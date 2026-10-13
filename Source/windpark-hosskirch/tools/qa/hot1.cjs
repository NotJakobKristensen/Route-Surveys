// node hot1.cjs <url> <passage id> [timeout s] [roadKm]: one passage opened from the map (after a road view at roadKm, if
// given); prints the time until it is open and drawn, its h/ requests, console warnings and long tasks with times
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const THREE_LOCAL = '/tmp/claude-0/-home-user-Interactive-Turbine-Lab/564bad2b-aee6-5ac6-9043-5b521443c8a3/scratchpad/node/three159/package/build/three.module.min.js';
(async () => {
  const [url, id, tmo = 300, roadKm] = process.argv.slice(2);
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-angle-features=enableParallelCompileAndLink'] });
  const p = await (await b.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })).newPage();
  const T0 = Date.now(), t = () => ((Date.now() - T0) / 1000).toFixed(1) + 's', log = [];
  p.on('console', (m) => { if (m.type() !== 'log' && !/CERT|software/.test(m.text())) log.push(`${t()} console.${m.type()}: ${m.text().slice(0, 160)}`); });
  p.on('pageerror', (e) => log.push(`${t()} pageerror: ${String(e).slice(0, 200)}`));
  p.on('request', (r) => { if (/\/h\//.test(r.url())) log.push(`${t()} request ${r.url().split('/').slice(-2).join('/')}`); });
  p.on('requestfinished', (r) => { if (/\/h\//.test(r.url())) log.push(`${t()} finished ${r.url().split('/').slice(-2).join('/')}`); });
  p.on('requestfailed', (r) => log.push(`${t()} FAILED ${r.url().split('/').slice(-2).join('/')} ${r.failure() && r.failure().errorText}`));
  await p.route(/cdn\.jsdelivr\.net\/npm\/three@0\.159\.0\/.*/, (r) => r.fulfill({ path: THREE_LOCAL, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' } }));
  await p.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await p.addInitScript(() => { window.__lt = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push([e.startTime, e.duration]); }).observe({ entryTypes: ['longtask'] }); });
  await p.goto(url); await p.waitForFunction(() => window.__route, null, { timeout: 120000 }); await p.waitForTimeout(3000);
  if (roadKm) { await p.evaluate((k) => window.__route.openRoad(+k), roadKm); await p.waitForFunction(() => document.querySelector('#ui').className.includes('road-mode'), null, { timeout: 300000 }); await p.waitForTimeout(15000); log.push(`${t()} road view up`); }
  await p.evaluate(() => window.__route.goRoute()); await p.waitForTimeout(2500);
  const ta = Date.now(), pa = await p.evaluate(() => performance.now()); log.push(`${t()} openHot ${id}`);
  const st0 = await p.evaluate(() => window.__route.WARM && { ...window.__route.WARM.stats });
  const iv = setInterval(async () => { try { log.push(`${t()} stats ${JSON.stringify(await p.evaluate(() => window.__route.WARM && window.__route.WARM.stats))}`); } catch {} }, 10000);
  await p.evaluate((id) => window.__route.openHot(id), id);
  let ok = true;
  try { await p.waitForFunction(() => { const H = window.__route.HOT; return H && document.querySelector('#ui').className.indexOf('hot-mode') >= 0 && document.querySelector('#ui').className.indexOf('road-mode') < 0 && document.querySelector('#hot-out').textContent.indexOf('loading') < 0; }, null, { timeout: +tmo * 1000, polling: 250 }); }
  catch { ok = false; }
  clearInterval(iv);
  log.push(`${t()} ${ok ? 'OPEN after ' + ((Date.now() - ta) / 1000).toFixed(1) + ' s' : 'NOT OPEN after ' + tmo + ' s'}; hot-out: ${await p.evaluate(() => document.querySelector('#hot-out').textContent.slice(0, 100))}`);
  const lt = await p.evaluate((pa) => window.__lt.filter((x) => x[0] >= pa).map((x) => `${((x[0] - pa) / 1000).toFixed(1)}s:${Math.round(x[1])}`), pa);
  console.log(log.join("\n")); console.log("long tasks after open (start:ms):", lt.join(" ")); console.log("warm stats", JSON.stringify(await p.evaluate(() => window.__route.WARM && window.__route.WARM.stats)));
  await b.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
