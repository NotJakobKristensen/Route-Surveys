"""Carriageway from the aerial photo: paved = grey, unsaturated, not green, flat (nDOM < 0.6 m, cars excepted),
grown from the route centreline and from the mapped road centrelines, cleaned morphologically."""
import math
import numpy as np
from scipy import ndimage as ndi
from pyproj import Transformer
from shapely.geometry import LineString


def raster_lines(lines, ext, px, shape, width=0.0):
    """Burn polylines (local metres) into a bool mask (row 0 = north)."""
    from PIL import Image, ImageDraw
    im = Image.new('L', (shape[1], shape[0]), 0); d = ImageDraw.Draw(im)
    for L in lines:
        L = np.asarray(L)
        pts = [((x - ext[0]) / px, (ext[3] - y) / px) for x, y in L]
        d.line(pts, fill=255, width=max(1, int(round(width / px))))
    return np.asarray(im) > 0


def features(rgb):
    f = rgb.astype(np.float32)
    mx = f.max(-1); mn = f.min(-1); v = f.mean(-1)
    return (mx - mn) / (mx + 1), (2 * f[..., 1] - f[..., 0] - f[..., 2]) / (f.sum(-1) + 1), v


def texture(v, px):
    k = max(3, int(round(1.25 / px)) | 1)
    m = ndi.uniform_filter(v, k); m2 = ndi.uniform_filter(v * v, k)
    return np.sqrt(np.maximum(m2 - m * m, 0))


def classify(rgb, ndom, ref, px=0.25, bridge=None):
    """ref: bool mask of pixels certainly on the carriageway (under the route centreline) to learn its colour from;
    bridge: bool mask where the road is on a bridge deck (the surface model sees it raised)."""
    sat, exg, v = features(rgb)
    tx = texture(v, px)
    # the learning pixels: under the centreline and level with the ground (or on a known deck); where that leaves too
    # few (an elevated road the surface model sees raised), the centreline pixels themselves
    sel = ref & ((ndom < 0.6) | (bridge if bridge is not None else False))
    if sel.sum() < 50: sel = ref
    if sel.sum() < 50: sel = np.ones_like(ref, bool)
    def stat(a):
        x = a[sel]
        med = np.median(x); mad = np.median(np.abs(x - med)) * 1.48
        return med, mad
    ms, ds = stat(sat); me, de = stat(exg); mv, dv = stat(v)
    tref = np.percentile(tx[sel], 75)
    grey = (sat < ms + max(0.07, 3 * ds)) & (exg < me + max(0.03, 3 * de)) & (v > 0.35 * mv) & (tx < max(6.0, 2.2 * tref))
    shadow = (v < 0.75 * mv) & (exg < me + 0.03) & (sat < ms + 0.15)
    white = (v > mv + 25) & (sat < ms + 0.05)
    flat = ndom < 0.6
    if bridge is not None: flat |= bridge
    return (grey | shadow | white) & flat, (ndom >= 0.6) & (ndom < 2.2) & (exg < me + 0.03)


LIM = {'motorway': 11, 'trunk': 10, 'primary': 9, 'secondary': 8.5, 'tertiary': 8, 'unclassified': 6.5,
       'residential': 7, 'living_street': 6, 'service': 5.5, 'track': 4.5, 'unknown': 6}


def carriageway(rgb, ndom, ext, px, route_line, roads, route_half=9.0):
    """Bool mask of the paved surface connected to the route and the mapped roads near it. roads: list of
    (polyline, class, is_bridge)."""
    H, W = ndom.shape
    ref = raster_lines([route_line], ext, px, (H, W), width=1.0)
    bridge = np.zeros((H, W), bool)
    allow = raster_lines([route_line], ext, px, (H, W), width=2 * route_half)
    for L, cls, isb in roads:
        lim = LIM.get(cls, 6)
        allow |= raster_lines([L], ext, px, (H, W), width=2 * lim)
        if isb: bridge |= raster_lines([L], ext, px, (H, W), width=2 * lim)
    # junction mouths: kerb radii reach further than either road's band
    ends = [np.asarray(L)[[0, -1]] for L, _, _ in roads]
    if ends:
        from PIL import Image, ImageDraw
        im = Image.fromarray(allow.astype(np.uint8) * 255); d = ImageDraw.Draw(im)
        for e in ends:
            for x, y in e:
                c = ((x - ext[0]) / px, (ext[3] - y) / px); r = 14 / px
                d.ellipse([c[0] - r, c[1] - r, c[0] + r, c[1] + r], fill=255)
        allow = np.asarray(im) > 0
    road_lines = [L for L, _, _ in roads]
    paved, carlike = classify(rgb, ndom, ref, px, bridge)
    cand = (paved | carlike) & allow
    seed = raster_lines([route_line], ext, px, (H, W), width=1.5) & cand
    seed |= raster_lines(road_lines, ext, px, (H, W), width=1.0) & cand
    lab, n = ndi.label(cand)
    keep = np.zeros(n + 1, bool); keep[np.unique(lab[seed])] = True; keep[0] = False
    m = keep[lab]
    r = max(1, int(round(0.6 / px)))
    st = ndi.generate_binary_structure(2, 1)
    m = ndi.binary_closing(m, st, iterations=r)
    m = ndi.binary_opening(m, st, iterations=max(1, int(round(0.4 / px))))
    # fill small holes (cars, markings, manholes) under 40 m²
    holes = ndi.binary_fill_holes(m) & ~m
    hl, hn = ndi.label(holes)
    if hn:
        sz = ndi.sum(holes, hl, np.arange(1, hn + 1)) * px * px
        small = np.r_[False, sz < 40]
        m |= small[hl]
    # drop pieces not touching the seed after cleaning
    lab, n = ndi.label(m)
    keep = np.zeros(n + 1, bool); keep[np.unique(lab[seed & m])] = True; keep[0] = False
    return keep[lab]


def sdf(mask, px):
    """Signed distance to the paved edge in metres (> 0 inside)."""
    return (ndi.distance_transform_edt(mask) - ndi.distance_transform_edt(~mask)) * px


def road_pieces(r):
    """Split a mapped road into (polyline, on_bridge) pieces from its Overture road_flags / level_rules ranges."""
    from shapely.ops import substring
    ln = LineString(r['xy'])
    rng = []
    for f in (r.get('flags') or []):
        if 'is_bridge' in (f.get('values') or []): rng.append(f.get('between') or [0, 1])
    for lr in (r.get('level') or []):
        if (lr.get('value') or 0) > 0: rng.append(lr.get('between') or [0, 1])
    if not rng: return [(np.asarray(ln.coords), False)]
    rng = sorted((max(0, a), min(1, b)) for a, b in rng)
    out, t = [], 0.0
    for a, b in rng:
        if a > t: out.append((t, a, False))
        out.append((max(a, t), b, True)); t = max(t, b)
    if t < 1: out.append((t, 1.0, False))
    res = []
    for a, b, isb in out:
        if b - a <= 1e-6: continue
        g = substring(ln, a, b, normalized=True)
        if g.geom_type == 'LineString' and len(g.coords) >= 2: res.append((np.asarray(g.coords), isb))
    return res
