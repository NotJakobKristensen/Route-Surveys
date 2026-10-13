"""Official open geodata for the survey points (fetch helpers, cached under .cache/route/hd/):
  Baden-Württemberg (LGL, Open GeoData, dl-de/by-2-0): DOP20 aerial photo tiles (GeoWebCache, EPSG:3857, z19),
  DGM1 / nDOM1 / LoD2 2 km tiles (UTM32).
"""
import routecfg
import io, math, os, urllib.request, zipfile
import numpy as np
from PIL import Image

C = routecfg.SHARED + 'hd/'
os.makedirs(C, exist_ok=True)


def _get(url, fn=None, tries=4):
    if fn and os.path.exists(fn): return open(fn, 'rb').read()
    for k in range(tries):
        try:
            b = urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'route-survey'}), timeout=120).read()
            if fn:
                import threading; os.makedirs(os.path.dirname(fn), exist_ok=True); tmp = f'{fn}.{os.getpid()}.{threading.get_ident()}.part'; open(tmp, 'wb').write(b); os.replace(tmp, fn)
            return b
        except urllib.error.HTTPError as e:
            if e.code == 404: return None
            if k == tries - 1: raise
        except Exception:
            if k == tries - 1: raise
        import time; time.sleep(2 ** k)


def _pad(t, r):
    a = 1
    if t > 9: a = int(math.ceil(math.log10(t) - .001)) if t > 11 else 2
    s = r - a
    return '0' * s + str(t) if s > 0 else str(t)


