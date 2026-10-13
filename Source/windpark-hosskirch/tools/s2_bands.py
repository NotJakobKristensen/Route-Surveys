"""Read Sentinel-2 L2A bands for a local-frame box and resample onto a local grid (exact reprojection)."""
import os, sys, numpy as np, rasterio
from rasterio.windows import Window
from pyproj import Transformer
from scipy.ndimage import map_coordinates
from geo import CACHE, cp, to_lonlat, Grid
os.environ['CURL_CA_BUNDLE'] = '/root/.ccr/ca-bundle.crt'; os.environ['GDAL_DISABLE_READDIR_ON_OPEN'] = 'EMPTY_DIR'
B = 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/32/U/NU'
tu = Transformer.from_crs('EPSG:4326', 'EPSG:32632', always_xy=True)
def read_bands(scene, bands, xs, ys, order=3):
    """xs, ys: 2D arrays of local-frame coords. Returns dict band -> array (reflectance, float32)."""
    lon, lat = to_lonlat(xs, ys); ux, uy = tu.transform(lon, lat)
    y, m = scene.split('_')[2][:4], int(scene.split('_')[2][4:6])
    out = {}
    for b in bands:
        with rasterio.open(f'/vsicurl/{B}/{y}/{m}/{scene}/{b}.tif') as s:
            inv = ~s.transform
            cc, rr = inv * (ux, uy)          # pixel-edge coords
            c0, r0 = int(np.floor(cc.min())) - 3, int(np.floor(rr.min())) - 3
            c1, r1 = int(np.ceil(cc.max())) + 3, int(np.ceil(rr.max())) + 3
            a = s.read(1, window=Window(c0, r0, c1 - c0, r1 - r0)).astype(np.float32)
            scale = 1.0 if b in ('TCI',) else 1 / 10000.
            # L2A processing baseline >= 04.00 adds a +1000 offset to reflectance DN
            off = 0.0
            if b not in ('TCI', 'SCL'):
                off = BOA_OFFSET.get(scene, 0)
            v = map_coordinates(a, [rr - r0 - 0.5, cc - c0 - 0.5], order=order if b != 'SCL' else 0, mode='nearest')
            out[b] = (v - off) * scale if b not in ('TCI', 'SCL') else v
    return out
BOA_OFFSET = {}
def boa_offset(scene):
    import requests, re
    y, m = scene.split('_')[2][:4], int(scene.split('_')[2][4:6])
    x = requests.get(f'{B}/{y}/{m}/{scene}/granule_metadata.xml', timeout=60).text
    x2 = requests.get(f'{B}/{y}/{m}/{scene}/{scene}.json', timeout=60).json()
    off = x2['properties'].get('earthsearch:boa_offset_applied')
    return off, x2['properties'].get('s2:processing_baseline')
if __name__ == '__main__':
    for sc in sys.argv[1:]: print(sc, boa_offset(sc))
