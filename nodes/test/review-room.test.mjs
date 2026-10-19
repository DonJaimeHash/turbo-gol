// MatchRoom endings against the real verifier: every way a room ends a started match must carry
// its proof in the replay, even when the node's wall clock and its simulation disagree (an event
// loop stall makes the sim fall behind: advance() clamps dt). Also the TTL: armed by the control
// plane's clock (RoomContext.serverNow) and only whistled in overtime. A match that started but has
// not ticked yet cannot end with a replay (no record at tick 0): it is cancelled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { T, P, chaseInput, roster1v1, testBuild } from './helpers.mjs';

const { MatchRoom } = await import('../node/matchRoom.ts');
const { LagHistogram } = await import('../node/ticker.ts');
const { verifyReplay, FORFEIT_DC_TICKS, EMPTY_PROOF_TICKS } = await import('../shared/verify.ts');
const { nodeSimFactory } = await import('../shared/nodeArena.ts');
const { decodeReplay } = await import('../shared/replay.ts');

const NODE_ID = 'n'.repeat(16);
const TICK_RATE = 120;
const TICK_MS = 1000 / TICK_RATE;
const READY = new Uint8Array([P.MsgType.Ready]);

let matchSeq = 0;
let jtiSeq = 0;

function assignment(extra = {}) {
  matchSeq++;
  return {
    matchId: ('room' + matchSeq).padEnd(32, 'x'),
    mode: '1v1',
    region: 'SA',
    ranked: false,
    roster: roster1v1(true, true),
    matchLengthSeconds: 300,
    kickoffSeed: 5,
    botDifficulty: 'medium',
    createdAt: Date.now(),
    kickoffCountdownSeconds: 1,
    goalPauseSeconds: 1,
    ...extra,
  };
}

function fakeWs() {
  return { remoteAddress: '127.0.0.1', protocol: '', open: true, bufferedAmount: 0, bytesSent: 0, onmessage: null, onclose: null, send() {}, close() {} };
}

async function makeRoom(assign, opts = {}) {
  const build = await testBuild();
  const seen = { ended: null, cancelled: null, lost: null, closed: null };
  const ticker = { lag: new LagHistogram(), add() {}, remove() {} };
  const room = await MatchRoom.create(assign, {
    nodeId: NODE_ID,
    label: 'test',
    build,
    ticker,
    timings: { endLingerMs: 0, ...(opts.timings ?? {}) },
    ...(opts.serverNow ? { serverNow: opts.serverNow } : {}),
    hooks: {
      onEnded(_r, result, replay, stats) {
        seen.ended = { result, replay, stats };
      },
      onCancelled(_r, reason, noShows) {
        seen.cancelled = { reason, noShows, at: Date.now() };
      },
      onLost(_r, reason) {
        seen.lost = reason;
      },
      onClosed(_r, reason) {
        seen.closed = reason;
      },
    },
  });
  return { room, seen, build };
}

/** Attach a fake socket for `slot` (precheck first, like the transports do). */
function join(room, assign, slot) {
  const e = assign.roster[slot];
  jtiSeq++;
  const claims = { sub: e.playerId, mid: assign.matchId, team: e.team, slot, role: 'player', name: e.name, iat: 0, exp: 0, jti: String(jtiSeq).padStart(32, '0'), aud: '' };
  const pre = room.precheck(claims);
  assert.ok(pre.ok, JSON.stringify(pre));
  const ws = fakeWs();
  room.attach(ws, claims);
  return ws;
}

async function verify(replay, assign, build, extra = {}) {
  return verifyReplay(replay, { makeSim: nodeSimFactory, wasmSha256: build.wasmSha256, protocol: P.PROTOCOL_VERSION, expect: assign, expectNodeId: NODE_ID, ...extra });
}

/**
 * Fake wall clock for Date.now and performance.now while `fn` runs, so a test can stall the node
 * (jump the clock) without waiting. Real timers (setTimeout) are untouched.
 */
async function withFakeClock(fn) {
  const clock = { t: 1_000_000 };
  const realDateNow = Date.now;
  Date.now = () => clock.t;
  Object.defineProperty(performance, 'now', { value: () => clock.t, configurable: true, writable: true });
  try {
    return await fn(clock);
  } finally {
    Date.now = realDateNow;
    delete performance.now; // back to Performance.prototype.now
  }
}

/**
 * Drive the room like the Ticker does (a callback every 4 ms of `clock`), feeding every slot in
 * `live` a ball-chaser input a couple of ticks ahead, as a client would. Stops when `until()` is
 * true or the room has ended; `onStep()` runs before each advance (disconnects, stalls).
 */
