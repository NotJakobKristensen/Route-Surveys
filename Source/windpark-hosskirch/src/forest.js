// Forest: a canopy shell over the OSM forest polygons (tracks, pads, power-line corridors, water and buildings carved
// out, height lowered where Sentinel-2 shows open ground or young growth), 3D trees along every forest edge, dense 3D
// trees around the camera (the shell sinks away there), and single trees / rows / hedges / orchards / gardens.
import * as THREE from 'three';
import { patch, U } from './env.js';
import { hash2, mulberry, ringBBox, pointInRing } from './data.js';

const CELL = 8192 / 6;          // canopy shell pieces (frustum / shadow-frustum culling units)

export function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const matureHeight = (x, y) => 27 * (0.84 + 0.3 * vnoise(x / 95, y / 95)) * (0.94 + 0.12 * vnoise(x / 23 + 50, y / 23));
const sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ------------------------------------------------------------------------------------------------ masks
function drawRings(g, rings, ext, px) {
  g.beginPath();
  for (const c of rings) {
    for (let i = 0; i < c.length; i += 2) {
      const X = (c[i] + ext) * px, Y = (ext - c[i + 1]) * px;
      i === 0 ? g.moveTo(X, Y) : g.lineTo(X, Y);
    }
    g.closePath();
  }
}
function drawLine(g, c, ext, px) {
  g.beginPath();
  for (let i = 0; i < c.length; i += 2) {
    const X = (c[i] + ext) * px, Y = (ext - c[i + 1]) * px;
    i === 0 ? g.moveTo(X, Y) : g.lineTo(X, Y);
  }
  g.stroke();
}
// everything that keeps trees away: roads, rail, pads, foundations, power corridors, water, buildings.
// tracksOnly: just the forest tracks and paths (class ≥ 8), which are too narrow to cut into the 12 m canopy shell
function drawClearings(g, data, ext, px, style, tracksOnly = false) {
  g.lineCap = 'round'; g.lineJoin = 'round';
  g.fillStyle = g.strokeStyle = style;
  for (const r of data.roads) {
    const w = r.a[2] / 10, cls = r.a[0];
    if ((cls >= 8) !== tracksOnly) continue;
    g.lineWidth = (w + (cls >= 8 ? 3 : 4)) * px;
    drawLine(g, r.rings[0], ext, px);
  }
  if (tracksOnly) return;
  g.lineWidth = 9 * px; for (const r of data.rail) drawLine(g, r.rings[0], ext, px);
  for (const p of data.power) { g.lineWidth = (p.a[0] === 1 ? 30 : 9) * px; drawLine(g, p.rings[0], ext, px); }
  for (const p of data.pads) { drawRings(g, p.rings, ext, px); g.fill('evenodd'); g.lineWidth = 10 * px; g.stroke(); }
  for (const t of data.header.turbines) { g.beginPath(); g.arc((t.x + ext) * px, (ext - t.y) * px, 17 * px, 0, Math.PI * 2); g.fill(); }
  for (const w of data.water) { drawRings(g, w.rings, ext, px); g.fill('evenodd'); g.lineWidth = 5 * px; g.stroke(); }
  for (const b of data.buildings) { drawRings(g, b.rings, ext, px); g.fill(); g.lineWidth = 5 * px; g.stroke(); }
}

export function makeForestModel(data, size) {
  const ext = data.header.core, px = size / (2 * ext);
  // one canvas: forest polygons in red, clearings in green, forest tracks / paths in blue
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#000'; g.fillRect(0, 0, size, size);
  g.fillStyle = '#f00';
  for (const f of data.forest) { drawRings(g, f.rings, ext, px); g.fill('evenodd'); }
  g.globalCompositeOperation = 'lighter';
  drawClearings(g, data, ext, px, '#0f0');
  drawClearings(g, data, ext, px, '#00f', true);
  g.globalCompositeOperation = 'source-over';
  const d = g.getImageData(0, 0, size, size).data, N = size * size;
  // tree mask: forest minus every clearing; shell mask: forest minus the clearings wide enough for the shell
  const rawT = new Uint8Array(N), rawS = new Uint8Array(N), ob = new Uint8Array(N), lane = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const R = d[i * 4], G = d[i * 4 + 1], B = d[i * 4 + 2];
    rawS[i] = (R * (255 - G) + 127) / 255; rawT[i] = (rawS[i] * (255 - B) + 127) / 255;
    ob[i] = G > B ? G : B; lane[i] = B;
  }
  // soften the edges: separable [1 2 1] blur (≈ canvas blur 1 px); the border rows / columns stay as they are
  const blur = (raw) => {
    const tmp = raw.slice(), m = new Uint8Array(N);
    for (let y = 0; y < size; y++) { const o = y * size; for (let i = o + 1, e = o + size - 1; i < e; i++) tmp[i] = (raw[i - 1] + 2 * raw[i] + raw[i + 1] + 2) >> 2; }
    m.set(tmp.subarray(0, size)); m.set(tmp.subarray(N - size), N - size);
    for (let i = size, e = N - size; i < e; i++) m[i] = (tmp[i - size] + 2 * tmp[i] + tmp[i + size] + 2) >> 2;
    return m;
  };
  const m = blur(rawT), ms = blur(rawS), ln = blur(lane);
  const sample = (arr) => (x, y) => {
    const fx = (x + ext) * px - 0.5, fy = (ext - y) * px - 0.5;
    const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
    if (ix < 0 || iy < 0 || ix >= size - 1 || iy >= size - 1) return 0;
    const i = iy * size + ix;
    const a = arr[i], b = arr[i + 1], c = arr[i + size], e = arr[i + size + 1];
    return ((a + (b - a) * tx) * (1 - ty) + (c + (e - c) * tx) * ty) / 255;
  };
  // Sentinel-2 openness (0 mature canopy … 1 open / young growth), 3×3 box-blurred once
  const O = data.openness, on = O.n, olv = O.levels, og = new Float32Array(on * on), openData = new Uint8Array(on * on);
  for (let y = 0; y < on; y++) for (let x = 0; x < on; x++) {
    let sum = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= on || yy >= on) continue; sum += O.g[yy * on + xx]; n++;
    }
    og[y * on + x] = sum / n; openData[y * on + x] = Math.round((255 * sum) / n / olv);
  }
  const openness = (x, y) => {
    const fx = (x + O.ext) / O.res - 0.5, fy = (O.ext - y) / O.res - 0.5;
    const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
    if (ix < 0 || iy < 0 || ix >= on - 1 || iy >= on - 1) return 0;
    const i = iy * on + ix;
    return (((og[i] + (og[i + 1] - og[i]) * tx) * (1 - ty) + (og[i + on] + (og[i + on + 1] - og[i + on]) * tx) * ty) / olv);
  };
  // canopy height follows a much smoother openness (the raster is quantised to 8 levels at 16 m: used directly, the
  // heights step in terraces that light up like contour lines); two passes of a 5×5 box ≈ 50 m
  const osm = new Float32Array(og), tmpo = new Float32Array(on * on);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < on; y++) for (let x = 0; x < on; x++) { let s2 = 0, n2 = 0; for (let d = -2; d <= 2; d++) { const xx = x + d; if (xx >= 0 && xx < on) { s2 += osm[y * on + xx]; n2++; } } tmpo[y * on + x] = s2 / n2; }
    for (let y = 0; y < on; y++) for (let x = 0; x < on; x++) { let s2 = 0, n2 = 0; for (let d = -2; d <= 2; d++) { const yy = y + d; if (yy >= 0 && yy < on) { s2 += tmpo[yy * on + x]; n2++; } } osm[y * on + x] = s2 / n2; }
  }
  const opennessSmooth = (x, y) => {
    const fx = (x + O.ext) / O.res - 0.5, fy = (O.ext - y) / O.res - 0.5;
    const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
    if (ix < 0 || iy < 0 || ix >= on - 1 || iy >= on - 1) return 0;
    const i = iy * on + ix;
    return (((osm[i] + (osm[i + 1] - osm[i]) * tx) * (1 - ty) + (osm[i + on] + (osm[i + on + 1] - osm[i + on]) * tx) * ty) / olv);
  };
  const mask = sample(m), shellBase = sample(ms);
  // the shell leaves out the openings Sentinel-2 sees (clear-cuts, windthrow, fresh plantings): the ground shows there
  const shellMask = (x, y) => { const v = shellBase(x, y); return v > 0 ? v * (1 - sstep(0.84, 0.94, openness(x, y))) : 0; };
  // canopy height above ground: mature stands ≈ 23–31 m, young growth ≈ 7–9 m
  const canopyHeight = (x, y) => matureHeight(x, y) * (1 - 0.7 * sstep(0.5, 0.92, opennessSmooth(x, y)));
  // GPU copies: R = shell mask (ground shader, before openness), G = forest lanes (canopy shader); openness raster
  const tex = new Uint8Array(N * 2);
  for (let i = 0; i < N; i++) { tex[i * 2] = ms[i]; tex[i * 2 + 1] = ln[i]; }
  return { mask, shellMask, obstacle: sample(ob), openness, canopyHeight, size, ext, texData: tex, open: { data: openData, n: on, ext: O.ext } };
}

