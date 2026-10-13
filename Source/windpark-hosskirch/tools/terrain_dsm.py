"""Copernicus GLO-30 surface model and the OSM forest mask on a 10 m grid over ±12.5 km (inputs of terrain_dtm.py)."""
import numpy as np, json, math
from scipy.ndimage import map_coordinates, gaussian_filter, distance_transform_edt, binary_erosion
from geo import *
from PIL import Image
G = Grid(12500, 10)     # 25 km x 25 km at 10 m
X, Y = G.xy()
LON, LAT = to_lonlat(X, Y)
A = np.load(cp('cop_wide.npy')); left, top, res = np.load(cp('cop_wide_geo.npy'))
DSM = map_coordinates(A, [(top - LAT) / res - 0.5, (LON - left) / res - 0.5], order=3, mode='nearest').astype(np.float32)
print('DSM', DSM.shape, DSM.min(), DSM.max())
# forest mask from OSM (wide)
forest = [f for f in load(cp('wide_land.geojson')) if f['properties'].get('class') in ('wood', 'forest') and f['geometry']['type'] in ('Polygon', 'MultiPolygon')]
forest += [f for f in load(cp('wide_land_use.geojson')) if f['properties'].get('class') == 'forest' and f['geometry']['type'] in ('Polygon', 'MultiPolygon')]
F = np.asarray(rasterize(forest, G)) > 127
print('forest frac', F.mean())
np.save(cp('g10_forest.npy'), F); np.save(cp('g10_dsm.npy'), DSM)
