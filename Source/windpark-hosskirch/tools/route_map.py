"""Country-scale map of the blade route (Goleniów → Hoßkirch) for the route-survey page.

Map frame: transverse Mercator centred on the route (lon 12.1°, lat 50.6°), metres; x east, y north.
  map_rgb.webp     natural colour: ESA WorldCover 2021 Sentinel-2 composite (cloud-free median), relief shading from
                   AWS Terrain Tiles; sharp along the route, softened away from it
  map_dem.npy      ground height on a 2 km grid (relief of the 3D map)
  map_vec.json     route (simplified), motorways, borders, rivers, lakes, towns
"""
import routecfg
import json, math, os, pickle, sys, numpy as np
from pyproj import Transformer
from PIL import Image, ImageFilter
from scipy.ndimage import map_coordinates, gaussian_filter, distance_transform_edt, zoom
import rasterio
from rasterio.windows import from_bounds
from shapely.geometry import LineString
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from fetch_far import mosaic  # noqa: E402

C = routecfg.C
LON0, LAT0 = routecfg.get('map_center', [12.1, 50.6])
PROJ = f'+proj=tmerc +lat_0={LAT0} +lon_0={LON0} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs'
fw = Transformer.from_crs('EPSG:4326', PROJ, always_xy=True)
bw = Transformer.from_crs(PROJ, 'EPSG:4326', always_xy=True)
utm = Transformer.from_crs('EPSG:32633', 'EPSG:4326', always_xy=True)
RES = 300.0            # texture metres per pixel
MARGIN = 60000.0


def route_lonlat():
    z = np.load(C + 'screen.npz')
    lon, lat = utm.transform(z['P'][:, 0], z['P'][:, 1])
    return np.c_[lon, lat], z['s']


def extent(rx, ry):
    x0, x1 = rx.min() - MARGIN, rx.max() + MARGIN
    y0, y1 = ry.min() - MARGIN, ry.max() + MARGIN
    W = int(math.ceil((x1 - x0) / RES / 16) * 16); H = int(math.ceil((y1 - y0) / RES / 16) * 16)
    return x0, y1 - H * RES, x0 + W * RES, y1, W, H


def s2_tile(la, lo):
    return f'/vsicurl/https://esa-worldcover-s2.s3.eu-central-1.amazonaws.com/rgbnir/2021/N{la:02d}/ESA_WorldCover_10m_2021_v200_N{la:02d}E{lo:03d}_S2RGBNIR.tif'


