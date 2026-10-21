// Physics mutators in the wasm (rs_set_mutators / rs_get_mutators through RocketSimBridge):
// stock by default, all-or-nothing validation, every preset field has its effect, the ball
// predictor follows the preset (bit for bit, incrementally), save / load and determinism under a
// preset, car mass untouched, the car top speed cap and its supersonic thresholds.
//   node --test tests/mutators-wasm.test.mjs      (needs src/sim/wasm/rocketsim.{js,wasm})
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

// The trace script registers the .ts resolve hook and runs the bot scenarios.
const { runStockTrace } = await import('../scripts/stock-trace.mjs');
const { RocketSim } = await import('../src/sim/RocketSimBridge.ts');
const { buildArenaMesh } = await import('../src/sim/arenaMesh.ts');
const T = await import('../src/sim/types.ts');
const L = await import('../src/sim/mutatorLayout.ts');
const M = await import('../src/sim/mutators.ts');
const R = await import('../src/game/physicsRules.ts');

const mesh = buildArenaMesh().physics;
const sim = await RocketSim.load();
sim.initArena(mesh);
const raw = sim['mod'];

const sameBits = (a, b) => a.length === b.length && Array.from(a).every((v, i) => Object.is(v, b[i]));
const car = (slot, f) => sim.buf[T.CARS_OFFSET + slot * T.CAR_STRIDE + f];
const carVec = (slot, f) => [car(slot, f), car(slot, f + 1), car(slot, f + 2)];
const ballVec = (f) => [sim.buf[T.BALL_OFFSET + f], sim.buf[T.BALL_OFFSET + f + 1], sim.buf[T.BALL_OFFSET + f + 2]];
const len = (v) => Math.hypot(v[0], v[1], v[2]);
const ctl = (over) => ({ ...T.emptyControls(), ...over });

/** rs_set_mutators straight on the module (count may differ from the data's length; ptr 0 = null). */
function rawSet(data, count = data.length, nullPtr = false) {
  const ptr = raw._malloc(Math.max(1, data.length) * 4);
  new Float32Array(raw.wasmMemory.buffer, ptr, data.length).set(data);
  const rc = raw._rs_set_mutators(nullPtr ? 0 : ptr, count);
  raw._free(ptr);
  return rc;
}

/** A fresh arena with `values` (null / {} = stock). */
function arena(values = null) {
  sim.createArena(T.TICK_RATE, values ? M.toMutators(values) : null);
  sim.events.onGoal = sim.events.onBump = sim.events.onBallHit = undefined;
  return sim;
}

test('a fresh arena is stock, bit for bit (STOCK_MUTATORS), and createArena without a preset never changes that', () => {
  arena();
  assert.ok(sameBits(sim.getMutators(), L.stockMutators()));
  arena({});
  assert.ok(sameBits(sim.getMutators(), L.stockMutators()));
  const out = new Float32Array(L.MUTATOR_COUNT);
  assert.equal(sim.getMutators(out), out);
});

test('a preset round-trips: getMutators returns exactly what toMutators built', () => {
  const values = { gravity: 70, ballMaxSpeed: 120, ballHit: 180, ballWeight: 60, ballBounce: 130, ballDrag: 25, carMaxSpeed: 2450, boostPower: 150, boostUse: 50, spawnBoost: 75, jumpPower: 120, unlimitedFlips: 1, unlimitedDoubleJumps: 1, bumpForce: 200, demoMode: 1, respawnDelay: 2 };
  arena(values);
  assert.ok(sameBits(sim.getMutators(), M.toMutators(values)));
  sim.destroyArena();
  sim.createArena(T.TICK_RATE);
  assert.ok(sameBits(sim.getMutators(), L.stockMutators()), 'destroy / create is stock again');
});

test('the hand-over from the shared table: every built-in through rulesOf / arenaMutators runs, and reads back its physicsFingerprint', () => {
  for (const p of R.BUILT_IN_PRESETS) {
    const rules = R.rulesOf(p.values);
    sim.createArena(T.TICK_RATE, M.arenaMutators(rules));
    assert.equal(L.mutatorFingerprint(sim.getMutators()), M.physicsFingerprint(rules), p.id);
  }
  // A lobby's snapshot, through JSON as a room welcome brings it.
  const snap = R.parseRulesSnapshot(JSON.parse(JSON.stringify(R.snapshotOf('Fast ball', R.BUILT_IN_PRESETS[2].values))));
  sim.createArena(T.TICK_RATE, M.arenaMutators(snap));
  assert.ok(sameBits(sim.getMutators(), M.toMutators(R.BUILT_IN_PRESETS[2].values)));
  sim.createArena(T.TICK_RATE);
});

