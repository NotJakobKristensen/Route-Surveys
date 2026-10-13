import * as THREE from 'three';
import { decodeScene, b64bytes, makeProjection } from './data.js';
import { makeGround } from './ground.js';
import { U, makeSky, updateEnvironment, sunPosition } from './env.js';
import { makeTerrain, loadImageTexture, makeFarTerrain } from './terrain.js';
import { makeForestModel, makeCanopy, makeTrees, NearForest, NEAR, FOREST_TEX, TREE_U, treeMaterial } from './forest.js';
import { makeBuildings } from './buildings.js';
import { makeRoads, makePads } from './roads.js';
import { makeWater } from './water.js';
import { makePower } from './power.js';
import { makeTurbines, rotorRpm, feuerW, V172, BLADE_SHADOW } from './turbines.js';
import { GroundOrbit } from './controls.js';

const $ = (s) => document.querySelector(s);
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const D2R = Math.PI / 180;

const header = JSON.parse($('#scene-header').textContent);
const LAT = header.origin.lat, LON = header.origin.lon;
const proj = makeProjection(LON, LAT);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const forced = window.__PARK_QUALITY__;
const coarse = forced ? forced === 'low' : matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 900;
const Q = coarse
  ? { step: 32, classSize: 1024, maskSize: 1024, canopyStep: 20, wideCanopyStep: 72, edgeStep: 9, shadow: 2048, dpr: 1.5, treeLod: [320, 1000, 2600], nearR: 300, nearStep: 8.5, nearLod: [160, 700, 4000] }
  : { step: 8192 / 384, classSize: 2048, maskSize: 2048, canopyStep: 12, wideCanopyStep: 56, edgeStep: 6.5, shadow: 4096, dpr: 1.5, treeLod: [550, 1700, 5000], nearR: 520, nearStep: 7, nearLod: [230, 1300, 6000] };
// boot timeline (ms since navigation start), read by the QA harness
const marks = (window.__bootMarks = {});
const mark = (k) => { marks[k] = Math.round(performance.now()); };

// ------------------------------------------------------------------------------------------------ state
const state = {
  minutes: 19 * 60 + 40,              // local time (CEST) on the imagery date
  date: '2026-06-19',
  utcOffset: 2,
  windFrom: 240,                      // prevailing WSW
  wind: 7.5,                          // m/s at hub height
  lights: true,
  playing: false,
  selected: null,
};

const loading = $('#loading'), loadMsg = $('#load-msg'), loadBar = $('#load-bar');
function progress(msg, f) { loadMsg.textContent = msg; loadBar.style.transform = `scaleX(${f})`; }

