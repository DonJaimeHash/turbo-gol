// Node test harness for the RocketSim WebAssembly bridge. Run from the project root:
//   node --test tests/sim.test.mjs      (needs src/sim/wasm/rocketsim.{js,wasm}: npm run build:wasm)
//
// Node 24 strips TypeScript types natively but does not add extensions to bare relative imports,
// so a tiny resolve hook maps "./types" -> "./types.ts" for the TS modules imported below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { performance } from 'node:perf_hooks';

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

const { RocketSim } = await import('../src/sim/RocketSimBridge.ts');
const T = await import('../src/sim/types.ts');
const K = await import('../src/sim/constants.ts');

// ---- Arena mesh: use the real one if the arenaMesh agent delivered it, else a minimal stand-in.
function fallbackMesh() {
  const verts = [];
  const idx = [];
  const addV = (x, y, z) => {
    verts.push(x, y, z);
    return verts.length / 3 - 1;
  };
  // Quad a,b,c,d (any order); the winding is fixed so the triangle normal points along `inward`.
  const quad = (a, b, c, d, inward) => {
    const A = [verts[a * 3], verts[a * 3 + 1], verts[a * 3 + 2]];
    const B = [verts[b * 3], verts[b * 3 + 1], verts[b * 3 + 2]];
    const C = [verts[c * 3], verts[c * 3 + 1], verts[c * 3 + 2]];
    const ab = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
    const ac = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    const dot = n[0] * inward[0] + n[1] * inward[1] + n[2] * inward[2];
    if (dot >= 0) idx.push(a, b, c, a, c, d);
    else idx.push(a, c, b, a, d, c);
  };
  // Axis-aligned rectangle helper: plane fixed on `axis` at `v`, spanning [u0,u1]x[w0,w1] on the other two.
  const rect = (axis, v, u0, u1, w0, w1, inward) => {
    const P = (u, w) => (axis === 'x' ? addV(v, u, w) : axis === 'y' ? addV(u, v, w) : addV(u, w, v));
    quad(P(u0, w0), P(u1, w0), P(u1, w1), P(u0, w1), inward);
  };
  // A plain box field with the dimensions of constants.ts (no ramps, square corners).
  const A = K.ARENA;
  const X = A.extentX, Y = A.extentY, H = A.height, GW = A.goalHalfWidth, GH = A.goalHeight, GD = A.extentY + A.goalDepth;
  for (const s of [-1, 1]) {
    const inward = [0, -s, 0];
    // Back wall at y = s*Y with a 2*GW x GH opening.
    rect('y', s * Y, -X, -GW, 0, H, inward);
    rect('y', s * Y, GW, X, 0, H, inward);
    rect('y', s * Y, -GW, GW, GH, H, inward);
    // Goal box behind the opening (floor comes from RocketSim's global floor plane).
    rect('y', s * GD, -GW, GW, 0, GH, [0, -s, 0]); // net back
    rect('x', -GW, Math.min(s * Y, s * GD), Math.max(s * Y, s * GD), 0, GH, [1, 0, 0]); // left net wall
    rect('x', GW, Math.min(s * Y, s * GD), Math.max(s * Y, s * GD), 0, GH, [-1, 0, 0]); // right net wall
    rect('z', GH, -GW, GW, Math.min(s * Y, s * GD), Math.max(s * Y, s * GD), [0, 0, -1]); // net roof
  }
  return { vertices: new Float32Array(verts), indices: new Int32Array(idx) };
}

async function loadMesh() {
  try {
    const m = await import('../src/sim/arenaMesh.ts');
    if (typeof m.buildArenaMesh === 'function') {
      const built = m.buildArenaMesh();
      if (built && built.physics && built.physics.vertices && built.physics.indices) {
        console.log(`arena mesh: src/sim/arenaMesh.ts (${built.physics.vertices.length / 3} verts, ${built.physics.indices.length / 3} tris)`);
        return built.physics;
      }
    }
  } catch (err) {
    console.log(`arena mesh: fallback (arenaMesh.ts not usable: ${err && err.message ? err.message.split('\n')[0] : err})`);
  }
  return fallbackMesh();
}

const sim = await RocketSim.load();
sim.initArena(await loadMesh());

const { CARS_OFFSET, CAR_STRIDE, BALL_OFFSET } = T;
const car = (slot, field) => sim.buf[CARS_OFFSET + slot * CAR_STRIDE + field];
const carVec = (slot, field) => [car(slot, field), car(slot, field + 1), car(slot, field + 2)];
const ball = (field) => sim.buf[BALL_OFFSET + field];
const ballVec = (field) => [ball(field), ball(field + 1), ball(field + 2)];
const speed = (v) => Math.hypot(v[0], v[1], v[2]);
const controls = (over) => ({ ...T.emptyControls(), ...over });

function fresh() {
  sim.createArena();
  sim.events.onGoal = undefined;
  sim.events.onBump = undefined;
  sim.events.onBallHit = undefined;
}

test('1. load, version, arena, add car, car config', () => {
  assert.equal(sim.version, '2.2.1');
  fresh();
  assert.equal(sim.numCars, 0);
  const id = sim.addCar(T.Team.Blue, T.CarPreset.Standard);
  assert.ok(id > 0);
  assert.equal(sim.numCars, 1);
  assert.equal(sim.slotOf(id), 0);
  assert.equal(car(0, T.C_ID), id);
  assert.equal(car(0, T.C_TEAM), T.Team.Blue);
  const cfg = sim.getCarConfig(T.CarPreset.Standard);
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-3, `${a} != ${b}`);
  near(cfg.hitboxSize[0], 120.507);
  near(cfg.hitboxSize[1], 86.6994);
  near(cfg.hitboxSize[2], 38.6591);
  near(cfg.hitboxOffset[0], 13.8757);
  near(cfg.hitboxOffset[2], 20.755);
  near(cfg.frontWheelRadius, 12.5);
  near(cfg.backWheelRadius, 15.0);
  near(cfg.frontSuspensionRest, 38.755);
  near(cfg.backSuspensionRest, 37.055);
  near(cfg.frontWheelOffset[0], 51.25);
  near(cfg.frontWheelOffset[1], 25.9);
  near(cfg.backWheelOffset[0], -33.75);
  near(cfg.backWheelOffset[1], 29.5);
  near(cfg.dodgeDeadzone, 0.5);
  const tall = sim.getCarConfig(T.CarPreset.Tall);
  near(tall.hitboxSize[2], 44.1591);
});

test('2. throttle: drives forward along +x, reaches ~1410 uu/s in 2 s', () => {
  fresh();
  const id = sim.addCar(T.Team.Blue);
  sim.setCarState(id, [0, 0, 17], [0, 0, 0]);
  sim.setControls(id, controls({ throttle: 1 }));
  sim.step(240);
  sim.sync();
  const pos = carVec(0, T.C_POS);
  const vel = carVec(0, T.C_VEL);
  const s = speed(vel);
  console.log(`throttle 240 ticks: pos=(${pos.map((v) => v.toFixed(1))}) speed=${s.toFixed(1)}`);
  assert.ok(pos[0] > 1000, `x should increase, got ${pos[0]}`);
  assert.ok(Math.abs(pos[1]) < 50, `y should stay ~0, got ${pos[1]}`);
  assert.ok(s >= 1300 && s <= 1500, `speed ${s} not in [1300,1500]`);
  assert.equal(car(0, T.C_IS_ON_GROUND), 1);
  assert.equal(car(0, T.C_IS_SUPERSONIC), 0);
});