// ------------------------------------------------------------------------------------------------ canopy shell
const CANOPY_PARS = /* glsl */ `
varying float vEdge;
varying float vSink;
uniform sampler2D uCanopy;
uniform sampler2D uOpen;
uniform float uOpenExt;
uniform sampler2D uSatCore;
uniform sampler2D uSatWide;
uniform float uGainInv;
uniform float uCore;
uniform float uWide;
varying float vHt;
float gWall = 0.0;
vec3 vCrownN; float vCrownDet;
vec3 satAlb(vec2 xy) {
  float m = max(abs(xy.x), abs(xy.y));
  vec3 c = m < uCore - 4.0 ? texture2D(uSatCore, vec2(xy.x + uCore, uCore - xy.y) / (2.0 * uCore)).rgb
                           : texture2D(uSatWide, vec2(xy.x + uWide, uWide - xy.y) / (2.0 * uWide)).rgb;
  c *= uGainInv;
  c = mix(c, c.ggg * vec3(0.62, 1.0, 0.6), 0.2);           // Sentinel-2 forest pixels come out olive; crowns are greener
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c *= clamp((0.045 + 1.5 * (l - 0.045)) / max(l, 1e-4), 0.55, 1.8);   // stretch stand contrast around the forest mean
  c = max(mix(vec3(l), c, 1.2), 0.0) * 0.95;
  c.b = min(c.b, c.g * 0.8);                                // no teal cast
  return c;
}
// crowns: jittered cellular pattern
vec3 crown(vec2 p, out float edge) {
  vec2 g = floor(p), f = fract(p);
  float best = 9.0; vec2 bo = vec2(0.0); float bid = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 o = vec2(float(i), float(j));
    vec2 h = vec2(hash12(g + o), hash12(g + o + 19.7));
    vec2 r = o + 0.05 + 0.9 * h - f;
    float d = dot(r, r) * (0.8 + 0.4 * hash12(g + o + 7.1));
    if (d < best) { best = d; bo = r; bid = hash12(g + o + 3.3); }
  }
  edge = sqrt(best);
  return vec3(-bo, bid);
}
`;
// inside the near-forest disc the shell is lowered (fully at eye level, to 40 % of its height from the air, where it
// fills the gaps between the individual trees like their lower crowns)
const SINK_VERT = /* glsl */ `
  { float nd = distance(transformed.xz, uNearC); transformed.y -= aH * uSinkK * (1.0 - smoothstep(uNearR0, uNearR1, nd)) * uNearOn; }`;
export const NEAR = { uNearC: { value: new THREE.Vector2(0, 0) }, uNearR0: { value: 420 }, uNearR1: { value: 560 }, uNearOn: { value: 0 }, uSinkK: { value: 1 } };
// forest textures shared with the ground shader: canopy / lanes (RG) and openness (R)
export const FOREST_TEX = { canopy: { value: null }, open: { value: null }, openExt: { value: 4160 } };