async function boot() {
  mark('start');
  progress('Decoding terrain and map data', 0.05);
  await nextFrame();
  const data = await decodeScene(header, $('#scene-bin').textContent);
  mark('decoded');
  const ground = makeGround(data);
  const coreBytes = b64bytes($('#img-core').textContent);
  const [satCore, satWide, satImg] = await Promise.all([
    loadImageTexture(coreBytes, 'image/webp'),
    loadImageTexture(b64bytes($('#img-wide').textContent), 'image/webp'),
    // CPU copy of the core image: tree tints are baked from it
    createImageBitmap(new Blob([coreBytes], { type: 'image/webp' }), { resizeWidth: 512, resizeHeight: 512, resizeQuality: 'medium' }).then((bmp) => {
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
      const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(bmp, 0, 0);
      return { data: g.getImageData(0, 0, bmp.width, bmp.height).data, w: bmp.width };
    }).catch(() => null),
  ]);
  U.uSatCore.value = satCore; U.uSatWide.value = satWide; U.uGainInv.value = 1 / header.imagery.core.gain;
  mark('images');

  // --- renderer
  const canvas = $('#c');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: !!window.__PARK_TEST__ });
  renderer.useLegacyLights = false;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.autoClear = false;
  renderer.info.autoReset = false;            // stats() counts all passes of a frame (far, shadow, main)
  let dprMax = Math.min(window.devicePixelRatio || 1, Q.dpr), dpr = dprMax;
  renderer.setPixelRatio(dpr);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 1, 30000);
  // far pass: sky dome, horizon silhouettes and the terrain ring to ±64 km, drawn first with its own depth range
  const farScene = new THREE.Scene();
  const farCamera = new THREE.PerspectiveCamera(50, 1, 2500, 95000);
  const sky = makeSky(); farScene.add(sky);
  {
    const hz = data.horizon, n = hz.length, arr = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) arr[i * 4] = hz[i];
    const tex = new THREE.DataTexture(arr, n, 1, THREE.RGBAFormat, THREE.FloatType);
    tex.wrapS = THREE.RepeatWrapping; tex.magFilter = tex.minFilter = THREE.NearestFilter; tex.needsUpdate = true;
    sky.material.uniforms.uHorizonTex.value = tex; sky.material.uniforms.uHorizonOn.value = 1;
  }
  farScene.add(makeFarTerrain(data));
  const farHemi = new THREE.HemisphereLight(0x8899bb, 0x334422, 1.0), farSun = new THREE.DirectionalLight(0xffffff, 3);
  farScene.add(farHemi, farSun);
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(Q.shadow, Q.shadow);
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.6;
  sun.shadow.autoUpdate = false;              // refreshed every second frame in the loop (rotor shadows at 30 Hz)
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(0x8899bb, 0x334422, 1.2); scene.add(hemi);
  const env = { sun, hemi, farSun, farHemi };

  progress('Building terrain', 0.2); await nextFrame();
  const terrain = makeTerrain(data, ground, Q);
  mark('terrain');
  scene.add(terrain.coreMesh, terrain.wideMesh);

  progress('Placing the six V172 turbines', 0.3); await nextFrame();
  // door of each tower faces its crane pad
  for (const t of header.turbines) {
    let best = null, bd = Infinity;
    for (const p of data.pads) { const c = p.rings[0]; let sx = 0, sy = 0; for (let i = 0; i < c.length; i += 2) { sx += c[i]; sy += c[i + 1]; } sx /= c.length / 2; sy /= c.length / 2; const d = Math.hypot(sx - t.x, sy - t.y); if (d < bd) { bd = d; best = [sx, sy]; } }
    if (best) t.doorYaw = Math.atan2(best[1] - t.y, best[0] - t.x);
  }
  const turb = makeTurbines(data, ground, Q);
  scene.add(turb.group);

  progress('Roads, tracks and streams', 0.42); await nextFrame();
  const roads = makeRoads(data, ground, terrain.meshH, coarse ? 12 : 6);
  scene.add(roads.roads, roads.rail, roads.streams, makePads(data));
  scene.add(makeWater(data));
  // start compiling the programs seen so far: with KHR_parallel_shader_compile the driver works on them while the forest
  // is being built on the main thread
  const earlyCompile = renderer.compileAsync(scene, camera).catch(() => {});

  progress('Growing the Wagenhart forest', 0.55); await nextFrame();
  mark('roads');
  const fm = makeForestModel(data, Q.maskSize);
  mark('forestMask');
  {
    // R: canopy shell mask, G: forest lanes; openness raster from Sentinel-2
    const t = new THREE.DataTexture(fm.texData, fm.size, fm.size, THREE.RGFormat, THREE.UnsignedByteType);
    t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.needsUpdate = true;
    FOREST_TEX.canopy.value = t;
    const o = new THREE.DataTexture(fm.open.data, fm.open.n, fm.open.n, THREE.RedFormat, THREE.UnsignedByteType);
    o.unpackAlignment = 1; o.magFilter = o.minFilter = THREE.LinearFilter; o.needsUpdate = true;
    FOREST_TEX.open.value = o; FOREST_TEX.openExt.value = fm.open.ext;
  }
  const canopy = makeCanopy(data, ground, fm, Q);
  scene.add(canopy.group);
  const trees = makeTrees(data, ground, fm, Q, terrain.meshH, satImg, 1 / header.imagery.core.gain);
  scene.add(trees.group);
  const nearForest = new NearForest(fm, ground, treeMaterial(true), trees.geos, Q, terrain.meshH);
  scene.add(nearForest.group);

  mark('forest');
  progress('Villages and farms', 0.75); await nextFrame();
  const bld = makeBuildings(data, ground);
  scene.add(bld.mesh);

  progress('110 kV lines', 0.85); await nextFrame();
  const power = makePower(data, ground);
  scene.add(power.group);

  // surface used by the camera: terrain + canopy + a margin
  const surface = (x, y) => {
    let h = ground.height(x, y);
    if (Math.abs(x) < header.core && Math.abs(y) < header.core) { const m = fm.shellMask(x, y); if (m > 0.12) h += (fm.canopyHeight(x, y) + 3) * Math.min(1, (m - 0.12) / 0.3); }
    return h;
  };
  const controls = new GroundOrbit(camera, canvas, surface);

  // ---------------------------------------------------------------------------------------------- views
  const T = Object.fromEntries(turb.turbines.map((t) => [t.info.id, t]));
  const hubPos = (id, dy = 0) => { const t = T[id].info; return new THREE.Vector3(t.x, t.ground + V172.hub + dy, -t.y); };
  const views = {
    // from the south-west, all six rotors between the side panels on common desktop sizes (1280×760 … 1920×1080)
    overview: () => [new THREE.Vector3(-530, 700, -331), 2700, 32, 9.5],
    // portrait screens: from the west along the row (WEA 1 nearest), evening sun behind the camera
    overviewTall: () => [new THREE.Vector3(0, 720, 4), 3400, 80, 9],
    top: () => [new THREE.Vector3(0, 660, 0), 5000, 0, 89],
    hosskirch: () => {
      // open field between Königseggwald and Hoßkirch, 3.5 km SSW of the park (47.9294° N, 9.4305° E, ground 667 m): the
      // stretch of the fields south of the Wagenhart where terrain, forest, tree rows and orchards leave every nacelle and
      // every lower blade tip in sight (≥ 2 m clearance)
      const cx = -1100, cy = -3350, eye = ground.height(cx, cy) + 1.7;
      let a0 = Infinity, a1 = -Infinity;
      for (const t of header.turbines) { const a = Math.atan2(t.x - cx, t.y - cy); a0 = Math.min(a0, a); a1 = Math.max(a1, a); }
      southSpan = a1 - a0;
      const az = (a0 + a1) / 2, D = 3300, up = 3.2 * D2R;              // look 3.2° up: fields below, sky above the rotors
      const tgt = new THREE.Vector3(cx + Math.sin(az) * D, eye + Math.tan(up) * D, -(cy + Math.cos(az) * D));
      return [tgt, D / Math.cos(up), az / D2R, -up / D2R, D / Math.cos(up)];
    },
    nacelle: () => {
      // on the roof of WEA 3's nacelle, at its rear, looking downwind along the row (the rotor behind the camera): the
      // turbines within 70° of the downwind direction, WEA 4, 6 and 5 with the default south-westerly
      const a = T['WEA 3'].info, back = (state.windFrom + 180) * D2R;
      const others = header.turbines.filter((t) => t.id !== 'WEA 3');
      let sel = others.filter((t) => Math.cos(Math.atan2(t.x - a.x, t.y - a.y) - back) > Math.cos(70 * D2R));
      if (!sel.length) sel = others;
      const tgt = new THREE.Vector3(0, 0, 0);
      for (const t of sel) tgt.add(hubPos(t.id, -45));
      tgt.divideScalar(sel.length);
      tgt.y -= Math.hypot(tgt.x - a.x, -tgt.z - a.y) * Math.tan(4 * D2R);   // 4° down: a sliver of the nacelle roof below
      const camx = a.x + Math.sin(back) * 14, camy = a.y + Math.cos(back) * 14, camh = a.ground + V172.hub + 6.5;
      const d = Math.hypot(tgt.x - camx, -tgt.z - camy);
      return [tgt, Math.hypot(d, camh - tgt.y), Math.atan2(tgt.x - camx, -tgt.z - camy) / D2R, Math.asin((camh - tgt.y) / Math.hypot(d, camh - tgt.y)) / D2R];
    },
    foot: () => {
      // far end of WEA 5's crane pad, eye level, looking up at the tower base (evening sun from the left)
      const t = T['WEA 5'].info;
      let best = null, bd = Infinity;
      for (const p of data.cranepads) { const c = p.rings[0]; let sx = 0, sy = 0; for (let i = 0; i < c.length; i += 2) { sx += c[i]; sy += c[i + 1]; } sx /= c.length / 2; sy /= c.length / 2; const d = Math.hypot(sx - t.x, sy - t.y); if (d < bd) { bd = d; best = [sx, sy]; } }
      const ax = Math.atan2(best[0] - t.x, best[1] - t.y), cx = t.x + Math.sin(ax) * 56, cy = t.y + Math.cos(ax) * 56;
      const ch = ground.height(cx, cy) + 1.7, tgt = new THREE.Vector3(t.x, t.ground + 14, -t.y), d = Math.hypot(t.x - cx, t.y - cy);
      return [tgt, Math.hypot(d, tgt.y - ch), Math.atan2(t.x - cx, t.y - cy) / D2R, Math.asin((ch - tgt.y) / Math.hypot(d, tgt.y - ch)) / D2R];
    },
  };
  // ---------------------------------------------------------------------------------------------- camera framing
  // The panels cover part of the canvas (the dock at the bottom; on phones also the title and the turbine card), so the
  // optical centre moves to the middle of the uncovered area: only the lower part of a taller virtual frame is drawn
  // (setViewOffset), with the FOV widened so that the visible field of view stays what the view asked for.
  let baseFov = 50, shift = 0, viewW = 1, viewH = 1, freeTop = 0, freeBottom = 1, southSpan = 0.72;
  const phoneMQ = matchMedia('(max-width: 760px)');
  function applyCam() {
    const H2 = viewH + 2 * shift, fov = (2 * Math.atan((Math.tan((baseFov * D2R) / 2) * H2) / viewH)) / D2R;
    for (const cam of [camera, farCamera]) {
      cam.fov = fov; cam.userData.visibleFov = baseFov;
      if (shift > 0) cam.setViewOffset(viewW, H2, 0, 2 * shift, viewW, viewH);
      else { cam.clearViewOffset(); cam.aspect = viewW / viewH; }
      cam.updateProjectionMatrix();
    }
  }
  function frameShift() {
    let top = 0, bottom = viewH;
    if (!$('#ui').classList.contains('hide')) {
      const c = canvas.getBoundingClientRect(), r = (sel) => $(sel).getBoundingClientRect();
      bottom = r('#dock').top - c.top;
      if (phoneMQ.matches) {
        top = r('#title').bottom - c.top;
        for (const sel of ['#views', '#info']) if (!$(sel).hidden) bottom = Math.min(bottom, r(sel).top - c.top);
      }
    }
    freeTop = top; freeBottom = Math.max(top + 1, bottom);
    const s2 = Math.max(0, Math.min(Math.round(viewH * 0.3), Math.round(viewH / 2 - (top + bottom) / 2)));
    if (s2 !== shift) { shift = s2; applyCam(); }
  }
  function resize() {
    viewW = Math.max(1, canvas.clientWidth); viewH = Math.max(1, canvas.clientHeight);
    renderer.setSize(viewW, viewH, false);
    shift = -1; frameShift();
  }
  new ResizeObserver(() => { if (canvas.clientWidth !== viewW || canvas.clientHeight !== viewH) resize(); else frameShift(); })
    .observe(canvas);
  { const ro = new ResizeObserver(() => frameShift()); for (const sel of ['#dock', '#info', '#views', '#title']) ro.observe($(sel)); }
  window.addEventListener('park-layout', () => frameShift());
  resize();
  function setFov(f) { if (baseFov !== f) { baseFov = f; applyCam(); } }
  // distance at which a box of half-width w and half-height h (m, across the view) fits the uncovered part of the screen
  function fitDist(w, h) {
    const t = Math.tan((baseFov * D2R) / 2);
    return Math.max(w / (t * (viewW / viewH)), h / ((t * (freeBottom - freeTop)) / viewH));
  }
  function goView(name, instant) {
    let v;
    const aspect = viewW / viewH;
    // the southern panorama: all six rotors across the screen (a longer lens on landscape screens, wider in portrait)
    if (name === 'hosskirch') views.hosskirch();
    setFov(name === 'hosskirch' ? Math.max(32, Math.min(95, (2 * Math.atan(Math.tan(southSpan / 2 + 4 * D2R) / aspect)) / D2R)) : name === 'nacelle' && aspect > 1 ? 40 : 50);
    const tall = aspect < 0.8;
    select(name.startsWith('WEA') ? name : null);
    frameShift();                                                  // the turbine card changes the uncovered area
    let fit = null;
    if (name.startsWith('WEA')) {
      const face = state.windFrom;                                 // stand upwind, look at the rotor face
      v = [hubPos(name, -35), 520, (face + 180 + 25) % 360, 8];
      fit = [118, 150];                                            // rotor and tower with a margin
    } else {
      v = views[name === 'overview' && tall ? 'overviewTall' : name]();
      if (name === 'overview') fit = tall ? [620, 420] : [1500, 420];
      if (name === 'top') fit = [1800, 800];
    }
    const [tgt, d0, az, el, dd0] = v;
    const d = fit ? Math.max(d0, fitDist(fit[0], fit[1])) : dd0 || d0;
    controls.lockY = name !== 'overview' && name !== 'top';
    if (instant) controls.set(tgt, d, az, el); else controls.flyTo(tgt, d, az, el, reduceMotion ? 0.01 : 2.4);
  }
  // ---------------------------------------------------------------------------------------------- UI
  const ui = setupUI({ header, state, goView, proj, ground, controls, T });
  function select(id) { state.selected = id; ui.showTurbine(id); }
  goView('overview', true);
  controls.onTap = (x, y) => {
    const r = canvas.getBoundingClientRect();
    const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), camera);
    const hits = ray.intersectObjects(turb.turbines.flatMap((t) => [t.tower, t.rotor, t.yaw.children[0]]), false);
    if (hits.length) { let o = hits[0].object; while (o && !T[o.name]) o = o.parent; if (o) { select(o.name); return; } }
    select(null);
  };
  let hoverT = 0;
  canvas.addEventListener('pointermove', (e) => {
    const now = performance.now(); if (now - hoverT < 90 || e.buttons) return; hoverT = now;
    const p = controls.pick(e.clientX, e.clientY);
    ui.cursor(p ? { x: p.x, y: -p.z, h: ground.height(p.x, -p.z) } : null);
  });
  canvas.addEventListener('pointerleave', () => ui.cursor(null));

  // ---------------------------------------------------------------------------------------------- quality
  // Resolution governor on the frame interval (GPU time is invisible around render()). Below ~40 fps for a second of
  // frames → fewer pixels; a steady 60 fps for six seconds → try one step up, but a step that failed before is retried
  // only after 6 s, then 30 s, then 2 min. A steady 30 fps may be a frame-rate cap (battery saver) or a GPU at its
  // limit: tested once by dropping half a step of resolution for 2 s. No faster → a cap: resolution restored, and from
  // then on only frames well below 30 fps count as slow. Still slow at the lowest resolution → lighter shadows and a
  // smaller near forest (they do not shrink with the pixel count).
  const gov = { ema: 16.7, slow: 0, fast: 0, failed: new Map(), degraded: false, cap: null, probe: null };
  const setDpr = (v) => { dpr = v; renderer.setPixelRatio(dpr); resize(); gov.ema = 16.7; gov.slow = gov.fast = 0; };
  function adapt(msRaw) {
    if (window.__PARK_TEST__ || document.hidden) return;
    const ms = Math.min(msRaw, 200), now = performance.now();
    gov.ema += (ms - gov.ema) * 0.06;
    if (gov.probe) {
      if (now - gov.probe.t < 2000) return;
      const d0 = gov.probe.dpr; gov.probe = null;
      if (gov.ema > 30) { gov.cap = true; gov.failed.clear(); setDpr(d0); }
      else { gov.cap = false; gov.failed.set(d0, { n: 1, t: now }); gov.slow = gov.fast = 0; }
      return;
    }
    const at30 = gov.cap === null && Math.abs(gov.ema - 33.3) < 2.5;
    if (gov.ema > (gov.cap ? 40 : 25)) { gov.slow += ms; gov.fast = 0; } else if (gov.ema < 17.6) { gov.fast += ms; gov.slow = 0; } else { gov.slow = gov.fast = 0; }
    if (gov.slow > 1000) {
      if (at30) {
        if (dpr > 0.75) { gov.probe = { t: now, dpr }; setDpr(Math.max(0.75, dpr - 0.5)); }
        else { gov.cap = true; gov.slow = 0; }
      } else if (dpr > 0.75) {
        const f = gov.failed.get(dpr) || { n: 0, t: 0 }; gov.failed.set(dpr, { n: f.n + 1, t: now });
        setDpr(Math.max(0.75, dpr - 0.25));
      } else if (!gov.degraded && gov.slow > 2500) {
        gov.degraded = true;
        if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
        sun.shadow.mapSize.set(2048, 2048);
        nearForest.R = Math.min(nearForest.R, 320); nearForest.center = null;
        gov.slow = 0;
      }
    }
    if (gov.fast > 6000 && dpr < dprMax) {
      const next = Math.min(dprMax, dpr + 0.25), f = gov.failed.get(next), wait = f ? [6000, 30000, 120000][Math.min(2, f.n - 1)] : 0;
      if (!f || now - f.t > wait) setDpr(next); else gov.fast = 0;
    }
  }

  // ---------------------------------------------------------------------------------------------- loop
  let lastEnvKey = '', prevT = performance.now(), simT = 0, frameNo = 0, camMoved = true, sunMoved = true, lastShadowT = -1;
  const lastCam = new THREE.Vector3(), camFwd = new THREE.Vector3();
  const shadowCam = sun.shadow.camera;
  function updateSun() {
    const [Y, M, Dd] = state.date.split('-').map(Number);
    const utcMin = state.minutes - state.utcOffset * 60;
    const date = new Date(Date.UTC(Y, M - 1, Dd, 0, 0, 0) + utcMin * 60000);
    const s = sunPosition(date, LAT, LON);
    updateEnvironment(env, s.el, s.az);
    state.sun = s;
    ui.sun(s);
  }
  function frame(now) {
    adapt(now - prevT);
    const dt = Math.min(0.1, (now - prevT) / 1000); prevT = now; simT += dt;
    if (state.playing) { state.minutes = (state.minutes + dt * 12) % 1440; ui.syncTime(); }
    const key = state.minutes.toFixed(1) + state.date;
    if (key !== lastEnvKey) {
      updateSun(); lastEnvKey = key; sunMoved = true;
      const el = state.sun.el, lowSun = 1 - Math.min(1, Math.max(0, (el + 4) / 14));
      renderer.toneMappingExposure = (1.25 + 0.45 * lowSun * lowSun * (3 - 2 * lowSun)) * (1 + 0.6 * U.uNight.value);
      const bs = Math.max(0, Math.min(1, (el - 10) / 20));
      BLADE_SHADOW.value = 0.45 + 0.55 * bs * bs * (3 - 2 * bs);
      // glass panels go dark with the night
      $('#ui').classList.toggle('night', U.uNight.value > 0.5);
    }
    U.uTime.value = simT;
    // clouds drift with the wind (from windFrom towards the opposite side)
    const wa = state.windFrom * D2R, ws = state.wind * dt * 0.00016 * 1.4;
    U.uCloudOff.value.x -= Math.sin(wa) * ws; U.uCloudOff.value.y += Math.cos(wa) * ws;
    controls.update(dt);
    camMoved = lastCam.distanceTo(camera.position) > Math.max(0.1, controls.dist * 1e-4); if (camMoved) lastCam.copy(camera.position);
    // turbines
    const rpm = rotorRpm(state.wind), omega = (rpm / 60) * Math.PI * 2;
    const utc = Date.now() / 1000;
    const night = U.uNight.value, lightsOn = state.lights && (night > 0.05 || (state.sun && state.sun.el < 1.5));
    const blink = feuerW(utc);
    for (const t of turb.turbines) {
      t.rotor.rotation.x -= omega * dt;                    // clockwise seen from upwind (+x)
      t.yaw.rotation.y = (90 - (state.windFrom + t.yawJitter)) * D2R;
      for (const l of t.lights) { l.visible = lightsOn && blink === 1; if (l.userData.halo) l.material.opacity = 0.18 * Math.min(1, Math.max(0, (night - 0.3) / 0.6)); }
      for (const l of t.towerLights) l.visible = lightsOn;

    }
    for (const o of turb.others) { o.rotor.rotation.x -= omega * 0.9 * dt; o.yaw.rotation.y = (90 - state.windFrom) * D2R; }
    // shadow frustum follows the view (texel-snapped to avoid shimmering)
    const half = Math.min(2600, Math.max(320, controls.dist * 0.95));
    const sd = U.uSunDir.value;
    if (shadowCam.right !== half) { shadowCam.left = -half; shadowCam.right = half; shadowCam.top = half; shadowCam.bottom = -half; shadowCam.updateProjectionMatrix(); }
    const fw = Math.min(controls.dist, half * 0.5), ca = controls.az * D2R;
    const tx = camera.position.x + Math.sin(ca) * fw, tz = camera.position.z - Math.cos(ca) * fw;
    const ty = ground.height(tx, -tz);
    const texel = (2 * half) / Q.shadow;
    const sx = Math.round(tx / texel) * texel, sz = Math.round(tz / texel) * texel;
    sun.target.position.set(sx, ty, sz);
    sun.position.set(sx + sd.x * 5000, ty + Math.max(0.05, sd.y) * 5000, sz + sd.z * 5000);
    shadowCam.near = 100; shadowCam.far = 11000;
    sun.target.updateMatrixWorld();
    // dynamic near plane: generous when high up, small close to the ground or a turbine
    const cp = camera.position;
    const camH = cp.y - surface(cp.x, -cp.z);
    let near = Math.min(60, Math.max(0.6, camH * 0.25)), nearHub = Infinity;
    for (const t of turb.turbines) {
      const r = t.root.position, dh = Math.hypot(cp.x - r.x, cp.z - r.z);
      nearHub = Math.min(nearHub, Math.hypot(dh, cp.y - r.y - V172.hub));
      const toHub = Math.hypot(dh, cp.y - (r.y + V172.hub)) - 92;                        // outside the rotor sphere
      const toTower = Math.hypot(Math.max(0, dh - 6), Math.max(0, cp.y - r.y - V172.hub)); // tower axis segment
      near = Math.min(near, Math.max(0.5, Math.min(toHub, toTower) * 0.5));
    }
    if (Math.abs(camera.near - near) / camera.near > 0.1) { camera.near = near; camera.updateProjectionMatrix(); }
    // trees farther behind the camera than their shadows reach are skipped
    camera.getWorldDirection(camFwd);
    // (higher ground behind the camera throws its shadows farther: relief sampled every 25 m up to 800 m back)
    let relief = 0;
    {
      const fl = Math.hypot(camFwd.x, camFwd.z) || 1, bx = -camFwd.x / fl, bz = -camFwd.z / fl, g0 = surface(cp.x, -cp.z);
      for (let s = 25; s <= 800; s += 25) relief = Math.max(relief, ground.height(cp.x + bx * s, -(cp.z + bz * s)) - g0);
    }
    const tanEl = Math.tan(Math.max(2, state.sun.el) * D2R);
    const shadowReach = Math.min(1200, Math.max(60, Math.min(400, 35 / tanEl) + relief / tanEl));
    // near-field forest: individual trees around the view, the canopy shell sinks there
    {
      let nx, ny, on;
      if (camH < 260) {                       // low: trees around and ahead of the camera
        const a = controls.az * D2R, ahead = Math.min(controls.dist, 360);
        nx = cp.x + Math.sin(a) * ahead; ny = -cp.z + Math.cos(a) * ahead; on = true;
      } else {                                // aerial: between the camera and what it looks at
        const tg = controls.target, w = Math.min(1, controls.dist / 1600) * 0.5;
        nx = tg.x * (1 - w) + cp.x * w; ny = -(tg.z * (1 - w) + cp.z * w);
        on = camH < 520 * (Q.nearR / 520) && controls.dist < 1800 * (Q.nearR / 520);
      }
      nearForest.update(nx, ny, on && Math.abs(nx) < header.core - 200 && Math.abs(ny) < header.core - 200, cp, window.__PARK_TEST__ ? 1 : dt, camFwd, shadowReach, !!controls.flight && !window.__PARK_TEST__);
      // shell fully lowered at eye level (see between the trunks), to 40 % from the air (fills the gaps between crowns)
      NEAR.uSinkK.value = 0.6 + 0.4 * (1 - Math.min(1, Math.max(0, (camH - 40) / 80)));
      // trees fill the view at eye level: lift their shade there only
      TREE_U.uTreeLift.value = 1.15 + 0.45 * (1 - Math.min(1, Math.max(0, (camH - 15) / 25)));
    }
    // static trees: detail level by distance (beyond the last level the canopy shell carries the forest)
    trees.lod.update(cp, camFwd, shadowReach);
    power.update(cp);
    sky.position.copy(camera.position);
    farCamera.position.copy(camera.position); farCamera.quaternion.copy(camera.quaternion);
    farSun.position.copy(U.uSunDir.value); farSun.color.copy(sun.color); farSun.intensity = sun.intensity;
    farHemi.color.copy(hemi.color); farHemi.groundColor.copy(hemi.groundColor); farHemi.intensity = hemi.intensity;
    frameNo++;
    // shadow map refresh: rotor shadows at 30 Hz within 1.5 km of a hub, 15 Hz to 4 km, 8 Hz beyond (time-based, so a
    // 120 Hz display does not double the cost, and phase-locked so frame jitter does not slow it); at 30 Hz while the
    // sun moves; never with the sun below the horizon
    const shadowDt = sunMoved ? 1 / 30 : nearHub < 1500 ? 1 / 30 : nearHub < 4000 ? 1 / 15 : 1 / 8, ts = now / 1000;
    if (state.sun.el > 0 && ts - lastShadowT >= shadowDt - 0.004) {
      sun.shadow.needsUpdate = true; sunMoved = false;
      lastShadowT = ts - lastShadowT > 2 * shadowDt ? ts : lastShadowT + shadowDt;
    }
    renderer.info.reset();
    renderer.clear();
    renderer.render(farScene, farCamera);
    renderer.clearDepth();
    renderer.render(scene, camera);
    ui.frame(camera, controls, rpm);
    requestAnimationFrame(frame);
  }
  updateSun();
  progress('Compiling shaders', 0.94); await nextFrame();
  mark('built');
  // everything that may appear later too (night lights, far pylons) is compiled now, not at first use
  const hidden = [];
  scene.traverse((o) => { if (!o.visible && (o.isMesh || o.isSprite)) { hidden.push(o); o.visible = true; } });
  try { await Promise.all([earlyCompile, renderer.compileAsync(farScene, farCamera), renderer.compileAsync(scene, camera)]); } catch (e) { /* first frame compiles instead */ }
  for (const o of hidden) o.visible = false;
  mark('compiled');
  progress('Ready', 1);
  requestAnimationFrame((t) => { prevT = t; frame(t); mark('firstFrame'); requestAnimationFrame(() => { loading.classList.add('done'); setTimeout(() => loading.remove(), 900); }); });

  // debug / QA API
  window.__park = {
    header, data, ground, proj, scene, camera, renderer, controls, state, turbines: turb.turbines, views: Object.keys(views), goView, fm, Q,
    setTime: (h) => { state.minutes = h * 60; ui.syncTime(); },
    setView: (tgt, dist, az, el) => { controls.lockY = true; setFov(50); controls.set(new THREE.Vector3(...tgt), dist, az, el); },
    render: () => renderer.render(scene, camera),
    stats: () => ({ calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, programs: renderer.info.programs.length, trees: trees.count, treeLod: trees.lod.last, nearTrees: nearForest.last || 0, nearLod: nearForest.lod.last, buildings: bld.count, dpr, quality: Q, boot: marks }),
    trees: () => ({ n: trees.lod.n, ...trees.lod.src }),
    towerWorld: (id) => { const t = T[id]; const p = new THREE.Vector3(); t.root.getWorldPosition(p); return { x: p.x, y: -p.z, ground: p.y }; },
    surface,
  };
  window.dispatchEvent(new Event('park-ready'));
}

