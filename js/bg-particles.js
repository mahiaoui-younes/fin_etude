/**
 * EpitopX AI — 3D animated protein background
 * Floating 3D protein structures with perspective projection,
 * rotation on all axes, and depth-based rendering.
 */

(function () {
  'use strict';

  const canvas = document.createElement('canvas');
  canvas.id = 'protein-bg';
  canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:0;pointer-events:none;opacity:0.45;';
  document.body.prepend(canvas);

  const ctx = canvas.getContext('2d');
  let W, H;
  let objects = [];
  let animId;
  const FOV = 600; // perspective field-of-view

  const PALETTE = [
    [59, 130, 246],   // blue
    [13, 148, 136],   // teal
    [99, 102, 241],   // indigo
    [16, 185, 129],   // emerald
    [14, 116, 144],   // cyan
    [139, 92, 246],   // violet
  ];

  const AA = 'ACDEFGHIKLMNPQRSTVWY'.split('');

  function resize() {
    W = canvas.width = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }

  // ============ 3D Math ============

  function rotateX(p, a) {
    const c = Math.cos(a), s = Math.sin(a);
    return { x: p.x, y: p.y * c - p.z * s, z: p.y * s + p.z * c };
  }
  function rotateY(p, a) {
    const c = Math.cos(a), s = Math.sin(a);
    return { x: p.x * c + p.z * s, y: p.y, z: -p.x * s + p.z * c };
  }
  function rotateZ(p, a) {
    const c = Math.cos(a), s = Math.sin(a);
    return { x: p.x * c - p.y * s, y: p.x * s + p.y * c, z: p.z };
  }

  function rotate3D(pt, rx, ry, rz) {
    let p = rotateX(pt, rx);
    p = rotateY(p, ry);
    p = rotateZ(p, rz);
    return p;
  }

  function project(pt3d, cx, cy) {
    const scale = FOV / (FOV + pt3d.z);
    return {
      x: cx + pt3d.x * scale,
      y: cy + pt3d.y * scale,
      scale: scale,
      z: pt3d.z
    };
  }

  function rgba(color, alpha) {
    return `rgba(${color[0]},${color[1]},${color[2]},${alpha})`;
  }

  // ============ 3D Protein Shapes ============

  // --- 1. Alpha Helix (3D spiral ribbon) ---
  function buildHelix(size) {
    const points = [];
    const turns = 2.5;
    const steps = 40;
    const radius = size * 0.35;
    const height = size * 1.2;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const angle = t * Math.PI * 2 * turns;
      points.push({
        x: Math.cos(angle) * radius,
        y: (t - 0.5) * height,
        z: Math.sin(angle) * radius
      });
    }
    return points;
  }

  function drawHelix3D(obj) {
    const pts = obj.geometry.map(pt => {
      const r = rotate3D(pt, obj.rx, obj.ry, obj.rz);
      return project(r, obj.x, obj.y);
    });

    // Draw ribbon with depth-based thickness
    for (let i = 1; i < pts.length; i++) {
      const p0 = pts[i - 1];
      const p1 = pts[i];
      const depthAlpha = Math.max(0.08, Math.min(0.6, p1.scale * 0.5));
      const lw = Math.max(1, 6 * p1.scale);

      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.strokeStyle = rgba(obj.color, depthAlpha * obj.opacity);
      ctx.lineWidth = lw;
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    // Backbone dots at every 4th point
    for (let i = 0; i < pts.length; i += 4) {
      const p = pts[i];
      const r = Math.max(1.5, 4 * p.scale);
      const depthAlpha = Math.max(0.1, Math.min(0.7, p.scale * 0.6));
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = rgba(obj.color, depthAlpha * obj.opacity);
      ctx.fill();
    }
  }

  // --- 2. Beta Sheet (3D flat arrow ribbons) ---
  function buildBetaSheet(size) {
    const strands = [];
    const count = 3;
    const spacing = size * 0.4;
    for (let s = 0; s < count; s++) {
      const strand = [];
      const len = 8;
      for (let i = 0; i <= len; i++) {
        const t = i / len;
        strand.push({
          x: (t - 0.5) * size,
          y: (s - (count - 1) / 2) * spacing,
          z: Math.sin(t * Math.PI) * size * 0.15
        });
      }
      strands.push(strand);
    }
    return strands;
  }

  function drawBetaSheet3D(obj) {
    for (const strand of obj.geometry) {
      const pts = strand.map(pt => {
        const r = rotate3D(pt, obj.rx, obj.ry, obj.rz);
        return project(r, obj.x, obj.y);
      });

      // Ribbon
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i].x, pts[i].y);
      }
      const avgScale = pts.reduce((s, p) => s + p.scale, 0) / pts.length;
      const alpha = Math.max(0.08, Math.min(0.45, avgScale * 0.4));
      ctx.strokeStyle = rgba(obj.color, alpha * obj.opacity);
      ctx.lineWidth = Math.max(2, 10 * avgScale);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();

      // Arrow tip at end
      const last = pts[pts.length - 1];
      const prev = pts[pts.length - 2];
      const dx = last.x - prev.x;
      const dy = last.y - prev.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > 2) {
        const nx = dx / len, ny = dy / len;
        const arrowSize = Math.max(3, 8 * avgScale);
        ctx.beginPath();
        ctx.moveTo(last.x + nx * arrowSize, last.y + ny * arrowSize);
        ctx.lineTo(last.x - ny * arrowSize * 0.6, last.y + nx * arrowSize * 0.6);
        ctx.lineTo(last.x + ny * arrowSize * 0.6, last.y - nx * arrowSize * 0.6);
        ctx.closePath();
        ctx.fillStyle = rgba(obj.color, alpha * obj.opacity * 0.8);
        ctx.fill();
      }
    }
  }

  // --- 3. Ball-and-Stick Molecule (3D) ---
  function buildMolecule(size) {
    const atoms = [];
    const bonds = [];
    const n = Math.floor(rand(5, 9));
    const r = size * 0.4;

    // Generate atoms in 3D clustered shape
    for (let i = 0; i < n; i++) {
      const phi = Math.acos(2 * Math.random() - 1);
      const theta = Math.random() * Math.PI * 2;
      const dist = rand(0.3, 1) * r;
      atoms.push({
        x: Math.sin(phi) * Math.cos(theta) * dist,
        y: Math.sin(phi) * Math.sin(theta) * dist,
        z: Math.cos(phi) * dist,
        radius: rand(0.06, 0.12) * size,
        label: AA[Math.floor(Math.random() * AA.length)]
      });
    }

    // Connect nearby atoms
    for (let i = 0; i < atoms.length; i++) {
      for (let j = i + 1; j < atoms.length; j++) {
        const dx = atoms[i].x - atoms[j].x;
        const dy = atoms[i].y - atoms[j].y;
        const dz = atoms[i].z - atoms[j].z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist < r * 0.85) {
          bonds.push([i, j]);
        }
      }
    }

    return { atoms, bonds };
  }

  function drawMolecule3D(obj) {
    const { atoms, bonds } = obj.geometry;

    // Project all atoms
    const projected = atoms.map(a => {
      const r = rotate3D(a, obj.rx, obj.ry, obj.rz);
      return { ...project(r, obj.x, obj.y), radius: a.radius, label: a.label };
    });

    // Draw bonds (sorted by z, back to front)
    for (const [i, j] of bonds) {
      const a = projected[i], b = projected[j];
      const avgZ = (a.z + b.z) / 2;
      const avgScale = (a.scale + b.scale) / 2;
      const alpha = Math.max(0.05, Math.min(0.35, avgScale * 0.3));
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = rgba(obj.color, alpha * obj.opacity);
      ctx.lineWidth = Math.max(0.5, 2 * avgScale);
      ctx.stroke();
    }

    // Sort atoms back-to-front for proper occlusion
    const sorted = projected.slice().sort((a, b) => b.z - a.z);

    // Draw atoms
    for (const a of sorted) {
      const r = Math.max(2, a.radius * a.scale);
      const depthAlpha = Math.max(0.1, Math.min(0.65, a.scale * 0.55));

      // Sphere gradient
      const g = ctx.createRadialGradient(
        a.x - r * 0.3, a.y - r * 0.3, r * 0.1,
        a.x, a.y, r
      );
      g.addColorStop(0, rgba(obj.color, depthAlpha * obj.opacity * 1.2));
      g.addColorStop(0.7, rgba(obj.color, depthAlpha * obj.opacity * 0.6));
      g.addColorStop(1, rgba(obj.color, depthAlpha * obj.opacity * 0.1));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(a.x, a.y, r, 0, Math.PI * 2);
      ctx.fill();

      // Label on larger atoms
      if (r > 5) {
        ctx.fillStyle = rgba(obj.color, depthAlpha * obj.opacity * 0.9);
        ctx.font = `bold ${Math.max(7, Math.round(r * 0.8))}px "JetBrains Mono", monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(a.label, a.x, a.y);
      }
    }
  }

  // --- 4. Protein Globule (3D sphere cloud) ---
  function buildGlobule(size) {
    const points = [];
    const n = Math.floor(rand(25, 50));
    const r = size * 0.45;
    for (let i = 0; i < n; i++) {
      const phi = Math.acos(2 * Math.random() - 1);
      const theta = Math.random() * Math.PI * 2;
      const dist = rand(0.4, 1) * r;
      points.push({
        x: Math.sin(phi) * Math.cos(theta) * dist,
        y: Math.sin(phi) * Math.sin(theta) * dist,
        z: Math.cos(phi) * dist,
        r: rand(1.5, 4)
      });
    }
    return points;
  }

  function drawGlobule3D(obj) {
    const pts = obj.geometry.map(pt => {
      const r = rotate3D(pt, obj.rx, obj.ry, obj.rz);
      const p = project(r, obj.x, obj.y);
      return { ...p, baseR: pt.r };
    });

    // Sort back to front
    pts.sort((a, b) => b.z - a.z);

    // Outer glow
    const glowR = obj.size * 0.55;
    const gg = ctx.createRadialGradient(obj.x, obj.y, 0, obj.x, obj.y, glowR);
    gg.addColorStop(0, rgba(obj.color, 0.06 * obj.opacity));
    gg.addColorStop(1, rgba(obj.color, 0));
    ctx.fillStyle = gg;
    ctx.beginPath();
    ctx.arc(obj.x, obj.y, glowR, 0, Math.PI * 2);
    ctx.fill();

    for (const p of pts) {
      const r = Math.max(1, p.baseR * p.scale);
      const depthAlpha = Math.max(0.08, Math.min(0.5, p.scale * 0.45));

      const g = ctx.createRadialGradient(
        p.x - r * 0.2, p.y - r * 0.2, 0,
        p.x, p.y, r
      );
      g.addColorStop(0, rgba(obj.color, depthAlpha * obj.opacity));
      g.addColorStop(1, rgba(obj.color, depthAlpha * obj.opacity * 0.2));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // --- 5. DNA Double Helix (3D) ---
  function buildDNA(size) {
    const steps = 50;
    const turns = 2;
    const radius = size * 0.25;
    const height = size * 1.3;
    const strand1 = [], strand2 = [], rungs = [];

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const angle = t * Math.PI * 2 * turns;
      const y = (t - 0.5) * height;
      strand1.push({ x: Math.cos(angle) * radius, y, z: Math.sin(angle) * radius });
      strand2.push({ x: Math.cos(angle + Math.PI) * radius, y, z: Math.sin(angle + Math.PI) * radius });
      if (i % 5 === 0) {
        rungs.push([
          { x: Math.cos(angle) * radius, y, z: Math.sin(angle) * radius },
          { x: Math.cos(angle + Math.PI) * radius, y, z: Math.sin(angle + Math.PI) * radius }
        ]);
      }
    }
    return { strand1, strand2, rungs };
  }

  function drawDNA3D(obj) {
    const { strand1, strand2, rungs } = obj.geometry;

    const proj1 = strand1.map(pt => {
      const r = rotate3D(pt, obj.rx, obj.ry, obj.rz);
      return project(r, obj.x, obj.y);
    });
    const proj2 = strand2.map(pt => {
      const r = rotate3D(pt, obj.rx, obj.ry, obj.rz);
      return project(r, obj.x, obj.y);
    });

    // Draw rungs (base pairs)
    for (const [a, b] of rungs) {
      const pa = project(rotate3D(a, obj.rx, obj.ry, obj.rz), obj.x, obj.y);
      const pb = project(rotate3D(b, obj.rx, obj.ry, obj.rz), obj.x, obj.y);
      const avgScale = (pa.scale + pb.scale) / 2;
      const alpha = Math.max(0.04, Math.min(0.25, avgScale * 0.2));
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.strokeStyle = rgba(obj.color, alpha * obj.opacity);
      ctx.lineWidth = Math.max(0.5, 2 * avgScale);
      ctx.stroke();
    }

    // Draw strands
    [proj1, proj2].forEach((pts, si) => {
      for (let i = 1; i < pts.length; i++) {
        const p0 = pts[i - 1], p1 = pts[i];
        const depthAlpha = Math.max(0.06, Math.min(0.5, p1.scale * 0.4));
        const lw = Math.max(1, 4 * p1.scale);
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.strokeStyle = rgba(obj.color, depthAlpha * obj.opacity);
        ctx.lineWidth = lw;
        ctx.lineCap = 'round';
        ctx.stroke();
      }
    });
  }

  // --- 6. Floating amino acid sphere ---
  function drawAA3D(obj) {
    const pt = rotate3D({ x: 0, y: 0, z: 0 }, obj.rx, obj.ry, obj.rz);
    const p = project(pt, obj.x, obj.y);
    const r = Math.max(4, obj.size * 0.45 * p.scale);

    // Sphere with lighting
    const g = ctx.createRadialGradient(
      p.x - r * 0.35, p.y - r * 0.35, r * 0.05,
      p.x, p.y, r
    );
    g.addColorStop(0, rgba(obj.color, 0.25 * obj.opacity));
    g.addColorStop(0.5, rgba(obj.color, 0.12 * obj.opacity));
    g.addColorStop(1, rgba(obj.color, 0.02 * obj.opacity));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();

    // Ring
    ctx.strokeStyle = rgba(obj.color, 0.18 * obj.opacity);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 0.7, 0, Math.PI * 2);
    ctx.stroke();

    // Label
    ctx.fillStyle = rgba(obj.color, 0.45 * obj.opacity);
    ctx.font = `bold ${Math.max(9, Math.round(r * 0.55))}px "JetBrains Mono", monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(obj.label, p.x, p.y);
  }

  // ============ Object Factory ============

  function createObject() {
    const type = weightedRandom([
      ['helix', 3],
      ['beta', 2],
      ['molecule', 3],
      ['globule', 2],
      ['dna', 2],
      ['aa', 4],
    ]);

    const color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
    const size = type === 'aa' ? rand(18, 38) : rand(40, 90);

    const obj = {
      type,
      x: Math.random() * W,
      y: Math.random() * H,
      vx: rand(-0.18, 0.18),
      vy: rand(-0.14, 0.14),
      size,
      rx: Math.random() * Math.PI * 2,
      ry: Math.random() * Math.PI * 2,
      rz: Math.random() * Math.PI * 2,
      rxV: rand(-0.004, 0.004),
      ryV: rand(-0.005, 0.005),
      rzV: rand(-0.003, 0.003),
      opacity: rand(0.35, 0.85),
      color,
      label: AA[Math.floor(Math.random() * AA.length)],
      floatAmp: rand(0.08, 0.35),
      floatFreq: rand(0.002, 0.008),
      t: Math.random() * 1000,
    };

    // Build geometry once
    switch (type) {
      case 'helix':    obj.geometry = buildHelix(size); break;
      case 'beta':     obj.geometry = buildBetaSheet(size); break;
      case 'molecule': obj.geometry = buildMolecule(size); break;
      case 'globule':  obj.geometry = buildGlobule(size); break;
      case 'dna':      obj.geometry = buildDNA(size); break;
    }

    return obj;
  }

  function spawnObjects() {
    const area = W * H;
    const count = Math.max(8, Math.min(25, Math.floor(area / 65000)));
    objects = [];
    for (let i = 0; i < count; i++) {
      objects.push(createObject());
    }
  }

  // ============ Update & Draw ============

  function update() {
    for (const o of objects) {
      o.t++;
      o.x += o.vx + Math.sin(o.t * o.floatFreq) * o.floatAmp;
      o.y += o.vy + Math.cos(o.t * o.floatFreq * 0.7) * o.floatAmp * 0.5;

      // Continuous 3D rotation
      o.rx += o.rxV;
      o.ry += o.ryV;
      o.rz += o.rzV;

      // Wrap edges
      const m = o.size + 20;
      if (o.x < -m) o.x = W + m;
      if (o.x > W + m) o.x = -m;
      if (o.y < -m) o.y = H + m;
      if (o.y > H + m) o.y = -m;
    }
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    for (const o of objects) {
      ctx.save();
      switch (o.type) {
        case 'helix':    drawHelix3D(o); break;
        case 'beta':     drawBetaSheet3D(o); break;
        case 'molecule': drawMolecule3D(o); break;
        case 'globule':  drawGlobule3D(o); break;
        case 'dna':      drawDNA3D(o); break;
        case 'aa':       drawAA3D(o); break;
      }
      ctx.restore();
    }
  }

  function loop() {
    update();
    draw();
    animId = requestAnimationFrame(loop);
  }

  // ============ Helpers ============

  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  function weightedRandom(items) {
    const total = items.reduce((s, [, w]) => s + w, 0);
    let r = Math.random() * total;
    for (const [val, w] of items) {
      r -= w;
      if (r <= 0) return val;
    }
    return items[0][0];
  }

  // ============ Init ============

  function init() {
    resize();
    spawnObjects();
    loop();
  }

  window.addEventListener('resize', () => {
    resize();
    const target = Math.max(8, Math.min(25, Math.floor((W * H) / 65000)));
    while (objects.length < target) objects.push(createObject());
    while (objects.length > target) objects.pop();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
