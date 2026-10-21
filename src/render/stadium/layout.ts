/**
 * Where every part of the stadium stands: the cage's steel, the LED board band, the floodlight
 * towers and the stands. Pure numbers and small pure functions (no three.js), so the
 * tests check them in node against the sim's playable volume.
 *
 * Units and axes: uu (1 uu ~ 1 cm), three.js world space (x across the field, y up, z along it;
 * side walls at x = +-4400, goal lines at z = +-5600, ceiling at y = 2250). Everything here sits
 * ON the shell or OUTSIDE it: nothing enters the playable volume, so nothing suggests a collision
 * the sim does not have (the roof stays flat because the physics ceiling is flat).
 */
import { ARENA, GOAL_PROFILE } from '../../sim/constants';
import { HEAD_Y, TOWER_X, TOWER_Z } from '../theme';

/** The field's outline and profile (from ARENA, renamed to three's axes). */
export const FIELD = {
  halfX: ARENA.extentX,
  halfZ: ARENA.extentY,
  cornerR: ARENA.cornerRadius,
  /** Corner arc centres (+-cx, +-cz). */
  cx: ARENA.cornerCentreX,
  cz: ARENA.cornerCentreY,
  ceiling: ARENA.height,
  /** Wall -> ceiling arc radius, and the height where the vertical wall turns into it. */
  ceilR: ARENA.ceilingRadius,
  wallTop: ARENA.height - ARENA.ceilingRadius,
  sideRampR: ARENA.sideRampRadius,
  backRampR: ARENA.backRampRadius,
  goalHalfW: ARENA.goalHalfWidth,
  /** The flat back-wall panel built with each goal (|x| <= moduleHalfW, y <= moduleTop). */
  moduleHalfW: GOAL_PROFILE.moduleHalfWidth,
  moduleTop: GOAL_PROFILE.moduleTop,
} as const;

// ---- The LED board band (the shell below BOARD_SPLIT_Y: opaque, lit) -------------------------

/**
 * The shell is cut at this height: below it the opaque board band (ramp pad, LED boards, rail),
 * above it the transparent netting. The sim's shell has a ring of vertices at y = 360, so the cut
 * clips no triangle there.
 */
export const BOARD_SPLIT_Y = 360;
/**
 * The LED surface, in profile distance v (uu along the wall's cross-section, = height on the
 * vertical wall, arc length on the ramp): it starts down on the floor ramp and ends just above the
 * ramp top, so the boards stay under y ~ 340 and the backdrop shows over them.
 */
export const LED_LO = 112;
export const LED_HI = 328;
/** Dark frame inside the LED band, top and bottom (uu). */
export const LED_FRAME = 7;
/** The white LED rail on top of the boards (profile distance). */
export const RAIL_LO = 333;
export const RAIL_HI = 340;
/** Length of the field outline (the rounded rectangle at the foot of the walls). */
export const OUTLINE_LENGTH = 4 * (FIELD.cz + FIELD.cx) + 2 * Math.PI * FIELD.cornerR;
/**
 * The LED panels round the outline: PANEL_COUNT panels of PANEL_LEN uu, one card each. Panel k
 * spans outline distances [(k - 1/2) PANEL_LEN, (k + 1/2) PANEL_LEN) (mod the outline): 36 of
 * them put the middle of each side wall (a quarter and three quarters of the way round) on a
 * panel centre, so the big sponsor board there is exactly BIG_PANELS panels.
 */
export const PANEL_COUNT = 36;
export const PANEL_LEN = OUTLINE_LENGTH / PANEL_COUNT;
/** LED card aspect (width / height) the atlas is drawn at (~5.1). */
export const CARD_ASPECT = PANEL_LEN / (LED_HI - LED_LO - 2 * LED_FRAME);

/** The panel at outline distance `s` (0 .. PANEL_COUNT - 1). */
export function panelAt(s: number): number {
  return Math.floor(s / PANEL_LEN + 0.5) % PANEL_COUNT;
}

/**
 * The big sponsor board in the middle of each side wall: BIG_PANELS panels wide (~31 m, the
 * same height as the others), alternating between the place's main and secondary sponsor.
 * BIG_FIRST is its first panel on the -x side wall; the +x one starts half the outline later.
 */
export const BIG_PANELS = 3;
export const BIG_FIRST = panelAt(outlineDistance(-FIELD.halfX, 0)) - (BIG_PANELS - 1) / 2;

// ---- The cage: steel hugging the OUTSIDE of the netting --------------------------------------

