/**
 * Our analytic arena -> indexed triangle meshes, in uu and sim coordinates (x side +-4400, y length
 * +-5600 with the goals reaching |y| = 6560, z up 0..2250; every number comes from ARENA /
 * GOAL_PROFILE in constants.ts).
 *
 * ONE generator feeds both RocketSim (collision mesh: `physics`) and the renderer (`shell`,
 * `goals`, `floor`, `ceiling`, `goalFrames`), so what is drawn is exactly what the ball bounces off.
 * No two surfaces meet at an angle: every junction is a tangent arc (tests/arena.test.mjs measures
 * the crease between every pair of neighbouring triangles).
 *
 * Construction:
 *  - Floor outline (top view): a rounded rectangle. Back walls at y = +-5600, side walls at
 *    x = +-4400, and four vertical quarter-cylinder corners of radius 1700 centred at
 *    (+-2700, +-3900). Each back wall is interrupted by its goal: the outline turns into the goal
 *    round the post (a plan-view arc of radius postRadius), runs along the side netting, round the
 *    back corner (radius edgeRadius), across the back and out the other side. The outline is a
 *    closed polygon, CCW seen from +z, whose arcs are polylines.
 *  - Walls: rings of that outline at increasing heights. Every outline vertex is pushed inward
 *    along its miter direction by the floor-ramp inset (circular ramp: r = 320 on the side walls,
 *    r = 240 on the back walls and inside the goals, eased with a smoothstep around each corner
 *    arc) plus the ceiling-arc inset (r = 600). Consecutive rings are stitched into triangle
 *    bands. Up to the ramp top (z = 240) the goal part of the outline gives the back-wall ramp
 *    wrapping round each post and the chamber's floor curves (side netting, back, back corners);
 *    above it those outline vertices are not used up to the top of the goal module (z = 1000)
 *    and then sit on the straight back wall, as extra samples of it.
 *  - Goal module (per goal, |x| <= 1450, from the ramp top up to z = 1000), above the ramp bands:
 *      tube   the mouth's cross-section (a rounded rectangle: the netting, the roof, corner radius
 *             240) swept from the back wall into the chamber: first the rounded edge with the back
 *             wall (posts and crossbar, radius 150), then the straight netting, then the rounded
 *             back cap (radius 240). A grid of mouth-curve samples x depth rows.
 *      back   the flat back of the net inside the cap, a fan.
 *      wall   the flat back wall around the mouth, ear-clipped between the tube's first row, the
 *             ramp-top ring and the rings at the module edges.
 *    Seen from inside, the chamber is a box with every edge rounded by 240; the ramp wraps round
 *    the posts into its floor curve, and the posts and crossbar are rounded into the wall.
 *    The goal floor is part of `floor` (RocketSim covers it with its infinite floor plane).
 *
 * Winding: every triangle is CCW seen from inside, i.e. face normals point INTO the playable
 * volume. A post-pass orients each triangle (a per-region reference point for the shell; the
 * analytic volume, isInsideArena, for the goals) and drops degenerate triangles. No triangle of
 * `physics` lies in the planes z = 0 or z = ARENA.height (RocketSim has infinite planes there; the
 * wrapper also moves its side-wall planes to x = +-ARENA.extentX, so the flat side-wall triangles at
 * x = +-4400 are harmless duplicates of that plane).
 *
 * Pure TypeScript, no three.js: runs in node (tests/arena.test.mjs). Build-time only, so it
 * allocates freely; the returned typed arrays are meant to be uploaded once.
 */
import { ARENA, GOAL_PROFILE } from './constants';

export interface MeshData {
  /** xyz triples, uu, sim coordinates (x side, y length, z up). */
  vertices: Float32Array;
  /** Triangle vertex indices (3 per triangle), wound so face normals point into the playable volume. */
  indices: Int32Array;
}

export interface ArenaMeshUvs {
  /** 2 floats per `shell` vertex: (distance along the back / side walls, height), both in uu. */
  shell: Float32Array;
  /** 2 floats per `goals` vertex: (x, height), uu (the goal material projects its net in world space). */
  goals: Float32Array;
}

export interface ArenaMesh {
  /**
   * Everything RocketSim needs: wall shell (ramps, flat walls, rounded corners, ceiling arcs, back
   * walls with the goal openings) plus both goals. Contains no triangle in the floor plane z = 0
   * or the ceiling plane z = ARENA.height.
   */
  physics: MeshData;
  /** Visual: the wall shell (same triangles as the shell part of `physics`). */
  shell: MeshData;
  /** Visual: both goals (posts and crossbar, netting, roof, back, their floor curves; no floor). */
  goals: MeshData;
  /** Visual: flat floor at z = 0 bounded by the ramp feet, plus the goal floors under the floor curves. */
  floor: MeshData;
  /** Visual: flat ceiling at z = ARENA.height bounded by the ceiling-arc tops. */
  ceiling: MeshData;
  /** Planar UVs for `shell` and `goals` (uu; divide by a tile size in the material). */
  uvs?: ArenaMeshUvs;
  /**
   * The goal frames: per goal (blue at -y first) a polyline (xyz triples, sim coords) along the
   * middle of the rounded post / crossbar edge, from the floor at one post over the crossbar to
   * the floor at the other (the renderer draws a glowing tube along it).
   */
  goalFrames?: Float32Array[];
}

export interface ArenaMeshOptions {
  /** Chords per 90deg of the floor ramps (default 12, 7.5deg facets). Also sets the goal's arcs (2/3 of it). */
  rampSegments?: number;
  /** Chords per 90deg of the wall-to-ceiling arcs (default 8). */
  ceilingSegments?: number;
  /** Chords per rounded corner (90deg plan-view arc; default 12). */
  cornerSegments?: number;
}

const EPS = 1e-6;
/** Rings closer than this (uu) are merged so no sliver bands are produced. */
const MIN_RING_GAP = 3;
/** Triangles with less area (uu^2) are dropped as degenerate. */
const MIN_TRI_AREA = 1e-3;