def main():
    ll, s = route_lonlat()
    rx, ry = fw.transform(ll[:, 0], ll[:, 1])
    x0, y0, x1, y1, W, H = extent(rx, ry)
    print('map', W, 'x', H, 'px', (x1 - x0) / 1000, 'x', (y1 - y0) / 1000, 'km')
    # pixel centres → lon/lat
    gx, gy = np.meshgrid(x0 + (np.arange(W) + 0.5) * RES, y1 - (np.arange(H) + 0.5) * RES)
    glon, glat = bw.transform(gx, gy)
    lo0, la0, lo1, la1 = glon.min(), glat.min(), glon.max(), glat.max()
    # ---- Sentinel-2 composite: 1/16 overview (≈ 160 m) of each 1° tile, mosaicked on a 1/720° lon/lat grid
    st = 1 / 720
    LW = int(math.ceil((lo1 - lo0) / st)) + 2; LH = int(math.ceil((la1 - la0) / st)) + 2
    mos = np.zeros((4, LH, LW), np.float32)
    fn = C + 'map_s2.npy'
    if os.path.exists(fn):
        mos = np.load(fn)
    else:
        for la in range(int(math.floor(la0)), int(math.floor(la1)) + 1):
            for lo in range(int(math.floor(lo0)), int(math.floor(lo1)) + 1):
                try:
                    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR'):
                        with rasterio.open(s2_tile(la, lo)) as r:
                            a = r.read(out_shape=(4, 720, 720), resampling=rasterio.enums.Resampling.average).astype(np.float32)
                except Exception as ex:
                    print('  no tile', la, lo, ex); continue
                c0 = int(round((lo - lo0) / st)); r0 = int(round((la1 + st - (la + 1)) / st))
                cs, rs = slice(max(0, c0), min(LW, c0 + 720)), slice(max(0, r0), min(LH, r0 + 720))
                mos[:, rs, cs] = a[:, rs.start - r0:rs.stop - r0, cs.start - c0:cs.stop - c0]
                print('  tile', la, lo)
        np.save(fn, mos)
    cc = (glon - lo0) / st - 0.5; rr = (la1 + st - glat) / st - 0.5
    img = np.stack([map_coordinates(mos[b], [rr, cc], order=1, mode='nearest') for b in range(4)])
    # ---- relief (Terrain Tiles z8, ≈ 400 m) on the texture grid
    samp = mosaic(8, lo0 - 0.2, la0 - 0.2, lo1 + 0.2, la1 + 0.2)
    dem = samp(glon, glat).reshape(H, W)
    rgb, water = shade_colour(img, dem, RES)
    # ---- focus: away from the route the picture softens (and compresses better)
    rpx = ((rx - x0) / RES).astype(int).clip(0, W - 1); rpy = ((y1 - ry) / RES).astype(int).clip(0, H - 1)
    mask = np.ones((H, W), bool); mask[rpy, rpx] = False
    dist = distance_transform_edt(mask) * RES
    soft = np.stack([gaussian_filter(rgb[..., k], 1.6) for k in range(3)], -1)
    wgt = np.clip((dist - 30000) / 40000, 0, 1)[..., None]
    lum = soft @ np.array([0.2126, 0.7152, 0.0722])
    soft = lum[..., None] + (soft - lum[..., None]) * 0.75
    rgb = rgb * (1 - wgt) + soft * wgt
    Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8)).save(C + 'map_rgb.png')
    Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8)).save(C + 'map_rgb.webp', quality=74, method=6)
    print('rgb webp', os.path.getsize(C + 'map_rgb.webp') // 1024, 'KB')
    # ---- 2 km height grid for the mesh
    step = 2000.0
    MW, MH = int((x1 - x0) / step) + 1, int((y1 - y0) / step) + 1
    mx, my = np.meshgrid(x0 + np.arange(MW) * step, y1 - np.arange(MH) * step)
    mlon, mlat = bw.transform(mx, my)
    mdem = gaussian_filter(samp(mlon.ravel(), mlat.ravel()).reshape(MH, MW), 0.7)
    mdem = np.maximum(mdem, -5)
    np.save(C + 'map_dem.npy', mdem.astype(np.float32))
    json.dump(dict(proj=PROJ, x0=x0, y0=y0, x1=x1, y1=y1, W=W, H=H, res=RES, mesh=[MW, MH, step]), open(C + 'map_meta.json', 'w'))
    print('dem grid', MW, MH, mdem.min(), mdem.max())


def shade_colour(img, dem, res, exg=2.5):
    """natural colour from L2A reflectance + relief shading from the NW; sea (no S2 data, ground ≤ 1 m) filled"""
    gz = gaussian_filter(dem, 0.8)
    dzdx = np.gradient(gz, axis=1) / res; dzdy = -np.gradient(gz, axis=0) / res
    nx, ny, nz = -dzdx * exg, -dzdy * exg, np.ones_like(gz)
    nl = np.sqrt(nx * nx + ny * ny + nz * nz)
    L = np.array([-0.55, 0.62, 0.56]); L /= np.linalg.norm(L)
    shade = (nx * L[0] + ny * L[1] + nz * L[2]) / nl
    rel = np.clip(1 + (shade - L[2]) * 1.6, 0.55, 1.35)
    r, g, b = img[0], img[1], img[2]
    nodata = (r + g + b) <= 0
    def tone(v):
        v = np.clip(v / 10000.0, 0, 1)
        return np.clip((v * 3.4) ** (1 / 2.05), 0, 1)
    base = np.stack([tone(r), tone(g), tone(b)], -1)
    lum = base @ np.array([0.2126, 0.7152, 0.0722])
    base = np.clip(lum[..., None] + (base - lum[..., None]) * 1.3, 0, 1)
    rgb = base * rel[..., None]
    ndwi = (g - img[3]) / np.maximum(g + img[3], 1)
    water = (ndwi > 0.15) & ~nodata
    rgb[water] = base[water] * 0.95
    sea = nodata & (gaussian_filter(dem, 1.0) <= 2.0)
    # soft seam between land without data and the sea colour
    seaf = gaussian_filter(sea.astype(np.float32), 1.2)[..., None]
    rgb = np.where(nodata[..., None], np.array([0.11, 0.21, 0.30]) * (1 - 0.0 * seaf) + np.array([0.0, 0.0, 0.0]), rgb)
    land_nod = nodata & ~sea
    if land_nod.any():
        rgb[land_nod] = np.array([0.36, 0.40, 0.30]) * rel[land_nod][:, None]
    return rgb, water | sea




def outer():
    """Low-resolution surround (≈ 1.5 km/px) so the map runs on to the horizon: map_outer.webp, map_outer_dem.npy"""
    m = json.load(open(C + 'map_meta.json'))
    cx, cy = (m['x0'] + m['x1']) / 2, (m['y0'] + m['y1']) / 2
    R_ = 1500.0
    W, H = 760, 900
    x0, y1 = cx - W / 2 * R_, cy + H / 2 * R_
    x1, y0 = x0 + W * R_, y1 - H * R_
    gx, gy = np.meshgrid(x0 + (np.arange(W) + 0.5) * R_, y1 - (np.arange(H) + 0.5) * R_)
    glon, glat = bw.transform(gx, gy)
    lo0, la0, lo1, la1 = glon.min(), glat.min(), glon.max(), glat.max()
    print('outer lon', lo0, lo1, 'lat', la0, la1)
    st = 1 / 90
    LW = int(math.ceil((lo1 - lo0) / st)) + 2; LH = int(math.ceil((la1 - la0) / st)) + 2
    fn = C + 'map_outer_s2.npy'
    if os.path.exists(fn): mos = np.load(fn)
    else:
        mos = np.zeros((4, LH, LW), np.float32)
        import concurrent.futures as cf
        def get(args):
            la, lo = args
            try:
                with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR'):
                    with rasterio.open(s2_tile(la, lo)) as r:
                        return la, lo, r.read(out_shape=(4, 90, 90), resampling=rasterio.enums.Resampling.average).astype(np.float32)
            except Exception:
                return la, lo, None
        jobs = [(la, lo) for la in range(int(math.floor(la0)), int(math.floor(la1)) + 1) for lo in range(int(math.floor(lo0)), int(math.floor(lo1)) + 1)]
        with cf.ThreadPoolExecutor(8) as ex:
            for la, lo, a in ex.map(get, jobs):
                if a is None: continue
                c0 = int(round((lo - lo0) / st)); r0 = int(round((la1 + st - (la + 1)) / st))
                cs, rs = slice(max(0, c0), min(LW, c0 + 90)), slice(max(0, r0), min(LH, r0 + 90))
                mos[:, rs, cs] = a[:, rs.start - r0:rs.stop - r0, cs.start - c0:cs.stop - c0]
        np.save(fn, mos)
    cc = (glon - lo0) / st - 0.5; rr = (la1 + st - glat) / st - 0.5
    img = np.stack([map_coordinates(mos[b], [rr, cc], order=1, mode='nearest') for b in range(4)])
    samp = mosaic(6, lo0 - 0.5, la0 - 0.5, lo1 + 0.5, la1 + 0.5)
    dem = samp(glon, glat).reshape(H, W)
    rgb, _ = shade_colour(img, dem, R_, exg=3.0)
    Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8)).save(C + 'map_outer.png')
    Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8)).save(C + 'map_outer.webp', quality=70, method=6)
    print('outer webp', os.path.getsize(C + 'map_outer.webp') // 1024, 'KB')
    step = 6000.0
    MW, MH = int(W * R_ / step) + 1, int(H * R_ / step) + 1
    mx, my = np.meshgrid(x0 + np.arange(MW) * step, y1 - np.arange(MH) * step)
    mlon, mlat = bw.transform(mx, my)
    mdem = gaussian_filter(samp(mlon.ravel(), mlat.ravel()).reshape(MH, MW), 0.6)
    np.save(C + 'map_outer_dem.npy', np.maximum(mdem, -5).astype(np.float32))
    m['outer'] = dict(x0=x0, y0=y0, x1=x1, y1=y1, W=W, H=H, res=R_, mesh=[MW, MH, step])
    json.dump(m, open(C + 'map_meta.json', 'w'))


if __name__ == '__main__':
    if 'outer' in sys.argv: outer()
    else: main()
