// One survey point in 3D at true scale: ground (Copernicus GLO-30 without trees and buildings), the 10 m Sentinel-2
// composite, every mapped road, building, tree, lamp, signal and barrier (Overture / OSM, ESA WorldCover), the convoy
// driving the swept-path model, its swept area painted on the ground and what is in its way.
import * as THREE from 'three';
import { patch, PHOTO_TRUE, PHOTO_PARS, photoUniforms } from '../env.js';
import { decodeHot, sampler } from './rdata.js';
import { makeConvoy, makeConvoySteps } from './convoy.js';
import { buildSigns, signalGeo } from './signs.js';
import { areaRoadsSteps, roadMaterials, ROAD_XR } from './roads3d.js';
import { hash2 } from '../data.js';
import { inWorker, abs, photoTexture } from './dataio.js';
import { bridgeMaterials, bridgeAccs, bridgeMeshes, Acc, block, pier, deckProfile, deck, deckSteps, depthOf, tube, tubeMaterials, XRAY_PARS, XRAY_CUT } from './bridges.js';
import { DEFAULTS } from './vehicle.js';

let CONVOY = null;
// the passages' convoy made ahead (at idle after the map's first frame)
export async function preConvoy(slice) { if (CONVOY) return; const it = makeConvoySteps(); let st; while (!(st = it.next()).done) if (slice.due()) await slice(); if (!CONVOY) CONVOY = st.value; }
const DT = { '<f4': Float32Array, '<f8': Float64Array, '<i2': Int16Array, '|u1': Uint8Array, '<u2': Uint16Array, '<u4': Uint32Array };

// the survey point's detail from official geodata (tools/route_hd_pack.py): photo tiles, laser terrain, LoD2, trees
export async function loadHD(base, id, kinds = null) {
  // in the data worker where one runs (the same requests and decoding there; the arrays are views made here, as below)
  const w = await inWorker('h', { base: abs(base || './'), id, kinds });
  if (w) { const blob = new Uint8Array(w.buf, w.off, w.len), A = {}; for (const m of w.hdr.arrays) A[m.n] = new DT[m.t](blob.buffer, blob.byteOffset + m.o, m.l); const g = w.hdr.grid;
    return { hdr: w.hdr, A, tiles: w.tiles, grid: { nx: g.nx, ny: g.ny, x0: g.x0, y0: g.y0, step: g.step, z: new Float32Array(w.z) }, zb: g.zb }; }
  // the passage's photo atlases are fetched at the same time as its data (the near and far atlas; kinds: the ones it has,
  // from h/index.json — without that list both are tried)
  const atlP = Object.fromEntries((kinds || ['n', 'f']).map((k) => [k, fetch(`${base}h/${id}_${k}.webp`).then((rr) => (rr.ok ? rr.blob() : null)).catch(() => null)]));
  const r = await fetch(`${base}h/${id}.json`); if (!r.ok) throw new Error('hd ' + r.status);
  const hdr = await r.json();
  const { inflate, b64bytes } = await import('../data.js');
  const blob = await inflate(b64bytes(hdr.blob)); delete hdr.blob;
  const A = {}; for (const m of hdr.arrays) A[m.n] = new DT[m.t](blob.buffer, blob.byteOffset + m.o, m.l);
  const atl = {};
  await Promise.all([...new Set(hdr.tiles.map((t) => t.a))].map(async (k) => { const b = await (atlP[k] || fetch(`${base}h/${id}_${k}.webp`).then((rr) => rr.blob())); atl[k] = await createImageBitmap(b); }));
  const tiles = await Promise.all(hdr.tiles.map(async (t) => ({ ...t, bmp: await createImageBitmap(atl[t.a], t.ax, t.ay, t.n, t.n, { imageOrientation: 'flipY' }) })));
  Object.values(atl).forEach((b) => b.close && b.close());
  const g = hdr.grid, z = new Float32Array(g.nx * g.ny); for (let i = 0; i < z.length; i++) z[i] = g.zb + A.dgm[i] * g.q;
  return { hdr, A, tiles, grid: { nx: g.nx, ny: g.ny, x0: g.x0, y0: g.y0, step: g.step, z }, zb: g.zb };
}

const ROADCOL = { motorway: [0.075, 0.077, 0.08], trunk: [0.08, 0.082, 0.085], primary: [0.088, 0.09, 0.093], secondary: [0.095, 0.095, 0.098],
  tertiary: [0.10, 0.10, 0.10], unclassified: [0.11, 0.11, 0.108], residential: [0.115, 0.115, 0.112], service: [0.13, 0.13, 0.125],
  living_street: [0.13, 0.13, 0.125], track: [0.25, 0.21, 0.15], footway: [0.30, 0.28, 0.25], cycleway: [0.16, 0.13, 0.12], path: [0.26, 0.22, 0.16],
  pedestrian: [0.30, 0.28, 0.25], steps: [0.30, 0.28, 0.25], unknown: [0.11, 0.11, 0.11], rail: [0.07, 0.065, 0.06] };

function overlayCanvas(H, ext) {
  const span = Math.max(ext[2] - ext[0], ext[3] - ext[1]);
  const res = Math.max(0.45, span / 2048);
  const W = Math.ceil((ext[2] - ext[0]) / res), Hh = Math.ceil((ext[3] - ext[1]) / res);
  const c = document.createElement('canvas'); c.width = W; c.height = Hh;
  const g = c.getContext('2d');
  const tx = (x) => (x - ext[0]) / res, ty = (y) => (ext[3] - y) / res;
  const pathOf = (rings) => { const p = new Path2D(); for (const r of rings) { p.moveTo(tx(r[0]), ty(r[1])); for (let k = 2; k < r.length; k += 2) p.lineTo(tx(r[k]), ty(r[k + 1])); p.closePath(); } return p; };
  // hatch pattern for the blade's swept area
  const pat = document.createElement('canvas'); pat.width = pat.height = 16;
  { const q = pat.getContext('2d'); q.fillStyle = 'rgba(230,40,30,0.22)'; q.fillRect(0, 0, 16, 16); q.strokeStyle = 'rgba(255,60,40,0.55)'; q.lineWidth = 2.2;
    q.beginPath(); q.moveTo(-4, 20); q.lineTo(20, -4); q.moveTo(-4, 4); q.lineTo(4, -4); q.moveTo(12, 20); q.lineTo(20, 12); q.stroke(); }
  const hatch = g.createPattern(pat, 'repeat');
  const by = (k) => pathOf(H.swept.filter((f) => f.a[0] === k).flatMap((f) => f.rings));
  // each class as one path (no alpha build-up where the sampled footprints overlap)
  g.fillStyle = hatch; g.fill(by(1), 'nonzero');
  g.fillStyle = 'rgba(255,170,30,0.6)'; g.fill(by(0), 'nonzero');
  g.fillStyle = 'rgba(255,40,40,0.40)'; g.fill(by(3), 'nonzero');
  g.lineWidth = Math.max(1.5, 0.35 / res); g.strokeStyle = 'rgba(255,40,30,0.95)'; g.stroke(by(3));
  g.fillStyle = 'rgba(220,0,200,0.85)'; g.fill(by(2), 'nonzero');
  // the oncoming lane used by the wheels (the escort holds traffic): violet hatch with an outline; where keeping right
  // would have put the wheels off the road: a dashed magenta outline
  const pat2 = document.createElement('canvas'); pat2.width = pat2.height = 16;
  { const q = pat2.getContext('2d'); q.fillStyle = 'rgba(120,60,255,0.30)'; q.fillRect(0, 0, 16, 16); q.strokeStyle = 'rgba(150,90,255,0.85)'; q.lineWidth = 2.4;
    q.beginPath(); q.moveTo(-4, -4); q.lineTo(20, 20); q.moveTo(-4, 12); q.lineTo(4, 20); q.moveTo(12, -4); q.lineTo(20, 4); q.stroke(); }
  const onc = by(4); g.fillStyle = g.createPattern(pat2, 'repeat'); g.fill(onc, 'nonzero');
  g.lineWidth = Math.max(1.5, 0.3 / res); g.strokeStyle = 'rgba(130,70,255,0.95)'; g.stroke(onc);
  g.setLineDash([Math.max(4, 1.2 / res), Math.max(3, 0.8 / res)]); g.lineWidth = Math.max(1.5, 0.28 / res); g.strokeStyle = 'rgba(255,40,220,0.95)'; g.stroke(by(5)); g.setLineDash([]);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

// no deck mask: a single black texel
const NOMASK = (() => { const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); t.needsUpdate = true; return t; })();
// the footprints of the decks the route rides on, in the overlay's frame (white = deck)
function deckMask(segs, ext, runs = null) {
  const res = 0.5, W = Math.ceil((ext[2] - ext[0]) / res), Hh = Math.ceil((ext[3] - ext[1]) / res);
  const s = Math.min(1, 4096 / Math.max(W, Hh)), c = document.createElement('canvas'); c.width = Math.ceil(W * s); c.height = Math.ceil(Hh * s);
  const g = c.getContext('2d'), tx = (x) => ((x - ext[0]) / res) * s, ty = (y) => ((ext[3] - y) / res) * s;
  g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#fff';
  for (const sg of segs) {
    const vx = sg[2] - sg[0], vy = sg[3] - sg[1], l = Math.hypot(vx, vy) || 1, nx = (-vy / l) * (sg[6] + 0.3), ny = (vx / l) * (sg[6] + 0.3), ex = (vx / l) * 0.3, ey = (vy / l) * 0.3;
    g.beginPath(); g.moveTo(tx(sg[0] + nx - ex), ty(sg[1] + ny - ey)); g.lineTo(tx(sg[2] + nx + ex), ty(sg[3] + ny + ey)); g.lineTo(tx(sg[2] - nx + ex), ty(sg[3] - ny + ey)); g.lineTo(tx(sg[0] - nx - ex), ty(sg[1] - ny - ey)); g.closePath(); g.fill();
  }
  if (runs) {             // only around the passes on the decks (the swept area reaches ≤ 25 m from the path)
    g.globalCompositeOperation = 'destination-in'; g.strokeStyle = '#fff'; g.lineCap = 'round'; g.lineJoin = 'round'; g.lineWidth = (50 / res) * s;
    g.beginPath(); for (const r of runs) r.forEach(([x, y], i) => (i ? g.lineTo(tx(x), ty(y)) : g.moveTo(tx(x), ty(y)))); g.stroke(); g.globalCompositeOperation = 'source-over';
  }
  const t = new THREE.CanvasTexture(c); t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; return t;
}

// the footprints of the tunnels' tubes (walls + 2 m) in the overlay's frame (white = tube): where the lid may fade
function tubeMask(tuns, path, ext) {
  const res = 0.5, W = Math.ceil((ext[2] - ext[0]) / res), Hh = Math.ceil((ext[3] - ext[1]) / res);
  const s = Math.min(1, 2048 / Math.max(W, Hh)), c = document.createElement('canvas'); c.width = Math.ceil(W * s); c.height = Math.ceil(Hh * s);
  const g = c.getContext('2d'), tx = (x) => ((x - ext[0]) / res) * s, ty = (y) => ((ext[3] - y) / res) * s;
  g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#fff';
  for (const t of tuns) {
    const L = [], R = [];
    for (let j = t.i0; j <= t.i1; j++) { const a = Math.max(t.i0, j - 1), b = Math.min(t.i1, j + 1), vx = path[2 * b] - path[2 * a], vy = path[2 * b + 1] - path[2 * a + 1], l = Math.hypot(vx, vy) || 1, nx = -vy / l, ny = vx / l;
      L.push([path[2 * j] + nx * (t.dl + 2), path[2 * j + 1] + ny * (t.dl + 2)]); R.push([path[2 * j] + nx * (t.dr - 2), path[2 * j + 1] + ny * (t.dr - 2)]); }
    g.beginPath(); [...L, ...R.reverse()].forEach(([x, y], i) => (i ? g.lineTo(tx(x), ty(y)) : g.moveTo(tx(x), ty(y)))); g.closePath(); g.fill();
  }
  const t = new THREE.CanvasTexture(c); t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; return t;
}

// minimum-area rectangle of a ring (for roof shapes): returns {cx, cy, a (angle of the long side), L, W}
function obb(r) {
  let best = null;
  for (let k = 0; k < r.length; k += 2) {
    const k2 = (k + 2) % r.length, dx = r[k2] - r[k], dy = r[k2 + 1] - r[k + 1], l = Math.hypot(dx, dy); if (l < 0.5) continue;
    const ux = dx / l, uy = dy / l;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (let j = 0; j < r.length; j += 2) { const p = r[j] * ux + r[j + 1] * uy, q = -r[j] * uy + r[j + 1] * ux; a0 = Math.min(a0, p); a1 = Math.max(a1, p); b0 = Math.min(b0, q); b1 = Math.max(b1, q); }
    const area = (a1 - a0) * (b1 - b0);
    if (!best || area < best.area) best = { area, ux, uy, a0, a1, b0, b1 };
  }
  if (!best) return null;
  let { ux, uy, a0, a1, b0, b1 } = best;
  if (b1 - b0 > a1 - a0) { [ux, uy] = [-uy, ux]; const t0 = a0, t1 = a1; a0 = b0; a1 = b1; b0 = -t1; b1 = -t0; }
  const pc = (a0 + a1) / 2, qc = (b0 + b1) / 2;
  return { cx: pc * ux - qc * uy, cy: pc * uy + qc * ux, ux, uy, L: a1 - a0, W: b1 - b0 };
}

