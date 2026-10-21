/**
 * Railyard skyline generator (original design, theme 'railyard-night', "Patio Ferroviario"): an
 * old railway depot turned stadium. Brick factory halls with arched windows lit warmly, tall brick
 * chimneys, steel lattice gantries, a brick viaduct with a lit passenger train, freight wagons on
 * the yard tracks, water towers and gasholders, and a city glowing on the horizon behind the far
 * goal. Two parts, both appended to GeoBuilders (geo.ts), like the harbour (harbour.ts):
 *
 *   LIVE (`buildRailyardLive`)  what is near enough to need real parallax, drawn every frame as ONE
 *                               merged mesh (World.ts swaps it into the live layer for this theme):
 *                               the yard ground round the stadium, the lattice gantry and the brick
 *                               halls framing the far end, the chimney and the water tower behind
 *                               it, the viaduct with its train, the engine shed behind the near
 *                               goal, the warehouses behind the side stands, wagons, masts.
 *   FAR  (`buildRailyardFar`)   everything farther, baked into the cube map: the plain and its track
 *                               fields, more halls, chimneys and gasholders, and the city.
 *
 * Layout (top view, uu; the stadium sits at the origin; +z = behind the red goal, what the blue
 * kickoff camera faces; -x = the right of that view, +x = its left):
 *
 *   far end (+z)     gantry over the yard at z = GANTRY_Z between two lattice towers at |x| =
 *                    GANTRY_TOWER_X; brick halls at |x| > 6900, z 8000..13000 (the "Deposito" on
 *                    the right, the sawtooth "Talleres" on the left); the chimney (right) and the
 *                    water tower (left) behind the gantry; the viaduct along x at z = VIADUCT_Z with
 *                    a passenger train on it; freight tracks at ground level in between
 *   near end (-z)    the engine shed (big lit arched doors toward the pitch), tracks into it, a
 *                    second chimney and water tower, a signal gantry
 *   sides (|x|)      tall warehouses behind the stands (their lit windows show over the canopy)
 *
 * Every live part stays within harbour.ts LIVE_RADIUS and outside the stadium footprint
 * (STADIUM_HALF_X / STADIUM_HALF_Z hold nothing above the ground), and every baked top stays under
 * SKYLINE_TOP (the dome's parallax band).
 *
 * Patterns (railyardMaterial.ts): KIND.BRICK walls draw their arched windows, piers, string courses
 * and soot from the part's box; the integer part of the seed (kdat.w) is the facade style (0 plain
 * brick, 1..4 storeys of arched windows), its fraction the random seed. KIND.RAILBED is ballast with
 * sleepers and rails on single-track beds (half width under RAILBED_TRACK_HALF), plain gravel on
 * wide ground. Boxcars reuse KIND.CONTAINER, coaches KIND.WINDOWS.
 */
import * as THREE from 'three/webgpu';
import { GeoBuilder, KIND, rng, type Lamp, type Vec3 } from './geo';
import { LIVE_RADIUS, QUAY, SKYLINE_TOP, STADIUM_HALF_X, STADIUM_HALF_Z } from './harbour';

/** Ground level of the yard (the harbour's quay level: just under the pitch). */
export const YARD = QUAY;
/** The lattice gantry over the far end: its z, the x of its towers and its chords' heights. */
export const GANTRY_Z = 10000;
export const GANTRY_TOWER_X = 5800;
export const GANTRY_BOTTOM = 1750;
export const GANTRY_TOP = 2350;
/** The brick viaduct behind the gantry: its axis z and the top of its deck. */
export const VIADUCT_Z = 14300;
export const VIADUCT_DECK = 1000;
/** The far end's chimney (right of the goal) and its top. */
export const CHIMNEY_AT: readonly [number, number] = [-4600, 13200];
export const CHIMNEY_TOP = 7000;
/** A track bed narrower than this (half width, uu) draws sleepers and rails (railyardMaterial.ts). */
export const RAILBED_TRACK_HALF = 300;
/** Track gauge (rail centre to rail centre, uu) the pattern draws. */
export const RAIL_GAUGE = 144;

// ---- palette (linear albedo; lamps are HDR emission)
const BRICK_RED: Vec3 = [0.2, 0.058, 0.034];
const BRICK_DARK: Vec3 = [0.13, 0.044, 0.03];
const BRICK_BROWN: Vec3 = [0.16, 0.068, 0.04];
const BRICK_OCHRE: Vec3 = [0.22, 0.1, 0.05];
const BRICK_SOOT: Vec3 = [0.09, 0.036, 0.026];
const SLATE: Vec3 = [0.045, 0.045, 0.052];
const TAR: Vec3 = [0.035, 0.033, 0.033];
const STEEL_RUST: Vec3 = [0.14, 0.07, 0.04];
const STEEL_DARK: Vec3 = [0.06, 0.058, 0.055];
const STEEL_GREY: Vec3 = [0.16, 0.16, 0.165];
const BALLAST: Vec3 = [0.095, 0.085, 0.075];
const YARD_GROUND: Vec3 = [0.06, 0.055, 0.05];
/** North-light roof glazing (KIND.WINDOWS: a grid of panes, some lit from inside). */
const GLAZING: Vec3 = [0.06, 0.064, 0.07];
const SODIUM_LAMP: Vec3 = [16, 9.5, 4.2];
const WALL_LAMP: Vec3 = [12, 7.2, 3.2];
const RED_LAMP: Vec3 = [9, 0.5, 0.25];
const GREEN_LAMP: Vec3 = [0.4, 7, 1.6];
const HEAD_LAMP: Vec3 = [20, 17, 12];
const SODIUM: Vec3 = [3.6, 2.0, 0.8];
/** The gantry's floods: dimmer than a yard mast (they hang low over the wagons). */
const FLOOD: Vec3 = [1.9, 1.08, 0.44];
const WALL_LIGHT: Vec3 = [0.6, 0.36, 0.15];
const WINDOW_SPILL: Vec3 = [0.22, 0.12, 0.05];

