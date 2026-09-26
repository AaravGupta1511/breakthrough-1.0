// Mission timeline: countdown -> powered ascent -> coast arcs joined by
// impulsive burns (circularisation, GTO/GEO, trans-lunar injection, lunar
// orbit insertion). Coast arcs are propagated analytically, so any amount of
// time warp stays exact.

import { MOON_SOI, MU_EARTH, MU_MOON, R_EARTH, R_MOON } from './constants.js';
import { Ascent, MAX_DIRECT_INSERTION_ALT } from './ascent.js';
import { moonPositionEci, moonVelocityEci } from './ephemeris.js';
import { lambertDeltaV } from './lambert.js';
import { propagate, stateToElements, sunSyncInclination } from './orbits.js';
import { eciToGeo, geoToEci } from './time.js';
import { add, cross, dist, dot, norm, scale, sub, unit } from './vec.js';

export const R_GEO = 42164.17;
const COUNTDOWN = 10; // s
const TRAIL_MAX = 6000;
const LUNAR_ORBIT_ALT = 100; // km

export const TARGETS = {
  leo: { label: 'Low Earth orbit (custom)', alt: 400, inc: null, editableInc: true, editableAlt: true },
  iss: { label: 'ISS orbit (420 km, 51.6°)', alt: 420, inc: 51.64 },
  sso: { label: 'Sun-synchronous orbit', alt: 600, inc: 'sso', editableAlt: true },
  polar: { label: 'Polar orbit', alt: 500, inc: 90, editableAlt: true },
  geo: { label: 'Geostationary (via GTO)', alt: 200, inc: null, parking: true },
  moon: { label: 'Moon (TLI + lunar orbit)', alt: 185, inc: null, parking: true },
};

// Resolve the inclination actually requested for a target from a given site.
export function targetInclination(targetId, altKm, site, customInc) {
  const t = TARGETS[targetId];
  if (t.inc === 'sso') return sunSyncInclination(altKm) * 180 / Math.PI;
  if (typeof t.inc === 'number') return t.inc;
  if (t.editableInc && Number.isFinite(customInc)) return customInc;
  return Math.abs(site.lat); // due east: the cheapest orbit from this site
}

export class Mission {
  constructor({ vehicle, payload, site, targetId, altitude, inclination, startMs }) {
    this.vehicle = vehicle;
    this.payload = payload;
    this.site = site;
    this.targetId = targetId;
    this.targetAlt = altitude;
    this.launchMs = startMs + COUNTDOWN * 1000;
    this.createdMs = startMs;
    this.phase = 'countdown';
    this.frame = 'earth';
    this.events = [];
    this.burns = [];
    this.maneuvers = [];
    this.arc = null;
    this.status = '';
    this.trail = { earth: [], moon: [] };
    this.groundTrack = []; // [lat, lon] while in the Earth frame
    this.lastTrailMs = null;

    const planeNormal = targetId === 'moon' ? lunarPlaneNormal(site, this.launchMs) : null;
    this.ascent = new Ascent({
      vehicle, payload, site, launchMs: this.launchMs,
      targetAlt: altitude, inclination, planeNormal,
    });
    this.inclination = this.ascent.inclination;
    this.ascentEventsSeen = 0;
    this.log(startMs, 'Countdown', `${vehicle.name} from ${site.short}, target: ${TARGETS[targetId].label}`);
    if (this.ascent.inclinationClamped) {
      this.log(startMs, 'Note', `Inclination raised to ${this.inclination.toFixed(1)}°: a site at ${site.lat.toFixed(1)}° latitude cannot launch directly into a lower one.`);
    }
    this.now = startMs;
    this.r = geoToEci(site.lat, site.lon, R_EARTH, startMs);
    this.v = [0, 0, 0];
  }

  log(ms, name, detail = '', kind = 'info') {
    this.events.push({ ms, name, detail, kind });
  }

  // ------------------------------------------------------------ propagation

