"""Bridges for the 3D views, from Overture (centrelines, class, width) and the states' terrain / surface models (heights):
  over   every road or railway crossing above the route, found exactly as route_objects.py finds them (same s0, so the
         clear-height records match): the bridge part of its centreline within 100 m of the crossing, its width, and along
         it every 2 m the surface (deck top) and the terrain (ground under the deck) in m above the datum
  route  stretches where the route itself runs on a bridge (Overture is_bridge on the route's own segments): s0, s1 and
         the terrain across the route every 4 m (offsets D), relative to the road's level, for piers and the valley below
  hot    every bridge (road or rail) inside the twelve survey-point areas, with the same profiles
Run:  python route_bridges.py fetch     (Overture, ~45 min, resumable)  then  python route_bridges.py heights  (then
      python route_bridges.py glo: GLO-30 rows for the route's own bridges where no state height model was reachable)
→ .cache/route/corr/bridges_raw.pkl, bridges.pkl"""
import routecfg
import json, math, os, pickle, sys
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from route_corridor import route, OUT
from shapely import wkb
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import transform as stf
from pyproj import Transformer

t2ll = Transformer.from_crs('EPSG:32633', 'EPSG:4326', always_xy=True)
ll2t = Transformer.from_crs('EPSG:4326', 'EPSG:32633', always_xy=True)
tf = lambda g: stf(lambda X, Y, Z=None: ll2t.transform(X, Y), g)
RAW = OUT + 'bridges_raw.pkl'
D = np.array([-45, -35, -27, -20, -14, -9, 9, 14, 20, 27, 35, 45], float)     # offsets of the terrain across route bridges
# typical width (m) of the deck by class where the map has none: carriageway + shoulders / verges + parapets
WIDTH = {'motorway': 16.0, 'trunk': 13.0, 'primary': 12.0, 'secondary': 11.0, 'tertiary': 10.0, 'unclassified': 8.0, 'residential': 8.5,
         'living_street': 7.0, 'service': 6.0, 'track': 5.0, 'path': 4.0, 'footway': 4.0, 'cycleway': 4.5, 'pedestrian': 5.0, 'steps': 3.0,
         'standard_gauge': 9.5, 'light_rail': 8.0, 'tram': 8.0, 'subway': 9.0, 'narrow_gauge': 6.0, 'unknown': 8.0}


def width_of(cls, rules):
    vals = [r.get('value') for r in (rules or []) if r.get('value')]
    w = float(np.median(vals)) + 2.5 if vals else None              # mapped width is the carriageway: add verges and parapets
    return float(np.clip(w, 3.5, 40.0)) if w else WIDTH.get(cls, 8.0)


def bridge_parts(g, flags):
    """the parts of line g (UTM33) flagged is_bridge (fractions of its length); None when the segment has no bridge flag"""
    parts = []
    for f in flags or []:
        if 'is_bridge' not in (f.get('values') or []): continue
        a, b = (f.get('between') or [0.0, 1.0])
        L = g.length
        from shapely.ops import substring
        p = substring(g, a * L, b * L)
        if p.length > 1.0: parts.append(p)
    return parts or None


def level_of(rules):
    return max([d.get('value') or 0 for d in (rules or [])] or [0])


