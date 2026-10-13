"""Survey points at survey accuracy from official open geodata (Baden-Württemberg LGL, Bavaria LDBV):
aerial photo tiles (20 cm), the paved carriageway traced on the photo, the 1 m laser terrain (DGM1), the surface
model above it (trees, objects), LoD2 buildings with their real roofs. All returned in the survey point's local frame.
Everything is cached under .cache/route/hd/."""
import io, math, os, pickle, urllib.request
import numpy as np
from pyproj import Transformer
from scipy import ndimage as ndi
from PIL import Image
from hd_sources import C as HDC, sample_source, _get

REGION = {'factory': 'PL-32', 'feuchtwangen': 'DE-BY', 'a7-exit': 'DE-BY', 'neu-ulm': 'DE-BY'}
import routecfg
REGION.update(routecfg.get('hot_regions', {}))      # another route: its survey points' regions
BYT = HDC + 'byt/'
os.makedirs(BYT, exist_ok=True)


def region(hid):
    return REGION.get(hid, 'DE-BW')


# ---------------------------------------------------------------- Bavarian 1 km rasters (DGM1, DOM20) and LoD2
def _by_tile(kind, e, n):
    if kind == 'dgm1':
        url, fn = f'https://download1.bayernwolke.de/a/dgm/dgm1/{e}_{n}.tif', BYT + f'dgm1_{e}_{n}.tif'
    elif kind == 'dom20':
        url, fn = f'https://download1.bayernwolke.de/a/dom20/DOM/32{e}_{n}_20_DOM.tif', BYT + f'dom20_{e}_{n}.tif'
    else:
        raise ValueError(kind)
    if _get(url, fn) is None: return None
    return fn


def _by_sample(kind, X, Y):
    import rasterio
    out = np.full(X.shape, np.nan, np.float32)
    ek = np.floor(X / 1000).astype(int); nk = np.floor(Y / 1000).astype(int)
    for e, n in set(zip(ek.ravel().tolist(), nk.ravel().tolist())):
        fn = _by_tile(kind, e, n)
        if fn is None: continue
        m = (ek == e) & (nk == n)
        with rasterio.open(fn) as r:
            a = r.read(1).astype(np.float32); a[a < -1000] = np.nan
            T = ~r.transform
            c, rr = T * (X[m], Y[m])
            out[m] = ndi.map_coordinates(np.nan_to_num(a, nan=np.nanmean(a)), [rr - 0.5, c - 0.5], order=1, mode='nearest')
    return out


