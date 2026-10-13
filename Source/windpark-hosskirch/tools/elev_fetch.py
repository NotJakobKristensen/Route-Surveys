#!/usr/bin/env python3
"""elev_fetch - sample official open terrain (DGM/DTM) and surface (DOM/DSM) heights.

    from elev_fetch import sample, info
    z = sample('BB', 'dom', xs, ys, crs='EPSG:25832')     # numpy float64, NaN = no data
    dz = sample('PL', 'ndom', [lon], [lat], crs='EPSG:4326')  # 'ndom' = dom - dgm

Regions: BB (Brandenburg + Berlin), MV, ST (Sachsen-Anhalt), SN (Sachsen), TH (Thueringen),
BY (Bayern), BW (Baden-Wuerttemberg), PL (Poland).  Kinds: 'dgm' (terrain) / 'dom' (surface).

Only small pieces are fetched: 256-pixel WCS blocks around the points (BB, MV, ST, PL), single
cells via WMS GetFeatureInfo (SN), 100 m windows read with HTTP range requests out of the
cloud-readable DOM20 GeoTIFFs (BY dom), or whole 1 km / 2 km tiles of a few MB (BY dgm, BW, TH).
Everything is cached under ./cache (override with ELEV_CACHE); a second call is offline.

Heights are metres above the national datum: DHHN2016 (NHN) in Germany, PL-EVRF2007-NH in
Poland.  Sampling is bilinear between cell centres (method='nearest' for the containing cell);
if one of the four neighbours is missing the nearest cell is used.

Requires numpy, requests, pyproj; rasterio for the GeoTIFF sources (all but SN and PL).
Honours HTTPS_PROXY and REQUESTS_CA_BUNDLE / CURL_CA_BUNDLE.  See README.md for sources,
licences and attribution (all sources need a source credit, see info()).
"""
from __future__ import annotations

import io
import json
import math
import os
import re
import threading
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import requests
from pyproj import Transformer

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.environ.get('ELEV_CACHE', os.path.join(HERE, 'cache'))
UA = 'elev_fetch/1.0 (bridge clearance survey; python-requests)'
_tls = threading.local()


class ElevFetchError(RuntimeError):
    pass


# ----------------------------------------------------------------------------- HTTP
def _session():
    s = getattr(_tls, 's', None)
    if s is None:
        s = _tls.s = requests.Session()
        s.headers['User-Agent'] = UA
    return s


DEBUG = bool(os.environ.get('ELEV_DEBUG'))


def _log(msg):
    if DEBUG:
        print(f'[elev_fetch] {msg}', flush=True)


def _http(url, params=None, timeout=180, tries=4, ok404=False, method='GET', **kw):
    """GET with retries.  Returns the Response, or None for 404 when ok404."""
    last = None
    host = re.sub(r'^https?://([^/]+).*$', r'\1', url)
    for k in range(tries):
        t0 = time.time()
        try:
            r = _session().request(method, url, params=params, timeout=timeout, **kw)
        except requests.exceptions.ProxyError as e:
            # a refused host stays refused, a dropped connection through the proxy is worth a retry
            if '403' in str(e) or k == tries - 1:
                raise ElevFetchError(f'the egress proxy refused {host} (host not allowed?): {e}') from None
            last = e
            time.sleep(2 * 2 ** k)
            continue
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout,
                requests.exceptions.ChunkedEncodingError) as e:
            last = e
            _log(f'{method} {url} failed ({type(e).__name__}), retry {k + 1}')
            time.sleep(2 * 2 ** k)
            continue
        _log(f'{method} {r.url[:160]} -> HTTP {r.status_code} {r.headers.get("Content-Type", "")[:40]} '
             f'{len(r.content) if method != "HEAD" else r.headers.get("Content-Length")} B {time.time() - t0:.1f} s')
        if r.status_code == 404 and ok404:
            return None
        if r.status_code in (429, 500, 502, 503, 504):
            last = f'HTTP {r.status_code}: {r.text[:200]}'
            time.sleep(2 * 2 ** k)
            continue
        if r.status_code >= 400:
            raise ElevFetchError(f'HTTP {r.status_code} from {r.url[:300]}: {r.text[:300]}')
        return r
    raise ElevFetchError(f'giving up on {url} after {tries} tries: {last}')


def _atomic_write(fn, data: bytes):
    os.makedirs(os.path.dirname(fn), exist_ok=True)
    tmp = f'{fn}.{os.getpid()}.{threading.get_ident()}.part'
    with open(tmp, 'wb') as f:
        f.write(data)
    os.replace(tmp, fn)


def _download(url, fn, ok404=True, timeout=600):
    """Download url to fn once (cached).  Returns fn, or None if the server says 404."""
    if os.path.exists(fn):
        return fn
    if os.path.exists(fn + '.404'):
        return None
    r = _http(url, ok404=ok404, timeout=timeout)
    if r is None:
        _atomic_write(fn + '.404', b'')
        return None
    _atomic_write(fn, r.content)
    return fn


