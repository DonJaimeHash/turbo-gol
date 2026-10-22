// Experimental free play (src/game/experimentalTraining.ts): only free play takes rules and only for
// an unlocked player; packs are always stock; the rules go into createArena before the car; a pack
// after experimental free play gets a stock arena again (the leak fix); free play records nothing;
// game speed slows the fixed-step accumulator and never speeds it up. The last test builds real
// training arenas in the wasm with the extreme built-ins and checks the ball and the car follow them.
//   node --test tests/experimental-training.test.mjs      (the last test needs src/sim/wasm/rocketsim.{js,wasm})
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (relative && err && err.code === 'ERR_MODULE_NOT_FOUND') {
        if (!/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + '.ts', context);
        if (specifier.endsWith('.js')) return nextResolve(specifier.slice(0, -3) + '.ts', context);
      }
      throw err;
    }
  },
});

const X = await import('../src/game/experimentalTraining.ts');
const R = await import('../src/game/physicsRules.ts');
const M = await import('../src/sim/mutators.ts');
const P = await import('../src/game/trainingPacks.ts');
const S = await import('../src/game/TrainingSession.ts');
const T = await import('../src/sim/types.ts');

const builtIn = (id) => R.BUILT_IN_PRESETS.find((p) => p.id === id).values;
const LOW = builtIn('lowGravity');

test('only free play takes rules, only for an unlocked player; every pack is stock whatever is asked', () => {
  assert.deepEqual(X.trainingRules(P.FREEPLAY_ID, LOW, true), { v: R.PHYSICS_SCHEMA, values: { gravity: 50, ballDrag: 50 } });
  assert.equal(X.trainingRules(P.FREEPLAY_ID, LOW, false), null, 'locked (a guest, the switch off): stock');
  assert.equal(X.trainingRules(P.FREEPLAY_ID, null, true), null, 'plain free play');
  for (const pack of P.TRAINING_PACKS) assert.equal(X.trainingRules(pack.id, LOW, true), null, `${pack.id} never runs rules`);
  // Free play keeps its own keys (game speed), which a match would drop.
  assert.deepEqual(X.trainingRules(P.FREEPLAY_ID, { gameSpeed: 50, gravity: 70 }, true).values, { gravity: 70, gameSpeed: 50 });
});

test('the plan: stock has no mutators, a preset its own fingerprint, game speed alone is stock physics at a slower clock', () => {
  const stock = X.planTrainingArena(null);
  assert.deepEqual(stock, { mutators: null, fingerprint: X.STOCK_ARENA_FINGERPRINT, speed: 1 });
  assert.equal(X.STOCK_ARENA_FINGERPRINT, M.physicsFingerprint(null));
  assert.equal(X.planTrainingArena(R.rulesOf({})).mutators, null, 'standard values: the plain stock path');
  const low = X.planTrainingArena(R.rulesOf(LOW, 'training'));
  assert.ok(low.mutators instanceof Float32Array);
  assert.equal(low.fingerprint, M.physicsFingerprint(R.rulesOf(LOW, 'training')));
  assert.notEqual(low.fingerprint, X.STOCK_ARENA_FINGERPRINT);
  assert.equal(low.speed, 1);
  const slow = X.planTrainingArena(R.rulesOf({ gameSpeed: 25 }, 'training'));
  assert.deepEqual([slow.mutators, slow.fingerprint, slow.speed], [null, X.STOCK_ARENA_FINGERPRINT, 0.25]);
  assert.throws(() => X.planTrainingArena({ v: R.PHYSICS_SCHEMA, values: { gravity: 47 } }), /grid/, 'off-grid values never run');
});

test('the rules go into createArena before the car exists', () => {
  const calls = [];
  const sim = {
    createArena: (rate, mutators) => calls.push(['createArena', rate, mutators]),
    addCar: (team, preset) => {
      calls.push(['addCar', team, preset]);
      return 7;
    },
  };
  const plan = X.planTrainingArena(R.rulesOf(LOW, 'training'));
  assert.equal(X.buildTrainingArena(sim, plan, T.TICK_RATE, T.Team.Blue, T.CarPreset.Standard), 7);
  assert.deepEqual(calls.map((c) => c[0]), ['createArena', 'addCar']);
  assert.equal(calls[0][1], T.TICK_RATE);
  assert.equal(calls[0][2], plan.mutators);
  assert.deepEqual(calls[1].slice(1), [T.Team.Blue, T.CarPreset.Standard]);
});

test('the leak fix: a pack after experimental free play gets a stock arena; the same physics keep the arena', () => {
  const exp = X.planTrainingArena(X.trainingRules(P.FREEPLAY_ID, LOW, true));
  const pack = X.planTrainingArena(X.trainingRules(P.TRAINING_PACKS[0].id, LOW, true));
  assert.equal(pack.fingerprint, X.STOCK_ARENA_FINGERPRINT);
  assert.equal(X.needsTrainingArena(false, X.STOCK_ARENA_FINGERPRINT, exp), true, 'entering training always builds');
  assert.equal(X.needsTrainingArena(true, exp.fingerprint, pack), true, 'experimental free play -> a pack: rebuilt stock');
  assert.equal(X.needsTrainingArena(true, exp.fingerprint, exp), false, 'the same preset again: kept');
  assert.equal(X.needsTrainingArena(true, X.STOCK_ARENA_FINGERPRINT, pack), false, 'pack -> pack: kept, as before');
  const slow = X.planTrainingArena(X.trainingRules(P.FREEPLAY_ID, { gameSpeed: 50 }, true));
  assert.equal(X.needsTrainingArena(true, X.STOCK_ARENA_FINGERPRINT, slow), false, 'game speed alone is stock physics: no rebuild');
});

