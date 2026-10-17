/* Pixel creature generator. A fighter's `design` decides the shape and colors;
 * its id seeds the small details, so the same fighter always looks the same. */
(function (root) {
  "use strict";
  const N = 28, H = N / 2;

  function hash(str) {
    let h = 2166136261;
    for (const ch of String(str)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function rng(seed) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Cell codes: 1 body, 2 spike/horn, 3 eye white, 4 pupil/mouth, 5 accent pattern, 6 armor plate
  function grid(design, key) {
    const d = Object.assign({ hue: 200, accent: 40, body: "round", size: 0.6, spikes: 1, armor: false, eyes: "round", pattern: "plain" }, design || {});
    const r = rng(hash(key || "x"));
    const g = Array.from({ length: N }, () => Array(N).fill(0));
    const set = (y, x, v) => { if (y >= 0 && y < N && x >= 0 && x < H) { g[y][x] = v; g[y][N - 1 - x] = v; } };
    const get = (y, x) => (y >= 0 && y < N && x >= 0 && x < N ? g[y][x] : 0);
    const s = 0.75 + Math.max(0, Math.min(1, d.size)) * 0.5;
    const shape = { round: [8, 8], tall: [6.5, 10.5], wide: [10.5, 7] }[d.body] || [8, 8];
    const rx = shape[0] * s, ry = shape[1] * s;
    const cy = N - 4 - ry;
    for (let y = 0; y < N - 2; y++) {
      for (let x = 0; x < H; x++) {
        const dx = (H - 0.5 - x) / rx, dy = (y - cy) / ry, dist = dx * dx + dy * dy;
        if (dist < 0.62 || (dist < 1 && r() < 0.6)) set(y, x, 1);
      }
    }
    // legs or feet
    const legX = Math.max(1, Math.round(H - rx * 0.55));
    const bottom = g.reduce((b, row, y) => (row.some((v) => v) ? y : b), 0);
    for (let y = bottom; y < N - 1; y++) { set(y, legX, 1); set(y, legX - 1, 1); }
    // arms
    if (d.body !== "round") {
      const ay = Math.round(cy + ry * 0.1);
      let ax = 0;
      while (ax < H && !get(ay, ax)) ax++;
      for (let i = 1; i <= 2; i++) set(ay + i - 1, ax - i, 1);
    }
    // pattern on the belly
    const belly = (y, x) => get(y, x) === 1 && Math.abs(H - 0.5 - x) < rx * 0.75 && y > cy - ry * 0.2;
    for (let y = 0; y < N; y++) for (let x = 0; x < H; x++) {
      if (!belly(y, x)) continue;
      if (d.pattern === "stripes" && y % 3 === 0) set(y, x, 5);
      if (d.pattern === "spots" && (x * 7 + y * 3) % 9 === 0) set(y, x, 5);
    }
    if (d.armor) for (let y = Math.round(cy - 1); y < bottom; y += 4) for (let x = 0; x < H; x++) if (get(y, x) === 1) set(y, x, 6);
    // spikes along the top
    const spikes = Math.max(0, Math.min(3, d.spikes | 0));
    for (let i = 0; i < spikes; i++) {
      const x = H - 1 - Math.round((i + 0.5) * (rx * 0.75 / Math.max(1, spikes)));
      let top = 0;
      while (top < N && !get(top, x)) top++;
      const len = 2 + (i === 0 ? 1 : 0);
      for (let k = 1; k <= len && top - k >= 0; k++) set(top - k, x, 2);
    }
    // face
    const ey = Math.round(cy - ry * 0.32), ex = Math.round(H - 1 - rx * 0.38);
    return { g, d, ey, ex, cy, ry };
  }

  function face(g, d, ey, ex, back) {
    const setBoth = (y, x, v) => { if (y >= 0 && y < N && x >= 0 && x < H) { g[y][x] = v; g[y][N - 1 - x] = v; } };
    if (back) return;
    if (d.eyes === "visor") {
      for (let x = ex - 1; x < H; x++) { setBoth(ey, x, 4); setBoth(ey - 1, x, 3); }
    } else {
      setBoth(ey - 1, ex, 3); setBoth(ey - 1, ex - 1, 3); setBoth(ey, ex - 1, 3); setBoth(ey, ex, 4);
      if (d.eyes === "angry") { setBoth(ey - 2, ex - 1, 4); setBoth(ey - 2, ex + 1, 4); }  // brows
    }
    const my = ey + 3;
    if (d.eyes === "angry") for (let x = H - 2; x < H; x++) setBoth(my, x, 4);
    else setBoth(my, H - 1, 4);
  }

  function draw(canvas, who, opts = {}) {
    const design = who.design || {};
    const { g, d, ey, ex, cy, ry } = grid(design, who.id || who.name);
    face(g, d, ey, ex, opts.back);
    const hue = ((d.hue % 360) + 360) % 360, acc = ((d.accent % 360) + 360) % 360;
    const col = {
      body: `hsl(${hue} 60% 56%)`, shade: `hsl(${hue} 55% 41%)`, light: `hsl(${hue} 75% 72%)`,
      line: `hsl(${hue} 45% 14%)`, spike: `hsl(${acc} 30% 90%)`, accent: `hsl(${acc} 70% 58%)`,
      plate: `hsl(${hue} 14% 76%)`, eye: "#ffffff", pupil: "#151515",
    };
    canvas.width = N; canvas.height = N;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, N, N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const v = g[y][x];
        let c = null;
        if (v === 0) {
          if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dy, dx]) => g[y + dy] && g[y + dy][x + dx] > 0)) c = col.line;
        } else if (v === 1) {
          c = y > cy + ry * 0.45 ? col.shade : y < cy - ry * 0.55 ? col.light : col.body;
          if (opts.back && y < cy) c = col.shade;
        } else c = { 2: col.spike, 3: col.eye, 4: col.pupil, 5: col.accent, 6: col.plate }[v];
        if (c) { ctx.fillStyle = c; ctx.fillRect(x, y, 1, 1); }
      }
    }
    return canvas;
  }

  root.FighterSprites = { draw, size: N };
})(typeof self !== "undefined" ? self : this);