const WAGON_COLORS: readonly Vec3[] = [
  [0.22, 0.07, 0.04], // oxide red
  [0.16, 0.085, 0.05], // brown
  [0.05, 0.095, 0.06], // dark green
  [0.17, 0.17, 0.17], // grey
  [0.06, 0.095, 0.15], // faded blue
  [0.22, 0.13, 0.05], // ochre
  [0.2, 0.06, 0.08], // maroon
];
const COACH_COLORS: readonly Vec3[] = [
  [0.06, 0.11, 0.07], // bottle green
  [0.2, 0.06, 0.05], // crimson
  [0.07, 0.08, 0.14], // navy
];

const _up = new THREE.Vector3(0, 1, 0);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);

/** Shared state of one generator run. */
interface Ctx {
  readonly g: GeoBuilder;
  readonly R: () => number;
  readonly lamps: Lamp[];
}

/** Brick facade seed: the integer part is the style (0 plain, 1..4 storeys of windows), the fraction random. */
function brickSeed(c: Ctx, storeys: number): number {
  return storeys + c.R() * 0.999;
}

function pick<T>(R: () => number, list: readonly T[]): T {
  return list[Math.floor(R() * list.length) % list.length];
}

/** A matrix placing a local part at (x, y, z) turned by `yaw` about y. */
function place(x: number, y: number, z: number, yaw = 0): THREE.Matrix4 {
  _q.setFromAxisAngle(_up, yaw);
  return new THREE.Matrix4().compose(_p.set(x, y, z), _q, _s);
}

// ------------------------------------------------------------------------------------------ parts

/** Up-facing ground cells of a region that lie inside a disc of `radius` (plain gravel / asphalt). */
function groundCells(c: Ctx, radius: number, cell: number): void {
  for (let x = -radius; x < radius; x += cell) {
    for (let z = -radius; z < radius; z += cell) {
      const x1 = Math.min(x + cell, radius);
      const z1 = Math.min(z + cell, radius);
      const fx = Math.max(Math.abs(x), Math.abs(x1));
      const fz = Math.max(Math.abs(z), Math.abs(z1));
      if (Math.hypot(fx, fz) > radius) continue;
      c.g.quadUp(x, z, x1, z1, YARD, YARD_GROUND, KIND.RAILBED, c.R());
    }
  }
}

/** One track bed along local x (sleepers and rails drawn by the pattern), centred on (x, z), turned by `yaw`. */
function track(c: Ctx, x: number, z: number, length: number, yaw = 0): void {
  c.g.boxAt(x, YARD + 8, z, length / 2, 8, 190, BALLAST, KIND.RAILBED, c.R(), yaw);
}

/** Tracks along x at each z, from x0 to x1 (clipped to a disc of `radius` when given). */
function tracksAlongX(c: Ctx, x0: number, x1: number, zs: readonly number[], radius = Infinity): void {
  for (const z of zs) {
    const half = Math.sqrt(Math.max(radius * radius - (z + 200) * (z + 200), 0));
    const a = Math.max(x0, -half);
    const b = Math.min(x1, half);
    if (b - a > 400) track(c, (a + b) / 2, z, b - a);
  }
}

type WagonType = 'box' | 'tank' | 'gondola' | 'hopper' | 'coach' | 'loco';

/**
 * A rail vehicle of length `len` along local x centred at (x, z), its rails at height `y`: two
 * bogies, the underframe and the body by type. Returns nothing; locomotives and coaches add their
 * lamps (headlight, window spill) to the light map when `lit`.
 */
function wagon(c: Ctx, x: number, y: number, z: number, len: number, type: WagonType, rgb: Vec3, yaw = 0, lit = true): void {
  const { g, R } = c;
  const M = place(x, y, z, yaw);
  const at = (lx: number, ly: number, lz: number, hx: number, hy: number, hz: number, col: Vec3, kind: number, seed = R()): void => {
    g.box(new THREE.Matrix4().copy(M).multiply(_m.makeTranslation(lx, ly, lz)), hx, hy, hz, col, kind, seed);
  };
  const half = len / 2;
  for (const s of [-1, 1]) at(s * (half - 260), 52, 0, 140, 48, 112, STEEL_DARK, KIND.STEEL);
  at(0, 118, 0, half - 30, 20, 128, STEEL_DARK, KIND.STEEL);
  if (type === 'box') {
    at(0, 330, 0, half - 40, 192, 146, rgb, KIND.CONTAINER);
    at(0, 528, 0, half - 50, 8, 136, [rgb[0] * 0.6, rgb[1] * 0.6, rgb[2] * 0.6], KIND.STEEL);
  } else if (type === 'gondola') {
    at(0, 250, 0, half - 40, 112, 146, rgb, KIND.CONTAINER);
    at(0, 330, 0, half - 70, 30, 122, [0.03, 0.03, 0.03], KIND.STEEL);
  } else if (type === 'hopper') {
    at(0, 330, 0, half - 60, 170, 146, rgb, KIND.CONTAINER);
    for (const s of [-1, 1]) at(s * (half * 0.45), 175, 0, half * 0.22, 40, 110, rgb, KIND.STEEL);
  } else if (type === 'tank') {
    const tank = new THREE.CylinderGeometry(150, 150, len - 140, 14, 1, false).rotateZ(Math.PI / 2);
    g.geometry(tank, new THREE.Matrix4().copy(M).multiply(_m.makeTranslation(0, 300, 0)), rgb, KIND.STEEL, R());
    tank.dispose();
    at(0, 462, 0, 70, 22, 70, rgb, KIND.STEEL);
    at(0, 150, 0, half - 60, 8, 150, STEEL_DARK, KIND.STEEL);
  } else if (type === 'coach') {
    at(0, 330, 0, half - 30, 185, 140, rgb, KIND.WINDOWS);
    at(0, 532, 0, half - 40, 18, 122, [0.05, 0.05, 0.055], KIND.STEEL);
    if (lit) c.lamps.push({ pos: [x, y + 330, z + 380], range: 900, color: WINDOW_SPILL, down: 0 });
  } else {
    // a diesel hood unit: long hood, cab with lit windows at one end, headlight, red markers
    at(-120, 300, 0, half - 220, 165, 118, rgb, KIND.STEEL);
    at(half - 300, 380, 0, 180, 240, 140, rgb, KIND.WINDOWS);
    at(half - 300, 628, 0, 190, 10, 146, STEEL_DARK, KIND.STEEL);
    at(half - 110, 470, 0, 8, 26, 26, HEAD_LAMP, KIND.LAMP);
    for (const s of [-1, 1]) at(-half + 22, 200, s * 95, 6, 14, 14, RED_LAMP, KIND.LAMP);
    if (lit) c.lamps.push({ pos: [x + Math.cos(yaw) * (half + 400), y + 300, z - Math.sin(yaw) * (half + 400)], range: 1000, color: [1.6, 1.4, 1.1], down: 0 });
  }
}

