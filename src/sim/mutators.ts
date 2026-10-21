/**
 * Experimental physics presets: the value table players choose from, its integer grid, the exact
 * mapping to the wasm's mutator layout (./mutatorLayout) and to the bots' physics profile, and the
 * one pure parser / validator the client and the server (LobbyDO, MatchmakerDO, RoomDO, account
 * storage) share.
 *
 * Values are INTEGERS: a percentage of the stock value, a speed in uu/s, a choice or a toggle,
 * always on the field's grid. A preset's values object holds only the keys that differ from the
 * default (the canonical form); a missing key means the default. The default of every field maps to
 * the exact stock float, so a preset that changes nothing is bit-for-bit stock physics.
 *
 * Bounded three times: the UI only offers grid values, parsePhysicsValues() refuses anything else
 * (strict) or snaps it back onto the grid (lenient), and rs_set_mutators refuses anything outside
 * its hard limits, all or nothing. Every range here lies inside those hard limits
 * (tests/mutators.test.mjs), so a range can move here without a wasm rebuild; nothing node-side
 * imports this file, so it needs no community node release either.
 *
 * Cost: none per tick. RocketSim reads every one of these fields each tick in place of its
 * constant; the preset is applied once, when the arena is created.
 *
 * Pure TS (no DOM, no i18n, no const enum): node's type stripping, the Worker and the Durable
 * Objects can import it. Display names come from the locale keys rules.<key>.
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
  stockMutators,
} from './mutatorLayout';
import { STOCK_BOT_PHYSICS, type BotPhysics } from '../ai/math';

/** Version of the value table (stored presets and lobby snapshots carry it). */
export const PHYSICS_SCHEMA = 1;

export type PhysicsKey =
  | 'gravity'
  | 'gameSpeed'
  | 'ballMaxSpeed'
  | 'ballHit'
  | 'ballWeight'
  | 'ballBounce'
  | 'ballDrag'
  | 'carMaxSpeed'
  | 'boostPower'
  | 'boostUse'
  | 'spawnBoost'
  | 'jumpPower'
  | 'unlimitedFlips'
  | 'unlimitedDoubleJumps'
  | 'bumpForce'
  | 'demoMode'
  | 'respawnDelay';

export type PhysicsKind = 'range' | 'choice' | 'toggle';
/** UI groups (Settings > Experimental): World, Ball, Car, Contact. */
export type PhysicsGroup = 'world' | 'ball' | 'car' | 'contact';
/** 'all': free play and P2P lobbies; 'training': free play only (never in a lobby or a room). */
export type PhysicsScope = 'all' | 'training';
/** Where values are used: 'training' accepts every field, 'match' refuses the training-only ones. */
export type PhysicsContext = 'training' | 'match';
/** How the UI shows a value: % of stock, a speed (km/h, from uu/s), boost units, seconds, a choice, on/off. */
export type PhysicsUnit = 'percent' | 'speed' | 'boost' | 'seconds' | 'choice' | 'toggle';

export interface PhysicsField {
  readonly key: PhysicsKey;
  readonly kind: PhysicsKind;
  readonly group: PhysicsGroup;
  readonly scope: PhysicsScope;
  readonly unit: PhysicsUnit;
  /** Range: the grid min..max by step. Choice / toggle: the first and last option, step 0. */
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** Every allowed integer, ascending (the whole grid). */
  readonly values: readonly number[];
  readonly def: number;
}

/** Canonical values: only the keys that differ from their default, integers on the grid. */
export type PhysicsValues = { readonly [K in PhysicsKey]?: number };

function range(key: PhysicsKey, group: PhysicsGroup, min: number, max: number, step: number, def: number, unit: PhysicsUnit = 'percent', scope: PhysicsScope = 'all'): PhysicsField {
  const values: number[] = [];
  for (let v = min; v <= max; v += step) values.push(v);
  return Object.freeze({ key, kind: 'range', group, scope, unit, min, max, step, values: Object.freeze(values), def });
}

function choice(key: PhysicsKey, group: PhysicsGroup, options: number[], def: number, unit: PhysicsUnit): PhysicsField {
  return Object.freeze({ key, kind: 'choice', group, scope: 'all', unit, min: options[0], max: options[options.length - 1], step: 0, values: Object.freeze(options), def });
}

function toggle(key: PhysicsKey, group: PhysicsGroup): PhysicsField {
  return Object.freeze({ key, kind: 'toggle', group, scope: 'all', unit: 'toggle', min: 0, max: 1, step: 0, values: Object.freeze([0, 1]), def: 0 });
}

