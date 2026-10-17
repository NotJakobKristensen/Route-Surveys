// Every place on the route where the blade may have trouble passing, with the page's own code: the page's vehicle (its
// defaults) drives the whole route along the convoy's line window by window (src/route/vehicle.js sweep, as the drive view),
// and per front-axle metre it records
//   blade    the blade beyond the carriageway edge traced on the photo, more than its tolerance (src/route/bladeedge.js,
//            with the passages' traced paved surface); apart, where the overhang lies over a mapped road (a junction mouth,
//            a slip road: typical widths) and is road, not verge
//   object   the blade's underside over a mapped object at its height (vehicle.js overPoint, as the road view labels them:
//            hits under 0.1 m, close under 0.5 m) or the object in the wheels' path: signals, lamps, poles, signs (their plates
//            at their real sizes and mounting heights, src/route/signdims.js), barriers at their typical heights (walls,
//            noise barriers, fences, hedges, guard rails), buildings (footprint, height)
//   tree     a tree's crown (surface model) in the blade's swing beyond the traced edge
//   wheels   the wheels beyond the traced edge by more than 0.1 m
//   height   a structure over the road that the page rates "too low" or "to check" for the transport height
// and which of these lie outside the passages (their front-axle stretch [a, b]).
//   ROUTE_ROOT=<route> node windpark-hosskirch/tools/route_scan.mjs [km_from km_to]   → OUT (default .cache/route/corr/route_scan.json)
// Reads the road packs and the passages' packs (rpacks.mjs) and the page header (data/route/route.json: the passages).
import fs from 'node:fs';
import path from 'node:path';
import { SRC, C, ROOT, PIDX, PK, pack, line, windowOf, pavedFor, dropPacks } from './rpacks.mjs';

const { sweep, DEFAULTS } = await import(path.join(SRC, 'vehicle.js'));
const { bladeProfile, bladeFrame, section } = await import(path.join(SRC, 'blade.js'));
const { bladeEdge, normals, SIG } = await import(path.join(SRC, 'bladeedge.js'));
const { signDims, base } = await import(path.join(SRC, 'signdims.js'));
const { tmInverse } = await import(path.join(SRC, 'geo.js'));