# ----------------------------------------------------------------------------- parsers
def _tiff_part(r):
    """Raw TIFF bytes from a WCS response (plain image/tiff or multipart/related)."""
    ct = r.headers.get('Content-Type', '')
    b = r.content
    if 'multipart' not in ct:
        if b[:4] in (b'II*\x00', b'MM\x00*'):
            return b
        raise ElevFetchError(f'unexpected WCS answer ({ct}): {b[:300]!r}')
    m = re.search(r'boundary="?([^";]+)"?', ct)
    bnd = ('--' + m.group(1)).encode() if m else b'--wcs'
    for part in b.split(bnd):
        head, sep, body = part.partition(b'\r\n\r\n')
        if not sep:
            head, sep, body = part.partition(b'\n\n')
        if b'image/tiff' in head:
            return body[:-2] if body.endswith(b'\r\n') else body[:-1] if body.endswith(b'\n') else body
    raise ElevFetchError(f'no TIFF part in multipart WCS answer: {b[:300]!r}')


def _read_tiff(b):
    """(array float32 with NaN, x_left, y_top, res) from GeoTIFF bytes."""
    import rasterio
    from rasterio.io import MemoryFile
    with MemoryFile(b) as mf, mf.open() as d:
        a = d.read(1).astype(np.float32)
        if d.nodata is not None:
            a[a == d.nodata] = np.nan
        t = d.transform
        return a, t.c, t.f, t.a


def _read_aaigrid(text):
    """(array, x_left, y_top, cellsize) from an ARC/INFO ASCII grid (also inside a multipart)."""
    i = text.find('ncols')
    if i < 0:
        raise ElevFetchError(f'no ASCII grid in WCS answer: {text[:300]}')
    body = text[i:]
    head, pos = {}, 0
    while True:
        end = body.index('\n', pos)
        tok = body[pos:end].split()
        if not tok or not tok[0][0].isalpha():
            break
        head[tok[0].lower()] = float(tok[1])
        pos = end + 1
    nr, nc = int(head['nrows']), int(head['ncols'])
    j = body.find('--', pos)
    data = np.array(body[pos:j if j > 0 else None].split()[:nr * nc], dtype=np.float32).reshape(nr, nc)
    cs = head['cellsize']
    xl = head['xllcenter'] - cs / 2 if 'xllcenter' in head else head['xllcorner']
    yl = head['yllcenter'] - cs / 2 if 'yllcenter' in head else head['yllcorner']
    if 'nodata_value' in head:
        data[data == head['nodata_value']] = np.nan
    return data, xl, yl + nr * cs, cs


def _place(dst, x0, y1, res, a, ax, ay, ares):
    """Copy grid a (top-left ax, ay) into dst (top-left x0, y1); both on the same lattice."""
    if abs(ares - res) > 1e-9:
        raise ElevFetchError(f'server returned cell size {ares} instead of {res}')
    c0 = int(round((ax - x0) / res))
    r0 = int(round((y1 - ay) / res))
    H, W = dst.shape
    rs, cs = max(0, r0), max(0, c0)
    re_, ce = min(H, r0 + a.shape[0]), min(W, c0 + a.shape[1])
    if rs < re_ and cs < ce:
        dst[rs:re_, cs:ce] = a[rs - r0:re_ - r0, cs - c0:ce - c0]
    return dst


