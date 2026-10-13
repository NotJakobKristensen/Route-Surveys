"""Swept-path model of the blade convoy: tractor + front blade support + remote-steered rear dolly, the blade carried
'freischwebend' between the two supports with the tip overhanging the rear dolly (as described in the press reports).

Lengths in metres. The path is the tractor's line: keeping right — the right lane of a motorway or dual carriageway, the
right half of a two-way road (route_lanes.keep_right) — and moving into lane 2 or the oncoming lane only where its own
lane is not enough and the left side is (lane_plan; the escort closes that lane). At every position the rear-dolly
operator's lateral offset is chosen to keep the wheel units on the road first, inside the convoy's own lane second
(simulate's `own`) and the blade as far inside as possible third — the trade-off between the inner cut (blade chord,
dolly) and the outer swing (tip) that the crew makes on site.
"""
import numpy as np
from scipy.spatial import cKDTree

V = dict(
    blade=84.3,          # V172 blade length (Vestas)
    front_oh=1.4,        # tractor front overhang ahead of the steered axle
    wheelbase=4.8,       # steered axle → drive tandem centre
    kp_ahead=0.6,        # king pin ahead of the drive tandem
    fu_len=6.5,          # king pin → blade-root turntable on the self-steering front unit
    root_ahead=1.2,      # blade root face ahead of the front support
    support=50.0,        # front support → rear dolly turntable
    tractor_len=8.4, tractor_w=2.55,
    fdolly_len=4.0, fdolly_w=2.9,
    dolly_len=7.2, dolly_w=2.9,     # rear dolly, 4 axle lines, steered remotely
    root_d=4.2, load_w=4.2,          # blade root with the adapter; the load's widest point (root frame)
    maxchord=4.3,                    # widest chord of the blade
    height=4.7, under_sup=1.6,       # transport height (highest point); blade underside at the rear support
)
import routecfg                                      # another blade or vehicle: the route config's "vehicle" (same keys)
V.update({k: float(v) for k, v in (routecfg.get('vehicle') or {}).items() if k in V})
V['p1_back'] = V['wheelbase'] - V['kp_ahead'] + V['fu_len']                     # steered axle → front support (straight line)
V['length'] = V['front_oh'] + V['p1_back'] + V['blade'] - V['root_ahead']    # ≈ 95 m bumper → tip (press: 95–98 m)
V['overhang'] = V['blade'] - V['root_ahead'] - V['support']                     # tip beyond the rear dolly ≈ 33 m
# blade plan width along its length (fraction from the root) as carried — the same geometry as src/route/blade.js: the
# root adapter frame (the load's widest point) at the root face, then the blade's sections (V172 planform, root Ø 3.2 m,
# widest chord 4.3 m at 23 %), trailing edge up and turned about the axis only as far as the transport height requires
PLAN = np.array([[0, 3.2, 1, 13.3], [0.03, 3.2, 1, 13.3], [0.07, 3.5, 0.9, 13.3], [0.11, 3.85, 0.66, 13.3], [0.17, 4.21, 0.42, 13.3],
                 [0.23, 4.3, 0.35, 11.5], [0.3, 4.12, 0.33, 10.2], [0.37, 3.93, 0.3, 9.0], [0.43, 3.7, 0.26, 7.8], [0.5, 3.47, 0.24, 6.5],
                 [0.57, 3.24, 0.21, 5.4], [0.63, 3.01, 0.21, 4.2], [0.7, 2.78, 0.19, 3.1], [0.77, 2.55, 0.18, 2.3], [0.83, 2.33, 0.18, 1.5],
                 [0.89, 2.14, 0.18, 0.9], [0.93, 1.93, 0.18, 0.4], [0.97, 1.5, 0.18, 0.15], [0.99, 1.0, 0.19, 0.05], [1, 0.6, 0.22, 0]])


def _sstep(t):
    t = min(1.0, max(0.0, t)); return t * t * (3 - 2 * t)


