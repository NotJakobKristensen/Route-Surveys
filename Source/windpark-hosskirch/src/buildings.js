// Buildings from OSM footprints. Heights: OSM / Microsoft ML where known, else by class. Roofs are fitted to each
// footprint's minimum rotated rectangle: the roof is the lower envelope of planes (gable = 2, hip = 4, pyramid = 4),
// the footprint is clipped per plane region, so every roof face stays planar for any footprint shape.
import * as THREE from 'three';
import { patch } from './env.js';
import { hash2, ringArea } from './data.js';

function hull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
// minimum-area rectangle: centre, unit axis u (long), half extents
function mrr(pts) {
  const h = hull(pts);
  let best = null;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    let ux = b[0] - a[0], uy = b[1] - a[1]; const l = Math.hypot(ux, uy); if (l < 1e-6) continue; ux /= l; uy /= l;
    let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity;
    for (const q of h) { const s = q[0] * ux + q[1] * uy, t = -q[0] * uy + q[1] * ux; s0 = Math.min(s0, s); s1 = Math.max(s1, s); t0 = Math.min(t0, t); t1 = Math.max(t1, t); }
    const area = (s1 - s0) * (t1 - t0);
    if (!best || area < best.area) best = { area, ux, uy, s0, s1, t0, t1 };
  }
  if (!best) return null;
  let { ux, uy, s0, s1, t0, t1 } = best;
  if (t1 - t0 > s1 - s0) { [ux, uy] = [-uy, ux]; [s0, s1, t0, t1] = [t0, t1, -s1, -s0]; }
  const sc = (s0 + s1) / 2, tc = (t0 + t1) / 2;
  return { cx: sc * ux - tc * uy, cy: sc * uy + tc * ux, ux, uy, L: (s1 - s0) / 2, W: (t1 - t0) / 2, area: best.area };
}
// clip polygon (array of [x,y]) by half-plane a*x + b*y + c >= 0
function clip(poly, a, b, c) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const dp = a * p[0] + b * p[1] + c, dq = a * q[0] + b * q[1] + c;
    if (dp >= 0) out.push(p);
    if ((dp >= 0) !== (dq >= 0)) { const t = dp / (dp - dq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
  }
  return out;
}

const ROOF_COLS = [[0.36, 0.13, 0.08], [0.42, 0.17, 0.10], [0.30, 0.12, 0.09], [0.24, 0.10, 0.08], [0.12, 0.12, 0.13], [0.20, 0.19, 0.19], [0.47, 0.22, 0.12]];
const WALL_COLS = [[0.60, 0.56, 0.48], [0.63, 0.59, 0.50], [0.56, 0.54, 0.50], [0.61, 0.54, 0.42], [0.53, 0.53, 0.50], [0.60, 0.53, 0.46], [0.55, 0.56, 0.49]];

