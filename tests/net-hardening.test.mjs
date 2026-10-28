// Hardening regressions for the client netcode (review of the phase 1 online mode):
//   node --test tests/net-hardening.test.mjs
// - NetClient.queue(): a persistent 401 re-registers the guest once, then fails (no endless loop)
// - NetClient: close code 4000 'replaced' is final (no /api/rejoin), error codes surface in messages
// - OnlineSession: at most ONE input packet per advance() once >= 2 ticks were stepped (a slow frame
//   sends one fat packet instead of a burst), and a hard resync while ahead is counted once per stall
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

const P = await import('../src/net/protocol.ts');
const T = await import('../src/sim/types.ts');
const { NetClient, NetError, CLOSE_REPLACED } = await import('../src/net/NetClient.ts');
const { OnlineSession, HARD_RESYNC_TICKS } = await import('../src/game/OnlineSession.ts');
const { TICK_MS } = await import('../src/net/ClockSync.ts');
const { seatCars } = await import('../src/net/cosmetics.ts');

const { MsgType, encodeJson, encodeSnapshot, encodePong, decodeInput, fnv1a32 } = P;
const { STATE_BUFFER_FLOATS, H_TICK_COUNT, H_NUM_CARS, CARS_OFFSET, CAR_STRIDE, C_ID, C_TEAM, C_POS, BALL_OFFSET, B_POS, PACKED_INPUT_BYTES, TICK_DT } = T;

// ---- fakes ---------------------------------------------------------------------------------

class FakeStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this.map.delete(k);
  }
}

class FakeSocket {
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.binaryType = 'blob';
    this.readyState = 0;
    this.protocol = '';
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this.sent = [];
    this.closed = null;
  }
  send(data) {
    this.sent.push(data instanceof Uint8Array ? new Uint8Array(data) : data);
  }
  close(code, reason) {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.protocol = 'tg1';
    if (this.onopen) this.onopen({});
  }
  deliver(bytes) {
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    if (this.onmessage) this.onmessage({ data: copy.buffer });
  }
  dropped(code, reason = '') {
    this.readyState = 3;
    if (this.onclose) this.onclose({ code, reason });
  }
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function makeClient(routes, opts = {}) {
  const sockets = [];
  const calls = [];
  let t = 1000;
  const client = new NetClient({
    storage: new FakeStorage(),
    now: () => t,
    fetchFn: async (url, init) => {
      calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
      const r = routes[url];
      if (typeof r === 'function') return r(init, calls.length);
      return r ?? jsonResponse(404, {});
    },
    webSocketFactory: (url, protocols) => {
      const s = new FakeSocket(url, protocols);
      sockets.push(s);
      return s;
    },
    pingIntervalMs: 1e9,
    reconnectDelaysMs: [0], // the reconnection's tries without their waits
    ...opts,
  });
  return { client, sockets, calls, setTime: (v) => (t = v), now: () => t };
}

const GUEST = { playerId: 'p1', name: 'Tester', session: 'jwt-session', expiresAt: Date.now() + 24 * 3600 * 1000 };

