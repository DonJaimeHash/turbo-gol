/**
 * Harbour skyline generator (original design): a container terminal around the stadium. Two parts,
 * both appended to GeoBuilders (geo.ts):
 *
 *   LIVE (`buildHarbourLive`)  what is near enough to need real parallax, drawn every frame as ONE
 *                              merged mesh (World.ts): the quay ground round the stadium, the two
 *                              container yards just beyond the ends of the field, the ship-to-shore
 *                              gantry cranes with lattice booms and A-frames on the north quay, the
 *                              rail-mounted gantries over the south yard, the light masts, a cruise
 *                              ship moored in the basin and the lighthouse on its breakwater.
 *   FAR  (`buildHarbourFar`)   everything farther, baked into the cube map: land and far shores,
 *                              more yards and cranes along the quay, buoys, the city on the far
 *                              shores. The sea is not here: it is its own bake mesh (sea level).
 *
 * Layout (top view, uu; the stadium sits at the origin, +z = behind the red goal = what the blue
 * kickoff camera faces, -x = the right of that view):
 *
 *   main land      x > WEST_QUAY, z < NORTH_QUAY (quay level y = QUAY, just under the pitch)
 *   north quay     z = NORTH_QUAY: STS cranes, booms over the water toward +z
 *   basin          x < WEST_QUAY between the south-west shore (z < SOUTH_BASIN) and the open sea
 *   north yard     z in [8300, 14800]  (live)     south yard   z in [-14800, -8300]  (live)
 *   cruise ship    moored in the basin mouth north-west, bow toward the basin (live)
 *   lighthouse     end of a breakwater north-east of the cranes (live)
 *   far shores     west (x < -46000) and north-east (z > 64000), city lights (bake)
 *
 * Every live part stays within LIVE_RADIUS of the origin (inside the camera's far plane from any
 * camera position, see World.ts) and outside the stadium footprint (|x| < STADIUM_HALF_X and
 * |z| < STADIUM_HALF_Z hold no tall part). Cranes, yards and the ship rise well above y = 900, over
 * the stadium's low LED boards.
 */
import * as THREE from 'three/webgpu';
import { GeoBuilder, KIND, rng, type Lamp, type Vec3 } from './geo';

export const SEA_LEVEL = -400;
/** Quay level: just under the pitch (y = 0), so the ground never fights the turf. */
export const QUAY = -30;
export const NORTH_QUAY = 18800;
export const WEST_QUAY = -12000;
export const SOUTH_BASIN = -9000;
/** Live geometry stays inside this radius (uu) round the origin. */
export const LIVE_RADIUS = 30500;
/** The lighthouse on its breakwater (live): tower foot, height, and the lantern centre (the beam's origin). */
const LIGHTHOUSE_AT: readonly [number, number] = [9500, 22500];
const LIGHTHOUSE_BASE = -220;
const LIGHTHOUSE_TOWER = 4400;
export const LIGHTHOUSE_LANTERN: Vec3 = [LIGHTHOUSE_AT[0], LIGHTHOUSE_BASE + LIGHTHOUSE_TOWER + 270, LIGHTHOUSE_AT[1]];
/** No tall live part inside this box (the stadium: side stands to |x| ~ 7600, field ends at |z| 6560). */
export const STADIUM_HALF_X = 8000;
export const STADIUM_HALF_Z = 7600;
/**
 * Highest point of the baked skyline (world y). The dome's parallax proxy hands over to "at
 * infinity" from dome.ts PROXY_TOP[0] over the bake origin (world y 10250) upward: anything
 * standing in that band is stretched and sheared from an off-centre camera (a far tower seen from
 * a high corner of the arena smeared its windows into streaks), so every top stays under it.
 */
export const SKYLINE_TOP = 10000;

const ASPHALT: Vec3 = [0.07, 0.07, 0.075];
const CONCRETE: Vec3 = [0.2, 0.2, 0.19];
const ROCK: Vec3 = [0.11, 0.1, 0.095];
const FARLAND: Vec3 = [0.045, 0.045, 0.05];
const CRANE_BLUE: Vec3 = [0.1, 0.16, 0.24];
const CRANE_RED: Vec3 = [0.36, 0.09, 0.05];
const RMG_YELLOW: Vec3 = [0.46, 0.34, 0.06];
const MAST_GREY: Vec3 = [0.13, 0.135, 0.14];
const SODIUM_LAMP: Vec3 = [16, 9.5, 4.2];
const LED_LAMP: Vec3 = [9, 9.4, 10];
const RED_LAMP: Vec3 = [9, 0.5, 0.25];
const SODIUM: Vec3 = [3.6, 2.0, 0.8];
const LED: Vec3 = [1.6, 1.65, 1.8];