  update(ms) {
    if (ms < this.now) return; // no rewinding
    let guard = 0;
    while (guard++ < 20) {
      if (this.phase === 'countdown') {
        if (ms < this.launchMs) break;
        this.phase = 'ascent';
        if (this.ascent.status === 'failed') { this.fail(this.launchMs, this.ascent.message); break; }
        continue;
      }
      if (this.phase === 'ascent') {
        this.ascent.advanceTo((ms - this.launchMs) / 1000);
        this.syncAscentEvents();
        const st = this.ascent.status;
        if (st === 'failed') { this.fail(this.launchMs + this.ascent.t * 1000, this.ascent.message); break; }
        if (st === 'inserted') { this.onInsertion(); continue; }
        break;
      }
      if (this.phase === 'coast') {
        const next = this.maneuvers[0];
        if (next && next.ms <= ms) {
          this.maneuvers.shift();
          const s = this.stateAtArc(next.ms);
          next.apply(s, next.ms);
          continue;
        }
        break;
      }
      break;
    }
    this.now = ms;
    this.refreshState(ms);
    this.recordTrail(ms);
  }

  refreshState(ms) {
    if (this.phase === 'countdown') {
      this.r = geoToEci(this.site.lat, this.site.lon, R_EARTH, ms);
      this.v = [0, 0, 0];
      return;
    }
    if (this.phase === 'ascent') {
      const s = this.ascent.stateEci();
      this.r = s.r; this.v = s.v;
      return;
    }
    if (this.phase === 'failed') {
      // Wreckage on the ground turns with the Earth; anything else stays put.
      if (this.groundFix) this.r = geoToEci(this.groundFix.lat, this.groundFix.lon, R_EARTH, ms);
      this.v = [0, 0, 0];
      return;
    }
    const s = this.stateAtArc(ms);
    this.r = s.r; this.v = s.v;
    if (this.frame === 'earth' && norm(this.r) < R_EARTH) {
      this.fail(ms, 'Orbit decayed: the vehicle re-entered and hit the surface.');
    } else if (this.frame === 'moon' && norm(this.r) < R_MOON) {
      this.fail(ms, 'Impacted the lunar surface.');
    }
  }

  // State on the current coast arc (in the current frame).
  stateAtArc(ms) {
    const a = this.arc;
    return propagate(a.r, a.v, (ms - a.ms) / 1000, a.mu);
  }

  setArc(ms, r, v, frame = this.frame) {
    this.frame = frame;
    this.arc = { ms, r, v, mu: frame === 'moon' ? MU_MOON : MU_EARTH };
    this.r = r; this.v = v;
  }

  fail(ms, message) {
    const r = this.arc ? this.stateAtArc(ms).r : this.phase === 'countdown' ? this.r : this.ascent.stateEci().r;
    this.phase = 'failed';
    this.failMs = ms;
    this.status = message;
    this.r = r;
    if (this.frame === 'earth' && norm(r) < R_EARTH + 50) this.groundFix = eciToGeo(r, ms);
    this.maneuvers = [];
    this.log(ms, 'Mission failed', message, 'bad');
  }

  syncAscentEvents() {
    const evs = this.ascent.events;
    for (; this.ascentEventsSeen < evs.length; this.ascentEventsSeen++) {
      const e = evs[this.ascentEventsSeen];
      this.log(this.launchMs + e.t * 1000, e.name, e.detail, e.name === 'Impact' ? 'bad' : 'info');
    }
  }

  // ------------------------------------------------------------ mission logic

