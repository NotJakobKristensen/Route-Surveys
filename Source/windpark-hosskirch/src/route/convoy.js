// The blade convoy at true size, as the V172 blades travel: an 8×4 heavy-haul tractor, the two-axle jeep dolly with the
// lifting root adapter (the blade root bolted into a steel root frame, held on a turntable), the blade itself as the
// middle of the vehicle, carried trailing edge up and leading edge down, and the four-axle remote-steered rear dolly with
// the friction clamp under the leading edge; a BF4 escort ahead and the BF3 behind (it steers the rear dolly).
// Dimensions from the user's vehicle (vehicle.js): the blade is turned about its axis so its widest plan width is the
// user's 'widest chord', lifted so its highest point is the user's transport height, and bent so its underside at the
// rear support and at the tip are the user's values. Wheels turn with the distance driven and steer with the path.
// Posed from the swept-path model: [front axle, rear axle, front support, blade root, blade tip, dolly centre, dolly
// front] (x, y each).
import * as THREE from 'three';
import { patch } from '../env.js';
import { DEFAULTS } from './vehicle.js';
import { NP, section, ext, bladeFrame } from './blade.js';

// ---------------------------------------------------------------- colours (sRGB hex → linear vertex colours)
const C = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
const CAB = C(0xf1f2ef), CAB2 = C(0x2b2f33), ACCENT = C(0xe06a10), CHASSIS = C(0x202224), BLACK = C(0x111213), DARK = C(0x36393c),
  GLASS = C(0x16202a), CHROME = C(0xc4c8cc), ALU = C(0xaab0b5), RIM = C(0xc9ccce), TYRE = C(0x18181a), LAMP = C(0xf2efe4), RED = C(0xc0141b),
  AMBER = C(0xff9a1a), YELLOW = C(0xf2b705), SULFUR = C(0xf3e05a), FRAME = C(0x33373b), STEEL = C(0x7b8085), GALV = C(0xa3a8ac),
  WHITE = C(0xf5f5f2), PLATE = C(0xf3f3ee), EUBLUE = C(0x0f3a8f), RUBBER = C(0x232425), STRAP = C(0xf0a800), ROD = C(0xdfe3e6),
  HOSE_B = C(0x1b5fd1), BLADE = C(0xcbd0cc), BLADE_LE = C(0xb8bdbb), BRED = C(0xb5141c), BULK = C(0x6b6e6c);

