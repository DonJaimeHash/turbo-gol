// Rollback prediction (src/net/Prediction.ts) against a tiny deterministic stand-in for the
// RocketSim bridge, so the tests run without the wasm:
//   node --test tests/net-prediction.test.mjs
// The fake implements the RollbackSim surface: buf (state buffer layout of types.ts for the car
// positions and the ball), tickCount, numCars, carOffset, saveState / loadState / stateHash /
// stateSizeMax / setControlsPacked / step / sync. Its physics is integer-friendly (ticks of
// throttle move cars along +x, steer along +y, jump bumps z; the ball drifts and bounces off the
// walls) so a replay must reproduce the state bit for bit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (!specifier.startsWith('.') || /\.[cm]?ts$/.test(specifier)) throw err;
      return nextResolve(specifier.replace(/\.js$/, '') + '.ts', context);
    }
  },
});

const T = await import('../src/sim/types.ts');
const { RollbackPredictor, ERR_SNAP, MAX_REPLAY } = await import('../src/net/Prediction.ts');
const { InputRing, assembleInputs, INPUT_RING } = await import('../src/net/InputRing.ts');
const { computeLead, LeadAdjuster, LEAD_MIN, LEAD_MAX, TICK_MS } = await import('../src/net/ClockSync.ts');
const { fnv1a32 } = await import('../src/net/protocol.ts');

const { CARS_OFFSET, CAR_STRIDE, C_POS, C_VEL, C_ID, C_TEAM, BALL_OFFSET, B_POS, B_VEL, H_TICK_COUNT, H_NUM_CARS, STATE_BUFFER_FLOATS, PACKED_INPUT_BYTES, BTN_JUMP } = T;

