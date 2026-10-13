// Terrain height in the local frame: bicubic (Catmull-Rom) over the 32 m detail grid inside ±CORE, the 128 m grid
// outside, blended over the last 300 m. Local edits on top: level crane pads / foundations, lakes below their surface.
import { pointInRing, distToRing, ringBBox } from './data.js';

const cr = (p0, p1, p2, p3, t) => p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));

function sampler(G) {
  const { n, res, ext, z } = G;
  return (x, y) => {
    const fx = (x + ext) / res, fy = (ext - y) / res;
    let ix = Math.floor(fx), iy = Math.floor(fy);
    const tx = fx - ix, ty = fy - iy;
    const c = (i) => (i < 0 ? 0 : i > n - 1 ? n - 1 : i);
    const x0 = c(ix - 1), x1 = c(ix), x2 = c(ix + 1), x3 = c(ix + 2);
    let r0, r1, r2, r3, row;
    row = c(iy - 1) * n; r0 = cr(z[row + x0], z[row + x1], z[row + x2], z[row + x3], tx);
    row = c(iy) * n; r1 = cr(z[row + x0], z[row + x1], z[row + x2], z[row + x3], tx);
    row = c(iy + 1) * n; r2 = cr(z[row + x0], z[row + x1], z[row + x2], z[row + x3], tx);
    row = c(iy + 2) * n; r3 = cr(z[row + x0], z[row + x1], z[row + x2], z[row + x3], tx);
    return cr(r0, r1, r2, r3, ty);
  };
}

export function makeGround(data) {
  const H = data.header, CORE = H.core;
  const core = sampler(data.demCore), wide = sampler(data.demWide);
  const B0 = CORE - 300;
  const base = (x, y) => {
    const m = Math.max(Math.abs(x), Math.abs(y));
    if (m <= B0) return core(x, y);
    const w = wide(x, y);
    if (m >= CORE) return w;
    let t = (m - B0) / (CORE - B0); t = t * t * (3 - 2 * t);
    return core(x, y) * (1 - t) + w * t;
  };

  // --- edits
  const edits = [];
  let RAMP = 16;
  const rampFor = (ring, level) => {
    // ramp wide enough for ≤ ~18° slopes: 3 × the largest height difference along the edge (14–70 m)
    let dh = 0;
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      const L = Math.hypot(ring[i] - ring[j], ring[i + 1] - ring[j + 1]), n = Math.max(1, Math.ceil(L / 4));
      for (let k = 0; k < n; k++) { const f = k / n, x = ring[j] + (ring[i] - ring[j]) * f, y = ring[j + 1] + (ring[i + 1] - ring[j + 1]) * f; dh = Math.max(dh, Math.abs(base(x, y) - level)); }
    }
    return Math.max(14, Math.min(70, 3 * dh));
  };
  // one flat region per turbine (crane pad ∪ foundation Ø 25.5 m + 2 m), level with the tower foot; the ramp width
  // comes from the data build (iterated there until the terrain it meets is reached at ≤ 18°, at most 90 m)
  for (const p of data.cranepads) {
    const ring = p.rings[0], level = H.base + p.a[0] / 10;
    edits.push({ kind: 'flat', ring, level, ramp: p.a.length > 1 && p.a[1] > 0 ? p.a[1] : rampFor(ring, level), bb: ringBBox(ring) });
  }
  RAMP = Math.max(...edits.map((e) => e.ramp || 16));
  for (const w of data.water) {
    const ring = w.rings[0], level = H.base + w.a[0] / 10;
    edits.push({ kind: 'water', ring, holes: w.rings.slice(1), level, bb: ringBBox(ring) });
  }
  // grid index (256 m cells)
  const CELL = 256, NC = Math.ceil((2 * CORE + 512) / CELL), OFF = CORE + 256;
  const index = new Map();
  edits.forEach((e, i) => {
    const pad = e.kind === 'flat' ? e.ramp : 8;
    const cx0 = Math.floor((e.bb[0] - pad + OFF) / CELL), cx1 = Math.floor((e.bb[2] + pad + OFF) / CELL);
    const cy0 = Math.floor((e.bb[1] - pad + OFF) / CELL), cy1 = Math.floor((e.bb[3] + pad + OFF) / CELL);
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
      const k = cy * NC + cx; if (!index.has(k)) index.set(k, []); index.get(k).push(i);
    }
  });
  const smooth = (t) => t * t * (3 - 2 * t);
  function height(x, y) {
    let h = base(x, y);
    const list = index.get(Math.floor((y + OFF) / CELL) * NC + Math.floor((x + OFF) / CELL));
    if (!list) return h;
    for (const i of list) {
      const e = edits[i];
      if (e.kind === 'flat') {
        const R = e.ramp;
        if (x < e.bb[0] - R || x > e.bb[2] + R || y < e.bb[1] - R || y > e.bb[3] + R) continue;
        if (pointInRing(x, y, e.ring)) { h = e.level; continue; }
        const d = distToRing(x, y, e.ring);
        if (d < R) h = h + (e.level - h) * smooth(1 - d / R);
      } else {
        if (x < e.bb[0] - 8 || x > e.bb[2] + 8 || y < e.bb[1] - 8 || y > e.bb[3] + 8) continue;
        let inside = pointInRing(x, y, e.ring);
        if (inside) for (const hole of e.holes) if (pointInRing(x, y, hole)) { inside = false; break; }
        const d = distToRing(x, y, e.ring);
        if (inside) h = Math.min(h, e.level - 0.5 - Math.min(d, 25) * 0.12);
        else if (d < 8) h = Math.max(h, Math.min(h + 1.5, e.level + 0.25 * smooth(d / 8) + 0.05));   // a dry bank, never a levee
      }
    }
    return h;
  }
  return { height, base, edits };
}