function paint(g, c) {
  const n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set(c, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(a, 3)); return g;
}
function merge(list) {
  const geos = list.filter(Boolean).map((g) => { if (!g.attributes.normal) g.computeVertexNormals(); return g.index ? g.toNonIndexed() : g; });
  let n = 0; for (const g of geos) n += g.attributes.position.count;
  const P = new Float32Array(n * 3), N = new Float32Array(n * 3), Cc = new Float32Array(n * 3);
  let o = 0;
  for (const g of geos) {
    P.set(g.attributes.position.array, o * 3); N.set(g.attributes.normal.array, o * 3); Cc.set(g.attributes.color.array, o * 3);
    o += g.attributes.position.count;
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.BufferAttribute(P, 3)); m.setAttribute('normal', new THREE.BufferAttribute(N, 3)); m.setAttribute('color', new THREE.BufferAttribute(Cc, 3));
  m.computeBoundingSphere();
  return m;
}
// ---------------------------------------------------------------- geometry helpers (part frames: +z forward, x across, y up)
const box = (w, h, l, x, y, z, col) => paint(new THREE.BoxGeometry(w, h, l).translate(x, y, z), col);
function cyl(r0, r1, h, x, y, z, col, seg = 16, axis = 'y') {
  const g = new THREE.CylinderGeometry(r0, r1, h, seg);
  if (axis === 'x') g.rotateZ(Math.PI / 2); if (axis === 'z') g.rotateX(Math.PI / 2);
  return paint(g.translate(x, y, z), col);
}
// a bar (square, or round) of thickness t between two points
function strut(a, b, t, col, round = false) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), d = B.clone().sub(A), l = d.length();
  const g = round ? new THREE.CylinderGeometry(t / 2, t / 2, l, 10) : new THREE.BoxGeometry(t, l, t);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  const m = A.add(B).multiplyScalar(0.5); return paint(g.translate(m.x, m.y, m.z), col);
}
// rounded rectangle (w across x, l along z) extruded from y0 to y1
function rbox(w, l, y0, y1, r, x, z, col, bevel = 0.02) {
  const s = new THREE.Shape(), hw = w / 2 - bevel, hl = l / 2 - bevel, rr = Math.max(0.001, Math.min(r, hw, hl));
  s.moveTo(-hw + rr, -hl); s.lineTo(hw - rr, -hl); s.quadraticCurveTo(hw, -hl, hw, -hl + rr); s.lineTo(hw, hl - rr); s.quadraticCurveTo(hw, hl, hw - rr, hl);
  s.lineTo(-hw + rr, hl); s.quadraticCurveTo(-hw, hl, -hw, hl - rr); s.lineTo(-hw, -hl + rr); s.quadraticCurveTo(-hw, -hl, -hw + rr, -hl);
  const g = new THREE.ExtrudeGeometry(s, { depth: Math.max(0.01, y1 - y0 - 2 * bevel), bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 5 });
  g.rotateX(-Math.PI / 2); g.translate(x, y0 + bevel, z);
  g.deleteAttribute('uv');
  return paint(g, col);
}
// loft of rounded rectangles across x–y at stations along z: [{z, w, y0, y1, r}]; smooth sides, flat caps
function loftRR(sec, col, seg = 4) {
  const ring = (S) => {
    const pts = [], hw = S.w / 2, cy = (S.y0 + S.y1) / 2, hh = (S.y1 - S.y0) / 2, r = Math.min(S.r, hw - 0.001, hh - 0.001);
    const corners = [[hw - r, hh - r, 0], [-hw + r, hh - r, Math.PI / 2], [-hw + r, -hh + r, Math.PI], [hw - r, -hh + r, Math.PI * 1.5]];
    for (const [cx, cyy, a0] of corners) for (let k = 0; k <= seg; k++) { const a = a0 + (k / seg) * (Math.PI / 2); pts.push([cx + Math.cos(a) * r, cy + cyy + Math.sin(a) * r]); }
    return pts;
  };
  const R = sec.map(ring), m = R[0].length, pos = [], idx = [];
  sec.forEach((S, s) => R[s].forEach((p) => pos.push(p[0], p[1], S.z)));
  for (let s = 0; s + 1 < sec.length; s++) for (let k = 0; k < m; k++) {
    const k2 = (k + 1) % m, a = s * m + k, b = s * m + k2, c = (s + 1) * m + k2, d = (s + 1) * m + k;
    idx.push(a, b, c, a, c, d);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  const caps = [];
  for (const [si, back] of [[0, true], [sec.length - 1, false]]) {
    const r = R[si], z = sec[si].z, cy = (sec[si].y0 + sec[si].y1) / 2;
    for (let k = 0; k < m; k++) { const a = r[k], b = r[(k + 1) % m]; if (back) caps.push(0, cy, z, b[0], b[1], z, a[0], a[1], z); else caps.push(0, cy, z, a[0], a[1], z, b[0], b[1], z); }
  }
  const cg = new THREE.BufferGeometry(); cg.setAttribute('position', new THREE.Float32BufferAttribute(caps, 3)); cg.computeVertexNormals();
  return merge([paint(g, col), paint(cg, col)]);
}
// a tyre (rounded section) with its rim, hub and nuts, axle along x, centred at (x, y, z)
function tyreGeo(r, w, x, y, z, seg = 26, inner = false) {
  const pr = [], sw = w / 2, rr = Math.min(0.07, w * 0.24), ri = r * 0.6;
  pr.push(new THREE.Vector2(ri, -sw * 0.92));
  for (let k = 0; k <= 4; k++) { const a = -Math.PI / 2 + (k / 4) * (Math.PI / 2); pr.push(new THREE.Vector2(r - rr + Math.cos(a) * rr, -sw + rr + Math.sin(a) * rr)); }
  for (let k = 0; k <= 4; k++) { const a = (k / 4) * (Math.PI / 2); pr.push(new THREE.Vector2(r - rr + Math.cos(a) * rr, sw - rr + Math.sin(a) * rr)); }
  pr.push(new THREE.Vector2(ri, sw * 0.92));
  const t = new THREE.LatheGeometry(pr, seg); t.rotateZ(Math.PI / 2); t.translate(x, y, z); t.deleteAttribute('uv'); paint(t, TYRE);
  const out = [t];
  const side = Math.sign(x) || 1, face = x + side * sw * (inner ? -0.2 : 0.55);
  out.push(cyl(ri * 1.01, ri * 1.01, w * 0.9, x, y, z, RIM, seg, 'x'));
  out.push(cyl(ri * 0.82, ri * 0.82, 0.02, face, y, z, inner ? DARK : RIM, seg, 'x'));
  out.push(cyl(ri * 0.36, ri * 0.42, 0.08, face + side * 0.03, y, z, CHROME, 12, 'x'));
  for (let k = 0; k < 10; k++) { const a = (k / 10) * Math.PI * 2; out.push(cyl(0.022, 0.022, 0.05, face + side * 0.03, y + Math.cos(a) * ri * 0.3, z + Math.sin(a) * ri * 0.3, CHROME, 6, 'x')); }
  // the rim's openings, so the turning reads
  for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2, b = new THREE.BoxGeometry(0.025, ri * 0.13, ri * 0.4); b.translate(0, ri * 0.62, 0); b.rotateX(a); b.translate(face + side * 0.012, y, z); out.push(paint(b, DARK)); }
  return out;
}
// the wheels of one side of an axle (single or twin), centred at the origin so they spin about their own axle
// (made once per size and kept: a convoy has some 30 wheel sets of a few sizes, and every change of the vehicle rebuilt them)
const WHEELS = new Map();
function wheelSetGeo(r, w, dual, side) {
  const k = `${r}|${w}|${dual}|${side}`; let g = WHEELS.get(k); if (g) return g;
  g = !dual ? merge(tyreGeo(r, w, side * 0.001, 0, 0)) : merge([...tyreGeo(r, w, side * (w / 2 + 0.02), 0, 0), ...tyreGeo(r, w, -side * (w / 2 + 0.02), 0, 0, 26, true)]);
  g.userData.keep = true; WHEELS.set(k, g); return g;
}
// a polygon clipped to the rectangle |x| ≤ w/2, |y| ≤ h/2 (Sutherland–Hodgman)
function clipRect(poly, w, h) {
  for (const [a, b, c] of [[1, 0, w / 2], [-1, 0, w / 2], [0, 1, h / 2], [0, -1, h / 2]]) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const P = poly[i], Q = poly[(i + 1) % poly.length], dp = a * P[0] + b * P[1] - c, dq = a * Q[0] + b * Q[1] - c;
      if (dp <= 0) out.push(P);
      if ((dp <= 0) !== (dq <= 0)) { const t = dp / (dp - dq); out.push([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t]); }
    }
    poly = out; if (poly.length < 3) return [];
  }
  return poly;
}
// a warning board (DIN 30710: red and white stripes at 45°, 141 mm wide), facing +z (face −1: facing −z), both sides striped
function warnBoard(w, h, x, y, z, face = 1) {
  const g = [box(w, h, 0.03, 0, 0, 0, WHITE)], d = 0.2;
  for (let u = -w / 2 - h / 2 - d, i = 0; u < w / 2 + h / 2; u += d, i++) {
    if (i % 2) continue;
    const poly = clipRect([[u - 10, -10], [u + 10, 10], [u + d + 10, 10], [u + d - 10, -10]], w, h);
    if (!poly.length) continue;
    const sh = new THREE.Shape(); poly.forEach((p, k) => (k ? sh.lineTo(p[0], p[1]) : sh.moveTo(p[0], p[1]))); sh.closePath();
    const sg = new THREE.ShapeGeometry(sh); sg.deleteAttribute('uv'); sg.translate(0, 0, 0.017); g.push(paint(sg, RED));
    g.push(paint(sg.clone().rotateY(Math.PI), RED));
  }
  const m = merge(g); if (face < 0) m.rotateY(Math.PI); m.translate(x, y, z); return m;
}

