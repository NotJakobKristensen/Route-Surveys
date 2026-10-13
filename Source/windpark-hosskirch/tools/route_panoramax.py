"""Open street-level photos along the route from Panoramax (api.panoramax.xyz, the federated open street-photo
archive): every picture taken within 20 m of the route line, with its chainage, offset, date, viewing direction and
whether it looks along our direction of travel.
→ .cache/route/corr/panoramax.json  {date, pics: [{id, s, d, lon, lat, t, az, fwd, coll, thumb, sd, lic, by}]}
Usage: python route_panoramax.py"""
import routecfg
import json, os, time, urllib.request, urllib.parse
import numpy as np
from pyproj import Transformer
from scipy.spatial import cKDTree
from route_corridor import route, OUT

API = 'https://api.panoramax.xyz/api/search'
to_ll = Transformer.from_crs('EPSG:32633', 'EPSG:4326', always_xy=True)
to_u = Transformer.from_crs('EPSG:4326', 'EPSG:32633', always_xy=True)


def get(url):
    for a in range(4):
        try: return json.loads(urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'route-survey'}), timeout=120).read())
        except Exception as ex: print('  retry', repr(ex)[:80], flush=True); time.sleep(4 * (a + 1))
    return {}


def main():
    r = route(); P, s, N = r['P'], r['s'], r['N']
    kd = cKDTree(P); pics = {}
    step = 1500
    for i in range(0, len(P) - 1, step):
        seg = P[i:i + step + 1:10]
        lo, la = to_ll.transform(seg[:, 0], seg[:, 1])
        bb = f'{min(lo) - 0.0004:.5f},{min(la) - 0.0003:.5f},{max(lo) + 0.0004:.5f},{max(la) + 0.0003:.5f}'
        url = API + '?' + urllib.parse.urlencode({'bbox': bb, 'limit': 1000})
        while url:
            js = get(url); F = js.get('features', [])
            for f in F:
                if f['id'] in pics: continue
                lon, lat = f['geometry']['coordinates'][:2]; x, y = to_u.transform(lon, lat)
                dd, k = kd.query((x, y))
                if dd > 20: continue
                k = int(k); p = f.get('properties', {})
                az = p.get('view:azimuth'); fwd = None
                if az is not None:
                    # the route's heading at k (compass degrees) against the picture's view direction
                    tx, ty = N[k, 1], -N[k, 0]; hd = (np.degrees(np.arctan2(tx, ty)) + 360) % 360
                    diff = abs((az - hd + 180) % 360 - 180); fwd = bool(diff < 50) if diff < 50 or diff > 130 else None
                    if diff > 130: fwd = False
                A = f.get('assets', {})
                pics[f['id']] = dict(id=f['id'], s=round(float(s[k]), 1), d=round(float((x - P[k, 0]) * N[k, 0] + (y - P[k, 1]) * N[k, 1]), 1),
                                     lon=round(lon, 6), lat=round(lat, 6), t=(p.get('datetime') or '')[:10], az=az, fwd=fwd, coll=f.get('collection'),
                                     pano=(p.get('pers:interior_orientation') or {}).get('field_of_view') == 360,
                                     thumb=(A.get('thumb') or {}).get('href'), sd=(A.get('sd') or {}).get('href'),
                                     lic=p.get('license'), by=(p.get('providers') or [{}])[0].get('name') if p.get('providers') else None)
            nxt = [l_['href'] for l_ in js.get('links', []) if l_.get('rel') == 'next']
            url = nxt[0] if nxt and len(F) >= 1000 else None
        if i // step % 20 == 0: print(f'  km {s[i] / 1000:6.1f}: {len(pics)} pictures', flush=True)
    L = sorted(pics.values(), key=lambda q: q['s'])
    json.dump(dict(date=time.strftime('%Y-%m-%d'), source='Panoramax (api.panoramax.xyz)', pics=L), open(OUT + 'panoramax.json', 'w'), ensure_ascii=False)
    km = np.unique(np.array([q['s'] for q in L]) // 1000) if L else []
    print(len(L), 'pictures within 20 m of the route, on', len(km), 'route kilometres')


if __name__ == '__main__':
    main()
