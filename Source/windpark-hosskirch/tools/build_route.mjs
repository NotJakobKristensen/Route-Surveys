// Builds the route-survey page: bundles windpark-hosskirch/src/route/*.js (three.js stays external, from jsDelivr),
// inlines windpark-hosskirch/data/route/{route.json, route.bin, *.webp} and writes
//   windpark-hosskirch/hosskirch-blade-route.html        standalone page (open it directly)
//   windpark-hosskirch/dist/hosskirch-blade-route.html   same page without the document skeleton (hosted artifacts)
//   windpark-hosskirch/{r,h}/                            the data packs from dist/{r,h}, next to the standalone page
// Usage: npm install && node windpark-hosskirch/tools/build_route.mjs
import { build } from 'esbuild';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..');                        // the page's code (src/route)
// the route: ROUTE_ROOT (another route's folder with route_config.json, data/route, dist) or this project
const wp = process.env.ROUTE_ROOT ? path.resolve(process.env.ROUTE_ROOT) : src;
const cfgFile = path.join(wp, 'route_config.json');
const CFG = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {};
const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.159.0/build/three.module.min.js';
const NAME = CFG.page || 'hosskirch-blade-route';
// the swept-path worker: its own bundle, inlined into the page as a string (started from a blob: URL)
const worker = await build({
  entryPoints: [path.join(src, 'src', 'route', 'sweep_worker.js')],
  bundle: true, format: 'iife', minify: !process.env.DEBUG, target: 'es2020', write: false, legalComments: 'none',
});
// the data worker (the packs fetched and decoded off the main thread): inlined the same way
const dataWorker = await build({
  entryPoints: [path.join(src, 'src', 'route', 'data_worker.js')],
  bundle: true, format: 'iife', minify: !process.env.DEBUG, target: 'es2020', write: false, legalComments: 'none',
});
const res = await build({
  entryPoints: [path.join(src, 'src', 'route', 'main.js')],
  bundle: true, format: 'esm', minify: !process.env.DEBUG, target: 'es2020', write: false, external: ['three'], legalComments: 'none',
  define: { __SWEEP_WORKER__: JSON.stringify(worker.outputFiles[0].text), __DATA_WORKER__: JSON.stringify(dataWorker.outputFiles[0].text) },
});
const app = res.outputFiles[0].text.replace(/from\s*"three"/g, `from"${THREE_URL}"`).replace(/<\/script/gi, '<\\/script');
if (!app.includes(THREE_URL)) throw new Error('three import not rewritten');
const dd = path.join(wp, 'data', 'route');
const tpl = fs.readFileSync(path.join(src, 'src', 'route', 'hosskirch-blade-route.html'), 'utf8');      // the template of every route page
const header = JSON.parse(fs.readFileSync(path.join(dd, 'route.json'), 'utf8'));
// the route's own page texts as they are in route_config.json now (the bake copies them too; a text edit needs no re-bake)
if (CFG.page_text) header.page = { ...(header.page || {}), ...CFG.page_text };
// where the detail data come from when the page cannot read its own folders (opened from disk, downloaded without r/ h/):
// the route's website, which sends them with Access-Control-Allow-Origin (_headers). KEY ties the data to this page (same
// length and passages), BUILT is the newest data file (not index.json, which this script writes)
const SITE = CFG.site ?? (process.env.ROUTE_ROOT ? '' : 'https://hosskirch.netlify.app/');
const KEY = crypto.createHash('sha1').update(JSON.stringify([header.km, header.hot.map((h) => [h.id, h.km])])).digest('hex').slice(0, 10);
const BUILT = (() => {
  let t = 0; const see = (f) => { try { t = Math.max(t, fs.statSync(f).mtimeMs); } catch { /* absent */ } };
  see(path.join(dd, 'route.json')); see(path.join(dd, 'route.bin'));
  for (const sub of ['r', 'h']) { const d = path.join(wp, 'dist', sub); if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) if (f !== 'index.json') see(path.join(d, f)); }
  return new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
})();
// the map, its outer frame and the aerial image of each passage in the header (route_bake leaves the images of passages a
// route no longer has in data/route: those are not inlined)
const used = new Set(['map', 'outer', ...header.hot.map((h) => 'h_' + h.id)]);
const images = {};
for (const f of fs.readdirSync(dd)) if (f.endsWith('.webp') && used.has(f.replace('.webp', ''))) images[f.replace('.webp', '')] = fs.readFileSync(path.join(dd, f)).toString('base64');
const PARK = CFG.park !== undefined ? (CFG.park || { full: '', artifact: '' }) : { full: 'windpark-hosskirch.html', artifact: 'https://claude.ai/artifact/VNuGz9KDw7NdgcG5D1x5oL' };
const T = Object.assign({
  TITLE: 'Hoßkirch Blade Route', H1: 'Hoßkirch blade route', CONVOYS: '6 × 3', START: 'Goleniów',
  DESC: 'Route survey for the 84.3 m Vestas V172 blades of Windpark Hoßkirch: 935 km by road from the LM Wind Power plant in Goleniów, Poland, to the Wagenhart forest, with every difficult passage driven by a swept-path model.',
  FROM: 'From the LM Wind Power / Vestas blade plant in Goleniów (PL) to the crane pads of Windpark Hoßkirch in the Wagenhart forest (DE)',
}, CFG.text || {}, { KM: String(Math.round(header.km)), KMMAX: String(Math.floor(header.km)), SITE, KEY, BUILT });
const fill = (s, park = PARK.full) => s
  .replace('/*__HEADER__*/', () => JSON.stringify(header))
  .replace('__BIN__', () => fs.readFileSync(path.join(dd, 'route.bin')).toString('base64'))
  .replace('/*__IMAGES__*/', () => JSON.stringify(images))
  .replace('/*__APP__*/', () => app)
  .replace('__THREE_URL__', THREE_URL)
  .replaceAll('%%PARK_URL%%', park)
  .replace(/%%([A-Z][A-Z0-9]*)%%/g, (m, k) => (k in T ? T[k].replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;') : m));
const head = tpl.split('<!--HEAD-->')[1].split('<!--/HEAD-->')[0].trim();
const body = tpl.split('<!--BODY-->')[1].split('<!--/BODY-->')[0].trim();
const stamp = '<!-- Built by windpark-hosskirch/tools/build_route.mjs from windpark-hosskirch/src/route + windpark-hosskirch/data/route: edit those, then rebuild. -->';
// (lang, translate="no" and the google meta: no "Translate this page?" offer; the hosted variant gets them from the template's
// first script, which also puts the meta into its <head>)
const full = `<!doctype html>\n${stamp}\n<html lang="en" translate="no" class="notranslate">\n<head>\n<meta charset="utf-8">\n<meta name="google" content="notranslate">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n${fill(head)}\n</head>\n<body>\n${fill(body)}\n</body>\n</html>\n`;
if (process.env.OUT_DIR) {          // a test build elsewhere (the hosted variant only); the repository's pages stay as they are
  fs.mkdirSync(process.env.OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.OUT_DIR, `${NAME}.html`), `${fill(head, PARK.artifact)}\n${fill(body, PARK.artifact)}\n`);
} else {
  fs.writeFileSync(path.join(wp, `${NAME}.html`), full);
  fs.mkdirSync(path.join(wp, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(wp, 'dist', `${NAME}.html`), `${fill(head, PARK.artifact)}\n${fill(body, PARK.artifact)}\n`);
  // the packs' indexes carry the page's key and build time: the page reads data from its folders or the website only when
  // the key fits, and says when the website's copy is newer (written only when changed)
  for (const sub of ['r', 'h']) {
    const f = path.join(wp, 'dist', sub, 'index.json'); if (!fs.existsSync(f)) continue;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (j.key !== KEY || j.built !== BUILT) fs.writeFileSync(f, JSON.stringify({ ...j, key: KEY, built: BUILT }));
  }
  // the data packs the page loads on demand (r/: road view, h/: passages), next to the repository's page as well, so the
  // page in the repository is the same as the hosted one (packs built by route_pack.py / route_hd_pack.py into dist/)
  for (const sub of ['r', 'h']) {
    const src = path.join(wp, 'dist', sub), dst = path.join(wp, sub);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(dst, { recursive: true });
    const keep = new Set(fs.readdirSync(src));
    for (const f of keep) {
      const a = path.join(src, f), b = path.join(dst, f);
      if (!fs.existsSync(b) || !fs.readFileSync(a).equals(fs.readFileSync(b))) fs.copyFileSync(a, b);
    }
    for (const f of fs.readdirSync(dst)) if (!keep.has(f)) fs.rmSync(path.join(dst, f));
  }
}
const kb = (n) => (n / 1024).toFixed(0) + ' KB';
console.log(`${NAME}.html ${kb(full.length)} (app ${kb(app.length)}) · key ${KEY} · data built ${BUILT}${SITE ? ' · site ' + SITE : ''}`);