test('3. boost + throttle reaches 2300 uu/s and is supersonic', () => {
  fresh();
  const id = sim.addCar(T.Team.Blue);
  sim.setCarState(id, [-3000, 0, 17], [0, 0, 0]);
  sim.setCarBoost(id, 100);
  sim.setControls(id, controls({ throttle: 1, boost: true }));
  sim.step(300);
  sim.sync();
  const s = speed(carVec(0, T.C_VEL));
  console.log(`boost 300 ticks: speed=${s.toFixed(1)} boost=${car(0, T.C_BOOST).toFixed(1)}`);
  assert.ok(s > 2290 && s <= 2301, `speed ${s}`);
  assert.equal(car(0, T.C_IS_SUPERSONIC), 1);
  assert.ok(car(0, T.C_BOOST) < 100);
});

test('4. steer sign: steer=+1 with throttle from yaw 0', () => {
  fresh();
  const id = sim.addCar(T.Team.Blue);
  sim.setCarState(id, [0, 0, 17], [0, 0, 0]);
  sim.setControls(id, controls({ throttle: 1, steer: 1 }));
  sim.step(120);
  sim.sync();
  const pos = carVec(0, T.C_POS);
  const fwd = carVec(0, T.C_ROT);
  console.log(`steer +1, 120 ticks: pos=(${pos.map((v) => v.toFixed(1))}) forward=(${fwd.map((v) => v.toFixed(3))})`);
  assert.ok(pos[0] > 100, 'car should have moved forward (+x)');
  // steer=+1 turns the car toward +y (car local +y is right, so from yaw 0 the car
  // curves toward world +y and its forward vector gains a positive y component).
  assert.ok(pos[1] > 50, `steer=+1 should move the car toward +y, got y=${pos[1]}`);
  assert.ok(fwd[1] > 0.1, `forward.y should become positive, got ${fwd[1]}`);
  assert.ok(Math.abs(car(0, T.C_WHEEL_STEER + 0)) > 0.01 && Math.abs(car(0, T.C_WHEEL_STEER + 1)) > 0.01, 'front wheels steer');
  assert.equal(car(0, T.C_WHEEL_STEER + 2), 0, 'back wheels do not steer');
});

test('5. jump: 1-tick press leaves the ground', () => {
  fresh();
  const id = sim.addCar(T.Team.Blue);
  sim.setCarState(id, [0, 0, 17], [0, 0, 0]);
  sim.step(10); // settle on the wheels
  sim.sync();
  assert.equal(car(0, T.C_IS_ON_GROUND), 1);
  assert.equal(car(0, T.C_WHEEL_CONTACT + 0) + car(0, T.C_WHEEL_CONTACT + 1) + car(0, T.C_WHEEL_CONTACT + 2) + car(0, T.C_WHEEL_CONTACT + 3), 4);
  const z0 = car(0, T.C_POS + 2);
  sim.setControls(id, controls({ jump: true }));
  sim.step(1);
  sim.setControls(id, controls({}));
  sim.step(29);
  sim.sync();
  const z = car(0, T.C_POS + 2);
  console.log(`jump: z ${z0.toFixed(1)} -> ${z.toFixed(1)}`);
  assert.ok(z > z0 + 20, `z should increase, ${z0} -> ${z}`);
  assert.equal(car(0, T.C_IS_ON_GROUND), 0);
  assert.equal(car(0, T.C_HAS_JUMPED), 1);
  assert.ok(car(0, T.C_AIR_TIME) > 0.1);
});

test('6. ball dropped from z=1000 settles at rest height', () => {
  fresh();
  sim.setBallState([0, 0, 1000]);
  sim.step(600);
  sim.sync();
  const z600 = ball(T.B_POS + 2);
  sim.step(600);
  sim.sync();
  const z = ball(T.B_POS + 2);
  console.log(`ball drop: z after 600 ticks = ${z600.toFixed(2)}, after 1200 = ${z.toFixed(2)} (rest ${K.BALL.restZ})`);
  assert.ok(Math.abs(z - 93.15) < 2, `ball z ${z} not near 93.15`);
  assert.ok(speed(ballVec(T.B_VEL)) < 5);
  assert.ok(Math.abs(ball(T.B_POS)) < 1 && Math.abs(ball(T.B_POS + 1)) < 1);
});

test('7. goal: ball shot into the +y net -> onGoal(Blue), H_GOAL_COUNT++, rs_is_ball_scored', () => {
  fresh();
  const goals = [];
  sim.events.onGoal = (team) => goals.push({ team, tick: sim.tickCount });
  sim.setBallState([0, 4000, 300], [0, 3000, 0]);
  let scoredAtGoalTick = false;
  let goalCountAtGoal = 0;
  for (let i = 0; i < 120 && goals.length === 0; i++) {
    sim.step(1);
    sim.sync();
    if (goals.length === 1) {
      scoredAtGoalTick = sim.isBallScored();
      goalCountAtGoal = sim.buf[T.H_GOAL_COUNT];
    }
  }
  assert.equal(goals.length, 1, 'exactly one goal event');
  assert.equal(goals[0].team, T.Team.Blue);
  assert.equal(sim.buf[T.H_LAST_GOAL_TEAM], T.Team.Blue);
  assert.equal(goalCountAtGoal, 1);
  assert.equal(scoredAtGoalTick, true);
  assert.equal(sim.buf[T.H_BALL_SCORED], 1);
  // The ball staying in the net must NOT produce more goals.
  sim.step(60);
  sim.sync();
  assert.equal(goals.length, 1);
  assert.equal(sim.buf[T.H_GOAL_COUNT], 1);
  // Reset and score again in the -y net: red scores, counter increments.
  sim.setBallState([0, -4000, 300], [0, -3000, 0]);
  sim.step(120);
  sim.sync();
  assert.equal(goals.length, 2);
  assert.equal(goals[1].team, T.Team.Red);
  assert.equal(sim.buf[T.H_GOAL_COUNT], 2);
});

test('8. resetKickoff(0): mirrored spawns, ball at centre', () => {
  fresh();
  const blue = sim.addCar(T.Team.Blue);
  const red = sim.addCar(T.Team.Red);
  sim.resetKickoff(0);
  sim.sync();
  const b = carVec(sim.slotOf(blue), T.C_POS);
  const o = carVec(sim.slotOf(red), T.C_POS);
  console.log(`kickoff: blue=(${b.map((v) => v.toFixed(0))}) red=(${o.map((v) => v.toFixed(0))})`);
  assert.ok(Math.abs(b[0] + o[0]) < 1 && Math.abs(b[1] + o[1]) < 1, 'x,y mirrored');
  assert.ok(Math.abs(b[2] - o[2]) < 1);
  assert.ok(b[1] < 0 && o[1] > 0, 'blue on -y, red on +y');
  const spawn = K.KICKOFF_SPAWNS.find((s) => Math.abs(s[0] - b[0]) < 1 && Math.abs(s[1] - b[1]) < 1);
  assert.ok(spawn, 'blue car on one of the kickoff spawns');
  const bf = carVec(sim.slotOf(blue), T.C_ROT);
  const of = carVec(sim.slotOf(red), T.C_ROT);
  assert.ok(Math.abs(bf[0] + of[0]) < 1e-3 && Math.abs(bf[1] + of[1]) < 1e-3, 'forward vectors mirrored');
  assert.ok(Math.abs(Math.atan2(bf[1], bf[0]) - spawn[2]) < 1e-3, 'blue yaw matches spawn yaw');
  const bp = ballVec(T.B_POS);
  assert.ok(Math.abs(bp[0]) < 1e-3 && Math.abs(bp[1]) < 1e-3 && Math.abs(bp[2] - 93.15) < 1, `ball at ${bp}`);
  assert.ok(Math.abs(car(0, T.C_BOOST) - 100 / 3) < 0.01, 'kickoff boost 33.3');
  // Deterministic for the same seed.
  sim.resetKickoff(0);
  sim.sync();
  const b2 = carVec(sim.slotOf(blue), T.C_POS);
  assert.deepEqual(b2, b);
});