test('rs_set_mutators refuses bad data with nothing changed: NaN, infinities, outside a hard limit, non-integral toggles, version, count, null', () => {
  const preset = M.toMutators({ gravity: 50, ballWeight: 150, carMaxSpeed: 2600 });
  arena({ gravity: 50, ballWeight: 150, carMaxSpeed: 2600 });
  const before = sim.getMutators();
  const expectRefused = (data, why, count, nullPtr) => {
    assert.equal(rawSet(data, count, nullPtr), 1, why);
    assert.ok(sameBits(sim.getMutators(), before), `${why}: nothing changed`);
  };
  for (let i = 0; i < L.MUTATOR_COUNT; i++) {
    const [lo, hi] = L.MUTATOR_HARD_LIMITS[i];
    for (const bad of [NaN, Infinity, -Infinity, lo - Math.max(1e-3, Math.abs(lo) * 1e-3), hi + Math.max(1e-3, Math.abs(hi) * 1e-3)]) {
      const m = preset.slice();
      m[i] = bad;
      expectRefused(m, `slot ${i} = ${bad}`);
      assert.equal(L.mutatorsWithinLimits(m), false, 'the JS mirror agrees');
    }
  }
  for (const slot of [L.M_UNLIMITED_FLIPS, L.M_UNLIMITED_DOUBLE_JUMPS, L.M_DEMO_MODE]) {
    const m = preset.slice();
    m[slot] = 0.5;
    expectRefused(m, `slot ${slot} = 0.5`);
  }
  const v2 = preset.slice();
  v2[0] = 2;
  expectRefused(v2, 'version 2');
  expectRefused(preset, 'count 18', 18);
  expectRefused(Float32Array.from([...preset, 0]), 'count 20');
  expectRefused(preset, 'null pointer', L.MUTATOR_COUNT, true);
  // Every value at its hard limit is accepted (the limits are inclusive).
  const edge = Float32Array.from(L.MUTATOR_HARD_LIMITS.map(([lo]) => lo));
  assert.equal(rawSet(edge), 0);
  assert.ok(sameBits(sim.getMutators(), edge));
  const top = Float32Array.from(L.MUTATOR_HARD_LIMITS.map(([, hi]) => hi));
  assert.equal(rawSet(top), 0);
  assert.ok(sameBits(sim.getMutators(), top));
  // No arena.
  sim.destroyArena();
  assert.equal(rawSet(preset), 2);
});

test('createArena with a refused preset throws and leaves no arena (no silent stock fallback)', () => {
  const bad = M.toMutators({ gravity: 50 });
  bad[L.M_GRAVITY_Z] = 100; // gravity up: outside the hard limit
  assert.throws(() => sim.createArena(T.TICK_RATE, bad), /rs_set_mutators failed with code 1/);
  assert.throws(() => sim.addCar(T.Team.Blue), /no arena/);
  assert.throws(() => sim.createArena(T.TICK_RATE, new Float32Array(5)), /code 1/);
  arena({ gravity: 50 }); // and the bridge works again right after
  assert.equal(sim.getMutators()[L.M_GRAVITY_Z], -325);
});

test('ballMass cannot change once a car exists (code 3, nothing changed); the other fields can', () => {
  arena();
  sim.addCar(T.Team.Blue);
  const heavy = M.toMutators({ ballWeight: 200 });
  assert.equal(rawSet(heavy), 3);
  assert.ok(sameBits(sim.getMutators(), L.stockMutators()));
  const light = M.toMutators({ gravity: 50, ballDrag: 0 });
  assert.equal(rawSet(light), 0);
  assert.ok(sameBits(sim.getMutators(), light));
});

