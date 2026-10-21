/**
 * City generator ("Distrito 9", theme city-dusk; original design): the stadium stands on the roof
 * deck of a multi-storey car park in the middle of a city at dusk. Two parts, like harbour.ts, both
 * appended to GeoBuilders (geo.ts):
 *
 *   LIVE (`buildCityLive`)  what is near enough to need real parallax, drawn every frame as ONE
 *                           merged mesh. World.ts swaps it in for the harbour's: the same material and
 *                           the same vertex layout, so no new pipeline. It holds the roof deck round
 *                           the stadium (wet concrete, bay markings, parked cars, light poles, stair
 *                           and lift cores with a lit parking sign, the parapet), the streets far
 *                           below with street lamps and car lights, and the ring of buildings across
 *                           the streets, with the landmark towers just beyond the ends of the field.
 *   FAR  (`buildCityFar`)   everything beyond, baked into the cube map: the street grid out to the
 *                           haze, a few thousand buildings (a downtown behind the far goal and three
 *                           smaller clusters), a needle tower, rooftop aviation lights, lit crowns,
 *                           street lamps and car lights. Every top stays under SKYLINE_TOP.
 *
 * Layout (top view, uu; the stadium at the origin, +z = behind the red goal = what the blue kickoff
 * camera faces, -x = the right of that view):
 *
 *   deck        |x| < DECK_X, |z| < DECK_Z at y = QUAY: the car park's roof with the stadium on it
 *   streets     y = CITY_STREET (26 m below the deck): a ring road round the car park (centre lines
 *               x = +-RING_X, z = +-RING_Z), then a grid every PITCH, plus one street splitting each
 *               long block next to the car park
 *   blocks      between the streets, split into lots, one building per lot (a few lots stay empty,
 *               the middle of big blocks is a courtyard)
 *   landmarks   live, so they may rise above SKYLINE_TOP: the spire tower right of the far goal, the
 *               crown tower left of it, a round tower, twin slabs, towers over both stands and one
 *               behind the blue goal; the needle tower far behind the spire is baked
 *
 * Facades use the TOWER pattern, the deck and the streets the DECK pattern (bakeMaterials.ts). A
 * facade's style is in its seed (`towerSeed`: office curtain wall, residential punched windows or
 * dark glass), and so is its lit crown band (`crownOf`). Live geometry is emitted near to far with the
 * ground last, so the GPU's early depth test rejects most hidden facade and street pixels.
 */
import * as THREE from 'three/webgpu';
import { GeoBuilder, KIND, rng, type Lamp, type Vec3 } from './geo';
import { LIVE_RADIUS, QUAY, SKYLINE_TOP } from './harbour';

/** Street level: the car park's roof deck (QUAY) is about 26 m above it. */
export const CITY_STREET = -2600;
/** Half sizes of the roof deck. */
export const DECK_X = 10400;
export const DECK_Z = 13200;
/** Cap of the dome's parallax proxy radius for the city (World.ts proxyMaxR): about the downtown's distance. */
export const CITY_PROXY_MAX_R = 42000;
/** The city's hand-over band of the dome's parallax (World.ts topOf; dome.ts PROXY_TOP elsewhere). */
export const CITY_PROXY_TOP: readonly [number, number] = [14000, 20000];
/** Light map layers (lightmap.ts): the streets and the deck. */
export const CITY_LIGHT_LAYERS: readonly [number, number] = [CITY_STREET, QUAY];
/**
 * Parking rows on the deck at both ends (the DECK pattern draws their bay lines): double rows (two
 * cars nose to nose) centred on |z| = ROW_Z0 + k * ROW_PITCH (k < ROWS), ROW_HALF deep on each side
 * of the centre line, bays BAY_W wide for |x| < BAY_X.
 */
export const ROW_Z0 = 7700;
export const ROW_PITCH = 2150;
export const ROWS = 3;
export const ROW_HALF = 500;
export const BAY_W = 270;
export const BAY_X = 9180;
/** Facade styles of the TOWER pattern (the integer part of seed * 3). */
export const TOWER_STYLE = { OFFICE: 0, RESIDENTIAL: 1, DARK: 2 } as const;
/** Lit crown band: a TOWER part shows it when fract(seed * CROWN_K) >= CROWN_MIN. */
export const CROWN_K = 5.37;
export const CROWN_MIN = 0.62;
/** Seeds of the DECK pattern: the streets (asphalt) below 0.5, the car park's deck above. */
export const DECK_SEED = 0.8;
export const STREET_SEED = 0.2;

/** Ring road round the car park (centre lines, half width), then the grid. */
const RING_X = 11700;
const RING_Z = 14500;
const RING_HW = 1300;
const PITCH = 7400;
const STREET_HW = 1100;
/** Extra streets splitting the long blocks next to the car park (north, south / east, west). */
const SPLIT_X_N = -2900;
const SPLIT_X_S = 3400;
const SPLIT_Z_E = 1800;
const SPLIT_Z_W = -1500;
/** The baked city reaches this far (the haze takes the rest). */
const FAR_EXTENT = 112000;
/** Live parts stay inside this distance of (0, 250, 0) (World.ts BAKE_ORIGIN; harbour.ts LIVE_RADIUS). */
const LIVE_R = LIVE_RADIUS - 150;
/** Height of a building's roof units and lamps over its roof (its top + this stays within bounds). */
const EXTRA_TOP = 400;