/** Tiny RollbackSim: state = tick + car x positions; throttle moves a car along +x. */
class FakeSim {
  constructor(numCars) {
    this.buf = new Float32Array(STATE_BUFFER_FLOATS);
    this.n = numCars;
    this.buf[H_NUM_CARS] = numCars;
    this.controls = new Int8Array(numCars * PACKED_INPUT_BYTES);
    for (let i = 0; i < numCars; i++) {
      const o = CARS_OFFSET + i * CAR_STRIDE;
      this.buf[o + C_ID] = i + 1;
      this.buf[o + C_TEAM] = i % 2;
      this.buf[o + C_POS] = -1000 + i * 500;
    }
    this.buf[BALL_OFFSET + B_POS + 2] = 93;
    this.bytes = 4 + numCars * 4;
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
    for (let i = 0; i < numSlots * PACKED_INPUT_BYTES; i++) this.controls[i] = packed[i];
  }
  step(n = 1) {
    for (let k = 0; k < n; k++) {
      for (let i = 0; i < this.n; i++) {
        const o = CARS_OFFSET + i * CAR_STRIDE;
        this.buf[o + C_POS] = Math.fround(this.buf[o + C_POS] + this.controls[i * PACKED_INPUT_BYTES] / 127);
      }
      this.buf[H_TICK_COUNT] = this.buf[H_TICK_COUNT] + 1;
    }
  }
  sync() {}
  stateSizeMax() {
    return this.bytes;
  }
  saveState(out) {
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    dv.setUint32(0, this.buf[H_TICK_COUNT], true);
    for (let i = 0; i < this.n; i++) dv.setFloat32(4 + i * 4, this.buf[CARS_OFFSET + i * CAR_STRIDE + C_POS], true);
    return this.bytes;
  }
  loadState(blob, len = blob.length) {
    if (len !== this.bytes) return 4;
    const dv = new DataView(blob.buffer, blob.byteOffset, len);
    this.buf[H_TICK_COUNT] = dv.getUint32(0, true);
    for (let i = 0; i < this.n; i++) this.buf[CARS_OFFSET + i * CAR_STRIDE + C_POS] = dv.getFloat32(4 + i * 4, true);
    return 0;
  }
  stateHash() {
    const out = new Uint8Array(this.bytes);
    return fnv1a32(out, this.saveState(out));
  }
}

/**
 * An OnlineSession in the 'playing' state on a fake Game, with the fake socket and clock exposed;
 * `routes` add / override API routes; `connecting: true` stops right after the socket was created;
 * `welcome` adds fields to the Welcome (hostColo 'node:<name>': a community node); `prepare(client)`
 * runs before the queue (an account's sessionProvider).
 */
async function playingSession(routes = {}, { connecting = false, welcome = {}, prepare = null } = {}) {
  const h = makeClient({
    '/api/guest': () => jsonResponse(200, GUEST),
    '/api/queue': () => jsonResponse(200, { status: 'matched', matchId: 'm1', ticket: 'tkt', wsUrl: '/ws/m1' }),
    ...routes,
  });
  const sim = new FakeSim(2);
  const controls = T.emptyControls();
  controls.throttle = 1;
  const game = {
    sim,
    hud: { netVisible: false },
    ticks: 0,
    rosterCalls: [],
    applyOnlineRoster(w, cars) {
      this.rosterCalls.push({ w, cars });
    },
    afterRollback() {},
    startOnlineMatch() {},
    onOnlineEvent() {},
    restoreOfflineRoster() {},
    onOnlineDisconnected() {},
    onlineTick() {
      this.ticks++;
      session.stepTick(controls);
    },
  };
  const session = new OnlineSession(game, { client: h.client, now: h.now });
  if (prepare !== null) prepare(h.client);
  session.quickMatch('1v1');
  for (let i = 0; i < 10 && h.sockets.length === 0; i++) await new Promise((r) => setTimeout(r, 0));
  assert.equal(session.state, 'connecting');
  const ws = h.sockets[0];
  if (connecting) return { session, game, ws, client: h.client, calls: h.calls, setTime: h.setTime, now: h.now };
  ws.open();
  const roster = [
    { carId: 1, slot: 0, team: 0, name: 'Tester', kind: 'player' },
    { carId: 2, slot: 1, team: 1, name: 'Bot 1', kind: 'bot' },
  ];
  ws.deliver(encodeJson(MsgType.Welcome, { protocol: P.PROTOCOL_VERSION, matchId: 'm1', mode: '1v1', tickRate: 120, carId: 1, slot: 0, roster, tick: 0, matchLengthSeconds: 300, ...welcome }));
  assert.ok(session.predictor, 'predictor built from the Welcome');
  // First authoritative state (tick 0): the match is on screen.
  const state = new Uint8Array(sim.stateSizeMax());
  const len = sim.saveState(state);
  const out = new Uint8Array(1024);
  const n = encodeSnapshot(out, 0, 0, 0, 2, new Int8Array(12), state, len, fnv1a32(state, len));
  ws.deliver(out.subarray(0, n));
  assert.equal(session.state, 'playing');
  ws.sent.length = 0;
  return { session, game, ws, client: h.client, calls: h.calls, setTime: h.setTime, now: h.now };
}

