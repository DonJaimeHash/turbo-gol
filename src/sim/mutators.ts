/**
 * Experimental physics presets, the physics core's half: what a preset's integers set in the wasm
 * (the mutator layout of ./mutatorLayout) and in the bots' physics profile.
 *
 * The keys, their grids, the defaults, the built-ins and the one strict / lenient parser the client
 * and the server share (account storage now; LobbyDO, MatchmakerDO and RoomDO with the lobbies) are
 * src/game/physicsRules.ts, the only table. Its `PhysicsRules { v, values }` is the hand-over:
 * arenaMutators(rules) is what createArena gets, botPhysicsOf(values) what the bots plan with,
 * gameSpeedFactor(values) what free play's clock runs at.
 *
 * Every default maps to the exact stock float32, so values that change nothing are bit-for-bit
 * stock physics; any other value maps to Math.fround(stock x p / 100) (IEEE double, then float32:
 * the same bits on every peer). Every grid value of the table lies inside the wasm's hard limits
 * (tests/physics-rules.test.mjs), so a range can move in physicsRules.ts without a wasm rebuild;
 * nothing node-side imports this file or the table, so neither needs a community node release.
 *
 * Cost: none per tick. RocketSim reads every one of these fields each tick in place of its
 * constant; the preset is applied once, when the arena is created.
 *
 * Pure TS (no DOM, no i18n, no const enum): node's type stripping, the Worker and the Durable
 * Objects can import it.
 */
import {
  M_BALL_DRAG,
  M_BALL_HIT_SCALE,
  M_BALL_MASS,
  M_BALL_MAX_SPEED,
  M_BALL_RESTITUTION,
  M_BOOST_ACCEL_AIR,
  M_BOOST_ACCEL_GROUND,
  M_BOOST_USED_PER_SECOND,
  M_BUMP_FORCE_SCALE,
  M_CAR_MAX_SPEED,
  M_CAR_SPAWN_BOOST,
  M_DEMO_MODE,
  M_GRAVITY_Z,
  M_JUMP_ACCEL,
  M_JUMP_IMMEDIATE_FORCE,
  M_RESPAWN_DELAY,
  M_UNLIMITED_DOUBLE_JUMPS,
  M_UNLIMITED_FLIPS,
  STOCK_MUTATORS,
  mutatorFingerprint,
  stockMutators,
} from './mutatorLayout';
import { STOCK_BOT_PHYSICS, type BotPhysics } from '../ai/math';
import { PHYSICS_SCHEMA, isStock, parsePhysicsValues, valueOf } from '../game/physicsRules';
import type { PhysicsKey, PhysicsRules, PhysicsValues } from '../game/physicsRules';

/** stock x p / 100 rounded to float32; exactly the stock float when p is the default 100. */
function pct(stock: number, p: number): number {
  return p === 100 ? stock : Math.fround((stock * p) / 100);
}

/**
 * The wasm mutator layout for `values` (grid integers, as physicsRules' parsers give them). Every
 * default maps to the exact stock float32 and every other value to Math.fround(stock x p / 100).
 * gameSpeed has no slot (it only changes free play's loop). Anything the wasm's hard limits refuse
 * makes createArena throw, so off-grid values can never run by mistake; arenaMutators checks them
 * before that.
 */
