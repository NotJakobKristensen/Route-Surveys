"""Forest openness from Sentinel-2 (June/July 2026 median, 10 m): 0 = mature canopy … 1 = open ground / young growth."""
import numpy as np, json
from PIL import Image
from s2_bands import read_bands
from geo import CACHE, cp, Grid, rasterize, load
from scipy.ndimage import gaussian_filter, binary_opening, binary_closing
G = Grid(4096, 10)
X, Y = G.xy()
bands = {}
for sc in ['S2C_32UNU_20260619_0_L2A', 'S2B_32UNU_20260704_0_L2A']:
    b = read_bands(sc, ['B02', 'B03', 'B04', 'B08'], X, Y, order=1)
    for k, v in b.items(): bands.setdefault(k, []).append(v)
B = {k: np.median(np.stack(v), 0) for k, v in bands.items()}
np.save(cp('core10_bands.npy'), np.stack([B['B02'], B['B03'], B['B04'], B['B08']]))
forest = [f for f in load(cp('core_land.geojson')) + load(cp('core_land_use.geojson')) if f['properties'].get('class') in ('wood', 'forest') and f['geometry']['type'] in ('Polygon', 'MultiPolygon')]
F = np.asarray(rasterize(forest, G)) > 127
ndvi = (B['B08'] - B['B04']) / (B['B08'] + B['B04'] + 1e-6)
vis = (B['B02'] + B['B03'] + B['B04']) / 3
print('forest px', F.sum())
for name, arr in (('B03', B['B03']), ('B04', B['B04']), ('B08', B['B08']), ('vis', vis), ('ndvi', ndvi)):
    v = arr[F]; print(name, 'p5 %.3f p25 %.3f p50 %.3f p75 %.3f p95 %.3f' % tuple(np.percentile(v, [5, 25, 50, 75, 95])))
np.save(cp('core10_forest.npy'), F)
# candidate openness score: brighter visible & red than mature canopy
score = (B['B04'] - 0.018) / 0.03 + (B['B03'] - 0.035) / 0.03
img = np.zeros(F.shape + (3,), np.uint8)
rgb = np.clip((np.stack([B['B04'], B['B03'], B['B02']], -1) * 4) ** (1 / 2.2), 0, 1)
img[:] = (rgb * 255).astype(np.uint8)
c = 410; s = slice(c - 200, c + 200)
Image.fromarray(img[s, s]).resize((800, 800), Image.NEAREST).save('open_rgb.png')
sc = np.clip(score, -1, 3); sc[~F] = -1
Image.fromarray(((sc[s, s] + 1) / 4 * 255).astype(np.uint8)).resize((800, 800), Image.NEAREST).save('open_score.png')

o = np.clip(((B['B04'] - 0.018) / 0.03 + (B['B03'] - 0.035) / 0.03 - 0.5) / 2.0, 0, 1)
o = gaussian_filter(o, 0.6); o[~F] = 0
np.save(cp('core10_open.npy'), o.astype(np.float32))
print('open fraction (>0.5) in forest', (o[F] > 0.5).mean())