const CONTAINER_COLORS: readonly (readonly [Vec3, number])[] = [
  [[0.3, 0.07, 0.05], 3], // rust red
  [[0.05, 0.11, 0.24], 3], // blue
  [[0.04, 0.2, 0.21], 2], // teal
  [[0.42, 0.17, 0.04], 2], // orange
  [[0.27, 0.27, 0.27], 2], // grey
  [[0.06, 0.17, 0.08], 1.5], // green
  [[0.42, 0.32, 0.05], 1], // yellow
  [[0.55, 0.55, 0.52], 1.5], // white
  [[0.2, 0.1, 0.05], 1.5], // brown
  [[0.24, 0.05, 0.12], 1], // maroon
  [[0.02, 0.06, 0.15], 1.5], // navy
];
const COLOR_TOTAL = CONTAINER_COLORS.reduce((s, c) => s + c[1], 0);

const _up = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _t = new THREE.Matrix4();

/** Shared state of one generator run. */
interface Ctx {
  readonly g: GeoBuilder;
  readonly R: () => number;
  readonly lamps: Lamp[];
}

function pickColor(R: () => number): Vec3 {
  let r = R() * COLOR_TOTAL;
  for (const [c, w] of CONTAINER_COLORS) {
    r -= w;
    if (r <= 0) return c;
  }
  return CONTAINER_COLORS[0][0];
}

/** A local frame (position, yaw about y, uniform scale) and helpers that place parts in it. */
function frame(c: Ctx, x: number, y: number, z: number, yaw: number, scale: number) {
  const M = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(_up, yaw), new THREE.Vector3(scale, scale, scale));
  const P = (px: number, py: number, pz: number): Vec3 => {
    _v.set(px, py, pz).applyMatrix4(M);
    return [_v.x, _v.y, _v.z];
  };
  return {
    M,
    P,
    /** Square beam between two local points (`w` in world uu). */
    beam(a: Vec3, b: Vec3, w: number, rgb: Vec3, kind: number = KIND.STEEL): void {
      c.g.beam(P(a[0], a[1], a[2]), P(b[0], b[1], b[2]), w, rgb, kind, c.R());
    },
    /** Box centred at a local point, half sizes in local units. */
    box(px: number, py: number, pz: number, hx: number, hy: number, hz: number, rgb: Vec3, kind: number = KIND.STEEL): void {
      c.g.box(_t.copy(M).multiply(new THREE.Matrix4().makeTranslation(px, py, pz)), hx, hy, hz, rgb, kind, c.R());
    },
  };
}

// ------------------------------------------------------------------------------------------ parts

/** Land block from sea level up to `top`. */
function land(c: Ctx, x0: number, x1: number, z0: number, z1: number, top: number, rgb: Vec3 = ASPHALT, kind: number = KIND.GROUND): void {
  const bottom = SEA_LEVEL + 2;
  c.g.boxAt((x0 + x1) / 2, (top + bottom) / 2, (z0 + z1) / 2, (x1 - x0) / 2, (top - bottom) / 2, (z1 - z0) / 2, rgb, kind, c.R());
}

/**
 * Container yard: bays along one axis, rows across, stacks of `maxTiers` at most following a smooth
 * height field (+ noise), a cross lane every 7 bays and a straddle-carrier lane every 9 rows; 15% of
 * the slots hold two 20-foot boxes instead of one 40-foot. `minTiers` lifts the low stacks.
 */
function yard(c: Ctx, x0: number, x1: number, z0: number, z1: number, alongX: boolean, maxTiers: number, phase: number, minTiers = 0): void {
  const { g, R } = c;
  const L = 1219;
  const W = 244;
  const H = 259;
  const pitchL = L + 70;
  const pitchW = W + 36;
  const spanL = alongX ? x1 - x0 : z1 - z0;
  const spanW = alongX ? z1 - z0 : x1 - x0;
  const nBays = Math.floor(spanL / pitchL);
  const nRows = Math.floor(spanW / pitchW);
  for (let bay = 0; bay < nBays; bay++) {
    if (bay % 7 === 6) continue; // cross lane
    for (let row = 0; row < nRows; row++) {
      if (row % 9 === 8) continue; // straddle-carrier lane
      const hN = 0.55 + 0.32 * Math.sin(bay * 0.53 + phase) * Math.cos(row * 0.19 + phase * 1.7) + 0.4 * (R() - 0.5);
      const tiers = Math.max(minTiers, Math.min(maxTiers, Math.round(hN * (maxTiers + 0.6))));
      const a = (alongX ? x0 : z0) + (bay + 0.5) * pitchL;
      const b = (alongX ? z0 : x0) + (row + 0.5) * pitchW;
      for (let t = 0; t < tiers; t++) {
        const y = QUAY + H / 2 + t * H + 1;
        const twenty = R() < 0.15;
        for (let k = 0; k < (twenty ? 2 : 1); k++) {
          const off = twenty ? (k - 0.5) * (L / 2 + 3) : 0;
          const hl = twenty ? L / 4 - 2 : L / 2;
          const cx = alongX ? a + off : b;
          const cz = alongX ? b : a + off;
          g.boxAt(cx, y, cz, hl, H / 2, W / 2, pickColor(R), KIND.CONTAINER, R(), alongX ? 0 : Math.PI / 2);
        }
      }
    }
  }
}

