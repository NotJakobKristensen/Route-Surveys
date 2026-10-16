// The swept path of the user's vehicle in a background thread (bundled by tools/build_route.mjs into the page and started
// from a blob: URL): the road view asks for the next window of the route ahead of the convoy, so driving never waits on it.
// With M (the window's whole route metres, roadview.js measureOf) also the blade beyond the edge there (bladeedge.js
// edgeOf): what the drive view draws and shows.
import { sweep } from './vehicle.js';
import { edgeOf } from './bladeedge.js';

self.onmessage = (e) => {
  const { id, v, P, N, HL, HR, HO, M } = e.data;
  const res = sweep(v, P, N, HL, HR, 0, HO || null);      // HO: the own lane's left boundary from the path (optional)
  const blade = M ? edgeOf(v, M, res) : null;
  const bufs = Object.values(res).filter((a) => a && a.buffer instanceof ArrayBuffer).map((a) => a.buffer);
  if (blade) for (const a of [blade.u16, blade.P, blade.NT, blade.k, blade.d0, blade.d1, blade.out, blade.depth]) bufs.push(a.buffer);
  self.postMessage({ id, res, blade }, bufs);
};
