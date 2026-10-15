// RoomHost (server/src/roomHost.ts) on the REAL RocketSim wasm with a client RocketSim +
// RollbackPredictor on the other end, in one process: the in-process twin of server/test/smoke.mjs
// (no workerd, no sockets). The human slot is fed the way the browser feeds the host (its inputs
// produced `lead` ticks ahead and shipped at once); the other slots are the host's BotTeam.
// Checks, for every snapshot the host encodes:
//   - fnv1a32(blob) == stateHash, and the client's loadState gives the same hash / tick (desync 0);
//   - the client's rollback (load + replay of its own ticks) keeps its local tick and never fails;
//   - with the controls the host actually applied each tick (host.appliedInputs), a client that
//     loads snapshot k and steps to snapshot k + 1 lands exactly on snapshot k + 1's hash: a host
//     tick is reproducible from blob + inputs alone (pairs with a kickoff reset excepted).
// Plus: a human quitting for good (RoomHost.convertToBot, the explicit leave) is deterministic on
// the real wasm (two hosts, same inputs, same takeover tick: same hashes) and the bot drives on.
// The fake-sim unit tests of the RoomHost stay in server/test/roomHost.test.mjs.
//   node --test tests/net-roomhost-wasm.test.mjs
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
const { buildArenaMesh } = await import('../src/sim/arenaMesh.ts');
const T = await import('../src/sim/types.ts');
const P = await import('../src/net/protocol.ts');
const { RoomHost } = await import('../server/src/roomHost.ts');
const { RollbackPredictor } = await import('../src/net/Prediction.ts');

const { CarPreset, TICK_RATE, PACKED_INPUT_BYTES, MAX_CARS } = T;
const mesh = buildArenaMesh().physics;
const KICKOFF_SEED = 1;
const SNAPSHOT_EVERY = 4;

/** A fresh instance with the roster's cars in slot order (server/src/wasm.ts and Game.applyOnlineRoster do the same). */
async function arenaFor(roster) {
  const sim = await RocketSim.load();
  sim.initArena(mesh);
  sim.createArena(TICK_RATE);
  for (const e of roster) sim.addCar(e.team, CarPreset.Standard);
  sim.resetKickoff(KICKOFF_SEED);
  sim.sync();
  return sim;
}

/** Matchmaker slot order: blue humans, blue bots, red humans, red bots. One human at slot 0. */
function rosterFor(perTeam) {
  const roster = [{ slot: 0, team: 0, kind: 'player', name: 'Human', playerId: 'a'.repeat(16) }];
  for (let b = 1; b < perTeam; b++) roster.push({ slot: roster.length, team: 0, kind: 'bot', name: `Bot ${b + 1}` });
  for (let b = 0; b < perTeam; b++) roster.push({ slot: roster.length, team: 1, kind: 'bot', name: `Bot ${b + 1}` });
  return roster;
}

/** The human's packed input for a tick: drives, turns, boosts, slides and jumps in phases (deterministic). */
function humanInput(tick, out, off) {
  const phase = Math.floor(tick / 90) % 6;
  out[off] = 127;
  out[off + 1] = phase === 1 ? 80 : phase === 3 ? -80 : phase === 5 ? 127 : 0;
  out[off + 2] = phase === 4 ? -60 : 0;
  out[off + 3] = 0;
  out[off + 4] = 0;
  out[off + 5] = (phase === 2 || phase === 5 ? T.BTN_BOOST : 0) | (tick % 180 === 7 ? T.BTN_JUMP : 0) | (phase === 3 ? T.BTN_HANDBRAKE : 0);
}

/**
 * `ticks` host ticks with a client predicting `lead` ticks ahead whose inputs always reach the
 * host before their tick (a good connection). Returns everything the assertions need.
 */