test('9. ball prediction matches the real arena', () => {
  fresh();
  sim.setBallState([0, 0, 500], [600, 400, 300], [1, 0, 0]);
  let t0 = performance.now();
  sim.updateBallPrediction(); // first call: creates the predictor arena + full 720-tick prediction
  const tFirst = performance.now() - t0;
  sim.setBallState([0, 0, 500], [-600, 400, 300], [1, 0, 0]);
  t0 = performance.now();
  sim.updateBallPrediction(); // disturbed ball: full re-prediction (720 ball-only ticks)
  const tFull = performance.now() - t0;
  sim.step(1);
  sim.sync();
  t0 = performance.now();
  sim.updateBallPrediction(); // undisturbed: incremental (1 ball tick)
  const tIncr = performance.now() - t0;
  console.log(`ball pred cost: first=${tFirst.toFixed(2)}ms full re-pred=${tFull.toFixed(2)}ms incremental=${(tIncr * 1000).toFixed(0)}us`);
  fresh();
  sim.setBallState([0, 0, 500], [600, 400, 300], [1, 0, 0]);
  sim.updateBallPrediction();
  const p0 = [sim.ballPred[0], sim.ballPred[1], sim.ballPred[2]];
  const p119 = [sim.ballPred[119 * 6], sim.ballPred[119 * 6 + 1], sim.ballPred[119 * 6 + 2]];
  sim.step(1);
  sim.sync();
  const b1 = ballVec(T.B_POS);
  const d1 = Math.hypot(p0[0] - b1[0], p0[1] - b1[1], p0[2] - b1[2]);
  sim.step(119);
  sim.sync();
  const b120 = ballVec(T.B_POS);
  const d120 = Math.hypot(p119[0] - b120[0], p119[1] - b120[1], p119[2] - b120[2]);
  console.log(`ball pred: err@1=${d1.toFixed(3)} err@120=${d120.toFixed(3)} (pos@120=${b120.map((v) => v.toFixed(1))})`);
  assert.ok(d1 < 1, `pred[0] off by ${d1}`);
  assert.ok(d120 < 1, `pred[119] off by ${d120}`);
  // Incremental update after stepping keeps matching (entry 0 == next tick).
  sim.updateBallPrediction();
  const q0 = [sim.ballPred[0], sim.ballPred[1], sim.ballPred[2]];
  sim.step(1);
  sim.sync();
  const b121 = ballVec(T.B_POS);
  assert.ok(Math.hypot(q0[0] - b121[0], q0[1] - b121[1], q0[2] - b121[2]) < 1);
  assert.equal(sim.ballPred.length, T.BALL_PRED_TICKS * T.BALL_PRED_STRIDE);
});

test('10. performance: 12000 ticks with 2 cars', () => {
  fresh();
  const a = sim.addCar(T.Team.Blue);
  const b = sim.addCar(T.Team.Red, T.CarPreset.Low);
  sim.resetKickoff(1);
  let hits = 0;
  sim.events.onBallHit = () => hits++;
  const t0 = performance.now();
  for (let i = 0; i < 12000; i++) {
    const phase = (i / 120) % 8;
    sim.setControls(a, controls({ throttle: 1, steer: Math.sin(i / 60), boost: phase < 2, jump: i % 400 === 0 }));
    sim.setControls(b, controls({ throttle: 1, steer: Math.cos(i / 90), boost: phase > 5, handbrake: i % 300 < 20 }));
    sim.step(1);
    sim.sync();
    if (i % 4 === 0) sim.updateBallPrediction();
  }
  const dt = (performance.now() - t0) / 1000;
  console.log(`perf: 12000 ticks (2 cars, sync every tick, ball pred every 4) in ${dt.toFixed(3)} s = ${(12000 / dt).toFixed(0)} ticks/s, ball hits=${hits}`);
  assert.ok(dt < 1.5, `too slow: ${dt}s`);
  assert.equal(sim.tickCount, 12000);
  assert.equal(sim.numCars, 2);
  // Nothing escaped the arena.
  for (const slot of [0, 1]) {
    const p = carVec(slot, T.C_POS);
    assert.ok(Math.abs(p[0]) < 4200 && Math.abs(p[1]) < 6100 && p[2] > -10 && p[2] < 2100, `car ${slot} at ${p}`);
  }
  const bp = ballVec(T.B_POS);
  assert.ok(Math.abs(bp[0]) < 4200 && Math.abs(bp[1]) < 6100 && bp[2] > 0 && bp[2] < 2100, `ball at ${bp}`);
});

test('11. remove car, destroy arena, snapshot', () => {
  fresh();
  const a = sim.addCar(T.Team.Blue);
  const b = sim.addCar(T.Team.Red);
  assert.equal(sim.numCars, 2);
  sim.removeCar(a);
  assert.equal(sim.numCars, 1);
  assert.equal(sim.slotOf(b), 0);
  assert.equal(sim.slotOf(a), -1);
  const snap = new Float32Array(T.STATE_BUFFER_FLOATS);
  sim.snapshotInto(snap);
  assert.equal(snap[T.H_NUM_CARS], 1);
  sim.destroyArena();
  sim.step(10); // no-ops without an arena
  sim.sync();
  sim.createArena();
  assert.equal(sim.numCars, 0);
  assert.equal(sim.tickCount, 0);
});

test('12. ball prediction age: entries are anchored to the refresh tick (predTick)', async () => {
  fresh();
  sim.setBallState([0, 0, 500], [600, 400, 300], [1, 0, 0]);
  sim.step(5);
  sim.sync();
  sim.updateBallPrediction();
  assert.equal(sim.predTick, sim.tickCount);
  // Step 3 ticks WITHOUT refreshing: a consumer now sees age 3 and must read entry 3 for "next tick".
  sim.step(3);
  sim.sync();
  const age = sim.tickCount - sim.predTick;
  assert.equal(age, 3);
  const aged = [sim.ballPred[age * 6], sim.ballPred[age * 6 + 1], sim.ballPred[age * 6 + 2]];
  const naive = [sim.ballPred[0], sim.ballPred[1], sim.ballPred[2]];
  const { predictBallAt } = await import('../src/ai/Bot.ts');
  const out = new Float32Array(6);
  predictBallAt(sim, 1 / 120, out); // the bot helper applies the age itself
  sim.step(1);
  sim.sync();
  const b = ballVec(T.B_POS);
  const dAged = Math.hypot(aged[0] - b[0], aged[1] - b[1], aged[2] - b[2]);
  const dNaive = Math.hypot(naive[0] - b[0], naive[1] - b[1], naive[2] - b[2]);
  const dHelper = Math.hypot(out[0] - b[0], out[1] - b[1], out[2] - b[2]);
  console.log(`pred age 3: aged entry err=${dAged.toFixed(3)} naive entry err=${dNaive.toFixed(3)} predictBallAt err=${dHelper.toFixed(3)}`);
  assert.ok(dAged < 1, `aged entry off by ${dAged}`);
  assert.ok(dHelper < 1, `predictBallAt off by ${dHelper}`);
  assert.ok(dNaive > 5, `naive entry should be ~3 ticks early, was off by only ${dNaive}`);
  // A refresh resets the age to 0.
  sim.updateBallPrediction();
  assert.equal(sim.tickCount - sim.predTick, 0);
});

