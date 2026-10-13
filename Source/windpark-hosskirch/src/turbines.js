// Vestas V172-7.2 MW on a Max Bögl hybrid tower, as built at Hoßkirch:
//  hub 175 m, rotor Ø 172 m (blade 84.35 m, hub radius 1.65 m), tip 261 m; concrete 0–103.09 m (Ø 9.427 → 4.527 m),
//  steel to the yaw bearing; tilt 6°, cone 6°; clockwise seen from the front; 9.5 rpm at rated power (range 4.3–12.1).
//  AVV 2020 day marking: blade tips red–grey–red 3 × 6 m, 2 m red nacelle band, 3 m red tower ring at 40 m.
//  Night marking: two "Feuer W, rot" on the cooler roof (≈ hub + 4 m), 1 s on / 0.5 off / 1 on / 1.5 off, synchronised to
//  UTC; steady red tower lights at half height (≈ 89.5 m).
import * as THREE from 'three';
import { patch } from './env.js';

const GREY = [0.60, 0.63, 0.61];          // RAL 7035 (linear)
const RED = [0.60, 0.012, 0.010];         // RAL 3020 (linear)
const CONC = [0.56, 0.58, 0.56];
export const V172 = { hub: 175, rotorR: 86, bladeLen: 84.35, hubR: 1.65, concreteTop: 103.09, concreteD0: 9.427, concreteD1: 4.527,
  steelD0: 4.5, steelD1: 2.665, towerTop: 172.8, tilt: 6, cone: 6, overhang: 7.2, ratedRpm: 9.5, minRpm: 4.3 };

function colorize(g, fn) {
  const p = g.attributes.position, n = p.count, c = new Float32Array(n * 3);
  if (g.index) throw new Error('non-indexed expected');
  for (let i = 0; i < n; i += 3) {
    const cy = (p.getY(i) + p.getY(i + 1) + p.getY(i + 2)) / 3, cx = (p.getX(i) + p.getX(i + 1) + p.getX(i + 2)) / 3, cz = (p.getZ(i) + p.getZ(i + 1) + p.getZ(i + 2)) / 3;
    const col = fn(cx, cy, cz);
    for (let k = 0; k < 3; k++) { c[(i + k) * 3] = col[0]; c[(i + k) * 3 + 1] = col[1]; c[(i + k) * 3 + 2] = col[2]; }
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}
function mergeNI(geos) {
  const list = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  for (const g of list) { if (!g.attributes.normal) g.computeVertexNormals(); }
  let n = 0; for (const g of list) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3);
    if (g.attributes.color) col.set(g.attributes.color.array, o * 3); else col.fill(0.6, o * 3, (o + g.attributes.position.count) * 3);
    o += g.attributes.position.count;
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  m.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  m.setAttribute('color', new THREE.BufferAttribute(col, 3));
  m.computeBoundingSphere();
  return m;
}

