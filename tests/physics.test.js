// Physics sanity checks. Run with: npm test  (Node 18+, no dependencies)

import test from 'node:test';
import assert from 'node:assert/strict';

import { AU, DEG, MU_EARTH } from '../js/core/constants.js';
import { moonPositionEci, planetPositionHelio, PLANETS, sunPositionEci } from '../js/core/ephemeris.js';
import { solveLambert } from '../js/core/lambert.js';
import { Ascent } from '../js/core/ascent.js';
import { assessMission, maxPayload } from '../js/core/planner.js';
import { Mission, R_GEO, TARGETS, launchTimeFor } from '../js/core/mission.js';
import { BODIES, systemPlanet } from '../js/core/bodies.js';
import { findTransferWindow } from '../js/core/interplanetary.js';
import { elementsToState, propagate, stateToElements, sunSyncInclination } from '../js/core/orbits.js';
import { eciToGeo } from '../js/core/time.js';
import { dist, norm } from '../js/core/vec.js';
import { buildCatalog } from '../js/data/catalog.js';
import { SITES } from '../js/data/sites.js';
import { VEHICLES } from '../js/data/vehicles.js';

const T0 = Date.UTC(2026, 8, 26, 12);
const site = (id) => SITES.find((s) => s.id === id);
const vehicle = (id) => VEHICLES.find((v) => v.id === id);
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);

test('elements -> state -> elements round trip', () => {
  const el = { a: 12000, e: 0.3, i: 40 * DEG, raan: 1.1, argp: 2.2, M: 0.7 };
  const { r, v } = elementsToState(el);
  const back = stateToElements(r, v);
  close(back.a, el.a, 1e-6, 'a');
  close(back.e, el.e, 1e-9, 'e');
  close(back.i, el.i, 1e-9, 'i');
  close(back.raan, el.raan, 1e-9, 'raan');
  close(back.argp, el.argp, 1e-9, 'argp');
});

test('universal propagation returns to start after one period and conserves energy', () => {
  const { r, v } = elementsToState({ a: 26600, e: 0.74, i: 63.4 * DEG, raan: 0.3, argp: 270 * DEG, M: 0.2 });
  const period = 2 * Math.PI * Math.sqrt(26600 ** 3 / MU_EARTH);
  const after = propagate(r, v, period);
  assert.ok(dist(after.r, r) < 1e-3, 'position repeats');
  const half = propagate(r, v, period / 2.7);
  const energy = (s) => norm(s.v) ** 2 / 2 - MU_EARTH / norm(s.r);
  close(energy(half), energy({ r, v }), 1e-9, 'energy');
});

test('Lambert solution reaches the target in the requested time', () => {
  const r1 = [7000, 0, 0];
  const r2 = [-2000, 30000, 5000];
  const tof = 5 * 3600;
  const sol = solveLambert(r1, r2, tof);
  assert.ok(sol, 'solution exists');
  const end = propagate(r1, sol.v1, tof);
  assert.ok(dist(end.r, r2) < 1, `miss distance ${dist(end.r, r2)} km`);
});

test('sun-synchronous inclination at 700 km is about 98.2°', () => {
  close(sunSyncInclination(700) / DEG, 98.19, 0.05, 'inclination');
});

test('ephemerides give sensible distances', () => {
  close(norm(sunPositionEci(T0)) / AU, 1.0, 0.02, 'Sun distance (AU)');
  const moon = norm(moonPositionEci(T0));
  assert.ok(moon > 356000 && moon < 407000, `Moon distance ${moon}`);
  const mars = norm(planetPositionHelio(PLANETS.find((p) => p.name === 'Mars'), T0)) / AU;
  assert.ok(mars > 1.38 && mars < 1.67, `Mars heliocentric distance ${mars}`);
});

test('geostationary satellites sit over their station longitude', () => {
  const cat = buildCatalog(T0);
  const goes = cat.find((o) => o.name.startsWith('GOES-16'));
  for (const dt of [0, 6, 17]) {
    const t = T0 + dt * 3600e3;
    close(eciToGeo(goes.orbit.positionAt(t), t).lon, -75.2, 0.3, `longitude after ${dt} h`);
  }
});