/** Yard light mast: a tall pole, a head frame with four sodium lamps, one lamp in the light map. */
function mast(c: Ctx, x: number, z: number, h = 3300): void {
  const { g, R } = c;
  g.boxAt(x, QUAY + h / 2, z, 32, h / 2, 32, MAST_GREY, KIND.STEEL, R());
  g.boxAt(x, QUAY + h + 30, z, 280, 28, 110, [0.15, 0.15, 0.15], KIND.STEEL, R());
  for (let i = 0; i < 4; i++) g.boxAt(x - 200 + i * 133, QUAY + h - 8, z, 52, 18, 70, SODIUM_LAMP, KIND.LAMP, R());
  c.lamps.push({ pos: [x, QUAY + h - 120, z], range: 2700, color: SODIUM, down: 1 });
}

/** Quay lamp posts along z = `z` from x0 to x1. */
function quayPosts(c: Ctx, x0: number, x1: number, z: number): void {
  const { g, R } = c;
  for (let x = x0, i = 0; x < x1; x += 2900, i++) {
    g.boxAt(x, QUAY + 550, z, 22, 550, 22, [0.25, 0.25, 0.26], KIND.STEEL, R());
    g.boxAt(x, QUAY + 1110, z - 50, 40, 14, 70, LED_LAMP, KIND.LAMP, R());
    if (i % 3 === 0) c.lamps.push({ pos: [x, QUAY + 1000, z - 100], range: 1300, color: LED, down: 1 });
  }
}

/**
 * Truss between two chords in a local frame: `bot(s)` / `top(s)` give the chord points at
 * station s (0..1); `n` panels with posts and alternating diagonals (a Pratt truss).
 */
function truss(f: ReturnType<typeof frame>, bot: (s: number) => Vec3, top: (s: number) => Vec3, n: number, chord: number, web: number, rgb: Vec3): void {
  f.beam(bot(0), bot(1), chord, rgb);
  f.beam(top(0), top(1), chord, rgb);
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    f.beam(bot(s), top(s), web, rgb);
    if (i < n) {
      const s2 = (i + 1) / n;
      if (i % 2 === 0) f.beam(bot(s), top(s2), web, rgb);
      else f.beam(top(s), bot(s2), web, rgb);
    }
  }
}

/**
 * Ship-to-shore gantry crane (about 62 m to the apex): a four-leg portal with braced side frames,
 * a lattice back-reach and a lattice outreach boom over the water (local +z), raised to ~72 deg
 * when `raised`, an A-frame with fore- and backstays, the machinery house, trolley, spreader and
 * the lamps. Local frame: x along the quay, z toward the water, y up; scale 0.85.
 */
