import * as THREE from 'three';
// The data worker (data_worker.js, inlined by the build): one background thread for the packs' fetching and decoding.
// inWorker(kind, args) resolves with its result, or with null where no worker can be started (the caller then decodes
// on the main thread, as before) or the worker failed on this pack.
// A worker counts as dead only when it fails (error) or stops answering altogether: with a request waiting and nothing
// heard from it for 20 s it is asked (ping); no answer of any kind within 15 s more and it is stopped (terminate: it can
// no longer answer), its requests then go to the main thread, and so does everything after. A slow worker (a big passage,
// a slow network) keeps answering pings and is waited for: its answer is always the one used, nothing is loaded twice.
let W, seq = 0, lastMsg = 0, pingAt = 0, timer = 0;
const waiting = new Map();
function dead(why) {
  console.warn('data worker:', why, '- decoding on the main thread');
  try { W && W.terminate(); } catch { /* gone */ }
  W = null; clearInterval(timer); timer = 0;
  const fs = [...waiting.values()]; waiting.clear(); for (const f of fs) f({ err: why });
}
function watch() {
  if (timer) return;
  timer = setInterval(() => {
    if (!W || !waiting.size) { clearInterval(timer); timer = 0; pingAt = 0; return; }
    const now = performance.now();
    if (pingAt && lastMsg < pingAt) { if (now - pingAt > 15000) dead('no answer'); return; }
    if (now - lastMsg > 20000) { pingAt = now; W.postMessage({ ping: 1 }); }
  }, 5000);
}
function worker() {
  if (W === undefined) {
    try {
      W = typeof __DATA_WORKER__ === 'string' ? new Worker(URL.createObjectURL(new Blob([__DATA_WORKER__], { type: 'text/javascript' }))) : null;
      if (W) {
        W.onmessage = (e) => { lastMsg = performance.now(); if (e.data.pong) return; const f = waiting.get(e.data.id); if (f) { waiting.delete(e.data.id); f(e.data); } };
        W.onerror = () => dead('failed');
      }
    } catch { W = null; }
  }
  return W;
}
export function inWorker(kind, args) {
  const w = worker(); if (!w) return Promise.resolve(null);
  const id = ++seq;
  return new Promise((res) => {
    waiting.set(id, (d) => { if (d.err) console.warn('data worker:', d.err); res(d.err ? null : d.res); });
    w.postMessage({ id, kind, args }); watch();
  });
}
// relative URLs of the packs resolved against the page (a worker started from a blob: URL has no base of its own)
export const abs = (u) => new URL(u, location.href).href;
// a photo texture from what the worker sends (its pixels: a data texture with the settings of an image texture, the same
// pixels on the GPU) or from a picture decoded on the main thread
export function photoTexture(src) {
  if (!src || !src.data || (typeof ImageBitmap !== 'undefined' && src instanceof ImageBitmap)) return new THREE.Texture(src);
  const t = new THREE.DataTexture(src.data, src.width, src.height, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.unpackAlignment = 4; t.flipY = false;
  return t;
}
