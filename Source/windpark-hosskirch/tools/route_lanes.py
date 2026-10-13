"""Keep right, lane 2 or the oncoming lane, along the whole route — the user's rule: the convoy stays in the right side of
the road; only where the right side is not sufficient but the left side is, it takes the left side (lane 2 of a motorway
or dual carriageway, the oncoming lane of a two-way road; the escort closes it).

keep_right() lays the line for every metre: on a one-way carriageway of two lanes or more the centre of the right lane
(the painted lines, route_lanelines.py; an exit lane where the route leaves by it), on a one-way single lane (ramps) the
middle of the lane, on a two-way road the middle of the right half (at least the wheel clearance plus half the widest
unit from the right edge, never past the centre line), on tracks and service roads the middle. On every curve window
(radius under 700 m, any road) route_swept.lane_plan compares it with the cheapest line leftwards; that line is kept only
on the stretches where keeping right is not sufficient (wheels off the road or beyond the own lane by more than 0.15 m,
or the blade into a mapped obstacle) and the left line is (its wheels on the road), else the stretch keeps right.
→ .cache/route/corr/lanes_1m.npz, per metre, m from the route line, left +: drv the planned tractor line; kr the keep-
  right line; own the left boundary of the convoy's own lane; left the wheels beyond own (every metre; on curve windows
  from the swept path, elsewhere the widest unit on the line); acw / acb wheels / wheels or blade beyond own on curve
  windows (NaN elsewhere, as before); krw keep-right wheel clearance (< 0: off the road or beyond own); krx keep-right
  wheels beyond own; krb blade beyond the right edge keeping right; rcb / rcw blade beyond either edge / wheel clearance
  on drv; tw two-way; multi one-way with two lanes or more
  and lanes.json: the stretches where the wheels on drv go beyond own by more than 0.4 m (or drv is more than 0.3 m left
  of keep right with the wheels beyond own), with kind 'oncoming' (two-way) or 'lane2' (multi-lane one-way)."""
import routecfg
import os, sys, json, pickle, time, numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from route_corridor import route, OUT
from route_swept import lane_plan, simulate, offset_path, beyond, V
from route_lanelines import twoway_mask, context, runs_of            # (twoway_mask kept importable from here)
from scipy.ndimage import gaussian_filter1d, minimum_filter1d

C = routecfg.C
CLEAR = 0.5                                                           # wheel clearance to the edge (route_swept.simulate)
WMAX = max(V['tractor_w'], V['fdolly_w'], V['dolly_w'])               # the widest wheel unit
# mapped things beside the road the overswinging blade (underside ≥ 1.6 m) would touch
TALL = {'street_lamp', 'traffic_signals', 'power_pole', 'power_tower', 'catenary_mast', 'communication_tower', 'mobile_phone_tower',
        'mast', 'tower', 'information', 'stop', 'give_way', 'bus_stop', 'charging_station', 'artwork', 'vending_machine'}
WALLS = {'wall', 'noise_barrier', 'retaining_wall', 'city_wall', 'fence', 'hedge'}


def clean_runs(m, minlen):
    """a boolean per metre with its runs (True and False) shorter than minlen merged into their neighbours"""
    m = m.copy()
    for _ in range(2):
        for a, b in runs_of(m):
            if b - a < minlen: m[a:b] = False
        for a, b in runs_of(~m):
            if b - a < minlen and a > 0 and b < len(m): m[a:b] = True
    return m


