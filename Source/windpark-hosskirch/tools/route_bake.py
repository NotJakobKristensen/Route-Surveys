"""Bake the route-survey page data → windpark-hosskirch/data/route/{route.json, route.bin, *.webp}.

route.bin is one deflate stream of sections (varint / zig-zag delta coded, as scene.bin):
  mapDem            2 km height grid of the map frame (predictor coded)
  route             the route, simplified to 12 m, map frame, 1 m units; routeKm: km of every vertex (1 m units)
  routeSev          difficulty per 200 m of route (0 passes, 1 needs care, 2 difficult)
  motorways, borders, rivers, lakes   context layers (map frame, 20 m units)
  h_<id>_*          per hot spot, local frame (dm units): ground grid, roads, buildings, trees, objects, barriers, water,
                    path, convoy poses, swept areas
"""
import routecfg
import collections, glob, io, json, math, os, pickle, sys, zlib
import numpy as np
from PIL import Image
from pyproj import Transformer
from scipy.ndimage import map_coordinates, gaussian_filter
from scipy.spatial import cKDTree
from shapely.geometry import LineString, Polygon, MultiPolygon, Point, box
from shapely.ops import unary_union, substring
import pyarrow.parquet as pq, pyarrow.compute as pc
from shapely import wkb
from route_swept import V, half_width
from route_hotspots import HOT

HERE = os.path.dirname(os.path.abspath(__file__))
C = routecfg.C
OUT = routecfg.DATA
os.makedirs(OUT, exist_ok=True)
utm = Transformer.from_crs('EPSG:32633', 'EPSG:4326', always_xy=True)
meta = json.load(open(C + 'map_meta.json'))
mfw = Transformer.from_crs('EPSG:4326', meta['proj'], always_xy=True)
# the blade beyond the edge at every passage and lane stretch (route_blade.mjs: the page's own model, as the drive view has it)
BLADE = json.load(open(C + 'corr/blade_edge.json')) if os.path.exists(C + 'corr/blade_edge.json') else None


class Writer:
    def __init__(self): self.b = bytearray()
    def var(self, v):
        v = int(v); assert v >= 0, v
        while v >= 128: self.b.append((v & 127) | 128); v >>= 7
        self.b.append(v)
    def svar(self, v):
        v = int(v); self.var((v << 1) ^ (v >> 63) if v < 0 else v << 1)


sections = collections.OrderedDict()
def add(name, data, **m):
    sections[name] = (bytes(data), m)


class Layer:
    def __init__(self, name, attrs, q):
        self.name, self.attrs, self.q, self.w, self.n, self.px, self.py = name, attrs, q, Writer(), 0, 0, 0
    def add(self, attrs, rings):
        rings = [r for r in rings if len(r) >= 1]
        if not rings: return
        for a in attrs: self.w.var(a)
        self.w.var(len(rings))
        for r in rings:
            self.w.var(len(r))
            for x, y in r:
                qx, qy = int(round(x * self.q)), int(round(y * self.q))
                self.w.svar(qx - self.px); self.w.svar(qy - self.py); self.px, self.py = qx, qy
        self.n += 1
    def finish(self, **m):
        w = Writer(); w.var(self.n); w.var(len(self.attrs)); w.b += self.w.b
        add(self.name, w.b, q=self.q, count=self.n, attrs=self.attrs, **m)


def enc_grid(Z, q, base):
    Qz = np.round((Z - base) / q).astype(np.int64)
    P = np.zeros_like(Qz)
    P[1:, 1:] = Qz[1:, :-1] + Qz[:-1, 1:] - Qz[:-1, :-1]; P[0, 1:] = Qz[0, :-1]; P[1:, 0] = Qz[:-1, 0]
    w = Writer()
    for v in (Qz - P).ravel(): w.svar(v)
    return w.b


def rings_of(g):
    out = []
    for p in getattr(g, 'geoms', [g]):
        if p.is_empty: continue
        if p.geom_type == 'Polygon': out.append(list(p.exterior.coords)[:-1]); out += [list(r.coords)[:-1] for r in p.interiors]
        elif p.geom_type == 'LineString': out.append(list(p.coords))
    return out


def tone(v):
    v = np.clip(v / 10000.0, 0, 1)
    return np.clip((v * 3.2) ** (1 / 2.0), 0, 1)


# ================================================================================================= route on the map
z = np.load(C + 'screen.npz')
Ru = pickle.load(open(C + 'route.pkl', 'rb'))
s_all = z['s']; Pu = z['P']; SEG = z['SEG']
lon, lat = utm.transform(Pu[:, 0], Pu[:, 1])
mx, my = mfw.transform(lon, lat)
total_km = float(s_all[-1] / 1000)
step = 10
idx10 = np.arange(0, len(mx), step)
line = LineString(np.c_[mx[idx10], my[idx10]])
simp = line.simplify(12.0)
tree = cKDTree(np.c_[mx[idx10], my[idx10]])
kept, last = [], 0
for x, y in simp.coords:
    d, k = tree.query((x, y), k=8)
    k = [int(i) for i in np.atleast_1d(k) if i >= last]
    j = min(k, key=lambda i: (mx[idx10[i]] - x) ** 2 + (my[idx10[i]] - y) ** 2) if k else last
    kept.append(j); last = j
kept = np.array(kept); vid = idx10[kept]
L = Layer('route', [], 1.0); L.add([], [list(zip(mx[vid], my[vid]))]); L.finish()
w = Writer(); prev = 0
for v in vid:
    m_ = int(round(s_all[v])); w.svar(m_ - prev); prev = m_
add('routeKm', w.b, n=len(vid))
print('route vertices', len(vid), 'of', len(mx))

# difficulty per 200 m from the screen; hot-spot windows get their own verdict
wmax = np.nan_to_num(np.maximum(z['wL'], z['wR'])); bmax = np.nan_to_num(np.maximum(z['bL'], z['bR']))
BIN = 200
nb = int(math.ceil(s_all[-1] / BIN))
sev = np.zeros(nb, np.uint8)
b_of = (s_all // BIN).astype(int)
wcl = np.nan_to_num(z['wm'], nan=9.0)
lvl = np.where(wmax > 0.5, 2, np.where((wmax > 0.1) | (bmax > 3) | (wcl < 0.3), 1, 0)).astype(np.uint8)
np.maximum.at(sev, b_of, lvl)


# ================================================================================================= legs and nights
def ref_at(i): return Ru[SEG[i]][0]['ref'] or ''
LEGS = [('S3 / A6 to the border at Kołbaskowo – Pomellen', 'Goleniów → S3 → A6 → border', lambda r: 'A 11' in r),
        ('A 11 to the Berlin ring', 'A 11 · Uckermark', lambda r: 'A 10' in r),
        ('A 10 Berliner Ring, north and west', 'A 10 · Dreieck Barnim → Dreieck Potsdam', lambda r: r.startswith('A 9') or ';A 9' in r or r == 'A 9'),
        ('A 9 south: Berlin → Nürnberg', 'A 9 · Leipzig · Hof · Bayreuth', lambda r: 'E 50' in r or 'A 6' in r),
        ('A 6 west to Kreuz Feuchtwangen/Crailsheim', 'A 6 · Ansbach', lambda r: 'E 43' in r),
        ('A 7 south to Neu-Ulm', 'A 7 · Ellwangen · Ulm', lambda r: 'B 28' in r),
        ('B 28 / B 30 through Upper Swabia', 'B 28 · B 30 · Biberach · Bad Waldsee', lambda r: 'B 32' in r),
        ('B 32 to Haid', 'B 32 · Weingarten → Altshausen → Haid', lambda r: 'K 8274' in r),
        ('K 8274 and the forest tracks', 'K 8274 · Wilfertsweiler · Heratskirch · Wagenhart forest', lambda r: False)]
if routecfg.get('route_legs'):                # another route: [name, roads, refs that start the next leg (any)]
    LEGS = [(n_, r_, (lambda nx: (lambda r: any(x in r for x in nx)))(nx_)) for n_, r_, nx_ in routecfg.get('route_legs')]
legs, i, li = [], 0, 0
start = 0
stepi = 25
while li < len(LEGS) and i < len(s_all):
    nxt = LEGS[li][2]
    j = i
    while j < len(s_all) and not nxt(ref_at(j)): j += stepi
    j = min(j, len(s_all) - 1)
    legs.append(dict(name=LEGS[li][0], roads=LEGS[li][1], a=round(s_all[start] / 1000, 1), b=round(s_all[j] / 1000, 1)))
    start = i = j; li += 1
legs[-1]['b'] = round(total_km, 1)
for l in legs: print(f"  leg {l['a']:6.1f}–{l['b']:6.1f} {l['name']}")

# illustrative night schedule: driving 22:00–06:00 (about 7 h on the move), heavy-transport speeds by road type
SPD = {'motorway': 45, 'trunk': 32, 'primary': 22, 'secondary': 18, 'tertiary': 12, 'track': 5}
nights, t, cur, k0 = [], 0.0, 1, 0.0
seg_cls = np.array([Ru[k][0]['cls'] for k in range(len(Ru))])
cls_pt = seg_cls[SEG[::100]]
km_pt = s_all[::100] / 1000
for kk, c in zip(km_pt, cls_pt):
    t += 0.1 / SPD.get(c, 12)
    if t >= 7.0:
        nights.append(dict(n=cur, a=round(k0, 1), b=round(kk, 1))); cur += 1; t = 0; k0 = kk
nights.append(dict(n=cur, a=round(k0, 1), b=round(total_km, 1)))
HOTWIN = []   # filled below; nights are adjusted after the hot spots are known


# ================================================================================================= map raster + context
mdem0 = np.load(C + 'map_dem.npy')
MW0, MH0, mstep0 = meta['mesh']
mstep = 4000.0
MW, MH = int((MW0 - 1) * mstep0 / mstep) + 1, int((MH0 - 1) * mstep0 / mstep) + 1
mdem = map_coordinates(mdem0, np.meshgrid(np.arange(MH) * mstep / mstep0, np.arange(MW) * mstep / mstep0, indexing='ij'), order=1)
base = float(np.floor(mdem.min()))
add('mapDem', enc_grid(mdem, 6.0, base), nx=MW, ny=MH, step=mstep, base=base, q=6.0)
odem0 = np.load(C + 'map_outer_dem.npy'); OM = meta['outer']
ostep = 9000.0; ONX, ONY = int((OM['mesh'][0] - 1) * OM['mesh'][2] / ostep) + 1, int((OM['mesh'][1] - 1) * OM['mesh'][2] / ostep) + 1
odem = map_coordinates(odem0, np.meshgrid(np.arange(ONY) * ostep / OM['mesh'][2], np.arange(ONX) * ostep / OM['mesh'][2], indexing='ij'), order=1)
add('outerDem', enc_grid(odem, 12.0, float(np.floor(odem.min()))), nx=ONX, ny=ONY, step=ostep, base=float(np.floor(odem.min())), q=12.0)
ctx = pickle.load(open(C + 'context.pkl', 'rb'))
TURB = routecfg.get('turbines') or json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'scene.json')))['turbines']
ext_poly = box(meta['x0'], meta['y0'], meta['x1'], meta['y1'])
_RDS = None
PAVED_S = ('paved', 'asphalt', 'concrete', 'paving_stones', 'sett', 'cobblestone', 'metal', 'wood')


