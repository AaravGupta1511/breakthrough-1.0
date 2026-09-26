// Mission timeline: countdown -> powered ascent -> coast arcs joined by
// impulsive burns. Each coast arc is a two-body conic around one "centre"
// body (Earth, Moon, Sun, a planet or a planet's moon), propagated
// analytically so any amount of time warp stays exact. Crossing a sphere of
// influence switches the centre (patched conics).
//
// Missions: Earth orbits, GEO via GTO, the Moon, the planets (launch window,
// escape burn, cruise with a trajectory correction, capture), and moons of
// the planets (capture at the planet, transfer to the moon, orbit insertion;
// rendezvous for moons too small to orbit).

import { MU_EARTH, MU_SUN, R_EARTH } from './constants.js';
import { Ascent, MAX_DIRECT_INSERTION_ALT } from './ascent.js';
import { BODIES, ECLIPTIC_NORTH, MOON_IDS, PLANET_IDS, helioPosition, orbitNormal, positionRelEarth, stateRelTo, systemPlanet } from './bodies.js';
import { moonPositionEci } from './ephemeris.js';
import { captureOrbit, departurePoint, escapeDeltaV, findTransferWindow, planeContaining } from './interplanetary.js';
import { lambertDeltaV, solveLambert } from './lambert.js';
import { propagate, stateToElements, sunSyncInclination } from './orbits.js';
import { eciToGeo, geoToEci } from './time.js';
import { add, cross, dist, dot, norm, scale, sub, unit } from './vec.js';

export const R_GEO = 42164.17;
const COUNTDOWN = 10; // s
const TRAIL_MAX = 6000;
const DEPARTURE_LEAD = 2 * 3600e3; // launch this long before the ideal escape burn
const STATION_KEEPING = 20;        // km above a small moon's surface

export const TARGETS = {
  leo: { label: 'Low Earth orbit (custom)', group: 'Earth orbit', alt: 400, inc: null, editableInc: true, editableAlt: true },
  iss: { label: 'ISS orbit (420 km, 51.6°)', group: 'Earth orbit', alt: 420, inc: 51.64 },
  sso: { label: 'Sun-synchronous orbit', group: 'Earth orbit', alt: 600, inc: 'sso', editableAlt: true },
  polar: { label: 'Polar orbit', group: 'Earth orbit', alt: 500, inc: 90, editableAlt: true },
  geo: { label: 'Geostationary (via GTO)', group: 'Earth orbit', alt: 200, inc: null, parking: true },
  moon: { label: 'The Moon (TLI + lunar orbit)', group: 'The Moon', alt: 185, inc: null, parking: true, body: 'moon' },
};
for (const id of PLANET_IDS) TARGETS[id] = { label: BODIES[id].name, group: 'Planets', alt: 200, inc: null, parking: true, body: id };
for (const id of MOON_IDS) {
  const b = BODIES[id];
  TARGETS[id] = { label: `${b.name} (${BODIES[b.parent].name})`, group: 'Moons of other planets', alt: 200, inc: null, parking: true, body: id };
}

// Destinations beyond the Earth–Moon system need a launch window.
export const isInterplanetary = (targetId) => {
  const body = TARGETS[targetId]?.body;
  return !!body && systemPlanet(body) !== 'earth';
};

// Launch time for an interplanetary window: shortly before the escape burn.
export const launchTimeFor = (window, nowMs) => Math.max(nowMs, window.departMs - DEPARTURE_LEAD);

// Resolve the inclination actually requested for a target from a given site.
export function targetInclination(targetId, altKm, site, customInc) {
  const t = TARGETS[targetId];
  if (t.inc === 'sso') return sunSyncInclination(altKm) * 180 / Math.PI;
  if (typeof t.inc === 'number') return t.inc;
  if (t.editableInc && Number.isFinite(customInc)) return customInc;
  return Math.abs(site.lat); // due east: the cheapest orbit from this site
}