export function toMutators(values: Readonly<PhysicsValues>): Float32Array {
  const m = stockMutators();
  const S = STOCK_MUTATORS;
  // `+ 0` turns a -0 (JSON.parse('-0') passes every integer check) into 0, so one set of values
  // has one float layout and one fingerprint whichever way its zeros arrived.
  const v = (k: PhysicsKey) => valueOf(values, k) + 0;
  m[M_GRAVITY_Z] = pct(S[M_GRAVITY_Z], v('gravity'));
  m[M_BALL_MAX_SPEED] = pct(S[M_BALL_MAX_SPEED], v('ballMaxSpeed'));
  m[M_BALL_HIT_SCALE] = pct(S[M_BALL_HIT_SCALE], v('ballHit'));
  m[M_BALL_MASS] = pct(S[M_BALL_MASS], v('ballWeight'));
  m[M_BALL_RESTITUTION] = pct(S[M_BALL_RESTITUTION], v('ballBounce'));
  m[M_BALL_DRAG] = pct(S[M_BALL_DRAG], v('ballDrag'));
  const car = v('carMaxSpeed');
  m[M_CAR_MAX_SPEED] = car === 2300 ? S[M_CAR_MAX_SPEED] : car;
  m[M_BOOST_ACCEL_GROUND] = pct(S[M_BOOST_ACCEL_GROUND], v('boostPower'));
  m[M_BOOST_ACCEL_AIR] = pct(S[M_BOOST_ACCEL_AIR], v('boostPower'));
  m[M_BOOST_USED_PER_SECOND] = pct(S[M_BOOST_USED_PER_SECOND], v('boostUse'));
  const spawn = v('spawnBoost');
  m[M_CAR_SPAWN_BOOST] = spawn === 33 ? S[M_CAR_SPAWN_BOOST] : spawn; // 33 is RocketSim's 100/3
  m[M_JUMP_IMMEDIATE_FORCE] = pct(S[M_JUMP_IMMEDIATE_FORCE], v('jumpPower'));
  m[M_JUMP_ACCEL] = pct(S[M_JUMP_ACCEL], v('jumpPower'));
  m[M_UNLIMITED_FLIPS] = v('unlimitedFlips');
  m[M_UNLIMITED_DOUBLE_JUMPS] = v('unlimitedDoubleJumps');
  m[M_BUMP_FORCE_SCALE] = pct(S[M_BUMP_FORCE_SCALE], v('bumpForce'));
  m[M_DEMO_MODE] = v('demoMode');
  m[M_RESPAWN_DELAY] = v('respawnDelay');
  return m;
}

/**
 * What createArena gets for `rules` (physicsRules' rulesOf, a lobby's snapshot): null for no rules
 * or stock physics (the plain stock path: no rs_set_mutators call at all; a free-play game speed
 * alone is stock physics), else toMutators of the values. Throws on a table version this build does
 * not read or on values that are not exactly grid values of the table, so a caller that skipped the
 * parser fails at once instead of running other physics than the one its players agreed on.
 */
export function arenaMutators(rules: PhysicsRules | null): Float32Array | null {
  if (rules === null) return null;
  if (rules.v !== PHYSICS_SCHEMA) throw new Error(`arenaMutators: rules version ${String(rules.v)}, this build reads ${PHYSICS_SCHEMA}`);
  const values = parsePhysicsValues(rules.values, 'strict', 'training');
  if (values === null) throw new Error('arenaMutators: the values are not on the table\'s grid');
  return isStock(values, 'match') ? null : toMutators(values);
}

/**
 * The fingerprint (mutatorFingerprint) of the physics `rules` run: what a peer's arena reads back
 * through getMutators() once createArena(tickRate, arenaMutators(rules)) applied them, stock's for
 * null or stock rules. The P2P ready check compares the two before tick 0, because the state hash
 * does not cover the config.
 */
export function physicsFingerprint(rules: PhysicsRules | null): number {
  return mutatorFingerprint(arenaMutators(rules) ?? STOCK_MUTATORS);
}

/** stock x p / 100 in double; exactly the stock number when p is 100. */
function pctD(stock: number, p: number): number {
  return p === 100 ? stock : (stock * p) / 100;
}

/**
 * The bots' physics profile for `values`, mirroring toMutators in double precision (the bots plan
 * in doubles; the defaults give STOCK_BOT_PHYSICS itself, so stock bots compute exactly what they
 * always did). jumpPower scales only the first jump, as in RocketSim (its double jump uses a
 * constant). Built from the shared integers, so every peer's bots get the identical profile.
 */
export function botPhysicsOf(values: Readonly<PhysicsValues>): BotPhysics {
  if (isStock(values, 'match')) return STOCK_BOT_PHYSICS;
  const S = STOCK_BOT_PHYSICS;
  const v = (k: PhysicsKey) => valueOf(values, k) + 0; // -0 as 0, as in toMutators
  const car = v('carMaxSpeed');
  return Object.freeze({
    gravity: pctD(S.gravity, v('gravity')),
    jumpImpulse: pctD(S.jumpImpulse, v('jumpPower')),
    doubleJumpImpulse: S.doubleJumpImpulse,
    jumpHoldAccel: pctD(S.jumpHoldAccel, v('jumpPower')),
    boostAccelGround: pctD(S.boostAccelGround, v('boostPower')),
    boostAccelAir: pctD(S.boostAccelAir, v('boostPower')),
    boostPerSecond: pctD(S.boostPerSecond, v('boostUse')),
    maxBoostSpeed: car === 2300 ? S.maxBoostSpeed : car,
  });
}

/** Free play's game speed as a factor of real time (1 = normal, never above 1). */
export function gameSpeedFactor(values: Readonly<PhysicsValues>): number {
  return valueOf(values, 'gameSpeed') / 100;
}
