// Scene data: the header (JSON) and one deflate-raw blob of binary sections, both embedded in the page.
// Layout of the blob is written by windpark-hosskirch/tools/build_data.py.

export function b64bytes(b64) {
  const bin = atob(b64.replace(/\s+/g, ''));
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

export async function inflate(u8) {
  if (typeof DecompressionStream === 'undefined') return inflateRaw(u8);
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Fallback raw-DEFLATE decoder (RFC 1951, after zlib's puff.c) for browsers without DecompressionStream.
const LB = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LE = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DB = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DE = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const ORD = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
export function inflateRaw(src) {
  let out = new Uint8Array(src.length * 3 + 1024), op = 0, ip = 0, bb = 0, bc = 0;
  const bits = (n) => { while (bc < n) { bb |= src[ip++] << bc; bc += 8; } const v = bb & ((1 << n) - 1); bb >>>= n; bc -= n; return v; };
  const room = (n) => { if (op + n > out.length) { const o = new Uint8Array(Math.max(out.length * 2, op + n)); o.set(out); out = o; } };
  const table = (len, n) => {
    const count = new Uint16Array(16), offs = new Uint16Array(16), sym = new Uint16Array(n);
    for (let i = 0; i < n; i++) count[len[i]]++;
    count[0] = 0;
    for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
    for (let i = 0; i < n; i++) if (len[i]) sym[offs[len[i]]++] = i;
    return { count, sym };
  };
  const decode = (h) => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const c = h.count[len];
      if (code - c < first) return h.sym[index + (code - first)];
      index += c; first = (first + c) << 1; code <<= 1;
    }
    throw new Error('inflate: bad code');
  };
  let fixedL = null, fixedD = null, last = 0;
  while (!last) {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bb = 0; bc = 0;
      const n = src[ip] | (src[ip + 1] << 8); ip += 4;
      room(n); out.set(src.subarray(ip, ip + n), op); op += n; ip += n;
      continue;
    }
    let L, D;
    if (type === 1) {
      if (!fixedL) {
        const l = new Uint8Array(288); l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
        fixedL = table(l, 288); fixedD = table(new Uint8Array(30).fill(5), 30);
      }
      L = fixedL; D = fixedD;
    } else {
      const nl = bits(5) + 257, nd = bits(5) + 1, nc = bits(4) + 4;
      const cl = new Uint8Array(19);
      for (let i = 0; i < nc; i++) cl[ORD[i]] = bits(3);
      const C = table(cl, 19), lens = new Uint8Array(nl + nd);
      for (let i = 0; i < nl + nd;) {
        const sym = decode(C);
        if (sym < 16) lens[i++] = sym;
        else {
          let v = 0, r;
          if (sym === 16) { v = lens[i - 1]; r = 3 + bits(2); } else if (sym === 17) r = 3 + bits(3); else r = 11 + bits(7);
          while (r--) lens[i++] = v;
        }
      }
      L = table(lens.subarray(0, nl), nl); D = table(lens.subarray(nl), nd);
    }
    for (;;) {
      let sym = decode(L);
      if (sym < 256) { room(1); out[op++] = sym; continue; }
      if (sym === 256) break;
      sym -= 257;
      const len = LB[sym] + bits(LE[sym]);
      const ds = decode(D), dist = DB[ds] + bits(DE[ds]);
      room(len);
      for (let k = 0; k < len; k++, op++) out[op] = out[op - dist];
    }
  }
  return out.subarray(0, op);
}

export class Reader {
  constructor(u8) { this.u = u8; this.p = 0; }
  var() {
    let v = 0, s = 1, b;
    do { b = this.u[this.p++]; v += (b & 127) * s; s *= 128; } while (b & 128);
    return v;
  }
  svar() { const v = this.var(); return v % 2 ? -(v + 1) / 2 : v / 2; }
}

// Vector layer: [{a: [attrs], rings: [Float32Array x,y,x,y…]}], metres in the local frame.
export function readLayer(u8, q) {
  const r = new Reader(u8);
  const n = r.var(), na = r.var();
  const out = new Array(n);
  let px = 0, py = 0;
  for (let i = 0; i < n; i++) {
    const a = new Array(na);
    for (let k = 0; k < na; k++) a[k] = r.var();
    const nr = r.var(), rings = new Array(nr);
    for (let j = 0; j < nr; j++) {
      const np = r.var(), c = new Float32Array(np * 2);
      for (let k = 0; k < np; k++) {
        px += r.svar(); py += r.svar();
        c[2 * k] = px / q; c[2 * k + 1] = py / q;
      }
      rings[j] = c;
    }
    out[i] = { a, rings };
  }
  return out;
}

// Height grid, predictor-coded (left + up − up-left) residuals.
export function readGrid(u8, m) {
  const n = m.n, r = new Reader(u8), Q = new Int32Array(n * n), z = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x;
    const p = y === 0 ? (x === 0 ? 0 : Q[i - 1]) : x === 0 ? Q[i - n] : Q[i - 1] + Q[i - n] - Q[i - n - 1];
    Q[i] = p + r.svar();
    z[i] = m.base + Q[i] * m.q;
  }
  return { n, res: m.res, ext: m.ext, z };
}