# ----------------------------------------------------------------------------- grid core
class GridSource:
    """A raster on a regular lattice (cell edges at ox + i*res, oy - j*res), fetched and cached
    in square blocks of `block` cells.  Subclasses implement fetch_block(br, bc)."""

    def __init__(self, key, crs, res, ox=0.0, oy=0.0, block=256, workers=4, zero_is_nodata=False):
        self.key, self.crs, self.res, self.ox, self.oy = key, crs, float(res), float(ox), float(oy)
        self.block, self.workers, self.zero_is_nodata = int(block), workers, zero_is_nodata
        self.cdir = os.path.join(CACHE, *key.split('/'))
        self._mem, self._lock = {}, threading.Lock()

    def block_bounds(self, br, bc):
        s = self.block * self.res
        x0 = self.ox + bc * s
        y1 = self.oy - br * s
        return x0, y1 - s, x0 + s, y1

    def empty_block(self):
        return np.full((self.block, self.block), np.nan, np.float32)

    def fetch_block(self, br, bc):  # -> float32 array (block x block) or None
        raise NotImplementedError

    def _clean(self, a):
        a = np.asarray(a, np.float32)
        a[a < -1000] = np.nan
        if self.zero_is_nodata:
            a[a == 0] = np.nan
        return a

    def get_block(self, br, bc):
        k = (br, bc)
        with self._lock:
            if k in self._mem:
                return self._mem[k]
        fn = os.path.join(self.cdir, f'{br}_{bc}.npy')
        if os.path.exists(fn):
            a = np.load(fn)
        else:
            a = self.fetch_block(br, bc)
            a = np.zeros(0, np.float32) if a is None else self._clean(a)
            if a.size and np.isnan(a).all():
                a = np.zeros(0, np.float32)
            buf = io.BytesIO()
            np.save(buf, a)
            _atomic_write(fn, buf.getvalue())
        a = None if a.size == 0 else a
        with self._lock:
            self._mem[k] = a
            while len(self._mem) > 96:
                self._mem.pop(next(iter(self._mem)))
        return a

    def _gather(self, rows, cols):
        B = self.block
        br, bc = rows // B, cols // B
        keys = sorted(set(zip(br.tolist(), bc.tolist())))
        todo = [k for k in keys if k not in self._mem
                and not os.path.exists(os.path.join(self.cdir, f'{k[0]}_{k[1]}.npy'))]
        if len(todo) > 1 and self.workers > 1:
            with ThreadPoolExecutor(min(self.workers, len(todo))) as ex:
                list(ex.map(lambda k: self.get_block(*k), todo))
        out = np.full(rows.shape, np.nan, np.float32)
        for k in keys:
            a = self.get_block(*k)
            if a is None:
                continue
            m = (br == k[0]) & (bc == k[1])
            out[m] = a[rows[m] - k[0] * B, cols[m] - k[1] * B]
        return out

    def sample(self, x, y, method='bilinear'):
        x = np.asarray(x, np.float64).ravel()
        y = np.asarray(y, np.float64).ravel()
        cf = (x - self.ox) / self.res
        rf = (self.oy - y) / self.res
        rn, cn = np.floor(rf).astype(np.int64), np.floor(cf).astype(np.int64)
        if method == 'nearest':
            return self._gather(rn, cn).astype(np.float64)
        cf, rf = cf - 0.5, rf - 0.5
        c0, r0 = np.floor(cf).astype(np.int64), np.floor(rf).astype(np.int64)
        fx, fy = cf - c0, rf - r0
        R = np.concatenate([r0, r0, r0 + 1, r0 + 1, rn])
        C = np.concatenate([c0, c0 + 1, c0, c0 + 1, cn])
        v = self._gather(R, C).astype(np.float64).reshape(5, -1)
        z = (v[0] * (1 - fx) * (1 - fy) + v[1] * fx * (1 - fy)
             + v[2] * (1 - fx) * fy + v[3] * fx * fy)
        bad = ~np.isfinite(z)
        z[bad] = v[4][bad]
        return z


class WCS20(GridSource):
    """OGC WCS 2.0.1 GetCoverage with SUBSET on the native lattice (MapServer, ArcGIS)."""

    def __init__(self, key, url, coverage, crs, res, fmt='image/tiff', axes=('x', 'y'),
                 extra=None, envelope=None, **kw):
        super().__init__(key, crs, res, **kw)
        self.url, self.coverage, self.fmt, self.axes, self.extra = url, coverage, fmt, axes, extra or []
        self.envelope = envelope  # (xmin, ymin, xmax, ymax) from DescribeCoverage

    def request_params(self, x0, y0, x1, y1):
        return [('SERVICE', 'WCS'), ('VERSION', '2.0.1'), ('REQUEST', 'GetCoverage'),
                ('COVERAGEID', self.coverage), ('FORMAT', self.fmt),
                ('SUBSET', f'{self.axes[0]}({x0:.6f},{x1:.6f})'),
                ('SUBSET', f'{self.axes[1]}({y0:.6f},{y1:.6f})')] + list(self.extra)

    def fetch_block(self, br, bc):
        x0, y0, x1, y1 = self.block_bounds(br, bc)
        e = self.envelope
        if e and (x1 <= e[0] or x0 >= e[2] or y1 <= e[1] or y0 >= e[3]):
            return None  # outside the coverage: no request
        try:
            r = _http(self.url, self.request_params(x0, y0, x1, y1), ok404=True)
        except ElevFetchError as ex:
            if 'ExtentError' in str(ex) or 'does not intersect' in str(ex):
                return None
            raise
        if r is None:  # ArcGIS answers 404 outside its extent
            return None
        if self.fmt == 'image/x-aaigrid':
            a, ax, ay, ares = _read_aaigrid(r.content.decode('latin1'))
        else:
            a, ax, ay, ares = _read_tiff(_tiff_part(r))
        return _place(self.empty_block(), x0, y1, self.res, a, ax, ay, ares)


class TileSource(GridSource):
    """Whole square tiles (tile_m metres, SW corner at multiples of tile_m) = one block each."""

    def __init__(self, key, crs, res, tile_m=1000, **kw):
        super().__init__(key, crs, res, block=int(round(tile_m / res)), **kw)
        self.tile_m = tile_m

    def tile_of_block(self, br, bc):
        x0, y0, _, _ = self.block_bounds(br, bc)
        return int(round(x0 / 1000)), int(round(y0 / 1000))  # SW corner in km


