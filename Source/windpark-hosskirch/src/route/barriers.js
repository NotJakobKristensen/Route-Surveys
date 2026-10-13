// Road restraint systems in the road view (German practice, RPS 2009 / EN 1317): the barrier in the central reservation
// of a dual carriageway (route_lanelines.py: concrete step barrier, double steel guard rail, raised median with a rail on
// top, on the measured median axis) and the mapped barriers (OSM via Overture: guard rails, jersey barriers, walls,
// noise barriers, hedges, fences) as solid profiles instead of flat sheets. Shared materials; the concrete in 500 m
// chunks (it casts shadows, so the shadow camera culls per chunk), steel rails and posts per pack without shadows.
// Built into typed arrays, each face of a profile one strip sharing its vertices along the line (a pack in a few ms).
import * as THREE from 'three';

// concrete step barrier (Betonschutzwand, 0.81 m type): half-widths (m) over height (m), scaled to the measured height
const STEP = [[0.30, 0], [0.30, 0.075], [0.21, 0.255], [0.12, 0.81]];
// W-beam (A-profile, 0.31 m high, top at 0.75 m): the edges stand 6 cm towards the traffic, folded at the middle
const WBEAM = [[0.06, 0.44], [0, 0.595], [0.06, 0.75]];
let SHARED = null;
/** the shared materials (also for the view's shader warm-up) */
export function barrierMaterials() {
  if (SHARED) return SHARED;
  const m = (o) => new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, side: THREE.DoubleSide, ...o });
  return (SHARED = {
    con: m({ color: 0xcdc7bb, emissive: 0x4c4841 }),                       // concrete barriers, walls
    steel: m({ color: 0xbcc3c8, emissive: 0x30343a, roughness: 0.4, metalness: 0.45 }),   // galvanised W-beams, fences
    post: m({ color: 0xa9afb4, emissive: 0x24272a, roughness: 0.5, metalness: 0.35, side: THREE.FrontSide }),
    verge: m({ color: 0x6f7d4f, emissive: 0x262c1c, roughness: 1 }),        // the top of a raised median
    noise: m({ color: 0x8f998c, emissive: 0x2b2f2a, roughness: 0.9 }),      // noise barrier panels
    hedge: m({ color: 0x3f5a2c, emissive: 0x121a0c, roughness: 1 }),
  });
}
// a guard-rail post (sigma profile 100 × 55 mm, 0.72 m out of the ground), one geometry for every pack
const POST = (() => { const g = new THREE.BoxGeometry(0.055, 0.72, 0.1); g.translate(0, 0.36, 0); return g; })();

