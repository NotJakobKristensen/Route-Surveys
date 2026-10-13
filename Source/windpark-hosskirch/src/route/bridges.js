// Bridges in 3D for the road view and the survey points: the deck on its measured height (surface model along the mapped
// centreline), parapets, abutments where the deck meets the ground, piers beside the road below; tunnels and covered
// sections (walls, ceiling, portals). Pure geometry helpers; the views decide where the ground is.
import * as THREE from 'three';
import { patch } from '../env.js';

// structure depth below the deck top by kind (as tools/route_clearance.py)
const DEPTH = { motorway: 1.5, trunk: 1.4, primary: 1.3, secondary: 1.2, tertiary: 1.1, path: 0.8, footway: 0.8, cycleway: 0.8, pedestrian: 0.8, steps: 0.8 };
export const depthOf = (b) => (b.sub === 'rail' ? 1.5 : DEPTH[b.cls] ?? 1.0);

export function bridgeMaterials(keep) {
  const m = (o) => keep(new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, side: THREE.DoubleSide, ...o }));
  // height not measured (no surface model): opaque (a see-through ghost read as a hole in the view and still cast a full
  // shadow), hatched in amber stripes across the world so it reads as assumed
  const unk = patch(new THREE.MeshStandardMaterial({ color: 0xc4bdb0, emissive: 0x5a554c, roughness: 0.85, metalness: 0, side: THREE.DoubleSide }), {
    key: 'bridge-unk', frag: { map: /* glsl */ `#include <map_fragment>
      if (fract((vWP.x + vWP.y - vWP.z) * 0.4) < 0.3) diffuseColor.rgb *= vec3(1.05, 0.78, 0.42);` } });
  return {
    con: m({ color: 0xc4bdb0, emissive: 0x6e675d }),             // concrete: slab, abutments, piers (lifted, warm: reads as concrete, not steel, in shade)
    cap: m({ color: 0xd8d3c8, emissive: 0x7d786d, roughness: 0.8 }), // edge beams, fascia and caps: the lighter, newer concrete
    earth: m({ color: 0x7d8a58, emissive: 0x2c3322, roughness: 1 }), // grassed embankments where the view's ground is flat
    road: m({ color: 0x5b5a58, emissive: 0x0d0c0a, roughness: 0.95 }), // asphalt on top (a touch warm: no navy shade under the sky light)
    ballast: m({ color: 0x7c705f, roughness: 1 }),               // railway: ballast bed
    steel: m({ color: 0x9aa2a8, roughness: 0.4, metalness: 0.6 }), // railings, guardrails (galvanised), catenary
    rail: m({ color: 0x5b5048, roughness: 0.5, metalness: 0.5 }), // running rails, sleepers
    unk: keep(unk),
    paint: m({ color: 0xe8e8e2, emissive: 0x303030, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), // markings on decks
  };
}
export const BRIDGE_KEYS = ['con', 'cap', 'earth', 'road', 'ballast', 'steel', 'rail', 'unk', 'paint'];
export const bridgeAccs = () => Object.fromEntries(BRIDGE_KEYS.map((k) => [k, new Acc()]));
/** the meshes of a set of accumulators (keys as BRIDGE_KEYS), with the materials from bridgeMaterials */
export function bridgeMeshes(K, BK) { const out = []; for (const k of BRIDGE_KEYS) { if (!K[k]) continue; const m = K[k].mesh(BK[k]); if (m) out.push(m); } return out; }

/** collects flat-shaded quads in scene coordinates (x, height, -y) */
export class Acc {
  constructor() { this.p = []; this.n = []; this.i = []; }
  quad(a, b, c, d) {                                            // a, b, c, d: [x, y, z] world (z = height), counter-clockwise from outside
    const A = [a[0], a[2], -a[1]], B = [b[0], b[2], -b[1]], C = [c[0], c[2], -c[1]], D = [d[0], d[2], -d[1]];
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = D[0] - A[0], vy = D[1] - A[1], vz = D[2] - A[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    const o = this.p.length / 3;
    this.p.push(...A, ...B, ...C, ...D); for (let k = 0; k < 4; k++) this.n.push(nx, ny, nz);
    this.i.push(o, o + 1, o + 2, o, o + 2, o + 3);
  }
  mesh(mat) {
    if (!this.i.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3)); g.setIndex(this.i);
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat); m.castShadow = true; m.receiveShadow = true; return m;
  }
}

// unit normals (left of travel) at the points of a polyline, mitred at the joints
function normals(P) {
  const n = P.length, N = [];
  for (let i = 0; i < n; i++) {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1]; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
    N.push([-ty, tx]);
  }
  return N;
}

