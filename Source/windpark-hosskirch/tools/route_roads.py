"""Every road within 120 m of the route (Overture transportation segments, release in overture.py), for the 3D road
surfaces of the road view: the route's own segments are left out (the view builds the route from its measured edges).
Per piece: class, subclass, width (mapped or typical), surface, one-way, bridge / tunnel / level, the line clipped to the
corridor (UTM 33). A segment flagged as bridge or tunnel only over part of its length (Overture road_flags 'between') is
cut there: each piece carries the flags of its own part. → .cache/route/corr/roads.pkl {'blocks': {b0: [piece, …]}}
FLAGS=1: cut the pieces already in roads.pkl by their flags' parts (the segments' flags from the cached road networks
net_*.parquet, the rest from the release's parquet files read a row group at a time) — nothing else is fetched again."""
import routecfg
import os, sys, time, pickle, numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import overture as ov, pyarrow.compute as pc
from shapely import wkb
from shapely.geometry import LineString, Point
from shapely.ops import transform as stf, substring
from pyproj import Transformer
from route_corridor import route, OUT

C = routecfg.C
r = route(); P = r['P']; s = r['s']
t = Transformer.from_crs('EPSG:32633', 'EPSG:4326', always_xy=True)
f = Transformer.from_crs('EPSG:4326', 'EPSG:32633', always_xy=True)
tf = lambda g: stf(lambda X, Y, Z=None: f.transform(X, Y), g)
OWN = {rec[0]['id'] for rec in pickle.load(open(C + 'route.pkl', 'rb'))}
SKIP = {'footway', 'pedestrian', 'steps', 'path', 'cycleway', 'bridleway', 'sidewalk', 'crosswalk'}
fn = OUT + 'roads.pkl'


def parts(xy, g, flags):
    """the piece xy (a part of segment g, both UTM) cut where its bridge / tunnel flags begin and end (road_flags 'between':
    fractions of g's length, none = all of it) → [(xy, bridge, tunnel)] in order (cuts under 0.5 m apart dropped)"""
    L = g.length; iv = {'b': [], 't': []}
    for d in flags or []:
        vals = d.get('values') or []; bt = d.get('between') or [0.0, 1.0]
        if 'is_bridge' in vals: iv['b'].append((bt[0] * L, bt[1] * L))
        if 'is_tunnel' in vals: iv['t'].append((bt[0] * L, bt[1] * L))
    ln = LineString(xy); m0, m1 = g.project(Point(xy[0])), g.project(Point(xy[-1])); sg = 1 if m1 >= m0 else -1
    cut = sorted({abs(x - m0) for v in iv.values() for a, b in v for x in (a, b) if min(m0, m1) < x < max(m0, m1)})
    ed = [0.0] + [c for c in cut if 0.5 < c < ln.length - 0.5] + [ln.length]
    out = []
    for a, b in zip(ed[:-1], ed[1:]):
        mid = m0 + sg * (a + b) / 2
        q = substring(ln, a, b) if (a, b) != (0.0, ln.length) else ln
        out.append((np.asarray(q.coords)[:, :2].astype(np.float32), any(x <= mid <= y for x, y in iv['b']), any(x <= mid <= y for x, y in iv['t'])))
    return out


def piece_rows(x, g, corr):
    """the pieces of one Overture segment (its row x, its line g in UTM) inside the corridor, each part with its flags"""
    fl = set(); [fl.update(d.get('values') or []) for d in (x['road_flags'] or [])]
    lv = max([d.get('value') or 0 for d in (x['level_rules'] or [])] + [0])
    w = None
    for d in (x['width_rules'] or []):
        if d.get('value'): w = float(d['value'])
    surf = None
    for d in (x['road_surface'] or []):
        if d.get('value'): surf = d['value']
    oneway = 0
    for a in (x['access_restrictions'] or []):
        wh = a.get('when') or {}
        if a.get('access_type') == 'denied' and wh.get('heading') and not (wh.get('mode') or wh.get('using') or wh.get('during') or wh.get('recognized')):
            oneway = 1 if wh['heading'] == 'backward' else -1
    clip = g.intersection(corr); out = []
    for gg in getattr(clip, 'geoms', [clip]):
        if gg.geom_type != 'LineString' or gg.length < 3: continue
        xy = np.asarray(gg.coords)[:, :2].astype(np.float32)
        for pxy, br, tu in (parts(xy, g, x['road_flags']) if fl & {'is_bridge', 'is_tunnel'} else [(xy, False, False)]):
            out.append(dict(id=x['id'], cls=x['class'], sub=x['subclass'], w=w, surf=surf, oneway=oneway, bridge=br, tunnel=tu,
                            level=lv, xy=pxy, parts=True))
    return out


