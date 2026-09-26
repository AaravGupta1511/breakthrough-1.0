// Flat map with day/night shading and ground tracks. It shows the whole
// world, or zooms in on the launch region before and during a launch so the
// range-safety corridor and any dogleg are visible.

import { DEG } from '../core/constants.js';
import { sunPositionEci } from '../core/ephemeris.js';
import { eciToGeo, gmst } from '../core/time.js';
import { CATEGORIES } from '../data/catalog.js';
import { LAND_RINGS } from '../data/land.js';
import { mapTexture } from './textures.js';

const WORLD = { lonMin: -180, lonMax: 180, latMin: -90, latMax: 90 };
// Bounding box of every coastline ring, to skip rings outside a zoomed view.
const RING_BOXES = LAND_RINGS.map((r) => {
  let a = 180, b = -180, c = 90, d = -90;
  for (let i = 0; i < r.length; i += 2) { a = Math.min(a, r[i]); b = Math.max(b, r[i]); c = Math.min(c, r[i + 1]); d = Math.max(d, r[i + 1]); }
  return [a, b, c, d];
});

// A 2:1 view centred on (lat, lon) spanning `spanLon` degrees of longitude.
function viewAround(lat, lon, spanLon) {
  spanLon = Math.min(360, spanLon);
  const spanLat = spanLon / 2;
  const latMin = Math.max(-90, Math.min(90 - spanLat, lat - spanLat / 2));
  return { lonMin: lon - spanLon / 2, lonMax: lon + spanLon / 2, latMin, latMax: latMin + spanLat };
}