export function canopyMaterial(core, wide) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0, color: 0xffffff });
  patch(mat, {
    key: 'canopy',
    uniforms: { uCore: { value: core }, uWide: { value: wide }, uCanopy: FOREST_TEX.canopy, uOpen: FOREST_TEX.open, uOpenExt: FOREST_TEX.openExt, ...NEAR },
    vert: {
      pars: 'attribute float aH;\nattribute float aEdge;\nvarying float vEdge;\nvarying float vHt;\nvarying float vSink;\nuniform vec2 uNearC;\nuniform float uNearR0, uNearR1, uNearOn, uSinkK;',
      begin: SINK_VERT,
      // height up the forest edge (core shell: 0 at the wall foot; outer ring has no foot data → treated as high)
      main: 'vEdge = aEdge; vHt = aH == 0.0 ? 30.0 : max(aH, 0.0); vSink = (1.0 - smoothstep(uNearR0, uNearR1, distance(position.xz, uNearC))) * uNearOn * step(0.5, aH);',
    },
    frag: {
      pars: CANOPY_PARS,
      map: /* glsl */ `
        vec2 xy = vec2(vWP.x, -vWP.z);
        float camD = distance(vWP, cameraPosition);
        vec2 pfx = dFdx(xy), pfy = dFdy(xy);
        float mpp = max(length(pfx), length(pfy));            // long axis: cellular crowns alias into contour bands otherwise
        float det = 1.0 - smoothstep(0.7, 2.0, mpp);          // 4.6 m crowns while they cover ≥ 2–3 px
        float det9 = 1.0 - smoothstep(2.5, 5.0, mpp);         // 9 m crown groups further out
        vec3 alb = satAlb(xy);
        vec3 cr = vec3(0.0), cr2 = vec3(0.0);
        if (max(det, det9) > 0.0) {                             // crown detail only where it can be resolved
          vec2 p1 = xy / 4.6, p2 = xy / 9.0 + 31.0;   // (a size factor varying in space would multiply the absolute coordinates)
          p1 += 0.6 * (vec2(vnoise(p1 * 0.23), vnoise(p1 * 0.23 + 17.0)) - 0.5);  // no fish-scale regularity
          p2 += 1.1 * (vec2(vnoise(p2 * 0.23 + 5.0), vnoise(p2 * 0.23 + 29.0)) - 0.5) + 0.4 * (vec2(vnoise(p2 * 0.61 + 3.0), vnoise(p2 * 0.61 + 41.0)) - 0.5);
          float ce; cr = crown(p1, ce);
          float ce2; cr2 = crown(p2, ce2);
          float broad = step(0.72, cr2.z) * smoothstep(0.3, 0.6, vnoise(xy * 0.011));
          vec3 tint = mix(vec3(0.84, 0.95, 0.88), vec3(1.22, 1.2, 0.92), broad);
          alb *= mix(vec3(1.0), tint * (0.82 + 0.36 * fract(cr.z * 7.13)), det);
          alb *= mix(1.0, (smoothstep(0.8, 0.3, ce) * 0.5 + 0.5) / 0.83, det * 0.85);        // mean-preserving
          alb *= mix(1.0, (smoothstep(0.85, 0.35, ce2) * 0.3 + 0.7) / 0.9, det9 * (1.0 - det) * 1.2);
          alb *= mix(1.0, 0.55, step(0.88, fract(cr2.z * 13.1)) * max(det, det9) * 0.9);   // gaps between crowns
        }
        // stands of different age and species (never faded out: they carry the texture from afar)
        alb *= (0.88 + 0.24 * vnoise(xy / 21.0 + 3.7)) * (0.88 + 0.24 * vnoise(xy / 95.0 + 1.3));
        vec2 cuv = vec2(xy.x + uCore, uCore - xy.y) / (2.0 * uCore);
        if (max(abs(xy.x), abs(xy.y)) < uCore) {
          // forest tracks and paths under the canopy: dark lanes
          float lane = smoothstep(0.3, 0.75, texture2D(uCanopy, cuv).g) * min(1.0, 3.0 / max(mpp, 1e-3));
          float hs = smoothstep(0.3, 0.8, uSunDir.y);
          alb = mix(alb * (1.0 - 0.6 * lane), mix(alb, vec3(0.3, 0.28, 0.24) * 0.6, 0.1 * lane), hs);
          // young growth: a livelier, lighter green
          float o = texture2D(uOpen, vec2(xy.x + uOpenExt, uOpenExt - xy.y) / (2.0 * uOpenExt)).r;
          alb = mix(alb, vec3(0.62, 1.0, 0.45) * dot(alb, vec3(0.3, 0.6, 0.1)) * 1.1, smoothstep(0.55, 0.85, o) * 0.55);
        }
        alb *= mix(1.0, 0.55, vSink);                          // lowered under the individual near trees: shade
        diffuseColor.rgb = clamp(alb, 0.0, 1.0);
        vCrownN = normalize(mix(vec3(cr2.x * 1.2, 1.0, -cr2.y * 1.2), vec3(cr.x * 1.4, 1.0, -cr.y * 1.4), det));
        vCrownDet = max(det, det9 * 0.7);`,
      normal: /* glsl */ `
        {
          vec3 wn = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
          float wall = smoothstep(0.35, 0.8, vEdge) * (1.0 - smoothstep(0.55, 0.9, wn.y)); gWall = wall;
          vec3 pn = normalize(mix(wn, vCrownN, vCrownDet * (1.0 - wall) * 0.8));
          normal = normalize((viewMatrix * vec4(pn, 0.0)).xyz);
          // forest edge: a mantle of branches and shrubs down to the ground (not bare trunks), crown-sized light and
          // dark blobs along the wall, shaded towards the foot
          vec2 tw = normalize(wn.xz + vec2(1e-4, 0.0));
          vec2 wq = vec2(dot(vWP.xz, vec2(-tw.y, tw.x)), vWP.y);
          float blob = vnoise(wq * vec2(0.21, 0.28)) * 0.62 + vnoise(wq * vec2(0.55, 0.7) + 7.0) * 0.38;
          float mantle = (0.55 + 0.25 * blob) * mix(0.66, 1.0, smoothstep(0.5, 6.0, vHt));
          diffuseColor.rgb *= mix(1.0, mantle, wall);
          normal = normalize(normal + (viewMatrix * vec4(-tw.y, 0.0, tw.x, 0.0)).xyz * (blob - 0.5) * 0.6 * wall);   // leafy relief
        }`,
      // no glossy sheen: a canopy scatters, its crowns shadow each other (a smooth GGX sheet turns khaki against the sun)
      // edge walls face a low sun head-on (3.7× the sun of the canopy top): they would glow like chalk cliffs
      afterLights: 'reflectedLight.directDiffuse *= canopyBRDF(vWP) * mix(1.0, 0.45, gWall); reflectedLight.directSpecular *= 0.03; reflectedLight.indirectDiffuse *= mix(1.15, 0.85, 1.0 - smoothstep(0.08, 0.6, uSunDir.y));',
    },
  });
  return mat;
}
function sinkDepthMaterial() {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, NEAR);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aH;\nuniform vec2 uNearC;\nuniform float uNearR0, uNearR1, uNearOn, uSinkK;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + SINK_VERT);
  };
  m.customProgramCacheKey = () => 'sinkdepth';
  return m;
}

