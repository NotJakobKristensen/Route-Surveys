// German road signs as they stand at the road: faces drawn from the sign catalogue's geometry (VzKat, VwV-StVO),
// plates at their real sizes for the speed (size classes 1–3), lower edge 2.0 m above the road, grey backs (RAL 7043)
// with the aluminium edge profile, galvanised posts (Ø 60.3 mm; town signs on two); guide posts (Leitpfosten, Z 620)
// in their real shape: 1.0 m, black band, the rectangular reflector towards the traffic that has them on its right and
// two round ones on the back.
import * as THREE from 'three';
import { pooled } from './matpool.js';

const RED = '#c1121c', BLUE = '#154889', YEL = '#f0ca00', GREEN = '#008754', BLK = '#141414', WHITE = '#ffffff', GREYT = '#666666';
const FONT = '"Roboto Condensed", "Arial Narrow", "Helvetica Neue", Arial, sans-serif';

// sign kinds: shape and size (m) by the speed on the approach (VwV-StVO zu §§ 39–43, Rn. 6–8): round 420 / 600 / 750 mm up
// to 20 / up to 80 / above 80 km/h; triangles, squares and plates size 1 / 2 / 3 below 50 / 50–100 / above 100 km/h
const ROUND = new Set(['274', '278', '282', '265', '264', '262', '263', '266', '224', '276', '277', '280', '281', '250', '251', '253', '254', '255', '259', '260', '261', '267', '269', '283', '286',
  '209', '211', '214', '215', '222', '237', '239', '240', '241', '242.1', '244.1']);
// the family of a code: its number without the variant ('103-20' → '103'), Polish codes keep their letter ('PL:A-7' → 'PL:A')
export const base = (code) => (code.startsWith('PL:') ? code.split('-')[0] : code.split('-')[0]);
const cls3 = (speed, a, b, c) => (speed > 100 ? c : speed >= 50 ? b : a);
export function signDims(code, v, speed = 100, wide = false) {
  const B = base(code);
  if (ROUND.has(B) || B === 'PL:B' || B === 'PL:C') { const D = speed <= 20 ? 0.42 : speed <= 80 ? 0.6 : 0.75; return { w: D, h: D, shape: 'round' }; }
  if (B === '206') return { w: 0.9, h: 0.9, shape: 'oct' };
  if (B === '205') { const a = speed > 100 ? 1.05 : 0.9; return { w: a, h: a * 0.866, shape: 'tri-down' }; }   // VzKat: 900 / 1050
  if ((/^1[0-5]\d$/.test(B) && !['156', '159', '162'].includes(B)) || B === 'PL:A') { const a = cls3(speed, 0.63, 0.9, 1.26); return { w: a, h: a * 0.866, shape: 'tri' }; }
  if (['156', '159', '162'].includes(B)) return { w: 0.25, h: 1.0, shape: 'rect', lower: 0.4 };                        // Baken before a level crossing
  if (B === '306' || B === '307') { const s = cls3(speed, 0.42, 0.6, 0.84); return { w: s * 1.414, h: s * 1.414, shape: 'diamond' }; }
  if (['350', '314', '357', '308', '330.1', '330.2', '331.1', '331.2', '354', '325.1', '325.2'].includes(B) || B === 'PL:D') { const s = cls3(speed, 0.42, 0.6, 0.84); return { w: s, h: s, shape: 'square' }; }
  if (B === '310' || B === '311' || B === 'PL:E-17a') {
    const H = wide || speed > 100 ? 0.84 : 0.6, chars = String(v || '').length, W = Math.max(H * 1.5, (0.09 * chars + 0.25) * (H / 0.6));
    return { w: W, h: H, shape: 'rect' };
  }
  if (/^10\d\d$/.test(B) || B === 'PL:T') { const w = cls3(speed, 0.42, 0.6, 0.75); return { w, h: w * 0.55, shape: 'rect', plate: true }; }   // Zusatzzeichen
  if (B === '386.3') return speed > 100 ? { w: 3.6, h: 2.4, shape: 'rect', lower: 1.2 } : { w: 2.4, h: 1.6, shape: 'rect', lower: 1.2 };
  if (B === '386.1' || B === '386.2' || B === '385') return { w: 1.5, h: 0.6, shape: 'rect' };
  if (B === '449' || B === '448') return { w: 4.4, h: 3.0, shape: 'rect', lower: 1.5 };
  if (B === '453') return { w: 3.4, h: 2.6, shape: 'rect', lower: 1.5 };
  if (B === '333' || B === '332') return { w: 1.6, h: 0.9, shape: 'rect' };
  if (B === '390.1' || B === '390.2' || B === '336') return { w: 0.6, h: 0.9, shape: 'rect' };
  if (B === '460' || B === '454' || B === '455.1') return { w: 0.84, h: 0.6, shape: 'rect' };
  if (B === '626') return { w: 0.25, h: 1.0, shape: 'rect', lower: 0.6 };
  if (/^5\d\d$/.test(B)) return { w: 1.6, h: 1.2, shape: 'rect', lower: 1.5 };                                     // road-works lane boards
  if (B === 'PL:E' || B === 'PL:F') return { w: 2.2, h: 1.5, shape: 'rect', lower: 1.5 };
  if (B === 'km') return { w: 0.6, h: 0.4, shape: 'rect', lower: 1.0 };
  return { w: 0.6, h: 0.6, shape: 'square' };
}