/** Ball alone in a preset arena: does the prediction equal the stepped ball, bit for bit, for 720 ticks? */
function predictionMatches(label) {
  sim.setBallState([500, -200, 1200], [1800, 900, -300], [1, 2, 0.5]);
  sim.sync();
  sim.updateBallPrediction();
  const pred = Float32Array.from(sim.ballPred);
  let bounces = 0;
  let prevVz = 0;
  for (let t = 0; t < T.BALL_PRED_TICKS; t++) {
    sim.step(1);
    sim.sync();
    const p = ballVec(T.B_POS);
    const v = ballVec(T.B_VEL);
    if (prevVz < 0 && v[2] > 0) bounces++;
    prevVz = v[2];
    const o = t * T.BALL_PRED_STRIDE;
    for (let j = 0; j < 3; j++) {
      assert.ok(Object.is(pred[o + j], p[j]) && Object.is(pred[o + 3 + j], v[j]), `${label}: tick ${t + 1} predicted (${Array.from(pred.subarray(o, o + 6))}) vs stepped (${p}, ${v})`);
    }
  }
  return bounces;
}

const PRED_PRESET = { gravity: 50, ballDrag: 50, ballBounce: 150, ballWeight: 70, ballMaxSpeed: 80 };

test('the ball predictor follows the preset bit for bit: tracker created after the preset (createArena)', () => {
  arena(PRED_PRESET);
  const bounces = predictionMatches('createArena');
  assert.ok(bounces >= 1, 'the run includes bounces');
});

test('the ball predictor follows the preset bit for bit: tracker existing when the preset is set (rs_set_mutators)', () => {
  arena();
  sim.updateBallPrediction(); // the tracker exists, with stock physics, ball asleep at the kickoff spot
  assert.equal(rawSet(M.toMutators(PRED_PRESET)), 0);
  predictionMatches('rs_set_mutators');
});

test('the prediction stays incremental under a preset: no full re-prediction per update (cost like stock)', () => {
  const run = (values) => {
    arena(values);
    sim.setBallState([0, 0, 1500], [800, 300, 0]);
    sim.sync();
    sim.updateBallPrediction();
    const t0 = performance.now();
    for (let k = 0; k < 600; k++) {
      sim.step(1);
      sim.sync();
      sim.updateBallPrediction();
    }
    return performance.now() - t0;
  };
  run(PRED_PRESET); // warm-up
  const stock = Math.min(run(null), run(null));
  const preset = Math.min(run(PRED_PRESET), run(PRED_PRESET));
  console.log(`600 prediction updates: stock ${stock.toFixed(1)} ms, preset ${preset.toFixed(1)} ms`);
  // A full 720-tick re-prediction per update would cost ~1-2 ms each, 600+ ms in all.
  assert.ok(preset < stock * 3 + 30, `preset ${preset.toFixed(1)} ms vs stock ${stock.toFixed(1)} ms`);
});

test('car mass is untouched: with only ballWeight changed a boosting car moves exactly like stock', () => {
  const drive = (values) => {
    arena(values);
    const id = sim.addCar(T.Team.Blue);
    sim.setCarState(id, [2000, -4000, 17], [Math.PI / 2, 0, 0]);
    sim.setCarBoost(id, 100);
    for (let t = 0; t < 180; t++) {
      sim.setControls(id, ctl({ throttle: 1, boost: t < 120, steer: t > 140 ? 0.5 : 0 }));
      sim.step(1);
    }
    sim.sync();
    return Float32Array.from(sim.buf.subarray(T.CARS_OFFSET, T.CARS_OFFSET + T.CAR_STRIDE));
  };
  const stock = drive(null);
  for (const w of [50, 200]) assert.ok(sameBits(drive({ ballWeight: w }), stock), `ballWeight ${w}`);
});

/**
 * Full boost along the +y lane at x = 2000 (unlimited boost). `coastAfter`: ticks of boost kept
 * after supersonic switches on, then throttle and boost off (the maintain window is the first second
 * of supersonic). Returns the top speed and the speeds where supersonic switched on and off.
 */
function topSpeedRun(values, coastAfter = Infinity) {
  arena(values);
  const id = sim.addCar(T.Team.Blue);
  sim.setCarState(id, [2000, -5200, 17], [Math.PI / 2, 0, 0]);
  sim.setUnlimitedBoost(true);
  let max = 0;
  let onAt = -1;
  let onTick = -1;
  let offAt = -1;
  let prevSs = 0;
  let prevSpeed = 0;
  for (let t = 0; t < 600 && offAt < 0; t++) {
    const boosting = onTick < 0 || t < onTick + coastAfter;
    sim.setControls(id, ctl({ throttle: boosting ? 1 : 0, boost: boosting }));
    sim.step(1);
    sim.sync();
    const s = len(carVec(0, T.C_VEL));
    const ss = car(0, T.C_IS_SUPERSONIC);
    if (s > max) max = s;
    if (ss === 1 && prevSs === 0 && onAt < 0) {
      onAt = s;
      onTick = t;
    }
    if (ss === 0 && prevSs === 1) offAt = prevSpeed;
    prevSs = ss;
    prevSpeed = s;
  }
  sim.setUnlimitedBoost(false);
  return { max, onAt, offAt };
}

