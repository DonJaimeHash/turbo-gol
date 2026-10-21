/**
 * Load-time CPU bakes for the pitch: no image files, everything comes from fixed seeds and the field
 * layout of constants.ts. Pure functions on typed arrays (no three.js), so the node tests run them
 * (tests/turf.test.mjs); TurfView uploads the results as textures.
 *
 *   bladeField()   BLADE_FIELD_SIZE^2 tileable "blade field" seen from above (one tile = TURF_TILE uu):
 *                  R = blade height (0 soil .. 1 = GRASS_HEIGHT uu), G / B = surface normal x / z
 *                  (0.5 = flat), A = tint (a tileable clump noise mixed with a per-blade random
 *                  value). Uploaded with mipmaps and anisotropic filtering, so the GPU's filter
 *                  anti-aliases the blade detail: crisp blades at the car's feet, a calm average far
 *                  away, no shimmer at grazing angles. Baked once per page load (~140 ms), shared by
 *                  every TurfView (a tier switch rebuilds the views, not the bake).
 *   fieldMap()     FIELD_MAP over the whole floor: R = wear (trampled turf, bare soil in the goal
 *                  mouths), G = damp (wet patches, worse drainage near the walls), B = puddle basin
 *                  RANK (the share of the pitch lower than a texel equals its value, so a puddle
 *                  level of 0.2 floods 20 % of it), A = large-scale colour variation. Low frequency
 *                  only. Baked once per page load.
 *   bakePoolMap()  POOL_MAP: RGB = the theme's floodlight irradiance on the pitch (the pools of light,
 *                  sqrt-encoded over POOL_MAX), A = boost-pad mask (1 on a pad: the grass blades of
 *                  the ultra tier stay off the pads). Baked once per floodlight rig: TurfView keeps
 *                  each rig's map and swaps it into the pool texture on a theme change.
 *
 * Axes: three.js world space in uu (x across the field, z along it: sim y = three z; y up).
 */
import { ARENA, BOOST_PADS_BIG, BOOST_PADS_SMALL, BOOST_PAD_BIG_RADIUS, BOOST_PAD_SMALL_RADIUS, KICKOFF_SPAWNS } from '../../sim/constants';
import type { Floodlight } from '../theme';

/** uu covered by one tile of the blade field (40 cm). */
export const TURF_TILE = 40;
/** Texels per side of the blade field (a power of two: it tiles and mips cleanly). */
export const BLADE_FIELD_SIZE = 512;
/** Height of blade-field value 1.0 (uu): mown pitch turf is 25-30 mm, a little more reads better. */
export const GRASS_HEIGHT = 4;

/** A map over the floor: `w` x `h` texels covering x0..x0+sx (three x) and z0..z0+sz (three z). */
export interface FloorMapRect {
  readonly w: number;
  readonly h: number;
  readonly x0: number;
  readonly z0: number;
  readonly sx: number;
  readonly sz: number;
}

/** The whole floor, goal floors included (|z| <= 6560): 46 uu texels. */
export const FIELD_MAP: FloorMapRect = { w: 192, h: 288, x0: -ARENA.extentX, z0: -(ARENA.extentY + ARENA.goalDepth), sx: 2 * ARENA.extentX, sz: 2 * (ARENA.extentY + ARENA.goalDepth) };
/** Same rect, 50 uu texels (the pools are broad; the pad mask needs a few texels per pad). */
export const POOL_MAP: FloorMapRect = { w: 176, h: 264, x0: FIELD_MAP.x0, z0: FIELD_MAP.z0, sx: FIELD_MAP.sx, sz: FIELD_MAP.sz };
/** Irradiance stored as 1.0 in the pool map (rgb = sqrt(E / POOL_MAX): finer steps in the darks). */
export const POOL_MAX = 2;
/**
 * Distance (uu) at which a floodlight of strength 1 gives irradiance 1 on a surface facing it: the
 * unit of the pool map and of the turf's analytic streaks (an aimed head ~50 m from its pool).
 */
export const LAMP_REF_DISTANCE = 5000;

/** Flat floor (where the ramps start): the pitch whose basins are ranked for the puddles. */
const FLAT_HALF_X = ARENA.extentX - ARENA.sideRampRadius;
const FLAT_HALF_Z = ARENA.extentY - ARENA.backRampRadius;

