"""Screen the whole route with the swept-path model: every stretch with a radius under 700 m is driven by the
virtual convoy; hot spots are where wheel units or the blade leave the carriageway."""
import routecfg
import os, pickle, sys, json, numpy as np
from pyproj import Transformer
from route_swept import V, resample, smooth, curvature_radius, simulate, half_width
C = routecfg.C
R = pickle.load(open(C + (sys.argv[1] if len(sys.argv) > 1 else 'route.pkl'), 'rb'))
T = Transformer.from_crs('EPSG:4326', 'EPSG:32633', always_xy=True)
import pyarrow.parquet as pq, pyarrow.compute as pc_
from route_graph import _restrictions
ids = {info['id'] for info, _ in R}
oneway = set()
TAG = os.environ.get('SCREEN_TAG', '')                 # a candidate route of the planner: screen_<tag>.npz / screen_spots_<tag>.json
for f in ('net_major', 'net_factory', 'net_site'):
    if not os.path.exists(C + f + '.parquet'): continue
    t = pq.read_table(C + f + '.parquet', columns=['id', 'access_restrictions'])
    t = t.filter(pc_.is_in(t['id'], value_set=__import__('pyarrow').array(list(ids))))
    for r in t.to_pylist():
        fw, bw, _ = _restrictions(r['access_restrictions'])
        if fw != bw: oneway.add(r['id'])
pts, hw, seg = [], [], []
def hw_of(info):
    h = half_width(info['cls'], info['sub'])
    # a one-way piece of an ordinary road: a carriageway split around a traffic island (one lane)
    if info['id'] in oneway and info['cls'] in ('primary', 'secondary', 'tertiary', 'unclassified', 'residential') and info['sub'] != 'link':
        h = min(h, 2.4)
    return h
for k, (info, pc) in enumerate(R):
    for j, p in enumerate(pc):
        if pts and j == 0: continue
        pts.append(p); hw.append(hw_of(info)); seg.append(k)
pts = np.array(pts); x, y = T.transform(pts[:, 0], pts[:, 1]); P0 = np.c_[x, y]
P, s_utm, d = resample(P0, 1.0)
# route km measured on the ellipsoid: UTM 33 metres are stretched by the scale factor away from 15° E
_k = 0.9996 * (1 + ((P[:, 0] - 500000.0) ** 2) / (2 * 6381000.0 ** 2))
s = np.r_[0, np.cumsum(np.hypot(*np.diff(P, axis=0).T) / ((_k[1:] + _k[:-1]) / 2))]
idx = np.clip(np.searchsorted(d, s_utm, side='right') - 1, 0, len(hw) - 1)      # attributes by UTM distance (same as d)
# the edge from vertex idx to idx + 1 belongs to the piece of its END vertex (a piece's first vertex is skipped above, so the
# vertex at idx is the previous piece's last one on every piece's first edge)
idx = np.clip(idx + 1, 0, len(hw) - 1)
HW = np.array(hw)[idx]; SEG = np.array(seg)[idx]
P = smooth(P, 4.0)
Rr, sg = curvature_radius(P)
need = np.zeros(len(P), bool)
for i in np.nonzero(Rr < 700)[0]: need[max(0, i - 20):i + 140] = True
# contiguous windows (with run-in so the dolly has a history)
wins = []; i = 0
while i < len(P):
    if need[i]:
        j = i
        while j < len(P) and need[j]: j += 1
        wins.append((i, j)); i = j
    else: i += 1
print(len(wins), 'windows,', int(need.sum()), 'm simulated of', len(P))
out = {k: np.full(len(P), np.nan) for k in ('wL', 'wR', 'bL', 'bR', 'off', 'wm')}
for a, b in wins:
    a0 = max(0, a - 120)
    res, _ = simulate(P[a0:b], HW[a0:b], i0=a - a0, i1=b - a0, clear=np.where(HW[a0:b] <= 3.45, 1.0, 0.5))
    for k in out: out[k][a:b] = res[k]
if not TAG: np.savez(C + 'screen.npz', P=P, s=s, HW=HW, SEG=SEG, R=Rr, **out)
inv = Transformer.from_crs('EPSG:32633', 'EPSG:4326', always_xy=True)
w = np.nan_to_num(np.maximum(out['wL'], out['wR'])); bo = np.nan_to_num(np.maximum(out['bL'], out['bR']))
score = 3 * w + bo
spots = []; taken = np.zeros(len(P), bool)
for i in np.argsort(-score):
    if score[i] < 0.5: break
    if taken[max(0, i - 250):i + 250].any(): continue
    taken[i] = True; spots.append(i)
print(len(spots), 'spots')
rows = []
for i in sorted(spots):
    info = R[SEG[i]][0]; lon, lat = inv.transform(*P[i])
    rows.append(dict(km=round(s[i] / 1000, 2), lon=round(lon, 5), lat=round(lat, 5), R=round(float(Rr[i])), wheel=round(float(w[i]), 2),
                     blade=round(float(bo[i]), 2), cls=info['cls'], sub=info['sub'], ref=info['ref'] or info['name'] or ''))
    print(f"{rows[-1]['km']:7.2f} km R={rows[-1]['R']:5d} wheel {rows[-1]['wheel']:5.2f} blade {rows[-1]['blade']:5.2f}  {info['cls']:9s} {str(info['sub']):5s} {rows[-1]['ref'][:24]:24s} {lat:.5f},{lon:.5f}")
json.dump(rows, open(C + (f'screen_spots_{TAG}.json' if TAG else 'screen_spots.json'), 'w'), indent=1)
