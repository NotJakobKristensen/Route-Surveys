"""Multi-date Sentinel-2 reflectance (median of 4 summer 2026 scenes) around each turbine, 2.5 m grid (for pads_trace.py)."""
import json, numpy as np
from PIL import Image, ImageDraw
from geo import CACHE, cp, to_local
from s2_bands import read_bands
T = sorted([t for t in json.load(open(cp('wind_turbines_region.json'))) if t['tags'].get('model') == 'V172'], key=lambda t: t['tags']['ref:local'])
scenes = ['S2C_32UNU_20260619_0_L2A', 'S2B_32UNU_20260704_0_L2A', 'S2B_32UNU_20260724_0_L2A', 'S2B_32UNU_20260813_0_L2A']
R = 160; res = 2.5
tiles = []
res_all = {}
for t in T:
    tx, ty = to_local(t['lon'], t['lat'])
    xs = tx + np.arange(-R, R, res) + res / 2; ys = ty + R - np.arange(0, 2 * R, res) - res / 2
    X, Y = np.meshgrid(xs, ys)
    stack = []
    for sc in scenes:
        b = read_bands(sc, ['B02', 'B03', 'B04', 'B08'], X, Y, order=3)
        stack.append(b)
    # median across dates
    med = {k: np.median(np.stack([s[k] for s in stack]), 0) for k in stack[0]}
    ndvi = (med['B08'] - med['B04']) / (med['B08'] + med['B04'] + 1e-6)
    bright = (med['B02'] + med['B03'] + med['B04']) / 3
    res_all[t['tags']['ref:local']] = dict(ndvi=ndvi, bright=bright, rgb=np.stack([med['B04'], med['B03'], med['B02']], -1), x0=tx - R, y0=ty + R)
    rgb = np.clip((np.stack([med['B04'], med['B03'], med['B02']], -1) * 4.0) ** (1 / 2.2), 0, 1)
    im = Image.fromarray((rgb * 255).astype(np.uint8)); d = ImageDraw.Draw(im)
    c = R / res; d.ellipse([c - 2, c - 2, c + 2, c + 2], outline=(255, 0, 0))
    nd = Image.fromarray((np.clip((ndvi + 0.1) / 1.0, 0, 1) * 255).astype(np.uint8)).convert('RGB')
    tiles.append((im, nd, t['tags']['ref:local']))
    print(t['tags']['ref:local'], 'ndvi min %.2f  bright max %.3f' % (ndvi.min(), bright.max()))
np.save(cp('pads_raw.npy'), res_all, allow_pickle=True)
W = tiles[0][0].size[0]
m = Image.new('RGB', (W * 6 + 50, W * 2 + 10), (255, 255, 255))
for i, (im, nd, name) in enumerate(tiles):
    m.paste(im, (i * (W + 10), 0)); m.paste(nd, (i * (W + 10), W + 10))
m.save('pads_view.png'); print(m.size)
