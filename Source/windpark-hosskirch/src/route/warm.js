// Everything a view draws is made ready before it is shown, a few milliseconds at a time between frames, so that no frame
// waits on the GPU: the materials prepared (their programs compiled and linked in the background where the browser has
// KHR_parallel_shader_compile), the shadow pass's depth programs (the very programs three.js builds for it, prepared on
// proxies of the casters), the textures uploaded, and each new program's uniforms and attributes read once the GPU has
// caught up with the frames (a fence after the last frame, checked at the start of the next): such a read while the GPU
// is busy waits for all of its queued work, which is what made a passage's first frames stall.
import * as THREE from 'three';

// ---------------------------------------------------------------- time slices
// background work runs in slices of `budget` ms, each a task of its own: between two slices the browser draws a frame
// when one is due, so a frame never waits longer than one slice, and the work goes on in the time the frames leave
// (pacing it by frames instead starved it where frames are slow: a software GPU drawing two a second)
let urgent = 0;
// while the reader waits for a view to open (urgent), slices are longer (12 ms): the view opens sooner
export const setUrgent = (on) => { urgent = Math.max(0, urgent + (on ? 1 : -1)); };
const mc = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null, mq = [];
if (mc) mc.port1.onmessage = () => { const f = mq.shift(); if (f) f(); };
const task = () => new Promise((r) => { if (mc) { mq.push(r); mc.port2.postMessage(0); } else setTimeout(r, 0); });
export function slicer(budget = 6) {
  let t = performance.now();
  const b = () => (urgent ? Math.max(budget, 12) : budget);
  const s = async () => { if (performance.now() - t < b()) return; await task(); t = performance.now(); };
  s.due = () => performance.now() - t >= b();              // (for tight loops: if (s.due()) await s();)
  return s;
}

const SHADOW_SIDE = { [THREE.FrontSide]: THREE.BackSide, [THREE.BackSide]: THREE.FrontSide, [THREE.DoubleSide]: THREE.DoubleSide };
const mats = (o) => (Array.isArray(o.material) ? o.material : o.material ? [o.material] : []);

