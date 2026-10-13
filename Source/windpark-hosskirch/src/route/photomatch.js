// Street level and photo match: a camera at eye level on the road (2.5 m, the height of the Street View cameras), with a
// link that opens the same spot, heading, pitch and field of view in Google Street View for comparison; and the convoy
// drawn into a street-level photo the user brings (their own, or an openly licensed one such as Mapillary or
// Panoramax: Google's terms do not allow screenshots of Street View). The photo never leaves the browser. The camera
// comes from the view (or from the photo's GPS and compass data) and is aligned with sliders; the modelled terrain,
// buildings and trees hide the convoy where they stand in front of it, and its shadow falls on the photo.
import * as THREE from 'three';

/** tiny EXIF reader: GPS position and image direction (true north) of a JPEG, or null */
export function exifGps(buf) {
  const v = new DataView(buf); if (v.getUint16(0) !== 0xffd8) return null;
  let o = 2;
  while (o + 4 < v.byteLength) {
    const m = v.getUint16(o), len = v.getUint16(o + 2);
    if (m === 0xffe1 && v.getUint32(o + 4) === 0x45786966) {
      const t = o + 10, le = v.getUint16(t) === 0x4949, u16 = (p) => v.getUint16(t + p, le), u32 = (p) => v.getUint32(t + p, le);
      const ifd = (p) => { const n = u16(p), out = {}; for (let i = 0; i < n; i++) { const e = p + 2 + i * 12; out[u16(e)] = { type: u16(e + 2), count: u32(e + 4), off: e + 8 }; } return out; };
      const rat = (e, k = 0) => { const p = u32(e.off) + k * 8; return u32(p) / (u32(p + 4) || 1); };
      const ifd0 = ifd(u32(4)); if (!ifd0[0x8825]) return null;
      const g = ifd(u32(ifd0[0x8825].off));
      const dms = (e) => (e ? rat(e, 0) + rat(e, 1) / 60 + rat(e, 2) / 3600 : NaN);
      const ref = (e) => (e ? String.fromCharCode(v.getUint8(e.off)) : '');
      let lat = dms(g[2]), lon = dms(g[4]); if (ref(g[1]) === 'S') lat = -lat; if (ref(g[3]) === 'W') lon = -lon;
      const dir = g[17] ? rat(g[17]) : NaN;
      return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon, dir } : null;
    }
    o += 2 + len;
  }
  return null;
}