/**
 * The table, in UI order. At most 18 steps per range (the pad's left / right has no hold-repeat).
 * Speeds show in km/h (uu/s x 0.036, the HUD's unit), the rest as % of standard or in seconds.
 */
export const PHYSICS_FIELDS: readonly PhysicsField[] = Object.freeze([
  // World
  range('gravity', 'world', 30, 200, 10, 100), // gravity.z = -650 x p: -195 .. -1300
  range('gameSpeed', 'world', 25, 100, 5, 100, 'percent', 'training'), // JS only: the fixed step runs dt x p
  // Ball
  range('ballMaxSpeed', 'ball', 50, 130, 5, 100), // 6000 x p: 3000 .. 7800 uu/s (108 .. 281 km/h)
  range('ballHit', 'ball', 50, 200, 10, 100), // ballHitExtraForceScale (still capped by the ball top speed)
  range('ballWeight', 'ball', 50, 200, 10, 100), // ballMass = 30 x p (the ball body is rebuilt once, at arena creation)
  range('ballBounce', 'ball', 50, 150, 10, 100), // ballWorldRestitution = 0.6 x p: 0.30 .. 0.90
  range('ballDrag', 'ball', 0, 300, 25, 100), // ballDrag = 0.03 x p: 0 .. 0.09
  // Car
  range('carMaxSpeed', 'car', 2000, 2600, 50, 2300, 'speed'), // uu/s (72 .. 94 km/h); supersonic scales with it
  range('boostPower', 'car', 50, 200, 10, 100), // boostAccelGround and boostAccelAir x p
  range('boostUse', 'car', 0, 200, 25, 100), // boostUsedPerSecond = 33.3 x p (0: never runs out)
  choice('spawnBoost', 'car', [0, 33, 50, 75, 100], 33, 'boost'), // kickoff / respawn boost (33 = exactly 100/3)
  range('jumpPower', 'car', 50, 150, 10, 100), // the first jump (impulse and hold); the double jump stays stock
  toggle('unlimitedFlips', 'car'),
  toggle('unlimitedDoubleJumps', 'car'),
  // Contact
  range('bumpForce', 'contact', 0, 300, 25, 100), // bumpForceScale (car speed still capped)
  choice('demoMode', 'contact', [0, 1, 2], 0, 'choice'), // 0 normal, 1 on contact, 2 off
  choice('respawnDelay', 'contact', [1, 2, 3, 4, 5], 3, 'seconds'),
]);

const FIELD_BY_KEY: ReadonlyMap<string, PhysicsField> = new Map(PHYSICS_FIELDS.map((f) => [f.key, f]));

/** The field of a key, or undefined (a Map: '__proto__', 'constructor' and the like are never fields). */
export function physicsField(key: string): PhysicsField | undefined {
  return FIELD_BY_KEY.get(key);
}

/** The value of `key` in canonical `values` (its default when absent). */
export function physicsValue(values: PhysicsValues, key: PhysicsKey): number {
  const v = Object.prototype.hasOwnProperty.call(values, key) ? values[key] : undefined;
  return v === undefined ? (FIELD_BY_KEY.get(key) as PhysicsField).def : v;
}

/** The grid value nearest to `v` (ties to the lower one). `v` must be finite. */
function snap(f: PhysicsField, v: number): number {
  const vals = f.values;
  let best = vals[0];
  let bestD = Math.abs(v - best);
  for (let i = 1; i < vals.length; i++) {
    const d = Math.abs(v - vals[i]);
    if (d < bestD) {
      best = vals[i];
      bestD = d;
    }
  }
  return best;
}

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const proto = Object.getPrototypeOf(raw);
  return proto === Object.prototype || proto === null;
}

/**
 * Parse a values object.
 *  - 'strict' (lobby settings, matchmaker, room, the room welcome on a client): null on anything
 *    that is not exactly canonical-compatible: not a plain object, an unknown key, a value that is
 *    not a number, not an integer (NaN and infinities included), off the grid or out of range, or a
 *    training-only key in the 'match' context. Explicit defaults are accepted and dropped.
 *  - 'lenient' (account storage, the local cache, server answers): never null. Unknown keys,
 *    non-numbers and training-only keys in 'match' are dropped; numbers are clamped and snapped to
 *    the nearest grid value, so presets saved under an older table stay usable when a range moves.
 * The result is canonical: only non-default keys, in table order.
 */
