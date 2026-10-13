// Overhead lines from OSM. 110 kV (EnBW, 2 circuits / 6 conductors): Donau-type lattice pylons (upper arm 1 phase per
// side, lower arm 2 phases per side, earth wire on the peak) with sagging conductors. Medium-voltage lines on poles.
import * as THREE from 'three';
import { patch } from './env.js';

function box(list, x0, y0, z0, x1, y1, z1, t) {
  // thin beam between two points (square section t)
  const a = new THREE.Vector3(x0, y0, z0), b = new THREE.Vector3(x1, y1, z1);
  const L = a.distanceTo(b); if (L < 1e-3) return;
  const g = new THREE.BoxGeometry(t, L, t);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  m.compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
  g.applyMatrix4(m);
  list.push(g.toNonIndexed());
}
function merge(list) {
  let n = 0; for (const g of list) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3); let o = 0;
  for (const g of list) { pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3); o += g.attributes.position.count; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return g;
}

// Donau pylon, local: x along the line, z across, y up. Returns geometry + conductor attachment points.
const PY = { H: 37, lowY: 24.5, upY: 30.5, low: [3.6, 7.4], up: 4.6, base: 3.1, top: 0.95 };
function pylonGeometry() {
  const L = [];
  const w = (y) => PY.base + (PY.top - PY.base) * Math.min(1, y / PY.upY);
  const levels = [0, 7, 13.5, 19, PY.lowY, PY.upY, PY.H];
  const corners = (y) => { const s = y <= PY.upY ? w(y) : PY.top * (1 - (y - PY.upY) / (PY.H - PY.upY) * 0.7); return [[s, s], [s, -s], [-s, -s], [-s, s]]; };
  for (let i = 0; i + 1 < levels.length; i++) {
    const y0 = levels[i], y1 = levels[i + 1], c0 = corners(y0), c1 = corners(y1);
    for (let k = 0; k < 4; k++) {
      box(L, c0[k][0], y0, c0[k][1], c1[k][0], y1, c1[k][1], 0.22);                               // legs
      const k2 = (k + 1) % 4;
      if ((i + k) % 2) box(L, c0[k][0], y0, c0[k][1], c1[k2][0], y1, c1[k2][1], 0.1);               // bracing
      else box(L, c0[k2][0], y0, c0[k2][1], c1[k][0], y1, c1[k][1], 0.1);
      box(L, c1[k][0], y1, c1[k][1], c1[k2][0], y1, c1[k2][1], 0.1);                               // horizontals
    }
  }
  // cross arms (tapered trusses approximated by 3 beams each)
  for (const s of [-1, 1]) {
    const wl = w(PY.lowY), wu = w(PY.upY);
    box(L, -wl, PY.lowY, s * wl, 0, PY.lowY, s * PY.low[1], 0.16); box(L, wl, PY.lowY, s * wl, 0, PY.lowY, s * PY.low[1], 0.16);
    box(L, 0, PY.lowY + 2.2, s * wl, 0, PY.lowY, s * PY.low[1], 0.12);
    box(L, -wu, PY.upY, s * wu, 0, PY.upY, s * PY.up, 0.15); box(L, wu, PY.upY, s * wu, 0, PY.upY, s * PY.up, 0.15);
    box(L, 0, PY.upY + 1.8, s * wu, 0, PY.upY, s * PY.up, 0.11);
  }
  const attach = [[0, PY.H, 0]];                                                                  // earth wire
  for (const s of [-1, 1]) { attach.push([0, PY.upY - 2.2, s * PY.up]); for (const z of PY.low) attach.push([0, PY.lowY - 2.2, s * z]); }
  // insulator strings
  for (const a of attach.slice(1)) box(L, a[0], a[1], a[2], a[0], a[1] + 2.2, a[2], 0.14);
  return { geo: merge(L), attach };
}
// far version (beyond ~900 m, where the lattice is sub-pixel): legs, peak and cross arms, 108 triangles instead of 1080
function pylonLowGeometry() {
  const L = [];
  for (const [a, b] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) box(L, a * PY.base, 0, b * PY.base, a * PY.top, PY.upY, b * PY.top, 0.5);
  box(L, 0, PY.upY, 0, 0, PY.H, 0, 0.45);
  for (const s of [-1, 1]) { box(L, 0, PY.lowY, 0, 0, PY.lowY, s * PY.low[1], 0.35); box(L, 0, PY.upY, 0, 0, PY.upY, s * PY.up, 0.35); }
  return merge(L);
}
function poleGeometry() {
  const L = [];
  box(L, 0, 0, 0, 0, 11, 0, 0.28);
  box(L, 0, 10.2, -0.9, 0, 10.2, 0.9, 0.12);
  return { geo: merge(L), attach: [[0, 10.4, -0.8], [0, 11.1, 0], [0, 10.4, 0.8]] };
}

