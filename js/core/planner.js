// Pre-launch checks: fly the ascent model quickly and see whether the upper
// stage will have enough delta-v left for the rest of the mission.

import { MU_EARTH, R_EARTH } from './constants.js';
import { Ascent } from './ascent.js';
import { R_GEO, lunarPlaneNormal } from './mission.js';

const MOON_DISTANCE = 384400; // km
const TLI_MARGIN = 1.03;      // Lambert arcs cost a little more than an ideal Hohmann
const PLAN_STEP = 0.25;       // s; within ~30 m/s of the full-resolution ascent

// Delta-v (m/s) the upper stage must still deliver after reaching the
// parking orbit: GTO injection for GEO, trans-lunar injection for the Moon.
export function departureDeltaV(targetId, parkingAltKm) {
  const r = R_EARTH + parkingAltKm;
  const vCirc = Math.sqrt(MU_EARTH / r);
  const toApogee = (ra) => Math.sqrt(MU_EARTH * (2 / r - 2 / (r + ra))) - vCirc;
  if (targetId === 'geo') return toApogee(R_GEO) * 1000;
  if (targetId === 'moon') return toApogee(MOON_DISTANCE) * 1000 * TLI_MARGIN;
  return 0;
}

export function assessMission({ vehicle, payload, site, targetId, altitude, inclination, launchMs }) {
  const planeNormal = targetId === 'moon' ? lunarPlaneNormal(site, launchMs) : null;
  const a = new Ascent({ vehicle, payload, site, launchMs, targetAlt: altitude, inclination, planeNormal, stepSize: PLAN_STEP });
  a.advanceTo(3600);
  const reachesOrbit = a.reachedTarget === true;
  const dvLeft = reachesOrbit ? a.remainingDeltaV() : 0;
  const dvNeeded = departureDeltaV(targetId, altitude);
  return { reachesOrbit, dvLeft, dvNeeded, feasible: reachesOrbit && dvLeft >= dvNeeded };
}

// Heaviest payload (kg) for which assessMission() is feasible; 0 if none.
export function maxPayload(opts) {
  const ok = (payload) => assessMission({ ...opts, payload }).feasible;
  if (!ok(0)) return 0;
  let lo = 0;
  let hi = Math.max(500, opts.vehicle.payloadLEO * 1.3);
  for (let k = 0; k < 6 && ok(hi); k++) { lo = hi; hi *= 1.5; }
  while (hi - lo > Math.max(10, hi * 0.005)) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) lo = mid; else hi = mid;
  }
  return lo;
}
