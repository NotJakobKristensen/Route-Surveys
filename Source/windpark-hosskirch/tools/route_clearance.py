"""Clear heights over the route: every structure crossing above the carriageway (bridges, footbridges, rail bridges,
sign gantries, canopies, overhanging trees) with
  - the signed limit where one is mapped (Overture / OSM maxheight on the route segment),
  - a measured estimate from the official surface and terrain models (height of the structure's top above the road,
    minus a typical structure depth for its kind), with its uncertainty,
  - the measured lateral position and length along the route.
Inputs: route (screen.npz), corridor survey (survey_1m.npz: edges, shift), Overture crossings (objects.pkl), the
regions (regions.pkl) and the elevation samplers (elev.py). → .cache/route/corr/clear.json"""
import json, math, os, pickle, sys
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from route_corridor import route, OUT, load_clear

# typical structure depth below the top surface (deck, girders, ballast) by the crossing's class, m, and its spread
DEPTH = {'rail': (1.5, 0.6), 'motorway': (1.5, 0.5), 'trunk': (1.4, 0.5), 'primary': (1.3, 0.45), 'secondary': (1.2, 0.4),
         'tertiary': (1.1, 0.4), 'unclassified': (1.0, 0.4), 'residential': (1.0, 0.4), 'service': (1.0, 0.4), 'track': (1.0, 0.4),
         'path': (0.8, 0.35), 'footway': (0.8, 0.35), 'cycleway': (0.8, 0.35), 'pedestrian': (0.8, 0.35), 'gantry': (1.8, 0.6), 'unknown': (1.2, 0.5)}


def depth_of(sub, cls):
    if sub == 'rail' or cls in ('standard_gauge', 'rail', 'light_rail', 'subway', 'tram', 'narrow_gauge'): return DEPTH['rail']
    return DEPTH.get(cls, DEPTH['unknown'])


def analyse(sampler, reg, s_mid, cls, sub, r, S1, half_len=28.0, coarse=False):
    """surface-minus-terrain over the convoy's band around route distance s_mid (m); returns a record or None"""
    s = r['s']; P = r['P']; N = r['N']
    i0 = int(np.searchsorted(s, s_mid - half_len)); i1 = int(np.searchsorted(s, s_mid + half_len))
    if i1 - i0 < 10: return None
    ii = np.arange(i0, i1)
    if coarse: ii = ii[::2]
    sh = S1['shift'][ii].astype(float)
    d = np.arange(-6.0, 6.01, 1.5) if coarse else np.arange(-7.0, 7.01, 0.5)
    X = P[ii, 0][:, None] + N[ii, 0][:, None] * (sh[:, None] + d[None])
    Y = P[ii, 1][:, None] + N[ii, 1][:, None] * (sh[:, None] + d[None])
    H = sampler(reg, X, Y)                # height above the terrain (m)
    if H is None or not np.isfinite(H).any(): return None
    H = np.nan_to_num(H)
    over = H > 2.2
    rows = np.where(over.mean(1) > 0.35)[0]          # positions where the structure spans most of the band
    st = 2 if coarse else 1                           # metres per row
    if not len(rows): return dict(found=False)
    # the crossing: longest run of such rows around the centre
    runs = np.split(rows, np.where(np.diff(rows) > 2)[0] + 1)
    run = min(runs, key=lambda q: abs((q[0] + q[-1]) / 2 - (len(ii) / 2)))
    top_rows = H[run]
    # top surface above the road per lateral offset: median of the rows where the structure is over that offset (a skewed
    # deck or a pier covers each offset at different rows); offsets the structure never covers are left out
    band = np.abs(d) <= 4.5                           # convoy band around the driving line (wheels + root adapter)
    tops = []
    for j in np.where(band)[0]:
        v = top_rows[:, j]; cov = v > 2.2
        tops.append(float(np.median(v[cov])) if cov.mean() >= 0.3 and cov.sum() >= 2 else np.nan)
    tops = np.array(tops); covered = float(np.isfinite(tops).mean())
    if not np.isfinite(tops).any(): return dict(found=False)
    top_min = float(np.nanmin(tops)); top_med = float(np.nanmedian(tops))
    dep, unc = depth_of(sub, cls)
    rec = dict(found=True, s=float(s[ii[run[0]]] + s[ii[run[-1]]]) / 2, length=float(len(run) * st), top=round(top_min, 2), top_med=round(top_med, 2),
               est=round(top_min - dep, 2), unc=unc, depth=dep, covered=round(covered, 2))
    return rec


