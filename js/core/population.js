// A set of catalogue objects whose positions are refreshed together into one
// typed array (shared directly with the GPU buffer for drawing).

export class Population {
  constructor(cat, objects) {
    this.cat = cat;
    this.objects = objects;
    this.positions = new Float32Array(objects.length * 3);
    objects.forEach((o, i) => {
      o.index = i;
      o.getPosition = () => [this.positions[i * 3], this.positions[i * 3 + 1], this.positions[i * 3 + 2]];
    });
  }

  update(ms) {
    const P = this.positions;
    const objs = this.objects;
    for (let i = 0; i < objs.length; i++) objs[i].orbit.positionAt(ms, P, i * 3);
  }
}

// The k nearest objects to point p across several populations.
export function nearestObjects(p, populations, k = 8) {
  const best = [];
  let worst = Infinity;
  for (const pop of populations) {
    const P = pop.positions;
    for (let i = 0, n = pop.objects.length; i < n; i++) {
      const dx = P[i * 3] - p[0], dy = P[i * 3 + 1] - p[1], dz = P[i * 3 + 2] - p[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (best.length < k || d2 < worst) {
        best.push({ d2, obj: pop.objects[i] });
        best.sort((a, b) => a.d2 - b.d2);
        if (best.length > k) best.pop();
        worst = best[best.length - 1].d2;
      }
    }
  }
  return best.map(({ d2, obj }) => ({ obj, distance: Math.sqrt(d2), pos: obj.getPosition() }));
}
