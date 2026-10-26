// motion.js — pure functions of time for deterministic motion design.
// Load in a page with <script src="/lib/motion.js"></script> (render.mjs serves /lib/ from the scripts folder),
// or copy next to your page. Everything lives on globalThis.Motion; nothing reads a clock.
(function (G) {
  'use strict';
  const TAU = Math.PI * 2;
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, k) => a + (b - a) * k;
  const invLerp = (a, b, x) => (b === a ? 0 : (x - a) / (b - a));
  /** 0..1 progress of t through [a, b] */
  const seg = (t, a, b) => clamp(invLerp(a, b, t));
  const mapRange = (x, a, b, c, d, ease = (k) => k) => lerp(c, d, ease(seg(x, a, b)));

  // ---------- seeded randomness ----------
  /** mulberry32: returns a function giving floats in [0,1) */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  /** stable value in [0,1) for (i, seed) — use for per-element constants */
  function hash(i, seed = 0) {
    let h = (Math.imul((i | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(seed | 0, 0xc2b2ae35)) >>> 0;
    h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); h ^= h >>> 15; h = Math.imul(h, 0x846ca68b); h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  const hashStr = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
  const randRange = (i, a, b, seed = 0) => lerp(a, b, hash(i, seed));
  /** smooth 1-D value noise in [-1, 1], deterministic */
  function noise(x, seed = 0) {
    const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
    return lerp(hash(i, seed) * 2 - 1, hash(i + 1, seed) * 2 - 1, u);
  }
  /** deterministic camera shake [dx, dy] that decays after t0 */
  function shake(t, t0, amp = 12, dur = 0.35, freq = 28, seed = 7) {
    if (t < t0 || t > t0 + dur) return [0, 0];
    const k = 1 - (t - t0) / dur, e = k * k;
    return [noise((t - t0) * freq, seed) * amp * e, noise((t - t0) * freq, seed + 101) * amp * e];
  }

  // ---------- easing ----------
  const E = {
    linear: (k) => k,
    inQuad: (k) => k * k, outQuad: (k) => 1 - (1 - k) * (1 - k), inOutQuad: (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2),
    inCubic: (k) => k * k * k, outCubic: (k) => 1 - Math.pow(1 - k, 3), inOutCubic: (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2),
    outQuart: (k) => 1 - Math.pow(1 - k, 4), outQuint: (k) => 1 - Math.pow(1 - k, 5),
    inOutSine: (k) => -(Math.cos(Math.PI * k) - 1) / 2, outSine: (k) => Math.sin((k * Math.PI) / 2),
    outExpo: (k) => (k >= 1 ? 1 : 1 - Math.pow(2, -10 * k)), inOutExpo: (k) => (k <= 0 ? 0 : k >= 1 ? 1 : k < 0.5 ? Math.pow(2, 20 * k - 10) / 2 : (2 - Math.pow(2, -20 * k + 10)) / 2),
    outBack: (k, s = 1.70158) => 1 + (s + 1) * Math.pow(k - 1, 3) + s * Math.pow(k - 1, 2),
    inBack: (k, s = 1.70158) => (s + 1) * k * k * k - s * k * k,
    inOutBack: (k, s = 1.70158 * 1.525) => (k < 0.5 ? (Math.pow(2 * k, 2) * ((s + 1) * 2 * k - s)) / 2 : (Math.pow(2 * k - 2, 2) * ((s + 1) * (k * 2 - 2) + s) + 2) / 2),
    outElastic: (k) => (k <= 0 ? 0 : k >= 1 ? 1 : Math.pow(2, -10 * k) * Math.sin((k * 10 - 0.75) * (TAU / 3)) + 1),
    outBounce: (k) => { const n = 7.5625, d = 2.75; if (k < 1 / d) return n * k * k; if (k < 2 / d) return n * (k -= 1.5 / d) * k + 0.75; if (k < 2.5 / d) return n * (k -= 2.25 / d) * k + 0.9375; return n * (k -= 2.625 / d) * k + 0.984375; },
  };
  /** CSS-identical cubic-bezier(x1,y1,x2,y2) as an easing function */
  function bezier(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx, cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const sx = (u) => ((ax * u + bx) * u + cx) * u, sy = (u) => ((ay * u + by) * u + cy) * u, dx = (u) => (3 * ax * u + 2 * bx) * u + cx;
    return (x) => {
      if (x <= 0) return 0; if (x >= 1) return 1;
      let u = x; for (let i = 0; i < 8; i++) { const e = sx(u) - x, d = dx(u); if (Math.abs(e) < 1e-6) break; if (Math.abs(d) < 1e-6) break; u -= e / d; }
      let lo = 0, hi = 1; if (Math.abs(sx(u) - x) > 1e-5) { u = x; for (let i = 0; i < 30; i++) { const v = sx(u); if (Math.abs(v - x) < 1e-6) break; if (v < x) lo = u; else hi = u; u = (lo + hi) / 2; } }
      return sy(u);
    };
  }
  /** brand → motion presets (references/product-promo.md) */
  const PRESETS = {
    trust:   { frames: 21, ease: bezier(0, 0, 0.2, 1), overshoot: 1.0, squash: 0 },
    premium: { frames: 48, ease: bezier(0.4, 0, 0.6, 1), overshoot: 1.02, squash: 0 },
    bold:    { frames: 18, ease: bezier(0.16, 1, 0.3, 1), overshoot: 1.12, squash: 0.25 },
    playful: { frames: 27, ease: bezier(0.34, 1.56, 0.64, 1), overshoot: 1.08, squash: 0.18 },
    calm:    { frames: 42, ease: E.inOutSine, overshoot: 1.0, squash: 0.04 },
    friendly:{ frames: 26, ease: bezier(0.25, 0.46, 0.45, 0.94), overshoot: 1.04, squash: 0.08 },
  };

  // ---------- keyframes & acting ----------
  /** keyframes: kf(t, [[t0, v0], [t1, v1, ease?], ...], defaultEase). Values may be numbers or arrays. */
  function kf(t, keys, ease = E.inOutCubic) {
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      const [ta, va] = keys[i - 1], [tb, vb, e] = keys[i];
      if (t <= tb) { const k = (e || ease)(seg(t, ta, tb)); return Array.isArray(va) ? va.map((x, j) => lerp(x, vb[j], k)) : lerp(va, vb, k); }
    }
    return keys[keys.length - 1][1];
  }
  /** pop-in scale: 0 → peak → 1 over dur seconds starting at t0 (hanazi default: peak 1.15, 8 frames) */
  function pop(t, t0, dur = 8 / 30, peak = 1.15) {
    if (t < t0) return 0;
    const k = (t - t0) / dur;
    if (k >= 1) return 1;
    const a = 0.6; // reach peak at 60% of dur
    return k < a ? peak * E.outCubic(k / a) : lerp(peak, 1, E.inOutSine((k - a) / (1 - a)));
  }
  /** damped spring kick after t0: returns displacement in [-1,1]·amp, settles to 0 */
  function spring(t, t0, amp = 1, freq = 3.2, damp = 5.5) {
    if (t < t0) return 0; const x = t - t0; return amp * Math.exp(-damp * x) * Math.sin(TAU * freq * x);
  }
  /** sum of spring kicks for several event times */
  const ring = (t, times, amp = 1, freq, damp) => times.reduce((s, t0) => s + spring(t, t0, amp, freq, damp), 0);
  /** squash on landing: returns [sx, sy] volume-preserving, peak at t0 */
  function squash(t, t0, amt = 0.2, dur = 0.25) {
    const k = seg(t, t0, t0 + dur); if (t < t0 || k >= 1) return [1, 1];
    const s = amt * Math.sin(Math.PI * k) * (1 - k); const sy = 1 - s; return [1 / Math.sqrt(sy), sy];
  }
  /** anticipation → action: value goes slightly negative (wind-up) before reaching 1 */
  function anticipate(k, wind = 0.12, split = 0.3) {
    k = clamp(k); if (k < split) return -wind * Math.sin((Math.PI * k) / split);
    return E.outBack((k - split) / (1 - split), 1.2);
  }
  /** point on a thrown arc from p0 to p1 with peak height h (y up is negative screen y) */
  const arcPt = (p0, p1, h, k) => [lerp(p0[0], p1[0], k), lerp(p0[1], p1[1], k) - 4 * h * k * (1 - k)];
  /** gentle idle wobble */
  const wob = (t, freq = 0.5, phase = 0) => Math.sin(TAU * (t * freq + phase));

  // ---------- velocity-shaped moves (no jumps in speed or acceleration) ----------
  // speed ∝ u^a (1-u)^b; b > a gives inertia (fast start, long settle). Position = normalised integral.
  const _vcache = {};
  function velEase(a = 2, b = 3) {
    const key = a + ',' + b; if (_vcache[key]) return _vcache[key];
    const N = 512, tab = new Float64Array(N + 1); let s = 0;
    for (let i = 1; i <= N; i++) { const u0 = (i - 1) / N, u1 = i / N, um = (u0 + u1) / 2; s += Math.pow(um, a) * Math.pow(1 - um, b); tab[i] = s; }
    for (let i = 0; i <= N; i++) tab[i] /= s;
    return (_vcache[key] = (k) => { k = clamp(k); const x = k * N, i = Math.floor(x); return i >= N ? 1 : lerp(tab[i], tab[i + 1], x - i); });
  }

  // ---------- timing helpers ----------
  /** start times for n items that get faster and faster ("deal the cards"); first gap is largest */
  function accelTimes(n, total, power = 1.8) {
    const out = []; for (let i = 0; i < n; i++) out.push(total * Math.pow(i / Math.max(1, n - 1), 1 / power));
    return out;
  }
  /** uniform stagger with seeded jitter (avoid twinning) */
  const stagger = (i, step, jitter = 0, seed = 1) => i * step + (hash(i, seed) - 0.5) * 2 * jitter;
  /** hold the drawing for `step` frames at `fps` (on twos = 2 at 24 fps). Use for elements, not the camera. */
  const onTwos = (t, fps = 24, step = 2) => Math.floor((t * fps) / step) * step / fps;
  /** minimum on-screen time for text (references/timing.md) */
  function readTime(text) {
    const cjk = (text.match(/[　-鿿＀-￯]/g) || []).length;
    const other = text.replace(/[　-鿿＀-￯\s]/g, '').length;
    return Math.max(1.8, cjk / 4.5 + other / 15 + 1.5);
  }

  // ---------- beat grid ----------
  /** grid(bpm, beat0, offset): beatT(n) → seconds; beatOf(t); pulse(t, decay) = 1 on each beat then decays */
  function grid(bpm, beat0 = 0, offset = 0) {
    const T = 60 / bpm;
    const beatT = (n) => beat0 + offset + n * T;
    const beatOf = (t) => (t - beat0 - offset) / T;
    const pulse = (t, decay = 6, div = 1) => { const b = beatOf(t) * div; if (b < 0) return 0; return Math.exp(-decay * (b - Math.floor(b)) * T / div); };
    return { T, bpm, beatT, beatOf, pulse, beatN: (t) => Math.floor(beatOf(t)) };
  }

  // ---------- 2-D camera (one world→screen function for everything that follows a subject) ----------
  /** camera(cx, cy, zoom, rot, W, H): world point (cx, cy) lands at the screen centre */
  function camera(cx, cy, zoom = 1, rot = 0, W = 1920, H = 1080) {
    const c = Math.cos(rot), s = Math.sin(rot);
    return {
      toScreen: (x, y) => { const dx = (x - cx) * zoom, dy = (y - cy) * zoom; return [W / 2 + dx * c - dy * s, H / 2 + dx * s + dy * c]; },
      apply: (ctx) => { ctx.translate(W / 2, H / 2); ctx.rotate(rot); ctx.scale(zoom, zoom); ctx.translate(-cx, -cy); },
      css: () => `translate(${W / 2}px,${H / 2}px) rotate(${rot}rad) scale(${zoom}) translate(${-cx}px,${-cy}px)`,
    };
  }

  /** shot table helper: shots([[t0, fn], [t1, fn2], ...], duration) → render(t) calling fn(t, localT, shotDur) */
  function shots(list, duration) {
    return (t) => {
      let i = list.length - 1; while (i > 0 && t < list[i][0]) i--;
      const t0 = list[i][0], t1 = i + 1 < list.length ? list[i + 1][0] : duration;
      return list[i][1](t, t - t0, t1 - t0);
    };
  }

  G.Motion = { TAU, clamp, lerp, invLerp, seg, mapRange, mulberry32, hash, hashStr, randRange, noise, shake,
    E, ease: E, bezier, PRESETS, kf, pop, spring, ring, squash, anticipate, arcPt, wob, velEase,
    accelTimes, stagger, onTwos, readTime, grid, camera, shots };
})(typeof globalThis !== 'undefined' ? globalThis : window);