// ---------------------------------------------------------------- faces
const fmt = (x) => (Math.abs(x - Math.round(x)) < 0.05 ? String(Math.round(x)) : x.toFixed(1).replace('.', ','));
function text(g, s, cx, cy, capH, maxW, color) {
  g.save(); g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  const fs = capH / 0.72; g.font = `700 ${fs}px ${FONT}`;
  const w = g.measureText(s).width, k = maxW && w > maxW ? maxW / w : 1;
  g.translate(cx, cy + capH / 2); g.scale(k, 1); g.fillText(s, 0, 0); g.restore();
}
const circle = (g, cx, cy, r, col) => { g.fillStyle = col; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill(); };
function poly(g, pts, col) { g.fillStyle = col; g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fill(); }
// the 'end' band: 5 black and 4 white stripes at 45°, rising to the right
function endBand(g, c, D) {
  g.save(); g.beginPath(); g.arc(c, c, 0.4583 * D, 0, Math.PI * 2); g.clip();
  g.translate(c, c); g.rotate(-Math.PI / 4);
  const w = 0.0185 * D; for (let k = 0; k < 9; k++) { g.fillStyle = k % 2 ? WHITE : BLK; g.fillRect(-D, -4.5 * w + k * w, 2 * D, w); }
  g.restore();
}
/** draws the face of `code` (value v) into g at (0, 0), S×S px (rectangular signs use the full width, aspect kept) */
export function drawFace(g, code, v, S, aspect = 1) {
  const D = S, c = S / 2;
  g.clearRect(0, 0, S, S);
  switch (code) {
    case '274': case '265': case '264': case '262': {
      circle(g, c, c, 0.5 * D, WHITE); circle(g, c, c, 0.4833 * D, RED); circle(g, c, c, 0.3493 * D, WHITE);
      if (code === '274') { const t = String(v); text(g, t, c, c, 0.417 * D, t.length > 2 ? 0.555 * D : 0.515 * D, BLK); }
      else {
        const t = fmt(+v) + (code === '262' ? 't' : 'm'); text(g, t, c, c, 0.3 * D, 0.56 * D, BLK);
        const a = 0.124 * D, b = 0.093 * D;
        if (code === '265') { poly(g, [[c - a, 0.16 * D], [c + a, 0.16 * D], [c, 0.16 * D + b]], BLK); poly(g, [[c - a, 0.84 * D], [c + a, 0.84 * D], [c, 0.84 * D - b]], BLK); }
        if (code === '264') { poly(g, [[0.16 * D, c - a], [0.16 * D, c + a], [0.16 * D + b, c]], BLK); poly(g, [[0.84 * D, c - a], [0.84 * D, c + a], [0.84 * D - b, c]], BLK); }
      }
      break;
    }
    case '278': case '282': {
      circle(g, c, c, 0.5 * D, WHITE); circle(g, c, c, 0.4833 * D, BLK); circle(g, c, c, 0.4583 * D, WHITE);
      if (code === '278') { const t = String(v); text(g, t, c, c, 0.417 * D, t.length > 2 ? 0.555 * D : 0.515 * D, GREYT); }
      endBand(g, c, D);
      break;
    }
    case '224': {
      circle(g, c, c, 0.5 * D, WHITE); circle(g, c, c, 0.488 * D, YEL); circle(g, c, c, 0.473 * D, GREEN); circle(g, c, c, 0.338 * D, YEL);
      const hw = 0.1825 * D, hh = 0.257 * D, st = 0.07 * D;
      g.fillStyle = GREEN; g.fillRect(c - hw, c - hh, st, 2 * hh); g.fillRect(c + hw - st, c - hh, st, 2 * hh); g.fillRect(c - hw, c - st / 2, 2 * hw, st);
      break;
    }
    case '206': {
      const oct = (r) => { const pts = []; for (let k = 0; k < 8; k++) { const a = Math.PI / 8 + (k * Math.PI) / 4; pts.push([c + Math.cos(a) * r, c + Math.sin(a) * r]); } return pts; };
      const R = 0.5 * D / Math.cos(Math.PI / 8);
      poly(g, oct(R), WHITE); poly(g, oct(R * 0.9), RED);
      text(g, 'STOP', c, c, 0.353 * D, 0.77 * D, WHITE);
      break;
    }
    case '205': {
      const h = 0.866 * D, y0 = (S - h) / 2;
      poly(g, [[0, y0], [D, y0], [c, y0 + h]], WHITE);
      poly(g, [[0.03 * D, y0 + 0.017 * D], [0.97 * D, y0 + 0.017 * D], [c, y0 + h - 0.035 * D]], RED);
      poly(g, [[0.172 * D, y0 + 0.101 * D], [0.828 * D, y0 + 0.101 * D], [c, y0 + 0.668 * D]], WHITE);
      break;
    }
    case '350': {
      g.fillStyle = WHITE; g.fillRect(0, 0, S, S); g.fillStyle = BLUE; g.fillRect(0.02 * S, 0.02 * S, 0.96 * S, 0.96 * S);
      poly(g, [[0.084 * S, 0.843 * S], [0.919 * S, 0.843 * S], [0.5 * S, 0.12 * S]], WHITE);
      g.fillStyle = BLK; for (let k = 0; k < 5; k++) g.fillRect((0.2 + k * 0.13) * S, 0.69 * S, 0.075 * S, 0.11 * S);
      circle(g, 0.52 * S, 0.33 * S, 0.035 * S, BLK); g.fillRect(0.5 * S, 0.37 * S, 0.045 * S, 0.17 * S);
      g.save(); g.translate(0.52 * S, 0.53 * S); g.rotate(0.35); g.fillRect(-0.02 * S, 0, 0.04 * S, 0.14 * S); g.rotate(-0.7); g.fillRect(-0.02 * S, 0, 0.04 * S, 0.14 * S); g.restore();
      break;
    }
    case '310': case '311': {
      const H = S / aspect, y0 = (S - H) / 2;
      g.fillStyle = YEL; g.fillRect(0, y0, S, H);
      g.strokeStyle = BLK; g.lineWidth = 0.035 * H; g.strokeRect(0.045 * H, y0 + 0.045 * H, S - 0.09 * H, H - 0.09 * H);
      text(g, String(v || ''), c, y0 + H * 0.5, 0.3 * H, S - 0.3 * H, BLK);
      if (code === '311') { g.save(); g.strokeStyle = RED; g.lineWidth = 0.1 * H; g.beginPath(); g.moveTo(0.12 * S, y0 + 0.85 * H); g.lineTo(0.88 * S, y0 + 0.15 * H); g.stroke(); g.restore(); }
      break;
    }
    default: drawMore(g, code, v, S, aspect);
  }
}

