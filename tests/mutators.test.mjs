// The experimental physics value table and its parser (src/sim/mutators.ts) against the wasm's
// layout and hard limits (src/sim/mutatorLayout.ts). Pure: no wasm needed.
//   node --test tests/mutators.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[a-z]+$/i.test(specifier) && context.parentURL) {
      const candidate = new URL(specifier + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
});

const L = await import('../src/sim/mutatorLayout.ts');
const M = await import('../src/sim/mutators.ts');
const AI = await import('../src/ai/math.ts');
const { BALL, CAR_STANDARD } = await import('../src/sim/constants.ts');
const { TICK_RATE } = await import('../src/sim/types.ts');

const { PHYSICS_FIELDS, parsePhysicsValues, toMutators, botPhysicsOf } = M;
const field = (k) => M.physicsField(k);
const sameBits = (a, b) => a.length === b.length && Array.from(a).every((v, i) => Object.is(Math.fround(v), Math.fround(b[i])));
const allAt = (pick) => Object.fromEntries(PHYSICS_FIELDS.map((f) => [f.key, pick(f)]));

test('table: 17 integer fields, unique keys, the UI groups, every default on its grid', () => {
  assert.equal(PHYSICS_FIELDS.length, 17);
  assert.equal(new Set(PHYSICS_FIELDS.map((f) => f.key)).size, 17);
  const groups = {};
  for (const f of PHYSICS_FIELDS) groups[f.group] = (groups[f.group] ?? 0) + 1;
  assert.deepEqual(groups, { world: 2, ball: 5, car: 7, contact: 3 });
  for (const f of PHYSICS_FIELDS) {
    assert.ok(f.values.includes(f.def), `${f.key}: default ${f.def} on the grid`);
    assert.ok(f.values.every((v) => Number.isInteger(v)), `${f.key}: integers only`);
    assert.ok(f.values.every((v, i) => i === 0 || v > f.values[i - 1]), `${f.key}: ascending`);
    assert.equal(f.min, f.values[0]);
    assert.equal(f.max, f.values[f.values.length - 1]);
    if (f.kind === 'range') {
      assert.ok(Number.isInteger((f.max - f.min) / f.step), `${f.key}: max on the grid`);
      assert.equal(f.values.length, (f.max - f.min) / f.step + 1);
    }
    if (f.kind === 'toggle') assert.deepEqual([...f.values, f.def], [0, 1, 0]);
  }
  assert.deepEqual(PHYSICS_FIELDS.filter((f) => f.scope === 'training').map((f) => f.key), ['gameSpeed']);
});

test('table: no field has more than 18 steps (the pad left / right has no hold-repeat)', () => {
  for (const f of PHYSICS_FIELDS) assert.ok(f.values.length - 1 <= 18, `${f.key}: ${f.values.length - 1} steps`);
});

test('table: every grid value of every field, and the all-min / all-max corners, are inside the C++ hard limits', () => {
  for (const f of PHYSICS_FIELDS) {
    for (const v of f.values) {
      const m = toMutators({ [f.key]: v });
      assert.ok(L.mutatorsWithinLimits(m), `${f.key} = ${v}`);
    }
  }
  assert.ok(L.mutatorsWithinLimits(toMutators(allAt((f) => f.min))), 'all minimums');
  assert.ok(L.mutatorsWithinLimits(toMutators(allAt((f) => f.max))), 'all maximums');
});

