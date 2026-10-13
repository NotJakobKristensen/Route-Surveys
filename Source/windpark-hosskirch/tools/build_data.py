"""Build the compact scene data for the Windpark Hoßkirch page.

Inputs (downloaded by fetch_sources.py into CACHE):
  Overture Maps 2026-09-23.1 GeoJSON extracts (OSM-derived roads, buildings, land use, water, power, trees),
  Copernicus GLO-30 DSM, Sentinel-2 L2A (2026-06-19) surface reflectance, turbine list (OSM power=generator).
Outputs (windpark-hosskirch/data/):
  scene.bin   deflate-raw stream of binary sections (terrain grids, vector layers, rasters)
  scene.json  header: section offsets, grid metadata, turbines, labels
  core.webp   Sentinel-2 true colour of the detail zone (±4096 m, 8 m/px)
  wide.webp   Sentinel-2 true colour of the whole scene (±12800 m, 40 m/px)

Frame: local transverse Mercator centred on LON0/LAT0 (k=1), x = east, y = north, metres.
"""
import io, json, math, os, sys, zlib, collections
import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import map_coordinates, gaussian_filter, distance_transform_edt, binary_dilation
from shapely.geometry import shape, Polygon, MultiPolygon, LineString, MultiLineString, Point, box, mapping
from shapely.ops import unary_union
from shapely import affinity

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from geo import LON0, LAT0, to_local, to_lonlat, Grid, load, iter_polys  # noqa: E402

from geo import CACHE  # noqa: E402
OUT = os.path.join(HERE, '..', 'data')
os.makedirs(OUT, exist_ok=True)
C = lambda *p: os.path.join(CACHE, *p)

CORE = 4096.0      # half extent of the detail zone (m)
WIDE = 12800.0     # half extent of the whole scene (m)
Q = 5.0            # vector quantisation: 1 unit = 0.2 m
CLIP = box(-CORE - 150, -CORE - 150, CORE + 150, CORE + 150)

# ----------------------------------------------------------------------------------------------- encoding
class Writer:
    def __init__(self): self.b = bytearray()
    def u8(self, v): self.b.append(int(v) & 255)
    def var(self, v):
        v = int(v)
        assert v >= 0, v
        while v >= 128:
            self.b.append((v & 127) | 128); v >>= 7
        self.b.append(v)
    def svar(self, v):
        v = int(v); self.var((v << 1) ^ (v >> 63) if v < 0 else v << 1)
    def raw(self, bs): self.b += bs

sections = collections.OrderedDict()
def add_section(name, data, **meta):
    sections[name] = (bytes(data), meta)
    print(f'  section {name:12s} {len(data):8d} B  {meta if len(str(meta)) < 120 else ""}')

class Layer:
    """Features with integer attributes and one or more point rings (quantised, delta-coded)."""
    def __init__(self, name, attrs):
        self.name, self.attrs, self.w, self.n = name, attrs, Writer(), 0
        self.px = self.py = 0
    def add(self, attrs, rings):
        rings = [r for r in rings if len(r) >= 1]
        if not rings: return
        for a in attrs: self.w.var(a)
        self.w.var(len(rings))
        for r in rings:
            self.w.var(len(r))
            for x, y in r:
                qx, qy = int(round(x * Q)), int(round(y * Q))
                self.w.svar(qx - self.px); self.w.svar(qy - self.py)
                self.px, self.py = qx, qy
        self.n += 1
    def finish(self):
        w = Writer(); w.var(self.n); w.var(len(self.attrs)); w.raw(self.w.b)
        add_section(self.name, w.b, count=self.n, attrs=self.attrs, q=Q)

def proj_coords(coords):
    xs, ys = to_local(*zip(*coords))
    return list(zip(xs, ys))

def proj_geom(g):
    """Project a shapely lon/lat geometry to the local frame."""
    if g.geom_type == 'Polygon':
        return Polygon(proj_coords(g.exterior.coords), [proj_coords(r.coords) for r in g.interiors])
    if g.geom_type == 'MultiPolygon':
        return MultiPolygon([proj_geom(p) for p in g.geoms])
    if g.geom_type == 'LineString':
        return LineString(proj_coords(g.coords))
    if g.geom_type == 'MultiLineString':
        return MultiLineString([proj_coords(l.coords) for l in g.geoms])
    if g.geom_type == 'Point':
        return Point(*to_local(g.x, g.y))
    raise ValueError(g.geom_type)

def rings_of(p, tol):
    p = p.simplify(tol, preserve_topology=True)
    if p.is_empty: return []
    out = []
    for q in iter_polys(p):
        if q.area < 4: continue
        ext = list(q.exterior.coords)[:-1]
        if Polygon(ext).exterior.is_ccw is False: ext = ext[::-1]    # exterior CCW
        out.append([ext] + [list(r.coords)[:-1][::-1] if Polygon(r.coords).exterior.is_ccw else list(r.coords)[:-1] for r in q.interiors])
    return out

