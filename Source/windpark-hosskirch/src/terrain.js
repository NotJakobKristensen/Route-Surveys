// Terrain: a detail mesh over ±CORE (16 m, with skirts) and an outer ring to ±WIDE (128 m). Ground colour is the
// Sentinel-2 surface reflectance; a class map rasterised from the OSM polygons adds close-range detail per land use.
import * as THREE from 'three';
import { patch, U } from './env.js';
import { FOREST_TEX } from './forest.js';

export const CLS = { farmland: 1, meadow: 2, orchard: 3, residential: 4, industrial: 5, farmyard: 6, cemetery: 7, garden: 8, park: 9,
  quarry: 10, scrub: 11, wetland: 12, forest: 13, water: 14, gravel: 15 };

function ringsPath(rings, ext, px) {
  const p = new Path2D();
  for (const c of rings) {
    for (let i = 0; i < c.length; i += 2) {
      const X = (c[i] + ext) * px, Y = (ext - c[i + 1]) * px;
      i === 0 ? p.moveTo(X, Y) : p.lineTo(X, Y);
    }
    p.closePath();
  }
  return p;
}

// Class map: R = class*16+8, G = farmland direction (0..255 → 0..180°) or seed, B = seed. NEAREST sampled.
export function makeClassMap(data, size) {
  const ext = data.header.core, px = size / (2 * ext);
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.fillStyle = 'rgb(8,0,0)'; g.fillRect(0, 0, size, size);
  let seed = 1;
  const fill = (rings, cls, gch) => {
    seed = (seed * 16807) % 2147483647;
    g.fillStyle = `rgb(${cls * 16 + 8},${gch == null ? seed % 256 : gch},${(seed >> 8) % 256})`;
    g.fill(ringsPath(rings, ext, px), 'evenodd');
  };
  for (const f of data.landuse) fill(f.rings, f.a[0], f.a[0] === 1 ? f.a[1] : null);
  for (const f of data.forest) fill(f.rings, CLS.forest);
  for (const f of data.water) fill(f.rings, CLS.water);
  for (const f of data.pads) fill(f.rings, CLS.gravel);
  // snap antialiased edge pixels to a valid class code (copy the left / upper neighbour)
  const img = g.getImageData(0, 0, size, size), d = img.data;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4, r = d[i];
    if ((r & 15) !== 8) {
      const j = x > 0 ? i - 4 : y > 0 ? i - size * 4 : i;
      if (j !== i) { d[i] = d[j]; d[i + 1] = d[j + 1]; d[i + 2] = d[j + 2]; } else { d[i] = ((r >> 4) << 4) + 8; }
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.magFilter = tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.colorSpace = THREE.NoColorSpace;
  return { tex, canvas: cv, ctx: g, data: d, size, ext };
}

const GROUND_FRAG_PARS = /* glsl */ `
uniform sampler2D uSatCore;
uniform sampler2D uSatWide;
uniform sampler2D uCls;
uniform sampler2D uCanopy;
uniform sampler2D uOpen;
uniform float uOpenExt;
uniform float uGainInv;
uniform float uCore;
uniform float uWide;
vec3 satAlbedo(vec2 xy, float lod) {
  float m = max(abs(xy.x), abs(xy.y));
  vec3 w = texture2D(uSatWide, vec2(xy.x + uWide, uWide - xy.y) / (2.0 * uWide)).rgb;
  vec3 c = w;
  if (m < uCore - 4.0) {
    vec2 uv = vec2(xy.x + uCore, uCore - xy.y) / (2.0 * uCore);
    vec3 k = lod > 0.0 ? textureLod(uSatCore, uv, lod).rgb : texture2D(uSatCore, uv).rgb;
    c = mix(k, w, smoothstep(uCore - 400.0, uCore - 4.0, m));          // blend the 8 m and 40 m imagery over 400 m
  }
  c *= uGainInv;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = max(mix(vec3(l), c, 1.45), 0.0) * 1.08;
  return c;
}
// thin stripe once per period (m), area-preserving when it gets thinner than a pixel, gone before it can alias
float stripe(float s, float period, float offs, float halfw) {
  float d = abs(mod(s + offs, period) - 0.5 * period);
  float w = fwidth(s) * 1.2 + 1e-4;
  return (1.0 - smoothstep(halfw - w, halfw + w, d)) * min(1.0, halfw / w) * (1.0 - smoothstep(period * 0.12, period * 0.32, w));
}
`;

const GROUND_MAP = /* glsl */ `
  vec2 xy = vec2(vWP.x, -vWP.z);
  vec2 pfx = dFdx(xy), pfy = dFdy(xy);
  vec3 alb = satAlbedo(xy, 0.0);
  float camD = distance(vWP, cameraPosition);
  float det = 1.0 - smoothstep(180.0, 1600.0, camD);
  float inCore = step(max(abs(xy.x), abs(xy.y)), uCore - 2.0);
  // class lookup jittered by ±1.5 m so the 4 m class raster has no staircase edges
  vec2 jit = (vec2(vnoise(xy * 0.61), vnoise(xy * 0.61 + 19.3)) - 0.5) * 3.2;
  vec3 cm = texture2D(uCls, vec2(xy.x + jit.x + uCore, uCore - xy.y - jit.y) / (2.0 * uCore)).rgb;
  float id = inCore > 0.5 ? floor(cm.r * 255.0 / 16.0 + 0.01) : 0.0;
  float n1 = vnoise(xy * 0.85), n2 = vnoise(xy * 0.21 + 7.0), n3 = vnoise(xy * 0.043 + 3.0);
  // metres per pixel → close-range detail fades by footprint, not by distance
  // footprint between the long axis (length(fwidth) kills detail at grazing angles) and the area (shimmers)
  float mpp = sqrt(max(length(pfx), length(pfy))) * pow(max(abs(pfx.x * pfy.y - pfx.y * pfy.x), 1e-10), 0.25);
  float nearD = 1.0 - smoothstep(0.05, 0.45, mpp);
  // eye level: one 10 m image pixel spans the whole foreground and stretches into streaks — take the smoothed image
  // colour there and let the procedural detail below carry the texture
  float closeUp = 1.0 - smoothstep(0.03, 0.3, mpp);
  if (closeUp > 0.001) alb = mix(alb, satAlbedo(xy, 1.6), closeUp * 0.85);
  float tuft = vnoise(xy * 2.6) * 0.5 + vnoise(xy * 0.77 + 5.0) * 0.3 + vnoise(xy * 0.25 + 9.0) * 0.2;
  gBump = 0.0;
  // de-blur the 10 m imagery a little with small-scale variation
  alb *= mix(1.0, 0.86 + 0.28 * n1, det) * (0.94 + 0.12 * n3);
  if (id == 1.0) {
    float a = cm.g * 3.14159265;
    vec2 dir = vec2(cos(a), sin(a)), nrm = vec2(-dir.y, dir.x);
    float s = dot(xy, nrm) + cm.b * 0.33;
    float tl = max(stripe(s, 21.0, 0.9, 0.22), stripe(s, 21.0, -0.9, 0.22));
    // across-row footprint: row patterns fade out before they can alias (moiré at grazing angles)
    float fs = fwidth(s);
    float rows = vnoise(vec2(dot(xy, dir) * 0.06, s * 3.2));
    alb *= mix(1.0, 0.93 + 0.14 * rows, det * (1.0 - smoothstep(0.12, 0.35, fs)));
    // crop density patches (≈ 3 × 1.7 m) up close, where the image is smoothed
    alb *= mix(1.0, 0.82 + 0.36 * vnoise(vec2(dot(xy, dir) * 0.35, s * 0.6)), closeUp);
    alb = mix(alb, alb * vec3(0.78, 0.74, 0.70), tl * det * 0.9);
    // crop rows (0.75 m) and clods up close
    // (irregular, low ridges: at grazing evening sun a strong regular bump reads as corduroy)
    float row = 0.5 + 0.5 * sin(s * 8.3776 + 2.0 * vnoise(xy * vec2(0.3, 0.3) + 3.1)), rowA = 1.0 - smoothstep(0.06, 0.24, fs);
    alb *= mix(1.0, 0.88 + 0.18 * row, rowA * (0.45 + 0.4 * n2)) * mix(1.0, 0.85 + 0.3 * tuft, nearD * 0.8);
    gBump = row * 0.14 * rowA + tuft * 0.4 * nearD;
  } else if (id == 2.0 || id == 3.0 || id == 9.0 || id == 12.0) {
    alb *= mix(1.0, 0.85 + 0.3 * n2, det * 0.8);
    alb *= mix(1.0, 0.66 + 0.68 * tuft, nearD * 0.85);                  // grass tufts
    gBump = tuft * nearD;
  } else if (id == 4.0 || id == 6.0 || id == 7.0 || id == 8.0) {
    vec3 lawn = vec3(0.085, 0.13, 0.045) * (0.8 + 0.4 * n2);
    vec3 yard = vec3(0.17, 0.16, 0.145) * (0.85 + 0.3 * n1);
    float k = id == 6.0 ? 0.55 : 0.3;
    alb = mix(alb, mix(lawn, yard, k), 0.55);
  } else if (id == 5.0) {
    alb = mix(alb, vec3(0.16, 0.16, 0.155) * (0.8 + 0.4 * n1), 0.55);
  } else if (id == 15.0) {
    vec3 grv = vec3(0.34, 0.315, 0.27) * (0.82 + 0.3 * n1) * (0.92 + 0.16 * vnoise(xy * 3.1));
    alb = mix(alb, grv, 0.8);
  } else if (id == 13.0) {
    // inside the forest polygon: under the canopy it is dark forest floor; where the canopy is carved out
    // (tracks, pads, power corridor, clearings) it is grass, scrub and bare soil instead
    float canopy = texture2D(uCanopy, vec2(xy.x + uCore, uCore - xy.y) / (2.0 * uCore)).r;
    canopy *= 1.0 - smoothstep(0.84, 0.94, texture2D(uOpen, vec2(xy.x + uOpenExt, uOpenExt - xy.y) / (2.0 * uOpenExt)).r);
    // clearings keep the Sentinel-2 tones (clear-cuts, young plantings, grass) with grass / scrub / soil texture on top
    vec3 clearing = mix(alb, mix(vec3(0.075, 0.11, 0.04), vec3(0.14, 0.13, 0.085), smoothstep(0.45, 0.8, n2)), 0.35) * mix(1.0, 0.8 + 0.4 * tuft, nearD);   // tufts only where resolved
    alb = mix(clearing, alb * vec3(0.75, 0.72, 0.65), smoothstep(0.35, 0.7, canopy));
    gBump = tuft * nearD;
  }
  if (id == 10.0) alb = min(alb, vec3(0.3));          // quarry sand: bright, but not snow
  diffuseColor.rgb = clamp(alb, 0.0, 1.0);
`;

export function groundMaterial(classTex, core, wide) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.93, metalness: 0, color: 0xffffff });
  return patch(mat, {
    key: 'ground',
    uniforms: { uCls: { value: classTex }, uCore: { value: core }, uWide: { value: wide }, uCanopy: FOREST_TEX.canopy, uOpen: FOREST_TEX.open, uOpenExt: FOREST_TEX.openExt },
    frag: {
      pars: GROUND_FRAG_PARS + 'float gBump = 0.0;\n',
      map: GROUND_MAP,
      afterLights: 'reflectedLight.directSpecular *= 0.35;',        // fields and meadows: only a faint forward sheen
      // bump from the close-range detail (surface-gradient method)
      normal: /* glsl */ `
        if (gBump > 0.001) {
          vec3 sx = dFdx(-vViewPosition), sy = dFdy(-vViewPosition);
          float hx = dFdx(gBump), hy = dFdy(gBump);
          vec3 r1 = cross(sy, normal), r2 = cross(normal, sx);
          float det = dot(sx, r1);
          vec3 grad = sign(det) * (hx * r1 + hy * r2) * 0.12;
          normal = normalize(abs(det) * normal - grad);
        }`,
    },
  });
}

