// Unit tests for server/src/roomHost.ts with a fake sim (no wasm needed). Run from server/:
//   npm test        (= node --experimental-transform-types --test "test/*.test.mjs")
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

const { RoomHost } = await import('../src/roomHost.ts');
const T = await import('../../src/sim/types.ts');
const P = await import('../../src/net/protocol.ts');

/** Minimal HostSim: a state buffer with the roster, a tick counter and a toy save/load format. */
class FakeSim {
  constructor(teams) {
    this.buf = new Float32Array(T.STATE_BUFFER_FLOATS);
    this.buf[T.H_NUM_CARS] = teams.length;
    for (let s = 0; s < teams.length; s++) {
      const o = T.CARS_OFFSET + s * T.CAR_STRIDE;
      this.buf[o + T.C_ID] = s + 1;
      this.buf[o + T.C_TEAM] = teams[s];
      this.buf[o + T.C_POS + 1] = teams[s] === 0 ? -3000 : 3000;
      this.buf[o + T.C_ROT + 2] = 1; // forward = +z (nonsense but non-degenerate)
      this.buf[o + T.C_IS_ON_GROUND] = 1;
      this.buf[o + T.C_BOOST] = 33;
    }
    this.buf[T.BALL_OFFSET + T.B_POS + 2] = 93;
    this.ballPred = new Float32Array(T.BALL_PRED_TICKS * T.BALL_PRED_STRIDE);
    this.predTick = 0;
    this.events = {};
    this.lastPacked = new Int8Array(T.MAX_CARS * T.PACKED_INPUT_BYTES);
    this.resets = [];
    this.pendingGoal = null;
    this.predUpdates = 0;
  }
  get tickCount() {
    return this.buf[T.H_TICK_COUNT];
  }
  get numCars() {
    return this.buf[T.H_NUM_CARS];
  }
  carOffset(slot) {
    return T.CARS_OFFSET + slot * T.CAR_STRIDE;
  }
  slotOf(id) {
    return id - 1;
  }
  teamOf(slot) {
    return this.buf[this.carOffset(slot) + T.C_TEAM] === 1 ? 1 : 0;
  }
  updateBallPrediction() {
    this.predUpdates++;
    this.predTick = this.tickCount;
  }
  setControlsPacked(packed, n) {
    this.lastPacked.fill(0);
    this.lastPacked.set(packed.subarray(0, n * T.PACKED_INPUT_BYTES));
  }
  step(n) {
    this.buf[T.H_TICK_COUNT] += n;
  }
  sync() {
    if (this.pendingGoal !== null) {
      const t = this.pendingGoal;
      this.pendingGoal = null;
      this.events.onGoal?.(t);
    }
  }
  resetKickoff(seed) {
    this.resets.push(seed);
  }
  saveState(out) {
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    dv.setUint32(0, this.tickCount, true);
    for (let i = 0; i < 12; i++) out[4 + i] = this.lastPacked[i] & 0xff;
    return 16;
  }
  stateHash() {
    const tmp = new Uint8Array(64);
    return P.fnv1a32(tmp, this.saveState(tmp));
  }
  stateSizeMax() {
    return 64;
  }
}

const H = { slot: 0, team: 0, kind: 'player', name: 'A', playerId: 'a'.repeat(16) };
const roster1v1 = [H, { slot: 1, team: 1, kind: 'player', name: 'B', playerId: 'b'.repeat(16) }];

function input(throttle, steer = 0, buttons = 0) {
  const p = new Int8Array(6);
  p[0] = throttle;
  p[1] = steer;
  p[5] = buttons;
  return p;
}

/** count consecutive ticks of inputs starting at firstTick, throttle = tick (identifiable). */
function batch(firstTick, count) {
  const p = new Int8Array(count * 6);
  for (let i = 0; i < count; i++) p[i * 6] = (firstTick + i) % 100;
  return p;
}

