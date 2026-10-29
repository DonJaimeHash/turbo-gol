/**
 * The car body kit: what every procedural car body is built from (docs/cars.md).
 *
 *   surfaces   CAR_KIND (the shared material's surface kinds) and the stock Surfaces (trim,
 *              carbon, satin alloy, lamps, exhaust...), the team colours, the boost nozzles
 *   geometry   tag / tagBy (bake one Surface, or one per triangle, into `color` / `aMat`,
 *              non-indexed, no uv), mergeParts, section / loft (superellipse lofts), tube (a
 *              cylinder between two points)
 *   wheels     the tyre numbers the shader compiles, the placement ranges and resolveWheels (where
 *              a body's WheelPlacement puts the wheels: CarView draws them there, the kit reports it)
 *   bodies     createKit (the BodyKit a CarBodySpec.build receives: the design half extents, the
 *              nozzles, the wheels, the team surfaces, push / pushBy / box / fin / arch /
 *              wheelArch) and buildBody (build, merge, containment guard, translate to the car
 *              origin)
 *
 * Every part carries exactly the attributes position, normal, color, aMat (non-indexed): the
 * attribute layout is part of three's render-object cache key, so one more attribute, a uv or an
 * index would give every car a pipeline of its own. Car.ts (the material, the flame, CarView)
 * reads the shared constants from here. Pure geometry: no material, no renderer.
 */
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { CarConfigInfo, Team } from '../../sim/types';
import type { ArchOptions, BodyKit, CarBodySpec, CarDetail, Ring, Surface, SurfacePicker, WheelAt, WheelPlacement, WheelStyle } from './types';

/**
 * Surface kinds of the shared car material, stored per vertex in `aMat.w` (small integers, decoded
 * in TSL with `isKind`). The vertex colour, metalness and roughness are each kind's base values;
 * the material adds the kind's procedural detail on top. A new kind costs every car (every kind is
 * evaluated on every pixel): bodies reuse these.
 */
export const CAR_KIND = {
  /** Satin black plastic (light-bar housing). */
  TRIM: 0,
  /**
   * Team paint: metallic flakes under a deep clearcoat, plus the body's livery (LiverySpec: gloss
   * carbon below the two-tone line, lime pinstripe on it, white nose chevrons, two panel seams)
   * and grime low down.
   */
  PAINT: 1,
  /** Gloss carbon fibre (engine cover): a 2x2 twill under clearcoat. */
  CARBON: 2,
  /** Dark tinted canopy glass: a dielectric with a mirror clearcoat. */
  GLASS: 3,
  /** Polished chrome (wheel bolts). */
  CHROME: 4,
  /** Satin light alloy (roll hoop, braces, nerf bar) with a fine brushed roughness variation. */
  ALLOY: 5,
  /** Dark anodised metal (rim barrel, spokes, dish, thruster throats). */
  DARK_METAL: 6,
  /** Tyre rubber: knob sipes, sidewall ribs and a raised lettering band (relief), worn crown, dust. */
  TYRE: 7,
  /** HDR lamp (headlights, tail-light rings, team light strips): emission with a lens falloff. */
  LAMP: 8,
  /** Team-painted hub cap: flake paint and clearcoat without the livery. */
  HUB: 9,
  /**
   * Thruster housing: polished metal with a heat tint (straw to blue) toward the exit. Only the two
   * boost thrusters (the tint runs from their exit plane, the test finds them by it): side pipes
   * and stacks are ALLOY, CHROME or DARK_METAL.
   */
  EXHAUST: 10,
  /** Beadlock ring: machined alloy with fine concentric turning marks. */
  BEAD: 11,
} as const;
export type CarKind = (typeof CAR_KIND)[keyof typeof CAR_KIND];

/**
 * Team paint (sRGB hex), indexed by Team (0 blue, 1 red). The blue is the lighter of the two
 * (lit paint L* ~57 vs ~44) so the teams also separate by lightness for colour-blind players.
 */
export const TEAM_PAINT: readonly [number, number] = [0x2a86f0, 0xc8152f];
/** Brighter team tint for flames, light strips, trails and explosions, indexed by Team. */
export const TEAM_GLOW: readonly [number, number] = [0x56b0ff, 0xff3d55];
/** Canopy glass, a dark team tint. */
export const TEAM_GLASS: readonly [number, number] = [0x081426, 0x22080e];

