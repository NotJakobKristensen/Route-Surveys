// Orbit camera around a target on the ground: drag = orbit, right-drag / shift-drag / two fingers = pan,
// wheel / pinch = zoom towards the cursor, two-finger twist = rotate, keys = move. Smoothly damped; fly-to presets.
import * as THREE from 'three';

const D2R = Math.PI / 180;
const wrap = (a) => ((a % 360) + 540) % 360 - 180;

export class GroundOrbit {
  constructor(camera, dom, surface) {
    this.camera = camera; this.dom = dom; this.surface = surface;   // surface(x, y) → height incl. canopy / roofs (approx)
    this.target = new THREE.Vector3(); this.goal = { target: new THREE.Vector3(), dist: 1000, az: 0, el: 30 };
    this.dist = 1000; this.az = 0; this.el = 30;
    this.minDist = 4; this.maxDist = 16000; this.bound = 7000;
    this.flight = null; this.onChange = null; this.enabled = true;
    this.pickMax = 40000; this.hopMax = 2500;   // ray-march range for picking, extra height of long fly-tos
    this._ptrs = new Map(); this._last = null;
    this._bind();
  }
  set(t, dist, az, el, instant = true) {
    this.goal.target.copy(t); this.goal.dist = dist; this.goal.az = az; this.goal.el = el;
    if (instant) { this.target.copy(t); this.dist = dist; this.az = az; this.el = el; }
  }
  flyTo(t, dist, az, el, secs = 2.2) {
    this.flight = { t0: performance.now(), dur: secs * 1000, from: { t: this.target.clone(), dist: this.dist, az: this.az, el: this.el },
      to: { t: t.clone(), dist, az: this.az + wrap(az - this.az), el } };
  }
  // ray from screen point to ground (height function), world coords or null
  pick(clientX, clientY) {
    const r = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, this.camera);
    const o = ray.ray.origin, d = ray.ray.direction;
    let prev = 0, t = 0;
    for (let i = 0; i < 900; i++) {
      t = prev + Math.max(4, t * 0.02);
      const p = o.clone().addScaledVector(d, t);
      if (p.y <= this.surface(p.x, -p.z)) {
        let a = prev, b = t;
        for (let k = 0; k < 18; k++) { const m = (a + b) / 2, q = o.clone().addScaledVector(d, m); if (q.y <= this.surface(q.x, -q.z)) b = m; else a = m; }
        return o.clone().addScaledVector(d, b);
      }
      prev = t; if (t > this.pickMax) break;
    }
    return null;
  }
  _bind() {
    const el = this.dom;
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      el.setPointerCapture(e.pointerId);
      this._ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey || e.ctrlKey || e.metaKey });
      this.flight = null; this._moved = 0;
    });
    el.addEventListener('pointermove', (e) => {
      const p = this._ptrs.get(e.pointerId); if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      this._moved += Math.abs(dx) + Math.abs(dy);
      if (this._ptrs.size === 1) {
        if (p.button === 2 || p.button === 1 || p.shift) this._pan(dx, dy);
        else { this.goal.az -= dx * 0.28; this.goal.el = Math.min(89, Math.max(1.5, this.goal.el + dy * 0.22)); }
      } else if (this._ptrs.size === 2) {
        const [a, b] = [...this._ptrs.values()];
        const before = { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y), ang: Math.atan2(b.y - a.y, b.x - a.x) };
        p.x = e.clientX; p.y = e.clientY;
        const [a2, b2] = [...this._ptrs.values()];
        const after = { cx: (a2.x + b2.x) / 2, cy: (a2.y + b2.y) / 2, d: Math.hypot(a2.x - b2.x, a2.y - b2.y), ang: Math.atan2(b2.y - a2.y, b2.x - a2.x) };
        this._pan(after.cx - before.cx, after.cy - before.cy);
        if (before.d > 10 && after.d > 10) this._zoom(before.d / after.d, after.cx, after.cy);
        this.goal.az += (after.ang - before.ang) / D2R;
        return;
      }
      p.x = e.clientX; p.y = e.clientY;
    });
    const up = (e) => {
      const p = this._ptrs.get(e.pointerId);
      if (p && this._ptrs.size === 1 && this._moved < 6 && this.onTap) this.onTap(e.clientX, e.clientY);
      this._ptrs.delete(e.pointerId);
    };
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      e.preventDefault(); this.flight = null;
      const k = Math.exp((e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY) * 0.0011);
      this._zoom(k, e.clientX, e.clientY);
    }, { passive: false });
    window.addEventListener('keydown', (e) => {
      if (!this.enabled || e.target.closest && e.target.closest('input,select,textarea,button')) return;
      const s = this.goal.dist * 0.08, a = this.goal.az * D2R;
      const mv = (fx, fy) => { this.goal.target.x += (Math.sin(a) * fy + Math.cos(a) * fx) * s; this.goal.target.z += (-Math.cos(a) * fy + Math.sin(a) * fx) * s; };
      const k = e.key.toLowerCase();
      if (k === 'w' || k === 'arrowup') mv(0, 1); else if (k === 's' || k === 'arrowdown') mv(0, -1);
      else if (k === 'a' || k === 'arrowleft') mv(-1, 0); else if (k === 'd' || k === 'arrowright') mv(1, 0);
      else if (k === 'q') this.goal.az -= 5; else if (k === 'e') this.goal.az += 5;
      else if (k === 'r') this.goal.el = Math.min(89, this.goal.el + 3); else if (k === 'f') this.goal.el = Math.max(1.5, this.goal.el - 3);
      else if (k === '+' || k === '=') this.goal.dist = Math.max(this.minDist, this.goal.dist / 1.2); else if (k === '-') this.goal.dist = Math.min(this.maxDist, this.goal.dist * 1.2);
      else return;
      this.flight = null; e.preventDefault();
    });
  }
  _pan(dx, dy) {
    const h = this.dom.clientHeight || 1;
    const s = (2 * this.dist * Math.tan(((this.camera.userData.visibleFov || this.camera.fov) * D2R) / 2)) / h;
    const a = this.az * D2R, k = 1 / Math.max(0.35, Math.sin(Math.max(this.el, 8) * D2R));
    // grab-the-ground: dragging right moves the camera left, dragging down moves it forward
    this.goal.target.x += (-Math.cos(a) * dx + Math.sin(a) * dy * k) * s;
    this.goal.target.z += (-Math.sin(a) * dx - Math.cos(a) * dy * k) * s;
  }
  _zoom(k, cx, cy) {
    const nd = Math.min(this.maxDist, Math.max(this.minDist, this.goal.dist * k));
    const f = 1 - nd / this.goal.dist;
    const p = this.pick(cx, cy);
    if (p && f > 0) { this.goal.target.lerp(p, f); }
    this.goal.dist = nd;
  }
  update(dt) {
    if (this.flight) {
      const F = this.flight; let t = Math.min(1, (performance.now() - F.t0) / F.dur);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      this.target.lerpVectors(F.from.t, F.to.t, e);
      // arc: pull the distance out mid-flight when travelling far
      const travel = F.from.t.distanceTo(F.to.t);
      const hop = Math.sin(Math.PI * e) * Math.min(travel * 0.35, this.hopMax);
      this.dist = Math.exp(Math.log(F.from.dist) + (Math.log(F.to.dist) - Math.log(F.from.dist)) * e) + hop;
      this.az = F.from.az + (F.to.az - F.from.az) * e; this.el = F.from.el + (F.to.el - F.from.el) * e;
      this.goal.target.copy(this.target); this.goal.dist = F.to.dist; this.goal.az = F.to.az; this.goal.el = F.to.el;
      if (t >= 1) { this.flight = null; this.dist = F.to.dist; }
    } else {
      const k = 1 - Math.exp(-dt * 9);
      const B = this.bound;
      this.goal.target.x = Math.max(-B, Math.min(B, this.goal.target.x)); this.goal.target.z = Math.max(-B, Math.min(B, this.goal.target.z));
      // free views keep their target on the ground surface: the goal itself sits there, so target and goal converge
      // (pulling only the target towards the ground left it balancing against the goal, jittering with the frame time)
      if (!this.lockY) this.goal.target.y = this.surface(this.goal.target.x, -this.goal.target.z);
      this.target.lerp(this.goal.target, k);
      this.dist += (this.goal.dist - this.dist) * k;
      this.az += wrap(this.goal.az - this.az) * k; this.el += (this.goal.el - this.el) * k;
    }
    this._apply();
  }
  _apply() {
    const a = this.az * D2R, e = this.el * D2R;
    const fwd = new THREE.Vector3(Math.sin(a) * Math.cos(e), -Math.sin(e), -Math.cos(a) * Math.cos(e));
    const cam = this.camera;
    cam.position.copy(this.target).addScaledVector(fwd, -this.dist);
    const floor = this.surface(cam.position.x, -cam.position.z) + 1.8;
    if (cam.position.y < floor) cam.position.y = floor;
    cam.lookAt(this.target);
  }
}