const VEH = { ...DEFAULTS };
const HDR = JSON.parse(fs.readFileSync(process.env.HEADER || path.join(ROOT, 'data', 'route', 'route.json'), 'utf8'));
const HOTS = HDR.hot.map((h) => ({ id: h.id, title: h.title, km: h.km, lon: h.lon, lat: h.lat }));
const TOTAL = HDR.km * 1000;
const [K0, K1] = process.argv.length > 3 ? [+process.argv[2] * 1000, +process.argv[3] * 1000] : [0, TOTAL];
const CORE = 1400, RUNIN = 410, RUNOUT = 300;
const NEED = VEH.height + VEH.heightMargin;
const prof = bladeProfile(VEH), NP = prof.n;
const Wt = (t) => { const f = Math.max(0, Math.min(1, t)) * (NP - 1), i = Math.min(NP - 2, Math.floor(f)), u = f - i; return prof.W[i] * (1 - u) + prof.W[i + 1] * u; };
const Ut = (t) => { const f = Math.max(0, Math.min(1, t)) * (NP - 1), i = Math.min(NP - 2, Math.floor(f)), u = f - i; return prof.U[i] * (1 - u) + prof.U[i + 1] * u; };
// the blade's underside across its width: per station (121 along the span) the lowest point of the section as carried at
// each lateral distance from the axis (0.05 m bins, both sides folded: the lower of the two), above the axis' height there
// (vehicle.js overPoint takes the section's lowest point at any distance: more cautious; kept for the road view's objects)
const BF = bladeFrame(VEH), NS = 121, NB = 46, LOW = new Float32Array(NS * NB).fill(NaN), AX = new Float32Array(NS), HALFW = new Float32Array(NS);
for (let j = 0; j < NS; j++) {
  const t = j / (NS - 1), r = t * BF.Lb, pts = section(BF, Math.min(1, t)), m = pts.length;
  AX[j] = BF.Hc + (BF.supC - BF.Hc) * (r / BF.rSup) + BF.bend(r);
  let wmax = 0;
  for (let a = 0; a < m; a++) {
    const [u0, y0] = pts[a], [u1, y1] = pts[(a + 1) % m], ya = Math.abs(y0), yb = Math.abs(y1); wmax = Math.max(wmax, ya);
    if (Math.sign(y0) !== Math.sign(y1) && y0 !== 0 && y1 !== 0) {     // (crossing the axis: both halves)
      const yc = 0, uc = u0 + (u1 - u0) * (-y0) / (y1 - y0);
      for (const [p, q, up, uq] of [[ya, yc, u0, uc], [yc, yb, uc, u1]]) for (let b = Math.ceil(Math.min(p, q) / 0.05); b <= Math.floor(Math.max(p, q) / 0.05) && b < NB; b++) { const f = q === p ? 0 : (b * 0.05 - p) / (q - p), u = up + (uq - up) * f; const o = j * NB + b; if (!(LOW[o] <= u)) LOW[o] = u; }
      continue;
    }
    for (let b = Math.ceil(Math.min(ya, yb) / 0.05); b <= Math.floor(Math.max(ya, yb) / 0.05) && b < NB; b++) { const f = yb === ya ? 0 : (b * 0.05 - ya) / (yb - ya), u = u0 + (u1 - u0) * f; const o = j * NB + b; if (!(LOW[o] <= u)) LOW[o] = u; }
  }
  HALFW[j] = wmax;
  for (let b = 1; b < NB; b++) if (Number.isNaN(LOW[j * NB + b])) LOW[j * NB + b] = LOW[j * NB + b - 1];       // (beyond the section: its outermost)
}
const underAt = (t, lat) => {          // the blade's underside above the road at span fraction t, lat m beside the axis
  const f = Math.max(0, Math.min(1, t)) * (NS - 1), j = Math.min(NS - 2, Math.floor(f)), u = f - j;
  const lo = (jj) => { const b = Math.min(NB - 1, Math.round(Math.min(lat, HALFW[jj]) / 0.05)); return AX[jj] + LOW[jj * NB + b]; };
  return lo(j) * (1 - u) + lo(j + 1) * u;
};
const LL = (x, y) => { const [la, lo] = tmInverse(x, y, { lon0: 15, k0: 0.9996, x0: 500000 }); return [+lo.toFixed(6), +la.toFixed(6)]; };
const inPassage = (s) => HOTS.find((h) => s >= h.km[0] * 1000 - 0.5 && s <= h.km[1] * 1000 + 0.5) || null;

// typical heights (m) as the road view draws them: objects (roadview.js OBJ_H), barriers (barriers.js)
const OBJ_H = { street_lamp: 9.0, traffic_signals: 4.2, stop: 2.6, give_way: 2.6, information: 2.8, bus_stop: 2.8, power_pole: 9.0, power_tower: 30.0,
  bollard: 0.9, barrier: 1.2, toll_booth: 4.5, camera: 5.5, speed_camera: 2.5, mast: 15, tower: 25, other: 2.5 };
const BAR_H = { guard_rail: 0.75, jersey_barrier: 0.81, wall: 1.6, retaining_wall: 1.6, noise_barrier: 3.5, hedge: 1.6, fence: 1.4, other: 0.6 };
const HALF = { motorway: 5.25, trunk: 4.5, primary: 3.4, secondary: 3.1, tertiary: 2.9, unclassified: 2.75, residential: 2.75, living_street: 2.5, service: 2.5, track: 2.25, unknown: 2.5 };
const HALF_LINK = { motorway: 3.25, trunk: 3.1, primary: 3.0, secondary: 2.9 };

