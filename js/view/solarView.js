// Heliocentric solar-system view (ecliptic frame, north up). Distances are to
// scale (1 AU = 100 units); planet sizes are exaggerated so they are visible.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { AU } from '../core/constants.js';
import { PLANETS, eciToEcliptic, planetOrbitPath, planetPositionHelio } from '../core/ephemeris.js';
import { glowTexture } from './textures.js';

const S = 100 / AU;
const SIZE = { Mercury: 0.9, Venus: 1.5, Earth: 1.6, Mars: 1.2, Jupiter: 4.2, Saturn: 3.6, Uranus: 2.6, Neptune: 2.5 };

export class SolarView {
  constructor(renderer) {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1e6);
    this.camera.position.set(0, 330, 360);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.minDistance = 8;
    this.controls.maxDistance = 25000;
    this.controls.enabled = false;

    this.ecl = new THREE.Group();
    this.ecl.rotation.x = -Math.PI / 2;
    this.scene.add(this.ecl);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.35));
    const light = new THREE.PointLight(0xffffff, 2.2, 0, 0);
    this.scene.add(light);

    const sun = new THREE.Mesh(new THREE.SphereGeometry(5, 48, 32), new THREE.MeshBasicMaterial({ color: 0xffd97a }));
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(glowTexture('rgba(255,220,140,0.9)', 'rgba(255,160,60,0)', 256, 0.05)), blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.scale.setScalar(42);
    this.scene.add(sun, glow);

    // Stars (shared look with the Earth view).
    const n = 3000, pos = new Float32Array(n * 3);
    let seed = 11;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) {
      const u = rand() * 2 - 1, th = rand() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      pos.set([4e5 * s * Math.cos(th), 4e5 * u, 4e5 * s * Math.sin(th)], i * 3);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.scene.add(new THREE.Points(sg, new THREE.PointsMaterial({ size: 1.4, sizeAttenuation: false, color: 0xcfd8ff })));

    this.planets = PLANETS.map((p) => {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(SIZE[p.name], 32, 24), new THREE.MeshLambertMaterial({ color: p.color }));
      if (p.name === 'Saturn') {
        const ring = new THREE.Mesh(new THREE.RingGeometry(SIZE.Saturn * 1.4, SIZE.Saturn * 2.3, 64), new THREE.MeshBasicMaterial({ color: 0xcbb98a, side: THREE.DoubleSide, transparent: true, opacity: 0.6 }));
        ring.rotation.x = 0.47;
        mesh.add(ring);
      }
      this.ecl.add(mesh);
      const line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: p.color, transparent: true, opacity: 0.35 }));
      this.ecl.add(line);
      return { planet: p, mesh, line };
    });
    this.orbitStamp = null;

    const craftGeom = new THREE.BufferGeometry();
    craftGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    this.craft = new THREE.Points(craftGeom, new THREE.PointsMaterial({ size: 16, sizeAttenuation: false, map: new THREE.CanvasTexture(glowTexture('rgba(255,236,150,1)', 'rgba(255,190,60,0)', 64, 0.25)), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.craft.frustumCulled = false;
    this.ecl.add(this.craft);
  }

  update(ms, mission) {
    if (this.orbitStamp == null || Math.abs(ms - this.orbitStamp) > 30 * 86400e3) {
      for (const it of this.planets) {
        const pts = planetOrbitPath(it.planet, ms, 360).map((p) => new THREE.Vector3(p[0] * S, p[1] * S, p[2] * S));
        it.line.geometry.dispose();
        it.line.geometry = new THREE.BufferGeometry().setFromPoints(pts);
      }
      this.orbitStamp = ms;
    }
    for (const it of this.planets) {
      const p = planetPositionHelio(it.planet, ms);
      it.mesh.position.set(p[0] * S, p[1] * S, p[2] * S);
      it.helio = p;
    }
    const earth = this.planets.find((p) => p.planet.name === 'Earth').helio;
    this.craft.visible = !!mission;
    if (mission) {
      const g = eciToEcliptic(mission.positionEci());
      const a = this.craft.geometry.attributes.position;
      a.array.set([(earth[0] + g[0]) * S, (earth[1] + g[1]) * S, (earth[2] + g[2]) * S]);
      a.needsUpdate = true;
    }
  }

  // Label anchors in world space.
  labels() {
    const out = [{ key: 'sun', text: 'Sun', world: new THREE.Vector3(0, 7, 0), cls: 'body' }];
    for (const it of this.planets) {
      const w = it.mesh.getWorldPosition(new THREE.Vector3());
      w.y += SIZE[it.planet.name] + 1.5;
      out.push({ key: it.planet.name, text: it.planet.name, world: w, cls: 'body' });
    }
    return out;
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
