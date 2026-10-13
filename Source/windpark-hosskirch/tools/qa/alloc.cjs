// Allocations while driving: node alloc.cjs <url> <km> [secs]   (sampling heap profiler, collected objects included)
// Prints the bytes allocated per drawn frame inside the frame callback's call tree and the heaviest allocating functions there.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const THREE_LOCAL = '/tmp/claude-0/-home-user-Interactive-Turbine-Lab/564bad2b-aee6-5ac6-9043-5b521443c8a3/scratchpad/node/three159/package/build/three.module.min.js';
(async () => {
  const [url, km, secs = 12] = process.argv.slice(2);
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-angle-features=enableParallelCompileAndLink'] });
  const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await p.route(/cdn\.jsdelivr\.net\/npm\/three@0\.159\.0\/.*/, (r) => r.fulfill({ path: THREE_LOCAL, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' } }));
  await p.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await p.addInitScript(() => { window.__frames = 0; const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = (cb) => raf((t) => { window.__frames++; cb(t); }); });
  await p.goto(url); await p.waitForFunction(() => window.__route, null, { timeout: 120000 }); await p.waitForTimeout(3000);
  await p.evaluate((k) => window.__route.openRoad(+k), km);
  await p.waitForFunction(() => document.querySelector('#ui').className.includes('road-mode'), null, { timeout: 300000 });
  await p.waitForTimeout(20000);
  await p.evaluate(() => document.getElementById('play').click()); await p.waitForTimeout(3000);
  const cdp = await p.context().newCDPSession(p);
  await cdp.send('HeapProfiler.enable');
  const f0 = await p.evaluate(() => window.__frames);
  await cdp.send('HeapProfiler.startSampling', { samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  await p.waitForTimeout(+secs * 1000);
  const { profile } = await cdp.send('HeapProfiler.stopSampling');
  const frames = (await p.evaluate(() => window.__frames)) - f0;
  // walk the allocation tree: bytes under the frame callback (frame / frameBody), per function
  let inFrame = 0, total = 0; const per = new Map();
  const walk = (n, under) => { const nm = n.callFrame.functionName || '(anon)'; const u = under || nm === 'frame' || nm === 'frameBody'; const self = (n.selfSize || 0);
    total += self; if (u) { inFrame += self; per.set(nm + ':' + (n.callFrame.lineNumber + 1), (per.get(nm + ':' + (n.callFrame.lineNumber + 1)) || 0) + self); } for (const c of n.children || []) walk(c, u); };
  walk(profile.head, false);
  console.log(JSON.stringify({ frames, totalKB: Math.round(total / 1024), inFrameKB: Math.round(inFrame / 1024), bytesPerFrame: Math.round(inFrame / Math.max(1, frames)) }));
  console.log([...per.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k} ${Math.round(v / 1024)} KB`).join('\n'));
  await b.close();
})();