// ---------------------------------------------------------------- the other faces: families with simplified pictograms
const BROWN = '#6e4126', ORANGE = '#e3741c', WORKS = '#f2c200', PLYEL = '#f6d000';
function stroke(g, pts, w, col, close = false) { g.strokeStyle = col; g.lineWidth = w; g.lineJoin = 'round'; g.lineCap = 'round'; g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); if (close) g.closePath(); g.stroke(); }
function arrow(g, x0, y0, x1, y1, w, col) {                     // a shaft with a head at (x1, y1)
  const a = Math.atan2(y1 - y0, x1 - x0), h = w * 2.6;
  stroke(g, [[x0, y0], [x1 - Math.cos(a) * h * 0.8, y1 - Math.sin(a) * h * 0.8]], w, col);
  poly(g, [[x1, y1], [x1 - Math.cos(a) * h - Math.sin(a) * h * 0.75, y1 - Math.sin(a) * h + Math.cos(a) * h * 0.75], [x1 - Math.cos(a) * h + Math.sin(a) * h * 0.75, y1 - Math.sin(a) * h - Math.cos(a) * h * 0.75]], col);
}
// pictograms in a unit box (0..1) scaled to (x, y, s)
const PICT = {
  car(g, x, y, s, col) { g.fillStyle = col; g.fillRect(x + 0.12 * s, y + 0.45 * s, 0.76 * s, 0.25 * s); poly(g, [[x + 0.25 * s, y + 0.45 * s], [x + 0.35 * s, y + 0.25 * s], [x + 0.68 * s, y + 0.25 * s], [x + 0.78 * s, y + 0.45 * s]], col); circle(g, x + 0.28 * s, y + 0.72 * s, 0.09 * s, col); circle(g, x + 0.72 * s, y + 0.72 * s, 0.09 * s, col); },
  truck(g, x, y, s, col) { g.fillStyle = col; g.fillRect(x + 0.08 * s, y + 0.25 * s, 0.6 * s, 0.42 * s); poly(g, [[x + 0.7 * s, y + 0.4 * s], [x + 0.84 * s, y + 0.4 * s], [x + 0.92 * s, y + 0.52 * s], [x + 0.92 * s, y + 0.67 * s], [x + 0.7 * s, y + 0.67 * s]], col); circle(g, x + 0.25 * s, y + 0.72 * s, 0.08 * s, col); circle(g, x + 0.78 * s, y + 0.72 * s, 0.08 * s, col); },
  bike(g, x, y, s, col) { const w = 0.07 * s; g.strokeStyle = col; g.lineWidth = w; g.beginPath(); g.arc(x + 0.25 * s, y + 0.65 * s, 0.17 * s, 0, 7); g.stroke(); g.beginPath(); g.arc(x + 0.75 * s, y + 0.65 * s, 0.17 * s, 0, 7); g.stroke(); stroke(g, [[x + 0.25 * s, y + 0.65 * s], [x + 0.45 * s, y + 0.38 * s], [x + 0.7 * s, y + 0.38 * s], [x + 0.75 * s, y + 0.65 * s]], w, col); stroke(g, [[x + 0.45 * s, y + 0.38 * s], [x + 0.5 * s, y + 0.65 * s], [x + 0.7 * s, y + 0.38 * s]], w, col); },
  walker(g, x, y, s, col) { circle(g, x + 0.52 * s, y + 0.14 * s, 0.08 * s, col); const w = 0.09 * s; stroke(g, [[x + 0.5 * s, y + 0.25 * s], [x + 0.47 * s, y + 0.55 * s]], w, col); stroke(g, [[x + 0.47 * s, y + 0.55 * s], [x + 0.35 * s, y + 0.9 * s]], w, col); stroke(g, [[x + 0.47 * s, y + 0.55 * s], [x + 0.62 * s, y + 0.9 * s]], w, col); stroke(g, [[x + 0.33 * s, y + 0.45 * s], [x + 0.5 * s, y + 0.3 * s], [x + 0.66 * s, y + 0.48 * s]], w * 0.8, col); },
  deer(g, x, y, s, col, flip) { g.save(); if (flip) { g.translate(2 * x + s, 0); g.scale(-1, 1); } g.fillStyle = col; g.beginPath(); g.ellipse(x + 0.48 * s, y + 0.52 * s, 0.24 * s, 0.11 * s, -0.15, 0, 7); g.fill(); poly(g, [[x + 0.66 * s, y + 0.48 * s], [x + 0.78 * s, y + 0.2 * s], [x + 0.86 * s, y + 0.22 * s], [x + 0.75 * s, y + 0.52 * s]], col); const w = 0.05 * s; for (const [a, b] of [[0.32, 0.25], [0.4, 0.33], [0.6, 0.7], [0.66, 0.78]]) stroke(g, [[x + a * s, y + 0.58 * s], [x + b * s, y + 0.86 * s]], w, col); stroke(g, [[x + 0.8 * s, y + 0.2 * s], [x + 0.74 * s, y + 0.06 * s], [x + 0.68 * s, y + 0.1 * s]], w * 0.8, col); stroke(g, [[x + 0.8 * s, y + 0.2 * s], [x + 0.9 * s, y + 0.06 * s], [x + 0.96 * s, y + 0.12 * s]], w * 0.8, col); g.restore(); },
  train(g, x, y, s, col) { g.fillStyle = col; g.fillRect(x + 0.15 * s, y + 0.35 * s, 0.55 * s, 0.32 * s); g.fillRect(x + 0.55 * s, y + 0.2 * s, 0.25 * s, 0.47 * s); g.fillRect(x + 0.22 * s, y + 0.2 * s, 0.09 * s, 0.16 * s); for (const k of [0.25, 0.45, 0.68]) circle(g, x + k * s, y + 0.74 * s, 0.08 * s, col); },
  signals(g, x, y, s) { g.fillStyle = BLK; g.fillRect(x + 0.36 * s, y + 0.08 * s, 0.28 * s, 0.84 * s); circle(g, x + 0.5 * s, y + 0.23 * s, 0.09 * s, RED); circle(g, x + 0.5 * s, y + 0.5 * s, 0.09 * s, YEL); circle(g, x + 0.5 * s, y + 0.77 * s, 0.09 * s, GREEN); },
  works(g, x, y, s, col) { circle(g, x + 0.42 * s, y + 0.18 * s, 0.07 * s, col); const w = 0.08 * s; stroke(g, [[x + 0.4 * s, y + 0.28 * s], [x + 0.5 * s, y + 0.55 * s], [x + 0.4 * s, y + 0.86 * s]], w, col); stroke(g, [[x + 0.5 * s, y + 0.55 * s], [x + 0.62 * s, y + 0.86 * s]], w, col); stroke(g, [[x + 0.42 * s, y + 0.36 * s], [x + 0.7 * s, y + 0.5 * s], [x + 0.85 * s, y + 0.82 * s]], w * 0.7, col); poly(g, [[x + 0.1 * s, y + 0.88 * s], [x + 0.28 * s, y + 0.62 * s], [x + 0.36 * s, y + 0.88 * s]], col); },
  motorway(g, x, y, s, col) { g.fillStyle = col; g.fillRect(x + 0.1 * s, y + 0.32 * s, 0.8 * s, 0.1 * s); g.fillRect(x + 0.18 * s, y + 0.42 * s, 0.1 * s, 0.4 * s); g.fillRect(x + 0.72 * s, y + 0.42 * s, 0.1 * s, 0.4 * s); poly(g, [[x + 0.36 * s, y + 0.92 * s], [x + 0.46 * s, y + 0.5 * s], [x + 0.54 * s, y + 0.5 * s], [x + 0.64 * s, y + 0.92 * s]], col); },
};
function triFrame(g, S, fill = WHITE, rim = RED) {
  const h = 0.866 * S, y0 = (S - h) / 2;
  poly(g, [[0, y0 + h], [S, y0 + h], [S / 2, y0]], WHITE);
  poly(g, [[0.03 * S, y0 + h - 0.017 * S], [0.97 * S, y0 + h - 0.017 * S], [S / 2, y0 + 0.035 * S]], rim);
  poly(g, [[0.17 * S, y0 + h - 0.1 * S], [0.83 * S, y0 + h - 0.1 * S], [S / 2, y0 + 0.28 * S]], fill);
  return { x: 0.33 * S, y: y0 + 0.43 * S, s: 0.34 * S };      // the pictogram box
}
function ringFrame(g, S, fill = WHITE) { const c = S / 2; circle(g, c, c, 0.5 * S, WHITE); circle(g, c, c, 0.4833 * S, RED); circle(g, c, c, 0.3493 * S, fill); }
function blueDisc(g, S) { const c = S / 2; circle(g, c, c, 0.5 * S, WHITE); circle(g, c, c, 0.4765 * S, BLUE); }
function board(g, S, aspect, bg, fg, lines = 3, title = '') {
  const H = S / aspect, y0 = (S - H) / 2, r = 0.04 * H;
  g.fillStyle = bg; g.fillRect(0, y0, S, H);
  g.strokeStyle = fg; g.lineWidth = 0.025 * H; g.strokeRect(r, y0 + r, S - 2 * r, H - 2 * r);
  if (title) text(g, title, S / 2, y0 + H * (lines ? 0.22 : 0.5), 0.13 * H, S * 0.86, fg);
  // the destinations are not mapped: their rows as plain bars (no invented names)
  g.fillStyle = fg; g.globalAlpha = 0.85;
  for (let k = 0; k < lines; k++) { const yy = y0 + H * ((title ? 0.42 : 0.24) + k * (title ? 0.18 : 0.22)); g.fillRect(S * 0.12, yy, S * (0.5 + 0.2 * ((k * 37) % 3) / 2), 0.07 * H); }
  g.globalAlpha = 1;
}
function wrapText(g, s, cx, cy, capH, maxW, col, maxLines = 2) {
  g.save(); g.font = `700 ${capH / 0.72}px ${FONT}`; const words = String(s).split(/\s+/), lines = []; let cur = '';
  for (const w of words) { const tt = cur ? cur + ' ' + w : w; if (g.measureText(tt).width > maxW && cur) { lines.push(cur); cur = w; } else cur = tt; }
  if (cur) lines.push(cur); g.restore();
  const L = lines.slice(0, maxLines), lh = capH * 1.45;
  L.forEach((ln, i) => text(g, ln, cx, cy + (i - (L.length - 1) / 2) * lh, capH, maxW, col));
}
const PLATE_TEXT = { '1020-30': 'Anlieger frei', '1022-10': 'frei', '1022-11': 'frei', '1026-36': 'Land- u. forstw. Verkehr frei', '1026-38': 'Landwirtschaftl. Verkehr frei', '1026-39': 'Forstwirtschaftl. Verkehr frei',
  '1053-33': 'bei Nässe', '1053-35': 'bei Nässe', '1052-36': 'Ölspur', '1049-13': 'außer Kom.' , '1040-35': 'Std.', '1006-31': 'Baustellenausfahrt', '1024-17': 'frei' };
