// The road anywhere on the route: the official aerial photo along the road (25 cm, strips that follow the route),
// the carriageway edges measured on it, the convoy's swept path, mapped objects and buildings, the convoy driving.
// Data streams in 5 km packs (tools/route_pack.py) fetched next to the page.
import * as THREE from 'three';
import { patch, PHOTO_TRUE, PHOTO_PARS, photoUniforms, ENV } from '../env.js';
import { inflate, b64bytes } from '../data.js';
import { inWorker, abs, photoTexture } from './dataio.js';
import { makeConvoy, makeConvoySteps } from './convoy.js';
import { buildSigns, signalGeo, signWarmList } from './signs.js';
import { makeRoads3D, roadMaterials, ROAD_XR } from './roads3d.js';
import { sweep, DEFAULTS } from './vehicle.js';
import { pooled, release } from './matpool.js';
import { slicer } from './warm.js';
import { bridgeMaterials, bridgeAccs, bridgeMeshes, Acc, block, pier as pierGeo, column, railing, guardrail, deckProfile, smooth, deck, deckSteps, depthOf, tube, tubeMaterials, XRAY_PARS, XRAY_CUT, CUT, cutPatch } from './bridges.js';
import { medianBuilder, mappedBarriers, barrierMaterials } from './barriers.js';

const DT = { '<f4': Float32Array, '<f8': Float64Array, '<i2': Int16Array, '|u1': Uint8Array, '<u2': Uint16Array, '<i4': Int32Array, '<u4': Uint32Array };
const ROWS = [45, 34, 24, 16, 12, 9, 7, 5, 3, 0, -3, -5, -7, -9, -12, -16, -24, -34, -45];
const WROWS = [300, 200, 130, 80, 45, -45, -80, -130, -200, -300];
const VROWS = [45, 40, 35, 30, 25, 20, 16, 12, 9, 6, 3, 0, -3, -6, -9, -12, -16, -20, -25, -30, -35, -40, -45];
let CONVOY_R = null;
// the road view's convoy made ahead (at idle after the map's first frame: building it takes a moment)
export async function preConvoy(veh, slice) { if (CONVOY_R) return; const it = makeConvoySteps(veh); let st; while (!(st = it.next()).done) if (slice.due()) await slice(); if (!CONVOY_R) CONVOY_R = st.value; }
// the sky light two-thirds grey on the route page: the shade under bridges and gantries stays grey, not navy (env.js)
ENV.hemiDesat = 0.65;
// the see-through over the convoy in a tube (0..0.7): one value for every road view — the pooled lid materials keep the
// uniform of the view that made them, so a value per view would leave a reopened view's lid solid (or see-through for good)
const XRAY = { value: 0 };
// the swept path of the next window ahead, computed in a background thread (sweep_worker.js, inlined by the build)
let SW = null;
function sweepWorker() {
  if (SW === null) { try { SW = typeof __SWEEP_WORKER__ === 'string' ? new Worker(URL.createObjectURL(new Blob([__SWEEP_WORKER__], { type: 'text/javascript' }))) : false; } catch { SW = false; } }
  return SW || null;
}
const V = { blade: 84.3, wheelbase: 4.8, kp_ahead: 0.6, fu_len: 6.5, root_ahead: 1.2, support: 50.0, dolly_len: 7.2 };
const SLMAX = 0.08, U16 = -32768;           // cross slope drawn up to ±8 %; int16 'unknown'
const slOf = (v) => Math.max(-SLMAX, Math.min(SLMAX, v / 10000));

async function bitmap(url) {
  const r = await fetch(url); if (!r.ok) throw new Error(url + ' ' + r.status);
  return createImageBitmap(await r.blob());
}
export async function fetchPack(base, p) {
  const id = String(p).padStart(3, '0');
  // in the data worker where one runs (the same requests and decoding there; the arrays are views made here, as below)
  const w = await inWorker('r', { json: abs(`${base}r/${id}.json`), webp: abs(`${base}r/${id}.webp`), webpW: abs(`${base}r/${id}w.webp`) });
  if (w) { const blob = new Uint8Array(w.buf, w.off, w.len), A = {}; for (const m of w.hdr.arrays) A[m.n] = new DT[m.t](blob.buffer, blob.byteOffset + m.o, m.l); return { hdr: w.hdr, A }; }
  const r = await fetch(`${base}r/${id}.json`);
  if (!r.ok) throw new Error('pack ' + p + ' ' + r.status);
  const hdr = await r.json();
  const blob = await inflate(b64bytes(hdr.blob)); delete hdr.blob;
  const A = {};
  for (const m of hdr.arrays) A[m.n] = new DT[m.t](blob.buffer, blob.byteOffset + m.o, m.l);
  // the strips of the pack stacked in one picture (and the wide band in another): cut apart here
  // one picture per pack: the strips on the left, the wide band's pictures in a column at x (older packs: a second file)
  const one = (hdr.wide || []).some((c) => c.x != null);
  const [at, aw] = await Promise.all([bitmap(`${base}r/${id}.webp`), !one && (hdr.wide || []).length ? bitmap(`${base}r/${id}w.webp`) : null]);
  await Promise.all(hdr.chunks.map(async (c) => { c.bmp = await createImageBitmap(at, 0, c.y, c.w, c.h, { imageOrientation: 'flipY' }); }));
  const src = one ? at : aw;
  if (src) await Promise.all(hdr.wide.map(async (c) => { c.bmp = await createImageBitmap(src, c.x || 0, c.y, c.w, c.h, { imageOrientation: 'flipY' }); }));
  at.close && at.close(); aw && aw.close && aw.close();
  return { hdr, A };
}