def s3_flags(want):
    """road_flags and geometry (WKB) of the segments want {id: (lon, lat) of a point on it} from the release's parquet
    files read one row group at a time (the dataset scan fails through the proxy): the footers' bbox statistics pick the
    row groups that can hold each point; → {id: (road_flags, wkb)} (what could be read)"""
    import pyarrow as pa, pyarrow.parquet as pq
    from pyarrow.fs import FileSelector
    pa.set_io_thread_count(2)
    def tries(fn_, *a):
        for k in range(4):
            try: return fn_(*a)
            except Exception as ex:
                print('  retry', repr(ex)[:90], flush=True); time.sleep(3 * (k + 1))
        return None
    base = ov.REL + '/theme=transportation/type=segment/'
    files = tries(lambda: sorted(i.path for i in ov.s3.get_file_info(FileSelector(base)))) or []
    pts = np.array(list(want.values()), float); ids = set(want); out = {}
    for fi, fp in enumerate(files):
        pf = tries(lambda: pq.ParquetFile(ov.s3.open_input_file(fp)))
        if pf is None: continue
        md = pf.metadata; nm = {md.schema.column(i).path: i for i in range(md.num_columns)}
        for gi in range(md.num_row_groups):
            rg = md.row_group(gi); st = [rg.column(nm[k]).statistics for k in ('bbox.xmin', 'bbox.xmax', 'bbox.ymin', 'bbox.ymax')]
            if not ((pts[:, 0] >= st[0].min - 1e-4) & (pts[:, 0] <= st[1].max + 1e-4) & (pts[:, 1] >= st[2].min - 1e-4) & (pts[:, 1] <= st[3].max + 1e-4)).any(): continue
            tid = tries(lambda: pf.read_row_group(gi, columns=['id']))
            if tid is None: continue
            hit = [k for k, v in enumerate(tid['id'].to_pylist()) if v in ids and v not in out]
            if not hit: continue
            tb = tries(lambda: pf.read_row_group(gi, columns=['id', 'road_flags', 'geometry']))
            if tb is None: continue
            rows = tb.take(hit).to_pylist()
            for x in rows: out[x['id']] = (x['road_flags'], x['geometry'])
            print(f'  file {fi} group {gi}: {len(rows)} segments ({len(out)} of {len(ids)})', flush=True)
        if len(out) == len(ids): break
    return out


def refresh_flags():
    """FLAGS=1: the pieces of roads.pkl flagged as bridge or tunnel (whole segments, before the parts were kept) cut by their
    flags' parts"""
    import pyarrow.parquet as pq
    res = pickle.load(open(fn, 'rb'))
    todo = {q['id']: q['xy'][len(q['xy']) // 2] for v in res['blocks'].values() for q in v if (q['bridge'] or q['tunnel']) and not q.get('parts')}
    print(len(todo), 'segments flagged as bridge or tunnel to cut by their parts', flush=True)
    info = {}
    for nmf in ('net_major', 'net_de', 'net_factory', 'net_site'):           # the cached road networks (major roads)
        for d in (C, routecfg.SHARED):
            p_ = d + nmf + '.parquet'
            if not os.path.exists(p_): continue
            tb = pq.read_table(p_, columns=['id', 'road_flags', 'geometry'])
            m = pc.is_in(tb['id'], value_set=__import__('pyarrow').array(list(set(todo) - set(info))))
            for x in tb.filter(m).to_pylist(): info[x['id']] = (x['road_flags'], x['geometry'])
            break
    print(len(info), 'from the cached road networks', flush=True)
    rest = {i: t.transform(*map(float, xy)) for i, xy in todo.items() if i not in info}
    if rest:
        try: info.update(s3_flags(rest))
        except Exception as ex: print('  the release could not be read:', repr(ex)[:160], flush=True)
    print(len(info), 'of', len(todo), 'segments with their flags', flush=True)
    n0 = n1 = 0
    for b0, v in res['blocks'].items():
        out = []
        for q in v:
            if (q['bridge'] or q['tunnel']) and not q.get('parts') and q['id'] in info and len(q['xy']) >= 2:
                flags, gw = info[q['id']]
                pp = parts(q['xy'].astype(float), tf(wkb.loads(gw)), flags)
                out += [dict(q, xy=xy, bridge=br, tunnel=tu, parts=True) for xy, br, tu in pp if len(xy) >= 2]; n0 += 1; n1 += len(pp)
            else: out.append(q)
        res['blocks'][b0] = out
    pickle.dump(res, open(fn, 'wb'))
    print(f'{n0} pieces cut into {n1} parts; bridge pieces {sum(q["bridge"] for v in res["blocks"].values() for q in v)}, '
          f'tunnel pieces {sum(q["tunnel"] for v in res["blocks"].values() for q in v)}, all {sum(len(v) for v in res["blocks"].values())}')


if __name__ == '__main__':
    if os.environ.get('FLAGS') == '1':
        refresh_flags(); sys.exit(0)
    res = pickle.load(open(fn, 'rb')) if os.path.exists(fn) and os.environ.get('FRESH') != '1' else {'blocks': {}}
    B = 20000
    for b0 in range(0, len(s), B):
        if b0 in res['blocks']: continue
        Pb = P[b0:b0 + B + 1:20]
        line = LineString(Pb); corr = line.buffer(120)
        lo, la = t.transform(Pb[:, 0], Pb[:, 1])
        bb = (lo.min() - 0.003, la.min() - 0.003, lo.max() + 0.003, la.max() + 0.003)
        tb = ov.query('transportation', 'segment', bb, columns=['id', 'class', 'subclass', 'geometry', 'road_flags', 'level_rules', 'width_rules', 'road_surface', 'access_restrictions'],
                      extra=pc.field('subtype') == 'road')
        out = []
        for x in tb.to_pylist():
            if x['id'] in OWN or (x['class'] or '') in SKIP: continue
            g = tf(wkb.loads(x['geometry']))
            if not corr.intersects(g): continue
            out += piece_rows(x, g, corr)
        res['blocks'][b0] = out
        pickle.dump(res, open(fn, 'wb'))
        print(b0, len(out), flush=True)
    print('done', sum(len(v) for v in res['blocks'].values()))
