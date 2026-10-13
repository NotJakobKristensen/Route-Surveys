"""All OSM wind turbines (power=generator, generator:source=wind) within ~30 km, from Overture Maps base/infrastructure,
with full-precision WKB geometry → <cache>/wind_turbines_region.json. The six Hoßkirch V172 carry model=V172."""
import json
from shapely import wkb
import pyarrow.compute as pc
import overture as ov
from geo import cp
t = ov.query('base', 'infrastructure', (9.10, 47.75, 9.80, 48.18), columns=['id', 'class', 'source_tags', 'geometry'],
             extra=(pc.field('class') == 'generator'))
out = []
for r in t.to_pylist():
    tags = dict(r['source_tags']) if r['source_tags'] else {}
    if tags.get('generator:source') != 'wind': continue
    g = wkb.loads(r['geometry']); c = g if g.geom_type == 'Point' else g.centroid
    out.append({'id': r['id'], 'lon': c.x, 'lat': c.y, 'geom': g.geom_type, 'tags': tags})
json.dump(out, open(cp('wind_turbines_region.json'), 'w'), ensure_ascii=False, indent=1)
print(len(out), 'wind turbines;', sum(1 for o in out if o['tags'].get('model') == 'V172'), 'V172')