function stsCrane(c: Ctx, cx: number, cz: number, yaw: number, raised: boolean, rgb: Vec3): void {
  const CS = 0.85;
  const f = frame(c, cx, QUAY, cz, yaw, CS);
  const LX = 850;
  const LZ = 1500;
  const TOP = 4300;
  const BY = 4500; // boom underside
  const BH = 520; // boom girder depth
  const BX = 650; // girder offset from the centre line
  const GREY: Vec3 = [0.4, 0.42, 0.44];
  // ---- portal: legs, braced side frames, top beams
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) f.beam([sx * LX, 0, sz * LZ], [sx * LX, TOP, sz * LZ], 150, rgb);
    f.box(sx * LX, TOP - 120, 0, 90, 130, LZ + 80, rgb);
    f.beam([sx * LX, 1300, -LZ], [sx * LX, 1300, LZ], 90, rgb);
    f.beam([sx * LX, 1300, -LZ], [sx * LX, TOP - 250, 0], 70, rgb);
    f.beam([sx * LX, 1300, LZ], [sx * LX, TOP - 250, 0], 70, rgb);
    f.beam([sx * LX, 140, -LZ], [sx * LX, 140, LZ], 110, [0.16, 0.16, 0.17]); // sill beam / rail bogies
  }
  for (const sz of [-1, 1]) f.box(0, TOP - 100, sz * LZ, LX + 80, 110, 90, rgb);
  // ---- back-reach (fixed, landside): two lattice girders, cross members underneath
  const BACK = -3300;
  for (const sx of [-1, 1]) {
    const x = sx * BX;
    truss(f, (s) => [x, BY, LZ + (BACK - LZ) * s], (s) => [x, BY + BH, LZ + (BACK - LZ) * s], 8, 70, 34, rgb);
  }
  for (let i = 0; i <= 4; i++) {
    const z = LZ + ((BACK - LZ) * i) / 4;
    f.beam([-BX, BY, z], [BX, BY, z], 50, rgb);
    f.beam([-BX, BY + BH, z], [BX, BY + BH, z], 40, rgb);
  }
  // ---- outreach boom, hinged at the waterside legs; tapers toward the tip
  const ang = raised ? 1.26 : 0;
  const sa = Math.sin(ang);
  const ca = Math.cos(ang);
  const OUT = 6100;
  const hy = BY + BH / 2;
  /** Local point at distance s along the boom and h across it (h = 0 on the boom's axis). */
  const O = (s: number, h: number, x: number): Vec3 => [x, hy + s * sa + h * ca, LZ + s * ca - h * sa];
  const topH = (s: number): number => BH / 2 - BH * 0.42 * s;
  for (const sx of [-1, 1]) {
    const x = sx * BX;
    truss(f, (s) => O(s * OUT, -BH / 2, x), (s) => O(s * OUT, topH(s), x), 10, 70, 32, rgb);
  }
  for (let i = 0; i <= 10; i += 2) {
    const s = (i / 10) * OUT;
    f.beam(O(s, -BH / 2, -BX), O(s, -BH / 2, BX), 50, rgb);
    f.beam(O(s, topH(i / 10), -BX), O(s, topH(i / 10), BX), 38, rgb);
    if (i < 10) f.beam(O(s, topH(i / 10), -BX), O(s + OUT / 5, topH((i + 2) / 10), BX), 26, rgb);
  }
  // ---- A-frame (with ties and braces), apex beam, fore- and backstays
  const AP: Vec3 = [0, 7300, -250];
  for (const sx of [-1, 1]) {
    const apex: Vec3 = [sx * 420, AP[1], AP[2]];
    const front: Vec3 = [sx * BX, BY + BH, LZ - 150];
    const back: Vec3 = [sx * BX, BY + BH, -LZ];
    f.beam(front, apex, 120, rgb);
    f.beam(back, apex, 120, rgb);
    const mid = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    f.beam(mid(front, apex, 0.5), mid(back, apex, 0.5), 60, rgb);
    f.beam(mid(front, apex, 0.5), back, 44, rgb);
    f.beam(mid(back, apex, 0.5), front, 44, rgb);
    for (const s of [0.48, 0.95]) f.beam([sx * 420, AP[1] - 40, AP[2]], O(s * OUT, topH(s), sx * BX), 30, [0.5, 0.52, 0.55]);
    f.beam([sx * 420, AP[1] - 40, AP[2]], [sx * BX, BY + BH, BACK + 50], 34, [0.5, 0.52, 0.55]);
  }
  f.box(AP[0], AP[1], AP[2], 470, 70, 70, rgb);
  f.beam([-470, BY + BH + 1300, LZ - 150 - 400], [470, BY + BH + 1300, LZ - 150 - 400], 50, rgb);
  // ---- machinery house, cab, trolley + spreader (boom down), lamps
  f.box(0, BY + BH + 320, -2450, 920, 320, 720, GREY);
  f.box(0, BY - 190, 2050, 170, 170, 200, [0.38, 0.4, 0.43]);
  f.box(0, BY - 190, 2258, 140, 90, 6, [2.2, 1.6, 1.0], KIND.LAMP);
  if (!raised) {
    f.box(0, BY - 60, 4300, 520, 90, 380, [0.3, 0.31, 0.33]);
    for (const sx of [-1, 1]) f.beam([sx * 320, BY - 150, 4300], [sx * 320, 2300, 4300], 26, [0.05, 0.05, 0.05]);
    f.box(0, 2200, 4300, 640, 60, 130, [0.42, 0.3, 0.05]);
    for (const s of [900, 3300, 5600]) {
      const p = O(s, -BH / 2 - 35, 0);
      f.box(0, p[1], p[2], 170, 22, 90, LED_LAMP, KIND.LAMP);
    }
  }
  f.box(0, BY - 30, -1500, 170, 22, 90, LED_LAMP, KIND.LAMP);
  f.box(AP[0], AP[1] + 100, AP[2], 32, 32, 32, RED_LAMP, KIND.LAMP);
  const tip = O(OUT, topH(1) + 40, 0);
  if (raised) f.box(tip[0], tip[1], tip[2], 32, 32, 32, RED_LAMP, KIND.LAMP);
  c.lamps.push({ pos: f.P(0, BY - 250, raised ? 0 : 1800), range: 2300, color: LED, down: 1 });
}

