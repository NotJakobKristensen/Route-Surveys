import json, numpy as np
from scipy import ndimage as ndi
from skimage import measure, morphology
from shapely.geometry import Polygon, Point, mapping
from shapely.ops import unary_union
from PIL import Image, ImageDraw
from geo import CACHE, cp, to_local
raw = np.load(cp('pads_raw.npy'), allow_pickle=True).item()
res = 2.5; out = {}
T = {t['tags']['ref:local']: t for t in json.load(open(cp('wind_turbines_region.json'))) if t['tags'].get('model') == 'V172'}
views = []
for name in sorted(raw):
    r = raw[name]; ndvi = r['ndvi']; n = ndvi.shape[0]; c = n / 2
    m = ndvi < 0.45
    m = morphology.binary_opening(m, morphology.disk(3))      # remove roads (<~15 m wide blurred)
    lab = measure.label(m)
    # component containing / nearest to turbine centre
    best, bd = 0, 1e9
    for reg in measure.regionprops(lab):
        cy, cx = reg.centroid
        dmin = min(np.hypot(y - c, x - c) for y, x in reg.coords[::max(1, len(reg.coords) // 200)])
        if dmin < bd: bd, best = dmin, reg.label
    pm = lab == best
    pm = morphology.binary_closing(pm, morphology.disk(2))
    cs = measure.find_contours(np.pad(pm, 1).astype(float), 0.5)
    cont = max(cs, key=len) - 1
    # contour (row, col) -> local metres
    xs = r['x0'] + (cont[:, 1] + 0.5) * res; ys = r['y0'] - (cont[:, 0] + 0.5) * res
    poly = Polygon(zip(xs, ys)).buffer(0).simplify(2.0)
    rect = poly.minimum_rotated_rectangle
    tx, ty = to_local(T[name]['lon'], T[name]['lat'])
    out[name] = dict(poly=list(poly.exterior.coords), rect=list(rect.exterior.coords), area=poly.area, rect_area=rect.area,
                     dist_tower_to_pad=Point(tx, ty).distance(poly))
    print(name, 'pad area %.0f m2, rect %.0f m2, tower-pad distance %.1f m' % (poly.area, rect.area, out[name]['dist_tower_to_pad']))
    rgb = np.clip((r['rgb'] * 4.0) ** (1 / 2.2), 0, 1)
    im = Image.fromarray((rgb * 255).astype(np.uint8)).resize((n * 2, n * 2), Image.BICUBIC); d = ImageDraw.Draw(im)
    P = lambda x, y: ((x - r['x0']) / res * 2, (r['y0'] - y) / res * 2)
    d.polygon([P(*p) for p in out[name]['poly']], outline=(255, 255, 0))
    d.polygon([P(*p) for p in out[name]['rect']], outline=(0, 255, 255))
    X, Y = P(tx, ty); d.ellipse([X - 3, Y - 3, X + 3, Y + 3], outline=(255, 0, 0), width=2)
    views.append(im)
json.dump(out, open(cp('pads.json'), 'w'))
W = views[0].size[0]; mm = Image.new('RGB', (W * 3 + 20, W * 2 + 10), (255, 255, 255))
for i, v in enumerate(views): mm.paste(v, ((i % 3) * (W + 10), (i // 3) * (W + 10)))
mm.save('pads_poly.png'); print(mm.size)
