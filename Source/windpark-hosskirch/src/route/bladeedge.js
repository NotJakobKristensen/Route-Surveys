// The blade beyond the edge, measured: one model for the passage view, the drive view and the bake (tools/route_blade.mjs
// runs this file in Node). The blade's plan outline as it is drawn (blade.js: the root frame, then the sections as carried)
// at every place the convoy takes: the metre poses of the swept-path model (vehicle.js) and the places in between, as the
// convoy is animated (poses interpolated linearly), so the tip's swing leaves no gaps. It is measured along the normals of
// the convoy's line (one per metre, more in sharp bends, where they fan out), each holding the points whose nearest normal
// of the line it is (so nothing is counted twice where a bend's normals cross or the route passes close to itself): beyond
// the edge is what lies outside the carriageway measured on the aerial photo (the band between the edges left and right of
// the line, every metre) and outside any further paved surface given (in a passage: the paved surface traced on its
// photo: junction mouths, slip roads, lay-bys), counted where it reaches more than the traced edge's tolerance (0.3 m) beyond.
// Result: the stretches beyond on every normal, the blade's outer sweep there, and per front-axle position how far its blade
// reaches beyond the paved surface.
import { bladeProfile } from './blade.js';

const CELL = 4;                 // m, grid of the normals' feet for the nearest-normal lookups
const STEP = 0.25;              // m, the blade's ends move at most this far across it between two places measured
const OWN = 3;                  // m, a point belongs to a normal while its nearest normal is within ± OWN along the line
const SURE = 0.6;               // m, a blade stretch this far inside both edges is on the carriageway without measuring
export const SIG = 0.3;         // m, the measuring tolerance of the traced edge: less than this beyond it is not counted
const FAN = 2 * Math.PI / 180;  // neighbouring normals more than 2° apart: normals in between (in halves down to 1/16 m)
export const SUB = 16;          // a normal's place along the line in 1/16 m (u16 = 16 · (s − window start))

/** the normals the window W (its metres: P, N, HL, HR) is measured along: one per metre, square to the line itself (from
 *  the metres two before and after), and where two neighbours are more than 2° apart as many in between as halve the
 *  angle below that (their foot, normal and edges interpolated). → { m, u16: Int32Array, P, NT (Float64Array 2m), HL, HR
 *  (Float32Array m), base: Int32Array (the metre before) } */
export function normals(W) {
  const { n, P } = W, T = new Float64Array(2 * n);
  for (let k = 0; k < n; k++) {
    const a = Math.max(0, k - 2), b = Math.min(n - 1, k + 2), tx = P[2 * b] - P[2 * a], ty = P[2 * b + 1] - P[2 * a + 1], l = Math.hypot(tx, ty) || 1;
    T[2 * k] = -ty / l; T[2 * k + 1] = tx / l;
  }
  const parts = new Uint8Array(n);
  let m = 0;
  for (let k = 0; k < n; k++) {
    let f = 1;
    if (k < n - 1) { const c = Math.max(-1, Math.min(1, T[2 * k] * T[2 * k + 2] + T[2 * k + 1] * T[2 * k + 3])), ang = Math.acos(c); while (ang / f > FAN && f < SUB) f *= 2; }
    parts[k] = f; m += f;
  }
  const u16 = new Int32Array(m), SP = new Float64Array(2 * m), NT = new Float64Array(2 * m), HL = new Float32Array(m), HR = new Float32Array(m), base = new Int32Array(m);
  let o = 0;
  for (let k = 0; k < n; k++) {
    const f = parts[k], k2 = Math.min(n - 1, k + 1);
    for (let j = 0; j < f; j++, o++) {
      const t = j / f;
      u16[o] = k * SUB + (j * SUB) / f; base[o] = k;
      SP[2 * o] = P[2 * k] + (P[2 * k2] - P[2 * k]) * t; SP[2 * o + 1] = P[2 * k + 1] + (P[2 * k2 + 1] - P[2 * k + 1]) * t;
      const nx = T[2 * k] + (T[2 * k2] - T[2 * k]) * t, ny = T[2 * k + 1] + (T[2 * k2 + 1] - T[2 * k + 1]) * t, l = Math.hypot(nx, ny) || 1;
      NT[2 * o] = nx / l; NT[2 * o + 1] = ny / l;
      HL[o] = W.HL[k] + (W.HL[k2] - W.HL[k]) * t; HR[o] = W.HR[k] + (W.HR[k2] - W.HR[k]) * t;
    }
  }
  return { m, u16, P: SP, NT, HL, HR, base };
}
// a normal through the triangle (ax, ay, bx, by, cx, cy): the interval it runs inside it (pushed to out)
function triCut(px, py, nx, ny, ax, ay, bx, by, cx, cy, out) {
  let lo = Infinity, hi = -Infinity;
  const edge = (x0, y0, x1, y1) => { const ex = x1 - x0, ey = y1 - y0, den = nx * ey - ny * ex; if (Math.abs(den) < 1e-12) return;
    const u = ((x0 - px) * ey - (y0 - py) * ex) / den, v = ((x0 - px) * ny - (y0 - py) * nx) / den;
    if (v >= -1e-9 && v <= 1 + 1e-9) { if (u < lo) lo = u; if (u > hi) hi = u; } };
  edge(ax, ay, bx, by); edge(bx, by, cx, cy); edge(cx, cy, ax, ay);
  if (hi > lo) out.push([lo, hi]);
}
const merge = (L) => { L.sort((a, b) => a[0] - b[0]); const M = []; for (const q of L) { if (M.length && q[0] <= M[M.length - 1][1] + 1e-6) M[M.length - 1][1] = Math.max(M[M.length - 1][1], q[1]); else M.push([q[0], q[1]]); } return M; };