export class GroundTrackMap {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.view = WORLD;
    this.resize();
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth || 320;
    const h = w / 2;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.w = this.canvas.width; this.h = this.canvas.height;
    this.dpr = dpr;
    this.base = mapTexture(this.w, this.h);
  }

  xy(lat, lon) {
    const v = this.view;
    if (v !== WORLD) {
      // Zoomed views may straddle the date line: use the nearest copy of lon.
      const c = (v.lonMin + v.lonMax) / 2;
      while (lon - c > 180) lon -= 360;
      while (lon - c < -180) lon += 360;
    }
    return [((lon - v.lonMin) / (v.lonMax - v.lonMin)) * this.w, ((v.latMax - lat) / (v.latMax - v.latMin)) * this.h];
  }

  // Background: the pre-rendered world map, or coastlines redrawn for a zoomed view.
  drawBase() {
    const { ctx, w, h, view } = this;
    if (view === WORLD) { ctx.drawImage(this.base, 0, 0); return; }
    ctx.fillStyle = '#0e2747';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#2d5a3f';
    // Rings are cut at the date line, so draw them as they are on the
    // -180…180 strip, plus a copy either side when the view extends past it.
    const sx = w / (view.lonMax - view.lonMin), sy = h / (view.latMax - view.latMin);
    for (const shift of [-360, 0, 360]) {
      RING_BOXES.forEach(([a, b, c, d], k) => {
        if (b + shift < view.lonMin || a + shift > view.lonMax || d < view.latMin || c > view.latMax) return;
        const ring = LAND_RINGS[k];
        ctx.beginPath();
        for (let i = 0; i < ring.length; i += 2) {
          const x = (ring[i] + shift - view.lonMin) * sx, y = (view.latMax - ring[i + 1]) * sy;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fill();
      });
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    const step = view.lonMax - view.lonMin > 90 ? 10 : 5;
    for (let lon = Math.ceil(view.lonMin / step) * step; lon <= view.lonMax; lon += step) {
      const [x] = this.xy(0, lon);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let lat = Math.ceil(view.latMin / step) * step; lat <= view.latMax; lat += step) {
      const [, y] = this.xy(lat, 0);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
  }

  // Zoom on the launch region before liftoff and while the track is short.
  chooseView(mission, site) {
    if (!mission) return site ? viewAround(site.lat, site.lon, 56) : WORLD;
    const pts = mission.frame === 'earth' || mission.phase === 'ascent' ? mission.groundTrack : [];
    if (!pts.length) return mission.phase === 'countdown' ? viewAround(mission.site.lat, mission.site.lon, 56) : WORLD;
    let a = mission.site.lon, b = a, c = mission.site.lat, d = c;
    for (const [lat, lon] of pts) { a = Math.min(a, lon); b = Math.max(b, lon); c = Math.min(c, lat); d = Math.max(d, lat); }
    const spanLon = Math.max(56, (b - a) * 1.3, (d - c) * 2.6);
    if (b - a > 100 || spanLon > 200) return WORLD;
    return viewAround((c + d) / 2, (a + b) / 2, spanLon);
  }

  polyline(points, color, width = 1.5, dash = null) {
    const { ctx } = this;
    ctx.strokeStyle = color;
    ctx.lineWidth = width * this.dpr;
    ctx.setLineDash(dash ? dash.map((d) => d * this.dpr) : []);
    ctx.beginPath();
    let prev = null;
    for (const [lat, lon] of points) {
      const [x, y] = this.xy(lat, lon);
      if (!prev || Math.abs(x - prev) > this.w / 2) ctx.moveTo(x, y); else ctx.lineTo(x, y); // break at the date line
      prev = x;
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  dot(lat, lon, color, r = 3.5, ring = false) {
    const { ctx } = this;
    const [x, y] = this.xy(lat, lon);
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x, y, r * this.dpr, 0, Math.PI * 2); ctx.fill();
    if (ring) {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1.2 * this.dpr;
      ctx.beginPath(); ctx.arc(x, y, (r + 3) * this.dpr, 0, Math.PI * 2); ctx.stroke();
    }
  }

  // Great-circle point `distDeg` away from (lat, lon) along bearing `azDeg`.
  static destination(lat, lon, azDeg, distDeg) {
    const p = lat * DEG, l = lon * DEG, b = azDeg * DEG, d = distDeg * DEG;
    const p2 = Math.asin(Math.sin(p) * Math.cos(d) + Math.cos(p) * Math.sin(d) * Math.cos(b));
    const l2 = l + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p), Math.cos(d) - Math.sin(p) * Math.sin(p2));
    return [p2 / DEG, ((l2 / DEG + 540) % 360) - 180];
  }

  // Range-safety corridor of the selected site, and the planned heading.
  drawCorridor(site, plan) {
    const { ctx } = this;
    const reach = 22; // degrees of arc
    const [sx, sy] = this.xy(site.lat, site.lon);
    ctx.fillStyle = 'rgba(92, 225, 230, 0.16)';
    ctx.strokeStyle = 'rgba(92, 225, 230, 0.6)';
    ctx.lineWidth = 1 * this.dpr;
    for (const [a, b] of site.corridors || [[0, 360]]) {
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      for (let az = a; az <= b; az += 2) { const [x, y] = this.xy(...GroundTrackMap.destination(site.lat, site.lon, az, reach)); ctx.lineTo(x, y); }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    if (!plan) return;
    // Planned path: out along the launch azimuth, then (for a dogleg) the turn.
    ctx.strokeStyle = '#ffd24d';
    ctx.lineWidth = 1.6 * this.dpr;
    ctx.setLineDash([4 * this.dpr, 3 * this.dpr]);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    const leg = plan.dogleg ? 4 : reach;
    const [mlat, mlon] = GroundTrackMap.destination(site.lat, site.lon, plan.launchAz, leg);
    let [x, y] = this.xy(mlat, mlon);
    ctx.lineTo(x, y);
    if (plan.dogleg) {
      [x, y] = this.xy(...GroundTrackMap.destination(mlat, mlon, plan.targetAz, reach - leg));
      ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  draw({ ms, mission, selected, sites, site = null, plan = null }) {
    const { ctx, w, h } = this;
    this.view = this.chooseView(mission, site);
    this.drawBase();

    // Night side: region beyond the terminator.
    const sun = sunPositionEci(ms);
    const dec = Math.atan2(sun[2], Math.hypot(sun[0], sun[1]));
    const subLon = ((Math.atan2(sun[1], sun[0]) - gmst(ms)) / DEG + 540) % 360 - 180;
    const tanDec = Math.abs(Math.tan(dec)) < 1e-4 ? 1e-4 * Math.sign(dec || 1) : Math.tan(dec);
    ctx.fillStyle = 'rgba(2, 6, 20, 0.5)';
    ctx.beginPath();
    ctx.moveTo(0, dec > 0 ? h : 0);
    const v = this.view, lonStep = (v.lonMax - v.lonMin) / 180;
    for (let lon = v.lonMin; lon <= v.lonMax + 1e-9; lon += lonStep) {
      const lat = Math.atan(-Math.cos((lon - subLon) * DEG) / tanDec) / DEG;
      const [x, y] = this.xy(lat, lon);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, dec > 0 ? h : 0);
    ctx.closePath();
    ctx.fill();
    this.dot(dec / DEG, subLon, '#ffd65c', 4);

    if (site && !mission) this.drawCorridor(site, plan);

    for (const s of sites) {
      const [x, y] = this.xy(s.lat, s.lon);
      ctx.fillStyle = '#ffa24d';
      ctx.beginPath();
      ctx.moveTo(x, y - 4 * this.dpr); ctx.lineTo(x + 3.5 * this.dpr, y + 3 * this.dpr); ctx.lineTo(x - 3.5 * this.dpr, y + 3 * this.dpr);
      ctx.fill();
    }

    if (selected && selected.orbit) {
      const color = CATEGORIES[selected.cat]?.color || '#fff';
      const span = Math.min(selected.orbit.period, 86400) * 1000;
      const pts = [];
      for (let k = 0; k <= 200; k++) {
        const t = ms + (k / 200) * span;
        const g = eciToGeo(selected.orbit.positionAt(t), t);
        pts.push([g.lat, g.lon]);
      }
      this.polyline(pts, color, 1.2, [4, 3]);
      const g = eciToGeo(selected.getPosition(), ms);
      this.dot(g.lat, g.lon, color, 3.5, true);
    }

    if (mission) {
      this.polyline(mission.groundTrack, '#ffd24d', 1.6);
      if (mission.phase === 'coast' && mission.frame === 'earth') {
        const el = mission.elements();
        const span = Math.min(el && el.e < 1 ? el.period * 1.2 : 6 * 3600, 12 * 3600) * 1000;
        const pts = [];
        for (let k = 0; k <= 200; k++) {
          const t = ms + (k / 200) * span;
          const g = eciToGeo(mission.stateAtArc(t).r, t);
          pts.push([g.lat, g.lon]);
        }
        this.polyline(pts, 'rgba(92,225,230,0.9)', 1.2, [5, 4]);
      }
      if (mission.frame === 'earth') {
        const g = eciToGeo(mission.positionEci(), ms);
        this.dot(g.lat, g.lon, '#ffe066', 4, true);
      }
    }
  }
}
