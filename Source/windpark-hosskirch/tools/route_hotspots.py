"""Detailed swept-path check at the route's hot spots.

For each window of the route: the local roads, buildings, street furniture, barriers and trees (Overture / OSM,
ESA WorldCover), the ground (Copernicus GLO-30 with trees and buildings taken out) and the 10 m Sentinel-2 composite.
The virtual convoy drives the window; its swept area is compared with the paved area and the objects next to the road.
The convoy's line is the road view's (route_lanes.py lanes_1m: keep right, lane 2 or the oncoming lane only where the right
side is not sufficient), the keep-right line simulated alongside for the comparison.
Output: .cache/route/hot/<id>.pkl (everything the page bake needs) and a summary table.
REPOSE=1: the line, swept areas, conflicts and poses again on the data already in <id>.pkl (nothing fetched; the area,
photo trace, buildings, trees and ground as surveyed).
"""
import routecfg
import json, math, os, pickle, sys, numpy as np
import overture as ov
from pyproj import Transformer
from shapely import wkb
from shapely.geometry import LineString, Point, Polygon, MultiPolygon, box, shape
from shapely.ops import unary_union, transform as shp_transform
from route_swept import V, resample, smooth, simulate, half_width, HALF, curvature_radius, turn_angle, lane_plan, offset_path, beyond
import rasterio
from rasterio.windows import from_bounds
from scipy.interpolate import griddata
from scipy.ndimage import gaussian_filter, distance_transform_edt, map_coordinates

C = routecfg.C
OUT = C + 'hot/'
TURB = routecfg.get('turbines') or json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'scene.json')))['turbines']
os.makedirs(OUT, exist_ok=True)

# id, title, anchor (lon, lat) where the window starts on the route, window length (m; None = to the end)
HOT = [
    ('factory', 'Blade yard, Goleniów', 14.7928, 53.5511, 3800),
    ('feuchtwangen', 'A6 → A7, Kreuz Feuchtwangen/Crailsheim', 10.237529, 49.203700, 1200),
    ('a7-exit', 'A7 exit onto the B28', 10.088267, 48.331888, 1200),
    ('neu-ulm', 'B28 → B30, Neu-Ulm', 9.998783, 48.367887, 1200),
    ('gaisbeuren', 'B30 through Gaisbeuren and Enzisreute', 9.727227, 47.900435, 4000),
    ('niederbiegen', 'B30 → B32 ramp at Niederbiegen (near Weingarten)', 9.615638, 47.831184, 1100),
    ('blitzenreute', 'B32 bends at Blitzenreute', 9.595825, 47.852495, 2200),
    ('altshausen', 'B32 through Altshausen', 9.548697, 47.921826, 2600),
    ('hirschegg', 'B32 between Altshausen and Hangen', 9.5326, 47.9394, 3100),
    ('haid', 'Haid: B32 → K 8274', 9.516001, 47.987085, 900),
    ('wilfertsweiler', 'K 8274 at Wilfertsweiler', 9.501733, 47.983440, 900),
    ('forest', 'Heratskirch → Wagenhart forest → crane pad', 9.48722, 47.96678, None),
]
if routecfg.get('hot') is not None: HOT = [tuple(h) for h in routecfg.get('hot')]     # another route: its survey points

DRIVABLE = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'service',
            'living_street', 'track', 'unknown'}
# objects next to the road that the swinging blade (≈ 1.0–5 m above the road) would touch, by Overture class
BLADE_OBJ = {'street_lamp', 'traffic_signals', 'power_pole', 'power_tower', 'information', 'stop', 'give_way',
             'bus_stop', 'charging_station', 'artwork', 'fire_hydrant', 'post_box', 'vending_machine', 'bench',
             'waste_basket', 'recycling', 'toilets', 'bicycle_parking', 'mast', 'tower', 'communication_tower'}
WHEEL_OBJ = {'bollard', 'block', 'kerb', 'cycle_barrier', 'lift_gate', 'gate', 'swing_gate', 'jersey_barrier'}
LINE_BAR = {'guard_rail', 'wall', 'fence', 'retaining_wall', 'hedge', 'city_wall', 'jersey_barrier', 'kerb'}

scr = np.load(C + 'screen.npz')
SURV = np.load(C + 'corr/survey_1m.npz') if os.path.exists(C + 'corr/survey_1m.npz') else None
# the convoy's line along the whole route (route_lanes.py): drv the tractor line, kr keep right, own the left boundary of
# its own lane, tw two-way, multi one-way with two lanes or more (m from the route line, left +)
LANES = np.load(C + 'corr/lanes_1m.npz') if os.path.exists(C + 'corr/lanes_1m.npz') else None
TWOWAY = LANES['tw'] if LANES is not None else None
utm = Transformer.from_crs('EPSG:32633', 'EPSG:4326', always_xy=True)
_EFF = None