def _section(s, roll, k_root, k_chord, n=28):
    """(up, side) of the section at span fraction s, centred sideways (as blade.js section())"""
    c_ref, t, tw = (float(np.interp(s, PLAN[:, 0], PLAN[:, k])) for k in (1, 2, 3))
    c = c_ref * (k_root + (k_chord - k_root) * _sstep(s / 0.23) if s < 0.23 else k_chord)
    circ = 1.0 if s <= 0.03 else 1 - _sstep((s - 0.03) / 0.09)
    flat = 0 if s < 0.06 else 0.34 * _sstep((s - 0.06) / 0.05) if s < 0.2 else 0.34 * (0.42 - s) / 0.22 if s < 0.42 else 0
    t = min(0.97, t)
    b = np.arange(n + 1) / n * np.pi; x = (1 - np.cos(b)) / 2
    yt = 5 * t * (0.2969 * np.sqrt(x) - 0.126 * x - 0.3516 * x ** 2 + 0.2843 * x ** 3 - 0.1036 * x ** 4) + flat * t * 0.5 * x * x
    yc = 0.035 * (1 - (2 * x - 0.8) ** 2) * max(0, 1 - t * 1.8)
    X = np.r_[x, x[::-1][1:-1]]; Y = np.r_[yc + yt, (yc - yt)[::-1][1:-1]]
    a = np.arange(len(X)) / len(X) * 2 * np.pi
    px = (X - 0.35) * c * (1 - circ) - np.cos(a) * c / 2 * circ; py = Y * c * (1 - circ) + np.sin(a) * c / 2 * circ
    th = roll + np.radians(tw)
    u = px * np.cos(th) - py * np.sin(th); sd = px * np.sin(th) + py * np.cos(th)
    return u, sd - (sd.max() + sd.min()) / 2


def blade_frame(v):
    """roll, root centre height, plan width per 15 stations — v: blade, root_d, maxchord, load_w, height, under_sup,
    root_ahead, support"""
    k_root = min(1.5, max(0.6, (v['root_d'] - 1.0) / 3.2)); k_chord = min(1.6, max(0.5, v['maxchord'] / 4.3))
    R0 = 1.6 * k_root; frame_up = R0 + 0.5; r_sup = v['root_ahead'] + v['support']; Lb = v['blade']
    s_sup = min(0.98, r_sup / Lb)

    def fit(roll):
        u, _ = _section(s_sup, roll, k_root, k_chord); sup_c = v['under_sup'] - u.min()
        tops = [(s * Lb, _section(s, roll, k_root, k_chord)[0].max()) for s in np.arange(0, min(0.95, s_sup) + 1e-9, 0.01)]

        def top_at(hc):
            w, wr = hc + frame_up, 0.0
            for r, uu in tops:
                z = hc + (sup_c - hc) * (r / r_sup) + uu
                if z > w: w, wr = z, r
            return w, wr
        hc = max(R0 + 0.72, v['height'] - frame_up)
        for _ in range(30):
            w, wr = top_at(hc); hc -= (w - v['height']) / max(0.3, 1 - wr / r_sup); hc = max(R0 + 0.72, min(v['height'] - 0.4, hc))
        return top_at(hc)[0], hc

    up = -np.radians(11.5); roll = up
    if fit(up)[0] > v['height'] + 0.01:
        lo, hi = up, 1.45
        if fit(hi)[0] > v['height'] + 0.01: lo = hi
        for _ in range(26):
            if hi - lo < 1e-4: break
            m = (lo + hi) / 2
            if fit(m)[0] > v['height'] + 0.01: lo = m
            else: hi = m
        roll = hi
    top, hc = fit(roll)
    t = np.linspace(0, 1, 15)
    w = np.array([np.ptp(_section(min(1.0, x), roll, k_root, k_chord)[1]) for x in t]); w[0] = max(w[0], v['load_w'])
    return dict(roll=roll, Hc=hc, top=top, t=t, w=w)


_BF = blade_frame(dict(blade=V['blade'], root_d=V['root_d'], maxchord=V['maxchord'], load_w=V['load_w'], height=V['height'],
                       under_sup=V['under_sup'], root_ahead=V['root_ahead'], support=V['support']))
BT, BWS = _BF['t'], _BF['w']

# usable half-width of the carriageway (m) by road class: whole carriageway incl. hard shoulder where there is one
HALF = {('motorway', None): 5.25, ('motorway', 'link'): 3.25, ('trunk', None): 4.5, ('trunk', 'link'): 3.1,
        ('primary', None): 3.4, ('primary', 'link'): 3.0, ('secondary', None): 3.1, ('secondary', 'link'): 2.9,
        ('tertiary', None): 2.9, ('unclassified', None): 2.75, ('service', None): 2.5, ('track', None): 2.25,
        ('residential', None): 2.75}