// ---- deterministic noise ----------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One 256 x 256 lattice of random values; octaves and seeds read it at different offsets. */
let lattice: Float32Array | null = null;
function getLattice(): Float32Array {
  if (lattice === null) {
    const r = mulberry32(12345);
    lattice = new Float32Array(256 * 256);
    for (let i = 0; i < lattice.length; i++) lattice[i] = r();
  }
  return lattice;
}

/**
 * Smooth value noise in 0..1 (quintic fade). `period` (a power of two <= 256, 0 = none) makes it
 * tile every `period` cells, which the tileable blade field needs.
 */
function vnoise(x: number, y: number, seed: number, period = 0): number {
  const L = getLattice();
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const m = period > 0 ? period - 1 : 255;
  const ox = (seed * 37) & 255;
  const oy = (seed * 91) & 255;
  const x0 = ((ix & m) + ox) & 255;
  const x1 = (((ix + 1) & m) + ox) & 255;
  const y0 = (((iy & m) + oy) & 255) << 8;
  const y1 = ((((iy + 1) & m) + oy) & 255) << 8;
  const a = L[y0 + x0];
  const b = L[y0 + x1];
  const c = L[y1 + x0];
  const d = L[y1 + x1];
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** Fractal sum of `octaves` value-noise octaves, normalised to 0..1. */
function fbm(x: number, y: number, seed: number, octaves: number, period = 0): number {
  let s = 0;
  let amp = 0.5;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    s += amp * vnoise(x * f, y * f, seed + o * 17, period > 0 ? period * f : 0);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return s / norm;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const toByte = (v: number): number => Math.round(clamp01(v) * 255);

// ---- blade field --------------------------------------------------------------------------------

/**
 * Blades are tapered strokes seen from above: each has a root, a direction, a lean and a length; its
 * height rises from the root to the tip along the stroke (a blade leaning over shows a long stroke
 * that stays low, an upright one a short stroke that ends high). Overlaps keep the max, so the top
 * blade wins. Normals come from the height gradient plus a per-blade twist.
 */
export function bakeBladeField(size = BLADE_FIELD_SIZE, blades = 5200, seed = 7): Uint8Array {
  const N = size; // a power of two
  const M = N - 1;
  const pxPerUu = N / TURF_TILE;
  const H = new Float32Array(N * N); // height 0..1
  const ID = new Float32Array(N * N); // per-blade random value of the top blade
  const TW = new Float32Array(N * N); // per-blade twist (sideways normal tilt)
  const rnd = mulberry32(seed);
  const MAX_H = 5; // uu of the tallest tip in the bake (the shader maps 1.0 to GRASS_HEIGHT)
  for (let b = 0; b < blades; b++) {
    const rx = rnd() * N;
    const ry = rnd() * N;
    const ang = rnd() * Math.PI * 2;
    const lean = (0.1 + rnd() * 0.6) * (Math.PI / 2); // 9..63 degrees from vertical
    const len = 2.6 + rnd() * 2.6; // uu
    const tipH = (len * Math.cos(lean)) / MAX_H;
    const projLen = len * Math.sin(lean) * pxPerUu; // px
    const w0 = (0.18 + rnd() * 0.14) * pxPerUu; // half width at the root, px
    const id = rnd();
    const twist = rnd() * 2 - 1;
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    const steps = Math.max(2, Math.ceil(projLen));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      // Height along the blade: rises fast, flattens as the blade bends over.
      const h = tipH * Math.sin(t * Math.PI * 0.5) * (0.35 + 0.65 * t) + 0.04;
      const hw = w0 * Math.pow(1 - t, 0.6) + 0.35; // tapers to a point
      const cx = rx + dx * projLen * t;
      const cy = ry + dy * projLen * t;
      // Scan across the blade (perpendicular to its direction) in half-pixel steps.
      for (let a = -hw; a <= hw; a += 0.5) {
        const px = Math.round(cx - dy * a) & M;
        const py = Math.round(cy + dx * a) & M;
        const i = py * N + px;
        // Rounded cross-section: the midrib stands a little higher than the edges.
        const q = a / hw;
        const hh = h * (1 - 0.25 * q * q);
        if (hh > H[i]) {
          H[i] = hh;
          ID[i] = id;
          TW[i] = twist;
        }
      }
    }
  }

  const data = new Uint8Array(N * N * 4);
  const period = 8; // clump-noise cells per tile (a power of two: tileable)
  const k = (MAX_H * pxPerUu) / 2;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const h = Math.min(1, H[i]);
      // Central-difference gradient (wrapping), in height units per uu.
      const hx = H[y * N + ((x + 1) & M)] - H[y * N + ((x - 1 + N) & M)];
      const hy = H[((y + 1) & M) * N + x] - H[((y - 1 + N) & M) * N + x];
      let nx = -hx * k * 0.35 + TW[i] * 0.35 * (h > 0.05 ? 1 : 0);
      let nz = -hy * k * 0.35;
      const l = Math.sqrt(nx * nx + nz * nz + 1);
      nx /= l;
      nz /= l;
      const clump = fbm((x / N) * period, (y / N) * period, seed + 101, 3, period);
      data[i * 4] = toByte(h);
      data[i * 4 + 1] = toByte(nx * 0.5 + 0.5);
      data[i * 4 + 2] = toByte(nz * 0.5 + 0.5);
      data[i * 4 + 3] = toByte(clump * 0.7 + ID[i] * 0.3);
    }
  }
  return data;
}

