// The road packs (r/) and the passages' traced paved surface (h/ pv) as the road view reads them, for the Node tools that run
// the page's own code on the route (route_blade.mjs, route_scan.mjs). ROUTE_ROOT: the route's folder.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SRC = path.join(here, '..', 'src', 'route');
const { pavedAlong } = await import(path.join(SRC, 'bladeedge.js'));
const { tmInverse, utm33fwd } = await import(path.join(SRC, 'geo.js'));

export const ROOT = path.resolve(process.env.ROUTE_ROOT || path.join(here, '..'));
export const C = path.join(ROOT, '.cache', 'route');
const pk = (sub) => [path.join(ROOT, 'dist', sub), path.join(ROOT, sub)].find((d) => fs.existsSync(path.join(d, 'index.json')));
export const RDIR = pk('r'), HDIR = pk('h');
const DT = { '<f4': Float32Array, '<f8': Float64Array, '<i2': Int16Array, '|u1': Uint8Array, '<u2': Uint16Array, '<u4': Uint32Array, '<i4': Int32Array };
const U16 = -32768;

// ---------------------------------------------------------------- the road packs, as roadview.js reads them
export const PIDX = JSON.parse(fs.readFileSync(path.join(RDIR, 'index.json'), 'utf8')), PK = (PIDX.pack_km || 5) * 1000;
export const unpack = (file) => {
  const hdr = JSON.parse(fs.readFileSync(file, 'utf8'));
  const raw = zlib.inflateRawSync(Buffer.from(hdr.blob, 'base64')); delete hdr.blob;
  const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), A = {};
  for (const m of hdr.arrays) A[m.n] = new DT[m.t](buf, m.o, m.l);
  return { hdr, A };
};
const packs = new Map();
export function pack(p) {
  if (!packs.has(p)) {
    const f = path.join(RDIR, String(p).padStart(3, '0') + '.json');
    let P = null;
    if (fs.existsSync(f)) {
      P = unpack(f); const A = P.A, n = P.hdr.n2, F = (a, i) => (a[i] === U16 ? NaN : a[i] / 100);
      if (A.lane && A.lane.length >= 4 * n) { P.OW = Float32Array.from({ length: n }, (_, k) => F(A.lane, 4 * k)); P.KR = Float32Array.from({ length: n }, (_, k) => F(A.lane, 4 * k + 3)); }
    }
    packs.set(p, P);
  }
  return packs.get(p);
}
// the samples (every 2 m) of the packs over [sa, sb], in a frame with the first pack's origin (as the road view's session)
export function line(sa, sb) {
  let O = null; const S = [];
  for (let p = Math.floor(sa / PK) - 1; p <= Math.floor(sb / PK) + 1; p++) {
    if (!PIDX.packs.includes(p)) continue; const P = pack(p); if (!P) continue; if (!O) O = { x: P.hdr.ox, y: P.hdr.oy };
    const A = P.A, n = P.hdr.n2, dx = P.hdr.ox - O.x, dy = P.hdr.oy - O.y;
    for (let k = 0; k < n; k++) S.push({ s: A.s2[k], x: A.cen[2 * k] + dx, y: A.cen[2 * k + 1] + dy, nx: A.nor[2 * k] / 30000, ny: A.nor[2 * k + 1] / 30000,
      L: A.edge[2 * k] / 100, R: A.edge[2 * k + 1] / 100, sh: A.shift ? A.shift[k] / 100 : 0, dv: A.drv ? A.drv[k] / 100 : null, ow: P.OW ? P.OW[k] : NaN, kr: P.KR ? P.KR[k] : NaN });
  }
  const idx = (s) => { let lo = 0, hi = S.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (S[m].s < s) lo = m + 1; else hi = m; } return lo; };
  const at = (s) => { const i = idx(s), a = S[Math.max(0, i - 1)], b = S[i]; const t = b.s > a.s ? Math.max(0, Math.min(1, (s - a.s) / (b.s - a.s))) : 0, r = { s };
    for (const k of ['x', 'y', 'nx', 'ny', 'L', 'R', 'sh', 'ow', 'kr']) r[k] = a[k] + (b[k] - a[k]) * t;
    r.dv = a.dv != null && b.dv != null ? a.dv + (b.dv - a.dv) * t : null; return r; };
  return { S, O, at, s0: S[0].s, s1: S[S.length - 1].s };
}
// a window of the line from sa (integer metres), as roadview.js windowAt builds it: the convoy's line (the planned tractor line)
// and the carriageway's edges left / right of it; HO the own lane's left boundary from it. kr: the keep-right line instead,
// its edge on the left the own lane's boundary (as route_hotspots.py simulates keeping right), E the real edges from it
export function windowOf(Ln, sa, sb, kr = false) {
  const n = Math.floor(sb - sa);
  const P = new Float64Array(2 * n), N = new Float64Array(2 * n), HL = new Float32Array(n), HR = new Float32Array(n), SH = new Float32Array(n), EL = new Float32Array(n), ER = new Float32Array(n);
  let HO = null;
  const Q = []; for (let i = 0; i < n; i++) Q.push(Ln.at(sa + i));
  if (kr) {    // (keep right and the own lane are undefined where no edge was traced: bridged from the metres around)
    for (const f of ['kr', 'ow']) { const ok = Q.map((q) => Number.isFinite(q[f])); const ks = ok.flatMap((v, i) => (v ? [i] : []));
      if (!ks.length) { for (const q of Q) q[f] = f === 'kr' ? (q.dv ?? 0) : q.L; continue; }
      for (let i = 0; i < n; i++) if (!ok[i]) { let j = ks.findIndex((x) => x > i); const b = j < 0 ? ks[ks.length - 1] : ks[j], a = j <= 0 ? ks[0] : ks[j - 1]; Q[i][f] = a === b ? Q[a][f] : Q[a][f] + (Q[b][f] - Q[a][f]) * (i - a) / (b - a); } }
  }
  for (let i = 0; i < n; i++) {
    const q = Q[i], sh = kr ? q.kr : q.dv != null ? q.dv : q.sh || 0;
    P[2 * i] = q.x + q.nx * sh; P[2 * i + 1] = q.y + q.ny * sh; N[2 * i] = q.nx; N[2 * i + 1] = q.ny; SH[i] = sh;
    HL[i] = Math.max(0.5, (kr ? q.ow : q.L) - sh); HR[i] = Math.max(0.5, q.R + sh); EL[i] = Math.max(0.5, q.L - sh); ER[i] = HR[i];
    if (!kr && Number.isFinite(q.ow)) { if (!HO) HO = new Float32Array(n).fill(1e3); HO[i] = q.ow - sh; }
  }
  return { sa, sb, n, P, N, HL, HR, HO, SH, EL, ER, O: Ln.O };
}