def edges_eff(L, R, ctx, LL):
    """the measured edges widened to the painted edge lines (+0.3 m) where those lie outside them (the trace stopped at a
    shadow, a vehicle or a lane line; the paved road reaches at least that far) — for the line and the swept path; the
    survey's own edges stay as measured"""
    eR = LL['eR'].astype(float); eL = LL['eL'].astype(float); rR = LL['rR'].astype(float); lq = LL['lq']; kind = ctx['kind']
    # (one-way: the edge line at the right lane's right line or up to 1.5 m beyond it — not an exit lane's far line)
    okR = (lq >= 1) & np.isfinite(eR) & ((kind == 1) | ((kind == 2) & (eR >= rR - 1.5) & (eR <= rR + 0.5)))
    okL = (lq >= 1) & np.isfinite(eL) & (kind >= 1)
    # (where the detection was implausible, route_lanelines carries the lines over from the good windows either side, lq 0
    # with the lines set — a fallback without any line has none: those widen a carriageway's edges the same way)
    rL = LL['rL'].astype(float)
    with np.errstate(invalid='ignore'):
        okR |= (lq == 0) & (kind == 2) & np.isfinite(eR) & np.isfinite(rR) & (eR >= rR - 1.5) & (eR <= rR + 0.5)
        okL |= (lq == 0) & (kind == 2) & np.isfinite(eL) & np.isfinite(rL)
    return np.where(okL, np.maximum(L, eL + 0.3), L), np.where(okR, np.maximum(R, -eR + 0.3), R)


def keep_right(L, R, have, ctx, LL, isl=None):
    """per metre: kr (the keep-right tractor line), own (left boundary of the convoy's own lane), multi (one-way with two
    lanes or more), pl (cost of each metre left of kr in lane_plan) — L / R the measured edges, ctx route_lanelines.
    context, LL lanelines.npz, isl the right edge of a traffic or pedestrian island on a two-way carriageway (NaN none)"""
    n = len(L)
    Ls = gaussian_filter1d(L, 15, mode='nearest'); Rs = gaussian_filter1d(R, 15, mode='nearest')
    W = Ls + Rs; c = (Ls - Rs) / 2
    kind = ctx['kind']; tw = kind == 1; one = kind == 2
    rR = LL['rR'].astype(float); rL = LL['rL'].astype(float); nl = LL['nl'].astype(int)
    cl = LL['cl'].astype(float) if 'cl' in LL.files else np.full(n, np.nan)
    eR = LL['eR'].astype(float); eL = LL['eL'].astype(float)
    # one-way: two lanes or more where painted so (9 m wide where nothing is painted); runs under 150 m merged
    multi = clean_runs(one & ((nl >= 2) | ((nl == 0) & (W >= 9))), 150) & one
    # (lane lines carried across a diverge lie well beyond the paved edge there: not the convoy's lane; within 1.5 m the
    # trace stopped short of the edge line, at a shadow or the shoulder's edge)
    with np.errstate(invalid='ignore'):
        lane = np.where((rR < -Rs - 1.5) | (rL > Ls + 1.5), np.nan, (rR + rL) / 2)
        # (no lane there on a carriageway of two lanes or more: a lane's width right of its left line, else close to the
        # right edge — not the carriageway's middle, which is a lane line)
        lane_m = np.where(np.isfinite(lane), lane, np.where(np.isfinite(rL) & (rL < Ls) & (rL > -Rs + 2.0), rL - 1.9, -Rs + CLEAR + WMAX / 2))
    # one-way: the centre of the right lane of a carriageway; a single lane (ramp): the middle of the paved width
    kr = np.where(one & multi, lane_m, c)
    own = np.where(multi & np.isfinite(rL), rL, Ls)
    # two-way: the middle of the right half — from the right edge to the painted centre line (where it lies near the paved
    # middle, or within 1 m of the mapped line where a junction widens the road, a lane's width from both edges), else the
    # paved middle, else (a road traced over 9 m wide with its middle more than 1.5 m off the mapped line: a verge or yard
    # traced as paved) the mapped line; the right half at most 4.5 m wide — at least the wheel clearance plus half the
    # widest unit from the right edge, never past the centre line
    with np.errstate(invalid='ignore'):
        okc = np.isfinite(cl) & ((np.abs(cl - c) < 1.5) | (np.abs(cl) < 1.0)) & (cl + Rs >= 2.6) & (Ls - cl >= 2.6)
    cm = np.where(okc, cl, np.where((np.abs(c) > 1.5) & (W > 9), 0.0, c))
    Rk = np.minimum(Rs, 4.5 - cm); Wr = cm + Rk                          # (the right half: from −Rk to cm, ≤ 4.5 m)
    kr = np.where(tw, -Rk + np.minimum(Wr, np.maximum(Wr / 2, CLEAR + WMAX / 2)), kr)
    own = np.where(tw, cm, own)
    # no steps of a few metres where a painted line comes and goes: a 21 m median and a 8 m Gaussian within each run of
    # one road kind
    from scipy.ndimage import median_filter
    edge = np.r_[0, np.nonzero(kind[1:] != kind[:-1])[0] + 1, n]
    for a, b in zip(edge[:-1], edge[1:]):
        if b - a > 25:
            for arr in (kr, own):
                arr[a:b] = gaussian_filter1d(median_filter(arr[a:b], 21, mode='nearest'), 8, mode='nearest')
    # a traffic or pedestrian island on a two-way road is the left boundary of the own lane (0.3 m clear of its kerb);
    # the line keeps the wheel clearance plus half the widest unit right of it where the road allows
    if isl is not None:
        m = tw & np.isfinite(isl)
        own = np.where(m, np.minimum(own, isl - 0.3), own)
        kr = np.where(m, np.minimum(kr, own - CLEAR - WMAX / 2), kr)
    # on the paved road: at least the wheel clearance plus half the widest unit inside both edges (the middle where the
    # road is narrower) — a painted lane read beyond the traced edge (ramps, junction mouths) does not take the line off it;
    # on two-way roads that much inside the narrowest right edge within 20 m (the line moves before a narrowing, not after)
    m_ = (Ls + Rs) >= 2 * (CLEAR + WMAX / 2)
    kr = np.where(m_, np.clip(kr, -Rs + CLEAR + WMAX / 2, Ls - CLEAR - WMAX / 2), c)
    kr = np.where(tw & m_, np.minimum(np.maximum(kr, -minimum_filter1d(R, 41) + CLEAR + WMAX / 2), Ls - CLEAR - WMAX / 2), kr)
    kr = np.where(have, kr, 0.0); own = np.where(have, own, np.nan)
    pl = np.where(tw, 1.0, np.where(multi, 0.5, 0.2))
    return kr, own, multi, pl