// ---------------------------------------------------------------- the mapped roads beside the route along the normals
// (convex quads per segment, square end caps: their union), kept where they reach beyond the traced edges as pavedAlong does
function roadsAlong(S, quads) {
  const { m, P, NT, HL, HR } = S, CS = 8, G = new Map(), at = new Int32Array(m + 1), d = [];
  quads.forEach((q, i) => { let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity; for (let k = 0; k < 4; k++) { x0 = Math.min(x0, q[2 * k]); x1 = Math.max(x1, q[2 * k]); y0 = Math.min(y0, q[2 * k + 1]); y1 = Math.max(y1, q[2 * k + 1]); }
    for (let x = Math.floor(x0 / CS); x <= Math.floor(x1 / CS); x++) for (let y = Math.floor(y0 / CS); y <= Math.floor(y1 / CS); y++) { const k = x * 1048576 + y; let a = G.get(k); if (!a) G.set(k, (a = [])); a.push(i); } });
  for (let k = 0; k < m; k++) {
    at[k] = d.length / 2; if (!quads.length) continue;
    const px = P[2 * k], py = P[2 * k + 1], nx = NT[2 * k], ny = NT[2 * k + 1], seen = new Set(), iv = [];
    for (let t = -60; t <= 60; t += CS / 2) { const cx = Math.floor((px + nx * t) / CS), cy = Math.floor((py + ny * t) / CS);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const qi of G.get((cx + i) * 1048576 + cy + j) || []) seen.add(qi); }
    for (const qi of seen) {          // the normal (p + n u) clipped by the quad's four half-planes (counter-clockwise or not)
      const q = quads[qi]; let lo = -60, hi = 60, area = 0;
      for (let e = 0; e < 4; e++) { const a = (e + 1) % 4; area += q[2 * e] * q[2 * a + 1] - q[2 * a] * q[2 * e + 1]; }
      const sg = area > 0 ? 1 : -1;
      for (let e = 0; e < 4 && lo < hi; e++) {
        const a = (e + 1) % 4, ex = q[2 * a] - q[2 * e], ey = q[2 * a + 1] - q[2 * e + 1];
        // inside: sg · cross(edge, point − start) ≥ 0, linear in u
        const c0 = sg * (ex * (py - q[2 * e + 1]) - ey * (px - q[2 * e])), c1 = sg * (ex * ny - ey * nx);
        if (Math.abs(c1) < 1e-12) { if (c0 < 0) hi = lo - 1; continue; }
        const u = -c0 / c1; if (c1 > 0) lo = Math.max(lo, u); else hi = Math.min(hi, u);
      }
      if (hi > lo) iv.push([lo, hi]);
    }
    iv.sort((a, b) => a[0] - b[0]); const M = [];
    for (const q of iv) { if (M.length && q[0] <= M[M.length - 1][1]) M[M.length - 1][1] = Math.max(M[M.length - 1][1], q[1]); else M.push(q.slice()); }
    for (const [a, b] of M) {
      if (a < -HR[k] - SIG) d.push(a, Math.min(b, -HR[k] + 1.5));
      if (b > HL[k] + SIG) d.push(Math.max(a, HL[k] - 1.5), b);
    }
  }
  at[m] = d.length / 2;
  return { at, d: Float32Array.from(d) };
}
// two paved sets on the same normals joined (intervals per normal merged)
function joinPaved(m, A, B) {
  if (!A) return B; if (!B) return A;
  const at = new Int32Array(m + 1), d = [];
  for (let k = 0; k < m; k++) {
    at[k] = d.length / 2; const L = [];
    for (const X of [A, B]) for (let j = X.at[k]; j < X.at[k + 1]; j++) L.push([X.d[2 * j], X.d[2 * j + 1]]);
    L.sort((a, b) => a[0] - b[0]); const M = [];
    for (const q of L) { if (M.length && q[0] <= M[M.length - 1][1] + 1e-6) M[M.length - 1][1] = Math.max(M[M.length - 1][1], q[1]); else M.push(q.slice()); }
    for (const q of M) d.push(q[0], q[1]);
  }
  at[m] = d.length / 2;
  return { at, d: Float32Array.from(d) };
}

