// Route page bench: node rp.cjs <url> <route hk|ml>   env: OUT=file.json PHASES=load,map,road,hot,ui PAR=1|0 W H HOTS=id,id KMS=k,k,k
// Per frame (exact): main-thread JS of the frame without the render call, render call CPU, draw calls, triangles, programs linked in
// the frame, time in blocking GL queries (program/shader status, uniform lookups) in the frame. Long tasks (> 50 ms) per phase.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs'), path = require('path');
const THREE_LOCAL = '/tmp/claude-0/-home-user-Interactive-Turbine-Lab/564bad2b-aee6-5ac6-9043-5b521443c8a3/scratchpad/node/three159/package/build/three.module.min.js';
const KMS = { hk: [212.4, 608.3, 902.6], ml: [37.2, 266.1, 455.4] };
const q = (a, f) => (a.length ? +a[Math.min(a.length - 1, Math.floor(f * a.length))].toFixed(2) : null);
const summ = (rows) => {     // rows: [t, dur, rend, calls, tris, links, blockMs, linkTotalInFrame]
  const R = rows.filter((x) => x[2] > 0), js = R.map((x) => x[1] - x[2]).sort((a, b) => a - b), rd = R.map((x) => x[2]).sort((a, b) => a - b);
  const all = rows.map((x) => x[1] - x[2]).sort((a, b) => a - b);
  const calls = R.map((x) => x[3]).sort((a, b) => a - b), tris = R.map((x) => x[4]).sort((a, b) => a - b);
  return { n: R.length, js: { p50: q(js, 0.5), p95: q(js, 0.95), max: q(js, 1) }, jsAll: { p95: q(all, 0.95), max: q(all, 1) }, render: { p50: q(rd, 0.5), p95: q(rd, 0.95), max: q(rd, 1) },
    calls: { p50: q(calls, 0.5), max: q(calls, 1) }, tris: { p50: q(tris, 0.5), max: q(tris, 1) }, links: rows.reduce((s, x) => s + x[5], 0), blockMs: +rows.reduce((s, x) => s + x[6], 0).toFixed(1), blockMax: +Math.max(0, ...rows.map((x) => x[6])).toFixed(1) };
};
(async () => {
  const [url, route] = process.argv.slice(2), PH = (process.env.PHASES || 'load,map,road,hot,ui').split(',');
  const args = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-precise-memory-info'];
  if (process.env.PAR !== '0') args.push('--enable-angle-features=enableParallelCompileAndLink');
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args });
  const ctx = await b.newContext({ viewport: { width: +(process.env.W || 1280), height: +(process.env.H || 800) }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  await p.route(/cdn\.jsdelivr\.net\/npm\/three@0\.159\.0\/.*/, (r) => r.fulfill({ path: THREE_LOCAL, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' } }));
  await p.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)); });
  await p.addInitScript(() => {
    try { localStorage.setItem('route-speed', '4'); } catch { /* */ }
    window.__ph = 'load';
    window.__lt = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push([Math.round(e.startTime), Math.round(e.duration), window.__ph]); }).observe({ entryTypes: ['longtask'] });
    const F = window.__F = { on: false, rows: [], inCb: false, rend: 0, calls: 0, tris: 0, links: 0, block: 0, firstDraw: 0, firstFrameEnd: 0, drew: false, linkAll: 0, firstOf: new Map() };
    const P = WebGL2RenderingContext.prototype;
    const ol = P.linkProgram; P.linkProgram = function (pr) { F.linkAll++; if (F.inCb) F.links++; return ol.call(this, pr); };
    for (const n of ['getProgramParameter', 'getShaderParameter', 'getProgramInfoLog', 'getShaderInfoLog', 'getUniformLocation', 'getActiveUniform', 'getAttribLocation', 'getActiveAttrib', 'getUniformBlockIndex', 'readPixels', 'getError']) {
      const o = P[n]; P[n] = function (...a) { if (!F.inCb) return o.apply(this, a); const t = performance.now(); try { return o.apply(this, a); } finally { F.block += performance.now() - t; } };
    }
    const dk = ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced'], od = {};
    for (const n of dk) { od[n] = P[n]; P[n] = function (...a) { if (!F.firstDraw) { F.firstDraw = performance.now(); F.drew = true; for (const k of dk) P[k] = od[k]; } return od[n].apply(this, a); }; }
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => raf((ts) => {
      const a = performance.now(); F.inCb = true; F.rend = 0; F.calls = 0; F.tris = 0; F.links = 0; F.block = 0;
      try { cb(ts); } finally {
        F.inCb = false; const d = performance.now() - a;
        if (F.drew && !F.firstFrameEnd) F.firstFrameEnd = performance.now();
        if (F.on && (d > 0.2 || F.rend > 0)) F.rows.push([a, d, F.rend, F.calls, F.tris, F.links, F.block]);
      }
    });
    let rv; Object.defineProperty(window, '__route', { configurable: true, get: () => rv, set: (v) => { rv = v; F.routeAt = performance.now();
      const R = v.renderer, o = R.render.bind(R);
      R.render = (s, c) => { const t = performance.now(); o(s, c); const dt = performance.now() - t; F.rend += dt; F.calls += R.info.render.calls; F.tris += R.info.render.triangles; if (!F.firstOf.has(s)) F.firstOf.set(s, performance.now()); };
    } });
  });
  const out = { url, route, par: process.env.PAR !== '0', W: +(process.env.W || 1280), H: +(process.env.H || 800) };
  const phase = (n) => p.evaluate((n) => { window.__ph = n; }, n);
  const ltSince = (t0) => p.evaluate((t0) => window.__lt.filter((x) => x[0] >= t0), t0);
  const now = () => p.evaluate(() => performance.now());
  const rec = async (fn) => { await p.evaluate(() => { window.__F.rows = []; window.__F.on = true; }); const t0 = await now(); await fn(); const rows = await p.evaluate(() => { const F = window.__F; F.on = false; return F.rows; }); const lt = await ltSince(t0); return { ...summ(rows), lt: lt.map((x) => x[1]), ltMax: Math.max(0, ...lt.map((x) => x[1])) }; };
  const heap = () => p.evaluate(() => +(performance.memory.usedJSHeapSize / 1048576).toFixed(1));
  const wait = (ms) => p.waitForTimeout(ms);

  // ---------------------------------------------------------------- load
  const t0 = Date.now();
  await p.goto(url);
  await p.waitForFunction(() => window.__route, null, { timeout: 300000, polling: 50 });
  await wait(4000);
  out.load = await p.evaluate(() => { const F = window.__F, nav = performance.getEntriesByType('navigation')[0];
    return { firstDraw: Math.round(F.firstDraw), firstFrameEnd: Math.round(F.firstFrameEnd), routeReady: Math.round(F.routeAt), domContentLoaded: Math.round(nav.domContentLoadedEventEnd), linksTotal: F.linkAll,
      ltAll: window.__lt.map((x) => [x[0], x[1]]), ltAfterFirst: window.__lt.filter((x) => x[0] >= F.firstFrameEnd).map((x) => [x[0], x[1]]), heapMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) }; });
  out.load.wall = Date.now() - t0;
  const hots = await p.evaluate(() => JSON.parse(document.querySelector('#route-header').textContent).hot.map((h) => h.id));
  const hdIds = await p.evaluate(() => fetch('h/index.json').then((r) => r.json()).then((j) => j.ids).catch(() => []));
  console.error('load', JSON.stringify(out.load).slice(0, 200));

  const save = () => { if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(out)); };
  save();
  // ---------------------------------------------------------------- map: drag (orbit), shift-drag (pan), wheel zoom, fly home
  if (PH.includes('map')) {
    await phase('map');
    const W = out.W, H = out.H;
    out.map = await rec(async () => {
      await p.mouse.move(W / 2, H / 2); await p.mouse.down();
      for (let i = 0; i < 30; i++) { await p.mouse.move(W / 2 + i * 8, H / 2 + i * 2); await wait(40); }
      await p.mouse.up(); await wait(500);
      await p.keyboard.down('Shift'); await p.mouse.move(W / 2, H / 2); await p.mouse.down();
      for (let i = 0; i < 30; i++) { await p.mouse.move(W / 2 - i * 10, H / 2 - i * 4); await wait(40); }
      await p.mouse.up(); await p.keyboard.up('Shift'); await wait(500);
      for (let i = 0; i < 12; i++) { await p.mouse.wheel(0, -400); await wait(90); }
      await wait(800);
      for (let i = 0; i < 12; i++) { await p.mouse.wheel(0, 400); await wait(90); }
      await wait(800);
      await p.evaluate(() => window.__route.goRoute()); await wait(2600);
    });
    console.error('map', JSON.stringify(out.map).slice(0, 300)); save();
  }

  // ---------------------------------------------------------------- road: open at three points (from the map), drive normal, then fast with pack crossings
  if (PH.includes('road')) {
    out.road = [];
    const kms = process.env.KMS ? process.env.KMS.split(',').map(Number) : KMS[route];
    for (let i = 0; i < kms.length; i++) {
      const k = kms[i], r = { km: k };
      await p.evaluate(() => window.__route.goRoute()); await wait(2600);
      await phase('roadopen' + i);
      const ta = await now();
      await p.evaluate(() => { window.__F.rows = []; window.__F.on = true; });
      await p.evaluate((k) => { window.__route.openRoad(k); }, k);
      await p.waitForFunction(() => { const R = window.__route; return R.ROAD && window.__F.firstOf.has(R.ROAD.scene); }, null, { timeout: 120000, polling: 50 });
      r.openMs = Math.round((await p.evaluate(() => window.__F.firstOf.get(window.__route.ROAD.scene))) - ta);
      await wait(15000);
      { const rows = await p.evaluate(() => { const F = window.__F; F.on = false; return F.rows; }); const lt = await ltSince(ta); r.open = { ...summ(rows), lt: lt.map((x) => x[1]), ltMax: Math.max(0, ...lt.map((x) => x[1])) }; }
      r.packs = await p.evaluate(() => [...window.__route.ROAD.packs.keys()]);
      r.build = await p.evaluate(() => window.__route.ROAD.buildStats());
      await phase('drive' + i);
      await p.click('#play');
      r.drive = await rec(() => wait(12000));
      // fast: 200 km/h and a 400 m step every 2.5 s (≈ 720 km/h on average: crosses packs within the test)
      await phase('fast' + i);
      for (let j = 0; j < 4; j++) await p.click('#spd-up');
      r.fast = await rec(async () => { for (let j = 0; j < 12; j++) { await p.evaluate(() => { const R = window.__route; R.setRoadS(+document.getElementById('km').value * 1000 + 400); }); await wait(2500); } });
      for (let j = 0; j < 4; j++) await p.click('#spd-dn');
      await p.click('#play');
      r.kmEnd = await p.evaluate(() => +document.getElementById('km').value);
      r.packsEnd = await p.evaluate(() => [...window.__route.ROAD.packs.keys()]);
      r.heapMB = await heap();
      r.info = await p.evaluate(() => { const i = window.__route.renderer.info; return { progs: i.programs.length, geoms: i.memory.geometries, tex: i.memory.textures }; });
      out.road.push(r); save();
      console.error('road', JSON.stringify(r).slice(0, 400));
    }
  }

  // ---------------------------------------------------------------- HD passages: open each from the map, drive 5 s, close
  if (PH.includes('hot')) {
    out.hot = [];
    const list = process.env.HOTS ? process.env.HOTS.split(',') : hots;
    for (const id of list) {
      const r = { id, hd: hdIds.includes(id) };
      await phase('open:' + id);
      const ta = await now();
      await p.evaluate(() => { window.__F.rows = []; window.__F.on = true; window.__F.hotScenes = []; });
      await p.evaluate((id) => { window.__route.openHot(id); }, id);
      // ready: the passage's final scene (the survey-grade one where it has h/ data) drawn
      try {
        await p.waitForFunction((hd) => { const R = window.__route, H = R.HOT; return H && window.__F.firstOf.has(H.scene) && (!hd || (H.treeCount !== undefined && R.HOT.H && document.querySelector('#hot-out').textContent.indexOf('loading') < 0)); }, r.hd, { timeout: 120000, polling: 50 });
      } catch (e) { r.err = 'timeout'; }
      r.openMs = Math.round((await p.evaluate(() => { const H = window.__route.HOT; return H ? window.__F.firstOf.get(H.scene) || 0 : 0; })) - ta);
      await wait(3000);
      { const rows = await p.evaluate(() => { const F = window.__F; F.on = false; return F.rows; }); const lt = await ltSince(ta); r.open = { ...summ(rows), lt: lt.map((x) => x[1]), ltMax: Math.max(0, ...lt.map((x) => x[1])) }; }
      await phase('hotdrive:' + id);
      r.drive = await rec(() => wait(5000));
      await phase('close:' + id);
      r.close = await rec(async () => { await p.evaluate(() => window.__route.goRoute()); await wait(2600); });
      out.hot.push(r); save();
      console.error('hot', id, JSON.stringify({ openMs: r.openMs, openLt: r.open.lt, js: r.drive.js, calls: r.drive.calls, tris: r.drive.tris, links: r.drive.links, closeLt: r.close.lt }));
    }
  }

  // ---------------------------------------------------------------- UI: switches in a passage and in the road view, photo match, vehicle panel (swept path again)
  if (PH.includes('ui')) {
    out.ui = {};
    const click = (sel) => p.evaluate((sel) => document.querySelector(sel).click(), sel);
    const act = async (name, fn, ms = 1800) => { await phase('ui:' + name); out.ui[name] = await rec(async () => { await fn(); await wait(ms); }); console.error('ui', name, JSON.stringify({ lt: out.ui[name].lt, links: out.ui[name].links, js: out.ui[name].js })); save(); };
    const hid = hdIds[Math.floor(hdIds.length / 2)] || hots[1];
    await p.evaluate((id) => window.__route.openHot(id), hid);
    await p.waitForFunction(() => { const H = window.__route.HOT; return H && window.__F.firstOf.has(H.scene) && document.querySelector('#hot-out').textContent.indexOf('loading') < 0; }, null, { timeout: 120000 });
    await wait(4000);
    for (const t of ['t-night', 't-swept', 't-roads3d']) { await act('hot-' + t + '-on', () => click('#' + t)); await act('hot-' + t + '-off', () => click('#' + t)); }
    await act('hot-photo-on', () => click('#t-photo'), 3000); await act('hot-photo-off', () => click('#pm-close'), 1500);
    await act('road-open', () => p.evaluate((k) => { window.__route.openRoad(k); }, KMS[route][1]), 15000);
    for (const t of ['t-night', 't-swept', 't-roads3d']) { await act('road-' + t + '-on', () => click('#' + t)); await act('road-' + t + '-off', () => click('#' + t)); }
    await act('road-photo-on', () => click('#t-photo'), 3000); await act('road-photo-off', () => click('#pm-close'), 1500);
    await act('veh-open', () => click('#veh-btn'));
    await act('veh-apply', async () => { await p.evaluate(() => { const el = document.querySelector('#veh-form input[name="height"]') || document.querySelector('#veh-form input'); el.value = String(+el.value + 0.1); }); await click('#veh-apply'); }, 3000);
    await act('veh-reset', async () => { await click('#veh-reset'); }, 3000);
    await act('veh-close', () => click('#veh-close'));
    await act('src-open', () => click('#src-btn')); await act('src-close', () => click('#src-close'));
    await act('road-drive', async () => { await click('#play'); await wait(6000); await click('#play'); });
    await act('back-map', () => p.evaluate(() => window.__route.goRoute()), 3000);
  }
  out.heapEnd = await heap();
  out.ltTotal = (await p.evaluate(() => window.__lt.length));
  out.errs = errs.slice(0, 10);
  if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(out));
  console.log(JSON.stringify({ load: out.load && { firstDraw: out.load.firstDraw, firstFrameEnd: out.load.firstFrameEnd, ltAfterFirst: out.load.ltAfterFirst }, errs: out.errs }));
  await b.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
