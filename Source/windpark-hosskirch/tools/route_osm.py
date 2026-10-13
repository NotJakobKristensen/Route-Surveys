"""Detailed OpenStreetMap tags along the route, from overpass-api.de (the open map's live database):

  - height / weight / width / length / axle-load limits on the route's own ways (maxheight, maxweight, maxwidth,
    maxlength, maxaxleload, their :physical forms) and on barrier / sign nodes on it;
  - overhead power lines (power=line / minor_line, cables only where mapped overhead) and telecom lines that cross the
    route, with voltage, operator and name;
  - traffic islands (area:highway=traffic_island, traffic_calming=island, crossing:island), kerbs (barrier=kerb with
    kerb=*), bollards, gates and height restrictors within 30 m of the route.

Each feature gets its route chainage s (m) and lateral offset d (left +); crossing lines the chainage where they cross.
Overpass is asked over plain HTTP (its HTTPS endpoint resets through this environment's proxy; the data are public).
→ .cache/route/corr/osm_tags.json  {limits: [...], lines: [...], points: [...], areas: [...], date}
→ .cache/route/corr/limits.json    the signed height limits on the route (read by route_pack.py / route_signs.py)
Usage: python route_osm.py            (ONLY=a-b: a chainage range in m)"""
import routecfg
import json, os, re, sys, time, urllib.request, urllib.parse
import numpy as np
from pyproj import Transformer
from scipy.spatial import cKDTree
from route_corridor import route, OUT

URL = os.environ.get('OVERPASS', 'http://overpass-api.de/api/interpreter')
STEP = 3000                      # route metres per query (small, quick queries get a slot sooner)
CACHE = routecfg.C + 'osm/'      # one answer per stretch, so a run resumes
os.makedirs(CACHE, exist_ok=True)
to_ll = Transformer.from_crs('EPSG:32633', 'EPSG:4326', always_xy=True)
to_u = Transformer.from_crs('EPSG:4326', 'EPSG:32633', always_xy=True)


def num(v, unit='m'):
    """a limit value in m or t ('4.0', '4 m', '13\\'1"', '7.5 t', '7500 kg'); None for none / default / signs only"""
    if v is None: return None
    v = str(v).strip().lower().replace(',', '.')
    m = re.match(r"^(\d+)'(\d+)\"?$", v)
    if m: return round(int(m[1]) * 0.3048 + int(m[2]) * 0.0254, 2)
    m = re.match(r'^([\d.]+)\s*(m|t|kg|st)?$', v)
    if not m: return None
    x = float(m[1])
    if m[2] == 'kg': x /= 1000
    return x if x > 0 else None


def query(poly):
    ll = ' '.join(f'{la:.6f} {lo:.6f}' for lo, la in poly)
    q = f"""[out:json][timeout:180];
(
 way(around:12,{ll.replace(' ', ',')})[highway][~"^(maxheight|maxheight:physical|maxweight|maxweightrating|maxwidth|maxwidth:physical|maxlength|maxaxleload|hgv)$"~"."];
 node(around:30,{ll.replace(' ', ',')})[~"^(maxheight|maxheight:physical|maxweight|maxwidth|barrier|traffic_calming|crossing:island|kerb)$"~"."];
 way(around:30,{ll.replace(' ', ',')})[~"^(area:highway|traffic_calming|barrier)$"~"^(traffic_island|island|kerb|height_restrictor|bollard|gate|jersey_barrier)$"];
 way(around:30,{ll.replace(' ', ',')})[power~"^(line|minor_line|cable)$"];
 way(around:30,{ll.replace(' ', ',')})[telecom=line];
 way(around:30,{ll.replace(' ', ',')})[communication=line];
);
out tags geom;"""
    # the polyline as "lat,lon,lat,lon,…" for around: the ll string above already alternates lat lon
    for a in range(400):
        try:
            req = urllib.request.Request(URL, data=urllib.parse.urlencode({'data': q}).encode(), headers={'User-Agent': 'route-survey (open-data transport study)'})
            return json.loads(urllib.request.urlopen(req, timeout=240).read())['elements']
        except Exception as ex:
            # busy (503 / 429 / 504): the shared address's slots are taken; try again shortly
            wait = 4 + (a % 4) * 3 + (20 if a > 20 else 0)
            print('  overpass busy', a, repr(ex)[:60], f'waiting {wait}s', flush=True); time.sleep(wait)
    raise RuntimeError('overpass not reachable')