test('car top speed: capped at carMaxSpeed, supersonic starts at 2200 x k and is kept down to 2100 x k (k = carMaxSpeed / 2300)', () => {
  for (const cap of [2000, 2300, 2600]) {
    const values = cap === 2300 ? null : { carMaxSpeed: cap };
    const k = cap / 2300;
    const top = topSpeedRun(values);
    assert.ok(top.max <= cap + 0.01 && top.max > cap - 1, `cap ${cap}: top speed ${top.max}`);
    assert.ok(top.onAt >= 2200 * k && top.onAt < 2200 * k + 20, `cap ${cap}: supersonic from ${top.onAt} (threshold ${2200 * k})`);
    const coast = topSpeedRun(values, 10);
    assert.ok(coast.offAt >= 2100 * k && coast.offAt < 2100 * k + 20, `cap ${cap}: supersonic kept down to ${coast.offAt} (threshold ${2100 * k})`);
  }
});

// ---- every preset field has its effect ------------------------------------------------------

/** Ticks a ball dropped from z = 1000 needs to reach z = 200. */
function dropTicks(values) {
  arena(values);
  sim.setBallState([0, 0, 1000]);
  for (let t = 1; t < 2000; t++) {
    sim.step(1);
    sim.sync();
    if (ballVec(T.B_POS)[2] < 200) return t;
  }
  return -1;
}

/** Highest point after the first bounce of a ball dropped from z = 1500. */
function bounceApex(values) {
  arena(values);
  sim.setBallState([0, 0, 1500]);
  let bounced = false;
  let apex = 0;
  for (let t = 0; t < 900; t++) {
    sim.step(1);
    sim.sync();
    const z = ballVec(T.B_POS)[2];
    const vz = ballVec(T.B_VEL)[2];
    if (!bounced && vz > 0) bounced = true;
    if (bounced) {
      apex = Math.max(apex, z);
      if (vz < 0) break;
    }
  }
  return apex;
}

/** A car at 1400 uu/s drives into a ball at rest: the ball's top speed in the next 0.5 s. */
function hitSpeed(values) {
  arena(values);
  const id = sim.addCar(T.Team.Blue);
  sim.setCarState(id, [0, -1400, 17], [Math.PI / 2, 0, 0], [0, 1400, 0]);
  sim.setBallState([0, -800, T.BALL_REST_Z ?? 93.15]);
  let top = 0;
  for (let t = 0; t < 60; t++) {
    sim.setControls(id, ctl({ throttle: 1 }));
    sim.step(1);
    sim.sync();
    top = Math.max(top, len(ballVec(T.B_VEL)));
  }
  return top;
}

/** Car on the ground from rest: [speed, boost left] after 0.5 s of full boost (100 boost to start). */
function boostRun(values) {
  arena(values);
  const id = sim.addCar(T.Team.Blue);
  sim.setCarState(id, [2000, -4000, 17], [Math.PI / 2, 0, 0]);
  sim.setCarBoost(id, 100);
  for (let t = 0; t < 60; t++) {
    sim.setControls(id, ctl({ throttle: 1, boost: true }));
    sim.step(1);
  }
  sim.sync();
  return [len(carVec(0, T.C_VEL)), car(0, T.C_BOOST)];
}

/** Highest z of a car that holds jump for 0.2 s from rest. */
function jumpApexOf(values) {
  arena(values);
  const id = sim.addCar(T.Team.Blue);
  sim.setCarState(id, [2000, -3000, 17], [Math.PI / 2, 0, 0]);
  for (let t = 0; t < 10; t++) sim.step(1); // settle on the wheels
  let apex = 0;
  for (let t = 0; t < 180; t++) {
    sim.setControls(id, ctl({ jump: t < 24 }));
    sim.step(1);
    sim.sync();
    apex = Math.max(apex, carVec(0, T.C_POS)[2]);
  }
  return apex;
}

