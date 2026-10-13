// Sun, sky, clouds, aerial perspective and lighting shared by every material.
import * as THREE from 'three';

// ---------------------------------------------------------------------------------------------- sun ephemeris (NOAA)
export function sunPosition(date, lat, lon) {
  const rad = Math.PI / 180;
  const jd = date.getTime() / 86400000 + 2440587.5, T = (jd - 2451545) / 36525;
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = Math.sin(M * rad) * (1.914602 - T * (0.004817 + 0.000014 * T)) + Math.sin(2 * M * rad) * (0.019993 - 0.000101 * T) + Math.sin(3 * M * rad) * 0.000289;
  const omega = 125.04 - 1934.136 * T, lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * rad);
  const eps = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60 + 0.00256 * Math.cos(omega * rad);
  const decl = Math.asin(Math.sin(eps * rad) * Math.sin(lambda * rad));
  const y = Math.tan((eps * rad) / 2) ** 2;
  const eqt = (4 / rad) * (y * Math.sin(2 * L0 * rad) - 2 * e * Math.sin(M * rad) + 4 * e * y * Math.sin(M * rad) * Math.cos(2 * L0 * rad)
    - 0.5 * y * y * Math.sin(4 * L0 * rad) - 1.25 * e * e * Math.sin(2 * M * rad));
  const min = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const ha = ((min + eqt + 4 * lon) % 1440) / 4 - 180;
  const phi = lat * rad;
  const cz = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha * rad);
  let el = 90 - Math.acos(Math.max(-1, Math.min(1, cz))) / rad;
  if (el > -1.5) el += 1.02 / Math.tan((el + 10.3 / (el + 5.11)) * rad) / 60;   // refraction (Sæmundsson)
  const az = (Math.atan2(Math.sin(ha * rad), Math.cos(ha * rad) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) / rad + 540) % 360;
  return { el, az };
}
// azimuth (deg from north, clockwise) / elevation -> world direction (x east, y up, z south)
export function dirFromAzEl(az, el, out = new THREE.Vector3()) {
  const a = (az * Math.PI) / 180, e = (el * Math.PI) / 180;
  return out.set(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e));
}

// ---------------------------------------------------------------------------------------------- shared uniforms
export const U = {
  uTime: { value: 0 },
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uSunCol: { value: new THREE.Color(1, 1, 1) },
  uZenith: { value: new THREE.Color(0.1, 0.2, 0.5) },
  uHorizon: { value: new THREE.Color(0.5, 0.6, 0.8) },
  uFogDens: { value: 0.00006 },
  uFogH: { value: 950 },
  uFogBase: { value: 620 },
  uCloudCover: { value: 0.3 },
  uCloudOff: { value: new THREE.Vector2(0, 0) },
  uCloudH: { value: 1900 },
  uNight: { value: 0 },
  uSatCore: { value: null },
  uSatWide: { value: null },
  uGainInv: { value: 1 / 2.5 },
};