// ---------------------------------------------------------------- what the packs hold beside the route, in the window's frame
function packsOf(sa, sb) { const out = []; for (let p = Math.floor(sa / PK) - 1; p <= Math.floor(sb / PK) + 1; p++) if (PIDX.packs.includes(p)) { const P = pack(p); if (P) out.push(P); } return out; }
function obstacles(Ln, sa, sb) {
  const O = Ln.O, pts = [], trees = [], quads = [], over = [];
  for (const P of packsOf(sa, sb)) {
    const A = P.A, H = P.hdr, dx = H.ox - O.x, dy = H.oy - O.y;
    // mapped objects (their measured height, else the typical one)
    for (let i = 0; i < (A.obj_c ? A.obj_c.length : 0); i++) {
      const c = H.objc[A.obj_c[i]]; if (c === 'other') continue;
      const hm = A.obj_h ? A.obj_h[i] / 10 : 0;
      pts.push({ kind: 'object', cls: c, x: A.obj_xy[2 * i] + dx, y: A.obj_xy[2 * i + 1] + dy, h: hm > 0 ? hm : OBJ_H[c] || 2.5, src: hm > 0 ? 'measured' : 'typical', r: 0 });
    }
    // road signs: the plates on one post stacked down from the top, the lowest at its mounting height (signs.js)
    const posts = new Map();
    for (const [s, d, dir, code, v, sp] of H.signs || []) {
      if (s < sa - 5 || s > sb + 5) continue; const q = Ln.at(s); if (!q) continue;
      const x = q.x + q.nx * d, y = q.y + q.ny * d;
      if (code === 'gantry') { for (const e of [8, -8]) pts.push({ kind: 'sign', cls: 'gantry column', x: x + q.nx * e, y: y + q.ny * e, h: 7.4, src: 'typical', r: 0.3 }); continue; }
      // guide posts stand 0.5 m beyond the traced edge (route_signs.py; where an edge was traced again later the packed
      // offset can lie on the carriageway: placed by the packed edge here)
      if (base(code) === '620') { const dd = dir > 0 ? -(q.R + 0.5) : q.L + 0.5; pts.push({ kind: 'sign', cls: 'guide post', x: q.x + q.nx * dd, y: q.y + q.ny * dd, h: 1.05, src: 'standard', r: 0.05 }); continue; }
      const dm = signDims(code, v, sp || (code === '274' && v <= 50 ? 50 : 100), false), key = x.toFixed(1) + ',' + y.toFixed(1);
      let g = posts.get(key); if (!g) posts.set(key, (g = { x, y, low: Infinity, tot: 0, w: 0, codes: [] }));
      g.low = Math.min(g.low, dm.lower ?? 2.0); g.tot += dm.h + (g.codes.length ? 0.03 : 0); g.w = Math.max(g.w, dm.w); g.codes.push(code);
    }
    for (const g of posts.values()) pts.push({ kind: 'sign', cls: 'sign ' + g.codes.join('+'), x: g.x, y: g.y, h: g.low + g.tot, src: 'standard size', r: g.w / 2 });
    // barriers, every metre at their typical heights (kerbs left out)
    let o = 0;
    for (let b = 0; b < (A.bar_n ? A.bar_n.length : 0); b++) {
      const n = A.bar_n[b], c = H.barc[A.bar_c[b]];
      if (c !== 'kerb') for (let j = 0; j + 1 < n; j++) {
        const x0 = A.bar_xy[2 * (o + j)] + dx, y0 = A.bar_xy[2 * (o + j) + 1] + dy, x1 = A.bar_xy[2 * (o + j + 1)] + dx, y1 = A.bar_xy[2 * (o + j + 1) + 1] + dy, L = Math.hypot(x1 - x0, y1 - y0), k = Math.max(1, Math.ceil(L));
        for (let t = 0; t <= k; t++) pts.push({ kind: 'barrier', cls: c.replace('_', ' '), x: x0 + (x1 - x0) * t / k, y: y0 + (y1 - y0) * t / k, h: BAR_H[c] || 0.6, src: 'typical', r: 0, grp: `${H.p}:b${b}` });
      }
      o += n;
    }
    // buildings: their outline every half metre at their height
    o = 0;
    for (let b = 0; b < (A.bld_n ? A.bld_n.length : 0); b++) {
      const n = A.bld_n[b], h = A.bld_h[b];
      for (let j = 0; j < n; j++) {
        const x0 = A.bld_xy[2 * (o + j)] + dx, y0 = A.bld_xy[2 * (o + j) + 1] + dy, jj = (j + 1) % n, x1 = A.bld_xy[2 * (o + jj)] + dx, y1 = A.bld_xy[2 * (o + jj) + 1] + dy, k = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.5));
        for (let t = 0; t < k; t++) pts.push({ kind: 'building', cls: 'building', x: x0 + (x1 - x0) * t / k, y: y0 + (y1 - y0) * t / k, h, src: 'map', r: 0, grp: `${H.p}:h${b}` });
      }
      o += n;
    }
    // trees (crown: top, radius)
    const T = A.tree; for (let i = 0; T && i < T.length / 7; i++) trees.push({ x: T[7 * i] / 10 + dx, y: T[7 * i + 1] / 10 + dy, h: Math.abs(T[7 * i + 2]) / 10, r: T[7 * i + 3] / 10, typ: T[7 * i + 2] < 0 });
    // mapped roads as paved quads (segments widened by their width or the typical one for their class; unpaved tracks too)
    for (const [c, wdm, fl, lev, xy] of H.roads || []) {
      if (fl & 2 || lev) continue;                              // (a tunnel, or a road on another level: not beside us)
      const cls = H.roadc[c] || 'unknown', hw = wdm > 0 ? wdm / 20 : (fl & 16 ? HALF_LINK[cls] : null) || HALF[cls] || 2.5;
      for (let j = 0; j + 3 < xy.length; j += 2) {
        const ax = xy[j] / 10 + dx, ay = xy[j + 1] / 10 + dy, bx = xy[j + 2] / 10 + dx, by = xy[j + 3] / 10 + dy, L = Math.hypot(bx - ax, by - ay); if (L < 0.01) continue;
        const ux = (bx - ax) / L, uy = (by - ay) / L, nx = -uy * hw, ny = ux * hw, ex = ux * hw * 0.7, ey = uy * hw * 0.7;
        quads.push([ax - ex + nx, ay - ey + ny, bx + ex + nx, by + ey + ny, bx + ex - nx, by + ey - ny, ax - ex - nx, ay - ey - ny]);
      }
    }
    for (const q of H.over || []) if (q.s >= sa && q.s < sb) over.push({ ...q, p: H.p, ox: H.ox, oy: H.oy, rb: H.rbridges || [] });
  }
  return { pts, trees, quads, over };
}