const CONCRETE: Vec3 = [0.25, 0.245, 0.235];
const DECK_CONCRETE: Vec3 = [0.2, 0.198, 0.192];
const ASPHALT: Vec3 = [0.06, 0.06, 0.066];
const ROOF_GREY: Vec3 = [0.1, 0.1, 0.105];
const POLE_GREY: Vec3 = [0.18, 0.185, 0.19];
const LED_HEAD: Vec3 = [11, 11.5, 12.5];
const LED: Vec3 = [0.8, 0.82, 0.9];
const SODIUM_HEAD: Vec3 = [10, 5.6, 2.2];
const SODIUM: Vec3 = [1.0, 0.6, 0.27];
const HEADLIGHT: Vec3 = [6.5, 6.0, 5.2];
const TAILLIGHT: Vec3 = [5.5, 0.28, 0.12];
const AVIATION: Vec3 = [9, 0.45, 0.22];
const SIGN_BLUE: Vec3 = [0.25, 0.55, 2.6];
const SIGN_WHITE: Vec3 = [5, 5.2, 5.6];

/** Facade albedo per style (the window glass is the pattern's own). */
const WALL: readonly (readonly Vec3[])[] = [
  // office: blue-grey and green-grey spandrels, a few light-stone frames
  [
    [0.05, 0.058, 0.07],
    [0.045, 0.06, 0.058],
    [0.12, 0.115, 0.11],
  ],
  // residential: concrete, brick, render, dark render
  [
    [0.15, 0.15, 0.155],
    [0.13, 0.09, 0.08],
    [0.18, 0.17, 0.16],
    [0.09, 0.09, 0.1],
  ],
  // dark glass
  [
    [0.03, 0.034, 0.045],
    [0.035, 0.03, 0.04],
  ],
];
/** Lit crown strips: cool white, amber, cyan, rose. */
const CROWN_COLORS: readonly Vec3[] = [
  [7, 7.5, 9],
  [8, 4.2, 1.6],
  [2, 5, 9],
  [7.5, 2.2, 5],
];
const CAR_COLORS: readonly Vec3[] = [
  [0.35, 0.36, 0.37],
  [0.55, 0.55, 0.54],
  [0.025, 0.025, 0.028],
  [0.08, 0.08, 0.085],
  [0.02, 0.035, 0.1],
  [0.2, 0.03, 0.025],
  [0.04, 0.08, 0.2],
  [0.28, 0.24, 0.17],
];

/** A TOWER part's seed: the style in floor(seed * 3), a free random number in fract(seed * 3). */
export function towerSeed(style: number, r: number): number {
  return (style + Math.min(Math.max(r, 0.002), 0.995)) / 3;
}

/** Whether a TOWER part with this seed shows the lit crown band (the shader's test, in float32). */
export function crownOf(seed: number): boolean {
  const s = Math.fround(Math.fround(seed) * Math.fround(CROWN_K));
  return s - Math.floor(s) >= CROWN_MIN;
}

/**
 * A seed of `style` whose crown flag is `crown`, kept away from the decision edges (the style and
 * crown tests run on the GPU on the stored float32 value).
 */
function seedFor(R: () => number, style: number, crown: boolean): number {
  for (let i = 0; i < 40; i++) {
    const s = towerSeed(style, R());
    const c = Math.fround(s) * CROWN_K;
    const f = c - Math.floor(c);
    if (Math.abs(f - CROWN_MIN) < 0.01 || f < 0.01 || f > 0.99) continue;
    if (f >= CROWN_MIN === crown) return s;
  }
  return towerSeed(style, crown ? 0.3 : 0.5);
}

/** Shared state of one generator run. */
interface Ctx {
  readonly g: GeoBuilder;
  readonly R: () => number;
  readonly lamps: Lamp[];
}

/** Distance of a world point from the bake origin (0, 250, 0): the live layer's bound. */
function originDist(x: number, y: number, z: number): number {
  return Math.hypot(x, y - 250, z);
}

interface Rect {
  readonly x0: number;
  readonly x1: number;
  readonly z0: number;
  readonly z1: number;
}

const overlaps = (a: Rect, b: Rect): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1;

// ------------------------------------------------------------------------------------- city plan

/** One planned building: its lot, its height above the street, its style and shape numbers. */
interface Building extends Rect {
  /** Height above CITY_STREET (before the live / bake caps). */
  readonly h: number;
  readonly style: number;
  /** Random numbers for the shape (wall colour, crown, setbacks, roof). */
  readonly r: readonly number[];
}

/** Footprints of the landmarks (with a margin): no planned building may overlap them. */
const LANDMARK_LOTS: readonly Rect[] = [
  { x0: -6600, x1: -3800, z0: 16900, z1: 19700 }, // spire tower
  { x0: 4900, x1: 9100, z0: 23700, z1: 27300 }, // crown tower
  { x0: 15000, x1: 18000, z0: 18000, z1: 21000 }, // round tower
  { x0: -17300, x1: -13700, z0: 16500, z1: 20300 }, // twin slabs
  { x0: 21000, x1: 24600, z0: 3300, z1: 6700 }, // over the left stands
  { x0: -24500, x1: -20500, z0: -6200, z1: -2600 }, // over the right stands
  { x0: -2300, x1: 1100, z0: -20000, z1: -16600 }, // behind the blue goal
  { x0: -25000, x1: -23000, z0: 61000, z1: 63000 }, // needle tower (baked)
];