export const GLSL_COMMON = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform float uFogDens;
uniform float uFogH;
uniform float uFogBase;
uniform float uCloudCover;
uniform vec2 uCloudOff;
uniform float uCloudH;
uniform float uNight;
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm4(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; } return s; }
vec3 skyCol(vec3 d) {
  float h = clamp(d.y, -0.3, 1.0);
  float t = pow(1.0 - max(h, 0.0), 5.0);
  vec3 hz = uHorizon;
  {
    vec2 a = d.xz, b = uSunDir.xz;
    float side = dot(a, b) * inversesqrt(max(dot(a, a) * dot(b, b), 1e-8));
    float low = (1.0 - smoothstep(0.0, 0.25, uSunDir.y)) * smoothstep(-0.12, 0.0, uSunDir.y);
    vec3 anti = vec3(0.6, 0.6, 0.9) * dot(uHorizon, vec3(0.2126, 0.7152, 0.0722));
    hz = mix(uHorizon, anti, smoothstep(0.3, -0.8, side) * low);
  }
  vec3 c = mix(uZenith, hz, t);
  float mu = max(dot(d, uSunDir), 0.0);
  c += uSunCol * (0.018 * pow(mu, 3.0) + 0.06 * pow(mu, 24.0) + 0.3 * pow(mu, 300.0)) * (0.35 + 0.65 * t);
  // low sun: warm glow over the sunset side of the sky
  float low = 1.0 - smoothstep(0.0, 0.35, uSunDir.y);
  c += uSunCol * vec3(1.0, 0.72, 0.5) * 0.35 * pow(mu, 6.0) * low * (0.3 + 0.7 * t);
  if (h < 0.0) c = mix(c, hz * 0.55, clamp(-h * 3.0, 0.0, 1.0));
  return c;
}
// fair-weather cumulus: a 3 km octave for single clouds, a 14 km octave for fields of them
float cloudDensity(vec2 xz) {
  if (uCloudCover <= 0.001) return 0.0;
  float n = fbm4(xz * 0.00032 + uCloudOff * 2.0) * 0.65 + fbm4(xz * 0.00007 + 5.0) * 0.35;
  float lo = 0.66 - uCloudCover * 0.5;
  return smoothstep(lo, lo + 0.16, n);
}
// shadows only need the large shapes: the first octaves of both fields exactly as in cloudDensity, the finest ones
// replaced by their mean (5 instead of 8 noise lookups per pixel)
float fbm2(vec2 p) { return 0.5 * vnoise(p) + 0.25 * vnoise(p * 2.03 + vec2(17.1, 9.2)); }
float cloudShadow(vec3 p) {
  if (uCloudCover <= 0.001 || uSunDir.y <= 0.03) return 1.0;
  vec2 c = p.xz + uSunDir.xz * (uCloudH - p.y) / uSunDir.y;
  vec2 q = c * 0.00032 + uCloudOff * 2.0;
  float n = (fbm2(q) + 0.125 * vnoise(q * 4.1209 + vec2(51.813, 27.876)) + 0.03125) * 0.65 + (fbm2(c * 0.00007 + 5.0) + 0.09375) * 0.35;
  float lo = 0.66 - uCloudCover * 0.5;
  return 1.0 - 0.78 * smoothstep(lo, lo + 0.16, n);
}
// a forest canopy seen as a whole: darker when looking into a low sun (the shaded sides of the crowns face the viewer),
// a hot spot with the sun behind the viewer
float canopyBRDF(vec3 wp) {
  vec3 V = normalize(cameraPosition - wp);
  float low = 1.0 - smoothstep(0.08, 0.6, uSunDir.y);
  vec2 a = -V.xz, b = uSunDir.xz;
  float into = max(dot(a, b) * inversesqrt(max(dot(a, a) * dot(b, b), 1e-8)), 0.0);
  float hot = pow(max(dot(V, uSunDir), 0.0), 6.0);
  return mix(1.0, 0.55, into * low) * mix(1.0, 0.75, low * into) * (1.0 + 0.5 * hot) + 0.25 * into * low * (1.0 - V.y) * (1.0 - V.y);
}
vec3 applyFog(vec3 col, vec3 wp) {
  vec3 V = wp - cameraPosition; float dist = length(V); vec3 dir = V / max(dist, 1e-3);
  float k = 1.0 / uFogH, h0 = cameraPosition.y - uFogBase, dy = dir.y;
  float fi = abs(dy) > 1e-4 ? uFogDens * exp(-h0 * k) * (1.0 - exp(-dist * dy * k)) / (dy * k) : uFogDens * exp(-h0 * k) * dist;
  fi *= mix(0.25, 1.0, smoothstep(400.0, 3000.0, dist)) * (1.0 + 3.0 * smoothstep(20000.0, 60000.0, dist));   // clear near, veiled far        // the far ring melts into the haze, no hard skyline
  float f = 1.0 - exp(-max(fi, 0.0));
  vec3 ins = skyCol(normalize(vec3(dir.x, max(dir.y, 0.015), dir.z)));
  // forward scattering by the haze (Henyey–Greenstein, g = 0.6): the air glows towards a low sun
  float mu = dot(dir, uSunDir), g2 = 0.36;
  ins += uSunCol * 0.15 * (1.0 - g2) / pow(1.0 + g2 - 1.2 * mu, 1.5) * smoothstep(-0.05, 0.1, uSunDir.y);
  ins *= mix(vec3(1.0), vec3(1.08, 1.0, 0.88), smoothstep(-0.2, 0.6, mu) * (1.0 - smoothstep(0.0, 0.35, uSunDir.y)));   // warm towards the sun
  return mix(col, ins, f);
}
`;

// Aerial photos on the ground: shown in their true colours (they already carry the real light and shadows), only darkened
// where the scene casts a shadow (convoy, trees, buildings), by the cloud shadows and by the slope against the sun. The
// material is not tone mapped, so a photo pixel reaches the screen as it was taken. Night keeps the moonlit look.
export const PHOTO_TRUE = /* glsl */ `
  {
    float shd = 1.0, lam = 1.0;
    #if NUM_DIR_LIGHTS > 0
      shd = clamp(dot(directLight.color, vec3(1.0)) / max(dot(directionalLights[0].color, vec3(1.0)), 1e-4), 0.0, 1.0);
      vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz), Ls = directionalLights[0].direction;
      lam = clamp(max(dot(geometryNormal, Ls), 0.0) / max(dot(upV, Ls), 0.12), 0.55, 1.3);
    #endif
    float sh = mix(0.45, 1.0, shd * cloudShadow(vWP)) * lam;
    vec3 day = diffuseColor.rgb * sh * uPhotoGain;
    vec3 night = vec3(dot(diffuseColor.rgb, vec3(0.2, 0.7, 0.1))) * vec3(0.8, 0.95, 1.25) * 0.09 * mix(0.5, 1.0, shd);
    reflectedLight.directDiffuse = mix(day, night, uNight);
    reflectedLight.indirectDiffuse = vec3(0.0); reflectedLight.directSpecular = vec3(0.0); reflectedLight.indirectSpecular = vec3(0.0);
  }`;
export const photoUniforms = { uPhotoGain: { value: 1.0 } };
export const PHOTO_PARS = /* glsl */ `uniform float uPhotoGain;\n`;

// Patch a built-in material: world position varying, cloud shadows on direct light, aerial perspective before tone mapping.
// opts.frag: {pars, map (replaces map_fragment), afterLights, beforeFog}; opts.vert: {pars, main}; opts.uniforms.
export function patch(mat, opts = {}) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    if (prev) prev(sh, r);
    Object.assign(sh.uniforms, U, opts.uniforms || {});
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWP;\n' + ((opts.vert && opts.vert.pars) || ''))
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n' + ((opts.vert && opts.vert.normal) || ''))
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + ((opts.vert && opts.vert.begin) || ''))
      .replace('#include <project_vertex>', `#include <project_vertex>
        { vec4 wp4 = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            wp4 = instanceMatrix * wp4;
          #endif
          vWP = (modelMatrix * wp4).xyz; }
        ${(opts.vert && opts.vert.main) || ''}`);
    let f = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWP;\n' + GLSL_COMMON + ((opts.frag && opts.frag.pars) || ''));
    if (opts.frag && opts.frag.map) f = f.replace('#include <map_fragment>', opts.frag.map);
    if (opts.frag && opts.frag.normal) f = f.replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + opts.frag.normal);
    f = f.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
      { float cs = cloudShadow(vWP); reflectedLight.directDiffuse *= cs; reflectedLight.directSpecular *= cs; }
      if (uNight > 0.0) {
        vec3 tint = vec3(0.8, 0.95, 1.25), w = vec3(0.2, 0.7, 0.1);
        reflectedLight.indirectDiffuse = mix(reflectedLight.indirectDiffuse, vec3(dot(reflectedLight.indirectDiffuse, w)) * tint, 0.7 * uNight);
        reflectedLight.directDiffuse = mix(reflectedLight.directDiffuse, vec3(dot(reflectedLight.directDiffuse, w)) * tint, 0.7 * uNight);
      }
      ${(opts.frag && opts.frag.afterLights) || ''}`);
    f = f.replace('#include <tonemapping_fragment>', `${(opts.frag && opts.frag.beforeFog) || ''}
      gl_FragColor.rgb = applyFog(gl_FragColor.rgb, vWP);
      #include <tonemapping_fragment>`);
    sh.fragmentShader = f;
  };
  mat.customProgramCacheKey = () => (opts.key || '') + '|wp';
  return mat;
}