test('Falcon 9 reaches a 200 km orbit from Kennedy', () => {
  const v = vehicle('falcon9');
  const a = new Ascent({ vehicle: v, payload: v.defaultPayload, site: site('ksc'), launchMs: T0, targetAlt: 200, inclination: 28.6 });
  a.advanceTo(1200);
  assert.equal(a.status, 'inserted');
  const t = a.telemetry();
  close(t.periapsisAlt, 200, 15, 'perigee');
  close(t.apoapsisAlt, 200, 15, 'apogee');
});

test('an overloaded rocket fails to reach orbit', () => {
  const v = vehicle('electron');
  const a = new Ascent({ vehicle: v, payload: 900, site: site('mahia'), launchMs: T0, targetAlt: 400, inclination: 45 });
  a.advanceTo(4000);
  assert.equal(a.status, 'failed');
});

function flyMission(opts, days) {
  const m = new Mission({ startMs: T0, ...opts });
  for (let t = T0; t <= T0 + days * 86400e3; t += 60e3) m.update(t);
  return m;
}

test('sun-synchronous mission circularises at the target altitude', () => {
  const v = vehicle('pslv');
  const inc = sunSyncInclination(600) / DEG;
  const m = flyMission({ vehicle: v, payload: 1750, site: site('shar'), targetId: 'sso', altitude: 600, inclination: inc }, 0.2);
  const el = m.elements();
  close(el.periAlt, 600, 15, 'perigee');
  close(el.apoAlt, 600, 15, 'apogee');
  close(el.i / DEG, inc, 0.2, 'inclination');
});

test('GEO mission ends on station with ~2.4 + ~1.8 km/s of transfer burns', () => {
  const v = vehicle('falcon9');
  const m = flyMission({ vehicle: v, payload: 5500, site: site('ksc'), targetId: 'geo', altitude: 200, inclination: 28.6 }, 1);
  close(norm(m.r), R_GEO, 1, 'radius');
  close(m.elements().i / DEG, 0, 0.1, 'inclination');
  const gto = m.burns.find((b) => b.name === 'GTO injection');
  close(gto.dv, 2450, 120, 'GTO injection Δv');
});

test('Saturn V mission ends in a 100 km lunar orbit', () => {
  const v = vehicle('saturnv');
  const m = flyMission({ vehicle: v, payload: 45000, site: site('ksc'), targetId: 'moon', altitude: 185, inclination: 28.6 }, 6);
  assert.equal(m.frame, 'moon');
  const el = m.elements();
  close(el.periAlt, 100, 1, 'periselene');
  close(el.apoAlt, 100, 1, 'aposelene');
  const tli = m.burns.find((b) => b.name === 'Trans-lunar injection');
  assert.ok(tli.dv > 3000 && tli.dv < 3300, `TLI Δv ${tli.dv}`);
  assert.ok(norm(m.positionEci()) > 300000, 'far from Earth');
});

test('a payload too heavy for the Moon is reported as incomplete, not complete', () => {
  const v = vehicle('falcon9');
  const m = flyMission({ vehicle: v, payload: 15000, site: site('ksc'), targetId: 'moon', altitude: 185, inclination: 28.6 }, 1);
  const names = m.events.map((e) => e.name);
  assert.ok(names.includes('Mission incomplete'), names.join(', '));
  assert.ok(!names.includes('Mission complete'), 'must not claim success');
  assert.equal(m.frame, 'earth');
});

