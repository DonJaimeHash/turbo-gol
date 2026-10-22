// The physics core's mapping of the experimental physics values (src/sim/mutators.ts) to the wasm's
// layout and hard limits (src/sim/mutatorLayout.ts) and to the bots' profile. The table, its grid
// and its parser are src/game/physicsRules.ts (tests/physics-rules.test.mjs). Pure: no wasm needed.
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
const R = await import('../src/game/physicsRules.ts');
const AI = await import('../src/ai/math.ts');

const { toMutators, botPhysicsOf } = M;
const { PHYSICS_FIELDS } = R;
const sameBits = (a, b) => a.length === b.length && Array.from(a).every((v, i) => Object.is(Math.fround(v), Math.fround(b[i])));
const allAt = (pick) => Object.fromEntries(PHYSICS_FIELDS.map((f) => [f.key, pick(f)]));

test('stock mapping: the defaults are the exact stock float32 values, bit for bit', () => {
  assert.equal(L.MUTATOR_COUNT, 19);
  assert.equal(L.STOCK_MUTATORS.length, L.MUTATOR_COUNT);
  assert.ok(sameBits(toMutators({}), L.STOCK_MUTATORS));
  assert.ok(sameBits(toMutators(allAt((f) => f.default)), L.STOCK_MUTATORS), 'explicit defaults too');
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

test('a -0 (JSON.parse("-0") passes every integer check) maps and fingerprints exactly like 0', () => {
  const neg = JSON.parse('{"ballDrag": -0, "boostUse": -0, "bumpForce": -0, "spawnBoost": -0, "unlimitedFlips": -0}');
  const pos = { ballDrag: 0, boostUse: 0, bumpForce: 0, spawnBoost: 0 };
  assert.ok(Object.is(neg.ballDrag, -0), 'the input really holds -0');
  const strict = R.parsePhysicsValues(neg, 'strict', 'match');
  assert.deepEqual(strict, pos, 'the shared strict parser keeps the grid 0, never -0');
  assert.ok(Object.values(strict).every((v) => Object.is(v, 0)));
  const a = toMutators(neg);
  const b = toMutators(pos);
  assert.ok(Array.from(a).every((v, i) => Object.is(v, b[i])), 'the same float32 layout, bit for bit');
  assert.equal(L.mutatorFingerprint(a), L.mutatorFingerprint(b));
  assert.deepEqual({ ...botPhysicsOf(neg) }, { ...botPhysicsOf(pos) });
});

test('fingerprint: golden values, and any one value changes it', () => {
  assert.equal(L.mutatorFingerprint(L.STOCK_MUTATORS), 0x7318f74a);
  assert.equal(L.mutatorFingerprint(L.stockMutators()), 0x7318f74a, 'array or Float32Array alike');
  const arcade = R.BUILT_IN_PRESETS.find((p) => p.id === 'arcade');
  assert.equal(L.mutatorFingerprint(toMutators(arcade.values)), 0x1dbde5c1);
  const seen = new Set([L.mutatorFingerprint(L.STOCK_MUTATORS)]);
  for (const f of PHYSICS_FIELDS) {
    if (f.scope === 'training') continue;
    const other = R.fieldValues(f).find((v) => v !== f.default);
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

test('the hand-over: arenaMutators(PhysicsRules) is null for stock, the layout otherwise, and refuses another version or off-grid values', () => {
  assert.equal(M.arenaMutators(null), null, 'no rules: the plain stock path');
  assert.equal(M.arenaMutators(R.rulesOf({})), null, 'stock rules: no rs_set_mutators call at all');
  assert.equal(M.arenaMutators(R.rulesOf({ gameSpeed: 50 }, 'training')), null, 'a game speed alone is stock physics');
  assert.equal(M.arenaMutators(R.rulesOf({ gravity: 100, unlimitedFlips: 0 })), null, 'explicit defaults are stock');
  const low = R.BUILT_IN_PRESETS.find((p) => p.id === 'lowGravity').values;
  assert.ok(sameBits(M.arenaMutators(R.rulesOf(low)), toMutators(low)));
  assert.ok(sameBits(M.arenaMutators(R.rulesOf({ ...low, gameSpeed: 50 }, 'training')), toMutators(low)), 'free play: the game speed stays out of the wasm');
  // A rules snapshot as a lobby carries it ({ v, name, values }) is PhysicsRules too.
  const snap = R.parseRulesSnapshot(JSON.parse(JSON.stringify(R.snapshotOf('Low gravity', low))));
  assert.ok(sameBits(M.arenaMutators(snap), toMutators(low)));
  assert.throws(() => M.arenaMutators({ v: R.PHYSICS_SCHEMA + 1, values: low }), /version/);
  for (const values of [{ gravity: 55 }, { gravity: 1e9 }, { gravity: NaN }, { nope: 1 }, { gravity: '50' }, null, []]) {
    assert.throws(() => M.arenaMutators({ v: R.PHYSICS_SCHEMA, values }), /grid/, JSON.stringify(values));
  }
  // The fingerprint a peer's arena reads back once the rules are applied.
  assert.equal(M.physicsFingerprint(null), 0x7318f74a);
  assert.equal(M.physicsFingerprint(R.rulesOf({ gameSpeed: 50 }, 'training')), 0x7318f74a);
  const arcade = R.BUILT_IN_PRESETS.find((p) => p.id === 'arcade').values;
  assert.equal(M.physicsFingerprint(R.rulesOf(arcade)), 0x1dbde5c1);
  assert.equal(M.physicsFingerprint(R.rulesOf(low)), L.mutatorFingerprint(toMutators(low)));
});

test('game speed: a factor of real time, never above 1', () => {
  assert.equal(M.gameSpeedFactor({}), 1);
  assert.equal(M.gameSpeedFactor({ gameSpeed: 25 }), 0.25);
  for (const v of R.fieldValues(R.physicsField('gameSpeed'))) assert.ok(M.gameSpeedFactor({ gameSpeed: v }) <= 1);
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
  assert.equal(botPhysicsOf(allAt((f) => f.default)), S);
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

test('built-in presets: inside the hard limits, each with its own fingerprint, Standard is stock', () => {
  for (const p of R.BUILT_IN_PRESETS) assert.ok(L.mutatorsWithinLimits(toMutators(p.values)), p.id);
  assert.ok(sameBits(toMutators(R.BUILT_IN_PRESETS[0].values), L.STOCK_MUTATORS));
  const fps = new Set(R.BUILT_IN_PRESETS.map((p) => L.mutatorFingerprint(toMutators(p.values))));
  assert.equal(fps.size, R.BUILT_IN_PRESETS.length);
});
