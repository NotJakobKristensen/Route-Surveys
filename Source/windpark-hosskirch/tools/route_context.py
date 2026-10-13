"""Context layers for the route map (Overture Maps, OSM-derived): country and state borders, major rivers and lakes,
towns. → .cache/route/context.pkl (lon/lat shapely geometries)."""
import routecfg
import os, pickle, json
import overture as ov, pyarrow.compute as pc
from shapely import wkb
from shapely.geometry import box
C = routecfg.C
meta = json.load(open(C + 'map_meta.json'))
from pyproj import Transformer
bw = Transformer.from_crs(meta['proj'], 'EPSG:4326', always_xy=True)
cs = [bw.transform(x, y) for x in (meta['x0'], meta['x1']) for y in (meta['y0'], meta['y1'])]
BB = (min(c[0] for c in cs), min(c[1] for c in cs), max(c[0] for c in cs), max(c[1] for c in cs))
out = {}
t = ov.query('divisions', 'division_boundary', BB, columns=['subtype', 'class', 'admin_level', 'is_land', 'geometry', 'country'],
             extra=pc.field('subtype').isin(['country', 'region']))
out['borders'] = [(r['subtype'], r['country'], wkb.loads(r['geometry'])) for r in t.to_pylist()]
print('borders', len(out['borders']))
RIVERS = ['Odra', 'Oder', 'Elbe', 'Saale', 'Main', 'Donau', 'Spree', 'Havel', 'Iller', 'Rhein', 'Neckar', 'Altmühl', 'Regnitz',
          'Weiße Elster', 'Mulde', 'Naab', 'Lech', 'Riß', 'Schussen', 'Peene', 'Warta', 'Neiße', 'Lausitzer Neiße', 'Nysa Łużycka', 'Fränkische Saale']
t = ov.query('base', 'water', BB, columns=['subtype', 'class', 'names', 'geometry'],
             extra=pc.field('subtype').isin(['river', 'lake', 'ocean', 'sea', 'reservoir']))
riv, lakes, sea = [], [], []
for r in t.to_pylist():
    n = (r['names'] or {}).get('primary')
    g = wkb.loads(r['geometry'])
    if r['subtype'] == 'river' and g.geom_type in ('LineString', 'MultiLineString') and n in RIVERS:
        riv.append((n, g))
    elif r['subtype'] in ('lake', 'reservoir') and g.geom_type in ('Polygon', 'MultiPolygon'):
        a = g.area * 111.0 * 111.0 * 0.64
        if a > 12: lakes.append((n, g))
    elif r['subtype'] in ('ocean', 'sea') and g.geom_type in ('Polygon', 'MultiPolygon'):
        sea.append((n, g))
out['rivers'], out['lakes'], out['sea'] = riv, lakes, sea
print('rivers', len(riv), 'lakes', len(lakes), 'sea', len(sea))
t = ov.query('divisions', 'division', BB, columns=['subtype', 'class', 'names', 'geometry', 'population', 'country'],
             extra=pc.field('subtype').isin(['locality', 'country']))
towns = []
for r in t.to_pylist():
    n = (r['names'] or {}).get('primary'); g = wkb.loads(r['geometry'])
    if g.geom_type != 'Point': g = g.representative_point()
    towns.append(dict(name=n, sub=r['subtype'], cls=r['class'], pop=r['population'] or 0, lon=g.x, lat=g.y, country=r['country']))
out['towns'] = towns
print('towns', len(towns))
pickle.dump(out, open(C + 'context.pkl', 'wb'))