// ---------------------------------------------------------------- the route, window by window
const runs = { blade: [], bladeRoad: [], wheels: [] }, hits = [], trees = [], heights = [], artefacts = {};
const t0 = Date.now(); let nwin = 0;
for (let c0 = Math.floor(K0 / CORE) * CORE; c0 < K1; c0 += CORE) {
  const c1 = Math.min(TOTAL, c0 + CORE);
  const Ln = line(c0 - RUNIN - 600, c1 + RUNOUT + 600);
  const sa = Math.max(Math.ceil(Ln.s0), c0 - RUNIN), sb = Math.min(Math.floor(Ln.s1), c1 + RUNOUT);
  if (sb - sa < 150) continue;
  const W = windowOf(Ln, sa, sb), n = W.n, i0 = Math.max(0, c0 - sa), i1 = Math.min(n - 1, c1 - 1 - sa);
  const S = normals(W), pv = pavedFor(W, S, HOTS);
  const res = sweep(VEH, W.P, W.N, W.HL, W.HR, 0, W.HO);
  const E = bladeEdge(VEH, W, res, { i0, i1, S, paved: pv });
  const Ob = obstacles(Ln, sa - 100, sb + 100);
  const E2 = Ob.quads.length ? bladeEdge(VEH, W, res, { i0, i1, S, paved: joinPaved(S.m, pv, roadsAlong(S, Ob.quads)) }) : E;
  // per front-axle metre: the blade beyond the traced edge (and beyond the mapped roads too), the wheels
  for (let i = i0; i <= i1; i++) {
    if (!res.valid[i]) continue; const s = sa + i;
    if (E.depth[i] > SIG) runs.blade.push([s, +E.depth[i].toFixed(2), +E2.depth[i].toFixed(2)]);
    if (res.wc[i] < -0.1) runs.wheels.push([s, +(-res.wc[i]).toFixed(2)]);
  }
  // the blade over the obstacles: each against the positions whose blade can reach it (front axle up to 105 m ahead)
  const grid = new Map(), G = 10;
  for (let i = 0; i < n; i++) { const k = Math.floor(W.P[2 * i] / G) * 1048576 + Math.floor(W.P[2 * i + 1] / G); let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(i); }
  const near = (x, y) => { let best = -1, bd = Infinity; const cx = Math.floor(x / G), cy = Math.floor(y / G);
    for (let r = 0; r <= 6 && best < 0; r++) for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) { if (Math.max(Math.abs(a), Math.abs(b)) !== r) continue; for (const i of grid.get((cx + a) * 1048576 + cy + b) || []) { const d = (W.P[2 * i] - x) ** 2 + (W.P[2 * i + 1] - y) ** 2; if (d < bd) { bd = d; best = i; } } }
    return best; };
  // lateral of (x, y) at sample k (left +), and whether it is beyond the traced edge there
  const latAt = (k, x, y) => (x - W.P[2 * k]) * W.N[2 * k] + (y - W.P[2 * k + 1]) * W.N[2 * k + 1];
  function over(x, y, extra) {          // positions whose blade (outline + extra) covers (x, y): its underside there (across
    const k = near(x, y); if (k < 0) return null;           // the section, and the section's lowest point), range
    let under = Infinity, umin = Infinity, ia = -1, ib = -1, gap = Infinity;
    for (let i = Math.max(i0, k - 5); i <= Math.min(i1, k + 110); i++) {
      if (!res.valid[i]) continue; const o = 14 * i, rx = res.pose[o + 6], ry = res.pose[o + 7];
      let bx = res.pose[o + 8] - rx, by = res.pose[o + 9] - ry; const L = Math.hypot(bx, by) || 1; bx /= L; by /= L;
      const px = x - rx, py = y - ry, t = (px * bx + py * by) / L; if (t < -0.02 || t > 1.02) continue;
      const tc = Math.max(0, Math.min(1, t)), lat = Math.abs(-px * by + py * bx), w = Wt(tc) / 2;
      gap = Math.min(gap, lat - w);
      if (lat <= w + extra) { under = Math.min(under, underAt(tc, lat)); umin = Math.min(umin, Ut(tc)); if (ia < 0) ia = i; ib = i; }
    }
    return { k, under, umin, ia, ib, gap };
  }
  // a tree's crown in the blade's swing beyond the traced edge: where the blade reaches over the verge on the crown's side and
  // the crown reaches into it
  function treeIn(t, k, latT) {
    let ia = -1, ib = -1, under = Infinity; const side = latT > 0 ? 1 : -1, edge = side > 0 ? W.HL[k] : W.HR[k];
    for (let i = Math.max(i0, k - 5); i <= Math.min(i1, k + 110); i++) {
      if (!res.valid[i]) continue; const o = 14 * i, rx = res.pose[o + 6], ry = res.pose[o + 7];
      let bx = res.pose[o + 8] - rx, by = res.pose[o + 9] - ry; const L = Math.hypot(bx, by) || 1; bx /= L; by /= L;
      const px = t.x - rx, py = t.y - ry, tt = (px * bx + py * by) / L; if (tt < -0.02 || tt > 1.02) continue;
      const tc = Math.max(0, Math.min(1, tt)), lat = Math.abs(-px * by + py * bx), w = Wt(tc) / 2;
      if (lat > w + t.r) continue;
      const ax = rx + bx * tc * L, ay = ry + by * tc * L, latA = latAt(k, ax, ay), outer = side > 0 ? latA + w : -(latA - w);
      if (outer > edge + SIG && side * latT - t.r < outer) { under = Math.min(under, underAt(tc, Math.min(lat, w))); if (ia < 0) ia = i; ib = i; }
    }
    return ia < 0 ? null : { ia, ib, under };
  }
  const best = new Map();                 // per barrier / building: its worst point
  const skipGrp = new Set();
  for (const q of Ob.pts) if (q.kind === 'building' && !skipGrp.has(q.grp)) {     // (a building reaching over the carriageway)
    const k = near(q.x, q.y); if (k < 0) continue; const lat = latAt(k, q.x, q.y);
    if (lat < W.HL[k] - 0.3 && lat > -W.HR[k] + 0.3) skipGrp.add(q.grp);
  }
  artefacts.building = (artefacts.building || 0) + skipGrp.size;
  for (const q of Ob.pts) {
    const k = near(q.x, q.y); if (k < 0 || k < i0 - 120 || k > i1 + 5) continue;
    const lat = latAt(k, q.x, q.y); if (Math.abs(lat) > 45) continue;
    // barriers mapped on the carriageway or across it (the road view leaves them out), signs mapped on it (a node of the road
    // itself) and buildings reaching over it (a bridge or a canopy mapped as a building: its clear height is the measure):
    // mapping artefacts, not obstacles beside the road
    const inBand = (m) => lat < W.HL[k] + m && lat > -W.HR[k] - m;
    if ((q.kind === 'barrier' && inBand(0.2)) || (q.kind === 'sign' && inBand(-0.3))) { artefacts[q.kind] = (artefacts[q.kind] || 0) + 1; continue; }
    if (q.grp && q.kind === 'building' && (skipGrp.has(q.grp) || (inBand(-0.3) && skipGrp.add(q.grp)))) continue;
    const r = over(q.x, q.y, 0.3 + q.r); if (!r) continue;
    const inWheels = res.valid[k] && lat <= res.env[4 * k] + 0.25 && lat >= res.env[4 * k + 1] - 0.25 && k >= i0 && k <= i1;
    const free = r.under - q.h, page = q.kind === 'object' && r.umin - q.h < 0.1;     // (the road view's label: "hits")
    if (!(inWheels || free < 0.5 || page)) continue;
    const rec = { kind: q.kind, cls: q.cls, s: sa + (r.ia >= 0 ? r.ia : k), s1: sa + (r.ib >= 0 ? r.ib : k), at: +(sa + k).toFixed(0), lat: +lat.toFixed(1), h: +q.h.toFixed(2), src: q.src,
      under: Number.isFinite(r.under) ? +r.under.toFixed(2) : null, free: Number.isFinite(free) ? +free.toFixed(2) : null, wheels: inWheels, page, ll: LL(q.x + W.O.x, q.y + W.O.y) };
    if (q.grp) { const p = best.get(q.grp); if (!p || (rec.wheels && !p.wheels) || (rec.free ?? 9) < (p.free ?? 9)) best.set(q.grp, { ...rec, s: Math.min(rec.s, p ? p.s : rec.s), s1: Math.max(rec.s1, p ? p.s1 : rec.s1) }); else { p.s = Math.min(p.s, rec.s); p.s1 = Math.max(p.s1, rec.s1); } }
    else hits.push(rec);
  }
  hits.push(...best.values());
  // trees: the crown in the blade's swing where the blade is beyond the traced edge (as the passages count them)
  for (const t of Ob.trees) {
    const k = near(t.x, t.y); if (k < 0 || k < i0 - 120 || k > i1 + 5) continue;
    const lat = latAt(k, t.x, t.y); if (Math.abs(lat) > 40) continue;
    const r = treeIn(t, k, lat); if (!r) continue;
    trees.push({ s: sa + r.ia, s1: sa + r.ib, at: sa + k, lat: +lat.toFixed(1), h: +t.h.toFixed(1), r: +t.r.toFixed(1), typ: t.typ, under: +r.under.toFixed(2), ll: LL(t.x + W.O.x, t.y + W.O.y) });
  }
  // structures over the road: the page's verdict for the default vehicle
  for (const q of Ob.over) {
    if (q.kind === 'artefact' || (q.est == null && q.signed == null && q.note)) continue;
    if (q.kind === 'bridge' && q.rb.some((rb) => q.s >= rb.s0 - 5 && q.s <= rb.s1 + 5)) continue;
    const cl = q.signed != null ? q.signed : q.est != null ? q.est : null, unc = q.signed != null ? 0 : q.unc || 0.5;
    const v = q.check ? 'check' : cl == null ? 'unknown' : cl - unc >= NEED ? 'pass' : cl + unc < NEED ? 'too low' : 'check';
    if (v === 'pass' || v === 'unknown') continue;
    if (heights.some((h) => Math.abs(h.s - q.s) < 3 && h.kind === q.kind)) continue;
    heights.push({ s: +q.s.toFixed(1), kind: q.kind, name: q.name || q.cls || '', clear: cl, unc, verdict: v, src: q.src || '', ll: LL(q.x + q.ox, q.y + q.oy) });
  }
  nwin++;
  if (nwin % 25 === 0) console.error(`km ${(c1 / 1000).toFixed(1)}  ${((Date.now() - t0) / 1000).toFixed(0)} s  blade ${runs.blade.length} m  wheels ${runs.wheels.length} m  objects ${hits.length}  trees ${trees.length}  heights ${heights.length}`);
  dropPacks(Math.floor((c0 - RUNIN - 1200) / PK) - 1);
}