/** the further paved surface (rings: closed outlines in the window's frame, even-odd) along the normals S = normals(W): per
 *  normal the intervals that reach beyond the carriageway's edges by more than the edge's tolerance (less is the same edge
 *  traced twice), each reaching 1.5 m back over the carriageway (the edges were measured along the route's normals, these
 *  run square to the line, and the two differ a little in bends), out to 80 m → { at: Int32Array(m + 1), d: Float32Array } */
export function pavedAlong(S, rings) {
  const { m, P, NT, HL, HR } = S, at = new Int32Array(m + 1), d = [], segs = [], G = new Map(), CS = 8, RMAX = 80;
  for (const r of rings || []) { const q = r.length / 2; for (let k = 0; k < q; k++) { const b = (k + 1) % q; segs.push([r[2 * k], r[2 * k + 1], r[2 * b], r[2 * b + 1]]); } }
  segs.forEach((s, i) => { for (let x = Math.floor(Math.min(s[0], s[2]) / CS); x <= Math.floor(Math.max(s[0], s[2]) / CS); x++) for (let y = Math.floor(Math.min(s[1], s[3]) / CS); y <= Math.floor(Math.max(s[1], s[3]) / CS); y++) { const k = x * 1048576 + y; let a = G.get(k); if (!a) G.set(k, (a = [])); a.push(i); } });
  for (let k = 0; k < m; k++) {
    at[k] = d.length / 2; if (!segs.length) continue;
    const px = P[2 * k], py = P[2 * k + 1], nx = NT[2 * k], ny = NT[2 * k + 1], seen = new Set(), xs = [];
    for (let t = -RMAX; t <= RMAX; t += CS / 2) { const cx = Math.floor((px + nx * t) / CS), cy = Math.floor((py + ny * t) / CS);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const si of G.get((cx + i) * 1048576 + cy + j) || []) seen.add(si); }
    for (const si of seen) { const [ax, ay, bx, by] = segs[si], ex = bx - ax, ey = by - ay, den = nx * ey - ny * ex; if (Math.abs(den) < 1e-12) continue;
      const u = ((ax - px) * ey - (ay - py) * ex) / den, v = ((ax - px) * ny - (ay - py) * nx) / den; if (v >= 0 && v < 1 && Math.abs(u) <= RMAX) xs.push(u); }
    xs.sort((a, b) => a - b);
    const x0 = px - nx * RMAX, y0 = py - ny * RMAX; let inside = false;          // (the normal may start inside the surface)
    for (const r of rings) { const q = r.length / 2; for (let i = 0, j = q - 1; i < q; j = i++) { const xi = r[2 * i], yi = r[2 * i + 1], xj = r[2 * j], yj = r[2 * j + 1]; if ((yi > y0) !== (yj > y0) && x0 < ((xj - xi) * (y0 - yi)) / (yj - yi) + xi) inside = !inside; } }
    if (inside) xs.unshift(-RMAX);
    if (xs.length % 2) xs.push(RMAX);
    for (let j = 0; j + 1 < xs.length; j += 2) {
      const a = xs[j], b = xs[j + 1];
      if (a < -HR[k] - SIG) { const e = Math.min(b, -HR[k] + 1.5); d.push(a, e); }
      if (b > HL[k] + SIG) { const e = Math.max(a, HL[k] - 1.5); if (d.length / 2 > at[k] && d[d.length - 1] >= e) d[d.length - 1] = b; else d.push(e, b); }
    }
  }
  at[m] = d.length / 2;
  return { at, d: Float32Array.from(d) };
}