// the blade mesh in its own frame: x up, y along the span from the root face, z sideways; smooth, indexed
function bladeGeo(B) {
  const Lb = B.Lb, st = [];
  for (let r = 0; r < 10; r += 0.5) st.push(r);
  for (let r = 10; r < Lb - 20; r += r < 30 ? 1.0 : 1.6) st.push(r);
  for (let r = Lb - 20; r < Lb - 1.5; r += 0.8) st.push(r);
  for (let r = Lb - 1.5; r < Lb; r += 0.25) st.push(r);
  st.push(Lb);
  const cuts = [6, 12, 18].map((d) => Lb - d);
  const rings = st.filter((r) => cuts.every((c) => Math.abs(r - c) > 0.05)).map((r) => ({ r, side: 0 }));
  for (const c of cuts) rings.push({ r: c, side: -1 }, { r: c, side: 1 });
  rings.sort((a, b) => a.r - b.r || a.side - b.side);
  const m = 2 * NP, pos = [], col = [], idx = [];
  // the day marking: red / grey / red, 6 m each from the tip (side: which side of a cut this ring belongs to)
  const red = (r, side) => { const d = Lb - r - side * 1e-3; return d < 6 || (d >= 12 && d < 18); };
  rings.forEach(({ r, side }) => {
    const sec = section(B, Math.min(1, r / Lb)), bz = B.bend(r), rd = red(r, side);
    sec.forEach(([u, sd], k) => {
      pos.push(u + bz, r, sd);
      const le = (k <= 3 || k >= m - 3) && r > 0.62 * Lb;   // leading-edge protection on the outer third
      col.push(...(rd ? BRED : le ? BLADE_LE : BLADE));
    });
  });
  for (let i = 0; i + 1 < rings.length; i++) {
    if (rings[i + 1].r - rings[i].r < 1e-6) continue;
    for (let k = 0; k < m; k++) { const k2 = (k + 1) % m, a = i * m + k, b = i * m + k2, c = (i + 1) * m + k2, d = (i + 1) * m + k; idx.push(a, c, d, a, b, c); }
  }
  // the tip: closed to a point slightly beyond the last ring
  const tipC = pos.length / 3, last = (rings.length - 1) * m;
  let cx = 0, cz = 0; for (let k = 0; k < m; k++) { cx += pos[3 * (last + k)]; cz += pos[3 * (last + k) + 2]; }
  pos.push(cx / m, Lb + 0.12, cz / m); col.push(...BRED);
  for (let k = 0; k < m; k++) idx.push(last + k, last + (k + 1) % m, tipC);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx);
  g.computeVertexNormals();
  // the root face: the bulkhead, set back a little
  const disc = new THREE.CircleGeometry(B.R0 * 0.985, 40); disc.rotateX(Math.PI / 2); disc.translate(0, 0.06, 0); disc.deleteAttribute('uv');
  return { blade: g, extra: [paint(disc, BULK)] };
}
// a band hugging the section at span r (the lashing straps), offset outwards by `off`, visible from both sides
function sectionBand(B, r, width, off, col) {
  const sec = section(B, Math.min(1, r / B.Lb)), m = sec.length, bz = B.bend(r);
  let cu = 0, cs = 0; for (const [u, s] of sec) { cu += u / m; cs += s / m; }
  const P = sec.map(([u, s]) => { const du = u - cu, ds = s - cs, l = Math.hypot(du, ds) || 1; return [u + du / l * off + bz, s + ds / l * off]; });
  const pos = [], y0 = r - width / 2, y1 = r + width / 2;
  for (let k = 0; k < m; k++) {
    const a = P[k], b = P[(k + 1) % m];
    pos.push(a[0], y0, a[1], b[0], y0, b[1], b[0], y1, b[1], a[0], y0, a[1], b[0], y1, b[1], a[0], y1, a[1]);
    pos.push(a[0], y0, a[1], b[0], y1, b[1], b[0], y0, b[1], a[0], y0, a[1], a[0], y1, a[1], b[0], y1, b[1]);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals();
  return paint(g, col);
}
// the friction clamp under the leading edge at the rear support (blade frame): a U-cradle with pads, down to the turntable
function clampGeo(v, B) {
  const r = B.rSup, sec = section(B, Math.min(1, r / B.Lb)), m = sec.length, e = ext(sec);
  let i0 = 0; sec.forEach(([u], k) => { if (u < sec[i0][0]) i0 = k; });
  const g = [];
  // the lower part of the section around the leading edge, ordered across; offsets outwards (pads 5 cm, steel 24 cm)
  const low = []; for (let d = -Math.floor(m / 2); d <= Math.floor(m / 2); d++) { const k = (i0 + d + m) % m; if (sec[k][0] < e.u0 + 0.6) low.push(sec[k]); }
  low.sort((a, b) => a[1] - b[1]);
  const offs = (pts, o) => pts.map(([u, s], k) => { const p = pts[Math.max(0, k - 1)], q = pts[Math.min(pts.length - 1, k + 1)]; const du = q[0] - p[0], ds = q[1] - p[1], l = Math.hypot(du, ds) || 1; return [u - ds / l * o, s + du / l * o]; });
  const pad = offs(low, 0.05), steel = offs(low, 0.24);
  const shape = (outer, inner) => { const sh = new THREE.Shape(); outer.forEach(([u, s], k) => (k ? sh.lineTo(s, u) : sh.moveTo(s, u))); [...inner].reverse().forEach(([u, s]) => sh.lineTo(s, u)); sh.closePath(); return sh; };
  const toBlade = (geo, y0) => { geo.deleteAttribute('uv'); geo.applyMatrix4(new THREE.Matrix4().set(0, 1, 0, 0, 0, 0, 1, y0, 1, 0, 0, 0, 0, 0, 0, 1)); return geo; };
  if (low.length > 2) {
    g.push(paint(toBlade(new THREE.ExtrudeGeometry(shape(steel, pad), { depth: 0.9, bevelEnabled: false }), r - 0.45), YELLOW));
    g.push(paint(toBlade(new THREE.ExtrudeGeometry(shape(pad, low), { depth: 0.8, bevelEnabled: false }), r - 0.4), RUBBER));
  }
  // the column down to the rear dolly's turntable (top 1.3 m above the road) and the swivel plate
  const uTop = e.u0 - 0.22, uBot = 1.3 - B.supC, sLE = B.leSide;
  if (uTop - uBot > 0.03) g.push(box(uTop - uBot, 0.7, 0.9, (uTop + uBot) / 2, r, sLE * 0.6, YELLOW));
  g.push(box(0.1, 1.4, 1.9, uBot + 0.05, r, sLE * 0.3, DARK));
  g.push(sectionBand(B, r - 0.62, 0.07, 0.025, STRAP), sectionBand(B, r + 0.62, 0.07, 0.025, STRAP));
  return merge(g);
}
// the root adapter (blade frame): root frame with studs, the lifting frame, arms down to the jeep dolly's turntable
// (rootAhead behind the root face) and the lift cylinders
function adapterGeo(v, B) {
  const g = [], R0 = B.R0, ya = v.rootAhead, tt = 0.97 - B.Hc;          // turntable top, in the blade's up coordinate
  const prof = [[R0 - 0.06, -0.24], [R0 + 0.3, -0.24], [R0 + 0.3, -0.03], [R0 - 0.06, -0.03]].map(([a, b]) => new THREE.Vector2(a, b));
  { const lg = new THREE.LatheGeometry([...prof, prof[0]], 56); lg.deleteAttribute('uv'); g.push(paint(lg, STEEL)); }
  for (let k = 0; k < 64; k++) { const a = (k / 64) * Math.PI * 2; g.push(cyl(0.028, 0.028, 0.12, Math.cos(a) * (R0 + 0.12), -0.3, Math.sin(a) * (R0 + 0.12), GALV, 6)); }
  const W = Math.max(2 * R0 + 0.7, Math.min(v.width, v.rootDiameter, 2 * R0 + 1.4)), xs = W / 2 - 0.14, top = R0 + 0.5;
  g.push(box(0.36, 0.34, W, top - 0.18, -0.2, 0, YELLOW));
  for (const s of [-1, 1]) {
    g.push(strut([top - 0.3, -0.2, s * xs], [-R0 * 0.45, -0.2, s * xs], 0.3, YELLOW));
    g.push(strut([top - 0.3, -0.16, s * (xs - 0.5)], [R0 * 0.55, -0.16, s * (R0 * 0.72)], 0.16, YELLOW));
    g.push(strut([-R0 * 0.4, -0.16, s * xs], [-R0 * 0.62, -0.16, s * R0 * 0.68], 0.16, YELLOW));
    // lift arms to the turntable rim; the hydraulic cylinders (body and chrome rod) to its rear
    g.push(strut([-R0 * 0.45, -0.2, s * xs], [tt + 0.08, ya - 0.2, s * 0.86], 0.24, YELLOW));
    const A = [tt + 0.05, ya + 0.75, s * 0.72], Bq = [-R0 * 0.1, -0.12, s * (xs - 0.1)], Mq = A.map((a, i) => a + (Bq[i] - a) * 0.55);
    g.push(strut(A, Mq, 0.2, DARK, true), strut(Mq, Bq, 0.1, ROD, true));
    g.push(box(0.12, 0.5, 0.5, tt + 0.06, ya - 0.2, s * 0.86, DARK), box(0.12, 0.4, 0.4, tt + 0.06, ya + 0.75, s * 0.72, DARK));
    for (let k = 0; k < 4; k++) g.push(box(0.31, 0.14, 0.31, top - 0.5 - k * 0.32, -0.2, s * xs, k % 2 ? BLACK : YELLOW));
  }
  g.push(cyl(0.11, 0.12, 0.2, top + 0.1, -0.2, 0, AMBER, 12, 'x'));
  return merge(g);
}

// ---------------------------------------------------------------- tractor: 8×4/4 heavy-haul, origin at the first steered axle
function tractorGeo(v) {
  const g = [], L = v.tractorLength, fo = v.frontOverhang, rear = fo - L, zf = fo - 0.1, zk = -v.wheelbase + v.kingpinAhead;
  const cz0 = zf - 2.32;                                              // back of the cab
  for (const s of [-1, 1]) g.push(box(0.1, 0.32, L - 0.5, s * 0.44, 0.98, (fo + rear) / 2 - 0.2, CHASSIS));
  for (const z of [0.6, -1.0, -2.5, -3.4, zk, rear + 0.3]) g.push(box(0.9, 0.12, 0.14, 0, 0.94, z, CHASSIS));
  // the cab: high roof, rounded corners, a slight lean at the top of the front
  g.push(loftRR([
    { z: cz0, w: 2.44, y0: 1.12, y1: 3.92, r: 0.12 },
    { z: zf - 0.3, w: 2.5, y0: 1.08, y1: 3.98, r: 0.16 },
    { z: zf - 0.14, w: 2.48, y0: 1.06, y1: 3.9, r: 0.2 },
    { z: zf, w: 2.4, y0: 1.06, y1: 3.66, r: 0.24 },
  ], CAB));
  g.push(rbox(2.52, 0.5, 0.56, 1.36, 0.08, 0, zf - 0.05, CAB2));
  g.push(box(2.505, 0.06, 2.1, 0, 1.66, zf - 1.15, ACCENT), box(2.505, 0.38, 2.1, 0, 1.3, zf - 1.15, CAB2));
  { const ws = new THREE.PlaneGeometry(2.18, 1.02); ws.rotateX(-0.08); ws.translate(0, 2.88, zf + 0.012); ws.deleteAttribute('uv'); g.push(paint(ws, GLASS)); }
  g.push(rbox(2.36, 0.36, 3.42, 3.58, 0.05, 0, zf + 0.06, CAB2, 0.015));
  g.push(box(1.7, 0.9, 0.04, 0, 1.86, zf + 0.012, BLACK));
  for (let k = 0; k < 5; k++) g.push(box(1.66, 0.05, 0.06, 0, 1.5 + k * 0.17, zf + 0.035, CHROME));
  g.push(box(0.5, 0.08, 0.04, 0, 2.17, zf + 0.06, CHROME));
  for (const s of [-1, 1]) {
    g.push(rbox(0.52, 0.08, 1.06, 1.3, 0.05, s * 0.86, zf + 0.22, LAMP, 0.01));
    g.push(box(0.16, 0.06, 0.04, s * 1.12, 1.33, zf + 0.24, AMBER));
    g.push(cyl(0.065, 0.065, 0.04, s * 0.9, 0.72, zf + 0.21, LAMP, 12, 'z'));
  }
  g.push(box(0.52, 0.11, 0.02, 0, 0.88, zf + 0.21, PLATE), box(0.05, 0.11, 0.021, -0.235, 0.88, zf + 0.211, EUBLUE));
  g.push(box(0.36, 0.18, 0.2, 0, 0.6, zf + 0.2, STEEL));
  for (const s of [-1, 1]) {
    const x = s * 1.252;
    { const p = new THREE.PlaneGeometry(1.0, 0.8); p.rotateY(s * Math.PI / 2); p.translate(x, 2.8, zf - 0.75); p.deleteAttribute('uv'); g.push(paint(p, GLASS)); }
    g.push(box(0.02, 1.9, 0.025, x, 2.2, zf - 1.32, DARK), box(0.03, 0.05, 0.24, x + s * 0.015, 2.25, zf - 1.15, CHROME));
    for (const y of [0.45, 0.82]) g.push(box(0.4, 0.05, 0.66, s * 1.05, y, zf - 0.78, BLACK));
    g.push(box(0.04, 1.0, 0.04, s * 1.27, 2.3, zf - 0.16, CHROME));
    g.push(box(0.04, 1.3, 0.62, s * 1.265, 2.9, cz0 + 0.3, CAB));
    g.push(strut([s * 1.25, 3.05, zf - 0.12], [s * 1.6, 3.12, zf - 0.02], 0.045, BLACK), strut([s * 1.25, 2.48, zf - 0.12], [s * 1.58, 2.42, zf - 0.02], 0.045, BLACK));
    g.push(rbox(0.11, 0.26, 2.5, 3.22, 0.04, s * 1.64, zf - 0.02, BLACK, 0.015), rbox(0.09, 0.22, 2.16, 2.44, 0.03, s * 1.62, zf - 0.02, BLACK, 0.01));
    g.push(box(0.05, 0.5, 2.0, s * 1.26, 0.82, zf - 1.3, CAB2));
  }
  for (const z of [0, -1.95]) for (const s of [-1, 1]) g.push(box(0.44, 0.06, 1.24, s * 1.06, 1.16, z, BLACK));
  g.push(rbox(2.0, 0.26, 3.98, 4.1, 0.05, 0, zf - 0.36, BLACK, 0.01));
  for (const s of [-1, 1]) g.push(cyl(0.11, 0.12, 0.19, s * 0.98, 4.2, zf - 0.36, AMBER, 12));
  for (let k = -2; k <= 2; k++) g.push(box(0.2, 0.08, 0.05, k * 0.33, 4.04, zf - 0.21, LAMP));
  g.push(cyl(0.05, 0.07, 0.55, 0.62, 4.02, zf - 1.3, CHROME, 10, 'z'), cyl(0.05, 0.07, 0.45, 0.42, 4.02, zf - 1.3, CHROME, 10, 'z'));
  g.push(cyl(0.09, 0.09, 2.7, -0.98, 2.62, cz0 - 0.18, CHROME, 12), cyl(0.11, 0.09, 0.22, -0.98, 4.04, cz0 - 0.18, CHROME, 12));
  g.push(rbox(0.36, 0.3, 1.4, 3.6, 0.06, 0.96, cz0 - 0.2, CAB2, 0.01));
  g.push(box(1.8, 0.04, 0.85, 0, 1.36, cz0 - 0.52, ALU));
  g.push(strut([-0.3, 1.38, cz0 - 0.5], [-0.25, 1.5, zk + 0.5], 0.05, HOSE_B, true), strut([0.3, 1.38, cz0 - 0.5], [0.25, 1.5, zk + 0.5], 0.05, RED, true));
  g.push(cyl(0.34, 0.34, 1.8, 0.98, 0.78, cz0 - 1.25, ALU, 22, 'z'));
  for (const dz of [-0.3, -2.2]) g.push(box(0.71, 0.04, 0.05, 0.98, 1.1, cz0 + dz, BLACK));
  g.push(box(0.55, 0.62, 0.95, -0.98, 0.8, cz0 - 0.95, BLACK), cyl(0.22, 0.22, 0.5, -0.98, 0.78, cz0 - 1.85, WHITE, 16, 'z'));
  for (const s of [-1, 1]) g.push(cyl(0.13, 0.13, 1.1, s * 0.64, 0.62, -3.0, STEEL, 10, 'z'));
  g.push(box(1.36, 0.16, 1.4, 0, 1.17, zk, DARK), cyl(0.62, 0.62, 0.1, 0, 1.33, zk, STEEL, 28), box(0.16, 0.12, 0.62, 0, 1.4, zk - 0.38, BLACK));
  for (const s of [-1, 1]) {
    g.push(box(0.78, 0.05, 2.7, s * 0.95, 1.16, -v.wheelbase, BLACK));
    g.push(box(0.62, 0.6, 0.02, s * 0.95, 0.55, -v.wheelbase - 1.42, RUBBER));
    g.push(box(0.36, 0.14, 0.05, s * 0.98, 0.9, rear + 0.04, RED), box(0.12, 0.14, 0.052, s * 0.72, 0.9, rear + 0.04, AMBER));
  }
  g.push(box(2.3, 0.12, 0.1, 0, 0.6, rear + 0.06, CHASSIS));
  return merge(g);
}
// ---------------------------------------------------------------- jeep dolly (front unit): origin at the turntable, +z towards the king pin
function jeepGeo(v) {
  const g = [], W = v.frontWidth, L = v.frontUnit, bx = W / 2 - 0.25, yb = 0.97;
  // gooseneck: the plate on the fifth wheel, the high neck over the tractor's tandem, the drop ahead of the root frame
  const zDrop = Math.max(v.rootAhead + 0.75, 1.9);
  g.push(box(1.36, 0.12, 1.5, 0, 1.5, L + 0.15, FRAME));
  for (const sx of [-1, 1]) {
    // side plates of the neck: high over the tractor's tandem, then the drop ahead of the root frame
    g.push(box(0.1, 0.5, 3.6, sx * 0.42, 1.82, L - 1.0, FRAME));
    const a = [sx * 0.42, 1.78, L - 2.75], b = [sx * 0.55, 1.0, zDrop + 0.15];
    const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]), l = d.length();
    const pl = new THREE.BoxGeometry(0.1, 0.42, l); pl.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), d.normalize()));
    pl.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2); g.push(paint(pl, FRAME));
  }
  g.push(box(0.94, 0.06, 3.6, 0, 2.08, L - 1.0, FRAME), box(0.94, 0.06, 3.6, 0, 1.58, L - 1.0, FRAME));
  for (const z of [L - 2.4, L - 0.6, L + 0.6]) g.push(box(0.84, 0.4, 0.08, 0, 1.82, z, FRAME));
  g.push(box(2 * bx + 0.3, 0.3, 0.42, 0, yb, zDrop, FRAME));
  // hydraulic and air couplings along the neck, the lift unit's power pack on the jeep's front
  g.push(strut([0.25, 2.12, L + 0.4], [0.3, 1.2, zDrop + 0.3], 0.05, HOSE_B, true), strut([-0.25, 2.12, L + 0.4], [-0.3, 1.2, zDrop + 0.3], 0.05, RED, true));
  g.push(rbox(0.7, 0.6, yb + 0.15, yb + 0.75, 0.05, -0.9, zDrop - 0.05, YELLOW, 0.02));
  for (const s of [-1, 1]) {
    g.push(box(0.3, 0.34, zDrop + 1.55, s * bx, yb, (zDrop - 1.55) / 2, FRAME));
    g.push(box(0.6, 0.05, 2.3, s * (W / 2 - 0.3), 0.86, 0, BLACK));
  }
  g.push(box(2 * bx, 0.24, 0.26, 0, 0.6, -1.45, FRAME));
  { const prof = [[0.6, 0.8], [0.95, 0.8], [0.95, 0.97], [0.6, 0.97]].map(([a, b]) => new THREE.Vector2(a, b)); const lg = new THREE.LatheGeometry([...prof, prof[0]], 36); lg.deleteAttribute('uv'); g.push(paint(lg, STEEL)); }
  for (const s of [-1, 1]) g.push(box(0.4, 0.2, 1.8, s * 0.82, 0.7, 0, FRAME));
  for (const s of [-1, 1]) {
    g.push(warnBoard(0.42, 0.42, s * (W / 2 - 0.22), 1.36, zDrop + 0.24, 1));
    g.push(warnBoard(0.42, 0.42, s * (W / 2 - 0.22), 0.98, -1.62, -1));
    g.push(box(0.3, 0.12, 0.05, s * (W / 2 - 0.25), 0.66, -1.62, RED));
    for (const z of [zDrop - 0.4, -1.2]) g.push(box(0.03, 0.06, 0.14, s * (W / 2 - 0.08), 1.02, z, AMBER));
  }
  return merge(g);
}
// ---------------------------------------------------------------- rear dolly: origin at the turntable, +z forward
function dollyGeo(v) {
  const g = [], W = v.dollyWidth, L = v.dollyLength, bx = W / 2 - 0.24, yb = 0.98;
  for (const s of [-1, 1]) g.push(box(0.3, 0.34, L, s * bx, yb, 0, FRAME));
  g.push(box(0.5, 0.42, L - 0.4, 0, yb + 0.02, 0, FRAME));
  for (let k = 0; k < 6; k++) g.push(box(2 * bx, 0.22, 0.18, 0, yb - 0.02, -L / 2 + 0.25 + k * (L - 0.5) / 5, FRAME));
  { const prof = [[0.2, yb + 0.17], [1.05, yb + 0.17], [1.05, 1.3], [0.2, 1.3]].map(([a, b]) => new THREE.Vector2(a, b)); const lg = new THREE.LatheGeometry([...prof, prof[0]], 40); lg.deleteAttribute('uv'); g.push(paint(lg, STEEL)); }
  for (const s of [-1, 1]) g.push(box(0.62, 0.05, L - 1.2, s * (W / 2 - 0.3), 0.86, 0, BLACK));
  g.push(rbox(0.8, 1.0, yb + 0.17, 1.72, 0.06, 0.72, L / 2 - 0.65, YELLOW), box(0.6, 0.3, 0.02, 0.72, 1.45, L / 2 - 0.14, BLACK));
  g.push(box(0.36, 0.42, 0.3, -0.85, yb + 0.38, L / 2 - 0.45, DARK));
  g.push(box(2 * bx + 0.3, 0.16, 0.12, 0, 0.7, -L / 2 - 0.06, BLACK));
  for (const s of [-1, 1]) {
    g.push(warnBoard(0.5, 0.5, s * (W / 2 - 0.26), 1.16, -L / 2 - 0.08, -1));
    g.push(warnBoard(0.42, 0.42, s * (W / 2 - 0.22), 1.12, L / 2 + 0.06, 1));
    g.push(box(0.28, 0.12, 0.05, s * (W / 2 - 0.24), 0.7, -L / 2 - 0.13, RED), box(0.1, 0.12, 0.051, s * (W / 2 - 0.5), 0.7, -L / 2 - 0.13, AMBER));
    for (const z of [L / 2 - 0.5, 0, -L / 2 + 0.5]) g.push(box(0.03, 0.06, 0.14, s * (W / 2 - 0.08), 1.02, z, AMBER));
  }
  // long-vehicle plate (ECE 70: yellow with a red border)
  g.push(box(1.14, 0.2, 0.02, 0, 0.92, -L / 2 - 0.13, YELLOW), box(1.14, 0.03, 0.021, 0, 1.007, -L / 2 - 0.131, RED), box(1.14, 0.03, 0.021, 0, 0.833, -L / 2 - 0.131, RED));
  g.push(cyl(0.11, 0.12, 0.2, -W / 2 + 0.45, 1.42, L / 2 - 0.4, AMBER, 12));
  return merge(g);
}

