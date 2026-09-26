// Powered ascent simulation, integrated in 3D (Earth-centred inertial frame).
//
// The equations of motion (gravity, thrust, drag in a co-rotating
// atmosphere, mass flow, staging) are integrated with RK4. Guidance:
//   1. vertical rise to clear the tower,
//   2. a pitch kick along the launch azimuth, then a gravity turn (thrust
//      along the airflow, zero angle of attack) through the thick atmosphere,
//   3. closed-loop guidance above ~40 km: each step it solves for a linear
//      radial-acceleration profile that arrives at the insertion radius with
//      zero vertical speed; the horizontal thrust is yawed to null the
//      velocity across the target plane,
//   4. engine cutoff once orbital energy matches the insertion orbit.
//
// Range safety: every launch site only allows certain launch azimuths (so
// spent stages and failures fall into the sea, not on towns or neighbours).
// When the orbit's inclination is fixed (sun-synchronous, polar, ISS) but its
// natural azimuth is forbidden, the rocket launches along the edge of the
// corridor and turns towards the target plane during the upper-stage burns:
// the "dogleg" PSLV flies from Sriharikota, heading south-east over the Bay
// of Bengal before swinging south to avoid Sri Lanka.
//
// High targets are reached like real missions do: insert into a low
// perigee x target-apogee ellipse, then circularise at apogee (mission.js).

import { DEG, G0, MU_EARTH, OMEGA_EARTH, R_EARTH } from './constants.js';
import { stateToElements } from './orbits.js';
import { eciToGeo, geoToEci } from './time.js';
import { add, cross, dot, norm, scale, sub, unit } from './vec.js';

const MU = MU_EARTH * 1e9;   // m^3/s^2
const RE = R_EARTH * 1000;   // m
const STEP = 0.1;            // s
const STAGING_GAP = 3;       // s of coast between stages
const MAX_G = 4.5;           // liquid stages throttle to stay under this
const MIN_THROTTLE = 0.4;
const CLOSED_LOOP_ALT = 40000; // m
const DOGLEG_ALT = 60000;      // m; the yaw turn starts in the upper-stage burns
const FAIRING_ALT = 110000;    // m
const MAX_YAW = 60 * DEG;      // largest sideways thrust angle
const DOGLEG_TAU = 250;        // s; longest time constant for removing cross-plane velocity in a dogleg
const ATT_RATE = 2 * DEG;      // rad/s, attitude rate limit
export const MAX_DIRECT_INSERTION_ALT = 250; // km; higher targets use a transfer ellipse
const INSERTION_PERIGEE_ALT = 200;           // km

// Atmosphere: simple exponential model.
const density = (h) => (h > 150000 ? 0 : 1.225 * Math.exp(-h / 8500));
const pressureRatio = (h) => Math.exp(-h / 8500);

// ------------------------------------------------------------ range safety

const norm360 = (a) => ((a % 360) + 360) % 360;
const angDist = (a, b) => { const d = Math.abs(norm360(a) - norm360(b)); return Math.min(d, 360 - d); };
const corridorsOf = (site) => site.corridors || [[0, 360]];
export const azimuthAllowed = (site, az) => corridorsOf(site).some(([a, b]) => norm360(az) >= a - 1e-9 && norm360(az) <= b + 1e-9);

// Closest allowed azimuth to `az` (itself if allowed).
function nearestAllowed(site, az) {
  if (azimuthAllowed(site, az)) return norm360(az);
  let best = null;
  for (const [a, b] of corridorsOf(site)) {
    for (const edge of [a, b]) if (best == null || angDist(az, edge) < angDist(az, best)) best = norm360(edge);
  }
  return best;
}

// Inclination of the orbit launched due along azimuth `azDeg` from latitude `latDeg`.
export const inclinationFor = (latDeg, azDeg) => Math.acos(Math.max(-1, Math.min(1, Math.cos(latDeg * DEG) * Math.sin(azDeg * DEG)))) / DEG;

