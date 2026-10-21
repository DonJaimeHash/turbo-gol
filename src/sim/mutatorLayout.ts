/**
 * The physics mutator layout shared with the wasm (native/rs_api.h, rs_set_mutators /
 * rs_get_mutators): the float slots, the float32-exact stock values, the C++ hard limits mirrored
 * for documentation and tests, and the fingerprint peers compare.
 *
 * RocketSimBridge imports this module, so it is part of everything that runs the sim (the web
 * client, the Worker, community nodes): it changes only with the wasm. The value table players
 * choose from (ranges, the integer grid, defaults, the parser) is src/sim/mutators.ts, which nothing
 * node-side imports, so its ranges can move inside these hard limits without a node release.
 *
 * Pure TS without const enums: node's type stripping, the Worker and RoomDO can import it.
 */

/** rs_set_mutators layout version (slot 0). */
export const MUTATOR_LAYOUT_VERSION = 1;
/** Floats in the layout, version included. */
export const MUTATOR_COUNT = 19;

export const M_VERSION = 0;
/** Gravity along z (uu/s², negative). */
export const M_GRAVITY_Z = 1;
/** Ball speed cap (uu/s). */
export const M_BALL_MAX_SPEED = 2;
/** Scale of the extra impulse a car hit adds to the ball (RocketSim ballHitExtraForceScale). */
export const M_BALL_HIT_SCALE = 3;
/** Ball mass in Bullet units (stock 30 = car mass / 6). A change rebuilds the ball body. */
export const M_BALL_MASS = 4;
/** Ball bounce against the arena (restitution). */
export const M_BALL_RESTITUTION = 5;
/** Ball linear damping (air drag). */
export const M_BALL_DRAG = 6;
/** Car speed cap (uu/s, RocketSim patch 3); the supersonic thresholds scale with it. */
export const M_CAR_MAX_SPEED = 7;
export const M_BOOST_ACCEL_GROUND = 8;
export const M_BOOST_ACCEL_AIR = 9;
export const M_BOOST_USED_PER_SECOND = 10;
/** Boost every car gets at a kickoff and a respawn. */
export const M_CAR_SPAWN_BOOST = 11;
/** First jump impulse (uu/s); the double jump keeps RocketSim's constant. */
export const M_JUMP_IMMEDIATE_FORCE = 12;
/** First jump hold acceleration (uu/s²). */
export const M_JUMP_ACCEL = 13;
export const M_UNLIMITED_FLIPS = 14;
export const M_UNLIMITED_DOUBLE_JUMPS = 15;
/** Scale of the car-car bump impulse. */
export const M_BUMP_FORCE_SCALE = 16;
/** 0 normal (supersonic bumps demolish), 1 any contact demolishes, 2 no demolitions. */
export const M_DEMO_MODE = 17;
/** Seconds a demolished car waits before it respawns. */
export const M_RESPAWN_DELAY = 18;

/**
 * Stock values exactly as the wasm holds them (float32; RocketSim's RLConst). A fresh arena's
 * rs_get_mutators returns these bit for bit (tests/mutators-wasm.test.mjs).
 */
export const STOCK_MUTATORS: readonly number[] = Object.freeze(
  [
    MUTATOR_LAYOUT_VERSION,
    -650, // GRAVITY_Z
    6000, // BALL_MAX_SPEED
    1, // ballHitExtraForceScale
    30, // BALL_MASS_BT = CAR_MASS_BT / 6
    0.6, // BALL_RESTITUTION
    0.03, // BALL_DRAG
    2300, // CAR_MAX_SPEED
    2975 / 3, // BOOST_ACCEL_GROUND
    3175 / 3, // BOOST_ACCEL_AIR
    100 / 3, // BOOST_USED_PER_SECOND
    100 / 3, // BOOST_SPAWN_AMOUNT
    875 / 3, // JUMP_IMMEDIATE_FORCE
    4375 / 3, // JUMP_ACCEL
    0, // unlimitedFlips
    0, // unlimitedDoubleJumps
    1, // bumpForceScale
    0, // DemoMode::NORMAL
    3, // DEMO_RESPAWN_TIME
  ].map(Math.fround),
);

/** A fresh Float32Array with the stock values (createArena(tickRate, m) with it equals stock). */
export function stockMutators(): Float32Array {
  return Float32Array.from(STOCK_MUTATORS);
}

/**
 * The hard limits rs_set_mutators enforces (native/wrapper.cpp, namespace M): [min, max] per slot,
 * float32 like the C++ comparison. Integral slots (version, toggles, demo mode) must hold an exact
 * integer. Mirrored here for the tests and for anyone reading the table in src/sim/mutators.ts.
 */
export const MUTATOR_HARD_LIMITS: readonly (readonly [number, number])[] = Object.freeze(
  (
    [
      [1, 1],
      [-2000, -100],
      [1000, 8500],
      [0, 4],
      [10, 90],
      [0, 0.95],
      [0, 0.5],
      [1500, 2700],
      [0, 3000],
      [0, 3200],
      [0, 100],
      [0, 100],
      [0, 600],
      [0, 3000],
      [0, 1],
      [0, 1],
      [0, 5],
      [0, 2],
      [0.5, 10],
    ] as const
  ).map(([lo, hi]) => Object.freeze([Math.fround(lo), Math.fround(hi)] as const)),
);

/** Slots that must hold an exact integer. */
export const MUTATOR_INTEGRAL_SLOTS: readonly number[] = Object.freeze([M_VERSION, M_UNLIMITED_FLIPS, M_UNLIMITED_DOUBLE_JUMPS, M_DEMO_MODE]);

/** The JS mirror of rs_set_mutators' validation: true when the wasm would accept `m`. */
export function mutatorsWithinLimits(m: ArrayLike<number>): boolean {
  if (m.length !== MUTATOR_COUNT || Math.fround(m[M_VERSION]) !== MUTATOR_LAYOUT_VERSION) return false;
  for (let i = 0; i < MUTATOR_COUNT; i++) {
    const v = Math.fround(m[i]);
    const [lo, hi] = MUTATOR_HARD_LIMITS[i];
    if (!Number.isFinite(v) || v < lo || v > hi) return false;
    if (MUTATOR_INTEGRAL_SLOTS.includes(i) && !Number.isInteger(v)) return false;
  }
  return true;
}

/**
 * FNV-1a 32 (offset basis 0x811c9dc5, prime 0x01000193, like rs_state_hash) over the
 * little-endian float32 bytes of the MUTATOR_COUNT values. Peers compare it before tick 0: the state
 * hash does not cover the config, which never changes during a match. Returns a uint32.
 */
export function mutatorFingerprint(m: ArrayLike<number>): number {
  const bytes = new DataView(new ArrayBuffer(MUTATOR_COUNT * 4));
  for (let i = 0; i < MUTATOR_COUNT; i++) bytes.setFloat32(i * 4, i < m.length ? m[i] : 0, true);
  let h = 0x811c9dc5;
  for (let i = 0; i < MUTATOR_COUNT * 4; i++) {
    h ^= bytes.getUint8(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