function makeHost(roster = roster1v1, opts = {}) {
  const sim = new FakeSim(roster.map((e) => e.team));
  const host = new RoomHost(sim, roster, { kickoffCountdownSeconds: 0, goalPauseSeconds: 0.05, ...opts });
  return { sim, host };
}

test('roster validation', () => {
  const sim = new FakeSim([0, 1]);
  assert.throws(() => new RoomHost(sim, [], {}));
  assert.throws(() => new RoomHost(sim, [{ ...H, slot: 1 }], {}), /slot/);
});

test('before start: frozen, zero controls, no underruns counted', () => {
  const { sim, host } = makeHost();
  host.setConnected(0, true);
  host.addInputs(0, 1, 2, batch(1, 2));
  assert.equal(host.frozen, true);
  host.tick();
  assert.equal(host.currentTick, 1);
  assert.equal(sim.lastPacked[0], 0, 'frozen -> zero controls');
  assert.equal(host.lastInputTick(0), 1, 'the input is still consumed');
  assert.equal(host.slotStats[0].underruns, 0);
});

test('inputs apply on their tick; a missing tick repeats the last and counts an underrun', () => {
  const { sim, host } = makeHost();
  host.setConnected(0, true);
  host.start();
  host.tick(); // tick 1: kickoff with 0 s countdown -> frozen this tick, 'go' after it
  assert.equal(host.phase, 'playing');
  assert.equal(host.addInputs(0, 2, 2, batch(2, 2)), 2);
  host.tick(); // tick 2
  assert.equal(sim.lastPacked[0], 2);
  assert.equal(host.lastInputTick(0), 2);
  assert.equal(host.queued(0), 1);
  assert.equal(host.bufferHint(0), 1 - 2, 'queued - target');
  host.tick(); // tick 3 (queued)
  assert.equal(sim.lastPacked[0], 3);
  assert.equal(host.slotStats[0].underruns, 0);
  host.tick(); // tick 4: nothing queued -> repeat tick 3's input
  assert.equal(sim.lastPacked[0], 3);
  assert.equal(host.lastInputTick(0), 3);
  assert.equal(host.slotStats[0].underruns, 1);
  assert.equal(host.bufferHint(0), -3, 'newest 3 - tick 4 - target 2');
  // slot 1 never sent anything: hint stays 0 and no underruns
  assert.equal(host.bufferHint(1), 0);
  assert.equal(host.slotStats[1].underruns, 0);
  // the echo holds what was applied
  assert.equal(host.appliedInputs[0], 3);
  assert.equal(host.appliedInputs[6], 0);
});

test('late inputs are ignored, far-future inputs dropped, +32 accepted', () => {
  const { host } = makeHost();
  host.setConnected(0, true);
  host.start();
  for (let i = 0; i < 5; i++) host.tick(); // tick 5
  assert.equal(host.addInputs(0, 1, 5, batch(1, 5)), 0, 'all late');
  assert.equal(host.addInputs(0, 4, 4, batch(4, 4)), 2, 'ticks 6 and 7 stored, 4 and 5 ignored');
  assert.equal(host.addInputs(0, 5 + 33, 1, batch(38, 1)), 0, 'beyond +32');
  assert.equal(host.slotStats[0].dropped, 1);
  assert.equal(host.addInputs(0, 6, 40, batch(6, 40)), 32, 'exactly +32 fit');
  assert.equal(host.slotStats[0].dropped, 1 + 8);
  assert.equal(host.addInputs(1, 6, 1, batch(6, 1)), 1);
  assert.equal(host.addInputs(5, 6, 1, batch(6, 1)), 0, 'not a slot');
  assert.equal(host.addInputs(0, 6, 0, batch(6, 1)), 0, 'count 0');
});

test('bufferHint clamps at +-8 and counts overruns', () => {
  const { host } = makeHost();
  host.setConnected(0, true);
  host.start();
  host.tick();
  host.addInputs(0, 2, 32, batch(2, 32)); // queue 32 ticks ahead
  host.tick(); // tick 2: newest 33 - 2 = 31 queued
  assert.equal(host.queued(0), 31);
  assert.equal(host.bufferHint(0), 8);
  assert.equal(host.slotStats[0].overruns, 1);
  for (let i = 0; i < 40; i++) host.tick();
  assert.equal(host.bufferHint(0), -8, 'far behind now');
  assert.equal(host.slotStats[0].underruns, 42 - 33);
});