def islands(r):
    """per metre: the right edge (m from the route line, left +) of a mapped traffic island or pedestrian crossing island
    in the middle of the road (route_osm.py's tags: island areas reaching within 1.5 m of the route line, crossing:island /
    traffic_calming=island nodes on it taken as 2 m wide), NaN where none"""
    fn = OUT + 'osm_tags.json'; n = len(r['s']); out = np.full(n, np.nan)
    if not os.path.exists(fn): return out
    from scipy.spatial import cKDTree
    T = json.load(open(fn)); s = r['s']; P, N = r['P'], r['N']; kd = cKDTree(P)
    for q in T.get('points', []):
        t = q.get('tags') or {}
        if not (t.get('crossing:island') == 'yes' or t.get('traffic_calming') == 'island') or abs(q.get('d', 99)) > 2: continue
        i = int(np.searchsorted(s, q['s'])); a, b = max(0, i - 10), min(n, i + 11)
        out[a:b] = np.fmin(out[a:b], q['d'] - 1.0)
    for q in T.get('areas', []):
        if q.get('kind') not in ('traffic_island', 'island') or len(q.get('xy') or []) < 3: continue
        xy = np.asarray(q['xy'], float)[:, :2]; dd, k = kd.query(xy); k = np.minimum(k, n - 1)
        if dd.min() > 12: continue
        lat = ((xy - P[k]) * N[k]).sum(1)
        if lat.min() > 1.5 or lat.max() < -1.5: continue                   # (not on the middle of the road: a slip lane's)
        a, b = max(0, int(k.min()) - 3), min(n, int(k.max()) + 4)
        out[a:b] = np.fmin(out[a:b], float(lat.min()))
    return out