const inputPackets = (ws) => ws.sent.filter((f) => f[0] === MsgType.Input);

// ---- NetClient -----------------------------------------------------------------------------

test('queue: a persistent 401 re-registers the guest once and then fails instead of looping', async () => {
  let guests = 0;
  let queues = 0;
  const { client } = makeClient({
    '/api/guest': () => jsonResponse(200, { ...GUEST, playerId: `p${++guests}` }),
    '/api/queue': () => {
      queues++;
      return jsonResponse(401, { error: 'unauthorized' });
    },
  });
  await assert.rejects(client.queue('1v1'), (err) => err instanceof NetError && err.code === 'http' && err.status === 401 && /session rejected/.test(err.message));
  assert.equal(guests, 2, 'one re-registration');
  assert.equal(queues, 2, 'two attempts, then the error');
  assert.equal(client.queueing, false);
});

test('queue / rejoin failures carry the server error code', async () => {
  const { client } = makeClient({
    '/api/guest': () => jsonResponse(200, GUEST),
    '/api/queue': () => jsonResponse(503, { error: 'capacity', message: 'all rooms are busy' }),
  });
  // The server's `message` rides along (the menu shows the real reason); a bare code stays bare.
  await assert.rejects(client.queue('2v2'), (err) => err instanceof NetError && err.status === 503 && err.message === 'queue failed (503 capacity: all rooms are busy)');
  const h2 = makeClient({
    '/api/guest': () => jsonResponse(200, GUEST),
    '/api/rejoin': () => jsonResponse(410, { error: 'match_reset' }),
  });
  await assert.rejects(h2.client.rejoin('abc'), (err) => err instanceof NetError && err.status === 410 && err.message === 'rejoin failed (410 match_reset)');
  // Through the automatic rejoin: the onClose reason is that message (no doubled prefix).
  const closes = [];
  h2.client.onClose = (code, reason, reconnecting) => closes.push([code, reason, reconnecting]);
  h2.client.matchId = 'abc';
  h2.client.connect('/ws/abc', 't');
  h2.sockets[0].open();
  h2.sockets[0].dropped(1006, 'network');
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(closes, [
    [1006, 'network', true],
    [1006, 'rejoin failed (410 match_reset)', false],
  ]);
});

test('close code 4000 (replaced by a newer socket) is final: no rejoin, no new socket', async () => {
  assert.equal(CLOSE_REPLACED, 4000);
  let rejoins = 0;
  const h = makeClient({
    '/api/guest': () => jsonResponse(200, GUEST),
    '/api/rejoin': () => {
      rejoins++;
      return jsonResponse(200, { status: 'matched', matchId: 'm9', ticket: 'T2', wsUrl: '/ws/m9' });
    },
  });
  const closes = [];
  h.client.onClose = (code, reason, reconnecting) => closes.push([code, reason, reconnecting]);
  h.client.matchId = 'm9';
  h.client.connect('/ws/m9', 'T1');
  h.sockets[0].open();
  h.sockets[0].dropped(CLOSE_REPLACED, 'replaced');
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  assert.equal(rejoins, 0);
  assert.equal(h.sockets.length, 1);
  assert.deepEqual(closes, [[4000, 'replaced', false]]);
  assert.equal(h.client.reconnects, 0);
  // An ordinary abnormal close still rejoins once.
  h.client.connect('/ws/m9', 'T1');
  h.sockets[1].open();
  h.sockets[1].dropped(1006, 'network');
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  assert.equal(rejoins, 1);
  assert.equal(h.sockets.length, 3);
});

// ---- OnlineSession -------------------------------------------------------------------------

