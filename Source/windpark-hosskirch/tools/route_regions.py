"""The state / voivodeship (ISO 3166-2) of every 500 m of the route, from Overture divisions (region areas)
→ <route cache>/corr/regions.pkl {'step': 500, 'lab': [code per 500 m]} (the photo and height sources per chunk)."""
import pickle
import numpy as np
from pyproj import Transformer
from shapely import wkb
from shapely.geometry import Point
from shapely.strtree import STRtree
import routecfg
import overture as ov
from route_corridor import route, OUT

if __name__ == '__main__':
    r = route(); P = r['P']; s = r['s']
    tr = Transformer.from_crs('EPSG:32633', 'EPSG:4326', always_xy=True)
    ss = np.arange(250.0, s[-1] + 250.0, 500.0)
    lon, lat = tr.transform(np.interp(ss, s, P[:, 0]), np.interp(ss, s, P[:, 1]))
    bb = (float(lon.min()) - 0.1, float(lat.min()) - 0.1, float(lon.max()) + 0.1, float(lat.max()) + 0.1)
    t = ov.query('divisions', 'division_area', bb, columns=['subtype', 'class', 'region', 'geometry'])
    areas = [(r_['region'], wkb.loads(r_['geometry'])) for r_ in t.to_pylist() if r_['subtype'] == 'region' and r_['class'] == 'land' and r_['region']]
    tree = STRtree([g for _, g in areas])
    lab, last = [], None
    for x, y in zip(lon, lat):
        p = Point(x, y); code = None
        for i in tree.query(p):
            if areas[i][1].contains(p): code = areas[i][0]; break
        if code is None:                                  # on a border river or bridge: the nearest region
            i = tree.nearest(p); code = areas[i][0] if i is not None else last
        lab.append(code); last = code
    pickle.dump({'step': 500, 'lab': lab}, open(OUT + 'regions.pkl', 'wb'))
    import collections
    print(len(lab), collections.Counter(lab))