/** a box swept along polyline P between offsets o0 < o1 across it, from height zb[i] to zt[i] (arrays or numbers) */
export function sweep(acc, P, zt, zb, o0, o1, caps = true) {
  const n = P.length; if (n < 2) return;
  const N = normals(P), T = (a, i) => (typeof a === 'number' ? a : a[i]);
  const v = (i, o, z) => [P[i][0] + N[i][0] * o, P[i][1] + N[i][1] * o, z];
  for (let i = 0; i < n - 1; i++) {
    const j = i + 1;
    const L0t = v(i, o1, T(zt, i)), R0t = v(i, o0, T(zt, i)), L1t = v(j, o1, T(zt, j)), R1t = v(j, o0, T(zt, j));
    const L0b = v(i, o1, T(zb, i)), R0b = v(i, o0, T(zb, i)), L1b = v(j, o1, T(zb, j)), R1b = v(j, o0, T(zb, j));
    acc.quad(R0t, R1t, L1t, L0t);       // top
    acc.quad(L0b, L1b, R1b, R0b);       // bottom
    acc.quad(L0b, L0t, L1t, L1b);       // left side
    acc.quad(R1b, R1t, R0t, R0b);       // right side
  }
  if (caps) {
    const e = (i, s) => { const Lt = v(i, o1, T(zt, i)), Rt = v(i, o0, T(zt, i)), Lb = v(i, o1, T(zb, i)), Rb = v(i, o0, T(zb, i)); if (s > 0) acc.quad(Rb, Rt, Lt, Lb); else acc.quad(Lb, Lt, Rt, Rb); };
    e(0, 1); e(n - 1, -1);
  }
}

/** an upright box: centre (cx, cy), long axis (ux, uy), length len across thickness th, from height z0 to z1 */
export function block(acc, cx, cy, ux, uy, len, th, z0, z1) {
  if (!(z1 - z0 > 0.05)) return;
  const l = Math.hypot(ux, uy) || 1; ux /= l; uy /= l;
  const P = [[cx - ux * len / 2, cy - uy * len / 2], [cx + ux * len / 2, cy + uy * len / 2]];
  sweep(acc, P, z1, z0, -th / 2, th / 2, true);
}

/** the run of indices around i where h[i] stays above hmin (the deck clear of the ground); [-1, -1] if none near */
export function deckRun(h, i, hmin = 1.5) {
  const n = h.length; let c = -1, bd = Infinity;
  for (let k = 0; k < n; k++) if (h[k] > hmin && Math.abs(k - i) < bd) { bd = Math.abs(k - i); c = k; }
  if (c < 0 || bd > 6) return [-1, -1];
  let a = c, b = c;
  const ok = (k) => h[k] > hmin || (k > 0 && k < n - 1 && h[k - 1] > hmin && h[k + 1] > hmin);   // single-sample dips (lamp, car) bridged
  while (a > 0 && ok(a - 1)) a--; while (b < n - 1 && ok(b + 1)) b++;
  return [a, b];
}

/** the deck top along a bridge centreline from the surface model S and terrain T (2 m steps) around index ci: a smooth
 *  line fitted to the samples standing clear of the ground near the crossing, extended outwards while the surface keeps
 *  to it (trees, lamps and vehicles beside or on the deck stand above it and end nothing; the deck ends where the surface
 *  falls back to the ground). Holes in the surface model of up to 3 samples are bridged; samples on the fitted line are
 *  kept even where the terrain model holds the deck as ground (height over it under 1 m); the core's reference is the
 *  lower quartile (catenary masts, lamps and wires stand above the deck, never below it). Returns {i0, i1, zt: absolute
 *  heights for i0..i1, F: the fitted line (index → height), spk: samples standing 2.5 m or more above it (catenary masts
 *  on a railway)} or null. */