test('the planner’s payload limit matches what the full mission can do', () => {
  const v = vehicle('falcon9');
  const opts = { vehicle: v, site: site('ksc'), targetId: 'geo', altitude: 200, inclination: 28.6, launchMs: T0 + 10000 };
  const max = maxPayload(opts);
  assert.ok(max > 6000 && max < 10000, `Falcon 9 GTO limit ${max} kg`);
  assert.equal(assessMission({ ...opts, payload: 15000 }).feasible, false);
  const m = flyMission({ vehicle: v, payload: Math.floor(max * 0.95), site: site('ksc'), targetId: 'geo', altitude: 200, inclination: 28.6 }, 1);
  assert.ok(m.events.some((e) => e.name === 'Mission complete'), m.status);
  assert.equal(maxPayload({ ...opts, vehicle: vehicle('electron') }), 0, 'Electron cannot reach GEO');
});

// ------------------------------------------------------------ interplanetary

// Fly a mission by jumping from event to event (coasts are analytic).
function flyToEnd(m, start) {
  let t = start;
  while (m.phase === 'countdown' || m.phase === 'ascent') { t += 1000; m.update(t); if (t - start > 4000e3) break; }
  for (let k = 0; k < 40; k++) {
    const ev = m.nextEvent();
    if (!ev) break;
    t = Math.max(t, ev.ms + 1);
    m.update(t);
  }
  m.update(t + 86400e3);
  return m;
}

function flyInterplanetary(vehicleId, targetId, payload, from = T0) {
  const dest = TARGETS[targetId].body;
  const window = findTransferWindow(systemPlanet(dest), from, 200, dest);
  const start = launchTimeFor(window, from) - 10000;
  const m = new Mission({ vehicle: vehicle(vehicleId), payload, site: site('ksc'), targetId, altitude: 200, inclination: 28.6, startMs: start, window });
  return flyToEnd(m, start);
}

test('the launch-window search reproduces the 2020 Mars window (Perseverance)', () => {
  const w = findTransferWindow('mars', Date.UTC(2020, 4, 1));
  const days = (a, b) => Math.abs(a - b) / 86400e3;
  assert.ok(days(w.departMs, Date.UTC(2020, 6, 30)) < 10, `departure ${new Date(w.departMs).toISOString()}`);
  assert.ok(days(w.arriveMs, Date.UTC(2021, 1, 18)) < 10, `arrival ${new Date(w.arriveMs).toISOString()}`);
  assert.ok(w.c3 > 11 && w.c3 < 17, `C3 ${w.c3}`);
});

test('Falcon Heavy puts a spacecraft into Mars orbit', () => {
  const m = flyInterplanetary('falconheavy', 'mars', 10000);
  assert.equal(m.frame, 'mars', m.status);
  assert.ok(m.events.some((e) => e.name === 'Mission complete'), m.status);
  const el = m.elements();
  close(el.periAlt, 400, 5, 'periapsis');
  const moi = m.burns.find((b) => b.name === 'Mars orbit insertion');
  assert.ok(moi.dv > 600 && moi.dv < 1300, `Mars orbit insertion ${moi.dv} m/s`);
});

test('SLS reaches a 100 km orbit around Europa', () => {
  const m = flyInterplanetary('sls', 'europa', 2000);
  assert.equal(m.frame, 'europa', m.status);
  const el = m.elements();
  close(el.periAlt, 100, 1, 'periapsis');
  close(el.apoAlt, 100, 1, 'apoapsis');
});

test('a Phobos mission ends holding station (Phobos is too small to orbit)', () => {
  const m = flyInterplanetary('falconheavy', 'phobos', 5000);
  assert.equal(m.frame, 'phobos', m.status);
  assert.ok(m.arc.hold, 'holding station');
  close(norm(m.r) - BODIES.phobos.radius, 20, 0.01, 'height above Phobos');
});

test('planner limits for the outer planets are plausible', () => {
  const now = T0;
  const jw = findTransferWindow('jupiter', now);
  const opts = { site: site('ksc'), targetId: 'jupiter', altitude: 200, inclination: 28.6, launchMs: now + 10000, window: jw };
  assert.equal(maxPayload({ ...opts, vehicle: vehicle('electron') }), 0, 'Electron cannot reach Jupiter');
  const sls = maxPayload({ ...opts, vehicle: vehicle('sls') });
  assert.ok(sls > 3000 && sls < 9000, `SLS to Jupiter ${sls} kg`);
});
