// The blade beyond the edge at every passage and lane stretch, with the page's own code (src/route/vehicle.js sweep,
// src/route/bladeedge.js): the road packs read as the road view reads them, the passage's window driven by the page's
// vehicle (its defaults) along the convoy's line, the blade measured against the carriageway's measured edges and the
// paved surface traced on the passage's photo (h/<id>.json, pv). route_bake.py takes the result (the area drawn in the
// passage view, the figures of the passage card and the lane list, and what the drive view draws and shows in a passage)
// from .cache/route/corr/blade_edge.json.
//   ROUTE_ROOT=<route> node windpark-hosskirch/tools/route_blade.mjs [ids]   (OUT=<file>: write there instead; DUMP=1: with
//   each passage's window, convoy and traced outlines, to check it against an exact polygon computation)
// Reads <route>/dist/r, dist/h (else <route>/r, h), .cache/route/hot/summary_all.json and corr/lanes.json.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '..', 'src', 'route');
const { sweep, DEFAULTS } = await import(path.join(SRC, 'vehicle.js'));
const { bladeEdge, cells, pavedAlong, normals, SUB } = await import(path.join(SRC, 'bladeedge.js'));
const { tmInverse, utm33fwd } = await import(path.join(SRC, 'geo.js'));

const ROOT = path.resolve(process.env.ROUTE_ROOT || path.join(here, '..'));
const C = path.join(ROOT, '.cache', 'route');
const pk = (sub) => [path.join(ROOT, 'dist', sub), path.join(ROOT, sub)].find((d) => fs.existsSync(path.join(d, 'index.json')));
const RDIR = pk('r'), HDIR = pk('h');
const only = process.argv[2] ? process.argv[2].split(',') : null;
const DT = { '<f4': Float32Array, '<f8': Float64Array, '<i2': Int16Array, '|u1': Uint8Array, '<u2': Uint16Array, '<u4': Uint32Array, '<i4': Int32Array };
const U16 = -32768;
const RUNIN = 410, RUNOUT = 300;          // the passage's window: from where "Drive this passage" starts its first window (150 m before
                                          // the passage, 260 m behind the convoy) to 300 m beyond its end
const VEH = { ...DEFAULTS };

