"""Painted lines, lanes and the central reservation along the whole route, from the 0.25 m photo strips of the corridor
(corr/NNNN.webp, rows across the road from +45 m (left) to −45 m, columns every 0.25 m along it) and their traced edges.

1. Markings: a white top-hat across the road (bright and narrower than 1.25 m, grey) on windows of 100 m stepped every
   25 m; each row peak is classed by its pattern along the road (duty, FFT period): solid, lane line (6/12, 4/8 or
   3/6 m dashes), block (6/6 broad dashes: an exit / entry lane), warn (dense dashes). Yellow temporary markings are found
   the same way on a yellowness channel and replace the white ones where they mark a layout of their own.
2. Lanes: the right lane is bounded by the right-most lane line and a solid or block line 2.6–4.7 m to its right (or the
   paved edge); the edge lines eR / eL are the outermost solid lines bounding the lane lines; lane count = lane lines + 1.
   Exit / entry lanes (right of a block line) count only where the route leaves by them (a link within 400 m). Along the
   route: 7-window running median, jumps over 1.5 m that last less than 300 m dropped, gaps up to 2 km interpolated,
   then the fallbacks (right edge line + 1.875; the paved right edge + the typical offset of that road; OSM lanes=*).
3. Central reservation (dual carriageways): the opposite carriageway is the one-way motorway / trunk piece (roads.pkl)
   running the other way 8–40 m to the left; the median axis is the middle between the two painted inner edge lines
   (else halfway between the centrelines − 0.43 m); its barrier from mapped guard rails / jersey barriers on the axis,
   else from the surface and terrain models where they are cached (terrain raised over ≥ 2 m: raised median; a crisp
   narrow hump in a fine surface model only: concrete step barrier), laser points near structures for the height, else
   the German standard double steel guard rail (top 0.75 m).
→ corr/lanelines.npz per 1 m (route index of screen.npz): float16 rR, rL (right lane's right / left line), eR, eL
  (outer edge lines), ax (median axis), oin, oout (opposite carriageway inner / outer paved edge), mh (barrier top above
  the road), mw (raised median width), all m from the route line, left +, NaN = not found; uint8 nl (lane count of our
  carriageway, 0 unknown), lq (0 fallback, 1 edge line only, 2 full detection), mtyp (0 none, 1 double steel guard rail,
  2 concrete step barrier, 3 raised median with steel rail on top); also cl (painted centre line of a two-way road),
  ex (1 = an exit / entry lane right of eR), sep (opposite centreline). corr/lanelines_det.pkl caches the detections
  (LANELINES_REDETECT=1 runs them again).
Usage: python route_lanelines.py [workers]      python route_lanelines.py show CHUNK …   (print a chunk's windows)"""
import routecfg
import os, sys, json, glob, pickle, time
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from scipy.ndimage import uniform_filter1d, maximum_filter1d, white_tophat, median_filter
from route_corridor import route, OUT, CH, PX, HALF

D = ((np.arange(int(2 * HALF / PX)) + 0.5) * PX - HALF)[::-1]      # row → lateral offset (m, left +): row 0 = +45 m
WIN, STEP = 400, 100                                               # 100 m windows every 25 m (columns)
DET = OUT + 'lanelines_det.pkl'
LANE_W = 3.75                                                      # standard lane (RAA: 3.50–3.75 m)


# ───────────────────────────── 1. markings on one strip ─────────────────────────────
def kind(sig):
    """sig: 0/1 mark along the road (one per column). → (kind, duty, period m): 'solid' | 'lane' | 'block' | 'warn' | None"""
    duty = float(sig.mean())
    if duty > 0.8: return 'solid', duty, 0.0
    if duty < 0.12: return None, duty, 0.0
    x = sig - duty; n = len(x); f = np.abs(np.fft.rfft(x, 4 * n)) ** 2
    per = 4 * n / np.maximum(np.arange(len(f)), 1) * PX               # period (m) per bin
    ok = (per > 7) & (per < 22)
    k = int(np.argmax(np.where(ok, f, 0))); P = float(per[k])
    strength = f[k] / (f[1:].sum() + 1e-9)
    if strength < 0.04: return ('solid' if duty > 0.55 else None), duty, P        # aperiodic: a shadowed solid line / noise
    # (the marks are averaged over 1.25 m along the road: a dash reads ~0.5 m longer at each end than painted)
    if 10.5 <= P <= 13.5: return ('lane' if 0.2 <= duty < 0.45 else 'block' if duty <= 0.85 else None), duty, P   # 4/8 · 6/6
    if 0.2 <= duty <= 0.5 and (15.5 <= P <= 20.5 or 8.0 <= P <= 10): return 'lane', duty, P                      # 6/12 · 3/6
    if 0.5 < duty <= 0.85: return 'warn', duty, P
    return None, duty, P


def _peaks(mk, lo, hi):
    """row peaks of the share of marked columns (local maximum over 1.25 m, ≥ 0.1) between d = lo and hi; per peak
    (d refined to a fraction of a row, kind, duty, period, share); peaks closer than 0.5 m: the stronger one"""
    occ = uniform_filter1d(mk.mean(1), 2)
    pk = (occ == maximum_filter1d(occ, 5)) & (occ > 0.1) & (D > lo) & (D < hi)
    out = []
    for r in np.nonzero(pk)[0]:
        if out and abs(out[-1][0] - D[r]) < 0.5 and out[-1][4] >= occ[r]: continue
        sig = mk[max(0, r - 1):r + 2].any(0).astype(np.float32)
        k, du, P = kind(sig)
        if not k: continue
        a, b, c = occ[max(0, r - 1)], occ[r], occ[min(len(occ) - 1, r + 1)]
        dr = 0.5 * (a - c) / (a - 2 * b + c) if (a - 2 * b + c) < 0 else 0.0
        x = (round(float(D[r] - np.clip(dr, -0.5, 0.5) * PX), 3), k, round(du, 2), round(P, 1), round(float(b), 2))
        if out and abs(out[-1][0] - x[0]) < 0.5: out[-1] = x
        else: out.append(x)
    return out


def detect_chunk(c):
    """windows of chunk c: [(s_mid, Lb, Rb, white lines, yellow lines)] (lines as _peaks; Lb / Rb the traced edges)"""
    fn = OUT + f'{c:04d}.webp'
    if not os.path.exists(fn) or not os.path.exists(OUT + f'{c:04d}.npz'): return c, []
    from PIL import Image
    a = np.asarray(Image.open(fn).convert('RGB')).astype(np.float32)
    z = np.load(OUT + f'{c:04d}.npz'); Lc = z['L'].astype(float); Rc = z['R'].astype(float); s0 = float(z['s0'])
    v = a.mean(-1); mx = a.max(-1); sat = (mx - a.min(-1)) / (mx + 1)
    # bright and narrower than 1.25 m across, averaged over 1.25 m along the road (paint is continuous along a dash,
    # the texture of concrete slabs and chippings is not)
    th = uniform_filter1d(white_tophat(v, size=(5, 1)), 5, axis=1)
    # yellow (temporary markings): red and green high, blue low
    yl = np.clip(0.5 * (a[..., 0] + a[..., 1]) - a[..., 2], 0, None)
    ty = uniform_filter1d(white_tophat(yl, size=(5, 1)), 5, axis=1) if (yl > 40).mean() > 0.001 else None
    out = []
    for b0 in range(0, v.shape[1] - WIN + 1, STEP):
        cols = slice(b0, b0 + WIN)
        Lb = float(np.median(Lc[cols])); Rb = float(np.median(Rc[cols]))
        T = th[:, cols]
        # threshold: 28 grey levels on asphalt, down to 9 on pale concrete where the paint's contrast is small — three
        # times the texture's noise floor on the carriageway (median over its rows of the 90th percentile along the road)
        on = (D < min(Lb, 12) - 0.5) & (D > -min(Rb, 12) + 0.5)
        noise = float(np.median(np.percentile(T[on], 90, axis=1))) if on.sum() > 8 else 9.0
        thr = float(np.clip(3 * noise + 6, 9, 28))
        mk = (T > thr) & (sat[:, cols] < 0.18)
        white = _peaks(mk, -Rb - 0.8, HALF - 1)
        yel = []
        if ty is not None:
            mky = (ty[:, cols] > 22) & (sat[:, cols] > 0.25) & (a[:, cols, 0] > 120)
            if mky.mean() > 0.002: yel = _peaks(mky, -Rb - 0.8, Lb + 0.8)
        out.append((round(s0 + (b0 + WIN / 2) * PX, 1), round(Lb, 2), round(Rb, 2), white, yel, round(thr, 1)))
    return c, out