test('13. car-car bump: a mutual head-on bump counts once; a demo keeps the demo direction', () => {
  // Both at 1500 uu/s (nobody supersonic): RocketSim fires the callback for BOTH directions in the
  // same tick; the wrapper must merge them into one bump.
  fresh();
  const a = sim.addCar(T.Team.Blue);
  const b = sim.addCar(T.Team.Red);
  sim.setCarState(a, [-600, 0, 17], [0, 0, 0], [1500, 0, 0]);
  sim.setCarState(b, [600, 0, 17], [Math.PI, 0, 0], [-1500, 0, 0]);
  let events = [];
  sim.events.onBump = (bumper, victim, isDemo) => events.push({ bumper, victim, isDemo });
  let prev = 0;
  let maxDelta = 0;
  for (let t = 0; t < 120; t++) {
    sim.step(1);
    sim.sync();
    const c = sim.buf[T.H_BUMP_COUNT];
    if (c !== prev) maxDelta = Math.max(maxDelta, c - prev);
    prev = c;
  }
  assert.equal(sim.buf[T.H_BUMP_COUNT], 1, 'one physical bump = one count');
  assert.equal(maxDelta, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].isDemo, false);
  assert.ok((events[0].bumper === a && events[0].victim === b) || (events[0].bumper === b && events[0].victim === a));

  // A slow car rolling into a supersonic one, in both creation orders (Bullet body order decides
  // which direction fires first): exactly one bump, flagged as a demo, victim = the slow car.
  for (const slowFirst of [true, false]) {
    fresh();
    let slow;
    let fast;
    if (slowFirst) {
      slow = sim.addCar(T.Team.Blue);
      fast = sim.addCar(T.Team.Red);
    } else {
      fast = sim.addCar(T.Team.Red);
      slow = sim.addCar(T.Team.Blue);
    }
    // 400 uu apart so the bumper-to-bumper contact happens while the fast car is still supersonic
    // (a longer run-up lets Bullet's contact resolution bleed its speed before the callback).
    sim.setCarState(slow, [-100, 0, 17], [0, 0, 0], [300, 0, 0]);
    sim.setCarState(fast, [300, 0, 17], [Math.PI, 0, 0], [-2300, 0, 0]);
    sim.setCarBoost(fast, 100);
    sim.setControls(fast, controls({ throttle: 1, boost: true }));
    sim.setControls(slow, controls({ throttle: 0.3 }));
    events = [];
    sim.events.onBump = (bumper, victim, isDemo) => events.push({ bumper, victim, isDemo });
    for (let t = 0; t < 120 && events.length === 0; t++) {
      sim.step(1);
      sim.sync();
    }
    assert.equal(events.length, 1, `slowFirst=${slowFirst}: one bump event`);
    assert.equal(sim.buf[T.H_BUMP_COUNT], 1, `slowFirst=${slowFirst}: count 1`);
    assert.equal(events[0].isDemo, true, `slowFirst=${slowFirst}: demo`);
    assert.equal(events[0].victim, slow, `slowFirst=${slowFirst}: victim is the slow car`);
    assert.equal(events[0].bumper, fast);
    assert.equal(car(sim.slotOf(slow), T.C_IS_DEMOED), 1);
  }
});

test('14. a ball re-placed inside the net every tick (goal pause pin) does not re-count the goal', () => {
  fresh();
  const goals = [];
  sim.events.onGoal = (team) => goals.push(team);
  sim.setBallState([0, 4000, 300], [0, 3000, 0]);
  for (let i = 0; i < 240 && goals.length === 0; i++) {
    sim.step(1);
    sim.sync();
  }
  assert.equal(goals.length, 1);
  const pin = ballVec(T.B_POS);
  // What Game.pinBall() does for the 3 s pause: hold x/y, keep z / vz so the ball settles in the net.
  const pos = [pin[0], pin[1], 0];
  const vel = [0, 0, 0];
  for (let i = 0; i < 360; i++) {
    pos[2] = ball(T.B_POS + 2);
    vel[2] = ball(T.B_VEL + 2);
    sim.setBallState(pos, vel);
    sim.step(1);
    sim.sync();
    assert.equal(sim.buf[T.H_BALL_SCORED], 1, `tick ${i}: still in the net`);
  }
  assert.equal(goals.length, 1, 'no second goal event while pinned');
  assert.equal(sim.buf[T.H_GOAL_COUNT], 1);
  const bp = ballVec(T.B_POS);
  assert.ok(Math.abs(bp[0] - pin[0]) < 1 && Math.abs(bp[1] - pin[1]) < 1, `ball held at ${bp} vs ${pin}`);
  assert.ok(bp[2] < 200, `ball settled (z=${bp[2]})`);
  // Placing the ball OUTSIDE a net still forgets the goal, so its next entry is a new goal.
  sim.setBallState([0, -4000, 300], [0, -3000, 0]);
  sim.step(120);
  sim.sync();
  assert.equal(goals.length, 2);
  assert.equal(goals[1], T.Team.Red);
});

// ---- 8-car layout, teams, kickoffs, 3v3 performance (MAX_CARS 8 / STATE_BUFFER_FLOATS 1024) ----

