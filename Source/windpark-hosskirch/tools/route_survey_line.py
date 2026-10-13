"""Survey values along the whole route, every metre / every 10 m, from the measured carriageway edges:
left/right edge (photo), curve radius, junction turn, gradient (GLO-30), and on curves the swept path of the
convoy against the measured edges (route_swept.simulate with asymmetric half-widths).
Two passes: the edges pass (survey_line step: edges, shift = the middle of the carriageway, the swept path on that
middle as a first estimate) and, after route_lanes.py, SWEPT=1 (survey_swept step): the swept path again on the planned
line drv (keep right; the dolly kept in the convoy's own lane unless the road needs more; the edges widened to the painted
edge lines where the trace stopped short of them), so env / off and the 10 m rows wm / bL / bR / wo / off describe the
real driving line; the edges, shift and have stay as they are (and so does survey_1m.npz's time stamp, the key of
route_vprof's measurements).
→ .cache/route/corr/survey.npz, survey_1m.npz"""
import routecfg
import os, sys, glob, numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from scipy.ndimage import gaussian_filter1d, median_filter
from route_corridor import route, OUT, CH, PX
from route_swept import simulate, turn_angle, curvature_radius, V, Lateral


def swept_pass():
    """SWEPT=1: env / off (per metre) and wm / bL / bR / wo / off (per 10 m) on lanes_1m drv; everything else kept"""
    import time, warnings
    r = route(); P = r['P']; s = r['s']; n = len(s); Rc = r['R']
    S1 = dict(np.load(OUT + 'survey_1m.npz')); S10 = dict(np.load(OUT + 'survey.npz'))
    LN = np.load(OUT + 'lanes_1m.npz')
    L2 = S1['L'].astype(np.float32); R2 = S1['R'].astype(np.float32); have = S1['have'].astype(bool)
    if os.path.exists(OUT + 'lanelines.npz'):                           # the edges widened to the painted edge lines
        from route_lanes import edges_eff, context
        L2, R2 = (a.astype(np.float32) for a in edges_eff(L2.astype(float), R2.astype(float), context(r), np.load(OUT + 'lanelines.npz')))
    drv = LN['drv'].astype(np.float32); own = LN['own'].astype(np.float32) if 'own' in LN.files else np.full(n, np.nan, np.float32)
    t0 = time.time()
    # off the curves: the wheel units (dolly width) and the load (root frame) centred on the line
    hw, hl = V['dolly_w'] / 2, V['load_w'] / 2
    env = np.zeros((n, 4), np.float32); env[:, 0] = drv + hw; env[:, 1] = drv - hw; env[:, 2] = drv + hl; env[:, 3] = drv - hl
    off1 = np.zeros(n, np.float32)
    wm = np.full(n, np.nan, np.float32); bL = wm.copy(); bR = wm.copy(); wo = wm.copy(); off = wm.copy()
    idx = np.where(have & (Rc < 700))[0]
    runs = []
    if len(idx):
        a = b = idx[0]
        for i in idx[1:]:
            if i - b > 300: runs.append((a, b)); a = i
            b = i
        runs.append((a, b))
    for a, b in runs:
        a0 = max(0, a - 150); b1 = min(n, b + 60)
        while a0 < a and not have[a0:a0 + 1].all(): a0 += 1          # run-in only where the photo was measured
        if a - a0 < 60: continue
        hv = have[a0:b1]
        if hv.mean() < 0.8: continue
        o = drv[a0:b1].astype(float)
        Pc = P[a0:b1] + r['N'][a0:b1] * o[:, None]
        HWa = np.c_[L2[a0:b1] - o, R2[a0:b1] + o]
        clear = np.where((L2[a0:b1] + R2[a0:b1]) <= 6.9, 1.0, 0.5)
        ow = own[a0:b1] - o
        res, polys = simulate(Pc, HWa, i0=a - a0, clear=clear, keep=True, own=np.where(np.isfinite(ow), ow, 99.0))
        j = a; m = len(res['wm'])
        off1[j:j + m] = np.nan_to_num(res['off'])
        lat = Lateral(Pc, HWa)
        for ii, pg in enumerate(polys):
            if pg is None: continue
            for key, cols in (('wheel', (0, 1)), ('blade', (2, 3))):
                pts = np.r_[pg['tractor'], pg['front'], pg['dolly']] if key == 'wheel' else pg['blade']
                la, _, _, kk = lat(pts)
                la = la + o[kk]; kk = kk + a0
                np.maximum.at(env[:, cols[0]], kk, la)
                np.minimum.at(env[:, cols[1]], kk, la)
        wm[j:j + m] = res['wm']; bL[j:j + m] = res['bL']; bR[j:j + m] = res['bR']
        wo[j:j + m] = np.maximum(res['wL'], res['wR']); off[j:j + m] = res['off']
    env[~have] = [[hw, -hw, hl, -hl]]
    k10 = np.arange(0, n, 10)
    def agg(a, f):
        m = len(k10); A = np.full(m * 10, np.nan, np.float32); A[:n] = a
        return f(A.reshape(m, 10), axis=1)
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        S10.update(wm=agg(wm, np.nanmin), bL=agg(bL, np.nanmax), bR=agg(bR, np.nanmax), wo=agg(wo, np.nanmax), off=agg(off, np.nanmean))
    np.savez_compressed(OUT + 'survey.npz', **S10)
    # survey_1m: only env and off change — the edges keep their time stamp (route_vprof keys its measurements on it)
    st = os.stat(OUT + 'survey_1m.npz')
    S1.update(env=env.astype(np.float16), off=off1.astype(np.float16))
    np.savez_compressed(OUT + 'survey_1m.tmp.npz', **S1); os.replace(OUT + 'survey_1m.tmp.npz', OUT + 'survey_1m.npz')
    os.utime(OUT + 'survey_1m.npz', ns=(st.st_atime_ns, st.st_mtime_ns))
    print(f'swept path on the planned line: {len(runs)} curve windows, min wheel clearance {np.nanmin(wm):.2f} m, '
          f'wheels off > 0.1 m on {(np.nan_to_num(wo) > 0.1).sum()} m ({time.time() - t0:.0f} s)', flush=True)


