// Route survey page: the whole route on a 3D map, every survey point as a true-scale 3D scene with the convoy.
import * as THREE from 'three';
import { decodeRoute, decodeBlade } from './rdata.js';
import { makeMap, EXAG } from './mapview.js';
import { makeHot, loadHD, preConvoy as preConvoyHot } from './hotview.js';
import { makeRoad, preConvoy as preConvoyRoad } from './roadview.js';
import { boardCanvas } from './convoy.js';
import { DEFAULTS, LABELS, loadVehicle, saveVehicle, derived, overPoint } from './vehicle.js';
import { tmInverse, tmForward, utm33, utm33fwd, convergence, mapsLinks } from './geo.js';
import { makePhotoMatch, exifGps } from './photomatch.js';
import { GroundOrbit } from '../controls.js';
import { U, makeSky, updateEnvironment, sunPosition } from '../env.js';
import { b64bytes } from '../data.js';
import { makeWarmer, slicer, setUrgent } from './warm.js';

const $ = (s) => document.querySelector(s);
const D2R = Math.PI / 180;
const setLoad = (f, msg) => { $('#load-bar').style.transform = `scaleX(${f})`; if (msg) $('#load-msg').textContent = msg; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtKm = (k) => (k >= 100 ? k.toFixed(0) : k.toFixed(1));
const SEVTXT = ['passes', 'needs care', 'difficult'];
// DOM writes only when the value changes (each write costs the browser a restyle / repaint of the overlay)
const setT = (e, t) => { if (e._t !== t) { e._t = t; e.style.transform = t; } };
const show = (e, on) => { const d = on ? '' : 'none'; if (e._d !== d) { e._d = d; e.style.display = d; } };
const setTxt = (e, t) => { if (e && e._x !== t) { e._x = t; e.textContent = t; } };
const setHTML = (e, h) => { if (!e || e._h === h) return false; e._h = h; e.innerHTML = h; return true; };
// a compile in the background (KHR_parallel_shader_compile where the browser has it), at most a few seconds
const PARK_URL = window.ROUTE_PARK_LINK === undefined ? 'windpark-hosskirch.html' : window.ROUTE_PARK_LINK;   // '' : no 3D wind park for this route
if (!PARK_URL) { const a = document.getElementById('park-link'); if (a) a.hidden = true; }   // (module scripts run after parsing)

async function loadImage(b64, mime = 'image/webp') {
  const blob = new Blob([b64bytes(b64)], { type: mime });
  const url = URL.createObjectURL(blob);
  const img = new Image(); img.decoding = 'async'; img.src = url;
  await img.decode(); return img;
}

async function main() {
  setLoad(0.1, 'Reading the survey');
  const header = JSON.parse($('#route-header').textContent);
  let VEH = loadVehicle();
  const images = JSON.parse($('#route-img').textContent);
  // the survey data and the map's pictures decode in the background (inflate and image decoding run off the main thread)
  // while the renderer starts: awaited just before the map is built
  const Rp = decodeRoute(header, $('#route-bin').textContent.trim()), imgP = Promise.all([loadImage(images.map), loadImage(images.outer)]);
  setLoad(0.35, 'Decoding the map');
  // the detail data (r/: road view, h/: survey-grade passages) are folders next to the page. Opened from disk the browser
  // blocks them, and a downloaded page may come without them: then they are read from the route's website (ROUTE_SITE,
  // sent with Access-Control-Allow-Origin), but only if they belong to this page (same key: same route and passages).
  // packSrc says where they came from ('local' | 'site' | 'none') and why not ('file' | 'missing' | 'stale' | 'newer');
  // the note under the title and the version line in "Sources and method" tell the reader
  let PACK_BASE = window.ROUTE_PACK_BASE || '';
  let packIndex = null, hdIndex = null;
  const SITE = window.ROUTE_SITE || '', KEY = window.ROUTE_KEY || '', BUILT = window.ROUTE_BUILT || '';
  const packSrc = { from: '', why: '', site: '', siteBuilt: '' };
  const packsFound = (async () => {
    const getJ = (u) => fetch(u, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);      // (revalidated: the site caches stale-while-revalidate)
    const both = async (b) => { const [r, h] = await Promise.all([getJ(b + 'r/index.json'), getJ(b + 'h/index.json')]); return r || h ? { b, r, h, key: (r || h).key, built: (r || h).built || '' } : null; };
    const fits = (q) => !q.key || !KEY || q.key === KEY;          // (data built before the key: accepted)
    const file = location.protocol === 'file:';
    let got = null;
    if (!file || window.ROUTE_PACK_BASE) { const L = await both(PACK_BASE); if (L && fits(L)) got = { ...L, from: 'local' }; else packSrc.why = L ? 'stale' : 'missing'; }
    else packSrc.why = 'file';                                    // (a fetch of a file: URL only ends in a console error)
    let site = ''; try { site = SITE ? new URL(SITE, location.href).href : ''; } catch { /* no site */ }
    if (!got && site && (file || new URL('.', location.href).href !== site)) {
      packSrc.site = site; const S = await both(site);
      if (S) { packSrc.siteBuilt = S.built; if (fits(S)) got = { ...S, from: 'site' }; else packSrc.why = S.built && BUILT && S.built > BUILT ? 'newer' : 'other'; }
    }
    if (got) { PACK_BASE = got.b; packIndex = got.r; hdIndex = got.h; packSrc.from = got.from; if (got.from === 'site' && BUILT && got.built && got.built !== BUILT) packSrc.why = got.built > BUILT ? 'newer' : 'older'; }
    else packSrc.from = 'none';
  })();
  // the map is built before the renderer starts: the renderer's first questions to the GPU wait until the GPU process has
  // set up the context (made by the page's first script), which it does meanwhile
  const R = await Rp, [mapImg, outerImg] = await imgP;
  setLoad(0.55, 'Building the map');
  const M = makeMap(R, mapImg, outerImg);
  const canvas = $('#c');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  const coarse = matchMedia('(pointer: coarse)').matches;
  const WARM = makeWarmer(renderer);            // what is drawn is made ready before it is shown (warm.js)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // smoothness: the shadow map is redrawn only when the sun's target moves (the convoy) or the scene changed; an idle view
  // (camera, convoy and controls at rest) is redrawn a few times a second; the resolution adapts to the GPU's time per frame
  renderer.shadowMap.autoUpdate = false;
  // quality tiers: the pixel ratio, top tier the screen's own up to 2 (a 4K screen at 1440p layout: full 4K). Shadows,
  // textures and geometry stay the same on every tier: only the resolution is traded, never the measured content
  const PR_MAX = Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2);
  const TIERS = [PR_MAX, ...[1.75, 1.5, 1.25, 1, 0.85, 0.75, 0.6, 0.5].filter((v) => v < PR_MAX - 0.01)];
  const perf = { pr: PR_MAX, tier: 0, ema: 16.7, gpu: 0, gpuN: 0, tChange: 0, tOver: 0, tUnder: 0, upBlock: 0, last: new Float64Array(16), idle: 0, lastDraw: 0, sunAt: new THREE.Vector3(1e9, 0, 0), shadowAge: 0 };
  // what the browser draws with: the graphics card (some browsers mask its name) or a software renderer, which is very slow:
  // then a note how to switch the hardware on, and a lighter start (the resolution still adapts upwards if it can)
  const GPU = (() => { try { const g = renderer.getContext(), x = g.getExtension('WEBGL_debug_renderer_info'); return String((x && g.getParameter(x.UNMASKED_RENDERER_WEBGL)) || g.getParameter(g.RENDERER) || '?'); } catch { return '?'; } })();
  const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render/i.test(GPU);
  if (SOFTWARE) { $('#sw-note').hidden = false; perf.pr = 0.75; renderer.setPixelRatio(0.75); console.warn('3D drawn in software:', GPU); }      // (and fixed: a resize costs it more than a second)
  $('#sw-close').onclick = () => { $('#sw-note').hidden = true; stackNotes(); };
  const camMoved = (cam) => { const e = cam.matrixWorld.elements, L = perf.last; let d = 0; for (let i = 0; i < 16; i++) { d += Math.abs(e[i] - L[i]); L[i] = e[i]; } return d > 1e-4; };
  function shadowsIfMoved() {
    perf.shadowAge++;
    if (perf.sunAt.distanceToSquared(sun.target.position) > 0.0025 || perf.shadowAge > 30) { perf.sunAt.copy(sun.target.position); renderer.shadowMap.needsUpdate = true; perf.shadowAge = 0; }
  }
  // the GPU's own time per frame where the browser measures it (EXT_disjoint_timer_query_webgl2, every 4th frame, read a few
  // frames later when ready: never waited on); else the interval between frames
  const TQ = (() => { try { return renderer.getContext().getExtension('EXT_disjoint_timer_query_webgl2'); } catch { return null; } })();
  const tq = { q: [], n: 0 };
  function gpuTimer(begin, drew) {
    if (!TQ || SOFTWARE) return; const g = renderer.getContext();
    if (begin) { if (tq.cur || tq.q.length > 3 || (tq.n++ & 3)) return; tq.cur = g.createQuery(); g.beginQuery(TQ.TIME_ELAPSED_EXT, tq.cur); return; }
    if (tq.cur) { g.endQuery(TQ.TIME_ELAPSED_EXT); tq.q.push([tq.cur, drew]); tq.cur = null; }
    while (tq.q.length && g.getQueryParameter(tq.q[0][0], g.QUERY_RESULT_AVAILABLE)) {
      const [q, d] = tq.q.shift(), ms = g.getQueryParameter(q, g.QUERY_RESULT) / 1e6; g.deleteQuery(q);
      if (d && !g.getParameter(TQ.GPU_DISJOINT_EXT)) { perf.gpu = perf.gpuN ? perf.gpu + (ms - perf.gpu) * 0.2 : ms; perf.gpuN++; }
    }
  }
  // one tier down when a frame takes too long for 60 fps for 1.5 s, one up when it has clearly fit for 6 s (with the GPU's
  // time: the next tier's estimated time fits 12.5 ms); a step that came back within 10 s keeps the tier for a minute.
  // Each step resizes the drawing buffer once (no stutter otherwise); in software it stays fixed
  function adapt(now, dtMs, busy) {
    if (!busy || SOFTWARE) return;
    perf.ema += (Math.min(100, dtMs) - perf.ema) * 0.05;
    const gpu = perf.gpuN > 3 ? perf.gpu : 0, slow = perf.ema > 19 || gpu > 15, fast = gpu ? gpu * (TIERS[Math.max(0, perf.tier - 1)] / perf.pr) ** 2 < 12.5 : perf.ema < 15;
    perf.tOver = slow ? perf.tOver || now : 0; perf.tUnder = fast ? perf.tUnder || now : 0;
    if (now - perf.tChange < 2500) return;
    let t = perf.tier;
    if (slow && now - perf.tOver > 1500 && t < TIERS.length - 1) t++;
    else if (fast && now - perf.tUnder > 6000 && t > 0 && now > perf.upBlock) t--;
    if (t === perf.tier) return;
    if (t > perf.tier && now - perf.tChange < 10000 && perf.lastUp) perf.upBlock = now + 60000;     // (an up-step that did not hold)
    perf.lastUp = t < perf.tier; perf.tier = t; perf.pr = TIERS[t]; perf.tChange = now; perf.tOver = perf.tUnder = 0; perf.gpuN = 0; perf.ema = 16.7;
    renderer.setPixelRatio(perf.pr); M.setRes(VW * perf.pr, VH * perf.pr);
  }
  const mcam = new THREE.PerspectiveCamera(38, 1, 500, 6e6);
  const mctl = new GroundOrbit(mcam, canvas, (x, y) => M.hgt(x, y));
  Object.assign(mctl, { minDist: 4000, maxDist: 1.6e6, bound: 9e5, pickMax: 5e6, hopMax: 260000 });
  // (the map's few programs are compiled in its first frame: at that point the GPU process is still busy setting up, and
  // every question asked of it to make them ready beforehand only waits longer)
  const mapOK = true;
  const Hd = header.map;
  const routeCentre = (() => { let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity; const r = R.route;
    for (let i = 0; i < r.length; i += 2) { x0 = Math.min(x0, r[i]); x1 = Math.max(x1, r[i]); y0 = Math.min(y0, r[i + 1]); y1 = Math.max(y1, r[i + 1]); }
    return new THREE.Vector3((x0 + x1) / 2, 0, -(y0 + y1) / 2); })();
  const homeView = () => ({ t: routeCentre.clone().setY(M.hgt(routeCentre.x, -routeCentre.z)), dist: 1.18e6 * Math.max(1, 0.9 * canvas.clientHeight / Math.max(1, canvas.clientWidth) * 1.6), az: 31, el: 44 });
  { const v = homeView(); mctl.set(v.t, v.dist, v.az, v.el, true); }

  // hot-spot rendering: shared lights and sky (env.js), one scene at a time
  const hcam = new THREE.PerspectiveCamera(40, 1, 0.5, 30000);
  let hctl = null;
  const sun = new THREE.DirectionalLight(0xffffff, 3); sun.castShadow = true;
  sun.shadow.mapSize.set(coarse ? 1024 : 2048, coarse ? 1024 : 2048); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.4;
  const hemi = new THREE.HemisphereLight(0x8899bb, 0x334422, 1.0);
  const env = { sun, hemi };
  // PROBE: the lights of a road or passage view (the sun with its shadow, the sky light, the convoy's headlight), for the
  // programs of objects not yet in their scene (warm.js)
  const PROBE = new THREE.Scene(); { const d = new THREE.DirectionalLight(); d.castShadow = true; const sp = new THREE.SpotLight(); PROBE.add(d, d.target, new THREE.HemisphereLight(), sp, sp.target); }
  const sky = makeSky({ late: true });
  let HOT = null, hotMeta = null, hotU = 0, hotPlay = true, chaseActive = false;   // chase view only after Drive is pressed
  const farTex = new THREE.Texture(mapImg); farTex.colorSpace = THREE.SRGBColorSpace; farTex.anisotropy = 4; farTex.needsUpdate = true;
  const FAR = { tex: farTex, map: Hd, height: (x, y) => M.hgt(x, y) / EXAG,
    uvMatrix: (h) => { const T = h.toMap, W = Hd.x1 - Hd.x0, Hh = Hd.y1 - Hd.y0;
      return new THREE.Matrix3().set(T[0] / W, T[1] / W, (T[2] - Hd.x0) / W, T[3] / Hh, T[4] / Hh, (T[5] - Hd.y0) / Hh, 0, 0, 1); } };

  // ---------------------------------------------------------------- UI: stops, timeline, cards
  const hots = header.hot;
  hots.forEach((h, i) => { if (h.role === undefined) h.role = i === 0 ? 'start' : i === hots.length - 1 ? 'end' : null; });   // (data baked before roles)
  const list = $('#stop-list');
  const stopBtn = (label, cls, dotHtml, km, id) => `<button class="stop ${cls}" type="button" data-id="${id}"><span class="dot ${cls.includes('overview') ? '' : ''}">${dotHtml}</span><span class="t">${esc(label)}</span><span class="km">${km}</span></button>`;
  list.innerHTML = stopBtn('Whole route', 'overview on', '⌂', `${fmtKm(header.km)} km`, 'route') +
    hots.map((h, i) => `<button class="stop" type="button" data-id="${h.id}"><span class="dot ${h.role === 'start' ? 'start' : 's' + h.sev}">${h.role === 'start' ? 'S' : i}</span><span class="t">${esc(h.title)}</span><span class="km">km ${fmtKm(h.km[0])}</span></button>`).join('');
  list.addEventListener('click', (e) => { const b = e.target.closest('.stop'); if (!b) return; b.dataset.id === 'route' ? goRoute() : openHot(b.dataset.id); });
  $('#st-km').textContent = `${Math.round(header.km)} km`;
  const kmIn = $('#km'); kmIn.max = header.km.toFixed(1);
  $('#ticks').innerHTML = hots.map((h) => `<i class="s${h.sev}" style="left:${(h.km[0] / header.km) * 100}%" title="${esc(h.title)}"></i>`).join('');
  $('#legs').innerHTML = header.legs.map((l) => `<span style="flex:${l.b - l.a}" title="${esc(l.name)}"></span>`).join('');

  const legAt = (k) => header.legs.find((l) => k >= l.a && k <= l.b) || header.legs[header.legs.length - 1];
  const nightAt = (k) => header.nights.find((n) => k >= n.a && k <= n.b) || header.nights[header.nights.length - 1];
  const card = $('#card');
  // the route's own texts (route_config.json page_text); none: the Hoßkirch page, whose texts rest on press and police reports
  const PT = header.page || {}, HOSS = !Object.keys(PT).length;
  const OPS = PT.operations || (HOSS ? ['Driving only at night, 22:00–06:00 (reported for the K 8274; the usual window for such transports in Germany). The convoy keeps to the right lane; where the swept path needs lane 2 or the oncoming lane, the escort closes it while the convoy passes.',
    'Police escort reported on the A 7 / B 28 / B 30 in Bavaria; escort vehicles ahead and behind.', 'Permits: needed in Poland and Germany for an oversize transport of this kind (not shown in the reports).']
    : ['Driving at night, 22:00–06:00, the usual window for such transports in Germany. The convoy keeps to the right lane; where the swept path needs lane 2 or the oncoming lane, the escort closes it while the convoy passes.',
      'Escort vehicles ahead and behind; police escort where the permits require it (not modelled).', 'Permits: needed in Poland and Germany for an oversize transport of this kind (not part of this survey).']);
  const LEGS_NOTE = PT.legs_note ?? (HOSS ? `Reported: the start near Szczecin, A 7 → B 28 → B 30 at Neu-Ulm and everything from Bad Waldsee on. The motorway legs in between (km ${fmtKm(header.legs[1].a)}–${fmtKm(header.legs[5].b)}) are the likeliest heavy-transport route, not reported.` : '');
  const NIGHTS_NOTE = PT.nights_note ?? `Illustrative: driving 22:00–06:00 at about 45 km/h on motorways including stops, slower on B-roads.${HOSS ? ' The reports only say the convoys were "several days" on the road; one lost a day at Niederbiegen.' : ''}`;
  const routeCard = () => {
    const nights = header.nights.length;
    card.innerHTML = `
      <header><div><span class="label">Route survey · overview</span><h2>${Math.round(header.km)} km · ${hots.length - 1} passages to check</h2></div></header>
      <p class="sub">${esc(PT.overview || 'The route the blade convoys most likely took, rebuilt on the road network and driven with a swept-path model of the transporter. Fixed points come from the press and police reports; the rest is the cheapest heavy-transport route between them.')}</p>
      ${packSrc.from === 'none' && packNoteText() ? `<p class="note warn-note">${esc(packNoteText().short)}</p>` : ''}
      ${packIndex ? `<div class="howto"><b>See the road anywhere, not only at the survey points.</b> Click the route line on the map, or open it at a km:
        <span class="goto"><label>km <input id="go-km" type="number" min="0" max="${Math.floor(header.km)}" step="0.1" value="${(+document.getElementById('km').value || 0).toFixed(1)}" aria-label="km along the route"></label><button id="go-road" class="chip" type="button">Open the road here</button></span>
        <span class="mini">The road view shows the official aerial photo with the measured edges, every bridge in 3D, signals, signs and trees, and your convoy; drag the slider or press <b>Drive</b> to travel along it.</span></div>` : ''}
      <h3>Convoy (as modelled)</h3>
      <dl>
        <dt>Blade</dt><dd>Vestas V172, ${header.blade}&nbsp;m</dd>
        <dt>Vehicle, bumper to tip</dt><dd>${header.vehicle}&nbsp;m ${(header.page || {}).vehicle_note === undefined ? '<span class="mini">(press: 95–98&nbsp;m)</span>' : ''}</dd>
        <dt>Blade carried</dt><dd>free between front unit and rear dolly</dd>
        <dt>Supports</dt><dd>${header.model.support}&nbsp;m apart, tip ${header.model.overhang.toFixed(0)}&nbsp;m behind the dolly</dd>
        <dt>Convoys</dt><dd>${esc((header.page || {}).convoys || '6 × 3')} blades, at night</dd>
        <dt>Assumed for routing</dt><dd>${header.model.height ? header.model.height.toFixed(1) : '4.7'}&nbsp;m high, 72&nbsp;t gross</dd>
      </dl>
      ${laneSection()}
      ${clearSection()}
      ${worksSection()}
      ${osmSection()}
      <h3>Measures along the route (all passages)</h3>
      <ul>${(() => { const t = {}; const add = (k, v) => { t[k] = (t[k] || 0) + v; };
        for (const h of hots) { for (const c of h.conflicts) { if (c.what.startsWith('traffic signals')) add('signal heads to swing aside', 1); else if (c.what === 'bus stop') add('bus-stop signs / shelters', 1); else if (c.what.endsWith('sign')) add('road signs to unbolt', 1); else if (c.kind === 'overpass') add('bridges: clear height to check', 1); else if (c.what.startsWith('tree cover') || c.what.startsWith('trees in the blade')) add('m² of tree crowns to prune or clear', c.area || 0); else if (c.what === 'fence') add('m of fence to open', c.length || 0); }
          if (h.wheelOut > 0.25) add('m² of temporary hardstanding', Math.max(10, h.wheelArea)); if (/guardrail/.test(h.measures.join(' '))) add('guardrail sections to dismantle (reported)', 1); }
        return Object.entries(t).map(([k, v]) => `<li><b>${Math.round(v).toLocaleString('en')}</b> ${esc(k)}</li>`).join(''); })()}</ul>
      <h3>Operations</h3>
      <ul>${OPS.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
      <h3>Legs</h3>
      <ul>${header.legs.map((l) => `<li><b>km ${fmtKm(l.a)}–${fmtKm(l.b)}</b> ${esc(l.name)}</li>`).join('')}</ul>
      ${LEGS_NOTE ? `<p class="note">${esc(LEGS_NOTE)}</p>` : ''}
      <h3>Nights (illustrative)</h3>
      <ul>${header.nights.map((n) => `<li><b>Night ${n.n}</b> km ${fmtKm(n.a)}–${fmtKm(n.b)}</li>`).join('')}</ul>
      <p class="note">${esc(NIGHTS_NOTE)} Relief on the map ×${EXAG}.</p>`;
    void nights;
  };
  // roadworks on the motorways (Autobahn GmbH snapshot), overhead lines and signed limits (open map data)
  const convoyW = () => Math.max(VEH.width, VEH.tractorWidth, VEH.frontWidth, VEH.dollyWidth);
  const rwNarrow = (q) => q.w != null && q.w < convoyW() + 0.5;
  const rwWhen = (q) => (q.st ? `${esc(q.st)} – ${esc(q.en || '?')}` : (q.win || []).map(esc).join('; ')) || '';
  const rwTxt = (q) => `${esc(q.t)}${q.k === 'c' ? ' · <b class="warn">closure</b>' : ''}${q.w != null ? ` · <b class="${rwNarrow(q) ? 'warn' : ''}">max width ${q.w}&nbsp;m</b>` : ''}${q.v ? ` · ${q.v}&nbsp;km/h` : ''}${rwWhen(q) ? ` · ${rwWhen(q)}` : ''}`;
  const lineTxt = (q) => `${q.k === 't' ? 'Overhead telecom line' : q.kv ? `Power line ${q.kv}&nbsp;kV` : q.mn ? 'Low-voltage power line' : 'Power line (voltage not mapped)'}${q.op ? ' · ' + esc(q.op) : ''}${q.nm ? ' · ' + esc(q.nm) : ''}`;
  const limTxt = (q) => [q.w && `weight limit ${q.w}&nbsp;t`, q.wd && `width limit ${q.wd}&nbsp;m`, q.ln && `length limit ${q.ln}&nbsp;m`, q.h && `height limit ${q.h}&nbsp;m`, q.hgv && 'closed to lorries'].filter(Boolean).join(' · ') + (q.ref ? ` on ${esc(q.ref)}` : '');
  const kmA = (s0) => `<a href="#" data-km="${(Math.max(0, s0 - 300) / 1000).toFixed(3)}">km ${(s0 / 1000).toFixed(1)}</a>`;
  function worksSection() {
    const R = header.roadworks; if (!R || !R.items.length) return '';
    const long = R.items.filter((q) => q.st || q.k === 'c'), night = R.items.filter((q) => !q.st && q.k !== 'c' && q.n), day = R.day || 0;
    const li = (q) => `<li>${kmA(q.a)}–${(q.b / 1000).toFixed(1)} · ${rwTxt(q)}${mapsA(linksAt(q.x, q.y, 'map'), 'Maps')}</li>`;
    return `<h3>Roadworks on the motorways (${esc(R.date)})</h3>
      <p class="sub">${long.length} longer phase${long.length === 1 ? '' : 's'} or closures and ${night.length} night works on the route, plus ${day} day works (outside the 22:00–06:00 window). The convoy is ${convoyW().toFixed(1)}&nbsp;m wide and needs about ${(convoyW() + 0.5).toFixed(1)}&nbsp;m; where the passable width is less, the section must be closed for the run or the phase avoided.</p>
      ${long.length ? `<h3>Longer phases and closures</h3><ul>${long.map(li).join('')}</ul>` : ''}
      ${night.length ? `<h3>Night works</h3><ul>${night.map(li).join('')}</ul>` : ''}
      <p class="note">Autobahn GmbH des Bundes (verkehr.autobahn.de), as of ${esc(R.date)}: phases change weekly, so re-check before each run.</p>`;
  }
  function osmSection() {
    const O = header.osm; if (!O) return '';
    const low = O.lines.filter((q) => q.low), hi = O.lines.length - low.length;
    return `<h3>Overhead lines and signed limits (${esc(O.date)})</h3>
      <p class="sub">${O.lines.length} overhead line${O.lines.length === 1 ? '' : 's'} cross the route: ${hi} high-voltage (110&nbsp;kV and up, hung far above any load) and ${low.length} low- or medium-voltage or telecom line${low.length === 1 ? '' : 's'}, which can sag to 5–6&nbsp;m: the operator confirms the height at each crossing.</p>
      ${low.length ? `<ul>${low.map((q) => `<li>${kmA(q.s)} · ${lineTxt(q)}${mapsA(linksAt(q.x, q.y, 'map'), 'Maps')}</li>`).join('')}</ul>` : ''}
      ${O.lim.length ? `<h3>Signed limits on the route</h3><ul>${O.lim.map((q) => `<li>${kmA(q.a)} · ${limTxt(q)}</li>`).join('')}</ul>` : '<p class="note">No weight, width or length limit below the convoy\'s on the route in the map data.</p>'}
      <p class="note">© OpenStreetMap contributors, via overpass-api.de.</p>`;
  }
  // where the convoy leaves its own lane: on a road with two or more lanes one way the escort closes lane 2 ('lane2'), on a
  // two-way road it stops oncoming traffic ('oncoming'); everywhere else it keeps to the right lane (route_lanes.py; stretches
  // baked before the kind are two-way)
  const L2 = (l) => (l && l.kind === 'lane2');
  const laneWord = (l) => (L2(l) ? { lane: 'lane 2', Lane: 'Lane 2', across: 'into lane 2', hold: 'lane 2 closed', esc: 'the escort closes lane 2', by: 'which the escort closes' } : { lane: 'the oncoming lane', Lane: 'Oncoming lane', across: 'across the centre line', hold: 'hold traffic', esc: 'the escort holds oncoming traffic', by: 'while the escort holds oncoming traffic' });
  function laneSection() {
    const L = header.lanes || []; if (!L.length) return '';
    const tot = L.reduce((a, l) => a + (l.b - l.a), 0), n2 = L.filter(L2).length;
    const gain = (l) => l.krOut > 0.15 && l.krOut - l.out > 0.15 ? `keeping right the wheels leave the road by ${l.krOut.toFixed(1)}&nbsp;m${l.out > 0.1 ? `, using it ${l.out.toFixed(1)}&nbsp;m` : ', using it they stay on'}`
      : l.krAcross > 0.6 ? `keeping right the wheels reach ${laneWord(l).across} by ${l.krAcross.toFixed(1)}&nbsp;m anyway`
      : l.krBlade - l.blade > 1 ? `blade ${l.krBlade.toFixed(0)}&nbsp;m beyond the edge keeping right, ${l.blade.toFixed(0)}&nbsp;m using it` : 'a smoother line through the curve';
    const li = (l) => `<li><a href="#" data-km="${(Math.max(0, l.a - 120) / 1000).toFixed(3)}">km ${(l.a / 1000).toFixed(1)}</a> · ${laneWord(l).Lane}, ${Math.round((l.b - l.a) / 10) * 10}&nbsp;m, wheels up to ${l.across.toFixed(1)}&nbsp;m ${laneWord(l).across} · ${gain(l)} · ${laneWord(l).hold} ≈&nbsp;${Math.max(1, Math.round(l.hold / 60))}&nbsp;min</li>`;
    return `<h3 class="lane-h">Leaving the right lane: ${L.length} stretches, ${(tot / 1000).toFixed(1)}&nbsp;km</h3>
      <p class="sub">The convoy keeps to the right lane. Only where the swept path needs more room does it use ${n2 ? `lane 2 (${n2} on roads with two or more lanes each way: the escort closes it) or ` : ''}the oncoming lane (${L.length - n2} on two-way roads: the escort stops oncoming traffic), violet on the road.</p>
      <details class="all-clear"><summary>All stretches by km</summary><ul class="clist" data-lazy="${lazyList(() => L.map(li).join(''))}"></ul></details>`;
  }
  const isTun = (o) => o.kind === 'tunnel' || o.kind === 'overpass';
  function structName(o) { return ( o.kind === 'artefact' ? 'Vehicle in the surface model' : o.kind === 'gantry' ? 'Sign gantry / overhead structure' : o.kind === 'trees' ? 'Trees over the road' : o.kind === 'canopy' ? 'Canopy over the road' : o.kind === 'limit' ? 'Signed height limit'
    : o.kind === 'tunnel' ? 'Tunnel / covered section' : o.kind === 'overpass' ? 'Wildlife overpass (green bridge)'
    : (o.sub === 'rail' || ['standard_gauge', 'rail', 'light_rail', 'narrow_gauge', 'tram'].includes(o.cls)) ? 'Railway bridge'
    : ['path', 'footway', 'cycleway', 'pedestrian', 'steps'].includes(o.cls) ? 'Footbridge' : o.cls === 'track' ? 'Farm-track bridge' : `Road bridge${o.cls ? ' (' + o.cls + ')' : ''}`); }
  // the states along the route ([code, km from, km to], Berlin counted as Brandenburg; route data baked before this field:
  // the two surveyed routes' runs) and what each serves (hd_sources.py, route_pack.HCREDIT, laser extracts)
  const ST = { 'PL-32': ['Poland (West Pomerania)', 'GUGiK orthophoto, 25&nbsp;cm', 'NMT 1&nbsp;m laser terrain and NMPT 0.5&nbsp;m surface model', 'GUGiK'],
    'DE-MV': ['Mecklenburg-Vorpommern', 'LAiV orthophoto, 20&nbsp;cm', 'DGM1 laser terrain and DOM1 surface model, 1&nbsp;m', null, 'not open (login and fee)'],
    'DE-BB': ['Brandenburg and Berlin', 'LGB orthophoto DOP20c, 20&nbsp;cm', 'DGM1 laser terrain and bDOM1 image-matched surface model, 1&nbsp;m', 'LGB'],
    'DE-ST': ['Saxony-Anhalt', 'LVermGeo orthophoto DOP20, 20&nbsp;cm', 'DGM1 laser terrain and DOM1 surface model, 1&nbsp;m', null, 'not in the open data'],
    'DE-SN': ['Saxony', 'GeoSN orthophoto DOP20, 20&nbsp;cm', 'DGM and DOM, 1&nbsp;m, sampled sparsely (one request per cell)', null, 'not reachable (the state\'s server refused the connection)'],
    'DE-TH': ['Thuringia', 'GDI-Th orthophoto, 20&nbsp;cm', null, null, 'not reachable (the state\'s server refused the connection)'],
    'DE-BY': ['Bavaria', 'LDBV orthophoto DOP20, 20&nbsp;cm', 'DGM1 laser terrain 1&nbsp;m, DOM20 surface model 0.2&nbsp;m, LoD2 buildings', 'LDBV'],
    'DE-BW': ['Baden-Württemberg', 'LGL orthophoto DOP20, 20&nbsp;cm', 'DGM1 laser terrain and nDOM1 surface model, 1&nbsp;m, LoD2 buildings', null, 'not used'] };
  const REGIONS = header.regions || (() => {
    const A = [['PL-32', 0, 45.5], ['DE-MV', 45.5, 64.5], ['DE-BB', 64.5, 296.5], ['DE-ST', 296.5, 357], ['DE-SN', 357, 360.5], ['DE-ST', 360.5, 361.5], ['DE-SN', 361.5, 373], ['DE-ST', 373, 380.5], ['DE-SN', 380.5, 383], ['DE-ST', 383, 418.5], ['DE-TH', 418.5, 495]];
    return Math.abs(header.km - 935) < 3 ? [...A, ['DE-BY', 495, 726], ['DE-BW', 726, 804], ['DE-BY', 804, 831], ['DE-BW', 831, header.km]] : [...A, ['DE-BY', 495, header.km]]; })();
  const regionAt = (s) => { const k = s / 1000, r = REGIONS.find((q) => k >= q[1] && k < q[2]); return r ? r[0] : ''; };
  const DS = header.datasets || {};
  const noHeights = (c) => (DS[c] ? !DS[c].height : !!ST[c] && !ST[c][2]);
  const NM_OLD = /^nothing above the road found in the surface model/;      // (data baked before 'nm': the same, in a state without one)
  // clear heights over the whole route against the user's load ('nm': in a state without a height model, so not measured;
  // a tunnel or green bridge with only the standard clear height needs the registered value)
  const clearVerdict = (o) => { if (o.kind === 'artefact') return 'artefact'; if (o.nm || (o.note && NM_OLD.test(o.note) && noHeights(regionAt(o.s)))) return 'unknown'; if (o.check) return 'check'; if (isTun(o) && o.signed == null && o.est == null) return 'check';
    if (o.est == null && o.signed == null && o.note) return 'none'; const c = o.signed != null ? o.signed : o.est; if (c == null) return 'unknown'; const need = VEH.height + VEH.heightMargin, unc = o.signed != null ? 0 : o.unc || 0.5;
    return c - unc >= need ? 'pass' : c + unc < need ? 'fail' : 'check'; };
  const clearCount = () => { const L = (header.clear || []).filter((o) => !isTun(o)), n = { pass: 0, check: 0, fail: 0, unknown: 0, none: 0, artefact: 0 }; L.forEach((o) => n[clearVerdict(o)]++); n.all = L.length - n.artefact - n.none; return n; };
  // tunnels and covered sections: the route.json list (portal heights, lid), else the clear records of that kind
  const tunnels = () => (header.tunnels || (header.clear || []).filter(isTun)).map((t) => ({ ...t, s: t.s ?? t.s0, len: t.len ?? (t.s1 - t.s0), check: t.check ?? (t.signed == null && t.phys == null) })).sort((a, b) => a.s - b.s);
  const tunClear = (t) => t.signed != null ? `${t.signed.toFixed(2)}&nbsp;m signed` : t.phys != null ? `${(+t.phys).toFixed(2)}&nbsp;m registered` : t.est != null ? `≈&nbsp;${t.est.toFixed(2)}&nbsp;m&nbsp;±${(t.unc || 0.5).toFixed(1)} (lid top minus an assumed slab and cover)` : `${(t.std || 4.5).toFixed(2)}&nbsp;m assumed (the German standard; not measured)`;
  // (a bored tunnel: its lid figure is the portal's headwall, the cover above the tube comes from its note; the note of an
  // estimated one only repeats how the estimate is made)
  const tunLi = (t) => { const v = clearVerdict(t), lid = (t.lidtop || []).filter((x) => x != null), mined = t.kind === 'tunnel' && t.est == null && /mined/.test(t.note || ''), cover = ((t.note || '').match(/under up to (\d+) m of ground/) || [])[1];
    return `<li><a href="#" data-km="${(Math.max(0, t.s - 300) / 1000).toFixed(3)}">km ${(t.s / 1000).toFixed(1)}</a> · <b class="${v === 'fail' ? 'warn' : v === 'pass' ? 'ok' : ''}">${v === 'pass' ? 'passes' : v === 'fail' ? 'probably too low' : 'check'}</b> · ${esc(structName(t))}${t.name ? ' ' + esc(t.name) : ''}, ${Math.round(t.len)}&nbsp;m${t.zA != null && t.zB != null ? ` · road at the portals ${t.zA.toFixed(1)} / ${t.zB.toFixed(1)}&nbsp;m above sea level` : ''}${mined ? `${cover ? ` · bored, under up to ${cover}&nbsp;m of ground` : ' · bored'}${lid.length ? `, portal headwalls ${lid.map((x) => x.toFixed(1)).join(' / ')}&nbsp;m above the road` : ''}` : lid.length ? ` · lid ${lid.map((x) => x.toFixed(1)).join(' / ')}&nbsp;m above the road` : ''} · clear height ${tunClear(t)}${t.signed == null && t.phys == null ? ` · registered clear height from ${regionAt(t.s).startsWith('PL') ? 'GDDKiA' : regionAt(t.s) ? 'Autobahn GmbH' : 'Autobahn GmbH / GDDKiA'} needed` : ''}${t.note && !mined && t.est == null ? ` <span class="muted">(${esc(t.note)})</span>` : ''}</li>`; };
  const tunCount = (T) => { const nt = T.filter((t) => t.kind !== 'overpass').length, no = T.length - nt; return [nt && `${nt} tunnel${nt === 1 ? '' : 's'} or covered section${nt === 1 ? '' : 's'}`, no && `${no} wildlife overpass${no === 1 ? '' : 'es'}`].filter(Boolean).join(' and '); };
  function clearSection() {
    const L = header.clear || []; if (!L.length) return '';
    const n = clearCount(), T = tunnels();
    const key = (o) => [clearVerdict(o) === 'fail' ? 0 : 1, o.signed ?? o.est ?? 99];
    const crit = L.filter((o) => !isTun(o) && ['fail', 'check'].includes(clearVerdict(o))).sort((a, b) => { const ka = key(a), kb = key(b); return ka[0] - kb[0] || ka[1] - kb[1]; }).slice(0, 30);
    const VW = { pass: 'passes', check: 'check', fail: 'too low', unknown: 'not measured', none: 'nothing over the road', artefact: 'not an obstacle' };
    const vw = (o, v) => v === 'fail' && o.signed == null ? 'probably too low' : VW[v];
    const val = (o) => isTun(o) ? tunClear(o) : o.signed != null ? o.signed.toFixed(2) + '&nbsp;m signed' : o.est != null ? '≈&nbsp;' + o.est.toFixed(1) + '&nbsp;m ±' + (o.unc || 0.5).toFixed(1) : o.check ? 'clear height unknown' : o.top != null ? 'top ' + o.top.toFixed(1) + '&nbsp;m' : '–';
    const li = (o) => { const v = clearVerdict(o); return `<li><a href="#" data-km="${(o.s / 1000).toFixed(3)}">km ${(o.s / 1000).toFixed(1)}</a> · <b class="${v === 'fail' ? 'warn' : v === 'pass' ? 'ok' : ''}">${vw(o, v)}</b> · ${esc(structName(o))}${o.name ? ' ' + esc(o.name) : ''}: ${val(o)}${o.note && v !== 'pass' ? ` <span class="muted">(${esc(o.note)})</span>` : ''}${o.x != null ? mapsA(linksAt(o.x, o.y, 'map'), 'Maps') : ''}</li>`; };
    // structures not measured, by the states without a height model they stand in
    const nmBy = {}; for (const o of L) if (!isTun(o) && clearVerdict(o) === 'unknown') { const c = regionAt(o.s); if (noHeights(c)) nmBy[c] = (nmBy[c] || 0) + 1; }
    const nmTxt = Object.entries(nmBy).map(([c, k]) => `${k === n.unknown ? 'all' : `${k} of them`} in ${(ST[c] || [c])[0]}`).join(', ');
    return `<h3>Clear heights over the route (load ${VEH.height.toFixed(2)}&nbsp;m + ${VEH.heightMargin.toFixed(2)}&nbsp;m)</h3>
      <p class="sub">${n.all} structures over the carriageway: <b class="ok">${n.pass} pass</b> · <b>${n.check} check on site</b> · <b class="warn">${n.fail} too low or probably too low</b> · ${n.unknown} not measured${nmTxt ? ` (${nmTxt}, where no open height model is reachable)` : ''}.</p>
      ${crit.length ? `<p class="note">Lowest first:</p><ul class="clist">${crit.map(li).join('')}</ul>` : ''}
      ${T.length ? `<h3>Tunnels, covered sections and wildlife overpasses: ${tunCount(T)}</h3><ul class="clist">${T.map(tunLi).join('')}</ul>
      <p class="note">The road through each one is drawn as a straight or gently curved grade between the portals. A cut-and-cover tunnel's clear height is estimated from its lid (top minus an assumed slab and cover); a bored tunnel gets the German standard 4.50&nbsp;m. Neither is a measurement: ask the road authority for the registered clear height.</p>` : ''}
      <details class="all-clear"><summary>All ${L.length} records by km</summary><ul class="clist" data-lazy="${lazyList(() => [...L].sort((a, b) => a.s - b.s).map(li).join(''))}"></ul></details>
      <p class="note">Estimated: the structure's top above the road from the states' laser point clouds, terrain and surface models, minus a typical depth for its kind (deck, girders, ballast), hence the ±. Signed limits (OSM maxheight) are exact. ${n.none} mapped crossings where the route itself runs on a bridge (or the structure stands on a tunnel lid) and ${n.artefact} vehicles the surface model caught on the road are listed but not counted. Field-check every "check" before the run.</p>`;
  }
  // the long lists of the overview (all clear-height records, all lane stretches) are written when their <details> is first
  // opened: some 600 rows each, which took building and laying out the card half a second every time it was shown
  const LAZY = new Map(); let lazyN = 0;
  function lazyList(fn) { const k = String(++lazyN); LAZY.set(k, fn); if (LAZY.size > 8) LAZY.delete(LAZY.keys().next().value); return k; }
  card.addEventListener('toggle', (e) => { const d = e.target; if (!d.open) return; const u = d.querySelector && d.querySelector('ul[data-lazy]'); if (!u) return;
    const fn = LAZY.get(u.dataset.lazy); u.removeAttribute('data-lazy'); if (fn) u.innerHTML = fn(); }, true);
  card.addEventListener('click', (e) => {
    if (e.target.closest('#go-road')) { const v = parseFloat($('#go-km').value); if (Number.isFinite(v)) openRoad(Math.max(0, Math.min(header.km, v))); return; }
    const a = e.target.closest('a[data-km]'); if (!a) return; e.preventDefault();
    // "Drive this passage": open the road there and start driving at the chosen speed
    openRoad(+a.dataset.km).then(() => { if (a.dataset.drive && mode === 'road' && ROAD && !roadPlay) $('#play').click(); }); });
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'go-km') { const v = parseFloat(e.target.value); if (Number.isFinite(v)) openRoad(Math.max(0, Math.min(header.km, v))); } });
  const hotCard = (h) => {
    const groups = {};
    for (const c of h.conflicts) {
      const k = c.what.replace(/ \d.*$/, '').replace('building-near', 'building close by');
      const g = (groups[k] ||= { n: 0, len: 0, area: 0, sev: 0 });
      g.n++; g.len += c.length || 0; g.area += c.area || 0; g.sev = Math.max(g.sev, c.sev);
    }
    const conf = Object.entries(groups).map(([k, g]) => `<li><b>${esc(k)}</b>${g.n > 1 ? ` × ${g.n}` : ''}${g.len ? ` · ${Math.round(g.len)} m` : ''}${g.area ? ` · ${Math.round(g.area)} m²` : ''}</li>`).join('');
    const ev = (h.evidence || []).map((e) => `<blockquote>${esc(e.t)}<cite>${esc(e.s)} · <a href="${esc(e.u)}" target="_blank" rel="noopener">source</a></cite></blockquote>`).join('');
    const idx = hots.indexOf(h);
    card.innerHTML = `
      <header><div><span class="label">${h.role === 'start' ? 'Start' : 'Survey point ' + idx} · km ${h.km[0].toFixed(1)}–${h.km[1].toFixed(1)}</span><h2>${esc(h.title)}</h2></div><button id="close-card" type="button" aria-label="Back to the route">×</button></header>
      <p class="sub">${esc(h.road || '')}</p>
      ${packIndex ? `<p class="note"><a href="#" data-km="${Math.max(0, h.km[0] - 0.15).toFixed(3)}" data-drive="1">Drive this passage with your vehicle →</a> (${VEH.height.toFixed(2)}&nbsp;m high, ${derived(VEH).length.toFixed(1)}&nbsp;m long; the findings and measures below travel with you, − / + sets the speed)</p>` : ''}
      <p class="verdict s${h.sev}">${h.incident ? 'Incident on record · ' : ''}${h.incident && h.sev === 0 ? 'passes in the model' : SEVTXT[h.sev]}</p>
      ${h.why ? `<p class="sub">${esc(h.why.charAt(0).toUpperCase() + h.why.slice(1))}.</p>` : ''}
      ${h.incident ? `<p class="sub"><b>${esc(h.incident)}</b></p>` : ''}
      <dl>
        <dt>Tightest curve (outside junction corners)</dt><dd>${h.minR == null ? '–' : h.minR + '&nbsp;m'}</dd>
        ${h.maxTurn > 60 ? `<dt>Junction turn</dt><dd>${h.maxTurn}°&nbsp;within 40&nbsp;m</dd>` : ''}
        <dt>Wheels off the carriageway</dt><dd>${h.wheelOut > 0.1 ? `up to ${h.wheelOut.toFixed(1)}&nbsp;m · ${h.wheelArea}&nbsp;m²` : 'no'}</dd>
        <dt>Wheel clearance to the edge</dt><dd>${h.wheelOut > 0.1 ? 'off the paved area' : Math.max(0, h.wheelClear).toFixed(1) + '&nbsp;m'}</dd>
        <dt>Steepest grade (200 m, ${h.gradeSrc === 'DGM1' ? 'laser terrain' : 'GLO-30'})</dt><dd>${h.grade.toFixed(1)}&nbsp;%</dd>
        <dt>Blade beyond the road edge</dt><dd>${h.bladeOut > 0.3 ? `up to ${h.bladeOut.toFixed(h.bladeOut < 10 ? 1 : 0)}&nbsp;m${h.bladeArea >= 1 ? ` · ${h.bladeArea}&nbsp;m²` : ''}` : 'no'}</dd>
      </dl>
      ${h.lane ? `<div class="lane-cmp"><h3>${laneWord(h.lane).Lane}</h3><p class="sub">The convoy keeps to the right lane except here: for about ${Math.round(h.lane.m / 10) * 10}&nbsp;m it uses ${laneWord(h.lane).lane}, ${laneWord(h.lane).by} (wheels up to ${h.lane.across.toFixed(1)}&nbsp;m ${laneWord(h.lane).across}; violet on the ground).</p>
        <table class="cmp"><thead><tr><th></th><th>Keeping right</th><th>Using ${laneWord(h.lane).lane}</th></tr></thead><tbody>
        <tr><th>Wheels off the road</th><td>${h.lane.krOut > 0.1 ? `up to ${h.lane.krOut.toFixed(1)}&nbsp;m` : 'no'}</td><td>${h.wheelOut > 0.1 ? `up to ${h.wheelOut.toFixed(1)}&nbsp;m` : 'no'}</td></tr>
        <tr><th>Wheel clearance</th><td>${h.lane.krOut > 0.1 ? 'off the road' : Math.max(0, h.lane.krClear).toFixed(1) + '&nbsp;m'}</td><td>${h.wheelOut > 0.1 ? 'off the road' : Math.max(0, h.wheelClear).toFixed(1) + '&nbsp;m'}</td></tr>
        <tr><th>Blade beyond the road</th><td>${h.lane.krBlade > 0.3 ? `up to ${h.lane.krBlade.toFixed(0)}&nbsp;m` : 'no'}</td><td>${h.bladeOut > 0.3 ? `up to ${h.bladeOut.toFixed(0)}&nbsp;m` : 'no'}</td></tr>
        </tbody></table></div>` : ''}
      ${conf ? `<h3>In the swept path</h3><ul>${conf}</ul>` : ''}
      ${h.measures.length ? `<h3>Measures</h3><ul>${h.measures.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}
      ${ev ? `<h3>Reported</h3>${ev}` : ''}
      ${h.note ? `<p class="note">${esc(h.note)}</p>` : ''}
      ${(() => { const W = ((header.roadworks || {}).items || []).filter((q) => q.b >= h.km[0] * 1000 - 200 && q.a <= h.km[1] * 1000 + 200); return W.length ? `<h3>Roadworks here (${esc(header.roadworks.date)})</h3><ul>${W.map((q) => `<li>${rwTxt(q)}</li>`).join('')}</ul>` : ''; })()}
      ${pixStrip(h)}
      ${h.role === 'end' && PARK_URL ? `<p class="note"><a href="${esc(PARK_URL)}" target="_blank" rel="noopener">Continue in the 3D wind park →</a> ${esc((header.page || {}).park_text || 'the six V172 at their pads in the Wagenhart forest.')}</p>` : ''}
      ${h.role === 'start' && header.factory.name ? `<h3>The plant</h3><ul><li><b>${esc(header.factory.name)}</b></li><li>${esc(header.factory.address)}</li>${header.factory.facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}`;
    $('#close-card').onclick = goRoute;
  };
  routeCard();
  // ---------------------------------------------------------------- "Sources and method": why the survey can be relied on,
  // exactly which data it rests on (per state along the route and for the whole route), what may be missing, the method in
  // short, the press sources, credits and the version. Counts come from the data and the user's vehicle (rebuilt on opening)
  const kmR = (k) => String(+(+k).toFixed(1));
  const hostOf = (u) => { try { return new URL(u).host; } catch { return u; } };
  function sourcesHTML() {
    const L = header.clear || [], n = clearCount(), T = tunnels(), D = header.data || {}, OS = header.osm || { lines: [], lim: [] };
    const counted = L.filter((o) => !isTun(o) && !['artefact', 'none'].includes(clearVerdict(o)));
    const by = (re) => counted.filter((o) => re.test(o.src || '')).length;
    const nLaz = by(/^laser point cloud/), nDgm = by(/laser terrain|DGM1/), nDom = by(/surface model/), nSig = by(/^signed/);
    const dOv = D.overture || '2026-09-23.1', dPl = D.osm_planet || '2026-09-28', dOp = D.overpass || OS.date, dRw = D.roadworks || (header.roadworks || {}).date, dPx = D.panoramax || '';
    const photoKm = packIndex && packIndex.packs ? Math.min(header.km, packIndex.packs.length * packIndex.pack_km) : header.km;
    const np = hots.length - 1, start = hots[0] && hots[0].role === 'start', blind = !HOSS;
    // the states along the route, in order, with their runs merged (Berlin counted as Brandenburg)
    const order = [], runs = {};
    for (const [c0, a, b] of REGIONS) { const c = c0 === 'DE-BE' ? 'DE-BB' : c0, R = runs[c] || (order.push(c), runs[c] = []), q = R[R.length - 1];
      if (q && Math.abs(q[1] - a) < 0.01) q[1] = b; else R.push([a, b]); }
    const kmTxt = (R) => R.length === 1 ? `km ${kmR(R[0][0])}–${kmR(R[0][1])}` : `km ${kmR(R[0][0])}–${kmR(R[R.length - 1][1])}, ${R.length} stretches, ${Math.round(R.reduce((t, r) => t + r[1] - r[0], 0))}&nbsp;km in all`;
    // laser point clouds per state: route.json's datasets, else counted from the clear records (flight month in their text)
    const lazOf = (c) => { if (DS[c]) return DS[c].laser || null;
      const R = counted.filter((o) => /^laser point cloud/.test(o.src || '') && regionAt(o.s) === c); if (!R.length) return null;
      const d = R.map((o) => ((o.src + ' ' + (o.note || '')).match(/\((\d{4}-\d{2})\)/) || [])[1]).filter(Boolean).sort(); return { n: R.length, from: d[0] || '', to: d[d.length - 1] || '' }; };
    const flown = (z) => (z.from ? ` flown ${z.from === z.to ? z.from : z.from + ' to ' + z.to}` : '');
    const stLi = (c) => { const S = ST[c] || [c, '', null, null, ''], d = DS[c], z = lazOf(c), hgt = d ? (d.height ? S[2] || esc(d.height) : null) : S[2];
      return `<li><b>${S[0]}</b>, ${kmTxt(runs[c])}: photo ${S[1] || esc((d || {}).photo || '?')} · heights ${hgt || '<b>none reachable</b>'} · laser point cloud ${z ? `<b>${z.n}</b> structure${z.n === 1 ? '' : 's'}${z.from ? ',' + flown(z) : ''}` : S[4] || 'not used'}</li>`; };
    const lz = order.map(lazOf).filter(Boolean), lzN = lz.reduce((t, z) => t + z.n, 0), lzD = lz.flatMap((z) => [z.from, z.to]).filter(Boolean).sort();
    const lzSt = order.filter((c) => lazOf(c)), stName = (c) => (ST[c] || [c])[0].replace(/ \(.*| and Berlin/, '');
    const andJ = (a) => (a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);
    const lzWho = andJ(lzSt.map((c) => `${(ST[c] || [])[3] || c} (${stName(c)})`));
    const noH = order.filter(noHeights), nmN = L.filter((o) => !isTun(o) && clearVerdict(o) === 'unknown' && noH.includes(regionAt(o.s))).length;
    const low = (OS.lines || []).filter((q) => q.low).length;
    // how much of the edges is bridged and of the lanes laid from the stretches around (route_bake.py's data: survey rows,
    // lanelines lq); the states' credits in route order (their photo and height models)
    const EG = D.edges || null, LFB = D.lanes_fb, pc = (v) => (v < 10 ? (+v).toFixed(1) : Math.round(v));
    const stCred = [...new Set(order.flatMap((c) => (DS[c] ? [DS[c].photo, DS[c].height] : []).filter(Boolean)))];
    const where = { local: 'next to the page', site: `from the website (${esc(hostOf(packSrc.site))})`, none: `not loaded (${{ file: 'opened from a file', missing: 'the folders r/ and h/ are missing', stale: 'r/ and h/ belong to another version', newer: 'the website has a newer version', other: 'the website has another version' }[packSrc.why] || 'not reachable'})` }[packSrc.from] || 'loading…';
    // in short first (the user's order: why it can be relied on, which sources, what is missing), then the details
    const gaps = [noH.length && `no height model in ${andJ(noH.map(stName))}`, 'registered clear heights (bridges, tunnels) and deck depths', 'kerb heights, load ratings and pavement', 'roadworks after ' + esc(dRw || 'the survey date')].filter(Boolean);
    return `
    <p class="lead"><b>In short:</b> the road's edges were traced on the states' official aerial photos along the whole route (where an edge is hidden it is bridged and marked) and a swept-path model of this convoy drove all of it; ${n.all} structures over it are measured in laser data or surface models wherever the states publish them, and every finding links to its place on the map. Sources: the official aerial photos of ${andJ(order.map(stName))}, the laser terrain and surface models of ${andJ(order.filter((c) => !noH.includes(c)).map(stName))}${lzN ? `, laser point clouds of ${andJ(lzSt.map(stName))}` : ''}, OpenStreetMap / Overture Maps, Copernicus${dRw ? ', Autobahn GmbH roadworks' : ''}${hots.some((h) => h.pix) ? ', Panoramax street photos' : ''} (all below). Not covered: ${andJ(gaps)} — see "What may be missing".</p>
    <h4>Why it can be relied on</h4>
    <ul><li><b>The road is traced on the photo, not assumed.</b> Both edges of the carriageway were traced on the states' official aerial photos (20–25&nbsp;cm per pixel) along ${photoKm < header.km - 1 ? `${Math.round(photoKm)} of the ${Math.round(header.km)}` : `all ${Math.round(header.km)}`}&nbsp;km; where trees, shadows, vehicles or bridges hide an edge${EG ? ` (on ${pc(EG.bridged)}&nbsp;% of the metres, in runs of 200&nbsp;m or more on ${pc(EG.runs200)}&nbsp;% of the route)` : ''} it is bridged between the measured points on both sides and marked "bridged" in the road card. A swept-path model of the transporter drove the whole route, and every 10&nbsp;m is rated.</li>
      <li><b>The blade beyond the road edge is one measure, in the passage and in the drive.</b> The vehicle of this page drives the convoy's line; its blade, as drawn, is taken at every place it passes (between the metres too, so its swing leaves no gaps) and measured against the carriageway's edges traced on the photo and, at the passages, the paved surface traced there (a junction mouth or a slip road is road, not verge). Less than 0.3&nbsp;m beyond the traced edge, its tolerance, is not counted. The passage view paints that area and its card gives its figures; driving the passage shows the same area and figures.</li>
    <li><b>Each structure over the road is measured where the data allow.</b> ${n.all} structures: ${[nLaz && `${nLaz} in the airborne laser point cloud`, nDgm && `${nDgm} against the 1&nbsp;m laser terrain`, nDom && `${nDom} in the surface model`, nSig && `${nSig} by a signed limit`, n.unknown && `${n.unknown} not measured (no height data)`].filter(Boolean).join(', ')}. For your load (${VEH.height.toFixed(2)}&nbsp;m + ${VEH.heightMargin.toFixed(2)}&nbsp;m): <b class="ok">${n.pass} pass</b>, <b>${n.check} to check on site</b>, <b class="warn">${n.fail} too low or probably too low</b>.${T.length ? ` Plus ${tunCount(T)}, with estimated or standard clear heights.` : ''}</li>
    <li><b>The passages were chosen by the data${blind ? '' : ' and the reports'}.</b> The ${np} passages${start ? ' (plus the start at the plant)' : ''} are ${blind ? 'where the ratings say it gets difficult' : 'the places named in the press and police reports and where the ratings say it gets difficult'}. Each is shown in 3D on survey-grade official data and was reviewed on the aerial photo.</li>
    <li><b>Open, dated data only.</b> Road network from Overture Maps ${esc(dOv)}${dOp ? `, map data of ${esc(dOp)}` : ''}${dRw ? `, roadworks of ${esc(dRw)}` : ''}; every source is listed below, so each finding can be checked. ${blind ? 'No reports or local knowledge went into it.' : 'The fixed points of the route come from press and police reports (listed at the end).'}</li></ul>
    <h4>Sources along the route</h4>
    <ul>${order.map(stLi).join('')}</ul>
    <h4>For the whole route</h4>
    <ul><li>Road network, bridges, buildings, objects: Overture Maps ${esc(dOv)} (based on OpenStreetMap), with weight, height and one-way restrictions.</li>
    <li>Road signs: OpenStreetMap planet extract of ${esc(dPl)}.${dOp ? ` Height and weight limits, overhead lines, kerbs and traffic islands: OpenStreetMap via Overpass, ${esc(dOp)}.` : ''}</li>
    ${dRw ? `<li>Roadworks and closures on the motorways: Autobahn GmbH des Bundes, ${esc(dRw)}.</li>` : ''}
    ${hots.some((h) => h.pix) ? `<li>Street-level photos at the passages and low bridges: Panoramax${dPx ? ', ' + esc(dPx) : ''}.</li>` : ''}
    ${lzN ? `<li>Laser point clouds for the clear heights: ${lzWho}: ${lzN} structures${lzD.length ? `, flown ${lzD[0].slice(0, 4)}–${lzD[lzD.length - 1].slice(0, 4)}` : ''}.</li>` : ''}
    <li>Map relief and the height where no laser terrain is reachable: Copernicus DEM GLO-30 (30&nbsp;m) and AWS Terrain Tiles. Map colours and the coarse passage scenes: ESA WorldCover 2021 and a Sentinel-2 composite.</li></ul>
    <h4>What may be missing or could be better</h4>
    <ul>${noH.length ? `<li><b>${noH.map((c) => (ST[c] || [c])[0]).join(', ')}</b> (${noH.map((c) => kmTxt(runs[c])).join('; ')}): no open height model is reachable, so ${nmN ? `${nmN} structure${nmN === 1 ? '' : 's'} there ${nmN === 1 ? 'is' : 'are'}` : 'the structures there are'} not measured, trees get typical heights and the road's height comes from the 30&nbsp;m model.</li>` : ''}
    ${EG ? `<li>On ${pc(EG.bridged)}&nbsp;% of the metres at least one edge of the carriageway is hidden on the photo (trees, shadows, vehicles) or too erratic to use, and is bridged between the measured points (10&nbsp;m rows bridged throughout: ${pc(EG.rows)}&nbsp;%; runs of 1&nbsp;km or more: ${pc(EG.runs1k)}&nbsp;% of the route, the longest ${(+EG.longest).toFixed(1)}&nbsp;km). The width there is an interpolation; the road card says "bridged".</li>` : ''}
    ${LFB ? `<li>On about ${Math.round(LFB)}&nbsp;km of the dual carriageways the painted lines are not readable on the photo (roadworks markings, tree shadows, raised decks distorted on the photo): the lane layout of the stretches around is drawn there, and the road card says so.</li>` : ''}
    <li>Bridge undersides can't be seen from the air: a clear height is the deck top minus an assumed deck depth (hence the ±). Every "check" needs a look on site.</li>
    ${T.length ? `<li>Tunnels, covered sections and wildlife overpasses are modelled, but their clear heights are estimated from the lid or set to the standard 4.50&nbsp;m: the registered values from ${order.includes('PL-32') ? 'Autobahn GmbH and GDDKiA' : 'Autobahn GmbH'} are needed.</li>` : ''}
    <li>${lzN ? `Laser point clouds are used only in ${andJ(lzSt.map(stName))}, where they are open and reachable; elsewhere clear heights` : 'No laser point cloud is used on this route yet (they are open in Poland, Brandenburg and Bavaria): clear heights'} come from the laser terrain and surface models.</li>
    <li>The road's height is taken from the 1&nbsp;m laser terrain where the state serves it (on bridges the deck, in tunnels a grade between the portals); elsewhere from the 30&nbsp;m model, so slopes there are approximate.</li>
    <li>The convoy keeps to the right lane, placed from the painted lines on the photo; where they are worn or hidden a standard lane width is assumed.</li>
    <li>The barrier in the central reservation: a raised median where the terrain model shows one, a concrete wall where it is mapped (or seen in the fine surface models of Bavaria and Poland), else a double steel guard rail is assumed. Concrete walls are not detected in Brandenburg, Saxony-Anhalt and Mecklenburg-Vorpommern, whose surface models are matched from images and blur a wall into a hump.</li>
    <li>The passages' laser terrain is shipped thinned to a 4&nbsp;m grid (6–10&nbsp;m at the largest passages): kerbs, ditches and narrow verges are not in it.</li>
    ${HOSS && header.legs.length > 5 ? `<li>The route's fixed points come from press and police reports; the motorway legs between them (km ${fmtKm(header.legs[1].a)}–${fmtKm(header.legs[5].b)}) are the likeliest heavy-transport route, not reported.</li>` : ''}
    <li>The route search knows no turn costs or turn bans: awkward turns were checked at the passages and fixed by hand where needed.</li>
    ${dRw ? `<li>Roadworks are a snapshot of ${esc(dRw)} (motorways only) and change weekly.</li>` : ''}
    <li>Not in open data: kerb heights, bridge load ratings, pavement strength, temporary widenings. Weight is only checked against signed limits (72&nbsp;t assumed).</li>
    ${low ? `<li>${low} low- or medium-voltage and telecom lines cross the route at unknown height: the operators must confirm.</li>` : ''}
    <li>Photos, surface models and point clouds are from different years, and the photo flight dates are not recorded.</li>
    <li>Permits, escorts and police are outside this survey.</li></ul>
    <h4>How it was made</h4>
    <p>${PT.intro ? esc(PT.intro) : 'A route survey checks, before the first convoy, whether the longest and heaviest parts can pass every bend, junction and village on the way. This one does it for the 84.3&nbsp;m blades of the six Vestas V172 at Hoßkirch.'}</p>
    <ul><li><b>Route</b>: ${PT.method ? esc(PT.method) : `fixed points from reports: blade origin "Stettin" (press; the plant at Goleniów is inferred, the only V172 blade plant near Szczecin); A 7 → B 28 → B 30 at Neu-Ulm; the B 30 past Bad Waldsee; the B 30 → B 32 ramp at Weingarten-Niederbiegen; the B 32 at Hirschegg; the K 8274 from Haid via Wilfertsweiler to Heratskirch. Between them the cheapest heavy-transport path on the Overture road network (motorways preferred, no city streets).`}</li>
    <li><b>Swept path</b>: tractor, self-steering front unit with the root adapter and a remote-steered rear dolly under the blade, ${header.model.support}&nbsp;m between the supports, tip ${header.model.overhang.toFixed(0)}&nbsp;m behind the dolly (${header.vehicle}&nbsp;m overall). Enter your own under <b>Vehicle &amp; blade</b>: the road view re-drives the next 1.6&nbsp;km with it, choosing the dolly offset as a crew would.</li>
    <li><b>Keep right</b>: the convoy drives in the right lane; lane 2 or the oncoming lane only where the swept path needs it (the escort closes it), violet on the road.</li>
    <li><b>Clear heights</b>: the top of each structure above the road over the convoy's band, from the laser point cloud, laser terrain or surface model, minus a typical depth for its kind; signed limits as they are. Tunnels: a grade between the portals and a clear height from the lid or the standard.</li>
    <li><b>Signals, signs, lamps, trees</b>: from the map, heights from the surface model where plausible, otherwise typical (marked); tree crowns from the surface model, or from the photo with typical heights where there is none.</li></ul>
    <h4>If it runs slowly</h4>
    <ul><li>Press <b>P</b> (or add <b>#perf</b> to the address) for a performance readout; <b>Copy</b> puts it on the clipboard to send on.</li>
    <li>If it says SwiftShader, llvmpipe or "Basic Render", the browser draws without the graphics card: turn on hardware acceleration (Chrome / Edge: Settings → System) and restart it.</li></ul>
    ${(header.sources || []).length ? `<h4>${blind ? 'Press sources (the plant)' : 'Press and police reports'}</h4>
    <ul>${header.sources.map((q) => `<li><a href="${esc(q.u)}" target="_blank" rel="noopener">${esc(q.t)}</a></li>`).join('')}</ul>` : ''}
    <p>© OpenStreetMap contributors (ODbL) · Overture Maps · ${dRw ? 'Autobahn GmbH des Bundes · ' : ''}${hots.some((h) => h.pix) ? 'Panoramax contributors · ' : ''}ESA WorldCover 2021 (CC BY 4.0) incl. the Sentinel-2 composite (contains modified Copernicus Sentinel-2 data) · Copernicus DEM GLO-30 © DLR e.V. / Airbus DS · AWS Terrain Tiles (Mapzen) · ${stCred.length ? stCred.map(esc).join(' · ') : 'Geoportal.gov.pl / GUGiK · © GeoBasis-DE/M-V (CC BY 4.0) · © GeoBasis-DE/LGB (dl-de/by-2-0) · © GeoBasis-DE / LVermGeo LSA (dl-de/by-2-0) · GeoSN (dl-de/by-2-0) · © GDI-Th · Bayerische Vermessungsverwaltung (CC BY 4.0) · LGL, www.lgl-bw.de (dl-de/by-2-0)'} · three.js (MIT).</p>
    <p class="note ver">Built ${esc(BUILT || '–')} · detail data (road view, passages): ${where}${SITE ? ` · website: <a href="${esc(SITE)}" target="_blank" rel="noopener">${esc(hostOf(SITE))}</a>` : ''}</p>`;
  }
  const renderSources = () => setHTML($('#src-body'), sourcesHTML());
  renderSources();
  // the detail data's note under the title: what is missing and how to get it (none when they are here or came from the website)
  function packNoteText() {
    const siteA = SITE ? `<a href="${esc(SITE)}" target="_blank" rel="noopener">${esc(hostOf(SITE))}</a>` : '', B = esc(BUILT || '?'), SB = esc(packSrc.siteBuilt || 'later');
    if (packSrc.from === 'site' && packSrc.why === 'newer') return { title: 'Newer survey on the website', html: `This copy (built ${B}) is older than the website (${SB}). Open ${siteA} for the current survey.`, short: '' };
    if (packSrc.from === 'site' && packSrc.why === 'older') return { title: 'Older detail data on the website', html: `The road view and the passages come from ${siteA}, which still has older detail data (built ${SB}) than this page (built ${B}).`, short: '' };
    if (packSrc.from !== 'none') return null;
    const off = SITE ? ', and the website copy couldn\'t be reached (offline?)' : '';
    return { file: { title: 'Opened from a file', html: `Opened from a file, so the road view and the survey-grade passages are missing. Browsers don't let a page read its data folders <b>r/</b> and <b>h/</b> from disk${off}. ${SITE ? `Open ${siteA}, or start` : 'Start'} a local web server in the folder (<code>python3 -m http.server</code>) and open the page from there.`, short: 'Opened from a file: the road view and the survey-grade passages are not loaded (see the note at the top).' },
      missing: { title: 'Detail data missing', html: `The road view and passages couldn't be loaded: <b>r/</b> and <b>h/</b> are not next to this page${off}.${SITE ? ` The full survey: ${siteA}.` : ''}`, short: 'The road view and the survey-grade passages could not be loaded: r/ and h/ are not next to this page.' },
      stale: { title: 'Detail data of another version', html: `The road view and passages are left out: the folders <b>r/</b> and <b>h/</b> next to this page belong to another version of the survey${off}.${SITE ? ` The current survey: ${siteA}.` : ''}`, short: 'The road view and the survey-grade passages are left out: r/ and h/ belong to another version.' },
      other: { title: 'Another version on the website', html: `The road view and passages are left out: ${packSrc.why === 'other' && packSrc.siteBuilt ? `the website's copy (built ${SB})` : 'the website\'s copy'} belongs to another version of the survey than this page (built ${B}).`, short: 'The road view and the survey-grade passages are left out: the website has another version of the survey.' },
      newer: { title: 'Newer survey on the website', html: `This copy (built ${B}) is older than the website (${SB}). Open ${siteA} for the current survey; its road view and passages don't fit this copy, so they are left out here.`, short: 'This copy is older than the website: open the website for the road view and the survey-grade passages.' },
    }[packSrc.why] || null;
  }
  // the notes at the top centre (software drawing, detail data) and the performance readout stack below each other
  function stackNotes() { let y = 0; for (const id of ['#sw-note', '#pack-note', '#perf']) { const e = $(id); if (!e || e.hidden) continue; e.style.top = y ? `${Math.round(y + 8)}px` : ''; y = e.getBoundingClientRect().bottom; } }
  function showPackNote() { const t = packNoteText(), el = $('#pack-note'); if (!el) return; if (t) { $('#pack-note h3').textContent = t.title; $('#pack-note p').innerHTML = t.html; } el.hidden = !t; stackNotes(); }
  $('#pack-close').onclick = () => { $('#pack-note').hidden = true; stackNotes(); };
  // ---------------------------------------------------------------- the user's vehicle and blade
  const DIM_LETTER = { bladeLength: 'A', support: 'B', height: 'C', undersideSupport: 'D', undersideTip: 'E', wheelbase: 'F', frontUnit: 'G', rootDiameter: 'H', dollyLength: 'J', tractorLength: 'K' };
  const GROUPS = [['Blade and load', ['bladeLength', 'rootDiameter', 'maxChord', 'width', 'height', 'undersideSupport', 'undersideTip', 'weight', 'gross']],
    ['Tractor', ['tractorLength', 'frontOverhang', 'wheelbase', 'kingpinAhead', 'tractorWidth']],
    ['Front unit (root support)', ['frontUnit', 'rootAhead', 'frontWidth']],
    ['Rear dolly (tip support)', ['support', 'dollyLength', 'dollyWidth', 'dollyMaxOffset']],
    ['Checks', ['wheelClear', 'heightMargin']]];
  const vehForm = $('#veh-form');
  const fillVeh = () => { vehForm.innerHTML = GROUPS.map(([g, keys]) => `<fieldset><legend>${esc(g)}</legend>${keys.map((k) => `<label for="v-${k}">${DIM_LETTER[k] ? `<b class="dim">${DIM_LETTER[k]}</b>` : ''}${esc(LABELS[k][0])} (${LABELS[k][1]})</label><input id="v-${k}" name="${k}" type="number" step="0.05" min="0" value="${VEH[k]}">`).join('')}</fieldset>`).join('');
    const d = derived(VEH); $('#veh-out').textContent = `Overall length ${d.length.toFixed(1)} m · tip ${d.overhang.toFixed(1)} m behind the dolly`; };
  const showVeh = (on) => { $('#vehicle').hidden = !on; $('#veh-btn').setAttribute('aria-expanded', String(on)); if (on) fillVeh(); };
  $('#veh-btn').onclick = () => showVeh($('#vehicle').hidden);
  $('#veh-close').onclick = () => showVeh(false);
  const applyVeh = (v) => { VEH = v; saveVehicle(VEH); fillVeh(); if (ROAD) { ROAD.setVehicle(VEH); roadTags(); } if (HOT) HOT.convoy.setDimsAsync(VEH, slicer(5)); lastCard = 0; if (mode === 'map') routeCard(); renderSources(); };
  $('#veh-apply').onclick = () => { const v = { ...VEH }; for (const el of vehForm.querySelectorAll('input')) { const x = parseFloat(el.value); if (Number.isFinite(x) && x >= 0) v[el.name] = x; } applyVeh(v); };
  $('#veh-reset').onclick = () => applyVeh({ ...DEFAULTS });
  const srcBtn = $('#src-btn'), srcP = $('#sources');
  const showSrc = (on) => { if (on) renderSources(); srcP.hidden = !on; $('#scrim').hidden = !on; srcBtn.setAttribute('aria-expanded', String(on)); };
  srcBtn.onclick = () => showSrc(srcP.hidden);
  $('#src-close').onclick = () => showSrc(false); $('#scrim').onclick = () => showSrc(false);

  // ---------------------------------------------------------------- labels on the map
  const tags = $('#tags');
  const pinEls = hots.map((h, i) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = `pin ${h.role === 'start' ? 'start' : 's' + h.sev}`; b.textContent = h.role === 'start' ? 'S' : String(i);
    b.title = h.title; b.setAttribute('aria-label', `Survey point ${i}: ${h.title}`);
    b.addEventListener('pointerenter', () => prefetchHD(h.id));
    b.onclick = () => {
      if (b.dataset.cluster) {     // zoom onto the cluster
        const ids = b.dataset.cluster.split(',').map(Number); let x = 0, y = 0; ids.forEach((k) => { x += hots[k].x; y += hots[k].y; });
        x /= ids.length; y /= ids.length; chase = false; playing = false;
        mctl.flyTo(new THREE.Vector3(x, M.hgt(x, y), -y), Math.max(30000, mctl.dist / 6), mctl.az, Math.max(40, mctl.el - 6), 1.6); return;
      }
      openHot(h.id);
    };
    tags.appendChild(b); return b;
  });
  const placeEls = header.places.map((p) => { const d = document.createElement('div'); d.className = 'city ' + (p.k === 'big' ? 'big' : p.k === 'country' ? 'country' : ''); d.textContent = p.n; tags.appendChild(d); return d; });
  const dest = document.createElement('div'); dest.className = 'flag info'; dest.textContent = (header.page || {}).dest || 'Windpark Hoßkirch'; tags.appendChild(dest);
  const convoyTag = document.createElement('div'); convoyTag.id = 'convoy-tag'; tags.appendChild(convoyTag);
  const hotTagEls = [];
  let freeAt = 0, freeR = null;
  const freeRect = () => { const now = performance.now(); if (freeR && now - freeAt < 1000) return freeR; freeAt = now;
    const w = canvas.clientWidth, h = canvas.clientHeight; if (w <= 760) return (freeR = [8, 8, w - 8, h * 0.55]);
    const L = $('#left').getBoundingClientRect(), Rr = $('#right').getBoundingClientRect(), Dk = $('#dock').getBoundingClientRect(); return (freeR = [L.right + 8, 10, Rr.left - 8, Dk.top - 8]); };
  const v3 = new THREE.Vector3();
  let VW = canvas.clientWidth, VH = canvas.clientHeight;        // (kept by resize: reading the layout every frame is slow)
  const project = (cam, x, y, z) => { v3.set(x, y, z).project(cam); return v3.z < 1 ? [(v3.x + 1) / 2 * VW, (1 - v3.y) / 2 * VH] : null; };
  // labels follow the view: placed again only when the camera, the window or the set of labels changed
  let tagGen = 0; const lastView = { m: new Float64Array(16), w: 0, h: 0, gen: -1 };
  function viewChanged(cam) {
    const e = cam.matrixWorld.elements, L = lastView.m; let d = 0; for (let i = 0; i < 16; i++) { d += Math.abs(e[i] - L[i]); L[i] = e[i]; }
    const ch = d > 1e-6 || VW !== lastView.w || VH !== lastView.h || tagGen !== lastView.gen; lastView.w = VW; lastView.h = VH; lastView.gen = tagGen; return ch;
  }
  const lastHot = hots[hots.length - 1];
  const order = header.places.map((p, i) => [p.k === 'country' ? 3 : p.k === 'big' ? 2 : p.d < 15000 ? 1 : 0, i]).sort((a, b) => b[0] - a[0]);
  let lastTagKey = '';
  function placeMapTags() {
    const e_ = mcam.matrixWorld.elements, key = e_[12].toFixed(0) + e_[13].toFixed(0) + e_[14].toFixed(0) + e_[8].toFixed(4) + e_[9].toFixed(4) + VW + VH;
    if (key === lastTagKey) return; lastTagKey = key;
    const W = VW, Hh = VH, boxes = [];
    const overlap = (x, y, w, h) => boxes.some((b) => x < b[0] + b[2] && x + w > b[0] && y < b[1] + b[3] && y + h > b[1]);
    // pins that would overlap join the earlier one (a cluster: click to zoom in)
    const shown = [];
    hots.forEach((h, i) => {
      const p = project(mcam, h.x, M.hgt(h.x, h.y) + 800, -h.y); const e = pinEls[i];
      e.dataset.cluster = '';
      if (!p) { e.style.display = 'none'; return; }
      const lead = shown.find((q) => Math.hypot(q.p[0] - p[0], q.p[1] - p[1]) < 24);
      if (lead) { e.style.display = 'none'; lead.n.push(i); return; }
      shown.push({ i, p, n: [i] });
      e.style.display = ''; e.style.transform = `translate(${p[0] - 12}px,${p[1] - 12}px)`; boxes.push([p[0] - 13, p[1] - 13, 26, 26]);
    });
    for (const q of shown) {
      const e = pinEls[q.i], lab = hots[q.i].role === 'start' ? 'S' : String(q.i);
      if (q.n.length > 1) { e.textContent = `${lab}–${q.n[q.n.length - 1]}`; e.dataset.cluster = q.n.join(','); e.style.width = 'auto'; e.style.padding = '0 6px'; e.style.borderRadius = '12px'; }
      else { e.textContent = lab; e.style.width = ''; e.style.padding = ''; e.style.borderRadius = ''; }
    }
    { const p = project(mcam, lastHot.x, M.hgt(lastHot.x, lastHot.y) + 800, -lastHot.y); if (p && mctl.dist < 3e5) { dest.style.display = ''; dest.style.transform = `translate(${p[0]}px,${p[1] - 18}px) translate(-50%,-100%)`; } else dest.style.display = 'none'; }
    for (const [, i] of order) {
      const p = header.places[i], e = placeEls[i];
      const q = project(mcam, p.x, M.hgt(p.x, p.y) + 500, -p.y);
      const show = q && q[0] > 20 && q[0] < W - 20 && q[1] > 20 && q[1] < Hh - 20 && (p.k !== 'town' || mctl.dist < 4.2e5 || p.d < 15000 && mctl.dist < 8e5);
      if (!show) { e.style.display = 'none'; continue; }
      const w = p.n.length * (p.k === 'country' ? 15 : 7.4) + 10, hgt = 16;
      if (overlap(q[0] - w / 2, q[1] - hgt / 2, w, hgt)) { e.style.display = 'none'; continue; }
      boxes.push([q[0] - w / 2, q[1] - hgt / 2, w, hgt]);
      e.style.display = ''; e.style.transform = `translate(${q[0]}px,${q[1]}px) translate(-50%,-50%)`;
    }
  }
  function placeHotTags() {
    if (!HOT) return;
    const on = $('#t-labels').checked;
    const fr = freeRect(), boxes = [];
    HOT.tags.forEach((t, i) => {
      const e = hotTagEls[i]; if (!e) return;
      let p = on && project(hcam, t.x, t.z, -t.y);
      if (!p) { show(e, false); return; }
      // keep the flag inside the free area (with an arrow towards the target when clamped), skip overlaps
      const w = e._w || 120, hh = 22;
      const cx = Math.max(fr[0] + w / 2, Math.min(fr[2] - w / 2, p[0])), cy = Math.max(fr[1] + hh, Math.min(fr[3], p[1]));
      const clamped = Math.abs(cx - p[0]) > 2 || Math.abs(cy - p[1]) > 2;
      if (boxes.some((b) => cx - w / 2 < b[0] + b[2] && cx + w / 2 > b[0] && cy - hh < b[1] + b[3] && cy > b[1])) { show(e, false); return; }
      boxes.push([cx - w / 2, cy - hh, w, hh]);
      show(e, true); if (e._c !== clamped) { e._c = clamped; e.classList.toggle('clamped', clamped); }
      setT(e, `translate(${Math.round(cx)}px,${Math.round(cy)}px) translate(-50%,-100%)`);
    });
  }
  $('#t-labels').addEventListener('change', () => { tagGen++; });

  // ---------------------------------------------------------------- modes
  let mode = 'map', playing = false, km = 0, chase = false;
  const ui = $('#ui');
  const setActive = (id) => list.querySelectorAll('.stop').forEach((b) => b.classList.toggle('on', b.dataset.id === id));
  function goRoute() {
    lastTagKey = ''; openToken++;
    if (HOT) { HOT.scene.remove(sun, sun.target, hemi, sky); HOT.dispose(); HOT = null; }
    closeRoad();
    hotTagEls.splice(0).forEach((e) => e.remove());
    mode = 'map'; ui.classList.remove('hot-mode', 'road-mode'); pinEls.forEach((e) => e.classList.remove('on'));
    hctl && (hctl.enabled = false); mctl.enabled = true;
    tags.querySelectorAll('.pin,.city').forEach((e) => (e.hidden = false));
    setActive('route');
    const v = homeView(); mctl.flyTo(v.t, v.dist, v.az, v.el, 2.0);
    $('#play').textContent = 'Drive the route'; playing = false; chase = false; $('#play').setAttribute('aria-pressed', 'false');
    kmIn.max = header.km.toFixed(1); kmIn.step = 0.1;
    kmIn.value = km; updateKmOut();
    routeCard();                                   // after the slider is back on the route km (its box reads the slider)
  }
  let openToken = 0;
  // passage data: loaded once per passage and kept for the last few; hovering a passage in the list or on the map, and
  // the neighbours of the one shown, start its download before it is clicked
  const hdCache = new Map();
  const getHD = (id) => {
    if (!hdIndex || !hdIndex.ids.includes(id)) return Promise.resolve(null);
    let p = hdCache.get(id);
    if (p) hdCache.delete(id);
    else p = loadHD(PACK_BASE, id, hdIndex.atl ? hdIndex.atl[id] : null).catch((e) => { console.warn(e); hdCache.delete(id); return null; });
    hdCache.set(id, p);
    while (hdCache.size > 4) hdCache.delete(hdCache.keys().next().value);
    return p;
  };
  const prefetchHD = (id) => { if (hdIndex && !hdCache.has(id)) getHD(id); };
  document.addEventListener('pointerover', (e) => { const b = e.target.closest && e.target.closest('button.stop[data-id]'); if (b) prefetchHD(b.dataset.id); });
  document.addEventListener('focusin', (e) => { const b = e.target.closest && e.target.closest('button.stop[data-id]'); if (b) prefetchHD(b.dataset.id); });
  // while a view opens, its build runs in longer slices (warm.setUrgent): the reader is waiting for it
  async function openHot(id) { setUrgent(true); try { return await openHot0(id); } finally { setUrgent(false); } }
  async function openHot0(id) {
    const h = hots.find((q) => q.id === id); if (!h) return;
    const tm = performance.now(), mk = (l) => console.debug(`[open ${id}] ${l} ${Math.round(performance.now() - tm)} ms`);
    const tok = ++openToken;
    playing = false; chase = false;
    closeRoad(); ui.classList.remove('road-mode');
    setActive(id); hotCard(h);
    pinEls.forEach((e, i) => e.classList.toggle('on', hots[i] === h));
    const imgP = loadImage(images['h_' + id]);
    const hdP = getHD(id);
    if (mode === 'map') {
      // fly down to the point first
      const t = new THREE.Vector3(h.x, M.hgt(h.x, h.y), -h.y);
      mctl.flyTo(t, 22000, mctl.az, 48, 1.4);
      await new Promise((r) => setTimeout(r, 1300));
    }
    const img = await imgP; mk('aerial image');
    // the survey-grade data in hand within a moment: show it at once; otherwise show the passage from the route's own data
    // now and swap the survey-grade scene in when it arrives (same view, same place in the drive)
    let hd = await Promise.race([hdP, new Promise((r) => setTimeout(() => r(undefined), 350))]);
    if (hd === undefined) {
      if (tok !== openToken) return;
      await placeHot(h, img, null, tok, false, mk);
      hd = await hdP; if (tok !== openToken || !hd || mode !== 'hot') return;
      await placeHot(h, img, hd, tok, true, mk); return;
    }
    mk('passage data');
    if (tok !== openToken) return;
    await placeHot(h, img, hd, tok, false, mk);
  }
  async function placeHot(h, img, hd, tok, keepView, mk) {
    const id = h.id;
    const keep = keepView && HOT ? { u: hotU, play: hotPlay } : null;
    // the passage is built and made ready to draw (programs, shadow programs, pictures) while the view before it stays
    // on screen, then shown in one step
    const H1 = await makeHot(R, h, img, FAR, hd, slicer(6)); mk('scene built');
    if (tok !== openToken) { H1.dispose(); return; }
    if (H1.setRoads3D) H1.setRoads3D($('#t-roads3d').checked);
    { const objs = []; for (const root of [H1.scene, H1.convoy.group, sky]) root.traverse((o) => { if (o.material && o.geometry) objs.push(o); });
      await WARM.prepare(objs, PROBE, hcam, { slice: slicer(5), mk }); mk('shaders compiled'); }
    if (tok !== openToken) { H1.dispose(); return; }
    if (HOT) { HOT.scene.remove(sun, sun.target, hemi, sky); HOT.dispose(); }
    hotTagEls.splice(0).forEach((e) => e.remove());
    HOT = H1; hotMeta = h; HOT.attach();
    if (hd && !card.querySelector('.hd-note')) { const n = document.createElement('p'); n.className = 'note hd-note'; n.textContent = `Shown from official geodata: ${hd.hdr.credit}. ${hd.hdr.nbld} buildings (LoD2), ${hd.hdr.ntree.toLocaleString('en')} trees from the surface model; cyan: the carriageway traced on the photo.`; card.appendChild(n); }
    HOT.scene.add(sun, sun.target, hemi, sky); WARM.primeLights(HOT.scene, hcam);
    U.uFogBase.value = HOT.meanZ; U.uFogH.value = 950;
    for (const t of HOT.tags) { const e = document.createElement('div'); e.className = `flag s${t.sev}`; e.textContent = t.text; tags.appendChild(e); hotTagEls.push(e); }
    for (const e of hotTagEls) e._w = e.offsetWidth || null;          // measured once, all together (one layout)
    tagGen++; freeAt = 0;
    // view: from the side of the worst part of the passage
    const P = HOT.H.path, n = P.length / 2;
    let wx = 0, wy = 0, wn = 0;
    for (const c of h.conflicts) if (c.at) { wx += c.at[0]; wy += c.at[1]; wn++; }
    let cx, cy;
    if (wn) { cx = wx / wn; cy = wy / wn; } else { cx = P[(n >> 1) * 2]; cy = P[(n >> 1) * 2 + 1]; }
    // nearest path point, its direction
    let best = 0, bd = Infinity; for (let i = 0; i < n; i++) { const d = (P[2 * i] - cx) ** 2 + (P[2 * i + 1] - cy) ** 2; if (d < bd) { bd = d; best = i; } }
    const i0 = Math.max(0, best - 10), i1 = Math.min(n - 1, best + 10);
    const az = Math.atan2(P[2 * i1] - P[2 * i0], P[2 * i1 + 1] - P[2 * i0 + 1]) / D2R;
    const span = Math.max(h.ext[2] - h.ext[0], h.ext[3] - h.ext[1]);
    hcam.near = 0.5; hcam.far = 26000; hcam.updateProjectionMatrix();
    sky.scale.setScalar(20000);
    if (!hctl) { hctl = new GroundOrbit(hcam, canvas, (x, y) => (HOT ? HOT.surface(x, y) : 0)); hctl.onTap = null; }
    Object.assign(hctl, { minDist: 12, maxDist: span * 0.9, bound: span * 0.45, pickMax: span * 4, hopMax: 400, enabled: true });
    mctl.enabled = false;
    // frame the stretch of path ±220 m around the worst point
    let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
    for (let i = Math.max(0, best - 70); i < Math.min(n, best + 50); i++) { bx0 = Math.min(bx0, P[2 * i]); bx1 = Math.max(bx1, P[2 * i]); by0 = Math.min(by0, P[2 * i + 1]); by1 = Math.max(by1, P[2 * i + 1]); }
    const fitR = Math.min(120, Math.max(70, Math.hypot(bx1 - bx0, by1 - by0) / 2 + 20));
    const tcx = (bx0 + bx1) / 2 * 0.5 + cx * 0.5, tcy = (by0 + by1) / 2 * 0.5 + cy * 0.5;
    const fr = freeRect(), aspectFree = (fr[2] - fr[0]) / Math.max(1, fr[3] - fr[1]);
    const dist = fitR / Math.tan((hcam.fov * D2R) / 2) * 1.05 / Math.min(1, aspectFree);
    if (!keep) hctl.set(new THREE.Vector3(tcx, HOT.surface(tcx, tcy), -tcy), dist, az + 62, 47, true);
    hotU = keep ? keep.u : Math.max(0, (best - 10) / n);
    mode = 'hot'; ui.classList.add('hot-mode');
    tags.querySelectorAll('.pin,.city').forEach((e) => (e.hidden = true)); dest.style.display = 'none';
    hotPlay = keep ? keep.play : true; if (!keep) chaseActive = false; $('#play').textContent = hotPlay ? 'Pause' : 'Drive'; $('#play').setAttribute('aria-pressed', String(hotPlay));
    kmIn.max = 1; kmIn.step = 0.001; if (!keep) kmIn.value = 0;
    setEnv();
    mk(hd ? 'ready' : 'first view'); requestAnimationFrame(() => requestAnimationFrame(() => mk('first frames')));
    $('#hot-out').textContent = !hd && hdIndex && hdIndex.ids.includes(id) ? 'loading the survey-grade photo, terrain and trees…' : `${Math.round(HOT.pathLength).toLocaleString('en')} m driven · ${(HOT.treeCount || (HOT.H.trees.length / 2) | 0).toLocaleString('en')} trees`;
    // the passages before and after this one: fetched in the background, so the next click opens at once
    if (hd) { const i = hots.indexOf(h); setTimeout(() => { if (HOT && hotMeta === h) [hots[i + 1], hots[i - 1]].forEach((q) => q && prefetchHD(q.id)); }, 1500); }
    setTimeout(() => { if (HOT && hotMeta === h && mode === 'hot') PM.warm(WARM, pmAdapter()); }, 2500);
  }
  function setEnv() {
    const night = $('#t-night').checked && mode === 'hot';
    // survey light: a June afternoon at the spot; night: as the convoys drove
    const h = hotMeta || hots[0];
    const date = new Date(Date.UTC(2025, 5, 11, night ? 21 : 15, night ? 45 : 30));
    const s = sunPosition(date, h.lat, h.lon);
    updateEnvironment(env, s.el, s.az);
    renderer.toneMappingExposure = night ? 2.1 : 1.0;
    if (HOT) HOT.nightLights.visible = night;
  }
  $('#t-night').onchange = setEnv;
  $('#t-swept').onchange = (e) => HOT && HOT.setOverlay(e.target.checked);
  $('#back').onclick = goRoute;
  // (road mode keeps the dock's back button)


  // ---------------------------------------------------------------- the road anywhere: aerial photo strips + survey
  let ROAD = null, roadS = 0, roadPlay = false, rctl = null, roadTok = 0, lastCard = 0, lastLive = null;
  // driving speed (− / + next to Drive): the road view drives at these speeds; the passage drive and the route map scale with it
  const SPEEDS = [2.5, 5, 10, 20, 40, 60, 80, 120, 200];
  let spdI = 4;
  try { const v = localStorage.getItem('route-speed'); if (v !== null && SPEEDS[+v] != null) spdI = +v; } catch (e) { /* storage blocked */ }
  const spdMul = () => SPEEDS[spdI] / 40;
  const showSpeed = () => {
    const v = mode === 'hot' ? 25.2 * spdMul() : SPEEDS[spdI], m = spdMul();
    setTxt($('#spd-out'), mode === 'map' ? `×${m < 1 ? +m.toFixed(3) : +m.toFixed(1)}` : `${v < 10 ? +v.toFixed(1) : Math.round(v)} km/h`);
    $('#spd-dn').disabled = spdI === 0; $('#spd-up').disabled = spdI === SPEEDS.length - 1;
  };
  const setSpeed = (d) => { spdI = Math.max(0, Math.min(SPEEDS.length - 1, spdI + d)); try { localStorage.setItem('route-speed', String(spdI)); } catch (e) { /* storage blocked */ } showSpeed(); };
  const measure = { pts: [], line: null, marks: [] };
  const roadTagEls = [];
  const PK = () => (packIndex ? packIndex.pack_km * 1000 : 5000);
  const availableAt = (k) => packIndex && packIndex.packs.includes(Math.floor((k * 1000) / PK()));
  const nearestAvailable = (k) => { if (!packIndex) return null; let best = null, bd = Infinity;
    for (const p of packIndex.packs) { const a = (p * PK()) / 1000, b = a + PK() / 1000, d = k < a ? a - k : k > b ? k - b : 0; if (d < bd) { bd = d; best = Math.min(Math.max(k, a + 0.05), b - 0.05); } } return best; };
  function updateExplore() {
    const b = $('#explore'); if (!b) return;
    b.hidden = !packIndex;
    b.textContent = availableAt(km) ? 'Explore the road here' : 'Explore the road (nearest photographed stretch)';
  }
  $('#explore').onclick = () => openRoad(km > 0 ? km : 760);
  // hovering the route line on the map: the km under the pointer and how to open the road there
  const hoverTip = document.createElement('div'); hoverTip.id = 'route-tip'; hoverTip.hidden = true; document.body.appendChild(hoverTip);
  let hoverT = 0;
  function nearestRouteKm(cx, cy) {
    const p = mctl.pick(cx, cy); if (!p) return null;
    const r = R.route, x = p.x, y = -p.z; let best = -1, bd = Infinity;
    for (let i = 0; i < r.length; i += 2) { const d = (r[i] - x) ** 2 + (r[i + 1] - y) ** 2; if (d < bd) { bd = d; best = i / 2; } }
    return best >= 0 && Math.sqrt(bd) < Math.max(3000, mctl.dist / 40) ? R.km[best] : null;
  }
  canvas.addEventListener('pointermove', (e) => {
    if (mode !== 'map' || !packIndex || e.buttons) { hoverTip.hidden = true; canvas.style.cursor = ''; return; }
    const now = performance.now(); if (now - hoverT < 120) return; hoverT = now;
    const r = canvas.getBoundingClientRect(), k = nearestRouteKm(e.clientX - r.left, e.clientY - r.top);
    if (k == null) { hoverTip.hidden = true; canvas.style.cursor = ''; return; }
    hoverTip.textContent = `km ${k.toFixed(1)} · click to open the road here`; hoverTip.hidden = false;
    hoverTip.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 12}px)`; canvas.style.cursor = 'pointer';
  });
  canvas.addEventListener('pointerleave', () => { hoverTip.hidden = true; canvas.style.cursor = ''; });
  mctl.onTap = (cx, cy) => {
    if (mode !== 'map' || !packIndex) return;
    const p = mctl.pick(cx, cy); if (!p) return;
    const r = R.route, x = p.x, y = -p.z; let best = -1, bd = Infinity;
    for (let i = 0; i < r.length; i += 2) { const d = (r[i] - x) ** 2 + (r[i + 1] - y) ** 2; if (d < bd) { bd = d; best = i / 2; } }
    if (best >= 0 && Math.sqrt(bd) < Math.max(3000, mctl.dist / 40)) openRoad(R.km[best]);
  };
  function closeRoad() {
    if (!ROAD) return;
    ROAD.scene.remove(sun, sun.target, hemi, sky); ROAD.dispose(); ROAD = null;
    roadTagEls.splice(0).forEach((e) => e.remove());
    clearMeasure(); if (rctl) rctl.enabled = false; roadPlay = false;
  }
  async function openRoad(k) { setUrgent(true); try { return await openRoad0(k); } finally { setUrgent(false); } }
  async function openRoad0(k) {
    const tm = performance.now(), mk = (l) => console.debug(`[road ${k.toFixed(1)}] ${l} ${Math.round(performance.now() - tm)} ms`);
    chaseActive = false;
    if (!packIndex) return;
    const tok = ++roadTok; openToken++;
    if (!availableAt(k)) { const n = nearestAvailable(k); if (n == null) return; k = n; }
    playing = false; chase = false;
    if (HOT) { HOT.scene.remove(sun, sun.target, hemi, sky); HOT.dispose(); HOT = null; }
    hotTagEls.splice(0).forEach((e) => e.remove());
    const fresh = !ROAD || Math.abs(k * 1000 - roadS) > 15000;
    if (fresh) { closeRoad(); ROAD = makeRoad(packIndex, FAR_ROAD, { base: PACK_BASE, vehicle: VEH, renderer, warm: WARM, probe: PROBE, cam: hcam, passages: hots.map((h) => ({ id: h.id, a: h.km[0] * 1000, b: h.km[1] * 1000 })), bladeOf: (id) => decodeBlade(R, id) }); ROAD.convoy.setDims(VEH); ROAD.scene.add(sun, sun.target, hemi, sky); ROAD.setRoads3D($('#t-roads3d').checked); }
    roadS = k * 1000;
    card.innerHTML = `<header><div><span class="label">The road · km ${k.toFixed(1)}</span><h2>Loading the aerial photo…</h2></div><button id="close-card" type="button" aria-label="Back to the route">×</button></header>`;
    $('#close-card').onclick = goRoute;
    if (mode === 'map') { const c = M.kmAt(k); mctl.flyTo(new THREE.Vector3(c.x, c.h, -c.y), 9000, mctl.az, 50, 1.2); }
    // the convoy's swept path is asked of the worker as soon as the first pack's samples are in (while it is built)
    const RD0 = ROAD, liveP = (async () => { for (let i = 0; i < 2400 && ROAD === RD0 && !RD0.samples.length; i++) await new Promise((r) => setTimeout(r, 25)); return ROAD === RD0 ? RD0.liveReady(roadS) : false; })();
    await ROAD.ensure(roadS, true); mk('first pack built');
    if (tok !== roadTok || !ROAD) return;
    ROAD.updateFar(roadS);
    if (fresh) { const RD = ROAD, first = []; RD.scene.traverse((o) => { if (o.material && o.geometry && !inGroup(o, RD.warm)) first.push(o); });
      await Promise.all([WARM.prepare(first, RD.scene, hcam, { slice: slicer(5) }), liveP.then(() => RD.liveReady(roadS)).then(() => mk('swept path'))]); mk('ready'); if (tok !== roadTok || !ROAD || ROAD !== RD) return; }
    else await ROAD.liveReady(roadS);
    mctl.enabled = false;
    hcam.near = 0.3; hcam.far = 26000; hcam.updateProjectionMatrix(); sky.scale.setScalar(20000);
    if (!rctl) { rctl = new GroundOrbit(hcam, canvas, (x, y) => (ROAD ? ROAD.ground(x, y) : 0)); }
    rctl.surface = (x, y) => (ROAD ? ROAD.ground(x, y) : 0);
    rctl.onTap = onRoadTap;
    Object.assign(rctl, { minDist: 6, maxDist: 2500, bound: 1e7, pickMax: 6000, hopMax: 200, enabled: true });
    if (hctl) hctl.enabled = false;
    const q = ROAD.at(roadS);
    if (q && (fresh || mode !== 'road')) rctl.set(new THREE.Vector3(q.x, q.z, -q.y), 140, Math.atan2(q.nx, q.ny) / D2R + 180 + 35, 34, true);
    mode = 'road'; ui.classList.add('hot-mode', 'road-mode'); setActive('');
    tags.querySelectorAll('.pin,.city').forEach((e) => (e.hidden = true)); dest.style.display = 'none';
    kmIn.max = header.km.toFixed(1); kmIn.step = 0.01; kmIn.value = (roadS / 1000).toFixed(2);
    roadPlay = false; $('#play').textContent = 'Drive'; $('#play').setAttribute('aria-pressed', 'false');
    hotMeta = null; setEnv(); lastCard = 0; updateKmOut();
    U.uFogBase.value = q ? q.z : 0; U.uFogH.value = 900;
    roadTags();
    // the kinds of surface a later pack may bring (the warm-up set: every material on an empty triangle, never drawn) made
    // ready behind the view, then given back to the pool; the photo match's programs after them
    if (fresh) { const RD = ROAD; WARM.prepare(RD.warm, RD.scene, hcam, { slice: slicer(4), geometry: false }).then(() => { if (ROAD === RD) RD.warmDone(); }); }
    { const RD = ROAD; setTimeout(() => { if (ROAD === RD && mode === 'road') PM.warm(WARM, pmAdapter()); }, 2500); }
  }
  const clearTxt = (o) => isTun(o) ? `${tunClear(o)}${o.note ? ' · ' + esc(o.note) : ''}` : o.signed != null ? `${o.signed.toFixed(2)}&nbsp;m signed` : o.est != null ? `≈&nbsp;${o.est.toFixed(1)}&nbsp;m&nbsp;±${(o.unc || 0.5).toFixed(1)}${o.top != null ? ` (measured top ${o.top.toFixed(1)}&nbsp;m − structure)` : ''}${o.note ? ' · ' + esc(o.note) : ''}` : o.note ? esc(o.note) : 'not measured';
  const VTXT = { pass: 'passes', check: 'check on site', fail: 'probably too low', unknown: 'unknown' };
  const laneIn = (l) => { const S = ROAD && ROAD.samples; return !!(S && S.length && l.a >= S[0].s && l.a <= S[S.length - 1].s); };
  const lanesHere = () => (header.lanes || []).filter(laneIn).length;
  function roadTags() {
    roadTagEls.splice(0).forEach((e) => e.remove()); tagGen++;
    if (!ROAD) return;
    for (const bi of ROAD.bridgeInfo) {
      if (!bi.rb) continue;
      const e = document.createElement('div'); e.className = 'flag info';
      e.textContent = `route on a bridge, ${Math.round(bi.rb.s1 - bi.rb.s0)} m${bi.rb.under && bi.rb.under.length ? ' · over ' + bi.rb.under.join(', ') : ''}`;
      e.dataset.x = bi.x; e.dataset.y = bi.y; e.dataset.z = bi.z; e.dataset.far = 700; tags.appendChild(e); roadTagEls.push(e);
    }
    for (const l of header.lanes || []) {
      if (!laneIn(l)) continue; const q = ROAD.at(l.a); if (!q) continue;
      // over the middle of lane 2 (next to the convoy's own lane where the pack has it) or of the oncoming lane
      const c = L2(l) && Number.isFinite(q.ow) ? q.ow + 1.875 : (q.L - q.R) / 2 + (q.L - (q.L - q.R) / 2) / 2;
      const e = document.createElement('div'); e.className = 'flag lane';
      e.textContent = L2(l) ? `lane 2 ${Math.round((l.b - l.a) / 10) * 10} m · escort closes it` : `oncoming lane ${Math.round((l.b - l.a) / 10) * 10} m · escort holds traffic`;
      e.dataset.x = q.x + q.nx * c; e.dataset.y = q.y + q.ny * c; e.dataset.z = q.z + 4; e.dataset.far = 900; tags.appendChild(e); roadTagEls.push(e);
    }
    for (const f of extraFlags()) {
      const q = ROAD.at(f.s);
      const e = document.createElement('div'); e.className = 'flag ' + f.cls; e.textContent = f.t;
      e.dataset.x = q.x; e.dataset.y = q.y; e.dataset.z = q.z + f.z; e.dataset.far = 900; tags.appendChild(e); roadTagEls.push(e);
    }
    for (const f of passFlags()) {
      const q = ROAD.at(f.s); if (!q) continue;
      const e = document.createElement('div'); e.className = 'flag ' + (f.sev >= 2 ? 's2' : f.sev >= 1 ? 's1' : 'info');
      e.textContent = [...f.w].slice(0, 3).join(' · ') + (f.w.size > 3 ? ` +${f.w.size - 3}` : '');
      e.dataset.x = q.x; e.dataset.y = q.y; e.dataset.z = q.z + 5; e.dataset.far = 700; tags.appendChild(e); roadTagEls.push(e);
    }
    for (const g of ROAD.gates) {
      const e = document.createElement('div'); e.className = 'flag ' + (g.v === 'fail' ? 's2' : g.v === 'check' ? 's1' : g.v === 'pass' ? 'ok' : 's1');
      e.innerHTML = `${esc(structName(g.o))} · ${g.c != null ? (g.o.signed != null ? '' : '≈') + g.c.toFixed(1) + ' m' : g.o.check && g.o.top != null ? 'top ' + g.o.top.toFixed(1) + ' m' : isTun(g.o) && g.o.std ? g.o.std.toFixed(2) + ' m standard' : 'height ?'} · ${g.v === 'fail' && g.o.signed != null ? 'too low' : VTXT[g.v]}`;
      e.dataset.x = g.x; e.dataset.y = g.y; e.dataset.z = g.z; e.dataset.far = g.v === 'fail' ? 1500 : 800; tags.appendChild(e); roadTagEls.push(e);
    }
  }
  // objects next to or under the swept path: name, height and where the height comes from
  const objTagEls = [];
  function objectTags() {
    objTagEls.splice(0).forEach((e) => e.remove()); tagGen++;
    if (!ROAD || !ROAD.live || !$('#t-labels-road').checked) return;
    const L = ROAD.live;
    for (const o of ROAD.objects) {
      const t = ROAD.toRoute(o.x, o.y); if (!t || t.s < L.sa || t.s > L.sb || Math.abs(t.d) > 30) continue;
      const q = overPoint(VEH, L.res, L.P, L.N, o.x, o.y);
      const near = q.wheels || q.under < Infinity || q.gap < 1.5;
      if (!near && (Math.abs(t.d) > 15 || !LABEL_CLS.has(o.cls))) continue;     // far from the road or minor: no label
      let cls = 'info', txt;
      const nm = `${OBJ_NAME[o.cls] || o.cls.replace('_', ' ')} ${o.h.toFixed(1)} m`;
      if (q.wheels) { cls = 's2'; txt = `${nm} · in the wheels' path`; }
      else if (q.under < Infinity) {
        const free = q.under - o.h;
        cls = free < 0.1 ? 's2' : free < 0.5 ? 's1' : 'ok';
        txt = free < 0.1 ? `${nm} · blade underside ${q.under.toFixed(1)} m: hits` : `${nm} · blade passes ${free.toFixed(1)} m above`;
      } else if (q.gap < Infinity) { cls = q.gap < 0.5 ? 's1' : near ? 'ok' : 'info'; txt = `${nm} · ${Math.max(0, q.gap).toFixed(1)} m beside the blade`; }
      else txt = nm;
      const e = document.createElement('div'); e.className = 'flag obj ' + cls;
      e.textContent = txt + (o.src.startsWith('typical') ? ' · typ. height' : '') + (o.kerb ? ' · at kerb' : '');
      e.dataset.x = o.x; e.dataset.y = o.y; e.dataset.z = ROAD.ground(o.x, o.y) + o.h + 0.5; e.dataset.far = cls === 's2' ? 900 : cls === 's1' ? 500 : 260;
      tags.appendChild(e); objTagEls.push(e);
    }
  }
  const LABEL_CLS = new Set(['traffic_signals', 'stop', 'give_way', 'information', 'street_lamp', 'power_pole', 'power_tower', 'camera', 'speed_camera', 'toll_booth', 'barrier', 'bus_stop']);
  const OBJ_NAME = { traffic_signals: 'signal', street_lamp: 'lamp', stop: 'stop sign', give_way: 'give-way sign', information: 'sign', bus_stop: 'bus stop',
    power_pole: 'power pole', power_tower: 'pylon', bollard: 'bollard', barrier: 'barrier', toll_booth: 'toll booth', camera: 'camera', speed_camera: 'speed camera' };
  const FAR_ROAD = { tex: farTex, map: Hd, height: (x, y) => M.hgt(x, y) / EXAG };
  function fmt(v, d = 1, u = 'm') { return Number.isFinite(v) ? `${v.toFixed(d)}&nbsp;${u}` : '–'; }
  function roadAt(k) {                       // the road under the convoy: ref (and name in towns) from the route's road network
    const T = R.header.roads; if (!T || !T.length) return '';
    let a = 0, b = T.length - 1; while (a < b) { const c = (a + b + 1) >> 1; if (T[c][0] <= k) a = c; else b = c - 1; }
    const [, ref, nm] = T[a]; return ref && nm ? `${ref} · ${nm}` : ref || nm;
  }
  // open street-level photos at a passage (route_pix.py → h/pix_<id>.json, loaded when first shown)
  const PIXC = {};
  const pixStrip = (h) => {
    if (!h.pix || !hdIndex) return '';                // (no detail data folder reachable: no photo list either)
    const P = PIXC[h.id];
    if (!P) { PIXC[h.id] = 'loading'; fetch(PACK_BASE + 'h/pix_' + h.id + '.json').then((r) => r.json()).then((j) => { PIXC[h.id] = j; lastCard = 0; if (mode === 'hot' && hotMeta && hotMeta.id === h.id) { const el = $('#pix-' + h.id); if (el) el.outerHTML = pixStrip(h); } }).catch(() => { PIXC[h.id] = { pics: [] }; }); return `<div id="pix-${h.id}"></div>`; }
    if (P === 'loading' || !P.pics.length) return `<div id="pix-${h.id}"></div>`;
    return `<div id="pix-${h.id}" class="pix"><h3>Street-level photos</h3><div class="pix-row">${P.pics.map((p) => pixA(P.hosts, p.h, p.id, p.s, p.t, p.fwd, p.img)).join('')}</div><p class="note">Panoramax${P.lic ? ', ' + esc(P.lic) : ''}${P.by ? ' · ' + esc(P.by) : ''}; photos may predate roadworks and changes. Where a thumbnail cannot load here, the link opens the photo.</p></div>`;
  };
  // a Panoramax picture: the thumbnail straight from its instance (in the viewer's browser), linked to the Panoramax viewer
  const pixA = (hosts, h, id, s0, t, fwd, img, note) => `<a href="https://api.panoramax.xyz/#focus=pic&pic=${encodeURIComponent(id)}" target="_blank" rel="noopener" title="Open in Panoramax"><img src="${img || `https://${hosts[h]}/api/pictures/${encodeURIComponent(id)}/thumb.jpg`}" alt="" loading="lazy" referrerpolicy="no-referrer"><span>${note || `Street photo ↗ km ${(s0 / 1000).toFixed(2)}`} · ${esc(t)}${fwd === 0 || fwd === false ? ' · facing back' : ''}</span></a>`;
  // photos looking at the critical structures (h/pix_bridges.json, fetched once the road view shows one)
  let BRPIX = null;
  const brPix = (o) => {
    if (BRPIX === null) { BRPIX = 'loading'; fetch(PACK_BASE + 'h/pix_bridges.json').then((r) => r.json()).then((j) => { BRPIX = j; lastCard = 0; }).catch(() => { BRPIX = { pics: {} }; }); }
    const p = BRPIX && BRPIX !== 'loading' && BRPIX.pics[String(Math.round(o.s))];
    return p ? `<div class="pix one">${pixA(BRPIX.hosts, p.h, p.id, p.s, p.t, true, p.img, `Photo ${Math.round(o.s - p.s)} m before it ↗`)}</div>` : '';
  };
  card.addEventListener('error', (e) => { if (e.target.tagName === 'IMG' && e.target.closest('.pix')) e.target.remove(); }, true);
  // the nearest picture ahead of the convoy in the loaded road packs (one per 100 m where Panoramax has any)
  function nearPix() {
    if (!ROAD) return null; let best = null;
    for (const P of ROAD.packs.values()) for (const r of P.hdr.pix || []) { const d = r[0] - roadS; if (d > -40 && d < 160 && (!best || Math.abs(d) < Math.abs(best.r[0] - roadS))) best = { r, hosts: P.hdr.pixh }; }
    return best;
  }
  // the survey point being driven: everything its review found, the findings ahead with their distance, and every measure
  const confName = (c) => c.what.replace(/ \d.*$/, '').replace('building-near', 'building close by');
  const passageBlock = (h) => {
    const a = h.km[0] * 1000, b = h.km[1] * 1000, r10 = (v) => Math.max(0, Math.round(v / 10) * 10);
    const where = roadS < a ? `starts in ${r10(a - roadS)}&nbsp;m` : roadS <= b ? `driving it · ${r10(b - roadS)}&nbsp;m to go` : 'just passed';
    const placed = (h.conflicts || []).filter((c) => c.s != null), loose = (h.conflicts || []).filter((c) => c.s == null);
    const ahead = placed.map((c) => ({ c, d: c.s - roadS })).filter((q) => q.d > -40).sort((p, q) => p.d - q.d);
    const groups = {};
    for (const c of loose) { const g = (groups[confName(c)] ||= { n: 0, len: 0, area: 0, sev: 0 }); g.n++; g.len += c.length || 0; g.area += c.area || 0; g.sev = Math.max(g.sev, c.sev); }
    const extra = (c) => `${c.length ? ` · ${Math.round(c.length)}&nbsp;m` : ''}${c.area ? ` · ${Math.round(c.area)}&nbsp;m²` : ''}`;
    const items = [...ahead.slice(0, 12).map(({ c, d }) => `<li><b class="${c.sev >= 2 ? 'warn' : ''}">${esc(confName(c))}</b> ${d > 0 ? `in ${r10(d)}&nbsp;m` : 'here'}${extra(c)}</li>`),
      ...Object.entries(groups).map(([k, g]) => `<li><b class="${g.sev >= 2 ? 'warn' : ''}">${esc(k)}</b>${g.n > 1 ? ` × ${g.n}` : ''}${extra(g)}</li>`)];
    const passed = placed.length - ahead.length;
    return `<section class="pass">
      <h3>${h.role === 'start' ? 'Start' : 'Survey point ' + hots.indexOf(h)} · ${esc(h.title)} <span class="muted">· ${where}</span></h3>
      <p class="verdict s${h.sev}">${h.incident ? 'Incident on record · ' : ''}${SEVTXT[h.sev]}</p>
      ${h.why ? `<p class="sub">${esc(h.why.charAt(0).toUpperCase() + h.why.slice(1))}.</p>` : ''}
      <dl>
        <dt>Tightest curve</dt><dd>${h.minR == null ? '–' : h.minR + '&nbsp;m'}${h.maxTurn > 60 ? ` · junction turn ${h.maxTurn}°` : ''}</dd>
        <dt>Wheels off the carriageway</dt><dd>${h.wheelOut > 0.1 ? `<span class="warn">up to ${h.wheelOut.toFixed(1)}&nbsp;m · ${h.wheelArea}&nbsp;m²</span>` : `no · ${Math.max(0, h.wheelClear).toFixed(1)}&nbsp;m to the edge`}</dd>
        <dt>Blade beyond the road edge</dt><dd>${h.bladeOut > 0.3 ? `up to ${h.bladeOut.toFixed(h.bladeOut < 10 ? 1 : 0)}&nbsp;m${h.bladeArea >= 1 ? ` · ${h.bladeArea}&nbsp;m²` : ''}` : 'no'}</dd>
        <dt>Steepest grade (200 m)</dt><dd>${h.grade.toFixed(1)}&nbsp;%</dd>
        ${h.lane ? `<dt>${laneWord(h.lane).Lane}</dt><dd>about ${Math.round(h.lane.m / 10) * 10}&nbsp;m, wheels up to ${h.lane.across.toFixed(1)}&nbsp;m ${laneWord(h.lane).across}; ${laneWord(h.lane).esc}</dd>` : ''}
      </dl>
      <p class="note">Survey figures for the modelled convoy; the live figures above are re-driven with your vehicle.</p>
      ${items.length ? `<h3>In the swept path${ahead.length ? ' ahead' : ''}${passed > 0 ? ` <span class="muted">(${passed} passed)</span>` : ''}</h3><ul>${items.join('')}</ul>` : ''}
      ${h.measures.length ? `<h3>Measures</h3><ol>${h.measures.map((m) => `<li>${esc(m)}</li>`).join('')}</ol>` : ''}
      ${h.incident ? `<p class="sub"><b>Incident on record:</b> ${esc(h.incident)}</p>` : ''}
      ${(h.evidence || []).length ? `<h3>Reported</h3>${h.evidence.map((e) => `<blockquote>${esc(e.t)}<cite>${esc(e.s)} · <a href="${esc(e.u)}" target="_blank" rel="noopener">source</a></cite></blockquote>`).join('')}` : ''}
      ${(() => { const W = ((header.roadworks || {}).items || []).filter((q) => q.b >= a - 200 && q.a <= b + 200); return W.length ? `<h3>Roadworks here (${esc(header.roadworks.date)})</h3><ul>${W.map((q) => `<li>${rwTxt(q)}</li>`).join('')}</ul>` : ''; })()}
      ${h.note ? `<p class="note"><b>Review:</b> ${esc(h.note)}</p>` : ''}
      ${pixStrip(h)}
      <p class="note"><a href="#" id="go-hot">Open this passage in 3D (survey-grade photo and terrain, trees, lane plan) →</a></p>
    </section>`;
  };
  // flags on the road for overhead lines, roadworks and signed limits (only those within the loaded stretch)
  const extraFlags = () => {
    const S = ROAD && ROAD.samples; if (!S || !S.length) return [];
    const s0 = S[0].s, s1 = S[S.length - 1].s, out = [];
    for (const q of (header.osm || {}).lines || []) if (q.s >= s0 && q.s <= s1) out.push({ s: q.s, z: 9, cls: q.low ? 's1' : 'info', t: lineTxt(q).replace(/&nbsp;/g, ' ') });
    for (const q of (header.roadworks || {}).items || []) if (q.a >= s0 && q.a <= s1) out.push({ s: q.a, z: 5, cls: rwNarrow(q) || q.k === 'c' ? 's2' : 's1', t: `roadworks${q.w != null ? ' · max width ' + q.w + ' m' : ''}${q.k === 'c' ? ' · closure' : ''}` });
    for (const q of (header.osm || {}).lim || []) if (q.a >= s0 && q.a <= s1) out.push({ s: q.a, z: 5, cls: 's2', t: limTxt(q).replace(/&nbsp;/g, ' ') });
    return out.filter((f) => ROAD.at(f.s));
  };
  // flags on the road for the survey points' findings that have a place (one flag per 25 m, the worst first)
  const passFlags = () => {
    const S = ROAD && ROAD.samples; if (!S || !S.length) return [];
    const s0 = S[0].s, s1 = S[S.length - 1].s, bins = new Map();
    for (const h of hots) {
      if (h.km[1] * 1000 < s0 || h.km[0] * 1000 > s1) continue;
      for (const c of h.conflicts || []) {
        if (c.s == null || c.s < s0 || c.s > s1) continue;
        const k = Math.round(c.s / 25), g = bins.get(k) || { s: c.s, sev: 0, w: new Set() };
        g.sev = Math.max(g.sev, c.sev); g.w.add(confName(c)); bins.set(k, g);
      }
    }
    return [...bins.values()];
  };
  function roadCard() {
    if (!ROAD) return;
    const sv = ROAD.survey(roadS); if (!sv) return;
    const k = roadS / 1000, l = legAt(k);
    const lv = ROAD.liveAt(roadS);
    const width = sv.L + sv.R, wm = lv ? lv.wc : sv.wm, bz = ROAD.bladeAtS(roadS), out = bz != null ? bz : Math.max(sv.bL || 0, sv.bR || 0);
    const q0 = ROAD.at(roadS), dv0 = q0 && q0.dv != null ? q0.dv : null;          // the planned tractor line (keep right)
    const tnl = ROAD.tunnelAt ? ROAD.tunnelAt(roadS) : null;                        // in a tunnel: its edges are not measured
    const curve = Number.isFinite(sv.Rc) && sv.Rc < 2500 ? `${Math.round(sv.Rc)}&nbsp;m` : 'straight';
    const wheel = Number.isFinite(wm) ? (wm < 0 ? `<span class="warn">${(-wm).toFixed(1)}&nbsp;m off the paved edge</span>` : `${wm.toFixed(1)}&nbsp;m to the edge`) : dv0 != null ? `${Math.max(0, sv.R + dv0 - 1.45).toFixed(1)}&nbsp;m to the right edge (planned line, keeping right)` : `${Math.max(0, (sv.L + sv.R) / 2 - 1.45).toFixed(1)}&nbsp;m to the edge (straight, centred)`;
    const near = hots.find((h) => k > h.km[0] - 0.3 && k < h.km[1] + 0.3);
    // the card is refreshed every 0.4 s while driving: the profile chart keeps its canvas, the text above and below it is
    // only rewritten where it changed
    if (!card.querySelector('#rc-top')) { card.innerHTML = `<div id="rc-head"></div><div id="rc-pass"></div><div id="rc-top"></div><canvas id="prof" width="640" height="300" aria-label="Profile: carriageway width, curve radius and wheel clearance over the next 2 km"></canvas><div id="rc-bot"></div>`; card._h = null; drawProfile.ink = null; }
    const top = `
      <header><div><span class="label">The road · km ${k.toFixed(2)}</span><h2>${esc(roadAt(k) || l.roads.split('·')[0].trim())}</h2></div><button id="close-card" type="button" aria-label="Back to the route">×</button></header>
      <p class="sub">${esc(l.name)} · vehicle ${derived(VEH).length.toFixed(1)}&nbsp;m long, ${VEH.height.toFixed(2)}&nbsp;m high, blade ${VEH.bladeLength.toFixed(1)}&nbsp;m (<a href="#" id="edit-veh">change</a>)</p>
      ${Object.keys(DEFAULTS).every((key) => VEH[key] === DEFAULTS[key]) ? `<p class="note"><b>Checked with the default convoy</b> (V172 blade, a typical blade transporter). <a href="#" id="edit-veh2">Enter your blade and haulier</a> – the swept path, clear heights and objects are re-checked with them.</p>` : ''}
      %%SPLIT%%<dl>
        ${tnl ? `<dt>Carriageway (in the ${tnl.t.kind === 'overpass' ? 'overpass' : 'tunnel'}: not measured, the photo shows its ${tnl.t.kind === 'overpass' ? 'deck' : 'lid'}; carried over from the portals)</dt>` : '<dt>Carriageway (measured on the photo)</dt>'}<dd><span class="kv-strong">${fmt(width)}</span></dd>
        <dt>Left / right of the route line</dt><dd>${fmt(sv.L)} / ${fmt(sv.R)}</dd>
        <dt>Curve radius (50 m)</dt><dd>${curve}</dd>
        <dt>Gradient (100 m, ${[...ROAD.packs.values()].some((P) => P.hdr.xrd) ? 'laser terrain where the state has one' : 'GLO-30'}; on bridges the deck)</dt><dd>${fmt(sv.grade, 1, '%')}</dd>
        <dt>Wheels of the convoy</dt><dd>${wheel}</dd>
        <dt>Blade beyond the edge</dt><dd>${out > 0.3 ? `<span class="warn">${out.toFixed(1)}&nbsp;m</span>` : 'no'}</dd>
        ${lv ? `<dt>Next 1.5 km (your vehicle)</dt><dd>${lv.ahead.wmin < 0 ? `<span class="warn">wheels ${(-lv.ahead.wmin).toFixed(1)}&nbsp;m off at km ${(lv.ahead.wAtS / 1000).toFixed(2)}</span>` : `wheels ≥ ${lv.ahead.wmin.toFixed(1)}&nbsp;m inside`}${lv.ahead.bmax > 0.3 ? `; blade ${lv.ahead.bmax.toFixed(0)}&nbsp;m beyond the edge at km ${(lv.ahead.bAtS / 1000).toFixed(2)}` : ''}</dd>` : ''}
        ${sv.occl > 0.3 && !tnl ? `<dt>Edge</dt><dd>partly hidden (trees, shadow, bridge) – bridged</dd>` : ''}
        ${q0 && q0.lq === 0 && !q0.tw && !tnl ? `<dt>Lanes</dt><dd>the painted lines are not readable on the photo here (roadworks, tree shadows, a raised deck): the layout of the stretches around is drawn</dd>` : ''}
        ${sv.openL || sv.openR ? `<dt>Junction / lay-by</dt><dd>${sv.openL ? 'left' : ''}${sv.openL && sv.openR ? ' and ' : ''}${sv.openR ? 'right' : ''}</dd>` : ''}
      </dl>
      ${(() => {
        // one entry per structure (a tunnel's two portal gates share it): the distance to it, 0 while the convoy is in a
        // tunnel or under a covered section or green bridge ("in it now", with its exit), kept until 50 m after it
        const seenT = new Set(), ahead = [];
        for (const g of ROAD.gates) {
          const o = g.o, tun = isTun(o), key = tun ? 't' + Math.round(o.s) : o; if (seenT.has(key)) continue;
          const s1 = tun ? o.s + (o.len || 0) : o.s, d = roadS < o.s ? o.s - roadS : roadS <= s1 ? 0 : s1 - roadS;
          if (d < -50 || d > 2500) continue;
          seenT.add(key); ahead.push({ g, d, exit: tun && roadS >= o.s && roadS <= s1 ? s1 - roadS : null });
        }
        ahead.sort((a, b) => a.d - b.d); ahead.length = Math.min(6, ahead.length);
        const W = (header.roadworks || {}).items || [], O = header.osm || { lines: [], lim: [] };
        const rw = W.filter((q) => q.b >= roadS - 100 && q.a <= roadS + 2500), ln = O.lines.filter((q) => q.s >= roadS - 50 && q.s <= roadS + 2500), lm = O.lim.filter((q) => q.b >= roadS - 100 && q.a <= roadS + 2500);
        const more = [...rw.map((q) => `<li>${q.a <= roadS ? '<b>in roadworks</b>' : `roadworks in ${Math.round((q.a - roadS) / 10) * 10}&nbsp;m`} · ${rwTxt(q)}</li>`),
          ...ln.map((q) => `<li><b class="${q.low ? 'warn' : 'ok'}">${q.low ? 'check sag' : 'high above'}</b> · ${lineTxt(q)} in ${Math.max(0, Math.round((q.s - roadS) / 10) * 10)}&nbsp;m</li>`),
          ...lm.map((q) => `<li><b class="warn">${limTxt(q)}</b>${q.a > roadS ? ` in ${Math.round((q.a - roadS) / 10) * 10}&nbsp;m` : ' here'}</li>`)];
        const moreH = more.length ? `<h3>Also ahead (roadworks, overhead lines, signed limits)</h3><ul>${more.join('')}</ul>` : '';
        return moreH + (ahead.length ? `<h3>Over the road, next 2.5 km (your load ${VEH.height.toFixed(2)}&nbsp;m + ${VEH.heightMargin.toFixed(2)}&nbsp;m)</h3><ul>${ahead.map(({ g, d, exit }) => `<li><b class="${g.v === 'fail' ? 'warn' : g.v === 'pass' ? 'ok' : ''}">${g.v === 'fail' && g.o.signed != null ? 'too low' : VTXT[g.v]}</b> · ${esc(structName(g.o))}${g.o.name ? ' ' + esc(g.o.name) : ''} ${exit != null ? `<b>in it now</b>, exit in ${Math.max(0, Math.round(exit / 10) * 10)}&nbsp;m` : d < 0 ? 'just passed' : `in ${Math.max(0, Math.round(d / 10) * 10)}&nbsp;m`}: ${clearTxt(g.o)}${mapsA(linksAt(g.x, g.y, 'road'), 'Maps')}${d > -20 && d < 900 ? brPix(g.o) : ''}</li>`).join('')}</ul>` : `<p class="note">No structure over the road in the next 2.5 km.</p>`); })()}`;
    const bot = `
      <p class="note">Profile from 500 m behind to 1.5 km ahead: carriageway width (cyan), wheel clearance to the edge (amber, below zero = off the paved surface), curves under 500 m (bars). Tap the road with <b>Measure</b> on for distances and widths.</p>
      ${(() => { const b = nearPix(); return b ? `<div class="pix one">${pixA(b.hosts, b.r[4], b.r[1], b.r[0], b.r[2], b.r[3])}</div>` : ''; })()}
      <p class="note" id="measure-out"></p>
      <p class="note">Aerial photo: ${esc([...ROAD.packs.values()].flatMap((P) => P.hdr.credit).filter((v, i, a) => a.indexOf(v) === i).join(' · '))}${(() => { const h = [...ROAD.packs.values()].flatMap((P) => P.hdr.hcredit || []).filter((v, i, a) => a.indexOf(v) === i); return h.length ? ' · Heights: ' + esc(h.join(' · ')) : ' · Heights: no open height model reachable here, typical values shown'; })()}</p>`;
    const [head, rest] = top.split('%%SPLIT%%');
    setHTML($('#rc-top'), rest);
    if (setHTML($('#rc-head'), head)) { $('#close-card').onclick = goRoute; for (const id of ['#edit-veh', '#edit-veh2']) { const ev = $(id); if (ev) ev.onclick = (e) => { e.preventDefault(); showVeh(true); }; } }
    setHTML($('#rc-bot'), bot);
    if (setHTML($('#rc-pass'), near ? passageBlock(near) : '') && near) $('#go-hot').onclick = (e) => { e.preventDefault(); openHot(near.id); };
    drawProfile(); showMeasure();
  }
  function drawProfile() {
    const cv = $('#prof'); if (!cv || !ROAD) return;
    const g = cv.getContext('2d'), W = cv.width, H = cv.height;
    const sa = roadS - 500, sb = roadS + 1500, rows = ROAD.profile(sa, sb, 10);
    g.clearRect(0, 0, W, H);
    const ink = (drawProfile.ink ||= getComputedStyle(document.documentElement).getPropertyValue('--ink-3').trim() || '#789');
    const X = (s) => ((s - sa) / (sb - sa)) * W;
    const Yw = (v) => H - 24 - (Math.min(24, Math.max(0, v)) / 24) * (H - 40);
    g.font = '20px system-ui'; g.fillStyle = ink;
    for (const v of [6, 12, 18, 24]) { g.globalAlpha = 0.35; g.fillRect(0, Yw(v), W, 1); g.globalAlpha = 1; g.fillText(v + ' m', 4, Yw(v) - 4); }
    // curves
    g.fillStyle = 'rgba(160,110,255,0.35)';
    for (const r of rows) if (r && r.Rc < 500) g.fillRect(X(r.s), H - 22, Math.max(1, W / 200), 22 * (1 - r.Rc / 500) + 3);
    const line = (key, col, f) => { g.strokeStyle = col; g.lineWidth = 3; g.beginPath(); let on = false;
      for (const r of rows) { if (!r || !Number.isFinite(f(r))) { on = false; continue; } const x = X(r.s), y = Yw(f(r)); on ? g.lineTo(x, y) : g.moveTo(x, y); on = true; } g.stroke(); };
    line('w', '#22c8e8', (r) => r.L + r.R);
    line('c', '#ffa020', (r) => (Number.isFinite(r.wm) ? r.wm * 4 : NaN));
    g.fillStyle = '#ff3020'; for (const r of rows) if (r && r.wm < 0) g.fillRect(X(r.s) - 2, Yw(0) - 2, 4, 6);
    g.fillStyle = ink; g.globalAlpha = 0.9; g.fillRect(X(roadS) - 1, 0, 2, H - 22); g.globalAlpha = 1;
    g.fillText('convoy', X(roadS) + 6, 22); g.fillText('+1.5 km', W - 92, 22);
  }
  function clearMeasure() {
    measure.pts = []; if (measure.line) { measure.line.parent && measure.line.parent.remove(measure.line); measure.line.geometry.dispose(); measure.line = null; }
    measure.marks.forEach((m) => m.parent && m.parent.remove(m)); measure.marks = [];
  }
  const markGeo = new THREE.CylinderGeometry(0.25, 0.25, 3, 10); markGeo.translate(0, 1.5, 0);
  const markMat = new THREE.MeshBasicMaterial({ color: 0xff2bd6 });
  function onRoadTap(cx, cy) {
    if (!ROAD || !$('#t-measure').checked) return;
    const p = rctl.pick(cx, cy); if (!p) return;
    if (measure.pts.length >= 2) clearMeasure();
    const x = p.x, y = -p.z, z = ROAD.ground(x, y);
    measure.pts.push({ x, y, z });
    const m = new THREE.Mesh(markGeo, markMat); m.position.set(x, z, -y); ROAD.scene.add(m); measure.marks.push(m);
    if (measure.pts.length === 2) {
      const [a, b] = measure.pts; const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(a.x, a.z + 0.4, -a.y), new THREE.Vector3(b.x, b.z + 0.4, -b.y)]);
      measure.line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xff2bd6, depthTest: false })); measure.line.renderOrder = 9; ROAD.scene.add(measure.line);
    }
    showMeasure();
  }
  function showMeasure() {
    const o = $('#measure-out'); if (!o || !ROAD) return;
    if (!measure.pts.length) { setHTML(o, ''); return; }
    const a = measure.pts[0], ra = ROAD.toRoute(a.x, a.y), sv = ra ? ROAD.survey(ra.s) : null;
    let t = ra ? `Point A: km ${(ra.s / 1000).toFixed(3)}, ${Math.abs(ra.d).toFixed(1)} m ${ra.d >= 0 ? 'left' : 'right'} of the route line${sv ? `; carriageway there ${(sv.L + sv.R).toFixed(1)} m (${sv.L.toFixed(1)} left, ${sv.R.toFixed(1)} right)` : ''}.${mapsA(linksAt(a.x, a.y, 'road'), 'A in Google Maps')}` : '';
    if (measure.pts.length === 2) { const b = measure.pts[1]; const d = Math.hypot(b.x - a.x, b.y - a.y); t += ` <b>A → B: ${d.toFixed(2)} m</b> horizontal, height difference ${(b.z - a.z).toFixed(1)} m.${mapsA(linksAt(b.x, b.y, 'road'), 'B in Google Maps')}`; }
    setHTML(o, t);
  }
  $('#t-measure').onchange = (e) => { if (!e.target.checked) { clearMeasure(); showMeasure(); } };
  $('#t-swept').addEventListener('change', (e) => ROAD && ROAD.setOverlay(e.target.checked));

  // where am I: latitude / longitude of the view centre and of tapped points, with links to Google Maps to check them there
  function llOf(x, y, frame) {
    if (frame === 'road') { const O = ROAD && ROAD.origin; return O ? utm33(x + O.x, y + O.y) : null; }
    if (frame === 'hot') return hotMeta ? tmInverse(x, y, { lon0: hotMeta.lon, lat0: hotMeta.lat }) : null;
    return tmInverse(x, y, { lon0: header.map.lon0, lat0: header.map.lat0 });
  }
  function linksAt(x, y, frame, heading, viewWidth) {
    const ll = llOf(x, y, frame); if (!ll) return null;
    const lon0 = frame === 'road' ? 15 : frame === 'hot' ? hotMeta.lon : header.map.lon0;
    return mapsLinks(ll[0], ll[1], Number.isFinite(heading) ? heading + convergence(ll[0], ll[1], lon0) : undefined, viewWidth);
  }
  function mapsA(L, txt = 'Google Maps') { return L ? ` <a class="maps-link" href="${L.pin}" target="_blank" rel="noopener">${txt}&nbsp;↗</a>` : ''; }
  let hereLL = null;
  function updateHere() {
    const frame = mode === 'road' ? 'road' : mode === 'hot' ? 'hot' : 'map';
    const ctl = frame === 'road' ? rctl : frame === 'hot' ? hctl : mctl, cam = frame === 'map' ? mcam : hcam;
    if (!ctl) return;
    const t = ctl.target, heading = Math.atan2(t.x - cam.position.x, cam.position.z - t.z) / D2R;
    const L = linksAt(t.x, -t.z, frame, heading, 1.3 * (ctl.dist || 500)); if (!L) return;
    hereLL = L;
    setTxt($('#here-ll'), L.text); for (const [id, u] of [['#g-pin', L.pin], ['#g-sat', L.sat], ['#g-street', L.street]]) { const a = $(id); if (a._u !== u) { a._u = u; a.href = u; } }
  }
  setInterval(updateHere, 500);
  $('#g-copy').onclick = () => {
    if (!hereLL) return; const t = `${hereLL.lat.toFixed(6)}, ${hereLL.lon.toFixed(6)}`;
    const done = () => { $('#g-copy').textContent = 'copied'; setTimeout(() => { $('#g-copy').textContent = 'copy'; }, 1200); };
    try { navigator.clipboard.writeText(t).then(done, () => { const r = document.createRange(); r.selectNodeContents($('#here-ll')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }); } catch { /* selection fallback above */ }
  };

  // timeline
  const kmOut = $('#km-out');
  const updateKmOut = () => {
    showSpeed();
    if (mode === 'road') { setTxt(kmOut, `km ${(roadS / 1000).toFixed(2)}`); return; }
    if (mode === 'hot' && HOT) {
      const m = hotU * HOT.pathLength;
      setTxt(kmOut, `km ${fmtKm(hotMeta.km[0] + m / 1000)}`);
      return;
    }
    setTxt(kmOut, `km ${fmtKm(km)}`);
    updateExplore();
    const l = legAt(km), n = nightAt(km);
    setTxt($('#leg-out'), l.name);
    setTxt($('#night-out'), `Night ${n.n} (illustrative)`);
    M.setProgress(playing || km > 0 ? km : -1);
  };
  let jumpT = 0;
  kmIn.addEventListener('input', () => {
    if (mode === 'road') { const k = +kmIn.value; roadPlay = false; $('#play').textContent = 'Drive';
      if (Math.abs(k * 1000 - roadS) > 15000 || !availableAt(k)) { clearTimeout(jumpT); jumpT = setTimeout(() => openRoad(k), 250); }
      else { roadS = k * 1000; ROAD && ROAD.ensure(roadS); lastCard = 0; }
      updateKmOut(); return; }
    if (mode === 'hot') { hotU = +kmIn.value; hotPlay = false; $('#play').textContent = 'Drive'; return; }
    km = +kmIn.value; chase = true; updateKmOut();
  });
  $('#spd-dn').onclick = () => setSpeed(-1); $('#spd-up').onclick = () => setSpeed(1);
  window.addEventListener('keydown', (e) => { if (e.target.closest('input:not([type=range]),textarea')) return; if (e.key === '+' || e.key === '=') setSpeed(1); else if (e.key === '-' || e.key === '_') setSpeed(-1); });
  $('#play').onclick = () => {
    if (mode === 'road') { roadPlay = !roadPlay; $('#play').textContent = roadPlay ? 'Pause' : 'Drive'; $('#play').setAttribute('aria-pressed', String(roadPlay)); if (roadPlay) { $('#t-follow').checked = true; chaseStart(rctl); } return; }
    if (mode === 'hot') { hotPlay = !hotPlay; if (hotPlay && hotU >= 0.999) hotU = 0; $('#play').textContent = hotPlay ? 'Pause' : 'Drive'; $('#play').setAttribute('aria-pressed', String(hotPlay)); if (hotPlay && $('#t-follow').checked) chaseStart(hctl); return; }
    playing = !playing; chase = playing;
    if (playing && km >= header.km - 0.5) km = 0;
    $('#play').textContent = playing ? 'Pause' : 'Drive the route'; $('#play').setAttribute('aria-pressed', String(playing));
  };
  updateKmOut();

  // ---------------------------------------------------------------- resize, loop
  const resize = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight; VW = w; VH = h; freeAt = 0;
    renderer.setSize(w, h, false);
    // the free area between the side panels and above the dock
    const L = $('#left').getBoundingClientRect(), Rr = $('#right').getBoundingClientRect(), Dk = $('#dock').getBoundingClientRect();
    const wide = w > 760;
    const fx0 = wide ? L.right : 0, fx1 = wide ? Rr.left : w, fy1 = wide ? Dk.top : h * 0.55;
    const dx = (fx0 + fx1) / 2 - w / 2, dy = (fy1 + (wide ? 0 : 60)) / 2 - h / 2;
    for (const cam of [mcam, hcam]) { cam.aspect = w / h; cam.setViewOffset(w, h, -dx, -dy, w, h); cam.updateProjectionMatrix(); }
    const pr = renderer.getPixelRatio(); M.setRes(w * pr, h * pr);
  };
  new ResizeObserver(resize).observe(canvas); resize();
  window.addEventListener('keydown', (e) => { if (e.key === 'h' && !e.target.closest('input')) ui.classList.toggle('hide'); if (e.key === 'Escape' && (mode === 'hot' || mode === 'road')) goRoute(); });

  // ---------------------------------------------------------------- performance overlay (?perf or #perf in the address, P or Shift+P)
  // measures nothing while hidden (the frame loop checks one flag). Shown: frames per second, the time between drawn frames
  // (median, 95th percentile, slowest) and the 1 % low over the last 10 s, the main thread's time per frame (script and
  // draw submission), draw calls and triangles of the last frame, the drawing size and tier, tasks over 50 ms since shown
  const PF = { on: false, t: new Float64Array(1024), c: new Float32Array(1024), i: 0, n: 0, calls: 0, tris: 0, lt: 0, ltMax: 0, obs: null, timer: 0, d: new Float64Array(1024) };
  function perfFrame(now, cpu) { PF.t[PF.i] = now; PF.c[PF.i] = cpu; PF.i = (PF.i + 1) & 1023; if (PF.n < 1024) PF.n++; PF.calls = renderer.info.render.calls; PF.tris = renderer.info.render.triangles; }
  const TIER_NAME = (t) => (t === 0 ? 'top' : `${t + 1} of ${TIERS.length}`);
  const perfText = () => {
    const now = performance.now(), d = PF.d; let k = 0, cpuMax = 0, f1 = 0; const cs = [];
    for (let j = 1; j < PF.n; j++) { const a = (PF.i - j - 1) & 1023, b = (PF.i - j) & 1023; if (now - PF.t[b] > 10000) break; const dt = PF.t[b] - PF.t[a]; if (now - PF.t[b] < 1000) f1++; if (dt < 1000) d[k++] = dt; cs.push(PF.c[b]); cpuMax = Math.max(cpuMax, PF.c[b]); }
    const D = Array.from(d.subarray(0, k)).sort((x, y) => x - y), q = (f) => D[Math.min(D.length - 1, Math.floor(f * D.length))];
    const slow = D.slice(Math.floor(D.length * 0.99)), low = slow.length ? 1000 / (slow.reduce((x, y) => x + y, 0) / slow.length) : 0;
    cs.sort((x, y) => x - y);
    const w = renderer.domElement.width, h = renderer.domElement.height, ua = navigator.userAgentData;
    const browser = ua && ua.brands ? ua.brands.filter((b) => !/not.?a.?brand|chromium/i.test(b.brand)).map((b) => b.brand + ' ' + b.version).join(', ') || 'Chromium' : (navigator.userAgent.match(/(Firefox|Edg|Chrome|Safari)\/[\d.]+/) || ['?'])[0];
    return [D.length > 4 ? `${f1} fps · frame ${q(0.5).toFixed(1)} ms median, ${q(0.95).toFixed(1)} p95, ${D[D.length - 1].toFixed(1)} max · 1 % low ${low.toFixed(0)} fps (last ${((now - PF.t[(PF.i - Math.min(PF.n, k + 1)) & 1023]) / 1000).toFixed(0)} s)` : 'Frames: the view is at rest (redrawn a few times a second); move or drive to measure',
      cs.length ? `Main thread per frame: ${cs[cs.length >> 1].toFixed(1)} ms median, ${cs[Math.floor(cs.length * 0.95)].toFixed(1)} p95, ${cpuMax.toFixed(1)} max (script and draw submission)` : '',
      `Tasks over 50 ms since shown: ${PF.lt}${PF.lt ? ` (longest ${PF.ltMax.toFixed(0)} ms)` : ''}${PerformanceObserver.supportedEntryTypes && PerformanceObserver.supportedEntryTypes.includes('longtask') ? '' : ' (not measured in this browser)'}`,
      `Last frame: ${PF.calls} draw calls, ${PF.tris >= 1e6 ? (PF.tris / 1e6).toFixed(2) + ' M' : (PF.tris / 1000).toFixed(0) + 'k'} triangles · ${renderer.info.programs.length} shader programs`,
      `Drawing ${w} × ${h} px · pixel ratio ${renderer.getPixelRatio().toFixed(2)} of ${PR_MAX.toFixed(2)} · tier ${SOFTWARE ? 'fixed (software)' : TIER_NAME(perf.tier)}${perf.gpuN > 3 ? ` · GPU ${perf.gpu.toFixed(1)} ms per frame` : ''} · screen ${(window.devicePixelRatio || 1).toFixed(2)}`,
      `Graphics: ${GPU}${SOFTWARE ? '  ← SOFTWARE, hardware acceleration off' : ''}${WARM.PAR ? ' · shaders compiled in the background' : ''}`,
      `View: ${mode}${mode === 'road' ? ' km ' + (roadS / 1000).toFixed(1) : ''} · ${browser} · ${navigator.hardwareConcurrency || '?'} cores${navigator.deviceMemory ? ' · ' + navigator.deviceMemory + ' GB' : ''}`].filter(Boolean).join('\n');
  };
  const showPerf = (on) => {
    PF.on = on; $('#perf').hidden = !on; stackNotes();   // (below the notes when they show)
    clearInterval(PF.timer); if (PF.obs) { PF.obs.disconnect(); PF.obs = null; }
    if (!on) return;
    PF.n = 0; PF.lt = 0; PF.ltMax = 0;
    try { PF.obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) { PF.lt++; PF.ltMax = Math.max(PF.ltMax, e.duration); } }); PF.obs.observe({ type: 'longtask' }); } catch { PF.obs = null; }
    PF.timer = setInterval(() => setTxt($('#perf-out'), perfText()), 500);
  };
  window.addEventListener('keydown', (e) => { if ((e.key === 'p' || e.key === 'P') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.target.closest('input,textarea')) showPerf($('#perf').hidden); });
  $('#perf-close').onclick = () => showPerf(false);
  $('#perf-copy').onclick = () => { const t = perfText(); try { navigator.clipboard.writeText(t).then(() => { $('#perf-copy').textContent = 'Copied'; setTimeout(() => { $('#perf-copy').textContent = 'Copy'; }, 1200); }, () => {}); } catch { /* select by hand */ } };
  if (/(^|[#&?])perf\b/.test(location.hash + location.search)) showPerf(true);
  let prev = performance.now(), simT = 0;
  const chaseState = { az: 0 };
  // the chase view while driving: behind the convoy and a little to its left, turning with the road (smoothed); the
  // user's own orbit and zoom are kept as an offset
  const wrap180 = (a) => ((a % 360) + 540) % 360 - 180;
  const follow = { hd: null, off: 24, last: null };
  function chaseStart(ctl) { chaseActive = true; follow.hd = null; follow.last = null; follow.off = 24; follow.deep = false; ctl.goal.el = 23; ctl.goal.dist = 100; ctl.flight = null; }
  function chaseCam(ctl, p, gz, dt) {
    const hb = Math.atan2(p[0] - p[2], p[1] - p[3]) * 180 / Math.PI;
    if (follow.hd == null) follow.hd = hb;
    follow.hd += wrap180(hb - follow.hd) * Math.min(1, dt * 1.1);
    if (follow.last != null) follow.off += wrap180(ctl.goal.az - follow.last);
    ctl.goal.az = follow.hd + follow.off; follow.last = ctl.goal.az;
    ctl.goal.target.set(p[4], gz, -p[5]);                    // the jeep dolly: the whole convoy in view, the road ahead too
  }
  // ---------------------------------------------------------------- street level and photo match
  const PM = makePhotoMatch(renderer);
  let pmOn = false, pmBase = 0, pmPathCache = null;
  function pmAdapter() {
    if (mode === 'road' && ROAD) return {
      scene: ROAD.scene, convoy: ROAD.convoy.group, ground: ROAD.ground,
      pointAt: (m) => { const q = ROAD.at(m); return q ? { x: q.x, y: q.y, nx: q.nx, ny: q.ny } : null; },
      convoyAt: () => { const p = ROAD.poseAt(roadS); return p ? { m: roadS, x: p[4], y: p[5] } : null; },
      oppAt: (m) => { const q = ROAD.at(m); if (!q) return 1.8; const W = q.L + q.R, c = (q.L - q.R) / 2; return W >= 5.6 ? c + W / 4 : c; },   // the oncoming lane's centre
      latLon: (x, y) => llOf(x, y, 'road'), convergence: (la, lo) => convergence(la, lo, 15),
      fromLatLon: (la, lo) => { const O = ROAD.origin, [E, N] = utm33fwd(la, lo), r = ROAD.toRoute(E - O.x, N - O.y); return r ? { m: r.s, d: r.d } : null; },
    };
    if (mode === 'hot' && HOT) {
      const P = HOT.H.path, n = P.length / 2;
      if (!pmPathCache || pmPathCache.P !== P) { const c = new Float64Array(n); for (let k = 1; k < n; k++) c[k] = c[k - 1] + Math.hypot(P[2 * k] - P[2 * k - 2], P[2 * k + 1] - P[2 * k - 1]); pmPathCache = { P, c }; }
      const C = pmPathCache.c, L = C[n - 1];
      const pointAt = (m) => { m = Math.max(0, Math.min(L, m)); let lo = 0, hi = n - 1; while (hi - lo > 1) { const md = (lo + hi) >> 1; if (C[md] < m) lo = md; else hi = md; }
        const t = (m - C[lo]) / ((C[hi] - C[lo]) || 1), x = P[2 * lo] + (P[2 * hi] - P[2 * lo]) * t, y = P[2 * lo + 1] + (P[2 * hi + 1] - P[2 * lo + 1]) * t;
        const tx = P[2 * hi] - P[2 * lo], ty = P[2 * hi + 1] - P[2 * lo + 1], l = Math.hypot(tx, ty) || 1; return { x, y, nx: -ty / l, ny: tx / l }; };
      return {
        scene: HOT.scene, convoy: HOT.convoy.group, ground: HOT.ground, pointAt,
        convoyAt: () => { const p = HOT.poseAt(hotU); let bk = 0, bd = Infinity; for (let k = 0; k < n; k++) { const d = (P[2 * k] - p[0]) ** 2 + (P[2 * k + 1] - p[1]) ** 2; if (d < bd) { bd = d; bk = k; } } return { m: C[bk], x: p[4], y: p[5] }; },
        oppAt: () => 3.2,                                                    // the path is the convoy's line, right of the centre
        latLon: (x, y) => llOf(x, y, 'hot'), convergence: (la, lo) => convergence(la, lo, hotMeta.lon),
        fromLatLon: (la, lo) => { const [x, y] = tmForward(la, lo, { lon0: hotMeta.lon, lat0: hotMeta.lat }); let bk = 0, bd = Infinity; for (let k = 0; k < n; k++) { const d = (P[2 * k] - x) ** 2 + (P[2 * k + 1] - y) ** 2; if (d < bd) { bd = d; bk = k; } }
          const q = pointAt(C[bk]); return { m: C[bk], d: (x - q.x) * q.nx + (y - q.y) * q.ny }; },
      };
    }
    return null;
  }
  const PM_SL = [['heading', 'Heading', -180, 180, 0.5, '°'], ['pitch', 'Pitch', -25, 25, 0.1, '°'], ['fov', 'Field of view', 15, 100, 0.5, '°'], ['h', 'Camera height', 0.4, 8, 0.05, 'm'], ['d', 'Across the road', -20, 20, 0.05, 'm'], ['m', 'Along the road', -150, 150, 0.5, 'm']];
  function pmSliders() {
    const box = $('#pm-sl'); box.innerHTML = '';
    for (const [k, label, a, b, st, u] of PM_SL) {
      const val = k === 'm' ? PM.cam.m - pmBase : PM.cam[k];
      const l = document.createElement('label'); l.textContent = label; l.htmlFor = 'pm-' + k;
      const r = document.createElement('input'); r.type = 'range'; r.id = 'pm-' + k; r.min = a; r.max = b; r.step = st; r.value = val;
      const o = document.createElement('output'); o.textContent = (+val).toFixed(st < 0.1 ? 2 : 1) + ' ' + u;
      r.addEventListener('input', () => { const v = +r.value; if (k === 'm') PM.cam.m = pmBase + v; else PM.cam[k] = v; o.textContent = v.toFixed(st < 0.1 ? 2 : 1) + ' ' + u; pmLink(); });
      box.append(l, r, o);
    }
  }
  function pmLink() { const A = pmAdapter(); if (!A) return; const u = PM.googleLink(A); if (u) $('#pm-gsv').href = u; }
  function pmOpen(on) {
    pmOn = on; tagGen++; $('#t-photo').checked = on; $('#pm').hidden = !on; document.body.classList.toggle('pm-on', on);
    const A = pmAdapter();
    if (on && A) { if (!PM.S.tex) PM.streetHere(A); pmBase = PM.cam.m; pmSliders(); pmLink(); roadPlay = false; hotPlay = false; $('#play').textContent = 'Drive'; }
    if (!on && A) PM.off(A);
    // the painted swept path and labels belong to the survey views, not to a street-level picture
    const sw = $('#t-swept') ? $('#t-swept').checked : true;
    if (mode === 'road' && ROAD && ROAD.setOverlay) ROAD.setOverlay(on ? false : sw);
    if (mode === 'hot' && HOT && HOT.setOverlay) HOT.setOverlay(on ? false : sw);
  }
  async function pmLoad(file) {
    if (!file || !/^image\//.test(file.type)) return;
    const buf = await file.arrayBuffer(), g = exifGps(buf), url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      PM.setPhoto(img, file.name); $('#pm-clear').hidden = false;
      const A = pmAdapter(); let msg = 'No GPS position in the photo: the camera stays where it was; line the photo up with the sliders (heading and field of view first).';
      if (g && A && PM.fromExif(A, g)) { pmBase = PM.cam.m; msg = `Placed from the photo's GPS${Number.isFinite(g.dir) ? ' and compass' : ''} (a few metres off is normal): line it up with the sliders.`; }
      else if (g) msg = 'The photo was taken more than 300 m from the route here: open the road view where it was taken, or line it up by hand.';
      $('#pm-msg').textContent = msg; pmSliders(); pmLink(); URL.revokeObjectURL(url);
    };
    img.src = url;
  }
  $('#t-photo').addEventListener('change', (e) => pmOpen(e.target.checked));
  // modelled road surfaces and markings over the photo (off: the photo's own road surface)
  $('#t-roads3d').addEventListener('change', (e) => { if (ROAD) ROAD.setRoads3D(e.target.checked); if (HOT && HOT.setRoads3D) HOT.setRoads3D(e.target.checked); });
  $('#pm-close').onclick = () => pmOpen(false);
  $('#pm-here').onclick = () => { const A = pmAdapter(); if (!A) return; PM.streetHere(A); pmBase = PM.cam.m; pmSliders(); pmLink(); };
  $('#pm-clear').onclick = () => { PM.clearPhoto(pmAdapter()); $('#pm-clear').hidden = true; $('#pm-msg').textContent = ''; };
  $('#pm-file').addEventListener('change', (e) => pmLoad(e.target.files[0]));
  window.addEventListener('dragover', (e) => { if (pmOn) e.preventDefault(); });
  window.addEventListener('drop', (e) => { if (!pmOn) return; e.preventDefault(); pmLoad(e.dataTransfer.files[0]); });
  window.addEventListener('paste', (e) => { if (!pmOn) return; const f = [...(e.clipboardData?.files || [])][0]; if (f) { e.preventDefault(); pmLoad(f); } });
  // the BF3 escort behind the blade tip, on the convoy's line (lateral offset of the line at that point)
  const rearGap = () => derived(VEH).length + 24;
  // the escort's and the rear car's samples, filled every frame (no new objects in the frame)
  const AT = [{}, {}, {}, {}], latOf = (e) => (e.dv != null ? e.dv : e.sh || 0);
  function placeRoadTags(list) {
    for (let i = 0; i < list.length; i++) { const e = list[i]; if (pmOn) { show(e, false); continue; }
      const x = +e.dataset.x, y = +e.dataset.y, pp = project(hcam, x, +e.dataset.z || ROAD.ground(x, y) + 7, -y);
      if (pp && Math.hypot(x - hcam.position.x, -y - hcam.position.z) < (+e.dataset.far || 1500)) { show(e, true); setT(e, `translate(${Math.round(pp[0])}px,${Math.round(pp[1])}px) translate(-50%,-100%)`); } else show(e, false); }
  }
  const inGroup = (o, g) => { for (let q = o; q; q = q.parent) if (q === g) return true; return false; };
  function roadUI() {
    const R0 = ROAD, step = [() => roadCard(), () => ROAD.updateFar(roadS),
      () => { if (ROAD.gates.length + ROAD.bridgeInfo.filter((b) => b.rb).length + lanesHere() + passFlags().filter((f) => ROAD.at(f.s)).length + extraFlags().length !== roadTagEls.length) roadTags(); if (ROAD.live !== lastLive) { lastLive = ROAD.live; objectTags(); } }];
    let i = 0; const next = () => { if (ROAD !== R0 || !ROAD || mode !== 'road') { roadUI.on = false; return; } try { step[i](); } catch (e) { console.error(e); } if (++i < step.length) setTimeout(next, 0); else roadUI.on = false; };
    next();
  }
  roadUI.on = false;
  // one frame; a fault in it is reported and the next frame still comes
  function frame(now) { WARM.frameStart(now); gpuTimer(true); const t0 = PF.on ? performance.now() : 0;
    try { frameBody(now); } catch (e) { console.error(e); }
    const drew = perf.lastDraw === now; gpuTimer(false, drew); WARM.frameEnd(drew);
    if (PF.on && drew) perfFrame(now, performance.now() - t0);
    requestAnimationFrame(frame); }
  function frameBody(now) {
    const dtMs = now - prev, dt = Math.min(0.1, dtMs / 1000); prev = now; simT += dt;
    U.uTime.value = simT;
    if (pmOn && mode === 'map') pmOpen(false);
    if (mode === 'map') {
      if (playing) {
        // faster on the motorways, slower near the survey points
        const near = hots.some((h) => km > h.km[0] - 4 && km < h.km[1] + 2);
        km = Math.min(header.km, km + dt * (near ? 2.2 : 24) * spdMul());
        if (km >= header.km) { playing = false; $('#play').textContent = 'Drive the route'; }
        const mv = km.toFixed(2); if (kmIn.value !== mv) kmIn.value = mv; updateKmOut();
      }
      const c = M.kmAt(km);
      M.marker.visible = km > 0 || playing; M.marker.position.set(c.x, c.h + 1500, -c.y);
      if (chase && !mctl.flight) {
        chaseState.az += (((c.az - chaseState.az) % 360 + 540) % 360 - 180) * Math.min(1, dt * 1.5);
        mctl.goal.target.set(c.x, c.h, -c.y); mctl.goal.dist = 95000; mctl.goal.el = 38; mctl.goal.az = chaseState.az;
      } else chaseState.az = mctl.az;
      mctl.update(dt); mcam.updateMatrixWorld();
      convoyTag.style.display = M.marker.visible ? 'block' : 'none';
      if (M.marker.visible) { const p = project(mcam, c.x, c.h + 1500, -c.y); if (p) { setT(convoyTag, `translate(${Math.round(p[0])}px,${Math.round(p[1])}px) translate(-50%,-140%)`); setTxt(convoyTag, `km ${fmtKm(km)} · ${legAt(km).roads.split('·')[0].trim()}`); } }
      placeMapTags();
      { const busy = playing || camMoved(mcam) || pmOn;
        if (busy) perf.idle = 0; else perf.idle += dtMs;
        adapt(now, dtMs, busy);
        if (mapOK && !WARM.hold && (perf.idle < 600 || now - perf.lastDraw > 250)) { perf.lastDraw = now; shadowsIfMoved(); renderer.render(M.scene, mcam); } }
    } else if (mode === 'road' && ROAD) {
      if (roadPlay) {
        const next = roadS + dt * SPEEDS[spdI] / 3.6;          // the chosen speed, 40 km/h to start
        if (ROAD.available(next + 2600)) ROAD.ensure(next + 2600);
        if (ROAD.at(next + 5)) roadS = next; else if (!ROAD.available(next)) { roadPlay = false; $('#play').textContent = 'Drive'; }
        const kv = (roadS / 1000).toFixed(2); if (kmIn.value !== kv) kmIn.value = kv; updateKmOut();
      }
      const p = ROAD.poseAt(roadS);
      if (p) {
        ROAD.convoy.group.visible = true;
        ROAD.convoy.set(p, ROAD.ground, 0, simT);
        { const e1 = ROAD.at(roadS + 45, AT[0]), e2 = ROAD.at(roadS + 50, AT[1]); if (e1 && e2) ROAD.convoy.placeEscort(e1.x + e1.nx * latOf(e1), e1.y + e1.ny * latOf(e1), e2.x + e2.nx * latOf(e2), e2.y + e2.ny * latOf(e2), ROAD.ground);
          const g = rearGap(), r1 = ROAD.at(roadS - g, AT[2]), r2 = ROAD.at(roadS - g + 5, AT[3]); if (r1 && r2) ROAD.convoy.placeRear(r1.x + r1.nx * latOf(r1), r1.y + r1.ny * latOf(r1), r2.x + r2.nx * latOf(r2), r2.y + r2.ny * latOf(r2), ROAD.ground); }
        const cx = (p[0] + p[10]) / 2, cy = (p[1] + p[11]) / 2;
        const sd = U.uSunDir.value;
        sun.target.position.set(cx, ROAD.ground(cx, cy), -cy); sun.position.copy(sun.target.position).addScaledVector(sd, 800);
        const sc = sun.shadow.camera; const r = 120; if (sc.right !== r) { sc.left = -r; sc.right = r; sc.top = r; sc.bottom = -r; sc.near = 10; sc.far = 2000; sc.updateProjectionMatrix(); }
        sun.target.updateMatrixWorld();
        // in a bored tunnel under deep cover the chase view would sit in the hill: it moves into the tube ahead of the convoy,
        // looking back at it, low under the ceiling (and back behind it at the exit)
        if (chaseActive) { const tn = ROAD.tunnelAt ? ROAD.tunnelAt(roadS) : null, deep = !!(tn && tn.deep);
          if (deep !== !!follow.deep) { follow.deep = deep; follow.off = deep ? 180 : 24; follow.last = null; rctl.goal.el = deep ? 6 : 23; rctl.goal.dist = deep ? 22 : 100; } }
        if ($('#t-follow').checked && roadPlay && !rctl.flight) { if (chaseActive) chaseCam(rctl, p, ROAD.ground(p[4], p[5]), dt); else rctl.goal.target.set(p[0], ROAD.ground(p[0], p[1]), -p[1]); } else follow.last = null;
      } else if (!ROAD.livePending) ROAD.convoy.group.visible = false;
      // the card, the far landscape and the labels follow the convoy: each in a task of its own after the frame, not in it
      if (now - lastCard > (roadPlay ? 1000 : 400) && !roadUI.on) { lastCard = now; roadUI.on = true; setTimeout(roadUI, 0); }
      sky.position.copy(hcam.position);
      rctl.update(dt); hcam.updateMatrixWorld();
      const moved = viewChanged(hcam);
      if (p && (moved || roadPlay)) { const q = !pmOn && project(hcam, p[0], ROAD.ground(p[0], p[1]) + 6, -p[1]); convoyTag.style.display = q ? 'block' : 'none';
        if (q) { setT(convoyTag, `translate(${Math.round(q[0])}px,${Math.round(q[1])}px) translate(-50%,-140%)`); setTxt(convoyTag, `convoy · km ${(roadS / 1000).toFixed(2)}`); } }
      else if (!p) convoyTag.style.display = 'none';
      if (moved) { placeRoadTags(roadTagEls); placeRoadTags(objTagEls); }
      { const busy = roadPlay || camMoved(hcam) || pmOn;
        if (busy) perf.idle = 0; else perf.idle += dtMs;
        adapt(now, dtMs, busy);
        if (!WARM.hold && (perf.idle < 600 || now - perf.lastDraw > 250)) { perf.lastDraw = now; shadowsIfMoved(); if (!(pmOn && PM.render(pmAdapter()))) renderer.render(ROAD.scene, hcam); }
      }
    } else if (HOT && mode === 'hot' && hctl) {
      if (hotPlay) { hotU += (dt * 7 * spdMul()) / HOT.pathLength; if (hotU >= 1) { hotU = 1; hotPlay = false; $('#play').textContent = 'Drive'; } const hv = hotU.toFixed(4); if (kmIn.value !== hv) kmIn.value = hv; updateKmOut(); }
      const p = HOT.poseAt(hotU), gu = HOT.groundFor ? HOT.groundFor(hotU) : HOT.ground;       // decks only on the convoy's own pass
      HOT.convoy.set(p, gu, U.uNight.value > 0.3 ? 1 : 0, simT);
      // (poseAt returns one shared row: each escort takes its heading from its own pose's axles, front minus rear)
      { const ue = Math.min(1, hotU + 45 / HOT.pathLength), q = HOT.poseAt(ue); HOT.convoy.placeEscort(q[0], q[1], 2 * q[0] - q[2], 2 * q[1] - q[3], HOT.groundFor ? HOT.groundFor(ue) : HOT.ground);
        const ur = hotU - rearGap() / HOT.pathLength; if (ur > 0) { const a = HOT.poseAt(ur); HOT.convoy.placeRear(a[0], a[1], 2 * a[0] - a[2], 2 * a[1] - a[3], HOT.groundFor ? HOT.groundFor(ur) : HOT.ground); } }
      if (chaseActive && $('#t-follow').checked && hotPlay && !hctl.flight) chaseCam(hctl, p, gu(p[4], p[5]), dt); else if (!hotPlay) follow.last = null;
      // shadow camera around the convoy
      const cx = p[6], cy = p[7];
      const sd = U.uSunDir.value;
      sun.target.position.set(cx, HOT.ground(cx, cy), -cy); sun.position.copy(sun.target.position).addScaledVector(sd, 800);
      const sc = sun.shadow.camera; const r = 140; if (sc.right !== r) { sc.left = -r; sc.right = r; sc.top = r; sc.bottom = -r; sc.near = 10; sc.far = 2000; sc.updateProjectionMatrix(); }
      sun.target.updateMatrixWorld();
      sky.position.copy(hcam.position);
      hctl.update(dt); hcam.updateMatrixWorld();
      HOT.FOCUS.value.set(p[6], gu(p[6], p[7]) + 3, -p[7]);
      { const mk = HOT.markers.children; for (let i = 0; i < mk.length; i++) { const s = 1 + 0.18 * Math.sin(simT * 3 + i); mk[i].scale.set(s, 1, s); } }
      const moved = viewChanged(hcam);
      if (moved) placeHotTags();
      if (moved || hotPlay) { const q = !pmOn && project(hcam, p[0], gu(p[0], p[1]) + 6, -p[1]); convoyTag.style.display = q ? 'block' : 'none';
        if (q) { setT(convoyTag, `translate(${Math.round(q[0])}px,${Math.round(q[1])}px) translate(-50%,-140%)`); setTxt(convoyTag, `convoy · ${header.vehicle} m`); } }
      { const busy = hotPlay || camMoved(hcam) || pmOn;
        if (busy) perf.idle = 0; else perf.idle += dtMs;
        adapt(now, dtMs, busy);
        if (!WARM.hold && (perf.idle < 600 || now - perf.lastDraw > 250)) { perf.lastDraw = now; shadowsIfMoved(); if (!(pmOn && PM.render(pmAdapter()))) renderer.render(HOT.scene, hcam); } }
    }
  }
  // the detail data found (next to the page, from the website or not at all): the road view's entry points, the note, the
  // overview card and the version line follow
  packsFound.then(() => {
    updateExplore(); showPackNote(); renderSources();
    try { if (mode === 'map' && card.querySelector('.label')?.textContent.startsWith('Route survey')) routeCard(); } catch { /* not started yet */ }
  });
  setLoad(1, 'Ready');
  requestAnimationFrame(frame);
  // made ahead once the map is up, one piece per idle moment of the GPU: the convoys of the road and passage views
  setTimeout(() => { WARM.queue(() => boardCanvas('bf4')); WARM.queue(() => { boardCanvas('bf3'); preConvoyRoad(VEH, slicer(5)).then(() => preConvoyHot(slicer(5))); }); }, 1500);
  setTimeout(() => $('#loading').classList.add('done'), 150);
  window.__route = { WARM, R, M, mcam, mctl, openHot, goRoute, openRoad, get ROAD() { return ROAD; }, setRoadS: (v) => { roadS = v; lastCard = 0; }, get HOT() { return HOT; }, hcam, get hctl() { return hctl; }, get rctl() { return rctl; }, setHotU: (u) => { hotU = u; hotPlay = false; }, renderer, setKm: (k) => { km = k; kmIn.value = k; chase = true; updateKmOut(); } };
}

main().catch((e) => { console.error(e); $('#loading').classList.add('error'); $('#load-msg').textContent = 'Could not start: ' + e.message; });
