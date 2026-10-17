// Fidelity: node fid.cjs <url> <route hk|ml> <outdir>   env: HOTS=all|id,id  KMS=k,k (road points)  SHOTS=1  PAR=1|0
// Fingerprints (SHA-256) of the decoded data and of the built scene: per road pack (header, every decoded array, every mesh's
// geometry, instances, world matrix and material state), the live swept path at each road point, per HD passage (scene,
// decoded passage data, convoy poses along the path, labels). Screenshots at fixed cameras (pixel ratio 1): map overview,
// three road points, three HD passages, each twice (1.5 s apart: what differs there is time-animated).
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs'), path = require('path');
const THREE_LOCAL = '/tmp/claude-0/-home-user-Interactive-Turbine-Lab/564bad2b-aee6-5ac6-9043-5b521443c8a3/scratchpad/node/three159/package/build/three.module.min.js';
const KMS = { hk: [212.4, 608.3, 902.6], ml: [37.2, 266.1, 455.4] };
const SHOT_HOTS = { hk: ['gaisbeuren', 'niederbiegen', 'forest'], ml: ['muenster-lech-moos', 'muenster-lech-feldheim', 'muenster-lech-pessenburgheim'] };
(async () => {
  const [url, route, outdir] = process.argv.slice(2);
  fs.mkdirSync(outdir, { recursive: true });
  const args = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
  if (process.env.PAR !== '0') args.push('--enable-angle-features=enableParallelCompileAndLink');
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  // the road packs in a fixed order (the one under the point, then the one before it, then the one after, each once the
  // one before is built): what a pack's build takes from its neighbours (the session origin, the seams) is then the same
  // in every run, as it is not when they arrive in whatever order the network and the decoding give
  let order = null; const routed = [];
  const built = (q) => p.evaluate((q) => { const Q = window.__route && window.__route.ROAD, P = Q && Q.packs.get(q); return !!(P && P.medRuns !== undefined); }, q).catch(() => false);
  await ctx.route(/\/r\/(\d{3})\.json$/, async (route) => {
    const q = +route.request().url().match(/\/r\/(\d{3})\.json$/)[1]; routed.push(q);
    if (order) { const i = order.indexOf(q); for (const pr of order.slice(0, Math.max(0, i))) { const t0 = Date.now(); while (!(await built(pr)) && Date.now() - t0 < 120000) await new Promise((r) => setTimeout(r, 200)); } }
    route.continue();
  });
  await p.route(/cdn\.jsdelivr\.net\/npm\/three@0\.159\.0\/.*/, (r) => r.fulfill({ path: THREE_LOCAL, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' } }));
  await p.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript(() => {
    try { localStorage.clear(); localStorage.setItem('route-speed', '4'); } catch { /* */ }
    let rv; Object.defineProperty(window, '__route', { configurable: true, get: () => rv, set: (v) => { rv = v; const R = v.renderer; R.setPixelRatio(1); R.setPixelRatio = () => {}; } });
  });
  await p.goto(url);
  await p.waitForFunction(() => window.__route, null, { timeout: 300000 });
  await p.waitForTimeout(3000);
  // the view's offset (the free area between the panels) is measured on resize: once more now that the layout is final, the
  // same in every run (when the page first measured it depends on when its panels filled)
  await p.setViewportSize({ width: 1281, height: 800 }); await p.waitForTimeout(400); await p.setViewportSize({ width: 1280, height: 800 }); await p.waitForTimeout(1200);
  // hashing helpers in the page
  await p.evaluate((GP) => {
    const enc = new TextEncoder();
    const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
    const sha = async (parts) => { let n = 0; const bs = parts.map((x) => (typeof x === 'string' ? enc.encode(x) : x instanceof ArrayBuffer ? new Uint8Array(x) : new Uint8Array(x.buffer, x.byteOffset, x.byteLength))); for (const x of bs) n += x.length;
      const all = new Uint8Array(n); let o = 0; for (const x of bs) { all.set(x, o); o += x.length; } return hex(await crypto.subtle.digest('SHA-256', all)).slice(0, 16); };
    const num = (v) => (v && v.isColor ? v.getHexString() : v && v.isVector2 ? v.toArray().join(',') : v && v.isVector3 ? v.toArray().join(',') : typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string' ? String(v) : v == null ? 'null' : '');
    // (a default key is the source of onBeforeCompile: its minified names differ between two builds of the same code)
    const ckey = (k) => (/=>|function/.test(k) ? 'fn' + k.replace(/[A-Za-z_$][\w$]*/g, '_') : k);
    const matDesc = (m) => !m ? 'none' : (Array.isArray(m) ? m : [m]).map((x) => [x.type, num(x.color), num(x.emissive), x.opacity, x.transparent, x.side, x.depthWrite, x.depthTest, x.vertexColors, x.polygonOffset, x.polygonOffsetFactor, x.polygonOffsetUnits, x.roughness, x.metalness, x.toneMapped, x.alphaTest, x.blending,
      x.map ? (x.map.image ? (x.map.image.width + 'x' + x.map.image.height) : 'img?') + ':' + x.map.anisotropy + ':' + x.map.colorSpace + ':' + x.map.flipY + ':' + x.map.minFilter : 'nomap', x.customProgramCacheKey ? ckey(x.customProgramCacheKey()) : '', x.userData && x.userData.pool || ''].join('/')).join(';');
    // one object: its geometry (every attribute and the index), instances, world matrix, material state, draw state
    window.__objHash = async (o) => {
      const parts = [o.type, String(o.renderOrder), String(o.visible), String(o.castShadow), String(o.receiveShadow), String(o.frustumCulled), matDesc(o.material), new Float64Array(o.matrixWorld.elements)];
      const g = o.geometry; if (g) { for (const k of Object.keys(g.attributes).sort()) { const a = g.attributes[k]; parts.push(k, String(a.itemSize), String(a.normalized), a.array); }
        if (g.index) parts.push('index', g.index.array); parts.push(JSON.stringify(g.groups), JSON.stringify(g.drawRange)); }
      if (o.isInstancedMesh) { parts.push('inst', String(o.count), o.instanceMatrix.array); if (o.instanceColor) parts.push(o.instanceColor.array); }
      return sha(parts);
    };
    // a set of objects, order-independent (sorted hashes), and the count of triangles in it
    window.__setHash = async (list) => { const hs = []; let tris = 0; for (const o of list) { hs.push(await window.__objHash(o)); const g = o.geometry; if (g && g.attributes.position) tris += ((g.index ? g.index.count : g.attributes.position.count) / 3) * (o.isInstancedMesh ? o.count : 1); }
      hs.sort(); return { n: hs.length, tris: Math.round(tris), h: await sha([hs.join(',')]) }; };
    window.__sha = sha;
    window.__GP = GP;
    window.__drawables = (root, skip) => { const L = []; root.traverse((o) => { if (skip && skip(o)) return; if (o.geometry && (o.isMesh || o.isLine || o.isPoints || o.isSprite)) L.push(o); }); return L; };
    window.__under = (o, g) => { for (let q = o; q; q = q.parent) if (q === g) return true; return false; };
    // the blade's drawing in the road view (its outer sweep, where it reaches beyond the edge): the new build tags its meshes,
    // the builds before it drew them with these materials (fingerprinted apart: the blade beyond the edge may change)
    window.__isBlade = (o) => { if (o.userData && o.userData.blade) return true; const m = o.material; if (!m || m.type !== 'MeshBasicMaterial' || o.renderOrder !== 2 || !m.color) return false;
      const c = m.color.getHex(); return (c === 0xff2a1a && Math.abs(m.opacity - 0.4) < 1e-6) || c === 0xff3020 || (c === 0xff3b30 && Math.abs(m.opacity - 0.7) < 1e-6); };
  }, process.env.GP === '1');
  const out = { url, route, road: [], hot: [], errs };
  // ---------------------------------------------------------------- road points: packs (decoded data and meshes), live swept path, the rest of the scene
  const RK = process.env.KMS ? process.env.KMS.split(',').map(Number) : KMS[route];
  for (const k of RK) {
    await p.evaluate(() => window.__route.goRoute()); await p.waitForTimeout(2200);
    { const p0 = Math.floor(k * 1000 / 5000), list = await p.evaluate(() => fetch('r/index.json').then((r) => r.json()).then((j) => j.packs)); order = [p0, p0 - 1, p0 + 1].filter((q) => list.includes(q)); }
    await p.evaluate((n) => { window.__want = n; }, order.length);
    await p.evaluate((k) => { window.__route.openRoad(k); }, k);
    await p.waitForFunction(() => { const R = window.__route, Q = R.ROAD; if (!Q || Q.packs.size === 0 || document.querySelector('#ui').className.indexOf('road-mode') < 0) return false;
      for (const P of Q.packs.values()) if (P.medRuns === undefined || P.meshes.some((m) => !m.visible)) return false; return Q.packs.size >= window.__want; }, null, { timeout: 600000, polling: 250 });
    await p.waitForTimeout(4000);
    // the live swept path computed again now that the packs around are in (its window then does not depend on timing)
    await p.evaluate(() => { const Q = window.__route.ROAD; Q.setVehicle({ ...Q.convoy.dims }); });
    await p.waitForFunction(() => { const Q = window.__route.ROAD; return Q.live && !Q.livePending; }, null, { timeout: 60000, polling: 200 });
    await p.waitForTimeout(1500);
    const r = await p.evaluate(async () => {
      const R = window.__route, Q = R.ROAD, res = { km: +document.getElementById('km').value, packs: {} };
      for (const [pk, P] of [...Q.packs.entries()].sort((a, b) => a[0] - b[0])) {
        const hdr = JSON.stringify(P.hdr, (key, v) => (key === 'bmp' ? undefined : v));
        const arrs = Object.keys(P.A).sort().map((n) => [n, P.A[n]]).flat();
        const bm = P.hdr.chunks.map((c) => c.bmp ? c.bmp.width + 'x' + c.bmp.height : 'closed').join(',');
        const ms = await window.__setHash(P.meshes.filter((m) => m.geometry));
        res.packs[pk] = { hdr: await window.__sha([hdr]), A: await window.__sha(arrs), bmps: await window.__sha([bm]), meshes: ms };
        if (window.__GP) {   // GP=1: the header with the guide posts' offsets masked, and every mesh's hash with its type and instance count
          const g6 = (c) => String(c).split('-')[0] === '620';
          const hdrX = JSON.stringify(P.hdr, (key, v) => (key === 'bmp' ? undefined : key === 'signs' && Array.isArray(v) ? v.map((q) => (g6(q[3]) ? [q[0], 0, ...q.slice(2)] : q)) : v));
          const list = []; for (const m of P.meshes.filter((m) => m.geometry)) list.push([await window.__objHash(m), m.type, m.isInstancedMesh ? m.count : 0]);
          list.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
          Object.assign(res.packs[pk], { hdrX: await window.__sha([hdrX]), n620: (P.hdr.signs || []).filter((q) => g6(q[3])).length, list });
        }
      }
      const L = Q.live; if (L) { const x = L.res; res.live = { sa: L.sa, sb: L.sb, n: L.n, h: await window.__sha(Object.keys(x).sort().map((k) => [k, x[k] && x[k].buffer ? x[k] : String(x[k])]).flat()) }; }
      const conv = Q.convoy.group, sky = R.ROAD.scene.children.filter((c) => c.isMesh && c.material && c.material.side === 1 && c.geometry.type === 'SphereGeometry');
      // everything else in the scene (far landscape, live swept path drawn, warm-up gone), the convoy left out (it moves)
      const rest = window.__drawables(Q.scene, (o) => window.__under(o, conv) || sky.includes(o) || (Q.warm && window.__under(o, Q.warm)));      // (the warm-up set: never drawn)
      res.scene = await window.__setHash(rest);
      // the same without the blade's drawing, and that drawing on its own
      res.sceneNoBlade = await window.__setHash(rest.filter((o) => !window.__isBlade(o))); res.bladeDrawn = await window.__setHash(rest.filter((o) => window.__isBlade(o)));
      res.samples = await window.__sha([new Float64Array(Q.samples.flatMap((s) => [s.s, s.x, s.y, s.nx, s.ny, s.z, s.sl, s.L, s.R, s.off, s.sh, s.dv ?? NaN, s.oc, s.ow, s.lq, s.tw]))]);
      res.gates = Q.gates.map((g) => [g.s, g.v, g.c]).length; res.objects = Q.objects.length; res.survey = JSON.stringify(Q.survey(res.km * 1000));
      return res;
    });
    // screenshot: a fixed camera over the road point
    if (process.env.SHOTS !== '0') {
      await p.evaluate(() => { const R = window.__route, Q = R.ROAD, s = +document.getElementById('km').value * 1000, q = Q.at(s); R.rctl.set(new R.hcam.position.constructor(q.x, q.z, -q.y), 140, Math.atan2(q.nx, q.ny) * 180 / Math.PI + 215, 34, true); });
      await p.waitForTimeout(2500);
      await p.setViewportSize({ width: 1281, height: 800 }); await p.waitForTimeout(400); await p.setViewportSize({ width: 1280, height: 800 }); await p.waitForTimeout(1200);
      await p.evaluate(() => { const R = window.__route, w = 1280, h = 800, L = document.querySelector('#left').getBoundingClientRect(), Rr = document.querySelector('#right').getBoundingClientRect(), Dk = document.querySelector('#dock').getBoundingClientRect(); const dx = (L.right + Rr.left) / 2 - w / 2, dy = Dk.top / 2 - h / 2; for (const c of [R.mcam, R.hcam]) { c.setViewOffset(w, h, -dx, -dy, w, h); c.updateProjectionMatrix(); } const t = document.querySelector('#t-labels'); if (t) t.dispatchEvent(new Event('change')); }); await p.waitForTimeout(1500);      // (the view's offset as the page's resize computes it, from the layout now: when the page last measured it depends on load timing)
    for (const t of [0, 1, 2]) { await p.screenshot({ path: path.join(outdir, `road${RK.indexOf(k)}_${t}.png`) }); await p.waitForTimeout(1500); }
    }
    order = null; r.routed = routed.splice(0);
    out.road.push(r);
    console.error('road', k, JSON.stringify(r).slice(0, 300));
  }
  // ---------------------------------------------------------------- HD passages
  const hots = await p.evaluate(() => JSON.parse(document.querySelector('#route-header').textContent).hot.map((h) => h.id));
  const hdIds = await p.evaluate(() => fetch('h/index.json').then((r) => r.json()).then((j) => j.ids).catch(() => []));
  const list = process.env.HOTS === 'shots' ? SHOT_HOTS[route] : process.env.HOTS && process.env.HOTS !== 'all' ? process.env.HOTS.split(',') : hots;
  for (const id of list) {
    await p.evaluate(() => window.__route.goRoute()); await p.waitForTimeout(2500);      // (from the map, as a click in the list)
    await p.evaluate((id) => { window.__route.openHot(id); }, id);
    const hd = hdIds.includes(id);
    await p.waitForFunction((hd) => { const R = window.__route, H = R.HOT; return H && document.querySelector('#ui').className.indexOf('hot-mode') >= 0 && (!hd || document.querySelector('#hot-out').textContent.indexOf('loading') < 0); }, hd, { timeout: 180000, polling: 250 });
    await p.waitForTimeout(3000);
    const r = await p.evaluate(async (id) => {
      const R = window.__route, H = R.HOT, conv = H.convoy.group;
      const sky = H.scene.children.filter((c) => c.isMesh && c.material && c.material.side === 1 && c.geometry.type === 'SphereGeometry');
      const res = { id, scene: await window.__setHash(window.__drawables(H.scene, (o) => window.__under(o, conv) || window.__under(o, H.markers) || sky.includes(o))) };
      const D = H.H; res.data = await window.__sha([D.path, D.poses, D.trees, JSON.stringify(D.swept), JSON.stringify(D.roads), JSON.stringify(D.bld), JSON.stringify(D.obj), JSON.stringify(D.bar), JSON.stringify(D.water), D.ground.z]);
      const poses = []; for (let i = 0; i <= 200; i++) poses.push(...H.poseAt(i / 200)); res.poses = await window.__sha([new Float64Array(poses)]);
      res.swept = await window.__sha([JSON.stringify(D.swept)]);
      // the passage's data and painted areas without the blade beyond the edge (swept kind 3, or its own layer), and that apart
      const s3 = D.swept.filter((f) => f.a[0] !== 3);
      res.dataNoBlade = await window.__sha([D.path, D.poses, D.trees, JSON.stringify(s3), JSON.stringify(D.roads), JSON.stringify(D.bld), JSON.stringify(D.obj), JSON.stringify(D.bar), JSON.stringify(D.water), D.ground.z]);
      res.sweptNoBlade = await window.__sha([JSON.stringify(s3)]);
      res.bladeArea = await window.__sha([JSON.stringify(D.bout || D.swept.filter((f) => f.a[0] === 3))]);
      res.tags = await window.__sha([JSON.stringify(H.tags)]); res.ntags = H.tags.length; res.trees = H.treeCount; res.pathLength = H.pathLength;
      res.markers = await window.__setHash(window.__drawables(H.markers)).then((x) => x.n);
      res.out = document.querySelector('#hot-out').textContent;
      return res;
    }, id);
    if (process.env.SHOTS !== '0' && SHOT_HOTS[route].includes(id)) {
      await p.evaluate(() => { const R = window.__route, H = R.HOT, P = H.H.path, n = P.length / 2, i = n >> 1, x = P[2 * i], y = P[2 * i + 1];
        R.setHotU(0.45); R.hctl.set(new R.hcam.position.constructor(x, H.surface(x, y), -y), 160, 40, 38, true); });
      await p.waitForTimeout(2500);
      await p.setViewportSize({ width: 1281, height: 800 }); await p.waitForTimeout(400); await p.setViewportSize({ width: 1280, height: 800 }); await p.waitForTimeout(1200);
      await p.evaluate(() => { const R = window.__route, w = 1280, h = 800, L = document.querySelector('#left').getBoundingClientRect(), Rr = document.querySelector('#right').getBoundingClientRect(), Dk = document.querySelector('#dock').getBoundingClientRect(); const dx = (L.right + Rr.left) / 2 - w / 2, dy = Dk.top / 2 - h / 2; for (const c of [R.mcam, R.hcam]) { c.setViewOffset(w, h, -dx, -dy, w, h); c.updateProjectionMatrix(); } const t = document.querySelector('#t-labels'); if (t) t.dispatchEvent(new Event('change')); }); await p.waitForTimeout(1500);      // (the view's offset as the page's resize computes it, from the layout now: when the page last measured it depends on load timing)
    for (const t of [0, 1, 2]) { await p.screenshot({ path: path.join(outdir, `hot_${id}_${t}.png`) }); await p.waitForTimeout(1500); }
    }
    out.hot.push(r);
    console.error('hot', id, JSON.stringify(r).slice(0, 300));
  }
  // ---------------------------------------------------------------- map overview
  if (process.env.SHOTS !== '0') {
    await p.evaluate(() => window.__route.goRoute()); await p.waitForTimeout(4000);
    await p.evaluate(() => { const R = window.__route, c = R.mctl; c.set(c.goal.target.clone(), c.goal.dist, c.goal.az, c.goal.el, true); });
    await p.waitForTimeout(1500);
    await p.evaluate(() => { const R = window.__route, w = 1280, h = 800, L = document.querySelector('#left').getBoundingClientRect(), Rr = document.querySelector('#right').getBoundingClientRect(), Dk = document.querySelector('#dock').getBoundingClientRect(); const dx = (L.right + Rr.left) / 2 - w / 2, dy = Dk.top / 2 - h / 2; for (const c of [R.mcam, R.hcam]) { c.setViewOffset(w, h, -dx, -dy, w, h); c.updateProjectionMatrix(); } const t = document.querySelector('#t-labels'); if (t) t.dispatchEvent(new Event('change')); }); await p.waitForTimeout(1500);      // (the view's offset as the page's resize computes it, from the layout now: when the page last measured it depends on load timing)
    for (const t of [0, 1, 2]) { await p.screenshot({ path: path.join(outdir, `map_${t}.png`) }); await p.waitForTimeout(1500); }
  }
  fs.writeFileSync(path.join(outdir, 'fid.json'), JSON.stringify(out, null, 1));
  console.log('done', outdir, 'errs', errs.length);
  await b.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