function gridMesh(x0, y0, step, n, heightFn, skirt, cut) {
  // (n+1)^2 vertices; `cut(cx, cy)` drops cells
  const nv = (n + 1) * (n + 1);
  const pos = new Float32Array(nv * 3);
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const x = x0 + i * step, y = y0 - j * step, k = (j * (n + 1) + i) * 3;
    pos[k] = x; pos[k + 1] = heightFn(x, y); pos[k + 2] = -y;
  }
  const idx = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    if (cut && cut(x0 + (i + 0.5) * step, y0 - (j + 0.5) * step)) continue;
    const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
    // alternate diagonals for a less directional look
    if ((i + j) & 1) idx.push(a, c, b, b, c, d); else idx.push(a, c, d, a, d, b);
  }
  let positions = pos;
  if (skirt) {
    // extra ring of vertices below the boundary
    const border = [];
    for (let i = 0; i <= n; i++) border.push(i);
    for (let j = 1; j <= n; j++) border.push(j * (n + 1) + n);
    for (let i = n - 1; i >= 0; i--) border.push(n * (n + 1) + i);
    for (let j = n - 1; j >= 1; j--) border.push(j * (n + 1));
    const ext = new Float32Array(pos.length + border.length * 3);
    ext.set(pos);
    border.forEach((v, q) => { const k = nv + q; ext[k * 3] = pos[v * 3]; ext[k * 3 + 1] = pos[v * 3 + 1] - skirt; ext[k * 3 + 2] = pos[v * 3 + 2]; });
    for (let q = 0; q < border.length; q++) {
      const a = border[q], b = border[(q + 1) % border.length], a2 = nv + q, b2 = nv + ((q + 1) % border.length);
      idx.push(a, a2, b, b, a2, b2);
    }
    positions = ext;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setIndex(positions.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  return g;
}

function smoothNormals(g, heightFn, step) {
  // analytic normals from the height function (smoother than face normals, identical across the seam)
  const p = g.attributes.position.array, n = new Float32Array(p.length), e = step;
  for (let k = 0; k < p.length; k += 3) {
    const x = p[k], y = -p[k + 2];
    const dx = heightFn(x + e, y) - heightFn(x - e, y), dy = heightFn(x, y + e) - heightFn(x, y - e);
    // world: x east, y up, z = -north
    let nx = -dx / (2 * e), ny = 1, nz = dy / (2 * e);
    const l = Math.hypot(nx, ny, nz); n[k] = nx / l; n[k + 1] = ny / l; n[k + 2] = nz / l;
  }
  g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
}

export function makeTerrain(data, ground, opts) {
  const H = data.header, CORE = H.core, WIDE = H.wide;
  const step = opts.step;                 // 21.3 (desktop) or 32 (mobile)
  const n = Math.round((2 * CORE) / step);
  // grid nodes within 20 m of a tower sit exactly at the tower foot (the foundation area is level)
  const hNode = (x, y) => {
    for (const t of H.turbines) if (Math.abs(x - t.x) < 20 && Math.abs(y - t.y) < 20 && Math.hypot(x - t.x, y - t.y) < 20) return t.ground;
    return ground.height(x, y);
  };
  // fine patches (≈ 3 m) over each levelled crane pad with its ramps: the 21 / 32 m grid cannot follow them. Patch edges
  // lie on core grid lines; the core cells inside are cut out.
  // Also over lakes and ponds: the grid cannot hold their shores (small ponds vanished under it, sheets overhung the banks).
  let rects = [];
  const snap = (v, f) => Math.max(-CORE, Math.min(CORE, f((v + CORE) / step) * step - CORE));
  for (const e of ground.edits) {
    const m = e.kind === 'flat' ? e.ramp + 12 : 14;
    if (e.bb[2] < -CORE || e.bb[0] > CORE || e.bb[3] < -CORE || e.bb[1] > CORE) continue;
    rects.push({ x0: snap(e.bb[0] - m, Math.floor), x1: snap(e.bb[2] + m, Math.ceil), y0: snap(e.bb[1] - m, Math.floor), y1: snap(e.bb[3] + m, Math.ceil) });
  }
  // merge overlapping rectangles (patches must not overlap)
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < rects.length && !merged; i++) for (let j = i + 1; j < rects.length; j++) {
      const A = rects[i], B = rects[j];
      if (A.x0 < B.x1 && B.x0 < A.x1 && A.y0 < B.y1 && B.y0 < A.y1) {
        rects[i] = { x0: Math.min(A.x0, B.x0), x1: Math.max(A.x1, B.x1), y0: Math.min(A.y0, B.y0), y1: Math.max(A.y1, B.y1) };
        rects.splice(j, 1); merged = true; break;
      }
    }
  }
  rects = rects.filter((r) => r.x1 > r.x0 && r.y1 > r.y0);
  const inRect = (x, y) => { for (const r of rects) if (x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1) return r; return null; };
  const coreGeo = gridMesh(-CORE, CORE, step, n, hNode, 25, (cx, cy) => !!inRect(cx, cy));
  smoothNormals(coreGeo, ground.height, 6);
  const wstep = 128, wn = Math.round((2 * WIDE) / wstep);
  const wideGeo = gridMesh(-WIDE, WIDE, wstep, wn, ground.height, 60,
    (cx, cy) => Math.abs(cx) < CORE && Math.abs(cy) < CORE);
  smoothNormals(wideGeo, ground.height, 40);
  const cls = makeClassMap(data, opts.classSize);
  const mat = groundMaterial(cls.tex, CORE, WIDE);
  const coreMesh = new THREE.Mesh(coreGeo, mat), wideMesh = new THREE.Mesh(wideGeo, mat);
  coreMesh.receiveShadow = wideMesh.receiveShadow = true;
  coreMesh.name = 'terrain-core'; wideMesh.name = 'terrain-wide';
  // height of a rendered grid (same diagonal split as gridMesh) — for draping roads and placing trees
  const tri = (P, N1, i, j, u, v) => {
    const ha = P[(j * N1 + i) * 3 + 1], hb = P[(j * N1 + i + 1) * 3 + 1], hc = P[((j + 1) * N1 + i) * 3 + 1], hd = P[((j + 1) * N1 + i + 1) * 3 + 1];
    if ((i + j) & 1) return u + v <= 1 ? ha + (hb - ha) * u + (hc - ha) * v : hd + (hc - hd) * (1 - u) + (hb - hd) * (1 - v);   // split b–c
    return u >= v ? ha + (hb - ha) * u + (hd - hb) * v : ha + (hc - ha) * v + (hd - hc) * u;                                  // split a–d
  };
  const P = coreGeo.attributes.position.array, N1 = n + 1;
  const coreH = (x, y) => {
    const fx = (x + CORE) / step, fy = (CORE - y) / step;
    const i = Math.floor(fx), j = Math.floor(fy);
    if (i < 0 || j < 0 || i >= n || j >= n) return ground.height(x, y);
    return tri(P, N1, i, j, fx - i, fy - j);
  };
  // patches: interior vertices on the exact terrain, border vertices on the core mesh (watertight seam, no skirt)
  const pp = [], pi = [];
  for (const r of rects) {
    // 3 m for ponds, 4 m for the pads, 6–8 m over the big lakes (their beds are under water; the shore band is what counts)
    const area = (r.x1 - r.x0) * (r.y1 - r.y0), ps = (area > 300000 ? 8 : area > 150000 ? 6 : area > 10000 ? 4 : 3) * (step > 25 ? 1.5 : 1);
    // spacing = core step / k, so every core node on the patch border is a patch vertex (watertight seam)
    const k = Math.max(1, Math.round(step / ps));
    r.nx = Math.round((r.x1 - r.x0) / step) * k; r.ny = Math.round((r.y1 - r.y0) / step) * k;
    r.sx = (r.x1 - r.x0) / r.nx; r.sy = (r.y1 - r.y0) / r.ny; r.off = pp.length / 3;
    for (let j = 0; j <= r.ny; j++) for (let i = 0; i <= r.nx; i++) {
      const x = r.x0 + i * r.sx, y = r.y1 - j * r.sy, edge = i === 0 || j === 0 || i === r.nx || j === r.ny;
      pp.push(x, edge ? coreH(x, y) : ground.height(x, y), -y);
    }
    const W = r.nx + 1;
    for (let j = 0; j < r.ny; j++) for (let i = 0; i < r.nx; i++) {
      const a = r.off + j * W + i, b = a + 1, c = a + W, d = c + 1;
      if ((i + j) & 1) pi.push(a, c, b, b, c, d); else pi.push(a, c, d, a, d, b);
    }
  }
  const patchGeo = new THREE.BufferGeometry();
  patchGeo.setAttribute('position', new THREE.Float32BufferAttribute(pp, 3));
  patchGeo.setIndex(pp.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(pi, 1) : new THREE.Uint16BufferAttribute(pi, 1));
  // normals from the patch grid itself (central differences; one-sided at the border)
  {
    const pn = new Float32Array(pp.length);
    for (const r of rects) {
      const W = r.nx + 1, H = (i, j) => pp[(r.off + j * W + i) * 3 + 1];
      for (let j = 0; j <= r.ny; j++) for (let i = 0; i <= r.nx; i++) {
        const i0 = Math.max(0, i - 1), i1 = Math.min(r.nx, i + 1), j0 = Math.max(0, j - 1), j1 = Math.min(r.ny, j + 1);
        const gx = (H(i1, j) - H(i0, j)) / ((i1 - i0) * r.sx), gy = (H(i, j0) - H(i, j1)) / ((j1 - j0) * r.sy);
        const l = Math.hypot(gx, 1, gy), k = (r.off + j * W + i) * 3;
        pn[k] = -gx / l; pn[k + 1] = 1 / l; pn[k + 2] = gy / l;
      }
    }
    patchGeo.setAttribute('normal', new THREE.BufferAttribute(pn, 3));
  }
  const patchMesh = new THREE.Mesh(patchGeo, mat); patchMesh.receiveShadow = true; patchMesh.name = 'terrain-pads';
  coreMesh.add(patchMesh);
  const PP = patchGeo.attributes.position.array;
  const meshH = (x, y) => {
    const r = inRect(x, y);
    if (!r) return coreH(x, y);
    const fx = (x - r.x0) / r.sx, fy = (r.y1 - y) / r.sy;
    const i = Math.min(r.nx - 1, Math.floor(fx)), j = Math.min(r.ny - 1, Math.floor(fy));
    return tri(PP.subarray(r.off * 3), r.nx + 1, i, j, fx - i, fy - j);
  };
  return { coreMesh, wideMesh, material: mat, classMap: cls, meshH };
}