const W = ARENA.extentX;
const L = ARENA.extentY;
const H = ARENA.height;
const GW = ARENA.goalHalfWidth;
const GH = ARENA.goalHeight;
const GD = ARENA.goalDepth;
const R_SIDE = ARENA.sideRampRadius;
const R_BACK = ARENA.backRampRadius;
const R_CEIL = ARENA.ceilingRadius;
const RC = ARENA.cornerRadius;
const CX = ARENA.cornerCentreX;
const CY = ARENA.cornerCentreY;
const R_G = GOAL_PROFILE.edgeRadius;
const P_G = GOAL_PROFILE.postRadius;
const XB = GOAL_PROFILE.moduleHalfWidth;
const ZB = GOAL_PROFILE.moduleTop;

// The construction relies on these (the goal's floor curves continue the back-wall ramp).
if (R_G !== R_BACK) throw new Error('arenaMesh: GOAL_PROFILE.edgeRadius must equal ARENA.backRampRadius');
if (!(XB > GW + P_G && XB < CX)) throw new Error('arenaMesh: moduleHalfWidth must be between the post edge and the corner arc');
if (!(ZB > GH + P_G && ZB < H - R_CEIL)) throw new Error('arenaMesh: moduleTop must be between the crossbar edge and the ceiling arc');
if (!(GH > 2 * R_G && GW > R_G && GD > R_G + P_G)) throw new Error('arenaMesh: goal too small for its edge radii');

// ---- Small mesh builder --------------------------------------------------------------------

class MeshBuilder {
  readonly pos: number[] = [];
  readonly uv: number[] = [];
  readonly idx: number[] = [];
  /** Per triangle: wound by construction (finish never flips it). */
  readonly fixed: boolean[] = [];

  add(x: number, y: number, z: number, u = 0, v = 0): number {
    this.pos.push(x, y, z);
    this.uv.push(u, v);
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number, fixed = false): void {
    this.idx.push(a, b, c);
    this.fixed.push(fixed);
  }
}

/** Decides whether a triangle (unnormalised normal n, centroid c) must be flipped to face into the playable volume. */
type Orient = (nx: number, ny: number, nz: number, cx: number, cy: number, cz: number) => boolean;

/** Faces the arena's centre (the shell: every wall faces it). */
const towardCentre: Orient = (nx, ny, nz, cx, cy, cz) => nx * -cx + ny * -cy + nz * (H / 2 - cz) >= 0;

/** Faces the playable volume (isInsideArena) a few uu away: exact for any surface of the goals. */
const towardVolume: Orient = (nx, ny, nz, cx, cy, cz) => {
  const k = 6 / Math.hypot(nx, ny, nz);
  return isInsideArena(cx + nx * k, cy + ny * k, cz + nz * k) || !isInsideArena(cx - nx * k, cy - ny * k, cz - nz * k);
};

interface Finished extends MeshData {
  /** The builder's UVs for the vertices kept. */
  uv: Float32Array;
}

/**
 * Orient every triangle so its normal faces into the playable volume (flip otherwise), drop
 * degenerate triangles and the vertices no triangle uses (the collapsed ring points of a goal or a
 * back corner). Returns the finished mesh.
 */
function finish(b: MeshBuilder, keep: Orient): Finished {
  const p = b.pos;
  const src = b.idx;
  const out: number[] = [];
  for (let i = 0; i < src.length; i += 3) {
    const ia = src[i];
    const ib = src[i + 1];
    const ic = src[i + 2];
    if (ia === ib || ib === ic || ia === ic) continue;
    const ax = p[ia * 3];
    const ay = p[ia * 3 + 1];
    const az = p[ia * 3 + 2];
    const bx = p[ib * 3];
    const by = p[ib * 3 + 1];
    const bz = p[ib * 3 + 2];
    const cx = p[ic * 3];
    const cy = p[ic * 3 + 1];
    const cz = p[ic * 3 + 2];
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    if (Math.hypot(nx, ny, nz) < 2 * MIN_TRI_AREA) continue;
    if (b.fixed[i / 3] || keep(nx, ny, nz, (ax + bx + cx) / 3, (ay + by + cy) / 3, (az + bz + cz) / 3)) out.push(ia, ib, ic);
    else out.push(ia, ic, ib);
  }
  // Keep only the vertices some triangle uses, in their original order.
  const remap = new Int32Array(p.length / 3).fill(-1);
  for (const i of out) remap[i] = 0;
  let n = 0;
  for (let i = 0; i < remap.length; i++) if (remap[i] === 0) remap[i] = n++;
  const vertices = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  for (let i = 0; i < remap.length; i++) {
    const k = remap[i];
    if (k < 0) continue;
    vertices[k * 3] = p[i * 3];
    vertices[k * 3 + 1] = p[i * 3 + 1];
    vertices[k * 3 + 2] = p[i * 3 + 2];
    uv[k * 2] = b.uv[i * 2];
    uv[k * 2 + 1] = b.uv[i * 2 + 1];
  }
  return { vertices, indices: Int32Array.from(out, (i) => remap[i]), uv };
}

function meshOf(f: Finished): MeshData {
  return { vertices: f.vertices, indices: f.indices };
}

// ---- Arcs and insets --------------------------------------------------------------------------

/** cos / sin of `i / n` of a quarter turn, with exact values at both ends (shared vertices must be bit-identical). */
function quarterCos(i: number, n: number): number {
  return i === 0 ? 1 : i === n ? 0 : Math.cos(((Math.PI / 2) * i) / n);
}

function quarterSin(i: number, n: number): number {
  return i === 0 ? 0 : i === n ? 1 : Math.sin(((Math.PI / 2) * i) / n);
}

/** Points of the arc from (ax, ay) to (bx, by) around centre (cx, cy), both ends included. */
function arcPoints(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, segs: number): number[] {
  const a0 = Math.atan2(ay - cy, ax - cx);
  let a1 = Math.atan2(by - cy, bx - cx);
  while (a1 - a0 > Math.PI) a1 -= 2 * Math.PI;
  while (a1 - a0 < -Math.PI) a1 += 2 * Math.PI;
  const rad = Math.hypot(ax - cx, ay - cy);
  const pts: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const ang = a0 + ((a1 - a0) * i) / segs;
    pts.push(cx + rad * Math.cos(ang), cy + rad * Math.sin(ang));
  }
  // Snap the ends exactly onto the tangent points (keeps the back wall at exactly |y| = L).
  pts[0] = ax;
  pts[1] = ay;
  pts[2 * segs] = bx;
  pts[2 * segs + 1] = by;
  return pts;
}