def main():
    r = route(); P, s, N = r['P'], r['s'], r['N']
    kd = cKDTree(P)
    import glob
    def cached():
        return [tuple(map(int, os.path.basename(f)[:-5].split('_'))) for f in glob.glob(CACHE + '[0-9]*_[0-9]*.json')]
    ranges = [(0.0, float(s[-1]))]
    if os.environ.get('ONLY'): ranges = [tuple(map(float, r.split('-'))) for r in os.environ['ONLY'].split(',')]
    for ra, rb in ranges:
        i, hi_ = int(np.searchsorted(s, ra)), min(len(P) - 1, int(np.searchsorted(s, rb)))
        while i < hi_:
            done = [c for c in cached() if c[0] <= s[i] + 1 and c[1] > s[i]]
            if done: i = min(hi_, int(np.searchsorted(s, max(c[1] for c in done)))); continue
            j = min(hi_, i + int(STEP))
            nxt = [c[0] for c in cached() if s[i] < c[0] < s[j]]            # stop where a stretch answered before begins
            if nxt: j = int(np.searchsorted(s, min(nxt)))
            idx = np.arange(i, j + 1, 40)
            lo, la = to_ll.transform(P[idx, 0], P[idx, 1])
            got = query(list(zip(lo, la)))
            json.dump(got, open(CACHE + f'{int(s[i])}_{int(s[j])}.json', 'w')); time.sleep(1)
            print(f'  km {s[i] / 1000:6.1f}–{s[j] / 1000:6.1f}: {len(got)} features', flush=True)
            i = j
    # everything answered so far, whole route
    seen, els = set(), []
    for f in glob.glob(CACHE + '[0-9]*_[0-9]*.json'):
        for e in json.load(open(f)):
            if (e['type'], e['id']) not in seen: seen.add((e['type'], e['id'])); els.append(e)
    cov = sorted(cached()); km_cov = sum(b_ - a_ for a_, b_ in cov) / 1000
    print(f'{len(els)} features from {len(cov)} answered stretches ({km_cov:.0f} km of {s[-1] / 1000:.0f})')
    def onroute(x, y):
        dd, k = kd.query((x, y)); k = int(k)
        d = float((x - P[k, 0]) * N[k, 0] + (y - P[k, 1]) * N[k, 1])
        return float(s[k]), d, float(dd), k
    limits, lines, points, areas = [], [], [], []
    from shapely.geometry import LineString, Polygon
    for e in els:
        t = e.get('tags', {})
        if e['type'] == 'node':
            x, y = to_u.transform(e['lon'], e['lat']); sk, d, dd, k = onroute(x, y)
            rec = dict(s=round(sk, 1), d=round(d, 1), x=round(x, 1), y=round(y, 1), id=e['id'], tags={k_: v for k_, v in t.items() if not k_.startswith(('source', 'note', 'fixme', 'check_date', 'survey'))})
            for key in ('maxheight', 'maxheight:physical', 'maxweight', 'maxwidth'):
                if num(t.get(key)) and dd < 15: rec[key.replace(':physical', '_physical')] = num(t.get(key))
            points.append(rec); continue
        g = e.get('geometry') or []
        if len(g) < 2: continue
        xy = np.array(to_u.transform([p['lon'] for p in g], [p['lat'] for p in g])).T
        if t.get('highway') and not t.get('area:highway'):
            # a way of the route itself: the stretch of it within 6 m of the route line
            dd, k = kd.query(xy); on = dd < 6
            if on.sum() < 2: continue
            ks = sorted(int(v) for v in k[on]); sa, sb = float(s[ks[0]]), float(s[ks[-1]])
            vals = {key: num(t.get(key)) for key in ('maxheight', 'maxheight:physical', 'maxweight', 'maxweightrating', 'maxwidth', 'maxwidth:physical', 'maxlength', 'maxaxleload')}
            vals = {k_: v for k_, v in vals.items() if v}
            if not vals and t.get('hgv') not in ('no', 'destination', 'delivery', 'agricultural'): continue
            limits.append(dict(s0=round(sa, 1), s1=round(sb, 1), id=e['id'], ref=t.get('ref'), name=t.get('name'), hgv=t.get('hgv'),
                               **{k_.replace(':physical', '_physical'): v for k_, v in vals.items()}))
            continue
        kind = ('power' if t.get('power') else 'telecom') if (t.get('power') or t.get('telecom') or t.get('communication')) else None
        if kind:
            if t.get('power') == 'cable' and t.get('location') not in ('overhead',): continue      # underground cable
            Lw = LineString(xy)
            # where it crosses the route: the closest approach of its segments to the route line
            dd, k = kd.query(xy)
            k0 = int(k[np.argmin(dd)])
            seg = LineString(P[max(0, k0 - 300):min(len(P), k0 + 300):2])
            x_ = Lw.intersection(seg)
            if x_.is_empty:
                if dd.min() > 8: continue                                   # beside the route, not over it
                cx, cy = xy[np.argmin(dd)]
            else:
                pt = x_ if x_.geom_type == 'Point' else list(getattr(x_, 'geoms', [x_]))[0]
                cx, cy = pt.x, pt.y
            sk, d, _, kk = onroute(cx, cy)
            # crossing angle against the route
            v = np.diff(xy, axis=0); vi = v[min(len(v) - 1, int(np.argmin(np.hypot(xy[:-1, 0] - cx, xy[:-1, 1] - cy))))]
            ta = np.array([-N[kk, 1], N[kk, 0]]); ang = float(np.degrees(np.arccos(abs(np.dot(vi, ta)) / (np.linalg.norm(vi) + 1e-9))))
            volt = [num(x) for x in re.split(r'[;,]', t.get('voltage', '')) if num(x)]
            lines.append(dict(s=round(sk, 1), d=round(d, 1), x=round(float(cx), 1), y=round(float(cy), 1), id=e['id'], kind=kind, line=t.get('power') or t.get('telecom') or t.get('communication'),
                              kv=round(max(volt) / 1000, 1) if volt else None, operator=t.get('operator'), name=t.get('name'), ref=t.get('ref'),
                              cables=t.get('cables'), wires=t.get('wires'), height=num(t.get('height')), angle=round(ang), crosses=not x_.is_empty))
            continue
        # islands, kerbs, barriers as ways / areas
        dd, k = kd.query(xy); k0 = int(k[np.argmin(dd)]); sk, d, _, _ = onroute(*xy[np.argmin(dd)])
        closed = len(xy) > 3 and np.hypot(*(xy[0] - xy[-1])) < 0.5
        areas.append(dict(s=round(sk, 1), d=round(d, 1), id=e['id'], closed=bool(closed),
                          kind=t.get('area:highway') or t.get('traffic_calming') or t.get('barrier'), kerb=t.get('kerb'), height=num(t.get('height')),
                          xy=[[round(float(p[0]), 1), round(float(p[1]), 1)] for p in xy]))
    for L in (limits, lines, points, areas): L.sort(key=lambda q: q.get('s', q.get('s0', 0)))
    out = dict(date=time.strftime('%Y-%m-%d'), covered=[[a_, b_] for a_, b_ in sorted(cached())], limits=limits, lines=lines, points=points, areas=areas,
               credit='© OpenStreetMap contributors (ODbL), via overpass-api.de')
    json.dump(out, open(OUT + 'osm_tags.json', 'w'), ensure_ascii=False)
    # signed height limits on the route (signs 265): the route's ways with maxheight, nodes with one on the road
    lim = []
    for q in limits:
        h = q.get('maxheight') or q.get('maxheight_physical')
        if h: lim.append(dict(s=q['s0'], len=round(q['s1'] - q['s0'], 1), value=h, name=q.get('ref') or q.get('name'), physical='maxheight_physical' in q and 'maxheight' not in q, src='OSM way %d' % q['id']))
    # a node with a height limit counts only when it is on the route's own road: nodes of a road passing under the route,
    # and waterway clearances (seamarks) of a bridge the route crosses, are not
    import pickle
    Ru = pickle.load(open(routecfg.C + 'route.pkl', 'rb')); SEG = route()['SEG']
    nw_fn = CACHE + 'nodeways.json'; NW = json.load(open(nw_fn)) if os.path.exists(nw_fn) else {}
    def parents(nid):
        if str(nid) not in NW:
            q_ = f'[out:json][timeout:60];node({nid});way(bn)[highway];out tags;'
            for a in range(60):
                try:
                    req = urllib.request.Request(URL, data=urllib.parse.urlencode({'data': q_}).encode(), headers={'User-Agent': 'route-survey'})
                    NW[str(nid)] = [e.get('tags', {}) for e in json.loads(urllib.request.urlopen(req, timeout=240).read())['elements']]; break
                except Exception: time.sleep(5 + 5 * (a % 4))
            json.dump(NW, open(nw_fn, 'w'))
        return NW.get(str(nid), [])
    for q in points:
        h = q.get('maxheight') or q.get('maxheight_physical')
        if not h or abs(q['d']) >= 12 or any(k_.startswith(('seamark', 'waterway')) for k_ in q['tags']) or q['tags'].get('obstacle') == 'bridge': continue
        if any(L_['s'] - 30 <= q['s'] <= L_['s'] + L_['len'] + 30 for L_ in lim): continue
        k = int(np.clip(np.searchsorted(s, q['s']), 0, len(s) - 1)); info = Ru[SEG[k]][0]
        refs = {r_.strip().replace(' ', '') for r_ in (info.get('ref') or '').split(';') if r_.strip()}
        own = [w for w in parents(q['id']) if (refs and refs & {r_.strip().replace(' ', '') for r_ in (w.get('ref') or '').split(';')})
               or (w.get('highway', '').replace('_link', '') == (info.get('cls') or '').replace('_link', '') and (not refs or not w.get('ref')) and (w.get('name') or '') == (info.get('name') or w.get('name') or ''))]
        if own: lim.append(dict(s=q['s'], len=6, value=h, name=info.get('ref') or info.get('name'), physical=False, src='OSM node %d' % q['id']))
        else: print(f"  km {q['s'] / 1000:.2f}: height limit {h} m on a road beside or under the route ({', '.join(w.get('highway', '?') for w in parents(q['id'])) or 'no road'}), left out")
    # limits mapped before on stretches this run has not covered stay
    cov = sorted(cached())
    if os.path.exists(OUT + 'limits.json'):
        try: old = json.load(open(OUT + 'limits.json'))
        except Exception: old = []
        lim += [q for q in (old if isinstance(old, list) else []) if not any(a_ <= q['s'] <= b_ for a_, b_ in cov)]
    json.dump(sorted(lim, key=lambda q: q['s']), open(OUT + 'limits.json', 'w'))
    print(f"{len(limits)} limited ways, {len(lim)} height limits, {len(lines)} overhead lines ({sum(1 for q in lines if q['crosses'])} crossing), "
          f"{len(points)} nodes, {len(areas)} islands / kerbs / barriers")


if __name__ == '__main__':
    main()