test('disconnecting a slot zeroes its controls and clears the queue', () => {
  const { sim, host } = makeHost();
  host.setConnected(0, true);
  host.start();
  host.tick();
  host.addInputs(0, 2, 10, batch(2, 10));
  host.tick();
  assert.equal(sim.lastPacked[0], 2);
  host.setConnected(0, false);
  host.tick();
  assert.equal(sim.lastPacked[0], 0);
  assert.equal(host.bufferHint(0), 0);
  assert.equal(host.slotStats[0].underruns, 0, 'a disconnected slot is not an underrun');
});

test('match flow: kickoff reset, countdown 3-2-1, go, clock, goal, kickoff again, seeds', () => {
  const { sim, host } = makeHost(roster1v1, { kickoffCountdownSeconds: 3, goalPauseSeconds: 1, kickoffSeed: 10, matchLengthSeconds: 300 });
  host.start();
  const evs = [];
  const drain = () => {
    const out = [];
    host.takeEvents(out);
    evs.push(...out);
  };
  host.tick();
  drain();
  assert.deepEqual(
    evs.map((e) => e.type),
    ['kickoff', 'countdown'],
  );
  assert.equal(evs[1].n, 3);
  assert.equal(evs[0].tick, 1);
  assert.deepEqual(sim.resets, [10]);
  for (let i = 0; i < 360; i++) host.tick();
  drain();
  const types = evs.map((e) => e.type + (e.type === 'countdown' ? e.n : ''));
  assert.deepEqual(types.slice(0, 6), ['kickoff', 'countdown3', 'countdown2', 'countdown1', 'go', 'clock']);
  assert.equal(evs[5].seconds, 300);
  assert.equal(host.phase, 'playing');
  assert.equal(host.frozen, false);
  // one second of play -> one clock event (299)
  for (let i = 0; i < 120; i++) host.tick();
  drain();
  const clocks = evs.filter((e) => e.type === 'clock').map((e) => e.seconds);
  assert.deepEqual(clocks, [300, 299]);
  // a goal: pause (frozen), then a new kickoff with the next seed
  sim.pendingGoal = 1;
  host.tick();
  drain();
  const goal = evs.find((e) => e.type === 'goal');
  assert.ok(goal);
  assert.deepEqual([goal.team, goal.blue, goal.red], [1, 0, 1]);
  assert.equal(host.frozen, true);
  assert.deepEqual(host.score, { blue: 0, red: 1 });
  for (let i = 0; i < 121; i++) host.tick();
  drain();
  assert.deepEqual(sim.resets, [10, 11]);
  assert.equal(evs.filter((e) => e.type === 'kickoff').length, 2);
  // a goal during the pause does not count
  assert.equal(host.phase, 'kickoff');
});

test('ends by the clock, with winner / score in the ended event', () => {
  const { sim, host } = makeHost(roster1v1, { matchLengthSeconds: 1, kickoffCountdownSeconds: 0, goalPauseSeconds: 0.01 });
  host.start();
  host.tick();
  sim.pendingGoal = 0;
  host.tick();
  let ended = null;
  for (let i = 0; i < 400 && !ended; i++) {
    host.tick();
    const out = [];
    host.takeEvents(out);
    ended = out.find((e) => e.type === 'ended') ?? null;
  }
  assert.ok(ended, 'ended within 400 ticks');
  assert.deepEqual([ended.winner, ended.blue, ended.red], [0, 1, 0]);
  assert.equal(host.ended, true);
  assert.equal(host.frozen, true);
});