test('15. layout: the wasm agrees with types.ts (pads at PADS_OFFSET, 8 car slots, padding stays 0)', () => {
  const { PADS_OFFSET, PAD_STRIDE, P_IS_ACTIVE, P_COOLDOWN, NUM_BOOST_PADS, STATE_BUFFER_SIZE, STATE_BUFFER_FLOATS, MAX_CARS } = T;
  assert.equal(MAX_CARS, 8);
  assert.equal(PADS_OFFSET, 560);
  assert.equal(NUM_BOOST_PADS, K.BOOST_PADS_BIG.length + K.BOOST_PADS_SMALL.length);
  assert.equal(STATE_BUFFER_SIZE, 560 + 2 * NUM_BOOST_PADS);
  assert.equal(STATE_BUFFER_SIZE, 624);
  assert.equal(STATE_BUFFER_FLOATS, 1024);
  assert.equal(sim.buf.length, STATE_BUFFER_FLOATS);
  fresh();
  // rs_sync writes every pad as active at PADS_OFFSET: a wrapper still built with MAX_CARS 4
  // would write them at 304 and leave 560.. at zero.
  for (let i = 0; i < NUM_BOOST_PADS; i++) {
    assert.equal(sim.buf[PADS_OFFSET + i * PAD_STRIDE + P_IS_ACTIVE], 1, `pad ${i} active at PADS_OFFSET`);
    assert.equal(sim.buf[PADS_OFFSET + i * PAD_STRIDE + P_COOLDOWN], 0, `pad ${i} cooldown 0`);
  }
  // Nothing is written past the last pad (the old 4-car pads region 304..371 is now car slot 4).
  for (let i = STATE_BUFFER_SIZE; i < STATE_BUFFER_FLOATS; i++) assert.equal(sim.buf[i], 0, `buf[${i}] padding`);
  for (let i = 304; i < 372; i++) assert.equal(sim.buf[i], 0, `buf[${i}] (car slot 4 region) empty before cars are added`);

  // Fill all 8 slots: ids / teams land in their own slot, slot 7 ends at 559, pads survive at 560.
  const ids = [];
  for (let i = 0; i < MAX_CARS; i++) ids.push(sim.addCar(i % 2 === 0 ? T.Team.Blue : T.Team.Red, i % 6));
  assert.equal(sim.numCars, 8);
  for (let slot = 0; slot < MAX_CARS; slot++) {
    assert.equal(car(slot, T.C_ID), ids[slot], `slot ${slot} id`);
    assert.equal(car(slot, T.C_TEAM), slot % 2, `slot ${slot} team`);
    assert.equal(sim.slotOf(ids[slot]), slot);
  }
  assert.equal(CARS_OFFSET + 7 * CAR_STRIDE + CAR_STRIDE, PADS_OFFSET, 'slot 7 ends exactly where the pads start');
  sim.step(2);
  sim.sync();
  for (let i = 0; i < NUM_BOOST_PADS; i++) assert.equal(sim.buf[PADS_OFFSET + i * PAD_STRIDE + P_IS_ACTIVE], 1, `pad ${i} still active with 8 cars`);
  for (let i = STATE_BUFFER_SIZE; i < STATE_BUFFER_FLOATS; i++) assert.equal(sim.buf[i], 0, `buf[${i}] padding with 8 cars`);
  // All 8 cars are simulated (they fell onto their wheels at distinct places, nothing NaN).
  for (let slot = 0; slot < MAX_CARS; slot++) {
    const p = carVec(slot, T.C_POS);
    assert.ok(p.every(Number.isFinite), `slot ${slot} finite`);
    assert.ok(p[2] > 0 && p[2] < 100, `slot ${slot} z=${p[2]}`);
  }
});

test('16. addCar beyond MAX_CARS throws (no crash), the arena keeps working', () => {
  fresh();
  for (let i = 0; i < T.MAX_CARS; i++) sim.addCar(i < 4 ? T.Team.Blue : T.Team.Red);
  assert.throws(() => sim.addCar(T.Team.Blue), /MAX_CARS \(8\) reached/);
  assert.equal(sim.numCars, 8);
  // Still alive: a kickoff, a tick and a car removal work and the module did not abort.
  sim.resetKickoff(3);
  sim.step(10);
  sim.sync();
  assert.equal(sim.tickCount, 10);
  const last = sim.carIdOf(7);
  sim.removeCar(last);
  assert.equal(sim.numCars, 7);
  const again = sim.addCar(T.Team.Red);
  assert.equal(sim.slotOf(again), 7);
  assert.equal(sim.numCars, 8);
  assert.throws(() => sim.addCar(T.Team.Red));
  sim.destroyArena();
  assert.throws(() => sim.addCar(T.Team.Blue), /no arena/);
});

function checkKickoff(teamSize, seed) {
  fresh();
  const blue = [];
  const red = [];
  // Interleave creation so slot order is not team order.
  for (let i = 0; i < teamSize; i++) {
    blue.push(sim.addCar(T.Team.Blue, i));
    red.push(sim.addCar(T.Team.Red, i + 1));
  }
  sim.resetKickoff(seed);
  sim.sync();
  assert.equal(sim.numCars, teamSize * 2);
  const spawnIndexOf = (x, y) => K.KICKOFF_SPAWNS.findIndex((s) => Math.abs(s[0] - x) < 1 && Math.abs(s[1] - y) < 1);
  const blueSpots = [];
  const redSpots = [];
  for (let i = 0; i < teamSize; i++) {
    const bs = sim.slotOf(blue[i]);
    const os = sim.slotOf(red[i]);
    const b = carVec(bs, T.C_POS);
    const o = carVec(os, T.C_POS);
    assert.ok(b[1] < 0, `blue car ${i} on -y (y=${b[1]})`);
    assert.ok(o[1] > 0, `red car ${i} on +y (y=${o[1]})`);
    const bi = spawnIndexOf(b[0], b[1]);
    const oi = spawnIndexOf(-o[0], -o[1]);
    assert.ok(bi >= 0, `blue car ${i} at (${b[0]}, ${b[1]}) is not a kickoff spawn`);
    assert.ok(oi >= 0, `red car ${i} at (${o[0]}, ${o[1]}) is not a mirrored kickoff spawn`);
    blueSpots.push(bi);
    redSpots.push(oi);
    assert.ok(Math.abs(b[2] - 17) < 1 && Math.abs(o[2] - 17) < 1, 'rest height');
    // Yaw matches the spawn (red = blue yaw + pi) and the car points along the ground.
    const bf = carVec(bs, T.C_ROT);
    const of = carVec(os, T.C_ROT);
    assert.ok(Math.abs(Math.atan2(bf[1], bf[0]) - K.KICKOFF_SPAWNS[bi][2]) < 1e-3, `blue car ${i} yaw`);
    const oyaw = Math.atan2(of[1], of[0]);
    const want = K.KICKOFF_SPAWNS[oi][2] + Math.PI;
    const dyaw = Math.atan2(Math.sin(oyaw - want), Math.cos(oyaw - want));
    assert.ok(Math.abs(dyaw) < 1e-3, `red car ${i} yaw ${oyaw} vs ${want}`);
    assert.ok(Math.abs(car(bs, T.C_BOOST) - 100 / 3) < 0.01 && Math.abs(car(os, T.C_BOOST) - 100 / 3) < 0.01, 'kickoff boost 33.3');
    assert.equal(speed(carVec(bs, T.C_VEL)), 0);
    assert.equal(speed(carVec(os, T.C_VEL)), 0);
  }
  assert.equal(new Set(blueSpots).size, teamSize, `blue cars on distinct spawns: ${blueSpots}`);
  assert.equal(new Set(redSpots).size, teamSize, `red cars on distinct spawns: ${redSpots}`);
  assert.deepEqual([...blueSpots].sort(), [...redSpots].sort(), 'red uses the mirror of the blue spots');
  const bp = ballVec(T.B_POS);
  assert.ok(Math.abs(bp[0]) < 1e-3 && Math.abs(bp[1]) < 1e-3 && Math.abs(bp[2] - 93.15) < 1, `ball at ${bp}`);
  assert.equal(speed(ballVec(T.B_VEL)), 0);
  // Nobody overlaps after settling (no two cars spawned into each other).
  sim.step(30);
  sim.sync();
  for (let a = 0; a < teamSize * 2; a++) {
    for (let b = a + 1; b < teamSize * 2; b++) {
      const pa = carVec(a, T.C_POS);
      const pb = carVec(b, T.C_POS);
      assert.ok(Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) > 300, `cars ${a} and ${b} overlap after kickoff`);
    }
  }
  return { blueSpots, redSpots };
}

test('17. kickoff 2v2: both blue cars on distinct kickoff spots, red mirrored, ball at centre', () => {
  const seeded = checkKickoff(2, 0);
  console.log(`kickoff 2v2 seed 0: blue spots ${seeded.blueSpots}, red spots ${seeded.redSpots}`);
  checkKickoff(2, 5);
  checkKickoff(2, -1); // random seed
  // Same seed, same layout (deterministic).
  const again = checkKickoff(2, 0);
  assert.deepEqual(again.blueSpots, seeded.blueSpots);
});

