"""Baden-Württemberg LGL open data rasters (DGM1, nDOM1) from the 2 km tile zips, sampled on any grid."""
import io, os, zipfile, functools
import numpy as np
import rasterio
from hd_sources import C

T = C + 'bwt/'
os.makedirs(T, exist_ok=True)
AUTO = True       # fetch missing 2 km tiles from the LGL open data portal


@functools.lru_cache(maxsize=64)
def _km_tile(kind, e, n):
    """1 km tile (1000×1000, row 0 = north) of DGM1 or nDOM1 with SW corner (e, n) km; None if missing."""
    e2 = e - ((e - 1) % 2); n2 = n - (n % 2)          # 2 km zip: E odd, N even
    pre = {'dgm1': 'dgm1', 'ndom1': 'ndom1'}[kind]
    fn = T + f'{pre}_32_{e2}_{n2}_2_bw.zip'
    if not os.path.exists(fn):
        if not AUTO: return None
        sub = {'dgm1': 'dgm', 'ndom1': 'ndom1'}[kind]
        from hd_sources import _get
        if _get(f'https://opengeodata.lgl-bw.de/data/{sub}/{pre}_32_{e2}_{n2}_2_bw.zip', fn) is None: return None
    z = zipfile.ZipFile(fn)
    names = [x for x in z.namelist() if f'_32_{e}_{n}_1_' in x]
    if kind == 'dgm1':
        nm = [x for x in names if x.endswith('.xyz')]
        if not nm: return None
        a = np.loadtxt(io.BytesIO(z.read(nm[0])), dtype=np.float32)
        g = np.full((1000, 1000), np.nan, np.float32)
        c = np.floor(a[:, 0] - e * 1000).astype(int); r = 999 - np.floor(a[:, 1] - n * 1000).astype(int)
        ok = (c >= 0) & (c < 1000) & (r >= 0) & (r < 1000); g[r[ok], c[ok]] = a[ok, 2]
        return g
    nm = [x for x in names if x.endswith('.tif')]
    if not nm: return None
    with rasterio.open(io.BytesIO(z.read(nm[0]))) as r:
        a = r.read(1).astype(np.float32); a[a < -1000] = np.nan; t = r.transform
    if a.shape == (1000, 1000) and abs(t.c - e * 1000) < 0.01 and abs(t.f - (n + 1) * 1000) < 0.01: return a
    # border tiles can be cut short: place by their geotransform
    g = np.full((1000, 1000), np.nan, np.float32)
    c0 = int(round(t.c - e * 1000)); r0 = int(round((n + 1) * 1000 - t.f))
    rs, cs = max(0, r0), max(0, c0); re_, ce = min(1000, r0 + a.shape[0]), min(1000, c0 + a.shape[1])
    if rs < re_ and cs < ce: g[rs:re_, cs:ce] = a[rs - r0:re_ - r0, cs - c0:ce - c0]
    return g


def sample(kind, X, Y, order=1):
    """Sample DGM1/nDOM1 at UTM32 coordinates X, Y (arrays), bilinear on the 1 m cell centres."""
    X = np.asarray(X, float); Y = np.asarray(Y, float)
    out = np.full(X.shape, np.nan, np.float32)
    fx = X - 0.5; fy = Y - 0.5
    ek = np.floor(X / 1000).astype(int); nk = np.floor(Y / 1000).astype(int)
    for e, n in set(zip(ek.ravel().tolist(), nk.ravel().tolist())):
        m = (ek == e) & (nk == n)
        if order == 0:                                   # nearest cell: the tile itself is enough
            g = _km_tile(kind, e, n)
            if g is None: continue
            c = np.floor(X[m] - e * 1000).astype(int); r = 999 - np.floor(Y[m] - n * 1000).astype(int)
            ok = (r >= 0) & (r < g.shape[0]) & (c >= 0) & (c < g.shape[1])     # border tiles can be cut short
            v = np.full(len(r), np.nan, np.float32); v[ok] = g[r[ok], c[ok]]; out[m] = v
            continue
        # gather a 1002-wide window including neighbours for seamless bilinear
        win = np.full((1002, 1002), np.nan, np.float32)
        for de in (-1, 0, 1):
            for dn in (-1, 0, 1):
                g = _km_tile(kind, e + de, n + dn)
                if g is None: continue
                # window rows: 0 = north edge of tile n+1 last row
                r0 = 1 - dn * 1000; c0 = 1 + de * 1000
                rs = slice(max(0, r0), min(1002, r0 + 1000)); cs = slice(max(0, c0), min(1002, c0 + 1000))
                if g.shape != (1000, 1000):
                    gg = np.full((1000, 1000), np.nan, np.float32); gg[:min(1000, g.shape[0]), :min(1000, g.shape[1])] = g[:1000, :1000]; g = gg
                win[rs, cs] = g[rs.start - r0:rs.stop - r0, cs.start - c0:cs.stop - c0]
        cx = fx[m] - e * 1000 + 1; ry = (n * 1000 + 1000 - 0.5 - Y[m]) + 1 - 0.0
        if order == 0:
            out[m] = win[np.clip(np.round(ry).astype(int), 0, 1001), np.clip(np.round(cx).astype(int), 0, 1001)]
        else:
            from scipy.ndimage import map_coordinates
            w2 = np.where(np.isnan(win), np.nanmean(win) if np.isfinite(win).any() else 0, win)
            out[m] = map_coordinates(w2, [ry, cx], order=1, mode='nearest')
    return out
