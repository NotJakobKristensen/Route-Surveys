"""Height above the terrain (surface model − terrain model) anywhere on the route, from each region's official data.
above_ground(region, X, Y) with X, Y in UTM33 (the route's frame) → metres (NaN where unknown).
  DE-BW  LGL nDOM1 (2 km tiles, fetched on demand)
  PL-32  GUGiK NMPT − NMT via WCS 2.0.1 (1 m, EVRF2007)
  DE-BB  LGB bDOM1 − DGM1 (WCS 2.0.1, Berlin included)      DE-MV  LAiV DOM1 − DGM1 (WCS 2.0.1)
  DE-ST  LVermGeo DOM1 − DGM1 (WCS 2.0.1)                    DE-SN  GeoSN DOM1 − DGM1 (WMS GetFeatureInfo, per 1 m cell)
  DE-BY  LDBV DOM20 (range reads of the cloud GeoTIFFs) − DGM1 (1 km tiles)
  DE-TH  no open height service reachable from here (see elev_fetch.INFO['TH'])"""
import io, math, os, functools
import numpy as np
from pyproj import Transformer
from scipy.ndimage import map_coordinates
from hd_sources import C as HDC, _get

U33 = 'EPSG:32633'
_tr = functools.lru_cache(maxsize=16)(lambda a, b: Transformer.from_crs(a, b, always_xy=True))


def _bw(X, Y):
    from hd_bw import sample
    ux, uy = _tr(U33, 'EPSG:25832').transform(X, Y)
    return sample('ndom1', ux, uy, order=0)


WSS = 'https://mapy.geoportal.gov.pl/wss/service/PZGIK'


def _read_asc(text):
    lines = text.splitlines(); hdr = {}; k = 0
    while k < len(lines):
        p = lines[k].split()
        if len(p) == 2 and p[0].lower() in ('ncols', 'nrows', 'xllcorner', 'yllcorner', 'xllcenter', 'yllcenter', 'cellsize', 'nodata_value', 'dx', 'dy'):
            hdr[p[0].lower()] = float(p[1]); k += 1
        else: break
    a = np.loadtxt(io.StringIO('\n'.join(lines[k:])), dtype=np.float32)
    nd = hdr.get('nodata_value'); a[a == nd] = np.nan
    cs = hdr.get('cellsize', hdr.get('dx'))
    x0 = hdr.get('xllcorner', hdr.get('xllcenter', 0) - cs / 2); y0 = hdr.get('yllcorner', hdr.get('yllcenter', 0) - cs / 2)
    return a, x0, y0, cs


def _pl_wcs(cov, url, x0, y0, x1, y1):
    key = f'{cov}_{int(x0)}_{int(y0)}_{int(x1)}_{int(y1)}'
    fn = HDC + 'plwcs/' + key + '.asc'
    q = (f'{url}?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage&COVERAGEID={cov}&FORMAT=image/x-aaigrid'
         f'&SUBSET=x({x0},{x1})&SUBSET=y({y0},{y1})')
    b = _get(q, fn)
    if b is None or b[:1] == b'<': return None
    t = b.decode('latin1')
    k = t.lower().find('ncols')
    if k < 0: return None
    t = t[k:]
    e = t.find('\n--')                     # multipart reply: the grid ends at the next boundary
    if e > 0: t = t[:e]
    return _read_asc(t)


def _pl(X, Y):
    """points grouped into 400 m cells, one small WCS request pair per cell"""
    X = np.asarray(X, float); Y = np.asarray(Y, float)
    out = np.full(X.shape, np.nan, np.float32)
    key = (np.floor(X / 400).astype(np.int64) * 100000 + np.floor(Y / 400).astype(np.int64))
    for k in np.unique(key):
        m = key == k
        out[m] = _pl_cell(X[m], Y[m])
    return out