export class Mission {
  // `window` (from findTransferWindow) is used for planets and their moons;
  // it is computed here if not supplied.
  constructor({ vehicle, payload, site, targetId, altitude, inclination, startMs, window = null }) {
    this.vehicle = vehicle;
    this.payload = payload;
    this.site = site;
    this.targetId = targetId;
    this.targetAlt = altitude;
    this.destination = TARGETS[targetId].body || null;
    this.launchMs = startMs + COUNTDOWN * 1000;
    this.createdMs = startMs;
    this.phase = 'countdown';
    this.frame = 'earth';
    this.events = [];
    this.burns = [];
    this.maneuvers = [];
    this.arc = null;
    this.status = '';
    this.trail = { earth: [] }; // per centre body
    this.groundTrack = [];      // [lat, lon] while in the Earth frame
    this.lastTrailMs = null;

    let planeNormal = null;
    if (targetId === 'moon') planeNormal = lunarPlaneNormal(site, this.launchMs);
    if (isInterplanetary(targetId)) {
      this.window = window || findTransferWindow(systemPlanet(this.destination), startMs, altitude, this.destination);
      // Launch into the plane that contains the escape direction.
      planeNormal = planeContaining(geoToEci(site.lat, site.lon, 1, this.launchMs), this.window.vInfDep);
    }
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
    while (guard++ < 30) {
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
          this.recordTrail(next.ms); // keep the flown path continuous across frame changes
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
    const body = BODIES[this.frame];
    if (!this.arc.hold && this.frame !== 'sun' && norm(this.r) < body.radius) {
      this.fail(ms, this.frame === 'earth' ? 'Orbit decayed: the vehicle re-entered and hit the surface.'
        : this.frame === 'moon' ? 'Impacted the lunar surface.' : `Impacted ${body.name}.`);
    }
  }

  // State on the current coast arc (relative to the current centre body).
  stateAtArc(ms) {
    const a = this.arc;
    if (a.hold) return { r: [...a.r], v: [0, 0, 0] };
    return propagate(a.r, a.v, (ms - a.ms) / 1000, a.mu);
  }

  setArc(ms, r, v, frame = this.frame, hold = false) {
    this.frame = frame;
    this.arc = { ms, r, v, mu: BODIES[frame].mu, center: frame, hold };
    this.r = r; this.v = v;
    if (!this.trail[frame]) this.trail[frame] = [];
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
    if (this.targetId === 'moon') {
      this.planBodyTransfer(tMs, 'moon', {
        tofs: [3, 3.5, 4, 4.5, 5].map((d) => d * 86400), span: el.period * 1.5, step: 60,
        name: 'Trans-lunar injection', performer: 'upper stage', upperStage: true,
      });
      return;
    }
    if (this.window) { this.planDeparture(tMs); return; }
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

  // Upper-stage burns are limited by the propellant left after the ascent.
  checkUpperStage(ms, dvVec, burnName) {
    const need = norm(dvVec) * 1000;
    const have = this.ascent.remainingDeltaV();
    if (need <= have + 1) return true;
    this.incomplete(ms, `Not enough propellant for ${burnName.charAt(0).toLowerCase() + burnName.slice(1)}: the upper stage has ${have.toFixed(0)} m/s left but needs ${need.toFixed(0)} m/s. Stranded in the parking orbit — try a lighter payload.`);
    return false;
  }

  burn(ms, name, dvVec, detail, performer) {
    const dv = norm(dvVec) * 1000;
    this.burns.push({ ms, name, dv, performer });
    this.log(ms, name, `${detail}${detail ? ' · ' : ''}Δv ${dv.toFixed(0)} m/s${performer ? ` (${performer})` : ''}`, 'burn');
  }

  schedule(ms, name, apply) {
    this.maneuvers.push({ ms, name, apply });
    this.maneuvers.sort((a, b) => a.ms - b.ms);
  }

  performer() {
    return this.vehicle.upperStageCanRestart ? 'upper stage restart' : 'payload thrusters';
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

  // GEO: burn at an equator crossing so apogee lands on the equator, then
  // circularise and remove the inclination at apogee.
  planGto(fromMs) {
    const tNode = findNextNode(this.arc, fromMs + 60000);
    this.log(fromMs, 'Parking orbit', 'Coasting to the equator crossing for GTO injection');
    this.schedule(tNode, 'GTO injection', (s, ms) => {
      const rm = norm(s.r);
      const vp = Math.sqrt((2 * MU_EARTH * R_GEO) / (rm * (rm + R_GEO)));
      const vNew = scale(unit(s.v), vp);
      if (!this.checkUpperStage(ms, sub(vNew, s.v), 'GTO injection')) return;
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

  // Scan departure times on the current orbit and flight times for the
  // cheapest Lambert arc to a body orbiting the current centre (the Moon from
  // Earth orbit, or a planet's moon from a capture orbit), then fly it.
  planBodyTransfer(fromMs, targetId, { tofs, span, step, name, performer, upperStage = false, includeArrival = false }) {
    const center = this.frame;
    const mu = BODIES[center].mu;
    const target = BODIES[targetId];
    const arrivalCost = (vRel) => (target.small ? vRel : escapeDeltaV(vRel, target.radius + target.orbitAlt, target.mu));
    let best = null;
    for (let dt = 300; dt < span; dt += step) {
      const ms = fromMs + dt * 1000;
      const s = this.stateAtArc(ms);
      for (const tof of tofs) {
        const tgt = stateRelTo(targetId, center, ms + tof * 1000);
        const sol = lambertDeltaV(s.r, s.v, tgt.r, tof, mu);
        if (!sol) continue;
        const cost = sol.dvMag + (includeArrival ? arrivalCost(norm(sub(sol.v2, tgt.v))) : 0);
        if (!best || cost < best.cost) best = { ...sol, ms, tof, cost };
      }
    }
    if (!best) { this.incomplete(fromMs, `No transfer to ${target.name} found from this orbit.`); return; }
    const days = best.tof / 86400;
    const when = days >= 1 ? `${days.toFixed(1)}-day coast` : `${(best.tof / 3600).toFixed(1)}-hour coast`;
    this.log(fromMs, targetId === 'moon' ? 'Parking orbit' : 'Transfer planned', `${name} planned: ${(best.dvMag * 1000).toFixed(0)} m/s, ${when}`);
    this.schedule(best.ms, name, (s, ms) => {
      // Re-solve from the exact state at the burn to keep the arrival accurate.
      const tgt = stateRelTo(targetId, center, best.ms + best.tof * 1000);
      let sol = lambertDeltaV(s.r, s.v, tgt.r, best.tof, mu) || best;
      if (targetId !== 'moon' && !target.small) {
        // Aim beside the moon, at the miss distance that makes the flyby's
        // periapsis equal the target orbit, so little correction is needed on arrival.
        const vRel = sub(sol.v2, tgt.v);
        let side = cross(vRel, orbitNormal(targetId));
        if (norm(side) < 1e-6 * norm(vRel)) side = cross(vRel, [0, 0, 1]);
        const rp = target.radius + target.orbitAlt;
        const b = rp * Math.sqrt(1 + (2 * target.mu) / (rp * dot(vRel, vRel)));
        const aimed = lambertDeltaV(s.r, s.v, add(tgt.r, scale(unit(side), b)), best.tof, mu);
        if (aimed) sol = aimed;
      }
      if (upperStage && !this.checkUpperStage(ms, sol.dv, name)) return;
      this.setArc(ms, s.r, sol.vDepart);
      const detail = targetId === 'moon' ? `Heading for the Moon, arrival in ${days.toFixed(1)} days` : `Heading for ${target.name}, arrival in ${days >= 1 ? `${days.toFixed(1)} days` : `${(best.tof / 3600).toFixed(1)} hours`}`;
      this.burn(ms, name, sol.dv, detail, performer);
      const arriveMs = ms + best.tof * 1000;
      if (target.small) {
        this.schedule(arriveMs, `Rendezvous with ${target.name}`, (s2, ms2) => this.rendezvous(s2, ms2, targetId));
        return;
      }
      const tSoi = findSoiEntry(this.arc, ms, arriveMs + (best.tof * 1000) / 2, targetId);
      if (tSoi == null) { this.log(ms, 'Warning', `Trajectory misses ${target.name}’s sphere of influence`, 'warn'); return; }
      this.schedule(tSoi, targetId === 'moon' ? 'Lunar SOI entry' : `Arrival at ${target.name}`, (s2, ms2) => this.enterMoonSoi(s2, ms2, targetId));
    });
  }

  // Arrival at a moon: trim for the target periapsis, then brake into a circular orbit.
  enterMoonSoi(s, ms, moonId) {
    const moon = BODIES[moonId];
    const m = stateRelTo(moonId, this.frame, ms);
    const rRel = sub(s.r, m.r), vRel = sub(s.v, m.v);
    const lunar = moonId === 'moon';
    this.log(ms, lunar ? 'Lunar SOI entry' : `Arrival at ${moon.name}`,
      lunar ? `Now dominated by lunar gravity at ${(norm(rRel) / 1000).toFixed(0)},000 km from the Moon`
        : `Entered ${moon.name}’s sphere of influence, ${Math.round(norm(rRel)).toLocaleString('en-US')} km away`);
    const alt = moon.orbitAlt;
    this.approach(ms, rRel, vRel, moonId, moon.radius + alt, null,
      lunar ? 'Mid-course correction' : 'Approach correction', `Aim ${lunar ? 'periselene' : 'periapsis'} at ${alt} km`, lunar ? 'spacecraft RCS' : 'spacecraft thrusters');
    const tPeri = ms + timeToApsis(this.arc, ms, 'peri') * 1000;
    const name = lunar ? 'Lunar orbit insertion' : `${moon.name} orbit insertion`;
    this.schedule(tPeri, name, (s2, ms2) => {
      const vCirc = scale(unit(cross(cross(s2.r, s2.v), s2.r)), Math.sqrt(moon.mu / norm(s2.r)));
      this.setArc(ms2, s2.r, vCirc, moonId);
      this.burn(ms2, name, sub(vCirc, s2.v), lunar ? `Captured into a ${alt} km lunar orbit` : `Captured into a ${alt} km orbit around ${moon.name}`, lunar ? 'service module engine' : 'spacecraft main engine');
      this.complete(ms2, lunar ? `In lunar orbit at ${alt} km` : `In orbit around ${moon.name} at ${alt} km`);
    });
  }

  // Moons too small to orbit (Phobos, Deimos): match their velocity and hold station.
  rendezvous(s, ms, moonId) {
    const moon = BODIES[moonId];
    const m = stateRelTo(moonId, this.frame, ms);
    let dir = sub(s.r, m.r);
    if (norm(dir) < 1e-3) dir = s.r;
    const rel = scale(unit(dir), moon.radius + STATION_KEEPING);
    this.setArc(ms, rel, [0, 0, 0], moonId, true);
    this.burn(ms, `Rendezvous with ${moon.name}`, sub(m.v, s.v), `Match ${moon.name}’s speed and hold station ${STATION_KEEPING} km above the surface`, 'spacecraft thrusters');
    this.complete(ms, `Holding station ${STATION_KEEPING} km from ${moon.name} (too small to orbit)`);
  }

  // Replace the approach velocity so the hyperbola's periapsis is at radius
  // rp: same speed (energy), rotated within a plane through the current
  // position — the plane closest to `preferredNormal` if given.
  approach(ms, rRel, vRel, center, rp, preferredNormal, name, detail, performer) {
    const mu = BODIES[center].mu;
    const rm = norm(rRel), vm = norm(vRel);
    const energy = (vm * vm) / 2 - mu / rm;
    const hNeed = rp * Math.sqrt(2 * (energy + mu / rp));
    const rhat = scale(rRel, 1 / rm);
    const vr = dot(vRel, rhat);
    let tdir = null;
    if (preferredNormal) {
      const n = sub(preferredNormal, scale(rhat, dot(preferredNormal, rhat)));
      if (norm(n) > 0.05) tdir = unit(cross(n, rhat));
    }
    if (!tdir) {
      tdir = sub(vRel, scale(rhat, vr));
      if (norm(tdir) < 1e-6) tdir = cross(rhat, [0, 0, 1]);
      tdir = unit(tdir);
    }
    const vt = Math.min(hNeed / rm, vm);
    const vrNew = -Math.sqrt(Math.max(0, vm * vm - vt * vt));
    const vNew = add(scale(rhat, vrNew), scale(tdir, vt));
    this.setArc(ms, rRel, vNew, center);
    this.burn(ms, name, sub(vNew, vRel), detail, performer);
  }

  // ------------------------------------------------------------ interplanetary

  // Escape burn from the parking orbit at the point where the departure
  // hyperbola's asymptote lines up with the required excess velocity.
  planDeparture(fromMs) {
    const w = this.window;
    const planet = BODIES[w.planetId];
    const name = `Trans-${planet.name} injection`;
    const r0 = norm(this.arc.r);
    const pHat = departurePoint(w.vInfDep, cross(this.arc.r, this.arc.v), r0);
    const tBurn = timeToDirection(this.arc, fromMs + 300e3, pHat);
    const waitDays = (w.departMs - fromMs) / 86400e3;
    this.log(fromMs, 'Parking orbit', `Escape burn to ${planet.name} planned: C3 ${w.c3.toFixed(1)} km²/s², ${(w.tofDays / 365.25 >= 1.5 ? `${(w.tofDays / 365.25).toFixed(1)}-year` : `${Math.round(w.tofDays)}-day`)} cruise${waitDays > 1 ? ` (window opens in ${waitDays.toFixed(0)} days)` : ''}`);
    this.schedule(tBurn, name, (s, ms) => {
      // Keep the planned arrival date: re-solve the heliocentric arc from now.
      const e = stateRelTo('earth', 'sun', ms);
      const p = stateRelTo(w.planetId, 'sun', w.arriveMs);
      const sol = solveLambert(e.r, p.r, (w.arriveMs - ms) / 1000, MU_SUN, ECLIPTIC_NORTH);
      const vInf = norm(sol ? sub(sol.v1, e.v) : w.vInfDep);
      const rm = norm(s.r);
      const vNew = scale(unit(cross(cross(s.r, s.v), s.r)), Math.sqrt(vInf * vInf + (2 * MU_EARTH) / rm));
      if (!this.checkUpperStage(ms, sub(vNew, s.v), name)) return;
      this.setArc(ms, s.r, vNew, 'earth');
      this.burn(ms, name, sub(vNew, s.v), `Escape from Earth at ${vInf.toFixed(2)} km/s excess speed`, 'upper stage');
      const tExit = findSoiExit(this.arc, ms, BODIES.earth.soi);
      this.schedule(tExit, 'Leaving Earth’s sphere of influence', (s2, ms2) => this.enterHeliocentric(s2, ms2));
    });
  }

  enterHeliocentric(s, ms) {
    const w = this.window;
    const planet = BODIES[w.planetId];
    const e = stateRelTo('earth', 'sun', ms);
    const r = add(s.r, e.r), v = add(s.v, e.v);
    this.setArc(ms, r, v, 'sun');
    this.log(ms, 'Leaving Earth’s sphere of influence', `${Math.round(norm(s.r)).toLocaleString('en-US')} km from Earth — now in orbit around the Sun`);
    // Trajectory correction: re-aim at the planet for the planned arrival date.
    const p = stateRelTo(w.planetId, 'sun', w.arriveMs);
    const sol = solveLambert(r, p.r, (w.arriveMs - ms) / 1000, MU_SUN, ECLIPTIC_NORTH);
    if (sol) {
      this.setArc(ms, r, sol.v1, 'sun');
      this.burn(ms, 'Trajectory correction', sub(sol.v1, v), `Aim for ${planet.name}, arrival ${new Date(w.arriveMs).toISOString().slice(0, 10)}`, 'spacecraft thrusters');
    }
    const tSoi = findSoiEntry(this.arc, ms, w.arriveMs + 60 * 86400e3, w.planetId);
    if (tSoi == null) { this.incomplete(ms, `The trajectory misses ${planet.name}.`); return; }
    this.schedule(tSoi, `Arrival at ${planet.name}`, (s2, ms2) => this.enterPlanetSoi(s2, ms2));
  }

  enterPlanetSoi(s, ms) {
    const planetId = this.window.planetId;
    const P = BODIES[planetId];
    const dest = this.destination;
    const ps = stateRelTo(planetId, 'sun', ms);
    const rRel = sub(s.r, ps.r), vRel = sub(s.v, ps.v);
    this.log(ms, `Arrival at ${P.name}`, `Entered ${P.name}’s sphere of influence ${(norm(rRel) / 1e6).toFixed(2)} million km out, approaching at ${norm(vRel).toFixed(2)} km/s`);
    const cap = captureOrbit(planetId, dest);
    // Arrive in the planet's equatorial plane (where its moons orbit).
    const planeNormal = dest === planetId ? P.poleDir : orbitNormal(dest);
    this.approach(ms, rRel, vRel, planetId, cap.rp, planeNormal, 'Approach correction', `Aim periapsis at ${Math.round(cap.rp - P.radius).toLocaleString('en-US')} km`, 'spacecraft thrusters');
    const tPeri = ms + timeToApsis(this.arc, ms, 'peri') * 1000;
    const name = `${P.name} orbit insertion`;
    this.schedule(tPeri, name, (s2, ms2) => {
      const rm = norm(s2.r);
      const vCap = Math.sqrt(P.mu * (2 / rm - 2 / (rm + cap.ra)));
      const vNew = scale(unit(s2.v), vCap);
      this.setArc(ms2, s2.r, vNew, planetId);
      const orbit = `${Math.round(rm - P.radius).toLocaleString('en-US')} × ${Math.round(cap.ra - P.radius).toLocaleString('en-US')} km`;
      this.burn(ms2, name, sub(vNew, s2.v), `Captured into a ${orbit} orbit`, 'spacecraft main engine');
      if (dest === planetId) { this.complete(ms2, `In orbit around ${P.name}: ${orbit}`); return; }
      const period = stateToElements(s2.r, vNew, P.mu).period;
      this.planBodyTransfer(ms2, dest, {
        tofs: [0.06, 0.1, 0.15, 0.22, 0.3, 0.4, 0.55, 0.7].map((f) => f * period),
        span: period * 1.2, step: period / 240,
        name: `Transfer to ${BODIES[dest].name}`, performer: 'spacecraft main engine', includeArrival: true,
      });
    });
  }

  // ------------------------------------------------------------ read-outs

  // Position of the vehicle relative to Earth's centre (ECI axes), km.
  positionEci(ms = this.now) {
    if (this.frame === 'earth' || this.phase === 'ascent' || this.phase === 'countdown') return this.r;
    return add(this.r, positionRelEarth(this.frame, ms));
  }

  velocityEci(ms = this.now) {
    if (this.frame === 'earth') return this.v;
    return add(this.v, stateRelTo(this.frame, 'earth', ms).v);
  }

  // Heliocentric position (equatorial axes), km.
  positionHelio(ms = this.now) {
    const center = this.phase === 'ascent' || this.phase === 'countdown' ? 'earth' : this.frame;
    return add(this.r, helioPosition(center, ms));
  }

  nextEvent() {
    if (this.phase === 'countdown') return { name: 'Liftoff', ms: this.launchMs };
    if (this.phase === 'coast' && this.maneuvers.length) return this.maneuvers[0];
    return null;
  }

  // Orbit through the current state, sampled for drawing (in the current frame).
  predictedPath() {
    if (this.phase === 'ascent') {
      const { r, v } = this.ascent.stateEci();
      return { frame: 'earth', points: samplePath(r, v, MU_EARTH, R_EARTH, 4 * 86400) };
    }
    if (this.phase !== 'coast' || this.arc.hold) return null;
    const next = this.nextEvent();
    const untilNext = next ? (next.ms - this.now) / 1000 : null;
    const body = BODIES[this.frame];
    const span = this.frame === 'sun' ? (untilNext ?? 2 * 365.25 * 86400) : (untilNext ? untilNext * 1.15 : 4 * 86400);
    return { frame: this.frame, points: samplePath(this.r, this.v, body.mu, this.frame === 'sun' ? 0 : body.radius, span, this.frame !== 'sun') };
  }

  elements() {
    if (this.phase === 'countdown' || this.phase === 'failed' || this.arc?.hold) return null;
    const body = BODIES[this.phase === 'ascent' ? 'earth' : this.frame];
    const el = stateToElements(this.r, this.v, body.mu);
    return { ...el, body: body.name, bodyId: body.id, periAlt: el.rp - body.radius, apoAlt: el.ra - body.radius };
  }

  totalDeltaV() {
    return (this.ascentDv || this.ascent.dvSpent) / 1000 + this.burns.reduce((s, b) => s + b.dv, 0) / 1000;
  }

  recordTrail(ms) {
    if (this.phase === 'countdown') { this.lastTrailMs = ms; return; }
    const list = this.trail[this.frame] || (this.trail[this.frame] = []);
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
    if (this.arc.hold) { this.lastTrailMs = ms; return; }
    // Coast: sample the analytic arc between the previous and current time.
    const from = Math.max(this.lastTrailMs ?? ms, this.arc.ms);
    const span = (ms - from) / 1000;
    if (span <= 0) return;
    const s = this.stateAtArc(ms);
    const rNow = norm(s.r);
    const vNow = norm(s.v);
    // About 1/360 of an orbit, or 1/300 of the time to travel the current distance.
    const step = Math.max(2, Math.min((2 * Math.PI * Math.sqrt(rNow ** 3 / this.arc.mu)) / 360, rNow / Math.max(vNow, 1e-6) / 300));
    const n = Math.min(400, Math.floor(span / step));
    for (let k = 1; k <= n; k++) {
      const t = from + (k * span * 1000) / (n + 1);
      pushPoint(this.stateAtArc(t).r, t);
    }
    pushPoint(s.r, ms);
    this.lastTrailMs = ms;
  }
}

// ------------------------------------------------------------ helpers

// Lunar missions launch into the plane that contains the Moon's expected
// arrival point, as Apollo did by picking the launch azimuth.
export function lunarPlaneNormal(site, launchMs) {
  return planeContaining(geoToEci(site.lat, site.lon, 1, launchMs), moonPositionEci(launchMs + 4.1 * 86400e3));
}

// Points along the conic through (r, v): a full revolution for closed orbits
// (or up to `openSpan` when fullOrbit is false), otherwise `openSpan` seconds.
function samplePath(r, v, mu, bodyRadius, openSpan, fullOrbit = true) {
  const el = stateToElements(r, v, mu);
  const pts = [];
  const span = el.e < 1 ? (fullOrbit ? el.period : Math.min(el.period, openSpan)) : openSpan;
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

// Next time (after fromMs) that the position on a near-circular arc points
// along `dir`.
function timeToDirection(arc, fromMs, dir) {
  let t = fromMs;
  for (let k = 0; k < 4; k++) {
    const s = propagate(arc.r, arc.v, (t - arc.ms) / 1000, arc.mu);
    const h = unit(cross(s.r, s.v));
    const rh = unit(s.r);
    let ang = Math.atan2(dot(h, cross(rh, dir)), dot(rh, dir));
    if (k === 0 && ang < 0) ang += 2 * Math.PI;
    const n = norm(s.v) / norm(s.r);
    t += (ang / n) * 1000;
  }
  return t;
}

// First time the arc leaves a sphere of radius `soi` around its centre.
function findSoiExit(arc, fromMs, soi) {
  const r = (ms) => norm(propagate(arc.r, arc.v, (ms - arc.ms) / 1000, arc.mu).r);
  let lo = fromMs, hi = fromMs + 3600e3;
  while (r(hi) < soi && hi - fromMs < 400 * 86400e3) { lo = hi; hi = fromMs + (hi - fromMs) * 2; }
  for (let i = 0; i < 50; i++) {
    const m = (lo + hi) / 2;
    if (r(m) < soi) lo = m; else hi = m;
  }
  return hi;
}

// First time the arc enters `targetId`'s sphere of influence. The step size
// adapts to the remaining distance and closing speed, so it neither skips a
// small sphere nor crawls across a long cruise.
function findSoiEntry(arc, fromMs, untilMs, targetId) {
  const soi = BODIES[targetId].soi;
  const gap = (ms) => {
    const s = propagate(arc.r, arc.v, (ms - arc.ms) / 1000, arc.mu);
    const b = stateRelTo(targetId, arc.center, ms);
    return { d: dist(s.r, b.r) - soi, v: norm(sub(s.v, b.v)) };
  };
  let prev = fromMs;
  let t = fromMs;
  for (let k = 0; k < 20000 && t <= untilMs; k++) {
    const { d, v } = gap(t);
    if (d < 0) {
      let a = prev, b = t;
      for (let i = 0; i < 50; i++) {
        const m = (a + b) / 2;
        if (gap(m).d < 0) b = m; else a = m;
      }
      return b;
    }
    prev = t;
    t += Math.max(1000, Math.min(30 * 86400e3, (0.3 * d / Math.max(v, 0.01)) * 1000));
  }
  return null;
}
