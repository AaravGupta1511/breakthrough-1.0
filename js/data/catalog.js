// Catalogue of artificial satellites on representative orbits.
//
// Altitudes, inclinations and orbit shapes follow published values; the
// position of each satellite along its orbit (RAAN / mean anomaly) is not live
// tracking data, so this shows realistic traffic rather than real-time
// positions. Geostationary satellites are placed at their real longitudes.

import { DEG, R_EARTH } from '../core/constants.js';
import { KeplerOrbit, sunSyncInclination } from '../core/orbits.js';
import { gmst } from '../core/time.js';

export const CATEGORIES = {
  station: { label: 'Space stations', color: '#4de1ff', size: 7 },
  navigation: { label: 'Navigation (GNSS)', color: '#ffc94d', size: 5 },
  geo: { label: 'Geostationary comms & weather', color: '#c595ff', size: 5 },
  earthobs: { label: 'Earth observation', color: '#6be39b', size: 5 },
  science: { label: 'Science & telescopes', color: '#ff8fcb', size: 6 },
  constellation: { label: 'Broadband constellations', color: '#8fb4ff', size: 3 },
  debris: { label: 'Debris & rocket bodies', color: '#ff6a4d', size: 2.5 },
};

// Deterministic pseudo-random numbers (mulberry32).
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hash = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

const circ = (alt) => ({ a: R_EARTH + alt, e: 0.0005 });
const ellipse = (periAlt, apoAlt) => {
  const rp = R_EARTH + periAlt, ra = R_EARTH + apoAlt;
  return { a: (rp + ra) / 2, e: (ra - rp) / (ra + rp) };
};

// Single named satellites: [name, category, shape, inclination (deg or 'sso'), note]
const NAMED = [
  ['ISS (Zarya)', 'station', circ(418), 51.64, 'International Space Station, crewed since 2000'],
  ['Tiangong (CSS)', 'station', circ(385), 41.47, 'Chinese Space Station'],
  ['Hubble Space Telescope', 'science', circ(515), 28.47, 'Optical/UV telescope, launched 1990'],
  ['AstroSat', 'science', circ(650), 6.0, 'India’s multi-wavelength space observatory'],
  ['Fermi', 'science', circ(525), 25.6, 'Gamma-ray space telescope'],
  ['NuSTAR', 'science', circ(600), 6.0, 'Hard X-ray telescope'],
  ['Chandra X-ray Observatory', 'science', ellipse(14000, 134000), 64, 'Highly elliptical 64-hour orbit'],
  ['XMM-Newton', 'science', ellipse(7000, 114000), 70, 'ESA X-ray observatory, 48-hour orbit'],
  ['TESS', 'science', ellipse(101600, 368600), 37, 'Exoplanet hunter on a 13.7-day lunar-resonant orbit'],
  ['Landsat 8', 'earthobs', circ(705), 'sso', 'USGS/NASA land imaging'],
  ['Landsat 9', 'earthobs', circ(705), 'sso', 'USGS/NASA land imaging'],
  ['Sentinel-1A', 'earthobs', circ(693), 'sso', 'ESA radar imaging'],
  ['Sentinel-2A', 'earthobs', circ(786), 'sso', 'ESA multispectral imaging'],
  ['Sentinel-2B', 'earthobs', circ(786), 'sso', 'ESA multispectral imaging'],
  ['Terra', 'earthobs', circ(705), 'sso', 'NASA Earth Observing System'],
  ['Aqua', 'earthobs', circ(705), 'sso', 'NASA Earth Observing System'],
  ['NOAA-20', 'earthobs', circ(824), 'sso', 'Polar weather satellite'],
  ['Suomi NPP', 'earthobs', circ(824), 'sso', 'Polar weather satellite'],
  ['Cartosat-3', 'earthobs', circ(509), 'sso', 'ISRO high-resolution imaging'],
  ['Oceansat-3 (EOS-06)', 'earthobs', circ(740), 'sso', 'ISRO ocean & atmosphere monitoring'],
  ['Resourcesat-2A', 'earthobs', circ(817), 'sso', 'ISRO natural-resource mapping'],
  ['RISAT-2B', 'earthobs', circ(555), 37, 'ISRO radar imaging'],
  ['WorldView-3', 'earthobs', circ(617), 'sso', 'Commercial 30 cm imaging'],
  ['ICESat-2', 'earthobs', circ(496), 92, 'Laser altimetry of ice sheets'],
  ['GRACE-FO 1', 'earthobs', circ(490), 89, 'Gravity field mapping (pair)'],
  ['GRACE-FO 2', 'earthobs', circ(490), 89, 'Gravity field mapping (pair)'],
  ['Meridian 9', 'geo', ellipse(990, 39700), 62.8, 'Russian comms, Molniya orbit'],
  ['Meridian 10', 'geo', ellipse(990, 39700), 62.8, 'Russian comms, Molniya orbit'],
];

