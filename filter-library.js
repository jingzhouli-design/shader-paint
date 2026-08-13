// ─── Universal post-process filter stack (manager-level, works across every project) ──
// Each filter definition renders one or more full-screen GLSL passes on top of a live
// CanvasTexture sourced from the active project's own <canvas> (WebGL or Canvas2D).
import * as THREE from "three";

const VERTEX_SHADER = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
  }
`;

export function fragmentShaderForPass(pass) {
  if (!pass.matchAspect) return pass.fragmentShader || PASSTHROUGH_FRAGMENT;
  const source = (pass.fragmentShader || "")
    .replace(/varying\s+vec2\s+vUv\s*;/, "__SHADER_PAINT_UV_DECLARATION__")
    .replace(/\bvUv\b/g, "fxAspectUv(vUv)")
    .replace("__SHADER_PAINT_UV_DECLARATION__", "varying vec2 vUv;");
  return `
    uniform float uMatchRatio;
    uniform float uAspectRatio;
    vec2 fxAspectUv(vec2 uv) {
      vec2 squareReference = uAspectRatio >= 1.0
        ? vec2((uv.x - 0.5) * uAspectRatio + 0.5, uv.y)
        : vec2(uv.x, (uv.y - 0.5) / uAspectRatio + 0.5);
      // Off uses a long-edge square reference; on preserves the canvas's
      // native UV ratio, matching the current document proportions.
      return mix(squareReference, uv, uMatchRatio);
    }
    ${source}
  `;
}

const NOISE_GLSL = `
  // Sine-free hash ("hash without sine", iq-style): avoids the precision collapse
  // that sin()-based hashes suffer once their input grows large (common once uTime
  // accumulates for more than a minute or so), which otherwise shows up as hard
  // square/grid-aligned block artifacts instead of smooth pseudo-random noise.
  float fxHash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  vec2 fxHash2(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
  }
  float fxNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = fxHash(i);
    float b = fxHash(i + vec2(1.0, 0.0));
    float c = fxHash(i + vec2(0.0, 1.0));
    float d = fxHash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
  }
  // Periodic value noise. Unlike blending unrelated tiles, this wraps the
  // lattice itself, so it remains sharp and continuous even at low scales.
  float fxTileNoise(vec2 p, vec2 period) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 periodCells = max(vec2(1.0), floor(period + 0.5));
    vec2 aCell = mod(i, periodCells);
    vec2 bCell = mod(i + vec2(1.0, 0.0), periodCells);
    vec2 cCell = mod(i + vec2(0.0, 1.0), periodCells);
    vec2 dCell = mod(i + vec2(1.0), periodCells);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(fxHash(aCell), fxHash(bCell), u.x) + (fxHash(cCell) - fxHash(aCell)) * u.y * (1.0 - u.x) + (fxHash(dCell) - fxHash(bCell)) * u.x * u.y;
  }
  // Fractal/"cloud" noise: a handful of octaves of fxNoise summed at increasing frequency.
  float fxFbm(vec2 p) {
    float v = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 4; i++) {
      v += amp * fxNoise(p);
      p *= 2.02;
      amp *= 0.5;
    }
    return v;
  }
  // Classic cellular/Voronoi field: distance from each texel to the nearest of 9
  // jittered lattice points, producing organic cell-like boundaries.
  float fxVoronoi(vec2 p) {
    vec2 ip = floor(p);
    vec2 fp = fract(p);
    float minDist = 1.5;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 neighbor = vec2(float(x), float(y));
        vec2 point = fxHash2(ip + neighbor);
        vec2 diff = neighbor + point - fp;
        minDist = min(minDist, length(diff));
      }
    }
    return minDist;
  }
  // Ridged fbm: inverts each octave around its midpoint and sharpens it,
  // producing crisp mountain-ridge-like lines instead of smooth rolling hills.
  float fxRidged(vec2 p) {
    float v = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 4; i++) {
      float n = 1.0 - abs(fxNoise(p) * 2.0 - 1.0);
      v += amp * n * n;
      p *= 2.02;
      amp *= 0.5;
    }
    return v;
  }
  // Domain-warped fbm: the coordinate fed into the final fbm sample is itself
  // displaced by two independent fbm fields — the classic iq-style "domain
  // warping" that produces organic swirl/marble patterns.
  float fxDomainWarp(vec2 p) {
    vec2 q = vec2(fxFbm(p), fxFbm(p + vec2(5.2, 1.3)));
    vec2 r = vec2(fxFbm(p + 4.0 * q + vec2(1.7, 9.2)), fxFbm(p + 4.0 * q + vec2(8.3, 2.8)));
    return fxFbm(p + 4.0 * r);
  }
  // Turbulence: sum of absolute-value noise octaves (no sign cancellation),
  // giving a chaotic, higher-contrast field than standard fbm.
  float fxTurbulence(vec2 p) {
    float v = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 4; i++) {
      v += amp * abs(fxNoise(p) * 2.0 - 1.0);
      p *= 2.02;
      amp *= 0.5;
    }
    return v;
  }
  // Single dispatcher shared by every filter that exposes a "Noise Type"
  // dropdown, so all noise-driven filters (UV Noise, UV Blur's synced fallback)
  // stay perfectly in sync on the same numeric type codes.
  // 0 value, 1 cloud(fbm), 2 voronoi, 3 ridged, 4 domain warp, 5 turbulence.
  float fxNoiseSample(vec2 p, float t) {
    if (t < 0.5) return fxNoise(p);
    else if (t < 1.5) return fxFbm(p);
    else if (t < 2.5) return fxVoronoi(p);
    else if (t < 3.5) return fxRidged(p);
    else if (t < 4.5) return fxDomainWarp(p);
    else return fxTurbulence(p);
  }
  // Returns the nearest Voronoi cell's lattice coordinate (.xy) plus a stable
  // per-cell random id (.z) — used to derive a constant offset per shard/cell
  // for geometric "shattered glass" style displacement.
  vec3 fxVoronoiCell(vec2 p) {
    vec2 ip = floor(p);
    vec2 fp = fract(p);
    float minDist = 1.5;
    vec2 bestCell = ip;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 neighbor = vec2(float(x), float(y));
        vec2 point = fxHash2(ip + neighbor);
        vec2 diff = neighbor + point - fp;
        float d = length(diff);
        if (d < minDist) { minDist = d; bestCell = ip + neighbor; }
      }
    }
    return vec3(bestCell, fxHash(bestCell));
  }
`;

// Shared numeric codes for the "Noise Type" dropdown used by UV Noise and UV
// Blur's synced fallback field — centralized here so both filters (and any
// future ones) can never drift out of sync with each other.
export const NOISE_TYPE_OPTIONS = [
  { value: "value", label: "Value" },
  { value: "cloud", label: "Cloud" },
  { value: "voronoi", label: "Voronoi" },
  { value: "ridged", label: "Ridged" },
  { value: "warp", label: "Domain Warp" },
  { value: "turbulence", label: "Turbulence" },
];
const NOISE_TYPE_CODES = { value: 0, cloud: 1, voronoi: 2, ridged: 3, warp: 4, turbulence: 5 };
export function noiseTypeCode(name) {
  return NOISE_TYPE_CODES[name] ?? 1;
}

// Multi-point value-curve evaluator shared by every filter that exposes a "curve"
// param (radial distort falloff, curve blur bend). Points are packed as
// vec4(x, y, type, unused) where type 1.0 == "constant" (step: hold this
// point's y until the next point) and 0.0 == "bezier" (real cubic-bezier
// interpolation to the next point). A parallel array, uCurveTans, holds
// vec4(tanDx, tanDy, tanSet, unused) per point — a point's own tangent-handle
// offset (in the same x/y curve space), used directly as its OUTGOING control
// point for the segment ahead of it, and mirrored (negated) as its INCOMING
// control point for the segment behind it. This is a classic "smooth anchor"
// with a single draggable handle, exactly matching pen-tool conventions
// (Illustrator/Figma): dragging one handle reshapes both neighboring segments.
// When tanSet is 0 (point never dragged), a default tangent is derived
// per-segment (span/3 horizontally, flat) that reproduces a smoothstep-like
// ease — the exact cubic-bezier identity for 3t²-2t³. `count` is the number of
// points actually in use (arrays always padded to CURVE_MAX_POINTS).
const CURVE_MAX_POINTS = 8;
const CURVE_GLSL = `
  #define FX_CURVE_MAX ${CURVE_MAX_POINTS}
  // Solves a cubic bezier's x(s) = t for parameter s via Newton-Raphson,
  // clamped each step to stay in [0,1] — the same technique browsers use
  // internally for CSS cubic-bezier() timing functions. Reliable as long as
  // the control-point x's are kept within [p0x, p3x] (monotonic in x), which
  // fxCurveEval guarantees by clamping before calling this.
  float fxCubicSolveX(float p0x, float c1x, float c2x, float p3x, float t) {
    float s = clamp(t, 0.0, 1.0);
    for (int i = 0; i < 8; i++) {
      float mt = 1.0 - s;
      float x = mt * mt * mt * p0x + 3.0 * mt * mt * s * c1x + 3.0 * mt * s * s * c2x + s * s * s * p3x - t;
      float d = 3.0 * mt * mt * (c1x - p0x) + 6.0 * mt * s * (c2x - c1x) + 3.0 * s * s * (p3x - c2x);
      if (abs(d) < 1e-6) break;
      s = clamp(s - x / d, 0.0, 1.0);
    }
    return s;
  }
  float fxCurveEval(float t, vec4 pts[FX_CURVE_MAX], vec4 tans[FX_CURVE_MAX], int count) {
    float tc = clamp(t, 0.0, 1.0);
    for (int i = 0; i < FX_CURVE_MAX - 1; i++) {
      if (i >= count - 1) break;
      vec4 a = pts[i];
      vec4 b = pts[i + 1];
      if (tc >= a.x && (tc < b.x || i >= count - 2)) {
        if (a.z > 0.5) return a.y;
        float span = max(b.x - a.x, 1e-5);
        vec4 ta = tans[i];
        vec4 tb = tans[i + 1];
        vec2 c1 = ta.z > 0.5 ? (a.xy + ta.xy) : (a.xy + vec2(span / 3.0, 0.0));
        vec2 c2 = tb.z > 0.5 ? (b.xy - tb.xy) : (b.xy - vec2(span / 3.0, 0.0));
        // Clamp horizontal control positions to the segment so x(s) stays
        // monotonic (a valid function of x) even if a dragged handle points
        // backward or far past the neighboring point. Y is left free so
        // overshoot/bounce shapes remain expressible.
        c1.x = clamp(c1.x, a.x, b.x);
        c2.x = clamp(c2.x, a.x, b.x);
        float s = fxCubicSolveX(a.x, c1.x, c2.x, b.x, tc);
        float mt = 1.0 - s;
        return mt * mt * mt * a.y + 3.0 * mt * mt * s * c1.y + 3.0 * mt * s * s * c2.y + s * s * s * b.y;
      }
    }
    return pts[count - 1].y;
  }
`;

function clamp01(n) {
  return Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
}

function clampNum(n, lo, hi) {
  return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : 0));
}

// JS mirror of fxCubicSolveX (see CURVE_GLSL) — Newton-Raphson solve of a cubic
// bezier's x(s) = t for parameter s, used by the manager UI's curve preview.
function cubicSolveX(p0x, c1x, c2x, p3x, t) {
  let s = clamp01(t);
  for (let i = 0; i < 8; i++) {
    const mt = 1 - s;
    const x = mt * mt * mt * p0x + 3 * mt * mt * s * c1x + 3 * mt * s * s * c2x + s * s * s * p3x - t;
    const d = 3 * mt * mt * (c1x - p0x) + 6 * mt * s * (c2x - c1x) + 3 * s * s * (p3x - c2x);
    if (Math.abs(d) < 1e-6) break;
    s = clamp01(s - x / d);
  }
  return s;
}

// Best-effort one-time migration from the older single-scalar `bend` (plus any
// freely-rotated `handleAngle`/`handleDist` from an even earlier iteration) to
// the new real per-point bezier tangent. Only used for points saved before this
// rewrite that have no explicit tanDx/tanDy of their own; exact visual parity
// with the old shapes isn't the goal, just a reasonable non-destructive carry-over.
function deriveLegacyTangent(p) {
  if (typeof p.handleAngle === "number" && typeof p.handleDist === "number" && p.handleDist > 0) {
    const mag = p.handleDist * 0.33;
    return { tanDx: Math.cos(p.handleAngle) * mag, tanDy: Math.sin(p.handleAngle) * mag, tanSet: true };
  }
  if (typeof p.bend === "number" && p.bend !== 0) {
    return { tanDx: 0, tanDy: clampNum(p.bend, -1, 1) * 0.25, tanSet: true };
  }
  return { tanDx: 0, tanDy: 0, tanSet: false };
}

// Normalizes any curve param value — including legacy single-control-point
// {x, y} quadratic-bezier values, and legacy {bend}/{handleAngle,handleDist}
// point formats from before this rewrite — into the canonical shape:
// { points: [{x, y, type, tanDx, tanDy, tanSet}, ...] }, sorted ascending by
// x, always anchored at x=0 and x=1. tanSet=false means "use the per-segment
// auto-default tangent" (see CURVE_GLSL/evalCurveAt) rather than a stored value.
export function normalizeCurveValue(value) {
  if (value && Array.isArray(value.points) && value.points.length >= 2) {
    const pts = value.points
      .map((p) => {
        const explicit = p.tanSet && typeof p.tanDx === "number" && typeof p.tanDy === "number";
        const tan = explicit ? { tanDx: p.tanDx, tanDy: p.tanDy, tanSet: true } : deriveLegacyTangent(p);
        return {
          x: clamp01(p.x),
          y: clamp01(p.y),
          type: p.type === "constant" ? "constant" : "bezier",
          tanDx: tan.tanSet ? tan.tanDx : 0,
          tanDy: tan.tanSet ? tan.tanDy : 0,
          tanSet: !!tan.tanSet,
        };
      })
      .sort((a, b) => a.x - b.x)
      .slice(0, CURVE_MAX_POINTS);
    pts[0] = { ...pts[0], x: 0 };
    pts[pts.length - 1] = { ...pts[pts.length - 1], x: 1 };
    return { points: pts };
  }
  if (value && typeof value.x === "number" && typeof value.y === "number") {
    return {
      points: [
        { x: 0, y: 0, type: "bezier", tanDx: 0, tanDy: 0, tanSet: false },
        { x: clamp01(value.x), y: clamp01(value.y), type: "bezier", tanDx: 0, tanDy: 0, tanSet: false },
        { x: 1, y: 1, type: "bezier", tanDx: 0, tanDy: 0, tanSet: false },
      ],
    };
  }
  return {
    points: [
      { x: 0, y: 0, type: "bezier", tanDx: 0, tanDy: 0, tanSet: false },
      { x: 1, y: 1, type: "bezier", tanDx: 0, tanDy: 0, tanSet: false },
    ],
  };
}

// Evaluates the normalized curve at parameter t in [0,1] with the same math as
// the GLSL fxCurveEval — used by the manager UI to draw curve previews.
export function evalCurveAt(curveValue, t) {
  const { points } = normalizeCurveValue(curveValue);
  const tc = clamp01(t);
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (tc >= a.x && (tc < b.x || i === points.length - 2)) {
      if (a.type === "constant") return a.y;
      const span = Math.max(b.x - a.x, 1e-5);
      const c1x = clampNum(a.tanSet ? a.x + a.tanDx : a.x + span / 3, a.x, b.x);
      const c1y = a.tanSet ? a.y + a.tanDy : a.y;
      const c2x = clampNum(b.tanSet ? b.x - b.tanDx : b.x - span / 3, a.x, b.x);
      const c2y = b.tanSet ? b.y - b.tanDy : b.y;
      const s = cubicSolveX(a.x, c1x, c2x, b.x, tc);
      const mt = 1 - s;
      return mt * mt * mt * a.y + 3 * mt * mt * s * c1y + 3 * mt * s * s * c2y + s * s * s * b.y;
    }
  }
  return points[points.length - 1].y;
}

// Builds the fixed-size (padded to CURVE_MAX_POINTS) uniform array representation
// consumed by the shared fxCurveEval GLSL function — one vec4 per point for the
// point data (x, y, type, unused) and a parallel vec4 per point for its tangent
// handle (tanDx, tanDy, tanSet, unused).
export function curveToUniformArray(curveValue) {
  const { points } = normalizeCurveValue(curveValue);
  const arr = [];
  const tans = [];
  for (let i = 0; i < CURVE_MAX_POINTS; i++) {
    const p = points[Math.min(i, points.length - 1)];
    arr.push([p.x, p.y, p.type === "constant" ? 1 : 0, 0]);
    tans.push([p.tanDx || 0, p.tanDy || 0, p.tanSet ? 1 : 0, 0]);
  }
  return { points: arr, tans, count: points.length };
}

// Multi-stop color-gradient system for the Gradient Map filter — the Figma
// gradient-bar / Blender ColorRamp equivalent, replacing the old fixed
// shadow-hue/highlight-hue pair with any number of freely positioned,
// freely colored stops.
const GRADIENT_MAX_STOPS = 16;
function clampHex(hex) {
  const m = typeof hex === "string" ? /^#?([0-9a-fA-F]{6})$/.exec(hex.trim()) : null;
  return m ? `#${m[1].toLowerCase()}` : "#ffffff";
}
function hexToRgb01(hex) {
  const c = clampHex(hex).slice(1);
  return [parseInt(c.slice(0, 2), 16) / 255, parseInt(c.slice(2, 4), 16) / 255, parseInt(c.slice(4, 6), 16) / 255];
}
function rgb01ToHex([r, g, b]) {
  const h = (n) => Math.round(clamp01(n) * 255).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

// Normalizes any gradient param value into the canonical shape
// { stops: [{ t, color }, ...] }, sorted ascending by t, always at least 2
// stops, capped at GRADIENT_MAX_STOPS. Positions outside the outermost stops
// simply extend that stop's color flatly (same behavior as CSS/Figma linear
// gradients), so stops need not sit exactly at t=0/t=1.
export function normalizeGradientValue(value) {
  let stops = value && Array.isArray(value.stops) ? value.stops : null;
  if (!stops || stops.length < 2) {
    stops = [
      { t: 0, color: "#1b2a6b" },
      { t: 1, color: "#ffcf6b" },
    ];
  }
  const norm = stops
    .map((s) => ({ t: clamp01(Number(s && s.t)), color: clampHex(s && s.color) }))
    .sort((a, b) => a.t - b.t)
    .slice(0, GRADIENT_MAX_STOPS);
  if (norm.length < 2) norm.push({ t: 1, color: "#ffffff" });
  return { stops: norm };
}

export function evalGradientAt(value, t) {
  const { stops } = normalizeGradientValue(value);
  const tc = clamp01(t);
  if (tc <= stops[0].t) return stops[0].color;
  if (tc >= stops[stops.length - 1].t) return stops[stops.length - 1].color;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (tc >= a.t && tc <= b.t) {
      const span = Math.max(b.t - a.t, 1e-5);
      const k = (tc - a.t) / span;
      const ca = hexToRgb01(a.color);
      const cb = hexToRgb01(b.color);
      return rgb01ToHex([ca[0] + (cb[0] - ca[0]) * k, ca[1] + (cb[1] - ca[1]) * k, ca[2] + (cb[2] - ca[2]) * k]);
    }
  }
  return stops[stops.length - 1].color;
}

// CSS preview string for the collapsed gradient-bar swatch button in the panel.
export function gradientToCssString(value) {
  const { stops } = normalizeGradientValue(value);
  return `linear-gradient(90deg, ${stops.map((s) => `${s.color} ${(s.t * 100).toFixed(1)}%`).join(", ")})`;
}

// Builds the fixed-size (padded to GRADIENT_MAX_STOPS) uniform array consumed
// by fxGradientEval — one vec4 per stop packed as (r, g, b, t).
export function gradientToUniformArray(value) {
  const { stops } = normalizeGradientValue(value);
  const arr = [];
  for (let i = 0; i < GRADIENT_MAX_STOPS; i++) {
    const s = stops[Math.min(i, stops.length - 1)];
    const rgb = hexToRgb01(s.color);
    arr.push([rgb[0], rgb[1], rgb[2], s.t]);
  }
  return { stops: arr, count: stops.length };
}

const GRADIENT_GLSL = `
  #define FX_GRAD_MAX ${GRADIENT_MAX_STOPS}
  vec3 fxGradientEval(float t, vec4 stops[FX_GRAD_MAX], int count) {
    float tc = clamp(t, 0.0, 1.0);
    if (tc <= stops[0].a) return stops[0].rgb;
    if (tc >= stops[count - 1].a) return stops[count - 1].rgb;
    for (int i = 0; i < FX_GRAD_MAX - 1; i++) {
      if (i >= count - 1) break;
      vec4 a = stops[i];
      vec4 b = stops[i + 1];
      if (tc >= a.a && tc <= b.a) {
        float span = max(b.a - a.a, 1e-5);
        return mix(a.rgb, b.rgb, (tc - a.a) / span);
      }
    }
    return stops[count - 1].rgb;
  }
`;

// Shared HSL <-> RGB helpers plus a spec-accurate "color" blend (hue+saturation
// from a source color, luminosity kept from the backdrop) used by Color Variation.
const HSL_GLSL = `
  vec3 fxHsl2rgb(vec3 hsl) {
    float h = hsl.x / 360.0;
    float s = hsl.y;
    float l = hsl.z;
    float c = (1.0 - abs(2.0 * l - 1.0)) * s;
    float hp = h * 6.0;
    float x = c * (1.0 - abs(mod(hp, 2.0) - 1.0));
    vec3 rgb;
    if (hp < 1.0) rgb = vec3(c, x, 0.0);
    else if (hp < 2.0) rgb = vec3(x, c, 0.0);
    else if (hp < 3.0) rgb = vec3(0.0, c, x);
    else if (hp < 4.0) rgb = vec3(0.0, x, c);
    else if (hp < 5.0) rgb = vec3(x, 0.0, c);
    else rgb = vec3(c, 0.0, x);
    return rgb + (l - c * 0.5);
  }
  float fxLum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
  vec3 fxClipColor(vec3 c) {
    float l = fxLum(c);
    float n = min(c.r, min(c.g, c.b));
    float x = max(c.r, max(c.g, c.b));
    if (n < 0.0) c = l + (c - l) * (l / max(l - n, 1e-5));
    if (x > 1.0) c = l + (c - l) * ((1.0 - l) / max(x - l, 1e-5));
    return c;
  }
  vec3 fxSetLum(vec3 c, float l) {
    float d = l - fxLum(c);
    return fxClipColor(c + vec3(d));
  }
`;

