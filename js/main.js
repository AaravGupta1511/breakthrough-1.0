// Simulator app: wires the physics, the 3D views and the DOM panels together.

import * as THREE from 'three';
import { AU, DEG, MU_EARTH, OMEGA_EARTH, R_EARTH, R_MOON } from './core/constants.js';
import { inEarthShadow, moonPositionEci, sunPositionEci } from './core/ephemeris.js';
import { corridorText, lowestInclination, planLaunch } from './core/ascent.js';
import { BODIES, MOON_IDS, PLANET_IDS, helioPosition, positionRelEarth, systemPlanet } from './core/bodies.js';
import { findTransferWindow } from './core/interplanetary.js';
import { Mission, TARGETS, inclinationIsMandatory, isInterplanetary, launchTimeFor, targetInclination } from './core/mission.js';
import { assessMission, maxPayload } from './core/planner.js';
import { stateToElements } from './core/orbits.js';
import { Population, nearestObjects } from './core/population.js';
import { eciToGeo, formatDuration, formatUtc, geoToEci } from './core/time.js';
import { dist, norm, sub } from './core/vec.js';
import { CATEGORIES, buildCatalog, generateDebris } from './data/catalog.js';
import { SITES } from './data/sites.js';
import { VEHICLES, liftoffMass, vehicleDeltaV } from './data/vehicles.js';
import { EarthView, eciToWorld } from './view/earthView.js';
import { GroundTrackMap } from './view/groundTrack.js';
import { LabelLayer } from './view/labels.js';
import { SolarView } from './view/solarView.js';

const $ = (id) => document.getElementById(id);
const WARPS = [1, 2, 5, 10, 30, 60, 120, 300, 600, 1800, 3600, 10800, 43200, 86400, 604800, 2592000, 31557600];
const ASCENT_MAX_WARP = 50;
const DEFAULT_DEBRIS = 4000;
const LIGHT_SPEED = 299792.458; // km/s

// ------------------------------------------------------------------ helpers

const fmt = (x, d = 0) => (Number.isFinite(x) ? x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
function fmtDist(km) {
  if (!Number.isFinite(km)) return '—';
  if (km < 1) return `${fmt(km * 1000)} m`;
  if (km < 1e6) return `${fmt(km, km < 100 ? 1 : 0)} km`;
  if (km < 0.1 * AU) return `${fmt(km / 1e6, 2)} million km`;
  return `${fmt(km / AU, 3)} AU`;
}
function fmtLight(km) {
  const s = km / LIGHT_SPEED;
  if (s < 60) return `${fmt(s, 2)} light-s`;
  if (s < 3600) return `${fmt(s / 60, 1)} light-min`;
  return `${fmt(s / 3600, 2)} light-h`;
}
function fmtPeriod(sec) {
  if (!Number.isFinite(sec)) return 'escape';
  if (sec < 7200) return `${fmt(sec / 60, 1)} min`;
  if (sec < 172800) return `${fmt(sec / 3600, 2)} h`;
  return `${fmt(sec / 86400, 2)} days`;
}
function fmtWarp(w) {
  if (w < 60) return `${w}×`;
  const per = w >= 31557600 ? `${fmt(w / 31557600)} yr/s` : w >= 86400 ? `${fmt(w / 86400, w % 86400 ? 1 : 0)} d/s` : w >= 3600 ? `${fmt(w / 3600, w % 3600 ? 1 : 0)} h/s` : `${fmt(w / 60)} min/s`;
  return `${fmt(w)}× · ${per}`;
}
const fmtDate = (ms) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const fmtDuration = (days) => (days >= 548 ? `${fmt(days / 365.25, 1)} years` : days >= 60 ? `${fmt(days / 30.44, 1)} months` : `${fmt(days, 1)} days`);
const fmtLatLon = (g) => `${fmt(Math.abs(g.lat), 2)}°${g.lat >= 0 ? 'N' : 'S'}, ${fmt(Math.abs(g.lon), 2)}°${g.lon >= 0 ? 'E' : 'W'}`;
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rows = (pairs) => pairs.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');

function showFatal(html) {
  const f = $('fatal');
  f.innerHTML = html;
  f.hidden = false;
  $('boot').hidden = true;
}

// ------------------------------------------------------------------ boot

// Optional start time: simulator.html?time=2026-12-01T12:00:00Z
const startParam = Date.parse(new URLSearchParams(location.search).get('time') || '');
const bootMs = Number.isFinite(startParam) ? startParam : Date.now();
const state = {
  simMs: bootMs,
  warpIndex: 0,
  playing: true,
  mission: null,
  selected: null,
  tracking: 'selected',
  hovered: null,
  view: 'earth',
  nearest: [],
  threshold: 50,
  alerts: new Map(),
  eventsShown: -1,
  bannerUntil: 0,
};

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas: $('scene'), antialias: true, logarithmicDepthBuffer: true });
} catch (err) {
  showFatal('<h2>WebGL is not available</h2><p>This simulator draws with WebGL. Try a current version of Chrome, Firefox, Safari or Edge, and make sure hardware acceleration is enabled.</p>');
  throw err;
}
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.setClearColor(0x02040a);

const earthView = new EarthView(renderer, SITES);
const solarView = new SolarView(renderer);
const labels = new LabelLayer($('viewport'));
const groundMap = new GroundTrackMap($('map'));

// Catalogue populations, one per category.
const catalog = buildCatalog(bootMs);
const pops = {};
for (const cat of Object.keys(CATEGORIES)) {
  const objs = catalog.filter((o) => o.cat === cat);
  if (!objs.length) continue;
  pops[cat] = new Population(cat, objs);
  pops[cat].update(state.simMs);
  earthView.setLayer(cat, pops[cat]);
}
function setDebris(count) {
  pops.debris = new Population('debris', generateDebris(count, bootMs));
  pops.debris.update(state.simMs);
  earthView.setLayer('debris', pops.debris);
  if (state.selected && state.selected.cat === 'debris') select(null);
}
setDebris(DEFAULT_DEBRIS);

// ------------------------------------------------------------------ tracking

const trackingCraft = () => state.tracking === 'craft' && state.mission;
function trackedPosition() {
  if (trackingCraft()) return state.mission.positionEci();
  return state.selected ? state.selected.getPosition() : null;
}
function trackedVelocity() {
  if (trackingCraft()) return state.mission.velocityEci();
  return state.selected ? state.selected.orbit.stateAt(state.simMs).v : null;
}

