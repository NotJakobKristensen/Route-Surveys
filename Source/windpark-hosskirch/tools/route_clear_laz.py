"""Clear heights over the route measured in the official airborne laser point clouds (not estimated from raster models).

For every structure crossing over the route (bridges_raw.pkl: the deck centrelines and widths from Overture) the points of
the open ALS tiles around it are kept: the driving line ±35 m and the deck lines, plus 12 m. The road under the convoy is the
lower envelope of the ground points (class 2, PL also 11) per 2 m along the driving line ahead of and behind the deck, a
robust line or parabola through it, so ballast on a rail deck or a lid classed as ground stays out of it. The deck is the
layer of the other points that spans the driving line on both sides, metre by metre over the convoy's band; its median
height is the deck top. Points below the deck that hang together with it (no vertical gap over GAP m) are its side faces
or underside; trees beside it and vehicles under it are not. A scanner overhead rarely sees an underside, so the clear
height is the deck top minus the larger of a typical depth (route_clearance.depth_of) and the depth seen.
No deck over the driving line: recorded as such (the route passes over or beside the mapped crossing). Road not seen
beyond both ends of the deck, or ground well above the road beside it (a covered section, a cutting under a lid): recorded
as undetermined, and route_corridor.load_clear skips it so the next source holds.

Sources: Bavaria, LDBV open data: 1 km LAZ tiles (EPSG:25832, DHHN2016), https://geodaten.bayern.de/odd_data/laser/E_N.laz;
Poland, GUGiK: sheets found per point through the geoportal's index WMS, newest flight first (EPSG:2180, PL-EVRF2007-NH).
Usage: python route_clear_laz.py extract [DE-BY|PL-32]   (download each tile once, keep the points around its structures,
                                                         delete it; ONLY=a-b limits to a chainage range in m)
       python route_clear_laz.py measure                 (→ corr/clear_laz.json, read before every other clear-height file)"""
import routecfg
import json, os, pickle, sys, time, urllib.request
import numpy as np
from pyproj import Transformer
from route_corridor import route, OUT

C = routecfg.C
PTS = C + 'laz/'                      # point extracts per structure (small), kept for re-measuring
TMP = routecfg.SHARED + 'laz_tmp/'    # one tile at a time
os.makedirs(PTS, exist_ok=True); os.makedirs(TMP, exist_ok=True)
ALONG = 35.0                          # m either side of the crossing along the route
BAND = 2.5                            # convoy band either side of the driving line (root frame 4.2 m, blade chord 4.3 m)
WIDE = 4.5                            # second, wider band (lateral position of the convoy not fixed)
GAP = 0.6                             # a vertical gap over this ends a run of structure points
SRC = {'DE-BY': dict(crs='EPSG:25832', tile=1000, url='https://geodaten.bayern.de/odd_data/laser/{e}_{n}.laz',
                     credit='Laser point cloud: Bayerische Vermessungsverwaltung (CC BY 4.0)'),
       'DE-BB': dict(crs='EPSG:25833', tile=1000, url='https://data.geobasis-bb.de/geobasis/daten/als/laz/als_33{e}-{n}.zip',
                     credit='Laser point cloud: © GeoBasis-DE/LGB (dl-de/by-2-0)'),
       'PL-32': dict(crs='EPSG:2180', index=True, credit='Laser point cloud: GUGiK, geoportal.gov.pl (PL-EVRF2007-NH)')}
PL_IDX = 'https://mapy.geoportal.gov.pl/wss/service/PZGIK/DanePomiaroweNMT/WMS/SkorowidzeUkladEVRF2007'
PL_LAYERS = 'SkorowidzeLIDAR2026,SkorowidzeLIDAR2025,SkorowidzeLIDAR2024,SkorowidzeLIDAR2023iStarsze'