/** A train along x from x0 (rear) toward +x on rails at height y, track z; returns the x after it. */
function train(c: Ctx, x0: number, y: number, z: number, types: readonly WagonType[], palette: readonly Vec3[], lit = true): number {
  let x = x0;
  for (const t of types) {
    const len = t === 'coach' ? 1750 : t === 'loco' ? 1700 : t === 'tank' ? 1250 : t === 'gondola' ? 1150 : 1400;
    wagon(c, x + len / 2, y, z, len, t, t === 'loco' ? [0.32, 0.1, 0.04] : pick(c.R, palette), 0, lit);
    x += len + 70;
  }
  return x;
}

/** A random freight consist of `n` wagons. */
function freight(R: () => number, n: number): WagonType[] {
  const out: WagonType[] = [];
  for (let i = 0; i < n; i++) {
    const r = R();
    out.push(r < 0.45 ? 'box' : r < 0.65 ? 'tank' : r < 0.85 ? 'gondola' : 'hopper');
  }
  return out;
}

/**
 * A brick hall: walls from the ground to `h` (arched windows on `storeys` floors, 0 = plain), a
 * roof ('gable' along the long axis, 'saw' north-light teeth whose glazing faces -z, 'flat' with a
 * parapet) and wall lamps over the doors. Axis-aligned, centred on (cx, cz), half sizes hx, hz.
 * `spill` adds the lit windows' glow on the ground in front of each face to the light map.
 */
function hall(c: Ctx, cx: number, cz: number, hx: number, hz: number, h: number, storeys: number, rgb: Vec3, roof: 'gable' | 'saw' | 'flat', spill = true): void {
  const { g, R } = c;
  g.boxAt(cx, YARD + h / 2, cz, hx, h / 2, hz, rgb, KIND.BRICK, brickSeed(c, storeys));
  const top = YARD + h;
  const along = hx >= hz; // ridge / teeth along x
  if (roof === 'gable') {
    const span = along ? hz : hx;
    const rise = Math.min(span * 0.55, 900);
    const slope = Math.hypot(span, rise) + 40;
    const th = Math.atan2(rise, span);
    for (const s of [-1, 1]) {
      if (along) {
        const zc = cz + (s * span) / 2;
        g.slab([cx - hx - 40, top + rise / 2, zc], [cx + hx + 40, top + rise / 2, zc], slope, 34, SLATE, KIND.STEEL, R(), [0, Math.cos(th), s * Math.sin(th)]);
      } else {
        const xc = cx + (s * span) / 2;
        g.slab([xc, top + rise / 2, cz - hz - 40], [xc, top + rise / 2, cz + hz + 40], slope, 34, SLATE, KIND.STEEL, R(), [s * Math.sin(th), Math.cos(th), 0]);
      }
    }
    // gable ends: brick triangles
    const tri = new THREE.Shape();
    tri.moveTo(-span, 0);
    tri.lineTo(span, 0);
    tri.lineTo(0, rise);
    tri.lineTo(-span, 0);
    const geo = new THREE.ExtrudeGeometry(tri, { depth: 40, bevelEnabled: false });
    geo.deleteAttribute('uv');
    for (const s of [-1, 1]) {
      if (along) g.geometry(geo, place(cx + s * (hx - 20) - 20, top, cz, Math.PI / 2), rgb, KIND.BRICK, brickSeed(c, 0));
      else g.geometry(geo, place(cx, top, cz + s * (hz - 20) - 20), rgb, KIND.BRICK, brickSeed(c, 0));
    }
    geo.dispose();
  } else if (roof === 'saw') {
    // teeth across z (each a sloped roof rising toward -z and a glazed face toward -z)
    const tw = 900;
    const th = 620;
    const n = Math.max(1, Math.floor((2 * hz) / tw));
    const w = (2 * hz) / n;
    for (let i = 0; i < n; i++) {
      const z0 = cz - hz + i * w;
      const slope = Math.hypot(w, th);
      const ang = Math.atan2(th, w);
      g.slab([cx - hx, top + th / 2, z0 + w / 2], [cx + hx, top + th / 2, z0 + w / 2], slope, 30, SLATE, KIND.STEEL, R(), [0, Math.cos(ang), Math.sin(ang)]);
      g.boxAt(cx, top + th / 2, z0 + 12, hx - 30, th / 2 - 20, 10, GLAZING, KIND.WINDOWS, R());
    }
    g.boxAt(cx, top + 30, cz, hx + 30, 30, hz + 30, BRICK_SOOT, KIND.BRICK, brickSeed(c, 0));
  } else {
    // parapet, a roof tank on legs, vents
    g.boxAt(cx, top + 45, cz, hx + 25, 45, hz + 25, [rgb[0] * 1.15, rgb[1] * 1.15, rgb[2] * 1.15], KIND.BRICK, brickSeed(c, 0));
    g.boxAt(cx, top + 92, cz, hx - 10, 4, hz - 10, TAR, KIND.STEEL, R());
    const tx = cx + (R() - 0.5) * hx;
    const tz = cz + (R() - 0.5) * hz;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.beam([tx + sx * 160, top, tz + sz * 160], [tx + sx * 160, top + 420, tz + sz * 160], 22, STEEL_DARK, KIND.STEEL, R());
    const tank = new THREE.CylinderGeometry(230, 230, 380, 12);
    g.geometry(tank, place(tx, top + 610, tz), STEEL_RUST, KIND.STEEL, R());
    tank.dispose();
  }
  // wall lamps over the doors on the two long faces, and the windows' glow on the ground
  const faces: readonly (readonly [number, number, number, number, number])[] = along
    ? [
        [cx, cz - hz, hx, 0, -1],
        [cx, cz + hz, hx, 0, 1],
      ]
    : [
        [cx - hx, cz, hz, -1, 0],
        [cx + hx, cz, hz, 1, 0],
      ];
  for (const [fx, fz, len, nx, nz] of faces) {
    const n = Math.max(1, Math.round((2 * len) / 2600));
    for (let i = 0; i < n; i++) {
      const t = ((i + 0.5) / n - 0.5) * 2 * len;
      const lx = fx + (nz !== 0 ? t : 0) + nx * 30;
      const lz = fz + (nx !== 0 ? t : 0) + nz * 30;
      g.boxAt(lx, YARD + 520, lz, nz !== 0 ? 40 : 14, 14, nx !== 0 ? 40 : 14, WALL_LAMP, KIND.LAMP, R());
      c.lamps.push({ pos: [lx + nx * 120, YARD + 480, lz + nz * 120], range: 800, color: WALL_LIGHT, down: 1 });
      if (spill && storeys > 0) c.lamps.push({ pos: [lx + nx * 420, YARD + Math.min(h * 0.5, 1400), lz + nz * 420], range: 1300, color: WINDOW_SPILL, down: 0 });
    }
  }
}

