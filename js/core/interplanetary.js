// Interplanetary transfers: launch-window search and departure geometry.

import { MU_EARTH, MU_SUN, R_EARTH } from './constants.js';
import { BODIES, ECLIPTIC_NORTH, stateRelTo } from './bodies.js';
import { solveLambert } from './lambert.js';
import { cross, dot, norm, scale, sub, unit } from './vec.js';

const DAY = 86400e3;
const YEAR_DAYS = 365.256;
const TIME_COST = 0.15; // km/s per year of cruise: prefer quicker trips when delta-v is similar

// Delta-v (km/s) to leave a circular orbit of radius r on a hyperbola with
// excess speed vInf, and to capture from vInf into an orbit rp x ra.
export const escapeDeltaV = (vInf, r, mu = MU_EARTH) => Math.sqrt(vInf * vInf + (2 * mu) / r) - Math.sqrt(mu / r);
export const captureDeltaV = (vInf, rp, ra, mu) =>
  Math.sqrt(vInf * vInf + (2 * mu) / rp) - Math.sqrt(mu * (2 / rp - 2 / (rp + ra)));

// Capture orbit (periapsis, apoapsis radius) used at a planet for a given
// final destination (the planet itself or one of its moons).
export function captureOrbit(planetId, destId) {
  const p = BODIES[planetId];
  const rp = p.radius + p.capture[0];
  if (destId === planetId) return { rp, ra: Math.min(p.radius + p.capture[1], 0.5 * p.soi) };
  const a = BODIES[destId].a;
  return { rp, ra: Math.min(Math.max(2.2 * a, rp * 1.5), 0.4 * p.soi) };
}

// Transfer between Earth and a planet as a Lambert arc around the Sun.
function transfer(planetId, departMs, tofSec) {
  const e = stateRelTo('earth', 'sun', departMs);
  const p = stateRelTo(planetId, 'sun', departMs + tofSec * 1000);
  const sol = solveLambert(e.r, p.r, tofSec, MU_SUN, ECLIPTIC_NORTH);
  if (!sol) return null;
  return { vInfDep: sub(sol.v1, e.v), vInfArr: sub(sol.v2, p.v), v1: sol.v1 };
}

// Search the next synodic period for the departure date and flight time that
// minimise the total delta-v (escape from the parking orbit + capture), with a
// small penalty on long cruises.
export function findTransferWindow(planetId, fromMs, parkingAltKm = 200, destId = planetId) {
  const P = BODIES[planetId];
  const aE = BODIES.earth.planet.el[0], aP = P.planet.el[0];
  const periodP = YEAR_DAYS * aP ** 1.5;
  const synodic = 1 / Math.abs(1 / YEAR_DAYS - 1 / periodP);
  const hohmann = 0.5 * YEAR_DAYS * ((aE + aP) / 2) ** 1.5; // days
  const rPark = R_EARTH + parkingAltKm;
  const cap = captureOrbit(planetId, destId);

  const evaluate = (dep, tofDays) => {
    const t = transfer(planetId, dep, tofDays * 86400);
    if (!t) return null;
    const dvDep = escapeDeltaV(norm(t.vInfDep), rPark);
    const dvCap = captureDeltaV(norm(t.vInfArr), cap.rp, cap.ra, P.mu);
    return { ...t, departMs: dep, tofDays, dvDep, dvCap, cost: dvDep + dvCap + (TIME_COST * tofDays) / YEAR_DAYS };
  };

  let best = null;
  const consider = (dep, tof) => {
    const r = evaluate(dep, tof);
    if (r && (!best || r.cost < best.cost)) best = r;
  };
  const start = fromMs + DAY;
  const span = (synodic + 20) * DAY;
  const depStep = Math.max(1, synodic / 120) * DAY;
  for (let dep = start; dep <= start + span; dep += depStep) {
    for (let k = 0; k <= 15; k++) consider(dep, hohmann * (0.45 + (0.8 * k) / 15));
  }
  if (!best) return null;
  // Refine around the best grid point.
  const d0 = best.departMs, t0 = best.tofDays;
  for (let i = -6; i <= 6; i++) {
    for (let j = -5; j <= 5; j++) {
      const dep = d0 + (i * depStep) / 6;
      if (dep >= start) consider(dep, t0 * (1 + j * 0.01));
    }
  }
  return {
    planetId,
    departMs: best.departMs,
    arriveMs: best.departMs + best.tofDays * DAY,
    tofDays: best.tofDays,
    vInfDep: best.vInfDep,
    vInfArr: best.vInfArr,
    c3: norm(best.vInfDep) ** 2,
    dvDepart: best.dvDep * 1000, // m/s, from the parking orbit
    dvCapture: best.dvCap * 1000,
  };
}

// Where on a circular parking orbit (plane normal h) to fire so that the
// escape hyperbola leaves along vInf: returns the periapsis direction.
export function departurePoint(vInf, h, rPark, mu = MU_EARTH) {
  const hHat = unit(h);
  const vHat = unit(sub(vInf, scale(hHat, dot(vInf, hHat)))); // projected into the orbit plane
  const e = 1 + (rPark * dot(vInf, vInf)) / mu;
  const nuInf = Math.acos(-1 / e);
  return unit(sub(scale(vHat, Math.cos(nuInf)), scale(cross(hHat, vHat), Math.sin(nuInf))));
}

// Parking-orbit plane through the launch site that contains a direction.
export function planeContaining(siteEci, dir) {
  let n = cross(siteEci, dir);
  if (norm(n) < 1e-6 * norm(siteEci) * norm(dir)) n = cross(siteEci, [0, 0, 1]);
  n = unit(n);
  return n[2] < 0 ? scale(n, -1) : n;
}