class BavariaDGM1(TileSource):
    URLS = ('https://download1.bayernwolke.de/a/dgm/dgm1/{e}_{n}.tif',
            'https://download2.bayernwolke.de/a/dgm/dgm1/{e}_{n}.tif')

    def __init__(self):
        super().__init__('BY/dgm', 'EPSG:25832', 1.0, 1000)

    def fetch_block(self, br, bc):
        e, n = self.tile_of_block(br, bc)
        fn = os.path.join(CACHE, 'BY', 'tiles', f'dgm1_{e}_{n}.tif')
        if not _download(self.URLS[0].format(e=e, n=n), fn):
            return None
        a, ax, ay, ares = _read_tiff(open(fn, 'rb').read())
        x0, _, _, y1 = self.block_bounds(br, bc)
        out = _place(self.empty_block(), x0, y1, self.res, a, ax, ay, ares)
        os.remove(fn)  # the 1 km block is now cached as .npy
        return out


class BavariaDOM20(GridSource):
    """DOM20 1 km GeoTIFFs (0.2 m, LZW, 256 px internal tiles) read window-wise over HTTP."""
    URL = 'https://download1.bayernwolke.de/a/dom20/DOM/32{e}_{n}_20_DOM.tif'

    def __init__(self):
        super().__init__('BY/dom', 'EPSG:25832', 0.2, block=500, workers=4)  # 100 m blocks
        self._exists = {}

    def fetch_block(self, br, bc):
        import rasterio
        from rasterio.windows import Window
        x0, y0, x1, y1 = self.block_bounds(br, bc)
        e, n = int(math.floor(x0 / 1000 + 1e-9)), int(math.floor(y0 / 1000 + 1e-9))
        url = self.URL.format(e=e, n=n)
        if url not in self._exists:
            self._exists[url] = _http(url, method='HEAD', ok404=True, timeout=60) is not None
        if not self._exists[url]:
            return None
        col = int(round((x0 - e * 1000) / self.res))
        row = int(round(((n + 1) * 1000 - y1) / self.res))
        env = dict(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR', CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tif',
                   GDAL_HTTP_MAX_RETRY='4', GDAL_HTTP_RETRY_DELAY='2', GDAL_HTTP_USERAGENT=UA,
                   VSI_CACHE='TRUE')
        ca = os.environ.get('CURL_CA_BUNDLE') or os.environ.get('REQUESTS_CA_BUNDLE') or os.environ.get('SSL_CERT_FILE')
        if ca:
            env['CURL_CA_BUNDLE'] = ca
        for k in range(3):
            try:
                with rasterio.Env(**env), rasterio.open('/vsicurl/' + url) as d:
                    a = d.read(1, window=Window(col, row, self.block, self.block)).astype(np.float32)
                    if d.nodata is not None:
                        a[a == d.nodata] = np.nan
                    return a
            except rasterio.errors.RasterioIOError as ex:
                err = ex
                time.sleep(2 * 2 ** k)
        raise ElevFetchError(f'range read failed for {url}: {err}')


class ZipTiles(TileSource):
    """1 km sub-tiles inside zip archives (BW 2 km zips; TH 1 km zips).  Members are matched by
    the AdV tile name '_32_{e}_{n}_1_' and read as GeoTIFF or XYZ (cell centres)."""

    def __init__(self, key, crs, res, zip_m, url_fns, **kw):
        super().__init__(key, crs, res, 1000, **kw)
        self.zip_m, self.url_fns = zip_m, url_fns

    def zip_corner(self, e, n):
        raise NotImplementedError

    def fetch_block(self, br, bc):
        e, n = self.tile_of_block(br, bc)
        ze, zn = self.zip_corner(e, n)
        zfn = None
        for fn_url in self.url_fns:
            url = fn_url(ze, zn)
            zfn = _download(url, os.path.join(CACHE, self.key.split('/')[0], 'zips', url.rsplit('/', 1)[1]))
            if zfn:
                break
        if not zfn:
            return None
        z = zipfile.ZipFile(zfn)
        names = [m for m in z.namelist() if f'_32_{e}_{n}_1_' in m or f'_{e}_{n}_1_' in m]
        tif = [m for m in names if m.lower().endswith(('.tif', '.tiff'))]
        xyz = [m for m in names if m.lower().endswith(('.xyz', '.txt'))]
        x0, _, _, y1 = self.block_bounds(br, bc)
        out = self.empty_block()
        if tif:
            a, ax, ay, ares = _read_tiff(z.read(tif[0]))
            return _place(out, x0, y1, self.res, a, ax, ay, ares)
        if xyz:
            p = np.array(z.read(xyz[0]).decode('latin1').replace(',', ' ').split(), np.float64).reshape(-1, 3)
            c = np.floor((p[:, 0] - x0) / self.res).astype(np.int64)
            r = np.floor((y1 - p[:, 1]) / self.res).astype(np.int64)
            ok = (c >= 0) & (c < self.block) & (r >= 0) & (r < self.block)
            out[r[ok], c[ok]] = p[ok, 2]
            return out
        return None


