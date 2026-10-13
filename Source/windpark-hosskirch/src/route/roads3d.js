// Modelled road surfaces for the road view: the route's carriageway between its measured edges and every road within
// 120 m of it (route_roads.py, Overture), as asphalt (gravel on unpaved tracks) with German markings (RMS): edge lines
// and the centre line on two-way roads (dashes 3 / 6 m in towns, 4 / 8 m outside), lane lines 6 / 12 m and broad edge
// lines on dual carriageways, zebra stripes at the zebra crossings, kerbs in towns, parapets on small road bridges.
// The route's markings follow its class, one- or two-way traffic and the speed in force (route_pack.py marks); where the
// painted lines were found on the photo (route_lanelines.py, newer packs) they are drawn there, with the lane count found,
// the asphalt stops at the central reservation and the opposite carriageway is drawn from its measured edges.
import * as THREE from 'three';

const TYPICAL = { motorway: 11.0, trunk: 8.5, primary: 7.0, secondary: 6.5, tertiary: 6.0, unclassified: 5.0, residential: 5.5, living_street: 4.5, service: 3.5, track: 3.0, unknown: 4.0 };
// vertex colours are linear (the renderer's working space): the shades below are written as sRGB, as picked on the photo,
// and converted once (a motorway's worn surface a little lighter, gravel ochre)
const lin = (c) => c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
const ASPHALT = lin([0.44, 0.45, 0.47]), ASPHALT_M = lin([0.47, 0.48, 0.5]), GRAVEL = lin([0.6, 0.55, 0.46]), KERB = lin([0.7, 0.69, 0.66]), PARAPET = lin([0.72, 0.71, 0.68]), RAIL = lin([0.62, 0.64, 0.66]);

