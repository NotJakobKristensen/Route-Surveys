"""Blade-transport route planner and survey runner — Germany and the Goleniów / Szczecin area of Poland.

Give it the blade (and the vehicle) and the start and the end; it finds the best heavy-transport route and its
challenges, then (on request) surveys the chosen route in full:

  python survey_route.py plan <name> --start LON,LAT --end LON,LAT [--via LON,LAT …] [--alts 4]
         [--blade 84.3 --root 4.2 --chord 4.3 --height 4.7 --width 4.2 --weight 72 --length 98 --support 50]
     → routes/<name>/plan.json and routes/<name>/<name>-route-plan.html (minutes, not hours):
       1. the road graph of Germany (Overture transportation, OSM-derived; motorway → secondary, built once and shared)
          with every road within ~20 km of the start and the end; roads whose signed weight / height / length / width
          limit the convoy exceeds are left out;
       2. up to N distinct candidate routes under the heavy-transport policy (motorways, trunk and federal roads on the
          long haul, town streets avoided, minor roads only near the ends; Germany only, plus the Goleniów area);
       3. each candidate checked: swept-path screen of every bend and junction (the convoy model of route_swept.py
          with this blade), town kilometres, road bridges over the route, tunnels, roadworks and lane restrictions on
          the motorways today (Autobahn GmbH), signed limits close to the convoy's dimensions, mapped narrow roads;
       4. one score per candidate (convoy driving time plus a time-equivalent per challenge, weights in plan.json),
          the best one recommended, every challenge listed with its km and position.
  python survey_route.py survey <name> [--pick N] [--from STEP] [--only STEP] [--list]
     → the full survey of the chosen route with the tools of this folder (corridor photo strips and carriageway edges,
       swept path on measured edges, clear heights from laser terrain and point clouds, map tags, roadworks, photos,
       HD passages) and its 3D route page; every finished step is stamped, a re-run continues where it stopped.

Vehicle defaults are the V172 blade convoy of the two surveyed routes (route_swept.V).
"""
import argparse, json, math, os, pickle, re, subprocess, sys, time, urllib.request
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.normpath(os.path.join(HERE, '..'))
SHARED = os.path.join(PROJECT, '.cache', 'route') + '/'
DE_BOX = (5.85, 47.25, 15.1, 55.1)                     # the national network (Germany; Goleniów and Szczecin inside)
PL_AREA = (14.1, 53.2, 15.05, 53.75)                   # the Polish part in scope: Goleniów, Szczecin, A6 to the border
LOCAL_DLON, LOCAL_DLAT = 0.3, 0.2                      # every road around the start and the end (~20 km)
NEAR_M = 20000.0

# time-equivalent (minutes) per challenge: the score is the convoy's driving time plus these
WEIGHTS = dict(wheel_spot=30.0, wheel_per_m=60.0, blade_spot=4.0, blade_per_m=1.5, urban_km=6.0, bridge_over=4.0,
               tunnel=30.0, works_narrow=25.0, works=5.0, tight_limit=90.0, narrow_road=20.0)
# convoy speeds (km/h) for the driving-time estimate (night, escorted)
CONVOY_KMH = {'motorway': 60, 'trunk': 50, 'primary': 40, 'secondary': 30, 'tertiary': 25, 'unclassified': 15}
VEH_KEYS = dict(blade='blade', root='root_d', chord='maxchord', height='height', width='load_w', support='support')


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def route_root(name):
    return os.path.join(PROJECT, 'routes', name)


def run(args, root, env=None, log_to=None, cwd=HERE):
    e = dict(os.environ, ROUTE_ROOT=root, **(env or {}))
    out = open(log_to, 'a') if log_to else None
    r = subprocess.run([sys.executable] + args if args[0].endswith('.py') else args, cwd=cwd, env=e, stdout=out or None,
                       stderr=subprocess.STDOUT if out else None)
    if out: out.close()
    if r.returncode: raise RuntimeError(f'{" ".join(args)} failed ({r.returncode})' + (f', see {log_to}' if log_to else ''))


# ───────────────────────────── national graph ─────────────────────────────
def area_polygon():
    """Germany (Overture divisions, country DE) plus the Polish area in scope, simplified → shapely geometry"""
    from shapely import wkb
    from shapely.geometry import box
    fn = SHARED + 'area_de.wkb'
    if not os.path.exists(fn):
        sys.path.insert(0, HERE); import overture as ov, pyarrow.compute as pc
        t = ov.query('divisions', 'division_area', DE_BOX, columns=['subtype', 'class', 'country', 'geometry'],
                     extra=(pc.field('subtype') == 'country') & (pc.field('country') == 'DE'))
        g = [wkb.loads(r['geometry']) for r in t.to_pylist() if r['class'] == 'land'] or [wkb.loads(r['geometry']) for r in t.to_pylist()]
        from shapely.ops import unary_union
        a = unary_union(g).buffer(0.01).simplify(0.005).union(box(*PL_AREA))
        open(fn, 'wb').write(a.wkb)
    return wkb.loads(open(fn, 'rb').read())


def node_mask(G, area):
    import shapely
    shapely.prepare(area)
    return shapely.contains_xy(area, np.asarray(G.nlon), np.asarray(G.nlat))