function buildShell(cells, positions, heights, edges, tnorm, mat, depthMat, group, name) {
  const remap = new Int32Array(heights.length).fill(-1);
  for (const [key, idx] of cells) {
    if (!idx.length) continue;
    let nv = 0;
    const order = [];
    const ind = new Uint32Array(idx.length);
    for (let q = 0; q < idx.length; q++) { const v = idx[q]; if (remap[v] < 0) { remap[v] = nv++; order.push(v); } ind[q] = remap[v]; }
    const pos = new Float32Array(nv * 3), hh = new Float32Array(nv), ee = new Float32Array(nv), tn = new Float32Array(nv * 3);
    for (let r = 0; r < nv; r++) {
      const v = order[r];
      pos[r * 3] = positions[v * 3]; pos[r * 3 + 1] = positions[v * 3 + 1]; pos[r * 3 + 2] = positions[v * 3 + 2];
      hh[r] = heights[v]; ee[r] = edges[v]; tn[r * 3] = tnorm[v * 3]; tn[r * 3 + 1] = tnorm[v * 3 + 1]; tn[r * 3 + 2] = tnorm[v * 3 + 2];
      remap[v] = -1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aH', new THREE.BufferAttribute(hh, 1));
    g.setAttribute('aEdge', new THREE.BufferAttribute(ee, 1));
    g.setIndex(new THREE.BufferAttribute(nv > 65535 ? ind : new Uint16Array(ind), 1));
    g.computeVertexNormals();
    // canopy tops follow the terrain's shading (no "moguls"); forest edges keep their own wall normals
    const nn = g.attributes.normal.array;
    for (let i = 0, k = 0; i < ee.length; i++, k += 3) {
      const w = 0.3 + 0.7 * ee[i];
      let x = tn[k] + (nn[k] - tn[k]) * w, y = tn[k + 1] + (nn[k + 1] - tn[k + 1]) * w, z = tn[k + 2] + (nn[k + 2] - tn[k + 2]) * w;
      const l = Math.hypot(x, y, z) || 1; nn[k] = x / l; nn[k + 1] = y / l; nn[k + 2] = z / l;
    }
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat);
    m.customDepthMaterial = depthMat;
    m.castShadow = true; m.receiveShadow = true; m.name = name + key;
    group.add(m);
  }
}

export function makeCanopy(data, ground, fm, opts) {
  const H = data.header, CORE = H.core, WIDE = H.wide;
  const group = new THREE.Group(); group.name = 'forest';
  const mat = canopyMaterial(CORE, WIDE), depthMat = sinkDepthMaterial();
  // --- detail zone
  {
    const S = opts.canopyStep, n = Math.round((2 * CORE) / S), N1 = n + 1;
    const pos = new Float32Array(N1 * N1 * 3), hh = new Float32Array(N1 * N1), mv = new Float32Array(N1 * N1);
    const ed = new Float32Array(N1 * N1), tn = new Float32Array(N1 * N1 * 3);
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) mv[j * N1 + i] = fm.shellMask(-CORE + i * S, CORE - j * S);
    const used = new Uint8Array(N1 * N1);
    const cells = new Map();
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const a = j * N1 + i, b = a + 1, c = a + N1, d = c + 1;
      if (Math.max(mv[a], mv[b], mv[c], mv[d]) < 0.08) continue;
      const x = -CORE + (i + 0.5) * S, y = CORE - (j + 0.5) * S;
      const key = Math.floor((x + CORE) / CELL) + ',' + Math.floor((y + CORE) / CELL);
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(a, c, b, b, c, d);
      used[a] = used[b] = used[c] = used[d] = 1;
    }
    // ground height at every used node and its four neighbours (for the terrain normal)
    const gh = new Float32Array(N1 * N1).fill(NaN);
    const G = (i, j) => { const k = j * N1 + i; if (gh[k] !== gh[k]) gh[k] = ground.height(-CORE + i * S, CORE - j * S); return gh[k]; };
    for (let v = 0; v < N1 * N1; v++) {
      if (!used[v]) continue;
      const i = v % N1, j = (v / N1) | 0, x = -CORE + i * S, y = CORE - j * S, m = mv[v];
      const s = sstep(0.12, 0.72, m);
      // edge factor: 1 at the forest fringe (and next to it), 0 in the interior
      const mn = Math.min(mv[v], i > 0 ? mv[v - 1] : 0, i < n ? mv[v + 1] : 0, j > 0 ? mv[v - N1] : 0, j < n ? mv[v + N1] : 0);
      const edge = 1 - sstep(0.2, 0.75, mn);
      // ragged crowns along the fringe instead of a flat-topped mesa
      const h = m < 0.12 ? 0 : fm.canopyHeight(x, y) * (0.55 + 0.45 * s) * Math.min(1, s * 1.6) * (1 - edge * 0.45 * hash2(x * 0.37 + 1.3, y * 0.29));
      pos[v * 3] = x; pos[v * 3 + 1] = G(i, j) + (m < 0.12 ? -1.0 : h); pos[v * 3 + 2] = -y;
      hh[v] = m < 0.12 ? -0.01 : h + 1.5;
      ed[v] = edge;
      const i0 = Math.max(0, i - 1), i1 = Math.min(n, i + 1), j0 = Math.max(0, j - 1), j1 = Math.min(n, j + 1);
      const gx = (G(i1, j) - G(i0, j)) / ((i1 - i0) * S), gy = (G(i, j0) - G(i, j1)) / ((j1 - j0) * S);
      const l = Math.hypot(gx, 1, gy); tn[v * 3] = -gx / l; tn[v * 3 + 1] = 1 / l; tn[v * 3 + 2] = gy / l;
    }
    buildShell(cells, pos, hh, ed, tn, mat, depthMat, group, 'canopy-core-');
  }
  // --- outer ring from the 25 m forest raster
  {
    const fw = data.forestWide, bits = fw.bits, fn = fw.n;
    const bit = (ix, iy) => (ix < 0 || iy < 0 || ix >= fn || iy >= fn ? 0 : (bits[(iy * fn + ix) >> 3] >> (7 - ((iy * fn + ix) & 7))) & 1);
    const maskW = (x, y) => {
      const fx = (x + fw.ext) / fw.res - 0.5, fy = (fw.ext - y) / fw.res - 0.5;
      const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
      const a = bit(ix, iy), b = bit(ix + 1, iy), c = bit(ix, iy + 1), d = bit(ix + 1, iy + 1);
      return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    };
    const S = opts.wideCanopyStep, n = Math.round((2 * WIDE) / S), N1 = n + 1;
    const pos = new Float32Array(N1 * N1 * 3), hh = new Float32Array(N1 * N1), mv = new Float32Array(N1 * N1);
    const ed = new Float32Array(N1 * N1), tn = new Float32Array(N1 * N1 * 3);
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) mv[j * N1 + i] = maskW(-WIDE + i * S, WIDE - j * S);
    const used = new Uint8Array(N1 * N1);
    const cells = new Map();
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const x = -WIDE + (i + 0.5) * S, y = WIDE - (j + 0.5) * S;
      if (Math.abs(x) < CORE && Math.abs(y) < CORE) continue;
      const a = j * N1 + i, b = a + 1, c = a + N1, d = c + 1;
      if (Math.max(mv[a], mv[b], mv[c], mv[d]) < 0.1) continue;
      const key = Math.floor((x + WIDE) / 3200) + ',' + Math.floor((y + WIDE) / 3200);
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(a, c, b, b, c, d);
      used[a] = used[b] = used[c] = used[d] = 1;
    }
    for (let v = 0; v < N1 * N1; v++) {
      if (!used[v]) continue;
      const i = v % N1, j = (v / N1) | 0, x = -WIDE + i * S, y = WIDE - j * S, m = mv[v];
      const inCore = Math.abs(x) < CORE && Math.abs(y) < CORE;
      const s = sstep(0.2, 0.95, m);
      pos[v * 3] = x; pos[v * 3 + 2] = -y;
      pos[v * 3 + 1] = ground.height(x, y) + (m < 0.15 || inCore ? -2 : matureHeight(x, y) * s * s * 0.92);
      hh[v] = 0;
      ed[v] = 1 - s;
      const dx = ground.height(x + S, y) - ground.height(x - S, y), dy = ground.height(x, y + S) - ground.height(x, y - S);
      const l = Math.hypot(dx / (2 * S), 1, dy / (2 * S)); tn[v * 3] = -dx / (2 * S) / l; tn[v * 3 + 1] = 1 / l; tn[v * 3 + 2] = dy / (2 * S) / l;
    }
    buildShell(cells, pos, hh, ed, tn, mat, depthMat, group, 'canopy-wide-');
  }
  return { group, material: mat };
}