def lines_of(g, tol):
    g = g.simplify(tol)
    if g.is_empty: return []
    if g.geom_type == 'LineString': return [list(g.coords)]
    if g.geom_type == 'MultiLineString': return [list(l.coords) for l in g.geoms]
    if g.geom_type == 'GeometryCollection': return [list(l.coords) for l in g.geoms if l.geom_type == 'LineString']
    return []

def feats(name):
    return load(C(f'{name}.geojson'))

# ----------------------------------------------------------------------------------------------- terrain
print('terrain')
G10 = Grid(12500, 10)
DTM10 = np.load(C('g10_dtm.npy')).astype(np.float64)

def sample10(X, Y, order=3):
    px = (X + G10.ext) / G10.res - 0.5; py = (G10.ext - Y) / G10.res - 0.5
    return map_coordinates(DTM10, [py, px], order=order, mode='nearest')

turbines_raw = sorted([t for t in json.load(open(C('wind_turbines_region.json'))) if t['tags'].get('model') == 'V172'],
                      key=lambda t: t['tags']['ref:local'])
pads = json.load(open(C('pads.json')))
S2_SHIFT = (2.0, 0.4)          # Sentinel-2 vs OSM (cross-correlated, geo QA): image content sits 2.0 m E, 0.4 m N
for pd in pads.values():
    pd['poly'] = [(x - S2_SHIFT[0], y - S2_SHIFT[1]) for x, y in pd['poly']]

# Water levels first, from data the corrections below do not touch: lakes over 0.5 ha take the median GLO-30 surface
# inside the shore eroded by 10 m (GLO-30 is water-flattened there); smaller ponds the 15th percentile of the open
# (non-forest) shoreline of the canopy-corrected terrain, or of the whole shoreline when it is all forest.
X10, Y10 = G10.xy()
F10 = np.load(C('g10_forest.npy'))
DSM10 = np.load(C('g10_dsm.npy')).astype(np.float64)
water_levels = {}
water_polys = []
for f in feats('core_water'):
    g = shape(f['geometry'])
    if g.geom_type not in ('Polygon', 'MultiPolygon'): continue
    if f['properties'].get('class') == 'swimming_pool': continue
    pg = proj_geom(g).buffer(0)
    if pg.is_empty or not pg.intersects(CLIP) or pg.area < 30: continue
    water_polys.append((f, pg))
def poly_mask(pg, grid, img=None):
    n = grid.n
    img = Image.new('L', (n, n), 0); d = ImageDraw.Draw(img)
    for q in iter_polys(pg):
        d.polygon([grid.px(x, y) for x, y in q.exterior.coords], fill=255)
        for r in q.interiors: d.polygon([grid.px(x, y) for x, y in r.coords], fill=0)
    return np.asarray(img) > 127
def sample_grid(A, X, Y, order=1):
    return map_coordinates(A, [(G10.ext - Y) / G10.res - 0.5, (X + G10.ext) / G10.res - 0.5], order=order, mode='nearest')
water_masks = {}
for i, (f, pg) in enumerate(water_polys):
    m = poly_mask(pg, G10)
    water_masks[i] = m
    inner = pg.buffer(-10.0)
    if pg.area > 5000 and not inner.is_empty:
        mi = poly_mask(inner, G10)
        lvl = float(np.median(DSM10[mi])) if mi.sum() >= 4 else None
    else:
        lvl = None
    if lvl is None:
        ring = np.array(pg.exterior.coords) if pg.geom_type == 'Polygon' else np.array(max(pg.geoms, key=lambda q: q.area).exterior.coords)
        # densify the shore to ~5 m
        pts = []
        for (x0, y0), (x1, y1) in zip(ring[:-1], ring[1:]):
            k = max(1, int(math.hypot(x1 - x0, y1 - y0) / 5))
            pts += [(x0 + (x1 - x0) * j / k, y0 + (y1 - y0) * j / k) for j in range(k)]
        pts = np.array(pts)
        # step 6 m outwards from the shore to classify it (forest / open)
        cx, cy = pg.centroid.x, pg.centroid.y
        dv = pts - [cx, cy]; dv /= np.maximum(np.hypot(dv[:, 0], dv[:, 1]), 1e-6)[:, None]
        out = pts + dv * 6
        zs = sample10(pts[:, 0], pts[:, 1], order=1)
        fo = sample_grid(F10.astype(np.float64), out[:, 0], out[:, 1]) > 0.5
        lvl = float(np.percentile(zs[~fo], 15)) if (~fo).sum() >= 8 else float(np.percentile(zs, 15))
    water_levels[i] = lvl
    print(f"  water {f['properties'].get('names', {}).get('primary', '') if isinstance(f['properties'].get('names'), dict) else ''} {pg.area / 1e4:.2f} ha: level {lvl:.1f} m")