/**
 * Boost nozzles in car-local three.js coordinates (x forward, y up, z right) for the default
 * hitbox: the twin thrusters sit at (x, y, +-z). Effects.ts emits the boost trails from here and
 * the flame's jets are compiled at +-BOOST_NOZZLE_Z: every body puts its thrusters here.
 */
export const BOOST_NOZZLE_X = -44.3;
export const BOOST_NOZZLE_Y = 19.75;
export const BOOST_NOZZLE_Z = 8;

/** Base-coat metalness and roughness of team paint (the vertex values; the material reads them too). */
export const PAINT_METAL = 0.22;
export const PAINT_ROUGH = 0.34;

export const TRIM: Surface = { color: 0x14161a, metal: 0.1, rough: 0.55, emissive: 0, kind: CAR_KIND.TRIM };
export const CARBON: Surface = { color: 0x16181d, metal: 0.2, rough: 0.32, emissive: 0, kind: CAR_KIND.CARBON };
// Satin rather than mirror: a fully metallic hoop mirrors the dark night sky and loses the white
// roll hoop that is part of the car's silhouette.
export const CAGE: Surface = { color: 0xdfe3ea, metal: 0.7, rough: 0.3, emissive: 0, kind: CAR_KIND.ALLOY };
export const HEADLIGHT: Surface = { color: 0xf4f7ff, metal: 0, rough: 0.12, emissive: 3.0, kind: CAR_KIND.LAMP };
export const TAILLIGHT: Surface = { color: 0xff2a1e, metal: 0, rough: 0.12, emissive: 1.8, kind: CAR_KIND.LAMP };
export const TYRE: Surface = { color: 0x0c0e11, metal: 0, rough: 0.88, emissive: 0, kind: CAR_KIND.TYRE };
export const BOLT: Surface = { color: 0xc9ced6, metal: 1, rough: 0.16, emissive: 0, kind: CAR_KIND.CHROME };
// Gunmetal, not mirror chrome: fully metallic parts mirrored the red crowd tiers and read pink.
export const EXHAUST: Surface = { color: 0xaab0b8, metal: 0.8, rough: 0.24, emissive: 0, kind: CAR_KIND.EXHAUST };
export const RIM_DARK: Surface = { color: 0x2a2f37, metal: 0.75, rough: 0.34, emissive: 0, kind: CAR_KIND.DARK_METAL };
export const BEAD: Surface = { color: 0xd3d8e0, metal: 0.7, rough: 0.3, emissive: 0, kind: CAR_KIND.BEAD };
export const DISC: Surface = { color: 0x1b1e24, metal: 0.5, rough: 0.5, emissive: 0, kind: CAR_KIND.DARK_METAL };

export const TWO_PI = Math.PI * 2;
/** Height of the car origin above the floor at rest (RocketSim CAR_SPAWN_REST_Z), any preset. */
export const CAR_REST_Z = 17;
/** The visible body stays this far inside the physics hitbox (uu), on every axis. */
export const HITBOX_MARGIN = 1.5;
/** Wheel (tyre) width in uu: compiled into the tyre shader (the sipe rule). */
export const WHEEL_WIDTH = 18;
/** Rim radius in tyre-radius units (the sidewall runs from here to the tread): compiled in. */
export const RIM_R = 0.66;
/** Tyre carcass radius in tyre-radius units; knobs stand out to 1. Compiled in. */
export const TREAD_R = 0.93;
/**
 * The shader paints knob tops (sipes, the scuffed crown) where the unit-wheel radius is at least
 * this: a slick tyre's tread stays below it (SLICK_R).
 */
export const CROWN_R = 0.985;
/**
 * A slick's tread radius (tyre-radius units): below CROWN_R, so the shader paints no knob sipes on
 * it (they would sit on a smooth tread), close enough to 1 that the tyre keeps its size.
 */
export const SLICK_R = 0.975;
/** Tread knobs around the tyre per geometry detail, and their width (tyre-radius units). Compiled in. */
export const KNOBS_HIGH = 16;
export const KNOBS_LOW = 12;
export const KNOB_WIDTH = 0.24;

