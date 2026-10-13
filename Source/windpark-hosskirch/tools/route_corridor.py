"""Whole-route corridor: the route is cut into 500 m chunks; for each chunk a photo strip that follows the road
(columns along the route every PX m, rows across from -HALF to +HALF m), the paved carriageway traced from it, and
the survey values. Frames: UTM33 (the route), strips sampled on the route centreline with normals from a smoothed copy."""
import routecfg
import math, os, pickle, sys
import numpy as np
from scipy.ndimage import gaussian_filter1d, map_coordinates
from pyproj import Transformer

HERE = os.path.dirname(os.path.abspath(__file__))
C = routecfg.C
OUT = C + 'corr/'
os.makedirs(OUT, exist_ok=True)
CH = 500.0          # chunk length, m
PX = 0.25           # strip pixel, m
HALF = 45.0         # strip half-width, m

_scr = None


def route():
    global _scr
    if _scr is None:
        z = np.load(C + 'screen.npz')
        P = z['P']; s = z['s']
        Ps = gaussian_filter1d(P, 18, axis=0, mode='nearest')
        T = np.gradient(Ps, axis=0); T /= np.linalg.norm(T, axis=1)[:, None]
        _scr = dict(P=P, s=s, N=np.c_[-T[:, 1], T[:, 0]], HW=z['HW'], SEG=z['SEG'], R=z['R'])
    return _scr


def strip_frame(c):
    """Centre positions (UTM33) and normals at every PX along chunk c; returns s, centre (n×2), normal (n×2)."""
    r = route(); s = r['s']
    s0 = c * CH; s1 = min(s[-1], s0 + CH)
    ss = np.arange(s0, s1, PX)
    cx = np.interp(ss, s, r['P'][:, 0]); cy = np.interp(ss, s, r['P'][:, 1])
    nx = np.interp(ss, s, r['N'][:, 0]); ny = np.interp(ss, s, r['N'][:, 1])
    nn = np.hypot(nx, ny); nx /= nn; ny /= nn
    return ss, np.c_[cx, cy], np.c_[nx, ny]


def strip_points(c):
    ss, cen, nor = strip_frame(c)
    d = (np.arange(int(2 * HALF / PX)) + 0.5) * PX - HALF        # rows: left (+) at top
    d = d[::-1]
    X = cen[None, :, 0] + nor[None, :, 0] * d[:, None]
    Y = cen[None, :, 1] + nor[None, :, 1] * d[:, None]
    return ss, d, X, Y


def sample_xyz(tile_fn, z, X, Y, crs='EPSG:32633'):
    """Sample an XYZ (EPSG:3857, 256 px) imagery source at the points X, Y (in crs), bilinear."""
    from hd_sources import xyz_mosaic
    t = Transformer.from_crs(crs, 'EPSG:4326', always_xy=True)
    lon, lat = t.transform(X, Y)
    img, x0, y1, res = xyz_mosaic(tile_fn, lon.min(), lat.min(), lon.max(), lat.max(), z)
    R = 6378137.0
    mx = np.radians(lon) * R; my = np.log(np.tan(np.pi / 4 + np.radians(lat) / 2)) * R
    cc = (mx - x0) / res - 0.5; rr = (y1 - my) / res - 0.5
    out = np.zeros(X.shape + (3,), np.uint8)
    for b in range(3):
        out[..., b] = np.clip(map_coordinates(img[..., b], [rr, cc], order=1, mode='nearest'), 0, 255)
    return out