if os.environ.get('SWEPT') == '1':
    swept_pass(); sys.exit()

r = route(); P = r['P']; s = r['s']; n = len(s)
Lm = np.full(n, np.nan, np.float32); Rm = np.full(n, np.nan, np.float32); have = np.zeros(n, bool)
shLm = np.zeros(n, bool); shRm = np.zeros(n, bool)
band = 16.0
for fn in sorted(glob.glob(OUT + '[0-9][0-9][0-9][0-9].npz')):
    z = np.load(fn)
    L = z['L'].astype(np.float32); R = z['R'].astype(np.float32)
    s0 = float(z['s0'])
    i0 = int(np.searchsorted(s, s0))
    k = len(L) // 4 * 4
    Lr = np.median(L[:k].reshape(-1, 4), 1); Rr = np.median(R[:k].reshape(-1, 4), 1)
    i1 = min(n, i0 + len(Lr))
    Lm[i0:i1] = Lr[:i1 - i0]; Rm[i0:i1] = Rr[:i1 - i0]; have[i0:i1] = True
    if 'shL' in z.files:
        shLm[i0:i1] = z['shL'][:k].reshape(-1, 4).any(1)[:i1 - i0]; shRm[i0:i1] = z['shR'][:k].reshape(-1, 4).any(1)[:i1 - i0]
# flags: open = edge at the band limit (junction mouth, lay-by, parallel paved area); occluded = centre not seen paved
openL = have & (Lm >= band - 0.6); openR = have & (Rm >= band - 0.6)
occl = have & ((Lm <= 0.3) | (Rm <= 0.3))
# erratic edges (canopy, broken shadows): local spread over 21 m above 1 m, or an edge set by a shadow
from scipy.ndimage import uniform_filter1d
def erratic(a):
    a = np.nan_to_num(a); m1 = uniform_filter1d(a, 21); m2 = uniform_filter1d(a * a, 21)
    return np.sqrt(np.maximum(m2 - m1 * m1, 0)) > 1.0
badL = have & (erratic(Lm) | shLm); badR = have & (erratic(Rm) | shRm)
def fill(a, bad):
    a = a.copy(); ok = have & ~bad & np.isfinite(a)
    idx = np.arange(n)
    if ok.sum() > 2: a[have & bad] = np.interp(idx[have & bad], idx[ok], a[ok])
    return a
# the carriageway edge used for the vehicle: occlusions bridged, junction mouths limited to the usual edge nearby
L2 = fill(Lm, occl | openL | badL); R2 = fill(Rm, occl | openR | badR)
occl = occl | badL | badR
from scipy.ndimage import grey_closing, grey_opening
# along the route: dips shorter than 21 m (a car or lorry on the lane edge, arrows, shadow of a sign) are closed,
# widenings shorter than 11 m (driveway mouths, lay-by corners) opened; longer changes are real
def clean1d(a):
    a = np.nan_to_num(a)
    a = grey_closing(a, size=21)
    a = grey_opening(a, size=11)
    return median_filter(a, 5)
L2 = clean1d(L2); R2 = clean1d(R2)
# motorways / dual carriageways: the width does not drop by more than 1.5 m for less than ~80 m; such dips are a
# shadow or a vehicle hiding the edge → the 201 m running median there (flagged as hidden)
import pickle
Ru = pickle.load(open(routecfg.C + 'route.pkl', 'rb'))
cls = np.array([Ru[k][0]['cls'] for k in range(len(Ru))])[r['SEG']]
fast = np.isin(cls, ['motorway', 'trunk'])
def dips(a):
    med = median_filter(a, 201)
    bad = (a < med - 1.5)
    lab = np.cumsum(np.r_[True, bad[1:] != bad[:-1]])
    out = a.copy()
    for g in np.unique(lab[bad & fast]):
        m = lab == g
        if m.sum() < 80: out[m] = med[m]; occl[m] = True
    return out