test('18. kickoff 3v3 (and 4v4): all cars on distinct kickoff spots', () => {
  const seen = new Set();
  for (const seed of [0, 1, 2, 7, 11]) {
    const r = checkKickoff(3, seed);
    seen.add(r.blueSpots.join(','));
  }
  console.log(`kickoff 3v3: ${seen.size} distinct layouts over 5 seeds`);
  assert.ok(seen.size >= 2, 'the kickoff order is shuffled by the seed');
  checkKickoff(3, -1);
  checkKickoff(4, 0); // 8 cars: the full buffer, still 4 distinct spots per team
});

// The wrapper deals OUR kickoff spots (constants.ts KICKOFF_SPAWNS) in creation order from the
// seed: the k-th created blue car and the k-th created red car take mirrored spots, and a seed
// alone fixes the whole line-up (RocketSim's own deal follows the iteration order of its
// unordered_set<Car*>, which made the same seeded 3v3 run differ between processes).
test('21. kickoff deal: blue car k and red car k mirror each other, by creation order and seed only', () => {
  for (const teamSize of [2, 3, 4]) {
    const layouts = new Set();
    for (const seed of [0, 1, 2, 3, 5, 7, 11]) {
      const r = checkKickoff(teamSize, seed);
      assert.deepEqual(r.redSpots, r.blueSpots, `${teamSize}v${teamSize} seed ${seed}: car k of each team on mirrored spots`);
      const again = checkKickoff(teamSize, seed);
      assert.deepEqual(again.blueSpots, r.blueSpots, `${teamSize}v${teamSize} seed ${seed}: same seed, same deal`);
      layouts.add(r.blueSpots.join(','));
    }
    assert.ok(layouts.size >= 2, `${teamSize}v${teamSize}: the deal varies with the seed`);
  }
});

test('19. team helpers: teamOf / slotsOfTeam / carIdOf, and slots compact on removeCar', () => {
  fresh();
  const a = sim.addCar(T.Team.Blue);
  const b = sim.addCar(T.Team.Red);
  const c = sim.addCar(T.Team.Blue);
  const d = sim.addCar(T.Team.Red);
  const e = sim.addCar(T.Team.Blue);
  assert.deepEqual([a, b, c, d, e].map((id) => sim.slotOf(id)), [0, 1, 2, 3, 4]);
  assert.deepEqual([0, 1, 2, 3, 4].map((s) => sim.carIdOf(s)), [a, b, c, d, e]);
  assert.equal(sim.carIdOf(5), 0);
  assert.equal(sim.carIdOf(-1), 0);
  assert.equal(sim.carIdOf(99), 0);
  assert.deepEqual([0, 1, 2, 3, 4].map((s) => sim.teamOf(s)), [T.Team.Blue, T.Team.Red, T.Team.Blue, T.Team.Red, T.Team.Blue]);
  assert.equal(sim.teamOf(7), T.Team.Blue);
  const out = new Int32Array(T.MAX_CARS);
  assert.equal(sim.slotsOfTeam(T.Team.Blue, out), 3);
  assert.deepEqual([...out.subarray(0, 3)], [0, 2, 4]);
  assert.equal(sim.slotsOfTeam(T.Team.Red, out), 2);
  assert.deepEqual([...out.subarray(0, 2)], [1, 3]);
  // A short output array caps the count (no overflow).
  const two = new Int32Array(2);
  assert.equal(sim.slotsOfTeam(T.Team.Blue, two), 2);
  assert.deepEqual([...two], [0, 2]);

  // Remove the middle red car: everyone after it shifts down one slot, ids are unchanged.
  sim.removeCar(b);
  assert.equal(sim.numCars, 4);
  assert.equal(sim.slotOf(b), -1);
  assert.deepEqual([a, c, d, e].map((id) => sim.slotOf(id)), [0, 1, 2, 3]);
  assert.deepEqual([0, 1, 2, 3].map((s) => sim.carIdOf(s)), [a, c, d, e]);
  assert.equal(sim.carIdOf(4), 0, 'trailing slot cleared');
  assert.equal(car(4, T.C_ID), 0);
  assert.deepEqual([0, 1, 2, 3].map((s) => sim.teamOf(s)), [T.Team.Blue, T.Team.Blue, T.Team.Red, T.Team.Blue]);
  assert.equal(sim.slotsOfTeam(T.Team.Blue, out), 3);
  assert.deepEqual([...out.subarray(0, 3)], [0, 1, 3]);
  assert.equal(sim.slotsOfTeam(T.Team.Red, out), 1);
  assert.equal(out[0], 2);
  // Unknown id: no-op.
  sim.removeCar(b);
  sim.removeCar(12345);
  assert.equal(sim.numCars, 4);
  // A new car takes the next free slot (4); the removed id is never reused.
  const f = sim.addCar(T.Team.Red);
  assert.notEqual(f, b);
  assert.equal(sim.slotOf(f), 4);
  assert.equal(sim.slotsOfTeam(T.Team.Red, out), 2);
  assert.deepEqual([...out.subarray(0, 2)], [2, 4]);
  // The shifted cars keep simulating in their new slots (ball hit events are per id, not per slot).
  const hits = [];
  sim.events.onBallHit = (id) => hits.push(id);
  sim.setBallState([0, 0, 93.15]);
  sim.setCarState(c, [-500, 0, 17], [0, 0, 0], [1200, 0, 0]);
  sim.setControls(c, controls({ throttle: 1 }));
  for (let t = 0; t < 120 && hits.length === 0; t++) {
    sim.step(1);
    sim.sync();
  }
  assert.deepEqual(hits, [c], 'the shifted car (now slot 1) reports its own id on a ball touch');
});

test('20. performance: 3v3 (6 cars), 12000 ticks, sync every tick, ball prediction every 4', () => {
  fresh();
  const ids = [];
  for (let i = 0; i < 3; i++) {
    ids.push(sim.addCar(T.Team.Blue, i));
    ids.push(sim.addCar(T.Team.Red, i + 3));
  }
  sim.resetKickoff(2);
  let hits = 0;
  let bumps = 0;
  sim.events.onBallHit = () => hits++;
  sim.events.onBump = () => bumps++;
  const ctl = ids.map(() => T.emptyControls());
  const buf = sim.buf;
  const t0 = performance.now();
  for (let i = 0; i < 12000; i++) {
    const bx = buf[BALL_OFFSET + T.B_POS];
    const by = buf[BALL_OFFSET + T.B_POS + 1];
    for (let k = 0; k < ids.length; k++) {
      // Everyone chases the ball (steer by the sign of forward x toBall), the way a match loads
      // the sim: constant car-ball and car-car contacts, frequent full ball re-predictions.
      const o = sim.carOffset(k);
      const dx = bx - buf[o + T.C_POS];
      const dy = by - buf[o + T.C_POS + 1];
      const fx = buf[o + T.C_ROT];
      const fy = buf[o + T.C_ROT + 1];
      const cross = fx * dy - fy * dx;
      const c = ctl[k];
      c.throttle = 1;
      c.steer = cross > 0 ? 1 : -1;
      c.boost = (i / 120 + k) % 8 < 2;
      c.jump = (i + k * 37) % 400 === 0;
      c.handbrake = (i + k * 50) % 300 < 20;
      sim.setControls(ids[k], c);
    }
    sim.step(1);
    sim.sync();
    if (i % 4 === 0) sim.updateBallPrediction();
  }
  const dt = (performance.now() - t0) / 1000;
  console.log(
    `perf 3v3: 12000 ticks (6 cars, sync every tick, ball pred every 4) in ${dt.toFixed(3)} s = ${(12000 / dt).toFixed(0)} ticks/s, ${((dt / 12) * 1000).toFixed(1)} us/tick, ball hits=${hits} bumps=${bumps}`,
  );
  assert.ok(dt < 2.5, `too slow: ${dt}s`);
  assert.equal(sim.tickCount, 12000);
  assert.equal(sim.numCars, 6);
  for (let slot = 0; slot < 6; slot++) {
    const p = carVec(slot, T.C_POS);
    assert.ok(Math.abs(p[0]) < 4200 && Math.abs(p[1]) < 6100 && p[2] > -10 && p[2] < 2100, `car ${slot} at ${p}`);
  }
  const bp = ballVec(T.B_POS);
  assert.ok(Math.abs(bp[0]) < 4200 && Math.abs(bp[1]) < 6100 && bp[2] > 0 && bp[2] < 2100, `ball at ${bp}`);
  assert.ok(hits > 0, 'six cars driving around for 100 s touch the ball');
});