function select(obj, follow = false) {
  state.selected = obj;
  if (obj) state.tracking = 'selected';
  else if (state.mission) state.tracking = 'craft';
  if (follow && obj) setView('follow');
  else if (state.view === 'follow') setView('follow');
  updateUi(true);
}

function trackCraft() {
  if (!state.mission) return;
  state.tracking = 'craft';
  if (state.view === 'follow') setView('follow');
  updateUi(true);
}

// ------------------------------------------------------------------ views

// Views: 'earth' | 'follow' | 'earthmoon' | 'solar' | 'body:<id>' (Moon, planets, moons).
function setView(view) {
  state.view = view;
  document.querySelectorAll('.views button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  const bodySel = $('view-body');
  bodySel.classList.toggle('active', view.startsWith('body:'));
  if (!view.startsWith('body:')) bodySel.value = '';
  earthView.controls.enabled = view !== 'solar';
  solarView.controls.enabled = view === 'solar';
  labels.clear();
  if (view === 'solar') return;
  if (view === 'follow') {
    if (!trackedPosition()) { setView('earth'); return; }
    const m = state.mission;
    // Away from Earth, look "down" on the craft from the side of the body it
    // orbits, far enough back to see that orbit.
    const away = trackingCraft() && m.frame !== 'earth' && (m.phase === 'coast' || m.phase === 'failed');
    const dist = away ? Math.max(1500, Math.min(norm(m.r) * 0.8, 5e7)) : trackingCraft() ? 1500 : 900;
    earthView.setView('follow', trackedPosition, dist, away ? eciToWorld(m.r) : null);
  } else if (view.startsWith('body:')) {
    const id = view.slice(5);
    bodySel.value = id;
    if (id === 'moon') { earthView.setView('moon'); return; }
    const b = BODIES[id];
    // Look from the sunlit side, slightly above the body's equator.
    const sunward = eciToWorld(helioPosition(id, state.simMs)).multiplyScalar(-1).normalize();
    earthView.setView('body', () => positionRelEarth(id, state.simMs), b.radius * 5, sunward.add(new THREE.Vector3(0, 0.45, 0)));
  } else {
    earthView.setView(view);
  }
}
document.querySelectorAll('.views button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
$('view-body').innerHTML = '<option value="">Planets & moons…</option><option value="moon">Moon</option>'
  + PLANET_IDS.map((p) => {
    const moons = BODIES[p].moons.map((m) => `<option value="${m}">&nbsp;&nbsp;${BODIES[m].name}</option>`).join('');
    return `<option value="${p}">${BODIES[p].name}</option>${moons}`;
  }).join('');
$('view-body').addEventListener('change', (e) => { if (e.target.value) setView(`body:${e.target.value}`); });

// ------------------------------------------------------------------ time controls

const currentWarp = () => {
  const w = WARPS[state.warpIndex];
  const m = state.mission;
  const limited = m && (m.phase === 'countdown' || m.phase === 'ascent') && w > ASCENT_MAX_WARP;
  return { warp: limited ? ASCENT_MAX_WARP : w, limited };
};
const setWarp = (i) => { state.warpIndex = Math.max(0, Math.min(WARPS.length - 1, i)); updateUi(true); };
$('btn-slower').onclick = () => setWarp(state.warpIndex - 1);
$('btn-faster').onclick = () => setWarp(state.warpIndex + 1);
$('btn-play').onclick = () => { state.playing = !state.playing; updateUi(true); };
$('btn-now').onclick = () => {
  const now = Date.now();
  if (state.mission && now < state.simMs) { flash('Time can’t run backwards during a mission — reset it first'); setWarp(0); return; }
  state.simMs = now;
  setWarp(0);
};
$('btn-next').onclick = () => {
  const ev = state.mission && state.mission.nextEvent();
  if (!ev) return;
  const lead = ev.name === 'Liftoff' ? 0 : 20000;
  state.simMs = Math.max(state.simMs, ev.ms - lead);
  if (state.warpIndex > 3) setWarp(3);
};
window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); $('btn-play').click(); }
  else if (e.key === '+' || e.key === '=') setWarp(state.warpIndex + 1);
  else if (e.key === '-' || e.key === '_') setWarp(state.warpIndex - 1);
  else if (e.key.toLowerCase() === 'n') $('btn-next').click();
});

// ------------------------------------------------------------------ mission form

const siteSel = $('site'), vehSel = $('vehicle'), tgtSel = $('target');
const payloadIn = $('payload'), altIn = $('altitude'), incIn = $('inclination');
siteSel.innerHTML = SITES.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
vehSel.innerHTML = VEHICLES.map((v) => `<option value="${v.id}">${escapeHtml(v.name)} — ${escapeHtml(v.operator)}</option>`).join('');
{
  const groups = {};
  for (const [id, t] of Object.entries(TARGETS)) (groups[t.group] ||= []).push(`<option value="${id}">${escapeHtml(t.label)}</option>`);
  tgtSel.innerHTML = Object.entries(groups).map(([g, opts]) => `<optgroup label="${escapeHtml(g)}">${opts.join('')}</optgroup>`).join('');
}

const getSite = () => SITES.find((s) => s.id === siteSel.value);
const getVehicle = () => VEHICLES.find((v) => v.id === vehSel.value);

function applyTargetDefaults() {
  const t = TARGETS[tgtSel.value];
  const site = getSite();
  altIn.value = t.alt;
  altIn.disabled = !t.editableAlt;
  if (t.editableInc) {
    incIn.disabled = false;
    incIn.value = lowestInclination(site).toFixed(1);
    incIn.placeholder = '';
  } else if (TARGETS[tgtSel.value].body) {
    incIn.disabled = true; incIn.value = ''; incIn.placeholder = 'auto';
  } else {
    incIn.disabled = true;
    incIn.value = targetInclination(tgtSel.value, +altIn.value, site).toFixed(1);
  }
}