// vertices (scene frame: x, height, −y), normals and triangles in growing typed arrays
class Buf {
  constructor() { this.P = new Float32Array(3 * 4096); this.N = new Float32Array(3 * 4096); this.I = new Uint32Array(8192); this.nv = 0; this.ni = 0; }
  room(nv, ni) {
    if ((this.nv + nv) * 3 > this.P.length) { const L = Math.max(this.P.length * 2, (this.nv + nv) * 3), P = new Float32Array(L), N = new Float32Array(L); P.set(this.P); N.set(this.N); this.P = P; this.N = N; }
    if (this.ni + ni > this.I.length) { const I = new Uint32Array(Math.max(this.I.length * 2, this.ni + ni)); I.set(this.I); this.I = I; }
  }
  // a strip along the points Q [{x, y, z, nx, ny}] between cross-section points (lateral w0, height h0) and (w1, h1)
  // (lateral along the point's left normal from offset o, heights from its z + dz); flat across, shared along
  strip(Q, o, w0, h0, w1, h1, dz = 0) {
    const n = Q.length; if (n < 2) return; this.room(2 * n, 6 * (n - 1));
    let el = h1 - h0, eu = -(w1 - w0); const l = Math.hypot(el, eu) || 1; el /= l; eu /= l;      // the face's normal (lateral, up)
    const v0 = this.nv, P = this.P, N = this.N;
    for (let i = 0; i < n; i++) {
      const q = Q[i], z = q.z + dz;
      for (const [w, h] of [[w0, h0], [w1, h1]]) { const k = 3 * this.nv++, x = q.x + q.nx * (o + w), y = q.y + q.ny * (o + w);
        P[k] = x; P[k + 1] = z + h; P[k + 2] = -y; N[k] = q.nx * el; N[k + 1] = eu; N[k + 2] = -q.ny * el; }
    }
    // (wound counter-clockwise seen from the side the normal points to: the faces are front faces where they are lit — wound
    // the other way, the double-sided material turned their normals away and the tops of the barriers rendered black)
    const I = this.I; for (let i = 0; i < n - 1; i++) { const a = v0 + 2 * i, j = this.ni; I[j] = a; I[j + 1] = a + 3; I[j + 2] = a + 2; I[j + 3] = a; I[j + 4] = a + 1; I[j + 5] = a + 3; this.ni += 6; }
  }
  mesh(mat, shadow) {
    if (!this.ni) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.P.slice(0, 3 * this.nv), 3)); g.setAttribute('normal', new THREE.BufferAttribute(this.N.slice(0, 3 * this.nv), 3));
    g.setIndex(new THREE.BufferAttribute(this.I.slice(0, this.ni), 1)); g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat); m.castShadow = shadow; m.receiveShadow = true; m.matrixAutoUpdate = false; return m;
  }
}
// a profile (half-widths / heights) swept along Q at offset o, mirrored about it, closed on top; heights scaled by hs
function profile(B, Q, prof, o = 0, hs = 1, dz = 0) {
  for (const s of [1, -1]) for (let k = 0; k < prof.length - 1; k++) {
    const [w0, h0] = prof[k], [w1, h1] = prof[k + 1];
    if (s > 0) B.strip(Q, o, w0, h0 * hs, w1, h1 * hs, dz); else B.strip(Q, o, -w1, h1 * hs, -w0, h0 * hs, dz);
  }
  const [w, h] = prof[prof.length - 1]; B.strip(Q, o, w, h * hs, -w, h * hs, dz);
}
// a W-beam at offset o facing side s (±1: towards +n / −n)
function wbeam(B, Q, o, s, dz = 0) {
  for (let k = 0; k < WBEAM.length - 1; k++) { const [w0, h0] = WBEAM[k], [w1, h1] = WBEAM[k + 1];
    if (s > 0) B.strip(Q, o, w0, h0, w1, h1, dz); else B.strip(Q, o, -w1, h1, -w0, h0, dz); }
}
// posts every 2 m along Q at offset o: [x, z, y, nx, ny] into list
function posts(list, Q, o, dz = 0) {
  let acc = 0, next = 1;
  for (let i = 0; i < Q.length - 1; i++) {
    const a = Q[i], b = Q[i + 1], l = Math.hypot(b.x - a.x, b.y - a.y); if (l < 1e-3) continue;
    while (next <= acc + l) { const t = (next - acc) / l, nx = a.nx + (b.nx - a.nx) * t, ny = a.ny + (b.ny - a.ny) * t;
      list.push(a.x + (b.x - a.x) * t + nx * o, a.z + (b.z - a.z) * t + dz, a.y + (b.y - a.y) * t + ny * o, nx, ny); next += 2; }
    acc += l;
  }
}
function postMesh(list, mat) {
  const n = list.length / 5; if (!n) return null;
  const im = new THREE.InstancedMesh(POST, mat, n), A = im.instanceMatrix.array;
  for (let k = 0; k < n; k++) {
    // turned about the vertical so its local x runs along the road's normal (nx, ny) → scene (nx, 0, −ny)
    const nx = list[5 * k + 3], ny = list[5 * k + 4], l = Math.hypot(nx, ny) || 1, c = nx / l, s = ny / l, o = 16 * k;
    A[o] = c; A[o + 1] = 0; A[o + 2] = -s; A[o + 3] = 0; A[o + 4] = 0; A[o + 5] = 1; A[o + 6] = 0; A[o + 7] = 0;
    A[o + 8] = s; A[o + 9] = 0; A[o + 10] = c; A[o + 11] = 0; A[o + 12] = list[5 * k]; A[o + 13] = list[5 * k + 1]; A[o + 14] = -list[5 * k + 2]; A[o + 15] = 1;
  }
  im.instanceMatrix.needsUpdate = true; im.castShadow = false; im.receiveShadow = true; im.computeBoundingSphere(); im.matrixAutoUpdate = false; return im;
}

/** The median barrier of a pack, built in steps (step(k): the samples up to k; finish(): the meshes). ctx: { surfK(P, f,
 *  d): the drawn road surface at fractional sample f, offset d; origin() }. Per sample (new packs): A.med [ax, oin, oout,
 *  mh·100] cm, A.mty (1 steel, 2 concrete, 3 raised), A.lane [own, eR, eL, kr] cm (the inner edge line sets a raised
 *  median's width), optional A.mw (raised width, dm). finish() returns {meshes, runs: [[s0, s1, ax0, ax1]]} */