def bw_dop_url(z, x, y):
    """GeoWebCache file layout used by opengeodata.lgl-bw.de/tiles/DOP_20_C (y in TMS order)."""
    n = 2 ** z - 1 - y
    a = 2 ** (z // 2 + 1); s = 1
    if a > 10: s = int(math.log10(a)) + 1
    h = _pad(x // a, s) + '_' + _pad(n // a, s)
    f = _pad(x, 2 * s) + '_' + _pad(n, 2 * s)
    return f'https://opengeodata.lgl-bw.de/tiles/DOP_20_C/GoogleMapsCompatible_{_pad(z, 2)}/{h}/{f}.jpeg'


def bw_dop_tile(z, x, y):
    b = _get(bw_dop_url(z, x, y), C + f'bwdop/{z}/{x}_{y}.jpg')
    return None if b is None else Image.open(io.BytesIO(b)).convert('RGB')


R_EARTH = 6378137.0


def merc(lon, lat):
    x = np.radians(lon) * R_EARTH; y = np.log(np.tan(np.pi / 4 + np.radians(lat) / 2)) * R_EARTH
    return x, y


def xyz_mosaic(tile_fn, lon0, lat0, lon1, lat1, z, workers=12):
    """Mosaic of 256 px XYZ tiles covering the box; returns (rgb uint8 HxWx3, x0, y1, res) in EPSG:3857 (top-left)."""
    from concurrent.futures import ThreadPoolExecutor
    n = 2 ** z
    tx0 = int((lon0 + 180) / 360 * n); tx1 = int((lon1 + 180) / 360 * n)
    ty0 = int((1 - math.asinh(math.tan(math.radians(lat1))) / math.pi) / 2 * n)
    ty1 = int((1 - math.asinh(math.tan(math.radians(lat0))) / math.pi) / 2 * n)
    W, H = (tx1 - tx0 + 1) * 256, (ty1 - ty0 + 1) * 256
    out = np.zeros((H, W, 3), np.uint8)
    jobs = [(x, y) for y in range(ty0, ty1 + 1) for x in range(tx0, tx1 + 1)]
    with ThreadPoolExecutor(workers) as ex:
        for (x, y), im in zip(jobs, ex.map(lambda t: tile_fn(z, *t), jobs)):
            if im is not None:
                out[(y - ty0) * 256:(y - ty0 + 1) * 256, (x - tx0) * 256:(x - tx0 + 1) * 256] = np.asarray(im)
    res = 2 * math.pi * R_EARTH / n / 256
    x0 = -math.pi * R_EARTH + tx0 * 256 * res; y1 = math.pi * R_EARTH - ty0 * 256 * res
    return out, x0, y1, res


def warp_to(img, x0, y1, res, proj, ext, px):
    """Resample a 3857 mosaic onto an axis-aligned grid in `proj` (ext = x0, y0, x1, y1; north up), bilinear."""
    from pyproj import Transformer
    from scipy.ndimage import map_coordinates
    W, H = int(math.ceil((ext[2] - ext[0]) / px)), int(math.ceil((ext[3] - ext[1]) / px))
    t = Transformer.from_crs(proj, 'EPSG:3857', always_xy=True)
    out = np.zeros((H, W, img.shape[2]), np.uint8)
    for r0 in range(0, H, 512):
        rr = np.arange(r0, min(H, r0 + 512))
        X, Y = np.meshgrid(ext[0] + (np.arange(W) + 0.5) * px, ext[3] - (rr + 0.5) * px)
        mx, my = t.transform(X, Y)
        cc = (mx - x0) / res - 0.5; rw = (y1 - my) / res - 0.5
        for b in range(img.shape[2]):
            out[r0:r0 + len(rr), :, b] = np.clip(map_coordinates(img[:, :, b], [rw, cc], order=1, mode='nearest'), 0, 255)
    return out


def wms_getmap(url, layer, crs, bbox, W, H, fmt='image/jpeg', extra='', fn=None, version='1.3.0'):
    """One WMS GetMap (axis order x,y for projected CRS) → RGB uint8 array (None when empty)."""
    b = ','.join(f'{v:.2f}' for v in bbox)
    sep = '&' if '?' in url else '?'
    crsk = 'CRS' if version == '1.3.0' else 'SRS'
    q = (f'{url}{sep}SERVICE=WMS&VERSION={version}&REQUEST=GetMap&LAYERS={layer}&STYLES=&{crsk}={crs}&BBOX={b}'
         f'&WIDTH={W}&HEIGHT={H}&FORMAT={fmt}{extra}')
    data = _get(q, fn)
    if data is None or data[:1] == b'<': return None
    im = Image.open(io.BytesIO(data)).convert('RGB')
    return np.asarray(im)


SOURCES = {
    'DE-BY': dict(kind='wms', url='https://geoservices.bayern.de/od/wms/dop/v1/dop20', layer='by_dop20c', crs='EPSG:25832',
                  res=0.2, maxpx=5000, credit='Bayerische Vermessungsverwaltung – www.geodaten.bayern.de (CC BY 4.0)'),
    'DE-BW': dict(kind='xyz', z=19, credit='LGL, www.lgl-bw.de (dl-de/by-2-0)'),
    'DE-MV': dict(kind='wms', url='https://www.geodaten-mv.de/dienste/adv_dop', layer='mv_dop', crs='EPSG:25833', res=0.2, maxpx=4000,
                  credit='GeoBasis-DE/M-V (CC BY 4.0)'),          # (as the state's height models: elev_fetch.INFO['MV'])
    'DE-BB': dict(kind='wms', url='https://isk.geobasis-bb.de/mapproxy/dop20c/service/wms', layer='bebb_dop20c', crs='EPSG:25833', res=0.2, maxpx=4000,
                  credit='GeoBasis-DE/LGB (dl-de/by-2-0)'),
    'DE-ST': dict(kind='wms', url='https://www.geodatenportal.sachsen-anhalt.de/wss/service/ST_LVermGeo_DOP_WMS_OpenData/guest', layer='lsa_lvermgeo_dop20_2',
                  crs='EPSG:25833', res=0.2, maxpx=4000, credit='GeoBasis-DE/LVermGeo ST (dl-de/by-2-0)'),
    'DE-SN': dict(kind='wms', url='https://geodienste.sachsen.de/wms_geosn_dop-rgb/guest', layer='sn_dop_020', crs='EPSG:25833', res=0.2, maxpx=4000,
                  credit='Geodaten Sachsen, GeoSN (dl-de/by-2-0)'),
    'DE-TH': dict(kind='wms', url='https://www.geoproxy.geoportal-th.de/geoproxy/services/DOP', layer='th_dop', crs='EPSG:25833', res=0.2, maxpx=4000,
                  credit='© GDI-Th (dl-de/by-2-0)'),
    'PL-32': dict(kind='wms', url='https://mapy.geoportal.gov.pl/wss/service/PZGIK/ORTO/WMS/StandardResolutionTime', layer='Raster',
                  crs='EPSG:2180', res=0.25, maxpx=4000, version='1.1.1',
                  credit='Geoportal.gov.pl / GUGiK (Główny Urząd Geodezji i Kartografii)'),
}


def sample_source(reg, X, Y, crs_in='EPSG:32633', cache_key=None, res_m=None):
    """Sample the official aerial photo of region `reg` at points X, Y (crs_in), bilinear; RGB uint8."""
    from pyproj import Transformer
    from scipy.ndimage import map_coordinates
    S = SOURCES[reg]
    out = np.zeros(X.shape + (3,), np.uint8)
    if S['kind'] == 'xyz':
        t = Transformer.from_crs(crs_in, 'EPSG:4326', always_xy=True)
        lon, lat = t.transform(X, Y)
        z = S['z'] if res_m is None else max(12, min(S['z'], int(round(math.log2(156543.0 * math.cos(math.radians(float(lat.mean()))) / res_m)))))
        img, x0, y1, res = xyz_mosaic(bw_dop_tile, lon.min(), lat.min(), lon.max(), lat.max(), z)
        mx, my = merc(lon, lat)
    else:
        t = Transformer.from_crs(crs_in, S['crs'], always_xy=True)
        mx, my = t.transform(X, Y)
        res = S['res'] if res_m is None else max(S['res'], res_m)
        x0 = math.floor(mx.min() / res) * res - 2 * res; x1 = math.ceil(mx.max() / res) * res + 2 * res
        y0 = math.floor(my.min() / res) * res - 2 * res; y1 = math.ceil(my.max() / res) * res + 2 * res
        W = int(round((x1 - x0) / res)); H = int(round((y1 - y0) / res))
        img = np.zeros((H, W, 3), np.uint8)
        step = S['maxpx'] - 8
        for r0 in range(0, H, step):
            for c0 in range(0, W, step):
                w = min(step, W - c0); h = min(step, H - r0)
                bb = (x0 + c0 * res, y1 - (r0 + h) * res, x0 + (c0 + w) * res, y1 - r0 * res)
                fn = C + f'wms/{reg}/{bb[0]:.0f}_{bb[1]:.0f}_{w}x{h}.jpg' if cache_key else None
                a = wms_getmap(S['url'], S['layer'], S['crs'], bb, w, h, fn=fn, version=S.get('version', '1.3.0'))
                if a is not None: img[r0:r0 + h, c0:c0 + w] = a
    cc = (mx - x0) / res - 0.5; rr = (y1 - my) / res - 0.5
    for b in range(3):
        out[..., b] = np.clip(map_coordinates(img[..., b], [rr, cc], order=1, mode='nearest'), 0, 255)
    return out
