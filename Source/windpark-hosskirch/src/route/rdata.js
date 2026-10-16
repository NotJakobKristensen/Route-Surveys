// Decoding of the route-survey data (route.bin sections, see tools/route_bake.py).
import { Reader, readLayer, inflate, b64bytes } from '../data.js';

export async function decodeRoute(header, binB64) {
  const raw = await inflate(b64bytes(binB64));
  const S = header.sections;
  const sec = (k) => raw.subarray(S[k].off, S[k].off + S[k].len);
  const layer = (k) => readLayer(sec(k), S[k].q);
  const route = layer('route')[0].rings[0];
  const km = new Float32Array(route.length / 2);
  { const r = new Reader(sec('routeKm')); let m = 0; for (let i = 0; i < km.length; i++) { m += r.svar(); km[i] = m / 1000; } }
  return {
    header, sec, layer,
    mapDem: grid(sec('mapDem'), S.mapDem.nx, S.mapDem.ny, S.mapDem.base, S.mapDem.q),
    outerDem: grid(sec('outerDem'), S.outerDem.nx, S.outerDem.ny, S.outerDem.base, S.outerDem.q),
    route, km, sev: sec('routeSev'),
    borders: layer('borders'), rivers: layer('rivers'), lakes: layer('lakes'), motorways: layer('motorways'),
  };
}

// predictor-coded height grid (left + up − up-left), row 0 = south (y0) for hot spots / north for the map (see bake)
export function grid(u8, nx, ny, base, q) {
  const r = new Reader(u8), Q = new Int32Array(nx * ny), z = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = y * nx + x;
    const p = y === 0 ? (x === 0 ? 0 : Q[i - 1]) : x === 0 ? Q[i - nx] : Q[i - 1] + Q[i - nx] - Q[i - nx - 1];
    Q[i] = p + r.svar();
    z[i] = base + Q[i] * q;
  }
  return { nx, ny, z };
}

export function points(u8, q) {
  const r = new Reader(u8), n = r.var(), a = new Float32Array(n * 2);
  let x = 0, y = 0;
  for (let i = 0; i < n; i++) { x += r.svar(); y += r.svar(); a[2 * i] = x / q; a[2 * i + 1] = y / q; }
  return a;
}

// convoy poses, second-order delta coded (prediction 2·p[i−1] − p[i−2])
export function poses(u8, n, q) {
  const r = new Reader(u8), a = new Float32Array(n * 14), p1 = new Float64Array(14), p2 = new Float64Array(14);
  for (let i = 0; i < n; i++) for (let k = 0; k < 14; k++) {
    const v = 2 * p1[k] - p2[k] + r.svar(); p2[k] = p1[k]; p1[k] = v; a[i * 14 + k] = v / q;
  }
  return a;
}

// tree cover: 1 bit per 10 m cell (little-endian bit order) → jittered tree positions, 1–2 per cell, deterministic
export function treesFromMask(u8, m) {
  const out = [];
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  for (let j = 0; j < m.ny; j++) for (let i = 0; i < m.nx; i++) {
    const b = j * m.nx + i;
    if (!((u8[b >> 3] >> (b & 7)) & 1)) continue;
    const k = rnd() < 0.55 ? 2 : 1;
    for (let q = 0; q < k; q++) out.push(m.x0 + (i + 0.05 + rnd() * 0.9) * m.step, m.y0 + (j + 0.05 + rnd() * 0.9) * m.step);
  }
  return new Float32Array(out);
}

export function decodeHot(R, id) {
  const S = R.header.sections, p = `h_${id}_`;
  const g = S[p + 'ground'];
  const ground = grid(R.sec(p + 'ground'), g.nx, g.ny, g.base, g.q);
  return {
    ground: { ...ground, x0: g.x0, y0: g.y0, step: g.step },
    roads: R.layer(p + 'roads'), bld: R.layer(p + 'bld'), obj: R.layer(p + 'obj'), bar: R.layer(p + 'bar'), water: R.layer(p + 'water'),
    trees: treesFromMask(R.sec(p + 'trees'), S[p + 'trees']),
    path: R.layer(p + 'path')[0].rings[0],
    poses: poses(R.sec(p + 'poses'), S[p + 'poses'].n, S[p + 'poses'].q),
    swept: R.layer(p + 'swept'),
    bout: S[p + 'bout'] ? R.layer(p + 'bout') : null,          // the blade beyond the edge (route_blade.mjs), where baked so
  };
}

// bilinear sample of a grid laid out from (x0, y0) with spacing step, row-major from y0 upwards
export function sampler(G) {
  const { nx, ny, z, x0, y0, step } = G;
  return (x, y) => {
    let fx = (x - x0) / step, fy = (y - y0) / step;
    fx = Math.max(0, Math.min(nx - 1.001, fx)); fy = Math.max(0, Math.min(ny - 1.001, fy));
    const ix = fx | 0, iy = fy | 0, tx = fx - ix, ty = fy - iy, i = iy * nx + ix;
    return (z[i] * (1 - tx) + z[i + 1] * tx) * (1 - ty) + (z[i + nx] * (1 - tx) + z[i + nx + 1] * tx) * ty;
  };
}

// the blade beyond the edge at a passage (tools/route_bake.py, section h_<id>_blade, from route_blade.mjs): the stretches
// beyond on the normals of the passage's window (place along the line in 1/sub m from the window's start sa, from / to in
// m along the normal, left +), how far the blade reaches beyond per front-axle metre ia … ib, and the paved surface traced
// on its photo along those normals (for the page's own sweep of another vehicle); null where the data have none
export function decodeBlade(R, id) {
  const m = R.header.sections[`h_${id}_blade`]; if (!m) return null;
  const r = new Reader(R.sec(`h_${id}_blade`));
  // rows, one per normal: its place, then intervals [start, length] in cm, each the difference from the row before's of that rank
  const rows = (q = 0.01) => {
    const nrow = r.var(), u = [], ru = [], at = [0], d = []; let pu = 0, prev = [];
    for (let i = 0; i < nrow; i++) {
      pu += r.var(); const c = r.var(), cur = [];
      for (let j = 0; j < c; j++) { const p = prev[j] || [0, 0], a = p[0] + r.svar(), l = p[1] + r.svar(); cur.push([a, l]); u.push(pu); d.push(a * q, (a + l) * q); }
      prev = cur; ru.push(pu); at.push(d.length / 2);
    }
    return { u, ru, at, d };
  };
  const R1 = rows(), runs = { u: Int32Array.from(R1.u), d0: Float32Array.from(R1.d.filter((_, i) => i % 2 === 0)), d1: Float32Array.from(R1.d.filter((_, i) => i % 2 === 1)) };
  const depth = new Float32Array(m.ib - m.ia + 1); for (let c = r.var(), i = -1; c > 0; c--) { i += r.var() + 1; depth[i] = r.var() / 100; }
  const R2 = rows(m.pq || 0.01);
  return { sa: m.sa, n: m.n, ia: m.ia, ib: m.ib, sub: m.sub, runs, depth, paved: { u: Int32Array.from(R2.ru), at: Int32Array.from(R2.at), d: Float32Array.from(R2.d) } };
}