def overhead_scan(sampler, reg, i0, i1, r, S1, step=2):
    """unmapped objects over the driving line: runs where the surface stands > 3 m above the terrain over the centre"""
    s = r['s']; P = r['P']; N = r['N']
    ii = np.arange(i0, i1, step)
    sh = S1['shift'][ii].astype(float)
    d = np.array([-2.0, 0.0, 2.0])
    X = P[ii, 0][:, None] + N[ii, 0][:, None] * (sh[:, None] + d[None]); Y = P[ii, 1][:, None] + N[ii, 1][:, None] * (sh[:, None] + d[None])
    H = np.nan_to_num(sampler(reg, X, Y))
    o = (H > 3.0).all(1)
    out = []
    if not o.any(): return out
    idx = np.where(o)[0]
    for g in np.split(idx, np.where(np.diff(idx) > 2)[0] + 1):
        L = len(g) * step
        if L > 80: continue                           # a tunnel / long canopy: reported separately
        out.append(dict(s=float(s[ii[g[0]]] + s[ii[g[-1]]]) / 2, length=float(L), top=round(float(np.median(H[g].min(1))), 2)))
    return out


def road_relative(reg, s_mid, length, r, S1, coarse=False):
    """height of the surface over the driving line above the road itself, the road's level taken from the terrain model
    5–20 m before and after the object (so a bridge carrying the route, whose deck the terrain model leaves out, reads
    ≈ 0 instead of its height above the valley floor). Returns (median, min over the run) in m, or None."""
    import elev
    s = r['s']; P = r['P']; N = r['N']
    h = max(2.0, length / 2)
    st = 2.0 if coarse else 1.0
    run = np.arange(s_mid - h, s_mid + h + 0.01, st)
    ends = np.r_[np.arange(s_mid - h - 20, s_mid - h - 4.9, st * 2), np.arange(s_mid + h + 5, s_mid + h + 20.1, st * 2)]
    ii = np.clip(np.searchsorted(s, np.r_[run, ends]), 0, len(s) - 1)
    sh = S1['shift'][ii].astype(float)
    X = P[ii, 0] + N[ii, 0] * sh; Y = P[ii, 1] + N[ii, 1] * sh
    S_, T_ = elev.surface_terrain(reg, X, Y)
    if S_ is None: return None
    S_ = np.asarray(S_, float); T_ = np.asarray(T_, float)
    nr = len(run); se = np.r_[run, ends]
    te, ss = T_[nr:], se[nr:]
    ok = np.isfinite(te)
    if ok.sum() < 3: return None
    a, b = np.polyfit(ss[ok], te[ok], 1)                 # the road's level through the run: a line through both ends
    rel = S_[:nr] - (a * run + b)
    rel = rel[np.isfinite(rel)]
    if not len(rel): return None
    return float(np.median(rel)), float(np.min(rel))