export function makePower(data, ground) {
  const group = new THREE.Group(); group.name = 'power';
  const pyl = pylonGeometry(), pole = poleGeometry();
  const steel = patch(new THREE.MeshStandardMaterial({ color: 0x8a918f, roughness: 0.55, metalness: 0.6 }), { key: 'steel' });
  const wood = patch(new THREE.MeshStandardMaterial({ color: 0x5a4a3a, roughness: 0.9, metalness: 0 }), { key: 'wood' });
  const wire = [];
  const towersByKind = { 1: [], 2: [] };
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1);
  for (const line of data.power) {
    const kind = line.a[0], c = line.rings[0], n = c.length / 2;
    if (n < 2) continue;
    const T = kind === 1 ? pyl : pole;
    const frames = [];
    for (let i = 0; i < n; i++) {
      const x = c[2 * i], y = c[2 * i + 1];
      // heading: bisector of adjacent spans
      let dx = 0, dy = 0;
      if (i > 0) { const l = Math.hypot(x - c[2 * i - 2], y - c[2 * i - 1]) || 1; dx += (x - c[2 * i - 2]) / l; dy += (y - c[2 * i - 1]) / l; }
      if (i < n - 1) { const l = Math.hypot(c[2 * i + 2] - x, c[2 * i + 3] - y) || 1; dx += (c[2 * i + 2] - x) / l; dy += (c[2 * i + 3] - y) / l; }
      const ang = Math.atan2(dy, dx);             // local frame angle
      const gz = ground.height(x, y);
      q.setFromAxisAngle(up, ang);                // world: rotate +x (east) to heading (x, -y) → angle = atan2(dy, dx)
      m4.compose(new THREE.Vector3(x, gz, -y), q, one);
      towersByKind[kind].push(m4.clone());
      frames.push({ x, y, gz, ang });
    }
    // conductors: catenary approximated by a parabola, sag 3 % of the span (110 kV) / 2 %
    for (let i = 0; i + 1 < frames.length; i++) {
      const A = frames[i], B = frames[i + 1];
      const span = Math.hypot(B.x - A.x, B.y - A.y), sag = span * (kind === 1 ? 0.03 : 0.02);
      for (const at of T.attach) {
        const pa = attachWorld(A, at), pb = attachWorld(B, at);
        const segs = 14;
        for (let s = 0; s < segs; s++) {
          for (const tt of [s / segs, (s + 1) / segs]) {
            const x = pa[0] + (pb[0] - pa[0]) * tt, y = pa[1] + (pb[1] - pa[1]) * tt - 4 * sag * tt * (1 - tt), z = pa[2] + (pb[2] - pa[2]) * tt;
            wire.push(x, y, z);
          }
        }
      }
    }
  }
  function attachWorld(F, at) {
    const ca = Math.cos(F.ang), sa = Math.sin(F.ang);
    // local attach (x along line, z across) → local frame (east, north) → world (x, y, -north)
    const ex = at[0] * ca + at[2] * sa, ny = at[0] * sa - at[2] * ca;
    return [F.x + ex, F.gz + at[1], -(F.y + ny)];
  }
  // 110 kV pylons in ~1.4 km tiles (culled on their own), each tile full detail within ~900 m, the light version beyond
  // (no shadow from that one); medium-voltage poles in one mesh
  const tiles = [], lowGeo = pylonLowGeometry(), byTile = new Map();
  for (const m of towersByKind[1]) {
    const x = m.elements[12], y = -m.elements[14], k = Math.floor(x / 1400) + ',' + Math.floor(y / 1400);
    if (!byTile.has(k)) byTile.set(k, []); byTile.get(k).push(m);
  }
  for (const list of byTile.values()) {
    const hi = new THREE.InstancedMesh(pyl.geo, steel, list.length);
    list.forEach((m, i) => hi.setMatrixAt(i, m));
    hi.instanceMatrix.needsUpdate = true; hi.computeBoundingSphere();
    hi.castShadow = true; hi.receiveShadow = true; hi.name = 'pylons';
    const lo = new THREE.InstancedMesh(lowGeo, steel, list.length);
    lo.instanceMatrix = hi.instanceMatrix; lo.computeBoundingSphere(); lo.receiveShadow = true; lo.name = 'pylons-far'; lo.visible = false;
    group.add(hi, lo); tiles.push({ hi, lo, c: hi.boundingSphere.center, r: hi.boundingSphere.radius });
  }
  if (towersByKind[2].length) {
    const list = towersByKind[2], im = new THREE.InstancedMesh(pole.geo, wood, list.length);
    list.forEach((m, i) => im.setMatrixAt(i, m));
    im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere();
    im.castShadow = true; im.receiveShadow = true; im.name = 'supports-2';
    group.add(im);
  }
  const wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.Float32BufferAttribute(wire, 3)); wg.computeBoundingSphere();
  // 1-px lines: fade with distance so seven conductors don't merge into a dark band far away
  const wmat = patch(new THREE.LineBasicMaterial({ color: 0x2c3032, transparent: true, opacity: 0.85 }), { key: 'wire', frag: { beforeFog: 'gl_FragColor.a *= clamp(320.0 / distance(vWP, cameraPosition) - 0.25, 0.0, 1.0);' } });
  const wires = new THREE.LineSegments(wg, wmat); wires.name = 'wires';
  group.add(wires);
  const update = (cam) => { for (const t of tiles) { const near = cam.distanceTo(t.c) - t.r < 900; t.hi.visible = near; t.lo.visible = !near; } };
  return { group, update };
}