// ------------------------------------------------------------------------------------------------ tree models
function colorGeo(g, col, gradient) {
  const n = g.attributes.position.count, c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const y = g.attributes.position.getY(i), k = gradient ? gradient(y) : 1;
    c[i * 3] = col[0] * k; c[i * 3 + 1] = col[1] * k; c[i * 3 + 2] = col[2] * k;
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g.index ? g.toNonIndexed() : g;
}
function spruceGeometry(segs = 8, trunk = true) {
  // height 1: trunk + three stacked tiers with jagged, drooping rims (Picea abies silhouette)
  const parts = trunk ? [colorGeo(new THREE.CylinderGeometry(0.011, 0.02, 0.24, 5, 1, true).translate(0, 0.12, 0), [0.075, 0.055, 0.04])] : [];
  const tiers = segs > 4 ? [[0.155, 0.46, 0.14], [0.12, 0.4, 0.4], [0.078, 0.34, 0.66]] : [[0.15, 0.86, 0.14]];
  tiers.forEach(([r, h, y0], ti) => {
    const c = new THREE.ConeGeometry(r, h, segs, 1, true); c.translate(0, y0 + h / 2, 0);
    const p = c.attributes.position, step = (Math.PI * 2) / segs;
    for (let i = 0; i < p.count && segs > 4; i++) {
      const y = p.getY(i);
      if (y < y0 + 0.01) {                                  // rim vertex: jitter radius, droop every other one
        const x = p.getX(i), z = p.getZ(i), a = Math.atan2(z, x), k = 0.85 + 0.3 * hash2(a * 13.7 + ti, ti * 7.1);
        p.setXYZ(i, x * k, y - (Math.round(a / step) % 2 ? 0.035 : 0), z * k);
      }
    }
    c.computeVertexNormals();
    parts.push(colorGeo(c, [0.042, 0.078, 0.046], (y) => 0.45 + 0.65 * y));
  });
  return merge(parts);
}
function broadleafGeometry(detail = 1) {
  // detail 1: 80-face crown on a trunk; 0: 20-face crown, 3-sided trunk; -1: 8-face crown only (far away)
  const parts = [];
  if (detail >= 0) parts.push(colorGeo(new THREE.CylinderGeometry(0.016, 0.026, 0.42, detail ? 5 : 3, 1, true).translate(0, 0.21, 0), [0.085, 0.07, 0.055]));
  const crown = detail >= 0 ? new THREE.IcosahedronGeometry(0.3, detail) : new THREE.OctahedronGeometry(0.31, 0);
  crown.scale(1, 1.1, 1); crown.translate(0, 0.64, 0);
  const p = crown.attributes.position;
  for (let i = 0; i < p.count && detail >= 0; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), k = 0.86 + 0.28 * hash2(x * 97 + z * 13, y * 71);
    p.setXYZ(i, x * k, 0.64 + (y - 0.64) * k, z * k);
  }
  // smooth, sphere-like normals (the polyhedron is non-indexed)
  const nrm = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i) - 0.64, z = p.getZ(i), l = Math.hypot(x, y, z) || 1;
    nrm[i * 3] = x / l; nrm[i * 3 + 1] = y / l; nrm[i * 3 + 2] = z / l;
  }
  crown.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  parts.push(colorGeo(crown, [0.045, 0.078, 0.03], (y) => 0.6 + 0.5 * y));
  return merge(parts);
}
export function merge(geos) {
  let n = 0; for (const g of geos) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  for (const g of geos) {
    if (!g.attributes.normal) g.computeVertexNormals();
    pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3);
    if (g.attributes.color) col.set(g.attributes.color.array, o * 3); else col.fill(1, o * 3, (o + g.attributes.position.count) * 3);
    o += g.attributes.position.count;
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  m.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  m.setAttribute('color', new THREE.BufferAttribute(col, 3));
  m.computeBoundingSphere();
  return m;
}
// Shared by all trees: ambient lift (1.15 like the canopy; more at eye level, where the crowns fill the view)
export const TREE_U = { uTreeLift: { value: 1.15 } };
// Sentinel-2 tint of a tree, the same transform the canopy shell applies (so trees and shell match), relative to a
// typical forest albedo and clamped: GLSL for the near forest, JS (baked into the instance colour) for the static trees
const TINT_GLSL = /* glsl */ `
vec3 satTint(vec2 xy) {
  vec3 c = texture2D(uSatCore, vec2(xy.x + uCoreExt, uCoreExt - xy.y) / (2.0 * uCoreExt)).rgb * uGainInv;
  c = mix(c, c.ggg * vec3(0.62, 1.0, 0.6), 0.2);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = max(mix(vec3(l), c, 1.2), 0.0) * 0.95; c.b = min(c.b, c.g * 0.8);
  return clamp(c / vec3(0.05, 0.075, 0.045), 0.6, 1.1);
}`;
export function satTintJS(img, x, y, core, gainInv) {
  // img: {data, w} 8-bit sRGB RGBA of the core Sentinel-2 image
  const u = (x + core) / (2 * core), v = (core - y) / (2 * core);
  const px = Math.max(0, Math.min(img.w - 1, Math.floor(u * img.w))), py = Math.max(0, Math.min(img.w - 1, Math.floor(v * img.w)));
  const k = (py * img.w + px) * 4, lin = (b) => { const s = b / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  let r = lin(img.data[k]) * gainInv, g = lin(img.data[k + 1]) * gainInv, bl = lin(img.data[k + 2]) * gainInv;
  r += (g * 0.62 - r) * 0.2; bl += (g * 0.6 - bl) * 0.2;
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  const sat = (c) => Math.max(0, l + (c - l) * 1.2) * 0.95, cg = sat(g), cb = Math.min(sat(bl), cg * 0.8);
  const f = (c, ref) => Math.max(0.6, Math.min(1.1, c / ref));
  return [f(sat(r), 0.05), f(cg, 0.075), f(cb, 0.045)];
}
// near: the individual trees around the camera — tinted in the shader, and towards the rim of their disc they shade
// like the canopy shell they merge into (flatter normals, darker)
export function treeMaterial(near = false) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  return patch(mat, {
    key: near ? 'tree-near' : 'tree',
    uniforms: { uCoreExt: { value: 4096 }, ...TREE_U, ...(near ? NEAR : {}) },
    frag: {
      pars: 'uniform float uTreeLift;',
      afterLights: /* glsl */ `
        { vec3 nW = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
          // light through the needles / leaves when the sun is behind the crown; sky light fills the shaded side
          reflectedLight.directDiffuse += uSunCol * diffuseColor.rgb * 0.3 * max(dot(-nW, uSunDir), 0.0) * step(0.0, uSunDir.y);
          // a crown's side is never a flat panel facing the sun: temper the brightest faces (pale slivers far away)
          reflectedLight.directDiffuse *= mix(1.0, 0.6, smoothstep(0.4, 0.95, dot(nW, uSunDir))) * canopyBRDF(vWP);
          reflectedLight.directSpecular *= 0.2;
          reflectedLight.indirectDiffuse *= uTreeLift * mix(1.0, 0.74, 1.0 - smoothstep(0.08, 0.6, uSunDir.y)); }`,
    },
    vert: {
      normal: `{ vec4 ip0 = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
                 vec3 q = position * 23.0 + ip0.xyz * 0.37;
                 objectNormal = normalize(objectNormal + 0.45 * (vec3(fract(sin(dot(q, vec3(12.9898, 78.233, 37.719))) * 43758.5453),
                   fract(sin(dot(q, vec3(39.346, 11.135, 83.155))) * 24634.6345), fract(sin(dot(q, vec3(73.156, 52.235, 9.151))) * 56445.2345)) - 0.5));
                 ${near ? 'float rim = smoothstep(uNearR0 - 150.0, uNearR1, distance(ip0.xz, uNearC)); objectNormal = normalize(mix(objectNormal, vec3(0.0, 1.0, 0.0), 0.8 * rim));' : ''} }`,
      begin: `{ vec4 ip = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
               float ph = ip.x * 0.13 + ip.z * 0.17;
               transformed.x += sin(uTime * 1.3 + ph) * 0.012 * position.y * position.y; }`,
      pars: 'uniform float uTime;\nuniform sampler2D uSatCore;\nuniform float uGainInv;\nuniform float uCoreExt;\n' + (near ? 'uniform vec2 uNearC;\nuniform float uNearR0, uNearR1;\n' + TINT_GLSL : ''),
      main: near ? `{ vec4 ip = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
               #ifdef USE_COLOR
                 vColor.rgb *= satTint(vec2(ip.x, -ip.z)) * mix(1.0, 0.8, smoothstep(uNearR0 - 150.0, uNearR1, distance(ip.xz, uNearC)));
               #endif
             }` : '',
    },
  });
}
// [species][level]: spruce 34 / 18 / 5 triangles, broadleaf 90 / 26 / 8 triangles
export const TREE_GEOS = () => [[spruceGeometry(8), spruceGeometry(6, false), spruceGeometry(4, false)], [broadleafGeometry(1), broadleafGeometry(0), broadleafGeometry(-1)]];

