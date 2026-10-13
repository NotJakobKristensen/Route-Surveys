"""Roadside objects along the whole route from Overture (release in overture.py), in blocks of ~20 km:
infrastructure points/lines (signs, lamps, signals, poles, barriers/guardrails), buildings within 60 m, and
roads/railways on a higher level crossing the route (bridges over the route). → .cache/route/corr/objects.pkl"""
import os, sys, pickle, numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import overture as ov
from shapely import wkb
from shapely.geometry import LineString, Point
from shapely.ops import transform as stf
from pyproj import Transformer
from route_corridor import route, OUT

r = route(); P = r['P']; s = r['s']
t = Transformer.from_crs('EPSG:32633', 'EPSG:4326', always_xy=True)
f = Transformer.from_crs('EPSG:4326', 'EPSG:32633', always_xy=True)
tf = lambda g: stf(lambda X, Y, Z=None: f.transform(X, Y), g)
fn = OUT + 'objects.pkl'
res = pickle.load(open(fn, 'rb')) if os.path.exists(fn) else {'blocks': {}}
B = 20000
# the map tags kept: heights, the kind of object, signs, and what makes a crossing a zebra crossing (Z 350)
KEEP = ('maxheight', 'height', 'highway', 'barrier', 'traffic_sign', 'man_made', 'power', 'name', 'ref', 'direction', 'crossing',
        'crossing_ref', 'crossing:markings', 'crossing:signals', 'crossing:island')
keep_tags = lambda tags: {k: v for k, v in (dict(tags) if isinstance(tags, list) else (tags or {})).items() if k in KEEP}
if os.environ.get('TAGS_ONLY') == '1':                  # refresh the kept tags of the points already in the cache
    for b0, out in res['blocks'].items():
        Pb = P[b0:b0 + B + 1:20]; lo, la = t.transform(Pb[:, 0], Pb[:, 1])
        bb = (lo.min() - 0.002, la.min() - 0.002, lo.max() + 0.002, la.max() + 0.002)
        tags_at = {}
        for x in ov.query('base', 'infrastructure', bb, columns=['class', 'geometry', 'source_tags']).to_pylist():
            g = wkb.loads(x['geometry'])
            if g.geom_type != 'Point': continue
            X, Y = f.transform(g.x, g.y); tags_at[(x['class'], round(X, 1), round(Y, 1))] = keep_tags(x['source_tags'])
        hit = 0
        for rec in out['pts']:
            k = (rec['cls'], round(rec['xy'][0], 1), round(rec['xy'][1], 1))
            if k in tags_at: rec['tags'] = tags_at[k]; hit += 1
        print(b0, hit, '/', len(out['pts']), flush=True)
    pickle.dump(res, open(fn, 'wb'))
    sys.exit(0)
for b0 in range(0, len(s), B):
    if b0 in res['blocks']: continue
    Pb = P[b0:b0 + B + 1:20]
    line = LineString(Pb); corr = line.buffer(60)
    lo, la = t.transform(Pb[:, 0], Pb[:, 1])
    bb = (lo.min() - 0.002, la.min() - 0.002, lo.max() + 0.002, la.max() + 0.002)
    out = dict(pts=[], lines=[], bld=[], over=[])
    tb = ov.query('base', 'infrastructure', bb, columns=['subtype', 'class', 'geometry', 'height', 'source_tags'])
    for x in tb.to_pylist():
        g = tf(wkb.loads(x['geometry']))
        if not corr.intersects(g): continue
        tags = x['source_tags']
        if isinstance(tags, list): tags = dict(tags)
        rec = dict(sub=x['subtype'], cls=x['class'], h=x['height'], tags=keep_tags(tags))
        if g.geom_type == 'Point': rec['xy'] = (g.x, g.y); out['pts'].append(rec)
        elif 'Line' in g.geom_type: rec['g'] = g.intersection(corr); out['lines'].append(rec)
        else: rec['g'] = g.intersection(corr); out['lines'].append(rec)
    from shapely.prepared import prep
    pc = prep(corr)
    tb = ov.query('buildings', 'building', bb, columns=['class', 'height', 'num_floors', 'geometry'])
    cols = {k: tb.column(k).to_pylist() for k in ('class', 'height', 'num_floors')}
    geo = tb.column('geometry')
    for i in range(tb.num_rows):
        g = tf(wkb.loads(geo[i].as_py()))
        if pc.intersects(g): out['bld'].append(dict(g=g, h=cols['height'][i], fl=cols['num_floors'][i], cls=cols['class'][i]))
    del tb, geo
    tb = ov.query('transportation', 'segment', bb, columns=['subtype', 'class', 'names', 'level_rules', 'road_flags', 'geometry'])
    for x in tb.to_pylist():
        lv = x['level_rules'] or []
        fl = x['road_flags'] or []
        hi = any((d.get('value') or 0) > 0 for d in lv) or any('is_bridge' in (d.get('values') or []) for d in fl)
        if not hi: continue
        g = tf(wkb.loads(x['geometry']))
        if not g.intersects(line.buffer(3)): continue
        ip = g.intersection(line.buffer(3))
        c = ip.centroid
        k = int(np.argmin(np.hypot(Pb[:, 0] - c.x, Pb[:, 1] - c.y)))
        # skip the route's own bridges (segment running along the route)
        if g.length > 0 and ip.length > 0.6 * min(g.length, 40): continue
        nm = None
        if x['names']: nm = (dict(x['names']) if isinstance(x['names'], list) else x['names']).get('primary')
        out['over'].append(dict(s=float(s[b0 + k * 20]), sub=x['subtype'], cls=x['class'], name=nm, xy=(c.x, c.y)))
    res['blocks'][b0] = out
    pickle.dump(res, open(fn, 'wb'))
    print(b0, len(out['pts']), len(out['lines']), len(out['bld']), len(out['over']), flush=True)
print('done')