function drawMore(g, code, v, S, aspect) {
  const B = base(code), c = S / 2, sub = code.slice(B.length + 1);
  // round prohibitions (red ring) and their ends (grey, banded)
  if (['250', '251', '253', '254', '255', '259', '260', '261', '263', '266', '269'].includes(B) || B === 'PL:B') {
    ringFrame(g, S); const p = { x: c - 0.22 * S, y: c - 0.22 * S, s: 0.44 * S };
    if (B === '251' || B === '260') PICT.car(g, p.x, p.y, p.s, BLK); else if (B === '253') PICT.truck(g, p.x, p.y, p.s, BLK); else if (B === '254') PICT.bike(g, p.x, p.y, p.s, BLK); else if (B === '259') PICT.walker(g, p.x, p.y, p.s, BLK);
    else if (B === '263' || B === '266') text(g, (v ? fmt(+String(v).replace(',', '.')) : '') + (B === '263' ? 't' : 'm'), c, c, 0.26 * S, 0.56 * S, BLK);
    else if (B === 'PL:B') text(g, v ? String(v) : '', c, c, 0.3 * S, 0.56 * S, BLK);
    return;
  }
  if (B === '267') { circle(g, c, c, 0.5 * S, WHITE); circle(g, c, c, 0.4833 * S, RED); g.fillStyle = WHITE; g.fillRect(0.2 * S, c - 0.085 * S, 0.6 * S, 0.17 * S); return; }
  if (B === '276' || B === '277' || B === '280' || B === '281') {
    const end = B === '280' || B === '281';
    if (end) { circle(g, c, c, 0.5 * S, WHITE); circle(g, c, c, 0.4833 * S, BLK); circle(g, c, c, 0.4583 * S, WHITE); } else ringFrame(g, S);
    const s2 = 0.26 * S; (B === '277' || B === '281' ? PICT.truck : PICT.car)(g, c - 0.29 * S, c - 0.14 * S, s2, end ? GREYT : RED); PICT.car(g, c + 0.03 * S, c - 0.14 * S, s2, end ? GREYT : BLK);
    if (end) endBand(g, c, S); return;
  }
  if (B === '283' || B === '286') { circle(g, c, c, 0.5 * S, WHITE); circle(g, c, c, 0.4833 * S, RED); circle(g, c, c, 0.3593 * S, BLUE); g.save(); g.beginPath(); g.arc(c, c, 0.36 * S, 0, 7); g.clip(); stroke(g, [[0.15 * S, 0.15 * S], [0.85 * S, 0.85 * S]], 0.13 * S, RED); if (B === '283') stroke(g, [[0.85 * S, 0.15 * S], [0.15 * S, 0.85 * S]], 0.13 * S, RED); g.restore(); return; }
  // round mandatory (blue)
  if (['209', '211', '214', '215', '222', '237', '239', '240', '241', '242.1', '244.1'].includes(B) || B === 'PL:C') {
    blueDisc(g, S); const w = 0.09 * S;
    if (B === '209' || B === 'PL:C') { const l = sub === '10' ? -1 : 1; arrow(g, c - l * 0.12 * S, 0.78 * S, c + l * 0.22 * S, 0.36 * S, w, WHITE); }
    else if (B === '211') { stroke(g, [[c - 0.12 * S, 0.8 * S], [c - 0.12 * S, 0.45 * S]], w, WHITE); arrow(g, c - 0.12 * S, 0.45 * S, c + 0.25 * S, 0.45 * S, w, WHITE); }
    else if (B === '214') { arrow(g, c, 0.82 * S, c, 0.2 * S, w, WHITE); arrow(g, c, 0.55 * S, c + 0.27 * S, 0.4 * S, w * 0.8, WHITE); }
    else if (B === '215') { for (let k = 0; k < 3; k++) { const a0 = k * 2.094 + 0.3, a1 = a0 + 1.5; g.strokeStyle = WHITE; g.lineWidth = w; g.beginPath(); g.arc(c, c, 0.24 * S, a0, a1); g.stroke(); arrow(g, c + Math.cos(a1 - 0.2) * 0.24 * S, c + Math.sin(a1 - 0.2) * 0.24 * S, c + Math.cos(a1 + 0.05) * 0.24 * S, c + Math.sin(a1 + 0.05) * 0.24 * S, w, WHITE); } }
    else if (B === '222') arrow(g, 0.3 * S, 0.3 * S, 0.7 * S, 0.7 * S, w, WHITE);
    else if (B === '237') PICT.bike(g, 0.2 * S, 0.22 * S, 0.6 * S, WHITE);
    else if (B === '239') PICT.walker(g, 0.27 * S, 0.17 * S, 0.5 * S, WHITE);
    else { PICT.walker(g, 0.36 * S, 0.1 * S, 0.3 * S, WHITE); g.fillStyle = WHITE; g.fillRect(0.14 * S, 0.5 * S, 0.72 * S, 0.025 * S); PICT.bike(g, 0.3 * S, 0.53 * S, 0.4 * S, WHITE); }
    return;
  }
  // warning triangles (German white field, Polish yellow) with their pictograms
  if (/^1[0-5]\d$/.test(B) || B === 'PL:A') {
    const pl = B === 'PL:A', p = triFrame(g, S, pl ? PLYEL : WHITE, RED), w = 0.06 * S, X = (u) => p.x + u * p.s, Y = (u) => p.y + u * p.s;
    const left = sub === '10' || /^PL:A-1|^PL:A-3/.test(code);
    if (B === '103' || code === 'PL:A-1' || code === 'PL:A-2') { const l = left ? -1 : 1; g.strokeStyle = BLK; g.lineWidth = w; g.beginPath(); g.moveTo(X(0.5 - l * 0.1), Y(1)); g.quadraticCurveTo(X(0.5 - l * 0.12), Y(0.35), X(0.5 + l * 0.32), Y(0.25)); g.stroke(); arrow(g, X(0.5 + l * 0.2), Y(0.27), X(0.5 + l * 0.42), Y(0.2), w, BLK); }
    else if (B === '105' || code === 'PL:A-3' || code === 'PL:A-4') { const l = left ? -1 : 1; g.strokeStyle = BLK; g.lineWidth = w; g.beginPath(); g.moveTo(X(0.5), Y(1)); g.bezierCurveTo(X(0.5 - l * 0.4), Y(0.7), X(0.5 + l * 0.4), Y(0.45), X(0.5 + l * 0.05), Y(0.12)); g.stroke(); arrow(g, X(0.5 + l * 0.12), Y(0.3), X(0.5 + l * 0.02), Y(0.02), w, BLK); }
    else if (B === '142' || code.startsWith('PL:A-18')) PICT.deer(g, p.x - 0.03 * S, p.y, p.s * 1.05, BLK, sub === '20');
    else if (B === '131' || code === 'PL:A-29') PICT.signals(g, p.x + 0.1 * p.s, p.y - 0.05 * p.s, p.s * 0.85);
    else if (B === '133' || code === 'PL:A-16') PICT.walker(g, p.x, p.y - 0.05 * p.s, p.s, BLK);
    else if (B === '138' || code === 'PL:A-24') PICT.bike(g, p.x - 0.05 * p.s, p.y, p.s * 1.1, BLK);
    else if (B === '123' || code === 'PL:A-14') PICT.works(g, p.x, p.y - 0.05 * p.s, p.s, BLK);
    else if (B === '151' || code === 'PL:A-10') PICT.train(g, p.x - 0.05 * p.s, p.y, p.s * 1.1, BLK);
    else if (B === '102' || code.startsWith('PL:A-5') || code.startsWith('PL:A-6')) { g.fillStyle = BLK; g.fillRect(X(0.43), Y(0), 0.14 * p.s, p.s); if (!code.startsWith('PL:A-6') || /A-6a/.test(code)) g.fillRect(X(0.05), Y(0.43), 0.9 * p.s, 0.14 * p.s); else g.fillRect(X(/A-6b|A-6d/.test(code) ? 0.5 : 0.05), Y(0.43), 0.45 * p.s, 0.14 * p.s); }
    else if (B === '120' || B === '121' || code === 'PL:A-12a') { stroke(g, [[X(0.25), Y(0)], [X(0.25), Y(0.3)], [X(0.38), Y(0.55)], [X(0.38), Y(1)]], w, BLK); stroke(g, [[X(0.75), Y(0)], [X(0.75), Y(0.3)], [X(0.62), Y(0.55)], [X(0.62), Y(1)]], w, BLK); }
    else text(g, '!', c, p.y + p.s * 0.45, p.s * 0.85, p.s, BLK);
    return;
  }
  if (['156', '159', '162'].includes(B)) { const H = S / aspect, y0 = (S - H) / 2; g.fillStyle = WHITE; g.fillRect(0, y0, S, H); const n = B === '156' ? 3 : B === '159' ? 2 : 1; for (let k = 0; k < n; k++) { const yy = y0 + H * (0.15 + k * 0.28); poly(g, [[0, yy + 0.18 * H], [S, yy], [S, yy + 0.12 * H], [0, yy + 0.3 * H]], RED); } return; }
  if (B === '626') { const H = S / aspect, y0 = (S - H) / 2; g.fillStyle = WHITE; g.fillRect(0, y0, S, H); for (let k = 0; k < 6; k++) { const yy = y0 + H * (0.05 + k * 0.17); poly(g, [[0, yy], [S, yy + 0.08 * H], [S, yy + 0.16 * H], [0, yy + 0.08 * H]], RED); } return; }
  // squares / plates
  if (B === '307') { drawFace(g, '306', v, S, aspect); g.save(); g.globalAlpha = 0.9; stroke(g, [[0.2 * S, 0.8 * S], [0.8 * S, 0.2 * S]], 0.06 * S, BLK); g.restore(); return; }
  if (B === '306') { poly(g, [[c, 0], [S, c], [c, S], [0, c]], WHITE); poly(g, [[c, 0.07 * S], [0.93 * S, c], [c, 0.93 * S], [0.07 * S, c]], BLK); poly(g, [[c, 0.1 * S], [0.9 * S, c], [c, 0.9 * S], [0.1 * S, c]], WHITE); poly(g, [[c, 0.22 * S], [0.78 * S, c], [c, 0.78 * S], [0.22 * S, c]], YEL); return; }
  if (['330.1', '330.2', '331.1', '331.2', 'PL:D'].includes(B) && (B !== 'PL:D' || /D-7|D-8|D-9|D-10/.test(code))) {
    g.fillStyle = WHITE; g.fillRect(0, 0, S, S); g.fillStyle = BLUE; g.fillRect(0.03 * S, 0.03 * S, 0.94 * S, 0.94 * S);
    const mw = B.startsWith('330') || /D-9|D-10/.test(code); (mw ? PICT.motorway : PICT.car)(g, 0.18 * S, 0.18 * S, 0.64 * S, WHITE);
    if (B.endsWith('.2') || /D-8|D-10/.test(code)) stroke(g, [[0.12 * S, 0.88 * S], [0.88 * S, 0.12 * S]], 0.07 * S, RED);
    return;
  }
  if (B === 'PL:D' && /D-51/.test(code)) { g.fillStyle = WHITE; g.fillRect(0, 0, S, S); g.fillStyle = BLUE; g.fillRect(0.03 * S, 0.03 * S, 0.94 * S, 0.94 * S); g.fillStyle = WHITE; g.fillRect(0.25 * S, 0.3 * S, 0.5 * S, 0.34 * S); circle(g, 0.5 * S, 0.47 * S, 0.11 * S, BLUE); g.fillRect(0.45 * S, 0.64 * S, 0.1 * S, 0.2 * S); return; }
  if (B === '314') { g.fillStyle = WHITE; g.fillRect(0, 0, S, S); g.fillStyle = BLUE; g.fillRect(0.03 * S, 0.03 * S, 0.94 * S, 0.94 * S); text(g, 'P', c, c, 0.55 * S, 0.8 * S, WHITE); return; }
  if (B === '357') { g.fillStyle = WHITE; g.fillRect(0, 0, S, S); g.fillStyle = BLUE; g.fillRect(0.03 * S, 0.03 * S, 0.94 * S, 0.94 * S); g.fillStyle = WHITE; g.fillRect(0.42 * S, 0.3 * S, 0.16 * S, 0.6 * S); g.fillStyle = RED; g.fillRect(0.26 * S, 0.18 * S, 0.48 * S, 0.14 * S); return; }
  if (B === '354') { g.fillStyle = WHITE; g.fillRect(0, 0, S, S); g.fillStyle = BLUE; g.fillRect(0.03 * S, 0.03 * S, 0.94 * S, 0.94 * S); g.strokeStyle = WHITE; g.lineWidth = 0.05 * S; for (let k = 0; k < 3; k++) { g.beginPath(); for (let i = 0; i <= 20; i++) { const xx = 0.18 * S + i * 0.032 * S, yy = (0.38 + k * 0.14) * S + Math.sin(i * 0.9) * 0.03 * S; i ? g.lineTo(xx, yy) : g.moveTo(xx, yy); } g.stroke(); } return; }
  if (B === '333' || B === '332') { const H = S / aspect, y0 = (S - H) / 2; g.fillStyle = BLUE; g.fillRect(0, y0, S, H); g.strokeStyle = WHITE; g.lineWidth = 0.04 * H; g.strokeRect(0.05 * H, y0 + 0.05 * H, S - 0.1 * H, H - 0.1 * H); text(g, 'Ausfahrt', c - 0.1 * S, y0 + 0.5 * H, 0.22 * H, S * 0.6, WHITE); arrow(g, S * 0.72, y0 + 0.75 * H, S * 0.9, y0 + 0.28 * H, 0.06 * H, WHITE); return; }
  if (B === '390.1' || B === '390.2' || B === '336') { const H = S / aspect, y0 = (S - H) / 2; g.fillStyle = WHITE; g.fillRect(0, y0, S, H); g.fillStyle = BLUE; g.fillRect(0.04 * S, y0 + 0.04 * S, S * 0.92, H - 0.08 * S); text(g, B === '336' ? '' : 'Maut', c, y0 + H * 0.3, 0.12 * H, S * 0.8, WHITE); PICT.truck(g, 0.2 * S, y0 + H * 0.45, 0.6 * S, WHITE); return; }
  if (B === '460' || B === '454' || B === '455.1') { const H = S / aspect, y0 = (S - H) / 2; g.fillStyle = B === '460' ? BLUE : WHITE; g.fillRect(0, y0, S, H); text(g, 'U', S * 0.3, y0 + 0.5 * H, 0.45 * H, S * 0.3, B === '460' ? WHITE : BLK); arrow(g, S * 0.5, y0 + 0.5 * H, S * 0.88, y0 + 0.5 * H, 0.08 * H, B === '460' ? WHITE : BLK); return; }
  if (B === '385' || B === 'PL:E-17a' || B === 'PL:E') { if (B !== 'PL:E') { const H = S / aspect, y0 = (S - H) / 2; g.fillStyle = B === '385' ? YEL : WHITE; g.fillRect(0, y0, S, H); g.strokeStyle = BLK; g.lineWidth = 0.03 * H; g.strokeRect(0.04 * H, y0 + 0.04 * H, S - 0.08 * H, H - 0.08 * H); text(g, String(v || ''), c, y0 + 0.5 * H, 0.3 * H, S - 0.2 * H, BLK); return; }
    board(g, S, aspect, GREEN, WHITE, 3); return; }
  if (B === '386.3' || B === '386.1' || B === '386.2') { const H = S / aspect, y0 = (S - H) / 2; g.fillStyle = BROWN; g.fillRect(0, y0, S, H); g.strokeStyle = WHITE; g.lineWidth = 0.025 * H; g.strokeRect(0.04 * H, y0 + 0.04 * H, S - 0.08 * H, H - 0.08 * H);
    if (v) wrapText(g, v, c, y0 + H * (B === '386.3' ? 0.72 : 0.5), (B === '386.3' ? 0.1 : 0.22) * H, S * 0.86, WHITE, B === '386.3' ? 2 : 1);
    if (B === '386.3') { g.strokeStyle = WHITE; g.lineWidth = 0.03 * H; g.strokeRect(S * 0.3, y0 + H * 0.12, S * 0.4, H * 0.42); }   // the place's pictogram field (not mapped)
    return; }
  if (B === '449' || B === '448' || B === '453' || B === 'PL:F') { board(g, S, aspect, B === 'PL:F' ? BLUE : BLUE, WHITE, B === '453' ? 4 : 3, B === '448' ? 'Ausfahrt' : ''); return; }
  if (/^5\d\d$/.test(B)) { const H = S / aspect, y0 = (S - H) / 2; g.fillStyle = WORKS; g.fillRect(0, y0, S, H); g.strokeStyle = BLK; g.lineWidth = 0.03 * H; g.strokeRect(0.04 * H, y0 + 0.04 * H, S - 0.08 * H, H - 0.08 * H);
    for (let k = 0; k < 2; k++) arrow(g, S * (0.32 + k * 0.36), y0 + 0.85 * H, S * (0.32 + k * 0.36) + (k ? -0.1 : 0.1) * S * (sub.startsWith('2') ? -1 : 1), y0 + 0.18 * H, 0.05 * H, BLK); return; }
  if (/^10\d\d$/.test(B) || B === 'PL:T') {
    const H = S / aspect, y0 = (S - H) / 2; g.fillStyle = WHITE; g.fillRect(0, y0, S, H); g.strokeStyle = BLK; g.lineWidth = 0.035 * H; g.strokeRect(0.04 * H, y0 + 0.04 * H, S - 0.08 * H, H - 0.08 * H);
    const val = v != null ? String(v).replace('.', ',') : '';
    let s = PLATE_TEXT[code] || '';
    if (B === '1000') { const l = sub.startsWith('1') ? -1 : 1; arrow(g, c - l * 0.25 * S, y0 + 0.5 * H, c + l * 0.25 * S, y0 + 0.5 * H, 0.08 * H, BLK); if (sub.endsWith('1')) arrow(g, c + l * 0.25 * S, y0 + 0.5 * H, c - l * 0.25 * S, y0 + 0.5 * H, 0.08 * H, BLK); return; }
    if (B === '1001') s = 'auf ' + (val || '') + (val ? ' km' : '');
    if (B === '1004') s = (val ? val + ' m' : '');
    if (B === '1022') PICT.bike(g, S * 0.12, y0 + 0.1 * H, H * 0.8, BLK);
    if (!s && val) s = val;
    text(g, s, B === '1022' ? c + 0.12 * S : c, y0 + 0.5 * H, 0.32 * H, S * 0.82, BLK); return;
  }
  if (B === 'km') { const H = S / aspect, y0 = (S - H) / 2; g.fillStyle = WHITE; g.fillRect(0, y0, S, H); g.strokeStyle = BLK; g.lineWidth = 0.05 * H; g.strokeRect(0.05 * H, y0 + 0.05 * H, S - 0.1 * H, H - 0.1 * H); text(g, String(v || ''), c, y0 + 0.5 * H, 0.42 * H, S * 0.8, BLK); return; }
  // any other: a plain blue sign without an invented face
  g.fillStyle = WHITE; g.fillRect(0, 0, S, S); g.fillStyle = BLUE; g.fillRect(0.03 * S, 0.03 * S, 0.94 * S, 0.94 * S);
}