// Instanced trees in three levels of detail chosen by distance to the camera. The instance buffers are re-binned
// whenever the camera has moved `step` metres: one draw call per species and level, nothing to cull.
export class TreeLOD {
  constructor(name, geos, mat, caps, dists, step) {
    this.dists = dists; this.step = step; this.at = null; this.n = 0;
    this.group = new THREE.Group(); this.group.name = name;
    this.meshes = geos.map((set, kind) => set.slice(0, dists.length).map((g, lod) => {
      const cap = Math.max(1, caps[kind]);
      const m = new THREE.InstancedMesh(g, mat, cap);
      m.count = 0; m.frustumCulled = false; m.receiveShadow = true;
      m.castShadow = lod < 2;                  // far trees: the canopy shell's own shadow carries them
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
      m.name = `${name}-${kind}-${lod}`; this.group.add(m);
      return m;
    }));
  }
  // mats: 16 floats, cols: 3 floats, pos: world x, y, z (tree foot) per instance; kinds: species index
  set(mats, cols, pos, kinds, n) { this.src = { mats, cols, pos, kinds }; this.n = n; this.at = null; }
  // fwd: camera direction; trees more than `behind` metres behind the camera are left out (farther than their shadows
  // reach into the view). Re-binned after `step` metres or a 20° turn.
  update(cam, fwd, behind = 150) {
    if (!this.src) return;
    const turned = !fwd || !this.fwd || this.fwd.dot(fwd) < 0.94;
    if (this.at && !turned && this.at.distanceToSquared(cam) < this.step * this.step) return;
    (this.at || (this.at = new THREE.Vector3())).copy(cam);
    if (fwd) (this.fwd || (this.fwd = new THREE.Vector3())).copy(fwd);
    const fx = fwd ? fwd.x : 0, fy = fwd ? fwd.y : 0, fz = fwd ? fwd.z : 0, back = fwd ? -behind : -Infinity;
    const { mats, cols, pos, kinds } = this.src, L = this.dists.length, D2 = this.dists.map((d) => d * d);
    const cnt = this.meshes.map((set) => set.map(() => 0));
    for (let i = 0; i < this.n; i++) {
      const dx = pos[i * 3] - cam.x, dy = pos[i * 3 + 1] - cam.y, dz = pos[i * 3 + 2] - cam.z, d2 = dx * dx + dy * dy + dz * dz;
      if (dx * fx + dy * fy + dz * fz < back) continue;
      let l = 0; while (l < L && d2 > D2[l]) l++;
      if (l === L) continue;
      const k = kinds[i], m = this.meshes[k][l], c = cnt[k][l]++;
      const A = m.instanceMatrix.array, o = c * 16, s = i * 16;
      for (let q = 0; q < 16; q++) A[o + q] = mats[s + q];
      const C = m.instanceColor.array; C[c * 3] = cols[i * 3]; C[c * 3 + 1] = cols[i * 3 + 1]; C[c * 3 + 2] = cols[i * 3 + 2];
    }
    this.meshes.forEach((set, k) => set.forEach((m, l) => {
      m.count = cnt[k][l];
      if (!m.count) return;
      m.instanceMatrix.clearUpdateRanges(); m.instanceMatrix.addUpdateRange(0, m.count * 16); m.instanceMatrix.needsUpdate = true;
      m.instanceColor.clearUpdateRanges(); m.instanceColor.addUpdateRange(0, m.count * 3); m.instanceColor.needsUpdate = true;
    }));
    this.last = cnt;
  }
}