def national():
    """the shared road graph of Germany (keeps roads with signed limits; filtered per convoy) with its area mask"""
    sys.path.insert(0, HERE)
    import route_graph
    fn = SHARED + 'graph_de.pkl'
    if os.path.exists(fn):
        log('loading the road graph of Germany')
        G = pickle.load(open(fn, 'rb'))
        return G
    if not os.path.exists(SHARED + 'net_de.parquet'):
        log('fetching the road network of Germany (Overture, motorway → secondary)')
        run(['route_net.py', ','.join(map(str, DE_BOX)), 'de', 'motorway,trunk,primary,secondary'], PROJECT)
    log('building the road graph of Germany (once)')
    G = route_graph.Net([SHARED + 'net_de.parquet'])
    G.mask = node_mask(G, area_polygon())
    pickle.dump(G, open(fn, 'wb'), protocol=pickle.HIGHEST_PROTOCOL)
    return G


# ───────────────────────────── helpers ─────────────────────────────
def hav(lon1, lat1, lon2, lat2):
    from route_graph import hav as h
    return h(lon1, lat1, lon2, lat2)


def flag_on(info, name):
    """is the edge (piece a..b of its segment) flagged (is_bridge, is_tunnel …)"""
    for f in info.get('flags') or []:
        if name not in (f.get('values') or []): continue
        bt = f.get('between')
        if not bt or (bt[0] < info['b'] and bt[1] > info['a']): return True
    return False


def flag_len(info, name, L):
    """metres of the edge (length L) under the flag (a tunnel: the covered stretch, not the whole piece)"""
    a, b = info['a'], info['b']; seg = L / max(1e-9, b - a); m = 0.0
    for f in info.get('flags') or []:
        if name not in (f.get('values') or []): continue
        bt = f.get('between') or [0.0, 1.0]
        m += max(0.0, min(b, bt[1]) - max(a, bt[0])) * seg
    return m


def sharp_turns(G, path, limit=125.0, skip_m=150.0):
    """(u, v) of the edges leaving a node where the path turns back sharper than limit degrees (a U-turn on a ramp,
    a hairpin into the opposite slip road) — beyond what a blade convoy can do at a junction; not within skip_m of the
    ends (the yard and the crane pad are surveyed anyway)"""
    out = []
    E = G.edges(path)
    lens = [float(hav(np.array(pc)[:-1, 0], np.array(pc)[:-1, 1], np.array(pc)[1:, 0], np.array(pc)[1:, 1]).sum()) for _, pc in E]
    tot = sum(lens); s = 0.0
    def head(pc, rev):
        a = np.array(pc[::-1] if rev else pc); k = math.cos(math.radians(a[0, 1]))
        d = np.cumsum(np.r_[0, np.hypot(np.diff(a[:, 0]) * k, np.diff(a[:, 1])) * 111000])
        j = min(len(a) - 1, int(np.searchsorted(d, 25.0)))
        v = (a[j] - a[0]) * [k, 1]; return v / (np.hypot(*v) + 1e-12)
    for i in range(len(E) - 1):
        s += lens[i]
        if s < skip_m or s > tot - skip_m: continue
        hin = -head(E[i][1], True); hout = head(E[i + 1][1], False)
        ang = math.degrees(math.acos(max(-1.0, min(1.0, float(hin @ hout)))))
        if ang > limit: out.append((path[i + 1], path[i + 2]))
    return out


def width_of(info):
    """mapped road width (m) over the edge, if any"""
    for w in info.get('width') or []:
        bt = w.get('between')
        if w.get('value') and (not bt or (bt[0] < info['b'] and bt[1] > info['a'])): return float(w['value'])
    return None


def places():
    """towns and cities of Germany and the Goleniów area with their population (Overture divisions), shared"""
    fn = SHARED + 'places_de.json'
    if not os.path.exists(fn):
        sys.path.insert(0, HERE); import overture as ov, pyarrow.compute as pc
        from shapely import wkb
        t = ov.query('divisions', 'division', DE_BOX, columns=['subtype', 'names', 'geometry', 'population', 'country'],
                     extra=pc.field('subtype').isin(['locality', 'localadmin']))
        out = []
        for r in t.to_pylist():
            g = wkb.loads(r['geometry']); n = (r.get('names') or {}).get('primary')
            if n and r.get('country') in ('DE', 'PL'):
                out.append([n, round(g.x, 5), round(g.y, 5), int(r.get('population') or 0)])
        json.dump(out, open(fn, 'w'), ensure_ascii=False)
    return json.load(open(fn))


def place_name(lon, lat, P=None, within=6000.0):
    """the town a point belongs to: the most populous place within `within` m, else the nearest place"""
    P = P or places()
    a = np.array([[p[1], p[2]] for p in P]); d = hav(a[:, 0], a[:, 1], lon, lat)
    near = np.nonzero(d < within)[0]
    if len(near):
        pop = np.array([P[i][3] for i in near])
        if pop.max() > 0: i = int(near[np.argmax(pop)]); return P[i][0], float(d[i])
    i = int(np.argmin(d)); return P[i][0], float(d[i])


def main_ref(ref):
    """the national road number of a ref list ("3;6;A6;E 28;S3" → "S3", "A 9;E 51" → "A 9"): no E-roads"""
    rs = [r.strip() for r in (ref or '').split(';') if r.strip()]
    for pat in (r'^A ?\d', r'^S ?\d', r'^B ?\d', r'^DK ?\d', r'^(St|L|K|S|DW) ?\d'):
        for r in rs:
            if re.match(pat, r): return r
    rs = [r for r in rs if not r.startswith('E ')] or rs
    return rs[0] if rs else ''


def convoy_of(veh):
    return dict(weight_t=veh['weight'], height_m=veh['height'], length_m=veh['length'], width_m=veh['load_w'])


