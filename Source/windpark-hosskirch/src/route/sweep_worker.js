// The swept path of the user's vehicle in a background thread (bundled by tools/build_route.mjs into the page and started
// from a blob: URL): the road view asks for the next window of the route ahead of the convoy, so driving never waits on it.
import { sweep } from './vehicle.js';

self.onmessage = (e) => {
  const { id, v, P, N, HL, HR, HO } = e.data;
  const res = sweep(v, P, N, HL, HR, 0, HO || null);      // HO: the own lane's left boundary from the path (optional)
  const bufs = Object.values(res).filter((a) => a && a.buffer instanceof ArrayBuffer).map((a) => a.buffer);
  self.postMessage({ id, res }, bufs);
};
