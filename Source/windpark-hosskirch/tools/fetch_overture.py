"""Overture Maps (OSM-derived) extracts for a bbox → <cache>/<tag>_<layer>.geojson.
Usage: python fetch_overture.py W,S,E,N tag [layers]   e.g. 9.37,47.915,9.52,48.005 core ; 9.26,47.83,9.63,48.09 wide land_use,land,water,segment,infrastructure,division"""
import overture as ov, json, sys
from geo import CACHE, cp
from shapely import wkb
from shapely.geometry import mapping
BBOX = tuple(map(float, sys.argv[1].split(','))) if len(sys.argv) > 1 else (9.37, 47.915, 9.52, 48.005)
TAG = sys.argv[2] if len(sys.argv) > 2 else 'core'
jobs = {
  'land_use':  ('base', 'land_use', ['id','subtype','class','names','source_tags','geometry','surface']),
  'land':      ('base', 'land', ['id','subtype','class','names','source_tags','geometry','surface','elevation']),
  'water':     ('base', 'water', ['id','subtype','class','names','source_tags','geometry','is_intermittent']),
  'infrastructure': ('base', 'infrastructure', ['id','subtype','class','names','source_tags','geometry','height']),
  'segment':   ('transportation', 'segment', ['id','subtype','class','subclass','names','geometry','road_surface','road_flags','width_rules','level_rules','subclass_rules']),
  'building':  ('buildings', 'building', ['id','subtype','class','names','geometry','height','num_floors','roof_shape','roof_direction','roof_orientation','roof_height','roof_color','facade_color','roof_material','min_height','is_underground','sources']),
  'building_part':  ('buildings', 'building_part', ['id','names','geometry','height','num_floors','roof_shape','min_height','building_id']),
  'place':     ('places', 'place', ['id','names','categories','geometry','confidence']),
  'division':  ('divisions', 'division', ['id','subtype','class','names','geometry','population']),
}
which = sys.argv[3].split(',') if len(sys.argv) > 3 else list(jobs)
def clean(v):
    if isinstance(v, (bytes, bytearray)): return None
    if isinstance(v, list):
        # map columns come back as list of tuples
        if v and isinstance(v[0], tuple) and len(v[0]) == 2: return {k: clean(x) for k, x in v}
        return [clean(x) for x in v]
    if isinstance(v, tuple): return [clean(x) for x in v]
    if isinstance(v, dict): return {k: clean(x) for k, x in v.items()}
    return v
for name in which:
    theme, typ, cols = jobs[name]
    ds = ov.dataset(theme, typ)
    cols = [c for c in cols if c in ds.schema.names]
    t = ov.query(theme, typ, BBOX, columns=cols)
    feats = []
    for r in t.to_pylist():
        g = wkb.loads(r.pop('geometry'))
        props = {k: clean(v) for k, v in r.items() if v is not None}
        feats.append({'type': 'Feature', 'geometry': mapping(g), 'properties': props})
    json.dump({'type': 'FeatureCollection', 'features': feats}, open(f'{CACHE}/{TAG}_{name}.geojson', 'w'), ensure_ascii=False)
    print(name, len(feats), 'features')
