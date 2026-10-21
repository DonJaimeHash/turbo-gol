/**
 * Geometry builder for the backdrop: every solid of a skyline (land, containers, cranes, ship,
 * lighthouse, far city, rock) is appended to ONE merged world-space BufferGeometry drawn with ONE
 * material, so a skyline is one draw call and one pipeline. Per vertex it carries what the shader
 * needs to draw patterns without textures (see bakeMaterials.ts):
 *
 *   kcol (vec4)  albedo rgb (emission rgb for lamps) + kind (pattern id, see KIND)
 *   kloc (vec3)  the vertex position in the PART's own frame (box-local, centred), in uu
 *   kdat (vec4)  the part's half-size (x, y, z) + a random seed in [0, 1)
 *
 * A builder made with `dry = true` only counts: the generators run in that mode to collect their
 * lamps (for the light map) without paying for geometry they do not need.
 */
import * as THREE from 'three/webgpu';

/** Pattern ids (kcol.w) read by the structure material. */
export const KIND = {
  STEEL: 0,
  CONTAINER: 1,
  WINDOWS: 2,
  LIGHTHOUSE: 3,
  LAMP: 4,
  HULL: 5,
  GROUND: 6,
  ROCK: 7,
  FARCITY: 8,
  STRATA: 9,
} as const;
export type Kind = (typeof KIND)[keyof typeof KIND];

export type Vec3 = readonly [number, number, number];

/** A point lamp of a skyline (light map input, see lightmap.ts). `down` = 1 for a lamp aimed at the ground. */
export interface Lamp {
  readonly pos: Vec3;
  readonly range: number;
  readonly color: Vec3;
  readonly down: number;
}

/** Small deterministic PRNG (mulberry32) so every build produces the same skyline. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Unit box template: 6 faces x 4 corners at +-1, outward normals, CCW winding. */
const BOX = (() => {
  const g = new THREE.BoxGeometry(2, 2, 2);
  const r = {
    pos: Float32Array.from(g.attributes.position.array as ArrayLike<number>),
    nrm: Float32Array.from(g.attributes.normal.array as ArrayLike<number>),
    idx: Uint32Array.from((g.index as THREE.BufferAttribute).array as ArrayLike<number>),
  };
  g.dispose();
  return r;
})();

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _n = new THREE.Matrix3();
const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();
const _side = new THREE.Vector3();
const _up2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3(0, 1, 0);
const _lp = new Float32Array(BOX.pos.length);

/** A growable typed array. */
class Grow<T extends Float32Array | Uint32Array> {
  a: T;
  n = 0;
  constructor(a: T) {
    this.a = a;
  }
  reserve(k: number): void {
    if (this.n + k <= this.a.length) return;
    let cap = this.a.length * 2;
    while (cap < this.n + k) cap *= 2;
    const b = new (this.a.constructor as new (n: number) => T)(cap);
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }
}

export class GeoBuilder {
  /** Vertices and parts appended so far (also counted in dry mode). */
  verts = 0;
  parts = 0;
  private readonly dry: boolean;
  private readonly pos: Grow<Float32Array>;
  private readonly nrm: Grow<Float32Array>;
  private readonly col: Grow<Float32Array>;
  private readonly loc: Grow<Float32Array>;
  private readonly dat: Grow<Float32Array>;
  private readonly idx: Grow<Uint32Array>;

  /** `dry`: count only. `capacity`: expected vertex count (the arrays grow past it). */
  constructor(dry = false, capacity = 1 << 16) {
    this.dry = dry;
    const n = dry ? 1 : capacity;
    this.pos = new Grow(new Float32Array(n * 3));
    this.nrm = new Grow(new Float32Array(n * 3));
    this.col = new Grow(new Float32Array(n * 4));
    this.loc = new Grow(new Float32Array(n * 3));
    this.dat = new Grow(new Float32Array(n * 4));
    this.idx = new Grow(new Uint32Array(n * 6));
  }