// ---------------------------------------------------------------------------------------------- UI
function setupUI({ header, state, goView, proj, ground, controls, T }) {
  const fmtT = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.floor(m % 60)).padStart(2, '0')}`;
  const time = $('#time'), timeOut = $('#time-out'), sunOut = $('#sun-out');
  const windDir = $('#wind-dir'), windSpd = $('#wind-spd'), windOut = $('#wind-out'), rpmOut = $('#rpm-out');
  time.value = state.minutes;
  time.addEventListener('input', () => { state.minutes = +time.value; timeOut.textContent = fmtT(state.minutes); });
  windDir.value = state.windFrom; windSpd.value = state.wind;
  const compassName = (a) => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(a / 22.5) % 16];
  const syncWind = () => { windOut.textContent = `${compassName(state.windFrom)} ${state.wind.toFixed(1)} m/s`; };
  windDir.addEventListener('input', () => { state.windFrom = +windDir.value; syncWind(); });
  windSpd.addEventListener('input', () => { state.wind = +windSpd.value; syncWind(); });
  syncWind();
  $('#more').addEventListener('click', (e) => { const open = $('#dock').classList.toggle('open'); e.currentTarget.setAttribute('aria-expanded', String(open)); window.dispatchEvent(new Event('park-layout')); });
  $('#play').addEventListener('click', (e) => { state.playing = !state.playing; e.currentTarget.setAttribute('aria-pressed', state.playing); e.currentTarget.textContent = state.playing ? 'Pause' : 'Play day'; });
  $('#lights').addEventListener('change', (e) => { state.lights = e.target.checked; });
  for (const b of document.querySelectorAll('[data-time]')) b.addEventListener('click', () => { state.minutes = +b.dataset.time; syncTime(); });
  for (const b of document.querySelectorAll('[data-view]')) b.addEventListener('click', () => goView(b.dataset.view));
  function syncTime() { time.value = Math.round(state.minutes); timeOut.textContent = fmtT(state.minutes); }
  syncTime();
  // turbine list
  const list = $('#wea-list');
  for (const t of header.turbines) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'wea'; b.dataset.id = t.id;
    b.innerHTML = `<span class="wea-id">${t.id.replace('WEA ', '')}</span>`;
    b.setAttribute('aria-label', `Fly to ${t.id}`);
    b.addEventListener('click', () => goView(t.id));
    list.appendChild(b);
  }
  const info = $('#info');
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtDate = (s) => { if (!s) return '–'; const [y, m, d] = s.split('-').map(Number); return `${d} ${MON[m - 1]} ${y}`; };
  // WEA 5: OSM start_date 2025-10-28, German Wikipedia 22 Aug 2025 — show both
  const DATE_NOTE = { 'WEA 5': 'Wikipedia: 22 Aug 2025' };
  function showTurbine(id) {
    for (const b of list.children) b.classList.toggle('on', b.dataset.id === id);
    if (!id) { info.hidden = true; return; }
    const t = T[id].info;
    info.hidden = false;
    $('#i-id').textContent = t.id;
    $('#i-date').textContent = fmtDate(t.start);
    const note = DATE_NOTE[t.id];
    if (note) { const sm = document.createElement('small'); sm.textContent = note; $('#i-date').append(sm); }
    $('#i-date').title = note ? 'OpenStreetMap start_date; German Wikipedia gives another date' : '';
    $('#i-pos').textContent = `${t.lat.toFixed(6)}, ${t.lon.toFixed(6)}`;
    $('#i-ground').textContent = `${t.ground.toFixed(0)} m a.s.l.`;
    $('#i-tip').textContent = `${(t.ground + t.hub + t.rotor / 2).toFixed(0)} m a.s.l.`;
    $('#i-mastr').textContent = t.mastr || '–';
  }
  $('#info-close').addEventListener('click', () => showTurbine(null));
  const srcBtn = $('#src-btn'), srcPanel = $('#sources');
  const setSrc = (open) => { srcPanel.hidden = !open; srcBtn.setAttribute('aria-expanded', String(open)); };
  srcBtn.addEventListener('click', () => setSrc(srcPanel.hidden));
  $('#src-close').addEventListener('click', () => setSrc(false));
  window.addEventListener('keydown', (e) => {
    if (e.target.closest && e.target.closest('input,select,textarea')) return;
    if (e.key === 'Escape') setSrc(false);
    if (e.key === 'h' || e.key === 'H') { $('#ui').classList.toggle('hide'); window.dispatchEvent(new Event('park-layout')); }
  });
  // compass & minimap
  const compass = $('#compass-needle');
  $('#compass').addEventListener('click', () => { controls.goal.az = 0; });
  const mm = $('#minimap'), mg = mm.getContext('2d');
  const base = document.createElement('canvas'); base.width = base.height = 256;
  (async () => {
    const bmp = await createImageBitmap(new Blob([b64bytes($('#img-core').textContent)], { type: 'image/webp' }));
    const g = base.getContext('2d'); g.filter = 'saturate(1.25) brightness(1.08)'; g.drawImage(bmp, 0, 0, 256, 256);
  })();
  const CORE = header.core, S = 256 / (2 * CORE);
  const mmXY = (x, y) => [(x + CORE) * S, (CORE - y) * S];
  mm.addEventListener('click', (e) => {
    const r = mm.getBoundingClientRect(), x = ((e.clientX - r.left) / r.width) * 256, y = ((e.clientY - r.top) / r.height) * 256;
    const lx = x / S - CORE, ly = CORE - y / S;
    controls.flyTo(new THREE.Vector3(lx, ground.height(lx, ly), -ly), Math.min(controls.dist, 2600), controls.az, Math.max(controls.el, 20), 1.6);
    controls.lockY = false;
  });
  const cursorOut = $('#cursor');
  let frameN = 0;
  return {
    showTurbine, syncTime,
    sun(s) { sunOut.textContent = s.el > -0.8 ? `Sun ${s.el.toFixed(0)}° above the horizon, ${compassName(s.az)}` : `Sun ${(-s.el).toFixed(0)}° below the horizon`; },
    cursor(p) {
      if (!p) { cursorOut.textContent = 'Hover the landscape for coordinates'; return; }
      const [lon, lat] = proj.toLonLat(p.x, p.y);
      cursorOut.textContent = `${lat.toFixed(5)}° N  ${lon.toFixed(5)}° E · ${p.h.toFixed(0)} m a.s.l.`;
    },
    frame(camera, ctl, rpm) {
      compass.style.transform = `rotate(${-ctl.az}deg)`;
      if ((frameN++ & 3) !== 0) return;
      rpmOut.textContent = `${rpm.toFixed(1)} rpm`;
      mg.clearRect(0, 0, 256, 256); mg.drawImage(base, 0, 0);
      // view cone
      const [cx, cy] = mmXY(camera.position.x, -camera.position.z), [tx, ty] = mmXY(ctl.target.x, -ctl.target.z);
      const a = ctl.az * D2R, spread = 28 * D2R, len = Math.max(18, Math.hypot(tx - cx, ty - cy) * 1.4);
      mg.fillStyle = 'rgba(255,255,255,0.22)'; mg.strokeStyle = 'rgba(255,255,255,0.8)'; mg.lineWidth = 1;
      mg.beginPath(); mg.moveTo(cx, cy);
      mg.lineTo(cx + Math.sin(a - spread) * len, cy - Math.cos(a - spread) * len); mg.lineTo(cx + Math.sin(a + spread) * len, cy - Math.cos(a + spread) * len);
      mg.closePath(); mg.fill(); mg.stroke();
      for (const t of header.turbines) {
        const [x, y] = mmXY(t.x, t.y);
        mg.fillStyle = state.selected === t.id ? '#ffd24a' : '#fff'; mg.strokeStyle = '#14323d'; mg.lineWidth = 1.5;
        mg.beginPath(); mg.arc(x, y, 3.2, 0, Math.PI * 2); mg.fill(); mg.stroke();
      }
      // 1 km scale
      mg.fillStyle = '#fff'; mg.fillRect(10, 244, 1000 * S, 2.5);
      mg.font = '600 10px Archivo, system-ui, sans-serif'; mg.fillText('1 km', 12, 240);
    },
  };
}

boot().catch((e) => {
  console.error(e);
  loadMsg.textContent = 'This view needs WebGL 2 and a current browser. ' + (e && e.message ? `(${e.message})` : '');
  document.getElementById('loading').classList.add('error');
});