let bladeFieldCache: Uint8Array | null = null;
/** The blade field, baked on first use and shared afterwards (read-only). */
export function bladeField(): Uint8Array {
  if (bladeFieldCache === null) bladeFieldCache = bakeBladeField();
  return bladeFieldCache;
}

// ---- field map ----------------------------------------------------------------------------------

/** Wear hot spots [x, z, radius, strength]: where the play concentrates (mirrored per half). */
function wearSpots(): Array<readonly [number, number, number, number]> {
  const s: Array<readonly [number, number, number, number]> = [
    [0, 0, 1000, 0.24], // kickoff circle: paler, trampled, never bare
    [0, 0, 300, 0.16],
  ];
  for (const g of [-1, 1]) {
    s.push([0, g * 5150, 900, 0.55]); // goal mouth: the most worn
    s.push([0, g * 4300, 900, 0.3]); // in front of the box
    s.push([-1800, g * 3300, 420, 0.3], [1800, g * 3300, 420, 0.3]); // kickoff wings
    s.push([-600, g * 4000, 360, 0.25], [600, g * 4000, 360, 0.25]);
    s.push([0, g * 6000, 700, 0.5]); // inside the goal
  }
  return s;
}

/** True on the flat pitch (the share used to rank the basins). */
function onFlatPitch(x: number, z: number): boolean {
  return Math.abs(x) <= FLAT_HALF_X && Math.abs(z) <= FLAT_HALF_Z;
}