def pl_tiles(x, y):
    """GUGiK point-cloud sheets at (x, y) in EPSG:2180, newest flight first: [(date, sheet, url)]"""
    import re, urllib.parse
    p = dict(SERVICE='WMS', VERSION='1.3.0', REQUEST='GetFeatureInfo', LAYERS=PL_LAYERS, QUERY_LAYERS=PL_LAYERS, STYLES='',
             CRS='EPSG:2180', BBOX=f'{y - 50},{x - 50},{y + 50},{x + 50}', WIDTH=101, HEIGHT=101, I=50, J=50,
             INFO_FORMAT='text/html', FEATURE_COUNT=50, FORMAT='image/png')
    for a in range(4):
        try:
            html = urllib.request.urlopen(urllib.request.Request(PL_IDX + '?' + urllib.parse.urlencode(p), headers={'User-Agent': 'route-survey'}), timeout=60).read().decode('utf-8', 'replace'); break
        except Exception:
            time.sleep(2 ** a); html = ''
    out = []
    for rec in re.findall(r'push\(\{(.*?)\}\)', html, re.S):
        d = dict(re.findall(r'(\w+)\s*:\s*"([^"]*)"', rec))
        if d.get('url', '').endswith(('.laz', '.las')): out.append((d.get('aktualnosc') or '', d.get('godlo'), d['url']))
    return sorted(out, reverse=True)