// ------------------------------------------------------------------------------------------------ static trees
export function makeTrees(data, ground, fm, opts, meshH, satImg, gainInv) {
  const baseY = (x, y) => Math.min(ground.height(x, y), meshH ? meshH(x, y) : 1e9) - 0.3;
  const H = data.header, CORE = H.core;
  const rnd = mulberry(1234);
  const list = [];   // [x, y, height, kind(0 spruce, 1 broadleaf), widthScale]
  // 1) forest edges from the canopy mask
  const S = opts.edgeStep, BLK = 64;
  const blockHasEdge = (bx, by) => {
    let mn = 1, mx = 0;
    for (let yy = by - 8; yy <= by + BLK + 8; yy += 8) for (let xx = bx - 8; xx <= bx + BLK + 8; xx += 8) { const v = fm.shellMask(xx, yy); if (v < mn) mn = v; if (v > mx) mx = v; }
    return mx > 0.5 && mn < 0.4;
  };
  const edgeBlocks = new Set();
  for (let by = -CORE; by < CORE; by += BLK) for (let bx = -CORE; bx < CORE; bx += BLK) if (blockHasEdge(bx, by)) edgeBlocks.add(bx + ',' + by);
  for (let y = -CORE + S / 2; y < CORE; y += S) for (let x = -CORE + S / 2; x < CORE; x += S) {
    if (!edgeBlocks.has((Math.floor((x + CORE) / BLK) * BLK - CORE) + ',' + (Math.floor((y + CORE) / BLK) * BLK - CORE))) continue;
    const jx = x + (hash2(x * 0.37, y * 0.71) - 0.5) * S * 0.9, jy = y + (hash2(x * 0.53 + 9, y * 0.29) - 0.5) * S * 0.9;
    const m = fm.shellMask(jx, jy);
    if (m < 0.3 || fm.obstacle(jx, jy) > 0.4) continue;
    const e = 6;
    const mx0 = fm.shellMask(jx - e, jy), mx1 = fm.shellMask(jx + e, jy), my0 = fm.shellMask(jx, jy - e), my1 = fm.shellMask(jx, jy + e);
    if (Math.min(mx0, mx1, my0, my1) > 0.35) continue;
    let gx = mx0 - mx1, gy = my0 - my1; const gl = Math.hypot(gx, gy) || 1; gx /= gl; gy /= gl;
    if (fm.shellMask(jx + gx * 17, jy + gy * 17) > 0.5 && hash2(jx * 3.1, jy * 1.7) > 0.12) continue;   // narrow gaps
    const ch = fm.canopyHeight(jx, jy);
    if (ch < 3) continue;
    if (m < 0.55) {
      // forest mantle (Waldmantel): shrubs and young broadleaves 2–5 m outside the edge, in clumps with gaps
      if (vnoise(jx / 14 + 3.1, jy / 14) < 0.4 || hash2(jx * 1.7 + 3, jy * 2.3) > 0.55) continue;
      const off = 2 + 3 * rnd(), mx = jx + gx * off, my = jy + gy * off;
      if (fm.obstacle(mx, my) > 0.3) continue;
      list.push([mx, my, ch * (0.35 + 0.5 * rnd()), hash2(jx * 0.9, jy * 0.7 + 2) < 0.7 ? 1 : 0, 0.5 + 0.8 * rnd(), jx - gx * 10, jy - gy * 10, 0.8]);
      continue;
    }
    list.push([jx, jy, ch * (0.8 + 0.28 * rnd()), hash2(jx * 0.02 + 5, jy * 0.02) > 0.72 ? 1 : 0, 1, jx - gx * 10, jy - gy * 10, 1]);
  }
  const nEdge = list.length;
  // 2) OSM single trees, tree rows, hedges
  for (const t of data.trees) {
    const kind = t.a[0], c = t.rings[0];
    if (kind === 1) { list.push([c[0], c[1], 11 + 9 * rnd(), 1, 1]); continue; }
    const step = kind === 2 ? 8 : 2.6;
    for (let i = 0; i + 3 < c.length; i += 2) {
      const ax = c[i], ay = c[i + 1], bx = c[i + 2], by = c[i + 3], L = Math.hypot(bx - ax, by - ay);
      for (let s = 0; s < L; s += step) {
        const x = ax + ((bx - ax) * s) / L + (rnd() - 0.5), y = ay + ((by - ay) * s) / L + (rnd() - 0.5);
        if (fm.obstacle(x, y) > 0.5) continue;
        list.push(kind === 2 ? [x, y, 12 + 8 * rnd(), rnd() < 0.2 ? 0 : 1, 1] : [x, y, 3 + 2.5 * rnd(), 1, 1.35]);
      }
    }
  }
  // 3) orchards (Streuobstwiesen, 10 m grid) and village gardens
  for (const f of data.landuse) {
    const cls = f.a[0];
    if (cls !== 3 && cls !== 4 && cls !== 8) continue;
    const ring = f.rings[0], bb = ringBBox(ring);
    const step = cls === 3 ? 10 : 17;
    for (let y = bb[1] + step / 2; y < bb[3]; y += step) for (let x = bb[0] + step / 2; x < bb[2]; x += step) {
      const px = x + (rnd() - 0.5) * (cls === 3 ? 2.5 : step * 0.9), py = y + (rnd() - 0.5) * (cls === 3 ? 2.5 : step * 0.9);
      if (cls !== 3 && rnd() > 0.42) continue;
      if (!pointInRing(px, py, ring)) continue;
      let hole = false; for (let k = 1; k < f.rings.length; k++) if (pointInRing(px, py, f.rings[k])) { hole = true; break; }
      if (hole || fm.obstacle(px, py) > 0.3 || fm.mask(px, py) > 0.3) continue;
      if (cls === 3) list.push([px, py, 5.5 + 3 * rnd(), 1, 1.25]);
      else list.push([px, py, 6 + 9 * rnd(), rnd() < 0.3 ? 0 : 1, 1]);
    }
  }
  const geos = TREE_GEOS();
  const mat = treeMaterial(false);
  const n = list.length, mats = new Float32Array(n * 16), cols = new Float32Array(n * 3), pos = new Float32Array(n * 3), kinds = new Uint8Array(n);
  const caps = [0, 0];
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  list.forEach((t, i) => {
    const [x, y, h, kind, s] = t;
    // Sentinel-2 tint: edge trees sample 10 m inside the forest (their own pixel straddles the bright field) and
    // are never lighter than the forest behind them
    const tint = satImg ? satTintJS(satImg, t.length > 5 ? t[5] : x, t.length > 5 ? t[6] : y, CORE, gainInv) : [1, 1, 1];
    const cap = t.length > 5 ? 1.0 : 1.1, dim = t.length > 7 ? t[7] : 1;
    p.set(x, baseY(x, y), -y);
    q.setFromAxisAngle(up, hash2(x * 7.1, y * 3.3) * Math.PI * 2);
    const w = h * (kind ? 0.95 + 0.25 * hash2(x, y * 2) : 1) * s;
    sc.set(w, h, w);
    m4.compose(p, q, sc); m4.toArray(mats, i * 16);
    const v = 0.8 + 0.4 * hash2(x * 1.3, y * 0.7);
    cols[i * 3] = v * (0.95 + 0.1 * hash2(y, x)) * Math.min(cap, tint[0]) * dim; cols[i * 3 + 1] = v * Math.min(cap, tint[1]) * dim; cols[i * 3 + 2] = v * 0.95 * Math.min(cap, tint[2]) * dim;
    pos[i * 3] = x; pos[i * 3 + 1] = p.y + h * 0.5; pos[i * 3 + 2] = -y;
    kinds[i] = kind; caps[kind]++;
  });
  const lod = new TreeLOD('trees', geos, mat, caps, opts.treeLod, 60);
  lod.set(mats, cols, pos, kinds, n);
  const group = lod.group;
  return { group, lod, count: list.length, edgeCount: nEdge, material: mat, geos };
}