/**
 * A round brick chimney: square plinth, tapered shaft with soot bands (the plain brick pattern), an
 * iron cap and a red aviation lamp. `top` is the world height of the rim.
 */
function chimney(c: Ctx, x: number, z: number, top: number, rBase: number, rTop: number, rgb: Vec3 = BRICK_BROWN): void {
  const { g, R } = c;
  const plinth = Math.min(900, top * 0.12);
  g.boxAt(x, YARD + plinth / 2, z, rBase + 160, plinth / 2, rBase + 160, rgb, KIND.BRICK, brickSeed(c, 0));
  g.boxAt(x, YARD + plinth + 30, z, rBase + 190, 30, rBase + 190, [rgb[0] * 1.2, rgb[1] * 1.2, rgb[2] * 1.2], KIND.BRICK, brickSeed(c, 0));
  const hs = top - YARD - plinth;
  const shaft = new THREE.CylinderGeometry(rTop, rBase, hs, 16, 1, true);
  g.geometry(shaft, place(x, YARD + plinth + hs / 2, z), rgb, KIND.BRICK, brickSeed(c, 0));
  shaft.dispose();
  const cap = new THREE.CylinderGeometry(rTop + 40, rTop + 30, 120, 16, 1, false);
  g.geometry(cap, place(x, top - 40, z), [0.035, 0.03, 0.03], KIND.STEEL, R());
  cap.dispose();
  g.boxAt(x, top + 60, z, 26, 26, 26, RED_LAMP, KIND.LAMP, R());
}

/**
 * A four-legged lattice tower from the ground to `h`, legs leaning from half-width `b0` at the
 * foot to `b1` at the top, X-braced on every face at `levels` levels.
 */
function latticeTower(c: Ctx, x: number, z: number, h: number, b0: number, b1: number, levels: number, rgb: Vec3, leg = 46, web = 20): void {
  const { g, R } = c;
  const P = (sx: number, sz: number, t: number): Vec3 => {
    const b = b0 + (b1 - b0) * t;
    return [x + sx * b, YARD + h * t, z + sz * b];
  };
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.beam(P(sx, sz, 0), P(sx, sz, 1), leg, rgb, KIND.STEEL, R());
  const corners: readonly (readonly [number, number])[] = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  for (let i = 0; i < levels; i++) {
    const t0 = i / levels;
    const t1 = (i + 1) / levels;
    for (let k = 0; k < 4; k++) {
      const [ax, az] = corners[k];
      const [bx, bz] = corners[(k + 1) % 4];
      g.beam(P(ax, az, t1), P(bx, bz, t1), web * 1.3, rgb, KIND.STEEL, R());
      g.beam(P(ax, az, t0), P(bx, bz, t1), web, rgb, KIND.STEEL, R());
      g.beam(P(bx, bz, t0), P(ax, az, t1), web, rgb, KIND.STEEL, R());
    }
  }
}

/**
 * A Warren truss girder between world points a and b (bottom chord) with depth `d` upward, `n`
 * panels, verticals at every node: chords `chord` wide, web members `web` wide.
 */
function trussGirder(c: Ctx, a: Vec3, b: Vec3, d: number, n: number, chord: number, web: number, rgb: Vec3): void {
  const { g, R } = c;
  const at = (t: number, up: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t + up, a[2] + (b[2] - a[2]) * t];
  g.beam(at(0, 0), at(1, 0), chord, rgb, KIND.STEEL, R());
  g.beam(at(0, d), at(1, d), chord, rgb, KIND.STEEL, R());
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    g.beam(at(t, 0), at(t, d), web, rgb, KIND.STEEL, R());
    if (i < n) {
      const t2 = (i + 1) / n;
      if (i % 2 === 0) g.beam(at(t, 0), at(t2, d), web, rgb, KIND.STEEL, R());
      else g.beam(at(t, d), at(t2, 0), web, rgb, KIND.STEEL, R());
    }
  }
}

/**
 * The lattice gantry spanning the far end: two Warren girders on lattice towers, cross-braced, a
 * walkway, a row of sodium floods under it (light map) and a red lamp on each tower.
 */
