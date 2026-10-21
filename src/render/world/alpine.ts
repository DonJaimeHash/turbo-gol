/**
 * Alpine valley generator ("Valle Alto", original design): the stadium stands on the meadow floor of
 * a glacial valley running along the field (z). Forested walls rise on both sides, the valley
 * climbs gently behind each goal into pine forest, and a snow-capped massif closes it ahead of the
 * blue kickoff camera (+z); lower snowy ranges stand behind the other goal and over the side walls.
 *
 * One terrain height function serves both parts (so the live edge sits exactly on the baked land
 * when seen from the bake origin):
 *
 *   LIVE (`buildAlpineLive`)  drawn every frame as ONE merged mesh (World.ts, the harbour's live
 *                             slot, same attributes and pipeline): the valley floor and its walls
 *                             out to LIVE_EDGE (a polar grid, flat under the stadium) and ~1650
 *                             pines (four stacked cones near the stadium, three farther out; jagged,
 *                             drooping rims; self-shadowing in the vertex colour) in forests, clumps
 *                             and lone trees, with a meadow behind each goal so the massif shows
 *                             over the boards. About 95k triangles from 95k vertices (the harbour:
 *                             35k from 71k), built in ~30-60 ms on the first visit of a session.
 *                             The walls end in a crest at LIVE_EDGE: behind it the land drops first,
 *                             so the baked continuation (drawn through the dome's parallax proxy)
 *                             never meets the live edge where a camera near the pitch could see a
 *                             seam (tests/world.test.mjs).
 *   FAR  (`buildAlpineFar`)   baked into the cube map: the land beyond the crest and the mountains,
 *                             a ridged multifractal heightfield (a polar grid, fine in azimuth for
 *                             crisp ridge lines) shaped by a mass per direction: the high massif
 *                             ahead, side ranges, a lower range behind. Per vertex it carries the
 *                             baked sun visibility (a march over a coarse height grid), ambient
 *                             occlusion and a smoothed slope; the ALPINE pattern (alpineShade.ts)
 *                             draws snow by slope and height, rock strata, scree, alpine meadows
 *                             and forest per pixel. ~160k vertices, ~0.3 s of CPU while the bake
 *                             pipelines compile.
 *
 * Heights: the mountains rise above the default parallax band (harbour.ts SKYLINE_TOP), so the
 * 'alpine-day' preset raises the dome's hand-over band (presets.ts proxyTop) above ALPINE_TOP: the
 * whole range then gets the proxy's parallax (as if ~60-80k away) and only the sky above it is at
 * infinity, so no peak is sheared by the hand-over.
 *
 * Axes as in harbour.ts: +z = behind the red goal (what the blue kickoff camera faces), -x = the
 * right of that view; azimuth 0 = +z, 90 = -x (presets.ts dirFromAzEl).
 */
import * as THREE from 'three/webgpu';
import { GeoBuilder, KIND, rng, type Lamp } from './geo';
import { LIVE_RADIUS, STADIUM_HALF_X, STADIUM_HALF_Z } from './harbour';

/** Valley floor level round the stadium (the harbour's quay level: just under the pitch). */
export const ALPINE_GROUND = -30;
/** Outer radius of the live terrain (its crest); every live vertex stays inside harbour.ts LIVE_RADIUS. */
export const LIVE_EDGE = 28500;
/** Highest point of the baked mountains (world y); the preset's proxy band starts above it. */
export const ALPINE_TOP = 31000;
/** Mean snow line and tree line of the mountain pattern (world y, alpineShade.ts). */
export const SNOW_Y = 10200;
export const TREE_Y = 5600;

/** Flat floor under and round the stadium (exactly ALPINE_GROUND inside). */
const FLAT_X = 8300;
const FLAT_Z = 7900;
/** Heights of the valley walls at the live crest: the side walls and the gentle rise behind each goal. */
const SIDE_H = 5400;
const END_H = 1150;

// ------------------------------------------------------------------------------------------ noise

const sstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function hash2(ix: number, iz: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** 2D value noise in [0, 1]. */
function vnoise2(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

/** fbm of value noise in [0, 1]. */
function fbm2(x: number, z: number, oct: number): number {
  let s = 0;
  let a = 0.5;
  let f = 1;
  let n = 0;
  for (let o = 0; o < oct; o++) {
    s += a * vnoise2(x * f + o * 17.3, z * f - o * 9.1);
    n += a;
    f *= 2.03;
    a *= 0.5;
  }
  return s / n;
}

/** 16 unit gradients for the gradient noise. */
const GRAD = (() => {
  const g = new Float64Array(32);
  for (let i = 0; i < 16; i++) {
    const a = ((i + 0.5) / 16) * Math.PI * 2;
    g[i * 2] = Math.cos(a);
    g[i * 2 + 1] = Math.sin(a);
  }
  return g;
})();

/** 2D gradient (Perlin-style) noise, about [-0.7, 0.7]. */
function perlin2(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const dot = (cx: number, cz: number, dx: number, dz: number): number => {
    const k = (Math.floor(hash2(cx, cz) * 16) & 15) * 2;
    return GRAD[k] * dx + GRAD[k + 1] * dz;
  };
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const a = dot(ix, iz, fx, fz);
  const b = dot(ix + 1, iz, fx - 1, fz);
  const c = dot(ix, iz + 1, fx, fz - 1);
  const d = dot(ix + 1, iz + 1, fx - 1, fz - 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

/**
 * Shape of the ridged field (tuned for alpine relief: slopes of ~30-60 degrees, not needles). The
 * octaves stop at ~1600 uu: finer relief than the far mesh's rows (~1200 uu deep at 75k) would
 * alias into noisy normals, and the slope-driven snow would break into facet-sized blocks.
 */
const RIDGE_SCALE = 30000;
const RIDGE_POW = 1.2;
const RIDGE_GAIN = 1.4;
const RIDGE_OCTAVE_GAIN = 0.4;
const RIDGE_OCTAVES = 5;

/**
 * Ridged multifractal (sharp crests, smoother valleys), about [0, 1]: each octave's ridge is
 * weighted by the previous one, so detail gathers on the crests, as erosion leaves it.
 */
function ridged(x: number, z: number, oct: number): number {
  let sum = 0;
  let norm = 0;
  let amp = 1;
  let weight = 1;
  let f = 1;
  for (let o = 0; o < oct; o++) {
    let s = 1 - Math.abs(perlin2(x * f + o * 31.7, z * f - o * 17.9)) * 1.45;
    s = Math.max(s, 0);
    s *= s;
    s *= weight;
    weight = Math.min(1, Math.max(0, s * 1.8));
    sum += s * amp;
    norm += amp;
    f *= 2.07;
    amp *= RIDGE_OCTAVE_GAIN;
  }
  return sum / norm;
}


// -------------------------------------------------------------------------------- height functions

/** Azimuth in degrees of the direction (x, z) (0 = +z, 90 = -x; presets.ts convention). */
function azimuthDeg(x: number, z: number): number {
  return (Math.atan2(-x, z) * 180) / Math.PI;
}

/**
 * The valley (live part of the terrain, any radius): the flat floor under the stadium, the side
 * walls rising with |x| (concave, like a glacial trough), a gentle climb behind each goal, and
 * hummocks away from the stadium.
 */
export function valleyHeight(x: number, z: number): number {
  const ax = Math.abs(x);
  const az = Math.abs(z);
  if (ax < FLAT_X && az < FLAT_Z) return ALPINE_GROUND;
  const r = Math.hypot(x, z);
  // 0 on the flat box, 1 from 3000 uu beyond it: everything else fades in from the box's edge
  const away = sstep(0, 3000, Math.max(ax - FLAT_X, az - FLAT_Z));
  const wobX = 900 * Math.sin(z / 7300 + 0.6) + 450 * Math.sin(z / 2900 + 2.1);
  const wobZ = 700 * Math.sin(x / 6100 + 1.0);
  const side = SIDE_H * Math.pow(sstep(FLAT_X, LIVE_EDGE, ax + wobX), 1.45);
  const end = END_H * Math.pow(sstep(FLAT_Z + 1500, LIVE_EDGE, az + wobZ), 1.25);
  const h = Math.max(side, end) + 0.3 * Math.min(side, end);
  const bumps = (fbm2(x / 5200 + 7.3, z / 5200 - 2.9, 4) - 0.45) * (260 + 1000 * sstep(9000, 24000, r));
  return ALPINE_GROUND + (h + bumps) * away;
}

/** The mountains (baked part only): zero inside ~40k, the range's height elsewhere. */
function mountainHeight(x: number, z: number, r: number): number {
  const az = azimuthDeg(x, z);
  const front = Math.exp(-((az / 48) ** 2));
  const back = Math.exp(-(((180 - Math.abs(az)) / 50) ** 2));
  const amp = 7600 + 21500 * front + 8000 * back;
  const start = 40000 + 6000 * front + 4000 * back;
  const rise = sstep(start, start + 20000, r);
  if (rise <= 0) return 0;
  const far = 1 - 0.3 * sstep(100000, 140000, r);
  // domain warp: ridges wander instead of following the noise lattice
  const wx = (fbm2(x / 40000 + 3.3, z / 40000, 2) - 0.5) * 1.4;
  const wz = (fbm2(x / 40000, z / 40000 + 8.1, 2) - 0.5) * 1.4;
  const rid = ridged(x / RIDGE_SCALE + wx, z / RIDGE_SCALE + wz, RIDGE_OCTAVES);
  // broad mass: a few dominant summits instead of an even comb of peaks
  const mass = 0.4 + 0.8 * fbm2(x / 52000 + 1.7, z / 52000 - 4.2, 3);
  return amp * rise * far * mass * Math.pow(rid, RIDGE_POW) * RIDGE_GAIN;
}

/** Soft cap: heights above `start` ease toward `top` (never above it). */
function capTop(h: number, start: number, top: number): number {
  if (h <= start) return h;
  const room = top - start;
  return start + room * (1 - Math.exp(-(h - start) / room));
}

/** The live crest's height per azimuth (valleyHeight on the LIVE_EDGE circle), sampled finely. */
const CREST_N = 4096;
let crestTable: Float32Array | null = null;
function crestHeight(x: number, z: number): number {
  if (crestTable === null) {
    crestTable = new Float32Array(CREST_N + 1);
    for (let i = 0; i <= CREST_N; i++) {
      const a = (i / CREST_N) * Math.PI * 2;
      crestTable[i] = valleyHeight(Math.sin(a) * LIVE_EDGE, Math.cos(a) * LIVE_EDGE);
    }
  }
  let u = (Math.atan2(x, z) / (Math.PI * 2)) * CREST_N;
  if (u < 0) u += CREST_N;
  const i = Math.min(CREST_N - 1, Math.floor(u));
  const f = u - i;
  return crestTable[i] + (crestTable[i + 1] - crestTable[i]) * f;
}

/**
 * The whole terrain: the valley inside LIVE_EDGE; beyond it the land drops behind the live crest
 * (so the bake's continuation is hidden from the arena) and the mountains rise out of it.
 */
export function terrainHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);
  if (r <= LIVE_EDGE) return valleyHeight(x, z);
  const crest = crestHeight(x, z);
  const t = sstep(LIVE_EDGE, LIVE_EDGE + 6000, r);
  const floor = crest * (1 - 0.7 * t) + (t > 0 ? (fbm2(x / 7000, z / 7000, 2) - 0.5) * 700 * t : 0);
  return capTop(floor + mountainHeight(x, z, r), ALPINE_TOP - 6000, ALPINE_TOP - 50);
}

/** Forest cover of the live valley in [0, 1] (meadows near the stadium, forest on the walls). */
export function forestCover(x: number, z: number, slope: number): number {
  const r = Math.hypot(x, z);
  let f = fbm2(x / 6400 + 3.1, z / 6400 - 7.7, 3);
  f += 0.24 * sstep(11000, 21000, r) + 0.25 * sstep(0.12, 0.45, slope);
  // a meadow right behind each goal, so the massif shows over the boards from the field
  f -= 0.55 * (1 - sstep(12500, 17500, Math.abs(z))) * (1 - sstep(6500, 11500, Math.abs(x)));
  // rock and scree on the steepest slopes
  f -= 0.5 * sstep(0.85, 1.3, slope);
  return Math.min(1, Math.max(0, f));
}

// ------------------------------------------------------------------------------------- mesh parts

interface PolarGrid {
  readonly pos: Float32Array;
  readonly idx: Uint32Array;
  readonly radii: readonly number[];
  readonly nt: number;
  /** ln(rMin) and 1 / ln(grow): the ring of a radius without a search. */
  readonly logMin: number;
  readonly invLogGrow: number;
}

/** Polar grid of terrain from rMin to rMax (radii grow by `grow`), `nt` azimuth steps. */
function polarGrid(rMin: number, rMax: number, grow: number, nt: number, height: (x: number, z: number) => number): PolarGrid {
  const radii: number[] = [];
  for (let r = rMin; r < rMax; r *= grow) radii.push(r);
  radii.push(rMax);
  const nr = radii.length;
  const pos = new Float32Array(nr * nt * 3);
  for (let ri = 0; ri < nr; ri++) {
    const r = radii[ri];
    for (let ti = 0; ti < nt; ti++) {
      const a = (ti / nt) * Math.PI * 2;
      const x = Math.sin(a) * r;
      const z = Math.cos(a) * r;
      const k = (ri * nt + ti) * 3;
      pos[k] = x;
      pos[k + 1] = height(x, z);
      pos[k + 2] = z;
    }
  }
  const idx = new Uint32Array((nr - 1) * nt * 6);
  let n = 0;
  for (let ri = 0; ri < nr - 1; ri++) {
    for (let ti = 0; ti < nt; ti++) {
      const a = ri * nt + ti;
      const b = ri * nt + ((ti + 1) % nt);
      const c = (ri + 1) * nt + ti;
      const d = (ri + 1) * nt + ((ti + 1) % nt);
      // counter-clockwise seen from above (+y)
      idx[n++] = a;
      idx[n++] = c;
      idx[n++] = b;
      idx[n++] = b;
      idx[n++] = c;
      idx[n++] = d;
    }
  }
  return { pos, idx, radii, nt, logMin: Math.log(rMin), invLogGrow: 1 / Math.log(grow) };
}

/**
 * Bilinear sample of a per-vertex value of the grid (`data`, `stride` floats per vertex, element
 * `at`) at (x, z) inside it: the tree placement reads the built terrain's height and normal instead
 * of evaluating the height function again.
 */
function sampleGrid(g: PolarGrid, data: Float32Array, stride: number, at: number, x: number, z: number): number {
  const r = Math.sqrt(x * x + z * z);
  const radii = g.radii;
  let ri = Math.min(radii.length - 2, Math.max(0, Math.floor((Math.log(Math.max(r, 1)) - g.logMin) * g.invLogGrow)));
  if (ri < radii.length - 2 && radii[ri + 1] < r) ri++;
  const t = Math.min(1, Math.max(0, (r - radii[ri]) / (radii[ri + 1] - radii[ri])));
  let u = (Math.atan2(x, z) / (Math.PI * 2)) * g.nt;
  if (u < 0) u += g.nt;
  const ti = Math.min(g.nt - 1, Math.floor(u));
  const s = u - ti;
  const tj = (ti + 1) % g.nt;
  const a = data[(ri * g.nt + ti) * stride + at];
  const b = data[(ri * g.nt + tj) * stride + at];
  const c = data[((ri + 1) * g.nt + ti) * stride + at];
  const d = data[((ri + 1) * g.nt + tj) * stride + at];
  return (a + (b - a) * s) * (1 - t) + (c + (d - c) * s) * t;
}

function vertexNormals(pos: Float32Array, idx: Uint32Array): Float32Array {
  const tmp = new THREE.BufferGeometry();
  tmp.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  tmp.setIndex(new THREE.BufferAttribute(idx, 1));
  tmp.computeVertexNormals();
  const nrm = Float32Array.from(tmp.attributes.normal.array as ArrayLike<number>);
  tmp.dispose();
  return nrm;
}

/**
 * The live mesh's vertex arrays, written once in place and sized up front (this runs on the main
 * thread the first time a session shows the valley, so no intermediate copies): GeoBuilder's
 * layout exactly (position, normal, kcol = rgb + kind, kloc = the world position for world-space
 * parts as in GeoBuilder.raw, kdat; Uint32 indices), so the harbour's live mesh draws it with the
 * same pipeline.
 */
class LiveWriter {
  readonly pos: Float32Array;
  readonly nrm: Float32Array;
  readonly col: Float32Array;
  readonly loc: Float32Array;
  readonly dat: Float32Array;
  readonly idx: Uint32Array;
  count = 0;
  indices = 0;
  constructor(maxVerts: number, maxIndices: number) {
    this.pos = new Float32Array(maxVerts * 3);
    this.nrm = new Float32Array(maxVerts * 3);
    this.col = new Float32Array(maxVerts * 4);
    this.loc = new Float32Array(maxVerts * 3);
    this.dat = new Float32Array(maxVerts * 4);
    this.idx = new Uint32Array(maxIndices);
  }
  /** One vertex; the normal must be unit length. kdat = (sun visibility, occlusion, free, seed). */
  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, r: number, g: number, b: number, kind: number, vis: number, ao: number, seed: number): number {
    const i = this.count++;
    const o = i * 3;
    this.pos[o] = this.loc[o] = x;
    this.pos[o + 1] = this.loc[o + 1] = y;
    this.pos[o + 2] = this.loc[o + 2] = z;
    this.nrm[o] = nx;
    this.nrm[o + 1] = ny;
    this.nrm[o + 2] = nz;
    const c = i * 4;
    this.col[c] = r;
    this.col[c + 1] = g;
    this.col[c + 2] = b;
    this.col[c + 3] = kind;
    this.dat[c] = vis;
    this.dat[c + 1] = ao;
    this.dat[c + 2] = 0;
    this.dat[c + 3] = seed;
    return i;
  }
  tri(a: number, b: number, c: number): void {
    const k = this.indices;
    this.idx[k] = a;
    this.idx[k + 1] = b;
    this.idx[k + 2] = c;
    this.indices = k + 3;
  }
  geometry(radius: number): THREE.BufferGeometry {
    const n = this.count;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.subarray(0, n * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nrm.subarray(0, n * 3), 3));
    g.setAttribute('kcol', new THREE.BufferAttribute(this.col.subarray(0, n * 4), 4));
    g.setAttribute('kloc', new THREE.BufferAttribute(this.loc.subarray(0, n * 3), 3));
    g.setAttribute('kdat', new THREE.BufferAttribute(this.dat.subarray(0, n * 4), 4));
    g.setIndex(new THREE.BufferAttribute(this.idx.subarray(0, this.indices), 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radius);
    return g;
  }
}

/** The vertices / indices a pine of `tiers` cones with `segs` rim segments takes. */
const pineVerts = (tiers: number, segs: number): number => tiers * 2 * (segs + 1);
const pineIndices = (tiers: number, segs: number): number => tiers * 2 * segs * 3;
/** Most rim segments of a pine (scratch size). */
const MAX_SEGS = 12;

type Rgb3 = readonly [number, number, number];

/** Needle colours (linear albedo): spruce, silver fir (bluer), pine (yellower), a rare larch. */
const NEEDLES: readonly (readonly [Rgb3, number])[] = [
  [[0.017, 0.042, 0.017], 5],
  [[0.013, 0.038, 0.026], 3],
  [[0.028, 0.05, 0.016], 2],
  [[0.048, 0.08, 0.02], 0.6],
];
const NEEDLE_TOTAL = NEEDLES.reduce((s, n) => s + n[1], 0);

function needleColor(R: () => number): Rgb3 {
  let u = R() * NEEDLE_TOTAL;
  for (const [c, w] of NEEDLES) {
    u -= w;
    if (u <= 0) return c;
  }
  return NEEDLES[0][0];
}

/** Rim scratch of one cone (x, y, z, cos, sin per point). */
const RIM = new Float64Array(MAX_SEGS * 5);
/** Unit normals of a crown's lit top (tilted up: a rounded crown) and of its underside. */
const TOP_R = 0.85 / Math.sqrt(0.85 * 0.85 + 0.52 * 0.52);
const TOP_Y = 0.52 / Math.sqrt(0.85 * 0.85 + 0.52 * 0.52);
const UNDER_R = 0.6;
const UNDER_Y = -0.8;

/**
 * A pine of height `h` and base radius `rb` standing at (x, y0, z): `tiers` stacked cones with
 * jagged, drooping rims (`segs` per rim; alternate rim points jut out as branch tips). Each cone is
 * a lit top surface and a dark underside that closes it (the lowest reaches into the ground: no
 * floating trees). The colour carries the self-shadowing: rims full, the inner tops (under the
 * tier above) dark, the undersides darker still. Rim angles increase monotonically, so the
 * windings below are outward by construction.
 */
function pine(w: LiveWriter, R: () => number, x: number, y0: number, z: number, h: number, rb: number, tiers: number, segs: number, col: Rgb3): void {
  const seed = R();
  const rot = R() * Math.PI * 2;
  const lean = 0.03 * h;
  const lx = (R() - 0.5) * lean;
  const lz = (R() - 0.5) * lean;
  const tone = 0.85 + 0.3 * R();
  const c0 = col[0] * tone;
  const c1 = col[1] * tone;
  const c2 = col[2] * tone;
  const F = KIND.FOLIAGE;
  for (let k = 0; k < tiers; k++) {
    const f = k / (tiers - 1);
    const yb = y0 + h * (0.08 + 0.66 * f);
    const yt = k === tiers - 1 ? y0 + h : yb + h * (0.4 - 0.12 * f);
    const rr = rb * (1 - 0.66 * f);
    const cx = x + lx * f;
    const cz = z + lz * f;
    const lf = Math.min(1, f + 0.4);
    for (let i = 0; i < segs; i++) {
      const a = rot + ((i + (R() - 0.5) * 0.5) / segs) * Math.PI * 2;
      const tip = (i & 1) === 0;
      const rad = rr * (0.82 + 0.3 * R()) * (tip ? 1.12 : 0.84);
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const o = i * 5;
      RIM[o] = cx + ca * rad;
      RIM[o + 1] = yb - h * (tip ? 0.05 : 0.01) * (0.5 + R());
      RIM[o + 2] = cz + sa * rad;
      RIM[o + 3] = ca;
      RIM[o + 4] = sa;
    }
    // lit top: apex fan, (apex, next, this) faces outward and up
    const apex = w.vert(x + lx * lf, yt, z + lz * lf, 0, 1, 0, c0 * 0.5, c1 * 0.5, c2 * 0.5, F, 1, 1, seed);
    for (let i = 0; i < segs; i++) {
      const o = i * 5;
      const v = 0.86 + 0.28 * R();
      w.vert(RIM[o], RIM[o + 1], RIM[o + 2], RIM[o + 3] * TOP_R, TOP_Y, RIM[o + 4] * TOP_R, c0 * v, c1 * v, c2 * v, F, 1, 1, seed);
    }
    for (let i = 0; i < segs; i++) w.tri(apex, apex + 1 + ((i + 1) % segs), apex + 1 + i);
    // dark underside: rim -> a point on the trunk, (centre, this, next) faces outward and down
    const under = w.vert(cx, k === 0 ? y0 - 40 : yb + h * 0.03, cz, 0, -1, 0, c0 * 0.2, c1 * 0.2, c2 * 0.2, F, 1, 1, seed);
    for (let i = 0; i < segs; i++) {
      const o = i * 5;
      w.vert(RIM[o], RIM[o + 1], RIM[o + 2], RIM[o + 3] * UNDER_R, UNDER_Y, RIM[o + 4] * UNDER_R, c0 * 0.38, c1 * 0.38, c2 * 0.38, F, 1, 1, seed);
    }
    for (let i = 0; i < segs; i++) w.tri(under, under + 1 + i, under + 1 + ((i + 1) % segs));
  }
}

/** Terrain slope (rise over run) of a surface whose normal has the vertical component `ny`. */
function slopeOf(ny: number): number {
  const n = Math.max(ny, 0.05);
  return Math.sqrt(Math.max(0, 1 - n * n)) / n;
}

// ------------------------------------------------------------------------------------- generators

export interface AlpineLive {
  /** The merged live mesh geometry (same attributes as the harbour's: one pipeline). */
  readonly geometry: THREE.BufferGeometry;
  /** No lamps by day (the light map stays empty). */
  readonly lamps: Lamp[];
  readonly stats: { readonly parts: number; readonly verts: number; readonly triangles: number; readonly trees: number };
}

/** The live (per-frame) part of the valley: see the file header. */
export function buildAlpineLive(seed = 5): AlpineLive {
  const R = rng(seed);

  // ---- terrain: valley floor, walls, crest at LIVE_EDGE
  const NT = 256;
  const grid = polarGrid(5000, LIVE_EDGE, 1.04, NT, valleyHeight);
  const nv = grid.pos.length / 3;
  const nrm = vertexNormals(grid.pos, grid.idx);

  // ---- pines: a jittered grid (finer near the stadium), kept by the forest cover: first the
  // list (x, y0, z, h, rb, tiers * 100 + segs), then every vertex straight into the final arrays
  const list: number[] = [];
  const place = (cell: number, r0: number, r1: number, tiers: number, segs: number, hMin: number, hMax: number, fat: number): void => {
    const n = Math.ceil(r1 / cell);
    for (let j = -n; j < n; j++) {
      for (let i = -n; i < n; i++) {
        const x = (i + 0.5 + (R() - 0.5) * 0.9) * cell;
        const z = (j + 0.5 + (R() - 0.5) * 0.9) * cell;
        const keep = R();
        const hr = R();
        const wr = R();
        const r = Math.sqrt(x * x + z * z);
        if (r < r0 || r >= r1) continue;
        // clear of the stadium footprint (nothing stands inside it), even at the widest crown
        if (Math.abs(x) - 1200 < STADIUM_HALF_X && Math.abs(z) - 1200 < STADIUM_HALF_Z) continue;
        const y0 = sampleGrid(grid, grid.pos, 3, 1, x, z);
        const f = forestCover(x, z, slopeOf(sampleGrid(grid, nrm, 3, 1, x, z)));
        // forest where the cover is high, lone trees and small clumps in the meadows
        if (!(keep < sstep(0.45, 0.62, f) * 0.95 || (f > 0.2 && keep > 0.985))) continue;
        let h = hMin + (hMax - hMin) * Math.pow(hr, 0.8);
        // smaller trees in the meadow behind each goal (the massif stays in view over them)
        h *= 1 - 0.38 * (1 - sstep(14000, 21000, Math.abs(z))) * (1 - sstep(8000, 13000, Math.abs(x)));
        const rb = h * (fat + 0.07 * wr);
        // clear of the stadium footprint and inside the live radius
        if (Math.abs(x) - rb * 1.25 < STADIUM_HALF_X && Math.abs(z) - rb * 1.25 < STADIUM_HALF_Z) continue;
        if (r + rb * 1.25 > LIVE_EDGE) continue;
        if (Math.hypot(r + rb * 1.25, y0 + h - 250) > LIVE_RADIUS - 100) continue;
        list.push(x, y0, z, h, rb, tiers * 100 + segs);
      }
    }
  };
  place(780, 0, 17500, 4, 8, 1700, 2900, 0.2);
  place(1080, 17500, LIVE_EDGE, 3, 6, 1900, 3100, 0.23);
  const trees = list.length / 6;
  let maxV = nv;
  let maxI = grid.idx.length;
  for (let t = 0; t < trees; t++) {
    const shape = list[t * 6 + 5];
    maxV += pineVerts(Math.floor(shape / 100), shape % 100);
    maxI += pineIndices(Math.floor(shape / 100), shape % 100);
  }
  const w = new LiveWriter(maxV, maxI);

  // terrain colour: meadow (lusher low down, drier on the knolls), forest floor, rock
  for (let i = 0; i < nv; i++) {
    const x = grid.pos[i * 3];
    const y = grid.pos[i * 3 + 1];
    const z = grid.pos[i * 3 + 2];
    const slope = slopeOf(nrm[i * 3 + 1]);
    const forest = forestCover(x, z, slope);
    const rock = sstep(0.8, 1.25, slope + (fbm2(x / 1500, z / 1500, 2) - 0.5) * 0.5);
    const dry = fbm2(x / 2600 - 5.1, z / 2600 + 1.3, 3);
    let cr = 0.042 + 0.03 * dry;
    let cg = 0.085 + 0.018 * dry;
    let cb = 0.026 + 0.006 * dry;
    const ff = sstep(0.35, 0.7, forest);
    cr += (0.022 - cr) * ff;
    cg += (0.034 - cg) * ff;
    cb += (0.016 - cb) * ff;
    cr += (0.15 - cr) * rock;
    cg += (0.14 - cg) * rock;
    cb += (0.125 - cb) * rock;
    // occlusion under the canopy
    w.vert(x, y, z, nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2], cr, cg, cb, KIND.MEADOW, 1, 1 - 0.25 * ff, hash2(i, 77));
  }
  for (let k = 0; k < grid.idx.length; k += 3) w.tri(grid.idx[k], grid.idx[k + 1], grid.idx[k + 2]);
  for (let t = 0; t < trees; t++) {
    const o = t * 6;
    const shape = list[o + 5];
    pine(w, R, list[o], list[o + 1], list[o + 2], list[o + 3], list[o + 4], Math.floor(shape / 100), shape % 100, needleColor(R));
  }

  const geometry = w.geometry(LIVE_RADIUS);
  return { geometry, lamps: [], stats: { parts: 1 + trees, verts: w.count, triangles: w.indices / 3, trees } };
}