function updatePlan() {
  const v = getVehicle(), site = getSite(), tid = tgtSel.value, t = TARGETS[tid];
  const payload = Math.max(0, +payloadIn.value || 0);
  const mass = liftoffMass(v, payload);
  const dv = vehicleDeltaV(v, payload) / 1000;
  const twr = v.phases[0].thrustSL / (mass * 9.80665);
  $('vehicle-info').innerHTML = `${escapeHtml(v.operator)} · liftoff ${fmt(mass / 1000)} t · thrust/weight ${fmt(twr, 2)} · ideal Δv ${fmt(dv, 2)} km/s · up to ${fmt(v.payloadLEO / 1000, 1)} t to LEO`;

  if (!t.editableInc && !t.body) incIn.value = targetInclination(tid, +altIn.value, site).toFixed(1);
  const alt = +altIn.value;
  const lines = [];
  if (tid === 'moon') {
    lines.push('Parking orbit aligned with the Moon’s arrival point, then trans-lunar injection and lunar orbit insertion.');
  } else if (isInterplanetary(tid)) {
    const b = BODIES[t.body];
    const planet = BODIES[systemPlanet(t.body)];
    lines.push(`Parking orbit aligned with the escape direction, then an escape burn at the launch window, a trajectory correction, and capture at ${planet.name}${b !== planet ? `, followed by a transfer to ${b.name}${b.small ? ' and a rendezvous (it is too small to orbit)' : ' and orbit insertion'}` : ''}.`);
  } else {
    const inc = tid === 'leo' ? +incIn.value : targetInclination(tid, alt, site);
    const plan = planLaunch(site, inc, { mandatory: inclinationIsMandatory(tid), launchMs: state.simMs });
    state.launchPlan = plan;
    const vRot = OMEGA_EARTH * R_EARTH * Math.cos(site.lat * DEG) * Math.sin(plan.targetAz * DEG);
    const need = Math.sqrt(MU_EARTH / (R_EARTH + alt)) + 1.6 - vRot;
    lines.push(`Launch azimuth ${fmt(plan.launchAz, 0)}° · Earth’s spin ${vRot >= 0 ? 'adds' : 'costs'} ${fmt(Math.abs(vRot) * 1000)} m/s · ≈ ${fmt(need, 1)} km/s to orbit incl. losses`);
    if (plan.dogleg) {
      lines.push(`<span class="warn">Range safety: ${escapeHtml(site.short)} may only launch ${corridorText(site)} (${escapeHtml(site.range)}). The ${fmt(plan.inclination, 1)}° orbit needs a heading of ${fmt(plan.targetAz, 0)}°, so the rocket flies ${fmt(plan.launchAz, 0)}° first and makes a <b>dogleg</b> turn during the upper-stage burns, which costs payload.</span>`);
    } else if (plan.adjusted) {
      lines.push(`<span class="warn">Range safety: ${escapeHtml(site.short)} may only launch ${corridorText(site)} (${escapeHtml(site.range)}), so this orbit will be inclined ${fmt(plan.inclination, 1)}°.</span>`);
    } else if (lowestInclination(site) > Math.abs(site.lat) + 0.5 && Math.abs(plan.inclination - lowestInclination(site)) < 0.1) {
      lines.push(`Range safety: ${escapeHtml(site.short)} may only launch ${corridorText(site)} (${escapeHtml(site.range)}), so the lowest inclination from here is ${fmt(plan.inclination, 1)}° rather than ${fmt(Math.abs(site.lat), 1)}°.`);
    }
    if (plan.clamped) lines.push(`<span class="warn">Lowest inclination reachable from ${escapeHtml(site.short)} is ${fmt(Math.abs(site.lat), 1)}°.</span>`);
  }
  if (tid === 'moon' || isInterplanetary(tid)) state.launchPlan = null;
  if (tid === 'geo') lines.push('Then GTO injection (~2.4 km/s) at an equator crossing and a GEO apogee burn by the satellite.');
  if (payload > v.payloadLEO) lines.push(`<span class="warn">Payload exceeds this rocket’s ${fmt(v.payloadLEO)} kg LEO capacity — expect a failure.</span>`);
  if (twr < 1) lines.push('<span class="warn">Thrust-to-weight below 1: the rocket cannot leave the pad.</span>');
  $('plan-info').innerHTML = lines.join('<br>');
}

// ------------------------------------------------------------ flight-plan check
// Flies the ascent model ahead of time to tell whether the chosen rocket and
// payload can actually reach the destination, and suggests a payload if not.

const DESTINATION = { leo: 'orbit', iss: 'the ISS orbit', sso: 'sun-synchronous orbit', polar: 'polar orbit', geo: 'geostationary orbit', moon: 'the Moon' };
const DEPARTURE_BURN = { geo: 'GTO injection', moon: 'trans-lunar injection' };
for (const id of [...PLANET_IDS, ...MOON_IDS]) {
  DESTINATION[id] = BODIES[id].name;
  DEPARTURE_BURN[id] = `the escape burn to ${BODIES[systemPlanet(id)].name}`;
}

// Launch windows are cached per destination and day.
const windowCache = new Map();
function launchWindow(targetId = tgtSel.value) {
  if (!isInterplanetary(targetId)) return null;
  const dest = TARGETS[targetId].body;
  const day = Math.floor(state.simMs / 86400e3);
  const key = `${dest}|${day}`;
  if (!windowCache.has(key)) windowCache.set(key, findTransferWindow(systemPlanet(dest), day * 86400e3, 200, dest));
  return windowCache.get(key);
}
let planTimer = null;
let adjustPayload = false; // may lower the payload on the next check
let payloadIsAuto = false; // the current payload was chosen by the app

const readAltitude = () => Math.min(2000, Math.max(150, +altIn.value || TARGETS[tgtSel.value].alt));
function planOptions(payload, vehicle = getVehicle()) {
  const site = getSite(), targetId = tgtSel.value, altitude = readAltitude();
  return {
    vehicle, site, targetId, altitude, payload,
    inclination: targetInclination(targetId, altitude, site, +incIn.value),
    launchMs: state.simMs + 10000,
    window: launchWindow(targetId),
  };
}

function schedulePlanCheck(adjust = false) {
  adjustPayload = adjustPayload || adjust;
  clearTimeout(planTimer);
  planTimer = setTimeout(runPlanCheck, 120);
}

