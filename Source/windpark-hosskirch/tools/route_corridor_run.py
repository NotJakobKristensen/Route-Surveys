"""Batch: photo strip + carriageway edges for every 500 m chunk whose region has an imagery source.
Usage: python3 route_corridor_run.py [workers] [region ...]"""
import os, sys, pickle, time, io, traceback
import numpy as np
from multiprocessing import Pool
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from route_corridor import OUT, CH, strip_points, paved_strip, other_side_mask, route, wide_points
from hd_sources import sample_source, SOURCES

REG = pickle.load(open(OUT + 'regions.pkl', 'rb'))['lab']


def region_of(c):
    k = min(len(REG) - 1, c)
    r = REG[k]
    return 'DE-BB' if r == 'DE-BE' else r


def wide_job(c):
    fn = OUT + f'{c:04d}w.webp'
    if os.path.exists(fn): return c, 'cached'
    try:
        from PIL import Image
        reg = region_of(c)
        ss, d, X, Y = wide_points(c)
        rgb = sample_source(reg, X, Y, res_m=2.0)
        b = io.BytesIO(); Image.fromarray(rgb).save(b, 'WEBP', quality=60, method=6)
        open(fn, 'wb').write(b.getvalue())
        return c, f'wide {len(b.getvalue()) // 1024} KB'
    except Exception as e:
        return c, 'ERR ' + repr(e) + traceback.format_exc()[-400:]


def job(c):
    fn = OUT + f'{c:04d}.npz'
    if os.path.exists(fn): return c, 'cached'
    try:
        from PIL import Image
        reg = region_of(c)
        ss, d, X, Y = strip_points(c)
        rgb = sample_source(reg, X, Y)
        # at a state border one service is blank (white / black) on the other side: fill from the neighbour
        blank = (rgb.min(-1) >= 250) | (rgb.max(-1) <= 3)
        if blank.mean() > 0.01:
            for alt in SOURCES:
                if alt == reg: continue
                try:
                    rgb2 = sample_source(alt, X, Y)
                except Exception:
                    continue
                ok2 = ~((rgb2.min(-1) >= 250) | (rgb2.max(-1) <= 3))
                fill = blank & ok2
                rgb[fill] = rgb2[fill]; blank &= ~fill
                if blank.mean() < 0.01: break
        if rgb.mean() < 3: return c, 'empty'
        ex = other_side_mask(c, d, X, Y)
        m, L, R, shL, shR = paved_strip(rgb, d, excl=ex)
        b = io.BytesIO(); Image.fromarray(rgb).save(b, 'WEBP', quality=62, method=6)
        open(OUT + f'{c:04d}.webp', 'wb').write(b.getvalue())
        np.savez_compressed(fn, s0=ss[0], L=L.astype(np.float16), R=R.astype(np.float16), shL=shL, shR=shR, reg=reg,
                            band=(np.abs(d).max()), kb=len(b.getvalue()) // 1024)
        return c, f'{reg} {len(b.getvalue()) // 1024} KB w {np.median(L + R):.1f}'
    except Exception as e:
        return c, 'ERR ' + repr(e) + traceback.format_exc()[-400:]


if __name__ == '__main__':
    nw = int(sys.argv[1]) if len(sys.argv) > 1 else 6
    regs = set(sys.argv[2:]) or set(SOURCES)
    n = int(np.ceil(route()['s'][-1] / CH))
    todo = [c for c in range(n) if region_of(c) in regs]
    print(len(todo), 'chunks', sorted(regs), flush=True)
    t = time.time()
    fnj = wide_job if os.environ.get('WIDE') else job
    with Pool(nw) as p:
        for i, (c, msg) in enumerate(p.imap_unordered(fnj, todo)):
            if i % 20 == 0 or 'ERR' in msg: print(i, c, msg, f'{time.time() - t:.0f}s', flush=True)
    print('done', time.time() - t)
