// The blade transport as the user describes it: dimensions of the blade and the vehicle, kept in the browser,
// the convoy's kinematics and its swept path along a stretch of road (the same model as tools/route_swept.py).

import { bladeProfile } from './blade.js';

export const DEFAULTS = {
  bladeLength: 84.3,      // m, Vestas V172 blade
  rootDiameter: 4.2,      // m, root flange with the transport adapter
  maxChord: 4.3,          // m, widest chord of the blade (V172, at 23 % of the span)
  width: 4.2,             // m, widest point of the load seen from above (root adapter)
  height: 4.7,            // m, highest point above the road (root adapter top)
  undersideSupport: 1.6,  // m, blade underside above the road at the rear support
  undersideTip: 3.2,      // m, blade underside at the tip (pre-bend, tilt)
  frontOverhang: 1.4,     // m, tractor bumper → steered axle
  tractorLength: 8.4,     // m, tractor bumper → rear end
  wheelbase: 4.8,         // m, steered axle → drive tandem
  kingpinAhead: 0.6,      // m, king pin ahead of the drive tandem
  frontUnit: 6.5,         // m, king pin → blade-root turntable
  rootAhead: 1.2,         // m, root face ahead of the front support
  support: 50.0,          // m, front support → rear dolly turntable
  dollyLength: 7.2,       // m
  tractorWidth: 2.55, frontWidth: 2.9, dollyWidth: 2.9,
  dollyMaxOffset: 3.5,    // m, how far the remote-steered dolly can leave the path to either side
  wheelClear: 0.5,        // m, wheel clearance to the edge wanted where the road allows
  heightMargin: 0.10,     // m, wanted margin under structures
  weight: 35,             // t, blade incl. frames (police report: about 35 t); vehicle total below
  gross: 72,              // t, gross weight of the convoy
};
export const LABELS = {
  bladeLength: ['Blade length', 'm'], rootDiameter: ['Root diameter (with adapter)', 'm'], maxChord: ['Widest chord of the blade', 'm'],
  width: ['Widest point of the load (plan view)', 'm'], height: ['Transport height (highest point)', 'm'],
  undersideSupport: ['Blade underside at the rear support', 'm'], undersideTip: ['Blade underside at the tip', 'm'],
  frontOverhang: ['Tractor front overhang', 'm'], tractorLength: ['Tractor length', 'm'], wheelbase: ['Tractor wheelbase (steer → tandem)', 'm'], kingpinAhead: ['King pin ahead of tandem', 'm'],
  frontUnit: ['Front unit: king pin → root turntable', 'm'], rootAhead: ['Root face ahead of front support', 'm'], support: ['Front support → rear dolly turntable', 'm'],
  dollyLength: ['Rear dolly length', 'm'], tractorWidth: ['Tractor width', 'm'], frontWidth: ['Front unit width', 'm'], dollyWidth: ['Rear dolly width', 'm'],
  dollyMaxOffset: ['Rear dolly steering, max offset', 'm'], wheelClear: ['Wheel clearance wanted', 'm'], heightMargin: ['Height margin wanted', 'm'],
  weight: ['Blade weight', 't'], gross: ['Gross weight', 't'],
};
const KEY = 'hosskirch-route-vehicle-v1';
export function loadVehicle() {
  try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); if (v) return { ...DEFAULTS, ...v }; } catch { /* storage unavailable */ }
  return { ...DEFAULTS };
}
export function saveVehicle(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* ignore */ } }
export const derived = (v) => {
  const p1Back = v.wheelbase - v.kingpinAhead + v.frontUnit;
  return { p1Back, length: v.frontOverhang + p1Back + v.bladeLength - v.rootAhead, overhang: v.bladeLength - v.rootAhead - v.support };
};
// plan width and underside of the blade along its length (fraction from the root face), from the blade as it is drawn
// (blade.js): the root adapter frame at the root face, then the sections turned as carried
const interp = (A, n, t) => { const f = Math.max(0, Math.min(1, t)) * (n - 1), i = Math.min(n - 2, Math.floor(f)), u = f - i; return A[i] * (1 - u) + A[i + 1] * u; };
export function bladeWidthAt(v, t) { const P = bladeProfile(v); return interp(P.W, P.n, t); }
export function bladeUndersideAt(v, t) { const P = bladeProfile(v); return interp(P.U, P.n, t); }