// ------------------------------------------------------------------------------------------------ tower
function towerGeometry(S) {
  const pts = [];
  const r0 = S.concreteD0 / 2, r1 = S.concreteD1 / 2, s0 = S.steelD0 / 2, s1 = S.steelD1 / 2;
  const cr = (h) => r0 + (r1 - r0) * (h / S.concreteTop);
  // concrete section with ring-joint stations every 3.8 m and the red ring at 40–43 m
  const hs = new Set([0, 40, 43, 89.1, 89.9, S.concreteTop]);
  for (let h = 3.8; h < S.concreteTop; h += 3.8) hs.add(+h.toFixed(2));
  const H = [...hs].sort((a, b) => a - b);
  const conc = new THREE.LatheGeometry(H.map((h) => new THREE.Vector2(cr(h), h)), 48).toNonIndexed();
  colorize(conc, (x, y) => (y > 40 && y < 43 ? RED : CONC));
  // transition piece
  const tp = new THREE.LatheGeometry([new THREE.Vector2(r1 + 0.05, S.concreteTop - 0.2), new THREE.Vector2(r1 + 0.05, S.concreteTop + 0.5),
    new THREE.Vector2(s0, S.concreteTop + 0.9)], 48).toNonIndexed();
  colorize(tp, () => [0.5, 0.52, 0.51]);
  const steel = new THREE.LatheGeometry([new THREE.Vector2(s0, S.concreteTop + 0.9), new THREE.Vector2((s0 + s1) / 2, (S.concreteTop + S.towerTop) / 2),
    new THREE.Vector2(s1, S.towerTop)], 48).toNonIndexed();
  colorize(steel, () => GREY);
  // foundation plinth and entrance door (door faces +x, rotated per turbine)
  const plinth = new THREE.CylinderGeometry(r0 + 0.8, r0 + 1.2, 2.8, 48, 1, false).toNonIndexed(); plinth.translate(0, -0.9, 0);   // 0.5 m above, 2.3 m below grade
  colorize(plinth, () => [0.42, 0.42, 0.40]);
  const door = new THREE.BoxGeometry(0.4, 2.4, 1.2).toNonIndexed(); door.translate(cr(1.6) - 0.05, 1.7, 0);
  colorize(door, () => [0.08, 0.09, 0.1]);
  const steps = new THREE.BoxGeometry(2.2, 0.9, 2.2).toNonIndexed(); steps.translate(r0 + 1.0, 0.3, 0);
  colorize(steps, () => [0.3, 0.3, 0.29]);
  // tower light fixtures at 89.5 m
  const fixtures = [];
  for (let k = 0; k < 4; k++) {
    const b = new THREE.BoxGeometry(0.5, 0.5, 0.5).toNonIndexed(); const a = (k * Math.PI) / 2 + Math.PI / 4, r = cr(89.5) + 0.25;
    b.translate(Math.cos(a) * r, 89.5, Math.sin(a) * r); colorize(b, () => [0.15, 0.15, 0.15]); fixtures.push(b);
  }
  return mergeNI([conc, tp, steel, plinth, door, steps, ...fixtures]);
}

// ------------------------------------------------------------------------------------------------ nacelle (local +x = upwind / hub)
function nacelleGeometry(S) {
  const W = 4.2, Hh = 4.3, x0 = -13.2, x1 = 5.6, yb = -2.1;   // y relative to the shaft height
  const shape = new THREE.Shape();
  const ch = 0.55, cb = 0.25;
  shape.moveTo(-W / 2 + cb, yb); shape.lineTo(W / 2 - cb, yb); shape.lineTo(W / 2, yb + cb);
  shape.lineTo(W / 2, yb + Hh / 2 - 1.0); shape.lineTo(W / 2, yb + Hh / 2 + 1.0);         // band stations
  shape.lineTo(W / 2, yb + Hh - ch); shape.lineTo(W / 2 - ch, yb + Hh); shape.lineTo(-W / 2 + ch, yb + Hh);
  shape.lineTo(-W / 2, yb + Hh - ch); shape.lineTo(-W / 2, yb + Hh / 2 + 1.0); shape.lineTo(-W / 2, yb + Hh / 2 - 1.0);
  shape.lineTo(-W / 2, yb + cb); shape.closePath();
  const body = new THREE.ExtrudeGeometry(shape, { depth: x1 - x0, bevelEnabled: false, steps: 1 });
  // extrusion runs along +z: map shape (x → z lateral, y → y) and depth → x
  body.rotateY(Math.PI / 2); body.translate(x0, 0, 0);
  const g = body.index ? body.toNonIndexed() : body;
  g.computeVertexNormals();
  const bandY0 = yb + Hh / 2 - 1.0, bandY1 = yb + Hh / 2 + 1.0;
  colorize(g, (x, y, z) => (Math.abs(z) > W / 2 - 0.01 && y > bandY0 && y < bandY1 ? RED : GREY));
  // band across the rear face (the extrusion cap is not split at the band edges)
  const rear = new THREE.BoxGeometry(0.04, bandY1 - bandY0, W).toNonIndexed(); rear.translate(x0 - 0.02, (bandY0 + bandY1) / 2, 0);
  colorize(rear, () => RED);
  // rear cooler on the roof (slatted frame)
  const cool = new THREE.BoxGeometry(4.6, 1.8, W + 0.2).toNonIndexed(); cool.translate(x0 + 2.6, yb + Hh + 0.9, 0);
  colorize(cool, () => [0.38, 0.40, 0.40]);
  const slats = [];
  for (let k = 0; k < 6; k++) { const s = new THREE.BoxGeometry(0.12, 1.5, W + 0.26).toNonIndexed(); s.translate(x0 + 0.6 + k * 0.8, yb + Hh + 0.9, 0); colorize(s, () => [0.22, 0.23, 0.23]); slats.push(s); }
  // side compartment (converter / transformer) on the rear right
  const sideParts = [[yb, bandY0, GREY], [bandY0, bandY1, RED], [bandY1, yb + 3.4, GREY]].map(([y0, y1, col]) => {
    const b = new THREE.BoxGeometry(7.5, y1 - y0, 1.4).toNonIndexed(); b.translate(x0 + 4.2, (y0 + y1) / 2, W / 2 + 0.7); return colorize(b, () => col);
  });
  // light posts on the cooler roof
  const posts = [];
  for (const z of [-1.4, 1.4]) { const p = new THREE.CylinderGeometry(0.06, 0.06, 0.3, 6).toNonIndexed(); p.translate(x0 + 2.2, yb + Hh + 1.95, z); colorize(p, () => [0.2, 0.2, 0.2]); posts.push(p); }
  return mergeNI([g, rear, cool, ...slats, ...sideParts, ...posts]);
}