# Ground elevation at the tower feet as published (de.wikipedia "Windpark Hoßkirch", m ü. NHN). The canopy-corrected DSM is
# off by up to ±14 m at these spots (the DSM predates the clearings), so the residuals are blended in: σ = 300 m around the
# towers, and only in the forest interior — ramping in over the first 300 m from the forest edge, so no banks form at
# the edges and nothing leaks into the fields (plus a σ = 60 m term right at each tower).
CORR_SIGMA = float(os.environ.get('CORR_SIGMA', '300'))
GROUND_PUBLISHED = {'WEA 1': 648.0, 'WEA 2': 645.0, 'WEA 3': 645.0, 'WEA 4': 663.0, 'WEA 5': 671.0, 'WEA 6': 663.0}
d_in = distance_transform_edt(F10) * G10.res
FW = np.clip(d_in / 300.0, 0, 1); FW = FW * FW * (3 - 2 * FW)
num = np.zeros(DTM10.shape); den = np.zeros(DTM10.shape)
for t in turbines_raw:
    tx, ty = to_local(t['lon'], t['lat'])
    r = GROUND_PUBLISHED[t['tags']['ref:local']] - float(sample10(np.array([tx]), np.array([ty]))[0])
    w = np.exp(-((X10 - tx) ** 2 + (Y10 - ty) ** 2) / (2 * CORR_SIGMA ** 2))
    num += w * r; den += w
    print(f"  ground correction {t['tags']['ref:local']}: {r:+.1f} m, {float(sample_grid(d_in, np.array([tx]), np.array([ty]))[0]):.0f} m inside the forest")
DTM10 += num / np.maximum(den, 0.3) * np.maximum(FW, np.exp(-((X10[..., None] - np.array([to_local(t['lon'], t['lat'])[0] for t in turbines_raw])) ** 2
                                                              + (Y10[..., None] - np.array([to_local(t['lon'], t['lat'])[1] for t in turbines_raw])) ** 2).min(-1) / (2 * 60.0 ** 2)))

# no lake above its banks: where the (canopy-corrected) terrain round a lake lies below its water surface, raise it to the
# level + 0.3 m at the shore, rising gently (3 %) and blending out over 80 m
for i, (f, pg) in enumerate(water_polys):
    m = water_masks[i]; lvl = water_levels[i]
    if not m.any(): continue
    ys, xs = np.nonzero(binary_dilation(m, iterations=10))
    y0, y1, x0, x1 = max(0, ys.min() - 2), ys.max() + 3, max(0, xs.min() - 2), xs.max() + 3
    sub = m[y0:y1, x0:x1]
    d_out = distance_transform_edt(~sub) * G10.res
    band = (~sub) & (d_out < 80)
    target = lvl + 0.3 + 0.03 * d_out
    w = np.clip(1 - d_out / 80.0, 0, 1); w = w * w * (3 - 2 * w)
    D = DTM10[y0:y1, x0:x1]
    low = band & (D < target)
    D[low] = D[low] + (target[low] - D[low]) * w[low]

# inside a lake the data terrain sits just under the water surface (whatever the canopy removal made of the water)
for i, (f, pg) in enumerate(water_polys):
    m = water_masks[i]
    if m.any(): DTM10[m] = water_levels[i] - 0.3
# (lake beds are cut at runtime along the exact shoreline, through the fine terrain patches: cut into the 32 m grid here
# they smeared the dip across the shore)
# Around each tower the forest DTM is least certain (the corrections above reach ±14 m) and a crane pad in a forest
# needs a few metres of earthworks, not 20: within ~120 m the terrain's deviation from the tower-foot level is limited
# softly to ±6 m (6·tanh), easing back to the unmodified terrain by 300 m.
for t in turbines_raw:
    tx, ty = to_local(t['lon'], t['lat']); lvl = GROUND_PUBLISHED[t['tags']['ref:local']]
    d = np.hypot(X10 - tx, Y10 - ty)
    near = d < 300
    dev = DTM10[near] - lvl
    lim = 6.0 * np.tanh(dev / 6.0)
    s_ = np.clip((d[near] - 120.0) / 180.0, 0, 1); s_ = s_ * s_ * (3 - 2 * s_)
    DTM10[near] = lvl + lim + (dev - lim) * s_