test('gravity: a ball falls slower at 50 % (about sqrt 2 longer) and faster at 200 %', () => {
  const stock = dropTicks(null);
  const low = dropTicks({ gravity: 50 });
  const high = dropTicks({ gravity: 200 });
  assert.ok(low / stock > 1.35 && low / stock < 1.48, `50 %: ${low} vs ${stock} ticks`);
  assert.ok(stock / high > 1.35 && stock / high < 1.48, `200 %: ${high} vs ${stock} ticks`);
});

test('ball top speed: the ball is capped at 6000 x p', () => {
  for (const p of [50, 100, 130]) {
    arena(p === 100 ? null : { ballMaxSpeed: p });
    sim.setBallState([0, 0, 1000], [0, 9000, 0]);
    sim.step(1);
    sim.sync();
    const s = len(ballVec(T.B_VEL));
    assert.ok(Math.abs(s - 60 * p) < 2, `${p} %: ${s}`);
  }
});

test('hit strength and ball weight: a stronger hit or a lighter ball leaves faster', () => {
  const stock = hitSpeed(null);
  const weak = hitSpeed({ ballHit: 50 });
  const strong = hitSpeed({ ballHit: 200 });
  assert.ok(weak < stock && stock < strong, `hit 50/100/200 %: ${weak} / ${stock} / ${strong}`);
  const light = hitSpeed({ ballWeight: 50 });
  const heavy = hitSpeed({ ballWeight: 200 });
  assert.ok(light > stock && stock > heavy, `weight 50/100/200 %: ${light} / ${stock} / ${heavy}`);
});

test('ball bounce: higher rebounds with more bounce', () => {
  const low = bounceApex({ ballBounce: 50 });
  const stock = bounceApex(null);
  const high = bounceApex({ ballBounce: 150 });
  assert.ok(low < stock && stock < high, `50/100/150 %: ${low} / ${stock} / ${high}`);
  assert.ok(high < 1500, 'never above the drop height (no energy gained)');
});

test('air drag: 0 keeps the horizontal speed, more drag slows the ball more', () => {
  const after = (values) => {
    arena(values);
    sim.setBallState([-2000, 0, 1800], [1500, 0, 0]);
    for (let t = 0; t < 60; t++) sim.step(1);
    sim.sync();
    return ballVec(T.B_VEL)[0];
  };
  const none = after({ ballDrag: 0 });
  const stock = after(null);
  const lots = after({ ballDrag: 300 });
  assert.ok(Math.abs(none - 1500) < 0.01, `no drag: ${none}`);
  assert.ok(lots < stock && stock < none, `0/100/300 %: ${none} / ${stock} / ${lots}`);
});

test('boost power and boost use: faster with more power, the tank empties at 33.3 x p per second (0: never)', () => {
  const [vStock, bStock] = boostRun(null);
  const [vWeak] = boostRun({ boostPower: 50 });
  const [vStrong] = boostRun({ boostPower: 200 });
  assert.ok(vWeak < vStock && vStock < vStrong, `power 50/100/200 %: ${vWeak} / ${vStock} / ${vStrong}`);
  const [, bNone] = boostRun({ boostUse: 0 });
  const [, bDouble] = boostRun({ boostUse: 200 });
  assert.equal(bNone, 100, 'boost use 0: never runs out');
  assert.ok(Math.abs(100 - bStock - 0.5 * (100 / 3)) < 1, `stock use after 0.5 s: ${100 - bStock}`);
  assert.ok(Math.abs(100 - bDouble - 2 * (100 - bStock)) < 1, `200 %: ${100 - bDouble}`);
});

test('boost at kickoff: 0 / 50 / 100, and 33 is exactly the stock 100/3', () => {
  for (const [v, want] of [[0, 0], [50, 50], [100, 100], [33, Math.fround(100 / 3)]]) {
    arena(v === 33 ? null : { spawnBoost: v });
    sim.addCar(T.Team.Blue);
    sim.addCar(T.Team.Red);
    sim.resetKickoff(3);
    sim.sync();
    assert.equal(car(0, T.C_BOOST), want, `kickoff boost ${v}`);
    assert.equal(car(1, T.C_BOOST), want);
  }
});