/** Street centre lines from the ring outward (both signs), sorted. */
function streetLines(ring: number, extent: number): number[] {
  const out: number[] = [];
  for (let c = ring; c < extent; c += PITCH) out.push(c, -c);
  return out.sort((a, b) => a - b);
}

/** Half width of the street on line `c` (the ring road is wider). */
function halfWidth(c: number, ring: number): number {
  return Math.abs(Math.abs(c) - ring) < 1 ? RING_HW : STREET_HW;
}

/**
 * Planned height above the street at (x, z): low just across the streets from the car park (so the
 * towers behind stand out), a downtown behind the far goal, three smaller clusters, scattered towers.
 */
function plannedHeight(x: number, z: number, R: () => number): number {
  const g = (cx: number, cz: number, s: number): number => Math.exp(-((x - cx) ** 2 + (z - cz) ** 2) / (2 * s * s));
  const down = Math.max(g(-2000, 50000, 22000), 0.75 * g(44000, -6000, 17000), 0.6 * g(-34000, -42000, 19000), 0.45 * g(-52000, 24000, 15000));
  const r = Math.hypot(x, z);
  const nearLow = 1 - 0.38 * Math.exp(-((r - 18000) ** 2) / (2 * 6000 * 6000));
  let h = (2500 + 2600 * R() + 4200 * down) * nearLow;
  if (R() < 0.05 + 0.42 * down) h *= 1.45 + 1.0 * R();
  return h;
}

/** The whole city plan (live and far), deterministic. */
function planCity(seed = 23): Building[] {
  const R = rng(seed);
  const xs = streetLines(RING_X, FAR_EXTENT);
  const zs = streetLines(RING_Z, FAR_EXTENT);
  const out: Building[] = [];
  const block = (bx0: number, bx1: number, bz0: number, bz1: number): void => {
    const w = bx1 - bx0;
    const d = bz1 - bz0;
    if (w < 800 || d < 800) return;
    // lots of ~2000-3600 along each side
    const nx = Math.max(1, Math.round(w / (2000 + 1600 * R())));
    const nz = Math.max(1, Math.round(d / (2000 + 1600 * R())));
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nz; j++) {
        // the middle of a big block is mostly a courtyard
        const inner = i > 0 && i < nx - 1 && j > 0 && j < nz - 1 && R() < 0.7;
        const lx0 = bx0 + (w * i) / nx;
        const lx1 = bx0 + (w * (i + 1)) / nx;
        const lz0 = bz0 + (d * j) / nz;
        const lz1 = bz0 + (d * (j + 1)) / nz;
        const cx = (lx0 + lx1) / 2;
        const cz = (lz0 + lz1) / 2;
        const empty = R() < 0.06;
        const sb = 80 + 220 * R();
        const lot: Rect = { x0: lx0 + sb, x1: lx1 - sb, z0: lz0 + sb, z1: lz1 - sb };
        const h = plannedHeight(cx, cz, R);
        const styleR = R();
        const r = [R(), R(), R(), R(), R(), R(), R(), R()];
        if (inner || empty || Math.hypot(cx, cz) > FAR_EXTENT || LANDMARK_LOTS.some((l) => overlaps(l, lot))) continue;
        // tall ones are mostly glass, low ones mostly residential
        const style =
          h > 7500
            ? styleR < 0.55
              ? TOWER_STYLE.OFFICE
              : styleR < 0.85
                ? TOWER_STYLE.DARK
                : TOWER_STYLE.RESIDENTIAL
            : styleR < 0.3
              ? TOWER_STYLE.OFFICE
              : styleR < 0.88
                ? TOWER_STYLE.RESIDENTIAL
                : TOWER_STYLE.DARK;
        out.push({ ...lot, h, style, r });
      }
    }
  };
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < zs.length; j++) {
      const xa = xs[i];
      const xb = xs[i + 1];
      const za = zs[j];
      const zb = zs[j + 1];
      const bx0 = xa + halfWidth(xa, RING_X);
      const bx1 = xb - halfWidth(xb, RING_X);
      const bz0 = za + halfWidth(za, RING_Z);
      const bz1 = zb - halfWidth(zb, RING_Z);
      const midX = xa < 0 && xb > 0;
      const midZ = za < 0 && zb > 0;
      if (midX && midZ) continue; // the car park
      if (midX) {
        const sx = za > 0 ? SPLIT_X_N : SPLIT_X_S;
        block(bx0, sx - STREET_HW, bz0, bz1);
        block(sx + STREET_HW, bx1, bz0, bz1);
      } else if (midZ) {
        const sz = xa > 0 ? SPLIT_Z_E : SPLIT_Z_W;
        block(bx0, bx1, bz0, sz - STREET_HW);
        block(bx0, bx1, sz + STREET_HW, bz1);
      } else block(bx0, bx1, bz0, bz1);
    }
  }
  return out;
}