def half_width(cls, sub):
    return HALF.get((cls, 'link' if sub == 'link' else None), HALF.get((cls, None), 2.5))


def resample(P, step=1.0):
    d = np.r_[0, np.cumsum(np.hypot(*np.diff(P, axis=0).T))]
    s = np.arange(0, d[-1], step)
    return np.c_[np.interp(s, d, P[:, 0]), np.interp(s, d, P[:, 1])], s, d


def smooth(P, sigma=4.0):
    """Gaussian smoothing of a 1 m polyline (removes vertex kinks; σ in metres), ends held"""
    r = int(3 * sigma)
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2); k /= k.sum()
    pad = np.r_[np.repeat(P[:1], r, 0), P, np.repeat(P[-1:], r, 0)]
    return np.c_[np.convolve(pad[:, 0], k, 'valid'), np.convolve(pad[:, 1], k, 'valid')]


def curvature_radius(P, half=25):
    """radius over a 50 m window (the support spacing): 1 / slope of a least-squares line through the heading
    (a junction corner reads as its turn, not as a fictitious radius); 1 m spacing"""
    h = np.unwrap(np.arctan2(*np.gradient(P, axis=0)[:, ::-1].T))
    n = len(P); k = np.zeros(n)
    if n > 2 * half + 1:
        t = np.arange(-half, half + 1, dtype=float); w = t / (t @ t)
        k[half:n - half] = np.convolve(h, w[::-1], 'valid')
    return 1 / np.maximum(np.abs(k), 1e-6), np.sign(k)


def turn_angle(P, span=40):
    """heading change (deg) over the next `span` metres"""
    h = np.unwrap(np.arctan2(*np.gradient(P, axis=0)[:, ::-1].T))
    a = np.zeros(len(P))
    if len(P) > span: a[:-span] = np.degrees(np.abs(h[span:] - h[:-span]))
    return a


def tractrix(P, L):
    """rear point at distance L following the front points P (discrete tractrix)"""
    Q = np.empty_like(P)
    t = P[min(len(P) - 1, int(L))] - P[0]; t /= np.linalg.norm(t) + 1e-9
    Q[0] = P[0] - t * L
    for i in range(1, len(P)):
        v = Q[i - 1] - P[i]; n = np.linalg.norm(v) + 1e-9
        Q[i] = P[i] + v / n * L
    return Q


def rect(c, u, length, width, back=0.5):
    n = np.array([-u[1], u[0]])
    f, b = c + u * length * (1 - back), c - u * length * back
    return np.array([f + n * width / 2, f - n * width / 2, b - n * width / 2, b + n * width / 2])


def blade_outline(root, u):
    """plan outline (closed polygon, 30 pts) of the blade from its root along unit axis u"""
    n = np.array([-u[1], u[0]])
    c = root[None] + u[None] * (BT[:, None] * V['blade'])
    return np.r_[c + n * (BWS[:, None] / 2), (c - n * (BWS[:, None] / 2))[::-1]]


class Lateral:
    """signed lateral offset of points from a centreline (left positive) and the local half-width there"""
    def __init__(self, P, halfw):
        self.P, self.halfw = P, halfw
        T = np.gradient(P, axis=0); T /= np.linalg.norm(T, axis=1)[:, None] + 1e-9
        self.Nn = np.c_[-T[:, 1], T[:, 0]]
        self.tree = cKDTree(P)

    def __call__(self, Q):
        """lat (left +), left half-width, right half-width, index"""
        d, k = self.tree.query(Q)
        lat = np.einsum('ij,ij->i', Q - self.P[k], self.Nn[k])
        h = self.halfw[k]
        if h.ndim == 2: return lat, h[:, 0], h[:, 1], k
        return lat, h, h, k