# ───────────────────────────── candidate metrics ─────────────────────────────
class Bridges:
    """road bridges of the graph (pieces flagged is_bridge), for the structures over a candidate"""

    def __init__(self, G):
        from shapely.geometry import LineString
        from shapely.strtree import STRtree
        self.g, self.sid = [], []
        for k in np.nonzero(G.p_br)[0]:
            self.g.append(LineString(G.coords(k))); self.sid.append(G.seg_id[G.p_seg[k]])
        self.tree = STRtree(self.g)

    def over(self, E):
        """[(lon, lat, road over, edge index)] where a bridge of another road crosses the route (not at its ends)"""
        from shapely.geometry import LineString, Point
        own = {info['id'] for info, _ in E}
        hits, seen = [], set()
        for k, (info, pc) in enumerate(E):
            if len(pc) < 2 or flag_on(info, 'is_tunnel'): continue
            ln = LineString(pc)
            for j in self.tree.query(ln, predicate='intersects'):
                if self.sid[j] in own or j in seen: continue
                x = ln.intersection(self.g[j])
                if x.is_empty: continue
                p = x if x.geom_type == 'Point' else x.representative_point()
                b = self.g[j]; ends = (Point(b.coords[0]), Point(b.coords[-1]))
                if min(hav(p.x, p.y, e.x, e.y) for e in ends) < 15: continue      # a ramp joining the route, not over it
                seen.add(j); hits.append((p.x, p.y, j, k))
        return hits


def roadworks(refs, cache):
    """today's roadworks and closures of the motorways refs (Autobahn GmbH) → [(entry, coords array)]"""
    from route_roadworks import API, parse
    import ast
    out = []
    os.makedirs(cache, exist_ok=True)
    for road in refs:
        for svc in ('roadworks', 'closure'):
            fn = os.path.join(cache, f'{road}_{svc}_{time.strftime("%Y%m%d")}.json')
            if os.path.exists(fn): js = json.load(open(fn))
            else:
                js = {}
                for a in range(3):
                    try:
                        js = json.loads(urllib.request.urlopen(urllib.request.Request(API.format(road=road, svc=svc), headers={'User-Agent': 'route-survey'}), timeout=60).read()); break
                    except Exception as ex: log('  autobahn retry', road, svc, repr(ex)[:60]); time.sleep(3 * (a + 1))
                json.dump(js, open(fn, 'w'))
            for e in js.get(svc, []):
                try: g = e['geometry'] if isinstance(e['geometry'], dict) else ast.literal_eval(e['geometry'])
                except Exception: continue
                co = np.array(g.get('coordinates') or [])
                if co.ndim != 2 or len(co) < 1: continue
                info = parse(e.get('description') or [])
                info.update(kind=svc, road=road, title=(e.get('title') or '').replace(' | ', ': '), dir=(e.get('subtitle') or '').strip(),
                            blocked=e.get('isBlocked') == 'true', future=e.get('future') == 'True')
                out.append((info, co))
    return out