pad_level = {}
crane = {}                       # per turbine: [levelled region, gravel slab, slab minus a 1.5 m shoulder] (local metres)
crane_ramp = {}
crane_axis = {}
for t in turbines_raw:
    name = t['tags']['ref:local']; tx, ty = to_local(t['lon'], t['lat'])
    pg = Polygon(pads[name]['poly']).buffer(0)
    # axis from the tower towards the far end of its clearing
    far = max(pg.exterior.coords, key=lambda c: math.hypot(c[0] - tx, c[1] - ty))
    cx, cy = pg.centroid.x, pg.centroid.y
    ax, ay = cx - tx, cy - ty; L = math.hypot(ax, ay) or 1.0; ax, ay = ax / L, ay / L
    nx, ny = -ay, ax
    d0, d1, hw = 10.0, 62.0, 14.0         # from the foundation edge along the clearing, 28 m wide
    rect = [(tx + ax * d0 + nx * hw, ty + ay * d0 + ny * hw), (tx + ax * d1 + nx * hw, ty + ay * d1 + ny * hw),
            (tx + ax * d1 - nx * hw, ty + ay * d1 - ny * hw), (tx + ax * d0 - nx * hw, ty + ay * d0 - ny * hw)]
    lvl = GROUND_PUBLISHED[name]
    pad_level[name] = lvl
    # gravel slab: the crane pad rectangle and the hardstanding round the foundation; the terrain is levelled 5 m beyond
    # it, so the rendered ground never rises through the slab edge
    # (the synthetic rectangle is clipped to the traced Sentinel-2 clearing + 1 m; the hardstanding circle is kept)
    slab = Polygon(rect).intersection(pg.buffer(1.0)).union(Point(tx, ty).buffer(13.5, 24)).buffer(0).simplify(0.2)
    if slab.geom_type != 'Polygon': slab = max(slab.geoms, key=lambda q: q.area)
    flat = slab.buffer(5.0, 6).simplify(0.3)
    inner = slab.buffer(-1.5, 6).simplify(0.2)
    crane[name] = [list(flat.exterior.coords)[:-1], list(slab.exterior.coords)[:-1], list(inner.exterior.coords)[:-1]]
    crane_axis[name] = math.degrees(math.atan2(ax, ay)) % 360
    m = poly_mask(flat, G10)
    # ramp width: iterate until the terrain where the ramp ends is reached at ≤ 18° (×1.5 for the smoothstep blend), ≤ 90 m
    ramp = 14.0
    for _ in range(8):
        ring = np.array(flat.buffer(ramp, 8).exterior.coords)
        dh = float(np.max(np.abs(sample10(ring[:, 0], ring[:, 1], order=1) - lvl)))
        new_r = float(np.clip(1.5 * dh / math.tan(math.radians(18.0)), 14.0, 90.0))
        if abs(new_r - ramp) < 0.5: ramp = new_r; break
        ramp = new_r
    crane_ramp[name] = ramp
    dist_out = distance_transform_edt(~m) * G10.res
    w = np.clip(1 - dist_out / ramp, 0, 1); w = w * w * (3 - 2 * w)
    near = w > 0
    DTM10[near] = DTM10[near] * (1 - w[near]) + lvl * w[near]
    zr = sample10(ring[:, 0], ring[:, 1], order=1) - lvl
    print(f'  {name}: crane pad axis {math.degrees(math.atan2(ax, ay)) % 360:.0f}°, ramp {ramp:.0f} m, terrain at ramp end {zr.min():+.1f} … {zr.max():+.1f} m')

def grid_nodes(ext, res):
    n = int(round(2 * ext / res)) + 1
    xs = -ext + np.arange(n) * res; ys = ext - np.arange(n) * res
    return np.meshgrid(xs, ys)

def enc_grid(Z, q, base):
    Qz = np.round((Z - base) / q).astype(np.int64)
    P = np.zeros_like(Qz)
    P[1:, 1:] = Qz[1:, :-1] + Qz[:-1, 1:] - Qz[:-1, :-1]; P[0, 1:] = Qz[0, :-1]; P[1:, 0] = Qz[:-1, 0]
    R = (Qz - P).ravel()
    w = Writer()
    for v in R: w.svar(v)
    return w.b

DEM_CORE_RES = 32.0
Xc, Yc = grid_nodes(CORE + 64, DEM_CORE_RES)          # a margin for normals / blending
Zc = sample10(Xc, Yc, order=3)
DEM_WIDE_RES = 128.0
Xw, Yw = grid_nodes(WIDE, DEM_WIDE_RES)
# wide grid: area-average the 10 m DTM (no aliasing), falls back to cubic sample
Zw = sample10(Xw, Yw, order=1)
Zsm = gaussian_filter(DTM10, 4.0)
Zw = map_coordinates(Zsm, [(G10.ext - Yw) / 10 - 0.5, (Xw + G10.ext) / 10 - 0.5], order=1, mode='nearest')
BASE = 400.0
add_section('demCore', enc_grid(Zc, 0.1, BASE), n=Zc.shape[0], res=DEM_CORE_RES, ext=CORE + 64, q=0.1, base=BASE)
add_section('demWide', enc_grid(Zw, 0.5, BASE), n=Zw.shape[0], res=DEM_WIDE_RES, ext=WIDE, q=0.5, base=BASE)
np.save(C('dem_core_final.npy'), Zc); np.save(C('dem_wide_final.npy'), Zw)