test('table: the physics stays sane at the extremes (no tunnelling ball, bounce < 1, gravity pulls down)', () => {
  const hi = toMutators(allAt((f) => f.max));
  const lo = toMutators(allAt((f) => f.min));
  // The ball moves at most 0.72 of its radius per tick at the UI's top speed (tunnelling starts ~0.8 R).
  assert.ok(hi[L.M_BALL_MAX_SPEED] / TICK_RATE <= 0.72 * BALL.radius, `${hi[L.M_BALL_MAX_SPEED]} uu/s`);
  // ...and at most 0.8 R at the wasm's hard limit, whatever a modified client sends.
  assert.ok(L.MUTATOR_HARD_LIMITS[L.M_BALL_MAX_SPEED][1] / TICK_RATE <= 0.8 * BALL.radius);
  assert.ok(hi[L.M_BALL_RESTITUTION] < 1 && L.MUTATOR_HARD_LIMITS[L.M_BALL_RESTITUTION][1] < 1, 'a bounce never gains energy');
  assert.ok(hi[L.M_GRAVITY_Z] < 0 && lo[L.M_GRAVITY_Z] < 0 && L.MUTATOR_HARD_LIMITS[L.M_GRAVITY_Z][1] < 0, 'gravity always pulls down');
  // The car moves 21.7 uu per tick at the UI maximum (22.5 at the hard limit): more than its half
  // hitbox height (19.3) but well under its height and its half length; the 60 s corner runs of
  // tests/mutators-extremes.test.mjs show it never leaves the field.
  assert.ok(hi[L.M_CAR_MAX_SPEED] / TICK_RATE < CAR_STANDARD.hitboxSize[2] * 0.6);
  assert.ok(L.MUTATOR_HARD_LIMITS[L.M_CAR_MAX_SPEED][1] / TICK_RATE < CAR_STANDARD.hitboxSize[0] / 2);
});

test('stock mapping: the defaults are the exact stock float32 values, bit for bit', () => {
  assert.equal(L.MUTATOR_COUNT, 19);
  assert.equal(L.STOCK_MUTATORS.length, L.MUTATOR_COUNT);
  assert.ok(sameBits(toMutators({}), L.STOCK_MUTATORS));
  assert.ok(sameBits(toMutators(allAt((f) => f.def)), L.STOCK_MUTATORS), 'explicit defaults too');
  assert.ok(sameBits(toMutators({ gameSpeed: 50 }), L.STOCK_MUTATORS), 'game speed is not a wasm field');
  assert.ok(sameBits(L.stockMutators(), L.STOCK_MUTATORS));
  // RocketSim's own expressions, evaluated in float32.
  const f = Math.fround;
  assert.equal(L.STOCK_MUTATORS[L.M_BOOST_ACCEL_GROUND], f(f(2975) / f(3)));
  assert.equal(L.STOCK_MUTATORS[L.M_BOOST_USED_PER_SECOND], f(f(100) / f(3)));
  assert.equal(L.STOCK_MUTATORS[L.M_JUMP_IMMEDIATE_FORCE], f(f(875) / f(3)));
  assert.equal(L.STOCK_MUTATORS[L.M_JUMP_ACCEL], f(f(4375) / f(3)));
  assert.equal(L.STOCK_MUTATORS[L.M_BALL_MASS], 30);
  assert.ok(L.mutatorsWithinLimits(L.STOCK_MUTATORS));
});

test('mapping: a non-default value is fround(stock x p / 100); speeds and choices are the value itself', () => {
  const S = L.STOCK_MUTATORS;
  const m = toMutators({ gravity: 50, ballMaxSpeed: 130, ballHit: 150, ballWeight: 200, ballBounce: 150, ballDrag: 0, carMaxSpeed: 2600, boostPower: 70, boostUse: 0, spawnBoost: 100, jumpPower: 150, unlimitedFlips: 1, unlimitedDoubleJumps: 1, bumpForce: 300, demoMode: 2, respawnDelay: 5 });
  const pct = (slot, p) => Math.fround((S[slot] * p) / 100);
  assert.equal(m[L.M_GRAVITY_Z], -325);
  assert.equal(m[L.M_BALL_MAX_SPEED], 7800);
  assert.equal(m[L.M_BALL_HIT_SCALE], 1.5);
  assert.equal(m[L.M_BALL_MASS], 60);
  assert.equal(m[L.M_BALL_RESTITUTION], pct(L.M_BALL_RESTITUTION, 150));
  assert.equal(m[L.M_BALL_DRAG], 0);
  assert.equal(m[L.M_CAR_MAX_SPEED], 2600);
  assert.equal(m[L.M_BOOST_ACCEL_GROUND], pct(L.M_BOOST_ACCEL_GROUND, 70));
  assert.equal(m[L.M_BOOST_ACCEL_AIR], pct(L.M_BOOST_ACCEL_AIR, 70));
  assert.equal(m[L.M_BOOST_USED_PER_SECOND], 0);
  assert.equal(m[L.M_CAR_SPAWN_BOOST], 100);
  assert.equal(m[L.M_JUMP_IMMEDIATE_FORCE], pct(L.M_JUMP_IMMEDIATE_FORCE, 150));
  assert.equal(m[L.M_JUMP_ACCEL], pct(L.M_JUMP_ACCEL, 150));
  assert.deepEqual([m[L.M_UNLIMITED_FLIPS], m[L.M_UNLIMITED_DOUBLE_JUMPS], m[L.M_BUMP_FORCE_SCALE], m[L.M_DEMO_MODE], m[L.M_RESPAWN_DELAY]], [1, 1, 3, 2, 5]);
  assert.equal(m[L.M_VERSION], L.MUTATOR_LAYOUT_VERSION);
  // spawnBoost 33 is RocketSim's 100/3 exactly, not 33.
  assert.equal(toMutators({ spawnBoost: 33 })[L.M_CAR_SPAWN_BOOST], S[L.M_CAR_SPAWN_BOOST]);
  assert.equal(toMutators({ spawnBoost: 50 })[L.M_CAR_SPAWN_BOOST], 50);
});