def fetch():
    import overture as ov
    r = route(); P = r['P']; s = r['s']
    raw = pickle.load(open(RAW, 'rb')) if os.path.exists(RAW) else {'blocks': {}, 'hot': {}}
    cols = ['id', 'subtype', 'class', 'names', 'level_rules', 'road_flags', 'width_rules', 'geometry']
    B = 20000
    for b0 in range(0, len(s), B):
        if b0 in raw['blocks']: continue
        Pb = P[b0:b0 + B + 1:20]
        line = LineString(Pb)
        lo, la = t2ll.transform(Pb[:, 0], Pb[:, 1])
        bb = (lo.min() - 0.002, la.min() - 0.002, lo.max() + 0.002, la.max() + 0.002)
        tb = ov.query('transportation', 'segment', bb, columns=cols)
        near = line.buffer(3); out = []
        for x in tb.to_pylist():
            lv = x['level_rules'] or []; fl = x['road_flags'] or []
            hi = any((d.get('value') or 0) > 0 for d in lv) or any('is_bridge' in (d.get('values') or []) for d in fl)
            if not hi: continue
            g = tf(wkb.loads(x['geometry']))
            if not g.intersects(near): continue
            ip = g.intersection(near); c = ip.centroid
            k = int(np.argmin(np.hypot(Pb[:, 0] - c.x, Pb[:, 1] - c.y)))
            if g.length > 0 and ip.length > 0.6 * min(g.length, 40): continue          # the route's own bridge (runs along it)
            nm = None
            if x['names']: nm = (dict(x['names']) if isinstance(x['names'], list) else x['names']).get('primary')
            parts = bridge_parts(g, fl)
            cut = Point(c.x, c.y).buffer(100)
            geoms = [p.intersection(cut) for p in (parts or [g])]
            geoms = [q for q in geoms if not q.is_empty and q.length > 1.0]
            lines = []
            for q in geoms:
                for ln in (q.geoms if hasattr(q, 'geoms') else [q]):
                    if ln.length > 1.0: lines.append(np.asarray(ln.coords)[:, :2])
            out.append(dict(s0=float(s[b0 + k * 20]), sub=x['subtype'], cls=x['class'], name=nm, xy=(c.x, c.y), id=x['id'],
                            width=width_of(x['class'], x['width_rules']), level=level_of(lv), flagged=parts is not None, lines=lines))
        raw['blocks'][b0] = out
        pickle.dump(raw, open(RAW, 'wb'))
        print('block', b0, len(out), flush=True)
    # every bridge inside the survey-point areas
    H = json.load(open(routecfg.DATA + 'route.json'))['hot'] if os.path.exists(routecfg.DATA + 'route.json') else []     # (after the first bake)
    for h in H:
        if h['id'] in raw['hot']: continue
        proj = f"+proj=tmerc +lat_0={h['lat']} +lon_0={h['lon']} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs"
        bw = Transformer.from_crs(proj, 'EPSG:4326', always_xy=True)
        x0, y0, x1, y1 = h['ext']
        lo, la = bw.transform([x0, x1, x0, x1], [y0, y0, y1, y1])
        bb = (min(lo) - 0.001, min(la) - 0.001, max(lo) + 0.001, max(la) + 0.001)
        tb = ov.query('transportation', 'segment', bb, columns=cols + ['rail_flags'])
        fw = Transformer.from_crs(proj, 'EPSG:32633', always_xy=True)
        area = Polygon([fw.transform(x, y) for x, y in ((x0 - 30, y0 - 30), (x1 + 30, y0 - 30), (x1 + 30, y1 + 30), (x0 - 30, y1 + 30))])
        out = []
        for x in tb.to_pylist():
            fl = (x['road_flags'] or []) + (x.get('rail_flags') or [])          # railways carry their bridge flag in rail_flags
            g = tf(wkb.loads(x['geometry']))
            parts = bridge_parts(g, fl)
            if not parts: continue
            parts = [p for p in parts if p.intersects(area)]                # long railway segments reach far beyond the area
            if not parts: continue
            nm = None
            if x['names']: nm = (dict(x['names']) if isinstance(x['names'], list) else x['names']).get('primary')
            for p in parts:
                out.append(dict(sub=x['subtype'], cls=x['class'], name=nm, id=x['id'], width=width_of(x['class'], x['width_rules']),
                                level=level_of(x['level_rules']), lines=[np.asarray(p.coords)[:, :2]]))
        raw['hot'][h['id']] = out
        pickle.dump(raw, open(RAW, 'wb'))
        print('hot', h['id'], len(out), flush=True)
    print('fetched')


def _resample(L, step=2.0):
    seg = np.hypot(*np.diff(L, axis=0).T); cs = np.r_[0, np.cumsum(seg)]
    if cs[-1] < step: return L
    t = np.arange(0, cs[-1] + 1e-6, step)
    return np.c_[np.interp(t, cs, L[:, 0]), np.interp(t, cs, L[:, 1])]


def route_bridges(r, REG):
    """intervals [s0, s1] where the route's own segments are flagged is_bridge"""
    import pyarrow.parquet as pq
    C = routecfg.C
    Ru = pickle.load(open(C + 'route.pkl', 'rb'))
    SEG = np.load(C + 'screen.npz')['SEG']
    full = {}
    want = {info['id'] for info, _ in Ru if any('is_bridge' in (f.get('values') or []) for f in (info.get('flags') or []))}
    for fn in ('net_major.parquet', 'net_factory.parquet', 'net_site.parquet'):
        if not os.path.exists(C + fn): continue
        t = pq.read_table(C + fn, columns=['id', 'geometry'])
        for i, g in zip(t.column('id').to_pylist(), t.column('geometry').to_pylist()):
            if i in want and i not in full: full[i] = tf(wkb.loads(g))
    P = r['P']; s = r['s']
    on = np.zeros(len(s), bool)
    for j, (info, _) in enumerate(Ru):
        if info['id'] not in want or info['id'] not in full: continue
        parts = bridge_parts(full[info['id']], info.get('flags'))
        if not parts: continue
        ii = np.where(SEG == j)[0]
        if not len(ii): continue
        for p in parts:
            buf = p.buffer(4.0)
            from shapely import vectorized
            m = vectorized.contains(buf, P[ii, 0], P[ii, 1])
            on[ii[m]] = True
    # intervals, gaps under 6 m closed, pieces under 8 m dropped
    idx = np.where(on)[0]; out = []
    if len(idx):
        for g in np.split(idx, np.where(np.diff(idx) > 6)[0] + 1):
            if s[g[-1]] - s[g[0]] >= 8: out.append((float(s[g[0]]), float(s[g[-1]])))
    return out