def detect_all(workers=4):
    """every chunk (cached in corr/lanelines_det.pkl with the strips' time stamps: a new strip is read again;
    LANELINES_REDETECT=1 reads them all again)"""
    chunks = sorted(int(os.path.basename(f)[:4]) for f in glob.glob(OUT + '[0-9][0-9][0-9][0-9].webp'))
    mt = {c: os.path.getmtime(OUT + f'{c:04d}.webp') for c in chunks}
    det, old = {}, None
    if os.path.exists(DET) and os.environ.get('LANELINES_REDETECT') != '1':
        det = pickle.load(open(DET, 'rb')); old = det.pop('_mt', None)
    todo = [c for c in chunks if c not in det or (old is not None and old.get(c) != mt[c])]
    if todo:
        from multiprocessing import Pool
        t0 = time.time()
        with Pool(workers) as pool:
            for k, (c, w) in enumerate(pool.imap_unordered(detect_chunk, todo, chunksize=4)):
                det[c] = w
                if k % 200 == 0: print('markings', k, '/', len(todo), round(time.time() - t0), 's', flush=True)
    if todo or old is None:
        pickle.dump(dict(det, _mt=mt), open(DET + '.tmp', 'wb')); os.replace(DET + '.tmp', DET)
    return det


# ───────────────────────────── 2. the route ─────────────────────────────
def twoway_mask(r):
    """per metre: does traffic run both ways on the route's carriageway in lanes (no 'oneway' restriction on the segment,
    not a track or service road)"""
    import pyarrow.parquet as pq
    C = routecfg.C
    Ru = pickle.load(open(C + 'route.pkl', 'rb'))
    ids = [Ru[k][0]['id'] for k in range(len(Ru))]
    one = {}
    for f in ('net_major', 'net_factory', 'net_site'):
        fn = C + f + '.parquet'
        if not os.path.exists(fn): continue
        t = pq.read_table(fn, columns=['id', 'class', 'access_restrictions'])
        for row in t.to_pylist():
            ar = row['access_restrictions'] or []
            one[row['id']] = any(x.get('access_type') == 'denied' and (x.get('when') or {}).get('heading') in ('backward', 'forward')
                                 and not (x.get('when') or {}).get('mode') and not (x.get('when') or {}).get('using') for x in ar) or row['class'] == 'motorway'
    seg_one = np.array([one.get(i, False) for i in ids])
    # tracks and service roads have no lanes: the convoy drives their middle (as on a one-way carriageway)
    nolane = np.array([Ru[k][0]['cls'] in ('track', 'service', 'path') for k in range(len(Ru))])
    return ~(seg_one | nolane)[r['SEG']]