/** Deterministic stand-in sim. State = tick + per car pos/vel + ball pos/vel, all Float32. */
class FakeSim {
  constructor(numCars) {
    this.buf = new Float32Array(STATE_BUFFER_FLOATS);
    this.n = numCars;
    this.buf[H_NUM_CARS] = numCars;
    this.controls = new Int8Array(numCars * PACKED_INPUT_BYTES);
    this.stepsCalled = 0;
    for (let i = 0; i < numCars; i++) {
      const o = CARS_OFFSET + i * CAR_STRIDE;
      this.buf[o + C_ID] = i + 1;
      this.buf[o + C_TEAM] = i % 2;
      this.buf[o + C_POS] = -1000 + i * 500;
      this.buf[o + C_POS + 1] = i % 2 === 0 ? -2000 : 2000;
      this.buf[o + C_POS + 2] = 17;
    }
    this.buf[BALL_OFFSET + B_POS + 2] = 93;
    this.buf[BALL_OFFSET + B_VEL] = 200;
    this.buf[BALL_OFFSET + B_VEL + 1] = 150;
    this.bytes = 4 + this.n * 6 * 4 + 6 * 4;
    this.scratch = new Uint8Array(this.bytes);
  }
  get tickCount() {
    return this.buf[H_TICK_COUNT];
  }
  get numCars() {
    return this.n;
  }
  carOffset(slot) {
    return CARS_OFFSET + slot * CAR_STRIDE;
  }
  setControlsPacked(packed, numSlots) {
    assert.equal(numSlots, this.n);
    for (let i = 0; i < numSlots * PACKED_INPUT_BYTES; i++) this.controls[i] = packed[i];
  }
  step(n = 1) {
    for (let k = 0; k < n; k++) {
      this.stepsCalled++;
      const b = this.buf;
      for (let i = 0; i < this.n; i++) {
        const o = CARS_OFFSET + i * CAR_STRIDE;
        const c = i * PACKED_INPUT_BYTES;
        const throttle = this.controls[c] / 127;
        const steer = this.controls[c + 1] / 127;
        const jump = (this.controls[c + 5] & BTN_JUMP) !== 0;
        b[o + C_VEL] = Math.fround(b[o + C_VEL] * 0.98 + throttle * 60);
        b[o + C_VEL + 1] = Math.fround(b[o + C_VEL + 1] * 0.98 + steer * 40);
        b[o + C_VEL + 2] = jump && b[o + C_POS + 2] <= 17 ? 300 : Math.fround(b[o + C_VEL + 2] - 650 / 120);
        b[o + C_POS] = Math.fround(b[o + C_POS] + b[o + C_VEL] / 120);
        b[o + C_POS + 1] = Math.fround(b[o + C_POS + 1] + b[o + C_VEL + 1] / 120);
        b[o + C_POS + 2] = Math.fround(b[o + C_POS + 2] + b[o + C_VEL + 2] / 120);
        if (b[o + C_POS + 2] < 17) {
          b[o + C_POS + 2] = 17;
          b[o + C_VEL + 2] = 0;
        }
        // Car-ball "touch": push the ball when close.
        const dx = b[BALL_OFFSET + B_POS] - b[o + C_POS];
        const dy = b[BALL_OFFSET + B_POS + 1] - b[o + C_POS + 1];
        if (dx * dx + dy * dy < 200 * 200) {
          b[BALL_OFFSET + B_VEL] = Math.fround(b[BALL_OFFSET + B_VEL] + b[o + C_VEL]);
          b[BALL_OFFSET + B_VEL + 1] = Math.fround(b[BALL_OFFSET + B_VEL + 1] + b[o + C_VEL + 1]);
        }
      }
      const bo = BALL_OFFSET;
      b[bo + B_POS] = Math.fround(b[bo + B_POS] + b[bo + B_VEL] / 120);
      b[bo + B_POS + 1] = Math.fround(b[bo + B_POS + 1] + b[bo + B_VEL + 1] / 120);
      if (Math.abs(b[bo + B_POS]) > 4000) b[bo + B_VEL] = -b[bo + B_VEL];
      if (Math.abs(b[bo + B_POS + 1]) > 5000) b[bo + B_VEL + 1] = -b[bo + B_VEL + 1];
      b[H_TICK_COUNT] = b[H_TICK_COUNT] + 1;
    }
  }
  sync() {}
  stateSizeMax() {
    return this.bytes;
  }
  saveState(out) {
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    let p = 0;
    dv.setUint32(p, this.buf[H_TICK_COUNT], true);
    p += 4;
    for (let i = 0; i < this.n; i++) {
      const o = CARS_OFFSET + i * CAR_STRIDE;
      for (let k = 0; k < 3; k++) {
        dv.setFloat32(p, this.buf[o + C_POS + k], true);
        dv.setFloat32(p + 12, this.buf[o + C_VEL + k], true);
        p += 4;
      }
      p += 12;
    }
    for (let k = 0; k < 3; k++) {
      dv.setFloat32(p, this.buf[BALL_OFFSET + B_POS + k], true);
      dv.setFloat32(p + 12, this.buf[BALL_OFFSET + B_VEL + k], true);
      p += 4;
    }
    p += 12;
    return p;
  }
  loadState(blob, len = blob.length) {
    if (len !== this.bytes) return 4;
    const dv = new DataView(blob.buffer, blob.byteOffset, len);
    let p = 0;
    this.buf[H_TICK_COUNT] = dv.getUint32(p, true);
    p += 4;
    for (let i = 0; i < this.n; i++) {
      const o = CARS_OFFSET + i * CAR_STRIDE;
      for (let k = 0; k < 3; k++) {
        this.buf[o + C_POS + k] = dv.getFloat32(p, true);
        this.buf[o + C_VEL + k] = dv.getFloat32(p + 12, true);
        p += 4;
      }
      p += 12;
    }
    for (let k = 0; k < 3; k++) {
      this.buf[BALL_OFFSET + B_POS + k] = dv.getFloat32(p, true);
      this.buf[BALL_OFFSET + B_VEL + k] = dv.getFloat32(p + 12, true);
      p += 4;
    }
    return 0;
  }
  stateHash() {
    const len = this.saveState(this.scratch);
    return fnv1a32(this.scratch, len);
  }
}

function pack(throttle, steer, jump = false) {
  const out = new Int8Array(6);
  T.packControls({ throttle, steer, pitch: 0, yaw: 0, roll: 0, jump, boost: false, handbrake: false }, out, 0);
  return out;
}

/** Deterministic pseudo random input for a tick (same on "host" and "client"). */
function inputFor(slot, tick) {
  const s = Math.sin(tick * 0.37 + slot * 1.7);
  const c = Math.cos(tick * 0.11 + slot);
  return pack(s, c, (tick + slot) % 17 === 0);
}