/**
 * Rail-mounted gantry over a container block: two braced leg frames on rails at z = +-span/2
 * (local), two lattice girders across with a short cantilever, the trolley, under-girder floods.
 * Local frame: x along the rails, z across the block.
 */
function rmgCrane(c: Ctx, cx: number, cz: number, yaw: number, span: number): void {
  const f = frame(c, cx, QUAY, cz, yaw, 1);
  const H = 2350;
  const LEGX = 900;
  const GX = 380;
  const GD = 300;
  const half = span / 2;
  const reach = half + 700;
  for (const sz of [-1, 1]) {
    const z = sz * half;
    for (const sx of [-1, 1]) f.beam([sx * LEGX, 0, z], [sx * GX, H, z], 110, RMG_YELLOW);
    f.beam([-LEGX - 150, 90, z], [LEGX + 150, 90, z], 120, [0.2, 0.18, 0.12]);
    f.beam([-LEGX * 0.8, 300, z], [GX, H - 200, z], 50, RMG_YELLOW);
    f.beam([LEGX * 0.8, 300, z], [-GX, H - 200, z], 50, RMG_YELLOW);
    f.beam([-GX - 60, H, z], [GX + 60, H, z], 90, RMG_YELLOW);
  }
  for (const sx of [-1, 1]) {
    const x = sx * GX;
    truss(f, (s) => [x, H, -reach + 2 * reach * s], (s) => [x, H + GD, -reach + 2 * reach * s], 10, 60, 28, RMG_YELLOW);
  }
  for (let i = 0; i <= 5; i++) {
    const z = -reach + (2 * reach * i) / 5;
    f.beam([-GX, H + GD, z], [GX, H + GD, z], 34, RMG_YELLOW);
  }
  const tz = (c.R() - 0.5) * span * 0.6;
  f.box(0, H + GD + 140, tz, GX + 120, 140, 320, [0.5, 0.5, 0.5]);
  for (const sx of [-1, 1]) f.beam([sx * 200, H, tz], [sx * 200, 900, tz], 20, [0.05, 0.05, 0.05]);
  f.box(0, 880, tz, 620, 50, 120, [0.42, 0.3, 0.05]);
  for (const s of [-0.5, 0.5]) f.box(0, H - 30, s * span, 160, 20, 80, LED_LAMP, KIND.LAMP);
  c.lamps.push({ pos: f.P(0, H - 200, 0), range: 2200, color: LED, down: 1 });
}

/**
 * Cruise ship: a hull extruded from a deck outline (transom stern, parallel mid-body, curved bow
 * toward local +z), nine white decks of lit windows, a bridge with wings and side lights, the
 * funnel, a mast with lamps, lifeboats and deck light strings. `scale` 1 is 240 m long.
 */
function cruiseShip(c: Ctx, x: number, z: number, yaw: number, scale: number): void {
  const f = frame(c, x, SEA_LEVEL, z, yaw, scale);
  const HB = 1600;
  const LS = 12000;
  const FB = 1300; // freeboard
  const s = new THREE.Shape();
  s.moveTo(-HB * 0.9, LS);
  s.lineTo(HB * 0.9, LS);
  s.quadraticCurveTo(HB, LS, HB, LS - 900);
  s.lineTo(HB, -5000);
  s.bezierCurveTo(HB, -8800, HB * 0.45, -11000, 0, -LS);
  s.bezierCurveTo(-HB * 0.45, -11000, -HB, -8800, -HB, -5000);
  s.lineTo(-HB, LS - 900);
  s.quadraticCurveTo(-HB, LS, -HB * 0.9, LS);
  const hull = new THREE.ExtrudeGeometry(s, { depth: FB, bevelEnabled: false, curveSegments: 10 });
  hull.rotateX(-Math.PI / 2);
  hull.deleteAttribute('uv');
  c.g.geometry(hull, f.M, [0.02, 0.04, 0.09], KIND.HULL, c.R());
  hull.dispose();
  const DH = 290;
  const ND = 9;
  const WHITE: Vec3 = [0.62, 0.63, 0.62];
  for (let i = 0; i < ND; i++) {
    const y0 = FB + i * DH;
    const zb = -10300 + i * 130 + (i > 6 ? 700 : 0);
    const zf = 5300 - i * 330;
    const hx = HB - 170 - (i > 5 ? 140 : 0);
    f.box(0, y0 + DH / 2, (zb + zf) / 2, hx, DH / 2 - 7, (zf - zb) / 2, WHITE, KIND.WINDOWS);
  }
  const topY = FB + ND * DH;
  const zBridge = 5300 - (ND - 2) * 330 - 260;
  f.box(0, FB + (ND - 2) * DH + DH / 2, zBridge, HB + 260, DH / 2 - 7, 240, WHITE, KIND.WINDOWS);
  f.box(HB + 230, FB + (ND - 2) * DH + DH / 2, zBridge + 200, 25, 25, 25, [0.4, 7, 1.2], KIND.LAMP);
  f.box(-HB - 230, FB + (ND - 2) * DH + DH / 2, zBridge + 200, 25, 25, 25, [8, 0.5, 0.3], KIND.LAMP);
  f.box(0, topY + 800, -7400, 520, 800, 950, [0.04, 0.09, 0.22]);
  f.box(0, topY + 1630, -7400, 530, 30, 960, [0.02, 0.02, 0.02]);
  f.beam([0, topY, 2400], [0, topY + 1700, 2400], 70 * scale, [0.5, 0.5, 0.5]);
  f.box(0, topY + 1740, 2400, 40, 40, 40, LED_LAMP, KIND.LAMP);
  f.box(0, topY + 1300, 2400, 35, 35, 35, RED_LAMP, KIND.LAMP);
  for (let zz = -8600; zz <= 3400; zz += 1000) {
    for (const sx of [-1, 1]) f.box(sx * (HB - 60), FB + 2 * DH + 150, zz, 75, 110, 390, [0.55, 0.2, 0.02]);
  }
  for (let zz = -9200; zz <= 2400; zz += 420) {
    for (const sx of [-1, 1]) f.box(sx * (HB - 330), topY + 20, zz, 22, 22, 22, [7, 5.6, 3.8], KIND.LAMP);
  }
  c.lamps.push({ pos: f.P(0, topY + 500, -4000), range: 3000 * scale, color: [1.3, 1.05, 0.75], down: 0 });
  c.lamps.push({ pos: f.P(0, topY + 500, 2000), range: 3000 * scale, color: [1.3, 1.05, 0.75], down: 0 });
  c.lamps.push({ pos: f.P(0, FB + 900, 9500), range: 2600 * scale, color: LED, down: 0 });
}

