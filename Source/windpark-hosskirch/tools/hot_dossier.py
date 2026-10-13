"""Review dossier per survey point (for a reviewer, human or agent): the summary with every conflict in lat/lon, an overview
of the passage on the official aerial photo with the convoy's path, the traced carriageway, the wheel and blade swept areas
and where they leave the road, and close-ups (0.25 m) of the worst spots.
Usage: python hot_dossier.py <outdir> [ids…]"""
import routecfg
import json, os, pickle, sys
import numpy as np
from PIL import Image, ImageDraw
from pyproj import Transformer
import hd_hot
from hd_sources import sample_source

C = routecfg.C


def polys(g):
    if g is None or g.is_empty: return []
    return [p for p in getattr(g, 'geoms', [g]) if p.geom_type == 'Polygon']


def render(D, reg, box, px, fn, marks):
    x0, y0, x1, y1 = box
    W, H = int((x1 - x0) / px), int((y1 - y0) / px)
    X, Y = np.meshgrid(x0 + (np.arange(W) + .5) * px, y1 - (np.arange(H) + .5) * px)
    try: rgb = sample_source(reg, X, Y, crs_in=D['proj'], res_m=None if px < 0.5 else px)
    except Exception as ex: print('  photo failed', repr(ex)[:80]); rgb = np.full((H, W, 3), 90, np.uint8)
    im = Image.fromarray(rgb).convert('RGBA'); ov = Image.new('RGBA', im.size, (0, 0, 0, 0)); d = ImageDraw.Draw(ov)
    T = lambda xy: [((x - x0) / px, (y1 - y) / px) for x, y in xy]
    lw = max(1, int(0.6 / px)) if px < 0.5 else 2
    for p in polys(D['hd'].get('paved_photo') if D.get('hd') else D.get('paved')):
        d.line(T(p.exterior.coords), fill=(0, 255, 255, 200), width=lw)
    for p in polys(D.get('blade_sw')): d.polygon(T(p.exterior.coords), fill=(255, 230, 0, 50), outline=(255, 230, 0, 160))
    for p in polys(D.get('wheel_sw')): d.polygon(T(p.exterior.coords), fill=(255, 140, 0, 70), outline=(255, 140, 0, 200))
    for p in polys(D.get('blade_out')): d.polygon(T(p.exterior.coords), fill=(200, 0, 255, 110))
    for p in polys(D.get('wheel_out')): d.polygon(T(p.exterior.coords), fill=(255, 0, 0, 170))
    d.line(T(np.asarray(D['P'])[:, :2]), fill=(30, 120, 255, 230), width=lw)
    for k, (x, y, lab) in enumerate(marks):
        (u, v), = T([(x, y)]); r = 9
        d.ellipse((u - r, v - r, u + r, v + r), outline=(255, 0, 80, 255), width=3); d.text((u + r + 2, v - r), str(lab), fill=(255, 255, 255, 255))
    Image.alpha_composite(im, ov).convert('RGB').save(fn, quality=85)


def main():
    out = sys.argv[1]; os.makedirs(out, exist_ok=True)
    ids = sys.argv[2:] or [h[0] for h in routecfg.get('hot')]
    for hid in ids:
        fn = C + 'hot/' + hid + '.pkl'
        if not os.path.exists(fn): print('missing', hid); continue
        D = pickle.load(open(fn, 'rb')); sm = D['summary']; reg = hd_hot.region(hid)
        inv = Transformer.from_crs(D['proj'], 'EPSG:4326', always_xy=True)
        ll = lambda x, y: [round(v, 6) for v in inv.transform(x, y)[::-1]]
        od = os.path.join(out, hid); os.makedirs(od, exist_ok=True)
        conf = [dict(c, latlon=ll(*c['at'])) if 'at' in c else c for c in sm['conflicts']]
        P = np.asarray(D['P'])[:, :2]
        res = D['res']; w = np.nan_to_num(np.fmax(res['wL'], res['wR'])); b = np.nan_to_num(np.fmax(res['bL'], res['bR']))
        n = min(len(P), len(w))
        score = 3 * w[:n] + b[:n] / 4
        spots = []
        for i in np.argsort(-score):
            if score[i] <= 0.5 or len(spots) >= 3: break
            if all(np.hypot(*(P[i] - P[j])) > 250 for j in spots): spots.append(int(i))
        for c in conf:                                  # serious conflicts not already near a spot
            if c.get('sev', 0) >= 2 and 'at' in c and len(spots) < 5:
                j = int(np.argmin(np.hypot(*(P - np.asarray(c['at'])).T)))
                if all(np.hypot(*(P[j] - P[k])) > 250 for k in spots): spots.append(j)
        marks = [(c['at'][0], c['at'][1], k + 1) for k, c in enumerate(conf) if 'at' in c]
        pad = 90
        box = (P[:, 0].min() - pad, P[:, 1].min() - pad, P[:, 0].max() + pad, P[:, 1].max() + pad)
        px = max(0.5, max(box[2] - box[0], box[3] - box[1]) / 1800)
        render(D, reg, box, px, os.path.join(od, 'overview.jpg'), marks)
        zooms = []
        for k, i in enumerate(spots):
            cx, cy = P[i]; zb = (cx - 75, cy - 75, cx + 75, cy + 75)
            render(D, reg, zb, 0.15 if reg != 'PL-32' else 0.25, os.path.join(od, f'spot{k + 1}.jpg'), marks)
            zooms.append(dict(file=f'spot{k + 1}.jpg', km=round(sm['km'][0] + i / 1000, 2), latlon=ll(cx, cy), wheel_out_m=round(float(w[i]), 2), blade_out_m=round(float(b[i]), 1)))
        # every structure over the route inside the passage with its clear height (laser terrain / surface model estimate)
        from route_corridor import load_clear
        a_m, b_m = sm['km'][0] * 1000 - 30, sm['km'][1] * 1000 + 30
        clr = []
        for c in load_clear()['mapped']:
            if not (a_m <= c.get('s', c['s0']) <= b_m) or not c.get('found') or c.get('est') is None: continue
            clr.append(dict(km=round(c['s0'] / 1000, 2), structure=f"{c.get('sub')}/{c.get('cls')}", name=c.get('name'), clear_height_est_m=c['est'],
                            uncertainty_m=c.get('unc'), source=c.get('src', 'surface minus terrain model along the route'),
                            needed_m=4.8, verdict='below 4.8 m even at the top of its range' if c['est'] + c.get('unc', 0.5) < 4.8 else 'range reaches below 4.8 m' if c['est'] - c.get('unc', 0.5) < 4.8 else 'clears 4.8 m'))
        info = dict(sm, conflicts=conf, region=reg, spots=zooms, frame=D['proj'], clear_heights=clr,
                    legend='blue: convoy driving line; cyan: carriageway traced on the aerial photo; orange: wheel swept area; yellow: blade swept area; '
                           'red: wheels beyond the paved area; purple: blade beyond the road edge; numbered rings: conflicts (index = position in conflicts, 1-based)')
        json.dump(info, open(os.path.join(od, 'summary.json'), 'w'), ensure_ascii=False, indent=1, default=float)
        print(hid, len(conf), 'conflicts', len(zooms), 'spots', flush=True)


if __name__ == '__main__':
    main()
