/**
 * Allocation-free vector helpers for the AI, on Float32Array(3) scratch objects, plus the small
 * driving model the bot uses to estimate what the car can do (turn radius, ground acceleration,
 * jump numbers). Pure TypeScript: no three, no DOM, runnable in node.
 *
 * Conventions follow src/sim/types.ts: sim units (uu, uu/s, rad/s), z up, car local +x forward /
 * +y right / +z up. Every function that returns a vector writes into its first `out` argument and
 * returns it, so hot loops never allocate. Only `vec3()` allocates (call it at construction time).
 */

export type Vec3 = Float32Array;

const EPS = 1e-6;

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  const v = new Float32Array(3);
  v[0] = x;
  v[1] = y;
  v[2] = z;
  return v;
}

export function v3set(out: Vec3, x: number, y: number, z: number): Vec3 {
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}

export function v3copy(out: Vec3, a: Vec3): Vec3 {
  out[0] = a[0];
  out[1] = a[1];
  out[2] = a[2];
  return out;
}

/** Read 3 floats at `off` from any Float32Array (state buffer, prediction buffer). */
export function v3read(out: Vec3, buf: Float32Array, off: number): Vec3 {
  out[0] = buf[off];
  out[1] = buf[off + 1];
  out[2] = buf[off + 2];
  return out;
}

export function v3add(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out[0] = a[0] + b[0];
  out[1] = a[1] + b[1];
  out[2] = a[2] + b[2];
  return out;
}

export function v3sub(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out[0] = a[0] - b[0];
  out[1] = a[1] - b[1];
  out[2] = a[2] - b[2];
  return out;
}

export function v3scale(out: Vec3, a: Vec3, s: number): Vec3 {
  out[0] = a[0] * s;
  out[1] = a[1] * s;
  out[2] = a[2] * s;
  return out;
}

/** out = a + b * s */
export function v3addScaled(out: Vec3, a: Vec3, b: Vec3, s: number): Vec3 {
  out[0] = a[0] + b[0] * s;
  out[1] = a[1] + b[1] * s;
  out[2] = a[2] + b[2] * s;
  return out;
}

export function v3lerp(out: Vec3, a: Vec3, b: Vec3, t: number): Vec3 {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

export function v3dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Dot product of the xy projections. */
export function v3dot2D(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1];
}

export function v3cross(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  const x = a[1] * b[2] - a[2] * b[1];
  const y = a[2] * b[0] - a[0] * b[2];
  const z = a[0] * b[1] - a[1] * b[0];
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}

export function v3len2(a: Vec3): number {
  return a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
}

export function v3len(a: Vec3): number {
  return Math.sqrt(v3len2(a));
}

export function v3len2D(a: Vec3): number {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1]);
}