def _pl_cell(X, Y, both=False):
    ex, ny = _tr(U33, 'EPSG:2180').transform(X, Y)
    x0, y0 = math.floor(ex.min()) - 2, math.floor(ny.min()) - 2; x1, y1 = math.ceil(ex.max()) + 2, math.ceil(ny.max()) + 2
    out = []
    for cov, url in (('DSM_PL-EVRF2007-NH', WSS + '/NMPT/GRID1/WCS/DigitalSurfaceModel'), ('DTM_PL-EVRF2007-NH', WSS + '/NMT/GRID1/WCS/DigitalTerrainModel')):
        g = _pl_wcs(cov, url, x0, y0, x1, y1)
        if g is None: return (np.full(np.shape(X), np.nan, np.float32),) * 2 if both else np.full(np.shape(X), np.nan, np.float32)
        a, gx, gy, cs = g
        H = a.shape[0]
        c = (ex - gx) / cs - 0.5; r = (gy + H * cs - ny) / cs - 0.5
        out.append(map_coordinates(np.nan_to_num(a, nan=float(np.nanmean(a))), [r, c], order=1, mode='nearest'))
    return (out[0], out[1]) if both else np.maximum(out[0] - out[1], 0)


def _pl_local(X, Y):
    """surface and terrain from the GUGiK mosaics fetched for the survey points (NaN outside them)"""
    import hd_hot
    proj = U33
    S = np.asarray(hd_hot._pl_sample(['pl_nmpt.tif'], proj, X, Y), np.float32)
    T = np.asarray(hd_hot._pl_sample(['pl_nmt.tif', 'pl_nmt_ext.tif'], proj, X, Y), np.float32)
    return S, T


def _pl_mixed(X, Y):
    S, T = _pl_local(X, Y)
    out = np.maximum(S - T, 0).astype(np.float32)
    need = ~np.isfinite(out)
    if need.any(): out[need] = _pl(X[need], Y[need])
    return out


os.environ.setdefault('ELEV_CACHE', os.path.join(os.path.dirname(HDC.rstrip('/')), 'elev'))


def _ef(code):
    def f(X, Y):
        import elev_fetch
        return np.maximum(elev_fetch.sample(code, 'ndom', X, Y, crs=U33, method='nearest' if code == 'SN' else 'bilinear'), 0).astype(np.float32)
    return f


SAMPLERS = {'DE-BW': _bw, 'PL-32': _pl_mixed, 'DE-BB': _ef('BB'), 'DE-MV': _ef('MV'), 'DE-ST': _ef('ST'), 'DE-SN': _ef('SN'), 'DE-BY': _ef('BY')}
COARSE = {'DE-SN'}           # one web request per cell: sample sparsely
if os.environ.get('PL_EF') == '1': SAMPLERS['PL-32'] = _ef('PL')      # GUGiK via native-grid blocks, parallel (faster for long lines)
REGIONS = list(SAMPLERS)


def register(reg, fn):
    SAMPLERS[reg] = fn
    if reg not in REGIONS: REGIONS.append(reg)


def above_ground(reg, X, Y):
    f = SAMPLERS.get(reg)
    if f is None: return None
    X = np.asarray(X, float); Y = np.asarray(Y, float)
    return f(X, Y)


def surface_terrain(reg, X, Y):
    """(surface, terrain) heights in m above the datum: needed where the height above the terrain misleads, e.g. on a
    bridge carrying the route (its deck stands above the valley floor of the terrain model)"""
    X = np.asarray(X, float); Y = np.asarray(Y, float)
    if reg == 'DE-BW':
        from hd_bw import sample
        ux, uy = _tr(U33, 'EPSG:25832').transform(X, Y)
        t = sample('dgm1', ux, uy, order=0); return t + sample('ndom1', ux, uy, order=0), t
    if reg == 'PL-32' and os.environ.get('PL_EF') != '1':
        # the survey points' laser mosaics first (hd_pl_fetch.py, local files), the WCS for whatever they do not cover
        S, T = _pl_local(X, Y)
        need = ~(np.isfinite(S) & np.isfinite(T))
        if need.any():
            key = (np.floor(X / 400).astype(np.int64) * 100000 + np.floor(Y / 400).astype(np.int64))
            for k in np.unique(key[need]):
                m = (key == k) & need; S[m], T[m] = _pl_cell(X[m], Y[m], both=True)
        return S, T
    code = {'DE-BB': 'BB', 'DE-MV': 'MV', 'DE-ST': 'ST', 'DE-SN': 'SN', 'DE-BY': 'BY', 'PL-32': 'PL'}.get(reg)
    if code is None: return None, None
    import elev_fetch
    meth = 'nearest' if code == 'SN' else 'bilinear'
    return elev_fetch.sample(code, 'dom', X, Y, crs=U33, method=meth), elev_fetch.sample(code, 'dgm', X, Y, crs=U33, method=meth)