// The two launch azimuths that reach inclination `incDeg` directly, preferred first.
function azimuthCandidates(latDeg, incDeg) {
  const s = Math.max(-1, Math.min(1, Math.cos(incDeg * DEG) / Math.cos(latDeg * DEG)));
  const b1 = norm360(Math.asin(s) / DEG);   // north-east, or north-west if retrograde
  const b2 = norm360(180 - Math.asin(s) / DEG); // south-east, or south-west if retrograde
  const southFirst = incDeg >= 90 || latDeg < 0;
  return southFirst ? [{ az: b2, branch: 2 }, { az: b1, branch: 1 }] : [{ az: b1, branch: 1 }, { az: b2, branch: 2 }];
}

// Lowest inclination a site can launch into without a dogleg.
export function lowestInclination(site) {
  let best = 90;
  for (const [a, b] of corridorsOf(site)) for (let az = a; az <= b; az += 0.25) best = Math.min(best, inclinationFor(site.lat, az));
  return Math.max(Math.abs(site.lat), best);
}

export function corridorText(site) {
  return corridorsOf(site).map(([a, b]) => `${a}°–${b}°`).join(' or ').replace('349°–360° or 0°–93°', '349°–93°');
}

// Decide how to fly: launch azimuth, whether a dogleg is needed, and the
// inclination that results. `mandatory`: the inclination must be met (dogleg
// if needed); otherwise the nearest allowed azimuth sets a new inclination.
export function planLaunch(site, incDeg, { mandatory = true, planeNormal = null, launchMs = Date.now() } = {}) {
  const up = unit(geoToEci(site.lat, site.lon, 1, launchMs));
  const east = unit(cross([0, 0, 1], up));
  const north = cross(up, east);
  const headingAt = (azDeg) => add(scale(north, Math.cos(azDeg * DEG)), scale(east, Math.sin(azDeg * DEG)));
  const minInc = Math.abs(site.lat);

  if (planeNormal) {
    const w = unit(cross(planeNormal, up));
    const az = norm360(Math.atan2(dot(w, east), dot(w, north)) / DEG);
    const launchAz = nearestAllowed(site, az);
    const n = launchAz === az ? planeNormal : unit(cross(up, headingAt(launchAz)));
    return { launchAz, targetAz: launchAz, wantedAz: az, inclination: Math.acos(Math.max(-1, Math.min(1, n[2]))) / DEG, planeNormal: n, dogleg: false, adjusted: launchAz !== az, clamped: false };
  }

  let inc = incDeg, clamped = false;
  if (inc < minInc) { clamped = inc < minInc - 0.05; inc = minInc; }
  if (inc > 180 - minInc) { clamped = inc > 180 - minInc + 0.05; inc = 180 - minInc; }
  const cands = azimuthCandidates(site.lat, inc);
  const direct = cands.find((c) => azimuthAllowed(site, c.az));
  if (direct) return { launchAz: direct.az, targetAz: direct.az, inclination: inc, branch: direct.branch, dogleg: false, adjusted: false, clamped };

  // Neither direct azimuth is allowed: fly along the nearest corridor edge.
  const best = cands.map((c) => ({ ...c, edge: nearestAllowed(site, c.az) })).sort((x, y) => angDist(x.az, x.edge) - angDist(y.az, y.edge))[0];
  if (!mandatory) {
    return { launchAz: best.edge, targetAz: best.edge, wantedAz: best.az, inclination: inclinationFor(site.lat, best.edge), dogleg: false, adjusted: true, clamped };
  }
  return { launchAz: best.edge, targetAz: best.az, inclination: inc, branch: best.branch, dogleg: true, adjusted: false, clamped };
}

// ------------------------------------------------------------ ascent