def structures(regs):
    raw = pickle.load(open(OUT + 'bridges_raw.pkl', 'rb'))
    REG = pickle.load(open(OUT + 'regions.pkl', 'rb'))['lab']
    reg_of = lambda sv: (lambda q: 'DE-BB' if q == 'DE-BE' else q)(REG[min(len(REG) - 1, int(sv // 500))])
    out = []
    for recs in raw['blocks'].values():
        for o in recs:
            r = reg_of(o['s0'])
            if os.environ.get('ONLY') and not any(float(a) <= o['s0'] <= float(b) for a, b in (r.split('-') for r in os.environ['ONLY'].split(','))): continue
            if r in regs and o.get('lines'): out.append(dict(o, reg=r, key=f"{round(o['s0'])}_{str(o['id'])[:12]}"))
    return sorted(out, key=lambda o: o['s0'])


def window(o, r, S1):
    """driving line ±ALONG around the crossing (UTM 33): points, chainage, normals"""
    s = r['s']; i0 = int(np.searchsorted(s, o['s0'] - ALONG)); i1 = int(np.searchsorted(s, o['s0'] + ALONG))
    ii = np.arange(max(0, i0), min(len(s), i1 + 1))
    sh = np.nan_to_num(S1['shift'][np.minimum(ii, len(S1['shift']) - 1)].astype(float))
    Q = r['P'][ii] + r['N'][ii] * sh[:, None]
    return Q, s[ii] - o['s0'], r['N'][ii]


def extract(regs):
    r = route(); S1 = np.load(OUT + 'survey_1m.npz')
    todo = {}
    for o in structures(regs):
        fn = PTS + o['key'] + '.npz'
        if os.path.exists(fn): continue
        S = SRC[o['reg']]; t = Transformer.from_crs('EPSG:32633', S['crs'], always_xy=True)
        Q, _, _ = window(o, r, S1)
        L = np.concatenate([np.asarray(l, float) for l in o['lines']])
        xs, ys = t.transform(np.r_[Q[:, 0], L[:, 0]], np.r_[Q[:, 1], L[:, 1]])
        bb = (min(xs) - 12, min(ys) - 12, max(xs) + 12, max(ys) + 12)
        if S.get('index'):                                # sheets of the newest flight covering the window's corners and centre
            urls = set()
            for x_, y_ in ((bb[0], bb[1]), (bb[2], bb[1]), (bb[0], bb[3]), (bb[2], bb[3]), ((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2)):
                tl = pl_tiles(x_, y_)
                if tl: newest = tl[0][0]; urls |= {u for dt, g, u in tl if dt == newest}
            for u in urls: todo.setdefault((o['reg'], u), []).append((o, bb))
        else:
            for e in range(int(bb[0] // S['tile']), int(bb[2] // S['tile']) + 1):
                for n in range(int(bb[1] // S['tile']), int(bb[3] // S['tile']) + 1):
                    todo.setdefault((o['reg'], S['url'].format(e=e, n=n)), []).append((o, bb))
    print(len(todo), 'tiles for', sum(len(v) for v in todo.values()), 'structure windows', flush=True)
    import laspy, concurrent.futures as cf
    def fetch_zip(url, fn, n=8):
        """a zipped tile from a slow server: n ranged requests at once (resumed after a break), then the LAZ inside it"""
        out = fn[:-4] + '.laz'
        if os.path.exists(out): return out
        hdr = {'User-Agent': 'route-survey'}
        with urllib.request.urlopen(urllib.request.Request(url, headers=hdr, method='HEAD'), timeout=120) as rq: size = int(rq.headers['Content-Length'])
        cuts = [size * i // n for i in range(n + 1)]
        def part(i):
            p = f'{fn}.{i}'; a, b = cuts[i], cuts[i + 1] - 1
            for t in range(12):
                have = os.path.getsize(p) if os.path.exists(p) else 0
                if have >= b - a + 1: return
                try:
                    with urllib.request.urlopen(urllib.request.Request(url, headers={**hdr, 'Range': f'bytes={a + have}-{b}'}), timeout=300) as rq, open(p, 'ab') as f:
                        while True:
                            c = rq.read(1 << 20)
                            if not c: break
                            f.write(c)
                except Exception: time.sleep(min(60, 2 ** t))
            raise IOError('range download failed')
        import concurrent.futures as cf2, zipfile
        with cf2.ThreadPoolExecutor(n) as ex2: list(ex2.map(part, range(n)))
        with open(fn, 'wb') as f:
            for i in range(n):
                with open(f'{fn}.{i}', 'rb') as g: f.write(g.read())
                os.remove(f'{fn}.{i}')
        with zipfile.ZipFile(fn) as z:
            m = [q for q in z.namelist() if q.lower().endswith(('.laz', '.las'))][0]
            with z.open(m) as src, open(out + '.part', 'wb') as dst:
                while True:
                    c = src.read(1 << 22)
                    if not c: break
                    dst.write(c)
        os.replace(out + '.part', out); os.remove(fn)
        return out
    def fetch(k):
        reg, url = k; fn = TMP + reg + '_' + url.rsplit('/', 1)[-1]
        if url.endswith('.zip'):
            try: return k, fetch_zip(url, fn)
            except urllib.error.HTTPError as ex: return k, None if ex.code == 404 else fetch_zip(url, fn)
        if not os.path.exists(fn):
            for a in range(4):
                try:
                    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'route-survey'}), timeout=600) as rq, open(fn + '.part', 'wb') as f:
                        want = int(rq.headers.get('Content-Length') or 0); got = 0
                        while True:
                            b = rq.read(1 << 22)
                            if not b: break
                            f.write(b); got += len(b)
                    if want and got != want: raise IOError(f'truncated {got} of {want}')      # a connection closed early
                    os.replace(fn + '.part', fn); break
                except urllib.error.HTTPError as ex:
                    if ex.code == 404: return k, None
                    time.sleep(2 ** a)
                except Exception:
                    time.sleep(2 ** a)
        return k, fn
    parts = {}                                     # structure key -> list of point arrays (several tiles)
    need = {}
    for k, v in todo.items():
        for o, bb in v: need[o['key']] = need.get(o['key'], 0) + 1
    keys = list(todo); t0 = time.time()
    with cf.ThreadPoolExecutor(2) as ex:
        futs = [ex.submit(fetch, k) for k in keys[:2]]; nxt = 2
        for done in range(len(keys)):
            k, fn = futs[done].result()
            if nxt < len(keys): futs.append(ex.submit(fetch, keys[nxt])); nxt += 1
            if fn is None or not os.path.exists(fn): print('  no tile', k, flush=True)
            else:
              for attempt in range(2):
                try:
                  with laspy.open(fn) as f:
                      sel = {o['key']: [] for o, bb in todo[k]}
                      for ch in f.chunk_iterator(5_000_000):
                          x = np.asarray(ch.x); y = np.asarray(ch.y)
                          for o, bb in todo[k]:
                              m = (x >= bb[0]) & (x <= bb[2]) & (y >= bb[1]) & (y <= bb[3])
                              if m.any():
                                  sel[o['key']].append(np.c_[x[m], y[m], np.asarray(ch.z)[m], np.asarray(ch.classification)[m], np.asarray(ch.gps_time)[m]])
                  break
                except Exception as err:                 # a damaged file: fetch it again once
                  print('  bad tile', k, repr(err)[:80], flush=True)
                  if os.path.exists(fn): os.remove(fn)
                  sel = {o['key']: [] for o, bb in todo[k]}
                  if attempt or fetch(k)[1] is None: break
              for o, bb in todo[k]:
                  parts.setdefault(o['key'], []).extend(sel[o['key']])
              if os.path.exists(fn): os.remove(fn)
            for o, bb in todo[k]:
                need[o['key']] -= 1
                if need[o['key']] == 0:
                    a = np.concatenate(parts.pop(o['key'])) if parts.get(o['key']) else np.zeros((0, 5))
                    np.savez_compressed(PTS + o['key'] + '.npz', p=a.astype(np.float64), reg=o['reg'])
            print(f'  tile {done + 1}/{len(keys)} {k} {time.time() - t0:.0f}s', flush=True)


def measure():
    from shapely.geometry import LineString, Point
    from shapely.ops import unary_union
    import shapely
    r = route(); S1 = np.load(OUT + 'survey_1m.npz')
    out, rep = [], []
    for o in structures(set(SRC)):
        fn = PTS + o['key'] + '.npz'
        if not os.path.exists(fn): continue
        a = np.load(fn)['p']
        if not len(a): continue
        S = SRC[o['reg']]; t = Transformer.from_crs('EPSG:32633', S['crs'], always_xy=True)
        Q, sq, Nq = window(o, r, S1)
        qx, qy = t.transform(Q[:, 0], Q[:, 1]); Qc = np.c_[qx, qy]
        line = LineString(Qc)
        # chainage and offset of every point along the driving line (left +)
        P2 = shapely.points(a[:, 0], a[:, 1])
        sp = shapely.line_locate_point(line, P2)
        cum = np.r_[0, np.cumsum(np.hypot(*np.diff(Qc, axis=0).T))]
        j = np.clip(np.searchsorted(cum, sp) - 1, 0, len(Qc) - 2)
        tx = Qc[j + 1] - Qc[j]; tx /= np.maximum(np.hypot(tx[:, 0], tx[:, 1]), 1e-9)[:, None]
        base = Qc[j] + tx * (sp - cum[j])[:, None]
        dv = a[:, :2] - base; d = tx[:, 0] * dv[:, 1] - tx[:, 1] * dv[:, 0]
        sa = sq[0] + sp
        L = [np.c_[t.transform(*np.asarray(l, float).T)] for l in o['lines']]
        fp = unary_union([LineString(l).buffer(o.get('width', 8) / 2 + 0.5, cap_style=2) for l in L if len(l) >= 2])
        infp = shapely.contains(fp, P2)
        # the deck's extent along the route over the band
        cen = shapely.points(base[:, 0], base[:, 1])
        sfp = sa[infp & (np.abs(d) < WIDE)]
        if not len(sfp): rep.append((o, 'no points in footprint')); continue
        fa, fb = np.percentile(sfp, 1), np.percentile(sfp, 99)
        cls = a[:, 3].astype(int)
        g = np.isin(cls, (2, 11)) & (np.abs(d) < WIDE) & (np.abs(sa) <= ALONG)      # ground, road surface
        gout = g & ((sa < fa - 1) | (sa > fb + 1))
        if gout.sum() < 30: rep.append((o, 'too few road points')); continue
        ss, zz = sa[gout], a[gout, 2]
        # the road: the lower envelope of the ground points per 2 m (ballast on a railway deck or a tunnel's lid can be
        # classed as ground too, above the road), a robust line or parabola through it; a step in it (a covered section,
        # a cutting under a lid) leaves the road under the structure undetermined
        bi = np.floor(ss / 2).astype(int); bx, bz = [], []
        for k_ in np.unique(bi):
            v = zz[bi == k_]
            if len(v) >= 5: bx.append(k_ * 2 + 1.0); bz.append(float(np.percentile(v, 10)))
        bx, bz = np.array(bx), np.array(bz)
        if len(bx) < 6: rep.append((o, 'too few road points')); continue
        k = bz <= np.percentile(bz, 30) + 1.0                      # start from the low bins: a deck or lid classed as ground is above
        for _ in range(6):
            deg = 2 if (bx[k].min() < fa - 5 and bx[k].max() > fb + 5 and k.sum() >= 8) else 1
            c = np.polyfit(bx[k], bz[k], deg); res = bz - np.polyval(c, bx)
            sd = max(0.04, 1.4826 * np.median(np.abs(res[k]))); k = np.abs(res) < 3 * sd
        bad_road = k.sum() < 6 or sd > 0.25 or (bx[k].max() < fb + 1) or (bx[k].min() > fa - 1)     # road on both sides of the deck
        rp = np.abs(zz - np.polyval(c, ss)) < 0.3
        road_sd = float(np.std(zz[rp] - np.polyval(c, ss[rp]))) if rp.sum() > 10 else float(sd)
        zr = np.polyval(c, sa)
        # the route itself on a viaduct: along the driving line, away from the deck, most of the points lie well above the
        # ground fit (the ground under the viaduct is what was fitted), so nothing found here is over the convoy
        ob = (np.abs(d) < BAND) & (np.abs(sa) <= ALONG) & ((sa < fa - 3) | (sa > fb + 3))
        bo = np.floor(sa[ob] / 2).astype(int); zo = a[ob, 2] - zr[ob]; hi_, nb_ = 0, 0
        for k_ in np.unique(bo):
            v = zo[bo == k_]
            if len(v) >= 10: nb_ += 1; hi_ += np.median(v) > 2.5
        gr = g & (np.abs(d) < BAND) & (np.abs(a[:, 2] - zr) < 0.3)              # the fitted level seen densely: the route's own road
        bg = np.floor(sa[gr] / 2).astype(int); dense = int((np.bincount(bg - bg.min()) >= 30).sum()) if gr.any() else 0
        on_viaduct = nb_ >= 6 and hi_ > 0.6 * nb_ and dense < 3
        h = a[:, 2] - zr
        st = infp & ~np.isin(cls, (2, 7, 11, 18)) & (h > 2.0) & (h < 40)
        def lowest(band, base=None):
            """the deck over the band: metres along the route where the structure's points span the driving line (both sides),
            their median height the deck top; then the points below the deck in those metres that hang together with it
            (fascia, edge girders, underside): their lowest point, if any"""
            m = (st if base is None else base) & (np.abs(d) <= band)
            if m.sum() < 5: return None
            sm_, hm, dm = sa[m], h[m], d[m]
            sb = np.floor(sm_).astype(int); surf = {}
            for k_ in np.unique(sb):
                q = sb == k_
                if q.sum() >= 3 and dm[q].min() < -0.8 and dm[q].max() > 0.8:
                    surf[k_] = float(np.percentile(hm[q], 50))
            surf = {k_: v for k_, v in surf.items() if v > 3.5}
            if not surf: return None
            top = float(np.median(list(surf.values())))
            surf = {k_: v for k_, v in surf.items() if abs(v - top) < 1.5}          # a deck, not trees or a building beside it
            sf = np.array([surf.get(k_, np.nan) for k_ in sb])
            below = np.isfinite(sf) & (hm < sf - 0.25)
            low, n_below = None, 0
            if below.any():                                       # runs downward from the surface, broken by a gap of air
                cs, cd = np.floor(sm_ / 0.5).astype(int), np.floor(dm / 0.5).astype(int)
                from collections import defaultdict
                cols = defaultdict(list)
                for ci, di, hh, ff in zip(cs, cd, hm, sf):
                    if np.isfinite(ff): cols[(ci, di)].append((hh, ff))
                for v in cols.values():
                    v = sorted(v, reverse=True); lo = None; prev = v[0][1]
                    for hh, ff in v:
                        if hh >= ff - 0.25: prev = min(prev, hh); continue
                        if prev - hh > GAP: break
                        prev = hh; lo = hh; n_below += 1
                    if lo is not None and (low is None or lo < low): low = lo
            return dict(low=None if (low is None or n_below < 4) else float(low), top=top, n_below=n_below, n=int(m.sum()), deck=len(surf), s0=float(min(surf)), s1=float(max(surf) + 1))
        R = lowest(BAND); W = lowest(WIDE)
        if R is None or R['deck'] < 3:                                  # the map's deck line may be off: any deck over the band near the crossing
            alt = ~np.isin(cls, (2, 7, 11, 18)) & (h > 3.5) & (h < 40) & (np.abs(sa) <= 15)
            R2 = lowest(BAND, alt)
            if R2 is not None and R2['deck'] >= 3: R, W = R2, lowest(WIDE, alt); print(f"  {o['s0'] / 1000:.2f}: deck found off the mapped footprint", flush=True)
        gm = float(np.median(a[:, 4])) if len(a) else 0                  # adjusted GPS time → date (GPS week seconds: no date)
        date = time.strftime('%Y-%m', time.gmtime(gm + 1e9 + 315964800 - 18)) if gm > 1e7 or gm < -1e7 else {'DE-BB': 'Brandenburg, LGB'}.get(o['reg'])
        if on_viaduct: R = None
        if R is not None and R['deck'] >= 3 and not bad_road:       # road seen beyond both ends of the deck found, else a covered section
            out_ = (bx < R['s0'] - 2) | (bx > R['s1'] + 2)
            high = out_ & (bz - np.polyval(c, bx) > 1.5)               # ground well above the road beside the deck: a lid, a cutting's edge
            bad_road = (k & (bx < R['s0'] - 0.5)).sum() < 3 or (k & (bx > R['s1'] + 0.5)).sum() < 3 or high.sum() >= 3
        if bad_road and R is not None and R['deck'] >= 3:               # a structure, but the road under it is not in the data
            out.append(dict(s0=o['s0'], reg=o['reg'], cls=o['cls'], sub=o['sub'], name=o.get('name'), found=True, s=o['s0'], top=None, est=None,
                            src=f'laser point cloud ({date})', laz=dict(undetermined=True, date=date)))
            print(f"{o['s0'] / 1000:8.2f} {o['sub']}/{o['cls']:13s} {str(o.get('name') or ''):26s} road under the structure not in the data (covered section?) [inl {k.sum()}/{len(k)} sd {sd:.2f} road {bx[k].min():.0f}..{bx[k].max():.0f} deck {fa:.0f}..{fb:.0f}]", flush=True)
            continue
        if R is None or R['deck'] < 3:                                  # no deck over the convoy: the map's crossing is beside / under the route
            out.append(dict(s0=o['s0'], reg=o['reg'], cls=o['cls'], sub=o['sub'], name=o.get('name'), found=True, s=o['s0'], top=None, est=None,
                            src=f'laser point cloud ({date})', laz=dict(none=True, date=date)))
            print(f"{o['s0'] / 1000:8.2f} {o['sub']}/{o['cls']:13s} {str(o.get('name') or ''):26s} no deck over the road in the point cloud", flush=True)
            continue
        from route_clearance import depth_of
        dep, dunc = depth_of(o['sub'], o['cls'])
        # conservative: the deck top less the larger of a typical depth and the depth seen (a partly seen side face only shows
        # that the deck is at least that deep; it never makes the clear height larger)
        dobs = (R['top'] - R['low']) if R['low'] is not None else 0.0
        seen = dobs >= dep
        est = R['top'] - max(dep, dobs)
        unc = max(0.08, road_sd * 2) if seen else round(min(0.6, dunc), 2)
        rec = dict(s0=o['s0'], reg=o['reg'], cls=o['cls'], sub=o['sub'], name=o.get('name'), found=True, s=o['s0'], length=round(float(fb - fa), 1),
                   top=round(R['top'], 2), top_med=round(R['top'], 2), est=round(est, 2), unc=round(unc, 2), depth=round(max(dep, dobs), 2),
                   covered=1.0, src=('laser point cloud, lowest point of the structure seen' if seen else 'laser point cloud: deck top above the road minus a typical deck depth') + f' ({date})',
                   laz=dict(top=round(R['top'], 2), low=round(R['low'], 2) if R['low'] is not None else None, low_wide=round(W['low'], 2) if W and W['low'] is not None else None, n_below=R['n_below'], n=R['n'], road_sd=round(road_sd, 3), seen=seen, date=date))
        out.append(rec)
        print(f"{o['s0'] / 1000:8.2f} {o['sub']}/{o['cls']:13s} {str(o.get('name') or ''):26s} clear {est:5.2f} m {'seen' if seen else 'top-depth'}"
              f"  (deck top {R['top']:5.2f}, below-deck points {R['n_below']}, road sd {road_sd:.2f}, {date})", flush=True)
    for o, why in rep: print(f"  skipped {o['s0'] / 1000:8.2f} {o['cls']}: {why}")
    json.dump({'mapped': out, 'scan': []}, open(OUT + 'clear_laz.json', 'w'))
    print(len(out), 'structures;', sum(1 for q in out if q['laz'].get('none')), 'without a deck over the road;', sum(1 for q in out if q['laz'].get('undetermined')), 'road not determinable;', sum(1 for q in out if q['laz'].get('seen')), 'with the underside seen')


if __name__ == '__main__':
    if sys.argv[1] == 'extract': extract(set(sys.argv[2:]) or set(SRC))
    else: measure()