function drive(room, clock, live, until, onStep = () => {}) {
  const one = new Int8Array(T.PACKED_INPUT_BYTES);
  let guard = 0;
  while (!room.isEnded && !until()) {
    if (++guard > 200_000) throw new Error('drive: runaway');
    clock.t += 4;
    const host = room.host;
    for (const s of live) {
      for (let k = 1; k <= 2; k++) {
        chaseInput(room.arena.sim, s, host.currentTick + k, one);
        host.addInputs(s, host.currentTick + k, 1, one, 0);
      }
    }
    onStep();
    room.advance(clock.t);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, ms, what) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out waiting for ' + what);
    await sleep(20);
  }
}

// ---- 1. ranked disconnect forfeit, measured in sim ticks -------------------------------------

test('a ranked disconnect forfeit after an event-loop stall verifies ok (forfeit measured in sim ticks)', async () => {
  for (const stallMs of [3_000, 65_000]) {
    await withFakeClock(async (clock) => {
      const assign = assignment({ ranked: true, createdAt: clock.t });
      const { room, seen, build } = await makeRoom(assign);
      const ws = [join(room, assign, 0), join(room, assign, 1)];
      for (const w of ws) w.onmessage(READY, false);
      assert.equal(room.host.isStarted, true, 'ranked starts when everyone is ready');
      const live = new Set([0, 1]);
      let dcTick = -1;
      let stalled = false;
      drive(room, clock, live, () => false, () => {
        const t = room.host.currentTick;
        if (dcTick < 0 && t >= 1200) {
          dcTick = t;
          live.delete(1);
          ws[1].onclose(1006, '');
        }
        // The node freezes: the wall clock jumps, the sim only gets one clamped advance.
        if (dcTick >= 0 && !stalled && t >= dcTick + 2400) {
          stalled = true;
          clock.t += stallMs;
        }
      });
      assert.ok(seen.ended, `stall ${stallMs}: the match ended`);
      const res = seen.ended.result;
      assert.equal(res.endReason, 'forfeit');
      assert.equal(res.forfeitTeam, 1);
      assert.equal(res.winner, 0);
      assert.ok(res.endTick - dcTick >= FORFEIT_DC_TICKS, `stall ${stallMs}: whistled ${res.endTick - dcTick} ticks after the disconnect`);
      assert.deepEqual(
        seen.ended.stats.slots.map((s) => [s.slot, s.connectedAtEnd]),
        [
          [0, true],
          [1, false],
        ],
        `stall ${stallMs}: who had a socket at the whistle`,
      );
      const v = await verify(seen.ended.replay, assign, build, { leaves: [] });
      assert.equal(v.code, 'ok', `stall ${stallMs}: ${v.code} ${v.message ?? ''}`);
      assert.equal(v.endReason, 'forfeit');
      assert.equal(v.forfeitTeam, 1);
      assert.equal(v.winner, 0);
    });
  }
});

test('a ranked reconnect resets the disconnect count: the forfeit counts from the last disconnection', async () => {
  await withFakeClock(async (clock) => {
    const assign = assignment({ ranked: true, createdAt: clock.t });
    const { room, seen, build } = await makeRoom(assign);
    const ws = [join(room, assign, 0), join(room, assign, 1)];
    for (const w of ws) w.onmessage(READY, false);
    const live = new Set([0, 1]);
    let firstDc = -1;
    let back = -1;
    let lastDc = -1;
    let ws2 = null;
    drive(room, clock, live, () => false, () => {
      const t = room.host.currentTick;
      if (firstDc < 0 && t >= 600) {
        firstDc = t;
        live.delete(1);
        ws[1].onclose(1006, '');
      } else if (firstDc >= 0 && back < 0 && t >= firstDc + FORFEIT_DC_TICKS - 600) {
        back = t;
        ws2 = join(room, assign, 1); // a new ticket, same player
        live.add(1);
      } else if (back >= 0 && lastDc < 0 && t >= back + 600) {
        lastDc = t;
        live.delete(1);
        ws2.onclose(1006, '');
      }
    });
    assert.ok(seen.ended);
    assert.ok(lastDc > 0, 'the match outlived the first disconnection');
    assert.equal(seen.ended.result.endReason, 'forfeit');
    // Never before FORFEIT_DC_TICKS of the LAST disconnection.
    assert.ok(seen.ended.result.endTick - lastDc >= FORFEIT_DC_TICKS, `whistled ${seen.ended.result.endTick - lastDc} ticks after the last disconnection`);
    const v = await verify(seen.ended.replay, assign, build, { leaves: [] });
    assert.equal(v.code, 'ok', `${v.code} ${v.message ?? ''}`);
  });
});