test('fingerprint: golden values, and any one value changes it', () => {
  assert.equal(L.mutatorFingerprint(L.STOCK_MUTATORS), 0x7318f74a);
  assert.equal(L.mutatorFingerprint(L.stockMutators()), 0x7318f74a, 'array or Float32Array alike');
  const arcade = M.BUILT_IN_PRESETS.find((p) => p.id === 'arcade');
  assert.equal(L.mutatorFingerprint(toMutators(arcade.values)), 0x1dbde5c1);
  const seen = new Set([L.mutatorFingerprint(L.STOCK_MUTATORS)]);
  for (const f of PHYSICS_FIELDS) {
    if (f.scope === 'training') continue;
    const other = f.values.find((v) => v !== f.def);
    seen.add(L.mutatorFingerprint(toMutators({ [f.key]: other })));
  }
  assert.equal(seen.size, 1 + PHYSICS_FIELDS.length - 1, 'every field moves the fingerprint');
});

test('hard limits mirror: what the wasm refuses (non-finite, outside a limit, non-integral toggles, bad version or count)', () => {
  const ok = L.stockMutators();
  assert.ok(L.mutatorsWithinLimits(ok));
  for (let i = 0; i < L.MUTATOR_COUNT; i++) {
    const [lo, hi] = L.MUTATOR_HARD_LIMITS[i];
    for (const bad of [NaN, Infinity, -Infinity, lo - Math.max(1e-3, Math.abs(lo) * 1e-3), hi + Math.max(1e-3, Math.abs(hi) * 1e-3)]) {
      const m = L.stockMutators();
      m[i] = bad;
      assert.equal(L.mutatorsWithinLimits(m), false, `slot ${i} = ${bad}`);
    }
  }
  for (const slot of [L.M_UNLIMITED_FLIPS, L.M_UNLIMITED_DOUBLE_JUMPS, L.M_DEMO_MODE]) {
    const m = L.stockMutators();
    m[slot] = 0.5;
    assert.equal(L.mutatorsWithinLimits(m), false, `slot ${slot} must be an integer`);
  }
  assert.equal(L.mutatorsWithinLimits(ok.subarray(0, 18)), false);
  assert.equal(L.mutatorsWithinLimits([...ok, 0]), false);
  const v2 = L.stockMutators();
  v2[0] = 2;
  assert.equal(L.mutatorsWithinLimits(v2), false);
});