if __name__ == '__main__':
    import elev
    r = route(); s = r['s']
    S1 = np.load(OUT + 'survey_1m.npz')
    REG = pickle.load(open(OUT + 'regions.pkl', 'rb'))['lab']
    regions = set(sys.argv[1:]) or set(elev.REGIONS)
    O = pickle.load(open(OUT + 'objects.pkl', 'rb'))['blocks']
    over = sorted([o for b in O.values() for o in b['over']], key=lambda o: o['s'])
    fn = OUT + os.environ.get('CLEAR_OUT', 'clear.json')
    res = json.load(open(fn)) if os.path.exists(fn) else {'mapped': [], 'scan': []}
    done = {(round(x['s0'])) for x in res['mapped'] + load_clear()['mapped']}
    reg_of = lambda sv: (lambda q: 'DE-BB' if q == 'DE-BE' else q)(REG[min(len(REG) - 1, int(sv // 500))])
    for o in over:
        reg = reg_of(o['s'])
        if reg not in regions or round(o['s']) in done: continue
        if not S1['have'][min(len(s) - 1, int(np.searchsorted(s, o['s'])))]: continue
        try:
            a = analyse(elev.above_ground, reg, o['s'], o['cls'], o['sub'], r, S1, coarse=reg in elev.COARSE)
        except Exception as ex:
            print('  fail', round(o['s'] / 1000, 2), repr(ex)); continue
        rec = dict(s0=o['s'], reg=reg, cls=o['cls'], sub=o['sub'], name=o['name'], **(a or {'found': False}))
        res['mapped'].append(rec)
        print(f"{o['s'] / 1000:8.2f} {reg} {o['sub']}/{o['cls']:14s} {o['name'] or '':22s} top {rec.get('top')} est {rec.get('est')}", flush=True)
        if len(res['mapped']) % 10 == 0: json.dump(res, open(fn, 'w'))
    json.dump(res, open(fn, 'w'))
    if os.environ.get('VERIFY'):                      # heights above the road itself for every record → rel_clear.json
        import concurrent.futures as cf
        fr = OUT + 'rel_clear.json'
        rel = json.load(open(fr)) if os.path.exists(fr) else {}
        C = load_clear(); jobs = []
        for m in C['mapped']:
            if m.get('found') and f"m{round(m['s0'])}" not in rel: jobs.append((f"m{round(m['s0'])}", m['reg'], m['s'], max(6.0, m['length'])))
        for q in C['scan']:
            if f"s{q['reg']}{round(q['s'])}" not in rel: jobs.append((f"s{q['reg']}{round(q['s'])}", q['reg'], q['s'], q['length']))
        print('verify', len(jobs), flush=True)
        def one(j):
            try: return j[0], road_relative(j[1], j[2], j[3], r, S1, coarse=j[1] in elev.COARSE)
            except Exception as ex: print('  verify fail', j, repr(ex)); return j[0], None
        with cf.ThreadPoolExecutor(3) as ex:
            for n_, (k, v) in enumerate(ex.map(one, jobs)):
                if v is not None: rel[k] = [round(v[0], 2), round(v[1], 2)]
                if n_ % 50 == 0: json.dump(rel, open(fr, 'w')); print(' ', n_, flush=True)
        json.dump(rel, open(fr, 'w')); print('verified', len(rel)); sys.exit(0)
    if os.environ.get('REANALYSE'):                   # all mapped crossings again with the current analysis → clear_fix.json
        import concurrent.futures as cf
        fx = OUT + 'clear_fix.json'
        res2 = json.load(open(fx)) if os.path.exists(fx) else {'mapped': [], 'scan': []}
        have = {round(x['s0']) for x in res2['mapped']}
        jobs = [o for o in over if round(o['s']) not in have and reg_of(o['s']) in regions and S1['have'][min(len(s) - 1, int(np.searchsorted(s, o['s'])))]]
        print('reanalyse', len(jobs), flush=True)
        def one(o):
            reg = reg_of(o['s'])
            try: a = analyse(elev.above_ground, reg, o['s'], o['cls'], o['sub'], r, S1, coarse=reg in elev.COARSE)
            except Exception as ex: print('  fail', round(o['s'] / 1000, 2), repr(ex)); return None
            return dict(s0=o['s'], reg=reg, cls=o['cls'], sub=o['sub'], name=o['name'], **(a or {'found': False}))
        with cf.ThreadPoolExecutor(3) as ex:
            for k, rec in enumerate(ex.map(one, jobs)):
                if rec: res2['mapped'].append(rec)
                if k % 40 == 0: json.dump(res2, open(fx, 'w')); print(' ', k, flush=True)
        json.dump(res2, open(fx, 'w')); print('reanalysed', len(res2['mapped'])); sys.exit(0)
    if os.environ.get('SCAN_AT'):                     # re-scan given 400-sample windows: SCAN_AT=DE-BW:805677,827677
        reg, c0s = os.environ['SCAN_AT'].split(':')
        for c0 in map(int, c0s.split(',')):
            for q in overhead_scan(elev.above_ground, reg, c0, c0 + 400, r, S1):
                q['reg'] = reg; res['scan'].append(q)
        json.dump(res, open(fn, 'w')); print('rescanned', c0s); sys.exit(0)
    # scan the whole driving line in 5 km pieces
    for reg in sorted(regions):
        if reg in elev.COARSE or os.environ.get('SCAN', '1') != '1': continue
        ks = [k for k in range(len(REG)) if (('DE-BB' if REG[k] == 'DE-BE' else REG[k]) == reg)]
        if not ks: continue
        a = int(np.searchsorted(s, ks[0] * 500)); b = int(np.searchsorted(s, (ks[-1] + 1) * 500))
        if any(x.get('reg') == reg for x in res['scan'] + load_clear()['scan']): continue
        for c0 in range(a, b, 400):
            try:
                for q in overhead_scan(elev.above_ground, reg, c0, min(b, c0 + 400), r, S1):
                    q['reg'] = reg; res['scan'].append(q)
            except Exception as ex:
                print('  scan fail', reg, c0, repr(ex))
        json.dump(res, open(fn, 'w'))
        print('scan', reg, sum(1 for x in res['scan'] if x['reg'] == reg), flush=True)