def simulate(P, halfw, i0=0, i1=None, offsets=np.arange(-3.5, 3.5001, 0.25), keep=False, clear=0.5, own=None, obst=None):
    """P: smoothed 1 m centreline (N×2), travel = increasing index; halfw: usable half-width per point.
    Kinematics: tractor steered axle on the path, drive tandem on its tractrix, king pin just ahead of the tandem, the
    self-steering front unit's turntable (blade root support) on the king pin's tractrix; the blade runs from there to the
    rear dolly's turntable, which the operator places on the path laterally offset. The offsets along the stretch are
    chosen together (dynamic programming, at most 0.25 m per metre): wheels kept `clear` m inside the edge where the road
    allows (1 m on roads without hard shoulder, 0.5 m elsewhere; scalar or per point), then inside the convoy's own lane
    (own: its left boundary per point, m from P, left +; 2 per metre beyond it), then the least overswing.
    obst (optional, N×2): distance from P to the nearest mapped obstacle left / right (signs, lamps, walls, buildings;
    inf = none) — only measured (bo), the choice is not changed.
    For front-axle positions i0..i1 returns arrays of: wL/wR (wheel units beyond the edge, m), wm (smallest wheel
    clearance to the edge, m; < 0 = off the road), wmR (the same to the right edge), bL/bR (blade beyond the edge, m),
    off (dolly offset, m); with own: ow (wheel units beyond it, m); with obst: bo (blade beyond the obstacle line, m);
    with keep=True also the footprint polygons of the chosen configuration."""
    N = len(P); i1 = N if i1 is None else i1
    lat = Lateral(P, halfw)
    own = None if own is None else np.nan_to_num(np.broadcast_to(np.asarray(own, float), (N,)), nan=1e3)   # (NaN: no limit)
    obst = None if obst is None else np.asarray(obst, float)
    rearax = tractrix(P, V['wheelbase'])
    T0 = P - rearax; T0 /= np.linalg.norm(T0, axis=1)[:, None] + 1e-9
    kp = rearax + T0 * V['kp_ahead']
    p1 = tractrix(kp, V['fu_len'])
    K = len(offsets); M = i1 - i0
    WL = np.full((M, K), np.nan); WR = WL.copy(); BL_ = WL.copy(); BR_ = WL.copy(); CL = WL.copy(); CR = WL.copy()
    OW = np.zeros((M, K)); BO = np.zeros((M, K))
    geo = [None] * M
    j = 0
    for ii, i in enumerate(range(i0, i1)):
        ut = P[i] - rearax[i]; ut /= np.linalg.norm(ut) + 1e-9
        tr = rect(P[i] + ut * V['front_oh'], ut, V['tractor_len'], V['tractor_w'], back=1.0)
        uf = kp[i] - p1[i]; uf /= np.linalg.norm(uf) + 1e-9
        fd = rect(p1[i] + uf * (V['fu_len'] * 0.25), uf, V['fu_len'] * 0.75, V['fdolly_w'])
        while j < i and np.linalg.norm(P[j + 1] - p1[i]) > V['support']: j += 1
        if np.linalg.norm(P[j] - p1[i]) < V['support'] * 0.6: continue
        Tj = P[min(j + 1, N - 1)] - P[max(j - 1, 0)]; Tj /= np.linalg.norm(Tj) + 1e-9
        Nj = np.array([-Tj[1], Tj[0]])
        q = P[j][None] + Nj[None] * offsets[:, None]
        U = q - p1[i][None]; U /= np.linalg.norm(U, axis=1)[:, None] + 1e-9
        Q = p1[i][None] + U * V['support']
        DL = np.concatenate([rect(Q[k], Tj, V['dolly_len'], V['dolly_w']) for k in range(K)])
        BLn = np.concatenate([blade_outline(p1[i] - U[k] * V['root_ahead'], U[k]) for k in range(K)])
        lw, hwl, hwr, kw = lat(np.r_[tr, fd]); ld, hdl, hdr, kd = lat(DL); lb, hbl, hbr, kb = lat(BLn)
        ld, hdl, hdr = ld.reshape(K, 4), hdl.reshape(K, 4), hdr.reshape(K, 4); nb = BLn.shape[0] // K
        lb, hbl, hbr = lb.reshape(K, nb), hbl.reshape(K, nb), hbr.reshape(K, nb)
        wl0, wr0 = max(0, (lw - hwl).max()), max(0, (-lw - hwr).max())
        WL[ii] = np.maximum(wl0, np.maximum(0, (ld - hdl).max(1))); WR[ii] = np.maximum(wr0, np.maximum(0, (-ld - hdr).max(1)))
        BL_[ii] = np.maximum(0, (lb - hbl).max(1)); BR_[ii] = np.maximum(0, (-lb - hbr).max(1))
        CL[ii] = np.minimum(np.minimum(hwl - lw, hwr + lw).min(), np.minimum(hdl - ld, hdr + ld).min(1))
        CR[ii] = np.minimum((hwr + lw).min(), (hdr + ld).min(1))
        if own is not None:                                            # wheel units beyond the own lane's left boundary
            OW[ii] = np.maximum(0, np.maximum((lw - own[kw]).max(), (ld - own[kd].reshape(K, 4)).max(1)))
        if obst is not None:                                           # blade beyond the nearest mapped obstacle
            ob = obst[kb].reshape(K, nb, 2)
            BO[ii] = np.maximum(0, np.maximum((lb - ob[..., 0]).max(1), (-lb - ob[..., 1]).max(1)))
        geo[ii] = (tr, fd, Tj, U, Q)
    # per-position cost of every offset, then the smoothest cheapest sequence (|Δ| ≤ 1 grid step per metre)
    valid = ~np.isnan(CL[:, 0])
    clr = np.broadcast_to(np.asarray(clear, float), (N,))[i0:i1][:, None] if np.ndim(clear) else clear
    C = 40 * np.maximum(WL, WR) + 8 * np.maximum(0, clr - CL) + 0.6 * np.maximum(BL_, BR_) + 0.02 * np.abs(offsets)[None] + 2.0 * OW
    C[~valid] = 0.02 * np.abs(offsets)[None].repeat((~valid).sum(), 0)
    D = np.zeros((M, K)); arg = np.zeros((M, K), np.int64)
    D[0] = C[0]
    for ii in range(1, M):
        prev = np.stack([np.r_[np.inf, D[ii - 1][:-1]], D[ii - 1], np.r_[D[ii - 1][1:], np.inf]])
        a = np.argmin(prev, 0); D[ii] = C[ii] + prev[a, np.arange(K)]; arg[ii] = np.arange(K) + a - 1
    path = np.zeros(M, np.int64); path[-1] = int(np.argmin(D[-1]))
    for ii in range(M - 1, 0, -1): path[ii - 1] = arg[ii, path[ii]]
    r = np.arange(M)
    res = {'wL': WL[r, path], 'wR': WR[r, path], 'bL': BL_[r, path], 'bR': BR_[r, path], 'wm': CL[r, path], 'wmR': CR[r, path],
           'off': offsets[path].astype(float), 'ow': OW[r, path], 'bo': BO[r, path]}
    for k in ('wL', 'wR', 'bL', 'bR', 'wm', 'wmR', 'off', 'ow', 'bo'): res[k] = np.where(valid, res[k], np.nan)
    if own is None: del res['ow']
    if obst is None: del res['bo']
    polys = []
    if keep:
        for ii in range(M):
            g = geo[ii]
            if g is None: polys.append(None); continue
            tr, fd, Tj, U, Q = g; k = path[ii]
            polys.append({'tractor': tr, 'front': fd, 'dolly': rect(Q[k], Tj, V['dolly_len'], V['dolly_w']),
                          'blade': blade_outline(p1[i0 + ii] - U[k] * V['root_ahead'], U[k])})
    res['kp'] = kp[i0:i1]; res['p1'] = p1[i0:i1]
    return res, polys


