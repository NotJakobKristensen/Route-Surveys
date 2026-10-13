// The V172 blade as carried: planform, sections and how it sits on the convoy (roll about its axis, root height, the
// clamp section, the prebend). Shared by the 3D model (convoy.js) and the swept-path model (vehicle.js), so the plan
// width and the underside the analysis uses are those of the blade that is drawn.
// planform of the V172 blade (84.35 m, root Ø 3.2 m, widest chord 4.3 m at 23 % span; NREL 5 MW proportions scaled):
// [span fraction, chord (m), relative thickness, twist (°)]
const PLAN = [[0, 3.2, 1, 13.3], [0.03, 3.2, 1, 13.3], [0.07, 3.5, 0.9, 13.3], [0.11, 3.85, 0.66, 13.3], [0.17, 4.21, 0.42, 13.3],
  [0.23, 4.3, 0.35, 11.5], [0.3, 4.12, 0.33, 10.2], [0.37, 3.93, 0.3, 9.0], [0.43, 3.7, 0.26, 7.8], [0.5, 3.47, 0.24, 6.5],
  [0.57, 3.24, 0.21, 5.4], [0.63, 3.01, 0.21, 4.2], [0.7, 2.78, 0.19, 3.1], [0.77, 2.55, 0.18, 2.3], [0.83, 2.33, 0.18, 1.5],
  [0.89, 2.14, 0.18, 0.9], [0.93, 1.93, 0.18, 0.4], [0.97, 1.5, 0.18, 0.15], [0.99, 1.0, 0.19, 0.05], [1, 0.6, 0.22, 0]];