/** Breakwater of rock from `a` to the lighthouse at `lh`, the striped tower, gallery, lantern, roof. */
function lighthouse(c: Ctx, a: readonly [number, number], lh: readonly [number, number]): { pos: Vec3; height: number } {
  const { g, R } = c;
  const base = LIGHTHOUSE_BASE;
  const dx = lh[0] - a[0];
  const dz = lh[1] - a[1];
  const len = Math.hypot(dx, dz);
  const yaw = Math.atan2(-dz, dx);
  g.boxAt((a[0] + lh[0]) / 2, (base + SEA_LEVEL + 2) / 2, (a[1] + lh[1]) / 2, len / 2 + 300, (base - SEA_LEVEL - 2) / 2, 380, ROCK, KIND.ROCK, R(), yaw);
  g.boxAt(lh[0], (base + SEA_LEVEL + 2) / 2, lh[1], 600, (base - SEA_LEVEL - 2) / 2, 600, ROCK, KIND.ROCK, R());
  const TH = LIGHTHOUSE_TOWER;
  const place = (y: number): THREE.Matrix4 => new THREE.Matrix4().makeTranslation(lh[0], y, lh[1]);
  const tower = new THREE.CylinderGeometry(230, 360, TH, 24, 1, false);
  g.geometry(tower, place(base + TH / 2), [1, 1, 1], KIND.LIGHTHOUSE, R());
  const gallery = new THREE.CylinderGeometry(420, 420, 80, 24);
  g.geometry(gallery, place(base + TH + 40), [0.06, 0.06, 0.06], KIND.STEEL, R());
  const lantern = new THREE.CylinderGeometry(240, 240, 420, 16);
  g.geometry(lantern, place(base + TH + 270), [24, 18, 11], KIND.LAMP, R());
  const roof = new THREE.ConeGeometry(270, 320, 16);
  g.geometry(roof, place(base + TH + 620), [0.4, 0.04, 0.03], KIND.STEEL, R());
  for (const geo of [tower, gallery, lantern, roof]) geo.dispose();
  c.lamps.push({ pos: [lh[0], base + TH + 300, lh[1]], range: 700, color: [3, 2.4, 1.6], down: 0 });
  c.lamps.push({ pos: [lh[0] - 500, base + 300, lh[1] - 900], range: 1200, color: [1.2, 0.8, 0.45], down: 0 });
  return { pos: [lh[0], base + TH + 270, lh[1]], height: TH };
}

/** Quay ground round the stadium: the up-facing cells of a region that lie inside a disc of `radius`. */
function groundCells(c: Ctx, x0: number, x1: number, z0: number, z1: number, radius: number, cell: number): void {
  const ax0 = Math.max(x0, -radius);
  const ax1 = Math.min(x1, radius);
  const az0 = Math.max(z0, -radius);
  const az1 = Math.min(z1, radius);
  for (let x = ax0; x < ax1; x += cell) {
    for (let z = az0; z < az1; z += cell) {
      const cx1 = Math.min(x + cell, ax1);
      const cz1 = Math.min(z + cell, az1);
      // the cell's farthest corner stays inside the disc
      const fx = Math.max(Math.abs(x), Math.abs(cx1));
      const fz = Math.max(Math.abs(z), Math.abs(cz1));
      if (Math.hypot(fx, fz) > radius) continue;
      c.g.quadUp(x, z, cx1, cz1, QUAY, ASPHALT, KIND.GROUND, c.R());
    }
  }
}