def road_attrs(xy, proj, cls):
    """a passage's mapped road (its line in the passage's frame): one-way (8) and unpaved (16) as the same way has them in
    the route's road pieces (route_roads.py: Overture's access restrictions and road surface, within 120 m of the route) —
    the pieces of the same class running within 1.5 m of the line along 70 % of the shorter of the two; elsewhere neither
    (the passage's own map data have no such attributes)"""
    global _RDS
    if _RDS is None:
        fn = C + 'corr/roads.pkl'
        _RDS = [q for blk in pickle.load(open(fn, 'rb'))['blocks'].values() for q in blk if len(q['xy']) >= 2] if os.path.exists(fn) else []
    if not _RDS or len(xy) < 2: return 0
    if getattr(road_attrs, 'cache', (None,))[0] != proj:
        tr = Transformer.from_crs('EPSG:32633', proj, always_xy=True); loc = []
        for q in _RDS:
            X, Y = tr.transform(np.asarray(q['xy'][:, 0], float), np.asarray(q['xy'][:, 1], float)); L = np.c_[X, Y]
            loc.append((L.min(0), L.max(0), LineString(L), q))
        road_attrs.cache = (proj, loc)
    P_ = np.asarray(xy)[:, :2]; lo, hi = P_.min(0) - 2, P_.max(0) + 2; ln = LineString(P_); fl = 0
    for a, b, L, q in road_attrs.cache[1]:
        if a[0] > hi[0] or a[1] > hi[1] or b[0] < lo[0] or b[1] < lo[1]: continue
        if q['cls'] and cls != 'unknown' and q['cls'] != cls: continue
        sh, other = (L, ln) if L.length < ln.length else (ln, L)
        if sh.length < 3 or sh.intersection(other.buffer(1.5)).length < 0.7 * sh.length: continue
        if q.get('oneway'): fl |= 8
        if (q.get('surf') or 'paved') not in PAVED_S or (q['cls'] == 'track' and not q.get('surf')): fl |= 16
    return fl


def proj_geom(g):
    from shapely.ops import transform
    return transform(lambda X, Y, Z=None: mfw.transform(X, Y), g)
Lb = Layer('borders', ['kind'], 0.004)
for sub, cc, g in ctx['borders']:
    pg = proj_geom(g).intersection(ext_poly).simplify(900)
    for r in rings_of(pg): Lb.add([0 if sub == 'country' else 1], [r])
Lb.finish()
Lr = Layer('rivers', [], 0.004)
for n, g in ctx['rivers']:
    pg = proj_geom(g).intersection(ext_poly).simplify(650)
    for r in rings_of(pg):
        if len(r) > 1: Lr.add([], [r])
Lr.finish()
Ll = Layer('lakes', [], 0.004)
for n, g in ctx['lakes'] + ctx['sea']:
    pg = proj_geom(g).intersection(ext_poly).simplify(500)
    for p in getattr(pg, 'geoms', [pg]):
        if p.geom_type == 'Polygon' and p.area > 2e7: Ll.add([], [list(p.exterior.coords)[:-1]])
Ll.finish()
# motorways within 140 km of the route (net_major), simplified to 300 m
t_ = pq.read_table(C + 'net_major.parquet', columns=['class', 'subclass', 'geometry'])
t_ = t_.filter(pc.equal(t_['class'], 'motorway'))
corr = LineString(np.c_[mx[idx10][::20], my[idx10][::20]]).buffer(80000)
mw_lines = []
for r in t_.to_pylist():
    if r['subclass'] == 'link': continue
    g = proj_geom(wkb.loads(r['geometry']))
    if corr.intersects(g): mw_lines.append(g)
from shapely.ops import linemerge
mw = linemerge(unary_union(mw_lines)).simplify(1000)
Lm = Layer('motorways', [], 0.004)
for r in rings_of(mw):
    if len(r) > 1: Lm.add([], [r])
Lm.finish()
print('  motorways pts', sum(len(r) for r in rings_of(mw)))
# places
route_line_m = LineString(np.c_[mx[vid], my[vid]])
KEEP = {'Goleniów', 'Szczecin', 'Berlin', 'Potsdam', 'Leipzig', 'Hof', 'Bayreuth', 'Nürnberg', 'Ansbach', 'Feuchtwangen', 'Crailsheim',
        'Ulm', 'Neu-Ulm', 'Biberach an der Riß', 'Bad Waldsee', 'Ravensburg', 'Weingarten', 'Altshausen', 'Hoßkirch', 'Bad Saulgau',
        'Dresden', 'Erfurt', 'Stuttgart', 'München', 'Würzburg', 'Magdeburg', 'Halle (Saale)', 'Jena', 'Gera', 'Plauen', 'Augsburg',
        'Regensburg', 'Ingolstadt', 'Prenzlau', 'Schwedt/Oder', 'Ellwangen (Jagst)', 'Aalen', 'Memmingen', 'Friedrichshafen', 'Konstanz', 'Frankfurt (Oder)', 'Cottbus', 'Chemnitz', 'Zwickau', 'Dessau-Roßlau', 'Wittenberg', 'Lutherstadt Wittenberg', 'Bamberg'}
KEEP |= set(routecfg.get('keep_towns', []))
places, seen = [], set()
for tw in sorted(ctx['towns'], key=lambda t: -(t['pop'] or 0)):
    if tw['sub'] != 'locality' or not tw['name'] or tw['name'] in seen: continue
    x, y = mfw.transform(tw['lon'], tw['lat'])
    if not ext_poly.contains(Point(x, y)): continue
    d = route_line_m.distance(Point(x, y))
    bx, by = mfw.transform(13.405, 52.52)
    if tw['name'] not in ('Berlin', 'Potsdam') and math.hypot(x - bx, y - by) < 22000: continue
    if tw['name'] == 'Police': continue
    if tw['name'] in KEEP or (tw['pop'] or 0) > 250000 or ((tw['pop'] or 0) > 40000 and d < 25000):
        seen.add(tw['name'])
        places.append(dict(n=tw['name'].replace('Biberach an der Riß', 'Biberach').replace('Ellwangen (Jagst)', 'Ellwangen').replace('Lutherstadt Wittenberg', 'Wittenberg'),
                           x=round(x), y=round(y), k='big' if (tw['pop'] or 0) > 400000 else 'town', pop=tw['pop'] or 0, d=round(d)))
for n, lo, la in (('Polska', 15.0, 53.2), ('Deutschland', 11.0, 51.35), ('Česko', 13.6, 49.9), ('Österreich', 9.90, 47.42)):
    x, y = mfw.transform(lo, la)
    if ext_poly.contains(Point(x, y)): places.append(dict(n=n, x=round(x), y=round(y), k='country'))
print('  places', len(places))

# ================================================================================================= hot spots
CODES_ROAD = {c: i for i, c in enumerate(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'service',
                                          'living_street', 'track', 'footway', 'cycleway', 'path', 'pedestrian', 'steps', 'unknown', 'rail'])}
CODES_OBJ = {c: i for i, c in enumerate(['street_lamp', 'traffic_signals', 'power_pole', 'power_tower', 'bus_stop', 'stop', 'give_way',
                                         'information', 'bollard', 'crossing', 'tree', 'other'])}
CODES_BAR = {c: i for i, c in enumerate(['guard_rail', 'fence', 'wall', 'hedge', 'retaining_wall', 'kerb', 'jersey_barrier', 'gate', 'other'])}
images = {}
hot_meta = []

EVIDENCE = json.load(open(os.path.join(routecfg.ROOT, routecfg.get('evidence')) if routecfg.get('evidence') else os.path.join(HERE, 'route_evidence.json'))) if routecfg.get('evidence', 1) else {}


_OVR = None
def overs_in(a, b):
    """the structures over the route between route metres a and b, with their clear heights (as the road packs)"""
    global _OVR
    if _OVR is None:
        import route_pack as RP
        over = sorted([o for b_ in pickle.load(open(C + 'corr/objects.pkl', 'rb'))['blocks'].values() for o in b_['over']], key=lambda o: o['s'])
        _OVR = RP.overs(over, 0, 1e9, 0.0, 0.0)
    return [r for r in _OVR if a <= r['s'] <= b and r.get('kind') in ('bridge', 'limit')]