/** Smoothstep 0..1 (the ramp radius eases from the side value to the back value around a corner). */
function smooth01(f: number): number {
  const t = f < 0 ? 0 : f > 1 ? 1 : f;
  return t * t * (3 - 2 * t);
}

/** Floor-ramp radius at the corner-arc angle `ang` (0 = side-wall tangent, pi/2 = back-wall tangent). */
export function cornerRampRadius(ang: number): number {
  return R_SIDE + (R_BACK - R_SIDE) * smooth01(ang / (Math.PI / 2));
}

/** Floor-ramp inset of a circular ramp of radius r at height z (r at the floor, 0 at z >= r). */
function rampInset(r: number, z: number): number {
  if (z >= r) return 0;
  if (z <= 0) return r;
  const d = r - z;
  return r - Math.sqrt(r * r - d * d);
}

function ceilInset(z: number): number {
  return rampInset(R_CEIL, H - z);
}

// ---- Goal tube ------------------------------------------------------------------------------

/**
 * One goal in local coordinates: X across (left -GW .. right +GW), Y = depth behind the mouth plane
 * (0 at the back wall, GD at the back of the net), Z up. Mirrored onto both ends by the caller.
 */
interface GoalTube {
  /** Mouth-curve samples (columns), from the left netting at the ramp top over the roof to the right. */
  cols: number;
  /** Depth rows: bullnose (row 0 on the wall plane), straight netting, back cap (last row on the back of the net). */
  rows: number;
  /** (X, Y, Z) per point, (row * cols + col) * 3. */
  pts: Float64Array;
  /** The row along the middle (45 degrees) of the rounded post / crossbar edge. */
  frameRow: number;
  /** X of the back-of-the-net floor samples between the two back corners, left to right, ends excluded. */
  backX: number[];
  /** Rows 0..lastBullnoseRow are the rounded post / crossbar edge; firstCapRow..rows-1 the back cap. */
  lastBullnoseRow: number;
  firstCapRow: number;
}

function goalTube(arcSegs: number): GoalTube {
  const r = R_G;
  const p = P_G;
  const nB = arcSegs + (arcSegs % 2); // even: the frame runs along its middle row
  const nK = arcSegs;
  const nC = arcSegs;
  const nV = 2;
  const nT = 8;
  const nS = 4;
  const nBack = 8;
  // The mouth curve: [point X, Z, outward normal X, Z, core point X, Z] (core = the curve inset by r).
  const U: number[][] = [];
  for (let i = 0; i <= nV; i++) {
    const z = i === nV ? GH - r : r + ((GH - 2 * r) * i) / nV;
    U.push([-GW, z, -1, 0, -(GW - r), z]);
  }
  for (let i = 1; i <= nC; i++) {
    // Left top corner: the normal turns from -X (i = 0) to +Z (i = nC).
    const nx = -quarterCos(i, nC);
    const nz = quarterSin(i, nC);
    U.push([-(GW - r) + r * nx, GH - r + r * nz, nx, nz, -(GW - r), GH - r]);
  }
  for (let i = 1; i <= nT; i++) {
    const x = -(GW - r) + (2 * (GW - r) * i) / nT;
    U.push([x, GH, 0, 1, x, GH - r]);
  }
  for (let i = 1; i <= nC; i++) {
    // Right top corner: the normal turns from +Z to +X.
    const nx = quarterSin(i, nC);
    const nz = quarterCos(i, nC);
    U.push([GW - r + r * nx, GH - r + r * nz, nx, nz, GW - r, GH - r]);
  }
  for (let i = 1; i <= nV; i++) {
    const z = i === nV ? r : GH - r - ((GH - 2 * r) * i) / nV;
    U.push([GW, z, 1, 0, GW - r, z]);
  }
  const cols = U.length;
  const rows = 1 + nB + nS + nK;
  const pts = new Float64Array(rows * cols * 3);
  for (let c = 0; c < cols; c++) {
    const [ux, uz, nx, nz, kx, kz] = U[c];
    let row = 0;
    const put = (x: number, y: number, z: number): void => {
      const o = (row * cols + c) * 3;
      pts[o] = x;
      pts[o + 1] = y;
      pts[o + 2] = z;
      row++;
    };
    // Rounded edge with the back wall: psi from 90 deg (on the wall plane) to 0 (on the netting).
    for (let j = 0; j <= nB; j++) {
      const out = 1 - quarterCos(nB - j, nB); // 1 - cos(psi), psi = 90 deg * (nB - j) / nB
      const depth = p * (1 - quarterSin(nB - j, nB)); // p * (1 - sin(psi))
      put(ux + p * nx * out, depth, uz + p * nz * out);
    }
    for (let j = 1; j <= nS; j++) put(ux, j === nS ? GD - r : p + ((GD - r - p) * j) / nS, uz);
    // Back cap: phi from 0 (on the netting) to 90 deg (on the back of the net).
    for (let j = 1; j <= nK; j++) {
      const cs = quarterCos(j, nK);
      put(kx + r * nx * cs, GD - r + r * quarterSin(j, nK), kz + r * nz * cs);
    }
  }
  const backX: number[] = [];
  for (let i = 1; i < nBack; i++) backX.push(-(GW - r) + (2 * (GW - r) * i) / nBack);
  return { cols, rows, pts, frameRow: nB / 2, backX, lastBullnoseRow: nB, firstCapRow: nB + nS };
}

// ---- Floor outline ----------------------------------------------------------------------------

/** Outline vertex kinds: the arena's own, the back wall inside a goal module, the goal's part of the outline. */
const K_ARENA = 0;
const K_MODULE = 1;
const K_GOAL = 2;