export interface AlpineFar {
  readonly geometry: THREE.BufferGeometry | null;
  readonly lamps: Lamp[];
  readonly stats: { readonly parts: number; readonly verts: number };
}

/**
 * The baked part: the land beyond the live crest and the mountains. `sunDir` (unit, toward the
 * sun) bakes the terrain shadows. A dry run has nothing to collect (no lamps by day).
 */
export function buildAlpineFar(sunDir: readonly [number, number, number], dry = false): AlpineFar {
  const g = new GeoBuilder(dry);
  if (dry) return { geometry: null, lamps: [], stats: { parts: 0, verts: 0 } };
  // ---- coarse height grid for the shadow march and the occlusion
  const GN = 224;
  const GE = 145000;
  const hg = new Float32Array(GN * GN);
  for (let j = 0; j < GN; j++) {
    for (let i = 0; i < GN; i++) hg[j * GN + i] = terrainHeight(-GE + ((i + 0.5) / GN) * 2 * GE, -GE + ((j + 0.5) / GN) * 2 * GE);
  }
  const G = (x: number, z: number): number => {
    const fx = ((x + GE) / (2 * GE)) * GN - 0.5;
    const fz = ((z + GE) / (2 * GE)) * GN - 0.5;
    const i = Math.max(0, Math.min(GN - 2, Math.floor(fx)));
    const j = Math.max(0, Math.min(GN - 2, Math.floor(fz)));
    const u = Math.min(1, Math.max(0, fx - i));
    const v = Math.min(1, Math.max(0, fz - j));
    const a = hg[j * GN + i];
    const b = hg[j * GN + i + 1];
    const c = hg[(j + 1) * GN + i];
    const d = hg[(j + 1) * GN + i + 1];
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  const sunVis = (x: number, y: number, z: number): number => {
    let t = 400;
    let vis = 1;
    for (let k = 0; k < 24 && t < 120000; k++) {
      const ry = y + sunDir[1] * t;
      if (ry > ALPINE_TOP + 300) break; // above every summit: lit from here on
      const h = G(x + sunDir[0] * t, z + sunDir[2] * t);
      vis = Math.min(vis, sstep(-300, 300, ry - h));
      if (vis <= 0) break;
      t *= 1.42;
    }
    return vis;
  };

  // ---- polar mesh: fine in azimuth (crisp ridge lines), from just inside the live crest
  const NT = 1536;
  const grid = polarGrid(LIVE_EDGE - 1200, 140000, 1.016, NT, terrainHeight);
  const nv = grid.pos.length / 3;
  const nrm = vertexNormals(grid.pos, grid.idx);
  const rgb = new Float32Array(nv * 3);
  const dat = new Float32Array(nv * 4);
  for (let i = 0; i < nv; i++) {
    const x = grid.pos[i * 3];
    const y = grid.pos[i * 3 + 1];
    const z = grid.pos[i * 3 + 2];
    // kcol: r = albedo tint, g = the slope over ~2.6k uu (1 - n.y of the coarse grid's surface): the
    // snow and the meadows follow it, so they do not flip from one mesh column to the next across
    // the ridges' creases (the true normal still lights every facet)
    const gx = (G(x + 1300, z) - G(x - 1300, z)) / 2600;
    const gz = (G(x, z + 1300) - G(x, z - 1300)) / 2600;
    rgb[i * 3] = 0.93 + 0.14 * hash2(i, 5);
    rgb[i * 3 + 1] = 1 - 1 / Math.sqrt(1 + gx * gx + gz * gz);
    rgb[i * 3 + 2] = 0;
    dat[i * 4] = sunVis(x, y + 60, z);
    const around = (G(x + 2600, z) + G(x - 2600, z) + G(x, z + 2600) + G(x, z - 2600)) * 0.25;
    dat[i * 4 + 1] = 0.6 + 0.4 * sstep(-2600, 500, y - around);
    // forest potential of the pattern (patches, not a uniform band)
    dat[i * 4 + 2] = fbm2(x / 5000 - 2.2, z / 5000 + 6.4, 2);
    dat[i * 4 + 3] = hash2(i, 91);
  }
  g.raw(grid.pos, nrm, grid.idx, rgb, dat, KIND.ALPINE);
  return { geometry: g.build(new THREE.Sphere(new THREE.Vector3(), 145000)), lamps: [], stats: { parts: g.parts, verts: g.verts } };
}