test('snapshot encodes tick, per-slot lastInputTick / bufferHint, echoed inputs, state and hash', () => {
  const { sim, host } = makeHost();
  host.setConnected(0, true);
  host.setConnected(1, true);
  host.start();
  host.tick();
  host.addInputs(0, 2, 4, batch(2, 4));
  host.addInputs(1, 2, 1, input(-50, 20, T.BTN_BOOST));
  for (let i = 0; i < 3; i++) host.tick(); // tick 4
  assert.equal(host.snapshotDue, true);
  const out = new Uint8Array(host.snapshotMaxBytes);
  const pkt = { tick: 0, lastInputTick: 0, bufferHint: 0, numCars: 0, inputs: new Int8Array(T.MAX_CARS * 6), stateLen: 0, state: new Uint8Array(0), stateHash: 0 };
  const len0 = host.snapshot(out, 0);
  assert.ok(P.decodeSnapshot(out.subarray(0, len0), pkt));
  assert.equal(pkt.tick, 4);
  assert.equal(pkt.lastInputTick, 4);
  assert.equal(pkt.bufferHint, 5 - 4 - 2);
  assert.equal(pkt.numCars, 2);
  assert.equal(pkt.inputs[0], 4, 'slot 0 applied tick 4');
  assert.deepEqual(Array.from(pkt.inputs.subarray(6, 12)), [-50, 20, 0, 0, 0, T.BTN_BOOST], 'slot 1 repeats its tick-2 input');
  assert.equal(pkt.stateLen, 16);
  assert.equal(new DataView(pkt.state.buffer, pkt.state.byteOffset).getUint32(0, true), 4, 'fake state carries the tick');
  assert.equal(pkt.stateHash, P.fnv1a32(pkt.state, pkt.stateLen));
  assert.equal(pkt.stateHash, sim.stateHash());
  const len1 = host.snapshot(out, 1);
  assert.ok(P.decodeSnapshot(out.subarray(0, len1), pkt));
  assert.equal(pkt.lastInputTick, 2);
  assert.equal(pkt.bufferHint, -4, 'newest 2 - tick 4 - target 2');
  assert.equal(len0, len1);
  host.tick();
  assert.equal(host.snapshotDue, false);
});

test('bots drive the bot slots (BotTeam), humans stay passive members', () => {
  const roster = [
    { slot: 0, team: 0, kind: 'player', name: 'A', playerId: 'a'.repeat(16) },
    { slot: 1, team: 0, kind: 'bot', name: 'Bot 2' },
    { slot: 2, team: 1, kind: 'bot', name: 'Bot 1' },
    { slot: 3, team: 1, kind: 'bot', name: 'Bot 2' },
  ];
  const { sim, host } = makeHost(roster);
  host.setConnected(0, true);
  host.start();
  for (let i = 0; i < 20; i++) host.tick();
  assert.equal(host.isHumanSlot(0), true);
  assert.equal(host.isHumanSlot(1), false);
  assert.ok(sim.predUpdates > 0, 'ball prediction refreshed for the bots');
  let nonZero = 0;
  for (let s = 1; s < 4; s++) for (let k = 0; k < 6; k++) if (sim.lastPacked[s * 6 + k] !== 0) nonZero++;
  assert.ok(nonZero > 0, 'bots produced some controls');
  assert.equal(host.addInputs(1, 21, 1, input(1)), 0, 'no inputs for a bot slot');
});

