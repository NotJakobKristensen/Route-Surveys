"""Packs for the page's road view: one file per 5 km (10 chunks) → windpark-hosskirch/dist/r/NNN.bin
Layout: u32 header length, header JSON, u32 blob length, raw-deflated blob of typed arrays, then the strip WebPs.
Coordinates: metres in UTM33 relative to the pack origin (ox, oy) — the page converts to its map frame.
The road's height and cross slope come from route_vprof.py (corr/vprof.npz: the 1 m laser terrain fitted along the road,
decks, tunnels as a grade between the portals) with the terrain beside the road (xrel, every 10 m at the offsets xrd);
tunnels and covered sections from route_tunnels.py (corr/tunnels.json: header tun, clear records); the convoy's line, its
own lane, the painted edge lines and the central reservation from route_lanes.py / route_lanelines.py (drv, onc, lane, nl,
med, mty, mw). Without those files the packs are made as before (GLO-30 road, no lanes)."""
import routecfg
import os, sys, glob, json, zlib, pickle, struct, numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from route_corridor import route, OUT, CH, PX, HALF, strip_frame, load_clear
from hd_sources import SOURCES
DIST = os.environ.get('PACK_OUT') or routecfg.DIST + 'r'; os.makedirs(DIST, exist_ok=True)
PACK = 10
OBJ_CLASSES = ['street_lamp', 'traffic_signals', 'stop', 'give_way', 'information', 'bus_stop', 'power_pole', 'power_tower',
               'bollard', 'barrier', 'toll_booth', 'camera', 'speed_camera', 'mast', 'tower', 'other']
# plausible heights (m) per class: a measured peak outside this is a tree / bridge over the object or a pole too thin
# for the surface model, not the object
OBJ_RANGE = {'traffic_signals': (2.4, 8.0), 'street_lamp': (3.5, 16.0), 'stop': (1.4, 4.5), 'give_way': (1.4, 4.5), 'information': (1.2, 7.5),
             'bus_stop': (1.4, 5.0), 'power_pole': (5.0, 25.0), 'power_tower': (12.0, 90.0), 'bollard': (0.4, 1.8), 'barrier': (0.4, 3.0),
             'toll_booth': (2.4, 8.0), 'camera': (2.0, 12.0), 'speed_camera': (1.0, 6.0), 'mast': (4.0, 90.0), 'tower': (4.0, 160.0)}
# height models (terrain / surface) behind clear heights, object heights and trees
HCREDIT = {'PL-32': 'NMT / NMPT: Geoportal.gov.pl / GUGiK', 'DE-MV': 'DGM1 / DOM1: © GeoBasis-DE/M-V (CC BY 4.0)',
           'DE-BB': 'DGM1 / bDOM1: © GeoBasis-DE/LGB (dl-de/by-2-0)', 'DE-ST': 'DGM1 / DOM1: © GeoBasis-DE / LVermGeo LSA (dl-de/by-2-0)',
           'DE-SN': 'DGM / DOM: GeoSN (dl-de/by-2-0)', 'DE-BY': 'DGM1 / DOM20: Bayerische Vermessungsverwaltung (CC BY 4.0)',
           'DE-BW': 'DGM1 / nDOM1: LGL, www.lgl-bw.de (dl-de/by-2-0)'}
BAR = ['guard_rail', 'wall', 'fence', 'retaining_wall', 'jersey_barrier', 'noise_barrier', 'hedge', 'kerb', 'other']

r = route(); P = r['P']; s = r['s']; n = len(s)
MAPMETA = json.load(open(routecfg.C + 'map_meta.json'))
from pyproj import Transformer
_u2m = Transformer.from_crs('EPSG:32633', MAPMETA['proj'], always_xy=True)


def to_map(ox, oy):
    g = np.array([[dx, dy] for dx in (-8000, 0, 8000) for dy in (-8000, 0, 8000)], float)
    mx, my = _u2m.transform(g[:, 0] + ox, g[:, 1] + oy)
    A = np.c_[g, np.ones(len(g))]
    ax = np.linalg.lstsq(A, mx, rcond=None)[0]; ay = np.linalg.lstsq(A, my, rcond=None)[0]
    return [round(float(q), 7) for q in (*ax, *ay)]
S10 = np.load(OUT + 'survey.npz'); S1 = np.load(OUT + 'survey_1m.npz')
# the convoy's line (route_lanes.py): keep right (the right lane; the right half of a two-way road), lane 2 or the oncoming
# lane only where the swept path needs it; ONC: the wheels beyond the own lane's left boundary (m; on the stretches of
# lanes.json at least 0.45, the page's band shows above 0.4)
LN = np.load(OUT + 'lanes_1m.npz') if os.path.exists(OUT + 'lanes_1m.npz') else None
ONC = None
if LN is not None:
    _acw = np.nan_to_num(LN['acw'].astype(np.float32), nan=0.0)
    ONC = np.nan_to_num(LN['left'].astype(np.float32), nan=0.0) if 'left' in LN.files else np.zeros(len(_acw), np.float32)
    _inst = np.zeros(len(ONC), bool)
    for _st in json.load(open(OUT + 'lanes.json')):
        _a, _b = int(np.searchsorted(s, _st['s0'])), int(np.searchsorted(s, _st['s1'])) + 1
        ONC[_a:_b] = np.maximum(ONC[_a:_b], np.maximum(_acw[_a:_b], 0.45)); _inst[_a:_b] = True
    # (outside the stretches a blip of the band under 15 m is no lane change: dropped)
    _e = np.flatnonzero(np.diff(np.r_[0, (ONC > 0.4).astype(np.int8), 0]))
    for _a, _b in zip(_e[::2], _e[1::2]):
        if _b - _a < 15 and not _inst[_a:_b].any(): ONC[_a:_b] = 0.0
# painted lines and the central reservation (route_lanelines.py), per metre
LL = np.load(OUT + 'lanelines.npz') if os.path.exists(OUT + 'lanelines.npz') else None
# the road's vertical alignment and the terrain beside it (route_vprof.py), tunnels and covered sections (route_tunnels.py)
VP = np.load(OUT + 'vprof.npz') if os.path.exists(OUT + 'vprof.npz') else None
TUN = json.load(open(OUT + 'tunnels.json'))['items'] if os.path.exists(OUT + 'tunnels.json') else None
TUBES = [t for t in TUN or [] if t['kind'] in ('tunnel', 'overpass')]      # ('underbridge': the bridge pipeline's)


def _eff_edges():
    """the measured edges per metre widened to the painted edge lines (+0.3 m) where the trace stopped short of them
    (route_lanes.edges_eff: the edges the convoy's line and swept path were planned on — the page's sweep and asphalt use
    the same, so no wheels show off a road the plan had them on); the survey's own edges where there are no lines"""
    L, R = S1['L'].astype(float), S1['R'].astype(float)
    if LL is None: return L, R
    try:
        from route_lanes import edges_eff
        from route_lanelines import context
        return edges_eff(L, R, context(r), LL)
    except Exception as ex:
        print('  painted edge lines not used for the edges:', repr(ex)[:120]); return L, R


