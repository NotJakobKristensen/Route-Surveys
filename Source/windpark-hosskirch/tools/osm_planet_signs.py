"""Every road-sign node near the route from the OpenStreetMap planet (AWS open data osm-pds, ORC, reachable from this build
environment while overpass-api.de is not): the planet's node stripes are fetched with range requests and decoded with
pyarrow in parallel (about 80 GB read, 20 min), nodes with traffic_sign / crossing / signal / stop / give-way /
milestone / speed-camera tags inside the route's bounding box are kept, then those within 60 m of the route.
→ .cache/route/corr/osm_nodes.pkl [{id, x, y (UTM 33), i, s, d (left +), dist, tags}]"""
import zlib
def varint(b, i):
    r = s = 0
    while True:
        c = b[i]; i += 1; r |= (c & 0x7f) << s; s += 7
        if c < 0x80: return r, i
def fields(b):
    i = 0; out = []
    while i < len(b):
        k, i = varint(b, i); f, w = k >> 3, k & 7
        if w == 0: v, i = varint(b, i)
        elif w == 2: n, i = varint(b, i); v = b[i:i + n]; i += n
        elif w == 1: v = b[i:i + 8]; i += 8
        elif w == 5: v = b[i:i + 4]; i += 4
        out.append((f, v))
    return out
def decompress(b, kind):
    if kind == 0: return b
    out = bytearray(); i = 0
    while i < len(b):
        h = b[i] | b[i + 1] << 8 | b[i + 2] << 16; i += 3; n = h >> 1
        chunk = b[i:i + n]; i += n
        if h & 1: out += chunk
        elif kind == 1: out += zlib.decompress(chunk, -15)
        elif kind == 5:
            import zstandard; out += zstandard.ZstdDecompressor().decompress(chunk, max_output_length=1 << 26)
        elif kind == 2:
            import snappy; out += snappy.decompress(chunk)
        else: raise ValueError(kind)
    return bytes(out)
def stripes(tail):
    """tail: last bytes of the file → [(offset, length, rows)]"""
    psl = tail[-1]; ps = dict(fields(tail[-1 - psl:-1]))
    flen, comp = ps[1], ps.get(2, 0)
    fb = decompress(tail[-1 - psl - flen:-1 - psl], comp)
    out = []
    for f, v in fields(fb):
        if f == 3:
            d = dict(fields(v)); out.append((d[1], d.get(2, 0) + d.get(3, 0) + d.get(4, 0), d.get(5, 0)))
    return out, comp


import os, sys, time, io, json, pickle, requests, numpy as np
import pyarrow as pa, pyarrow.orc as orc, pyarrow.compute as pc
U = os.environ.get('PLANET_ORC', 'https://osm-pds.s3.amazonaws.com/2026/planet-260928.orc')
BB = (47.6, 9.2, 53.8, 15.1)          # lat0, lon0, lat1, lon1: Goleniów … Hoßkirch
import routecfg
BB = tuple(routecfg.get('signs_bb', BB))
KEYS = {'city_limit', 'destination', 'inscription', 'traffic_sign', 'traffic_sign:forward', 'traffic_sign:backward', 'highway', 'crossing', 'direction', 'traffic_signals:direction',
        'traffic_signals', 'maxspeed', 'maxheight', 'maxweight', 'overtaking', 'name', 'ref', 'distance', 'side', 'traffic_sign:direction',
        'crossing_ref', 'crossing:markings', 'crossing:signals', 'button_operated', 'traffic_signals:sound', 'man_made', 'support', 'railway'}
HW = {'traffic_signals', 'stop', 'give_way', 'crossing', 'milestone', 'speed_camera', 'street_lamp', 'traffic_mirror', 'level_crossing'}

class F(io.RawIOBase):
    def __init__(self, tail):
        self.s = requests.Session(); self.size, self.tail_off, self.tail = tail; self.pos = 0; self.buf = None; self.boff = 0
    def readable(self): return True
    def seekable(self): return True
    def tell(self): return self.pos
    def seek(self, o, w=0): self.pos = o if w == 0 else self.pos + o if w == 1 else self.size + o; return self.pos
    def fetch(self, a, n):
        for t in range(6):
            try:
                r = self.s.get(U, headers={'Range': f'bytes={a}-{a + n - 1}'}, timeout=300); r.raise_for_status()
                if len(r.content) == n: return r.content
            except Exception: time.sleep(2 * (t + 1))
        raise IOError('fetch failed')
    def prefetch(self, a, n): self.buf = self.fetch(a, n); self.boff = a
    def read(self, n=-1):
        if n < 0: n = self.size - self.pos
        a = self.pos
        if a >= self.tail_off: d = self.tail[a - self.tail_off:a - self.tail_off + n]
        elif self.buf is not None and self.boff <= a and a + n <= self.boff + len(self.buf): d = self.buf[a - self.boff:a - self.boff + n]
        else: d = self.fetch(a, n)
        self.pos += len(d); return d
    def readinto(self, b): d = self.read(len(b)); b[:len(d)] = d; return len(d)

