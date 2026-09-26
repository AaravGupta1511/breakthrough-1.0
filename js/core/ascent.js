// Powered ascent simulation.
//
// The rocket flies in a fixed inertial plane through the launch site, chosen
// so the final orbit has the requested inclination. Inside that plane the
// equations of motion (gravity, thrust, drag, mass flow, staging) are
// integrated with RK4. Guidance:
//   1. vertical rise to clear the tower,
//   2. a small pitch kick, then a gravity turn (thrust along the airflow,
//      zero angle of attack) through the thick atmosphere,
//   3. closed-loop guidance above ~40 km: each step it solves for a linear
//      radial-acceleration profile that arrives at the insertion radius with
//      zero vertical speed, and puts the rest of the thrust horizontal,
//   4. engine cutoff once orbital energy matches the insertion orbit.
// High targets are reached like real missions do: insert into a low
// perigee x target-apogee ellipse, then circularise at apogee (mission.js).

import { DEG, G0, MU_EARTH, OMEGA_EARTH, R_EARTH } from './constants.js';
import { geoToEci } from './time.js';
import { cross, dot, unit } from './vec.js';

const MU = MU_EARTH * 1e9;   // m^3/s^2
const RE = R_EARTH * 1000;   // m
const STEP = 0.1;            // s
const STAGING_GAP = 3;       // s of coast between stages
const MAX_G = 4.5;           // liquid stages throttle to stay under this
const MIN_THROTTLE = 0.4;
const CLOSED_LOOP_ALT = 40000; // m
const FAIRING_ALT = 110000;    // m
export const MAX_DIRECT_INSERTION_ALT = 250; // km; higher targets use a transfer ellipse
const INSERTION_PERIGEE_ALT = 200;           // km

// Atmosphere: simple exponential model.
const density = (h) => (h > 150000 ? 0 : 1.225 * Math.exp(-h / 8500));
const pressureRatio = (h) => Math.exp(-h / 8500);

// Inertial launch azimuth (radians from north) that yields inclination incDeg
// from latitude latDeg. Retrograde targets launch towards the south.
export function launchAzimuth(latDeg, incDeg) {
  const cosLat = Math.cos(latDeg * DEG);
  let inc = incDeg;
  let clamped = false;
  const minInc = Math.abs(latDeg);
  // Clamp to what the site can reach; only flag it when the request was
  // meaningfully out of range (not just rounded in the input box).
  if (inc < minInc) { clamped = inc < minInc - 0.05; inc = minInc; }
  if (inc > 180 - minInc) { clamped = inc > 180 - minInc + 0.05; inc = 180 - minInc; }
  const s = Math.max(-1, Math.min(1, Math.cos(inc * DEG) / cosLat));
  let az = Math.asin(s);
  if (inc >= 90) az = Math.PI - az;
  if (latDeg < 0 && inc < 90) az = Math.PI - az; // southern sites: go east-south-east
  return { azimuth: az, inclination: inc, clamped };
}