/** Transverse arch tube radius and the distance of its centre line from the shell. */
export const ARCH_R = 19;
export const ARCH_OFF = ARCH_R + 6;
/** Transverse arches over the field (z of each), from side wall to side wall over the roof. */
export const ARCH_Z: readonly number[] = [-3900, -2600, -1300, 0, 1300, 2600, 3900];
/** Corner ribs (degrees on each corner arc, 0 = the side-wall end, 90 = the back-wall end). */
export const CORNER_RIB_DEG: readonly number[] = [30, 60, 90];
/** End-wall ribs (|x|): at the edges of the goal module. */
export const END_RIB_X: readonly number[] = [FIELD.moduleHalfW];
/** Horizontal rings round the cage: heights (1100 passes over the goal modules, top 1000). */
export const RING_Y: readonly number[] = [1100, FIELD.wallTop];
export const RING_R = 12;
/** Longitudinal roof beams (x of each), tube radius. */
export const ROOF_BEAM_X: readonly number[] = [-1900, 0, 1900];
export const ROOF_BEAM_R = 13;
/** The ring round the roof edge, on the ceiling at the top of the wall arcs (hides the net seam there). */
export const ROOF_RING_R = 15;

// ---- Floodlight towers (positions shared with every theme: theme.ts) -------------------------

export { HEAD_Y, TOWER_X, TOWER_Z };
/** Lamp panel size (uu) and its grid of round lamps. */
export const HEAD_W = 560;
export const HEAD_H = 330;
export const LAMP_COLS = 5;
export const LAMP_ROWS = 3;

/** One tower head: the panel centre, its aim point on the pitch and the panel's axes (unit vectors). */
export interface TowerHead {
  readonly base: readonly [number, number, number];
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  readonly dir: readonly [number, number, number];
  readonly right: readonly [number, number, number];
  readonly up: readonly [number, number, number];
}

/**
 * The eight tower heads (outside the side walls, above the cage roof), cross-aimed like
 * theme.ts's standard floodlights (same positions and targets, in the same order: -x side
 * first, then +x, each by TOWER_Z), so `themeWorld(t).floodlights[i]` drives head i.
 */
export function towerHeads(): TowerHead[] {
  const out: TowerHead[] = [];
  for (const sx of [-1, 1]) {
    for (const z of TOWER_Z) {
      const position: [number, number, number] = [sx * (TOWER_X - 240), HEAD_Y, z * 0.985];
      const target: [number, number, number] = [-sx * 1500, 0, z * 0.72];
      const dir = unit(target[0] - position[0], target[1] - position[1], target[2] - position[2]);
      // right = dir x up(0, 1, 0); up = right x dir
      const right = unit(-dir[2], 0, dir[0]);
      const up = unit(right[1] * dir[2] - right[2] * dir[1], right[2] * dir[0] - right[0] * dir[2], right[0] * dir[1] - right[1] * dir[0]);
      out.push({ base: [sx * TOWER_X, 0, z], position, target, dir, right, up });
    }
  }
  return out;
}

function unit(x: number, y: number, z: number): [number, number, number] {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}

// ---- Stands along both side walls (the ends behind the goals stay open for the backdrop) ------

export const STAND = {
  /** Front edge of the first row (|x|) and its tread height (a wall in front of it). */
  x0: 5150,
  y0: 380,
  rowDepth: 80,
  /** 35 degrees: steep, so the upper rows rise into view over the boards. */
  rowRise: 56,
  rows: 30,
  /** |z| extent: past the goal lines, so far views along the sides still hit seats. */
  halfLen: 6300,
  seatW: 58,
  /** Seats between two aisles, aisle width. */
  aisleEvery: 18,
  aisleW: 110,
  /** Canopy over the back rows: its height and the first row it covers. */
  roofY: 2700,
  roofRow: 13,
} as const;

export const standRowX = (r: number): number => STAND.x0 + r * STAND.rowDepth;
export const standRowY = (r: number): number => STAND.y0 + r * STAND.rowRise;

// ---- The shell's surface coordinates ------------------------------------------------------------

/**
 * Profile distance of a shell point: the distance along the wall's cross-section, equal to the
 * height on the vertical wall, the arc length on the wall-to-ceiling arc (above wallTop) and on the
 * floor ramp (below its top, negative near the floor), so a texture keeps its proportions where
 * the surface curves. `ny` is the vertical component of the surface normal (1 on the floor, 0 on
 * the wall). The ramp radius is found from the height and the slope (it eases between the side
 * and back values round each corner).
 */
export function profileDistance(y: number, ny: number): number {
  if (y >= FIELD.wallTop) return FIELD.wallTop + FIELD.ceilR * Math.asin(Math.min(1, (y - FIELD.wallTop) / FIELD.ceilR));
  if (y >= FIELD.sideRampR + 4) return y;
  // On a circular ramp of radius r: y = r (1 - cos th), th = 0 at the floor, pi/2 at the top.
  const th = Math.acos(Math.min(1, Math.max(0, Math.abs(ny))));
  let r: number = FIELD.sideRampR;
  if (th > 0.05) r = Math.min(FIELD.sideRampR + 20, Math.max(FIELD.backRampR - 40, y / Math.max(1e-3, 1 - Math.cos(th))));
  if (y >= r) return y;
  return r * (1 - Math.PI / 2 + th);
}

/**
 * Where a point stands round the outline: 'side' (the straight side walls, s = z), 'end' (the
 * straight back walls, s = x) or a 'corner' (the angle `a` from the side wall's end, 0..pi/2, and
 * the plan-view distance `r` from the corner's centre).
 */
