"""Shared geo helpers: local transverse-Mercator frame centred on the park, rasterisation."""
import json, os, numpy as np
CACHE = os.environ.get('WINDPARK_CACHE', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '.cache'))
os.makedirs(CACHE, exist_ok=True)
def cp(*p): return os.path.join(CACHE, *p)
from pyproj import Transformer
from PIL import Image, ImageDraw
from shapely.geometry import shape
LON0, LAT0 = 9.4452, 47.9595          # scene origin (≈ centroid of the 6 turbines)
PROJ = f'+proj=tmerc +lat_0={LAT0} +lon_0={LON0} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs'
fwd = Transformer.from_crs('EPSG:4326', PROJ, always_xy=True)
inv = Transformer.from_crs(PROJ, 'EPSG:4326', always_xy=True)
def to_local(lon, lat): return fwd.transform(lon, lat)
def to_lonlat(x, y): return inv.transform(x, y)
class Grid:
    """Square grid centred on the origin: half extent `ext` m, cell `res` m. Row 0 = north."""
    def __init__(self, ext, res):
        self.ext, self.res = ext, res; self.n = int(round(2 * ext / res))
        self.c = -ext + (np.arange(self.n) + 0.5) * res           # x of column centres
        self.r = ext - (np.arange(self.n) + 0.5) * res            # y of row centres
    def xy(self):
        return np.meshgrid(self.c, self.r)
    def px(self, x, y):  # local metres -> pixel coords (float, pixel edges at integers)
        return (x + self.ext) / self.res, (self.ext - y) / self.res
def load(path): return json.load(open(path))['features']
def iter_polys(geom):
    g = shape(geom) if isinstance(geom, dict) else geom
    if g.geom_type == 'Polygon': yield g
    elif g.geom_type in ('MultiPolygon', 'GeometryCollection'):
        for p in g.geoms:
            if p.geom_type == 'Polygon': yield p
def rasterize(features, grid, value=255, ss=1, img=None, width=None):
    """Rasterise polygons (or lines if width given, width in metres) of lon/lat features onto grid."""
    n = grid.n * ss
    if img is None: img = Image.new('L', (n, n), 0)
    d = ImageDraw.Draw(img)
    def P(coords):
        xs, ys = fwd.transform(*zip(*coords))
        px, py = grid.px(np.array(xs), np.array(ys))
        return list(zip(px * ss, py * ss))
    for f in features:
        g = shape(f['geometry']) if isinstance(f, dict) else f
        if width is not None:
            lines = [g] if g.geom_type == 'LineString' else (list(g.geoms) if g.geom_type == 'MultiLineString' else [])
            for l in lines:
                d.line(P(l.coords), fill=value, width=max(1, int(round(width / grid.res * ss))), joint='curve')
        else:
            for p in iter_polys(g):
                d.polygon(P(p.exterior.coords), fill=value)
                for r in p.interiors: d.polygon(P(r.coords), fill=0)
    return img