// ------------------------------------------------------------------------------------------------ rotor
function airfoil(n, t) {
  // NACA-like thickness (t = thickness/chord) with a little camber; x from LE (0) to TE (1); returns [x, y] loop (CCW)
  const up = [], lo = [];
  for (let i = 0; i <= n; i++) {
    const b = (i / n) * Math.PI, x = (1 - Math.cos(b)) / 2;
    const yt = 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
    const yc = 0.035 * (1 - (2 * x - 0.8) ** 2) * (t < 0.5 ? 1 : 0);
    up.push([x, yc + yt]); lo.push([x, yc - yt]);
  }
  return up.concat(lo.reverse().slice(1, -1));
}
export function bladeGeometry(S) {
  const R = S.rotorR, r0 = S.hubR;
  const NP = 14;
  const base = airfoil(NP, 0.2), npts = base.length;
  const st = [r0, 2.4, 3.4, 5, 7, 9.5, 12, 15, 18, 22, 27, 33, 40, 47, 54, 61, 66, 68, 68, 71, 74, 74, 77, 80, 80, 82.5, 84.5, 85.6, 86];
  const chord = (r) => {
    if (r < 3.4) return 2.9;
    if (r < 18) { const t = (r - 3.4) / (18 - 3.4); return 2.9 + (4.3 - 2.9) * Math.sin((t * Math.PI) / 2); }
    const t = (r - 18) / (R - 18); return 4.3 * (1 - 0.77 * Math.pow(t, 0.85)) * (r > R - 1.5 ? 0.35 + 0.65 * (R - r) / 1.5 : 1);
  };
  const thick = (r) => (r < 3.4 ? 1 : r < 18 ? 1 - (1 - 0.36) * ((r - 3.4) / 14.6) ** 0.7 : 0.36 - (0.36 - 0.16) * Math.min(1, (r - 18) / 50));
  const twist = (r) => (r < 18 ? 13 : 13 * Math.max(0, 1 - (r - 18) / 62)) * (Math.PI / 180);
  const prebend = (r) => 4.2 * ((r - r0) / (R - r0)) ** 2;       // tip towards upwind (+x)
  const col = (r, next) => { const m = (r + next) / 2; return m > R - 6 || (m > R - 18 && m < R - 12) ? RED : GREY; };
  const rings = st.map((r, si) => {
    const c = chord(r), t = thick(r), tw = twist(r);
    const circ = r < 3.4 ? 1 : r < 12 ? 1 - (r - 3.4) / 8.6 : 0;
    const prof = airfoil(NP, Math.min(0.99, t));
    return prof.map(([x, y], k) => {
      // airfoil in (chord, thickness); pitch axis at 30 % chord
      let px = (x - 0.3) * c, py = y * c;
      const a = (k / npts) * Math.PI * 2, cx = Math.cos(a) * 1.45, cy = Math.sin(a) * 1.45;   // root circle Ø 2.9 m
      px = px * (1 - circ) + cx * circ; py = py * (1 - circ) + cy * circ;
      const ca = Math.cos(tw), sa = Math.sin(tw);
      const qx = px * ca - py * sa, qy = px * sa + py * ca;
      return [-qy + prebend(r), r, qx];     // x: upwind (pressure side), y: span, z: chordwise (leading edge towards −z = direction of travel)
    });
  });
  const pos = [], colr = [];
  for (let s = 0; s + 1 < st.length; s++) {
    if (st[s + 1] === st[s]) continue;
    const A = rings[s], B = rings[s + 1], cc = col(st[s], st[s + 1]);
    for (let k = 0; k < npts; k++) {
      const k2 = (k + 1) % npts;
      pos.push(...A[k], ...B[k], ...B[k2], ...A[k], ...B[k2], ...A[k2]);
      for (let q = 0; q < 6; q++) colr.push(...cc);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
  g.computeVertexNormals();
  return g;
}
function rotorGeometry(S) {
  const blades = [];
  const cone = (S.cone * Math.PI) / 180;
  for (let k = 0; k < 3; k++) {
    const b = bladeGeometry(S);
    // 86 m along the blade (Vestas' Ø 172 m); cone and pre-bend bring the swept radius at rest to 85.1 m, and with
    // tilt = cone the upper blade stands vertical, its tip at exactly hub + 86 m = 261 m
    b.rotateZ(-cone);                          // lean the blade upwind (+x)
    b.rotateX((k * 2 * Math.PI) / 3);
    blades.push(b);
  }
  // spinner (nose cone) and hub
  const prof = [[2.35, -1.6], [2.45, 0], [2.3, 1.2], [1.9, 2.4], [1.2, 3.4], [0.45, 4.0], [0.0, 4.15]].map(([r, x]) => new THREE.Vector2(r, x));
  const sp = new THREE.LatheGeometry(prof, 40).toNonIndexed(); sp.rotateZ(-Math.PI / 2);
  colorize(sp, () => GREY);
  return mergeNI([...blades.map((b) => b.index ? b.toNonIndexed() : b), sp]);
}

// ------------------------------------------------------------------------------------------------ simple distant turbine
function simpleTurbine(hub, rotorD) {
  const tower = new THREE.CylinderGeometry(1.6, 3.6, hub, 12, 1, true).toNonIndexed(); tower.translate(0, hub / 2, 0); colorize(tower, () => GREY);
  const nac = new THREE.BoxGeometry(12, 3.8, 3.8).toNonIndexed(); nac.translate(-3, hub, 0); colorize(nac, () => GREY);
  const blades = [];
  const R = rotorD / 2;
  for (let k = 0; k < 3; k++) {
    const b = new THREE.BoxGeometry(0.8, R, 2.6).toNonIndexed(); b.translate(0, R / 2 + 1, 0); b.rotateX((k * 2 * Math.PI) / 3); colorize(b, () => GREY); blades.push(b);
  }
  return { tower: mergeNI([tower, nac]), rotor: mergeNI(blades) };
}

// ------------------------------------------------------------------------------------------------ lights
function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,235,225,1)'); gr.addColorStop(0.07, 'rgba(255,60,40,1)'); gr.addColorStop(0.3, 'rgba(255,20,10,0.4)'); gr.addColorStop(1, 'rgba(255,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
// Feuer W, rot: on 0–1 s, off 1–1.5, on 1.5–2.5, off 2.5–4 (cycle starts 00:00:00 UTC)
export function feuerW(utcSeconds) { const t = ((utcSeconds % 4) + 4) % 4; return t < 1 || (t >= 1.5 && t < 2.5) ? 1 : 0; }

// Blade shadows: the rotor writes only a fraction of its shadow-map texels (hash dither) — a 1–4 m blade seen by a low
// sun casts a faint, sun-disc-blurred band, not a black line. The coverage is set per frame from the sun elevation.
export const BLADE_SHADOW = { value: 1 };
const BLADE_DEPTH = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
BLADE_DEPTH.onBeforeCompile = (sh) => {
  sh.uniforms.uCov = BLADE_SHADOW;
  sh.fragmentShader = sh.fragmentShader.replace('void main() {', `uniform float uCov;
void main() {
  if (fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453) > uCov) discard;`);
};
BLADE_DEPTH.customProgramCacheKey = () => 'bladedepth';

export function makeTurbines(data, ground, opts) {
  const S = V172, H = data.header;
  const group = new THREE.Group(); group.name = 'turbines';
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.05 });
  patch(mat, {
    key: 'turbine',
    frag: {
      // concrete ring joints every 3.8 m on the lower tower
      map: `#include <map_fragment>
        { float h = vWP.y - vBaseY; if (h < ${S.concreteTop.toFixed(2)} && h > 0.9) { float j = abs(fract(h / 3.8) - 0.5); diffuseColor.rgb *= mix(0.9, 1.0, smoothstep(0.0, 0.012, 0.5 - j)); } }`,
      pars: 'uniform float vBaseY;',
    },
  });
  const towerG = towerGeometry(S), nacG = nacelleGeometry(S), rotG = rotorGeometry(S);
  const glow = glowTexture();
  const turbines = [];
  for (const t of H.turbines) {
    const root = new THREE.Group(); root.name = t.id;
    root.position.set(t.x, t.ground, -t.y);
    const tm = mat.clone(); tm.onBeforeCompile = mat.onBeforeCompile; tm.customProgramCacheKey = mat.customProgramCacheKey;
    const baseU = { value: t.ground };
    const prevCompile = tm.onBeforeCompile;
    tm.onBeforeCompile = (sh, r) => { prevCompile(sh, r); sh.uniforms.vBaseY = baseU; };
    const tower = new THREE.Mesh(towerG, tm);
    // door towards the crane pad (pads lie on the side of the access road)
    tower.rotation.y = t.doorYaw || 0;
    tower.castShadow = true; tower.receiveShadow = true;
    root.add(tower);
    const yaw = new THREE.Group(); yaw.position.y = S.towerTop + 2.2 - 0.4 * Math.sin((S.tilt * Math.PI) / 180); root.add(yaw);   // rotor centre at 175.00 m
    const nac = new THREE.Mesh(nacG, tm); nac.castShadow = true; nac.receiveShadow = true; yaw.add(nac);
    const tiltG = new THREE.Group(); tiltG.position.x = S.overhang - 0.4; tiltG.rotation.z = (S.tilt * Math.PI) / 180; yaw.add(tiltG);
    const rotor = new THREE.Mesh(rotG, tm); rotor.castShadow = true; rotor.receiveShadow = true; rotor.customDepthMaterial = BLADE_DEPTH;
    rotor.position.x = 0.4; tiltG.add(rotor);
    rotor.rotation.x = (((t.x * 0.013) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    // lights
    const lights = [];
    for (const z of [-1.4, 1.4]) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: 0xff1a0a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: false, toneMapped: false }));
      sp.position.set(-13.2 + 2.2, -2.1 + 4.3 + 2.3, z); sp.scale.setScalar(0.012); sp.renderOrder = 5; yaw.add(sp); lights.push(sp);   // ≈ hub + 4.2 m
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: 0xff2a14, transparent: true, opacity: 0.18, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: false, toneMapped: false }));
      halo.position.copy(sp.position); halo.scale.setScalar(0.035); halo.renderOrder = 5; halo.userData.halo = true; yaw.add(halo); lights.push(halo);   // only once the sky is dark
    }
    const towerLights = [];
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2 + Math.PI / 4, r = 2.9;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: 0xff1a0a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: false, toneMapped: false }));
      sp.position.set(Math.cos(a) * r, 89.5, Math.sin(a) * r); sp.scale.setScalar(0.008); sp.renderOrder = 5; tower.add(sp); towerLights.push(sp);
    }
    group.add(root);
    turbines.push({ info: t, root, yaw, rotor, tower, lights, towerLights, phase: (t.x * 0.013) % (Math.PI * 2), yawJitter: ((((t.y * 0.37) % 5) + 5) % 5) - 2.5 });
  }
  // other wind turbines in the region (simple models, for the horizon)
  const others = [];
  for (const o of H.others) {
    if (Math.abs(o.x) > H.wide - 200 || Math.abs(o.y) > H.wide - 200) continue;
    const hub = o.hub > 30 ? o.hub : 140, rd = o.rotor > 30 ? o.rotor : 120;
    const g = simpleTurbine(hub, rd);
    const root = new THREE.Group(); root.position.set(o.x, ground.height(o.x, o.y), -o.y);
    root.add(new THREE.Mesh(g.tower, mat));
    const yaw = new THREE.Group(); yaw.position.y = hub; root.add(yaw);
    const rotor = new THREE.Mesh(g.rotor, mat); rotor.position.x = 3.5; yaw.add(rotor);
    group.add(root);
    others.push({ info: o, root, yaw, rotor, phase: Math.random() * 6 });
  }
  return { group, turbines, others, material: mat };
}

export function rotorRpm(v) {
  if (v < 3 || v > 25) return v > 25 ? 0 : 0.35;
  return Math.min(V172.ratedRpm, Math.max(V172.minRpm, 0.888 * v));
}