/**
 * The height a planned building is drawn with in the LIVE layer, or null when it is baked: live
 * when all of it (roof units included) stays within LIVE_R; near ones that would not fit are cut
 * down to fit, the rest are baked.
 */
function liveHeight(b: Building): number | null {
  const fx = Math.max(Math.abs(b.x0), Math.abs(b.x1));
  const fz = Math.max(Math.abs(b.z0), Math.abs(b.z1));
  const flat2 = fx * fx + fz * fz;
  if (flat2 > (LIVE_R - 200) ** 2) return null;
  const room = Math.sqrt(LIVE_R * LIVE_R - flat2) + 250 - EXTRA_TOP - CITY_STREET;
  if (b.h <= room) return b.h;
  const near = Math.hypot(Math.max(0, b.x0, -b.x1), Math.max(0, b.z0, -b.z1));
  return near > 25000 || room < 1500 ? null : room;
}

/** Street segments for lamps and traffic: [runs along x, centre line, from, to, half width]. */
function streetSegments(extent: number): [boolean, number, number, number, number][] {
  const out: [boolean, number, number, number, number][] = [];
  for (const c of streetLines(RING_X, extent)) out.push([false, c, -extent, extent, halfWidth(c, RING_X)]);
  for (const c of streetLines(RING_Z, extent)) out.push([true, c, -extent, extent, halfWidth(c, RING_Z)]);
  out.push([false, SPLIT_X_N, RING_Z, extent, STREET_HW], [false, SPLIT_X_S, -extent, -RING_Z, STREET_HW]);
  out.push([true, SPLIT_Z_E, RING_X, extent, STREET_HW], [true, SPLIT_Z_W, -extent, -RING_X, STREET_HW]);
  return out;
}

// ------------------------------------------------------------------------------------------ parts

/** The parts of one building `h` tall (body, podium and setbacks, roof unit, crown strips, lamps). */
function building(c: Ctx, b: Building, h: number): void {
  const { g } = c;
  const [r0, r1, r2, r3, r4, r5, r6, r7] = b.r;
  const cx = (b.x0 + b.x1) / 2;
  const cz = (b.z0 + b.z1) / 2;
  let hx = (b.x1 - b.x0) / 2;
  let hz = (b.z1 - b.z0) / 2;
  const walls = WALL[b.style];
  const wall = walls[Math.floor(r0 * walls.length) % walls.length];
  const crown = h > 5200 && r1 < 0.32;
  const seed = seedFor(c.R, b.style, crown);
  const plain = seedFor(c.R, b.style, false);
  let y = CITY_STREET;
  const top = CITY_STREET + h;
  if (h > 6500 && r2 < 0.6) {
    // podium + tower (+ a setback near the top of the tallest)
    const podium = Math.min(h * (0.12 + 0.12 * r3), 2600);
    g.boxAt(cx, y + podium / 2, cz, hx, podium / 2, hz, wall, KIND.TOWER, plain);
    y += podium;
    hx *= 0.6 + 0.2 * r4;
    hz *= 0.6 + 0.2 * r5;
    if (h > 9500 && r6 < 0.6) {
      const mid = y + (top - y) * (0.68 + 0.12 * r7);
      g.boxAt(cx, (y + mid) / 2, cz, hx, (mid - y) / 2, hz, wall, KIND.TOWER, plain);
      y = mid;
      hx *= 0.74;
      hz *= 0.74;
    }
  }
  g.boxAt(cx, (y + top) / 2, cz, hx, (top - y) / 2, hz, wall, KIND.TOWER, seed);
  // roof: a plant room on most, a lit strip round the top of some crowns, aviation lights on the tall
  if (h > 3600 && r3 > 0.25) {
    const ph = 140 + 200 * r4;
    g.boxAt(cx + (r5 - 0.5) * hx * 0.5, top + ph / 2, cz + (r6 - 0.5) * hz * 0.5, hx * (0.3 + 0.25 * r7), ph / 2, hz * (0.3 + 0.2 * r0), ROOF_GREY, KIND.STEEL, c.R());
  }
  if (crown && r7 < 0.55) {
    const col = CROWN_COLORS[Math.floor(r4 * CROWN_COLORS.length) % CROWN_COLORS.length];
    const k = 0.55 + 0.4 * r2;
    edgeRing(c, cx, cz, hx, hz, top + 16, [col[0] * k, col[1] * k, col[2] * k]);
  }
  if (h > 7200) {
    g.boxAt(cx - hx * 0.8, top + 40, cz - hz * 0.8, 30, 30, 30, AVIATION, KIND.LAMP, c.R());
    g.boxAt(cx + hx * 0.8, top + 40, cz + hz * 0.8, 30, 30, 30, AVIATION, KIND.LAMP, c.R());
  }
}

/** A street lamp at the street's edge (`pole` false: the head only, for the far city; `lit`: light map). */
function streetLamp(c: Ctx, x: number, z: number, alongX: boolean, side: number, sodium: boolean, pole: boolean, lit: boolean): void {
  const y = CITY_STREET + 880;
  if (pole) c.g.boxAt(x, CITY_STREET + 440, z, 14, 440, 14, POLE_GREY, KIND.STEEL, c.R());
  const ox = alongX ? 0 : -side * 120;
  const oz = alongX ? -side * 120 : 0;
  c.g.boxAt(x + ox, y, z + oz, alongX ? 50 : 70, 12, alongX ? 70 : 50, sodium ? SODIUM_HEAD : LED_HEAD, KIND.LAMP, c.R());
  if (lit) c.lamps.push({ pos: [x + ox, y - 60, z + oz], range: 1100, color: sodium ? SODIUM : LED, down: 1 });
}

