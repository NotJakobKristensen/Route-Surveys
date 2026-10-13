"""Survey-point detail for the page (fetched when a survey point is opened) → windpark-hosskirch/dist/h/<id>.bin
Layout as the road packs: u32 header length, header JSON, u32 blob length, raw-deflated typed arrays, then WebP tiles.
Contents (local frame of the survey point): aerial photo tiles (0.25 m near the path, 1 m around), the laser terrain
(DGM1) on a grid, LoD2 buildings (roof and wall triangles), trees from the surface model (top, height, crown radius,
colour from the photo), the paved carriageway traced on the photo (outline rings); in the header the bridges, signs, speeds
and the tunnels / covered sections on the path (tun: the road's profile through them — the grid keeps their lid)."""
import routecfg
import os, sys, json, zlib, struct, pickle, math
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import hd_hot
from hd_sources import sample_source

C = routecfg.C
DIST = os.environ.get('PACK_OUT') or routecfg.DIST + 'h'; os.makedirs(DIST, exist_ok=True)


def tri_ring(ring):
    """triangulate a planar 3D ring (fan after projecting onto its best plane; rings from LoD2 are simple)"""
    from shapely.geometry import Polygon
    from shapely.ops import triangulate
    P = np.asarray(ring, float)
    if len(P) > 3 and np.allclose(P[0], P[-1]): P = P[:-1]
    if len(P) < 3: return []
    c = P.mean(0); U, S, Vt = np.linalg.svd(P - c); e1, e2 = Vt[0], Vt[1]
    q = np.c_[(P - c) @ e1, (P - c) @ e2]
    poly = Polygon(q)
    if not poly.is_valid: poly = poly.buffer(0)
    if poly.is_empty or poly.area < 0.05: return []
    out = []
    for t in triangulate(poly):
        if not poly.buffer(1e-6).contains(t.centroid): continue
        for x, y in list(t.exterior.coords)[:3]:
            out.append(c + e1 * x + e2 * y)
    return out


