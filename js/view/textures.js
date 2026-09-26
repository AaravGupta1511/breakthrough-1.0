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

// ------------------------------------------------------------ planets & moons

function noise1(r, n) {
  // Smooth 1D random profile made of a few sine waves.
  const waves = Array.from({ length: n }, () => [1 + r() * 12, r() * Math.PI * 2, 0.3 + r()]);
  return (x) => waves.reduce((s, [f, p, a]) => s + a * Math.sin(x * f + p), 0) / n;
}

// Gas giants: latitude bands with wavy edges and a few storms.
function banded(w, h, palette, seed, storms = []) {
  const c = canvas(w, h);
  const ctx = c.getContext('2d');
  const r = rng(seed);
  const wobble = noise1(r, 5);
  const shade = noise1(r, 7);
  for (let y = 0; y < h; y++) {
    const lat = y / h;
    for (let x = 0; x < w; x += 4) {
      const t = lat + 0.012 * wobble((x / w) * Math.PI * 2 + lat * 20);
      const k = Math.min(palette.length - 1, Math.max(0, Math.floor((0.5 + 0.5 * Math.sin(t * palette.length * 3.1 + shade(t * 9) * 2)) * palette.length)));
      ctx.fillStyle = palette[k];
      ctx.fillRect(x, y, 4, 1);
    }
  }
  for (const [x, y, rx, ry, col] of storms) {
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.ellipse(x * w, y * h, rx * w, ry * h, 0, 0, Math.PI * 2); ctx.fill();
  }
  // Soft blur-like overlay to blend the bands.
  ctx.globalAlpha = 0.35;
  ctx.drawImage(c, 0, 2, w, h - 4);
  ctx.globalAlpha = 1;
  return c;
}

// Rocky or icy bodies: base colour, blotches and craters.
function rocky(w, h, { base, dark, light, seed, blotches = 30, craters = 300, streaks = 0, streakColor = 'rgba(120,70,40,0.5)' }) {
  const c = canvas(w, h);
  const ctx = c.getContext('2d');
  const r = rng(seed);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);
  for (let k = 0; k < blotches; k++) {
    const x = w * r(), y = h * (0.1 + 0.8 * r()), rad = w * (0.02 + 0.07 * r());
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    const col = r() < 0.5 ? dark : light;
    g.addColorStop(0, col); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(x, y, rad * 1.5, rad, r() * 3, 0, Math.PI * 2); ctx.fill();
  }
  ctx.strokeStyle = streakColor;
  for (let k = 0; k < streaks; k++) {
    ctx.lineWidth = 0.6 + r() * 1.4;
    ctx.beginPath();
    let x = w * r(), y = h * (0.15 + 0.7 * r());
    ctx.moveTo(x, y);
    for (let s = 0; s < 6; s++) { x += (r() - 0.5) * w * 0.15; y += (r() - 0.5) * h * 0.1; ctx.lineTo(x, y); }
    ctx.stroke();
  }
  for (let k = 0; k < craters; k++) {
    const x = w * r(), y = h * (0.05 + 0.9 * r());
    const rad = Math.max(0.8, w * 0.01 * Math.pow(r(), 3));
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = Math.max(0.5, rad * 0.3);
    ctx.beginPath(); ctx.arc(x, y, rad, Math.PI, Math.PI * 1.8); ctx.stroke();
  }
  return c;
}