def ground(x, y):
    px = (x + (CORE + 64)) / DEM_CORE_RES; py = ((CORE + 64) - y) / DEM_CORE_RES
    return float(map_coordinates(Zc, [[py], [px]], order=3)[0])

# ----------------------------------------------------------------------------------------------- vectors
print('vectors')
# forest (union of OSM wood/forest), clipped to detail zone
forest_geoms = []
for f in feats('core_land') + feats('core_land_use'):
    p = f['properties']
    if p.get('class') in ('wood', 'forest') and f['geometry']['type'] in ('Polygon', 'MultiPolygon'):
        forest_geoms.append(proj_geom(shape(f['geometry'])).buffer(0))
forest = unary_union(forest_geoms).intersection(CLIP)
L = Layer('forest', [])
for rs in rings_of(forest, 0.8): L.add([], rs)
L.finish()

# land use / land cover classes for the ground detail map
LU = {'farmland': 1, 'meadow': 2, 'grass': 2, 'grassland': 2, 'village_green': 2, 'orchard': 3, 'plant_nursery': 3, 'vineyard': 3,
      'residential': 4, 'garages': 4, 'industrial': 5, 'commercial': 5, 'retail': 5, 'farmyard': 6, 'cemetery': 7,
      'allotments': 8, 'garden': 8, 'flowerbed': 8, 'park': 9, 'pitch': 9, 'recreation_ground': 9, 'playground': 9, 'golf_course': 9,
      'green': 9, 'driving_range': 9, 'track': 9, 'quarry': 10, 'construction': 10, 'landfill': 10, 'bunker': 10,
      'scrub': 11, 'wetland': 12, 'shingle': 10, 'water_park': 9, 'zoo': 9, 'university': 4, 'plaza': 4}
ORDER = {1: 0, 2: 1, 3: 2, 9: 3, 8: 4, 7: 5, 6: 6, 4: 7, 5: 8, 10: 9, 11: 10, 12: 11}
lu = []
for f in feats('core_land_use') + feats('core_land'):
    p = f['properties']; c = LU.get(p.get('class'))
    if not c or f['geometry']['type'] not in ('Polygon', 'MultiPolygon'): continue
    g = proj_geom(shape(f['geometry'])).buffer(0).intersection(CLIP)
    if g.is_empty: continue
    ang = 0
    if c == 1:
        r = g.minimum_rotated_rectangle
        cs = list(r.exterior.coords)
        e1 = (cs[1][0] - cs[0][0], cs[1][1] - cs[0][1]); e2 = (cs[2][0] - cs[1][0], cs[2][1] - cs[1][1])
        e = e1 if math.hypot(*e1) >= math.hypot(*e2) else e2
        ang = int(round((math.degrees(math.atan2(e[1], e[0])) % 180) / 180 * 255)) % 256
    lu.append((ORDER[c], c, ang, g))
lu.sort(key=lambda t: (t[0], -t[3].area))
L = Layer('landuse', ['cls', 'ang'])
for _, c, ang, g in lu:
    for rs in rings_of(g, 1.5): L.add([c, ang], rs)
L.finish()

# water bodies with level (dm above BASE)
L = Layer('water', ['level', 'kind'])
for i, (f, pg) in enumerate(water_polys):
    kind = {'pond': 1, 'lake': 1, 'reservoir': 2, 'basin': 2, 'river': 3, 'water': 1}.get(f['properties'].get('subtype'), 1)
    for rs in rings_of(pg.intersection(CLIP), 0.4):
        L.add([int(round((water_levels[i] - BASE) * 10)), kind], rs)
L.finish()
# waterways (width in dm)
L = Layer('waterway', ['width'])
for f in feats('core_water'):
    g = f['geometry']; p = f['properties']
    if g['type'] not in ('LineString', 'MultiLineString'): continue
    w = {'river': 60, 'stream': 20, 'ditch': 10, 'drain': 10, 'canal': 30}.get(p.get('class'), 12)
    lg = proj_geom(shape(g)).intersection(CLIP)
    for ln in lines_of(lg, 0.5): L.add([w], [ln])
L.finish()

# roads: class code, surface code, width dm, flags
RC = {'motorway': 1, 'trunk': 1, 'primary': 2, 'secondary': 3, 'tertiary': 4, 'unclassified': 5, 'residential': 6, 'living_street': 6,
      'service': 7, 'track': 8, 'path': 9, 'footway': 9, 'cycleway': 9, 'bridleway': 9, 'steps': 9, 'pedestrian': 6, 'unknown': 7}
RW = {1: 90, 2: 75, 3: 68, 4: 60, 5: 48, 6: 52, 7: 36, 8: 32, 9: 16}
SURF = {'paved': 1, 'asphalt': 1, 'concrete': 1, 'paving_stones': 2, 'sett': 2, 'cobblestone': 2, 'compacted': 3, 'gravel': 3,
        'fine_gravel': 3, 'unpaved': 4, 'dirt': 4, 'ground': 4, 'grass': 5, 'wood': 4, 'metal': 1}