// ------------------------------------------------------------------------------------- generators

export interface HarbourLive {
  /** The merged live mesh geometry. */
  readonly geometry: THREE.BufferGeometry;
  /** The lamps of the live parts (part of the light map). */
  readonly lamps: Lamp[];
  /** Lantern centre of the lighthouse (the beam's origin) and the tower height. */
  readonly lighthouse: { readonly pos: Vec3; readonly height: number };
  readonly stats: { readonly parts: number; readonly verts: number; readonly triangles: number };
}

/** The live (per-frame) part of the harbour: see the file header. */
export function buildHarbourLive(seed = 7): HarbourLive {
  const g = new GeoBuilder(false, 80000);
  const c: Ctx = { g, R: rng(seed), lamps: [] };
  const R = LIVE_RADIUS - 300;

  // ---- quay ground (main land and the south-west shore of the basin), quay edges
  groundCells(c, WEST_QUAY, R, -R, NORTH_QUAY, R, 2500);
  groundCells(c, -R, WEST_QUAY, -R, SOUTH_BASIN, R, 2500);
  // quay walls down to the water, cut where the ground disc ends
  const northEnd = Math.sqrt(R * R - NORTH_QUAY * NORTH_QUAY);
  const southWestEnd = -Math.sqrt(R * R - SOUTH_BASIN * SOUTH_BASIN);
  g.boxAt((WEST_QUAY + northEnd) / 2, (QUAY + SEA_LEVEL) / 2, NORTH_QUAY - 150, (northEnd - WEST_QUAY) / 2, (QUAY - SEA_LEVEL) / 2, 150, CONCRETE, KIND.GROUND, c.R());
  g.boxAt(WEST_QUAY + 150, (QUAY + SEA_LEVEL) / 2, (SOUTH_BASIN + NORTH_QUAY) / 2, 150, (QUAY - SEA_LEVEL) / 2, (NORTH_QUAY - SOUTH_BASIN) / 2, CONCRETE, KIND.GROUND, c.R());
  g.boxAt((WEST_QUAY + southWestEnd) / 2, (QUAY + SEA_LEVEL) / 2, SOUTH_BASIN - 150, (WEST_QUAY - southWestEnd) / 2, (QUAY - SEA_LEVEL) / 2, 150, CONCRETE, KIND.GROUND, c.R());

  // ---- container yards just beyond both ends of the field (tall stacks over the LED boards)
  // (lower stacks on the ship's side, so its decks clear them from the field)
  yard(c, -11000, -3260, 8300, 14800, true, 2, 0.3, 1);
  yard(c, -3260, 13000, 8300, 14800, true, 5, 1.7, 2);
  yard(c, -11000, 13000, -14800, -8300, true, 4, 2.6, 1);

  // ---- light masts in the yards' lanes and at their edges, posts along the north quay
  for (const x of [-2621, 6402]) {
    for (const z of [10680, 13200, -12420, -9900]) mast(c, x, z);
  }
  for (const x of [-11400, 13400]) {
    mast(c, x, 11550);
    mast(c, x, -11550);
  }
  quayPosts(c, -9000, 24000, NORTH_QUAY - 120);

  // ---- ship-to-shore cranes on the north quay (one red, one boom raised), RMGs over the south yard
  const sts: readonly (readonly [number, boolean, Vec3])[] = [
    [-2600, false, CRANE_BLUE],
    [1100, true, CRANE_BLUE],
    [4800, false, CRANE_RED],
  ];
  for (const [x, raised, rgb] of sts) stsCrane(c, x, NORTH_QUAY - 1900, 0, raised, rgb);
  for (const x of [-6200, 1300, 8800]) rmgCrane(c, x, -11550, 0, 3600);

  // ---- cruise ship moored in the basin mouth, lighthouse on a breakwater north-east of the cranes
  cruiseShip(c, -9500, 21600, -1.92, 0.85);
  const lh = lighthouse(c, [13500, NORTH_QUAY], LIGHTHOUSE_AT);

  const geometry = g.build(new THREE.Sphere(new THREE.Vector3(), LIVE_RADIUS)) as THREE.BufferGeometry;
  const triangles = (geometry.index as THREE.BufferAttribute).count / 3;
  return { geometry, lamps: c.lamps, lighthouse: lh, stats: { parts: g.parts, verts: g.verts, triangles } };
}