test('advance() sends at most one input packet per frame, once two or more ticks were stepped', async () => {
  const { session, game, ws } = await playingSession();
  const pkt = { firstTick: 0, count: 0, ackTick: 0, packed: new Int8Array(P.INPUT_MAX_BATCH * PACKED_INPUT_BYTES) };

  // A normal 60 fps frame: two ticks, one packet with those two ticks.
  session.advance(2.5 * TICK_DT);
  assert.equal(game.ticks, 2);
  assert.equal(inputPackets(ws).length, 1);
  assert.ok(decodeInput(inputPackets(ws)[0], pkt));
  assert.equal(pkt.firstTick, 1);
  assert.equal(pkt.count, 2);
  // A frame that steps no tick or a single tick sends nothing; the next tick completes the pair.
  session.advance(0.4 * TICK_DT);
  assert.equal(game.ticks, 2);
  session.advance(0.2 * TICK_DT); // acc 1.1 ticks -> 1 tick
  assert.equal(game.ticks, 3);
  assert.equal(inputPackets(ws).length, 1, 'odd tick waits for the next one');
  session.advance(1 * TICK_DT); // acc 1.1 ticks -> 1 tick
  assert.equal(game.ticks, 4);
  assert.equal(inputPackets(ws).length, 2);
  assert.ok(decodeInput(inputPackets(ws)[1], pkt));
  assert.equal(pkt.firstTick, 1, 'unacked ticks are resent from tick 1');
  assert.equal(pkt.count, 4);
  // A slow frame (0.1 s = the clamp, ~12 ticks): ONE packet, not six, carrying the newest ticks.
  session.advance(0.1);
  assert.ok(game.ticks >= 15, `slow frame stepped ${game.ticks - 4} ticks`);
  assert.equal(inputPackets(ws).length, 3, 'a multi-tick frame emits a single packet');
  assert.ok(decodeInput(inputPackets(ws)[2], pkt));
  assert.equal(pkt.firstTick + pkt.count - 1, session.predictor.localTick, 'the packet ends at the newest local tick');
  assert.ok(pkt.count >= 15 && pkt.count <= 16, `every unacked tick up to the cap (${pkt.count})`);
  // Nothing more goes out while no tick runs.
  session.advance(0);
  assert.equal(inputPackets(ws).length, 3);
});

test('a hard resync while ahead is counted once per stall, not once per frame', async () => {
  const { session, game, ws, now, setTime } = await playingSession();
  // Pong with zero rtt / offset at the client's clock: host tick estimate = (now - 1000) / TICK_MS.
  const pong = new Uint8Array(P.PONG_LEN);
  encodePong(pong, now(), now(), now(), 0);
  ws.deliver(pong);
  assert.equal(session.client.clock.samples, 1);
  assert.equal(session.hardResyncs, 0);
  // Run 12 local ticks while the host clock stands still: local 12 vs target 2 -> 10 ticks ahead.
  session.advance(0.1);
  assert.equal(game.ticks, 12);
  assert.equal(session.hardResyncs, 0, 'the resync is decided at the next frame');
  session.advance(2 * TICK_DT);
  assert.equal(session.hardResyncs, 1);
  assert.ok(session.drift > HARD_RESYNC_TICKS);
  assert.equal(game.ticks, 12, 'stalled: no local tick');
  // The stall lasts several frames (the host has to catch up): still ONE resync.
  for (let i = 0; i < 5; i++) session.advance(2 * TICK_DT);
  assert.equal(session.hardResyncs, 1, 'not inflated per frame');
  assert.equal(game.ticks, 12);
  // The host catches up (12 ticks later on the clock): the remaining stall drains without a new count.
  setTime(now() + 12 * TICK_MS);
  for (let i = 0; i < 3; i++) session.advance(2 * TICK_DT);
  assert.equal(session.hardResyncs, 1, 'draining the stall is not a new resync');
  assert.equal(game.ticks, 12);
  assert.ok(session.drift <= HARD_RESYNC_TICKS);
  // Local ticks run again; with the host clock frozen the sim gets ahead once more: a second event.
  let frames = 0;
  while (session.hardResyncs === 1 && frames < 40) {
    session.advance(2 * TICK_DT);
    frames++;
  }
  assert.equal(session.hardResyncs, 2, `a new stall counts again (after ${frames} frames)`);
  assert.ok(game.ticks > 12, 'the sim ticked between the two stalls');
});