// ---- 2. 'left': every human has a takeover -----------------------------------------------------

test("a casual 'left' ending verifies ok when leaves lists the leavers, 'bad_takeover' when one is missing", async () => {
  await withFakeClock(async (clock) => {
    const assign = assignment({ createdAt: clock.t });
    const { room, seen, build } = await makeRoom(assign);
    const ws = [join(room, assign, 0), join(room, assign, 1)];
    for (const w of ws) w.onmessage(READY, false);
    assert.equal(room.host.isStarted, true);
    const live = new Set([0, 1]);
    const [a, b] = [assign.roster[0].playerId, assign.roster[1].playerId];
    drive(room, clock, live, () => room.host.currentTick >= 600);
    const first = room.leave(a);
    assert.equal(first.ended, false);
    live.delete(0);
    drive(room, clock, live, () => room.host.currentTick >= 1300);
    const lastTick = room.host.currentTick;
    const last = room.leave(b);
    assert.equal(last.ended, true, 'the last human left: the match stops');
    assert.ok(seen.ended);
    const res = seen.ended.result;
    assert.equal(res.endReason, 'left');
    assert.equal(res.endTick, lastTick);
    assert.deepEqual(
      seen.ended.stats.slots.map((s) => s.connectedAtEnd),
      [false, false],
      'both left before the end',
    );
    const r = decodeReplay(seen.ended.replay);
    assert.deepEqual(
      r.takeovers.map((t) => t.slot),
      [0, 1],
      'a takeover for each leaver',
    );
    assert.equal(r.takeovers[1].tick, res.endTick + 1, "the last leaver's takeover lands at end + 1");

    const ok = await verify(seen.ended.replay, assign, build, { leaves: [a, b] });
    assert.equal(ok.code, 'ok', `${ok.code} ${ok.message ?? ''}`);
    assert.equal(ok.endReason, 'left');
    assert.deepEqual(ok.leftSlots, [0, 1]);
    for (const leaves of [[a], [b], []]) {
      const bad = await verify(seen.ended.replay, assign, build, { leaves });
      assert.equal(bad.code, 'bad_takeover', `leaves ${JSON.stringify(leaves)}: ${bad.code}`);
    }
  });
});

// ---- 3. 'empty': nobody connected for more than EMPTY_PROOF_TICKS ---------------------------

test("an 'empty' ending verifies ok, also when a stall makes the wall-clock delay pass at once", async () => {
  for (const variant of [
    { name: 'default delay + 20 s stall', timings: {}, stallMs: 20_000 },
    { name: 'no wall delay', timings: { emptyShutdownMs: 0 }, stallMs: 0 },
  ]) {
    await withFakeClock(async (clock) => {
      const assign = assignment({ createdAt: clock.t });
      const { room, seen, build } = await makeRoom(assign, { timings: variant.timings });
      const ws = [join(room, assign, 0), join(room, assign, 1)];
      for (const w of ws) w.onmessage(READY, false);
      const live = new Set([0, 1]);
      drive(room, clock, live, () => room.host.currentTick >= 900);
      const emptyTick = room.host.currentTick;
      live.clear();
      ws[0].onclose(1006, '');
      ws[1].onclose(1006, '');
      assert.equal(room.sockets, 0);
      clock.t += variant.stallMs;
      drive(room, clock, live, () => false);
      assert.ok(seen.ended, variant.name);
      const res = seen.ended.result;
      assert.equal(res.endReason, 'empty', variant.name);
      // The delay counts in ticks too (never fewer than the proof): 15 s = 1800 ticks by default.
      const delayMs = variant.timings.emptyShutdownMs ?? 15_000;
      const minTicks = Math.max(EMPTY_PROOF_TICKS + 1, Math.ceil((delayMs * TICK_RATE) / 1000));
      assert.ok(res.endTick - emptyTick >= minTicks, `${variant.name}: stopped ${res.endTick - emptyTick} ticks after the room emptied (min ${minTicks})`);
      const v = await verify(seen.ended.replay, assign, build, { leaves: [] });
      assert.equal(v.code, 'ok', `${variant.name}: ${v.code} ${v.message ?? ''}`);
      assert.equal(v.endReason, 'empty');
    });
  }
});

