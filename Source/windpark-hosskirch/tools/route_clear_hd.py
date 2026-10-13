"""Clear heights over the route inside the survey points, from the official 1 m laser terrain (DGM1) the passage view
stands on: the deck's top surface where it crosses the convoy's band minus the road under it there (its median over
the deck's footprint; the rise to its highest point under the deck widens the uncertainty).
route_clearance.py measures surface-minus-terrain along the route, which under a wide deck (a motorway's two
carriageways, a skewed crossing) reads the terrain model's interpolation across the cutting rather than the road; here
the road under the deck is the DGM1's (laser points reach under the deck from the side). The records override
route_clearance.py's for the same crossing (load_clear reads clear_hd.json first).
Inputs: bridges.pkl (route_bridges: crossings over the route with surface and terrain along their centreline), the
survey points (hot/<id>.pkl), the DGM1 sampler (hd_hot). → .cache/route/corr/clear_hd.json"""
import routecfg
import json, os, pickle, sys
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from pyproj import Transformer
from shapely.geometry import LineString, Point
from route_corridor import OUT
from route_clearance import depth_of
import hd_hot

C = routecfg.C
BAND = 4.5                                    # convoy band either side of the driving line (wheels + root adapter), m


def crossing(L, path):
    """the deck centreline's vertex nearest the driving line and every vertex's distance to it, or None when it does not
    reach within 6 m"""
    d = np.array([path.distance(Point(p)) for p in L])
    k = int(np.argmin(d))
    if d[k] > 6: return None
    return k, d


def areas():
    """the survey points (hot/<id>.pkl, their local frame), or with ALL=1 the whole route in pieces around each structure
    over it (UTM 33, the region of the structure) → (id, region, proj, ext, path points, structures)"""
    B = pickle.load(open(C + 'corr/bridges.pkl', 'rb'))
    if os.environ.get('ALL'):
        from route_corridor import route
        r = route(); s = r['s']; P = r['P']
        for b in sorted(B['over'].values(), key=lambda b: b['s0']):
            reg = b.get('reg')
            if reg not in hd_hot.HD_SET: continue
            i0, i1 = int(np.searchsorted(s, b['s0'] - 150)), int(np.searchsorted(s, b['s0'] + 150))
            Pw = P[i0:i1]
            if len(Pw) < 10: continue
            ext = (Pw[:, 0].min() - 60, Pw[:, 1].min() - 60, Pw[:, 0].max() + 60, Pw[:, 1].max() + 60)
            yield f"km{b['s0'] / 1000:.2f}", reg, 'EPSG:32633', ext, Pw, [b]
        return
    ids = sys.argv[1:] or [f[:-4] for f in sorted(os.listdir(C + 'hot')) if f.endswith('.pkl') and not f.endswith('_src.pkl')]
    for hid in ids:
        D = pickle.load(open(C + 'hot/' + hid + '.pkl', 'rb'))
        reg = hd_hot.region(hid)
        if reg not in hd_hot.HD_SET: continue
        yield hid, reg, D['proj'], D['ext'], np.asarray(D['P'])[:, :2], list(B['over'].values())


def main():
    out = []
    for hid, reg, proj, ext, P, structs in areas():
        tr = Transformer.from_crs('EPSG:32633', proj, always_xy=True)
        path = LineString(P)
        for b in structs:
            x, y = tr.transform(*b['xy'])
            if not (ext[0] <= x <= ext[2] and ext[1] <= y <= ext[3]): continue
            best = None
            for pt in b['parts']:
                L = np.asarray(pt['line'], float)
                if len(L) < 2 or pt['S'] is None: continue
                X, Y = tr.transform(L[:, 0], L[:, 1]); Lx = np.c_[X, Y]
                S = np.asarray(pt['S'], float)
                c = crossing(Lx, path)
                if c is None: continue
                k, d = c
                # the deck's top over the band: the surface along the centreline within half the deck's width + the band
                # of the driving line (a skewed deck covers the band over a longer stretch of its centreline)
                on = (d < b['width'] / 2 + BAND) & np.isfinite(S)
                if on.sum() < 2: continue
                top_s = float(np.median(S[on]))
                # the road under it: the driving line (±1.5 m, the lane) where it passes under the deck (within half the
                # deck's width); the band's edges can reach an abutment's slope or a cutting's side
                deck = LineString(Lx)
                i = int(np.argmin(np.hypot(P[:, 0] - Lx[k, 0], P[:, 1] - Lx[k, 1])))
                ii = np.arange(max(0, i - 60), min(len(P), i + 61))
                ii = ii[[deck.distance(Point(P[j])) < b['width'] / 2 and 0.5 < deck.project(Point(P[j])) < deck.length - 0.5 for j in ii]]   # not beyond its ends (the abutments)
                if len(ii) < 2: continue
                tx = P[np.minimum(ii + 1, len(P) - 1)] - P[np.maximum(ii - 1, 0)]
                tx /= np.maximum(np.hypot(tx[:, 0], tx[:, 1]), 1e-6)[:, None]
                nx = np.c_[-tx[:, 1], tx[:, 0]]
                off = np.array([-1.5, 0.0, 1.5])
                QX = P[ii, 0][:, None] + nx[:, 0][:, None] * off[None]; QY = P[ii, 1][:, None] + nx[:, 1][:, None] * off[None]
                try: G = hd_hot.sample_dgm(reg, proj, QX, QY)
                except Exception as ex: print('  terrain failed', hid, repr(ex)[:100], flush=True); G = None
                if G is None or not np.isfinite(G).any(): continue
                # under the deck the laser terrain is interpolated across it, so the road's level there is its median
                # over the footprint (the deck's centre on a climbing road) and the rise to its highest point the spread
                road = float(np.nanmedian(G[:, 1])); spread = float(np.nanmax(G)) - road
                top = top_s - road
                if best is None or top < best[0]: best = (top, road, top_s, int(len(ii)), spread)
            if best is None or not (2.5 < best[0] < 30) or best[4] > 2.5: continue     # (a road climbing steeply under it: left to route_clearance)
            dep, unc = depth_of(b['sub'], b['cls'])
            rec = dict(s0=b['s0'], reg=b.get('reg', reg), cls=b['cls'], sub=b['sub'], name=b['name'], found=True, s=b['s0'],
                       length=float(best[3]), top=round(best[0], 2), top_med=round(best[0], 2), est=round(best[0] - dep, 2),
                       unc=round(min(1.0, max(unc * 0.6, best[4])), 2), depth=dep, covered=1.0, src='DGM1 laser terrain', hid=hid,
                       road=round(best[1], 2), deck_top=round(best[2], 2))
            prev = next((q for q in out if round(q['s0']) == round(rec['s0'])), None)      # two structures mapped at one point:
            if prev is not None and prev['est'] <= rec['est']: continue                   # the lower one counts
            if prev is not None: out.remove(prev)
            out.append(rec)
            print(f"{hid:14s} {b['s0'] / 1000:8.2f} {b['sub']}/{b['cls']:12s} top {rec['top']:5.2f} est {rec['est']:5.2f}", flush=True)
    json.dump({"mapped": out, "scan": []}, open(OUT + os.environ.get("CLEAR_HD_OUT", "clear_hd.json"), "w"), indent=0)
    print('clear heights from DGM1', len(out))


if __name__ == '__main__':
    main()