test('strict parser: refuses unknown keys, non-integers, off-grid, out of range, NaN, strings, arrays, training-only keys in a match', () => {
  const S = (raw, ctx) => parsePhysicsValues(raw, 'strict', ctx);
  assert.deepEqual(S({}), {});
  assert.deepEqual(S({ gravity: 50, ballDrag: 50 }), { gravity: 50, ballDrag: 50 });
  for (const bad of [
    null,
    undefined,
    42,
    'gravity',
    [],
    [50],
    { gravity: 55 }, // off the 10 grid
    { gravity: 20 }, // below the range
    { gravity: 210 }, // above
    { gravity: 50.5 },
    { gravity: NaN },
    { gravity: Infinity },
    { gravity: '50' },
    { gravity: true },
    { gravity: null },
    { gravity: [50] },
    { gravity: { v: 50 } },
    { gravityZ: -325 },
    { spawnBoost: 34 },
    { unlimitedFlips: 2 },
    { unlimitedFlips: 0.5 },
    { demoMode: 3 },
    { carMaxSpeed: 2310 },
    JSON.parse('{"__proto__": 50}'),
    JSON.parse('{"constructor": 50}'),
    JSON.parse('{"toString": 50}'),
    new Map([['gravity', 50]]),
  ]) {
    assert.equal(S(bad), null, `refused: ${typeof bad === 'object' && bad !== null && !(bad instanceof Map) ? JSON.stringify(bad) : String(bad)}`);
  }
  assert.deepEqual(S({ gameSpeed: 50 }), { gameSpeed: 50 }, 'free play takes the game speed');
  assert.equal(S({ gameSpeed: 50 }, 'match'), null, 'a match never does');
  assert.deepEqual(S({ gravity: 100, ballDrag: 0 }), { ballDrag: 0 }, 'explicit defaults are dropped');
  assert.deepEqual(S(Object.assign(Object.create(null), { gravity: 60 })), { gravity: 60 });
});

test('lenient parser: drops unknown keys and non-numbers, clamps and snaps onto the grid, never fails', () => {
  const Lp = (raw, ctx) => parsePhysicsValues(raw, 'lenient', ctx);
  assert.deepEqual(Lp(null), {});
  assert.deepEqual(Lp([1, 2]), {});
  assert.deepEqual(Lp('x'), {});
  assert.deepEqual(Lp({ gravity: 1000, ballDrag: -5, nope: 1, ballHit: 'x', jumpPower: NaN }), { gravity: 200, ballDrag: 0 });
  assert.deepEqual(Lp({ ballDrag: -5 }), { ballDrag: 0 });
  assert.deepEqual(Lp({ gravity: 54 }), { gravity: 50 });
  assert.deepEqual(Lp({ gravity: 56 }), { gravity: 60 });
  assert.deepEqual(Lp({ gravity: 55 }), { gravity: 50 }, 'ties go to the lower grid value');
  assert.deepEqual(Lp({ gravity: 99.6 }), {}, 'snaps to the default, which is dropped');
  assert.deepEqual(Lp({ spawnBoost: 40 }), {}, 'snaps to 33, the default');
  assert.deepEqual(Lp({ spawnBoost: 42 }), { spawnBoost: 50 });
  assert.deepEqual(Lp({ unlimitedFlips: 0.9 }), { unlimitedFlips: 1 });
  assert.deepEqual(Lp({ demoMode: 7 }), { demoMode: 2 });
  assert.deepEqual(Lp({ carMaxSpeed: 9999 }), { carMaxSpeed: 2600 });
  assert.deepEqual(Lp({ gameSpeed: 50, gravity: 60 }, 'match'), { gravity: 60 }, 'training-only keys dropped in a match');
  // Whatever comes in, the result passes strict.
  for (const raw of [{ gravity: 1e9 }, { ballDrag: 37 }, { bumpForce: -1e9, boostUse: 12.5, respawnDelay: 0 }]) {
    const v = Lp(raw);
    assert.deepEqual(parsePhysicsValues(v, 'strict'), v);
  }
});

test('canonical form: only non-default keys, in table order, stable JSON', () => {
  const a = parsePhysicsValues({ ballDrag: 50, gravity: 50, ballHit: 100 }, 'strict');
  const b = parsePhysicsValues({ gravity: 50, ballDrag: 50 }, 'strict');
  assert.equal(JSON.stringify(a), '{"gravity":50,"ballDrag":50}');
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(JSON.stringify(M.canonicalValues({ ballDrag: 50, gravity: 50, ballHit: 100 })), '{"gravity":50,"ballDrag":50}');
  assert.deepEqual(M.changedKeys({ ballDrag: 50, gameSpeed: 50 }), ['gameSpeed', 'ballDrag']);
  assert.deepEqual(M.changedKeys({ ballDrag: 50, gameSpeed: 50 }, 'match'), ['ballDrag']);
  assert.equal(M.isStock({}), true);
  assert.equal(M.isStock({ gameSpeed: 50 }), false);
  assert.equal(M.isStockPhysics({ gameSpeed: 50 }), true);
  assert.equal(M.arenaMutators({}), null, 'stock physics takes the plain stock path');
  assert.equal(M.arenaMutators({ gameSpeed: 50 }), null);
  assert.ok(sameBits(M.arenaMutators({ gravity: 50 }), toMutators({ gravity: 50 })));
  assert.equal(M.gameSpeedFactor({}), 1);
  assert.equal(M.gameSpeedFactor({ gameSpeed: 25 }), 0.25);
  assert.ok(field('gameSpeed').max <= 100, 'free play never runs faster than real time');
});

