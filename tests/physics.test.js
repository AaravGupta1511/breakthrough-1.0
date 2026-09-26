// Physics sanity checks. Run with: npm test  (Node 18+, no dependencies)

import test from 'node:test';
import assert from 'node:assert/strict';

import { AU, DEG, MU_EARTH } from '../js/core/constants.js';
import { moonPositionEci, planetPositionHelio, PLANETS, sunPositionEci } from '../js/core/ephemeris.js';
import { solveLambert } from '../js/core/lambert.js';
import { Ascent } from '../js/core/ascent.js';
import { Mission, R_GEO } from '../js/core/mission.js';
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