// Geostationary satellites at their station longitudes (deg east).
const GEO_SATS = [
  ['GOES-16 (GOES-East)', -75.2, 'NOAA weather'],
  ['GOES-18 (GOES-West)', -137.2, 'NOAA weather'],
  ['Meteosat-12 (MTG-I1)', 0.0, 'EUMETSAT weather'],
  ['Himawari-9', 140.7, 'JMA weather'],
  ['INSAT-3DR', 74.0, 'ISRO weather'],
  ['INSAT-3DS', 82.0, 'ISRO weather'],
  ['GSAT-11', 74.0, 'ISRO broadband'],
  ['GSAT-30', 83.0, 'ISRO communications'],
  ['Fengyun-4B', 105.0, 'CMA weather'],
  ['Elektro-L 3', 165.8, 'Roscosmos weather'],
  ['Astra 1KR', 19.2, 'SES broadcasting'],
  ['Hot Bird 13F', 13.0, 'Eutelsat broadcasting'],
  ['Intelsat 37e', -18.0, 'Intelsat communications'],
  ['SES-17', -67.1, 'SES broadband'],
  ['EchoStar 23', -44.9, 'Broadcasting'],
  ['TDRS-13', -150.0, 'NASA data relay'],
  ['NavIC IRNSS-1C', 83.0, 'ISRO navigation (GEO)', 'navigation'],
  ['NavIC IRNSS-1F', 32.5, 'ISRO navigation (GEO)', 'navigation'],
  ['NavIC IRNSS-1G', 129.5, 'ISRO navigation (GEO)', 'navigation'],
];

// Walker-style constellations: evenly spaced planes and slots.
const CONSTELLATIONS = [
  { prefix: 'GPS', cat: 'navigation', a: 26559.7, e: 0.008, i: 55, planes: 6, perPlane: 5, note: 'US Global Positioning System' },
  { prefix: 'GLONASS', cat: 'navigation', a: 25508, e: 0.001, i: 64.8, planes: 3, perPlane: 8, note: 'Russian navigation system' },
  { prefix: 'Galileo', cat: 'navigation', a: 29600, e: 0.0005, i: 56, planes: 3, perPlane: 8, note: 'European navigation system' },
  { prefix: 'BeiDou-3 M', cat: 'navigation', a: 27906, e: 0.001, i: 55, planes: 3, perPlane: 8, note: 'Chinese navigation system (MEO)' },
  { prefix: 'Starlink', cat: 'constellation', a: R_EARTH + 550, e: 0.0001, i: 53, planes: 36, perPlane: 14, note: 'SpaceX broadband, 53° shell (sample of ~7,000)' },
  { prefix: 'Starlink', cat: 'constellation', a: R_EARTH + 540, e: 0.0001, i: 43, planes: 24, perPlane: 8, note: 'SpaceX broadband, 43° shell (sample)' },
  { prefix: 'Starlink', cat: 'constellation', a: R_EARTH + 560, e: 0.0001, i: 97.6, planes: 8, perPlane: 8, note: 'SpaceX broadband, polar shell (sample)' },
  { prefix: 'OneWeb', cat: 'constellation', a: R_EARTH + 1200, e: 0.0001, i: 87.9, planes: 12, perPlane: 12, note: 'Eutelsat OneWeb broadband (sample)' },
  { prefix: 'Iridium', cat: 'constellation', a: R_EARTH + 780, e: 0.0002, i: 86.4, planes: 6, perPlane: 11, note: 'Iridium NEXT voice/data network' },
];

