// Two-body orbital mechanics: Kepler propagation, universal-variable
// propagation, state <-> element conversion and orbit sampling.

import { J2_EARTH, MU_EARTH, R_EARTH } from './constants.js';
import { add, cross, dot, norm, scale } from './vec.js';

const TWO_PI = 2 * Math.PI;

export function solveKepler(M, e) {
  if (e < 1e-8) return M;
  let E = e < 0.8 ? M : Math.PI;
  for (let k = 0; k < 30; k++) {
    const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-11) break;
  }
  return E;
}

// Stumpff functions with series expansion near zero.
export function stumpffS(z) {
  if (z > 1e-3) { const s = Math.sqrt(z); return (s - Math.sin(s)) / (s * s * s); }
  if (z < -1e-3) { const s = Math.sqrt(-z); return (Math.sinh(s) - s) / (s * s * s); }
  return 1 / 6 - z / 120 + (z * z) / 5040;
}
export function stumpffC(z) {
  if (z > 1e-3) return (1 - Math.cos(Math.sqrt(z))) / z;
  if (z < -1e-3) return (Math.cosh(Math.sqrt(-z)) - 1) / -z;
  return 0.5 - z / 24 + (z * z) / 720;
}

// Propagate a state vector by dt seconds under two-body gravity (any conic).
// Curtis, "Orbital Mechanics for Engineering Students", algorithms 3.3/3.4.
export function propagate(r0, v0, dt, mu = MU_EARTH) {
  const r0m = norm(r0);
  const v0m = norm(v0);
  const vr0 = dot(r0, v0) / r0m;
  const alpha = 2 / r0m - (v0m * v0m) / mu;
  const sqmu = Math.sqrt(mu);

  // Remove whole revolutions for bound orbits to keep Newton well conditioned.
  if (alpha > 1e-12) {
    const period = TWO_PI / Math.sqrt(mu * alpha * alpha * alpha);
    dt = dt % period;
  }
  if (dt === 0) return { r: [...r0], v: [...v0] };

  let chi = sqmu * Math.abs(alpha) * dt;
  if (alpha <= 1e-12) chi = Math.sign(dt) * Math.sqrt(Math.abs(dt) * sqmu / r0m) * 2;
  for (let k = 0; k < 60; k++) {
    const z = alpha * chi * chi;
    const C = stumpffC(z), S = stumpffS(z);
    const F = (r0m * vr0 / sqmu) * chi * chi * C + (1 - alpha * r0m) * chi * chi * chi * S + r0m * chi - sqmu * dt;
    const dF = (r0m * vr0 / sqmu) * chi * (1 - z * S) + (1 - alpha * r0m) * chi * chi * C + r0m;
    const step = F / dF;
    chi -= step;
    if (Math.abs(step) < 1e-9 * Math.max(1, Math.abs(chi))) break;
  }
  const z = alpha * chi * chi;
  const C = stumpffC(z), S = stumpffS(z);
  const f = 1 - (chi * chi / r0m) * C;
  const g = dt - (chi * chi * chi / sqmu) * S;
  const r = add(scale(r0, f), scale(v0, g));
  const rm = norm(r);
  const fdot = (sqmu / (rm * r0m)) * (alpha * chi * chi * chi * S - chi);
  const gdot = 1 - (chi * chi / rm) * C;
  const v = add(scale(r0, fdot), scale(v0, gdot));
  return { r, v };
}

// Classical orbital elements from a state vector (Curtis algorithm 4.2).
export function stateToElements(r, v, mu = MU_EARTH) {
  const rm = norm(r);
  const vm = norm(v);
  const vr = dot(r, v) / rm;
  const h = cross(r, v);
  const hm = norm(h);
  const i = Math.acos(Math.max(-1, Math.min(1, h[2] / hm)));
  const N = [-h[1], h[0], 0];
  const Nm = norm(N);
  let raan = 0;
  if (Nm > 1e-9) {
    raan = Math.acos(Math.max(-1, Math.min(1, N[0] / Nm)));
    if (N[1] < 0) raan = TWO_PI - raan;
  }
  const evec = scale(add(scale(r, vm * vm - mu / rm), scale(v, -rm * vr)), 1 / mu);
  const e = norm(evec);
  let argp = 0;
  if (e > 1e-7) {
    if (Nm > 1e-9) {
      argp = Math.acos(Math.max(-1, Math.min(1, dot(N, evec) / (Nm * e))));
      if (evec[2] < 0) argp = TWO_PI - argp;
    } else {
      argp = Math.atan2(evec[1], evec[0]);
      if (h[2] < 0) argp = TWO_PI - argp;
    }
  }
  let nu;
  if (e > 1e-7) {
    nu = Math.acos(Math.max(-1, Math.min(1, dot(evec, r) / (e * rm))));
    if (vr < 0) nu = TWO_PI - nu;
  } else if (Nm > 1e-9) {
    // Circular: argument of latitude, measured from the ascending node.
    const n = scale(N, 1 / Nm);
    nu = Math.atan2(dot(r, cross(scale(h, 1 / hm), n)), dot(r, n));
  } else {
    nu = Math.atan2(r[1], r[0]); // circular equatorial: true longitude
  }
  if (nu < 0) nu += TWO_PI;
  const p = (hm * hm) / mu;
  const energy = (vm * vm) / 2 - mu / rm;
  const a = Math.abs(energy) > 1e-12 ? -mu / (2 * energy) : Infinity;
  const rp = p / (1 + e);
  const ra = e < 1 ? p / (1 - e) : Infinity;
  const period = e < 1 ? TWO_PI * Math.sqrt((a * a * a) / mu) : Infinity;
  return { a, e, i, raan, argp, nu, h: hm, p, rp, ra, period, energy };
}

