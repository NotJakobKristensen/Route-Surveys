// The sizes of German and Polish road signs as they stand at the road (signs.js draws them; the route scan, tools/route_scan.mjs,
// takes their heights): no dependencies, so it runs in Node as well.
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
