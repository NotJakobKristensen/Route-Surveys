// The data packs fetched and decoded in a background thread (bundled by tools/build_route.mjs and started from a blob: URL):
// the same requests and the same decoding as roadview.fetchPack / hotview.loadHD do on the main thread (which they still
// do where no worker can be started), the photos decoded and cut into their strips and tiles here. The main thread only
// receives the result: the pack's header, its decoded bytes (the arrays are views on them, made there as before) and the
// pictures, all transferred, nothing copied.
import { inflate, b64bytes } from '../data.js';

// a picture as its pixels (RGBA, the rows as cut and flipped): uploaded to the GPU from an array the main thread copies
// into the command stream without waiting, where uploading a picture object made the main thread wait for the GPU
function pix(b) {
  const c = new OffscreenCanvas(b.width, b.height), g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(b, 0, 0); const d = g.getImageData(0, 0, b.width, b.height); b.close && b.close();
  return { data: new Uint8Array(d.data.buffer), width: d.width, height: d.height };
}
const bitmap = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(url + ' ' + r.status); return createImageBitmap(await r.blob()); };

// a road pack (r/NNN.json and its pictures): as roadview.fetchPack
async function road({ json, webp, webpW }) {
  const r = await fetch(json);
  if (!r.ok) throw new Error('pack ' + json + ' ' + r.status);
  const hdr = await r.json();
  const blob = await inflate(b64bytes(hdr.blob)); delete hdr.blob;
  const one = (hdr.wide || []).some((c) => c.x != null);
  const [at, aw] = await Promise.all([bitmap(webp), !one && (hdr.wide || []).length ? bitmap(webpW) : null]);
  await Promise.all(hdr.chunks.map(async (c) => { c.bmp = pix(await createImageBitmap(at, 0, c.y, c.w, c.h, { imageOrientation: 'flipY' })); }));
  const src = one ? at : aw;
  if (src) await Promise.all(hdr.wide.map(async (c) => { c.bmp = pix(await createImageBitmap(src, c.x || 0, c.y, c.w, c.h, { imageOrientation: 'flipY' })); }));
  at.close && at.close(); aw && aw.close && aw.close();
  const bmps = [...hdr.chunks, ...(hdr.wide || [])].map((c) => c.bmp && c.bmp.data.buffer).filter(Boolean);
  return [{ hdr, buf: blob.buffer, off: blob.byteOffset, len: blob.byteLength }, [blob.buffer, ...bmps]];
}

// a passage (h/<id>.json, its photo atlases): as hotview.loadHD, the height grid included
async function hd({ base, id, kinds }) {
  const atlP = Object.fromEntries((kinds || ['n', 'f']).map((k) => [k, fetch(`${base}h/${id}_${k}.webp`).then((rr) => (rr.ok ? rr.blob() : null)).catch(() => null)]));
  const r = await fetch(`${base}h/${id}.json`); if (!r.ok) throw new Error('hd ' + r.status);
  const hdr = await r.json();
  const blob = await inflate(b64bytes(hdr.blob)); delete hdr.blob;
  const T = { '<f4': Float32Array, '<f8': Float64Array, '<i2': Int16Array, '|u1': Uint8Array, '<u2': Uint16Array, '<u4': Uint32Array };
  const A = {}; for (const m of hdr.arrays) A[m.n] = new T[m.t](blob.buffer, blob.byteOffset + m.o, m.l);
  const atl = {};
  await Promise.all([...new Set(hdr.tiles.map((t) => t.a))].map(async (k) => { const b = await (atlP[k] || fetch(`${base}h/${id}_${k}.webp`).then((rr) => rr.blob())); atl[k] = await createImageBitmap(b); }));
  const tiles = await Promise.all(hdr.tiles.map(async (t) => ({ ...t, bmp: pix(await createImageBitmap(atl[t.a], t.ax, t.ay, t.n, t.n, { imageOrientation: 'flipY' })) })));
  Object.values(atl).forEach((b) => b.close && b.close());
  const g = hdr.grid, z = new Float32Array(g.nx * g.ny); for (let i = 0; i < z.length; i++) z[i] = g.zb + A.dgm[i] * g.q;
  return [{ hdr, buf: blob.buffer, off: blob.byteOffset, len: blob.byteLength, tiles, z: z.buffer }, [blob.buffer, z.buffer, ...tiles.map((t) => t.bmp.data.buffer)]];
}

self.onmessage = async (e) => {
  if (e.data.ping) { self.postMessage({ pong: 1 }); return; }           // (alive: the page asks when it has heard nothing for a while)
  const { id, kind, args } = e.data;
  try { const [res, tr] = await (kind === 'r' ? road(args) : hd(args)); self.postMessage({ id, res }, tr); }
  catch (err) { self.postMessage({ id, err: String(err && err.message || err) }); }
};