export class Ascent {
  // planeNormal (optional, ECI unit vector) fixes the exact orbital plane,
  // e.g. one containing the Moon's direction; otherwise `inclination` is
  // flown, with a dogleg if range safety requires one and
  // `inclinationMandatory` is set. stepSize: integration step in seconds (the
  // mission planner uses a coarser step for quick what-if runs).
  constructor({ vehicle, payload, site, launchMs, targetAlt, inclination, planeNormal = null, inclinationMandatory = true, stepSize = STEP }) {
    this.stepSize = stepSize;
    this.vehicle = vehicle;
    this.payload = payload;
    this.site = site;
    this.launchMs = launchMs;
    // Insertion orbit: circular at the target if it is low, otherwise an
    // ellipse from a 200 km perigee up to the target altitude.
    const insAlt = targetAlt <= MAX_DIRECT_INSERTION_ALT ? targetAlt : INSERTION_PERIGEE_ALT;
    this.insertRadius = RE + insAlt * 1000;
    this.apoRadius = RE + Math.max(targetAlt, insAlt) * 1000;
    this.insertSpeed = Math.sqrt((2 * MU * this.apoRadius) / (this.insertRadius * (this.insertRadius + this.apoRadius)));
    this.insertEnergy = -MU / (this.insertRadius + this.apoRadius);

    // Flight plan within the site's range-safety corridor.
    const plan = planLaunch(site, inclination, { mandatory: inclinationMandatory, planeNormal, launchMs });
    this.plan = plan;
    this.azimuth = plan.launchAz * DEG;
    this.inclination = plan.inclination;
    this.inclinationClamped = plan.clamped;
    this.dogleg = plan.dogleg;

    const up = unit(geoToEci(site.lat, site.lon, 1, launchMs));
    const east = unit(cross([0, 0, 1], up));
    const north = cross(up, east);
    const launchHeading = add(scale(north, Math.cos(this.azimuth)), scale(east, Math.sin(this.azimuth)));
    this.launchNormal = unit(cross(up, launchHeading)); // plane flown before any dogleg
    // Target: a specific plane (Moon, planets: steer into it), or just an
    // inclination (steer to the heading that gives it at the current latitude,
    // which stays right even after the vehicle drifts sideways).
    this.targetNormal = plan.planeNormal || null;
    this.branch = plan.branch;

    // State (m, m/s): on the pad, moving with the Earth's rotation.
    this.r = scale(up, RE);
    this.v = [-OMEGA_EARTH * this.r[1], OMEGA_EARTH * this.r[0], 0];
    this.t = 0;

    this.phase = 0;
    this.propLeft = vehicle.phases[0].prop;
    this.fairingOn = vehicle.fairing > 0;
    this.mass = payload + vehicle.fairing + vehicle.phases.reduce((s, p) => s + p.dry + p.prop, 0);
    this.area = Math.PI * (vehicle.diameter / 2) ** 2;
    this.cd = 0.35;

    this.engineOn = true;
    this.gapLeft = 0;
    this.mode = 'vertical';
    this.pitch = 90 * DEG;       // thrust angle above local horizontal
    this.yaw = 0;                // thrust angle across the flight direction
    this.steering = false;       // plane/heading steering active
    this.throttle = 1;
    this.q = 0; this.qMax = 0; this.maxQLogged = false;
    this.accel = 0;
    this.dvSpent = 0;
    this.karman = false;
    this.status = 'ascent';      // ascent | inserted | ballistic | failed
    this.message = '';
    this.events = [];

    const twr = this.thrustAt(0) / (this.mass * G0);
    this.liftoffTWR = twr;
    this.kick = Math.min(7, Math.max(2.5, 2.5 + (twr - 1.15) * 10)) * DEG;
    if (twr < 1) {
      this.status = 'failed';
      this.message = `Thrust-to-weight ${twr.toFixed(2)} < 1: too heavy to lift off.`;
      this.log('Launch scrubbed', this.message);
    } else {
      this.log('Liftoff', `${vehicle.name} clears the tower (TWR ${twr.toFixed(2)}), heading ${plan.launchAz.toFixed(0)}°`);
    }
  }

  log(name, detail = '') { this.events.push({ t: this.t, name, detail }); }

  get altitude() { return norm(this.r) - RE; }

  thrustAt(h) {
    const p = this.vehicle.phases[this.phase];
    if (!p) return 0;
    const pr = pressureRatio(h);
    return p.thrustVac - (p.thrustVac - p.thrustSL) * pr;
  }

  ispAt(h) {
    const p = this.vehicle.phases[this.phase];
    const pr = pressureRatio(h);
    return p.ispVac - (p.ispVac - (p.ispSL || p.ispVac)) * pr;
  }