// ---------------------------------------------------------------- an atlas of the faces a pack needs
export class SignAtlas {
  constructor(cell = 256, cols = 8) {
    this.cell = cell; this.cols = cols; this.map = new Map();
    this.c = document.createElement('canvas'); this.c.width = cell * cols; this.c.height = cell; this.rows = 1;
    this.g = this.c.getContext('2d');
  }
  /** uv rectangle [u0, v0, u1, v1] of the face (allocated on first use) */
  uv(code, v, aspect = 1) {
    const key = code + '|' + v + '|' + aspect.toFixed(2);
    let k = this.map.get(key);
    if (k == null) {
      k = this.map.size; this.map.set(key, k);
      const need = Math.floor(k / this.cols) + 1;
      if (need > this.rows) { const old = this.c; this.c = document.createElement('canvas'); this.c.width = old.width; this.c.height = this.cell * need; this.g = this.c.getContext('2d'); this.g.drawImage(old, 0, 0); this.rows = need; }
      const x = (k % this.cols) * this.cell, y = Math.floor(k / this.cols) * this.cell;
      this.g.save(); this.g.translate(x, y); drawFace(this.g, code, v, this.cell, aspect); this.g.restore();
    }
    return k;
  }
  rect(k, aspect = 1) {
    const x = (k % this.cols) * this.cell, y = Math.floor(k / this.cols) * this.cell, W = this.c.width, H = this.c.height;
    const hpx = this.cell / aspect, y0 = y + (this.cell - hpx) / 2;
    return [x / W, 1 - (y0 + hpx) / H, (x + this.cell) / W, 1 - y0 / H];
  }
  texture() { const t = new THREE.CanvasTexture(this.c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; return t; }
}

// ---------------------------------------------------------------- the guide post (Leitpfosten), local frame: +z towards the traffic it serves, x across
function guidePostGeo() {
  const pos = [], col = [], W = [0.96, 0.96, 0.94], K = [0.06, 0.06, 0.06];
  const quad = (a, b, c, d, cc) => { pos.push(...a, ...b, ...c, ...a, ...c, ...d); for (let k = 0; k < 6; k++) col.push(...cc); };
  // a prism 0.12 across, 0.10 along the road; the top falls 5 cm towards the road (−x); the black band 25 cm below the top
  const x0 = -0.06, x1 = 0.06, z0 = -0.05, z1 = 0.05, top = (x) => 0.95 + (x - x0) / (x1 - x0) * 0.05;
  const band = [[0, 0.5, W], [0.5, 0.75, K], [0.75, 0.95, W]];
  for (const [ya, yb, cc] of band) {
    const ya1 = (x) => ya + (x - x0) / (x1 - x0) * 0.05 * (ya > 0 ? 1 : 0), yb1 = (x) => yb + (x - x0) / (x1 - x0) * 0.05;
    quad([x0, ya1(x0), z1], [x1, ya1(x1), z1], [x1, yb1(x1), z1], [x0, yb1(x0), z1], cc);   // front
    quad([x1, ya1(x1), z0], [x0, ya1(x0), z0], [x0, yb1(x0), z0], [x1, yb1(x1), z0], cc);   // back
    quad([x1, ya1(x1), z1], [x1, ya1(x1), z0], [x1, yb1(x1), z0], [x1, yb1(x1), z1], cc);   // outer side
    quad([x0, ya1(x0), z0], [x0, ya1(x0), z1], [x0, yb1(x0), z1], [x0, yb1(x0), z0], cc);   // road side
  }
  quad([x0, top(x0), z1], [x1, top(x1), z1], [x1, top(x1), z0], [x0, top(x0), z0], W);
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.computeVertexNormals();
  return g;
}
function reflectorGeo() {
  // front: one rectangle 40 × 180 mm in the band; back: two discs Ø 60 mm (as squares)
  const pos = [], quad = (a, b, c, d) => pos.push(...a, ...b, ...c, ...a, ...c, ...d);
  quad([-0.02, 0.585, 0.052], [0.02, 0.585, 0.052], [0.02, 0.765, 0.052], [-0.02, 0.765, 0.052]);
  for (const y of [0.6, 0.76]) quad([0.03, y - 0.03, -0.052], [-0.03, y - 0.03, -0.052], [-0.03, y + 0.03, -0.052], [0.03, y + 0.03, -0.052]);
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals(); return g;
}
function colored(parts) {
  let n = 0; const G = parts.map(([g, c]) => { g = g.index ? g.toNonIndexed() : g; g.deleteAttribute('uv'); const a = new Float32Array(g.attributes.position.count * 3); for (let i = 0; i < a.length; i += 3) a.set(c, i); g.setAttribute('color', new THREE.BufferAttribute(a, 3)); n += g.attributes.position.count; return g; });
  const P = new Float32Array(n * 3), C = new Float32Array(n * 3); let o = 0;
  for (const g of G) { P.set(g.attributes.position.array, 3 * o); C.set(g.attributes.color.array, 3 * o); o += g.attributes.position.count; }
  const m = new THREE.BufferGeometry(); m.setAttribute('position', new THREE.BufferAttribute(P, 3)); m.setAttribute('color', new THREE.BufferAttribute(C, 3)); m.computeVertexNormals(); return m;
}
const bx = (w, h, d, x, y, z) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
let CAM = null;
function camGeo() {
  if (CAM) return CAM;
  const G = [0.56, 0.58, 0.6], D = [0.08, 0.08, 0.09];
  return (CAM = colored([[new THREE.CylinderGeometry(0.08, 0.1, 2.4, 10).translate(0, 1.2, 0), G], [bx(0.62, 0.9, 0.55, 0, 2.85, 0), G], [bx(0.5, 0.3, 0.02, 0, 3.05, 0.285), D], [bx(0.2, 0.2, 0.02, 0.12, 2.65, 0.285), D], [bx(0.7, 0.06, 0.62, 0, 3.32, 0), G]]));
}
function gantryMesh(q, S) {
  if (!q.span) return null;
  const [x0, y0, x1, y1] = q.span, L = Math.hypot(x1 - x0, y1 - y0); if (L < 4) return null;
  const G = [0.66, 0.68, 0.7], BL = [0.1, 0.28, 0.6], WH = [0.95, 0.95, 0.95];
  const parts = [];
  // local frame: x along the span (from the first end), z towards the traffic, y up
  for (const xx of [0, L]) parts.push([bx(0.45, 7.4, 0.45, xx, 3.7, 0), G], [bx(1.2, 0.3, 1.2, xx, 0.15, 0), [0.6, 0.6, 0.58]]);
  parts.push([bx(L, 0.12, 0.12, L / 2, 6.65, -0.35), G], [bx(L, 0.12, 0.12, L / 2, 7.35, -0.35), G], [bx(L, 0.12, 0.12, L / 2, 6.65, 0.35), G], [bx(L, 0.12, 0.12, L / 2, 7.35, 0.35), G]);
  for (let u = 0; u < L; u += 1.6) parts.push([bx(0.06, 0.8, 0.06, u, 7.0, -0.35), G], [bx(0.06, 0.8, 0.06, u, 7.0, 0.35), G]);
  const nb = Math.max(1, Math.min(4, Math.floor((L - 1) / 4.2)));
  for (let k = 0; k < nb; k++) {
    const cx = L * (k + 0.5) / nb;
    parts.push([bx(3.6, 2.2, 0.1, cx, 6.6, 0.5), BL], [bx(3.4, 0.05, 0.02, cx, 7.62, 0.56), WH], [bx(3.4, 0.05, 0.02, cx, 5.58, 0.56), WH]);
    // the destinations are not mapped: their rows as plain bars, a lane arrow below
    for (let r = 0; r < 3; r++) parts.push([bx(1.6 + 0.4 * ((r + k) % 2), 0.16, 0.02, cx - 0.4, 7.2 - r * 0.42, 0.56), WH]);
    parts.push([bx(0.12, 0.5, 0.02, cx + 1.3, 6.15, 0.56), WH]);
  }
  const g = colored(parts);
  // local x along the span (map direction (ex, ey) at rotation atan2(ey, ex)); local +z is the span's right: callers give
  // the ends so that the approaching traffic is on that side
  const M = new THREE.Matrix4().makeRotationY(Math.atan2(y1 - y0, x1 - x0)); M.setPosition(x0, q.z, -y0);
  g.applyMatrix4(M);
  const m = new THREE.Mesh(g, S.solid); m.castShadow = true; m.receiveShadow = true; return [m];
}
const makeFace = () => new THREE.MeshStandardMaterial({ transparent: true, alphaTest: 0.5, roughness: 0.55, emissive: 0xffffff, emissiveIntensity: 0.12 });
/** the materials signs are drawn with, as [material, object kind ('mesh' | 'inst'), casts a shadow], for the road view's
 *  warm-up; the face material comes from the pool with the texture given (the caller returns it) */
export function signWarmList(tex) {
  const S = shared(), face = pooled('sign-face', makeFace); face.map = tex; face.emissiveMap = tex;
  return [[face, 'mesh', true], [S.backMat, 'mesh', true], [S.edgeMat, 'mesh', true], [S.postMat, 'inst', true], [S.solid, 'inst', true], [S.solid, 'mesh', true], [S.gpMat, 'inst', true], [S.reflMat, 'inst', false]];
}
let SHARED = null;
function shared() {
  if (SHARED) return SHARED;
  SHARED = {
    post: new THREE.CylinderGeometry(0.0302, 0.0302, 1, 8).translate(0, 0.5, 0),
    postMat: new THREE.MeshStandardMaterial({ color: 0xa8aeb3, roughness: 0.45, metalness: 0.7 }),
    backMat: new THREE.MeshStandardMaterial({ color: 0x4e5452, roughness: 0.6, metalness: 0.2 }),
    edgeMat: new THREE.MeshStandardMaterial({ color: 0xb9bec2, roughness: 0.4, metalness: 0.6 }),
    gp: guidePostGeo(), gpMat: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55 }),
    refl: reflectorGeo(), reflMat: new THREE.MeshStandardMaterial({ color: 0xf2f2ee, emissive: 0x9a9a92, roughness: 0.3 }),
    solid: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.3 }),
  };
  return SHARED;
}