/** W: the window's metres (P interleaved x/y, N the route's normals the edges were measured along, HL / HR the
 *  carriageway's edges left / right of the convoy's line P); res: the convoy's places (sweep(): valid, pose per front-axle
 *  position, in W's frame; positions need not be W's metres); opts.i0 / i1: the positions counted (default all);
 *  opts.skip: positions (Uint8Array, 1 = skip) whose blade counts for the outer sweep only (measured elsewhere);
 *  opts.S: normals(W) (made if not given); opts.paved: pavedAlong() of the further paved surface on those normals.
 *  Returns { S, runs: {k (normal), d0, d1} (beyond, offsets along the normal, left +), out: Float32Array(2 S.m) (the blade's
 *  outer sweep on each normal: farthest left, farthest right; NaN where it does not pass), depth: Float32Array (per position:
 *  how far its blade reaches beyond the paved surface, m), area (m², of cells()), max (m), atMax (normal of the deepest
 *  point), atPos (position then) } */
export function bladeEdge(v, W, res, opts = {}) {
  const { n } = W, WP = W.P, WN = W.N, np = res.valid.length;
  const S = opts.S || normals(W), { m, P, NT, HL, HR, u16 } = S;
  const i0 = Math.max(0, opts.i0 ?? 0), i1 = Math.min(np - 1, opts.i1 ?? np - 1), pav = opts.paved || null, skip = opts.skip || null;
  const prof = bladeProfile(v), NS = prof.n, HW = new Float64Array(NS); let hmax = 0;
  for (let j = 0; j < NS; j++) { HW[j] = prof.W[j] / 2; hmax = Math.max(hmax, HW[j]); }
  const Lb = v.bladeLength;
  // ---- the normals' feet in a grid, and the nearest normal to a point
  const grid = new Map();
  for (let k = 0; k < m; k++) { const key = Math.floor(P[2 * k] / CELL) * 1048576 + Math.floor(P[2 * k + 1] / CELL); let a = grid.get(key); if (!a) grid.set(key, (a = [])); a.push(k); }
  const nearest = (x, y) => {
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL); let best = -1, bd = Infinity;
    for (let r = 0; r <= 40; r++) {
      for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
        const a = grid.get((cx + i) * 1048576 + cy + j); if (!a) continue;
        for (const k of a) { const d = (P[2 * k] - x) ** 2 + (P[2 * k + 1] - y) ** 2; if (d < bd) { bd = d; best = k; } }
      }
      if (best >= 0 && bd <= (r * CELL) ** 2) break;          // (nothing nearer can lie in a farther ring)
    }
    return best;
  };
  // ---- how far out each normal holds the points (left / right): out to where the nearest normal is no longer this one
  // (the centre of a bend, half way to another part of the route); found where needed, kept
  const reach = new Float32Array(2 * m).fill(NaN), done = new Float32Array(2 * m);
  const owns = (k, d) => { const q = nearest(P[2 * k] + NT[2 * k] * d, P[2 * k + 1] + NT[2 * k + 1] * d); return q >= 0 && Math.abs(u16[q] - u16[k]) <= OWN * SUB; };
  const reachTo = (k, side, need) => {
    const o = 2 * k + side;
    if (!Number.isNaN(reach[o])) return reach[o];
    if (done[o] >= need) return Infinity;
    const sg = side ? -1 : 1;
    for (let d = Math.max(0.5, done[o] + 0.5); d <= need + 0.5; d += 0.5) {
      if (!owns(k, sg * d)) { let a = d - 0.5, b = d; for (let it = 0; it < 6; it++) { const c = (a + b) / 2; if (owns(k, sg * c)) a = c; else b = c; } reach[o] = a; return a; }
      done[o] = d;
    }
    return Infinity;
  };
  // ---- the paved intervals on normal k: the carriageway (the band of the window's quads between the edge points, as far
  // as they cross this normal), joined with the further paved surface
  const PAV = new Array(m);
  const pavedOf = (k) => {
    const px = P[2 * k], py = P[2 * k + 1], nx = NT[2 * k], ny = NT[2 * k + 1], L = [], b = S.base[k];
    for (let j = Math.max(0, b - 40); j < Math.min(n - 1, b + 40); j++) {
      const lx0 = WP[2 * j] + WN[2 * j] * W.HL[j], ly0 = WP[2 * j + 1] + WN[2 * j + 1] * W.HL[j], lx1 = WP[2 * j + 2] + WN[2 * j + 2] * W.HL[j + 1], ly1 = WP[2 * j + 3] + WN[2 * j + 3] * W.HL[j + 1];
      const rx0 = WP[2 * j] - WN[2 * j] * W.HR[j], ry0 = WP[2 * j + 1] - WN[2 * j + 1] * W.HR[j], rx1 = WP[2 * j + 2] - WN[2 * j + 2] * W.HR[j + 1], ry1 = WP[2 * j + 3] - WN[2 * j + 3] * W.HR[j + 1];
      triCut(px, py, nx, ny, lx0, ly0, lx1, ly1, rx1, ry1, L); triCut(px, py, nx, ny, lx0, ly0, rx1, ry1, rx0, ry0, L);
    }
    if (pav) for (let j = pav.at[k]; j < pav.at[k + 1]; j++) L.push([pav.d[2 * j], pav.d[2 * j + 1]]);
    return merge(L);
  };
  // ---- per normal: the stretches beyond (kept merged), the outer sweep
  const runs = new Array(m), out = new Float32Array(2 * m).fill(NaN), depth = new Float32Array(np);
  let max = 0, atMax = -1, atPos = -1;
  const addRun = (k, a, b) => {
    let R = runs[k]; if (!R) runs[k] = R = [];
    for (const q of R) if (a <= q[1] + 1e-4 && b >= q[0] - 1e-4) { q[0] = Math.min(q[0], a); q[1] = Math.max(q[1], b); return; }
    R.push([a, b]);
  };
  // how far the point (x, y), on normal k0, lies from the paved surface (Euclidean): the nearest of the paved stretches on the
  // normals within ±200 of it, the ground between two neighbouring normals' overlapping stretches counted as paved. Within
  // `bound`; the search stops once the point is found no farther than `need` (it then changes nothing)
  const EXT = new Float32Array(m).fill(NaN);        // (per normal: how far from its foot its paved stretches reach)
  const pavedAt = (j) => { let M = PAV[j]; if (!M) { M = PAV[j] = pavedOf(j); let e = 0; for (const q of M) e = Math.max(e, Math.abs(q[0]), Math.abs(q[1])); EXT[j] = e; } return M; };
  const segD = (x, y, ax, ay, bx, by) => { const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy, t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / l2)) : 0; return Math.hypot(x - ax - vx * t, y - ay - vy * t); };
  const inTri = (x, y, ax, ay, bx, by, cx, cy) => { const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by), d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy), d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0)); };
  const dist = (x, y, bound, need, k0) => {
    let best = bound;
    const visit = (j) => {                          // the paved stretches of normal j and the ground to normal j + 1
      const Mj = pavedAt(j), Mn = pavedAt(j + 1);
      if (Math.hypot(x - P[2 * j], y - P[2 * j + 1]) - EXT[j] - 1.5 > best) return;
      const px = P[2 * j], py = P[2 * j + 1], nx = NT[2 * j], ny = NT[2 * j + 1], qx = P[2 * j + 2], qy = P[2 * j + 3], mx = NT[2 * j + 2], my = NT[2 * j + 3];
      for (let u = 0; u < Mj.length; u++) {
        const lo = Mj[u][0], hi = Mj[u][1], ax = px + nx * lo, ay = py + ny * lo, bx = px + nx * hi, by = py + ny * hi;
        const d = segD(x, y, ax, ay, bx, by); if (d < best) best = d;
        for (let w = 0; w < Mn.length; w++) {
          const lo2 = Mn[w][0], hi2 = Mn[w][1]; if (lo2 > hi || hi2 < lo) continue;
          const cx = qx + mx * hi2, cy = qy + my * hi2, ex = qx + mx * lo2, ey = qy + my * lo2;
          if (inTri(x, y, ax, ay, bx, by, cx, cy) || inTri(x, y, ax, ay, cx, cy, ex, ey)) { best = 0; return; }
          const d2 = Math.min(segD(x, y, bx, by, cx, cy), segD(x, y, ax, ay, ex, ey)); if (d2 < best) best = d2;
        }
      }
    };
    for (let dj = 0; dj <= 200 && best > need; dj++) {
      const j1 = k0 - dj, j2 = k0 + dj;
      if (j1 >= 0 && j1 < m - 1) visit(j1);
      if (dj && j2 >= 0 && j2 < m - 1 && best > need) visit(j2);
      // (past 8 normals each way: on when either foot is still near enough to hold a paved stretch nearer than the best)
      if (dj > 8) { const f1 = j1 >= 0 ? Math.hypot(x - P[2 * j1], y - P[2 * j1 + 1]) : Infinity, f2 = j2 < m ? Math.hypot(x - P[2 * j2], y - P[2 * j2 + 1]) : Infinity; if (Math.min(f1, f2) - 50 > best) break; }
    }
    return best;
  };
  // one stretch [a, b] of the blade on normal k, at front-axle position i: what of it lies beyond the paved area, and how far
  const take = (k, a, b, i) => {
    const sure = a >= -HR[k] + SURE && b <= HL[k] - SURE;
    if (!sure) { if (b > 0) b = Math.min(b, reachTo(k, 0, b)); if (a < 0) a = Math.max(a, -reachTo(k, 1, -a)); if (!(b > a)) return; }
    if (Number.isNaN(out[2 * k]) || b > out[2 * k]) out[2 * k] = b;
    if (Number.isNaN(out[2 * k + 1]) || a < out[2 * k + 1]) out[2 * k + 1] = a;
    if (sure || (skip && skip[i])) return;
    const M = PAV[k] || (PAV[k] = pavedOf(k));
    if (!M.length) return;                                                  // (no carriageway on this normal: not measured)
    let x = a;
    for (let j = 0; j <= M.length; j++) {
      const lo = j < M.length ? M[j][0] : Infinity, e = Math.min(b, lo);
      if (e > x + 1e-6) {
        // drawn and counted where it reaches more than the edge's measuring tolerance beyond the paved surface (along this
        // normal); its depth, the farthest of its ends and middle from the paved surface, is taken in any case (no farther
        // than the paved boundary on this normal: a bound that spares the search where the position already reaches farther)
        const below = j > 0 ? M[j - 1][1] : -Infinity, above = lo, mid = (below + above) / 2;
        const along = below === -Infinity ? above - x : above === Infinity ? e - below : mid >= x && mid <= e ? mid - below : e < mid ? e - below : above - x;
        if (along > SIG) {
          addRun(k, x, e);
          // its farthest point from the paved surface: its outer end (outside the outermost paved stretch), else the point
          // nearest the middle of the gap; measured where it can reach farther than the position already does (and than the
          // tolerance: nearer counts as on the edge)
          const t = below === -Infinity ? x : above === Infinity ? e : Math.max(x, Math.min(e, mid)), ub = Math.min(t - below, above - t);
          if (ub > depth[i] + 1e-3) {
            const dd = dist(P[2 * k] + NT[2 * k] * t, P[2 * k + 1] + NT[2 * k + 1] * t, ub, Math.max(depth[i], SIG), k);
            if (dd > depth[i]) depth[i] = dd;
            if (dd > max) { max = dd; atMax = k; atPos = i; }
          }
        }
      }
      if (j === M.length || M[j][1] >= b) break;
      x = Math.max(x, M[j][1]);
    }
  };
  // ---- the blade at one place: root (rx, ry), unit axis (ux, uy); its cut with normal k: [a, b] or null
  let rx = 0, ry = 0, ux = 1, uy = 0;
  const cut = (k) => {
    const px = P[2 * k] - rx, py = P[2 * k + 1] - ry, nx = NT[2 * k], ny = NT[2 * k + 1];
    const a0 = px * ux + py * uy, a1 = nx * ux + ny * uy;                  // along the blade = a0 + a1·d
    const c0 = -px * uy + py * ux, c1 = -nx * uy + ny * ux;               // across = c0 + c1·d
    let dA, dB;
    if (Math.abs(c1) > 1e-9) { const dm = -c0 / c1, w = (hmax + 0.01) / Math.abs(c1); dA = dm - w; dB = dm + w; }
    else { if (Math.abs(c0) > hmax) return null; dA = -1e4; dB = 1e4; }
    let tA = (a0 + a1 * dA) / Lb, tB = (a0 + a1 * dB) / Lb; if (tA > tB) { const s = tA; tA = tB; tB = s; }
    if (tB < 0 || tA > 1) return null;
    const j0 = Math.max(0, Math.floor(tA * (NS - 1))), j1 = Math.min(NS - 2, Math.ceil(tB * (NS - 1)));
    let lo = Infinity, hi = -Infinity;
    for (let j = j0; j <= j1; j++) {
      // section j of the outline: t in [tj, tj1], half-width h = HW[j] + g·(t − tj); with t = (a0 + a1·d) / Lb every bound is linear in d
      const tj = j / (NS - 1), tj1 = (j + 1) / (NS - 1), g = (HW[j + 1] - HW[j]) * (NS - 1);
      let d0 = -Infinity, d1 = Infinity;
      const lin = (p, q) => { if (Math.abs(p) < 1e-12) { if (q < 0) { d0 = Infinity; d1 = -Infinity; } return; } if (p > 0) d1 = Math.min(d1, q / p); else d0 = Math.max(d0, q / p); };
      lin(a1 / Lb, tj1 - a0 / Lb); lin(-a1 / Lb, a0 / Lb - tj);
      const h0 = HW[j] + g * (a0 / Lb - tj), hg = g * a1 / Lb;
      lin(c1 - hg, h0 - c0); lin(-c1 - hg, h0 + c0);
      if (d1 >= d0) { if (d0 < lo) lo = d0; if (d1 > hi) hi = d1; }
    }
    return hi >= lo ? [lo, hi] : null;
  };
  // ---- the places: every front-axle metre and the places between two valid ones (as the convoy is drawn moving)
  const prevA = new Float64Array(m), prevB = new Float64Array(m), prevQ = new Int32Array(m).fill(-9);   // (per normal: its cut at the place before)
  const cand = new Uint8Array(m), list = [];
  let q = 0;
  const place = (i, Rx, Ry, Tx, Ty) => {
    rx = Rx; ry = Ry; const bx = Tx - Rx, by = Ty - Ry, L = Math.hypot(bx, by) || 1; ux = bx / L; uy = by / L;
    // the normals that can hold a part of this blade: around the nearest normal of points along its axis (± 8 m)
    list.length = 0;
    for (let s = 0; s <= 8; s++) {
      const k = nearest(Rx + bx * s / 8, Ry + by * s / 8); if (k < 0) continue;
      for (let kk = k; kk >= 0 && u16[k] - u16[kk] <= 8 * SUB; kk--) if (!cand[kk]) { cand[kk] = 1; list.push(kk); }
      for (let kk = k + 1; kk < m && u16[kk] - u16[k] <= 8 * SUB; kk++) if (!cand[kk]) { cand[kk] = 1; list.push(kk); }
    }
    for (const k of list) {
      cand[k] = 0;
      const c = cut(k); if (!c) continue;
      let a = c[0], b = c[1];
      // swept since the place before (where the two cuts overlap: the blade slid along this normal, nothing in between missed)
      if (prevQ[k] === q - 1 && a <= prevB[k] + 0.05 && b >= prevA[k] - 0.05) { a = Math.min(a, prevA[k]); b = Math.max(b, prevB[k]); }
      prevA[k] = c[0]; prevB[k] = c[1]; prevQ[k] = q;
      take(k, a, b, i);
    }
    q++;
  };
  const pose = res.pose;
  for (let i = i0; i <= i1; i++) {
    if (!res.valid[i]) { q += 2; continue; }
    const o = 14 * i;
    place(i, pose[o + 6], pose[o + 7], pose[o + 8], pose[o + 9]);
    if (i < i1 && res.valid[i + 1]) {
      // as many places between as keep both ends' moves across the blade within STEP (a move along it leaves no gap)
      const o2 = o + 14, bx = pose[o + 8] - pose[o + 6], by = pose[o + 9] - pose[o + 7], bl = Math.hypot(bx, by) || 1;
      const across = (dx, dy) => Math.abs(dx * by - dy * bx) / bl;
      const f = Math.min(128, Math.max(1, Math.ceil(Math.max(across(pose[o2 + 8] - pose[o + 8], pose[o2 + 9] - pose[o + 9]), across(pose[o2 + 6] - pose[o + 6], pose[o2 + 7] - pose[o + 7])) / STEP)));
      for (let s = 1; s < f; s++) { const t = s / f;
        place(i, pose[o + 6] + (pose[o2 + 6] - pose[o + 6]) * t, pose[o + 7] + (pose[o2 + 7] - pose[o + 7]) * t, pose[o + 8] + (pose[o2 + 8] - pose[o + 8]) * t, pose[o + 9] + (pose[o2 + 9] - pose[o + 9]) * t); }
    }
  }
  let nr = 0; for (let k = 0; k < m; k++) if (runs[k]) { runs[k].sort((x, y) => x[0] - y[0]); nr += runs[k].length; }
  const K = new Int32Array(nr), D0 = new Float32Array(nr), D1 = new Float32Array(nr); let r = 0;
  for (let k = 0; k < m; k++) if (runs[k]) for (const [a, b] of runs[k]) { K[r] = k; D0[r] = a; D1[r] = b; r++; }
  const result = { S, runs: { k: K, d0: D0, d1: D1 }, out, depth, max, atMax, atPos, area: 0 };
  result.area = cells(S, result.runs).area;
  return result;
}