L2 = dips(L2); R2 = dips(R2)
shift = np.clip(gaussian_filter1d((L2 - R2) / 2.0, 25), -6, 6).astype(np.float32)
# curvature, turn
Rc = curvature_radius(P[::1], half=25) if False else r['R']
turn = np.zeros(n, np.float32)
# swept path on curves (R < 700 m) against the measured edges
env = np.zeros((n, 4), np.float32)     # swept envelope per metre: wheels left/right, blade left/right (lateral, m; left +)
pass
off1 = np.zeros(n, np.float32)
wm = np.full(n, np.nan, np.float32); bL = np.full(n, np.nan, np.float32); bR = bL.copy(); wo = bL.copy(); off = bL.copy()
env[:, 0] = shift + 1.45; env[:, 1] = shift - 1.45; env[:, 2] = shift + 2.1; env[:, 3] = shift - 2.1
env[:, 0][~have] = 1.45; env[:, 1][~have] = -1.45; env[:, 2][~have] = 2.1; env[:, 3][~have] = -2.1
cur = have & (Rc < 700)
idx = np.where(cur)[0]
if len(idx):
    # windows: runs of curve samples, padded 150 m (blade run-in), merged
    runs = []; a = idx[0]; b = idx[0]
    for i in idx[1:]:
        if i - b > 300: runs.append((a, b)); a = i
        b = i
    runs.append((a, b))
    for a, b in runs:
        a0 = max(0, a - 150); b1 = min(n, b + 60)
        while a0 < a and not have[a0:a0 + 1].all(): a0 += 1          # run-in only where the photo was measured
        if a - a0 < 60: continue
        # the convoy drives on the middle of the measured carriageway (the mapped line can sit near one edge)
        sh = shift[a0:b1]
        Pc = P[a0:b1] + r['N'][a0:b1] * sh[:, None]
        HWa = np.c_[L2[a0:b1] - sh, R2[a0:b1] + sh]
        hv = have[a0:b1]
        if hv.mean() < 0.8: continue
        clear = np.where((L2[a0:b1] + R2[a0:b1]) <= 6.9, 1.0, 0.5)
        res, polys = simulate(Pc, HWa, i0=a - a0, clear=clear, keep=True)
        j = a
        m = len(res['wm'])
        off1[j:j + m] = np.nan_to_num(res['off'])
        lat = Lateral(Pc, HWa)
        for ii, pg in enumerate(polys):
            if pg is None: continue
            for key, cols in (('wheel', (0, 1)), ('blade', (2, 3))):
                pts = np.r_[pg['tractor'], pg['front'], pg['dolly']] if key == 'wheel' else pg['blade']
                la, _, _, kk = lat(pts)
                la = la + sh[kk]
                kk = kk + a0
                np.maximum.at(env[:, cols[0]], kk, la)
                np.minimum.at(env[:, cols[1]], kk, la)
        wm[j:j + m] = res['wm']; bL[j:j + m] = res['bL']; bR[j:j + m] = res['bR']
        wo[j:j + m] = np.maximum(res['wL'], res['wR']); off[j:j + m] = res['off']
        print('window', round(s[a] / 1000, 1), round(s[b] / 1000, 1), 'min wheel clr', np.nanmin(res['wm']).round(2), flush=True)
# elevation → grade over 100 m (smoothed); per 10 m rows
E = np.load(OUT + 'elev.npz'); z10 = gaussian_filter1d(np.nan_to_num(E['z0']), 4)
g10 = np.gradient(z10, 10.0) * 100
k10 = np.arange(0, n, 10)
def agg(a, f):
    m = len(k10); out = np.full(m, np.nan, np.float32)
    A = np.full(m * 10, np.nan, np.float32); A[:n] = a
    return f(A.reshape(m, 10), axis=1)
import warnings; warnings.simplefilter('ignore')
np.savez_compressed(OUT + 'survey.npz', s10=s[k10].astype(np.float32),
                    L=agg(np.where(have, L2, np.nan), np.nanmin), R=agg(np.where(have, R2, np.nan), np.nanmin),
                    Lraw=agg(np.where(have, Lm, np.nan), np.nanmedian), Rraw=agg(np.where(have, Rm, np.nan), np.nanmedian),
                    openL=agg(openL.astype(float), np.nanmax), openR=agg(openR.astype(float), np.nanmax), occl=agg(occl.astype(float), np.nanmean),
                    Rc=agg(Rc.astype(np.float32), np.nanmin), z=z10.astype(np.float32), grade=g10.astype(np.float32),
                    wm=agg(wm, np.nanmin), bL=agg(bL, np.nanmax), bR=agg(bR, np.nanmax), wo=agg(wo, np.nanmax), off=agg(off, np.nanmean),
                    have=agg(have.astype(float), np.nanmean))
np.savez_compressed(OUT + 'survey_1m.npz', shift=shift.astype(np.float16), env=env.astype(np.float16), off=off1.astype(np.float16), L=np.nan_to_num(L2).astype(np.float16), R=np.nan_to_num(R2).astype(np.float16), have=have)
print('saved', have.mean())