function gantry(c: Ctx, x0: number, x1: number, z: number, yBot: number, yTop: number, towerX: number): void {
  const { g, R } = c;
  const dz = 300;
  const d = yTop - yBot;
  const n = Math.max(4, Math.round((x1 - x0) / 600));
  for (const s of [-1, 1]) trussGirder(c, [x0, yBot, z + s * dz], [x1, yBot, z + s * dz], d, n, 110, 44, STEEL_RUST);
  for (let i = 0; i <= n; i += 2) {
    const x = x0 + ((x1 - x0) * i) / n;
    g.beam([x, yBot, z - dz], [x, yBot, z + dz], 34, STEEL_RUST, KIND.STEEL, R());
    g.beam([x, yTop, z - dz], [x, yTop, z + dz], 30, STEEL_RUST, KIND.STEEL, R());
    if (i < n) {
      const x2 = x0 + ((x1 - x0) * (i + 2)) / n;
      g.beam([x, yTop, z - dz], [x2, yTop, z + dz], 20, STEEL_RUST, KIND.STEEL, R());
      g.beam([x, yBot, z + dz], [x2, yBot, z - dz], 20, STEEL_RUST, KIND.STEEL, R());
    }
  }
  g.boxAt((x0 + x1) / 2, yBot + 12, z, (x1 - x0) / 2, 10, dz - 40, STEEL_DARK, KIND.STEEL, R());
  for (const sx of [-1, 1]) {
    latticeTower(c, sx * towerX, z, yTop + 260, 420, 300, 6, STEEL_RUST, 56, 22);
    g.boxAt(sx * towerX, YARD + yTop + 300, z, 32, 32, 32, RED_LAMP, KIND.LAMP, R());
  }
  // floods under the deck, aimed at the tracks
  for (let i = 0; i < 5; i++) {
    const x = x0 + ((x1 - x0) * (i + 0.5)) / 5;
    g.boxAt(x, yBot - 40, z - dz + 20, 110, 16, 50, SODIUM_LAMP, KIND.LAMP, R());
    c.lamps.push({ pos: [x, yBot - 160, z - dz], range: 2200, color: FLOOD, down: 1 });
  }
}

/**
 * A brick viaduct along x from x0 to x1 at axis z: a wall of semicircular arches (real openings)
 * with a ballast deck and a parapet on top, `deck` the height of the deck top.
 */
function viaduct(c: Ctx, x0: number, x1: number, z: number, deck: number, span = 1150, pier = 260): void {
  const { g, R } = c;
  const width = 520;
  const n = Math.floor((x1 - x0 - pier) / (span + pier));
  const len = n * (span + pier) + pier;
  const shape = new THREE.Shape();
  const top = deck - YARD - 110;
  shape.moveTo(0, 0);
  shape.lineTo(len, 0);
  shape.lineTo(len, top);
  shape.lineTo(0, top);
  shape.lineTo(0, 0);
  const r = span / 2;
  const spring = Math.min(top - r - 120, top * 0.55);
  for (let i = 0; i < n; i++) {
    const a = pier + i * (span + pier);
    const hole = new THREE.Path();
    hole.moveTo(a, 0);
    hole.lineTo(a, spring);
    hole.absarc(a + r, spring, r, Math.PI, 0, true);
    hole.lineTo(a + span, 0);
    hole.lineTo(a, 0);
    shape.holes.push(hole);
  }
  const geo = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false, curveSegments: 7 });
  geo.deleteAttribute('uv');
  const x = x0 + (x1 - x0 - len) / 2;
  g.geometry(geo, new THREE.Matrix4().makeTranslation(x, YARD, z - width / 2), BRICK_DARK, KIND.BRICK, brickSeed(c, 0));
  geo.dispose();
  // deck, parapets (string course) and the track bed on top
  g.boxAt(x + len / 2, deck - 55, z, len / 2 + 20, 55, width / 2 + 30, [0.24, 0.1, 0.06], KIND.BRICK, brickSeed(c, 0));
  for (const s of [-1, 1]) g.boxAt(x + len / 2, deck + 50, z + s * (width / 2 + 10), len / 2, 50, 20, BRICK_DARK, KIND.BRICK, brickSeed(c, 0));
  g.boxAt(x + len / 2, deck + 6, z, len / 2, 6, 190, BALLAST, KIND.RAILBED, R());
  // lamp posts on the parapet every few arches
  for (let i = 1; i < n; i += 4) {
    const lx = x + pier / 2 + i * (span + pier);
    g.boxAt(lx, deck + 360, z - width / 2 - 10, 10, 260, 10, STEEL_DARK, KIND.STEEL, R());
    g.boxAt(lx, deck + 630, z - width / 2 - 10, 34, 12, 22, WALL_LAMP, KIND.LAMP, R());
    c.lamps.push({ pos: [lx, deck + 560, z - width / 2 - 120], range: 900, color: WALL_LIGHT, down: 1 });
  }
}

/** A steel water tower: a lattice stand and a riveted tank with a conical roof. */
function waterTower(c: Ctx, x: number, z: number, h: number): void {
  const { g, R } = c;
  latticeTower(c, x, z, h, 340, 300, 4, STEEL_DARK, 50, 20);
  const tank = new THREE.CylinderGeometry(460, 460, 620, 18);
  g.geometry(tank, place(x, YARD + h + 310, z), STEEL_RUST, KIND.STEEL, R());
  tank.dispose();
  const roof = new THREE.ConeGeometry(500, 260, 18);
  g.geometry(roof, place(x, YARD + h + 750, z), [0.05, 0.05, 0.05], KIND.STEEL, R());
  roof.dispose();
  g.boxAt(x, YARD + h + 910, z, 22, 22, 22, RED_LAMP, KIND.LAMP, R());
}