class BWTiles(ZipTiles):
    """LGL Open GeoData: 2 km zips (E odd, N even km) holding four 1 km sub-tiles."""
    def zip_corner(self, e, n):
        return e - ((e - 1) % 2), n - (n % 2)


class THTiles(ZipTiles):
    """TLBG Hoehendaten, 1 km zips.  UNVERIFIED: the host geoportal.geoportal-th.de was blocked."""
    def zip_corner(self, e, n):
        return e, n


class SaxonyGFI(GridSource):
    """GeoSN 'wms_geosn_hoehe' GetFeatureInfo: one request per 1 m cell (cells centred on whole
    metres, values in cm).  Cells are cached in one JSON file per layer."""
    URL = 'https://geodienste.sachsen.de/wms_geosn_hoehe/guest'

    def __init__(self, kind, layer):
        super().__init__(f'SN/{kind}', 'EPSG:25833', 1.0, ox=-0.5, oy=0.5, block=1, workers=8)
        self.layer = layer
        self.fn = os.path.join(self.cdir, 'cells.json')
        self.cells = json.load(open(self.fn)) if os.path.exists(self.fn) else {}

    def _cell(self, rc):
        r, c = rc
        x, y = c, -r  # cell centre
        p = dict(SERVICE='WMS', VERSION='1.3.0', REQUEST='GetFeatureInfo', LAYERS=self.layer,
                 QUERY_LAYERS=self.layer, STYLES='', CRS='EPSG:25833',
                 BBOX=f'{x - 1.5},{y - 1.5},{x + 1.5},{y + 1.5}', WIDTH=3, HEIGHT=3, I=1, J=1,
                 INFO_FORMAT='text/xml', FORMAT='image/png')
        t = _http(self.URL, p, timeout=60).text
        m = re.search(r'Classify\.PixelValue</geobak_20:Name>\s*<geobak_20:Wert>\s*(-?\d+)', t)
        if m:
            return int(m.group(1)) / 100.0
        if 'ServiceException' in t:
            raise ElevFetchError(f'GeoSN GetFeatureInfo error: {t[:300]}')
        return None  # outside Saxony / no data

    def _gather(self, rows, cols):
        keys = [f'{r},{c}' for r, c in zip(rows.tolist(), cols.tolist())]
        todo = sorted(set(k for k in keys if k not in self.cells))
        if todo:
            with ThreadPoolExecutor(self.workers) as ex:
                vals = list(ex.map(lambda k: self._cell(tuple(map(int, k.split(',')))), todo))
            self.cells.update(zip(todo, vals))
            _atomic_write(self.fn, json.dumps(self.cells).encode())
        return np.array([np.nan if self.cells[k] is None else self.cells[k] for k in keys], np.float32)


# ----------------------------------------------------------------------------- registry
PL_OX, PL_OY = 160828.34326572, 796521.669409553  # native lattice of the GUGiK grids (EPSG:2180)
GUGIK = 'https://mapy.geoportal.gov.pl/wss/service/PZGIK'
ST = 'https://www.geodatenportal.sachsen-anhalt.de'
TH = 'https://geoportal.geoportal-th.de/hoehendaten'

