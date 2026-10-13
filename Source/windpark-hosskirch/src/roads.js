// Roads, railway and streams as ribbons draped on the terrain. Widths from OSM classes (or width tags), surfaces from
// OSM (asphalt / gravel / unpaved), German rural markings on primary–tertiary roads (edge lines, 6 m dash / 12 m gap).
import * as THREE from 'three';
import { patch } from './env.js';

const SURF_COL = {
  1: [0.075, 0.078, 0.082],   // asphalt
  2: [0.13, 0.12, 0.115],     // paving stones
  3: [0.30, 0.28, 0.235],     // gravel / compacted
  4: [0.19, 0.16, 0.115],     // unpaved
  5: [0.085, 0.115, 0.05],    // grass
};

let SEG = 6;
function resample(c, maxSeg) {
  const out = [c[0], c[1]];
  for (let i = 2; i < c.length; i += 2) {
    const ax = c[i - 2], ay = c[i - 1], bx = c[i], by = c[i + 1], L = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.ceil(L / maxSeg));
    for (let k = 1; k <= n; k++) out.push(ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n);
  }
  return out;
}

// Append a ribbon to the buffers. h(x, y) gives the surface height.
function ribbon(B, c, width, h, info) {
  const p = resample(c, SEG);
  const n = p.length / 2;
  if (n < 2) return;
  const hw = width / 2;
  let dist = 0;
  const base = B.pos.length / 3;
  for (let i = 0; i < n; i++) {
    const x = p[2 * i], y = p[2 * i + 1];
    let tx, ty;
    if (i === 0) { tx = p[2] - x; ty = p[3] - y; }
    else if (i === n - 1) { tx = x - p[2 * i - 2]; ty = y - p[2 * i - 1]; }
    else {
      let ax = x - p[2 * i - 2], ay = y - p[2 * i - 1], bx = p[2 * i + 2] - x, by = p[2 * i + 3] - y;
      const la = Math.hypot(ax, ay) || 1, lb = Math.hypot(bx, by) || 1; ax /= la; ay /= la; bx /= lb; by /= lb;
      tx = ax + bx; ty = ay + by;
    }
    const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    let nx = -ty, ny = tx, miter = 1;
    if (i > 0 && i < n - 1) {
      let ax = x - p[2 * i - 2], ay = y - p[2 * i - 1]; const la = Math.hypot(ax, ay) || 1; ax /= la; ay /= la;
      miter = Math.min(2, 1 / Math.max(0.5, Math.abs(-ay * nx + ax * ny)));
    }
    if (i > 0) dist += Math.hypot(x - p[2 * i - 2], y - p[2 * i - 1]);
    for (const s of [-1, 1]) {
      const vx = x + nx * hw * miter * s, vy = y + ny * hw * miter * s;
      B.pos.push(vx, h(vx, vy, x, y), -vy);
      B.uv.push(s, dist);
      B.info.push(info[0], width, info[1]);
      B.col.push(...info[2]);
    }
    if (i > 0) {
      const a = base + (i - 1) * 2, b = a + 1, cc = a + 2, d = a + 3;
      B.idx.push(a, cc, b, b, cc, d);
    }
  }
}

function buffers() { return { pos: [], uv: [], info: [], col: [], idx: [] }; }
function toGeometry(B) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(B.pos, 3));
  const nor = new Float32Array(B.pos.length); for (let i = 1; i < nor.length; i += 3) nor[i] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('aUV', new THREE.Float32BufferAttribute(B.uv, 2));
  g.setAttribute('aInfo', new THREE.Float32BufferAttribute(B.info, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(B.col, 3));
  g.setIndex(B.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(B.idx, 1) : new THREE.Uint16BufferAttribute(B.idx, 1));
  g.computeBoundingSphere();
  return g;
}

const ROAD_FRAG = /* glsl */ `
  float u = vUV.x, v = vUV.y, cls = vInfo.x, wid = vInfo.y, surf = vInfo.z;
  float det = 1.0 - smoothstep(150.0, 1400.0, distance(vWP, cameraPosition));
  vec3 c = diffuseColor.rgb;
  vec2 xy = vec2(vWP.x, -vWP.z);
  float n1 = vnoise(xy * 1.7), n2 = vnoise(xy * 0.3);
  c *= mix(1.0, 0.86 + 0.28 * n1, det) * (0.93 + 0.14 * n2);
  float fw = fwidth(u) * 1.2 + 1e-4;
  if (cls < 1.5) { }
  if (surf < 1.5 && cls >= 1.5 && cls <= 4.5 && wid > 5.2) {
    // edge lines 0.12 m, 0.25 m inside the edge; centre dashes 6 m / 12 m
    float hw = 0.5 * wid, eu = 1.0 - (0.37 / hw), lw = 0.06 / hw;
    float edge = 1.0 - smoothstep(lw - fw, lw + fw, abs(abs(u) - eu));
    float dash = step(mod(v, 18.0), 6.0) * (1.0 - smoothstep(lw - fw, lw + fw, abs(u)));
    c = mix(c, vec3(0.62, 0.62, 0.60), max(edge, dash) * mix(0.35, 1.0, det));
  }
  if (surf > 3.5 && surf < 4.5 || (cls > 7.5 && cls < 8.5 && surf > 2.5 && surf < 3.5 && wid < 3.6)) {
    // two wheel ruts with a grassy centre strip
    float centre = 1.0 - smoothstep(0.18 - fw, 0.28 + fw, abs(u));
    c = mix(c, vec3(0.07, 0.10, 0.045) * (0.8 + 0.4 * n1), centre * 0.85);
  }
  // soft shoulders
  c = mix(c, c * 0.8, smoothstep(0.8, 1.0, abs(u)));
  diffuseColor.rgb = c;
`;

