"""Road signs along the route, for both directions, from the open map data reachable here:
  - speed limits (Overture segments' speed_limits, from OSM maxspeed): a sign 274 where a limit starts or changes, 278
    where it ends and the general limit applies again (no 274 at a town entrance, where the town sign sets 50 km/h);
  - town entrance / exit signs 310 / 311 where a 50 km/h limit starts / ends among buildings, with the name of the
    nearest locality (Overture divisions);
  - signed height and width limits (corr/limits.json): signs 265 / 264 at the structure;
  - zebra crossings (the map's crossing tags, kept in objects.pkl): sign 350 at both kerbs;
  - guide posts (Leitpfosten, StVO Anlage 4 Nr. 11) every 50 m outside towns, closer in curves (VwV spacing), on both
    edges of a two-way road and on the right edge of a one-way carriageway.
Stop / give-way / bus-stop signs come with the road view's objects (Overture infrastructure). Every other
mapped sign (direction signs, warnings, priority road, no overtaking …) needs OpenStreetMap's traffic_sign nodes: when
overpass-api.de is reachable, fetch_osm() adds every one within 25 m of the route.
→ .cache/route/corr/signs.json: [{s, d (lateral, left +), dir (+1 faces our direction of travel, −1 the opposite),
   code, v (value / text), sp (speed of the traffic approaching it, km/h: sets the size class), src}]
→ .cache/route/corr/speed_1m.npz: f, b — the speed in force per route metre for our direction and the opposite one"""
import routecfg
import os, sys, json, pickle, numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import pyarrow.parquet as pq
from route_corridor import route, OUT

C = routecfg.C


def per_metre_limits(r):
    """maxspeed (km/h, 0 = none mapped) for our direction and the opposite one, per route metre"""
    Ru = pickle.load(open(C + 'route.pkl', 'rb'))
    SL = {}
    for f in ('net_major', 'net_factory', 'net_site'):
        fn = C + f + '.parquet'
        if not os.path.exists(fn): continue
        for row in pq.read_table(fn, columns=['id', 'speed_limits']).to_pylist():
            if row['speed_limits']: SL[row['id']] = row['speed_limits']
    seg = r['SEG']; n = len(seg)
    vf = np.zeros(n, np.int16); vb = np.zeros(n, np.int16)
    # runs of one segment: the fraction along the segment from rec a → b
    i = 0
    while i < n:
        j = i
        while j < n and seg[j] == seg[i]: j += 1
        rec = Ru[seg[i]][0]; a, b = float(rec.get('a', 0.0) or 0.0), float(rec.get('b', 1.0) if rec.get('b') is not None else 1.0)
        fwd = b >= a
        fr = np.linspace(a, b, j - i) if j - i > 1 else np.array([a])
        for rule in SL.get(rec['id'], []):
            ms = (rule.get('max_speed') or {})
            if not ms or ms.get('value') is None: continue
            v = int(ms['value']) if (ms.get('unit') or 'km/h') == 'km/h' else int(round(ms['value'] * 1.609))
            w = rule.get('when') or {}
            if w.get('vehicle') or w.get('during') or w.get('mode') or w.get('using') or w.get('recognized'): continue
            bt = rule.get('between') or [0.0, 1.0]
            m = (fr >= bt[0] - 1e-6) & (fr <= bt[1] + 1e-6)
            hd = w.get('heading')
            ours = hd is None or (hd == 'forward') == fwd
            theirs = hd is None or (hd == 'forward') != fwd
            if ours: vf[i:j][m] = v
            if theirs: vb[i:j][m] = v
        i = j
    return vf, vb


def runs(v, min_len=30):
    """constant stretches of v, the ones shorter than min_len merged into the previous one"""
    out = []; i = 0; n = len(v)
    while i < n:
        j = i
        while j < n and v[j] == v[i]: j += 1
        if out and j - i < min_len: out[-1][1] = j
        elif out and out[-1][2] == v[i]: out[-1][1] = j
        else: out.append([i, j, int(v[i])])
        i = j
    return out