function runPlanCheck() {
  const box = $('plan-check');
  const v = getVehicle(), tid = tgtSel.value, dest = DESTINATION[tid];
  const burn = DEPARTURE_BURN[tid];
  let payload = Math.max(0, +payloadIn.value || 0);
  let res = assessMission(planOptions(payload));
  let note = '';
  let max = null;
  if (!res.feasible) {
    max = maxPayload(planOptions(0));
    if (adjustPayload && max > 0) {
      const step = max > 2000 ? 100 : 10;
      payload = Math.max(step, Math.floor((max * 0.95) / step) * step);
      payloadIn.value = payload;
      payloadIsAuto = true;
      updatePlan();
      res = assessMission(planOptions(payload));
      note = `<br><span class="muted">Payload set to ${fmt(payload)} kg, about the most the ${escapeHtml(v.name)} can send to ${dest}.</span>`;
    }
  }
  adjustPayload = false;

  const km = (ms) => `${fmt(ms / 1000, 2)} km/s`;
  let html;
  if (res.feasible) {
    html = burn
      ? `✓ Reaches the parking orbit with ≈ ${km(res.dvLeft)} left in the upper stage; ${burn} needs ≈ ${km(res.dvNeeded)}.`
      : `✓ Reaches ${dest} with ≈ ${km(res.dvLeft)} of propellant to spare.`;
    box.className = 'plan-check ok';
  } else if (max === 0) {
    const others = VEHICLES.filter((o) => o !== v && assessMission(planOptions(0, o)).feasible).map((o) => o.name);
    html = `✗ The ${escapeHtml(v.name)} can’t reach ${dest}, even with no payload.${others.length ? ` Try the ${others.map(escapeHtml).join(', ')}.` : ''}`;
    box.className = 'plan-check bad';
  } else {
    const use = Math.max(10, Math.floor((max * 0.95) / (max > 2000 ? 100 : 10)) * (max > 2000 ? 100 : 10));
    html = res.reachesOrbit
      ? `✗ Only ≈ ${km(res.dvLeft)} left after reaching orbit, but ${burn} needs ≈ ${km(res.dvNeeded)}. The vehicle would be stranded in the parking orbit.`
      : `✗ Too heavy: the ${escapeHtml(v.name)} can’t reach orbit with ${fmt(payload)} kg.`;
    html += ` <button type="button" class="small" id="use-max">Use ${fmt(use)} kg</button>`;
    box.className = 'plan-check bad';
  }
  const w = launchWindow(tid);
  if (w) {
    const waitDays = (w.departMs - state.simMs) / 86400e3;
    html = `<div class="window">Next launch window: <b>${fmtDate(w.departMs)}</b>${waitDays > 2 ? ` (in ${fmtDuration(waitDays)})` : ''} · cruise ${fmtDuration(w.tofDays)} · arrive ${fmtDate(w.arriveMs)} · C3 ${fmt(w.c3, 1)} km²/s²</div>${html}`;
    if (waitDays > 0.2) note += '<br><span class="muted">Launching jumps the clock ahead to the window.</span>';
  }
  box.innerHTML = html + note;
  const btn = $('use-max');
  if (btn) {
    btn.disabled = !!state.mission;
    btn.onclick = () => { payloadIn.value = btn.textContent.replace(/\D/g, ''); payloadIsAuto = false; updatePlan(); schedulePlanCheck(); };
  }
}

vehSel.onchange = () => {
  payloadIn.value = getVehicle().defaultPayload;
  payloadIsAuto = false;
  updatePlan();
  schedulePlanCheck(true);
};
tgtSel.onchange = () => {
  // A payload the app lowered for a far destination goes back to the rocket's default.
  if (payloadIsAuto) { payloadIn.value = getVehicle().defaultPayload; payloadIsAuto = false; }
  applyTargetDefaults();
  updatePlan();
  schedulePlanCheck(true);
};
siteSel.onchange = () => {
  const site = getSite();
  if (TARGETS[tgtSel.value].editableInc) incIn.value = lowestInclination(site).toFixed(1);
  updatePlan();
  schedulePlanCheck(payloadIsAuto);
};
payloadIn.addEventListener('input', () => { payloadIsAuto = false; updatePlan(); schedulePlanCheck(); });
[altIn, incIn].forEach((el) => el.addEventListener('input', () => { updatePlan(); schedulePlanCheck(); }));

// Defaults, overridable from the URL: ?vehicle=saturnv&site=ksc&target=moon&payload=45000
const params = new URLSearchParams(location.search);
const pick = (sel, value, fallback) => { sel.value = [...sel.options].some((o) => o.value === value) ? value : fallback; };
pick(siteSel, params.get('site'), 'ksc');
pick(vehSel, params.get('vehicle'), 'falcon9');
pick(tgtSel, params.get('target'), 'leo');
payloadIn.value = Number.isFinite(parseFloat(params.get('payload'))) ? parseFloat(params.get('payload')) : getVehicle().defaultPayload;
applyTargetDefaults();
if (params.has('alt') && !altIn.disabled) altIn.value = params.get('alt');
if (params.has('inc') && !incIn.disabled) incIn.value = params.get('inc');
updatePlan();
schedulePlanCheck(!params.has('payload')); // an explicit payload in the URL is kept as is

$('mission-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const site = getSite(), vehicle = getVehicle(), targetId = tgtSel.value;
  const altitude = readAltitude();
  const inclination = targetInclination(targetId, altitude, site, +incIn.value);
  const win = launchWindow(targetId);
  if (win) {
    // Wait for the launch window: jump the clock to just before it.
    const start = launchTimeFor(win, state.simMs + 10000) - 10000;
    if (start - state.simMs > 60000) {
      state.simMs = start;
      flash(`Jumped ahead to the ${BODIES[systemPlanet(TARGETS[targetId].body)].name} launch window · ${fmtDate(start)}`, 5000);
    }
  }
  state.mission = new Mission({
    vehicle, site, targetId, altitude, inclination, window: win,
    payload: Math.max(0, +payloadIn.value || 0),
    startMs: state.simMs,
  });
  state.alerts.clear();
  state.eventsShown = -1;
  state.tracking = 'craft';
  state.playing = true;
  if (WARPS[state.warpIndex] > 10) setWarp(0);
  setFormLocked(true);
  setView('follow');
  updateUi(true);
});

$('btn-reset').onclick = () => {
  state.mission = null;
  state.tracking = 'selected';
  setFormLocked(false);
  earthView.updateMission(null);
  if (state.view === 'follow') setView(state.selected ? 'follow' : 'earth');
  state.eventsShown = -1;
  updateUi(true);
};