// ---------------------------------------------------------------- the paved surface traced on a passage's photo
export function pvRings(hot) {          // the rings in UTM 33 (absolute), from the passage's frame (local TM at its lon / lat)
  const f = path.join(HDIR, hot.id + '.json'); if (!fs.existsSync(f)) return null;
  const { A } = unpack(f); if (!A.pv_n) return null;
  const rings = []; let o = 0;
  for (const m of A.pv_n) {
    const r = new Float64Array(2 * m);
    for (let k = 0; k < m; k++) { const [la, lo] = tmInverse(A.pv_xy[2 * (o + k)], A.pv_xy[2 * (o + k) + 1], { lon0: hot.lon, lat0: hot.lat }); const [E, Nn] = utm33fwd(la, lo); r[2 * k] = E; r[2 * k + 1] = Nn; }
    rings.push(r); o += m;
  }
  return rings;
}
// the further paved surface along the normals S of window W: the passages' traced surfaces that reach into it
export const RINGS = new Map();
export function pavedFor(W, S, hots) {
  const rings = [];
  for (const h of hots) if (h.km[1] * 1000 + 200 >= W.sa && h.km[0] * 1000 - 200 <= W.sb) { if (!RINGS.has(h.id)) RINGS.set(h.id, pvRings(h)); rings.push(...(RINGS.get(h.id) || [])); }
  return rings.length ? pavedAlong(S, rings.map((r) => r.map((v, i) => v - (i % 2 ? W.O.y : W.O.x)))) : null;
}
// packs not needed any more (the route scan walks the whole route): dropped from the cache
export function dropPacks(below) { for (const p of [...packs.keys()]) if (p < below) packs.delete(p); }