const S_MAX = 0.23;
export const NP = 28;
function plan(s) {
  for (let i = 1; i < PLAN.length; i++) if (s <= PLAN[i][0]) { const a = PLAN[i - 1], b = PLAN[i], f = (s - a[0]) / (b[0] - a[0]); return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f]; }
  return PLAN[PLAN.length - 1].slice(1);
}
const sstep = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
function airfoil(n, t, flat) {
  // NACA-type thickness with a little camber; `flat` opens the trailing edge (flatback, fraction of the thickness)
  const up = [], lo = [];
  for (let i = 0; i <= n; i++) {
    const b = (i / n) * Math.PI, x = (1 - Math.cos(b)) / 2;
    const yt = 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4) + flat * t * 0.5 * x * x;
    const yc = 0.035 * (1 - (2 * x - 0.8) ** 2) * Math.max(0, 1 - t * 1.8);
    up.push([x, yc + yt]); lo.push([x, yc - yt]);
  }
  return up.concat(lo.reverse().slice(1, -1));
}
// the section at span fraction s in the transport frame: [up, side] pairs (before the prebend), turned by B.roll
export function section(B, s) {
  const [cRef, t, tw] = plan(s);
  const k = s < S_MAX ? B.kRoot + (B.kChord - B.kRoot) * sstep(s / S_MAX) : B.kChord, c = cRef * k;
  const circ = s <= 0.03 ? 1 : 1 - sstep((s - 0.03) / 0.09);
  const flat = s < 0.06 ? 0 : s < 0.2 ? 0.34 * sstep((s - 0.06) / 0.05) : s < 0.42 ? 0.34 * (0.42 - s) / 0.22 : 0;
  const prof = airfoil(NP, Math.min(0.97, t), flat), m = prof.length, R = c / 2;
  const th = B.roll + tw * Math.PI / 180, ca = Math.cos(th), sa = Math.sin(th);
  const pts = prof.map(([x, y], i) => {
    const a = (i / m) * Math.PI * 2;
    const px = ((x - 0.35) * c) * (1 - circ) + (-Math.cos(a) * R) * circ, py = (y * c) * (1 - circ) + (Math.sin(a) * R) * circ;
    return [px * ca - py * sa, px * sa + py * ca];
  });
  // centred sideways on the axis, so the plan view is symmetric about it (as the swept-path model takes it)
  let s0 = Infinity, s1 = -Infinity; for (const p of pts) { s0 = Math.min(s0, p[1]); s1 = Math.max(s1, p[1]); }
  const mid = (s0 + s1) / 2; for (const p of pts) p[1] -= mid;
  return pts;
}
export const ext = (sec) => { let u0 = Infinity, u1 = -Infinity, s0 = Infinity, s1 = -Infinity; for (const [u, s] of sec) { u0 = Math.min(u0, u); u1 = Math.max(u1, u); s0 = Math.min(s0, s); s1 = Math.max(s1, s); } return { u0, u1, s0, s1, w: s1 - s0 }; };
// how the blade sits: turned about its axis only as far as the transport height requires — trailing edge up, the chord
// as upright as the height allows (an upright chord keeps the blade narrow, a turned one keeps it low) —, the root
// centre on the adapter (root bottom at least 0.72 m above the road, the root frame's top within the height), the
// clamp section's leading edge at the user's underside, and the prebend so the tip's underside is the user's value
export function bladeFrame(v) {
  const Lb = v.bladeLength, B = { Lb, kChord: Math.max(0.5, Math.min(1.6, v.maxChord / 4.3)), kRoot: Math.max(0.6, Math.min(1.5, (v.rootDiameter - 1.0) / 3.2)), roll: 0 };
  B.R0 = 1.6 * B.kRoot;
  B.frameUp = B.R0 + 0.5;                                   // the root frame's top above the root centre
  B.rSup = v.rootAhead + v.support;
  const sSup = Math.min(0.98, B.rSup / Lb);
  const fit = (roll) => {
    B.roll = roll;
    const se = ext(section(B, sSup));
    B.supDown = -se.u0; B.supC = v.undersideSupport + B.supDown;
    const tops = []; for (let s = 0; s <= Math.min(0.95, sSup); s += 0.01) tops.push([s * Lb, ext(section(B, s)).u1]);
    const topAt = (Hc) => { let w = Hc + B.frameUp, wr = 0; for (const [r, u] of tops) { const z = Hc + (B.supC - Hc) * (r / B.rSup) + u; if (z > w) { w = z; wr = r; } } return [w, wr]; };
    let Hc = Math.max(B.R0 + 0.72, v.height - B.frameUp);
    for (let it = 0; it < 30; it++) { const [w, wr] = topAt(Hc); Hc -= (w - v.height) / Math.max(0.3, 1 - wr / B.rSup); Hc = Math.max(B.R0 + 0.72, Math.min(v.height - 0.4, Hc)); }
    B.Hc = Hc; B.top = topAt(Hc)[0];
    return B.top;
  };
  const up = -11.5 * Math.PI / 180;                          // chord upright at the widest chord
  let roll = up;
  if (fit(up) > v.height + 0.01) {
    let lo = up, hi = 1.45;
    if (fit(hi) > v.height + 0.01) lo = hi;
    for (let k = 0; k < 26 && hi - lo > 1e-4; k++) { const m = (lo + hi) / 2; if (fit(m) > v.height + 0.01) lo = m; else hi = m; }
    roll = hi;
  }
  fit(roll);
  B.planWidth = (() => { let w = 0; for (let s = 0.16; s <= 0.4; s += 0.02) w = Math.max(w, ext(section(B, s)).w); return w; })();
  // the prebend: the tip's underside at the user's value
  const axisAt = (r) => B.Hc + (B.supC - B.Hc) * (r / B.rSup);
  let tipU = Infinity; for (let s = 0.975; s <= 1.0001; s += 0.005) tipU = Math.min(tipU, axisAt(Math.min(1, s) * Lb) + ext(section(B, Math.min(1, s))).u0);
  B.bendTip = Math.max(-1, Math.min(6, v.undersideTip - tipU));
  B.bend = (r) => (r <= B.rSup ? 0 : B.bendTip * ((r - B.rSup) / (Lb - B.rSup)) ** 2);
  const supSec = section(B, sSup);
  B.leSide = (() => { let k = 0; supSec.forEach(([u], i) => { if (u < supSec[k][0]) k = i; }); return supSec[k][1]; })();
  return B;
}
// plan width and underside along the blade (61 stations, fraction of the length from the root face) for the vehicle's
// dimensions: the root frame of the adapter (the load's widest point) at the root face, then the blade's sections;
// the underside above a level road with the axis from the root centre to the clamp section and the prebend beyond
const cache = new Map();
export function bladeProfile(v) {
  const key = ['bladeLength', 'rootDiameter', 'maxChord', 'width', 'height', 'undersideSupport', 'undersideTip', 'rootAhead', 'support'].map((k) => v[k]).join('|');
  let P = cache.get(key); if (P) return P;
  const B = bladeFrame(v), n = 61, W = new Float32Array(n), U = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1), r = t * B.Lb, e = ext(section(B, Math.min(1, t)));
    W[i] = e.w; U[i] = B.Hc + (B.supC - B.Hc) * (r / B.rSup) + e.u0 + B.bend(r);
  }
  W[0] = Math.max(W[0], v.width);
  P = { B, W, U, n }; cache.set(key, P); if (cache.size > 6) cache.delete(cache.keys().next().value);
  return P;
}