def context(r):
    """per metre: class, motorway ref (first part), on a link (ramp), a link taken within the next 400 m, two-way, kind
    (0 track / service / path: no lanes, 1 two-way, 2 one-way carriageway)"""
    Ru = pickle.load(open(routecfg.C + 'route.pkl', 'rb')); SEG = r['SEG']; n = len(SEG)
    cls = np.array([q[0]['cls'] for q in Ru])[SEG]
    link = np.array([q[0].get('sub') == 'link' or any('is_link' in (f.get('values') or []) for f in (q[0].get('flags') or []))
                     for q in Ru])[SEG]
    ref = np.array([str(q[0].get('ref') or '').split(';')[0].strip() for q in Ru])[SEG]
    cnt = np.r_[np.cumsum(link[::-1])[::-1], 0]
    ahead = (cnt[:n] - cnt[np.minimum(n, np.arange(n) + 400)]) > 0
    tw = twoway_mask(r)
    kind_ = np.where(np.isin(cls, ['track', 'service', 'path']), 0, np.where(tw, 1, 2)).astype(np.uint8)
    REG = pickle.load(open(OUT + 'regions.pkl', 'rb'))['lab']
    de = np.array([x.startswith('DE') for x in REG])[np.minimum(len(REG) - 1, (r['s'] // CH).astype(int))]
    return dict(cls=cls, link=link, ref=ref, ahead=ahead, tw=tw, kind=kind_, de=de)


def opposite(r):
    """per metre: lateral offset (left +, m) of the opposite carriageway's centreline — a one-way motorway / trunk piece
    (not a ramp) of roads.pkl that runs the other way 8–40 m to the left; NaN where none (gaps under 30 m bridged)"""
    from scipy.spatial import cKDTree
    P, N = r['P'], r['N']; n = len(P); sep = np.full(n, np.nan)
    fn = OUT + 'roads.pkl'
    if not os.path.exists(fn): return sep.astype(np.float32)
    T = np.c_[N[:, 1], -N[:, 0]]
    kd = cKDTree(P)
    for b in pickle.load(open(fn, 'rb'))['blocks'].values():
        for q in b:
            if q['cls'] not in ('motorway', 'trunk') or q['sub'] == 'link' or not q['oneway']: continue
            xy = q['xy'].astype(float); sl = np.hypot(*np.diff(xy, axis=0).T)
            if sl.sum() < 5: continue
            cs = np.r_[0, np.cumsum(sl)]; ss = np.arange(0, cs[-1], 1.0)
            pts = np.c_[np.interp(ss, cs, xy[:, 0]), np.interp(ss, cs, xy[:, 1])]
            g = np.gradient(pts, axis=0); g /= np.linalg.norm(g, axis=1)[:, None] + 1e-9
            dd, k = kd.query(pts, distance_upper_bound=45)
            ok = np.isfinite(dd); k = np.minimum(k, n - 1)
            v = pts - P[k]; lat = (v * N[k]).sum(1); along = (v * T[k]).sum(1); head = (g * T[k]).sum(1) * q['oneway']
            m = ok & (head < -0.9) & (lat >= 8) & (lat <= 40) & (np.abs(along) < 4)
            np.fmin.at(sep, k[m], lat[m])
    ok = np.isfinite(sep)
    if ok.sum() > 10:
        idx = np.nonzero(ok)[0]; v = median_filter(sep[idx], 9, mode='nearest')
        full = np.interp(np.arange(n), idx, v)
        gap = np.diff(np.r_[idx, n + 99])                                    # distance to the next finding
        nxt = np.searchsorted(idx, np.arange(n)); prv = np.maximum(nxt - 1, 0); nxt = np.minimum(nxt, len(idx) - 1)
        span = idx[nxt] - idx[prv]
        sep = np.where((span <= 30) | ok, full, np.nan)
        sep[:idx[0]] = np.nan; sep[idx[-1] + 1:] = np.nan
    return sep.astype(np.float32)


def osm_lanes(r):
    """per metre: lanes=* of the OSM way lying on the route line (cached Overpass answers, the route's own carriageway;
    0 unknown) — a prior for the lane count where the photo shows none"""
    from scipy.spatial import cKDTree
    from pyproj import Transformer
    n = len(r['s']); out = np.zeros(n, np.uint8)
    fs = glob.glob(routecfg.C + 'osm/[0-9]*_[0-9]*.json')
    if not fs: return out
    els = {}
    for f in fs:
        try:
            for e in json.load(open(f)): els[(e['type'], e['id'])] = e
        except Exception: pass
    tr = Transformer.from_crs('EPSG:4326', 'EPSG:32633', always_xy=True); kd = cKDTree(r['P']); N = r['N']; T = np.c_[N[:, 1], -N[:, 0]]
    for e in els.values():
        t = e.get('tags') or {}
        if e['type'] != 'way' or 'geometry' not in e or not str(t.get('highway', '')).startswith(('motorway', 'trunk', 'primary')): continue
        try: nl = int(str(t.get('lanes', '0')).split(';')[0])
        except ValueError: continue
        if not 0 < nl < 7: continue
        xy = np.array(tr.transform([p['lon'] for p in e['geometry']], [p['lat'] for p in e['geometry']])).T
        sl = np.hypot(*np.diff(xy, axis=0).T)
        if not len(sl) or sl.sum() < 5: continue
        cs = np.r_[0, np.cumsum(sl)]; ss = np.arange(0, cs[-1], 2.0)
        pts = np.c_[np.interp(ss, cs, xy[:, 0]), np.interp(ss, cs, xy[:, 1])]
        g = np.gradient(pts, axis=0); g /= np.linalg.norm(g, axis=1)[:, None] + 1e-9
        dd, k = kd.query(pts, distance_upper_bound=4); ok = np.isfinite(dd); k = np.minimum(k, n - 1)
        ok &= np.abs((g * T[k]).sum(1)) > 0.9 if t.get('oneway') != 'yes' else (g * T[k]).sum(1) > 0.9
        for a in k[ok]: out[max(0, a - 1):a + 2] = nl
    return out


# ───────────────────────────── 3. lanes in one window ─────────────────────────────
def _classes(lines, mway, one=True):
    """→ sorted offsets of solid, block and lane lines (on a German motorway a 12 m period is a block marking: 6/6;
    Polish lane lines are 4/8 m; on a one-way carriageway dense dashes are a solid line broken by shadows)"""
    so, bl, la, wn = [], [], [], []
    for d, k, du, P, oc in lines:
        if k == 'solid': so.append(d)
        elif k == 'block' or (mway and k in ('lane', 'warn') and 10.5 <= P <= 13.5 and du >= 0.35): bl.append(d)
        elif one and k == 'warn' and du >= 0.6: wn.append(d)
        elif k in ('lane', 'warn'): la.append(d)
    # dense dashes inside the lane structure (a line one lane away on both sides) are a lane line (concrete joints
    # lengthen the dashes), at its edge a solid line broken by shadows
    allx = so + bl + la + wn
    for d in wn:
        (la if any(2.6 <= d - x <= 4.7 for x in allx) and any(2.6 <= x - d <= 4.7 for x in allx) else so).append(d)
    return sorted(so), sorted(bl), sorted(la)


def one_window(lines, Lb, Rb, sep, tw, mway, up_sep=0.5):
    """the lanes of one 100 m window. lines: as _peaks; Lb / Rb: traced edges; sep: opposite centreline (NaN: none);
    tw: two-way; mway: motorway. → dict(rR, rL, eR, eL, nl, lq, cl, ex, xR, oi, oo, bx) — oi / oo the opposite
    carriageway's inner / outer edge line, bx a bright line in the median (the barrier), xR the right line of the exit lane"""
    nan = np.nan
    o = dict(rR=nan, rL=nan, eR=nan, eL=nan, nl=0, lq=0, cl=nan, ex=0, xR=nan, oi=nan, oo=nan, bx=nan)
    dual = (not tw) and np.isfinite(sep)
    up = Lb + 0.8
    if dual: up = min(max(up, 2.5), sep * up_sep - 1.2)               # our lines lie right of the median
    so, bl, la = _classes([x for x in lines if -Rb - 0.8 < x[0] < up], mway, not tw)
    edge_ok = Rb < 15.5                                                # (at the band limit the paved edge is a junction mouth)
    if tw:
        # two-way: the centre line near the middle of the paved width, the edge lines just inside the paved edges
        c = (Lb - Rb) / 2; W = Lb + Rb
        cand = [x for x in la + so + bl if abs(x - c) <= max(1.2, 0.15 * W) and x + Rb >= 2.0 and Lb - x >= 2.0]
        if cand: o['cl'] = min(cand, key=lambda x: abs(x - c) - (0.3 if x in la else 0.0))
        er = [x for x in so if -Rb - 0.3 <= x <= -Rb + 1.2]; el = [x for x in so if Lb - 1.2 <= x <= Lb + 0.3]
        if er: o['eR'] = min(er, key=lambda x: abs(x + Rb))
        if el: o['eL'] = min(el, key=lambda x: abs(x - Lb))
        if np.isfinite(o['cl']):
            o['rR'], o['rL'], o['nl'] = o['eR'], o['cl'], 2; o['lq'] = 2 if np.isfinite(o['eR']) else 1
        return o
    # lanes right of a separator — a block line (exit / entry / auxiliary lanes) or a solid line with lane lines on both
    # sides (a parallel carriageway) — are not through lanes: the through lanes are those left of the right-most one
    sp = sorted(bl + [x for x in so if any(2.6 <= y - x <= 4.7 for y in la) and any(2.6 <= x - y <= 4.7 for y in la)])
    aux = []
    if sp and la and max(la) > sp[0]:
        xb = max(x for x in sp if x < max(la))
        aux = [x for x in la if x < xb]; la = [x for x in la if x > xb]
        so = [x for x in so if x > xb - 0.3] + ([xb] if xb not in bl else []); bl = [x for x in bl if x >= xb]
        o['ex'] = 1; xr = [x for x in sorted(aux + so) if 2.6 <= xb - x <= 4.7] + [x for x in sorted(set(sp) - {xb}) if 2.6 <= xb - x <= 4.7]
        o['xR'] = max(xr) if xr else (-Rb if edge_ok and 2.6 <= xb + Rb <= 4.7 else nan)
    bd = sorted(so + bl)
    if not la:
        # a single lane between two solid lines (ramp), else the right edge line alone
        pr = [(a, b) for a in so for b in so if 2.6 <= b - a <= 5.5 and -Rb - 0.3 <= a <= -Rb + 1.5]
        if pr and edge_ok and not aux: a, b = pr[0]; o.update(rR=a, rL=b, eR=a, eL=b, nl=1, lq=2)
    if la and not np.isfinite(o['rR']):
        ld = la[0]                                                     # the right-most (through) lane line
        rb = [x for x in bd if 2.6 <= ld - x <= 4.7]
        if rb:
            o.update(rR=max(rb), rL=ld, lq=2); o['eR'] = o['rR']; o['ex'] = max(o['ex'], int(o['rR'] in bl))
        elif edge_ok and 2.6 <= ld + Rb <= 4.7: o.update(rR=-Rb, rL=ld, lq=2)   # the paved edge (no edge line seen)
        elif edge_ok and ld - LANE_W >= -Rb - 0.3 and ld - LANE_W - 3.5 <= -Rb:  # the edge line not seen: one lane (and
            o.update(rR=ld - LANE_W, rL=ld, lq=1)                              # a hard shoulder) still fits on its right
    if not np.isfinite(o['rR']) and edge_ok and not aux:
        ed = [x for x in so if 1.5 <= x + Rb <= 4.2] or [x for x in so if -0.3 <= x + Rb < 1.2]
        if ed:
            e = min(ed); ll = [x for x in la if 2.6 <= x - e <= 4.7]
            o.update(rR=e, eR=e, rL=min(ll) if ll else e + LANE_W, lq=2 if ll else 1)
    if o['ex'] and not np.isfinite(o['xR']) and np.isfinite(o['rR']):  # the exit / entry lane right of the block line
        xr = [x for x in so if 2.6 <= o['rR'] - x <= 4.7]
        o['xR'] = max(xr) if xr else (-Rb if edge_ok and 2.6 <= o['rR'] + Rb <= 4.7 else nan)
    if np.isfinite(o['rL']) and o['nl'] == 0:
        painted = o['rL'] in la; cur = o['rL']; cnt = 1
        while True:                                                    # lane lines to the left, one lane apart
            nx = [x for x in la if 2.6 <= x - cur <= 4.7]
            if not nx: break
            cur = min(nx); cnt += 1
        el = [x for x in so if 2.6 <= x - cur <= 4.7]
        if el:
            o['eL'] = min(el)
            if painted: o['nl'] = cnt + 1
    if dual:
        # the opposite carriageway: its inner edge line 2.5–12 m left of ours (with one of its lane lines one lane
        # further), its outer edge line beyond its lane lines; a bright line between the two inner lines is the barrier
        so2, bl2, la2 = _classes(lines, mway, True)
        e0 = o['eL'] if np.isfinite(o['eL']) else sep / 2 - 0.43 - 2.4
        oi = [x for x in so2 if e0 + 2.5 <= x <= min(e0 + 12, sep - 2)]
        wl = [x for x in oi if any(2.6 <= y - x <= 4.7 for y in la2)]
        if wl: o['oi'] = min(wl)
        elif oi:
            x = min(oi, key=lambda x: abs(x - (sep - 0.86 - e0)))
            if abs(x - (sep - 0.86 - e0)) < 1.5: o['oi'] = x
        if np.isfinite(o['oi']):
            cur = o['oi']
            while True:
                nx = [y for y in la2 if 2.6 <= y - cur <= 4.7]
                if not nx: break
                cur = min(nx)
            oo = [y for y in so2 if 2.6 <= y - cur <= 4.7]
            if oo and cur > o['oi']: o['oo'] = min(oo)
            if np.isfinite(o['eL']):
                mid = [y for y in so2 if o['eL'] + 1.0 < y < o['oi'] - 1.0]
                if mid: o['bx'] = min(mid, key=lambda y: abs(y - (o['eL'] + o['oi']) / 2))
    return o


# ───────────────────────────── 4. along the route ─────────────────────────────
def _runmed(x, k):
    """running median over k windows (NaN-aware: at least 2 values), centred"""
    from numpy.lib.stride_tricks import sliding_window_view
    h = k // 2; xp = np.r_[np.full(h, np.nan), x, np.full(h, np.nan)]
    W = sliding_window_view(xp, k); cnt = np.isfinite(W).sum(1)
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter('ignore'); m = np.nanmedian(W, 1)
    return np.where(cnt >= 2, m, np.nan)


def _trend(x, k, c=1.5):
    """robust local linear trend of window values x (NaN-aware) over k windows centred: per window the value at its place
    of a line through its neighbours (Tukey reweighted, c m), NaN with fewer than 4 values — where the route line drifts
    across the carriageway (an old mapped alignment) every painted line moves with it and stays on the trend"""
    from numpy.lib.stride_tricks import sliding_window_view
    n = len(x); h = k // 2
    Y = sliding_window_view(np.r_[np.full(h, np.nan), x, np.full(h, np.nan)], k)
    M = np.isfinite(Y); Y0 = np.where(M, Y, 0.0); T = np.broadcast_to(np.arange(-h, h + 1, dtype=float), Y.shape); w = M.astype(float)
    with np.errstate(invalid='ignore', divide='ignore'):
        for _ in range(3):
            W = w.sum(1); tm = (w * T).sum(1) / W; ym = (w * Y0).sum(1) / W; dt = T - tm[:, None]
            st = (w * dt * dt).sum(1); sl = np.where(st > 1e-9, (w * dt * (Y0 - ym[:, None])).sum(1) / np.where(st > 1e-9, st, 1.0), 0.0)
            res = Y0 - (ym[:, None] + sl[:, None] * dt); w = M * np.clip(1 - (res / c) ** 2, 0, None) ** 2
        out = ym - sl * tm
    return np.where(M.sum(1) >= 4, out, np.nan)


def consolidate(Iw, v, grp, n, keep=None, med=7, jump=1.5, minrun=12, gap=2000, long=25, strong=None):
    """window values v (NaN: none) at route indices Iw → per metre (NaN where nothing): running median over `med`
    windows; departures over `jump` m from the robust local trend over `long` windows that last fewer than `minrun`
    windows (300 m) are dropped unless `keep` (a ramp: lanes move there) or four windows of full detection (`strong`) in it
    agree (steps under 1 m: the route line runs off the carriageway there, every line seen moves with it); gaps up to `gap`
    m interpolated, within one group"""
    out = np.full(n, np.nan, np.float32)
    v = np.asarray(v, float)
    for g in np.unique(grp):
        w = np.nonzero(grp == g)[0]
        x = _runmed(v[w], med)
        if jump:
            lg = _trend(x, long); dev = np.isfinite(lg) & (np.abs(x - lg) > jump)
            if keep is not None: dev &= ~keep[w]
            lab = np.cumsum(np.r_[True, dev[1:] != dev[:-1]])
            for q in np.unique(lab[dev]):
                m = lab == q
                if m.sum() >= minrun: continue
                if strong is not None:
                    sv = v[w][m & strong[w] & np.isfinite(v[w])]
                    if len(sv) >= 4 and np.abs(np.diff(sv)).max() < 1.0: x[m] = np.where(np.isfinite(v[w][m]), v[w][m], x[m]); continue
                x[m] = np.nan
        ok = np.isfinite(x)
        if ok.sum() < 1: continue
        ii = Iw[w][ok]; xx = x[ok]
        a = max(0, Iw[w[0]] - 50); b = min(n, Iw[w[-1]] + 50)
        j = np.arange(a, b)
        y = np.interp(j, ii, xx)
        nxt = np.searchsorted(ii, j); prv = np.clip(nxt - 1, 0, len(ii) - 1); nx_ = np.clip(nxt, 0, len(ii) - 1)
        span = np.where((nxt > 0) & (nxt < len(ii)), ii[nx_] - ii[prv], np.minimum(np.abs(j - ii[prv]), np.abs(j - ii[nx_])) * 2)
        y[span > gap] = np.nan
        y[(j < ii[0] - 50) | (j > ii[-1] + 50)] = np.nan
        out[a:b] = np.where(np.isfinite(y), y, out[a:b])
    return out


def runs_of(m):
    """[(a, b)] index ranges (b exclusive) of the True runs of a boolean array"""
    if not m.any(): return []
    d = np.diff(np.r_[0, m.astype(np.int8), 0]); return list(zip(np.nonzero(d == 1)[0], np.nonzero(d == -1)[0]))


# ───────────────────────────── 5. the barrier in the median ─────────────────────────────
GUARD_H, CONC_H = 0.75, 0.81          # German double steel guard rail (top of the W-beams); concrete step barrier (H2)
FINE = {'BY': 0.2, 'PL': 0.5}         # surface models fine enough to see a concrete barrier's width (others: 1 m)


class Cached:
    """heights from the shared elevation cache only (elev_fetch blocks already on disk; nothing is fetched)"""
    def __init__(self):
        import elev                                                    # (sets ELEV_CACHE to the shared cache)
        import elev_fetch
        from pyproj import Transformer
        self.ef, self.T, self.mem, self.src = elev_fetch, Transformer, {}, {}

    def __call__(self, code, kind, X, Y):
        key = (code, kind)
        if key not in self.src:
            try:
                s = self.ef.source(code, kind); s.tr = self.T.from_crs('EPSG:32633', s.crs, always_xy=True); self.src[key] = s
            except Exception: self.src[key] = None
        s = self.src[key]
        out = np.full(np.shape(X), np.nan, np.float32)
        if s is None or not hasattr(s, 'cdir'): return out
        x, y = s.tr.transform(np.ravel(X), np.ravel(Y))
        rr = np.floor((s.oy - np.asarray(y)) / s.res).astype(np.int64); cc = np.floor((np.asarray(x) - s.ox) / s.res).astype(np.int64)
        B = s.block; br, bc = rr // B, cc // B; o = out.ravel()
        for k in set(zip(br.tolist(), bc.tolist())):
            fk = (code, kind, k)
            if fk not in self.mem:
                fn = os.path.join(s.cdir, f'{k[0]}_{k[1]}.npy')
                a = np.load(fn) if os.path.exists(fn) else np.zeros(0, np.float32)
                if len(self.mem) > 64: self.mem.pop(next(iter(self.mem)))
                self.mem[fk] = a if a.size else None
            a = self.mem[fk]
            if a is None: continue
            m = (br == k[0]) & (bc == k[1]); o[m] = a[rr[m] - k[0] * B, cc[m] - k[1] * B]
        return out


def _mode_runs(typ, conf, n, win=201):
    """per metre: the most frequent type among the classified profiles within ±win/2 m (0 where none)"""
    out = np.zeros(n, np.uint8); best = np.zeros(n)
    for t_ in (1, 2, 3):
        c = np.convolve((typ == t_).astype(float) * conf, np.ones(win), 'same')
        m = c > best; out[m] = t_; best[m] = c[m]
    return out


def barriers(r, ax, eL, oin, dual, bx):
    """per metre: mtyp (0 none, 1 double steel guard rail, 2 concrete step barrier, 3 raised median with a steel rail on
    top), mh (top above the road, m), mw (raised median width, m) — mapped barriers on the axis, else the cached surface
    and terrain models every 10 m, laser points near structures for the height, else the standard guard rail"""
    from scipy.spatial import cKDTree
    P, N, s = r['P'], r['N'], r['s']; n = len(s); T = np.c_[N[:, 1], -N[:, 0]]
    mtyp = np.where(dual & np.isfinite(ax), 1, 0).astype(np.uint8); mh = np.where(mtyp > 0, GUARD_H, np.nan); mw = np.full(n, np.nan)
    if not mtyp.any(): return mtyp, mh, mw
    kd = cKDTree(P)
    # 1. mapped (Overture / OSM): a guard rail or jersey barrier within 2.5 m of the axis, parallel to it
    mapped = np.zeros(n, np.uint8)
    O = pickle.load(open(OUT + 'objects.pkl', 'rb'))['blocks'] if os.path.exists(OUT + 'objects.pkl') else {}
    for b in O.values():
        for l in b['lines']:
            if l['cls'] not in ('guard_rail', 'jersey_barrier'): continue
            for gg in getattr(l['g'], 'geoms', [l['g']]):
                xy = np.asarray(gg.coords)[:, :2]; sl = np.hypot(*np.diff(xy, axis=0).T)
                if not len(sl) or sl.sum() < 4: continue
                cs = np.r_[0, np.cumsum(sl)]; ss = np.arange(0, cs[-1], 1.0)
                pts = np.c_[np.interp(ss, cs, xy[:, 0]), np.interp(ss, cs, xy[:, 1])]
                g = np.gradient(pts, axis=0); g /= np.linalg.norm(g, axis=1)[:, None] + 1e-9
                dd, k = kd.query(pts, distance_upper_bound=40); ok = np.isfinite(dd); k = np.minimum(k, n - 1)
                lat = ((pts - P[k]) * N[k]).sum(1)
                ok &= np.isfinite(ax[k]) & (np.abs(lat - ax[k]) <= 2.5) & (np.abs((g * T[k]).sum(1)) > 0.9)
                for a in k[ok]: mapped[max(0, a - 1):a + 2] = 2 if l['cls'] == 'jersey_barrier' else 1
    # 2. surface (DOM) and terrain (DGM) models where cached: a profile across the axis every 10 m
    REG = pickle.load(open(OUT + 'regions.pkl', 'rb'))['lab']
    code = np.array([{'DE-BE': 'BB'}.get(x, x.replace('DE-', '').replace('PL-32', 'PL')) for x in REG])[np.minimum(len(REG) - 1, (s // CH).astype(int))]
    H = Cached(); u = np.arange(-3.0, 3.0001, 0.2)
    i10 = np.nonzero(dual & np.isfinite(ax) & (np.arange(n) % 10 == 0))[0]
    ptyp = np.zeros(n, np.uint8); ph = np.full(n, np.nan); pw = np.full(n, np.nan); seen = 0
    for c in np.unique(code[i10]):
        if c not in ('BY', 'BB', 'MV', 'ST', 'PL'): continue
        ii = i10[code[i10] == c]
        for k0 in range(0, len(ii), 2000):
            jj = ii[k0:k0 + 2000]
            dd = ax[jj, None] + u[None]
            # the reference: our inner lane 1 m inside the edge line and the opposite one 1 m inside its paved edge
            dr = np.c_[eL[jj] - 1.0, oin[jj] + 1.6]
            X = P[jj, 0, None] + N[jj, 0, None] * np.c_[dd, dr]; Y = P[jj, 1, None] + N[jj, 1, None] * np.c_[dd, dr]
            dgm = H(c, 'dgm', X, Y); dom = H(c, 'dom', X, Y)
            ok = np.isfinite(dgm).all(1) & (np.isfinite(dom[:, :len(u)]).mean(1) > 0.8)
            if not ok.any(): continue
            seen += ok.sum()
            za, zb = dgm[:, len(u)], dgm[:, len(u) + 1]
            ua, ub = dr[:, 0] - ax[jj], dr[:, 1] - ax[jj]
            zl = za[:, None] + (zb - za)[:, None] * ((u[None] - ua[:, None]) / np.maximum(ub - ua, 1)[:, None])
            hg = dgm[:, :len(u)] - zl; hs = dom[:, :len(u)] - zl
            core = np.abs(u) <= 0.8
            hd = np.nanmax(np.where(core[None], hs - np.maximum(hg, 0), -9), 1)          # standing on the ground at the axis
            up = (hg > 0.35) & (np.abs(u)[None] <= 2.5); wg = up.sum(1) * 0.2
            wd = ((hs - np.maximum(hg, 0)) > 0.4).sum(1) * 0.2
            fine = FINE.get(c, 1.0) <= 0.5
            for q in np.nonzero(ok)[0]:
                j = jj[q]
                if hd[q] > 1.6: continue                                    # a hedge or trees in the median: not decisive
                if wg[q] >= 2.0:
                    blk = float(np.nanmedian(hg[q][up[q]])); ptyp[j] = 3; ph[j] = round(min(1.15, blk) + GUARD_H, 2); pw[j] = wg[q]
                # (image-matched surface models smooth a 0.6 m concrete wall into a 2 m hump and read hedges and guard
                # rails alike: only a crisp narrow hump in a fine model counts as concrete)
                elif fine and hd[q] >= 0.7 and wd[q] <= 1.0: ptyp[j] = 2; ph[j] = float(np.clip(hd[q], 0.75, 1.3))
    # 3. laser points near structures (the survey's extracts; any route's cache — the shared kilometres): the height
    lz = sorted(set(glob.glob(routecfg.C + 'laz/*.npz') + glob.glob(os.path.join(routecfg.PROJECT, 'routes', '*', '.cache', 'route', 'laz', '*.npz'))
                   + glob.glob(os.path.join(routecfg.SHARED, 'laz', '*.npz'))), key=os.path.basename)
    done = set(); lzh = np.full(n, np.nan); lzt = np.zeros(n, np.uint8); lzw = np.full(n, np.nan)
    from pyproj import Transformer
    for fn in lz:
        b = os.path.basename(fn)
        if b in done: continue
        done.add(b)
        try: sc = float(b.split('_')[0])
        except ValueError: continue
        k0 = int(np.searchsorted(s, sc))
        if k0 >= n or not dual[max(0, k0 - 100):k0 + 100].any(): continue
        z = np.load(fn); p = z['p']; crs = {'DE-BY': 'EPSG:25832', 'PL-32': 'EPSG:2180', 'DE-BB': 'EPSG:25833'}.get(str(z['reg']))
        if crs is None: continue
        x, y = Transformer.from_crs(crs, 'EPSG:32633', always_xy=True).transform(p[:, 0], p[:, 1])
        Q = np.c_[x, y]; dd, k = kd.query(Q, distance_upper_bound=45); ok = np.isfinite(dd)
        if ok.mean() < 0.3: continue
        k = np.minimum(k, n - 1); lat = ((Q - P[k]) * N[k]).sum(1); Z = p[:, 2]; cl = p[:, 3].astype(int)
        for a in range(int(k[ok].min()), int(k[ok].max()) + 1, 4):
            if not (dual[a] and np.isfinite(ax[a])): continue
            m = ok & (np.abs(k - a) <= 2)
            g = m & (cl == 2)
            ra = g & (lat > eL[a] - 2.0) & (lat < eL[a] - 0.5); rb = g & (lat > oin[a] + 0.5) & (lat < oin[a] + 2.0)
            if ra.sum() < 5 or rb.sum() < 5: continue
            za, zb = np.median(Z[ra]), np.median(Z[rb]); ua, ub = eL[a] - 1.25 - ax[a], oin[a] + 1.25 - ax[a]
            uu = lat - ax[a]; zl = za + (zb - za) * (uu - ua) / max(ub - ua, 1.0); h = Z - zl
            near = m & (np.abs(uu) <= 2.5) & (h < 2.5)
            if near.sum() < 10: continue
            gr = near & (cl == 2) & (h > 0.35)
            wgr = (np.ptp(uu[gr]) if gr.sum() > 8 else 0.0)
            sel = near & (np.abs(uu) <= (wgr / 2 + 0.3 if wgr >= 2 else 0.8))
            if sel.sum() < 5: continue
            top = float(np.percentile(h[sel], 97))
            if wgr >= 2.0: lzt[a:a + 4] = 3; lzw[a:a + 4] = min(4.5, wgr); lzh[a:a + 4] = max(top, float(np.median(h[gr])) + GUARD_H if top < 1.0 else top)
            elif 0.6 <= top <= 1.4: lzh[a:a + 4] = top
    # combine: laser > models > mapped > the standard guard rail; types by majority over ±100 m of profiles
    pt = _mode_runs(ptyp, 1.0, n)
    for t_ in (1, 2, 3):
        m = (pt == t_) & (mtyp > 0); mtyp[m] = t_
    m = (pt == 0) & (mapped > 0) & (mtyp > 0); mtyp[m] = mapped[m]
    m = (lzt == 3) & (mtyp > 0); mtyp[m] = 3
    hh = gsmooth(np.where(ptyp > 0, ph, np.nan), 30); ww = gsmooth(np.where(ptyp == 3, pw, np.nan), 30)
    hh = np.where(np.isfinite(lzh), lzh, hh); ww = np.where(np.isfinite(lzw), lzw, ww)
    mh = np.where(mtyp == 1, GUARD_H, np.where(mtyp == 2, np.where(np.isfinite(hh) & (hh < 1.4), hh, CONC_H),
                  np.where(mtyp == 3, np.where(np.isfinite(hh) & (hh >= 1.2), hh, 0.7 + GUARD_H), np.nan)))
    mw = np.where(mtyp == 3, np.where(np.isfinite(ww), ww, 3.0), np.nan)
    print(f'median: {dual.mean() * 100:.1f} % of the route dual; profiles from cached models {seen} (classified '
          f'{(ptyp > 0).sum()}: steel {(ptyp == 1).sum()}, concrete {(ptyp == 2).sum()}, raised {(ptyp == 3).sum()}); mapped on '
          f'{(mapped > 0).mean() * 100:.1f} %; laser {np.isfinite(lzh).sum()} m from {len(done)} extracts; types steel/concrete/raised '
          f'{(mtyp == 1).sum() / 1000:.1f}/{(mtyp == 2).sum() / 1000:.1f}/{(mtyp == 3).sum() / 1000:.1f} km', flush=True)
    return mtyp, mh, mw


def report(r, ctx, A, Iw, Kw, V, have):
    """validation: coverage by kind and region, lane widths and counts, the axis"""
    s = r['s']; n = len(s); one = (ctx['kind'] == 2) & have; tw = (ctx['kind'] == 1) & have
    REG = pickle.load(open(OUT + 'regions.pkl', 'rb'))['lab']; reg = np.array(REG)[np.minimum(len(REG) - 1, (s // CH).astype(int))]
    w = A['rL'] - A['rR']
    print(f"one-way {one.sum() / 1000:.1f} km: right lane detected (lq 2) {(one & (A['lq'] == 2)).mean() / max(one.mean(), 1e-9) * 100:.1f} %, "
          f"edge line only {(one & (A['lq'] == 1)).mean() / max(one.mean(), 1e-9) * 100:.1f} %, fallback {(one & (A['lq'] == 0)).mean() / max(one.mean(), 1e-9) * 100:.1f} %; "
          f"lane width p10/50/90 {np.nanpercentile(w[one], 10):.2f}/{np.nanmedian(w[one]):.2f}/{np.nanpercentile(w[one], 90):.2f}; "
          f"lanes {dict(zip(*np.unique(A['nl'][one], return_counts=True)))}")
    for rg in np.unique(reg[one]):
        m = one & (reg == rg)
        print(f"  {rg}: {m.sum() / 1000:6.1f} km  lq2 {(A['lq'][m] == 2).mean() * 100:5.1f} %  lq1 {(A['lq'][m] == 1).mean() * 100:5.1f} %  "
              f"lanes {dict(zip(*np.unique(A['nl'][m], return_counts=True)))}")
    print(f"two-way {tw.sum() / 1000:.1f} km: centre line {np.isfinite(A['cl'][tw]).mean() * 100:.1f} %")
    d = ctx['kind'] == 2
    print(f"median axis on {np.isfinite(A['ax'][d]).mean() * 100:.1f} % of one-way km; axis − eL p10/50/90 "
          f"{np.nanpercentile((A['ax'] - A['eL'])[d], 10):.2f}/{np.nanmedian((A['ax'] - A['eL'])[d]):.2f}/{np.nanpercentile((A['ax'] - A['eL'])[d], 90):.2f}; "
          f"opposite width p50 {np.nanmedian((A['oout'] - A['oin'])[d]):.1f}")


def gsmooth(a, sig):
    """Gaussian smoothing (σ in samples) of the finite runs of a; NaN stays NaN"""
    from scipy.ndimage import gaussian_filter1d
    ok = np.isfinite(a)
    if not ok.any(): return a
    num = gaussian_filter1d(np.where(ok, a, 0.0), sig, mode='nearest'); den = gaussian_filter1d(ok.astype(float), sig, mode='nearest')
    return np.where(ok, num / np.maximum(den, 1e-6), np.nan).astype(np.float32)


def main(workers=4):
    t0 = time.time()
    r = route(); s = r['s']; n = len(s)
    ctx = context(r); kind_ = ctx['kind']
    S1 = np.load(OUT + 'survey_1m.npz')
    L = S1['L'].astype(float); R = S1['R'].astype(float); have = S1['have'].astype(bool)
    # the paved edges without junction mouths and lay-bys (fallbacks are laid from them)
    Ls = gsmooth(median_filter(L, 101, mode='nearest'), 25).astype(float); Rs = gsmooth(median_filter(R, 101, mode='nearest'), 25).astype(float)
    sep = opposite(r); seps = gsmooth(sep.astype(float), 10)
    osm = osm_lanes(r)
    print(f'route {s[-1] / 1000:.1f} km: opposite carriageway on {np.isfinite(sep).mean() * 100:.1f} %, OSM lanes on {(osm > 0).mean() * 100:.1f} %', flush=True)
    det = detect_all(workers)
    # ── every window: its lanes
    F = ('rR', 'rL', 'eR', 'eL', 'cl', 'xR', 'oi', 'oo', 'bx')
    Iw, Kw, rows = [], [], []
    for c in sorted(det):
        for w in det[c]:
            sm, Lb, Rb, wl, yl = w[:5]
            i = int(min(n - 1, np.searchsorted(s, sm)))
            if not have[i]: continue
            sw = float(np.nanmedian(sep[max(0, i - 50):i + 50])) if np.isfinite(sep[max(0, i - 50):i + 50]).any() else np.nan
            tw = bool(ctx['tw'][i]); mway = ctx['cls'][i] == 'motorway' and ctx['de'][i]
            o = one_window(wl, Lb, Rb, sw, tw, mway)
            if not tw and np.isfinite(sw) and o['lq'] < 2:
                # nothing right of the mapped median: the mapped lines may lie off the photo's carriageway (an old
                # alignment); the right lane may then reach towards the opposite carriageway's line, if it lies on the
                # traced width
                o2 = one_window(wl, Lb, Rb, sw, tw, mway, up_sep=1.0)
                if o2['lq'] == 2 and o2['rR'] < Lb - 2.6: o = o2
            if len(yl) >= 2:                                           # yellow temporary markings: a layout of their own
                oy = one_window(yl, Lb, Rb, sw, tw, mway)
                if oy['lq'] == 2: oy.update({k: o[k] for k in ('oi', 'oo', 'bx')}); o = oy
            # the route leaves by a ramp within 400 m: its exit lane is the convoy's lane
            if o['ex'] and ctx['ahead'][i] and not ctx['link'][i] and np.isfinite(o['xR']): o['rL'], o['rR'] = o['rR'], o['xR']
            Iw.append(i); Kw.append(kind_[i]); rows.append(o)
    Iw = np.array(Iw); Kw = np.array(Kw)
    V = {k: np.array([o[k] for o in rows], float) for k in F + ('nl', 'lq', 'ex')}
    # groups: runs of one road kind without a gap over 2 km
    grp = np.cumsum(np.r_[True, (Kw[1:] != Kw[:-1]) | (np.diff(Iw) > 2000)])
    keep = ctx['link'][Iw] | ctx['ahead'][Iw]
    print(f'{len(Iw)} windows in {grp.max()} runs ({time.time() - t0:.0f} s); right lane found in '
          f'{(V["lq"][Kw == 2] == 2).mean() * 100:.1f} % of one-way windows (+{(V["lq"][Kw == 2] == 1).mean() * 100:.1f} % edge line only), '
          f'centre line in {np.isfinite(V["cl"][Kw == 1]).mean() * 100:.1f} % of two-way windows', flush=True)
    M = {}
    for k in F:
        gk = np.where(np.isin(Kw, [1, 2]), grp, -1)
        M[k] = consolidate(Iw, np.where(gk >= 0, V[k], np.nan), gk, n, keep=keep, jump=1.5 if k in ('rR', 'rL', 'xR') else 1.0,
                           strong=(V['lq'] == 2) if k in ('rR', 'rL', 'eR', 'eL', 'xR') else None)
    nlm = consolidate(Iw, np.where(V['nl'] > 0, V['nl'], np.nan), grp, n, keep=keep, jump=0.9, gap=2000)
    # per metre: what the nearest window found (within 60 m)
    near = np.full(n, -1, np.int64); dist = np.full(n, 1e9)
    for j, i in enumerate(Iw):
        a, b = max(0, i - 60), min(n, i + 61); dd = np.abs(np.arange(a, b) - i); m = dd < dist[a:b]
        near[a:b][m] = j; dist[a:b][m] = dd[m]
    lq_near = np.where(near >= 0, V['lq'][np.maximum(near, 0)], 0)
    for k in F: M[k] = gsmooth(M[k].astype(float), 20)

    # ── one-way carriageways: the right lane, its fallbacks, the edge lines and the lane count
    one = kind_ == 2
    rR = np.where(one, M['rR'], np.nan); rL = np.where(one, M['rL'], np.nan)
    w = rL - rR; bad = np.isfinite(w) & ((w < 2.6) | (w > 4.7))
    ctr = (rR + rL) / 2; rR[bad] = ctr[bad] - LANE_W / 2; rL[bad] = ctr[bad] + LANE_W / 2
    lq = np.where(np.isfinite(rR), np.where(lq_near > 0, lq_near, 1), 0).astype(np.uint8)
    eR = np.where(one, M['eR'], np.nan); eL = np.where(one, M['eL'], np.nan)
    m = one & ~np.isfinite(rR) & np.isfinite(eR); rR[m] = eR[m]; rL[m] = eR[m] + LANE_W; lq[m] = 1
    # the typical place of the right lane over the paved right edge, per motorway (where it was seen)
    det2 = one & (lq == 2) & have & np.isfinite(rR)
    off_all = float(np.nanmedian((rR + Rs)[det2])) if det2.sum() > 1000 else 4.5
    wid_all = float(np.nanmedian((rL - rR)[det2])) if det2.sum() > 1000 else LANE_W
    off = np.full(n, off_all); wid = np.full(n, wid_all)
    for rf in np.unique(ctx['ref'][one]):
        mm = det2 & (ctx['ref'] == rf)
        if rf and mm.sum() > 500:
            q = ctx['ref'] == rf; off[q] = np.nanmedian((rR + Rs)[mm]); wid[q] = np.nanmedian((rL - rR)[mm])
    W = Ls + Rs
    m = one & ~np.isfinite(rR) & have
    nos = m & (W < 10.5)                                              # no hard shoulder: 2.25 m from the paved edge
    rR[nos] = -Rs[nos] + 2.25 - LANE_W / 2; rL[nos] = rR[nos] + LANE_W
    hs = m & ~nos; rR[hs] = -Rs[hs] + off[hs] - wid[hs] / 2; rL[hs] = rR[hs] + wid[hs]
    rR = gsmooth(rR, 15); rL = gsmooth(rL, 15)
    eR = np.where(one & ~np.isfinite(eR), rR, eR)
    # ── central reservation (dual carriageways): axis, opposite carriageway
    dual = one & np.isfinite(seps) & (seps >= 8) & (seps <= 30)
    axw = np.where(np.isfinite(V['eL']) & np.isfinite(V['oi']) & (V['oi'] - V['eL'] >= 3) & (V['oi'] - V['eL'] <= 12), (V['eL'] + V['oi']) / 2, np.nan)
    axp = consolidate(Iw, np.where(Kw == 2, axw, np.nan), grp, n, jump=1.0)
    ax = np.where(dual, np.where(np.isfinite(axp), axp, seps / 2 - 0.43), np.nan)
    ax = gsmooth(ax, 15)
    eL0 = eL.copy()                                                  # (as painted, carried over gaps up to 2 km)
    eLseen = np.isfinite(eL0) & (near >= 0) & np.isfinite(V['eL'][np.maximum(near, 0)])      # (seen within 60 m)
    # our inner edge line: as painted, else 2.4 m right of the axis, else 0.6 m inside the paved left edge
    eL = np.where(one & ~np.isfinite(eL), np.where(np.isfinite(ax), np.minimum(Ls - 0.3, ax - 2.4), Ls - 0.6), eL)
    eL = np.where(np.isfinite(ax), np.minimum(eL, ax - 1.2), eL)
    eL = np.where(one, np.maximum(eL, rL), eL)
    # lane count: as painted, else OSM, else from the width between the edge lines
    nl = np.where(np.isfinite(nlm), np.round(nlm), 0)
    nl = np.where(one & (nl == 0) & (osm > 0), osm, nl)
    nl = np.where(one & (nl == 0) & np.isfinite(eL) & np.isfinite(eR), np.clip(np.round((eL - eR) / 3.7), 1, 5), nl)
    # ── plausibility (one-way): lanes of 3.0–4.3 m between the edge lines, the inner edge line 1.0–4.5 m right of the median
    # axis, the right lane inside the edge lines, not a lane or two fewer than the map has (nor one more of narrow lanes:
    # a roadworks layout). Where the inner edge line was not seen but the right lane was, the right lane is believed (the
    # route line runs off the carriageway there and the fallbacks from the mapped axis are wrong): the inner edge line and
    # the axis are laid from it. Elsewhere a distorted deck, tree shadows or the markings of roadworks on the photo broke
    # the lines: they and the axis come from the plausible metres around (linear, gaps up to 3 km; one side only: held).
    # Both count as a fallback (lq 0; the opposite carriageway is then mirrored about the axis)
    def implausible():
        wl = (eL - eR) / np.where(nl > 0, nl, np.nan)
        with np.errstate(invalid='ignore'):
            iw = one & have & np.isfinite(wl) & (nl >= 2) & ((wl < 3.0) | (wl > 4.3) | ((nl >= 3) & (wl < 3.25)))
            ia = one & have & dual & np.isfinite(ax) & np.isfinite(eL) & ((ax - eL < 1.0) | (ax - eL > 4.5))
            io = one & have & ((np.isfinite(rR) & np.isfinite(eR) & (rR < eR - 0.3))
                               | (dual & (nl == 1) & ~ctx['link'])
                               | ((osm >= 2) & (nl > 0) & ((nl <= osm - 2) | ((nl > osm) & (wl < 3.25)))))
        return iw, ia, io
    iw, ia, io = implausible(); iw0, ia0, io0 = iw, ia, io
    left = (iw | ia) & ~io & ~eLseen & (lq == 2) & np.isfinite(rL)
    eL = np.where(left, rL + (np.maximum(np.maximum(nl, osm), 1) - 1) * wid, eL)
    with np.errstate(invalid='ignore'):
        ax = np.where(left & np.isfinite(ax) & ((ax - eL < 1.0) | (ax - eL > 4.5)), eL + 2.4, ax)
    lq[left] = 0
    iw, ia, io = implausible()
    imp = (maximum_filter1d((iw | ia | io).astype(np.uint8), 101) > 0) & one & ~left     # (the smoothing carried it 50 m on)
    for a, b in runs_of(imp):
        p0 = a - 1 if a > 0 and one[a - 1] else None; p1 = b if b < n and one[b] else None
        if b - a > 3000: p0 = p1 = None
        for arr in (rR, rL, eR, eL, ax):
            v0 = arr[p0] if p0 is not None else np.nan; v1 = arr[p1] if p1 is not None else np.nan
            keep_nan = (arr is ax) & ~np.isfinite(arr[a:b])                 # (no median there: none)
            if np.isfinite(v0) and np.isfinite(v1): arr[a:b] = np.where(keep_nan, np.nan, v0 + (v1 - v0) * (np.arange(a, b) - a + 1) / (b - a + 1))
            elif np.isfinite(v0) or np.isfinite(v1): arr[a:b] = np.where(keep_nan, np.nan, v0 if np.isfinite(v0) else v1)
        # the lane count of the ends or the map's, whichever gives lanes nearest the standard width between the lines laid
        k0 = {int(nl[p]) for p in (p0, p1) if p is not None and nl[p] > 0} | ({int(osm[a:b].max())} if osm[a:b].max() >= 2 else set())
        wd = float(np.nanmedian(eL[a:b] - eR[a:b])) if np.isfinite(eL[a:b] - eR[a:b]).any() else np.nan
        if k0: nl[a:b] = min(k0, key=lambda k: abs(wd / k - LANE_W) if np.isfinite(wd) else k)
        lq[a:b] = 0
    eL = np.where(one, np.maximum(eL, rL), eL)
    if os.environ.get('LANELINES_DEBUG'):                            # (the plausibility rules' masks, for checks)
        np.savez_compressed(os.environ['LANELINES_DEBUG'], iw=iw0, ia=ia0, io=io0, left=left, imp=imp, osm=osm, eLseen=eLseen, nl=nl)
    imp |= left
    print(f'implausible lanes on {imp.sum() / 1000:.1f} km of one-way road: the inner edge line laid from the right lane on '
          f'{left.sum() / 1000:.1f} km, the lines carried over from the plausible metres around on {(imp & ~left).sum() / 1000:.1f} km '
          f'({len(runs_of(imp & ~left))} stretches)', flush=True)
    Lp = np.where(np.isfinite(eL), eL + 0.6, Ls)                      # our inner paved edge
    oin = np.where(dual & np.isfinite(M['oi']) & ~imp, M['oi'] - 0.6, 2 * ax - Lp)
    shd = np.clip(np.where(np.isfinite(eR), eR + Rs, 2.5), 0.5, 4.0)
    oout = np.where(dual & np.isfinite(M['oo']) & ~imp, M['oo'] + shd, 2 * ax + Rs)
    # its width: 7 m to 18 m (or our paved width + 2.5 m); a measured outer edge beyond is a verge or a parallel road, and
    # the fallback mirrored about the mapped median is checked the same way (it put a 30 m slab across a verge where the
    # mapped median ran wide). Where neither holds, or the outer edge jumps by more than 1 m per metre, the width is carried
    # across from the plausible metres around (gaps up to 300 m), else none
    wmax = np.maximum(18.0, Ls + Rs + 2.5)
    bad = ~((oout - oin >= 7) & (oout - oin <= wmax)); oout = np.where(bad, 2 * seps - oin, oout)
    with np.errstate(invalid='ignore'):
        jump = np.r_[False, np.abs(np.diff(oout)) > 1.0]
        bad = ~((oout - oin >= 7) & (oout - oin <= wmax)) | (maximum_filter1d(jump.astype(np.uint8), 5) > 0)
    wo = np.where(bad, np.nan, oout - oin)
    for a, b in runs_of(dual & ~np.isfinite(wo) & np.isfinite(oin)):
        v0 = wo[a - 1] if a > 0 and np.isfinite(wo[a - 1]) else np.nan; v1 = wo[b] if b < n and np.isfinite(wo[b]) else np.nan
        if b - a > 300 or not (np.isfinite(v0) or np.isfinite(v1)): continue
        v0 = v0 if np.isfinite(v0) else v1; v1 = v1 if np.isfinite(v1) else v0
        wo[a:b] = v0 + (v1 - v0) * (np.arange(a, b) - a + 1) / (b - a + 1)
    oout = oin + wo
    oin = np.where(dual, oin, np.nan); oout = np.where(dual, oout, np.nan)
    # ── two-way roads: the painted centre line, the edge lines
    tw = kind_ == 1
    cl = np.where(tw, M['cl'], np.nan)
    eR = np.where(tw, M['eR'], eR); eL = np.where(tw, M['eL'], eL)
    rR = np.where(tw, eR, rR); rL = np.where(tw, cl, rL)
    nl = np.where(tw, np.where(np.isfinite(cl), 2, 0), nl)
    lq = np.where(tw, np.where(np.isfinite(cl), np.where(lq_near > 0, lq_near, 1), 0), lq).astype(np.uint8)
    ex = np.zeros(n, np.uint8)
    for j in np.nonzero(V['ex'] > 0)[0]: ex[max(0, Iw[j] - 50):Iw[j] + 50] = 1
    nl[kind_ == 0] = 0
    # ── the barrier in the median
    mtyp, mh, mw = barriers(r, ax, eL, oin, dual, M['bx'])
    f16 = lambda a: np.asarray(a, np.float32).astype(np.float16)
    np.savez_compressed(OUT + 'lanelines.npz', rR=f16(rR), rL=f16(rL), eR=f16(eR), eL=f16(eL), ax=f16(ax), oin=f16(oin), oout=f16(oout),
                        nl=nl.astype(np.uint8), lq=lq.astype(np.uint8), mtyp=mtyp.astype(np.uint8), mh=f16(mh), mw=f16(mw),
                        cl=f16(cl), ex=ex, sep=f16(sep))
    report(r, ctx, dict(rR=rR, rL=rL, eR=eR, eL=eL, nl=nl, lq=lq, ax=ax, oin=oin, oout=oout, mtyp=mtyp, mh=mh, cl=cl), Iw, Kw, V, have)
    print(f'saved {OUT}lanelines.npz ({time.time() - t0:.0f} s)', flush=True)


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'show':
        for c in map(int, sys.argv[2:]):
            for sm, Lb, Rb, wl, yl, thr in detect_chunk(c)[1]:
                print(f's {sm:9.1f} L {Lb:5.2f} R {Rb:5.2f} t {thr:4.1f} |', ' '.join(f'{d:+.2f}{k[0]}{du:.2f}/{P:.0f}' for d, k, du, P, o in wl),
                      ('| yellow ' + ' '.join(f'{d:+.2f}{k[0]}' for d, k, du, P, o in yl)) if yl else '')
    elif len(sys.argv) > 1 and sys.argv[1] == 'detect': detect_all(int(sys.argv[2]) if len(sys.argv) > 2 else 4)
    else: main(int(sys.argv[1]) if len(sys.argv) > 1 else 4)
