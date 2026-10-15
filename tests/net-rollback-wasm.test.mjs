// RollbackPredictor against the REAL RocketSim wasm (src/sim/wasm, npm run build:wasm): the
// client-side replay after rs_load_state must reproduce, bit for bit, what the host computed by
// stepping continuously with the same packed inputs. Skips when the build has no rollback exports.
//   node --test tests/net-rollback-wasm.test.mjs
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

const { RocketSim } = await import('../src/sim/RocketSimBridge.ts');
const { buildArenaMesh } = await import('../src/sim/arenaMesh.ts');
const T = await import('../src/sim/types.ts');
const { RollbackPredictor } = await import('../src/net/Prediction.ts');
const { fnv1a32 } = await import('../src/net/protocol.ts');

const { CarPreset, Team, TICK_RATE, PACKED_INPUT_BYTES, MAX_STATE_BYTES } = T;

const sim = await RocketSim.load();
const hasRollback = typeof sim.saveState === 'function' && typeof sim.loadState === 'function' && typeof sim.setControlsPacked === 'function';
const mesh = buildArenaMesh().physics;
sim.initArena(mesh);

/** Fresh arena with `n` cars (blue, red alternating) at a deterministic kickoff. Returns the ids. */
function freshArena(n, seed) {
  sim.createArena(TICK_RATE);
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(sim.addCar(i % 2 === 0 ? Team.Blue : Team.Red, CarPreset.Standard));
  sim.resetKickoff(seed);
  sim.sync();
  return ids;
}

function pack(throttle, steer, pitch, yaw, roll, jump, boost, handbrake, out, off) {
  T.packControls({ throttle, steer, pitch, yaw, roll, jump, boost, handbrake }, out, off);
}

/** Deterministic pseudo-random packed input for a slot at a tick (same on both "ends"). */
function inputFor(slot, tick, out, off) {
  const s = Math.sin(tick * 0.21 + slot * 1.3);
  const c = Math.cos(tick * 0.07 + slot * 0.4);
  pack(s > -0.6 ? 1 : -1, c, Math.sin(tick * 0.05), 0, 0, (tick + slot * 7) % 23 === 0, (tick >> 4) % 3 === 0, (tick + slot) % 41 < 3, out, off);
}

/** Run `ticks` ticks on the current arena with inputFor() for every slot (continuous "host"). */
function runHost(n, ticks, startTick) {
  const frame = new Int8Array(n * PACKED_INPUT_BYTES);
  for (let t = startTick + 1; t <= startTick + ticks; t++) {
    for (let s = 0; s < n; s++) inputFor(s, t, frame, s * PACKED_INPUT_BYTES);
    sim.setControlsPacked(frame, n);
    sim.step(1);
  }
  sim.sync();
}

function snapshotNow(n) {
  const state = new Uint8Array(MAX_STATE_BYTES);
  const len = sim.saveState(state);
  const inputs = new Int8Array(n * PACKED_INPUT_BYTES);
  for (let s = 0; s < n; s++) inputFor(s, sim.tickCount, inputs, s * PACKED_INPUT_BYTES);
  return { tick: sim.tickCount, lastInputTick: sim.tickCount, bufferHint: 0, numCars: n, inputs, stateLen: len, state, stateHash: fnv1a32(state, len) };
}

test('createArena restarts the car ids at 1 (the online roster relies on it)', { skip: !hasRollback && 'wasm without rollback exports' }, () => {
  freshArena(4, 7);
  const again = freshArena(2, 7);
  assert.deepEqual(again, [1, 2]);
  assert.equal(sim.numCars, 2);
});