# ---------------------------------------------------------------- own lane or the oncoming lane
def offset_path(P, o):
    """the path shifted laterally by o (m, left +; scalar or per point) along the smoothed normals of P"""
    T = np.gradient(smooth(P, 6.0), axis=0); T /= np.linalg.norm(T, axis=1)[:, None] + 1e-9
    Nn = np.c_[-T[:, 1], T[:, 0]]
    return P + Nn * np.broadcast_to(np.asarray(o, float), (len(P),))[:, None], Nn


def lane_plan(P, L, R, i0=0, twoway=None, clear=None, n_cand=13, kr_o=None, own=None, pl=None, obst=None, reach=None, lazy=False):
    """Own lane against the left side at a stretch of road (the user's rule: keep right; take the left side only where the
    right side is not sufficient and the left side is). P: 1 m line (the mapped route line); L / R: distance of the left
    / right carriageway edge from it (per point, m); twoway: True where traffic runs both ways (default all); kr_o: the
    keep-right line and own: the left boundary of the convoy's own lane (per point, m from P, left +; route_lanes.
    keep_right — default: the middle of the right half / the centre line of a two-way road, the middle elsewhere);
    pl: cost per metre and metre left of kr_o (default 1.0 two-way: the escort holds oncoming traffic; 0.5 elsewhere:
    lane 2 closed); obst (N×2): distance from P to the nearest mapped obstacle left / right — blade overswing costs 0.6
    per metre only into those, 0.1 over a free verge; reach: how far left the candidates go (m, default to 1.6 m inside
    the left edge). Returns, for positions i0.., two plans:
      'kr'  keep right: the tractor on kr_o, the own lane's left boundary treated as an edge: what stays inside, what
            crosses it, what leaves the road;
      'rec' the cheapest line among parallel lines from kr_o (candidate 0) leftwards every 0.5 m (dynamic programming over
            per-line costs, at most one step per ~6 m: 0.08 m sideways per metre; entering and leaving on kr_o): wheels off
            the road, wheel clearance, blade overswing, and the cost of being left of kr_o. lazy=True: rec = kr where
            keeping right is enough throughout (wheels on the road and in the own lane within 0.15 m, the blade clear of
            mapped obstacles within 0.3 m).
    Each plan: res (as simulate), polys, line offset per point (from P, left +), and per point the extent of the swept
    area beyond own (m, > 0 = into lane 2 / the oncoming lane): 'across' (wheels or blade), 'across_w' (wheels)."""
    n = len(P); L = np.asarray(L, float); R = np.asarray(R, float)
    tw = np.ones(n, bool) if twoway is None else np.asarray(twoway, bool)
    from scipy.ndimage import gaussian_filter1d as _g
    W = L + R; c = (L - R) / 2                                   # carriageway width; its middle (= centre line, two-way)
    # the lines are laid on the smoothed carriageway (a junction mouth or a lay-by does not pull them sideways); the
    # clearances below use the measured edges
    Ws = _g(W, 10, mode='nearest'); cs = _g(c, 10, mode='nearest'); Lsm = _g(L, 10, mode='nearest')
    narrow = Ws < 5.6                                             # one lane wide: the convoy needs the whole road anyway
    if kr_o is None: kr_o = np.where(tw & ~narrow, cs - Ws / 4, cs)
    if own is None: own = np.where(tw & ~narrow, cs, L)
    kr_o = np.asarray(kr_o, float); own = np.asarray(own, float)
    if pl is None: pl = np.where(tw, 1.0, 0.5)
    pl = np.broadcast_to(np.asarray(pl, float), (n,))
    if clear is None: clear = np.where(W <= 6.9, 1.0, 0.5)
    clr = np.broadcast_to(np.asarray(clear, float), (n,))
    rel = lambda o: None if obst is None else np.c_[obst[:, 0] - o, obst[:, 1] + o]
    out = {}
    # keep right: edges = the right edge and the own lane's left boundary
    Pk, _ = offset_path(P, kr_o)
    HWk = np.c_[own - kr_o, R + kr_o]
    rk, pk = simulate(Pk, HWk, i0=i0, keep=True, clear=np.minimum(clr, 0.3), obst=rel(kr_o))
    out['kr'] = dict(res=rk, polys=pk, o=kr_o)
    ok_right = (np.nan_to_num(np.maximum(rk['wL'], rk['wR'])) <= 0.15).all() and (obst is None or (np.nan_to_num(rk['bo']) <= 0.3).all())
    if lazy and ok_right:
        out['rec'] = dict(res=rk, polys=pk, o=kr_o.copy())
    else:
        # candidate lines from the keep-right line leftwards every 0.5 m, the tractor at least 1.6 m inside the left edge
        top = np.maximum(kr_o, Lsm - 1.6)
        span = float(np.max((top - kr_o)[i0:])) if reach is None else float(reach)
        K = int(min(n_cand, max(1, np.ceil(span / 0.5) + 1)))
        cand = [np.minimum(kr_o + 0.5 * k, np.maximum(top, kr_o)) for k in range(K)]
        cost = []
        for o in cand:
            Po, _ = offset_path(P, o)
            ro, _ = simulate(Po, np.c_[L - o, R + o], i0=i0, keep=False, clear=clr, obst=rel(o))
            cc = 40 * np.nan_to_num(np.maximum(ro['wL'], ro['wR'])) + 8 * np.nan_to_num(np.maximum(0, clr[i0:] - ro['wm']))
            if obst is None: cc = cc + 0.6 * np.nan_to_num(np.maximum(ro['bL'], ro['bR']))
            else: cc = cc + 0.1 * np.nan_to_num(np.maximum(ro['bL'], ro['bR'])) + 0.5 * np.nan_to_num(ro['bo'])
            # keeping right is the default: every metre left of the keep-right line costs (the escort closes that lane)
            cc = cc + pl[i0:] * np.maximum(0, (o - kr_o)[i0:])
            cost.append(cc)
        C = np.array(cost).T                                      # (M, K)
        M = C.shape[0]
        # the line moves at most one candidate step per block of `hop` metres (≈ 0.08 m sideways per metre)
        hop = max(2, int(round(0.5 / 0.08)))
        nb = int(np.ceil(M / hop))
        Cb = np.array([C[b * hop:(b + 1) * hop].sum(0) for b in range(nb)])
        D = np.zeros_like(Cb); arg = np.zeros(Cb.shape, np.int64)
        D[0] = Cb[0] + 1e3 * np.arange(K)                         # enter on the keep-right line
        for b in range(1, nb):
            prev = np.stack([np.r_[np.inf, D[b - 1][:-1]] + 0.5, D[b - 1], np.r_[D[b - 1][1:], np.inf] + 0.5])
            a_ = np.argmin(prev, 0); D[b] = Cb[b] + prev[a_, np.arange(K)]; arg[b] = np.arange(K) + a_ - 1
        kb = np.zeros(nb, np.int64); kb[-1] = int(np.argmin(D[-1] + 1e3 * np.arange(K)))   # leave on it
        for b in range(nb - 1, 0, -1): kb[b - 1] = arg[b, kb[b]]
        xc = np.minimum(np.arange(nb) * hop + hop / 2, M - 1)
        fm = _g(np.interp(np.arange(M), xc, kb.astype(float)), 4, mode='nearest')    # candidate index per metre
        ow = np.minimum(kr_o[i0:] + 0.5 * fm, np.maximum(top, kr_o)[i0:])
        rec_o = kr_o.copy(); rec_o[i0:] = ow
        if i0 > 0:                                                # run-in: from the keep-right line, eased onto the plan
            t_ = np.arange(i0) / i0; rec_o[:i0] = kr_o[:i0] + (ow[0] - kr_o[i0]) * t_ * t_ * (3 - 2 * t_)
        Pr, _ = offset_path(P, rec_o)
        rr, pr = simulate(Pr, np.c_[L - rec_o, R + rec_o], i0=i0, keep=True, clear=clr, obst=rel(rec_o))
        out['rec'] = dict(res=rr, polys=pr, o=rec_o)
    # extent beyond the own lane per point (swept area of wheels and blade, from the polygons)
    for key in ('kr', 'rec'):
        if key == 'rec' and out['rec']['res'] is rk:
            out['rec']['across'], out['rec']['across_w'] = out['kr']['across'], out['kr']['across_w']; continue
        out[key]['across'], out[key]['across_w'] = beyond(P, own, out[key]['polys'])
    out['c'] = c; out['W'] = W; out['twoway'] = tw; out['narrow'] = narrow; out['own'] = own; out['ok_right'] = ok_right
    return out


def beyond(P, own, polys):
    """per point of P: how far the swept area goes beyond `own` (m from P, left +; > 0 = into lane 2 / the oncoming lane)
    — (wheels or blade, wheels only), from simulate's polygons; NaN where none"""
    n = len(P); lat = Lateral(P, np.zeros(n))
    x = np.full(n, -np.inf); xw = np.full(n, -np.inf); own = np.nan_to_num(np.asarray(own, float), nan=1e3)
    for pg in polys:
        if pg is None: continue
        for nm, arr in (('w', np.r_[pg['tractor'], pg['front'], pg['dolly']]), ('b', pg['blade'])):
            la, _, _, kk = lat(arr)
            v = la - own[kk]
            np.maximum.at(x, kk, v)
            if nm == 'w': np.maximum.at(xw, kk, v)
    return np.where(np.isfinite(x), x, np.nan), np.where(np.isfinite(xw), xw, np.nan)