interface OutlinePoint {
  x: number;
  y: number;
  /** Floor-ramp radius at this outline vertex. */
  ramp: number;
  kind: number;
  /** K_GOAL: x of the back-wall sample it becomes above the goal module. */
  cx: number;
  /** Goal row (tube depth row) of a K_GOAL / post vertex taken from a tube column, else -1. */
  row: number;
  /** Which goal (+1 / -1 = the y sign) for K_MODULE / K_GOAL, 0 otherwise. */
  goal: number;
  /**
   * On a plan-view arc of a goal: 1 convex (the back corners: the inset moves toward the centre),
   * -1 reflex (round the posts: away from it), 0 elsewhere; (ax, ay) the centre. Arc points are
   * inset radially so the ramp stays an exact surface of revolution there (a back corner closes
   * to a point at the floor instead of overshooting its centre).
   */
  arc: number;
  ax: number;
  ay: number;
}

/**
 * The (+x, +y) quadrant of the outline from the side-wall tangent point (W, CY) to the back-wall
 * tangent point (CX, L), CCW: the quarter circle of radius RC around (CX, CY).
 */
function quadrantPath(cornerSegs: number): OutlinePoint[] {
  const arc = arcPoints(W, CY, CX, L, CX, CY, cornerSegs);
  const pts: OutlinePoint[] = [];
  for (let i = 0; i <= cornerSegs; i++) {
    pts.push({ x: arc[2 * i], y: arc[2 * i + 1], ramp: cornerRampRadius(((i / cornerSegs) * Math.PI) / 2), kind: K_ARENA, cx: 0, row: -1, goal: 0, arc: 0, ax: 0, ay: 0 });
  }
  return pts;
}

/** Module wall samples between the module edge and the post (both included), from x = a to x = b. */
const MODULE_WALL_SEGS = 2;

/**
 * The part of the back wall at y = sy * L that a goal replaces, in outline (travel) order: the
 * back wall from the module edge to the first post, the goal's floor outline (round the post,
 * along the netting, round the back corner, across the back, out the other side: the tube's two
 * end columns at the ramp top and the back samples), the back wall to the other module edge.
 * The +y wall is travelled toward -x, the -y wall toward +x.
 */
function goalInsert(sy: 1 | -1, tube: GoalTube): OutlinePoint[] {
  const dir = sy > 0 ? -1 : 1; // travel direction along x
  const out: OutlinePoint[] = [];
  const wall = (x: number): OutlinePoint => ({ x, y: sy * L, ramp: R_BACK, kind: K_MODULE, cx: 0, row: -1, goal: sy, arc: 0, ax: 0, ay: 0 });
  // Module edge -> first post.
  const x0 = -dir * XB;
  const xPost = -dir * (GW + P_G);
  for (let i = 0; i < MODULE_WALL_SEGS; i++) out.push(wall(x0 + ((xPost - x0) * i) / MODULE_WALL_SEGS));
  // The tube column at the first post (travel enters the goal there), then the back, then the other column.
  const firstCol = dir < 0 ? tube.cols - 1 : 0;
  const lastCol = dir < 0 ? 0 : tube.cols - 1;
  const goalPts: OutlinePoint[] = [];
  const colPoint = (c: number, row: number): OutlinePoint => {
    const o = (row * tube.cols + c) * 3;
    const side = c === 0 ? -1 : 1;
    let arc = 0;
    let ax = 0;
    let ay = 0;
    if (row <= tube.lastBullnoseRow) {
      arc = -1;
      ax = side * (GW + P_G);
      ay = sy * (L + P_G);
    } else if (row >= tube.firstCapRow) {
      arc = 1;
      ax = side * (GW - R_G);
      ay = sy * (L + GD - R_G);
    }
    return { x: tube.pts[o], y: sy * (L + tube.pts[o + 1]), ramp: R_BACK, kind: row === 0 ? K_MODULE : K_GOAL, cx: 0, row, goal: sy, arc, ax, ay };
  };
  for (let row = 0; row < tube.rows; row++) goalPts.push(colPoint(firstCol, row));
  const back = dir < 0 ? [...tube.backX].reverse() : tube.backX;
  for (const x of back) goalPts.push({ x, y: sy * (L + GD), ramp: R_BACK, kind: K_GOAL, cx: 0, row: tube.rows - 1, goal: sy, arc: 0, ax: 0, ay: 0 });
  for (let row = tube.rows - 1; row >= 0; row--) goalPts.push(colPoint(lastCol, row));
  // Above the module the K_GOAL vertices all sit on the second post's wall point, so the wall
  // across the mouth is one band per ring there (the zero-length bands are dropped as degenerate).
  const xb = goalPts[goalPts.length - 1].x;
  for (const g of goalPts) if (g.kind === K_GOAL) g.cx = xb;
  out.push(...goalPts);
  // Second post -> the other module edge.
  const x1 = dir * XB;
  for (let i = 1; i <= MODULE_WALL_SEGS; i++) out.push(wall(-xPost + ((x1 + xPost) * i) / MODULE_WALL_SEGS));
  return out;
}

interface RingVertex {
  x: number;
  y: number;
  /** Miter offset direction (inward, length 1/cos(half turn) so straight edges stay parallel). */
  mx: number;
  my: number;
  ramp: number;
  kind: number;
  cx: number;
  row: number;
  goal: number;
  /** Distance along the walls (the back walls straight across the mouths), for UVs. */
  u: number;
}

interface RingTemplate {
  verts: RingVertex[];
  /** Per goal (index 0: -y, 1: +y), the template indices of its insert, in travel order. */
  inserts: number[][];
}