/** A snapshot packet from a "host" sim at its current tick (state copied). */
function snapshotOf(host, lastInputTick, bufferHint = 0) {
  const state = new Uint8Array(host.stateSizeMax());
  const len = host.saveState(state);
  const inputs = new Int8Array(host.controls.length);
  inputs.set(host.controls);
  return { tick: host.tickCount, lastInputTick, bufferHint, numCars: host.numCars, inputs, stateLen: len, state, stateHash: fnv1a32(state, len) };
}

test('replaying N own inputs after loadState reproduces the hash of continuous stepping', () => {
  const N = 3;
  const host = new FakeSim(N);
  const client = new FakeSim(N);
  const pred = new RollbackPredictor(client, 1, N);
  const frame = new Int8Array(N * 6);

  // Both sides run 40 ticks with the same inputs for every slot (the client holds the remote
  // inputs the host echoed at tick 0, which is what the host applies here too).
  const remote0 = inputFor(0, 0);
  const remote2 = inputFor(2, 0);
  frame.set(remote0, 0);
  frame.set(remote2, 12);
  pred.setHold(0, remote0, 0);
  pred.setHold(2, remote2, 0);
  for (let t = 1; t <= 40; t++) {
    const mine = inputFor(1, t);
    frame.set(mine, 6);
    host.setControlsPacked(frame, N);
    host.step(1);
    pred.stepLocal(t, mine, 0);
  }
  assert.equal(pred.localTick, 40);
  assert.equal(client.stateHash(), host.stateHash(), 'identical inputs -> identical state');

  // Now the host's snapshot of tick 20 arrives while the client is at 40: load + replay 21..40.
  const hostAt20 = new FakeSim(N);
  hostAt20.setHold = undefined;
  frame.set(remote0, 0);
  frame.set(remote2, 12);
  for (let t = 1; t <= 20; t++) {
    frame.set(inputFor(1, t), 6);
    hostAt20.setControlsPacked(frame, N);
    hostAt20.step(1);
  }
  const pkt = snapshotOf(hostAt20, 20);
  pred.synced = true; // pretend an earlier snapshot was applied so this one replays
  const before = client.stateHash();
  pred.applySnapshot(pkt);
  assert.equal(pred.localTick, 40);
  assert.equal(client.tickCount, 40);
  assert.equal(pred.rollbacks, 1);
  assert.equal(pred.replayedTicks, 20);
  assert.equal(pred.desyncs, 0, 'hash after load matches the snapshot hash');
  assert.equal(client.stateHash(), before, 'the replay converges to the same state');
  assert.equal(client.stateHash(), host.stateHash());
  // No misprediction -> no visual error.
  assert.deepEqual(Array.from(pred.errorOffsetCar), [0, 0, 0]);
  assert.deepEqual(Array.from(pred.errorOffsetBall), [0, 0, 0]);
});

test('held remote inputs: a remote slot keeps the last echoed input until the next snapshot', () => {
  const N = 2;
  const host = new FakeSim(N);
  const client = new FakeSim(N);
  const pred = new RollbackPredictor(client, 0, N);
  const frame = new Int8Array(N * 6);

  // The host applies full throttle for the remote car (slot 1) from tick 1.
  const remote = pack(1, 0);
  frame.set(remote, 6);
  const idle = pack(0, 0);
  for (let t = 1; t <= 10; t++) {
    frame.set(idle, 0);
    host.setControlsPacked(frame, N);
    host.step(1);
  }
  // The client did not know: it predicted the remote idle.
  for (let t = 1; t <= 10; t++) pred.stepLocal(t, idle, 0);
  const remoteOff = client.carOffset(1) + C_POS;
  assert.equal(client.buf[remoteOff], -500, 'client predicted the remote car idle (its spawn x)');
  assert.ok(host.buf[host.carOffset(1) + C_POS] > -500, 'sanity: the fake moves the car on the host');
  assert.ok(client.buf[remoteOff] < host.buf[host.carOffset(1) + C_POS], 'client predicted the idle car behind the host');

  // Snapshot at tick 10 echoes the remote input: load, no replay needed (client at 10).
  pred.synced = true;
  pred.applySnapshot(snapshotOf(host, 10));
  assert.equal(pred.hold[6], 127, 'remote hold updated from the echo');
  assert.equal(client.stateHash(), host.stateHash());

  // From now on the client steps with the hold and tracks the host exactly.
  for (let t = 11; t <= 30; t++) {
    frame.set(idle, 0);
    host.setControlsPacked(frame, N);
    host.step(1);
    pred.stepLocal(t, idle, 0);
  }
  assert.equal(client.stateHash(), host.stateHash(), 'held remote input == what the host applied');
});

