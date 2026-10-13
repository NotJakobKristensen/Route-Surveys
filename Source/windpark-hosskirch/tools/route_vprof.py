"""Vertical alignment of the route for the road view: the road surface height at the route line every 1 m, its cross slope
and the terrain beside the road relative to the road plane — from the states' 1 m laser terrain models (DGM1) measured
across the carriageway instead of the 30 m radar surface model (GLO-30: trees, buildings and tunnel lids in it):
  1. every 1 m the terrain model at 5 points across the carriageway, around the driving line and inside the paved edges:
     a robust line across (the worst point dropped while it is off by more than 0.1 m) gives the height at the route line
     (d = 0) and the cross slope; Saxony answers one 1 m cell per request: the driving line every 5 m there; Baden-
     Württemberg comes in 2 km zips: fetched into memory, read, dropped (BWCells)
  2. no weight on the route's own bridges (the terrain model is the valley floor) and beyond their mapped ends while the
     surface model over the driving line stands 0.5 m above the terrain model (abutments, a deck reaching a tunnel portal),
     in tunnels and under covers (route_tunnels.intervals: the terrain model keeps a soil lid as ground), where the models
     have no data; the deck comes in from the surface model along the driving line (bridges.pkl surf, half weight)
  3. where no state model is reachable (Thuringia: its height host is refused here) or a gap is longer than 300 m:
     Copernicus GLO-30 (elev.npz), weight 0.05 where ESA WorldCover shows trees within 20 m or buildings at 30 m (it maps
     the road itself as built-up), fitted to its lower envelope (asymmetric least squares, p = 0.1) over 500 m, shifted by
     a linear ramp onto the neighbouring fits (median difference over 1 km of overlap) and blended in over 500 m
  4. a penalised smoother on 2 m nodes over the whole route in one banded solve (smoothing length 80 m on DGM1, 150 m on the
     stepped Polish NMT, 500 m on GLO-30), Tukey weights (c = 1.2 m) against what is not the road, and a guard by road
     class: where the fit bends tighter than the class's smallest vertical radius or is steeper than its grade over 20 m,
     λ × 8 there (≤ 4 rounds) — always on motorways, trunks and ramps, on other roads only where the accepted observations
     do not carry the bend (a local road may crest tighter); a tunnel comes out as the Hermite between the portals, the
     straight chord where that bulges more than 0.3 m from it or the chord is steeper than 6 %
  5. cross slope: measured (σ 10 m, Poland 40 m, ±7 %), not within 10 m of headwalls and abutments, linear over bridges and
     tunnels; without DGM1 a motorway carriageway or ramp falls 2.5 % to the right, toward the inside of curves (rolling
     over between 4000 and 2000 m radius on left curves, up to 6 %), other roads 0; measured and default blend over ~100 m
  6. terrain beside the road every 10 m at the offsets XRD: terrain model − (z + q·clamp(d, −R−0.5, L+0.5)), from the
     tiles already cached (VPROF_XFETCH=<m>: fetch missing ones up to that offset; in BW the zips opened for the road and
     ±45 m), so the wide band (±80…300 m) is partly unknown; 0 on the route's bridges (the page keeps their measured rows)
     and under covers (route_tunnels.py: the lid), −32768 where unknown
The samples (step 1, 6 and the surface model at the bridges) are kept in corr/vprof_samp.npz; VPROF_RESAMPLE=1 measures again.
Run after route_bridges.py heights:  python route_vprof.py     (then route_tunnels.py)
→ .cache/route/corr/vprof.npz  z1 f4 per 1 m (screen.npz P), q1 f2 per 1 m, src10 u1 per 10 m (0 gap / GLO-30, 1 DGM1,
  2 deck, 3 tunnel / covered, 4 GLO-30 in a state without DGM1), xrd (offsets, m, left +), xrel i2 cm per 10 m × xrd"""
import routecfg
import io, json, os, pickle, sys, time, zipfile
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import elev                                    # sets ELEV_CACHE: the official tiles are cached once for every route
import elev_fetch as ef
from route_corridor import route, OUT
from pyproj import Transformer
from scipy.linalg import solve_banded
from scipy.ndimage import gaussian_filter1d, median_filter

XRD = np.array([-300, -200, -130, -80, -45, -34, -24, -16, -12, -9, -7, -5, 5, 7, 9, 12, 16, 24, 34, 45, 80, 130, 200, 300], float)
XFETCH = float(os.environ.get('VPROF_XFETCH', 0))   # terrain beside the road: offsets up to here fetch missing tiles (0: cached
                                                    # tiles only; they cover ±45 m on 94–100 % of the grid states)
CODE = {'DE-BB': 'BB', 'DE-BE': 'BB', 'DE-MV': 'MV', 'DE-ST': 'ST', 'DE-SN': 'SN', 'DE-BY': 'BY', 'PL-32': 'PL', 'DE-BW': 'BW', 'DE-TH': 'TH'}
GRID = ('PL', 'MV', 'BB', 'ST', 'BY')           # terrain models in WCS blocks / 1 km tiles (elev_fetch)
NODGM = {'TH'}       # no terrain model reachable (elev_fetch.INFO['TH']: host refused by the egress proxy)
HN = 2.0             # node spacing of the fit (m)
LC = dict(dgm=80.0, glo=500.0)                 # smoothing length (m): λ = (Lc / (2π·HN))⁴
LC_STATE = {'PL': 150.0}                       # the Polish NMT comes in 3–5 m steps of a few cm: smoothed longer
QSIG = {'PL': 40.0}                            # cross slope smoothing along the road (m), default 10
TUKEY = 1.2          # residual (m) beyond which an observation gets no weight
# guard by class: (smallest vertical radius m, steepest grade) — below the design rules (RAA 2008: motorway grade ≈ 4–4.5 %,
# crest ≥ 10 000 m, sag ≥ 5 700 m) so the guard never fights a measured road, only what is left of artefacts
GUARD = {'motorway': (3000.0, 0.07), 'trunk': (2000.0, 0.08), 'primary': (1200.0, 0.10), 'secondary': (600.0, 0.12),
         'tertiary': (600.0, 0.12), 'link': (400.0, 0.08)}
OTHER = (250.0, 0.12)
PIECE = 2000         # samples per sampler call: one large call thrashes elev_fetch's 96-block memory
SAMP = OUT + 'vprof_samp.npz'
_t33 = {}