function buildRingTemplate(cornerSegs: number, tube: GoalTube): RingTemplate {
  const q = quadrantPath(cornerSegs);
  // CCW seen from +z: up the +x side, along the +y back wall toward -x, down the -x side, along the -y back wall.
  const mirror = (p: OutlinePoint, sx: number, sy: number): OutlinePoint => ({ ...p, x: sx * p.x, y: sy * p.y });
  const outline: OutlinePoint[] = [];
  const inserts: number[][] = [[], []];
  const addInsert = (sy: 1 | -1): void => {
    for (const p of goalInsert(sy, tube)) {
      inserts[sy > 0 ? 1 : 0].push(outline.length);
      outline.push(p);
    }
  };
  outline.push(...q);
  addInsert(1);
  outline.push(...q.map((p) => mirror(p, -1, 1)).reverse());
  outline.push(...q.map((p) => mirror(p, -1, -1)));
  addInsert(-1);
  outline.push(...q.map((p) => mirror(p, 1, -1)).reverse());
  const E = outline.length;

  // Inward (left) unit normal of edge i: outline[i] -> outline[i+1].
  const nx = new Float64Array(E);
  const ny = new Float64Array(E);
  for (let i = 0; i < E; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % E];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    nx[i] = -dy / len;
    ny[i] = dx / len;
    if (nx[i] * -a.x + ny[i] * -a.y <= 0) throw new Error('arenaMesh: outline is not CCW');
  }

  const verts: RingVertex[] = [];
  for (let i = 0; i < E; i++) {
    const prev = (i - 1 + E) % E;
    let mx = nx[prev] + nx[i];
    let my = ny[prev] + ny[i];
    const ml = Math.hypot(mx, my);
    mx /= ml;
    my /= ml;
    let scale = 1 / (mx * nx[i] + my * ny[i]);
    const v = outline[i];
    if (v.arc !== 0) {
      // Radial (unit) inset on a goal arc: toward the centre on a convex arc, away on a reflex one.
      const rx = v.ax - v.x;
      const ry = v.ay - v.y;
      const rl = Math.hypot(rx, ry);
      mx = (v.arc * rx) / rl;
      my = (v.arc * ry) / rl;
      scale = 1;
    }
    verts.push({ x: v.x, y: v.y, mx: mx * scale, my: my * scale, ramp: v.ramp, kind: v.kind, cx: v.cx, row: v.row, goal: v.goal, u: 0 });
  }

  // Distance along the walls at floor level, measured with the goal vertices on the straight wall
  // (so the wall pattern runs on across a mouth); the arena's own vertices at their ramp feet.
  const p = new Float64Array(2);
  let px = 0;
  let py = 0;
  let u = 0;
  for (let j = 0; j < verts.length; j++) {
    const vj = verts[j];
    if (vj.kind === K_ARENA) ringPos(vj, 0, p);
    else {
      p[0] = vj.kind === K_GOAL ? vj.cx : vj.x;
      p[1] = vj.goal * (L - R_BACK);
    }
    if (j > 0) u += Math.hypot(p[0] - px, p[1] - py);
    vj.u = u;
    px = p[0];
    py = p[1];
  }
  return { verts, inserts };
}

/** Position of a ring vertex at height z (sim x, y into `out`). */
function ringPos(v: RingVertex, z: number, out: Float64Array): void {
  if (v.kind !== K_ARENA && z >= ZB - EPS) {
    // Above the goal module: the plain back wall (goal vertices are samples of it now).
    out[0] = v.kind === K_GOAL ? v.cx : v.x;
    out[1] = v.goal * (L - rampInset(R_BACK, z) - ceilInset(z));
    return;
  }
  const inset = rampInset(v.ramp, z) + ceilInset(z);
  out[0] = v.x + v.mx * inset;
  out[1] = v.y + v.my * inset;
}

/** Ring heights: cosine-spaced floor-ramp samples, the back-ramp top, the module top, sine-spaced ceiling-arc samples. */
function ringHeights(rampSegs: number, ceilSegs: number): number[] {
  interface Cand {
    z: number;
    required: boolean;
  }
  const cand: Cand[] = [];
  for (let k = 0; k <= rampSegs; k++) {
    const z = k === rampSegs ? R_SIDE : R_SIDE * (1 - Math.cos(((k / rampSegs) * Math.PI) / 2));
    cand.push({ z, required: k === 0 || k === rampSegs });
  }
  cand.push({ z: R_BACK, required: true });
  cand.push({ z: ZB, required: true });
  for (let k = 0; k <= ceilSegs; k++) {
    const z = k === ceilSegs ? H : H - R_CEIL + R_CEIL * Math.sin(((k / ceilSegs) * Math.PI) / 2);
    cand.push({ z, required: true });
  }
  cand.sort((a, b) => a.z - b.z);

  const out: Cand[] = [];
  for (const c of cand) {
    const last = out.length > 0 ? out[out.length - 1] : undefined;
    if (last !== undefined && c.z - last.z < MIN_RING_GAP) {
      if (c.required && !last.required) out[out.length - 1] = c;
      else if (c.required && last.required && c.z - last.z > EPS) out.push(c);
      continue; // otherwise drop the optional sample that sits too close
    }
    out.push(c);
  }
  return out.map((c) => c.z);
}

// ---- Planar triangulation -------------------------------------------------------------------

/**
 * Ear clipping of a simple polygon given as 2-D points (any orientation); returns triangles as
 * indices into `pts`. Every polygon vertex is kept as a triangle corner (an ear whose triangle
 * touches another vertex is refused), so collinear boundary samples stay shared with the
 * neighbouring meshes and no T-junction appears.
 */
function earClip(pts: readonly (readonly [number, number])[]): number[] {
  const n = pts.length;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(area >= 0 ? i : n - 1 - i);
  const cross = (o: readonly number[], a: readonly number[], b: readonly number[]): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const out: number[] = [];
  let guard = 0;
  while (idx.length > 3) {
    if (++guard > 10 * n * n) throw new Error('arenaMesh: ear clipping failed');
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const ia = idx[(k + idx.length - 1) % idx.length];
      const ib = idx[k];
      const ic = idx[(k + 1) % idx.length];
      const a = pts[ia];
      const b = pts[ib];
      const c = pts[ic];
      const ab = cross(a, b, c);
      if (ab <= 1e-6) continue; // reflex or flat corner: not an ear
      let blocked = false;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        const pj = pts[j];
        if ((pj[0] === a[0] && pj[1] === a[1]) || (pj[0] === b[0] && pj[1] === b[1]) || (pj[0] === c[0] && pj[1] === c[1])) continue;
        // Inside or on the triangle (an edge through another vertex would leave a T-junction).
        if (cross(a, b, pj) >= -1e-9 && cross(b, c, pj) >= -1e-9 && cross(c, a, pj) >= -1e-9) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      out.push(ia, ib, ic);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) throw new Error('arenaMesh: no ear found');
  }
  out.push(idx[0], idx[1], idx[2]);
  return out;
}

// ---- Public API -----------------------------------------------------------------------------