test('error offsets record the misprediction and decay 0.95 / 0.85 per tick, snapping beyond 200 uu', () => {
  const N = 2;
  const host = new FakeSim(N);
  const client = new FakeSim(N);
  const pred = new RollbackPredictor(client, 0, N);
  const frame = new Int8Array(N * 6);
  const idle = pack(0, 0);
  const go = pack(1, 0);

  // Client predicts itself idle; the host actually applied a different input for the player's
  // slot (packet loss): a misprediction of the own car.
  for (let t = 1; t <= 30; t++) {
    frame.set(go, 0);
    frame.set(idle, 6);
    host.setControlsPacked(frame, N);
    host.step(1);
    pred.stepLocal(t, idle, 0);
  }
  // Snapshot of tick 20 from a host that applied `go` for us; the ring replays our idle input
  // for 21..30, so the corrected car sits ahead of the prediction.
  const h20 = new FakeSim(N);
  for (let t = 1; t <= 20; t++) {
    frame.set(go, 0);
    frame.set(idle, 6);
    h20.setControlsPacked(frame, N);
    h20.step(1);
  }
  const myOff = client.carOffset(0) + C_POS;
  const predicted = client.buf[myOff];
  pred.synced = true;
  pred.applySnapshot(snapshotOf(h20, 20));
  const corrected = client.buf[myOff];
  assert.ok(corrected > predicted, 'host moved the car forward');
  const err = pred.errorOffsetCar[0];
  assert.ok(Math.abs(err - (predicted - corrected)) < 1e-3, 'offset = predicted - corrected');
  assert.ok(pred.lastErrorCar > 0 && pred.lastErrorCar < ERR_SNAP, `magnitude ${pred.lastErrorCar}`);

  // Decay: 0.95 per tick below 100 uu, 0.85 at or above.
  const len0 = Math.abs(err);
  pred.decayOffsets();
  const k = len0 >= 100 ? 0.85 : 0.95;
  assert.ok(Math.abs(pred.errorOffsetCar[0] - err * k) < 1e-3, `decayed by ${k}`);
  let steps = 0;
  while (pred.errorOffsetCar[0] !== 0 && steps < 500) {
    pred.decayOffsets();
    steps++;
  }
  assert.ok(steps < 500, 'offset reaches zero');

  // A huge correction (kickoff reset) snaps instead of smoothing.
  pred.errorOffsetBall.set([0, 0, 0]);
  pred.errorOffsetCar.set([0, 0, 0]);
  const far = new FakeSim(N);
  for (let t = 1; t <= 20; t++) {
    frame.set(go, 0);
    frame.set(idle, 6);
    far.setControlsPacked(frame, N);
    far.step(1);
  }
  far.buf[far.carOffset(0) + C_POS] += 5000; // teleported on the host
  pred.applySnapshot(snapshotOf(far, 20));
  assert.deepEqual(Array.from(pred.errorOffsetCar), [0, 0, 0], 'snap to zero beyond ERR_SNAP');
  assert.ok(pred.lastErrorCar > ERR_SNAP);
});

test('snapshots the client cannot replay reset the local tick (host ahead / older than the ring)', () => {
  const N = 1;
  const host = new FakeSim(N);
  const client = new FakeSim(N);
  const pred = new RollbackPredictor(client, 0, N);
  const idle = pack(0, 0);
  for (let t = 1; t <= 5; t++) pred.stepLocal(t, idle, 0);
  // First snapshot ever: no replay regardless of the gap (nothing authoritative to replay from).
  host.step(12);
  pred.applySnapshot(snapshotOf(host, 12));
  assert.equal(pred.localTick, 12);
  assert.equal(pred.rollbacks, 0);
  assert.equal(pred.synced, true);
  // Host ahead of the client: localTick jumps to the snapshot.
  host.step(10);
  pred.applySnapshot(snapshotOf(host, 22));
  assert.equal(pred.localTick, 22);
  assert.equal(pred.resyncs, 1);
  // Snapshot older than the ring: resync instead of a replay longer than MAX_REPLAY.
  for (let t = 23; t <= 22 + MAX_REPLAY + 10; t++) pred.stepLocal(t, idle, 0);
  pred.applySnapshot(snapshotOf(host, 22));
  assert.equal(pred.localTick, 22);
  assert.equal(pred.resyncs, 2);
  // A desync (bad hash) is counted but the state is still loaded.
  host.step(1);
  const pkt = snapshotOf(host, 23);
  pkt.stateHash ^= 0x1234;
  pred.applySnapshot(pkt);
  assert.equal(pred.desyncs, 1);
  // A blob the sim refuses is counted and leaves the state alone.
  const bad = snapshotOf(host, 24);
  bad.stateLen = 3;
  const tickBefore = pred.localTick;
  pred.applySnapshot(bad);
  assert.equal(pred.loadErrors, 1);
  assert.equal(pred.localTick, tickBefore);
});