async function runMatch(perTeam, ticks, lead) {
  const roster = rosterFor(perTeam);
  const n = roster.length;
  const hostSim = await arenaFor(roster);
  const clientSim = await arenaFor(roster);
  const host = new RoomHost(hostSim, roster, {
    tickRate: TICK_RATE,
    snapshotEvery: SNAPSHOT_EVERY,
    inputBufferTarget: 2,
    inputBufferMax: 8,
    matchLengthSeconds: 300,
    kickoffSeed: KICKOFF_SEED,
    kickoffCountdownSeconds: 0.5,
    goalPauseSeconds: 0.5,
  });
  const pred = new RollbackPredictor(clientSim, 0, n);
  pred.trackHashes = true;
  host.setConnected(0, true);
  host.start();

  const out = new Uint8Array(host.snapshotMaxBytes);
  const pkt = { tick: 0, lastInputTick: 0, bufferHint: 0, numCars: 0, inputs: new Int8Array(MAX_CARS * PACKED_INPUT_BYTES), stateLen: 0, state: new Uint8Array(0), stateHash: 0 };
  const applied = new Map(); // host tick -> copy of the controls the host applied at it
  const snapshots = [];
  const kickoffTicks = [];
  const eventTypes = [];
  const hints = new Map();
  const mine = new Int8Array(PACKED_INPUT_BYTES);
  const evs = [];
  let lateInputs = 0;
  let appliesWhileSynced = 0;
  const t0 = performance.now();
  for (let t = 1; t <= ticks; t++) {
    // Client: once synced, keep the local sim `lead` ticks ahead of the host (now at t - 1) and
    // ship every new input right away.
    if (pred.synced) {
      while (pred.localTick < t - 1 + lead) {
        const lt = pred.localTick + 1;
        humanInput(lt, mine, 0);
        pred.stepLocal(lt, mine, 0);
        if (host.addInputs(0, lt, 1, mine, 0) !== 1) lateInputs++;
      }
    }
    host.tick();
    applied.set(t, Int8Array.from(host.appliedInputs.subarray(0, n * PACKED_INPUT_BYTES)));
    const ne = host.takeEvents(evs);
    for (let i = 0; i < ne; i++) {
      eventTypes.push(evs[i].type);
      if (evs[i].type === 'kickoff') kickoffTicks.push(evs[i].tick);
    }
    if (host.snapshotDue) {
      const len = host.snapshot(out, 0);
      assert.ok(P.decodeSnapshot(out.subarray(0, len), pkt), `snapshot at tick ${t} decodes`);
      assert.equal(pkt.tick, t);
      assert.equal(pkt.numCars, n);
      const copy = {
        tick: pkt.tick,
        lastInputTick: pkt.lastInputTick,
        bufferHint: pkt.bufferHint,
        numCars: pkt.numCars,
        inputs: Int8Array.from(pkt.inputs),
        stateLen: pkt.stateLen,
        state: Uint8Array.from(pkt.state),
        stateHash: pkt.stateHash,
        bytes: len,
      };
      snapshots.push(copy);
      hints.set(copy.bufferHint, (hints.get(copy.bufferHint) ?? 0) + 1);
      // Client: like OnlineSession.advance -> RollbackPredictor.applySnapshot (load, hash check,
      // holds from the echo, replay of its own ticks after the snapshot).
      const before = pred.localTick;
      const wasSynced = pred.synced;
      pred.applySnapshot(copy);
      if (wasSynced) {
        assert.equal(pred.localTick, before, `rollback keeps the local tick (snapshot ${t})`);
        appliesWhileSynced++;
      }
    }
  }
  const ms = performance.now() - t0;
  return { roster, n, host, hostSim, clientSim, pred, applied, snapshots, kickoffTicks, eventTypes, hints, lateInputs, appliesWhileSynced, ms };
}