/** Index of the first element of sorted `a` that is >= v. */
function lowerBound(a: Float32Array, v: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function bakeFieldMap(seed = 3): Uint8Array {
  const { w, h, x0, z0, sx, sz } = FIELD_MAP;
  const data = new Uint8Array(w * h * 4);
  const basin = new Float32Array(w * h);
  const spots = wearSpots();
  const flat: number[] = [];
  for (let j = 0; j < h; j++) {
    const z = z0 + ((j + 0.5) / h) * sz;
    for (let i = 0; i < w; i++) {
      const x = x0 + ((i + 0.5) / w) * sx;
      // Wear: gaussian hot spots broken up by noise, plus faint random scuffs.
      let wear = 0;
      for (let s = 0; s < spots.length; s++) {
        const sp = spots[s];
        const dx = x - sp[0];
        const dz = z - sp[1];
        const d2 = (dx * dx + dz * dz) / (sp[2] * sp[2]);
        if (d2 < 9) wear += sp[3] * Math.exp(-d2 * 1.4);
      }
      const wn = fbm(x / 520, z / 520, seed + 1, 3);
      wear = wear * (0.45 + 1.1 * wn) + Math.max(0, fbm(x / 900, z / 900, seed + 2, 2) - 0.62) * 1.2;
      // Damp: broad wet areas (worse drainage near the walls and in the corners).
      const edge = Math.max(Math.abs(x) / ARENA.extentX, Math.abs(z) / ARENA.extentY);
      const damp = fbm(x / 1900, z / 1900, seed + 3, 3) * 0.85 + edge * edge * 0.35;
      // Puddle basins: low spots of a smooth height field (low = water collects first).
      let b = fbm(x / 1150, z / 1150, seed + 4, 4);
      b = b * 0.85 + fbm(x / 340, z / 340, seed + 5, 2) * 0.15 - edge * 0.12 - Math.max(0, wear - 0.5) * 0.12;
      const hue = fbm(x / 650, z / 650, seed + 6, 3);
      const t = j * w + i;
      basin[t] = b;
      if (onFlatPitch(x, z)) flat.push(b);
      const o = t * 4;
      data[o] = toByte(wear);
      data[o + 1] = toByte(damp);
      data[o + 3] = toByte(hue);
    }
  }
  // Rank the basins over the flat pitch: B = the share of the pitch lower than this texel, so the
  // shader's puddle level IS the flooded share (0.2 -> 20 % of the pitch, before the soft edge).
  const sorted = Float32Array.from(flat).sort();
  for (let t = 0; t < w * h; t++) data[t * 4 + 2] = toByte(lowerBound(sorted, basin[t]) / sorted.length);
  return data;
}

let fieldMapCache: Uint8Array | null = null;
/** The field map, baked on first use and shared afterwards (read-only). */
export function fieldMap(): Uint8Array {
  if (fieldMapCache === null) fieldMapCache = bakeFieldMap();
  return fieldMapCache;
}

// ---- floodlight pools + pad mask ------------------------------------------------------------------

/** Beam profile of a floodlight head (angle from its aim axis): a core and a wide, weak spill. */
const BEAM_CORE = 0.3; // rad, gaussian sigma (~17 degrees)
const BEAM_SPILL = 0.75;
const SPILL_SHARE = 0.18;

/**
 * Irradiance (linear RGB, LAMP_REF_DISTANCE units) of `floodlights` on the flat pitch at (x, 0, z),
 * added into `out` (length >= 3).
 */
export function floodlightIrradiance(floodlights: readonly Floodlight[], x: number, z: number, out: Float64Array | Float32Array | number[]): void {
  for (let k = 0; k < floodlights.length; k++) {
    const f = floodlights[k];
    if (!(f.strength > 0)) continue;
    const px = f.position[0];
    const py = f.position[1];
    const pz = f.position[2];
    const tx = f.target[0];
    const ty = f.target[1];
    const tz = f.target[2];
    // Light vector from the ground point to the head; aim axis from the head to its target.
    const lx = px - x;
    const ly = py;
    const lz = pz - z;
    const d2 = lx * lx + ly * ly + lz * lz;
    const d = Math.sqrt(d2);
    if (!(d > 1) || ly <= 0) continue;
    const ax = tx - px;
    const ay = ty - py;
    const az = tz - pz;
    const al = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
    // Angle between the aim axis and the head -> point direction (= -L).
    const cosA = Math.max(-1, Math.min(1, (-lx * ax - ly * ay - lz * az) / (d * al)));
    // acos(c)^2 ~ 2(1 - c)(1 + (1 - c) / 3): within 1 % out to 60 degrees, no acos in the loop.
    const u = 1 - cosA;
    const ang2 = 2 * u * (1 + u / 3);
    const beam = Math.exp((-0.5 * ang2) / (BEAM_CORE * BEAM_CORE)) * (1 - SPILL_SHARE) + Math.exp((-0.5 * ang2) / (BEAM_SPILL * BEAM_SPILL)) * SPILL_SHARE;
    const e = (f.strength * beam * (ly / d) * LAMP_REF_DISTANCE * LAMP_REF_DISTANCE) / d2;
    out[0] += f.color[0] * e;
    out[1] += f.color[1] * e;
    out[2] += f.color[2] * e;
  }
}

/** Pad mask: 1 within PAD_MASK_IN x the pad radius, 0 beyond PAD_MASK_OUT x (the glow disc is 1.25x). */
const PAD_MASK_IN = 1.2;
const PAD_MASK_OUT = 1.5;

/** Pad mask at (x, z): 1 on a boost pad, smooth to 0 just outside its glow disc. */
export function padMask(x: number, z: number): number {
  let m = 0;
  const nBig = BOOST_PADS_BIG.length;
  for (let k = 0; k < nBig + BOOST_PADS_SMALL.length; k++) {
    // Pads are listed in sim coords: sim (x, y) = three (x, z).
    const p = k < nBig ? BOOST_PADS_BIG[k] : BOOST_PADS_SMALL[k - nBig];
    const r = k < nBig ? BOOST_PAD_BIG_RADIUS : BOOST_PAD_SMALL_RADIUS;
    const r0 = r * PAD_MASK_IN;
    const r1 = r * PAD_MASK_OUT;
    const dx = Math.abs(x - p[0]);
    const dz = Math.abs(z - p[1]);
    if (dx > r1 || dz > r1) continue;
    const t = clamp01((Math.sqrt(dx * dx + dz * dz) - r0) / (r1 - r0));
    const v = 1 - t * t * (3 - 2 * t);
    if (v > m) m = v;
  }
  return m;
}

/** The pad-mask channel of the pool map (static: baked once, copied into every re-bake). */
let padMaskCache: Uint8Array | null = null;
function padMaskBytes(): Uint8Array {
  if (padMaskCache === null) {
    const { w, h, x0, z0, sx, sz } = POOL_MAP;
    padMaskCache = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) {
      const z = z0 + ((j + 0.5) / h) * sz;
      for (let i = 0; i < w; i++) padMaskCache[j * w + i] = toByte(padMask(x0 + ((i + 0.5) / w) * sx, z));
    }
  }
  return padMaskCache;
}