export function makeRoads(data, ground, meshH, step) {
  const B = buffers();
  // drape on the rendered terrain triangles themselves (the smooth analytic surface floats above them on convex ground);
  // bridges keep their own straight decks
  const hRoad = (lift) => (x, y) => (meshH ? meshH(x, y) : ground.height(x, y)) + lift;
  SEG = step || 6;
  // lower classes first; each class slightly higher so junctions resolve
  const roads = data.roads.slice().sort((a, b) => b.a[0] - a.a[0]);
  for (const r of roads) {
    const [cls, surf, wdm, flags] = r.a;
    if (flags & 2) continue;                     // tunnels
    const w = Math.max(1.2, wdm / 10);
    const lift = 0.07 + (9 - cls) * 0.012;
    let h = hRoad(lift);
    if (flags & 1) {                             // bridges: straight deck between the end heights
      const c = r.rings[0], n = c.length / 2;
      const h0 = ground.height(c[0], c[1]), h1 = ground.height(c[2 * n - 2], c[2 * n - 1]);
      let L = 0; const acc = [0]; for (let i = 1; i < n; i++) { L += Math.hypot(c[2 * i] - c[2 * i - 2], c[2 * i + 1] - c[2 * i - 1]); acc.push(L); }
      h = (x, y, cx, cy) => {
        // project centre point onto the polyline parameter (nearest vertex is enough for short bridges)
        let best = 0, bd = Infinity;
        for (let i = 0; i < n; i++) { const d = (c[2 * i] - cx) ** 2 + (c[2 * i + 1] - cy) ** 2; if (d < bd) { bd = d; best = i; } }
        const t = L > 0 ? acc[best] / L : 0;
        return Math.max(h0 + (h1 - h0) * t, ground.height(cx, cy)) + 0.4;
      };
    }
    ribbon(B, r.rings[0], w, h, [cls, surf, SURF_COL[surf] || SURF_COL[1]]);
  }
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 });
  patch(mat, {
    key: 'road',
    vert: { pars: 'attribute vec2 aUV;\nattribute vec3 aInfo;\nvarying vec2 vUV;\nvarying vec3 vInfo;', main: 'vUV = aUV; vInfo = aInfo;' },
    frag: { pars: 'varying vec2 vUV;\nvarying vec3 vInfo;', map: '#include <map_fragment>\n' + ROAD_FRAG, afterLights: 'reflectedLight.indirectDiffuse *= mix(1.0, 0.6, uNight);' },
  });
  const mesh = new THREE.Mesh(toGeometry(B), mat);
  mesh.receiveShadow = true; mesh.renderOrder = 1; mesh.name = 'roads';

  // railway: ballast bed with two rails and sleepers
  const R = buffers();
  for (const r of data.rail) ribbon(R, r.rings[0], 4.2, hRoad(0.28), [0, 0, [0.19, 0.17, 0.15]]);
  const rmat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.1, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 });
  patch(rmat, {
    key: 'rail',
    vert: { pars: 'attribute vec2 aUV;\nvarying vec2 vUV;', main: 'vUV = aUV;' },
    frag: {
      pars: 'varying vec2 vUV;',
      map: /* glsl */ `#include <map_fragment>
        float u = vUV.x, v = vUV.y, fw = fwidth(u) * 1.2 + 1e-4;
        float sl = step(fract(v / 0.6), 0.4) * step(abs(u), 0.62);
        diffuseColor.rgb *= mix(1.0, 0.72, sl);
        float rail = 1.0 - smoothstep(0.035 - fw, 0.035 + fw, abs(abs(u) - 0.3414));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.28, 0.27, 0.26), rail);`,
    },
  });
  const rail = new THREE.Mesh(toGeometry(R), rmat);
  rail.receiveShadow = true; rail.renderOrder = 1; rail.name = 'rail';

  // streams and ditches
  const W = buffers();
  for (const w of data.waterway) ribbon(W, w.rings[0], Math.max(0.8, w.a[0] / 10), hRoad(0.05), [0, 0, [0.018, 0.03, 0.03]]);
  const wmat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.12, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -5 });
  patch(wmat, { key: 'stream' });
  const streams = new THREE.Mesh(toGeometry(W), wmat);
  streams.receiveShadow = true; streams.renderOrder = 1; streams.name = 'streams';
  return { roads: mesh, rail, streams };
}