def build(hid):
    D = pickle.load(open(C + 'hot/' + hid + '.pkl', 'rb'))
    hd = D.get('hd') or {}
    reg = hd_hot.region(hid)
    if reg not in hd_hot.HD_SET: return None
    proj, ext, P = D['proj'], D['ext'], D['P']
    arrays = []
    def add(n, a): arrays.append((n, np.ascontiguousarray(a)))
    # terrain grid
    span = max(ext[2] - ext[0], ext[3] - ext[1]); step = max(4.0, round(span / 520))
    x0, y0 = math.floor(ext[0] / step) * step, math.floor(ext[1] / step) * step
    nx, ny = int(math.ceil((ext[2] - x0) / step)) + 1, int(math.ceil((ext[3] - y0) / step)) + 1
    X, Y = np.meshgrid(x0 + np.arange(nx) * step, y0 + np.arange(ny) * step)
    Z = hd_hot.sample_dgm(reg, proj, X, Y)
    Z = np.where(np.isfinite(Z), Z, np.nanmean(Z))
    Z = tube_ground(D, X, Y, Z)
    zb = float(np.floor(Z.min()))
    add('dgm', np.round((Z - zb) * 20).astype(np.uint16))
    # buildings
    tri_r, tri_w, bid = [], [], []
    lod = hd.get('lod2') or []
    for k, b in enumerate(lod):
        for ring in b['roof']:
            for v in tri_ring(ring): tri_r.append(v)
        for ring in b['wall']:
            for v in tri_ring(ring): tri_w.append(v)
    tr = np.array(tri_r, np.float32).reshape(-1, 3); tw = np.array(tri_w, np.float32).reshape(-1, 3)
    tr[:, 2] -= zb; tw[:, 2] -= zb
    add('roof', tr); add('wall', tw)
    # trees with the colour of their crown on the photo
    T = hd.get('trees')
    if T is not None and len(T):
        T = T[(T[:, 0] > ext[0]) & (T[:, 0] < ext[2]) & (T[:, 1] > ext[1]) & (T[:, 1] < ext[3])]
        T = T[~in_tube(D, T[:, 0], T[:, 1], 2.0, 1.0)]                 # (a roof or the lid over a tube: no tree there)
        col = sample_source(reg, T[:, 0][None], T[:, 1][None], crs_in=proj, res_m=1.0)[0]
        add('tree', T.astype(np.float32)); add('treec', col.astype(np.uint8))
    else:
        add('tree', np.zeros((0, 4), np.float32)); add('treec', np.zeros((0, 3), np.uint8))
    # paved outline (bridged under the decks over the passage, smoothed, kept to the mapped roads' corridor)
    bridges = hd_bridges(hid, D)
    pv = paved_outline(D, hd.get('paved_photo'), bridges)
    rings = []
    if pv is not None and not pv.is_empty:
        for g in getattr(pv, 'geoms', [pv]):
            if g.geom_type != 'Polygon' or g.area < 30: continue
            rings.append(np.asarray(g.exterior.coords)[:, :2])
            for it in g.interiors:
                if __import__('shapely').geometry.Polygon(it).area > 15: rings.append(np.asarray(it.coords)[:, :2])
    add('pv_n', np.array([len(r) for r in rings], np.uint32))
    add('pv_xy', (np.concatenate(rings) if rings else np.zeros((0, 2))).astype(np.float32))
    blob = b''; meta = []
    for name, a in arrays:
        blob += b'\0' * ((-len(blob)) % 8)
        meta.append(dict(n=name, t=a.dtype.str, o=len(blob), l=int(a.size), sh=list(a.shape)))
        blob += a.tobytes()
    comp = zlib.compress(blob, 9)[2:-4]
    import base64, io
    from PIL import Image
    tiles = hd_hot.photo_tiles(hid, P, proj, ext)
    # two atlases: the 0.25 m tiles (1024 px) and the 1 m tiles (256 px), 8 per row
    tl = []; out_bytes = 0
    for kind, sel, px_ in (('n', [t for t in tiles if t['px'] < 0.5], 1024), ('f', [t for t in tiles if t['px'] >= 0.5], 256)):
        if not sel: continue
        cols = min(8, len(sel)); rows = int(math.ceil(len(sel) / cols))
        A = Image.new('RGB', (cols * px_, rows * px_))
        for k, t in enumerate(sel):
            im = Image.open(io.BytesIO(t['webp'])).convert('RGB')
            if im.width != px_: im = im.resize((px_, px_))
            A.paste(im, ((k % cols) * px_, (k // cols) * px_))
            tl.append(dict(x0=t['x0'], y0=t['y0'], size=t['size'], px=t['px'], a=kind, ax=(k % cols) * px_, ay=(k // cols) * px_, n=px_))
        bb = io.BytesIO(); A.save(bb, 'WEBP', quality=66 if kind == 'n' else 60, method=6)
        open(os.path.join(DIST, f'{hid}_{kind}.webp'), 'wb').write(bb.getvalue()); out_bytes += len(bb.getvalue())
    from hd_sources import SOURCES
    hdr = dict(id=hid, region=reg, grid=dict(x0=x0, y0=y0, nx=nx, ny=ny, step=step, zb=zb, q=0.05), tiles=tl, arrays=meta,
               nbld=len(lod), ntree=0 if T is None else int(len(T)),
               credit=SOURCES[reg]['credit'] + {'DE-BW': '; DGM1, nDOM, LoD2: LGL (dl-de/by-2-0)', 'DE-BY': '; DGM1, DOM20, LoD2: Bayerische Vermessungsverwaltung (CC BY 4.0)', 'PL-32': '; NMT / NMPT (lidar 2022/2024): GUGiK', 'DE-BB': '; DGM1, bDOM: GeoBasis-DE/LGB (dl-de/by-2-0)', 'DE-MV': '; DGM1, DOM1: GeoBasis-DE/M-V (CC BY 4.0)', 'DE-ST': '; DGM1, DOM1: GeoBasis-DE/LVermGeo LSA (dl-de/by-2-0)'}[reg],
               bridges=bridges, signs=hd_signs(D), spd=hd_speeds(D), tun=hd_tunnels(D), blob=base64.b64encode(comp).decode())
    open(os.path.join(DIST, f'{hid}.json'), 'w').write(json.dumps(hdr, separators=(',', ':')))
    return len(comp) + out_bytes


DRIVE_X = ('footway', 'path', 'steps', 'cycleway', 'pedestrian', 'bridleway')


def paved_outline(D, pv, bridges):
    """the carriageway traced on the photo as the page draws it (asphalt and markings on it):
    1. under the decks over the passage the photo shows the deck, and the trace stopped at its edges (a jagged gap across the
       road): each mapped road crossing a deck's footprint (its edges + 1 m) is bridged straight across it between the
       traced carriageway's first cross-sections 1.5–17.5 m beyond the footprint on either side (as route_pack.py does for
       tunnels);
    2. smoothed: closed and opened by 0.75 m (notches, spurs and the pixel steps of the trace), holes under 15 m² filled,
       simplified to 0.3 m;
    3. kept to the corridor of the mapped roads (their typical half-width × 1.4 + 1 m, at least + 1.5 m) and of the path
       (its half-width + 2 m): shadows, verges and yards read as paved on the photo are left out."""
    from shapely.geometry import LineString, Polygon, Point
    from shapely.ops import unary_union
    if pv is None or pv.is_empty: return pv
    from route_swept import half_width
    g = pv.buffer(0)
    roads = [r for r in D['roads'] if r.get('sub_t') == 'road' and r.get('cls') not in DRIVE_X and len(r['xy']) >= 2]
    lines = [(LineString(np.asarray(r['xy'])[:, :2]), half_width(r['cls'], r['sub']), r) for r in roads]
    # 1. across the decks over the passage (twice: decks side by side, the second bridged across the first one's fill)
    for _pass in range(2):
        fills = []
        for b in bridges or []:
            hw = max(1.8, float(b.get('w') or 0) / 2)
            for pt in b['parts']:
                if pt.get('carries'): continue
                xy = np.asarray(pt['xy'], float).reshape(-1, 2)
                if len(xy) < 2: continue
                foot = LineString(xy).buffer(hw + 1.0, cap_style=2)
                if foot.distance(g) > 17: continue                         # (no trace near: nothing to bridge)
                near = foot.buffer(1.5)
                for ln, rhw, r in lines:
                    if not ln.intersects(foot): continue
                    piece = ln.intersection(near)
                    # (the deck's own way, a way in a tube: flagged so where it crosses the footprint — the flags may hold for a
                    # part of the way only, 'between' fractions along it)
                    fm = ln.project(piece.centroid, normalized=True) if not piece.is_empty else 0.5
                    if any(({'is_bridge', 'is_tunnel'} & set(f.get('values') or [])) and (not f.get('between') or f['between'][0] - 0.01 <= fm <= f['between'][1] + 0.01)
                           for f in (r.get('flags') or [])): continue
                    for pc in getattr(piece, 'geoms', [piece]):
                        if pc.geom_type != 'LineString' or pc.length < 2: continue
                        P = np.asarray(pc.coords)[:, :2]; t = P[-1] - P[0]; tl = np.hypot(*t)
                        if tl < 2: continue
                        t /= tl; n = np.array([-t[1], t[0]]); sec = []
                        # (the trace may stop a few metres short of the footprint: the deck's image on the photo is displaced
                        # by its height, its shadow beside it, and it breaks up there) — the cross-sections within 16 m on which
                        # the traced carriageway covers 40 % of the mapped width, its extent within the road's corridor
                        wl = 1.4 * rhw + 2.0
                        for E0, sg in ((P[0], -1), (P[-1], 1)):
                            ok_ = []
                            for o in range(0, 17, 2):
                                E = E0 + t * sg * o
                                cut = LineString([E - n * wl, E + n * wl]).intersection(g)
                                us = [((np.asarray(c.coords)[:, :2] - E) @ n) for c in getattr(cut, 'geoms', [cut]) if c.geom_type == 'LineString' and not c.is_empty]
                                if us and sum(u.max() - u.min() for u in us) >= 0.8 * rhw: ok_.append((E, min(u.min() for u in us), max(u.max() for u in us)))
                            if not ok_: break
                            # (at the first of them, as wide as the carriageway is on any of them: it breaks up near the deck)
                            E = ok_[0][0]; sec.append((E + n * min(q[1] for q in ok_), E + n * max(q[2] for q in ok_)))
                        if len(sec) < 2: continue
                        (a0, a1), (b0, b1) = sec
                        if not (0.4 < np.hypot(*(a1 - a0)) / max(0.5, np.hypot(*(b1 - b0))) < 2.5): continue     # (a junction on one side)
                        q = Polygon([a0, a1, b1, b0]).buffer(0)
                        if not q.is_empty and q.area < 3 * (hw * 2 + 40) * max(np.hypot(*(a1 - a0)), np.hypot(*(b1 - b0))): fills.append(q)
        if fills: g = unary_union([g] + fills).buffer(0)
    # 2. smoothed
    g = g.buffer(0.75, join_style=1).buffer(-1.5, join_style=1).buffer(0.75, join_style=1)
    polys = []
    for p in getattr(g, 'geoms', [g]):
        if p.geom_type != 'Polygon' or p.is_empty: continue
        polys.append(Polygon(p.exterior, [it for it in p.interiors if Polygon(it).area >= 15]))
    g = unary_union(polys) if polys else g
    # 3. kept to the corridor
    corr = [ln.buffer(max(rhw + 1.5, 1.4 * rhw + 1.0)) for ln, rhw, r in lines]
    PP = np.asarray(D['P'])[:, :2]; HW = np.asarray(D.get('HW') if D.get('HW') is not None else np.full(len(PP), 5.0), float).ravel()
    for k in range(0, len(PP) - 1, 10):
        seg = PP[k:k + 11]
        if len(seg) >= 2: corr.append(LineString(seg).buffer(float(np.nanmax(HW[k:k + 11])) + 2.0))
    if corr: g = g.intersection(unary_union(corr)).buffer(0)
    return g.simplify(0.3, preserve_topology=True)


def hd_bridges(hid, D):
    """every bridge in the survey area (local frame): centreline, width, surface and terrain along it (m above the datum),
    and whether the route itself runs on it (then the convoy rides on the deck)"""
    from pyproj import Transformer
    from shapely.geometry import LineString
    fn = os.path.join(C, 'corr', 'bridges.pkl')
    if not os.path.exists(fn): return []
    B = pickle.load(open(fn, 'rb'))
    tr = Transformer.from_crs('EPSG:32633', D['proj'], always_xy=True)
    ext = D['ext']; PP = np.asarray(D['P'])[:, :2]; path = LineString(PP)
    # crossings above the route first (also when not flagged as bridge), with their clear height as the road view has it
    # (route_pack.overs: signed limits, the route's own bridges told apart); a crossing under the route's own bridge is left
    # to the area's bridge list (no clear height for it)
    import route_pack as RP
    from route_corridor import load_clear
    global _OVR
    if '_OVR' not in globals() or _OVR is None:
        over = sorted([o for b_ in pickle.load(open(os.path.join(C, 'corr', 'objects.pkl'), 'rb'))['blocks'].values() for o in b_['over']], key=lambda o: o['s'])
        _OVR = {}
        for r_ in RP.overs(over, 0, 1e9, 0.0, 0.0):
            for s0 in r_.get('s0s', [r_.get('s0')]):
                if s0 is not None: _OVR[round(s0)] = r_
    recs = []
    for b in B['over'].values():
        x, y = tr.transform(*b['xy'])
        if not (ext[0] <= x <= ext[2] and ext[1] <= y <= ext[3]): continue
        r_ = _OVR.get(round(b['s0'])) or {}
        if (r_.get('note') or '').startswith(('the route crosses', 'measured top only')): continue
        clr = {k: round(float(r_[k]), 2) for k in ('est', 'unc', 'top', 'signed') if r_.get(k) is not None}
        recs.append(dict(b, utm=True, clr=clr))
    recs += list(B['hot'].get(hid, []))
    out, seen = [], []
    for b in recs:
        parts = []
        for pt in b['parts']:
            L = np.asarray(pt['line'], float)
            if len(L) < 2: continue
            X, Y = tr.transform(L[:, 0], L[:, 1]); Lx = np.c_[X, Y]
            inside = (Lx[:, 0] > ext[0]) & (Lx[:, 0] < ext[2]) & (Lx[:, 1] > ext[1]) & (Lx[:, 1] < ext[3])
            if inside.sum() < 2: continue
            c = Lx[len(Lx) // 2]
            if any(np.hypot(*(c - q)) < 3 for q in seen): continue           # the same deck from both sources
            seen.append(c)
            near = np.array([path.distance(__import__('shapely').geometry.Point(p)) < 5 for p in Lx])
            # the route rides on it where half the part, or 20 m of it, runs along the path (the view checks the approaches),
            # or where it runs along the path's first or last 20 m (the passage ends on the route's own bridge)
            car = near.mean() > 0.5 or near.sum() * 2.0 >= 20
            if not car and not b.get('utm') and len(Lx) >= 2:
                from shapely.geometry import Point as _Pt
                bl = LineString(Lx)
                for E in (PP[:21], PP[-21:]):
                    if len(E) < 2: continue
                    # (the part's line within 5 m of the end for 4 m or more — a long deck's vertices may all lie beyond it —
                    # and running along it)
                    if LineString(E).intersection(bl.buffer(5)).length < 4: continue
                    pa, pb = bl.interpolate(bl.project(_Pt(E[0]))), bl.interpolate(bl.project(_Pt(E[-1])))
                    v1 = np.array([pb.x - pa.x, pb.y - pa.y]); v2 = E[-1] - E[0]
                    if np.linalg.norm(v1) > 1 and abs(np.dot(v1, v2)) / (np.linalg.norm(v1) * np.linalg.norm(v2) + 1e-9) > 0.9: car = True
            d = dict(xy=[round(float(v), 1) for v in Lx.ravel()], carries=bool(not b.get('utm') and car))    # (a crossing over the route never)
            if pt['S'] is not None and np.isfinite(pt['S']).any():
                d.update(S=[round(float(v), 2) for v in np.nan_to_num(pt['S'], nan=-999)], T=[round(float(v), 2) for v in np.nan_to_num(pt['T'], nan=-999)])
            parts.append(d)
        if parts: out.append(dict(cls=b['cls'], sub=b['sub'], name=b['name'], w=round(b['width'], 1), lv=b.get('level', 0), parts=parts, **({'clr': b['clr']} if 'clr' in b else {})))
    return out


_SG = None


def _sg():
    """the route and its signs (route_signs.py), loaded once"""
    global _SG
    if _SG is None:
        from route_corridor import route as _route
        r = _route(); _SG = (r, json.load(open(C + 'corr/signs.json')) if os.path.exists(C + 'corr/signs.json') else [])
    return _SG


def hd_signs(D):
    """the route's signs (route_signs.py) in the passage's local frame: [x, y, fx, fy (face normal), code, v] plus, except
    on guide posts, the approach speed (sets the size class)"""
    r, signs = _sg()
    sm = D['summary']; a, b = sm['km'][0] * 1000 - 150, sm['km'][1] * 1000 + 60
    from pyproj import Transformer
    fw = Transformer.from_crs('EPSG:32633', D['proj'], always_xy=True)
    out = []
    for q in signs:
        if not (a <= q['s'] <= b): continue
        i = int(np.clip(np.searchsorted(r['s'], q['s']), 1, len(r['s']) - 2))
        n_ = r['N'][i]; t_ = np.array([n_[1], -n_[0]])
        x, y = r['P'][i] + n_ * q['d']
        f = -t_ * q['dir']                                       # the face looks at the traffic it serves
        (lx, ly), (lx2, ly2) = fw.transform([x, x + f[0]], [y, y + f[1]])
        fl = math.hypot(lx2 - lx, ly2 - ly) or 1
        out.append([round(lx, 2), round(ly, 2), round((lx2 - lx) / fl, 3), round((ly2 - ly) / fl, 3), q['code'], q['v']] + ([q['sp']] if 'sp' in q else []))
    return out


_TF = {}


def _tube_frame(D):
    """the tunnels, covered sections and wildlife overpasses near the passage (tunnels.json, not underbridge) and the route's
    samples around them in the passage's frame: (items, route, a, Q (xy), Nl (left normals), kd) — None where none"""
    key = (D['summary'].get('id'), D['proj'])
    if key in _TF: return _TF[key]
    fn = os.path.join(C, 'corr', 'tunnels.json'); out = None
    if os.path.exists(fn):
        sm = D['summary']; a_, b_ = sm['km'][0] * 1000 - 400, sm['km'][1] * 1000 + 400
        T = [t for t in json.load(open(fn))['items'] if t['kind'] != 'underbridge' and t['s1'] >= a_ and t['s0'] <= b_]
        if T:
            from pyproj import Transformer
            from scipy.spatial import cKDTree
            r = _sg()[0]; a, b = int(np.searchsorted(r['s'], a_)), int(np.searchsorted(r['s'], b_))
            fw = Transformer.from_crs('EPSG:32633', D['proj'], always_xy=True)
            x, y = fw.transform(r['P'][a:b, 0], r['P'][a:b, 1]); x1, y1 = fw.transform(r['P'][a:b, 0] + r['N'][a:b, 0], r['P'][a:b, 1] + r['N'][a:b, 1])
            Q = np.c_[x, y]; out = (T, r, a, Q, np.c_[np.asarray(x1) - x, np.asarray(y1) - y], cKDTree(Q))
    _TF[key] = out
    return out


def _at_route(F, X, Y):
    """route distance s and lateral offset d (left +) of local points X, Y (any shape)"""
    T, r, a, Q, Nl, kd = F
    p = np.c_[np.ravel(X), np.ravel(Y)]; _, k = kd.query(p)
    return r['s'][a + k].reshape(np.shape(X)), ((p - Q[k]) * Nl[k]).sum(1).reshape(np.shape(X)), (a + k).reshape(np.shape(X))


def _walls(t):
    w = lambda v, dflt: float(np.mean(v)) if isinstance(v, list) else (v if v is not None else dflt)
    return w(t.get('dl'), 7.5), w(t.get('dr'), -7.5)


def in_tube(D, X, Y, ms=0.0, md=0.0):
    """which local points lie over a tube (its walls ± md, its portals ± ms)"""
    F = _tube_frame(D); out = np.zeros(np.shape(X), bool)
    if F is None or not np.size(X): return out
    sp, dd, _ = _at_route(F, X, Y)
    for t in F[0]:
        dl, dr = _walls(t); out |= (sp >= t['s0'] - ms) & (sp <= t['s1'] + ms) & (dd <= dl + md) & (dd >= dr - md)
    return out


def tube_ground(D, X, Y, Z):
    """the terrain grid (absolute heights) over and at the tubes: over a tube (walls ± 0.5 m) the lid of tunnels.json (the
    terrain model leaves out a roof — the solar panels over the Bayreuth enclosure — and lies on the road there), at least the
    road + the clear height drawn + 0.65 m; on the carriageway 8 m before a portal and after one (up to 50 m, to the
    route's next bridge) the fitted road (route_vprof.py), where the grid mixes in the lid or lies under a deck the terrain
    model leaves out"""
    F = _tube_frame(D)
    if F is None: return Z
    vf = os.path.join(C, 'corr', 'vprof.npz')
    if not os.path.exists(vf): return Z
    V = np.load(vf); Z = Z.copy(); sp, dd, kk = _at_route(F, X, Y); r = F[1]
    zr = V['z1'][kk].astype(float); road = zr + V['q1'][kk].astype(float) * dd
    BR = pickle.load(open(os.path.join(C, 'corr', 'bridges.pkl'), 'rb'))['route'] if os.path.exists(os.path.join(C, 'corr', 'bridges.pkl')) else []
    for t in F[0]:
        dl, dr = _walls(t); H = t.get('H') or t.get('std') or 4.5
        tube = (sp >= t['s0']) & (sp <= t['s1']) & (dd <= dl + 0.5) & (dd >= dr - 0.5)
        L = t.get('lid')
        if L and L.get('rel'):
            rel = np.asarray(L['rel'], float) / 100; Dl = np.asarray(L['D'], float)
            fr = np.clip((sp - L['s0']) / L.get('step', 4), 0, len(rel) - 1); r0 = np.floor(fr).astype(int); r1 = np.minimum(r0 + 1, len(rel) - 1); w = fr - r0
            ci = np.clip(np.searchsorted(Dl, dd) - 1, 0, len(Dl) - 2); u = np.clip((dd - Dl[ci]) / (Dl[ci + 1] - Dl[ci]), 0, 1)
            lv = lambda rr: rel[rr, ci] + (rel[rr, ci + 1] - rel[rr, ci]) * u
            lid = zr + lv(r0) * (1 - w) + lv(r1) * w
        else: lid = road + H + 1.2
        Z = np.where(tube, np.maximum(np.maximum(Z, lid), road + H + 0.65), Z)
        cw = (dd <= dl) & (dd >= dr)
        nxt = min([b['s0'] for b in BR if b['s0'] >= t['s1']] + [t['s1'] + 50.0])
        app = cw & (((sp >= t['s0'] - 8) & (sp < t['s0'])) | ((sp > t['s1']) & (sp <= min(nxt, t['s1'] + 50))))
        Z = np.where(app & (np.abs(Z - road) > 0.3), road, Z)
    return Z


def hd_tunnels(D):
    """the tunnels, covered sections and wildlife overpasses on the passage (route_tunnels.py): the path samples i0..i1 they
    cover (the path every 2 m, as the page has it), the road's height under each in the passage's heights (the fitted road
    of route_vprof.py — height and cross slope at the path's offset; the item's own profile without it), the tube walls
    from the path (dl > 0 > dr), the clear height drawn (H) and the record's clear-height fields; [] where none"""
    fn = os.path.join(C, 'corr', 'tunnels.json')
    if not os.path.exists(fn): return []
    T = [t for t in json.load(open(fn))['items'] if t['kind'] != 'underbridge']
    sm = D['summary']; a_, b_ = sm['km'][0] * 1000 - 200, sm['km'][1] * 1000 + 200
    T = [t for t in T if t['s1'] >= a_ and t['s0'] <= b_]
    if not T: return []
    from pyproj import Transformer
    from scipy.spatial import cKDTree
    r = _sg()[0]; a, b = int(np.searchsorted(r['s'], a_)), int(np.searchsorted(r['s'], b_))
    fw = Transformer.from_crs('EPSG:32633', D['proj'], always_xy=True)
    x, y = fw.transform(r['P'][a:b, 0], r['P'][a:b, 1]); x1, y1 = fw.transform(r['P'][a:b, 0] + r['N'][a:b, 0], r['P'][a:b, 1] + r['N'][a:b, 1])
    Q = np.c_[x, y]; Nl = np.c_[np.asarray(x1) - x, np.asarray(y1) - y]
    Pp = np.asarray(D['P'])[::2, :2]
    _, k = cKDTree(Q).query(Pp); sp = r['s'][a + k]; d = ((Pp - Q[k]) * Nl[k]).sum(1)
    vf = os.path.join(C, 'corr', 'vprof.npz'); V = np.load(vf) if os.path.exists(vf) else None
    wall = lambda v: float(np.mean(v)) if isinstance(v, list) else v
    out = []
    for t in T:
        i = np.flatnonzero((sp >= t['s0']) & (sp <= t['s1']))
        if len(i) < 2: continue
        i0, i1 = int(i[0]), int(i[-1]); kk = a + k[i0:i1 + 1]; dd = d[i0:i1 + 1]
        if V is not None: z = V['z1'][kk].astype(float) + V['q1'][kk].astype(float) * dd
        else: pr = np.asarray(t['prof'], float); z = np.interp(sp[i0:i1 + 1], pr[:, 0], pr[:, 1])
        o = float(np.median(dd))                                      # (the walls as offsets from the path)
        rec = dict(i0=i0, i1=i1, kind=t['kind'], name=t.get('name'), len=t.get('len'), H=t.get('H'), std=t.get('std'), est=t.get('est'), unc=t.get('unc'),
                   signed=t.get('signed'), phys=t.get('phys'), check=t.get('signed') is None and t.get('phys') is None,
                   dl=round(wall(t['dl']) - o, 2) if t.get('dl') is not None else None, dr=round(wall(t['dr']) - o, 2) if t.get('dr') is not None else None,
                   prof=[round(float(v), 2) for v in z])
        if V is not None:
            # the road just outside the portals (the DGM grid there mixes in the lid): pre for the path samples up to 10 m
            # before i0, post up to 10 m after i1 — and on through a bridge of the route's own that starts within 50 m of
            # the portal (the grid under its deck is the valley floor; at most 40 samples, cut at the path's ends)
            BRr = pickle.load(open(os.path.join(C, 'corr', 'bridges.pkl'), 'rb'))['route'] if os.path.exists(os.path.join(C, 'corr', 'bridges.pkl')) else []
            post_lim = max([t['s1'] + 10] + [b_['s1'] + 5 for b_ in BRr if t['s1'] - 5 <= b_['s0'] <= t['s1'] + 50])
            pre_lim = min([t['s0'] - 10] + [b_['s0'] - 5 for b_ in BRr if t['s0'] - 50 <= b_['s1'] <= t['s0'] + 5])
            jpost = []
            for j in range(i1 + 1, min(len(Pp), i1 + 41)):
                if sp[j] > post_lim: break
                jpost.append(j)
            jpre = []
            for j in range(i0 - 1, max(-1, i0 - 41), -1):
                if sp[j] < pre_lim: break
                jpre.insert(0, j)
            for key, jj in (('pre', jpre), ('post', jpost)):
                jj = np.asarray(jj, int)
                if len(jj): rec[key] = [round(float(v), 2) for v in V['z1'][a + k[jj]].astype(float) + V['q1'][a + k[jj]].astype(float) * d[jj]]
        out.append(rec)
    return out


def hd_speeds(D):
    """the speed in force along the passage every 10 m, in its local frame: [[x, y, ours, opposite], …] (km/h) — sizes
    the map's own stop, give-way, bus-stop and crossing signs"""
    if not os.path.exists(C + 'corr/speed_1m.npz'): return []
    r = _sg()[0]; Z = np.load(C + 'corr/speed_1m.npz')
    sm = D['summary']; a, b = sm['km'][0] * 1000 - 400, sm['km'][1] * 1000 + 400
    from pyproj import Transformer
    fw = Transformer.from_crs('EPSG:32633', D['proj'], always_xy=True)
    k = np.arange(int(np.searchsorted(r['s'], a)), int(np.searchsorted(r['s'], b)), 10)
    lx, ly = fw.transform(r['P'][k, 0], r['P'][k, 1])
    return [[round(float(x), 1), round(float(y), 1), int(Z['f'][i]), int(Z['b'][i])] for x, y, i in zip(lx, ly, k)]


if __name__ == '__main__':
    ids = sys.argv[1:] or [f[:-4] for f in sorted(os.listdir(C + 'hot')) if f.endswith('.pkl') and not f.endswith('_src.pkl')]
    if os.environ.get('SIGNS_ONLY') == '1':                         # refresh the signs and speeds in the existing packs only
        for hid in ids:
            fn = os.path.join(DIST, f'{hid}.json')
            if not os.path.exists(fn): continue
            D_ = pickle.load(open(C + 'hot/' + hid + '.pkl', 'rb')); hdr = json.load(open(fn)); hdr['signs'] = hd_signs(D_); hdr['spd'] = hd_speeds(D_)
            open(fn, 'w').write(json.dumps(hdr, separators=(',', ':'))); print(hid, len(hdr['signs']), 'signs', len(hdr['spd']), 'speeds')
        sys.exit(0)
    if os.environ.get('BRIDGES_ONLY') == '1':                       # add / refresh the bridges in the existing packs only
        for hid in ids:
            fn = os.path.join(DIST, f'{hid}.json')
            if not os.path.exists(fn): continue
            D_ = pickle.load(open(C + 'hot/' + hid + '.pkl', 'rb')); hdr = json.load(open(fn)); hdr['bridges'] = hd_bridges(hid, D_); hdr['signs'] = hd_signs(D_); hdr['spd'] = hd_speeds(D_)
            hdr['tun'] = hd_tunnels(D_)
            open(fn, 'w').write(json.dumps(hdr, separators=(',', ':'))); print(hid, len(hdr['bridges']), 'bridges', len(hdr['tun']), 'tunnels')
        sys.exit(0)
    made = []
    for hid in ids:
        L = build(hid)
        if L: made.append(hid); print(hid, L // 1024, 'KB')
    # (with the photo atlases each passage has: the page fetches only those)
    json.dump(dict(ids=made, atl={h: [k for k in ('n', 'f') if os.path.exists(os.path.join(DIST, f'{h}_{k}.webp'))] for h in made}), open(os.path.join(DIST, 'index.json'), 'w'))