test("a stall while a ranked room is empty does not let 'empty' overtake a forfeit that is due first", async () => {
  // Red's socket goes at tick 1200, blue's GAP s of play later. MatchDO (all wall clock) forfeits
  // red at red + 60 s when blue went more than 45 s after red (empty needs 15 s more), else 'empty'.
  for (const c of [
    { gapS: 50, stallMs: 0, want: 'forfeit' },
    { gapS: 50, stallMs: 6_000, want: 'forfeit' }, // the stall used to make it 'empty' (void + a strike)
    { gapS: 46, stallMs: 20_000, want: 'forfeit' },
    { gapS: 40, stallMs: 6_000, want: 'empty' },
  ]) {
    await withFakeClock(async (clock) => {
      const name = `gap ${c.gapS} s, stall ${c.stallMs} ms`;
      const assign = assignment({ ranked: true, createdAt: clock.t });
      const { room, seen, build } = await makeRoom(assign);
      const ws = [join(room, assign, 0), join(room, assign, 1)];
      for (const w of ws) w.onmessage(READY, false);
      const live = new Set([0, 1]);
      let redAt = -1;
      let blueAt = -1;
      let stalled = false;
      drive(room, clock, live, () => false, () => {
        const t = room.host.currentTick;
        if (redAt < 0 && t >= 1200) {
          redAt = t;
          live.delete(1);
          ws[1].onclose(1006, '');
        } else if (redAt >= 0 && blueAt < 0 && t >= redAt + c.gapS * TICK_RATE) {
          blueAt = t;
          live.delete(0);
          ws[0].onclose(1006, '');
        } else if (blueAt >= 0 && !stalled && c.stallMs > 0 && t >= blueAt + 240) {
          stalled = true;
          clock.t += c.stallMs;
        }
      });
      assert.ok(seen.ended, name);
      const res = seen.ended.result;
      assert.equal(res.endReason, c.want, name);
      if (c.want === 'forfeit') {
        assert.equal(res.forfeitTeam, 1, name);
        assert.equal(res.winner, 0, name);
        assert.equal(res.endTick, redAt + FORFEIT_DC_TICKS, name);
      }
      const v = await verify(seen.ended.replay, assign, build, { leaves: [] });
      assert.equal(v.code, 'ok', `${name}: ${v.code} ${v.message ?? ''}`);
      assert.equal(v.endReason, c.want, name);
    });
  }
});

// ---- 4. no ending at tick 0 --------------------------------------------------------------------

test('a match that started but has not ticked yet is cancelled, never ended with a tick-0 replay', async () => {
  // Casual: both humans leave between host.start() and the first advance.
  {
    const assign = assignment();
    const { room, seen } = await makeRoom(assign);
    const ws = [join(room, assign, 0), join(room, assign, 1)];
    for (const w of ws) w.onmessage(READY, false);
    assert.equal(room.host.isStarted, true);
    assert.equal(room.host.currentTick, 0);
    const [a, b] = [assign.roster[0].playerId, assign.roster[1].playerId];
    assert.equal(room.leave(a).ended, false, 'the first leaver becomes a bot');
    assert.equal(room.leave(b).ended, true);
    assert.equal(seen.ended, null, 'no replay');
    assert.deepEqual(seen.cancelled && { reason: seen.cancelled.reason, noShows: seen.cancelled.noShows }, { reason: 'left', noShows: [] });
    assert.equal(seen.closed, 'cancelled');
  }
  // Ranked: a leave before the first tick is a dodge, as before the start.
  {
    const assign = assignment({ ranked: true });
    const { room, seen } = await makeRoom(assign);
    const ws = [join(room, assign, 0), join(room, assign, 1)];
    for (const w of ws) w.onmessage(READY, false);
    assert.equal(room.host.isStarted, true);
    assert.equal(room.host.currentTick, 0);
    const b = assign.roster[1].playerId;
    assert.equal(room.leave(b).ended, true);
    assert.equal(seen.ended, null, 'no replay');
    assert.deepEqual(seen.cancelled && { reason: seen.cancelled.reason, noShows: seen.cancelled.noShows }, { reason: 'dodge', noShows: [b] });
    assert.equal(seen.closed, 'cancelled');
  }
});