// ---------------------------------------------------------------- kinematics on a 1 m path
function tractrix(P, L) {
  const n = P.length / 2, Q = new Float64Array(P.length);
  const k = Math.min(n - 1, Math.ceil(L));
  let tx = P[2 * k] - P[0], ty = P[2 * k + 1] - P[1]; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
  Q[0] = P[0] - tx * L; Q[1] = P[1] - ty * L;
  for (let i = 1; i < n; i++) { const vx = Q[2 * i - 2] - P[2 * i], vy = Q[2 * i - 1] - P[2 * i + 1], l = Math.hypot(vx, vy) || 1; Q[2 * i] = P[2 * i] + vx / l * L; Q[2 * i + 1] = P[2 * i + 1] + vy / l * L; }
  return Q;
}
// signed lateral position (left +) of point (x, y) against the path near index hint; returns [lat, index]
function lateral(P, N, x, y, hint) {
  const n = P.length / 2; let best = hint, bd = Infinity;
  for (let i = Math.max(0, hint - 16); i < Math.min(n, hint + 16); i++) { const d = (P[2 * i] - x) ** 2 + (P[2 * i + 1] - y) ** 2; if (d < bd) { bd = d; best = i; } }
  return [(x - P[2 * best]) * N[2 * best] + (y - P[2 * best + 1]) * N[2 * best + 1], best];
}

/** Swept path along a 1 m path P (x,y interleaved), normals N, edges HL/HR (usable width left / right of the path).
 *  The dolly's lateral offset is chosen along the stretch by dynamic programming (as route_swept.simulate):
 *  wheels kept `wheelClear` inside where possible, inside the convoy's own lane (HO: its left boundary from the path,
 *  optional) where the road allows, then the least blade overswing, smooth steering.
 *  Returns per position i (front axle at i): pose, wheel clearance (m, < 0 = off), blade beyond the edge left/right,
 *  envelope (lateral extents of wheels and blade), and the conflicts list is left to the caller. */