export function makePhotoMatch(renderer) {
  const cam = { m: 0, d: 0, h: 2.5, heading: 0, pitch: 0, fov: 75 };
  const S = { on: false, tex: null, aspect: 16 / 9, name: '' };
  const pcam = new THREE.PerspectiveCamera(75, 16 / 9, 0.3, 30000); pcam.rotation.order = 'YXZ';
  const bgScene = new THREE.Scene(), bgCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const bgMat = new THREE.MeshBasicMaterial({ toneMapped: false, depthTest: false, depthWrite: false });
  bgScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgMat));
  const shadowMat = new THREE.ShadowMaterial({ opacity: 0.45 });
  const size = new THREE.Vector2();
  let saved = null;                 // castShadow of the scene's meshes while the photo is up (only the convoy casts)

  /** the camera pose in the view: A.pointAt(m) → {x, y, nx, ny} (route / path frame), A.ground(x, y) */
  function pose(A) {
    const p = A.pointAt(cam.m); if (!p) return null;
    const x = p.x + p.nx * cam.d, y = p.y + p.ny * cam.d, z = A.ground(x, y) + cam.h;
    pcam.position.set(x, z, -y); pcam.rotation.set(cam.pitch * Math.PI / 180, -cam.heading * Math.PI / 180, 0);
    return { x, y, z };
  }
  // eye level ahead of the convoy, in the oncoming lane where a Street View car would drive, looking back at it (beside
  // the road the camera would often stand in a front garden or a house)
  function streetHere(A) {
    const c = A.convoyAt(); if (!c) return;
    cam.m = c.m + 32; const p = A.pointAt(cam.m); if (!p) return;              // (between the convoy and its BF4 escort, 45 m ahead)
    cam.d = A.oppAt ? A.oppAt(cam.m) : 1.8; cam.h = 2.5; cam.fov = 75; cam.pitch = -2;
    const x = p.x + p.nx * cam.d, y = p.y + p.ny * cam.d;
    cam.heading = Math.atan2(c.x - x, c.y - y) * 180 / Math.PI;
  }
  // from the photo's GPS and compass: the nearest point on the route, the lateral offset and the heading
  function fromExif(A, g) {
    const r = A.fromLatLon(g.lat, g.lon); if (!r || Math.abs(r.d) > 300) return false;
    cam.m = r.m; cam.d = r.d; cam.h = 1.6;                       // a hand-held photo: eye height
    if (Number.isFinite(g.dir)) cam.heading = g.dir - A.convergence(g.lat, g.lon);
    return true;
  }
  function googleLink(A) {
    const p = pose(A); if (!p) return null;
    const ll = A.latLon(p.x, p.y); if (!ll) return null;
    const hd = ((cam.heading + A.convergence(ll[0], ll[1])) % 360 + 360) % 360;
    return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${ll[0].toFixed(6)}%2C${ll[1].toFixed(6)}&heading=${Math.round(hd)}&pitch=${Math.round(cam.pitch)}&fov=${Math.round(Math.max(10, Math.min(100, cam.fov)))}`;
  }
  function shadowsOnly(A, on) {
    if (on && !saved) { saved = []; A.scene.traverse((o) => { if ((o.isMesh || o.isInstancedMesh) && o.castShadow && !isConvoy(A, o)) { saved.push(o); o.castShadow = false; } }); }
    if (!on && saved) { saved.forEach((o) => { o.castShadow = true; }); saved = null; }
  }
  const isConvoy = (A, o) => { let p = o; while (p) { if (p === A.convoy) return true; p = p.parent; } return false; };
  /** draws the view: without a photo the 3D scene at street level; with one, the photo with the convoy on it */
  function render(A) {
    if (!pose(A)) return false;
    renderer.getSize(size);
    const W = size.x, H = size.y;
    if (!S.tex) {
      pcam.fov = cam.fov; pcam.aspect = W / H; pcam.clearViewOffset(); pcam.updateProjectionMatrix();
      renderer.render(A.scene, pcam); return true;
    }
    shadowsOnly(A, true);
    const ar = S.aspect; let w = W, h = W / ar; if (h > H) { h = H; w = H * ar; }
    const x0 = (W - w) / 2, y0 = (H - h) / 2;
    pcam.fov = cam.fov; pcam.aspect = ar; pcam.clearViewOffset(); pcam.updateProjectionMatrix();
    const ac = renderer.autoClear; renderer.autoClear = false;
    renderer.setScissorTest(false); renderer.setViewport(0, 0, W, H); renderer.setClearColor(0x15191c, 1); renderer.clear();
    renderer.setScissorTest(true); renderer.setScissor(x0, y0, w, h); renderer.setViewport(x0, y0, w, h);
    bgMat.map = S.tex; bgMat.needsUpdate = true; renderer.render(bgScene, bgCam);
    renderer.clearDepth();
    // everything as a shadow catcher: the photo shows through, the convoy's shadow darkens it, and the depth hides the
    // convoy behind modelled terrain, buildings and trees
    A.scene.overrideMaterial = shadowMat; renderer.render(A.scene, pcam); A.scene.overrideMaterial = null;
    // the convoy itself (and the measured edges as a guide, if asked)
    const hidden = [];
    for (const c of A.scene.children) { if (c.isLight || c === A.convoy || (A.guides && A.guides.includes(c)) || !c.visible) continue; if (c.type === 'Object3D' && !c.children.length) continue; c.visible = false; hidden.push(c); }
    renderer.render(A.scene, pcam);
    hidden.forEach((c) => { c.visible = true; });
    renderer.setScissorTest(false); renderer.setViewport(0, 0, W, H); renderer.autoClear = ac;
    return true;
  }
  function setPhoto(img, name) {
    if (S.tex) S.tex.dispose();
    const t = new THREE.Texture(img); t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true; t.minFilter = THREE.LinearFilter; t.generateMipmaps = false;
    S.tex = t; S.aspect = img.naturalWidth / img.naturalHeight || 16 / 9; S.name = name || '';
  }
  function clearPhoto(A) { if (S.tex) S.tex.dispose(); S.tex = null; if (A) shadowsOnly(A, false); }
  // the programs it draws with a photo (the photo behind, the scene as a shadow catcher over it) made ahead, when a view has
  // been shown (W: the warmer of warm.js): bringing a photo then compiles nothing
  const DUMMY = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); DUMMY.needsUpdate = true;
  const warmed = new WeakSet();
  function warm(W, A) {
    if (!A || warmed.has(A.scene)) return; warmed.add(A.scene);
    if (!S.tex) { bgMat.map = DUMMY; W.prepare([bgScene.children[0]], bgScene, bgCam, { geometry: false }); bgMat.map = null; }      // (compiled at once, before the first pause)
    const objs = []; A.scene.traverse((o) => { if (o.material && o.geometry && (o.isMesh || o.isLine || o.isPoints)) objs.push(o); });
    W.prepare([], A.scene, pcam, { override: [shadowMat, objs], geometry: false });
  }
  return { cam, S, pcam, pose, streetHere, fromExif, googleLink, render, setPhoto, clearPhoto, warm, off: (A) => shadowsOnly(A, false) };
}