/** Street lamps and car lights along every street segment, where `inside(x, z)` holds. */
function streetLife(c: Ctx, extent: number, inside: (x: number, z: number) => boolean, lampStep: number, carStep: number, carP: number, live: boolean): void {
  const { g, R } = c;
  const onDeck = (x: number, z: number): boolean => Math.abs(x) < DECK_X + 200 && Math.abs(z) < DECK_Z + 200;
  for (const [alongX, ctr, from, to, hw] of streetSegments(extent)) {
    // sodium on some streets, white LED on the others
    const sodium = Math.round(Math.abs(ctr) / PITCH) % 2 === 0;
    let side = 1;
    for (let s = from + lampStep / 2; s < to; s += lampStep) {
      side = -side;
      const off = ctr + side * (hw - 160);
      const x = alongX ? s : off;
      const z = alongX ? off : s;
      if (!inside(x, z) || onDeck(x, z)) continue;
      streetLamp(c, x, z, alongX, side, sodium, live, live);
    }
    // traffic, a still frame of it: white headlights in one lane, red tail lights in the other
    // (the two lamps of one car are one small box)
    for (let s = from; s < to; s += carStep) {
      for (const lane of [-1, 1]) {
        if (R() > carP) continue;
        const along = s + (R() - 0.5) * carStep * 0.6;
        const off = ctr + lane * Math.min(380, hw * 0.4);
        const x = alongX ? along : off;
        const z = alongX ? off : along;
        if (!inside(x, z) || onDeck(x, z)) continue;
        g.boxAt(x, CITY_STREET + 70, z, alongX ? 14 : 80, 16, alongX ? 80 : 14, lane > 0 ? HEADLIGHT : TAILLIGHT, KIND.LAMP, R());
      }
    }
  }
}

/** Up-facing DECK cells over a rectangle at height y (cells of at most `cell`), inside a disc of `radius`. */
function groundCells(c: Ctx, x0: number, x1: number, z0: number, z1: number, y: number, radius: number, cell: number, rgb: Vec3, seed: number): void {
  const nx = Math.max(1, Math.ceil((x1 - x0) / cell));
  const nz = Math.max(1, Math.ceil((z1 - z0) / cell));
  for (let i = 0; i < nx; i++) {
    const ax = x0 + ((x1 - x0) * i) / nx;
    const bx = x0 + ((x1 - x0) * (i + 1)) / nx;
    for (let j = 0; j < nz; j++) {
      const az = z0 + ((z1 - z0) * j) / nz;
      const bz = z0 + ((z1 - z0) * (j + 1)) / nz;
      if (originDist(Math.max(Math.abs(ax), Math.abs(bx)), y, Math.max(Math.abs(az), Math.abs(bz))) > radius) continue;
      c.g.quadUp(ax, az, bx, bz, y, rgb, KIND.DECK, seed);
    }
  }
}

/** A parked car in a bay (body + cabin), its nose toward `dir` (+-1 along z). */
function parkedCar(c: Ctx, x: number, z: number, dir: number): void {
  const { g, R } = c;
  const col = CAR_COLORS[Math.floor(R() * CAR_COLORS.length) % CAR_COLORS.length];
  const len = 205 + 25 * R();
  g.boxAt(x, QUAY + 48, z, 86, 34, len, col, KIND.STEEL, R());
  g.boxAt(x, QUAY + 104, z - dir * 25, 76, 24, len * 0.52, [0.03, 0.034, 0.04], KIND.STEEL, R());
  // a few are leaving: their tail lights are on
  if (R() < 0.04) g.boxAt(x, QUAY + 58, z - dir * (len + 2), 70, 10, 4, TAILLIGHT, KIND.LAMP, R());
}

/** A light pole on the deck: shaft, arm, two LED heads (one light-map lamp). */
function deckPole(c: Ctx, x: number, z: number): void {
  const { g, R } = c;
  const H = 1100;
  g.boxAt(x, QUAY + H / 2, z, 16, H / 2, 16, POLE_GREY, KIND.STEEL, R());
  g.boxAt(x, QUAY + H - 10, z, 150, 12, 26, POLE_GREY, KIND.STEEL, R());
  for (const s of [-1, 1]) g.boxAt(x + s * 120, QUAY + H - 28, z, 42, 9, 36, LED_HEAD, KIND.LAMP, R());
  c.lamps.push({ pos: [x, QUAY + H - 60, z], range: 1700, color: LED, down: 1 });
}

/**
 * A stair and lift core at a deck corner: a concrete box, a lit door, and a blue parking sign with
 * a white "P" of four bars, facing the field (`face`: +-1 along z).
 */