function setFormLocked(locked) {
  for (const el of $('mission-form').elements) {
    if (el.id === 'btn-reset') el.disabled = !locked;
    else if (el.id === 'btn-launch') el.disabled = locked;
    else if (locked) el.disabled = true;
  }
  if (!locked) {
    siteSel.disabled = vehSel.disabled = tgtSel.disabled = payloadIn.disabled = false;
    applyTargetDefaults();
    updatePlan();
    schedulePlanCheck();
  }
}

// ------------------------------------------------------------------ layers panel

const layerDefs = [
  ...Object.entries(CATEGORIES).map(([cat, c]) => ({ id: cat, label: c.label, color: c.color, layer: true })),
  { id: 'orbits', label: 'Orbit of selected object' },
  { id: 'proximity', label: 'Lines to nearest objects' },
  { id: 'grid', label: 'Latitude / longitude grid' },
  { id: 'sites', label: 'Launch sites' },
  { id: 'moonOrbit', label: 'Moon’s orbit' },
  { id: 'labels', label: 'Labels' },
];
$('layers-body').innerHTML = layerDefs.map((d) => `
  <label class="check">
    <input type="checkbox" data-layer="${d.id}" checked>
    ${d.color ? `<i class="swatch" style="background:${d.color}"></i>` : '<i class="swatch empty"></i>'}
    <span>${escapeHtml(d.label)}${d.layer ? ` <em id="count-${d.id}"></em>` : ''}</span>
  </label>`).join('') + `
  <label class="slider">Debris shown: <b id="debris-count">${fmt(DEFAULT_DEBRIS)}</b>
    <input type="range" id="debris-slider" min="0" max="20000" step="500" value="${DEFAULT_DEBRIS}">
  </label>
  <p class="hint">Over 30,000 pieces of debris are tracked from the ground; about a million pieces are larger than 1 cm.</p>`;
function updateCounts() {
  for (const [cat, pop] of Object.entries(pops)) {
    const el = $(`count-${cat}`);
    if (el) el.textContent = `(${fmt(pop.objects.length)})`;
  }
}
updateCounts();
$('layers-body').addEventListener('change', (e) => {
  const id = e.target.dataset.layer;
  if (!id) return;
  if (CATEGORIES[id]) earthView.setLayerVisible(id, e.target.checked);
  else earthView.options[id] = e.target.checked;
});
$('debris-slider').addEventListener('input', (e) => { $('debris-count').textContent = fmt(+e.target.value); });
$('debris-slider').addEventListener('change', (e) => { setDebris(+e.target.value); updateCounts(); });
$('layers-toggle').onclick = () => {
  const body = $('layers-body');
  body.hidden = !body.hidden;
  $('layers-toggle').setAttribute('aria-expanded', String(!body.hidden));
};
if (window.innerWidth < 700 || window.innerHeight < 1000) $('layers-toggle').click();

// ------------------------------------------------------------------ search

const searchIn = $('search'), results = $('search-results');
searchIn.addEventListener('input', () => {
  const q = searchIn.value.trim().toLowerCase();
  if (q.length < 2) { results.hidden = true; return; }
  const all = Object.values(pops).flatMap((p) => p.objects);
  const hits = all.filter((o) => o.name.toLowerCase().includes(q)).slice(0, 10);
  results.innerHTML = hits.length
    ? hits.map((o, i) => `<li role="option" data-i="${i}"><i class="swatch" style="background:${CATEGORIES[o.cat].color}"></i>${escapeHtml(o.name)}<small>${escapeHtml(CATEGORIES[o.cat].label)}</small></li>`).join('')
    : '<li class="muted">No match</li>';
  results.hidden = false;
  results.onclick = (e) => {
    const li = e.target.closest('li[data-i]');
    if (!li) return;
    select(hits[+li.dataset.i], true);
    results.hidden = true;
    searchIn.value = '';
    searchIn.blur();
  };
});
searchIn.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { const first = results.querySelector('li[data-i]'); if (first) first.click(); }
  if (e.key === 'Escape') { results.hidden = true; searchIn.blur(); }
});
document.addEventListener('click', (e) => { if (!e.target.closest('.search')) results.hidden = true; });

// ------------------------------------------------------------------ picking

const canvas = $('scene');
const tooltip = $('tooltip');
let down = null, hoverStamp = 0;
const hitToObject = (hit) => (hit && hit.cat !== 'craft' ? pops[hit.cat].objects[hit.index] : null);

canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointerup', (e) => {
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || state.view === 'solar') return;
  const r = canvas.getBoundingClientRect();
  const hit = earthView.pick(e.clientX - r.left, e.clientY - r.top, e.pointerType === 'touch' ? 22 : 10);
  if (!hit) return;
  if (hit.cat === 'craft') trackCraft(); else select(hitToObject(hit));
});
canvas.addEventListener('pointermove', (e) => {
  if (e.buttons || state.view === 'solar') { tooltip.hidden = true; return; }
  const now = performance.now();
  if (now - hoverStamp < 40) return;
  hoverStamp = now;
  const r = canvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const hit = earthView.pick(x, y);
  state.hovered = hitToObject(hit);
  canvas.style.cursor = hit ? 'pointer' : '';
  if (!hit) { tooltip.hidden = true; return; }
  const name = hit.cat === 'craft' ? `${state.mission.vehicle.name} (your mission)` : state.hovered.name;
  const cat = hit.cat === 'craft' ? 'Spacecraft' : CATEGORIES[hit.cat].label;
  tooltip.innerHTML = `<b>${escapeHtml(name)}</b><span>${escapeHtml(cat)}</span>`;
  tooltip.style.transform = `translate(${x + 14}px, ${y + 12}px)`;
  tooltip.hidden = false;
});
canvas.addEventListener('pointerleave', () => { tooltip.hidden = true; state.hovered = null; });

$('btn-follow-track').onclick = () => setView('follow');

// ------------------------------------------------------------------ nearby objects

