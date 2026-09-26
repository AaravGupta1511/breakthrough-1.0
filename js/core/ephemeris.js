// Low-precision ephemerides for the Sun, Moon and planets.
// Accuracy is a fraction of a degree, which is plenty for visualisation and
// for distance read-outs. Geocentric results are in the Earth-centred
// equatorial inertial frame (ECI, km); heliocentric ones in the ecliptic frame.

import { AU, DEG, OBLIQUITY, R_EARTH } from './constants.js';
import { toJulian, centuriesSinceJ2000 } from './time.js';
import { rotX, sub } from './vec.js';

const sinD = (x) => Math.sin(x * DEG);
const cosD = (x) => Math.cos(x * DEG);

// Sun position (Astronomical Almanac low-precision formula), ECI km.
export function sunPositionEci(ms) {
  const n = toJulian(ms) - 2451545.0;
  const L = 280.460 + 0.9856474 * n;
  const g = 357.528 + 0.9856003 * n;
  const lambda = L + 1.915 * sinD(g) + 0.020 * sinD(2 * g);
  const eps = 23.439 - 0.0000004 * n;
  const R = (1.00014 - 0.01671 * cosD(g) - 0.00014 * cosD(2 * g)) * AU;
  return [
    R * cosD(lambda),
    R * cosD(eps) * sinD(lambda),
    R * sinD(eps) * sinD(lambda),
  ];
}

// Moon position (Astronomical Almanac low-precision series), ECI km.
export function moonPositionEci(ms) {
  const T = centuriesSinceJ2000(ms);
  const lambda = 218.32 + 481267.881 * T
    + 6.29 * sinD(135.0 + 477198.87 * T) - 1.27 * sinD(259.3 - 413335.36 * T)
    + 0.66 * sinD(235.7 + 890534.22 * T) + 0.21 * sinD(269.9 + 954397.74 * T)
    - 0.19 * sinD(357.5 + 35999.05 * T) - 0.11 * sinD(186.5 + 966404.03 * T);
  const beta = 5.13 * sinD(93.3 + 483202.02 * T) + 0.28 * sinD(228.2 + 960400.89 * T)
    - 0.28 * sinD(318.3 + 6003.15 * T) - 0.17 * sinD(217.6 - 407332.21 * T);
  const parallax = 0.9508 + 0.0518 * cosD(135.0 + 477198.87 * T)
    + 0.0095 * cosD(259.3 - 413335.36 * T) + 0.0078 * cosD(235.7 + 890534.22 * T)
    + 0.0028 * cosD(269.9 + 954397.74 * T);
  const r = R_EARTH / sinD(parallax);
  const ecl = [r * cosD(beta) * cosD(lambda), r * cosD(beta) * sinD(lambda), r * sinD(beta)];
  return rotX(ecl, OBLIQUITY);
}

// Moon velocity by central difference (ECI km/s).
export function moonVelocityEci(ms) {
  const a = moonPositionEci(ms - 30000);
  const b = moonPositionEci(ms + 30000);
  return [(b[0] - a[0]) / 60, (b[1] - a[1]) / 60, (b[2] - a[2]) / 60];
}

// JPL "Approximate Positions of the Planets", Table 1 (valid 1800-2050).
// [a (AU), e, I, L, long. perihelion, long. node] and their rates per century.
export const PLANETS = [
  { name: 'Mercury', color: '#b7b1a8', radius: 2439.7,
    el: [0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593],
    rate: [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081] },
  { name: 'Venus', color: '#e8cf96', radius: 6051.8,
    el: [0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255],
    rate: [0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418] },
  { name: 'Earth', color: '#4f8fe8', radius: 6371.0,
    el: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0],
    rate: [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0] },
  { name: 'Mars', color: '#d9653b', radius: 3389.5,
    el: [1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
    rate: [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343] },
  { name: 'Jupiter', color: '#d8b48c', radius: 69911,
    el: [5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909],
    rate: [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106] },
  { name: 'Saturn', color: '#e6d3a1', radius: 58232,
    el: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448],
    rate: [-0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794] },
  { name: 'Uranus', color: '#a6dde3', radius: 25362,
    el: [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503],
    rate: [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589] },
  { name: 'Neptune', color: '#5b7fe0', radius: 24622,
    el: [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574],
    rate: [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664] },
];

function solveKeplerDeg(Mdeg, e) {
  let M = ((Mdeg % 360) + 540) % 360 - 180;
  M *= DEG;
  let E = M + e * Math.sin(M);
  for (let i = 0; i < 12; i++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-12) break;
  }
  return E;
}

// Heliocentric ecliptic position of a planet (km).
export function planetPositionHelio(planet, ms) {
  const T = centuriesSinceJ2000(ms);
  const [a0, e0, I0, L0, w0, O0] = planet.el;
  const [da, de, dI, dL, dw, dO] = planet.rate;
  const a = (a0 + da * T) * AU;
  const e = e0 + de * T;
  const I = (I0 + dI * T) * DEG;
  const L = L0 + dL * T;
  const varpi = w0 + dw * T;
  const Om = (O0 + dO * T) * DEG;
  const w = varpi * DEG - Om;
  const E = solveKeplerDeg(L - varpi, e);
  const xp = a * (Math.cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(Om), sO = Math.sin(Om), cI = Math.cos(I), sI = Math.sin(I);
  return [
    (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp,
    (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
    (sw * sI) * xp + (cw * sI) * yp,
  ];
}

// Orbit ellipse of a planet (heliocentric ecliptic km), for drawing.
export function planetOrbitPath(planet, ms, segments = 256) {
  const T = centuriesSinceJ2000(ms);
  const [a0, e0, I0, , w0, O0] = planet.el;
  const [da, de, dI, , dw, dO] = planet.rate;
  const a = (a0 + da * T) * AU, e = e0 + de * T, I = (I0 + dI * T) * DEG;
  const Om = (O0 + dO * T) * DEG, w = (w0 + dw * T) * DEG - Om;
  const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(Om), sO = Math.sin(Om), cI = Math.cos(I), sI = Math.sin(I);
  const pts = [];
  for (let k = 0; k <= segments; k++) {
    const E = (k / segments) * 2 * Math.PI;
    const xp = a * (Math.cos(E) - e);
    const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
    pts.push([
      (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp,
      (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
      (sw * sI) * xp + (cw * sI) * yp,
    ]);
  }
  return pts;
}

const EARTH = PLANETS.find((p) => p.name === 'Earth');

// Planet position relative to Earth, in the ECI (equatorial) frame, km.
export function planetPositionEci(planet, ms) {
  const rel = sub(planetPositionHelio(planet, ms), planetPositionHelio(EARTH, ms));
  return rotX(rel, OBLIQUITY);
}

// Convert an ECI vector to the ecliptic frame (for the solar-system view).
export const eciToEcliptic = (v) => rotX(v, -OBLIQUITY);

// Is a point (ECI) inside Earth's shadow? Cylindrical shadow model.
export function inEarthShadow(r, sunEci) {
  const s = Math.hypot(sunEci[0], sunEci[1], sunEci[2]);
  const u = [sunEci[0] / s, sunEci[1] / s, sunEci[2] / s];
  const along = r[0] * u[0] + r[1] * u[1] + r[2] * u[2];
  if (along > 0) return false;
  const perp = Math.hypot(r[0] - along * u[0], r[1] - along * u[1], r[2] - along * u[2]);
  return perp < R_EARTH;
}