// ---------------------------------------------------------------------------------------------- sky palette
const KEYS = [
  // sun elevation (deg), zenith colour, horizon colour (linear HDR)
  [-18, [0.0028, 0.0042, 0.0095], [0.0068, 0.0066, 0.0085]],
  [-10, [0.0055, 0.009, 0.022], [0.02, 0.019, 0.03]],
  [-4, [0.014, 0.026, 0.07], [0.12, 0.08, 0.09]],
  [0, [0.035, 0.07, 0.17], [0.52, 0.30, 0.18]],
  [4, [0.06, 0.12, 0.28], [0.72, 0.52, 0.36]],
  [10, [0.08, 0.17, 0.40], [0.60, 0.66, 0.76]],
  [25, [0.09, 0.21, 0.52], [0.62, 0.72, 0.86]],
  [60, [0.08, 0.20, 0.54], [0.60, 0.72, 0.88]],
];
function lerp3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
export function skyPalette(el) {
  let i = 0;
  while (i < KEYS.length - 2 && el > KEYS[i + 1][0]) i++;
  const a = KEYS[i], b = KEYS[i + 1];
  let t = (el - a[0]) / (b[0] - a[0]); t = Math.max(0, Math.min(1, t)); t = t * t * (3 - 2 * t);
  return { zenith: lerp3(a[1], b[1], t), horizon: lerp3(a[2], b[2], t) };
}
// sun colour through the atmosphere (Kasten–Young air mass, per-channel optical depth)
export function sunColor(el) {
  if (el < -2) return [0, 0, 0];
  const e = Math.max(el, -1.5);
  const am = 1 / (Math.sin((Math.max(e, 0) * Math.PI) / 180) + 0.50572 * Math.pow(e + 6.07995, -1.6364));
  const tau = [0.06, 0.11, 0.24];
  const k = Math.max(0, Math.min(1, (el + 2) / 3));
  return tau.map((t) => Math.exp(-t * am) * k);
}