test('jump power: a held jump goes higher at 150 % and lower at 50 %', () => {
  const low = jumpApexOf({ jumpPower: 50 });
  const stock = jumpApexOf(null);
  const high = jumpApexOf({ jumpPower: 150 });
  assert.ok(low < stock && stock < high, `50/100/150 %: ${low} / ${stock} / ${high}`);
});

test('unlimited flips: a second flip in the air only with the toggle on', () => {
  const secondFlip = (values) => {
    arena(values);
    const id = sim.addCar(T.Team.Blue);
    sim.setCarState(id, [2000, -3000, 17], [Math.PI / 2, 0, 0]);
    for (let t = 0; t < 10; t++) sim.step(1);
    const press = (t) => t < 6 || t === 12 || t === 40; // jump, flip at 0.1 s, flip again at 0.33 s
    let flipTimeBefore = 0;
    for (let t = 0; t <= 41; t++) {
      sim.setControls(id, ctl({ jump: press(t), pitch: t >= 12 ? -1 : 0 }));
      sim.step(1);
      sim.sync();
      if (t === 39) flipTimeBefore = car(0, T.C_FLIP_TIME);
    }
    return { before: flipTimeBefore, after: car(0, T.C_FLIP_TIME) };
  };
  const stock = secondFlip(null);
  assert.ok(stock.after > stock.before, `stock: the first flip keeps running (${stock.before} -> ${stock.after})`);
  const on = secondFlip({ unlimitedFlips: 1 });
  assert.ok(on.after < 0.05 && on.before > 0.2, `unlimited: a new flip started (${on.before} -> ${on.after})`);
});

test('unlimited double jumps: a third jump in the air only with the toggle on', () => {
  const thirdJump = (values) => {
    arena(values);
    const id = sim.addCar(T.Team.Blue);
    sim.setCarState(id, [2000, -3000, 17], [Math.PI / 2, 0, 0]);
    for (let t = 0; t < 10; t++) sim.step(1);
    const press = (t) => t < 6 || t === 20 || t === 40;
    let vzBefore = 0;
    for (let t = 0; t <= 40; t++) {
      sim.setControls(id, ctl({ jump: press(t) }));
      if (t === 40) {
        sim.sync();
        vzBefore = carVec(0, T.C_VEL)[2];
      }
      sim.step(1);
    }
    sim.sync();
    return carVec(0, T.C_VEL)[2] - vzBefore;
  };
  const stock = thirdJump(null);
  const on = thirdJump({ unlimitedDoubleJumps: 1 });
  assert.ok(stock < 0, `stock: no third jump (dvz ${stock})`);
  assert.ok(on > 200, `unlimited: the third jump adds ~290 uu/s (dvz ${on})`);
});

/** Blue car at speed into a red car at rest, side on; demolitions off unless `values` sets them. */
function bump(values, speed = 1800) {
  arena({ demoMode: 2, ...values });
  const a = sim.addCar(T.Team.Blue);
  const b = sim.addCar(T.Team.Red);
  sim.setCarState(a, [2000, -700, 17], [Math.PI / 2, 0, 0], [0, speed, 0]);
  sim.setCarState(b, [2000, 0, 17], [0, 0, 0]);
  let bumps = 0;
  let demos = 0;
  sim.events.onBump = (_x, _y, isDemo) => {
    bumps++;
    if (isDemo) demos++;
  };
  let top = 0;
  for (let t = 0; t < 60; t++) {
    sim.setControls(a, ctl({ throttle: 1 }));
    sim.step(1);
    sim.sync();
    top = Math.max(top, len(carVec(1, T.C_VEL)));
  }
  return { top, bumps, demos, demoed: car(1, T.C_IS_DEMOED) };
}

test('bump strength: the victim flies off faster with a stronger bump', () => {
  const none = bump({ bumpForce: 0 });
  const stock = bump({});
  const strong = bump({ bumpForce: 300 });
  assert.ok(stock.bumps >= 1, 'it was a bump');
  assert.ok(none.top < stock.top && stock.top < strong.top, `0/100/300 %: ${none.top} / ${stock.top} / ${strong.top}`);
});

