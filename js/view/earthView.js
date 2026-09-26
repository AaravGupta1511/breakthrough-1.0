// Earth-centred 3D view built with three.js.
// Everything orbital lives in the `eci` group, whose local axes are the
// Earth-centred inertial frame (z = north); the group is rotated so that
// north points up on screen. Units are kilometres.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { R_EARTH, R_MOON } from '../core/constants.js';
import { moonPositionEci, sunPositionEci } from '../core/ephemeris.js';
import { gmst } from '../core/time.js';
import { CATEGORIES } from '../data/catalog.js';
import { dotTexture, earthTextures, glowTexture, moonTexture } from './textures.js';

const TRAIL_MAX = 6000;
const PATH_MAX = 400;

export const eciToWorld = (p, out = new THREE.Vector3()) => out.set(p[0], p[2], -p[1]);

function lineGeometry(maxPoints) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(maxPoints * 3), 3));
  g.setDrawRange(0, 0);
  return g;
}

function writeLine(line, points, offset = null) {
  const attr = line.geometry.attributes.position;
  const max = attr.count;
  const start = Math.max(0, points.length - max);
  let n = 0;
  for (let i = start; i < points.length; i++, n++) {
    const p = points[i];
    attr.array[n * 3] = p[0] - (offset ? offset[0] : 0);
    attr.array[n * 3 + 1] = p[1] - (offset ? offset[1] : 0);
    attr.array[n * 3 + 2] = p[2] - (offset ? offset[2] : 0);
  }
  attr.needsUpdate = true;
  line.geometry.setDrawRange(0, n);
  line.geometry.computeBoundingSphere();
  if (line.material.isLineDashedMaterial) line.computeLineDistances();
}

export class EarthView {
  constructor(renderer, sites) {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 2e9);
    this.camera.position.set(14000, 9000, 22000);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = R_EARTH * 1.05;
    this.controls.maxDistance = 3e6;
    this.controls.zoomSpeed = 1.2;

    this.eci = new THREE.Group();
    this.eci.rotation.x = -Math.PI / 2;
    this.scene.add(this.eci);

    this.layers = {};
    this.options = { grid: true, orbits: true, labels: true, proximity: true, moonOrbit: true, sites: true };
    this.followFn = null;
    this.tween = null;
    this.mode = 'earth';

