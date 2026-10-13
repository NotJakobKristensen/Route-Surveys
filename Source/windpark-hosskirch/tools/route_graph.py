"""Road graph for the blade route from Overture transportation segments (OSM-derived).

Edges are the pieces of a segment between consecutive connectors. Travel cost is a heavy-transport time:
motorways are strongly preferred (blade convoys keep to Autobahn/expressway as long as possible), roads with a
weight/height limit below the convoy's are dropped, one-way rules are kept.
"""
import json, math, numpy as np, pyarrow.parquet as pq
from shapely import wkb
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra

# heavy-transport speeds (km/h) per road class: the cost, not a prediction of the convoy's real speed
SPEED = {'motorway': 75, 'trunk': 55, 'primary': 38, 'secondary': 28, 'tertiary': 18, 'unclassified': 12,
         'residential': 6, 'service': 6, 'track': 8, 'living_street': 3, 'unknown': 5}
CONVOY = {'weight_t': 72.0, 'height_m': 4.7, 'length_m': 98.0}
R_EARTH = 6371008.8


def hav(lon1, lat1, lon2, lat2):
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dp, dl = p2 - p1, np.radians(lon2 - lon1)
    a = np.sin(dp / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * R_EARTH * np.arcsin(np.sqrt(a))


def _cut(coords, cum, a, b):
    """polyline between fractions a..b of its length"""
    L = cum[-1]
    s0, s1 = a * L, b * L
    out = []
    for i in range(len(coords) - 1):
        c0, c1 = cum[i], cum[i + 1]
        if c1 < s0 or c0 > s1: continue
        def lerp(s):
            t = 0 if c1 == c0 else (s - c0) / (c1 - c0)
            return (coords[i][0] + (coords[i + 1][0] - coords[i][0]) * t, coords[i][1] + (coords[i + 1][1] - coords[i][1]) * t)
        if not out: out.append(lerp(max(s0, c0)))
        out.append(lerp(min(s1, c1)))
    return out


def _restrictions(ar):
    """→ (forward_ok, backward_ok, blocked_for_convoy)"""
    fwd = bwd = True
    blocked = False
    for r in ar or []:
        w = r.get('when') or {}
        if r.get('access_type') != 'denied': continue
        veh = w.get('vehicle') or []
        mode = w.get('mode') or []
        if r.get('between'): continue          # partial restrictions: ignored (rare on through roads)
        if veh:
            for v in veh:
                d, val, cmp = v.get('dimension'), v.get('value') or 0, v.get('comparison')
                if cmp in ('greater_than', 'greater_than_equal'):
                    if (d == 'weight' and val < CONVOY['weight_t']) or (d == 'height' and val < CONVOY['height_m']) or \
                       (d == 'length' and val < CONVOY['length_m']):
                        blocked = True
            continue
        if mode and not any(m in ('vehicle', 'motor_vehicle', 'hgv', 'car') for m in mode): continue
        if w.get('during') or w.get('using') or w.get('recognized'): continue
        h = w.get('heading')
        if h == 'forward': fwd = False
        elif h == 'backward': bwd = False
        elif not mode: fwd = bwd = False
    return fwd, bwd, blocked


def _limits(ar, a=0.0, b=1.0):
    """signed vehicle limits on the piece a..b of the segment (no access when greater than …): {weight, height, length,
    width} → minimum; restrictions on part of the segment (a tunnel, a bridge) count where they overlap the piece"""
    lim = {}
    for r in ar or []:
        if r.get('access_type') != 'denied': continue
        bt = r.get('between')
        if bt and not (bt[0] < b and bt[1] > a): continue
        for v in (r.get('when') or {}).get('vehicle') or []:
            d, val = v.get('dimension'), v.get('value')
            if d in ('weight', 'height', 'length', 'width') and val and v.get('comparison') in ('greater_than', 'greater_than_equal'):
                lim[d] = min(lim.get(d, 1e9), float(val))
    return lim or None


def blocks(lim, convoy):
    """a signed limit below the convoy's dimension (convoy: weight_t, height_m, length_m, width_m)"""
    if not lim: return False
    return any(lim.get(d, 1e9) < convoy.get(k, 0) for d, k in (('weight', 'weight_t'), ('height', 'height_m'), ('length', 'length_m'), ('width', 'width_m')))


def _urban(sl):
    """a road through a town: a limit of 50 km/h or less over the whole segment (no 'between' range)"""
    for x in sl or []:
        if x.get('between') or x.get('when'): continue
        m = (x.get('max_speed') or {})
        v, u = m.get('value'), m.get('unit') or 'km/h'
        if v is None: continue
        if u == 'mph': v *= 1.609
        if v <= 50: return True
    return False


class Graph:
    def __init__(self, paths, classes=None, keep_limited=False):
        """keep_limited: keep roads with a signed weight/height/length/width limit (info['lim']) so that one graph serves
        convoys of any size (policy_matrix(convoy=…) drops them); otherwise they are dropped against CONVOY"""
        self.node = {}            # connector id → index
        self.nlon, self.nlat = [], []
        self.eu, self.ev, self.ecost, self.elen, self.eseg = [], [], [], [], []
        self.segs = []            # per edge: dict(class, ref, name, coords, flags)
        for p in paths:
            self._load(p, classes, keep_limited)
        self._finish()

    def extend(self, paths, keep_limited=True):
        """add road networks (e.g. every road around the start and the end) to a loaded graph; shared connectors join"""
        self.nlon, self.nlat = list(self.nlon), list(self.nlat)
        for p in paths: self._load(p, None, keep_limited)
        self.__dict__.pop('_refn', None)
        self._finish()

    def _finish(self):
        n = len(self.nlon)
        self.nlon, self.nlat = np.array(self.nlon), np.array(self.nlat)
        self.A = csr_matrix((self.ecost, (self.eu, self.ev)), shape=(n, n))
        # parallel edges: csr sums duplicates, so keep the cheapest explicitly
        best = {}
        for i, (u, v, c) in enumerate(zip(self.eu, self.ev, self.ecost)):
            k = (u, v)
            if k not in best or c < self.ecost[best[k]]: best[k] = i
        self.best = best
        keys = list(best.items())
        self.A = csr_matrix(([self.ecost[i] for _, i in keys], ([k[0] for k, _ in keys], [k[1] for k, _ in keys])), shape=(n, n))
        print(f'graph: {n} nodes, {len(keys)} edges')

    def _nid(self, cid, lon, lat):
        i = self.node.get(cid)
        if i is None:
            i = self.node[cid] = len(self.nlon); self.nlon.append(lon); self.nlat.append(lat)
        return i

    def _load(self, path, classes, keep_limited=False):
        t = pq.read_table(path)
        seen = getattr(self, '_seen', None)
        if seen is None: seen = self._seen = set()
        for r in t.to_pylist():
            if classes and r['class'] not in classes: continue
            if r.get('subtype') not in (None, 'road'): continue
            if r['id'] in seen: continue          # the same segment in two networks (national and local)
            seen.add(r['id'])
            fwd, bwd, blocked = _restrictions(r.get('access_restrictions'))
            if blocked and not keep_limited: continue
            g = wkb.loads(r['geometry'])
            coords = list(g.coords)
            lon = np.array([c[0] for c in coords]); lat = np.array([c[1] for c in coords])
            d = hav(lon[:-1], lat[:-1], lon[1:], lat[1:])
            cum = np.concatenate([[0], np.cumsum(d)])
            if cum[-1] <= 0: continue
            cons = sorted(r['connectors'] or [], key=lambda c: c['at'])
            if len(cons) < 2: continue
            ref = ';'.join(sorted({x['ref'] for x in (r.get('routes') or []) if x.get('ref')}))
            name = (r.get('names') or {}).get('primary')
            flags = [f for f in (r.get('road_flags') or []) for _ in [0]]
            spd = SPEED.get(r['class'], 5)
            urban = _urban(r.get('speed_limits'))
            if r.get('subclass') == 'link': spd *= 0.7
            for a, b in zip(cons[:-1], cons[1:]):
                pc = _cut(coords, cum, a['at'], b['at'])
                if len(pc) < 2: continue
                L = (b['at'] - a['at']) * cum[-1]
                u = self._nid(a['connector_id'], *pc[0]); v = self._nid(b['connector_id'], *pc[-1])
                cost = L / (spd / 3.6) + 0.5
                info = {'cls': r['class'], 'sub': r.get('subclass'), 'ref': ref, 'name': name, 'id': r['id'], 'urban': urban,
                        'a': a['at'], 'b': b['at'], 'flags': r.get('road_flags'), 'width': r.get('width_rules'),
                        'lim': _limits(r.get('access_restrictions'), a['at'], b['at'])}
                k = len(self.segs); self.segs.append((info, pc))
                if fwd: self.eu.append(u); self.ev.append(v); self.ecost.append(cost); self.elen.append(L); self.eseg.append((k, 1))
                if bwd: self.eu.append(v); self.ev.append(u); self.ecost.append(cost); self.elen.append(L); self.eseg.append((k, -1))

    def ref_nodes(self, ref):
        if not hasattr(self, '_refn'):
            self._refn = {}
            for i, (u, v) in enumerate(zip(self.eu, self.ev)):
                for r in self.segs[self.eseg[i][0]][0]['ref'].split(';'):
                    if r: self._refn.setdefault(r, set()).update((u, v))
        return np.array(sorted(self._refn.get(ref, ())))

    def nearest(self, lon, lat, ref=None):
        idx = self.ref_nodes(ref) if ref else np.arange(len(self.nlon))
        d = hav(self.nlon[idx], self.nlat[idx], lon, lat)
        j = int(np.argmin(d))
        return int(idx[j]), float(d[j])

    def matrix(self, classes):
        """adjacency restricted to road classes (links of those classes included)"""
        if classes is None: return self.A
        keep = [(k, i) for k, i in self.best.items() if self.segs[self.eseg[i][0]][0]['cls'] in classes]
        n = len(self.nlon)
        return csr_matrix(([self.ecost[i] for _, i in keep], ([k[0] for k, _ in keep], [k[1] for k, _ in keep])), shape=(n, n))

    def policy_matrix(self, ends, near_m=30000.0, urban_x=8.0, long_classes=('motorway', 'trunk', 'primary'), convoy=None, mask=None):
        """heavy-transport routing without fixed points: on the long haul only motorways, trunk and primary roads,
        town streets (50 km/h or less) cost urban_x times as much; every road class within near_m of the ends.
        convoy: drop roads whose signed limits it exceeds (graphs built with keep_limited); mask: per node, inside the
        area the route may use (outside only within near_m of the ends)"""
        n = len(self.nlon)
        near = np.zeros(n, bool)
        for lon, lat in ends: near |= hav(self.nlon, self.nlat, lon, lat) < near_m
        rows, cols, vals = [], [], []
        for (u, v), i in self.best.items():
            info = self.segs[self.eseg[i][0]][0]
            close = near[u] and near[v]
            if not close and info['cls'] not in long_classes: continue
            if convoy and blocks(info.get('lim'), convoy): continue
            if mask is not None and not close and not (mask[u] and mask[v]): continue
            c = self.ecost[i]
            if info.get('urban') and not (hav(self.nlon[u], self.nlat[u], *ends[0]) < 3000 or hav(self.nlon[u], self.nlat[u], *ends[-1]) < 3000):
                c *= urban_x
            rows.append(u); cols.append(v); vals.append(c)
        return csr_matrix((vals, (rows, cols)), shape=(n, n))

    def path(self, M, a, b):
        """cheapest node path a → b on matrix M (None if there is none)"""
        dist, pred = dijkstra(M, directed=True, indices=a, return_predecessors=True)
        if not np.isfinite(dist[b]): return None
        p = [b]
        while p[-1] != a: p.append(pred[p[-1]])
        return p[::-1]

    def edges(self, path):
        """node path → [(info, coords oriented along travel)] (the same form as route())"""
        out = []
        for u, v in zip(path[:-1], path[1:]):
            k, sgn = self.eseg[self.best[(u, v)]]
            info, pc = self.segs[k]
            out.append((info, pc if sgn > 0 else pc[::-1]))
        return out

    def alternatives(self, M, ids, k=4, penalty=1.6, max_share=0.8):
        """up to k distinct routes through the nodes ids (start, via…, end), by the penalty method: after each route the
        cost of its edges (both directions) is multiplied by penalty; a route sharing more than max_share of its length
        with an earlier one is not kept. → [node path]"""
        M = M.tocsr(copy=True); M.sort_indices()
        out, tries = [], 0
        def scale(u, v, f):
            a0, a1 = M.indptr[u], M.indptr[u + 1]
            j = a0 + np.searchsorted(M.indices[a0:a1], v)
            if j < a1 and M.indices[j] == v: M.data[j] *= f
        while len(out) < k and tries < 3 * k:
            tries += 1
            full = []
            for a, b in zip(ids[:-1], ids[1:]):
                p = self.path(M, a, b)
                if p is None: return out
                full += p if not full else p[1:]
            E = set(zip(full[:-1], full[1:]))
            L = sum(self.elen[self.best[e]] for e in E)
            if all(sum(self.elen[self.best[e]] for e in E & set(zip(q[:-1], q[1:]))) / L <= max_share for q in out):
                out.append(full)
            for u, v in E: scale(u, v, penalty); scale(v, u, penalty)
        return out

    def route(self, waypoints, legs=None):
        """waypoints: [(lon, lat[, ref]), …]; legs: per leg a set of allowed classes (None = all)
        → list of (info, coords oriented along travel)"""
        out = []
        ids = [self.nearest(w[0], w[1], w[2] if len(w) > 2 else None)[0] for w in waypoints]
        for li, (a, b) in enumerate(zip(ids[:-1], ids[1:])):
            M = legs[li] if legs is not None and hasattr(legs[li], 'tocsr') else self.matrix(legs[li] if legs else None)
            dist, pred = dijkstra(M, directed=True, indices=a, return_predecessors=True)
            if not np.isfinite(dist[b]): raise RuntimeError(f'no path {a}->{b}')
            path = [b]
            while path[-1] != a: path.append(pred[path[-1]])
            path.reverse()
            for u, v in zip(path[:-1], path[1:]):
                i = self.best[(u, v)]
                k, sgn = self.eseg[i]
                info, pc = self.segs[k]
                out.append((info, pc if sgn > 0 else pc[::-1]))
        return out


# ───────────────────── compact graph for whole countries (the route planner) ─────────────────────
import array, json as _json
CLS = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'service', 'track',
       'living_street', 'pedestrian', 'footway', 'cycleway', 'path', 'steps', 'bridleway', 'unknown']