// built in slices (slice: a slicer from warm.js; without one in one go): a passage takes up to a few seconds of work, and the
// view shown meanwhile keeps drawing. The convoy is added to the scene by attach() when the passage is shown (it is shared)
export async function makeHot(R, hm, texImg, far, hd = null, slice = null) {
  const S = slice || (async () => {}), due = () => !!slice && slice.due();
  const H = decodeHot(R, hm.id); await S();
  const tileTexs = [];
  const codes = R.header.codes;
  const ext = hm.ext;
  const scene = new THREE.Scene();
  const G = hd ? hd.grid : H.ground;
  const hs = sampler(G);
  const roadH = new Map();
  let deckZ = null;                      // set below once the bridges are built: decks the route rides on
  let pathOn = null;                     // per path vertex (2 m): the route on a deck there (not passing under it)
  const ground = (x, y) => { const g = hs(x, y); if (deckZ) { const d = deckZ(x, y); if (d != null && d > g) return d; } return g; };
  // tunnels and covered sections on the passage (hdr.tun, route_hd_pack.py): path samples i0..i1, the road's profile there
  // in the passage's heights, the walls dl > 0 > dr from the path, the clear height drawn (H). The terrain keeps the lid;
  // the convoy, its path and the asphalt run on the profile inside the tube
  const TUN = ((hd && hd.hdr.tun) || []).filter((t) => t && t.kind !== 'underbridge' && t.prof && t.i1 > t.i0 && t.prof.length >= t.i1 - t.i0 + 1);
  {
    const Pp = H.path, np0 = Pp.length / 2;
    for (const t of TUN) {
      t.i0 = Math.max(0, t.i0); t.i1 = Math.min(np0 - 1, t.i1); t.dl = Number.isFinite(t.dl) ? t.dl : 7.5; t.dr = Number.isFinite(t.dr) ? t.dr : -7.5; t.Hd = t.H || t.std || 4.5;
      // the road just outside the portals too (pre / post: the fitted road under the 5 path samples before i0 and after i1 —
      // the terrain grid there mixes in the lid or the deck the terrain model leaves out): e0 … e1, eprof
      const pre = Array.isArray(t.pre) ? t.pre.slice(-Math.min(t.pre.length, t.i0)) : [], post = Array.isArray(t.post) ? t.post.slice(0, Math.max(0, np0 - 1 - t.i1)) : [];
      t.e0 = t.i0 - pre.length; t.e1 = t.i1 + post.length; t.eprof = [...pre, ...t.prof.slice(0, t.i1 - t.i0 + 1), ...post];
      const w = Math.max(t.dl, -t.dr) + 3; t.box = [Infinity, Infinity, -Infinity, -Infinity];
      for (let j = t.e0; j <= t.e1; j++) { t.box[0] = Math.min(t.box[0], Pp[2 * j] - w); t.box[1] = Math.min(t.box[1], Pp[2 * j + 1] - w); t.box[2] = Math.max(t.box[2], Pp[2 * j] + w); t.box[3] = Math.max(t.box[3], Pp[2 * j + 1] + w); }
    }
  }
  // the road in a tube (and 10 m before and after its portals; inner: in the tube only) under (x, y), or null
  const tubeZ = (x, y, inner = false) => {
    for (const t of TUN) {
      if (x < t.box[0] || y < t.box[1] || x > t.box[2] || y > t.box[3]) continue;
      const Pp = H.path, a0 = inner ? t.i0 : t.e0, a1 = inner ? t.i1 : t.e1, pr = inner ? t.prof : t.eprof; let bj = -1, bd = Infinity;
      for (let j = a0; j <= a1; j++) { const d = (Pp[2 * j] - x) ** 2 + (Pp[2 * j + 1] - y) ** 2; if (d < bd) { bd = d; bj = j; } }
      const j0 = Math.max(a0, Math.min(a1 - 1, bj)), ax = Pp[2 * j0], ay = Pp[2 * j0 + 1], vx = Pp[2 * j0 + 2] - ax, vy = Pp[2 * j0 + 3] - ay, l = Math.hypot(vx, vy) || 1;
      const u = ((x - ax) * vx + (y - ay) * vy) / l, d = (-(x - ax) * vy + (y - ay) * vx) / l;
      if ((bj === a0 && u < -0.5) || (bj === a1 && u > l + 0.5) || d > t.dl || d < t.dr) continue;
      const f = Math.max(0, Math.min(1, u / l)); return pr[j0 - a0] + (pr[j0 + 1 - a0] - pr[j0 - a0]) * f;
    }
    return null;
  };
  const XRAY = { value: 0 }, TUBE = { uTubeM: { value: NOMASK }, uXray: XRAY };
  const FOCUS = { value: new THREE.Vector3(0, -1e6, 0) };
  const treeGeos = [], tileGeos = [];
  let treeCount = 0;
  await S();
  // ---- terrain
  const nx = G.nx, ny = G.ny;
  const pos = new Float32Array(nx * ny * 3), uv = new Float32Array(nx * ny * 2);
  for (let j = 0; j < ny; j++) { if (due()) await S(); for (let i = 0; i < nx; i++) {
    const k = j * nx + i, x = G.x0 + i * G.step, y = G.y0 + j * G.step;
    pos[3 * k] = x; pos[3 * k + 1] = G.z[k]; pos[3 * k + 2] = -y;
    uv[2 * k] = (x - ext[0]) / (ext[2] - ext[0]); uv[2 * k + 1] = (y - ext[1]) / (ext[3] - ext[1]);
  } }
  const idx = new Uint32Array((nx - 1) * (ny - 1) * 6); let o = 0;
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) { const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1; idx.set([a, b, c, b, d, c], o); o += 6; }
  const tg = new THREE.BufferGeometry();
  tg.setAttribute('position', new THREE.BufferAttribute(pos, 3)); tg.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); tg.setIndex(new THREE.BufferAttribute(idx, 1));
  {
    // lighting normals from smoothed heights: the 20 m ground keeps small bumps where trees and buildings were taken out,
    // and the picture carries its own shading anyway
    const z2 = Float32Array.from(G.z);
    for (let pass = 0; pass < 3; pass++) { await S(); const src = Float32Array.from(z2);
      for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) { let a = 0; for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) a += src[(j + dj) * nx + i + di]; z2[j * nx + i] = a / 9; } }
    const nrm = new Float32Array(nx * ny * 3);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i, zl = z2[j * nx + Math.max(0, i - 1)], zr = z2[j * nx + Math.min(nx - 1, i + 1)], zd = z2[Math.max(0, j - 1) * nx + i], zu = z2[Math.min(ny - 1, j + 1) * nx + i];
      const dx = (zr - zl) / (2 * G.step), dy = (zu - zd) / (2 * G.step), l = Math.hypot(dx, dy, 1);
      nrm[3 * k] = -dx / l; nrm[3 * k + 1] = 1 / l; nrm[3 * k + 2] = dy / l;
    }
    tg.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  }
  const tex = new THREE.Texture(texImg); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8; tex.needsUpdate = true;
  const ovTex = overlayCanvas(H, ext);
  const OV = { uOv: { value: ovTex }, uOvOn: { value: 1 }, uDeckM: { value: NOMASK }, uMaskOn: { value: 1 }, uExt: { value: new THREE.Vector4(ext[0], ext[1], ext[2] - ext[0], ext[3] - ext[1]) },
    uFar: { value: far.tex }, uFarM: { value: far.uvMatrix(hm) } };
  const OV_PARS = /* glsl */ `uniform sampler2D uOv; uniform float uOvOn; uniform sampler2D uDeckM; uniform float uMaskOn; uniform vec4 uExt; uniform sampler2D uFar; uniform mat3 uFarM;
    vec3 overlay(vec3 c) { vec2 q = vec2((vWP.x - uExt.x) / uExt.z, (-vWP.z - uExt.y) / uExt.w);
      if (q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) return c; vec4 o = texture2D(uOv, vec2(q.x, q.y));
      float mk = texture2D(uDeckM, q).r * uMaskOn;            // under a deck the route rides on: the path is on the deck
      return mix(c, o.rgb, o.a * uOvOn * (1.0 - mk)); }
    vec3 overlayDeck(vec3 c) { vec2 q = vec2((vWP.x - uExt.x) / uExt.z, (-vWP.z - uExt.y) / uExt.w);       // on a deck: the paint of the passes on it
      if (q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) return c; vec4 o = texture2D(uOv, q); return mix(c, o.rgb, o.a * uOvOn * texture2D(uDeckM, q).r); }
    vec3 overlayGlow() { vec2 q = vec2((vWP.x - uExt.x) / uExt.z, (-vWP.z - uExt.y) / uExt.w);
      if (q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) return vec3(0.0); vec4 o = texture2D(uOv, q); return o.rgb * o.a * uOvOn * uNight * 0.25; }`;
  const tmat = patch(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.96, metalness: 0 }), {
    key: 'hot-ground', uniforms: OV,
    frag: {
      pars: OV_PARS,
      map: /* glsl */ `
        vec4 texelColor = texture2D(map, vMapUv);
        vec3 alb = texelColor.rgb;
        // the 10 m picture gets a field-scale grain so it holds up close to the road
        alb = pow(alb, vec3(1.12));
        float lum = dot(alb, vec3(0.2126, 0.7152, 0.0722)); alb = max(mix(vec3(lum), alb, 1.15), 0.0);
        float n = vnoise(vWP.xz * 0.21) * 0.6 + vnoise(vWP.xz * 0.9) * 0.4;
        alb *= 0.86 + 0.26 * n;
        { vec2 q = vec2((vWP.x - uExt.x) / uExt.z, (-vWP.z - uExt.y) / uExt.w);
          float e = smoothstep(0.0, 0.035, min(min(q.x, q.y), min(1.0 - q.x, 1.0 - q.y)));
          alb = mix(texture2D(uFar, (uFarM * vec3(vWP.x, -vWP.z, 1.0)).xy).rgb, alb, e); }
        diffuseColor.rgb *= overlay(alb);`,
      afterLights: 'totalEmissiveRadiance += overlayGlow();',
    },
  });
  if (!hd) { const terrain = new THREE.Mesh(tg, tmat); terrain.receiveShadow = true; scene.add(terrain); }
  else {
    // the 20 cm aerial photo in 256 m tiles on the laser terrain, the swept-path overlay painted over it
    // (over a tunnel's tube the lid fades to a screen door while the convoy is in it and the camera above it)
    if (TUN.length) TUBE.uTubeM.value = tubeMask(TUN, H.path, ext);
    const tileMat = (tex) => { const m = patch(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.94, metalness: 0 }), {
      key: TUN.length ? 'hot-tile-x' : 'hot-tile', uniforms: { ...OV, ...photoUniforms, ...TUBE },
      frag: { pars: OV_PARS + PHOTO_PARS + (TUN.length ? XRAY_PARS + 'uniform sampler2D uTubeM;\n' : ''),
        map: (TUN.length ? /* glsl */ `if (uXray > 0.0 && texture2D(uTubeM, vec2((vWP.x - uExt.x) / uExt.z, (-vWP.z - uExt.y) / uExt.w)).r > 0.5) { ${XRAY_CUT} }\n` : '') + /* glsl */ `vec4 texelColor = texture2D(map, vMapUv); diffuseColor.rgb *= overlay(texelColor.rgb);`, afterLights: PHOTO_TRUE + 'totalEmissiveRadiance += overlayGlow();' } });
      m.toneMapped = false; return m; };
    for (const t of hd.tiles) {
      if (due()) await S();
      const tex = photoTexture(t.bmp); tex.flipY = false; tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8; tex.needsUpdate = true;
      tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter; tileTexs.push(tex); t.tex = tex;
      // level of detail: the terrain's own grid near the convoy's path, 4 m and 8 m further out (skirts close the seams)
      let dp = Infinity; const Pp = H.path;
      for (let k = 0; k < Pp.length; k += 8) { const dx = Math.max(t.x0 - Pp[k], 0, Pp[k] - t.x0 - t.size), dy = Math.max(t.y0 - Pp[k + 1], 0, Pp[k + 1] - t.y0 - t.size); dp = Math.min(dp, Math.hypot(dx, dy)); }
      const step = dp < 60 ? Math.min(G.step, 4) : dp < 300 ? Math.max(4, G.step) : Math.max(8, G.step);
      const n = Math.max(8, Math.round(t.size / step)) + 1;
      const nv = n * n + 4 * n, pos = new Float32Array(nv * 3), uvt = new Float32Array(nv * 2), idx2 = [];
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const k = j * n + i, x = t.x0 + (i / (n - 1)) * t.size, y = t.y0 + (j / (n - 1)) * t.size;
        pos[3 * k] = x; pos[3 * k + 1] = ground(x, y); pos[3 * k + 2] = -y; uvt[2 * k] = i / (n - 1); uvt[2 * k + 1] = j / (n - 1); }
      for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) { const a = j * n + i, b = a + 1, c = a + n, d = c + 1; idx2.push(a, b, c, b, d, c); }
      // skirts: each border row repeated 0.6 m lower, joined to it
      const borders = [[...Array(n).keys()], [...Array(n).keys()].map((i) => (n - 1) * n + i), [...Array(n).keys()].map((j) => j * n), [...Array(n).keys()].map((j) => j * n + n - 1)];
      borders.forEach((row, bi) => { const o = n * n + bi * n; row.forEach((k, i) => { pos[3 * (o + i)] = pos[3 * k]; pos[3 * (o + i) + 1] = pos[3 * k + 1] - 0.6; pos[3 * (o + i) + 2] = pos[3 * k + 2]; uvt[2 * (o + i)] = uvt[2 * k]; uvt[2 * (o + i) + 1] = uvt[2 * k + 1]; });
        for (let i = 0; i < n - 1; i++) idx2.push(row[i], o + i, row[i + 1], row[i + 1], o + i, o + i + 1, row[i], row[i + 1], o + i, row[i + 1], o + i + 1, o + i); });
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uvt, 2)); g.setIndex(idx2); g.computeVertexNormals();
      const m = new THREE.Mesh(g, tileMat(tex)); m.receiveShadow = true; scene.add(m); tileGeos.push({ g, n });
    }
  }
  await S();
  // the landscape beyond: a 25 km disc with the country map's picture and relief, sunk under the surveyed area
  {
    const NR = 40, NS = 72, Rm = 25000, cx = (ext[0] + ext[2]) / 2, cy = (ext[1] + ext[3]) / 2;
    const P = [], UVd = [], I = [];
    const T = hm.toMap, Mx = far.map;
    for (let r = 0; r <= NR; r++) for (let a = 0; a < NS; a++) {
      const rr = Rm * Math.pow(r / NR, 1.8), th = (a / NS) * Math.PI * 2;
      const x = cx + Math.cos(th) * rr, y = cy + Math.sin(th) * rr;
      const mx = T[0] * x + T[1] * y + T[2], my = T[3] * x + T[4] * y + T[5];
      const inside = Math.max(ext[0] - x, x - ext[2], ext[1] - y, y - ext[3]);
      let z = far.height(mx, my);
      const edgeZ = ground(Math.max(ext[0], Math.min(ext[2], x)), Math.max(ext[1], Math.min(ext[3], y)));
      if (inside < 2500) { const t = Math.max(0, Math.min(1, inside / 2500)); z = Math.min(z, edgeZ * (1 - t) + z * t) - 6 * (1 - t) - Math.max(0, -inside) * 0.05; }
      P.push(x, z, -y); UVd.push((mx - Mx.x0) / (Mx.x1 - Mx.x0), (my - Mx.y0) / (Mx.y1 - Mx.y0));
    }
    for (let r = 0; r < NR; r++) for (let a = 0; a < NS; a++) { const a2 = (a + 1) % NS, i0 = r * NS + a, i1 = r * NS + a2, i2 = i0 + NS, i3 = i1 + NS; I.push(i0, i2, i1, i1, i2, i3); }
    const dg = new THREE.BufferGeometry(); dg.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); dg.setAttribute('uv', new THREE.Float32BufferAttribute(UVd, 2)); dg.setIndex(I); dg.computeVertexNormals();
    const dm = patch(new THREE.MeshStandardMaterial({ map: far.tex, roughness: 1 }), { key: 'far-disc' });
    const disc = new THREE.Mesh(dg, dm); disc.renderOrder = 2; scene.add(disc);      // (after the passage: hidden parts fail the depth test early)
  }
  await S();
  // the carriageway traced on the photo (rings, outer and holes by winding) and a 0.5 m mask of it: inside the traced
  // carriageway (drawn once, even-odd, looked up per point; testing every ring's every edge per point took seconds on a
  // passage with a long traced edge). The asphalt goes on it; the piers of the decks keep off it
  const pvRings = []; { let o = 0; const N = hd ? hd.A.pv_n : [], XY = hd ? hd.A.pv_xy : null;
    for (let r = 0; r < N.length; r++) { const a = []; for (let k = 0; k < N[r]; k++) a.push([XY[2 * (o + k)], XY[2 * (o + k) + 1]]); pvRings.push(a); o += N[r]; } }
  const inPaved = (() => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of pvRings) for (const [x, y] of r) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (!Number.isFinite(x0)) return () => false;
    const res = Math.max(0.5, Math.max(x1 - x0, y1 - y0) / 4096), W = Math.ceil((x1 - x0) / res) + 2, Hh = Math.ceil((y1 - y0) / res) + 2;
    const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, Hh) : Object.assign(document.createElement('canvas'), { width: W, height: Hh });
    const g = cv.getContext('2d', { willReadFrequently: true }); const p = new Path2D();
    for (const r of pvRings) { if (r.length < 3) continue; p.moveTo((r[0][0] - x0) / res + 1, (y1 - r[0][1]) / res + 1); for (let k = 1; k < r.length; k++) p.lineTo((r[k][0] - x0) / res + 1, (y1 - r[k][1]) / res + 1); p.closePath(); }
    g.fillStyle = '#fff'; g.fill(p, 'evenodd');
    const px = g.getImageData(0, 0, W, Hh).data;
    return (x, y) => { const i = Math.floor((x - x0) / res + 1), j = Math.floor((y1 - y) / res + 1); return i >= 0 && j >= 0 && i < W && j < Hh && px[(j * W + i) * 4 + 3] > 127; };
  })();
  await S();
  // ---- bridges: decks on their measured height (surface model along the mapped centreline), parapets, piers and
  // abutments; where the route runs on a deck the convoy and the path ride on it
  const bridgeLabels = [], allSegs = [];
  // is (x, y) on a deck? (surface-model 'trees' on bridges are lamps and railings)
  const onDeck = (x, y) => { for (const s of allSegs) { const vx = s[2] - s[0], vy = s[3] - s[1], l2 = vx * vx + vy * vy || 1, t = ((x - s[0]) * vx + (y - s[1]) * vy) / l2; if (t < -0.1 || t > 1.1) continue; const tt = Math.max(0, Math.min(1, t)); if (Math.hypot(x - s[0] - vx * tt, y - s[1] - vy * tt) < s[6] + 1.0) return true; } return false; };
  // the trees found in the surface model, binned (a 'deck' under closed canopy is the canopy)
  const HTb = new Map();
  if (hd && hd.A.tree) { const T = hd.A.tree; for (let i = 0; i < T.length; i += 4) { const k = Math.floor(T[i] / 8) * 65536 + Math.floor(T[i + 1] / 8); let a = HTb.get(k); if (!a) HTb.set(k, (a = [])); a.push(i); } }
  const treeNear = (x, y, r) => { const T = hd.A.tree, cx = Math.floor(x / 8), cy = Math.floor(y / 8), w = Math.ceil(r / 8); for (let i = -w; i <= w; i++) for (let j = -w; j <= w; j++) { const a = HTb.get((cx + i) * 65536 + cy + j); if (a) for (const k of a) if ((T[k] - x) ** 2 + (T[k + 1] - y) ** 2 < r * r) return true; } return false; };
  const distLine = (x, y, run) => { let bd = Infinity; for (let k = 0; k + 1 < run.length; k++) { const [ax, ay] = run[k], [bx, by] = run[k + 1], vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy || 1, t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / l2)); bd = Math.min(bd, Math.hypot(x - ax - vx * t, y - ay - vy * t)); } return bd; };
  const MINOR = ['track', 'path', 'footway', 'cycleway', 'pedestrian', 'steps', 'service', 'unclassified', 'bridleway'];
  // mapped roads and railways under a deck: no pier on them (pieces crossing the deck's direction)
  const roadSegs = [];
  for (const f of H.roads) { const cls = codes.road[f.a[0]]; if (['footway', 'path', 'steps', 'cycleway'].includes(cls)) continue; const hw = f.a[1] / 10;
    for (const r of f.rings) for (let k = 0; k + 3 < r.length; k += 2) roadSegs.push([r[k], r[k + 1], r[k + 2], r[k + 3], hw]); }
  const onRoadUnder = (x, y, ex, ey) => { const el = Math.hypot(ex, ey) || 1;
    for (const [ax, ay, bx, by, hw] of roadSegs) { const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy || 1; if (Math.abs((vx * ex + vy * ey) / (Math.sqrt(l2) * el)) > 0.85) continue;
      const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / l2)); if (Math.hypot(x - ax - vx * t, y - ay - vy * t) < hw + 1.8) return true; } return false; };
  if (hd && hd.hdr.bridges && hd.hdr.bridges.length) {
    const BK = bridgeMaterials((x) => x), K = bridgeAccs();
    const KC = { ...K, road: new Acc(), ballast: new Acc() };
    const deckOV = patch(new THREE.MeshStandardMaterial({ color: 0x55585b, roughness: 0.95, side: THREE.DoubleSide }), { key: 'hot-deck', uniforms: OV, frag: { pars: OV_PARS, map: 'diffuseColor.rgb = overlayDeck(diffuseColor.rgb);' } });
    const segs = [], path = H.path, cands = [];
    const distPath = (x, y) => { let bd = Infinity; for (let k = 0; k + 3 < path.length; k += 2) { const ax = path[k], ay = path[k + 1], bx = path[k + 2], by = path[k + 3], vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy || 1, t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / l2)); bd = Math.min(bd, Math.hypot(x - ax - vx * t, y - ay - vy * t)); } return bd; };
    for (const b of hd.hdr.bridges) {
      if (due()) await S();
      const rail = b.sub === 'rail', dep = depthOf(b), hw = Math.max(1.8, b.w / 2);
      for (const pt of b.parts) {
        if (!pt.S) continue;
        const n = pt.xy.length / 2; if (n < 3) continue;
        const pts = []; for (let i = 0; i < n; i++) pts.push([pt.xy[2 * i], pt.xy[2 * i + 1]]);
        const S = pt.S.map((v) => (v < -900 ? NaN : v)), T = pt.T.map((v) => (v < -900 ? NaN : v)), h = S.map((v, i) => v - T[i]);
        // a small crossing under closed canopy: the surface model shows the crowns, not a deck (both ends of the bridge part
        // stand high above the ground, trees all along it): the deck at the level of the ground at its ends
        const fin = h.map((v, i) => (Number.isFinite(v) ? i : -1)).filter((i) => i >= 0);
        const lowDeck = () => { const g0 = hs(pts[0][0], pts[0][1]), g1 = hs(pts[n - 1][0], pts[n - 1][1]);
          const zt = pts.map((p, k) => Math.max(g0 + ((g1 - g0) * k) / (n - 1), hs(p[0], p[1]) + 0.5));
          cands.push({ b, run: pts, zt, dep: Math.min(dep, 0.8), hw, rail, carries: false, low: true, top: Math.max(...zt.map((z, k) => z - hs(pts[k][0], pts[k][1]))) }); };
        if (!pt.carries && !rail && fin.length >= 2 && h[fin[0]] > 3 && h[fin[fin.length - 1]] > 3) {
          const tf = pts.filter((p) => treeNear(p[0], p[1], 4)).length / n, hmax = Math.max(...fin.map((i) => h[i]));
          if (tf >= 0.3 || (MINOR.includes(b.cls) && hmax > 12)) { lowDeck(); continue; }
        }
        // a track, path or minor road away from the route: each span must come down to the ground at both ends and stand
        // clear of trees, otherwise the part is a low crossing (canopy and the stream bed in the surface model)
        const strict = !pt.carries && !rail && !b.clr && MINOR.includes(b.cls), mine = [];
        // every span standing clear of the ground (single-sample dips from cars or lamps bridged)
        const up = h.map((v, i) => v > 1.5 || (i > 0 && i < n - 1 && h[i - 1] > 1.5 && h[i + 1] > 1.5));
        for (let i = 0; i < n;) {
          if (!up[i]) { i++; continue; }
          let a = i; while (i < n && up[i]) i++; let c = i - 1;
          if (c - a < 2) continue;
          // the deck top: a smooth line through the span (trees and lamps beside it stand above it), on the scene's terrain
          const pr = deckProfile(S, T, Math.round((a + c) / 2), 1.5); if (!pr) continue;
          const offs = []; for (let k = pr.i0; k <= pr.i1; k++) if (Number.isFinite(T[k])) offs.push(hs(pts[k][0], pts[k][1]) - T[k]);
          if (!offs.length) continue; offs.sort((x, y) => x - y);
          const off = offs[offs.length >> 1]; a = pr.i0; c = pr.i1;
          const run = pts.slice(a, c + 1), zt = pr.zt.map((z) => z + off), Hs = run.map((p, k) => zt[k] - hs(p[0], p[1]));
          // does the route really run on this deck, or pass under it at a narrow angle? On the deck, the road just before and
          // after it (on the ground model) comes up to the deck's level; underneath, it stays on the ground below
          let carries = pt.carries;
          if (carries) {
            const near = []; for (let k = 0; k + 1 < path.length; k += 2) { const x = path[k], y = path[k + 1]; let dmin = 1e9, ki = 0; run.forEach((p, ii) => { const d = Math.hypot(p[0] - x, p[1] - y); if (d < dmin) { dmin = d; ki = ii; } }); if (dmin < hw) near.push([k, ki]); }
            if (near.length) {
              const app = (k, dir) => { let acc = 0, kk = k; while (kk >= 0 && kk + 1 < path.length && acc < 15) { const k2 = kk + 2 * dir; if (k2 < 0 || k2 + 1 >= path.length) break; acc += Math.hypot(path[k2] - path[kk], path[k2 + 1] - path[kk + 1]); kk = k2; } return hs(path[kk], path[kk + 1]); };
              const [ka, ia] = near[0], [kb, ib] = near[near.length - 1];
              const da = Math.abs(app(ka, -1) - zt[ia]), db = Math.abs(app(kb, 1) - zt[ib]);
              if (Math.min(da, db) > 2.5) carries = false;
            }
          }
          mine.push({ b, run, zt, dep, hw, rail, carries, low: false, top: Math.max(...Hs.filter(Number.isFinite)), Hs });
        }
        if (strict && mine.some((c) => !(c.Hs[0] <= 2.5 && c.Hs[c.Hs.length - 1] <= 2.5) || c.run.filter((p) => treeNear(p[0], p[1], 4)).length / c.run.length >= 0.3)) lowDeck();
        else cands.push(...mine);
      }
    }
    // one deck where two mapped ways run on it side by side (a road and its footway): the wider (or the road) kept,
    // widened over the other; railways stay separate. Only where they really overlap (the narrower one's line within the
    // wider one's own deck + half its width, on 60 % of it) and the widening stays under 4.5 m (a footway, a cycle track):
    // the two carriageways of a road on decks side by side stay two decks (merged, they made a 60 m slab over a junction)
    const ROADRANK = (c) => (MINOR.includes(c.b.cls) ? 1 : 2);
    cands.sort((p, q) => q.hw - p.hw);
    for (const c of cands) c.hw0 = c.hw;
    for (let ci = 0; ci < cands.length; ci++) {
      if (due()) await S();
      const c = cands[ci]; if (c.rail || c.low) continue;
      for (let ki = 0; ki < ci; ki++) {
        const k = cands[ki]; if (k.drop || k.rail || k.low || k.carries !== c.carries) continue;    // the route's own deck stays its own
        if (ROADRANK(c) === 2 && ROADRANK(k) === 2 && c.hw0 >= 3) continue;                      // (two carriageways)
        const lim = k.hw0 + 0.5 * c.hw0, ds = c.run.map((p) => distLine(p[0], p[1], k.run)), inn = ds.filter((d) => d < lim);
        if (inn.length / ds.length < 0.6) continue;
        const zc = c.zt.reduce((s, v) => s + v, 0) / c.zt.length, zk = k.zt.reduce((s, v) => s + v, 0) / k.zt.length;
        if (Math.abs(zc - zk) > 2) continue;
        const md = inn.reduce((s, v) => s + v, 0) / inn.length, hw = Math.max(k.hw, md + c.hw0);
        if (hw - k.hw0 > 4.5) continue;
        k.hw = hw; if (ROADRANK(c) > ROADRANK(k)) k.b = c.b; k.carries = k.carries || c.carries; c.drop = true; break;
      }
    }
    // a span that lies inside another deck's footprint at that deck's height is the other deck's surface (a railway under a
    // motorway deck picks up the deck in the surface model): left out
    const zMean = (c) => c.zt.reduce((s, v) => s + v, 0) / c.zt.length;
    for (const c of cands) {
      if (due()) await S();
      if (c.drop || c.carries || c.low) continue;
      for (const k of cands) {
        if (k === c || k.drop || k.low || k.run.length < c.run.length) continue;
        const inside = c.run.filter((p) => distLine(p[0], p[1], k.run) < k.hw + 1).length / c.run.length;
        if (inside >= 0.6 && Math.abs(zMean(c) - zMean(k)) < 2) { c.drop = true; break; }
      }
    }
    const live = cands.filter((c) => !c.drop);
    // the ground under the decks: the terrain model there may hold parts of the deck (spikes up to the abutments, a hump in
    // the road below): across each deck's footprint (its edges + 1 m) the grid is laid straight between the ground 1.5 m
    // beyond both edges, where that is lower (a stream bed under the deck stays). The passage's tiles, asphalt and paint
    // are on the ground after this
    {
      const z0 = Float32Array.from(G.z), hs0 = sampler({ ...G, z: z0 }), boxes = [];
      for (const C of live) {
      if (due()) await S();
        if (C.low || C.top < 3) continue;
        const w = C.hw + 1, wo = C.hw + 1.5, R_ = C.run;
        let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity; for (const [x, y] of R_) { bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y); }
        bx0 -= w; by0 -= w; bx1 += w; by1 += w; boxes.push([bx0, by0, bx1, by1]);
        const i0 = Math.max(0, Math.floor((bx0 - G.x0) / G.step)), i1 = Math.min(G.nx - 1, Math.ceil((bx1 - G.x0) / G.step)), j0 = Math.max(0, Math.floor((by0 - G.y0) / G.step)), j1 = Math.min(G.ny - 1, Math.ceil((by1 - G.y0) / G.step));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          const x = G.x0 + i * G.step, y = G.y0 + j * G.step; let best = null;
          for (let k = 0; k + 1 < R_.length; k++) { const [ax, ay] = R_[k], [bx, by] = R_[k + 1], vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy || 1, t = ((x - ax) * vx + (y - ay) * vy) / l2;
            if (t < 0 || t > 1) continue; const l = Math.sqrt(l2), d = (-(x - ax) * vy + (y - ay) * vx) / l; if (Math.abs(d) < w && (!best || Math.abs(d) < Math.abs(best[0]))) best = [d, ax + vx * t, ay + vy * t, -vy / l, vx / l]; }
          if (!best) continue;
          const [d, px, py, nx, ny] = best, za = hs0(px + nx * wo, py + ny * wo), zb = hs0(px - nx * wo, py - ny * wo), zl = zb + ((za - zb) * (d + wo)) / (2 * wo), q = j * G.nx + i;
          if (zl < G.z[q]) G.z[q] = zl;
        }
      }
      // the tiles' heights again where they changed (skirts 0.6 m under their border), the plain terrain mesh's too
      const inBox = (x, y) => boxes.some((b) => x >= b[0] - G.step && x <= b[2] + G.step && y >= b[1] - G.step && y <= b[3] + G.step);
      for (const { g, n } of tileGeos) {
      if (due()) await S();
        const P_ = g.attributes.position.array; let ch = false;
        for (let k = 0; k < n * n; k++) { const x = P_[3 * k], y = -P_[3 * k + 2]; if (!inBox(x, y)) continue; const z = hs(x, y); if (Math.abs(z - P_[3 * k + 1]) > 1e-3) { P_[3 * k + 1] = z; ch = true; } }
        if (!ch) continue;
        for (let bi = 0; bi < 4; bi++) for (let i = 0; i < n; i++) { const k = bi === 0 ? i : bi === 1 ? (n - 1) * n + i : bi === 2 ? i * n : i * n + n - 1, o2 = n * n + bi * n + i; P_[3 * o2 + 1] = P_[3 * k + 1] - 0.6; }
        g.attributes.position.needsUpdate = true; g.computeVertexNormals(); g.computeBoundingSphere();
      }
      if (!hd && boxes.length) { const P_ = tg.attributes.position.array; for (let k = 0; k < G.z.length; k++) P_[3 * k + 1] = G.z[k]; tg.attributes.position.needsUpdate = true; tg.computeBoundingSphere(); }
    }
    // a pier keeps off the traced carriageway and the mapped roads (1 m), off the path (4 m) and other decks: its wall
    // checked along its length
    // (a road running along the deck is the deck's own: not in the way)
    const nearRoad = (x, y, m, dx, dy) => { const dl = Math.hypot(dx, dy) || 1; for (const [ax, ay, bx, by, hw] of roadSegs) { const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy || 1;
      if (Math.abs((vx * dx + vy * dy) / (Math.sqrt(l2) * dl)) > 0.85) continue;
      const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / l2)); if (Math.hypot(x - ax - vx * t, y - ay - vy * t) < hw + m) return true; } return false; };
    const pierClear = (C, cx, cy, ux, uy, len, dx, dy) => { const l = Math.hypot(ux, uy) || 1;
      for (let i = 0; i <= 6; i++) { const t = (i / 6 - 0.5) * len, x = cx + (ux / l) * t, y = cy + (uy / l) * t;
        if (distPath(x, y) < 4 || nearRoad(x, y, 1.0, dx, dy) || inPaved(x, y)) return false;
        if (live.some((o2) => o2 !== C && distLine(x, y, o2.run) < o2.hw + 1)) return false; }
      return true; };
    for (const C of live) {
      if (due()) await S();
      const { b, run, zt, dep, hw, rail, carries } = C;
      // piers about every 30 m (40 m where the deck stands over 12 m high), only under a deck over 3.5 m above the ground;
      // the wall along the road below where the deck crosses one at a skew (else across the deck)
      let acc = 0; const lens = [0]; for (let k = 1; k < run.length; k++) lens.push((acc += Math.hypot(run[k][0] - run[k - 1][0], run[k][1] - run[k - 1][1])));
      if (!C.low && acc > 24) {
        const sp = C.top > 12 ? 40 : 30, np = Math.max(1, Math.round(acc / sp));
        for (let m = 1; m < np; m++) for (const du of [0, 6, -6, 12, -12]) {           // (shifted up to 12 m to clear a road below)
          const u = (acc * m) / np + du; if (u < 6 || u > acc - 6) continue; let k = 1; while (k < run.length - 1 && lens[k] < u) k++;
          const p = run[k], g = hs(p[0], p[1]); if (zt[k] - dep - g < 3.5) continue;
          const q = run[Math.min(run.length - 1, k + 1)], o = run[Math.max(0, k - 1)], ex = q[0] - o[0], ey = q[1] - o[1], el = Math.hypot(ex, ey) || 1;
          // (the road below: the path's direction where it passes within 40 m)
          let ux = -ey / el, uy = ex / el, len = hw * 2 - 0.6;
          { let bd = 40, bk = -1; for (let j = 0; j + 3 < path.length; j += 2) { const dd = Math.hypot(path[j] - p[0], path[j + 1] - p[1]); if (dd < bd) { bd = dd; bk = j; } }
            if (bk >= 0) { const tx = path[bk + 2] - path[bk], ty = path[bk + 3] - path[bk + 1], tl = Math.hypot(tx, ty) || 1, sn = Math.abs((tx * ey - ty * ex) / (tl * el));
              if (sn > 0.5 && sn < 0.97) { ux = tx / tl; uy = ty / tl; len = Math.min(3 * hw, (hw * 2 - 0.6) / sn); } } }
          if (!pierClear(C, p[0], p[1], ux, uy, len, ex, ey)) continue;
          pier(K.con, p[0], p[1], ux, uy, len, g, zt[k] - dep); break;
        }
      }
      for (let k = 0; k < run.length - 1; k++) { const sg = [run[k][0], run[k][1], run[k + 1][0], run[k + 1][1], zt[k], zt[k + 1], hw]; allSegs.push(sg); if (carries) segs.push(sg); }
      // a deck the route rides on carries the painted swept path on its surface, like the ground does
      { const it = deckSteps(carries ? KC : K, run, zt, dep, hw, rail, (k) => hs(run[k][0], run[k][1]), false, null, (k) => !carries && distPath(run[k][0], run[k][1]) < 6.5, b.cls); while (!it.next().done) if (due()) await S(); }
      const m = Math.floor(run.length / 2);
      bridgeLabels.push({ x: run[m][0], y: run[m][1], z: zt[m], b, carries, low: C.low, top: C.top });
    }
    for (const mesh of bridgeMeshes(K, BK)) scene.add(mesh);
    for (const [k, mat] of [['road', deckOV], ['ballast', deckOV]]) { const mesh = KC[k].mesh(mat); if (mesh) scene.add(mesh); }
    if (segs.length) {
      const cell = 20, bins = new Map();
      segs.forEach((s, i) => { const x0 = Math.floor((Math.min(s[0], s[2]) - s[6]) / cell), x1 = Math.floor((Math.max(s[0], s[2]) + s[6]) / cell), y0 = Math.floor((Math.min(s[1], s[3]) - s[6]) / cell), y1 = Math.floor((Math.max(s[1], s[3]) + s[6]) / cell);
        for (let a = x0; a <= x1; a++) for (let c = y0; c <= y1; c++) { const key = a * 65536 + c; let L = bins.get(key); if (!L) bins.set(key, (L = [])); L.push(i); } });
      deckZ = (x, y) => {
        const L = bins.get(Math.floor(x / cell) * 65536 + Math.floor(y / cell)); if (!L) return null; let best = null;
        for (const i of L) { const s = segs[i], vx = s[2] - s[0], vy = s[3] - s[1], l2 = vx * vx + vy * vy || 1, t = ((x - s[0]) * vx + (y - s[1]) * vy) / l2;
          if (t < -0.05 || t > 1.05) continue; const tt = Math.max(0, Math.min(1, t)); if (Math.hypot(x - s[0] - vx * tt, y - s[1] - vy * tt) > s[6] + 0.3) continue;
          const z = s[4] + (s[5] - s[4]) * tt; if (best == null || z > best) best = z; }
        return best;
      };
      // the route may pass under a deck and later ride on it (loop ramps): on the deck only on the passes whose approach
      // comes up to the deck's level
      const Pp = path, npp = Pp.length / 2; pathOn = new Uint8Array(npp);
      for (let k = 0; k < npp;) {
        if (deckZ(Pp[2 * k], Pp[2 * k + 1]) == null) { k++; continue; }
        const a = k; while (k < npp && deckZ(Pp[2 * k], Pp[2 * k + 1]) != null) k++; const e = k - 1;
        const da = a > 0 ? Math.abs(hs(Pp[2 * a - 2], Pp[2 * a - 1]) - deckZ(Pp[2 * a], Pp[2 * a + 1])) : 99;
        const de = e < npp - 1 ? Math.abs(hs(Pp[2 * e + 2], Pp[2 * e + 3]) - deckZ(Pp[2 * e], Pp[2 * e + 1])) : 99;
        if (Math.min(da, de) < 2.5) pathOn.fill(1, a, e + 1);
      }
      // the swept path is painted on the deck the route rides on, not on the ground under it: a mask of those decks around
      // the passes that ride on them (a pass under the same deck keeps its paint on the road below)
      const runs = []; for (let k = 0; k < npp;) { if (!pathOn[k]) { k++; continue; } const a = Math.max(0, k - 15); while (k < npp && pathOn[k]) k++; const r = []; for (let j = a; j < Math.min(npp, k + 15); j++) r.push([Pp[2 * j], Pp[2 * j + 1]]); runs.push(r); }
      OV.uDeckM.value = deckMask(segs, ext, runs);
    }
  }
  await S();
  // ---- tunnels: walls, ceiling at the clear height drawn, lit band, portals with headwalls up to the lid, a gate at each
  // portal coloured by the verdict for the convoy (signed or estimated clear height ± its uncertainty, else 'check')
  const tunLabels = [];
  if (TUN.length) {
    const TM = tubeMaterials((x) => x, XRAY), K = { wall: new Acc(), ceil: new Acc(), lit: new Acc() }, Pp = H.path;
    const v = CONVOY ? CONVOY.dims : DEFAULTS, need = v.height + v.heightMargin;
    const GATE = { pass: 0x2fbf71, check: 0xffb020, fail: 0xff2a1a };
    for (const t of TUN) {
      const pts = [], zr = [];
      for (let j = t.i0; j <= t.i1; j++) { pts.push([Pp[2 * j], Pp[2 * j + 1]]); zr.push(t.prof[j - t.i0]); }
      // the lid's top just inside each portal, highest over the tube and 2 m beside it (the terrain keeps the lid)
      const top = [0, pts.length - 1].map((i) => { const a = pts[Math.max(0, Math.min(pts.length - 1, i + (i ? -1 : 1)))], nx = -(pts[Math.min(pts.length - 1, i + 1)][1] - pts[Math.max(0, i - 1)][1]), ny = pts[Math.min(pts.length - 1, i + 1)][0] - pts[Math.max(0, i - 1)][0], l = Math.hypot(nx, ny) || 1;
        let m = -Infinity; for (let d = t.dr - 2; d <= t.dl + 2.01; d += 1) m = Math.max(m, hs(a[0] + (nx / l) * d, a[1] + (ny / l) * d) - zr[i]); return m; });
      // the lowest lid (the terrain here) over the tube at each point: the slab stays under it
      const lidMin = pts.map((p, i) => { const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)], vx = b[0] - a[0], vy = b[1] - a[1], l = Math.hypot(vx, vy) || 1;
        let m = Infinity; for (let d = t.dr - 0.5; d <= t.dl + 0.51; d += 1) m = Math.min(m, hs(p[0] - (vy / l) * d, p[1] + (vx / l) * d) - zr[i]); return m; });
      tube(K, pts, zr, t.dl, t.dr, t.Hd, top, [true, true], lidMin);
      const c = t.signed ?? t.phys ?? t.est ?? null, unc = t.signed != null || t.phys != null ? 0 : t.unc ?? 0.5;
      const vd = c == null || t.check ? 'check' : c - unc >= need ? 'pass' : c + unc < need ? 'fail' : 'check', h = c ?? t.Hd;
      const gm = new THREE.MeshBasicMaterial({ color: GATE[vd], transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide });
      const gl = new THREE.LineBasicMaterial({ color: GATE[vd] });
      for (const i of [0, pts.length - 1]) {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)], tx = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tx, ty) || 1, nx = -ty / l, ny = tx / l, ux = tx / l, uy = ty / l;
        const P3 = (d, zz, al) => [pts[i][0] + nx * d + ux * al, zr[i] + zz, -(pts[i][1] + ny * d + uy * al)];
        const w0 = t.dr + 0.1, w1 = t.dl - 0.1, q = [P3(w0, h, -0.5), P3(w1, h, -0.5), P3(w1, h, 0.5), P3(w0, h, 0.5), P3(w0, 0, 0), P3(w0 + 0.25, 0, 0), P3(w0 + 0.25, h, 0), P3(w0, h, 0), P3(w1 - 0.25, 0, 0), P3(w1, 0, 0), P3(w1, h, 0), P3(w1 - 0.25, h, 0)];
        const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(q.flat(), 3)); g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11]);
        const m = new THREE.Mesh(g, gm); m.renderOrder = 4; scene.add(m);
        const lg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...P3(w0, h, 0)), new THREE.Vector3(...P3(w1, h, 0))]); const ln = new THREE.Line(lg, gl); ln.renderOrder = 5; scene.add(ln);
      }
      const kind = t.kind === 'overpass' ? 'wildlife overpass' : 'tunnel';
      const clr = t.signed != null ? `clear height ${t.signed.toFixed(2)} m signed` : t.phys != null ? `clear height ${t.phys.toFixed(2)} m` : t.est != null ? `clear height ≈ ${t.est.toFixed(1)} m ±${(t.unc ?? 0.5).toFixed(1)} (estimated)` : `standard clear height ${t.Hd.toFixed(2)} m: registered value needed`;
      const m0 = pts[Math.floor(pts.length / 2)];
      let len = 0; for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (Number.isFinite(t.len)) len = t.len;                        // (portal to portal; the path samples are 2 m apart)
      tunLabels.push({ x: m0[0], y: m0[1], z: Math.max(...zr) + Math.max(t.Hd + 1, ...top.filter(Number.isFinite)) + 3, sev: vd === 'fail' ? 2 : vd === 'check' ? 1 : 0, text: `${kind}${t.name ? ' ' + t.name : ''}, ${Math.round(len)} m · ${clr}` });
    }
    const wm = K.wall.mesh(TM.wall), cm = K.ceil.mesh(TM.ceil), lm = K.lit.mesh(TM.lit);
    if (lm) { lm.castShadow = false; lm.receiveShadow = false; }
    for (const m of [wm, cm, lm]) if (m) scene.add(m);
    // see-through while the convoy is in a tube and the camera above its ceiling (eased over about 0.3 s)
    let fade = 0, last = 0, roof = null; ROAD_XR.uRx.value.z = 0;
    scene.onBeforeRender = (r, sc, cam) => {
      const now = performance.now(), dt = last ? Math.min(0.1, (now - last) / 1000) : 0; last = now;
      let want = 0;
      if (CONVOY) for (const part of [CONVOY.tractor, CONVOY.dolly]) { const e = part.matrix.elements, tz = tubeZ(e[12], -e[14], true);
        if (tz != null && cam.position.y > tz + Math.max(...TUN.map((t) => t.Hd)) + 0.3) { want = 1; roof = [e[12], e[14], tz + Math.max(...TUN.map((t) => t.Hd)) + 0.3]; } }
      fade += (want - fade) * Math.min(1, dt * 8); XRAY.value = fade < 0.02 ? 0 : 0.7 * fade;
      if (XRAY.value > 0 && roof) ROAD_XR.uRx.value.set(roof[0], roof[1], 45, roof[2]); else ROAD_XR.uRx.value.z = 0;      // (streets on the lid)
      ROAD_XR.uRxf.value = XRAY.value;
    };
  }
  await S();
  // the carriageway traced on the photo: thin cyan outline (on the deck where the route rides on one)
  if (hd) { const v = []; let o = 0; const N = hd.A.pv_n, XY = hd.A.pv_xy, Pp = H.path;
    const nearPath = (x, y) => { for (let k = 0; k + 3 < Pp.length; k += 2) { const ax = Pp[k], ay = Pp[k + 1], vx = Pp[k + 2] - ax, vy = Pp[k + 3] - ay, l2 = vx * vx + vy * vy || 1, t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / l2)); if (Math.hypot(x - ax - vx * t, y - ay - vy * t) < 9) return true; } return false; };
    const nearPathOn = (x, y) => { if (!pathOn) return true; for (let k = 0; k + 3 < Pp.length; k += 2) { if (!pathOn[k >> 1]) continue; const ax = Pp[k], ay = Pp[k + 1], vx = Pp[k + 2] - ax, vy = Pp[k + 3] - ay, l2 = vx * vx + vy * vy || 1, t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / l2)); if (Math.hypot(x - ax - vx * t, y - ay - vy * t) < 9) return true; } return false; };
    const zo = (x, y) => { const tz = tubeZ(x, y); return (tz != null ? tz : deckZ && deckZ(x, y) != null && nearPathOn(x, y) ? deckZ(x, y) : hs(x, y)) + 0.12; };   // the street under a deck stays below it; in a tube its road
    for (let r = 0; r < N.length; r++) { if (due()) await S(); for (let k = 0; k < N[r] - 1; k++) { const a = o + k, b = o + k + 1; const ax = XY[2 * a], ay = XY[2 * a + 1], bx = XY[2 * b], by = XY[2 * b + 1];
      v.push(ax, zo(ax, ay), -ay, bx, zo(bx, by), -by); } o += N[r]; }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x22e0ff, transparent: true, opacity: 0.9 })); l.renderOrder = 3; scene.add(l); }
  await S();
  // modelled road surfaces (3D roads): asphalt over the traced carriageway, markings of the mapped roads on it
  const road3d = new THREE.Group(); scene.add(road3d);
  if (hd) {
    const rings = pvRings, inside = inPaved;
    // the mapped roads' lines: one-way (flag 8) and unpaved (16) where the bake has them (route_bake.py, newer data), in a
    // town where buildings stand around (8 or more within 60 m: the dashes 3 / 6 m there, 6 / 12 m outside)
    const bcell = new Map(); for (const f of H.bld) { const r = f.rings[0]; if (!r || r.length < 2) continue; const key = Math.floor(r[0] / 60) * 65536 + Math.floor(r[1] / 60); bcell.set(key, (bcell.get(key) || 0) + 1); }
    const townAt = (x, y) => { let c = 0; const cx = Math.floor(x / 60), cy = Math.floor(y / 60); for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) c += bcell.get((cx + i) * 65536 + cy + j) || 0; return c >= 8; };
    const lines = []; for (const f of H.roads) { const cls = codes.road[f.a[0]], fl = f.a[2] || 0; for (const r of f.rings) { const pts = []; for (let k = 0; k + 1 < r.length; k += 2) pts.push([r[k], r[k + 1]]); if (!pts.length) continue;
      const m = pts[pts.length >> 1]; lines.push({ pts, hw: f.a[1] / 10, cls, oneway: !!(fl & 8), unpaved: !!(fl & 16) || cls === 'track', town: townAt(m[0], m[1]) }); } }
    // two levels: on a bridge deck the deck's top, unless a road on the ground runs there (the road under the bridge)
    const groundSegs = []; for (const f of H.roads) { const cls = codes.road[f.a[0]]; if ((f.a[2] & 5) || ['footway', 'path', 'steps', 'cycleway', 'rail'].includes(cls)) continue; for (const r of f.rings) for (let k = 0; k + 3 < r.length; k += 2) groundSegs.push([r[k], r[k + 1], r[k + 2], r[k + 3], f.a[1] / 10]); }
    const nearGround = (x, y) => { for (const [ax, ay, bx, by, hw] of groundSegs) { const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy || 1, tt = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / l2)); if (Math.hypot(x - ax - vx * tt, y - ay - vy * tt) < hw + 1.0) return true; } return false; };
    const topDeck = (x, y) => { let best = null; for (const s of allSegs) { const vx = s[2] - s[0], vy = s[3] - s[1], l2 = vx * vx + vy * vy || 1, tt = ((x - s[0]) * vx + (y - s[1]) * vy) / l2; if (tt < -0.05 || tt > 1.05) continue; const t2 = Math.max(0, Math.min(1, tt)); if (Math.hypot(x - s[0] - vx * t2, y - s[1] - vy * t2) > s[6] - 0.2) continue; const z = s[4] + (s[5] - s[4]) * t2; if (best == null || z > best) best = z; } return best; };
    const onDeckTop = (x, y) => { const d = topDeck(x, y); return d != null && d - hs(x, y) > 2 && !nearGround(x, y) ? d : null; };
    const zRoad = (x, y) => { const tz = tubeZ(x, y); if (tz != null) return tz; const d = onDeckTop(x, y); return d != null ? d + 0.02 : hs(x, y); };
    // the asphalt carries the swept-path paint as the photo does (wheels, blade, oncoming lane): on the ground the paint of
    // the passes there, on a deck that of the passes on it
    const RM = roadMaterials(), mk = (key, fn) => patch(new THREE.MeshStandardMaterial({ map: RM.tex, vertexColors: true, roughness: 0.93, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }), {
      key, uniforms: OV, frag: { pars: OV_PARS, map: `vec4 texelColor = texture2D(map, vMapUv); diffuseColor.rgb = ${fn}(diffuseColor.rgb * texelColor.rgb);`, afterLights: 'totalEmissiveRadiance += overlayGlow();' } });
    try { const it = areaRoadsSteps(rings, lines, zRoad, inside, mk('hot-asphalt', 'overlay'), null, (x, y) => onDeckTop(x, y) != null); let st; while (!(st = it.next()).done) if (due()) await S(); for (const m of st.value) road3d.add(m); } catch (e) { console.warn('3D roads', e); }
  }
  await S();
  // ---- roads (ribbons on the ground)
  const roadGroups = {};
  const addRibbon = (arr, ring, hw, lift) => {
    const n = ring.length / 2; if (n < 2) return;
    let along = 0;
    for (let k = 0; k < n - 1; k++) {
      const x0 = ring[2 * k], y0 = ring[2 * k + 1], x1 = ring[2 * k + 2], y1 = ring[2 * k + 3];
      const dx = x1 - x0, dy = y1 - y0, l = Math.hypot(dx, dy); if (l < 0.05) continue;
      // split long pieces so the ribbon follows the ground
      const parts = Math.max(1, Math.ceil(l / 6));
      for (let s = 0; s < parts; s++) {
        const t0 = s / parts, t1 = (s + 1) / parts;
        const ax = x0 + dx * t0, ay = y0 + dy * t0, bx = x0 + dx * t1, by = y0 + dy * t1;
        const nxv = -dy / l * hw, nyv = dx / l * hw;
        const v0 = along + l * t0, v1 = along + l * t1;
        const pts = [[ax + nxv, ay + nyv, 0, v0], [ax - nxv, ay - nyv, 1, v0], [bx + nxv, by + nyv, 0, v1], [bx - nxv, by - nyv, 1, v1]];
        const P = pts.map(([x, y, u, v]) => [x, ground(x, y) + lift, -y, u, v]);
        for (const q of [0, 1, 2, 1, 3, 2]) arr.push(...P[q]);
      }
      along += l;
    }
  };
  for (const f of (hd ? [] : H.roads)) {
    const cls = codes.road[f.a[0]], hw = f.a[1] / 10;
    const key = cls === 'rail' ? 'rail' : ['footway', 'cycleway', 'path', 'pedestrian', 'steps'].includes(cls) ? 'path' : cls === 'track' ? 'track' : 'road';
    const lift = key === 'road' ? 0.18 + (12 - f.a[0]) * 0.004 : key === 'track' ? 0.12 : 0.08;
    const arr = (roadGroups[key + ':' + cls] ||= []);
    for (const r of f.rings) addRibbon(arr, r, hw, lift);
  }
  const ROAD_FRAG = (marks) => /* glsl */ `
    vec3 alb = diffuse;
    float g = vnoise(vWP.xz * 1.7) * 0.5 + vnoise(vWP.xz * 7.0) * 0.5;
    alb *= 0.9 + 0.2 * g;
    ${marks ? `
    float u = vRoadUv.x, v = vRoadUv.y;
    float w = uHalfW;
    float edge = (1.0 - smoothstep(0.10, 0.16, u * 2.0 * w - 0.35)) + (1.0 - smoothstep(0.10, 0.16, (1.0 - u) * 2.0 * w - 0.35));
    float centre = (1.0 - smoothstep(0.06, 0.1, abs(u - 0.5) * 2.0 * w)) * step(0.5, fract(v / 9.0)) * uCentre;
    alb = mix(alb, vec3(0.62), clamp(edge + centre, 0.0, 1.0) * 0.85);` : ''}
    diffuseColor.rgb = overlay(alb);`;
  const roadMats = [];
  for (const [key, arr] of Object.entries(roadGroups)) {
    if (!key.includes(':') || !arr.length) continue;
    const [kind, cls] = key.split(':');
    const a = new Float32Array(arr), n = a.length / 5;
    const P = new Float32Array(n * 3), UVr = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { P.set(a.subarray(i * 5, i * 5 + 3), i * 3); UVr[2 * i] = a[i * 5 + 3]; UVr[2 * i + 1] = a[i * 5 + 4]; }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(P, 3)); g.setAttribute('roadUv', new THREE.BufferAttribute(UVr, 2));
    g.computeVertexNormals();
    const hw = { motorway: 5.25, trunk: 4.5, primary: 3.75, secondary: 3.25, tertiary: 3.0 }[cls] || 2.5;
    const marks = kind === 'road' && ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'].includes(cls);
    const col = ROADCOL[cls] || ROADCOL.unknown;
    const m = patch(new THREE.MeshStandardMaterial({ color: new THREE.Color(...col), roughness: kind === 'road' ? 0.88 : 0.97, polygonOffset: true, polygonOffsetFactor: -2 - (kind === 'road' ? 2 : 0), polygonOffsetUnits: -2 }), {
      key: 'road-' + (marks ? 'm' : 'p'), uniforms: { ...OV, uHalfW: { value: hw }, uCentre: { value: ['motorway', 'trunk'].includes(cls) ? 0 : 1 } },
      vert: { pars: 'attribute vec2 roadUv; varying vec2 vRoadUv;', main: 'vRoadUv = roadUv;' },
      frag: { pars: OV_PARS + 'varying vec2 vRoadUv; uniform float uHalfW; uniform float uCentre;', map: ROAD_FRAG(marks), afterLights: 'totalEmissiveRadiance += overlayGlow();' },
    });
    roadMats.push(m);
    const mesh = new THREE.Mesh(g, m); mesh.receiveShadow = true; mesh.renderOrder = 1;
    scene.add(mesh);
  }
  await S();
  // ---- water
  for (const f of H.water) {
    const r = f.rings[0]; if (!r || r.length < 6) continue;
    const pts = []; let zmin = Infinity;
    for (let k = 0; k < r.length; k += 2) { pts.push(new THREE.Vector2(r[k], r[k + 1])); zmin = Math.min(zmin, ground(r[k], r[k + 1])); }
    const g = new THREE.ShapeGeometry(new THREE.Shape(pts)); g.rotateX(-Math.PI / 2); g.translate(0, zmin + 0.25, 0);
    const m = patch(new THREE.MeshStandardMaterial({ color: 0x1d3542, roughness: 0.12, metalness: 0.0, polygonOffset: true, polygonOffsetFactor: -1 }), { key: 'water' });
    scene.add(new THREE.Mesh(g, m));
  }
  // footprints with modelled roofs (map data): everywhere without LoD2, and where the LoD2 data have no building
  async function modelled(list) {
    const wallPos = [], wallCol = [], roofPos = [], roofCol = [];
    const WALLS = [[0.58, 0.56, 0.51], [0.64, 0.62, 0.57], [0.53, 0.50, 0.45], [0.61, 0.58, 0.50], [0.50, 0.51, 0.50]];
    const ROOFS = [[0.42, 0.17, 0.11], [0.50, 0.24, 0.15], [0.30, 0.15, 0.11], [0.36, 0.34, 0.33], [0.25, 0.24, 0.24]];
    const tri = (arr, carr, c, ...p) => { for (const q of p) { arr.push(...q); carr.push(...c); } };
    for (const f of list) {
      if (due()) await S();
      const r = f.rings[0]; if (!r || r.length < 6) continue;
      const h = Math.max(3, f.a[0] / 10), roof = f.a[1];
      let zb = Infinity; for (let k = 0; k < r.length; k += 2) zb = Math.min(zb, ground(r[k], r[k + 1]));
      const hh = hash2(r[0] * 0.13, r[1] * 0.17);
      const wc = WALLS[(hh * WALLS.length) | 0], rc = roof ? ROOFS[(((hh * 7.3) % 1) * 3) | 0] : ROOFS[3 + ((((hh * 5.1) % 1) * 2) | 0)];
      const ob = roof ? obb(r) : null;
      const eave = roof && ob ? Math.max(2.8, h - Math.min(ob.W * 0.42, 5.5)) : h;
      // walls
      let area = 0; for (let k = 0; k < r.length; k += 2) { const k2 = (k + 2) % r.length; area += r[k] * r[k2 + 1] - r[k2] * r[k + 1]; }
      const ccw = area > 0;
      for (let k = 0; k < r.length; k += 2) {
        const k2 = (k + 2) % r.length;
        let ax = r[k], ay = r[k + 1], bx = r[k2], by = r[k2 + 1];
        if (!ccw) { [ax, bx] = [bx, ax]; [ay, by] = [by, ay]; }
        const A = [ax, zb - 0.5, -ay], B = [bx, zb - 0.5, -by], C = [bx, zb + eave, -by], Dd = [ax, zb + eave, -ay];
        tri(wallPos, wallCol, wc, A, B, C, A, C, Dd);
      }
      if (!roof || !ob) {
        const pts = []; for (let k = 0; k < r.length; k += 2) pts.push(new THREE.Vector2(r[k], r[k + 1]));
        const tris = THREE.ShapeUtils.triangulateShape(pts, []);
        for (const t of tris) tri(roofPos, roofCol, rc.map((v) => v * 0.9), ...t.map((i) => [pts[i].x, zb + h, -pts[i].y]));
      } else {
        // gable roof over the oriented rectangle, ridge along the long side
        const { cx, cy, ux, uy, L, W } = ob, vx = -uy, vy = ux;
        const P = (a, b, z) => [cx + ux * a + vx * b, zb + z, -(cy + uy * a + vy * b)];
        const l = L / 2 + 0.3, w = W / 2 + 0.35;
        const e1 = P(-l, -w, eave), e2 = P(l, -w, eave), e3 = P(l, w, eave), e4 = P(-l, w, eave), r1 = P(-l, 0, h), r2 = P(l, 0, h);
        if (roof === 2) { const r1h = P(-l + Math.min(w, l * 0.4), 0, h), r2h = P(l - Math.min(w, l * 0.4), 0, h); tri(roofPos, roofCol, rc, e1, e2, r2h, e1, r2h, r1h, e3, e4, r1h, e3, r1h, r2h, e2, e3, r2h, e4, e1, r1h); }
        else { tri(roofPos, roofCol, rc, e1, e2, r2, e1, r2, r1, e3, e4, r1, e3, r1, r2); tri(roofPos, roofCol, wc, e2, e3, r2, e4, e1, r1); }
      }
    }
    const mk = (P, Cc, rough) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(Cc, 3)); g.computeVertexNormals();
      const m = new THREE.Mesh(g, patch(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: rough, side: THREE.DoubleSide }), { key: 'bld' })); m.castShadow = true; m.receiveShadow = true; scene.add(m); };
    if (wallPos.length) mk(wallPos, wallCol, 0.9);
    if (roofPos.length) mk(roofPos, roofCol, 0.75);
  }
  await S();
  // ---- buildings: official LoD2 (walls plaster, roofs carry the photo) or footprints with modelled roofs
  if (hd && hd.hdr.nbld > 0) {
    const A = hd.A, zb = hd.zb;
    // some LoD2 data model the pylons of overhead lines as round 'buildings': left out (the towers are drawn as lattices)
    const TW = H.obj.filter((f) => codes.obj[f.a[0]] === 'power_tower').map((f) => f.rings[0]);
    const atTower = (x, y) => TW.some((p) => Math.abs(p[0] - x) < 7 && Math.abs(p[1] - y) < 7);
    const keepTri = (Q, i) => !TW.length || !atTower((Q[i] + Q[i + 3] + Q[i + 6]) / 3, (Q[i + 1] + Q[i + 4] + Q[i + 7]) / 3);
    if (A.wall.length) { const P = new Float32Array(A.wall.length); for (let i = 0; i < A.wall.length; i += 3) { P[i] = A.wall[i]; P[i + 1] = A.wall[i + 2] + zb; P[i + 2] = -A.wall[i + 1]; }
      if (TW.length) for (let i = 0; i < A.wall.length; i += 9) if (!keepTri(A.wall, i)) P.fill(0, i, i + 9);       // degenerate: not drawn
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(P, 3)); g.computeVertexNormals();
      const m = new THREE.Mesh(g, patch(new THREE.MeshStandardMaterial({ color: 0xd2cbbd, emissive: 0x4a453e, roughness: 0.9, side: THREE.DoubleSide }), { key: 'lod2-wall' })); m.castShadow = true; m.receiveShadow = true; scene.add(m); }
    // roofs grouped by the photo tile their triangle centre falls in
    const byTile = new Map(), R3 = A.roof;
    const tileOf = (x, y) => hd.tiles.find((t) => x >= t.x0 && x < t.x0 + t.size && y >= t.y0 && y < t.y0 + t.size);
    for (let i = 0; i < R3.length; i += 9) {
      if (due()) await S();
      if (!keepTri(R3, i)) continue;
      const cx = (R3[i] + R3[i + 3] + R3[i + 6]) / 3, cy = (R3[i + 1] + R3[i + 4] + R3[i + 7]) / 3, t = tileOf(cx, cy); if (!t) continue;
      let a = byTile.get(t); if (!a) byTile.set(t, (a = { p: [], uv: [] }));
      for (let k = 0; k < 3; k++) { const x = R3[i + 3 * k], y = R3[i + 3 * k + 1], z = R3[i + 3 * k + 2] + zb; a.p.push(x, z + 0.05, -y); a.uv.push((x - t.x0) / t.size, (y - t.y0) / t.size); }
    }
    for (const [t, a] of byTile) {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(a.p, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(a.uv, 2)); g.computeVertexNormals();
      const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: t.tex, roughness: 0.8, side: THREE.DoubleSide })); m.castShadow = true; m.receiveShadow = true; scene.add(m);
    }
    // map buildings where the LoD2 data have none (another state's side of a border passage, gaps)
    const cellW = new Set(); for (let i = 0; i < A.wall.length; i += 3) cellW.add(Math.floor(A.wall[i] / 10) * 65536 + Math.floor(A.wall[i + 1] / 10));
    const hasLod = (x, y) => { const cx = Math.floor(x / 10), cy = Math.floor(y / 10); for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) if (cellW.has((cx + i) * 65536 + cy + j)) return true; return false; };
    await modelled(H.bld.filter((f) => { const r = f.rings[0]; if (!r || r.length < 6) return false; let cx = 0, cy = 0; for (let k = 0; k < r.length; k += 2) { cx += r[k]; cy += r[k + 1]; } return !hasLod(cx / (r.length / 2), cy / (r.length / 2)); }));
  } else await modelled(H.bld);
  await S();
  // ---- trees (instanced: conifers and broadleaves mixed by place)
  {
    // keep trees off the carriageways and tracks (WorldCover's 10 m cells reach over roads in the forest)
    const cell = 12, roadCells = new Map();
    for (const f of H.roads) {
      const cls = codes.road[f.a[0]]; if (['footway', 'path', 'steps', 'cycleway'].includes(cls)) continue;
      const hw = f.a[1] / 10 + 1.5;
      for (const r of f.rings) for (let k = 0; k + 3 < r.length; k += 2) {
        const l = Math.hypot(r[k + 2] - r[k], r[k + 3] - r[k + 1]);
        for (let d = 0; d <= l; d += 2) { const t = l ? d / l : 0, x = r[k] + (r[k + 2] - r[k]) * t, y = r[k + 1] + (r[k + 3] - r[k + 1]) * t;
          const key = Math.floor(x / cell) + ',' + Math.floor(y / cell); (roadCells.get(key) || roadCells.set(key, []).get(key)).push(x, y, hw); }
      }
    }
    const onRoad = (x, y) => {
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) { const a = roadCells.get((cx + i) + ',' + (cy + j)); if (!a) continue;
        for (let k = 0; k < a.length; k += 3) if ((a[k] - x) ** 2 + (a[k + 1] - y) ** 2 < a[k + 2] * a[k + 2]) return true; }
      return false;
    };
    const T0 = H.trees, keep = [];
    const HT = hd ? hd.A.tree : null, HC = hd ? hd.A.treec : null, info = [];
    const hsl = {}, lift = (c) => { c.getHSL(hsl); c.setHSL(Math.min(0.36, Math.max(0.17, hsl.h)), Math.min(0.75, hsl.s * 1.6 + 0.18), Math.min(0.42, hsl.l * 1.5 + 0.06)); };     // photo crowns are dark and grey: livelier, as in the road view
    if (HT) {
      // crowns from the surface model at a deck's edge whose top is the deck's height are the deck (railings, lamps)
      const deckTop = (x, y, r) => { let best = null; for (const s of allSegs) { const vx = s[2] - s[0], vy = s[3] - s[1], l2 = vx * vx + vy * vy || 1, tt = Math.max(0, Math.min(1, ((x - s[0]) * vx + (y - s[1]) * vy) / l2)); if (Math.hypot(x - s[0] - vx * tt, y - s[1] - vy * tt) < s[6] + r) { const z = s[4] + (s[5] - s[4]) * tt; if (best == null || z > best) best = z; } } return best; };
      for (let i = 0; i < HT.length; i += 4) {
      if (due()) await S();
        if (allSegs.length) { if (onDeck(HT[i], HT[i + 1])) continue; const z = deckTop(HT[i], HT[i + 1], HT[i + 3] + 1); if (z != null && Math.abs(hs(HT[i], HT[i + 1]) + HT[i + 2] - z) < 1.5) continue; }
        keep.push(HT[i], HT[i + 1]); info.push(i / 4);
      }
      // where the surface model's crowns were not searched (outside the core of the passage): the tree cover of the route
      // data, wherever no crown from the surface model stands within 10 m
      for (let i = 0; i < T0.length; i += 2) if ((!due() || (await S(), true)) && !treeNear(T0[i], T0[i + 1], 10) && !onRoad(T0[i], T0[i + 1]) && !(allSegs.length && onDeck(T0[i], T0[i + 1]))) { keep.push(T0[i], T0[i + 1]); info.push(-1); }
    }
    else for (let i = 0; i < T0.length; i += 2) if (!onRoad(T0[i], T0[i + 1])) keep.push(T0[i], T0[i + 1]);
    treeCount = keep.length / 2;
    const T = keep, n = T.length / 2;
    // conifer: three stacked tiers; broadleaf: three clustered crowns; both darker underneath (vertex colour)
    const shadeGeo = (g, y0, y1) => { const p = g.attributes.position, c = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) { const t = Math.max(0, Math.min(1, (p.getY(i) - y0) / (y1 - y0))); const v = 0.55 + 0.45 * t; c[3 * i] = v; c[3 * i + 1] = v; c[3 * i + 2] = v; }
      g.setAttribute('color', new THREE.BufferAttribute(c, 3)); return g; };
    const mergeG = (list) => { const gs = list.map((g) => (g.index ? g.toNonIndexed() : g)); let n2 = 0; for (const g of gs) n2 += g.attributes.position.count;
      const P = new Float32Array(n2 * 3); let o3 = 0; for (const g of gs) { P.set(g.attributes.position.array, o3 * 3); o3 += g.attributes.position.count; }
      const m = new THREE.BufferGeometry(); m.setAttribute('position', new THREE.BufferAttribute(P, 3)); m.computeVertexNormals(); return m; };
    const tiers = [[1.0, 0.0, 0.62], [0.68, 0.42, 1.0]].map(([r, y, h]) => { const c = new THREE.ConeGeometry(2.7 * r, h * 0.66, 6, 1, true); c.translate(0, y + h * 0.33, 0); return c; });
    const con = shadeGeo(mergeG(tiers), 0, 1);
    const blobs = [[0, 0, 0, 1], [0.5, -0.2, 0.15, 0.75]].map(([x, y, z, r]) => { const g = new THREE.IcosahedronGeometry(r, 0); g.translate(x, y, z); return g; });
    const brd = shadeGeo(mergeG(blobs), -0.9, 1.0);
    const trunk = new THREE.CylinderGeometry(0.22, 0.32, 1, 5, 1, true); trunk.translate(0, 0.5, 0);
    const mc = patch(new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.95, flatShading: true }), { key: 'tree-c' });
    const mb = patch(new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.95, flatShading: true }), { key: 'tree-b' });
    const mt = patch(new THREE.MeshStandardMaterial({ color: 0x3a2f25, roughness: 1 }), { key: 'trunk' });
    // trees standing between the camera and the convoy step aside (shrunk to nothing within 22 m of that line)
    const FADE = /* glsl */ `
      { vec3 c0 = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vec3 ab = uFocus - cameraPosition; float t = clamp(dot(c0 - cameraPosition, ab) / max(dot(ab, ab), 1.0), 0.0, 1.0);
        float d = distance(c0.xz, (cameraPosition + ab * t).xz);
        if (d < 22.0 && t > 0.05 && t < 0.97) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }`;
    treeGeos.push(con, brd, trunk);
    for (const m of [mc, mb, mt]) { const prev = m.onBeforeCompile; m.onBeforeCompile = (sh, r) => { prev(sh, r); sh.uniforms.uFocus = FOCUS; sh.vertexShader = sh.vertexShader.replace('void main() {', 'uniform vec3 uFocus;\nvoid main() {').replace(/}\s*$/, FADE + '\n}'); }; m.customProgramCacheKey = () => 'tree-fade|' + (m === mc ? 'c' : m === mb ? 'b' : 't'); }
    // two sets: trees within 170 m of the path cast shadows, the rest do not; both culled by their bounds
    const path = H.path, pc = 20, pcell = new Map();
    for (let k = 0; k < path.length; k += 2) { const key = Math.floor(path[k] / pc) + ',' + Math.floor(path[k + 1] / pc); if (!pcell.has(key)) pcell.set(key, 1); }
    // (the cells within reach of a path cell, made once: one look-up per tree instead of 361; the same answer)
    const nearC = new Set(), rr = Math.ceil(170 / pc), ck = (cx, cy) => (cx + 32768) * 65536 + (cy + 32768);
    for (const key of pcell.keys()) { const [a, b] = key.split(',').map(Number); for (let i = -rr; i <= rr; i++) for (let j = -rr; j <= rr; j++) nearC.add(ck(a + i, b + j)); }
    const nearPath = (x, y) => nearC.has(ck(Math.floor(x / pc), Math.floor(y / pc)));
    // tiles of 250 m (camera and shadow frustum culling work per tile), near-path tiles cast shadows
    const tiles = new Map();
    for (let i = 0; i < n; i++) { if (due()) await S(); const near = nearPath(T[2 * i], T[2 * i + 1]) ? 0 : 1;
      const key = near + ':' + Math.floor(T[2 * i] / 250) + ',' + Math.floor(T[2 * i + 1] / 250); (tiles.get(key) || tiles.set(key, []).get(key)).push(i); }
    const sets = [...tiles.entries()].map(([k, ids]) => ({ near: k[0] === '0', ids }));
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), col = new THREE.Color(), up = new THREE.Vector3(0, 1, 0);
    const coniferShare = hm.coniferShare ?? (hm.id === 'factory' ? 0.8 : hm.id === 'forest' ? 0.55 : 0.35);
    for (const { near, ids } of sets) {
      if (!ids.length) continue;
      const ic = new THREE.InstancedMesh(con, mc, ids.length), ib = new THREE.InstancedMesh(brd, mb, ids.length), it = near ? new THREE.InstancedMesh(trunk, mt, ids.length) : null;
      let nc = 0, nb = 0;
      for (let k = 0; k < ids.length; k++) {
        const i = ids[k]; if (due()) await S();
        const x = T[2 * i], y = T[2 * i + 1], z = ground(x, y);
        const r1 = hash2(x * 0.71, y * 0.37), r2 = hash2(x * 0.19 + 3, y * 0.53), r3 = hash2(x * 0.43, y * 0.91 + 7);
        let h = 15 + r2 * 13, crR = null, cc = null, isCon = r1 < coniferShare;
        if (HT && info[i] >= 0) { const j = info[i]; h = HT[4 * j + 2]; crR = HT[4 * j + 3]; cc = [HC[3 * j] / 255, HC[3 * j + 1] / 255, HC[3 * j + 2] / 255];
          isCon = cc[0] < 0.2 && cc[1] < 0.26 && h > 8 && crR < 3.4; }
        q.setFromAxisAngle(up, r3 * 6.28);
        if (cc) {
          const lin = (v) => Math.pow(v, 2.2) * 1.6;
          if (isCon) { p.set(x, z + h * 0.22, -y); const w = Math.max(0.5, Math.min(1.4, crR / 2.7)); s.set(w, h * 0.8, w); m4.compose(p, q, s); ic.setMatrixAt(nc, m4); col.setRGB(lin(cc[0]), lin(cc[1]), lin(cc[2])); lift(col); ic.setColorAt(nc, col); nc++; }
          else { const cr = Math.max(1.2, crR); p.set(x, z + Math.max(cr + 1, h - cr), -y); s.set(cr, Math.min(cr, h * 0.45), cr); m4.compose(p, q, s); ib.setMatrixAt(nb, m4); col.setRGB(lin(cc[0]), lin(cc[1]), lin(cc[2])); lift(col); ib.setColorAt(nb, col); nb++; }
        } else if (r1 < coniferShare) {
          p.set(x, z + h * 0.22, -y); s.set(0.8 + r3 * 0.45, h * 0.8, 0.8 + r3 * 0.45); m4.compose(p, q, s); ic.setMatrixAt(nc, m4);
          col.setHSL(0.29 + r2 * 0.05, 0.30, 0.13 + r3 * 0.06); ic.setColorAt(nc, col); nc++;
        } else {
          const cr = 2.6 + r2 * 2.0;
          p.set(x, z + h - cr, -y); s.set(cr, cr * 0.95, cr); m4.compose(p, q, s); ib.setMatrixAt(nb, m4);
          col.setHSL(0.22 + r3 * 0.07, 0.42, 0.17 + r2 * 0.09); ib.setColorAt(nb, col); nb++;
        }
        if (it) { p.set(x, z, -y); s.set(1, h * 0.55, 1); m4.compose(p, q, s); it.setMatrixAt(k, m4); }
      }
      ic.count = nc; ib.count = nb;
      for (const m of [ic, ib, it]) { if (!m || !m.count) continue; m.castShadow = near && m !== it; m.receiveShadow = true; m.computeBoundingSphere(); scene.add(m); }
    }
  }
  await S();
  // signals and signs mapped as a node on the carriageway mark the junction: placed at the traced kerb, as in the road view
  const PV = []; if (hd) { let o = 0; for (let r = 0; r < hd.A.pv_n.length; r++) { const a = []; for (let k = 0; k < hd.A.pv_n[r]; k++) a.push([hd.A.pv_xy[2 * (o + k)], hd.A.pv_xy[2 * (o + k) + 1]]); PV.push(a); o += hd.A.pv_n[r]; } }
  const inPV = (x, y) => { let c = false; for (const r of PV) for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
  const KERB = new Set(['traffic_signals', 'stop', 'give_way', 'bus_stop']);
  const objAt = (f) => {
    const kind = codes.obj[f.a[0]], x = f.rings[0][0], y = f.rings[0][1];
    if (!KERB.has(kind) || !PV.length || !inPV(x, y)) return [x, y];
    let best = null, bd = Infinity;
    for (const r of PV) for (let i = 0; i + 1 < r.length; i++) { const [ax, ay] = r[i], [bx, by] = r[i + 1], vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy || 1, tt = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / l2)), px = ax + vx * tt, py = ay + vy * tt, d = Math.hypot(x - px, y - py); if (d < bd) { bd = d; best = [px, py]; } }
    if (!best || bd > 15) return [x, y];
    return [best[0] + ((best[0] - x) / (bd || 1)) * 0.8, best[1] + ((best[1] - y) / (bd || 1)) * 0.8];
  };
  await S();
  // overhead lines: the mapped towers joined to their neighbours along the line (120-520 m apart, the two neighbours on
  // opposite sides), conductors hung between the crossarms with a typical sag; the wires' height is not measured
  const towers = H.obj.filter((f) => codes.obj[f.a[0]] === 'power_tower'), towerDir = new Map(), spans = [];
  {
    const P_ = towers.map((f) => f.rings[0]);
    const nb = (i, excl) => { let best = -1, bd = Infinity; for (let j = 0; j < P_.length; j++) { if (j === i) continue; const d = Math.hypot(P_[j][0] - P_[i][0], P_[j][1] - P_[i][1]); if (d < 120 || d > 520) continue;
      if (excl >= 0) { const a = Math.atan2(P_[excl][1] - P_[i][1], P_[excl][0] - P_[i][0]), b = Math.atan2(P_[j][1] - P_[i][1], P_[j][0] - P_[i][0]); let da = Math.abs(a - b); if (da > Math.PI) da = 2 * Math.PI - da; if (da < (140 * Math.PI) / 180) continue; }
      if (d < bd) { bd = d; best = j; } } return best; };
    const key = new Set();
    P_.forEach((p, i) => { const a = nb(i, -1); if (a < 0) return; const b = nb(i, a);
      for (const j of [a, b]) if (j >= 0) { const k = Math.min(i, j) + ':' + Math.max(i, j); if (!key.has(k)) { key.add(k); spans.push([i, j]); } }
      const q = b >= 0 ? [P_[b][0] - P_[a][0], P_[b][1] - P_[a][1]] : [P_[a][0] - p[0], P_[a][1] - p[1]];
      towerDir.set(towers[i], Math.atan2(q[1], q[0])); });
  }
  // tower height: from the LoD2 model of the pylon where there is one, else typical (34 m)
  const towerH = new Map();
  if (hd && hd.A.wall && hd.A.wall.length) for (const f of towers) { const [x, y] = f.rings[0]; let zm = -Infinity; const W = hd.A.wall;
    for (let i = 0; i < W.length; i += 3) if (Math.abs(W[i] - x) < 7 && Math.abs(W[i + 1] - y) < 7) zm = Math.max(zm, W[i + 2] + hd.zb);
    if (Number.isFinite(zm)) { const h = zm - hs(x, y); if (h > 15 && h < 90) towerH.set(f, h); } }
  function latticeTower(Ht = 34) {
    const G = [], up = new THREE.Vector3(0, 1, 0);
    const bar = (a, b, r) => { const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), d = B.clone().sub(A), L = d.length(); const g = new THREE.CylinderGeometry(r, r, L, 4, 1, true);
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, d.normalize())); const m = A.clone().add(B).multiplyScalar(0.5); g.translate(m.x, m.y, m.z); G.push(g); };
    const W0 = 3.2 * Math.sqrt(Ht / 34), W1 = 0.8;
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) bar([sx * W0, 0, sz * W0], [sx * W1, Ht, sz * W1], 0.16);
    for (let k = 0; k < 6; k++) { const y0 = (k / 6) * Ht * 0.8, y1 = ((k + 1) / 6) * Ht * 0.8, w = (y) => W0 + (W1 - W0) * (y / Ht);
      for (const [a, b] of [[[1, 1], [-1, 1]], [[1, -1], [-1, -1]], [[1, 1], [1, -1]], [[-1, 1], [-1, -1]]]) bar([a[0] * w(y0), y0, a[1] * w(y0)], [b[0] * w(y1), y1, b[1] * w(y1)], 0.07); }
    for (const [y, l] of [[Ht * 0.7, 7.5], [Ht * 0.84, 6], [Ht, 1.5]]) { const g = new THREE.BoxGeometry(0.5, 0.5, 2 * l); g.translate(0, y, 0); G.push(g); }
    return G;
  }
  await S();
  // ---- street furniture (merged per hot spot) and barriers
  {
    const parts = [];
    const add = (g, x, y, rot, col) => { g.rotateY(rot); g.translate(x, ground(x, y), -y); const n = g.attributes.position.count, c = new Float32Array(n * 3); for (let i = 0; i < n; i++) c.set(col, i * 3); g.setAttribute('color', new THREE.BufferAttribute(c, 3)); parts.push(g.index ? g.toNonIndexed() : g); };
    const GREYM = [0.42, 0.43, 0.44], DARK = [0.08, 0.08, 0.09], RED = [0.7, 0.05, 0.04], WOOD = [0.32, 0.24, 0.16], YEL = [0.85, 0.65, 0.1], WHITE = [0.85, 0.85, 0.83];
    // signs face the traffic they serve: on the route, our direction (right side) or the oncoming one (left side); on a side
    // road, the traffic coming towards the junction
    const signList = [], PP = H.path; let SIG_GEO = null;
    const faceYaw = (x, y) => {
      let bk = 0, bd = Infinity; for (let k = 0; k + 3 < PP.length; k += 2) { const d = (PP[k] - x) ** 2 + (PP[k + 1] - y) ** 2; if (d < bd) { bd = d; bk = k; } }
      const tx0 = PP[bk + 2] - PP[bk], ty0 = PP[bk + 3] - PP[bk + 1], tl = Math.hypot(tx0, ty0) || 1, tx = tx0 / tl, ty = ty0 / tl;
      const dx = x - PP[bk], dy = y - PP[bk + 1], side = tx * dy - ty * dx;            // > 0: left of the route
      let fx, fy;
      if (Math.sqrt(bd) < 7) { fx = side > 0 ? tx : -tx; fy = side > 0 ? ty : -ty; }
      else { const l = Math.hypot(dx, dy) || 1; fx = dx / l; fy = dy / l; }
      return Math.atan2(fx, -fy);
    };
    // the speed in force near a point (the HD pack's speeds along the route; 50 where there are none): sets sign sizes
    const SPD = (hd && hd.hdr.spd) || [];
    const speedNear = (x, y) => { let bd = Infinity, v = 0; for (const [sx, sy, f, b] of SPD) { const d = (sx - x) ** 2 + (sy - y) ** 2; if (d < bd) { bd = d; v = Math.max(f, b); } } return v || 50; };
    for (const f of H.obj) {
      if (due()) await S();
      const kind = codes.obj[f.a[0]], [x, y] = objAt(f), r = hash2(x, y) * 6.28;
      if (kind === 'street_lamp') { const pl = new THREE.CylinderGeometry(0.08, 0.12, 8.5, 6); pl.translate(0, 4.25, 0); add(pl, x, y, r, GREYM); const arm = new THREE.BoxGeometry(1.6, 0.15, 0.3); arm.translate(0.8, 8.4, 0); add(arm, x, y, r, GREYM); }
      // a German signal post (signs.js): vehicle signal facing the traffic it serves, pedestrian signal and push button
      else if (kind === 'traffic_signals') { const g = (SIG_GEO || (SIG_GEO = signalGeo(false))).clone(); g.rotateY(faceYaw(x, y)); g.translate(x, ground(x, y), -y); parts.push(g); }
      else if (kind === 'power_pole') { const pl = new THREE.CylinderGeometry(0.13, 0.17, 10, 6); pl.translate(0, 5, 0); add(pl, x, y, r, WOOD); }
      else if (kind === 'power_tower') { const tw = towerDir.get(f); for (const g of latticeTower(towerH.get(f))) add(g, x, y, tw != null ? tw : r, GREYM); }
      else if (kind === 'bus_stop' || kind === 'stop' || kind === 'give_way') signList.push({ x, y, z: ground(x, y), yaw: faceYaw(x, y), code: { bus_stop: '224', stop: '206', give_way: '205' }[kind], v: null, speed: speedNear(x, y) });
      else if (kind === 'information') { const pl = new THREE.CylinderGeometry(0.04, 0.04, 2.4, 5); pl.translate(0, 1.2, 0); add(pl, x, y, r, GREYM); const sg = new THREE.BoxGeometry(0.7, 0.45, 0.04); sg.translate(0, 2.2, 0); add(sg, x, y, r, [0.92, 0.92, 0.9]); }
      else if (kind === 'bollard') { const pl = new THREE.CylinderGeometry(0.1, 0.1, 0.9, 6); pl.translate(0, 0.45, 0); add(pl, x, y, r, WHITE); }
    }
    for (const [x, y, fx, fy, code, v, sp] of (hd && hd.hdr.signs) || []) {
      const e = { x, y, z: ground(x, y), yaw: Math.atan2(fx, -fy), code, v, speed: sp || (code === '274' && v <= 50 ? 50 : 100) };
      // a gantry spans 16 m across the face direction, its boards towards the traffic (the span's right side)
      if (code === 'gantry') e.span = [x + fy * 8, y - fx * 8, x - fy * 8, y + fx * 8];
      signList.push(e);
    }
    if (signList.length) for (const m of buildSigns(signList)) scene.add(m);
    // barriers: guardrails as W-beam strips with posts, fences / walls / hedges as strips
    const strip = (r, h0, h1, col) => {
      for (let k = 0; k + 3 < r.length; k += 2) {
        const ax = r[k], ay = r[k + 1], bx = r[k + 2], by = r[k + 3], l = Math.hypot(bx - ax, by - ay); if (l < 0.1) continue;
        const parts_ = Math.max(1, Math.ceil(l / 4));
        for (let s = 0; s < parts_; s++) {
          const t0 = s / parts_, t1 = (s + 1) / parts_;
          const x0 = ax + (bx - ax) * t0, y0 = ay + (by - ay) * t0, x1 = ax + (bx - ax) * t1, y1 = ay + (by - ay) * t1;
          const z0 = ground(x0, y0), z1 = ground(x1, y1);
          const g = new THREE.BufferGeometry();
          const P = [x0, z0 + h0, -y0, x1, z1 + h0, -y1, x1, z1 + h1, -y1, x0, z0 + h0, -y0, x1, z1 + h1, -y1, x0, z0 + h1, -y0];
          g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.computeVertexNormals();
          const c = new Float32Array(18); for (let i = 0; i < 6; i++) c.set(col, i * 3); g.setAttribute('color', new THREE.BufferAttribute(c, 3));
          parts.push(g);
        }
      }
    };
    for (const f of H.bar) {
      if (due()) await S();
      const kind = codes.bar[f.a[0]];
      for (const r of f.rings) {
        if (kind === 'guard_rail') {
          strip(r, 0.45, 0.78, [0.62, 0.64, 0.66]);
          for (let k = 0; k + 3 < r.length; k += 2) { const l = Math.hypot(r[k + 2] - r[k], r[k + 3] - r[k + 1]); for (let d = 0; d < l; d += 2) { const t = d / l, x = r[k] + (r[k + 2] - r[k]) * t, y = r[k + 1] + (r[k + 3] - r[k + 1]) * t; const pg = new THREE.BoxGeometry(0.1, 0.8, 0.1); pg.translate(0, 0.4, 0); add(pg, x, y, 0, [0.4, 0.41, 0.42]); } }
        } else if (kind === 'wall' || kind === 'retaining_wall') strip(r, 0, 1.4, [0.62, 0.6, 0.56]);
        else if (kind === 'hedge') strip(r, 0, 1.6, [0.18, 0.3, 0.14]);
        else if (kind === 'fence' || kind === 'gate') strip(r, 0, 1.6, [0.25, 0.27, 0.27]);
      }
    }
    if (parts.length) {
      let n = 0; for (const g of parts) n += g.attributes.position.count;
      const P = new Float32Array(n * 3), N = new Float32Array(n * 3), Cc = new Float32Array(n * 3); let o2 = 0;
      for (const g of parts) { if (!g.attributes.normal) g.computeVertexNormals(); P.set(g.attributes.position.array, o2 * 3); N.set(g.attributes.normal.array, o2 * 3); Cc.set(g.attributes.color.array, o2 * 3); o2 += g.attributes.position.count; }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(P, 3)); g.setAttribute('normal', new THREE.BufferAttribute(N, 3)); g.setAttribute('color', new THREE.BufferAttribute(Cc, 3));
      const m = new THREE.Mesh(g, patch(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.2, side: THREE.DoubleSide }), { key: 'furn' }));
      m.castShadow = true; scene.add(m);
    }
  }
  await S();
  // conductors: four phases on the crossarms and an earth wire on top, 3 % sag
  if (spans.length) {
    const v = [], P_ = towers.map((f) => f.rings[0]);
    for (const [i, j] of spans) {
      const [ax, ay] = P_[i], [bx, by] = P_[j], L = Math.hypot(bx - ax, by - ay), nx = -(by - ay) / L, ny = (bx - ax) / L, za = ground(ax, ay), zb = ground(bx, by);
      const ht = ((towerH.get(towers[i]) || 34) + (towerH.get(towers[j]) || 34)) / 2;
      for (const [o, h] of [[7.2, ht * 0.7], [-7.2, ht * 0.7], [5.7, ht * 0.84], [-5.7, ht * 0.84], [0, ht]]) {
        let px, py, pz;
        for (let k = 0; k <= 24; k++) { const tt = k / 24, x = ax + (bx - ax) * tt + nx * o, y = ay + (by - ay) * tt + ny * o, z = za + (zb - za) * tt + h - 0.03 * L * 4 * tt * (1 - tt);
          if (k) v.push(px, pz, -py, x, z, -y); px = x; py = y; pz = z; }
      }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    scene.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x2a2d30, transparent: true, opacity: 0.85 })));
  }
  await S();
  // ---- night lights: street lamps and signals
  const lampPts = [], sigPts = [];
  for (const f of H.obj) { const kind = codes.obj[f.a[0]], [x, y] = objAt(f);
    if (kind === 'street_lamp') lampPts.push(x, ground(x, y) + 8.3, -y); else if (kind === 'traffic_signals') sigPts.push(x, ground(x, y) + 3.3, -y); }
  const glowTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'); const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.2, 'rgba(255,255,255,.5)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); })();
  const nightLights = new THREE.Group(); nightLights.visible = false; scene.add(nightLights);
  for (const [pts, col, size] of [[lampPts, 0xffc070, 9], [sigPts, 0xff4020, 4]]) {
    if (!pts.length) continue;
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    nightLights.add(new THREE.Points(g, new THREE.PointsMaterial({ color: col, size, map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })));
  }
  await S();
  // ---- conflict markers: rings on the ground at each finding
  const markers = new THREE.Group(); scene.add(markers);
  const ringGeo = new THREE.RingGeometry(1.6, 2.2, 32); ringGeo.rotateX(-Math.PI / 2);
  const tags = [];
  const shown = [];
  const rank = (L) => (L.carries ? 2 : 0) + (L.b.clr ? 1 : 0);
  for (const L of [...bridgeLabels].sort((p, q) => rank(q) - rank(p))) {
    if (!L.carries && !L.b.clr && !(L.top >= 4)) continue;            // ramps onto embankments, low crossings: no label
    const near = shown.filter((q) => Math.hypot(q.x - L.x, q.y - L.y) < 30).length; if (near >= 3 && !L.carries) continue; shown.push(L);   // close together: stacked
    const nm = L.b.name ? ` ${L.b.name}` : '';
    const kind = L.b.sub === 'rail' ? 'railway bridge' : ['path', 'footway', 'cycleway', 'pedestrian', 'steps'].includes(L.b.cls) ? 'footbridge' : 'bridge';
    const c = L.b.clr, clr = c ? (c.signed != null ? `clear height ${c.signed.toFixed(2)} m signed` : c.est != null ? `clear height ≈ ${c.est.toFixed(1)} m ±${(c.unc || 0.5).toFixed(1)} (estimated)` : 'clear height not measured') : null;
    tags.push({ x: L.x, y: L.y, z: L.z + 2.5 + near * 3.2, sev: 0, text: L.carries ? `route on ${kind}${nm}` : clr ? `${kind}${nm} over the route · ${clr}` : `${kind}${nm} · deck ${L.top.toFixed(1)} m above ground` });
  }
  tags.push(...tunLabels);
  const merged = [];
  for (const c of hm.conflicts) {
    if (!c.at) continue;
    const m = merged.find((q) => q.what === c.what && Math.hypot(q.at[0] - c.at[0], q.at[1] - c.at[1]) < 35);
    if (m) { m.n++; m.length = (m.length || 0) + (c.length || 0); m.area = (m.area || 0) + (c.area || 0); continue; }
    merged.push({ ...c, n: 1 });
  }
  for (const c of merged) {
    const z = ground(c.at[0], c.at[1]);
    const col = c.sev >= 3 ? 0xff3b2e : 0xffb020;
    const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.95, depthTest: false }));
    m.position.set(c.at[0], z + 0.4, -c.at[1]); m.renderOrder = 5; markers.add(m);
    tags.push({ x: c.at[0], y: c.at[1], z: z + 4, text: c.what + (c.n > 1 ? ` × ${c.n}` : '') + (c.length ? ` · ${Math.round(c.length)} m` : c.area ? ` · ${Math.round(c.area)} m²` : ''), sev: c.sev >= 3 ? 2 : 1 });
  }
  await S();
  // ---- convoy
  const convoy = CONVOY || (CONVOY = makeConvoy());
  const PS = H.poses, np = PS.length / 14, pstep = R.header.sections[`h_${hm.id}_poses`].step || 2;
  const pose = new Float32Array(14);
  const poseAt = (u) => {
    const f = Math.max(0, Math.min(np - 1.001, u * (np - 1))), i = f | 0, t = f - i;
    for (let k = 0; k < 14; k++) pose[k] = PS[i * 14 + k] * (1 - t) + PS[(i + 1) * 14 + k] * t;
    return pose;
  };
  // the convoy's ground at progress u: a deck counts only where the convoy's own stretch of the path runs on it
  const groundFor = (u) => { const npp = H.path.length / 2, kc = u * (npp - 1);
    return (x, y) => { if (TUN.length) { const tz = tubeZ(x, y); if (tz != null) return tz; }       // in a tube: its road
      const g = hs(x, y); if (!deckZ) return g; const d = deckZ(x, y); if (d == null || d <= g) return g; if (!pathOn) return d;
      const P2 = H.path; for (let j = Math.max(0, Math.floor(kc - 70)); j <= Math.min(npp - 1, Math.ceil(kc + 15)); j++) if (Math.abs(P2[2 * j] - x) < 9 && Math.abs(P2[2 * j + 1] - y) < 9) return pathOn[j] ? d : g;
      return d; }; };
  await S();
  // the path driven (thin line on the road)
  {
    const inTube = (j) => TUN.find((t) => j >= t.e0 && j <= t.e1);
    const v = []; const r = H.path, zp = (k) => { const t = inTube(k >> 1); return (t ? t.eprof[(k >> 1) - t.e0] : pathOn && !pathOn[k >> 1] ? hs(r[k], r[k + 1]) : ground(r[k], r[k + 1])) + 0.35; };
    for (let k = 0; k + 3 < r.length; k += 2) v.push(r[k], zp(k), -r[k + 1], r[k + 2], zp(k + 2), -r[k + 3]);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.7 })); l.renderOrder = 3; scene.add(l);
  }
  const meanZ = (() => { let s = 0; for (let i = 0; i < G.z.length; i++) s += G.z[i]; return s / G.z.length; })();
  return {
    setRoads3D(on) { road3d.visible = on; },
    attach() { scene.add(convoy.group); },
    scene, surface: (x, y) => ground(x, y), ground, groundFor, tubeZ, tunnels: TUN, get xray() { return XRAY.value; }, convoy, get treeCount() { return treeCount; }, FOCUS, nightLights, markers, tags, OV, ovTex, poseAt, np, ext, meanZ, H, bridgeLabels,
    setOverlay(on) { OV.uOvOn.value = on ? 1 : 0; },
    pathLength: (np - 1) * pstep,
    dispose() {
      ROAD_XR.uRx.value.z = 0;
      scene.remove(convoy.group);
      scene.traverse((o) => { if (o.isInstancedMesh) o.dispose(); else if (o.geometry) o.geometry.dispose(); });
      treeGeos.forEach((g) => g.dispose());
      ovTex.dispose(); tex.dispose(); glowTex.dispose(); tileTexs.forEach((t) => t.dispose()); if (OV.uDeckM.value !== NOMASK) OV.uDeckM.value.dispose(); if (TUBE.uTubeM.value !== NOMASK) TUBE.uTubeM.value.dispose();
    },
  };
}
