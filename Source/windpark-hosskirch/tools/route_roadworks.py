"""Roadworks and closures on the route's motorways, from Autobahn GmbH's traffic service (verkehr.autobahn.de):
every entry (roadworks, closure) of the motorways the route uses whose geometry runs along the route in our direction of
travel, with its stretch (chainage), the phase dates, the narrowest passable width, speed limit and lanes.

A snapshot: phases change weekly. The page states the date; re-run before the transport.
→ .cache/route/corr/roadworks.json  {date, items: [{s0, s1, kind, title, dir, width, speed, length, start, end, until, text, lanes, blocked, future, lat, lon}]}
Usage: python route_roadworks.py"""
import routecfg
import json, os, re, time, ast, urllib.request
import numpy as np
from pyproj import Transformer
from scipy.spatial import cKDTree
from route_corridor import route, OUT

API = 'https://verkehr.autobahn.de/o/autobahn/{road}/services/{svc}'
to_u = Transformer.from_crs('EPSG:4326', 'EPSG:32633', always_xy=True)


def get(url):
    for a in range(4):
        try: return json.loads(urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'route-survey'}), timeout=90).read())
        except Exception as ex: print('  retry', url, repr(ex)[:80]); time.sleep(3 * (a + 1))
    return {}


def roads_on_route():
    """the motorways the route runs on (A 9, A 10 …), from the route's road refs"""
    import pickle
    Ru = pickle.load(open(routecfg.C + 'route.pkl', 'rb'))
    refs = set()
    for seg in Ru:
        info = seg[0] if isinstance(seg, (list, tuple)) else seg
        if info.get('cls') in ('motorway', 'motorway_link'):
            for r in (info.get('ref') or '').split(';'):
                m = re.match(r'^A\s?(\d+)$', r.strip())
                if m: refs.add('A' + m[1])
    return sorted(refs, key=lambda x: int(x[1:]))


def parse(desc):
    t = ' '.join(x for x in desc if x).replace('\xa0', ' ')
    f = lambda rx: (re.search(rx, t) or [None, None])[1]
    width = f(r'Durchfahrtsbreite:\s*([\d.,]+)\s*m'); speed = f(r'Max\.\s*(\d+)\s*km/h'); length = f(r'Länge:\s*([\d.,]+)\s*km')
    start = f(r'Beginn:\s*([\d.]+ um [\d:]+)'); end = f(r'Ende:\s*([\d.]+ um [\d:]+)'); until = f(r'Ende der Gesamtmaßnahme:\s*([\d.]+)')
    windows = re.findall(r'(\d\d\.\d\d\.\d\d (?:von [\d:]+ bis [\d:]+|[\d:]+ bis zum \d\d\.\d\d\.\d\d [\d:]+) Uhr)', t)
    num = lambda v: float(v.replace(',', '.')) if v else None
    return dict(width=num(width), speed=int(speed) if speed else None, length=num(length), start=start, end=end, until=until,
                windows=windows[:6], text=t[:600])


def main():
    r = route(); P, s = r['P'], r['s']
    kd = cKDTree(P)
    roads = roads_on_route(); print('motorways on the route:', ', '.join(roads))
    items = []
    for road in roads:
        for svc in ('roadworks', 'closure'):
            js = get(API.format(road=road, svc=svc))
            for e in js.get(svc, []):
                try: g = e['geometry'] if isinstance(e['geometry'], dict) else ast.literal_eval(e['geometry'])
                except Exception: continue
                co = np.array(g.get('coordinates') or [])
                if co.ndim != 2 or len(co) < 1: continue
                xy = np.array(to_u.transform(co[:, 0], co[:, 1])).T
                dd, k = kd.query(xy)
                on = dd < 35                                       # along the route (the other carriageway is ~15–30 m off)
                if on.mean() < 0.6: continue
                ks = k[on]
                if len(ks) > 1 and ks[-1] < ks[0]: continue          # the opposite direction of travel
                if len(ks) > 1:                                      # same carriageway: the route's own side (right of the centre line)
                    pass
                info = parse(e.get('description') or [])
                try: imp = e['impact'] if isinstance(e['impact'], dict) else ast.literal_eval(e['impact'])
                except Exception: imp = {}
                items.append(dict(s0=round(float(s[int(ks.min())]), 0), s1=round(float(s[int(ks.max())]), 0), kind=svc, road=road,
                                  title=(e.get('title') or '').replace(' | ', ': '), dir=(e.get('subtitle') or '').strip(),
                                  lanes=imp.get('symbols'), blocked=e.get('isBlocked') == 'true', future=e.get('future') == 'True',
                                  lat=round(float(co[0, 1]), 5), lon=round(float(co[0, 0]), 5), off=round(float(np.median(dd[on])), 1), **info))
    # one entry per stretch and phase text (the service lists some twice)
    seen, out = set(), []
    for q in sorted(items, key=lambda q: (q['s0'], q['s1'])):
        key = (q['s0'] // 50, q['s1'] // 50, q['width'], q['start'], tuple(q['windows']))
        if key in seen: continue
        seen.add(key); out.append(q)
    json.dump(dict(date=time.strftime('%Y-%m-%d'), source='Autobahn GmbH des Bundes, verkehr.autobahn.de', items=out),
              open(OUT + 'roadworks.json', 'w'), ensure_ascii=False)
    for q in out:
        print(f"km {q['s0'] / 1000:6.1f}–{q['s1'] / 1000:6.1f} {q['kind']:9s} {q['title'][:50]:50s} width {q['width']} {q['start'] or ''}–{q['end'] or ''} {'; '.join(q['windows'][:2])}")
    print(len(out), 'entries along the route')


if __name__ == '__main__':
    main()