/** The stretches beyond (runs {k, d0, d1} on the normals S) as cells of the ground (what is drawn and counted): a stretch on
 *  normal k spans from half way to the normal before to half way to the one after (the line and its normal there: the mean
 *  of the two), its ends there the mean of this stretch's and the neighbour's where both normals hold one stretch on that
 *  side and they overlap (so the outline runs smoothly), else its own. Returns { area, quads: Float64Array (8 per cell: x, y
 *  of the four corners in the window's frame), k, side (0 left, 1 right) } */
export function cells(S, runs) {
  const { m, P, NT } = S, { k: K, d0: D0, d1: D1 } = runs, nr = K.length;
  const first = new Int32Array(m).fill(-1), cnt = new Int32Array(m);
  for (let r = nr - 1; r >= 0; r--) first[K[r]] = r;
  for (let r = 0; r < nr; r++) cnt[K[r]]++;
  const sideOf = (r) => (D1[r] <= 0 ? 1 : 0);
  const one = (k, side) => {
    if (k < 0 || k >= m || first[k] < 0) return -1; let f = -1, c = 0;
    for (let r = first[k]; r < first[k] + cnt[k]; r++) if (sideOf(r) === side) { f = r; c++; }
    return c === 1 ? f : -1;
  };
  const half = (k, dir) => {        // half way from normal k to its neighbour (dir ±1): the foot and the mean normal
    const k2 = k + dir;
    if (k2 < 0 || k2 >= m) { const k3 = Math.max(0, Math.min(m - 1, k - dir)); return [P[2 * k] + (P[2 * k] - P[2 * k3]) / 2, P[2 * k + 1] + (P[2 * k + 1] - P[2 * k3 + 1]) / 2, NT[2 * k], NT[2 * k + 1]]; }
    const nx = NT[2 * k] + NT[2 * k2], ny = NT[2 * k + 1] + NT[2 * k2 + 1], l = Math.hypot(nx, ny) || 1;
    return [(P[2 * k] + P[2 * k2]) / 2, (P[2 * k + 1] + P[2 * k2 + 1]) / 2, nx / l, ny / l];
  };
  const quads = new Float64Array(8 * nr), side = new Uint8Array(nr);
  let area = 0;
  for (let r = 0; r < nr; r++) {
    const k = K[r], s_ = sideOf(r); side[r] = s_;
    let a0 = D0[r], b0 = D1[r], a1 = D0[r], b1 = D1[r];
    if (one(k, s_) === r) {
      const o0 = one(k - 1, s_), o1 = one(k + 1, s_);
      if (o0 >= 0 && D0[o0] <= D1[r] && D1[o0] >= D0[r]) { a0 = (D0[r] + D0[o0]) / 2; b0 = (D1[r] + D1[o0]) / 2; }
      if (o1 >= 0 && D0[o1] <= D1[r] && D1[o1] >= D0[r]) { a1 = (D0[r] + D0[o1]) / 2; b1 = (D1[r] + D1[o1]) / 2; }
    }
    const [xA, yA, nA, mA] = half(k, -1), [xB, yB, nB, mB] = half(k, 1);
    const c = [xA + nA * a0, yA + mA * a0, xB + nB * a1, yB + mB * a1, xB + nB * b1, yB + mB * b1, xA + nA * b0, yA + mA * b0];
    quads.set(c, 8 * r);
    area += Math.abs((c[0] * c[3] - c[2] * c[1]) + (c[2] * c[5] - c[4] * c[3]) + (c[4] * c[7] - c[6] * c[5]) + (c[6] * c[1] - c[0] * c[7])) / 2;
  }
  return { area, quads, k: K, side };
}