export function makeBuildings(data, ground) {
  const pos = [], nor = [], col = [], win = [];
  const v3 = (x, h, y) => [x, h, -y];
  function tri(a, b, c, colr, w, up) {
    // a,b,c: [x,h,-y]; up: force the face normal upwards (roofs)
    let ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) return;
    nx /= l; ny /= l; nz /= l;
    if (up && ny < 0) { const t = b; b = c; c = t; nx = -nx; ny = -ny; nz = -nz; }
    pos.push(...a, ...b, ...c); nor.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    col.push(...colr, ...colr, ...colr); win.push(w, w, w);
  }
  let count = 0;
  for (const b of data.buildings) {
    const ring = b.rings[0];
    let H = b.a[0] / 10, eave = b.a[1] / 10; const cls = b.a[2], roof = b.a[3];
    const pts = [];
    for (let i = 0; i < ring.length; i += 2) pts.push([ring[i], ring[i + 1]]);
    if (pts.length < 3) continue;
    if (ringArea(ring) < 0) pts.reverse();              // CCW
    const r = mrr(pts); if (!r) continue;
    // ground: lowest terrain under the footprint (building sits level, walls reach down)
    let gmin = Infinity, gmax = -Infinity;
    for (const p of pts) { const g = ground.height(p[0], p[1]); gmin = Math.min(gmin, g); gmax = Math.max(gmax, g); }
    const base = gmin - 0.3, top0 = gmax;           // eave measured from the highest corner
    const hsh = hash2(r.cx * 0.13, r.cy * 0.17);
    const roofCol = cls === 5 ? [0.55, 0.58, 0.58] : cls === 12 ? [0.30, 0.34, 0.26] : cls === 9 ? [0.30, 0.31, 0.32] : ROOF_COLS[Math.floor(hsh * ROOF_COLS.length)];
    const wallCol = cls === 4 ? [0.46, 0.40, 0.33] : cls === 12 ? [0.40, 0.44, 0.34] : WALL_COLS[Math.floor(hash2(r.cy, r.cx) * WALL_COLS.length)];
    const hasWin = cls === 1 || cls === 2 || cls === 3 || cls === 7 || cls === 8 ? 1 : 0;
    const E = top0 + eave, rh = Math.max(0, H - eave);
    // roof planes: z = E + k * (distance-based); build region list (convex polygons in plane-local form)
    const { cx, cy, ux, uy, L, W } = r;
    const toS = (p) => (p[0] - cx) * ux + (p[1] - cy) * uy, toT = (p) => -(p[0] - cx) * uy + (p[1] - cy) * ux;
    let regions;   // [{clips: [[a,b,c],...], z: (p) => h}]
    const kW = W > 0.1 ? rh / W : 0, kL = L > 0.1 ? rh / L : 0;
    const gable = (roof === 2 || roof === 4) && rh > 0.2, hip = roof === 3 && rh > 0.2, pyr = roof === 5 && rh > 0.2;
    if (roof === 4 && rh > 0.2) {
      regions = [{ clips: [], z: (p) => E + rh * (1 - (toT(p) + W) / (2 * W)) }];  // skillion
    } else if (gable) {
      regions = [
        { clips: [[-uy, ux, uy * cx - ux * cy]], z: (p) => E + rh - kW * Math.abs(toT(p)) },      // t >= 0
        { clips: [[uy, -ux, -uy * cx + ux * cy]], z: (p) => E + rh - kW * Math.abs(toT(p)) },     // t <= 0
      ];
    } else if (hip || pyr) {
      // hip: distance to long sides with slope kW, to short sides with the same slope (ridge shortened)
      const k = kW, Lr = pyr ? 0 : Math.max(0, L - W);
      const zf = (p) => { const s = Math.abs(toS(p)), t = Math.abs(toT(p)); return E + Math.max(0, Math.min(rh - k * t, rh - k * Math.max(0, s - Lr))); };
      // four regions split by the lines t = ±(s - Lr) and s = ±Lr handled by clipping with the two diagonal families
      // region A (t >= 0, long side +): |s| - Lr <= t
      const mk = (sgnT) => [
        [sgnT * -uy, sgnT * ux, sgnT * (uy * cx - ux * cy)],                                      // sgnT*t >= 0
        ...[1, -1].map((sg) => { // sgnT*t - (sg*s - Lr) >= 0  ->  linear in p
          const a = sgnT * -uy - sg * ux, b2 = sgnT * ux - sg * uy;
          const c = -(a * cx + b2 * cy) + Lr;
          return [a, b2, c];
        }),
      ];
      const mkS = (sgnS) => [
        ...[1, -1].map((sg) => { // (sgnS*s - Lr) - sg*t >= 0
          const a = sgnS * ux + sg * uy, b2 = sgnS * uy - sg * ux;
          const c = -(a * cx + b2 * cy) - Lr;
          return [a, b2, c];
        }),
      ];
      regions = [{ clips: mk(1), z: zf }, { clips: mk(-1), z: zf }, { clips: mkS(1), z: zf }, { clips: mkS(-1), z: zf }];
    } else {
      regions = [{ clips: [], z: () => E }];
    }
    const zRoof = (p) => { let z = Infinity; for (const rg of regions) z = Math.min(z, rg.z(p)); return Math.max(E, z); };
    const zOver = (p) => { let z = Infinity; for (const rg of regions) z = Math.min(z, rg.z(p)); return z; };   // no clamp: eaves slope on
    // pitched roofs overhang the walls by 0.5 m (mitred outward offset of the footprint)
    const pitched = gable || hip || pyr || (roof === 4 && rh > 0.2);
    let roofPts = pts;
    if (pitched) {
      roofPts = pts.map((p, i) => {
        const a = pts[(i + pts.length - 1) % pts.length], c = pts[(i + 1) % pts.length];
        let n1x = p[1] - a[1], n1y = a[0] - p[0], n2x = c[1] - p[1], n2y = p[0] - c[0];
        const l1 = Math.hypot(n1x, n1y) || 1, l2 = Math.hypot(n2x, n2y) || 1; n1x /= l1; n1y /= l1; n2x /= l2; n2y /= l2;
        let mx = n1x + n2x, my = n1y + n2y; const ml = Math.hypot(mx, my) || 1; mx /= ml; my /= ml;
        const k = Math.min(1.0, 0.5 / Math.max(0.3, mx * n1x + my * n1y));
        return [p[0] + mx * k, p[1] + my * k];
      });
    }
    const solar = (cls === 1 || cls === 3 || cls === 4) && gable && hash2(r.cx * 0.37, r.cy * 0.91) < 0.3;
    // roof faces
    regions.forEach((rg, ri) => {
      let poly = roofPts;
      for (const c of rg.clips) { poly = clip(poly, c[0], c[1], c[2]); if (poly.length < 3) break; }
      if (poly.length < 3) return;
      const contour = poly.map((p) => new THREE.Vector2(p[0], p[1]));
      let tris;
      try { tris = THREE.ShapeUtils.triangulateShape(contour, []); } catch (e) { return; }
      const zf = pitched ? zOver : zRoof;
      for (const t of tris) {
        const a = poly[t[0]], bb = poly[t[1]], c = poly[t[2]];
        tri(v3(a[0], zf(a), a[1]), v3(bb[0], zf(bb), bb[1]), v3(c[0], zf(c), c[1]), roofCol, 0, true);
      }
      // photovoltaics on south-facing gable faces (down-slope direction of face ri points south)
      if (solar) {
        const dy = ri === 0 ? ux : -ux;                 // north component of the face's down-slope direction (−uy, ux) / (uy, −ux)
        if (dy < -0.5) {
          let cxp = 0, cyp = 0; for (const q of poly) { cxp += q[0]; cyp += q[1]; } cxp /= poly.length; cyp /= poly.length;
          const panel = poly.map((q) => [cxp + (q[0] - cxp) * 0.62, cyp + (q[1] - cyp) * 0.62]);
          const pc = panel.map((q) => new THREE.Vector2(q[0], q[1]));
          let pt; try { pt = THREE.ShapeUtils.triangulateShape(pc, []); } catch (e) { pt = []; }
          for (const t of pt) {
            const a = panel[t[0]], bb = panel[t[1]], c = panel[t[2]];
            tri(v3(a[0], zf(a) + 0.14, a[1]), v3(bb[0], zf(bb) + 0.14, bb[1]), v3(c[0], zf(c) + 0.14, c[1]), [0.018, 0.026, 0.05], 2, true);
          }
        }
      }
    });
    // walls: split each edge exactly where it crosses a ridge / hip line, so the wall top follows the roof
    const kinks = [];
    if (gable) kinks.push([-uy, ux, uy * cx - ux * cy]);                                // t = 0
    if (hip || pyr) {
      const Lr = pyr ? 0 : Math.max(0, L - W);
      kinks.push([-uy, ux, uy * cx - ux * cy]);
      for (const st of [1, -1]) for (const ss of [1, -1]) {                             // st*t = ss*s - Lr
        const a2 = st * -uy - ss * ux, b2 = st * ux - ss * uy; kinks.push([a2, b2, -(a2 * cx + b2 * cy) + Lr]);
      }
      for (const ss of [1, -1]) kinks.push([ux * ss, uy * ss, -(ux * ss * cx + uy * ss * cy) - Lr]);   // s = ±Lr
    }
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], c = pts[(i + 1) % pts.length];
      const len = Math.hypot(c[0] - a[0], c[1] - a[1]); if (len < 0.05) continue;
      const ts = [0, 1];
      for (const k of kinks) {
        const fa = k[0] * a[0] + k[1] * a[1] + k[2], fc = k[0] * c[0] + k[1] * c[1] + k[2];
        if ((fa > 0) !== (fc > 0) && Math.abs(fa - fc) > 1e-9) { const t = fa / (fa - fc); if (t > 1e-4 && t < 1 - 1e-4) ts.push(t); }
      }
      ts.sort((p, q) => p - q);
      for (let s = 0; s + 1 < ts.length; s++) {
        const t0 = ts[s], t1 = ts[s + 1];
        const p0 = [a[0] + (c[0] - a[0]) * t0, a[1] + (c[1] - a[1]) * t0], p1 = [a[0] + (c[0] - a[0]) * t1, a[1] + (c[1] - a[1]) * t1];
        const z0 = zRoof(p0), z1 = zRoof(p1);
        const A0 = v3(p0[0], base, p0[1]), B0 = v3(p1[0], base, p1[1]), B1 = v3(p1[0], z1, p1[1]), A1 = v3(p0[0], z0, p0[1]);
        tri(A0, B0, B1, wallCol, hasWin); tri(A0, B1, A1, wallCol, hasWin);
      }
    }
    count++;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aWin', new THREE.Float32BufferAttribute(win, 1));
  g.computeBoundingSphere();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0, side: THREE.DoubleSide });
  patch(mat, {
    key: 'bld',
    vert: { pars: 'attribute float aWin;\nvarying float vWin;\nvarying vec3 vN;', main: 'vWin = aWin; vN = normal;' },
    frag: {
      pars: 'varying float vWin;\nvarying vec3 vN;',
      map: /* glsl */ `
        // windows: rows of dark panes on walls; lit at night
        float wmask = 0.0; float lit = 0.0; float glow = 0.0;
        if (vWin > 0.5 && vWin < 1.5 && abs(vN.y) < 0.3) {
          vec2 q = vec2(dot(vWP.xz, normalize(vec2(-vN.z, vN.x))), vWP.y);
          vec2 cell = vec2(2.6, 2.8), id = floor(q / cell), f = fract(q / cell);
          vec2 fw = fwidth(q / cell) * 1.2 + 1e-4;
          float wx = smoothstep(0.36 - fw.x, 0.36 + fw.x, f.x) * (1.0 - smoothstep(0.68 - fw.x, 0.68 + fw.x, f.x));
          float wy = smoothstep(0.36 - fw.y, 0.36 + fw.y, f.y) * (1.0 - smoothstep(0.76 - fw.y, 0.76 + fw.y, f.y));
          float farW = 1.0 - smoothstep(0.25, 0.6, max(fw.x, fw.y));   // windows fade out before they alias
          float hasw = step(0.25, hash12(id + floor(vWP.xz * 0.05)));
          wmask = wx * wy * hasw * farW;
          lit = step(0.72, hash12(id * 1.7 + 11.0));
          // from afar the lit windows merge into a warm glow instead of vanishing with the pane pattern
          glow = mix(0.09, wx * wy * hasw * lit, farW);
        }
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.09, 0.1, 0.11), wmask * 0.7);
        if (vWin > 1.5) { vec2 g = fract(vWP.xz * vec2(0.6, 1.0)); diffuseColor.rgb *= 0.85 + 0.15 * step(0.06, g.x) * step(0.06, g.y); }
        vWinLit = glow;`,
      afterLights: `totalEmissiveRadiance += vec3(1.0, 0.62, 0.3) * vWinLit * uNight * 0.9;
        { float l = dot(reflectedLight.indirectDiffuse, vec3(0.3333));          // shade from the whole sky, not lavender
          reflectedLight.indirectDiffuse = mix(vec3(l) * vec3(1.03, 1.0, 0.95), reflectedLight.indirectDiffuse, 0.45); }`,
    },
  });
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, rr) => { prev(sh, rr); sh.fragmentShader = sh.fragmentShader.replace('varying float vWin;', 'varying float vWin;\nfloat vWinLit = 0.0;'); };
  const mesh = new THREE.Mesh(g, mat);
  mesh.castShadow = true; mesh.receiveShadow = true; mesh.name = 'buildings';
  return { mesh, count };
}