seg_features = []
for f in feats('core_segment'):
    p = f['properties']; g = f['geometry']
    if g['type'] != 'LineString': continue
    lg = proj_geom(shape(g)).intersection(CLIP)
    if lg.is_empty: continue
    if p.get('subtype') == 'rail':
        seg_features.append(('rail', p, lg)); continue
    c = RC.get(p.get('class'), 7)
    s = 0
    rs = p.get('road_surface')
    if isinstance(rs, list) and rs:
        s = SURF.get((rs[0] or {}).get('value'), 0)
    if s == 0: s = 1 if c <= 7 else (3 if c == 8 else 4)
    flags = 0
    for fl in p.get('road_flags') or []:
        v = fl.get('values') or []
        if 'is_bridge' in v: flags |= 1
        if 'is_tunnel' in v: flags |= 2
    w = RW[c]
    for wr in p.get('width_rules') or []:
        try: w = int(round(float(wr.get('value')) * 10))
        except Exception: pass
    seg_features.append(('road', (c, s, w, flags), lg))
L = Layer('roads', ['cls', 'surf', 'width', 'flags'])
for kind, a, lg in sorted([s for s in seg_features if s[0] == 'road'], key=lambda s: -s[1][0]):
    for ln in lines_of(lg, 0.6): L.add(list(a), [ln])
L.finish()
L = Layer('rail', [])
for kind, a, lg in [s for s in seg_features if s[0] == 'rail']:
    for ln in lines_of(lg, 0.3): L.add([], [ln])
L.finish()

# buildings: height (dm), class, roof code, eave (dm)
BCLS = {'house': 1, 'detached': 1, 'semidetached_house': 1, 'residential': 1, 'apartments': 2, 'terrace': 1, 'farm': 3,
        'farm_auxiliary': 4, 'barn': 4, 'stable': 4, 'cowshed': 4, 'greenhouse': 5, 'garage': 6, 'garages': 6, 'carport': 6,
        'shed': 6, 'hut': 6, 'roof': 6, 'allotment_house': 6, 'cabin': 6, 'shelter': 6, 'church': 7, 'chapel': 8,
        'industrial': 9, 'warehouse': 9, 'commercial': 9, 'retail': 9, 'service': 10, 'transformer_tower': 11, 'digester': 12,
        'slurry_tank': 12, 'storage_tank': 12, 'school': 2, 'public': 2, 'civic': 2, 'fire_station': 9, 'train_station': 2}
ROOF = {'flat': 1, 'gabled': 2, 'hipped': 3, 'skillion': 4, 'pyramidal': 5, 'dome': 6, 'round': 6, 'half-hipped': 3, 'gambrel': 2, 'mansard': 3}
L = Layer('buildings', ['height', 'eave', 'cls', 'roof'])
nb = 0
for f in feats('core_building'):
    p = f['properties']
    if p.get('is_underground'): continue
    g = proj_geom(shape(f['geometry'])).buffer(0)
    if g.is_empty or not g.intersects(CLIP): continue
    if g.geom_type == 'MultiPolygon': g = max(g.geoms, key=lambda q: q.area)
    area = g.area
    if area < 6: continue
    cls = BCLS.get(p.get('class'), 0)
    if cls == 0:
        cls = 6 if area < 40 else (1 if area < 260 else 4)
    roof = ROOF.get(p.get('roof_shape'), 0)
    if roof == 0:
        roof = {1: 2, 2: 3, 3: 2, 4: 2, 5: 1, 6: 2, 7: 2, 8: 2, 9: 1, 10: 1, 11: 5, 12: 6}[cls]
        if cls == 6 and area < 25: roof = 1
        if cls == 9 and area < 400: roof = 2
    H = p.get('height')
    lv = p.get('num_floors')
    # eave height heuristics per class, then total height
    eave = {1: 5.6, 2: 8.5, 3: 6.0, 4: 6.5, 5: 3.2, 6: 2.6, 7: 11.0, 8: 5.0, 9: 7.0, 10: 3.0, 11: 8.0, 12: 6.0}[cls]
    if lv: eave = max(2.6, float(lv) * 2.9)
    r = g.minimum_rotated_rectangle
    cs = list(r.exterior.coords); w1 = math.dist(cs[0], cs[1]); w2 = math.dist(cs[1], cs[2]); span = min(w1, w2)
    pitch = {1: 42, 2: 30, 3: 35, 4: 24, 5: 28, 6: 18, 7: 48, 8: 45, 9: 12, 10: 20, 11: 0, 12: 0}[cls]
    roof_h = 0.0 if roof == 1 else (span / 2) * math.tan(math.radians(pitch))
    if roof in (3, 5): roof_h *= 0.9
    roof_h = min(roof_h, 14.0)
    if H:
        H = float(H)
        if H > eave + roof_h + 4 or H < eave * 0.6:        # ML height: trust it but keep a plausible split
            eave = max(2.4, H - roof_h) if roof != 1 else H
        else:
            eave = max(2.4, H - roof_h) if roof != 1 else H
    Htot = eave + (0 if roof == 1 else roof_h)
    if cls in (11,): eave, Htot = 7.5, 7.5
    for rs in rings_of(g, 0.35):
        L.add([int(round(Htot * 10)), int(round(eave * 10)), cls, roof], rs[:1])
        nb += 1