INFO = {
    'BB': dict(name='Brandenburg incl. Berlin (LGB)', crs='EPSG:25833', datum='DHHN2016 (NHN)',
               licence='dl-de/by-2-0', attribution='© GeoBasis-DE/LGB, dl-de/by-2-0 (Berlin: © Geoportal Berlin, dl-de/by-2-0)',
               dgm='WCS 2.0.1 https://isk.geobasis-bb.de/ows/dgm_wcs coverage bb_dgm, DGM1 1 m (ALS), GeoTIFF float32',
               dom='WCS 2.0.1 https://isk.geobasis-bb.de/ows/bdom_wcs coverage bb_bdom, bDOM 1 m (image matching), GeoTIFF float32',
               laz='open ALS point clouds are on data.geobasis-bb.de (blocked here, not verified)'),
    'MV': dict(name='Mecklenburg-Vorpommern (LAiV)', crs='EPSG:25833', datum='DHHN2016 (NHN)',
               licence='CC BY 4.0', attribution='© GeoBasis-DE/M-V <year of delivery>, CC BY 4.0',
               dgm='WCS 2.0.1 https://www.geodaten-mv.de/dienste/dgm_wcs coverage mv_dgm (DGM1 1 m), GeoTIFF float32',
               dom='WCS 2.0.1 https://www.geodaten-mv.de/dienste/dom_wcs coverage mv_dom1 (DOM1 1 m), GeoTIFF float32',
               laz='ATOM als_atom: als_download?...&file=3dm_33_{E}_{N}_1.laz (1 km) -> HTTP 401 (login, fee-based), not open'),
    'ST': dict(name='Sachsen-Anhalt (LVermGeo)', crs='EPSG:25832', datum='DHHN2016 (NHN)',
               licence='dl-de/by-2-0', attribution='© GeoBasis-DE / LVermGeo LSA, dl-de/by-2-0',
               dgm=f'WCS 2.0.1 (ArcGIS) {ST}/ows_WCS_ST_DGM1 coverage Coverage1, DGM1 1 m (ALS), multipart GeoTIFF',
               dom=f'WCS 2.0.1 (ArcGIS) {ST}/ows_WCS_ST_DOM1 coverage Coverage1, DOM1 1 m from bDOM (image matching)',
               laz='3D-Messdaten (ALS) are not part of the open data offer'),
    'SN': dict(name='Sachsen (GeoSN)', crs='EPSG:25833', datum='DHHN2016 (NHN)',
               licence='dl-de/by-2-0', attribution='GeoSN, dl-de/by-2-0',
               dgm='WMS GetFeatureInfo https://geodienste.sachsen.de/wms_geosn_hoehe/guest layer gelaendehoehe (DGM 1 m, ALS, cm)',
               dom='WMS GetFeatureInfo ... layer hoehe_oberflaeche (DOM 1 m, ALS, cm)',
               laz='downloads (geocloud.landesvermessung.sachsen.de, www.geodaten.sachsen.de) blocked here, not verified'),
    'TH': dict(name='Thueringen (TLBG)', crs='EPSG:25832', datum='DHHN2016 (NHN)',
               licence='CC BY 4.0 (per geoproxy capabilities)', attribution='© GDI-Th, CC BY 4.0',
               dgm=f'tiles {TH}/DGM/... (UNVERIFIED, host blocked); geoproxy has no WCS, DGM WMS = hillshade only, GetFeatureInfo forbidden',
               dom=f'tiles {TH}/DOM/... (UNVERIFIED, host blocked)',
               laz=f'{TH}/LAS/las_<period>/las_32_{{E}}_{{N}}_1_th_<period>.zip (UNVERIFIED, host blocked)'),
    'BY': dict(name='Bayern (LDBV)', crs='EPSG:25832', datum='DHHN2016 (NHN)',
               licence='CC BY 4.0', attribution='Bayerische Vermessungsverwaltung – www.geodaten.bayern.de, CC BY 4.0',
               dgm='1 km GeoTIFF https://download1.bayernwolke.de/a/dgm/dgm1/{E}_{N}.tif (DGM1 1 m, ~3 MB); '
                   'point API POST https://geoservices.bayern.de/bvvapi/od/hoehen/v1/elevation/list (<=4000 pts, 0.1 m)',
               dom='range reads of https://download1.bayernwolke.de/a/dom20/DOM/32{E}_{N}_20_DOM.tif (DOM20 0.2 m, image matching, ~45 MB/tile)',
               laz='https://geodaten.bayern.de/odd_data/laser/{E}_{N}.laz (1 km, LAS 1.2 PF1, ~150 MB)'),
    'BW': dict(name='Baden-Wuerttemberg (LGL)', crs='EPSG:25832', datum='DHHN2016 (NHN)',
               licence='dl-de/by-2-0', attribution='© LGL, www.lgl-bw.de, dl-de/by-2-0',
               dgm='2 km zip https://opengeodata.lgl-bw.de/data/dgm/dgm1_32_{E}_{N}_2_bw.zip (E odd, N even; XYZ, ~12 MB)',
               dom='2 km zip https://opengeodata.lgl-bw.de/data/dom1/dom1_32_{E}_{N}_2_bw.zip (DOM1 1 m GeoTIFF, ALS, ~10 MB)',
               laz='not open (only the 2000-2005 ALS product is listed, inactive)'),
    'PL': dict(name='Poland (GUGiK)', crs='EPSG:2180', datum='PL-EVRF2007-NH',
               licence='free open data (Polish geodetic law, art. 40a)', attribution='Źródło: Geoportal.gov.pl / GUGiK',
               dgm=f'WCS 2.0.1 {GUGIK}/NMT/GRID1/WCS/DigitalTerrainModel coverage DTM_PL-EVRF2007-NH, 1 m, image/x-aaigrid',
               dom=f'WCS 2.0.1 {GUGIK}/NMPT/GRID1/WCS/DigitalSurfaceModel coverage DSM_PL-EVRF2007-NH, 0.5 m, image/x-aaigrid',
               laz='LIDAR LAS/LAZ is open on opendata.geoportal.gov.pl; index service not identified here'),
}