// Crane pads (traced from Sentinel-2) and the tower foundations (Ø 25.5 m) as level gravel surfaces with crisp edges.
export function makePads(data) {
  // gravel crane pads (with a darker 1.5 m shoulder, truck tracks along the pad axis, a few puddles) and the concrete
  // round each tower; the terrain is levelled 5 m beyond the slab, so the slab edge sits on flat ground
  const H = data.header, pos = [], col = [], pad = [];
  const P = (r) => { const a = []; for (let i = 0; i < r.length; i += 2) a.push(new THREE.Vector2(r[i], r[i + 1])); return a; };
  const add = (outer, holes, level, c, pd) => {
    const o = P(outer), hs = holes.map(P), all = o.concat(...hs);
    let tris; try { tris = THREE.ShapeUtils.triangulateShape(o, hs); } catch (e) { return; }
    for (const t of tris) for (const k of [t[0], t[1], t[2]]) { pos.push(all[k].x, level, -all[k].y); col.push(...c); pad.push(...pd); }
  };
  for (const p of data.cranepads) {
    const level = H.base + p.a[0] / 10 + 0.12, ax = ((p.a[2] || 0) * Math.PI) / 180;
    const c0 = p.rings[0];
    let best = H.turbines[0], bd = Infinity;
    for (const t of H.turbines) { const d = Math.hypot(t.x - c0[0], t.y - c0[1]); if (d < bd) { bd = d; best = t; } }
    const pd = [best.x, best.y, -Math.cos(ax), Math.sin(ax)];
    if (p.rings.length >= 3) {
      add(p.rings[1], [p.rings[2]], level - 0.02, [0.3, 0.28, 0.24], pd);      // shoulder
      add(p.rings[2], [], level, [0.4, 0.37, 0.31], pd);
    } else add(p.rings[0], [], level, [0.4, 0.37, 0.31], pd);
  }
  for (const t of H.turbines) {
    const ring = []; for (let i = 0; i < 40; i++) { const a = (i / 40) * Math.PI * 2; ring.push(t.x + Math.cos(a) * 12.75, t.y + Math.sin(a) * 12.75); }
    add(ring, [], t.ground + 0.16, [0.36, 0.35, 0.32], [t.x, t.y, 0, 0]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aPad', new THREE.Float32BufferAttribute(pad, 4));
  const nor = new Float32Array(pos.length); for (let i = 1; i < nor.length; i += 3) nor[i] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.computeBoundingSphere();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6, side: THREE.DoubleSide });
  patch(mat, {
    key: 'pad',
    vert: { pars: 'attribute vec4 aPad;\nvarying vec4 vPad;', main: 'vPad = aPad;' },
    frag: {
      pars: 'varying vec4 vPad;\nfloat gPud = 0.0;',
      map: /* glsl */ `#include <map_fragment>
        vec2 xy = vec2(vWP.x, -vWP.z);
        vec2 pfx = dFdx(xy), pfy = dFdy(xy);
        float mpp = sqrt(abs(pfx.x * pfy.y - pfx.y * pfy.x)), nearD = 1.0 - smoothstep(0.05, 0.6, mpp);
        float n = vnoise(xy * 0.9) * 0.5 + vnoise(xy * 3.7) * 0.3 + vnoise(xy * 12.0) * 0.2;
        // truck tracks 2.2 m apart along the pad axis, beyond the foundation, patchy
        vec2 d = xy - vPad.xy;
        float s = dot(d, vPad.zw), along = dot(d, vec2(vPad.w, -vPad.z));
        float tr = (1.0 - smoothstep(0.3, 0.55, abs(abs(s) - 1.1))) * smoothstep(13.0, 16.0, abs(along)) * smoothstep(0.25, 0.55, vnoise(xy * 0.21 + 1.7)) * step(0.5, dot(vPad.zw, vPad.zw));
        // puddles in the ruts and hollows (≈ 8 %)
        gPud = smoothstep(0.74, 0.82, vnoise(xy * 0.11 + 3.0) * 0.8 + tr * 0.25) * step(0.5, dot(vPad.zw, vPad.zw));
        diffuseColor.rgb *= (0.84 + 0.3 * n) * (1.0 - 0.2 * tr) * mix(1.0, 0.85 + 0.3 * vnoise(xy * 25.0), nearD) * mix(1.0, 0.45, gPud);`,
      afterLights: /* glsl */ `
        { // the forest walls hide much of the blue sky and throw back green-brown light: shade is grey, not ice-blue
          float l = dot(reflectedLight.indirectDiffuse, vec3(0.3333));
          reflectedLight.indirectDiffuse = mix(vec3(l), reflectedLight.indirectDiffuse, 0.35) * vec3(1.02, 0.97, 0.86) * mix(1.0, 0.6, uNight) * mix(0.8, 1.0, smoothstep(0.0, 0.06, uSunDir.y)); }
        { vec3 R = reflect(normalize(vWP - cameraPosition), vec3(0.0, 1.0, 0.0));
          reflectedLight.indirectSpecular += skyCol(normalize(vec3(R.x, max(R.y, 0.02), R.z))) * 0.4 * gPud; }`,
    },
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.receiveShadow = true; mesh.renderOrder = 1; mesh.name = 'pads';
  return mesh;
}