export function deckProfile(S, T, ci, hmin = 1.5, rail = false) {
  const n = S.length, h = S.map((v, i) => v - T[i]), ok = (i) => Number.isFinite(h[i]) && h[i] > hmin;
  let c = -1, bd = 1e9; for (let i = 0; i < n; i++) if (ok(i) && Math.abs(i - ci) < bd) { bd = Math.abs(i - ci); c = i; }
  if (c < 0 || bd > 6) return null;
  // core: up to ±4 samples around c that stand clear of the ground
  let core = []; for (let i = Math.max(0, c - 4); i <= Math.min(n - 1, c + 4); i++) if (ok(i)) core.push(i);
  if (core.length < 2) core = [c];
  const fit = (I, deg) => {                                          // least squares in t = index - c, degree 0..2
    const m = Math.min(deg, I.length - 1) + 1, A = [], y = [];
    for (const i of I) { const t = (i - c) / 10; A.push([1, t, t * t].slice(0, m)); y.push(S[i]); }
    const N = Array.from({ length: m }, () => new Array(m).fill(0)), r = new Array(m).fill(0);
    A.forEach((row, k) => { for (let a = 0; a < m; a++) { r[a] += row[a] * y[k]; for (let b = 0; b < m; b++) N[a][b] += row[a] * row[b]; } });
    for (let a = 0; a < m; a++) { let p = a; for (let q = a + 1; q < m; q++) if (Math.abs(N[q][a]) > Math.abs(N[p][a])) p = q; [N[a], N[p]] = [N[p], N[a]]; [r[a], r[p]] = [r[p], r[a]];
      if (Math.abs(N[a][a]) < 1e-9) return (i) => S[c]; for (let q = 0; q < m; q++) if (q !== a) { const f = N[q][a] / N[a][a]; for (let b = a; b < m; b++) N[q][b] -= f * N[a][b]; r[q] -= f * r[a]; } }
    const co = r.map((v, a) => v / N[a][a]); return (i) => { const t = (i - c) / 10; return co[0] + (co[1] || 0) * t + (co[2] || 0) * t * t; };
  };
  // the lower quartile of the core as the reference: samples far above it (a lamp, a catenary mast) left out, then a line
  const q1 = core.map((i) => S[i]).sort((a, b) => a - b)[Math.floor((core.length - 1) / 4)];
  core = core.filter((i) => S[i] - q1 < 1.2 && S[i] - q1 > -0.8); if (!core.length) core = [c];
  let F = fit(core, 1), lo = Math.min(...core), hi = Math.max(...core);
  const keep = (i) => Number.isFinite(S[i]) && Math.abs(S[i] - F(i)) < (Number.isFinite(h[i]) && h[i] > 1.0 ? 1.2 : 0.5);
  // the next kept sample beyond k within 4 steps (holes of up to 3 samples bridged), or -1
  const next = (k, dir) => { for (let j = 1; j <= 4; j++) { const i = k + dir * j; if (i < 0 || i >= n) return -1; if (keep(i)) return i; } return -1; };
  for (let pass = 0; pass < 2; pass++) {
    for (let j; (j = next(lo, -1)) >= 0;) lo = j;
    for (let j; (j = next(hi, 1)) >= 0;) hi = j;
    const I = []; for (let i = lo; i <= hi; i++) if (keep(i)) I.push(i);
    if (I.length >= 3) { F = fit(I, hi - lo > 14 ? 2 : 1); if (hi - lo > 14) { const q = (F(c + 10) + F(c - 10) - 2 * F(c)) / 2; if (Math.abs(q) > 0.25) F = fit(I, 1); } }
  }
  if (hi - lo < 2) return null;                                      // a single spike (a mast, a lamp), not a deck
  const zt = []; let spk = 0;
  for (let i = lo; i <= hi; i++) { zt.push(F(i)); if (Number.isFinite(S[i]) && S[i] - F(i) > (rail ? 2.5 : 4)) spk++; }
  return { i0: lo, i1: hi, zt, F, spk };
}

/** running median of a[i0..i1] (window 2w+1), NaN-tolerant */
export function smooth(a, i0, i1, w = 2) {
  const out = a.slice();
  for (let i = i0; i <= i1; i++) {
    const v = []; for (let k = Math.max(i0, i - w); k <= Math.min(i1, i + w); k++) if (Number.isFinite(a[k])) v.push(a[k]);
    if (v.length) { v.sort((x, y) => x - y); out[i] = v[v.length >> 1]; }
  }
  return out;
}

