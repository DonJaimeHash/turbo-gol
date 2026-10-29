// Security limits of the server-authoritative match (server/src/MatchDO.ts): a casual match whose
// every human is idle ends, and a match nobody joined is dropped sooner (audit rt-3, cost-6). The
// harness is match.test.mjs's: FakeSim arena through the resolve hook, fake sockets and storage,
// no workerd, no wasm. Run from server/: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const DO_STUB = 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }';
const WASM_STUB = 'data:text/javascript,export const createHostArena = (roster, seed) => globalThis.__createHostArena(roster, seed);';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:workers') return { url: DO_STUB, shortCircuit: true };
    if (specifier === './wasm' && context.parentURL !== undefined && context.parentURL.endsWith('/server/src/MatchDO.ts')) return { url: WASM_STUB, shortCircuit: true };
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

// The DO's start timer (5 s) and tick loop must never keep the test process alive.
const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;
globalThis.setTimeout = (fn, ms, ...args) => {
  const t = realSetTimeout(fn, ms, ...args);
  t.unref?.();
  return t;
};
globalThis.setInterval = (fn, ms, ...args) => {
  const t = realSetInterval(fn, ms, ...args);
  t.unref?.();
  return t;
};

const T = await import('../../src/sim/types.ts');
const P = await import('../../src/net/protocol.ts');
const { MatchDO } = await import('../src/MatchDO.ts');
const { INTERNAL_HEADER, internalSecret } = await import('../src/auth.ts');

const SECRET = 'match-limits-test-secret';
const MATCH_ID = 'ab'.repeat(32);

