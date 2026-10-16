"""Compare the two views from blade.cjs output: python3 blade_cmp.py <blade.json> [rows.json out]
default view: the passage's painted area (kind 3 / bout, passage frame → UTM 33 with the passage's projection) and its card;
drive view: the drawn 'beyond' meshes (UTM) within the passage's corridor (the convoy line from 100 m before it to its end,
± 60 m) and the card's figure: the largest over the passage's front-axle metres (bladeAtS / the old live bL, bR)"""
import json, sys, numpy as np
from pyproj import Transformer
from shapely.geometry import Polygon, LineString, MultiPolygon
from shapely.ops import unary_union
J = json.load(open(sys.argv[1]))
rows = []
for hid, r in J['hot'].items():
    tf = Transformer.from_crs(f"+proj=tmerc +lat_0={r['lat']} +lon_0={r['lon']} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs", 'EPSG:32633', always_xy=True)   # (the passage's frame)
    polys = []
    for f in r['hot']['k3']:
        rings = []
        for x in f:
            a = np.array(x).reshape(-1, 2); X, Y = tf.transform(a[:, 0], a[:, 1]); rings.append(list(zip(X, Y)))
        polys.append(Polygon(rings[0], rings[1:]).buffer(0))
    hotA = unary_union(polys) if polys else Polygon()
    a, b = r['km'][0] * 1000, r['km'][1] * 1000
    tris, line, dmax, dat = [], [], 0.0, None
    for d in r['drive']:
        for m in d['meshes'].get('beyond', []):
            P = np.array(m['pos']).reshape(-1, 3)[:, [0, 2]]
            idx = m['idx'] if m['idx'] else list(range(len(P)))
            for i in range(0, len(idx), 3):
                t = Polygon(P[idx[i:i + 3]])
                if t.area > 1e-6: tris.append(t.buffer(0))
        line += d['line']
        for i, v in enumerate(d['depth']['v']):
            s = d['depth']['s0'] + i
            if v is not None and a <= s <= b and v > dmax: dmax, dat = v, s
    corr = LineString(line).buffer(60) if len(line) > 1 else Polygon()
    drvA = unary_union(tris).buffer(0).intersection(corr) if tris else Polygon()
    sd = hotA.symmetric_difference(drvA).area if not (hotA.is_empty and drvA.is_empty) else 0.0
    hc = (r['hot']['card'].get('Blade beyond the road edge') or [''])[0]
    dc = [x.get('cardAt', {}).get('card', {}).get('Blade beyond the edge', [''])[0] for x in r['drive'] if x.get('cardAt')]
    row = dict(id=hid, json_out=r['json']['bladeOut'], json_area=r['json']['bladeArea'], hot_card=hc, hot_area=round(hotA.area, 1),
               drive_max=round(dmax, 2), drive_card=' / '.join(dc), drive_area=round(drvA.area, 1), symdiff=round(sd, 1))
    rows.append(row)
    print(f"{hid:32s} default view: card '{hc}' painted {hotA.area:8.1f} m² | drive view: up to {dmax:6.2f} m (card '{' / '.join(dc)}'), drawn {drvA.area:8.1f} m² | differ {sd:7.1f} m²", flush=True)
if len(sys.argv) > 2: json.dump(rows, open(sys.argv[2], 'w'), indent=1)
