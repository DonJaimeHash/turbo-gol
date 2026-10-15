/**
 * Our analytic arena -> indexed triangle meshes, in uu and sim coordinates (x side +-4400, y length
 * +-5600 with the goals reaching |y| = 6560, z up 0..2250; every number comes from ARENA /
 * GOAL_PROFILE in constants.ts).
 *
 * ONE generator feeds both RocketSim (collision mesh: `physics`) and the renderer (`shell`,
 * `goals`, `floor`, `ceiling`), so what is drawn is exactly what the ball bounces off.
 *
 * Construction:
 *  - Floor outline (top view): a rounded rectangle. Back walls at y = +-5600, side walls at
 *    x = +-4400, and four vertical quarter-cylinder corners of radius 1700 centred at
 *    (+-2700, +-3900). The outline is a closed polygon, CCW seen from +z, whose corner arcs are
 *    polylines of `cornerSegments` chords.
 *  - Walls: rings of that outline at increasing heights. Every outline vertex is pushed inward
 *    along its miter direction by the floor-ramp inset (circular ramp: r = 320 on the side walls,
 *    r = 240 on the back walls, eased with a smoothstep around each corner arc) plus the
 *    ceiling-arc inset (r = 600). Consecutive rings are stitched into triangle bands. The
 *    back-wall edge is split at the goal posts and the mouth segment is left open below
 *    z = 720; small vertical caps close the ends of the back-wall ramp at the posts.
 *  - Goal chambers: a 2-D profile (depth behind the mouth, height) extruded across the goal width
 *    with flat side caps (the netting at x = +-1000): a box 960 deep and 720 high whose back
 *    edges are rounded (r = 240 from the floor up the back of the net, r = 360 into the roof),
 *    with a flat roof back to the mouth. The goal floor is part of `floor` (RocketSim covers it
 *    with its infinite floor plane).
 *
 * Winding: every triangle is CCW seen from inside, i.e. face normals point INTO the playable
 * volume. A post-pass checks each triangle against a per-region reference point and flips strays;
 * it also drops degenerate triangles. No triangle of `physics` lies in the planes z = 0 or
 * z = ARENA.height (RocketSim has infinite planes there; the wrapper also moves its side-wall
 * planes to x = +-ARENA.extentX, so the flat side-wall triangles at x = +-4400 are harmless
 * duplicates of that plane).
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
  /** 2 floats per `shell` vertex: (distance along the floor outline, height), both in uu. */
  shell: Float32Array;
  /** 2 floats per `goals` vertex: (x, distance along the chamber profile from the mouth floor), uu. */
  goals: Float32Array;
}

export interface ArenaMesh {
  /**
   * Everything RocketSim needs: wall shell (ramps, flat walls, rounded corners, ceiling arcs, back
   * walls with the goal openings, post caps) plus both goal chambers. Contains no triangle in the
   * floor plane z = 0 or the ceiling plane z = ARENA.height.
   */
  physics: MeshData;
  /** Visual: the wall shell (same triangles as the shell part of `physics`). */
  shell: MeshData;
  /** Visual: both goal chambers (netting, rounded back, roof; no floor). */
  goals: MeshData;
  /** Visual: flat floor at z = 0 bounded by the ramp feet, plus the goal floors out to the back of the nets. */
  floor: MeshData;
  /** Visual: flat ceiling at z = ARENA.height bounded by the ceiling-arc tops. */
  ceiling: MeshData;
  /** Planar UVs for `shell` and `goals` (uu; divide by a tile size in the material). */
  uvs?: ArenaMeshUvs;
}

export interface ArenaMeshOptions {
  /** Chords per 90deg of the floor ramps (default 12, 7.5deg facets). Also the goal's rounded back edges. */
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
const G_RB = GOAL_PROFILE.backBottomRadius;
const G_RT = GOAL_PROFILE.backTopRadius;

// ---- Small mesh builder --------------------------------------------------------------------

class MeshBuilder {
  readonly pos: number[] = [];
  readonly uv: number[] = [];
  readonly idx: number[] = [];