  onInsertion() {
    const tMs = this.launchMs + this.ascent.t * 1000;
    const { r, v } = this.ascent.stateEci();
    this.phase = 'coast';
    this.setArc(tMs, r, v, 'earth');
    this.ascentDv = this.ascent.dvSpent;
    const el = stateToElements(r, v);
    if (el.rp - R_EARTH < 120) {
      this.log(tMs, 'Suborbital', 'Perigee inside the atmosphere; the stage will re-enter.', 'bad');
      return;
    }
    if (this.targetId === 'geo') { this.planGto(tMs); return; }
    if (this.targetId === 'moon') { this.planTli(tMs); return; }
    if (this.targetAlt > MAX_DIRECT_INSERTION_ALT && el.e > 0.002) {
      this.planCircularisation(tMs, 'Circularisation burn', `Raise perigee to ${this.targetAlt.toFixed(0)} km`);
    } else {
      this.complete(tMs, `In orbit: ${(el.rp - R_EARTH).toFixed(0)} × ${(el.ra - R_EARTH).toFixed(0)} km`);
    }
  }

  complete(ms, text) {
    this.status = text;
    this.log(ms, 'Mission complete', text, 'good');
  }

  // The vehicle is safe in orbit but cannot continue to the destination.
  incomplete(ms, text) {
    this.status = text;
    this.incompleteMs = ms;
    this.log(ms, 'Mission incomplete', text, 'warn');
  }

  burn(ms, name, dvVec, detail, performer) {
    const dv = norm(dvVec) * 1000;
    this.burns.push({ ms, name, dv, performer });
    this.log(ms, name, `${detail}${detail ? ' · ' : ''}Δv ${dv.toFixed(0)} m/s${performer ? ` (${performer})` : ''}`, 'burn');
  }

  // Burn to circular at the next apoapsis.
  planCircularisation(fromMs, name, detail) {
    const tApo = fromMs + timeToApsis(this.arc, fromMs, 'apo') * 1000;
    this.schedule(tApo, name, (s, ms) => {
      const vNew = scale(unit(cross(cross(s.r, s.v), s.r)), Math.sqrt(MU_EARTH / norm(s.r)));
      this.setArc(ms, s.r, vNew);
      this.burn(ms, name, sub(vNew, s.v), detail, this.performer());
      const el = stateToElements(s.r, vNew);
      this.complete(ms, `In orbit: ${(el.rp - R_EARTH).toFixed(0)} × ${(el.ra - R_EARTH).toFixed(0)} km, i ${(el.i * 180 / Math.PI).toFixed(1)}°`);
    });
  }

  performer() {
    return this.vehicle.upperStageCanRestart ? 'upper stage restart' : 'payload thrusters';
  }

  schedule(ms, name, apply) {
    this.maneuvers.push({ ms, name, apply });
    this.maneuvers.sort((a, b) => a.ms - b.ms);
  }

  // GEO: burn at an equator crossing so apogee lands on the equator, then
  // circularise and remove the inclination at apogee.
  planGto(fromMs) {
    const tNode = findNextNode(this.arc, fromMs + 60000);
    this.log(fromMs, 'Parking orbit', 'Coasting to the equator crossing for GTO injection');
    this.schedule(tNode, 'GTO injection', (s, ms) => {
      const rm = norm(s.r);
      const vp = Math.sqrt((2 * MU_EARTH * R_GEO) / (rm * (rm + R_GEO)));
      const vNew = scale(unit(s.v), vp);
      const need = norm(sub(vNew, s.v)) * 1000;
      const have = this.ascent.remainingDeltaV();
      if (need > have + 1) {
        this.incomplete(ms, `Not enough propellant for GTO injection: the upper stage has ${have.toFixed(0)} m/s left but needs ${need.toFixed(0)} m/s. Stranded in the parking orbit — try a lighter payload.`);
        return;
      }
      this.setArc(ms, s.r, vNew);
      this.burn(ms, 'GTO injection', sub(vNew, s.v), `Apogee raised to ${(R_GEO - R_EARTH).toFixed(0)} km`, 'upper stage');
      const tApo = ms + timeToApsis(this.arc, ms, 'apo') * 1000;
      this.schedule(tApo, 'Apogee burn (GEO insertion)', (s2, ms2) => {
        const vGeo = scale(unit(cross([0, 0, 1], s2.r)), Math.sqrt(MU_EARTH / norm(s2.r)));
        this.setArc(ms2, s2.r, vGeo);
        this.burn(ms2, 'Apogee burn (GEO insertion)', sub(vGeo, s2.v), 'Circularise and zero the inclination', 'satellite apogee engine');
        this.complete(ms2, 'On station in geostationary orbit (35,786 km, i = 0°)');
      });
    });
  }