// ---------------------------------------------------------------- escorts: BF4 (sulfur yellow, board to the front) and BF3 (board to the back)
function escortGeo(kind) {
  const g = [], body = kind === 'bf4' ? SULFUR : WHITE;
  g.push(loftRR([
    { z: -2.6, w: 1.98, y0: 0.36, y1: 2.32, r: 0.1 },
    { z: 1.2, w: 2.02, y0: 0.36, y1: 2.34, r: 0.14 },
    { z: 1.78, w: 1.98, y0: 0.36, y1: 1.66, r: 0.2 },
    { z: 2.55, w: 1.86, y0: 0.36, y1: 1.08, r: 0.22 },
  ], body));
  { const ws = new THREE.PlaneGeometry(1.7, 0.66); ws.rotateX(-0.9); ws.translate(0, 1.48, 1.5); ws.deleteAttribute('uv'); g.push(paint(ws, GLASS)); }
  for (const s of [-1, 1]) {
    { const p = new THREE.PlaneGeometry(0.9, 0.5); p.rotateY(s * Math.PI / 2); p.translate(s * 1.012, 1.66, 0.55); p.deleteAttribute('uv'); g.push(paint(p, GLASS)); }
    for (let k = 0; k < 10; k++) g.push(box(0.012, 0.16, 0.36, s * 1.014, 0.78, -2.35 + k * 0.44, kind === 'bf4' ? (k % 2 ? WHITE : SULFUR) : (k % 2 ? WHITE : RED)));
    g.push(box(0.4, 0.1, 0.05, s * 0.66, 0.92, 2.55, LAMP), box(0.12, 0.34, 0.05, s * 0.88, 1.22, -2.62, RED));
  }
  g.push(box(1.9, 0.22, 0.1, 0, 0.5, 2.6, CAB2), box(1.9, 0.2, 0.1, 0, 0.48, -2.64, CAB2));
  g.push(box(0.52, 0.11, 0.02, 0, 0.62, 2.66, PLATE), box(0.52, 0.11, 0.02, 0, 0.66, -2.7, PLATE));
  g.push(box(1.7, 0.08, 2.4, 0, 2.38, -0.6, DARK));
  for (const s of [-1, 1]) g.push(cyl(0.1, 0.11, 0.18, s * 0.78, 2.5, kind === 'bf4' ? -1.6 : 0.5, AMBER, 12));
  const zb = kind === 'bf4' ? 0.55 : -1.9;
  g.push(box(1.8, 1.1, 0.12, 0, 3.0, zb, BLACK));
  for (const s of [-1, 1]) g.push(box(0.06, 0.6, 0.06, s * 0.7, 2.62, zb, DARK));
  return merge(g);
}
// the board faces: the BF4's LED matrix (sign 101 and 'SCHWERTRANSPORT') and the BF3's panel (signs 101 and 276, flashers)
// the boards are drawn once per kind (the BF4's needs a read-back of its canvas: slow while the GPU is busy) and shared
const BOARDS = {};
export function boardCanvas(kind) { return BOARDS[kind] || (BOARDS[kind] = drawBoard(kind)); }
function boardTexture(kind) { const t = new THREE.CanvasTexture(boardCanvas(kind)); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t; }
function drawBoard(kind) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 300; const x = c.getContext('2d');
  const tri = (cx, cy, s) => { x.fillStyle = '#fff'; x.strokeStyle = '#d0101a'; x.lineWidth = s * 0.12; x.lineJoin = 'round';
    x.beginPath(); x.moveTo(cx, cy - s * 0.55); x.lineTo(cx + s * 0.6, cy + s * 0.48); x.lineTo(cx - s * 0.6, cy + s * 0.48); x.closePath(); x.fill(); x.stroke();
    x.fillStyle = '#111'; x.fillRect(cx - s * 0.05, cy - s * 0.22, s * 0.1, s * 0.42); x.beginPath(); x.arc(cx, cy + s * 0.32, s * 0.065, 0, Math.PI * 2); x.fill(); };
  const noOvertake = (cx, cy, s) => { x.fillStyle = '#fff'; x.beginPath(); x.arc(cx, cy, s * 0.5, 0, Math.PI * 2); x.fill(); x.strokeStyle = '#d0101a'; x.lineWidth = s * 0.1; x.beginPath(); x.arc(cx, cy, s * 0.45, 0, Math.PI * 2); x.stroke();
    const car = (ox, col) => { x.fillStyle = col; x.fillRect(ox - s * 0.1, cy - s * 0.22, s * 0.2, s * 0.38); x.fillRect(ox - s * 0.12, cy + s * 0.02, s * 0.24, s * 0.12); };
    car(cx - s * 0.17, '#d0101a'); car(cx + s * 0.17, '#111'); };
  if (kind === 'bf4') {
    x.fillStyle = '#050505'; x.fillRect(0, 0, 512, 300);
    tri(256, 112, 170);
    x.fillStyle = '#ffb000'; x.font = 'bold 44px sans-serif'; x.textAlign = 'center'; x.fillText('SCHWERTRANSPORT', 256, 274);
    const img = x.getImageData(0, 0, 512, 300), d = img.data;
    for (let yy = 0; yy < 300; yy++) for (let xx = 0; xx < 512; xx++) { if (xx % 4 === 3 || yy % 4 === 3) { const i = (yy * 512 + xx) * 4; d[i] *= 0.2; d[i + 1] *= 0.2; d[i + 2] *= 0.2; } }
    x.putImageData(img, 0, 0);
  } else {
    x.fillStyle = '#f4f4f2'; x.fillRect(0, 0, 512, 300);
    for (let k = -12; k < 30; k++) { x.fillStyle = k % 2 ? '#d0101a' : '#f4f4f2'; x.beginPath(); x.moveTo(k * 30, 0); x.lineTo(k * 30 + 30, 0); x.lineTo(k * 30 + 330, 300); x.lineTo(k * 30 + 300, 300); x.fill(); }
    x.fillStyle = '#f4f4f2'; x.fillRect(26, 26, 460, 248);
    tri(160, 152, 190); noOvertake(352, 150, 190);
    for (const [fx, fy] of [[52, 52], [460, 52], [52, 248], [460, 248]]) { x.fillStyle = '#ffae00'; x.beginPath(); x.arc(fx, fy, 19, 0, Math.PI * 2); x.fill(); }
  }
  return c;
}
function plateTexture(text) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 96; const x = c.getContext('2d');
  x.fillStyle = '#f4f4f0'; x.fillRect(0, 0, 512, 96); x.strokeStyle = '#111'; x.lineWidth = 6; x.strokeRect(5, 5, 502, 86);
  x.fillStyle = '#111'; x.font = 'bold 58px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(text, 256, 52);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// ---------------------------------------------------------------- the convoy