export function sweep(v, P, N, HL, HR, i0 = 0, HO = null) {
  const n = P.length / 2, d = derived(v);
  const rear = tractrix(P, v.wheelbase);
  const kp = new Float64Array(P.length);
  for (let i = 0; i < n; i++) { let tx = P[2 * i] - rear[2 * i], ty = P[2 * i + 1] - rear[2 * i + 1]; const l = Math.hypot(tx, ty) || 1; kp[2 * i] = rear[2 * i] + tx / l * v.kingpinAhead; kp[2 * i + 1] = rear[2 * i + 1] + ty / l * v.kingpinAhead; }
  const p1 = tractrix(kp, v.frontUnit);
  const step = 0.25, K = Math.round(2 * v.dollyMaxOffset / step) + 1, offs = Array.from({ length: K }, (_, k) => -v.dollyMaxOffset + k * step);
  const M = n - i0;
  const C = new Float64Array(M * K), WL = new Float64Array(M * K), BLm = new Float64Array(M * K), BRm = new Float64Array(M * K), EN = new Float32Array(M * K * 4);
  const geo = new Array(M);
  const BT = 15, tSup = v.support / v.bladeLength, WB = Array.from({ length: BT }, (_, k) => bladeWidthAt(v, k / (BT - 1)) / 2);
  let j = 0;
  for (let ii = 0; ii < M; ii++) {
    const i = i0 + ii;
    while (j < i && Math.hypot(P[2 * j + 2] - p1[2 * i], P[2 * j + 3] - p1[2 * i + 1]) > v.support) j++;
    if (Math.hypot(P[2 * j] - p1[2 * i], P[2 * j + 1] - p1[2 * i + 1]) < v.support * 0.6) { geo[ii] = null; continue; }
    // tractor and front unit footprints (corners)
    let ux = P[2 * i] - rear[2 * i], uy = P[2 * i + 1] - rear[2 * i + 1]; let ul = Math.hypot(ux, uy) || 1; ux /= ul; uy /= ul;
    const pts = [];
    const rect = (cx, cy, ax, ay, len, w, back) => { const nx = -ay, ny = ax, fx = cx + ax * len * (1 - back), fy = cy + ay * len * (1 - back), bx = cx - ax * len * back, by = cy - ay * len * back;
      return [fx + nx * w / 2, fy + ny * w / 2, fx - nx * w / 2, fy - ny * w / 2, bx - nx * w / 2, by - ny * w / 2, bx + nx * w / 2, by + ny * w / 2]; };
    const tr = rect(P[2 * i] + ux * v.frontOverhang, P[2 * i + 1] + uy * v.frontOverhang, ux, uy, v.tractorLength, v.tractorWidth, 1);
    let fx = kp[2 * i] - p1[2 * i], fy = kp[2 * i + 1] - p1[2 * i + 1]; const fl = Math.hypot(fx, fy) || 1; fx /= fl; fy /= fl;
    const fu = rect(p1[2 * i] + fx * v.frontUnit * 0.25, p1[2 * i + 1] + fy * v.frontUnit * 0.25, fx, fy, v.frontUnit * 0.75, v.frontWidth, 0.5);
    let tjx = P[2 * Math.min(n - 1, j + 1)] - P[2 * Math.max(0, j - 1)], tjy = P[2 * Math.min(n - 1, j + 1) + 1] - P[2 * Math.max(0, j - 1) + 1]; const tl = Math.hypot(tjx, tjy) || 1; tjx /= tl; tjy /= tl;
    let worstFix = Infinity, fixL = -Infinity, fixR = Infinity, fixO = -Infinity;
    for (let q = 0; q < 16; q += 2) { const [la, k] = lateral(P, N, (q < 8 ? tr : fu)[q % 8], (q < 8 ? tr : fu)[q % 8 + 1], i); worstFix = Math.min(worstFix, Math.min(HL[k] - la, HR[k] + la)); fixL = Math.max(fixL, la); fixR = Math.min(fixR, la); if (HO) fixO = Math.max(fixO, la - HO[k]); }
    geo[ii] = { j, tjx, tjy };
    for (let k = 0; k < K; k++) {
      const qx = P[2 * j] + N[2 * j] * offs[k], qy = P[2 * j + 1] + N[2 * j + 1] * offs[k];
      let bx = qx - p1[2 * i], by = qy - p1[2 * i + 1]; const bl = Math.hypot(bx, by) || 1; bx /= bl; by /= bl;
      const Qx = p1[2 * i] + bx * v.support, Qy = p1[2 * i + 1] + by * v.support;
      const dl = rect(Qx, Qy, tjx, tjy, v.dollyLength, v.dollyWidth, 0.5);
      let wc = worstFix, eL = fixL, eR = fixR, own = fixO;      // own: how far the wheels reach beyond the own lane
      for (let q = 0; q < 8; q += 2) { const [la, kk] = lateral(P, N, dl[q], dl[q + 1], j); wc = Math.min(wc, Math.min(HL[kk] - la, HR[kk] + la)); eL = Math.max(eL, la); eR = Math.min(eR, la); if (HO) own = Math.max(own, la - HO[kk]); }
      // blade outline: both sides at 15 stations
      const rx = p1[2 * i] - bx * v.rootAhead, ry = p1[2 * i + 1] - by * v.rootAhead, nx = -by, ny = bx;
      let bL = 0, bR = 0, gL = -Infinity, gR = Infinity, hint = Math.max(0, i - Math.round(d.p1Back));
      for (let s = 0; s < BT; s++) {
        const t = s / (BT - 1), w = WB[s], cx = rx + bx * t * v.bladeLength, cy = ry + by * t * v.bladeLength;
        for (const sg of [1, -1]) { const [la, kk] = lateral(P, N, cx + nx * w * sg, cy + ny * w * sg, hint); hint = kk; bL = Math.max(bL, la - HL[kk]); bR = Math.max(bR, -la - HR[kk]); gL = Math.max(gL, la); gR = Math.min(gR, la); }
      }
      const o = ii * K + k;
      WL[o] = wc; BLm[o] = bL; BRm[o] = bR;
      EN[4 * o] = eL; EN[4 * o + 1] = eR; EN[4 * o + 2] = gL; EN[4 * o + 3] = gR;
      C[o] = 40 * Math.max(0, -wc) + 8 * Math.max(0, v.wheelClear - wc) + 0.6 * Math.max(bL, bR) + 0.02 * Math.abs(offs[k]) + (HO ? 2 * Math.max(0, own) : 0);
    }
  }
  // dynamic programming: offset changes by at most one step per metre
  const D = new Float64Array(M * K), A = new Int8Array(M * K);
  for (let k = 0; k < K; k++) D[k] = geo[0] ? C[k] : 0.02 * Math.abs(offs[k]);
  for (let ii = 1; ii < M; ii++) for (let k = 0; k < K; k++) {
    let bd = Infinity, ba = 0;
    for (let a = -1; a <= 1; a++) { const kk = k + a; if (kk < 0 || kk >= K) continue; const dv = D[(ii - 1) * K + kk]; if (dv < bd) { bd = dv; ba = a; } }
    D[ii * K + k] = (geo[ii] ? C[ii * K + k] : 0.02 * Math.abs(offs[k])) + bd; A[ii * K + k] = ba;
  }
  const path = new Int16Array(M); let bk = 0, bv = Infinity; for (let k = 0; k < K; k++) if (D[(M - 1) * K + k] < bv) { bv = D[(M - 1) * K + k]; bk = k; }
  path[M - 1] = bk; for (let ii = M - 1; ii > 0; ii--) path[ii - 1] = path[ii] + A[ii * K + path[ii]];
  const out = { off: new Float32Array(M), wc: new Float32Array(M), bL: new Float32Array(M), bR: new Float32Array(M), env: new Float32Array(M * 4), valid: new Uint8Array(M),
    pose: new Float32Array(M * 14) };
  for (let ii = 0; ii < M; ii++) { const k = path[ii], o = ii * K + k; out.off[ii] = offs[k]; if (!geo[ii]) continue; out.valid[ii] = 1;
    { // pose row as convoy.set expects: front axle, rear axle, front support, root, tip, dolly centre, dolly front
      const i = i0 + ii, g = geo[ii], jj = g.j, qx = P[2 * jj] + N[2 * jj] * offs[k], qy = P[2 * jj + 1] + N[2 * jj + 1] * offs[k];
      let bx = qx - p1[2 * i], by = qy - p1[2 * i + 1]; const bl = Math.hypot(bx, by) || 1; bx /= bl; by /= bl;
      const Qx = p1[2 * i] + bx * v.support, Qy = p1[2 * i + 1] + by * v.support, rx = p1[2 * i] - bx * v.rootAhead, ry = p1[2 * i + 1] - by * v.rootAhead;
      out.pose.set([P[2 * i], P[2 * i + 1], rear[2 * i], rear[2 * i + 1], p1[2 * i], p1[2 * i + 1], rx, ry, rx + bx * v.bladeLength, ry + by * v.bladeLength,
        Qx, Qy, Qx + g.tjx * v.dollyLength / 2, Qy + g.tjy * v.dollyLength / 2], ii * 14); }
    out.wc[ii] = WL[o]; out.bL[ii] = BLm[o]; out.bR[ii] = BRm[o]; for (let c = 0; c < 4; c++) out.env[4 * ii + c] = EN[4 * o + c]; }
  out.rear = rear; out.p1 = p1; out.i0 = i0;
  return out;
}

