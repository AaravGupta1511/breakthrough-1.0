// HTML labels that follow 3D positions.

import * as THREE from 'three';

export class LabelLayer {
  constructor(container) {
    this.root = document.createElement('div');
    this.root.className = 'label-layer';
    container.appendChild(this.root);
    this.nodes = new Map();
    this.v = new THREE.Vector3();
  }

  // items: [{ key, text, world: Vector3, cls, hidden }]; occluded(world) -> bool
  update(camera, items, width, height, occluded = () => false) {
    const seen = new Set();
    for (const it of items) {
      seen.add(it.key);
      let node = this.nodes.get(it.key);
      if (!node) {
        node = document.createElement('div');
        this.root.appendChild(node);
        this.nodes.set(it.key, node);
      }
      const cls = `label ${it.cls || ''}`;
      if (node.className !== cls) node.className = cls;
      if (node.textContent !== it.text) node.textContent = it.text;
      this.v.copy(it.world).project(camera);
      const visible = !it.hidden && this.v.z < 1 && Math.abs(this.v.x) < 1.1 && Math.abs(this.v.y) < 1.1 && !occluded(it.world);
      node.style.display = visible ? '' : 'none';
      if (visible) {
        const x = ((this.v.x + 1) / 2) * width, y = ((1 - this.v.y) / 2) * height;
        node.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      }
    }
    for (const [key, node] of this.nodes) {
      if (!seen.has(key)) { node.remove(); this.nodes.delete(key); }
    }
  }

  clear() {
    for (const node of this.nodes.values()) node.remove();
    this.nodes.clear();
  }
}