export interface HarbourFar {
  /** The merged bake geometry (null for a dry run). */
  readonly geometry: THREE.BufferGeometry | null;
  readonly lamps: Lamp[];
  readonly stats: { readonly parts: number; readonly verts: number };
}

/** The baked (far) part of the harbour; `dry` only collects the lamps. */
export function buildHarbourFar(dry = false, seed = 11): HarbourFar {
  const g = new GeoBuilder(dry, 192000);
  const c: Ctx = { g, R: rng(seed), lamps: [] };
  const { R } = c;

  // ---- land (bottoms at sea level); the live ground covers the part round the stadium
  land(c, WEST_QUAY, 160000, -160000, NORTH_QUAY, QUAY);
  land(c, -160000, WEST_QUAY, -160000, SOUTH_BASIN, QUAY);
  land(c, -160000, -46000, SOUTH_BASIN, 70000, -260, FARLAND);
  land(c, 25000, 160000, 64000, 160000, -260, FARLAND);
  g.boxAt(52000, QUAY + 4, NORTH_QUAY - 700, 26000, 6, 700, CONCRETE, KIND.GROUND, R());

  // ---- more yards, masts and cranes beyond the live ones
  yard(c, 16500, 42000, 7000, 15200, true, 4, 1.1);
  yard(c, 16500, 42000, -15200, -7000, true, 4, 3.8);
  yard(c, -9000, 14000, -30000, -19000, true, 4, 4.4);
  yard(c, 44000, 60000, -9000, 14000, false, 3, 2.2);
  for (const x of [20000, 28000, 36000]) {
    mast(c, x, 11000);
    mast(c, x, -11000);
  }
  mast(c, -3000, -24500);
  mast(c, 6000, -24500);
  quayPosts(c, 26000, 62000, NORTH_QUAY - 120);
  const craneXs = [24200, 27900, 31600, 35300, 39000, 42700];
  craneXs.forEach((x, i) => stsCrane(c, x, NORTH_QUAY - 1900, 0, i === 2 || i === 5, i === 3 ? CRANE_RED : CRANE_BLUE));

  // ---- buoys at the basin mouth
  g.boxAt(-14600, SEA_LEVEL + 90, 30500, 40, 90, 40, [0.5, 8, 1.4], KIND.LAMP, R());
  g.boxAt(-4200, SEA_LEVEL + 90, 33500, 40, 90, 40, [9, 0.6, 0.4], KIND.LAMP, R());

  // ---- distant city on the far shores
  const city = (x0: number, x1: number, z0: number, z1: number, base: number, count: number, hMin: number, hMax: number, tall: number): void => {
    for (let i = 0; i < count; i++) {
      const x = x0 + (x1 - x0) * R();
      const z = z0 + (z1 - z0) * R();
      const w = 700 + 1800 * R();
      const d = 700 + 1800 * R();
      // every top and its roof lamp (60 uu) stay under SKYLINE_TOP (the dome's parallax band)
      const cap = SKYLINE_TOP - 60;
      let h = hMin + (hMax - hMin) * Math.pow(R(), 2.2);
      if (R() < tall) h *= 2.2;
      h = Math.min(h, cap - base);
      const k = 0.75 + 0.5 * R();
      const yaw = R() * 0.6;
      const tone: Vec3 = [0.045 * k, 0.05 * k, 0.06 * k];
      // seed < 0.2 = an office block with its lights mostly off (FARCITY pattern)
      g.boxAt(x, base + h / 2, z, w, h / 2, d, tone, KIND.FARCITY, R(), yaw);
      let top = base + h;
      if (h > 3500 && R() < 0.4) {
        const h2 = Math.min(h * (0.15 + 0.25 * R()), cap - top);
        const seed = R();
        if (h2 > 100) {
          g.boxAt(x, top + h2 / 2, z, w * 0.62, h2 / 2, d * 0.62, tone, KIND.FARCITY, seed, yaw);
          top += h2;
        }
      }
      if (top - base > 7000) g.boxAt(x, top + 30, z, 30, 30, 30, RED_LAMP, KIND.LAMP, R());
    }
  };
  city(-95000, -48000, -5000, 66000, -260, 170, 1500, 6000, 0.08);
  city(28000, 115000, 66000, 125000, -260, 120, 1200, 5000, 0.06);
  city(-36000, 30000, -75000, -34000, QUAY, 230, 2000, 9000, 0.15);
  city(64000, 90000, -28000, 18000, QUAY, 90, 800, 2600, 0.04);
  city(-85000, -20000, -65000, -16000, QUAY, 120, 1500, 6000, 0.06);

  return { geometry: g.build(new THREE.Sphere(new THREE.Vector3(), 160000)), lamps: c.lamps, stats: { parts: g.parts, verts: g.verts } };
}
