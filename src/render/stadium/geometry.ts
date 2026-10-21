/**
 * Geometry helpers for the stadium. Everything here runs once, at build time (behind the loading
 * overlay or a tier switch), and may allocate freely; nothing runs per frame.
 *
 *  - splitShell(): the sim's wall shell -> the opaque board band (below BOARD_SPLIT_Y, plus the flat
 *    goal-module panels round each goal mouth) and the netting above it, as two non-indexed
 *    geometries with surface coordinates in `uv` (uu): the boards get the distance round the
 *    outline (continuous, so the cards run round the corners), the netting a per-panel coordinate
 *    whose seams fall under the steel (layout.ts netAcross). Triangles crossing the cut are clipped,
 *    so the seam is exact without a per-pixel discard.
 *  - sweepTube(): a tube along a polyline with a fixed side axis (planar arches, flat rings).
 *  - arcInPlane(), roundedOutline(): the cage's rib profiles and rings.
 *  - mergeParts(): merge geometries that share position / normal (+ uv) into one draw.
 *  - rng(): a small seeded PRNG so every bake is identical.
 */
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BOARD_SPLIT_Y, FIELD, OUTLINE_LENGTH, netAcross, outlineDistance, profileDistance } from './layout';

/** One vertex during the split: position, normal. */
interface V {
  p: [number, number, number];
  n: [number, number, number];
}

function lerpV(a: V, b: V, t: number): V {
  return {
    p: [a.p[0] + (b.p[0] - a.p[0]) * t, a.p[1] + (b.p[1] - a.p[1]) * t, a.p[2] + (b.p[2] - a.p[2]) * t],
    n: [a.n[0] + (b.n[0] - a.n[0]) * t, a.n[1] + (b.n[1] - a.n[1]) * t, a.n[2] + (b.n[2] - a.n[2]) * t],
  };
}

/** True for a triangle (centroid) of the flat back-wall panel built round a goal mouth. */
function inGoalModule(cx: number, cy: number, cz: number): boolean {
  return Math.abs(cx) < FIELD.moduleHalfW + 1 && Math.abs(cz) > FIELD.halfZ - 30 && cy < FIELD.moduleTop + 1;
}

/** Collects triangles, then builds a non-indexed geometry with its surface coordinates. */
class TriSink {
  readonly tris: V[][] = [];

  add(poly: V[]): void {
    for (let k = 1; k + 1 < poly.length; k++) this.tris.push([poly[0], poly[k], poly[k + 1]]);
  }

