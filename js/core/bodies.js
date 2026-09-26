// Solar-system bodies: physical data and positions.
//
// All vectors use the same axes as the Earth-centred inertial frame (Earth's
// equator and equinox), whatever the origin, so a position relative to any
// body can be converted to any other by adding body positions.
// Planet orbits come from JPL's approximate elements (see ephemeris.js); the
// planets' moons move on circular orbits in their planet's equatorial plane,
// with representative (not ephemeris-accurate) positions along those orbits.

import { AU, DEG, MOON_SOI, MU_EARTH, MU_MOON, MU_SUN, OBLIQUITY, R_EARTH, R_MOON, R_SUN } from './constants.js';
import { PLANETS, moonPositionEci, planetPositionHelio } from './ephemeris.js';
import { add, cross, rotX, scale, sub, unit } from './vec.js';

const J2000 = Date.UTC(2000, 0, 1, 12);
const planetData = (name) => PLANETS.find((p) => p.name === name);
const poleVector = (raDeg, decDeg) => [
  Math.cos(decDeg * DEG) * Math.cos(raDeg * DEG),
  Math.cos(decDeg * DEG) * Math.sin(raDeg * DEG),
  Math.sin(decDeg * DEG),
];
const soiRadius = (a, mu, muParent) => a * (mu / muParent) ** 0.4;

// Planets: GM (km^3/s^2), equatorial radius (km), IAU north pole (RA, Dec),
// and a representative capture orbit (periapsis x apoapsis altitude, km).
const PLANET_INFO = {
  mercury: { name: 'Mercury', mu: 22031.78, radius: 2440.5, pole: [281.0103, 61.4155], capture: [200, 15000], color: '#b7b1a8' },
  venus: { name: 'Venus', mu: 324858.59, radius: 6051.8, pole: [272.76, 67.16], capture: [250, 66000], color: '#e8cf96' },
  mars: { name: 'Mars', mu: 42828.37, radius: 3396.2, pole: [317.681, 52.887], capture: [400, 33000], color: '#d9653b' },
  jupiter: { name: 'Jupiter', mu: 126686534, radius: 71492, pole: [268.057, 64.495], capture: [4200, 8000000], color: '#d8b48c' },
  saturn: { name: 'Saturn', mu: 37931187, radius: 60268, pole: [40.589, 83.537], capture: [20000, 9000000], color: '#e6d3a1' },
  uranus: { name: 'Uranus', mu: 5793939, radius: 25559, pole: [257.311, -15.175], capture: [4000, 1500000], color: '#a6dde3' },
  neptune: { name: 'Neptune', mu: 6836529, radius: 24764, pole: [299.36, 43.46], capture: [4000, 1500000], color: '#5b7fe0' },
};

// Moons of other planets: orbit radius (km), radius, GM, final orbit altitude,
// and whether they orbit against the IAU pole (Uranus's moons and Triton do).
// Phobos and Deimos are too small to orbit, so missions rendezvous instead.
const MOON_INFO = {
  phobos: { name: 'Phobos', parent: 'mars', a: 9376, radius: 11.1, mu: 7.087e-4, small: true, phase: 40, color: '#8a7d70' },
  deimos: { name: 'Deimos', parent: 'mars', a: 23463, radius: 6.2, mu: 9.62e-5, small: true, phase: 200, color: '#a39486' },
  io: { name: 'Io', parent: 'jupiter', a: 421700, radius: 1821.6, mu: 5959.9, orbitAlt: 200, phase: 106, color: '#e8d25a' },
  europa: { name: 'Europa', parent: 'jupiter', a: 671034, radius: 1560.8, mu: 3202.7, orbitAlt: 100, phase: 176, color: '#d9cbb3' },
  ganymede: { name: 'Ganymede', parent: 'jupiter', a: 1070412, radius: 2634.1, mu: 9887.8, orbitAlt: 500, phase: 305, color: '#a39a8c' },
  callisto: { name: 'Callisto', parent: 'jupiter', a: 1882709, radius: 2410.3, mu: 7179.3, orbitAlt: 200, phase: 64, color: '#6e6456' },
  titan: { name: 'Titan', parent: 'saturn', a: 1221870, radius: 2574.7, mu: 8978.1, orbitAlt: 1500, phase: 12, color: '#d9a44e' },
  enceladus: { name: 'Enceladus', parent: 'saturn', a: 237948, radius: 252.1, mu: 7.211, orbitAlt: 100, phase: 250, color: '#f4f7fa' },
  titania: { name: 'Titania', parent: 'uranus', a: 435910, radius: 788.4, mu: 228.2, orbitAlt: 100, phase: 140, retrograde: true, color: '#b3aca5' },
  triton: { name: 'Triton', parent: 'neptune', a: 354759, radius: 1353.4, mu: 1427.6, orbitAlt: 200, phase: 300, retrograde: true, color: '#e3cfc6' },
};