def obstacles(r, L, R):
    """per metre: distance (m) from the route line to the nearest mapped thing the blade could touch beyond the paved edge
    (signs, lamps, poles, walls, fences, buildings; within 25 m), left and right; inf where none"""
    from scipy.spatial import cKDTree
    P, N = r['P'], r['N']; n = len(P); kd = cKDTree(P)
    pts = []
    O = pickle.load(open(OUT + 'objects.pkl', 'rb'))['blocks'] if os.path.exists(OUT + 'objects.pkl') else {}
    def line_pts(xy, step=1.0):
        xy = np.asarray(xy, float)[:, :2]; sl = np.hypot(*np.diff(xy, axis=0).T)
        if not len(sl): return xy
        cs = np.r_[0, np.cumsum(sl)]; ss = np.arange(0, cs[-1] + 1e-9, step)
        return np.c_[np.interp(ss, cs, xy[:, 0]), np.interp(ss, cs, xy[:, 1])]
    for b in O.values():
        pts += [o['xy'] for o in b['pts'] if o['cls'] in TALL]
        for l in b['lines']:
            if l['cls'] in WALLS:
                for g in getattr(l['g'], 'geoms', [l['g']]): pts += list(line_pts(g.exterior.coords if hasattr(g, 'exterior') else g.coords))
        for o in b['bld']:
            for g in getattr(o['g'], 'geoms', [o['g']]):
                if hasattr(g, 'exterior'): pts += list(line_pts(g.exterior.coords, 2.0))
    oL = np.full(n, np.inf); oR = np.full(n, np.inf)
    if pts:
        Q = np.asarray(pts, float); dd, k = kd.query(Q, distance_upper_bound=26); ok = np.isfinite(dd); k = np.minimum(k, n - 1)
        lat = ((Q - P[k]) * N[k]).sum(1)
        okL = ok & (lat > 0) & (lat > L[k] - 0.3); okR = ok & (lat < 0) & (-lat > R[k] - 0.3)
        np.minimum.at(oL, k[okL], lat[okL]); np.minimum.at(oR, k[okR], -lat[okR])
    # the signs of the signs step (not the delineator posts: 1 m, under the blade)
    if os.path.exists(OUT + 'signs.json'):
        s = r['s']
        for g in json.load(open(OUT + 'signs.json')):
            if str(g.get('code')) == '620' or str(g.get('src', '')).startswith('standard'): continue
            i = int(min(n - 1, np.searchsorted(s, g['s']))); d = float(g['d'])
            if d > 0 and d > L[i] - 0.3: oL[i] = min(oL[i], d)
            elif d < 0 and -d > R[i] - 0.3: oR[i] = min(oR[i], -d)
    return np.c_[minimum_filter1d(oL, 5), minimum_filter1d(oR, 5)]


# ───────────────────────────── one curve window (run in workers) ─────────────────────────────
G = {}