/** meshes for a list of signs: {x, y, z (ground), yaw (the face's normal, radians, scene rotation about y), code, v,
 *  speed, wide}; guide posts (code 620) instanced. Returns {meshes, atlas} */
export function buildSigns(list) {
  const S = shared(), out = [];
  const special = new Set(['620', 'cam', 'gantry']);
  const plates = list.filter((q) => !special.has(base(q.code))), posts620 = list.filter((q) => base(q.code) === '620');
  const cams = list.filter((q) => q.code === 'cam'), gantries = list.filter((q) => q.code === 'gantry');
  if (plates.length) {
    const atlas = new SignAtlas(), pos = [], uv = [], idx = [], bpos = [], bidx = [], epos = [], eidx = [];
    const postM = [];
    const M = new THREE.Matrix4(), V = new THREE.Vector3();
    // signs on one post (one mapped node: the sign and its plates, or several signs) stack downwards from the top; the
    // lowest edge stays at its mounting height (2.0 m, large boards lower)
    const groups = new Map();
    for (const q of plates) { const key = q.x.toFixed(1) + ',' + q.y.toFixed(1) + ',' + q.yaw.toFixed(1); let a = groups.get(key); if (!a) groups.set(key, (a = [])); a.push(q); }
    for (const grp of groups.values()) {
      const dims = grp.map((q) => signDims(q.code, q.v, q.speed, q.wide));
      const bottom = Math.min(...dims.map((d) => d.lower ?? 2.0)), total = dims.reduce((a, d) => a + d.h, 0) + 0.03 * (grp.length - 1);
      let top = bottom + total; const W = Math.max(...dims.map((d) => d.w));
      grp.forEach((q, gi) => { q._lower = top - dims[gi].h; q._d = dims[gi]; top -= dims[gi].h + 0.03; q._post = gi === 0 ? { np: W >= 1.2 ? 2 : 1, W, h: bottom + total } : null; });
    }
    for (const q of plates) {
      const d = q._d, aspect = d.w / d.h;
      const k = atlas.uv(q.code, q.v, aspect > 1.05 ? aspect : 1), [u0, v0, u1, v1] = atlas.rect(k, aspect > 1.05 ? aspect : 1);
      const lower = q._lower, cy = lower + d.h / 2;
      M.makeRotationY(q.yaw); M.setPosition(q.x, q.z, -q.y);
      const P = (x, y, z) => V.set(x, y, z).applyMatrix4(M).toArray();
      const hw = d.w / 2, hh = d.h / 2, t = 0.012;
      // front face (textured, transparent outside the shape), back plate and edge profile follow the shape's bounding box
      const o = pos.length / 3;
      pos.push(...P(-hw, cy - hh, t), ...P(hw, cy - hh, t), ...P(hw, cy + hh, t), ...P(-hw, cy + hh, t));
      uv.push(u0, v0, u1, v0, u1, v1, u0, v1); idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
      // back: the same outline in grey (a polygon of the shape)
      const outline = d.shape === 'round' ? Array.from({ length: 24 }, (_, i) => [Math.cos((i / 24) * Math.PI * 2) * hw * 0.99, cy + Math.sin((i / 24) * Math.PI * 2) * hh * 0.99])
        : d.shape === 'oct' ? Array.from({ length: 8 }, (_, i) => { const a = Math.PI / 8 + (i * Math.PI) / 4, r = hw / Math.cos(Math.PI / 8); return [Math.cos(a) * r, cy + Math.sin(a) * r]; })
          : d.shape === 'tri-down' ? [[-hw, cy + hh], [0, cy - hh], [hw, cy + hh]] : d.shape === 'tri' ? [[-hw, cy - hh], [hw, cy - hh], [0, cy + hh]]
            : d.shape === 'diamond' ? [[0, cy - hh], [hw, cy], [0, cy + hh], [-hw, cy]] : [[-hw, cy - hh], [hw, cy - hh], [hw, cy + hh], [-hw, cy + hh]];
      const ob = bpos.length / 3; outline.forEach(([x, y]) => bpos.push(...P(x, y, -t))); bpos.push(...P(0, cy, -t));
      for (let i = 0; i < outline.length; i++) bidx.push(ob + outline.length, ob + (i + 1) % outline.length, ob + i);
      const oe = epos.length / 3; outline.forEach(([x, y]) => { epos.push(...P(x, y, t * 0.9), ...P(x, y, -t)); });
      for (let i = 0; i < outline.length; i++) { const a = oe + 2 * i, b = oe + 2 * ((i + 1) % outline.length); eidx.push(a, b, b + 1, a, b + 1, a + 1); }
      // posts: one per stack (two under wide signs and boards) from the ground to the top of the stack
      if (q._post) { const { np, W, h } = q._post; for (let i = 0; i < np; i++) { const ox = np > 1 ? (i ? 0.32 : -0.32) * W : 0; const pp = V.set(ox, 0, -t - 0.035).applyMatrix4(M).clone(); postM.push([pp, h + 0.03, W >= 2.5 ? 2.2 : 1]); } }
    }
    const tex = atlas.texture();
    const fm = pooled('sign-face', makeFace);
    fm.map = tex; fm.emissiveMap = tex;
    const mk = (p, ix, mat, u) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); if (u) g.setAttribute('uv', new THREE.Float32BufferAttribute(u, 2)); g.setIndex(ix); g.computeVertexNormals(); const m = new THREE.Mesh(g, mat); m.castShadow = true; m.receiveShadow = true; return m; };
    const face = mk(pos, idx, fm, uv); face.userData.tex = tex;          // (the atlas goes with the pack)
    out.push(face, mk(bpos, bidx, S.backMat), mk(epos, eidx, S.edgeMat));
    const im = new THREE.InstancedMesh(S.post, S.postMat, postM.length), mm = new THREE.Matrix4(), sc = new THREE.Vector3(), qq = new THREE.Quaternion();
    postM.forEach(([p, h, r], i) => { mm.compose(p, qq, sc.set(r, h, r)); im.setMatrixAt(i, mm); }); im.castShadow = true; out.push(im);
  }
  // speed cameras: the grey housing on its column, the lens towards the traffic it watches
  if (cams.length) {
    const g = camGeo(), im = new THREE.InstancedMesh(g, S.solid, cams.length), mm = new THREE.Matrix4(), qq = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
    cams.forEach((q, i) => { qq.setFromAxisAngle(up, q.yaw); mm.compose(p.set(q.x, q.z, -q.y), qq, one); im.setMatrixAt(i, mm); }); im.castShadow = true; out.push(im);
  }
  // sign gantries over the carriageway: two columns, a truss at 6.6–7.4 m, blue boards (lower edge 5.5 m) facing the traffic
  for (const q of gantries) { const m = gantryMesh(q, S); if (m) out.push(...m); }
  if (posts620.length) {
    const im = new THREE.InstancedMesh(S.gp, S.gpMat, posts620.length), ir = new THREE.InstancedMesh(S.refl, S.reflMat, posts620.length);
    const mm = new THREE.Matrix4(), qq = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
    posts620.forEach((q, i) => { qq.setFromAxisAngle(up, q.yaw); mm.compose(p.set(q.x, q.z, -q.y), qq, one); im.setMatrixAt(i, mm); ir.setMatrixAt(i, mm); });
    im.castShadow = true; out.push(im, ir);
  }
  return out;
}

