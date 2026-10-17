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
import { SRC, C, line, windowOf, pavedFor, RINGS } from './rpacks.mjs';

const { sweep, DEFAULTS } = await import(path.join(SRC, 'vehicle.js'));
const { bladeEdge, cells, normals, SUB } = await import(path.join(SRC, 'bladeedge.js'));

const only = process.argv[2] ? process.argv[2].split(',') : null;
const RUNIN = 410, RUNOUT = 300;          // the passage's window: from where "Drive this passage" starts its first window (150 m before
                                          // the passage, 260 m behind the convoy) to 300 m beyond its end
const VEH = { ...DEFAULTS };
const SUMMARY = JSON.parse(fs.readFileSync(path.join(C, 'hot', 'summary_all.json'), 'utf8'));

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