def window(job):
    a0, a, b1 = job
    g = G; i0 = a - a0; sl = slice(a0, b1)
    P, L, R, own, obst = g['P'][sl], g['L'][sl], g['R'][sl], g['own'][sl], g['obst'][sl]
    try:
        out = lane_plan(P, L, R, i0=i0, twoway=g['tw'][sl], kr_o=g['kr'][sl], own=own, pl=g['pl'][sl], obst=obst,
                        reach=4.5 if g['multi'][a] else None, lazy=True)
    except Exception as ex:
        return job, None, repr(ex)[:160]
    kr, rec = out['kr'], out['rec']; kres, rres = kr['res'], rec['res']
    m = len(kres['wm']); ko, ro = kr['o'], rec['o']
    # keeping right is not sufficient: wheels off the road or beyond the own lane, or the blade into a mapped obstacle
    k_off = np.nan_to_num(np.maximum(kres['wL'], kres['wR'])); k_bo = np.nan_to_num(kres.get('bo', np.zeros(m)))
    r_off = np.nan_to_num(np.maximum(rres['wL'], rres['wR'])); r_bo = np.nan_to_num(rres.get('bo', np.zeros(m)))
    dl = (L - own)[i0:i0 + m]
    k_road = np.maximum(np.nan_to_num(kres['wR']), np.maximum(0, np.nan_to_num(kres['wL']) - dl))   # (off the road itself)
    bad_right = (k_off > 0.15) | (k_bo > 0.3)
    fixes = (r_off <= 0.15) & (r_bo <= np.maximum(0.3, k_bo))         # the left line is sufficient here
    worse = (r_off > k_road + 0.15) | (r_bo > k_bo + 0.3)             # … and nowhere worse than keeping right
    use = np.zeros(b1 - a0, bool)
    if rres is not kres:
        for p, q in runs_of((ro - ko) > 0.05):                         # where the left line leaves keeping right
            pp, qq = max(p, i0) - i0, max(q, i0) - i0                  # (its positions with a swept path)
            if qq <= pp: continue
            br = bad_right[pp:qq]
            if br.any() and fixes[pp:qq][br].mean() >= 0.8 and not worse[pp:qq].any(): use[p:q] = True
            else:
                # keeping right puts the wheels off the road itself and the left line brings them back on (on 75 % of those
                # metres): taken where it is the cheaper by lane_plan's own weights (40 per metre of wheels off the road, 0.6
                # per metre of blade into a mapped obstacle), not vetoed by a little more overswing
                wo = k_road[pp:qq] > 0.15
                if wo.any() and (r_off[pp:qq][wo] <= 0.15).mean() >= 0.75 and \
                        40 * r_off[pp:qq].sum() + 0.6 * r_bo[pp:qq].sum() < 40 * k_road[pp:qq].sum() + 0.6 * k_bo[pp:qq].sum(): use[p:q] = True
    line = np.where(use, ro, ko)
    if out['ok_right']: fin, fp = kres, kr['polys']                    # it fits in its own lane: as planned
    else:
        # the convoy on the chosen line with the whole road: wheels on the road first, then in its own lane (the escort
        # closes the other where the dolly or the wheels need it), then the least overswing
        Pl, _ = offset_path(P, line); clr = np.where(L + R <= 6.9, 1.0, 0.5)
        fin, fp = simulate(Pl, np.c_[L - line, R + line], i0=i0, keep=True, clear=clr, own=own - line,
                           obst=np.c_[obst[:, 0] - line, obst[:, 1] + line])
    acb, acw = beyond(P, own, fp)
    acb, acw = acb[i0:i0 + m], acw[i0:i0 + m]
    if out['ok_right']:                                                # (keeping right, its left edge was own)
        f_off = np.maximum(np.nan_to_num(fin['wR']), np.maximum(0, np.nan_to_num(fin['wL']) - dl))
        rcb = np.maximum(np.maximum(0, np.nan_to_num(fin['bL']) - dl), np.nan_to_num(fin['bR'])); rcw = fin['wmR']
    else:
        f_off = np.nan_to_num(np.maximum(fin['wL'], fin['wR'])); rcb = np.nan_to_num(np.maximum(fin['bL'], fin['bR'])); rcw = fin['wm']
    krw = np.where(np.isnan(kres['wR']), np.nan, np.minimum(-np.nan_to_num(kres['wR']), np.nan_to_num(kres['wm'], nan=9.0)))
    res = dict(line=line, use=use, acw=acw, acb=acb, rcb=rcb, rcw=rcw, krw=krw, krx=kr['across_w'][i0:i0 + m], krb=kres['bR'],
               k_off=k_off, f_off=f_off, kblade=np.nan_to_num(kres['bR']), m=m)
    return job, res, None