test('input ring: 256 ticks by tick, overwrites, gaps', () => {
  const ring = new InputRing();
  assert.equal(INPUT_RING, 256);
  assert.equal(ring.has(0), false);
  for (let t = 1; t <= 300; t++) ring.set(t, pack(t / 300, 0), 0);
  assert.equal(ring.newestTick, 300);
  assert.equal(ring.has(300), true);
  assert.equal(ring.has(45), true);
  assert.equal(ring.has(44), false, 'overwritten by 300');
  const out = new Int8Array(6);
  assert.equal(ring.copyTo(300, out, 0), true);
  assert.equal(out[0], 127);
  assert.equal(ring.copyTo(10, out, 0), false);
  ring.clear();
  assert.equal(ring.has(300), false);
  assert.equal(ring.newestTick, -1);
});

test('assembleInputs: newest 2 + everything newer than the ack, capped at 16, oldest first', () => {
  const ring = new InputRing();
  const out = new Int8Array(16 * 6);
  assert.equal(assembleInputs(ring, 0, out), 0, 'empty ring');
  for (let t = 1; t <= 100; t++) ring.set(t, pack(0, t / 100), 0);
  // Everything acked: just the newest two.
  assert.equal(assembleInputs(ring, 99, out), 2);
  assert.equal(out[1], Math.round((99 / 100) * 127));
  assert.equal(out[7], 127);
  assert.equal(assembleInputs(ring, 100, out), 2);
  // Five unacked.
  assert.equal(assembleInputs(ring, 95, out), 5);
  assert.equal(out[1], Math.round((96 / 100) * 127), 'oldest first');
  // Many unacked: cap.
  assert.equal(assembleInputs(ring, 0, out), 16);
  assert.equal(out[1], Math.round((85 / 100) * 127));
  assert.equal(out[15 * 6 + 1], 127);
  // A ring shorter than the window.
  const small = new InputRing();
  small.set(1, pack(1, 0), 0);
  assert.equal(assembleInputs(small, 0, out), 1);
  // A gap ends the run (tick 98 overwritten by 354 then cleared -> missing).
  const gappy = new InputRing();
  for (let t = 90; t <= 100; t++) if (t !== 98) gappy.set(t, pack(0, 0), 0);
  assert.equal(assembleInputs(gappy, 0, out), 2, 'ticks 99, 100 only');
});

test('lead: ceil((rtt/2 + jitter margin) / 8.333) + 1 within [2, 24], bufferHint adjusts +-1 per second', () => {
  assert.equal(computeLead(0, 0), LEAD_MIN);
  assert.equal(computeLead(100, 5), Math.ceil((50 + 12) / TICK_MS) + 1);
  assert.equal(computeLead(100, 5), 9);
  assert.equal(computeLead(1000, 50), LEAD_MAX);
  assert.equal(computeLead(100, 5, -3), 6);
  assert.equal(computeLead(100, 5, -20), LEAD_MIN);
  const adj = new LeadAdjuster(30);
  for (let i = 0; i < 29; i++) adj.onHint(3);
  assert.equal(adj.adjust, 0, 'not yet a full second');
  adj.onHint(3);
  assert.equal(adj.adjust, -1, 'a second of "too far ahead" lowers the lead');
  for (let i = 0; i < 30; i++) adj.onHint(-1);
  assert.equal(adj.adjust, 0, 'a second of underruns raises it again');
  for (let i = 0; i < 15; i++) adj.onHint(-1);
  for (let i = 0; i < 15; i++) adj.onHint(0);
  for (let i = 0; i < 15; i++) adj.onHint(-1);
  assert.equal(adj.adjust, 0, 'zero hints walk the count back: inconsistent hints never adjust');
});
