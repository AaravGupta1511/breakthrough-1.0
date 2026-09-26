// Flat world map with day/night shading and ground tracks.

import { DEG } from '../core/constants.js';
import { sunPositionEci } from '../core/ephemeris.js';
import { eciToGeo, gmst } from '../core/time.js';
import { CATEGORIES } from '../data/catalog.js';
import { mapTexture } from './textures.js';

export class GroundTrackMap {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
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
    return [((lon + 180) / 360) * this.w, ((90 - lat) / 180) * this.h];
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
      if (!prev || Math.abs(lon - prev) > 180) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      prev = lon;
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

  draw({ ms, mission, selected, sites }) {
    const { ctx, w, h } = this;
    ctx.drawImage(this.base, 0, 0);

    // Night side: region beyond the terminator.
    const sun = sunPositionEci(ms);
    const dec = Math.atan2(sun[2], Math.hypot(sun[0], sun[1]));
    const subLon = ((Math.atan2(sun[1], sun[0]) - gmst(ms)) / DEG + 540) % 360 - 180;
    const tanDec = Math.abs(Math.tan(dec)) < 1e-4 ? 1e-4 * Math.sign(dec || 1) : Math.tan(dec);
    ctx.fillStyle = 'rgba(2, 6, 20, 0.5)';
    ctx.beginPath();
    ctx.moveTo(0, dec > 0 ? h : 0);
    for (let lon = -180; lon <= 180; lon += 2) {
      const lat = Math.atan(-Math.cos((lon - subLon) * DEG) / tanDec) / DEG;
      const [x, y] = this.xy(lat, lon);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, dec > 0 ? h : 0);
    ctx.closePath();
    ctx.fill();
    this.dot(dec / DEG, subLon, '#ffd65c', 4);

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