export function medianBarriers(P, ctx) { const b = medianBuilder(P, ctx); b.step(Infinity); return b.finish(); }
export function medianBuilder(P, ctx) {
  const A = P.A, out = { meshes: [], runs: [] };
  if (!A.med || !A.mty) return { step: () => true, finish: () => out };
  const M = barrierMaterials(), n = P.hdr.n2, O = ctx.origin(), dx = P.hdr.ox - O.x, dy = P.hdr.oy - O.y, U = -32768;
  const chunks = new Map(), steel = new Buf(), verge = new Buf(), pls = new Map();
  const conOf = (s) => { const c = Math.floor((s - A.s2[0]) / 500); let a = chunks.get(c); if (!a) chunks.set(c, (a = new Buf())); return a; };
  // the posts in 500 m chunks too: one instanced mesh each, so the camera culls the chunks out of view (2 posts every 2 m)
  const plOf = (s) => { const c = Math.floor((s - A.s2[0]) / 500); let a = pls.get(c); if (!a) pls.set(c, (a = [])); return a; };
  // runs of samples (every 2nd: 4 m) with the same barrier type and a continuous axis
  let run = [], typ = 0;
  const flush = () => {
    if (run.length >= 2) {
      const Q = run, t = typ, h = Q.reduce((a, q) => a + q.h, 0) / Q.length;
      if (t === 2) profile(conOf(Q[0].s), Q, STEP, 0, h / 0.81);
      else if (t === 1) { wbeam(steel, Q, 0.32, 1); wbeam(steel, Q, -0.32, -1); posts(plOf(Q[0].s), Q, 0); }
      else if (t === 3) {
        // a raised median: kerb faces and the planted top, the double rail on it (mh: the block's height when under 1.2 m,
        // else the rail's top)
        // the block stands at kerb height (0.18 m): the measured top is the rail's, or a rail on a low kerb read too high
        // (a 0.7 m block with a dark top where the photo shows a narrow median with a rail)
        const hb = Math.min(0.18, h < 1.2 ? h : h - 0.75), w = Q.reduce((a, q) => a + q.w, 0) / Q.length / 2, C = conOf(Q[0].s);
        C.strip(Q, 0, w, 0, w, hb); C.strip(Q, 0, -w, hb, -w, 0);
        verge.strip(Q, 0, w, hb, -w, hb);
        wbeam(steel, Q, 0.32, 1, hb); wbeam(steel, Q, -0.32, -1, hb); posts(plOf(Q[0].s), Q, 0, hb);
      }
      out.runs.push([Q[0].s, Q[Q.length - 1].s, Q[0].ax, Q[Q.length - 1].ax]);
    }
    run = [];
  };
  // a point of the run moved along the road by u m (the direction from sample kb to ka; the height carried on by the slope)
  const ext = (q, ka, kb, u) => {
    const tx = A.cen[2 * ka] - A.cen[2 * kb], ty = A.cen[2 * ka + 1] - A.cen[2 * kb + 1], l = Math.hypot(tx, ty) || 1, g = (A.z[ka] - A.z[kb]) / l;
    const sg = u < 0 ? -1 : 1, m = Math.abs(u), ux = (tx / l) * (ka > kb ? 1 : -1) * sg, uy = (ty / l) * (ka > kb ? 1 : -1) * sg;
    return { ...q, s: q.s + u, x: q.x + ux * m, y: q.y + uy * m, z: q.z + g * (ka > kb ? 1 : -1) * u };
  };
  let k = 0;
  const step = (kMax) => {
  for (; k < Math.min(n, kMax); k += 2) {
    const ax = A.med[4 * k];
    let t = A.mty[k];
    if (ax === U || !t || t > 3) { flush(); typ = 0; continue; }
    // a 'raised median' narrower than 2 m between the axis and our inner edge line is the double rail on a narrow median
    if (t === 3 && !(A.mw && A.mw[k] > 5) && A.lane && A.lane[4 * k + 2] !== U && 2 * (ax - A.lane[4 * k + 2]) / 100 - 1.8 < 2.0) t = 1;
    const a = ax / 100, prev = run[run.length - 1];
    if (t !== typ || (prev && Math.abs(prev.ax - a) > 1.5)) { flush(); typ = t; }
    const nx = A.nor[2 * k] / 30000, ny = A.nor[2 * k + 1] / 30000, mh = A.med[4 * k + 3];
    const h = mh !== U && mh > 20 ? mh / 100 : t === 1 ? 0.75 : t === 2 ? 0.81 : 0.7;
    // the raised median's width: mapped (mw) or twice the axis' distance to the inner edge line less the 0.9 m strip
    let w = 0;
    if (t === 3) { const eL = A.lane ? A.lane[4 * k + 2] : U, mw = A.mw ? A.mw[k] / 10 : 0;
      w = mw > 0.5 ? mw : eL !== U ? 2 * (a - eL / 100 - 0.9) : 3.0; w = Math.max(1.2, Math.min(4.5, w)); }
    // its foot: a raised median stands on the road's plane at its right kerb (beyond our measured edge the drawn surface is
    // the terrain model, which holds the raised block itself); a rail or wall on the drawn surface, not above the road's
    // plane by more than 0.2 m (the same block)
    const zr = A.z[k] + (P.SL ? P.SL[k] : 0) * (t === 3 ? a - w / 2 : a), z = t === 3 ? zr : Math.min(ctx.surfK(P, k, a), zr + 0.2);
    const q = { s: A.s2[k], ax: a, h, w, x: A.cen[2 * k] + dx + nx * a, y: A.cen[2 * k + 1] + dy + ny * a, z, nx, ny };
    // at the pack's ends the run is carried on along the road to half the gap to the neighbouring pack's first sample (no
    // gap in the barrier at the seams): before the first sample, and after the last one sampled (every 2nd)
    if (k === 0 && n > 1) run.push(ext(q, 0, 1, -1));
    run.push(q);
    if (k + 2 >= n && n > 1) run.push(ext(q, n - 1, n - 2, (A.s2[n - 1] - A.s2[k]) + 1));
  }
  if (k < n && run.length >= 2) { const last = run[run.length - 1]; flush(); run = [last]; }     // (a run goes on in the next step)
  return k >= n;
  };
  const finish = () => {
    flush();
    for (const B of chunks.values()) out.meshes.push(B.mesh(M.con, true));
    out.meshes.push(steel.mesh(M.steel, false), verge.mesh(M.verge, false), ...[...pls.values()].map((pl) => postMesh(pl, M.post)));
    out.meshes = out.meshes.filter(Boolean);
    return out;
  };
  return { step, finish };
}