ENV_BB = (228152, 5690412, 493382, 5939023)      # EPSG:25833 (DescribeCoverage)
ENV_MV = (200000, 5886000, 465000, 6075000)      # EPSG:25833
ENV_ST = (606000, 5646000, 790000, 5882000)      # EPSG:25832
ENV_PL = (PL_OX, 98928.8977745594, 876029.97009323, PL_OY)  # EPSG:2180 (easting, northing)


def _make(region, kind):
    if region == 'BB':
        cov = 'bb_dgm' if kind == 'dgm' else 'bb_bdom'
        return WCS20(f'BB/{kind}', f'https://isk.geobasis-bb.de/ows/{cov[3:]}_wcs', cov, 'EPSG:25833', 1.0,
                     envelope=ENV_BB)
    if region == 'MV':
        if kind == 'dgm':
            return WCS20('MV/dgm', 'https://www.geodaten-mv.de/dienste/dgm_wcs', 'mv_dgm', 'EPSG:25833', 1.0,
                         envelope=ENV_MV, zero_is_nodata=True)
        return WCS20('MV/dom', 'https://www.geodaten-mv.de/dienste/dom_wcs', 'mv_dom1', 'EPSG:25833', 1.0,
                     envelope=ENV_MV, zero_is_nodata=True)
    if region == 'ST':
        return WCS20(f'ST/{kind}', f'{ST}/ows_WCS_ST_{"DGM1" if kind == "dgm" else "DOM1"}', 'Coverage1',
                     'EPSG:25832', 1.0, envelope=ENV_ST, zero_is_nodata=True)
    if region == 'PL':
        if kind == 'dgm':
            return WCS20('PL/dgm', f'{GUGIK}/NMT/GRID1/WCS/DigitalTerrainModel', 'DTM_PL-EVRF2007-NH', 'EPSG:2180', 1.0,
                         fmt='image/x-aaigrid', ox=PL_OX, oy=PL_OY, workers=3, envelope=ENV_PL)
        return WCS20('PL/dom', f'{GUGIK}/NMPT/GRID1/WCS/DigitalSurfaceModel', 'DSM_PL-EVRF2007-NH', 'EPSG:2180', 0.5,
                     fmt='image/x-aaigrid', ox=PL_OX, oy=PL_OY, workers=3, envelope=ENV_PL)
    if region == 'SN':
        return SaxonyGFI(kind, 'gelaendehoehe' if kind == 'dgm' else 'hoehe_oberflaeche')
    if region == 'BY':
        return BavariaDGM1() if kind == 'dgm' else BavariaDOM20()
    if region == 'BW':
        sub, pre = ('dgm', 'dgm1') if kind == 'dgm' else ('dom1', 'dom1')
        return BWTiles(f'BW/{kind}', 'EPSG:25832', 1.0, 2000,
                       [lambda e, n: f'https://opengeodata.lgl-bw.de/data/{sub}/{pre}_32_{e}_{n}_2_bw.zip'])
    if region == 'TH':
        d, p = ('DGM', 'dgm1') if kind == 'dgm' else ('DOM', 'dom1')
        periods = ('2020-2025', '2014-2019')
        fns = [(lambda e, n, per=per: f'{TH}/{d}/{d.lower()}_{per}/{p}_32_{e}_{n}_1_th_{per}.zip') for per in periods]
        fns += [(lambda e, n, per=per: f'{TH}/{d}/{d.lower()}_{per}/{p}_{e}_{n}_1_th_{per}.zip') for per in periods]
        return THTiles(f'TH/{kind}', 'EPSG:25832', 1.0, 1000, fns)
    raise ElevFetchError(f'unknown region {region!r}')


ALIASES = {'BB': 'BB', 'BE': 'BB', 'BERLIN': 'BB', 'BRANDENBURG': 'BB', 'MV': 'MV', 'MECKLENBURG-VORPOMMERN': 'MV',
           'ST': 'ST', 'LSA': 'ST', 'SACHSEN-ANHALT': 'ST', 'SAXONY-ANHALT': 'ST', 'SN': 'SN', 'SACHSEN': 'SN',
           'SAXONY': 'SN', 'TH': 'TH', 'THUERINGEN': 'TH', 'THÜRINGEN': 'TH', 'THURINGIA': 'TH', 'BY': 'BY',
           'BAYERN': 'BY', 'BAVARIA': 'BY', 'BW': 'BW', 'BADEN-WUERTTEMBERG': 'BW', 'BADEN-WÜRTTEMBERG': 'BW',
           'PL': 'PL', 'POLAND': 'PL', 'POLSKA': 'PL'}
KINDS = {'dgm': 'dgm', 'dtm': 'dgm', 'nmt': 'dgm', 'terrain': 'dgm',
         'dom': 'dom', 'dsm': 'dom', 'nmpt': 'dom', 'surface': 'dom', 'ndom': 'ndom'}
_sources, _tr = {}, {}


