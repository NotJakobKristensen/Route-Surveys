import routecfg
import sys, pickle, math, time, numpy as np
sys.path.insert(0, '.')
from hd_sources import xyz_mosaic, bw_dop_tile, warp_to
from hd_bw import sample
from hd_road import carriageway, sdf
from pyproj import Transformer
from PIL import Image
C = routecfg.C
OUT = '/tmp/claude-0/-home-user-Interactive-Turbine-Lab/564bad2b-aee6-5ac6-9043-5b521443c8a3/scratchpad/'
hid = sys.argv[1]; i0 = int(sys.argv[2]); i1 = int(sys.argv[3])
D = pickle.load(open(C + 'hot/' + hid + '.pkl', 'rb'))
P = D['P'][i0:i1]; proj = D['proj']
px = 0.25; half = 40
ext = (P[:, 0].min() - half, P[:, 1].min() - half, P[:, 0].max() + half, P[:, 1].max() + half)
bw = Transformer.from_crs(proj, 'EPSG:4326', always_xy=True)
lo, la = bw.transform([ext[0], ext[2], ext[0], ext[2]], [ext[1], ext[1], ext[3], ext[3]])
t = time.time()
img, x0, y1, res = xyz_mosaic(bw_dop_tile, min(lo), min(la), max(lo), max(la), 19)
rgb = warp_to(img, x0, y1, res, proj, ext, px)
H, W = rgb.shape[:2]
X, Y = np.meshgrid(ext[0] + (np.arange(W) + .5) * px, ext[3] - (np.arange(H) + .5) * px)
tu = Transformer.from_crs(proj, 'EPSG:25832', always_xy=True)
UX, UY = tu.transform(X, Y)
ndom = sample('ndom1', UX, UY, order=0)
ndom = np.nan_to_num(ndom, nan=0)
print('fetch', time.time() - t, rgb.shape)
from shapely.geometry import box, LineString
bx = box(*ext)
rl = []
for r in D['roads']:
    if r['cls'] in ('footway', 'cycleway', 'path', 'steps', 'pedestrian'): continue
    from hd_road import road_pieces
    for L, isb in road_pieces(r):
        g = LineString(L).intersection(bx)
        for gg in getattr(g, 'geoms', [g]):
            if not gg.is_empty and gg.geom_type == 'LineString': rl.append((np.asarray(gg.coords), r['cls'], isb))
m = carriageway(rgb, ndom, ext, px, P, rl)
print('done', time.time() - t, 'paved m2', m.sum() * px * px)
ov = rgb.copy(); edge = m ^ __import__('scipy.ndimage', fromlist=['x']).binary_erosion(m, iterations=2)
ov[m] = (ov[m] * 0.6 + np.array([255, 120, 0]) * 0.4).astype(np.uint8); ov[edge] = (255, 0, 255)
Image.fromarray(ov).save(OUT + f'cw_{hid}.jpg', quality=85)
pickle.dump(dict(ext=ext, px=px, m=m), open(OUT + f'cw_{hid}.pkl', 'wb'))