test('demolitions: normal needs supersonic, on contact demolishes a slow bump, off never demolishes', () => {
  assert.equal(bump({ demoMode: 0 }, 1200).demos, 0, 'normal, 1200 uu/s: no demolition');
  assert.equal(bump({ demoMode: 1 }, 1200).demoed, 1, 'on contact, 1200 uu/s: demolished');
  assert.equal(bump({ demoMode: 2 }, 2290).demos, 0, 'off: never');
});

test('respawn time: a demolished car waits respawnDelay seconds', () => {
  for (const s of [1, 3, 5]) {
    arena(s === 3 ? null : { respawnDelay: s });
    sim.addCar(T.Team.Blue);
    const b = sim.addCar(T.Team.Red);
    sim.demolishCar(b);
    sim.sync();
    assert.equal(car(1, T.C_IS_DEMOED), 1);
    assert.ok(Math.abs(car(1, T.C_DEMO_RESPAWN_TIMER) - s) < 1e-6, `${s} s timer: ${car(1, T.C_DEMO_RESPAWN_TIMER)}`);
    sim.step(s * T.TICK_RATE - 2);
    sim.sync();
    assert.equal(car(1, T.C_IS_DEMOED), 1, `${s} s: still waiting`);
    sim.step(4);
    sim.sync();
    assert.equal(car(1, T.C_IS_DEMOED), 0, `${s} s: back`);
  }
});

// ---- rollback and determinism under a preset -----------------------------------------------

test('save / load under a preset: load + replay reproduces the run hash for hash', () => {
  arena({ gravity: 60, ballBounce: 140, carMaxSpeed: 2600, boostUse: 0, bumpForce: 250, demoMode: 1 });
  for (let i = 0; i < 2; i++) sim.addCar(T.Team.Blue);
  for (let i = 0; i < 2; i++) sim.addCar(T.Team.Red);
  sim.resetKickoff(5);
  const controls = (t, s) => ctl({ throttle: 1, steer: Math.sin(t * 0.03 + s), boost: (t + s * 17) % 90 < 50, jump: (t + s * 31) % 140 < 8, pitch: Math.cos(t * 0.05 + s) });
  const tickWith = (t) => {
    for (let s = 0; s < 4; s++) sim.setControls(sim.carIdOf(s), controls(t, s));
    sim.step(1);
  };
  for (let t = 0; t < 240; t++) tickWith(t);
  const blob = new Uint8Array(T.MAX_STATE_BYTES);
  const n = sim.saveState(blob);
  const hashes = [];
  for (let t = 240; t < 600; t++) {
    tickWith(t);
    hashes.push(sim.stateHash());
  }
  sim.loadState(blob, n);
  for (let t = 240; t < 600; t++) {
    tickWith(t);
    assert.equal(sim.stateHash(), hashes[t - 240], `tick ${t} after the load`);
  }
});

const DETERMINISM_PRESET = { gravity: 60, ballMaxSpeed: 120, ballHit: 150, ballWeight: 80, ballBounce: 120, carMaxSpeed: 2500, boostPower: 130, jumpPower: 120, bumpForce: 200 };

test('determinism: two module instances, the same preset, 60 s of 3v3 bots with the preset profile: the same hashes', async () => {
  const mutators = M.toMutators(DETERMINISM_PRESET);
  const physics = M.botPhysicsOf(DETERMINISM_PRESET);
  const other = await RocketSim.load();
  other.initArena(mesh);
  const a = await runStockTrace('bots-3v3', { sim, mutators, physics, ticks: 7200 });
  const b = await runStockTrace('bots-3v3', { sim: other, mutators, physics, ticks: 7200 });
  assert.deepEqual(b.hashes, a.hashes);
  assert.deepEqual(b.predHashes, a.predHashes);
  const stock = await runStockTrace('bots-3v3', { sim, ticks: 7200 });
  assert.notDeepEqual(a.hashes.slice(0, 5), stock.hashes.slice(0, 5), 'the preset changes the game');
  assert.ok(a.goals + a.bumps > 0, 'the bots play');
});

test('determinism: low gravity bots (bot profile from the preset) run the same twice', async () => {
  const values = R.BUILT_IN_PRESETS.find((p) => p.id === 'lowGravity').values;
  const opts = { mutators: M.toMutators(values), physics: M.botPhysicsOf(values), ticks: 3600 };
  const a = await runStockTrace('bots-3v3', { sim, ...opts });
  const b = await runStockTrace('bots-3v3', { sim, ...opts });
  assert.deepEqual(b.hashes, a.hashes);
});