// State vector from classical elements with mean anomaly M (radians).
export function elementsToState({ a, e, i, raan, argp, M }, mu = MU_EARTH) {
  const E = solveKepler(M, e);
  const n = Math.sqrt(mu / (a * a * a));
  const b = a * Math.sqrt(1 - e * e);
  const denom = 1 - e * Math.cos(E);
  const x = a * (Math.cos(E) - e), y = b * Math.sin(E);
  const vx = (-a * n * Math.sin(E)) / denom, vy = (b * n * Math.cos(E)) / denom;
  const { P, Q } = perifocalBasis(i, raan, argp);
  return {
    r: [P[0] * x + Q[0] * y, P[1] * x + Q[1] * y, P[2] * x + Q[2] * y],
    v: [P[0] * vx + Q[0] * vy, P[1] * vx + Q[1] * vy, P[2] * vx + Q[2] * vy],
  };
}

export function perifocalBasis(i, raan, argp) {
  const cO = Math.cos(raan), sO = Math.sin(raan);
  const ci = Math.cos(i), si = Math.sin(i);
  const cw = Math.cos(argp), sw = Math.sin(argp);
  return {
    P: [cO * cw - sO * sw * ci, sO * cw + cO * sw * ci, sw * si],
    Q: [-cO * sw - sO * cw * ci, -sO * sw + cO * cw * ci, cw * si],
  };
}

// A catalogue object on a fixed Keplerian orbit with J2 secular drift of the
// node and perigee (so sun-synchronous orbits really are sun-synchronous).
export class KeplerOrbit {
  constructor({ a, e = 0, i, raan, argp = 0, M0 = 0 }, epochMs, { mu = MU_EARTH, j2 = true } = {}) {
    this.a = a; this.e = e; this.i = i;
    this.raan0 = raan; this.argp0 = argp; this.M0 = M0;
    this.epoch = epochMs;
    this.mu = mu;
    this.n = Math.sqrt(mu / (a * a * a));
    this.b = a * Math.sqrt(1 - e * e);
    this.period = TWO_PI / this.n;
    if (j2) {
      const p = a * (1 - e * e);
      const k = 1.5 * this.n * J2_EARTH * (R_EARTH / p) ** 2;
      this.raanDot = -k * Math.cos(i);
      this.argpDot = k * (2 - 2.5 * Math.sin(i) ** 2);
    } else {
      this.raanDot = 0; this.argpDot = 0;
    }
  }

  basisAt(ms) {
    const t = (ms - this.epoch) / 1000;
    return perifocalBasis(this.i, this.raan0 + this.raanDot * t, this.argp0 + this.argpDot * t);
  }

  // Writes the ECI position (km) into out[o..o+2]. Returns out.
  positionAt(ms, out = [0, 0, 0], o = 0) {
    const t = (ms - this.epoch) / 1000;
    const { P, Q } = perifocalBasis(this.i, this.raan0 + this.raanDot * t, this.argp0 + this.argpDot * t);
    const E = solveKepler((this.M0 + this.n * t) % TWO_PI, this.e);
    const x = this.a * (Math.cos(E) - this.e), y = this.b * Math.sin(E);
    out[o] = P[0] * x + Q[0] * y;
    out[o + 1] = P[1] * x + Q[1] * y;
    out[o + 2] = P[2] * x + Q[2] * y;
    return out;
  }

  stateAt(ms) {
    const t = (ms - this.epoch) / 1000;
    return elementsToState({
      a: this.a, e: this.e, i: this.i,
      raan: this.raan0 + this.raanDot * t,
      argp: this.argp0 + this.argpDot * t,
      M: (this.M0 + this.n * t) % TWO_PI,
    }, this.mu);
  }

  pathAt(ms, segments = 180) {
    const { P, Q } = this.basisAt(ms);
    const pts = [];
    for (let k = 0; k <= segments; k++) {
      const E = (k / segments) * TWO_PI;
      const x = this.a * (Math.cos(E) - this.e), y = this.b * Math.sin(E);
      pts.push([P[0] * x + Q[0] * y, P[1] * x + Q[1] * y, P[2] * x + Q[2] * y]);
    }
    return pts;
  }
}

// Sample the conic through (r, v) for drawing. Closed orbits give one full
// revolution; open ones are sampled from the current point outwards.
export function sampleConic(r, v, mu = MU_EARTH, segments = 240, maxRadius = Infinity, maxTime = Infinity) {
  const el = stateToElements(r, v, mu);
  const pts = [];
  if (el.e < 1 && el.ra < maxRadius) {
    const dt = el.period / segments;
    for (let k = 0; k <= segments; k++) pts.push(propagate(r, v, k * dt, mu).r);
    return pts;
  }
  // Open or very large: march forward in time until leaving maxRadius.
  const span = Math.min(maxTime, el.e < 1 ? el.period : 20 * 86400);
  const dt = span / segments;
  for (let k = 0; k <= segments; k++) {
    const p = propagate(r, v, k * dt, mu).r;
    pts.push(p);
    if (norm(p) > maxRadius) break;
  }
  return pts;
}

export const circularSpeed = (radius, mu = MU_EARTH) => Math.sqrt(mu / radius);

// Sun-synchronous inclination for a circular orbit at the given altitude.
export function sunSyncInclination(altKm) {
  const a = R_EARTH + altKm;
  const n = Math.sqrt(MU_EARTH / (a * a * a));
  const needed = (2 * Math.PI) / (365.2422 * 86400); // rad/s eastward
  const cosI = -needed / (1.5 * n * J2_EARTH * (R_EARTH / a) ** 2);
  return Math.acos(Math.max(-1, Math.min(1, cosI)));
}