  // Velocity relative to the co-rotating atmosphere.
  static relVelocity(r, v) {
    return [v[0] + OMEGA_EARTH * r[1], v[1] - OMEGA_EARTH * r[0], v[2]];
  }

  // Unit horizontal direction the vehicle should fly along at position rHat.
  desiredHeading(rHat) {
    if (!this.steering) return unit(cross(this.launchNormal, rHat));
    if (this.targetNormal) return unit(cross(this.targetNormal, rHat));
    // Heading that gives the target inclination at the current latitude.
    const east = unit(cross([0, 0, 1], rHat));
    const north = cross(rHat, east);
    const lat = Math.asin(Math.max(-1, Math.min(1, rHat[2])));
    const s = Math.max(-1, Math.min(1, Math.cos(this.inclination * DEG) / Math.cos(lat)));
    let A = Math.asin(s);
    if (this.branch === 2) A = Math.PI - A;
    return add(scale(north, Math.cos(A)), scale(east, Math.sin(A)));
  }

  // Burn time needed for a given delta-v with the stages still available.
  timeToGo(dvNeed) {
    let t = 0, m = this.mass, dv = dvNeed;
    const phases = this.vehicle.phases;
    for (let k = this.phase; k < phases.length; k++) {
      const p = phases[k];
      const prop = k === this.phase ? this.propLeft : p.prop;
      const ve = p.ispVac * G0;
      const mdot = p.thrustVac / ve;
      const avail = ve * Math.log(m / (m - prop));
      if (avail >= dv) return t + (m - m / Math.exp(dv / ve)) / mdot;
      dv -= avail;
      t += prop / mdot + STAGING_GAP;
      m -= prop + p.dry;
    }
    return t + 60;
  }