def main(workers=4):
    t0 = time.time()
    r = route(); P = r['P']; s = r['s']; n = len(s)
    S1 = np.load(OUT + 'survey_1m.npz')
    L = S1['L'].astype(float); R = S1['R'].astype(float); have = S1['have'].astype(bool)
    # a metre or three without the photo trace (where two 500 m strips meet): bridged from both sides, so the line, the own
    # lane and the curve windows do not break there (no phantom stretches at the seams)
    gap = np.zeros(n, bool)
    for a_, b_ in runs_of(~have):
        if 0 < a_ and b_ < n and b_ - a_ <= 3: gap[a_:b_] = True
    if gap.any():
        k_ = np.flatnonzero(have); g_ = np.flatnonzero(gap)
        L[g_] = np.interp(g_, k_, L[k_]); R[g_] = np.interp(g_, k_, R[k_]); have = have | gap
    Rc = r['R']
    ctx = context(r); tw = ctx['tw']
    LL = np.load(OUT + 'lanelines.npz')
    L, R = edges_eff(L, R, ctx, LL)
    isl = islands(r)
    kr, own, multi, pl = keep_right(L, R, have, ctx, LL, isl)
    obst = obstacles(r, L, R)
    print(f'keep right laid ({time.time() - t0:.0f} s): one-way multi-lane {multi.sum() / 1000:.1f} km, two-way {(tw & have).sum() / 1000:.1f} km; '
          f'mapped obstacles beside the road on {np.isfinite(obst).any(1).mean() * 100:.1f} % of metres; islands on {np.isfinite(isl).sum()} m; '
          f'{gap.sum()} m without the trace bridged', flush=True)
    drv = kr.copy()
    acw, acb, krw, krx, krb, rcb, rcw = (np.full(n, np.nan, np.float32) for _ in range(7))
    # curve windows (any road; on two-way roads also straights under 8 m wide or where the right edge comes in by more than
    # 1.5 m within 60 m): runs merged across 300 m, a 150 m run-in for the blade
    nar = tw & ((L + R < 8) | ((R - minimum_filter1d(R, 121)) > 1.5))
    jobs = []
    for a, b in runs_of(have & ((Rc < 700) | nar)):
        if jobs and a - jobs[-1][1] <= 300: jobs[-1][1] = b
        else: jobs.append([a, b])
    wins = []
    for a, b in jobs:
        a0 = max(0, a - 150); b1 = min(n, b + 90)
        while a0 < a and not have[a0]: a0 += 1
        if (a0 > 0 and a - a0 < 60) or have[a0:b1].mean() < 0.8: continue      # (a run-in cut short by a gap; at the route's start none)
        wins.append((a0, a, b1))
    G.update(P=P, L=L, R=R, tw=tw, kr=kr, own=np.where(np.isfinite(own), own, L), pl=pl, obst=obst, multi=multi)
    from multiprocessing import Pool
    stretches = []; nrec = 0
    with Pool(workers) as pool:
        for wi, (job, res, err) in enumerate(pool.imap_unordered(window, wins, chunksize=1)):
            a0, a, b1 = job
            if err: print('window failed', round(s[a] / 1000, 2), err, flush=True); continue
            m = res['m']; sl = slice(a, a + m)
            drv[a0:b1] = res['line']
            acw[sl] = res['acw']; acb[sl] = res['acb']; krw[sl] = res['krw']; krx[sl] = res['krx']; krb[sl] = res['krb']
            rcb[sl] = res['rcb']; rcw[sl] = res['rcw']
            nrec += int(res['use'].any())
            # stretches: the wheels on the chosen line beyond the own lane by more than 0.4 m, or the line more than
            # 0.3 m left of keeping right with the wheels reaching beyond the own lane (lane 2 / the oncoming lane: the
            # escort closes it; a shift inside the own lane is not one) — two-way and multi-lane roads
            ac = np.nan_to_num(res['acw'], nan=-9)
            lft = (ac > 0.4) | (((res['line'] - kr[a0:b1])[a - a0:a - a0 + m] > 0.3) & (ac > 0.0))
            lft &= (tw | multi)[sl]
            # (a window on a narrow straight lists a stretch only where its line leaves keeping right: on a road too narrow
            # for both directions the convoy's wheels reach across the centre line anyway, shown in violet on the road)
            if not (Rc[a0:b1] < 700).any() and not res['use'].any(): lft[:] = False
            for p, q in runs_of(lft):
                if q - p < 8 or (q - p < 15 and gap[a + p:a + q].any()): continue
                seg = slice(p, q)
                stretches.append(dict(s0=float(s[a + p]), s1=float(s[min(n - 1, a + q - 1)]), len=int(q - p),
                                      kind='oncoming' if tw[a + p] else 'lane2',
                                      kr=dict(off=round(float(res['k_off'][seg].max()), 2), across=round(float(np.nanmax(np.nan_to_num(res['krx'][seg], nan=0))), 2),
                                              blade=round(float(res['kblade'][seg].max()), 1)),
                                      rec=dict(off=round(float(np.nanmax(res['f_off'][seg])), 2), across=round(float(np.nanmax(np.nan_to_num(res['acw'][seg], nan=0))), 2),
                                               blade=round(float(np.nanmax(res['rcb'][seg])), 1), clear=round(float(np.nanmin(np.nan_to_num(res['rcw'][seg], nan=9))), 2)),
                                      hold=int(round((q - p + 95) / 2.5))))     # s at ~9 km/h through the stretch
            if wi % 25 == 0: print('window', wi, '/', len(wins), round(s[a] / 1000, 1), 'km', round(time.time() - t0), 's', len(stretches), 'stretches', flush=True)
    # the line between windows: keep right, smooth (≤ 0.08 m per metre)
    for _ in range(2):
        for i in range(1, n): drv[i] = np.clip(drv[i], drv[i - 1] - 0.08, drv[i - 1] + 0.08)
        for i in range(n - 2, -1, -1): drv[i] = np.clip(drv[i], drv[i + 1] - 0.08, drv[i + 1] + 0.08)
    drv = gaussian_filter1d(drv, 3)
    # wheels beyond own: the swept path on curve windows, elsewhere the widest unit centred on the line
    left = np.where(np.isfinite(acw), np.maximum(np.nan_to_num(acw), 0), np.maximum(0, drv + WMAX / 2 - np.nan_to_num(own, nan=99)))
    f16 = lambda a: np.asarray(a, np.float32).astype(np.float16)
    np.savez_compressed(OUT + 'lanes_1m.npz', drv=f16(drv), kr=f16(kr), own=f16(own), left=f16(left), acw=f16(acw), acb=f16(acb),
                        krw=f16(krw), krx=f16(krx), krb=f16(krb), rcb=f16(rcb), rcw=f16(rcw), tw=tw, multi=multi)
    # merge stretches closer than 60 m (same kind)
    st = []
    for x in sorted(stretches, key=lambda q: q['s0']):
        if st and x['s0'] - st[-1]['s1'] < 60 and x['kind'] == st[-1]['kind']:
            p = st[-1]; p['s1'] = x['s1']; p['len'] = int(p['s1'] - p['s0']); p['hold'] = int(round((p['len'] + 95) / 2.5))
            for k in ('off', 'across', 'blade'): p['kr'][k] = max(p['kr'][k], x['kr'][k]); p['rec'][k] = max(p['rec'][k], x['rec'][k])
            p['rec']['clear'] = min(p['rec']['clear'], x['rec']['clear'])
        else: st.append(x)
    json.dump(st, open(OUT + 'lanes.json', 'w'), indent=0)
    print(f'done: {len(wins)} windows, the left line taken on {nrec}; {len(st)} stretches '
          f"({sum(1 for x in st if x['kind'] == 'oncoming')} oncoming, {sum(1 for x in st if x['kind'] == 'lane2')} lane 2, "
          f"{sum(x['len'] for x in st) / 1000:.2f} km), {time.time() - t0:.0f} s", flush=True)


if __name__ == '__main__':
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 4)