// ---------------------------------------------------------------- the places: metres and items joined within 250 m, outside / inside the passages
const items = [];
const metreRuns = (L, kind, val) => { let cur = null; for (const r of L) { if (cur && r[0] - cur.s1 <= 25) { cur.s1 = r[0]; cur.max = Math.max(cur.max, val(r)); cur.n++; } else { if (cur) items.push(cur); cur = { kind, s: r[0], s1: r[0], max: val(r), n: 1 }; } } if (cur) items.push(cur); };
metreRuns(runs.blade.filter((r) => r[2] > SIG), 'blade beyond the edge', (r) => r[2]);
metreRuns(runs.blade.filter((r) => r[2] <= SIG), 'blade beyond the traced edge over a mapped road', (r) => r[1]);
metreRuns(runs.wheels, 'wheels beyond the edge', (r) => r[1]);
for (const h of hits) items.push({ kind: h.wheels ? `${h.kind} in the wheels' path` : `blade over ${h.kind}`, s: h.s, s1: h.s1, max: h.free, item: h });
for (const t of trees) items.push({ kind: 'tree in the blade swing', s: t.s, s1: t.s1, max: t.h, item: t });
for (const h of heights) items.push({ kind: `clear height (${h.verdict})`, s: h.s, s1: h.s, max: h.clear, item: h });
for (const it of items) { const ha = inPassage(it.s), hb = inPassage(it.s1); it.passage = ha && hb && ha.id === hb.id ? ha.id : null; it.part = !it.passage && (ha || hb) ? (ha || hb).id : null; }
items.sort((a, b) => a.s - b.s);
const spots = [];
for (const it of items.filter((q) => !q.passage)) {
  const p = spots[spots.length - 1];
  if (p && it.s - p.s1 <= 250) { p.s1 = Math.max(p.s1, it.s1); p.items.push(it); } else spots.push({ s: it.s, s1: it.s1, items: [it] });
}
const OUT = process.env.OUT || path.join(C, 'corr', 'route_scan.json');
fs.writeFileSync(OUT, JSON.stringify({ vehicle: VEH, km: [K0 / 1000, K1 / 1000], passages: HOTS, artefacts, items, spots }));
console.log('left out as mapping artefacts:', JSON.stringify(artefacts));
console.log(`${nwin} windows, ${((Date.now() - t0) / 1000).toFixed(0)} s; ${items.length} items, ${items.filter((q) => !q.passage).length} outside the passages in ${spots.length} places → ${OUT}`);
for (const sp of spots) {
  const kinds = {}; for (const it of sp.items) kinds[it.kind] = (kinds[it.kind] || 0) + 1;
  console.log(`km ${(sp.s / 1000).toFixed(3)}–${(sp.s1 / 1000).toFixed(3)}  ${Object.entries(kinds).map(([k, v]) => `${k} ×${v}`).join(', ')}`);
}