def _tube_edges():
    """the edges per metre (_eff_edges) with each tunnel and covered section bridged from its portals (the photo there shows
    the lid, not the road): linear between the medians of the edges 3–40 m outside either portal (there the painted lines
    where the trace stopped short of them), within the tube's walls; and per 10 m survey row whether it lies in a tube (its
    edges not measured)"""
    L, R = (a.astype(np.float32).copy() for a in _eff_edges()); hv = S1['have'].astype(bool)
    in10 = np.zeros((n + 9) // 10, bool)
    for t in TUBES:
        a, b = int(np.searchsorted(s, t['s0'])), int(np.searchsorted(s, t['s1'])) + 1
        if b - a < 2: continue
        in10[a // 10:(b + 9) // 10] = True
        f = np.linspace(0, 1, b - a)
        for E, w in ((L, t.get('dl')), (R, t.get('dr'))):
            o0, o1 = slice(max(0, a - 40), max(0, a - 3)), slice(min(n, b + 3), min(n, b + 40))
            e = [float(np.nanmedian(E[o][hv[o]])) if hv[o].any() else np.nan for o in (o0, o1)]
            if not np.isfinite(e).any(): continue
            e0, e1 = (e[0] if np.isfinite(e[0]) else e[1]), (e[1] if np.isfinite(e[1]) else e[0])
            E[a:b] = e0 + (e1 - e0) * f
            # inside the tube's walls (tunnels.json: the edges outside + a 1 m walkway; a lane that ends before the portal
            # does not run through it)
            if w is not None:
                w = np.abs(np.asarray(w, float)); w = w[0] + (w[-1] - w[0]) * f if w.ndim else w
                E[a:b] = np.minimum(E[a:b], w - 1.0)
    # under a structure over the route the photo shows its deck: the edges traced there (stopping short at the deck's
    # edges, jagged) bridged across its footprint (its width along the road at the crossing angle + 2 m each side) as
    # through a tube, between the medians of the edges 3–25 m outside it
    try: brg = pickle.load(open(OUT + 'bridges.pkl', 'rb')) if os.path.exists(OUT + 'bridges.pkl') else None
    except Exception: brg = None
    own = [(q['s0'] - 8, q['s1'] + 8) for q in (brg or {}).get('route') or []] + [(t['s0'] - 10, t['s1'] + 10) for t in TUBES]
    nb = 0
    for o in ((brg or {}).get('over') or {}).values():
        c = float(o['s0'])
        if any(a_ <= c <= b_ for a_, b_ in own): continue
        i = min(n - 1, int(np.searchsorted(s, c))); tx, ty = r['N'][i, 1], -r['N'][i, 0]; sinA = 1.0
        for pt in o.get('parts') or []:
            Lp = np.asarray(pt['line'], float)
            if len(Lp) < 2: continue
            j = int(np.argmin(np.hypot(Lp[:, 0] - o['xy'][0], Lp[:, 1] - o['xy'][1]))); v = Lp[min(len(Lp) - 1, j + 2)] - Lp[max(0, j - 2)]
            if np.hypot(*v) > 0: sinA = max(0.35, abs(v[0] * ty - v[1] * tx) / np.hypot(*v))
            break
        h = min(40.0, float(o.get('width') or 8.0) / 2 / sinA + 2.0)
        a, b = int(np.searchsorted(s, c - h)), int(np.searchsorted(s, c + h)) + 1
        if b - a < 2: continue
        f = np.linspace(0, 1, b - a)
        for E in (L, R):
            o0, o1 = slice(max(0, a - 25), max(0, a - 3)), slice(min(n, b + 3), min(n, b + 25))
            e = [float(np.nanmedian(E[o_][hv[o_]])) if hv[o_].any() else np.nan for o_ in (o0, o1)]
            if not np.isfinite(e).all(): continue
            E[a:b] = e[0] + (e[1] - e[0]) * f
        nb += 1
    print(f'  edges bridged under {nb} structures over the route', flush=True)
    return L, R, in10


EL1, ER1, IN10 = _tube_edges()
E = np.load(OUT + 'elev.npz')
OBJ = pickle.load(open(OUT + 'objects.pkl', 'rb'))['blocks']
CLR = load_clear()
CLR_BY_S = {round(c['s0']): c for c in CLR['mapped']}
# signed height limits on the route's own segments (Overture / OSM maxheight), km ranges
LIMITS = json.load(open(OUT + 'limits.json')) if os.path.exists(OUT + 'limits.json') else []
REG = pickle.load(open(OUT + 'regions.pkl', 'rb'))['lab']
from scipy.ndimage import gaussian_filter1d
z10 = gaussian_filter1d(np.nan_to_num(E['z0']), 4); zl10 = np.nan_to_num(E['zl']); zr10 = np.nan_to_num(E['zr'])
slope10 = np.clip(gaussian_filter1d((zl10 - zr10) / 40.0, 3), -0.08, 0.08)


def blocks_for(a, b):
    out = dict(pts=[], lines=[], bld=[], over=[])
    for b0, blk in OBJ.items():
        if b0 > b or b0 + 20000 < a: continue
        for k in out: out[k] += blk[k]
    return out


TREES_PHOTO = {'PL-32'}         # height service too slow for a 64 m band over 45 km: crowns from the photo


def trees_photo(chunks, ox, oy, half=32.0):
    """trees where no height model can be used: crowns found on the photo (green and textured, unlike fields and
    lawns), height typical for the crown size; rows as trees_for with the height negative (= typical)"""
    from scipy.ndimage import gaussian_filter, maximum_filter, distance_transform_edt, uniform_filter
    rows = []
    for c in chunks:
        fn = OUT + f'{c:04d}.webp'
        if not os.path.exists(fn): continue
        im = _strip_img(c).astype(float)
        H, W = im.shape[:2]; k = 4                                     # 0.25 m → 1 m
        a = im[:H // k * k, :W // k * k].reshape(H // k, k, W // k, k, 3).mean((1, 3))
        r_, g_, b_ = a[..., 0], a[..., 1], a[..., 2]; lum = a.mean(-1)
        exg = (2 * g_ - r_ - b_) / (r_ + g_ + b_ + 1)
        sd = np.sqrt(np.maximum(uniform_filter(lum ** 2, 3) - uniform_filter(lum, 3) ** 2, 0))
        m = (exg > 0.04) & (sd > 9) & (lum < 125)
        m = gaussian_filter(m.astype(float), 1.2) > 0.5
        dt = distance_transform_edt(m)
        pk = (dt == maximum_filter(dt, size=7)) & (dt >= 1.5)
        ss, cen, nor = strip_frame(c)
        for rr, cc in zip(*np.nonzero(pk)):
            d = HALF - (rr + 0.5) * k * PX
            if abs(d) > half or abs(d) < 3.0: continue
            col = min(len(ss) - 1, int((cc + 0.5) * k)); rad = float(min(6.0, dt[rr, cc]))
            x = cen[col, 0] + nor[col, 0] * d; y = cen[col, 1] + nor[col, 1] * d
            h = 4.0 + 2.2 * rad
            px = a[rr, cc]
            rows.append([int((x - ox) * 10), int((y - oy) * 10), -int(h * 10), int(rad * 10), int(px[0]), int(px[1]), int(px[2])])
    A = np.array(rows, np.int32).reshape(-1, 7)
    if len(A) > 1:                                                     # plateaus give twin peaks: keep one per 3 m
        from scipy.spatial import cKDTree
        keep = np.ones(len(A), bool)
        for i, j in sorted(cKDTree(A[:, :2] / 10.0).query_pairs(3.0)):
            if keep[i] and keep[j]: keep[j] = False
        A = A[keep]
    return A


def trees_for(c0, chunks, i0, i1, ox, oy, half=32.0, step=2.0):
    """rows: x, y (dm, pack frame), height (dm; negative = typical, from the photo only), crown radius (dm), r, g, b of
    the crown on the photo"""
    from scipy.ndimage import maximum_filter, gaussian_filter
    from PIL import Image
    try:
        import elev
    except Exception:
        return trees_photo(chunks, ox, oy)
    reg = REG[min(len(REG) - 1, c0)]; reg = 'DE-BB' if reg == 'DE-BE' else reg
    if reg not in elev.SAMPLERS or reg in getattr(elev, 'COARSE', ()) or reg in TREES_PHOTO: return trees_photo(chunks, ox, oy)
    rows = []
    for c in chunks:
        ss, cen, nor = strip_frame(c)
        k = np.arange(0, len(ss), int(step / PX))
        d = np.arange(-half, half + 0.01, step)
        X = cen[k, 0][:, None] + nor[k, 0][:, None] * d[None]; Y = cen[k, 1][:, None] + nor[k, 1][:, None] * d[None]
        try:
            Hh = elev.above_ground(reg, X, Y)
        except Exception as ex:
            print('  trees', c, repr(ex)); continue
        if Hh is None: continue
        Hh = gaussian_filter(np.nan_to_num(Hh), 0.6)
        pk = (Hh == maximum_filter(Hh, size=3)) & (Hh >= 4.0)
        im = np.asarray(Image.open(OUT + f'{c:04d}.webp').convert('RGB')).astype(float)
        for a, b in zip(*np.nonzero(pk)):
            col = int(k[a]); row = int(round((HALF - d[b]) / PX))
            if not (0 <= row < im.shape[0] and 0 <= col < im.shape[1]): continue
            px = im[max(0, row - 3):row + 4, max(0, col - 3):col + 4].reshape(-1, 3).mean(0)
            exg = (2 * px[1] - px[0] - px[2]) / (px.sum() + 1)
            if exg < 0.03 or px.mean() > 170: continue          # not vegetation (roof, gantry, bridge)
            if abs(d[b]) < 3.0: continue                        # over the driving line: reported as trees over the road
            h = Hh[a, b]; r_ = min(7.0, max(1.5, (Hh[max(0, a - 2):a + 3, max(0, b - 2):b + 3] > 0.6 * h).sum() ** 0.5 * step * 0.55))
            rows.append([int((X[a, b] - ox) * 10), int((Y[a, b] - oy) * 10), int(h * 10), int(r_ * 10), int(px[0]), int(px[1]), int(px[2])])
    return np.array(rows, np.int32).reshape(-1, 7)


_KDP = None


def tube_trees(tr, ox, oy):
    """trees (rows of trees_for) dropped over a tube and 15 m before and after it within its walls + 1 m: the surface model
    and the photo there hold its lid, a roof or the slope over the headwall, not trees that could stand on the road"""
    global _KDP
    if not TUBES or not len(tr): return tr
    from scipy.spatial import cKDTree
    if _KDP is None: _KDP = cKDTree(P)
    xy = tr[:, :2] / 10.0 + [ox, oy]; _, k = _KDP.query(xy); k = np.minimum(k, n - 1)
    lat = ((xy - P[k]) * r['N'][k]).sum(1); sv = s[k]; keep = np.ones(len(tr), bool)
    for t in TUBES:
        wl = float(np.max(np.abs(np.atleast_1d(t.get('dl') or 9.5)))) + 1; wr = float(np.max(np.abs(np.atleast_1d(t.get('dr') or -9.5)))) + 1
        keep &= ~((sv >= t['s0'] - 15) & (sv <= t['s1'] + 15) & (lat <= wl) & (lat >= -wr))
    return tr[keep]


def road_trees(tr, ox, oy):
    """trees (rows of trees_for) dropped on the carriageway and 1 m beyond its edges (the packed edges; the trunks were kept
    out of ±3 m only: trees stood on the forest tracks)"""
    global _KDP
    if not len(tr): return tr
    from scipy.spatial import cKDTree
    if _KDP is None: _KDP = cKDTree(P)
    xy = tr[:, :2] / 10.0 + [ox, oy]; dd, k = _KDP.query(xy); k = np.minimum(k, n - 1)
    lat = ((xy - P[k]) * r['N'][k]).sum(1)
    on = (lat < np.nan_to_num(EL1[k], nan=3.0) + 1.0) & (lat > -(np.nan_to_num(ER1[k], nan=3.0) + 1.0))
    return tr[~on]


def photo_open_road(sv, length):
    """does the photo over the driving line at sv look like the road 25–45 m before and after (no deck, no gantry shadow)?"""
    from PIL import Image
    def band(x):
        c = int(x // CH); fn = OUT + f'{c:04d}.webp'
        if not os.path.exists(fn): return None
        im = _strip_img(c); col = int((x - c * CH) / PX); H = im.shape[0]
        if not (0 <= col < im.shape[1]): return None
        return im[H // 2 - 8:H // 2 + 8, max(0, col - 6):col + 6].reshape(-1, 3)
    at = [band(sv + d) for d in np.arange(-length / 2, length / 2 + 0.1, 2.0)]; at = [a for a in at if a is not None]
    ref = [band(sv + d) for d in (-45, -35, -25, 25, 35, 45)]; ref = [a for a in ref if a is not None]
    if not at or len(ref) < 2: return False
    A = np.concatenate(at).astype(float); Rf = np.concatenate(ref).astype(float)
    return bool(abs(A.mean() - Rf.mean()) < 16 and abs(np.median(A) - np.median(Rf)) < 16)


_SI = {}
def _strip_img(c):
    from PIL import Image
    if c not in _SI:
        if len(_SI) > 24: _SI.clear()
        _SI[c] = np.asarray(Image.open(OUT + f'{c:04d}.webp').convert('RGB'))
    return _SI[c]


def photo_green(sv):
    """is the photo green over the driving line at route distance sv (trees rather than a structure)?"""
    from PIL import Image
    c = int(sv // CH); fn = OUT + f'{c:04d}.webp'
    if not os.path.exists(fn): return False
    im = np.asarray(Image.open(fn).convert('RGB')).astype(float)
    x = int((sv - c * CH) / PX); H = im.shape[0]
    a = im[H // 2 - 16:H // 2 + 16, max(0, x - 8):x + 8].reshape(-1, 3)
    exg = (2 * a[:, 1] - a[:, 0] - a[:, 2]) / (a.sum(1) + 1)
    return float(np.median(exg)) > 0.04


REL = json.load(open(OUT + 'rel_clear.json')) if os.path.exists(OUT + 'rel_clear.json') else {}


def tube_at(x, m=0.0):
    """the tunnel, covered section or wildlife overpass (route_tunnels.py) at route distance x (± m), or None"""
    return next((t for t in TUBES if t['s0'] - m <= x <= t['s1'] + m), None)


def hmodel(x):
    """is there a height model (terrain and surface) at route distance x? (HCREDIT; Thuringia's is not reachable)"""
    reg = REG[min(len(REG) - 1, int(x // CH))]
    return ('DE-BB' if reg == 'DE-BE' else reg) in HCREDIT


def overs(over, sa, sb, ox, oy):
    """the clear-height records of [sa, sb): the mapped structures over the route (measured or not), structures found only
    in the surface model (scan hits: trees, gantries, canopies, vehicles caught on the road), signed limits, and one record
    per tunnel, covered section and wildlife overpass (kind 'tunnel' / 'overpass', s at its first portal, len) — a mapped
    crossing standing on such a lid loses its estimate (the lid is not its underside), scan hits in one are dropped; in a
    state without a height model a structure not measured is flagged nm (not 'nothing above the road')"""
    out = []
    for o in over:
        c = CLR_BY_S.get(round(o['s']), {})
        rec = dict(s=round(c.get('s', o['s']) if c.get('found') else o['s'], 1), s0=round(o['s']), sub=o['sub'], cls=o['cls'], name=o['name'], x=round(o['xy'][0] - ox, 1), y=round(o['xy'][1] - oy, 1), kind='bridge')
        rl = REL.get(f"m{round(o['s'])}")
        level = c.get('found') and rl and rl[0] < 2.0
        inside = BRG is not None and any(rb['s0'] - 5 <= rec['s'] <= rb['s1'] + 5 for rb in (BRG['route'] or []))
        if c.get('laz', {}).get('none'):
            rec.update(note=f"no deck over the convoy in the laser point cloud ({c['laz'].get('date')}): the route passes over or beside this crossing")
        elif inside:
            rec.update(note='the route crosses on a bridge here: nothing above the road')
        elif c.get('found') and c['top'] < 3.5:
            # no structure over a road stands this low (clear height + deck): the convoy's band passes on or beside it
            rec.update(note=f"measured top only {c['top']:.1f} m above the road: the route most likely runs on this structure – check on site")
        elif level and photo_open_road(c['s'], max(6.0, c['length'])):
            # high only against the valley floor, and the photo shows the road running on: the route crosses on its own bridge
            rec.update(note='the route crosses on a bridge here: nothing above the road in the surface model')
        elif c.get('found'):
            from route_clearance import depth_of
            dep, unc = depth_of(o['sub'], o['cls'])           # the current depth table, not the one of the run
            lz = c.get('laz')
            if lz and lz.get('seen'): pass                     # the structure's underside seen in the laser point cloud: measured
            else: c = dict(c, est=round(c['top'] - dep, 2), unc=max(unc, c['unc']) if c.get('src') else unc)    # (laser-terrain records carry the road's spread under the deck)
            if lz:
                need = float(routecfg.get('transport_height', 4.7)) + float(routecfg.get('height_margin', 0.1))
                rec['note'] = (f"lowest point of the structure measured in the laser point cloud ({lz.get('date')})" if lz.get('seen') else
                               f"laser point cloud ({lz.get('date')}): deck top {c['top']:.2f} m above the road; clears {need:.1f} m if the deck is less than {c['top'] - need:.2f} m deep")
            if level: rec['note'] = 'the surface is level with the road here, but the photo does not show open road: check on site'
            elif c.get('covered', 1) < 0.6: rec['note'] = 'the structure covers only part of the convoy band (skewed deck or pier)'
            rec.update(top=c['top'], est=c['est'], unc=c['unc'], len=c['length'], src=c.get('src', 'surface model'))
        elif not hmodel(rec['s']):
            rec['nm'] = 1                                      # no height model in this state: not measured
        elif c:
            rec.update(note='nothing above the road found in the surface model (structure beside the route, or not in the data)')
        if not inside and tube_at(rec['s'], 10.0):
            # a crossing standing on a tunnel's lid (a railway over a covered section's portal): the lid is not its underside,
            # the clear height there is the tunnel's
            for k in ('est', 'unc'): rec.pop(k, None)
            rec['note'] = 'carried on the lid of the covered section'
        out.append(rec)
    # parallel tracks or carriageways of one crossing: one record (the lowest), the classes joined
    out.sort(key=lambda r: r['s']); dedup = []
    for r_ in out:
        p_ = dedup[-1] if dedup else None
        if p_ and abs(r_['s'] - p_['s']) < 15 and p_['kind'] == r_['kind'] == 'bridge':
            s0s = p_.get('s0s', [p_.get('s0')]) + r_.get('s0s', [r_.get('s0')])
            if (r_.get('est') if r_.get('est') is not None else 99) < (p_.get('est') if p_.get('est') is not None else 99):
                r_ = dict(r_, cls=' + '.join(dict.fromkeys([r_['cls'], p_['cls']])), s0s=s0s); dedup[-1] = r_
            else: p_['cls'] = ' + '.join(dict.fromkeys([p_['cls'], r_['cls']])); p_['s0s'] = s0s
            continue
        dedup.append(r_)
    out = dedup
    mapped = [x['s'] for x in out]
    # scan hits: merged when closer than 15 m, then classified by the photo over the driving line
    hits = sorted([q for q in CLR['scan'] if sa <= q['s'] < sb and not any(abs(q['s'] - m) < 30 for m in mapped)], key=lambda q: q['s'])
    merged = []
    for q in hits:
        if merged and q['s'] - q['length'] / 2 - (merged[-1]['s'] + merged[-1]['length'] / 2) < 15:
            m = merged[-1]; a0 = min(m['s'] - m['length'] / 2, q['s'] - q['length'] / 2); a1 = max(m['s'] + m['length'] / 2, q['s'] + q['length'] / 2)
            m.update(s=(a0 + a1) / 2, length=a1 - a0, top=min(m['top'], q['top']))
        else: merged.append(dict(q))
    # in a tunnel or under a covered section or green bridge (± 5 m) the surface model holds the lid, its forest, the portal
    # headwalls: not things over the road (the tunnel has its own record)
    merged = [q for q in merged if not any(q['s'] - q['length'] / 2 <= t['s1'] + 5 and q['s'] + q['length'] / 2 >= t['s0'] - 5 for t in TUBES)]
    for q in merged:
        rl = REL.get(f"s{q.get('reg')}{round(q['s'])}")
        if rl:
            if rl[0] < 2.0: continue                     # level with the road: the route on a bridge, not something over it
            q['top'] = round(min(q['top'], rl[0]), 2)
        green = photo_green(q['s'])
        if not green and q['top'] < 4.6:
            # low, not on the map and not vegetation: almost always vehicles the surface model caught on the road
            op = photo_open_road(q['s'], q['length'])
            out.append(dict(s=round(q['s'], 1), sub=None, cls=None, name=None, kind='artefact', top=q['top'], len=round(q['length'], 1), src='surface model',
                            note='probably a vehicle on the road when the surface model was flown' + (': the photo shows open road here' if op else ' – check the photo here')))
            continue
        kind = 'trees' if green else 'gantry' if q['length'] <= 8 else 'canopy'
        if kind == 'trees':
            out.append(dict(s=round(q['s'], 1), sub=None, cls=None, name=None, kind=kind, top=q['top'], est=round(q['top'] - 0.3, 2), unc=0.8,
                            len=round(q['length'], 1), src='surface model (not in the map data)', note='branches can be cut back'))
        else:
            # a structure the map does not have: its top is in the surface model, its underside is not → always a site check
            out.append(dict(s=round(q['s'], 1), sub=None, cls=None, name=None, kind=kind, top=q['top'], check=True, len=round(q['length'], 1),
                            src='surface model (not in the map data)', note=f"top {q['top']:.1f} m above the road; the underside is not in the data"))
    for L in LIMITS:
        if sa <= L['s'] < sb:
            refs = ' / '.join(sorted([x.strip() for x in (L.get('name') or '').split(';') if x.strip()], key=lambda x: (x.startswith('E '), x[:1].isdigit(), x)))
            out.append(dict(s=round(L['s'], 1), kind='limit', signed=L['value'], name=f'on the {refs}' if refs else None, src='signed (OSM maxheight)',
                            len=round(L.get('len', 0)), note=f"signed over {L.get('len', 0):.0f} m"))
    # tunnels, covered sections and wildlife overpasses: estimated from the lid (or the standard clear height), a check until
    # the registered clear height is known
    for t in TUBES:
        if sa <= t['s0'] < sb:
            out.append(dict(s=round(t['s0'], 1), s1=round(t['s1'], 1), sub=None, cls=None, name=t.get('name'), kind=t['kind'], len=round(t['len'], 1),
                            est=t.get('est'), unc=t.get('unc'), std=t.get('std'), H=t.get('H'), lidtop=t.get('lidtop'), signed=t.get('signed'),
                            phys=t.get('phys'), src=t.get('src'), note=t.get('note'), check=t.get('signed') is None and t.get('phys') is None))
    return sorted(out, key=lambda r: r['s'])


BRG = pickle.load(open(OUT + 'bridges.pkl', 'rb')) if os.path.exists(OUT + 'bridges.pkl') else None
SIGNS = json.load(open(OUT + 'signs.json')) if os.path.exists(OUT + 'signs.json') else []   # route_signs.py
SPEED = np.load(OUT + 'speed_1m.npz') if os.path.exists(OUT + 'speed_1m.npz') else None     # route_signs.py


def signs_for(sa, sb):
    """the route's signs: [s, d, dir, code, v] plus, except on guide posts, the approach speed (sets the size class)"""
    return [[round(q['s'], 1), q['d'], q['dir'], q['code'], q['v']] + ([q['sp']] if 'sp' in q else []) for q in SIGNS if sa - 5 <= q['s'] <= sb + 5]


def speeds_for(i0, i1):
    """the speed in force where it changes: [[s, ours, opposite], …] (km/h) — sizes the map's own stop, give-way and
    bus-stop signs"""
    if SPEED is None: return []
    f, b = SPEED['f'][i0:i1].astype(int), SPEED['b'][i0:i1].astype(int)
    k = np.r_[0, np.nonzero((np.diff(f) != 0) | (np.diff(b) != 0))[0] + 1]
    return [[round(float(s[i0 + j]), 1), int(f[j]), int(b[j])] for j in k]


ROADS = pickle.load(open(OUT + 'roads.pkl', 'rb'))['blocks'] if os.path.exists(OUT + 'roads.pkl') else None   # route_roads.py
ROAD_CLS = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service', 'track', 'unknown']
_RKD = None


def _road_pieces():
    """every piece of roads.pkl resampled to ≤ 5 m, per point: the route distance of the nearest route sample (s), whether
    it is an original vertex, and whether the piece runs there as the opposite carriageway (a one-way motorway / trunk
    piece, not a ramp, heading the other way 8–40 m to the left: route_lanelines.opposite's rule)"""
    global _RKD
    if _RKD is not None: return _RKD
    from scipy.spatial import cKDTree
    kd = cKDTree(P); N = r['N']; T = np.c_[N[:, 1], -N[:, 0]]; out = []
    for blk in ROADS.values():
        for q in blk:
            xy = q['xy'].astype(np.float64)
            if len(xy) < 2: continue
            seg = np.hypot(*np.diff(xy, axis=0).T); m = np.maximum(1, np.ceil(seg / 5.0).astype(int))
            pts = np.concatenate([xy[i] + (xy[i + 1] - xy[i]) * np.arange(m[i])[:, None] / m[i] for i in range(len(seg))] + [xy[-1:]])
            orig = np.zeros(len(pts), bool); orig[np.r_[0, np.cumsum(m)]] = True
            dd, k = kd.query(pts); k = np.minimum(k, n - 1)
            opp = np.zeros(len(pts), bool)
            if q['cls'] in ('motorway', 'trunk') and q['sub'] != 'link' and q['oneway']:
                g = np.gradient(pts, axis=0); g /= np.linalg.norm(g, axis=1)[:, None] + 1e-9
                v = pts - P[k]; lat = (v * N[k]).sum(1); along = (v * T[k]).sum(1); head = (g * T[k]).sum(1) * q['oneway']
                opp = (head < -0.9) & (lat >= 8) & (lat <= 40) & (np.abs(along) < 4)
                # runs under 20 m (a junction's corner) join their neighbours
                for _ in range(2):
                    e = np.flatnonzero(np.diff(np.r_[-1, opp.astype(int), -1]))
                    for a_, b_ in zip(e[:-1], e[1:]):
                        if (b_ - a_) * 5.0 < 20 and 0 < a_ and b_ < len(opp): opp[a_:b_] = not opp[a_]
            out.append((q, pts, s[k], orig, opp, float(s[k].min()), float(s[k].max())))
    _RKD = out
    return out


def roads_for(sa, sb, ox, oy):
    """the roads near the route (not the route itself), each piece cut to the part beside the pack's stretch [sa − 10, sb +
    10] (by the nearest route sample) and split where it runs as the opposite carriageway: [class, width dm (0 = typical),
    flags (1 bridge, 2 tunnel, 4 one-way, 8 unpaved, 16 link, 32 opposite carriageway), level, [x, y, …] dm from the pack
    origin]"""
    if ROADS is None: return []
    out = []
    for q, pts, ps, orig, opp, s_lo, s_hi in _road_pieces():
        if s_hi < sa - 10 or s_lo > sb + 10: continue
        inr = (ps >= sa - 10) & (ps <= sb + 10)
        if not inr.any(): continue
        fl = (1 if q['bridge'] else 0) | (2 if q['tunnel'] else 0) | (4 if q['oneway'] else 0) | (8 if (q['surf'] or 'paved') not in ('paved', 'asphalt', 'concrete', 'paving_stones', 'sett', 'cobblestone', 'metal', 'wood') or (q['cls'] == 'track' and not q['surf']) else 0) | (16 if q['sub'] == 'link' else 0)
        c = ROAD_CLS.index(q['cls']) if q['cls'] in ROAD_CLS else len(ROAD_CLS) - 1
        key = np.where(inr, 1 + opp.astype(int), 0)                    # 0 outside, 1 a road, 2 the opposite carriageway
        e = np.flatnonzero(np.diff(np.r_[-1, key, -1]))
        for a_, b_ in zip(e[:-1], e[1:]):
            if key[a_] == 0: continue
            a1, b1 = a_, min(len(pts), b_ + 1) if b_ < len(pts) and key[b_] else b_     # (joined to the next run's first point)
            if b1 - a1 < 2: continue
            keep = orig[a1:b1].copy(); keep[0] = keep[-1] = True        # the original vertices and the cut points
            xy = pts[a1:b1][keep]
            out.append([c, int(round((q['w'] or 0) * 10)), fl | (32 if key[a_] == 2 else 0), int(q['level']), np.round((xy - [ox, oy]) * 10).astype(int).ravel().tolist()])
    return out


def tun_for(sa, sb):
    """the tunnels, covered sections, wildlife overpasses and bridges inside a flagged piece (route_tunnels.py) reaching into
    the pack's stretch ± 60 m: every field, the road profile and the lid rows cut to that stretch"""
    out = []
    for t in TUN or []:
        if t['s1'] < sa - 60 or t['s0'] > sb + 60: continue
        q = dict(t)
        if q.get('prof'): q['prof'] = [p_ for p_ in q['prof'] if sa - 60 <= p_[0] <= sb + 60]
        L = q.get('lid')
        if L and L.get('rel'):
            r0 = max(0, int(np.floor((sa - 60 - L['s0']) / L['step']))); r1 = min(len(L['rel']), int(np.ceil((sb + 60 - L['s0']) / L['step'])) + 1)
            q['lid'] = dict(L, s0=round(L['s0'] + r0 * L['step'], 2), rel=L['rel'][r0:r1])
        out.append(q)
    return out


def marks_for(i0, i1):
    """the route's markings where they change: [[s, class, two-way, town], …] (town: 50 km/h or less applies)"""
    tw = np.load(OUT + 'lanes_1m.npz')['tw'][i0:i1].astype(int) if os.path.exists(OUT + 'lanes_1m.npz') else np.ones(i1 - i0, int)
    cl = np.array([ROAD_CLS.index(c) if c in ROAD_CLS else len(ROAD_CLS) - 1 for c in _RCLS[i0:i1]])
    tn = (SPEED['f'][i0:i1] <= 50).astype(int) if SPEED is not None else np.zeros(i1 - i0, int)
    key = cl * 4 + tw * 2 + tn
    # runs shorter than 30 m join the previous one
    out = []; j = 0
    while j < len(key):
        k = j
        while k < len(key) and key[k] == key[j]: k += 1
        if out and (k - j < 30 or out[-1][4] == key[j]): pass
        else: out.append([round(float(s[i0 + j]), 1), int(cl[j]), int(tw[j]), int(tn[j]), int(key[j])])
        j = k
    return [o[:4] for o in out]


_RU = pickle.load(open(routecfg.C + 'route.pkl', 'rb'))
_RCLS = np.array([_RU[k][0]['cls'] for k in range(len(_RU))])[r['SEG']]


# the route's height on its own bridges: GLO-30 (30 m cells) sags into the valley under a viaduct. There the road is a line
# between the approaches plus the surface model's deviation from such a line over the driving line (the vertical curve);
# the terrain across (rel, srel) is then given relative to that deck. The 100 m gradient follows the corrected height.
DECK_DEV = {}


def _deck_heights():
    z0 = np.nan_to_num(E['z0']).astype(float).copy()
    if BRG is None or not BRG['route']: return z0
    s10 = s[::10][:len(z0)]
    from scipy.ndimage import median_filter
    for rb in BRG['route']:
        s0, s1 = rb['s0'], rb['s1']
        a = (s10 > s0 - 40) & (s10 < s0 - 15); b = (s10 > s1 + 15) & (s10 < s1 + 40)
        if not a.any() or not b.any(): continue
        za, zb = np.median(z0[a]), np.median(z0[b]); xa, xb = s10[a].mean(), s10[b].mean()
        nr = len(rb['rel']) if rb.get('rel') is not None else int(round((s1 - s0 + 24) / 4)) + 1
        sv = rb['sa'] + rb['step'] * np.arange(nr)
        dev = np.zeros(nr)
        if rb.get('surf') is not None:
            sf = np.asarray(rb['surf'], float); ok = np.isfinite(sf) & (np.abs(sf) < 8)
            if ok.mean() >= 0.5:
                sf = np.interp(sv, sv[ok], sf[ok]); sf = median_filter(sf, 5, mode='nearest')
                e0, e1 = sv < s0 - 3, sv > s1 + 3
                ea = sf[e0].mean() if e0.any() else sf[0]; eb = sf[e1].mean() if e1.any() else sf[-1]
                dev = sf - (ea + (eb - ea) * (sv - sv[0]) / max(1.0, sv[-1] - sv[0]))
                dev = np.where((sv > s0 - 3) & (sv < s1 + 3), dev, 0.0)
        DECK_DEV[round(s0, 1)] = dev
        m = (s10 >= sv[0]) & (s10 <= sv[-1])
        z0[m] = za + (zb - za) * (s10[m] - xa) / (xb - xa) + np.interp(s10[m], sv, dev)
    # under a bridge over the route the 30 m elevation model can hold the deck (a hump of up to several metres in the
    # road): the road follows the line between its approaches there (40–80 m out), dips kept, humps removed
    own = [(rb['s0'] - 20, rb['s1'] + 20) for rb in BRG['route']]
    for o in BRG.get('over', {}).values():
        c = o['s0']
        if any(a <= c <= b for a, b in own): continue
        a = (s10 > c - 80) & (s10 < c - 40); b = (s10 > c + 40) & (s10 < c + 80); w = (s10 >= c - 40) & (s10 <= c + 40)
        if a.sum() < 2 or b.sum() < 2 or not w.any(): continue
        A = np.r_[s10[a], s10[b]]; Z = np.r_[z0[a], z0[b]]
        k, d = np.polyfit(A, Z, 1)
        line = k * s10[w] + d
        z0[w] = np.minimum(z0[w], line + 0.1)
    return z0


def _vprof_road():
    """per metre: the road's height at the route line (route_vprof.py z1) and its cross slope (q1, ±7 %); where the fit has
    no value, the old road (GLO-30 and the decks) shifted onto the fit, the shift interpolated across the gap (blended into
    the fit at both ends; with a complete fit the old road is not made at all)"""
    z1 = np.full(n, np.nan); q1 = np.zeros(n); m = min(n, len(VP['z1']))
    z1[:m] = VP['z1'][:m]; q1[:m] = np.nan_to_num(VP['q1'][:m].astype(float))
    bad = ~np.isfinite(z1)
    if bad.any():
        old = gaussian_filter1d(_deck_heights(), 4); zo = np.interp(np.arange(n) / 10.0, np.arange(len(old)), old)
        k = np.flatnonzero(~bad)
        z1[bad] = zo[bad] + (np.interp(np.flatnonzero(bad), k, (z1 - zo)[k]) if len(k) else 0.0)
        print(f'  road height: {bad.sum()} m without the fit, the GLO-30 road blended in', flush=True)
    return z1, np.clip(q1, -0.07, 0.07)


def _deck_dev_vprof(Z1, Q1):
    """DECK_DEV from the fitted road: the road at the rows' driving line minus the rows' reference line (route_bridges.py:
    the terrain model through the bridge's ends), so that rel − dev is the terrain relative to the road drawn. The reference
    is recovered as a robust line through the fitted road less the surface model's height over it (surf: the deck the fit
    took, ≈ 0 on open road), else through the fitted road just beyond the ends"""
    for rb in (BRG['route'] if BRG is not None else None) or []:
        if rb.get('rel') is None: continue
        sv = rb['sa'] + rb['step'] * np.arange(len(rb['rel'])); ii = np.clip(np.searchsorted(s, sv), 0, n - 1)
        zr = Z1[ii] + Q1[ii] * S1['shift'][ii].astype(float)
        sf = np.asarray(rb['surf'], float) if rb.get('surf') is not None else np.full(len(sv), np.nan)
        ok = np.isfinite(sf) & (np.abs(sf) < 8); ends = (sv < rb['s0'] - 3) | (sv > rb['s1'] + 3)
        x, y = (sv[ok], (zr - sf)[ok]) if ok.sum() >= max(3, 0.5 * len(sv)) else (sv[ends], zr[ends])
        if len(x) < 2: continue
        keep = np.ones(len(x), bool)
        for _ in range(3):                                             # (a vehicle on the deck, a gantry: dropped)
            a, b = np.polyfit(x[keep], y[keep], 1); r_ = np.abs(y - (a * x + b))
            keep = r_ <= max(0.15, 3 * np.median(r_[keep]))
            if keep.sum() < 2: break
        DECK_DEV[round(rb['s0'], 1)] = zr - (a * sv + b)


if VP is None:
    z10 = gaussian_filter1d(_deck_heights(), 4)
    for _rb in (BRG['route'] if BRG is not None else None) or []:     # no cross fall from the valley sides on a bridge
        _s10 = s[::10][:len(slope10)]
        slope10 *= 1 - np.clip(np.minimum(_s10 - (_rb['s0'] - 12), (_rb['s1'] + 12) - _s10) / 12, 0, 1)
    Z1 = Q1 = None
else:
    # the fitted vertical alignment: per metre for the packs, every 10 m for the survey rows' grade
    Z1, Q1 = _vprof_road(); _deck_dev_vprof(Z1, Q1)
    z10 = Z1[::10]; slope10 = Q1[::10]
g10 = (np.gradient(z10, 10.0) * 100).astype(np.float32)


def deck_extent(r_, rel, srel):
    """one deck extent per side for a route bridge (left dl > 0, right dr < 0 of the route line), the same in every pack:
    the measured carriageway edges over the middle of the span, widened where the surface beside stays at road level above
    low ground over most of the span (a second carriageway on the deck; some terrain models keep the deck as ground); never
    narrower than the packed edges anywhere on the span (+ 0.9 m) and the painted edge lines (+ 1.4 m); out to the opposite
    carriageway's outer edge + 0.9 m where it runs on a twin deck or on the same deck (lanelines' oout over low ground), no
    farther. Returns (dl, dr, tw): tw = [s0, s1, inner, outer edge] of a twin deck reaching 4 m or more beyond our deck's
    ends, else None"""
    s0, s1 = r_['s0'], r_['s1']; L = s1 - s0
    i0 = int(np.searchsorted(s, s0 + 0.2 * L)); i1 = max(i0 + 1, int(np.searchsorted(s, s1 - 0.2 * L)))
    dl = float(np.nanmedian(S1['L'][i0:i1])) + 0.9; dr = -float(np.nanmedian(S1['R'][i0:i1])) - 0.9
    if not np.isfinite(dl): dl = 6.5
    if not np.isfinite(dr): dr = -6.5
    rows = deep = D = None
    if srel is not None:
        D = np.asarray(r_['D'], float); sv = r_['sa'] + r_['step'] * np.arange(len(rel))
        rows = np.where((sv >= s0 + 0.2 * L) & (sv <= s1 - 0.2 * L))[0]
        if not len(rows): rows = np.where((sv >= s0) & (sv <= s1))[0]
        if len(rows):
            deep = rel[rows].min(1) < -4
            for side in (1, -1):
                ext = dl if side > 0 else dr
                for i in sorted([i for i in range(len(D)) if side * D[i] > side * ext], key=lambda i: side * D[i]):
                    if abs(D[i] - ext) > 9: break
                    frac = float(np.mean((np.abs(srel[rows, i]) < 1.0) & ((rel[rows, i] < -1.5) | deep)))
                    if frac < 0.6: break
                    ext = float(D[i] + side * 1.5)
                if side > 0: dl = ext
                else: dr = ext
    # never narrower than our carriageway anywhere on the span (the median of the raw edges put parapets in the lane where
    # the carriageway widens on the deck)
    j0, j1 = int(np.searchsorted(s, s0 + 1)), max(int(np.searchsorted(s, s0 + 1)) + 1, int(np.searchsorted(s, s1 - 1)))
    minL = float(np.nanmax(EL1[j0:j1])) + 0.9 if np.isfinite(EL1[j0:j1]).any() else -np.inf
    minR = float(np.nanmax(ER1[j0:j1])) + 0.9 if np.isfinite(ER1[j0:j1]).any() else -np.inf
    if LL is not None:
        eL = LL['eL'][j0:j1].astype(float); eR = LL['eR'][j0:j1].astype(float)
        if np.isfinite(eL).mean() > 0.3: minL = max(minL, float(np.nanmax(eL)) + 1.4)
        if np.isfinite(eR).mean() > 0.3: minR = max(minR, -float(np.nanmin(eR)) + 1.4)
    minL = min(minL, 30.0); minR = min(minR, 30.0)
    # the opposite carriageway: on a twin deck (roads.pkl), or wherever lanelines measured its outer edge over low ground
    tw = twin_bridge(s0 + 0.2 * L, s1 - 0.2 * L)
    oo = LL['oout'][i0:i1].astype(np.float64) if LL is not None else np.full(1, np.nan)
    oi = LL['oin'][i0:i1].astype(np.float64) if LL is not None else np.full(1, np.nan)
    OO = float(np.nanpercentile(oo, 80)) if np.isfinite(oo).mean() > 0.4 else np.nan
    OI = float(np.nanmedian(oi)) if np.isfinite(oi).mean() > 0.4 else np.nan
    if np.isfinite(OO) and np.isfinite(OI) and OO - OI > 18: OO = OI + 18.0      # (no carriageway is wider: an outer edge run off)
    low = False
    if np.isfinite(OO) and D is not None and rows is not None and len(rows):
        j = int(np.argmin(np.abs(D - OO)))                            # the terrain under that carriageway lies low (a valley)
        low = bool(np.mean((rel[rows, j] < -1.5) | deep) > 0.5)
    if tw is not None or low:
        edge = OO if np.isfinite(OO) else tw['edge']
        dl = edge + 0.9                                                # its outer edge + 0.9 m: no farther (no parapet on its shoulder)
    dl = max(dl, minL); dr = min(dr, -minR)
    twr = None
    if tw is not None and (tw['s0'] < s0 - 4 or tw['s1'] > s1 + 4):
        inner = OI if np.isfinite(OI) else tw['inner']
        if np.isfinite(inner) and inner > 0 and dl - 0.9 > inner: twr = [round(tw['s0'], 1), round(tw['s1'], 1), round(inner, 2), round(dl - 0.9, 2)]
    return round(dl, 2), round(dr, 2), twr


def twin_bridge(a, b):
    """the opposite carriageway where roads.pkl has it on a bridge over [a, b] of the route (its piece flagged as bridge
    there, running the other way 8–40 m to the left over at least 40 % of the stretch): {edge: its outer edge (centreline
    + half its width, m, left +), inner: its inner edge, s0, s1: the stretch of the route it runs beside as a bridge};
    None where there is none"""
    if ROADS is None or b <= a: return None
    N = r['N']; best = None
    for q, pts, ps, orig, opp, lo, hi in _road_pieces():
        if not q['bridge'] or hi < a or lo > b: continue
        m = opp & (ps >= a) & (ps <= b)
        if m.sum() < 2 or np.ptp(ps[m]) < 0.4 * (b - a): continue
        k = np.clip(np.searchsorted(s, ps[m]), 0, n - 1)
        c = float(np.median(((pts[m] - P[k]) * N[k]).sum(1))); w = (q['w'] or 11.0) / 2
        e = c + w
        if best is None or e > best['edge']:
            best = dict(edge=e, inner=c - w, s0=float(ps[opp].min()), s1=float(ps[opp].max()))
    return best


def bridges_for(sa, sb, ox, oy, over_recs):
    """3D bridges of a pack: decks over the route (centreline, width, surface and terrain along it) and the stretches
    where the route runs on its own bridge (terrain across it, relative to the road)"""
    if BRG is None: return [], []
    own = {x for r_ in over_recs if (r_.get('note') or '').startswith(('the route crosses', 'measured top only')) for x in r_.get('s0s', [r_.get('s0')]) if x is not None}
    # crossings inside the route's own bridges pass under the route too
    for r_ in over_recs:
        if r_.get('kind') == 'bridge' and any(rb['s0'] - 8 <= r_['s'] <= rb['s1'] + 8 for rb in (BRG['route'] or [])):
            own.update(x for x in r_.get('s0s', [r_.get('s0')]) if x is not None)
    q2 = lambda a, k=1: [round(float(v), k) for v in np.asarray(a).ravel()]
    over = []
    for key, b in BRG['over'].items():
        if not (sa <= b['s0'] < sb) or round(b['s0']) in own: continue
        parts = []
        for pt in b['parts']:
            L = np.asarray(pt['line'], float)
            if len(L) < 2: continue
            ti = int(np.argmin(np.hypot(L[:, 0] - b['xy'][0], L[:, 1] - b['xy'][1])))
            if np.hypot(L[ti, 0] - b['xy'][0], L[ti, 1] - b['xy'][1]) > 10: continue      # a flagged piece away from the crossing
            d = dict(xy=q2(L - [ox, oy]), ti=ti)
            if pt['S'] is not None and np.isfinite(pt['S']).any(): d.update(S=q2(np.nan_to_num(pt['S'], nan=-999), 2), T=q2(np.nan_to_num(pt['T'], nan=-999), 2))
            parts.append(d)
        if parts: over.append(dict(s0=round(b['s0']), cls=b['cls'], sub=b['sub'], name=b['name'], w=round(b['width'], 1), lv=b['level'], parts=parts))
    unders = [r_ for r_ in over_recs if r_.get('s0') in own]
    rb = []
    for r_ in BRG['route'] or []:
        if r_['s1'] < sa - 80 or r_['s0'] > sb + 80: continue          # (its approach rows reach 72 m beyond the ends)
        und = [x for x in unders if r_['s0'] - 15 <= x['s'] <= r_['s1'] + 15]
        d = dict(s0=round(r_['s0'], 1), s1=round(r_['s1'], 1), sa=round(r_['sa'], 1), step=r_['step'], D=r_['D'],
                 under=[(x['name'] or ('railway' if x['sub'] == 'rail' else (x['cls'] or 'road'))) for x in und][:3],
                 cls=str(_RCLS[min(len(_RCLS) - 1, int(np.searchsorted(s, (r_['s0'] + r_['s1']) / 2)))]))
        if r_.get('rel') is not None:
            dev = DECK_DEV.get(round(r_['s0'], 1)); dev = np.zeros(len(r_['rel'])) if dev is None else dev
            rel = np.clip(np.nan_to_num(np.asarray(r_['rel'], float) - dev[:, None], nan=0.0), -80, 20)
            d['rel'] = [q2(row) for row in rel]
            srel = None
            if r_.get('srel') is not None:
                srel = np.clip(np.nan_to_num(np.asarray(r_['srel'], float) - dev[:, None], nan=-99), -99, 40)
                d['srel'] = [q2(row) for row in srel]
            d['dl'], d['dr'], tw = deck_extent(r_, rel, srel)
        else: d['dl'], d['dr'], tw = deck_extent(r_, None, None)
        if tw is not None: d['tw'] = tw                                # (the twin deck beyond our deck's ends: the page draws it)
        rb.append(d)
    return over, rb


def q16(a, sc):
    return np.clip(np.round(np.nan_to_num(a) * sc), -32767, 32767).astype(np.int16)


def q16u(a, sc=100):
    """int16 of a·sc with −32768 where a is unknown (NaN)"""
    a = np.asarray(a, np.float64)
    return np.where(np.isfinite(a), np.clip(np.round(np.nan_to_num(a) * sc), -32767, 32767), -32768).astype(np.int16)


def build(p):
    c0, c1 = p * PACK, (p + 1) * PACK
    chunks = []
    for c in range(c0, c1):
        if os.path.exists(OUT + f'{c:04d}.webp'): chunks.append(c)
    if not chunks: return None
    sa = c0 * CH; sb = min(s[-1], c1 * CH)
    i0 = int(np.searchsorted(s, sa)); i1 = int(np.searchsorted(s, sb))
    ox, oy = float(np.round(P[i0, 0])), float(np.round(P[i0, 1]))
    arrays = []
    def add(name, a):
        arrays.append((name, np.ascontiguousarray(a)))
    # centreline + strip normals every 2 m
    k2 = np.arange(i0, i1, 2)
    add('cen', np.c_[P[k2, 0] - ox, P[k2, 1] - oy].astype(np.float32))
    add('s2', s[k2].astype(np.float64))
    add('nor', q16(r['N'][k2], 30000))
    if Z1 is not None:                        # the fitted road (route_vprof.py): height at the route line, cross slope
        add('z', Z1[k2].astype(np.float32)); add('slope', q16(Q1[k2], 10000))
    else:
        add('z', (np.interp(k2 / 10.0, np.arange(len(z10)), z10)).astype(np.float32))
        add('slope', q16(np.interp(k2 / 10.0, np.arange(len(slope10)), slope10), 10000))
    # per metre → per 2 m: edges (through a tunnel from its portals), envelope, dolly offset
    add('edge', np.c_[q16(EL1[k2], 100), q16(ER1[k2], 100)])
    add('env', q16(S1['env'][k2].astype(np.float32), 100))
    add('off', q16(S1['off'][k2].astype(np.float32), 100))
    add('shift', q16(S1['shift'][k2].astype(np.float32), 100))
    if LN is not None:
        add('drv', q16(LN['drv'][k2].astype(np.float32), 100))
        add('onc', q16(ONC[k2], 100))
        if 'own' in LN.files and LL is not None:
            # the convoy's own lane and the painted edge lines: [own (its left boundary), eR, eL, kr (keep right)] cm, left +
            # (−32768 unknown; keep right is undefined where no edge was traced)
            add('lane', np.c_[q16u(LN['own'][k2]), q16u(LL['eR'][k2]), q16u(LL['eL'][k2]),
                              q16u(np.where(S1['have'][k2], LN['kr'][k2].astype(np.float64), np.nan))])
    if LL is not None:
        # our carriageway's lane count and the central reservation: [axis, opposite inner / outer paved edge, barrier top
        # above the road] cm (−32768 none / unknown), its type (1 double steel guard rail, 2 concrete step barrier, 3 raised
        # median with a rail on top) and a raised median's width (dm)
        add('nl', LL['nl'][k2].astype(np.uint8))
        add('lq', LL['lq'][k2].astype(np.uint8))           # how the lanes were found (0: laid from the stretches around)
        add('med', np.c_[q16u(LL['ax'][k2]), q16u(LL['oin'][k2]), q16u(LL['oout'][k2]), q16u(LL['mh'][k2])])
        add('mty', LL['mtyp'][k2].astype(np.uint8))
        add('mw', np.clip(np.round(np.nan_to_num(LL['mw'][k2].astype(np.float64)) * 10), 0, 255).astype(np.uint8))
        if 'cl' in LL.files: add('cl', q16u(LL['cl'][k2]))                  # painted centre line of a two-way road (cm, −32768 unknown)
        if 'ex' in LL.files: add('ex', LL['ex'][k2].astype(np.uint8))       # 1 = an exit / entry lane right of the edge line
    # survey rows every 10 m (edges through a tunnel from its portals, not counted as measured there)
    a10, b10 = i0 // 10, (i1 + 9) // 10
    nr = len(S10['L'][a10:b10]); rows = np.arange(a10, a10 + nr); tube = IN10[np.minimum(rows, len(IN10) - 1)]
    for key, sc in (('L', 100), ('R', 100), ('Lraw', 100), ('Rraw', 100), ('Rc', 1), ('grade', 100), ('wm', 100), ('bL', 100), ('bR', 100), ('wo', 100), ('have', 100), ('occl', 100), ('openL', 1), ('openR', 1)):
        v = (g10 if key == 'grade' else S10[key])[a10:a10 + nr].astype(np.float32)
        if key == 'Rc': v = np.minimum(v, 30000)
        if key in ('L', 'R', 'Lraw', 'Rraw') and tube.any(): v[tube] = (EL1 if key[0] == 'L' else ER1)[np.minimum(rows[tube] * 10, n - 1)]
        if key == 'have': v[tube] = 0
        add('s_' + key, q16(v, sc))
    if VP is not None:
        # the terrain beside the road relative to the road's plane, cm, rows as the survey's × the offsets xrd
        X = np.full((nr, VP['xrel'].shape[1]), -32768, np.int16); m_ = max(0, min(nr, len(VP['xrel']) - a10)); X[:m_] = VP['xrel'][a10:a10 + m_]
        add('xrel', X)
    # objects
    ob = blocks_for(i0, i1)
    from shapely.geometry import LineString
    ln = LineString(P[i0:i1:5])
    pts = [o for o in ob['pts'] if ln.distance(__import__('shapely').geometry.Point(o['xy'])) < 45]
    # signals, stop and give-way signs mapped as a node on the road itself mark the junction, not the pole: place them at the
    # measured kerbs (signals both sides, signs on the right of the direction of travel), flagged as an assumed position
    from scipy.spatial import cKDTree
    kd = cKDTree(P[i0:i1]); kerb = []
    out_pts = []
    for o in pts:
        dist, k = kd.query(o['xy']); k += i0
        lat = (o['xy'][0] - P[k, 0]) * r['N'][k, 0] + (o['xy'][1] - P[k, 1]) * r['N'][k, 1]
        if o['cls'] in ('traffic_signals', 'stop', 'give_way') and abs(lat) < 2.5 and S1['have'][k]:
            L_, R_ = float(S1['L'][k]), float(S1['R'][k])
            sides = (L_ + 0.8, -(R_ + 0.8)) if o['cls'] == 'traffic_signals' else (-(R_ + 0.8),)
            for dd in sides:
                q = dict(o); q['xy'] = (float(P[k, 0] + r['N'][k, 0] * dd), float(P[k, 1] + r['N'][k, 1] * dd)); out_pts.append(q); kerb.append(1)
        else:
            out_pts.append(o); kerb.append(0)
    pts = out_pts
    add('obj_xy', np.array([[o['xy'][0] - ox, o['xy'][1] - oy] for o in pts], np.float32).reshape(-1, 2))
    add('obj_c', np.array([OBJ_CLASSES.index(o['cls']) if o['cls'] in OBJ_CLASSES else len(OBJ_CLASSES) - 1 for o in pts], np.uint8))
    # measured heights: the surface model's peak above the terrain within 1 m of the mapped position (dm; 0 = unknown).
    # obj_hs: 0 map tag / typical, 1 measured, 2 measured value implausible for the class (tree or structure over it, or a
    # thin pole the surface model missed) → the page uses the typical height and says so
    oh = np.zeros(len(pts), np.uint16); ohs = np.zeros(len(pts), np.uint8)
    if len(pts) and os.environ.get('OBJ_HEIGHTS', '1') == '1':
        try:
            import elev
            reg = REG[min(len(REG) - 1, c0)]; reg = 'DE-BB' if reg == 'DE-BE' else reg
            if reg in elev.SAMPLERS:
                xy = np.array([o['xy'] for o in pts])
                g = (-1.0, 0, 1.0) if reg in getattr(elev, 'COARSE', ()) else (-1.0, -0.5, 0, 0.5, 1.0)
                off = np.array([[dx, dy] for dx in g for dy in g])
                X = xy[:, :1] + off[None, :, 0]; Y = xy[:, 1:] + off[None, :, 1]
                Hh = elev.above_ground(reg, X, Y)
                if Hh is not None:
                    hm = np.nanmax(np.nan_to_num(Hh), axis=1)
                    for k, o in enumerate(pts):
                        lo, hi = OBJ_RANGE.get(o['cls'], (0.8, 12.0))
                        if lo <= hm[k] <= hi: oh[k] = int(round(hm[k] * 10)); ohs[k] = 1
                        else: ohs[k] = 2
        except Exception as ex:
            print('  object heights', p, repr(ex))
    for k, o in enumerate(pts):
        h = (o.get('tags') or {}).get('height') or o.get('h')
        try:
            if h: oh[k] = int(float(str(h).replace('m', '').strip()) * 10); ohs[k] = 0
        except ValueError: pass
    add('obj_h', oh); add('obj_hs', ohs); add('obj_k', np.array(kerb, np.uint8))
    # trees within 40 m of the route: tops in the surface model (local maxima ≥ 4 m) that are green on the photo
    tr = trees_for(c0, chunks, i0, i1, ox, oy) if os.environ.get('TREES', '1') == '1' else np.zeros((0, 7), np.int32)
    add('tree', road_trees(tube_trees(tr, ox, oy), ox, oy))
    lines = []
    for o in ob['lines']:
        g = o['g']
        for gg in getattr(g, 'geoms', [g]):
            if gg.geom_type == 'LineString' and gg.length > 2 and ln.distance(gg) < 45 and o['cls'] in BAR[:-1]:
                lines.append((BAR.index(o['cls']) if o['cls'] in BAR else len(BAR) - 1, np.asarray(gg.coords)[:, :2]))
    add('bar_n', np.array([len(L) for _, L in lines], np.uint16))
    add('bar_c', np.array([c for c, _ in lines], np.uint8))
    add('bar_xy', (np.concatenate([L for _, L in lines]) - [ox, oy]).astype(np.float32) if lines else np.zeros((0, 2), np.float32))
    blds = []
    for b in ob['bld']:
        g = b['g']
        for gg in getattr(g, 'geoms', [g]):
            if gg.geom_type == 'Polygon' and ln.distance(gg) < 50:
                h = b['h'] or ((b['fl'] or 2) * 3.0 + 1.5)
                blds.append((float(h), np.asarray(gg.exterior.coords)[:-1, :2]))
    add('bld_n', np.array([len(L) for _, L in blds], np.uint16))
    add('bld_h', np.array([h for h, _ in blds], np.float32))
    add('bld_xy', (np.concatenate([L for _, L in blds]) - [ox, oy]).astype(np.float32) if blds else np.zeros((0, 2), np.float32))
    over = [o for o in ob['over'] if sa <= o['s'] < sb]
    # blob
    blob = b''; meta = []
    for name, a in arrays:
        pad = (-len(blob)) % 8; blob += b'\0' * pad
        meta.append(dict(n=name, t=a.dtype.str, o=len(blob), l=int(a.size), sh=list(a.shape)))
        blob += a.tobytes()
    comp = zlib.compress(blob, 9)[2:-4]
    import base64, io
    from PIL import Image
    # KEEP_PIX=1: the pack's picture as it is (the strips have not changed: only their sizes are read for the layout; the
    # WebP encoding is the slow part of a pack)
    keep_pix = os.environ.get('KEEP_PIX') == '1' and os.path.exists(os.path.join(DIST, f'{p:03d}.webp'))
    ch = []; strips = []
    for c in chunks:
        z = np.load(OUT + f'{c:04d}.npz')
        im = Image.open(OUT + f'{c:04d}.webp') if keep_pix else Image.open(OUT + f'{c:04d}.webp').convert('RGB')
        ss, cen, nor = strip_frame(c)
        ch.append(dict(c=c, s0=round(float(ss[0]), 2), ncol=len(ss), w=im.width, h=im.height, y=sum(x.height for x in strips), reg=str(z['reg'])))
        strips.append(im)
    wide = []; wims = []
    for c in chunks:
        fw = OUT + f'{c:04d}w.webp'
        if not os.path.exists(fw): continue
        im = Image.open(fw) if keep_pix else Image.open(fw).convert('RGB')
        s0c = c * CH; s1c = min(s[-1], s0c + CH)
        wide.append(dict(c=c, s0=round(float(s0c), 2), ncol=int(len(np.arange(s0c, s1c, 2.0))), px=2.0, w=im.width, h=im.height, y=sum(x.height for x in wims)))
        wims.append(im)
    # one picture per pack (the artifact's file count is limited): the strips stacked on the left, the wide band's
    # pictures stacked in a column to their right
    W0 = max(i.width for i in strips); H0 = sum(i.height for i in strips)
    W1 = max([i.width for i in wims] or [0]); H1 = sum(i.height for i in wims)
    for w in wide: w['x'] = W0
    wa_ = b''
    if keep_pix: sa_ = open(os.path.join(DIST, f'{p:03d}.webp'), 'rb').read()
    else:
        A = Image.new('RGB', (W0 + W1, max(H0, H1))); y = 0
        for i in strips: A.paste(i, (0, y)); y += i.height
        y = 0
        for i in wims: A.paste(i, (W0, y)); y += i.height
        bb = io.BytesIO(); A.save(bb, 'WEBP', quality=62, method=6); sa_ = bb.getvalue()
        open(os.path.join(DIST, f'{p:03d}.webp'), 'wb').write(sa_)
    if os.path.exists(os.path.join(DIST, f'{p:03d}w.webp')): os.remove(os.path.join(DIST, f'{p:03d}w.webp'))
    reg = REG[min(len(REG) - 1, c0)]
    hdr = dict(p=p, a10=int(a10), toMap=to_map(ox, oy), s0=float(s[i0]), s1=float(s[i1 - 1]), i0=int(i0), n2=len(k2), ox=ox, oy=oy, px=PX, half=HALF, ch=CH,
               chunks=ch, wide=wide, arrays=meta, objc=OBJ_CLASSES, barc=BAR,
               over=(ovr := overs(over, sa, sb, ox, oy)),
               credit=sorted({SOURCES[c['reg'] if c['reg'] != 'DE-BE' else 'DE-BB']['credit'] for c in ch if (c['reg'] if c['reg'] != 'DE-BE' else 'DE-BB') in SOURCES}),
               bridges=(brs := bridges_for(sa, sb, ox, oy, ovr))[0], rbridges=brs[1],
               signs=signs_for(sa, sb), spd=speeds_for(i0, i1), roads=roads_for(sa, sb, ox, oy), roadc=ROAD_CLS, marks=marks_for(i0, i1),
               hcredit=sorted({HCREDIT[c['reg'] if c['reg'] != 'DE-BE' else 'DE-BB'] for c in ch if (c['reg'] if c['reg'] != 'DE-BE' else 'DE-BB') in HCREDIT}),
               blob=base64.b64encode(comp).decode())
    if VP is not None: hdr['xrd'] = [round(float(x), 1) for x in VP['xrd']]       # the offsets of the xrel columns (m, left +)
    if TUN is not None: hdr['tun'] = tun_for(sa, sb)                                  # (an empty list: none here)
    open(os.path.join(DIST, f'{p:03d}.json'), 'w').write(json.dumps(hdr, separators=(',', ':')))
    out = comp
    return len(comp) + len(sa_) + len(wa_)


if __name__ == '__main__':
    npk = int(np.ceil(np.ceil(s[-1] / CH) / PACK))
    tot = 0; made = []
    only = [int(a) for a in sys.argv[1:]]          # rebuild just these packs (index.json kept)
    if os.environ.get('SIGNS_ONLY') == '1':        # refresh the signs, speeds, roads and markings in the existing packs only
        for p in (only or range(npk)):
            fn = os.path.join(DIST, f'{p:03d}.json')
            if not os.path.exists(fn): continue
            hdr = json.load(open(fn)); i0 = int(hdr['i0']); i1 = int(np.searchsorted(s, min(s[-1], (p + 1) * PACK * CH)))
            sa_, sb_ = p * PACK * CH, min(s[-1], (p + 1) * PACK * CH)
            hdr['signs'] = signs_for(sa_, sb_); hdr['spd'] = speeds_for(i0, i1)
            hdr['roads'] = roads_for(sa_, sb_, hdr['ox'], hdr['oy']); hdr['roadc'] = ROAD_CLS; hdr['marks'] = marks_for(i0, i1)
            open(fn, 'w').write(json.dumps(hdr, separators=(',', ':')))
        sys.exit(0)
    if os.environ.get('OVER_ONLY') == '1':         # refresh the structures over the route, the 3D bridges and the tunnels only
        for p in (only or range(npk)):
            fn = os.path.join(DIST, f'{p:03d}.json')
            if not os.path.exists(fn): continue
            hdr = json.load(open(fn)); sa_, sb_ = p * PACK * CH, min(s[-1], (p + 1) * PACK * CH)
            i0 = int(np.searchsorted(s, sa_)); i1 = int(np.searchsorted(s, sb_))
            over = [o for o in blocks_for(i0, i1)['over'] if sa_ <= o['s'] < sb_]
            hdr['over'] = overs(over, sa_, sb_, hdr['ox'], hdr['oy'])
            hdr['bridges'], hdr['rbridges'] = bridges_for(sa_, sb_, hdr['ox'], hdr['oy'], hdr['over'])
            if TUN is not None: hdr['tun'] = tun_for(sa_, sb_)                # (the tunnels' walls too)
            open(fn, 'w').write(json.dumps(hdr, separators=(',', ':')))
        sys.exit(0)
    if only:
        for p in only: print(p, build(p))
        sys.exit(0)
    for p in range(npk):
        L = build(p)
        if L: tot += L; made.append(p)
    json.dump(dict(packs=made, pack_km=PACK * CH / 1000), open(os.path.join(DIST, 'index.json'), 'w'))
    print(len(made), 'packs', tot // 1024 // 1024, 'MB')
