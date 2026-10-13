"""Sentinel-2 L2A surface reflectance (19 Jun 2026) resampled onto the local frame: core ±4096 m @ 8 m, wide ±12800 m @ 32 m."""
import io, numpy as np
from geo import CACHE, cp
from PIL import Image
from s2_bands import read_bands
def grid(ext, res):
    n = int(round(2 * ext / res)); c = -ext + (np.arange(n) + 0.5) * res
    return np.meshgrid(c, c[::-1])
for name, ext, res in (('core', 4096, 8), ('wide', 12800, 32)):
    X, Y = grid(ext, res)
    # Sentinel-2 content sits 2.0 m E / 0.4 m N of OSM (cross-correlated in the geo QA): sample with that offset
    b = read_bands('S2C_32UNU_20260619_0_L2A', ['B02', 'B03', 'B04'], X + 2.0, Y + 0.4, order=3)
    rgb = np.stack([b['B04'], b['B03'], b['B02']], -1)
    np.save(f'{CACHE}/s2_{name}_refl.npy', rgb.astype(np.float32))
    lin = np.clip(rgb * 2.5, 0, 1)
    srgb = np.where(lin <= 0.0031308, lin * 12.92, 1.055 * lin ** (1 / 2.4) - 0.055)
    im = Image.fromarray((srgb * 255 + 0.5).astype(np.uint8))
    im.save(f'{CACHE}/s2_{name}.png')
    for q in (60, 70, 80, 90):
        bio = io.BytesIO(); im.save(bio, 'WEBP', quality=q, method=6); bj = io.BytesIO(); im.save(bj, 'JPEG', quality=q, optimize=True, progressive=True)
        print(name, im.size, 'q', q, 'webp', len(bio.getvalue()), 'jpeg', len(bj.getvalue()))