function core(c: Ctx, x: number, z: number, face: number): void {
  const { g, R } = c;
  const H = 1300;
  g.boxAt(x, QUAY + H / 2, z, 440, H / 2, 380, CONCRETE, KIND.STEEL, R());
  g.boxAt(x, QUAY + H + 40, z, 460, 40, 400, ROOF_GREY, KIND.STEEL, R());
  g.boxAt(x - 150, QUAY + 120, z + face * 384, 90, 120, 4, [2.2, 1.9, 1.4], KIND.LAMP, R());
  const sy = QUAY + 1000;
  g.boxAt(x + 120, sy, z + face * 388, 170, 170, 3, SIGN_BLUE, KIND.LAMP, R());
  const pz = z + face * 393;
  g.boxAt(x + 70, sy, pz, 18, 115, 3, SIGN_WHITE, KIND.LAMP, R()); // stem
  g.boxAt(x + 120, sy + 100, pz, 50, 16, 3, SIGN_WHITE, KIND.LAMP, R()); // top bar
  g.boxAt(x + 170, sy + 55, pz, 16, 60, 3, SIGN_WHITE, KIND.LAMP, R()); // bowl side
  g.boxAt(x + 120, sy + 10, pz, 50, 16, 3, SIGN_WHITE, KIND.LAMP, R()); // middle bar
}

// ------------------------------------------------------------------------------------- landmarks

/** Stacked TOWER boxes centred at (x, z), [half x, half z, top y] from the street up. */
function stack(c: Ctx, x: number, z: number, tiers: readonly (readonly [number, number, number])[], wall: Vec3, style: number, crownTop: boolean): void {
  let y = CITY_STREET;
  tiers.forEach(([hx, hz, top], i) => {
    c.g.boxAt(x, (y + top) / 2, z, hx, (top - y) / 2, hz, wall, KIND.TOWER, seedFor(c.R, style, i === tiers.length - 1 && crownTop));
    y = top;
  });
}

/** Thin vertical light strips on the four corners of a box (the fins of a lit crown). */
function cornerFins(c: Ctx, x: number, z: number, hx: number, hz: number, y0: number, y1: number, rgb: Vec3): void {
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) c.g.boxAt(x + sx * (hx + 6), (y0 + y1) / 2, z + sz * (hz + 6), 16, (y1 - y0) / 2, 16, rgb, KIND.LAMP, c.R());
  }
}

/** A lit strip round the top edge of a box. */
function edgeRing(c: Ctx, x: number, z: number, hx: number, hz: number, y: number, rgb: Vec3): void {
  c.g.boxAt(x, y, z - hz - 8, hx + 10, 14, 10, rgb, KIND.LAMP, c.R());
  c.g.boxAt(x, y, z + hz + 8, hx + 10, 14, 10, rgb, KIND.LAMP, c.R());
  c.g.boxAt(x - hx - 8, y, z, 10, 14, hz + 10, rgb, KIND.LAMP, c.R());
  c.g.boxAt(x + hx + 8, y, z, 10, 14, hz + 10, rgb, KIND.LAMP, c.R());
}

/** The live landmarks (see the file header). */
function landmarks(c: Ctx): void {
  const { g, R } = c;
  const GLASS: Vec3 = [0.045, 0.055, 0.07];
  const DARK: Vec3 = [0.03, 0.033, 0.045];
  const STONE: Vec3 = [0.16, 0.15, 0.14];
  const ICE: Vec3 = [2.6, 3.3, 4.6];
  const AMBER: Vec3 = [8, 4.6, 1.7];
  // spire tower, right of the far goal: three glass tiers, lit fins and rings, the spire
  {
    const x = -5200;
    const z = 18300;
    stack(c, x, z, [[1150, 1150, 5600], [900, 900, 7400], [640, 640, 8600]], GLASS, TOWER_STYLE.OFFICE, false);
    cornerFins(c, x, z, 640, 640, 7500, 8600, ICE);
    edgeRing(c, x, z, 900, 900, 7400, ICE);
    edgeRing(c, x, z, 640, 640, 8600, ICE);
    g.boxAt(x, 8680, z, 420, 80, 420, ROOF_GREY, KIND.STEEL, R());
    g.beam([x, 8750, z], [x, 11300, z], 70, [0.32, 0.33, 0.35], KIND.STEEL, R());
    g.beam([x, 8750, z], [x, 9900, z], 160, [0.32, 0.33, 0.35], KIND.STEEL, R());
    for (const y of [9300, 9900, 10500]) g.boxAt(x, y, z, 48, 10, 48, [6, 7, 9], KIND.LAMP, R());
    g.boxAt(x, 11330, z, 34, 34, 34, AVIATION, KIND.LAMP, R());
  }
  // crown tower, left of the far goal: a wide dark slab with three stepped lit crowns
  {
    const x = 7000;
    const z = 25500;
    stack(c, x, z, [[1500, 1100, 7900], [1200, 880, 8800], [900, 660, 9500]], DARK, TOWER_STYLE.DARK, false);
    edgeRing(c, x, z, 1500, 1100, 7900, AMBER);
    edgeRing(c, x, z, 1200, 880, 8800, AMBER);
    edgeRing(c, x, z, 900, 660, 9500, AMBER);
    g.boxAt(x, 9600, z, 500, 100, 380, ROOF_GREY, KIND.STEEL, R());
    g.boxAt(x - 400, 9740, z, 30, 30, 30, AVIATION, KIND.LAMP, R());
    g.boxAt(x + 400, 9740, z, 30, 30, 30, AVIATION, KIND.LAMP, R());
  }
  // round tower (left): a glass cylinder with a lit top ring
  {
    const x = 16500;
    const z = 19500;
    const top = 7400;
    const cyl = new THREE.CylinderGeometry(1150, 1250, top - CITY_STREET, 28, 1, false);
    g.geometry(cyl, new THREE.Matrix4().makeTranslation(x, (top + CITY_STREET) / 2, z), GLASS, KIND.TOWER, seedFor(R, TOWER_STYLE.OFFICE, false));
    cyl.dispose();
    const ring = new THREE.CylinderGeometry(1165, 1165, 40, 28, 1, true);
    g.geometry(ring, new THREE.Matrix4().makeTranslation(x, top - 60, z), [2, 5.5, 9], KIND.LAMP, R());
    ring.dispose();
    g.boxAt(x, top + 120, z, 500, 120, 500, ROOF_GREY, KIND.STEEL, R());
    g.boxAt(x, top + 270, z, 30, 30, 30, AVIATION, KIND.LAMP, R());
  }
  // twin residential slabs (right, toward the far end)
  stack(c, -15500, 17200, [[1500, 450, 5200]], STONE, TOWER_STYLE.RESIDENTIAL, false);
  stack(c, -15500, 19600, [[1500, 450, 4300]], STONE, TOWER_STYLE.RESIDENTIAL, false);
  g.boxAt(-15500, 5280, 17200, 300, 80, 200, ROOF_GREY, KIND.STEEL, R());
  // towers rising over the stands' roofs on both sides, and one behind the blue goal
  stack(c, 22800, 5000, [[1500, 1450, 2000], [1150, 1100, 8800]], GLASS, TOWER_STYLE.OFFICE, true);
  g.boxAt(22800, 8880, 5000, 30, 30, 30, AVIATION, KIND.LAMP, R());
  stack(c, -22500, -4400, [[1700, 1550, 1600], [1200, 1200, 9200]], DARK, TOWER_STYLE.DARK, true);
  g.boxAt(-22500, 9280, -4400, 30, 30, 30, AVIATION, KIND.LAMP, R());
  stack(c, -600, -18300, [[1450, 1400, 1800], [1050, 1000, 7600], [760, 720, 9400]], GLASS, TOWER_STYLE.OFFICE, true);
  cornerFins(c, -600, -18300, 760, 720, 7700, 9400, AMBER);
}