def _tr(dst):
    if dst not in _t33: _t33[dst] = Transformer.from_crs('EPSG:32633', dst, always_xy=True)
    return _t33[dst]


# ───────────────────────────── sampling ─────────────────────────────
_NO = object()


def _gather_ro(src, rows, cols):
    """an elev_fetch grid's values from blocks already cached (NaN where a block was never fetched): no requests"""
    B = src.block; br, bc = rows // B, cols // B
    out = np.full(rows.shape, np.nan, np.float32)
    for k in set(zip(br.tolist(), bc.tolist())):
        a = src._mem.get(k, _NO)
        if a is _NO:
            fn = os.path.join(src.cdir, f'{k[0]}_{k[1]}.npy')
            if not os.path.exists(fn): continue
            a = np.load(fn); a = a if a.size else None
            with src._lock:
                src._mem[k] = a
                while len(src._mem) > 96: src._mem.pop(next(iter(src._mem)))
        if a is None: continue
        m = (br == k[0]) & (bc == k[1]); out[m] = a[rows[m] - k[0] * B, cols[m] - k[1] * B]
    return out


ZERO = {'PL'}         # grids whose no-data cells come back as 0 (GUGiK beyond the border): read as no data


def heights(code, kind, X, Y, fetch=True):
    """terrain ('dgm') / surface ('dom') heights at UTM33 points (any shape), bilinear; fetch=False: cached tiles only"""
    X = np.asarray(X, float); Y = np.asarray(Y, float)
    if fetch:
        z = ef.sample(code, kind, X, Y, crs='EPSG:32633', method='nearest' if code == 'SN' else 'bilinear')
        if code not in ZERO: return z                        # (else: the blocks are cached now; read them without the zeros)
    src = ef.source(code, kind)
    x, y = _tr(src.crs).transform(X.ravel(), Y.ravel())
    cf = (np.asarray(x) - src.ox) / src.res - 0.5; rf = (src.oy - np.asarray(y)) / src.res - 0.5
    c0 = np.floor(cf).astype(np.int64); r0 = np.floor(rf).astype(np.int64); fx = cf - c0; fy = rf - r0
    g = (lambda r_, c_: np.where((v_ := _gather_ro(src, r_, c_)) == 0, np.nan, v_)) if code in ZERO else (lambda r_, c_: _gather_ro(src, r_, c_))
    v = [g(r0 + a, c0 + b) for a, b in ((0, 0), (0, 1), (1, 0), (1, 1))]
    z = v[0] * (1 - fx) * (1 - fy) + v[1] * fx * (1 - fy) + v[2] * (1 - fx) * fy + v[3] * fx * fy
    bad = ~np.isfinite(z)                       # a neighbour missing: the cell itself (as elev_fetch does)
    if bad.any(): z[bad] = g(np.floor(rf[bad] + 0.5).astype(np.int64), np.floor(cf[bad] + 0.5).astype(np.int64))
    return z.reshape(X.shape)


