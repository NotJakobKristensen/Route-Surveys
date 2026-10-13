"""Find the route's difficult passages from the survey alone (no reports, no local knowledge) → the survey points.

Every 10 m of the route gets a severity from the measured data:
  wheels   the convoy's wheel units beyond the carriageway edge traced on the aerial photo (route_survey_line):
           > 0.5 m difficult (3), > 0.1 m needs care (2), less than 0.3 m to spare (1)
  blade    the blade's overswing beyond the edge: > 10 m (2), > 4 m (1) — verges, trees, signs and buildings there
           are checked in the passage
  lane     the convoy needs the oncoming lane (escort holds traffic) by more than 1 m (1)
  height   a structure over the road whose estimated clear height (route_clearance) leaves less than 0.2 m over the
           transport height (3) or less than 0.5 m (2)
  turn     a junction or bend tighter than 40 m radius on a public road (1)
Runs of rows with severity ≥ 2, or ≥ 1 over 100 m, are joined across gaps under 300 m; each run is scored by the sum of
its squared severities. The start (leaving the yard) and the end (the last kilometres to the crane pad) are always
surveyed. The best-scored runs in regions with official survey-grade data (aerial photo 20 cm, laser terrain, LoD2:
Poland, Bavaria, Baden-Württemberg) become the survey points; the others are listed as findings for the road view.
Usage: python route_findhot.py [N]   → route_config.json 'hot' / 'hot_regions' and <cache>/hot_auto.json (reasons)
DRY=1: print only."""
import json, os, pickle, sys
import numpy as np
from pyproj import Transformer
import routecfg
from route_corridor import route, OUT, load_clear
from route_swept import V

HD_REGIONS = ('PL-32', 'DE-BY', 'DE-BW', 'DE-BB', 'DE-MV', 'DE-ST')
HEIGHT = float(routecfg.get('transport_height', 4.7))


def rows():
    r = route(); s = r['s']
    S = np.load(OUT + 'survey.npz')
    s10 = S['s10'].astype(float); n = len(s10)
    sev = np.zeros(n, np.int8); why = [set() for _ in range(n)]
    have = np.nan_to_num(S['have']) > 0.5
    wo = np.nan_to_num(S['wo']); wm = np.where(np.isfinite(S['wm']), S['wm'], 9.0); b = np.nan_to_num(np.fmax(S['bL'], S['bR']))
    def put(m, v, w):
        for i in np.where(m)[0]:
            if v >= sev[i]: why[i].add(w)
        sev[m] = np.maximum(sev[m], v)
    put(have & (wo > 0.5), 3, 'wheels off the road'); put(have & (wo > 0.1) & (wo <= 0.5), 2, 'wheels at the edge')
    put(have & (wm < 0.3) & (wo <= 0.1), 1, 'little wheel clearance')
    put(have & (b > 10), 2, 'blade far over the verge'); put(have & (b > 4) & (b <= 10), 1, 'blade over the verge')
    if os.path.exists(OUT + 'lanes_1m.npz'):
        Lz = np.load(OUT + 'lanes_1m.npz'); acw = np.nan_to_num(Lz['acw'].astype(float)); tw = Lz['tw']
        k = np.minimum((np.arange(n) * 10), len(acw) - 1)
        a10 = np.array([np.nanmax(acw[i:i + 10]) for i in k]); t10 = tw[k]
        put(t10 & (a10 > 1.0), 1, 'oncoming lane needed')
    Rc = np.nan_to_num(S['Rc'], nan=1e6)
    Ru = pickle.load(open(routecfg.C + 'route.pkl', 'rb'))
    cls = np.array([Ru[k][0]['cls'] for k in range(len(Ru))])[r['SEG'][np.minimum(np.arange(n) * 10, len(s) - 1)]]
    public = ~np.isin(cls, ['service', 'track', 'unknown'])
    put(public & (Rc < 40) & have, 1, 'tight turn')
    # structures over the road, as the road view rates them: below the transport height + margin even at the top of the
    # estimate's range → probably too low (3); the range reaching below it → check (2). Records where the route itself is
    # on the structure (top under 3.5 m) or on its own bridge are left out, as in the road view.
    need = HEIGHT + float(routecfg.get('height_margin', 0.1))
    own = []
    if os.path.exists(OUT + 'bridges.pkl'):
        own = [(rb['s0'] - 5, rb['s1'] + 5) for rb in (pickle.load(open(OUT + 'bridges.pkl', 'rb')).get('route') or [])]
    hbonus = np.zeros(n)
    for c in load_clear()['mapped']:
        if not c.get('found') or c.get('est') is None or c.get('top', 9) < 3.5: continue
        if any(a <= c['s'] <= b for a, b in own): continue
        i = int(np.clip(np.searchsorted(s10, c['s']), 0, n - 1)); unc = c.get('unc', 0.5)
        if c['est'] + unc < 4.0:              # unsigned, below what every lorry may be (4.0 m): the measurement, not the structure
            put(np.arange(n) == i, 2, f"clear height ≈ {c['est']:.1f} m (implausible, check)"); hbonus[i] = max(hbonus[i], 12); continue
        if c['est'] + unc < need: put(np.arange(n) == i, 3, f"clear height ≈ {c['est']:.1f} m (probably too low)"); hbonus[i] = 40
        elif c['est'] - unc < need: put(np.arange(n) == i, 2, f"clear height ≈ {c['est']:.1f} m (check)"); hbonus[i] = max(hbonus[i], 12)
    rows.hbonus = hbonus
    return s10, sev, why, cls


