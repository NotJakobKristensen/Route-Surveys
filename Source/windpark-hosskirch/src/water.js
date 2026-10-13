// Lakes and ponds (OSM polygons) as flat surfaces at their shoreline level; colour tinted by the Sentinel-2 pixel
// (turquoise gravel-pit lakes stay turquoise), sky reflection with Fresnel, sun glint and small wind ripples.
import * as THREE from 'three';
import { patch } from './env.js';
import { FOREST_TEX } from './forest.js';

export function makeWater(data) {
  const H = data.header;
  const pos = [];
  for (const w of data.water) {
    const level = H.base + w.a[0] / 10;
    const toV = (c) => { const v = []; for (let i = 0; i < c.length; i += 2) v.push(new THREE.Vector2(c[i], c[i + 1])); return v; };
    const outer = toV(w.rings[0]), holes = w.rings.slice(1).map(toV);
    let tris;
    try { tris = THREE.ShapeUtils.triangulateShape(outer, holes); } catch (e) { continue; }
    const all = outer.concat(...holes);
    for (const t of tris) for (const k of [t[0], t[1], t[2]]) pos.push(all[k].x, level, -all[k].y);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const nor = new Float32Array(pos.length); for (let i = 1; i < nor.length; i += 3) nor[i] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.computeBoundingSphere();
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.06, metalness: 0, side: THREE.DoubleSide });
  patch(mat, {
    key: 'water',
    uniforms: { uCore: { value: H.core }, uCanopy: FOREST_TEX.canopy },
    frag: {
      pars: 'uniform sampler2D uSatCore;\nuniform float uGainInv;\nuniform float uCore;\nuniform sampler2D uCanopy;\nvec3 wN;',
      map: /* glsl */ `
        vec2 xy = vec2(vWP.x, -vWP.z);
        vec3 sat = texture2D(uSatCore, vec2(xy.x + uCore, uCore - xy.y) / (2.0 * uCore)).rgb * uGainInv;
        float sl = dot(sat, vec3(0.2126, 0.7152, 0.0722));
        diffuseColor.rgb = clamp(max(mix(vec3(sl), sat, 1.3) * 0.7, vec3(0.02, 0.05, 0.06)), 0.0, 1.0);   // never black from above
        float t = uTime * 0.5;
        float e = 0.6;
        float h0 = vnoise(xy * 0.9 + vec2(t, t * 0.7)) + 0.5 * vnoise(xy * 2.3 - vec2(t * 1.3, t * 0.4));
        float hx = vnoise((xy + vec2(e, 0.0)) * 0.9 + vec2(t, t * 0.7)) + 0.5 * vnoise((xy + vec2(e, 0.0)) * 2.3 - vec2(t * 1.3, t * 0.4));
        float hy = vnoise((xy + vec2(0.0, e)) * 0.9 + vec2(t, t * 0.7)) + 0.5 * vnoise((xy + vec2(0.0, e)) * 2.3 - vec2(t * 1.3, t * 0.4));
        float fade = 1.0 - smoothstep(60.0, 900.0, distance(vWP, cameraPosition));
        wN = normalize(vec3(-(hx - h0) * 0.12 * fade, 1.0, (hy - h0) * 0.12 * fade));`,
      beforeFog: /* glsl */ `
        {
          vec3 V = normalize(vWP - cameraPosition);
          vec3 R = reflect(V, wN);
          float fres = 0.02 + 0.98 * pow(1.0 - max(dot(-V, wN), 0.0), 5.0);
          vec3 refl = skyCol(normalize(vec3(R.x, max(R.y, 0.02), R.z)));
          // the far shore's tree line in the reflection: march the reflected ray over the canopy mask (≈ 27 m trees)
          {
            // marched with the unrippled reflection (ripples only jitter the height a little: no speckle)
            vec3 R0 = reflect(V, vec3(0.0, 1.0, 0.0));
            vec2 rd = normalize(R0.xz + vec2(1e-5, 0.0)), p0 = vec2(vWP.x, -vWP.z);
            float rise = R0.y / max(length(R0.xz), 1e-3), jit = (wN.x + wN.z) * 16.0, tree = 0.0;
            for (int k = 1; k <= 10; k++) {
              float dk = 15.0 + 65.0 * float(k - 1);                      // 15 … 600 m
              vec2 q = p0 + vec2(rd.x, -rd.y) * dk;
              float m = texture2D(uCanopy, vec2(q.x + uCore, uCore - q.y) / (2.0 * uCore)).r;
              tree = max(tree, smoothstep(0.3, 0.7, m) * (1.0 - smoothstep(20.0, 32.0, rise * dk + jit)));
            }
            refl = mix(refl, applyFog(vec3(0.03, 0.05, 0.035) * (0.4 + uSunCol.g), vWP), tree * 0.85);
          }
          float glint = pow(max(dot(R, uSunDir), 0.0), 350.0) * 6.0 * cloudShadow(vWP);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, refl, fres * 0.85) + uSunCol * glint;
        }`,
    },
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.receiveShadow = true; mesh.renderOrder = 1; mesh.name = 'water';
  return mesh;
}
