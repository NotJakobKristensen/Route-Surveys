"""Elevation along the whole route from Copernicus GLO-30 (every 10 m, at the centreline and ±20 m across),
read block by block. → .cache/route/corr/elev.npz (z0, zl, zr per 10 m; s)."""
import os, sys, numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from route_corridor import route, OUT
from pyproj import Transformer
from scipy.ndimage import map_coordinates
import importlib
rh_src = open(os.path.join(HERE, 'route_hotspots.py')).read()
ns = {'__file__': os.path.join(HERE, 'route_hotspots.py')}
exec(rh_src.split('def clean(v):')[0].replace("scr = np.load(C + 'screen.npz')", 'scr = None'), ns)     # imports + read_wgs/dem_url without running analyses
read_wgs, dem_url = ns['read_wgs'], ns['dem_url']
r = route(); P = r['P']; s = r['s']; N = r['N']
idx = np.arange(0, len(s), 10)
pts = {k: P[idx] + N[idx] * o for k, o in (('z0', 0.0), ('zl', 20.0), ('zr', -20.0))}
t = Transformer.from_crs('EPSG:32633', 'EPSG:4326', always_xy=True)
ll = {k: t.transform(v[:, 0], v[:, 1]) for k, v in pts.items()}
out = {k: np.full(len(idx), np.nan, np.float32) for k in pts}
res = 1 / 3600
B = 2000                                    # points per block (20 km)
for b0 in range(0, len(idx), B):
    sl = slice(b0, b0 + B)
    lons = np.concatenate([ll[k][0][sl] for k in ll]); lats = np.concatenate([ll[k][1][sl] for k in ll])
    bb = (lons.min() - 0.005, lats.min() - 0.005, lons.max() + 0.005, lats.max() + 0.005)
    a = read_wgs(dem_url, bb, res, bands=[1])
    if a is None: continue
    for k in ll:
        lo, la = ll[k][0][sl], ll[k][1][sl]
        out[k][sl] = map_coordinates(a[0].astype(np.float32), [(bb[3] - la) / res - 0.5, (lo - bb[0]) / res - 0.5], order=1)
    print(b0, len(idx), flush=True)
np.savez_compressed(OUT + 'elev.npz', s=s[idx], **out)
print('done')