// points every `step` m along polyline P (with the direction there)
function every(P, step, from = step / 2) {
  const out = []; let acc = 0, next = from;
  for (let i = 0; i < P.length - 1; i++) {
    const ax = P[i][0], ay = P[i][1], bx = P[i + 1][0], by = P[i + 1][1], l = Math.hypot(bx - ax, by - ay); if (l < 1e-6) continue;
    while (next <= acc + l) { const t = (next - acc) / l; out.push({ i, t, x: ax + (bx - ax) * t, y: ay + (by - ay) * t, ux: (bx - ax) / l, uy: (by - ay) / l }); next += step; }
    acc += l;
  }
  return out;
}
const lerpA = (a, p) => (typeof a === 'number' ? a : a[p.i] + (a[Math.min(a.length - 1, p.i + 1)] - a[p.i]) * p.t);
/** a round column (polygon prism) */
export function column(acc, cx, cy, r, z0, z1, seg = 10) {
  if (!(z1 - z0 > 0.05)) return;
  for (let k = 0; k < seg; k++) {
    const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2;
    const p0 = [cx + Math.cos(a0) * r, cy + Math.sin(a0) * r], p1 = [cx + Math.cos(a1) * r, cy + Math.sin(a1) * r];
    acc.quad([p0[0], p0[1], z0], [p1[0], p1[1], z0], [p1[0], p1[1], z1], [p0[0], p0[1], z1]);
  }
}
/** a pier across the road below: a cap beam under the deck on round columns (or one wall for a narrow deck) */
export function pier(acc, cx, cy, ux, uy, len, g, zb, d = 1.0) {
  if (!(zb - g > 1.6)) return;
  const l = Math.hypot(ux, uy) || 1; ux /= l; uy /= l;
  const capD = Math.min(1.1, (zb - g) * 0.25);
  block(acc, cx, cy, ux, uy, len, 1.5, zb - capD, zb);
  const n = len < 5 ? 1 : Math.max(2, Math.round(len / 6.5));
  for (let k = 0; k < n; k++) { const o = n > 1 ? -len / 2 + 1.0 + ((len - 2.0) * k) / (n - 1) : 0; column(acc, cx + ux * o, cy + uy * o, d / 2, g - 0.3, zb - capD + 0.05); }
}
/** a railing along P at lateral offset o: posts every 2 m, a handrail and a knee rail; zb: base heights */
export function railing(acc, P, o, zb, h = 1.1) {
  const N = normals(P), at = (p) => { const n = N[p.i]; return [p.x + n[0] * o, p.y + n[1] * o]; };
  for (const p of every(P, 2.0)) { const [x, y] = at(p); block(acc, x, y, p.ux, p.uy, 0.07, 0.07, lerpA(zb, p), lerpA(zb, p) + h); }
  const z = (dz) => (typeof zb === 'number' ? zb + dz : zb.map((v) => v + dz));
  sweep(acc, P, z(h + 0.04), z(h - 0.04), o - 0.045, o + 0.045, false);
  sweep(acc, P, z(h * 0.5 + 0.025), z(h * 0.5 - 0.025), o - 0.025, o + 0.025, false);
}
/** a steel guardrail (W-beam on posts) along P at offset o, facing the carriageway */
export function guardrail(acc, P, o, zb) {
  const N = normals(P);
  for (const p of every(P, 2.0)) { const n = N[p.i]; block(acc, p.x + n[0] * o, p.y + n[1] * o, p.ux, p.uy, 0.1, 0.1, lerpA(zb, p), lerpA(zb, p) + 0.72); }
  const z = (dz) => (typeof zb === 'number' ? zb + dz : zb.map((v) => v + dz));
  sweep(acc, P, z(0.75), z(0.42), o - 0.03, o + 0.03, false);
}

/** a painted line along P at offset o, width w, on the heights z[] (+ lift); dashed when dash > 0 (dash, gap in m) */
function stripe(acc, P, o, w, z, dash = 0, gap = 0, lift = 0.035) {
  const N = normals(P), seg = [];
  let acc0 = 0; const cs = [0]; for (let i = 0; i < P.length - 1; i++) { acc0 += Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]); cs.push(acc0); }
  const at = (u) => { let i = 0; while (i < cs.length - 2 && cs[i + 1] < u) i++; const t = Math.max(0, Math.min(1, (u - cs[i]) / ((cs[i + 1] - cs[i]) || 1))), j = Math.min(P.length - 1, i + 1);
    const nx = N[i][0] + (N[j][0] - N[i][0]) * t, ny = N[i][1] + (N[j][1] - N[i][1]) * t, zz = (typeof z === 'number' ? z : z[i] + (z[j] - z[i]) * t) + lift;
    return [P[i][0] + (P[j][0] - P[i][0]) * t, P[i][1] + (P[j][1] - P[i][1]) * t, nx, ny, zz]; };
  if (dash > 0) { for (let u = gap / 2; u < acc0; u += dash + gap) seg.push([u, Math.min(acc0, u + dash)]); } else seg.push([0, acc0]);
  for (const [u0, u1] of seg) {
    const step = Math.max(1, Math.ceil((u1 - u0) / 4));
    for (let k = 0; k < step; k++) {
      const a = at(u0 + ((u1 - u0) * k) / step), b = at(u0 + ((u1 - u0) * (k + 1)) / step);
      const p = (q, oo) => [q[0] + q[2] * oo, q[1] + q[3] * oo, q[4]];
      acc.quad(p(a, o - w / 2), p(b, o - w / 2), p(b, o + w / 2), p(a, o + w / 2));
    }
  }
}
const ROADWAY = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link', 'living_street', 'service'];