function computeNearest() {
  const p = trackedPosition();
  state.deepSpace = !!p && norm(p) > 3e6; // far beyond every catalogued orbit
  if (!p || state.deepSpace) { state.nearest = []; return; }
  const self = trackingCraft() ? null : state.selected;
  const list = nearestObjects(p, Object.values(pops), 9).filter((n) => n.obj !== self).slice(0, 8);
  const vSelf = trackedVelocity() || [0, 0, 0];
  for (const n of list) n.relSpeed = norm(sub(n.obj.orbit.stateAt(state.simMs).v, vSelf));
  state.nearest = list;

  // Conjunction alerts for the player's spacecraft.
  const m = state.mission;
  if (trackingCraft() && m && m.phase === 'coast') {
    for (const n of list) {
      if (n.distance >= state.threshold) break;
      const last = state.alerts.get(n.obj.name);
      if (last && state.simMs - last < 3600e3) continue;
      state.alerts.set(n.obj.name, state.simMs);
      m.log(state.simMs, 'Conjunction alert', `${n.obj.name} within ${fmtDist(n.distance)} (relative speed ${fmt(n.relSpeed, 2)} km/s)`, 'warn');
    }
  }
}

// ------------------------------------------------------------------ panels

let lastMap = 0;
function flash(text, ms = 2600) {
  const b = $('banner');
  b.textContent = text;
  b.hidden = false;
  b.classList.remove('show'); void b.offsetWidth; b.classList.add('show');
  state.bannerUntil = performance.now() + ms;
}

function updateUi(force = false) {
  const m = state.mission;
  const { warp, limited } = currentWarp();

  $('utc').textContent = formatUtc(state.simMs);
  $('warp').textContent = fmtWarp(warp);
  $('warp').classList.toggle('limited', limited);
  $('warp').title = limited ? `Time warp is capped at ${ASCENT_MAX_WARP}× during countdown and powered flight` : 'Time warp';
  $('btn-play').textContent = state.playing ? '❚❚' : '▶';
  $('btn-play').setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
  const next = m && m.nextEvent();
  $('btn-next').disabled = !next;
  $('btn-next').classList.toggle('attention', !!next && m.phase === 'coast' && next.ms - state.simMs > 120e3);
  $('btn-next').title = next ? `Skip to: ${next.name}` : 'No upcoming mission event';
  $('view-follow').disabled = !trackedPosition();

  updateTelemetry(m, next);
  updateEvents(m);
  updateTracking();
  updateBodies();
  updateNearby();
  const now = performance.now();
  if (force || now - lastMap > 500) {
    lastMap = now;
    groundMap.draw({ ms: state.simMs, mission: m, selected: trackingCraft() ? null : state.selected, sites: SITES, site: getSite(), plan: m ? null : state.launchPlan });
  }
  if (state.bannerUntil && now > state.bannerUntil) { $('banner').hidden = true; state.bannerUntil = 0; }
}

function updateTelemetry(m, next) {
  const badge = $('phase-badge');
  const bar = $('prop-bar');
  if (!m) {
    badge.textContent = 'Standby'; badge.className = 'badge';
    $('telemetry').innerHTML = rows([['Status', 'Configure a mission and press Launch.']]);
    bar.hidden = true;
    return;
  }
  const met = formatDuration((state.simMs - m.launchMs) / 1000);
  const falling = m.phase === 'ascent' && m.ascent.status === 'ballistic';
  const stranded = m.phase === 'coast' && m.incompleteMs != null;
  const where = m.frame === 'earth' ? 'Coasting' : m.frame === 'moon' ? 'Lunar space' : m.frame === 'sun' ? 'Interplanetary cruise' : `At ${BODIES[m.frame].name}`;
  const phaseName = falling ? 'Suborbital' : stranded ? 'Stranded' : { countdown: 'Countdown', ascent: 'Powered ascent', coast: where, failed: 'Failed' }[m.phase];
  badge.textContent = phaseName;
  badge.className = `badge ${falling ? 'failed' : stranded ? 'warn' : m.phase}`;
  let r = [['Mission time', met]];
  if (m.phase === 'countdown') {
    r.push(['Vehicle', escapeHtml(m.vehicle.name)], ['Launch site', escapeHtml(m.site.name)]);
    bar.hidden = true;
  } else if (m.phase === 'ascent') {
    const t = m.ascent.telemetry();
    r.push(
      ['Stage', escapeHtml(t.stage)],
      ['Altitude', `${fmt(t.altitude, 1)} km`],
      ['Speed (inertial)', `${fmt(t.speed, 3)} km/s`],
      ['Vertical speed', `${fmt(t.verticalSpeed * 1000)} m/s`],
      ['Downrange', `${fmt(t.downrange)} km`],
      ['Acceleration', `${fmt(t.accelG, 2)} g`],
      ['Dynamic pressure', `${fmt(t.q, 1)} kPa`],
      ['Throttle', `${fmt(t.throttle * 100)} %`],
      ['Pitch', `${fmt(t.pitch, 1)}°`],
      ['Heading', `${fmt(t.heading, 0)}°${t.dogleg === 'turning' ? ' · dogleg turn' : ''}`],
      ['Inclination', `${fmt(t.inclination, 1)}°`],
      ['Mass', `${fmt(t.mass / 1000, 1)} t`],
      ['Apoapsis', t.apoapsisAlt > 0 ? `${fmt(t.apoapsisAlt)} km` : '—'],
      ['Periapsis', t.periapsisAlt > -R_EARTH ? `${fmt(t.periapsisAlt)} km` : '—'],
    );
    bar.hidden = false;
    bar.firstElementChild.style.width = `${Math.max(0, Math.min(1, t.propFraction)) * 100}%`;
    bar.title = `Stage propellant remaining: ${fmt(t.propFraction * 100)} %`;
  } else if (m.phase === 'coast' && m.arc.hold) {
    const b = BODIES[m.frame];
    r.push(
      ['Holding at', b.name],
      ['Height', `${fmt(norm(m.r) - b.radius, 1)} km above the surface`],
      ['From Earth', fmtDist(norm(m.positionEci()))],
      ['Δv used', `${fmt(m.totalDeltaV(), 2)} km/s`],
    );
    bar.hidden = true;
  } else if (m.phase === 'coast' && m.frame === 'sun') {
    const el = m.elements();
    const target = BODIES[systemPlanet(m.destination)];
    r.push(
      ['Orbiting', 'Sun'],
      ['From Sun', fmtDist(norm(m.r))],
      ['Speed', `${fmt(norm(m.v), 2)} km/s`],
      [`To ${target.name}`, fmtDist(dist(m.positionHelio(), helioPosition(target.id, state.simMs)))],
      ['From Earth', fmtDist(norm(m.positionEci()))],
      ['Perihelion', fmtDist(el.rp)],
      ['Aphelion', Number.isFinite(el.ra) ? fmtDist(el.ra) : 'escape'],
      ['Δv used', `${fmt(m.totalDeltaV(), 2)} km/s`],
    );
  } else if (m.phase === 'coast') {
    const el = m.elements();
    const body = BODIES[m.frame].radius;
    r.push(
      ['Orbiting', el.body],
      ['Altitude', fmtDist(norm(m.r) - body)],
      ['Speed', `${fmt(norm(m.v), 3)} km/s`],
      ['Periapsis', fmtDist(el.periAlt)],
      ['Apoapsis', Number.isFinite(el.apoAlt) && el.e < 1 ? fmtDist(el.apoAlt) : 'escape'],
      ['Inclination', `${fmt(el.i / DEG, 2)}°`],
      ['Eccentricity', fmt(el.e, 4)],
      ['Period', fmtPeriod(el.period)],
      ['Δv used', `${fmt(m.totalDeltaV(), 2)} km/s`],
    );
  }
  if (m.phase === 'coast') {
    if (next) r.push(['Next event', `${escapeHtml(next.name)} in ${formatDuration((next.ms - state.simMs) / 1000).replace('T+ ', '')}`]);
    else r.push(['Status', escapeHtml(m.status || 'In orbit')]);
    bar.hidden = true;
  } else if (m.phase === 'failed') {
    r.push(['Status', `<span class="bad">${escapeHtml(m.status)}</span>`]);
    bar.hidden = true;
  }
  $('telemetry').innerHTML = rows(r);
}