def runs(s10, sev):
    """runs of difficult rows joined across gaps < 300 m"""
    idx = np.where(sev >= 1)[0]
    out = []
    if not len(idx): return out
    a = b = idx[0]
    for i in idx[1:]:
        if s10[i] - s10[b] > 300: out.append((a, b)); a = i
        b = i
    out.append((a, b))
    keep = []
    for a, b in out:
        sv = sev[a:b + 1]
        if sv.max() >= 2 or (sv >= 1).sum() * 10 >= 100: keep.append((a, b))
    return keep


def places():
    """localities near the route (Overture divisions) for the titles: [(x, y, name)] in UTM 33"""
    import overture as ov
    r = route(); P = r['P']
    tr = Transformer.from_crs('EPSG:32633', 'EPSG:4326', always_xy=True); fw = Transformer.from_crs('EPSG:4326', 'EPSG:32633', always_xy=True)
    lon, lat = tr.transform(P[::2000, 0], P[::2000, 1])
    from shapely import wkb
    out = []
    t = ov.query('divisions', 'division', (lon.min() - .05, lat.min() - .05, lon.max() + .05, lat.max() + .05), columns=['subtype', 'names', 'geometry', 'population'])
    for q in t.to_pylist():
        if q['subtype'] not in ('locality', 'localadmin'): continue
        nm = (q['names'] or {}).get('primary')
        if not nm: continue
        g = wkb.loads(q['geometry']); x, y = fw.transform(g.x, g.y)
        out.append((x, y, nm, q.get('population') or 0))
    return out


def title_of(a_s, b_s, Ru, r, PL):
    s = r['s']; P = r['P']
    ia, ib = int(np.searchsorted(s, a_s)), min(len(s) - 1, int(np.searchsorted(s, b_s)))
    def road(i):
        info = Ru[r['SEG'][i]][0]
        refs = [x.strip() for x in (info.get('ref') or '').split(';') if x.strip()]
        refs = [x[x.index('(') + 1:x.rindex(')')] if x.startswith('TMC') and '(' in x else x for x in refs]     # 'TMC 33388 (St 2047)'
        refs = [x for x in refs if not x.startswith(('E ', 'TMC'))]
        refs = sorted(refs, key=lambda x: (x[:1].isdigit(), x))
        return (refs[0] if refs else '') or info.get('name') or {'track': 'forest track', 'service': 'access road', 'unclassified': 'minor road', 'motorway': 'motorway', 'residential': 'town street', 'unknown': 'yard road'}.get(info['cls'], info['cls'] + ' road')
    seq = []
    for i in range(ia, ib + 1, 50):
        rd = road(i)
        if not seq or seq[-1] != rd: seq.append(rd)
    mid = (ia + ib) // 2
    nearest = min(PL, key=lambda p: (p[0] - P[mid, 0]) ** 2 + (p[1] - P[mid, 1]) ** 2) if PL else None
    place = nearest[2] if nearest else ''
    GEN = ('road', 'track', 'street', 'motorway')
    named = [x for x in seq if x and not x.endswith(GEN)]
    seq = named if named else [x for x in seq if x]
    seq = [x for k, x in enumerate(seq) if k == 0 or x != seq[k - 1]][:2]
    main = ' → '.join(seq) if len(seq) > 1 else (seq[0] if seq else 'road')
    d = np.hypot(nearest[0] - P[mid, 0], nearest[1] - P[mid, 1]) if nearest else 1e9
    return f"{main} {'at' if d < 1500 else 'near'} {place}".strip()