// ─── Filter catalogue ──────────────────────────────────────────────────────────
// `passes` describes 1..n sub-passes executed in order. Each pass has its own
// fragment shader "key" (cached/compiled once) plus an updateUniforms callback.
export const FILTER_DEFS = [
  {
    id: "parameterOffset",
    label: "Parameter Offset",
    group: "Effect",
    adjustmentOnly: true,
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M2 4h12M2 8h12M2 12h12"/><circle cx="6" cy="4" r="1.7"/><circle cx="10" cy="8" r="1.7"/><circle cx="7.5" cy="12" r="1.7"/></svg>`,
    params: [],
    passes: [],
  },
  {
    id: "glow",
    label: "Glow / Deep Glow",
    group: "Color",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="8" cy="8" r="2.6"/><path d="M8 1.4v2M8 12.6v2M1.4 8h2M12.6 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/></svg>`,
    params: [
      { key: "threshold", label: "Threshold", min: 0, max: 1, step: 0.01, default: 0.55 },
      { key: "intensity", label: "Intensity", min: 0, max: 3, step: 0.02, default: 1.1 },
      { key: "radius", label: "Radius", min: 0.5, max: 6, step: 0.05, default: 2.2 },
      { key: "steps", label: "Steps (Quality)", min: 2, max: 8, step: 1, default: 4 },
    ],
    passes: [
      {
        key: "glow",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform vec2 uResolution;
          uniform float uThreshold;
          uniform float uIntensity;
          uniform float uRadius;
          uniform float uSteps;
          varying vec2 vUv;
          const int MAX_GLOW_STEPS = 8;
          void main() {
            vec4 base = texture2D(tDiffuse, vUv);
            vec2 texel = 1.0 / uResolution;
            vec3 glow = vec3(0.0);
            float total = 0.0;
            for (int x = -MAX_GLOW_STEPS; x <= MAX_GLOW_STEPS; x++) {
              if (abs(float(x)) > uSteps) continue;
              for (int y = -MAX_GLOW_STEPS; y <= MAX_GLOW_STEPS; y++) {
                if (abs(float(y)) > uSteps) continue;
                // Radius defines the outer reach of the glow in texels.
                // Steps only changes the density of samples within that fixed
                // reach, so raising quality cannot make the glow larger.
                vec2 offset = vec2(float(x), float(y)) * texel * uRadius / max(uSteps, 1.0);
                vec3 c = texture2D(tDiffuse, vUv + offset).rgb;
                float lum = dot(c, vec3(0.299, 0.587, 0.114));
                float w = smoothstep(uThreshold, 1.0, lum);
                glow += c * w;
                total += 1.0;
              }
            }
            glow /= total;
            gl_FragColor = vec4(base.rgb + glow * uIntensity, base.a);
          }
        `,
        updateUniforms(u, params) {
          u.uThreshold.value = params.threshold;
          u.uIntensity.value = params.intensity;
          u.uRadius.value = params.radius;
          u.uSteps.value = params.steps;
        },
      },
    ],
  },
  {
    id: "basicTone",
    label: "Brightness / Contrast",
    group: "Color",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="8" cy="8" r="4.8"/><path d="M8 3.2v9.6"/><path d="M3.2 8h9.6" opacity="0.5"/></svg>`,
    params: [
      { key: "brightness", label: "Brightness", min: -1, max: 1, step: 0.01, default: 0 },
      { key: "contrast", label: "Contrast", min: -1, max: 1, step: 0.01, default: 0 },
    ],
    passes: [
      {
        key: "basicTone",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform float uBrightness;
          uniform float uContrast;
          varying vec2 vUv;
          void main() {
            vec4 base = texture2D(tDiffuse, vUv);
            vec3 color = base.rgb + vec3(uBrightness);
            color = (color - 0.5) * (1.0 + uContrast) + 0.5;
            color = base.a > 0.00001 ? clamp(color, 0.0, 1.0) : vec3(0.0);
            gl_FragColor = vec4(color, base.a);
          }
        `,
        updateUniforms(u, params) {
          u.uBrightness.value = params.brightness;
          u.uContrast.value = params.contrast;
        },
      },
    ],
  },
  {
    id: "levels",
    label: "Levels",
    group: "Color",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M2 12h12"/><path d="M4 12V8"/><path d="M8 12V4"/><path d="M12 12V6"/></svg>`,
    params: [
      {
        key: "graph",
        label: "Graph",
        type: "levelsGraph",
        default: 0,
        blackKey: "blackPoint",
        gammaKey: "gamma",
        whiteKey: "whitePoint",
      },
      { key: "blackPoint", label: "Input Black", min: 0, max: 0.5, step: 0.005, default: 0 },
      { key: "whitePoint", label: "Input White", min: 0.5, max: 1, step: 0.005, default: 1 },
      { key: "gamma", label: "Gamma", min: 0.2, max: 3, step: 0.01, default: 1 },
    ],
    passes: [
      {
        key: "levels",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform float uBlackPoint;
          uniform float uWhitePoint;
          uniform float uGamma;
          varying vec2 vUv;
          void main() {
            vec4 base = texture2D(tDiffuse, vUv);
            float lo = min(uBlackPoint, uWhitePoint - 0.001);
            float hi = max(uWhitePoint, lo + 0.001);
            vec3 color = clamp((base.rgb - vec3(lo)) / (hi - lo), 0.0, 1.0);
            color = pow(color, vec3(1.0 / max(uGamma, 0.001)));
            gl_FragColor = vec4(clamp(color, 0.0, 1.0), base.a);
          }
        `,
        updateUniforms(u, params) {
          u.uBlackPoint.value = params.blackPoint;
          u.uWhitePoint.value = params.whitePoint;
          u.uGamma.value = params.gamma;
        },
      },
    ],
  },
  {
    id: "colorBalance",
    label: "Color Balance",
    group: "Color",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M3 4h10M3 8h10M3 12h10"/><circle cx="6" cy="4" r="1.2"/><circle cx="10" cy="8" r="1.2"/><circle cx="7" cy="12" r="1.2"/></svg>`,
    params: [
      { key: "cyanRed", label: "Cyan / Red", min: -1, max: 1, step: 0.01, default: 0 },
      { key: "magentaGreen", label: "Magenta / Green", min: -1, max: 1, step: 0.01, default: 0 },
      { key: "yellowBlue", label: "Yellow / Blue", min: -1, max: 1, step: 0.01, default: 0 },
      { key: "preserveLuminosity", label: "Preserve Luminosity", type: "toggle", default: true },
    ],
    passes: [
      {
        key: "colorBalance",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform vec3 uBalance;
          uniform float uPreserveLuminosity;
          varying vec2 vUv;
          float fxLuma(vec3 color) { return dot(color, vec3(0.299, 0.587, 0.114)); }
          void main() {
            vec4 base = texture2D(tDiffuse, vUv);
            float luma = fxLuma(base.rgb);
            float shadows = 1.0 - smoothstep(0.0, 0.5, luma);
            float highlights = smoothstep(0.5, 1.0, luma);
            float midtones = 1.0 - shadows - highlights;
            vec3 tonalWeight = vec3(0.65 * shadows + midtones + 0.65 * highlights);
            vec3 color = clamp(base.rgb + uBalance * tonalWeight, 0.0, 1.0);
            if (uPreserveLuminosity > 0.5) {
              color *= (fxLuma(base.rgb) + 1e-4) / (fxLuma(color) + 1e-4);
            }
            gl_FragColor = vec4(clamp(color, 0.0, 1.0), base.a);
          }
        `,
        updateUniforms(u, params) {
          u.uBalance.value.set(params.cyanRed || 0, params.magentaGreen || 0, params.yellowBlue || 0);
          u.uPreserveLuminosity.value = params.preserveLuminosity ? 1 : 0;
        },
      },
    ],
  },
  {
    id: "roughenEdges",
    label: "Roughen Edges",
    group: "Effect",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M3 12c1.5-4 2.6-4.3 4-1.4 1.4-4.8 3.3-4.7 6-6.6"/><path d="M3 4h10v8H3z"/></svg>`,
    params: [
      { key: "amount", label: "Amount", min: 0, max: 1, step: 0.01, default: 0.45 },
      { key: "width", label: "Edge Width", min: 0, max: 64, step: 0.5, default: 8 },
      { key: "scale", label: "Rough Scale", min: 1, max: 400, step: 1, default: 24 },
      { key: "sharpness", label: "Edge Sharpness", min: 0.25, max: 4, step: 0.05, default: 1 },
    ],
    passes: [
      {
        key: "roughenEdges",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform vec2 uResolution;
          uniform float uAmount;
          uniform float uWidth;
          uniform float uScale;
          uniform float uSharpness;
          varying vec2 vUv;
          ${NOISE_GLSL}
          void main() {
            vec4 base = texture2D(tDiffuse, vUv);
            vec2 field = vec2(
              fxFbm(vUv * uScale + vec2(2.3, 7.1)),
              fxFbm(vUv * uScale + vec2(8.6, 3.4))
            ) * 2.0 - 1.0;
            float fieldLength = max(length(field), 1e-4);
            vec2 roughUv = clamp(vUv + field / fieldLength * (uWidth / uResolution), 0.0, 1.0);
            vec4 roughSample = texture2D(tDiffuse, roughUv);
            float alpha = mix(base.a, roughSample.a, uAmount);
            alpha = pow(clamp(alpha, 0.0, 1.0), max(0.01, uSharpness));
            gl_FragColor = vec4(mix(base.rgb, roughSample.rgb, uAmount), alpha);
          }
        `,
        updateUniforms(u, params) {
          u.uAmount.value = params.amount;
          u.uWidth.value = params.width;
          u.uScale.value = params.scale;
          u.uSharpness.value = params.sharpness;
        },
      },
    ],
  },
  {
    id: "findEdges",
    label: "Find Edges",
    group: "Effect",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M3 12 6.1 7.5 8.6 10l4.4-6M3 4h10v8H3z"/></svg>`,
    params: [
      { key: "radius", label: "Radius", min: 0.25, max: 6, step: 0.05, default: 1 },
      { key: "strength", label: "Strength", min: 0, max: 4, step: 0.05, default: 1.4 },
      { key: "invert", label: "Invert", type: "toggle", default: false },
      { key: "transparentBackground", label: "Transparent Background", type: "toggle", default: false },
    ],
    passes: [
      {
        key: "findEdges",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform vec2 uResolution;
          uniform float uRadius;
          uniform float uStrength;
          uniform float uInvert;
          uniform float uTransparentBackground;
          varying vec2 vUv;
          vec2 fxEdgeData(vec2 uv) {
            vec4 sampleColor = texture2D(tDiffuse, clamp(uv, 0.0, 1.0));
            return vec2(dot(sampleColor.rgb, vec3(0.299, 0.587, 0.114)) * sampleColor.a, sampleColor.a);
          }
          void main() {
            vec2 texel = uRadius / uResolution;
            vec2 tl = fxEdgeData(vUv + texel * vec2(-1.0, 1.0));
            vec2 tc = fxEdgeData(vUv + texel * vec2(0.0, 1.0));
            vec2 tr = fxEdgeData(vUv + texel * vec2(1.0, 1.0));
            vec2 ml = fxEdgeData(vUv + texel * vec2(-1.0, 0.0));
            vec2 mr = fxEdgeData(vUv + texel * vec2(1.0, 0.0));
            vec2 bl = fxEdgeData(vUv + texel * vec2(-1.0, -1.0));
            vec2 bc = fxEdgeData(vUv + texel * vec2(0.0, -1.0));
            vec2 br = fxEdgeData(vUv + texel * vec2(1.0, -1.0));
            vec2 gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
            vec2 gy = -tl - 2.0 * tc - tr + bl + 2.0 * bc + br;
            float colorEdge = length(vec2(gx.x, gy.x));
            float alphaEdge = length(vec2(gx.y, gy.y)) * 0.5;
            float edgeMask = clamp(max(colorEdge, alphaEdge) * uStrength, 0.0, 1.0);
            float edgeColor = mix(edgeMask, 1.0 - edgeMask, uInvert);
            float alpha = mix(texture2D(tDiffuse, vUv).a, edgeMask, uTransparentBackground);
            gl_FragColor = vec4(vec3(edgeColor), alpha);
          }
        `,
        updateUniforms(u, params) {
          u.uRadius.value = params.radius;
          u.uStrength.value = params.strength;
          u.uInvert.value = params.invert ? 1 : 0;
          u.uTransparentBackground.value = params.transparentBackground ? 1 : 0;
        },
      },
    ],
  },
  {
    id: "highlightShadow",
    label: "Highlight / Shadow",
    group: "Color",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M2 8a6 6 0 1112 0 6 6 0 01-12 0Z"/><path d="M8 2a6 6 0 000 12" opacity="0.5"/></svg>`,
    params: [
      { key: "highlights", label: "Highlights", min: -1, max: 1, step: 0.01, default: 0 },
      { key: "shadows", label: "Shadows", min: -1, max: 1, step: 0.01, default: 0 },
    ],
    passes: [
      {
        key: "highlightShadow",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform float uHighlights;
          uniform float uShadows;
          varying vec2 vUv;
          float fxLum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
          void main() {
            vec4 base = texture2D(tDiffuse, vUv);
            vec3 color = clamp(base.rgb, 0.0, 1.0);
            float lum = clamp(fxLum(color), 0.0, 1.0);
            float eps = 1e-4;

            float shadowPos = max(uShadows, 0.0);
            float shadowNeg = max(-uShadows, 0.0);
            float highlightPos = max(uHighlights, 0.0);
            float highlightNeg = max(-uHighlights, 0.0);

            // Photoshop-like luminance remap: lift/compress shadows and recover/compress
            // highlights with non-linear curves, then restore chroma by luminance ratio.
            float shadowLift = clamp(
              (pow(lum, 1.0 / (shadowPos + 1.0)) - 0.76 * pow(lum, 2.0 / (shadowPos + 1.0))) - lum,
              0.0, 1.0
            );
            float shadowCrush = clamp(lum - pow(lum, 1.0 + shadowNeg * 1.35), 0.0, 1.0);

            float oneMinus = 1.0 - lum;
            float highlightRecover = clamp(
              lum - (1.0 - (pow(oneMinus, 1.0 / (2.0 - highlightPos)) - 0.8 * pow(oneMinus, 2.0 / (2.0 - highlightPos)))),
              0.0, 1.0
            );
            float highlightBoost = clamp(pow(lum, 1.0 + highlightNeg * 1.35) - lum, 0.0, 1.0);

            float lumOut = clamp(lum + shadowLift - shadowCrush - highlightRecover + highlightBoost, 0.0, 1.0);
            vec3 outColor = color * ((lumOut + eps) / (lum + eps));
            gl_FragColor = vec4(clamp(outColor, 0.0, 1.0), base.a);
          }
        `,
        updateUniforms(u, params) {
          u.uHighlights.value = params.highlights;
          u.uShadows.value = params.shadows;
        },
      },
    ],
  },
  {
    id: "hueSaturation",
    label: "Hue / Saturation",
    group: "Color",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="8" cy="8" r="5.2"/><path d="M8 2.8v5.3l3.7 2.3" opacity="0.75"/></svg>`,
    params: [
      { key: "hue", label: "Hue", min: -180, max: 180, step: 1, default: 0 },
      { key: "saturation", label: "Saturation", min: -1, max: 1, step: 0.01, default: 0 },
      { key: "lightness", label: "Lightness", min: -1, max: 1, step: 0.01, default: 0 },
    ],
    passes: [
      {
        key: "hueSaturation",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform float uHueShift;
          uniform float uSatScale;
          uniform float uLightness;
          varying vec2 vUv;
          vec3 rgb2hsv(vec3 c) {
            vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
            vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
            vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
            float d = q.x - min(q.w, q.y);
            float e = 1.0e-10;
            return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
          }
          vec3 hsv2rgb(vec3 c) {
            vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
            return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
          }
          void main() {
            vec4 base = texture2D(tDiffuse, vUv);
            vec3 hsv = rgb2hsv(base.rgb);
            hsv.x = fract(hsv.x + uHueShift);
            hsv.y = clamp(hsv.y * uSatScale, 0.0, 1.0);
            vec3 color = hsv2rgb(hsv);
            color = mix(color, vec3(1.0), max(uLightness, 0.0));
            color = mix(color, vec3(0.0), max(-uLightness, 0.0));
            gl_FragColor = vec4(clamp(color, 0.0, 1.0), base.a);
          }
        `,
        updateUniforms(u, params) {
          u.uHueShift.value = (params.hue || 0) / 360;
          u.uSatScale.value = 1 + (params.saturation || 0);
          u.uLightness.value = params.lightness || 0;
        },
      },
    ],
  },
  {
    id: "chroma",
    label: "Chromatic Aberration",
    group: "Color",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="6.6" cy="7" r="3.4" opacity="0.85"/><circle cx="9.4" cy="7" r="3.4" opacity="0.55"/><circle cx="8" cy="9.2" r="3.4" opacity="0.7"/></svg>`,
    params: [
      { key: "amount", label: "Amount", min: 0, max: 0.2, step: 0.001, default: 0.01 },
      { key: "edge", label: "Edge Bias", min: 0, max: 1, step: 0.01, default: 0.6 },
      {
        key: "mode",
        label: "Field",
        type: "select",
        default: "radial",
        options: [
          { value: "radial", label: "Radial" },
          { value: "linear", label: "Linear" },
          { value: "diamond", label: "Diamond" },
          { value: "organic", label: "Organic Flow" },
          { value: "image", label: "Image Gradient" },
        ],
      },
      {
        key: "direction",
        label: "Direction",
        min: 0,
        max: 360,
        step: 1,
        default: 35,
        showIf: (p) => p.mode === "linear" || p.mode === "diamond",
      },
      { key: "flowScale", label: "Flow Scale", min: 0.5, max: 20, step: 0.1, default: 6, showIf: (p) => p.mode === "organic" },
      { key: "flowWarp", label: "Flow Warp", min: 0, max: 1.5, step: 0.01, default: 0.35, showIf: (p) => p.mode === "organic" },
      { key: "speed", label: "Flow Speed", min: 0, max: 2, step: 0.02, default: 0.25, showIf: (p) => p.mode === "organic" },
    ],
    passes: [
      {
        key: "chroma",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform vec2 uResolution;
          uniform float uAmount;
          uniform float uEdge;
          uniform float uMode;
          uniform float uAngle;
          uniform float uScale;
          uniform float uJitter;
          uniform float uSpeed;
          uniform float uTime;
          varying vec2 vUv;
          ${NOISE_GLSL}
          vec2 fxRotate(vec2 p, float a) {
            float s = sin(a);
            float c = cos(a);
            return mat2(c, -s, s, c) * p;
          }
          float fxLumaAt(vec2 uv) {
            vec3 c = texture2D(tDiffuse, clamp(uv, 0.0, 1.0)).rgb;
            return dot(c, vec3(0.299, 0.587, 0.114));
          }
          void main() {
            vec2 center = vec2(0.5);
            vec2 c = vUv - center;
            float dist = length(c) * 2.0;
            float k = mix(1.0, dist, uEdge);
            vec2 dir = normalize(c + vec2(1e-5));

            if (uMode >= 0.5 && uMode < 1.5) {
              vec2 lin = fxRotate(vec2(1.0, 0.0), radians(uAngle));
              dir = normalize(lin);
            } else if (uMode >= 1.5 && uMode < 2.5) {
              vec2 d = fxRotate(c, radians(uAngle));
              d = vec2(sign(d.x) * (abs(d.x) + 0.001), sign(d.y) * (abs(d.y) + 0.001));
              dir = normalize(d);
            } else if (uMode >= 2.5 && uMode < 3.5) {
              vec2 p = vUv * max(uScale, 0.2);
              float t = mod(uTime * max(uSpeed, 0.0) * 0.12, 1000.0);
              p += vec2(t, -t * 0.73);
              vec2 warp = vec2(
                fxFbm(p * 0.74 + vec2(2.1, 7.3)),
                fxFbm(p * 0.74 + vec2(9.4, 1.8))
              ) - 0.5;
              p += warp * (0.9 + uJitter * 2.4);
              float a = fxDomainWarp(p * 0.61 + vec2(3.4, 5.2)) * 6.2831853;
              dir = normalize(vec2(cos(a), sin(a)));
            } else if (uMode >= 3.5) {
              vec2 texel = 1.0 / max(uResolution, vec2(1.0));
              float lL = fxLumaAt(vUv - vec2(texel.x, 0.0));
              float lR = fxLumaAt(vUv + vec2(texel.x, 0.0));
              float lD = fxLumaAt(vUv - vec2(0.0, texel.y));
              float lU = fxLumaAt(vUv + vec2(0.0, texel.y));
              vec2 grad = vec2(lR - lL, lU - lD);
              if (dot(grad, grad) > 1e-7) {
                dir = normalize(grad);
              }
            }

            vec2 offset = dir * uAmount * k;
            float r = texture2D(tDiffuse, vUv - offset).r;
            vec4 base = texture2D(tDiffuse, vUv);
            float b = texture2D(tDiffuse, vUv + offset).b;
            gl_FragColor = vec4(r, base.g, b, base.a);
          }
        `,
        updateUniforms(u, params, time) {
          const amount = Number.isFinite(params.amount) ? params.amount : 0.01;
          const edge = Number.isFinite(params.edge) ? params.edge : 0.6;
          const direction = Number.isFinite(params.direction) ? params.direction : 35;
          const flowScale = Number.isFinite(params.flowScale) ? params.flowScale : 6;
          const flowWarp = Number.isFinite(params.flowWarp) ? params.flowWarp : 0.35;
          const speed = Number.isFinite(params.speed) ? params.speed : 0.25;
          const mode = typeof params.mode === "string" ? params.mode : "radial";
          u.uAmount.value = amount;
          u.uEdge.value = edge;
          u.uAngle.value = direction;
          u.uScale.value = flowScale;
          u.uJitter.value = flowWarp;
          u.uSpeed.value = speed;
          u.uTime.value = time;
          u.uMode.value =
            mode === "linear" ? 1
            : mode === "diamond" ? 2
            : mode === "organic" ? 3
            : mode === "image" ? 4
            : 0;
        },
      },
    ],
  },
  {
    id: "mirror",
    label: "Mirror / Kaleidoscope",
    group: "Distort",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.6v12.8"/><path d="M2 4.2l6 3.8 6-3.8"/><path d="M2 11.8l6-3.8 6 3.8"/></svg>`,
    params: [
      {
        key: "mode",
        label: "Mode",
        type: "select",
        default: "axis",
        options: [
          { value: "axis", label: "Axis Mirror" },
          { value: "radial", label: "Radial Kaleidoscope" },
        ],
      },
      {
        key: "side",
        label: "Mirror Side",
        type: "select",
        default: "below",
        options: [
          { value: "below", label: "Below -> Above" },
          { value: "above", label: "Above -> Below" },
        ],
        showIf: (params) => params.mode === "axis",
      },
      {
        key: "angle",
        label: "Axis / Rotation",
        min: 0,
        max: 360,
        step: 1,
        default: 0,
      },
      {
        key: "height",
        label: "Mirror Height",
        min: -0.8,
        max: 0.8,
        step: 0.005,
        default: 0,
        showIf: (params) => params.mode === "axis",
      },
      {
        key: "segments",
        label: "Segments",
        min: 2,
        max: 24,
        step: 1,
        default: 6,
        showIf: (params) => params.mode === "radial",
      },
      {
        key: "centerX",
        label: "Center X",
        min: 0,
        max: 1,
        step: 0.001,
        default: 0.5,
        showIf: (params) => params.mode === "radial",
      },
      {
        key: "centerY",
        label: "Center Y",
        min: 0,
        max: 1,
        step: 0.001,
        default: 0.5,
        showIf: (params) => params.mode === "radial",
      },
      { key: "seamBlend", label: "Seam Blend", min: 0, max: 0.2, step: 0.001, default: 0.03 },
      { key: "seamWave", label: "Wave", min: 0, max: 0.08, step: 0.0005, default: 0.01 },
      { key: "seamFreq", label: "Wave Freq", min: 0.5, max: 30, step: 0.1, default: 8 },
      { key: "seamNoise", label: "Noise", min: 0, max: 1, step: 0.01, default: 0.35 },
      { key: "seamDrift", label: "Drift", min: 0, max: 2, step: 0.01, default: 0.25 },
      { key: "seamBlur", label: "Edge Blur", min: 0, max: 2, step: 0.01, default: 0.6 },
    ],
    passes: [
      {
        key: "mirror",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform vec2 uResolution;
          uniform float uMode;
          uniform float uAngle;
          uniform float uOffset;
          uniform float uBlend;
          uniform float uEdge;
          uniform float uScale;
          uniform float uNoiseType;
          uniform float uSpeed;
          uniform float uBlur;
          uniform float uSpin;
          uniform float uBlades;
          uniform vec2 uCenter;
          uniform float uTime;
          varying vec2 vUv;
          ${NOISE_GLSL}
          vec2 fxRotate(vec2 p, float a) {
            float s = sin(a);
            float c = cos(a);
            return mat2(c, -s, s, c) * p;
          }
          vec4 sampleSoft(vec2 uv, vec2 texel, float blur) {
            uv = clamp(uv, 0.0, 1.0);
            if (blur <= 0.0001) return texture2D(tDiffuse, uv);
            vec2 b = texel * blur;
            vec4 sum = texture2D(tDiffuse, uv) * 0.30;
            sum += texture2D(tDiffuse, clamp(uv + vec2(b.x, 0.0), 0.0, 1.0)) * 0.175;
            sum += texture2D(tDiffuse, clamp(uv - vec2(b.x, 0.0), 0.0, 1.0)) * 0.175;
            sum += texture2D(tDiffuse, clamp(uv + vec2(0.0, b.y), 0.0, 1.0)) * 0.175;
            sum += texture2D(tDiffuse, clamp(uv - vec2(0.0, b.y), 0.0, 1.0)) * 0.175;
            return sum;
          }
          void main() {
            vec2 texel = 1.0 / max(uResolution, vec2(1.0));
            vec4 base = texture2D(tDiffuse, vUv);
            vec4 outCol = base;
            float seamW = max(uBlend, 0.0001);
            if (uMode < 0.5) {
              vec2 center = vec2(0.5);
              float ang = radians(uAngle);
              vec2 rp = fxRotate(vUv - center, ang);
              float phase = rp.x * uScale * 6.2831853 + uTime * uSpeed;
              float wave = sin(phase) * uEdge;
              float n = fxNoise(vec2(rp.x * uScale * 2.1 + 17.0, uTime * 0.2 + rp.y * 2.0));
              wave += (n - 0.5) * 2.0 * uEdge * uNoiseType;
              float seam = clamp(uOffset + wave, -0.98, 0.98);
              float d = rp.y - seam;
              float mirrorMask = uSpin < 0.5 ? step(d, 0.0) : step(0.0, d);
              vec2 mirRp = vec2(rp.x, seam - d);
              vec2 uvMir = fxRotate(mirRp, -ang) + center;
              vec4 reflected = sampleSoft(uvMir, texel, uBlur);
              float seamMix = smoothstep(0.0, seamW, abs(d));
              vec4 mirroredCol = mix(base, reflected, seamMix);
              outCol = mix(base, mirroredCol, mirrorMask);
            } else {
              vec2 center = uCenter;
              vec2 p = vUv - center;
              float radius = length(p);
              float segs = max(2.0, floor(uBlades + 0.5));
              float sector = 6.2831853 / segs;
              float aRaw = atan(p.y, p.x) + radians(uAngle);
              float local = mod(aRaw, sector);
              float radialWave = sin(radius * uScale * 10.0 + uTime * uSpeed) * uEdge * 0.25;
              float radialNoise = (fxNoise(vec2(radius * uScale * 6.0 + 13.0, local * 3.0 + uTime * 0.15)) - 0.5)
                * 2.0 * uEdge * uNoiseType * 0.25;
              local = mod(local + radialWave + radialNoise, sector);
              float folded = abs(local - sector * 0.5);
              float seamDist = min(local, sector - local);
              vec2 uvMirror = center + vec2(cos(folded), sin(folded)) * radius;
              vec4 sharp = texture2D(tDiffuse, clamp(uvMirror, 0.0, 1.0));
              vec4 soft = sampleSoft(uvMirror, texel, uBlur);
              float seamMix = smoothstep(0.0, seamW, seamDist);
              outCol = mix(soft, sharp, seamMix);
            }
            gl_FragColor = vec4(outCol.rgb, base.a);
          }
        `,
        updateUniforms(u, params, time) {
          u.uMode.value = params.mode === "radial" ? 1 : 0;
          u.uAngle.value = params.angle;
          u.uOffset.value = params.height || 0;
          u.uBlend.value = params.seamBlend;
          u.uEdge.value = params.seamWave;
          u.uScale.value = params.seamFreq;
          u.uNoiseType.value = params.seamNoise;
          u.uSpeed.value = params.seamDrift;
          u.uBlur.value = params.seamBlur;
          u.uSpin.value = params.side === "above" ? 1 : 0;
          u.uBlades.value = params.segments || 6;
          u.uCenter.value.set(params.centerX ?? 0.5, params.centerY ?? 0.5);
          u.uTime.value = time;
        },
      },
    ],
  },
  {
    id: "displace",
    label: "UV Displacement",
    group: "Distort",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M1.5 5.5c1.2-1.6 2.4-1.6 3.6 0s2.4 1.6 3.6 0 2.4-1.6 3.6 0"/><path d="M1.5 10.5c1.2-1.6 2.4-1.6 3.6 0s2.4 1.6 3.6 0 2.4-1.6 3.6 0"/></svg>`,
    params: [
      {
        key: "pattern",
        label: "Pattern",
        type: "select",
        default: "wave",
        options: [
          { value: "wave", label: "Wave" },
          { value: "slices", label: "Slices" },
          { value: "shards", label: "Shards" },
        ],
      },
      { key: "amount", label: "Amount", min: 0, max: 0.2, step: 0.001, default: 0.03 },
      { key: "scale", label: "Scale", min: 1, max: 30, step: 0.5, default: 6 },
      { key: "angle", label: "Angle", min: 0, max: 360, step: 1, default: 0 },
      { key: "speed", label: "Speed", min: 0, max: 3, step: 0.02, default: 0.6 },
      {
        key: "edgeShape",
        label: "Edge Shape",
        type: "select",
        default: "none",
        options: [
          { value: "none", label: "None" },
          { value: "circle", label: "Circle" },
          { value: "square", label: "Square" },
        ],
      },
      { key: "edgeSoftness", label: "Edge Soft", min: 0, max: 1, step: 0.01, default: 0.35 },
    ],
    passes: [
      {
        key: "displace",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform float uAmount;
          uniform float uScale;
          uniform float uSpeed;
          uniform float uTime;
          uniform float uAngle;
          uniform float uMode;
          uniform float uEdgeShape;
          uniform float uEdgeSoftness;
          varying vec2 vUv;
          ${NOISE_GLSL}
          vec2 fxRotate(vec2 p, float a) {
            float s = sin(a);
            float c = cos(a);
            return mat2(c, -s, s, c) * p;
          }
          void main() {
            float t = mod(uTime * uSpeed * 0.2, 1000.0);
            float ang = radians(uAngle);
            vec2 p = fxRotate(vUv - 0.5, ang) + 0.5;
            vec2 offset;
            if (uMode < 0.5) {
              // Wave: clean sinusoidal ripple along the rotated axis — a
              // geometric "rippled glass" look, distinct from organic noise.
              float wave = sin(p.x * uScale * 6.2831 + t * 6.2831);
              offset = vec2(0.0, wave);
            } else if (uMode < 1.5) {
              // Slices: quantizes into discrete straight bands, each shifted
              // by a stable per-band random amount — a cut/glitch-glass look.
              float bands = max(uScale, 1.0);
              float band = floor(p.x * bands);
              float rnd = fxHash(vec2(band, floor(t * 2.0))) * 2.0 - 1.0;
              offset = vec2(0.0, rnd);
            } else {
              // Shards: Voronoi-cell based, each irregular polygon cell gets
              // one constant offset direction — shattered-glass displacement.
              vec3 cell = fxVoronoiCell(p * uScale);
              float a2 = cell.z * 6.2831 + t;
              offset = vec2(cos(a2), sin(a2));
            }
            vec2 movedP = p + offset * uAmount;
            vec2 uv = fxRotate(movedP - 0.5, -ang) + 0.5;

            float mask = 1.0;
            if (uEdgeShape > 0.5) {
              vec2 d = vUv - 0.5;
              float field = uEdgeShape < 1.5 ? length(d) * 2.0 : max(abs(d.x), abs(d.y)) * 2.0;
              float soft = max(uEdgeSoftness, 0.001);
              mask = 1.0 - smoothstep(1.0 - soft, 1.0, field);
            }
            gl_FragColor = texture2D(tDiffuse, mix(vUv, uv, mask));
          }
        `,
        updateUniforms(u, params, time) {
          u.uAmount.value = params.amount;
          u.uScale.value = params.scale;
          u.uSpeed.value = params.speed;
          u.uTime.value = time;
          u.uAngle.value = params.angle;
          u.uMode.value = params.pattern === "slices" ? 1 : params.pattern === "shards" ? 2 : 0;
          u.uEdgeShape.value = params.edgeShape === "circle" ? 1 : params.edgeShape === "square" ? 2 : 0;
          u.uEdgeSoftness.value = params.edgeSoftness;
        },
      },
    ],
  },
  {
    id: "blur",
    label: "Gaussian Blur",
    group: "Blur",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="8" cy="8" r="3" opacity="0.9"/><circle cx="8" cy="8" r="5.4" opacity="0.4"/><circle cx="8" cy="8" r="7" opacity="0.18"/></svg>`,
    params: [{ key: "radius", label: "Radius", min: 0, max: 6, step: 0.05, default: 1.4 }],
    passes: [
      {
        key: "blur",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform vec2 uResolution;
          uniform float uRadius;
          uniform vec2 uDirection;
          varying vec2 vUv;
          void main() {
            vec2 texel = 1.0 / uResolution;
            vec4 sum = vec4(0.0);
            float total = 0.0;
            for (int i = -6; i <= 6; i++) {
              float w = exp(-float(i * i) / 18.0);
              vec2 offset = uDirection * texel * float(i) * uRadius;
              sum += texture2D(tDiffuse, vUv + offset) * w;
              total += w;
            }
            gl_FragColor = sum / total;
          }
        `,
        updateUniforms(u, params) {
          u.uRadius.value = params.radius;
          u.uDirection.value.set(1, 0);
        },
      },
      {
        key: "blur",
        fragmentShader: null, // reuses the same cached material/shader as pass 0
        updateUniforms(u, params) {
          u.uRadius.value = params.radius;
          u.uDirection.value.set(0, 1);
        },
      },
    ],
  },
  {
    id: "pixelate",
    label: "Pixelate",
    group: "Effect",
    icon: `<svg viewBox="0 0 16 16" fill="currentColor"><rect x="1.5" y="1.5" width="5" height="5" opacity="0.9"/><rect x="9.5" y="1.5" width="5" height="5" opacity="0.5"/><rect x="1.5" y="9.5" width="5" height="5" opacity="0.5"/><rect x="9.5" y="9.5" width="5" height="5" opacity="0.9"/></svg>`,
    params: [{ key: "size", label: "Pixel Size", min: 1, max: 64, step: 1, default: 8 }],
    passes: [
      {
        key: "pixelate",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform vec2 uResolution;
          uniform float uSize;
          varying vec2 vUv;
          void main() {
            vec2 grid = uResolution / max(uSize, 1.0);
            vec2 uv = floor(vUv * grid) / grid + (0.5 / grid);
            gl_FragColor = texture2D(tDiffuse, uv);
          }
        `,
        updateUniforms(u, params) {
          u.uSize.value = params.size;
        },
      },
    ],
  },
  {
    id: "halftone",
    label: "Halftone",
    group: "Effect",
    icon: `<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="3" cy="3" r="1.5"/><circle cx="8" cy="3" r="1.1"/><circle cx="13" cy="3" r="1.5"/><circle cx="3" cy="8" r="1.1"/><circle cx="8" cy="8" r="1.7"/><circle cx="13" cy="8" r="1.1"/><circle cx="3" cy="13" r="1.5"/><circle cx="8" cy="13" r="1.1"/><circle cx="13" cy="13" r="1.5"/></svg>`,
    params: [
      {
        key: "shape",
        label: "Shape",
        type: "select",
        default: "circle",
        options: [
          { value: "circle", label: "Circle" },
          { value: "square", label: "Square" },
          { value: "line", label: "Line" },
          { value: "cross", label: "Cross" },
          { value: "diamond", label: "Diamond" },
        ],
      },
      { key: "dotSize", label: "Dot Size", min: 2, max: 24, step: 0.5, default: 7 },
      { key: "angle", label: "Angle", min: 0, max: 90, step: 1, default: 22 },
      {
        key: "colorMode",
        label: "Color Mode",
        type: "select",
        default: "original",
        options: [
          { value: "original", label: "Original" },
          { value: "duotone", label: "Duotone" },
          { value: "cmy", label: "CMY Print" },
        ],
      },
      { key: "inkColor", label: "Ink Color", type: "color", default: "#151515", showIf: (p) => p.colorMode === "duotone" },
      {
        key: "transparentBackground",
        label: "Transparent Background",
        type: "toggle",
        default: false,
      },
      {
        key: "paperColor",
        label: "Paper Color",
        type: "color",
        default: "#f4efe2",
        showIf: (p) => !p.transparentBackground,
      },
    ],
    passes: [
      {
        key: "halftone",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform vec2 uResolution;
          uniform float uDotSize;
          uniform float uAngle;
          uniform float uShape;
          uniform float uColorMode;
          uniform vec3 uInkColor;
          uniform vec3 uPaperColor;
          uniform float uTransparentBackground;
          varying vec2 vUv;
          float fxShapeDist(vec2 d, float shape) {
            if (shape < 0.5) return length(d);
            if (shape < 1.5) return max(abs(d.x), abs(d.y));
            if (shape < 2.5) return abs(d.y);
            if (shape < 3.5) return min(abs(d.x), abs(d.y));
            return abs(d.x) + abs(d.y);
          }
          float fxDotMask(vec2 local, float radius, float shape) {
            float dist = fxShapeDist(local, shape);
            float feather = max(0.75, radius * 0.2);
            return 1.0 - smoothstep(radius - feather, radius + feather, dist);
          }
          vec2 fxCellCenter(vec2 p, float cellSize) {
            return (floor(p / cellSize) + 0.5) * cellSize;
          }
          float fxChannelMask(vec2 pixCoord, float dotSize, float angle, float ink, float shape) {
            mat2 rot = mat2(cos(angle), -sin(angle), sin(angle), cos(angle));
            vec2 rp = rot * pixCoord;
            vec2 center = fxCellCenter(rp, dotSize);
            vec2 local = rp - center;
            float radius = clamp(ink, 0.0, 1.0) * dotSize * 0.78;
            return fxDotMask(local, radius, shape);
          }
          void main() {
            vec4 src = texture2D(tDiffuse, vUv);
            float ang = uAngle * 3.14159265 / 180.0;
            mat2 rot = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
            mat2 invRot = mat2(cos(ang), sin(ang), -sin(ang), cos(ang));
            vec2 pixCoord = vUv * uResolution;
            vec2 rotated = rot * pixCoord;
            vec2 centerRot = fxCellCenter(rotated, uDotSize);
            vec2 centerUv = clamp((invRot * centerRot) / uResolution, 0.0, 1.0);
            vec4 centerSample = texture2D(tDiffuse, centerUv);
            vec3 centerColor = centerSample.rgb;
            float centerAlpha = centerSample.a;
            float lum = dot(centerColor, vec3(0.299, 0.587, 0.114));
            // Transparent output treats alpha as ink coverage, so dots taper naturally
            // through semi-transparent source detail instead of retaining hard full-size shapes.
            float inkCoverage = (1.0 - lum) * mix(1.0, centerAlpha, uTransparentBackground);
            float radius = clamp(inkCoverage * uDotSize * 0.82, 0.0, uDotSize * 0.92);
            float mask = fxDotMask(rotated - centerRot, radius, uShape);
            vec3 result;
            float coverage = mask;
            if (uColorMode < 0.5) {
              // "Original" mode is still true dot composition: no source image is
              // shown between dots; paper tone plus dot color reconstructs the image.
              result = mix(uPaperColor, centerColor, mask);
            } else if (uColorMode < 1.5) {
              result = mix(uPaperColor, uInkColor, mask);
            } else {
              vec3 channelColor = uTransparentBackground > 0.5 ? centerColor : src.rgb;
              float channelAlpha = uTransparentBackground > 0.5 ? centerAlpha : src.a;
              float cyan = (1.0 - channelColor.r) * channelAlpha;
              float magenta = (1.0 - channelColor.g) * channelAlpha;
              float yellow = (1.0 - channelColor.b) * channelAlpha;
              float a2 = ang + 0.5236;
              float a3 = ang + 1.0472;
              float cMask = fxChannelMask(pixCoord, uDotSize, ang, cyan, uShape);
              float mMask = fxChannelMask(pixCoord, uDotSize, a2, magenta, uShape);
              float yMask = fxChannelMask(pixCoord, uDotSize, a3, yellow, uShape);
              coverage = max(cMask, max(mMask, yMask));
              result = uPaperColor;
              result = mix(result, result * vec3(0.0, 0.68, 0.94), cMask);
              result = mix(result, result * vec3(0.86, 0.0, 0.53), mMask);
              result = mix(result, result * vec3(0.98, 0.86, 0.02), yMask);
              if (uTransparentBackground > 0.5) {
                vec3 cmyInk = cMask * vec3(0.0, 0.68, 0.94)
                  + mMask * vec3(0.86, 0.0, 0.53)
                  + yMask * vec3(0.98, 0.86, 0.02);
                result = cmyInk / max(cMask + mMask + yMask, 0.0001);
              }
            }
            if (uTransparentBackground > 0.5) {
              if (uColorMode < 0.5) {
                result = centerColor;
              } else if (uColorMode < 1.5) {
                result = uInkColor;
              }
            }
            float alpha = uTransparentBackground > 0.5
              ? centerAlpha * coverage
              : src.a;
            gl_FragColor = vec4(result, alpha);
          }
        `,
        updateUniforms(u, params) {
          const shapeCodes = { circle: 0, square: 1, line: 2, cross: 3, diamond: 4 };
          u.uDotSize.value = params.dotSize;
          u.uAngle.value = params.angle;
          u.uShape.value = shapeCodes[params.shape] ?? 0;
          const modeCodes = { original: 0, duotone: 1, cmy: 2 };
          u.uColorMode.value = modeCodes[params.colorMode] ?? 0;
          u.uInkColor.value.set(...hexToRgb01(params.inkColor));
          u.uPaperColor.value.set(...hexToRgb01(params.paperColor));
          u.uTransparentBackground.value = params.transparentBackground ? 1 : 0;
        },
      },
    ],
  },
  {
    id: "oilPaint",
    label: "Oil Paint Strokes",
    group: "Effect",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M2 11c2.4-1.2 3.4-3.4 6-4.5 2-.8 3.5-.3 6 .8"/><path d="M2 8.5c2-.8 3-2.4 5-3.2 2.2-.9 4.2-.2 7 .9" opacity="0.6"/><path d="M2 13.2h12" opacity="0.35"/></svg>`,
    params: [
      {
        key: "preset",
        label: "Preset",
        type: "select",
        default: "custom",
        options: [
          { value: "custom", label: "Custom" },
          { value: "paletteKnife", label: "Palette Knife" },
          { value: "softBrush", label: "Soft Brush" },
        ],
      },
      {
        key: "brushType",
        label: "Brush Type",
        type: "select",
        default: "round",
        options: [
          { value: "round", label: "Round" },
          { value: "flat", label: "Flat" },
          { value: "fan", label: "Fan" },
          { value: "palette", label: "Palette Knife" },
        ],
      },
      { key: "brushSize", label: "Brush Size", min: 2, max: 36, step: 0.5, default: 9 },
      { key: "strokeStrength", label: "Stroke Strength", min: 0, max: 1, step: 0.01, default: 0.72 },
      { key: "detail", label: "Stroke Detail", min: 0, max: 1, step: 0.01, default: 0.55 },
      { key: "edgeBlend", label: "Edge Blend", min: 0, max: 1, step: 0.01, default: 0.6 },
      { key: "strokePresence", label: "Stroke Presence", min: 0, max: 1, step: 0.01, default: 0.65 },
      { key: "mix", label: "Blend", min: 0, max: 1, step: 0.01, default: 0.85 },
    ],
    passes: [
      {
        key: "oilPaint",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform vec2 uResolution;
          uniform float uBrushType;
          uniform float uBrushSize;
          uniform float uStrokeStrength;
          uniform float uDetail;
          uniform float uEdgeBlend;
          uniform float uStrokePresence;
          uniform float uMix;
          varying vec2 vUv;
          ${NOISE_GLSL}
          float fxLum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
          void main() {
            vec4 base = texture2D(tDiffuse, vUv);
            vec2 texel = 1.0 / max(uResolution, vec2(1.0));
            float gradR = max(1.0, uBrushSize * 0.25);
            vec2 gxOff = vec2(texel.x * gradR, 0.0);
            vec2 gyOff = vec2(0.0, texel.y * gradR);
            float lR = fxLum(texture2D(tDiffuse, clamp(vUv + gxOff, 0.0, 1.0)).rgb);
            float lL = fxLum(texture2D(tDiffuse, clamp(vUv - gxOff, 0.0, 1.0)).rgb);
            float lT = fxLum(texture2D(tDiffuse, clamp(vUv + gyOff, 0.0, 1.0)).rgb);
            float lB = fxLum(texture2D(tDiffuse, clamp(vUv - gyOff, 0.0, 1.0)).rgb);
            vec2 grad = vec2(lR - lL, lT - lB);
            float nAng = (fxHash(vUv * uResolution + vec2(11.3, 53.1)) - 0.5) * 1.2;
            vec2 dir = normalize(vec2(-grad.y, grad.x) + vec2(cos(nAng), sin(nAng)) * 0.12);
            vec2 perp = vec2(-dir.y, dir.x);

            float anis = 1.0;
            float spread = 0.35;
            if (uBrushType > 0.5 && uBrushType < 1.5) {
              anis = 1.35;
              spread = 0.26;
            } else if (uBrushType >= 1.5 && uBrushType < 2.5) {
              anis = 1.15;
              spread = 0.5;
            } else if (uBrushType >= 2.5) {
              anis = 1.75;
              spread = 0.12;
            }

            vec3 acc = vec3(0.0);
            float total = 0.0;
            const int S = 6;
            for (int i = -S; i <= S; i++) {
              float t = float(i) / float(S);
              float j = (fxHash(vUv * uResolution + vec2(float(i) * 17.7, uBrushType * 29.0)) - 0.5);
              vec2 offset = dir * (t * uBrushSize * anis) + perp * (j * uBrushSize * spread);
              vec2 uv = clamp(vUv + offset * texel, 0.0, 1.0);
              float w = exp(-t * t * (2.1 + uDetail * 1.7));
              acc += texture2D(tDiffuse, uv).rgb * w;
              total += w;
            }
            vec3 paint = acc / max(total, 1e-4);
            float levels = mix(18.0, 7.0, uStrokeStrength);
            paint = floor(paint * levels + 0.5) / levels;

            vec2 brushUv = vec2(dot(vUv, dir), dot(vUv, perp)) * (uResolution / max(uBrushSize, 1.0));
            float grain = fxFbm(brushUv * vec2(1.2 + uDetail * 1.6, 2.4 + uDetail * 3.2));
            float rib = abs(fract(brushUv.x + grain * 0.45) - 0.5) * 2.0;
            float edgeSoft = mix(0.02, 0.45, uEdgeBlend);
            float strokeMask = 1.0 - smoothstep(1.0 - edgeSoft, 1.0, rib);
            strokeMask *= smoothstep(0.2, 0.92, grain + 0.15);
            float contour = smoothstep(0.03, 0.35, length(grad) * (1.0 + uDetail * 1.3));
            float ridgeA = 1.0 - smoothstep(0.72, 1.0, rib);
            float ridgeB = 1.0 - smoothstep(0.56, 1.0, rib + grain * 0.22);
            float ridge = max(ridgeA, ridgeB * (0.72 + contour * 0.28));
            float presence = clamp(uStrokePresence, 0.0, 1.0);
            strokeMask = mix(strokeMask, max(strokeMask, ridge * (0.5 + contour * 0.5)), presence);
            strokeMask = clamp(strokeMask * mix(1.0, 1.45, presence), 0.0, 1.0);

            vec3 stylized = mix(base.rgb, paint, uStrokeStrength);
            float impasto = ridge * contour * presence;
            vec3 result = mix(base.rgb, stylized, strokeMask * uMix);
            // Slight stroke-body shading to make brush ridges read clearly
            // without breaking the natural painterly blend.
            result *= mix(vec3(1.0), vec3(0.9, 0.88, 0.84), impasto * 0.24);
            gl_FragColor = vec4(clamp(result, 0.0, 1.0), base.a);
          }
        `,
        updateUniforms(u, params) {
          const effective = {
            brushType: typeof params?.brushType === "string" ? params.brushType : "round",
            brushSize: Number.isFinite(params?.brushSize) ? params.brushSize : 9,
            strokeStrength: Number.isFinite(params?.strokeStrength) ? params.strokeStrength : 0.72,
            detail: Number.isFinite(params?.detail) ? params.detail : 0.55,
            edgeBlend: Number.isFinite(params?.edgeBlend) ? params.edgeBlend : 0.6,
            strokePresence: Number.isFinite(params?.strokePresence) ? params.strokePresence : 0.65,
            mix: Number.isFinite(params?.mix) ? params.mix : 0.85,
          };
          const brushCodes = { round: 0, flat: 1, fan: 2, palette: 3 };
          u.uBrushType.value = brushCodes[effective.brushType] ?? 0;
          u.uBrushSize.value = effective.brushSize;
          u.uStrokeStrength.value = effective.strokeStrength;
          u.uDetail.value = effective.detail;
          u.uEdgeBlend.value = effective.edgeBlend;
          u.uStrokePresence.value = effective.strokePresence;
          u.uMix.value = effective.mix;
        },
      },
    ],
  },
  {
    id: "glitch",
    label: "Glitch",
    group: "Effect",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M1.5 4h7M10 4h4.5M1.5 8h4M7 8h8M1.5 12h9.5M13 12h1.5" opacity="0.85"/></svg>`,
    params: [
      { key: "amount", label: "Amount", min: 0, max: 1, step: 0.01, default: 0.4 },
      { key: "blockSize", label: "Band Height", min: 2, max: 80, step: 1, default: 16 },
      { key: "rgbSplit", label: "RGB Split", min: 0, max: 0.05, step: 0.0005, default: 0.01 },
      { key: "jitter", label: "Jitter", min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: "speed", label: "Speed", min: 0, max: 6, step: 0.05, default: 1.2 },
    ],
    passes: [
      {
        key: "glitch",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform vec2 uResolution;
          uniform float uAmount;
          uniform float uSize;
          uniform float uChroma;
          uniform float uJitter;
          uniform float uSpeed;
          uniform float uTime;
          varying vec2 vUv;
          ${NOISE_GLSL}
          void main() {
            float bandH = max(uSize, 1.0) / uResolution.y;
            float bandIndex = floor(vUv.y / bandH);
            float timeStep = floor(uTime * uSpeed * 6.0);
            float bandRand = fxHash(vec2(bandIndex, timeStep));
            float activeMask = step(1.0 - uAmount, bandRand);
            float shift = (fxHash(vec2(bandIndex, timeStep + 91.7)) - 0.5) * 2.0 * uJitter * 0.15 * activeMask;
            vec2 uv = vec2(clamp(vUv.x + shift, 0.0, 1.0), vUv.y);

            float r = texture2D(tDiffuse, clamp(uv + vec2(uChroma, 0.0), 0.0, 1.0)).r;
            float g = texture2D(tDiffuse, uv).g;
            float b = texture2D(tDiffuse, clamp(uv - vec2(uChroma, 0.0), 0.0, 1.0)).b;
            float a = texture2D(tDiffuse, uv).a;
            gl_FragColor = vec4(r, g, b, a);
          }
        `,
        updateUniforms(u, params, time) {
          u.uAmount.value = params.amount;
          u.uSize.value = params.blockSize;
          u.uChroma.value = params.rgbSplit;
          u.uJitter.value = params.jitter;
          u.uSpeed.value = params.speed;
          u.uTime.value = time;
        },
      },
    ],
  },
  {
    id: "datamosh",
    label: "Datamosh",
    group: "Effect",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1.5" y="2" width="5" height="5" opacity="0.9"/><rect x="4" y="2" width="5" height="5" opacity="0.35"/><rect x="9.5" y="9" width="5" height="5" opacity="0.9"/><rect x="7" y="9" width="5" height="5" opacity="0.35"/></svg>`,
    params: [
      { key: "amount", label: "Amount", min: 0, max: 1, step: 0.01, default: 0.45 },
      { key: "direction", label: "Direction", min: 0, max: 360, step: 1, default: 0 },
      { key: "blockSize", label: "Block Size", min: 4, max: 96, step: 1, default: 24 },
      { key: "drag", label: "Drag Length", min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: "speed", label: "Speed", min: 0, max: 4, step: 0.05, default: 0.6 },
    ],
    passes: [
      {
        key: "datamosh",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform vec2 uResolution;
          uniform float uAmount;
          uniform float uAngle;
          uniform float uSize;
          uniform float uRandomness;
          uniform float uSpeed;
          uniform float uTime;
          varying vec2 vUv;
          ${NOISE_GLSL}
          void main() {
            float rad = uAngle * 3.14159265 / 180.0;
            vec2 dir = vec2(cos(rad), sin(rad));
            vec2 cellId = floor(vUv * uResolution / max(uSize, 1.0));
            float timeStep = floor(uTime * uSpeed * 4.0);
            float h = fxHash(cellId + timeStep * 0.37);
            float activeMask = step(1.0 - uAmount, h);
            float dragAmount = (h - 0.5) * 2.0 * uRandomness * activeMask;

            vec3 color = vec3(0.0);
            const int N = 6;
            for (int i = 0; i < N; i++) {
              float fi = float(i) / float(N - 1);
              vec2 sampleUv = clamp(vUv - dir * dragAmount * fi * 0.4, 0.0, 1.0);
              color += texture2D(tDiffuse, sampleUv).rgb;
            }
            color /= float(N);
            float alpha = texture2D(tDiffuse, clamp(vUv - dir * dragAmount * 0.4, 0.0, 1.0)).a;
            gl_FragColor = vec4(color, alpha);
          }
        `,
        updateUniforms(u, params, time) {
          u.uAmount.value = params.amount;
          u.uAngle.value = params.direction;
          u.uSize.value = params.blockSize;
          u.uRandomness.value = params.drag;
          u.uSpeed.value = params.speed;
          u.uTime.value = time;
        },
      },
    ],
  },
  {
    id: "colorVariation",
    label: "Color Variation",
    group: "Color",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M8 1.5a6.5 6.5 0 100 13c.9 0 1.3-.6 1.3-1.2 0-.3-.1-.6-.3-.8-.2-.3-.3-.6-.3-.9 0-.6.5-1.1 1.1-1.1h1.3A2.9 2.9 0 0014.5 8 6.5 6.5 0 008 1.5Z"/><circle cx="5.2" cy="6" r=".85" fill="currentColor" stroke="none"/><circle cx="8" cy="4.6" r=".85" fill="currentColor" stroke="none"/><circle cx="10.8" cy="6" r=".85" fill="currentColor" stroke="none"/><circle cx="5.6" cy="9.4" r=".85" fill="currentColor" stroke="none"/></svg>`,
    params: [
      {
        key: "blendMode",
        label: "Blend Mode",
        type: "select",
        default: "color",
        options: [
          { value: "normal", label: "Normal" },
          { value: "multiply", label: "Multiply" },
          { value: "screen", label: "Screen" },
          { value: "overlay", label: "Overlay" },
          { value: "softlight", label: "Soft Light" },
          { value: "add", label: "Add" },
          { value: "difference", label: "Difference" },
          { value: "hue", label: "Hue" },
          { value: "color", label: "Color" },
        ],
      },
      {
        key: "mode",
        label: "Mode",
        type: "select",
        default: "linear",
        options: [
          { value: "linear", label: "Linear" },
          { value: "radial", label: "Radial" },
          { value: "noise", label: "Noise" },
        ],
      },
      { key: "variation", label: "Variation", min: 0, max: 1, step: 0.01, default: 0.35 },
      { key: "strength", label: "Strength", min: 0, max: 1, step: 0.01, default: 0.35 },
      { key: "offset", label: "Range", min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: "angle", label: "Angle", min: 0, max: 360, step: 1, default: 0, showIf: (p) => p.mode === "linear" },
      { key: "radius", label: "Radius", min: 0.1, max: 1.5, step: 0.01, default: 0.7, showIf: (p) => p.mode === "radial" },
      { key: "scale", label: "Scale", min: 1, max: 20, step: 0.5, default: 4, showIf: (p) => p.mode === "noise" },
      { key: "speed", label: "Speed", min: 0, max: 2, step: 0.02, default: 0.3, showIf: (p) => p.mode === "noise" },
    ],
    passes: [
      {
        key: "colorVariation",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform float uVariation;
          uniform float uStrength;
          uniform float uOffset;
          uniform float uAngle;
          uniform float uRadius;
          uniform float uScale;
          uniform float uSpeed;
          uniform float uTime;
          uniform float uMode; // 0 linear, 1 radial, 2 noise
          uniform float uBlendMode;
          varying vec2 vUv;
          ${NOISE_GLSL}
          ${HSL_GLSL}
          vec3 fxRgb2hsl(vec3 color) {
            float high = max(color.r, max(color.g, color.b));
            float low = min(color.r, min(color.g, color.b));
            float delta = high - low;
            float hue = 0.0;
            if (delta > 0.00001) {
              if (high == color.r) hue = mod((color.g - color.b) / delta, 6.0);
              else if (high == color.g) hue = (color.b - color.r) / delta + 2.0;
              else hue = (color.r - color.g) / delta + 4.0;
              hue *= 60.0;
              if (hue < 0.0) hue += 360.0;
            }
            float lightness = (high + low) * 0.5;
            float saturation = delta < 0.00001 ? 0.0 : delta / max(1.0 - abs(2.0 * lightness - 1.0), 0.00001);
            return vec3(hue, saturation, lightness);
          }
          vec3 fxColorVariationBlend(vec3 base, vec3 source, float mode) {
            if (mode < 0.5) return source;
            if (mode < 1.5) return base * source;
            if (mode < 2.5) return 1.0 - (1.0 - base) * (1.0 - source);
            if (mode < 3.5) return mix(2.0 * base * source, 1.0 - 2.0 * (1.0 - base) * (1.0 - source), step(0.5, base));
            if (mode < 4.5) {
              vec3 low = 2.0 * base * source + base * base * (1.0 - 2.0 * source);
              vec3 high = sqrt(max(base, vec3(0.0))) * (2.0 * source - 1.0) + 2.0 * base * (1.0 - source);
              return mix(low, high, step(0.5, source));
            }
            if (mode < 5.5) return min(base + source, 1.0);
            if (mode < 6.5) return abs(base - source);
            if (mode < 7.5) {
              vec3 baseHsl = fxRgb2hsl(base);
              vec3 sourceHsl = fxRgb2hsl(source);
              return fxHsl2rgb(vec3(sourceHsl.x, baseHsl.y, baseHsl.z));
            }
            return fxSetLum(source, fxLum(base));
          }
          void main() {
            vec4 base = texture2D(tDiffuse, vUv);
            float field;
            if (uMode < 0.5) {
              // Linear: hue sweeps along a freely rotatable axis instead of
              // always the horizontal (vUv.x) axis.
              float rad = uAngle * 3.14159265 / 180.0;
              vec2 dir = vec2(cos(rad), sin(rad));
              field = clamp(dot(vUv - 0.5, dir) * 2.0, -1.0, 1.0);
            } else if (uMode < 1.5) {
              // Radial: hue sweeps outward from the center within Radius,
              // then holds the outermost hue beyond that distance.
              float d = length(vUv - 0.5) * 1.41421356;
              field = clamp(d / max(uRadius, 0.001) * 2.0 - 1.0, -1.0, 1.0);
            } else {
              // Noise: hue follows an organic drifting fbm field instead of
              // any fixed geometric gradient — genuinely unpredictable.
              vec2 t = vec2(mod(uTime * uSpeed * 0.15, 1000.0));
              field = fxFbm(vUv * uScale + t) * 2.0 - 1.0;
            }
            float center = mod(210.0 + uOffset * 360.0, 360.0);
            float halfSpan = uVariation * 120.0;
            float hue = mod(center + halfSpan * field + 360.0, 360.0);
            float t2 = 1.0 - abs(field);
            float sat = 0.85 + 0.05 * t2;
            vec3 source = fxHsl2rgb(vec3(hue, sat, 0.5));
            vec3 blended = fxColorVariationBlend(base.rgb, source, uBlendMode);
            vec3 result = mix(base.rgb, blended, clamp(uStrength, 0.0, 1.0));
            gl_FragColor = vec4(result, base.a);
          }
        `,
        updateUniforms(u, params, time) {
          u.uVariation.value = params.variation;
          u.uStrength.value = params.strength;
          u.uOffset.value = params.offset;
          u.uAngle.value = params.angle;
          u.uRadius.value = params.radius;
          u.uScale.value = params.scale;
          u.uSpeed.value = params.speed;
          u.uTime.value = time;
          u.uMode.value = params.mode === "radial" ? 1 : params.mode === "noise" ? 2 : 0;
          const blendModeCodes = { normal: 0, multiply: 1, screen: 2, overlay: 3, softlight: 4, add: 5, difference: 6, hue: 7, color: 8 };
          u.uBlendMode.value = blendModeCodes[params.blendMode] ?? 8;
        },
      },
    ],
  },
  {
    id: "gradientMap",
    label: "Gradient Map",
    group: "Color",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1.5" y="4" width="13" height="8" rx="1.5"/><path d="M4.7 4v8M8 4v8M11.3 4v8" opacity="0.55"/></svg>`,
    params: [
      {
        key: "gradient",
        label: "Gradient",
        type: "gradient",
        default: {
          stops: [
            { t: 0, color: "#0b1e3d" },
            { t: 0.5, color: "#7a3ba3" },
            { t: 1, color: "#ffcf6b" },
          ],
        },
      },
      { key: "contrast", label: "Contrast", min: -1, max: 1, step: 0.01, default: 0 },
      { key: "invert", label: "Invert", type: "toggle", default: false },
      { key: "protectAlpha", label: "Protect alpha", type: "toggle", default: true },
      { key: "mix", label: "Mix", min: 0, max: 1, step: 0.01, default: 0.85 },
    ],
    passes: [
      {
        key: "gradientMap",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform vec4 uGradStops[${GRADIENT_MAX_STOPS}];
          uniform float uGradCount;
          uniform float uContrast;
          uniform float uInvert;
          uniform float uProtectAlpha;
          uniform float uMix;
          varying vec2 vUv;
          ${HSL_GLSL}
          ${GRADIENT_GLSL}
          void main() {
            vec4 base = texture2D(tDiffuse, vUv);
            if (uProtectAlpha > 0.5 && base.a <= 0.00001) {
              gl_FragColor = vec4(0.0);
              return;
            }
            float lum = fxLum(base.rgb);
            lum = clamp((lum - 0.5) * (1.0 + uContrast * 2.0) + 0.5, 0.0, 1.0);
            if (uInvert > 0.5) lum = 1.0 - lum;
            vec3 mapped = fxGradientEval(lum, uGradStops, int(uGradCount));
            vec3 result = mix(base.rgb, mapped, clamp(uMix, 0.0, 1.0));
            gl_FragColor = vec4(result, base.a);
          }
        `,
        updateUniforms(u, params) {
          const { stops, count } = gradientToUniformArray(params.gradient);
          for (let i = 0; i < stops.length; i++) {
            u.uGradStops.value[i].set(stops[i][0], stops[i][1], stops[i][2], stops[i][3]);
          }
          u.uGradCount.value = count;
          u.uContrast.value = params.contrast;
          u.uInvert.value = params.invert ? 1 : 0;
          u.uProtectAlpha.value = params.protectAlpha ? 1 : 0;
          u.uMix.value = params.mix;
        },
      },
    ],
  },
  {
    id: "uvNoise",
    label: "UV Noise",
    group: "Distort",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="4.5" cy="5" r="1.6"/><circle cx="11" cy="4.5" r="1.1"/><circle cx="10" cy="10.5" r="2"/><circle cx="4" cy="11" r="1.2"/></svg>`,
    params: [
      {
        key: "noiseType",
        label: "Noise Type",
        type: "select",
        default: "cloud",
        options: NOISE_TYPE_OPTIONS,
      },
      { key: "amount", label: "Amount", min: 0, max: 0.15, step: 0.001, default: 0.035 },
      { key: "scale", label: "Scale", min: 1, max: 30, step: 0.5, default: 5 },
      { key: "speed", label: "Speed", min: 0, max: 3, step: 0.02, default: 0.4 },
    ],
    passes: [
      {
        key: "uvNoise",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform float uAmount;
          uniform float uScale;
          uniform float uSpeed;
          uniform float uTime;
          uniform float uNoiseType;
          varying vec2 vUv;
          ${NOISE_GLSL}
          void main() {
            vec2 t = vec2(mod(uTime * uSpeed * 0.15, 1000.0));
            vec2 p1 = vUv * uScale + t;
            vec2 p2 = vUv * uScale + t + vec2(17.0, 5.0);
            float n1 = fxNoiseSample(p1, uNoiseType);
            float n2 = fxNoiseSample(p2, uNoiseType);
            vec2 offset = (vec2(n1, n2) - 0.5) * uAmount;
            gl_FragColor = texture2D(tDiffuse, vUv + offset);
          }
        `,
        updateUniforms(u, params, time) {
          u.uAmount.value = params.amount;
          u.uScale.value = params.scale;
          u.uSpeed.value = params.speed;
          u.uTime.value = time;
          u.uNoiseType.value = noiseTypeCode(params.noiseType);
        },
      },
    ],
  },
  {
    id: "radialDistort",
    label: "UV Radial Distort",
    group: "Distort",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="8" cy="8" r="2"/><circle cx="8" cy="8" r="5.5" opacity="0.55"/><path d="M8 2.5v2.2M8 11.3v2.2M2.5 8h2.2M11.3 8h2.2" opacity="0.8"/></svg>`,
    params: [
      { key: "bulge", label: "Bulge (Expand)", min: 0, max: 0.6, step: 0.005, default: 0.18 },
      { key: "pinch", label: "Pinch (Shrink)", min: 0, max: 0.6, step: 0.005, default: 0 },
      { key: "useCurve", label: "Use Curve", type: "toggle", default: false },
      {
        key: "curve",
        label: "Curve",
        type: "curve",
        showIf: "useCurve",
        default: {
          points: [
            { x: 0, y: 0, type: "bezier" },
            { x: 0.5, y: 0.5, type: "bezier" },
            { x: 1, y: 1, type: "bezier" },
          ],
        },
      },
    ],
    passes: [
      {
        key: "radialDistort",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform float uBulge;
          uniform float uPinch;
          uniform float uUseCurve;
          uniform vec4 uCurvePoints[${CURVE_MAX_POINTS}];
          uniform vec4 uCurveTans[${CURVE_MAX_POINTS}];
          uniform float uCurveCount;
          varying vec2 vUv;
          ${CURVE_GLSL}
          void main() {
            vec2 center = vec2(0.5);
            vec2 dir = vUv - center;
            float dist = clamp(length(dir) / 0.70710678, 0.0, 1.0);
            float curveShaped = fxCurveEval(dist, uCurvePoints, uCurveTans, int(uCurveCount));
            float shaped = mix(dist, curveShaped, uUseCurve);
            float amount = uBulge - uPinch;
            vec2 uv = center + dir * (1.0 + amount * shaped);
            gl_FragColor = texture2D(tDiffuse, uv);
          }
        `,
        updateUniforms(u, params) {
          u.uBulge.value = params.bulge;
          u.uPinch.value = params.pinch;
          u.uUseCurve.value = params.useCurve ? 1 : 0;
          const { points, tans, count } = curveToUniformArray(params.curve);
          for (let i = 0; i < points.length; i++) {
            u.uCurvePoints.value[i].set(points[i][0], points[i][1], points[i][2], points[i][3]);
            u.uCurveTans.value[i].set(tans[i][0], tans[i][1], tans[i][2], tans[i][3]);
          }
          u.uCurveCount.value = count;
        },
      },
    ],
  },
  {
    id: "imageDisplace",
    label: "UV Image Displacement",
    group: "Distort",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1.6" y="2.5" width="12.8" height="9" rx="1.2"/><path d="M1.6 9.3l3.4-3 2.6 2.4 2-2.2 3.8 3.5" stroke-linejoin="round"/><circle cx="5.3" cy="5.3" r="1" fill="currentColor" stroke="none"/></svg>`,
    params: [
      { key: "image", label: "Map", type: "image", default: null },
      { key: "amount", label: "Amount", min: 0, max: 0.2, step: 0.001, default: 0.05 },
    ],
    passes: [
      {
        key: "imageDisplace",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform sampler2D tImage;
          uniform float uAmount;
          uniform float uHasImage;
          varying vec2 vUv;
          void main() {
            vec2 offset = vec2(0.0);
            if (uHasImage > 0.5) {
              vec4 dmap = texture2D(tImage, vUv);
              offset = (dmap.rg - 0.5) * uAmount;
            }
            gl_FragColor = texture2D(tDiffuse, vUv + offset);
          }
        `,
        updateUniforms(u, params, time, ctx) {
          u.uAmount.value = params.amount;
          const tex = ctx && ctx.compositor ? ctx.compositor.getInstanceTexture(ctx.instance) : null;
          u.tImage.value = tex;
          u.uHasImage.value = tex ? 1 : 0;
        },
      },
    ],
  },
  {
    id: "derivativeUv",
    label: "UV from Derivative",
    group: "Distort",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M2 11.5c2-5.8 4-5.8 6 0s4 5.8 6 0"/><path d="M2.3 4.5h4.4M4.5 2.3v4.4" opacity="0.65"/></svg>`,
    params: [
      { key: "amount", label: "Distortion", min: 0, max: 0.12, step: 0.001, default: 0.025 },
      { key: "sampleRadius", label: "Derivative Scale", min: 0.25, max: 12, step: 0.25, default: 1.5 },
      { key: "contrast", label: "Gradient Contrast", min: 0, max: 5, step: 0.05, default: 1.25 },
      { key: "angle", label: "Direction", min: 0, max: 360, step: 1, default: 0 },
      { key: "penetrate", label: "Displacement Map", type: "toggle", default: false },
    ],
    passes: [
      {
        key: "derivativeUv",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform vec2 uResolution;
          uniform float uAmount;
          uniform float uSampleRadius;
          uniform float uContrast;
          uniform float uAngle;
          uniform sampler2D tPenetrationSource;
          uniform float uPenetrate;
          varying vec2 vUv;
          vec2 fxDerivativeData(vec2 uv) {
            vec4 sampleColor = texture2D(tDiffuse, clamp(uv, 0.0, 1.0));
            return vec2(dot(sampleColor.rgb, vec3(0.299, 0.587, 0.114)), sampleColor.a);
          }
          void main() {
            vec2 texel = uSampleRadius / uResolution;
            // The source is converted to luminance only for calculating the
            // derivative; the distorted sample remains the original color image.
            vec2 right = fxDerivativeData(vUv + vec2(texel.x, 0.0));
            vec2 left = fxDerivativeData(vUv - vec2(texel.x, 0.0));
            vec2 top = fxDerivativeData(vUv + vec2(0.0, texel.y));
            vec2 bottom = fxDerivativeData(vUv - vec2(0.0, texel.y));
            float colorDx = (right.x - left.x) * max(right.y, left.y);
            float colorDy = (top.x - bottom.x) * max(top.y, bottom.y);
            float alphaDx = (right.y - left.y) * 0.5;
            float alphaDy = (top.y - bottom.y) * 0.5;
            // Alpha contributes only when it describes a stronger contour than
            // visible color, preserving the prior opaque-image response.
            float dx = abs(colorDx) >= abs(alphaDx) ? colorDx : alphaDx;
            float dy = abs(colorDy) >= abs(alphaDy) ? colorDy : alphaDy;
            float radians = uAngle * 3.14159265 / 180.0;
            mat2 rotation = mat2(cos(radians), -sin(radians), sin(radians), cos(radians));
            vec2 derivativeUv = rotation * vec2(dx, dy) * uContrast;
            vec2 distortedUv = clamp(vUv + derivativeUv * uAmount, 0.0, 1.0);
            vec4 outputColor = texture2D(tDiffuse, distortedUv);
            if (uPenetrate > 0.5) outputColor = texture2D(tPenetrationSource, distortedUv);
            gl_FragColor = outputColor;
          }
        `,
        updateUniforms(u, params, time, context) {
          u.uAmount.value = params.amount;
          u.uSampleRadius.value = params.sampleRadius;
          u.uContrast.value = params.contrast;
          u.uAngle.value = params.angle;
          u.tPenetrationSource.value = context?.penetrationSource || null;
          u.uPenetrate.value = params.penetrate ? 1 : 0;
        },
      },
    ],
  },
  {
    id: "polarize",
    label: "Polarize",
    group: "Distort",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2v12" opacity="0.5"/><path d="M4 4.5c1.4 2.2 1.4 5.4 0 7.6M12 4.5c-1.4 2.2-1.4 5.4 0 7.6" opacity="0.6"/></svg>`,
    params: [
      { key: "amount", label: "Amount", min: 0, max: 1, step: 0.01, default: 1 },
      { key: "spin", label: "Spin", min: 0, max: 360, step: 1, default: 0 },
      { key: "blur", label: "Blur", min: 0, max: 0.06, step: 0.001, default: 0 },
      { key: "blend", label: "Blend (Seam)", min: 0, max: 0.08, step: 0.001, default: 0.02 },
    ],
    passes: [
      {
        key: "polarize",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform float uAmount;
          uniform float uSpin;
          uniform float uBlur;
          uniform float uBlend;
          varying vec2 vUv;
          #define FX_PI 3.14159265
          void main() {
            vec2 center = vec2(0.5);
            vec2 dir = vUv - center;
            float r = length(dir) / 0.70710678;
            float a = atan(dir.y, dir.x) / (2.0 * FX_PI) + 0.5 + uSpin / 360.0;
            float rr = clamp(r, 0.0, 1.0);
            // Only blur near the angular wrap seam (a=0 / a=1) instead of the whole image:
            // measure how close this pixel's angle is to the seam, then fade the extra
            // blur band down to 0 away from it.
            float seamWidth = max(uBlend, 0.0001);
            float distToSeam = min(a, 1.0 - a);
            float seamMask = 1.0 - smoothstep(0.0, seamWidth, distToSeam);
            float band = max(uBlur + seamMask * seamWidth, 0.0001);
            vec4 sum = vec4(0.0);
            float total = 0.0;
            const int N = 6;
            for (int i = -N; i <= N; i++) {
              float t = float(i) / float(N);
              float w = exp(-t * t * 2.0);
              float ax = fract(a + t * band);
              vec2 polarUv = vec2(ax, rr);
              vec2 uv = mix(vUv, polarUv, clamp(uAmount, 0.0, 1.0));
              sum += texture2D(tDiffuse, clamp(uv, 0.0, 1.0)) * w;
              total += w;
            }
            gl_FragColor = sum / max(total, 1e-4);
          }
        `,
        updateUniforms(u, params) {
          u.uAmount.value = params.amount;
          u.uSpin.value = params.spin;
          u.uBlur.value = params.blur;
          u.uBlend.value = params.blend;
        },
      },
    ],
  },
  {
    id: "glassDistort",
    label: "Glass Distort",
    group: "Distort",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1.8" y="1.8" width="5.4" height="5.4" rx="0.6"/><rect x="8.8" y="1.8" width="5.4" height="5.4" rx="0.6" opacity="0.65"/><rect x="1.8" y="8.8" width="5.4" height="5.4" rx="0.6" opacity="0.65"/><rect x="8.8" y="8.8" width="5.4" height="5.4" rx="0.6" opacity="0.35"/></svg>`,
    params: [
      {
        key: "pattern",
        label: "Pattern",
        type: "select",
        default: "blocks",
        options: [
          { value: "blocks", label: "Blocks" },
          { value: "fluted", label: "Fluted" },
          { value: "hex", label: "Hex" },
          { value: "ripple", label: "Ripple" },
          { value: "bubbles", label: "Bubbles" },
        ],
      },
      { key: "scale", label: "Scale", min: 1, max: 40, step: 0.5, default: 8 },
      { key: "angle", label: "Angle", min: 0, max: 360, step: 1, default: 0 },
      { key: "refraction", label: "Refraction", min: 0, max: 0.3, step: 0.001, default: 0.06 },
      { key: "roughness", label: "Roughness (Frost)", min: 0, max: 1, step: 0.01, default: 0.35 },
      { key: "edgeGlint", label: "Edge Glint", min: 0, max: 1, step: 0.01, default: 0.4 },
      { key: "chroma", label: "Edge Chroma", min: 0, max: 0.05, step: 0.0005, default: 0.006 },
      { key: "speed", label: "Speed", min: 0, max: 2, step: 0.02, default: 0.15 },
    ],
    passes: [
      {
        key: "glassDistort",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform float uAmount;
          uniform float uScale;
          uniform float uAngle;
          uniform float uSpeed;
          uniform float uTime;
          uniform float uMode;
          uniform float uRoughness;
          uniform float uEdge;
          uniform float uChroma;
          varying vec2 vUv;
          ${NOISE_GLSL}
          vec2 fxRotate(vec2 p, float a) {
            float s = sin(a);
            float c = cos(a);
            return mat2(c, -s, s, c) * p;
          }
          // Organic frosted-bubble lattice: like fxVoronoiCell but also returns
          // the vector FROM the fragment TO its nearest bubble center, so each
          // bubble can act as its own tiny lens (used only by this filter).
          vec3 fxBubbleCell(vec2 p) {
            vec2 ip = floor(p);
            vec2 fp = fract(p);
            float minDist = 8.0;
            vec2 bestDiff = vec2(0.0);
            float bestId = 0.0;
            for (int y = -1; y <= 1; y++) {
              for (int x = -1; x <= 1; x++) {
                vec2 neighbor = vec2(float(x), float(y));
                vec2 point = fxHash2(ip + neighbor);
                vec2 diff = neighbor + point - fp;
                float d = length(diff);
                if (d < minDist) {
                  minDist = d;
                  bestDiff = diff;
                  bestId = fxHash(ip + neighbor);
                }
              }
            }
            return vec3(bestDiff, bestId);
          }
          void main() {
            float t = mod(uTime * uSpeed * 0.15, 1000.0);
            float ang = radians(uAngle);
            vec2 p = fxRotate(vUv - 0.5, ang) + 0.5;
            vec2 offset = vec2(0.0);
            float edgeFactor = 0.0;

            if (uMode < 0.5) {
              // Blocks: rectangular glass-pane lenslets, each pulling the
              // image toward its own tile center like real pressed glass.
              vec2 cellLocal = fract(p * uScale) - 0.5;
              offset = cellLocal * uAmount * 2.4;
              edgeFactor = smoothstep(0.55, 0.98, max(abs(cellLocal.x), abs(cellLocal.y)) * 2.0);
            } else if (uMode < 1.5) {
              // Fluted: vertical reeded ribs, each a thin cylindrical lens —
              // distinct from Blocks by only bending along one local axis.
              float ribLocal = fract(p.x * uScale) - 0.5;
              offset = vec2(sin(ribLocal * 3.14159265), 0.0) * uAmount * 2.6;
              edgeFactor = 1.0 - smoothstep(0.0, 0.1, abs(abs(ribLocal) - 0.5));
            } else if (uMode < 2.5) {
              // Hex: hexagonal glass tiles via a two-row staggered lattice.
              vec2 s = vec2(1.0, 1.7320508);
              vec2 hp = p * uScale;
              vec2 c1 = (floor(hp / s) + 0.5) * s;
              vec2 c2 = (floor((hp - s * 0.5) / s) + 0.5) * s + s * 0.5;
              vec2 d1 = hp - c1;
              vec2 d2 = hp - c2;
              vec2 cellLocal = dot(d1, d1) < dot(d2, d2) ? d1 : d2;
              offset = cellLocal * uAmount * 2.2;
              edgeFactor = smoothstep(0.4, 0.62, length(cellLocal));
            } else if (uMode < 3.5) {
              // Ripple: concentric rain-glass rings radiating from center.
              vec2 c = p - 0.5;
              float dist = length(c);
              float ring = sin(dist * uScale * 6.2831 - t * 6.2831);
              vec2 dir = c / max(dist, 1e-4);
              offset = dir * ring * uAmount * 1.6;
              edgeFactor = abs(ring);
            } else {
              // Bubbles: organic frosted-glass blobs, each its own lens.
              vec2 bp = p * uScale + t * 0.2;
              vec3 cell = fxBubbleCell(bp);
              offset = cell.xy * uAmount * 2.0;
              edgeFactor = smoothstep(0.55, 1.0, length(cell.xy));
            }

            vec2 movedP = p + offset;
            vec2 baseUv = fxRotate(movedP - 0.5, -ang) + 0.5;

            // Frosted roughness: average several taps spun around baseUv at
            // the golden angle so the scatter reads as soft milky diffusion
            // instead of a directional smear.
            vec3 color = vec3(0.0);
            float alpha = texture2D(tDiffuse, clamp(baseUv, 0.0, 1.0)).a;
            float rough = uRoughness * 0.05;
            const int TAP_COUNT = 6;
            for (int i = 0; i < TAP_COUNT; i++) {
              float fi = float(i);
              float sa = fi * 2.39996 + t * 2.0;
              float tapLen = rough * (0.35 + 0.65 * fract(fi * 0.618));
              vec2 tapUv = clamp(baseUv + vec2(cos(sa), sin(sa)) * tapLen, 0.0, 1.0);

              // Per-channel chromatic split, boosted near cell/rib edges for
              // the dispersive glint real glass seams show under light.
              float chroma = uChroma * (0.3 + edgeFactor * 1.4);
              vec2 dirC = normalize(tapUv - 0.5 + 1e-4);
              float r = texture2D(tDiffuse, clamp(tapUv + dirC * chroma, 0.0, 1.0)).r;
              float g = texture2D(tDiffuse, tapUv).g;
              float b = texture2D(tDiffuse, clamp(tapUv - dirC * chroma, 0.0, 1.0)).b;
              color += vec3(r, g, b);
            }
            color /= float(TAP_COUNT);

            // Edge glint: a soft white highlight along cell/rib boundaries,
            // like light catching the ground seam of real glass panes.
            color += vec3(1.0) * edgeFactor * uEdge * 0.5;

            gl_FragColor = vec4(color, alpha);
          }
        `,
        updateUniforms(u, params, time) {
          u.uScale.value = params.scale;
          u.uAngle.value = params.angle;
          u.uAmount.value = params.refraction;
          u.uRoughness.value = params.roughness;
          u.uEdge.value = params.edgeGlint;
          u.uChroma.value = params.chroma;
          u.uSpeed.value = params.speed;
          u.uTime.value = time;
          u.uMode.value =
            params.pattern === "fluted" ? 1
            : params.pattern === "hex" ? 2
            : params.pattern === "ripple" ? 3
            : params.pattern === "bubbles" ? 4
            : 0;
        },
      },
    ],
  },
  {
    id: "causticEffect",
    label: "Caustic Refraction",
    group: "Distort",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1.7 10.8c1.1-2 2.2-2.8 3.3-2.5 1.1.3 1.8 1.3 2.7 1.3 1.1 0 1.8-1.7 3-1.9 1-.2 2 .6 3.6 2.4"/><path d="M2.2 6.1c1-1.4 1.9-2 2.9-1.8 1 .2 1.6 1 2.5 1 1 0 1.7-1.3 2.7-1.5 1-.2 1.9.3 3.5 1.8" opacity="0.7"/><path d="M3.1 13.7h9.8" opacity="0.35"/></svg>`,
    params: [
      { key: "angle", label: "Flow Angle", min: 0, max: 360, step: 1, default: 24 },
      { key: "scale", label: "Scale", min: 0, max: 32, step: 0.5, default: 10 },
      { key: "distortion", label: "Distortion", min: 0, max: 3, step: 0.01, default: 1 },
      { key: "refraction", label: "Refraction", min: 0, max: 0.2, step: 0.001, default: 0.03 },
      { key: "steps", label: "Steps", min: 1, max: 12, step: 1, default: 5 },
      { key: "focus", label: "Focus", min: 0.5, max: 3, step: 0.01, default: 1.45 },
      { key: "shimmer", label: "Shimmer", min: 0, max: 1, step: 0.01, default: 0.45 },
      { key: "speed", label: "Speed", min: 0, max: 2, step: 0.02, default: 0.4 },
      { key: "chroma", label: "Dispersion", min: 0, max: 0.03, step: 0.0005, default: 0.004 },
    ],
    passes: [
      {
        key: "causticEffect",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform vec2 uResolution;
          uniform float uAmount;
          uniform float uScale;
          uniform float uAngle;
          uniform float uSpeed;
          uniform float uTime;
          uniform float uFrequency;
          uniform float uJitter;
          uniform float uFalloff;
          uniform float uChroma;
          uniform float uSteps;
          varying vec2 vUv;
          ${NOISE_GLSL}
          vec2 fxRotate(vec2 p, float a) {
            float s = sin(a);
            float c = cos(a);
            return mat2(c, -s, s, c) * p;
          }
          float fxCausticField(vec2 p, float t) {
            vec2 q = fxRotate(p * uScale, radians(uAngle));
            q += vec2(t * (0.32 + uJitter * 0.18), -t * (0.24 + uJitter * 0.14));
            vec2 warp = vec2(
              fxFbm(q * 0.38 + vec2(1.7, 9.2)),
              fxFbm(q * 0.38 + vec2(8.3, 2.8))
            ) - 0.5;
            q += warp * (uFalloff * (0.7 + uJitter * 1.8));
            float a = sin(q.x * 1.85 + fxDomainWarp(q * 0.32 + vec2(2.1, 0.7)) * 4.4 + t * 0.85);
            float b = sin(q.y * -2.25 + fxDomainWarp(q * 0.29 + vec2(6.4, 3.7)) * 3.8 - t * 1.05);
            float c = sin((q.x + q.y) * 1.28 + fxFbm(q * 0.47 + vec2(4.8, 6.2)) * 5.2 + t * 0.58);
            return a + b + 0.65 * c;
          }
          void main() {
            float aspect = uResolution.x / max(uResolution.y, 1.0);
            vec2 p = (vUv - 0.5) * vec2(aspect, 1.0);
            float speed = max(uSpeed, 0.0);
            float t = speed < 1e-4 ? 0.0 : mod(uTime * speed * 0.9, 1000.0);
            float eps = 0.018;

            float f = fxCausticField(p, t);
            float fx = fxCausticField(p + vec2(eps, 0.0), t) - fxCausticField(p - vec2(eps, 0.0), t);
            float fy = fxCausticField(p + vec2(0.0, eps), t) - fxCausticField(p - vec2(0.0, eps), t);
            vec2 grad = vec2(fx, fy) / (2.0 * eps);

            float focus = clamp(uFrequency, 0.2, 4.0);
            float ridge = exp(-abs(f) * (3.5 + focus * 4.5));

            vec2 offset = grad * uAmount * (0.006 + ridge * 0.028);
            offset.x /= aspect;

            vec2 tangent = normalize(vec2(-grad.y, grad.x) + vec2(1e-5));
            tangent.x /= aspect;
            float spread = uAmount * (0.4 + ridge * (0.8 + 1.2 * uJitter));
            vec2 uv0 = clamp(vUv + offset, 0.0, 1.0);
            vec2 chromaDir = normalize(offset + vec2(1e-5));
            float dispersion = uChroma * (0.25 + ridge * 1.6);

            vec3 sum = vec3(0.0);
            float total = 0.0;
            const int MAX_TAPS = 12;
            int taps = int(clamp(floor(uSteps + 0.5), 1.0, float(MAX_TAPS)));
            for (int i = -MAX_TAPS; i <= MAX_TAPS; i++) {
              if (abs(i) > taps) continue;
              float fi = float(i);
              float w = exp(-fi * fi * (0.24 + focus * 0.06));
              vec2 tapUv = clamp(uv0 + tangent * fi * spread, 0.0, 1.0);
              float r = texture2D(tDiffuse, clamp(tapUv + chromaDir * dispersion, 0.0, 1.0)).r;
              float g = texture2D(tDiffuse, tapUv).g;
              float b = texture2D(tDiffuse, clamp(tapUv - chromaDir * dispersion, 0.0, 1.0)).b;
              sum += vec3(r, g, b) * w;
              total += w;
            }

            vec3 color = sum / max(total, 1e-4);
            gl_FragColor = vec4(color, texture2D(tDiffuse, uv0).a);
          }
        `,
        updateUniforms(u, params, time) {
          const speed = Number.isFinite(params.speed) ? params.speed : 0.4;
          const steps = Number.isFinite(params.steps) ? params.steps : 5;
          const distortion = Number.isFinite(params.distortion) ? params.distortion : 1;
          u.uAngle.value = params.angle;
          u.uScale.value = params.scale;
          u.uAmount.value = params.refraction;
          u.uFrequency.value = params.focus;
          u.uJitter.value = params.shimmer;
          u.uFalloff.value = distortion;
          u.uSpeed.value = speed;
          u.uSteps.value = steps;
          u.uChroma.value = params.chroma;
          u.uTime.value = time;
        },
      },
    ],
  },
  {
    id: "lensDistort",
    label: "Lens Distortion",
    group: "Distort",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="8" cy="8" r="6.2"/><path d="M8 1.8c2.6 2.4 2.6 10 0 12.4M8 1.8c-2.6 2.4-2.6 10 0 12.4" opacity="0.6"/></svg>`,
    params: [
      { key: "amount", label: "Amount", min: -1, max: 1, step: 0.01, default: 0.35 },
      { key: "falloff", label: "Edge Falloff", min: 0.3, max: 3, step: 0.05, default: 1.2 },
      { key: "chroma", label: "Edge Chroma", min: 0, max: 0.05, step: 0.0005, default: 0.008 },
    ],
    passes: [
      {
        key: "lensDistort",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform float uAmount;
          uniform float uFalloff;
          uniform float uChroma;
          varying vec2 vUv;
          vec2 fxLensUv(vec2 uv, float amt, float falloff) {
            vec2 c = uv - 0.5;
            float r2 = dot(c, c);
            float distortion = 1.0 + amt * pow(r2, falloff);
            return c * distortion + 0.5;
          }
          void main() {
            vec2 uvR = fxLensUv(vUv, uAmount + uChroma * 4.0, uFalloff);
            vec2 uvG = fxLensUv(vUv, uAmount, uFalloff);
            vec2 uvB = fxLensUv(vUv, uAmount - uChroma * 4.0, uFalloff);
            float r = texture2D(tDiffuse, clamp(uvR, 0.0, 1.0)).r;
            float g = texture2D(tDiffuse, clamp(uvG, 0.0, 1.0)).g;
            float b = texture2D(tDiffuse, clamp(uvB, 0.0, 1.0)).b;
            float a = texture2D(tDiffuse, clamp(uvG, 0.0, 1.0)).a;
            gl_FragColor = vec4(r, g, b, a);
          }
        `,
        updateUniforms(u, params) {
          u.uAmount.value = params.amount;
          u.uFalloff.value = params.falloff;
          u.uChroma.value = params.chroma;
        },
      },
    ],
  },
  {
    id: "waveDistort",
    label: "Wave Distort",
    group: "Distort",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M1.5 5.5c1.4-2 2.8-2 4.2 0s2.8 2 4.2 0 2.8-2 4.2 0" /><path d="M1.5 10.5c1.4-2 2.8-2 4.2 0s2.8 2 4.2 0 2.8-2 4.2 0" opacity="0.5"/></svg>`,
    params: [
      { key: "amplitude", label: "Amplitude", min: 0, max: 0.2, step: 0.002, default: 0.03 },
      { key: "frequency", label: "Frequency", min: 0.5, max: 40, step: 0.5, default: 8 },
      { key: "angle", label: "Angle", min: 0, max: 360, step: 1, default: 0 },
      { key: "speed", label: "Speed", min: 0, max: 3, step: 0.02, default: 0.5 },
      {
        key: "axis",
        label: "Axis",
        type: "select",
        default: "both",
        options: [
          { value: "horizontal", label: "Horizontal" },
          { value: "vertical", label: "Vertical" },
          { value: "both", label: "Both" },
        ],
      },
    ],
    passes: [
      {
        key: "waveDistort",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform float uAmount;
          uniform float uFrequency;
          uniform float uAngle;
          uniform float uSpeed;
          uniform float uTime;
          uniform float uMode;
          varying vec2 vUv;
          vec2 fxRotate(vec2 p, float a) {
            float s = sin(a);
            float c = cos(a);
            return mat2(c, -s, s, c) * p;
          }
          void main() {
            float rad = radians(uAngle);
            vec2 c = fxRotate(vUv - 0.5, rad);
            float t = uTime * uSpeed;
            vec2 offset = vec2(0.0);
            if (uMode < 0.5) {
              offset.x = sin(c.y * uFrequency * 6.2831 + t) * uAmount;
            } else if (uMode < 1.5) {
              offset.y = sin(c.x * uFrequency * 6.2831 + t) * uAmount;
            } else {
              offset.x = sin(c.y * uFrequency * 6.2831 + t) * uAmount;
              offset.y = sin(c.x * uFrequency * 6.2831 - t * 1.3) * uAmount;
            }
            vec2 uv = fxRotate(c + offset, -rad) + 0.5;
            gl_FragColor = texture2D(tDiffuse, clamp(uv, 0.0, 1.0));
          }
        `,
        updateUniforms(u, params, time) {
          u.uAmount.value = params.amplitude;
          u.uFrequency.value = params.frequency;
          u.uAngle.value = params.angle;
          u.uSpeed.value = params.speed;
          u.uTime.value = time;
          u.uMode.value = params.axis === "horizontal" ? 0 : params.axis === "vertical" ? 1 : 2;
        },
      },
    ],
  },
  {
    id: "twirl",
    label: "Twirl / Swirl",
    group: "Distort",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M8 2.2a5.8 5.8 0 105.8 5.8" stroke-linecap="round"/><path d="M13.8 8a3.4 3.4 0 11-3.4-3.4" opacity="0.6" stroke-linecap="round"/></svg>`,
    params: [
      { key: "centerX", label: "Center X", min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: "centerY", label: "Center Y", min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: "radius", label: "Radius", min: 0.05, max: 1.2, step: 0.01, default: 0.45 },
      { key: "angle", label: "Twist", min: -720, max: 720, step: 5, default: 220 },
      { key: "falloff", label: "Falloff", min: 0.3, max: 4, step: 0.05, default: 1.6 },
    ],
    passes: [
      {
        key: "twirl",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform vec2 uResolution;
          uniform vec2 uCenter;
          uniform float uRadius;
          uniform float uAngle;
          uniform float uFalloff;
          varying vec2 vUv;
          vec2 fxRotate(vec2 p, float a) {
            float s = sin(a);
            float c = cos(a);
            return mat2(c, -s, s, c) * p;
          }
          void main() {
            float aspect = uResolution.x / uResolution.y;
            vec2 c = vUv - uCenter;
            c.x *= aspect;
            float dist = length(c);
            float pct = clamp(1.0 - dist / max(uRadius, 1e-4), 0.0, 1.0);
            float twist = radians(uAngle) * pow(pct, uFalloff);
            vec2 rotated = fxRotate(c, twist);
            rotated.x /= aspect;
            vec2 uv = uCenter + rotated;
            gl_FragColor = texture2D(tDiffuse, clamp(uv, 0.0, 1.0));
          }
        `,
        updateUniforms(u, params) {
          u.uCenter.value.set(params.centerX, params.centerY);
          u.uRadius.value = params.radius;
          u.uAngle.value = params.angle;
          u.uFalloff.value = params.falloff;
        },
      },
    ],
  },
  {
    id: "perspectiveWarp",
    label: "Perspective Warp",
    group: "Distort",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M2 3h12l-2 10H4L2 3Z"/></svg>`,
    params: [
      { key: "tiltX", label: "Tilt X", min: -1, max: 1, step: 0.01, default: 0 },
      { key: "tiltY", label: "Tilt Y", min: -1, max: 1, step: 0.01, default: 0.3 },
      { key: "depth", label: "Depth", min: 0.2, max: 3, step: 0.02, default: 1 },
      { key: "scale", label: "Scale", min: 0.3, max: 2.5, step: 0.02, default: 1 },
    ],
    passes: [
      {
        key: "perspectiveWarp",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform float uTiltX;
          uniform float uTiltY;
          uniform float uAmount;
          uniform float uScale;
          varying vec2 vUv;
          void main() {
            vec2 p = (vUv - 0.5) * 2.0;
            float persp = 1.0 + (p.x * uTiltY + p.y * uTiltX) * 0.6 * uAmount;
            persp = max(persp, 0.05);
            vec2 warped = p / persp;
            warped /= uScale;
            vec2 uv = warped * 0.5 + 0.5;
            gl_FragColor = texture2D(tDiffuse, clamp(uv, 0.0, 1.0));
          }
        `,
        updateUniforms(u, params) {
          u.uTiltX.value = params.tiltX;
          u.uTiltY.value = params.tiltY;
          u.uAmount.value = params.depth;
          u.uScale.value = params.scale;
        },
      },
    ],
  },
  {
    id: "radialBlur",
    label: "Radial Blur",
    group: "Blur",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none"/><path d="M8 8L2 4.5M8 8l7 1M8 8l-3 6.5M8 8l4.5-6" opacity="0.6"/></svg>`,
    params: [
      { key: "amount", label: "Amount", min: 0, max: 0.4, step: 0.002, default: 0.08 },
      { key: "steps", label: "Steps", min: 4, max: 48, step: 1, default: 12 },
    ],
    passes: [
      {
        key: "radialBlur",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform vec2 uResolution;
          uniform float uAmount;
          uniform float uSteps;
          varying vec2 vUv;
          void main() {
            vec2 center = vec2(0.5);
            float aspect = uResolution.x / max(1.0, uResolution.y);
            vec2 circular = (vUv - center) * vec2(aspect, 1.0);
            float radius = length(circular);
            float baseAngle = atan(circular.y, circular.x);
            vec4 sum = vec4(0.0);
            const int MAX_STEPS = 48;
            int steps = int(uSteps);
            for (int i = 0; i < MAX_STEPS; i++) {
              if (i >= steps) break;
              float t = float(i) / float(steps - 1) - 0.5;
              float angle = baseAngle + t * uAmount * 6.2831853;
              vec2 sampleCircular = radius * vec2(cos(angle), sin(angle));
              vec2 sampleUv = center + sampleCircular / vec2(aspect, 1.0);
              sum += texture2D(tDiffuse, sampleUv);
            }
            gl_FragColor = sum / float(steps);
          }
        `,
        updateUniforms(u, params) {
          u.uAmount.value = params.amount;
          u.uSteps.value = params.steps;
        },
      },
    ],
  },
  {
    id: "directionalBlur",
    label: "Directional Blur",
    group: "Blur",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M1.5 5.5h13M1.5 8h9.5M1.5 10.5h6.5" opacity="0.85"/></svg>`,
    params: [
      { key: "angle", label: "Angle", min: 0, max: 360, step: 1, default: 0 },
      { key: "amount", label: "Amount", min: 0, max: 40, step: 0.5, default: 12 },
      { key: "steps", label: "Steps", min: 4, max: 24, step: 1, default: 12 },
      { key: "randomness", label: "Randomness", min: 0, max: 1, step: 0.01, default: 0 },
    ],
    passes: [
      {
        key: "directionalBlur",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform vec2 uResolution;
          uniform float uAngle;
          uniform float uAmount;
          uniform float uSteps;
          uniform float uRandomness;
          varying vec2 vUv;
          ${NOISE_GLSL}
          void main() {
            float rad = uAngle * 3.14159265 / 180.0;
            vec2 dir = vec2(cos(rad), sin(rad));
            vec2 texel = 1.0 / uResolution;
            vec4 sum = vec4(0.0);
            float total = 0.0;
            const int MAX_N = 24;
            int n = int(uSteps);
            // Per-pixel stable jitter phase (0..1) so the randomness reads as
            // uneven brush-stroke / motion-blur streaking rather than a clean
            // symmetric average, while staying temporally stable (no flicker).
            float jitterPhase = fxHash(vUv * uResolution) - 0.5;
            for (int i = -MAX_N; i <= MAX_N; i++) {
              if (i < -n || i > n) continue;
              float fi = float(i) + jitterPhase * uRandomness * float(n) * 0.7;
              float w = exp(-fi * fi / (float(n) * float(n) * 0.5));
              vec2 offset = dir * texel * fi * uAmount;
              sum += texture2D(tDiffuse, vUv + offset) * w;
              total += w;
            }
            gl_FragColor = sum / max(total, 1e-4);
          }
        `,
        updateUniforms(u, params) {
          u.uAngle.value = params.angle;
          u.uAmount.value = params.amount;
          u.uSteps.value = params.steps;
          u.uRandomness.value = params.randomness;
        },
      },
    ],
  },
  {
    id: "uvBlur",
    label: "UV Blur",
    group: "Blur",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M1.5 5.5c1.2-1.6 2.4-1.6 3.6 0s2.4 1.6 3.6 0 2.4-1.6 3.6 0" opacity="0.4"/><path d="M1.5 8.5c1.2-1.6 2.4-1.6 3.6 0s2.4 1.6 3.6 0 2.4-1.6 3.6 0" opacity="0.7"/><path d="M1.5 11.5c1.2-1.6 2.4-1.6 3.6 0s2.4 1.6 3.6 0 2.4-1.6 3.6 0" opacity="1"/></svg>`,
    params: [
      {
        key: "followDistort",
        label: "Sync Distort",
        type: "toggle",
        default: true,
      },
      { key: "strength", label: "Strength", min: 0, max: 0.15, step: 0.001, default: 0.05 },
      {
        key: "noiseType",
        label: "Noise Type",
        type: "select",
        default: "cloud",
        options: NOISE_TYPE_OPTIONS,
      },
      { key: "scale", label: "Scale", min: 1, max: 30, step: 0.5, default: 5 },
      { key: "speed", label: "Speed", min: 0, max: 3, step: 0.02, default: 0.4 },
    ],
    passes: [
      {
        key: "uvBlur",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform sampler2D tDistortImage;
          uniform float uHasImageDistort;
          uniform float uScale;
          uniform float uSpeed;
          uniform float uTime;
          uniform float uStrength;
          uniform float uNoiseType;
          uniform float uMode; // 0 = manual/fallback noise, 1 = radial (from center), 2 = angular/tangential (swirl), 3 = synced noise field, 4 = image-map direction
          varying vec2 vUv;
          ${NOISE_GLSL}
          vec2 fxNoiseOffset(vec2 uv, float scale, float speed, float noiseType, float strength) {
            vec2 t = vec2(mod(uTime * speed * 0.15, 1000.0));
            vec2 p1 = uv * scale + t;
            vec2 p2 = uv * scale + t + vec2(17.0, 5.0);
            float n1 = fxNoiseSample(p1, noiseType);
            float n2 = fxNoiseSample(p2, noiseType);
            return (vec2(n1, n2) - 0.5) * strength;
          }
          void main() {
            vec2 offset;
            if (uMode < 0.5) {
              // No distort filter found below (or auto-follow disabled): fall back to an
              // independent noise-driven blur field using this filter's own knobs.
              offset = fxNoiseOffset(vUv, uScale, uSpeed, uNoiseType, uStrength);
            } else if (uMode < 1.5) {
              // Radial distort below: blur radiates outward from the same center, growing
              // toward the edge the same way a bulge/pinch does.
              vec2 dir = vUv - vec2(0.5);
              float d = length(dir);
              vec2 ndir = d > 1e-5 ? dir / d : vec2(0.0);
              offset = ndir * uStrength * 4.0 * d;
            } else if (uMode < 2.5) {
              // Polarize below: blur follows the tangential/rotational direction around the
              // same center, so the blur reads as a swirl instead of a straight streak.
              vec2 dir = vUv - vec2(0.5);
              float d = length(dir);
              vec2 tdir = d > 1e-5 ? vec2(-dir.y, dir.x) / d : vec2(0.0);
              offset = tdir * uStrength * 4.0 * (0.25 + 0.75 * d);
            } else if (uMode < 3.5) {
              // UV Noise / UV Displacement below: reuse the exact same noise field (type,
              // scale, speed all synced from that filter instance) so the blur direction
              // physically matches the distortion that was already applied.
              offset = fxNoiseOffset(vUv, uScale, uSpeed, uNoiseType, uStrength);
            } else {
              // UV Image Displacement below: follow that filter's own displacement map.
              if (uHasImageDistort > 0.5) {
                vec4 dmap = texture2D(tDistortImage, vUv);
                offset = (dmap.rg - 0.5) * uStrength * 4.0;
              } else {
                offset = fxNoiseOffset(vUv, uScale, uSpeed, uNoiseType, uStrength);
              }
            }
            vec4 sum = vec4(0.0);
            float total = 0.0;
            const int N = 8;
            for (int i = -N; i <= N; i++) {
              float tt = float(i) / float(N);
              float w = exp(-tt * tt * 2.0);
              vec2 uv = clamp(vUv + offset * tt, 0.0, 1.0);
              sum += texture2D(tDiffuse, uv) * w;
              total += w;
            }
            gl_FragColor = sum / total;
          }
        `,
        updateUniforms(u, params, time, ctx) {
          u.uTime.value = time;
          u.uStrength.value = params.strength;

          let mode = 0;
          let scale = params.scale;
          let speed = params.speed;
          let noiseType = noiseTypeCode(params.noiseType);
          let distortTex = null;

          const found = params.followDistort ? findPrecedingDistort(ctx) : null;
          if (found) {
            const { inst, def } = found;
            if (def.id === "radialDistort") {
              mode = 1;
            } else if (def.id === "polarize") {
              mode = 2;
            } else if (def.id === "uvNoise" || def.id === "displace") {
              mode = 3;
              scale = inst.params.scale;
              speed = inst.params.speed;
              noiseType = noiseTypeCode(inst.params.noiseType);
            } else if (def.id === "imageDisplace") {
              mode = 4;
              distortTex = ctx.compositor ? ctx.compositor.getInstanceTexture(inst) : null;
            }
          }

          u.uMode.value = mode;
          u.uScale.value = scale;
          u.uSpeed.value = speed;
          u.uNoiseType.value = noiseType;
          u.tDistortImage.value = distortTex;
          u.uHasImageDistort.value = distortTex ? 1 : 0;
        },
      },
    ],
  },
  {
    id: "curveBlur",
    label: "Curve Blur",
    group: "Blur",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M1.5 12.5C4 12.5 4 3.5 8 3.5s4 9 6.5 9" opacity="0.85"/></svg>`,
    params: [
      { key: "angle", label: "Angle", min: 0, max: 360, step: 1, default: 0 },
      { key: "amount", label: "Amount", min: 0, max: 60, step: 0.5, default: 20 },
      {
        key: "mode",
        label: "Curve Mode",
        type: "select",
        default: "simple",
        options: [
          { value: "simple", label: "Simple" },
          { value: "advanced", label: "Advanced" },
        ],
      },
      { key: "arc", label: "Arc", min: -1, max: 1, step: 0.01, default: 0.4, showIf: (p) => p.mode === "simple" },
      {
        key: "arcPosition",
        label: "Arc Position",
        min: 0.05,
        max: 0.95,
        step: 0.01,
        default: 0.5,
        showIf: (p) => p.mode === "simple",
      },
      {
        key: "curve",
        label: "Bend Curve",
        type: "curve",
        showIf: (p) => p.mode === "advanced",
        default: {
          points: [
            { x: 0, y: 0, type: "bezier" },
            { x: 0.5, y: 0.15, type: "bezier" },
            { x: 1, y: 1, type: "bezier" },
          ],
        },
      },
    ],
    passes: [
      {
        key: "curveBlur",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform vec2 uResolution;
          uniform float uAngle;
          uniform float uAmount;
          uniform float uMode;
          uniform float uArc;
          uniform float uArcPosition;
          uniform vec4 uCurvePoints[${CURVE_MAX_POINTS}];
          uniform vec4 uCurveTans[${CURVE_MAX_POINTS}];
          uniform float uCurveCount;
          varying vec2 vUv;
          ${CURVE_GLSL}
          void main() {
            float rad = uAngle * 3.14159265 / 180.0;
            vec2 dir = vec2(cos(rad), sin(rad));
            vec2 perp = vec2(-dir.y, dir.x);
            vec2 texel = 1.0 / uResolution;
            vec4 sum = vec4(0.0);
            float total = 0.0;
            const int N = 10;
            for (int i = -N; i <= N; i++) {
              float t = float(i) / float(N);
              float w = exp(-t * t * 2.0);
              float bend;
              if (uMode < 0.5) {
                // Simple mode: an intuitive tent-shaped bend — Arc Position sets WHERE
                // along the blur streak the curvature peaks, Arc sets HOW MUCH and which
                // direction it bends, with a smooth ease-in/out on both sides of the peak.
                float u = (t + 1.0) * 0.5;
                float peak = clamp(uArcPosition, 0.02, 0.98);
                float local = u < peak ? u / peak : (1.0 - u) / (1.0 - peak);
                local = clamp(local, 0.0, 1.0);
                float tent = local * local * (3.0 - 2.0 * local);
                bend = uArc * tent;
              } else {
                bend = fxCurveEval(abs(t), uCurvePoints, uCurveTans, int(uCurveCount)) * sign(t);
              }
              vec2 offset = (dir * t + perp * bend * 0.6) * texel * uAmount;
              sum += texture2D(tDiffuse, vUv + offset) * w;
              total += w;
            }
            gl_FragColor = sum / total;
          }
        `,
        updateUniforms(u, params) {
          u.uAngle.value = params.angle;
          u.uAmount.value = params.amount;
          u.uMode.value = params.mode === "advanced" ? 1 : 0;
          u.uArc.value = params.arc;
          u.uArcPosition.value = params.arcPosition;
          const { points, tans, count } = curveToUniformArray(params.curve);
          for (let i = 0; i < points.length; i++) {
            u.uCurvePoints.value[i].set(points[i][0], points[i][1], points[i][2], points[i][3]);
            u.uCurveTans.value[i].set(tans[i][0], tans[i][1], tans[i][2], tans[i][3]);
          }
          u.uCurveCount.value = count;
        },
      },
    ],
  },
  {
    id: "bokehBlur",
    label: "Bokeh Blur",
    group: "Blur",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1"><circle cx="4.5" cy="5" r="2.3" opacity="0.85"/><circle cx="11" cy="4" r="1.6" opacity="0.6"/><circle cx="10" cy="11" r="2.7" opacity="0.9"/><circle cx="4" cy="11.5" r="1.3" opacity="0.5"/></svg>`,
    params: [
      { key: "radius", label: "Radius", min: 0, max: 30, step: 0.5, default: 9 },
      { key: "blades", label: "Blades", min: 0, max: 8, step: 1, default: 0 },
      { key: "rotation", label: "Rotation", min: 0, max: 360, step: 1, default: 0 },
      { key: "threshold", label: "Highlight Threshold", min: 0, max: 1, step: 0.01, default: 0.55 },
      { key: "boost", label: "Highlight Boost", min: 0, max: 8, step: 0.1, default: 2.5 },
    ],
    passes: [
      {
        key: "bokehBlur",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform vec2 uResolution;
          uniform float uRadius;
          uniform float uBlades;
          uniform float uAngle;
          uniform float uThreshold;
          uniform float uIntensity;
          varying vec2 vUv;
          float fxPolyRadius(float angle, float sides) {
            float segment = 6.28318530718 / sides;
            float a = mod(angle, segment) - segment * 0.5;
            return cos(segment * 0.5) / max(cos(a), 1e-3);
          }
          void main() {
            vec2 texel = 1.0 / uResolution;
            vec3 sum = vec3(0.0);
            float total = 0.0;
            const int TAP_COUNT = 32;
            float golden = 2.39996323;
            float rot = radians(uAngle);
            for (int i = 0; i < TAP_COUNT; i++) {
              float fi = float(i);
              float ringT = sqrt((fi + 0.5) / float(TAP_COUNT));
              float ang = fi * golden + rot;
              float shapeR = uBlades >= 3.0 ? fxPolyRadius(ang - rot, uBlades) : 1.0;
              vec2 tapOffset = vec2(cos(ang), sin(ang)) * ringT * shapeR * uRadius * texel;
              vec4 samp = texture2D(tDiffuse, clamp(vUv + tapOffset, 0.0, 1.0));
              float lum = dot(samp.rgb, vec3(0.299, 0.587, 0.114));
              float w = 1.0 + step(uThreshold, lum) * uIntensity;
              sum += samp.rgb * w;
              total += w;
            }
            vec4 center = texture2D(tDiffuse, vUv);
            gl_FragColor = vec4(sum / max(total, 1e-4), center.a);
          }
        `,
        updateUniforms(u, params) {
          u.uRadius.value = params.radius;
          u.uBlades.value = params.blades;
          u.uAngle.value = params.rotation;
          u.uThreshold.value = params.threshold;
          u.uIntensity.value = params.boost;
        },
      },
    ],
  },
  {
    id: "zoomBlur",
    label: "Zoom Blur",
    group: "Blur",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none"/><path d="M8 8L1.5 6M8 8l6.5 -1M8 8l-2 6.5M8 8l2 -6.5" opacity="0.6"/></svg>`,
    params: [
      { key: "centerX", label: "Center X", min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: "centerY", label: "Center Y", min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: "amount", label: "Amount", min: 0, max: 0.5, step: 0.002, default: 0.1 },
      { key: "steps", label: "Steps", min: 4, max: 48, step: 1, default: 16 },
    ],
    passes: [
      {
        key: "zoomBlur",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform vec2 uCenter;
          uniform float uAmount;
          uniform float uSteps;
          varying vec2 vUv;
          void main() {
            vec2 dir = vUv - uCenter;
            vec4 sum = vec4(0.0);
            const int MAX_STEPS = 48;
            int steps = int(uSteps);
            for (int i = 0; i < MAX_STEPS; i++) {
              if (i >= steps) break;
              float t = float(i) / float(steps - 1);
              sum += texture2D(tDiffuse, clamp(vUv - dir * uAmount * t, 0.0, 1.0));
            }
            gl_FragColor = sum / float(steps);
          }
        `,
        updateUniforms(u, params) {
          u.uCenter.value.set(params.centerX, params.centerY);
          u.uAmount.value = params.amount;
          u.uSteps.value = params.steps;
        },
      },
    ],
  },
  {
    id: "tiltShiftBlur",
    label: "Tilt-Shift Blur",
    group: "Blur",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1" y="6.5" width="14" height="3" opacity="0.9"/><path d="M1 2.5h14M1 13.5h14" opacity="0.4"/></svg>`,
    params: [
      { key: "focusPosition", label: "Focus Position", min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: "focusWidth", label: "Focus Width", min: 0.02, max: 0.8, step: 0.01, default: 0.22 },
      { key: "angle", label: "Angle", min: 0, max: 360, step: 1, default: 0 },
      { key: "amount", label: "Blur Amount", min: 0, max: 6, step: 0.05, default: 2.4 },
    ],
    passes: [
      {
        key: "tiltShiftBlur",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform vec2 uResolution;
          uniform float uAngle;
          uniform float uAmount;
          uniform float uFocusPos;
          uniform float uFocusWidth;
          uniform vec2 uDirection;
          varying vec2 vUv;
          vec2 fxRotate(vec2 p, float a) {
            float s = sin(a);
            float c = cos(a);
            return mat2(c, -s, s, c) * p;
          }
          void main() {
            vec2 c = vUv - 0.5;
            vec2 rc = fxRotate(c, -radians(uAngle));
            float bandCoord = rc.y - (uFocusPos - 0.5);
            float mask = smoothstep(uFocusWidth * 0.5, uFocusWidth * 0.5 + 0.25, abs(bandCoord));
            float localRadius = uAmount * mask;
            vec2 texel = 1.0 / uResolution;
            vec4 sum = vec4(0.0);
            float total = 0.0;
            for (int i = -6; i <= 6; i++) {
              float w = exp(-float(i * i) / 18.0);
              vec2 offset = uDirection * texel * float(i) * localRadius;
              sum += texture2D(tDiffuse, clamp(vUv + offset, 0.0, 1.0)) * w;
              total += w;
            }
            gl_FragColor = sum / total;
          }
        `,
        updateUniforms(u, params) {
          u.uAngle.value = params.angle;
          u.uAmount.value = params.amount;
          u.uFocusPos.value = params.focusPosition;
          u.uFocusWidth.value = params.focusWidth;
          u.uDirection.value.set(1, 0);
        },
      },
      {
        key: "tiltShiftBlur",
        fragmentShader: null,
        updateUniforms(u, params) {
          u.uAngle.value = params.angle;
          u.uAmount.value = params.amount;
          u.uFocusPos.value = params.focusPosition;
          u.uFocusWidth.value = params.focusWidth;
          u.uDirection.value.set(0, 1);
        },
      },
    ],
  },
  {
    id: "filmEmulation",
    label: "Film Emulation",
    group: "Color",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M1.5 5.2h13M1.5 10.8h13" opacity="0.6"/><circle cx="3.4" cy="3.85" r="0.5" fill="currentColor" stroke="none"/><circle cx="3.4" cy="12.15" r="0.5" fill="currentColor" stroke="none"/><circle cx="12.6" cy="3.85" r="0.5" fill="currentColor" stroke="none"/><circle cx="12.6" cy="12.15" r="0.5" fill="currentColor" stroke="none"/></svg>`,
    params: [
      {
        key: "stock",
        label: "Stock",
        type: "select",
        default: "portra",
        options: [
          { value: "neutral", label: "Neutral" },
          { value: "portra", label: "Portra" },
          { value: "velvia", label: "Velvia" },
          { value: "trix", label: "Tri-X B&W" },
          { value: "cinestill", label: "CineStill 800T" },
          { value: "bleach", label: "Bleach Bypass" },
        ],
      },
      { key: "grain", label: "Grain", min: 0, max: 2, step: 0.01, default: 0.45 },
      { key: "grainSize", label: "Grain Size", min: 0.3, max: 6, step: 0.05, default: 1.4 },
      { key: "grainAnimated", label: "Animated Grain", type: "toggle", default: true },
      { key: "halation", label: "Halation", min: 0, max: 3, step: 0.02, default: 0.55 },
      { key: "haloSize", label: "Halation Size", min: 0.5, max: 8, step: 0.1, default: 3.2 },
      { key: "contrast", label: "Contrast", min: -1, max: 1.5, step: 0.01, default: 0.12 },
      { key: "saturation", label: "Saturation", min: 0, max: 2.2, step: 0.01, default: 1.0 },
      { key: "fade", label: "Fade", min: 0, max: 0.6, step: 0.01, default: 0.08 },
      { key: "temperature", label: "Temperature", min: -1, max: 1, step: 0.01, default: 0 },
      { key: "tint", label: "Tint", min: -1, max: 1, step: 0.01, default: 0 },
      { key: "vignette", label: "Vignette", min: 0, max: 2, step: 0.01, default: 0.4 },
    ],
    passes: [
      {
        key: "filmEmulation",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform vec2 uResolution;
          uniform float uTime;
          uniform float uStock;
          uniform float uGrain;
          uniform float uGrainSize;
          uniform float uGrainAnimated;
          uniform float uHalation;
          uniform float uHaloSize;
          uniform float uContrast;
          uniform float uSaturation;
          uniform float uFade;
          uniform float uTemperature;
          uniform float uTintShift;
          uniform float uVignette;
          varying vec2 vUv;
          ${NOISE_GLSL}
          ${HSL_GLSL}
          void main() {
            vec4 base = texture2D(tDiffuse, vUv);
            vec3 color = base.rgb;

            // Halation: warm bloom bleeding outward from bright areas — the
            // signature look of film base reflecting light back through
            // missing/thin anti-halation backing (most visible on CineStill).
            vec2 texel = 1.0 / uResolution;
            vec3 halo = vec3(0.0);
            const int HALO_TAPS = 8;
            for (int i = 0; i < HALO_TAPS; i++) {
              float a = 6.28318530718 * float(i) / float(HALO_TAPS);
              vec2 dir = vec2(cos(a), sin(a));
              vec3 c = texture2D(tDiffuse, vUv + dir * texel * uHaloSize).rgb;
              halo += c * smoothstep(0.6, 1.0, fxLum(c));
            }
            halo /= float(HALO_TAPS);

            // Per-stock look: split-tone shadow/highlight tint, grayscale mix
            // (for B&W / bleach-bypass), a baked-in extra contrast punch, and
            // a halation color true to that stock's base.
            vec3 shadowTint = vec3(0.0);
            vec3 highlightTint = vec3(0.0);
            vec3 haloTint = vec3(1.0, 0.72, 0.55);
            float grayMix = 0.0;
            float curveBoost = 0.0;
            if (uStock < 0.5) {
              // Neutral
              haloTint = vec3(1.0, 0.75, 0.6);
            } else if (uStock < 1.5) {
              // Portra — soft warm highlights, faint cool shadows
              shadowTint = vec3(-0.01, 0.005, 0.03);
              highlightTint = vec3(0.05, 0.025, -0.02);
              haloTint = vec3(1.0, 0.62, 0.42);
              curveBoost = 0.12;
            } else if (uStock < 2.5) {
              // Velvia — punchy saturated slide film
              shadowTint = vec3(0.0, -0.01, 0.045);
              highlightTint = vec3(0.06, 0.03, -0.03);
              haloTint = vec3(1.0, 0.5, 0.18);
              curveBoost = 0.32;
            } else if (uStock < 3.5) {
              // Tri-X — classic silver B&W with a faint warm/cool split tone
              shadowTint = vec3(-0.02, -0.008, 0.025);
              highlightTint = vec3(0.03, 0.02, -0.008);
              haloTint = vec3(0.95, 0.9, 0.82);
              grayMix = 1.0;
              curveBoost = 0.38;
            } else if (uStock < 4.5) {
              // CineStill 800T — tungsten-balanced, signature red halation
              shadowTint = vec3(-0.025, 0.01, 0.05);
              highlightTint = vec3(0.015, 0.0, -0.01);
              haloTint = vec3(1.0, 0.14, 0.1);
              curveBoost = 0.18;
            } else {
              // Bleach Bypass — desaturated, crushed blacks, silvery highlights
              shadowTint = vec3(0.015, 0.015, 0.02);
              highlightTint = vec3(0.01, 0.008, 0.0);
              haloTint = vec3(1.0, 0.78, 0.6);
              grayMix = 0.55;
              curveBoost = 0.55;
            }

            color += halo * haloTint * uHalation * 0.6;

            // Saturation
            color = mix(vec3(fxLum(color)), color, uSaturation);

            // White balance push (temperature: warm<->cool, tint: green<->magenta)
            color.r += uTemperature * 0.05 - uTintShift * 0.015;
            color.b -= uTemperature * 0.05 - uTintShift * 0.015;
            color.g += uTintShift * 0.035;

            // Grayscale mix for B&W / bleach-bypass stocks, applied before
            // the split tone so a mono stock can still carry a color cast.
            color = mix(color, vec3(fxLum(color)), grayMix);

            // Filmic S-curve contrast: user amount plus the stock's baked-in punch.
            float totalContrast = clamp(uContrast + curveBoost, -1.0, 2.0);
            color = (color - 0.5) * (1.0 + totalContrast) + 0.5;

            // Lifted blacks ("faded" film look) — raises the floor instead of
            // a flat brightness add so highlights stay intact.
            color = color * (1.0 - uFade) + uFade * 0.5;

            // Split toning: cool cast in shadows, warm cast in highlights (or
            // whatever the stock defines), weighted by luminance.
            float lum1 = fxLum(color);
            color += shadowTint * (1.0 - lum1) + highlightTint * lum1;

            // Film grain: fine hash-speckle layer plus a coarser fbm "clump"
            // layer, shaped to peak in midtones (like real silver-halide
            // grain) and optionally flickering per-frame like a live scan.
            vec2 pixelCoord = vUv * uResolution;
            float grainT = uGrainAnimated > 0.5 ? floor(uTime * 24.0) : 0.0;
            float fine = fxHash(pixelCoord + vec2(grainT * 41.0, grainT * 67.0)) - 0.5;
            float coarse = fxNoise(pixelCoord / max(uGrainSize, 0.05) + vec2(grainT * 13.0, grainT * 19.0)) - 0.5;
            float grain = mix(fine, coarse, 0.35);
            float gLum = fxLum(color);
            float shape = 4.0 * gLum * (1.0 - gLum);
            color += grain * uGrain * shape * 0.5;

            // Vignette
            vec2 vc = vUv - 0.5;
            float vig = 1.0 - dot(vc, vc) * uVignette;
            color *= clamp(vig, 0.0, 1.0);

            gl_FragColor = vec4(clamp(color, 0.0, 1.0), base.a);
          }
        `,
        updateUniforms(u, params, time) {
          const stockIndex = { neutral: 0, portra: 1, velvia: 2, trix: 3, cinestill: 4, bleach: 5 }[params.stock] ?? 1;
          u.uStock.value = stockIndex;
          u.uGrain.value = params.grain;
          u.uGrainSize.value = params.grainSize;
          u.uGrainAnimated.value = params.grainAnimated ? 1 : 0;
          u.uHalation.value = params.halation;
          u.uHaloSize.value = params.haloSize;
          u.uContrast.value = params.contrast;
          u.uSaturation.value = params.saturation;
          u.uFade.value = params.fade;
          u.uTemperature.value = params.temperature;
          u.uTintShift.value = params.tint;
          u.uVignette.value = params.vignette;
          u.uTime.value = time;
        },
      },
    ],
  },
  {
    id: "silkSheen",
    label: "Silk Sheen",
    group: "Effect",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M1.2 4.5c3-2 6-2 7.6 0.4s4.6 2.4 7.6 0.4" opacity="0.9"/><path d="M1.2 8c3-2 6-2 7.6 0.4s4.6 2.4 7.6 0.4" opacity="0.6"/><path d="M1.2 11.5c3-2 6-2 7.6 0.4s4.6 2.4 7.6 0.4" opacity="0.35"/></svg>`,
    params: [
      {
        key: "flowType",
        label: "Fiber Flow",
        type: "select",
        default: "linear",
        options: [
          { value: "linear", label: "Linear" },
          { value: "radial", label: "Radial" },
          { value: "weave", label: "Weave" },
          { value: "noise", label: "Organic Flow" },
        ],
      },
      { key: "flowAngle", label: "Fiber Angle", min: 0, max: 360, step: 1, default: 35, showIf: (p) => p.flowType !== "radial" },
      { key: "lightAngle", label: "Light Angle", min: 0, max: 360, step: 1, default: 120 },
      { key: "frequency", label: "Fiber Density", min: 1, max: 40, step: 0.5, default: 10 },
      { key: "strength", label: "Anisotropy", min: 0, max: 1, step: 0.01, default: 0.6 },
      { key: "organic", label: "Organic Warp", min: 0, max: 1, step: 0.01, default: 0.25 },
      { key: "speed", label: "Shimmer Speed", min: 0, max: 2, step: 0.02, default: 0.12 },
      {
        key: "contentFollow",
        label: "Follow Image Shape",
        min: 0,
        max: 1,
        step: 0.01,
        default: 0.7,
        hint: "How much the sheen bends to wrap around the picture's own edges/contours instead of a flat pattern",
      },
      {
        key: "contentRelief",
        label: "Image Relief",
        min: 0,
        max: 1,
        step: 0.01,
        default: 0.5,
        hint: "Sculpts a pseudo height-field from the image's own brightness so folds catch light like real drape",
      },
      { key: "shadowHue", label: "Shadow Hue", min: 0, max: 360, step: 1, default: 230 },
      { key: "highlightHue", label: "Highlight Hue", min: 0, max: 360, step: 1, default: 45 },
      { key: "saturation", label: "Tint Saturation", min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: "colorize", label: "Recolor Base", min: 0, max: 1, step: 0.01, default: 0, hint: "0 keeps the image's own colors; higher values push it toward the shadow/highlight hues" },
      { key: "punch", label: "Highlight Punch", min: 0, max: 1, step: 0.01, default: 0.35 },
      { key: "mix", label: "Blend", min: 0, max: 1, step: 0.01, default: 0.6 },
    ],
    passes: [
      {
        key: "silkSheen",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform vec2 uResolution;
          uniform float uTime;
          uniform float uMode;
          uniform float uAngle;
          uniform float uArc;
          uniform float uFrequency;
          uniform float uStrength;
          uniform float uJitter;
          uniform float uSpeed;
          uniform float uRoughness; // "Follow Image Shape" - how much T bends along image contours
          uniform float uFalloff;   // "Image Relief" - bump-mapped light response from image luminance
          uniform float uShadowHue;
          uniform float uHighlightHue;
          uniform float uSaturation;
          uniform float uChroma;    // "Recolor Base" - 0 keeps original hue, 1 fully recolors
          uniform float uContrast;
          uniform float uMix;
          varying vec2 vUv;
          ${NOISE_GLSL}
          ${HSL_GLSL}
          // Tangent ("fiber") direction field at uv, per flow pattern. This is the
          // anisotropy fake: rather than shading a real 3D tangent basis, we build a
          // 2D direction field and stretch noise/highlights along it, which is the
          // same screen-space trick used for brushed-metal/hair-card shaders.
          vec2 silkFlowDir(vec2 uv, float mode, float angleDeg, float freq, float jitter, float t) {
            vec2 centered = uv - 0.5;
            float ang = radians(angleDeg);
            vec2 baseDir = vec2(cos(ang), sin(ang));
            vec2 dir = baseDir;
            if (mode < 0.5) {
              // Linear: constant fiber direction, like a bolt of woven cloth.
              dir = baseDir;
            } else if (mode < 1.5) {
              // Radial: fibers run tangential to the center, like pleated/gathered silk.
              float rl = length(centered) + 1e-4;
              vec2 radial = centered / rl;
              dir = vec2(-radial.y, radial.x);
            } else if (mode < 2.5) {
              // Weave: alternating perpendicular threads in a basket-weave lattice.
              vec2 cell = floor(uv * freq);
              float checker = mod(cell.x + cell.y, 2.0);
              vec2 dirB = vec2(-baseDir.y, baseDir.x);
              dir = checker < 0.5 ? baseDir : dirB;
            } else {
              // Organic Flow: tangent to a domain-warped noise field (curl-noise style)
              // for draped/rumpled fabric with no repeating structure.
              vec2 p = uv * freq * 0.5;
              float e = 0.02;
              float n1 = fxDomainWarp(p + vec2(e, 0.0));
              float n2 = fxDomainWarp(p - vec2(e, 0.0));
              float n3 = fxDomainWarp(p + vec2(0.0, e));
              float n4 = fxDomainWarp(p - vec2(0.0, e));
              vec2 grad = vec2(n1 - n2, n3 - n4);
              dir = normalize(vec2(-grad.y, grad.x) + 1e-5);
            }
            // Organic warp: bends the field a little so straight patterns don't read
            // as perfectly mechanical (real cloth always has some drape/wrinkle).
            if (mode < 2.5) {
              float n = fxFbm(uv * freq * 1.3 + t * 0.05) - 0.5;
              float rot = n * jitter * 1.6;
              float ca = cos(rot);
              float sa = sin(rot);
              dir = mat2(ca, -sa, sa, ca) * dir;
            }
            return normalize(dir);
          }
          void main() {
            vec4 base = texture2D(tDiffuse, vUv);
            float t = uTime * uSpeed * 0.3;
            vec2 centered = vUv - 0.5;
            vec2 texel = 1.0 / max(uResolution, vec2(1.0));

            // Read the image's own luminance around this pixel (3x3 Sobel) so the
            // sheen can actually react to what's drawn instead of floating on top
            // of it. This is the core "generated from the existing image" fix:
            // edges/silhouettes in the artwork now steer the fiber flow and create
            // their own highlight/shadow the way real fabric wraps around a form.
            float sampleR = max(1.0, uFrequency * 0.05);
            vec2 o1 = texel * sampleR;
            float lTL = fxLum(texture2D(tDiffuse, vUv + vec2(-o1.x,  o1.y)).rgb);
            float lTC = fxLum(texture2D(tDiffuse, vUv + vec2( 0.0,   o1.y)).rgb);
            float lTR = fxLum(texture2D(tDiffuse, vUv + vec2( o1.x,  o1.y)).rgb);
            float lML = fxLum(texture2D(tDiffuse, vUv + vec2(-o1.x,  0.0)).rgb);
            float lMR = fxLum(texture2D(tDiffuse, vUv + vec2( o1.x,  0.0)).rgb);
            float lBL = fxLum(texture2D(tDiffuse, vUv + vec2(-o1.x, -o1.y)).rgb);
            float lBC = fxLum(texture2D(tDiffuse, vUv + vec2( 0.0,  -o1.y)).rgb);
            float lBR = fxLum(texture2D(tDiffuse, vUv + vec2( o1.x, -o1.y)).rgb);
            float gx = (lTR + 2.0 * lMR + lBR) - (lTL + 2.0 * lML + lBL);
            float gy = (lBL + 2.0 * lBC + lBR) - (lTL + 2.0 * lTC + lTR);
            float edgeMag = length(vec2(gx, gy));
            vec2 edgeTangent = edgeMag > 1e-5 ? normalize(vec2(-gy, gx)) : vec2(1.0, 0.0);

            // Pattern-driven direction (user-chosen Linear/Radial/Weave/Organic Flow).
            vec2 patternDir = silkFlowDir(vUv, uMode, uAngle, uFrequency, uJitter, t);
            // Only bend toward the image's own contours where real structure exists
            // (smoothstep gate on edge strength) so flat/empty regions keep the
            // clean chosen pattern instead of turning into noise.
            float contentWeight = uRoughness * smoothstep(0.015, 0.22, edgeMag);
            vec2 T = normalize(mix(patternDir, edgeTangent, contentWeight));
            vec2 perp = vec2(-T.y, T.x);

            // Alignment between the fiber direction and a virtual light direction:
            // brightest where the "grain" of the silk points toward the light, exactly
            // the streaky, moving highlight silk/satin is known for.
            vec2 lightDir = vec2(cos(radians(uArc)), sin(radians(uArc)));
            float align = dot(T, lightDir);
            float sharp = mix(2.0, 40.0, uStrength);
            float baseSheen = pow(clamp(align * 0.5 + 0.5, 0.0, 1.0), sharp);

            // Fine fiber texture: noise stretched heavily along T and only lightly
            // across perp, which reads as the tiny parallel thread striations that
            // give silk its characteristic anisotropic sparkle.
            float alongC = dot(centered, T);
            float perpC = dot(centered, perp);
            float fiber = fxFbm(vec2(alongC * 2.0 + t * 0.15, perpC * 22.0));
            float sheenPattern = clamp(baseSheen + (fiber - 0.5) * 0.25 * uStrength, 0.0, 1.0);

            // Image Relief: treat the artwork's own luminance gradient as a bump map
            // and light it directly, so folds/edges that already exist in the image
            // catch or lose the light like real drape - not a generic overlay.
            vec3 N = normalize(vec3(-gx * uFalloff * 3.0, -gy * uFalloff * 3.0, 1.0));
            vec3 L3 = normalize(vec3(lightDir, 0.55));
            vec3 V3 = vec3(0.0, 0.0, 1.0);
            vec3 H3 = normalize(L3 + V3);
            float bumpSpec = pow(clamp(dot(N, H3), 0.0, 1.0), mix(6.0, 70.0, uStrength));
            float lum = fxLum(base.rgb);
            float bumpSheen = clamp(bumpSpec + max(0.0, lum - 0.5) * uFalloff * 0.6, 0.0, 1.0);

            float sheen = clamp(mix(sheenPattern, max(sheenPattern, bumpSheen), uFalloff), 0.0, 1.0);

            // Recolor Base blends between a hue-preserving sheen (keeps the artwork's
            // own colors, just adds a lit/shadowed silk sweep) and the fully tinted
            // shadow/highlight hue palette.
            vec3 shadowTint = fxHsl2rgb(vec3(uShadowHue, uSaturation, 0.4));
            vec3 highlightTint = fxHsl2rgb(vec3(uHighlightHue, uSaturation * 0.7, 0.75));
            vec3 coloredTint = mix(shadowTint, highlightTint, sheen);
            vec3 neutralTint = mix(base.rgb * 0.82, vec3(1.0), sheen);
            vec3 tint = mix(neutralTint, coloredTint, uChroma);

            // Screen-blend the tint by the sheen mask so shadows stay put and only
            // the "wet" highlight streaks lighten/color the surface underneath.
            vec3 screened = 1.0 - (1.0 - base.rgb) * (1.0 - tint * sheen);
            vec3 color = mix(base.rgb, screened, uMix);
            color += vec3(1.0) * pow(sheen, 3.0) * uContrast * 0.5;

            gl_FragColor = vec4(clamp(color, 0.0, 1.0), base.a);
          }
        `,
        updateUniforms(u, params, time) {
          u.uMode.value =
            params.flowType === "radial" ? 1
            : params.flowType === "weave" ? 2
            : params.flowType === "noise" ? 3
            : 0;
          u.uAngle.value = params.flowAngle;
          u.uArc.value = params.lightAngle;
          u.uFrequency.value = params.frequency;
          u.uStrength.value = params.strength;
          u.uJitter.value = params.organic;
          u.uSpeed.value = params.speed;
          u.uRoughness.value = params.contentFollow;
          u.uFalloff.value = params.contentRelief;
          u.uShadowHue.value = params.shadowHue;
          u.uHighlightHue.value = params.highlightHue;
          u.uSaturation.value = params.saturation;
          u.uChroma.value = params.colorize;
          u.uContrast.value = params.punch;
          u.uMix.value = params.mix;
          u.uTime.value = time;
        },
      },
    ],
  },
  {
    id: "chromaKey",
    label: "Chroma Key",
    group: "Color",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="8" cy="8" r="5.4"/><path d="M8 2.6v10.8M2.6 8h10.8"/></svg>`,
    params: [
      { key: "keyColor", label: "Key color", type: "color", default: "#00a85a" },
      { key: "threshold", label: "Threshold", min: 0, max: 1, step: 0.01, default: 0.22 },
      { key: "softness", label: "Softness", min: 0.001, max: 1, step: 0.01, default: 0.12 },
      { key: "invert", label: "Invert", type: "toggle", default: false },
    ],
    passes: [
      {
        key: "chromaKey",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform vec3 uKeyColor;
          uniform float uThreshold;
          uniform float uSoftness;
          uniform float uInvert;
          varying vec2 vUv;
          void main() {
            vec4 base = texture2D(tDiffuse, vUv);
            float distanceToKey = length(base.rgb - uKeyColor);
            float keyAlpha = smoothstep(uThreshold, uThreshold + max(uSoftness, 0.0001), distanceToKey);
            float alpha = mix(keyAlpha, 1.0 - keyAlpha, uInvert);
            gl_FragColor = vec4(base.rgb, base.a * alpha);
          }
        `,
        updateUniforms(u, params) {
          const rgb = hexToRgb01(params.keyColor);
          u.uKeyColor.value.set(rgb[0], rgb[1], rgb[2]);
          u.uThreshold.value = params.threshold;
          u.uSoftness.value = params.softness;
          u.uInvert.value = params.invert ? 1 : 0;
        },
      },
    ],
  },
  {
    id: "transform",
    label: "Transform",
    group: "Distort",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3"/><path d="M5 5h6v6H5z"/></svg>`,
    params: [
      { key: "translateX", label: "Move X", min: -1, max: 1, step: 0.01, default: 0 },
      { key: "translateY", label: "Move Y", min: -1, max: 1, step: 0.01, default: 0 },
      { key: "scaleX", label: "Scale X", min: 0.01, max: 3, step: 0.01, default: 1 },
      { key: "scaleY", label: "Scale Y", min: 0.01, max: 3, step: 0.01, default: 1 },
      { key: "rotation", label: "Rotation", min: -180, max: 180, step: 1, default: 0 },
    ],
    passes: [
      {
        key: "transform",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform vec2 uTranslate;
          uniform vec2 uScale;
          uniform float uRotation;
          varying vec2 vUv;
          void main() {
            vec2 point = vUv - 0.5 - uTranslate;
            float c = cos(uRotation);
            float s = sin(uRotation);
            point = mat2(c, s, -s, c) * point;
            vec2 uv = point / max(uScale, vec2(0.0001)) + 0.5;
            float inBounds = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
            gl_FragColor = texture2D(tDiffuse, clamp(uv, 0.0, 1.0)) * inBounds;
          }
        `,
        updateUniforms(u, params) {
          u.uTranslate.value.set(params.translateX, params.translateY);
          u.uScale.value.set(params.scaleX, params.scaleY);
          u.uRotation.value = params.rotation * Math.PI / 180;
        },
      },
    ],
  },
  {
    id: "generateGradient",
    label: "Gradient",
    group: "Generate",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="2" y="2" width="12" height="12" rx="1.5"/><path d="M3.5 12.5 12.5 3.5"/></svg>`,
    params: [
      {
        key: "gradient",
        label: "Gradient",
        type: "gradient",
        default: {
          stops: [
            { t: 0, color: "#11223b" },
            { t: 1, color: "#d29a5d" },
          ],
        },
      },
      { key: "mode", label: "Type", type: "select", default: "linear", options: [{ value: "linear", label: "Linear" }, { value: "radial", label: "Radial" }, { value: "conic", label: "Conic" }] },
      { key: "angle", label: "Angle", min: 0, max: 360, step: 1, default: 35, showIf: (p) => p.mode !== "radial" },
      { key: "centerX", label: "Center X", min: 0, max: 1, step: 0.01, default: 0.5, showIf: (p) => p.mode !== "linear" },
      { key: "centerY", label: "Center Y", min: 0, max: 1, step: 0.01, default: 0.5, showIf: (p) => p.mode !== "linear" },
      { key: "contrast", label: "Contrast", min: 0.1, max: 4, step: 0.05, default: 1 },
    ],
    passes: [{
      key: "generateGradient",
      fragmentShader: `
        uniform sampler2D tDiffuse; uniform vec4 uGradStops[${GRADIENT_MAX_STOPS}]; uniform float uGradCount; uniform float uMode; uniform float uAngle; uniform vec2 uCenter; uniform float uContrast; varying vec2 vUv; ${GRADIENT_GLSL}
        void main() {
          vec4 base = texture2D(tDiffuse, vUv);
          vec2 p = vUv - uCenter;
          float t = uMode < 0.5 ? dot(vUv - 0.5, vec2(cos(uAngle), sin(uAngle))) + 0.5 : uMode < 1.5 ? length(p) * 1.41421356 : atan(p.y, p.x) / 6.2831853 + 0.5 + uAngle / 6.2831853;
          t = clamp((t - 0.5) * uContrast + 0.5, 0.0, 1.0);
          gl_FragColor = vec4(fxGradientEval(t, uGradStops, int(uGradCount)), base.a);
        }`,
      updateUniforms(u, p) {
        const fallback = {
          stops: [
            { t: 0, color: p.colorA || "#11223b" },
            { t: 1, color: p.colorB || "#d29a5d" },
          ],
        };
        const { stops, count } = gradientToUniformArray(p.gradient || fallback);
        for (let i = 0; i < stops.length; i++) {
          u.uGradStops.value[i].set(stops[i][0], stops[i][1], stops[i][2], stops[i][3]);
        }
        u.uGradCount.value = count;
        u.uMode.value = p.mode === "radial" ? 1 : p.mode === "conic" ? 2 : 0;
        u.uAngle.value = p.angle * Math.PI / 180; u.uCenter.value.set(p.centerX, p.centerY); u.uContrast.value = p.contrast;
      },
    }],
  },
  {
    id: "cloudTexture",
    label: "Cloud Texture",
    group: "Generate",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M3 11.5h9.5a2.5 2.5 0 0 0 .3-5 3.7 3.7 0 0 0-7.1-.5A2.8 2.8 0 0 0 3 11.5Z"/></svg>`,
    params: [
      { key: "scale", label: "Scale", min: 0.25, max: 50, step: 0.25, default: 5 },
      { key: "detail", label: "Detail", min: 1, max: 8, step: 1, default: 4 },
      { key: "roughness", label: "Roughness", min: 0.05, max: 0.95, step: 0.01, default: 0.5 },
      { key: "lacunarity", label: "Lacunarity", min: 1.2, max: 4, step: 0.05, default: 2.02 },
      { key: "distortion", label: "Distortion", min: 0, max: 3, step: 0.02, default: 0.35 },
      { key: "contrast", label: "Contrast", min: 0.1, max: 5, step: 0.05, default: 1.4 },
      { key: "bias", label: "Bias", min: -1, max: 1, step: 0.01, default: 0 },
      { key: "seed", label: "Seed", min: 0, max: 100, step: 0.1, default: 17 },
      { key: "invert", label: "Invert", type: "toggle", default: false },
      { key: "transparentBackground", label: "Transparent Black", type: "toggle", default: false },
      { key: "threshold", label: "Transparency Threshold", min: 0, max: 1, step: 0.01, default: 0.04, showIf: "transparentBackground" },
    ],
    passes: [{
      key: "cloudTexture",
      fragmentShader: `
        uniform sampler2D tDiffuse; uniform float uScale; uniform float uDetail; uniform float uRoughness; uniform float uLacunarity; uniform float uDistortion; uniform float uContrast; uniform float uBias; uniform float uSeed; uniform float uInvert; uniform float uTransparentBackground; uniform float uThreshold; varying vec2 vUv; ${NOISE_GLSL}
        void main() {
          vec2 uv = fract(vUv);
          vec2 tilePeriod = max(vec2(1.0), floor(vec2(uScale) + 0.5));
          vec2 p = uv * tilePeriod + vec2(uSeed, uSeed * 0.37);
          float warpA = fxTileNoise(p + 8.1, tilePeriod);
          float warpB = fxTileNoise(p + 19.7, tilePeriod);
          vec2 warp = vec2(warpA, warpB) - 0.5;
          p += warp * uDistortion;
          float n = 0.0; float amplitude = 0.5; float total = 0.0;
          for (int i = 0; i < 8; i++) {
            if (float(i) >= uDetail) break;
            float octave = fxTileNoise(p, tilePeriod);
            n += amplitude * octave; total += amplitude; p *= uLacunarity; tilePeriod *= uLacunarity; amplitude *= uRoughness;
          }
          n /= max(total, 0.0001);
          n = clamp((n - 0.5 + uBias) * uContrast + 0.5, 0.0, 1.0);
          if (uInvert > 0.5) n = 1.0 - n;
          float alpha = uTransparentBackground > 0.5 ? smoothstep(uThreshold, min(1.0, uThreshold + 0.03), n) : 1.0;
          gl_FragColor = vec4(vec3(n) * alpha, alpha);
        }`,
      updateUniforms(u, p) {
        u.uScale.value = p.scale; u.uDetail.value = p.detail; u.uRoughness.value = p.roughness; u.uLacunarity.value = p.lacunarity; u.uDistortion.value = p.distortion; u.uContrast.value = p.contrast; u.uBias.value = p.bias; u.uSeed.value = p.seed; u.uInvert.value = p.invert ? 1 : 0; u.uTransparentBackground.value = p.transparentBackground ? 1 : 0; u.uThreshold.value = p.threshold;
      },
    }],
  },
  {
    id: "voronoiTexture",
    label: "Voronoi",
    group: "Generate",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="m3 3 4 2 3-2 3 3-2 4 2 3-4 1-3-2-3 1-1-4z"/></svg>`,
    params: [
      { key: "scale", label: "Cell Scale", min: 1, max: 150, step: 1, default: 12 },
      { key: "feature", label: "Feature", type: "select", default: "distance", options: [{ value: "distance", label: "Distance to Edge" }, { value: "f1", label: "F1 Distance" }, { value: "f2", label: "F2 Distance" }, { value: "crackle", label: "Crackle" }] },
      { key: "metric", label: "Distance Metric", type: "select", default: "euclidean", options: [{ value: "euclidean", label: "Euclidean" }, { value: "manhattan", label: "Manhattan" }, { value: "chebyshev", label: "Chebyshev" }] },
      { key: "edgeWidth", label: "Edge Width", min: 0.005, max: 0.5, step: 0.005, default: 0.12, showIf: (p) => p.feature === "distance" },
      { key: "jitter", label: "Jitter", min: 0, max: 1, step: 0.01, default: 0.8 },
      { key: "randomness", label: "Randomness", min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: "offsetX", label: "Offset X", min: -5, max: 5, step: 0.01, default: 0 },
      { key: "offsetY", label: "Offset Y", min: -5, max: 5, step: 0.01, default: 0 },
      { key: "contrast", label: "Contrast", min: 0.1, max: 5, step: 0.05, default: 1 },
      { key: "seed", label: "Seed", min: 0, max: 100, step: 0.1, default: 3 },
      { key: "invert", label: "Invert", type: "toggle", default: false },
      { key: "transparentBackground", label: "Transparent Black", type: "toggle", default: false },
      { key: "threshold", label: "Transparency Threshold", min: 0, max: 1, step: 0.01, default: 0.04, showIf: "transparentBackground" },
    ],
    passes: [{
      key: "voronoiTexture",
      fragmentShader: `
        uniform sampler2D tDiffuse; uniform float uScale; uniform float uFeature; uniform float uMetric; uniform float uEdgeWidth; uniform float uJitter; uniform float uRandomness; uniform vec2 uOffset; uniform float uContrast; uniform float uSeed; uniform float uInvert; uniform float uTransparentBackground; uniform float uThreshold; varying vec2 vUv; ${NOISE_GLSL}
        void main() {
          vec2 p = vUv * uScale + uOffset + uSeed; vec2 ip = floor(p); vec2 fp = fract(p); float first = 2.0; float second = 2.0;
          for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
            vec2 cell = vec2(float(x), float(y)); vec2 point = mix(vec2(0.5), fxHash2(ip + cell + uSeed) * mix(1.0, fxHash(ip + cell + 4.2), uRandomness), uJitter); vec2 diff = abs(cell + point - fp); float d = uMetric < 0.5 ? length(diff) : uMetric < 1.5 ? diff.x + diff.y : max(diff.x, diff.y);
            if (d < first) { second = first; first = d; } else if (d < second) second = d;
          }
          float n = uFeature < 0.5 ? smoothstep(0.0, max(0.001, uEdgeWidth), second - first) : uFeature < 1.5 ? first : uFeature < 2.5 ? second : second - first;
          n = clamp((n - 0.5) * uContrast + 0.5, 0.0, 1.0); if (uInvert > 0.5) n = 1.0 - n;
          float alpha = uTransparentBackground > 0.5 ? smoothstep(uThreshold, min(1.0, uThreshold + 0.03), n) : 1.0;
          gl_FragColor = vec4(vec3(n) * alpha, alpha);
        }`,
      updateUniforms(u, p) {
        u.uScale.value = p.scale; u.uFeature.value = p.feature === "f1" ? 1 : p.feature === "f2" ? 2 : p.feature === "crackle" ? 3 : 0; u.uMetric.value = p.metric === "manhattan" ? 1 : p.metric === "chebyshev" ? 2 : 0; u.uEdgeWidth.value = p.edgeWidth; u.uJitter.value = p.jitter; u.uRandomness.value = p.randomness; u.uOffset.value.set(p.offsetX, p.offsetY); u.uContrast.value = p.contrast; u.uSeed.value = p.seed; u.uInvert.value = p.invert ? 1 : 0; u.uTransparentBackground.value = p.transparentBackground ? 1 : 0; u.uThreshold.value = p.threshold;
      },
    }],
  },
  {
    id: "checkerTexture",
    label: "Checker",
    group: "Generate",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M2 2h12v12H2zM2 8h12M8 2v12"/><path d="M2 2h6v6H2zm6 6h6v6H8z" fill="currentColor" stroke="none" opacity=".45"/></svg>`,
    params: [
      { key: "size", label: "Size", min: 1, max: 100, step: 1, default: 12 },
      { key: "aspect", label: "Aspect", min: 0.2, max: 5, step: 0.05, default: 1 },
      { key: "angle", label: "Angle", min: 0, max: 360, step: 1, default: 0 },
      { key: "softness", label: "Softness", min: 0, max: 0.2, step: 0.005, default: 0 },
      { key: "offsetX", label: "Offset X", min: -2, max: 2, step: 0.01, default: 0 },
      { key: "offsetY", label: "Offset Y", min: -2, max: 2, step: 0.01, default: 0 },
      { key: "invert", label: "Invert", type: "toggle", default: false },
      { key: "transparentBackground", label: "Transparent Black", type: "toggle", default: false },
      { key: "threshold", label: "Transparency Threshold", min: 0, max: 1, step: 0.01, default: 0.04, showIf: "transparentBackground" },
    ],
    passes: [{
      key: "checkerTexture",
      fragmentShader: `
        uniform sampler2D tDiffuse; uniform float uSize; uniform float uAspect; uniform float uAngle; uniform float uSoftness; uniform vec2 uOffset; uniform float uInvert; uniform float uTransparentBackground; uniform float uThreshold; varying vec2 vUv;
        void main() {
          float c = cos(uAngle); float s = sin(uAngle); vec2 p = mat2(c, -s, s, c) * (vUv - 0.5 + uOffset); p.x *= uAspect; p = p * uSize + 0.5 * uSize;
          vec2 cell = fract(p); float parity = mod(floor(p.x) + floor(p.y), 2.0); float edge = min(min(cell.x, cell.y), min(1.0 - cell.x, 1.0 - cell.y)); float n = mix(parity, parity, smoothstep(0.0, max(0.0001, uSoftness), edge));
          if (uInvert > 0.5) n = 1.0 - n; float alpha = uTransparentBackground > 0.5 ? smoothstep(uThreshold, min(1.0, uThreshold + 0.03), n) : 1.0; gl_FragColor = vec4(vec3(n) * alpha, alpha);
        }`,
      updateUniforms(u, p) {
        u.uSize.value = p.size; u.uAspect.value = p.aspect; u.uAngle.value = p.angle * Math.PI / 180; u.uSoftness.value = p.softness; u.uOffset.value.set(p.offsetX, p.offsetY); u.uInvert.value = p.invert ? 1 : 0; u.uTransparentBackground.value = p.transparentBackground ? 1 : 0; u.uThreshold.value = p.threshold;
      },
    }],
  },
  {
    id: "stripesTexture",
    label: "Stripes",
    group: "Generate",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M2 4h12M2 8h12M2 12h12"/></svg>`,
    params: [
      { key: "frequency", label: "Frequency", min: 1, max: 100, step: 1, default: 18 },
      { key: "width", label: "Stripe Width", min: 0.05, max: 0.95, step: 0.01, default: 0.5 },
      { key: "angle", label: "Angle", min: 0, max: 360, step: 1, default: 0 },
      { key: "softness", label: "Softness", min: 0, max: 0.3, step: 0.005, default: 0.02 },
      { key: "offset", label: "Offset", min: -2, max: 2, step: 0.01, default: 0 },
      { key: "invert", label: "Invert", type: "toggle", default: false },
      { key: "transparentBackground", label: "Transparent Black", type: "toggle", default: false },
      { key: "threshold", label: "Transparency Threshold", min: 0, max: 1, step: 0.01, default: 0.04, showIf: "transparentBackground" },
    ],
    passes: [{
      key: "stripesTexture",
      fragmentShader: `
        uniform sampler2D tDiffuse; uniform float uFrequency; uniform float uWidth; uniform float uAngle; uniform float uSoftness; uniform float uOffset; uniform float uInvert; uniform float uTransparentBackground; uniform float uThreshold; varying vec2 vUv;
        void main() {
          vec2 dir = vec2(cos(uAngle), sin(uAngle)); float wave = fract(dot(vUv - 0.5, dir) * uFrequency + uOffset);
          float n = 1.0 - smoothstep(uWidth, min(1.0, uWidth + uSoftness), wave); if (uInvert > 0.5) n = 1.0 - n; float alpha = uTransparentBackground > 0.5 ? smoothstep(uThreshold, min(1.0, uThreshold + 0.03), n) : 1.0; gl_FragColor = vec4(vec3(n) * alpha, alpha);
        }`,
      updateUniforms(u, p) {
        u.uFrequency.value = p.frequency; u.uWidth.value = p.width; u.uAngle.value = p.angle * Math.PI / 180; u.uSoftness.value = p.softness; u.uOffset.value = p.offset; u.uInvert.value = p.invert ? 1 : 0; u.uTransparentBackground.value = p.transparentBackground ? 1 : 0; u.uThreshold.value = p.threshold;
      },
    }],
  },
  {
    id: "rippleTexture",
    label: "Ripple",
    group: "Generate",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="8" cy="8" r="2"/><circle cx="8" cy="8" r="4.5"/><circle cx="8" cy="8" r="6.5"/></svg>`,
    params: [
      { key: "frequency", label: "Frequency", min: 1, max: 80, step: 0.5, default: 18 },
      { key: "strength", label: "Strength", min: 0, max: 1, step: 0.01, default: 0.75 },
      { key: "centerX", label: "Center X", min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: "centerY", label: "Center Y", min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: "invert", label: "Invert", type: "toggle", default: false },
      { key: "transparentBackground", label: "Transparent Black", type: "toggle", default: false },
    ],
    passes: [{ key: "rippleTexture", fragmentShader: `uniform float uFrequency; uniform float uStrength; uniform vec2 uCenter; uniform float uInvert; uniform float uTransparentBackground; varying vec2 vUv; void main(){float n=0.5+0.5*sin(length(vUv-uCenter)*uFrequency*6.2831853)*uStrength;if(uInvert>.5)n=1.-n;float a=uTransparentBackground>.5?n:1.;gl_FragColor=vec4(vec3(n)*a,a);}`, updateUniforms(u,p){u.uFrequency.value=p.frequency;u.uStrength.value=p.strength;u.uCenter.value.set(p.centerX,p.centerY);u.uInvert.value=p.invert?1:0;u.uTransparentBackground.value=p.transparentBackground?1:0;} }],
  },
  {
    id: "radialTexture",
    label: "Radial",
    group: "Generate",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M8 2v12M2 8h12M3.8 3.8l8.4 8.4M12.2 3.8l-8.4 8.4"/><circle cx="8" cy="8" r="2"/></svg>`,
    params: [
      { key: "frequency", label: "Rays", min: 2, max: 64, step: 1, default: 12 },
      { key: "angle", label: "Rotation", min: 0, max: 360, step: 1, default: 0 },
      { key: "centerX", label: "Center X", min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: "centerY", label: "Center Y", min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: "invert", label: "Invert", type: "toggle", default: false },
      { key: "transparentBackground", label: "Transparent Black", type: "toggle", default: false },
    ],
    passes: [{ key: "radialTexture", fragmentShader: `uniform float uFrequency;uniform float uAngle;uniform vec2 uCenter;uniform float uInvert;uniform float uTransparentBackground;varying vec2 vUv;void main(){float n=.5+.5*cos(atan(vUv.y-uCenter.y,vUv.x-uCenter.x)*uFrequency+uAngle);if(uInvert>.5)n=1.-n;float a=uTransparentBackground>.5?n:1.;gl_FragColor=vec4(vec3(n)*a,a);}`, updateUniforms(u,p){u.uFrequency.value=p.frequency;u.uAngle.value=p.angle*Math.PI/180;u.uCenter.value.set(p.centerX,p.centerY);u.uInvert.value=p.invert?1:0;u.uTransparentBackground.value=p.transparentBackground?1:0;} }],
  },
  {
    id: "fbmTexture",
    label: "Fractal Brownian",
    group: "Generate",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M2 11c2-6 3 2 5-4s3 4 7-5"/></svg>`,
    params: [
      { key: "scale", label: "Scale", min: 0.25, max: 60, step: 0.25, default: 8 },
      { key: "detail", label: "Octaves", min: 1, max: 8, step: 1, default: 5 },
      { key: "roughness", label: "Roughness", min: 0.05, max: 0.95, step: 0.01, default: 0.5 },
      { key: "lacunarity", label: "Lacunarity", min: 1.2, max: 4, step: 0.05, default: 2 },
      { key: "seed", label: "Seed", min: 0, max: 100, step: .1, default: 0 },
      { key: "invert", label: "Invert", type: "toggle", default: false },
      { key: "transparentBackground", label: "Transparent Black", type: "toggle", default: false },
    ],
    passes: [{ key: "fbmTexture", fragmentShader: `uniform float uScale,uDetail,uRoughness,uLacunarity,uSeed,uInvert,uTransparentBackground;varying vec2 vUv;${NOISE_GLSL}void main(){vec2 p=vUv*uScale+uSeed;float n=0.,a=.5,t=0.;for(int i=0;i<8;i++){if(float(i)>=uDetail)break;n+=a*fxNoise(p);t+=a;p*=uLacunarity;a*=uRoughness;}n/=max(t,.0001);if(uInvert>.5)n=1.-n;float alpha=uTransparentBackground>.5?n:1.;gl_FragColor=vec4(vec3(n)*alpha,alpha);}`, updateUniforms(u,p){u.uScale.value=p.scale;u.uDetail.value=p.detail;u.uRoughness.value=p.roughness;u.uLacunarity.value=p.lacunarity;u.uSeed.value=p.seed;u.uInvert.value=p.invert?1:0;u.uTransparentBackground.value=p.transparentBackground?1:0;} }],
  },
  {
    id: "domainWarpTexture",
    label: "Domain Warping",
    group: "Generate",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M2 4c4-3 7 4 12 0M2 8c4-3 7 4 12 0M2 12c4-3 7 4 12 0"/></svg>`,
    params: [
      { key: "scale", label: "Scale", min: .25, max: 40, step: .25, default: 5 },
      { key: "strength", label: "Warp Strength", min: 0, max: 5, step: .05, default: 1.5 },
      { key: "detail", label: "Detail", min: 1, max: 8, step: 1, default: 4 },
      { key: "seed", label: "Seed", min: 0, max: 100, step: .1, default: 0 },
      { key: "invert", label: "Invert", type: "toggle", default: false },
      { key: "transparentBackground", label: "Transparent Black", type: "toggle", default: false },
    ],
    passes: [{
      key: "domainWarpTexture",
      fragmentShader: `
        uniform float uScale,uStrength,uDetail,uSeed,uInvert,uTransparentBackground;
        varying vec2 vUv;
        ${NOISE_GLSL}
        float fxWarpFbm(vec2 p) {
          float value = 0.0;
          float amplitude = 0.5;
          float total = 0.0;
          for (int i = 0; i < 8; i++) {
            if (float(i) >= uDetail) break;
            value += amplitude * fxNoise(p);
            total += amplitude;
            p = p * 2.03 + vec2(1.7, 9.2);
            amplitude *= 0.5;
          }
          return value / max(total, 0.0001);
        }
        void main() {
          vec2 p = (vUv - 0.5) * uScale + vec2(uSeed, uSeed * 1.37);
          vec2 q = vec2(
            fxWarpFbm(p + vec2(0.0, 0.0)),
            fxWarpFbm(p + vec2(5.2, 1.3))
          ) * 2.0 - 1.0;
          vec2 r = vec2(
            fxWarpFbm(p + uStrength * q + vec2(1.7, 9.2)),
            fxWarpFbm(p + uStrength * q + vec2(8.3, 2.8))
          ) * 2.0 - 1.0;
          float n = fxWarpFbm(p + uStrength * r);
          if (uInvert > 0.5) n = 1.0 - n;
          float alpha = uTransparentBackground > 0.5 ? n : 1.0;
          gl_FragColor = vec4(vec3(n) * alpha, alpha);
        }
      `,
      updateUniforms(u, p) {
        u.uScale.value = p.scale;
        u.uStrength.value = p.strength;
        u.uDetail.value = p.detail;
        u.uSeed.value = p.seed;
        u.uInvert.value = p.invert ? 1 : 0;
        u.uTransparentBackground.value = p.transparentBackground ? 1 : 0;
      },
    }],
  },
  {
    id: "worleyTexture",
    label: "Worley",
    group: "Generate",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="4" cy="5" r="1.5"/><circle cx="11" cy="4" r="1"/><circle cx="9" cy="11" r="2"/><circle cx="3.5" cy="11.5" r=".8"/></svg>`,
    params: [
      { key: "scale", label: "Scale", min: 1, max: 100, step: 1, default: 15 },
      { key: "jitter", label: "Jitter", min: 0, max: 1, step: .01, default: .85 },
      { key: "contrast", label: "Contrast", min: .1, max: 5, step: .05, default: 1.5 },
      { key: "seed", label: "Seed", min: 0, max: 100, step: .1, default: 0 },
      { key: "invert", label: "Invert", type: "toggle", default: false },
      { key: "transparentBackground", label: "Transparent Black", type: "toggle", default: false },
    ],
    passes: [{ key: "worleyTexture", fragmentShader: `uniform float uScale,uJitter,uContrast,uSeed,uInvert,uTransparentBackground;varying vec2 vUv;${NOISE_GLSL}void main(){vec2 p=vUv*uScale+uSeed,ip=floor(p),fp=fract(p);float d=2.;for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){vec2 c=vec2(float(x),float(y));vec2 q=mix(vec2(.5),fxHash2(ip+c),uJitter);d=min(d,length(c+q-fp));}float n=clamp((1.-d-.5)*uContrast+.5,0.,1.);if(uInvert>.5)n=1.-n;float a=uTransparentBackground>.5?n:1.;gl_FragColor=vec4(vec3(n)*a,a);}`, updateUniforms(u,p){u.uScale.value=p.scale;u.uJitter.value=p.jitter;u.uContrast.value=p.contrast;u.uSeed.value=p.seed;u.uInvert.value=p.invert?1:0;u.uTransparentBackground.value=p.transparentBackground?1:0;} }],
  },
  {
    id: "ifsFractalTexture",
    label: "Fractal (IFS)",
    group: "Generate",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="m8 2 5 10H3z"/><path d="m8 5 2 4H6z"/></svg>`,
    params: [
      { key: "scale", label: "Scale", min: .2, max: 8, step: .01, default: 1 },
      { key: "detail", label: "Iterations", min: 1, max: 12, step: 1, default: 7 },
      { key: "angle", label: "Rotation", min: 0, max: 360, step: 1, default: 0 },
      { key: "centerX", label: "Center X", min: -2, max: 2, step: .01, default: 0 },
      { key: "centerY", label: "Center Y", min: -2, max: 2, step: .01, default: 0 },
      { key: "aspect", label: "Horizontal Stretch", min: .25, max: 4, step: .01, default: 1 },
      { key: "fold", label: "Fold", min: 1.1, max: 3, step: .01, default: 2 },
      { key: "sharpness", label: "Sharpness", min: 4, max: 36, step: .1, default: 18 },
      { key: "invert", label: "Invert", type: "toggle", default: false },
      { key: "transparentBackground", label: "Transparent Black", type: "toggle", default: false },
    ],
    passes: [{
      key: "ifsFractalTexture",
      fragmentShader: `
        uniform float uScale,uDetail,uAngle,uCenterX,uCenterY,uAspect,uFold,uSharpness,uInvert,uTransparentBackground;
        varying vec2 vUv;
        void main() {
          // Dividing by Scale makes larger values reveal a closer, more detailed view.
          vec2 p = (vUv - .5) / max(uScale, .0001) - vec2(uCenterX, uCenterY);
          p.x /= max(uAspect, .0001);
          float c = cos(uAngle), s = sin(uAngle);
          p = mat2(c, -s, s, c) * p;
          float n = 0.;
          for (int i = 0; i < 12; i++) {
            if (float(i) >= uDetail) break;
            p = abs(p) * uFold - vec2(uFold - 1.);
            n += exp(-uSharpness * dot(p, p));
          }
          n = clamp(n / uDetail, 0., 1.);
          if (uInvert > .5) n = 1. - n;
          float a = uTransparentBackground > .5 ? n : 1.;
          gl_FragColor = vec4(vec3(n) * a, a);
        }
      `,
      updateUniforms(u, p) {
        u.uScale.value = p.scale;
        u.uDetail.value = p.detail;
        u.uAngle.value = p.angle * Math.PI / 180;
        u.uCenterX.value = p.centerX;
        u.uCenterY.value = p.centerY;
        u.uAspect.value = p.aspect;
        u.uFold.value = p.fold;
        u.uSharpness.value = p.sharpness;
        u.uInvert.value = p.invert ? 1 : 0;
        u.uTransparentBackground.value = p.transparentBackground ? 1 : 0;
      },
    }],
  },
  {
    id: "reactionDiffusionTexture",
    label: "Reaction-Diffusion",
    group: "Generate",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M3 5c2-3 4 3 6 0s3 2 4-1M3 10c2-3 4 3 6 0s3 2 4-1"/><circle cx="5" cy="5" r=".8"/><circle cx="10" cy="10" r=".8"/></svg>`,
    params: [
      { key: "scale", label: "Scale", min: 1, max: 80, step: 1, default: 18 },
      { key: "detail", label: "Iterations", min: 1, max: 12, step: 1, default: 6 },
      { key: "strength", label: "Feed", min: .1, max: 3, step: .01, default: 1 },
      { key: "seed", label: "Seed", min: 0, max: 100, step: .1, default: 0 },
      { key: "invert", label: "Invert", type: "toggle", default: false },
      { key: "transparentBackground", label: "Transparent Black", type: "toggle", default: false },
    ],
    passes: [{ key: "reactionDiffusionTexture", fragmentShader: `uniform float uScale,uDetail,uStrength,uSeed,uInvert,uTransparentBackground;varying vec2 vUv;${NOISE_GLSL}void main(){vec2 p=vUv*uScale+uSeed;float n=fxNoise(p);for(int i=0;i<12;i++){if(float(i)>=uDetail)break;float a=fxNoise(p+n*4.);n=abs(a-n*uStrength);p=p*1.73+vec2(2.1,1.3);}n=clamp(n*1.8,0.,1.);if(uInvert>.5)n=1.-n;float a=uTransparentBackground>.5?n:1.;gl_FragColor=vec4(vec3(n)*a,a);}`, updateUniforms(u,p){u.uScale.value=p.scale;u.uDetail.value=p.detail;u.uStrength.value=p.strength;u.uSeed.value=p.seed;u.uInvert.value=p.invert?1:0;u.uTransparentBackground.value=p.transparentBackground?1:0;} }],
  },
  {
    id: "fill",
    label: "Fill",
    group: "Generate",
    icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="m4.1 8.1 4-4 4 4-4 4z"/><path d="M4.1 8.1v3.8L8.1 15l4-3.1V8.1"/></svg>`,
    params: [
      {
        key: "fillType",
        label: "Fill type",
        type: "select",
        default: "solid",
        options: [
          { value: "solid", label: "Solid" },
          { value: "linear", label: "Linear gradient" },
          { value: "radial", label: "Radial gradient" },
        ],
      },
      { key: "color", label: "Color A", type: "color", default: "#405d50" },
      { key: "colorB", label: "Color B", type: "color", default: "#c4a76b", showIf: (p) => p.fillType !== "solid" },
      { key: "angle", label: "Angle", min: 0, max: 360, step: 1, default: 45, showIf: (p) => p.fillType === "linear" },
      { key: "opacity", label: "Opacity", min: 0, max: 1, step: 0.01, default: 1 },
    ],
    passes: [
      {
        key: "fill",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform vec3 uColorA;
          uniform vec3 uColorB;
          uniform float uType;
          uniform float uAngle;
          uniform float uOpacity;
          varying vec2 vUv;
          void main() {
            vec4 base = texture2D(tDiffuse, vUv);
            float t = 0.0;
            if (uType < 0.5) t = 0.0;
            else if (uType < 1.5) t = dot(vUv - 0.5, vec2(cos(uAngle), sin(uAngle))) + 0.5;
            else t = length(vUv - 0.5) * 1.41421356;
            vec3 fillColor = mix(uColorA, uColorB, clamp(t, 0.0, 1.0));
            gl_FragColor = vec4(mix(base.rgb, fillColor, uOpacity), base.a);
          }
        `,
        updateUniforms(u, params) {
          const colorA = hexToRgb01(params.color);
          const colorB = hexToRgb01(params.colorB);
          u.uColorA.value.set(colorA[0], colorA[1], colorA[2]);
          u.uColorB.value.set(colorB[0], colorB[1], colorB[2]);
          u.uType.value = params.fillType === "linear" ? 1 : params.fillType === "radial" ? 2 : 0;
          u.uAngle.value = params.angle * Math.PI / 180;
          u.uOpacity.value = params.opacity;
        },
      },
    ],
  },
];

export function getFilterDef(id) {
  return FILTER_DEFS.find((f) => f.id === id) || null;
}

FILTER_DEFS.forEach((definition) => {
  if (definition.group === "Generate") {
    definition.passes.forEach((pass) => {
      pass.matchAspect = true;
    });
  }
});

// Walks backward from a filter instance's position in the active stack (base-pass-first
// order) to find the nearest earlier ENABLED filter belonging to the "Distort" group.
// Used by UV Blur to auto-derive its blur direction field from whatever distortion was
// already applied to the image below it, instead of requiring a manually-picked noise map.
function findPrecedingDistort(ctx) {
  if (!ctx || !ctx.stack || !ctx.instance) return null;
  const idx = ctx.stack.indexOf(ctx.instance);
  if (idx < 0) return null;
  for (let i = idx - 1; i >= 0; i--) {
    const inst = ctx.stack[i];
    if (!inst.enabled) continue;
    const def = getFilterDef(inst.defId);
    if (def && def.group === "Distort") return { inst, def };
  }
  return null;
}

export function defaultParamsFor(defId) {
  const def = getFilterDef(defId);
  if (!def) return {};
  const out = {};
  def.params.forEach((p) => {
    // Deep-clone object-valued defaults (e.g. curve control points, which nest an
    // array of point objects) so separate filter instances of the same type never
    // end up sharing/mutating one shared object/array by reference.
    out[p.key] = p.default && typeof p.default === "object" ? JSON.parse(JSON.stringify(p.default)) : p.default;
  });
  return out;
}

const PASSTHROUGH_FRAGMENT = `
  uniform sampler2D tDiffuse;
  varying vec2 vUv;
  void main() { gl_FragColor = texture2D(tDiffuse, vUv); }
`;

// ─── Compositor: owns the WebGL context, ping-pong targets, and per-pass materials ──
export class FilterCompositor {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: false, antialias: false, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    // Surface real GLSL compile/link errors to the console instead of failing silently.
    // A shader compile failure commonly shows up visually as a blank/solid-color frame
    // with zero JS exceptions, so this is the single most useful diagnostic we can add.
    this.renderer.debug.onShaderError = (gl, program, vs, fs) => {
      const vsLog = gl.getShaderInfoLog(vs);
      const fsLog = gl.getShaderInfoLog(fs);
      const prgLog = gl.getProgramInfoLog(program);
      console.error(
        "[postfx] Shader compile/link error:\n--- vertex log ---\n" + vsLog +
        "\n--- fragment log ---\n" + fsLog +
        "\n--- program log ---\n" + prgLog
      );
    };
    canvas.addEventListener("webglcontextlost", this._onContextLost = (e) => {
      e.preventDefault();
      console.error("[postfx] WebGL context lost on compositor canvas.");
    });
    canvas.addEventListener("webglcontextrestored", this._onContextRestored = () => {
      console.warn("[postfx] WebGL context restored on compositor canvas.");
    });
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: PASSTHROUGH_FRAGMENT,
      uniforms: { tDiffuse: { value: null } },
    }));
    this.scene.add(this.quad);

    this.materialCache = new Map(); // passKey -> ShaderMaterial
    this.canvasTexture = null;
    this.sourceCanvas = null;
    this.sourceWidth = 0;
    this.sourceHeight = 0;
    // Export capture can render at a higher pixel density, but filters should keep
    // the same visual footprint as the live viewer. This factor remaps uResolution
    // during a capture pass back to viewer-relative units.
    this.uniformResolutionScale = 1;
    this.rtA = null;
    this.rtB = null;
    this.width = 0;
    this.height = 0;
  }

  _materialFor(pass) {
    let mat = this.materialCache.get(pass.key);
    if (!mat) {
      mat = new THREE.ShaderMaterial({
        vertexShader: VERTEX_SHADER,
        fragmentShader: fragmentShaderForPass(pass),
        uniforms: {
          tDiffuse: { value: null },
          uResolution: { value: new THREE.Vector2(1, 1) },
          uMatchRatio: { value: 0 },
          uAspectRatio: { value: 1 },
          uTime: { value: 0 },
          uThreshold: { value: 0.5 },
          uIntensity: { value: 1 },
          uRadius: { value: 1 },
          uSteps: { value: 4 },
          uAmount: { value: 0 },
          uBlend: { value: 0 },
          uBlur: { value: 0 },
          uBulge: { value: 0 },
          uPinch: { value: 0 },
          uUseCurve: { value: 0 },
          uEdge: { value: 0 },
          uScale: { value: 1 },
          uDetail: { value: 4 },
          uLacunarity: { value: 2 },
          uDistortion: { value: 0 },
          uSeed: { value: 0 },
          uTransparentBackground: { value: 0 },
          uSpeed: { value: 0 },
          uDirection: { value: new THREE.Vector2(1, 0) },
          uSize: { value: 8 },
          uDotSize: { value: 8 },
          uAngle: { value: 0 },
          uMono: { value: 0 },
          uVariation: { value: 0.35 },
          uStrength: { value: 0.35 },
          uOffset: { value: 0.5 },
          uShadowHue: { value: 220 },
          uHighlightHue: { value: 40 },
          uSaturation: { value: 0.65 },
          uMix: { value: 0.85 },
          uCurvePoints: { value: Array.from({ length: CURVE_MAX_POINTS }, () => new THREE.Vector4(0, 0, 0, 0)) },
          uCurveTans: { value: Array.from({ length: CURVE_MAX_POINTS }, () => new THREE.Vector4(0, 0, 0, 0)) },
          uCurveCount: { value: 2 },
          uEdgeShape: { value: 0 },
          uEdgeSoftness: { value: 0.35 },
          uNoiseType: { value: 0 },
          uSpin: { value: 0 },
          tImage: { value: null },
          uHasImage: { value: 0 },
          uMode: { value: 0 },
          tDistortImage: { value: null },
          uHasImageDistort: { value: 0 },
          uGradStops: { value: Array.from({ length: GRADIENT_MAX_STOPS }, () => new THREE.Vector4(0, 0, 0, 0)) },
          uGradCount: { value: 2 },
          uContrast: { value: 0 },
          uBrightness: { value: 0 },
          uBlackPoint: { value: 0 },
          uWhitePoint: { value: 1 },
          uGamma: { value: 1 },
          uHighlights: { value: 0 },
          uShadows: { value: 0 },
          uHueShift: { value: 0 },
          uSatScale: { value: 1 },
          uLightness: { value: 0 },
          uInvert: { value: 0 },
          uShape: { value: 0 },
          uColorMode: { value: 0 },
          uInkColor: { value: new THREE.Vector3(0, 0, 0) },
          uPaperColor: { value: new THREE.Vector3(1, 1, 1) },
          uRandomness: { value: 0 },
          uArc: { value: 0 },
          uArcPosition: { value: 0.5 },
          uRoughness: { value: 0 },
          uChroma: { value: 0 },
          uCenter: { value: new THREE.Vector2(0.5, 0.5) },
          uBlades: { value: 0 },
          uFocusPos: { value: 0.5 },
          uFocusWidth: { value: 0.2 },
          uFrequency: { value: 8 },
          uFalloff: { value: 1 },
          uTiltX: { value: 0 },
          uTiltY: { value: 0 },
          uJitter: { value: 0 },
          uStock: { value: 1 },
          uGrain: { value: 0.45 },
          uGrainSize: { value: 1.4 },
          uGrainAnimated: { value: 1 },
          uHalation: { value: 0.55 },
          uHaloSize: { value: 3.2 },
          uFade: { value: 0.08 },
          uTemperature: { value: 0 },
          uTintShift: { value: 0 },
          uVignette: { value: 0.4 },
          uBalance: { value: new THREE.Vector3(0, 0, 0) },
          uPreserveLuminosity: { value: 1 },
          // Oil Paint Strokes uniforms
          uBrushType: { value: 0 },
          uBrushSize: { value: 9 },
          uStrokeStrength: { value: 0.72 },
          uDetail: { value: 0.55 },
          uEdgeBlend: { value: 0.6 },
          uStrokePresence: { value: 0.65 },
        },
      });
      this.materialCache.set(pass.key, mat);
    }
    // Hot-reload/state-safe uniform backfill: if a material instance was created
    // before a filter gained new uniforms, ensure they exist before updateUniforms.
    if (pass.key === "oilPaint") {
      const u = mat.uniforms;
      if (!u.uBrushType) u.uBrushType = { value: 0 };
      if (!u.uBrushSize) u.uBrushSize = { value: 9 };
      if (!u.uStrokeStrength) u.uStrokeStrength = { value: 0.72 };
      if (!u.uDetail) u.uDetail = { value: 0.55 };
      if (!u.uEdgeBlend) u.uEdgeBlend = { value: 0.6 };
      if (!u.uStrokePresence) u.uStrokePresence = { value: 0.65 };
      if (!u.uMix) u.uMix = { value: 0.85 };
    }
    return mat;
  }

  // Lazily builds/caches a THREE.Texture for a filter instance's user-uploaded
  // displacement image (a data-URL string on instance.params.image). The texture
  // is cached directly on the instance object (not the shared material) since
  // multiple instances of the same filter type must be able to hold different
  // images while sharing one cached ShaderMaterial.
  getInstanceTexture(instance) {
    if (!instance) return null;
    const url = instance.params && instance.params.image;
    if (!url) {
      if (instance._glTex) {
        instance._glTex.dispose();
        instance._glTex = null;
        instance._glTexUrl = null;
      }
      return null;
    }
    if (instance._glTex && instance._glTexUrl === url) return instance._glTex;
    if (instance._glTex) instance._glTex.dispose();
    const img = new Image();
    const tex = new THREE.Texture(img);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    img.onload = () => {
      tex.needsUpdate = true;
    };
    img.src = url;
    instance._glTex = tex;
    instance._glTexUrl = url;
    return tex;
  }

  setSource(canvasEl) {
    if (this.sourceCanvas === canvasEl) return;
    this._recreateCanvasTexture(canvasEl);
    this._debugLoggedThisSource = false;
  }

  // Fully dispose + recreate the CanvasTexture (rather than relying on needsUpdate
  // on an existing GL texture). Chrome's ANGLE backend can use a GPU-side
  // glCopySubTextureCHROMIUM fast path for canvas-source texture uploads; if the
  // source canvas resizes (e.g. a project's renderer resizes on window resize)
  // while the destination texture is still allocated at the old dimensions, that
  // copy's offset overflows the texture and WebGL throws GL_INVALID_VALUE. A full
  // recreate forces a fresh allocation sized to the current source dimensions.
  _recreateCanvasTexture(canvasEl) {
    this.sourceCanvas = canvasEl;
    if (this.canvasTexture) this.canvasTexture.dispose();
    this.canvasTexture = canvasEl ? new THREE.CanvasTexture(canvasEl) : null;
    if (this.canvasTexture) {
      this.canvasTexture.minFilter = THREE.LinearFilter;
      this.canvasTexture.magFilter = THREE.LinearFilter;
      this.canvasTexture.generateMipmaps = false;
    }
    this.sourceWidth = canvasEl ? canvasEl.width : 0;
    this.sourceHeight = canvasEl ? canvasEl.height : 0;
  }

  resize(width, height) {
    if (width <= 0 || height <= 0) return;
    if (this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height, false);
    const pr = this.renderer.getPixelRatio();
    const rtW = Math.max(1, Math.floor(width * pr));
    const rtH = Math.max(1, Math.floor(height * pr));
    if (this.rtA) this.rtA.dispose();
    if (this.rtB) this.rtB.dispose();
    this.rtA = new THREE.WebGLRenderTarget(rtW, rtH, { depthBuffer: false, stencilBuffer: false });
    this.rtB = new THREE.WebGLRenderTarget(rtW, rtH, { depthBuffer: false, stencilBuffer: false });
  }

  // `stackOrderedBaseFirst` = filters in the order they should be applied (base pass first).
  renderFrame(stackOrderedBaseFirst, time) {
    if (!this.canvasTexture || !this.rtA || !this.rtB) return;

    // If the source canvas's own pixel dimensions changed since we last bound it
    // (e.g. the project's renderer resized), recreate the texture instead of
    // reusing the old GL allocation — otherwise Chrome's GPU-side canvas-copy
    // fast path can throw GL_INVALID_VALUE (offset overflows texture dimensions).
    const cw = this.sourceCanvas ? this.sourceCanvas.width : 0;
    const ch = this.sourceCanvas ? this.sourceCanvas.height : 0;
    if (cw !== this.sourceWidth || ch !== this.sourceHeight) {
      this._recreateCanvasTexture(this.sourceCanvas);
    }
    this.canvasTexture.needsUpdate = true;

    const passList = [];
    stackOrderedBaseFirst.forEach((instance) => {
      if (!instance.enabled) return;
      const def = getFilterDef(instance.defId);
      if (!def) return;
      def.passes.forEach((pass) => passList.push({ pass, params: instance.params, instance }));
    });

    const targets = [this.rtA, this.rtB];
    let srcTex = this.canvasTexture;
    let idx = 0;

    if (passList.length === 0) {
      // Passthrough straight to screen.
      const mat = this.quad.material;
      mat.uniforms.tDiffuse.value = srcTex;
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
      return;
    }

    passList.forEach(({ pass, params, instance }, i) => {
      const isLast = i === passList.length - 1;
      const material = this._materialFor(pass);
      material.uniforms.tDiffuse.value = srcTex;
      const resolutionScale = Math.max(1e-6, this.uniformResolutionScale || 1);
      material.uniforms.uResolution.value.set(this.rtA.width / resolutionScale, this.rtA.height / resolutionScale);
      pass.updateUniforms(material.uniforms, params, time, { instance, compositor: this, stack: stackOrderedBaseFirst });
      this.quad.material = material;

      const dstRT = isLast ? null : targets[idx % 2];
      this.renderer.setRenderTarget(dstRT);
      this.renderer.render(this.scene, this.camera);
      if (!isLast) {
        srcTex = dstRT.texture;
        idx += 1;
      }
    });

  }

  // Render the current filter stack once at `scale`× the compositor's current
  // CSS size and return a PNG data URL at that resolution. Temporarily bumps the
  // renderer's pixel ratio and rebuilds the ping-pong render targets, renders a
  // single frame, captures the buffer, then synchronously restores the original
  // pixel ratio/targets and re-renders at the normal resolution — all within one
  // JS turn, so the live on-screen canvas never visibly flashes to the scaled size.
  captureAtScale(stackOrderedBaseFirst, time, scale) {
    if (!this.width || !this.height) return null;
    const originalPR = this.renderer.getPixelRatio();
    const originalRtA = this.rtA;
    const originalRtB = this.rtB;

    const safeScale = Math.max(0.01, Number(scale) || 1);
    const targetPR = originalPR * safeScale;
    const rtW = Math.max(1, Math.floor(this.width * targetPR));
    const rtH = Math.max(1, Math.floor(this.height * targetPR));

    this.renderer.setPixelRatio(targetPR);
    this.renderer.setSize(this.width, this.height, false);
    this.rtA = new THREE.WebGLRenderTarget(rtW, rtH, { depthBuffer: false, stencilBuffer: false });
    this.rtB = new THREE.WebGLRenderTarget(rtW, rtH, { depthBuffer: false, stencilBuffer: false });

    let dataUrl = null;
    try {
      this.uniformResolutionScale = safeScale;
      this.renderFrame(stackOrderedBaseFirst, time);
      dataUrl = this.canvas.toDataURL("image/png");
    } finally {
      this.uniformResolutionScale = 1;
      this.rtA.dispose();
      this.rtB.dispose();
      this.rtA = originalRtA;
      this.rtB = originalRtB;
      this.renderer.setPixelRatio(originalPR);
      this.renderer.setSize(this.width, this.height, false);
      // Re-render at the original resolution so the live canvas reflects the
      // normal frame again rather than the last (scaled) one we just captured.
      this.renderFrame(stackOrderedBaseFirst, time);
    }
    return dataUrl ? { dataUrl, width: rtW, height: rtH } : null;
  }

  dispose() {
    this.materialCache.forEach((mat) => mat.dispose());
    this.materialCache.clear();
    if (this.canvasTexture) this.canvasTexture.dispose();
    if (this.rtA) this.rtA.dispose();
    if (this.rtB) this.rtB.dispose();
    if (this._onContextLost) this.canvas.removeEventListener("webglcontextlost", this._onContextLost);
    if (this._onContextRestored) this.canvas.removeEventListener("webglcontextrestored", this._onContextRestored);
    this.renderer.dispose();
  }
}