function checkRun(r, label) {
  const { host, pred, snapshots, applied, kickoffTicks, clientSim, n } = r;
  assert.equal(r.lateInputs, 0, 'every client input reached the host before its tick');
  assert.equal(host.slotStats[0].underruns, 0, 'no underruns on the human slot');
  assert.equal(host.slotStats[0].dropped, 0);
  assert.equal(host.lastInputTick(0), host.currentTick, 'the newest applied input is the current tick');
  assert.equal(snapshots.length, Math.floor(host.currentTick / SNAPSHOT_EVERY), 'one snapshot every 4 ticks');
  for (let i = 1; i < snapshots.length; i++) assert.equal(snapshots[i].tick - snapshots[i - 1].tick, SNAPSHOT_EVERY);
  for (const s of snapshots) {
    assert.equal(P.fnv1a32(s.state, s.stateLen), s.stateHash, `fnv1a32(blob) == stateHash at tick ${s.tick}`);
    assert.equal(s.inputs[0], applied.get(s.tick)[0], 'the echo carries the applied input of the human slot');
  }
  assert.ok(r.eventTypes.includes('go') && r.eventTypes.includes('clock'), `events: ${r.eventTypes.slice(0, 8).join(',')}`);
  assert.ok(kickoffTicks.length >= 1 && kickoffTicks[0] <= SNAPSHOT_EVERY, 'the match starts with a kickoff reset');

  // Client rollback path: no desync, no load error, no resync; one rollback per snapshot after the first.
  assert.equal(pred.desyncs, 0, 'hash after loadState == snapshot.stateHash for every snapshot');
  assert.equal(pred.loadErrors, 0);
  assert.equal(pred.resyncs, 0);
  assert.equal(pred.rollbacks, r.appliesWhileSynced);
  assert.equal(pred.rollbacks, snapshots.length - 1);
  assert.ok(Number.isFinite(pred.lastErrorCar) && Number.isFinite(pred.maxErrorCar));

  // Host-tick reproducibility: load snapshot k, step with the applied controls, land on k + 1.
  let checked = 0;
  let skipped = 0;
  for (let i = 0; i + 1 < snapshots.length; i++) {
    const a = snapshots[i];
    const b = snapshots[i + 1];
    if (kickoffTicks.some((k) => k > a.tick && k <= b.tick)) {
      skipped++;
      continue;
    }
    clientSim.loadState(a.state, a.stateLen);
    for (let t = a.tick + 1; t <= b.tick; t++) {
      clientSim.setControlsPacked(applied.get(t), n);
      clientSim.step(1);
    }
    clientSim.sync();
    assert.equal(clientSim.tickCount, b.tick);
    assert.equal(clientSim.stateHash(), b.stateHash, `replay ${a.tick} -> ${b.tick} reproduces the host`);
    checked++;
  }
  const sizes = snapshots.map((s) => s.bytes);
  const hints = [...r.hints.entries()].sort((x, y) => x[0] - y[0]).map(([h, c]) => `${h}:${c}`).join(' ');
  const goals = r.eventTypes.filter((e) => e === 'goal').length;
  console.log(
    `${label}: ${host.currentTick} ticks in ${r.ms.toFixed(0)} ms, ${snapshots.length} snapshots (${Math.min(...sizes)}-${Math.max(...sizes)} B), ` +
      `replay pairs checked ${checked} (skipped ${skipped} with a kickoff), kickoffs at ${kickoffTicks.join(',')}, ${goals} goals, ` +
      `rollbacks ${pred.rollbacks} / replayed ${pred.replayedTicks} ticks, mispredictions ${pred.mispredictions}, ` +
      `max car error ${pred.maxErrorCar.toFixed(1)} uu, bufferHint ${hints}`,
  );
  return checked;
}

test('1v1 human vs bot, 10 s: every snapshot loads with the host hash, the rollback never desyncs, host ticks replay exactly', async () => {
  const r = await runMatch(1, 1200, 4);
  const checked = checkRun(r, '1v1');
  assert.ok(checked >= 250, `${checked} replay pairs checked`);
});