export const BODIES = {
  sun: { id: 'sun', name: 'Sun', mu: MU_SUN, radius: R_SUN, parent: null, color: '#ffd97a' },
  earth: { id: 'earth', name: 'Earth', mu: MU_EARTH, radius: R_EARTH, parent: 'sun', planet: planetData('Earth'), color: '#4f8fe8' },
  moon: { id: 'moon', name: 'Moon', mu: MU_MOON, radius: R_MOON, parent: 'earth', soi: MOON_SOI, orbitAlt: 100, color: '#cfcfcf' },
};
BODIES.earth.soi = soiRadius(AU, MU_EARTH, MU_SUN);

for (const [id, p] of Object.entries(PLANET_INFO)) {
  const planet = planetData(p.name);
  BODIES[id] = {
    id, ...p, parent: 'sun', planet,
    poleDir: poleVector(...p.pole),
    soi: soiRadius(planet.el[0] * AU, p.mu, MU_SUN),
    moons: [],
  };
}
for (const [id, m] of Object.entries(MOON_INFO)) {
  const parent = BODIES[m.parent];
  const n = unit(cross([0, 0, 1], parent.poleDir)); // planet's equator node on Earth's equator
  const w = cross(parent.poleDir, n);
  BODIES[id] = {
    id, ...m,
    soi: soiRadius(m.a, m.mu, parent.mu),
    meanMotion: (m.retrograde ? -1 : 1) * Math.sqrt(parent.mu / m.a ** 3),
    basis: [n, w],
  };
  parent.moons.push(id);
}

export const PLANET_IDS = Object.keys(PLANET_INFO);
export const MOON_IDS = Object.keys(MOON_INFO);

// Ecliptic north expressed in equatorial axes (the "prograde" direction for
// heliocentric orbits).
export const ECLIPTIC_NORTH = rotX([0, 0, 1], OBLIQUITY);

// Orbit normal of a moon (direction of its angular momentum).
export function orbitNormal(id) {
  const b = BODIES[id];
  const pole = BODIES[b.parent].poleDir;
  return b.retrograde ? scale(pole, -1) : pole;
}

// Position of a body relative to its parent, km.
export function positionRelParent(id, ms) {
  const b = BODIES[id];
  if (id === 'sun') return [0, 0, 0];
  if (id === 'moon') return moonPositionEci(ms);
  if (b.planet) return rotX(planetPositionHelio(b.planet, ms), OBLIQUITY);
  const th = b.phase * DEG + b.meanMotion * ((ms - J2000) / 1000);
  const [n, w] = b.basis;
  return add(scale(n, b.a * Math.cos(th)), scale(w, b.a * Math.sin(th)));
}

// Heliocentric position, km.
export function helioPosition(id, ms) {
  let r = [0, 0, 0];
  for (let b = id; b && b !== 'sun'; b = BODIES[b].parent) r = add(r, positionRelParent(b, ms));
  return r;
}

// Position and velocity of body `id` relative to body `center`.
export function stateRelTo(id, center, ms) {
  const dt = BODIES[id].parent === 'sun' || BODIES[center]?.parent === 'sun' ? 600 : 30;
  const pos = (t) => (BODIES[id].parent === center ? positionRelParent(id, t) : sub(helioPosition(id, t), helioPosition(center, t)));
  const a = pos(ms - dt * 1000), b = pos(ms + dt * 1000);
  return { r: pos(ms), v: scale(sub(b, a), 1 / (2 * dt)) };
}

export const positionRelEarth = (id, ms) => (id === 'earth' ? [0, 0, 0] : id === 'moon' ? moonPositionEci(ms) : sub(helioPosition(id, ms), helioPosition('earth', ms)));

// The planet whose system a body belongs to (itself for planets).
export const systemPlanet = (id) => (BODIES[id].parent === 'sun' || id === 'sun' ? id : BODIES[id].parent === 'earth' ? 'earth' : BODIES[id].parent);
