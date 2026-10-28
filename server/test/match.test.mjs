// Unit tests for server/src/MatchDO.ts on fakes: the explicit leave of a server match (POST
// /internal/leave from the matchmaker): the slot's socket is closed, the slot is flagged left (no
// rejoin, no new socket), the host's bots drive the car, the others are told, and the last human's
// leave ends the match at once (connected or not: locks and capacity released); plus the Worker's /api/rejoin and /api/leave
// around it (server/src/index.ts). No workerd and no wasm: 'cloudflare:workers'
// is stubbed and MatchDO's './wasm' (createHostArena) is replaced by a FakeSim arena through the
// resolve hook (server/test/smoke.mjs drives the real object against wrangler dev). Run from server/:
//   npm test        (= node --test "test/*.test.mjs")
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

const SECRET = 'match-test-secret';
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
async function makeMatch(roster) {
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
  const created = await internal('/internal/create', { matchId: MATCH_ID, mode: '1v1', region: 'test', roster, matchLengthSeconds: 300, createdAt: Date.now() });
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

test('MatchDO /internal/leave: socket closed 1000 left, slot flagged (rejoin + upgrade 410 left, persisted, status), bots drive the car, the others get botTakeover; idempotent', async () => {
  const h = await makeMatch([A, B]);
  try {
    const wsA = await h.join(0);
    const wsB = await h.join(1);
    // B is ready, A is not: no start yet.
    wsB.deliver(P.encodeJson(P.MsgType.Ready, {}));
    assert.equal(h.mdo.host.isStarted, false, 'A has not sent Ready');

    const r = await h.internal('/internal/leave', { playerId: 'pa' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, slot: 0, closed: true, already: false, ended: false }, 'B still plays: the match goes on');
    assert.deepEqual(wsA.closed, { code: 1000, reason: 'left' }, 'the slot socket is closed with 1000: the client never rejoins it');
    assert.equal(h.mdo.clients[0], null);
    const take = wsB.json(P.MsgType.Event).filter((e) => e.type === 'botTakeover');
    assert.equal(take.length, 1, 'the others are told');
    assert.equal(take[0].slot, 0);
    assert.ok(take[0].tick >= 1);
    assert.equal(wsA.json(P.MsgType.Event).filter((e) => e.type === 'botTakeover').length, 0, 'not to the leaver');
    assert.equal(h.mdo.host.isHumanSlot(0), false, 'slot 0 is a bot of the host now');
    assert.equal(h.mdo.host.isStarted, true, 'the left slot no longer blocks the start: B was ready');
    assert.deepEqual(await h.storage.get('left'), [0], 'persisted');

    // No way back in for A; B is untouched.
    let rj = await h.internal('/internal/rejoin', { playerId: 'pa' });
    assert.equal(rj.status, 410);
    assert.equal(rj.json.error, 'left');
    rj = await h.internal('/internal/rejoin', { playerId: 'pb' });
    assert.equal(rj.status, 200);
    assert.equal(rj.json.slot, 1);
    const up = await h.upgrade(0);
    assert.equal(up.status, 410, 'a ticket minted before the leave cannot open a socket');
    assert.equal((await up.json()).error, 'left');
    const st = await h.internal('/internal/status');
    assert.deepEqual(st.json.left, [0]);
    assert.equal(st.json.liveSockets, 1);

    // A rejoining B sees slot 0 as a bot in its Welcome.
    const wsB2 = await h.join(1);
    assert.deepEqual(wsB.closed, { code: 4000, reason: 'replaced' });
    const welcome = wsB2.json(P.MsgType.Welcome)[0];
    assert.equal(welcome.roster[0].kind, 'bot');
    assert.equal(welcome.roster[1].kind, 'player');

    // Idempotent; a stranger is not in the match.
    const again = await h.internal('/internal/leave', { playerId: 'pa' });
    assert.deepEqual(again.json, { ok: true, slot: 0, closed: false, already: true, ended: false });
    assert.equal(wsB2.json(P.MsgType.Event).filter((e) => e.type === 'botTakeover').length, 0, 'no second announcement');
    assert.equal((await h.internal('/internal/leave', { playerId: 'px' })).status, 404);
    assert.equal((await h.internal('/internal/leave', {})).status, 400);

    // The car keeps moving: past the countdown the host's bot writes slot 0's controls.
    const host = h.mdo.host;
    const sim = h.sim();
    let driven = 0;
    for (let i = 0; i < 480; i++) {
      host.tick();
      if (!host.frozen) for (let k = 0; k < 6; k++) if (sim.lastPacked[k] !== 0) driven++;
    }
    assert.ok(driven > 0, 'bot controls on slot 0');
    assert.equal(host.addInputs(0, host.currentTick + 1, 1, new Int8Array([127, 0, 0, 0, 0, 0])), 0, 'inputs for slot 0 are refused');
  } finally {
    await h.shutdown();
  }
});

test('MatchDO: a leave before the host exists is applied when it is built; after the whistle it answers 410', async () => {
  const h = await makeMatch([A, B]);
  try {
    // Simulate a leave that lands while the arena is being (re)built: drop the host, leave, rebuild.
    h.mdo.host = null;
    h.mdo.hostPromise = null;
    const r = await h.internal('/internal/leave', { playerId: 'pb' });
    assert.deepEqual(r.json, { ok: true, slot: 1, closed: false, already: false, ended: false });
    const host = await h.mdo.ensureHost();
    assert.equal(host.isHumanSlot(1), false, 'ensureHost applies the left slots');
    assert.equal(host.isHumanSlot(0), true);
    h.mdo.ended = true;
    const late = await h.internal('/internal/leave', { playerId: 'pa' });
    assert.equal(late.status, 410);
    assert.equal(late.json.error, 'match_over');
  } finally {
    await h.shutdown();
  }
});

test('MatchDO: the last human leaving ends the match at once (socket closed, locks + capacity released, rejoin / status 404)', async () => {
  const h = await makeMatch([A, BOT]);
  try {
    const wsA = await h.join(0);
    wsA.deliver(P.encodeJson(P.MsgType.Ready, {}));
    assert.equal(h.mdo.host.isStarted, true, 'the loop runs');
    const r = await h.internal('/internal/leave', { playerId: 'pa' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, slot: 0, closed: true, already: false, ended: true });
    assert.deepEqual(wsA.closed, { code: 1000, reason: 'left' });
    assert.equal(h.mdo.shutDown, true, 'shut down before the answer: no 15 s empty-room grace');
    assert.equal(h.mdo.interval, null, 'the tick loop is stopped');
    await new Promise((res) => realSetTimeout(res, 0)); // the release runs in waitUntil
    const rel = h.releases.filter((x) => x.url === 'https://matchmaker/release');
    assert.equal(rel.length, 1);
    assert.deepEqual(rel[0].body, { matchId: MATCH_ID, playerIds: ['pa'] }, 'scoped to this match; closeRoom defaults to true (capacity)');
    assert.equal(h.storage.map.size, 0, 'storage wiped');
    assert.equal(h.storage.alarm, null);
    const rj = await h.internal('/internal/rejoin', { playerId: 'pa' });
    assert.equal(rj.status, 404, 'the match is gone');
    assert.equal((await h.internal('/internal/status')).status, 404);
    assert.equal((await h.internal('/internal/leave', { playerId: 'pa' })).status, 404, 'a repeated leave finds no match');
    assert.equal(h.releases.length, 1, 'one release only');
  } finally {
    await h.shutdown();
  }
});

test('MatchDO: the last human leaving before any socket ends the match at once (no 90 s unused alarm); one of two humans does not', async () => {
  let h = await makeMatch([A, BOT]);
  try {
    assert.equal(h.mdo.liveSockets, 0);
    assert.equal(h.mdo.host.isStarted, false, 'the loop never ran: no empty-room check would fire');
    const r = await h.internal('/internal/leave', { playerId: 'pa' });
    assert.deepEqual(r.json, { ok: true, slot: 0, closed: false, already: false, ended: true });
    assert.equal(h.mdo.shutDown, true);
    const st = await h.internal('/internal/status');
    assert.equal(st.status, 404, `status after the quit: ${JSON.stringify(st.json)}`);
    assert.equal(st.json.error, 'no_match');
    await new Promise((res) => realSetTimeout(res, 0));
    assert.deepEqual(
      h.releases.map((x) => [x.url, x.body]),
      [['https://matchmaker/release', { matchId: MATCH_ID, playerIds: ['pa'] }]],
      'the matchmaker forgets the room right away',
    );
    assert.equal(h.storage.alarm, null, "the 'unused' alarm is gone");
    assert.equal((await h.internal('/internal/rejoin', { playerId: 'pa' })).status, 404);
  } finally {
    await h.shutdown();
  }

  h = await makeMatch([A, B]);
  try {
    let r = await h.internal('/internal/leave', { playerId: 'pa' });
    assert.deepEqual(r.json, { ok: true, slot: 0, closed: false, already: false, ended: false }, 'B (not connected yet) still holds the match');
    assert.equal(h.mdo.shutDown, false);
    assert.equal((await h.internal('/internal/status')).status, 200);
    assert.deepEqual(await h.storage.get('left'), [0]);
    assert.equal(h.releases.length, 0);
    r = await h.internal('/internal/leave', { playerId: 'pb' });
    assert.deepEqual(r.json, { ok: true, slot: 1, closed: false, already: false, ended: true });
    assert.equal(h.mdo.shutDown, true);
    assert.equal((await h.internal('/internal/status')).status, 404);
    await new Promise((res) => realSetTimeout(res, 0));
    assert.deepEqual(h.releases.map((x) => x.body), [{ matchId: MATCH_ID, playerIds: ['pa', 'pb'] }]);
  } finally {
    await h.shutdown();
  }
});

test('MatchDO: a dropped socket (no leave) keeps the match for a rejoin; the empty-room check ends it after 15 s', async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  const h = await makeMatch([A, BOT]);
  try {
    const wsA = await h.join(0);
    wsA.deliver(P.encodeJson(P.MsgType.Ready, {}));
    // A network drop: the socket closes, no /internal/leave. The match waits for a rejoin.
    for (const fn of wsA.listeners.get('close') ?? []) fn({});
    assert.equal(h.mdo.liveSockets, 0);
    h.mdo.onInterval();
    assert.equal(h.mdo.shutDown, false, 'a reload rejoins within the grace');
    assert.equal((await h.internal('/internal/rejoin', { playerId: 'pa' })).status, 200);
    now += 15_000;
    h.mdo.onInterval();
    assert.equal(h.mdo.shutDown, true, 'no socket for 15 s: shut down');
  } finally {
    Date.now = realNow;
    await h.shutdown();
  }
});