/** deck, surface, caps, fascia, railings and abutments of one bridge part along P[i0..i1] with top heights zt[] (world),
 *  depth dep, half width hw; ground(i) gives the ground height under point i for the abutments; cls: the carried way's
 *  class (guardrails on motorway / trunk / primary decks, markings on roads, slender footbridges); ramps(x, y): the view's
 *  flat ground, for embankments up to the deck; noAbut(i): no abutment at end i (over a carriageway).
 *  opt: {rise(i): the measured ground beyond end i comes up to the deck (else no embankment there: the deck carries on
 *  beyond what was measured), corr(x, y): a point in the route's corridor (no embankment reaching into it), cat: overhead
 *  contact line (an electrified railway)} */
export function deck(...a) { const it = deckSteps(...a); while (!it.next().done); }
// the same in steps (a generator: it yields between the parts, a slicer may pause it there; same geometry in the same order)
export function* deckSteps(K, P, zt, dep, hw, rail, ground, unknown = false, ramps = null, noAbut = null, cls = null, opt = {}) {
  if (P.length < 2) return;
  const C = unknown ? K.unk : K.con, CAP = unknown ? K.unk : K.cap || K.con;
  const foot = !rail && (['path', 'footway', 'cycleway', 'pedestrian', 'steps', 'bridleway', 'track'].includes(cls) || hw < 2.4);
  const capW = rail ? 0.9 : foot ? 0.3 : Math.min(1.8, Math.max(0.75, hw * 0.24));
  const slab = Math.min(0.55, Math.max(0.3, dep * 0.4)), inner = hw > 3.4 ? hw - 1.7 : hw;
  const zb = zt.map((z) => z - dep), add = (dz) => zt.map((z) => z + dz);
  // tracks: as many as the width carries (4.5 m apart: merged decks of a multi-track line)
  const nt = rail ? Math.max(1, Math.min(6, Math.floor((2 * (hw - capW) + 0.3) / 4.5))) : 0, tc = (t) => (t - (nt - 1) / 2) * 4.5;
  sweep(C, P, add(-slab), zb, -inner, inner);                          // main body (girders / box)
  sweep(C, P, add(-0.06), add(-slab), -hw, hw);                        // deck slab and cantilevers
  sweep(rail ? K.ballast : K.road, P, add(rail ? 0.3 : 0.02), add(-0.06), -hw + capW, hw - capW, false);
  yield;
  for (const s of [-1, 1]) {
    sweep(CAP, P, add(0.22), add(-0.06), s > 0 ? hw - capW : -hw, s > 0 ? hw : -hw + capW);          // cap / edge beam
    sweep(CAP, P, add(0.3), add(-slab - 0.32), s > 0 ? hw : -hw - 0.07, s > 0 ? hw + 0.07 : -hw);      // fascia (cornice)
    yield; railing(K.steel, P, s * (hw - 0.14), add(0.22), rail ? 1.3 : foot ? 1.2 : 1.1); yield;
    if (!rail && !foot && ['motorway', 'trunk', 'primary', 'motorway_link', 'trunk_link', 'primary_link'].includes(cls)) guardrail(K.steel, P, s * (hw - capW - 0.05), add(0.02));
  }
  yield;
  const R = K.rail || K.steel;
  if (rail) for (let t = 0; t < nt; t++) for (const r of [-0.75, 0.75]) sweep(R, P, add(0.47), add(0.3), tc(t) + r - 0.04, tc(t) + r + 0.04, false);
  // markings: edge lines and lane lines (motorways and trunk roads 6 m dashes / 12 m gaps), else a centre line; per
  // carriageway where side-by-side parts were merged into one deck (opt.bands: their spans across it), with a guardrail
  // between two carriageways
  yield;
  if (!rail && !foot && K.paint && ROADWAY.includes(cls)) {
    const z = add(0.02), bands = opt.bands && opt.bands.length > 1 ? opt.bands : [[-hw, hw]], mw = /^(motorway|trunk)/.test(cls);
    bands.forEach(([a, b], j) => {
      const m0 = a <= -hw + 0.01 ? capW : 0.9, m1 = b >= hw - 0.01 ? capW : 0.9, lo = a + m0, hi = b - m1, cw = hi - lo, c = (lo + hi) / 2;
      if (cw < 5) return;
      const e = cw / 2 - (cw >= 7 ? 0.5 : 0.3);
      if (cw >= 6) for (const s of [-1, 1]) stripe(K.paint, P, c + s * e, cw >= 9 ? 0.25 : 0.15, z);
      if (mw || bands.length > 1) { const nl = Math.max(1, Math.round((2 * e) / 3.75)); for (let k = 1; k < nl; k++) stripe(K.paint, P, c - e + (2 * e * k) / nl, 0.15, z, 6, 12); }
      else stripe(K.paint, P, c, 0.12, z, 3, 6);
      if (j > 0 && a - bands[j - 1][1] > -2) guardrail(K.steel, P, (a + bands[j - 1][1]) / 2, add(0.02));
    });
  }
  // overhead contact line: a mast with a cantilever over the tracks at each end (and every ~60 m), contact and messenger
  // wires along each track
  yield;
  if (rail && opt.cat) {
    let Ltot = 0; for (let i = 0; i < P.length - 1; i++) Ltot += Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]);
    const N = normals(P), at = every(P, Math.max(8, Ltot / Math.max(1, Math.round(Ltot / 60))), 1.0);
    if (Ltot < 70) { const e = every(P, Math.max(1, Ltot - 2.0), 1.0); at.length = 0; at.push(...e); }
    const ztop = (p) => lerpA(zt, p) + 0.47;
    for (const p of at) {
      const n = N[p.i], z0 = lerpA(zt, p) + 0.22, side = 1, mo = side * (hw - 0.45), x = p.x + n[0] * mo, y = p.y + n[1] * mo;
      block(K.steel, x, y, p.ux, p.uy, 0.32, 0.32, z0, ztop(p) + 7.6);
      const far = tc(0) - 0.8, w = Math.abs(mo - far), cx = p.x + n[0] * (mo + far) / 2, cy = p.y + n[1] * (mo + far) / 2;
      block(K.steel, cx, cy, n[0], n[1], w, 0.12, ztop(p) + 6.95, ztop(p) + 7.1);              // cantilever (top tube)
      block(K.steel, cx, cy, n[0], n[1], w, 0.08, ztop(p) + 5.6, ztop(p) + 5.7);                // registration arm
    }
    for (let t = 0; t < nt; t++) {
      sweep(K.steel, P, add(0.47 + 5.53), add(0.47 + 5.49), tc(t) - 0.02, tc(t) + 0.02, false);  // contact wire 5.5 m over the rails
      sweep(K.steel, P, add(0.47 + 6.82), add(0.47 + 6.79), tc(t) - 0.015, tc(t) + 0.015, false); // messenger
    }
  }
  // abutments: a front wall where the deck meets the embankment, wing walls back along it
  const n = P.length;
  for (const [i, j] of [[0, 1], [n - 1, n - 2]]) {
    yield;
    if (noAbut && noAbut(i)) continue;                               // (an end over a carriageway: no wall in the lane)
    const ux = P[j][0] - P[i][0], uy = P[j][1] - P[i][1], l = Math.hypot(ux, uy) || 1, ex = -ux / l, ey = -uy / l;
    const g = ground(i), H = zt[i] - g, Lw = Math.min(9, Math.max(2.5, H * 1.3));
    if (Number.isFinite(g) && zb[i] - g > 0.4) {
      block(C, P[i][0] + ex * 0.5, P[i][1] + ey * 0.5, -uy / l, ux / l, hw * 2 + 1.0, 1.4, g - 0.5, zb[i]);
      block(K.rail || C, P[i][0] - ex * 0.15, P[i][1] - ey * 0.15, -uy / l, ux / l, hw * 2 - 1.0, 0.5, zb[i] - 0.001, zb[i] + 0.12);     // bearing shelf
      for (const s of [-1, 1]) {
        const o = s * (hw + 0.2), bx = P[i][0] + (-uy / l) * o, by = P[i][1] + (ux / l) * o;
        const W = [[bx, by], [bx + ex * Lw, by + ey * Lw]];
        sweep(C, W, [zt[i] + 0.25, g + Math.max(0.4, H * 0.25)], [g - 0.5, g - 0.5], -0.22, 0.22);
      }
    }
    // embankment: where the view's ground is lower than the measured ground beyond the end, an earth dam carries the road
    // down to it, flush with the deck (same top, road and ballast), held by the wing walls first, then side slopes (flare
    // at most 6 m, toe on the ground each side); at most 30 m; none reaching into the route's corridor
    if (!ramps || unknown || !Number.isFinite(g) || !(H > 1.0) || (opt.rise && !opt.rise(i))) continue;
    const L = Math.min(30, Math.max(12, H * 8)), m = 10, nx = -ey, ny = ex, tw = hw, top = [], Rr = [];
    let bad = false;
    for (let k = 0; k <= m && !bad; k++) {
      const sl = (k / m) * L, x = P[i][0] + ex * sl, y = P[i][1] + ey * sl; Rr.push([x, y]);
      if (opt.corr && k > 0 && (opt.corr(x, y) || opt.corr(x + nx * (tw + 2), y + ny * (tw + 2)) || opt.corr(x - nx * (tw + 2), y - ny * (tw + 2)))) bad = true;
      const gk = ramps(x, y), gl = ramps(x + nx * (tw + 3), y + ny * (tw + 3)), gr = ramps(x - nx * (tw + 3), y - ny * (tw + 3));
      top.push({ z: Math.max(gk, zt[i] + (gk - zt[i]) * Math.pow(k / m, 1.3)), gl: gl - 0.2, gr: gr - 0.2, sl });
    }
    if (bad) continue;
    const N2 = normals(Rr);
    const wOf = (q, gside) => tw + Math.min(6, 1.5 * Math.max(0, q.z - gside)) * Math.max(0, Math.min(1, (q.sl - Lw) / 3));
    for (let k = 0; k < m; k++) {
      const a = Rr[k], b = Rr[k + 1], na = N2[k], nb = N2[k + 1], qa = top[k], qb = top[k + 1], za = qa.z, zb2 = qb.z;
      const P2 = (p, nn, o, z) => [p[0] + nn[0] * o, p[1] + nn[1] * o, z];
      K.earth.quad(P2(a, na, tw, za), P2(b, nb, tw, zb2), P2(b, nb, wOf(qb, qb.gl), qb.gl), P2(a, na, wOf(qa, qa.gl), qa.gl));
      K.earth.quad(P2(a, na, -wOf(qa, qa.gr), qa.gr), P2(b, nb, -wOf(qb, qb.gr), qb.gr), P2(b, nb, -tw, zb2), P2(a, na, -tw, za));
      if (!rail) {
        K.road.quad(P2(a, na, -tw, za + 0.02), P2(b, nb, -tw, zb2 + 0.02), P2(b, nb, tw, zb2 + 0.02), P2(a, na, tw, za + 0.02));
      } else {
        K.ballast.quad(P2(a, na, -tw, za + 0.3), P2(b, nb, -tw, zb2 + 0.3), P2(b, nb, tw, zb2 + 0.3), P2(a, na, tw, za + 0.3));
        K.earth.quad(P2(a, na, -tw, za + 0.3), P2(b, nb, -tw, zb2 + 0.3), P2(b, nb, -tw, zb2 - 0.4), P2(a, na, -tw, za - 0.4));
        K.earth.quad(P2(a, na, tw, za - 0.4), P2(b, nb, tw, zb2 - 0.4), P2(b, nb, tw, zb2 + 0.3), P2(a, na, tw, za + 0.3));
        if (qa.sl < 20) for (let t = 0; t < nt; t++) for (const r of [-0.75, 0.75]) { const o = tc(t) + r;      // the running rails carry on
          K.rail ? K.rail.quad(P2(a, na, o - 0.04, za + 0.47), P2(b, nb, o - 0.04, zb2 + 0.47), P2(b, nb, o + 0.04, zb2 + 0.47), P2(a, na, o + 0.04, za + 0.47)) : 0; }
      }
    }
  }
}