def eff_edges():
    """the survey's edges widened to the painted edge lines where the trace stopped short of them (route_lanes.edges_eff:
    the edges the line and its swept path were laid on), whole route"""
    global _EFF
    if _EFF is None:
        L, R = SURV['L'].astype(float), SURV['R'].astype(float)
        try:
            from route_lanes import edges_eff
            from route_lanelines import context
            from route_corridor import route
            L, R = edges_eff(L, R, context(route()), np.load(C + 'corr/lanelines.npz'))
        except Exception as ex:
            print('  painted edge lines not used:', repr(ex)[:120])
        _EFF = (L, R)
    return _EFF


def route_normals(a0, i1, fw, fi):
    """the route's normals (route_corridor.route: the line smoothed over ~18 m, as the road view lays its lines) over route
    samples a0..i1 in the passage's frame, at the fractional samples fi (0 … i1 − a0 − 1: the passage's path points mapped
    by arc length)"""
    from route_corridor import route
    Pu, Nu = scr['P'][a0:i1], route()['N'][a0:i1]
    lo0, la0 = utm.transform(Pu[:, 0], Pu[:, 1]); lo1, la1 = utm.transform(Pu[:, 0] + Nu[:, 0], Pu[:, 1] + Nu[:, 1])
    x0, y0 = fw.transform(lo0, la0); x1, y1 = fw.transform(lo1, la1)
    t = np.arange(len(Pu))
    N_ = np.c_[np.interp(fi, t, np.asarray(x1) - x0), np.interp(fi, t, np.asarray(y1) - y0)]
    return N_ / (np.linalg.norm(N_, axis=1)[:, None] + 1e-9)


def gdal_env():
    return rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR', CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tif')


def read_wgs(url_fn, bb, res_deg, bands=None, resampling=None):
    """read a lon/lat raster covering bb (may straddle 1° tiles) at res_deg"""
    from rasterio.merge import merge
    w, s, e, n = bb
    W = int(np.ceil((e - w) / res_deg)); H = int(np.ceil((n - s) / res_deg))
    out = None
    for la in range(int(np.floor(s)), int(np.floor(n)) + 1):
        for lo in range(int(np.floor(w)), int(np.floor(e)) + 1):
            url = url_fn(la, lo)
            with gdal_env():
                try:
                    r = rasterio.open(url)
                except Exception as ex:
                    print('  missing', url, ex); continue
                with r:
                    # intersect
                    iw, is_, ie, in_ = max(w, lo), max(s, la), min(e, lo + 1), min(n, la + 1)
                    if ie <= iw or in_ <= is_: continue
                    c0 = int(round((iw - w) / res_deg)); c1 = int(round((ie - w) / res_deg))
                    r0 = int(round((n - in_) / res_deg)); r1 = int(round((n - is_) / res_deg))
                    if c1 <= c0 or r1 <= r0: continue
                    win = from_bounds(iw, is_, ie, in_, r.transform)
                    a = r.read(bands, window=win, out_shape=((len(bands) if bands else r.count), r1 - r0, c1 - c0),
                               resampling=resampling or rasterio.enums.Resampling.bilinear)
                    if out is None: out = np.zeros((a.shape[0], H, W), a.dtype)
                    out[:, r0:r1, c0:c1] = a
    return out


def dem_url(la, lo):
    ns = f'N{la:02d}' if la >= 0 else f'S{-la:02d}'; ew = f'E{lo:03d}' if lo >= 0 else f'W{-lo:03d}'
    n = f'Copernicus_DSM_COG_10_{ns}_00_{ew}_00_DEM'
    return f'/vsicurl/https://copernicus-dem-30m.s3.amazonaws.com/{n}/{n}.tif'