export function makeWarmer(renderer) {
  const gl = renderer.getContext(), props = renderer.properties;
  const PAR = !!renderer.extensions.get('KHR_parallel_shader_compile');
  const used = new WeakSet();              // programs whose uniforms and attributes have been read
  const jobs = [];                         // work that needs an idle GPU: [fn, queued at]
  let fence = null;
  const rt = new THREE.WebGLRenderTarget(1, 1);
  const depthMats = new Map();             // the depth materials of the proxies, kept: their programs stay alive for the shadow pass
  const stats = { programs: 0, textures: 0, slotRuns: 0, starved: 0, upRounds: 0, upWaitMs: 0, upMs: 0, upMax: 0, upBytes: 0, drawn: 0, held: 0 };

  // ---------------------------------------------------------------- the GPU slot: jobs run at the start of a frame once
  // the fence after the last drawn frame has passed (a GPU busy with the frames leaves them a few milliseconds per frame).
  // While the reader waits for a view to open (urgent) on a GPU that cannot keep up — a job, an upload or a program link
  // waiting more than 250 ms — frames go off (hold) and the work drains with the GPU idle; one frame is drawn now and
  // then, after at least 2 s and at least 4 times what the last frame cost the GPU (a slow GPU spends at most a fifth of
  // its time on them). Otherwise (background work: driving, the next packs) a frame only waits while a fence is overdue.
  const fenceNow = () => { if (fence) gl.deleteSync(fence); fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); gl.flush(); };
  let drainT = 0;                          // since when frames are off for the work to drain (-1: one frame through; 0: on)
  let fenceT = 0, gpuLast = 0;             // when the fence after the last drawn frame was set, what that frame cost the GPU
  let parN = 0, parT = 0;                  // programs being linked in the background: how many prepares wait, since when
  const W = { hold: false };
  function queue(fn) { jobs.push([fn, performance.now()]); if (!fence) fenceNow(); }
  function frameStart(now, budget = 3) {
    W.hold = false;
    let due = false;                       // the fence after the last frame not passed yet
    if (fence) { if (gl.getSyncParameter(fence, gl.SYNC_STATUS) === gl.SIGNALED) { gl.deleteSync(fence); fence = null; if (fenceT) { gpuLast = now - fenceT; fenceT = 0; } } else due = true; }
    const late = (jobs.length && now - jobs[0][1] > 250) || (ups.length && now - ups[0][2] > 250) || (upRunning && upWait && now - upWait > 250) || (parN && now - parT > 250);
    if (urgent && late) {
      if (drainT === 0) { drainT = now; stats.starved++; }
      else if (drainT === -1) drainT = now;
      else if (now - drainT > Math.max(2000, 4 * gpuLast)) drainT = -1;
    } else drainT = 0;
    if (drainT > 0) W.hold = true;
    else if ((due && jobs.length && now - jobs[0][1] > 250) || (upFence && upWait && now - upWait > 250)) W.hold = true;      // (a job or an upload batch waiting on the GPU: no new frame before it)
    if (!jobs.length || due) return;
    stats.slotRuns++; W.inSlot = true;
    const t0 = performance.now(), b = W.hold ? 10 : budget;
    do { const [fn] = jobs.shift(); try { fn(); } catch (e) { console.warn(e); } } while (jobs.length && performance.now() - t0 < b);
    W.inSlot = false;
  }
  // uploads (textures, vertex buffers) run in tasks of their own between frames (never inside one), about 4 MB at a
  // time, the next batch once the GPU has taken in the one before (a fence after it): issued faster than the GPU consumes
  // them, an upload waits for room in the command stream, and the main thread with it
  const ups = []; let upRunning = false, upFence = null, upWait = 0;
  async function upload(fn, bytes) {
    ups.push([fn, bytes, performance.now()]); if (upRunning) return; upRunning = true;
    try {
      while (ups.length) {
        upWait = performance.now();
        while (upFence && gl.getSyncParameter(upFence, gl.SYNC_STATUS) !== gl.SIGNALED) await new Promise((r) => setTimeout(r, 4));
        stats.upWaitMs += performance.now() - upWait; stats.upRounds++; upWait = 0; if (upFence) { gl.deleteSync(upFence); upFence = null; }
        let sent = 0;
        while (ups.length && sent < 4e6) { const [f, n] = ups.shift(); sent += n || 1e6; const t1 = performance.now(); try { f(); } catch (e) { console.warn(e); } const dt = performance.now() - t1; stats.upMs += dt; stats.upMax = Math.max(stats.upMax, dt); stats.upBytes += n || 0; await task(); }
        upFence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); gl.flush();
      }
    } finally { upRunning = false; }
  }
  function frameEnd(drew) {
    if (drew) stats.drawn++; else if (W.hold) stats.held++;
    if (drew && (jobs.length || ((upRunning || parN) && urgent))) { fenceNow(); fenceT = performance.now(); }      // (what the frame costs the GPU: measured while work waits)
  }
  // vertex buffers uploaded without drawing: rendering the objects' groups into a 1 × 1 target with every material hidden
  // uploads their geometry (three.js updates an object's buffers before it looks at its material) and draws nothing
  const upCam = new THREE.PerspectiveCamera();
  function uploadGeometry(objs) {
    const roots = new Set(), saved = [], vis = [];
    for (const o of objs) if (o.parent) roots.add(o.parent);
    for (const r of roots) r.traverse((o) => { for (const m of mats(o)) if (m.visible) { m.visible = false; saved.push(m); } });
    for (const o of objs) { vis.push(o.visible, o.frustumCulled); o.visible = true; o.frustumCulled = false; }
    const prev = renderer.getRenderTarget(), nu = renderer.shadowMap.needsUpdate, ac = renderer.autoClear; renderer.shadowMap.needsUpdate = false; renderer.autoClear = false;
    renderer.setRenderTarget(rt);
    try { for (const r of roots) { const obr = r.onBeforeRender; r.onBeforeRender = () => {}; try { renderer.render(r, upCam); } finally { r.onBeforeRender = obr; } } }
    finally { renderer.setRenderTarget(prev); renderer.shadowMap.needsUpdate = nu; renderer.autoClear = ac; objs.forEach((o, i) => { o.visible = vis[2 * i]; o.frustumCulled = vis[2 * i + 1]; }); for (const m of saved) m.visible = true; }
  }

  // ---------------------------------------------------------------- preparing objects
  // the programs of a material (both sides of a two-sided transparent one)
  const progsOf = (m, out) => { const p = props.get(m); if (p.programs) for (const q of p.programs.values()) out.add(q); };
  // a proxy of shadow caster o drawn with the depth material three.js's shadow pass would use for it (same side rule, the
  // alpha-tested variant with its map), so the program built for the proxy is the one the shadow pass will ask for
  function depthProxies(o, out) {
    for (const m of mats(o)) {
      const side = m.shadowSide !== null && m.shadowSide !== undefined ? m.shadowSide : SHADOW_SIDE[m.side];
      const alpha = (m.map && m.alphaTest > 0) || (m.alphaMap && m.alphaTest > 0) || (m.displacementMap && m.displacementScale !== 0);
      const key = side + (alpha ? `|${!!m.map}|${!!m.alphaMap}|${!!m.displacementMap}` : '');
      let d = depthMats.get(key);
      if (!d) {
        d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }); d.side = side;
        if (alpha) { d.map = m.map; d.alphaMap = m.alphaMap; d.alphaTest = m.alphaTest; d.displacementMap = m.displacementMap; d.displacementScale = m.displacementScale; }
        depthMats.set(key, d);
      }
      out.push(Object.create(o, { material: { value: d, writable: true } }));
    }
  }
  // objects drawn with another material (the photo match's shadow catcher): proxies, one per kind of object
  function overrideProxies(objs, material, out) {
    const seen = new Set();
    for (const o of objs) { const k = `${!!o.isInstancedMesh}|${!!(o.isInstancedMesh && o.instanceColor)}|${!!o.receiveShadow}|${o.isPoints ? 1 : o.isLine ? 2 : 0}|${!!o.geometry.attributes.color}`;
      if (seen.has(k)) continue; seen.add(k); out.push(Object.create(o, { material: { value: material, writable: true } })); }
  }
  const texOf = (v, T) => { if (v && v.isTexture) T.add(v); else if (Array.isArray(v)) for (const x of v) if (x && x.isTexture) T.add(x); };
  /**
   * objs: the objects about to be shown (or a root to traverse); scene: the scene they are (or will be) in, for its lights;
   * cam: the camera. opts.slice: a slicer; opts.override: [material, objects] drawn with it as well (photo match);
   * opts.geometry: false leaves the vertex buffers to the first frame; opts.mk(label): progress for the console.
   * Resolves once every program is linked and has been used once and every texture is uploaded.
   */
  async function prepare(objs, scene, cam, opts = {}) {
    if (!Array.isArray(objs)) { const root = objs; objs = []; root.traverse((o) => { if (o.material && o.geometry) objs.push(o); }); }
    const slice = opts.slice || slicer(5), progs = new Set(), shadow = [], T = new Set();
    const batch = [], fake = { traverse: (cb) => { for (const o of batch) cb(o); }, traverseVisible() { /* lights come from the scene */ } };
    // one renderer.compile over a few objects (into a render target for the shadow pass: no tone mapping, linear output)
    const live = (o) => mats(o).every((m) => !(m.userData && m.userData.pool && !m.map));       // (a pooled material back in the pool has no map)
    const run = (list, target) => {
      list = list.filter(live); if (!list.length) return;
      batch.length = 0; batch.push(...list);
      if (target) { const prev = renderer.getRenderTarget(); renderer.setRenderTarget(rt); try { renderer.compile(fake, cam, scene); } finally { renderer.setRenderTarget(prev); } }
      else renderer.compile(fake, cam, scene);
      for (const o of list) for (const m of mats(o)) progsOf(m, progs);
      batch.length = 0;
    };
    // the materials as drawn, then the casters' depth programs, then what is drawn with an override material; the bounds
    // the first frame's culling would compute (the same, made here)
    for (let i = 0; i < objs.length; i += 6) { run(objs.slice(i, i + 6), false); if (slice.due()) await slice(); }
    for (const o of objs) { const g = o.geometry; if (g && !g.boundingSphere && g.attributes.position && !o.isInstancedMesh) { g.computeBoundingSphere(); if (slice.due()) await slice(); } }
    for (const o of objs) if (o.castShadow && (o.isMesh || o.isLine || o.isPoints)) depthProxies(o, shadow);
    const mk = opts.mk || (() => {}); mk('materials prepared');
    for (let i = 0; i < shadow.length; i += 8) { run(shadow.slice(i, i + 8), true); if (slice.due()) await slice(); }
    mk('shadow programs prepared');
    if (opts.override) { const ov = []; overrideProxies(opts.override[1] || objs, opts.override[0], ov); for (let i = 0; i < ov.length; i += 6) { run(ov.slice(i, i + 6), false); if (slice.due()) await slice(); } }
    // textures (maps and the textures among the uniforms of the patched shaders)
    for (const o of objs) for (const m of mats(o)) {
      texOf(m.map, T); texOf(m.emissiveMap, T); texOf(m.alphaMap, T); texOf(m.normalMap, T); texOf(m.roughnessMap, T);
      const u = props.get(m).uniforms || m.uniforms; if (u) for (const k in u) texOf(u[k] && u[k].value, T);
    }
    // programs linked in the background (polled, never waited on), then used once with an idle GPU
    // (a program released meanwhile, its material disposed or changed, is gone: no longer waited for; nor any after 10 s)
    if (PAR) { let pend = [...progs]; const t0 = performance.now(); if (!parN++) parT = t0;
      try { while (pend.length && performance.now() - t0 < 10000) { pend = pend.filter((p) => p.program && !p.isReady()); if (pend.length) await new Promise((r) => setTimeout(r, 8)); } } finally { if (!--parN) parT = 0; } }
    mk('programs linked'); let left = 0, done = null; const fin = new Promise((r) => { done = r; });
    const add = (fn, gpu = true, bytes = 0) => { left++; const f = () => { try { fn(); } finally { if (--left === 0) done(); } }; if (gpu) queue(f); else upload(f, bytes); };
    for (const p of progs) if (!used.has(p) && p.program) { used.add(p); stats.programs++; add(() => { if (p.program) { p.getUniforms(); p.getAttributes(); } }); }
    for (const t of T) { const tp = props.get(t); if (t.image === null || t.image === undefined || (tp.__version === t.version && tp.__webglTexture)) continue; stats.textures++; const im = t.image; add(() => renderer.initTexture(t), false, (im.width || 1) * (im.height || 1) * 4); }
    if (opts.geometry !== false) { let b = [], bytes = 0;
      const bytesOf = (o) => { let n = 0; const g = o.geometry; for (const k in g.attributes) n += g.attributes[k].array.byteLength; if (g.index) n += g.index.array.byteLength; if (o.isInstancedMesh) n += o.instanceMatrix.array.byteLength; return n; };
      for (const o of objs) { if (!o.parent || !o.geometry) continue; b.push(o); bytes += bytesOf(o); if (bytes > 1e6) { const bb = b, nb = bytes; add(() => uploadGeometry(bb), false, nb); b = []; bytes = 0; } }
      if (b.length) { const bb = b, nb = bytes; add(() => uploadGeometry(bb), false, nb); } }
    mk(`${left} jobs queued`); if (left) await fin;
    return { programs: progs.size, textures: T.size };
  }
  // a scene about to be shown gets its lights set up now: three.js draws a frame's shadows before it sets up that frame's
  // lights, so a scene's first frame would ask for shadow programs keyed to "no lights" (built and linked in that frame)
  const none = { traverse() { /* no materials */ }, traverseVisible() { /* lights come from the scene */ } };
  const primeLights = (scene, cam) => renderer.compile(none, cam, scene);
  return Object.assign(W, { prepare, primeLights, frameStart, frameEnd, queue, stats, get pending() { return jobs.length; }, PAR, isUsed: (p) => used.has(p) });
}