/** The needle tower (baked): a tapered concrete shaft, a lit pod, an antenna. */
function needle(c: Ctx, x: number, z: number): void {
  const { g, R } = c;
  const shaftTop = 7300;
  const shaft = new THREE.CylinderGeometry(230, 520, shaftTop - CITY_STREET, 16, 1, false);
  g.geometry(shaft, new THREE.Matrix4().makeTranslation(x, (shaftTop + CITY_STREET) / 2, z), [0.3, 0.29, 0.28], KIND.STEEL, R());
  shaft.dispose();
  const pod = new THREE.CylinderGeometry(900, 650, 520, 24, 1, false);
  g.geometry(pod, new THREE.Matrix4().makeTranslation(x, 6300, z), [0.12, 0.12, 0.13], KIND.STEEL, R());
  pod.dispose();
  for (const y of [6080, 6520]) {
    const ring = new THREE.CylinderGeometry(905, 905, 36, 24, 1, true);
    g.geometry(ring, new THREE.Matrix4().makeTranslation(x, y, z), [8, 6, 9], KIND.LAMP, R());
    ring.dispose();
  }
  g.beam([x, shaftTop, z], [x, SKYLINE_TOP - 80, z], 50, [0.3, 0.3, 0.32], KIND.STEEL, R());
  for (const y of [8000, 8800, SKYLINE_TOP - 60]) g.boxAt(x, y, z, 30, 30, 30, AVIATION, KIND.LAMP, R());
}

// ------------------------------------------------------------------------------------- generators

export interface CityLive {
  /** The merged live mesh geometry. */
  readonly geometry: THREE.BufferGeometry;
  /** The lamps of the live parts (the light map's input; the far city adds none). */
  readonly lamps: Lamp[];
  readonly stats: { readonly parts: number; readonly verts: number; readonly triangles: number };
}