  // Moon: scan the next ~1.5 parking orbits for the cheapest Lambert arc to
  // where the Moon will be, fly it, correct on SOI entry, brake into orbit.
  planTli(fromMs) {
    const el = stateToElements(this.arc.r, this.arc.v);
    let best = null;
    const tofs = [3, 3.5, 4, 4.5, 5].map((d) => d * 86400);
    for (let dt = 300; dt < el.period * 1.5; dt += 60) {
      const ms = fromMs + dt * 1000;
      const s = this.stateAtArc(ms);
      for (const tof of tofs) {
        const moon = moonPositionEci(ms + tof * 1000);
        const sol = lambertDeltaV(s.r, s.v, moon, tof);
        if (sol && (!best || sol.dvMag < best.dvMag)) best = { ...sol, ms, tof };
      }
    }
    if (!best) { this.incomplete(fromMs, 'No lunar transfer found from this parking orbit.'); return; }
    this.log(fromMs, 'Parking orbit', `TLI planned: ${(best.dvMag * 1000).toFixed(0)} m/s, ${(best.tof / 86400).toFixed(1)}-day coast`);
    this.schedule(best.ms, 'Trans-lunar injection', (s, ms) => {
      const need = best.dvMag * 1000;
      const have = this.ascent.remainingDeltaV();
      if (need > have + 1) {
        this.incomplete(ms, `Not enough propellant for trans-lunar injection: the upper stage has ${have.toFixed(0)} m/s left but needs ${need.toFixed(0)} m/s. Stranded in the parking orbit — try a lighter payload.`);
        return;
      }
      this.setArc(ms, s.r, best.vDepart);
      this.burn(ms, 'Trans-lunar injection', best.dv, `Heading for the Moon, arrival in ${(best.tof / 86400).toFixed(1)} days`, 'upper stage');
      const tSoi = findSoiEntry(this.arc, ms, best.tof + 86400);
      if (tSoi == null) { this.log(ms, 'Warning', 'Trajectory misses the Moon’s sphere of influence', 'warn'); return; }
      this.schedule(tSoi, 'Lunar SOI entry', (s2, ms2) => this.enterLunarSoi(s2, ms2));
    });
  }

  enterLunarSoi(s, ms) {
    const rRel = sub(s.r, moonPositionEci(ms));
    const vRel = sub(s.v, moonVelocityEci(ms));
    this.log(ms, 'Lunar SOI entry', `Now dominated by lunar gravity at ${(norm(rRel) / 1000).toFixed(0)},000 km from the Moon`);
    // Course correction: keep speed, rotate the velocity so periselene is 100 km.
    const rm = norm(rRel), vm = norm(vRel);
    const rp = R_MOON + LUNAR_ORBIT_ALT;
    const energy = (vm * vm) / 2 - MU_MOON / rm;
    const hNeed = rp * Math.sqrt(2 * (energy + MU_MOON / rp));
    const rhat = scale(rRel, 1 / rm);
    const vr = dot(vRel, rhat);
    let tdir = sub(vRel, scale(rhat, vr));
    if (norm(tdir) < 1e-6) tdir = cross(rhat, [0, 0, 1]);
    tdir = unit(tdir);
    const vt = hNeed / rm;
    const vrNew = -Math.sqrt(Math.max(0, vm * vm - vt * vt));
    const vNew = add(scale(rhat, vrNew), scale(tdir, vt));
    this.setArc(ms, rRel, vNew, 'moon');
    this.burn(ms, 'Mid-course correction', sub(vNew, vRel), `Aim periselene at ${LUNAR_ORBIT_ALT} km`, 'spacecraft RCS');
    const tPeri = ms + timeToApsis(this.arc, ms, 'peri') * 1000;
    this.schedule(tPeri, 'Lunar orbit insertion', (s2, ms2) => {
      const vCirc = scale(unit(cross(cross(s2.r, s2.v), s2.r)), Math.sqrt(MU_MOON / norm(s2.r)));
      this.setArc(ms2, s2.r, vCirc, 'moon');
      this.burn(ms2, 'Lunar orbit insertion', sub(vCirc, s2.v), `Captured into a ${LUNAR_ORBIT_ALT} km lunar orbit`, 'service module engine');
      this.complete(ms2, `In lunar orbit at ${LUNAR_ORBIT_ALT} km`);
    });
  }