def measures(sm, D, extra=()):
    m = list(extra)
    c = collections.Counter(); length = collections.defaultdict(float); area = collections.defaultdict(float)
    for cf in sm['conflicts']:
        c[cf['what']] += 1
        if 'length' in cf: length[cf['what']] += cf['length']
        if 'area' in cf: area[cf['what']] += cf['area']
    if sm['wheel_out_max'] > 0.25:
        a = sm['wheel_out_area']
        m.append(("One set of steel plates" if a < 15 else f"Temporary hardstanding (steel plates or compacted gravel) of about {round(a, -1):.0f} m²") + f" where the wheel units leave the paved area, by up to {sm['wheel_out_max']:.1f} m.")
    if sm['blade_out_max'] > 1.0:
        m.append(f"Overswing zone of about {round(sm['blade_out_area'], -1):.0f} m² beyond the road edge (the blade reaches up to {sm['blade_out_max']:.0f} m out), kept clear of everything above the blade underside.")
    ln = sm.get('lane')
    if ln and ln['used_m'] >= 8:
        # (a road with two lanes or more one way: lane 2, which the escort closes; a two-way road: the oncoming lane)
        l2 = ln.get('kind') == 'lane2'; into = 'into lane 2' if l2 else 'across the centre line'
        kr = f"keeping right the wheels would leave the road by up to {ln['kr_wheel_out_max']:.1f} m" if ln['kr_wheel_out_max'] > 0.25 else \
             f"keeping right the wheels would reach {into} by {max(0, ln['kr_across_max']):.1f} m anyway" if ln['kr_across_max'] > 0.6 else \
             f"keeping right the blade would reach {ln['kr_blade_out_max']:.0f} m beyond the road" if ln['kr_blade_out_max'] > sm['blade_out_max'] + 1 else "it eases the line"
        m.insert(0, f"Use {'lane 2' if l2 else 'the oncoming lane'} for about {round(ln['used_m'], -1):.0f} m (wheels up to {ln['across_max']:.1f} m {into}): "
                    f"{'the escort closes it' if l2 else 'the escort holds oncoming traffic'}; {kr}.")
    if length.get('guard rail'): m.append(f"Dismantle about {length['guard rail']:.0f} m of guardrail for the passage and reinstall it afterwards.")
    if length.get('fence'): m.append(f"Open or take down about {length['fence']:.0f} m of fence in the swept path.")
    WORDS = {'traffic signals': ('Swing aside or dismantle', 'signal head'), 'street lamp': ('Dismount', 'street lamp'), 'bus stop': ('Remove', 'bus-stop sign / shelter'),
             'stop sign': ('Unbolt', 'stop sign'), 'give-way sign': ('Unbolt', 'give-way sign'), 'information sign': ('Unbolt', 'information sign'),
             'power pole': ('Check the clearance at', 'power pole'), 'bollard': ('Remove', 'bollard')}
    for what, (verb, noun) in WORDS.items():
        n = c.get(what)
        if n: m.append(f"{verb} {n} {noun}{'s' if n > 1 else ''} in the swept area.")
    nb_ = sum(1 for cf in sm['conflicts'] if cf['kind'] == 'overpass')
    if nb_:
        rs = [r for r in overs_in(sm['km'][0] * 1000 - 50, sm['km'][1] * 1000 + 50) if r.get('signed') is not None or r.get('est') is not None]
        def nm(r): return r.get('name') or ('railway' if r.get('sub') == 'rail' else (r.get('cls') or 'bridge'))
        nb_ = max(nb_, len(rs))                      # a crossing on two decks (a motorway's carriageways) counts both
        hs_ = '; '.join((f"{nm(r)} {r['signed']:.2f} m signed" if r.get('signed') is not None else f"{nm(r)} ≈ {r['est']:.1f} m ±{r.get('unc', 0.5):.1f}") for r in rs)
        m.append(f"Check the clear height under {nb_} bridge{'s' if nb_ > 1 else ''} over the route on site" + (f" (estimated: {hs_})" if hs_ else " (not measured)") + f"; transport height about {V.get('height', 4.7):.1f} m.")
    oc = [cf for cf in sm['conflicts'] if cf.get('kind') == 'osm']
    isl = [cf for cf in oc if 'island' in cf['what'] or 'choker' in cf['what']]
    if isl: m.append(f"{len(isl)} traffic island{'s' if len(isl) > 1 else ''} in the wheel path (open map data{', about %.0f m² overlap' % sum(cf.get('area', 0) for cf in isl) if any(cf.get('area') for cf in isl) else ''}): ramp over with steel plates or timber, take out the signs and posts on them, or remove the island for the run with the road authority; check the kerb height on site.")
    kb = [cf for cf in oc if 'kerb' in cf['what']]
    if kb: m.append(f"About {sum(cf.get('length', 0) for cf in kb):.0f} m of raised kerb in the wheel path: ramps or steel plates and a spotter at each crossing of the kerb.")
    br = [cf for cf in oc if any(w in cf['what'] for w in ('bollard', 'gate', 'barrier', 'block', 'height restrictor'))]
    if br: m.append(f"Remove for the run: {'; '.join(sorted({cf['what'] for cf in br}))} (mapped in the open map data; the road authority or owner unlocks or removes them).")
    wl = [cf for cf in oc if cf['what'].startswith(('overhead power', 'overhead telecom')) and cf.get('low')]
    if wl:
        ops = sorted({cf.get('operator') for cf in wl if cf.get('operator')})
        m.append(f"{len(wl)} low-hanging overhead line{'s' if len(wl) > 1 else ''} cross{'' if len(wl) > 1 else 'es'} the route ({'; '.join(sorted({cf['what'].replace(' over the route', '') for cf in wl}))}): have {'the operator (' + ', '.join(ops) + ')' if ops else 'the operator'} confirm the sag at the crossing is above the transport height plus margin, or lift or switch off the line for the passage.")
    lm = [cf for cf in oc if cf['what'].startswith(('weight limit', 'width limit', 'length limit', 'closed to lorries'))]
    if lm: m.append(f"Signed restriction on the route here ({'; '.join(sorted({cf['what'] for cf in lm}))}, open map data): the special-transport permit (VEMAGS) must cover it, with a bridge check for a weight limit.")
    if area.get('tree cover in the blade swing'): m.append(f"Prune or clear about {round(area['tree cover in the blade swing'], -1):.0f} m² of tree cover in the overswing.")
    nb = sum(1 for cf in sm['conflicts'] if cf['kind'] == 'building'); nn = sum(1 for cf in sm['conflicts'] if cf['kind'] == 'building-near')
    no = sum(1 for cf in sm['conflicts'] if cf['kind'] == 'mapped-object')
    if nb: m.append(f"The blade sweeps over {nb} building footprint{'s' if nb > 1 else ''} outside the carriageway in the map data: verify on site; use the opposite lane or protect the building.")
    if nn: m.append(f"{nn} building{'s' if nn > 1 else ''} at the road edge within reach of the blade: check on site, spotter and walking pace.")
    if no: m.append(f"{no} mapped object{'s' if no > 1 else ''} inside the carriageway in the map data (likely a mapping error or a shelter): verify on site.")
    cl = round(sm['wheel_clear_min'], 1)
    if sm['wheel_out_max'] <= 0.25 and cl < 1.0 and sm.get('noshoulder') and cl > -0.25:
        edge = 'kerb and footway' if sm.get('urban') else 'soft verge'
        m.append(f"The wheel units run {'at' if cl <= 0.05 else 'within ' + format(cl, '.1f') + ' m of'} the carriageway edge on a road without hard shoulder ({edge}): the remote-steered rear dolly needs a spotter on foot.")
    if sm.get('maxTurn', 0) > 60:
        m.append(f"A {sm['maxTurn']:.0f}° turn within 40 m: walking pace, the junction closed for the passage.")
    elif sm['minR'] is not None and sm['minR'] < 80:
        m.append(f"Curve radius down to {sm['minR']:.0f} m: walking pace, the road closed for the passage.")
    if sm.get('grade', 0) > 6:
        m.append(f"Grade up to {sm['grade']:.0f} % over 200 m: a pusher tractor on standby.")
    return m


def verdict(sm, ev):
    """→ (level, reason)"""
    walls = [cf['what'] for cf in sm['conflicts'] if cf['what'] in ('guard rail', 'wall', 'retaining wall', 'jersey barrier')]
    bld = any(cf['kind'] == 'building' for cf in sm['conflicts'])
    hard, care = [], []
    if sm['wheel_out_max'] > 0.5 and sm['wheel_out_area'] >= 5: hard.append(f"wheels up to {sm['wheel_out_max']:.1f} m off the paved area")
    if walls: hard.append(walls[0] + ' in the swept path')
    if bld: hard.append('blade over a building footprint')
    if ev.get('incident') and sm['wheel_clear_min'] < 1.0: hard.append('incident on record, wheels within 1 m of the edge')
    if sm.get('maxTurn', 0) > 100: hard.append(f"{sm['maxTurn']:.0f}° turn")
    if ev.get('hard'): hard.append(ev['hard'])
    if sm['blade_out_max'] > 3: care.append(f"blade up to {sm['blade_out_max']:.0f} m beyond the road")
    objs = sorted({cf['what'] for cf in sm['conflicts'] if cf['sev'] >= 2})
    if objs: care.append(', '.join(objs[:2]) + ' in the swept area')
    if round(sm['wheel_clear_min'], 1) < 1.0 and sm.get('noshoulder') and sm['wheel_out_max'] <= 0.25: care.append(f"wheels {max(0, sm['wheel_clear_min']):.1f} m from the edge, no hard shoulder")
    if sm.get('maxTurn', 0) > 60: care.append(f"{sm['maxTurn']:.0f}° turn")
    if sm['minR'] is not None and sm['minR'] < 80: care.append(f"curve radius {sm['minR']:.0f} m")
    if sm.get('grade', 0) > 6: care.append(f"grade {sm['grade']:.0f} %")
    if any(cf['kind'] == 'mapped-object' for cf in sm['conflicts']): care.append('mapped object inside the carriageway')
    lvl = 2 if hard else 1 if care else 0
    if ev.get('cap') is not None and lvl > ev['cap']:
        seen = []; [seen.append(x) for x in hard + care if x not in seen]
        lvl = ev['cap']; return lvl, '; '.join(seen[:3]) + ' — ' + ev.get('capnote', '')
    return lvl, '; '.join(hard if lvl == 2 else care)