if __name__ == '__main__':
    N = int(sys.argv[1]) if len(sys.argv) > 1 else 10
    r = route(); s = r['s']; P = r['P']
    s10, sev, why, cls = rows()
    REG = pickle.load(open(OUT + 'regions.pkl', 'rb'))['lab']
    reg_at = lambda sv: (lambda q: 'DE-BB' if q == 'DE-BE' else q)(REG[min(len(REG) - 1, int(sv // 500))])
    Ru = pickle.load(open(routecfg.C + 'route.pkl', 'rb'))
    PL = places()
    cand = []
    for a, b in runs(s10, sev):
        sv = sev[a:b + 1].astype(int)
        score = float((sv ** 2).sum() + 20 * sv.max() + rows.hbonus[a:b + 1].sum())
        reasons = sorted(set().union(*why[a:b + 1]))
        cand.append(dict(a=float(s10[a]), b=float(s10[b]), score=score, max=int(sv.max()), reasons=reasons, reg=reg_at((s10[a] + s10[b]) / 2)))
    total = float(s[-1])
    first = dict(a=0.0, b=min(3500.0, total), score=1e9, max=int(sev[:350].max()), reasons=['leaving the yard'] + sorted(set().union(*why[:350])), reg=reg_at(0), fixed='start')
    last = dict(a=max(0.0, total - 3500.0), b=total, score=1e9, max=int(sev[-350:].max()), reasons=['the last kilometres to the crane pad'] + sorted(set().union(*why[-350:])), reg=reg_at(total - 1), fixed='end')
    # runs inside the fixed windows belong to them
    cand = [c for c in cand if not (c['b'] < first['b'] + 200 or c['a'] > last['a'] - 200)]
    cand.sort(key=lambda c: -c['score'])
    # a passage needs the geometry against it or a structure probably too low; a clear height to check, or an oncoming
    # lane alone, stays a road-view finding (the gate and the lane plan show it there)
    strong = lambda c: any(not w.startswith('clear height') and w != 'oncoming lane needed' for w in c['reasons']) or any('probably too low' in w for w in c['reasons'])
    # every difficult stretch becomes a passage (ALL_REGIONS=0: only where survey-grade official data exist); outside those
    # regions (Saxony, Thuringia: no reachable 1 m terrain service) the passage is built from the open European data
    pool = [c for c in cand if (os.environ.get('ALL_REGIONS', '1') != '0' or c['reg'] in HD_REGIONS) and c['max'] >= 2 and strong(c)]
    if routecfg.get('passages') == 'all':        # every difficult stretch: also clear heights to check, the oncoming lane over 100 m
        onlyh = lambda c: all(w.startswith('clear height') for w in c['reasons'])
        pool = [c for c in cand if not (onlyh(c) and c['max'] < 3)]      # a clear height only to check stays a road-view finding
    def merge(chosen):
        merged = []
        for c in chosen:
            p = merged[-1] if merged else None
            if p and c['a'] - p['b'] < 2000 and (c.get('fixed') == 'end' and total - p['a'] < 6000 or c['b'] - p['a'] < 4000) and p.get('fixed') != 'start':
                q = dict(c if c.get('fixed') else p); q['a'] = p['a']; q['b'] = max(p['b'], c['b']); q['max'] = max(p['max'], c['max'])
                q['reasons'] = sorted(set(p['reasons']) | set(c['reasons'])); q['score'] = p['score'] + c['score']; merged[-1] = q
            else: merged.append(dict(c))
        return merged
    k = max(0, N - 2)
    while True:                                   # the best runs until N passages remain after joining neighbours
        hd = pool[:k]
        chosen = merge(sorted([first] + hd + [last], key=lambda c: c['a']))
        if len(chosen) >= N or k >= len(pool): break
        k += 1
    other = [c for c in cand if c not in hd and c['max'] >= 1]
    hot, hot_reg, rep = [], {}, []
    tr = Transformer.from_crs('EPSG:32633', 'EPSG:4326', always_xy=True)
    used = set()
    # a difficult stretch longer than 4 km becomes several passages of equal length (the last passage runs to the crane pad)
    wins = []
    for c in chosen:
        a_s = max(0.0, c['a'] - (0 if c.get('fixed') == 'start' else 250)); b_s = min(total, c['b'] + (0 if c.get('fixed') == 'end' else 150))
        if b_s - a_s < 800: m = (a_s + b_s) / 2; a_s, b_s = max(0, m - 400), min(total, m + 400)
        if c.get('fixed') == 'end' or b_s - a_s <= 4000: wins.append((c, a_s, b_s)); continue
        n_ = int(np.ceil((b_s - a_s) / 4000)); L_ = (b_s - a_s) / n_
        for q in range(n_):
            qa, qb = a_s + q * L_, a_s + (q + 1) * L_
            m_ = (s10 >= qa) & (s10 <= qb); cq = dict(c)
            if q: cq.pop('fixed', None)
            if m_.any() and not cq.get('fixed'):
                cq['max'] = int(sev[m_].max()); cq['reasons'] = sorted(set().union(*[why[i] for i in np.nonzero(m_)[0]])) or c['reasons']
            wins.append((cq, qa, qb))
    for c, a_s, b_s in wins:
        i = int(np.searchsorted(s, a_s)); lon, lat = tr.transform(P[i, 0], P[i, 1])
        ttl = title_of(a_s, b_s, Ru, r, PL)
        if c.get('fixed') == 'start': ttl = routecfg.get('start_title', 'Leaving the yard') + (' · ' + ttl.split(' at ')[-1].split(' near ')[-1] if (' at ' in ttl or ' near ' in ttl) else '')
        if c.get('fixed') == 'end': ttl = ttl + ' → crane pad'
        tl = title_of(a_s, b_s, Ru, r, PL).lower()             # the id from the place (before the start / end wording)
        for x_, y_ in (('ä', 'ae'), ('ö', 'oe'), ('ü', 'ue'), ('ß', 'ss'), ('ł', 'l'), ('ó', 'o'), ('ą', 'a'), ('ę', 'e'), ('ś', 's'), ('ć', 'c'), ('ń', 'n'), ('ż', 'z'), ('ź', 'z')): tl = tl.replace(x_, y_)
        base = ''.join(ch for ch in tl.split(' at ')[-1].split(' near ')[-1].split(' → ')[0] if (ch.isascii() and ch.isalnum()) or ch == ' ').strip().replace(' ', '-') or 'km'
        hid = (routecfg.get('id', 'r') + '-' + base)[:40]
        k = 2
        while hid in used: hid = f"{hid.rsplit('-', 1)[0] if k > 2 else hid}-{k}"; k += 1
        used.add(hid)
        hot.append([hid, ttl, round(lon, 6), round(lat, 6), None if c.get('fixed') == 'end' else round(b_s - a_s)])
        hot_reg[hid] = c['reg']
        rep.append(dict(id=hid, title=ttl, km=[round(a_s / 1000, 2), round(b_s / 1000, 2)], score=round(c['score']) if c['score'] < 1e8 else 'fixed', severity=c['max'], reasons=c['reasons'], region=c['reg']))
        print(f"{hid:34s} km {a_s / 1000:7.2f}–{b_s / 1000:7.2f}  sev {c['max']}  {ttl}  [{'; '.join(c['reasons'])}]")
    print('-- other findings (road view):')
    for c in other[:30]:
        print(f"   km {c['a'] / 1000:7.2f}–{c['b'] / 1000:7.2f} sev {c['max']} {c['reg']} {title_of(c['a'], c['b'], Ru, r, PL)} [{'; '.join(c['reasons'])}]")
    if not os.environ.get('DRY'):
        cfg_fn = os.path.join(routecfg.ROOT, 'route_config.json')
        cfg = json.load(open(cfg_fn)); cfg['hot'] = hot; cfg['hot_regions'] = hot_reg
        json.dump(cfg, open(cfg_fn, 'w'), ensure_ascii=False, indent=1)
        json.dump(dict(points=rep, other=[dict(km=[round(c['a'] / 1000, 2), round(c['b'] / 1000, 2)], severity=c['max'], region=c['reg'], reasons=c['reasons'],
                                              title=title_of(c['a'], c['b'], Ru, r, PL)) for c in other]),
                  open(routecfg.C + 'hot_auto.json', 'w'), ensure_ascii=False, indent=1)
