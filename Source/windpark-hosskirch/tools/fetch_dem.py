"""Copernicus GLO-30 DSM mosaic (N47/N48 E009 tiles) over the scene, from the AWS open-data bucket."""
import os, numpy as np, rasterio
from geo import CACHE, cp
from rasterio.windows import from_bounds, Window
os.environ['CURL_CA_BUNDLE'] = '/root/.ccr/ca-bundle.crt'; os.environ['GDAL_DISABLE_READDIR_ON_OPEN'] = 'EMPTY_DIR'
W, S, E, N = 9.26, 47.83, 9.63, 48.09
def cop(lat, lon):
    n = f'Copernicus_DSM_COG_10_N{lat:02d}_00_E{lon:03d}_00_DEM'
    return f'/vsicurl/https://copernicus-dem-30m.s3.amazonaws.com/{n}/{n}.tif'
# mosaic N47 + N48 into one array on the 1" grid
res = 1 / 3600.
lon0 = 8.99986111111111
c0 = int(round((W - lon0) / res)); c1 = int(round((E - lon0) / res))
top = 48.00013888888889 + 1  # N48 tile top
rows = []
for lat in (48, 47):
    t = lat + 1.00013888888889
    with rasterio.open(cop(lat, 9)) as s:
        r0 = max(0, int(round((t - N) / res))); r1 = min(3600, int(round((t - S) / res)))
        if r1 <= r0: continue
        a = s.read(1, window=Window(c0, r0, c1 - c0, r1 - r0))
        rows.append((t - r0 * res, a))
        print(lat, a.shape)
north = rows[0][0]
A = np.concatenate([a for _, a in rows], 0)
np.save(cp('cop_wide.npy'), A)
np.save(cp('cop_wide_geo.npy'), np.array([lon0 + c0 * res, north, res]))  # left edge lon, top edge lat, res
print('cop wide', A.shape, 'left', lon0 + c0 * res, 'top', north)