// ---- Worker routes around the explicit leave (server/src/index.ts) ---------------------------------

const worker = (await import('../src/index.ts')).default;
const { createSession } = await import('../src/auth.ts');

/** A Worker env whose MatchDO answers /internal/rejoin with `rejoin` and whose matchmaker records every call. */
function workerEnv(rejoin) {
  const mmCalls = [];
  const env = {
    JWT_SECRET: SECRET,
    REGION_OVERRIDE: 'test',
    FLAGS: { get: async () => null },
    MATCH: {
      idFromString: (s) => s,
      get: () => ({ fetch: async () => new RealResponse(JSON.stringify(rejoin.body), { status: rejoin.status, headers: { 'content-type': 'application/json' } }) }),
    },
    ROOM: {
      idFromString: () => {
        throw new Error('not a room id');
      },
    },
    MATCHMAKER: {
      idFromName: (n) => n,
      get: () => ({
        fetch: async (url, init) => {
          mmCalls.push({ path: new URL(url).pathname, body: JSON.parse(init.body) });
          return new RealResponse('{"ok":true,"left":false,"released":true}', { headers: { 'content-type': 'application/json' } });
        },
      }),
    },
  };
  return { env, mmCalls };
}

async function post(env, path, body, token) {
  const res = await worker.fetch(
    new Request('http://127.0.0.1:8787' + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify(body) }),
    env,
  );
  return { status: res.status, json: await res.json() };
}