/**
 * Bake the pool map of `floodlights` into `out` (allocated when absent). Texel (i, j) samples its
 * centre, like the GPU's bilinear filter.
 */
export function bakePoolMap(floodlights: readonly Floodlight[], out: Uint8Array = new Uint8Array(POOL_MAP.w * POOL_MAP.h * 4)): Uint8Array {
  const { w, h, x0, z0, sx, sz } = POOL_MAP;
  const pads = padMaskBytes();
  const lit = floodlights.filter((f) => f.strength > 0);
  const e = new Float64Array(3);
  for (let j = 0; j < h; j++) {
    const z = z0 + ((j + 0.5) / h) * sz;
    for (let i = 0; i < w; i++) {
      const x = x0 + ((i + 0.5) / w) * sx;
      e[0] = e[1] = e[2] = 0;
      floodlightIrradiance(lit, x, z, e);
      const t = j * w + i;
      const o = t * 4;
      out[o] = toByte(Math.sqrt(e[0] / POOL_MAX));
      out[o + 1] = toByte(Math.sqrt(e[1] / POOL_MAX));
      out[o + 2] = toByte(Math.sqrt(e[2] / POOL_MAX));
      out[o + 3] = pads[t];
    }
  }
  return out;
}

/** Decode one pool-map texel's rgb back to irradiance (what the shader does), for tests and tools. */
export function decodePool(byte: number): number {
  const s = byte / 255;
  return s * s * POOL_MAX;
}

/**
 * The `count` floodlights whose wet-turf streaks a tier draws: the heads farthest down the field
 * first (low in the view from either end, they make the long streaks down the pitch), padded with
 * dark slots so the shader's lamp count never changes with the theme.
 */
export function streakLamps(floodlights: readonly Floodlight[], count: number): Floodlight[] {
  const lit = floodlights.filter((f) => f.strength > 0);
  const order = lit.map((f, i) => ({ f, i })).sort((a, b) => Math.abs(b.f.position[2]) - Math.abs(a.f.position[2]) || a.i - b.i);
  const out: Floodlight[] = [];
  for (let k = 0; k < count; k++) {
    out.push(k < order.length ? order[k].f : { position: [0, 10000, 0], target: [0, 0, 0], color: [0, 0, 0], strength: 0 });
  }
  return out;
}

/**
 * The kickoff rings (both teams: every spot and its point mirror) folded into the +x +z quadrant.
 * The set is symmetric in x and in z, so the markings shader evaluates these few rings at |p|
 * instead of every ring at p (tests/turf.test.mjs checks the fold loses no ring).
 */
export const KICKOFF_RINGS_QUADRANT: ReadonlyArray<readonly [number, number]> = (() => {
  const seen = new Set<string>();
  const out: Array<readonly [number, number]> = [];
  for (const [kx, ky] of KICKOFF_SPAWNS) {
    const q: readonly [number, number] = [Math.abs(kx), Math.abs(ky)];
    const key = q.join(',');
    if (!seen.has(key)) {
      seen.add(key);
      out.push(q);
    }
  }
  return out;
})();
