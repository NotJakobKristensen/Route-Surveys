"""Far terrain and horizon for the Windpark Hoßkirch page (AWS Terrain Tiles, Terrarium encoding).

far_dem.npy      500 m grid over ±64 km in the local frame (Lake Constance, Swabian Jura, Upper Swabia)
far_lc.npy       ESA WorldCover 2021 fractions per far-grid node: forest (class 10), built-up (50) — real forests / towns on the horizon
horizon.npy      elevation angle (rad) of the skyline beyond 64 km for 1024 azimuths, seen from the park at 900 m
                 above sea level, with Earth curvature and refraction (k = 0.13) — the Alps from Säntis to the Allgäu.
"""
import math, os, sys, io
import numpy as np, requests
from PIL import Image
from scipy.ndimage import map_coordinates
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from geo import to_lonlat, LON0, LAT0  # noqa: E402

CACHE = os.environ.get('WINDPARK_CACHE', os.path.join(HERE, '..', '.cache'))
TD = os.path.join(CACHE, 'terr'); os.makedirs(TD, exist_ok=True)

def tile(z, x, y):
    fn = os.path.join(TD, f'{z}_{x}_{y}.png')
    if not os.path.exists(fn):
        r = requests.get(f'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png', timeout=60); r.raise_for_status()
        open(fn, 'wb').write(r.content)
    a = np.asarray(Image.open(fn).convert('RGB')).astype(np.float32)
    return a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768

def mosaic(z, lon0, lat0, lon1, lat1):
    n = 2 ** z
    fx = lambda lon: (lon + 180) / 360 * n
    fy = lambda lat: (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    tx0, tx1 = int(fx(lon0)), int(fx(lon1)); ty0, ty1 = int(fy(lat1)), int(fy(lat0))
    M = np.zeros(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256), np.float32)
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            M[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = tile(z, tx, ty)
    def sample(lon, lat, order=1):
        px = (np.asarray(lon) + 180) / 360 * n; py = (1 - np.arcsinh(np.tan(np.radians(lat))) / np.pi) / 2 * n
        return map_coordinates(M, [(py - ty0) * 256 - 0.5, (px - tx0) * 256 - 0.5], order=order, mode='nearest')
    return sample

if __name__ == '__main__':
    # far ring grid (z9 ≈ 200 m pixels)
    E = 64000.0; R = 500.0; n = int(2 * E / R) + 1
    xs = -E + np.arange(n) * R; X, Y = np.meshgrid(xs, xs[::-1])
    LON, LAT = to_lonlat(X, Y)
    s9 = mosaic(9, LON.min() - 0.05, LAT.min() - 0.05, LON.max() + 0.05, LAT.max() + 0.05)
    Z = s9(LON, LAT, order=1)
    np.save(os.path.join(CACHE, 'far_dem.npy'), Z.astype(np.float32))
    print('far dem', Z.shape, Z.min(), Z.max())
    # horizon beyond the far ring (z8 ≈ 400 m pixels), observer at the park centre, 900 m a.s.l.
    s8 = mosaic(8, LON0 - 3.6, LAT0 - 2.4, LON0 + 3.6, LAT0 + 2.4)
    NA = 1024; eye = 900.0; Re = 6371000.0; k = 0.13
    d = np.arange(E, 260000.0, 400.0)
    ang = np.full(NA, -0.05)
    for i in range(NA):
        az = 2 * math.pi * i / NA
        px, py = np.sin(az) * d, np.cos(az) * d
        lon, lat = to_lonlat(px, py)
        h = s8(lon, lat)
        drop = d * d / (2 * Re) * (1 - k)
        ang[i] = np.max(np.arctan2(h - drop - eye, d))
    np.save(os.path.join(CACHE, 'horizon.npy'), ang.astype(np.float32))
    deg = np.degrees(ang)
    print('horizon deg min %.2f max %.2f; south (180°) %.2f°' % (deg.min(), deg.max(), deg[NA // 2]))

    # land cover for the far ring: ESA WorldCover 2021 (10 m) read at the 80 m overview, box-filtered to 500 m
    import rasterio
    from rasterio.windows import from_bounds
    from scipy.ndimage import uniform_filter
    os.environ.setdefault('CURL_CA_BUNDLE', '/root/.ccr/ca-bundle.crt'); os.environ.setdefault('GDAL_DISABLE_READDIR_ON_OPEN', 'EMPTY_DIR')
    W, S_, E2, N2 = LON.min() - 0.02, LAT.min() - 0.02, LON.max() + 0.02, LAT.max() + 0.02
    res = 1 / 1200.0                                   # 3 arc-seconds ≈ 90 × 62 m
    nx, ny = int((E2 - W) / res) + 1, int((N2 - S_) / res) + 1
    cls = np.zeros((ny, nx), np.uint8)
    for t, (tl, tb) in {'N45E006': (6, 45), 'N45E009': (9, 45), 'N48E006': (6, 48), 'N48E009': (9, 48)}.items():
        u = f'/vsicurl/https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_{t}_Map.tif'
        w0, s0, e0, n0 = max(W, tl), max(S_, tb), min(E2, tl + 3), min(N2, tb + 3)
        if w0 >= e0 or s0 >= n0: continue
        with rasterio.open(u) as src:
            win = from_bounds(w0, s0, e0, n0, src.transform)
            c0, r0 = int(round((w0 - W) / res)), int(round((N2 - n0) / res))
            cw, ch = int(round((e0 - w0) / res)), int(round((n0 - s0) / res))
            a = src.read(1, window=win, out_shape=(ch, cw), resampling=rasterio.enums.Resampling.mode)
            cls[r0:r0 + ch, c0:c0 + cw] = a[:min(ch, ny - r0), :min(cw, nx - c0)]
    k = 7
    forest = uniform_filter((cls == 10).astype(np.float32), k); built = uniform_filter((cls == 50).astype(np.float32), k)
    col = (LON - W) / res - 0.5; row = (N2 - LAT) / res - 0.5
    F = map_coordinates(forest, [row, col], order=1, mode='nearest'); B = map_coordinates(built, [row, col], order=1, mode='nearest')
    np.save(os.path.join(CACHE, 'far_lc.npy'), np.stack([F, B]).astype(np.float32))
    print('far land cover: forest %.2f, built %.3f' % (F.mean(), B.mean()))