let SHARED = null;
export function roadMaterials() { return materials(); }
// streets on a tunnel lid see-through with the lid: while a view's x-ray is up, road fragments higher than w within z m
// (world x, z) of the convoy drop in the lid's screen door (uRx: x, z, radius, height, z 0 = off; uRxf: the share dropped).
// One uniform for every view (each view sets it per frame while its x-ray is up and clears it otherwise)
export const ROAD_XR = { uRx: { value: new THREE.Vector4(0, 0, 0, 0) }, uRxf: { value: 0 } };
function xrPatch(m) {
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, ROAD_XR);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vXW;\n')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvXW = (modelMatrix * vec4(transformed, 1.0)).xyz;\n');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
      varying vec3 vXW; uniform vec4 uRx; uniform float uRxf;
      float rxb2(vec2 a) { a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }
      float rxb4(vec2 a) { return rxb2(0.5 * a) * 0.25 + rxb2(a); }\n`).replace('#include <clipping_planes_fragment>',
      '#include <clipping_planes_fragment>\nif (uRx.z > 0.0 && vXW.y > uRx.w && distance(vXW.xz, uRx.xy) < uRx.z && rxb4(gl_FragCoord.xy) < uRxf) discard;\n');
  };
  m.customProgramCacheKey = () => 'road-xr';
  return m;
}
function materials() {
  if (SHARED) return SHARED;
  // a fine asphalt grain (world-scaled uv, 4 m tiles) so the surface does not read as flat colour up close
  const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d'); const img = g.createImageData(128, 128);
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 128 * 128; i++) { const v = 205 + rnd() * 50 - (rnd() < 0.04 ? 40 : 0); img.data.set([v, v, v, 255], 4 * i); }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c); tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  const surf = new THREE.MeshStandardMaterial({ vertexColors: true, map: tex, roughness: 0.93, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  const mark = new THREE.MeshStandardMaterial({ color: 0xf0f0ea, roughness: 0.6, emissive: 0x2a2a28, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 });
  const solid = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.1, side: THREE.DoubleSide });
  for (const m of [surf, mark, solid]) xrPatch(m);
  return (SHARED = { surf, mark, solid, tex });
}

// quads into growing typed arrays (positions, colours, world-scaled uv; flat normals per quad)
class Buf {
  constructor(uv = false) { this.hasUv = uv; this.nq = 0; this.P = new Float32Array(12 * 1024); this.C = new Float32Array(12 * 1024); this.N = new Float32Array(12 * 1024); }
  quad(a, b, c, d, col, nrm = null) {      // a b c d: [x, z, -y] counter-clockwise seen from above / outside (nrm: its normal, else flat)
    if (!(Number.isFinite(a[1] + b[1] + c[1] + d[1]) && Number.isFinite(a[0] + c[0] + a[2] + c[2]))) return;      // (an unknown line: left out)
    if ((this.nq + 1) * 12 > this.P.length) for (const k of ['P', 'C', 'N']) { const o = new Float32Array(this[k].length * 2); o.set(this[k]); this[k] = o; }
    const o = this.nq++ * 12, P = this.P, C = this.C, N = this.N;
    P[o] = a[0]; P[o + 1] = a[1]; P[o + 2] = a[2]; P[o + 3] = b[0]; P[o + 4] = b[1]; P[o + 5] = b[2]; P[o + 6] = c[0]; P[o + 7] = c[1]; P[o + 8] = c[2]; P[o + 9] = d[0]; P[o + 10] = d[1]; P[o + 11] = d[2];
    // the normal of the quad: (c − a) × (d − b)
    const ux = c[0] - a[0], uy = c[1] - a[1], uz = c[2] - a[2], vx = d[0] - b[0], vy = d[1] - b[1], vz = d[2] - b[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; if (nrm) { nx = nrm[0]; ny = nrm[1]; nz = nrm[2]; } const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    for (let v = 0; v < 4; v++) { const q = o + 3 * v; N[q] = nx; N[q + 1] = ny; N[q + 2] = nz; C[q] = col[0]; C[q + 1] = col[1]; C[q + 2] = col[2]; }
  }
  mesh(mat) {
    if (!this.nq) return null;
    const nv = 4 * this.nq, g = new THREE.BufferGeometry(), idx = nv > 65535 ? new Uint32Array(6 * this.nq) : new Uint16Array(6 * this.nq);
    for (let q = 0; q < this.nq; q++) { const v = 4 * q, o = 6 * q; idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 2; idx[o + 3] = v; idx[o + 4] = v + 2; idx[o + 5] = v + 3; }
    const P = this.P.slice(0, 3 * nv);
    g.setAttribute('position', new THREE.BufferAttribute(P, 3)); g.setAttribute('normal', new THREE.BufferAttribute(this.N.slice(0, 3 * nv), 3)); g.setAttribute('color', new THREE.BufferAttribute(this.C.slice(0, 3 * nv), 3));
    if (this.hasUv) { const U = new Float32Array(2 * nv); for (let v = 0; v < nv; v++) { U[2 * v] = P[3 * v] / 4; U[2 * v + 1] = P[3 * v + 2] / 4; } g.setAttribute('uv', new THREE.BufferAttribute(U, 2)); }
    g.setIndex(new THREE.BufferAttribute(idx, 1)); g.computeBoundingSphere(); return new THREE.Mesh(g, mat);
  }
}

const U16 = -32768;
// the photo strip's rows left of the route (roadview.js ROWS): the opposite carriageway is raised to the strip at them
const OROWS = [3, 5, 7, 9, 12, 16, 24, 34, 45];
// a per-sample column of an int16 ×100 array with w values per sample (NaN where unknown)
const column = (a, c, w, n) => { const o = new Float32Array(n); for (let k = 0; k < n; k++) { const v = a[w * k + c]; o[k] = v === U16 ? NaN : v / 100; } return o; };
// running median of 5 then mean of 5 samples over the known values (NaN stays NaN): the measured lines are noisy
const W5 = new Float64Array(5);
function smooth5(a) {
  const n = a.length, m = new Float32Array(n), o = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    if (!Number.isFinite(a[k])) { m[k] = NaN; continue; }
    let c = 0; for (let j = Math.max(0, k - 2); j <= Math.min(n - 1, k + 2); j++) { const v = a[j]; if (!Number.isFinite(v)) continue; let i = c++; while (i > 0 && W5[i - 1] > v) { W5[i] = W5[i - 1]; i--; } W5[i] = v; }
    m[k] = W5[c >> 1];
  }
  for (let k = 0; k < n; k++) { if (!Number.isFinite(m[k])) { o[k] = NaN; continue; } let s = 0, c = 0; for (let j = Math.max(0, k - 2); j <= Math.min(n - 1, k + 2); j++) if (Number.isFinite(m[j])) { s += m[j]; c++; } o[k] = s / c; }
  return o;
}

// the terrain under and beside the route's own bridge relative to the road (as roadview.js rbRel: across the deck straight
// between the terrain just outside it, eased by mw; faded beyond ±45 m and by fade): the side roads under our decks
function rbRelLocal(r, d) {
  if (!r || !r.rel || !r.D) return 0;
  const D = r.D, row = r.rel, ad = Math.abs(d);
  const at = (dd) => { dd = Math.max(D[0], Math.min(D[D.length - 1], dd)); let i = 0; while (i < D.length - 2 && D[i + 1] < dd) i++; const t = Math.max(0, Math.min(1, (dd - D[i]) / (D[i + 1] - D[i]))); return row[i] + (row[i + 1] - row[i]) * t; };
  let v = at(d);
  if (r.on) { const a = (r.dr ?? -7) - 4, b = (r.dl ?? 7) + 4; if (d > a && d < b) { const va = at(a), vb = at(b), ln = va + (vb - va) * ((d - a) / (b - a)); v += (Math.min(v, ln) - v) * (r.mw ?? 1); } }
  v = Math.min(0, v);
  return v * (ad <= 45 ? 1 : Math.max(0, (300 - ad) / 255)) * (r.fade ?? 1);
}

// the roundabouts of a pack: rings of the mapped pieces (an arc of 25° or more on a circle of radius 8–40 m, every point
// within 1.5 m of it) as [x, y, r] in the view's frame (cached on the pack)
function roundabouts(P, dx, dy) {
  if (P.R3RB) return P.R3RB;
  const out = [];
  for (const [, , fl, , pts] of P.hdr.roads || []) {
    const np = pts.length / 2; if (np < 3 || (fl & 35)) continue;
    const X = (i) => pts[2 * i] / 10 + dx, Y = (i) => pts[2 * i + 1] / 10 + dy, m = np >> 1;
    const ax = X(0), ay = Y(0), bx = X(m), by = Y(m), cx = X(np - 1), cy = Y(np - 1), d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(d) < 1e-6) continue;
    const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy, ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d, uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d, r = Math.hypot(ax - ux, ay - uy);
    if (r < 8 || r > 40 || Math.hypot(cx - ax, cy - ay) < 2 * r * Math.sin((12.5 * Math.PI) / 180)) continue;
    let ok = true; for (let i = 0; i < np && ok; i++) if (Math.abs(Math.hypot(X(i) - ux, Y(i) - uy) - r) > 1.5) ok = false;
    if (ok && !out.some((q) => Math.hypot(q[0] - ux, q[1] - uy) < 6)) out.push([ux, uy, r]);
  }
  return (P.R3RB = out);
}

/** ctx: { ground(x, y), surfK(P, f, d): the drawn surface of pack P at fractional sample f, offset d; surfR(r): the same
 *  at a position from toRoute(x, y); onDeck(x, y, margin), origin(), pack(p) } */
export function makeRoads3D(ctx) {
  const M = materials();

  // (a generator: it yields between its parts, so a pack's build can go on in the next slice)
  function* routeSurface(P, S, K, MK) {
    const A = P.A, n = P.hdr.n2, O = ctx.origin(), dx = P.hdr.ox - O.x, dy = P.hdr.oy - O.y;
    if (n < 2) return;
    const marks = P.hdr.marks || [[A.s2[0], 2, 1, 0]], cls = P.hdr.roadc || [];
    const markAt = (s) => { let k = 0; while (k + 1 < marks.length && marks[k + 1][0] <= s) k++; return marks[k]; };
    // edges smoothed along the road (median of 5, then mean of 5 samples): the measured edges are noisy
    const Lr = new Float32Array(n), Rr = new Float32Array(n);
    for (let k = 0; k < n; k++) { Lr[k] = A.edge[2 * k] / 100; Rr[k] = A.edge[2 * k + 1] / 100; }
    const L = smooth5(Lr), R = smooth5(Rr);
    yield;
    // the painted lines found on the photo and the central reservation (newer packs; NaN where not found)
    const ER = A.lane ? smooth5(column(A.lane, 1, 4, n)) : null, EL = A.lane ? smooth5(column(A.lane, 2, 4, n)) : null, OW = A.lane ? smooth5(column(A.lane, 0, 4, n)) : null;
    // the painted centre line of a two-way road (cm, route_lanelines.py cl) and exit / entry lanes right of the edge line
    // (ex: 1) where the pack has them (route_pack.py, newer packs)
    const CL = A.cl && A.cl.length >= n ? smooth5(column(A.cl, 0, 1, n)) : null, EX = A.ex && A.ex.length >= n ? A.ex : null;
    const AX = A.med ? smooth5(column(A.med, 0, 4, n)) : null;
    yield;
    // the opposite carriageway's edges: a width over 18 m (or 2.5 m more than ours) or a jump of the outer edge over 1 m
    // between samples is a misreading (the outer edge on a parallel road or verge): not drawn there
    let OI = null, OO = null;
    if (A.med) {
      const oi = column(A.med, 1, 4, n), oo = column(A.med, 2, 4, n), bad = new Uint8Array(n);
      for (let k = 0; k < n; k++) {
        const w = oo[k] - oi[k]; if (!(w >= 3 && w <= Math.max(18, Lr[k] + Rr[k] + 2.5))) bad[k] = 1;
        if (k && Math.abs(oo[k] - oo[k - 1]) > 1) bad[k] = bad[k - 1] = 1;
      }
      for (let k = 0; k < n; k++) if (bad[k]) oi[k] = oo[k] = NaN;
      // (a short run of them between good samples, a step of the edges: carried straight across, no hole)
      for (let k = 0; k < n;) { if (!Number.isFinite(oi[k]) || Number.isFinite(oi[k + 1]) || k + 1 >= n) { k++; continue; }
        let b = k + 1; while (b < n && !Number.isFinite(oi[b])) b++;
        if (b < n && b - k <= 6 && bad[k + 1]) for (let j = k + 1; j < b; j++) { const t = (j - k) / (b - k); oi[j] = oi[k] + (oi[b] - oi[k]) * t; oo[j] = oo[k] + (oo[b] - oo[k]) * t; }
        k = b; }
      OI = smooth5(oi); OO = smooth5(oo);
    }
    const dual = (k) => { const mk = markAt(A.s2[k]), c = cls[mk[1]]; return !mk[2] && (c === 'motorway' || c === 'trunk'); };
    yield;
    // our asphalt stops at the central reservation (the foot of a concrete barrier, 0.5 m short of a steel rail, the kerb
    // of a raised median) and 0.75 m beyond the inner edge line (as the opposite one); on dual carriageways 3.5 m beyond the
    // outer edge line (the hard shoulder: verge or median misread as paved on the photo is not drawn; 4.6 m beside an exit
    // or entry lane); on other roads 0.6 m beyond both painted edge lines where both were found (the shadows of trees and
    // the verges read as paved are not drawn)
    // elsewhere (no painted edge lines found) no further out than 1 m beyond the running median of the edge over 50 m: the
    // trace ran out into a meadow, a yard, the shadow of a hedge
    const med25 = (a) => { const o = new Float32Array(n), w = []; for (let k = 0; k < n; k++) { w.length = 0; for (let j = Math.max(0, k - 12); j <= Math.min(n - 1, k + 12); j++) if (Number.isFinite(a[j])) w.push(a[j]); w.sort((p, q) => p - q); o[k] = w.length ? w[w.length >> 1] : NaN; } return o; };
    const mL = med25(L); yield; const mR = med25(R); yield;
    for (let k = 0; k < n; k++) {
      const t = A.mty ? A.mty[k] : 0, ax = AX ? AX[k] : NaN;
      if (Number.isFinite(ax)) L[k] = Math.min(L[k], ax - (t === 2 ? 0.35 : t === 3 ? Math.max(0.6, Number.isFinite(EL && EL[k]) ? ax - EL[k] - 0.9 : 1.5) : 0.5));
      const el = EL ? EL[k] : NaN, er = ER ? ER[k] : NaN;
      if (dual(k)) {
        if (Number.isFinite(el)) L[k] = Math.min(L[k], el + 0.75);
        if (Number.isFinite(er)) R[k] = Math.min(R[k], (EX && EX[k] ? 4.6 : 3.5) - er);
      } else if (Number.isFinite(el - er) && el - er >= 4.5 && el - er <= 14 && el > 0.5 && er < -0.5) { L[k] = Math.min(L[k], el + 0.6); R[k] = Math.min(R[k], 0.6 - er); }
      else {
        if (Number.isFinite(mL[k] + mR[k])) { L[k] = Math.min(L[k], mL[k] + 1.0); R[k] = Math.min(R[k], mR[k] + 1.0); }
        // (and no wider than 1.25 × the road class's typical width + 1.5 m: the wider side is cut back — a junction's mouth is
        // the side road's own asphalt)
        const c = cls[markAt(A.s2[k])[1]] || 'unknown', cap = (TYPICAL[c] || 4) * 1.25 + 1.5, ex = L[k] + R[k] - cap;
        if (ex > 0) { const hi = L[k] > R[k] ? L : R, lo = hi === L ? R : L, d1 = Math.min(ex, hi[k] - lo[k]); hi[k] -= d1; if (ex > d1) { hi[k] -= (ex - d1) / 2; lo[k] -= (ex - d1) / 2; } }
      }
      if (L[k] + R[k] < 2.5) L[k] = 2.5 - R[k];
    }
    // (then a mean over 7 samples: the edges of an unmarked road came in steps — a sawtooth along a meadow)
    for (const E of [L, R]) { const c = Float32Array.from(E); for (let k = 0; k < n; k++) { let sm = 0, m = 0; for (let j = Math.max(0, k - 3); j <= Math.min(n - 1, k + 3); j++) if (Number.isFinite(c[j])) { sm += c[j]; m++; } if (m) E[k] = Math.min(c[k] + (E === L && AX && Number.isFinite(AX[k]) ? 0 : 0.3), sm / m); } }
    P.R3L = L; P.R3R = R;              // (the side roads stop at the asphalt as drawn)
    yield;
    // the pack's first and last columns reach half the gap to the neighbouring pack's (as the photo strips): no gap at the
    // seams (2 m every 5 km). e0 / e1: the reach in samples
    const ds0 = A.s2[1] - A.s2[0] || 2, ds1 = A.s2[n - 1] - A.s2[n - 2] || 2;
    const nbr = (o) => { const Q = ctx.pack ? ctx.pack(P.hdr.p + o) : null; return Q && Q.A && Q.hdr && Q.hdr.n2 > 1 ? Q : null; };
    const Pp = nbr(-1), Pn = nbr(1);
    const g0 = Pp ? (A.s2[0] - Pp.A.s2[Pp.hdr.n2 - 1]) / 2 : 1, g1 = Pn ? (Pn.A.s2[0] - A.s2[n - 1]) / 2 : 1;
    const e0 = (g0 >= 0 && g0 <= 3 ? g0 : 1) / ds0, e1 = (g1 >= 0 && g1 <= 3 ? g1 : 1) / ds1;
    const FC = []; if (e0 > 0) FC.push(-e0); for (let k = 0; k < n; k++) FC.push(k); if (e1 > 0) FC.push(n - 1 + e1);
    const ki = (f) => Math.max(0, Math.min(n - 1, Math.round(f)));
    // a point at fractional sample f (beyond the ends: carried on along the first / last step), lateral d (left +), lifted
    // above the drawn surface: on our carriageway its plane (also in a tunnel's tube and on our bridges), on the opposite
    // carriageway (opp) its own surface (oppZ)
    const SL = P.SL || Float32Array.from(A.slope, (v) => Math.max(-0.08, Math.min(0.08, v / 10000)));
    let oppZ = null;
    // (the points live in a ring of 8: a quad copies its four at once, the kerbs use six)
    const RING = Array.from({ length: 8 }, () => [0, 0, 0]); let ri = 0;
    const pt = (f, d, lift = 0.03, opp = false) => {
      const k = Math.max(0, Math.min(n - 2, Math.floor(f))), t = f - k, C = A.cen, Nr = A.nor;
      const x = C[2 * k] + (C[2 * k + 2] - C[2 * k]) * t + dx, y = C[2 * k + 1] + (C[2 * k + 3] - C[2 * k + 1]) * t + dy;
      const nx = (Nr[2 * k] + (Nr[2 * k + 2] - Nr[2 * k]) * t) / 30000, ny = (Nr[2 * k + 1] + (Nr[2 * k + 3] - Nr[2 * k + 1]) * t) / 30000;
      let z;
      if (opp) { const z0 = oppZ(k, d), z1 = oppZ(k + 1, d); z = z0 + (z1 - z0) * t; }
      else z = A.z[k] + (A.z[k + 1] - A.z[k]) * t + (SL[k] + (SL[k + 1] - SL[k]) * t) * d;
      const o = RING[ri++ & 7]; o[0] = x + nx * d; o[1] = z + lift; o[2] = -(y + ny * d); return o;
    };
    // over a tunnel's lid (outside its walls): no road drawn there
    const onLid = (k, d) => { const tn = P.tnk && P.tnk.get(k); return !!tn && (d > tn.dl || d < tn.dr); };
    const sA = A.s2[0] - e0 * ds0, sB = A.s2[n - 1] + e1 * ds1;
    const fOf = (s) => { if (s <= A.s2[0]) return Math.max(-e0, (s - A.s2[0]) / ds0); if (s >= A.s2[n - 1]) return Math.min(n - 1 + e1, n - 1 + (s - A.s2[n - 1]) / ds1);
      let lo = 0, hi = n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (A.s2[m] < s) lo = m; else hi = m; } return lo + Math.max(0, Math.min(1, (s - A.s2[lo]) / ((A.s2[hi] - A.s2[lo]) || 1))); };
    // asphalt between the edges; kerbs (0.12 m) in towns
    for (let j = 0; j < FC.length - 1; j++) {
      if ((j & 63) === 63) yield;
      const fa = FC[j], fb = FC[j + 1], ka = ki(fa), kb = ki(fb), mk = markAt(A.s2[Math.min(ka, kb)]), c = cls[mk[1]] || 'unknown', col = c === 'track' ? GRAVEL : c === 'motorway' ? ASPHALT_M : ASPHALT;
      S.quad(pt(fa, -R[ka]), pt(fb, -R[kb]), pt(fb, L[kb]), pt(fa, L[ka]), col);
      if (mk[3] && c !== 'motorway' && c !== 'track') for (const [e, sg] of [[L, 1], [R, -1]]) {
        const a0 = pt(fa, sg * e[ka]), a1 = pt(fb, sg * e[kb]), b0 = pt(fa, sg * e[ka], 0.15), b1 = pt(fb, sg * e[kb], 0.15), c0 = pt(fa, sg * (e[ka] + 0.18), 0.15), c1 = pt(fb, sg * (e[kb] + 0.18), 0.15);
        if (sg > 0) { K.quad(a0, a1, b1, b0, KERB); K.quad(b0, b1, c1, c0, KERB); } else { K.quad(a1, a0, b0, b1, KERB); K.quad(b1, b0, c0, c1, KERB); }
      }
    }
    yield;
    // markings: a line at offset fn(k) (m, left +) from s0 to s1, dashed (on, off) or solid, width w; cut: [[sa, sb]] left out
    const line = (s0, s1, off, w, on, off_, opp = false, cut = null) => {
      if (cut && cut.length) {
        let a = s0;
        for (const [ca, cb] of cut) { if (cb <= a || ca >= s1) continue; if (ca - a >= 1) line(a, ca, off, w, on, off_, opp); a = Math.max(a, cb); }
        if (s1 - a >= 1) line(a, s1, off, w, on, off_, opp); return;
      }
      const f0 = fOf(s0), f1 = fOf(s1);
      if (!on) { for (let f = f0; f < f1 - 1e-3; f = Math.min(f1, Math.floor(f) + 1)) { const g = Math.min(f1, Math.floor(f) + 1), d0 = off(f), d1 = off(g); MK.quad(pt(f, d0 - w / 2, 0.04, opp), pt(g, d1 - w / 2, 0.04, opp), pt(g, d1 + w / 2, 0.04, opp), pt(f, d0 + w / 2, 0.04, opp), [1, 1, 1]); } return; }
      const per = on + off_; let s = Math.ceil(s0 / per) * per;
      for (; s + on <= s1; s += per) { const fa = fOf(s), fb = fOf(s + on), d0 = off(fa), d1 = off(fb); MK.quad(pt(fa, d0 - w / 2, 0.04, opp), pt(fb, d1 - w / 2, 0.04, opp), pt(fb, d1 + w / 2, 0.04, opp), pt(fa, d0 + w / 2, 0.04, opp), [1, 1, 1]); }
    };
    const at = (a) => (f) => { const k = Math.max(0, Math.min(n - 2, Math.floor(f))), t = Math.max(0, Math.min(1, f - k)); return a[k] + (a[k + 1] - a[k]) * t; };
    const Lf = at(L), Rf = at(R);
    // the stretches of [s0, s1] where all of the arrays are known, each with its lane count (from the pack; else from the
    // width between the edge lines), runs under 50 m joined to the one before: [[s0, s1, nl]]
    const known = (s0, s1, arrs) => {
      const out = [], k0 = Math.max(0, Math.ceil(fOf(s0))), k1 = Math.min(n - 1, Math.floor(fOf(s1)));
      for (let k = k0; k <= k1; k++) {
        const ok = arrs.every((a) => Number.isFinite(a[k]) && (k + 1 >= n || Number.isFinite(a[k + 1])));
        const nl = !ok ? 0 : A.nl && A.nl[k] > 0 ? A.nl[k] : EL && ER && Number.isFinite(EL[k] - ER[k]) ? Math.max(1, Math.min(5, Math.round((EL[k] - ER[k]) / 3.75))) : 1;
        const last = out[out.length - 1];
        if (last && last[2] === nl && last[3] === k - 1) { last[1] = A.s2[k]; last[3] = k; } else out.push([A.s2[k], A.s2[k], nl, k]);
      }
      for (let i = 1; i < out.length; i++) if (out[i][2] && out[i - 1][2] && out[i][1] - out[i][0] < 50) { out[i - 1][1] = out[i][1]; out[i - 1][3] = out[i][3]; out.splice(i--, 1); }
      return out.map(([a, b, nl], i) => [i ? a : s0, i === out.length - 1 ? s1 : out[i + 1][0], nl]);
    };
    // the stretches of [s0, s1] by a per-sample value v(k): [[s0, s1, v]]
    const runsBy = (s0, s1, v) => {
      const out = [], k0 = Math.max(0, Math.ceil(fOf(s0))), k1 = Math.min(n - 1, Math.floor(fOf(s1)));
      for (let k = k0; k <= k1; k++) { const x = v(k), last = out[out.length - 1]; if (last && last[2] === x) last[1] = A.s2[k]; else out.push([A.s2[k], A.s2[k], x]); }
      if (!out.length) return [[s0, s1, v(Math.max(0, Math.min(n - 1, Math.round(fOf(s0)))))]];
      return out.map(([a, , x], i) => [i ? a : s0, i === out.length - 1 ? s1 : out[i + 1][0], x]);
    };
    yield;
    // where a side road meets our carriageway (the end of a mapped piece within 6 m of our edge): the edge line on the side
    // it leaves to is broken from where its line reaches our edge to where its ribbon is clear of it (a slip road merging at
    // a shallow angle: all along the merge), + half its width + 3 m either side; per side [[sa, sb]]. (A piece still on our carriageway 60 m
    // on runs along it: none)
    const mouths = { 1: [], [-1]: [] };
    for (const [ci, w10, fl, lv, pts] of P.hdr.roads || []) {
      yield;
      if ((fl & 35) || lv > 0 || pts.length < 4) continue;
      const W = Math.max(2.5, Math.min(16, w10 ? w10 / 10 : (fl & 16 ? 5 : TYPICAL[cls[ci]] || 4))), np = pts.length / 2;
      for (const end of [0, 1]) {
        const sg = end ? -1 : 1, i0 = end ? np - 1 : 0, X = (i) => pts[2 * i] / 10 + dx, Y = (i) => pts[2 * i + 1] / 10 + dy;
        const r0 = ctx.toRoute(X(i0), Y(i0)); if (!r0 || r0.q.p !== P.hdr.p) continue;
        if (Math.abs(r0.d) > (r0.d > 0 ? L[r0.q.k] : R[r0.q.k]) + 6) continue;
        let smin = r0.s, smax = r0.s, side = 0, clear = false, acc = 0;
        for (let i = i0; i + sg >= 0 && i + sg < np && !clear && acc < 60; i += sg) {
          const ax = X(i), ay = Y(i), bx = X(i + sg), by = Y(i + sg), l = Math.hypot(bx - ax, by - ay), m = Math.max(1, Math.ceil(l / 3));
          for (let j = 1; j <= m && acc < 60; j++) {
            acc += l / m; const r = ctx.toRoute(ax + ((bx - ax) * j) / m, ay + ((by - ay) * j) / m); if (!r) { acc = 60; break; }
            if (!side && Math.abs(r.d) > 1) side = r.d > 0 ? 1 : -1;
            const e = r.q.p === P.hdr.p ? (r.d > 0 ? L[r.q.k] : R[r.q.k]) : r.d > 0 ? r.q.L : r.q.R;
            if (Math.abs(r.d) - W / 2 > e + 1) { clear = true; break; }
            smin = Math.min(smin, r.s); smax = Math.max(smax, r.s);
          }
        }
        if (clear && side) mouths[side].push([smin - W / 2 - 3, smax + W / 2 + 3]);
      }
    }
    for (const sd of [1, -1]) { const m = mouths[sd].sort((p, q) => p[0] - q[0]); for (let i = 1; i < m.length; i++) if (m[i][0] <= m[i - 1][1]) { m[i - 1][1] = Math.max(m[i - 1][1], m[i][1]); m.splice(i--, 1); } }
    // in a roundabout (the route within 8 m of a ring of the mapped pieces, or turning on a radius under 35 m): no centre line
    const RND = new Uint8Array(n), RB = roundabouts(P, dx, dy);
    for (let k = 0; k < n; k++) { const a = Math.max(0, k - 5), b = Math.min(n - 1, k + 5), ds = A.s2[b] - A.s2[a]; if (ds <= 0) continue;
      const kap = Math.asin(Math.max(-1, Math.min(1, (A.nor[2 * a] * A.nor[2 * b + 1] - A.nor[2 * a + 1] * A.nor[2 * b]) / 9e8))) / ds; if (Math.abs(kap) > 1 / 35) RND[k] = 1;
      const x = A.cen[2 * k] + dx, y = A.cen[2 * k + 1] + dy; for (const [ux, uy, r] of RB) if (Math.hypot(x - ux, y - uy) < r + 8) RND[k] = 1; }
    // the centre line of a two-way road: as painted (cl), else midway between the painted edge lines, else the convoy's own
    // lane's left boundary (NaN: midway between the edges; in a roundabout none)
    let CC = null;
    if (CL || EL || OW) {
      const c0 = new Float32Array(n);
      for (let k = 0; k < n; k++) { const el = EL ? EL[k] : NaN, er = ER ? ER[k] : NaN;
        c0[k] = CL && Number.isFinite(CL[k]) ? CL[k] : Number.isFinite(el - er) && el - er >= 4.5 && el - er <= 14 ? (el + er) / 2 : OW ? OW[k] : NaN; }
      CC = smooth5(c0);
    }
    const CCf = CC ? at(CC) : null;
    const centre = (f) => { if (RND[ki(f)]) return NaN; const v = CCf ? CCf(f) : NaN, l = Lf(f), r = Rf(f); return Number.isFinite(v) ? Math.max(-r + 1.5, Math.min(l - 1.5, v)) : (l - r) / 2; };
    for (let j = 0; j < marks.length; j++) {
      if (j) yield;
      const s0 = j ? Math.max(sA, marks[j][0]) : sA, s1 = j + 1 < marks.length ? Math.min(sB, marks[j + 1][0]) : sB; if (s1 - s0 < 4) continue;
      const c = cls[marks[j][1]] || 'unknown', tw = marks[j][2], town = marks[j][3];
      if (c === 'track' || c === 'service' || c === 'living_street') continue;
      const W = (f) => Lf(f) + Rf(f);
      if (!tw && (c === 'motorway' || c === 'trunk')) {
        // dual carriageway: the painted edge lines found (broad lines, 0.30 m) with the lane lines (6 / 12 m, 0.15 m): the
        // first at the right lane's left line found (the own lane's boundary; the right lane is often the widest), the others
        // evenly up to the inner edge line; where none were found a hard shoulder on motorways and lanes of about 3.75 m.
        // Beside an exit or entry lane (ex) the right edge line is the broad dashed line (6 / 6 m) and the lane's own edge
        // line runs 3.75 m further out; where a slip road meets the edge the edge line is broken
        const cutR = mouths[-1];
        const old = (a, b) => {
          const sh = c === 'motorway' ? 2.5 : 0.5;
          line(a, b, (f) => -Rf(f) + sh, 0.30, 0, 0, false, cutR);
          line(a, b, (f) => Lf(f) - 0.6, 0.30, 0, 0);
          const fm = fOf((a + b) / 2), Wm = W(fm) - sh - 0.6, nl = Math.max(1, Math.min(4, Math.round(Wm / 3.75)));
          for (let l = 1; l < nl; l++) line(a, b, (f) => -Rf(f) + sh + (W(f) - sh - 0.6) * l / nl, 0.15, 6, 12);
        };
        if (!ER || !EL) { old(s0, s1); continue; }
        const ERf = at(ER), ELf = at(EL), OWf = OW ? at(OW) : null;
        for (const [a, b, nl] of known(s0, s1, [ER, EL])) {
          if (b - a < 4) continue;
          if (!nl) { old(a, b); yield; continue; }
          for (const [a2, b2, x] of runsBy(a, b, (k) => (EX && EX[k] ? 1 : 0))) {
            if (!x) { line(a2, b2, ERf, 0.30, 0, 0, false, cutR); continue; }
            line(a2, b2, ERf, 0.30, 6, 6);
            line(a2, b2, (f) => Math.max(-Rf(f) + 0.5, ERf(f) - 3.75), 0.30, 0, 0, false, cutR);
          }
          line(a, b, ELf, 0.30, 0, 0); yield;
          const first = (f) => { const e0 = ERf(f), e1 = ELf(f), o = OWf ? OWf(f) : NaN; return Number.isFinite(o) && o - e0 >= 2.6 && e1 - o >= 2.6 * (nl - 1) ? o : e0 + (e1 - e0) / nl; };
          for (let l = 1; l < nl; l++) line(a, b, l === 1 ? first : (f) => first(f) + ((ELf(f) - first(f)) * (l - 1)) / (nl - 1), 0.15, 6, 12);
          yield;
        }
      } else if (tw) {
        // two-way: the centre line (dashes 3 / 6 m in towns, 4 / 8 m outside), edge lines outside towns broken at the mouths
        // of side roads
        const Wm = W(fOf((s0 + s1) / 2));
        if (Wm >= 5.5 && ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified'].includes(c)) line(s0, s1, centre, 0.12, town ? 3 : 4, town ? 6 : 8);
        if (!town && Wm >= 5.5 && c !== 'unclassified') { line(s0, s1, (f) => Lf(f) - 0.3, 0.12, 0, 0, false, mouths[1]); line(s0, s1, (f) => -Rf(f) + 0.3, 0.12, 0, 0, false, mouths[-1]); }
      } else {
        // one-way carriageway of an ordinary road: edge lines only (broken at the mouths of side roads)
        if (!town) { line(s0, s1, (f) => Lf(f) - 0.3, 0.12, 0, 0, false, mouths[1]); line(s0, s1, (f) => -Rf(f) + 0.3, 0.12, 0, 0, false, mouths[-1]); }
      }
    }
    // the opposite carriageway between its measured paved edges (not over a tunnel's lid), its markings mirrored from ours:
    // broad edge lines inside its edges by our own margins (inner strip, hard shoulder), the lane lines evenly between
    if (OI && OO) {
      // where its own pieces (roads flag 32) are flagged as a bridge (1) or a tunnel (2): per sample of ours
      const OF = new Uint8Array(n);
      for (const [, , fl, , pts] of P.hdr.roads || []) {
        if (!(fl & 32) || !(fl & 3)) continue;
        let kp = -1;
        for (let i = 0; i + 1 < pts.length; i += 2) {
          const r = ctx.toRoute(pts[i] / 10 + dx, pts[i + 1] / 10 + dy); if (!r || r.q.p !== P.hdr.p) { kp = -1; continue; }
          const k = r.q.k; if (kp >= 0 && Math.abs(k - kp) < 60) for (let j = Math.min(k, kp); j <= Math.max(k, kp); j++) OF[j] |= fl & 3; else OF[k] |= fl & 3; kp = k;
        }
      }
      // no wider than our own carriageway + 2.5 m (an outer edge read on the verge beyond); it ends at its own portal (its
      // tube may start before ours: not drawn over the lid)
      for (let k = 0; k < n; k++) if (Number.isFinite(OO[k] - OI[k])) OO[k] = Math.min(OO[k], OI[k] + L[k] + R[k] + 2.5);
      P.R3OO = OO;                     // (side roads crossing a dual carriageway stop at its outer edges)
      const ok = (k) => Number.isFinite(OI[k]) && Number.isFinite(OO[k]) && OO[k] - OI[k] > 3 && OI[k] > L[k] - 0.5 && !onLid(k, OI[k]) && !onLid(k, OO[k]) && !(OF[k] & 2);
      // its surface (the measured terrain there) at both edges, planar between them; over our bridges and its own decks and
      // 12 m beyond them straight between the heights just outside (the terrain model has the gap under the decks there,
      // and our deck's plane carried across has the wrong cross fall)
      const ZI = new Float32Array(n), ZO = new Float32Array(n);
      for (let k = 0; k < n; k++) if (Number.isFinite(OI[k]) && Number.isFinite(OO[k])) { ZI[k] = ctx.surfK(P, k, OI[k]); ZO[k] = ctx.surfK(P, k, OO[k]); }
      const onB = new Uint8Array(n);
      for (let k = 0; k < n; k++) { const rb = P.rbk && P.rbk.get(k); if ((OF[k] & 1) || (rb && rb.on)) for (let j = Math.max(0, k - 6); j <= Math.min(n - 1, k + 6); j++) onB[j] = 1; }
      // where our own deck carries it (both its edges on the deck, give or take): on the deck's plane, as our carriageway and
      // the photo strip on the deck (a chord between the ends sinks under the deck on a crest and the photo shows through);
      // the 12 m beside the deck straight between the ground outside and the deck's end
      const onD = new Uint8Array(n);
      for (let k = 0; k < n; k++) { const rb = P.rbk && P.rbk.get(k);
        if (!(rb && rb.on && rb.rel) || !Number.isFinite(OI[k] + OO[k]) || OI[k] < rb.dr - 0.5 || OO[k] > rb.dl + 3) continue;
        const pl = (d) => A.z[k] + SL[k] * Math.max(rb.dr, Math.min(rb.dl, d)); ZI[k] = pl(OI[k]); ZO[k] = pl(OO[k]); onD[k] = 1; }
      for (let k = 0; k < n;) {
        if (!onB[k] || onD[k]) { k++; continue; }
        const a = k; while (k < n && onB[k] && !onD[k]) k++;
        const ka = a - 1, kb = k, fa = ka >= 0 && Number.isFinite(ZI[ka]) && Number.isFinite(OI[ka]), fb = kb < n && Number.isFinite(ZI[kb]) && Number.isFinite(OI[kb]);
        if (!fa && !fb) continue;
        for (let j = a; j < k; j++) { const t = fa && fb ? (j - ka) / (kb - ka) : fa ? 0 : 1, i0 = fa ? ka : kb, i1 = fb ? kb : ka;
          ZI[j] = ZI[i0] + (ZI[i1] - ZI[i0]) * t; ZO[j] = ZO[i0] + (ZO[i1] - ZO[i0]) * t; }
      }
      // across: the plane, raised to the photo strip where the strip lies higher (at the strip's rows, linear between them as
      // the strip is), so the photo's markings and cars do not show through — also beside the bridges (the terrain's gap
      // under a deck only lies lower); on our deck its plane
      const NN = 2 + OROWS.length, DN = new Float32Array(n * NN), ZN = new Float32Array(n * NN), CN = new Uint8Array(n);
      for (let k = 0; k < n; k++) {
        const oi = OI[k], oo = OO[k]; if (!(oo - oi > 0) || !Number.isFinite(ZI[k] + ZO[k])) continue;
        const o = k * NN; let c = 0;
        const put = (d) => { const pl = ZI[k] + ((ZO[k] - ZI[k]) * (d - oi)) / (oo - oi); DN[o + c] = d; ZN[o + c++] = onD[k] ? pl : Math.max(pl, ctx.surfK(P, k, d, true)); };
        put(oi); for (const d of OROWS) if (d > oi + 0.05 && d < oo - 0.05) put(d); put(oo); CN[k] = c;
      }
      oppZ = (k, d) => { const c = CN[k], o = k * NN; if (!c) return NaN; if (d <= DN[o]) return ZN[o]; for (let i = 1; i < c; i++) if (d <= DN[o + i]) return ZN[o + i - 1] + ((ZN[o + i] - ZN[o + i - 1]) * (d - DN[o + i - 1])) / (DN[o + i] - DN[o + i - 1] || 1); return ZN[o + c - 1]; };
      yield;
      // (quads across at the nodes of both columns, so the strip's rows are in each)
      const oq = (fa, fb, ka, kb) => {
        const ds = []; for (const kk of [ka, kb]) for (let i = 0; i < CN[kk]; i++) ds.push((DN[kk * NN + i] - OI[kk]) / (OO[kk] - OI[kk]));
        ds.sort((p, q) => p - q); const u = ds.filter((v, i) => !i || v - ds[i - 1] > 0.02);
        if (u[0] > 0) u.unshift(0); if (u[u.length - 1] < 1) u.push(1);
        const da = (v) => OI[ka] + (OO[ka] - OI[ka]) * Math.max(0, Math.min(1, v)), db = (v) => OI[kb] + (OO[kb] - OI[kb]) * Math.max(0, Math.min(1, v));
        // (shaded as its plane: the raised nodes would make blotches of the flat quads)
        const p0 = pt(fa, OI[ka], 0, false).slice(), p1 = pt(fb, OI[kb], 0, false).slice(), p2 = pt(fb, OO[kb], 0, false).slice(), p3 = pt(fa, OO[ka], 0, false).slice();
        p0[1] = ZI[ka]; p1[1] = ZI[kb]; p2[1] = ZO[kb]; p3[1] = ZO[ka];
        const ux = p2[0] - p0[0], uy = p2[1] - p0[1], uz = p2[2] - p0[2], vx = p3[0] - p1[0], vy = p3[1] - p1[1], vz = p3[2] - p1[2], nrm = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
        if (!(nrm[1] > 0)) { nrm[0] = 0; nrm[1] = 1; nrm[2] = 0; }
        for (let i = 0; i + 1 < u.length; i++) S.quad(pt(fa, da(u[i]), 0.04, true), pt(fb, db(u[i]), 0.04, true), pt(fb, db(u[i + 1]), 0.04, true), pt(fa, da(u[i + 1]), 0.04, true), ASPHALT_M, nrm);
      };
      for (let j = 0; j < FC.length - 1; j++) { if ((j & 63) === 63) yield; const ka = ki(FC[j]), kb = ki(FC[j + 1]); if (ok(ka) && ok(kb)) oq(FC[j], FC[j + 1], ka, kb); }
      yield;
      const OIf = at(OI), OOf = at(OO), ELf = EL ? at(EL) : null, ERf = ER ? at(ER) : null, mi = (f) => { const v = Lf(f) - (ELf ? ELf(f) : NaN); return Number.isFinite(v) ? Math.max(0.5, Math.min(1.5, v)) : 0.75; };
      const mo = (f) => { const v = (ERf ? ERf(f) : NaN) + Rf(f); return Number.isFinite(v) ? Math.max(0.5, Math.min(3.8, v)) : 2.5; };
      const runs = []; for (let k = 0; k < n; k++) { const g = ok(k); if (g && runs.length && runs[runs.length - 1][1] === k - 1) runs[runs.length - 1][1] = k; else if (g) runs.push([k, k]); }
      for (const [k0, k1] of runs) {
        const a = k0 ? A.s2[k0] : sA, b = k1 === n - 1 ? sB : A.s2[k1]; if (b - a < 20) continue;
        // (its outer edge line no further out than our width between the edge lines: a misread outer edge would put the
        // lane lines a lane off)
        const inner = (f) => OIf(f) + mi(f), outer = (f) => { const o = OOf(f) - mo(f), w = ELf && ERf ? ELf(f) - ERf(f) : NaN; return Number.isFinite(w) && w > 3 ? Math.min(o, inner(f) + w) : o; };
        const km = (k0 + k1) >> 1, nl = A.nl && A.nl[km] > 0 ? A.nl[km] : Math.max(1, Math.min(4, Math.round((outer(km) - inner(km)) / 3.75)));
        line(a, b, inner, 0.30, 0, 0, true); line(a, b, outer, 0.30, 0, 0, true); yield;
        for (let l = 1; l < nl; l++) line(a, b, (f) => inner(f) + ((outer(f) - inner(f)) * l) / nl, 0.15, 6, 12, true);
        yield;
      }
    }
    // zebra crossings (signs 350 of the route, both kerbs at one s): bars 0.5 m wide, 0.5 m apart, 3 m along the road
    const zs = []; for (const q of P.hdr.signs || []) if (q[3] === '350' && !zs.some((z) => Math.abs(z - q[0]) < 6)) zs.push(q[0]);
    for (const sz of zs) {
      if (sz < A.s2[0] + 2 || sz > A.s2[n - 1] - 2) continue;
      const f0 = fOf(sz - 1.5), f1 = fOf(sz + 1.5), fm = fOf(sz);
      for (let d = -Rf(fm) + 0.5; d + 0.5 < Lf(fm) - 0.3; d += 1.0) MK.quad(pt(f0, d, 0.045), pt(f1, d, 0.045), pt(f1, d + 0.5, 0.045), pt(f0, d + 0.5, 0.045), [1, 1, 1]);
    }
  }

  // the roads of a pack within 120 m of the route, one road per call (side(road))
  function sideRoads(P, S, K, MK) {
    const O = ctx.origin(), dx = P.hdr.ox - O.x, dy = P.hdr.oy - O.y, cls = P.hdr.roadc || [], roads = P.hdr.roads || [];
    // newer packs (hdr.tun): a piece flagged as tunnel is drawn except inside the route's tunnels (60 m either side) and on
    // the route's carriageway (a way under it); older packs leave every tunnel piece out. The opposite carriageway (flag 32)
    // is drawn from the median data (routeSurface) where the pack has it
    const tunNew = Array.isArray(P.hdr.tun);
    const inTun = (r) => { const Q = ctx.pack(r.q.p); return !!(Q && Q.tun && Q.tun.some((e) => r.s >= e.t.s0 - 5 && r.s <= e.t.s1 + 5 && Math.abs(r.d) < 60)); };
    const medAt = (r) => { const Q = ctx.pack(r.q.p); return !!(Q && Q.OI && Number.isFinite(Q.OI[r.q.k]) && Number.isFinite(Q.OO[r.q.k])); };
    // our carriageway's edges as drawn (routeSurface; else the pack's measured edges) at a route position
    const edges = (r) => { const Q = ctx.pack(r.q.p), k = r.q.k; return Q && Q.R3L && k < Q.R3L.length ? [Q.R3L[k], Q.R3R[k]] : [r.q.L, r.q.R]; };
    // ... and across the whole dual carriageway where the opposite one is drawn (to its outer edge)
    const outerL = (r, Le) => { const Q = ctx.pack(r.q.p), o = Q && Q.R3OO ? Q.R3OO[r.q.k] : NaN; return Number.isFinite(o) && o > Le ? o : Le; };
    // the route's own deck over a route position (its footprint, 0.6 m beyond its edges), or null
    const ownDeck = (r) => { const Q = ctx.pack(r.q.p), rb = Q && Q.rbk && Q.rbk.get(r.q.k); return rb && rb.on && rb.rel && r.d < (rb.dl ?? 7) + 0.6 && r.d > (rb.dr ?? -7) - 0.6 ? rb : null; };
    // the ground under our deck: the view's 'under' mode where it has one (else it gives the deck's plane back), and the
    // pack's terrain row across the bridge read here (the lower of the two)
    const underZ = (r, rb) => { const Q = ctx.pack(r.q.p), k = r.q.k, zd = ctx.surfR(r, true), sl = Q && Q.SL ? Q.SL[k] : 0;
      return Math.min(ctx.surfR(r, 'under'), zd - sl * Math.max(-45, Math.min(45, r.d)) + rbRelLocal(rb, r.d)); };
    // the drawn photo surface at a route position (one nearest-sample search per point): beyond ±45 m the wide band sinking
    // (over a tunnel: on its lid; no other road runs in the route's tube)
    const zOf = (r, x, y) => { if (!r) return ctx.ground(x, y); const ad = Math.abs(r.d); return ctx.surfR(r, true) - (ad > 45 ? 0.15 + (ad - 45) * 0.004 : 0); };
    // a point running along the route within a tube's walls or 5 m before / after it (a ramp merging at the portal): on the
    // road in the tube, not on its lid
    const tubeRoad = (r, nx, ny) => { const Q = ctx.pack(r.q.p); if (!Q || !Q.tun || Math.abs(r.q.ny * ny + r.q.nx * nx) < 0.7) return false;
      const wall = (v) => Math.max(...[].concat(v ?? 9.5).map((x) => Math.abs(x)));
      return Q.tun.some((e) => r.s >= e.t.s0 - 5 && r.s <= e.t.s1 + 5 && Math.abs(r.d) <= Math.max(wall(e.t.dl), wall(e.t.dr)) + 1); };
    // newer packs clip their pieces to the pack (±10 m): what lies more than 130 m outside the pack's samples is not looked
    // up (the nearest-sample search there is the slow part); older packs give each piece to one pack, drawn whole
    let box = null;
    if (tunNew || P.hdr.xrd) { const A = P.A; box = [Infinity, Infinity, -Infinity, -Infinity]; for (let k = 0; k < P.hdr.n2; k += 5) { const x = A.cen[2 * k] + dx, y = A.cen[2 * k + 1] + dy; if (x < box[0]) box[0] = x; if (y < box[1]) box[1] = y; if (x > box[2]) box[2] = x; if (y > box[3]) box[3] = y; } box[0] -= 130; box[1] -= 130; box[2] += 130; box[3] += 130; }
    const outside = (x, y) => !!box && (x < box[0] || y < box[1] || x > box[2] || y > box[3]);
    // every piece's line binned (25 m), for the markings: none inside another road's footprint (ramps overlapping the
    // carriageway they join, the arms of a junction)
    const GB = 25, grid = new Map(), segs = [];
    roads.forEach(([ci, w10, fl, lv, pts], ri) => {
      if (fl & 32) return; const hw = Math.max(1.25, Math.min(8, (w10 ? w10 / 10 : fl & 16 ? 5 : TYPICAL[cls[ci]] || 4) / 2));
      for (let i = 0; i + 3 < pts.length; i += 2) { const s = [pts[i] / 10 + dx, pts[i + 1] / 10 + dy, pts[i + 2] / 10 + dx, pts[i + 3] / 10 + dy, hw, ri]; segs.push(s);
        for (let gx = Math.floor(Math.min(s[0], s[2]) / GB); gx <= Math.floor(Math.max(s[0], s[2]) / GB); gx++) for (let gy = Math.floor(Math.min(s[1], s[3]) / GB); gy <= Math.floor(Math.max(s[1], s[3]) / GB); gy++) { const key = gx * 100003 + gy; let a = grid.get(key); if (!a) grid.set(key, (a = [])); a.push(segs.length - 1); } }
    });
    const onOther = (x, y, ri) => { const a = grid.get(Math.floor(x / GB) * 100003 + Math.floor(y / GB)); if (!a) return false;
      for (const j of a) { const s = segs[j]; if (s[5] === ri) continue; const vx = s[2] - s[0], vy = s[3] - s[1], l2 = vx * vx + vy * vy || 1, t = Math.max(0, Math.min(1, ((x - s[0]) * vx + (y - s[1]) * vy) / l2)); if (Math.hypot(x - s[0] - vx * t, y - s[1] - vy * t) < s[4] - 0.2) return true; } return false; };
    let ri = -1;
    return ([ci, w10, fl, lv, pts]) => {
      ri++;
      if ((fl & 2) && !tunNew) return;                                    // tunnels (older packs)
      const c = cls[ci] || 'unknown', link = fl & 16, unpaved = fl & 8, raised = (fl & 1) || lv > 0;
      let W = w10 ? w10 / 10 : (link ? 5.0 : TYPICAL[c] || 4.0); W = Math.max(2.5, Math.min(16, W));
      // resampled to ≤ 3 m, each point with its normal: mitred at the vertices (at most 1.5 × the width), split where the line
      // turns by more than 60° (the two ends joined by a quad; a mitre there would fold the ribbon over)
      const P0 = []; for (let i = 0; i + 1 < pts.length; i += 2) { const x = pts[i] / 10 + dx, y = pts[i + 1] / 10 + dy; if (!P0.length || Math.hypot(x - P0[P0.length - 1][0], y - P0[P0.length - 1][1]) > 0.05) P0.push([x, y]); }
      if (P0.length < 2) return;
      const T = []; for (let i = 0; i + 1 < P0.length; i++) { const tx = P0[i + 1][0] - P0[i][0], ty = P0[i + 1][1] - P0[i][1], l = Math.hypot(tx, ty) || 1; T.push([tx / l, ty / l]); }
      const Q = [], N = [];
      for (let i = 0; i < P0.length; i++) {
        if (i === 0 || i === P0.length - 1) { const t = T[Math.min(i, T.length - 1)]; Q.push(P0[i]); N.push([-t[1], t[0]]); }
        else {
          const a = T[i - 1], b = T[i], cs = a[0] * b[0] + a[1] * b[1];
          if (cs < 0.5) { Q.push(P0[i], P0[i]); N.push([-a[1], a[0]], [-b[1], b[0]]); }
          else { let nx = -(a[1] + b[1]), ny = a[0] + b[0]; const l = Math.hypot(nx, ny) || 1, sc = Math.min(1.5, 1 / Math.max(0.1, Math.sqrt((1 + cs) / 2))); Q.push(P0[i]); N.push([(nx / l) * sc, (ny / l) * sc]); }
        }
        if (i + 1 < P0.length) { const [ax, ay] = P0[i], [bx, by] = P0[i + 1], m = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 3)), t = T[i]; for (let j = 1; j < m; j++) { Q.push([ax + ((bx - ax) * j) / m, ay + ((by - ay) * j) / m]); N.push([-t[1], t[0]]); } }
      }
      // per point: the route's position (lateral, our drawn edges), whether on an overpass deck, under our own deck, the
      // height at the centre and at both edges (zr right, zl left: the ribbon follows the surface across)
      let prev = null;
      const info = Q.map(([x, y], i) => {
        if (prev && prev.x === x && prev.y === y) { const o = { ...prev.o }; prev = { x, y, o }; return o; }
        let o;
        if (outside(x, y)) o = { inR: false, deck: null, skip: true, z: 0, zl: 0, zr: 0 };
        else {
          const r = ctx.toRoute(x, y), deck = raised ? ctx.onDeck(x, y, 1.5) : null;
          if (!r) { const z = ctx.ground(x, y); o = { inR: false, deck, skip: false, z, zl: z, zr: z, r: null }; }
          else {
            const [Le, Re] = edges(r), Lo = outerL(r, Le), inR = r.d < Lo + 0.8 && r.d > -(Re + 0.8);
            const skip = ((fl & 2) && (inR || inTun(r))) || ((fl & 32) && medAt(r));
            const q = r.q, nx = N[i][0], ny = N[i][1], cn = nx * q.nx + ny * q.ny, cs = nx * q.ny - ny * q.nx;
            // (a piece flagged bridge / raised is on a deck: on ours where it runs along it, else it crosses under it — a small
            // bridge over a stream below our viaduct)
            const low = !raised || Math.abs(cn) < 0.8, tube = tunNew && tubeRoad(r, nx, ny), und = low && !tube ? ownDeck(r) : null;
            const zAt = (e) => { const rr = e ? { s: r.s + e * cs, d: r.d + e * cn, q } : r; if (tube) return ctx.surfR(rr, 'road'); const rb = low && ownDeck(rr); return rb ? underZ(rr, rb) : zOf(rr, x + nx * e, y + ny * e); };
            o = { inR, deck, skip, under: !!und, od: !!ownDeck(r), z: zAt(0), zl: zAt(W / 2), zr: zAt(-W / 2), d: r.d, cn, Le: Lo, Re, Lc: Le, par: Math.abs(cn) > 0.94 };
          }
        }
        prev = { x, y, o }; return o;
      });
      if (info.every((q) => q.skip)) return;
      // a piece running along our carriageway within 5 m of its edge (a ramp merging, a second mapping of the carriageway):
      // its asphalt and markings are ours there
      const along = (q) => q.d != null && !q.under && q.par && (q.d > 0 ? q.d - q.Lc : -q.d - q.Re) < Math.max(5, W / 2 + 1.5);
      for (const q of info) q.drop = q.skip || along(q);
      const col = unpaved ? GRAVEL : c === 'motorway' ? ASPHALT_M : ASPHALT;
      // a point at fraction t from Q[i] to Q[i + 1], lateral e (left +), lifted; its height between the edge heights
      const P3 = (i, t, e, lift) => { const a = info[i], b = info[i + 1], u = Math.max(0, Math.min(1, e / W + 0.5));
        const za = a.zr + (a.zl - a.zr) * u, zb = b.zr + (b.zl - b.zr) * u;
        return [Q[i][0] + (Q[i + 1][0] - Q[i][0]) * t + (N[i][0] + (N[i + 1][0] - N[i][0]) * t) * e, za + (zb - za) * t + lift, -(Q[i][1] + (Q[i + 1][1] - Q[i][1]) * t + (N[i][1] + (N[i + 1][1] - N[i][1]) * t) * e)]; };
      // the part of a piece's edge (e) outside our carriageway (to 0.2 m inside its edge: our asphalt covers the rest, no
      // seam between them): [t0, t1] or null
      const outPart = (i, e) => {
        const a = info[i], b = info[i + 1]; if (a.d == null || b.d == null || a.under || b.under) return [0, 1];
        const d0 = a.d + e * a.cn, d1 = b.d + e * b.cn, in0 = d0 < a.Le - 0.2 && d0 > -(a.Re - 0.2), in1 = d1 < b.Le - 0.2 && d1 > -(b.Re - 0.2);
        if (!in0 && !in1) return [0, 1]; if (in0 && in1) return null;
        const dOut = in0 ? d1 : d0, bnd = dOut > 0 ? (in0 ? a : b).Le - 0.2 : -((in0 ? a : b).Re - 0.2), t = Math.max(0, Math.min(1, (bnd - d0) / ((d1 - d0) || 1e-6)));
        return in0 ? [t, 1] : [0, t];
      };
      const lift = 0.02;
      for (let i = 0; i < Q.length - 1; i++) {
        if (info[i].drop || info[i + 1].drop) continue;
        if (info[i].deck != null || info[i + 1].deck != null) continue;      // the overpass deck carries its own road
        const pr0 = outPart(i, -W / 2), pl0 = outPart(i, W / 2); if (!pr0 && !pl0) continue; const pr = pr0 || pl0, pl = pl0 || pr0;
        S.quad(P3(i, pr[0], -W / 2, lift), P3(i, pr[1], -W / 2, lift), P3(i, pl[1], W / 2, lift), P3(i, pl[0], W / 2, lift), col);
        // a small bridge (over a stream, a track): parapets on both edges — only where that edge lies outside our carriageway,
        // and not on our own deck (its parapets are its own; a wall across our lanes there was a piece under the bridge)
        if ((fl & 1) && !info[i].od && !info[i + 1].od) for (const sg of [1, -1]) {
          const rg = sg > 0 ? pl0 : pr0; if (!rg || rg[1] - rg[0] < 0.02) continue;
          const e = sg * (W / 2 + 0.25), a0 = P3(i, rg[0], e, 0), a1 = P3(i, rg[1], e, 0), b0 = P3(i, rg[0], e, 0.9), b1 = P3(i, rg[1], e, 0.9);
          if (sg > 0) K.quad(a0, a1, b1, b0, PARAPET); else K.quad(a1, a0, b0, b1, PARAPET);
          const t0 = P3(i, rg[0], e - 0.15 * sg, 0.9), t1 = P3(i, rg[1], e - 0.15 * sg, 0.9); if (sg > 0) K.quad(b0, b1, t1, t0, RAIL); else K.quad(b1, b0, t0, t1, RAIL);
        }
      }
      if (unpaved || ['service', 'track', 'living_street'].includes(c)) return;
      // a roundabout's ring (the piece on a ring of the pack's pieces): no centre line
      const RB = roundabouts(P, dx, dy), ring = RB.some(([ux, uy, r]) => P0.every(([x, y]) => Math.abs(Math.hypot(x - ux, y - uy) - r) < 3));
      // markings: not inside the route's carriageway, not under our deck, not across another road's footprint
      const seg = (d, w, on, off_) => {
        let acc = 0;
        for (let i = 0; i < Q.length - 1; i++) {
          const l = Math.hypot(Q[i + 1][0] - Q[i][0], Q[i + 1][1] - Q[i][1]), a = acc; acc += l; if (l < 1e-3) continue;
          const A_ = info[i], B_ = info[i + 1];
          if (A_.inR || B_.inR || A_.drop || B_.drop || A_.under || B_.under || A_.deck != null || B_.deck != null) continue;
          const draw = (t0, t1) => { const ps = [P3(i, t0, d - w / 2, 0.03), P3(i, t1, d - w / 2, 0.03), P3(i, t1, d + w / 2, 0.03), P3(i, t0, d + w / 2, 0.03)];
            if (ps.some((p) => onOther(p[0], -p[2], ri))) return; MK.quad(ps[0], ps[1], ps[2], ps[3], [1, 1, 1]); };
          if (!on) { draw(0, 1); continue; }
          // (every dash overlapping this piece of the line, also one begun on the piece before: dashes run over the 3 m pieces)
          const per = on + off_;
          for (let u = Math.floor((a - on) / per + 1) * per; u < acc; u += per) { const t0 = Math.max(0, (u - a) / l), t1 = Math.min(1, (u + on - a) / l); if (t1 > t0) draw(t0, t1); }
        }
      };
      const oneway = fl & 4;
      if (c === 'motorway' || c === 'trunk') {
        if (link) { seg(W / 2 - 0.4, 0.2, 0, 0); seg(-W / 2 + 0.4, 0.2, 0, 0); }
        else { seg(W / 2 - 0.5, 0.25, 0, 0); seg(-W / 2 + 2.0, 0.25, 0, 0); if (W >= 9) seg((W / 2 - 0.5 + (-W / 2 + 2.0)) / 2, 0.15, 6, 12); }
      } else if (!oneway && !ring && W >= 5.5 && !link && ['primary', 'secondary', 'tertiary', 'unclassified'].includes(c)) seg(0, 0.12, 4, 8);
    };
  }

  return {
    // a pack's roads in steps of about ms milliseconds (the route's carriageway first, then the side roads): step() returns
    // true when done, meshes() then gives them; the times spent are in stats
    job(P, ms = 4) {
      const S = new Buf(true), K = new Buf(), MK = new Buf(), roads = P.hdr.roads || [], stats = { route: 0, side: 0 };
      let i = -1, side = null; const it = routeSurface(P, S, K, MK);
      return {
        stats,
        step() {
          const t0 = performance.now();
          while (i < 0) {
            const tq = performance.now(); let done = true; try { done = it.next().done; } catch (e) { console.warn('route surface', P.hdr.p, e); }
            stats.route += performance.now() - tq;
            if (done) { i = 0; side = sideRoads(P, S, K, MK); }
            if (performance.now() - t0 > ms * 0.5) return i >= 0 && !roads.length;
          }
          const t1 = performance.now();
          while (i < roads.length && performance.now() - t0 < ms) { try { side(roads[i]); } catch (e) { console.warn('side road', P.hdr.p, e); } i++; }
          stats.side += performance.now() - t1;
          return i >= roads.length;
        },
        meshes() {
          const out = [];
          const s = S.mesh(M.surf); if (s) { s.receiveShadow = true; s.renderOrder = 1; out.push(s); }
          const k = K.mesh(M.solid); if (k) { k.receiveShadow = true; k.castShadow = true; out.push(k); }
          const m = MK.mesh(M.mark); if (m) { m.receiveShadow = true; m.renderOrder = 2; out.push(m); }
          return out;
        },
      };
    },
    build(P) { const j = this.job(P, Infinity); while (!j.step()); return j.meshes(); },
  };
}

// The passage views: asphalt over the carriageway traced on the aerial photo (rings, outer and holes by winding) and the
// markings of the mapped roads (lines: {pts, hw, cls, oneway, unpaved, town}) where they run on it. z(x, y): the drawn ground.
export function areaRoads(rings, lines, z, inside, surfMat = null, deckMat = null, level = null) {
  const it = areaRoadsSteps(rings, lines, z, inside, surfMat, deckMat, level); let st; while (!(st = it.next()).done); return st.value;
}
// the same, step by step (a generator: the caller may stop between steps and go on later; it returns the meshes)
export function* areaRoadsSteps(rings, lines, z, inside, surfMat = null, deckMat = null, level = null) {
  const M = materials(), MK = new Buf();
  const area = (r) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]); return a / 2; };
  const inRing = (r, x, y) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
  const outer = rings.filter((r) => r.length >= 3 && area(r) < 0), holes = rings.filter((r) => r.length >= 3 && area(r) >= 0);
  const ol = outer.length ? outer : rings.filter((r) => r.length >= 3);
  const tri = [];
  for (const r of ol) {
    yield;
    const hs = (outer.length ? holes : []).filter((h) => inRing(r, h[0][0], h[0][1]));
    const pts = r.concat(...hs), T = THREE.ShapeUtils.triangulateShape(r.map(([x, y]) => new THREE.Vector2(x, y)), hs.map((h) => h.map(([x, y]) => new THREE.Vector2(x, y))));
    for (const [a, b, c] of T) tri.push([pts[a], pts[b], pts[c]]);
  }
  // the mapped lines binned (25 m): the class of the road a point lies on, markings not across another road's footprint
  const segs = []; lines.forEach((L, li) => { for (let i = 0; i + 1 < L.pts.length; i++) segs.push([L.pts[i][0], L.pts[i][1], L.pts[i + 1][0], L.pts[i + 1][1], L.hw, li]); });
  const grid = new Map(), G = 25; segs.forEach((s, k) => { for (let gx = Math.floor(Math.min(s[0], s[2]) / G) - 1; gx <= Math.floor(Math.max(s[0], s[2]) / G) + 1; gx++) for (let gy = Math.floor(Math.min(s[1], s[3]) / G) - 1; gy <= Math.floor(Math.max(s[1], s[3]) / G) + 1; gy++) { const key = gx * 100003 + gy; let a = grid.get(key); if (!a) grid.set(key, (a = [])); a.push(k); } });
  const dSeg = (s, x, y) => { const vx = s[2] - s[0], vy = s[3] - s[1], l2 = vx * vx + vy * vy || 1, tt = Math.max(0, Math.min(1, ((x - s[0]) * vx + (y - s[1]) * vy) / l2)); return Math.hypot(x - s[0] - vx * tt, y - s[1] - vy * tt); };
  // a marking of line li heading (ux, uy) at (x, y): across another road's footprint (a junction), or on a way mapped twice
  // side by side (a parallel line within 2.5 m: the markings of the higher class, else the first, are drawn)
  const RANK = { motorway: 7, trunk: 6, primary: 5, secondary: 4, tertiary: 3, unclassified: 2, residential: 1 };
  const onOther = (x, y, li, ux, uy) => { const a = grid.get(Math.floor(x / G) * 100003 + Math.floor(y / G)); if (!a) return false;
    for (const k of a) { const s = segs[k]; if (s[5] === li || lines[s[5]].cls === 'rail') continue;
      const vx = s[2] - s[0], vy = s[3] - s[1], vl = Math.hypot(vx, vy) || 1, par = Math.abs((vx * ux + vy * uy) / vl) > 0.9, d = dSeg(s, x, y);
      if (!par) { if (d < s[4] + 0.5) return true; continue; }
      const ro = RANK[lines[s[5]].cls] || 0, rm = RANK[lines[li].cls] || 0;
      if (d < 2.5 && (ro > rm || (ro === rm && s[5] < li))) return true; }
    return false; };
  // gravel where the nearest mapped way (beyond its half-width less) is a track or unpaved, no paved road within its own
  const PAVEDX = new Set(['rail', 'footway', 'path', 'cycleway', 'steps', 'pedestrian']);
  const gravelAt = (x, y) => { const a = grid.get(Math.floor(x / G) * 100003 + Math.floor(y / G)); if (!a) return false; let g = false;
    for (const k of a) { const s = segs[k], L = lines[s[5]]; if (PAVEDX.has(L.cls)) continue; const d = dSeg(s, x, y);
      if (!L.unpaved) { if (d < 1.4 * s[4] + 3) return false; continue; }      // (a paved road's asphalt reaches past its typical width)
      if (d < s[4] + 1) g = true; } return g; };
  // split large triangles so the surface follows the terrain (edges ≤ 6 m): an edge is halved by its length alone, so the
  // triangles on both sides of it split it alike (no cracks at T-joints where the heights differ)
  const out = [];
  const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const len = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const split = (a, b, c, depth) => {
    const sab = len(a, b) > 6, sbc = len(b, c) > 6, sca = len(c, a) > 6, ns = sab + sbc + sca;
    if (!ns || depth > 10) { out.push([a, b, c]); return; }
    const D = depth + 1;
    if (ns === 3) { const m1 = mid(a, b), m2 = mid(b, c), m3 = mid(c, a); split(a, m1, m3, D); split(m1, b, m2, D); split(m3, m2, c, D); split(m1, m2, m3, D); return; }
    // (rotate so the split edges come first: ab, or ab and bc)
    if (ns === 1) { if (sab) { const m = mid(a, b); split(a, m, c, D); split(m, b, c, D); } else if (sbc) { const m = mid(b, c); split(b, m, a, D); split(m, c, a, D); } else { const m = mid(c, a); split(c, m, b, D); split(m, a, b, D); } return; }
    const [p, q, r] = !sca ? [a, b, c] : !sab ? [b, c, a] : [c, a, b];          // p-q and q-r split, r-p not
    const m1 = mid(p, q), m2 = mid(q, r); split(m1, q, m2, D); split(p, m1, m2, D); split(p, m2, r, D);
  };
  for (const [a, b, c] of tri) { split(a, b, c, 0); yield; }
  const zc = new Map(), Z = (p) => { const k = p[0].toFixed(2) + ',' + p[1].toFixed(2); let v = zc.get(k); if (v == null) zc.set(k, (v = z(p[0], p[1]) + 0.05)); return v; };
  // two levels: the road on the ground and the carriageways on bridge decks (a triangle reaching from one to the other,
  // at a deck's edge, is left out)
  const lv = [{ pos: [], uv: [], col: [] }, { pos: [], uv: [], col: [] }];
  for (const [a, b, c] of out) {
    yield;
    // keep the winding facing up
    const cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); const [p, q, r] = cr > 0 ? [a, b, c] : [a, c, b];
    const zs = [Z(p), Z(q), Z(r)]; if (Math.max(...zs) - Math.min(...zs) > 1.2) continue;
    const cx = (p[0] + q[0] + r[0]) / 3, cy = (p[1] + q[1] + r[1]) / 3, up = level && level(cx, cy);
    if (up && !deckMat) continue;                     // a bridge deck has its own surface: only the markings go on it
    const L = lv[up ? 1 : 0], col = gravelAt(cx, cy) ? GRAVEL : ASPHALT;
    [p, q, r].forEach((v, i) => { L.pos.push(v[0], zs[i], -v[1]); L.uv.push(v[0] / 4, -v[1] / 4); L.col.push(...col); });
  }
  const meshes = [];
  lv.forEach((L, i) => { if (!L.pos.length) return; const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(L.pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(L.uv, 2)); g.setAttribute('color', new THREE.Float32BufferAttribute(L.col, 3)); g.computeVertexNormals();
    const m = new THREE.Mesh(g, (i ? deckMat : surfMat) || surfMat || M.surf); m.receiveShadow = true; m.renderOrder = 1; meshes.push(m); });
  // markings along the mapped roads where they run on the traced carriageway, not across another road (a junction): laid
  // on the traced asphalt (its middle and its edges found across the mapped line, 0.25 m steps; the mapped line is often a
  // metre or two off), edge lines 0.3 m inside it, the centre line on two-way roads (3 / 6 m in towns, else 6 / 12 m)
  for (const [li, L] of lines.entries()) {
    yield;
    const c = L.cls; if (L.unpaved || !['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential'].includes(c)) continue;
    const W = 2 * L.hw; if (W < 5.5) continue;
    const Q = []; for (let i = 0; i < L.pts.length - 1; i++) { const [ax, ay] = L.pts[i], [bx, by] = L.pts[i + 1], l = Math.hypot(bx - ax, by - ay), m = Math.max(1, Math.ceil(l / 2)); for (let j = 0; j < m; j++) Q.push([ax + (bx - ax) * j / m, ay + (by - ay) * j / m]); }
    if (L.pts.length) Q.push(L.pts[L.pts.length - 1]);
    const N = Q.map((_, i) => { const a = Q[Math.max(0, i - 1)], b = Q[Math.min(Q.length - 1, i + 1)]; const tx = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tx, ty) || 1; return [-ty / l, tx / l]; });
    // the traced asphalt across each point: [left, right] offsets (NaN where the point is not on it or the width found is
    // far from the mapped one: a junction, a lay-by), smoothed along the line (median of 5)
    const ext = Q.map(([x, y], i) => { if (!inside(x, y)) return [NaN, NaN]; const [nx, ny] = N[i], lim = L.hw * 1.8 + 2; let a = 0, b = 0;
      while (a < lim && inside(x + nx * (a + 0.25), y + ny * (a + 0.25))) a += 0.25; while (b < lim && inside(x - nx * (b + 0.25), y - ny * (b + 0.25))) b += 0.25;
      return a >= lim || b >= lim || a + b < W * 0.6 || a + b > W * 1.7 ? [NaN, NaN] : [a, -b]; });
    // (median over 9 points, gaps up to 40 m carried across, then a mean over 7: the traced edge is ragged at the scale of
    // the photo's pixels and shadows; the lines on it run smooth)
    const sm = (j) => {
      const n = ext.length, m = ext.map((_, i) => { const v = []; for (let k = Math.max(0, i - 4); k <= Math.min(n - 1, i + 4); k++) if (Number.isFinite(ext[k][j])) v.push(ext[k][j]); v.sort((p, q) => p - q); return v.length >= 3 ? v[v.length >> 1] : NaN; });
      for (let i = 0; i < n;) { if (Number.isFinite(m[i])) { i++; continue; } let b = i; while (b < n && !Number.isFinite(m[b])) b++;
        if (i > 0 && b < n && b - i <= 20) for (let k = i; k < b; k++) m[k] = m[i - 1] + ((m[b] - m[i - 1]) * (k - i + 1)) / (b - i + 1); i = b; }
      return m.map((_, i) => { let a = 0, c = 0; for (let k = Math.max(0, i - 3); k <= Math.min(n - 1, i + 3); k++) if (Number.isFinite(m[k])) { a += m[k]; c++; } return Number.isFinite(m[i]) && c ? a / c : NaN; });
    };
    const EL = sm(0), ER = sm(1);
    const offs = (kind) => (i) => { const l = EL[i], r = ER[i]; if (!Number.isFinite(l) || !Number.isFinite(r)) return kind === 0 ? 0 : kind > 0 ? L.hw - 0.3 : -L.hw + 0.3; return kind === 0 ? (l + r) / 2 : kind > 0 ? l - 0.3 : r + 0.3; };
    const line = (off, w, on, offL) => {
      let acc = 0;
      for (let i = 0; i < Q.length - 1; i++) {
        const l = Math.hypot(Q[i + 1][0] - Q[i][0], Q[i + 1][1] - Q[i][1]), a0 = acc; acc += l; if (l < 1e-3) continue;
        const d0 = off(i), d1 = off(i + 1);
        const P = (t, e) => { const dd = d0 + (d1 - d0) * t + e, x = Q[i][0] + (Q[i + 1][0] - Q[i][0]) * t + N[i][0] * dd, y = Q[i][1] + (Q[i + 1][1] - Q[i][1]) * t + N[i][1] * dd; return [x, y]; };
        const ux = (Q[i + 1][0] - Q[i][0]) / l, uy = (Q[i + 1][1] - Q[i][1]) / l;
        const draw = (t0, t1) => { const ps = [P(t0, -w / 2), P(t1, -w / 2), P(t1, w / 2), P(t0, w / 2)]; if (!ps.every(([x, y]) => inside(x, y)) || ps.some(([x, y]) => onOther(x, y, li, ux, uy))) return; const zz = ps.map(([x, y]) => z(x, y)); if (Math.max(...zz) - Math.min(...zz) > 0.8) return; MK.quad(...ps.map(([x, y], i) => [x, zz[i] + 0.07, -y]), [1, 1, 1]); };
        if (!on) { draw(0, 1); continue; }
        // (every dash overlapping this 2 m piece, also one begun on the piece before)
        for (let u = Math.floor((a0 - on) / (on + offL) + 1) * (on + offL); u < acc; u += on + offL) { const t0 = Math.max(0, (u - a0) / l), t1 = Math.min(1, (u + on - a0) / l); if (t1 > t0) draw(t0, t1); }
      }
    };
    if (!L.oneway && c !== 'residential' && c !== 'motorway') line(offs(0), 0.12, L.town ? 3 : 6, L.town ? 6 : 12);
    if (c !== 'residential') { line(offs(1), 0.12, 0, 0); line(offs(-1), 0.12, 0, 0); }
  }
  const mm = MK.mesh(M.mark); if (mm) { mm.renderOrder = 2; meshes.push(mm); }
  return meshes;
}