// ---- OnlineSession: explicit quit vs lost connection -----------------------------------------

/** A /api/leave route that records each body and whether the match socket was still open when it went out. */
function leaveRecorder() {
  const rec = { seen: [], ws: null };
  rec.route = (init) => {
    rec.seen.push({ body: JSON.parse(init.body), auth: init.headers.authorization, socketClosed: rec.ws !== null && rec.ws.closed !== null });
    return jsonResponse(200, { ok: true, left: false, released: true });
  };
  return rec;
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

test('OnlineSession.leave (quit from the menu) POSTs /api/leave { matchId } with the session before closing the socket 1000, once', async () => {
  const rec = leaveRecorder();
  const s = await playingSession({ '/api/leave': rec.route });
  rec.ws = s.ws;
  s.session.leave();
  assert.equal(s.session.state, 'idle');
  assert.deepEqual(rec.seen, [{ body: { matchId: 'm1' }, auth: 'Bearer jwt-session', socketClosed: false }], 'the leave goes out before the close');
  assert.deepEqual(s.ws.closed, { code: 1000, reason: 'leave' });
  assert.equal(s.client.leaves, 1);
  // Leaving again (idle) sends nothing more.
  s.session.leave();
  await flush();
  assert.equal(rec.seen.length, 1);
});

test('OnlineSession: no /api/leave after the connection was lost for good (the rejoin path keeps the lock) nor after the whistle', async () => {
  // Lost: the socket drops, the automatic rejoins fail (RECONNECT_TRIES), the Game shows the menu (-> leave()).
  const rec = leaveRecorder();
  let disconnected = null;
  const s = await playingSession({ '/api/leave': rec.route, '/api/rejoin': () => jsonResponse(503, { error: 'unavailable' }) });
  s.game.onOnlineDisconnected = (msg) => (disconnected = msg);
  s.ws.dropped(1006, 'network');
  for (let i = 0; i < 20 && disconnected === null; i++) await flush();
  assert.ok(disconnected !== null, 'the session reported the lost connection');
  s.session.leave();
  await flush();
  assert.deepEqual(rec.seen, [], 'a lost connection is not a quit: the server lock stays for the next queue');

  // The whistle: the match frees the locks itself.
  const rec2 = leaveRecorder();
  const s2 = await playingSession({ '/api/leave': rec2.route });
  s2.ws.deliver(encodeJson(MsgType.Event, { type: 'ended', winner: 0, blue: 1, red: 0, tick: 500 }));
  assert.equal(s2.session.state, 'ended');
  s2.session.leave();
  await flush();
  assert.deepEqual(rec2.seen, []);
  assert.deepEqual(s2.ws.closed, { code: 1000, reason: 'leave' });
});

test('OnlineSession.cancel while connecting quits the assigned match (/api/leave { matchId }, connected: false before the Welcome); cancel while queueing only drops the waiter ({})', async () => {
  const rec = leaveRecorder();
  const s = await playingSession({ '/api/leave': rec.route }, { connecting: true });
  rec.ws = s.ws;
  s.session.cancel();
  assert.equal(s.session.state, 'idle');
  assert.deepEqual(rec.seen, [{ body: { matchId: 'm1', connected: false }, auth: 'Bearer jwt-session', socketClosed: false }]);
  assert.deepEqual(s.ws.closed, { code: 1000, reason: 'cancel' });

  // The Welcome came (the slot is ours on the host), the first snapshot not yet: a plain quit.
  const rec2 = leaveRecorder();
  const s2 = await playingSession({ '/api/leave': rec2.route }, { connecting: true });
  s2.ws.open();
  s2.ws.deliver(encodeJson(MsgType.Welcome, { protocol: P.PROTOCOL_VERSION, matchId: 'm1', mode: '1v1', tickRate: 120, carId: 1, slot: 0, roster: [{ carId: 1, slot: 0, team: 0, name: 'Tester', kind: 'player' }, { carId: 2, slot: 1, team: 1, name: 'Bot 1', kind: 'bot' }], tick: 0, matchLengthSeconds: 300 }));
  assert.equal(s2.session.state, 'connecting');
  s2.session.cancel();
  assert.deepEqual(rec2.seen.map((r) => r.body), [{ matchId: 'm1' }]);

  // Still in the queue (the long-poll is pending): no match to quit, the waiter is dropped with {}.
  const bodies = [];
  const h = makeClient({
    '/api/guest': () => jsonResponse(200, GUEST),
    '/api/queue': (init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))),
    '/api/leave': (init) => {
      bodies.push(JSON.parse(init.body));
      return jsonResponse(200, { ok: true, left: true, released: false });
    },
  });
  const game = { sim: new FakeSim(2), hud: { netVisible: false }, restoreOfflineRoster() {}, onOnlineDisconnected() {} };
  const session = new OnlineSession(game, { client: h.client, now: h.now });
  session.quickMatch('1v1');
  await flush();
  assert.equal(session.state, 'queue');
  session.cancel();
  await flush();
  assert.equal(session.state, 'idle');
  assert.deepEqual(bodies, [{}]);
});

