// The whole route on a 3D map: relief from AWS Terrain Tiles, natural colour from the ESA WorldCover Sentinel-2
// composite, the route coloured by the survey's verdict, context lines, a convoy marker that drives it.
import * as THREE from 'three';

export const EXAG = 3.0;                      // relief exaggeration of the country-scale map (stated in the UI)
const SEV_COL = [[0.17, 0.72, 0.45], [0.95, 0.68, 0.10], [0.95, 0.27, 0.20]];

export function makeMap(R, mapImg, outerImg) {
  const H = R.header.map;
  const scene = new THREE.Scene();
  const D = R.mapDem, S = R.header.sections.mapDem;
  // height grid rows run north → south
  const hgt = (x, y) => {
    let fx = (x - H.x0) / S.step, fy = (H.y1 - y) / S.step;
    fx = Math.max(0, Math.min(D.nx - 1.001, fx)); fy = Math.max(0, Math.min(D.ny - 1.001, fy));
    const ix = fx | 0, iy = fy | 0, tx = fx - ix, ty = fy - iy, i = iy * D.nx + ix, z = D.z;
    return Math.max(-2, (z[i] * (1 - tx) + z[i + 1] * tx) * (1 - ty) + (z[i + D.nx] * (1 - tx) + z[i + D.nx + 1] * tx) * ty) * EXAG;
  };

  // ---- terrain: the sharp corridor over a low-resolution surround that runs on to the horizon
  const U = {
    uSun: { value: new THREE.Vector3(-0.45, 0.75, 0.48).normalize() },
    uHaze: { value: new THREE.Color(0.62, 0.71, 0.82) }, uHazeK: { value: 1 / 2600000 }, uDim: { value: 0 },
  };
  const texOf = (img) => { const t = new THREE.Texture(img); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.needsUpdate = true; return t; };
  const terrainMesh = (G, step, E, img, inner) => {
    const nx = G.nx, ny = G.ny;
    const pos = new Float32Array(nx * ny * 3), uv = new Float32Array(nx * ny * 2);
    const W = E.x1 - E.x0, Hh = E.y1 - E.y0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i, x = E.x0 + i * step, y = E.y1 - j * step;
      pos[3 * k] = x; pos[3 * k + 1] = Math.max(-2, G.z[k]) * EXAG + (inner ? 0 : -400); pos[3 * k + 2] = -y;
      uv[2 * k] = (x - E.x0) / W; uv[2 * k + 1] = (y - E.y0) / Hh;
    }
    const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
    let o = 0;
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx[o++] = a; idx[o++] = c; idx[o++] = b; idx[o++] = b; idx[o++] = c; idx[o++] = d;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...U, uTex: { value: texOf(img) }, uInner: { value: inner ? 1 : 0 } },
      transparent: inner, depthWrite: true,
      vertexShader: /* glsl */ `
        varying vec2 vUv; varying vec3 vN; varying vec3 vWP;
        void main() { vUv = uv; vN = normal; vec4 w = modelMatrix * vec4(position, 1.0); vWP = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uTex; uniform vec3 uSun; uniform vec3 uHaze; uniform float uHazeK; uniform float uDim; uniform float uInner;
        varying vec2 vUv; varying vec3 vN; varying vec3 vWP;
        void main() {
          vec3 c = texture2D(uTex, vUv).rgb;
          // relief is shaded in the picture already; the mesh adds a soft second light on the exaggerated slopes
          c *= 0.86 + 0.22 * max(dot(normalize(vN), uSun), 0.0);
          float d = distance(vWP, cameraPosition);
          c = mix(c, uHaze, (1.0 - exp(-d * uHazeK)) * 0.7);
          c *= 1.0 - 0.45 * uDim;
          vec2 e = min(vUv, 1.0 - vUv);
          float a = uInner > 0.5 ? smoothstep(0.0, 0.05, min(e.x, e.y)) : 1.0;
          if (uInner < 0.5) c = mix(uHaze * 0.95, c, smoothstep(0.0, 0.12, min(e.x, e.y)));
          gl_FragColor = vec4(c, a);
          #include <colorspace_fragment>
        }`,
    });
    const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; m.renderOrder = inner ? 1 : 0;
    return m;
  };
  const OE = H.outer, OS = R.header.sections.outerDem;
  const outerMesh = terrainMesh(R.outerDem, OS.step, OE, outerImg, false);
  const terrain = terrainMesh(D, S.step, H, mapImg, true);
  scene.add(outerMesh, terrain);

  // ---- sky
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { uHaze: U.uHaze },
    vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }',
    fragmentShader: /* glsl */ `uniform vec3 uHaze; varying vec3 vD;
      void main(){ float h = clamp(vD.y, -0.2, 1.0); vec3 top = vec3(0.16, 0.33, 0.62), hz = uHaze * 1.04;
        vec3 c = mix(hz, top, pow(max(h, 0.0), 0.55)); if (h < 0.0) c = hz * 0.9;
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), skyMat);
  sky.scale.setScalar(4e6); sky.frustumCulled = false; sky.renderOrder = -1;
  scene.add(sky);

  // ---- context lines
  const lineGroup = new THREE.Group(); scene.add(lineGroup);
  const lift = 600;
  const mkLines = (layer, color, opacity, dashed = null) => {
    const v = [];
    for (const f of layer) {
      if (dashed !== null && f.a[0] !== dashed) continue;
      for (const r of f.rings) for (let k = 0; k + 3 < r.length; k += 2) {
        v.push(r[k], hgt(r[k], r[k + 1]) + lift, -r[k + 1], r[k + 2], hgt(r[k + 2], r[k + 3]) + lift, -r[k + 3]);
      }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    let m;
    if (dashed !== null) { m = new THREE.LineDashedMaterial({ color, transparent: true, opacity, dashSize: 6000, gapSize: 4000, depthTest: false }); }
    else m = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false });
    const L = new THREE.LineSegments(g, m);
    if (dashed !== null) L.computeLineDistances();
    L.frustumCulled = false; L.renderOrder = 2;
    lineGroup.add(L);
    return L;
  };
  mkLines(R.rivers, 0x8fc7ff, 0.55);
  mkLines(R.motorways, 0xffffff, 0.33);
  mkLines(R.borders, 0xfff1d6, 0.75, 0);
  mkLines(R.borders, 0xfff1d6, 0.28, 1);

  // ---- route: screen-space ribbon coloured by the survey verdict
  const rt = R.route, km = R.km, n = km.length;
  const sevTex = new THREE.DataTexture(new Uint8Array(R.sev.length * 4), R.sev.length, 1, THREE.RGBAFormat);
  const sevD = new Uint8Array(R.sev.length);
  for (let i = 0; i < R.sev.length; i++) { let v = 0; for (let k = -4; k <= 4; k++) v = Math.max(v, R.sev[Math.max(0, Math.min(R.sev.length - 1, i + k))] || 0); sevD[i] = v; }
  for (let i = 0; i < R.sev.length; i++) { const c = SEV_COL[sevD[i]]; sevTex.image.data.set([c[0] * 255, c[1] * 255, c[2] * 255, 255], i * 4); }
  sevTex.needsUpdate = true; sevTex.magFilter = THREE.NearestFilter; sevTex.minFilter = THREE.NearestFilter;
  const P = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const x = rt[2 * i], y = rt[2 * i + 1]; P[3 * i] = x; P[3 * i + 1] = hgt(x, y) + lift * 1.5; P[3 * i + 2] = -y; }
  const segN = n - 1;
  const a0 = new Float32Array(segN * 4 * 3), a1 = new Float32Array(segN * 4 * 3), side = new Float32Array(segN * 4), end = new Float32Array(segN * 4), akm = new Float32Array(segN * 4);
  const ridx = new Uint32Array(segN * 6);
  for (let s = 0; s < segN; s++) {
    for (let q = 0; q < 4; q++) {
      const v = s * 4 + q;
      a0.set(P.subarray(3 * s, 3 * s + 3), v * 3); a1.set(P.subarray(3 * s + 3, 3 * s + 6), v * 3);
      side[v] = q & 1 ? 1 : -1; end[v] = q < 2 ? 0 : 1; akm[v] = q < 2 ? km[s] : km[s + 1];
    }
    const b = s * 4; ridx.set([b, b + 1, b + 2, b + 1, b + 3, b + 2], s * 6);
  }
  const rg = new THREE.BufferGeometry();
  rg.setAttribute('position', new THREE.BufferAttribute(a0, 3)); rg.setAttribute('pB', new THREE.BufferAttribute(a1, 3));
  rg.setAttribute('side', new THREE.BufferAttribute(side, 1)); rg.setAttribute('endf', new THREE.BufferAttribute(end, 1)); rg.setAttribute('km', new THREE.BufferAttribute(akm, 1));
  rg.setIndex(new THREE.BufferAttribute(ridx, 1));
  const RU = { uRes: { value: new THREE.Vector2(1, 1) }, uW: { value: 4.0 }, uSev: { value: sevTex }, uKmMax: { value: R.header.km }, uProg: { value: -1 }, uGlow: { value: 0 }, uBin: { value: R.header.sections.routeSev.bin / 1000 } };
  const routeMat = (glow) => new THREE.ShaderMaterial({
    uniforms: { ...RU, uW: { value: glow ? 13 : 5.2 }, uGlow: { value: glow ? 1 : 0 } },
    transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,   // ribbons wind one way per direction
    vertexShader: /* glsl */ `
      attribute vec3 pB; attribute float side; attribute float endf; attribute float km;
      uniform vec2 uRes; uniform float uW; varying float vKm; varying float vSide;
      void main() {
        vec4 A = projectionMatrix * viewMatrix * vec4(position, 1.0), B = projectionMatrix * viewMatrix * vec4(pB, 1.0);
        vec2 sa = A.xy / A.w * uRes, sb = B.xy / B.w * uRes;
        vec2 d = normalize(sb - sa + 1e-6), nrm = vec2(-d.y, d.x);
        vec4 P = endf < 0.5 ? A : B;
        P.xy += nrm * side * uW / uRes * P.w;
        vKm = km; vSide = side;
        gl_Position = P;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uSev; uniform float uKmMax; uniform float uProg; uniform float uGlow; uniform float uBin;
      varying float vKm; varying float vSide;
      void main() {
        vec3 c = texture2D(uSev, vec2(clamp(vKm / uBin / float(textureSize(uSev, 0).x), 0.0, 1.0), 0.5)).rgb;
        float done = uProg < 0.0 ? 1.0 : step(vKm, uProg);
        float edge = 1.0 - abs(vSide);
        float a;
        if (uGlow > 0.5) { a = 0.32 * edge * edge; c = mix(c, vec3(1.0), 0.15); }
        else { a = 1.0; c = mix(c * 0.55 + 0.25, c, done); c = mix(c, vec3(1.0), 0.25 * smoothstep(0.6, 1.0, edge)); if (edge < 0.3) c = vec3(0.04, 0.08, 0.10); a = mix(0.75, 1.0, smoothstep(0.0, 0.3, edge)); }
        a *= mix(0.55, 1.0, done);
        gl_FragColor = vec4(c, a);
        #include <colorspace_fragment>
      }`,
  });
  const glowMesh = new THREE.Mesh(rg, routeMat(true)); glowMesh.frustumCulled = false; glowMesh.renderOrder = 3;
  const lineMesh = new THREE.Mesh(rg, routeMat(false)); lineMesh.frustumCulled = false; lineMesh.renderOrder = 4;
  scene.add(glowMesh, lineMesh);

  // ---- convoy marker
  const marker = new THREE.Group();
  const dotTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.18, 'rgba(255,210,90,1)'); gr.addColorStop(0.45, 'rgba(255,160,40,.45)'); gr.addColorStop(1, 'rgba(255,140,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; })();
  const dot = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, depthTest: false, transparent: true, sizeAttenuation: false }));
  dot.scale.set(0.05, 0.05, 1); dot.renderOrder = 6; marker.add(dot);
  marker.visible = false;
  scene.add(marker);

  // position on the route at km k (map frame) + heading
  const kmAt = (k) => {
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (km[m] <= k) lo = m; else hi = m; }
    const t = km[hi] > km[lo] ? Math.min(1, Math.max(0, (k - km[lo]) / (km[hi] - km[lo]))) : 0;
    const x = rt[2 * lo] + (rt[2 * hi] - rt[2 * lo]) * t, y = rt[2 * lo + 1] + (rt[2 * hi + 1] - rt[2 * lo + 1]) * t;
    // heading from a point 3 km ahead (smooth for the chase camera)
    let j = hi; while (j < n - 1 && km[j] < k + 3) j++;
    let i0 = lo; while (i0 > 0 && km[i0] > k - 3) i0--;
    const hx = rt[2 * j] - rt[2 * i0], hy = rt[2 * j + 1] - rt[2 * i0 + 1];
    return { x, y, h: hgt(x, y), az: (Math.atan2(hx, hy) * 180) / Math.PI };
  };
  return {
    scene, terrain, outerMesh, U, RU, hgt, kmAt, marker, lineMesh, glowMesh, sky,
    setRes(w, h) { RU.uRes.value.set(w / 2, h / 2); lineMesh.material.uniforms.uRes.value.set(w / 2, h / 2); glowMesh.material.uniforms.uRes.value.set(w / 2, h / 2); },
    setProgress(k) { lineMesh.material.uniforms.uProg.value = k; glowMesh.material.uniforms.uProg.value = k; },
    surface: (x, y) => hgt(x, y),
  };
}