export interface OutlinePos {
  readonly part: 'side' | 'end' | 'corner';
  readonly sx: number;
  readonly sz: number;
  readonly a: number;
  readonly r: number;
}

export function outlinePos(x: number, z: number): OutlinePos {
  const ax = Math.abs(x);
  const az = Math.abs(z);
  const sx = x < 0 ? -1 : 1;
  const sz = z < 0 ? -1 : 1;
  if (az <= FIELD.cz) return { part: 'side', sx, sz, a: 0, r: 0 };
  if (ax <= FIELD.cx) return { part: 'end', sx, sz, a: Math.PI / 2, r: 0 };
  const dx = ax - FIELD.cx;
  const dz = az - FIELD.cz;
  return { part: 'corner', sx, sz, a: Math.atan2(dz, dx), r: Math.hypot(dx, dz) };
}

/**
 * Distance along the outline (uu), continuous all the way round: 0 in the middle of the +z back
 * wall (behind the red goal, where the boards stop for the goal module), increasing to the right
 * of a viewer inside the arena (toward -x on the +z wall), so text drawn along it reads left to
 * right. Points inset from the outline (ramp, wall arc) map to the outline point they face.
 */
export function outlineDistance(x: number, z: number): number {
  const s = outlineWalk(x, z);
  return s <= 0 ? 0 : OUTLINE_LENGTH - s;
}

/** The outline walked the other way round (toward +x from the middle of the +z wall). */
function outlineWalk(x: number, z: number): number {
  const o = outlinePos(x, z);
  const q = (Math.PI / 2) * FIELD.cornerR; // one corner arc
  const sideLen = 2 * FIELD.cz;
  const endLen = 2 * FIELD.cx;
  // Quadrant walk: +z end (x from 0 to cx), corner (+x,+z), +x side (z from cz to -cz), corner
  // (+x,-z), -z end (x from cx to -cx), corner (-x,-z), -x side (z from -cz to cz), corner (-x,+z),
  // +z end (x from -cx to 0).
  if (o.part === 'end') {
    if (o.sz > 0) return x >= 0 ? x : OUTLINE_LENGTH + x;
    return FIELD.cx + q + sideLen + q + (FIELD.cx - x);
  }
  if (o.part === 'side') {
    if (o.sx > 0) return FIELD.cx + q + (FIELD.cz - z);
    return FIELD.cx + q + sideLen + q + endLen + q + (z + FIELD.cz);
  }
  // corners: the angle from the side wall's end (a) runs toward the back wall
  if (o.sx > 0 && o.sz > 0) return FIELD.cx + (Math.PI / 2 - o.a) * FIELD.cornerR;
  if (o.sx > 0 && o.sz < 0) return FIELD.cx + q + sideLen + o.a * FIELD.cornerR;
  if (o.sx < 0 && o.sz < 0) return FIELD.cx + q + sideLen + q + endLen + (Math.PI / 2 - o.a) * FIELD.cornerR;
  return FIELD.cx + q + sideLen + q + endLen + q + sideLen + o.a * FIELD.cornerR;
}

/** The corner netting panels (between ribs): edges in radians, from CORNER_RIB_DEG with 0 first. */
const CORNER_PANEL_EDGES: readonly number[] = [0, ...CORNER_RIB_DEG].map((d) => (d * Math.PI) / 180);

/**
 * Netting coordinate across the wall at a shell point (x, z) (uu): z on the side walls, x on the
 * back walls, and on a corner the arc length at the point's own radius from the middle of the
 * panel between two ribs (so the hex cells keep their size up the wall arc, where the corner's
 * radius shrinks by 600 uu). The coordinate jumps only at the arches and ribs, which hide the
 * seams.
 *
 * (refX, refZ) is the triangle's centroid: it picks the part (side, end or corner) and the corner
 * panel for all three corners of the triangle, so a triangle never mixes two coordinate systems.
 * (A corner triangle's vertices sit exactly on the arcs' ends, z = +-cz or x = +-cx, which on
 * their own classify as side or end: mixing z ~ 3900 with a panel coordinate ~ -220 in one
 * triangle squeezed the cells 18x into a wireless strip beside the arches and the end ribs.)
 */
export function netAcross(x: number, z: number, refX: number, refZ: number): number {
  const ref = outlinePos(refX, refZ);
  if (ref.part === 'side') return z;
  if (ref.part === 'end') return x;
  // The point round the reference's corner (its quadrant, whatever the point's own part).
  const dx = x * ref.sx - FIELD.cx;
  const dz = z * ref.sz - FIELD.cz;
  let k = 0;
  while (k + 2 < CORNER_PANEL_EDGES.length && ref.a > CORNER_PANEL_EDGES[k + 1]) k++;
  const mid = (CORNER_PANEL_EDGES[k] + CORNER_PANEL_EDGES[k + 1]) / 2;
  return (Math.atan2(dz, dx) - mid) * Math.hypot(dx, dz);
}