export async function decodeScene(header, blobB64) {
  const raw = await inflate(b64bytes(blobB64));
  const S = header.sections;
  const sec = (k) => raw.subarray(S[k].off, S[k].off + S[k].len);
  const L = (k) => readLayer(sec(k), S[k].q);
  const fw = S.forestWide;
  return {
    header,
    demCore: readGrid(sec('demCore'), S.demCore),
    demWide: readGrid(sec('demWide'), S.demWide),
    forest: L('forest'), landuse: L('landuse'), water: L('water'), waterway: L('waterway'),
    roads: L('roads'), rail: L('rail'), buildings: L('buildings'), power: L('power'),
    supports: L('supports'), trees: L('trees'), pads: L('pads'), cranepads: L('cranepads'),
    forestWide: { n: fw.n, res: fw.res, ext: fw.ext, bits: sec('forestWide') },
    openness: { n: S.openness.n, res: S.openness.res, ext: S.openness.ext, levels: S.openness.levels, g: sec('openness') },
    demFar: readGrid(sec('demFar'), S.demFar),
    farCover: { n: S.farCover.n, res: S.farCover.res, ext: S.farCover.ext, g: sec('farCover') },
    horizon: (() => { const r = new Reader(sec('horizon')), n = S.horizon.n, a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = r.svar() * S.horizon.scale; return a; })(),
  };
}

// ---------------------------------------------------------------------------------------------- projection
// Local transverse Mercator (k0 = 1) on WGS84, centred on the scene origin. Krüger series, mm-accurate here.
const A = 6378137, F = 1 / 298.257223563;
const N_ = F / (2 - F), A_ = A / (1 + N_) * (1 + N_ * N_ / 4 + N_ ** 4 / 64);
const al = [N_ / 2 - 2 * N_ ** 2 / 3 + 5 * N_ ** 3 / 16, 13 * N_ ** 2 / 48 - 3 * N_ ** 3 / 5, 61 * N_ ** 3 / 240];
const be = [N_ / 2 - 2 * N_ ** 2 / 3 + 37 * N_ ** 3 / 96, N_ ** 2 / 48 + N_ ** 3 / 15, 17 * N_ ** 3 / 480];
const de = [2 * N_ - 2 * N_ ** 2 / 3 - 2 * N_ ** 3, 7 * N_ ** 2 / 3 - 8 * N_ ** 3 / 5, 56 * N_ ** 3 / 15];
const rad = Math.PI / 180, e2n = 2 * Math.sqrt(N_) / (1 + N_);
function tmFwd(lat, dlon) {
  const phi = lat * rad, lam = dlon * rad;
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - e2n * Math.atanh(e2n * Math.sin(phi)));
  const xi = Math.atan2(t, Math.cos(lam)), eta = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t));
  let x = eta, y = xi;
  for (let j = 1; j <= 3; j++) { x += al[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta); y += al[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta); }
  return [A_ * x, A_ * y];
}
export function makeProjection(lon0, lat0) {
  const y0 = tmFwd(lat0, 0)[1];
  const toLocal = (lon, lat) => { const [x, y] = tmFwd(lat, lon - lon0); return [x, y - y0]; };
  const toLonLat = (x, y) => {
    const xi = (y + y0) / A_, eta = x / A_;
    let xp = xi, ep = eta;
    for (let j = 1; j <= 3; j++) { xp -= be[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta); ep -= be[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta); }
    const chi = Math.asin(Math.sin(xp) / Math.cosh(ep));
    let phi = chi;
    for (let j = 1; j <= 3; j++) phi += de[j - 1] * Math.sin(2 * j * chi);
    return [lon0 + Math.atan2(Math.sinh(ep), Math.cos(xp)) / rad, phi / rad];
  };
  return { toLocal, toLonLat };
}

// ---------------------------------------------------------------------------------------------- geometry helpers
export function pointInRing(x, y, c) {
  let inside = false;
  for (let i = 0, j = c.length - 2; i < c.length; j = i, i += 2) {
    const xi = c[i], yi = c[i + 1], xj = c[j], yj = c[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function distToRing(x, y, c) {
  let best = Infinity;
  for (let i = 0, j = c.length - 2; i < c.length; j = i, i += 2) {
    const ax = c[j], ay = c[j + 1], bx = c[i], by = c[i + 1];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = ax + t * dx - x, ey = ay + t * dy - y, d = ex * ex + ey * ey;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}
export function ringBBox(c) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < c.length; i += 2) {
    const x = c[i], y = c[i + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}
export function ringArea(c) {
  let a = 0;
  for (let i = 0, j = c.length - 2; i < c.length; j = i, i += 2) a += c[j] * c[i + 1] - c[i] * c[j + 1];
  return a / 2;
}

// Small deterministic PRNG / hash
export function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function hash2(x, y) {
  let h = Math.imul(Math.floor(x) | 0, 374761393) + Math.imul(Math.floor(y) | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
