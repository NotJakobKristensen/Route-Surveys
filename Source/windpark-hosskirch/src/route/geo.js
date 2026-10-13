// Coordinates back to latitude / longitude (WGS84) for links to other maps.
// Transverse Mercator inverse after Krüger (6th-order series, < 1 mm inside a zone), used for the three frames of the page:
// the road view (UTM 33N, relative to the session origin), the country map (TM 12.1°E / 50.6°N) and each survey point
// (a local TM centred on the passage).

const A_ = 6378137, F_ = 1 / 298.257223563;
const N_ = F_ / (2 - F_), N2 = N_ * N_, N3 = N2 * N_, N4 = N3 * N_, N5 = N4 * N_, N6 = N5 * N_;
const AR = (A_ / (1 + N_)) * (1 + N2 / 4 + N4 / 64 + N6 / 256);
const ALPHA = [
  N_ / 2 - (2 / 3) * N2 + (5 / 16) * N3 + (41 / 180) * N4 - (127 / 288) * N5 + (7891 / 37800) * N6,
  (13 / 48) * N2 - (3 / 5) * N3 + (557 / 1440) * N4 + (281 / 630) * N5 - (1983433 / 1935360) * N6,
  (61 / 240) * N3 - (103 / 140) * N4 + (15061 / 26880) * N5 + (167603 / 181440) * N6,
  (49561 / 161280) * N4 - (179 / 168) * N5 + (6601661 / 7257600) * N6,
  (34729 / 80640) * N5 - (3418889 / 1995840) * N6,
  (212378941 / 319334400) * N6,
];
const BETA = [
  N_ / 2 - (2 / 3) * N2 + (37 / 96) * N3 - (1 / 360) * N4 - (81 / 512) * N5 + (96199 / 604800) * N6,
  (1 / 48) * N2 + (1 / 15) * N3 - (437 / 1440) * N4 + (46 / 105) * N5 - (1118711 / 3870720) * N6,
  (17 / 480) * N3 - (37 / 840) * N4 - (209 / 4480) * N5 + (5569 / 90720) * N6,
  (4397 / 161280) * N4 - (11 / 504) * N5 - (830251 / 7257600) * N6,
  (4583 / 161280) * N5 - (108847 / 3991680) * N6,
  (20648693 / 638668800) * N6,
];
const E_ = Math.sqrt(F_ * (2 - F_));
const D2R = Math.PI / 180;

// northing of latitude lat (deg) on the central meridian, scale 1
function meridian(lat) {
  const p = lat * D2R, t = Math.sinh(Math.atanh(Math.sin(p)) - E_ * Math.atanh(E_ * Math.sin(p)));
  const xi = Math.atan(t);
  let x = xi; for (let j = 1; j <= 6; j++) x += ALPHA[j - 1] * Math.sin(2 * j * xi);
  return AR * x;
}

/** (x, y) in a transverse Mercator → [lat, lon] in degrees */
export function tmInverse(x, y, { lon0, lat0 = 0, k0 = 1, x0 = 0, y0 = 0 }) {
  const xi = (y - y0 + k0 * meridian(lat0)) / (k0 * AR), eta = (x - x0) / (k0 * AR);
  let xp = xi, ep = eta;
  for (let j = 1; j <= 6; j++) { xp -= BETA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta); ep -= BETA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta); }
  const tau0 = Math.sin(xp) / Math.sqrt(Math.sinh(ep) ** 2 + Math.cos(xp) ** 2);
  // conformal → geodetic latitude by Newton on tau (Karney 2011)
  let tau = tau0;
  for (let k = 0; k < 6; k++) {
    const s = Math.sqrt(1 + tau * tau), sig = Math.sinh(E_ * Math.atanh(E_ * tau / s));
    const tp = tau * Math.sqrt(1 + sig * sig) - sig * s;
    const d = ((tau0 - tp) / Math.sqrt(1 + tp * tp)) * ((1 + (1 - E_ * E_) * tau * tau) / ((1 - E_ * E_) * s));
    tau += d; if (Math.abs(d) < 1e-14) break;
  }
  const lat = Math.atan(tau) / D2R, lon = lon0 + Math.atan2(Math.sinh(ep), Math.cos(xp)) / D2R;
  return [lat, lon];
}

/** [lat, lon] in degrees → (x, y) in a transverse Mercator (Krüger series, the inverse of tmInverse) */
export function tmForward(lat, lon, { lon0, lat0 = 0, k0 = 1, x0 = 0, y0 = 0 }) {
  const p = lat * D2R, t = Math.sinh(Math.atanh(Math.sin(p)) - E_ * Math.atanh(E_ * Math.sin(p))), l = (lon - lon0) * D2R;
  const xi = Math.atan2(t, Math.cos(l)), eta = Math.atanh(Math.sin(l) / Math.sqrt(1 + t * t));
  let x = xi, e = eta;
  for (let j = 1; j <= 6; j++) { x += ALPHA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta); e += ALPHA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta); }
  return [x0 + k0 * AR * e, y0 + k0 * AR * x - k0 * meridian(lat0)];
}
export const utm33 = (E, N) => tmInverse(E, N, { lon0: 15, k0: 0.9996, x0: 500000 });
export const utm33fwd = (lat, lon) => tmForward(lat, lon, { lon0: 15, k0: 0.9996, x0: 500000 });
/** meridian convergence (deg): the angle from true north to grid north, positive east of the central meridian; a grid
 *  bearing plus this is the true bearing */
export const convergence = (lat, lon, lon0) => Math.atan(Math.tan((lon - lon0) * D2R) * Math.sin(lat * D2R)) / D2R;

const f6 = (v) => v.toFixed(6);
/** links to Google Maps for a point: a pin, the satellite picture and Street View (heading in degrees from true north) */
export function mapsLinks(lat, lon, heading, viewWidth) {
  const ll = `${f6(lat)}%2C${f6(lon)}`;
  // zoom that shows about the same width as the view (Web Mercator: 156543 m/px at zoom 0, ~1400 px wide window)
  const zoom = Number.isFinite(viewWidth) ? Math.max(3, Math.min(21, Math.round(Math.log2((156543 * Math.cos(lat * D2R) * 1400) / Math.max(20, viewWidth))))) : 19;
  return {
    lat, lon, text: `${lat.toFixed(5)}° N, ${lon.toFixed(5)}° E`,
    pin: `https://www.google.com/maps/search/?api=1&query=${ll}`,
    sat: `https://www.google.com/maps/@?api=1&map_action=map&center=${ll}&zoom=${zoom}&basemap=satellite`,
    street: `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${ll}${Number.isFinite(heading) ? `&heading=${Math.round(((heading % 360) + 360) % 360)}` : ''}`,
  };
}