export function bodyTexture(id) {
  const W = 512, H = 256;
  switch (id) {
    case 'mercury': return rocky(W, H, { base: '#8f8a84', dark: 'rgba(60,58,55,0.5)', light: 'rgba(200,195,185,0.4)', seed: 11, craters: 700 });
    case 'venus': return banded(W, H, ['#e8d4a2', '#dcc38c', '#efdcb0', '#d6b77c'], 12);
    case 'mars': {
      const c = rocky(W, H, { base: '#b5532c', dark: 'rgba(70,30,20,0.55)', light: 'rgba(220,140,90,0.4)', seed: 13, blotches: 45, craters: 250 });
      const ctx = c.getContext('2d');
      ctx.fillStyle = 'rgba(245,245,250,0.9)';
      ctx.fillRect(0, 0, W, H * 0.05); ctx.fillRect(0, H * 0.96, W, H * 0.04); // polar caps
      return c;
    }
    case 'jupiter': return banded(W, H, ['#e9dcc4', '#c89b6b', '#f3eadb', '#b07a4f', '#dcc3a0', '#8f6444'], 14, [[0.62, 0.64, 0.035, 0.028, '#c2593c']]);
    case 'saturn': return banded(W, H, ['#eadbb0', '#d9c38f', '#f1e5c4', '#cdb27a'], 15);
    case 'uranus': return banded(W, H, ['#a8e0e6', '#9fd6de', '#b3e6ea'], 16);
    case 'neptune': return banded(W, H, ['#4b72d9', '#5a82e4', '#3f63c4', '#6d91ea'], 17, [[0.4, 0.62, 0.03, 0.02, '#2a3f8f']]);
    case 'phobos': return rocky(256, 128, { base: '#6e6258', dark: 'rgba(40,34,30,0.5)', light: 'rgba(150,135,120,0.4)', seed: 21, craters: 160 });
    case 'deimos': return rocky(256, 128, { base: '#8c7d6f', dark: 'rgba(60,52,45,0.4)', light: 'rgba(170,155,140,0.4)', seed: 22, craters: 90 });
    case 'io': return rocky(256, 128, { base: '#e2c84a', dark: 'rgba(150,80,30,0.6)', light: 'rgba(250,245,200,0.5)', seed: 23, blotches: 60, craters: 30 });
    case 'europa': return rocky(256, 128, { base: '#e4d9c6', dark: 'rgba(160,120,90,0.35)', light: 'rgba(255,255,255,0.4)', seed: 24, craters: 10, streaks: 40, streakColor: 'rgba(140,80,50,0.55)' });
    case 'ganymede': return rocky(256, 128, { base: '#9b917f', dark: 'rgba(70,62,52,0.55)', light: 'rgba(200,195,185,0.45)', seed: 25, blotches: 40, craters: 120 });
    case 'callisto': return rocky(256, 128, { base: '#5e5448', dark: 'rgba(40,35,30,0.5)', light: 'rgba(210,205,195,0.6)', seed: 26, craters: 400 });
    case 'titan': return banded(256, 128, ['#d9a14a', '#cf9540', '#e2ad5a'], 27);
    case 'enceladus': return rocky(256, 128, { base: '#f2f5f8', dark: 'rgba(170,190,210,0.35)', light: 'rgba(255,255,255,0.6)', seed: 28, craters: 60, streaks: 12, streakColor: 'rgba(120,160,200,0.5)' });
    case 'titania': return rocky(256, 128, { base: '#a39d97', dark: 'rgba(80,75,70,0.45)', light: 'rgba(210,205,200,0.4)', seed: 29, craters: 200 });
    case 'triton': return rocky(256, 128, { base: '#dcc8bf', dark: 'rgba(150,120,110,0.45)', light: 'rgba(245,235,230,0.5)', seed: 30, blotches: 50, craters: 40 });
    default: return rocky(256, 128, { base: '#999', dark: 'rgba(0,0,0,0.3)', light: 'rgba(255,255,255,0.3)', seed: 31 });
  }
}

// Saturn's rings, drawn as concentric bands for a RingGeometry's planar UVs.
export function ringTexture(size, inner, outer) {
  const c = canvas(size, size);
  const ctx = c.getContext('2d');
  const r = rng(99);
  const cx = size / 2;
  for (let k = 0; k < 220; k++) {
    const f = inner / outer + (1 - inner / outer) * (k / 220);
    const cassini = f > 0.82 && f < 0.86; // the Cassini division
    const a = cassini ? 0.05 : 0.35 + 0.5 * r();
    ctx.strokeStyle = `rgba(${220 - 30 * r()}, ${200 - 30 * r()}, ${160 - 30 * r()}, ${a})`;
    ctx.lineWidth = (size / 2) * (1 - inner / outer) / 220 + 0.5;
    ctx.beginPath(); ctx.arc(cx, cx, f * (size / 2), 0, Math.PI * 2); ctx.stroke();
  }
  return c;
}