    this.buildLights();
    this.buildStars();
    this.buildEarth(sites);
    this.buildMoon();
    this.buildMissionObjects();
    this.buildHighlights();
  }

  // ------------------------------------------------------------------ build

  buildLights() {
    this.sunLight = new THREE.DirectionalLight(0xffffff, 3.2);
    this.scene.add(this.sunLight, this.sunLight.target);
    this.scene.add(new THREE.AmbientLight(0x6d7fa8, 0.25));

    const sunMat = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(glowTexture('rgba(255,250,235,1)', 'rgba(255,200,120,0)', 256, 0.18)), blending: THREE.AdditiveBlending, depthWrite: false });
    this.sunSprite = new THREE.Sprite(sunMat);
    this.sunSprite.scale.setScalar(1.2e7);
    this.scene.add(this.sunSprite);
  }

  buildStars() {
    const n = 5000;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) {
      const u = rand() * 2 - 1, th = rand() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      pos.set([1e9 * s * Math.cos(th), 1e9 * u, 1e9 * s * Math.sin(th)], i * 3);
      const b = 0.35 + 0.65 * Math.pow(rand(), 3);
      const tint = rand();
      col.set(tint < 0.15 ? [b, b * 0.85, b * 0.7] : tint > 0.85 ? [b * 0.8, b * 0.9, b] : [b, b, b], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const m = new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, depthWrite: false });
    this.stars = new THREE.Points(g, m);
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);
  }

  buildEarth(sites) {
    this.earthSpin = new THREE.Group(); // Earth-fixed frame (ECEF)
    this.eci.add(this.earthSpin);

    const maxTex = this.renderer.capabilities.maxTextureSize >= 4096 && window.innerWidth > 700 ? 4096 : 2048;
    const tex = earthTextures(maxTex);
    const map = new THREE.CanvasTexture(tex.day);
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const spec = new THREE.CanvasTexture(tex.spec);
    const earth = new THREE.Mesh(
      new THREE.SphereGeometry(R_EARTH, 128, 96),
      // The faint emissive copy of the map keeps the night side readable.
      new THREE.MeshPhongMaterial({
        map, specularMap: spec, specular: new THREE.Color(0x3a5a80), shininess: 22,
        emissiveMap: map, emissive: new THREE.Color(0x3a4a66), emissiveIntensity: 0.55,
      }),
    );
    earth.rotation.x = Math.PI / 2; // geometry poles (y) -> ECI z; lon 0 -> +x
    this.earthSpin.add(earth);
    this.earthMesh = earth;

    // Atmosphere rim.
    this.atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(R_EARTH * 1.025, 96, 64),
      new THREE.ShaderMaterial({
        uniforms: { sunDir: { value: new THREE.Vector3(1, 0, 0) }, glowColor: { value: new THREE.Color(0x5aa9ff) } },
        vertexShader: `
          #include <common>
          #include <logdepthbuf_pars_vertex>
          varying vec3 vNormal; varying vec3 vWorld;
          void main() {
            vNormal = normalize(mat3(modelMatrix) * normal);
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vWorld = wp.xyz;
            gl_Position = projectionMatrix * viewMatrix * wp;
            #include <logdepthbuf_vertex>
          }`,
        fragmentShader: `
          #include <common>
          #include <logdepthbuf_pars_fragment>
          uniform vec3 sunDir; uniform vec3 glowColor;
          varying vec3 vNormal; varying vec3 vWorld;
          void main() {
            #include <logdepthbuf_fragment>
            vec3 viewDir = normalize(cameraPosition - vWorld);
            float rim = 1.0 - max(dot(viewDir, vNormal), 0.0);
            float glow = pow(rim, 2.6);
            float lit = smoothstep(-0.35, 0.4, dot(vNormal, sunDir));
            gl_FragColor = vec4(glowColor * glow * (0.15 + 1.1 * lit), glow * (0.1 + 0.9 * lit));
          }`,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.scene.add(this.atmosphere);

    // Latitude / longitude grid, in the Earth-fixed frame.
    const gridPts = [], eqPts = [];
    const R = R_EARTH * 1.0015;
    const toXYZ = (lat, lon) => {
      const a = (lat * Math.PI) / 180, b = (lon * Math.PI) / 180;
      return [R * Math.cos(a) * Math.cos(b), R * Math.cos(a) * Math.sin(b), R * Math.sin(a)];
    };
    for (let lat = -60; lat <= 60; lat += 30) {
      const target = lat === 0 ? eqPts : gridPts;
      for (let lon = 0; lon < 360; lon += 3) target.push(...toXYZ(lat, lon), ...toXYZ(lat, lon + 3));
    }
    for (let lon = 0; lon < 360; lon += 30) {
      const target = lon === 0 ? eqPts : gridPts;
      for (let lat = -88; lat < 88; lat += 4) target.push(...toXYZ(lat, lon), ...toXYZ(lat + 4, lon));
    }
    const mk = (pts, opacity) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x7fc3ff, transparent: true, opacity, depthWrite: false }));
    };
    this.grid = new THREE.Group();
    this.grid.add(mk(gridPts, 0.12), mk(eqPts, 0.35));
    this.earthSpin.add(this.grid);

    // Launch sites.
    this.sites = sites;
    const sp = [];
    for (const s of sites) sp.push(...toXYZ(s.lat, s.lon).map((v) => (v / R) * (R_EARTH + 8)));
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
    this.sitePoints = new THREE.Points(sg, new THREE.PointsMaterial({ size: 7, sizeAttenuation: false, color: 0xffa24d, map: new THREE.CanvasTexture(dotTexture()), transparent: true, alphaTest: 0.4 }));
    this.earthSpin.add(this.sitePoints);
  }

  buildMoon() {
    this.moonFrame = new THREE.Group(); // Moon-centred, inertial axes
    this.eci.add(this.moonFrame);
    const tex = new THREE.CanvasTexture(moonTexture(1024));
    tex.colorSpace = THREE.SRGBColorSpace;
    this.moonMesh = new THREE.Mesh(
      new THREE.SphereGeometry(R_MOON, 64, 48),
      new THREE.MeshPhongMaterial({ map: tex, shininess: 2, specular: 0x000000 }),
    );
    this.moonFrame.add(this.moonMesh);
    // Constant-size marker so the Moon stays findable when zoomed far out.
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    this.moonDot = new THREE.Points(mg, new THREE.PointsMaterial({ size: 7, sizeAttenuation: false, color: 0xd8dde8, map: new THREE.CanvasTexture(dotTexture()), transparent: true, alphaTest: 0.4 }));
    this.moonDot.frustumCulled = false;
    this.moonFrame.add(this.moonDot);

    this.moonOrbit = new THREE.Line(lineGeometry(PATH_MAX), new THREE.LineBasicMaterial({ color: 0x9aa4b8, transparent: true, opacity: 0.35 }));
    this.moonOrbit.frustumCulled = false;
    this.eci.add(this.moonOrbit);
    this.moonOrbitMs = null;
  }

  buildMissionObjects() {
    const glow = new THREE.CanvasTexture(glowTexture('rgba(255,236,150,1)', 'rgba(255,190,60,0)', 128, 0.2));
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    this.craft = new THREE.Points(cg, new THREE.PointsMaterial({ size: 22, sizeAttenuation: false, map: glow, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.craft.frustumCulled = false;
    this.craft.visible = false;
    this.eci.add(this.craft);

    this.trail = new THREE.Line(lineGeometry(TRAIL_MAX), new THREE.LineBasicMaterial({ color: 0xffd24d, transparent: true, opacity: 0.9 }));
    this.trailMoon = new THREE.Line(lineGeometry(TRAIL_MAX), new THREE.LineBasicMaterial({ color: 0xffd24d, transparent: true, opacity: 0.9 }));
    this.path = new THREE.Line(lineGeometry(PATH_MAX), new THREE.LineDashedMaterial({ color: 0x5ce1e6, dashSize: 250, gapSize: 180, transparent: true, opacity: 0.85 }));
    this.pathMoon = new THREE.Line(lineGeometry(PATH_MAX), new THREE.LineDashedMaterial({ color: 0x5ce1e6, dashSize: 60, gapSize: 40, transparent: true, opacity: 0.85 }));
    for (const l of [this.trail, this.trailMoon, this.path, this.pathMoon]) { l.frustumCulled = false; l.visible = false; }
    this.eci.add(this.trail, this.path);
    this.moonFrame.add(this.trailMoon, this.pathMoon);

    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6 * 3 * 2), 3));
    pg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(6 * 3 * 2), 3));
    this.proxLines = new THREE.LineSegments(pg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.7 }));
    this.proxLines.frustumCulled = false;
    this.eci.add(this.proxLines);
  }

  buildHighlights() {
    const ring = document.createElement('canvas');
    ring.width = ring.height = 64;
    const c = ring.getContext('2d');
    c.strokeStyle = '#fff'; c.lineWidth = 5;
    c.beginPath(); c.arc(32, 32, 26, 0, Math.PI * 2); c.stroke();
    const tex = new THREE.CanvasTexture(ring);
    const mk = (size, color) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
      const p = new THREE.Points(g, new THREE.PointsMaterial({ size, sizeAttenuation: false, map: tex, color, transparent: true, depthTest: false, depthWrite: false }));
      p.frustumCulled = false; p.visible = false; p.renderOrder = 10;
      this.eci.add(p);
      return p;
    };
    this.selMarker = mk(22, 0xffffff);
    this.hoverMarker = mk(16, 0x9fd7ff);
    this.selOrbit = new THREE.Line(lineGeometry(PATH_MAX), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 }));
    this.selOrbit.frustumCulled = false; this.selOrbit.visible = false;
    this.eci.add(this.selOrbit);
    this.selOrbitStamp = 0;
  }

  // Replace (or create) a catalogue layer. `pop` is a Population.
  setLayer(cat, pop) {
    const old = this.layers[cat];
    if (old) { this.eci.remove(old.points); old.points.geometry.dispose(); }
    const style = CATEGORIES[cat];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pop.positions, 3));
    const m = new THREE.PointsMaterial({
      size: style.size, sizeAttenuation: false, color: new THREE.Color(style.color),
      map: this.dot || (this.dot = new THREE.CanvasTexture(dotTexture())), transparent: true, alphaTest: 0.35, depthWrite: false,
    });
    const points = new THREE.Points(g, m);
    points.frustumCulled = false;
    this.eci.add(points);
    this.layers[cat] = { pop, points, visible: old ? old.visible : true };
    points.visible = this.layers[cat].visible;
  }

  setLayerVisible(cat, on) {
    const l = this.layers[cat];
    if (l) { l.visible = on; l.points.visible = on; }
  }

  // ------------------------------------------------------------------ update

  update(ms, { mission, selected, hovered, nearest, threshold }) {
    // Earth rotation, Sun and Moon.
    this.earthSpin.rotation.z = gmst(ms);
    const sun = sunPositionEci(ms);
    const sunW = eciToWorld(sun);
    this.sunDirWorld = sunW.clone().normalize();
    this.sunLight.position.copy(this.sunDirWorld).multiplyScalar(1e6);
    this.sunSprite.position.copy(sunW);
    this.atmosphere.material.uniforms.sunDir.value.copy(this.sunDirWorld);

    const moon = moonPositionEci(ms);
    this.moonEci = moon;
    this.moonFrame.position.set(moon[0], moon[1], moon[2]);
    // Tidally locked: the same face (texture longitude 0) always faces Earth.
    const toEarth = Math.atan2(-moon[1], -moon[0]);
    this.moonMesh.rotation.set(0, 0, 0);
    this.moonMesh.rotateZ(toEarth);
    this.moonMesh.rotateX(Math.PI / 2); // geometry poles -> z, longitude 0 -> Earth

    if (this.options.moonOrbit && (this.moonOrbitMs == null || Math.abs(ms - this.moonOrbitMs) > 86400e3)) {
      const pts = [];
      for (let k = 0; k <= 360; k++) pts.push(moonPositionEci(ms + (k / 360 - 0.5) * 27.4 * 86400e3));
      writeLine(this.moonOrbit, pts);
      this.moonOrbitMs = ms;
    }
    this.moonOrbit.visible = this.options.moonOrbit;
    this.grid.visible = this.options.grid;
    this.sitePoints.visible = this.options.sites;

    // Shrink catalogue dots when zoomed far out so they don't swamp the Earth.
    const camDist = this.camera.position.length();
    const shrink = Math.min(1, Math.max(0.35, 90000 / camDist));
    for (const [cat, l] of Object.entries(this.layers)) {
      l.points.geometry.attributes.position.needsUpdate = true;
      l.points.material.size = CATEGORIES[cat].size * shrink;
    }

    this.updateMission(mission, nearest, threshold);
    this.updateHighlights(ms, selected, hovered);
  }

  updateMission(mission, nearest, threshold) {
    const on = !!mission;
    this.craft.visible = on;
    this.trail.visible = on;
    this.trailMoon.visible = on && mission.trail.moon.length > 1;
    if (!on) {
      this.path.visible = this.pathMoon.visible = this.proxLines.visible = false;
      return;
    }
    const p = mission.positionEci();
    this.craftEci = p;
    const a = this.craft.geometry.attributes.position;
    a.array[0] = p[0]; a.array[1] = p[1]; a.array[2] = p[2];
    a.needsUpdate = true;
    writeLine(this.trail, mission.trail.earth);
    writeLine(this.trailMoon, mission.trail.moon);

    // Predicted path: refresh a few times per second.
    const now = performance.now();
    if (!this.pathStamp || now - this.pathStamp > 250) {
      this.pathStamp = now;
      const pred = mission.predictedPath();
      this.path.visible = !!pred && pred.frame === 'earth';
      this.pathMoon.visible = !!pred && pred.frame === 'moon';
      if (pred) writeLine(pred.frame === 'moon' ? this.pathMoon : this.path, pred.points);
    }

    // Lines to the nearest objects.
    const close = (nearest || []).filter((it) => it.distance < Math.max(1500, threshold * 2)).slice(0, 3);
    const show = this.options.proximity && close.length && mission.phase !== 'countdown';
    this.proxLines.visible = !!show;
    if (show) {
      const pos = this.proxLines.geometry.attributes.position;
      const col = this.proxLines.geometry.attributes.color;
      let n = 0;
      for (const it of close) {
        const q = it.obj.getPosition(); // current, not the last proximity scan
        pos.array.set([p[0], p[1], p[2], q[0], q[1], q[2]], n * 6);
        const c = it.distance < threshold ? [1, 0.35, 0.3] : [0.35, 0.6, 0.85];
        col.array.set([...c, ...c.map((x) => x * 0.25)], n * 6);
        n++;
      }
      pos.needsUpdate = col.needsUpdate = true;
      this.proxLines.geometry.setDrawRange(0, n * 2);
    }
  }

  updateHighlights(ms, selected, hovered) {
    const place = (marker, obj) => {
      marker.visible = !!obj;
      if (!obj) return;
      const a = marker.geometry.attributes.position;
      const p = obj.getPosition();
      a.array[0] = p[0]; a.array[1] = p[1]; a.array[2] = p[2];
      a.needsUpdate = true;
    };
    place(this.selMarker, selected);
    place(this.hoverMarker, hovered && hovered !== selected ? hovered : null);

    const orbit = selected && selected.orbit;
    this.selOrbit.visible = !!orbit && this.options.orbits;
    if (orbit && this.options.orbits && (this.selOrbitObj !== selected || Math.abs(ms - this.selOrbitStamp) > 60000)) {
      writeLine(this.selOrbit, orbit.pathAt(ms, 240));
      this.selOrbit.material.color.set(CATEGORIES[selected.cat]?.color || '#ffffff');
      this.selOrbitObj = selected;
      this.selOrbitStamp = ms;
    }
  }

  // ------------------------------------------------------------------ camera

  // mode: 'earth' | 'follow' | 'moon' | 'earthmoon'; fn returns an ECI position.
  setView(mode, followFn = null, followDist = 900) {
    this.mode = mode;
    const fromTarget = this.controls.target.clone();
    const fromOffset = this.camera.position.clone().sub(fromTarget);
    let dist;
    if (mode === 'earth') { this.followFn = null; dist = 26000; this.controls.minDistance = R_EARTH * 1.05; }
    else if (mode === 'earthmoon') { this.followFn = null; dist = 1.05e6; this.controls.minDistance = R_EARTH * 1.05; }
    else if (mode === 'moon') { this.followFn = () => this.moonEci; dist = 9000; this.controls.minDistance = R_MOON * 1.05; }
    else { this.followFn = followFn; dist = followDist; this.controls.minDistance = 2; }
    let dir = fromOffset.lengthSq() > 0 ? fromOffset.clone().normalize() : new THREE.Vector3(0.5, 0.35, 0.8).normalize();
    if (mode === 'earthmoon') dir.set(0.3, 0.7, 0.65).normalize();
    if (mode === 'follow' || mode === 'moon') {
      // Satellites: look from above and to the side, Earth as backdrop.
      // Moon: look from the Earth side, so we see the familiar near side.
      const up = this.targetWorld().normalize();
      if (up.lengthSq() > 0) {
        let side = new THREE.Vector3().crossVectors(up, new THREE.Vector3(0, 1, 0));
        if (side.lengthSq() < 1e-6) side = new THREE.Vector3(1, 0, 0);
        side.normalize();
        dir = up.multiplyScalar(mode === 'moon' ? -0.8 : 0.75).add(side.multiplyScalar(0.55)).add(new THREE.Vector3(0, 0.35, 0)).normalize();
      }
    }
    this.tween = { t0: performance.now(), dur: 1100, fromTarget, fromOffset, toOffset: dir.multiplyScalar(dist) };
  }

  targetWorld() {
    if (!this.followFn) return new THREE.Vector3();
    const p = this.followFn();
    return p ? eciToWorld(p) : new THREE.Vector3();
  }

  updateCamera() {
    const target = this.targetWorld();
    if (this.tween) {
      const t = Math.min(1, (performance.now() - this.tween.t0) / this.tween.dur);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const tgt = this.tween.fromTarget.clone().lerp(target, e);
      // Interpolate the offset direction linearly and its length logarithmically.
      const l0 = Math.log(this.tween.fromOffset.length()), l1 = Math.log(this.tween.toOffset.length());
      const dir = this.tween.fromOffset.clone().normalize().lerp(this.tween.toOffset.clone().normalize(), e).normalize();
      this.controls.target.copy(tgt);
      this.camera.position.copy(tgt).add(dir.multiplyScalar(Math.exp(l0 + (l1 - l0) * e)));
      if (t >= 1) this.tween = null;
    } else if (this.followFn) {
      const delta = target.clone().sub(this.controls.target);
      this.controls.target.add(delta);
      this.camera.position.add(delta);
    }
    this.controls.update();
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render() {
    this.updateCamera();
    this.renderer.render(this.scene, this.camera);
  }

  // ------------------------------------------------------------------ screen space

  // Projector from ECI to canvas pixels; returns null when behind the camera.
  projector() {
    this.scene.updateMatrixWorld();
    this.camera.updateMatrixWorld();
    const m = new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse).multiply(this.eci.matrixWorld);
    const e = m.elements;
    const w = this.renderer.domElement.clientWidth, h = this.renderer.domElement.clientHeight;
    const cam = this.camera.position;
    const moon = this.moonEci ? eciToWorld(this.moonEci) : null;
    return {
      project(x, y, z) {
        const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
        if (cw <= 0) return null;
        const cx = (e[0] * x + e[4] * y + e[8] * z + e[12]) / cw;
        const cy = (e[1] * x + e[5] * y + e[9] * z + e[13]) / cw;
        return [((cx + 1) / 2) * w, ((1 - cy) / 2) * h];
      },
      // Is the ECI point hidden behind the Earth or the Moon?
      occluded(x, y, z) {
        const px = x, py = z, pz = -y; // world coordinates
        const hit = (ox, oy, oz, r) => {
          const dx = px - cam.x, dy = py - cam.y, dz = pz - cam.z;
          const len2 = dx * dx + dy * dy + dz * dz;
          let t = ((ox - cam.x) * dx + (oy - cam.y) * dy + (oz - cam.z) * dz) / len2;
          if (t <= 0 || t >= 1) return false;
          const qx = cam.x + t * dx - ox, qy = cam.y + t * dy - oy, qz = cam.z + t * dz - oz;
          return qx * qx + qy * qy + qz * qz < r * r * 0.98;
        };
        return hit(0, 0, 0, R_EARTH) || (moon && hit(moon.x, moon.y, moon.z, R_MOON));
      },
    };
  }

  // Nearest visible catalogue object within `radius` pixels of (x, y).
  pick(x, y, radius = 10) {
    const pr = this.projector();
    let best = null, bestD = radius * radius;
    for (const [cat, layer] of Object.entries(this.layers)) {
      if (!layer.visible) continue;
      const P = layer.pop.positions;
      for (let i = 0, n = layer.pop.objects.length; i < n; i++) {
        const s = pr.project(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
        if (!s) continue;
        const d = (s[0] - x) ** 2 + (s[1] - y) ** 2;
        if (d < bestD && !pr.occluded(P[i * 3], P[i * 3 + 1], P[i * 3 + 2])) { bestD = d; best = { cat, index: i }; }
      }
    }
    if (this.craft.visible && this.craftEci) {
      const s = pr.project(...this.craftEci);
      if (s && (s[0] - x) ** 2 + (s[1] - y) ** 2 < Math.max(bestD, 144)) best = { cat: 'craft' };
    }
    return best;
  }
}