/** A gasholder frame: a ring of lattice columns with girder rings, and the tank inside at `fill`. */
function gasholder(c: Ctx, x: number, z: number, r: number, h: number, fill: number): void {
  const { g, R } = c;
  const cols = 16;
  for (let i = 0; i < cols; i++) {
    const a = (i / cols) * Math.PI * 2;
    const px = x + Math.cos(a) * r;
    const pz = z + Math.sin(a) * r;
    g.beam([px, YARD, pz], [px, YARD + h, pz], 90, STEEL_DARK, KIND.STEEL, R());
    for (const y of [h * 0.33, h * 0.66, h]) {
      const a2 = ((i + 1) / cols) * Math.PI * 2;
      g.beam([px, YARD + y, pz], [x + Math.cos(a2) * r, YARD + y, z + Math.sin(a2) * r], 60, STEEL_DARK, KIND.STEEL, R());
    }
  }
  const bell = new THREE.CylinderGeometry(r * 0.92, r * 0.92, h * fill, 24);
  g.geometry(bell, place(x, YARD + (h * fill) / 2, z), [0.1, 0.11, 0.1], KIND.STEEL, R());
  bell.dispose();
}

/** A yard light mast with four sodium heads; one lamp in the light map. */
function mast(c: Ctx, x: number, z: number, h = 3000): void {
  const { g, R } = c;
  g.boxAt(x, YARD + h / 2, z, 28, h / 2, 28, STEEL_GREY, KIND.STEEL, R());
  g.boxAt(x, YARD + h + 26, z, 250, 24, 100, [0.14, 0.14, 0.14], KIND.STEEL, R());
  for (let i = 0; i < 4; i++) g.boxAt(x - 180 + i * 120, YARD + h - 6, z, 46, 16, 64, SODIUM_LAMP, KIND.LAMP, R());
  c.lamps.push({ pos: [x, YARD + h - 120, z], range: 2600, color: SODIUM, down: 1 });
}

/** A signal gantry across tracks along x: two posts at z0 / z1 and a girder with signal heads. */
function signalGantry(c: Ctx, x: number, z0: number, z1: number, h: number): void {
  const { g, R } = c;
  for (const z of [z0, z1]) g.beam([x, YARD, z], [x, YARD + h, z], 50, STEEL_GREY, KIND.STEEL, R());
  trussGirder(c, [x, YARD + h - 160, z0], [x, YARD + h - 160, z1], 160, Math.max(2, Math.round((z1 - z0) / 300)), 30, 14, STEEL_GREY);
  for (let z = z0 + 300; z < z1 - 100; z += 450) {
    g.boxAt(x - 60, YARD + h - 330, z, 30, 120, 40, [0.02, 0.02, 0.02], KIND.STEEL, R());
    g.boxAt(x - 92, YARD + h - 300, z, 4, 16, 16, R() < 0.6 ? RED_LAMP : GREEN_LAMP, KIND.LAMP, R());
  }
}

/** Big arched doors (lit from inside) on a wall facing `nz` (+1 / -1) at z, centred at x. */
function shedDoors(c: Ctx, x0: number, x1: number, z: number, nz: number, n: number, dh: number): void {
  const { g, R } = c;
  const pitch = (x1 - x0) / n;
  const w = pitch * 0.62;
  const shape = new THREE.Shape();
  const r = w / 2;
  shape.moveTo(-r, 0);
  shape.lineTo(r, 0);
  shape.lineTo(r, dh - r);
  shape.absarc(0, dh - r, r, 0, Math.PI, false);
  shape.lineTo(-r, 0);
  const geo = new THREE.ShapeGeometry(shape, 8);
  geo.deleteAttribute('uv');
  if (nz < 0) geo.rotateY(Math.PI);
  for (let i = 0; i < n; i++) {
    const x = x0 + (i + 0.5) * pitch;
    const k = 0.55 + 0.45 * R();
    g.geometry(geo, place(x, YARD, z + nz * 4), [0.46 * k, 0.25 * k, 0.095 * k], KIND.LAMP, R());
    // glazing bars: three uprights and four transoms (dark steel just in front of the light)
    for (const t of [-0.5, 0, 0.5]) g.boxAt(x + t * r, YARD + (dh - r * (1 - Math.sqrt(1 - t * t))) / 2, z + nz * 10, 9, (dh - r * (1 - Math.sqrt(1 - t * t))) / 2, 5, STEEL_DARK, KIND.STEEL, R());
    for (let j = 1; j <= 4; j++) {
      const y = (dh - r) * (j / 4.6);
      g.boxAt(x, YARD + y, z + nz * 10, r, 8, 5, STEEL_DARK, KIND.STEEL, R());
    }
    g.boxAt(x, YARD + dh * 0.62, z + nz * 30, 36, 14, 14, WALL_LAMP, KIND.LAMP, R());
    c.lamps.push({ pos: [x, YARD + dh * 0.4, z + nz * 500], range: 1200, color: [0.45, 0.26, 0.11], down: 0 });
  }
  geo.dispose();
}

/** Distant city blocks (KIND.FARCITY: lit window grids), every top under SKYLINE_TOP. */
function city(c: Ctx, x0: number, x1: number, z0: number, z1: number, count: number, hMin: number, hMax: number, tall: number): void {
  const { g, R } = c;
  for (let i = 0; i < count; i++) {
    const x = x0 + (x1 - x0) * R();
    const z = z0 + (z1 - z0) * R();
    const w = 700 + 1700 * R();
    const d = 700 + 1700 * R();
    const cap = SKYLINE_TOP - 80;
    let h = hMin + (hMax - hMin) * Math.pow(R(), 2);
    if (R() < tall) h *= 2;
    h = Math.min(h, cap - YARD - 200);
    const k = 0.7 + 0.5 * R();
    const tone: Vec3 = [0.05 * k, 0.045 * k, 0.05 * k];
    const yaw = R() * 0.5;
    g.boxAt(x, YARD + h / 2, z, w, h / 2, d, tone, KIND.FARCITY, R(), yaw);
    let top = YARD + h;
    if (h > 3500 && R() < 0.45) {
      const h2 = Math.min(h * (0.12 + 0.2 * R()), cap - top - 100);
      if (h2 > 120) {
        g.boxAt(x, top + h2 / 2, z, w * 0.6, h2 / 2, d * 0.6, tone, KIND.FARCITY, R(), yaw);
        top += h2;
      }
    }
    if (top > 6500) {
      const spire = Math.min(500, cap - top);
      if (spire > 60) g.beam([x, top, z], [x, top + spire, z], 40, [0.08, 0.08, 0.08], KIND.STEEL, R());
      g.boxAt(x, top + Math.max(spire, 0) + 20, z, 28, 28, 28, RED_LAMP, KIND.LAMP, R());
    }
  }
}

