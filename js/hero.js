// Landing-page backdrop: a lightweight 2D animation of Earth, orbits,
// satellites, debris and a rocket climbing to orbit. Plain script (no modules).
(function () {
  var canvas = document.getElementById('hero-canvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var W, H, dpr, cx, cy, R, stars = [];

  var seed = 42;
  function rand() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }

  var VIEW_TILT = 0.32; // radians the camera looks down on the equatorial plane
  var orbits = [
    { a: 1.12, i: 0.9, node: 0.4, color: '#4de1ff', n: 1, speed: 0.55 },     // station
    { a: 1.18, i: 0.93, node: 2.1, color: '#8fb4ff', n: 14, speed: 0.5 },    // constellation shell
    { a: 1.18, i: 0.93, node: 3.3, color: '#8fb4ff', n: 14, speed: 0.5 },
    { a: 1.26, i: 1.7, node: 1.2, color: '#6be39b', n: 3, speed: 0.42 },     // sun-synchronous
    { a: 2.3, i: 0.96, node: 0.9, color: '#ffc94d', n: 5, speed: 0.16 },     // navigation
    { a: 2.3, i: 0.96, node: 3.0, color: '#ffc94d', n: 5, speed: 0.16 },
    { a: 3.2, i: 0.0, node: 0, color: '#c595ff', n: 9, speed: 0.08 },        // geostationary ring
  ];
  var debris = [];
  for (var k = 0; k < 420; k++) {
    debris.push({ a: 1.08 + Math.pow(rand(), 1.6) * 0.35, i: rand() * 1.9, node: rand() * 6.28, ph: rand() * 6.28, speed: 0.4 + rand() * 0.25 });
  }

  // Orbit point -> screen [x, y, depth]; depth > 0 is towards the viewer.
  function project(a, inc, node, theta) {
    var x = a * Math.cos(theta), y = a * Math.sin(theta), z = 0;
    var y1 = y * Math.cos(inc), z1 = y * Math.sin(inc);
    var x2 = x * Math.cos(node) - y1 * Math.sin(node), y2 = x * Math.sin(node) + y1 * Math.cos(node);
    // Camera looks along -y2 from slightly above: screen x = x2, screen up = z1 tilted.
    var sy = z1 * Math.cos(VIEW_TILT) - y2 * Math.sin(VIEW_TILT);
    var depth = -(y2 * Math.cos(VIEW_TILT) + z1 * Math.sin(VIEW_TILT));
    return [cx + x2 * R, cy - sy * R, depth];
  }
  function hidden(p) {
    var dx = (p[0] - cx) / R, dy = (p[1] - cy) / R;
    return p[2] < 0 && dx * dx + dy * dy < 1;
  }

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var narrow = W < 760;
    cx = narrow ? W * 0.55 : W * 0.72;
    cy = narrow ? H * 0.62 : H * 0.52;
    R = Math.min(W, H) * (narrow ? 0.2 : 0.17);
    stars = [];
    for (var s = 0; s < 260; s++) stars.push([rand() * W, rand() * H, rand() * 1.2 + 0.2, rand()]);
  }

  function drawEarth() {
    var g = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.1, cx, cy, R);
    g.addColorStop(0, '#3f8fd8'); g.addColorStop(0.55, '#1a4f8f'); g.addColorStop(1, '#06162e');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
    var atm = ctx.createRadialGradient(cx, cy, R * 0.96, cx, cy, R * 1.18);
    atm.addColorStop(0, 'rgba(90,169,255,0.55)'); atm.addColorStop(1, 'rgba(90,169,255,0)');
    ctx.fillStyle = atm;
    ctx.beginPath(); ctx.arc(cx, cy, R * 1.18, 0, Math.PI * 2); ctx.fill();
  }

  function drawOrbitPath(o, front) {
    ctx.strokeStyle = o.color;
    ctx.globalAlpha = front ? 0.28 : 0.1;
    ctx.lineWidth = 1;
    ctx.beginPath();
    var started = false;
    for (var s = 0; s <= 160; s++) {
      var p = project(o.a, o.i, o.node, (s / 160) * Math.PI * 2);
      var isFront = p[2] >= 0;
      if (isFront !== front || hidden(p)) { started = false; continue; }
      if (!started) { ctx.moveTo(p[0], p[1]); started = true; } else ctx.lineTo(p[0], p[1]);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function dot(p, r, color, alpha) {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
  }

  function frame(tms) {
    var t = tms / 1000;
    ctx.clearRect(0, 0, W, H);
    for (var s = 0; s < stars.length; s++) {
      var st = stars[s];
      dot(st, st[2], '#dfe6ff', 0.35 + 0.35 * Math.sin(t * 0.8 + st[3] * 20) * (reduce ? 0 : 1));
    }
    // Back halves, Earth, then front halves so orbits wrap around the planet.
    var items = [];
    orbits.forEach(function (o) {
      drawOrbitPath(o, false);
      for (var n = 0; n < o.n; n++) items.push({ p: project(o.a, o.i, o.node, t * o.speed + (n / o.n) * Math.PI * 2), r: o.n > 10 ? 1.6 : 2.6, c: o.color });
    });
    debris.forEach(function (d) { items.push({ p: project(d.a, d.i, d.node, d.ph + t * d.speed), r: 1.1, c: '#ff6a4d' }); });
    items.forEach(function (it) { if (it.p[2] < 0 && !hidden(it.p)) dot(it.p, it.r, it.c, 0.5); });
    drawEarth();
    orbits.forEach(function (o) { drawOrbitPath(o, true); });
    items.forEach(function (it) { if (it.p[2] >= 0) dot(it.p, it.r, it.c, 0.95); });
    drawRocket(t);
    if (!reduce) requestAnimationFrame(frame);
  }

  // A rocket climbing from the limb into a circular orbit, every 9 seconds.
  function drawRocket(t) {
    var cycle = 9, u = (t % cycle) / cycle;
    var start = -2.2;
    var trail = [];
    for (var s = 0; s <= 60; s++) {
      var v = (s / 60) * u;
      var climb = Math.min(1, v / 0.45);
      var r = 1 + 0.32 * (1 - Math.pow(1 - climb, 3));
      var ang = start + (v < 0.45 ? 0.9 * v * v / 0.45 : 0.45 * 0.9 + (v - 0.45) * 3.2);
      trail.push([cx + Math.cos(ang) * r * R, cy + Math.sin(ang) * r * R]);
    }
    var fade = u > 0.8 ? (1 - u) / 0.2 : 1;
    ctx.strokeStyle = '#ffd24d';
    ctx.lineWidth = 1.6;
    ctx.globalAlpha = 0.8 * fade;
    ctx.beginPath();
    trail.forEach(function (p, i) { if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); });
    ctx.stroke();
    var head = trail[trail.length - 1];
    var glow = ctx.createRadialGradient(head[0], head[1], 0, head[0], head[1], 10);
    glow.addColorStop(0, 'rgba(255,236,150,1)'); glow.addColorStop(1, 'rgba(255,190,60,0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(head[0], head[1], 10, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
  }

  resize();
  window.addEventListener('resize', resize);
  requestAnimationFrame(frame);
})();