class BWCells:
    """LGL DGM1 (Baden-Württemberg) at single 1 m cells (nearest, as hd_bw.sample order 0). The cells read so far are kept in
    one shared file; missing ones come from the 2 km zips (E odd, N even): a zip the passage tools keep (hd/bwt) is read in
    place, any other is fetched into memory, read and dropped (≈ 13 MB each; a whole route needs ≈ 120): nothing large stays"""
    FN = routecfg.SHARED + 'elev/BW/dgm1_cells.npz'
    URL = 'https://opengeodata.lgl-bw.de/data/dgm/dgm1_32_{e}_{n}_2_bw.zip'
    KEEP = routecfg.SHARED + 'hd/bwt/dgm1_32_{e}_{n}_2_bw.zip'

    def __init__(self):
        self.k = np.zeros(0, np.int64); self.v = np.zeros(0, np.float32)
        if os.path.exists(self.FN):
            z = np.load(self.FN); self.k, self.v = z['k'], z['v']

    @staticmethod
    def keys(X, Y):
        x, y = _tr('EPSG:25832').transform(np.ravel(X), np.ravel(Y))
        return np.floor(np.asarray(x)).astype(np.int64) * 10_000_000 + np.floor(np.asarray(y)).astype(np.int64)

    def _look(self, kk):
        if not len(self.k): return np.zeros(len(kk), bool), np.full(len(kk), np.nan, np.float32)
        j = np.minimum(np.searchsorted(self.k, kk), len(self.k) - 1); hit = self.k[j] == kk
        return hit, np.where(hit, self.v[j], np.nan).astype(np.float32)

    def _zip(self, e2, n2):
        fn = self.KEEP.format(e=e2, n=n2)
        if os.path.exists(fn): return open(fn, 'rb').read()
        try:
            r = ef._http(self.URL.format(e=e2, n=n2), ok404=True, timeout=300)
        except ef.ElevFetchError as ex:
            print('  BW zip', e2, n2, 'failed:', str(ex)[:120], flush=True); return b''
        return r.content if r is not None else None          # None: no such tile (outside the state)

    def get(self, X, Y, opt=None):
        """terrain at UTM33 points X, Y; opt = (Xo, Yo): wanted too, but only from zips opened for X, Y anyway → (z, zo)"""
        kn = self.keys(X, Y); ko = self.keys(*opt) if opt is not None else np.zeros(0, np.int64)
        miss = np.unique(kn[~self._look(kn)[0]])

        def zipk(k):                                         # the 2 km zip of a cell: SW corner E odd, N even (km)
            e, n_ = (k // 10_000_000) // 1000, (k % 10_000_000) // 1000
            return (e - (e - 1) % 2) * 100_000 + (n_ - n_ % 2)
        todo = np.unique(zipk(miss)) if len(miss) else np.zeros(0, np.int64)
        if len(todo):
            om = np.unique(ko[~self._look(ko)[0]]) if len(ko) else ko
            want = np.unique(np.r_[miss, om[np.isin(zipk(om), todo)]])
            wz = zipk(want)
            print(f'  BW terrain: {len(miss)} cells missing in {len(todo)} zips '
                  f'({sum(os.path.exists(self.KEEP.format(e=int(z // 100_000), n=int(z % 100_000))) for z in todo)} kept by hd/bwt)', flush=True)
            from concurrent.futures import ThreadPoolExecutor
            newk, newv = [], []; t0 = time.time(); i = -1
            with ThreadPoolExecutor(3) as ex:
              for g0 in range(0, len(todo), 6):                 # 6 zips at a time: at most ~80 MB in memory
                futs = {int(z): ex.submit(self._zip, int(z // 100_000), int(z % 100_000)) for z in todo[g0:g0 + 6]}
                for z, fu in futs.items():
                    i += 1; b = fu.result(); cells = want[wz == z]
                    vals = np.full(len(cells), np.nan, np.float32)
                    if b == b'':                         # a failed download: not remembered, tried again next run
                        continue
                    if b is not None:
                        zf = zipfile.ZipFile(io.BytesIO(b)); names = zf.namelist()
                        col = cells // 10_000_000; row = cells % 10_000_000
                        for ek, nk in set(zip((col // 1000).tolist(), (row // 1000).tolist())):
                            nm = [x for x in names if f'_32_{ek}_{nk}_1_' in x and x.endswith('.xyz')]
                            if not nm: continue
                            a = np.array(zf.read(nm[0]).split(), np.float64).reshape(-1, 3)
                            g = np.full((1000, 1000), np.nan, np.float32)
                            c = np.floor(a[:, 0] - ek * 1000).astype(int); r_ = np.floor(a[:, 1] - nk * 1000).astype(int)
                            ok = (c >= 0) & (c < 1000) & (r_ >= 0) & (r_ < 1000); g[r_[ok], c[ok]] = a[ok, 2]
                            m = (col // 1000 == ek) & (row // 1000 == nk)
                            vals[m] = g[row[m] - nk * 1000, col[m] - ek * 1000]
                        del zf, b
                    newk.append(cells); newv.append(vals)
                print(f'  BW zip {i + 1}/{len(todo)} {time.time() - t0:.0f} s', flush=True)
                self._merge(newk, newv); newk, newv = [], []         # kept after every batch: a run resumes
        zn = self._look(kn)[1].reshape(np.shape(X))
        zo = self._look(ko)[1].reshape(np.shape(opt[0])) if opt is not None else None
        return zn, zo

    def _merge(self, newk, newv):
        if not newk: return
        k = np.r_[self.k, np.concatenate(newk)]; v = np.r_[self.v, np.concatenate(newv)]
        k, i = np.unique(k[::-1], return_index=True)          # the newest value of a cell wins
        self.k, self.v = k, v[::-1][i]
        os.makedirs(os.path.dirname(self.FN), exist_ok=True)
        tmp = self.FN + '.part.npz'; np.savez(tmp, k=self.k, v=self.v); os.replace(tmp, self.FN)


def cross_fit(d, z):
    """a robust line across the carriageway through the points (d, z) of each row: (height at d = 0, slope, weight)"""
    w = np.isfinite(z).astype(float); zz = np.nan_to_num(z)
    for it in range(3):
        Sw = w.sum(1); Sd = (w * d).sum(1); Sz = (w * zz).sum(1); Sdd = (w * d * d).sum(1); Sdz = (w * d * zz).sum(1)
        det = Sw * Sdd - Sd ** 2; ok = (Sw >= 3) & (det > 1e-6)
        q = np.where(ok, (Sw * Sdz - Sd * Sz) / np.where(ok, det, 1.0), np.nan)
        z0 = np.where(ok, (Sz - np.nan_to_num(q) * Sd) / np.maximum(Sw, 1), np.nan)
        res = np.abs(zz - (np.nan_to_num(z0)[:, None] + np.nan_to_num(q)[:, None] * d)) * w
        if it == 2: break
        worst = np.argmax(res, 1); drop = (res[np.arange(len(d)), worst] > 0.10) & (Sw > 3)       # vehicles are not in DGM1:
        w[np.nonzero(drop)[0], worst[drop]] = 0                     # a kerb, a raised median, a verge or a noisy cell
    rms = np.sqrt((res ** 2).sum(1) / np.maximum(Sw, 1))
    one = np.isfinite(z).sum(1) >= 1                        # under 3 points: their median, little weight
    med = np.full(len(z), np.nan)
    if one.any(): med[one] = np.nanmedian(z[one], 1)
    z1 = np.where(ok, z0, med)
    wt = np.where(ok, np.where((rms < 0.08) & (np.abs(np.nan_to_num(q)) < 0.10), 1.0, 0.3), np.where(one, 0.2, 0.0))
    q = np.where(np.abs(np.nan_to_num(q, nan=9)) < 0.10, q, np.nan)
    return z1.astype(np.float32), q.astype(np.float32), wt.astype(np.float32)


def worldcover(X, Y):
    """ESA WorldCover 2021 class (10 m) at UTM33 points, read window-wise from the open cloud tiles (3° × 3° COGs)"""
    import rasterio
    from rasterio.windows import from_bounds
    lo, la = _tr('EPSG:4326').transform(np.ravel(X), np.ravel(Y)); lo = np.asarray(lo); la = np.asarray(la)
    out = np.zeros(lo.shape, np.uint8)
    t3 = (np.floor(la / 3) * 3).astype(int) * 1000 + (np.floor(lo / 3) * 3).astype(int)
    for t in np.unique(t3):
        la3, lo3 = t // 1000, t % 1000
        url = f'/vsicurl/https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N{la3:02d}E{lo3:03d}_Map.tif'
        idx = np.nonzero(t3 == t)[0]
        with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR', CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tif'), rasterio.open(url) as r:
            for k in range(0, len(idx), 3000):                     # ~10 km of route per window read
                m = idx[k:k + 3000]
                win = from_bounds(lo[m].min() - 0.001, la[m].min() - 0.001, lo[m].max() + 0.001, la[m].max() + 0.001, r.transform).round_offsets().round_lengths()
                a = r.read(1, window=win)
                rr, cc = rasterio.transform.rowcol(r.transform, lo[m], la[m])
                rr = np.clip(np.asarray(rr) - int(win.row_off), 0, a.shape[0] - 1); cc = np.clip(np.asarray(cc) - int(win.col_off), 0, a.shape[1] - 1)
                out[m] = a[rr, cc]
    return out.reshape(np.shape(X))


# ───────────────────────────── fit ─────────────────────────────
def _penalty(lam, n):
    """the five diagonals of D2ᵀ·diag(λ)·D2 (second differences of n nodes, λ per difference row) for solve_banded"""
    lp = np.zeros(n + 2); lp[2:n] = lam                       # lp[c + 2] = λ of the row starting at node c
    main = lp[2:n + 2] + 4 * lp[1:n + 1] + lp[0:n]
    off1 = -2 * (lp[2:n + 1] + lp[1:n]); off2 = lp[2:n]
    ab = np.zeros((5, n)); ab[0, 2:] = off2; ab[1, 1:] = off1; ab[2] = main; ab[3, :-1] = off1; ab[4, :-2] = off2
    return ab


def solve(zobs, w, lam):
    ab = _penalty(lam, len(zobs)); ab[2] += w
    return solve_banded((2, 2), ab, w * np.nan_to_num(zobs), check_finite=False)


def robust(zobs, w0, wfix, zfix, lam, it=8):
    """penalised smoother with Tukey reweighting of the observations (w0); (wfix, zfix) are observations kept as they are"""
    w = w0.copy()
    for _ in range(it):
        ww = w + wfix; zz = np.where(ww > 0, (w * np.nan_to_num(zobs) + wfix * np.nan_to_num(zfix)) / np.maximum(ww, 1e-12), 0.0)
        zf = solve(zz, ww, lam)
        u = np.where(np.isfinite(zobs), (zobs - zf) / TUKEY, 0.0)
        w = w0 * np.where(np.abs(u) < 1, (1 - u ** 2) ** 2, 0.0)
    return zf, w


def runs(m):
    """[(a, b)] index ranges (b exclusive) of the True runs of a boolean array"""
    if not m.any(): return []
    d = np.diff(np.r_[0, m.astype(np.int8), 0]); return list(zip(np.nonzero(d == 1)[0], np.nonzero(d == -1)[0]))


# ───────────────────────────── main ─────────────────────────────
def main():
    import route_tunnels
    t0 = time.time()
    r = route(); P = r['P']; s = r['s']; N = r['N']; SEG = r['SEG']; HW = r['HW']; n = len(s)
    Ru = pickle.load(open(routecfg.C + 'route.pkl', 'rb'))
    S1 = np.load(OUT + 'survey_1m.npz'); E = np.load(OUT + 'elev.npz')
    REG = pickle.load(open(OUT + 'regions.pkl', 'rb'))['lab']
    BRG = pickle.load(open(OUT + 'bridges.pkl', 'rb'))
    RB = sorted(BRG['route'] or [], key=lambda b: b['s0'])
    TUN = route_tunnels.intervals()
    COV = [t for t in TUN if t['kind'] != 'underbridge']    # under a mapped bridge the terrain model is the road
    code = np.array([CODE.get(x, '') for x in REG])[np.minimum(len(REG) - 1, (s // 500).astype(int))]
    cls = np.array([q[0]['cls'] for q in Ru]); link = np.array([q[0].get('sub') == 'link' or any('is_link' in (f.get('values') or []) for f in (q[0].get('flags') or [])) for q in Ru])
    C1 = cls[SEG]; K1 = link[SEG]
    # edges (survey_1m, m from the route line) without spikes; the driving line between them
    L, R = (np.clip(median_filter(np.where(np.isfinite(S1[k]), S1[k], HW).astype(np.float32), 51, mode='nearest'), 1.0, 16.0) for k in ('L', 'R'))
    sh = np.nan_to_num(S1['shift'].astype(np.float32))
    hw = np.clip(0.35 * (L + R), 1.2, 3.75)                 # half the measured span around the driving line (≤ two lanes)
    # default cross slope (no terrain model): a motorway carriageway / a ramp falls 2.5 % to the outside (right, q > 0) and
    # toward the inside of curves (left curve under 2000 m: q < 0); two-way roads are crowned: 0 at the route line's plane
    Ps = gaussian_filter1d(P, 25, axis=0, mode='nearest'); T = np.gradient(Ps, axis=0)
    th = np.unwrap(np.arctan2(T[:, 1], T[:, 0])); kap = gaussian_filter1d(np.gradient(th) / np.maximum(np.gradient(s), 1e-6), 25)
    k_ = gaussian_filter1d(kap, 50); Rc = 1 / np.maximum(np.abs(k_), 1e-6)
    e = np.clip(0.025 + 0.035 * (2000 - Rc) / 1500, 0.025, 0.06)          # 2.5 % … 6 % (R ≤ 500 m)
    roll = np.clip((k_ - 1 / 4000) / (1 / 2000 - 1 / 4000), 0, 1)          # left curves roll over between 4000 and 2000 m
    dual = (C1 == 'motorway') | K1
    qd = np.where(dual, np.where(k_ < 0, e, np.where(k_ < 1 / 2000, 0.025 - 0.05 * roll, -e)), 0.0).astype(np.float32)
    i10 = np.arange(0, n, 10); n10 = len(i10)
    print(f'route {s[-1] / 1000:.1f} km, {n} samples; covered pieces {len(TUN)} ({len(COV)} lids), route bridges {len(RB)}', flush=True)

    # ── 1, 6: terrain across the carriageway every 1 m, beside the road every 10 m; the surface model at the bridges ──
    fr = np.array([-1.0, -0.5, 0.0, 0.5, 1.0])
    near = np.abs(XRD) <= XFETCH; bwnear = np.abs(XRD) <= 45.0     # (LGL zips are quick: BW fetches ±45 m)
    BRWIN = [(b['s0'] - 60, b['s1'] + 60) for b in RB]
    bwin = np.zeros(n, bool)
    for a, b in BRWIN: bwin[np.searchsorted(s, a):np.searchsorted(s, b)] = True
    key = dict(n=n, s_end=round(float(s[-1]), 2), xrd=XRD.tolist(), survey=os.path.getmtime(OUT + 'survey_1m.npz'), nb=len(RB))
    smp = None
    if os.path.exists(SAMP) and os.environ.get('VPROF_RESAMPLE') != '1':
        z = np.load(SAMP)
        if json.loads(str(z['key'])) == key: smp = {k: z[k] for k in z.files}; print('samples from', SAMP, flush=True)
    if smp is None:
        Z0 = np.full(n, np.nan, np.float32); Q = np.full(n, np.nan, np.float32); WQ = np.zeros(n, np.float32)
        XR = np.full((n10, len(XRD)), np.nan, np.float32); DOM = np.full(n, np.nan, np.float32)
        def xpts(ii, off):
            return P[ii, 0][:, None] + N[ii, 0][:, None] * off, P[ii, 1][:, None] + N[ii, 1][:, None] * off
        for c in GRID:
            ia = np.nonzero(code == c)[0]
            if not len(ia): continue
            t1 = time.time()
            for k in range(0, len(ia), PIECE):
                ii = ia[k:k + PIECE]; d = sh[ii, None] + hw[ii, None] * fr
                X, Y = xpts(ii, d); Z0[ii], Q[ii], WQ[ii] = cross_fit(d, heights(c, 'dgm', X, Y))
                j = ii[ii % 10 == 0] // 10
                for sel, fe in ((near, True), (~near, False)):
                    if len(j) and sel.any(): X, Y = xpts(j * 10, XRD[sel]); XR[j[:, None], np.nonzero(sel)[0][None]] = heights(c, 'dgm', X, Y, fetch=fe)
                ib = ii[bwin[ii]][::2]
                if len(ib): DOM[ib] = heights(c, 'dom', P[ib, 0] + N[ib, 0] * sh[ib], P[ib, 1] + N[ib, 1] * sh[ib], fetch=False)
            print(f'  {c}: {len(ia) / 1000:.1f} km measured, terrain at {np.isfinite(Z0[ia]).mean() * 100:.1f} % ({time.time() - t1:.0f} s)', flush=True)
        # the 500 m state labels overlap the borders: what one grid left empty, a neighbour's cached tiles may hold
        for c in GRID:
            ia = np.nonzero(np.isin(code, GRID) & (code != c) & ~np.isfinite(Z0))[0]
            if len(ia):
                d = sh[ia, None] + hw[ia, None] * fr; X, Y = xpts(ia, d)
                z0_, q_, w_ = cross_fit(d, heights(c, 'dgm', X, Y, fetch=False)); k = np.isfinite(z0_)
                Z0[ia[k]], Q[ia[k]], WQ[ia[k]] = z0_[k], q_[k], w_[k]
            j = np.nonzero(np.isin(code[i10], GRID) & (code[i10] != c) & np.isnan(XR).any(1))[0]
            if len(j):
                X, Y = xpts(j * 10, XRD); z_ = heights(c, 'dgm', X, Y, fetch=False); XR[j] = np.where(np.isnan(XR[j]), z_, XR[j])
        ia = np.nonzero(code == 'BW')[0]
        if len(ia):
            t1 = time.time(); bw = BWCells()
            d = sh[ia, None] + hw[ia, None] * fr; X, Y = xpts(ia, d)
            j = ia[ia % 10 == 0] // 10
            Xn, Yn = xpts(j * 10, XRD[bwnear]); Xf, Yf = xpts(j * 10, XRD[~bwnear])
            zz, zf = bw.get(np.r_[X.ravel(), Xn.ravel()], np.r_[Y.ravel(), Yn.ravel()], opt=(Xf, Yf))
            Z0[ia], Q[ia], WQ[ia] = cross_fit(d, zz[:X.size].reshape(X.shape))
            XR[j[:, None], np.nonzero(bwnear)[0][None]] = zz[X.size:].reshape(Xn.shape); XR[j[:, None], np.nonzero(~bwnear)[0][None]] = zf
            print(f'  BW: {len(ia) / 1000:.1f} km measured, terrain at {np.isfinite(Z0[ia]).mean() * 100:.1f} % ({time.time() - t1:.0f} s)', flush=True)
        # Saxony: one request per 1 m cell — the driving line every 5 m (the cells a neighbour's model already holds first)
        ia = np.nonzero(code == 'SN')[0]
        if len(ia):
            t1 = time.time()
            for c in ('ST', 'BB'):                          # the 500 m state labels overlap the borders
                m = ~np.isfinite(Z0[ia])
                if not m.any(): break
                ii = ia[m]; d = sh[ii, None] + hw[ii, None] * fr; X, Y = xpts(ii, d)
                Z0[ii], Q[ii], WQ[ii] = cross_fit(d, heights(c, 'dgm', X, Y, fetch=False))
            ii = ia[~np.isfinite(Z0[ia])]; ii = ii[ii % 5 == 0]
            for k in range(0, len(ii), 400):
                q = ii[k:k + 400]
                z = heights('SN', 'dgm', P[q, 0] + N[q, 0] * sh[q], P[q, 1] + N[q, 1] * sh[q])
                Z0[q] = z - qd[q] * sh[q]; WQ[q] = np.where(np.isfinite(z), 1.0, 0.0)
            print(f'  SN: {len(ia) / 1000:.1f} km, {len(ii)} cells along the driving line ({time.time() - t1:.0f} s)', flush=True)
        smp = dict(Z0=Z0, Q=Q, WQ=WQ, XR=XR, DOM=DOM)
        np.savez(SAMP, key=json.dumps(key), **smp)
    Z0, Q, WQ, XR, DOM = (smp[k] for k in ('Z0', 'Q', 'WQ', 'XR', 'DOM'))
    print(f'measured in {time.time() - t0:.0f} s', flush=True)

    # ── 2: masks and the decks ──
    W1 = np.where(np.isfinite(Z0), WQ, 0.0).astype(np.float64)
    deck = np.zeros(n, bool); cov = np.zeros(n, bool)
    Zd = np.full(n, np.nan); Wd = np.zeros(n)              # deck observations (route line height)
    ext = []
    Tsh = Z0 + np.nan_to_num(Q) * sh                       # terrain at the driving line
    gap = DOM - Tsh                                         # surface over the driving line above it (sampled every 2 m)

    def reach(a, b, back):
        """m the deck reaches beyond a mapped end: from the end into [a, b] while the surface stands ≥ 0.5 m above the
        terrain model (median of 5 samples), starting within 4 m of the end"""
        jj = np.arange(np.searchsorted(s, a), np.searchsorted(s, b)); jj = jj[np.isfinite(gap[jj])]
        if len(jj) < 3: return None                         # no surface model cached here
        if back: jj = jj[::-1]
        v = median_filter(gap[jj], 5, mode='nearest'); end = b if back else a
        if abs(s[jj[0]] - end) > 4 or v[0] < 0.5: return 0.0
        k = np.argmax(v < 0.5) if (v < 0.5).any() else len(v)
        return float(abs(s[jj[k - 1]] - end))

    for b in RB:
        e0, e1 = reach(b['s0'] - 60, b['s0'], True), reach(b['s1'], b['s1'] + 60, False)
        sv = b['sa'] + b['step'] * np.arange(len(b['surf'])) if b.get('surf') is not None else np.zeros(0)
        if (e0 is None or e1 is None) and len(sv):           # no surface model cached here: the bridge record's own ends
            sf = np.asarray(b['surf'], float); s0_, s1_ = sf[sv < b['s0']][-2:], sf[sv > b['s1']][:2]
            if e0 is None: e0 = 12.0 if len(s0_) and np.isfinite(s0_).any() and np.nanmedian(s0_) > 0.6 else 0.0
            if e1 is None: e1 = 12.0 if len(s1_) and np.isfinite(s1_).any() and np.nanmedian(s1_) > 0.6 else 0.0
        e0, e1 = e0 or 0.0, e1 or 0.0
        a0, a1 = np.searchsorted(s, [b['s0'] - e0 - 3, b['s1'] + e1 + 3])
        W1[a0:a1] = 0; deck[np.searchsorted(s, b['s0'] - e0):np.searchsorted(s, b['s1'] + e1)] = True
        if e0 or e1: ext.append((round(b['s0']), round(e0), round(e1)))
        # deck heights: the bridge record's line through the terrain at its ends + its surface over the driving line
        if len(sv):
            sf = np.asarray(b['surf'], float); kk = np.clip(np.searchsorted(s, sv), 0, n - 1)
            ends = ((sv < b['s0'] - 3) | (sv > b['s1'] + 3)) & np.isfinite(Tsh[kk])
            if ends.sum() >= 2:
                a_, c_ = np.polyfit(sv[ends], Tsh[kk][ends], 1)
                ok = np.isfinite(sf) & (np.abs(sf) < 12) & (sv >= b['s0']) & (sv <= b['s1'])
                if ok.sum():
                    sm = median_filter(np.where(np.isfinite(sf), sf, np.nanmedian(sf[ok])), 5, mode='nearest')
                    Zd[kk[ok]] = a_ * sv[ok] + c_ + sm[ok] - qd[kk[ok]] * sh[kk[ok]]; Wd[kk[ok]] = 0.5
        for lo_, hi_ in ((b['s0'] - e0, b['s0']), (b['s1'], b['s1'] + e1)):       # the extension: the surface model itself
            if hi_ - lo_ < 1: continue
            jj = np.arange(np.searchsorted(s, lo_), np.searchsorted(s, hi_))
            jj = jj[np.isfinite(DOM[jj])]
            if len(jj): Zd[jj] = median_filter(DOM[jj], 5, mode='nearest') - qd[jj] * sh[jj]; Wd[jj] = 0.5
    for t in COV:
        a0, a1 = np.searchsorted(s, [t['s0'] - 3, t['s1'] + 3]); W1[a0:a1] = 0; Wd[a0:a1] = 0
        cov[np.searchsorted(s, t['s0']):np.searchsorted(s, t['s1'])] = True
    print('decks beyond their mapped ends (s0, m before, m after):', ext[:40], '…' if len(ext) > 40 else '', flush=True)

    # ── nodes ──
    nn = int(np.ceil(s[-1] / HN)) + 1; sn = np.arange(nn) * HN
    j1 = np.clip(np.round(s / HN).astype(int), 0, nn - 1)
    Wn = np.bincount(j1, W1, nn); Zn = np.bincount(j1, W1 * np.nan_to_num(Z0), nn) / np.maximum(Wn, 1e-12)
    Wdn = np.bincount(j1, Wd, nn); Zdn = np.bincount(j1, Wd * np.nan_to_num(Zd), nn) / np.maximum(Wdn, 1e-12)
    wobs = Wn + Wdn; zobs = np.where(wobs > 0, (Wn * Zn + Wdn * Zdn) / np.maximum(wobs, 1e-12), np.nan)
    covn = np.bincount(j1, cov, nn) > 0; deckn = np.bincount(j1, deck, nn) > 0
    # stretches without a terrain model: none within 150 m either side → GLO-30 (one run across the bridges in it; a cover
    # ends a run: its lid is in GLO-30)
    have = np.convolve((wobs > 0).astype(float), np.ones(151), 'same') > 0      # terrain or deck observations
    glo = ~have & ~covn
    gruns = [(a, b) for a, b in runs(glo) if (b - a) * HN >= 300]
    glo[:] = False
    for a, b in gruns: glo[a:b] = True
    z10 = np.interp(sn, E['s'], E['z0'])                     # GLO-30 at the route line (route_elev.py)
    lam_d = (LC['dgm'] / (2 * np.pi * HN)) ** 4; lam_g = (LC['glo'] / (2 * np.pi * HN)) ** 4
    lam = np.full(nn - 2, lam_d)
    cnode = code[np.clip(np.searchsorted(s, sn), 0, n - 1)]
    for c, lc in LC_STATE.items(): lam[cnode[1:-1] == c] = (lc / (2 * np.pi * HN)) ** 4
    gl = glo[1:-1] | glo[:-2] | glo[2:]; lam[gl] = lam_g
    prior = np.where(glo, 1e-4, 0.0)                         # keeps the solve well posed across long stretches without data
    zA, wA = robust(zobs, wobs, prior, z10, lam)
    print(f'first fit {time.time() - t0:.0f} s', flush=True)

    # ── 3: GLO-30 where no state model is reachable ──
    zg = np.full(nn, np.nan); wg = np.zeros(nn)
    if gruns:
        s10 = E['s']
        for a, b in gruns:
            k0, k1 = np.searchsorted(s10, [sn[a] - 1200, sn[b - 1] + 1200]); k1 = max(k1, k0 + 3)    # 1 km overlap each side
            ii = np.clip(np.searchsorted(s, s10[k0:k1]), 0, n - 1)
            try:                                             # WorldCover maps the road itself as built-up: buildings only at ±30 m
                o_ = np.array([-30, -20, -10, 0, 10, 20, 30])
                wc = worldcover(P[ii, 0][:, None] + N[ii, 0][:, None] * o_, P[ii, 1][:, None] + N[ii, 1][:, None] * o_)
                wcov = np.where((wc[:, 1:-1] == 10).any(1) | (wc[:, [0, -1]] == 50).any(1), 0.05, 1.0)
            except Exception as ex:
                print('  WorldCover unreadable here:', repr(ex)[:100], '→ GLO-30 unweighted', flush=True); wcov = np.ones(len(ii))
            zo = E['z0'][k0:k1].astype(float); f = zo.copy(); lam10 = np.full(len(zo) - 2, (LC['glo'] / (2 * np.pi * 10.0)) ** 4)
            wcov = wcov * ~deck[ii]                         # a valley under a bridge is no lower envelope of the road
            for _ in range(12):                              # asymmetric least squares: the lower envelope
                ww = wcov * np.where(zo > f, 0.1, 0.9) + 1e-6; f = solve(zo, ww, lam10)
            fg = np.interp(sn[a:b], s10[k0:k1], f)
            # a linear ramp onto the terrain-model fits on both sides (one side only at the route's ends): the offset is the
            # median of (terrain-model fit − envelope) over the 1 km before / after the run where the terrain model held
            def offset(lo_, hi_):
                j = np.arange(max(0, lo_), min(nn, hi_)); j = j[wA[j] > 0]
                return float(np.median(zA[j] - np.interp(sn[j], s10[k0:k1], f))) if len(j) > 50 else None
            oa = offset(a - int(1000 / HN), a); ob = offset(b, b + int(1000 / HN))
            oa = ob if oa is None else oa; ob = oa if ob is None else ob
            off = np.zeros(b - a) if oa is None else oa + (ob - oa) * (sn[a:b] - sn[a]) / max(HN, sn[b - 1] - sn[a])
            zr = fg + off
            # no kink at the joints: from the continuation of the terrain-model fit into the ramped curve over 500 m (cosine)
            u = sn[a:b] - sn[a]; v = sn[b - 1] - sn[a:b]; L_ = min(500.0, (sn[b - 1] - sn[a]) / 2)
            for ok_, dist in ((a > 0 and wA[max(0, a - 200):a].sum() > 0, u), (b < nn and wA[b:b + 200].sum() > 0, v)):
                if ok_:
                    w_ = np.where(dist < L_, 0.5 + 0.5 * np.cos(np.pi * np.clip(dist / L_, 0, 1)), 0.0); zr = w_ * zA[a:b] + (1 - w_) * zr
            zg[a:b] = zr; wg[a:b] = np.where(deckn[a:b], 0.0, 0.3)
            print(f'  GLO-30 {sn[a] / 1000:.1f}–{sn[b - 1] / 1000:.1f} km: trees / buildings within 20 m on {np.mean(wcov < 1) * 100:.0f} %, '
                  f'ramp {0 if oa is None else oa:+.2f} → {0 if ob is None else ob:+.2f} m', flush=True)

    # ── 4: the final fit: tunnels straight where the Hermite bulges, the guard by road class ──
    cn = C1[np.clip(np.searchsorted(s, sn), 0, n - 1)]; kn = K1[np.clip(np.searchsorted(s, sn), 0, n - 1)]
    Rmin = np.where(kn, GUARD['link'][0], np.select([cn == c for c in GUARD], [GUARD[c][0] for c in GUARD], OTHER[0]))
    gmax = np.where(kn, GUARD['link'][1], np.select([cn == c for c in GUARD], [GUARD[c][1] for c in GUARD], OTHER[1]))
    wfix = wg.copy() + prior; zfix = np.where(wg > 0, zg, z10)
    # motorways, trunks and ramps never bend tighter than their guard; a local road can (a crest on the way to the site): there
    # the guard only acts where the first fit's accepted observations do not carry the bend
    strict = np.isin(cn, ['motorway', 'trunk']) | kn
    chord = {}
    for rnd in range(6):
        zf, wt = robust(zobs, wobs, wfix, zfix, lam)
        if rnd == 0: carried = np.convolve(((wobs > 0) & (wt > 0.5 * wobs)).astype(float), np.ones(11), 'same') >= 8
        changed = False
        for t in COV:
            a, b = int(round(t['s0'] / HN)), int(round(t['s1'] / HN))
            if b - a < 3 or (a, b) in chord: continue
            ch = zf[a] + (zf[b] - zf[a]) * (sn[a:b + 1] - sn[a]) / (sn[b] - sn[a])
            bulge = np.abs(zf[a:b + 1] - ch).max(); g = (zf[b] - zf[a]) / (sn[b] - sn[a])
            if bulge > 0.3 or abs(g) > 0.06:
                m = slice(a + max(1, (b - a) // 10), b - max(1, (b - a) // 10) + 1)
                wfix[m] += 1.0; zfix[m] = ch[m.start - a:m.stop - a]; chord[(a, b)] = (round(bulge, 2), round(g * 100, 2)); changed = True
        if rnd < 4:
            cur = np.abs(np.diff(zf, 2)) / HN ** 2; grd = np.abs(np.gradient(zf, HN))
            v = ((cur > 1 / Rmin[1:-1]) | (grd[1:-1] > gmax[1:-1])) & (strict[1:-1] | ~carried[1:-1])
            viol = [(a, b) for a, b in runs(v) if b - a >= 10]
            for a, b in viol: lam[max(0, a - 10):b + 10] *= 8.0
            if viol: changed = True; print(f'  guard round {rnd + 1}: {len(viol)} stretches stiffened', flush=True)
        if not changed: break
    z1 = np.interp(s, sn, zf).astype(np.float32)
    print(f'fit {time.time() - t0:.0f} s; tunnels / covers fitted straight (bulge m, grade %): {chord}', flush=True)

    # ── 5: cross slope ──
    ok = np.isfinite(Q) & (W1 > 0) & (WQ >= 1.0) & ~(np.convolve(deck | cov, np.ones(21), 'same') > 0)   # not at headwalls / abutments
    qm = np.where(ok, Q, 0.0); wq = ok.astype(float)
    num = gaussian_filter1d(qm, 10); den = gaussian_filter1d(wq, 10)
    for c, sg in QSIG.items():
        m = code == c
        if m.any(): num[m] = gaussian_filter1d(qm, sg)[m]; den[m] = gaussian_filter1d(wq, sg)[m]
    qmeas = np.where(den > 0.05, num / np.maximum(den, 1e-9), qd)
    wm = np.clip(gaussian_filter1d(wq, 50) / 0.5, 0, 1)    # measured ↔ default over ~100 m, no twist where they meet
    q1 = gaussian_filter1d(wm * qmeas + (1 - wm) * qd, 3)
    for a, b in runs(deck | cov):                           # bridges, tunnels: linear between the values 10 m outside
        ka, kb = max(0, a - 10), min(n - 1, b + 10); q1[a:b] = np.interp(s[a:b], [s[ka], s[kb]], [q1[ka], q1[kb]])
    q1 = np.clip(q1, -0.07, 0.07)

    # ── 6: terrain beside the road relative to the road plane ──
    Ls, Rs = L[i10], R[i10]
    plane = z1[i10][:, None] + q1[i10][:, None] * np.clip(XRD[None], -Rs[:, None] - 0.5, Ls[:, None] + 0.5)
    xr = np.round((XR - plane) * 100)
    xrel = np.where(np.isfinite(xr), np.clip(xr, -4000, 4000), -32768).astype(np.int16)
    zero = (deck | cov)[i10]; xrel[zero] = 0

    # ── sources per 10 m ──
    src = np.zeros(n, np.uint8)
    hasd = np.convolve(W1 > 0, np.ones(11), 'same') > 0
    src[hasd & (wt[j1] > 0)] = 1
    src[np.isin(code, list(NODGM)) & ~hasd] = 4
    src[deck] = 2; src[cov] = 3
    src10 = src[i10]
    np.savez_compressed(OUT + 'vprof.part.npz', z1=z1, q1=q1.astype(np.float16), src10=src10, xrd=XRD.astype(np.float32), xrel=xrel)
    os.replace(OUT + 'vprof.part.npz', OUT + 'vprof.npz')         # (readers never see half a file)
    print(f'→ {OUT}vprof.npz ({os.path.getsize(OUT + "vprof.npz") / 1e6:.1f} MB) in {time.time() - t0:.0f} s', flush=True)
    report(s, z1, q1, Z0, W1, wt[j1], code, C1, K1, src10, xrel, COV, sn, zf, E)


def report(s, z1, q1, Z0, W1, wt1, code, C1, K1, src10, xrel, COV, sn, zf, E):
    """validation per state: fit vs DGM1, grades, grade reversals, cross slope; the tunnels"""
    n = len(s); g = np.gradient(zf, HN)
    gn = np.interp(s, sn, g)
    z_old = np.interp(s, E['s'], gaussian_filter1d(np.nan_to_num(E['z0']), 4))     # what the packs carried (GLO-30, σ 40 m)
    cva = gaussian_filter1d(np.gradient(gn, s), 10)
    go = np.gradient(z_old, s)
    def rev(g, m):                                           # grade reversals per km (|g| < 0.3 % counts as level)
        g10 = g[m][::10] * 100; sg = np.sign(np.where(np.abs(g10) < 0.3, 0, g10)); sg = sg[sg != 0]
        return (np.diff(sg) != 0).sum() / max(0.1, m.sum() / 1000) if len(sg) > 1 else 0.0
    def dg100(g, m):                                         # grade change over 100 m, p95 (%)
        g10 = g[::10] * 100; d = np.abs(g10[10:] - g10[:-10]); mm = m[::10][10:] & m[::10][:-10]
        return np.percentile(d[mm], 95) if mm.any() else np.nan
    print(f"\n{'state':5s} {'km':>6s} {'DGM1':>5s} {'RMS':>6s} {'p95':>6s} {'rej':>5s} | motorway: {'max g':>6s} {'rev/km':>6s} {'(old)':>6s} "
          f"{'dg100':>6s} {'(old)':>6s} {'Rv p1':>7s} | {'|q| p50':>7s} {'old-DGM sd':>10s}")
    for c in sorted(set(code.tolist()) - {''}, key=lambda c: np.nonzero(code == c)[0][0]):
        m = code == c; km = m.sum() / 1000
        ob = m & (W1 > 0) & np.isfinite(Z0)
        res = (z1 - Z0)[ob & (wt1 > 0)]
        rms = np.sqrt(np.mean(res ** 2)) if len(res) else np.nan; p95 = np.percentile(np.abs(res), 95) if len(res) else np.nan
        rej = 1 - (ob & (wt1 > 0)).sum() / max(1, ob.sum())
        mw = m & (C1 == 'motorway') & ~K1
        gm = np.abs(gn[mw]).max() * 100 if mw.any() else np.nan
        rv = np.percentile(1 / np.maximum(np.abs(cva[mw]), 1e-9), 1) if mw.any() else np.nan
        dgm = (src10[m[::10]] == 1).mean() * 100
        old = np.std((z_old - Z0)[ob]) if ob.sum() > 100 else np.nan
        print(f"{c:5s} {km:6.1f} {dgm:4.0f}% {rms:6.3f} {p95:6.3f} {rej * 100:4.1f}% | {'':9s} {gm:5.1f}% {rev(gn, mw):6.2f} {rev(go, mw):6.2f} "
              f"{dg100(gn, mw):5.2f}% {dg100(go, mw):5.2f}% {rv:7.0f} | "
              f"{np.median(np.abs(q1[m])) * 100:6.2f}% {old:10.2f}")
    mw = (C1 == 'motorway') & ~K1
    print(f"whole route: motorway max grade {np.abs(gn[mw]).max() * 100:.2f} % (ramps excluded); xrel known {np.mean(xrel != -32768) * 100:.1f} %; "
          f"src10 {np.bincount(src10, minlength=5).tolist()} (gap/GLO, DGM1, deck, covered, GLO no-DGM state)")
    for t in COV:
        a, b = np.searchsorted(s, [t['s0'], t['s1']])
        print(f"  {t['kind']:8s} {t['s0'] / 1000:8.3f}–{t['s1'] / 1000:.3f} km {str(t.get('name') or ''):22s} road {z1[a]:7.2f} → {z1[b]:7.2f}, "
              f"inside max {z1[a:b + 1].max():7.2f} min {z1[a:b + 1].min():7.2f}; GLO-30 old max {z_old[a:b + 1].max():7.2f}")


if __name__ == '__main__':
    main()
