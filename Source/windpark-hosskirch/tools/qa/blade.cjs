// Blade beyond the edge, both views, in the page itself: node blade.cjs <url> <out.json> [ids|all] [new|old]
// default view: the passage's painted kind-3 area (rings, passage frame) and its card's figure; drive view: the road opened in
// the passage, the drawn blade meshes (new: userData.blade; old: the M_BLADE strips) and the card's figure along the passage
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs');
const THREE_LOCAL = '/tmp/claude-0/-home-user-Interactive-Turbine-Lab/564bad2b-aee6-5ac6-9043-5b521443c8a3/scratchpad/node/three159/package/build/three.module.min.js';
(async () => {
  const [url, outFile, idsArg, mode = 'new'] = process.argv.slice(2);
  const args = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-angle-features=enableParallelCompileAndLink'];
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  await p.route(/cdn\.jsdelivr\.net\/npm\/three@0\.159\.0\/.*/, (r) => r.fulfill({ path: THREE_LOCAL, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' } }));
  await p.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push('console ' + m.type() + ': ' + m.text().slice(0, 200)); });
  await p.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('route-speed', '4'); } catch { /* */ } });
  await p.goto(url);
  await p.waitForFunction(() => window.__route, null, { timeout: 300000 });
  await p.waitForTimeout(3000);
  const hots = await p.evaluate(() => JSON.parse(document.querySelector('#route-header').textContent).hot.map((h) => ({ id: h.id, km: h.km, bladeOut: h.bladeOut, bladeArea: h.bladeArea, lon: h.lon, lat: h.lat })));
  const want = idsArg && idsArg !== 'all' ? idsArg.split(',') : hots.map((h) => h.id);
  const out = { url, mode, hot: {}, errs };
  const cardBlade = () => p.evaluate(() => { const o = {}; for (const dt of document.querySelectorAll('#card dt')) { const t = dt.textContent.trim(); if (/^Blade beyond the (road )?edge$/.test(t)) (o[t] ||= []).push(dt.nextElementSibling.textContent.trim()); } return o; });
  for (const h of hots.filter((q) => want.includes(q.id))) {
    const t0 = Date.now(), r = { id: h.id, km: h.km, lon: h.lon, lat: h.lat, json: { bladeOut: h.bladeOut, bladeArea: h.bladeArea } };
    // ---- the default view: the passage
    await p.evaluate(() => window.__route.goRoute()); await p.waitForTimeout(2000);
    await p.evaluate((id) => { window.__route.openHot(id); }, h.id);
    await p.waitForFunction(() => { const R = window.__route, H = R.HOT; return H && document.querySelector('#ui').className.indexOf('hot-mode') >= 0 && document.querySelector('#hot-out').textContent.indexOf('loading') < 0; }, null, { timeout: 300000, polling: 250 });
    await p.waitForTimeout(1500);
    r.hot = await p.evaluate(() => { const H = window.__route.HOT; return { k3: (H.H.bout || H.H.swept.filter((f) => f.a[0] === 3)).map((f) => f.rings.map((x) => Array.from(x))) }; });
    r.hot.card = await cardBlade();
    // ---- the drive view: the road at points along the passage, drawn blade meshes and the card
    r.drive = [];
    const a = h.km[0] * 1000, bb = h.km[1] * 1000;
    // points along the passage whose live windows join up (a window ends where the loaded road data end: the next one starts there)
    for (let s = a + 60 < bb + 1 ? a + 60 : (a + bb) / 2, more = true; more;) {
      await p.evaluate(() => window.__route.goRoute()); await p.waitForTimeout(1500);
      await p.evaluate((k) => { window.__route.openRoad(k); }, s / 1000);
      await p.waitForFunction(() => { const R = window.__route, Q = R.ROAD; if (!Q || document.querySelector('#ui').className.indexOf('road-mode') < 0) return false; for (const P of Q.packs.values()) if (P.medRuns === undefined) return false; return Q.live && !Q.livePending; }, null, { timeout: 600000, polling: 500 });
      await p.waitForTimeout(2500);
      const d = await p.evaluate(([mode, A, B]) => {
        const R = window.__route, Q = R.ROAD, O = Q.origin, L = Q.live, out = { s: +document.getElementById('km').value * 1000, sa: L.sa, sb: L.sb, O, meshes: {} };
        Q.scene.traverse((o) => {
          if (!o.isMesh) return;
          let part = o.userData && o.userData.blade;
          if (!part && mode === 'old' && o.material && o.material.color && o.renderOrder === 2) { const c = o.material.color.getHex(); part = c === 0xff2a1a ? 'beyond' : c === 0xff3020 ? 'outline' : c === 0xff3b30 ? 'sweep' : null; }
          if (!part) return;
          const pos = o.geometry.attributes.position.array, idx = o.geometry.index ? Array.from(o.geometry.index.array) : null;
          (out.meshes[part] ||= []).push({ pos: Array.from(pos, (v, i) => (i % 3 === 0 ? v + O.x : i % 3 === 2 ? -v + O.y : v)), idx });
        });
        // the drive view's figure per front-axle metre over the window (bladeAtS / the old live bL, bR)
        const dep = [];
        for (let s = Math.ceil(L.sa); s <= Math.floor(L.sb); s++) { let v = null;
          if (Q.bladeAtS) v = Q.bladeAtS(s); else { const i = Math.round(s - L.sa); if (i >= 0 && i < L.n && L.res.valid[i]) v = Math.max(L.res.bL[i], L.res.bR[i]); }
          dep.push(v); }
        out.depth = { s0: Math.ceil(L.sa), v: dep };
        // the convoy's line over the passage's stretch (from 100 m before it: its blade reaches back that far), UTM
        out.line = []; for (let i = 0; i < L.n; i++) { const s = L.sa + i; if (s >= A - 100 && s <= B + 10) out.line.push([L.P[2 * i] + O.x, L.P[2 * i + 1] + O.y]); }
        return out;
      }, [mode, a, bb]);
      d.card = await cardBlade();
      // the card at the deepest front-axle metre of the passage within this window
      { let bs = null, bv = -1; d.depth.v.forEach((v, i) => { const s2 = d.depth.s0 + i; if (v != null && s2 >= a && s2 <= bb && s2 >= d.sa + 140 && s2 <= d.sb - 260 && v > bv) { bv = v; bs = s2; } });
        if (bs != null) { await p.evaluate((v) => window.__route.setRoadS(v), bs); await p.waitForTimeout(1500); d.cardAt = { s: bs, v: bv, card: await cardBlade() }; } }
      r.drive.push(d);
      const next = Math.max(s + 200, Math.min(s + 1100, d.sb + 150)); more = next < bb + 1; s = next;
    }
    out.hot[h.id] = r;
    console.error(h.id, 'card(hot)', JSON.stringify(r.hot.card), 'drive points', r.drive.length, 'cards', r.drive.map((x) => JSON.stringify(x.card)).join(' | '), 'meshes', r.drive.map((x) => Object.keys(x.meshes).join('+')).join(' | '), ((Date.now() - t0) / 1000).toFixed(0) + ' s');
    fs.writeFileSync(outFile, JSON.stringify(out));
  }
  console.log('done errs', errs.length, errs.slice(0, 5));
  await b.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