export function v3dist(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function v3dist2D(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

export function dist2D(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Normalise `a` into `out`; returns the original length (out = 0 when the length is ~0). */
export function v3normalize(out: Vec3, a: Vec3): number {
  const l = v3len(a);
  if (l < EPS) {
    out[0] = out[1] = out[2] = 0;
    return 0;
  }
  const inv = 1 / l;
  out[0] = a[0] * inv;
  out[1] = a[1] * inv;
  out[2] = a[2] * inv;
  return l;
}

/** Normalise the xy projection of `a` into `out` (z = 0); returns the 2D length. */
export function v3normalize2D(out: Vec3, a: Vec3): number {
  const l = Math.sqrt(a[0] * a[0] + a[1] * a[1]);
  if (l < EPS) {
    out[0] = out[1] = out[2] = 0;
    return 0;
  }
  const inv = 1 / l;
  out[0] = a[0] * inv;
  out[1] = a[1] * inv;
  out[2] = 0;
  return l;
}

/** World vector -> car local (forward, right, up) components. */
export function v3toLocal(out: Vec3, v: Vec3, fwd: Vec3, right: Vec3, up: Vec3): Vec3 {
  const f = v3dot(v, fwd);
  const r = v3dot(v, right);
  const u = v3dot(v, up);
  out[0] = f;
  out[1] = r;
  out[2] = u;
  return out;
}

/** Car local (forward, right, up) components -> world vector. */
export function v3fromLocal(out: Vec3, l: Vec3, fwd: Vec3, right: Vec3, up: Vec3): Vec3 {
  const f = l[0];
  const r = l[1];
  const u = l[2];
  out[0] = fwd[0] * f + right[0] * r + up[0] * u;
  out[1] = fwd[1] * f + right[1] * r + up[1] * u;
  out[2] = fwd[2] * f + right[2] * r + up[2] * u;
  return out;
}

// ---- scalars ------------------------------------------------------------------------------

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Clamp to [-1, 1] (control range). */
export function clamp1(x: number): number {
  return x < -1 ? -1 : x > 1 ? 1 : x;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function sign(x: number): number {
  return x < 0 ? -1 : x > 0 ? 1 : 0;
}

/** Wrap an angle to (-π, π]. */
export function wrapAngle(a: number): number {
  a = a % (2 * Math.PI);
  if (a > Math.PI) a -= 2 * Math.PI;
  else if (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

/**
 * Signed ground-plane angle (rad) from the car's forward axis to the direction `dir`, measured in
 * the car's (forward, right) frame: positive = target is to the RIGHT (same sign as steer input).
 * `fwd`/`right` are the car's basis vectors; only their xy projections are used.
 */
export function angleTo2D(fwd: Vec3, right: Vec3, dir: Vec3): number {
  const f = fwd[0] * dir[0] + fwd[1] * dir[1];
  const r = right[0] * dir[0] + right[1] * dir[1];
  if (Math.abs(f) < EPS && Math.abs(r) < EPS) return 0;
  return Math.atan2(r, f);
}

/** Same as angleTo2D but for a target point (dir = to - from). */
export function angleToPoint2D(fwd: Vec3, right: Vec3, from: Vec3, to: Vec3): number {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const f = fwd[0] * dx + fwd[1] * dy;
  const r = right[0] * dx + right[1] * dy;
  if (Math.abs(f) < EPS && Math.abs(r) < EPS) return 0;
  return Math.atan2(r, f);
}

/** Heading angle of a direction vector in the ground plane (atan2(y, x)). */
export function heading2D(v: Vec3): number {
  return Math.atan2(v[1], v[0]);
}

// ---- driving model (RocketSim constants) ------------------------------------------

/** Ground max speed with throttle only (uu/s). */
export const MAX_DRIVE_SPEED = 1410;
/** Ground / air max speed with boost (uu/s). */
export const MAX_BOOST_SPEED = 2300;
export const SUPERSONIC_SPEED = 2200;
/** Boost acceleration on the ground (RocketSim BOOST_ACCEL_GROUND = 2975/3). */
export const BOOST_ACCEL_GROUND = 2975 / 3;
/** Boost acceleration in the air (RocketSim BOOST_ACCEL_AIR = 3175/3). */
export const BOOST_ACCEL_AIR = 3175 / 3;
/** Boost consumed per second (RocketSim BOOST_USED_PER_SECOND = 100/3). */
export const BOOST_PER_SECOND = 100 / 3;
/** Peak throttle acceleration at rest (uu/s²), scaled by DRIVE_SPEED_TORQUE_FACTOR_CURVE. */
export const THROTTLE_ACCEL_MAX = 1600;
/** Instant jump impulse (RocketSim JUMP_IMMEDIATE_FORCE = 875/3 uu/s). */
export const JUMP_IMPULSE = 875 / 3;
/** Extra jump acceleration while jump is held (RocketSim JUMP_ACCEL = 4375/3 uu/s², up to 0.2 s). */
export const JUMP_HOLD_ACCEL = 4375 / 3;
export const JUMP_MAX_HOLD = 0.2;
/** Dodge impulse magnitude (RocketSim FLIP_INITIAL_VEL_SCALE). */
export const DODGE_IMPULSE = 500;
export const GRAVITY = -650;

// Measured steady-state curvature (1/uu) vs forward speed (uu/s), from RocketSim constants
// STEER_ANGLE_FROM_SPEED_CURVE. Piecewise linear, clamped at both ends.
const CURV_SPEED = [0, 500, 1000, 1500, 1750, 2300];
const CURV_VALUE = [0.0069, 0.00398, 0.00235, 0.001375, 0.0011, 0.00088];

/** Piecewise-linear lookup on sorted `xs` -> `ys`, clamped at both ends. */
export function curveLookup(xs: readonly number[], ys: readonly number[], x: number): number {
  const n = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let i = 1;
  while (i < n - 1 && xs[i] < x) i++;
  const x0 = xs[i - 1];
  const x1 = xs[i];
  const t = (x - x0) / (x1 - x0);
  return ys[i - 1] + (ys[i] - ys[i - 1]) * t;
}

/** Max steady-state turning curvature (1/uu) at a given forward speed. */
export function curvatureAt(speed: number): number {
  return curveLookup(CURV_SPEED, CURV_VALUE, Math.abs(speed));
}

/** Minimum turn radius (uu) at a given forward speed. */
export function turnRadius(speed: number): number {
  return 1 / curvatureAt(speed);
}

/** Throttle-only forward acceleration (uu/s²) at a forward speed (DRIVE_SPEED_TORQUE_FACTOR_CURVE). */
export function throttleAccel(speed: number): number {
  const s = Math.abs(speed);
  if (s >= MAX_DRIVE_SPEED) return 0;
  if (s >= 1400) return THROTTLE_ACCEL_MAX * 0.1 * ((MAX_DRIVE_SPEED - s) / 10);
  return THROTTLE_ACCEL_MAX * (1 - 0.9 * (s / 1400));
}

/** Total ground forward acceleration with full throttle, with or without boost. */
export function groundAccel(speed: number, boosting: boolean): number {
  return throttleAccel(speed) + (boosting ? BOOST_ACCEL_GROUND : 0);
}

/**
 * Distance (uu) a car starting at forward speed `v0` with `boost` units reaches after `t` seconds,
 * driving straight with full throttle and boosting while it has any. Coarse explicit integration.
 */
export function straightDistance(v0: number, boost: number, t: number, dt = 1 / 30): number {
  let v = Math.max(0, v0);
  let b = boost;
  let d = 0;
  let elapsed = 0;
  while (elapsed < t) {
    const h = Math.min(dt, t - elapsed);
    const boosting = b > 0;
    const vmax = boosting ? MAX_BOOST_SPEED : MAX_DRIVE_SPEED;
    v += groundAccel(v, boosting) * h;
    if (v > vmax) v = Math.max(vmax, v - 200 * h);
    d += v * h;
    if (boosting) b -= BOOST_PER_SECOND * h;
    elapsed += h;
  }
  return d;
}

/** Height (uu) reached by a jump held for `hold` seconds (<= 0.2), ignoring the 3-tick ramp. */
export function jumpApex(hold: number): number {
  const h = clamp(hold, 0, JUMP_MAX_HOLD);
  const a = JUMP_HOLD_ACCEL + GRAVITY;
  const vEnd = JUMP_IMPULSE + a * h;
  const zEnd = JUMP_IMPULSE * h + 0.5 * a * h * h;
  return zEnd + (vEnd * vEnd) / (2 * -GRAVITY);
}

// ---- deterministic RNG --------------------------------------------------------------------

/** Small seeded PRNG (mulberry32) so bot behaviour is reproducible per seed. */
export class Rng {
  private s: number;

  constructor(seed = 1) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }

  /** The generator's whole state (one uint32): save / restore for deterministic rewinds. */
  get state(): number {
    return this.s >>> 0;
  }

  set state(v: number) {
    this.s = v >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  chance(p: number): boolean {
    return this.next() < p;
  }
}