// ---------------------------------------------------------------- tunnels and covered sections
// see-through ("x-ray") by screen door: uXray (0..1) of the fragments dropped in a 4 × 4 Bayer pattern, so the lid and the
// ceiling over the convoy can be faded without a transparent pass (no sorting, no second shader); one uniform per view
export const XRAY_PARS = /* glsl */ `uniform float uXray;
  float bay2(vec2 a) { a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }
  float bay4(vec2 a) { return bay2(0.5 * a) * 0.25 + bay2(a); }\n`;
export const XRAY_CUT = /* glsl */ `if (uXray > 0.0 && bay4(gl_FragCoord.xy) < uXray) discard;\n`;
// under deep cover (a bored tunnel under a hill) a slanted view from above sees hill, not lid: a disc around the convoy on
// screen is cut out of what lies nearer than the convoy's roof (uCut: centre x, y and radius in pixels, depth; z 0 = off).
// One uniform for every view (the road view sets it each frame, 0 when the convoy is not in a tube)
export const CUT = { value: new THREE.Vector4(0, 0, 0, 0) };
/** the disc cut added to a material (chained after any other onBeforeCompile; its own program cache key) */
export function cutPatch(mat) {
  const prev = mat.onBeforeCompile, pk = mat.customProgramCacheKey;
  mat.onBeforeCompile = (sh, r) => {
    if (prev) prev(sh, r);
    sh.uniforms.uCut = CUT;
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec4 uCut;\n').replace('#include <clipping_planes_fragment>',
      '#include <clipping_planes_fragment>\nif (uCut.z > 0.0 && gl_FragCoord.z < uCut.w && distance(gl_FragCoord.xy, uCut.xy) < uCut.z) discard;\n');
  };
  mat.customProgramCacheKey = () => (pk ? pk.call(mat) : '') + '|cut';
  return mat;
}
/** wall, ceiling (see-through when uXray is up) and the lit band of the tubes */
export function tubeMaterials(keep, XRAY) {
  const wall = keep(cutPatch(new THREE.MeshStandardMaterial({ color: 0xd6d1c6, emissive: 0x4a463f, roughness: 0.8, side: THREE.DoubleSide })));
  const ceil = keep(cutPatch(patch(new THREE.MeshStandardMaterial({ color: 0x8f8a80, emissive: 0x302d29, roughness: 0.9, side: THREE.DoubleSide }), {
    key: 'tube-ceil', uniforms: { uXray: XRAY }, frag: { pars: XRAY_PARS, map: XRAY_CUT + '#include <map_fragment>' } })));
  const lit = keep(new THREE.MeshBasicMaterial({ color: 0xfff0d2, toneMapped: false }));      // a continuous line of lamps
  return { wall, ceil, lit };
}
/** a tunnel, covered section or wildlife overpass along P ([x, y], the line through it) with road heights zr[]: side
 *  walls at the offsets dr < 0 < dl from below the road up to the slab, the ceiling slab from zr + H, a lit band under it
 *  and, at each portal (ends: [first, last] point), a headwall from the opening up to the lid top (top[0|1]: m above the
 *  road) reaching 2.5 m beyond the walls, with wing walls back along the cutting. lidMin[i] (optional): the lowest lid over
 *  the tube above the road, so the slab stays under the lid's photo. K: {wall, ceil, lit} (Acc) */