function updateEvents(m) {
  const list = $('events');
  const n = m ? m.events.length : 0;
  if (n === state.eventsShown) return;
  const fresh = m && state.eventsShown >= 0 ? m.events.slice(state.eventsShown) : [];
  state.eventsShown = n;
  if (!m) { list.innerHTML = '<li class="muted">No mission yet.</li>'; return; }
  const sorted = [...m.events].sort((a, b) => a.ms - b.ms);
  list.innerHTML = sorted.map((e) => `
    <li class="${e.kind}">
      <time>${formatDuration((e.ms - m.launchMs) / 1000)}</time>
      <b>${escapeHtml(e.name)}</b>
      ${e.detail ? `<span>${escapeHtml(e.detail)}</span>` : ''}
    </li>`).join('');
  list.scrollTop = list.scrollHeight;
  // Switch to the solar-system view for the cruise, and back on arrival.
  for (const e of fresh) {
    if (e.name === 'Leaving Earth’s sphere of influence' && (state.view === 'follow' || state.view === 'earth')) {
      setView('solar');
      solarView.fit(Math.max(1.2, BODIES[systemPlanet(m.destination)].planet.el[0]));
    }
    if (e.name.startsWith('Arrival at ') && state.view === 'solar' && m.frame !== 'sun') setView('follow');
    // Re-frame the camera on the new, much smaller orbit after a capture.
    if ((e.name.endsWith('orbit insertion') || e.name.startsWith('Rendezvous')) && state.view === 'follow' && trackingCraft() && m.frame !== 'earth') setView('follow');
  }
  const notable = fresh.filter((e) => e.name !== 'Ignition' && e.name !== 'Countdown');
  if (notable.length) {
    // After insertion, multi-burn missions coast for a while: point at the skip button.
    const next = m.nextEvent();
    const waiting = m.phase === 'coast' && next && next.ms - state.simMs > 120e3;
    flash(waiting ? `${notable[notable.length - 1].name} · press Next event ⏭ to skip ahead` : notable[notable.length - 1].name, waiting ? 6000 : 2600);
  }
}

function updateTracking() {
  const m = state.mission;
  const craft = trackingCraft();
  const obj = state.selected;
  const p = trackedPosition();
  if (!p) {
    $('track-name').textContent = 'Nothing selected';
    $('track-note').textContent = 'Click a satellite or launch a mission.';
    $('track-swatch').style.background = 'transparent';
    $('track-info').innerHTML = '';
    return;
  }
  $('track-name').textContent = craft ? `${m.vehicle.name} · your mission` : obj.name;
  $('track-note').textContent = craft ? `${fmt(m.payload)} kg payload from ${m.site.short}` : `${CATEGORIES[obj.cat].label} · ${obj.note}`;
  $('track-swatch').style.background = craft ? '#ffd24d' : CATEGORIES[obj.cat].color;
  const v = trackedVelocity();
  const away = craft && m.frame !== 'earth' && (m.phase === 'coast' || m.phase === 'failed');
  const center = away ? BODIES[m.frame] : null;
  const info = away
    ? [
      center.id === 'sun' ? ['From Sun', fmtDist(norm(m.r))] : [`Altitude (${center.name})`, fmtDist(norm(m.r) - center.radius)],
      [`Speed (${center.name})`, `${fmt(norm(m.v), 3)} km/s`],
      ['From Earth', fmtDist(norm(p))],
    ]
    : [
      ['Altitude', fmtDist(norm(p) - R_EARTH)],
      ['Speed', `${fmt(norm(v), 3)} km/s`],
      ['Over', fmtLatLon(eciToGeo(p, state.simMs))],
    ];
  if (!craft) {
    const o = obj.orbit;
    const el = stateToElements(p, v);
    info.push(
      ['Orbit', `${fmt(o.a * (1 - o.e) - R_EARTH)} × ${fmt(o.a * (1 + o.e) - R_EARTH)} km`],
      ['Inclination', `${fmt(o.i / DEG, 2)}°`],
      ['Period', fmtPeriod(o.period)],
      ['RAAN', `${fmt(el.raan / DEG, 1)}°`],
    );
  }
  $('track-info').innerHTML = rows(info);
}