export class Ascent {
  // planeNormal (optional, ECI unit vector) overrides `inclination` and fixes
  // the exact orbital plane, e.g. one that contains the Moon's direction.
  // stepSize: integration step in seconds; the mission planner uses a coarser
  // step for quick what-if runs.
  constructor({ vehicle, payload, site, launchMs, targetAlt, inclination, planeNormal = null, stepSize = STEP }) {
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

    // Plane basis (ECI unit vectors): u = up at the site, w = downrange.
    const up = unit(geoToEci(site.lat, site.lon, 1, launchMs));
    const east = unit(cross([0, 0, 1], up));
    const north = cross(up, east);
    this.u = up;
    if (planeNormal) {
      this.w = unit(cross(planeNormal, up));
      this.azimuth = Math.atan2(dot(this.w, east), dot(this.w, north));
      this.inclination = Math.acos(Math.max(-1, Math.min(1, planeNormal[2]))) / DEG;
      this.inclinationClamped = false;
    } else {
      const az = launchAzimuth(site.lat, inclination);
      this.azimuth = az.azimuth;
      this.inclination = az.inclination;
      this.inclinationClamped = az.clamped;
      this.w = [
        north[0] * Math.cos(this.azimuth) + east[0] * Math.sin(this.azimuth),
        north[1] * Math.cos(this.azimuth) + east[1] * Math.sin(this.azimuth),
        north[2] * Math.cos(this.azimuth) + east[2] * Math.sin(this.azimuth),
      ];
    }

    // State in the plane (metres, m/s).
    this.x = RE; this.y = 0;
    this.vx = 0;
    this.vy = OMEGA_EARTH * RE * Math.cos(site.lat * DEG) * Math.sin(this.azimuth);
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
      this.log('Liftoff', `${vehicle.name} clears the tower (TWR ${twr.toFixed(2)})`);
    }
  }

  log(name, detail = '') { this.events.push({ t: this.t, name, detail }); }

  get altitude() { return Math.hypot(this.x, this.y) - RE; }

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

  // Air-relative velocity in the plane (the atmosphere co-rotates with Earth).
  relVelocity(x, y, vx, vy) {
    const r3 = [x * this.u[0] + y * this.w[0], x * this.u[1] + y * this.w[1], x * this.u[2] + y * this.w[2]];
    const atm = [-OMEGA_EARTH * r3[1], OMEGA_EARTH * r3[0], 0];
    const ax = atm[0] * this.u[0] + atm[1] * this.u[1] + atm[2] * this.u[2];
    const ay = atm[0] * this.w[0] + atm[1] * this.w[1] + atm[2] * this.w[2];
    return [vx - ax, vy - ay];
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

  guidance(h, rx, ry, vx, vy, aThrust, dt) {
    const r = Math.hypot(rx, ry);
    const radial = [rx / r, ry / r];
    const horiz = [-radial[1], radial[0]];
    const vr = vx * radial[0] + vy * radial[1];
    const vh = vx * horiz[0] + vy * horiz[1];
    let cmd = this.pitch;

    if (this.mode === 'vertical') {
      cmd = 90 * DEG;
      const [rvx, rvy] = this.relVelocity(rx, ry, vx, vy);
      if (this.t > 5 && h > 100 && Math.hypot(rvx, rvy) > 50) { this.mode = 'kick'; this.kickStart = this.t; this.log('Pitch kick', `Pitching ${(this.kick / DEG).toFixed(1)}° downrange`); }
    } else if (this.mode === 'kick') {
      const f = Math.min(1, (this.t - this.kickStart) / 8);
      cmd = 90 * DEG - this.kick * f;
      const [rvx, rvy] = this.relVelocity(rx, ry, vx, vy);
      const fpa = Math.atan2(rvx * radial[0] + rvy * radial[1], rvx * horiz[0] + rvy * horiz[1]);
      if (f >= 1 && fpa <= cmd + 0.2 * DEG) this.mode = 'gravity';
    } else if (this.mode === 'gravity') {
      const [rvx, rvy] = this.relVelocity(rx, ry, vx, vy);
      cmd = Math.atan2(rvx * radial[0] + rvy * radial[1], rvx * horiz[0] + rvy * horiz[1]);
      if (h > CLOSED_LOOP_ALT) { this.mode = 'closed'; this.log('Closed-loop guidance', 'Steering to the target orbit'); }
    } else if (this.mode === 'closed' && aThrust > 0) {
      const rt = this.insertRadius;
      const vt = this.insertSpeed;
      const T = this.timeToGo(Math.hypot(vt - vh, vr));
      if (T > 6) {
        const dr = rt - r - vr * T;
        const B = -(6 * vr * T + 12 * dr) / (T * T * T);
        const A = (-vr - (B * T * T) / 2) / T;
        const gEff = MU / (r * r) - (vh * vh) / r;
        const s = Math.max(-0.5, Math.min(0.99, (A + gEff) / aThrust));
        cmd = Math.asin(s);
      }
    }
    // Rate-limit the attitude change.
    const maxStep = 2 * DEG * dt;
    this.pitch += Math.max(-maxStep, Math.min(maxStep, cmd - this.pitch));
    return [
      Math.cos(this.pitch) * horiz[0] + Math.sin(this.pitch) * radial[0],
      Math.cos(this.pitch) * horiz[1] + Math.sin(this.pitch) * radial[1],
    ];
  }

  // Acceleration at a state (without changing it).
  accelAt(x, y, vx, vy, thrustAcc, dir) {
    const r = Math.hypot(x, y);
    const g = -MU / (r * r * r);
    let ax = g * x, ay = g * y;
    const h = r - RE;
    const rho = density(h);
    if (rho > 0) {
      const [rvx, rvy] = this.relVelocity(x, y, vx, vy);
      const rv = Math.hypot(rvx, rvy);
      const k = (0.5 * rho * rv * this.cd * this.area) / this.mass;
      ax -= k * rvx; ay -= k * rvy;
    }
    if (thrustAcc > 0) { ax += thrustAcc * dir[0]; ay += thrustAcc * dir[1]; }
    return [ax, ay];
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
    const dir = this.guidance(h, this.x, this.y, this.vx, this.vy, aT, dt);

    // RK4 on position/velocity with thrust direction and mass frozen for the step.
    const s0 = [this.x, this.y, this.vx, this.vy];
    const deriv = (s) => { const a = this.accelAt(s[0], s[1], s[2], s[3], aT, dir); return [s[2], s[3], a[0], a[1]]; };
    const k1 = deriv(s0);
    const k2 = deriv(s0.map((v, i) => v + (dt / 2) * k1[i]));
    const k3 = deriv(s0.map((v, i) => v + (dt / 2) * k2[i]));
    const k4 = deriv(s0.map((v, i) => v + dt * k3[i]));
    const s1 = s0.map((v, i) => v + (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
    [this.x, this.y, this.vx, this.vy] = s1;
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
    const [rvx, rvy] = this.relVelocity(this.x, this.y, this.vx, this.vy);
    this.q = 0.5 * density(hNew) * (rvx * rvx + rvy * rvy);
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
      const r = Math.hypot(this.x, this.y);
      const energy = (this.vx * this.vx + this.vy * this.vy) / 2 - MU / r;
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
    const el = this.orbit2D();
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
    this.reachedTarget = true; // guidance cut the engine on target (not a fuel-out)
    const el = this.orbit2D();
    this.log('Engine cutoff', `Orbit ${el.periapsisAlt.toFixed(0)} × ${el.apoapsisAlt.toFixed(0)} km, i = ${this.inclination.toFixed(1)}°`);
  }

  // Apoapsis / periapsis altitude (km) of the current in-plane state.
  orbit2D() {
    const r = Math.hypot(this.x, this.y);
    const v2 = this.vx * this.vx + this.vy * this.vy;
    const hAng = this.x * this.vy - this.y * this.vx;
    const energy = v2 / 2 - MU / r;
    const a = -MU / (2 * energy);
    const e = Math.sqrt(Math.max(0, 1 + (2 * energy * hAng * hAng) / (MU * MU)));
    const rp = a * (1 - e), ra = energy < 0 ? a * (1 + e) : Infinity;
    return { periapsisAlt: (rp - RE) / 1000, apoapsisAlt: (ra - RE) / 1000, e };
  }

  // Advance to tSec after liftoff. Stops early if the ascent ends.
  advanceTo(tSec) {
    while (this.t < tSec - 1e-9 && (this.status === 'ascent' || this.status === 'ballistic')) {
      this.step(Math.min(this.stepSize, tSec - this.t));
    }
  }

  // ECI state in km, km/s.
  stateEci() {
    const { u, w } = this;
    return {
      r: [(this.x * u[0] + this.y * w[0]) / 1000, (this.x * u[1] + this.y * w[1]) / 1000, (this.x * u[2] + this.y * w[2]) / 1000],
      v: [(this.vx * u[0] + this.vy * w[0]) / 1000, (this.vx * u[1] + this.vy * w[1]) / 1000, (this.vx * u[2] + this.vy * w[2]) / 1000],
    };
  }

  telemetry() {
    const r = Math.hypot(this.x, this.y);
    const radial = [this.x / r, this.y / r];
    const vr = this.vx * radial[0] + this.vy * radial[1];
    const vh = -this.vx * radial[1] + this.vy * radial[0];
    const [rvx, rvy] = this.relVelocity(this.x, this.y, this.vx, this.vy);
    const p = this.vehicle.phases[this.phase];
    return {
      altitude: (r - RE) / 1000,
      speed: Math.hypot(this.vx, this.vy) / 1000,
      airspeed: Math.hypot(rvx, rvy) / 1000,
      verticalSpeed: vr / 1000,
      horizontalSpeed: vh / 1000,
      downrange: (RE * Math.atan2(this.y, this.x)) / 1000,
      accelG: this.accel / G0,
      q: this.q / 1000,
      mass: this.mass,
      throttle: this.engineOn && this.gapLeft <= 0 ? this.throttle : 0,
      pitch: this.pitch / DEG,
      flightPathAngle: Math.atan2(vr, vh) / DEG,
      stage: p ? p.name : 'Upper stage (spent)',
      propFraction: p ? this.propLeft / p.prop : 0,
      dvSpent: this.dvSpent / 1000,
      ...this.orbit2D(),
    };
  }

  // Delta-v the upper stage still has, for later burns (m/s).
  remainingDeltaV(extraMassKg = 0) {
    const p = this.vehicle.phases[this.phase];
    if (!p || this.propLeft <= 0) return 0;
    let dv = 0, m = this.mass + extraMassKg;
    const phases = this.vehicle.phases;
    for (let k = this.phase; k < phases.length; k++) {
      const prop = k === this.phase ? this.propLeft : phases[k].prop;
      dv += phases[k].ispVac * G0 * Math.log(m / (m - prop));
      m -= prop + phases[k].dry;
    }
    return dv;
  }
}
