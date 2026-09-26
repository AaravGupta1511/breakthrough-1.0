// Lambert's problem: find the orbit connecting two positions in a given time.
// Universal-variable formulation (Curtis, algorithm 5.2) solved by bisection,
// which is slower than Newton but never diverges.

import { MU_EARTH } from './constants.js';
import { add, cross, dot, norm, scale, sub } from './vec.js';
import { stumpffC, stumpffS } from './orbits.js';

// r1, r2: position vectors (km); tof: seconds; refNormal: angular-momentum
// direction to prefer (picks the short or long way round). Returns
// { v1, v2 } or null if no single-revolution solution exists.
export function solveLambert(r1, r2, tof, mu = MU_EARTH, refNormal = [0, 0, 1]) {
  const r1m = norm(r1), r2m = norm(r2);
  const c12 = cross(r1, r2);
  let cosDth = dot(r1, r2) / (r1m * r2m);
  cosDth = Math.max(-1, Math.min(1, cosDth));
  let dth = Math.acos(cosDth);
  if (dot(c12, refNormal) < 0) dth = 2 * Math.PI - dth;
  if (Math.abs(Math.sin(dth)) < 1e-6) return null; // 0 or 180 deg: plane undefined

  const A = Math.sin(dth) * Math.sqrt((r1m * r2m) / (1 - Math.cos(dth)));
  const sqmu = Math.sqrt(mu);
  const y = (z) => r1m + r2m + (A * (z * stumpffS(z) - 1)) / Math.sqrt(stumpffC(z));
  const F = (z) => {
    const yz = y(z);
    if (yz < 0) return -Infinity;
    return (yz / stumpffC(z)) ** 1.5 * stumpffS(z) + A * Math.sqrt(yz) - sqmu * tof;
  };

  let lo = -4 * Math.PI * Math.PI, hi = 4 * Math.PI * Math.PI - 1e-6;
  if (F(hi) < 0) return null;
  // Widen the hyperbolic end if even the lowest bound is too slow.
  let guard = 0;
  while (F(lo) > 0 && guard++ < 50) lo *= 2;
  let z = 0;
  for (let k = 0; k < 200; k++) {
    z = 0.5 * (lo + hi);
    const f = F(z);
    if (f > 0) hi = z; else lo = z;
    if (hi - lo < 1e-10) break;
  }
  const yz = y(z);
  if (!(yz > 0)) return null;
  const f = 1 - yz / r1m;
  const g = A * Math.sqrt(yz / mu);
  const gdot = 1 - yz / r2m;
  const v1 = scale(sub(r2, scale(r1, f)), 1 / g);
  const v2 = scale(sub(scale(r2, gdot), r1), 1 / g);
  if (!Number.isFinite(v1[0]) || !Number.isFinite(v2[0])) return null;
  return { v1, v2, dth };
}

// Helper: delta-v of departing from state (r, v) on a Lambert arc to target.
export function lambertDeltaV(r, v, target, tof, mu = MU_EARTH) {
  const sol = solveLambert(r, target, tof, mu, cross(r, v));
  if (!sol) return null;
  const dv = sub(sol.v1, v);
  return { ...sol, dv, dvMag: norm(dv), vDepart: add(v, dv) };
}