def by_lod2(bbox):
    from hd_lod2 import parse_gml
    out = []
    for e in range(int(bbox[0] // 2000) * 2, int(bbox[2] // 2000) * 2 + 2, 2):
        for n in range(int(bbox[1] // 2000) * 2, int(bbox[3] // 2000) * 2 + 2, 2):
            fn = BYT + f'lod2_{e}_{n}.gml'
            b = _get(f'https://download1.bayernwolke.de/a/lod2/citygml/{e}_{n}.gml', fn)
            if b: out += parse_gml(b, bbox)
    return out


# ---------------------------------------------------------------- terrain / surface on a grid in the local frame
def to_utm32(proj):
    return Transformer.from_crs(proj, 'EPSG:25832', always_xy=True), Transformer.from_crs('EPSG:25832', proj, always_xy=True)


_PLR = {}


def _pl_sample(names, proj, X, Y):
    """GUGiK mosaics (EPSG:2180) fetched with hd_pl_fetch.py, first file covering a point wins"""
    import rasterio
    t = Transformer.from_crs(proj, 'EPSG:2180', always_xy=True)
    ex, ny_ = t.transform(X, Y)
    out = np.full(np.shape(X), np.nan, np.float32)
    import glob as _g
    # every mosaic of the product (pl_nmt.tif, pl_nmt_<area>.tif …: one per survey area, hd_pl_fetch.py), the named first
    names = list(names) + sorted({os.path.basename(f) for n_ in names for f in _g.glob(HDC + 'pl/' + n_.split('.')[0].split('_ext')[0] + '_*.tif')} - set(names))
    for nm in names:
        fn = HDC + 'pl/' + nm
        if not os.path.exists(fn): continue
        if fn not in _PLR:                                      # read once per process (the mosaics run to 200 MB)
            with rasterio.open(fn) as r:
                a = r.read(1).astype(np.float32); a[a < -1000] = np.nan
                _PLR[fn] = (np.nan_to_num(a, nan=float(np.nanmean(a))), r.transform, r.width, r.height)
        a, tf, w_, h_ = _PLR[fn]
        c, rr = (~tf) * (ex, ny_)
        inside = (c >= 0) & (rr >= 0) & (c < w_ - 1) & (rr < h_ - 1) & np.isnan(out)
        if inside.any():
            out[inside] = ndi.map_coordinates(a, [rr[inside] - 0.5, c[inside] - 0.5], order=1, mode='nearest')
    return out


# border passages (Neu-Ulm: Bavaria and Baden-Württemberg either side of the Iller): the neighbouring state's data where the
# first state's services have none
ALT = {'DE-BY': 'DE-BW', 'DE-BW': 'DE-BY', 'DE-MV': 'DE-BB', 'DE-BB': 'DE-MV', 'DE-ST': 'DE-BB'}
# states whose 1 m laser terrain and surface model come from their WCS (elev_fetch.py: Brandenburg DGM1 + bDOM, Mecklenburg-
# Vorpommern DGM1 + DOM1, Saxony-Anhalt DGM1 + DOM1) with the 20 cm photo from their WMS; no open LoD2 service is wired in
# for them, so the passage's buildings are the mapped footprints with their heights
EF = {'DE-BB': 'BB', 'DE-MV': 'MV', 'DE-ST': 'ST'}
HD_SET = ('DE-BW', 'DE-BY', 'PL-32') + tuple(EF)


def _ef(reg, kind, proj, X, Y):
    import elev_fetch
    return elev_fetch.sample(EF[reg], kind, np.asarray(X, float), np.asarray(Y, float), crs=proj).astype(np.float32)


def _fill(fn, reg, proj, X, Y):
    Z = fn(reg, proj, X, Y)
    if Z is None or reg not in ALT: return Z
    Z = np.array(Z, float); bad = ~np.isfinite(Z)
    if bad.any():
        try: Z[bad] = fn(ALT[reg], proj, np.asarray(X)[bad], np.asarray(Y)[bad])
        except Exception as ex: print('  neighbouring state data failed', ALT[reg], repr(ex)[:100])
    return Z


def sample_dgm(reg, proj, X, Y):
    return _fill(_dgm, reg, proj, X, Y)


def _dgm(reg, proj, X, Y):
    if reg == 'PL-32':
        return _pl_sample(['pl_nmt.tif', 'pl_nmt_ext.tif'], proj, X, Y)
    if reg in EF:
        return _ef(reg, 'dgm', proj, X, Y)
    f, _ = to_utm32(proj)
    ux, uy = f.transform(X, Y)
    if reg == 'DE-BW':
        from hd_bw import sample
        return sample('dgm1', ux, uy)
    if reg == 'DE-BY':
        return _by_sample('dgm1', ux, uy)
    return None


def sample_ndom(reg, proj, X, Y):
    """height above the terrain (trees, buildings, objects), m"""
    nd = _fill(_ndom, reg, proj, X, Y)
    return None if nd is None else np.nan_to_num(nd)


def _ndom(reg, proj, X, Y):
    if reg == 'PL-32':
        d = _pl_sample(['pl_nmpt.tif'], proj, X, Y); g = _pl_sample(['pl_nmt.tif', 'pl_nmt_ext.tif'], proj, X, Y)
        return np.nan_to_num(np.maximum(d - g, 0))
    if reg in EF:
        d = _ef(reg, 'dom', proj, X, Y); g = _ef(reg, 'dgm', proj, X, Y)
        return np.where(np.isfinite(d) & np.isfinite(g), np.maximum(d - g, 0), np.nan)     # NaN outside the state (_fill)
    f, _ = to_utm32(proj)
    ux, uy = f.transform(X, Y)
    if reg == 'DE-BW':
        from hd_bw import sample
        return sample('ndom1', ux, uy, order=0)                       # NaN outside the state (filled by _fill)
    if reg == 'DE-BY':
        d = _by_sample('dom20', ux, uy); g = _by_sample('dgm1', ux, uy)
        return np.maximum(d - g, 0)
    return None


# ---------------------------------------------------------------- the paved carriageway on the photo (2D, 0.25 m)
def _paved_window(reg, Pw, proj, roads, half, px):
    from hd_road import carriageway, road_pieces, raster_lines
    from shapely.geometry import LineString, box, shape
    import rasterio.features
    from rasterio.transform import from_origin
    x0, y0 = Pw[:, 0].min() - half, Pw[:, 1].min() - half
    x1, y1 = Pw[:, 0].max() + half, Pw[:, 1].max() + half
    W, H = int(math.ceil((x1 - x0) / px)), int(math.ceil((y1 - y0) / px))
    fr = (x0, y0, x0 + W * px, y0 + H * px)
    X, Y = np.meshgrid(fr[0] + (np.arange(W) + .5) * px, fr[3] - (np.arange(H) + .5) * px)
    rgb = sample_source(reg, X, Y, crs_in=proj)
    nd = sample_ndom(reg, proj, X, Y)
    if nd is None: nd = np.zeros((H, W), np.float32)
    bx = box(*fr); rl = []
    for r in roads:
        if r.get('sub_t') not in (None, 'road') or r['cls'] in ('footway', 'cycleway', 'path', 'steps', 'pedestrian', 'bridleway'): continue
        for L, isb in road_pieces(r):
            g = LineString(L).intersection(bx)
            for gg in getattr(g, 'geoms', [g]):
                if not gg.is_empty and gg.geom_type == 'LineString': rl.append((np.asarray(gg.coords), r['cls'], isb))
    m = carriageway(rgb, nd, fr, px, Pw, rl)
    near = ndi.distance_transform_edt(~raster_lines([Pw], fr, px, (H, W), width=1)) * px < half - 2
    m &= near
    T = from_origin(fr[0], fr[3], px, px)
    return [shape(g) for g, v in rasterio.features.shapes(m.astype(np.uint8), mask=m, transform=T) if v == 1]


def photo_paved(hid, P, proj, ext, roads, half=42.0, px=0.25, win=300, overlap=60):
    """the paved surface within `half` m of the path traced on the photo (windows of `win` m along the path, merged)"""
    from shapely.ops import unary_union
    reg = region(hid)
    key = (round(float(P[0, 0]), 1), round(float(P[0, 1]), 1), len(P), half, px)
    fn = HDC + f'paved_{hid}.pkl'
    if os.path.exists(fn):
        d = pickle.load(open(fn, 'rb'))
        if d.get('key') == key: return d
    polys = []
    for a in range(0, len(P) - 1, win - overlap):
        Pw = P[a:min(len(P), a + win)]
        if len(Pw) < 5: continue
        polys += _paved_window(reg, Pw, proj, roads, half, px)
    poly = unary_union(polys).buffer(0.05).buffer(-0.05).simplify(0.12)
    d = dict(key=key, poly=poly)
    pickle.dump(d, open(fn, 'wb'))
    return d


# ---------------------------------------------------------------- aerial photo tiles for the page
def photo_tiles(hid, P, proj, ext, near_m=140.0, size=256.0):
    """square tiles over ext: 0.25 m (1024 px) within near_m of the path, 1 m (256 px) elsewhere → [(x0, y0, size, px, webp)]"""
    from shapely.geometry import LineString, box
    reg = region(hid)
    path = LineString(P)
    out = []
    tx0 = math.floor(ext[0] / size); ty0 = math.floor(ext[1] / size)
    tx1 = math.ceil(ext[2] / size); ty1 = math.ceil(ext[3] / size)
    for ty in range(ty0, ty1):
        for tx in range(tx0, tx1):
            b = box(tx * size, ty * size, (tx + 1) * size, (ty + 1) * size)
            near = path.distance(b) < near_m
            px = 0.25 if near else 1.0
            fn = HDC + f'tiles/{hid}/{tx}_{ty}_{int(px * 100)}.webp'
            n = int(size / px)
            X, Y = np.meshgrid(tx * size + (np.arange(n) + .5) * px, (ty + 1) * size - (np.arange(n) + .5) * px)
            if not os.path.exists(fn):
                rgb = sample_source(reg, X, Y, crs_in=proj, res_m=None if near else 1.0)
                os.makedirs(os.path.dirname(fn), exist_ok=True)
                bb = io.BytesIO(); Image.fromarray(rgb).save(bb, 'WEBP', quality=66 if near else 60, method=6)
                open(fn, 'wb').write(bb.getvalue())
            # a state's photo service is blank (white) beyond its border: the neighbouring state's photo there
            if reg in ALT:
                fm = fn.replace('.webp', '_m.webp')
                if not os.path.exists(fm):
                    img = np.asarray(Image.open(fn).convert('RGB')).copy(); white = img.min(2) > 243
                    if white.mean() > 0.02:
                        try:
                            rgb2 = sample_source(ALT[reg], X, Y, crs_in=proj, res_m=None if near else 1.0)
                            img[white] = rgb2[white]
                            bb = io.BytesIO(); Image.fromarray(img).save(bb, 'WEBP', quality=66 if near else 60, method=6); open(fm, 'wb').write(bb.getvalue())
                            print('  photo tile', tx, ty, f'{white.mean():.0%} from', ALT[reg], flush=True)
                        except Exception as ex: print('  neighbouring photo failed', repr(ex)[:100])
                if os.path.exists(fm): fn = fm
            out.append(dict(x0=tx * size, y0=ty * size, size=size, px=px, webp=open(fn, 'rb').read()))
    return out


# ---------------------------------------------------------------- buildings (LoD2) in the local frame
def lod2_local(hid, proj, ext):
    reg = region(hid)
    f, b = to_utm32(proj)
    xs = [ext[0], ext[2], ext[0], ext[2]]; ys = [ext[1], ext[1], ext[3], ext[3]]
    ux, uy = f.transform(xs, ys)
    bb = (min(ux), min(uy), max(ux), max(uy))
    if reg == 'DE-BW':
        from hd_lod2 import bw_lod2
        B = bw_lod2(bb, HDC + 'bwt')
    elif reg == 'DE-BY':
        B = by_lod2(bb)
    else:
        return None
    out = []
    from shapely.geometry import Polygon, MultiPoint
    from shapely.ops import unary_union
    for r in B:
        def loc(ring):
            x, y = b.transform(ring[:, 0], ring[:, 1]); return np.c_[x, y, ring[:, 2]]
        roof = [loc(q) for q in r['roof']]; wall = [loc(q) for q in r['wall']]; gr = [loc(q) for q in r['ground']]
        if gr:
            fp = unary_union([Polygon(q[:, :2]).buffer(0) for q in gr if len(q) >= 3])
        else:
            fp = MultiPoint(np.concatenate(roof + wall)[:, :2]).convex_hull
        if fp.is_empty: continue
        zs = np.concatenate(roof + wall)[:, 2]
        out.append(dict(id=r['id'], poly=fp, zmin=float(zs.min()), zmax=float(zs.max()), h=float(zs.max() - zs.min()), roof=roof, wall=wall))
    return out


# ---------------------------------------------------------------- trees from the surface model
def ndom_trees(hid, proj, ext, P, within=320.0, step=1.0, buildings=None):
    """tree tops: local maxima of the height above ground (≥ 3 m, crowns ≥ 2.5 m apart) that are not buildings"""
    from shapely.geometry import LineString
    reg = region(hid)
    x0, y0 = max(ext[0], P[:, 0].min() - within), max(ext[1], P[:, 1].min() - within)
    x1, y1 = min(ext[2], P[:, 0].max() + within), min(ext[3], P[:, 1].max() + within)
    W, H = int((x1 - x0) / step), int((y1 - y0) / step)
    X, Y = np.meshgrid(x0 + (np.arange(W) + .5) * step, y1 - (np.arange(H) + .5) * step)
    nd = sample_ndom(reg, proj, X, Y)
    if nd is None: return None
    s = ndi.gaussian_filter(nd, 0.8)
    mx = ndi.maximum_filter(s, size=5)
    pk = (s == mx) & (s >= 3.0)
    # crown radius from the area above 60 % of the top within 6 m
    ys, xs = np.nonzero(pk)
    h = s[ys, xs]
    lab, n = ndi.label(s > 2.0)
    r = np.clip(np.sqrt(np.bincount(lab.ravel())[lab[ys, xs]] / np.maximum(1, ndi.sum(pk, lab, lab[ys, xs])) / np.pi) * step, 1.2, 7.0)
    pts = np.c_[X[ys, xs], Y[ys, xs], h, r].astype(np.float32)
    import shapely
    d = shapely.distance(shapely.points(pts[:, :2]), LineString(P))
    pts = pts[d < within]
    # not on buildings, and green on the photo (roof edges and walls also stand out in the surface model)
    if buildings:
        from shapely.strtree import STRtree
        polys = [b.buffer(1.0) for b in buildings]
        tree = STRtree(polys)
        inside = np.zeros(len(pts), bool)
        for i, j in zip(*tree.query(shapely.points(pts[:, :2]), predicate='intersects')): inside[i] = True
        pts = pts[~inside]
    if len(pts):
        col = sample_source(reg, pts[:, 0][None], pts[:, 1][None], crs_in=proj, res_m=1.0)[0].astype(float)
        exg = (2 * col[:, 1] - col[:, 0] - col[:, 2]) / (col.sum(1) + 1)
        pts = pts[(exg > 0.015) & (col.mean(1) < 150)]
    return pts