  // Thrust direction (unit ECI vector) for this step.
  guidance(h, aThrust, dt) {
    const rm = norm(this.r);
    const rHat = scale(this.r, 1 / rm);
    const vr = dot(this.v, rHat);
    const vhVec = sub(this.v, scale(rHat, vr));
    const vh = norm(vhVec);
    const vRel = Ascent.relVelocity(this.r, this.v);
    let pitchCmd = this.pitch;
    let yawCmd = 0;

    if (this.mode === 'vertical') {
      pitchCmd = 90 * DEG;
      if (this.t > 5 && h > 100 && norm(vRel) > 50) {
        this.mode = 'kick';
        this.kickStart = this.t;
        this.log('Pitch kick', `Pitching ${(this.kick / DEG).toFixed(1)}° towards ${this.plan.launchAz.toFixed(0)}°`);
      }
    } else if (this.mode === 'kick') {
      const f = Math.min(1, (this.t - this.kickStart) / 8);
      pitchCmd = 90 * DEG - this.kick * f;
      const fpa = Math.asin(Math.max(-1, Math.min(1, dot(vRel, rHat) / Math.max(norm(vRel), 1e-6))));
      if (f >= 1 && fpa <= pitchCmd + 0.2 * DEG) this.mode = 'gravity';
    } else if (this.mode === 'gravity') {
      // Zero angle of attack: thrust along the airflow.
      pitchCmd = Math.asin(Math.max(-1, Math.min(1, dot(vRel, rHat) / Math.max(norm(vRel), 1e-6))));
      if (h > CLOSED_LOOP_ALT) {
        this.mode = 'closed';
        this.log('Closed-loop guidance', 'Steering to the target orbit');
      }
    }

    // Plane steering: from closed-loop guidance, or for a dogleg once the
    // vehicle is high and far enough down the safe corridor.
    if (this.mode === 'closed' && !this.steering && (!this.dogleg || (h > DOGLEG_ALT && this.downrange() >= (this.site.doglegAfterKm || 0)))) {
      this.steering = true;
      if (this.dogleg) this.log('Dogleg manoeuvre', `Yawing from ${this.plan.launchAz.toFixed(0)}° towards ${this.plan.targetAz.toFixed(0)}° to reach a ${this.inclination.toFixed(1)}° orbit`);
    }

    const heading = this.desiredHeading(rHat);
    const across = cross(rHat, heading); // horizontal, to the left of the heading
    const va = dot(vhVec, heading);
    const vc = dot(vhVec, across);

    if (this.mode === 'closed' && aThrust > 0) {
      const rt = this.insertRadius;
      const vt = this.insertSpeed;
      const T = this.timeToGo(Math.hypot(vt - va, vc, vr));
      if (T > 6) {
        const dr = rt - rm - vr * T;
        const B = -(6 * vr * T + 12 * dr) / (T * T * T);
        const A = (-vr - (B * T * T) / 2) / T;
        const gEff = MU / (rm * rm) - (vh * vh) / rm;
        pitchCmd = Math.asin(Math.max(-0.5, Math.min(0.99, (A + gEff) / aThrust)));
      }
      // Remove the velocity across the target plane over the remaining burn.
      if (this.steering) {
        const aH = aThrust * Math.cos(this.pitch);
        let aC;
        if (this.targetNormal) {
          // A specific plane: null both the offset from it and the velocity
          // across it by the end of the burn (linear acceleration profile).
          const Tc = Math.max(T, 20);
          const d = dot(this.r, this.targetNormal);
          const w = dot(this.v, this.targetNormal);
          const B = (6 * w * Tc + 12 * d) / (Tc * Tc * Tc);
          aC = ((-w - (B * Tc * Tc) / 2) / Tc) * Math.sign(dot(across, this.targetNormal) || 1);
        } else {
          // An inclination: spread the correction over the remaining burn
          // (cheapest), but finish a dogleg turn within a few minutes.
          const tau = Math.max(Math.min(T, this.dogleg ? DOGLEG_TAU : Infinity), 20);
          aC = -vc / tau;
        }
        yawCmd = Math.asin(Math.max(-Math.sin(MAX_YAW), Math.min(Math.sin(MAX_YAW), aC / Math.max(aH, 1e-6))));
      }
      if (this.dogleg && this.steering && !this.doglegDone && Math.abs(vc) < 20 && this.t > 1) {
        this.doglegDone = true;
        this.log('Dogleg complete', `Now flying in the ${this.inclination.toFixed(1)}° plane`);
      }
    }

    // Rate-limit the attitude.
    const maxStep = ATT_RATE * dt;
    this.pitch += Math.max(-maxStep, Math.min(maxStep, pitchCmd - this.pitch));
    this.yaw += Math.max(-maxStep, Math.min(maxStep, yawCmd - this.yaw));

    if (this.mode === 'gravity' || this.mode === 'kick' || this.mode === 'vertical') {
      // Before closed-loop guidance, the horizontal part follows the airflow
      // (or the launch azimuth until the vehicle is moving).
      const relH = sub(vRel, scale(rHat, dot(vRel, rHat)));
      const hDir = this.mode === 'gravity' && norm(relH) > 1 ? unit(relH) : heading;
      return add(scale(rHat, Math.sin(this.pitch)), scale(hDir, Math.cos(this.pitch)));
    }
    const hDir = add(scale(heading, Math.cos(this.yaw)), scale(across, Math.sin(this.yaw)));
    return add(scale(rHat, Math.sin(this.pitch)), scale(hDir, Math.cos(this.pitch)));
  }

  // Acceleration at a state (without changing it).
  accelAt(r, v, thrustAcc, dir) {
    const rm = norm(r);
    const a = scale(r, -MU / (rm * rm * rm));
    const rho = density(rm - RE);
    if (rho > 0) {
      const vRel = Ascent.relVelocity(r, v);
      const k = (0.5 * rho * norm(vRel) * this.cd * this.area) / this.mass;
      a[0] -= k * vRel[0]; a[1] -= k * vRel[1]; a[2] -= k * vRel[2];
    }
    if (thrustAcc > 0) { a[0] += thrustAcc * dir[0]; a[1] += thrustAcc * dir[1]; a[2] += thrustAcc * dir[2]; }
    return a;
  }