/** Minimal HostSim (the one of roomHost.test.mjs): a state buffer, a tick counter, a toy save format. */
class FakeSim {
  constructor(teams) {
    this.buf = new Float32Array(T.STATE_BUFFER_FLOATS);
    this.buf[T.H_NUM_CARS] = teams.length;
    for (let s = 0; s < teams.length; s++) {
      const o = T.CARS_OFFSET + s * T.CAR_STRIDE;
      this.buf[o + T.C_ID] = s + 1;
      this.buf[o + T.C_TEAM] = teams[s];
      this.buf[o + T.C_POS + 1] = teams[s] === 0 ? -3000 : 3000;
      this.buf[o + T.C_ROT + 2] = 1;
      this.buf[o + T.C_IS_ON_GROUND] = 1;
      this.buf[o + T.C_BOOST] = 33;
    }
    this.buf[T.BALL_OFFSET + T.B_POS + 2] = 93;
    this.ballPred = new Float32Array(T.BALL_PRED_TICKS * T.BALL_PRED_STRIDE);
    this.predTick = 0;
    this.events = {};
    this.lastPacked = new Int8Array(T.MAX_CARS * T.PACKED_INPUT_BYTES);
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
    this.predTick = this.tickCount;
  }
  setControlsPacked(packed, n) {
    this.lastPacked.fill(0);
    this.lastPacked.set(packed.subarray(0, n * T.PACKED_INPUT_BYTES));
  }
  step(n) {
    this.buf[T.H_TICK_COUNT] += n;
  }
  sync() {}
  resetKickoff() {}
  saveState(out) {
    new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(0, this.tickCount, true);
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

/** The sims the stubbed createHostArena handed out (one per MatchDO host). */
const sims = [];
globalThis.__createHostArena = async (roster) => {
  const sim = new FakeSim(roster.map((e) => e.team));
  sims.push(sim);
  return { sim, carIds: roster.map((_, i) => i + 1) };
};

/** The server end of a WebSocketPair with the standard (non-hibernating) API the MatchDO uses. */
class FakeWs {
  constructor() {
    this.readyState = 1;
    this.binaryType = 'blob';
    this.sent = [];
    this.closed = null;
    this.listeners = new Map();
  }
  accept() {}
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  send(bytes) {
    if (this.readyState !== 1) throw new Error('send on a closed socket');
    this.sent.push(Uint8Array.from(bytes));
  }
  close(code, reason) {
    if (this.readyState === 3) throw new Error('already closed');
    this.readyState = 3;
    this.closed = { code, reason };
  }
  /** A frame from the client. */
  deliver(bytes) {
    const copy = Uint8Array.from(bytes);
    for (const fn of this.listeners.get('message') ?? []) fn({ data: copy.buffer });
  }
  /** JSON messages of `type` sent to this socket. */
  json(type) {
    return this.sent.filter((b) => b[0] === type).map((b) => P.decodeJson(b));
  }
}

globalThis.WebSocketPair = class WebSocketPair {
  constructor() {
    this[0] = new FakeWs();
    this[1] = new FakeWs();
  }
};
const RealResponse = globalThis.Response;
globalThis.Response = class Response extends RealResponse {
  constructor(body, init) {
    if (init && init.status === 101) {
      super(body, { ...init, status: 200 });
      this.upgraded = true;
    } else super(body, init);
  }
};

class FakeStorage {
  constructor() {
    this.map = new Map();
    this.alarm = null;
  }
  async get(k) {
    return this.map.get(k);
  }
  async put(k, v) {
    this.map.set(k, structuredClone(v));
  }
  async delete(k) {
    return this.map.delete(k);
  }
  async deleteAll() {
    this.map.clear();
  }
  async setAlarm(t) {
    this.alarm = t;
  }
  async deleteAlarm() {
    this.alarm = null;
  }
}

const random32 = () => Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

/** A created MatchDO for `roster` with helpers: internal calls, upgrades, the matchmaker's /release calls. */
async function makeMatch(roster, extra = {}) {
  const storage = new FakeStorage();
  await storage.put('hostColo', 'TST'); // no colo trace (network) in the tests
  const waits = [];
  const ctx = { storage, blockConcurrencyWhile: (fn) => fn(), waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => undefined)) };
  const releases = [];
  const env = {
    JWT_SECRET: SECRET,
    MATCHMAKER: {
      idFromName: (n) => n,
      get: () => ({
        fetch: async (url, init) => {
          releases.push({ url, body: JSON.parse(init.body) });
          return new RealResponse('{"ok":true}');
        },
      }),
    },
  };
  const mdo = new MatchDO(ctx, env);
  const secret = await internalSecret(SECRET);
  const internal = async (path, body) => {
    const res = await mdo.fetch(
      new Request('https://match' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { [INTERNAL_HEADER]: secret, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    return { status: res.status, json: await res.json() };
  };
  const created = await internal('/internal/create', { matchId: MATCH_ID, mode: '1v1', region: 'test', roster, matchLengthSeconds: 300, createdAt: Date.now(), ...extra });
  assert.equal(created.status, 200, `create: ${JSON.stringify(created.json)}`);
  /** The Worker's forwarded upgrade for `slot` (a fresh ticket id): the raw Response. */
  const upgrade = (slot) => {
    const e = roster[slot];
    return mdo.fetch(
      new Request('https://match/ws/' + MATCH_ID, {
        headers: { Upgrade: 'websocket', [INTERNAL_HEADER]: secret, 'x-player-id': e.playerId, 'x-slot': String(slot), 'x-team': String(e.team), 'x-jti': random32(), 'x-name': e.name },
      }),
    );
  };
  /** Upgrade `slot` and return the server-side socket the MatchDO keeps for it. */
  const join = async (slot) => {
    const r = await upgrade(slot);
    assert.equal(r.upgraded, true, `upgrade of slot ${slot}: ${r.status} ${await r.text()}`);
    const ws = mdo.clients[slot].ws;
    assert.equal(ws.json(P.MsgType.Welcome).length, 1, 'Welcome sent');
    return ws;
  };
  const shutdown = async () => {
    await mdo.shutdown('test');
    await Promise.all(waits);
  };
  return { mdo, storage, internal, upgrade, join, releases, shutdown, sim: () => sims.at(-1) };
}

const A = { slot: 0, team: 0, kind: 'player', name: 'A', playerId: 'pa' };
const B = { slot: 1, team: 1, kind: 'player', name: 'B', playerId: 'pb' };
const BOT = { slot: 1, team: 1, kind: 'bot', name: 'Bot 1' };

/** An input packet of `count` ticks from `firstTick`: neutral (all controls 0) or with the throttle down. */
function input(firstTick, active) {
  const packed = new Int8Array(T.PACKED_INPUT_BYTES);
  if (active) packed[0] = 127;
  const out = new Uint8Array(P.INPUT_HEADER + T.PACKED_INPUT_BYTES);
  const n = P.encodeInput(out, firstTick, 1, 0, packed, 0);
  return out.subarray(0, n);
}

/** Run the host loop for `ms` of wall time (Date.now moved by hand, 250 ms per interval callback). */
function run(h, clock, ms, each) {
  for (let t = 0; t < ms && !h.mdo.shutDown && !h.mdo.ended; t += 250) {
    clock.now += 250;
    if (each) each(t);
    h.mdo.onInterval();
  }
}

async function withClock(fn) {
  const realNow = Date.now;
  const clock = { now: realNow() };
  Date.now = () => clock.now;
  try {
    return await fn(clock);
  } finally {
    Date.now = realNow;
  }
}

test('MatchDO: a casual bot match whose human sends only neutral inputs ends after IDLE_END_MS: the whistle, then shutdown and the release', async () => {
  await withClock(async (clock) => {
    const h = await makeMatch([A, BOT]);
    try {
      const ws = await h.join(0);
      ws.deliver(P.encodeJson(P.MsgType.Ready, {}));
      assert.equal(h.mdo.host.isStarted, true);
      let tick = 1;
      run(h, clock, 30_000, () => ws.deliver(input(tick++, false)));
      assert.equal(h.mdo.ended, false, 'half the idle window: still playing');
      run(h, clock, 31_000, () => ws.deliver(input(tick++, false)));
      assert.equal(h.mdo.ended, true, 'idle for 60 s: the whistle');
      const ended = ws.json(P.MsgType.Event).filter((e) => e.type === 'ended');
      assert.equal(ended.length, 1, "the client gets the usual 'ended'");
      await new Promise((r) => setTimeout(r, 2_100)); // END_LINGER_MS
      assert.equal(h.mdo.shutDown, true);
      assert.ok(h.releases.some((r) => r.body.matchId === MATCH_ID), 'locks and capacity released');
    } finally {
      await h.shutdown();
    }
  });
});

test('MatchDO: a socket open with no input at all ends the same way; a human who plays (any control) keeps the match going for minutes', async () => {
  await withClock(async (clock) => {
    const idle = await makeMatch([A, BOT]);
    try {
      const ws = await idle.join(0);
      ws.deliver(P.encodeJson(P.MsgType.Ready, {}));
      run(idle, clock, 61_000);
      assert.equal(idle.mdo.ended, true, 'no packets for 60 s');
    } finally {
      await idle.shutdown();
    }
    const h = await makeMatch([A, B]);
    try {
      const wsA = await h.join(0);
      const wsB = await h.join(1);
      wsA.deliver(P.encodeJson(P.MsgType.Ready, {}));
      wsB.deliver(P.encodeJson(P.MsgType.Ready, {}));
      let tick = 1;
      // A plays now and then (a touch every 20 s); B is AFK the whole time: the match goes on.
      run(h, clock, 4 * 60_000, (t) => {
        wsA.deliver(input(tick, t % 20_000 === 0));
        wsB.deliver(input(tick, false));
        tick++;
      });
      assert.equal(h.mdo.ended, false, 'one human playing is enough');
    } finally {
      await h.shutdown();
    }
  });
});

test('MatchDO: a reconnect gets RECONNECT_GRACE_MS of the idle window back; ranked matches are never ended for idleness', async () => {
  await withClock(async (clock) => {
    const h = await makeMatch([A, BOT]);
    try {
      let ws = await h.join(0);
      ws.deliver(P.encodeJson(P.MsgType.Ready, {}));
      run(h, clock, 50_000);
      for (const fn of ws.listeners.get('close') ?? []) fn({}); // a drop, then the rejoin
      ws = await h.join(0);
      run(h, clock, 15_000);
      assert.equal(h.mdo.ended, false, 'the reconnect bought time');
      run(h, clock, 6_000);
      assert.equal(h.mdo.ended, true, 'but not a fresh window');
    } finally {
      await h.shutdown();
    }
    const ranked = await makeMatch([A, B], { ranked: true });
    try {
      const wsA = await ranked.join(0);
      const wsB = await ranked.join(1);
      wsA.deliver(P.encodeJson(P.MsgType.Ready, {}));
      wsB.deliver(P.encodeJson(P.MsgType.Ready, {}));
      run(ranked, clock, 90_000);
      assert.equal(ranked.mdo.ended, false, 'ranked: its own forfeit rules, no idle end');
    } finally {
      await ranked.shutdown();
    }
  });
});

test('MatchDO: a match nobody joined is dropped 45 s after the create (UNUSED_ALARM_MS), not 90 s', async () => {
  const before = Date.now();
  const h = await makeMatch([A, BOT]);
  try {
    assert.ok(h.storage.alarm !== null && h.storage.alarm - before <= 45_000 + 1_000, `the unused alarm is due in ${h.storage.alarm - before} ms`);
  } finally {
    await h.shutdown();
  }
});