// ------------------------------------------------------------------------------------- generators

export interface RailyardLive {
  /** The merged live mesh geometry. */
  readonly geometry: THREE.BufferGeometry;
  /** The lamps of the live parts (part of the light map). */
  readonly lamps: Lamp[];
  readonly stats: { readonly parts: number; readonly verts: number; readonly triangles: number };
}

/** The live (per-frame) part of the railyard: see the file header. */
export function buildRailyardLive(seed = 5): RailyardLive {
  const g = new GeoBuilder(false, 60000);
  const c: Ctx = { g, R: rng(seed), lamps: [] };
  const R = LIVE_RADIUS - 400;

  // ---- yard ground round the stadium (the apron covers the footprint itself)
  groundCells(c, R, 2500);

  // ---- far end (+z): ground tracks and freight, the gantry, the halls, chimney and water tower
  tracksAlongX(c, -R, R, [8000, 8450, 8900, 11250, 11700, 12150, 12600], R);
  train(c, -9600, YARD + 16, 8450, freight(c.R, 13), WAGON_COLORS);
  train(c, -12500, YARD + 16, 11700, ['loco', ...freight(c.R, 15)], WAGON_COLORS);
  train(c, 600, YARD + 16, 12600, freight(c.R, 6), WAGON_COLORS);
  gantry(c, -GANTRY_TOWER_X - 500, GANTRY_TOWER_X + 500, GANTRY_Z, GANTRY_BOTTOM, GANTRY_TOP, GANTRY_TOWER_X);
  // right: the depot (three storeys of arched windows, slate gable) and its annexe
  hall(c, -11400, 10500, 4300, 2350, 2900, 3, BRICK_RED, 'gable');
  hall(c, -17600, 9300, 1800, 1500, 2100, 2, BRICK_BROWN, 'flat');
  // left: the workshops (one tall storey of arched windows, sawtooth roof) and an office block
  hall(c, 10900, 10300, 3700, 2200, 2500, 1, BRICK_OCHRE, 'saw');
  hall(c, 16300, 9600, 1500, 1600, 3300, 4, BRICK_RED, 'flat');
  chimney(c, CHIMNEY_AT[0], CHIMNEY_AT[1], CHIMNEY_TOP, 430, 250);
  waterTower(c, 4800, 13050, 2300);
  mast(c, 2600, 9300);
  mast(c, -2300, 12900, 3300);
  mast(c, 8200, 13300);
  mast(c, -8200, 13300);

  // ---- the brick viaduct and its lit passenger train
  const vx = Math.sqrt(R * R - (VIADUCT_Z + 300) * (VIADUCT_Z + 300)) - 200;
  viaduct(c, -vx, vx, VIADUCT_Z, VIADUCT_DECK);
  train(c, -10800, VIADUCT_DECK + 12, VIADUCT_Z, ['coach', 'coach', 'coach', 'coach', 'coach', 'coach', 'loco'], COACH_COLORS);
  // the far side of the viaduct: low sheds and a coal stage
  hall(c, -7000, 17600, 2600, 1300, 1500, 1, BRICK_DARK, 'gable');
  hall(c, 6500, 17800, 3200, 1400, 1700, 2, BRICK_BROWN, 'flat');

  // ---- near end (-z): the engine shed with its lit doors, tracks into it, chimney, water tower
  tracksAlongX(c, -R, R, [-8000, -8450], R);
  for (const x of [-5400, -2700, 0, 2700, 5400]) track(c, x, -10050, 3600, Math.PI / 2);
  hall(c, 0, -13600, 7600, 2600, 2900, 0, BRICK_RED, 'gable', false);
  shedDoors(c, -7600, 7600, -11000, 1, 5, 1900);
  // a clerestory of arched windows over the doors (a thin facade strip on the shed's front wall)
  c.g.boxAt(0, YARD + 2500, -11000 + 22, 7600, 400, 20, BRICK_RED, KIND.BRICK, brickSeed(c, 1));
  hall(c, 0, -17900, 6000, 1600, 2000, 2, BRICK_DARK, 'saw');
  train(c, -11500, YARD + 16, -8450, freight(c.R, 12), WAGON_COLORS);
  wagon(c, 2700, YARD + 16, -9300, 1700, 'loco', [0.06, 0.1, 0.07], Math.PI / 2);
  wagon(c, -2700, YARD + 16, -9100, 1400, 'box', WAGON_COLORS[0], Math.PI / 2);
  chimney(c, 9800, -14200, 5600, 280, 170, BRICK_RED);
  waterTower(c, -9600, -10200, 2000);
  signalGantry(c, -12800, -8900, -7700, 1300);
  mast(c, -6000, -9200);
  mast(c, 6000, -9200);

  // ---- sides: warehouses behind the stands, tracks and wagons beyond them
  for (const s of [-1, 1]) {
    hall(c, s * 10400, -3300, 1300, 3000, 3700, 4, s < 0 ? BRICK_RED : BRICK_BROWN, 'flat');
    hall(c, s * 10400, 3600, 1300, 3200, 3300, 3, s < 0 ? BRICK_BROWN : BRICK_RED, 'gable');
    for (const x of [13000, 13450, 13900]) track(c, s * x, 0, 2 * Math.sqrt(R * R - x * x) - 1200, Math.PI / 2);
    for (let i = 0; i < 9; i++) {
      const t = (i - 4) * 1500 + (c.R() - 0.5) * 300;
      wagon(c, s * 13450, YARD + 16, t, 1400, c.R() < 0.6 ? 'box' : 'tank', pick(c.R, WAGON_COLORS), Math.PI / 2);
    }
    mast(c, s * 12500, -7000);
    mast(c, s * 12500, 7000);
  }

  const geometry = g.build(new THREE.Sphere(new THREE.Vector3(), LIVE_RADIUS)) as THREE.BufferGeometry;
  const triangles = (geometry.index as THREE.BufferAttribute).count / 3;
  return { geometry, lamps: c.lamps, stats: { parts: g.parts, verts: g.verts, triangles } };
}