export function buildCatalog(epochMs) {
  const list = [];
  const theta = gmst(epochMs);

  for (const [name, cat, shape, inc, note] of NAMED) {
    const r = rng(hash(name));
    const i = inc === 'sso' ? sunSyncInclination(shape.a - R_EARTH) : inc * DEG;
    const argp = cat === 'geo' ? 270 * DEG : r() * 2 * Math.PI; // Molniya apogee over the north
    list.push({
      name, cat, note,
      orbit: new KeplerOrbit({ ...shape, i, raan: r() * 2 * Math.PI, argp, M0: r() * 2 * Math.PI }, epochMs),
    });
  }

  for (const [name, lon, note, cat = 'geo'] of GEO_SATS) {
    list.push({
      name, cat, note: `${note} · ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`,
      orbit: new KeplerOrbit({ a: 42164.17, e: 0.0002, i: 0.05 * DEG, raan: 0, argp: 0, M0: lon * DEG + theta }, epochMs),
    });
  }

  // NavIC inclined geosynchronous satellites (figure-of-eight ground tracks).
  [['NavIC IRNSS-1B', 55, 0], ['NavIC IRNSS-1I', 55, Math.PI], ['NavIC IRNSS-1D', 111.75, 0], ['NavIC IRNSS-1E', 111.75, Math.PI]]
    .forEach(([name, lon, M0]) => list.push({
      name, cat: 'navigation', note: 'ISRO navigation (inclined geosynchronous)',
      orbit: new KeplerOrbit({ a: 42164.17, e: 0.002, i: 29 * DEG, raan: lon * DEG + theta, argp: 0, M0 }, epochMs),
    }));

  let serial = 1000;
  for (const c of CONSTELLATIONS) {
    const r = rng(hash(c.prefix + c.i));
    const raan0 = r() * 2 * Math.PI;
    for (let p = 0; p < c.planes; p++) {
      for (let s = 0; s < c.perPlane; s++) {
        const id = c.cat === 'navigation' ? `${String(p * c.perPlane + s + 1).padStart(2, '0')}` : `${serial++}`;
        list.push({
          name: `${c.prefix}-${id}`, cat: c.cat, note: c.note,
          orbit: new KeplerOrbit({
            a: c.a, e: c.e, i: c.i * DEG,
            raan: raan0 + (p / c.planes) * 2 * Math.PI,
            argp: 0,
            M0: (s / c.perPlane) * 2 * Math.PI + (p * Math.PI) / c.perPlane * 0.5,
          }, epochMs),
        });
      }
    }
  }
  return list;
}