export function buildArenaMesh(opts: ArenaMeshOptions = {}): ArenaMesh {
  const rampSegments = Math.max(2, Math.floor(opts.rampSegments ?? 12));
  const ceilingSegments = Math.max(2, Math.floor(opts.ceilingSegments ?? 8));
  const cornerSegments = Math.max(2, Math.floor(opts.cornerSegments ?? 12));
  const goalArcSegments = Math.max(4, Math.round((rampSegments * 2) / 3));

  const tube = goalTube(goalArcSegments);
  const template = buildRingTemplate(cornerSegments, tube);
  const heights = ringHeights(rampSegments, ceilingSegments);
  const S = template.verts.length;
  const kRamp = heights.indexOf(R_BACK);
  const kTop = heights.indexOf(ZB);
  if (kRamp < 0 || kTop < 0) throw new Error('arenaMesh: ramp top / module top missing from the ring heights');

  // Ring positions, computed once (every mesh that shares a ring point reads the same floats).
  const ringX: Float64Array[] = [];
  const ringY: Float64Array[] = [];
  const p = new Float64Array(2);
  for (const z of heights) {
    const rx = new Float64Array(S);
    const ry = new Float64Array(S);
    for (let j = 0; j < S; j++) {
      ringPos(template.verts[j], z, p);
      rx[j] = p[0];
      ry[j] = p[1];
    }
    ringX.push(rx);
    ringY.push(ry);
  }
  const verts = template.verts;
  /** Shell UV u at a point of the back wall of goal `sy` (linear in x between the module edges). */
  const wallU = (sy: number, x: number): number => {
    const ins = template.inserts[sy > 0 ? 1 : 0];
    const a = verts[ins[0]];
    const b = verts[ins[ins.length - 1]];
    return a.u + ((b.u - a.u) * (x - a.x)) / (b.x - a.x);
  };

  // ---- Shell: ring bands ------------------------------------------------------------------
  const shellB = new MeshBuilder();
  const goalsB = new MeshBuilder();
  const rings: number[][] = [];
  for (let k = 0; k < heights.length; k++) {
    const row: number[] = [];
    for (let j = 0; j < S; j++) {
      const v = verts[j];
      row.push(shellB.add(ringX[k][j], ringY[k][j], heights[k], v.kind === K_GOAL && heights[k] >= ZB - EPS ? wallU(v.goal, v.cx) : v.u, heights[k]));
    }
    rings.push(row);
  }
  // Goal-mesh copies of ring points (the goals' floor curves below the ramp top).
  const goalRing = new Map<number, number>();
  const goalRingVertex = (k: number, j: number): number => {
    const key = k * S + j;
    let i = goalRing.get(key);
    if (i === undefined) {
      i = goalsB.add(ringX[k][j], ringY[k][j], heights[k], ringX[k][j], heights[k]);
      goalRing.set(key, i);
    }
    return i;
  };
  for (let k = 0; k < heights.length - 1; k++) {
    const zLo = heights[k];
    const zHi = heights[k + 1];
    const belowRampTop = zHi <= R_BACK + EPS;
    const aboveModule = zLo >= ZB - EPS;
    for (let j = 0; j < S; j++) {
      const j1 = (j + 1) % S;
      const a = verts[j];
      const b = verts[j1];
      const inGoal = a.kind === K_GOAL || b.kind === K_GOAL;
      const inModule = a.kind !== K_ARENA && b.kind !== K_ARENA;
      if (inGoal) {
        // The goal's floor curves (goal mesh) below the ramp top; the plain back wall above the module.
        if (belowRampTop) {
          const lo0 = goalRingVertex(k, j);
          const lo1 = goalRingVertex(k, j1);
          const hi0 = goalRingVertex(k + 1, j);
          const hi1 = goalRingVertex(k + 1, j1);
          goalsB.tri(lo0, hi0, hi1);
          goalsB.tri(lo0, hi1, lo1);
          continue;
        }
        if (!aboveModule) continue;
      } else if (inModule && !belowRampTop && !aboveModule) continue; // the module's wall panel covers it
      shellB.tri(rings[k][j], rings[k + 1][j], rings[k + 1][j1]);
      shellB.tri(rings[k][j], rings[k + 1][j1], rings[k][j1]);
    }
  }

  // ---- Goal modules: tube, back of the net, wall panel --------------------------------------
  const frames: Float32Array[] = [];
  for (const sy of [-1, 1] as const) {
    const ins = template.inserts[sy > 0 ? 1 : 0];
    const tubeIdx: number[] = [];
    for (let i = 0; i < tube.rows * tube.cols; i++) {
      const x = tube.pts[i * 3];
      const z = tube.pts[i * 3 + 2];
      tubeIdx.push(goalsB.add(x, sy * (L + tube.pts[i * 3 + 1]), z, x, z));
    }
    // The tube is one smooth grid: wind it all like a well-shaped quad of the straight netting
    // (thin triangles near the cap's poles would fool a per-triangle test).
    const at = (row: number, c: number, k: number): number => tube.pts[(row * tube.cols + c) * 3 + k];
    const qr = tube.lastBullnoseRow + 1;
    const qc = Math.floor(tube.cols / 2);
    const e1 = [at(qr + 1, qc, 0) - at(qr, qc, 0), sy * (at(qr + 1, qc, 1) - at(qr, qc, 1)), at(qr + 1, qc, 2) - at(qr, qc, 2)];
    const e2 = [at(qr, qc + 1, 0) - at(qr, qc, 0), sy * (at(qr, qc + 1, 1) - at(qr, qc, 1)), at(qr, qc + 1, 2) - at(qr, qc, 2)];
    const qn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const flip = !towardVolume(qn[0], qn[1], qn[2], at(qr, qc, 0), sy * (L + at(qr, qc, 1)), at(qr, qc, 2));
    for (let row = 0; row < tube.rows - 1; row++) {
      for (let c = 0; c < tube.cols - 1; c++) {
        const a = tubeIdx[row * tube.cols + c];
        const b = tubeIdx[row * tube.cols + c + 1];
        const d = tubeIdx[(row + 1) * tube.cols + c];
        const e = tubeIdx[(row + 1) * tube.cols + c + 1];
        if (flip) {
          goalsB.tri(a, e, d, true);
          goalsB.tri(a, b, e, true);
        } else {
          goalsB.tri(a, d, e, true);
          goalsB.tri(a, e, b, true);
        }
      }
    }

    // Back of the net: a fan over the cap's last row and the back's floor-curve top.
    const last = tube.rows - 1;
    const loop: number[] = [];
    for (let c = 0; c < tube.cols; c++) loop.push(tubeIdx[last * tube.cols + c]);
    const backRing = ins.filter((j) => verts[j].kind === K_GOAL && Math.abs(verts[j].y) === L + GD);
    // Right to left after the tube's right end (whatever the travel order was).
    const backSorted = [...backRing].sort((ja, jb) => verts[jb].x - verts[ja].x);
    for (const j of backSorted) loop.push(goalRingVertex(kRamp, j));
    const fc = goalsB.add(0, sy * (L + GD), GH / 2, 0, GH / 2);
    for (let i = 0; i < loop.length; i++) goalsB.tri(fc, loop[i], loop[(i + 1) % loop.length]);

    // Wall panel (shell): the back wall around the mouth, from the ramp top to the module top.
    const panel: { idx: number; x: number; z: number }[] = [];
    const ring = (k: number, j: number): void => {
      const prev = panel.length > 0 ? panel[panel.length - 1] : undefined;
      if (prev !== undefined && prev.x === ringX[k][j] && prev.z === heights[k]) return; // collapsed goal vertices on the module top
      panel.push({ idx: rings[k][j], x: ringX[k][j], z: heights[k] });
    };
    const postA = ins.findIndex((j) => verts[j].row === 0);
    const postB = ins.length - 1 - [...ins].reverse().findIndex((j) => verts[j].row === 0);
    // Along the ramp top from the module edge to the first post.
    for (let i = 0; i <= postA; i++) ring(kRamp, ins[i]);
    // The mouth: the tube's wall-plane row from the first post's column to the other one.
    const fromCol = verts[ins[postA]].x > 0 ? tube.cols - 1 : 0;
    const step = fromCol === 0 ? 1 : -1;
    for (let c = fromCol + step; c !== tube.cols - 1 - fromCol; c += step) {
      const i = c; // row 0
      const x = tube.pts[i * 3];
      const z = tube.pts[i * 3 + 2];
      panel.push({ idx: shellB.add(x, sy * L, z, wallU(sy, x), z), x, z });
    }
    // Along the ramp top from the second post to the other module edge.
    for (let i = postB; i < ins.length; i++) ring(kRamp, ins[i]);
    // Up the far module edge, back along the module top, down the near edge.
    const jFar = ins[ins.length - 1];
    const jNear = ins[0];
    for (let k = kRamp + 1; k <= kTop; k++) ring(k, jFar);
    for (let i = ins.length - 2; i >= 1; i--) ring(kTop, ins[i]);
    for (let k = kTop; k > kRamp; k--) ring(k, jNear);
    const tris = earClip(panel.map((q) => [q.x, q.z] as const));
    for (let i = 0; i < tris.length; i += 3) shellB.tri(panel[tris[i]].idx, panel[tris[i + 1]].idx, panel[tris[i + 2]].idx);

    // Goal frame: up the first post's floor curve, along the edge's middle row, down the other post.
    const frame: number[] = [];
    const framePost = (j: number, up: boolean): void => {
      for (let k = up ? 0 : kRamp; up ? k < kRamp : k > 0; k += up ? 1 : -1) frame.push(ringX[up ? k : k - 1][j], ringY[up ? k : k - 1][j], heights[up ? k : k - 1]);
    };
    const jLeft = ins.find((j) => verts[j].row === tube.frameRow && verts[j].x < 0);
    const jRight = ins.find((j) => verts[j].row === tube.frameRow && verts[j].x > 0);
    if (jLeft === undefined || jRight === undefined) throw new Error('arenaMesh: goal frame rows missing');
    framePost(jLeft, true);
    for (let c = 0; c < tube.cols; c++) {
      const o = (tube.frameRow * tube.cols + c) * 3;
      frame.push(tube.pts[o], sy * (L + tube.pts[o + 1]), tube.pts[o + 2]);
    }
    framePost(jRight, false);
    frames.push(Float32Array.from(frame));
  }
  const shellF = finish(shellB, towardCentre);
  const goalsF = finish(goalsB, towardVolume);
  const shell = meshOf(shellF);
  const goals = meshOf(goalsF);

  // ---- Floor: fan over the floor ring, plus the goal floors under their floor curves -------
  const floorB = new MeshBuilder();
  const fc = floorB.add(0, 0, 0);
  const ring0: number[] = [];
  for (let j = 0; j < S; j++) ring0.push(floorB.add(ringX[0][j], ringY[0][j], 0));
  for (let j = 0; j < S; j++) floorB.tri(fc, ring0[j], ring0[(j + 1) % S]);
  const wallFoot: number[] = [];
  for (let j = 0; j < S; j++) wallFoot.push(verts[j].kind === K_GOAL || verts[j].row === 0 ? floorB.add(verts[j].x, verts[j].y, 0) : -1);
  for (let j = 0; j < S; j++) {
    const j1 = (j + 1) % S;
    if (wallFoot[j] < 0 || wallFoot[j1] < 0 || (verts[j].kind !== K_GOAL && verts[j1].kind !== K_GOAL)) continue;
    floorB.tri(ring0[j], wallFoot[j], wallFoot[j1]);
    floorB.tri(ring0[j], wallFoot[j1], ring0[j1]);
  }
  const floor = meshOf(finish(floorB, (_nx, _ny, nz) => nz >= 0));

  // ---- Ceiling: fan over the top ring -----------------------------------------------------
  const ceilB = new MeshBuilder();
  const cc = ceilB.add(0, 0, H);
  const top: number[] = [];
  const kH = heights.length - 1;
  for (let j = 0; j < S; j++) top.push(ceilB.add(ringX[kH][j], ringY[kH][j], H));
  for (let j = 0; j < S; j++) ceilB.tri(cc, top[(j + 1) % S], top[j]);
  const ceiling = meshOf(finish(ceilB, (_nx, _ny, nz) => nz <= 0));

  return {
    physics: mergeForPhysics(shell, goals),
    shell,
    goals,
    floor,
    ceiling,
    uvs: { shell: shellF.uv, goals: goalsF.uv },
    goalFrames: frames,
  };
}