/** The mapped barriers: lines [{kind, pts: [[x, y]], toward: [x, y] (a point of the road they guard)}], z(x, y) the drawn
 *  ground. Guard rails: one W-beam facing the road on posts behind it; jersey barriers: the step profile; walls,
 *  retaining walls, noise barriers, hedges and fences as boxes of their typical thickness and height. */
export function mappedBarriers(lines, z) {
  const M = barrierMaterials(), K = { con: new Buf(), steel: new Buf(), noise: new Buf(), hedge: new Buf() }, pl = [];
  const BOX = { wall: ['con', 0.3, 1.6], retaining_wall: ['con', 0.4, 1.6], noise_barrier: ['noise', 0.18, 3.5], hedge: ['hedge', 1.0, 1.6], fence: ['steel', 0.04, 1.4] };
  for (const L of lines) {
    // resampled to ≤ 4 m, each point on the drawn ground with the line's own left normal
    const R = [];
    for (let i = 0; i < L.pts.length - 1; i++) { const [ax, ay] = L.pts[i], [bx, by] = L.pts[i + 1], m = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 4)); for (let j = 0; j < m; j++) R.push([ax + ((bx - ax) * j) / m, ay + ((by - ay) * j) / m]); }
    R.push(L.pts[L.pts.length - 1]); if (R.length < 2) continue;
    const Q = R.map((p, i) => { const a = R[Math.max(0, i - 1)], b = R[Math.min(R.length - 1, i + 1)], tx = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tx, ty) || 1; return { x: p[0], y: p[1], z: z(p[0], p[1]), nx: -ty / l, ny: tx / l }; });
    if (L.kind === 'guard_rail') {
      // the beam on the road's side of the posts: the side of the line the guarded road lies on
      const m = Q[Q.length >> 1], s = L.toward && (L.toward[0] - m.x) * m.nx + (L.toward[1] - m.y) * m.ny < 0 ? -1 : 1;
      wbeam(K.steel, Q, s * 0.12, s); posts(pl, Q, 0);
    } else if (L.kind === 'jersey_barrier') profile(K.con, Q, STEP);
    else if (BOX[L.kind]) { const [k, th, h] = BOX[L.kind]; profile(K[k], Q, [[th / 2, 0], [th / 2, h]]); }
    else profile(K.con, Q, [[0.1, 0], [0.1, 0.6]]);
  }
  return [K.con.mesh(M.con, true), K.noise.mesh(M.noise, true), K.hedge.mesh(M.hedge, true), K.steel.mesh(M.steel, false), postMesh(pl, M.post)].filter(Boolean);
}