/**
 * Triangle budgets per geometry detail (docs/cars.md; the per-tier frame budgets behind them): a
 * body (CarBodySpec.budget) or a wheel style (WheelStyle.budget) declares its own, aiming for the
 * target (the dune runner's size: a body or style above it says why in its module), never above
 * the hard cap (tests/car-bodies.test.mjs refuses it). The wheel geometry is drawn 4 times a car.
 */
export const BODY_TRIS_TARGET: Readonly<Record<CarDetail, number>> = { low: 2000, high: 3500 };
export const BODY_TRIS_CAP: Readonly<Record<CarDetail, number>> = { low: 2400, high: 4200 };
export const WHEEL_TRIS_TARGET: Readonly<Record<CarDetail, number>> = { low: 440, high: 820 };
export const WHEEL_TRIS_CAP: Readonly<Record<CarDetail, number>> = { low: 500, high: 900 };

/** WheelPlacement.visual's range: visual tyre radius over the physics radius (the dune runner: 1.1). */
export const WHEEL_VISUAL_RANGE: readonly [number, number] = [0.8, 1.3];
/** WheelPlacement.width's range: tyre width over WHEEL_WIDTH, the instances' z scale (the dune runner: 1). */
export const WHEEL_WIDTH_RANGE: readonly [number, number] = [0.8, 1.4];
/** The outer tyre face stays this far inside the hitbox's side (uu). */
const WHEEL_SIDE_INSET = 2.5;
/** wheelArch's band: from this far inside the tyre's inner face to this far past its outer face (uu). */
const ARCH_OVERLAP_IN = 1;
const ARCH_OVERLAP_OUT = 2.6;

// ---- scratch -------------------------------------------------------------------------------
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _col = new THREE.Color();

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Bake one Surface into `color` / `aMat` attributes, converting to non-indexed so parts can be
 * merged. The car material reads no uv, so it is dropped (every merged part then carries the same
 * attribute set: position, normal, color, aMat).
 */