def wc_url(la, lo):
    la3 = (la // 3) * 3; lo3 = (lo // 3) * 3
    return f'/vsicurl/https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N{la3:02d}E{lo3:03d}_Map.tif'


def s2_url(la, lo):
    return f'/vsicurl/https://esa-worldcover-s2.s3.eu-central-1.amazonaws.com/rgbnir/2021/N{la:02d}/ESA_WorldCover_10m_2021_v200_N{la:02d}E{lo:03d}_S2RGBNIR.tif'


def clean(v):
    if isinstance(v, (bytes, bytearray)): return None
    if isinstance(v, list):
        if v and isinstance(v[0], tuple) and len(v[0]) == 2: return {k: clean(x) for k, x in v}
        return [clean(x) for x in v]
    if isinstance(v, dict): return {k: clean(x) for k, x in v.items()}
    return v


def analyse(hid, title, alon, alat, length):
    s = scr['s']
    ux, uy = Transformer.from_crs('EPSG:4326', 'EPSG:32633', always_xy=True).transform(alon, alat)
    i0 = int(np.argmin(np.hypot(scr['P'][:, 0] - ux, scr['P'][:, 1] - uy)))
    i1 = len(s) if length is None else min(len(s), i0 + int(length))
    k0, k1 = s[i0] / 1000, (None if length is None else s[i1 - 1] / 1000)
    a0 = max(0, i0 - 130)                                      # run-in for the dolly
    Pw = scr['P'][a0:i1]
    lon, lat = utm.transform(Pw[:, 0], Pw[:, 1])
    lon0, lat0 = float(np.mean(lon[i0 - a0:])), float(np.mean(lat[i0 - a0:]))
    proj = f'+proj=tmerc +lat_0={lat0} +lon_0={lon0} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs'
    fw = Transformer.from_crs('EPSG:4326', proj, always_xy=True); bw = Transformer.from_crs(proj, 'EPSG:4326', always_xy=True)
    x, y = fw.transform(lon, lat)
    P, ss, dd = resample(np.c_[x, y], 1.0)           # (the screen's centreline is smoothed once already)
    # each path point's place among the route samples by arc length (the samples crowd on the inside of a hairpin: a mapping
    # by index folded the offset line over there)
    fi = np.interp(ss, dd, np.arange(len(Pw)))
    HW = np.interp(fi, np.arange(len(Pw)), scr['HW'][a0:i1])
    j0 = (i0 - a0)
    HD = None; LANE = None; Pc = None
    # re-pose: the area and its data as surveyed before (the same frame), only the line and what follows from it anew
    OLD = pickle.load(open(OUT + hid + '.pkl', 'rb')) if os.environ.get('REPOSE') == '1' and os.path.exists(OUT + hid + '.pkl') else None
    if OLD is not None and OLD.get('proj') != proj:
        print('  the passage frame moved: surveyed again'); OLD = None
    if SURV is not None and SURV['have'][a0:i1].mean() > 0.9:
        # the carriageway measured on the aerial photo (left / right of the mapped line)
        ii = np.minimum(i1 - 1, a0 + np.round(fi).astype(int)); fr = a0 + fi; ia = np.arange(a0, i1)
        at_ = lambda arr: np.interp(fr, ia, np.asarray(arr[a0:i1], float))      # (a per-metre array at the path's points)
        sh = SURV['shift'][ii].astype(float); Lm = SURV['L'][ii].astype(float); Rm = SURV['R'][ii].astype(float)
        T_ = np.gradient(P, axis=0); T_ /= np.linalg.norm(T_, axis=1)[:, None] + 1e-9
        N_ = np.c_[-T_[:, 1], T_[:, 0]]
        tw = TWOWAY[ii].astype(bool) if TWOWAY is not None else np.zeros(len(ii), bool)
        Pc = P + N_ * ((Lm - Rm) / 2)[:, None]
        if LANES is not None and 'own' in LANES.files:
            # the road view's line (route_lanes.py): keep right — the right lane, the right half of a two-way road — and lane 2
            # or the oncoming lane only where the right side is not sufficient and the left is (the escort closes it); laid
            # with the route's own normals and the edges widened to the painted edge lines, as there. The rear dolly keeps
            # inside the own lane where the road allows (simulate's own); keeping right is simulated for the comparison with
            # the own lane's left boundary as its edge
            N_ = route_normals(a0, i1, fw, fi)
            Le, Re = eff_edges(); Lm, Rm = at_(Le), at_(Re)
            o = at_(LANES['drv']); kro = at_(LANES['kr']); own = at_(LANES['own'])
            # (kr and own are undefined, 0 / NaN, where an edge was not traced: bridged from the metres around)
            k_ = np.arange(len(ii)); ok = SURV['have'][ii].astype(bool) & np.isfinite(kro) & np.isfinite(own)
            if ok.any(): kro = np.interp(k_, k_[ok], kro[ok]); own = np.interp(k_, k_[ok], own[ok])
            else: kro = o.copy(); own = Lm.copy()
            multi = LANES['multi'][ii].astype(bool) if 'multi' in LANES.files else np.zeros(len(ii), bool)
            Pr = P.copy(); Pc = Pr + N_ * ((Lm - Rm) / 2)[:, None]
            P = Pr + N_ * o[:, None]; HW = np.c_[Lm - o, Rm + o]
            clr = np.where(Lm + Rm <= 6.9, 1.0, 0.5)
            res, polys = simulate(P, HW, i0=j0, keep=True, clear=clr, own=own - o)
            rk, pk = simulate(Pr + N_ * kro[:, None], np.c_[own - kro, Rm + kro], i0=j0, keep=True, clear=np.minimum(clr, 0.3))
            LANE = dict(kr=dict(res=rk, polys=pk, o=kro), own=own, tw=tw, lanes=tw | multi, Pr=Pr, N=N_, L=Lm, R=Rm,
                        rec_across=beyond(Pr, own, polys)[1], kr_across=beyond(Pr, own, pk)[1])
        elif tw[j0:].mean() > 0.5 and ((Lm + Rm)[j0:] >= 5.6).mean() > 0.5:
            # two-way road: the convoy keeps right where its own lane is enough and uses the oncoming lane where that
            # keeps the wheels on the road or the blade over it — the escort holds oncoming traffic there
            # (route_swept.lane_plan, as in route_lanes.py); the keep-right line is kept for comparison
            Pr = P.copy()
            LP = lane_plan(Pr, Lm, Rm, i0=j0, twoway=tw)
            o = LP['rec']['o']
            P = Pr + N_ * o[:, None]; HW = np.c_[Lm - o, Rm + o]
            res, polys = LP['rec']['res'], LP['rec']['polys']
            LANE = dict(kr=LP['kr'], own=LP['c'], tw=tw, lanes=tw, Pr=Pr, N=N_, L=Lm, R=Rm, rec_across=LP['rec']['across_w'], kr_across=LP['kr']['across_w'])
        else:
            # one-way carriageway or a single-lane road: the convoy drives on the middle of the measured carriageway
            P = P + N_ * sh[:, None]
            HW = np.c_[Lm - sh, Rm + sh]
        HD = dict(measured=True)
    if LANE is None:
        hw1 = HW.sum(1) / 2 if HW.ndim == 2 else HW
        res, polys = simulate(P, HW, i0=j0, keep=True, clear=np.where(hw1 <= 3.45, 1.0, 0.5))
    # area: route window + margin
    xs, ys = P[j0:, 0], P[j0:, 1]
    m = 220
    ext = (xs.min() - m, ys.min() - m, xs.max() + m, ys.max() + m)
    corners = [bw.transform(ext[0], ext[1]), bw.transform(ext[2], ext[3]), bw.transform(ext[0], ext[3]), bw.transform(ext[2], ext[1])]
    bb = (min(c[0] for c in corners), min(c[1] for c in corners), max(c[0] for c in corners), max(c[1] for c in corners))
    if OLD is not None: ext, bb = OLD['ext'], OLD['bb']          # (the line moves by a few metres: the margin covers it)
    tf = lambda g: shp_transform(lambda X, Y, Z=None: fw.transform(X, Y), g)
    res10 = 1 / 12000
    src_fn = OUT + hid + '_src.pkl'
    cached = pickle.load(open(src_fn, 'rb')) if os.path.exists(src_fn) and OLD is None else None
    if OLD is not None:
        roads, bld, infra, lu, s2, wc, dem = (OLD[k] for k in ('roads', 'bld', 'infra', 'lu', 's2', 'wc', 'dem'))
    elif cached and cached['bb'][0] <= bb[0] + 1e-4 and cached['bb'][1] <= bb[1] + 1e-4 and cached['bb'][2] >= bb[2] - 1e-4 and cached['bb'][3] >= bb[3] - 1e-4:
        bb = cached['bb']
        S = pickle.load(open(src_fn, 'rb'))
        roads, bld, infra, lu, s2, wc, dem = S['roads'], S['bld'], S['infra'], S['lu'], S['s2'], S['wc'], S['dem']
    else:
        # ---- Overture
        seg = ov.query('transportation', 'segment', bb, columns=['id', 'subtype', 'class', 'subclass', 'names', 'routes', 'road_flags', 'level_rules', 'width_rules', 'geometry'])
        roads = []
        for r in seg.to_pylist():
            g = tf(wkb.loads(r['geometry']))
            roads.append(dict(cls=r['class'], sub=r['subclass'], sub_t=r['subtype'], name=(r['names'] or {}).get('primary'),
                              ref=';'.join(sorted({q['ref'] for q in (r['routes'] or []) if q.get('ref')})),
                              flags=clean(r['road_flags']), level=clean(r['level_rules']), width=clean(r['width_rules']),
                              xy=np.array(g.coords)))
        bld = []
        t = ov.query('buildings', 'building', bb, columns=['geometry', 'height', 'num_floors', 'roof_shape', 'class', 'min_height'])
        for r in t.to_pylist():
            g = tf(wkb.loads(r['geometry']))
            h = r['height'] or ((r['num_floors'] or 2) * 3.0 + 1.5)
            for p in getattr(g, 'geoms', [g]):
                bld.append(dict(poly=p, h=float(h), roof=r['roof_shape'], cls=r['class']))
        infra = []
        t = ov.query('base', 'infrastructure', bb, columns=['subtype', 'class', 'geometry', 'height', 'source_tags'])
        for r in t.to_pylist():
            infra.append(dict(sub=r['subtype'], cls=r['class'], g=tf(wkb.loads(r['geometry'])), h=r['height'], tags=clean(r['source_tags'])))
        lu = []
        for typ in ('land_use', 'land', 'water'):
            t = ov.query('base', typ, bb, columns=['subtype', 'class', 'geometry'])
            for r in t.to_pylist():
                g = tf(wkb.loads(r['geometry']))
                lu.append(dict(t=typ, sub=r['subtype'], cls=r['class'], g=g))
        # ---- rasters: 10 m Sentinel-2 composite and WorldCover on the local grid; DEM 30 m → ground
        res10 = 1 / 12000
        s2 = read_wgs(s2_url, bb, res10, bands=[1, 2, 3, 4])
        wc = read_wgs(wc_url, bb, res10, bands=[1], resampling=rasterio.enums.Resampling.nearest)
        dem = read_wgs(dem_url, bb, 1 / 3600, bands=[1])
        pickle.dump(dict(bb=bb, roads=roads, bld=bld, infra=infra, lu=lu, s2=s2, wc=wc, dem=dem), open(src_fn, 'wb'))
    if OLD is not None:
        paved, HD = OLD['paved'], OLD.get('hd')        # (the photo trace, LoD2 buildings and trees as surveyed)
        if HD and HD.get('paved_photo') is not None and HW.ndim == 2:
            # the paved area as the survey branch makes it, around the new line: the photo trace, the mapped roads beyond 38 m
            # of the path, and the carriageway between the edges the line was laid on (the painted edge lines where the trace
            # stopped short of them) — the old area's ribbon followed the old line's raw edges
            T_ = np.gradient(P, axis=0); T_ /= np.linalg.norm(T_, axis=1)[:, None] + 1e-9; Nn = np.c_[-T_[:, 1], T_[:, 0]]
            rib = Polygon(np.r_[P + Nn * HW[:, :1], (P - Nn * HW[:, 1:])[::-1]]).buffer(0)
            paved = unary_union([HD['paved_photo'], OLD['paved'].difference(LineString(P[j0:]).buffer(38)), rib]).buffer(0)
    else:
        # ---- paved area (all drivable roads, buffered by their usable half-width)
        paved = []
        for r in roads:
            if r['sub_t'] != 'road' or r['cls'] not in DRIVABLE or len(r['xy']) < 2: continue
            paved.append(LineString(r['xy']).buffer(half_width(r['cls'], r['sub']), cap_style=2, join_style=1))
        paved = unary_union(paved)
        # kerb fillets: at junction nodes (segment ends shared by two or more roads) the corners are rounded (closing, r 8 m)
        ends = {}
        for r in roads:
            if r['sub_t'] != 'road' or r['cls'] not in DRIVABLE or len(r['xy']) < 2: continue
            for e in (r['xy'][0], r['xy'][-1]):
                k = (round(e[0], 0), round(e[1], 0)); ends[k] = ends.get(k, 0) + 1
        nodes = [Point(*k).buffer(22) for k, c in ends.items() if c >= 2]
        if nodes:
            paved = unary_union([paved, paved.buffer(8).buffer(-8).intersection(unary_union(nodes))])
        # ---- official geodata (Baden-Württemberg / Bavaria): paved surface traced on the 20 cm photo, LoD2 buildings,
        # trees from the surface model
        try:
            import hd_hot
            if hd_hot.region(hid) in hd_hot.HD_SET:
                pv = hd_hot.photo_paved(hid, P[j0:], proj, ext, roads)
                corr = LineString(P[j0:]).buffer(38)
                parts = [pv['poly'], paved.difference(corr)]
                if HW.ndim == 2:
                    # the carriageway edges measured along the route (as in the road view) – occlusions bridged
                    T_ = np.gradient(P, axis=0); T_ /= np.linalg.norm(T_, axis=1)[:, None] + 1e-9
                    N_ = np.c_[-T_[:, 1], T_[:, 0]]
                    le = P + N_ * HW[:, :1]; re_ = P - N_ * HW[:, 1:]
                    rib = Polygon(np.r_[le, re_[::-1]]).buffer(0)
                    parts.append(rib)
                paved = unary_union(parts).buffer(0)
                lod = hd_hot.lod2_local(hid, proj, ext)
                if lod:
                    bld = [dict(poly=b_['poly'], h=b_['h'], roof='lod2', cls=None, lod=b_) for b_ in lod]
                trees_hd = hd_hot.ndom_trees(hid, proj, ext, P[j0:], buildings=[b_['poly'] for b_ in bld])
                HD = dict(HD or {}, region=hd_hot.region(hid), lod2=lod, trees=trees_hd, paved_photo=pv['poly'])
        except Exception as ex:
            import traceback; print('  HD data not used:', repr(ex), traceback.format_exc())
    # ---- swept areas
    wheel_polys, blade_polys = [], []
    for k, p in enumerate(polys):
        if p is None or k % 2: continue
        wheel_polys += [Polygon(p['tractor']), Polygon(p['front']), Polygon(p['dolly'])]
        blade_polys.append(Polygon(p['blade']).buffer(0))
    wheel_sw = unary_union(wheel_polys)
    blade_sw = unary_union(blade_polys)
    wheel_out = wheel_sw.difference(paved.buffer(0.10))          # only where the wheels are ≥ 10 cm off the paved area
    blade_out = blade_sw.difference(paved.buffer(0.3))
    # ---- own lane or the oncoming lane: the keep-right plan's swept areas, and where the recommended line's wheels run
    # in the oncoming lane
    lane = None
    if LANE is not None:
        kw, kb = [], []
        for k, p in enumerate(LANE['kr']['polys']):
            if p is None or k % 2: continue
            kw += [Polygon(p['tractor']), Polygon(p['front']), Polygon(p['dolly'])]
            kb.append(Polygon(p['blade']).buffer(0))
        kr_wheel_sw = unary_union(kw); kr_blade_sw = unary_union(kb)
        kr_wheel_out = kr_wheel_sw.difference(paved.buffer(0.10)); kr_blade_out = kr_blade_sw.difference(paved.buffer(0.3))
        Pr, N_, ow, Lm_ = LANE['Pr'][j0:], LANE['N'][j0:], LANE['own'][j0:], LANE['L'][j0:]
        twj = LANE['tw'][j0:]; lnj = LANE['lanes'][j0:]
        # the lane the convoy may borrow (two-way roads: the oncoming half; one-way roads of two lanes or more: lane 2 and up):
        # the own lane's left boundary → left edge (+0.5 m)
        onc = None
        runs = np.flatnonzero(np.diff(np.r_[0, lnj.astype(int), 0]))
        halves = []
        for a_, b_ in zip(runs[::2], runs[1::2]):
            if b_ - a_ < 3: continue
            cl = Pr[a_:b_] + N_[a_:b_] * ow[a_:b_, None]; le = Pr[a_:b_] + N_[a_:b_] * (np.maximum(Lm_, ow + 0.5)[a_:b_] + 0.5)[:, None]
            halves.append(Polygon(np.r_[cl, le[::-1]]).buffer(0))
        if halves:
            hv = unary_union(halves)
            onc = wheel_sw.intersection(hv)
            onc = unary_union([g for g in getattr(onc, 'geoms', [onc]) if g.geom_type == 'Polygon' and g.area > 1.0]) if not onc.is_empty else onc
        # wheels beyond the own lane (only where there is a lane to borrow: on a single-lane road it is the edge)
        acr = np.where(lnj, np.nan_to_num(LANE['rec_across'][j0:], nan=-9), -9); acr_k = np.where(lnj, np.nan_to_num(LANE['kr_across'][j0:], nan=-9), -9)
        use = acr > 0.4
        kres = LANE['kr']['res']
        # keeping right: off the road itself (right edge, or beyond the left edge — not the own lane's boundary it was given)
        dl = (Lm_ - ow)[:len(kres['wL'])]
        k_off = np.maximum(np.nan_to_num(kres['wR']), np.maximum(0, np.nan_to_num(kres['wL']) - dl))
        k_bo = np.maximum(np.nan_to_num(kres['bR']), np.maximum(0, np.nan_to_num(kres['bL']) - dl))
        lane = dict(used_m=int(use.sum()), across_max=float(max(0.0, acr.max())) if len(acr) else 0.0,
                    kr_wheel_out_max=float(k_off.max()) if len(k_off) else 0.0,
                    kr_blade_out_max=float(k_bo.max()) if len(k_bo) else 0.0,
                    kr_wheel_clear_min=float(np.nanmin(kres['wm'])) if len(kres['wm']) else 0.0,
                    kr_wheel_out_area=round(kr_wheel_out.area), kr_blade_out_area=round(kr_blade_out.area),
                    kr_across_max=float(max(0.0, acr_k.max())) if len(acr_k) else 0.0,
                    kind='oncoming' if (twj[use].mean() if use.any() else twj.mean()) >= 0.5 else 'lane2')
        LANE_G = dict(onc=onc, kr_wheel_sw=kr_wheel_sw, kr_wheel_out=kr_wheel_out, kr_blade_out=kr_blade_out, kr_poses=None)
    # ---- conflicts
    conf = []
    path_ln = LineString(P[j0:])
    for b in bld:
        dcl = path_ln.distance(b['poly'])
        if dcl < float(np.median(HW)) - 0.3 and blade_sw.intersects(b['poly']):
            conf.append(dict(kind='mapped-object', what='mapped object inside the carriageway (verify)', at=list(np.round(b['poly'].centroid.coords[0], 1)), sev=1))
            continue
        if blade_sw.intersects(b['poly']) and blade_sw.intersection(b['poly']).difference(paved).area >= 10:
            ip = blade_sw.intersection(b['poly']).difference(paved)
            conf.append(dict(kind='building', what='building', area=round(ip.area, 1), at=list(np.round(ip.centroid.coords[0], 1)), sev=3))
        elif blade_sw.intersects(b['poly']):        # a footprint grazing the sweep (map edge of a roof): close, not through
            conf.append(dict(kind='building-near', what='building at the road edge (map check)', d=0.0, at=list(np.round(b['poly'].centroid.coords[0], 1)), sev=2))
        else:
            d = blade_sw.distance(b['poly'])
            if d < 1.0:
                conf.append(dict(kind='building-near', what=f'building {d:.1f} m from the blade', d=round(d, 2), at=list(np.round(b['poly'].centroid.coords[0], 1)), sev=2))
    for o in infra:
        g = o['g']
        if o['cls'] in LINE_BAR and g.geom_type in ('LineString', 'MultiLineString'):
            if blade_sw.intersects(g) or wheel_sw.intersects(g):
                ip = g.intersection(blade_sw.union(wheel_sw))
                conf.append(dict(kind='barrier', what=o['cls'].replace('_', ' '), length=round(ip.length, 1), at=list(np.round(ip.centroid.coords[0], 1)) if not ip.is_empty else None, sev=3 if o['cls'] in ('guard_rail', 'wall', 'retaining_wall', 'jersey_barrier') else 2))
        elif g.geom_type == 'Point':
            if o['cls'] in BLADE_OBJ and blade_sw.buffer(0.3).contains(g):
                conf.append(dict(kind='object', what=o['cls'].replace('_', ' '), at=[round(g.x, 1), round(g.y, 1)], sev=2))
            elif o['cls'] in WHEEL_OBJ and wheel_sw.buffer(0.2).contains(g):
                conf.append(dict(kind='object', what=o['cls'].replace('_', ' '), at=[round(g.x, 1), round(g.y, 1)], sev=3))
    # structures over the route: roads / railways on a higher level crossing the path (clear height to check)
    for r in roads:
        lvl = max([lr.get('value') or 0 for lr in (r['level'] or [])] + [0])
        bridge = any('is_bridge' in (f.get('values') or []) for f in (r['flags'] or []))
        if (lvl > 0 or bridge) and len(r['xy']) > 1:
            ln = LineString(r['xy'])
            if ln.intersects(path_ln):
                ip = ln.intersection(path_ln)
                pt = ip if ip.geom_type == 'Point' else ip.centroid
                # skip the route's own bridges (same ref / name running along the path)
                if ln.length > 30 and path_ln.buffer(3).intersection(ln).length > 0.6 * min(ln.length, 60): continue
                what = 'railway bridge over the route' if r['sub_t'] == 'rail' else 'road bridge over the route'
                if not any(c['kind'] == 'overpass' and math.dist(c['at'], (pt.x, pt.y)) < 25 for c in conf):
                    conf.append(dict(kind='overpass', what=what, at=[round(pt.x, 1), round(pt.y, 1)], sev=2))
    # trees in the blade's overswing (WorldCover class 10 = tree cover), on the local 1 m grid via the lon/lat raster
    tree_area = 0.0; tree_pts = []
    if wc is not None and not blade_out.is_empty:
        Hh, Ww = wc.shape[1:]
        for r_ in range(Hh):
            la_ = bb[3] - (r_ + 0.5) * res10
            row = wc[0, r_]
            cols = np.nonzero(row == 10)[0]
            if not len(cols): continue
            lo_ = bb[0] + (cols + 0.5) * res10
            X, Y = fw.transform(lo_, np.full(len(cols), la_))
            for xx, yy in zip(X, Y):
                if blade_out.contains(Point(xx, yy)): tree_area += 100.0; tree_pts.append((xx, yy))
    if HD and HD.get('trees') is not None and not blade_out.is_empty:
        # surveyed trees (tops ≥ 3 m in the surface model) whose crowns reach into the blade's overswing
        tree_area = 0.0; tree_pts = []
        from shapely.prepared import prep
        bo = prep(blade_out.buffer(0))
        for x_, y_, h_, r_ in HD['trees']:
            cr = Point(x_, y_).buffer(float(r_), 8)
            if bo.intersects(cr):
                tree_area += cr.intersection(blade_out).area; tree_pts.append((x_, y_))
        if tree_pts: conf.append(dict(kind='trees', what=f'trees in the blade swing ({len(tree_pts)} surveyed crowns)', area=round(tree_area), sev=2))
    elif tree_area: conf.append(dict(kind='trees', what='tree cover in the blade swing', area=round(tree_area), sev=2))
    # ---- ground: a terrain model from GLO-30 minus the canopy / roofs where WorldCover has trees or buildings,
    # pulled to the surveyed pad heights of the park's turbines (route_dtm.py)
    ground = treefrac = None
    if OLD is not None: ground, treefrac = OLD['ground'], OLD['treefrac']          # (as surveyed: the line moved by metres)
    elif dem is not None:
        from route_dtm import dtm
        D = dem[0].astype(float)
        anchors = [((bb[3] - t['lat']) * 3600 - 0.5, (t['lon'] - bb[0]) * 3600 - 0.5, t['ground']) for t in TURB
                   if bb[0] < t['lon'] < bb[2] and bb[1] < t['lat'] < bb[3]]
        if wc is not None:
            ground, treefrac, _ = dtm(D, wc[0], anchors=anchors)
            # the road itself is open: where it runs through a short stretch of trees (an avenue, a copse) the canopy
            # correction is unreliable, so the profile is bridged between the open samples and the terrain next to the
            # road follows it (fading out over 80 m)
            from scipy.spatial import cKDTree
            plon, plat = bw.transform(P[:, 0], P[:, 1])
            prc = [(bb[3] - plat) * 3600 - 0.5, (plon - bb[0]) * 3600 - 0.5]
            prof = map_coordinates(ground, prc, order=1, mode='nearest')
            ok = map_coordinates(treefrac, prc, order=1, mode='nearest') < 0.35
            new = prof.copy(); i = 0; n = len(ok)
            while i < n:
                if ok[i]: i += 1; continue
                j = i
                while j < n and not ok[j]: j += 1
                if i > 0 and j < n and j - i < 400:
                    new[i:j] = np.interp(np.arange(i, j), [i - 1, j], [prof[i - 1], prof[j]])
                i = j
            delta = gaussian_filter(new - prof, 10)
            if np.abs(delta).max() > 0.2:
                Hg, Wg = ground.shape
                gr, gc = np.mgrid[0:Hg, 0:Wg]
                gx, gy = fw.transform(bb[0] + (gc + 0.5) / 3600, bb[3] - (gr + 0.5) / 3600)
                dd, ii = cKDTree(P).query(np.c_[gx.ravel(), gy.ravel()])
                wgt = np.clip((80 - dd) / 60, 0, 1).reshape(Hg, Wg)
                ground = ground + wgt * delta[ii].reshape(Hg, Wg)
        else:
            ground = gaussian_filter(D, 0.8)
    # ---- the convoy's poses for the page (every 2 m), in the local frame
    poses = []
    from route_swept import tractrix
    rearax = tractrix(P, V['wheelbase'])
    p1 = np.full_like(P, np.nan); p1[j0:] = res['p1']
    for k in range(0, len(polys), 2):
        p = polys[k]
        if p is None: continue
        i = j0 + k
        bl = p['blade']; root = (bl[0] + bl[-1]) / 2; tip = (bl[len(bl) // 2 - 1] + bl[len(bl) // 2]) / 2
        dc = p['dolly'].mean(0); df = (p['dolly'][0] + p['dolly'][1]) / 2
        poses.append([*P[i], *rearax[i], *p1[i], *root, *tip, *dc, *df])
    poses = np.array(poses, dtype=np.float32)
    Rc, _ = curvature_radius(P); turn = turn_angle(P)
    # curve radius over 50 m, away from junction corners (> 60° within 40 m count as turns, reported separately)
    tz = np.convolve((turn > 60).astype(float), np.ones(60), 'same') > 0
    curve = ~tz[j0:]
    summary = dict(id=hid, title=title, km=[round(k0, 2), round(k1, 2) if k1 is not None else round(s[-1] / 1000, 2)], lon=lon0, lat=lat0,
                   minR=float(np.min(Rc[j0:][curve])) if curve.any() else None,
                   maxTurn=float(turn[j0:].max()),
                   wheel_out_max=float(np.nanmax(np.maximum(res['wL'], res['wR']))) if len(res['wL']) else 0,
                   blade_out_max=float(np.nanmax(np.maximum(res['bL'], res['bR']))) if len(res['bL']) else 0,
                   wheel_clear_min=float(np.nanmin(res['wm'])) if len(res['wm']) else 0,
                   wheel_out_area=round(wheel_out.area), blade_out_area=round(blade_out.area), conflicts=conf, lane=lane)
    data = dict(summary=summary, proj=proj, ext=ext, bb=bb, P=P[j0:], HW=(HW[j0:] if HW.ndim == 1 else HW[j0:].sum(1) / 2), res=res, poses=poses, roads=roads, bld=bld,
                infra=infra, lu=lu, s2=s2, wc=wc, dem=dem, ground=ground, treefrac=treefrac, paved=paved, wheel_sw=wheel_sw, blade_sw=blade_sw,
                wheel_out=wheel_out, blade_out=blade_out, tree_pts=tree_pts, hd=HD,
                Pc=(Pc[j0:] if Pc is not None else None), lane_g=(LANE_G if LANE is not None else None))
    pickle.dump(data, open(OUT + hid + '.pkl', 'wb'))
    return summary


if __name__ == '__main__':
    want = sys.argv[1:] or [h[0] for h in HOT]
    allsum = []
    for h in HOT:
        if h[0] not in want: continue
        print('==', h[0], h[1])
        sm = analyse(*h)
        cs = {}
        for c in sm['conflicts']: cs[c['what']] = cs.get(c['what'], 0) + 1
        print(f"   minR {sm['minR'] or 0:.0f} turn {sm['maxTurn']:.0f}°  wheel out {sm['wheel_out_max']:.2f} m ({sm['wheel_out_area']} m²)  blade out {sm['blade_out_max']:.1f} m ({sm['blade_out_area']} m²)  conflicts {cs}")
        allsum.append(sm)
    json.dump(allsum, open(OUT + 'summary_' + ('all' if not sys.argv[1:] else ('_'.join(want) if len('_'.join(want)) < 200 else __import__('hashlib').md5('_'.join(want).encode()).hexdigest()[:12])) + '.json', 'w'), indent=1, default=float)