  // ------------------------------------------------------------ read-outs

  // Inertial (Earth-centred) position of the vehicle, km.
  positionEci(ms = this.now) {
    if (this.frame === 'moon' && this.phase !== 'ascent') return add(this.r, moonPositionEci(ms));
    return this.r;
  }

  velocityEci(ms = this.now) {
    if (this.frame === 'moon') return add(this.v, moonVelocityEci(ms));
    return this.v;
  }

  nextEvent() {
    if (this.phase === 'countdown') return { name: 'Liftoff', ms: this.launchMs };
    if (this.phase === 'coast' && this.maneuvers.length) return this.maneuvers[0];
    return null;
  }

  // Orbit through the current state, sampled for drawing (in current frame).
  predictedPath() {
    if (this.phase === 'ascent') {
      const { r, v } = this.ascent.stateEci();
      return { frame: 'earth', points: samplePath(r, v, MU_EARTH, R_EARTH) };
    }
    if (this.phase !== 'coast') return null;
    const mu = this.frame === 'moon' ? MU_MOON : MU_EARTH;
    const body = this.frame === 'moon' ? R_MOON : R_EARTH;
    return { frame: this.frame, points: samplePath(this.r, this.v, mu, body) };
  }

  elements() {
    if (this.phase === 'countdown' || this.phase === 'failed') return null;
    const mu = this.frame === 'moon' ? MU_MOON : MU_EARTH;
    const el = stateToElements(this.r, this.v, mu);
    const body = this.frame === 'moon' ? R_MOON : R_EARTH;
    return { ...el, body: this.frame === 'moon' ? 'Moon' : 'Earth', periAlt: el.rp - body, apoAlt: el.ra - body };
  }

  totalDeltaV() {
    return (this.ascentDv || this.ascent.dvSpent) / 1000 + this.burns.reduce((s, b) => s + b.dv, 0) / 1000;
  }

  recordTrail(ms) {
    if (this.phase === 'countdown') { this.lastTrailMs = ms; return; }
    const list = this.trail[this.frame];
    const earthFrame = this.frame === 'earth';
    const pushPoint = (p, t) => {
      list.push(p);
      if (list.length > TRAIL_MAX) list.splice(0, list.length - TRAIL_MAX);
      if (earthFrame) {
        const g = eciToGeo(p, t);
        this.groundTrack.push([g.lat, g.lon]);
        if (this.groundTrack.length > TRAIL_MAX) this.groundTrack.splice(0, this.groundTrack.length - TRAIL_MAX);
      }
    };
    if (this.phase === 'ascent' || this.phase === 'failed') {
      const last = list[list.length - 1];
      if (!last || dist(last, this.r) > 2) pushPoint([...this.r], ms);
      this.lastTrailMs = ms;
      return;
    }
    // Coast: sample the analytic arc between the previous and current time.
    const from = Math.max(this.lastTrailMs ?? ms, this.arc.ms);
    const span = (ms - from) / 1000;
    const rNow = norm(this.r);
    const mu = this.arc.mu;
    const step = Math.max(2, (2 * Math.PI * Math.sqrt((rNow ** 3) / mu)) / 360);
    const n = Math.min(400, Math.floor(span / step));
    for (let k = 1; k <= n; k++) {
      const t = from + (k * span * 1000) / (n + 1);
      pushPoint(this.stateAtArc(t).r, t);
    }
    pushPoint([...this.r], ms);
    this.lastTrailMs = ms;
  }
}

