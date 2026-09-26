// Time utilities. Simulation time is kept as a JavaScript epoch in milliseconds (UTC).

import { DEG, OMEGA_EARTH } from './constants.js';

export const toJulian = (ms) => ms / 86400000 + 2440587.5;
export const centuriesSinceJ2000 = (ms) => (toJulian(ms) - 2451545.0) / 36525;

// Greenwich Mean Sidereal Time in radians (IAU 1982, good to ~0.1 s over decades).
export function gmst(ms) {
  const d = toJulian(ms) - 2451545.0;
  const T = d / 36525;
  let deg = 280.46061837 + 360.98564736629 * d + 0.000387933 * T * T;
  deg %= 360;
  if (deg < 0) deg += 360;
  return deg * DEG;
}

// Earth-fixed (lat, lon, radius) to Earth-centred inertial at time ms.
export function geoToEci(latDeg, lonDeg, radius, ms) {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG + gmst(ms);
  return [
    radius * Math.cos(lat) * Math.cos(lon),
    radius * Math.cos(lat) * Math.sin(lon),
    radius * Math.sin(lat),
  ];
}

// Inertial position -> geocentric latitude / longitude (degrees) at time ms.
export function eciToGeo(r, ms) {
  const lon = Math.atan2(r[1], r[0]) - gmst(ms);
  const lat = Math.atan2(r[2], Math.hypot(r[0], r[1]));
  let lonDeg = (lon / DEG) % 360;
  if (lonDeg > 180) lonDeg -= 360;
  if (lonDeg < -180) lonDeg += 360;
  return { lat: lat / DEG, lon: lonDeg };
}

// Velocity of the ground (co-rotating atmosphere) at inertial position r.
export const groundVelocity = (r) => [-OMEGA_EARTH * r[1], OMEGA_EARTH * r[0], 0];

export function formatUtc(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
}

// Mission-elapsed-time style formatting: T+ 1d 02:03:04
export function formatDuration(sec) {
  const sign = sec < 0 ? '-' : '+';
  let s = Math.abs(Math.floor(sec));
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const p = (n) => String(n).padStart(2, '0');
  return `T${sign} ${d > 0 ? d + 'd ' : ''}${p(h)}:${p(m)}:${p(s)}`;
}