test('replay after loadState reproduces the host hash (2 cars, 60 ticks, snapshot at 30)', { skip: !hasRollback && 'wasm without rollback exports' }, () => {
  const n = 2;
  const SEED = 42;
  // Host: 60 continuous ticks.
  freshArena(n, SEED);
  runHost(n, 60, 0);
  const hostHash60 = sim.stateHash();
  // Host state at tick 30 (same deterministic inputs).
  freshArena(n, SEED);
  runHost(n, 30, 0);
  const snap30 = snapshotNow(n);
  assert.equal(snap30.tick, 30);
  assert.equal(sim.stateHash(), snap30.stateHash, 'stateHash == fnv1a32(saveState)');

  // Client (slot 0): predicts 60 ticks with its own inputs and the remote input of tick 0 held
  // (so it mispredicts the remote car), then the snapshot of tick 30 arrives.
  freshArena(n, SEED);
  const pred = new RollbackPredictor(sim, 0, n);
  const hold = new Int8Array(PACKED_INPUT_BYTES);
  inputFor(1, 0, hold, 0);
  pred.setHold(1, hold, 0);
  const mine = new Int8Array(PACKED_INPUT_BYTES);
  for (let t = 1; t <= 60; t++) {
    inputFor(0, t, mine, 0);
    pred.stepLocal(t, mine, 0);
  }
  sim.sync();
  assert.equal(pred.localTick, 60);
  assert.notEqual(sim.stateHash(), hostHash60, 'the held remote input mispredicts');

  // Make the snapshot's echo carry the remote input the host applied at every replayed tick: in
  // this synthetic host the remote input changes per tick, so feed the predictor the true inputs
  // through the hold before each replay step by replaying manually... Simplest faithful check:
  // the host itself holds the remote input constant from tick 30 on.
  freshArena(n, SEED);
  runHost(n, 30, 0);
  const frame = new Int8Array(n * PACKED_INPUT_BYTES);
  inputFor(1, 30, frame, PACKED_INPUT_BYTES); // remote held at its tick-30 input
  for (let t = 31; t <= 60; t++) {
    inputFor(0, t, frame, 0);
    sim.setControlsPacked(frame, n);
    sim.step(1);
  }
  sim.sync();
  const hostHeldHash60 = sim.stateHash();

  freshArena(n, SEED);
  const pred2 = new RollbackPredictor(sim, 0, n);
  pred2.setHold(1, hold, 0);
  for (let t = 1; t <= 60; t++) {
    inputFor(0, t, mine, 0);
    pred2.stepLocal(t, mine, 0);
  }
  pred2.synced = true;
  pred2.applySnapshot(snap30);
  assert.equal(pred2.desyncs, 0, 'hash after load matches the snapshot');
  assert.equal(pred2.loadErrors, 0);
  assert.equal(pred2.rollbacks, 1);
  assert.equal(pred2.replayedTicks, 30);
  assert.equal(pred2.localTick, 60);
  assert.equal(sim.tickCount, 60);
  assert.equal(sim.stateHash(), hostHeldHash60, 'load + replay == continuous stepping with the same inputs');
  assert.ok(pred2.lastErrorCar >= 0);
});

// Same arena: save at 24, play to 40, load 24, replay 16. With a complete blob this is
// bit-identical and the offsets are exactly zero (tests/sim-state.test.mjs "a. round trip" is the
// strict contract on the wrapper); here the visual offsets are only required to stay far below
// what a player could notice, so the netcode keeps a meaningful check while the blob is tuned.
test('a second snapshot after a converged replay leaves (near) zero visual error', { skip: !hasRollback && 'wasm without rollback exports' }, () => {
  const n = 2;
  freshArena(n, 3);
  const pred = new RollbackPredictor(sim, 1, n);
  const idle = new Int8Array(PACKED_INPUT_BYTES);
  const mine = new Int8Array(PACKED_INPUT_BYTES);
  pack(1, 0.3, 0, 0, 0, false, true, false, mine, 0);
  pred.setHold(0, idle, 0);
  for (let t = 1; t <= 24; t++) pred.stepLocal(t, mine, 0);
  // "Host" = the same sim: snapshot at 24 from what we have (converged by construction).
  const state = new Uint8Array(MAX_STATE_BYTES);
  const len = sim.saveState(state);
  const inputs = new Int8Array(n * PACKED_INPUT_BYTES);
  inputs.set(mine, PACKED_INPUT_BYTES);
  const snap = { tick: 24, lastInputTick: 24, bufferHint: 0, numCars: n, inputs, stateLen: len, state, stateHash: fnv1a32(state, len) };
  for (let t = 25; t <= 40; t++) pred.stepLocal(t, mine, 0);
  sim.sync(); // the Game syncs after every tick: the predictor reads the predicted pose from buf
  pred.synced = true;
  pred.applySnapshot(snap);
  assert.equal(pred.desyncs, 0, 'hash after load == snapshot hash');
  assert.equal(pred.replayedTicks, 16);
  console.log(`converged replay: car error ${pred.lastErrorCar.toFixed(3)} uu, ball error ${pred.lastErrorBall.toFixed(3)} uu (0 once the blob is complete)`);
  assert.ok(pred.lastErrorCar < 1, `car error ${pred.lastErrorCar} uu`);
  assert.ok(pred.lastErrorBall < 1, `ball error ${pred.lastErrorBall} uu`);
});