L.finish()

# power: 110 kV lines (and minor lines) with support points
L = Layer('power', ['kind', 'cables'])
towers = []
for f in feats('core_infrastructure'):
    p = f['properties']; g = f['geometry']; st = p.get('source_tags') or {}
    if p.get('class') in ('power_line', 'minor_line') and g['type'] == 'LineString':
        lg = proj_geom(shape(g)).intersection(CLIP.buffer(400, join_style=2))
        if lg.is_empty: continue
        kind = 1 if p['class'] == 'power_line' else 2
        cables = int(str(st.get('cables', '3')).split(';')[0] or 3) if kind == 1 else 3
        for ln in lines_of(lg, 0.0): L.add([kind, cables], [ln])
    if p.get('class') in ('power_tower', 'power_pole', 'portal') and g['type'] == 'Point':
        pt = proj_geom(shape(g))
        if CLIP.contains(pt): towers.append((1 if p['class'] != 'power_pole' else 2, pt))
L.finish()
L = Layer('supports', ['kind'])
for k, pt in towers: L.add([k], [[(pt.x, pt.y)]])
L.finish()

# trees: single trees, rows, hedges
L = Layer('trees', ['kind'])
for f in feats('core_land'):
    p = f['properties']; g = f['geometry']
    if p.get('class') == 'tree' and g['type'] == 'Point':
        pt = proj_geom(shape(g))
        if CLIP.contains(pt): L.add([1], [[(pt.x, pt.y)]])
    if p.get('class') == 'tree_row' and g['type'] == 'LineString':
        for ln in lines_of(proj_geom(shape(g)).intersection(CLIP), 0.5): L.add([2], [ln])
for f in feats('core_infrastructure'):
    p = f['properties']; g = f['geometry']
    if p.get('class') == 'hedge' and g['type'] == 'LineString':
        for ln in lines_of(proj_geom(shape(g)).intersection(CLIP), 0.5): L.add([3], [ln])
L.finish()

# crane pads (traced from Sentinel-2 NDVI, see pads.py), level in dm above BASE
L = Layer('pads', ['level'])                       # construction clearings (gravel), follow the terrain
for name in sorted(pads):
    pg = Polygon(pads[name]['poly']).buffer(0)
    for rs in rings_of(pg, 1.0): L.add([0], rs)
L.finish()
L = Layer('cranepads', ['level', 'ramp', 'axis'])  # rings: levelled region, gravel slab, slab inner edge; ramp width (m), pad axis (°)
for name in sorted(crane):
    L.add([int(round((pad_level[name] - BASE) * 10)), int(round(crane_ramp[name])), int(round(crane_axis[name]))], crane[name])
L.finish()

# ----------------------------------------------------------------------------------------------- rasters
print('rasters')
# wide forest mask (25 m, ±12800) for the outer canopy shell
forest_w = []
for f in feats('wide_land') + feats('wide_land_use'):
    p = f['properties']
    if p.get('class') in ('wood', 'forest') and f['geometry']['type'] in ('Polygon', 'MultiPolygon'):
        forest_w.append(f)
GW = Grid(WIDE, 25)
from geo import rasterize
Fw = np.asarray(rasterize(forest_w, GW)) > 127
bits = np.packbits(Fw.ravel())
add_section('forestWide', bits.tobytes(), n=GW.n, res=25, ext=WIDE)

# forest openness from Sentinel-2 (June/July 2026 median): mature canopy 0 … open / young growth 7, 16 m grid over the
# detail zone. Built by openness.py into core10_open.npy (10 m); resampled here.
O10 = np.load(C('core10_open.npy'))
GO = Grid(CORE, 16)
Xo, Yo = GO.xy()
Oq = map_coordinates(O10, [(4096 - Yo) / 10 - 0.5, (Xo + 4096) / 10 - 0.5], order=1, mode='constant')
add_section('openness', np.round(np.clip(Oq, 0, 1) * 7).astype(np.uint8).tobytes(), n=GO.n, res=16, ext=CORE, levels=7)