_CI = {c: i for i, c in enumerate(CLS)}
_INF = np.float32(1e9)


class Net:
    """The road graph as flat arrays (a country's major roads fit in ~1 GB, where Graph needs ~14 GB). Same policy and
    the same route form as Graph: edges() → [(info, coords)] with the info dict of Graph (cls, sub, ref, name, id,
    urban, a, b, flags, width, lim). Roads with signed limits are kept (policy_matrix(convoy=…) drops them)."""

    def __init__(self, paths=()):
        self.node = {}
        self._L = {k: array.array(t) for k, t in dict(
            nlon='d', nlat='d', eu='i', ev='i', ecost='f', elen='f', epc='i', esg='b',
            p_cls='b', p_link='b', p_urban='b', p_ref='i', p_name='i', p_seg='i', p_a='f', p_b='f',
            p_lw='f', p_lh='f', p_ll='f', p_lwd='f', p_br='b', p_tu='b', p_c0='i', p_c1='i', xy='d').items()}
        self.strs, self._si = [''], {'': 0}
        self.seg_id, self.seg_flags, self.seg_width = [], [], []
        self._seen = set()
        for p in paths: self._load(p)
        self._finish()

    def _s(self, v):
        if not v: return 0
        i = self._si.get(v)
        if i is None: i = self._si[v] = len(self.strs); self.strs.append(v)
        return i

    def _nid(self, cid, lon, lat):
        i = self.node.get(cid)
        if i is None:
            i = self.node[cid] = len(self._L['nlon']); self._L['nlon'].append(lon); self._L['nlat'].append(lat)
        return i

    def _load(self, path):
        L = self._L
        cols = ['id', 'class', 'subclass', 'subtype', 'names', 'routes', 'road_flags', 'access_restrictions', 'connectors',
                'geometry', 'width_rules', 'speed_limits']
        f = pq.ParquetFile(path)
        cols = [c for c in cols if c in f.schema_arrow.names]
        for batch in f.iter_batches(batch_size=20000, columns=cols):
            for r in batch.to_pylist():
                if r.get('subtype') not in (None, 'road') or r['id'] in self._seen: continue
                self._seen.add(r['id'])
                fwd, bwd, _ = _restrictions(r.get('access_restrictions'))
                coords = list(wkb.loads(r['geometry']).coords)
                lon = np.array([c[0] for c in coords]); lat = np.array([c[1] for c in coords])
                cum = np.concatenate([[0], np.cumsum(hav(lon[:-1], lat[:-1], lon[1:], lat[1:]))])
                if cum[-1] <= 0: continue
                cons = sorted(r['connectors'] or [], key=lambda c: c['at'])
                if len(cons) < 2: continue
                sg = len(self.seg_id); self.seg_id.append(r['id'])
                fl = r.get('road_flags'); wr = r.get('width_rules')
                self.seg_flags.append(_json.dumps(fl) if fl else None); self.seg_width.append(_json.dumps(wr) if wr else None)
                ref = self._s(';'.join(sorted({x['ref'] for x in (r.get('routes') or []) if x.get('ref')})))
                name = self._s((r.get('names') or {}).get('primary'))
                ci = _CI.get(r['class'], _CI['unknown']); link = r.get('subclass') == 'link'
                spd = SPEED.get(r['class'], 5) * (0.7 if link else 1)
                urban = _urban(r.get('speed_limits'))
                ar = r.get('access_restrictions')
                for a, b in zip(cons[:-1], cons[1:]):
                    pc = _cut(coords, cum, a['at'], b['at'])
                    if len(pc) < 2: continue
                    Lm = (b['at'] - a['at']) * cum[-1]
                    u = self._nid(a['connector_id'], *pc[0]); v = self._nid(b['connector_id'], *pc[-1])
                    k = len(L['p_cls'])
                    lim = _limits(ar, a['at'], b['at']) or {}
                    br = tu = False
                    for x in fl or []:
                        bt = x.get('between')
                        if bt and not (bt[0] < b['at'] and bt[1] > a['at']): continue
                        br |= 'is_bridge' in (x.get('values') or []); tu |= 'is_tunnel' in (x.get('values') or [])
                    for key, val in (('p_cls', ci), ('p_link', link), ('p_urban', urban), ('p_ref', ref), ('p_name', name), ('p_seg', sg),
                                     ('p_a', a['at']), ('p_b', b['at']), ('p_lw', lim.get('weight', _INF)), ('p_lh', lim.get('height', _INF)),
                                     ('p_ll', lim.get('length', _INF)), ('p_lwd', lim.get('width', _INF)), ('p_br', br), ('p_tu', tu)):
                        L[key].append(val)
                    L['p_c0'].append(len(L['xy']) // 2)
                    for x_, y_ in pc: L['xy'].append(x_); L['xy'].append(y_)
                    L['p_c1'].append(len(L['xy']) // 2)
                    cost = Lm / (spd / 3.6) + 0.5
                    for uu, vv, sg_, ok in ((u, v, 1, fwd), (v, u, -1, bwd)):
                        if not ok: continue
                        L['eu'].append(uu); L['ev'].append(vv); L['ecost'].append(cost); L['elen'].append(Lm); L['epc'].append(k); L['esg'].append(sg_)
            print(f'  {len(self.seg_id)} segments, {len(L["nlon"])} nodes, {len(L["eu"])} edges', flush=True)

    def _finish(self):
        for k, a in self._L.items(): setattr(self, k, np.frombuffer(a, dtype=a.typecode if a.typecode != 'b' else np.int8).copy())
        n = len(self.nlon)
        # parallel edges: the cheapest of each (u, v)
        o = np.lexsort((self.ecost, self.ev, self.eu))
        first = np.ones(len(o), bool); first[1:] = (self.eu[o][1:] != self.eu[o][:-1]) | (self.ev[o][1:] != self.ev[o][:-1])
        self.best_e = o[first]
        self.E = csr_matrix((self.best_e + 1, (self.eu[self.best_e], self.ev[self.best_e])), shape=(n, n))
        self.E.sort_indices()
        print(f'graph: {n} nodes, {len(self.best_e)} edges')

    def extend(self, paths):
        for p in paths: self._load(p)
        self._finish()

    def __getstate__(self):
        d = dict(self.__dict__); d.pop('_si', None); d.pop('_seen', None)
        d['_L'] = {k: (a.typecode, a.tobytes()) for k, a in self._L.items()}
        for k in self._L: d.pop(k, None)
        return d

    def __setstate__(self, d):
        d['_L'] = {k: array.array(t, b) for k, (t, b) in d['_L'].items()}
        self.__dict__.update(d)
        self._si = {s: i for i, s in enumerate(self.strs)}; self._seen = set(self.seg_id)
        for k, a in self._L.items(): setattr(self, k, np.frombuffer(a, dtype=a.typecode if a.typecode != 'b' else np.int8).copy())

    def edge(self, u, v):
        a0, a1 = self.E.indptr[u], self.E.indptr[u + 1]
        j = a0 + np.searchsorted(self.E.indices[a0:a1], v)
        return int(self.E.data[j]) - 1 if j < a1 and self.E.indices[j] == v else -1

    def coords(self, k):
        c = self.xy[2 * self.p_c0[k]:2 * self.p_c1[k]]
        return [(float(c[i]), float(c[i + 1])) for i in range(0, len(c), 2)]

    def info(self, k):
        sg = self.p_seg[k]
        lim = {d: float(v) for d, v in (('weight', self.p_lw[k]), ('height', self.p_lh[k]), ('length', self.p_ll[k]), ('width', self.p_lwd[k])) if v < 1e8}
        return {'cls': CLS[self.p_cls[k]], 'sub': 'link' if self.p_link[k] else None, 'ref': self.strs[self.p_ref[k]],
                'name': self.strs[self.p_name[k]] or None, 'id': self.seg_id[sg], 'urban': bool(self.p_urban[k]),
                'a': float(self.p_a[k]), 'b': float(self.p_b[k]),
                'flags': _json.loads(self.seg_flags[sg]) if self.seg_flags[sg] else None,
                'width': _json.loads(self.seg_width[sg]) if self.seg_width[sg] else None, 'lim': lim or None}

    def nearest(self, lon, lat):
        d = hav(self.nlon, self.nlat, lon, lat); j = int(np.argmin(d)); return j, float(d[j])

    def policy_matrix(self, ends, near_m=30000.0, urban_x=8.0, long_classes=('motorway', 'trunk', 'primary'), convoy=None, mask=None):
        """as Graph.policy_matrix, vectorised"""
        n = len(self.nlon); e = self.best_e; u, v = self.eu[e], self.ev[e]; k = self.epc[e]
        near = np.zeros(n, bool); town_end = np.zeros(n, bool)
        for lon, lat in ends:
            d = hav(self.nlon, self.nlat, lon, lat); near |= d < near_m; town_end |= d < 3000
        close = near[u] & near[v]
        keep = close | np.isin(self.p_cls[k], [_CI[c] for c in long_classes])
        if convoy:
            keep &= ~((self.p_lw[k] < convoy.get('weight_t', 0)) | (self.p_lh[k] < convoy.get('height_m', 0)) |
                      (self.p_ll[k] < convoy.get('length_m', 0)) | (self.p_lwd[k] < convoy.get('width_m', 0)))
        if mask is not None: keep &= close | (mask[u] & mask[v])
        c = self.ecost[e].astype(float) * np.where(self.p_urban[k].astype(bool) & ~town_end[u], urban_x, 1.0)
        return csr_matrix((c[keep], (u[keep], v[keep])), shape=(n, n))

    def path(self, M, a, b):
        return Graph.path(self, M, a, b)

    def edges(self, path):
        out = []
        for u, v in zip(path[:-1], path[1:]):
            i = self.edge(u, v); k = self.epc[i]; pc = self.coords(k)
            out.append((self.info(k), pc if self.esg[i] > 0 else pc[::-1]))
        return out

    def alternatives(self, M, ids, k=4, penalty=1.6, max_share=0.8, max_detour=1.3, repair=None):
        """as Graph.alternatives; a route costing more than max_detour × the best (on the unpenalised matrix) is dropped;
        repair(path) → edges to avoid (made 50 × as expensive, the route searched again)"""
        M0 = M.tocsr(); M0.sort_indices()
        M = M.tocsr(copy=True); M.sort_indices()
        out, tries, base = [], 0, None
        def cost0(p):
            c = 0.0
            for u, v in zip(p[:-1], p[1:]):
                a0, a1 = M0.indptr[u], M0.indptr[u + 1]
                c += M0.data[a0 + np.searchsorted(M0.indices[a0:a1], v)]
            return c
        def scale(u, v, f):
            a0, a1 = M.indptr[u], M.indptr[u + 1]
            j = a0 + np.searchsorted(M.indices[a0:a1], v)
            if j < a1 and M.indices[j] == v: M.data[j] *= f
        while len(out) < k and tries < 4 * k:
            tries += 1
            full = []
            for a, b in zip(ids[:-1], ids[1:]):
                p = self.path(M, a, b)
                if p is None: return out
                full += p if not full else p[1:]
            bad = repair(full) if repair else []
            if bad:
                for u, v in bad: scale(u, v, 50.0)
                continue
            E = set(zip(full[:-1], full[1:]))
            ln = lambda es: sum(float(self.elen[self.edge(*e)]) for e in es)
            L = ln(E); c0 = cost0(full)
            if base is None: base = c0
            if c0 > max_detour * base: continue
            if all(ln(E & set(zip(q[:-1], q[1:]))) / L <= max_share for q in out): out.append(full)
            for u, v in E: scale(u, v, penalty); scale(v, u, penalty)
        return out