export function makeConvoy(vehicle) { const it = makeConvoySteps(vehicle); let st; while (!(st = it.next()).done); return st.value; }
// the same in steps (a generator: it yields between the parts of the build; it returns the convoy), to make it ahead at idle
export function* makeConvoySteps(vehicle) {
  let v = { ...DEFAULTS, ...(vehicle || {}) };
  const mat = patch(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.1 }), { key: 'convoy' });
  const bmat = patch(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.0 }), { key: 'blade', frag: { afterLights: 'reflectedLight.indirectDiffuse += diffuseColor.rgb * 0.16 * (1.0 - uNight);' } });
  const group = new THREE.Group();
  const mk = (geo, m = mat) => { const o = new THREE.Mesh(geo, m); o.castShadow = true; o.receiveShadow = true; return o; };
  const part = () => { const o = new THREE.Group(); o.matrixAutoUpdate = false; group.add(o); return o; };
  const tractor = part(), front = part(), dolly = part(), blade = part(), escort = part(), escortRear = part();
  const boardF = new THREE.MeshBasicMaterial({ map: boardTexture('bf4'), toneMapped: false }), boardR = new THREE.MeshBasicMaterial({ map: boardTexture('bf3'), toneMapped: false });
  const plateM = new THREE.MeshBasicMaterial({ map: plateTexture('Schwertransport') });
  yield;
  let wheels = [], B = null, pend = null;
  const PARTS = [tractor, front, dolly, blade, escort, escortRear], dimsNow = () => v;
  const clear = (o) => { for (const c of [...o.children]) { o.remove(c); c.traverse((q) => q.geometry && !q.geometry.userData.keep && q.geometry.dispose()); } };
  function build() { const it = buildSteps(); while (!it.next().done); }
  // the parts for dimensions vv, into the part groups (in place: the old ones cleared first) or into others (P, with the
  // wheels and the blade's frame in out: the convoy shown keeps its old parts until they are swapped in)
  function* buildSteps(vv = dimsNow(), P = null, out = null) {
    const v = vv, [tractor, front, dolly, blade, escort, escortRear] = P || PARTS;
    if (!P) PARTS.forEach(clear);
    const WH = [], BF = bladeFrame(v);
    // an axle: a steering group per side (pivot at the wheel) holding the spinning wheels; the beam is static
    const addAxle = (p, z, track, r, w, dual, steer) => {
      for (const s of [-1, 1]) {
        const a = new THREE.Group(); a.position.set(s * track / 2, r, z);
        const m = mk(wheelSetGeo(r, w, dual, s)); a.add(m); p.add(a);
        WH.push({ obj: a, spin: m, r, steer, part: p });
      }
      p.add(mk(cyl(0.075, 0.075, Math.max(0.3, track - (dual ? 2 * w : w) - 0.1), 0, r, z, DARK, 8, 'x')));
    };
    tractor.add(mk(tractorGeo(v))); yield;
    addAxle(tractor, 0, 2.06, 0.536, 0.385, false, 1);
    addAxle(tractor, -1.95, 2.06, 0.536, 0.385, false, 0.62);
    addAxle(tractor, -v.wheelbase + 0.675, 1.84, 0.538, 0.315, true, 0);
    addAxle(tractor, -v.wheelbase - 0.675, 1.84, 0.538, 0.315, true, 0); yield;
    front.add(mk(jeepGeo(v))); yield;
    for (const z of [0.68, -0.68]) addAxle(front, z, v.frontWidth - 0.57, 0.394, 0.245, true, z > 0 ? 1 : -1);
    yield; dolly.add(mk(dollyGeo(v))); yield;
    for (const z of [2.04, 0.68, -0.68, -2.04]) addAxle(dolly, z, v.dollyWidth - 0.57, 0.394, 0.245, true, z / 2.04);
    yield; const bg = bladeGeo(BF); yield; blade.add(mk(bg.blade, bmat)); blade.add(mk(merge(bg.extra))); yield;
    blade.add(mk(adapterGeo(v, BF))); blade.add(mk(clampGeo(v, BF)));
    yield; escort.add(mk(escortGeo('bf4'))); yield; escortRear.add(mk(escortGeo('bf3'))); yield;
    for (const e of [escort, escortRear]) { addAxle(e, 1.72, 1.74, 0.34, 0.22, false, 1); addAxle(e, -1.62, 1.74, 0.34, 0.22, false, 0); }
    { const p = new THREE.PlaneGeometry(1.7, 1.0); p.translate(0, 3.0, 0.62); escort.add(new THREE.Mesh(p, boardF)); }
    { const p = new THREE.PlaneGeometry(1.7, 1.0); p.rotateY(Math.PI); p.translate(0, 3.0, -1.97); escortRear.add(new THREE.Mesh(p, boardR)); }
    { const p = new THREE.PlaneGeometry(1.2, 0.22); p.rotateY(Math.PI); p.translate(0, 1.05, -2.66); escortRear.add(new THREE.Mesh(p, plateM)); }
    if (out) { out.wheels = WH; out.B = BF; } else { wheels = WH; B = BF; }
  }
  yield* buildSteps();
  const glow = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d');
    const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,240,200,1)'); gr.addColorStop(0.15, 'rgba(255,150,20,1)'); gr.addColorStop(0.5, 'rgba(255,120,0,.3)'); gr.addColorStop(1, 'rgba(255,100,0,0)');
    x.fillStyle = gr; x.fillRect(0, 0, 64, 64); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; })();
  const beacons = Array.from({ length: 7 }, () => { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })); s.scale.set(3.2, 3.2, 1); s.visible = false; group.add(s); return s; });
  const head = new THREE.SpotLight(0xfff1dc, 0, 140, 0.55, 0.6, 1.2); group.add(head, head.target);
  const M = new THREE.Matrix4(), MX = new THREE.Matrix4(), V1 = new THREE.Vector3(), V2 = new THREE.Vector3(), VA = new THREE.Vector3(), VU = new THREE.Vector3(), VS = new THREE.Vector3();
  let lastNight = 0, lastT = 0;
  // the pitch eased like a suspension (time constant 0.15 s) while driving; set at once after a jump (> 4 m) or a pause.
  // The height is not eased: the wheels stay on the road
  const damp = {};
  const easePitch = (key, x, y, p) => {
    const d = damp[key], now = lastT;
    if (d && now === d.t && Math.hypot(x - d.x, y - d.y) < 0.01) return d.p;
    if (!d || Math.hypot(x - d.x, y - d.y) > 4 || now - d.t > 0.5 || now < d.t) { damp[key] = { x, y, p, t: now }; return p; }
    d.p += (p - d.p) * (1 - Math.exp(-(now - d.t) / 0.15)); d.x = x; d.y = y; d.t = now; return d.p;
  };
  // a part on the ground at (x, y) heading towards (fx, fy), pitched by the ground between `ahead` and `behind` (m)
  const place = (obj, x, y, fx, fy, h, ahead = 0, behind = 0, key = null) => {
    const dx = fx - x, dy = fy - y, l = Math.hypot(dx, dy) || 1, ux = dx / l, uy = dy / l;
    const yaw = Math.atan2(dx, -dy);
    let z0 = h(x, y), pitch = 0;
    if (ahead + behind > 0.5) { const za = h(x + ux * ahead, y + uy * ahead), zb = h(x - ux * behind, y - uy * behind); pitch = Math.atan2(za - zb, ahead + behind); z0 = zb + (za - zb) * (behind / (ahead + behind)); }
    if (key) pitch = easePitch(key, x, y, pitch);
    M.makeRotationY(yaw); MX.makeRotationX(-pitch); M.multiply(MX); M.setPosition(x, z0, -y);
    obj.matrix.copy(M); obj.matrixWorldNeedsUpdate = true;
    return yaw;
  };
  // wheels: spin by the distance the part moved along its heading, steer by its heading change per metre
  const st = {};
  function wheelsFor(key, part, x, y, yaw, wb) {
    const s = st[key];
    if (!s || Math.hypot(x - s.x, y - s.y) > 30) { st[key] = { x, y, yaw, dist: s ? s.dist : 0, steer: 0 }; return; }
    const dx = x - s.x, dy = y - s.y, d = Math.hypot(dx, dy);
    s.dist += Math.sin(yaw) * dx - Math.cos(yaw) * dy;
    if (d > 0.01) { let dyaw = yaw - s.yaw; dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw)); const target = Math.max(-0.7, Math.min(0.7, Math.atan(-(dyaw / d) * wb))); s.steer += (target - s.steer) * Math.min(1, d * 0.5); }
    s.x = x; s.y = y; s.yaw = yaw;
    for (const w of wheels) { if (w.part !== part) continue; w.spin.rotation.x = s.dist / w.r; w.obj.rotation.y = w.steer ? w.steer * s.steer : 0; }
  }
  const escortBeacons = (obj, z, k0) => {
    for (let i = 0; i < 2; i++) {
      const b = beacons[k0 + i]; b.visible = lastNight > 0.5 && obj.visible; if (!b.visible) continue;
      b.position.set(i ? 0.78 : -0.78, 2.6, z).applyMatrix4(obj.matrix); b.material.opacity = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(lastT * 9 + (k0 + i) * 2.1));
    }
  };
  return {
    group, tractor, front, dolly, blade, beacons, head, escort, escortRear,
    get dims() { return pend ? pend.n : v; },          // (dimensions being built count already)
    get frame() { return B; },
    // the escorts: ahead of the tractor (BF4) and behind the blade tip (BF3), at (x, y) heading towards (hx, hy)
    placeEscort(x, y, hx, hy, h) { const yw = place(escort, x, y, hx, hy, h, 1.7, 1.6, 'esc'); wheelsFor('esc', escort, x, y, yw, 3.3); escortBeacons(escort, -1.6, 3); },
    placeRear(x, y, hx, hy, h) { escortRear.visible = true; const yw = place(escortRear, x, y, hx, hy, h, 1.7, 1.6, 'escR'); wheelsFor('escR', escortRear, x, y, yw, 3.3); escortBeacons(escortRear, 0.5, 5); },
    setDims(nv) { const n = { ...DEFAULTS, ...nv }; pend = null; if (JSON.stringify(n) === JSON.stringify(v)) return; v = n; build(); },      // (the same dimensions: nothing to rebuild)
    // the same in slices (slice: a slicer of warm.js) beside the convoy shown, swapped in when done (the last call wins;
    // same materials, so no new programs: the new buffers go up with the next frame, as after setDims)
    async setDimsAsync(nv, slice) {
      const n = { ...DEFAULTS, ...nv }, key = JSON.stringify(n);
      if (pend && pend.key === key) return;                                       // (already being built)
      if (key === JSON.stringify(v)) { pend = null; return; }                     // (back to the dimensions shown)
      const me = pend = { key, n }, P = PARTS.map(() => new THREE.Group()), out = {}, it = buildSteps(n, P, out);
      while (!it.next().done) if (slice.due()) { await slice(); if (pend !== me) break; }
      if (pend !== me) { P.forEach(clear); return; }
      pend = null;
      PARTS.forEach((o, i) => { clear(o); for (const c of [...P[i].children]) o.add(c); });
      wheels = out.wheels.map((w) => ({ ...w, part: PARTS[P.indexOf(w.part)] })); B = out.B; v = n;
    },
    set(p, h, night, t) {
      lastNight = night; lastT = t;
      // tractor: front axle, heading from the rear axle
      const ty = place(tractor, p[0], p[1], p[0] + (p[0] - p[2]), p[1] + (p[1] - p[3]), h, 0.01, v.wheelbase, 'tractor');
      wheelsFor('tractor', tractor, p[0], p[1], ty, v.wheelbase);
      // jeep dolly: at the front support, heading to the king pin
      let ux = p[0] - p[2], uy = p[1] - p[3]; const ul = Math.hypot(ux, uy) || 1; ux /= ul; uy /= ul;
      const kx = p[2] + ux * v.kingpinAhead, ky = p[3] + uy * v.kingpinAhead;
      const jy = place(front, p[4], p[5], kx, ky, h, 0.7, 0.7, 'front');
      wheelsFor('front', front, p[4], p[5], jy, 1.6);
      // rear dolly: at its turntable, along its own heading
      const dy = place(dolly, p[10], p[11], p[12], p[13], h, 2.0, 2.0, 'dolly');
      wheelsFor('dolly', dolly, p[10], p[11], dy, 2.2);
      // escorts by default 45 m ahead along the tractor's heading, the BF3 hidden (the views place both on the road)
      { const ex = p[0] + ux * 45, ey = p[1] + uy * 45; place(escort, ex, ey, ex + ux, ey + uy, h); }
      escortRear.visible = false;
      // the blade: root centre on the adapter above the jeep dolly's turntable, the clamp section on the rear dolly
      const r = V1.set(p[6], h(p[4], p[5]) + B.Hc, -p[7]);
      const dc = V2.set(p[10], h(p[10], p[11]) + B.supC, -p[11]);
      const ax = VA.copy(dc).sub(r); const len = ax.length(); ax.normalize();
      const up = VU.set(0, 1, 0).addScaledVector(ax, -ax.y).normalize();
      const side = VS.crossVectors(up, ax).normalize();
      M.makeBasis(up, ax, side); M.setPosition(r);
      const sc = len / B.rSup; if (Math.abs(sc - 1) > 0.002) M.multiply(MX.makeScale(1, sc, 1));
      blade.matrix.copy(M); blade.matrixWorldNeedsUpdate = true;
      const on = night > 0.5, flash = (k) => 0.5 + 0.5 * Math.sin(t * 9 + k * 2.1);
      const pts = [[p[0], p[1], 4.2], [p[12], p[13], 1.45], [p[4], p[5], B.Hc + B.frameUp + 0.15]];
      for (let k = 0; k < 3; k++) { const b = beacons[k]; b.visible = on; if (!on) continue; const q = pts[k]; b.position.set(q[0], h(q[0], q[1]) + q[2], -q[1]); b.material.opacity = 0.35 + 0.65 * flash(k); }
      for (let k = 3; k < beacons.length; k++) if (!on) beacons[k].visible = false;
      head.intensity = on ? 60 : 0;
      if (on) {
        head.position.set(p[0] + ux * 1.6, h(p[0], p[1]) + 1.2, -(p[1] + uy * 1.6));
        head.target.position.set(p[0] + ux * 30, h(p[0], p[1]), -(p[1] + uy * 30));
        head.target.updateMatrixWorld();
      }
    },
  };
}