export function tube(K, P, zr, dl, dr, H, top = [null, null], ends = [true, true], lidMin = null) {
  const n = P.length; if (n < 2 || !(dl > dr)) return;
  const N = normals(P), c = (dl + dr) / 2;
  const at = (i, o, z) => [P[i][0] + N[i][0] * o, P[i][1] + N[i][1] * o, z];
  const T = zr.map((_, i) => H + Math.max(0.05, Math.min(0.6, lidMin && Number.isFinite(lidMin[i]) ? lidMin[i] - H - 0.15 : 0.6)));     // the slab's top
  for (let i = 0; i < n - 1; i++) {
    const j = i + 1, za = zr[i], zb = zr[j], ta = za + T[i], tb = zb + T[j];
    for (const o of [dl, dr]) {                                         // walls: the faces towards the road, 0.5 m thick
      const s = o > 0 ? 1 : -1, oo = o + s * 0.5;
      K.wall.quad(at(i, o, za - 0.3), at(j, o, zb - 0.3), at(j, o, tb), at(i, o, ta));
      K.wall.quad(at(i, oo, za - 0.3), at(j, oo, zb - 0.3), at(j, oo, tb), at(i, oo, ta));
    }
    K.ceil.quad(at(i, dr, za + H), at(i, dl, za + H), at(j, dl, zb + H), at(j, dr, zb + H));                 // soffit
    K.ceil.quad(at(i, dr - 0.5, ta), at(j, dr - 0.5, tb), at(j, dl + 0.5, tb), at(i, dl + 0.5, ta));
    K.lit.quad(at(i, c - 0.2, za + H - 0.04), at(i, c + 0.2, za + H - 0.04), at(j, c + 0.2, zb + H - 0.04), at(j, c - 0.2, zb + H - 0.04));
  }
  for (const [e, i, k] of [[0, 0, 1], [1, n - 1, n - 2]]) {
    if (!ends[e]) continue;
    let ux = P[i][0] - P[k][0], uy = P[i][1] - P[k][1]; const l = Math.hypot(ux, uy) || 1; ux /= l; uy /= l;      // out of the tube
    const z = zr[i], h = Math.max(T[i] + 0.4, Number.isFinite(top[e]) ? top[e] : H + 1.5), nx = N[i][0], ny = N[i][1];
    const ctr = (o, t) => [P[i][0] + nx * o + ux * t, P[i][1] + ny * o + uy * t];
    const W = dl - dr + 5, [bx, by] = ctr(c, 0.4);
    block(K.wall, bx, by, nx, ny, W, 0.8, z + H, z + h);                                        // over the opening
    block(K.wall, bx, by, nx, ny, W + 0.3, 1.0, z + h, z + h + 0.25);                            // coping
    for (const o of [dl + 1.25, dr - 1.25]) { const [sx, sy] = ctr(o, 0.4); block(K.wall, sx, sy, nx, ny, 2.5, 0.8, z - 0.3, z + H); }
    // wing walls along the cutting, falling from the headwall's top to the ground beside the road
    const Lw = Math.min(16, Math.max(4, (h - 0.6) * 1.8));
    for (const o of [dl + 2.3, dr - 2.3]) { const [ax, ay] = ctr(o, 0.4); sweep(K.wall, [[ax, ay], [ax + ux * Lw, ay + uy * Lw]], [z + h, z + 0.7], [z - 0.5, z - 0.5], -0.25, 0.25); }
  }
}