# far ring (±64 km, 500 m) and the skyline beyond it (see fetch_far.py)
FAR = np.load(C('far_dem.npy')).astype(np.float64)
FAR = np.maximum(FAR, 395.3)                          # Lake Constance: bathymetry → lake surface (395.3 m)
add_section('demFar', enc_grid(FAR, 1.0, 0.0), n=FAR.shape[0], res=500.0, ext=64000.0, q=1.0, base=0.0, lake=395.3)
LC = gaussian_filter(np.load(C('far_lc.npy')), (0, 0.7, 0.7))[:, ::2, ::2]      # 1 km is plenty 13–64 km away
add_section('farCover', (np.round(np.clip(LC[0], 0, 1) * 15).astype(np.uint8) * 16 + np.round(np.clip(LC[1] * 2.5, 0, 1) * 15).astype(np.uint8)).tobytes(),
            n=LC.shape[1], res=1000.0, ext=64000.0)
HZ = np.load(C('horizon.npy'))
w = Writer()
for v in np.round(HZ * 20000).astype(int): w.svar(int(v))
add_section('horizon', w.b, n=len(HZ), scale=1 / 20000, eye=900)

# ----------------------------------------------------------------------------------------------- images
print('images')
def srgb(lin):
    lin = np.clip(lin, 0, 1)
    return np.where(lin <= 0.0031308, lin * 12.92, 1.055 * lin ** (1 / 2.4) - 0.055)
GAIN = 2.5
for name, q in (('core', 72), ('wide', 62)):
    refl = np.load(C(f's2_{name}_refl.npy'))
    im = Image.fromarray((srgb(refl * GAIN) * 255 + 0.5).astype(np.uint8))
    if name == 'wide': im = im.resize((640, 640), Image.LANCZOS)
    im.save(os.path.join(OUT, f'{name}.webp'), 'WEBP', quality=q, method=6)
    print(f'  {name}.webp', os.path.getsize(os.path.join(OUT, f"{name}.webp")), im.size)

# ----------------------------------------------------------------------------------------------- header
turbines = []
for t in turbines_raw:
    x, y = to_local(t['lon'], t['lat'])
    tg = t['tags']
    turbines.append(dict(id=tg['ref:local'], lon=t['lon'], lat=t['lat'], x=round(x, 2), y=round(y, 2),
                         ground=round(pad_level[tg['ref:local']], 1), hub=float(tg['height:hub'].split()[0]),
                         rotor=float(tg['rotor:diameter'].split()[0]), mw=7.2, mastr=tg.get('ref:mastr'), start=tg.get('start_date'),
                         osm=t['id']))
# other turbines in the wider region (for the horizon)
others = []
for t in json.load(open(C('wind_turbines_region.json'))):
    if t['tags'].get('model') == 'V172': continue
    x, y = to_local(t['lon'], t['lat'])
    tg = t['tags']
    def num(v, d):
        try: return float(str(v).split()[0])
        except Exception: return d
    rot = num(tg.get('rotor:diameter'), 130); hub = num(tg.get('height:hub'), num(tg.get('height'), 200) - rot / 2)
    others.append(dict(x=round(x), y=round(y), hub=hub, rotor=rot, model=f"{tg.get('manufacturer', '')} {tg.get('model', '')}".strip()))
labels = []
PLACE_W = {'village': 3, 'town': 4, 'hamlet': 2, 'locality': 1, 'neighborhood': 1}
for f in feats('core_division'):
    p = f['properties']
    if p.get('subtype') != 'locality': continue
    g = shape(f['geometry'])
    if g.geom_type != 'Point': continue
    x, y = to_local(g.x, g.y)
    if abs(x) > WIDE or abs(y) > WIDE: continue
    labels.append(dict(name=(p.get('names') or {}).get('primary'), x=round(x), y=round(y), rank=PLACE_W.get(p.get('class'), 1),
                       pop=p.get('population')))

# pack sections
blob = bytearray(); meta = collections.OrderedDict()
for k, (data, m) in sections.items():
    m = dict(m); m['off'] = len(blob); m['len'] = len(data); meta[k] = m; blob += data
comp = zlib.compressobj(9, zlib.DEFLATED, -15)
packed = comp.compress(bytes(blob)) + comp.flush()
open(os.path.join(OUT, 'scene.bin'), 'wb').write(packed)
header = dict(origin=dict(lon=LON0, lat=LAT0), proj='tmerc k=1 WGS84', core=CORE, wide=WIDE, base=BASE, sections=meta,
              turbines=turbines, others=others, labels=labels,
              imagery=dict(core=dict(ext=CORE, res=8, gain=GAIN), wide=dict(ext=WIDE, res=40, gain=GAIN),
                           scene='S2C_32UNU_20260619_0_L2A', date='2026-06-19'),
              sources=dict(osm='Overture Maps 2026-09-23.1 (OpenStreetMap © contributors, ODbL; Microsoft ML building heights)',
                           dem='Copernicus GLO-30 DSM (canopy removed)', imagery='Copernicus Sentinel-2 L2A 2026-06-19'))
json.dump(header, open(os.path.join(OUT, 'scene.json'), 'w'), ensure_ascii=False, indent=1)
print(f'scene.bin {len(packed)} B (raw {len(blob)} B), buildings {nb}')
