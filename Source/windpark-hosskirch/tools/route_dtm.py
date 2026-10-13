"""A terrain model from the GLO-30 surface model: tree and built-up cells (ESA WorldCover) are lowered by the
canopy / roof height measured at their own edges against the open ground next to them."""
import numpy as np
from scipy.ndimage import gaussian_filter, binary_dilation, uniform_filter, map_coordinates, distance_transform_edt


def _nconv(D, w, sig):
    return gaussian_filter(D * w, sig) / np.maximum(gaussian_filter(w, sig), 1e-6), gaussian_filter(w, sig)


def cover_fractions(shape, wc):
    """Fraction of each GLO-30 cell (1") covered by WorldCover trees / built-up (0.3", same bounding box)."""
    Hd, Wd = shape
    sy, sx = wc.shape[0] / Hd, wc.shape[1] / Wd
    R, Cc = np.meshgrid((np.arange(Hd) + 0.5) * sy - 0.5, (np.arange(Wd) + 0.5) * sx - 0.5, indexing='ij')
    out = []
    for cls in (10, 50):
        m = uniform_filter((wc == cls).astype(float), size=int(round(sy)))
        out.append(map_coordinates(m, [R, Cc], order=1, mode='nearest'))
    return out


def dtm(D, wc10, Ht=20.0, anchors=()):
    """D: GLO-30 grid; wc10: WorldCover classes over the same bounding box. Ht: canopy bias of the surface model in
    closed forest (20 m: GLO-30 is 21 m above the surveyed ground of the WEA 5 pad, which WorldCover 2021 still shows
    as forest). anchors: (row, col, z) of surveyed ground heights (turbine pads) the result is pulled to."""
    tree, built = cover_fractions(D.shape, wc10)
    opn = np.clip(1 - tree - built, 0, 1)
    w = (opn > 0.85).astype(float)
    # the open ground spread inwards: smallest scale with enough open cells around
    est = D.copy(); done = w > 0
    for sig in (1.5, 3, 6, 12, 24):
        e, c = _nconv(D, w, sig)
        take = (~done) & (c > 0.12)
        est[take] = e[take]; done |= take
    est[~done] = D[~done]
    dist = distance_transform_edt(w == 0)
    e4, c4 = _nconv(D, w, 4)
    def height(mask, lo, hi, dflt):
        edge = mask & (dist >= 2) & (dist <= 4) & (c4 > 0.1)
        d = (D - e4)[edge]
        return float(np.clip(np.median(d), lo, hi)) if d.size > 20 else dflt
    Hb = height(built > 0.6, 2.0, 10.0, 6.0)
    G = D - Ht * gaussian_filter(tree, 0.6) - Hb * gaussian_filter(built, 0.6)
    # canopy texture inside the forest is not terrain: smooth more where the cover is closed
    cover = gaussian_filter(np.maximum(tree, built), 1.0)
    G = np.where(cover > 0.5, gaussian_filter(G, 2.5), gaussian_filter(G, 0.8))
    G = gaussian_filter(G, 0.6)
    if anchors:
        R, Cc = np.mgrid[0:G.shape[0], 0:G.shape[1]]
        for r, c, z in anchors:
            d0 = z - map_coordinates(G, [[r], [c]], order=1)[0]
            G = G + d0 * np.exp(-((R - r) ** 2 + (Cc - c) ** 2) / (2 * 4.0 ** 2))
    return G, tree, Hb