export function loadImageTexture(bytes, mime) {
  return createImageBitmap(new Blob([bytes], { type: mime }), { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
    .then((bmp) => {
      const t = new THREE.Texture(bmp);
      t.flipY = false;
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.needsUpdate = true;
      return t;
    });
}
export { U };

// ------------------------------------------------------------------------------------------------ far ring (±64 km)
// 500 m terrain beyond the scene with a procedural field / forest mosaic and Lake Constance; drawn in its own pass.
export function makeFarTerrain(data) {
  const G = data.demFar, WIDE = data.header.wide, LAKE = data.header.sections.demFar.lake;
  const { n, res, ext, z } = G;
  const h = (x, y) => {
    const fx = (x + ext) / res, fy = (ext - y) / res;
    const ix = Math.max(0, Math.min(n - 2, Math.floor(fx))), iy = Math.max(0, Math.min(n - 2, Math.floor(fy)));
    const tx = fx - ix, ty = fy - iy, i = iy * n + ix;
    return (z[i] * (1 - tx) + z[i + 1] * tx) * (1 - ty) + (z[i + n] * (1 - tx) + z[i + n + 1] * tx) * ty;
  };
  const inner = WIDE - 300;
  // radial grid: denser near the scene, coarser outwards
  const pos = [], idx = [];
  const rings = [];
  for (let r = inner, k = 0; r <= ext; k++) { rings.push(r); r += Math.max(250, (r - inner) * 0.06 + 250); }
  rings.push(ext);
  const NA = 256;
  for (let j = 0; j < rings.length; j++) {
    for (let i = 0; i < NA; i++) {
      const a = (i / NA) * Math.PI * 2;
      // square-ish inner boundary (the scene is square), round outside
      const c = Math.cos(a), s = Math.sin(a), sq = 1 / Math.max(Math.abs(c), Math.abs(s));
      const t = Math.min(1, (rings[j] - inner) / 12000);
      const rr = rings[j] * (sq * (1 - t) + t);
      const x = c * rr, y = s * rr;
      pos.push(x, Math.max(LAKE, h(x, y)) - (j === 0 ? 30 : 0), -y);
    }
  }
  for (let j = 0; j + 1 < rings.length; j++) for (let i = 0; i < NA; i++) {
    const a = j * NA + i, b = j * NA + ((i + 1) % NA), c = a + NA, d = b + NA;
    idx.push(a, c, b, b, c, d);            // counter-clockwise seen from above (front faces up)
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // ESA WorldCover fractions (forest, built-up) at 1 km → RG texture
  const fc = data.farCover, fcd = new Uint8Array(fc.n * fc.n * 4);
  for (let i = 0; i < fc.n * fc.n; i++) { const v = fc.g[i]; fcd[i * 4] = ((v >> 4) * 17); fcd[i * 4 + 1] = ((v & 15) * 17); fcd[i * 4 + 3] = 255; }
  const fcTex = new THREE.DataTexture(fcd, fc.n, fc.n, THREE.RGBAFormat);
  fcTex.magFilter = fcTex.minFilter = THREE.LinearFilter; fcTex.needsUpdate = true;
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0, color: 0xffffff });
  patch(mat, {
    key: 'far',
    uniforms: { uLake: { value: LAKE }, uCover: { value: fcTex }, uFarExt: { value: fc.ext } },
    frag: {
      pars: 'uniform float uLake;\nuniform sampler2D uCover;\nuniform float uFarExt;',
      afterLights: 'reflectedLight.directSpecular *= 0.35;',
      map: /* glsl */ `
        vec2 xy = vec2(vWP.x, -vWP.z);
        vec2 cuv = vec2(xy.x + uFarExt, uFarExt - xy.y) / (2.0 * uFarExt);
        vec2 cov = texture2D(uCover, cuv).rg;
        float n = fbm4(xy * 0.0016 + 3.0);
        float forest = smoothstep(0.45, 0.62, cov.r + (n - 0.5) * 0.5);
        vec3 field = mix(vec3(0.11, 0.115, 0.055), vec3(0.15, 0.13, 0.08), vnoise(xy * 0.0035));
        vec3 alb = mix(field, vec3(0.035, 0.062, 0.03), forest);
        alb = mix(alb, vec3(0.16, 0.13, 0.12), smoothstep(0.15, 0.6, cov.g) * 0.8);
        float lake = step(vWP.y, uLake + 0.6);
        alb = mix(alb, vec3(0.02, 0.035, 0.05), lake);
        diffuseColor.rgb = alb;
        farLake = lake;`,
      beforeFog: /* glsl */ `
        { vec3 V = normalize(vWP - cameraPosition); vec3 R = reflect(V, vec3(0.0, 1.0, 0.0));
          float fres = 0.02 + 0.98 * pow(1.0 - max(-V.y, 0.0), 5.0);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, skyCol(normalize(vec3(R.x, max(R.y, 0.01), R.z))), fres * farLake * 0.9); }`,
    },
  });
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => { prev(sh, r); sh.fragmentShader = sh.fragmentShader.replace('uniform float uLake;', 'uniform float uLake;\nfloat farLake = 0.0;'); };
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = 'terrain-far'; mesh.frustumCulled = false;
  return mesh;
}