if __name__ == '__main__':
    sys.path.insert(0, HERE)
    from hd_sources import bw_dop_tile
    from PIL import Image
    import io, time
    km = float(sys.argv[1]); c = int(km * 1000 // CH)
    t = time.time()
    ss, d, X, Y = strip_points(c)
    rgb = sample_xyz(bw_dop_tile, 19, X, Y)
    print('chunk', c, rgb.shape, time.time() - t)
    for q in (55, 65, 75):
        b = io.BytesIO(); Image.fromarray(rgb).save(b, 'WEBP', quality=q, method=6); print('webp q', q, len(b.getvalue()) // 1024, 'KB')
    b = io.BytesIO(); Image.fromarray(rgb[::2, ::2]).save(b, 'WEBP', quality=65, method=6); print('0.5 m webp q65', len(b.getvalue()) // 1024, 'KB')
    Image.fromarray(rgb).save('/tmp/claude-0/-home-user-Interactive-Turbine-Lab/564bad2b-aee6-5ac6-9043-5b521443c8a3/scratchpad/strip.jpg', quality=88)


_net = None


def net_lines():
    """Mapped major roads (Overture, from the routing network) in UTM33 with an STRtree."""
    global _net
    if _net is None:
        fn = C + 'corr/net_lines.pkl'
        if os.path.exists(fn):
            _net = pickle.load(open(fn, 'rb'))
        else:
            import pyarrow.parquet as pq
            from shapely import wkb
            from shapely.ops import transform as stf
            t = Transformer.from_crs('EPSG:4326', 'EPSG:32633', always_xy=True)
            geoms, cls = [], []
            for f in ('net_major', 'net_site', 'net_factory'):
                tb = pq.read_table(C + f + '.parquet', columns=['class', 'geometry'])
                for c_, g in zip(tb.column('class').to_pylist(), tb.column('geometry').to_pylist()):
                    gg = wkb.loads(g)
                    x, y = t.transform(*np.asarray(gg.coords).T)
                    geoms.append(np.c_[x, y].astype(np.float32)); cls.append(c_)
            _net = dict(lines=geoms, cls=cls)
            pickle.dump(_net, open(fn + f'.{os.getpid()}', 'wb')); os.replace(fn + f'.{os.getpid()}', fn)     # (workers build it at once)
        from shapely.geometry import LineString
        from shapely.strtree import STRtree
        _net['shp'] = [LineString(g) for g in _net['lines']]
        _net['tree'] = STRtree(_net['shp'])
    return _net


def other_side_mask(c, d, X, Y):
    """Strip pixels closer to another, roughly parallel mapped road than to the route (opposite carriageway,
    parallel service roads): excluded from the route's carriageway."""
    from shapely.geometry import LineString, box
    import shapely
    ss, cen, nor = strip_frame(c)
    net = net_lines()
    bb = box(X.min(), Y.min(), X.max(), Y.max())
    route_ln = LineString(cen[::8])
    excl = np.zeros(X.shape, bool)
    T = np.c_[nor[:, 1], -nor[:, 0]]
    for k in net['tree'].query(bb):
        ln = net['shp'][k]
        g = ln.intersection(bb)
        if g.is_empty or g.length < 15: continue
        # the route's own segments: (almost) on the centreline
        pts = np.asarray(g.coords if g.geom_type == 'LineString' else g.geoms[0].coords)
        dr = shapely.distance(shapely.points(pts), route_ln)
        if np.median(dr) < 2.5: continue
        # parallel: direction within 25° of the route's near its points
        D = np.diff(pts, axis=0); D /= np.linalg.norm(D, axis=1)[:, None] + 1e-9
        j = np.clip(np.searchsorted(ss, ss[0]), 0, len(T) - 1)
        mids = (pts[1:] + pts[:-1]) / 2
        kk = np.argmin(((cen[None, ::8] - mids[:, None]) ** 2).sum(-1), axis=1) * 8
        cosang = np.abs((D * T[kk]).sum(1))
        if np.median(cosang) < 0.9: continue
        # distance of every strip pixel to this line vs to the route (|d|)
        dl = shapely.distance(shapely.points(X.ravel(), Y.ravel()), g).reshape(X.shape)
        excl |= dl < np.abs(d)[:, None] - 0.5
    return excl


def paved_strip(rgb, d, band=16.0, excl=None):
    """Paved carriageway in strip space (rows = offsets d, cols = along): the grey, smooth, unsaturated surface
    connected to the route centreline within ±band m. Returns mask and per-column left/right edge offsets (m)."""
    from scipy import ndimage as ndi
    from hd_road import features, texture
    H, W = rgb.shape[:2]
    sat, exg, v = features(rgb)
    ref = np.abs(d)[:, None].repeat(W, 1) < 1.0
    vr = np.median(v[ref]); sr = np.median(sat[ref])
    mark = (v > vr + 25) & (sat < sr + 0.06)                # lane markings: left out of the smoothness measure
    mark = ndi.binary_dilation(mark, iterations=1)
    v2 = np.where(mark, ndi.median_filter(np.where(mark, vr, v), size=7), v)
    tx = texture(v2, PX)
    blk = 200                                             # colour statistics every 50 m (flight seams, shade)
    nb = max(1, int(math.ceil(W / blk)))
    def stat(a):
        med = np.zeros(nb); mad = np.zeros(nb)
        for b in range(nb):
            x = a[:, b * blk:(b + 1) * blk][ref[:, b * blk:(b + 1) * blk]]
            med[b] = np.median(x); mad[b] = np.median(np.abs(x - med[b])) * 1.48
        xc = (np.arange(nb) + 0.5) * blk
        cols = np.arange(W)
        return np.interp(cols, xc, med)[None], np.interp(cols, xc, mad)[None]
    ms, ds = stat(sat); me, de = stat(exg); mv, dv = stat(v)
    tref, _ = stat(tx)
    grey = (sat < ms + np.maximum(0.09, 3 * ds)) & (exg < me + np.maximum(0.04, 3 * de)) & (v > 0.35 * mv) & (tx < np.maximum(6.0, 2.6 * tref))
    shadow = (v < 0.75 * mv) & (exg < me + 0.03) & (sat < ms + 0.15)
    white = mark
    cand = (grey | shadow | white) & (np.abs(d)[:, None] <= band)
    if excl is not None: cand &= ~excl
    seed = cand & ref
    lab, n = ndi.label(cand)
    keep = np.zeros(n + 1, bool); keep[np.unique(lab[seed])] = True; keep[0] = False
    m = keep[lab]
    st = ndi.generate_binary_structure(2, 1)
    m = ndi.binary_closing(m, st, iterations=3)
    m = ndi.binary_opening(m, st, iterations=2)
    holes = ndi.binary_fill_holes(m) & ~m
    hl, hn = ndi.label(holes)
    if hn:
        sz = ndi.sum(holes, hl, np.arange(1, hn + 1)) * PX * PX
        m |= np.r_[False, sz < 40][hl]
    lab, n = ndi.label(m)
    keep = np.zeros(n + 1, bool); keep[np.unique(lab[ref & m])] = True; keep[0] = False
    m = keep[lab]
    # edges: walk out from the centre row on each column
    c0 = int(np.argmin(np.abs(d)))
    up = m[:c0 + 1][::-1]          # rows c0 → 0 (left, d > 0)
    dn = m[c0:]
    def run(a):
        bad = ~a
        k = np.where(bad.any(0), bad.argmax(0), a.shape[0])
        return k
    kl = run(up); kr = run(dn)
    left = np.where(kl > 0, d[np.clip(c0 - kl + 1, 0, H - 1)] + PX / 2, 0.0)
    right = np.where(kr > 0, -d[np.clip(c0 + kr - 1, 0, H - 1)] + PX / 2, 0.0)
    # is the edge where it is because of a shadow? (dark just beyond it: the edge may continue unseen)
    cols = np.arange(W)
    def dark_beyond(k, sign):
        rr = np.clip(c0 - sign * (k + np.arange(2, 7))[:, None] if False else 0, 0, H - 1)
        out = np.zeros(W, bool)
        for o in range(2, 7):
            r_ = np.clip(c0 - sign * (k + o), 0, H - 1)
            out |= v[r_, cols] < 0.62 * mv[0]
        return out
    shL = dark_beyond(kl, 1); shR = dark_beyond(kr, -1)
    return m, left, right, shL, shR


WPX = 2.0
WHALF = 300.0


def wide_points(c):
    """the wide band: columns every WPX m along the chunk, rows from +WHALF to -WHALF"""
    r = route(); s = r['s']
    s0 = c * CH; s1 = min(s[-1], s0 + CH)
    ss = np.arange(s0, s1, WPX)
    cx = np.interp(ss, s, r['P'][:, 0]); cy = np.interp(ss, s, r['P'][:, 1])
    nx = np.interp(ss, s, r['N'][:, 0]); ny = np.interp(ss, s, r['N'][:, 1]); nn = np.hypot(nx, ny); nx /= nn; ny /= nn
    d = ((np.arange(int(2 * WHALF / WPX)) + 0.5) * WPX - WHALF)[::-1]
    return ss, d, cx[None] + nx[None] * d[:, None], cy[None] + ny[None] * d[:, None]


def load_clear():
    """clear.json plus the per-run files clear_*.json (route_clearance.py runs per group of regions)"""
    import glob, json
    res = {'mapped': [], 'scan': []}; seen = set()
    for fn in sorted(glob.glob(OUT + 'clear*.json'), key=lambda f: (-1 if os.path.basename(f) == 'clear_laz.json' else 0 if os.path.basename(f) == 'clear_hd.json' else 1 if os.path.basename(f).startswith('clear_hd') else 2 if 'fix' in os.path.basename(f) else 3, f)):     # laser-terrain heights at the survey points, then re-analyses
        try: d = json.load(open(fn))
        except Exception: continue
        for m in d.get('mapped', []):
            if m.get('laz', {}).get('undetermined'): continue     # laser: the road under the structure is not in the data, the next source holds
            if round(m['s0']) not in seen: seen.add(round(m['s0'])); res['mapped'].append(m)
        res['scan'] += d.get('scan', [])
    return res