// ---------------------------------------------------------------- traffic signals
// A German signal post as it stands at the kerb: galvanised pole (Ø 114 mm), the vehicle signal (three 200 mm lamps in a
// black housing with visors, on a black contrast panel with a white border, lower edge about 2.3 m), a pedestrian signal
// facing across the road (red and green figure lamps) and the yellow push-button box at 1.05 m. With arm = true a mast arm
// reaches over the carriageway (wide roads) and carries a second vehicle signal over the lanes at 5.6 m.
// Local frame: the vehicle signal looks along +z (towards the traffic it serves), the carriageway lies towards -x.
// Returns a non-indexed geometry with vertex colours; lamp colours are lit (red on, the others dim) so they read by day.
export function signalGeo(arm = false) {
  const G = [];
  const col = (g, c) => { g = g.index ? g.toNonIndexed() : g; const n = g.attributes.position.count, a = new Float32Array(n * 3); for (let i = 0; i < n; i++) a.set(c, 3 * i); g.setAttribute('color', new THREE.BufferAttribute(a, 3)); g.deleteAttribute('uv'); G.push(g); return g; };
  const box = (w, h, d, x, y, z, c) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); return col(g, c); };
  const cyl = (r0, r1, h, x, y, z, c, seg = 10) => { const g = new THREE.CylinderGeometry(r0, r1, h, seg); g.translate(x, y, z); return col(g, c); };
  const POLE = [0.6, 0.62, 0.63], BLACK = [0.035, 0.035, 0.04], WHITE = [0.93, 0.93, 0.92], YEL = [0.95, 0.78, 0.08];
  const RED = [1.0, 0.12, 0.06], AMB = [0.42, 0.26, 0.04], GRN = [0.04, 0.3, 0.14];
  cyl(0.057, 0.057, arm ? 6.2 : 4.0, 0, (arm ? 6.2 : 4.0) / 2, 0, POLE, 12);
  cyl(0.07, 0.07, 0.1, 0, arm ? 6.2 : 4.0, 0, POLE, 12);
  // a vehicle signal head centred at (x, y, z) looking along +z
  const head = (x, y, z) => {
    box(0.66, 1.16, 0.02, x, y, z - 0.01, WHITE);                  // contrast panel: white border …
    box(0.58, 1.08, 0.03, x, y, z, BLACK);                         // … black field
    box(0.3, 0.86, 0.24, x, y, z + 0.13, BLACK);                   // housing
    [RED, AMB, GRN].forEach((c, k) => {
      const yy = y + 0.28 - k * 0.28;
      const l = new THREE.CylinderGeometry(0.1, 0.1, 0.02, 16); l.rotateX(Math.PI / 2); l.translate(x, yy, z + 0.26); col(l, c);
      // visor: an open half cylinder over the lamp
      const v = new THREE.CylinderGeometry(0.115, 0.115, 0.2, 12, 1, true, -Math.PI / 2, Math.PI); v.rotateX(Math.PI / 2); v.translate(x, yy, z + 0.36); col(v, BLACK);
    });
    box(0.06, 0.06, 0.16, x, y + 0.36, z - 0.08, POLE); box(0.06, 0.06, 0.16, x, y - 0.36, z - 0.08, POLE);   // brackets to the pole
  };
  head(-0.02, 2.85, 0.14);
  // pedestrian signal: two figure lamps facing across the road (-x)
  {
    const px = -0.14, py = 2.3;
    box(0.24, 0.62, 0.3, px - 0.1, py, 0, BLACK);
    [[RED, 0.15], [GRN, -0.15]].forEach(([c, dy]) => { const l = new THREE.PlaneGeometry(0.17, 0.2); l.rotateY(-Math.PI / 2); l.translate(px - 0.225, py + dy, 0); col(l, c); });
  }
  box(0.1, 0.24, 0.14, -0.09, 1.05, 0, YEL);                        // push button
  box(0.02, 0.06, 0.07, -0.145, 1.08, 0, BLACK);
  if (arm) {
    // the arm over the carriageway (towards -x), tapering, with the overhead head at its end
    const L = 4.6; const a = new THREE.CylinderGeometry(0.04, 0.055, L, 10); a.rotateZ(Math.PI / 2); a.translate(-L / 2, 6.0, 0); col(a, POLE);
    const s = new THREE.CylinderGeometry(0.02, 0.02, 2.0, 6); s.rotateZ(Math.atan2(1.0, 1.6)); s.translate(-0.8, 6.55, 0); col(s, POLE);
    head(-L + 0.3, 5.45, 0.06);
  }
  // merge
  let n = 0; for (const g of G) n += g.attributes.position.count;
  const P = new Float32Array(n * 3), C = new Float32Array(n * 3); let o = 0;
  for (const g of G) { P.set(g.attributes.position.array, 3 * o); C.set(g.attributes.color.array, 3 * o); o += g.attributes.position.count; g.dispose(); }
  const m = new THREE.BufferGeometry(); m.setAttribute('position', new THREE.BufferAttribute(P, 3)); m.setAttribute('color', new THREE.BufferAttribute(C, 3)); m.computeVertexNormals();
  return m;
}