export interface RailyardFar {
  /** The merged bake geometry (null for a dry run). */
  readonly geometry: THREE.BufferGeometry | null;
  readonly lamps: Lamp[];
  readonly stats: { readonly parts: number; readonly verts: number };
}

/**
 * The baked (far) part of the railyard; `dry` only collects the lamps. Everything stands outside a
 * ring of FAR_INNER round the origin (the live layer covers the inside) except the ground.
 */
export function buildRailyardFar(dry = false, seed = 13): RailyardFar {
  const g = new GeoBuilder(dry, 160000);
  const c: Ctx = { g, R: rng(seed), lamps: [] };
  const { R } = c;
  const FAR_INNER = 19000;
  const outside = (x: number, z: number, r: number): boolean => Math.hypot(x, z) - r > FAR_INNER;

  // ---- the plain (the live ground covers the part round the stadium)
  g.boxAt(0, (YARD - 600) / 2, 0, 170000, (YARD + 600) / 2, 170000, YARD_GROUND, KIND.RAILBED, R());

  // ---- track fields: along x beyond both ends, along z beyond both sides
  for (const z of [20500, 20950, 21400, 21850, 22300, -20500, -20950, -21400, -21850]) track(c, 0, z, 120000);
  for (const x of [20500, 20950, 21400, -20500, -20950, -21400, -21850]) track(c, x, 0, 120000, Math.PI / 2);
  for (const z of [20950, 21850, -20950, -21850]) {
    let x = -40000 + R() * 8000;
    while (x < 40000) {
      const n = 6 + Math.floor(R() * 10);
      x = train(c, x, YARD + 16, z, freight(R, n), WAGON_COLORS, false) + 1500 + R() * 6000;
    }
  }
  for (const x of [20950, -20950, -21850]) {
    for (let z = -36000 + R() * 6000; z < 36000; z += 1500 + R() * 400) {
      if (R() < 0.75) wagon(c, x, YARD + 16, z, 1400, R() < 0.6 ? 'box' : 'tank', pick(R, WAGON_COLORS), Math.PI / 2, false);
    }
  }

  // ---- factory halls in a ring round the yard
  const styles: readonly ('gable' | 'saw' | 'flat')[] = ['gable', 'saw', 'flat', 'gable'];
  const bricks: readonly Vec3[] = [BRICK_RED, BRICK_DARK, BRICK_BROWN, BRICK_OCHRE, BRICK_RED];
  let placed = 0;
  for (let tries = 0; placed < 70 && tries < 400; tries++) {
    const a = R() * Math.PI * 2;
    const r = 24000 + Math.pow(R(), 1.4) * 36000;
    const x = Math.sin(a) * r;
    const z = Math.cos(a) * r;
    const hx = 1200 + R() * 3200;
    const hz = 1000 + R() * 2200;
    if (!outside(x, z, Math.hypot(hx, hz))) continue;
    // keep the track fields clear
    if (Math.abs(z) - hz < 23000 && Math.abs(z) + hz > 19800 && Math.abs(x) < 60000) continue;
    if (Math.abs(x) - hx < 22500 && Math.abs(x) + hx > 19800 && Math.abs(z) < 60000) continue;
    const storeys = 1 + Math.floor(R() * 4);
    const h = Math.min(800 + storeys * (550 + R() * 350), 4200);
    hall(c, x, z, hx, hz, h, storeys, pick(R, bricks), pick(R, styles), false);
    placed++;
  }

  // ---- chimneys, gasholders, water towers, masts
  const chimneys: readonly (readonly [number, number, number])[] = [
    [14000, 30000, 7800],
    [-26000, 24000, 6400],
    [33000, -9000, 7200],
    [-30000, -26000, 8200],
    [9000, -34000, 6000],
    [-12000, 41000, 9000],
  ];
  for (const [x, z, h] of chimneys) chimney(c, x, z, h, 300 + h * 0.03, 170 + h * 0.012, pick(R, bricks));
  gasholder(c, -27500, 33000, 2600, 4200, 0.7);
  gasholder(c, -33500, 29000, 2300, 3900, 0.45);
  gasholder(c, 36000, 21000, 2400, 4000, 0.6);
  waterTower(c, 25500, -24000, 2600);
  waterTower(c, -24000, -12000, 2400);
  for (const [x, z] of [
    [-14000, 21700],
    [6000, 21700],
    [24000, 21700],
    [-8000, -21500],
    [14000, -21500],
    [21000, 8000],
    [-21000, -9000],
    [21000, -14000],
  ] as const) {
    mast(c, x, z, 3200);
  }

  // ---- the city: a tall cluster on the horizon behind the far goal, lower districts round it
  city(c, -16000, 16000, 42000, 62000, 46, 3500, 8000, 0.25);
  city(c, -60000, 60000, 48000, 100000, 240, 1500, 5000, 0.12);
  city(c, -95000, -50000, -20000, 60000, 120, 1000, 3800, 0.06);
  city(c, 50000, 95000, -30000, 50000, 120, 1000, 3800, 0.06);
  city(c, -50000, 50000, -95000, -55000, 160, 1200, 4200, 0.08);

  return { geometry: g.build(new THREE.Sphere(new THREE.Vector3(), 170000)), lamps: c.lamps, stats: { parts: g.parts, verts: g.verts } };
}

/** Exposed for tests: no tall live part inside this box (the stadium). */
export const RAILYARD_CLEAR = { halfX: STADIUM_HALF_X, halfZ: STADIUM_HALF_Z } as const;