// a point object (signal, sign, pole) against the swept path: the lowest blade underside that passes over it (where the
// blade's outline, widened by `margin`, covers it), the closest the blade's edge comes beside it, and whether it stands in
// the wheels' band. x, y in the frame of the path given to sweep().
export function overPoint(v, res, P, N, x, y, margin = 0.3) {
  const n = res.valid.length, tSup = v.support / v.bladeLength;
  let under = Infinity, tAt = -1, gap = Infinity, k = -1, bd = Infinity;
  for (let i = 0; i < n; i++) {
    const d2 = (P[2 * i] - x) ** 2 + (P[2 * i + 1] - y) ** 2; if (d2 < bd) { bd = d2; k = i; }
    if (!res.valid[i]) continue;
    const o = 14 * i, rx = res.pose[o + 6], ry = res.pose[o + 7];
    let bx = res.pose[o + 8] - rx, by = res.pose[o + 9] - ry; const L = Math.hypot(bx, by) || 1; bx /= L; by /= L;
    const px = x - rx, py = y - ry, t = (px * bx + py * by) / L;
    if (t < -0.02 || t > 1.02) continue;
    const tc = Math.max(0, Math.min(1, t)), lat = Math.abs(-px * by + py * bx), w = bladeWidthAt(v, tc) / 2;
    gap = Math.min(gap, lat - w);
    if (lat <= w + margin) { const u = bladeUndersideAt(v, tc, tSup); if (u < under) { under = u; tAt = tc; } }
  }
  let wheels = false;
  if (k >= 0 && res.valid[k]) { const lat = (x - P[2 * k]) * N[2 * k] + (y - P[2 * k + 1]) * N[2 * k + 1]; wheels = lat <= res.env[4 * k] + 0.25 && lat >= res.env[4 * k + 1] - 0.25; }
  return { under, t: tAt, gap, wheels };
}