test('3v3 with one human and five bots, 5 s: the same contract with six cars', async () => {
  const r = await runMatch(3, 600, 6);
  const checked = checkRun(r, '3v3');
  assert.ok(checked >= 120, `${checked} replay pairs checked`);
});

test('a human quitting for good (convertToBot) on the real wasm: two hosts with the same inputs and takeover tick stay identical; the bot drives the car on', async () => {
  // 1v1 between two humans; slot 1 quits at tick 400 (MatchDO /internal/leave between two ticks).
  const roster = [
    { slot: 0, team: 0, kind: 'player', name: 'A', playerId: 'a'.repeat(16) },
    { slot: 1, team: 1, kind: 'player', name: 'B', playerId: 'b'.repeat(16) },
  ];
  const TAKEOVER = 400;
  const TICKS = 1200;
  const make = async () => {
    const sim = await arenaFor(roster);
    const host = new RoomHost(sim, roster, { tickRate: TICK_RATE, snapshotEvery: SNAPSHOT_EVERY, matchLengthSeconds: 300, kickoffSeed: KICKOFF_SEED, kickoffCountdownSeconds: 0.5, goalPauseSeconds: 0.5 });
    host.setConnected(0, true);
    host.setConnected(1, true);
    host.start();
    return { sim, host };
  };
  const a = await make();
  const b = await make();
  const c = await make(); // slot 1 only disconnects (a network drop): zero controls, no bot
  const inA = new Int8Array(PACKED_INPUT_BYTES);
  const inB = new Int8Array(PACKED_INPUT_BYTES);
  let botTicks = 0;
  let pathLen = 0;
  let lastX = 0;
  let lastY = 0;
  let compared = 0;
  for (let t = 1; t <= TICKS; t++) {
    if (t === TAKEOVER) {
      assert.equal(a.host.convertToBot(1), true);
      assert.equal(b.host.convertToBot(1), true);
      c.host.setConnected(1, false);
    }
    humanInput(t, inA, 0);
    humanInput(t + 333, inB, 0);
    for (const h of [a, b, c]) {
      h.host.addInputs(0, t, 1, inA, 0);
      if (t < TAKEOVER) h.host.addInputs(1, t, 1, inB, 0);
      else if (h !== c) assert.equal(h.host.addInputs(1, t, 1, inB, 0), 0, 'after the takeover slot 1 refuses inputs'); // c: its socket is gone, nothing arrives
      h.host.tick();
    }
    const applied = a.host.appliedInputs;
    if (t >= TAKEOVER) {
      for (let k = 0; k < PACKED_INPUT_BYTES; k++) if (applied[PACKED_INPUT_BYTES + k] !== 0) {
        botTicks++;
        break;
      }
      for (let k = 0; k < PACKED_INPUT_BYTES; k++) assert.equal(c.host.appliedInputs[PACKED_INPUT_BYTES + k], 0, 'a dropped slot gets zero controls');
      const o = a.sim.carOffset(1);
      const x = a.sim.buf[o + T.C_POS];
      const y = a.sim.buf[o + T.C_POS + 1];
      if (t > TAKEOVER) {
        const d = Math.hypot(x - lastX, y - lastY);
        if (d < 100) pathLen += d; // a kickoff teleport is not driving
      }
      lastX = x;
      lastY = y;
    }
    if (a.host.snapshotDue) {
      a.host.prepareSnapshot();
      b.host.prepareSnapshot();
      assert.equal(a.host.stateHash, b.host.stateHash, `same state at tick ${t}`);
      compared++;
    }
  }
  assert.equal(compared, TICKS / SNAPSHOT_EVERY);
  assert.ok(botTicks > 300, `the bot wrote slot 1's controls on ${botTicks} ticks`);
  assert.ok(pathLen > 1000, `slot 1 drove ${pathLen.toFixed(0)} uu after the takeover`);
  c.host.prepareSnapshot();
  assert.notEqual(c.host.stateHash, a.host.stateHash, 'a drop (zero controls) is a different history than the takeover');
});
