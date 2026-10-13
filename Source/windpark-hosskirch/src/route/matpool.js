// Materials of the road view's packs are never thrown away: disposing the last material of a kind frees its compiled
// shader, and the next pack would compile it again (a freeze of up to a second while driving). An unloaded pack's
// materials wait here, without their textures, for the next pack that needs one of the same kind.
const POOL = new Map();
/** a material of this kind: one left by an unloaded pack, or make() */
export function pooled(key, make) {
  const a = POOL.get(key), m = (a && a.pop()) || make();
  m.userData.pool = key; return m;
}
/** back to the pool (true) if it came from pooled(); its textures are dropped (the caller disposes them) */
export function release(m) {
  const key = m && m.userData && m.userData.pool; if (!key) return false;
  if (m.map) m.map = null; if (m.emissiveMap) m.emissiveMap = null;
  let a = POOL.get(key); if (!a) POOL.set(key, (a = []));
  if (!a.includes(m)) a.push(m);
  return true;
}