// ---- OnlineSession on a community node (Welcome.hostColo 'node:<name>') -----------------------

const RANKED_QUEUE = { '/api/queue': () => jsonResponse(200, { status: 'matched', matchId: 'm1', ticket: 'tkt', wsUrl: '/ws/m1', ranked: true }) };
const NODE_WELCOME = { welcome: { hostColo: 'node:sao-paulo-1' } };

test('OnlineSession: a ranked match that ends on a community node is flagged for the longer result wait (lastRankedOnNode)', async () => {
  const ended = encodeJson(MsgType.Event, { type: 'ended', winner: 0, blue: 1, red: 0, tick: 500 });
  const node = await playingSession(RANKED_QUEUE, NODE_WELCOME);
  node.ws.deliver(ended);
  assert.equal(node.session.lastRankedMatchId, 'm1');
  assert.equal(node.session.lastRankedOnNode, true);
  const colo = await playingSession(RANKED_QUEUE, { welcome: { hostColo: 'GRU' } });
  colo.ws.deliver(ended);
  assert.equal(colo.session.lastRankedMatchId, 'm1');
  assert.equal(colo.session.lastRankedOnNode, false);
});

test('OnlineSession: the network view carries the host of the Welcome (the panel names a community node), cleared after the match', async () => {
  const s = await playingSession({}, NODE_WELCOME);
  s.session.advance(0.01);
  assert.equal(s.session.stats.host, 'node:sao-paulo-1');
  s.session.leave();
  assert.equal(s.session.stats.host, '');
});

test('OnlineSession: a hostColo that is not a string (the Welcome is not validated) is no node and breaks nothing', async () => {
  const { formatNetStats } = await import('../src/render/Hud.ts');
  for (const hostColo of [null, 42, { name: 'node:x' }]) {
    const s = await playingSession(RANKED_QUEUE, { welcome: { hostColo } });
    s.session.advance(0.01);
    assert.equal(s.session.stats.host, '');
    assert.doesNotThrow(() => formatNetStats(s.session.stats));
    s.ws.deliver(encodeJson(MsgType.Event, { type: 'ended', winner: 0, blue: 1, red: 0, tick: 500 }));
    assert.equal(s.session.lastRankedOnNode, false);
  }
  assert.equal(P.isNodeHost('node:sao-paulo-1'), true);
  assert.equal(P.isNodeHost('GRU'), false);
  assert.equal(P.isNodeHost(undefined), false);
});

/**
 * A match played under an account session (an AccountClient on a fake clock, wired like Game.ts)
 * with ten minutes left on its Bearer when the match starts; the first /api/leave answers 401.
 */