  add(x: number, y: number, z: number, u = 0, v = 0): number {
    this.pos.push(x, y, z);
    this.uv.push(u, v);
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }
}

/** Writes the point every triangle of a region must face into `out` (given the triangle centroid). */
type RefPoint = (cx: number, cy: number, cz: number, out: Float64Array) => void;

const arenaCentre: RefPoint = (_cx, _cy, _cz, out) => {
  out[0] = 0;
  out[1] = 0;
  out[2] = H / 2;
};

const goalAxis: RefPoint = (_cx, cy, _cz, out) => {
  out[0] = 0;
  out[1] = Math.sign(cy) * (L + 0.45 * GD);
  out[2] = GH / 2;
};

/**
 * Orient every triangle so its normal faces the region's reference point (flip otherwise) and
 * drop degenerate triangles. Returns the finished mesh.
 */
function finish(b: MeshBuilder, ref: RefPoint): MeshData {
  const p = b.pos;
  const src = b.idx;
  const out: number[] = [];
  const r = new Float64Array(3);
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
    const mx = (ax + bx + cx) / 3;
    const my = (ay + by + cy) / 3;
    const mz = (az + bz + cz) / 3;
    ref(mx, my, mz, r);
    const d = nx * (r[0] - mx) + ny * (r[1] - my) + nz * (r[2] - mz);
    if (d >= 0) out.push(ia, ib, ic);
    else out.push(ia, ic, ib);
  }
  return { vertices: Float32Array.from(b.pos), indices: Int32Array.from(out) };
}

// ---- Floor outline --------------------------------------------------------------------------