test("a casual leave at tick 0 that does not end the match is a takeover at tick 1; the 'left' ending verifies", async () => {
  await withFakeClock(async (clock) => {
    const assign = assignment({ createdAt: clock.t });
    const { room, seen, build } = await makeRoom(assign);
    const ws = [join(room, assign, 0), join(room, assign, 1)];
    for (const w of ws) w.onmessage(READY, false);
    const [a, b] = [assign.roster[0].playerId, assign.roster[1].playerId];
    assert.equal(room.host.currentTick, 0);
    assert.equal(room.leave(a).ended, false);
    const live = new Set([1]);
    drive(room, clock, live, () => room.host.currentTick >= 600);
    assert.equal(room.leave(b).ended, true);
    assert.ok(seen.ended);
    assert.equal(seen.ended.result.endReason, 'left');
    const r = decodeReplay(seen.ended.replay);
    assert.deepEqual(
      r.takeovers.map((t) => [t.tick, t.slot]),
      [
        [1, 0],
        [seen.ended.result.endTick + 1, 1],
      ],
    );
    const v = await verify(seen.ended.replay, assign, build, { leaves: [a, b] });
    assert.equal(v.code, 'ok', `${v.code} ${v.message ?? ''}`);
  });
});

// ---- 5. TTL: the control plane's clock, overtime only ----------------------------------------

test('the TTL is armed by serverNow (the control plane clock), not the local clock', async () => {
  const SKEW = 1_000_000_000;
  const t0 = Date.now();
  // Server clock far ahead of the local one: by Date.now the TTL would be ~11 days away.
  const ahead = () => Date.now() + SKEW;
  const A = assignment({ matchLengthSeconds: 0, createdAt: ahead() });
  const ra = await makeRoom(A, { serverNow: ahead, timings: { ttlAfterMatchMs: 1_500 } });
  // Server clock far behind: by Date.now the TTL would be long overdue (fires at the 1 s floor).
  const behind = () => Date.now() - SKEW;
  const B = assignment({ matchLengthSeconds: 0, createdAt: behind() });
  const rb = await makeRoom(B, { serverNow: behind, timings: { ttlAfterMatchMs: 2_500 } });
  // No serverNow: Date.now, as before.
  const C = assignment({ matchLengthSeconds: 0, createdAt: Date.now() });
  const rc = await makeRoom(C, { timings: { ttlAfterMatchMs: 1_200 } });

  await sleep(1_700);
  assert.equal(rb.seen.cancelled, null, 'B: not yet, by the server clock');
  await waitFor(() => ra.seen.cancelled && rb.seen.cancelled && rc.seen.cancelled, 4_000, 'the three TTLs');
  for (const [name, x, min] of [
    ['A', ra, 1_400],
    ['B', rb, 2_400],
    ['C', rc, 1_100],
  ]) {
    assert.equal(x.seen.cancelled.reason, 'ttl', name);
    assert.equal(x.seen.closed, 'cancelled', name);
    assert.ok(x.seen.cancelled.at - t0 >= min, `${name}: fired after ${x.seen.cancelled.at - t0} ms`);
  }
});

test('a TTL that fires during regulation waits for overtime, then whistles a ttl ending that verifies', async () => {
  // createdAt long ago: the TTL fires at its 1 s floor, while the match is still in regulation.
  const assign = assignment({ matchLengthSeconds: 3, createdAt: Date.now() - 3_600_000 });
  const { room, seen, build } = await makeRoom(assign);
  const ws = [join(room, assign, 0), join(room, assign, 1)];
  for (const w of ws) w.onmessage(READY, false);
  assert.equal(room.host.isStarted, true);
  // Nobody touches anything: 0-0 at 0:00 means overtime. Fast-forward the sim by hand (8 ticks per call).
  let now = performance.now();
  const step = (until) => {
    let guard = 0;
    while (!room.isEnded && !until()) {
      if (++guard > 100_000) throw new Error('step: runaway');
      now += TICK_MS * 8;
      room.advance(now);
    }
  };
  step(() => room.host.currentTick >= 240); // countdown + 1 s of regulation
  assert.equal(room.host.match.overtime, false);
  await sleep(1_500); // the TTL fired (1 s) in regulation and must have re-armed instead of whistling
  assert.equal(seen.ended, null, 'no ttl whistle in regulation');
  assert.equal(room.isEnded, false);
  step(() => room.host.match.overtime);
  assert.equal(room.host.match.overtime, true, 'tied at 0:00: overtime');
  await waitFor(() => seen.ended, 2_500, 'the ttl whistle in overtime');
  const res = seen.ended.result;
  assert.equal(res.endReason, 'ttl');
  assert.equal(res.winner, -1);
  const v = await verify(seen.ended.replay, assign, build, { leaves: [] });
  assert.equal(v.code, 'ok', `${v.code} ${v.message ?? ''}`);
  assert.equal(v.endReason, 'ttl');
});