// a short route window in the session frame, 1 m samples, for the convoy's kinematics and the ground lookup
export function makeRoad(packIndex, far, opts = {}) {
  let VEH = opts.vehicle || { ...DEFAULTS };
  const base = opts.base || '', renderer = opts.renderer || null, warm = opts.warm || null;      // warm: makeWarmer (warm.js), with opts.probe (lights) and opts.cam
  let disposed = false;
  const scene = new THREE.Scene();
  const packs = new Map();        // p → {hdr, A, meshes, ox, oy}
  const loading = new Map();
  let O = null;                   // session origin, UTM33
  const roadGroup = new THREE.Group(); scene.add(roadGroup);
  const overGroup = new THREE.Group(); scene.add(overGroup);
  const objGroup = new THREE.Group(); scene.add(objGroup);
  const road3dGroup = new THREE.Group(); scene.add(road3dGroup);    // modelled road surfaces and markings (roads3d.js)
  const FOCUS = { value: new THREE.Vector3(0, -1e6, 0) };
  const ovOn = { value: 1 };
  const disposables = [];
  const keep = (x) => (disposables.push(x), x);
  const PK = packIndex.pack_km * 1000;

  // ---------------------------------------------------------------- materials
  // kind: 'strip', 'strip-vc' (the terrain under bridges, vertex colours), 'strip-ds' (roofs, both sides), 'strip-lid'
  // (the photo on a tunnel's lid: see-through over the convoy in the tube); from the pool
  XRAY.value = 0; CUT.value.set(0, 0, 0, 0); ROAD_XR.uRx.value.z = 0;
  // (the photo is cut around the convoy on screen under deep cover: cutPatch)
  const stripMat = (tex, kind = 'strip') => { const m = pooled(kind, () => { const lid = kind === 'strip-lid'; const mm = cutPatch(patch(new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 }), {
    key: lid ? 'road-strip-lid' : 'road-strip', uniforms: lid ? { ...photoUniforms, uXray: XRAY } : photoUniforms,
    frag: { pars: PHOTO_PARS + (lid ? XRAY_PARS : ''), map: (lid ? XRAY_CUT : '') + /* glsl */ `vec4 texelColor = texture2D(map, vMapUv); diffuseColor.rgb *= texelColor.rgb;`, afterLights: PHOTO_TRUE },
  })); mm.toneMapped = false; if (kind === 'strip-vc') mm.vertexColors = true; if (kind === 'strip-ds') mm.side = THREE.DoubleSide; return mm; }); m.map = tex; return m; };
  const upload = (tex) => { if (renderer && !warm) try { renderer.initTexture(tex); } catch { /* uploaded on first use instead */ } };      // (with warm: in prepare)
  const wallMat = keep(new THREE.MeshStandardMaterial({ color: 0xe6dfd2, roughness: 0.9, side: THREE.DoubleSide }));
  const lineMat = (c, o) => keep(new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
  const M_ONC = lineMat(0x7a46ff, 0.34), M_ONCL = lineMat(0x8a5cff, 0.95);
  const M_EDGE = lineMat(0x22e0ff, 0.95), M_WHEEL = lineMat(0xffb020, 0.22), M_WHEELL = lineMat(0xffa000, 0.95), M_BLADEENV = lineMat(0xff3b30, 0.7), M_BLADE = lineMat(0xff2a1a, 0.40), M_BLADEL = lineMat(0xff3020, 0.95);
  const poleMat = keep(new THREE.MeshStandardMaterial({ color: 0x8a8f94, roughness: 0.5, metalness: 0.6 }));
  const signMat = keep(new THREE.MeshStandardMaterial({ color: 0xf2f2f0, roughness: 0.5 }));
  const sigMat = keep(new THREE.MeshStandardMaterial({ color: 0x1b1d20, roughness: 0.6 }));
  const railMat = keep(new THREE.MeshStandardMaterial({ color: 0xb8bcc0, roughness: 0.35, metalness: 0.8 }));

  // ---------------------------------------------------------------- the samples (every 2 m) of all loaded packs
  const samples = [];              // sorted by s: {s, x, y, nx, ny, z, sl, L, R, env[4], off, p, k}
  let packVer = 0;      // (counts the changes of the packs in: a swept path drawn ahead of time is drawn again if one came between)
  const rebuildIndex = () => {
    packVer++;
    samples.length = 0;
    for (const [p, P] of [...packs.entries()].sort((a, b) => a[0] - b[0])) {
      const A = P.A, n = P.hdr.n2, dx = P.hdr.ox - O.x, dy = P.hdr.oy - O.y;
      for (let k = 0; k < n; k++) samples.push({ s: A.s2[k], x: A.cen[2 * k] + dx, y: A.cen[2 * k + 1] + dy, nx: A.nor[2 * k] / 30000, ny: A.nor[2 * k + 1] / 30000,
        z: A.z[k], sl: P.SL[k], L: A.edge[2 * k] / 100, R: A.edge[2 * k + 1] / 100,
        e0: A.env[4 * k] / 100, e1: A.env[4 * k + 1] / 100, e2: A.env[4 * k + 2] / 100, e3: A.env[4 * k + 3] / 100, off: A.off[k] / 100, sh: A.shift ? A.shift[k] / 100 : 0, dv: A.drv ? A.drv[k] / 100 : null, oc: A.onc ? A.onc[k] / 100 : 0,
        ow: P.OW ? P.OW[k] : NaN, lq: P.LQ ? P.LQ[k] : 255, tw: P.TW ? P.TW[k] : 1, p, k, rb: P.rbk ? P.rbk.get(k) : undefined });
    }
    grid.clear(); coarse.clear(); lastNear = -1;
    samples.forEach((q, i) => { const key = Math.floor(q.x / 40) * 65536 + Math.floor(q.y / 40); let a = grid.get(key); if (!a) grid.set(key, (a = [])); a.push(i);
      if (i % 25 === 0) { const ck = Math.floor(q.x / 1000) * 65536 + Math.floor(q.y / 1000); let c = coarse.get(ck); if (!c) coarse.set(ck, (c = [])); c.push(i); } });
  };
  const coarse = new Map();        // every 25th sample per km cell: the nearest sample for points far from the route
  let lastNear = -1;
  const grid = new Map();
  const nearest = (x, y) => {
    // near the route: the 40 m cells around the point; farther out: the nearest of every 25th sample in the km cells around
    // it, refined along the route (one search over 441 cells per call made the drive stutter)
    // most calls come from the convoy and the camera, next to the last answer: look along the route there first
    const n = samples.length;
    if (lastNear >= 0 && lastNear < n) {
      let b2 = -1, d2 = Infinity; const a0 = Math.max(0, lastNear - 30), a1 = Math.min(n - 1, lastNear + 30);
      for (let k = a0; k <= a1; k++) { const q = samples[k], d = (q.x - x) ** 2 + (q.y - y) ** 2; if (d < d2) { d2 = d; b2 = k; } }
      if (d2 < 225 && b2 > a0 && b2 < a1) { lastNear = b2; return b2; }      // within 15 m: not the other side of a tight loop
    }
    const cx = Math.floor(x / 40), cy = Math.floor(y / 40); let best = -1, bd = Infinity;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) { const a = grid.get((cx + i) * 65536 + (cy + j)); if (!a) continue;
      for (const k of a) { const q = samples[k], d = (q.x - x) ** 2 + (q.y - y) ** 2; if (d < bd) { bd = d; best = k; } } }
    if (best >= 0) { lastNear = best; return best; }
    const kx = Math.floor(x / 1000), ky = Math.floor(y / 1000);
    for (let w = 1; w <= 3 && best < 0; w++) for (let i = -w; i <= w; i++) for (let j = -w; j <= w; j++) { const a = coarse.get((kx + i) * 65536 + (ky + j)); if (!a) continue;
      for (const k of a) { const q = samples[k], d = (q.x - x) ** 2 + (q.y - y) ** 2; if (d < bd) { bd = d; best = k; } } }
    if (best < 0) return -1;
    const k0 = best;
    for (let k = Math.max(0, k0 - 25); k <= Math.min(samples.length - 1, k0 + 25); k++) { const q = samples[k], d = (q.x - x) ** 2 + (q.y - y) ** 2; if (d < bd) { bd = d; best = k; } }
    return best;
  };
  const sIndex = (s) => { let lo = 0, hi = samples.length - 1; if (hi < 0) return -1; while (lo < hi) { const m = (lo + hi) >> 1; if (samples[m].s < s) lo = m + 1; else hi = m; } return lo; };
  // interpolated sample at route distance s
  // (o: an object to fill instead of a new one, for the calls made every frame)
  const at = (s, o = null) => {
    const i = sIndex(s); if (i < 0) return null; const a = samples[Math.max(0, i - 1)], b = samples[i];
    const t = b.s > a.s ? Math.max(0, Math.min(1, (s - a.s) / (b.s - a.s))) : 0;
    const r = o || {}; r.s = s; r.x = a.x + (b.x - a.x) * t; r.y = a.y + (b.y - a.y) * t; r.nx = a.nx + (b.nx - a.nx) * t; r.ny = a.ny + (b.ny - a.ny) * t; r.z = a.z + (b.z - a.z) * t;
    r.sl = a.sl + (b.sl - a.sl) * t; r.L = a.L + (b.L - a.L) * t; r.R = a.R + (b.R - a.R) * t; r.off = a.off + (b.off - a.off) * t; r.sh = a.sh + (b.sh - a.sh) * t;
    r.dv = a.dv != null && b.dv != null ? a.dv + (b.dv - a.dv) * t : null; r.oc = Math.max(a.oc || 0, b.oc || 0); r.ow = a.ow + (b.ow - a.ow) * t; r.lq = (t < 0.5 ? a : b).lq; r.tw = (t < 0.5 ? a : b).tw;
    return r;
  };
  // per pack, once: cross slopes (±8 %) and edges as floats; the keep-right lane's left boundary, the painted edge lines and
  // the median per sample (new packs; NaN where unknown); the measured terrain beside the road (xrel: cm every 10 m at the
  // offsets xrd)
  function prepPack(P) {
    const A = P.A, n = P.hdr.n2, F = (a, i) => (a[i] === U16 ? NaN : a[i] / 100), col = (a, c, w) => { const o = new Float32Array(n); for (let k = 0; k < n; k++) o[k] = F(a, w * k + c); return o; };
    P.SL = new Float32Array(n); P.LE = new Float32Array(n); P.RE = new Float32Array(n);
    for (let k = 0; k < n; k++) { P.SL[k] = slOf(A.slope[k]); P.LE[k] = A.edge[2 * k] / 100; P.RE[k] = A.edge[2 * k + 1] / 100; }
    if (A.lane && A.lane.length >= 4 * n) { P.OW = col(A.lane, 0, 4); P.ER = col(A.lane, 1, 4); P.EL = col(A.lane, 2, 4); P.KR = col(A.lane, 3, 4); }
    if (A.med && A.med.length >= 4 * n) { P.AX = col(A.med, 0, 4); P.OI = col(A.med, 1, 4); P.OO = col(A.med, 2, 4); }
    P.LQ = A.lq && A.lq.length >= n ? A.lq : null;          // (how the lanes were found: 0 laid from the stretches around)
    const xd = P.hdr.xrd; P.XR = A.xrel && xd && xd.length ? { d: xd, nc: xd.length, n10: Math.floor(A.xrel.length / xd.length), v: A.xrel } : null;
    if (P.XR && !P.XR.n10) P.XR = null;
    // two-way traffic per sample (the route's marking runs [s, class, two-way, town])
    const mk = P.hdr.marks || []; P.TW = new Uint8Array(n).fill(1);
    for (let k = 0, j = 0; k < n; k++) { while (j + 1 < mk.length && mk[j + 1][0] <= A.s2[k]) j++; if (mk.length) P.TW[k] = mk[j][2] ? 1 : 0; }
  }
  // the measured terrain beside the road relative to the road's plane (m) at 10 m row fr (fractional), offset d: nothing on
  // the carriageway (to 0.5 m beyond its edges), interpolated across the offsets sampled; beyond the outermost one sampled
  // its value fades out towards ±300 m (the wide photo band), as beside a bridge
  function xrelAt(X, fr, d, L, R) {
    if (d <= L + 0.5 && d >= -R - 0.5) return 0;
    const r0 = Math.max(0, Math.min(X.n10 - 1, Math.floor(fr))), r1 = Math.min(X.n10 - 1, r0 + 1), t = Math.max(0, Math.min(1, fr - r0)), D = X.d, V = X.v, nc = X.nc;
    const val = (c) => { const a = V[r0 * nc + c], b = V[r1 * nc + c]; return a === U16 ? (b === U16 ? NaN : b / 100) : b === U16 ? a / 100 : (a + (b - a) * t) / 100; };
    let pd = d > 0 ? L + 0.5 : -R - 0.5, pv = 0;                 // the last point (offset, value) towards the road
    if (d > 0) { for (let c = 0; c < nc; c++) { const dc = D[c]; if (!(dc > pd)) continue; const v = val(c); if (!Number.isFinite(v)) continue; if (dc >= d) return pv + ((v - pv) * (d - pd)) / (dc - pd); pd = dc; pv = v; } }
    else { for (let c = nc - 1; c >= 0; c--) { const dc = D[c]; if (!(dc < pd)) continue; const v = val(c); if (!Number.isFinite(v)) continue; if (dc <= d) return pv + ((v - pv) * (d - pd)) / (dc - pd); pd = dc; pv = v; } }
    const ap = Math.abs(pd); return ap >= 299 ? pv : pv * Math.max(0, Math.min(1, (300 - Math.abs(d)) / (300 - ap)));
  }
  // a tunnel's lid (the terrain over and beside the tube) relative to the road (m) at route distance s, offset d
  function lidRel(T, s, d) {
    const Ld = T.lid, none = (T.H || 4.5) + 1.2;
    if (!Ld || !Ld.rel || !Ld.rel.length || !Ld.D || Ld.D.length < 2) return none;
    const nr = Ld.rel.length, fr = Math.max(0, Math.min(nr - 1, (s - Ld.s0) / (Ld.step || 4))), r0 = Math.floor(fr), r1 = Math.min(nr - 1, r0 + 1), t = fr - r0, D = Ld.D;
    const dd = Math.max(D[0], Math.min(D[D.length - 1], d)); let i = 0; while (i < D.length - 2 && D[i + 1] < dd) i++;
    const u = (dd - D[i]) / (D[i + 1] - D[i] || 1), v = (r, c) => { const x = Ld.rel[r][c]; return x == null || x === U16 ? NaN : x / 100; };
    const mix = (a, b, w) => (Number.isFinite(a) ? (Number.isFinite(b) ? a + (b - a) * w : a) : b);
    const out = mix(mix(v(r0, i), v(r0, i + 1), u), mix(v(r1, i), v(r1, i + 1), u), t);
    return Number.isFinite(out) ? out : none;
  }
  // the lid relative to the road over a tube's sample tn (walls ± 0.5 m: at least the clear height drawn + 0.65 m, the slab:
  // the lid rows within a few metres of a portal were sampled at its face or on the road before it), beside it as sampled
  function lidOver(tn, s, d) {
    const v = lidRel(tn.t, s, d);
    return d <= tn.dl + 0.5 && d >= tn.dr - 0.5 ? Math.max(v, (tn.t.H || tn.t.std || 4.5) + 0.65) : v;
  }
  // the drawn surface of pack P at fractional sample f (0 … n2 − 1), offset d (m, left +): the carriageway's plane, the
  // measured terrain beside it (xrel; older packs: the plane carried on to ±45 m), the terrain beside and under the route's
  // own bridges; in a tunnel the road in the tube, the lid above and beside it (lid: over the tube too, for trees and roofs;
  // 'road': the tube's road whatever the offset, for the overlays: the measured edges in a tube may come from its lid; on
  // the route's own bridge the deck's plane whatever the offset, so no overlay hangs from the deck's edge into the valley)
  // 'under': as lid, but inside an own deck's footprint the ground under the deck (a side road passing under the bridge)
  function surfK(P, f, d, lid = false) {
    const A = P.A, n = P.hdr.n2, k = Math.max(0, Math.min(n - 1, Math.floor(f))), k1 = Math.min(n - 1, k + 1), t = Math.max(0, Math.min(1, f - k)), kn = t < 0.5 ? k : k1;
    const z = A.z[k] + (A.z[k1] - A.z[k]) * t, sl = P.SL[k] + (P.SL[k1] - P.SL[k]) * t;
    const tn = P.tnk && P.tnk.get(kn);
    if (tn) return lid === 'road' ? z + sl * Math.max(tn.dr, Math.min(tn.dl, d)) : !lid && d <= tn.dl && d >= tn.dr ? z + sl * d : z + lidOver(tn, A.s2[k] + (A.s2[k1] - A.s2[k]) * t, d);
    const rb0 = P.rbk && P.rbk.get(kn);
    if (rb0 && rb0.on && lid === 'road') return z + sl * Math.max(-45, Math.min(45, d));
    if (rb0 && rb0.on && rb0.rel && lid === 'under' && d <= rb0.dl + 0.6 && d >= rb0.dr - 0.6) return z + rbRel(rb0, d);
    if (rb0 && rb0.tw && !rb0.on && d >= rb0.tw[0] && d <= rb0.tw[1] && lid !== 'under') return z + sl * Math.max(-45, Math.min(45, d));   // (the twin deck beyond ours)
    // within 12 m before and after a portal the terrain beside the carriageway comes from the lid rows (the terrain rows
    // of the packs are 0 in the tunnel, and a row straddling the portal would sink the slope beside it)
    const nn = lid !== 'road' && P.tnn && P.tnn.get(kn);
    if (nn) { const Ln = P.LE[k] + (P.LE[k1] - P.LE[k]) * t, Rn = P.RE[k] + (P.RE[k1] - P.RE[k]) * t; if (d > Ln + 0.5 || d < -Rn - 0.5) return z + sl * Math.max(-Rn - 0.5, Math.min(Ln + 0.5, d)) + lidRel(nn, A.s2[k] + (A.s2[k1] - A.s2[k]) * t, d) - lidRel(nn, A.s2[k] + (A.s2[k1] - A.s2[k]) * t, d > 0 ? Ln + 0.5 : -Rn - 0.5); }
    const rb = P.rbk && P.rbk.get(kn);
    if (rb && rb.rel && rb.on) return d > rb.dl + 0.6 || d < rb.dr - 0.6 ? z + rbRel(rb, d) : z + sl * Math.max(-45, Math.min(45, d));
    const L = P.LE[k] + (P.LE[k1] - P.LE[k]) * t, R = P.RE[k] + (P.RE[k1] - P.RE[k]) * t;
    if (P.XR) return z + sl * Math.max(-R - 0.5, Math.min(L + 0.5, d)) + xrelAt(P.XR, (P.hdr.i0 + 2 * (k + t)) / 10 - P.hdr.a10, d, L, R);
    const dd = Math.max(-45, Math.min(45, d));
    return rb && rb.rel && (d > L + 1 || d < -R - 1) ? z + sl * dd + rbRel(rb, d) : z + sl * dd;    // (as the photo strip on a bridge's approaches)
  }
  // the drawn surface anywhere near the loaded route: interpolated along the road between the two samples around the point
  // (no steps every 2 m), across it as surfK; lid: the lid over a tunnel's tube (trees, roofs), else the road in it
  const surfXY = (x, y, lid) => surfXYk(nearest(x, y), x, y, lid);
  const surfXYk = (k, x, y, lid) => {
    if (k < 0) return 0; const q = samples[k], P = packs.get(q.p); if (!P) return q.z;
    const u = (x - q.x) * q.ny - (y - q.y) * q.nx, q2 = samples[u >= 0 ? k + 1 : k - 1];
    const d = Math.max(-300, Math.min(300, (x - q.x) * q.nx + (y - q.y) * q.ny));
    if (!q2 || Math.abs(q2.s - q.s) > 4 || !packs.has(q2.p)) return surfK(P, q.k, d, lid);
    const t = Math.min(1, Math.abs(u) / (Math.abs(q2.s - q.s) || 1));
    if (q2.p === q.p) return surfK(P, q.k + (q2.k - q.k) * t, d, lid);
    const d2 = Math.max(-300, Math.min(300, (x - q2.x) * q2.nx + (y - q2.y) * q2.ny)), a = surfK(P, q.k, d, lid);       // across two packs' seam
    return a + (surfK(packs.get(q2.p), q2.k, d2, lid) - a) * t;
  };
  const ground = (x, y) => surfXY(x, y, false), surface = (x, y) => surfXY(x, y, true);
  // the same from a position found by toRoute (no second nearest-sample search)
  const surfR = (r, lid = false) => {
    const q = r.q, P = packs.get(q.p); if (!P) return q.z;
    const u = r.s - q.s, j = u >= 0 ? q.k + 1 : q.k - 1, d = Math.max(-300, Math.min(300, r.d));
    if (j < 0 || j >= P.hdr.n2) return surfK(P, q.k, d, lid);
    return surfK(P, q.k + (j - q.k) * Math.min(1, Math.abs(u) / (Math.abs(P.A.s2[j] - q.s) || 2)), d, lid);
  };
  // the same at route distance s
  const surfS = (s, d, lid = false) => {
    const i = sIndex(s); if (i < 0) return 0; const a = samples[Math.max(0, i - 1)], b = samples[i], Pa = packs.get(a.p), Pb = packs.get(b.p); if (!Pa || !Pb) return b.z;
    const t = b.s > a.s ? Math.max(0, Math.min(1, (s - a.s) / (b.s - a.s))) : 0;
    if (a.p === b.p) return surfK(Pa, a.k + (b.k - a.k) * t, d, lid);
    const za = surfK(Pa, a.k, d, lid); return za + (surfK(Pb, b.k, d, lid) - za) * t;
  };
  // the terrain beside and under the route's own bridges and their approaches relative to the road (<= 0): under and next
  // to the deck the terrain model is interpolated across the gap, so the valley floor nearby is used there; beyond the
  // measured ±45 m the terrain at the edge runs out to the road's level at ±300 m (the wide photo band); faded in from the
  // ends of the profile
  function rbRel(r, d) {
    if (!r || !r.rel) return null;
    const D = r.D, row = r.rel, ad = Math.abs(d);
    const at = (dd) => { dd = Math.max(D[0], Math.min(D[D.length - 1], dd)); let i = 0; while (i < D.length - 2 && D[i + 1] < dd) i++; const t = Math.max(0, Math.min(1, (dd - D[i]) / (D[i + 1] - D[i]))); return row[i] + (row[i + 1] - row[i]) * t; };
    let v = at(d);
    // under the deck the terrain model is interpolated across the gap, or keeps the deck as ground: the ground there runs
    // straight across between the terrain measured just outside the deck on both sides (a road or river below stays level
    // across, no bowl), eased in from the abutments
    if (r.on) {
      const a = (r.dr ?? -7) - 4, b = (r.dl ?? 7) + 4;
      if (d > a && d < b) { const va = at(a), vb = at(b), lin = va + (vb - va) * ((d - a) / (b - a)); v += (Math.min(v, lin) - v) * (r.mw ?? 1); }
    }
    v = Math.min(0, v);
    const out = ad <= 45 ? 1 : Math.max(0, (300 - ad) / 255);
    return v * out * (r.fade ?? 1);
  }
  // the tunnel, covered section or wildlife overpass at route distance s ({t, s0, s1, deep: a bored tunnel under deep
  // cover}), or null
  const tunnelAt = (s) => { for (const P of packs.values()) for (const e of P.tun || []) { const t = e.t; if (s >= t.s0 && s <= t.s1) return { t, s0: t.s0, s1: t.s1, deep: t.kind === 'tunnel' && t.est == null }; } return null; };
  // route coordinates of a world point: s, lateral d
  const toRoute = (x, y) => { const k = nearest(x, y); if (k < 0) return null; const q = samples[k];
    return { s: q.s + (x - q.x) * q.ny - (y - q.y) * q.nx, d: (x - q.x) * q.nx + (y - q.y) * q.ny, q }; };

  // ---------------------------------------------------------------- per-chunk meshes
  function ribbon(...args) { const it = ribbonSteps(...args); let st; while (!(st = it.next()).done); return st.value; }
  // the same in steps (a generator: it yields every 16 columns, a pack's build slices it; it returns the geometry)
  function* ribbonSteps(P, c, rows, half, sa, sb, texW, uScale = 1, hole = 0, valley = false) {
    const A = P.A, n = P.hdr.n2, cols = [];
    for (let k = 0; k < n; k++) { const s = A.s2[k]; if (s >= sa - 2.5 && s <= sb + 2.5) cols.push([k, 0]); }
    if (cols.length < 2) return null;
    // the packs' strips meet: the first and last columns of a pack reach half the gap to the neighbouring pack
    if (cols[0][0] === 0) cols.unshift([0, -1.1]);
    if (cols[cols.length - 1][0] === n - 1) cols.push([n - 1, 1.1]);
    const dx = P.hdr.ox - O.x, dy = P.hdr.oy - O.y, nr = rows.length;
    const pos = new Float32Array(cols.length * nr * 3), uv = new Float32Array(cols.length * nr * 2), off = new Uint8Array(cols.length * nr), use = new Uint8Array(cols.length);
    const deckCol = new Uint8Array(cols.length);
    const col = valley ? new Float32Array(cols.length * nr * 3).fill(1) : null, dAt = valley ? new Float32Array(cols.length * nr) : null, rbAt = [];
    // nor does a row reach over another stretch of the route (an interchange loop, the road back on the other side of a
    // valley): it stops where the route nearest to it is a different stretch (the limit eased along the road)
    // (looked up on every 2nd column of the strip, every 4th of the wide band — the nearest-sample searches far from the
    // route were the longest part of a pack's build — the others take the nearer limit of their neighbours)
    const cstep = rows[0] > 100 ? 4 : 2;
    const LIM0 = new Array(cols.length);
    for (let j = 0; j < cols.length; j++) { if ((j & 15) === 15) yield; LIM0[j] = (([k, sh], j) => {
      const lim = [Infinity, Infinity]; if (valley || !samples.length) return lim;
      if (j % cstep && j !== cols.length - 1) return null;
      const nx = A.nor[2 * k] / 30000, ny = A.nor[2 * k + 1] / 30000, x = A.cen[2 * k] + dx + ny * sh, y = A.cen[2 * k + 1] + dy - nx * sh;
      for (const sg of [1, -1]) {
        const dmax = Math.abs(rows[sg > 0 ? 0 : nr - 1]);
        for (let dd = 20; dd <= dmax; dd += 10) {
          const kk = nearest(x + nx * dd * sg, y + ny * dd * sg);
          if (kk >= 0 && Math.abs(samples[kk].s - A.s2[k]) > dd * 1.3 + 25) { lim[sg > 0 ? 0 : 1] = Math.max(8, dd - 10); break; }
        }
      }
      return lim;
    })(cols[j], j); }
    for (let j = 0; j < LIM0.length; j++) if (!LIM0[j]) { const a = LIM0[j - (j % cstep)], b = LIM0[Math.min(LIM0.length - 1, j - (j % cstep) + cstep)] || a; LIM0[j] = [Math.min(a[0], b[0]), Math.min(a[1], b[1])]; }
    const LIM = LIM0.map((_, j) => [0, 1].map((e) => { let m = Infinity; for (let i = Math.max(0, j - 6); i <= Math.min(LIM0.length - 1, j + 6); i++) m = Math.min(m, LIM0[i][e] + Math.abs(i - j) * 4); return m; }));
    const TW = new Array(cols.length);      // the tunnel over a column (its lid carries the photo), else undefined
    for (let j = 0; j < cols.length; j++) { if ((j & 15) === 15) yield; (([k, sh], j) => {
      const nx = A.nor[2 * k] / 30000, ny = A.nor[2 * k + 1] / 30000, x = A.cen[2 * k] + dx + ny * sh, y = A.cen[2 * k + 1] + dy - nx * sh, z = A.z[k], sl = P.SL[k];
      const u = Math.max(0, Math.min(1, (A.s2[k] + sh - sa) / (sb - sa)));
      const rb = P.rbk && P.rbk.get(k), tn = !valley && P.tnk ? P.tnk.get(k) : undefined; TW[j] = tn;
      // the terrain mesh under a bridge: its columns on the deck and the one before and after (joining the approach)
      if (valley) { const on = (kk) => { const r2 = P.rbk.get(kk); return r2 && r2.rel && r2.on; }; use[j] = on(k) || (k > 0 && on(k - 1)) || (k < n - 1 && on(k + 1)) ? 1 : 0; }
      else use[j] = 1;
      // on the inside of a curve the rows cross beyond its centre and fold the mesh over the road (a mound of stretched
      // photo at tight interchange loops): there they stop at 60 % of the radius
      const ka = Math.max(0, k - 3), kb = Math.min(n - 1, k + 3), dsk = A.s2[kb] - A.s2[ka];
      const kap = dsk > 0 ? Math.asin(Math.max(-1, Math.min(1, (A.nor[2 * ka] * A.nor[2 * kb + 1] - A.nor[2 * ka + 1] * A.nor[2 * kb]) / 9e8))) / dsk : 0;
      const dIn = Math.abs(kap) > 1e-5 ? 0.6 / Math.abs(kap) : Infinity;
      const lim = LIM[j];
      rows.forEach((d0, r) => { const o = j * nr + r; let d = kap > 0 ? Math.min(d0, dIn) : kap < 0 ? Math.max(d0, -dIn) : d0; d = Math.max(-lim[1], Math.min(lim[0], d)); const ad = Math.abs(d);
        let zz, dp = d;
        if (valley) {
          zz = z + (rb && rb.rel ? rbRel(rb, d) : 0) - 0.06 * Math.max(0, Math.min(1, (45 - ad) / 5));
          // under and just beside the deck the ground stays below the fascia (a row between soffit and deck top drew a
          // green line along it), away from the abutments
          if (rb && rb.on && (rb.mw ?? 1) > 0.5 && d > rb.dr - 1.5 && d < rb.dl + 1.5) { const zs = z + sl * Math.max(-45, Math.min(45, d)) - (rb.rb.dd || 1.4) - 0.6; if (zz > zs && zz < zs + (rb.rb.dd || 1.4) + 0.5) zz = zs; }
        }
        else if (tn) zz = z + lidOver(tn, A.s2[k] + sh, d);                      // in a tunnel the photo shows its lid: on the lid
        else if (rb && rb.rel && !hole && rb.on) {
          // the photo strip on the route's own bridge covers the deck only; the terrain mesh lies beside and under it (on the
          // deck the rows beyond its edges are pulled in to the parapets, so the photo reaches them). On the approaches the
          // strip follows the terrain beside the carriageway, and so does the wide band (surfK)
          // (and no further out than 0.6 m beyond the paved edges measured — the opposite carriageway's outer edge where our
          // deck carries it: the deck's asphalt top shows out to the caps there, not the valley beside a deck drawn wider than
          // the photo's, nor the photo of a tall viaduct leaning off its line)
          const oo = P.OO ? P.OO[k] : NaN, ax = P.AX ? P.AX[k] : NaN, le = P.LE[k], re = P.RE[k];
          const eR = re > 1 ? Math.max(rb.dr, Math.min(-1, -(re + 0.6))) : rb.dr;
          const eL = Number.isFinite(oo) && oo > le && oo < rb.dl + 3 ? Math.min(rb.dl, oo + 0.6) : Number.isFinite(ax) ? rb.dl : le > 1 ? Math.min(rb.dl, Math.max(1, le + 0.6)) : rb.dl;
          deckCol[j] = 1; if (d > eL + 0.3 || d < eR - 0.3) { off[o] = 1; dp = d > 0 ? eL : eR; }
          zz = z + sl * dp;
        } else zz = surfK(P, k, d, true);
        if (!valley && ad > 45) zz -= 0.15 + (ad - 45) * 0.004;                  // the wide band just under the strip's edge
        pos[3 * o] = x + nx * dp; pos[3 * o + 1] = zz; pos[3 * o + 2] = -(y + ny * dp);
        if (valley) { dAt[o] = d; rbAt[j] = rb; if (rb && rb.on) { const inn = Math.min(d - (rb.dr - 3), rb.dl + 3 - d); if (inn > 0) col.fill(Math.max(0.5, 1 - inn * 0.25), 3 * o, 3 * o + 3); } }
        uv[2 * o] = u * uScale; uv[2 * o + 1] = (dp + half) / (2 * half); });
    })(cols[j], j); }
    // under a deck over the route the photo shows the deck: there the photo just beside the deck along the road (the
    // carriageway, verges and median running on under it), in the deck's shade (vertex colours: the strip-vc material)
    let shade = null;
    if (!valley) {
      const feet = []; for (const Q of packs.values()) for (const ft of Q.deckFoot || []) feet.push(ft);
      if (feet.length) {
        const ox = [Infinity, Infinity, -Infinity, -Infinity];
        for (let o = 0; o < pos.length / 3; o++) { const x = pos[3 * o], y = -pos[3 * o + 2]; ox[0] = Math.min(ox[0], x); ox[1] = Math.min(ox[1], y); ox[2] = Math.max(ox[2], x); ox[3] = Math.max(ox[3], y); }
        const near = feet.filter((ft) => ft.bb[0] < ox[2] && ft.bb[2] > ox[0] && ft.bb[1] < ox[3] && ft.bb[3] > ox[1]);
        if (near.length) cols.forEach(([k, sh], j) => {
          if (TW[j]) return;
          let cx0 = Infinity, cy0 = Infinity, cx1 = -Infinity, cy1 = -Infinity;          // (the column's extent: most miss every deck)
          for (let r = 0; r < nr; r++) { const o = j * nr + r, x = pos[3 * o], y = -pos[3 * o + 2]; if (x < cx0) cx0 = x; if (x > cx1) cx1 = x; if (y < cy0) cy0 = y; if (y > cy1) cy1 = y; }
          const nc = near.filter((ft) => ft.bb[0] < cx1 && ft.bb[2] > cx0 && ft.bb[1] < cy1 && ft.bb[3] > cy0); if (!nc.length) return;
          const tx = A.nor[2 * k + 1] / 30000, ty = -A.nor[2 * k] / 30000;
          for (let r = 0; r < nr; r++) {
            const o = j * nr + r, x = pos[3 * o], y = -pos[3 * o + 2];
            for (const ft of nc) {
              if (x < ft.bb[0] || x > ft.bb[2] || y < ft.bb[1] || y > ft.bb[3]) continue;
              let be = Infinity, bs = null; const R = ft.run;
              for (let i = 0; i < R.length - 1; i++) { const vx = R[i + 1][0] - R[i][0], vy = R[i + 1][1] - R[i][1], l2 = vx * vx + vy * vy || 1, t = Math.max(0, Math.min(1, ((x - R[i][0]) * vx + (y - R[i][1]) * vy) / l2));
                const dd = Math.hypot(x - R[i][0] - vx * t, y - R[i][1] - vy * t); if (dd < be) { be = dd; bs = i; } }
              const m = ft.hw + 1.0; if (!(be < m)) continue;
              const ax = R[bs][0], ay = R[bs][1], vx = R[bs + 1][0] - ax, vy = R[bs + 1][1] - ay, l = Math.hypot(vx, vy) || 1, ndx = -vy / l, ndy = vx / l;
              const e = (x - ax) * ndx + (y - ay) * ndy, tn = tx * ndx + ty * ndy; if (Math.abs(tn) < 0.3) continue;
              const d1 = (ft.hw + 1.5 - e) / tn, d2 = (-(ft.hw + 1.5) - e) / tn, D = Math.abs(d1) < Math.abs(d2) ? d1 : d2;
              if (Math.abs(D) > 40) continue;
              uv[2 * o] = Math.max(0, Math.min(uScale, uv[2 * o] + (D / (sb - sa)) * uScale));
              if (!shade) shade = new Float32Array(pos.length).fill(1);
              const f = Math.abs(e) < ft.hw ? 0.55 : 0.55 + 0.45 * Math.min(1, Math.abs(e) - ft.hw);
              shade.fill(Math.min(shade[3 * o], f), 3 * o, 3 * o + 3);
              break;
            }
          }
        });
      }
    }
    const idx = [], lidIdx = [];
    for (let j = 0; j < cols.length - 1; j++) {
      if (!use[j] || !use[j + 1]) continue;
      const t0 = TW[j], t1 = TW[j + 1], tt = t0 || t1, same = (t0 && t0.t) === (t1 && t1.t);
      for (let r = 0; r < nr - 1; r++) {
        if (hole && rows[r] <= hole && rows[r + 1] >= -hole) continue;      // the wide band leaves the photo strip's width open
        const a = j * nr + r, b = a + nr;
        if ((off[a] || off[a + 1] || off[b] || off[b + 1]) && !(deckCol[j] && deckCol[j + 1])) continue;
        // a portal: the step from the road up to the lid is left open over the tube (the headwall closes it around)
        const over = tt && rows[r] > tt.dr - 0.3 && rows[r + 1] < tt.dl + 0.3;
        if (!same && over) continue;
        // the lid over the tube and 3 m beside it: its own group, see-through over the convoy in the tube
        (t0 && t1 && !hole && rows[r] > tt.dr - 3 && rows[r + 1] < tt.dl + 3 ? lidIdx : idx).push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    if (!idx.length && !lidIdx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setIndex(idx.concat(lidIdx));
    if (lidIdx.length) { g.addGroup(0, idx.length, 0); g.addGroup(idx.length, lidIdx.length, 1); }
    if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    else if (shade) g.setAttribute('color', new THREE.BufferAttribute(shade, 3));
    g.computeVertexNormals();
    if (!valley) return g;
    // the photo shows the deck, not the ground under it: under the deck the ground beside it (in the deck's shade, the
    // colour above). Each quad gets its own vertices so the two halves under the deck take the photo from their own side
    const N = g.attributes.normal.array, nv = idx.length, P2 = new Float32Array(nv * 3), N2 = new Float32Array(nv * 3), C2 = new Float32Array(nv * 3), U2 = new Float32Array(nv * 2);
    for (let q = 0; q < nv; q += 6) {
      const vs = idx.slice(q, q + 6), rb = rbAt[Math.floor(vs[0] / nr)] || rbAt[Math.floor(vs[2] / nr)];
      const dq = (dAt[vs[0]] + dAt[vs[1]] + dAt[vs[2]] + dAt[vs[4]]) / 4, m = 3;
      for (let e = 0; e < 6; e++) {
        const v = vs[e], o = q + e, rv = rbAt[Math.floor(v / nr)] || rb; let dv = dAt[v];
        // (beyond the deck's and its railings' image: further out under a tall deck, whose image leans out on the photo)
        if (rv && rv.on && dv > rv.dr - m && dv < rv.dl + m) { const o = m + 0.25 * Math.max(6, rv.depth || 0); dv = dq > (rv.dl + rv.dr) / 2 ? rv.dl + o : rv.dr - o; }
        P2.set(pos.subarray(3 * v, 3 * v + 3), 3 * o); N2.set(N.subarray(3 * v, 3 * v + 3), 3 * o); C2.set(col.subarray(3 * v, 3 * v + 3), 3 * o);
        U2[2 * o] = uv[2 * v]; U2[2 * o + 1] = (dv + half) / (2 * half);
      }
    }
    g.dispose();
    const g2 = new THREE.BufferGeometry();
    g2.setAttribute('position', new THREE.BufferAttribute(P2, 3)); g2.setAttribute('normal', new THREE.BufferAttribute(N2, 3)); g2.setAttribute('color', new THREE.BufferAttribute(C2, 3)); g2.setAttribute('uv', new THREE.BufferAttribute(U2, 2));
    return g2;
  }
  // a band between two lateral offsets (functions of the sample) lifted slightly above the strip
  function band(P, f0, f1, lift, mat, filter) {
    const A = P.A, n = P.hdr.n2, dx = P.hdr.ox - O.x, dy = P.hdr.oy - O.y;
    const pos = [], idx = []; let prev = -1;
    for (let k = 0; k < n; k++) {
      const q = { k, L: A.edge[2 * k] / 100, R: A.edge[2 * k + 1] / 100, e0: A.env[4 * k] / 100, e1: A.env[4 * k + 1] / 100, e2: A.env[4 * k + 2] / 100, e3: A.env[4 * k + 3] / 100, oc: A.onc ? A.onc[k] / 100 : 0,
        ow: P.OW ? P.OW[k] : NaN, tw: P.TW ? P.TW[k] : 1 };
      const ok = !filter || filter(q);
      if (!ok) { prev = -1; continue; }
      const x = A.cen[2 * k] + dx, y = A.cen[2 * k + 1] + dy, nx = A.nor[2 * k] / 30000, ny = A.nor[2 * k + 1] / 30000;
      const a = f0(q), b = f1(q), v = pos.length / 3;
      pos.push(x + nx * a, surfK(P, k, a, 'road') + lift, -(y + ny * a), x + nx * b, surfK(P, k, b, 'road') + lift, -(y + ny * b));
      if (prev >= 0) idx.push(prev, prev + 1, v, prev + 1, v + 1, v);
      prev = v;
    }
    if (!idx.length) return null;
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
    const m = new THREE.Mesh(g, mat); m.renderOrder = 2; return m;
  }

  // a generator run to its end in slices (undefined when the pack is dropped meanwhile)
  const runSteps = async (it, slice, gone) => { let st; while (!(st = it.next()).done) if (slice.due()) { await slice(); if (gone()) return undefined; } return st.value; };
  async function buildPack(P) {
    const meshes = P.meshes = [], slice = slicer(5), gone = () => P.dead || disposed; P.ms = {};      // (build times of the parts, ms)
    // a pack's meshes stay hidden until all of them are built and ready to draw (warm.prepare: programs, textures), then
    // show together: no frame compiles a shader or uploads a picture while driving
    if (warm) meshes.push = function (...ms) { for (const m of ms) if (m) m.visible = false; return Array.prototype.push.apply(this, ms); };
    { const t0 = performance.now(); try { planDecks(P); } catch (e) { console.warn('pack', P.hdr.p, 'planDecks', e); P.deckPlan = []; } P.ms.planDecks = +(performance.now() - t0).toFixed(1); }
    for (const c of P.hdr.chunks) {
      await slice(); if (gone()) return;
      const tex = photoTexture(c.bmp); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8; tex.flipY = false; tex.needsUpdate = true;
      tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter; upload(tex);
      const sa = c.s0, sb = c.s0 + c.ncol * P.hdr.px;
      const t0 = performance.now(), g = await runSteps(ribbonSteps(P, c, ROWS, P.hdr.half, sa, sb), slice, gone); P.ms.ribbon = Math.max(P.ms.ribbon || 0, +(performance.now() - t0).toFixed(1)); if (gone()) return;
      if (!g) continue;
      const sk = g.attributes.color ? 'strip-vc' : 'strip';      // (a deck over the route shades the photo under it)
      const m = new THREE.Mesh(g, g.groups.length ? [stripMat(tex, sk), stripMat(tex, 'strip-lid')] : stripMat(tex, sk)); m.receiveShadow = true; m.userData.tex = tex; m.userData.chunk = c.c;
      roadGroup.add(m); meshes.push(m);
      if (P.rbk && P.rbk.size) {                                // the terrain beside and under the route's own bridges
        const gv = await runSteps(ribbonSteps(P, c, VROWS, P.hdr.half, sa, sb, 0, 1, 0, true), slice, gone); if (gone()) return;
        if (gv) { const mv = new THREE.Mesh(gv, stripMat(tex, 'strip-vc')); mv.receiveShadow = true; roadGroup.add(mv); meshes.push(mv); }
      }
    }
    for (const c of P.hdr.wide || []) {
      await slice(); if (gone()) return;
      const tex = photoTexture(c.bmp); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4; tex.flipY = false; tex.needsUpdate = true; upload(tex);
      const g = await runSteps(ribbonSteps(P, c, WROWS, 300, c.s0, c.s0 + c.ncol * c.px, 0, 1, 45), slice, gone); if (gone()) return;
      if (!g) continue;
      const m = new THREE.Mesh(g, stripMat(tex, g.attributes.color ? 'strip-vc' : 'strip')); m.receiveShadow = true; m.userData.tex = tex; m.renderOrder = 1;      // (after the strips: hidden parts fail the depth test early)
      roadGroup.add(m); meshes.push(m);
    }
    // measured carriageway edges (thin cyan lines), the wheels' swept band, the blade beyond the edge
    await slice(); if (gone()) return;
    const W = 0.12;
    const add = (m) => { if (m) { overGroup.add(m); meshes.push(m); } };
    add(band(P, (q) => q.L - W, (q) => q.L + W, 0.04, M_EDGE));
    add(band(P, (q) => -q.R - W, (q) => -q.R + W, 0.04, M_EDGE));
    // where the convoy leaves its own lane (the escort closes the lane it takes): that lane in violet, the line it crosses
    // drawn strong. own: the lane's left boundary (route_lanes.py; older packs: the carriageway's middle); the oncoming lane
    // on a two-way road reaches the left edge, lane 2 of a carriageway 3.75 m
    if (P.A.onc) {
      const own = (q) => (Number.isFinite(q.ow) ? q.ow : (q.L - q.R) / 2), far = (q) => (q.tw || !Number.isFinite(q.ow) ? q.L - W : Math.min(q.L - W, own(q) + 3.75));
      add(band(P, own, far, 0.036, M_ONC, (q) => q.oc > 0.4));
      add(band(P, (q) => own(q) - 0.09, (q) => own(q) + 0.09, 0.045, M_ONCL, (q) => q.oc > 0.4));
    }
    // objects, barriers, buildings
    // each part on its own: a fault in one (a bad deck) must not lose the gates, objects and trees of the pack
    for (const f of [buildBridges, buildTunnels, buildObjects, buildSignsOf, buildGates, buildTrees]) { await slice(); if (gone()) return; const t0 = performance.now(); let ms = 0; try { const r = f(P, meshes); if (r && r.next) for (let t1 = performance.now(); !r.next().done; t1 = performance.now()) { ms += performance.now() - t1; if (slice.due()) { await slice(); if (gone()) return; } } else ms = performance.now() - t0; } catch (e) { console.warn('pack', P.hdr.p, f.name, e); } P.ms[f.name] = +(ms || performance.now() - t0).toFixed(1); }
    await slice(); if (gone()) return;
    // the modelled roads (after the bridges: decks carry their own road), a few milliseconds per slice
    { const job = R3.job(P, 4); P.msRoads = 0; P.msStep = 0; for (;;) { const t0 = performance.now(), done = job.step(), dt = performance.now() - t0; P.msRoads += dt; P.msStep = Math.max(P.msStep, dt); if (done) break; await slice(); if (gone()) return; }
      for (const m of job.meshes()) { road3dGroup.add(m); meshes.push(m); } P.msRoute = job.stats.route; }
    // the barrier in the central reservation (barriers.js) from the pack's median data, a kilometre per slice (the build
    // time is kept for the readout)
    try {
      const mb = medianBuilder(P, { surfK, origin: () => O }); P.msMedian = 0;
      for (let k = 500; ; k += 500) { await slice(); if (gone()) return; const t0 = performance.now(), done = mb.step(k); P.msMedian += performance.now() - t0; if (done) break; }
      await slice(); if (gone()) return;
      const t0 = performance.now(), med = mb.finish(); P.medRuns = med.runs; for (const m of med.meshes) { objGroup.add(m); meshes.push(m); } P.msMedian += performance.now() - t0;
    } catch (e) { console.warn('pack', P.hdr.p, 'median', e); }
    if (warm) { const t0 = performance.now(); await warm.prepare(meshes.slice(), opts.probe, opts.cam, { slice }); P.ms.prepare = +(performance.now() - t0).toFixed(1); if (gone()) return; for (const m of meshes) m.visible = true; }
    P.ready = true; packVer++;
  }
  // a pack's meshes out of the scene: geometry and photos freed, materials back to the pool (the shared ones stay)
  function dropMeshes(list) {
    for (const m of list || []) {
      m.parent && m.parent.remove(m);
      if (m.isInstancedMesh) m.dispose(); else if (m.geometry) m.geometry.dispose();      // (instanced geometry is shared)
      const t = m.userData.tex; if (t) { t.dispose(); if (t.image && t.image.close) t.image.close(); }
      for (const mt of Array.isArray(m.material) ? m.material : [m.material]) if (mt && !disposables.includes(mt)) release(mt);
    }
  }

  // ---------------------------------------------------------------- bridges
  const BK = bridgeMaterials(keep);
  const bridgeInfo = [];          // {x, y, z, b, p} for labels
  // the route's own bridges: per pack sample the terrain row across, the deck's extent (left dl / right dr of the route line)
  function prepRB(P) {
    P.rbk = new Map();
    const A = P.A, n = P.hdr.n2;
    const med = (v) => { v = v.filter(Number.isFinite).sort((x, y) => x - y); return v.length ? v[v.length >> 1] : NaN; };
    for (const rb of P.hdr.rbridges || []) {
      const nr = rb.rel ? rb.rel.length : 0, ea = rb.rel ? rb.sa : rb.s0, eb = rb.rel ? rb.sa + (nr - 1) * rb.step : rb.s1;
      const rowAt = (R, s) => { const f = Math.max(0, Math.min(nr - 1, (s - rb.sa) / rb.step)), r0 = Math.floor(f), r1 = Math.min(nr - 1, r0 + 1), t = f - r0; return R[r0].map((v, i) => v + (R[r1][i] - v) * t); };
      // one deck extent per side for the whole bridge: the measured carriageway edges over the middle of the span, widened
      // where the surface beside stays at road level above low ground over most of the span (a second carriageway on it)
      const L = rb.s1 - rb.s0; let mid = [];
      for (let k = 0; k < n; k++) { const s = A.s2[k]; if (s >= rb.s0 + 0.2 * L && s <= rb.s1 - 0.2 * L) mid.push(k); }
      if (!mid.length) for (let k = 0; k < n; k++) { const s = A.s2[k]; if (s >= rb.s0 && s <= rb.s1) mid.push(k); }
      let dl = med(mid.map((k) => A.edge[2 * k] / 100)) + 0.9, dr = -med(mid.map((k) => A.edge[2 * k + 1] / 100)) - 0.9;
      if (!Number.isFinite(dl)) dl = 6.5; if (!Number.isFinite(dr)) dr = -6.5;
      if (rb.dl != null && rb.dr != null) { dl = rb.dl; dr = rb.dr; }          // worked out for the whole bridge (route_pack.py)
      else if (rb.srel && rb.rel && mid.length) {
        for (const side of [1, -1]) {
          let ext = side > 0 ? dl : dr;
          const order = rb.D.map((_, i) => i).filter((i) => side * rb.D[i] > side * ext).sort((p, q) => side * (rb.D[p] - rb.D[q]));
          for (const i of order) {
            const d = rb.D[i]; if (Math.abs(d - ext) > 9) break;
            // (some terrain models keep the decks as ground: a row that is deep elsewhere marks a deck there too)
            const frac = mid.filter((k) => { const s = A.s2[k], rr = rowAt(rb.rel, s); return Math.abs(rowAt(rb.srel, s)[i]) < 1.0 && (rr[i] < -1.5 || Math.min(...rr) < -4); }).length / mid.length;
            if (frac < 0.6) break; ext = d + side * 1.5;
          }
          if (side > 0) dl = ext; else dr = ext;
        }
      }
      // never narrower than our carriageway: 0.9 m beyond the widest edges packed over the span (older packs took the
      // median of the raw edges: parapets stood in the lane where the carriageway widens on the deck)
      { let mL = -Infinity, mR = -Infinity; for (let k = 0; k < n; k++) { const s = A.s2[k]; if (s < rb.s0 + 1 || s > rb.s1 - 1) continue; mL = Math.max(mL, P.LE[k]); mR = Math.max(mR, P.RE[k]); }
        if (Number.isFinite(mL) && mL < 40) dl = Math.max(dl, mL + 0.9); if (Number.isFinite(mR) && mR < 40) dr = Math.min(dr, -(mR + 0.9)); }
      // spans and structure depth: wider spans over deep valleys (piers about every 30 m, 40 m over 10 m, 50 m over 20 m),
      // the girders' depth by span (1.4–4.5 m)
      if (rb.dd == null) {
        let deep = 0; if (rb.rel) for (let i = 0; i < nr; i++) { const s = rb.sa + i * rb.step; if (s >= rb.s0 && s <= rb.s1) deep = Math.max(deep, -Math.min(...rb.rel[i])); }
        const Lb = rb.s1 - rb.s0, sp = deep > 20 ? 50 : deep > 10 ? 40 : 30, np = Lb > sp ? Math.max(1, Math.round(Lb / sp)) : 0;
        rb.np = np; rb.dd = Math.max(1.4, Math.min(4.5, (Lb / Math.max(1, np)) / 17)); rb.deep = deep;
      }
      for (let k = 0; k < n; k++) {
        // the measured rows reach 12 m beyond the ends; the first and last row carry on along the approaches, fading out over
        // 60 m (the ground beside an approach embankment is low too)
        const s = A.s2[k], EXT = rb.rel ? 60 : 0; if (s < ea - EXT || s > eb + EXT) continue;
        const on = s >= rb.s0 - 0.5 && s <= rb.s1 + 0.5;
        if (!rb.rel) { if (on) P.rbk.set(k, { rb, rel: null, dl, dr, on, depth: 0, fade: 1 }); continue; }
        const rel = rowAt(rb.rel, s), fade = Math.max(0, Math.min(1, 1 - (ea - s) / EXT, 1 - (s - eb) / EXT));
        const mw = on ? Math.max(0, Math.min(1, (s - rb.s0) / 12, (rb.s1 - s) / 12)) : 0;
        const old = P.rbk.get(k); if (old && old.rel && old.fade >= fade) continue;          // a neighbouring bridge's own rows win
        P.rbk.set(k, { rb, rel, D: rb.D, dl, dr, on, depth: Math.max(0, -Math.min(...rel)), fade, mw });
      }
      // the opposite carriageway on a twin deck reaching beyond our deck's ends (route_pack.py: tw = [s0, s1, its inner,
      // outer edge]): there a deck on the left only, from its inner edge − 0.5 m to its outer edge + 0.9 m
      const tw = Array.isArray(rb.tw) && rb.tw.length >= 4 && rb.tw[3] > rb.tw[2] && rb.tw[2] > 0 ? rb.tw : null;
      if (tw) for (let k = 0; k < n; k++) {
        const s = A.s2[k]; if (s < tw[0] || s > tw[1] || (s >= rb.s0 - 0.5 && s <= rb.s1 + 0.5)) continue;
        const o = P.rbk.get(k), w = [tw[2] - 0.5, tw[3] + 0.9];
        if (o) { if (!o.on) o.tw = w; } else P.rbk.set(k, { rb, rel: null, dl, dr, on: false, depth: 0, fade: 0, tw: w });
      }
    }
  }
  // tunnels, covered sections and wildlife overpasses in the pack (hdr.tun; a mapped bridge over the route inside one,
  // 'underbridge', is the bridges'): per sample inside one its item and walls (dl > 0 > dr; a pair [at s0, at s1] eased)
  function prepTN(P) {
    P.tnk = null; P.tun = []; P.tnn = null;
    const A = P.A, n = P.hdr.n2, T = (P.hdr.tun || []).filter((t) => t && t.kind !== 'underbridge' && t.s1 > t.s0);
    if (!T.length) return;
    P.tnk = new Map(); P.tnn = new Map();         // (tnn: the samples within 12 m before / after a portal → the item)
    const wall = (v, s, t, def) => (Array.isArray(v) ? (Number.isFinite(v[0]) && Number.isFinite(v[v.length - 1]) ? v[0] + (v[v.length - 1] - v[0]) * Math.max(0, Math.min(1, (s - t.s0) / (t.s1 - t.s0))) : def) : Number.isFinite(v) ? v : def);
    for (const t of T) {
      const e = { t, H: t.H || t.std || 4.5, ks: [] };
      for (let k = 0; k < n; k++) { const s = A.s2[k]; if (s < t.s0 - 12 || s > t.s1 + 12) continue; if (s < t.s0 || s > t.s1) { if (t.lid && t.lid.rel) P.tnn.set(k, t); continue; }
        P.tnk.set(k, { t, dl: wall(t.dl, s, t, 7.5), dr: wall(t.dr, s, t, -7.5) }); e.ks.push(k); }
      if (e.ks.length) P.tun.push(e);
    }
    for (const k of P.tnk.keys()) P.tnn.delete(k);
    if (!P.tnk.size) P.tnk = null;
    if (!P.tnn.size) P.tnn = null;
  }
  // the tubes: walls, ceiling at the clear height used for drawing (H), lit band, portals with headwalls up to the lid
  const XR = { fade: 0, t: 0 };                       // (the see-through's state, eased per frame)
  const TM = tubeMaterials(keep, XRAY);
  function buildTunnels(P, meshes) {
    if (!P.tun || !P.tun.length) return;
    const A = P.A, n = P.hdr.n2, dx = P.hdr.ox - O.x, dy = P.hdr.oy - O.y, K = { wall: new Acc(), ceil: new Acc(), lit: new Acc() };
    for (const e of P.tun) {
      const t = e.t, ks = e.ks; if (ks.length < 2) continue;
      // columns as the strips: at a pack's end the tube reaches half the gap to the next pack, where it runs on
      const cols = ks.map((k) => [k, 0]);
      if (ks[0] === 0 && t.s0 < A.s2[0] - 0.5) cols.unshift([0, -1.1]);
      if (ks[ks.length - 1] === n - 1 && t.s1 > A.s2[n - 1] + 0.5) cols.push([n - 1, 1.1]);
      const pts = cols.map(([k, sh]) => { const nx = A.nor[2 * k] / 30000, ny = A.nor[2 * k + 1] / 30000; return [A.cen[2 * k] + dx + ny * sh, A.cen[2 * k + 1] + dy - nx * sh]; });
      const zr = cols.map(([k, sh]) => A.z[k] + (sh ? sh * ((A.z[Math.min(n - 1, k + 1)] - A.z[Math.max(0, k - 1)]) / ((A.s2[Math.min(n - 1, k + 1)] - A.s2[Math.max(0, k - 1)]) || 1)) : 0));
      const w = cols.map(([k]) => P.tnk.get(k)), dl = w.reduce((a, q) => a + q.dl, 0) / w.length, dr = w.reduce((a, q) => a + q.dr, 0) / w.length;
      // the headwall's top: the lid just inside the portal, highest over the tube and 2 m beside it (else the item's lidtop)
      const topAt = (k, i) => { let m = -Infinity; for (let d = dr - 2; d <= dl + 2.01; d += 1) m = Math.max(m, lidRel(t, A.s2[k], d)); return t.lid && t.lid.rel && Number.isFinite(m) ? m : Array.isArray(t.lidtop) && Number.isFinite(t.lidtop[i]) ? t.lidtop[i] : null; };
      const ends = [cols[0][1] === 0, cols[cols.length - 1][1] === 0];
      // the lowest lid over the tube at each column (the slab stays under the photo)
      const lidMin = cols.map(([k, sh]) => { let m = Infinity; for (let d = dr - 0.5; d <= dl + 0.51; d += 1) m = Math.min(m, lidOver({ t, dl, dr }, A.s2[k] + sh, d)); return m; });
      tube(K, pts, zr, dl, dr, e.H, [topAt(ks[0], 0), topAt(ks[ks.length - 1], 1)], ends, lidMin);
    }
    const wm = K.wall.mesh(TM.wall), cm = K.ceil.mesh(TM.ceil), lm = K.lit.mesh(TM.lit);
    if (lm) { lm.castShadow = false; lm.receiveShadow = false; }
    for (const m of [wm, cm, lm]) if (m) { m.matrixAutoUpdate = false; objGroup.add(m); meshes.push(m); }
  }
  // see-through tunnels: while the convoy is in a tube and the camera is above the tube's ceiling, the lid's photo and the
  // ceiling over it fade to a screen door (30 % kept), so the convoy stays visible; eased over about 0.3 s
  // Under the deep cover of a bored tunnel a slanted view from above sees the hill, not the lid: there a disc of 16 m around
  // the convoy is also cut out of what lies nearer than its roof (photo, far landscape, trees, the tube's walls: CUT)
  const CV = new THREE.Vector3(), CR = new THREE.Vector2();
  scene.onBeforeRender = (r, sc, cam) => {
    const now = performance.now(), dt = Math.min(0.1, (now - (XR.t || now)) / 1000); XR.t = now;
    let want = 0, deep = null, roof = null;
    if (convoy.group.visible && [...packs.values()].some((P) => P.tnk)) for (const part of [convoy.tractor, convoy.dolly]) {
      const e = part.matrix.elements, r2 = toRoute(e[12], -e[14]); if (!r2) continue;
      const P = packs.get(r2.q.p), tn = P && P.tnk && P.tnk.get(r2.q.k);
      if (tn && r2.d <= tn.dl + 1 && r2.d >= tn.dr - 1 && cam.position.y > e[13] + (tn.t.H || 4.5) + 0.3) { want = 1; roof = roof || [e[12], e[14], e[13] + (tn.t.H || 4.5) + 0.3]; if (tn.t.est == null && tn.t.kind === 'tunnel' && !deep) deep = [e[12], e[13], e[14]]; }
    }
    XR.fade += (want - XR.fade) * Math.min(1, dt * 8);
    XRAY.value = XR.fade < 0.02 ? 0 : 0.7 * XR.fade;
    XR.roof = roof || XR.roof;                                  // (the streets on the lid fade with it, within 45 m of the convoy)
    if (XRAY.value > 0 && XR.roof) ROAD_XR.uRx.value.set(XR.roof[0], XR.roof[1], 45, XR.roof[2]); else ROAD_XR.uRx.value.z = 0;
    ROAD_XR.uRxf.value = XRAY.value;
    if (deep && XR.fade > 0.5 && cam.isPerspectiveCamera) {
      const dist = cam.position.distanceTo(CV.set(deep[0], deep[1] + 4.7, deep[2])); CV.project(cam); r.getDrawingBufferSize(CR);
      CUT.value.set((CV.x * 0.5 + 0.5) * CR.x, (CV.y * 0.5 + 0.5) * CR.y, (16 / Math.max(1, dist * Math.tan((cam.fov * Math.PI) / 360))) * CR.y * 0.5, CV.z * 0.5 + 0.5);
    } else CUT.value.z = 0;
  };
  // the top of a deck over the route at (x, y), or null (segments [ax, ay, bx, by, hw, za, zb]); margin widens the deck
  const onDeck = (x, y, margin = 1.0) => { let best = null; for (const P of packs.values()) for (const s of P.deckSegs || []) { const vx = s[2] - s[0], vy = s[3] - s[1], l2 = vx * vx + vy * vy || 1, t = ((x - s[0]) * vx + (y - s[1]) * vy) / l2; if (t < -0.1 || t > 1.1) continue; const tt = Math.max(0, Math.min(1, t)); if (Math.hypot(x - s[0] - vx * tt, y - s[1] - vy * tt) < s[4] + margin) { const z = s[5] + (s[6] - s[5]) * tt; if (best == null || z > best) best = z; } } return best; };
  const R3 = makeRoads3D({ ground, surfK, surfR, toRoute, onDeck, origin: () => O, pack: (p) => packs.get(p) });
  // the route's corridor at (x, y): our carriageway and, on a dual carriageway, the opposite one (the median data; older
  // packs: guessed), m metres beyond their edges
  const inCorr = (x, y, m = 3) => {
    const r = toRoute(x, y); if (!r) return false;
    const Q = packs.get(r.q.p); if (!Q || Math.abs(r.s - r.q.s) > 6) return false;
    const k = r.q.k, L = r.q.L, R = r.q.R, oo = Q.OO ? Q.OO[k] : NaN;
    const far = Number.isFinite(oo) ? Math.max(L, oo) : !Q.OO && Q.TW && !Q.TW[k] && L + R >= 10.5 ? L + 3.5 + (L + R) : L;    // (no median data: guessed)
    return r.d > -(R + m) && r.d < far + m;
  };
  // the decks over the route of a pack, worked out before its photo strips are laid (the strips take the photo beside a
  // deck under it, the trees and barriers keep off it): per mapped part the run standing clear of the ground and its top;
  // a run cut short over the corridor carries on along its line until it is 3 m clear of it; side-by-side parts (a
  // footway beside a road, the tracks of a railway) merged into one deck
  function planDecks(P) {
    const dx = P.hdr.ox - O.x, dy = P.hdr.oy - O.y, plan = []; P.deckPlan = plan; P.deckSegs = []; P.deckFoot = [];
    const drawn = (x, y) => surface(x, y);
    for (const b of P.hdr.bridges || []) {
      const rail = b.sub === 'rail', dep = depthOf(b), hw = Math.max(1.8, b.w / 2);
      for (const pt of b.parts) {
        const n = pt.xy.length / 2; if (n < 2) continue;
        const pts = []; for (let i = 0; i < n; i++) pts.push([pt.xy[2 * i] + dx, pt.xy[2 * i + 1] + dy]);
        const ci = Math.min(n - 1, pt.ti || 0), kc = nearest(pts[ci][0], pts[ci][1]); if (kc < 0) continue;
        const rc = toRoute(pts[ci][0], pts[ci][1]);
        if (rc && (P.hdr.rbridges || []).some((rb) => rc.s >= rb.s0 - 8 && rc.s <= rb.s1 + 8)) continue;    // it passes under the route's own bridge
        const qc = samples[kc];
        if (!rc || Math.abs(rc.d) > qc.L + qc.R + hw + 8) continue;    // a part beside the road, not over it
        const gate0 = (P.hdr.over || []).find((o) => o.s0 === b.s0 || (o.s0s || []).includes(b.s0));
        let i0, i1, zt, unknown = false, Tabs = () => NaN, spk = 0;
        const S = pt.S ? pt.S.map((v) => (v < -900 ? NaN : v)) : null, T = pt.T ? pt.T.map((v) => (v < -900 ? NaN : v)) : null;
        // (over a tunnel the drawn surface is its lid: a crossing standing on the lid)
        const onLid = P.tnk && P.tnk.get(qc.p === P.hdr.p ? qc.k : -1);
        if (S && T && Number.isFinite(T[ci])) {
          const pr = deckProfile(S, T, ci, 1.5, rail);
          if (!pr) continue;                                    // nothing standing above the ground here
          ({ i0, i1 } = pr); spk = pr.spk;
          let off = (onLid ? drawn(pts[ci][0], pts[ci][1]) : qc.z) - T[ci];
          // the measured top over the convoy's band (route_clearance) wins over the profile (catenary masts, lamps lift it)
          if (gate0 && gate0.top != null && ci >= i0 && ci <= i1) { const sh = qc.z + gate0.top - (pr.zt[ci - i0] + off); if (Math.abs(sh) > 0.3) off += sh; }
          zt = pr.zt.map((z) => z + off);
          const o2 = off; Tabs = (j) => (Number.isFinite(T[j]) ? T[j] + o2 : NaN);
        } else {
          // no height model here: a deck at a typical height across the corridor (hatched: assumed)
          const near = pts.map((p, i) => [i, Math.hypot(p[0] - pts[ci][0], p[1] - pts[ci][1])]).filter((v) => v[1] < 45).map((v) => v[0]);
          if (near.length < 2) continue; i0 = near[0]; i1 = near[near.length - 1];
          const top = gate0 && gate0.est != null ? gate0.est + dep : 4.7 + dep;
          zt = []; for (let i = i0; i <= i1; i++) zt.push(qc.z + top);
          unknown = !(gate0 && gate0.est != null);
        }
        // a run whose end lies over the corridor carries on (the surface model's hole over a carriageway, a viaduct's
        // profile cut short): straight on at its grade (at most 6 %), beyond the mapped part's end on its line (24 m at most)
        const ext = (dir) => { const a = zt[dir > 0 ? zt.length - 1 : 0], c = zt.length > 1 ? zt[dir > 0 ? zt.length - 2 : 1] : a; return a + Math.max(-0.12, Math.min(0.12, a - c)); };
        let o0 = 0, o1 = 0;
        const line = (a, c) => { const l = Math.hypot(a[0] - c[0], a[1] - c[1]) || 1; return [a[0] + ((a[0] - c[0]) / l) * 2, a[1] + ((a[1] - c[1]) / l) * 2]; };
        while (inCorr(pts[i0][0], pts[i0][1])) { if (i0 > 0) i0--; else if (o0 < 12 && pts.length > 1) { pts.unshift(line(pts[0], pts[1])); o0++; i1++; } else break; zt.unshift(ext(-1)); }
        while (inCorr(pts[i1][0], pts[i1][1])) { if (i1 < pts.length - 1) i1++; else if (o1 < 12 && pts.length > 1) { pts.push(line(pts[pts.length - 1], pts[pts.length - 2])); o1++; i1++; } else break; zt.push(ext(1)); }
        if (i1 - i0 < 1) continue;
        const T0 = Tabs, sT = o0; if (o0) Tabs = (j) => T0(j - sT);
        plan.push({ b, rail, dep, hw, pts, i0, i1, zt, unknown, Tabs, spk, ci: ci + o0, cls: b.cls, sh: 0, light: b.cls === 'light_rail' });
      }
    }
    // side-by-side parts: parallel, at most 2 m apart (or overlapping), alongside each other and at the same height →
    // one deck over both (the longer part's line moved to the middle of both, as wide as both, its ends as far as theirs)
    const dirOf = (D) => { const a = D.pts[D.i0], c = D.pts[D.i1], l = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1; return [(c[0] - a[0]) / l, (c[1] - a[1]) / l, l, a]; };
    plan.sort((p, q) => (q.i1 - q.i0) - (p.i1 - p.i0));
    const zMid = (D) => D.zt[(D.zt.length - 1) >> 1];
    const merge = (Da, Db) => {        // Db into Da (Da's line and heights kept)
      const [ax, ay, la, a0] = dirOf(Da), bm = Db.pts[(Db.i0 + Db.i1) >> 1], e = (bm[0] - a0[0]) * -ay + (bm[1] - a0[1]) * ax - Da.sh;
      const lo = Math.min(-Da.hw, e - Db.hw), hi = Math.max(Da.hw, e + Db.hw);
      const pr = [Db.pts[Db.i0], Db.pts[Db.i1]].map((p) => (p[0] - a0[0]) * ax + (p[1] - a0[1]) * ay);
      const e0 = Math.round(-Math.min(...pr) / 2), e1 = Math.round((Math.max(...pr) - la) / 2);
      for (let k = 0; k < e0 && Da.i0 > 0; k++) { Da.i0--; Da.zt.unshift(Da.zt[0]); }
      for (let k = 0; k < e1 && Da.i1 < Da.pts.length - 1; k++) { Da.i1++; Da.zt.push(Da.zt[Da.zt.length - 1]); }
      const bandsB = (Db.bands || [[-Db.hw, Db.hw]]).map(([p, q]) => [e + p, e + q]), c = (lo + hi) / 2;
      Da.bands = [...(Da.bands || [[-Da.hw, Da.hw]]), ...bandsB].map(([p, q]) => [p - c, q - c]).sort((u, v) => u[0] - v[0])
        .reduce((o, w) => { const l = o[o.length - 1]; if (l && w[0] < l[1] - 1.0) l[1] = Math.max(l[1], w[1]); else o.push(w); return o; }, []);   // (one carriageway measured twice: one band)
      Da.sh += c; Da.hw = (hi - lo) / 2; Da.spk += Db.spk; Da.light = Da.light || Db.light; Da.unknown = Da.unknown && Db.unknown;
      if (!Da.rail && ['path', 'footway', 'cycleway', 'pedestrian', 'steps', 'track', 'unknown'].includes(Da.cls)) Da.cls = Db.cls;
      Db.drop = true;
    };
    for (let pass = 0, any = true; pass < 4 && any; pass++) {
      any = false;
      for (const Da of plan) { if (Da.drop) continue;
        for (const Db of plan) {
          if (Db === Da || Db.drop || Da.drop || Da.rail !== Db.rail) continue;
          const [ax, ay, la, a0] = dirOf(Da), [bx, by] = dirOf(Db); if (Math.abs(ax * bx + ay * by) < 0.94) continue;
          const bm = Db.pts[(Db.i0 + Db.i1) >> 1], e = (bm[0] - a0[0]) * -ay + (bm[1] - a0[1]) * ax - Da.sh, al = (bm[0] - a0[0]) * ax + (bm[1] - a0[1]) * ay;
          if (Math.abs(e) > Da.hw + Db.hw + 2.0 || al < -4 || al > la + 4) continue;
          // at another height: two decks one over the other — unless they overlap (one structure measured twice: the
          // higher profile stood on wires, masts or trees; the lower one carries both)
          const dz = zMid(Da) - zMid(Db);
          if (Math.abs(dz) > 1.5) { if (Math.abs(e) > Math.max(Da.hw, Db.hw) + 0.5) continue; if (dz > 0) { merge(Db, Da); any = true; continue; } }
          merge(Da, Db); any = true;
        }
      }
    }
    for (let j = plan.length - 1; j >= 0; j--) if (plan[j].drop) plan.splice(j, 1);
    for (const D of plan) {
      let run = D.pts.slice(D.i0, D.i1 + 1);
      if (D.sh) run = run.map((p, i) => { const a = run[Math.max(0, i - 1)], c = run[Math.min(run.length - 1, i + 1)], l = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1; return [p[0] - ((c[1] - a[1]) / l) * D.sh, p[1] + ((c[0] - a[0]) / l) * D.sh]; });
      D.run = run;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < run.length; i++) { const p = run[i]; x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
        if (i < run.length - 1) P.deckSegs.push([p[0], p[1], run[i + 1][0], run[i + 1][1], D.hw, D.zt[i], D.zt[i + 1]]); }
      const m = D.hw + 1.5; P.deckFoot.push({ bb: [x0 - m, y0 - m, x1 + m, y1 + m], run, hw: D.hw });
    }
  }
  function* buildBridges(P, meshes) {          // (a generator: it yields between bridges, the pack's build slices it)
    const dx = P.hdr.ox - O.x, dy = P.hdr.oy - O.y, A = P.A;
    if (!P.deckPlan) planDecks(P);
    const K = bridgeAccs(), drawn = (x, y) => surface(x, y);
    // decks over the route
    for (const D of P.deckPlan) {
      yield;
      const { b, rail, dep, hw, run, zt, unknown, i0, i1, pts } = D;
      const gnd = (i) => Math.min(D.Tabs(i0 + i), drawn(run[i][0], run[i][1]));
      // an embankment only where the measured ground beyond the end comes up to the deck (or the mapped part ends there)
      const rise = (i) => { const dir = i === 0 ? -1 : 1, j0 = i === 0 ? i0 : i1; if (j0 + dir < 0 || j0 + dir >= pts.length) return true;
        for (let j = j0 + dir, c = 0; j >= 0 && j < pts.length && c < 15; j += dir, c++) if (D.Tabs(j) >= zt[i] - 1.5) return true; return false; };
      const cat = rail && (D.light || D.spk >= 1 || (unknown && hw >= 4.4));
      yield* deckSteps(K, run, zt, dep, hw, rail, gnd, unknown, drawn, (i) => inCorr(run[i][0], run[i][1]), D.cls, { rise, corr: (x, y) => inCorr(x, y, 1.0), cat, bands: D.bands });
      // piers: beside the route's carriageway, never on it; on a dual carriageway outside the opposite carriageway, and in
      // the central reservation where it is 2.5 m wide or more (the median measured; older packs: the opposite carriageway
      // guessed, no central pier); more along long spans
      const zb = zt.map((z) => z - dep), used = [];
      const pier = (i) => {
        if (i < 0 || i >= run.length || used.some((u) => Math.abs(u - i) < 4)) return; used.push(i);
        const p = run[i], r = toRoute(p[0], p[1]); if (!r) return;
        const tx = r.q.ny, ty = -r.q.nx;                       // along the road below
        const ex = run[Math.min(run.length - 1, i + 1)][0] - run[Math.max(0, i - 1)][0], ey = run[Math.min(run.length - 1, i + 1)][1] - run[Math.max(0, i - 1)][1];
        const sinA = Math.abs(ex * ty - ey * tx) / (Math.hypot(ex, ey) || 1);
        const len = Math.min(hw * 4, (hw * 2) / Math.max(0.35, sinA));
        const g = gnd(i); if (!(zb[i] - g > 2.2)) return;
        pierGeo(unknown ? K.unk : K.con, p[0], p[1], tx, ty, len, g, zb[i]);
      };
      const rs = run.map((p) => toRoute(p[0], p[1]));
      const medAt = (r) => { const Q = packs.get(r.q.p); if (!Q || !Q.AX) return null; const k = r.q.k, ax = Q.AX[k], oi = Q.OI[k], oo = Q.OO[k];
        if (!Number.isFinite(ax) || !Number.isFinite(oo)) return null; const Lc = Math.min(r.q.L, ax - 0.35); return { ax, oo, wide: (Number.isFinite(oi) ? oi : 2 * ax - Lc) - Lc >= 2.5 }; };
      const lines = (r) => { const L = r.q.L, R = r.q.R, m = medAt(r); if (m) return m.wide ? [-(R + 2.4), m.ax, m.oo + 2.4] : [-(R + 2.4), m.oo + 2.4];
        return L + R >= 10.5 ? [-(R + 2.4), L + 3.5 + (L + R) + 2.4] : [L + 2.4, -(R + 2.4)]; };
      for (let i = 1; i < run.length; i++) {
        const r = rs[i], prev = rs[i - 1]; if (!r || !prev) continue;
        for (const edge of lines(r)) if ((prev.d - edge) * (r.d - edge) <= 0) pier(Math.abs(prev.d - edge) < Math.abs(r.d - edge) ? i - 1 : i);
      }
      for (let i = 6; i < run.length - 6; i += 15) {          // long bridges: every ~30 m, clear of both carriageways
        const r = rs[i]; if (!r) continue;
        const L = r.q.L, R = r.q.R, m = medAt(r), far = m ? m.oo + 1.5 : L + R >= 10.5 ? L + 3.5 + (L + R) + 1.5 : L + 2;
        if (r.d < far && r.d > -(R + 2)) continue; pier(i);
      }
      const ic = Math.max(0, Math.min(run.length - 1, D.ci - i0));
      bridgeInfo.push({ x: run[ic][0], y: run[ic][1], z: zt[ic] + 1.5, b, p: P.hdr.p, unknown });
    }
    // the route's own bridges: deck slab under the photo (its top in asphalt out to the parapets), parapets, piers and
    // abutments down to the valley floor; one extent per side for the whole bridge
    // what passes under the route's own bridges (mapped roads and tracks, not the opposite carriageway): [s, half width]
    // where it crosses the route line, so the piers keep 4 m clear of it
    const unders = [];
    if ((P.hdr.rbridges || []).length) for (const [c, w, fl, , xy] of P.hdr.roads || []) {
      if (fl & 33) continue;
      const hwR = w ? w / 20 : [6, 5, 4, 3.5, 3.2, 3, 3, 2.5, 2, 1.6, 2.5][c] ?? 2.5;
      let prev = null;
      for (let i = 0; i + 1 < xy.length; i += 2) {
        const r = toRoute(xy[i] / 10 + dx, xy[i + 1] / 10 + dy); if (!r || Math.abs(r.d) > 300) { prev = null; continue; }
        if (prev && (prev.d > 0) !== (r.d > 0) && Math.abs(prev.s - r.s) < 120) { const t = prev.d / (prev.d - r.d); if ((P.hdr.rbridges || []).some((rb) => { const sc = prev.s + (r.s - prev.s) * t; return sc > rb.s0 - 5 && sc < rb.s1 + 5; })) unders.push([prev.s + (r.s - prev.s) * t, hwR]); }
        prev = r;
      }
    }
    for (const rb of P.hdr.rbridges || []) {
      yield;
      const ks = []; for (let k = 0; k < P.hdr.n2; k++) { const s = A.s2[k]; if (s >= rb.s0 - 0.5 && s <= rb.s1 + 0.5) ks.push(k); }
      if (!ks.length) continue;
      const r0 = P.rbk.get(ks[0]); if (!r0) continue;
      const dl = r0.dl, dr = r0.dr, depth = rb.dd || 1.4;
      // columns: the samples on the bridge, reaching half the gap to the neighbouring pack where the bridge runs on there
      const cols = ks.map((k) => [k, 0]);
      if (ks[0] === 0 && rb.s0 < A.s2[0] - 0.5) cols.unshift([0, -1.1]);
      if (ks[ks.length - 1] === P.hdr.n2 - 1 && rb.s1 > A.s2[P.hdr.n2 - 1] + 0.5) cols.push([P.hdr.n2 - 1, 1.1]);
      if (cols.length < 2) continue;
      const pt = ([k, sh], d, dz = 0) => { const nx = A.nor[2 * k] / 30000, ny = A.nor[2 * k + 1] / 30000, x = A.cen[2 * k] + dx + ny * sh, y = A.cen[2 * k + 1] + dy - nx * sh;
        return [x + nx * d, y + ny * d, A.z[k] + P.SL[k] * Math.max(-45, Math.min(45, d)) + dz]; };
      // a deck between offsets dR < dL over columns cc: surface just under the photo out to the caps, slab, caps with the
      // fascia, railings (a guardrail on the cap's kerb on motorways and trunk roads)
      const slab = function* (cc, dL, dR, rails = [true, true]) {       // (a generator: it yields every 32 columns and between the railings)
        for (let i = 0; i < cc.length - 1; i++) {
          if ((i & 31) === 31) yield;
          const a = cc[i], c = cc[i + 1];
          const aL = pt(a, dL, -0.07), aR = pt(a, dR, -0.07), cL = pt(c, dL, -0.07), cR = pt(c, dR, -0.07);
          const aLb = pt(a, dL, -depth), aRb = pt(a, dR, -depth), cLb = pt(c, dL, -depth), cRb = pt(c, dR, -depth);
          K.road.quad(aR, cR, cL, aL);
          K.con.quad(aLb, cLb, cRb, aRb); K.con.quad(aLb, aL, cL, cLb); K.con.quad(cRb, cR, aR, aRb);
          for (const d of [dL, dR]) {
            const s = d > 0 ? -1 : 1, up = (p, h) => [p[0], p[1], p[2] + h];
            const p0 = pt(a, d), p1 = pt(c, d), q0 = pt(a, d + s * 1.2), q1 = pt(c, d + s * 1.2), f0 = pt(a, d - s * 0.07), f1 = pt(c, d - s * 0.07);
            K.cap.quad(up(p0, 0.22), up(p1, 0.22), up(q1, 0.22), up(q0, 0.22));
            K.cap.quad(q1, q0, up(q0, 0.22), up(q1, 0.22));
            K.cap.quad(up(f0, -depth - 0.35), up(f1, -depth - 0.35), up(f1, 0.3), up(f0, 0.3));
            K.cap.quad(up(p0, 0.3), up(p1, 0.3), up(f1, 0.3), up(f0, 0.3));
          }
        }
        for (let j = 0; j < 2; j++) {
          const d = j ? dR : dL; if (!rails[j]) continue;
          yield;
          const s = d > 0 ? -1 : 1, E = cc.map((q) => pt(q, d + s * 0.14)), G = cc.map((q) => pt(q, d + s * 1.25));
          railing(K.steel, E.map((p) => [p[0], p[1]]), 0, E.map((p) => p[2] + 0.22), 1.1);
          if (rb.cls === 'motorway' || rb.cls === 'trunk' || (dL - dR) > 14) guardrail(K.steel, G.map((p) => [p[0], p[1]]), 0, G.map((p) => p[2]));
        }
      };
      yield* slab(cols, dl, dr);
      // the opposite carriageway's twin deck where it reaches beyond ours (left only)
      const tws = [[], []];
      for (let k = Math.max(0, ks[0] - 60); k <= Math.min(P.hdr.n2 - 1, ks[ks.length - 1] + 60); k++) { const e = P.rbk.get(k); if (e && e.tw && !e.on && e.rb === rb) tws[k < ks[0] ? 0 : 1].push([k, 0]); }
      for (const t of tws) if (t.length >= 2) {
        const lo = P.rbk.get(t[0][0]).tw[0], hi = Math.max(...t.map(([k]) => P.rbk.get(k).tw[1]));
        yield* slab(t, hi, lo);
        // its piers about every 30 m where the ground under it lies low (the approach rows reach 60 m beyond our ends)
        for (let i = 7; i < t.length - 3; i += 15) {
          const k = t[i][0], r = P.rbk.get(k); if (!r || !r.rel) continue;
          const mid = (lo + hi) / 2, c = pt([k, 0], mid, 0), g = A.z[k] + rbRel(r, mid), top = c[2] - depth;
          if (top - g > 1.6) block(K.con, c[0], c[1], A.nor[2 * k] / 30000, A.nor[2 * k + 1] / 30000, Math.max(2, (hi - lo) * 0.6), 1.6, g - 0.3, top);
        }
      }
      // piers on longer bridges (wider spans over deep valleys: prepRB) and abutments at the ends, standing on the valley
      // floor; a pier is moved by up to 0.4 of a span to stay 4 m clear of a road passing under the bridge, or left out
      const L = rb.s1 - rb.s0, np = rb.np ?? (L > 30 ? Math.max(1, Math.round(L / 30)) : 0);
      const gAt = (r, k, o, g) => (r && r.rel ? A.z[k] + rbRel(r, o) : g);
      const wall = (k, th, lo = dr, hi = dl) => {
        const r = P.rbk.get(k), nx = A.nor[2 * k] / 30000, ny = A.nor[2 * k + 1] / 30000, mid = (lo + hi) / 2, c = pt([k, 0], mid, 0);
        const g = r && r.rel ? c[2] - Math.max(r.depth, 0) : c[2] - 6;
        if (c[2] - depth - g < 1.5) return;
        const w = hi - lo - 1.0;
        if (th >= 1.8) { block(K.con, c[0], c[1], nx, ny, w, th, g - 0.3, c[2] - depth); return; }       // abutment
        let gmin = Infinity; for (let o = -w / 2; o <= w / 2 + 0.01; o += Math.max(1, w / 6)) gmin = Math.min(gmin, gAt(r, k, mid + o, g));
        if (c[2] - depth - gmin < 1.6) return;
        if (c[2] - depth - gmin > 8) {
          // a tall pier: one wall per carriageway (two on a deck carrying both), tapering slightly to the top
          const nw = w > 20 ? 2 : 1;
          for (let j = 0; j < nw; j++) {
            const o0 = nw > 1 ? -w / 2 + (w / 2) * (j + 0.5) : 0, wl = Math.min(nw > 1 ? w / 2 - 2 : w - 1.5, Math.max(3, (nw > 1 ? w / 2 : w) * 0.62)), cx = c[0] + nx * o0, cy = c[1] + ny * o0;
            let gj = Infinity; for (let o = -wl / 2; o <= wl / 2 + 0.01; o += Math.max(1, wl / 4)) gj = Math.min(gj, gAt(r, k, mid + o0 + o, g));
            const top = c[2] - depth, hgt = top - gj, mdl = gj + hgt * 0.55;
            block(K.con, cx, cy, nx, ny, wl + 0.6, 2.4 + hgt * 0.012, gj - 0.3, mdl);
            block(K.con, cx, cy, nx, ny, wl, 2.0 + hgt * 0.006, mdl - 0.01, top - 0.9);
            block(K.con, cx, cy, nx, ny, wl + 1.4, 2.6, top - 0.9, top);                                // pier head
          }
          return;
        }
        // a lower pier: one cap beam under the deck on round columns, each standing on the ground below it
        const ncol = w > 9 ? Math.max(2, Math.round(w / 7.5)) : 1;
        const capD = Math.min(1.2, (c[2] - depth - gmin) * 0.22);
        block(K.con, c[0], c[1], nx, ny, w, 1.6, c[2] - depth - capD, c[2] - depth);
        for (let i = 0; i < ncol; i++) {
          const o = ncol > 1 ? -w / 2 + 1 + ((w - 2) * i) / (ncol - 1) : 0, gi = gAt(r, k, mid + o, g);
          column(K.con, c[0] + nx * o, c[1] + ny * o, 0.6, gi - 0.3, c[2] - depth - capD + 0.05, 12);
        }
      };
      const kAt = (s) => { let kk = ks[0]; for (const k of ks) if (Math.abs(A.s2[k] - s) < Math.abs(A.s2[kk] - s)) kk = k; return kk; };
      const clear = (s) => unders.every(([sc, hw]) => Math.abs(s - sc) >= hw + 4 + 1.0);
      const span = L / Math.max(1, np);
      for (let jx = 1; jx < np; jx++) {
        let s = rb.s0 + jx * span;
        if (!clear(s)) { let best = null; for (let o = 2; o <= 0.4 * span && best == null; o += 2) for (const sg of [1, -1]) if (best == null && clear(s + sg * o)) best = s + sg * o; if (best == null) continue; s = best; }
        if (s >= A.s2[ks[0]] && s <= A.s2[ks[ks.length - 1]]) wall(kAt(s), 1.4);
      }
      // abutments; where the twin deck carries on beyond this end, only under our part (to its inner edge − 0.5 m)
      const twEnd = (e) => tws[e].length >= 2 ? P.rbk.get(tws[e][0][0]).tw[0] : null;
      if (A.s2[ks[0]] - rb.s0 < 3) { const t = twEnd(0); wall(ks[0], 2.0, dr, t != null ? t : dl); }
      if (rb.s1 - A.s2[ks[ks.length - 1]] < 3) { const t = twEnd(1); wall(ks[ks.length - 1], 2.0, dr, t != null ? t : dl); }
      if (!bridgeInfo.some((bi) => bi.rb && bi.rb.s0 === rb.s0)) {
        const km = ks[Math.floor(ks.length / 2)], c = pt([km, 0], 0, 0);
        bridgeInfo.push({ x: c[0], y: c[1], z: c[2] - 2, rb, p: P.hdr.p });
      }
    }
    for (const m of bridgeMeshes(K, BK)) { objGroup.add(m); meshes.push(m); }
  }
  // trees from the surface model, coloured like their crown on the photo; broadleaf / conifer by the crown's colour
  const TREE = (() => {
    // a lumpy crown: an icosphere pushed in and out by a few fixed waves, so the crowns do not read as balls
    const ico = new THREE.IcosahedronGeometry(1, 1), pa = ico.attributes.position, v = new THREE.Vector3();     // 80 triangles a crown (thousands of trees)
    for (let i = 0; i < pa.count; i++) { v.fromBufferAttribute(pa, i); const k = 1 + 0.09 * Math.sin(5.1 * v.x + 1.3) * Math.cos(4.3 * v.z) + 0.07 * Math.sin(6.7 * v.y + 2.1 * v.x); v.multiplyScalar(k); pa.setXYZ(i, v.x, v.y, v.z); }
    ico.computeVertexNormals();
    const cone = new THREE.ConeGeometry(1, 1, 10, 3); cone.translate(0, 0.5, 0);
    const trunk = new THREE.CylinderGeometry(0.1, 0.17, 1, 6); trunk.translate(0, 0.5, 0);
    const xr = (m, key) => keep(cutPatch(patch(m, { key, uniforms: { uXray: XRAY }, frag: { pars: XRAY_PARS, map: XRAY_CUT + '#include <map_fragment>' } })));
    // (the trees on a tunnel's lid over the tube fade with it: their own materials)
    return { ico, cone, trunk, mat: keep(cutPatch(new THREE.MeshStandardMaterial({ roughness: 0.9 }))), tm: keep(cutPatch(new THREE.MeshStandardMaterial({ color: 0x6b5440, roughness: 1 }))),
      matX: xr(new THREE.MeshStandardMaterial({ roughness: 0.9 }), 'tree-x'), tmX: xr(new THREE.MeshStandardMaterial({ color: 0x6b5440, roughness: 1 }), 'trunk-x') };
  })();
  function buildTrees(P, meshes) {
    const T = P.A.tree; if (!T || !T.length) return;
    const n = T.length / 7, dx = P.hdr.ox - O.x, dy = P.hdr.oy - O.y;
    const con = [], brd = [];
    // none on a deck over the route, on the route's own deck (1 m beyond its parapets) or on the carriageway (1 m beyond
    // its edges: the forest tracks; older packs kept trunks out of ±3 m only)
    const offRoad = (x, y) => { const r = toRoute(x, y); if (!r) return true; const Q = packs.get(r.q.p), rb = Q && Q.rbk && Q.rbk.get(r.q.k);
      if (rb && rb.on && r.d > rb.dr - 1 && r.d < rb.dl + 1) return false; if (rb && rb.tw && r.d > rb.tw[0] - 1 && r.d < rb.tw[1] + 1) return false;
      return !(Math.abs(r.s - r.q.s) < 3 && r.d < r.q.L + 1 && r.d > -r.q.R - 1); };
    for (let i = 0; i < n; i++) { const x = T[7 * i] / 10 + dx, y = T[7 * i + 1] / 10 + dy; if (onDeck(x, y) || !offRoad(x, y)) continue; const r = T[7 * i + 4], g = T[7 * i + 5], b = T[7 * i + 6]; ((r < 60 && g < 75 && Math.abs(T[7 * i + 2]) > 80) ? con : brd).push(i); }
    const mm = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), ps = new THREE.Vector3(), col = new THREE.Color();
    const lin = (v) => Math.pow(v / 255, 2.2);
    const hsl = {};
    // in tiles of 250 m, so the camera and the shadow only draw the trees in their view
    const tiles = new Map();
    // over a tunnel's tube (3 m beside its walls too) a tree goes with the lid's see-through
    const overTube = (x, y) => { if (!P.tnk) return false; const r = toRoute(x, y); if (!r || r.q.p !== P.hdr.p) return false; const tn = P.tnk.get(r.q.k); return !!tn && r.d < tn.dl + 3 && r.d > tn.dr - 3; };
    for (const [ids, geo] of [[con, TREE.cone], [brd, TREE.ico]]) for (const i of ids) { const x = T[7 * i] / 10 + dx, y = T[7 * i + 1] / 10 + dy, key = (geo === TREE.cone ? 'c' : 'b') + (overTube(x, y) ? 'x' : '') + Math.floor(x / 250) + ',' + Math.floor(y / 250); let t = tiles.get(key); if (!t) tiles.set(key, (t = [[], geo, key[1] === 'x'])); t[0].push(i); }
    for (const [ids, geo, xr] of tiles.values()) {
      if (!ids.length) continue;
      const im = new THREE.InstancedMesh(geo, xr ? TREE.matX : TREE.mat, ids.length), it = new THREE.InstancedMesh(TREE.trunk, xr ? TREE.tmX : TREE.tm, ids.length);
      ids.forEach((i, k) => {
        const x = T[7 * i] / 10 + dx, y = T[7 * i + 1] / 10 + dy, h = Math.abs(T[7 * i + 2]) / 10, r = T[7 * i + 3] / 10, z = surface(x, y);     // negative height: typical (photo only)
        if (geo === TREE.cone) { ps.set(x, z + h * 0.18, -y); sc.set(r * 0.9, h * 0.82, r * 0.9); }
        else { const cr = Math.min(r, h * 0.45); ps.set(x, z + h - cr, -y); sc.set(cr, cr * 0.9, cr); }
        mm.compose(ps, q, sc); im.setMatrixAt(k, mm);
        col.setRGB(lin(T[7 * i + 4]), lin(T[7 * i + 5]), lin(T[7 * i + 6])); col.getHSL(hsl);     // the crown's colour on the photo, livelier: photos of crowns are dark and grey
        col.setHSL(Math.min(0.36, Math.max(0.17, hsl.h)), Math.min(0.75, hsl.s * 1.6 + 0.18), Math.min(0.42, hsl.l * 1.5 + 0.06)); im.setColorAt(k, col);
        ps.set(x, z, -y); sc.set(1, h * 0.6, 1); mm.compose(ps, q, sc); it.setMatrixAt(k, mm);
      });
      im.castShadow = true; im.receiveShadow = true; it.castShadow = true; im.computeBoundingSphere(); it.computeBoundingSphere();
      objGroup.add(im, it); meshes.push(im, it);
    }
  }
  // clearance gates: at every structure over the route a frame at its clear height across the convoy band
  const gates = [];
  const gateMats = { pass: lineMat(0x2fbf71, 0.28), check: lineMat(0xffb020, 0.38), fail: lineMat(0xff2a1a, 0.45), unknown: lineMat(0x9aa4ad, 0.25) };
  const gateLine = { pass: lineMat(0x2fbf71, 0.95), check: lineMat(0xffb020, 0.95), fail: lineMat(0xff2a1a, 0.95), unknown: lineMat(0x9aa4ad, 0.9) };
  function clearOf(o) { return o.signed != null ? o.signed : o.est != null ? o.est : null; }
  function verdict(o) {
    if (o.check) return 'check';
    const c = clearOf(o); if (c == null) return 'unknown';
    const need = VEH.height + VEH.heightMargin, unc = o.signed != null ? 0 : o.unc || 0.5;
    return c - unc >= need ? 'pass' : c + unc < need ? 'fail' : 'check';
  }
  const isTun = (o) => o.kind === 'tunnel' || o.kind === 'overpass';
  function buildGates(P, meshes) {
    const n = P.hdr.n2, A = P.A, inPack = (s) => s >= A.s2[0] - 1.1 && s < A.s2[n - 1] + 1.1;
    // a tunnel's or an overpass's record (s = its first portal, len) gets a gate at each portal in this pack; a portal
    // whose record is in a neighbouring pack: from the tunnel item (hdr.tun) with the same fields
    const list = [];
    for (const o of P.hdr.over || []) {
      if (isTun(o)) { for (const s of [o.s, o.s + (o.len || 0)]) if (inPack(s)) list.push([o, s]); continue; }
      if (o.kind === 'artefact' || (o.est == null && o.signed == null && o.note)) continue;     // not over the road: no gate
      if ((P.hdr.rbridges || []).some((rb) => o.s >= rb.s0 - 5 && o.s <= rb.s1 + 5) && o.kind === 'bridge') continue;   // the route runs on a bridge here
      list.push([o, o.s]);
    }
    for (const e of P.tun || []) { const t = e.t; for (const s of [t.s0, t.s1]) if (inPack(s) && !list.some(([o, s2]) => isTun(o) && Math.abs(s2 - s) < 3))
      list.push([{ ...t, prof: undefined, lid: undefined, s: t.s0, len: t.s1 - t.s0, check: t.check ?? (t.signed == null && t.phys == null) }, s]); }
    for (const [o, s0] of list) {
      if (gates.some((g) => g.o.kind === o.kind && Math.abs(g.s - s0) < 3 && isTun(o))) continue;       // (drawn by a neighbouring pack)
      const q = at(s0); if (!q) continue;
      const c = clearOf(o), v = verdict(o), h = c != null ? c : o.check && o.top ? Math.max(3, o.top - 1.8) : o.H || o.std || 4.5;
      // across the carriageway; at a tunnel's portal between its walls; labelled over the convoy's line
      const tn = isTun(o) ? (P.tun || []).find((e) => Math.abs(e.t.s0 - o.s) < 3) : null, tw = tn && P.tnk.get(tn.ks[Math.abs(s0 - tn.t.s0) < 3 ? 0 : tn.ks.length - 1]);
      const sh = q.dv != null ? q.dv : q.sh || 0, w0 = tw ? tw.dr + 0.1 : -q.R - 0.5, w1 = tw ? tw.dl - 0.1 : q.L + 0.5;
      const tx = q.ny, ty = -q.nx;     // along the route
      const x = (d) => q.x + q.nx * d, y = (d) => q.y + q.ny * d, z = (d) => q.z + q.sl * d;
      // the gate: a 1 m deep plane at the clear height plus two posts
      const g = new THREE.BufferGeometry(), P4 = [], ix = [];
      const quad = (a, b, c2, d2) => { const k = P4.length / 3; P4.push(...a, ...b, ...c2, ...d2); ix.push(k, k + 1, k + 2, k, k + 2, k + 3); };
      const pt = (d, zz, along) => [x(d) + tx * along, z(d) + zz, -(y(d) + ty * along)];
      quad(pt(w0, h, -0.5), pt(w1, h, -0.5), pt(w1, h, 0.5), pt(w0, h, 0.5));
      quad(pt(w0, 0, 0), pt(w0 + 0.25, 0, 0), pt(w0 + 0.25, h, 0), pt(w0, h, 0));
      quad(pt(w1 - 0.25, 0, 0), pt(w1, 0, 0), pt(w1, h, 0), pt(w1 - 0.25, h, 0));
      g.setAttribute('position', new THREE.Float32BufferAttribute(P4, 3)); g.setIndex(ix);
      const m = new THREE.Mesh(g, gateMats[v]); m.renderOrder = 4; overGroup.add(m); meshes.push(m);
      const lg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...pt(w0, h, 0)), new THREE.Vector3(...pt(w1, h, 0))]);
      const l = new THREE.Line(lg, gateLine[v]); l.renderOrder = 5; overGroup.add(l); meshes.push(l);
      // (its label stacked above the passage flags, which stand 5 m over the road)
      gates.push({ o, s: s0, x: q.x + q.nx * sh, y: q.y + q.ny * sh, z: q.z + Math.max(h + 0.6, 7.4), v, c, m, l, p: P.hdr.p });
    }
  }
  function refreshGates() { for (const g of gates) { const v = verdict(g.o); g.v = v; g.m.material = gateMats[v]; g.l.material = gateLine[v]; } }
  // typical heights (m) of mapped objects where nothing measured is known (German practice: RiLSA, RPS, DIN EN 40)
  const OBJ_H = { street_lamp: 9.0, traffic_signals: 4.2, stop: 2.6, give_way: 2.6, information: 2.8, bus_stop: 2.8, power_pole: 9.0, power_tower: 30.0,
    bollard: 0.9, barrier: 1.2, toll_booth: 4.5, camera: 5.5, speed_camera: 2.5, mast: 15, tower: 25, other: 2.5 };
  const objects = [];            // {x, y, cls, h, src, p} for labels and the blade check
  function signGeo(kind) {
    const g = [];
    const mk = (shape, col, z) => { const sg = new THREE.ShapeGeometry(shape); sg.translate(0, 0, z); const n = sg.attributes.position.count, c = new Float32Array(n * 3); for (let i = 0; i < n; i++) c.set(col, 3 * i); sg.setAttribute('color', new THREE.BufferAttribute(c, 3)); g.push(sg); };
    const poly = (pts) => { const sh = new THREE.Shape(); pts.forEach(([x, y], i) => (i ? sh.lineTo(x, y) : sh.moveTo(x, y))); sh.closePath(); return sh; };
    if (kind === 'give_way') { const r = 0.5; mk(poly([[-r, r * 0.58], [r, r * 0.58], [0, -r * 1.15]]), [0.8, 0.05, 0.05], 0.03); const q = 0.32; mk(poly([[-q, q * 0.5], [q, q * 0.5], [0, -q * 1.1]]), [0.96, 0.96, 0.95], 0.035); }
    else if (kind === 'stop') { const pts = []; for (let k = 0; k < 8; k++) { const a = (k + 0.5) / 8 * Math.PI * 2; pts.push([Math.cos(a) * 0.42, Math.sin(a) * 0.42]); } mk(poly(pts), [0.8, 0.05, 0.05], 0.03); }
    else { mk(poly([[-0.45, -0.35], [0.45, -0.35], [0.45, 0.35], [-0.45, 0.35]]), kind === 'bus_stop' ? [0.95, 0.8, 0.1] : [0.08, 0.3, 0.7], 0.03); }
    const m = mergeGeos(g); m.translate(0, 2.2, 0); return m;
  }
  function mergeGeos(list) {
    const gs = list.map((g) => (g.index ? g.toNonIndexed() : g)); let n = 0; for (const g of gs) { if (!g.attributes.normal) g.computeVertexNormals(); n += g.attributes.position.count; }
    const P = new Float32Array(n * 3), N = new Float32Array(n * 3), Cc = new Float32Array(n * 3); let o = 0;
    for (const g of gs) { P.set(g.attributes.position.array, 3 * o); N.set(g.attributes.normal.array, 3 * o); if (g.attributes.color) Cc.set(g.attributes.color.array, 3 * o); else Cc.fill(0.6, 3 * o, 3 * (o + g.attributes.position.count)); o += g.attributes.position.count; }
    const m = new THREE.BufferGeometry(); m.setAttribute('position', new THREE.BufferAttribute(P, 3)); m.setAttribute('normal', new THREE.BufferAttribute(N, 3)); m.setAttribute('color', new THREE.BufferAttribute(Cc, 3)); return m;
  }
  const colGeo = (g, col) => { const n = g.attributes.position.count, c = new Float32Array(n * 3); for (let i = 0; i < n; i++) c.set(col, 3 * i); g.setAttribute('color', new THREE.BufferAttribute(c, 3)); return g; };
  const OBJ_GEO = {};
  function objGeo(kind) {
    if (OBJ_GEO[kind]) return OBJ_GEO[kind];
    const G = [], GREY = [0.55, 0.57, 0.6], DARK = [0.06, 0.06, 0.07];
    const pole = (h, r = 0.08) => { const g = new THREE.CylinderGeometry(r * 0.8, r, h, 8); g.translate(0, h / 2, 0); return colGeo(g, GREY); };
    if (kind === 'traffic_signals' || kind === 'traffic_signals_arm') return (OBJ_GEO[kind] = signalGeo(kind === 'traffic_signals_arm'));
    if (kind === 'street_lamp') {
      G.push(pole(9, 0.1)); const arm = new THREE.BoxGeometry(0.1, 0.1, 1.8); arm.translate(0, 8.9, 0.85); G.push(colGeo(arm, GREY));
      const hd = new THREE.BoxGeometry(0.35, 0.15, 0.7); hd.translate(0, 8.8, 1.7); G.push(colGeo(hd, [0.95, 0.92, 0.8]));
    } else if (['stop', 'give_way', 'information', 'bus_stop'].includes(kind)) { G.push(pole(2.6, 0.04), signGeo(kind)); }
    else if (kind === 'power_pole') { G.push(colGeo(pole(10, 0.15), [0.36, 0.27, 0.18])); const x = new THREE.BoxGeometry(2.2, 0.12, 0.12); x.translate(0, 9.6, 0); G.push(colGeo(x, [0.36, 0.27, 0.18])); }
    else if (kind === 'power_tower') { const t = new THREE.CylinderGeometry(0.5, 2.8, 32, 4, 1, true); t.translate(0, 16, 0); G.push(colGeo(t, [0.5, 0.52, 0.55])); }
    else if (kind === 'bollard') { const g = new THREE.CylinderGeometry(0.1, 0.1, 0.9, 8); g.translate(0, 0.45, 0); G.push(colGeo(g, [0.95, 0.95, 0.95])); }
    else { G.push(pole(OBJ_H[kind] || 2.5, 0.07)); }
    return (OBJ_GEO[kind] = mergeGeos(G));
  }
  const objMat = keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.3, side: THREE.DoubleSide }));
  const OBJ_BASE = { traffic_signals: 4.2, street_lamp: 9.0, power_pole: 10.0, power_tower: 32.0, bollard: 0.9 };   // modelled height of objGeo
  const SCALE_H = new Set(['street_lamp', 'power_pole', 'power_tower', 'camera', 'speed_camera', 'mast', 'tower', 'toll_booth']);
  const OBJ_COL = { traffic_signals: 0xff3b30, traffic_signals_arm: 0xff3b30, street_lamp: 0xffd34d, stop: 0xff3b30, give_way: 0xff3b30, information: 0x2f8cff, bus_stop: 0xffcc00,
    power_pole: 0xb07a3c, power_tower: 0xb07a3c, bollard: 0xffffff, barrier: 0xff8a00, toll_booth: 0xff8a00, camera: 0xb36bff, speed_camera: 0xb36bff };
  const DISC_GEO = keep((() => { const g = new THREE.RingGeometry(0.55, 0.95, 24); g.rotateX(-Math.PI / 2); return g; })());
  const DISC_MAT = keep(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6, toneMapped: false }));
  // the route's signs (route_signs.py: speed limits, town signs, height limits, zebra crossings, guide posts) and the map's
  // stop, give-way and bus-stop nodes, with their real faces, sizes and mounting
  const SIGN_OF = { stop: '206', give_way: '205', bus_stop: '224' };
  // the speed in force at s for our direction (dir > 0) or the opposite one: the pack's speed runs (route_signs.py)
  const speedAt = (P, s, dir) => { const R = P.hdr.spd; if (!R || !R.length) return 0; let k = 0; while (k + 1 < R.length && R[k + 1][0] <= s) k++; return dir > 0 ? R[k][1] : R[k][2]; };
  function buildSignsOf(P, meshes) {
    const L = [];
    // sizes follow the speed of the traffic approaching the sign (sp; the old packs: 50 for a limit of 50 or less, else 100)
    for (const [s, d, dir, code, v, sp] of P.hdr.signs || []) {
      const q = at(s); if (!q) continue;
      if (code === '620' && tunnelAt(s)) continue;                  // (no guide posts in a tube: they would stand on its lid)
      const x = q.x + q.nx * d, y = q.y + q.ny * d;
      const e = { x, y, z: ground(x, y), yaw: dir > 0 ? Math.atan2(-q.ny, -q.nx) : Math.atan2(q.ny, q.nx), code, v, speed: sp || (code === '274' && v <= 50 ? 50 : 100), wide: false };
      if (code === 'gantry') {
        // over our carriageway when mapped on it, else over the other one (16 m around the mapped point, clear of ours);
        // the ends ordered so that the boards face the traffic they serve (left to right for ours)
        const onc = d > -q.R - 0.5 && d < q.L + 0.5, a = onc ? q.L + 1.5 : d > 0 ? d + 8 : Math.min(-q.R - 1.5, d + 8), b = onc ? -q.R - 1.5 : d > 0 ? Math.max(q.L + 1.5, d - 8) : d - 8;
        const [da, db] = dir > 0 ? [a, b] : [b, a];
        e.span = [q.x + q.nx * da, q.y + q.ny * da, q.x + q.nx * db, q.y + q.ny * db]; e.z = q.z;
      }
      L.push(e);
    }
    for (const o of P.mapSigns || []) {
      const r = toRoute(o.x, o.y); if (!r) continue;
      let yaw;
      if (Math.abs(r.d) <= r.q.L + r.q.R + 4) yaw = r.d <= 0 ? Math.atan2(-r.q.ny, -r.q.nx) : Math.atan2(r.q.ny, r.q.nx);   // on the route: for our or the oncoming direction
      else { const px = r.q.x, py = r.q.y, fx = o.x - px, fy = o.y - py, fl = Math.hypot(fx, fy) || 1; yaw = Math.atan2(fx / fl, -fy / fl); }   // on a side road, facing its traffic
      L.push({ x: o.x, y: o.y, z: ground(o.x, o.y), yaw, code: o.code, v: null, speed: speedAt(P, r.s, r.d <= 0 ? 1 : -1) || 50, wide: false });
    }
    if (!L.length) return;
    for (const m of buildSigns(L)) { objGroup.add(m); meshes.push(m); }
  }
  // rotation about the vertical of a roadside object (local +z → map direction (fx, fy) at yaw atan2(fx, -fy)): street
  // furniture turns its arm (+z) towards the carriageway; a signal looks at the traffic it serves (+z against the
  // direction of travel on its side, the carriageway at its -x). Beyond the route's carriageway (a side road) both face
  // the route / the side road's approach.
  function objYaw(x, y, signal) {
    const r = toRoute(x, y); if (!r) return 0;
    const q = r.q, nx = q.nx, ny = q.ny;
    if (Math.abs(r.d) > q.L + q.R + 6) { let fx = q.x - x, fy = q.y - y; const l = Math.hypot(fx, fy) || 1; fx /= l; fy /= l; if (signal) { fx = -fx; fy = -fy; } return Math.atan2(fx, -fy); }
    if (!signal) return r.d > 0 ? Math.atan2(-nx, ny) : Math.atan2(nx, -ny);
    return r.d > 0 ? Math.atan2(ny, nx) : Math.atan2(-ny, -nx);
  }
  function buildObjects(P, meshes) {
    const A = P.A, dx = P.hdr.ox - O.x, dy = P.hdr.oy - O.y, cls = P.hdr.objc;
    const nObj = A.obj_c.length, byKind = new Map();
    for (let i = 0; i < nObj; i++) {
      const c = cls[A.obj_c[i]]; if (c === 'other') continue;
      const x = A.obj_xy[2 * i] + dx, y = A.obj_xy[2 * i + 1] + dy;
      const hm = A.obj_h ? A.obj_h[i] / 10 : 0;          // measured height (surface model / map), dm; 0 = unknown
      const hs = A.obj_hs ? A.obj_hs[i] : 0;
      const h = hm > 0 ? hm : OBJ_H[c] || 2.5;
      const src = hm > 0 ? (hs === 1 ? 'measured' : 'mapped') : hs === 2 ? 'typical (surface model disturbed here)' : 'typical';
      objects.push({ x, y, cls: c, h, src, kerb: A.obj_k ? A.obj_k[i] : 0, p: P.hdr.p });
      if (SIGN_OF[c]) { (P.mapSigns || (P.mapSigns = [])).push({ x, y, code: SIGN_OF[c] }); continue; }
      // signals over a wide carriageway (two lanes or more each way) hang from a mast arm reaching over the lanes
      let kind = c;
      if (c === 'traffic_signals') { const r = toRoute(x, y); if (r && Math.abs(r.d) < r.q.L + r.q.R + 4 && r.q.L + r.q.R >= 10) kind = 'traffic_signals_arm'; }
      let a = byKind.get(kind); if (!a) byKind.set(kind, (a = [])); a.push([x, y, h]);
    }
    const mm = new THREE.Matrix4(), q4 = new THREE.Quaternion(), sc = new THREE.Vector3(1, 1, 1), ps = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const disc = [];
    for (const [c, list] of byKind) {
      const im = new THREE.InstancedMesh(objGeo(c), objMat, list.length); im.castShadow = true;
      const base = OBJ_BASE[c] || OBJ_H[c] || 2.5;
      const sig = c.startsWith('traffic_signals');
      list.forEach(([x, y, h], k) => { q4.setFromAxisAngle(up, objYaw(x, y, sig));
        const z = ground(x, y); sc.set(1, SCALE_H.has(c) ? Math.max(0.6, Math.min(2.2, h / base)) : 1, 1);
        mm.compose(ps.set(x, z, -y), q4, sc); im.setMatrixAt(k, mm); disc.push([x, y, z, c]); });
      im.instanceMatrix.needsUpdate = true; objGroup.add(im); meshes.push(im);
    }
    // a coloured ring on the ground at every object's foot, so signals, signs and poles stand out on the photo from far up
    if (disc.length) {
      const dm = new THREE.InstancedMesh(DISC_GEO, DISC_MAT, disc.length), col = new THREE.Color();
      disc.forEach(([x, y, z, c], k) => { sc.set(1, 1, 1); q4.identity(); mm.compose(ps.set(x, z + 0.06, -y), q4, sc); dm.setMatrixAt(k, mm); dm.setColorAt(k, col.setHex(OBJ_COL[c] || 0xd0d4d8)); });
      dm.renderOrder = 3; objGroup.add(dm); meshes.push(dm);
    }
    // mapped barriers (barriers.js: guard rails as W-beams on posts, jersey barriers in the step profile, walls, noise
    // barriers, hedges and fences as boxes). Left out: what is mapped on an overpass deck (its parapets), across the
    // carriageway or inside it (its edges clipped to the median and to the hard shoulder), and what lies on the median's
    // axis where the median barrier is drawn from the median data
    const clip = (r) => { const Q = packs.get(r.q.p), k = r.q.k, ax = Q && Q.AX ? Q.AX[k] : NaN, eR = Q && Q.ER ? Q.ER[k] : NaN;
      return { L: Number.isFinite(ax) ? Math.min(r.q.L, ax - 0.6) : Q && !Q.TW[k] && r.q.L + r.q.R >= 10.5 ? r.q.L - 1.3 : r.q.L, R: Number.isFinite(eR) ? Math.min(r.q.R, 3.5 - eR) : r.q.R,
        ax, med: Number.isFinite(ax) && Q.A.mty && Q.A.mty[k] > 0 }; };
    let o = 0; const bars = [];
    for (let b = 0; b < A.bar_n.length; b++) {
      const n = A.bar_n[b], c = P.hdr.barc[A.bar_c[b]], pts = [];
      for (let j = 0; j < n; j++) pts.push([A.bar_xy[2 * (o + j)] + dx, A.bar_xy[2 * (o + j) + 1] + dy]);
      o += n; if (c === 'kerb' || n < 2) continue;
      let cur = [], toward = null;
      const flush = () => { if (cur.length >= 2) bars.push({ kind: c, pts: cur, toward }); cur = []; };
      for (let j = 0; j < n - 1; j++) {
        const [x0, y0] = pts[j], [x1, y1] = pts[j + 1], r0 = toRoute(x0, y0), r1 = toRoute(x1, y1);
        let keep = !!(r0 && r1) && onDeck((x0 + x1) / 2, (y0 + y1) / 2, 0.5) == null;
        if (keep) {
          const c0 = clip(r0), c1 = clip(r1), inBand = (r, q) => r.d < q.L + 0.2 && r.d > -(q.R + 0.2);
          if ((inBand(r0, c0) && inBand(r1, c1)) || (r0.d > c0.L && r1.d < -c1.R) || (r1.d > c1.L && r0.d < -c0.R)) keep = false;
          else if (c0.med && c1.med && Math.abs(r0.d - c0.ax) < 2.5 && Math.abs(r1.d - c1.ax) < 2.5) keep = false;
          if (keep && !toward) toward = [r0.q.x, r0.q.y];
        }
        if (!keep) { flush(); continue; }
        if (!cur.length) cur.push(pts[j]); cur.push(pts[j + 1]);
      }
      flush();
    }
    for (const m of mappedBarriers(bars, surface)) { objGroup.add(m); meshes.push(m); }      // (over a tube: on its lid)
    // buildings: walls plain, roofs carry the photo of the strip they stand on (planar, from above)
    o = 0; const wp = [], wi = [];
    const roofs = new Map();      // chunk → {pos, uv, idx}
    for (let b = 0; b < A.bld_n.length; b++) {
      const n = A.bld_n[b], h = A.bld_h[b];
      const ring = []; for (let j = 0; j < n; j++) ring.push([A.bld_xy[2 * (o + j)] + dx, A.bld_xy[2 * (o + j) + 1] + dy]);
      o += n;
      let zmin = Infinity; for (const [x, y] of ring) zmin = Math.min(zmin, surface(x, y));
      const zt = zmin + h;
      for (let j = 0; j < n; j++) { const [x0, y0] = ring[j], [x1, y1] = ring[(j + 1) % n], v = wp.length / 3;
        wp.push(x0, zmin - 1, -y0, x1, zmin - 1, -y1, x1, zt, -y1, x0, zt, -y0); wi.push(v, v + 1, v + 2, v, v + 2, v + 3); }
      // roof: fan triangulation via THREE.ShapeUtils, uv on the strip
      const cxy = ring.reduce((a, p) => [a[0] + p[0] / n, a[1] + p[1] / n], [0, 0]);
      const rc = toRoute(cxy[0], cxy[1]); if (!rc) continue;
      const ch = P.hdr.chunks.find((c) => rc.s >= c.s0 && rc.s < c.s0 + c.ncol * P.hdr.px); if (!ch) continue;
      const tri = THREE.ShapeUtils.triangulateShape(ring.map(([x, y]) => new THREE.Vector2(x, y)), []);
      let R = roofs.get(ch.c); if (!R) roofs.set(ch.c, (R = { pos: [], uv: [], idx: [], ch }));
      const v0 = R.pos.length / 3;
      for (const [x, y] of ring) { const t = toRoute(x, y) || rc; R.pos.push(x, zt, -y);
        R.uv.push((t.s - ch.s0) / (ch.ncol * P.hdr.px), (Math.max(-45, Math.min(45, t.d)) + P.hdr.half) / (2 * P.hdr.half)); }
      for (const t of tri) R.idx.push(v0 + t[0], v0 + t[2], v0 + t[1]);
    }
    if (wi.length) { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(wp, 3)); g.setIndex(wi); g.computeVertexNormals();
      const m = new THREE.Mesh(g, wallMat); m.castShadow = true; m.receiveShadow = true; objGroup.add(m); meshes.push(m); }
    for (const R of roofs.values()) {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(R.pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(R.uv, 2)); g.setIndex(R.idx); g.computeVertexNormals();
      const sm = roadGroup.children.find((m) => m.userData.tex && m.userData.chunk === R.ch.c);
      const tex = sm ? sm.userData.tex : null;
      const mat = tex ? stripMat(tex, 'strip-ds') : wallMat;
      const m = new THREE.Mesh(g, mat); m.castShadow = true; objGroup.add(m); meshes.push(m);
    }
  }

  // ---------------------------------------------------------------- loading around a position
  let chain = Promise.resolve();
  async function ensure(s, first = false) {
    const p0 = Math.floor(s / PK), want = [p0 - 1, p0, p0 + 1].filter((p) => packIndex.packs.includes(p));
    if (first) want.sort((a, b) => Math.abs(a - p0) - Math.abs(b - p0));      // the pack under s first, its neighbours after it
    const jobs = [];
    for (const p of want) {
      if (packs.has(p) || loading.has(p)) continue;
      // fetched side by side, taken in and built one after the other in the order asked (the pack under s first): the
      // first pack is built sooner, and what a pack takes from those already in (the session's origin, the seams) is the
      // same on every run
      const fetched = fetchPack(base, p); fetched.catch(() => {});
      const job = chain = chain.then(() => fetched).then(async (P) => {
        if (disposed) return;
        if (!O) O = { x: P.hdr.ox, y: P.hdr.oy };
        packs.set(p, P); prepPack(P); prepRB(P); prepTN(P); rebuildIndex();
        await buildPack(P);
        if ((P.hdr.rbridges || []).length) farAt = null;          // the far landscape goes below the new bridges' valleys
        loading.delete(p);
      }).catch((e) => { loading.delete(p); console.warn(e); });
      loading.set(p, job); jobs.push(job);
    }
    // drop far packs
    for (const [p, P] of packs) if (Math.abs(p - p0) > 2) { P.dead = true; for (let k = gates.length - 1; k >= 0; k--) if (gates[k].p === p) gates.splice(k, 1); for (let k = objects.length - 1; k >= 0; k--) if (objects[k].p === p) objects.splice(k, 1); for (let k = bridgeInfo.length - 1; k >= 0; k--) if (bridgeInfo[k].p === p) bridgeInfo.splice(k, 1); dropMeshes(P.meshes); P.meshes = []; packs.delete(p); rebuildIndex(); }
    if (first) { await (loading.get(p0) || Promise.resolve()); return packs.has(p0); }      // show the road as soon as its own pack is in
    await Promise.all(jobs);
    return want.every((p) => packs.has(p)) || want.length === 0;
  }
  const available = (s) => packIndex.packs.includes(Math.floor(s / PK));

  // ---------------------------------------------------------------- the convoy's pose from the route (kinematics as in route_swept.py)
  const convoy = CONVOY_R || (CONVOY_R = makeConvoy(VEH)); scene.add(convoy.group);
  // the swept path of the user's vehicle over a window of the route (1 m), recomputed when the convoy leaves it
  let LIVE = null;
  const liveGroup = new THREE.Group(); scene.add(liveGroup);
  const M_OFF = lineMat(0xff1ed2, 0.85);
  let NEXT = null, nextReq = 0, reqId = 0;
  function windowAt(sc) {
    const sa = Math.max(samples[0].s, sc - 260), sb = Math.min(samples[samples.length - 1].s, sc + 1600);
    const n = Math.floor(sb - sa); if (n < 120) return null;
    const P = new Float64Array(2 * n), N = new Float64Array(2 * n), HL = new Float32Array(n), HR = new Float32Array(n), SH = new Float32Array(n);
    let HO = null;
    // the convoy's line (route_lanes.py): keeping right, in the right lane of a carriageway, the oncoming lane or lane 2
    // only where the swept path needs it (older packs: the carriageway's middle on one-way roads). HO: the left boundary
    // of the convoy's own lane from its line (the sweep keeps the wheels inside it where it can; 1e3 = not known)
    for (let i = 0; i < n; i++) { const q = at(sa + i); if (!q) return null; const sh = q.dv != null ? q.dv : q.sh || 0;
      P[2 * i] = q.x + q.nx * sh; P[2 * i + 1] = q.y + q.ny * sh; N[2 * i] = q.nx; N[2 * i + 1] = q.ny; HL[i] = Math.max(0.5, q.L - sh); HR[i] = Math.max(0.5, q.R + sh); SH[i] = sh;
      if (Number.isFinite(q.ow)) { if (!HO) HO = new Float32Array(n).fill(1e3); HO[i] = q.ow - sh; } }
    return { sa, sb, n, P, N, HL, HR, HO, SH };
  }
  function computeLive(sc) {
    const w = windowAt(sc); if (!w) return null;
    const t0 = performance.now();
    w.res = sweep(VEH, w.P, w.N, w.HL, w.HR, 0, w.HO); w.ms = performance.now() - t0;
    LIVE = w; NEXT = null;
    buildLive();
    return LIVE;
  }
  // the window around sc from the worker (where one runs): LIVE once it is in; meanwhile the convoy is not drawn (a sweep
  // over 1.9 km takes the main thread a third of a second here). Resolves true when LIVE covers sc
  let liveReq = null;
  function requestLive(sc) {
    const W = sweepWorker(); if (!W) return Promise.resolve(!!computeLive(sc));
    if (liveReq && sc >= liveReq.w.sa + 140 && sc <= liveReq.w.sb - 260 && liveReq.veh === VEH) return liveReq.p;
    const w = windowAt(sc); if (!w) return Promise.resolve(false);
    const id = ++reqId, veh = VEH, t0 = performance.now();
    const req = { w, veh, p: null };
    req.p = new Promise((res) => {
      const onMsg = (e) => { if (e.data.id !== id) return; W.removeEventListener('message', onMsg); if (liveReq === req) liveReq = null;
        if (disposed || veh !== VEH) return res(false); w.res = e.data.res; w.ms = performance.now() - t0; LIVE = w; NEXT = null; buildLive(); res(true); };
      W.addEventListener('message', onMsg);
      W.postMessage({ id, v: VEH, P: w.P, N: w.N, HL: w.HL, HR: w.HR, HO: w.HO });
    });
    liveReq = req; return req.p;
  }
  // the next window, computed in the background while the convoy drives through this one
  function prefetchLive(sc) {
    const W = sweepWorker(); if (!W || nextReq) return;
    const w = windowAt(sc); if (!w) return;
    const id = (nextReq = ++reqId), veh = VEH, t0 = performance.now();
    const onMsg = (e) => { if (e.data.id !== id) return; W.removeEventListener('message', onMsg); if (nextReq === id) nextReq = 0;
      if (disposed || veh !== VEH) return; w.res = e.data.res; w.ms = performance.now() - t0; NEXT = w;
      // its drawing made now, in slices, beside the one shown: the switch to it in a frame is then a swap
      (async () => { const sl = slicer(4), ver = packVer, list = []; for (const m of liveSteps(w, list)) { if (sl.due()) await sl(); if (NEXT !== w || disposed) break; }
        if (NEXT === w && !disposed) { w.meshes = list; w.ver = ver; } else for (const m of list) m.geometry.dispose(); })();
    };
    W.addEventListener('message', onMsg);
    W.postMessage({ id, v: VEH, P: w.P, N: w.N, HL: w.HL, HR: w.HR, HO: w.HO });
  }
  function buildLive() {
    for (const m of liveGroup.children.splice(0)) m.geometry.dispose();
    const L = LIVE; if (!L) return;
    // drawn ahead of time (prefetchLive) with the same packs in: taken as it is
    if (L.meshes && L.ver === packVer) { for (const m of L.meshes) liveGroup.add(m); L.meshes = null; return; }
    if (L.meshes) { for (const m of L.meshes) m.geometry.dispose(); L.meshes = null; }
    const list = []; for (const _ of liveSteps(L, list));
    for (const m of list) liveGroup.add(m);
  }
  // the swept path's drawing for window L into list, one strip a step (a generator)
  function* liveSteps(L, list) {
    const { P, N, SH, res, n } = L;
    // on the drawn surface (in a tunnel: on its road), offsets from the convoy's line
    const strip = (f0, f1, lift, mat, ok) => {
      const pos = [], idx = []; let prev = -1;
      for (let i = 0; i < n; i++) {
        if (!res.valid[i] || (ok && !ok(i))) { prev = -1; continue; }
        const a = f0(i), b = f1(i), x = P[2 * i], y = P[2 * i + 1], nx = N[2 * i], ny = N[2 * i + 1], v0 = pos.length / 3, s = L.sa + i;
        pos.push(x + nx * a, surfS(s, SH[i] + a, 'road') + lift, -(y + ny * a), x + nx * b, surfS(s, SH[i] + b, 'road') + lift, -(y + ny * b));
        if (prev >= 0) idx.push(prev, prev + 1, v0, prev + 1, v0 + 1, v0); prev = v0;
      }
      if (!idx.length) return;
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
      const m = new THREE.Mesh(g, mat); m.renderOrder = 2; list.push(m);
    };
    const E = res.env;
    strip((i) => E[4 * i + 1], (i) => E[4 * i], 0.03, M_WHEEL); yield;
    // outlines: the wheels' band (amber) and the blade's outer sweep (thin red), drawn everywhere so the reserve is visible
    for (const c of [0, 1]) { strip((i) => E[4 * i + c] - 0.07, (i) => E[4 * i + c] + 0.07, 0.04, M_WHEELL); yield; }
    for (const c of [2, 3]) { strip((i) => E[4 * i + c] - 0.05, (i) => E[4 * i + c] + 0.05, 0.042, M_BLADEENV); yield; }
    strip((i) => L.HL[i], (i) => E[4 * i + 2], 0.035, M_BLADE, (i) => E[4 * i + 2] > L.HL[i] + 0.05); yield;
    strip((i) => E[4 * i + 3], (i) => -L.HR[i], 0.035, M_BLADE, (i) => E[4 * i + 3] < -L.HR[i] - 0.05); yield;
    strip((i) => E[4 * i + 2] - 0.08, (i) => E[4 * i + 2] + 0.08, 0.045, M_BLADEL, (i) => E[4 * i + 2] > L.HL[i] + 0.05); yield;
    strip((i) => E[4 * i + 3] - 0.08, (i) => E[4 * i + 3] + 0.08, 0.045, M_BLADEL, (i) => E[4 * i + 3] < -L.HR[i] - 0.05); yield;
    // wheels off the measured carriageway
    strip((i) => L.HL[i], (i) => L.HL[i] + Math.max(0.3, -res.wc[i]), 0.05, M_OFF, (i) => res.wc[i] < 0 && E[4 * i] > L.HL[i] - 0.05); yield;
    strip((i) => -L.HR[i] - Math.max(0.3, -res.wc[i]), (i) => -L.HR[i], 0.05, M_OFF, (i) => res.wc[i] < 0 && E[4 * i + 1] < -L.HR[i] + 0.05);
  }
  function setVehicle(v) { VEH = { ...v }; LIVE = null; NEXT = null; nextReq = 0; liveReq = null; if (convoy.setDimsAsync) convoy.setDimsAsync(VEH, slicer(5)); else convoy.setDims && convoy.setDims(VEH); refreshGates(); }
  const pose = new Float32Array(14); let nextSoon = false, liveSoon = false;
  function poseAt(s) {
    if (!samples.length) return null;
    if (!LIVE || s < LIVE.sa + 140 || s > LIVE.sb - 260) {
      if (NEXT && s >= NEXT.sa + 140 && s <= NEXT.sb - 260) { LIVE = NEXT; NEXT = null; buildLive(); }
      else if (sweepWorker()) { if (!liveSoon) { liveSoon = true; setTimeout(() => { liveSoon = false; if (!disposed) requestLive(s); }, 0); } return null; }      // (asked in a task of its own, not in the frame)
      else if (!computeLive(s)) return null;
    }
    if (s > LIVE.sb - 900 && LIVE.sb < samples[samples.length - 1].s - 50 && !(NEXT && NEXT.sa > LIVE.sa) && !nextReq && !nextSoon) { nextSoon = true; setTimeout(() => { nextSoon = false; if (!disposed) prefetchLive(s + 100); }, 0); }      // (its window made in a task of its own, not in the frame)
    const f = s - LIVE.sa, i = Math.floor(f), t = f - i;
    if (i < 0 || i >= LIVE.n - 1 || !LIVE.res.valid[i] || !LIVE.res.valid[i + 1]) return null;
    const A = LIVE.res.pose;
    for (let k = 0; k < 14; k++) pose[k] = A[i * 14 + k] * (1 - t) + A[(i + 1) * 14 + k] * t;
    return pose;
  }
  // the live swept-path values at s: wheel clearance, blade beyond the edge, and the worst over the window ahead
  function liveAt(s) {
    if (!LIVE) return null; const i = Math.round(s - LIVE.sa); if (i < 0 || i >= LIVE.n || !LIVE.res.valid[i]) return null;
    const r = LIVE.res; let wmin = Infinity, wAt = 0, bmax = 0, bAt = 0;
    for (let k = i; k < Math.min(LIVE.n, i + 1500); k++) { if (!r.valid[k]) continue; if (r.wc[k] < wmin) { wmin = r.wc[k]; wAt = k; } const b = Math.max(r.bL[k], r.bR[k]); if (b > bmax) { bmax = b; bAt = k; } }
    return { wc: r.wc[i], bL: r.bL[i], bR: r.bR[i], off: r.off[i], ahead: { wmin, wAtS: LIVE.sa + wAt, bmax, bAtS: LIVE.sa + bAt }, ms: LIVE.ms };
  }

  // ---------------------------------------------------------------- far landscape: the country map's picture and relief around the view
  let farMesh = null, farAt = null;
  function updateFar(s) {
    const q = at(s); if (!q || !far) return;
    if (farAt && Math.hypot(q.x - farAt.x, q.y - farAt.y) < 6000) return;
    farAt = { x: q.x, y: q.y };
    const P0 = packs.values().next().value; if (!P0) return;
    const T = P0.hdr.toMap, ox = O.x - P0.hdr.ox, oy = O.y - P0.hdr.oy, Mx = far.map;
    const NR = 44, NS = 96, Rm = 25000;
    const pos = [], uv = [], idx = [];
    // under the route's own bridges the valley floor: the far landscape stays below it within 350 m of the bridge
    const deep = samples.filter((qq, i) => qq.rb && qq.rb.depth > 1 && i % 4 === 0);
    for (let r = 0; r <= NR; r++) for (let a = 0; a < NS; a++) {
      const rr = 30 + Rm * Math.pow(r / NR, 1.9), th = (a / NS) * Math.PI * 2;
      const x = q.x + Math.cos(th) * rr, y = q.y + Math.sin(th) * rr;
      const mx = T[0] * (x + ox) + T[1] * (y + oy) + T[2], my = T[3] * (x + ox) + T[4] * (y + oy) + T[5];
      let z = far.height(mx, my);
      const k = nearest(x, y);
      // well under the wide photo band: 2.5 m under the drawn surface there (the band's measured terrain, the valley below
      // a bridge; beyond its ±300 m its edge), eased into the country map's relief from 320 m out
      if (k >= 0) { const qq = samples[k], dd = Math.hypot(x - qq.x, y - qq.y); const t = Math.max(0, Math.min(1, (dd - 320) / 2500));
        const zs = surfXYk(k, x, y, true) - 2.5, zb = (dd < 300 ? Math.min(qq.z - 3.0 - (qq.rb && qq.rb.depth ? qq.rb.depth : 0), zs) : zs) - Math.max(0, dd - 300) * 0.002;
        z = dd < 350 ? Math.min(zb, zb * (1 - t) + z * t) : zb * (1 - t) + z * t;
        for (const b of deep) { if (Math.abs(b.x - x) > 350 || Math.abs(b.y - y) > 350) continue; const db = Math.hypot(b.x - x, b.y - y); if (db < 350) z = Math.min(z, b.z - 3.0 - b.rb.depth * Math.min(1, (350 - db) / 100)); } }
      else z = Math.min(z, q.z + (rr - 2000) * 0.02);
      pos.push(x, z, -y); uv.push((mx - Mx.x0) / (Mx.x1 - Mx.x0), (my - Mx.y0) / (Mx.y1 - Mx.y0));
    }
    for (let r = 0; r < NR; r++) for (let a = 0; a < NS; a++) { const a2 = (a + 1) % NS, i0 = r * NS + a, i1 = r * NS + a2, i2 = i0 + NS, i3 = i1 + NS; idx.push(i0, i2, i1, i1, i2, i3); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
    if (farMesh) { scene.remove(farMesh); farMesh.geometry.dispose(); }
    farMesh = new THREE.Mesh(g, farMat); farMesh.renderOrder = 2; farMesh.receiveShadow = false; scene.add(farMesh);
  }
  const farMat = keep(cutPatch(patch(new THREE.MeshStandardMaterial({ map: far ? far.tex : null, roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 4 }), {
    key: 'road-far', frag: { map: /* glsl */ `vec4 texelColor = texture2D(map, vMapUv); diffuseColor.rgb *= pow(texelColor.rgb, vec3(1.1));` } })));

  function setOverlay(on) { overGroup.visible = on; liveGroup.visible = on; }
  // ---------------------------------------------------------------- warm-up
  // every kind of surface a pack can bring, on an empty triangle (nothing to see): its shaders and shadow shaders are
  // made ready (warm.js) once the view is up, not when a pack first brings it while driving; then removed (warmDone),
  // the pooled materials go back to the pool.
  const warmG = new THREE.Group(); warmG.visible = false; scene.add(warmG);      // (prepared by warm.js, never drawn)
  const warmPool = [];
  {
    const g = keep(new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3)); g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(6), 2)); g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(9).fill(1), 3));
    const dummy = keep(new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1)); dummy.needsUpdate = true;
    const I4 = new THREE.Matrix4(), white = new THREE.Color(1, 1, 1);
    const add = (mat, kind, cast) => {
      let m; if (kind === 'line') m = new THREE.Line(g, mat); else if (kind === 'mesh') m = new THREE.Mesh(g, mat);
      else { m = new THREE.InstancedMesh(g, mat, 1); m.setMatrixAt(0, I4); if (kind === 'instc') m.setColorAt(0, white); }
      m.castShadow = cast; m.receiveShadow = true; m.frustumCulled = false; warmG.add(m);
    };
    for (const k of ['strip', 'strip-vc', 'strip-ds', 'strip-lid']) { const m = stripMat(dummy, k); warmPool.push(m); add(m, 'mesh', k === 'strip-ds'); }
    for (const [m, kind, cast] of signWarmList(dummy)) { if (m.userData.pool) warmPool.push(m); add(m, kind, cast); }
    for (const m of [wallMat, poleMat, signMat, sigMat, railMat, ...Object.values(BK), TM.wall, TM.ceil]) add(m, 'mesh', true);
    { const BM = barrierMaterials(); for (const m of [BM.con, BM.steel, BM.verge, BM.noise, BM.hedge]) add(m, 'mesh', true); add(BM.post, 'inst', false); add(TM.lit, 'mesh', false); }
    for (const m of [M_ONC, M_ONCL, M_EDGE, M_WHEEL, M_WHEELL, M_BLADEENV, M_BLADE, M_BLADEL, M_OFF, ...Object.values(gateMats), farMat]) add(m, 'mesh', false);
    for (const m of Object.values(gateLine)) add(m, 'line', false);
    add(TREE.mat, 'instc', true); add(TREE.tm, 'inst', true); add(TREE.matX, 'instc', true); add(TREE.tmX, 'inst', true); add(objMat, 'inst', true); add(DISC_MAT, 'instc', false);
    { const RM = roadMaterials(); add(RM.surf, 'mesh', false); add(RM.mark, 'mesh', false); add(RM.solid, 'mesh', true); }
  }
  function warmDone() { if (!warmG.parent) return; scene.remove(warmG); for (const m of warmPool) release(m); warmPool.length = 0; }
  // the survey row (every 10 m) at route distance s: {key: value} with units decoded
  const SC = { L: 100, R: 100, Lraw: 100, Rraw: 100, Rc: 1, grade: 100, wm: 100, bL: 100, bR: 100, wo: 100, have: 100, occl: 100, openL: 1, openR: 1 };
  function row(P, r) { const o = {}; for (const k in SC) { const a = P.A['s_' + k]; o[k] = a && r >= 0 && r < a.length ? a[r] / SC[k] : NaN; } return o; }
  function survey(s) {
    const i = sIndex(s); if (i < 0) return null; const q = samples[i], P = packs.get(q.p);
    const r = Math.floor((P.hdr.i0 + 2 * q.k) / 10) - P.hdr.a10;
    return row(P, r);
  }
  // rows over [sa, sb] for the profile chart: arrays of {s, ...}
  function profile(sa, sb, step = 10) {
    const out = [];
    for (let s = sa; s <= sb; s += step) { const i = sIndex(s); if (i < 0) continue; const q = samples[i]; if (Math.abs(q.s - s) > 4) { out.push(null); continue; }
      const P = packs.get(q.p); const o = row(P, Math.floor((P.hdr.i0 + 2 * q.k) / 10) - P.hdr.a10); o.s = s; out.push(o); }
    return out;
  }
  function dispose() {
    disposed = true; XRAY.value = 0; CUT.value.set(0, 0, 0, 0); ROAD_XR.uRx.value.z = 0;
    for (const P of packs.values()) { P.dead = true; dropMeshes(P.meshes); }
    for (const m of liveGroup.children) m.geometry.dispose();
    if (farMesh) farMesh.geometry.dispose();
    packs.clear();
  }
  // build times per pack (ms): the median barrier and the modelled roads in total, the longest roads step, the other parts
  const buildStats = () => [...packs.values()].map((P) => ({ p: P.hdr.p, median: +(P.msMedian || 0).toFixed(1), roads: +(P.msRoads || 0).toFixed(1), route: +(P.msRoute || 0).toFixed(1), roadsStep: +(P.msStep || 0).toFixed(1), ...(P.ms || {}) }));
  return { scene, warm: warmG, warmDone, ensure, liveReady: (s) => (LIVE && s >= LIVE.sa + 140 && s <= LIVE.sb - 260 ? Promise.resolve(true) : requestLive(s)), available, setRoads3D: (on) => { road3dGroup.visible = on; }, poseAt, at, ground, surface, surfS, toRoute, convoy, tunnelAt, FOCUS, setOverlay, updateFar, packs, samples, survey, profile, dispose, setVehicle, liveAt, objects, gates, bridgeInfo, verdict, clearOf, buildStats, get xray() { return XRAY.value; }, get live() { return LIVE; }, get livePending() { return !!liveReq || liveSoon; }, get origin() { return O; } };
}