/** Shell + goals in one index space, minus any triangle lying in the floor or ceiling plane. */
function mergeForPhysics(shell: MeshData, goals: MeshData): MeshData {
  const vertices = new Float32Array(shell.vertices.length + goals.vertices.length);
  vertices.set(shell.vertices, 0);
  vertices.set(goals.vertices, shell.vertices.length);
  const offset = shell.vertices.length / 3;
  const out: number[] = [];
  const push = (idx: Int32Array, base: number): void => {
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] + base;
      const b = idx[i + 1] + base;
      const c = idx[i + 2] + base;
      const za = vertices[a * 3 + 2];
      const zb = vertices[b * 3 + 2];
      const zc = vertices[c * 3 + 2];
      const onFloor = Math.abs(za) < EPS && Math.abs(zb) < EPS && Math.abs(zc) < EPS;
      const onCeiling = Math.abs(za - H) < EPS && Math.abs(zb - H) < EPS && Math.abs(zc - H) < EPS;
      if (onFloor || onCeiling) continue;
      out.push(a, b, c);
    }
  };
  push(shell.indices, 0);
  push(goals.indices, offset);
  return { vertices, indices: Int32Array.from(out) };
}

/** Per-vertex (area-weighted, smooth) unit normals; 3 floats per vertex. De-index for flat shading. */
export function computeNormals(m: MeshData): Float32Array {
  const v = m.vertices;
  const idx = m.indices;
  const n = new Float32Array(v.length);
  for (let i = 0; i < idx.length; i += 3) {
    const ia = idx[i] * 3;
    const ib = idx[i + 1] * 3;
    const ic = idx[i + 2] * 3;
    const ux = v[ib] - v[ia];
    const uy = v[ib + 1] - v[ia + 1];
    const uz = v[ib + 2] - v[ia + 2];
    const wx = v[ic] - v[ia];
    const wy = v[ic + 1] - v[ia + 1];
    const wz = v[ic + 2] - v[ia + 2];
    const nx = uy * wz - uz * wy;
    const ny = uz * wx - ux * wz;
    const nz = ux * wy - uy * wx;
    n[ia] += nx;
    n[ia + 1] += ny;
    n[ia + 2] += nz;
    n[ib] += nx;
    n[ib + 1] += ny;
    n[ib + 2] += nz;
    n[ic] += nx;
    n[ic + 1] += ny;
    n[ic + 2] += nz;
  }
  for (let i = 0; i < n.length; i += 3) {
    const len = Math.hypot(n[i], n[i + 1], n[i + 2]);
    if (len > 0) {
      n[i] /= len;
      n[i + 1] /= len;
      n[i + 2] /= len;
    } else {
      n[i + 2] = 1;
    }
  }
  return n;
}

