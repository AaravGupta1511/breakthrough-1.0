// Procedurally generated textures, so the site needs no image downloads.

import { LAND_RINGS } from '../data/land.js';
import { rng } from '../data/catalog.js';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// Trace every land ring onto a 2D context in equirectangular projection.
function traceLand(ctx, w, h, each) {
  for (const ring of LAND_RINGS) {
    ctx.beginPath();
    for (let i = 0; i < ring.length; i += 2) {
      const x = ((ring[i] + 180) / 360) * w;
      const y = ((90 - ring[i + 1]) / 180) * h;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    each(ring);
  }
}

// Stroke coastlines, skipping artificial edges along the date line / pole.
function strokeCoasts(ctx, w, h) {
  const edge = (lon, lat) => Math.abs(lon) >= 179.9 || lat <= -84;
  for (const ring of LAND_RINGS) {
    ctx.beginPath();
    for (let i = 2; i < ring.length; i += 2) {
      const [lo0, la0, lo1, la1] = [ring[i - 2], ring[i - 1], ring[i], ring[i + 1]];
      if (edge(lo0, la0) && edge(lo1, la1)) continue;
      ctx.moveTo(((lo0 + 180) / 360) * w, ((90 - la0) / 180) * h);
      ctx.lineTo(((lo1 + 180) / 360) * w, ((90 - la1) / 180) * h);
    }
    ctx.stroke();
  }
}

export function earthTextures(size = 4096) {
  const w = size, h = size / 2;
  const day = canvas(w, h);
  const ctx = day.getContext('2d');

  // Ocean: deeper blue towards the poles.
  const ocean = ctx.createLinearGradient(0, 0, 0, h);
  ocean.addColorStop(0, '#0b1f3d');
  ocean.addColorStop(0.5, '#123f73');
  ocean.addColorStop(1, '#0b1f3d');
  ctx.fillStyle = ocean;
  ctx.fillRect(0, 0, w, h);

  // Land coloured by latitude band: ice, boreal, temperate, arid, tropical.
  const lat = (deg) => (90 - deg) / 180;
  const land = ctx.createLinearGradient(0, 0, 0, h);
  [[90, '#f2f5f7'], [72, '#e6ebee'], [66, '#7d8b6a'], [55, '#3f6b3a'], [42, '#5f8a45'],
    [32, '#b59b62'], [18, '#c9a86a'], [10, '#4f8a3c'], [0, '#2f6e32'], [-10, '#3d7a36'],
    [-22, '#b99d64'], [-32, '#8e9a58'], [-45, '#4d7a45'], [-58, '#7d8b6a'], [-64, '#e9eef1'], [-90, '#f7f9fb']]
    .forEach(([d, c]) => land.addColorStop(lat(d), c));
  ctx.fillStyle = land;
  traceLand(ctx, w, h, () => ctx.fill());
  ctx.strokeStyle = 'rgba(210, 235, 255, 0.35)';
  ctx.lineWidth = w / 4096;
  strokeCoasts(ctx, w, h);

  // Specular mask: oceans shine, land does not.
  const spec = canvas(w / 2, h / 2);
  const sctx = spec.getContext('2d');
  sctx.fillStyle = '#6a6a6a';
  sctx.fillRect(0, 0, w / 2, h / 2);
  sctx.fillStyle = '#000';
  traceLand(sctx, w / 2, h / 2, () => sctx.fill());

  return { day, spec };
}

export function moonTexture(size = 1024) {
  const w = size, h = size / 2;
  const c = canvas(w, h);
  const ctx = c.getContext('2d');
  const r = rng(1969);
  ctx.fillStyle = '#9a9894';
  ctx.fillRect(0, 0, w, h);
  // Maria: dark basalt plains, mostly on the near side (centre of the map).
  for (let k = 0; k < 26; k++) {
    const x = w * (0.3 + 0.4 * r()), y = h * (0.25 + 0.5 * r());
    const rad = w * (0.02 + 0.05 * r());
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, 'rgba(70,70,72,0.75)');
    g.addColorStop(1, 'rgba(70,70,72,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(x, y, rad * 1.4, rad, r() * 3, 0, Math.PI * 2); ctx.fill();
  }
  // Craters with bright rims.
  for (let k = 0; k < 900; k++) {
    const x = w * r(), y = h * (0.05 + 0.9 * r());
    const rad = Math.max(1, w * 0.012 * Math.pow(r(), 3));
    ctx.fillStyle = 'rgba(60,60,60,0.35)';
    ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(230,230,225,0.35)';
    ctx.lineWidth = Math.max(0.5, rad * 0.25);
    ctx.beginPath(); ctx.arc(x - rad * 0.15, y - rad * 0.15, rad, Math.PI * 0.9, Math.PI * 1.9); ctx.stroke();
  }
  return c;
}

// Soft round sprite for points and glows.
export function glowTexture(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)', size = 128, hardness = 0.15) {
  const c = canvas(size, size);
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner);
  g.addColorStop(hardness, inner);
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

export function dotTexture(size = 64) {
  const c = canvas(size, size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2); ctx.fill();
  return c;
}

// Flat map for the ground-track panel.
export function mapTexture(w, h) {
  const c = canvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0e2747';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#2d5a3f';
  traceLand(ctx, w, h, () => ctx.fill());
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  for (let lon = -150; lon <= 150; lon += 30) {
    const x = ((lon + 180) / 360) * w;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  for (let la = -60; la <= 60; la += 30) {
    const y = ((90 - la) / 180) * h;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  return c;
}