// ---------------------------------------------------------------------------------------------- sky dome
// late: drawn after the opaque scene at the far plane, so only the pixels where the sky is seen run its shader (the
// route views); otherwise first, under everything (the wind park's far pass)
export function makeSky(opts = {}) {
  const late = !!opts.late;
  const geo = new THREE.SphereGeometry(1, 64, 32);
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...U, uHorizonTex: { value: null }, uHorizonOn: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() { vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = ${late ? 'p.xyww' : 'p'}; }`,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      uniform sampler2D uHorizonTex;
      uniform float uHorizonOn;
      ${GLSL_COMMON}
      vec3 stars(vec3 d) {
        vec3 a = abs(d); vec2 uv = a.x > a.y && a.x > a.z ? d.yz / a.x : a.y > a.z ? d.xz / a.y : d.xy / a.z;
        vec2 g = uv * 420.0, id = floor(g), f = fract(g) - 0.5;
        float h = hash12(id + sign(d.x) * 13.0 + sign(d.y) * 29.0 + sign(d.z) * 7.0);
        float s = step(0.9965, h) * smoothstep(0.26, 0.0, length(f + (vec2(hash12(id + 3.1), hash12(id + 7.7)) - 0.5) * 0.4));
        float tw = 0.7 + 0.3 * sin(uTime * (1.5 + 3.0 * h) + h * 60.0);
        return vec3(s * tw * (0.6 + 1.4 * fract(h * 97.0)));
      }
      void main() {
        vec3 d = normalize(vDir);
        vec3 c = skyCol(d);
        float mu = dot(d, uSunDir);
        // sun disc (0.53°) with limb darkening
        float disc = smoothstep(0.999955, 0.999975, mu);
        c += uSunCol * (disc * 40.0 + pow(max(mu, 0.0), 2200.0) * 3.0 + pow(max(mu, 0.0), 90.0) * 0.18);
        // stars
        if (uNight > 0.01 && d.y > 0.0) c += stars(d) * uNight * 0.02 * smoothstep(0.0, 0.15, d.y);
        // Alps / distant skyline beyond 64 km (elevation angle per azimuth, from the Terrain Tiles)
        if (uHorizonOn > 0.5) {
          float az = fract(atan(d.x, -d.z) / 6.2831853 + 1.0);
          float hz = texture2D(uHorizonTex, vec2(az, 0.5)).r;
          // adjust for the viewer height relative to the reference eye (900 m): dip of the horizon
          hz -= (cameraPosition.y - 900.0) / 95000.0;
          float ang = asin(clamp(d.y, -1.0, 1.0));
          float px = 0.00025;
          float inside = smoothstep(px, -px, ang - hz);
          // distant ranges: a little bluer and darker than the sky behind them (aerial perspective over 70–250 km)
          vec3 far = mix(uHorizon, uZenith, 0.45) * 0.72 + uSunCol * pow(max(dot(d, uSunDir), 0.0), 6.0) * 0.05;
          // snowfields near the crest of the high Alps catch the light; alpenglow when the sun is low
          float snow = smoothstep(0.0022, 0.0075, hz) * smoothstep(0.003, 0.0004, hz - ang);
          float lowSun = 1.0 - smoothstep(0.0, 0.06, uSunDir.y);
          far = mix(far, uHorizon * 1.1 + uSunCol * 0.3, clamp(snow * 1.6, 0.0, 0.85));
          far += uSunCol * vec3(1.0, 0.5, 0.55) * snow * 2.0 * lowSun * step(0.0, uSunDir.y + 0.02);
          c = mix(c, far, inside * 0.94);
        }
        // clouds on a plane at uCloudH
        if (d.y > 0.0 && uCloudCover > 0.001) {
          float t = (uCloudH - cameraPosition.y) / d.y;
          if (t > 0.0) {
            vec2 p = cameraPosition.xz + d.xz * t;
            float den = cloudDensity(p) * smoothstep(0.03, 0.12, d.y);
            if (den > 0.001) {
              float sh = cloudDensity(p + uSunDir.xz * 260.0);
              float lit = clamp(1.0 - sh * 0.9 + 0.2, 0.0, 1.0);
              vec3 amb = mix(uZenith, uHorizon, 0.5);
              vec3 cc = mix(amb * 0.45, uSunCol * 2.2 + amb * 0.35, lit);
              cc += uSunCol * pow(max(mu, 0.0), 8.0) * den * (1.0 - den) * 3.0;      // silver lining
              float fade = exp(-t * 0.000028);
              c = mix(c, cc, den * fade * 0.95);
            }
          }
        }
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: late,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = late ? 1e6 : -10;
  mesh.scale.setScalar(20000);
  return mesh;
}

// ---------------------------------------------------------------------------------------------- update all lighting
// hemiDesat (0..1): how far the sky light's colour is pulled to its grey (same brightness). The route page sets it: under
// its bridges the shade is lit by the sky light alone, and the full sky blue turned grey asphalt navy there
export const ENV = { hemiDesat: 0 };
export function updateEnvironment(env, el, az) {
  const { sun, hemi } = env;
  dirFromAzEl(az, el, U.uSunDir.value);
  const sc = sunColor(el);
  U.uSunCol.value.setRGB(sc[0], sc[1], sc[2]);
  const pal = skyPalette(el);
  const sky = 1.0;
  U.uZenith.value.setRGB(pal.zenith[0] * sky, pal.zenith[1] * sky, pal.zenith[2] * sky);
  U.uHorizon.value.setRGB(pal.horizon[0] * sky, pal.horizon[1] * sky, pal.horizon[2] * sky);
  const night = Math.max(0, Math.min(1, (-el - 2) / 8));
  U.uNight.value = night;
  // sun light (light points from the sun towards the target)
  const inten = 4.4;
  sun.color.setRGB(sc[0], sc[1], sc[2]);
  sun.intensity = el > -2 ? inten : 0;
  // sky / ground ambient
  const z = pal.zenith, h = pal.horizon;
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const mixc = [0.75 * z[0] + 0.25 * h[0], 0.75 * z[1] + 0.25 * h[1], 0.75 * z[2] + 0.25 * h[2]];
  const k = (lum([z[0] + h[0], z[1] + h[1], z[2] + h[2]]) * 1.1) / Math.max(1e-6, lum(mixc));
  const nf = 0.8 * night;                       // moon / skyglow fill so the land never goes pure black
  hemi.color.setRGB(mixc[0] * k + 0.10 * nf, mixc[1] * k + 0.13 * nf, mixc[2] * k + 0.22 * nf);
  {
    const w = Math.max(0, Math.min(1, (3 - el) / 4)) * (1 - night), s = (lum(mixc) * k * 1.3) / Math.max(1e-6, lum(z)), g = lum(z) * s;
    const zc = [z[0] * s + (g - z[0] * s) * 0.4, z[1] * s + (g - z[1] * s) * 0.4, z[2] * s + (g - z[2] * s) * 0.4];   // zenith fill, 40 % desaturated
    hemi.color.setRGB(hemi.color.r + (zc[0] - hemi.color.r) * w, hemi.color.g + (zc[1] - hemi.color.g) * w, hemi.color.b + (zc[2] - hemi.color.b) * w);
  }
  if (ENV.hemiDesat > 0) { const c = hemi.color, g = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b, w = ENV.hemiDesat * (1 - night);
    c.setRGB(c.r + (g - c.r) * w, c.g + (g - c.g) * w, c.b + (g - c.b) * w); }
  hemi.groundColor.setRGB(hemi.color.r * 0.26, hemi.color.g * 0.3, hemi.color.b * 0.2);
  hemi.intensity = 0.76 + night * 0.9;
  // haze thicker at low sun
  U.uFogDens.value = 0.00003 + 0.000012 * Math.max(0, 1 - Math.abs(el) / 12);   // ≈ 12 % haze at 3.5 km at eye level
}