/** Zero-copy Uint32 view of the indices (three.js needs an unsigned index array on WebGL). */
export function indicesAsUint32(m: MeshData): Uint32Array {
  return new Uint32Array(m.indices.buffer, m.indices.byteOffset, m.indices.length);
}

// ---- Analytic volume --------------------------------------------------------------------------

/** Signed distance from (|x|, z) to the mouth's cross-section (|x| <= GW, 0 <= z <= GH, corners r): negative inside. */
function mouthSd(ax: number, z: number): number {
  const qx = ax - (GW - R_G);
  const qz = Math.abs(z - GH / 2) - (GH / 2 - R_G);
  return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - R_G;
}

/** Signed distance to the chamber (the box behind the mouth, every edge rounded by r; open toward the field). */
function chamberSd(ax: number, d: number, z: number): number {
  const qx = ax - (GW - R_G);
  const qy = d - (GD - R_G);
  const qz = Math.abs(z - GH / 2) - (GH / 2 - R_G);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - R_G;
}

/** Inside a goal module (|x| <= XB, |y| > L - R_BACK, 0 <= z <= H); `d` = depth behind the mouth plane. */
function insideGoalModule(ax: number, d: number, z: number): boolean {
  if (z > ZB) return d <= -(rampInset(R_BACK, z) + ceilInset(z));
  if (d >= P_G) return chamberSd(ax, d, z) <= 0;
  if (z < R_G) {
    // Plan view: the post is the quadrant x >= GW, d >= 0 with its corner rounded by P_G; the
    // ramp (the back wall's, wrapping round the post into the chamber) keeps rampInset away from it.
    const dist = Math.hypot(Math.max(GW + P_G - ax, 0), Math.max(P_G - d, 0)) - P_G;
    return dist >= rampInset(R_G, z);
  }
  // Above the ramp: the back wall with the mouth cut into it, the cut's edge rounded by P_G.
  const dy = P_G - d;
  const dxz = Math.max(0, P_G - mouthSd(ax, z));
  return dy * dy + dxz * dxz > P_G * P_G;
}

/**
 * Analytic containment test for the playable volume (main bowl incl. ramps, rounded corners and
 * ceiling arcs, plus the goals with their rounded posts, crossbar and chambers). Exact up to the
 * polyline chords of the mesh (a few uu). For orienting the goal triangles, AI, tests and
 * debugging; not for collision.
 */
export function isInsideArena(x: number, y: number, z: number): boolean {
  if (z < 0 || z > H) return false;
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  if (ax <= XB && ay > L - R_BACK) return insideGoalModule(ax, ay - L, z);
  if (ay > L) return false;
  const ci = ceilInset(z);
  if (ax > W - (rampInset(R_SIDE, z) + ci)) return false;
  const dx = ax - CX;
  const dy = ay - CY;
  if (dx > 0 && dy > 0) {
    // Rounded corner: the ramp radius at this angle around the corner.
    const inset = rampInset(cornerRampRadius(Math.atan2(dy, dx)), z) + ci;
    const r = RC - inset;
    return dx * dx + dy * dy <= r * r;
  }
  return ay <= L - (rampInset(R_BACK, z) + ci);
}