  step(dt) {
    const h = this.altitude;
    const phases = this.vehicle.phases;
    let thrust = 0, mdot = 0;

    if (this.gapLeft > 0) {
      this.gapLeft -= dt;
    } else if (this.engineOn && this.phase < phases.length) {
      const p = phases[this.phase];
      thrust = this.thrustAt(h);
      this.throttle = 1;
      if (!p.solid && thrust / this.mass > MAX_G * G0) {
        this.throttle = Math.max(MIN_THROTTLE, (MAX_G * G0 * this.mass) / thrust);
        thrust *= this.throttle;
      }
      mdot = thrust / (this.ispAt(h) * G0);
    }
    const aT = thrust / this.mass;
    const dir = this.guidance(h, aT, dt);

    // RK4 on position/velocity with thrust direction and mass frozen for the step.
    const deriv = (r, v) => [v, this.accelAt(r, v, aT, dir)];
    const [k1r, k1v] = deriv(this.r, this.v);
    const [k2r, k2v] = deriv(add(this.r, scale(k1r, dt / 2)), add(this.v, scale(k1v, dt / 2)));
    const [k3r, k3v] = deriv(add(this.r, scale(k2r, dt / 2)), add(this.v, scale(k2v, dt / 2)));
    const [k4r, k4v] = deriv(add(this.r, scale(k3r, dt)), add(this.v, scale(k3v, dt)));
    this.r = add(this.r, scale(add(add(k1r, scale(k2r, 2)), add(scale(k3r, 2), k4r)), dt / 6));
    this.v = add(this.v, scale(add(add(k1v, scale(k2v, 2)), add(scale(k3v, 2), k4v)), dt / 6));
    this.t += dt;
    this.accel = aT;
    this.dvSpent += aT * dt;

    // Mass flow and staging.
    if (mdot > 0) {
      const used = Math.min(this.propLeft, mdot * dt);
      this.propLeft -= used;
      this.mass -= used;
      if (this.propLeft <= 1e-6) this.stage();
    }

    const hNew = this.altitude;
    const vRel = Ascent.relVelocity(this.r, this.v);
    this.q = 0.5 * density(hNew) * dot(vRel, vRel);
    if (this.q > this.qMax) this.qMax = this.q;
    else if (!this.maxQLogged && this.qMax > 3000 && this.q < 0.97 * this.qMax) {
      this.maxQLogged = true;
      this.log('Max-Q', `Peak aerodynamic pressure ${(this.qMax / 1000).toFixed(1)} kPa`);
    }
    if (!this.karman && hNew > 100000) { this.karman = true; this.log('Kármán line', 'Crossed 100 km: officially in space'); }
    if (this.fairingOn && hNew > FAIRING_ALT) {
      this.fairingOn = false;
      this.mass -= this.vehicle.fairing;
      this.log('Fairing jettison', 'Payload fairing halves separate');
    }

    if (hNew < -1 && this.t > 1) {
      this.status = 'failed';
      this.message = 'Vehicle impacted the surface.';
      this.log('Impact', this.message);
      return;
    }

    if (this.status === 'ascent' && this.engineOn) {
      const energy = dot(this.v, this.v) / 2 - MU / norm(this.r);
      if (energy >= this.insertEnergy && this.mode === 'closed') this.cutoff();
    }
  }

  stage() {
    const phases = this.vehicle.phases;
    const p = phases[this.phase];
    this.mass -= p.dry;
    this.log(p.sep, `${p.name} spent`);
    this.phase++;
    if (this.phase < phases.length) {
      this.propLeft = phases[this.phase].prop;
      this.gapLeft = STAGING_GAP;
      this.log('Ignition', phases[this.phase].name);
    } else {
      this.engineOn = false;
      this.propLeft = 0;
      this.outOfPropellant();
    }
  }

  outOfPropellant() {
    const el = this.orbit();
    if (el.periapsisAlt > 150) {
      this.status = 'inserted';
      this.message = `Propellant depleted before target; settled into a ${el.periapsisAlt.toFixed(0)} × ${el.apoapsisAlt.toFixed(0)} km orbit.`;
      this.log('Orbit insertion', this.message);
    } else {
      this.status = 'ballistic';
      this.message = 'Propellant depleted before reaching orbital speed: suborbital trajectory.';
      this.log('Propellant depleted', this.message);
    }
  }

