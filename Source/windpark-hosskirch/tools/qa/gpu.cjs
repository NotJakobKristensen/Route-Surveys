// Relative GPU cost (software GPU): node gpu.cjs <url> <route> [W H]   env ABL=1: ablations (groups hidden, shadow pass)
// At fixed cameras and pixel ratio 1: median time of renderer.render + a 1-pixel read-back (waits for the GPU) over 5 frames.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const THREE_LOCAL = '/tmp/claude-0/-home-user-Interactive-Turbine-Lab/564bad2b-aee6-5ac6-9043-5b521443c8a3/scratchpad/node/three159/package/build/three.module.min.js';
const KMS = { hk: [212.4, 608.3, 902.6], ml: [37.2, 266.1, 455.4] };
const HOTS = { hk: ['gaisbeuren', 'niederbiegen', 'forest'], ml: ['muenster-lech-moos', 'muenster-lech-feldheim', 'muenster-lech-pessenburgheim'] };
(async () => {
  const [url, route, W = 2560, H = 1440] = process.argv.slice(2);
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-angle-features=enableParallelCompileAndLink'] });
  const p = await (await b.newContext({ viewport: { width: +W, height: +H }, deviceScaleFactor: 1 })).newPage();
  await p.route(/cdn\.jsdelivr\.net\/npm\/three@0\.159\.0\/.*/, (r) => r.fulfill({ path: THREE_LOCAL, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' } }));
  await p.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await p.addInitScript(() => { let rv; Object.defineProperty(window, '__route', { configurable: true, get: () => rv, set: (v) => { rv = v; v.renderer.setPixelRatio(1); v.renderer.setPixelRatio = () => {}; } }); });
  await p.goto(url); await p.waitForFunction(() => window.__route, null, { timeout: 300000 }); await p.waitForTimeout(3000);
  // time a frame: stop the page's own loop from drawing (a huge idle), then draw ourselves
  const time = (label) => p.evaluate(async (label) => {
    const R = window.__route, r = R.renderer, gl = r.getContext(), px = new Uint8Array(4);
    const sc = R.HOT && document.querySelector('#ui').className.includes('hot-mode') && !document.querySelector('#ui').className.includes('road-mode') ? R.HOT.scene : R.ROAD && document.querySelector('#ui').className.includes('road-mode') ? R.ROAD.scene : R.M.scene;
    const cam = sc === R.M.scene ? R.mcam : R.hcam; const ts = [];
    for (let i = 0; i < 6; i++) { r.shadowMap.needsUpdate = true; const t0 = performance.now(); r.render(sc, cam); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); ts.push(performance.now() - t0); }
    ts.shift(); ts.sort((a, b) => a - b); return { label, ms: +ts[ts.length >> 1].toFixed(0), calls: r.info.render.calls, tris: r.info.render.triangles };
  }, label);
  const out = [];
  out.push(await time('map'));
  for (const k of KMS[route]) {
    await p.evaluate((k) => window.__route.openRoad(k), k);
    await p.waitForFunction(() => { const Q = window.__route.ROAD; if (!Q || !document.querySelector('#ui').className.includes('road-mode')) return false; for (const P of Q.packs.values()) if (P.medRuns === undefined) return false; return Q.packs.size >= 2; }, null, { timeout: 300000, polling: 500 });
    await p.waitForTimeout(5000);
    await p.evaluate(() => { const R = window.__route, Q = R.ROAD, s = +document.getElementById('km').value * 1000, q = Q.at(s); R.rctl.set(new R.hcam.position.constructor(q.x, q.z, -q.y), 140, Math.atan2(q.nx, q.ny) * 180 / Math.PI + 215, 34, true); R.rctl.update(0); R.hcam.updateMatrixWorld(); });
    await p.waitForTimeout(1500);
    out.push(await time('road ' + k));
    if (process.env.ABL) {
      for (const [nm, fn] of [['no shadow pass', 'r.shadowMap.enabled=false'], ['no trees/objects (objGroup)', 'Q.scene.children[2].visible=false'], ['no strips (roadGroup)', 'Q.scene.children[0].visible=false'], ['no 3D roads', 'Q.scene.children[3].visible=false']]) {
        await p.evaluate((fn) => { const R = window.__route, r = R.renderer, Q = R.ROAD; window.__undo = []; eval(fn); }, fn);
        out.push(await time('  ' + nm));
        await p.evaluate(() => { const R = window.__route, r = R.renderer, Q = R.ROAD; r.shadowMap.enabled = true; for (const c of Q.scene.children) if (c.isGroup) c.visible = true; });
      }
    }
  }
  for (const id of HOTS[route]) {
    await p.evaluate((id) => window.__route.openHot(id), id);
    await p.waitForFunction(() => { const H = window.__route.HOT; return H && document.querySelector('#ui').className.includes('hot-mode') && !document.querySelector('#ui').className.includes('road-mode') && document.querySelector('#hot-out').textContent.indexOf('loading') < 0; }, null, { timeout: 300000, polling: 500 });
    await p.waitForTimeout(4000);
    await p.evaluate(() => { const R = window.__route, H = R.HOT, P = H.H.path, n = P.length / 2, i = n >> 1, x = P[2 * i], y = P[2 * i + 1]; R.setHotU(0.45); R.hctl.set(new R.hcam.position.constructor(x, H.surface(x, y), -y), 160, 40, 38, true); R.hctl.update(0); R.hcam.updateMatrixWorld(); });
    await p.waitForTimeout(1500);
    out.push(await time('hot ' + id));
    if (process.env.ABL) {
      await p.evaluate(() => { window.__route.renderer.shadowMap.enabled = false; }); out.push(await time('  no shadow pass')); await p.evaluate(() => { window.__route.renderer.shadowMap.enabled = true; });
    }
  }
  for (const o of out) console.log(JSON.stringify(o));
  await b.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