test('free play records nothing, rules or not (packs only)', () => {
  const recorded = [];
  const records = { recordResult: (...a) => (recorded.push(a), { record: { best: 0 }, newBest: false }) };
  const storage = { getItem: () => null, setItem: () => recorded.push('storage') };
  const hooks = { placeShot() {}, releaseShot() {}, shotResult() {}, packSummary() {}, freeplayGoal() {}, freeplayReset() {} };
  for (const opts of [{ records }, { storage: null }, { storage }]) {
    const s = new S.TrainingSession(null, hooks, opts);
    s.start();
    const ball = { x: 0, y: 0, z: 93, vx: 0, vy: 0, vz: 0 };
    for (let i = 0; i < 1200; i++) {
      s.input(i % 7 === 0);
      if (i % 300 === 10) s.onGoal(i % 2);
      s.onPlayerTouch();
      s.tick(T.TICK_DT, ball);
    }
  }
  assert.deepEqual(recorded, []);
});

test('game speed: the accumulator runs fewer ticks at a lower speed, never more than real time, clamped as before', () => {
  const run = (speed, frames = 60, dt = 1 / 60) => {
    let acc = 0;
    let ticks = 0;
    for (let i = 0; i < frames; i++) {
      acc = X.accumulate(acc, dt, speed, 0.1);
      while (acc >= T.TICK_DT) {
        ticks++;
        acc -= T.TICK_DT;
      }
    }
    return ticks;
  };
  assert.ok(Math.abs(run(1) - 120) <= 1, '1 s at normal speed: 120 ticks');
  assert.ok(Math.abs(run(0.5) - 60) <= 1, 'half speed: half the ticks');
  assert.ok(Math.abs(run(0.25) - 30) <= 1);
  assert.equal(X.accumulate(0, 1, 1, 0.1), 0.1, 'a long frame is clamped as before');
  const f = R.physicsField('gameSpeed');
  for (const v of R.fieldValues(f)) assert.ok(X.planTrainingArena(R.rulesOf({ gameSpeed: v }, 'training')).speed <= 1, `gameSpeed ${v}`);
});

test('real arenas: experimental free play with the extreme built-ins changes the ball and the car; a pack after it is stock again', async () => {
  const { RocketSim } = await import('../src/sim/RocketSimBridge.ts');
  const { buildArenaMesh } = await import('../src/sim/arenaMesh.ts');
  const L = await import('../src/sim/mutatorLayout.ts');
  const sim = await RocketSim.load();
  sim.initArena(buildArenaMesh().physics);
  const build = (id, values) => {
    const plan = X.planTrainingArena(X.trainingRules(id, values, true));
    const car = X.buildTrainingArena(sim, plan, T.TICK_RATE, T.Team.Blue, T.CarPreset.Standard);
    assert.equal(L.mutatorFingerprint(sim.getMutators()), plan.fingerprint, 'the arena reads back the planned physics');
    return { plan, car };
  };
  /** The ball dropped from 1000 uu: its height after 0.5 s. */
  const drop = () => {
    sim.setBallState([0, 0, 1000], [0, 0, 0], [0, 0, 0]);
    sim.step(60);
    sim.sync();
    return sim.buf[T.BALL_OFFSET + T.B_POS + 2];
  };
  /** The car boosting on the ground from rest for 3 s: its speed (uu/s). */
  const boost = (car) => {
    sim.setCarState(car, [0, -2000, 17], [Math.PI / 2, 0, 0], [0, 0, 0], [0, 0, 0]);
    sim.setCarBoost(car, 100);
    sim.setUnlimitedBoost(true);
    sim.setControls(car, { ...T.emptyControls(), throttle: 1, boost: true });
    sim.step(360);
    sim.sync();
    const v = sim.buf.subarray(T.CARS_OFFSET + T.C_VEL, T.CARS_OFFSET + T.C_VEL + 3);
    return Math.hypot(v[0], v[1], v[2]);
  };
  const stock = build(P.FREEPLAY_ID, null);
  const zStock = drop();
  const vStock = boost(stock.car);
  build(P.FREEPLAY_ID, builtIn('lowGravity'));
  const zLow = drop();
  assert.ok(zLow > zStock + 30, `low gravity falls slower (${zLow.toFixed(1)} vs ${zStock.toFixed(1)})`);
  const arcade = build(P.FREEPLAY_ID, builtIn('arcade'));
  const vArcade = boost(arcade.car);
  assert.ok(vStock <= 2300.5, `stock car top speed (${vStock.toFixed(1)})`);
  assert.ok(vArcade > 2400, `arcade's car goes past the stock top speed (${vArcade.toFixed(1)})`);
  // The next training is a pack: stock physics again.
  const pack = build(P.TRAINING_PACKS[0].id, builtIn('arcade'));
  assert.equal(pack.plan.fingerprint, X.STOCK_ARENA_FINGERPRINT);
  assert.ok(Math.abs(drop() - zStock) < 1e-3, 'the pack drops the ball like stock');
  sim.destroyArena();
});