// ------------------------------------------------------------------------------------------------ near-field trees
// Individual trees on a jittered grid inside the canopy mask around a moving centre; the canopy shell sinks there.
export class NearForest {
  constructor(fm, ground, mat, geos, opts, meshH) {
    this.fm = fm; this.ground = ground; this.meshH = meshH; this.S = opts.nearStep; this.R = opts.nearR;
    const cap = Math.ceil(((Math.PI * this.R * this.R) / (this.S * this.S)) * 0.95);
    this.lod = new TreeLOD('near-forest', geos, mat, [cap, cap], opts.nearLod, 25);
    this.mats = new Float32Array(cap * 16); this.cols = new Float32Array(cap * 3); this.pos = new Float32Array(cap * 3); this.kinds = new Uint8Array(cap);
    this.cap = cap; this.center = null; this.group = this.lod.group;
    this._m4 = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._q2 = new THREE.Quaternion(); this._ax = new THREE.Vector3(); this._s = new THREE.Vector3(); this._p = new THREE.Vector3();
  }
  // on/off fades over ~0.6 s: the shell sinks (or rises back over the trees) instead of popping
  update(cx, cy, on, cam, dt, fwd, behind, busy) {
    this.fade = Math.max(0, Math.min(1, (this.fade || 0) + (on ? dt : -dt) / 0.6));
    const f = this.fade;
    NEAR.uNearOn.value = f * f * (3 - 2 * f);
    this.group.visible = f > 0;
    if (f <= 0) return;
    // (not while flying: the disc would be rebuilt every frame on the way)
    if (on && !busy && (!this.center || Math.hypot(cx - this.center[0], cy - this.center[1]) >= 70)) this.regen(cx, cy);
    this.lod.update(cam, fwd, behind);
  }
  regen(cx, cy) {
    this.center = [cx, cy];
    NEAR.uNearC.value.set(cx, -cy);
    NEAR.uNearR1.value = this.R - 80; NEAR.uNearR0.value = this.R - 210;
    const { fm, ground, S, R } = this;
    let n = 0;
    const x0 = Math.floor((cx - R) / S), x1 = Math.ceil((cx + R) / S), y0 = Math.floor((cy - R) / S), y1 = Math.ceil((cy + R) / S);
    const up = new THREE.Vector3(0, 1, 0);
    for (let j = y0; j <= y1 && n < this.cap; j++) for (let i = x0; i <= x1 && n < this.cap; i++) {
      const h1 = hash2(i * 1.37, j * 0.73), h2 = hash2(i * 0.51 + 11, j * 1.91);
      const x = (i + 0.1 + 0.8 * h1) * S, y = (j + 0.1 + 0.8 * h2) * S;
      const dc = Math.hypot(x - cx, y - cy);
      if (dc > R * (0.84 + 0.16 * hash2(i * 0.7 + 5, j * 1.1))) continue;          // ragged rim
      if (hash2(i * 3.7 + 1, j * 1.9) < 0.1) continue;                              // gaps
      if (fm.mask(x, y) < 0.5) continue;
      const o = fm.openness(x, y);
      if (o > 0.9 && hash2(i * 5.1, j * 0.3) < 0.7) continue;                        // openings: scattered saplings only
      // towards the rim no tip may clear the shell, which stands at full height there
      const h = fm.canopyHeight(x, y) * (0.7 + 0.45 * hash2(i * 2.3, j * 3.1)) * (1 - 0.3 * sstep(R - 160, R - 70, dc)) * (o > 0.9 ? 0.55 : 1);
      if (h < 1.5) continue;
      const kind = hash2(Math.floor(x / 40), Math.floor(y / 40)) > 0.7 && hash2(i, j) > 0.3 ? 1 : 0;
      this._p.set(x, Math.min(ground.height(x, y), this.meshH ? this.meshH(x, y) : 1e9) - 0.3, -y);
      // heading plus a lean of up to ±3°
      const la = hash2(i * 4.1, j * 2.9) * Math.PI * 2;
      this._q.setFromAxisAngle(this._ax.set(Math.cos(la), 0, Math.sin(la)), (hash2(i * 1.1, j * 5.3) - 0.5) * 0.105)
        .multiply(this._q2.setFromAxisAngle(up, hash2(i * 7.7, j * 1.3) * Math.PI * 2));
      const w = h * (0.8 + 0.45 * hash2(j, i));
      this._s.set(w, h, w);
      this._m4.compose(this._p, this._q, this._s); this._m4.toArray(this.mats, n * 16);
      const v = (0.78 + 0.44 * hash2(i * 1.9, j * 2.7)) * (0.8 + 0.4 * vnoise(x / 25 + 7.7, y / 25));   // stands of lighter / darker trees
      this.cols[n * 3] = v * (0.94 + 0.12 * hash2(j * 3, i)); this.cols[n * 3 + 1] = v; this.cols[n * 3 + 2] = v * 0.94;
      this.pos[n * 3] = x; this.pos[n * 3 + 1] = this._p.y + h * 0.5; this.pos[n * 3 + 2] = -y;
      this.kinds[n] = kind; n++;
    }
    this.lod.set(this.mats, this.cols, this.pos, this.kinds, n);
    this.last = n;
  }
}
export { U };