# ---- the road's fitted vertical alignment (route_vprof.py) along a passage's driven path
VPROF = np.load(C + 'corr/vprof.npz') if os.path.exists(C + 'corr/vprof.npz') else None
TUNNELS = json.load(open(C + 'corr/tunnels.json'))['items'] if os.path.exists(C + 'corr/tunnels.json') else []   # route_tunnels.py
_RN = None


def vprof_path(D, sm):
    """the road's height under each point of the passage's path (the fitted road at the nearest route sample, its cross
    slope over the path's offset), or None where the fit rests on the 30 m model over more than a fifth of the passage"""
    global _RN
    if VPROF is None: return None
    if _RN is None:
        from route_corridor import route
        _RN = route()['N']
    a, b = int(np.searchsorted(s_all, sm['km'][0] * 1000 - 150)), int(np.searchsorted(s_all, sm['km'][1] * 1000 + 150))
    src = VPROF['src10'][a // 10:b // 10 + 1]
    if not len(src) or np.isin(src, (1, 2, 3)).mean() < 0.8: return None
    fw = Transformer.from_crs('EPSG:32633', D['proj'], always_xy=True)
    x, y = fw.transform(Pu[a:b, 0], Pu[a:b, 1]); x1, y1 = fw.transform(Pu[a:b, 0] + _RN[a:b, 0], Pu[a:b, 1] + _RN[a:b, 1])
    Q = np.c_[x, y]; Nl = np.c_[np.asarray(x1) - x, np.asarray(y1) - y]
    _, k = cKDTree(Q).query(np.asarray(D['P'])[:, :2])
    d = ((np.asarray(D['P'])[:, :2] - Q[k]) * Nl[k]).sum(1)
    return VPROF['z1'][a + k].astype(float) + VPROF['q1'][a + k].astype(float) * d


# ---- detailed map tags (route_osm.py) against each passage's swept areas: islands, kerbs, barriers, wires, limits
OSMT = json.load(open(C + 'corr/osm_tags.json')) if os.path.exists(C + 'corr/osm_tags.json') else None
PIX = json.load(open(C + 'corr/pix_index.json')) if os.path.exists(C + 'corr/pix_index.json') else {}      # route_pix.py: street photos per passage
GROSS = float(V.get('gross', 72)) if hasattr(V, 'get') else 72.0
def line_name(q):
    if q['kind'] == 'telecom': return 'overhead telecom line'
    kv = q.get('kv')
    return (f"overhead power line {kv:g} kV" if kv else 'overhead power line' + (' (low voltage)' if q.get('line') == 'minor_line' else ''))
def line_low(q):          # lines that can hang within reach of a 4.7 m load: telecom, low and medium voltage, unknown
    return q['kind'] == 'telecom' or q.get('line') == 'minor_line' or q.get('kv') is None or q['kv'] < 60
def osm_conflicts(D, sm):
    if not OSMT: return []
    a, b = sm['km'][0] * 1000 - 40, sm['km'][1] * 1000 + 40
    tl = Transformer.from_crs('EPSG:32633', D['proj'], always_xy=True)
    zs_ = np.load(C + 'screen.npz'); Pz, sz = zs_['P'], zs_['s']
    def loc(x, y): u, v = tl.transform(x, y); return float(u), float(v)
    wheel, blade = D['wheel_sw'], D['blade_sw']
    out = []
    for q in OSMT['areas']:
        if not (a <= q['s'] <= b) or len(q['xy']) < 2: continue
        pts = [loc(*p) for p in q['xy']]
        g = Polygon(pts).buffer(0) if q['closed'] and len(pts) >= 4 else LineString(pts)
        k = q['kind']
        if k in ('traffic_island', 'island'):
            x_ = g.intersection(wheel)
            if not x_.is_empty and (x_.area > 0.3 or g.geom_type != 'Polygon'):
                c_ = x_.centroid; out.append(dict(kind='osm', what='traffic island in the wheel path', sev=2, area=round(x_.area, 1), at=[round(c_.x, 1), round(c_.y, 1)]))
        elif k == 'kerb':
            if q.get('kerb') in ('lowered', 'flush', 'no'): continue
            x_ = g.intersection(wheel)
            if not x_.is_empty and x_.length > 1:
                c_ = x_.centroid; out.append(dict(kind='osm', what='raised kerb in the wheel path', sev=1, length=round(x_.length, 1), at=[round(c_.x, 1), round(c_.y, 1)]))
        elif k in ('bollard', 'gate', 'height_restrictor', 'jersey_barrier'):
            x_ = g.intersection(wheel)
            if not x_.is_empty:
                c_ = x_.centroid; out.append(dict(kind='osm', what={'bollard': 'bollards in the wheel path', 'gate': 'gate in the wheel path', 'height_restrictor': 'height restrictor', 'jersey_barrier': 'concrete barrier in the wheel path'}[k], sev=2, at=[round(c_.x, 1), round(c_.y, 1)]))
    for q in OSMT['points']:
        if not (a <= q['s'] <= b) or 'x' not in q: continue
        t = q['tags']
        pt = Point(loc(q['x'], q['y']))
        inw = wheel.distance(pt) < 1.0
        what, sev = None, 0
        if t.get('crossing:island') == 'yes' and inw: what, sev = 'pedestrian island in the wheel path', 2
        elif t.get('traffic_calming') in ('island', 'choker', 'chicane') and inw: what, sev = 'traffic-calming island / choker in the wheel path', 2
        elif t.get('traffic_calming') in ('table', 'hump', 'bump', 'cushion', 'rumble_strip') and inw: what, sev = 'speed hump / table on the route', 1
        elif t.get('barrier') in ('bollard', 'gate', 'lift_gate', 'block', 'cycle_barrier', 'swing_gate') and inw: what, sev = f"{t['barrier'].replace('_', ' ')} in the wheel path", 2
        elif t.get('barrier') == 'height_restrictor': what, sev = 'height restrictor', 2
        if what: out.append(dict(kind='osm', what=what, sev=sev, at=[round(pt.x, 1), round(pt.y, 1)]))
    for q in OSMT['lines']:
        if not (a <= q['s'] <= b) or not q.get('crosses') or 'x' not in q: continue
        pt = Point(loc(q['x'], q['y']))
        out.append(dict(kind='osm', what=line_name(q) + ' over the route', sev=1 if line_low(q) else 0, at=[round(pt.x, 1), round(pt.y, 1)],
                        operator=q.get('operator'), low=line_low(q)))
    for q in OSMT['limits']:
        if q['s1'] < a or q['s0'] > b: continue
        i = int(np.clip(np.searchsorted(sz, (max(a, q['s0']) + min(b, q['s1'])) / 2), 0, len(sz) - 1)); pt = Point(loc(*Pz[i]))
        w = q.get('maxweight') or q.get('maxweightrating')
        if w and w < GROSS: out.append(dict(kind='osm', what=f'weight limit {w:g} t', sev=2, at=[round(pt.x, 1), round(pt.y, 1)]))
        if q.get('maxwidth') and q['maxwidth'] < 4.6: out.append(dict(kind='osm', what=f"width limit {q['maxwidth']:g} m", sev=2, at=[round(pt.x, 1), round(pt.y, 1)]))
        if q.get('maxlength') and q['maxlength'] < 96: out.append(dict(kind='osm', what=f"length limit {q['maxlength']:g} m", sev=2, at=[round(pt.x, 1), round(pt.y, 1)]))
        if q.get('hgv') in ('no',): out.append(dict(kind='osm', what='closed to lorries (hgv=no)', sev=2, at=[round(pt.x, 1), round(pt.y, 1)]))
    # the same object already found in the map's objects (a barrier, a bollard): keep that one
    have = [cf for cf in sm['conflicts'] if cf.get('kind') != 'osm' and cf.get('at')]
    def dup(c):
        base = c['what'].replace(' in the wheel path', '').replace('s in', ' in').rstrip('s')
        return any(math.hypot(c['at'][0] - h_['at'][0], c['at'][1] - h_['at'][1]) < 8 and base.split(' ')[0] in h_['what'] for h_ in have)
    return [c for c in out if not dup(c)]


for h in HOT:
    hid = h[0]
    D = pickle.load(open(C + 'hot/' + hid + '.pkl', 'rb'))
    sm = D['summary']
    sm['conflicts'] = [cf for cf in sm['conflicts'] if cf.get('kind') != 'osm'] + osm_conflicts(D, sm)
    # wheels / blade beyond the paved area, measured on the mapped road surfaces (incl. kerb fillets): depth and area agree
    def depth_area(g, paved):
        g = g.buffer(0) if not g.is_empty else g
        if g.is_empty: return 0.0, 0.0
        pts = [Point(c) for p_ in getattr(g, 'geoms', [g]) if p_.geom_type == 'Polygon' for c in p_.exterior.coords]
        return (max(paved.distance(q) for q in pts) if pts else 0.0), g.area
    # the route's own carriageway as the model drives it (smoothed centreline ± usable half-width) joins the mapped roads
    Pp_, HW_ = (D['Pc'] if D.get('Pc') is not None else D['P']), D['HW']     # the carriageway's middle and half-width
    pieces, a_ = [], 0
    for b_ in range(1, len(Pp_) + 1):
        if b_ == len(Pp_) or abs(HW_[b_] - HW_[a_]) > 0.05:
            if b_ - a_ > 1: pieces.append(LineString(Pp_[a_:b_ + (1 if b_ < len(Pp_) else 0)]).buffer(float(HW_[a_]), cap_style=2))
            a_ = b_
    D['paved'] = unary_union([D['paved']] + pieces)
    D['blade_out'] = D['blade_sw'].difference(D['paved'].buffer(0.3))
    wo = D['wheel_sw'].difference(D['paved'].buffer(0.3))
    wo = unary_union([p_ for p_ in getattr(wo, 'geoms', [wo]) if p_.geom_type == 'Polygon' and p_.area > 0.5]) if not wo.is_empty else wo
    sm['wheel_out_max'], sm['wheel_out_area'] = depth_area(wo, D['paved'])
    D['wheel_out'] = wo
    sm['blade_out_max'], sm['blade_out_area'] = depth_area(D['blade_out'], D['paved'])
    # the blade beyond the edge by the page's model (route_blade.mjs): the convoy of the page's vehicle driving the passage
    # along the convoy's line, the blade as drawn at every place it takes, measured against the carriageway's measured edges
    # and the paved surface traced on the photo; the drive view shows the same (section h_<id>_blade). Its area replaces the
    # one above (the blade's outline every 2 m against the mapped roads), and the trees in the blade's swing follow it
    BE = (BLADE or {}).get('hot', {}).get(hid)
    if BE is not None:
        _tf = Transformer.from_crs('EPSG:32633', D['proj'], always_xy=True)
        _q = []
        for c_ in BE['cells']:
            _x, _y = _tf.transform(c_[0::2], c_[1::2]); _q.append(Polygon(list(zip(_x, _y))).buffer(0))
        D['blade_out'] = unary_union(_q).buffer(0) if _q else Polygon()
        sm['blade_out_max'], sm['blade_out_area'] = float(BE['max']), float(BE['area'])
        if sm.get('lane'): sm['lane']['kr_blade_out_max'] = float(BE['kr']['max'])
        from shapely.prepared import prep
        _hd = D.get('hd') or {}
        _tpts, _tarea = [], 0.0
        if _hd.get('trees') is not None:
            if not D['blade_out'].is_empty:
                _bo = prep(D['blade_out'])
                for x_, y_, h_, r_ in _hd['trees']:
                    _cr = Point(x_, y_).buffer(float(r_), 8)
                    if _bo.intersects(_cr): _tarea += _cr.intersection(D['blade_out']).area; _tpts.append((x_, y_))
            _tc = [dict(kind='trees', what=f'trees in the blade swing ({len(_tpts)} surveyed crowns)', area=round(_tarea), sev=2)] if _tpts else []
        elif D.get('wc') is not None:
            _bb, _r10 = D['bb'], 1 / 12000; _fw = Transformer.from_crs('EPSG:4326', D['proj'], always_xy=True); _bo = prep(D['blade_out'])
            for r_ in range(D['wc'].shape[1]):
                _cols = np.nonzero(D['wc'][0, r_] == 10)[0]
                if not len(_cols): continue
                _X, _Y = _fw.transform(_bb[0] + (_cols + 0.5) * _r10, np.full(len(_cols), _bb[3] - (r_ + 0.5) * _r10))
                for xx, yy in zip(_X, _Y):
                    if _bo.contains(Point(xx, yy)): _tarea += 100.0; _tpts.append((xx, yy))
            _tc = [dict(kind='trees', what='tree cover in the blade swing', area=round(_tarea), sev=2)] if _tarea else []
        else: _tc = []
        # (in the old one's place; without one, where route_hotspots.py puts it: after its own findings, before the map's)
        _cs = sm['conflicts']; _i = next((i for i, cf in enumerate(_cs) if cf.get('kind') == 'trees'), next((i for i, cf in enumerate(_cs) if cf.get('kind') == 'osm'), len(_cs)))
        sm['conflicts'] = [cf for cf in _cs[:_i] if cf.get('kind') != 'trees'] + _tc + [cf for cf in _cs[_i:] if cf.get('kind') != 'trees']
        D['tree_pts'] = _tpts
    if sm['wheel_out_area'] < 0.5:
        # (not over the path's first and last 15 m: the paved area is cut off at the passage's ends — flat caps, so the band
        # does not reach back over them)
        Pm = np.asarray(D['P'])[:, :2]; ws = D['wheel_sw'].intersection(LineString(Pm[15:-15]).buffer(30, cap_style=2)) if len(Pm) > 40 else D['wheel_sw']
        sm['wheel_clear_min'] = float((ws if not ws.is_empty else D['wheel_sw']).distance(D['paved'].boundary))
    else:
        sm['wheel_clear_min'] = -sm['wheel_out_max']
    nbld = sum(1 for b_ in D['bld'] if LineString(D['P']).distance(b_['poly']) < 25)
    sm['urban'] = nbld >= 8
    ext = D['ext']; proj = D['proj']
    fw = Transformer.from_crs('EPSG:4326', proj, always_xy=True); bw = Transformer.from_crs(proj, 'EPSG:4326', always_xy=True)
    bb = D['bb']
    pre = f'h_{hid}_'
    # ---- ground grid (10 m) on the local frame
    gstep = 20.0
    gx0, gy0 = math.floor(ext[0] / gstep) * gstep, math.floor(ext[1] / gstep) * gstep
    gnx, gny = int(math.ceil((ext[2] - gx0) / gstep)) + 1, int(math.ceil((ext[3] - gy0) / gstep)) + 1
    GX, GY = np.meshgrid(gx0 + np.arange(gnx) * gstep, gy0 + np.arange(gny) * gstep)
    glon, glat = bw.transform(GX, GY)
    G = D['ground']
    rr = (bb[3] - glat) * 3600 - 0.5; cc = (glon - bb[0]) * 3600 - 0.5
    Z = map_coordinates(G, [rr, cc], order=3, mode='nearest')
    zb = float(np.floor(Z.min()))
    add(pre + 'ground', enc_grid(Z, 0.2, zb), nx=gnx, ny=gny, x0=gx0, y0=gy0, step=gstep, base=zb, q=0.2)
    # grade along the path: terrain-model profile where the road runs in the open; under closed canopy the profile is
    # bridged linearly between open samples (and the surveyed pad heights), then smoothed over ~50 m
    plon, plat = bw.transform(D['P'][:, 0], D['P'][:, 1])
    prc = [(bb[3] - plat) * 3600 - 0.5, (plon - bb[0]) * 3600 - 0.5]
    zp = map_coordinates(G, prc, order=1, mode='nearest')
    ok = np.ones(len(zp), bool)
    if D.get('treefrac') is not None:
        ok = map_coordinates(D['treefrac'], prc, order=1, mode='nearest') < 0.35
        for t in TURB:
            if bb[0] < t['lon'] < bb[2] and bb[1] < t['lat'] < bb[3]:
                tx, ty = fw.transform(t['lon'], t['lat'])
                near = np.hypot(D['P'][:, 0] - tx, D['P'][:, 1] - ty) < 60
                ok |= near
                zp[near] = t['ground']
        if ok.sum() >= 2:
            ii = np.arange(len(zp)); zp = np.interp(ii, ii[ok], zp[ok])
    zp = gaussian_filter(zp, 25)
    # survey points with official laser terrain (DGM1 / NMT, ±15 cm): the gradient from it along the driven path
    if D.get('hd'):
        try:
            import hd_hot
            zl = hd_hot.sample_dgm(hd_hot.region(hid), proj, D['P'][:, 0], D['P'][:, 1])
            if zl is not None and np.isfinite(zl).mean() > 0.95:
                zp = gaussian_filter(np.where(np.isfinite(zl), zl, np.nanmean(zl)), 8)
                sm['grade_src'] = 'DGM1'
        except Exception as ex:
            print('  laser grade not used', ex)
    # better still the fitted road (route_vprof.py: the laser terrain along the road with covers, decks and tunnels taken
    # out — a tunnel a grade between its portals, not its lid)
    zv = vprof_path(D, sm)
    if zv is not None: zp = gaussian_filter(zv, 8); sm['grade_src'] = 'DGM1'
    sm['grade'] = float(np.max(np.abs(zp[200:] - zp[:-200])) / 200 * 100) if len(zp) > 220 else 0.0
    # ---- Sentinel-2 texture, ≤ 640 px on the long side
    span = max(ext[2] - ext[0], ext[3] - ext[1])
    px = max(4.0, span / 640)
    TW, TH = int(math.ceil((ext[2] - ext[0]) / px)), int(math.ceil((ext[3] - ext[1]) / px))
    tx, ty = np.meshgrid(ext[0] + (np.arange(TW) + 0.5) * px, ext[3] - (np.arange(TH) + 0.5) * px)
    tlon, tlat = bw.transform(tx, ty)
    res10 = 1 / 12000
    r2 = (bb[3] - tlat) / res10 - 0.5; c2 = (tlon - bb[0]) / res10 - 0.5
    S2 = D['s2'].astype(np.float32)
    rgb = np.stack([tone(map_coordinates(S2[b], [r2, c2], order=1, mode='nearest')) for b in range(3)], -1)
    lum = rgb @ np.array([0.2126, 0.7152, 0.0722]); rgb = np.clip(lum[..., None] + (rgb - lum[..., None]) * 1.12, 0, 1)
    buf = io.BytesIO(); Image.fromarray((rgb * 255).astype(np.uint8)).save(buf, 'WEBP', quality=78, method=6)
    images['h_' + hid] = buf.getvalue()
    # ---- roads (all segments incl. paths), dm
    Lrd = Layer(pre + 'roads', ['cls', 'hw', 'flags'], 5.0)
    clip = box(*ext).buffer(60)
    for r in D['roads']:
        if len(r['xy']) < 2: continue
        cls = 'rail' if r['sub_t'] == 'rail' else r['cls'] if r['cls'] in CODES_ROAD else 'unknown'
        if cls in ('footway', 'cycleway', 'path', 'steps', 'pedestrian'): continue
        full = LineString(r['xy'])
        if full.length < 0.5 or not full.intersects(clip): continue
        base = road_attrs(r['xy'], D['proj'], cls) if cls != 'rail' else 0          # one-way 8, unpaved 16 (roads.pkl, near the route)
        hw = half_width(r['cls'], r['sub']) if r['sub_t'] == 'road' and r['cls'] in CODES_ROAD and CODES_ROAD[r['cls']] < 10 else (0.9 if cls != 'rail' else 0.75)
        # bridge (1), tunnel (2) and raised (4) where the way's flags and level rules hold: Overture gives them for a part of the
        # way ('between' fractions along it) — a way flagged over its whole length took a 2 m bridge somewhere along it for
        # all of it (the road under a deck counted as on the deck: no asphalt under the bridges over the passage)
        rules = [(f.get('between'), (1 if 'is_bridge' in (f.get('values') or []) else 0) | (2 if 'is_tunnel' in (f.get('values') or []) else 0)) for f in (r['flags'] or [])]
        rules += [(lr.get('between'), 4 if (lr.get('value') or 0) > 0 else 0) for lr in (r['level'] or [])]
        cuts = sorted({0.0, 1.0} | {min(1.0, max(0.0, float(v))) for b_, fl_ in rules if fl_ and b_ for v in b_})
        for a_, b_ in zip(cuts[:-1], cuts[1:]):
            if b_ - a_ < 1e-6: continue
            m_ = (a_ + b_) / 2
            flags = base
            for bt, fl_ in rules:
                if fl_ and (not bt or bt[0] <= m_ <= bt[1]): flags |= fl_
            piece = full if (a_, b_) == (0.0, 1.0) else substring(full, a_, b_, normalized=True)
            g = piece.intersection(clip)
            if g.is_empty: continue
            for ring in rings_of(g.simplify(0.4)):
                if len(ring) > 1: Lrd.add([CODES_ROAD[cls], int(round(hw * 10)), flags], [ring])
    Lrd.finish()
    # ---- buildings
    Lbd = Layer(pre + 'bld', ['h', 'roof'], 2.0)
    near_b = LineString(D['P']).buffer(330)
    for b in D['bld']:
        if not near_b.intersects(b['poly']): continue
        for p in getattr(b['poly'].simplify(0.5), 'geoms', [b['poly'].simplify(0.5)]):
            if p.geom_type != 'Polygon' or p.is_empty or p.area < 6: continue
            roof = {'flat': 0, 'gabled': 1, 'hipped': 2}.get(b['roof'] or '', 1 if p.area < 450 else 0)
            Lbd.add([int(round(min(b['h'], 60) * 10)), roof], [list(p.exterior.coords)[:-1]])
    Lbd.finish()
    # ---- trees: WorldCover tree cover on a 10 m grid within 320 m of the path (1 bit per cell; the page plants them)
    path_line = LineString(D['P'])
    near = path_line.buffer(320)
    tstep = 10.0
    tx0, ty0 = math.floor(ext[0] / tstep) * tstep, math.floor(ext[1] / tstep) * tstep
    tnx, tny = int(math.ceil((ext[2] - tx0) / tstep)), int(math.ceil((ext[3] - ty0) / tstep))
    CX, CY = np.meshgrid(tx0 + (np.arange(tnx) + 0.5) * tstep, ty0 + (np.arange(tny) + 0.5) * tstep)
    clon, clat = bw.transform(CX, CY)
    wc = D['wc'][0]
    wr = np.clip(((bb[3] - clat) / res10).astype(int), 0, wc.shape[0] - 1); wcc = np.clip(((clon - bb[0]) / res10).astype(int), 0, wc.shape[1] - 1)
    tree = wc[wr, wcc] == 10
    from shapely import contains_xy
    inside = contains_xy(near, CX, CY)
    tree &= inside
    add(pre + 'trees', np.packbits(tree.ravel(), bitorder='little').tobytes(), nx=tnx, ny=tny, x0=tx0, y0=ty0, step=tstep)
    pts = [None] * int(tree.sum())
    # ---- objects (points) and barriers (lines)
    Lo = Layer(pre + 'obj', ['code'], 10.0); Lba = Layer(pre + 'bar', ['code'], 10.0)
    for o in D['infra']:
        g = o['g']
        if not clip.intersects(g): continue
        if g.geom_type == 'Point':
            code = CODES_OBJ.get(o['cls'])
            if code is None: continue
            Lo.add([code], [[(g.x, g.y)]])
        elif g.geom_type in ('LineString', 'MultiLineString') and o['sub'] == 'barrier':
            code = CODES_BAR.get(o['cls'], CODES_BAR['other'])
            for ring in rings_of(g.intersection(clip).simplify(0.3)):
                if len(ring) > 1: Lba.add([code], [ring])
    Lo.finish(); Lba.finish()
    # ---- water areas
    Lw = Layer(pre + 'water', [], 10.0)
    for l in D['lu']:
        if l['t'] != 'water' or l['g'].geom_type not in ('Polygon', 'MultiPolygon'): continue
        g = l['g'].intersection(clip).simplify(0.8)
        for p in getattr(g, 'geoms', [g]):
            if p.geom_type == 'Polygon' and p.area > 30: Lw.add([], [list(p.exterior.coords)[:-1]])
    Lw.finish()
    # ---- path (2 m) and poses (every 2 m: front axle, rear axle, front support, blade root, blade tip, dolly centre, dolly front)
    Pp = D['P'][::2]
    Lp = Layer(pre + 'path', [], 10.0); Lp.add([], [list(map(tuple, Pp))]); Lp.finish()
    poses = D['poses'][::2]                       # every 4 m (the page interpolates)
    w = Writer(); p1_ = np.zeros(14, np.int64); p2_ = np.zeros(14, np.int64)
    for row in poses:
        q = np.round(row * 10).astype(np.int64)
        pred = 2 * p1_ - p2_
        for k in range(14): w.svar(q[k] - pred[k])
        p2_, p1_ = p1_, q
    add(pre + 'poses', w.b, n=len(poses), q=10.0, step=4.0)
    # ---- swept areas (kind: 0 wheels, 1 blade, 2 wheels off the road, 3 blade beyond the road, 4 wheels in the oncoming
    # lane (escort holds traffic), 5 where keeping right would put the wheels off the road)
    Ls = Layer(pre + 'swept', ['kind'], 4.0)
    LG = D.get('lane_g') or {}
    from shapely.geometry import GeometryCollection
    k5 = LG['kr_wheel_out'].difference(D['wheel_out'].buffer(0.2)) if LG.get('kr_wheel_out') is not None and not LG['kr_wheel_out'].is_empty else GeometryCollection()
    for kind, g in enumerate((D['wheel_sw'], D['blade_sw'], D['wheel_out'], D['blade_out'], LG.get('onc') if LG.get('onc') is not None else GeometryCollection(), k5)):
        if kind == 3 and BE is not None: continue                      # (the blade beyond the edge by route_blade.mjs: its own layer, below)
        if kind in (1, 3) and not g.is_empty: g = g.buffer(1.5, join_style=1).buffer(-1.5, join_style=1)   # close the comb of sampled blade positions
        g = g.simplify(0.5)
        for p in getattr(g, 'geoms', [g]):
            if p.geom_type != 'Polygon' or p.area < 0.5: continue
            Ls.add([kind], [list(p.exterior.coords)[:-1]] + [list(r.coords)[:-1] for r in p.interiors if Polygon(r).area > 0.5])
    Ls.finish()
    if BE is not None:
        # the blade beyond the edge (route_blade.mjs: swept continuously, no comb to close), in 5 cm: the area the drive view
        # draws, painted in the passage view as the swept layer's kind 3 was
        Lb = Layer(pre + 'bout', [], 20.0); g = D['blade_out'].simplify(0.05)
        for p in getattr(g, 'geoms', [g]):
            if p.geom_type != 'Polygon' or p.area < 0.01: continue
            Lb.add([], [list(p.exterior.coords)[:-1]] + [list(r.coords)[:-1] for r in p.interiors if Polygon(r).area > 0.01])
        Lb.finish()
    if BE is not None:
        # (varint stream: the stretches beyond and the paved surface as rows, one per normal [place along the line in 1/16 m
        # from the window's start (delta), count, then per interval its start and length in cm (the paved surface in 5 cm),
        # each as the difference from
        # the row before's interval of that rank]; between them the depth per front-axle metre ia … ib where not 0 [count;
        # metre (gap since the last), cm])
        def rows_(R, q_=1):
            w.var(len(R)); pu, pv_ = 0, []
            for row_ in R:
                u_, iv = row_[0], [(round(row_[j_] / q_), round(row_[j_ + 1] / q_) - round(row_[j_] / q_)) for j_ in range(1, len(row_), 2)]
                w.var(u_ - pu); pu = u_; w.var(len(iv))
                for j_, (a_, l_) in enumerate(iv):
                    pa, pl = pv_[j_] if j_ < len(pv_) else (0, 0)
                    w.svar(a_ - pa); w.svar(l_ - pl)
                pv_ = iv
        w = Writer()
        _rr = {}
        for u_, d0_, d1_ in BE['runs']: _rr.setdefault(u_, []).extend([d0_, d1_])
        rows_([[u_] + v_ for u_, v_ in sorted(_rr.items())])
        _nz = [(i_, d_) for i_, d_ in enumerate(BE['depth']) if d_]
        w.var(len(_nz)); _pi = -1
        for i_, d_ in _nz: w.var(i_ - _pi - 1); _pi = i_; w.var(d_)
        rows_(BE['paved'], 5)                                          # (the paved surface in 5 cm)
        add(pre + 'blade', w.b, sa=BE['sa'], n=BE['n'], ia=BE['ia'], ib=BE['ib'], sub=BLADE['sub'], nr=len(BE['runs']), npv=len(BE['paved']), pq=0.05)
    # ---- summary for the page
    lon0, lat0 = sm['lon'], sm['lat']
    hx, hy = mfw.transform(lon0, lat0)
    # affine local frame → map frame (least squares over the hot spot ± 30 km; exact to a few metres)
    gg = np.array([(xx, yy) for xx in (-30000, 0, 30000) for yy in (-30000, 0, 30000)], float)
    glo, gla = bw.transform(gg[:, 0], gg[:, 1]); gmx, gmy = mfw.transform(glo, gla)
    A_ = np.c_[gg, np.ones(len(gg))]
    ax_ = np.linalg.lstsq(A_, gmx, rcond=None)[0]; ay_ = np.linalg.lstsq(A_, gmy, rcond=None)[0]
    ev = EVIDENCE.get(hid, {})
    # more than 180° within 40 m is a small loop of the routed line at a junction node (it overshoots the node and hooks
    # back), not a manoeuvre: the turn is the same one the other way round
    if sm.get('maxTurn', 0) > 180: sm['maxTurn'] = 360 - sm['maxTurn']
    for cf in sm['conflicts']: cf['what'] = {'give way': 'give-way sign', 'stop': 'stop sign', 'information': 'information sign'}.get(cf['what'], cf['what'])
    # a 'bridge over the route' where the clear-height survey finds the route itself on a bridge, or nothing above the
    # road, is no overpass
    _Pl = np.asarray(D['P'])[:, :2]; _cum = np.r_[0, np.cumsum(np.hypot(*np.diff(_Pl, axis=0).T))]
    def _over_ok(cf):
        if cf.get('kind') != 'overpass' or not cf.get('at'): return True
        sc = sm['km'][0] * 1000 + float(_cum[int(np.argmin(np.hypot(_Pl[:, 0] - cf['at'][0], _Pl[:, 1] - cf['at'][1])))])
        rs = sorted(overs_in(sc - 60, sc + 60), key=lambda r: abs(r['s'] - sc))
        return not rs or not (rs[0].get('note') or '').startswith(('the route crosses', 'nothing above the road', 'carried on the lid'))
    _n0 = len(sm['conflicts']); sm['conflicts'] = [cf for cf in sm['conflicts'] if _over_ok(cf)]
    if len(sm['conflicts']) < _n0: print('  ', hid, _n0 - len(sm['conflicts']), 'overpass finding(s) dropped (route on its own bridge / nothing above the road / on a tunnel lid)')
    # a tunnel, covered section or wildlife overpass on the passage (route_tunnels.py): the structure over the route there is
    # its tube, whose clear height needs confirming (a crossing standing on its lid is not over the convoy)
    _tl = Transformer.from_crs('EPSG:32633', D['proj'], always_xy=True)
    for t in TUNNELS:
        if t['kind'] == 'underbridge' or t['s1'] < sm['km'][0] * 1000 or t['s0'] > sm['km'][1] * 1000: continue
        i_ = int(np.clip(np.searchsorted(s_all, max(t['s0'], sm['km'][0] * 1000)), 0, len(s_all) - 1)); x_, y_ = _tl.transform(*Pu[i_])
        sm['conflicts'].append(dict(kind='tunnel', what='wildlife overpass over the route' if t['kind'] == 'overpass' else 'covered section over the route' if (t.get('est') is not None) else 'tunnel',
                                    sev=2, at=[round(float(x_), 1), round(float(y_), 1)]))
    HOTWIN.append((sm['km'][0], sm['km'][1]))
    sm['noshoulder'] = any(Ru[SEG[i_]][0]['cls'] in ('primary', 'secondary', 'tertiary', 'unclassified', 'track') for i_ in range(int(np.searchsorted(s_all, sm['km'][0] * 1000)), int(np.searchsorted(s_all, sm['km'][1] * 1000)), 50))
    v, why = verdict(sm, ev)
    conf = []
    for cf in sm['conflicts']:
        c2 = {k: cf[k] for k in ('kind', 'what', 'sev') if k in cf}
        c2['what'] = {'give way': 'give-way sign', 'stop': 'stop sign', 'information': 'information sign'}.get(c2['what'], c2['what'])
        for k in ('length', 'area', 'd'):
            if k in cf: c2[k] = cf[k]
        if cf.get('at'): c2['at'] = [round(cf['at'][0], 1), round(cf['at'][1], 1)]
        if cf.get('at'): c2['s'] = round(sm['km'][0] * 1000 + float(_cum[int(np.argmin(np.hypot(_Pl[:, 0] - cf['at'][0], _Pl[:, 1] - cf['at'][1])))]))   # route chainage, for the road view
        conf.append(c2)
    rrow = Ru[SEG[int(np.searchsorted(s_all, sm['km'][0] * 1000))]][0]
    hot_meta.append(dict(id=hid, title=h[1], km=sm['km'], role='start' if h is HOT[0] else 'end' if h is HOT[-1] else None, lon=round(lon0, 6), lat=round(lat0, 6), x=round(hx), y=round(hy), sev=v,
                         toMap=[round(float(q), 7) for q in (*ax_, *ay_)],
                         ext=[round(e, 1) for e in ext],
                         minR=None if sm['minR'] is None else round(sm['minR']), wheelOut=round(sm['wheel_out_max'], 2), wheelArea=round(sm['wheel_out_area']),
                         bladeOut=round(sm['blade_out_max'], 1), bladeArea=round(sm['blade_out_area']), wheelClear=round(sm['wheel_clear_min'], 2),
                         conflicts=conf, measures=measures(sm, D, ev.get('measures', [])), maxTurn=round(sm.get('maxTurn', 0)), why=why, grade=round(sm.get('grade', 0), 1), gradeSrc=sm.get('grade_src', 'GLO-30'), evidence=ev.get('evidence', []), note=ev.get('note'), incident=ev.get('incident'),
                         road=ev.get('road'), view=ev.get('view'), trees=len(pts), pix=PIX.get(hid) or None,
                         lane=(None if not sm.get('lane') or sm['lane']['used_m'] < 8 else dict(m=sm['lane']['used_m'], across=round(sm['lane']['across_max'], 1),
                               krOut=round(sm['lane']['kr_wheel_out_max'], 2), krClear=round(sm['lane']['kr_wheel_clear_min'], 2), krBlade=round(sm['lane']['kr_blade_out_max'], 1),
                               krAcross=round(sm['lane']['kr_across_max'], 1), kind=sm['lane'].get('kind', 'oncoming')))))
    print(f"  {hid:14s} sev {v}  ground {gnx}×{gny}  tex {TW}×{TH} {len(images['h_' + hid]) // 1024} KB  trees {len(pts)}")
    # make sure the verdict shows on the route line at the worst point
    worst = int(np.argmax(np.nan_to_num(np.maximum(z['bL'], z['bR']))[int(sm['km'][0] * 1000):int(sm['km'][1] * 1000) + 1])) + int(sm['km'][0] * 1000) if sm['km'][1] > sm['km'][0] else int(sm['km'][0] * 1000)
    sev[min(nb - 1, worst // BIN)] = max(sev[min(nb - 1, worst // BIN)], v)
add('routeSev', bytes(sev), n=nb, bin=BIN)
for i_ in range(len(nights) - 1):
    e = nights[i_]['b']
    for a_, b_ in HOTWIN:
        if a_ - 1 < e < b_ + 1: e = round(a_ - 1.5, 1)
    nights[i_]['b'] = e; nights[i_ + 1]['a'] = e
print('  nights', nights)

# ================================================================================================= write
blob = bytearray(); S = {}
for k, (b, m) in sections.items():
    S[k] = dict(off=len(blob), len=len(b), **m); blob += b
comp = zlib.compress(bytes(blob), 9)[2:-4]
open(OUT + 'route.bin', 'wb').write(comp)
_im = Image.open(C + 'map_rgb.png'); _b = io.BytesIO()
_im.resize((1100, round(_im.height * 1100 / _im.width)), Image.LANCZOS).save(_b, 'WEBP', quality=62, method=6)
images['map'] = _b.getvalue()
_im = Image.open(C + 'map_outer.png'); _b = io.BytesIO(); _im.resize((570, 675), Image.LANCZOS).save(_b, 'WEBP', quality=62, method=6); images['outer'] = _b.getvalue()
for k, v in images.items(): open(OUT + k + '.webp', 'wb').write(v)
for f in glob.glob(OUT + 'h_*.webp'):                           # (the pictures of passages this route no longer has)
    if os.path.basename(f)[:-5] not in images: os.remove(f)
# ---- every structure over the route with its clear height (signed / measured), for the whole-route list
def clear_list():
    if not glob.glob(OUTC + 'clear*.json'): return []
    import route_pack as RP                      # same records as the road packs
    over = sorted([o for b in pickle.load(open(OUTC + 'objects.pkl', 'rb'))['blocks'].values() for o in b['over']], key=lambda o: o['s'])
    recs = RP.overs(over, 0, 1e9, 0.0, 0.0)
    out = []
    zs = np.load(C + 'screen.npz'); Ps = zs['P']; ss = zs['s']
    for r in recs:
        i = int(np.clip(np.searchsorted(ss, r['s']), 0, len(ss) - 1))
        lo, la = utm.transform(Ps[i, 0], Ps[i, 1]); mx, my = mfw.transform(lo, la)
        q = {k: r[k] for k in ('s', 'kind', 'sub', 'cls', 'name', 'top', 'est', 'unc', 'signed', 'len', 'src', 'note', 'check', 'nm',
                               's1', 'std', 'H', 'lidtop', 'phys') if k in r and r[k] is not None}
        q['x'] = round(mx); q['y'] = round(my)
        out.append(q)
    return out


OUTC = C + 'corr/'
CLEAR = clear_list()
print('structures over the route', len(CLEAR), 'measured', sum(1 for c in CLEAR if 'est' in c))
# the road under the convoy: [km, ref, name] where it changes (every 25 m checked; blips under 150 m dropped)
def road_refs():
    out = []; step = max(1, int(round(25 / max(1e-6, float(np.median(np.diff(s_all)))))))
    for i in range(0, len(s_all), step):
        rec = Ru[SEG[i]][0]; nm = rec.get('name') or ''
        ref = ' / '.join(sorted([x.strip() for x in (rec.get('ref') or '').split(';') if x.strip()], key=lambda x: (x.startswith('E '), x[:1].isdigit(), x)))      # lettered national refs first, bare numbers, E-roads last
        if out and out[-1][1] == ref and (ref or out[-1][2] == nm): continue
        out.append([round(float(s_all[i]) / 1000, 3), ref, nm])
    clean = []
    for k, r_ in enumerate(out):
        nxt = out[k + 1][0] if k + 1 < len(out) else 1e9
        if nxt - r_[0] < 0.15 and clean: continue
        if clean and clean[-1][1] == r_[1] and clean[-1][2] == r_[2]: continue
        clean.append(r_)
    return clean
ROADREFS = road_refs(); print('road ref changes', len(ROADREFS))
import re as _re
def _mxy(x, y):
    lo, la = utm.transform(x, y); mx, my = mfw.transform(lo, la); return round(mx), round(my)
def roadworks_hdr():
    fn = C + 'corr/roadworks.json'
    if not os.path.exists(fn): return None
    d = json.load(open(fn)); out = []
    for q in d['items']:
        night = any(('bis zum' in w) or _re.search(r'von (1[89]|2\d):', w) for w in q['windows'])
        if not night and not q['start'] and q['kind'] != 'closure': continue       # day works only: outside the convoys' night window
        lx, ly = mfw.transform(q['lon'], q['lat'])
        out.append({k: v for k, v in dict(a=q['s0'], b=q['s1'], k=q['kind'][0], t=q['title'], w=q['width'], v=q['speed'], st=q['start'], en=q['end'], un=q['until'],
                                           win=q['windows'][:3], n=True if night else None, x=round(lx), y=round(ly)).items() if v not in (None, [], '')})
    return dict(date=d['date'], src=d['source'], items=out, day=len(d['items']) - len(out))
def osm_hdr():
    if not OSMT: return None
    lines = []
    for q in OSMT['lines']:
        if not q.get('crosses') or 'x' not in q: continue
        mx, my = _mxy(q['x'], q['y'])
        lines.append({k: v for k, v in dict(s=round(q['s']), k=q['kind'][0], kv=q.get('kv'), mn=True if q.get('line') == 'minor_line' else None, op=q.get('operator'),
                                             nm=q.get('name'), low=True if line_low(q) else None, x=mx, y=my).items() if v is not None})
    lim = []
    for q in OSMT['limits']:
        w = q.get('maxweight') or q.get('maxweightrating'); h_ = q.get('maxheight') or q.get('maxheight_physical')
        rec = dict(a=round(q['s0']), b=round(q['s1']), w=w if w and w < GROSS else None, wd=q.get('maxwidth') if q.get('maxwidth') and q['maxwidth'] < 4.6 else None,
                   ln=q.get('maxlength') if q.get('maxlength') and q['maxlength'] < 96 else None, h=h_, hgv=q.get('hgv') if q.get('hgv') == 'no' else None, ref=q.get('ref') or q.get('name'))
        if any(rec[k] for k in ('w', 'wd', 'ln', 'h', 'hgv')): lim.append({k: v for k, v in rec.items() if v is not None})
    return dict(date=OSMT['date'], lines=lines, lim=lim)
# ---- for "Sources and method": the states along the route, the data's dates, what each state serves, the tunnels
REGL = pickle.load(open(C + 'corr/regions.pkl', 'rb')) if os.path.exists(C + 'corr/regions.pkl') else None
def regions_hdr():
    """[[state code, km from, km to], …] in route order (per 500 m chunk, regions.pkl; Berlin counted as Brandenburg)"""
    if REGL is None: return None
    st = REGL.get('step', 500.0); out = []
    for c, lab in enumerate(REGL['lab']):
        lab = 'DE-BB' if lab == 'DE-BE' else lab; a = c * st / 1000
        if out and out[-1][0] == lab: out[-1][2] = round(min(total_km, a + st / 1000), 1)
        else: out.append([lab, round(a, 1), round(min(total_km, a + st / 1000), 1)])
    out[-1][2] = round(total_km, 1)
    return out
def data_hdr():
    """the dates of the data behind the survey (Overture release, OSM planet extract of the signs, Overpass, Autobahn
    roadworks, Panoramax) and when this was built"""
    import re, datetime, overture
    dt = lambda f: (json.load(open(C + 'corr/' + f)).get('date') if os.path.exists(C + 'corr/' + f) else None)
    pl = re.search(r'planet-(\d\d)(\d\d)(\d\d)\.orc', open(os.path.join(HERE, 'osm_planet_signs.py')).read())
    out = dict(overture=overture.REL.rsplit('/', 1)[-1], osm_planet=f'20{pl[1]}-{pl[2]}-{pl[3]}' if pl else None, overpass=OSMT.get('date') if OSMT else None,
               roadworks=dt('roadworks.json'), panoramax=dt('panoramax.json'), built=datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
               edges=edges_hdr(), lanes_fb=lanes_fb_hdr())
    return {k: v for k, v in out.items() if v}
def edges_hdr():
    """how much of the traced edges is bridged (survey.npz occl: an edge hidden, erratic or set by a shadow, filled from both
    sides): % of the metres, % of the 10 m rows bridged throughout, % of the route in bridged runs ≥ 200 m / ≥ 1 km, the
    longest run (km)"""
    fn = C + 'corr/survey.npz'
    if not os.path.exists(fn): return None
    S_ = np.load(fn); oc = np.nan_to_num(S_['occl'].astype(float)); hv = np.nan_to_num(S_['have'].astype(float)) > 0.5
    if not hv.any(): return None
    b = (oc >= 0.5) & hv; e = np.flatnonzero(np.diff(np.r_[0, b.astype(np.int8), 0])); L = e[1::2] - e[::2]
    return dict(bridged=round(float(oc[hv].mean() * 100), 1), rows=round(float((oc[hv] >= 0.999).mean() * 100), 1),
                runs200=round(float(L[L >= 20].sum() / hv.sum() * 100), 1), runs1k=round(float(L[L >= 100].sum() / hv.sum() * 100), 1),
                longest=round(float(L.max() / 100) if len(L) else 0.0, 2))
def lanes_fb_hdr():
    """km of one-way carriageway whose lanes are laid from the stretches around (route_lanelines.py lq 0: the painted lines
    not readable on the photo)"""
    fn = C + 'corr/lanelines.npz'
    if not os.path.exists(fn) or not os.path.exists(C + 'corr/lanes_1m.npz'): return None
    LLq = np.load(fn)['lq']; tw_ = np.load(C + 'corr/lanes_1m.npz')['tw'].astype(bool); m = min(len(LLq), len(tw_))
    return round(float(((LLq[:m] == 0) & ~tw_[:m]).sum() / 1000), 1)
def datasets_hdr(regions, clear):
    """per state: the photo credit (hd_sources), the height models' (route_pack.HCREDIT; null: none reachable) and the laser
    point clouds behind its clear heights ({n structures, flown from, to}; null: none used)"""
    from hd_sources import SOURCES
    import route_pack as RP, re
    out = {}
    for code in dict.fromkeys(c for c, a, b in regions or []):
        lz = [q for q in clear if (q.get('src') or '').startswith('laser point cloud')
              and any(c == code and a * 1000 <= q['s'] < b * 1000 for c, a, b in regions)]
        d = sorted(m[1] for q in lz for m in [re.search(r'\((\d{4}-\d{2})\)', (q.get('src') or '') + ' ' + (q.get('note') or ''))] if m)
        out[code] = dict(photo=SOURCES.get(code, {}).get('credit'), height=RP.HCREDIT.get(code),
                         laser=dict(n=len(lz), **{'from': d[0] if d else None, 'to': d[-1] if d else None}) if lz else None)
    return out
def tunnels_hdr():
    """the tunnels, covered sections and wildlife overpasses (route_tunnels.py), without the road profile and the lid"""
    fn = C + 'corr/tunnels.json'
    if not os.path.exists(fn): return None
    return [dict({k: v for k, v in t.items() if k not in ('prof', 'lid')}, check=t.get('signed') is None and t.get('phys') is None)
            for t in json.load(open(fn))['items'] if t['kind'] != 'underbridge']
REGIONS = regions_hdr()
# a lane stretch's blade beyond the edge (using the lane / keeping right) by the page's model (route_blade.mjs), else route_lanes.py's
_LB = {(round(q['s0'], 1), round(q['s1'], 1)): q for q in (BLADE or {}).get('lanes', [])}
def _lb(st, key, dflt):
    q = _LB.get((round(st['s0'], 1), round(st['s1'], 1)))
    return float(q[key]) if q else dflt
header = dict(
    title=routecfg.get('title', 'Windpark Hoßkirch blade route survey'), page=routecfg.get('page_text', {}), km=round(total_km, 1), blade=V['blade'], vehicle=round(V['length'], 1),
    model={k: V[k] for k in ('blade', 'front_oh', 'wheelbase', 'p1_back', 'root_ahead', 'support', 'tractor_len', 'tractor_w', 'dolly_len', 'dolly_w', 'fdolly_len', 'fdolly_w', 'overhang')},
    map=dict(proj=meta['proj'], lon0=routecfg.get('map_center', [12.1, 50.6])[0], lat0=routecfg.get('map_center', [12.1, 50.6])[1], x0=meta['x0'], y0=meta['y0'], x1=meta['x1'], y1=meta['y1'], W=meta['W'], H=meta['H'], outer={k: meta['outer'][k] for k in ('x0', 'y0', 'x1', 'y1')}),
    legs=legs, nights=nights, places=places, hot=hot_meta, sections=S, clear=CLEAR, roads=ROADREFS, roadworks=roadworks_hdr(), osm=osm_hdr(),
    lanes=[dict(a=round(st['s0']), b=round(st['s1']), across=st['rec']['across'], krOut=st['kr']['off'], krAcross=st['kr']['across'], krBlade=_lb(st, 'krBlade', st['kr']['blade']),
                out=st['rec']['off'], blade=_lb(st, 'blade', st['rec']['blade']), clear=st['rec']['clear'], hold=st['hold'], kind=st.get('kind', 'oncoming'))
           for st in (json.load(open(C + 'corr/lanes.json')) if os.path.exists(C + 'corr/lanes.json') else [])],
    codes=dict(road=list(CODES_ROAD), obj=list(CODES_OBJ), bar=list(CODES_BAR)),
    sources=EVIDENCE.get('_sources', []), factory=EVIDENCE.get('_factory', {}),
    regions=REGIONS, data=data_hdr(), datasets=datasets_hdr(REGIONS, CLEAR), tunnels=tunnels_hdr())
for k in ('regions', 'datasets', 'tunnels'):
    if header[k] is None: del header[k]                       # (without that data: as before)
json.dump(header, open(OUT + 'route.json', 'w'), ensure_ascii=False, separators=(',', ':'))
print(f'route.bin {len(comp) // 1024} KB (raw {len(blob) // 1024} KB), images', {k: len(v) // 1024 for k, v in images.items()})
for k, (b, m) in sections.items():
    if len(b) > 20000: print(f'   {k:28s} {len(b) // 1024} KB')