test('convertToBot: the left human slot is driven by its team BotTeam from the next tick; its inputs are refused; idempotent', () => {
  // 1v1 human vs human: blue has no BotTeam until its human leaves.
  const { sim, host } = makeHost();
  host.setConnected(0, true);
  host.setConnected(1, true);
  host.start();
  host.tick();
  host.addInputs(0, 2, 10, batch(2, 10));
  host.addInputs(1, 2, 1, input(-50));
  for (let i = 0; i < 4; i++) host.tick(); // tick 5
  assert.equal(sim.lastPacked[0], 5, 'slot 0 applies its own inputs');
  assert.equal(host.convertToBot(0), true);
  assert.equal(host.isHumanSlot(0), false);
  assert.equal(host.isHumanSlot(1), true);
  assert.equal(host.convertToBot(0), false, 'already a bot');
  assert.equal(host.convertToBot(7), false, 'not a slot');
  assert.equal(host.addInputs(0, 6, 1, input(100)), 0, 'no inputs for a bot slot');
  assert.equal(host.bufferHint(0), 0);
  let botControls = 0;
  for (let i = 0; i < 20; i++) {
    host.tick();
    for (let k = 0; k < 6; k++) if (sim.lastPacked[k] !== 0) botControls++;
    assert.notEqual(sim.lastPacked[0], 6 + i, 'the queued human inputs are never applied');
  }
  assert.ok(botControls > 0, 'the bot drives slot 0');
  assert.equal(sim.lastPacked[6], -50, 'the remaining human keeps its own input');
  // The snapshot of a bot slot carries no lastInputTick (no client acks for it).
  const out = new Uint8Array(host.snapshotMaxBytes);
  const pkt = { tick: 0, lastInputTick: 0, bufferHint: 0, numCars: 0, inputs: new Int8Array(T.MAX_CARS * 6), stateLen: 0, state: new Uint8Array(0), stateHash: 0 };
  assert.ok(P.decodeSnapshot(out.subarray(0, host.snapshot(out, 0)), pkt));
  assert.equal(pkt.lastInputTick, 0);
});

test('convertToBot joins an existing BotTeam (the other humans stay passive); frozen phases zero the new bot too', () => {
  const roster = [
    { slot: 0, team: 0, kind: 'player', name: 'A', playerId: 'a'.repeat(16) },
    { slot: 1, team: 0, kind: 'player', name: 'B', playerId: 'b'.repeat(16) },
    { slot: 2, team: 1, kind: 'player', name: 'C', playerId: 'c'.repeat(16) },
    { slot: 3, team: 1, kind: 'bot', name: 'Bot 2' },
  ];
  const { sim, host } = makeHost(roster, { kickoffCountdownSeconds: 1 });
  for (let s = 0; s < 3; s++) host.setConnected(s, true);
  assert.equal(host.convertToBot(2), true, 'before the start');
  host.start();
  for (let i = 0; i < 100; i++) {
    host.tick();
    if (host.frozen) for (let k = 0; k < 6; k++) assert.equal(sim.lastPacked[2 * 6 + k], 0, 'countdown: zero controls');
  }
  for (let i = 0; i < 60; i++) host.tick();
  assert.equal(host.frozen, false);
  let moved = 0;
  for (let k = 0; k < 6; k++) if (sim.lastPacked[2 * 6 + k] !== 0) moved++;
  assert.ok(moved > 0, 'slot 2 is driven next to the bot of slot 3');
  // Blue still has no bots: slot 0 / 1 humans get zero (they sent nothing).
  assert.equal(sim.lastPacked[0], 0);
  assert.equal(sim.lastPacked[6], 0);
});

test('convertToBot is deterministic: two hosts with the same inputs and the same takeover tick apply the same controls every tick', () => {
  const run = (takeoverAt) => {
    const { sim, host } = makeHost(roster1v1, { kickoffCountdownSeconds: 0.1 });
    host.setConnected(0, true);
    host.setConnected(1, true);
    host.start();
    const trace = [];
    for (let t = 1; t <= 200; t++) {
      if (t === takeoverAt) host.convertToBot(1);
      host.addInputs(0, t, 1, input((t * 7) % 127, (t * 3) % 50));
      host.addInputs(1, t, 1, input(-((t * 5) % 127)));
      host.tick();
      trace.push(Array.from(sim.lastPacked.subarray(0, 12)).join(','));
    }
    return trace;
  };
  const a = run(80);
  const b = run(80);
  assert.deepEqual(a, b);
  const c = run(81);
  assert.notDeepEqual(a, c, 'a different takeover tick is a different history');
  assert.deepEqual(a.slice(0, 79), c.slice(0, 79), 'identical up to the first takeover');
});