  /** Append local-space vertices transformed by `m`; kloc keeps the local position. */
  private append(lp: ArrayLike<number>, ln: ArrayLike<number>, li: ArrayLike<number>, m: THREE.Matrix4, rgb: Vec3, kind: number, hx: number, hy: number, hz: number, seed: number): void {
    const nv = lp.length / 3;
    this.parts++;
    if (this.dry) {
      this.verts += nv;
      return;
    }
    const pos = this.pos;
    const nrm = this.nrm;
    const loc = this.loc;
    const col = this.col;
    const dat = this.dat;
    pos.reserve(nv * 3);
    nrm.reserve(nv * 3);
    loc.reserve(nv * 3);
    col.reserve(nv * 4);
    dat.reserve(nv * 4);
    this.idx.reserve(li.length);
    // affine transform and normal matrix inlined (this loop runs for every backdrop vertex)
    const e = m.elements;
    const ne = _n.getNormalMatrix(m).elements;
    const pa = pos.a;
    const na = nrm.a;
    for (let i = 0; i < nv; i++) {
      const x = lp[i * 3];
      const y = lp[i * 3 + 1];
      const z = lp[i * 3 + 2];
      pa[pos.n++] = e[0] * x + e[4] * y + e[8] * z + e[12];
      pa[pos.n++] = e[1] * x + e[5] * y + e[9] * z + e[13];
      pa[pos.n++] = e[2] * x + e[6] * y + e[10] * z + e[14];
      const a = ln[i * 3];
      const b = ln[i * 3 + 1];
      const c = ln[i * 3 + 2];
      const nx = ne[0] * a + ne[3] * b + ne[6] * c;
      const ny = ne[1] * a + ne[4] * b + ne[7] * c;
      const nz = ne[2] * a + ne[5] * b + ne[8] * c;
      const inv = 1 / Math.max(Math.sqrt(nx * nx + ny * ny + nz * nz), 1e-12);
      na[nrm.n++] = nx * inv;
      na[nrm.n++] = ny * inv;
      na[nrm.n++] = nz * inv;
      loc.a[loc.n++] = x;
      loc.a[loc.n++] = y;
      loc.a[loc.n++] = z;
      col.a[col.n++] = rgb[0];
      col.a[col.n++] = rgb[1];
      col.a[col.n++] = rgb[2];
      col.a[col.n++] = kind;
      dat.a[dat.n++] = hx;
      dat.a[dat.n++] = hy;
      dat.a[dat.n++] = hz;
      dat.a[dat.n++] = seed;
    }
    const idx = this.idx;
    for (let i = 0; i < li.length; i++) idx.a[idx.n++] = li[i] + this.verts;
    this.verts += nv;
  }

  /** Box of half-size (hx, hy, hz) placed by matrix `m` (centre + orientation + scale). */
  box(m: THREE.Matrix4, hx: number, hy: number, hz: number, rgb: Vec3, kind: number, seed: number): void {
    for (let i = 0; i < BOX.pos.length; i += 3) {
      _lp[i] = BOX.pos[i] * hx;
      _lp[i + 1] = BOX.pos[i + 1] * hy;
      _lp[i + 2] = BOX.pos[i + 2] * hz;
    }
    this.append(_lp, BOX.nrm, BOX.idx, m, rgb, kind, hx, hy, hz, seed);
  }

  /** Axis-aligned box (optionally turned by `yaw` radians about y) centred at (cx, cy, cz). */
  boxAt(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, rgb: Vec3, kind: number, seed: number, yaw = 0): void {
    _q.setFromAxisAngle(_up, yaw);
    _m.compose(_v.set(cx, cy, cz), _q, _s);
    this.box(_m, hx, hy, hz, rgb, kind, seed);
  }

  /** Square-section beam of width `w` from world point a to world point b. */
  beam(a: Vec3, b: Vec3, w: number, rgb: Vec3, kind: number, seed: number): void {
    _a.set(a[0], a[1], a[2]);
    _b.set(b[0], b[1], b[2]);
    const len = _a.distanceTo(_b);
    if (len < 1e-3) return;
    _d.copy(_b).sub(_a).divideScalar(len);
    _q.setFromUnitVectors(_up, _d);
    _m.compose(_a.add(_b).multiplyScalar(0.5), _q, _s);
    this.box(_m, w / 2, len / 2, w / 2, rgb, kind, seed);
  }

  /**
   * Rectangular beam from a to b with a (wx sideways) x (wy "up") cross-section; `up` orients the
   * section (world up by default), e.g. a girder that stays upright when the boom is raised.
   */
  slab(a: Vec3, b: Vec3, wx: number, wy: number, rgb: Vec3, kind: number, seed: number, up: Vec3 = [0, 1, 0]): void {
    _a.set(a[0], a[1], a[2]);
    _b.set(b[0], b[1], b[2]);
    const len = _a.distanceTo(_b);
    if (len < 1e-3) return;
    _d.copy(_b).sub(_a).divideScalar(len);
    // right-handed basis (side x up2 = dir) so the box keeps its outward winding
    _side.crossVectors(_v.set(up[0], up[1], up[2]), _d);
    if (_side.lengthSq() < 1e-6) _side.set(1, 0, 0);
    _side.normalize();
    _up2.crossVectors(_d, _side).normalize();
    _m.makeBasis(_side, _up2, _d);
    _m.setPosition(_a.add(_b).multiplyScalar(0.5));
    this.box(_m, wx / 2, wy / 2, len / 2, rgb, kind, seed);
  }