// ---- Our field layout in the wasm (rs_set_field_layout, sent by initArena from constants.ts) ----

const A = K.ARENA;
const BALL_R = K.BALL.radius;
const yawOf = (slot) => {
  const f = carVec(slot, T.C_ROT);
  return Math.atan2(f[1], f[0]);
};
const angleDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
/** Index of the respawn spot (blue frame, mirrored for red) the car in `slot` stands on, or -1. */
function respawnSpotOf(slot, tol = 1e-2) {
  const p = carVec(slot, T.C_POS);
  const sign = car(slot, T.C_TEAM) === 1 ? -1 : 1;
  return K.RESPAWN_SPOTS.findIndex((r) => Math.abs(r[0] * sign - p[0]) < tol && Math.abs(r[1] * sign - p[1]) < tol);
}

test('22. field layout: the wasm simulates our boost pads, goal line and wall planes', () => {
  fresh();
  const want = [...K.BOOST_PADS_BIG.map((p) => [p, true]), ...K.BOOST_PADS_SMALL.map((p) => [p, false])];
  assert.equal(want.length, T.NUM_BOOST_PADS);
  for (let i = 0; i < want.length; i++) {
    const info = sim.boostPadInfo(i);
    assert.ok(info, `pad ${i} exists`);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(info.pos[k] - want[i][0][k]) < 1e-3, `pad ${i} at ${info.pos} (want ${want[i][0]})`);
    assert.equal(info.isBig, want[i][1], `pad ${i} size`);
  }
  assert.equal(sim.boostPadInfo(T.NUM_BOOST_PADS), null);
  assert.equal(sim.boostPadInfo(-1), null);

  // Pickups happen at our positions: a car parked on the first big pad and on the first small pad.
  const id = sim.addCar(T.Team.Blue);
  const [bx, by] = K.BOOST_PADS_BIG[0];
  sim.setCarState(id, [bx, by, 17], [Math.PI / 2, 0, 0]);
  sim.setCarBoost(id, 0);
  sim.step(2);
  sim.sync();
  assert.equal(car(0, T.C_BOOST), 100, 'big pad gives a full tank');
  assert.equal(sim.buf[T.PADS_OFFSET + T.P_IS_ACTIVE], 0, 'big pad 0 is now recharging');
  const [sx, sy] = K.BOOST_PADS_SMALL[0];
  sim.setCarState(id, [sx, sy, 17], [Math.PI / 2, 0, 0]);
  sim.setCarBoost(id, 0);
  sim.step(2);
  sim.sync();
  assert.equal(car(0, T.C_BOOST), 12, 'small pad gives 12');
  assert.equal(sim.buf[T.PADS_OFFSET + K.BOOST_PADS_BIG.length * T.PAD_STRIDE + T.P_IS_ACTIVE], 0, 'small pad 0 is recharging');

  // Goal line: the whole ball past |y| = goalScoreThresholdY.
  for (const sign of [1, -1]) {
    sim.setBallState([0, sign * (A.goalScoreThresholdY + BALL_R - 2), 300]);
    assert.equal(sim.isBallScored(), false, `ball on the line (${sign > 0 ? '+' : '-'}y) is not a goal`);
    sim.setBallState([0, sign * (A.goalScoreThresholdY + BALL_R + 2), 300]);
    assert.equal(sim.isBallScored(), true, `ball past the line (${sign > 0 ? '+' : '-'}y) is a goal`);
  }

  // The side-wall and ceiling planes moved with the field: a ball thrown at them bounces at
  // x = +-extentX and z = height (minus its radius), not earlier.
  for (const [name, pos, vel, axis, limit] of [
    ['+x wall', [A.extentX - 600, 0, 800], [2500, 0, 0], 0, A.extentX],
    ['-x wall', [-(A.extentX - 600), 0, 800], [-2500, 0, 0], 0, A.extentX],
    ['ceiling', [0, 0, A.height - 700], [0, 0, 2500], 2, A.height],
  ]) {
    sim.setBallState(pos, vel);
    let reach = 0;
    for (let t = 0; t < 90; t++) {
      sim.step(1);
      sim.sync();
      reach = Math.max(reach, Math.abs(ballVec(T.B_POS)[axis]));
    }
    assert.ok(reach > limit - BALL_R - 25 && reach < limit - BALL_R + 25, `${name}: ball reached ${reach.toFixed(1)}, wall at ${limit}`);
  }
});

test('23. a new car stands on its team respawn spot: the k-th car of a team on spot k % 4', () => {
  fresh();
  const ids = [];
  for (let i = 0; i < T.MAX_CARS; i++) ids.push(sim.addCar(i % 2 === 0 ? T.Team.Blue : T.Team.Red));
  for (let slot = 0; slot < T.MAX_CARS; slot++) {
    const k = Math.floor(slot / 2);
    const want = k % K.RESPAWN_SPOTS.length;
    assert.equal(respawnSpotOf(slot), want, `slot ${slot} (team car ${k}) on respawn spot ${want}, at ${carVec(slot, T.C_POS).map((v) => v.toFixed(0))}`);
    const yaw = K.RESPAWN_SPOTS[want][2] + (slot % 2 === 1 ? Math.PI : 0);
    assert.ok(Math.abs(angleDiff(yawOf(slot), yaw)) < 1e-3, `slot ${slot} faces upfield`);
  }
});

/** Demolish `victim` and step until it is back; returns { ticks, spot, hash }. */
function demoAndRespawn(victim) {
  sim.demolishCar(victim);
  const slot = sim.slotOf(victim);
  sim.step(1);
  sim.sync();
  assert.equal(car(slot, T.C_IS_DEMOED), 1, 'demolished');
  let ticks = 1;
  while (car(slot, T.C_IS_DEMOED) === 1 && ticks < 5 * 120) {
    sim.step(1);
    sim.sync();
    ticks++;
  }
  assert.equal(car(slot, T.C_IS_DEMOED), 0, 'respawned within 5 s');
  return { ticks, spot: respawnSpotOf(slot), hash: sim.stateHash(), tick: sim.tickCount };
}