test("Worker /api/rejoin: 410 'left' passes through WITHOUT a matchmaker release (the match still runs: its capacity entry stays); 410 match_over / 404 still release", async () => {
  const { token } = await createSession(SECRET, '0123456789abcdef', 'Tester');
  const left = workerEnv({ status: 410, body: { error: 'left', message: 'you left this match' } });
  let r = await post(left.env, '/api/rejoin', { matchId: MATCH_ID }, token);
  assert.equal(r.status, 410);
  assert.equal(r.json.error, 'left', 'the code reaches the client');
  assert.deepEqual(left.mmCalls, [], 'no /release for a match the player quit');
  const over = workerEnv({ status: 410, body: { error: 'match_over' } });
  r = await post(over.env, '/api/rejoin', { matchId: MATCH_ID }, token);
  assert.equal(r.status, 410);
  assert.deepEqual(over.mmCalls, [{ path: '/release', body: { matchId: MATCH_ID, playerIds: ['0123456789abcdef'] } }]);
  const gone = workerEnv({ status: 404, body: { error: 'no_match' } });
  r = await post(gone.env, '/api/rejoin', { matchId: MATCH_ID }, token);
  assert.equal(r.status, 404);
  assert.equal(gone.mmCalls.length, 1);
});

test('Worker /api/leave forwards { playerId, matchId } to the matchmaker (matchId only when it is a 64-hex id)', async () => {
  const { token } = await createSession(SECRET, 'fedcba9876543210', 'Tester');
  const h = workerEnv({ status: 200, body: {} });
  let r = await post(h.env, '/api/leave', { matchId: MATCH_ID }, token);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, left: false, released: true });
  r = await post(h.env, '/api/leave', { matchId: 'not-an-id' }, token);
  r = await post(h.env, '/api/leave', {}, token);
  assert.deepEqual(
    h.mmCalls.map((c) => c.body),
    [{ playerId: 'fedcba9876543210', matchId: MATCH_ID }, { playerId: 'fedcba9876543210' }, { playerId: 'fedcba9876543210' }],
  );
  assert.ok(h.mmCalls.every((c) => c.path === '/leave'));
});

test("Worker /api/config hands the client the server queue's bot fill (MatchmakerDO BOT_FILL_MS: the menus' bots countdown)", async () => {
  const { BOT_FILL_MS } = await import('../src/MatchmakerDO.ts');
  const { env } = workerEnv({ status: 200, body: {} });
  const res = await worker.fetch(new Request('http://127.0.0.1:8787/api/config'), env);
  assert.equal(res.status, 200);
  const cfg = await res.json();
  assert.equal(cfg.botFillMs, BOT_FILL_MS);
  assert.equal(cfg.botFillMs, 10_000, 'the constant the server queue fills with');
});