def heights():
    import elev
    r = route(); s = r['s']; P = r['P']; N = r['N']
    REG = pickle.load(open(OUT + 'regions.pkl', 'rb'))['lab']
    S1 = np.load(OUT + 'survey_1m.npz')
    reg_of = lambda sv: (lambda q: 'DE-BB' if q == 'DE-BE' else q)(REG[min(len(REG) - 1, int(sv // 500))])
    raw = pickle.load(open(RAW, 'rb'))
    fn = OUT + 'bridges.pkl'
    res = pickle.load(open(fn, 'rb')) if os.path.exists(fn) else {'over': {}, 'route': None, 'hot': {}}
    # BRIDGE_SEED=<another route's bridges.pkl>, BRIDGE_SEED_MAX=<m>: that route shares this one's road and chainage up to
    # BRIDGE_SEED_MAX (same start, same road): its measured records there are taken over instead of fetched again
    seed, smax = None, float(os.environ.get('BRIDGE_SEED_MAX', 0))
    if os.environ.get('BRIDGE_SEED'):
        seed = pickle.load(open(os.environ['BRIDGE_SEED'], 'rb'))
        k0 = len(res['over'])
        for k, v in seed['over'].items():
            if v['s0'] < smax and k not in res['over']: res['over'][k] = v
        print('seeded', len(res['over']) - k0, 'over records', flush=True)

    def prof(reg, L):
        L = _resample(np.asarray(L, float))
        try:
            S_, T_ = elev.surface_terrain(reg, L[:, 0], L[:, 1])
        except Exception as ex:
            print('  heights fail', reg, repr(ex)[:120]); S_ = T_ = None
        if S_ is None: return dict(line=L.astype(np.float64), S=None, T=None)
        return dict(line=L.astype(np.float64), S=np.round(np.asarray(S_, float), 2), T=np.round(np.asarray(T_, float), 2))

    n = 0
    for b0, recs in sorted(raw['blocks'].items()):
        for o in recs:
            key = f"{round(o['s0'])}:{o['id']}"
            if key in res['over']: continue
            reg = reg_of(o['s0'])
            res['over'][key] = dict({k: o[k] for k in ('s0', 'sub', 'cls', 'name', 'xy', 'width', 'level', 'flagged')}, reg=reg,
                                    parts=[prof(reg, L) for L in o['lines']])
            n += 1
            if n % 50 == 0: pickle.dump(res, open(fn, 'wb')); print(' over', n, flush=True)
    pickle.dump(res, open(fn, 'wb'))
    import hd_hot
    for hid, recs in raw['hot'].items():
        if hid in res['hot']: continue
        reg = hd_hot.region(hid)
        res['hot'][hid] = [dict({k: o[k] for k in ('sub', 'cls', 'name', 'width', 'level')}, reg=reg, parts=[prof(reg, L) for L in o['lines']]) for o in recs]
        pickle.dump(res, open(fn, 'wb')); print(' hot', hid, len(recs), flush=True)
    if res['route'] is None:
        iv = route_bridges(r, REG); out = []
        print('route bridges', len(iv), flush=True)
        if seed is not None and seed.get('route'):
            out = [q for q in seed['route'] if q['s1'] < smax]
            iv = [(a, b) for a, b in iv if b >= smax or not any(abs(q['s0'] - a) < 1 and abs(q['s1'] - b) < 1 for q in out)]
            print('seeded', len(out), 'route bridges; computing', len(iv), flush=True)
        for s0, s1 in iv:
            reg = reg_of((s0 + s1) / 2)
            sv = np.arange(s0 - 12, s1 + 12.01, 4.0)
            ii = np.clip(np.searchsorted(s, sv), 0, len(s) - 1)
            sh = S1['shift'][ii].astype(float)
            X = P[ii, 0][:, None] + N[ii, 0][:, None] * (sh[:, None] + D[None]); Y = P[ii, 1][:, None] + N[ii, 1][:, None] * (sh[:, None] + D[None])
            Xc = P[ii, 0] + N[ii, 0] * sh; Yc = P[ii, 1] + N[ii, 1] * sh
            rec = dict(s0=s0, s1=s1, reg=reg, step=4.0, sa=float(sv[0]), D=D.tolist(), rel=None, srel=None, surf=None)
            try:
                S_, T_ = elev.surface_terrain(reg, np.r_[X.ravel(), Xc], np.r_[Y.ravel(), Yc])
            except Exception as ex:
                print('  route bridge heights fail', reg, repr(ex)[:120]); S_ = None
            if S_ is not None:
                T_ = np.asarray(T_, float); S_ = np.asarray(S_, float)
                Tg = T_[:X.size].reshape(X.shape); Sc = S_[X.size:]
                # the road's level: the surface over the driving line (the deck), a line through the ends outside the bridge
                ends = (sv < s0 - 3) | (sv > s1 + 3)
                Tc = T_[X.size:]
                ok = ends & np.isfinite(Tc)
                if ok.sum() >= 2:
                    a, b = np.polyfit(sv[ok], Tc[ok], 1); road = a * sv + b
                    rec['rel'] = np.round(Tg - road[:, None], 2)            # terrain across the bridge relative to the road
                    rec['srel'] = np.round(S_[:X.size].reshape(X.shape) - road[:, None], 2)   # surface across: ≈ 0 where a deck is
                    rec['surf'] = np.round(Sc - road, 2)                    # the deck over the driving line (≈ 0 where flagged right)
            out.append(rec)
        res['route'] = out
        pickle.dump(res, open(fn, 'wb'))
    print('heights done', len(res['over']), sum(len(v) for v in res['hot'].values()), len(res['route']))


def glo_rows():
    """the route's own bridges left without terrain rows (no state height model reachable, Thuringia): rows from the
    Copernicus GLO-30 profile of route_elev.py (elev.npz: every 10 m at the route line and 20 m to either side) — the
    terrain 20 m beside the road on each side, relative to a line through the road just beyond the bridge's ends, for every
    offset on that side (coarse, 30 m cells: the valley's depth and shape along the road, no detail across). Marked
    src 'GLO-30'; srel / surf stay None. Run after heights:  python route_bridges.py glo"""
    fn = OUT + 'bridges.pkl'
    res = pickle.load(open(fn, 'rb')); E = np.load(OUT + 'elev.npz')
    s10, z0, zl, zr = (np.asarray(E[k], float) for k in ('s', 'z0', 'zl', 'zr'))
    from scipy.ndimage import gaussian_filter1d
    zl, zr = gaussian_filter1d(np.nan_to_num(zl, nan=np.nanmedian(zl)), 1.0), gaussian_filter1d(np.nan_to_num(zr, nan=np.nanmedian(zr)), 1.0)
    n = 0
    for rec in res.get('route') or []:
        if rec.get('rel') is not None and not str(rec.get('src', '')).startswith('GLO-30'): continue
        s0, s1 = rec['s0'], rec['s1']
        sv = np.arange(s0 - 12, s1 + 12.01, 4.0)
        out = ((s10 > s0 - 45) & (s10 < s0 - 10)) | ((s10 > s1 + 10) & (s10 < s1 + 45))
        if out.sum() < 2 or not np.isfinite(z0[out]).all(): continue
        a, b = np.polyfit(s10[out], z0[out], 1); road = a * sv + b
        L_, R_ = np.interp(sv, s10, zl) - road, np.interp(sv, s10, zr) - road
        rel = np.where(D[None] > 0, L_[:, None], R_[:, None]) + 0 * D[None]
        src = 'GLO-30'
        if rel.min() > -4.0:
            # the 30 m cells do not resolve what passes under a short bridge (a road, a stream): a nominal valley 6 m under
            # the road (a road's clear height and the deck) over the middle of the span, eased out to the abutments
            u = np.clip(np.minimum(sv - s0, s1 - sv) / max(4.0, 0.25 * (s1 - s0)), 0, 1)
            rel = np.minimum(rel, -6.0 * u[:, None] * np.ones(len(D))[None]); src = 'GLO-30, nominal valley (height not measured)'
        rec['rel'] = np.round(rel, 2)
        rec['src'] = src; rec['sa'] = float(sv[0]); rec['step'] = 4.0; rec['D'] = D.tolist(); n += 1
    pickle.dump(res, open(fn, 'wb'))
    print('GLO-30 rows for', n, 'route bridges')


if __name__ == '__main__':
    {'fetch': fetch, 'heights': heights, 'glo': glo_rows}[sys.argv[1]]()