export function tag(src: THREE.BufferGeometry, s: Surface): THREE.BufferGeometry {
  let g = src;
  if (src.index !== null) {
    g = src.toNonIndexed();
    src.dispose();
  }
  if (g.getAttribute('uv') !== undefined) g.deleteAttribute('uv');
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  const mat = new Float32Array(n * 4);
  _col.setHex(s.color); // sRGB hex -> linear working colour space
  for (let v = 0; v < n; v++) {
    col[v * 3] = _col.r;
    col[v * 3 + 1] = _col.g;
    col[v * 3 + 2] = _col.b;
    mat[v * 4] = s.metal;
    mat[v * 4 + 1] = s.rough;
    mat[v * 4 + 2] = s.emissive;
    mat[v * 4 + 3] = s.kind;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aMat', new THREE.BufferAttribute(mat, 4));
  return g;
}

/**
 * tag with a Surface per triangle: `pick` gets each triangle's centre and unit face normal (in the
 * geometry's own frame, the build frame for body parts) and returns its surface. The kind is
 * constant over a triangle (aMat.w is interpolated: a triangle spanning two kinds would decode as
 * neither), so a band follows the part's triangle edges: put loft rings where it should start.
 */
export function tagBy(src: THREE.BufferGeometry, pick: SurfacePicker): THREE.BufferGeometry {
  let g = src;
  if (src.index !== null) {
    g = src.toNonIndexed();
    src.dispose();
  }
  if (g.getAttribute('uv') !== undefined) g.deleteAttribute('uv');
  const p = g.attributes.position.array;
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  const mat = new Float32Array(n * 4);
  for (let t = 0; t + 2 < n; t += 3) {
    const a = t * 3;
    const ux = p[a + 3] - p[a];
    const uy = p[a + 4] - p[a + 1];
    const uz = p[a + 5] - p[a + 2];
    const vx = p[a + 6] - p[a];
    const vy = p[a + 7] - p[a + 1];
    const vz = p[a + 8] - p[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; // a degenerate triangle picks with a zero normal
    const s = pick((p[a] + p[a + 3] + p[a + 6]) / 3, (p[a + 1] + p[a + 4] + p[a + 7]) / 3, (p[a + 2] + p[a + 5] + p[a + 8]) / 3, nx / l, ny / l, nz / l);
    _col.setHex(s.color); // sRGB hex -> linear working colour space
    for (let v = t; v < t + 3; v++) {
      col[v * 3] = _col.r;
      col[v * 3 + 1] = _col.g;
      col[v * 3 + 2] = _col.b;
      mat[v * 4] = s.metal;
      mat[v * 4 + 1] = s.rough;
      mat[v * 4 + 2] = s.emissive;
      mat[v * 4 + 3] = s.kind;
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aMat', new THREE.BufferAttribute(mat, 4));
  return g;
}

/** Merge tagged parts in order (the order is the vertex order) and dispose of them. */
export function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return merged;
}

/** A body section across the car at `x`: half width `w` about `zc`, from `y0` up to `y1`. */
export function section(x: number, w: number, y0: number, y1: number, zc = 0): Ring {
  return { o: [x, (y0 + y1) * 0.5, zc], u: [0, 0, 1], v: [0, 1, 0], hu: w, hv: (y1 - y0) * 0.5 };
}

/** The unit superellipse of exponent `n` sampled at `seg` points (loft): its u and v coordinates. */
function superellipse(seg: number, n: number): readonly [Float64Array, Float64Array] {
  const e = 2 / n;
  const cu = new Float64Array(seg);
  const cv = new Float64Array(seg);
  for (let j = 0; j < seg; j++) {
    const a = (j / seg) * TWO_PI;
    const c = Math.cos(a);
    const s = Math.sin(a);
    cu[j] = Math.sign(c) * Math.pow(Math.abs(c), e);
    cv[j] = Math.sign(s) * Math.pow(Math.abs(s), e);
  }
  return [cu, cv];
}

/**
 * Smooth lofted solid: a superellipse ring per section (exponent `n`: 2 = ellipse, larger =
 * boxier, `seg` points; a ring's own `n` / `hvNeg` override it), consecutive rings stitched into
 * quads, both ends closed by a flat fan on their own vertices (a crisp end edge). The sides share
 * ring vertices, so computeVertexNormals() shades them smoothly. Winding is chosen so the faces
 * point outwards whichever way the rings progress. Consecutive rings must not coincide and no
 * ring may be zero-sized (a zero-area quad has no normal: NaN in the shader): taper a point to
 * at least 0.3 uu.
 */
export function loft(rings: readonly Ring[], seg: number, n: number): THREE.BufferGeometry {
  const [cu, cv] = superellipse(seg, n);
  const pos: number[] = [];
  const idx: number[] = [];
  const ringPoints = (r: Ring): void => {
    const [ru, rv] = r.n !== undefined ? superellipse(seg, r.n) : [cu, cv];
    for (let j = 0; j < seg; j++) {
      const a = ru[j] * r.hu;
      const b = rv[j] * (rv[j] < 0 && r.hvNeg !== undefined ? r.hvNeg : r.hv);
      pos.push(r.o[0] + r.u[0] * a + r.v[0] * b, r.o[1] + r.u[1] * a + r.v[1] * b, r.o[2] + r.u[2] * a + r.v[2] * b);
    }
  };
  for (const r of rings) ringPoints(r);
  // (a, c, b) faces outwards when u . ((o1 - o0) x v) > 0: the ring turns from +u towards +v.
  const r0 = rings[0];
  const r1 = rings[1];
  const px = r1.o[0] - r0.o[0];
  const py = r1.o[1] - r0.o[1];
  const pz = r1.o[2] - r0.o[2];
  const [vx, vy, vz] = r0.v;
  const flip = r0.u[0] * (py * vz - pz * vy) + r0.u[1] * (pz * vx - px * vz) + r0.u[2] * (px * vy - py * vx) < 0;
  const tri = (a: number, b: number, c: number): void => {
    if (flip) idx.push(a, c, b);
    else idx.push(a, b, c);
  };
  for (let i = 0; i + 1 < rings.length; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * seg + j;
      const b = i * seg + ((j + 1) % seg);
      const c = (i + 1) * seg + j;
      const d = (i + 1) * seg + ((j + 1) % seg);
      tri(a, c, b);
      tri(b, c, d);
    }
  }
  const cap = (r: Ring, last: boolean): void => {
    const first = pos.length / 3;
    ringPoints(r);
    const centre = pos.length / 3;
    pos.push(r.o[0], r.o[1], r.o[2]);
    for (let j = 0; j < seg; j++) {
      const a = first + j;
      const b = first + ((j + 1) % seg);
      if (last) tri(centre, b, a);
      else tri(centre, a, b);
    }
  };
  cap(rings[0], false);
  cap(rings[rings.length - 1], true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Cylinder of radius `r` from point a to point b (axis along a -> b). */
export function tube(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, seg: number): THREE.BufferGeometry {
  _v.set(bx - ax, by - ay, bz - az);
  const len = _v.length();
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1, false);
  _q.setFromUnitVectors(_s.set(0, 1, 0), _v.multiplyScalar(1 / len));
  _m.compose(_s.set((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5), _q, _v.set(1, 1, 1));
  g.applyMatrix4(_m);
  return g;
}

// ---- wheel placement ------------------------------------------------------------------------

/** The style's outer tyre radius in tyre-radius units: CarView keeps this on the floor. */
export function tyreRadius(style: WheelStyle): number {
  return style.tyre === 'slick' ? SLICK_R : 1;
}

/** The widest WheelPlacement.outer on hitbox `cfg` (uu from the centre line; 40.85 on Standard). */
export function wheelOuterMax(cfg: CarConfigInfo): number {
  return cfg.hitboxSize[1] * 0.5 - WHEEL_SIDE_INSET;
}

/** One axle's wheels resolved on a hitbox (resolveWheels). */
export interface AxleWheels {
  /** Visual radius over the physics radius and width over WHEEL_WIDTH, within their ranges. */
  readonly visual: number;
  readonly width: number;
  /** The style's outer tyre radius, unit wheel (tyreRadius). */
  readonly tyreR: number;
  /** Outward offset of the wheel centre from the physics hardpoint (uu; negative moves it in: a wide tyre keeps its outer face). */
  readonly track: number;
  /** The wheel at rest in the build frame (BodyKit.wheels). */
  readonly at: WheelAt;
}

/** `v` within [lo, hi]; `fallback` when it is not a number (a NaN scale would hide the wheels). */
function within(v: number, [lo, hi]: readonly [number, number], fallback: number): number {
  return Number.isFinite(v) ? clamp(v, lo, hi) : fallback;
}

function resolveAxle(cfg: CarConfigInfo, w: WheelPlacement, front: boolean): AxleWheels {
  const r = front ? undefined : w.rear;
  const visual = within(r?.visual ?? w.visual, WHEEL_VISUAL_RANGE, 1);
  const width = within(r?.width ?? w.width ?? 1, WHEEL_WIDTH_RANGE, 1);
  const outer = Math.min(r?.outer ?? w.outer, wheelOuterMax(cfg));
  const hp = front ? cfg.frontWheelOffset : cfg.backWheelOffset;
  const half = WHEEL_WIDTH * width * 0.5;
  const track = outer - half - hp[1];
  const tyreR = tyreRadius(w.style);
  const radius = (front ? cfg.frontWheelRadius : cfg.backWheelRadius) * visual * tyreR;
  const zOut = hp[1] + track + half;
  // The centre at rest sits the outer radius over the floor (CarView.composeWheel); the sim's
  // hardpoint is (x forward, y right, z up), the hitbox offset likewise.
  const at: WheelAt = { x: hp[0] - cfg.hitboxOffset[0], y: radius - CAR_REST_Z - cfg.hitboxOffset[2], radius, zIn: zOut - 2 * half, zOut };
  return { visual, width, tyreR, track, at };
}

/**
 * Where WheelPlacement `w` puts the wheels on hitbox `cfg`, per axle: what CarView draws (the
 * instance matrices) and what BodyKit.wheels tells the body, from one place, so arches, fenders
 * and pods follow the wheels drawn. Out-of-range numbers are clamped (the tests require none).
 */
export function resolveWheels(cfg: CarConfigInfo, w: WheelPlacement): { readonly front: AxleWheels; readonly back: AxleWheels } {
  return { front: resolveAxle(cfg, w, true), back: resolveAxle(cfg, w, false) };
}

// ---- bodies ---------------------------------------------------------------------------------

/** A BodyKit plus the parts it collects (buildBody merges them). */
interface KitBuild {
  readonly kit: BodyKit;
  readonly parts: THREE.BufferGeometry[];
}

/**
 * The kit a body is built with, for hitbox `cfg`, `team`, geometry `detail` and the body's wheel
 * placement: hitbox-centred design coordinates (the default hitbox gives hl 58.75, hh 17.83, hw
 * 41.85), the nozzles and wheels in them, the team surfaces, and the part helpers. The surfaces
 * and the dune runner's helpers (push, box, arch) are as they always were.
 */
function createKit(cfg: CarConfigInfo, team: Team, detail: CarDetail, wheels: WheelPlacement): KitBuild {
  const parts: THREE.BufferGeometry[] = [];
  const hi = detail === 'high';
  const L = cfg.hitboxSize[0];
  const W = cfg.hitboxSize[1];
  const H = cfg.hitboxSize[2];
  // The hitbox centre in three's axes: the sim's offset is (x forward, y right, z up).
  const ox = cfg.hitboxOffset[0];
  const oy = cfg.hitboxOffset[2];
  const oz = cfg.hitboxOffset[1];
  const hl = L * 0.5 - HITBOX_MARGIN;
  const hh = H * 0.5 - HITBOX_MARGIN;
  const hw = W * 0.5 - HITBOX_MARGIN;
  const paint: Surface = { color: TEAM_PAINT[team], metal: PAINT_METAL, rough: PAINT_ROUGH, emissive: 0, kind: CAR_KIND.PAINT };
  const glass: Surface = { color: TEAM_GLASS[team], metal: 0, rough: 0.05, emissive: 0, kind: CAR_KIND.GLASS };
  const strip: Surface = { color: TEAM_GLOW[team], metal: 0, rough: 0.2, emissive: 1.4, kind: CAR_KIND.LAMP };

  const resolved = resolveWheels(cfg, wheels);
  const push = (g: THREE.BufferGeometry, s: Surface): void => {
    parts.push(tag(g, s));
  };
  const pushBy = (g: THREE.BufferGeometry, pick: SurfacePicker): void => {
    parts.push(tagBy(g, pick));
  };
  const box = (s: Surface, sx: number, sy: number, sz: number, x: number, y: number, z: number): void => {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    g.translate(x, y, z);
    parts.push(tag(g, s));
  };
  const fin = (s: Surface, profile: readonly (readonly [number, number])[], thickness: number, plane: 'xy' | 'xz' = 'xy', at = 0): void => {
    const shape = new THREE.Shape(profile.map(([a, b]) => new THREE.Vector2(a, b)));
    const g = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 1 });
    if (plane === 'xy') {
      g.translate(0, 0, at - thickness * 0.5);
    } else {
      g.rotateX(Math.PI / 2); // (x, y, depth) -> (x, -depth, y): the profile's second axis becomes z
      g.translate(0, at + thickness * 0.5, 0);
    }
    parts.push(tag(g, s));
  };
  // A rounded band swept around a wheel's rest position (centre `wx`, `cy`, outer radius `rv`), one
  // per side between |z| `zIn` and `zOut`, its ends cut where they would leave the hitbox (floor,
  // nose, tail).
  const sweepArch = (wx: number, rv: number, cy: number, archZIn: number, archZOut: number, o: ArchOptions): void => {
    const archHu = (archZOut - archZIn) * 0.5;
    const rIn = rv + (o.gap ?? 1.75);
    const rOut = Math.min(rIn + (o.thickness ?? 3), hh - cy);
    if (rOut - rIn < 1) return;
    const rm = (rIn + rOut) * 0.5;
    const hv = (rOut - rIn) * 0.5;
    const low = Math.asin(clamp((-hh + 0.3 - cy) / rIn, -1, 1));
    let a0 = Math.max(low, 0.17);
    let a1 = Math.PI - a0;
    const front = (hl - wx) / rOut; // the outer edge must stay behind the nose...
    if (front < 1) a0 = Math.max(a0, Math.acos(Math.max(-1, front)));
    const rear = (-hl - wx) / rOut; // ...and in front of the tail
    if (rear > -1) a1 = Math.min(a1, Math.acos(Math.min(1, rear)));
    if (a1 - a0 < 0.3) return;
    const steps = hi ? 10 : 7;
    for (const side of [-1, 1]) {
      const zc = side * (archZIn + archHu);
      const rings: Ring[] = [];
      for (let i = 0; i <= steps; i++) {
        const a = a0 + ((a1 - a0) * i) / steps;
        const c = Math.cos(a);
        const s = Math.sin(a);
        rings.push({ o: [wx + rm * c, cy + rm * s, zc], u: [0, 0, 1], v: [c, s, 0], hu: archHu, hv });
      }
      parts.push(tag(loft(rings, hi ? 12 : 8, o.exponent ?? 4), o.surface ?? paint));
    }
  };
  // The dune runner's form: centre `rv` over the floor (its knobby tyre's outer radius), band 20..hw - 0.25.
  const arch = (wx: number, rv: number, o: ArchOptions = {}): void => {
    sweepArch(wx, rv, rv - CAR_REST_Z - oy, o.zIn ?? 20, o.zOut ?? hw - 0.25, o);
  };
  // Over a resolved wheel (k.wheels.front / back): its radius and centre, the band round its tyre.
  const wheelArch = (w: WheelAt, o: ArchOptions = {}): void => {
    sweepArch(w.x, w.radius, w.y, o.zIn ?? w.zIn - ARCH_OVERLAP_IN, o.zOut ?? Math.min(hw - 0.25, w.zOut + ARCH_OVERLAP_OUT), o);
  };
  const nozzle = { x: -hl + 0.75, y: BOOST_NOZZLE_Y - oy, z: BOOST_NOZZLE_Z };
  const kit: BodyKit = {
    hi,
    cfg,
    team,
    hl,
    hh,
    hw,
    ox,
    oy,
    oz,
    nozzle,
    wheels: { front: resolved.front.at, back: resolved.back.at },
    paint,
    glass,
    strip,
    push,
    pushBy,
    box,
    fin,
    arch,
    wheelArch,
  };
  return { kit, parts };
}

/**
 * Build `spec`'s body for hitbox `cfg`, `team` and geometry `detail`: the spec's parts in
 * hitbox-centred coordinates, merged, then translated to the car origin. A final guard squeezes
 * the body into the hitbox (minus HITBOX_MARGIN) should a preset ever be smaller than the design;
 * a squeeze is recorded in `userData.squeeze` (the tests require none on the default hitbox).
 */
export function buildBody(spec: CarBodySpec, cfg: CarConfigInfo, team: Team, detail: CarDetail): THREE.BufferGeometry {
  const { kit, parts } = createKit(cfg, team, detail, spec.wheels);
  spec.build(kit);
  const merged = mergeParts(parts);
  // Containment guard: squeeze any axis that would leave the hitbox (no-op on the default one).
  merged.computeBoundingBox();
  const bb = merged.boundingBox as THREE.Box3;
  const kx = Math.min(1, kit.hl / Math.max(-bb.min.x, bb.max.x));
  const ky = Math.min(1, kit.hh / Math.max(-bb.min.y, bb.max.y));
  const kz = Math.min(1, kit.hw / Math.max(-bb.min.z, bb.max.z));
  if (kx < 0.999 || ky < 0.999 || kz < 0.999) {
    if (import.meta.env?.DEV) console.warn(`[car-body] ${spec.id} exceeds the hitbox, squeezed by (${kx.toFixed(3)}, ${ky.toFixed(3)}, ${kz.toFixed(3)})`);
    merged.scale(kx, ky, kz);
    merged.userData.squeeze = [kx, ky, kz];
  }
  merged.translate(kit.ox, kit.oy, kit.oz);
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  if (import.meta.env?.DEV) assertUnitNormals(merged, `car-body ${spec.id}`);
  return merged;
}

/**
 * Dev-only check (runs once per geometry build): every normal must be unit length. A zero normal
 * would be normalised to NaN in the fragment shader (shading sparkles; on the flame, a NaN in the
 * bloom).
 */
export function assertUnitNormals(g: THREE.BufferGeometry, name: string): void {
  const n = g.getAttribute('normal');
  if (n === undefined) {
    console.warn(`[${name}] geometry has no normal attribute`);
    return;
  }
  for (let i = 0; i < n.count; i++) {
    const x = n.getX(i);
    const y = n.getY(i);
    const z = n.getZ(i);
    const l2 = x * x + y * y + z * z;
    if (!(l2 > 0.9 && l2 < 1.1)) {
      console.warn(`[${name}] degenerate normal at vertex ${i}: (${x}, ${y}, ${z})`);
      return;
    }
  }
}