// Synthetic debris population with a realistic altitude/inclination mix:
// the 2007 Fengyun-1C and 2009 Iridium–Cosmos collision clouds, general LEO
// clutter peaking near 800 km, spent upper stages on GTO, and the GEO belt.
const DEBRIS_SOURCES = [
  { w: 0.18, name: 'FENGYUN 1C DEB', alt: [650, 1500], inc: [98.6, 99.2], e: [0, 0.06], note: 'Fragment of the 2007 Chinese anti-satellite test' },
  { w: 0.10, name: 'COSMOS 2251 DEB', alt: [550, 1200], inc: [73.8, 74.2], e: [0, 0.04], note: 'Fragment from the 2009 Iridium–Cosmos collision' },
  { w: 0.05, name: 'IRIDIUM 33 DEB', alt: [550, 1100], inc: [86.2, 86.6], e: [0, 0.03], note: 'Fragment from the 2009 Iridium–Cosmos collision' },
  { w: 0.02, name: 'COSMOS 1408 DEB', alt: [350, 550], inc: [82.4, 82.8], e: [0, 0.01], note: 'Fragment of the 2021 Russian anti-satellite test' },
  { w: 0.30, name: 'DEB', alt: [700, 1050], inc: 'mixed', e: [0, 0.02], note: 'Untracked-origin fragment (LEO)' },
  { w: 0.12, name: 'DEB', alt: [300, 700], inc: 'mixed', e: [0, 0.01], note: 'Fragment (low LEO, decays within years)' },
  { w: 0.07, name: 'R/B', alt: [1300, 2000], inc: 'mixed', e: [0, 0.03], note: 'Spent rocket body' },
  { w: 0.08, name: 'R/B', gto: true, note: 'Spent upper stage in geostationary transfer orbit' },
  { w: 0.06, name: 'GEO DEB', geo: true, note: 'Dead satellite or fragment drifting near the GEO belt' },
  { w: 0.02, name: 'MEO DEB', alt: [18000, 23000], inc: [54, 66], e: [0, 0.02], note: 'Navigation-orbit debris' },
];
const MIXED_INC = [[98, 0.3], [82.5, 0.15], [74, 0.1], [65, 0.1], [71, 0.05], [51.6, 0.07], [28.5, 0.06], [null, 0.17]];
const ROCKET_NAMES = ['SL-16', 'SL-8', 'CZ-4B', 'CZ-2C', 'DELTA 2', 'ATLAS 5 CENTAUR', 'ARIANE 5', 'PSLV PS4', 'H-2A', 'FALCON 9'];

export function generateDebris(count, epochMs, seed = 20260926) {
  const r = rng(seed);
  const pick = (list) => {
    let x = r();
    for (const it of list) { x -= it.w ?? it[1]; if (x <= 0) return it; }
    return list[list.length - 1];
  };
  const range = ([a, b]) => a + (b - a) * r();
  const out = [];
  let id = 10000;
  for (let n = 0; n < count; n++) {
    const src = pick(DEBRIS_SOURCES);
    let a, e, inc;
    if (src.gto) {
      const rp = R_EARTH + range([180, 650]), ra = R_EARTH + range([33500, 36500]);
      a = (rp + ra) / 2; e = (ra - rp) / (ra + rp);
      inc = [7, 28.5, 51.6, 5.2, 19][Math.floor(r() * 5)] + range([-1.5, 1.5]);
    } else if (src.geo) {
      a = 42164 + range([-150, 450]); e = range([0, 0.004]); inc = range([0, 15]);
    } else {
      a = R_EARTH + range(src.alt);
      e = range(src.e);
      if (a * (1 - e) < R_EARTH + 200) e = Math.max(0, 1 - (R_EARTH + 200) / a); // keep perigee above 200 km
      if (src.inc === 'mixed') {
        const [base] = pick(MIXED_INC);
        inc = base == null ? range([0, 110]) : base + range([-1.2, 1.2]);
      } else inc = range(src.inc);
    }
    const isRB = src.name === 'R/B';
    const name = isRB ? `${ROCKET_NAMES[Math.floor(r() * ROCKET_NAMES.length)]} R/B` : src.name;
    out.push({
      name: `${name} #${id++}`, cat: 'debris', note: src.note,
      orbit: new KeplerOrbit({ a, e, i: inc * DEG, raan: r() * 2 * Math.PI, argp: r() * 2 * Math.PI, M0: r() * 2 * Math.PI }, epochMs),
    });
  }
  return out;
}