  /** `uvOf(vertex, triangle)` gives (u, v) for one corner; `unwrap` fixes the outline seam. */
  build(uvOf: (v: V, tri: V[]) => [number, number], unwrap: boolean): THREE.BufferGeometry {
    const n = this.tris.length * 3;
    const pos = new Float32Array(n * 3);
    const nor = new Float32Array(n * 3);
    const uvs = new Float32Array(n * 2);
    let i = 0;
    for (const tri of this.tris) {
      const us: number[] = [];
      const vs: number[] = [];
      for (const v of tri) {
        const [u, w] = uvOf(v, tri);
        us.push(u);
        vs.push(w);
      }
      // The outline distance jumps from OUTLINE_LENGTH back to 0 behind the red goal: a triangle
      // spanning it would interpolate backwards through every card, so lift its small values.
      if (unwrap && Math.max(...us) - Math.min(...us) > OUTLINE_LENGTH / 2) {
        for (let k = 0; k < 3; k++) if (us[k] < OUTLINE_LENGTH / 2) us[k] += OUTLINE_LENGTH;
      }
      for (let k = 0; k < 3; k++) {
        const v = tri[k];
        const len = Math.hypot(v.n[0], v.n[1], v.n[2]) || 1;
        pos.set(v.p, i * 3);
        nor.set([v.n[0] / len, v.n[1] / len, v.n[2] / len], i * 3);
        uvs[i * 2] = us[k];
        uvs[i * 2 + 1] = vs[k];
        i++;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * Split the wall shell (indexed, with vertex normals, faces pointing into the arena) into the
 * board band and the netting (see the file header). `ceiling` (the flat roof) joins the netting
 * with uv = world (x, z).
 */
export function splitShell(shell: THREE.BufferGeometry, ceiling: THREE.BufferGeometry): { boards: THREE.BufferGeometry; net: THREE.BufferGeometry } {
  const P = shell.getAttribute('position');
  const N = shell.getAttribute('normal');
  const index = shell.getIndex();
  const vert = (i: number): V => ({ p: [P.getX(i), P.getY(i), P.getZ(i)], n: [N.getX(i), N.getY(i), N.getZ(i)] });
  const below = new TriSink();
  const above = new TriSink();
  const triCount = index !== null ? index.count / 3 : P.count / 3;
  for (let t = 0; t < triCount; t++) {
    const ia = index !== null ? index.getX(t * 3) : t * 3;
    const ib = index !== null ? index.getX(t * 3 + 1) : t * 3 + 1;
    const ic = index !== null ? index.getX(t * 3 + 2) : t * 3 + 2;
    const tri = [vert(ia), vert(ib), vert(ic)];
    const ys = tri.map((v) => v.p[1]);
    const cx = (tri[0].p[0] + tri[1].p[0] + tri[2].p[0]) / 3;
    const cy = (ys[0] + ys[1] + ys[2]) / 3;
    const cz = (tri[0].p[2] + tri[1].p[2] + tri[2].p[2]) / 3;
    if (Math.max(...ys) <= BOARD_SPLIT_Y || inGoalModule(cx, cy, cz)) {
      below.add(tri);
      continue;
    }
    if (Math.min(...ys) >= BOARD_SPLIT_Y) {
      above.add(tri);
      continue;
    }
    // Clip against both half spaces (Sutherland-Hodgman on 3 vertices).
    for (const side of [0, 1] as const) {
      const inside = (v: V): boolean => (side === 0 ? v.p[1] <= BOARD_SPLIT_Y : v.p[1] >= BOARD_SPLIT_Y);
      const poly: V[] = [];
      for (let k = 0; k < 3; k++) {
        const a = tri[k];
        const b = tri[(k + 1) % 3];
        if (inside(a)) poly.push(a);
        if (inside(a) !== inside(b)) poly.push(lerpV(a, b, (BOARD_SPLIT_Y - a.p[1]) / (b.p[1] - a.p[1])));
      }
      if (poly.length >= 3) (side === 0 ? below : above).add(poly);
    }
  }
  const boards = below.build((v) => [outlineDistance(v.p[0], v.p[2]), profileDistance(v.p[1], v.n[1])], true);
  const walls = above.build((v, tri) => {
    const cx = (tri[0].p[0] + tri[1].p[0] + tri[2].p[0]) / 3;
    const cz = (tri[0].p[2] + tri[1].p[2] + tri[2].p[2]) / 3;
    return [netAcross(v.p[0], v.p[2], cx, cz), profileDistance(v.p[1], v.n[1])];
  }, false);

  // The roof: non-indexed, uv = world (x, z).
  const roof = ceiling.index !== null ? ceiling.toNonIndexed() : ceiling.clone();
  if (roof.getAttribute('normal') === undefined) roof.computeVertexNormals();
  const rp = roof.getAttribute('position');
  const ruv = new Float32Array(rp.count * 2);
  for (let i = 0; i < rp.count; i++) {
    ruv[i * 2] = rp.getX(i);
    ruv[i * 2 + 1] = rp.getZ(i);
  }
  roof.setAttribute('uv', new THREE.BufferAttribute(ruv, 2));
  for (const name of Object.keys(roof.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') roof.deleteAttribute(name);
  const net = mergeGeometries([walls, roof], false);
  walls.dispose();
  roof.dispose();
  net.computeBoundingSphere();
  return { boards, net };
}

/**
 * Tube along a polyline. `side` is a unit vector perpendicular to every segment (the plane normal
 * of a planar arch, or +y for a horizontal ring); the frames are built from it, so the tube never
 * twists. Miter-scaled joints keep the radius right at the bends. Returns an indexed geometry with
 * position and normal.
 */
export function sweepTube(path: readonly THREE.Vector3[], radius: number, radial: number, closed = false, side: THREE.Vector3 = new THREE.Vector3(0, 1, 0)): THREE.BufferGeometry {
  const n = path.length;
  const pos: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  const tan = new THREE.Vector3();
  const t0 = new THREE.Vector3();
  const t1 = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const bin = new THREE.Vector3();
  const rings = closed ? n + 1 : n;
  for (let i = 0; i < rings; i++) {
    const k = i % n;
    const prev = closed ? path[(k - 1 + n) % n] : path[Math.max(0, k - 1)];
    const next = closed ? path[(k + 1) % n] : path[Math.min(n - 1, k + 1)];
    t0.subVectors(path[k], prev);
    t1.subVectors(next, path[k]);
    if (t0.lengthSq() < 1e-6) t0.copy(t1);
    if (t1.lengthSq() < 1e-6) t1.copy(t0);
    t0.normalize();
    t1.normalize();
    tan.addVectors(t0, t1).normalize();
    const miter = 1 / Math.max(0.35, tan.dot(t1));
    bin.copy(side).addScaledVector(tan, -side.dot(tan)).normalize();
    nrm.crossVectors(tan, bin).normalize();
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      // Stretch along the in-plane normal by the miter so the joints keep their thickness.
      pos.push(
        path[k].x + (nrm.x * c * miter + bin.x * s) * radius,
        path[k].y + (nrm.y * c * miter + bin.y * s) * radius,
        path[k].z + (nrm.z * c * miter + bin.z * s) * radius,
      );
      nor.push(nrm.x * c + bin.x * s, nrm.y * c + bin.y * s, nrm.z * c + bin.z * s);
    }
  }
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j;
      const b = i * radial + ((j + 1) % radial);
      const c = (i + 1) * radial + j;
      const d = (i + 1) * radial + ((j + 1) % radial);
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

/**
 * Points of an arc in a vertical plane: centre (cx, cy, cz), horizontal unit direction (ux, uz),
 * radius r, from angle a0 to a1 (0 = horizontal along u, pi/2 = straight up).
 */
export function arcInPlane(cx: number, cy: number, cz: number, ux: number, uz: number, r: number, a0: number, a1: number, segs: number): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= segs; i++) {
    const a = a0 + ((a1 - a0) * i) / segs;
    pts.push(new THREE.Vector3(cx + ux * r * Math.cos(a), cy + r * Math.sin(a), cz + uz * r * Math.cos(a)));
  }
  return pts;
}

/**
 * The field outline grown by `off` (negative shrinks) at height y: straight walls and corner arcs
 * of `cornerSegs` chords round (+-cx, +-cz). A closed loop (the first point is not repeated).
 */
export function roundedOutline(off: number, y: number, cornerSegs: number): THREE.Vector3[] {
  const r = FIELD.cornerR + off;
  const pts: THREE.Vector3[] = [];
  const corner = (sx: number, sz: number, a0: number): void => {
    for (let i = 0; i <= cornerSegs; i++) {
      const a = a0 + ((Math.PI / 2) * i) / cornerSegs;
      pts.push(new THREE.Vector3(sx * FIELD.cx + r * Math.cos(a), y, sz * FIELD.cz + r * Math.sin(a)));
    }
  };
  corner(1, 1, 0);
  corner(-1, 1, Math.PI / 2);
  corner(-1, -1, Math.PI);
  corner(1, -1, Math.PI * 1.5);
  return pts;
}

/** Keep only position / normal (and uv with `keepUv`), non-indexed, so mergeGeometries accepts mixed sources. */
export function plain(g: THREE.BufferGeometry, keepUv = false): THREE.BufferGeometry {
  const out = g.index !== null ? g.toNonIndexed() : g;
  for (const name of Object.keys(out.attributes)) {
    if (name !== 'position' && name !== 'normal' && !(keepUv && name === 'uv')) out.deleteAttribute(name);
  }
  if (out.getAttribute('normal') === undefined) out.computeVertexNormals();
  return out;
}

/** Merge parts into one geometry (one draw call) and free the parts. */
export function mergeParts(parts: THREE.BufferGeometry[], keepUv = false): THREE.BufferGeometry {
  const flat = parts.map((p) => plain(p, keepUv));
  const merged = mergeGeometries(flat, false);
  for (const p of parts) p.dispose();
  for (const p of flat) p.dispose();
  merged.computeBoundingSphere();
  return merged;
}

/** Tiny deterministic PRNG (mulberry32) so every bake is identical. */
export function rng(seed = 1): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