test('bot profile: stock values give STOCK_BOT_PHYSICS itself (the old constants), presets mirror the mapping in doubles', () => {
  const S = AI.STOCK_BOT_PHYSICS;
  assert.deepEqual(
    { ...S },
    {
      gravity: AI.GRAVITY,
      jumpImpulse: AI.JUMP_IMPULSE,
      doubleJumpImpulse: AI.JUMP_IMPULSE,
      jumpHoldAccel: AI.JUMP_HOLD_ACCEL,
      boostAccelGround: AI.BOOST_ACCEL_GROUND,
      boostAccelAir: AI.BOOST_ACCEL_AIR,
      boostPerSecond: AI.BOOST_PER_SECOND,
      maxBoostSpeed: AI.MAX_BOOST_SPEED,
    },
  );
  assert.equal(botPhysicsOf({}), S);
  assert.equal(botPhysicsOf({ gameSpeed: 50 }), S, 'game speed is not physics');
  assert.equal(botPhysicsOf(allAt((f) => f.def)), S);
  const p = botPhysicsOf({ gravity: 50, jumpPower: 150, boostPower: 200, boostUse: 0, carMaxSpeed: 2000, ballDrag: 0 });
  assert.equal(p.gravity, -325);
  assert.equal(p.jumpImpulse, (AI.JUMP_IMPULSE * 150) / 100);
  assert.equal(p.jumpHoldAccel, (AI.JUMP_HOLD_ACCEL * 150) / 100);
  assert.equal(p.doubleJumpImpulse, AI.JUMP_IMPULSE, 'the double jump keeps the constant, as in RocketSim');
  assert.equal(p.boostAccelGround, (AI.BOOST_ACCEL_GROUND * 200) / 100);
  assert.equal(p.boostAccelAir, (AI.BOOST_ACCEL_AIR * 200) / 100);
  assert.equal(p.boostPerSecond, 0);
  assert.equal(p.maxBoostSpeed, 2000);
  // Close to what the wasm runs (float32 vs double).
  const m = toMutators({ gravity: 50, jumpPower: 150, boostPower: 200 });
  assert.ok(Math.abs(m[L.M_GRAVITY_Z] - p.gravity) < 1e-3);
  assert.ok(Math.abs(m[L.M_JUMP_IMMEDIATE_FORCE] - p.jumpImpulse) < 1e-3);
  assert.ok(Math.abs(m[L.M_BOOST_ACCEL_AIR] - p.boostAccelAir) < 1e-3);
  // The driving model follows the profile.
  assert.ok(AI.jumpApex(0.2, p) > AI.jumpApex(0.2));
  assert.equal(AI.jumpApex(0.2, S), AI.jumpApex(0.2));
  assert.equal(AI.straightDistance(0, 100, 2, 1 / 30, S), AI.straightDistance(0, 100, 2));
  assert.ok(AI.straightDistance(0, 100, 2, 1 / 30, p) > AI.straightDistance(0, 100, 2));
});

test('built-in presets: valid in a match, distinct, Standard is stock', () => {
  const ids = M.BUILT_IN_PRESETS.map((p) => p.id);
  assert.deepEqual(ids, ['standard', 'lowGravity', 'fastBall', 'bouncy', 'arcade']);
  for (const p of M.BUILT_IN_PRESETS) {
    assert.deepEqual(parsePhysicsValues(p.values, 'strict', 'match'), p.values, `${p.id} is canonical and valid in a match`);
    assert.ok(L.mutatorsWithinLimits(toMutators(p.values)), p.id);
  }
  assert.equal(M.isStock(M.BUILT_IN_PRESETS[0].values), true);
  const fps = new Set(M.BUILT_IN_PRESETS.map((p) => L.mutatorFingerprint(toMutators(p.values))));
  assert.equal(fps.size, M.BUILT_IN_PRESETS.length);
});
