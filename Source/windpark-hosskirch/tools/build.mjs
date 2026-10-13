// Builds the single-file page: bundles windpark-hosskirch/src/*.js (three.js stays external, loaded from jsDelivr),
// inlines windpark-hosskirch/data/{scene.json,scene.bin,core.webp,wide.webp} and writes
//   windpark-hosskirch/windpark-hosskirch.html      standalone page (open it directly)
//   windpark-hosskirch/dist/windpark-hosskirch.html same page without the <html>/<head>/<body> skeleton (for hosted artifacts)
// Usage: npm install && node windpark-hosskirch/tools/build.mjs
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const wp = path.join(here, '..');
export const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.159.0/build/three.module.min.js';

const res = await build({
  entryPoints: [path.join(wp, 'src', 'main.js')],
  bundle: true, format: 'esm', minify: !process.env.DEBUG, target: 'es2020', write: false, external: ['three'], legalComments: 'none',
});
let app = res.outputFiles[0].text.replace(/from\s*"three"/g, `from"${THREE_URL}"`).replace(/<\/script/gi, '<\\/script');
if (!app.includes(THREE_URL)) throw new Error('three import not rewritten');

const tpl = fs.readFileSync(path.join(wp, 'src', 'windpark-hosskirch.html'), 'utf8');
const header = fs.readFileSync(path.join(wp, 'data', 'scene.json'), 'utf8');
const b64 = (f) => fs.readFileSync(path.join(wp, 'data', f)).toString('base64');
const ROUTE = { full: 'hosskirch-blade-route.html', artifact: 'https://claude.ai/artifact/9EShdBZTbkd99JhSCQwpth' };
const fill = (s, route = ROUTE.full) => s
  .replace('/*__HEADER__*/', () => JSON.stringify(JSON.parse(header)))
  .replace('__BIN__', () => b64('scene.bin'))
  .replace('__IMG_CORE__', () => b64('core.webp'))
  .replace('__IMG_WIDE__', () => b64('wide.webp'))
  .replace('/*__APP__*/', () => app)
  .replace('__THREE_URL__', THREE_URL)
  .replaceAll('%%ROUTE_URL%%', route);
const head = tpl.split('<!--HEAD-->')[1].split('<!--/HEAD-->')[0].trim();
const body = tpl.split('<!--BODY-->')[1].split('<!--/BODY-->')[0].trim();
// no "Translate this page?" offer: lang, translate="no" and the google meta on the standalone page; the hosted variant has no
// <head> of its own, so a first script sets them and puts the meta into the host's <head> (Chrome reads it only there)
const NOTRANSLATE = `<script>(function(d){var h=d.documentElement;h.lang='en';h.setAttribute('translate','no');h.classList.add('notranslate');if(!d.querySelector('meta[name="google"]')){var m=d.createElement('meta');m.name='google';m.content='notranslate';(d.head||h).appendChild(m);}})(document);</script>`;
const stamp = '<!-- Built by windpark-hosskirch/tools/build.mjs from windpark-hosskirch/src + windpark-hosskirch/data: edit those, then rebuild. -->';
const full = `<!doctype html>\n${stamp}\n<html lang="en" translate="no" class="notranslate">\n<head>\n<meta charset="utf-8">\n<meta name="google" content="notranslate">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n${fill(head)}\n</head>\n<body>\n${fill(body)}\n</body>\n</html>\n`;
const fragment = `${NOTRANSLATE}\n${fill(head, ROUTE.artifact)}\n${fill(body, ROUTE.artifact)}\n`;
fs.writeFileSync(path.join(wp, 'windpark-hosskirch.html'), full);
fs.mkdirSync(path.join(wp, 'dist'), { recursive: true });
fs.writeFileSync(path.join(wp, 'dist', 'windpark-hosskirch.html'), fragment);
const kb = (n) => (n / 1024).toFixed(0) + ' KB';
console.log(`windpark-hosskirch.html ${kb(full.length)} (app ${kb(app.length)}), artifact ${kb(fragment.length)}`);