  /** Any BufferGeometry given in its local frame, placed by `m`; kloc is centred on its bounding box. */
  geometry(geo: THREE.BufferGeometry, m: THREE.Matrix4, rgb: Vec3, kind: number, seed: number): void {
    if (!geo.attributes.normal) geo.computeVertexNormals();
    const p = geo.attributes.position.array as ArrayLike<number>;
    const nn = geo.attributes.normal.array as ArrayLike<number>;
    const nv = p.length / 3;
    const idx = geo.index ? (geo.index.array as ArrayLike<number>) : Uint32Array.from({ length: nv }, (_, i) => i);
    geo.computeBoundingBox();
    const bb = geo.boundingBox as THREE.Box3;
    const cx = (bb.min.x + bb.max.x) / 2;
    const cy = (bb.min.y + bb.max.y) / 2;
    const cz = (bb.min.z + bb.max.z) / 2;
    const lp = new Float32Array(p.length);
    for (let i = 0; i < p.length; i += 3) {
      lp[i] = p[i] - cx;
      lp[i + 1] = p[i + 1] - cy;
      lp[i + 2] = p[i + 2] - cz;
    }
    _m2.copy(m).multiply(_m.makeTranslation(cx, cy, cz));
    this.append(lp, nn, idx, _m2, rgb, kind, (bb.max.x - bb.min.x) / 2, (bb.max.y - bb.min.y) / 2, (bb.max.z - bb.min.z) / 2, seed);
  }

  /** An up-facing quad at height y over [x0, x1] x [z0, z1] (kloc = world position). */
  quadUp(x0: number, z0: number, x1: number, z1: number, y: number, rgb: Vec3, kind: number, seed: number): void {
    const lp = [x0, y, z1, x1, y, z1, x1, y, z0, x0, y, z0];
    const ln = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0];
    this.append(lp, ln, [0, 1, 2, 0, 2, 3], _m.identity(), rgb, kind, (x1 - x0) / 2, 1, (z1 - z0) / 2, seed);
  }

  /**
   * A world-space mesh with per-vertex colours (rgb) and per-vertex kdat (xyzw, free for the
   * pattern: the canyon stores sun visibility / occlusion there). kloc = world position.
   */
  raw(pos: Float32Array, nrm: Float32Array, idx: Uint32Array, rgb: Float32Array, dat: Float32Array, kind: number): void {
    const nv = pos.length / 3;
    this.parts++;
    if (this.dry) {
      this.verts += nv;
      return;
    }
    this.pos.reserve(nv * 3);
    this.nrm.reserve(nv * 3);
    this.loc.reserve(nv * 3);
    this.col.reserve(nv * 4);
    this.dat.reserve(nv * 4);
    this.idx.reserve(idx.length);
    this.pos.a.set(pos, this.pos.n);
    this.pos.n += pos.length;
    this.nrm.a.set(nrm, this.nrm.n);
    this.nrm.n += nrm.length;
    this.loc.a.set(pos, this.loc.n);
    this.loc.n += pos.length;
    this.dat.a.set(dat, this.dat.n);
    this.dat.n += dat.length;
    const col = this.col;
    for (let i = 0; i < nv; i++) {
      col.a[col.n++] = rgb[i * 3];
      col.a[col.n++] = rgb[i * 3 + 1];
      col.a[col.n++] = rgb[i * 3 + 2];
      col.a[col.n++] = kind;
    }
    const out = this.idx;
    for (let i = 0; i < idx.length; i++) out.a[out.n++] = idx[i] + this.verts;
    this.verts += nv;
  }

  /**
   * The merged geometry (null in dry mode). `bounds` (centre + radius) skips three's bounding
   * sphere pass over every vertex; the backdrop meshes are never frustum culled anyway.
   */
  build(bounds: THREE.Sphere | null = null): THREE.BufferGeometry | null {
    if (this.dry) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.a.slice(0, this.pos.n), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nrm.a.slice(0, this.nrm.n), 3));
    g.setAttribute('kcol', new THREE.BufferAttribute(this.col.a.slice(0, this.col.n), 4));
    g.setAttribute('kloc', new THREE.BufferAttribute(this.loc.a.slice(0, this.loc.n), 3));
    g.setAttribute('kdat', new THREE.BufferAttribute(this.dat.a.slice(0, this.dat.n), 4));
    g.setIndex(new THREE.BufferAttribute(this.idx.a.slice(0, this.idx.n), 1));
    if (bounds !== null) g.boundingSphere = bounds.clone();
    else g.computeBoundingSphere();
    return g;
  }
}