// ---------------------------------------------------------------- the road packs, as roadview.js reads them
const PIDX = JSON.parse(fs.readFileSync(path.join(RDIR, 'index.json'), 'utf8')), PK = (PIDX.pack_km || 5) * 1000;
const unpack = (file) => {
  const hdr = JSON.parse(fs.readFileSync(file, 'utf8'));
  const raw = zlib.inflateRawSync(Buffer.from(hdr.blob, 'base64')); delete hdr.blob;
  const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), A = {};
  for (const m of hdr.arrays) A[m.n] = new DT[m.t](buf, m.o, m.l);
  return { hdr, A };
};
const packs = new Map();
function pack(p) {
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
function line(sa, sb) {
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
function windowOf(Ln, sa, sb, kr = false) {
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
const SUMMARY = JSON.parse(fs.readFileSync(path.join(C, 'hot', 'summary_all.json'), 'utf8'));
function pvRings(hot) {          // the rings in UTM 33 (absolute), from the passage's frame (local TM at its lon / lat)
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
const RINGS = new Map();
function pavedFor(W, S, hots) {
  const rings = [];
  for (const h of hots) if (h.km[1] * 1000 + 200 >= W.sa && h.km[0] * 1000 - 200 <= W.sb) { if (!RINGS.has(h.id)) RINGS.set(h.id, pvRings(h)); rings.push(...(RINGS.get(h.id) || [])); }
  return rings.length ? pavedAlong(S, rings.map((r) => r.map((v, i) => v - (i % 2 ? W.O.y : W.O.x)))) : null;
}

// ---------------------------------------------------------------- one stretch [a, b] (front axle): the drive and keeping right
const r2 = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
function measure(a, b, hots, keepRight) {
  const Ln = line(a - RUNIN - 600, b + RUNOUT + 600);
  const sa = Math.max(Math.ceil(Ln.s0), Math.floor(a) - RUNIN), sb = Math.min(Math.floor(Ln.s1), Math.ceil(b) + RUNOUT);
  const W = windowOf(Ln, sa, sb), ia = Math.max(0, Math.ceil(a) - sa), ib = Math.min(W.n - 1, Math.floor(b) - sa);
  const S = normals(W), paved = pavedFor(W, S, hots);
  const res = sweep(VEH, W.P, W.N, W.HL, W.HR, 0, W.HO);
  const E = bladeEdge(VEH, W, res, { i0: ia, i1: ib, S, paved });
  const out = { W, S, res, E, paved, ia, ib };
  if (keepRight) {
    const K = windowOf(Ln, sa, sb, true);
    const rk = sweep({ ...VEH, wheelClear: 0.3 }, K.P, K.N, K.HL, K.HR, 0, null);
    const Wm = { ...K, HL: K.EL, HR: K.ER }, Sm = normals(Wm);                  // measured against the road's own edges
    out.kr = bladeEdge(VEH, Wm, rk, { i0: ia, i1: ib, S: Sm, paved: pavedFor(Wm, Sm, hots) });
  }
  return out;
}

const hots = SUMMARY.filter((h) => !only || only.includes(h.id));
const OUT = { model: 'bladeedge', vehicle: VEH, sub: SUB, hot: {}, lanes: [] };
for (const h of hots) {
  const t0 = Date.now(), a = h.km[0] * 1000, b = h.km[1] * 1000;
  const M = measure(a, b, SUMMARY, true), { W, S, E } = M;
  const Cq = cells(S, E.runs);
  OUT.hot[h.id] = {
    km: h.km, sa: W.sa, n: W.n, ia: M.ia, ib: M.ib, max: r2(E.max), area: r2(E.area, 1),
    atS: E.atMax >= 0 ? r2(W.sa + S.u16[E.atMax] / SUB, 3) : null, atPos: E.atPos >= 0 ? W.sa + E.atPos : null,
    kr: { max: r2(M.kr.max), area: r2(M.kr.area, 1) },
    // the stretches beyond: [normal's place (1/16 m from the window's start), from, to (cm, along the normal, left +)]
    runs: Array.from(E.runs.k, (k, r) => [S.u16[k], Math.round(E.runs.d0[r] * 100), Math.round(E.runs.d1[r] * 100)]),
    // how far the blade reaches beyond the paved surface, per front-axle metre ia … ib (cm)
    depth: Array.from(E.depth.subarray(M.ia, M.ib + 1), (v) => Math.round(v * 100)),
    // the cells as drawn, UTM 33 (absolute): the passage view's area is their union
    cells: Array.from({ length: Cq.k.length }, (_, r) => Array.from(Cq.quads.subarray(8 * r, 8 * r + 8), (v, i) => r2(v + (i % 2 ? W.O.y : W.O.x), 3))),
    // the further paved surface on each normal (place, then from / to pairs, cm) where the blade of a front axle on the
    // passage can reach (from 100 m before its start to its end, within 45 m of the line), for the page's own sweep of
    // another vehicle
    paved: M.paved ? Array.from({ length: S.m }, (_, k) => {
      if (S.u16[k] < (M.ia - 100) * SUB || S.u16[k] > (M.ib + 10) * SUB) return [];
      const q = [S.u16[k]]; for (let j = M.paved.at[k]; j < M.paved.at[k + 1]; j++) { const a = Math.max(-45, M.paved.d[2 * j]), b = Math.min(45, M.paved.d[2 * j + 1]); if (b > a) q.push(Math.round(a * 100), Math.round(b * 100)); }
      return q; }).filter((q) => q.length > 1) : [],
  };
  if (process.env.DUMP) Object.assign(OUT.hot[h.id], { dump: { O: W.O, P: Array.from(W.P), N: Array.from(W.N), HL: Array.from(W.HL), HR: Array.from(W.HR), pose: Array.from(M.res.pose), valid: Array.from(M.res.valid),
    pv: (RINGS.get(h.id) || []).map((r) => Array.from(r)) } });
  console.log(`${h.id.padEnd(32)} blade beyond the edge up to ${E.max.toFixed(2)} m, ${E.area.toFixed(0)} m² (keeping right ${M.kr.max.toFixed(2)} m)  runs ${E.runs.k.length}  normals ${S.m} on ${W.n} m  ${Date.now() - t0} ms`);
}
// the lane stretches (route_lanes.py): the blade using the lane and keeping right, by the same measure
const LF = path.join(C, 'corr', 'lanes.json');
if (!only && fs.existsSync(LF)) for (const st of JSON.parse(fs.readFileSync(LF, 'utf8'))) {
  const M = measure(st.s0, st.s1, SUMMARY, true);
  OUT.lanes.push({ s0: st.s0, s1: st.s1, blade: r2(M.E.max, 1), krBlade: r2(M.kr.max, 1) });
}
const dst = process.env.OUT || path.join(C, 'corr', 'blade_edge.json');
fs.writeFileSync(dst, JSON.stringify(OUT)); console.log('→', dst);