function updateBodies() {
  const p = trackedPosition();
  const t = state.simMs;
  if (!p) { $('bodies').innerHTML = ''; return; }
  const sun = sunPositionEci(t);
  const moon = moonPositionEci(t);
  const dEarth = norm(p);
  const dMoon = dist(p, moon);
  const dSun = dist(p, sun);
  const nearEarth = dEarth < 2e6;
  const m = trackingCraft() ? state.mission : null;
  const dest = m && m.destination && systemPlanet(m.destination) !== 'earth' ? systemPlanet(m.destination) : null;
  const out = [
    ['Earth', nearEarth ? `${fmtDist(dEarth - R_EARTH)} up` : fmtDist(dEarth), nearEarth ? (inEarthShadow(p, sun) ? 'in Earth’s shadow' : 'in sunlight') : fmtLight(dEarth)],
    ['Moon', fmtDist(dMoon - R_MOON), `${fmtLight(dMoon)} · centre ${fmtDist(dMoon)}`],
    ['Sun', fmtDist(dSun), fmtLight(dSun)],
  ];
  for (const id of PLANET_IDS) {
    const d = dist(p, positionRelEarth(id, t));
    const above = d < BODIES[id].soi ? ` · ${fmtDist(d - BODIES[id].radius)} up` : '';
    out.push([id === dest ? `<b>${BODIES[id].name}</b>` : BODIES[id].name, fmtDist(d), fmtLight(d) + above]);
    // Moons of the destination planet, or of any planet we are close to.
    if (id === dest || d < BODIES[id].soi) {
      for (const mid of BODIES[id].moons) {
        const dm = dist(p, positionRelEarth(mid, t));
        out.push([`&nbsp;&nbsp;↳ ${BODIES[mid].name}`, fmtDist(dm), fmtDist(dm - BODIES[mid].radius) + ' above surface']);
      }
    }
  }
  $('bodies').innerHTML = `<thead><tr><th>Body</th><th>Distance</th><th>Detail</th></tr></thead><tbody>${out.map(([a, b, c]) => `<tr><td>${a}</td><td>${b}</td><td>${c}</td></tr>`).join('')}</tbody>`;
}

function updateNearby() {
  const list = state.nearest;
  if (state.deepSpace) { $('nearby').innerHTML = '<tbody><tr><td class="muted">Deep space: no catalogued satellites or debris out here.</td></tr></tbody>'; return; }
  if (!list.length) { $('nearby').innerHTML = '<tbody><tr><td class="muted">Select an object or launch a mission.</td></tr></tbody>'; return; }
  $('nearby').innerHTML = `<thead><tr><th>Object</th><th>Distance</th><th>Rel. speed</th></tr></thead><tbody>${list.map((n, i) => `
    <tr class="${n.distance < state.threshold ? 'alert' : ''}" data-i="${i}">
      <td><i class="swatch" style="background:${CATEGORIES[n.obj.cat].color}"></i>${escapeHtml(n.obj.name)}</td>
      <td>${fmtDist(n.distance)}</td>
      <td>${fmt(n.relSpeed, 2)} km/s</td>
    </tr>`).join('')}</tbody>`;
}
$('nearby').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-i]');
  if (tr) select(state.nearest[+tr.dataset.i].obj);
});
$('threshold').addEventListener('input', (e) => { state.threshold = Math.max(1, +e.target.value || 1); });

// ------------------------------------------------------------------ labels

function earthLabels() {
  if (!earthView.options.labels) return [];
  const t = state.simMs;
  const items = [];
  const moon = moonPositionEci(t);
  items.push({ key: 'moon', text: 'Moon', world: eciToWorld(moon).add(new THREE.Vector3(0, R_MOON * 1.6, 0)), cls: 'body' });
  items.push({ key: 'sun', text: 'Sun', world: eciToWorld(sunPositionEci(t)), cls: 'body' });
  const camDist = earthView.camera.position.length();
  if (camDist > 150000) items.push({ key: 'earth', text: 'Earth', world: new THREE.Vector3(0, R_EARTH * 1.5, 0), cls: 'body' });
  if (earthView.options.sites && camDist < 60000) {
    for (const s of SITES) items.push({ key: `site-${s.id}`, text: s.short, world: eciToWorld(geoToEci(s.lat, s.lon, R_EARTH + 10, t)), cls: 'site' });
  }
  // Planets (visible as bright points), and their moons when the camera is near.
  const destId = state.mission?.destination;
  for (const id of [...PLANET_IDS, ...MOON_IDS]) {
    const o = earthView.bodyObjs[id];
    if (!o || !o.dot.visible) continue;
    const b = BODIES[id];
    const isDest = id === destId || (destId && BODIES[destId].parent === id);
    items.push({ key: `body-${id}`, text: id === destId ? `${b.name} · destination` : b.name, world: eciToWorld(positionRelEarth(id, t)).add(new THREE.Vector3(0, b.radius * 1.3, 0)), cls: isDest ? 'body target' : 'body' });
  }
  if (state.selected) items.push({ key: 'sel', text: state.selected.name, world: eciToWorld(state.selected.getPosition()), cls: 'sel' });
  if (state.mission) items.push({ key: 'craft', text: state.mission.vehicle.name, world: eciToWorld(state.mission.positionEci()), cls: 'craft' });
  return items;
}

// ------------------------------------------------------------------ main loop

const viewport = $('viewport');
function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  renderer.setSize(w, h, false);
  earthView.resize(w, h);
  solarView.resize(w, h);
}
new ResizeObserver(resize).observe(viewport);
window.addEventListener('resize', () => groundMap.resize());
resize();

select(pops.station.objects[0]); // start by tracking the ISS

let last = performance.now(), lastUi = 0, lastNear = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const { warp } = currentWarp();
  if (state.playing) state.simMs += dt * warp * 1000;
  const m = state.mission;
  if (m) m.update(state.simMs);
  for (const p of Object.values(pops)) p.update(state.simMs);

  const w = viewport.clientWidth, h = viewport.clientHeight;
  if (state.view === 'solar') {
    solarView.update(state.simMs, m);
    solarView.render();
    labels.update(solarView.camera, solarView.labels(), w, h);
  } else {
    earthView.update(state.simMs, { mission: m, selected: state.selected, hovered: state.hovered, nearest: trackingCraft() ? state.nearest : null, threshold: state.threshold });
    earthView.render();
    const pr = earthView.projector();
    labels.update(earthView.camera, earthLabels(), w, h, (wp) => pr.occluded(wp.x, -wp.z, wp.y));
  }

  if (now - lastNear > 300) { computeNearest(); lastNear = now; }
  if (now - lastUi > 150) { updateUi(); lastUi = now; }
  requestAnimationFrame(frame);
}
$('boot').hidden = true;
requestAnimationFrame(frame);

// Handle for the browser console and automated tests.
window.breakthrough = { state, pops, earthView, solarView, setView, select };