// ------------------------------------------------------------ helpers

// Lunar missions launch into the plane that contains the Moon's expected
// arrival point, as Apollo did by picking the launch azimuth.
export function lunarPlaneNormal(site, launchMs) {
  const site0 = geoToEci(site.lat, site.lon, 1, launchMs);
  const moonDir = moonPositionEci(launchMs + 4.1 * 86400e3);
  const n = unit(cross(site0, moonDir));
  return n[2] < 0 ? scale(n, -1) : n;
}

function samplePath(r, v, mu, bodyRadius) {
  const el = stateToElements(r, v, mu);
  const pts = [];
  const bound = el.e < 1 && el.ra < 2e6;
  const span = bound ? el.period : 4 * 86400;
  const n = 360;
  for (let k = 0; k <= n; k++) {
    const p = propagate(r, v, (k / n) * span, mu).r;
    if (k > 0 && norm(p) < bodyRadius) break; // stops at impact
    pts.push(p);
  }
  return pts;
}

// Seconds from `ms` to the next apoapsis ('apo') or periapsis ('peri').
function timeToApsis(arc, ms, which) {
  const s = propagate(arc.r, arc.v, (ms - arc.ms) / 1000, arc.mu);
  const el = stateToElements(s.r, s.v, arc.mu);
  if (el.e < 1) {
    const n = Math.sqrt(arc.mu / el.a ** 3);
    const E = 2 * Math.atan(Math.sqrt((1 - el.e) / (1 + el.e)) * Math.tan(el.nu / 2));
    let M = E - el.e * Math.sin(E);
    if (M < 0) M += 2 * Math.PI;
    const target = which === 'apo' ? Math.PI : 2 * Math.PI;
    let dM = target - M;
    if (dM <= 1e-6) dM += 2 * Math.PI;
    return dM / n;
  }
  // Hyperbolic: time to periapsis from the hyperbolic anomaly.
  const F = 2 * Math.atanh(Math.sqrt((el.e - 1) / (el.e + 1)) * Math.tan(el.nu / 2));
  const Mh = el.e * Math.sinh(F) - F;
  const n = Math.sqrt(arc.mu / (-el.a) ** 3);
  return Math.max(1, -Mh / n);
}

// Next time the arc crosses the equatorial plane.
function findNextNode(arc, fromMs) {
  const z = (ms) => propagate(arc.r, arc.v, (ms - arc.ms) / 1000, arc.mu).r[2];
  let t0 = fromMs, z0 = z(t0);
  for (let k = 0; k < 400; k++) {
    const t1 = t0 + 30000, z1 = z(t1);
    if (z0 === 0 || Math.sign(z1) !== Math.sign(z0)) {
      let a = t0, b = t1, za = z0;
      for (let i = 0; i < 40; i++) {
        const m = (a + b) / 2, zm = z(m);
        if (Math.sign(zm) === Math.sign(za)) { a = m; za = zm; } else b = m;
      }
      return (a + b) / 2;
    }
    t0 = t1; z0 = z1;
  }
  return fromMs;
}

// First time within `spanSec` that the arc enters the Moon's sphere of influence.
function findSoiEntry(arc, fromMs, spanSec) {
  const d = (ms) => dist(propagate(arc.r, arc.v, (ms - arc.ms) / 1000, arc.mu).r, moonPositionEci(ms)) - MOON_SOI;
  let t0 = fromMs;
  for (let t = fromMs + 600000; t <= fromMs + spanSec * 1000; t += 600000) {
    if (d(t) < 0) {
      let a = t0, b = t;
      for (let i = 0; i < 40; i++) {
        const m = (a + b) / 2;
        if (d(m) < 0) b = m; else a = m;
      }
      return b;
    }
    t0 = t;
  }
  return null;
}