interface OutlinePoint {
  x: number;
  y: number;
  /** Floor-ramp radius at this outline vertex. */
  ramp: number;
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

/**
 * The (+x, +y) quadrant of the outline from the side-wall tangent point (W, CY) to the back-wall
 * tangent point (CX, L), CCW: the quarter circle of radius RC around (CX, CY). The straight side
 * and back walls are the implied edges between consecutive quadrants.
 */
function quadrantPath(cornerSegs: number): OutlinePoint[] {
  const arc = arcPoints(W, CY, CX, L, CX, CY, cornerSegs);
  const pts: OutlinePoint[] = [];
  for (let i = 0; i <= cornerSegs; i++) {
    pts.push({ x: arc[2 * i], y: arc[2 * i + 1], ramp: cornerRampRadius(((i / cornerSegs) * Math.PI) / 2) });
  }
  return pts;
}

interface RingVertex {
  x: number;
  y: number;
  /** Miter offset direction (inward, length 1/cos(half turn) so straight edges stay parallel). */
  mx: number;
  my: number;
  ramp: number;
  /** Distance along the floor ring, for UVs. */
  u: number;
}

interface RingTemplate {
  verts: RingVertex[];
  /** mouth[j]: the segment verts[j] -> verts[j+1] is the open goal mouth. */
  mouth: boolean[];
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

function ringPos(v: RingVertex, z: number, out: Float64Array): void {
  const inset = rampInset(v.ramp, z) + ceilInset(z);
  out[0] = v.x + v.mx * inset;
  out[1] = v.y + v.my * inset;
}

function buildRingTemplate(cornerSegs: number): RingTemplate {
  const q = quadrantPath(cornerSegs);
  // CCW seen from +z: up the +x side, along the +y back wall toward -x, down the -x side, along the -y back wall.
  const outline: OutlinePoint[] = [
    ...q,
    ...q.map((p) => ({ x: -p.x, y: p.y, ramp: p.ramp })).reverse(),
    ...q.map((p) => ({ x: -p.x, y: -p.y, ramp: p.ramp })),
    ...q.map((p) => ({ x: p.x, y: -p.y, ramp: p.ramp })).reverse(),
  ];
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
  const mouth: boolean[] = [];
  for (let i = 0; i < E; i++) {
    const prev = (i - 1 + E) % E;
    let mx = nx[prev] + nx[i];
    let my = ny[prev] + ny[i];
    const ml = Math.hypot(mx, my);
    mx /= ml;
    my /= ml;
    const scale = 1 / (mx * nx[i] + my * ny[i]);
    const v = outline[i];
    verts.push({ x: v.x, y: v.y, mx: mx * scale, my: my * scale, ramp: v.ramp, u: 0 });
    mouth.push(false);

    // Split the back-wall edge that spans the goal at the posts.
    const b = outline[(i + 1) % E];
    const onBack = Math.abs(Math.abs(v.y) - L) < EPS && Math.abs(Math.abs(b.y) - L) < EPS;
    if (onBack && Math.min(v.x, b.x) < -GW && Math.max(v.x, b.x) > GW) {
      const dir = Math.sign(b.x - v.x);
      verts.push({ x: -dir * GW, y: v.y, mx: nx[i], my: ny[i], ramp: R_BACK, u: 0 });
      mouth.push(true);
      verts.push({ x: dir * GW, y: v.y, mx: nx[i], my: ny[i], ramp: R_BACK, u: 0 });
      mouth.push(false);
    }
  }

  // Perimeter parameter along the floor ring.
  const p = new Float64Array(2);
  let px = 0;
  let py = 0;
  let u = 0;
  for (let j = 0; j < verts.length; j++) {
    ringPos(verts[j], 0, p);
    if (j > 0) u += Math.hypot(p[0] - px, p[1] - py);
    verts[j].u = u;
    px = p[0];
    py = p[1];
  }
  return { verts, mouth };
}

/** Ring heights: cosine-spaced floor-ramp samples, the back-ramp top, the goal height, sine-spaced ceiling-arc samples. */
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
  cand.push({ z: GH, required: true });
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

// ---- Goal chamber profile -------------------------------------------------------------------

/** Chamber profile as [depth, height] pairs, CCW in the (depth, height) plane, starting at the mouth floor. */
function goalProfile(rampSegs: number): number[][] {
  const steps = Math.max(3, rampSegs);
  const prof: number[][] = [];
  prof.push([0, 0]);
  // Floor -> back of the net: quarter circle around (GD - rb, rb) from -90deg to 0deg.
  prof.push([GD - G_RB, 0]);
  for (let k = 1; k <= steps; k++) {
    const ang = -Math.PI / 2 + ((Math.PI / 2) * k) / steps;
    prof.push([GD - G_RB + G_RB * Math.cos(ang), G_RB + G_RB * Math.sin(ang)]);
  }
  // Back of the net -> roof: quarter circle around (GD - rt, GH - rt) from 0deg to 90deg.
  if (GH - G_RT > G_RB + EPS) prof.push([GD, GH - G_RT]);
  for (let k = 1; k <= steps; k++) {
    const ang = ((Math.PI / 2) * k) / steps;
    prof.push([GD - G_RT + G_RT * Math.cos(ang), GH - G_RT + G_RT * Math.sin(ang)]);
  }
  prof.push([0, GH]);
  return prof;
}

// ---- Public API -----------------------------------------------------------------------------

export function buildArenaMesh(opts: ArenaMeshOptions = {}): ArenaMesh {
  const rampSegments = Math.max(2, Math.floor(opts.rampSegments ?? 12));
  const ceilingSegments = Math.max(2, Math.floor(opts.ceilingSegments ?? 8));
  const cornerSegments = Math.max(2, Math.floor(opts.cornerSegments ?? 12));

  const template = buildRingTemplate(cornerSegments);
  const heights = ringHeights(rampSegments, ceilingSegments);
  const S = template.verts.length;
  const p = new Float64Array(2);

  // ---- Shell: ring bands ------------------------------------------------------------------
  const shellB = new MeshBuilder();
  const rings: number[][] = [];
  for (const z of heights) {
    const row: number[] = [];
    for (const rv of template.verts) {
      ringPos(rv, z, p);
      row.push(shellB.add(p[0], p[1], z, rv.u, z));
    }
    rings.push(row);
  }
  for (let k = 0; k < heights.length - 1; k++) {
    const below = rings[k];
    const above = rings[k + 1];
    const zTop = heights[k + 1];
    for (let j = 0; j < S; j++) {
      if (template.mouth[j] && zTop <= GH + EPS) continue; // open goal mouth
      const j1 = (j + 1) % S;
      shellB.tri(below[j], above[j], above[j1]);
      shellB.tri(below[j], above[j1], below[j1]);
    }
  }

  // ---- Shell: post caps closing the back-wall ramp ends at the goal posts ------------------
  const capHeights = heights.filter((z) => z <= R_BACK + EPS);
  for (const sy of [-1, 1]) {
    for (const sx of [-1, 1]) {
      let u = 0;
      for (const rv of template.verts) {
        if (Math.abs(rv.x - sx * GW) < EPS && Math.sign(rv.y) === sy) u = rv.u;
      }
      const corner = shellB.add(sx * GW, sy * L, 0, u, 0);
      const prof: number[] = [];
      for (const z of capHeights) prof.push(shellB.add(sx * GW, sy * (L - rampInset(R_BACK, z)), z, u, z));
      for (let k = 0; k < prof.length - 1; k++) {
        if (sx * sy > 0) shellB.tri(corner, prof[k], prof[k + 1]);
        else shellB.tri(corner, prof[k + 1], prof[k]);
      }
    }
  }
  const shell = finish(shellB, arenaCentre);

  // ---- Goal chambers ----------------------------------------------------------------------
  const goalsB = new MeshBuilder();
  const prof = goalProfile(rampSegments);
  const P = prof.length;
  const arcLen: number[] = [0];
  for (let k = 1; k < P; k++) arcLen.push(arcLen[k - 1] + Math.hypot(prof[k][0] - prof[k - 1][0], prof[k][1] - prof[k - 1][1]));
  let cd = 0;
  let ch = 0;
  let cs = 0;
  for (let k = 0; k < P; k++) {
    cd += prof[k][0];
    ch += prof[k][1];
    cs += arcLen[k];
  }
  cd /= P;
  ch /= P;
  cs /= P;
  for (const sy of [-1, 1]) {
    const rails: number[][] = [];
    for (const x of [-GW, GW]) {
      const rail: number[] = [];
      for (let k = 0; k < P; k++) rail.push(goalsB.add(x, sy * (L + prof[k][0]), prof[k][1], x, arcLen[k]));
      rails.push(rail);
    }
    const left = rails[0];
    const right = rails[1];
    // Extruded surface: skip segment 0 (the floor) and the closing segment (the open mouth).
    for (let k = 1; k < P - 1; k++) {
      goalsB.tri(left[k], right[k], right[k + 1]);
      goalsB.tri(left[k], right[k + 1], left[k + 1]);
    }
    // Netting: fan over the (convex) profile polygon, including its floor and mouth edges.
    for (let side = 0; side < 2; side++) {
      const x = side === 0 ? -GW : GW;
      const rail = rails[side];
      const c = goalsB.add(x, sy * (L + cd), ch, x, cs);
      for (let k = 0; k < P; k++) goalsB.tri(c, rail[k], rail[(k + 1) % P]);
    }
  }
  const goals = finish(goalsB, goalAxis);

  // ---- Floor: fan over the floor ring + goal strips ----------------------------------------
  const floorB = new MeshBuilder();
  const fc = floorB.add(0, 0, 0);
  const ring0: number[] = [];
  for (const rv of template.verts) {
    ringPos(rv, 0, p);
    ring0.push(floorB.add(p[0], p[1], 0));
  }
  for (let j = 0; j < S; j++) floorB.tri(fc, ring0[j], ring0[(j + 1) % S]);
  for (const sy of [-1, 1]) {
    const y0 = sy * (L - R_BACK);
    const y1 = sy * (L + GD);
    const a = floorB.add(-GW, y0, 0);
    const b = floorB.add(GW, y0, 0);
    const c = floorB.add(GW, y1, 0);
    const d = floorB.add(-GW, y1, 0);
    floorB.tri(a, b, c);
    floorB.tri(a, c, d);
  }
  const floor = finish(floorB, arenaCentre);

  // ---- Ceiling: fan over the top ring -----------------------------------------------------
  const ceilB = new MeshBuilder();
  const cc = ceilB.add(0, 0, H);
  const top: number[] = [];
  for (const rv of template.verts) {
    ringPos(rv, H, p);
    top.push(ceilB.add(p[0], p[1], H));
  }
  for (let j = 0; j < S; j++) ceilB.tri(cc, top[(j + 1) % S], top[j]);
  const ceiling = finish(ceilB, arenaCentre);

  return {
    physics: mergeForPhysics(shell, goals),
    shell,
    goals,
    floor,
    ceiling,
    uvs: { shell: Float32Array.from(shellB.uv), goals: Float32Array.from(goalsB.uv) },
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

/**
 * Quick analytic containment test for the playable volume (main bowl incl. ramps, rounded corners
 * and ceiling arcs, plus the goal chambers). Exact up to the polyline chords of the mesh (a few uu).
 * For AI / tests / debugging, not for collision.
 */
export function isInsideArena(x: number, y: number, z: number): boolean {
  if (z < 0) return false;
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  if (ay > L) {
    // Inside a goal chamber?
    if (ax >= GW) return false;
    const d = ay - L;
    if (d > GD || z > GH) return false;
    if (d > GD - G_RB && z < G_RB) {
      const dd = d - (GD - G_RB);
      const dz = z - G_RB;
      if (dd * dd + dz * dz > G_RB * G_RB) return false;
    }
    if (d > GD - G_RT && z > GH - G_RT) {
      const dd = d - (GD - G_RT);
      const dz = z - (GH - G_RT);
      if (dd * dd + dz * dz > G_RT * G_RT) return false;
    }
    return true;
  }
  if (z > H) return false;
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
  if (ay > L - (rampInset(R_BACK, z) + ci)) return ax < GW && z < GH; // between the back ramp and the mouth plane
  return true;
}