/** The live (per-frame) part of the city: see the file header. */
export function buildCityLive(seed = 5): CityLive {
  const g = new GeoBuilder(false, 96000);
  const c: Ctx = { g, R: rng(seed), lamps: [] };
  const { R } = c;

  // ---- the deck's furniture: parked cars, light poles, the corner cores, the parapet
  for (const end of [-1, 1]) {
    for (let k = 0; k < ROWS; k++) {
      const zc = end * (ROW_Z0 + k * ROW_PITCH);
      for (const half of [-1, 1]) {
        for (let x = -BAY_X + BAY_W / 2; x < BAY_X; x += BAY_W) {
          if (R() < 0.42) parkedCar(c, x, zc + half * ROW_HALF * 0.5, -half);
        }
      }
    }
    for (const x of [-8000, -4000, 0, 4000, 8000]) {
      for (const k of [0.5, 1.5]) deckPole(c, x, end * (ROW_Z0 + k * ROW_PITCH));
      deckPole(c, x, end * (DECK_Z - 360));
    }
    for (const z of [-5000, -1700, 1700, 5000]) deckPole(c, end * 9200, z);
    for (const sx of [-1, 1]) core(c, sx * 9900, end * 12450, -end);
  }
  const P = 110;
  g.boxAt(0, QUAY + P / 2, DECK_Z - 18, DECK_X, P / 2, 18, CONCRETE, KIND.STEEL, R());
  g.boxAt(0, QUAY + P / 2, -DECK_Z + 18, DECK_X, P / 2, 18, CONCRETE, KIND.STEEL, R());
  g.boxAt(DECK_X - 18, QUAY + P / 2, 0, 18, P / 2, DECK_Z, CONCRETE, KIND.STEEL, R());
  g.boxAt(-DECK_X + 18, QUAY + P / 2, 0, 18, P / 2, DECK_Z, CONCRETE, KIND.STEEL, R());

  // ---- the landmarks, then the buildings across the streets, near to far
  landmarks(c);
  const live: { b: Building; h: number; d: number }[] = [];
  for (const b of planCity()) {
    const h = liveHeight(b);
    if (h !== null) live.push({ b, h, d: Math.hypot((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2) });
  }
  live.sort((a, b) => a.d - b.d);
  for (const { b, h } of live) building(c, b, h);

  // ---- the streets' life (seen from high cameras between the buildings)
  streetLife(c, LIVE_R, (x, z) => originDist(x, CITY_STREET + 900, z) < LIVE_R - 200, 3200, 1100, 0.3, true);

  // ---- ground last: the deck round the stadium's apron, the car park's walls, the streets
  const ax = 7500;
  const az = 6400;
  for (const s of [-1, 1]) {
    groundCells(c, -DECK_X, DECK_X, s > 0 ? az : -DECK_Z, s > 0 ? DECK_Z : -az, QUAY, LIVE_R, 1300, DECK_CONCRETE, DECK_SEED);
    groundCells(c, s > 0 ? ax : -DECK_X, s > 0 ? DECK_X : -ax, -az, az, QUAY, LIVE_R, 1300, DECK_CONCRETE, DECK_SEED);
  }
  const wallH = (QUAY - CITY_STREET) / 2;
  g.boxAt(0, CITY_STREET + wallH, DECK_Z + 20, DECK_X + 40, wallH, 20, CONCRETE, KIND.STEEL, R());
  g.boxAt(0, CITY_STREET + wallH, -DECK_Z - 20, DECK_X + 40, wallH, 20, CONCRETE, KIND.STEEL, R());
  g.boxAt(DECK_X + 20, CITY_STREET + wallH, 0, 20, wallH, DECK_Z, CONCRETE, KIND.STEEL, R());
  g.boxAt(-DECK_X - 20, CITY_STREET + wallH, 0, 20, wallH, DECK_Z, CONCRETE, KIND.STEEL, R());
  const S = LIVE_R;
  for (const s of [-1, 1]) {
    groundCells(c, -S, S, s > 0 ? DECK_Z : -S, s > 0 ? S : -DECK_Z, CITY_STREET, LIVE_R, 3000, ASPHALT, STREET_SEED);
    groundCells(c, s > 0 ? DECK_X : -S, s > 0 ? S : -DECK_X, -DECK_Z, DECK_Z, CITY_STREET, LIVE_R, 3000, ASPHALT, STREET_SEED);
  }

  const geometry = g.build(new THREE.Sphere(new THREE.Vector3(), LIVE_RADIUS)) as THREE.BufferGeometry;
  const triangles = (geometry.index as THREE.BufferAttribute).count / 3;
  return { geometry, lamps: c.lamps, stats: { parts: g.parts, verts: g.verts, triangles } };
}

export interface CityFar {
  /** The merged bake geometry (null for a dry run). */
  readonly geometry: THREE.BufferGeometry | null;
  /** Always empty: the far lamps only glow (their light on the ground is sub-pixel from the field). */
  readonly lamps: Lamp[];
  readonly stats: { readonly parts: number; readonly verts: number };
}

/** The baked (far) part of the city; `dry` only counts (and collects the lamps: none). */
export function buildCityFar(dry = false, seed = 13): CityFar {
  const g = new GeoBuilder(dry, 262144);
  const c: Ctx = { g, R: rng(seed), lamps: [] };

  // ---- every planned building the live layer does not draw, under the dome's parallax band
  const cap = SKYLINE_TOP - 60 - EXTRA_TOP - CITY_STREET;
  for (const b of planCity()) {
    if (liveHeight(b) === null) building(c, b, Math.min(b.h, cap));
  }
  needle(c, -24000, 62000);

  // ---- streets: lamp heads and traffic (no light map: their pools are sub-pixel from the field)
  streetLife(c, 64000, (x, z) => originDist(x, 0, z) > LIVE_R - 400 && Math.hypot(x, z) < 64000, 3600, 1500, 0.32, false);

  // ---- the ground: asphalt at street level out to the haze (the live layer covers the middle)
  g.boxAt(0, CITY_STREET - 100, 0, 170000, 100, 170000, ASPHALT, KIND.DECK, STREET_SEED);

  return { geometry: g.build(new THREE.Sphere(new THREE.Vector3(), 170000)), lamps: c.lamps, stats: { parts: g.parts, verts: g.verts } };
}