def metrics(G, E, veh, bridges, works_all):
    """→ dict of the candidate's figures and challenges (no swept path yet)"""
    from pyproj import Transformer
    from scipy.spatial import cKDTree
    km_cls, urban_km, t_h, refs_seq = {}, 0.0, 0.0, []
    ch = []
    need_w = max(2.9, veh['load_w']) + 0.5
    s_acc = 0.0
    S0 = []                     # chainage at each edge's start (m)
    for k, (info, pc) in enumerate(E):
        a = np.array(pc); L = float(hav(a[:-1, 0], a[:-1, 1], a[1:, 0], a[1:, 1]).sum()); S0.append(s_acc)
        cls = info['cls']; km_cls[cls] = km_cls.get(cls, 0) + L / 1000
        v = CONVOY_KMH.get(cls, 12) * (0.6 if info.get('sub') == 'link' else 1)
        if info.get('urban'): urban_km += L / 1000; v = min(v, 20)
        t_h += L / 1000 / v
        r = main_ref(info['ref'])
        if r and (not refs_seq or refs_seq[-1][0] != r): refs_seq.append([r, L / 1000])
        elif r: refs_seq[-1][1] += L / 1000
        mid = a[len(a) // 2]
        tl = flag_len(info, 'is_tunnel', L)
        if tl >= 80:                    # shorter: an underpass or a covered junction (in the bridge count's terms)
            ch.append(dict(kind='tunnel', s=s_acc, lon=mid[0], lat=mid[1], road=r or info['name'] or '', len_m=round(tl),
                           text=f'tunnel, {tl:.0f} m: clear height and width to confirm'))
        lim = info.get('lim') or {}
        if lim.get('height') and lim['height'] < veh['height'] + 0.3:
            ch.append(dict(kind='limit', s=s_acc, lon=mid[0], lat=mid[1], road=r or info['name'] or '',
                           text=f'signed height limit {lim["height"]:.2f} m (convoy {veh["height"]:.2f} m)'))
        if lim.get('width') and lim['width'] < veh['load_w'] + 0.5:
            ch.append(dict(kind='limit', s=s_acc, lon=mid[0], lat=mid[1], road=r or info['name'] or '',
                           text=f'signed width limit {lim["width"]:.2f} m (load {veh["load_w"]:.2f} m)'))
        w = width_of(info)
        if w and w < need_w and cls not in ('motorway', 'trunk'):
            ch.append(dict(kind='narrow', s=s_acc, lon=mid[0], lat=mid[1], road=r or info['name'] or '',
                           text=f'mapped road width {w:.1f} m (convoy needs about {need_w:.1f} m)'))
        s_acc += L
    total = s_acc
    # urban stretches (joined) as challenges
    run0 = None
    for k, (info, pc) in enumerate(E + [({'urban': False}, [])]):
        if info.get('urban') and run0 is None: run0 = k
        if not info.get('urban') and run0 is not None:
            s0 = S0[run0]; s1 = S0[k] if k < len(S0) else total
            if s1 - s0 > 150:
                m = E[(run0 + k) // 2][1][0]; nm = place_name(m[0], m[1])[0]
                ch.append(dict(kind='town', s=s0, lon=m[0], lat=m[1], road=main_ref(E[run0][0]['ref']) or E[run0][0]['name'] or '',
                               len_m=round(s1 - s0), text=f'through {nm}: {(s1 - s0) / 1000:.1f} km of town streets (50 km/h or less)'))
            run0 = None
    # road bridges over the route
    for lon, lat, j, k in bridges.over(E):
        a = np.array(E[k][1]); d = hav(a[:, 0], a[:, 1], lon, lat); s = S0[k] + float(np.min(d))
        ch.append(dict(kind='bridge', s=s, lon=lon, lat=lat, road=main_ref(E[k][0]['ref']) or E[k][0]['name'] or '',
                       text='road bridge over the route: clear height to confirm (≥ %.1f m needed)' % (veh['height'] + 0.1)))
    # roadworks on the route's motorways, in our direction of travel
    if works_all:
        T = Transformer.from_crs('EPSG:4326', 'EPSG:32633', always_xy=True)
        pts, ss = [], []
        for k, (info, pc) in enumerate(E):
            if info['cls'] != 'motorway': continue
            a = np.array(pc); x, y = T.transform(a[:, 0], a[:, 1]); pts += list(zip(x, y))
            ss += list(S0[k] + np.r_[0, np.cumsum(np.hypot(np.diff(x), np.diff(y)))])
        if pts:
            kd = cKDTree(np.array(pts)); ss = np.array(ss)
            for info, co in works_all:
                xy = np.array(T.transform(co[:, 0], co[:, 1])).T
                dd, kk = kd.query(xy); on = dd < 35
                if on.mean() < 0.6: continue
                ks = kk[on]
                if len(ks) > 1 and ss[ks[-1]] < ss[ks[0]]: continue
                narrow = info.get('width') is not None and info['width'] < need_w
                ch.append(dict(kind='works_narrow' if narrow else 'works', s=float(ss[ks.min()]), lon=float(co[0, 0]), lat=float(co[0, 1]),
                               road=info['road'], len_m=round(float(ss[ks.max()] - ss[ks.min()])),
                               text=(info['title'] or info['kind']) + (f' · passable width {info["width"]:.2f} m' if info.get('width') else '')
                               + (f' · {info["start"]} – {info["end"]}' if info.get('start') else '') + (' · closed' if info.get('blocked') else '')))
    # one entry per position and kind (a structure can cross the route in two edges)
    seen, out = set(), []
    for c in sorted(ch, key=lambda c: c['s']):
        key = (c['kind'], round(c['s'] / 60))
        if key in seen: continue
        seen.add(key); out.append(c)
    main = [r for r, L in refs_seq if L > 15]
    via = []
    for r in main:
        if not via or via[-1] != r: via.append(r)
    return dict(km=round(total / 1000, 1), hours=round(t_h, 1), nights=math.ceil(t_h / 7.0), urban_km=round(urban_km, 1),
                km_by_class={k: round(v, 1) for k, v in sorted(km_cls.items(), key=lambda kv: -kv[1])}, via=via[:12], challenges=out)


def add_screen(cand, spots):
    """the swept-path screen's spots → challenges"""
    for sp in spots:
        if sp['wheel'] >= 0.3:
            cand['challenges'].append(dict(kind='wheel', s=sp['km'] * 1000, lon=sp['lon'], lat=sp['lat'], road=main_ref(sp['ref']) or sp['ref'], R=sp['R'],
                                           wheel=sp['wheel'], blade=sp['blade'],
                                           text=(f'tight {"junction" if sp["R"] < 60 else "bend"} (radius ≈ {sp["R"]} m)' if sp['R'] < 3000 else 'turn') + f': wheel units {sp["wheel"]:.1f} m beyond the carriageway'
                                           + (f', blade sweeps {sp["blade"]:.0f} m beyond the edge' if sp['blade'] >= 1 else '')))
        elif sp['blade'] >= 1.0:
            cand['challenges'].append(dict(kind='blade', s=sp['km'] * 1000, lon=sp['lon'], lat=sp['lat'], road=main_ref(sp['ref']) or sp['ref'], R=sp['R'],
                                           wheel=sp['wheel'], blade=sp['blade'],
                                           text=f'blade overswing {sp["blade"]:.0f} m beyond the carriageway' + (f' (radius ≈ {sp["R"]} m)' if sp['R'] < 3000 else ' (leaving a turn)')
                                           + ': verge, signs, trees, buildings to check'))
    cand['challenges'].sort(key=lambda c: c['s'])


def score(c, W):
    n = lambda k: sum(1 for x in c['challenges'] if x['kind'] == k)
    parts = dict(drive=c['hours'] * 60,
                 wheel=sum(W['wheel_spot'] + W['wheel_per_m'] * min(3.0, x['wheel']) for x in c['challenges'] if x['kind'] == 'wheel'),
                 blade=sum(W['blade_spot'] + W['blade_per_m'] * min(30.0, x['blade']) for x in c['challenges'] if x['kind'] == 'blade'),
                 town=W['urban_km'] * c['urban_km'], bridges=W['bridge_over'] * n('bridge'), tunnels=W['tunnel'] * n('tunnel'),
                 works=W['works_narrow'] * n('works_narrow') + W['works'] * n('works'), limits=W['tight_limit'] * n('limit'),
                 narrow=W['narrow_road'] * n('narrow'))
    c['score_parts'] = {k: round(v) for k, v in parts.items()}
    c['score'] = round(sum(parts.values()))
    c['counts'] = {k: n(k) for k in ('wheel', 'blade', 'town', 'bridge', 'tunnel', 'works_narrow', 'works', 'limit', 'narrow')}


# ───────────────────────────── plan ─────────────────────────────
def snap(G, lon, lat, n=12):
    d = hav(np.asarray(G.nlon), np.asarray(G.nlat), lon, lat)
    idx = np.argsort(d)[:n]
    return [(int(i), float(d[i])) for i in idx]


def plan(a):
    sys.path.insert(0, HERE)
    import route_swept
    name = a.name; root = route_root(name); C = os.path.join(root, '.cache', 'route') + '/'
    os.makedirs(C, exist_ok=True)
    pts = [tuple(map(float, a.start.split(',')))] + [tuple(map(float, v.split(','))) for v in a.via] + [tuple(map(float, a.end.split(',')))]
    veh = {k: route_swept.V[k] for k in ('blade', 'root_d', 'maxchord', 'height', 'load_w', 'support', 'under_sup')}
    for k, key in VEH_KEYS.items():
        if getattr(a, k) is not None: veh[key] = getattr(a, k)
    veh['weight'] = a.weight; veh['length'] = a.length or round(route_swept.V['front_oh'] + route_swept.V['p1_back'] + veh['blade'] - route_swept.V['root_ahead'] + 2, 1)
    cfgfn = os.path.join(root, 'route_config.json')
    cfg = json.load(open(cfgfn)) if os.path.exists(cfgfn) else {}
    cfg.update(id=name, waypoints=[list(p) for p in pts], policy=dict(near_m=NEAR_M, urban_x=8.0),
               vehicle={k: veh[k] for k in ('blade', 'root_d', 'maxchord', 'height', 'load_w', 'support', 'under_sup')},
               transport_height=veh['height'], convoy=dict(weight_t=veh['weight'], length_m=veh['length']))
    json.dump(cfg, open(cfgfn, 'w'), ensure_ascii=False, indent=1)
    W = dict(WEIGHTS, **(json.loads(a.weights) if a.weights else {}))
    for p in pts:
        if not (DE_BOX[0] <= p[0] <= DE_BOX[2] and DE_BOX[1] <= p[1] <= DE_BOX[3]): sys.exit(f'{p} is outside the area in scope')
    # local networks: every road around the start and the end
    for tag, (lon, lat) in (('factory', pts[0]), ('site', pts[-1])):
        fn = C + f'net_{tag}.parquet'
        if not os.path.exists(fn):
            log(f'fetching every road around the {"start" if tag == "factory" else "end"}')
            run(['route_net.py', f'{lon - LOCAL_DLON:.3f},{lat - LOCAL_DLAT:.3f},{lon + LOCAL_DLON:.3f},{lat + LOCAL_DLAT:.3f}', tag], root)
    if not os.path.exists(C + 'net_major.parquet'): os.symlink(SHARED + 'net_de.parquet', C + 'net_major.parquet')
    G = national()
    n0 = len(G.nlon)
    G.extend([C + 'net_factory.parquet', C + 'net_site.parquet'])
    area = area_polygon()
    G.mask = np.r_[G.mask, node_mask(type('g', (), dict(nlon=G.nlon[n0:], nlat=G.nlat[n0:])), area)]
    convoy = convoy_of(veh)
    log('heavy-transport cost matrix for this convoy')
    M = G.policy_matrix([pts[0], pts[-1]], NEAR_M, 8.0, convoy=convoy, mask=G.mask)
    # the start, via points and end on the network: the nearest node from which the rest is reachable
    from scipy.sparse.csgraph import dijkstra
    ids, snapd = [], []
    for i, (lon, lat) in enumerate(pts):
        cands = snap(G, lon, lat)
        if i == 0:
            ids.append(None)
            for nid, d in cands:
                dist = dijkstra(M, directed=True, indices=nid, limit=200000.0)
                if np.isfinite(dist).sum() > 1000: ids[0] = nid; snapd.append(d); break
        else:
            ids.append(cands[0][0]); snapd.append(cands[0][1])
            dist = dijkstra(M, directed=True, indices=ids[-2])
            for nid, d in cands:
                if np.isfinite(dist[nid]): ids[-1] = nid; snapd[-1] = d; break
    for p, d in zip(pts, snapd):
        if d > 500: log(f'  note: {p} is {d:.0f} m from the nearest road of the network')
    # no U-turns or hairpins at junctions: such a turn's outgoing edge is made 50 × as expensive, then routed again
    M = M.tocsr(); M.sort_indices()
    for it in range(12):
        full = []
        for u_, v_ in zip(ids[:-1], ids[1:]):
            p_ = G.path(M, u_, v_)
            if p_ is None: sys.exit("no route found for this convoy (every connection blocked by signed limits?)")
            full += p_ if not full else p_[1:]
        bad = sharp_turns(G, full)
        if not bad: break
        for u_, v_ in bad:
            a0, a1 = M.indptr[u_], M.indptr[u_ + 1]; j = a0 + np.searchsorted(M.indices[a0:a1], v_)
            if j < a1 and M.indices[j] == v_: M.data[j] *= 50
        log(f'  {len(bad)} turn{"s" if len(bad) > 1 else ""} sharper than 125° avoided')
    log(f'{a.alts} candidate routes')
    paths = G.alternatives(M, ids, k=a.alts, penalty=1.35, max_share=0.75, max_detour=1.3, repair=lambda p_: sharp_turns(G, p_))
    for i, p_ in enumerate(paths):
        if sharp_turns(G, p_): log(f'  note: candidate {i} still turns back sharply somewhere (checked in the screen)')
    if not paths: sys.exit('no route found for this convoy (every connection blocked by signed limits?)')
    bridges = Bridges(G)
    cands = []
    for i, p in enumerate(paths):
        E = G.edges(p)
        pickle.dump(E, open(C + f'cand_{i}.pkl', 'wb'))
        refs = set()
        for info, _ in E:
            if info['cls'] == 'motorway':
                for r in (info.get('ref') or '').split(';'):
                    m_ = re.match(r'^A\s?(\d+)$', r.strip())
                    if m_: refs.add('A' + m_[1])
        sys.path.insert(0, HERE)
        os.environ['ROUTE_ROOT'] = root
        works = roadworks(sorted(refs, key=lambda x: int(x[1:])), C + 'autobahn')
        c = metrics(G, E, veh, bridges, works); c['id'] = i
        line = []
        for info, pc in E:
            line += pc if not line else pc[1:]
        from shapely.geometry import LineString
        c['line'] = [[round(x, 5), round(y, 5)] for x, y in LineString(line).simplify(0.00012).coords]
        cands.append(c)
        log(f'  candidate {i}: {c["km"]} km, {c["hours"]} h, via {" · ".join(c["via"][:8])}')
    # swept-path screen of each candidate (in parallel)
    log('swept-path screen of each candidate')
    procs = []
    for i in range(len(cands)):
        if os.path.exists(C + f'screen_spots_cand_{i}.json') and os.path.getmtime(C + f'screen_spots_cand_{i}.json') > os.path.getmtime(C + f'cand_{i}.pkl'): continue
        e = dict(os.environ, ROUTE_ROOT=root, SCREEN_TAG=f'cand_{i}')
        procs.append(subprocess.Popen([sys.executable, 'route_screen.py', f'cand_{i}.pkl'], cwd=HERE, env=e,
                                      stdout=open(C + f'screen_cand_{i}.log', 'w'), stderr=subprocess.STDOUT))
        while sum(p.poll() is None for p in procs) >= max(1, (os.cpu_count() or 2) - 1): time.sleep(2)
    for p in procs: p.wait()
    for c in cands:
        fn = C + f'screen_spots_cand_{c["id"]}.json'
        add_screen(c, json.load(open(fn)) if os.path.exists(fn) else [])
        score(c, W)
    best = min(cands, key=lambda c: c['score'])
    P = places()
    big = [p for p in P if p[3] >= 100000]
    sname, _ = place_name(*pts[0], P); ename, _ = place_name(*pts[-1], P)
    out = dict(name=name, date=time.strftime('%Y-%m-%d'), start=dict(lon=pts[0][0], lat=pts[0][1], place=sname),
               end=dict(lon=pts[-1][0], lat=pts[-1][1], place=ename), via=[dict(lon=p[0], lat=p[1]) for p in pts[1:-1]],
               vehicle=veh, weights=W, best=best['id'], candidates=cands, cities=[p[:3] for p in big])
    json.dump(out, open(os.path.join(root, 'plan.json'), 'w'), ensure_ascii=False)
    for c in sorted(cands, key=lambda c: c['score']):
        log(f'  {"★" if c is best else " "} {c["id"]}: score {c["score"]:5d}  {c["km"]:6.1f} km  {c["hours"]:4.1f} h  '
            + '  '.join(f'{k} {v}' for k, v in c['counts'].items() if v))
    page = plan_page(out, root)
    log('plan →', os.path.join(root, 'plan.json'), 'and', page)


def plan_page(plan_, root):
    """the plan as a self-contained page (map of the candidates, the challenges, the scores)"""
    from shapely import wkb
    from shapely.geometry import mapping
    base = SHARED + 'plan_base.json'
    if not os.path.exists(base):
        area = area_polygon().simplify(0.02)
        geoms = [area] if area.geom_type == 'Polygon' else list(area.geoms)
        outline = [[[round(x, 3), round(y, 3)] for x, y in g.exterior.coords] for g in geoms if g.area > 0.01]
        G = national()
        from shapely.geometry import LineString
        mw = [G.coords(k) for k in np.nonzero((G.p_cls == 0) & (G.p_link == 0))[0]]
        from shapely.ops import linemerge
        from shapely.geometry import MultiLineString
        merged = linemerge(MultiLineString([LineString(p) for p in mw]))
        lines = [[[round(x, 3), round(y, 3)] for x, y in l.simplify(0.01).coords] for l in (merged.geoms if hasattr(merged, 'geoms') else [merged]) if l.length > 0.02]
        json.dump(dict(outline=outline, motorways=lines), open(base, 'w'))
    B = json.load(open(base))
    tpl = open(os.path.join(HERE, 'plan_page.html'), encoding='utf-8').read()
    html = tpl.replace('/*PLAN*/null', json.dumps(plan_, ensure_ascii=False, separators=(',', ':'))) \
              .replace('/*BASE*/null', json.dumps(B, separators=(',', ':'))) \
              .replace('{{TITLE}}', f'{plan_["start"]["place"]} → {plan_["end"]["place"]}')
    fn = os.path.join(root, f'{plan_["name"]}-route-plan.html')
    open(fn, 'w', encoding='utf-8').write(html)
    return fn


# ───────────────────────────── survey ─────────────────────────────
HD = ('PL-32', 'DE-MV', 'DE-BB', 'DE-ST', 'DE-SN', 'DE-TH', 'DE-BY', 'DE-BW')       # aerial photo strips (hd_sources)
LAZ = ('PL-32', 'DE-BY', 'DE-BB')                                                     # airborne laser point clouds


def regions(C):
    lab = pickle.load(open(C + 'corr/regions.pkl', 'rb'))['lab']
    seen = []
    for r in lab:
        r = 'DE-BB' if r == 'DE-BE' else r
        if r not in seen: seen.append(r)
    return seen


def step_list(root, C):
    """(key, what, [commands]) — commands: (args, env) run in order; a callable returns them when the step starts"""
    hot_ids = lambda: [h[0] for h in json.load(open(os.path.join(root, 'route_config.json'))).get('hot') or []]
    reg = lambda: regions(C)
    return [
        ('screen', 'swept-path screen of the whole route', [(['route_screen.py'], {})]),
        ('regions', 'state / voivodeship of every 500 m', [(['route_regions.py'], {})]),
        ('corridor', 'aerial photo strips and carriageway edges per 500 m', lambda: [(['route_corridor_run.py', '4'] + [r for r in reg() if r in HD], {}),
                                                                                    (['route_corridor_run.py', '4'] + [r for r in reg() if r in HD], {'WIDE': '1'})]),
        ('objects', 'roadside objects and bridges over the route', [(['route_objects.py'], {})]),
        ('elev', 'elevation along the route', [(['route_elev.py'], {})]),
        ('site', 'crane pad height from the elevation', 'site'),
        ('survey_line', 'survey rows every 10 m, swept path on the measured edges', [(['route_survey_line.py'], {})]),
        # (roads within 120 m first: the opposite carriageway; incremental — the signs step finds them cached)
        ('lanelines', 'painted lines, lanes and the central reservation from the photo strips', [(['route_roads.py'], {}), (['route_lanelines.py', '4'], {})]),
        ('lanes', 'keep right; lane 2 or the oncoming lane only where needed', [(['route_lanes.py', '4'], {})]),
        ('survey_swept', 'swept path again on the planned line (survey rows)', [(['route_survey_line.py'], {'SWEPT': '1'})]),
        ('bridges', 'bridges over and under the route', [(['route_bridges.py', 'fetch'], {}), (['route_bridges.py', 'heights'], {})]),
        ('clearance', 'clear heights from the surface and terrain models', lambda: [(['route_clearance.py', r], {'CLEAR_OUT': f'clear_{r.lower()}.json'}) for r in reg()]
                                                                                  + [(['route_clearance.py'], {'VERIFY': '1'})]),
        ('clear_hd_all', 'clear heights from the 1 m laser terrain', [(['route_clear_hd.py'], {'ALL': '1', 'CLEAR_HD_OUT': 'clear_hd_all.json'})]),
        ('laz', 'clear heights from airborne laser point clouds', lambda: [(['route_clear_laz.py', 'extract', r], {}) for r in reg() if r in LAZ]
                                                                         + [(['route_clear_laz.py', 'measure'], {})]),
        ('osm', 'map tags: limits, power lines, kerbs, islands (Overpass)', [(['route_osm.py'], {})]),
        ('vprof', 'road profile from the laser terrain; tunnels and covered sections (OSM names)', [(['route_vprof.py'], {}), (['route_tunnels.py'], {})]),
        ('roadworks', 'roadworks and closures (Autobahn GmbH)', [(['route_roadworks.py'], {})]),
        ('panoramax', 'street-level photos (Panoramax)', [(['route_panoramax.py'], {})]),
        ('signs', 'signs, speed limits, town signs', [(['osm_planet_signs.py'], {}), (['route_roads.py'], {}), (['route_objects.py'], {'TAGS_ONLY': '1'}),
                                                     (['route_signs.py'], {})]),
        ('map', 'overview map and context', [(['route_map.py'], {}), (['route_map.py', 'outer'], {}), (['route_context.py'], {})]),
        ('findhot', 'the difficult passages, from the data', [(['route_findhot.py', '999'], {})]),
        ('bridges_hot', 'bridges at the passages', [(['route_bridges.py', 'fetch'], {}), (['route_bridges.py', 'heights'], {})]),
        ('hotspots', 'HD passages: official photo, laser terrain, swept areas', lambda: [(['route_hotspots.py'] + hot_ids()[i::3], {}) for i in range(3) if hot_ids()[i::3]]),
        ('trees', 'trees over each passage from the surface model', [(['hd_trees_all.py'], {})]),
        ('clear_hd', 'clear heights at the passages', [(['route_clear_hd.py'], {})]),
        ('bake', 'page data', [(['route_bake.py'], {})]),
        ('pack', 'road-view and passage packs', [(['rm', '-rf', os.path.join(root, 'dist', 'r'), os.path.join(root, 'dist', 'h')], {}),
                                                (['route_pack.py'], {}), (['route_hd_pack.py'], {}), (['route_pix.py'], {})]),
        ('page', 'the route page', [(['node', 'windpark-hosskirch/tools/build_route.mjs'], {'_cwd': os.path.normpath(os.path.join(PROJECT, '..'))})]),
    ]


def site_step(root, C):
    cfgfn = os.path.join(root, 'route_config.json'); cfg = json.load(open(cfgfn))
    z = np.load(C + 'corr/elev.npz')
    zz = z['z0'][np.isfinite(z['z0'])]
    end = cfg['waypoints'][-1]
    cfg['turbines'] = [dict(id='Site', lon=end[0], lat=end[1], ground=round(float(zz[-1]), 1), hub=None, rotor=None)]
    json.dump(cfg, open(cfgfn, 'w'), ensure_ascii=False, indent=1)


def survey_config(root, plan_, pick):
    """route_config.json for the chosen candidate: the page's name and texts, legs, towns, map centre"""
    cfgfn = os.path.join(root, 'route_config.json'); cfg = json.load(open(cfgfn))
    c = plan_['candidates'][pick]; st, en = plan_['start']['place'], plan_['end']['place']
    L = np.array(c['line'])
    name = plan_['name']; v = plan_['vehicle']
    cfg.setdefault('page', f'{name}-blade-route')
    cfg.setdefault('title', f'{st} → {en} blade route survey')
    cfg.setdefault('start_title', 'Leaving the yard')
    cfg['map_center'] = [round(float(L[:, 0].mean()), 2), round(float(L[:, 1].mean()), 2)]
    cfg.setdefault('park', None)
    cfg.setdefault('passages', 'all')
    near = [p for p in plan_['cities'] if np.min(hav(L[:, 0], L[:, 1], p[1], p[2])) < 15000]
    cfg['keep_towns'] = sorted({st, en} | {p[0] for p in near})
    legs, via = [], c['via']
    for i, r in enumerate(via):
        legs.append([f'{r}' + (f' to {via[i + 1]}' if i + 1 < len(via) else f' to {en}'), r, [via[i + 1]] if i + 1 < len(via) else []])
    cfg['route_legs'] = legs or [[f'{st} → {en}', ' · '.join(via), []]]
    desc = (f'Route survey for {v["blade"]:.1f} m blades from {st} to {en}: routed and checked from open data only, '
            'every difficult stretch found by the swept-path model, measured against the laser terrain and point clouds and driven in 3D.')
    cfg.setdefault('text', dict(TITLE=f'{st} → {en} Blade Route', H1=f'{st} → {en} blade route', CONVOYS='', START=st, DESC=desc,
                                FROM=f'From {st} to {en}'))
    cfg.setdefault('page_text', dict(dest=en, convoys='', intro=desc, method='The cheapest heavy-transport path on the road graph, chosen among '
                                     f'{len(plan_["candidates"])} candidates by the route planner (driving time plus the challenges found on each).',
                                     overview=desc, vehicle_note=''))
    json.dump(cfg, open(cfgfn, 'w'), ensure_ascii=False, indent=1)


def survey(a):
    root = route_root(a.name); C = os.path.join(root, '.cache', 'route') + '/'
    plan_ = json.load(open(os.path.join(root, 'plan.json')))
    pick = plan_['best'] if a.pick is None else a.pick
    steps = step_list(root, C)
    if a.list:
        for k, what, _ in steps: print(f'{k:14s} {what}' + ('   ✓' if os.path.exists(C + f'stamps/{k}.done') else ''))
        return
    os.makedirs(C + 'stamps', exist_ok=True)
    src = C + f'cand_{pick}.pkl'
    if not os.path.exists(C + 'route.pkl') or open(C + 'route.pkl', 'rb').read() != open(src, 'rb').read():
        import shutil; shutil.copy(src, C + 'route.pkl')
        for f in os.listdir(C + 'stamps'): os.remove(C + 'stamps/' + f)          # another route: everything again
    survey_config(root, plan_, pick)
    keys = [k for k, _, _ in steps]
    start = keys.index(a.from_) if a.from_ else 0
    for k, what, cmds in steps[start:]:
        if a.only and k != a.only: continue
        if os.path.exists(C + f'stamps/{k}.done') and not a.only and not a.from_: continue
        log(f'[{k}] {what}')
        if cmds == 'site': site_step(root, C)
        else:
            for args, env in (cmds() if callable(cmds) else cmds):
                env = dict(env); cwd = env.pop('_cwd', HERE)
                run(args, root, env, log_to=C + f'stamps/{k}.log', cwd=cwd)
        open(C + f'stamps/{k}.done', 'w').write(time.strftime('%Y-%m-%d %H:%M'))
    log('survey done →', root)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest='cmd', required=True)
    p = sp.add_parser('plan'); p.add_argument('name'); p.add_argument('--start', required=True); p.add_argument('--end', required=True)
    p.add_argument('--via', action='append', default=[]); p.add_argument('--alts', type=int, default=4)
    for k in VEH_KEYS: p.add_argument('--' + k, type=float)
    p.add_argument('--weight', type=float, default=72.0, help='gross weight of the convoy (t)')
    p.add_argument('--length', type=float, help='overall length (m); default from the blade')
    p.add_argument('--weights', help='JSON overriding the score weights')
    s = sp.add_parser('survey'); s.add_argument('name'); s.add_argument('--pick', type=int); s.add_argument('--from', dest='from_')
    s.add_argument('--only'); s.add_argument('--list', action='store_true')
    a = ap.parse_args()
    plan(a) if a.cmd == 'plan' else survey(a)


if __name__ == '__main__':
    main()