/** The drive view's measure of one window (in the sweep worker, or on the main thread without one). M: the window's whole
 *  route metres (n, sa: the route metre of the first; P, N, HL, HR as for bladeEdge, in the frame of the convoy's poses), skip
 *  (positions whose blade is measured elsewhere: a passage's own result), paved ({ u: places along the route in 1/SUB m,
 *  at, d }: the paved surface traced at the passages, on their normals). → plain arrays for the drawing and the card: the
 *  normals (sa, m, u16, P, NT), the stretches beyond (k, d0, d1), the outer sweep (out), the depth per position, ms */
export function edgeOf(v, M, res) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  const S = normals(M);
  let paved = null;
  if (M.paved && M.paved.u.length) {
    const idx = new Map(); for (let j = 0; j < M.paved.u.length; j++) idx.set(M.paved.u[j], j);
    const at = new Int32Array(S.m + 1), d = [];
    for (let k = 0; k < S.m; k++) { at[k] = d.length / 2; const j = idx.get(M.sa * SUB + S.u16[k]); if (j != null) for (let q = M.paved.at[j]; q < M.paved.at[j + 1]; q++) d.push(M.paved.d[2 * q], M.paved.d[2 * q + 1]); }
    at[S.m] = d.length / 2; paved = { at, d: Float32Array.from(d) };
  }
  const E = bladeEdge(v, M, res, { S, paved, skip: M.skip || null });
  return { sa: M.sa, m: S.m, u16: S.u16, P: S.P, NT: S.NT, k: E.runs.k, d0: E.runs.d0, d1: E.runs.d1, out: E.out, depth: E.depth, max: E.max,
    ms: typeof performance !== 'undefined' ? performance.now() - t0 : 0 };
}