async function accountMatch(welcome) {
  const { AccountClient } = await import('../src/net/AccountClient.ts');
  let t = 1_000_000;
  let issued = 0;
  const accounts = new AccountClient({
    storage: null,
    now: () => t,
    fetchFn: async (url) => {
      assert.equal(url, '/api/auth/refresh');
      issued++;
      return jsonResponse(200, { kind: 'account', playerId: 'acc1', name: 'Tomi', session: `jwt-a${issued}`, expiresAt: t + 3600_000 });
    },
  });
  await accounts.restore();
  t += 50 * 60_000;
  const auths = [];
  const leave = (init) => {
    auths.push(init.headers.authorization);
    return auths.length === 1 ? jsonResponse(401, { error: 'unauthorized' }) : jsonResponse(200, { ok: true, left: true, released: true });
  };
  const prepare = (client) => {
    client.sessionProvider = (minValidMs) => accounts.sessionForQueue(minValidMs);
    client.onSessionRejected = () => accounts.sessionRejected();
  };
  const s = await playingSession({ '/api/leave': leave }, { welcome, prepare });
  await flush();
  return { ...s, auths, issued: () => issued };
}

test('OnlineSession on a community node: the first Welcome renews an account Bearer with less than 15 min left; a quit refused with 401 goes again with a fresh one', async () => {
  const s = await accountMatch(NODE_WELCOME.welcome);
  assert.equal(s.issued(), 2, 'the queue kept jwt-a1 (10 min left), the Welcome renewed it');
  assert.equal(s.client.lastBearer, 'jwt-a2');
  s.session.leave();
  assert.deepEqual(s.auths, ['Bearer jwt-a2'], 'the first leave goes out before the socket closes');
  await flush();
  assert.equal(s.issued(), 3);
  assert.deepEqual(s.auths, ['Bearer jwt-a2', 'Bearer jwt-a3']);
  assert.equal(s.client.leaves, 2);
});

test('OnlineSession on a Durable Object: no early renewal and a refused quit is not retried (as before)', async () => {
  const s = await accountMatch({ hostColo: 'GRU' });
  assert.equal(s.issued(), 1);
  assert.equal(s.client.lastBearer, 'jwt-a1');
  s.session.leave();
  await flush();
  assert.equal(s.issued(), 1);
  assert.deepEqual(s.auths, ['Bearer jwt-a1']);
});

test('cars on a community node\'s match: the Worker\'s list alone; a car the node writes in its own Welcome is never drawn', async () => {
  const roster = [
    { carId: 1, slot: 0, team: 0, name: 'Tester', kind: 'player', car: 'tero' },
    { carId: 2, slot: 1, team: 1, name: 'Amigo', kind: 'player', car: 'condor' },
  ];
  const nodeQueue = (cars) => ({ '/api/queue': () => jsonResponse(200, { status: 'matched', matchId: 'm1', ticket: 'tkt', wsUrl: 'wss://node/ws/m1', node: true, ...(cars ? { cars } : {}) }) });
  const welcome = { hostColo: 'node:sao-paulo-1', roster };
  // The Worker seated the player on pampero and the other seat on the default car.
  let s = await playingSession(nodeQueue(['pampero', null]), { welcome });
  let call = s.game.rosterCalls.at(-1);
  assert.deepEqual(seatCars(call.w.roster, call.cars), ['pampero', 'dune']);
  s.session.leave();
  // Every seat on the default car: the Worker sends no `cars`, and the node's cars still do not count.
  s = await playingSession(nodeQueue(null), { welcome });
  call = s.game.rosterCalls.at(-1);
  assert.deepEqual(call.cars, []);
  assert.deepEqual(seatCars(call.w.roster, call.cars), ['dune', 'dune']);
  s.session.leave();
  // A MatchDO's Welcome (no node: true on the answer) is the Worker's own: its cars are drawn.
  s = await playingSession({}, { welcome: { roster } });
  call = s.game.rosterCalls.at(-1);
  assert.equal(call.cars, null);
  assert.deepEqual(seatCars(call.w.roster, call.cars), ['tero', 'condor']);
  s.session.leave();
});