def fetch_osm(P, s, N, step=20000):
    """every mapped traffic_sign node within 25 m of the route (OpenStreetMap via overpass-api.de, when reachable):
    [(i, d, code, value, raw)] — i the route index, d lateral (left +)"""
    import urllib.request, urllib.parse, re
    from pyproj import Transformer
    to_ll = Transformer.from_crs('EPSG:32633', 'EPSG:4326', always_xy=True); to_u = Transformer.from_crs('EPSG:4326', 'EPSG:32633', always_xy=True)
    from scipy.spatial import cKDTree
    kd = cKDTree(P[::2]); out = []
    for a in range(0, len(P), step):
        seg = P[a:a + step + 1:25]
        lo, la = to_ll.transform(seg[:, 0], seg[:, 1])
        q = f'[out:json][timeout:90];node(around:25,{",".join(f"{y:.5f},{x:.5f}" for x, y in zip(lo, la))})["traffic_sign"];out;'
        try:
            req = urllib.request.Request('https://overpass-api.de/api/interpreter', data=urllib.parse.urlencode({'data': q}).encode(), headers={'User-Agent': 'hosskirch-route-survey'})
            js = json.loads(urllib.request.urlopen(req, timeout=120).read())
        except Exception as ex:
            print('OpenStreetMap signs not reachable (overpass-api.de):', repr(ex)[:120]); return None
        for el in js.get('elements', []):
            x, y = to_u.transform(el['lon'], el['lat']); _, k = kd.query((x, y)); i = int(k) * 2
            d = float((x - P[i, 0]) * N[i, 0] + (y - P[i, 1]) * N[i, 1])
            for part in re.split(r'[;,]', el['tags'].get('traffic_sign', '')):
                m = re.match(r'(?:DE:)?(\d{3}(?:\.\d)?)(?:[-\[(]([\d.]+)[\])]?)?', part.strip())
                if m: out.append((i, d, m.group(1), m.group(2), part.strip()))
        print('OSM signs', a // 1000, 'km:', len(out), flush=True)
    return out


# ---------------------------------------------------------------- OpenStreetMap signs (traffic_sign tags, DE and PL)
import re, math
_CODE = re.compile(r'^(?:(DE|PL):)?([0-9]{3,4}(?:\.[0-9]{1,2})?|[A-Z]-[0-9]+[a-z]?)((?:-[0-9]+(?:[.,][0-9]+)?)*)(?:\[([^\]]*)\])?$')
_PL = {'B-33': '274', 'B-34': '278', 'A-7': '205', 'B-20': '206', 'D-1': '306', 'D-2': '307', 'B-1': '250', 'B-2': '267', 'B-25': '276', 'B-26': '277', 'B-27': '280', 'B-28': '281', 'B-18': '262', 'B-16': '265', 'B-15': '264', 'D-6': '350', 'C-12': '215'}
_COMPASS = {'N': 0, 'NNE': 22.5, 'NE': 45, 'ENE': 67.5, 'E': 90, 'ESE': 112.5, 'SE': 135, 'SSE': 157.5, 'S': 180, 'SSW': 202.5, 'SW': 225, 'WSW': 247.5, 'W': 270, 'WNW': 292.5, 'NW': 315, 'NNW': 337.5}


def parse_signs(val, tags):
    """'DE:274[60],1053-33;DE:250' → posts [[(code, value), …], …] (',' adds a plate to its post, ';' starts another)"""
    posts = []
    for grp in str(val).split(';'):
        items = []
        for part in grp.split(','):
            p = part.strip()
            if not p: continue
            if p == 'city_limit': items.append(('city', tags.get('name'))); continue
            if p == 'maxspeed':
                if tags.get('maxspeed', '').isdigit(): items.append(('274', int(tags['maxspeed'])))
                continue
            m = _CODE.match(p)
            if not m: continue
            cc, code, var, br = m.groups()
            vals = [x for x in var.split('-') if x]
            if cc == 'PL' or code[0].isalpha():
                code = _PL.get(code, 'PL:' + code)
            if code in ('274', '278'):
                v = br or (vals[0] if vals else tags.get('maxspeed'))
                try: v = int(float(str(v).replace(',', '.')))
                except (TypeError, ValueError): continue
            elif len(code) == 4 and code.startswith('10'):                     # a plate (Zusatzzeichen): variant, value
                code = code + ('-' + vals[0] if vals else ''); v = br or ('-'.join(vals[1:]) or None)
            else:
                if vals and code not in ('262', '263', '264', '265', '266'): code = code + '-' + vals[0]; vals = vals[1:]
                v = br or ('-'.join(vals) or None)
            items.append((code, v))
        if items: posts.append(items)
    return posts


def osm_signs(nodes, r, L, R, ef, eb, near_b, Ru):
    """the mapped signs as sign entries (as main()'s): facing from direction tags (forward / backward along the road, the
    compass bearing the sign faces) or the side of the road; a sign mapped on the carriageway goes to the kerb on the right
    of the traffic it serves; several signs of one node share a post (plates under their sign). Also the motorway
    kilometre posts (km), speed cameras (cam) and sign gantries (gantry)."""
    P, s, N, seg = r['P'], r['s'], r['N'], r['SEG']; n = len(s)
    fwd = np.array([(float(Ru[k][0].get('b', 1.0) if Ru[k][0].get('b') is not None else 1.0) >= float(Ru[k][0].get('a', 0.0) or 0.0)) for k in range(len(Ru))])[seg]
    bearing = lambda i: math.degrees(math.atan2(N[i, 1], -N[i, 0])) % 360     # direction of travel: t = (ny, -nx)
    out = []; gant = []
    for q in nodes:
        if q['dist'] > 30: continue
        t, i, d = q['tags'], q['i'], q['d']
        onc = -R[i] - 0.5 < d < L[i] + 0.5                                    # on our carriageway
        def facing():
            dv = t.get('traffic_sign:direction') or t.get('direction')
            if dv in ('forward', 'backward') and onc:
                f = 1 if fwd[i] else -1
                return f if dv == 'forward' else -f
            deg = _COMPASS.get(str(dv).upper()) if dv else None
            if deg is None and dv:
                try: deg = float(str(dv).split(';')[0].split('-')[0])
                except ValueError: deg = None
            if deg is not None:
                return 1 if abs(((deg - (bearing(i) + 180)) + 180) % 360 - 180) < 90 else -1
            return 1 if d < 0 else -1
        f = facing()
        urban = near_b[i] >= 6
        def kerb(ff): return -(R[i] + (0.5 if urban else 1.5)) if ff > 0 else L[i] + (0.5 if urban else 1.5)
        dd = kerb(f) if onc else d
        base = dict(s=round(float(s[i]), 1), dir=f)
        hw = t.get('highway')
        if t.get('man_made') == 'gantry':
            if not any(abs(g['s'] - base['s']) < 40 and g['dir'] == f for g in gant):
                g = dict(base, d=round(float(d), 2), code='gantry', v=t.get('traffic_sign'), src='OpenStreetMap gantry ' + str(q['id'])); gant.append(g); out.append(g)
            continue
        if hw == 'milestone' and t.get('distance'):
            try: km = float(str(t['distance']).replace(',', '.'))
            except ValueError: continue
            ff = 1 if d < L[i] + 0.5 else -1
            out.append(dict(base, dir=ff, d=round(float(-(R[i] + 1.2) if onc else d), 2), code='km', v=f'{km:.1f}'.replace('.', ','), src='OpenStreetMap milestone ' + str(q['id']))); continue
        if hw == 'speed_camera':
            out.append(dict(base, d=round(float(kerb(f) if onc else d), 2), code='cam', v=t.get('maxspeed'), src='OpenStreetMap speed camera ' + str(q['id']))); continue
        vals = [t[k] for k in ('traffic_sign', 'traffic_sign:forward', 'traffic_sign:backward') if t.get(k)]
        for k_, val in zip([k for k in ('traffic_sign', 'traffic_sign:forward', 'traffic_sign:backward') if t.get(k)], vals):
            ff = f if k_ == 'traffic_sign' else ((1 if fwd[i] else -1) * (1 if k_.endswith('forward') else -1))
            ddd = kerb(ff) if onc else d
            for pi, post in enumerate(parse_signs(val, t)):
                for code, v in post:
                    if code == 'city':
                        # a town sign is double-sided: the entrance (310) faces the traffic driving into the 50 km/h limit
                        j0, j1 = max(0, i - 60), min(n - 1, i + 60)
                        e = 1 if (ef[j1] <= 50 < ef[j0]) or (not (eb[j0] <= 50 < eb[j1]) and near_b[j1] >= near_b[j0]) else -1
                        out.append(dict(base, dir=e, d=round(float(kerb(e) if onc else ddd), 2), code='310', v=v, post=f"{q['id']}:{pi}", src='OpenStreetMap city_limit ' + str(q['id'])))
                        out.append(dict(base, dir=-e, d=round(float(kerb(e) if onc else ddd), 2), code='311', v=v, post=f"{q['id']}:{pi}b", src='OpenStreetMap city_limit ' + str(q['id'])))
                        continue
                    out.append(dict(base, dir=ff, d=round(float(ddd), 2), code=code, v=v, post=f"{q['id']}:{pi}", src='OpenStreetMap traffic_sign ' + str(q['id'])))
    return out


def main():
    r = route(); P = r['P']; s = r['s']; N = r['N']; n = len(s)
    S1 = np.load(OUT + 'survey_1m.npz')
    L = S1['L'].astype(float); R = S1['R'].astype(float); have = S1['have'].astype(bool)
    L = np.where(have & (L > 1), L, 3.5); R = np.where(have & (R > 1), R, 3.5)
    tw = np.load(OUT + 'lanes_1m.npz')['tw'].astype(bool) if os.path.exists(OUT + 'lanes_1m.npz') else np.ones(n, bool)
    Ru = pickle.load(open(C + 'route.pkl', 'rb'))
    cls = np.array([Ru[k][0]['cls'] for k in range(len(Ru))])[r['SEG']]
    vf, vb = per_metre_limits(r)
    print('limits mapped on', round((vf > 0).mean() * 100), '% of the route')
    # buildings near the route (urban test) and the localities' names
    O = pickle.load(open(OUT + 'objects.pkl', 'rb'))['blocks']
    from scipy.spatial import cKDTree
    cent = []
    for b in O.values():
        for q in b['bld']:
            try: c = q['g'].centroid; cent.append((c.x, c.y))
            except Exception: pass
    cent = np.array(cent) if cent else np.zeros((0, 2))
    kb = cKDTree(cent) if len(cent) else None
    near_b = np.zeros(n, np.int16)
    if kb is not None:
        for i in range(0, n, 10):
            near_b[i:i + 10] = len(kb.query_ball_point(P[i], 60))
    loc = []
    try:
        import overture as ov, pyarrow.compute as pc
        from pyproj import Transformer
        to_ll = Transformer.from_crs('EPSG:32633', 'EPSG:4326', always_xy=True); to_u = Transformer.from_crs('EPSG:4326', 'EPSG:32633', always_xy=True)
        lo, la = to_ll.transform(P[::500, 0], P[::500, 1])
        for k0 in range(0, len(lo), 40):
            bb = (float(lo[k0:k0 + 41].min()) - 0.05, float(la[k0:k0 + 41].min()) - 0.04, float(lo[k0:k0 + 41].max()) + 0.05, float(la[k0:k0 + 41].max()) + 0.04)
            t = ov.query('divisions', 'division', bb, columns=['subtype', 'names', 'geometry'], extra=pc.field('subtype').isin(['locality', 'macrohood', 'neighborhood']))
            from shapely import wkb
            for row in t.to_pylist():
                nm = (row['names'] or {}).get('primary'); g = wkb.loads(row['geometry'])
                if nm and g.geom_type == 'Point': x, y = to_u.transform(g.x, g.y); loc.append((x, y, nm, row['subtype']))
        print('localities', len(loc))
    except Exception as ex:
        print('localities not fetched:', repr(ex)[:160])
    kl = cKDTree(np.array([(a, b) for a, b, _, _ in loc])) if loc else None

    def place_name(i):
        if kl is None: return None
        best = None
        for j in kl.query_ball_point(P[i], 2500):
            x, y, nm, st = loc[j]; d = np.hypot(x - P[i, 0], y - P[i, 1]) + (600 if st != 'locality' else 0)
            if best is None or d < best[0]: best = (d, nm)
        return best[1] if best else None

    signs = []
    def add(i, side, d_dir, code, v=None, src='mapped speed limit'):
        # side +1 = right of the direction it faces; lateral 0.5 m (town) / 1.5 m (rural) beyond the carriageway edge
        urban = near_b[i] >= 6
        if d_dir > 0: d = -(R[i] + (0.5 if urban else 1.5))
        else: d = L[i] + (0.5 if urban else 1.5)
        signs.append(dict(s=round(float(s[i]), 1), d=round(float(d), 2), dir=d_dir, code=code, v=v, src=src))

    def urban_run(a, b): return np.mean(near_b[a:b] >= 6) > 0.35
    for d_dir, v in ((1, vf), (-1, vb)):
        rr = runs(v)
        seq = rr if d_dir > 0 else rr[::-1]
        prev = None
        for a, b, val in seq:
            i = a if d_dir > 0 else b - 1                         # where this stretch begins in the direction of travel
            if prev is None: prev = (a, b, val); continue
            pv = prev[2]
            mot = cls[i] in ('motorway', 'motorway_link')
            if val == pv: prev = (a, b, val); continue
            town_in = val == 50 and pv in (0, 60, 70, 80, 100) and urban_run(a, b) and not mot
            town_out = pv == 50 and val in (0, 60, 70, 80, 100) and urban_run(*prev[:2]) and not mot
            nm = place_name(i) if (town_in or town_out) else None
            if town_in:
                add(i, 1, d_dir, '310', nm, 'town entrance at the start of the 50 km/h limit among buildings (name: nearest locality)')
            else:
                if town_out: add(i, 1, d_dir, '311', nm, 'town exit at the end of the 50 km/h limit (name: nearest locality)')
                if val > 0 and not (town_out and val == 100): add(i, 1, d_dir, '274', val)
                elif val == 0 and pv > 0 and not town_out: add(i, 1, d_dir, '282' if mot else '278', pv)
            prev = (a, b, val)
    # towns whose 50 km/h limit is not mapped (it comes with the town sign): a stretch of 250 m or more between buildings
    # on an ordinary road, with a locality nearby, gets its entrance and exit signs where the buildings begin and end
    have310 = [q['s'] for q in signs if q['code'] in ('310', '311')]
    dense = (near_b >= 6) & ~np.isin(cls, ['motorway', 'motorway_link', 'trunk', 'trunk_link'])
    i = 0; added = 0
    while i < n:
        if not dense[i]: i += 10; continue
        j = i
        while j < n and (dense[j] or (j + 150 < n and dense[j:j + 150].any())): j += 10
        j = min(j, n - 1)
        if s[j] - s[i] >= 250:
            nm = place_name((i + j) // 2)
            if nm:
                a_, b_ = max(0, i - 30), min(n - 1, j + 30)
                for (k_, code_, dd) in ((a_, '310', 1), (b_, '311', 1), (b_, '310', -1), (a_, '311', -1)):
                    if not any(abs(s[k_] - x) < 400 for x in have310): add(k_, 1, dd, code_, nm, 'town sign where the buildings begin / end (name: nearest locality)'); added += 1
        i = j + 10
    print('town signs from the buildings', added)
    # the speed in force per metre and direction: the mapped limit; where none is mapped, 50 among buildings, none on
    # motorways and dual-carriageway trunk roads (stored as 130), else 100. The speed of the traffic approaching a sign
    # sets its size class (VwV-StVO: round 420 / 600 / 750 mm up to 20 / 80 / above; triangles 630 / 900 / 1260 mm
    # below 50 / up to 100 / above): the page reads it as sp, and the local speed (spd) for the map's own signs
    urb = np.convolve((near_b >= 6).astype(float), np.ones(301) / 301, 'same') > 0.5
    fast = np.isin(cls, ['motorway', 'motorway_link']) | (np.isin(cls, ['trunk', 'trunk_link']) & ~tw)
    dflt = np.where(fast, 130, np.where(urb, 50, 100)).astype(np.int16)
    ef = np.where(vf > 0, vf, dflt); eb = np.where(vb > 0, vb, dflt)
    np.savez_compressed(OUT + 'speed_1m.npz', f=np.clip(ef, 0, 255).astype(np.uint8), b=np.clip(eb, 0, 255).astype(np.uint8))
    # height / width limits
    lim = json.load(open(OUT + 'limits.json')) if os.path.exists(OUT + 'limits.json') else []
    for q in (lim if isinstance(lim, list) else lim.get('limits', [])):
        sq = q.get('s');
        if sq is None: continue
        i = int(np.clip(np.searchsorted(s, sq), 0, n - 1))
        h = q.get('maxheight', q.get('value'))
        if h: add(max(0, i - 3), 1, 1, '265', h, 'mapped height limit'); add(min(n - 1, i + int(q.get('len', 6)) + 3), 1, -1, '265', h, 'mapped height limit')
        if q.get('maxwidth'): add(max(0, i - 3), 1, 1, '264', q['maxwidth'], 'mapped width limit')
    # zebra crossings (Fußgängerüberweg) on the route, from the map's crossing tags: Z 350 at both kerbs (one-way roads: the
    # right one), each facing the traffic that has it on its right. Signal-controlled, unmarked and dashed crossings have none,
    # nor does a crossing where more than 50 km/h applies (no zebra crossings there: an island crossing tagged as one)
    def zebra(t):
        c, m = t.get('crossing'), t.get('crossing:markings')
        if c == 'traffic_signals' or t.get('crossing:signals') == 'yes': return False
        if 'zebra' in (c, m, t.get('crossing_ref')): return True
        if m and m != 'yes': return False
        return c in ('uncontrolled', 'marked') or m == 'yes'
    kr = cKDTree(P[::2]); zc = 0
    for b in O.values():
        for o in b['pts']:
            if o['cls'] != 'crossing' or not zebra(o.get('tags') or {}): continue
            i = int(kr.query(o['xy'])[1]) * 2
            lat = (o['xy'][0] - P[i, 0]) * N[i, 0] + (o['xy'][1] - P[i, 1]) * N[i, 1]
            if not -R[i] - 1.5 <= lat <= L[i] + 1.5: continue                # a side road's crossing
            if min(ef[i], eb[i]) > 50: continue                                # zebra crossings only up to 50 km/h (R-FGÜ)
            add(i, 1, 1, '350', None, 'zebra crossing (map: crossing tags)')
            if tw[i]: add(i, 1, -1, '350', None, 'zebra crossing (map: crossing tags)')
            zc += 1
    print('zebra crossings on the route', zc)
    # guide posts: rural roads (not among buildings), every 50 m, closer in curves; both edges on two-way roads
    Rc = r['R']
    spacing = lambda rc: 50 if rc >= 600 else 30 if rc >= 300 else 20 if rc >= 200 else 15 if rc >= 100 else 10 if rc >= 50 else 6
    i = 0; posts = 0
    while i < n:
        urban = near_b[i] >= 6
        if not urban and have[i] and cls[i] not in ('service', 'track', 'residential', 'living_street'):
            for sd in ((1, -1) if tw[i] else (1,)):
                d = -(R[i] + 0.5) if sd > 0 else (L[i] + 0.5)
                signs.append(dict(s=round(float(s[i]), 1), d=round(float(d), 2), dir=sd, code='620', v=None, src='standard equipment (StVO Anlage 4 Nr. 11)'))
                posts += 1
        i += spacing(float(Rc[i]) if np.isfinite(Rc[i]) else 1e4)
    # every mapped sign from OpenStreetMap: the planet extract (osm_planet_signs.py → osm_nodes.pkl), else overpass-api.de
    # when reachable. Mapped speed-limit and town signs replace inferred ones of the same kind and direction within 250 m
    osm = None
    if os.path.exists(OUT + 'osm_nodes.pkl'):
        osm = osm_signs(pickle.load(open(OUT + 'osm_nodes.pkl', 'rb')), r, L, R, ef, eb, near_b, Ru)
    elif os.environ.get('OSM_SIGNS', '1') == '1':
        raw = fetch_osm(P, s, N)
        if raw: osm = [dict(s=round(float(s[i]), 1), d=round(d, 2), dir=1 if d < 0 else -1, code=code, v=(int(float(v)) if v and code in ('274', '278') else v),
                            src='OpenStreetMap traffic_sign ' + raw_) for i, d, code, v, raw_ in raw]
    if osm:
        fam = lambda c: '310' if c in ('310', '311') else c
        keyed = {}
        for q in osm: keyed.setdefault((fam(q['code']), q['dir']), []).append(q['s'])
        before = len(signs)
        signs = [q for q in signs if q['code'] not in ('274', '278', '282', '310', '311') or not any(abs(q['s'] - x) < 250 for x in keyed.get((fam(q['code']), q['dir']), []))]
        print('inferred signs replaced by mapped ones:', before - len(signs), '; mapped signs:', len(osm))
        signs += osm
    for q in signs:
        if q['code'] == '620': continue
        i = int(np.clip(np.searchsorted(s, q['s']), 0, n - 1))
        q['sp'] = int(ef[max(0, i - 8)] if q['dir'] > 0 else eb[min(n - 1, i + 8)])
    signs.sort(key=lambda q: q['s'])
    cnt = {}
    for q in signs: cnt[q['code']] = cnt.get(q['code'], 0) + 1
    print('signs', cnt)
    json.dump(signs, open(OUT + 'signs.json', 'w'), separators=(',', ':'))


if __name__ == '__main__':
    main()