def open_tail():
    s = requests.Session(); size = int(s.head(U).headers['Content-Length']); n = 16 << 20
    tail = s.get(U, headers={'Range': f'bytes={size - n}-{size - 1}'}, timeout=300).content
    return (size, size - n, tail)

def scan(args):
    tail, idx, info = args
    f = F(tail); o = orc.ORCFile(f); out = []; t0 = time.time()
    for i in idx:
        a, n = info[i]
        f.prefetch(a, n)
        tb = o.read_stripe(i, columns=['id', 'type', 'tags', 'lat', 'lon'])
        if tb.column('type')[0].as_py() != 'node': out.append(('end', i)); break
        lat = pc.cast(tb.column('lat'), pa.float64()); lon = pc.cast(tb.column('lon'), pa.float64())
        inb = pc.and_(pc.and_(pc.greater(lat, BB[0]), pc.less(lat, BB[2])), pc.and_(pc.greater(lon, BB[1]), pc.less(lon, BB[3])))
        tags = tb.column('tags')
        off = tags.offsets.to_numpy(); keys = tags.keys; items = tags.items
        km = pc.or_(pc.starts_with(keys, 'traffic_sign'), pc.equal(keys, 'crossing'))
        km = pc.or_(km, pc.and_(pc.equal(keys, 'highway'), pc.is_in(items, value_set=pa.array(sorted(HW)))))
        fk = np.nonzero(pc.fill_null(km, False).to_numpy(zero_copy_only=False))[0]
        if len(fk):
            rows = np.unique(np.searchsorted(off, fk, 'right') - 1).astype(np.int64)
            inbn = np.asarray(pc.fill_null(inb, False).to_numpy(zero_copy_only=False), bool)
            sel = rows[inbn[rows]]
            if len(sel):
                ids = tb.column('id').to_numpy(zero_copy_only=False); la = pc.fill_null(lat, float('nan')).to_numpy(zero_copy_only=False); lo = pc.fill_null(lon, float('nan')).to_numpy(zero_copy_only=False)
                for k, tg in zip(sel, tags.take(pa.array(sel)).to_pylist()):
                    d = dict(tg)
                    out.append((int(ids[k]), float(la[k]), float(lo[k]), {x: v for x, v in d.items() if x in KEYS or x.startswith('traffic_sign')}))
        print(i, len(out), round(time.time() - t0, 1), flush=True)
    return out


def main():
    import multiprocessing as mp, glob
    from route_corridor import route, OUT
    from pyproj import Transformer
    from scipy.spatial import cKDTree
    # every sign node in the box, kept for the next route inside the same box (the scan reads the whole planet)
    box_fn = routecfg.SHARED + 'corr/osm_planet_box_%s.pkl' % '_'.join(f'{v:g}' for v in BB)
    cached = [f for f in glob.glob(routecfg.SHARED + 'corr/osm_planet_box_*.pkl')
              if (lambda b: b[0] <= BB[0] and b[1] <= BB[1] and b[2] >= BB[2] and b[3] >= BB[3])([float(v) for v in os.path.basename(f)[15:-4].split('_')])]
    if cached:
        items = pickle.load(open(cached[0], 'rb'))
    else:
        t = open_tail(); st, _ = stripes(t[2]); info = {i: (a, n) for i, (a, n, r) in enumerate(st)}
        NW = int(os.environ.get('WORKERS', '6'))
        with mp.Pool(NW) as p: parts = p.map(scan, [(t, list(range(w, len(st), NW)), info) for w in range(NW)])
        items = {}
        for part in parts:
            for x in part:
                if x[0] != 'end': items[x[0]] = x
        os.makedirs(os.path.dirname(box_fn), exist_ok=True); pickle.dump(items, open(box_fn, 'wb'))
    r = route(); P = r['P']; s = r['s']; N = r['N']
    to = Transformer.from_crs('EPSG:4326', 'EPSG:32633', always_xy=True)
    ids = list(items); X, Y = to.transform(np.array([items[i][2] for i in ids]), np.array([items[i][1] for i in ids]))
    d, k = cKDTree(P[::2]).query(np.c_[X, Y], distance_upper_bound=60)
    out = []
    for j in np.nonzero(np.isfinite(d))[0]:
        i = int(k[j]) * 2; lat = (X[j] - P[i, 0]) * N[i, 0] + (Y[j] - P[i, 1]) * N[i, 1]
        out.append(dict(id=ids[j], x=float(X[j]), y=float(Y[j]), i=i, s=float(s[i]), d=float(lat), dist=float(d[j]), tags=items[ids[j]][3]))
    pickle.dump(out, open(OUT + 'osm_nodes.pkl', 'wb')); print(len(items), 'in the box,', len(out), 'near the route')


if __name__ == '__main__':
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    main()
