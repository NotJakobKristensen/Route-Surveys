"""Bare-earth DTM: remove the forest canopy from the DSM (local edge-step offset, smoothed inside the forest)."""
import numpy as np, math, json
from scipy.ndimage import gaussian_filter, distance_transform_edt
from PIL import Image
from geo import *
G = Grid(12500, 10)
DSM = np.load(cp('g10_dsm.npy')); F = np.load(cp('g10_forest.npy'))
# remove tiny forest specks/holes effects: use forest mask as is
dist_in = distance_transform_edt(F) * G.res; dist_out = distance_transform_edt(~F) * G.res
inside = F & (dist_in > 25) & (dist_in < 65); outside = (~F) & (dist_out > 25) & (dist_out < 65)
def local_mean(v, m, s):
    num = gaussian_filter(np.where(m, v, 0).astype(np.float64), s); den = gaussian_filter(m.astype(np.float64), s)
    return num / np.maximum(den, 1e-9), den
mi, di = local_mean(DSM, inside, 8); mo, do = local_mean(DSM, outside, 8)
edge = F & (dist_in < 12) & (di > 0.03) & (do > 0.03)
step = np.clip(mi - mo, 0, 30)
num = gaussian_filter(np.where(edge, step, 0), 40); den = gaussian_filter(edge.astype(np.float64), 40)
glob = float(np.median(step[edge]))
offset = np.where(den > 1e-4, num / np.maximum(den, 1e-9), glob)
# blend towards the global median where edge support is weak
w = np.clip(den / 0.02, 0, 1); offset = w * offset + (1 - w) * glob
print('global step %.1f, offset range %.1f..%.1f' % (glob, offset[F].min(), offset[F].max()))
# soft forest mask: DSM canopy effect ramps over ~20 m across the edge (30 m DEM blur)
Fs = gaussian_filter(F.astype(np.float32), 1.5)
DTM = DSM - offset * Fs
# smooth inside forest (canopy roughness), keep open land detail
sm = gaussian_filter(DTM, 3.0)
wf = np.clip(gaussian_filter(F.astype(np.float32), 2.0) * 1.2, 0, 1)
DTM = (1 - wf) * DTM + wf * sm
np.save(cp('g10_dtm.npy'), DTM.astype(np.float32)); np.save(cp('g10_offset.npy'), offset.astype(np.float32))
def hill(Z, res):
    gy, gx = np.gradient(Z, res); az, alt = math.radians(315), math.radians(40)
    slope = np.arctan(np.hypot(gx, gy) * 2.0); aspect = np.arctan2(-gx, gy)
    hs = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)
    return np.clip(hs * 255, 0, 255).astype(np.uint8)
c = 1250; s = slice(c - 450, c + 450)
for name, Z in (('dsm', DSM), ('dtm', DTM)):
    h = hill(Z[s, s], 10); rgb = np.stack([h] * 3, -1).copy()
    e = F[s, s] ^ np.roll(F[s, s], 1, 0) | F[s, s] ^ np.roll(F[s, s], 1, 1); rgb[e] = [0, 150, 0]
    Image.fromarray(rgb).save(f'hill10_{name}.png')
T = [t for t in json.load(open(cp('wind_turbines_region.json'))) if t['tags'].get('model') == 'V172']
from scipy.ndimage import map_coordinates
for t in T:
    x, y = to_local(t['lon'], t['lat']); px, py = G.px(x, y)
    z1 = map_coordinates(DSM, [[py - 0.5], [px - 0.5]], order=1)[0]; z2 = map_coordinates(DTM, [[py - 0.5], [px - 0.5]], order=1)[0]
    print(t['tags']['ref:local'], 'x=%.1f y=%.1f  DSM %.1f  DTM %.1f' % (x, y, z1, z2))