  cutoff() {
    this.engineOn = false;
    this.status = 'inserted';
    const el = this.orbit();
    // On target only if the plane was reached too (a dogleg can run out of time).
    this.reachedTarget = Math.abs(el.inclination - this.inclination) < 0.5;
    this.log('Engine cutoff', `Orbit ${el.periapsisAlt.toFixed(0)} × ${el.apoapsisAlt.toFixed(0)} km, i = ${el.inclination.toFixed(1)}°`);
  }

  // Ground distance from the launch site, km.
  downrange() {
    const geo = eciToGeo(scale(this.r, 1e-3), this.launchMs + this.t * 1000);
    return groundDistance(this.site.lat, this.site.lon, geo.lat, geo.lon);
  }

  // Periapsis / apoapsis altitude (km) and inclination (deg) of the current state.
  orbit() {
    const { r, v } = this.stateEci();
    const el = stateToElements(r, v);
    return {
      periapsisAlt: el.rp - R_EARTH,
      apoapsisAlt: el.e < 1 ? el.ra - R_EARTH : Infinity,
      e: el.e,
      inclination: el.i / DEG,
    };
  }

  // Advance to tSec after liftoff. Stops early if the ascent ends.
  advanceTo(tSec) {
    while (this.t < tSec - 1e-9 && (this.status === 'ascent' || this.status === 'ballistic')) {
      this.step(Math.min(this.stepSize, tSec - this.t));
    }
  }

  // ECI state in km, km/s.
  stateEci() {
    return { r: scale(this.r, 1e-3), v: scale(this.v, 1e-3) };
  }

  telemetry() {
    const rm = norm(this.r);
    const rHat = scale(this.r, 1 / rm);
    const vr = dot(this.v, rHat);
    const vhVec = sub(this.v, scale(rHat, vr));
    const east = unit(cross([0, 0, 1], rHat));
    const north = cross(rHat, east);
    const vRel = Ascent.relVelocity(this.r, this.v);
    const p = this.vehicle.phases[this.phase];
    const geo = eciToGeo(scale(this.r, 1e-3), this.launchMs + this.t * 1000);
    return {
      altitude: (rm - RE) / 1000,
      speed: norm(this.v) / 1000,
      airspeed: norm(vRel) / 1000,
      verticalSpeed: vr / 1000,
      horizontalSpeed: norm(vhVec) / 1000,
      heading: norm360(Math.atan2(dot(vhVec, east), dot(vhVec, north)) / DEG),
      downrange: groundDistance(this.site.lat, this.site.lon, geo.lat, geo.lon),
      accelG: this.accel / G0,
      q: this.q / 1000,
      mass: this.mass,
      throttle: this.engineOn && this.gapLeft <= 0 ? this.throttle : 0,
      pitch: this.pitch / DEG,
      yaw: this.yaw / DEG,
      flightPathAngle: Math.atan2(vr, norm(vhVec)) / DEG,
      stage: p ? p.name : 'Upper stage (spent)',
      propFraction: p ? this.propLeft / p.prop : 0,
      dvSpent: this.dvSpent / 1000,
      dogleg: this.dogleg ? (this.doglegDone ? 'complete' : this.steering ? 'turning' : 'pending') : null,
      ...this.orbit(),
    };
  }

  // Delta-v the upper stage still has, for later burns (m/s).
  // A lower stage that cannot restart (restartable: false) is dropped at
  // cutoff with whatever propellant it still holds.
  remainingDeltaV(extraMassKg = 0) {
    const p = this.vehicle.phases[this.phase];
    if (!p || this.propLeft <= 0) return 0;
    let dv = 0, m = this.mass + extraMassKg;
    const phases = this.vehicle.phases;
    for (let k = this.phase; k < phases.length; k++) {
      const prop = k === this.phase ? this.propLeft : phases[k].prop;
      if (k === this.phase && p.restartable === false && k < phases.length - 1) {
        m -= prop + p.dry;
        continue;
      }
      dv += phases[k].ispVac * G0 * Math.log(m / (m - prop));
      m -= prop + phases[k].dry;
    }
    return dv;
  }
}

// Great-circle distance over the surface, km.
function groundDistance(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * DEG, p2 = lat2 * DEG, dl = (lon2 - lon1) * DEG;
  const c = Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dl);
  return R_EARTH * Math.acos(Math.max(-1, Math.min(1, c)));
}