test('24. a demolished car respawns on one of OUR respawn spots, chosen deterministically', () => {
  // Blue and red both land on a respawn spot of their own team, facing upfield, on the floor.
  fresh();
  const blue = sim.addCar(T.Team.Blue);
  const red = sim.addCar(T.Team.Red);
  sim.resetKickoff(3);
  const r1 = demoAndRespawn(blue);
  assert.ok(r1.ticks >= 3 * 120 - 2 && r1.ticks <= 3 * 120 + 2, `3 s respawn timer (${r1.ticks} ticks)`);
  assert.ok(r1.spot >= 0, `blue car on a respawn spot (${carVec(0, T.C_POS).map((v) => v.toFixed(1))})`);
  assert.ok(Math.abs(carVec(0, T.C_POS)[2] - 36) < 1e-3, 'dropped in at the respawn height');
  assert.ok(Math.abs(angleDiff(yawOf(0), K.RESPAWN_SPOTS[r1.spot][2])) < 1e-3, 'blue faces upfield');
  const r2 = demoAndRespawn(red);
  assert.ok(r2.spot >= 0, 'red car on a mirrored respawn spot');
  assert.ok(Math.abs(angleDiff(yawOf(1), K.RESPAWN_SPOTS[r2.spot][2] + Math.PI)) < 1e-3, 'red faces upfield');
  sim.step(120);
  sim.sync();
  for (const slot of [0, 1]) {
    assert.ok(car(slot, T.C_IS_ON_GROUND) === 1 && carVec(slot, T.C_POS)[2] < 30, `slot ${slot} settled on the floor`);
  }

  // Same scenario, same spot and same state hash (a fresh arena replays it exactly); the respawn
  // tick varies with the demo time and the spot follows it.
  const spots = new Set();
  for (let wait = 0; wait < 12; wait++) {
    const run = () => {
      fresh();
      const b = sim.addCar(T.Team.Blue);
      sim.addCar(T.Team.Red);
      sim.resetKickoff(1);
      sim.step(wait * 7);
      return demoAndRespawn(b);
    };
    const a = run();
    const again = run();
    assert.deepEqual(again, a, `wait ${wait}: identical respawn`);
    spots.add(a.spot);
  }
  assert.ok(spots.size >= 3, `the respawn spot varies with the tick (${[...spots]})`);

  // A spot another car stands on is skipped.
  const first = (() => {
    fresh();
    const b = sim.addCar(T.Team.Blue);
    sim.addCar(T.Team.Red);
    sim.resetKickoff(2);
    return demoAndRespawn(b).spot;
  })();
  fresh();
  const b = sim.addCar(T.Team.Blue);
  const o = sim.addCar(T.Team.Red);
  sim.resetKickoff(2);
  const [px, py, pyaw] = K.RESPAWN_SPOTS[first];
  sim.demolishCar(b);
  sim.setCarState(o, [px, py, 17], [pyaw, 0, 0]); // an red car parked on that blue spot
  sim.step(1);
  sim.sync();
  let n = 0;
  while (car(0, T.C_IS_DEMOED) === 1 && n++ < 5 * 120) {
    sim.setCarState(o, [px, py, 17], [pyaw, 0, 0]); // hold it there (tick-exact like the run above)
    sim.step(1);
    sim.sync();
  }
  const other = respawnSpotOf(0);
  assert.ok(other >= 0 && other !== first, `occupied spot ${first} skipped (got ${other})`);
});

test('25. a respawn replayed from a saved state lands on the same spot (rollback / host agree)', async () => {
  fresh();
  const b = sim.addCar(T.Team.Blue);
  sim.addCar(T.Team.Red);
  sim.resetKickoff(4);
  sim.demolishCar(b);
  sim.step(100);
  sim.sync();
  const blob = new Uint8Array(T.MAX_STATE_BYTES);
  const len = sim.saveState(blob);
  sim.step(300);
  sim.sync();
  const hashA = sim.stateHash();
  const spotA = respawnSpotOf(0, 2); // respawned at tick 360, settled on the floor since
  assert.ok(spotA >= 0 && car(0, T.C_IS_DEMOED) === 0, `respawned on a spot (${carVec(0, T.C_POS).map((v) => v.toFixed(1))})`);
  // Another instance (a peer / the host) with the same roster loads the blob and steps the same ticks.
  const other = await RocketSim.load();
  other.initArena(await loadMesh());
  other.createArena();
  other.addCar(T.Team.Blue);
  other.addCar(T.Team.Red);
  other.loadState(blob, len);
  other.step(300);
  other.sync();
  assert.equal(other.stateHash(), hashA, 'identical state after the respawn');
  // And a load into the same instance replays it too.
  sim.loadState(blob, len);
  sim.step(300);
  sim.sync();
  assert.equal(sim.stateHash(), hashA);
  assert.equal(respawnSpotOf(0, 2), spotA);
});

test('26. rs_set_field_layout validates its input and refuses while an arena exists', async () => {
  const { fieldLayoutData } = await import('../src/sim/RocketSimBridge.ts');
  const raw = await RocketSim.load();
  const mod = raw['mod'];
  const data = fieldLayoutData();
  const put = (arr) => {
    const p = mod._malloc(arr.length * 4);
    new Float32Array(mod.wasmMemory.buffer, p, arr.length).set(arr);
    return p;
  };
  const call = (arr, count = arr.length) => {
    const p = put(arr);
    const rc = mod._rs_set_field_layout(p, count);
    mod._free(p);
    return rc;
  };
  assert.equal(call(data, data.length - 1), 1, 'count mismatch');
  const badVersion = data.slice();
  badVersion[0] = 99;
  assert.equal(call(badVersion), 1, 'unknown version');
  const nan = data.slice();
  nan[1] = NaN;
  assert.equal(call(nan), 1, 'non-finite');
  const tightBounds = data.slice();
  tightBounds[8] = A.extentY - 100; // broadphase max y inside the field
  assert.equal(call(tightBounds), 1, 'bounds that cut the field are refused');
  // One pad fewer: the state buffer has NUM_BOOST_PADS slots.
  const nk = data[10];
  const nr = data[11 + nk * 3];
  const padCountAt = 12 + nk * 3 + nr * 3;
  assert.equal(data[padCountAt], T.NUM_BOOST_PADS);
  const fewer = Float32Array.from([...data.slice(0, padCountAt), T.NUM_BOOST_PADS - 1, ...data.slice(padCountAt + 1, data.length - 4)]);
  assert.equal(call(fewer), 2, 'pad count must match the state buffer');
  // A fresh instance with a mesh but no layout cannot create an arena.
  const fresh2 = await RocketSim.load();
  const m2 = fresh2['mod'];
  const mesh = await loadMesh();
  const vp = m2._malloc(mesh.vertices.length * 4);
  const tp = m2._malloc(mesh.indices.length * 4);
  new Float32Array(m2.wasmMemory.buffer, vp, mesh.vertices.length).set(mesh.vertices);
  new Int32Array(m2.wasmMemory.buffer, tp, mesh.indices.length).set(mesh.indices);
  assert.equal(m2._rs_init_arena_mesh(vp, mesh.vertices.length / 3, tp, mesh.indices.length / 3), 0);
  assert.equal(m2._rs_arena_create(120), 4, 'no arena without a field layout');
  // The bridge path works and a second layout while the arena exists is refused.
  raw.initArena(mesh);
  raw.createArena();
  assert.equal(call(data), 3, 'arena exists');
  raw.destroyArena();
  assert.equal(call(data), 0, 'accepted again once the arena is gone');
});
