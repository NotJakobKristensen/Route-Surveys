"""The passages that show every trouble spot of the route scan (route_scan.mjs → corr/route_scan.json): a spot next to a
passage (within EXT m of its ends) extends it, the others become new passages — spots within JOIN m of each other share
one, up to MAXL m long — each from 250 m before its first trouble to 150 m after its last (at least 800 m). Titles and ids
as route_findhot.py makes them. A blade overhang that lies over a mapped road only (a junction mouth, a slip road) is road,
not verge: it needs no passage.
Usage: python route_scan_hot.py [scan.json]   → route_config.json 'hot' / 'hot_regions' (DRY=1: print only), and
<cache>/scan_hot.json (the plan: which spot went where)."""
import json, os, pickle, sys
import numpy as np
from pyproj import Transformer
import routecfg
from route_corridor import route, OUT
import route_findhot as FH

EXT, JOIN, MAXL, MAXEXT = 1500.0, 2000.0, 4000.0, 6500.0
BEFORE, AFTER, MINL = 250.0, 150.0, 800.0


def plan(scan):
    hdr = scan['passages']
    P = [dict(id=h['id'], a=h['km'][0] * 1000, b=h['km'][1] * 1000, a0=h['km'][0] * 1000, b0=h['km'][1] * 1000, spots=[]) for h in hdr]
    road_only = 'blade beyond the traced edge over a mapped road'
    spots = []
    for sp in scan['spots']:
        its = [i for i in sp['items'] if i['kind'] != road_only]
        if its: spots.append(dict(s=min(i['s'] for i in its), s1=max(i['s1'] for i in its), items=its))
    new = []
    for sp in spots:
        lo, hi = sp['s'] - BEFORE, sp['s1'] + AFTER
        best = None
        for p in P:
            gap = max(lo - p['b'], p['a'] - hi, 0.0)          # 0: overlapping
            if gap <= EXT and (best is None or gap < best[0]): best = (gap, p)
        if best and max(best[1]['b'], hi) - min(best[1]['a'], lo) <= MAXEXT:
            p = best[1]; p['a'] = min(p['a'], lo); p['b'] = max(p['b'], hi); p['spots'].append(sp); continue
        q = new[-1] if new else None
        if q and lo - q['b'] <= JOIN and hi - q['a'] <= MAXL: q['b'] = max(q['b'], hi); q['spots'].append(sp)
        else: new.append(dict(a=max(0.0, lo), b=hi, spots=[sp]))
    for q in new:
        if q['b'] - q['a'] < MINL: m = (q['a'] + q['b']) / 2; q['a'], q['b'] = max(0.0, m - MINL / 2), m + MINL / 2
    return P, new


if __name__ == '__main__':
    scan = json.load(open(sys.argv[1] if len(sys.argv) > 1 else routecfg.C + 'corr/route_scan.json'))
    P_, new = plan(scan)
    r = route(); s = r['s']; Pr = r['P']; total = float(s[-1])
    tr = Transformer.from_crs('EPSG:32633', 'EPSG:4326', always_xy=True)
    REG = pickle.load(open(OUT + 'regions.pkl', 'rb'))['lab']
    reg_at = lambda sv: (lambda q: 'DE-BB' if q == 'DE-BE' else q)(REG[min(len(REG) - 1, int(sv // 500))])
    Ru = pickle.load(open(routecfg.C + 'route.pkl', 'rb'))
    cfg_fn = os.path.join(routecfg.ROOT, 'route_config.json'); cfg = json.load(open(cfg_fn))
    old = {h[0]: h for h in cfg['hot']}
    anchor = lambda a: (lambda i: [round(float(v), 6) for v in tr.transform(Pr[i, 0], Pr[i, 1])])(int(np.clip(np.searchsorted(s, a), 0, len(s) - 1)))
    hot, regs, rep = [], dict(cfg.get('hot_regions', {})), []
    for p in P_:
        h = list(old[p['id']])
        if p['a'] != p['a0'] or p['b'] != p['b0']:
            lon, lat = anchor(p['a']); h[2], h[3] = lon, lat
            if h[4] is not None: h[4] = round(p['b'] - p['a'])
            rep.append(dict(id=p['id'], was=[round(p['a0'] / 1000, 3), round(p['b0'] / 1000, 3)], km=[round(p['a'] / 1000, 3), round(p['b'] / 1000, 3)], spots=p['spots']))
        hot.append((p['a'], h))
    PL = FH.places()
    used = {h[0] for _, h in hot}
    for q in new:
        ttl = FH.title_of(q['a'], q['b'], Ru, r, PL)
        tl = ttl.lower()
        for x_, y_ in (('ä', 'ae'), ('ö', 'oe'), ('ü', 'ue'), ('ß', 'ss'), ('ł', 'l'), ('ó', 'o'), ('ą', 'a'), ('ę', 'e'), ('ś', 's'), ('ć', 'c'), ('ń', 'n'), ('ż', 'z'), ('ź', 'z')): tl = tl.replace(x_, y_)
        base = ''.join(ch for ch in tl.split(' at ')[-1].split(' near ')[-1].split(' → ')[0] if (ch.isascii() and ch.isalnum()) or ch == ' ').strip().replace(' ', '-') or 'km'
        hid = (routecfg.get('id', 'r') + '-' + base)[:40]; k = 2
        while hid in used: hid = f"{hid.rsplit('-', 1)[0] if k > 2 else hid}-{k}"; k += 1
        used.add(hid)
        lon, lat = anchor(q['a'])
        hot.append((q['a'], [hid, ttl, lon, lat, round(q['b'] - q['a'])]))
        regs[hid] = reg_at((q['a'] + q['b']) / 2)
        rep.append(dict(id=hid, new=True, title=ttl, km=[round(q['a'] / 1000, 3), round(q['b'] / 1000, 3)], region=regs[hid], spots=q['spots']))
    hot.sort(key=lambda t: t[0])
    for r_ in rep: print(f"{r_['id']:40s} {'new ' if r_.get('new') else 'ext '} km {r_['km'][0]:8.3f}–{r_['km'][1]:8.3f}" + (f"  (was {r_['was'][0]}–{r_['was'][1]})" if r_.get('was') else f"  {r_.get('region')}  {r_.get('title')}"))
    print(len([r_ for r_ in rep if r_.get('new')]), 'new passages,', len([r_ for r_ in rep if not r_.get('new')]), 'extended; passages', len(hot))
    json.dump(rep, open(routecfg.C + 'scan_hot.json', 'w'), ensure_ascii=False, indent=1)
    if not os.environ.get('DRY'):
        cfg['hot'] = [h for _, h in hot]; cfg['hot_regions'] = regs
        json.dump(cfg, open(cfg_fn, 'w'), ensure_ascii=False, indent=1)