def region_code(region):
    r = str(region).upper().replace('DE-', '').replace('_', '-').strip()
    if r not in ALIASES:
        raise ElevFetchError(f'unknown region {region!r}; use one of BB MV ST SN TH BY BW PL')
    return ALIASES[r]


def source(region, kind):
    key = (region_code(region), KINDS[kind.lower()])
    if key not in _sources:
        _sources[key] = _make(*key)
    return _sources[key]


def _transform(xs, ys, src, dst):
    if src == dst:
        return xs, ys
    if (src, dst) not in _tr:
        _tr[src, dst] = Transformer.from_crs(src, dst, always_xy=True)
    return _tr[src, dst].transform(xs, ys)


def sample(region, kind, xs, ys, crs='EPSG:25832', method='bilinear'):
    """Heights of `kind` ('dgm' | 'dom' | 'ndom' = dom - dgm) at points xs, ys given in `crs`.
    Returns a float64 numpy array shaped like xs (NaN where the source has no data)."""
    k = KINDS[kind.lower()]
    if k == 'ndom':
        return sample(region, 'dom', xs, ys, crs, method) - sample(region, 'dgm', xs, ys, crs, method)
    xs = np.asarray(xs, np.float64)
    ys = np.asarray(ys, np.float64)
    xs, ys = np.broadcast_arrays(xs, ys)
    src = source(region, k)
    X, Y = _transform(xs.ravel(), ys.ravel(), crs, src.crs)
    return src.sample(np.asarray(X), np.asarray(Y), method).reshape(xs.shape)


def profile(region, line_xy, crs='EPSG:25832', step=1.0, method='bilinear'):
    """Sample dgm and dom every `step` metres along a polyline (N x 2 coordinates in `crs`,
    which must be metric).  Returns dict(s=chainage, x, y, dgm, dom, ndom)."""
    p = np.asarray(line_xy, np.float64)
    seg = np.hypot(*np.diff(p, axis=0).T)
    cs = np.r_[0, np.cumsum(seg)]
    s = np.arange(0, cs[-1] + 1e-9, step)
    x, y = np.interp(s, cs, p[:, 0]), np.interp(s, cs, p[:, 1])
    dgm = sample(region, 'dgm', x, y, crs, method)
    dom = sample(region, 'dom', x, y, crs, method)
    return dict(s=s, x=x, y=y, dgm=dgm, dom=dom, ndom=dom - dgm)


def info(region=None):
    """Source description, datum, licence and attribution (dict, or all regions)."""
    return INFO if region is None else INFO[region_code(region)]


def bavaria_api(xs, ys, crs='EPSG:25832'):
    """DGM heights from the LDBV 'Hoehendienst' REST API (<= 4000 points per call, 0.1 m)."""
    srid = int(crs.split(':')[1])
    pts = np.c_[np.ravel(xs), np.ravel(ys)].tolist()
    out = []
    for i in range(0, len(pts), 4000):
        r = _http('https://geoservices.bayern.de/bvvapi/od/hoehen/v1/elevation/list', method='POST',
                  json={'srid': srid, 'coords': pts[i:i + 4000]})
        out += [c[2] if len(c) > 2 and c[2] is not None else np.nan for c in r.json()['coords']]
    return np.array(out, np.float64).reshape(np.shape(xs))


def laz_url(region, x, y, crs='EPSG:25832'):
    """URL of the open ALS point-cloud tile containing (x, y), where a scheme is known."""
    r = region_code(region)
    if r == 'BY':
        X, Y = _transform(np.array([x]), np.array([y]), crs, 'EPSG:25832')
        return f'https://geodaten.bayern.de/odd_data/laser/{int(X[0] // 1000)}_{int(Y[0] // 1000)}.laz'
    if r == 'TH':  # unverified (host blocked here)
        X, Y = _transform(np.array([x]), np.array([y]), crs, 'EPSG:25832')
        e, n = int(X[0] // 1000), int(Y[0] // 1000)
        return f'{TH}/LAS/las_2020-2025/las_32_{e}_{n}_1_th_2020-2025.zip'
    if r == 'MV':  # exists, but answers 401 (login required)
        X, Y = _transform(np.array([x]), np.array([y]), crs, 'EPSG:25833')
        return ('https://www.geodaten-mv.de/dienste/als_download?index=0&dataset=js213978-a8d5-4k22-v37g-5tk1al5a2904'
                f'&file=3dm_33_{int(X[0] // 1000)}_{int(Y[0] // 1000)}_1.laz')
    raise ElevFetchError(f'no open LAZ tile scheme known for {r}')


if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser(description='Sample official DGM/DOM heights.')
    ap.add_argument('region'), ap.add_argument('kind')
    ap.add_argument('x', type=float), ap.add_argument('y', type=float)
    ap.add_argument('--crs', default='EPSG:4326')
    a = ap.parse_args()
    print(f'{sample(a.region, a.kind, [a.x], [a.y], a.crs)[0]:.2f}')