export function parsePhysicsValues(raw: unknown, mode: 'strict', context?: PhysicsContext): PhysicsValues | null;
export function parsePhysicsValues(raw: unknown, mode: 'lenient', context?: PhysicsContext): PhysicsValues;
export function parsePhysicsValues(raw: unknown, mode: 'strict' | 'lenient', context: PhysicsContext = 'training'): PhysicsValues | null {
  const strict = mode === 'strict';
  if (!isPlainObject(raw)) return strict ? null : {};
  const picked = new Map<PhysicsKey, number>();
  for (const key of Object.keys(raw)) {
    const f = FIELD_BY_KEY.get(key);
    if (f === undefined || (context === 'match' && f.scope === 'training')) {
      if (strict) return null;
      continue;
    }
    const v = raw[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      if (strict) return null;
      continue;
    }
    if (strict) {
      if (!Number.isInteger(v) || !f.values.includes(v)) return null;
      picked.set(f.key, v);
    } else {
      picked.set(f.key, snap(f, v));
    }
  }
  const out: { [K in PhysicsKey]?: number } = {};
  for (const f of PHYSICS_FIELDS) {
    const v = picked.get(f.key);
    if (v !== undefined && v !== f.def) out[f.key] = v;
  }
  return out;
}

/** The canonical form of already-valid values: non-default keys only, in table order. */
export function canonicalValues(values: PhysicsValues): PhysicsValues {
  const out: { [K in PhysicsKey]?: number } = {};
  for (const f of PHYSICS_FIELDS) {
    const v = physicsValue(values, f.key);
    if (v !== f.def) out[f.key] = v;
  }
  return out;
}

/** The keys that differ from their default, in table order (UI summary lines). */
export function changedKeys(values: PhysicsValues, context: PhysicsContext = 'training'): PhysicsKey[] {
  const out: PhysicsKey[] = [];
  for (const f of PHYSICS_FIELDS) {
    if (context === 'match' && f.scope === 'training') continue;
    if (physicsValue(values, f.key) !== f.def) out.push(f.key);
  }
  return out;
}

/** True when no field differs from its default (in 'match', training-only fields are ignored). */
export function isStock(values: PhysicsValues, context: PhysicsContext = 'training'): boolean {
  return changedKeys(values, context).length === 0;
}

/** True when the physics the wasm runs is stock (gameSpeed is not physics: it only changes the loop). */
export function isStockPhysics(values: PhysicsValues): boolean {
  return isStock(values, 'match');
}

/** stock x p / 100 rounded to float32; exactly the stock float when p is the default 100. */
function pct(stock: number, p: number): number {
  return p === 100 ? stock : Math.fround((stock * p) / 100);
}

/**
 * The wasm mutator layout for `values` (createArena's second argument). Every default maps to the
 * exact stock float32 and every other value to Math.fround(stock x p / 100) (IEEE double, then
 * float32: the same bits on every peer). gameSpeed has no slot. Values are expected to come from
 * parsePhysicsValues; anything the wasm's hard limits refuse makes createArena throw.
 */
export function toMutators(values: PhysicsValues): Float32Array {
  const m = stockMutators();
  const S = STOCK_MUTATORS;
  const v = (k: PhysicsKey) => physicsValue(values, k);
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
 * What createArena should get for `values`: null when the physics is stock (the plain stock path,
 * no rs_set_mutators call at all), else toMutators(values).
 */
export function arenaMutators(values: PhysicsValues): Float32Array | null {
  return isStockPhysics(values) ? null : toMutators(values);
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
export function botPhysicsOf(values: PhysicsValues): BotPhysics {
  if (isStockPhysics(values)) return STOCK_BOT_PHYSICS;
  const S = STOCK_BOT_PHYSICS;
  const v = (k: PhysicsKey) => physicsValue(values, k);
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

/** Free play's game speed as a factor (1 = normal, never above 1). */
export function gameSpeedFactor(values: PhysicsValues): number {
  return physicsValue(values, 'gameSpeed') / 100;
}

export interface BuiltInPreset {
  /** Stable id; the name is the locale key rules.builtin.<id>. */
  readonly id: string;
  readonly values: PhysicsValues;
}

/** Read-only presets offered to everyone who has the experimental switch on. */
export const BUILT_IN_PRESETS: readonly BuiltInPreset[] = Object.freeze([
  { id: 'standard', values: Object.freeze({}) },
  { id: 'lowGravity', values: Object.freeze({ gravity: 50, ballDrag: 50 }) },
  { id: 'fastBall', values: Object.freeze({ ballMaxSpeed: 130, ballHit: 150, ballWeight: 80 }) },
  { id: 'bouncy', values: Object.freeze({ gravity: 80, ballWeight: 70, ballBounce: 150 }) },
  { id: 'arcade', values: Object.freeze({ carMaxSpeed: 2600, boostPower: 130, boostUse: 0, spawnBoost: 100, unlimitedFlips: 1, bumpForce: 150 }) },
]);
