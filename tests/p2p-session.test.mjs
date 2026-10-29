// P2PSession (src/net/p2p/P2PSession.ts) and RoomClient (src/net/p2p/RoomClient.ts) with fakes
// (no browser, no wasm): a fake rollback engine, room, mesh, queue client and game hooks.
//   node --test tests/p2p-session.test.mjs
// Covers: the queue -> room -> mesh -> start flow, the server-kind queue answer, the start time ->
// expected tick mapping through the room clock offset, the input send cadence / acks, stall
// handling (hint 'Waiting for <name>…'), the 10 s mesh fallback, drops (engine.drop + the bot
// hook taking the slot from atTick), confirmed-timeline match events / kickoff seeds, timesync
// skips, desync -> StateRequest -> resync, and leave().
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

const SESSION = await import('../src/net/p2p/P2PSession.ts');
const { RoomClient, ROOM_CLOCK_WINDOW } = await import('../src/net/p2p/RoomClient.ts');
const P = await import('../src/net/p2p/protocol.ts');
const { TICK_MS } = await import('../src/net/ClockSync.ts');
const T = await import('../src/sim/types.ts');
const S = await import('../src/net/NetStats.ts');
const { fnv1a32 } = await import('../src/net/protocol.ts');
const { NetError } = await import('../src/net/NetClient.ts');

const { P2PSession, expectedTickAt, queueStatus, connectingStatus, waitingStatus, STATUS, FALLBACK_MS, STALL_HINT_MS, STALL_RESEND_MS, TIMESYNC_MIN_GAP_TICKS } = SESSION;
const { PACKED_INPUT_BYTES, STATE_BUFFER_FLOATS, BALL_OFFSET, B_POS } = T;

// ---- fakes ---------------------------------------------------------------------------------

class FakeSim {
  constructor() {
    this.buf = new Float32Array(STATE_BUFFER_FLOATS);
    this.tickCount = 0;
    this.numCars = 0;
    this.ballPred = new Float32Array(720 * 6);
    this.predTick = 0;
    this.events = {};
    this.calls = [];
    this.scored = false;
    this.syncEvents = 0;
    this.events.onBump = () => this.syncEvents++;
  }
  carOffset(slot) {
    return T.CARS_OFFSET + slot * T.CAR_STRIDE;
  }
  slotOf(id) {
    return id - 1;
  }
  saveState() {
    return 0;
  }
  loadState() {}
  stateHash() {
    return 0;
  }
  stateSizeMax() {
    return 0;
  }
  setControlsPacked() {}
  step() {}
  sync() {
    this.calls.push('sync');
    if (this.events.onBump) this.events.onBump(1, 2, false);
  }
  resetKickoff(seed) {
    this.calls.push(`resetKickoff:${seed}`);
  }
  updateBallPrediction() {
    this.calls.push('pred');
  }
  isBallScored() {
    return this.scored;
  }
}

class FakeEngine {
  constructor(sim, numSlots, humanSlots, localSlot, hooks, opts) {
    this.sim = sim;
    this.numSlots = numSlots;
    this.humanSlots = humanSlots.slice();
    this.localSlot = localSlot;
    this.hooks = hooks;
    this.opts = opts;
    this.tick = 0;
    this.confirmedTick = 0;
    this.canAdvanceValue = true;
    this.ahead = 0;
    this.local = [];
    this.remote = [];
    this.remoteTicks = [];
    this.drops = [];
    this.resyncs = [];
    this.hashes = [];
    this.hashVerdict = 'unknown';
    this.pendingHashes = [];
    this.stateAtValue = null;
    this.onDesync = null;
    this.onHashDecided = null;
    this.blockReason = undefined; // set to 'throttle' / 'stall' to exercise the real engine's protocol
    this.store = new Map();
    // The real engine auto-fills the first inputDelay ticks with zeros (every peer ships them).
    for (let t = 1; t <= opts.inputDelay; t++) this.store.set(t, new Int8Array(PACKED_INPUT_BYTES));
    this.stats = { rollbacks: 0, resimTicks: 0, stalls: 0, desyncs: 0, resyncs: 0, predictedAhead: 0, mispredictions: 0 };
  }
  get newestLocalTick() {
    let n = 0;
    for (const t of this.store.keys()) if (t > n) n = t;
    return n;
  }
  addLocalInput(packed, off) {
    const t = this.tick + 1 + this.opts.inputDelay;
    this.local.push({ tick: t, bytes: Array.from(packed.subarray(off, off + PACKED_INPUT_BYTES)) });
    if (!this.store.has(t)) this.store.set(t, Int8Array.from(packed.subarray(off, off + PACKED_INPUT_BYTES)));
    return t;
  }
  assembleLocalInputs(ackTick, out, cap = 16) {
    const newest = this.newestLocalTick;
    if (newest < 1) return 0;
    let first = Math.max(1, ackTick + 1, newest - cap + 1);
    if (first > newest) first = newest;
    for (let i = 0; first + i <= newest; i++) out.set(this.store.get(first + i), i * PACKED_INPUT_BYTES);
    return newest - first + 1;
  }
  addRemoteInput(slot, firstTick, count, packed) {
    this.remote.push({ slot, firstTick, count, first: packed[0] });
  }
  canAdvance() {
    return this.canAdvanceValue;
  }
  advance() {
    this.tick++;
  }
  framesAhead() {
    return this.ahead;
  }
  noteRemoteTick(slot, myTick, ackTick) {
    this.remoteTicks.push({ slot, myTick, ackTick });
  }
  confirmedHashes() {
    const out = this.pendingHashes;
    this.pendingHashes = [];
    return out;
  }
  receiveHash(slot, tick, hash) {
    this.hashes.push({ slot, tick, hash });
    return this.hashVerdict;
  }
  stateAt() {
    return this.stateAtValue;
  }
  resync(tick, blob, len) {
    this.resyncs.push({ tick, len, first: blob[0] });
    this.hooks.onResync(tick);
  }
  drop(slot, atTick) {
    this.drops.push({ slot, atTick });
  }
}

class FakeRoom {
  constructor(opts) {
    this.opts = opts;
    this.onWelcome = null;
    this.onPeerJoined = null;
    this.onPeerLeft = null;
    this.onSignal = null;
    this.onStart = null;
    this.onDrop = null;
    this.onError = null;
    this.onClose = null;
    this.rttMs = 0;
    this.offset = 0; // server - local
    this.connected = null;
    this.sent = [];
    this.closed = null;
    this.disposed = false;
  }
  connect(wsUrl, ticket) {
    this.connected = { wsUrl, ticket };
  }
  signal(to, data) {
    this.sent.push({ type: 'signal', to, data });
    return true;
  }
  ready(physicsFp) {
    this.sent.push(physicsFp === undefined ? { type: 'ready' } : { type: 'ready', physicsFp });
    return true;
  }
  unreachable(slot, atTick) {
    this.sent.push({ type: 'unreachable', slot, atTick });
    return true;
  }
  hashReport(tick, hash, agree, disagree) {
    this.sent.push({ type: 'hashReport', tick, hash, agree, disagree });
    return true;
  }
  serverToLocal(ms) {
    return ms - this.offset;
  }
  close(code, reason) {
    this.closed = { code, reason };
  }
  dispose() {
    this.disposed = true;
    this.close(1000, 'dispose');
  }
}

class FakeMesh {
  constructor(opts) {
    this.opts = opts;
    this.onGame = null;
    this.onCtl = null;
    this.onPeerConnected = null;
    this.onPeerDead = null;
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.peers = [];
    this.removed = [];
    this.reoffered = [];
    this.dropped = [];
    this.connected = false;
    this.sentGame = [];
    this.sentCtl = [];
    this.armedAt = -1;
    this.updates = 0;
    this.closed = false;
    this.rtt = 0;
  }
  addPeer(slot) {
    if (!this.peers.includes(slot)) this.peers.push(slot);
  }
  removePeer(slot) {
    this.removed.push(slot);
  }
  reoffer(slot) {
    this.reoffered.push(slot);
  }
  signalDropped(slot) {
    this.dropped.push(slot);
  }
  handleSignal() {}
  allConnected() {
    return this.connected;
  }
  connectedCount() {
    return this.connected ? this.peers.length : 0;
  }
  expectedCount() {
    // Like the real mesh: removing a slot that was never added (a no-show's peerLeft / drop) changes nothing.
    return this.peers.filter((s) => !this.removed.includes(s)).length;
  }
  peerState(slot) {
    return this.removed.includes(slot) ? S.PEER_STATE_DROPPED : this.connected ? S.PEER_STATE_CONNECTED : S.PEER_STATE_CONNECTING;
  }
  peerRttMs() {
    return this.rtt;
  }
  peerCand() {
    return S.PEER_CAND_SRFLX;
  }
  sendGame(slot, buf, len) {
    this.sentGame.push({ slot, bytes: Uint8Array.from(buf.subarray(0, len)) });
    this.bytesOut += len;
    return true;
  }
  sendCtl(slot, buf, len) {
    this.sentCtl.push({ slot, bytes: Uint8Array.from(buf.subarray(0, len)) });
    this.bytesOut += len;
    return true;
  }
  broadcastCtl(buf, len) {
    for (const slot of this.peers) this.sendCtl(slot, buf, len);
    return this.peers.length;
  }
  armLiveness(now) {
    this.armedAt = now;
  }
  update() {
    this.updates++;
  }
  close() {
    this.closed = true;
  }
}

class FakeClient {
  constructor() {
    this.name = 'Tester';
    this.queued = [];
    this.cancelled = 0;
    this.leaves = 0;
  }
  setName(n) {
    this.name = n;
  }
  queue(mode, kind, onWaiting) {
    const q = { mode, kind, onWaiting };
    this.queued.push(q);
    return new Promise((resolve, reject) => {
      q.resolve = resolve;
      q.reject = reject;
    });
  }
  cancelQueue() {
    this.cancelled++;
  }
  leaveMatch() {
    this.leaves++;
    return Promise.resolve(true);
  }
}

function makeGame(sim) {
  return {
    sim,
    log: [],
    applyP2PRoster(w) {
      this.log.push(['roster', w.you.slot, w.slots.length]);
      sim.numCars = w.slots.length;
    },
    restoreOfflineRoster() {
      this.log.push(['restore']);
    },
    p2pMatchOnScreen() {
      this.log.push(['onScreen']);
    },
    p2pSampleInput(out) {
      out.throttle = 1;
      out.boost = true;
    },
    p2pAfterTick() {
      this.log.push(['afterTick']);
    },
    afterRollback() {
      this.log.push(['afterRollback']);
    },
    p2pMatchEvent(e, blue, red) {
      this.log.push(['event', e.type, blue, red]);
    },
    p2pKickoffReset() {
      this.log.push(['kickoff']);
    },
    p2pSlotDropped(slot, name) {
      this.log.push(['dropped', slot, name]);
    },
    p2pHandover(mode, assignment, notice) {
      this.log.push(['handover', mode, assignment === null ? null : assignment.kind, notice]);
    },
    onSessionDisconnected(message) {
      this.log.push(['disconnected', message]);
    },
  };
}

function welcomeFor(mySlot, slots) {
  return {
    type: 'room',
    protocol: P.P2P_PROTOCOL_VERSION,
    roomId: 'room1',
    mode: slots.length === 2 ? '1v1' : slots.length === 4 ? '2v2' : '3v3',
    seed: 4242,
    inputDelay: 3,
    window: 16,
    hashEvery: 30,
    tickRate: 120,
    matchLengthSeconds: 300,
    you: { slot: mySlot, peerId: 'me' },
    slots,
    iceServers: [{ urls: 'stun:stun.example:3478' }],
    now: 1_000_000,
    physics: null,
  };
}

const SLOTS_1V1 = [
  { slot: 0, team: 0, name: 'Me', kind: 'peer', peerId: 'me', connected: true },
  { slot: 1, team: 1, name: 'Rival', kind: 'peer', peerId: 'p1', connected: true },
];
const SLOTS_2V2 = [
  { slot: 0, team: 0, name: 'Me', kind: 'peer', peerId: 'me', connected: true },
  { slot: 1, team: 0, name: 'Bot 2', kind: 'bot', connected: false },
  { slot: 2, team: 1, name: 'Ana', kind: 'peer', peerId: 'p2', connected: true },
  { slot: 3, team: 1, name: 'Bot 2', kind: 'bot', connected: false },
];

/** A session wired to the fakes; `env` exposes them and a settable clock. */
function makeSession() {
  const sim = new FakeSim();
  const game = makeGame(sim);
  const client = new FakeClient();
  const env = { sim, game, client, room: null, mesh: null, engine: null, t: 5000 };
  const session = new P2PSession(game, {
    client,
    now: () => env.t,
    engineFactory: (s, n, humans, me, hooks, opts) => (env.engine = new FakeEngine(s, n, humans, me, hooks, opts)),
    roomFactory: (opts) => (env.room = new FakeRoom(opts)),
    meshFactory: (opts) => (env.mesh = new FakeMesh(opts)),
  });
  env.session = session;
  return env;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** queue -> p2p room -> welcome -> connected -> ready -> start at `startAtLocal` (local clock). Leaves the session in 'countdown'. */
async function startedSession(slots = SLOTS_1V1, mySlot = 0, startDelayMs = 200) {
  const env = makeSession();
  const { session, client } = env;
  session.quickMatch('1v1');
  assert.equal(session.state, 'queue');
  client.queued[0].resolve({ kind: 'p2p', roomId: 'room1', ticket: 'TICKET', wsUrl: '/room/room1' });
  await flush();
  assert.equal(session.state, 'signaling');
  env.room.offset = 995_000; // server clock is 995 s ahead of the local one
  env.room.onWelcome(welcomeFor(mySlot, slots));
  assert.equal(session.state, 'connecting');
  env.mesh.connected = true;
  session.advance(0);
  env.startAtLocal = env.t + startDelayMs;
  env.room.onStart(env.startAtLocal + env.room.offset, env.startAtLocal + env.room.offset - 50);
  assert.equal(session.state, 'countdown');
  return env;
}

// ---- pure helpers -------------------------------------------------------------------------

test('status strings and the start time -> expected tick mapping', () => {
  // English outside a browser (src/i18n.ts); src/locales/es.ts keeps the Spanish lines.
  assert.equal(queueStatus(2), 'Finding a match… (2 waiting)');
  assert.equal(queueStatus(1), 'Finding a match… (1 waiting)');
  assert.equal(connectingStatus(1, 3), 'Connecting to players… 1/3');
  assert.equal(waitingStatus('Ana'), 'Waiting for Ana…');
  assert.equal(expectedTickAt(1000, 1000), 0);
  assert.equal(expectedTickAt(1000 + 3 * TICK_MS + 0.1, 1000), 3);
  assert.equal(expectedTickAt(999, 1000), -1, 'before the start');
  assert.equal(expectedTickAt(1000 + 1000 + 0.01, 1000), 120, '120 ticks per second');
});

test('RoomClient clock: the welcome seeds a coarse offset, pongs refine it (median of 8), serverToLocal places startAt on the local clock', () => {
  let t = 10_000;
  const sent = [];
  let socket = null;
  const client = new RoomClient({
    now: () => t,
    pingIntervalMs: 1_000_000,
    webSocketFactory: (url, protocols) => {
      socket = { url, protocols, binaryType: 'blob', readyState: 0, protocol: '', onopen: null, onmessage: null, onclose: null, onerror: null, send: (d) => sent.push(JSON.parse(d)), close() {} };
      return socket;
    },
  });
  const welcomes = [];
  client.onWelcome = (w) => welcomes.push(w);
  client.connect('/room/r1', 'TK');
  assert.deepEqual(socket.protocols, ['tg1', 'ticket.TK']);
  assert.equal(socket.url.endsWith('/room/r1'), true);
  socket.readyState = 1;
  socket.onopen({});
  assert.deepEqual(sent[0], { type: 'ping', t0: 10_000 }, 'a ping goes out on open');

  // Server clock = local + 500_000 (epoch-like). The welcome's `now` is a coarse first sample.
  const OFFSET = 500_000;
  socket.onmessage({ data: JSON.stringify({ ...welcomeFor(0, SLOTS_1V1), now: t + OFFSET }) });
  assert.equal(welcomes.length, 1);
  assert.equal(client.samples, 1);
  assert.equal(client.offsetMs, OFFSET);
  // Pongs with a 40 ms rtt: offset = now - (t0 + t3) / 2 = exact when symmetric; one outlier is medianed out.
  for (let i = 0; i < ROOM_CLOCK_WINDOW + 2; i++) {
    const t0 = t;
    t += 40;
    const skew = i === 3 ? 10_000 : 0; // one wild sample
    socket.onmessage({ data: JSON.stringify({ type: 'pong', t0, now: t0 + 20 + OFFSET + skew }) });
  }
  assert.equal(client.samples, ROOM_CLOCK_WINDOW);
  assert.equal(client.rttMs, 40);
  assert.equal(client.offsetMs, OFFSET, 'the median ignores the outlier');
  assert.equal(client.serverToLocal(t + OFFSET + 1234), t + 1234);
  assert.equal(expectedTickAt(t + 1234 + 5 * TICK_MS + 0.01, client.serverToLocal(t + OFFSET + 1234)), 5);

  const starts = [];
  client.onStart = (startAt, now) => starts.push({ startAt, now });
  socket.onmessage({ data: JSON.stringify({ type: 'start', startAt: 777, now: 700 }) });
  assert.deepEqual(starts, [{ startAt: 777, now: 700 }]);
  client.ready();
  client.unreachable(2, 1200);
  assert.deepEqual(sent.at(-2), { type: 'ready' });
  assert.deepEqual(sent.at(-1), { type: 'unreachable', slot: 2, atTick: 1200 });
  const errors = [];
  client.onError = (code, msg) => errors.push(code);
  socket.onmessage({ data: '{not json' });
  assert.deepEqual(errors, ['protocol']);
});

// ---- flow ------------------------------------------------------------------------------------

test('queue -> room -> welcome builds the roster, seeds the kickoff / engine / mesh, ready when the mesh completes, start -> on screen', async () => {
  const env = makeSession();
  const { session, client, game, sim } = env;
  session.quickMatch('2v2');
  assert.equal(client.queued[0].kind, 'p2p');
  assert.equal(session.busy, true);
  assert.equal(session.statusText, STATUS.queue);
  client.queued[0].onWaiting(3);
  assert.equal(session.statusText, 'Finding a match… (3 waiting)');
  client.queued[0].resolve({ kind: 'p2p', roomId: 'room1', ticket: 'TICKET', wsUrl: '/room/room1' });
  await flush();
  assert.equal(session.state, 'signaling');
  assert.deepEqual(env.room.connected, { wsUrl: '/room/room1', ticket: 'TICKET' });

  env.room.onWelcome(welcomeFor(2, SLOTS_2V2));
  assert.equal(session.state, 'connecting');
  assert.deepEqual(game.log[0], ['roster', 2, 4]);
  assert.ok(sim.calls.includes('resetKickoff:4242'), 'rs_reset_kickoff with the room seed');
  assert.equal(session.mySlot, 2);
  assert.equal(session.mode, '2v2');
  const engine = env.engine;
  assert.equal(engine.numSlots, 4);
  assert.deepEqual(engine.humanSlots, [0, 2], 'bot slots are not human');
  assert.equal(engine.localSlot, 2);
  assert.deepEqual(engine.opts, { inputDelay: 3, window: 16, hashEvery: 30 });
  assert.equal(typeof engine.onDesync, 'function', 'the session installs its desync handler');
  assert.deepEqual(env.mesh.peers, [0], 'one RTCPeerConnection per other human peer');
  assert.equal(env.mesh.opts.mySlot, 2);
  assert.deepEqual(env.mesh.opts.iceServers, [{ urls: 'stun:stun.example:3478' }]);
  env.mesh.opts.signal(0, { candidate: null });
  assert.deepEqual(env.room.sent.at(-1), { type: 'signal', to: 0, data: { candidate: null } }, 'mesh signals go through the room');
  assert.equal(session.statusText, 'Connecting to players… 0/1');
  assert.equal(session.frozen, true);

  session.advance(0);
  assert.equal(env.room.sent.some((m) => m.type === 'ready'), false);
  env.mesh.connected = true;
  session.advance(0);
  assert.equal(env.room.sent.filter((m) => m.type === 'ready').length, 1);
  session.advance(0);
  assert.equal(env.room.sent.filter((m) => m.type === 'ready').length, 1, 'ready once');
  assert.equal(session.statusText, STATUS.readyWait);

  env.room.offset = 100;
  env.room.onStart(env.t + 500 + 100, env.t + 100);
  assert.equal(session.state, 'countdown');
  assert.equal(session.startAtLocal, env.t + 500);
  assert.equal(env.mesh.armedAt, -1, 'liveness is not armed at the start (a late first packet must not kill a peer)');
  assert.ok(game.log.some((e) => e[0] === 'onScreen'));
  env.t += 500 + TICK_MS + 1;
  session.advance(0);
  assert.equal(env.mesh.armedAt, env.t, 'liveness armed on the first local step');
  assert.equal(session.inMatch, true);
  assert.equal(session.active, true);
  assert.equal(session.busy, false);
  assert.equal(session.statusText, null);
  assert.equal(session.stats.p2pPeers, 1);
  assert.equal(session.stats.p2pPeerSlot[0], 0);
  assert.equal(session.stats.p2pPeerName[0], 'Me');
});

test('a p2p queue answered with a server match hands over to the phase 1 session', async () => {
  const env = makeSession();
  const { session, client, game } = env;
  session.quickMatch('1v1');
  client.queued[0].resolve({ kind: 'server', matchId: 'm1', ticket: 'T', wsUrl: '/ws/m1' });
  await flush();
  assert.equal(session.state, 'idle');
  assert.deepEqual(game.log, [['handover', '1v1', 'server', STATUS.serverAnswer]]);
});

test('ticks follow the local clock from startAt: none before it, catch up after; countdown -> playing on the first tick', async () => {
  const env = await startedSession();
  const { session, engine, game } = env;
  env.t = env.startAtLocal - 1;
  session.advance(0.016);
  assert.equal(engine.tick, 0);
  assert.equal(session.state, 'countdown');
  env.t = env.startAtLocal + 3 * TICK_MS + 0.5;
  session.advance(0.016);
  assert.equal(engine.tick, 3, 'floor((now - startAtLocal) / TICK_MS) ticks');
  assert.equal(session.state, 'playing');
  assert.equal(engine.local.length, 3);
  assert.deepEqual(engine.local[0].bytes, [0, 0, 0, 0, 0, 0], 'frozen (kickoff countdown): the local input is zeroed');
  assert.equal(engine.local[0].tick, 1 + 3, 'registered for tick + inputDelay');
  assert.equal(game.log.filter((e) => e[0] === 'afterTick').length, 3);
  const alpha = session.advance(0);
  assert.ok(alpha >= 0 && alpha <= 1);
  env.t = env.startAtLocal + 1000 * TICK_MS;
  session.advance(0.1);
  assert.equal(engine.tick, 3 + 64, 'at most MAX_TICKS_PER_FRAME per frame');
});

test('inputs go out every 2 ticks to each peer with the unacked ticks; incoming packets feed the engine and the acks', async () => {
  const env = await startedSession(SLOTS_2V2, 0);
  const { session, engine, mesh } = env;
  env.t = env.startAtLocal + 2 * TICK_MS + 0.5;
  session.advance(0);
  assert.equal(engine.tick, 2);
  assert.equal(mesh.sentGame.length, 1, 'one packet to the one human peer (slot 2), none to bots');
  assert.equal(mesh.sentGame[0].slot, 2);
  const pkt = { firstTick: 0, count: 0, ackTick: 0, myTick: 0, packed: new Int8Array(P.P2P_INPUT_MAX_BATCH * PACKED_INPUT_BYTES) };
  assert.ok(P.decodeP2pInput(mesh.sentGame[0].bytes, pkt));
  assert.equal(pkt.firstTick, 1, 'the first batch ships the engine-filled zero ticks 1..3 plus 4 and 5 (1 + delay, 2 + delay)');
  assert.equal(pkt.count, 5);
  assert.equal(pkt.myTick, 2);
  assert.equal(pkt.ackTick, 0, 'nothing received from slot 2 yet');

  // A packet from slot 2 acking our tick 4 and carrying its ticks 7..9 (myTick 6).
  const out = new Uint8Array(P.INPUT_HDR + 3 * PACKED_INPUT_BYTES);
  const theirs = new Int8Array(3 * PACKED_INPUT_BYTES).fill(5);
  const len = P.encodeP2pInput(out, 7, 3, 4, 6, theirs, 0);
  mesh.onGame(2, out.subarray(0, len));
  assert.deepEqual(engine.remote, [{ slot: 2, firstTick: 7, count: 3, first: 5 }]);
  assert.deepEqual(engine.remoteTicks, [{ slot: 2, myTick: 6, ackTick: 4 }], 'the engine gets the peer ack for its lead estimate');
  env.t = env.startAtLocal + 4 * TICK_MS + 0.5;
  session.advance(0);
  assert.equal(mesh.sentGame.length, 2);
  assert.ok(P.decodeP2pInput(mesh.sentGame[1].bytes, pkt));
  assert.equal(pkt.firstTick, 5, 'tick 4 was acked: 5..7 go out');
  assert.equal(pkt.count, 3);
  assert.equal(pkt.ackTick, 9, 'the newest tick received from slot 2');
  // Garbage never reaches the engine.
  mesh.onGame(2, new Uint8Array([9, 9]));
  assert.equal(engine.remote.length, 1);
});

test('stall: canAdvance false stops the ticks, keeps resending, and after 250 ms names the slowest peer', async () => {
  const env = await startedSession(SLOTS_2V2, 0);
  const { session, engine, mesh } = env;
  env.t = env.startAtLocal + 2 * TICK_MS + 1;
  session.advance(0);
  assert.equal(engine.tick, 2);
  engine.canAdvanceValue = false;
  env.t += 5 * TICK_MS;
  session.advance(0);
  assert.equal(engine.tick, 2, 'no tick while the engine waits for inputs');
  assert.equal(session.stallFrames, 1);
  assert.equal(session.hint, null, 'a short stall shows nothing');
  const sentBefore = mesh.sentGame.length;
  env.t += STALL_HINT_MS + 1;
  session.advance(0);
  assert.equal(session.hint, 'Waiting for Ana…', 'the human peer whose inputs are the oldest');
  assert.ok(mesh.sentGame.length > sentBefore, 'our newest inputs are repeated during the stall');
  engine.canAdvanceValue = true;
  env.t += TICK_MS;
  session.advance(0);
  assert.ok(engine.tick > 2);
  assert.equal(session.hint, null);
  session.advance(0);
  assert.equal(session.stats.stalls, session.stallFrames);
});

test('fallback: a mesh that is not complete 10 s after the welcome leaves the room and hands over to a server queue', async () => {
  const env = makeSession();
  const { session, client, game } = env;
  session.quickMatch('1v1');
  client.queued[0].resolve({ kind: 'p2p', roomId: 'room1', ticket: 'TICKET', wsUrl: '/room/room1' });
  await flush();
  env.room.onWelcome(welcomeFor(0, SLOTS_1V1));
  session.advance(0);
  env.t += FALLBACK_MS;
  session.advance(0);
  assert.equal(session.state, 'connecting', 'exactly 10 s is not over');
  env.t += 1;
  session.advance(0);
  assert.equal(session.state, 'idle');
  assert.ok(env.mesh.closed);
  assert.ok(env.room.disposed);
  assert.deepEqual(game.log.at(-1), ['handover', '1v1', null, STATUS.fallback]);
  assert.equal(session.stats.kind, 'none', 'stats view reset');
});

test('cancel while connecting restores the offline roster; a room error / close before the start fails to the menu', async () => {
  const env = makeSession();
  const { session, client, game } = env;
  session.quickMatch('1v1');
  client.queued[0].resolve({ kind: 'p2p', roomId: 'room1', ticket: 'TICKET', wsUrl: '/room/room1' });
  await flush();
  env.room.onWelcome(welcomeFor(0, SLOTS_1V1));
  session.cancel();
  assert.equal(session.state, 'idle');
  assert.deepEqual(game.log.at(-1), ['restore']);
  assert.ok(env.mesh.closed && env.room.disposed);

  // A close after the welcome (connecting) fails at once: the seat was taken and is gone.
  session.quickMatch('1v1');
  client.queued[1].resolve({ kind: 'p2p', roomId: 'room2', ticket: 'T2', wsUrl: '/room/room2' });
  await flush();
  env.room.onWelcome(welcomeFor(0, SLOTS_1V1));
  env.room.onClose(1006, '');
  assert.equal(session.state, 'idle');
  assert.equal(session.statusIsError, true);
  assert.equal(session.statusText, 'The match room closed', 'the close code goes to the console only');
  assert.equal(client.queued.length, 2, 'no automatic queue after the welcome');
});

test('a room socket closed before the welcome (the upgrade was refused, e.g. 403 left after the no-show grace) releases the lock and queues again once; a second one fails to the menu', async () => {
  const env = makeSession();
  const { session, client, game } = env;
  session.quickMatch('2v2');
  client.queued[0].resolve({ kind: 'p2p', roomId: 'room1', ticket: 'T1', wsUrl: '/room/room1' });
  await flush();
  assert.equal(session.state, 'signaling');
  const first = env.room;
  first.onClose(1006, '');
  assert.equal(session.state, 'queue', 'queued again by itself');
  assert.equal(session.error, null);
  assert.equal(session.statusText, STATUS.requeue);
  assert.equal(session.statusIsError, false);
  assert.equal(client.leaves, 1, 'the lock of the lost seat is released first (the queue waits for it)');
  assert.ok(first.disposed);
  assert.equal(client.queued.length, 2);
  assert.equal(client.queued[1].mode, '2v2');
  assert.equal(client.queued[1].kind, 'p2p');
  assert.ok(session.log.text().includes('room.requeue'), 'logged');
  client.queued[1].onWaiting(3);
  assert.equal(session.statusText, queueStatus(3), 'then the usual queue status');
  // The second room: welcomed and played normally would be fine; refused again -> the menu.
  client.queued[1].resolve({ kind: 'p2p', roomId: 'room2', ticket: 'T2', wsUrl: '/room/room2' });
  await flush();
  assert.equal(session.state, 'signaling');
  assert.notEqual(env.room, first);
  env.room.onClose(1006, '');
  assert.equal(session.state, 'idle');
  assert.equal(session.statusText, 'The match room closed', 'the close code goes to the console only');
  assert.equal(client.queued.length, 2, 'once per quick match');
  assert.equal(client.leaves, 2);
  assert.deepEqual(game.log, [], 'no handover, no roster');
  // A new quick match gets its own retry.
  session.quickMatch('1v1');
  client.queued[2].resolve({ kind: 'p2p', roomId: 'room3', ticket: 'T3', wsUrl: '/room/room3' });
  await flush();
  env.room.onClose(1006, '');
  assert.equal(session.state, 'queue');
  assert.equal(client.queued.length, 4);
  session.cancel();
  assert.equal(session.state, 'idle');
});

test('drop: engine.drop(slot, atTick), the mesh stops expecting it, the Game is told, and the bot hook owns the slot from atTick', async () => {
  const env = await startedSession(SLOTS_2V2, 0);
  const { session, engine, mesh, game } = env;
  const hooks = engine.hooks;
  const out = new Int8Array(4 * PACKED_INPUT_BYTES).fill(0x55);
  // Frozen (kickoff countdown): every slot is zeroed on the confirmed timeline, humans included.
  hooks.botInputs(10, out);
  assert.deepEqual(Array.from(out), new Array(4 * PACKED_INPUT_BYTES).fill(0));
  assert.deepEqual([0, 1, 2, 3].map((s) => session.isBotSlot(s)), [false, true, false, true]);

  env.room.onDrop(2, 500);
  assert.deepEqual(engine.drops, [{ slot: 2, atTick: 500 }]);
  assert.deepEqual(mesh.removed, [2]);
  assert.deepEqual(game.log.at(-1), ['dropped', 2, 'Ana']);
  hooks.botInputs(499, out);
  assert.equal(session.isBotSlot(2), false, 'before atTick slot 2 is still human');
  hooks.botInputs(500, out);
  assert.equal(session.isBotSlot(2), true, 'from atTick on slot 2 is a bot');
  // Unfrozen: the bot pass writes the bot slots (buttons byte <= 7) and leaves the human slot alone.
  for (let t = 1; t <= 361; t++) hooks.onConfirmedTick(t);
  assert.equal(session.frozen, false);
  out.fill(0x55);
  hooks.botInputs(501, out);
  assert.equal(out[0 * PACKED_INPUT_BYTES + 5], 0x55, 'human slot 0 untouched');
  for (const s of [1, 2, 3]) assert.ok(out[s * PACKED_INPUT_BYTES + 5] <= 7, `bot slot ${s} written`);
  env.room.onDrop(2, 600);
  assert.equal(engine.drops.length, 1, 'a second drop of the same slot is ignored');
  // No more packets to the dropped slot.
  env.t = env.startAtLocal + 2 * TICK_MS + 1;
  session.advance(0);
  assert.equal(mesh.sentGame.length, 0);
  session.advance(0);
  assert.equal(session.stats.p2pPeerState[0], S.PEER_STATE_DROPPED);
  // Being dropped myself ends the match.
  env.room.onDrop(0, 700);
  assert.deepEqual(game.log.at(-1), ['disconnected', STATUS.droppedMe]);
});

test('a dead peer link is reported to the room as unreachable at the current predicted tick', async () => {
  const env = await startedSession(SLOTS_1V1, 0);
  const { session, engine, mesh } = env;
  env.t = env.startAtLocal + 5 * TICK_MS + 1;
  session.advance(0);
  mesh.onPeerDead(1);
  assert.deepEqual(env.room.sent.at(-1), { type: 'unreachable', slot: 1, atTick: engine.tick });
  assert.equal(session.peersDead, 1);
});

test('confirmed-timeline hooks: countdown events, kickoff resets with seed + n, goal detection, the whistle ends the session', async () => {
  const env = await startedSession(SLOTS_1V1, 0);
  const { session, engine, sim, game } = env;
  const hooks = engine.hooks;
  sim.syncEvents = 0;
  hooks.onConfirmedTick(1);
  assert.equal(sim.syncEvents, 0, 'the confirmed-timeline sync never fires the bridge FX events');
  assert.equal(typeof sim.events.onBump, 'function', 'handlers restored');
  assert.deepEqual(game.log.filter((e) => e[0] === 'event').map((e) => e[1]), ['countdown']);
  assert.ok(game.log.some((e) => e[0] === 'kickoff'));
  assert.equal(sim.calls.filter((c) => c.startsWith('resetKickoff')).at(-1), 'resetKickoff:4242', 'the first kickoff repeats the room seed');
  for (let t = 2; t <= 361; t++) hooks.onConfirmedTick(t);
  assert.ok(game.log.some((e) => e[0] === 'event' && e[1] === 'go'), 'countdown over after 3 s of confirmed ticks');
  assert.equal(session.frozen, false);
  const predBefore = sim.calls.filter((c) => c === 'pred').length;
  const out = new Int8Array(2 * PACKED_INPUT_BYTES);
  hooks.botInputs(362, out);
  assert.equal(sim.calls.filter((c) => c === 'pred').length, predBefore + 1, 'ball prediction refreshed on a confirmed, unfrozen tick');
  // Goal: ball-scored rising edge with y > 0 (red net) -> blue scores; the goal pause then resets with seed + 1.
  sim.scored = true;
  sim.buf[BALL_OFFSET + B_POS + 1] = 5200;
  hooks.onConfirmedTick(362);
  assert.deepEqual(game.log.at(-1), ['event', 'goal', 1, 0]);
  assert.deepEqual(session.score, { blue: 1, red: 0 });
  hooks.onConfirmedTick(363);
  assert.equal(session.score.blue, 1, 'a scored ball during the pause is not a second goal');
  for (let t = 364; t <= 363 + 361; t++) hooks.onConfirmedTick(t);
  assert.equal(sim.calls.filter((c) => c.startsWith('resetKickoff')).at(-1), 'resetKickoff:4243', 'next kickoff: seed + 1');
  sim.scored = false;
  assert.equal(session.match.phase, 'kickoff');
  for (let t = 725; t <= 725 + 361; t++) hooks.onConfirmedTick(t);
  assert.equal(session.match.phase, 'playing', 'second countdown over');
  // Final whistle: a scoreline at 0:00 ends the match (shortened clock via the Match itself).
  session.match.clock = 0.001;
  hooks.onConfirmedTick(1100);
  hooks.onConfirmedTick(1101);
  assert.equal(session.state, 'ended');
  assert.deepEqual(game.log.at(-1), ['event', 'ended', 1, 0]);
  assert.equal(session.frozen, true);
  session.leave();
  assert.equal(session.state, 'idle');
  assert.deepEqual(game.log.at(-1), ['restore']);
  assert.ok(env.mesh.closed && env.room.disposed);
});

test('timesync: well ahead of the slowest peer the local clock shifts one tick, at most once per 30 ticks', async () => {
  const env = await startedSession(SLOTS_1V1, 0);
  const { session, engine } = env;
  const start = session.startAtLocal;
  engine.ahead = 3;
  env.t = start + 2 * TICK_MS + 1;
  session.advance(0);
  assert.equal(session.timesyncSkips, 1);
  assert.equal(session.startAtLocal, start + TICK_MS);
  assert.equal(engine.tick, 1, 'the skip costs one tick of this frame');
  env.t = start + 10 * TICK_MS + 1;
  session.advance(0);
  assert.equal(session.timesyncSkips, 1, 'no second skip within TIMESYNC_MIN_GAP_TICKS');
  env.t = start + (TIMESYNC_MIN_GAP_TICKS + 3) * TICK_MS + 1;
  session.advance(0);
  assert.equal(session.timesyncSkips, 2);
  engine.ahead = 2;
  env.t = start + (2 * TIMESYNC_MIN_GAP_TICKS + 6) * TICK_MS + 1;
  session.advance(0);
  assert.equal(session.timesyncSkips, 2, 'ahead by 2 is tolerated');
});

test('hashes: confirmed hashes go to every peer over ctl; incoming hashes vote; desync twice -> StateRequest to the majority slot, StateResponse -> resync, thrice -> abandon', async () => {
  const env = await startedSession(SLOTS_2V2, 2);
  const { session, engine, mesh, game } = env;
  engine.confirmedTick = 30;
  engine.pendingHashes = [{ tick: 30, hash: 0xabcdef01 }];
  env.t = env.startAtLocal + TICK_MS + 1;
  session.advance(0);
  assert.equal(mesh.sentCtl.length, 1);
  const h = { tick: 0, hash: 0 };
  assert.ok(P.decodeHash(mesh.sentCtl[0].bytes, h));
  assert.deepEqual(h, { tick: 30, hash: 0xabcdef01 });
  env.t += 1000;
  session.advance(0);
  assert.ok(env.room.sent.some((m) => m.type === 'hashReport' && m.tick === 30), 'a summary reaches the room once a second');

  const buf = new Uint8Array(P.HASH_LEN);
  engine.hashVerdict = 'disagree';
  mesh.onCtl(0, buf.subarray(0, P.encodeHash(buf, 30, 0x11111111)));
  assert.deepEqual(engine.hashes, [{ slot: 0, tick: 30, hash: 0x11111111 }]);
  assert.equal(session.hashesDisagreed, 1);
  session.advance(0);
  assert.equal(env.room.sent.filter((m) => m.type === 'hashReport').length, 2, 'a disagreeing vote reports to the room at once');

  const blob = new Uint8Array(100).fill(7);
  const h60 = fnv1a32(blob, 100);
  engine.onDesync(30, 0xabcdef01, h60, 0, 1);
  assert.equal(mesh.sentCtl.length, 1, 'a first minority verdict waits for the next one');
  engine.onDesync(60, 0xabcdef01, h60, 0, 1);
  assert.equal(mesh.sentCtl.length, 2, 'second in a row: StateRequest');
  assert.equal(mesh.sentCtl[1].slot, 0, 'to the human peer whose hash is the majority (the lower slot)');
  assert.equal(mesh.sentCtl[1].bytes[0], P.P2pMsg.StateRequest);
  assert.equal(new DataView(mesh.sentCtl[1].bytes.buffer).getUint32(1, true), 60);
  assert.equal(session.stateRequests, 1);
  engine.onDesync(90, 0xabcdef01, h60, 0, 1);
  assert.equal(mesh.sentCtl.length, 2, 'a third verdict while the request is in flight neither re-requests nor abandons');

  // Answers that are not the one asked for never reach the engine: wrong peer, wrong tick, a hash
  // that is not the majority's, a blob that does not hash to its header.
  const resp = new Uint8Array(P.STATE_RESP_HDR + 100);
  mesh.onCtl(1, resp.subarray(0, P.encodeStateResponse(resp, 60, h60, blob, 100)));
  mesh.onCtl(0, resp.subarray(0, P.encodeStateResponse(resp, 90, h60, blob, 100)));
  mesh.onCtl(0, resp.subarray(0, P.encodeStateResponse(resp, 60, 0x11111111, blob, 100)));
  mesh.onCtl(0, resp.subarray(0, P.encodeStateResponse(resp, 60, h60, new Uint8Array(100).fill(8), 100)));
  assert.deepEqual(engine.resyncs, [], 'unverified responses ignored');
  mesh.onCtl(0, resp.subarray(0, P.encodeStateResponse(resp, 60, h60, blob, 100)));
  assert.deepEqual(engine.resyncs, [{ tick: 60, len: 100, first: 7 }]);
  assert.equal(session.resyncs, 1);
  assert.deepEqual(game.log.at(-1), ['afterRollback'], 'hooks.onResync refreshed the Game snapshot');
  mesh.onCtl(0, resp.subarray(0, P.encodeStateResponse(resp, 60, h60, blob, 100)));
  assert.equal(engine.resyncs.length, 1, 'a duplicate answer (no request pending) is ignored');

  // Serving a StateRequest from a peer: the sim blob plus our checkpoint trailer (Match + bots at that tick).
  engine.stateAtValue = { blob: new Uint8Array(50).fill(3), len: 50, hash: 0x22 };
  engine.hooks.onConfirmedTick(90);
  const req = new Uint8Array(5);
  mesh.onCtl(0, req.subarray(0, P.encodeStateRequest(req, 90)));
  const out = { tick: 0, len: 0, hash: 0, blob: null };
  assert.ok(P.decodeStateResponse(mesh.sentCtl.at(-1).bytes, out));
  const floats = new Float64Array(SESSION.CHECKPOINT_FLOATS);
  const split = { simLen: 0, count: 0 };
  P.splitStateTrailer(out.blob, out.len, floats, split);
  assert.deepEqual([out.tick, out.hash, out.blob[0], split.simLen], [90, 0x22, 3, 50]);
  assert.ok(split.count > 0 && out.len === 50 + P.stateTrailerBytes(split.count), `trailer of ${split.count} floats`);
  assert.equal(floats[0], 1, 'kickoffs so far in the trailer');

  // Still a minority after the resync: the third verdict of the streak abandons.
  engine.onDesync(120, 1, 2, 0, 1);
  assert.deepEqual(game.log.at(-1), ['disconnected', STATUS.desync]);
});

test('minority streak: a partner agreeing per packet does not reset it, the decided vote does; an unanswered request is retried, five verdicts give up', async () => {
  const env = await startedSession(SLOTS_2V2, 2);
  const { session, engine, mesh, game } = env;
  engine.confirmedTick = 30;
  const buf = new Uint8Array(P.HASH_LEN);
  // 2-2 tie seen from the losing pair: every hash tick brings one 'agree' from the partner and
  // the engine's decision says minority.
  engine.hashVerdict = 'agree';
  engine.onDesync(30, 1, 2, 1, 2);
  mesh.onCtl(0, buf.subarray(0, P.encodeHash(buf, 30, 1)));
  engine.onDesync(60, 1, 2, 1, 2);
  assert.equal(mesh.sentCtl.length, 1, 'second minority decision in a row: StateRequest (the partner agreeing did not reset the streak)');
  assert.equal(session.hashesAgreed, 1);
  engine.onHashDecided(90, true);
  engine.onDesync(120, 1, 2, 1, 2);
  assert.equal(mesh.sentCtl.length, 1, 'an agreed decision reset the streak: back to the first verdict');
  // Lost answer: after a hash period the request is forgotten and the next verdict asks again.
  engine.onDesync(150, 1, 2, 1, 2);
  assert.equal(mesh.sentCtl.length, 2);
  engine.confirmedTick = 150 + 30;
  session.advance(0);
  engine.onDesync(180, 1, 2, 1, 2);
  assert.equal(mesh.sentCtl.length, 3, 'asked again');
  engine.confirmedTick = 180 + 30;
  session.advance(0);
  engine.onDesync(210, 1, 2, 1, 2);
  assert.equal(mesh.sentCtl.length, 4);
  assert.ok(!game.log.some((e) => e[0] === 'disconnected'));
  engine.confirmedTick = 210 + 30;
  session.advance(0);
  engine.onDesync(240, 1, 2, 1, 2);
  assert.deepEqual(game.log.at(-1), ['disconnected', STATUS.desync], 'five in a row without an answer: give up');
});

test('throttle (engine.blockReason): the clock shifts instead of stalling, no stall counted', async () => {
  const env = await startedSession(SLOTS_1V1, 0);
  const { session, engine, mesh } = env;
  const start = session.startAtLocal;
  env.t = start + 2 * TICK_MS + 1;
  session.advance(0);
  assert.equal(engine.tick, 2);
  engine.canAdvanceValue = false;
  engine.blockReason = 'throttle';
  const sentBefore = mesh.sentGame.length;
  env.t = start + 4 * TICK_MS + 1;
  session.advance(0);
  assert.equal(engine.tick, 2, 'no tick simulated while throttled');
  assert.equal(session.timesyncSkips, 1, 'one of the two due ticks became a clock shift (one per frame)');
  assert.equal(session.throttleFrames, 1);
  assert.ok(Math.abs(session.startAtLocal - (start + TICK_MS)) < 1e-6);
  assert.equal(session.stallFrames, 0, 'a throttle is not a stall');
  assert.equal(session.hint, null);
  env.t += STALL_RESEND_MS + 1;
  session.advance(0);
  assert.equal(session.timesyncSkips, 2, 'the next frame shifts the clock again');
  assert.ok(mesh.sentGame.length > sentBefore, 'the newest inputs keep going out while throttled (ack / liveness for the slow peer)');
  engine.blockReason = 'stall';
  env.t = start + 6 * TICK_MS + 1;
  session.advance(0);
  assert.equal(session.stallFrames, 1);
  assert.equal(session.timesyncSkips, 2);
  engine.canAdvanceValue = true;
  engine.blockReason = 'none';
  session.advance(0);
  assert.equal(engine.tick, 4, 'ticks resume against the shifted clock');
});

test('connecting: the first joiner is not ready with an empty mesh; a peer that joins later completes it', async () => {
  const env = makeSession();
  const { session, client } = env;
  session.quickMatch('1v1');
  client.queued[0].resolve({ kind: 'p2p', roomId: 'room1', ticket: 'TICKET', wsUrl: '/room/room1' });
  await flush();
  const slots = [SLOTS_1V1[0], { ...SLOTS_1V1[1], connected: false, peerId: undefined }];
  env.room.onWelcome(welcomeFor(0, slots));
  assert.deepEqual(env.mesh.peers, [], 'nobody to connect to yet');
  env.mesh.connected = true; // an empty mesh is trivially "all connected"
  session.advance(0);
  assert.equal(env.room.sent.some((m) => m.type === 'ready'), false, 'not ready before any peer is in the mesh');
  assert.equal(session.remainingPeers(), 1, 'the absent peer may still join');
  env.room.onPeerJoined({ ...SLOTS_1V1[1] });
  assert.deepEqual(env.mesh.peers, [1]);
  session.advance(0);
  assert.equal(env.room.sent.filter((m) => m.type === 'ready').length, 1, 'ready once the joined peer is connected');
});

test('connecting: the other peer leaves before the start -> immediate server fallback; with others left, no fallback', async () => {
  const env = makeSession();
  const { session, client, game } = env;
  session.quickMatch('1v1');
  client.queued[0].resolve({ kind: 'p2p', roomId: 'room1', ticket: 'TICKET', wsUrl: '/room/room1' });
  await flush();
  env.room.onWelcome(welcomeFor(0, SLOTS_1V1));
  env.mesh.connected = true;
  session.advance(0);
  assert.equal(session.statusText, STATUS.readyWait);
  env.room.onPeerLeft(1, 'p1');
  assert.deepEqual(env.mesh.removed, [1]);
  assert.equal(session.remainingPeers(), 0);
  session.advance(0);
  assert.equal(session.state, 'idle', 'nobody left to play with: no 10 s wait');
  assert.deepEqual(game.log.at(-1), ['handover', '1v1', null, STATUS.nobodyLeft]);

  // 2v2 with three humans: one leaves, the other two can still start.
  const three = [
    { slot: 0, team: 0, name: 'Me', kind: 'peer', peerId: 'me', connected: true },
    { slot: 1, team: 0, name: 'Bot 2', kind: 'bot', connected: false },
    { slot: 2, team: 1, name: 'Ana', kind: 'peer', peerId: 'p2', connected: true },
    { slot: 3, team: 1, name: 'Bea', kind: 'peer', peerId: 'p3', connected: true },
  ];
  session.quickMatch('2v2');
  client.queued[1].resolve({ kind: 'p2p', roomId: 'room2', ticket: 'T2', wsUrl: '/room/room2' });
  await flush();
  env.room.onWelcome(welcomeFor(0, three));
  env.room.onPeerLeft(3, 'p3');
  assert.equal(session.remainingPeers(), 1);
  env.mesh.connected = true;
  session.advance(0);
  assert.equal(session.state, 'connecting');
  assert.equal(env.room.sent.filter((m) => m.type === 'ready').length, 1);
  env.room.onStart(env.t + 200, env.t);
  assert.equal(session.state, 'countdown');
});

test('connecting: ready sent but no start within 10 s of the welcome -> server fallback', async () => {
  const env = makeSession();
  const { session, client, game } = env;
  session.quickMatch('1v1');
  client.queued[0].resolve({ kind: 'p2p', roomId: 'room1', ticket: 'TICKET', wsUrl: '/room/room1' });
  await flush();
  env.room.onWelcome(welcomeFor(0, SLOTS_1V1));
  env.mesh.connected = true;
  session.advance(0);
  assert.equal(env.room.sent.filter((m) => m.type === 'ready').length, 1);
  env.t += FALLBACK_MS;
  session.advance(0);
  assert.equal(session.state, 'connecting');
  env.t += 1;
  session.advance(0);
  assert.equal(session.state, 'idle');
  assert.deepEqual(game.log.at(-1), ['handover', '1v1', null, STATUS.fallback]);
});

test('a dead link before the start is not reported (the fallback handles it); in the match it reports contiguousInputTick + 1; without a room it ends the match', async () => {
  const env = makeSession();
  const { session, client, game } = env;
  session.quickMatch('1v1');
  client.queued[0].resolve({ kind: 'p2p', roomId: 'room1', ticket: 'TICKET', wsUrl: '/room/room1' });
  await flush();
  env.room.onWelcome(welcomeFor(0, SLOTS_1V1));
  env.mesh.onPeerDead(1);
  assert.equal(session.peersDead, 1);
  assert.equal(env.room.sent.some((m) => m.type === 'unreachable'), false, 'connecting: no report');
  session.cancel();

  const env2 = await startedSession(SLOTS_1V1, 0);
  env2.engine.contiguousInputTick = (slot) => (slot === 1 ? 41 : 0);
  env2.t = env2.startAtLocal + 5 * TICK_MS + 1;
  env2.session.advance(0);
  env2.mesh.onPeerDead(1);
  assert.deepEqual(env2.room.sent.at(-1), { type: 'unreachable', slot: 1, atTick: 42 }, 'the first tick we have no input of it for');
  // The room socket dies while that drop is pending: nobody can coordinate it.
  env2.room.onClose(1006, '');
  assert.deepEqual(env2.game.log.at(-1), ['disconnected', STATUS.lostRoom]);

  const env3 = await startedSession(SLOTS_1V1, 0);
  env3.room.onClose(1006, '');
  assert.equal(env3.session.room, null, 'mid-match the match goes on without the room');
  assert.equal(env3.session.inMatch, true);
  env3.mesh.onPeerDead(1);
  assert.deepEqual(env3.game.log.at(-1), ['disconnected', STATUS.lostRoom]);
  void game;
});

test('welcome: out-of-range room parameters fall back to the defaults; a throwing engine factory fails to the menu with the offline roster back', async () => {
  const env = makeSession();
  const { session, client, game } = env;
  session.quickMatch('1v1');
  client.queued[0].resolve({ kind: 'p2p', roomId: 'room1', ticket: 'TICKET', wsUrl: '/room/room1' });
  await flush();
  env.room.onWelcome({ ...welcomeFor(0, SLOTS_1V1), window: 1000, inputDelay: -1, hashEvery: 0 });
  assert.equal(session.state, 'connecting');
  assert.deepEqual(env.engine.opts, { inputDelay: 3, window: 16, hashEvery: 30 });
  session.cancel();

  const env2 = makeSession();
  const bad = new P2PSession(env2.game, {
    client: env2.client,
    now: () => env2.t,
    engineFactory: () => {
      throw new Error('window 1000');
    },
    roomFactory: (opts) => (env2.room = new FakeRoom(opts)),
    meshFactory: (opts) => (env2.mesh = new FakeMesh(opts)),
  });
  bad.quickMatch('1v1');
  env2.client.queued[0].resolve({ kind: 'p2p', roomId: 'room1', ticket: 'TICKET', wsUrl: '/room/room1' });
  await flush();
  env2.room.onWelcome(welcomeFor(0, SLOTS_1V1));
  assert.equal(bad.state, 'idle');
  assert.equal(bad.statusText, 'The game engine failed: reload the page', 'the engine error goes to the console only');
  assert.deepEqual(env2.game.log.at(-1), ['restore'], 'the arena had been replaced: offline roster back');
  assert.ok(env2.room.disposed);
  void game;
});

// ---- the real engine, the real wasm, the real bots: two sessions cross-wired --------------------

const { RocketSim } = await import('../src/sim/RocketSimBridge.ts');
const { buildArenaMesh } = await import('../src/sim/arenaMesh.ts');
const { RollbackEngine } = await import('../src/net/p2p/Rollback.ts');

/** Game hooks over a real RocketSim: the roster from the welcome, scripted controls, event log. */
function realGame(sim, mesh, script) {
  return {
    sim,
    events: [],
    kickoffs: 0,
    applyP2PRoster(w) {
      sim.initArena(mesh);
      sim.createArena(120);
      for (const s of w.slots.slice().sort((a, b) => a.slot - b.slot)) sim.addCar(s.team === 1 ? T.Team.Red : T.Team.Blue, T.CarPreset.Standard);
      sim.resetKickoff(w.seed);
      sim.sync();
    },
    restoreOfflineRoster() {},
    p2pMatchOnScreen() {},
    p2pSampleInput(out) {
      script(out);
    },
    p2pAfterTick() {},
    afterRollback() {},
    p2pMatchEvent(e) {
      this.events.push(e.type);
    },
    p2pKickoffReset() {
      this.kickoffs++;
    },
    p2pSlotDropped() {},
    p2pHandover() {
      throw new Error('unexpected handover');
    },
    onSessionDisconnected(m) {
      throw new Error(`disconnected: ${m}`);
    },
  };
}

test('two sessions on the real RollbackEngine + wasm + BotTeams (2v2, 20 ms links): no desyncs, same confirmed match on both', async () => {
  const mesh = buildArenaMesh().physics;
  const simA = await RocketSim.load();
  const simB = await RocketSim.load();
  let t = 10_000;
  const now = () => t;
  const inbox = []; // { at, to: session index, kind, from, bytes }
  const sessions = [];
  const fakes = [];
  const LATENCY = 20;
  let tickA = 0;
  const scriptA = (out) => {
    tickA++;
    out.throttle = 1;
    out.steer = Math.floor(tickA / 60) % 2 === 0 ? 0.6 : -0.6;
    out.boost = tickA % 180 < 90;
    out.jump = tickA % 240 === 5;
  };
  const scriptB = (out) => {
    out.throttle = 1;
    out.steer = 0.2;
    out.boost = true;
  };
  for (let i = 0; i < 2; i++) {
    const sim = i === 0 ? simA : simB;
    const game = realGame(sim, mesh, i === 0 ? scriptA : scriptB);
    const fake = { room: null, mesh: null };
    fakes.push(fake);
    const session = new P2PSession(game, {
      client: new FakeClient(),
      now,
      engineFactory: (s, n, humans, me, hooks, opts) => new RollbackEngine(s, n, humans, me, hooks, opts),
      roomFactory: (o) => (fake.room = new FakeRoom(o)),
      meshFactory: (o) => {
        const m = new FakeMesh(o);
        m.sendGame = (slot, buf, len) => {
          inbox.push({ at: t + LATENCY, to: slot === 0 ? 0 : 1, kind: 'game', from: o.mySlot, bytes: Uint8Array.from(buf.subarray(0, len)) });
          m.bytesOut += len;
          return true;
        };
        m.sendCtl = (slot, buf, len) => {
          inbox.push({ at: t + LATENCY, to: slot === 0 ? 0 : 1, kind: 'ctl', from: o.mySlot, bytes: Uint8Array.from(buf.subarray(0, len)) });
          m.bytesOut += len;
          return true;
        };
        m.broadcastCtl = (buf, len) => {
          m.sendCtl(o.mySlot === 0 ? 2 : 0, buf, len);
          return 1;
        };
        fake.mesh = m;
        return m;
      },
    });
    sessions.push({ session, game });
  }
  const slots = [
    { slot: 0, team: 0, name: 'A', kind: 'peer', peerId: 'a', connected: true },
    { slot: 1, team: 0, name: 'Bot 2', kind: 'bot', connected: false },
    { slot: 2, team: 1, name: 'B', kind: 'peer', peerId: 'b', connected: true },
    { slot: 3, team: 1, name: 'Bot 2', kind: 'bot', connected: false },
  ];
  for (let i = 0; i < 2; i++) {
    const { session } = sessions[i];
    session.quickMatch('2v2');
    session.client.queued[0].resolve({ kind: 'p2p', roomId: 'r', ticket: 'T', wsUrl: '/room/r' });
  }
  await flush();
  const startAt = t + 100;
  for (let i = 0; i < 2; i++) {
    const { session } = sessions[i];
    fakes[i].room.onWelcome(welcomeFor(i === 0 ? 0 : 2, slots));
    assert.equal(session.state, 'connecting');
    fakes[i].mesh.connected = true;
    session.advance(0);
    fakes[i].room.onStart(startAt, t);
    assert.equal(session.state, 'countdown');
  }
  const deliver = () => {
    for (let k = 0; k < inbox.length; k++) {
      const m = inbox[k];
      if (m.at > t) continue;
      inbox.splice(k--, 1);
      const target = fakes[m.to].mesh;
      if (m.kind === 'game') target.onGame(m.from, m.bytes);
      else target.onCtl(m.from, m.bytes);
    }
  };
  const FRAME = 1000 / 60;
  const SECONDS = 6; // 3 s countdown + 3 s of play with the bots driving
  const frames = Math.ceil((SECONDS * 1000 + 100) / FRAME);
  const t0 = performance.now();
  for (let f = 0; f < frames; f++) {
    t += FRAME;
    deliver();
    sessions[f % 2].session.advance(FRAME / 1000);
    sessions[(f + 1) % 2].session.advance(FRAME / 1000);
  }
  const ms = performance.now() - t0;
  const [A, B] = sessions;
  const eA = A.session.engine;
  const eB = B.session.engine;
  assert.equal(A.session.state, 'playing');
  assert.equal(B.session.state, 'playing');
  assert.ok(eA.confirmedTick > 600 && eB.confirmedTick > 600, `confirmed ${eA.confirmedTick} / ${eB.confirmedTick}`);
  assert.equal(eA.stats.desyncs, 0, 'A: hash votes never disagreed');
  assert.equal(eB.stats.desyncs, 0, 'B: hash votes never disagreed');
  assert.equal(A.session.hashesDisagreed, 0);
  assert.equal(B.session.hashesDisagreed, 0);
  assert.ok(A.session.hashesAgreed >= 15 && B.session.hashesAgreed >= 15, `agreed ${A.session.hashesAgreed} / ${B.session.hashesAgreed}`);
  assert.equal(A.session.resyncs, 0);
  assert.equal(B.session.stateRequests, 0);
  assert.deepEqual(A.game.events.slice(0, 4), ['countdown', 'countdown', 'countdown', 'go'], 'the confirmed Match ran the countdown');
  assert.deepEqual(A.game.events, B.game.events, 'identical match flow on both peers');
  assert.deepEqual(A.session.score, B.session.score);
  assert.equal(A.session.match.phase, 'playing');
  assert.ok(Math.abs(A.session.displaySeconds - B.session.displaySeconds) <= 1);
  assert.equal(A.game.kickoffs, 1, 'tick 1 kickoff reset only (no goal in 3 s of play)');
  // The cars moved under the scripted inputs and the bots (the confirmed state is not the kickoff layout).
  const off = simA.carOffset(0);
  assert.ok(Math.abs(simA.buf[off + T.C_POS + 1]) > 100 || Math.abs(simA.buf[off + T.C_POS]) > 100, 'A drove somewhere');
  const sA = A.session.stats;
  A.session.advance(0);
  assert.equal(sA.kind, 'p2p');
  assert.equal(sA.p2pPeers, 1);
  assert.equal(sA.p2pPeerSlot[0], 2);
  console.log(
    `p2p 2v2 real engine: ${frames} frames in ${ms.toFixed(0)} ms, confirmed A ${eA.confirmedTick} B ${eB.confirmedTick}, ` +
      `rollbacks ${eA.stats.rollbacks}/${eB.stats.rollbacks}, resim ${eA.stats.resimTicks}/${eB.stats.resimTicks}, ` +
      `stalls ${A.session.stallFrames}/${B.session.stallFrames}, timesync ${A.session.timesyncSkips}/${B.session.timesyncSkips}, ` +
      `hashes agreed ${A.session.hashesAgreed}/${B.session.hashesAgreed}, mispred ${eA.stats.mispredictions}/${eB.stats.mispredictions}`,
  );
});

test('resync realigns Match + bots: a goal, then a corrupted peer (foreign sim state, tampered clock) rejoins the majority through the StateResponse trailer', async () => {
  const mesh = buildArenaMesh().physics;
  const simA = await RocketSim.load();
  const simB = await RocketSim.load();
  let t = 10_000;
  const now = () => t;
  const inbox = [];
  const sessions = [];
  const fakes = [];
  const LATENCY = 20;
  const SHOT_TICK = 400; // after the 3 s countdown: a shot into the red net on the confirmed timeline (both peers)
  const idle = (out) => {
    out.throttle = 0;
  };
  const slots = [
    { slot: 0, team: 0, name: 'A', kind: 'peer', peerId: 'a', connected: true },
    { slot: 1, team: 0, name: 'Bot 2', kind: 'bot', connected: false },
    { slot: 2, team: 1, name: 'B', kind: 'peer', peerId: 'b', connected: true },
    { slot: 3, team: 1, name: 'Bot 2', kind: 'bot', connected: false },
  ];
  for (let i = 0; i < 2; i++) {
    const sim = i === 0 ? simA : simB;
    const game = realGame(sim, mesh, idle);
    const fake = { room: null, mesh: null };
    fakes.push(fake);
    const session = new P2PSession(game, {
      client: new FakeClient(),
      now,
      engineFactory: (s, n, humans, me, hooks, opts) => {
        const shot = (tick, out) => {
          if (tick === SHOT_TICK) sim.setBallState([0, 4000, 93], [0, 2500, 0], [0, 0, 0]);
          hooks.botInputs(tick, out);
        };
        return new RollbackEngine(s, n, humans, me, { ...hooks, botInputs: shot }, opts);
      },
      roomFactory: (o) => (fake.room = new FakeRoom(o)),
      meshFactory: (o) => {
        const m = new FakeMesh(o);
        const push = (kind, slot, buf, len) => {
          inbox.push({ at: t + LATENCY, to: slot === 0 ? 0 : 1, kind, from: o.mySlot, bytes: Uint8Array.from(buf.subarray(0, len)) });
          m.bytesOut += len;
          return true;
        };
        m.sendGame = (slot, buf, len) => push('game', slot, buf, len);
        m.sendCtl = (slot, buf, len) => push('ctl', slot, buf, len);
        m.broadcastCtl = (buf, len) => {
          m.sendCtl(o.mySlot === 0 ? 2 : 0, buf, len);
          return 1;
        };
        fake.mesh = m;
        return m;
      },
    });
    sessions.push({ session, game });
  }
  for (let i = 0; i < 2; i++) {
    const { session } = sessions[i];
    session.quickMatch('2v2');
    session.client.queued[0].resolve({ kind: 'p2p', roomId: 'r', ticket: 'T', wsUrl: '/room/r' });
  }
  await flush();
  const startAt = t + 100;
  for (let i = 0; i < 2; i++) {
    const { session } = sessions[i];
    fakes[i].room.onWelcome(welcomeFor(i === 0 ? 0 : 2, slots));
    fakes[i].mesh.connected = true;
    session.advance(0);
    fakes[i].room.onStart(startAt, t);
  }
  const deliver = () => {
    for (let k = 0; k < inbox.length; k++) {
      const m = inbox[k];
      if (m.at > t) continue;
      inbox.splice(k--, 1);
      const target = fakes[m.to].mesh;
      if (m.kind === 'game') target.onGame(m.from, m.bytes);
      else target.onCtl(m.from, m.bytes);
    }
  };
  // A foreign state for the corruption: the same roster idling from the kickoff to B's confirmed tick.
  const other = await RocketSim.load();
  other.initArena(mesh);
  other.createArena(120);
  for (const s of slots) other.addCar(s.team === 1 ? T.Team.Red : T.Team.Blue, T.CarPreset.Standard);
  other.resetKickoff(4242);
  other.sync();
  const foreign = new Uint8Array(T.MAX_STATE_BYTES);
  const [A, B] = sessions;
  let corruptedAt = -1;
  let scoreAtCorruption = null;
  const FRAME = 1000 / 60;
  const frames = Math.ceil((11.5 * 1000 + 100) / FRAME);
  for (let f = 0; f < frames; f++) {
    t += FRAME;
    deliver();
    sessions[f % 2].session.advance(FRAME / 1000);
    sessions[(f + 1) % 2].session.advance(FRAME / 1000);
    const eB = B.session.engine;
    if (corruptedAt < 0 && eB.confirmedTick >= 500) {
      // During the goal pause: both count 1-0. B's Match clock is tampered (10 s off) and its
      // confirmed sim state is replaced by the foreign one at the same tick.
      assert.deepEqual(A.session.score, { blue: 1, red: 0 }, 'the shot scored on A');
      assert.deepEqual(B.session.score, { blue: 1, red: 0 }, 'the shot scored on B');
      scoreAtCorruption = { ...B.session.score };
      B.session.match.clock -= 10;
      const F = eB.confirmedTick;
      other.step(F - other.tickCount);
      other.sync();
      assert.equal(other.tickCount, F);
      const len = other.saveState(foreign);
      eB.resync(F, foreign, len);
      corruptedAt = F;
    }
  }
  const eA = A.session.engine;
  const eB = B.session.engine;
  console.log(
    `resync test: corrupted B at ${corruptedAt}; A desyncs ${eA.stats.desyncs} B desyncs ${eB.stats.desyncs}, B requests ${B.session.stateRequests} resyncs ${B.session.resyncs} ` +
      `restores ${B.session.checkpointRestores}, hashes A agreed/disagreed ${A.session.hashesAgreed}/${A.session.hashesDisagreed}, ` +
      `confirmed ${eA.confirmedTick}/${eB.confirmedTick}, kickoffs ${A.session.kickoffs}/${B.session.kickoffs}, clock ${A.session.match.clock.toFixed(2)}/${B.session.match.clock.toFixed(2)}`,
  );
  assert.ok(corruptedAt > 0, 'the corruption happened');
  assert.equal(A.session.state, 'playing');
  assert.equal(B.session.state, 'playing');
  assert.equal(eA.stats.desyncs, 0, 'A (the lower slot) is the reference of the tie: never minority');
  assert.equal(eB.stats.desyncs, 2, 'B: minority at the two hash ticks after the corruption, then repaired');
  assert.equal(B.session.stateRequests, 1);
  assert.equal(B.session.resyncs, 1, 'one resync from A');
  assert.ok(B.session.checkpointRestores >= 2, `own checkpoint at the corruption + the trailer at the repair (${B.session.checkpointRestores})`);
  assert.ok(A.session.hashesDisagreed >= 2 && A.session.hashesDisagreed <= 3, `A heard B's bad hashes (${A.session.hashesDisagreed})`);
  assert.ok(A.session.hashesAgreed >= 25, `agreement afterwards (${A.session.hashesAgreed})`);
  // Identical confirmed timelines after the repair: the last hash ticks both confirmed.
  const F = Math.min(eA.confirmedTick, eB.confirmedTick);
  let checked = 0;
  for (let tick = Math.floor(F / 30) * 30; tick > corruptedAt + 60 && checked < 8; tick -= 30) {
    assert.equal(eB.hashAt(tick), eA.hashAt(tick), `hash at ${tick}`);
    checked++;
  }
  assert.ok(checked >= 8, `${checked} hash ticks compared`);
  assert.ok(F > corruptedAt + 600, `played on after the repair (confirmed ${F})`);
  // Match + kickoffs + bots realigned from A's trailer: same score, same clock (the tamper is gone),
  // same kickoff count (seed + 1 after the goal), same phase, and the bots (driving since the
  // second kickoff) keep the hashes identical.
  assert.deepEqual(B.session.score, scoreAtCorruption);
  assert.deepEqual(A.session.score, B.session.score);
  assert.ok(Math.abs(A.session.match.clock - B.session.match.clock) < 0.05, `clocks ${A.session.match.clock} vs ${B.session.match.clock}`);
  assert.equal(A.session.match.phase, B.session.match.phase);
  assert.equal(A.session.kickoffs, 2, 'tick 1 kickoff + the one after the goal');
  assert.equal(B.session.kickoffs, 2);
  assert.deepEqual(A.game.events, B.game.events, 'identical match flow on both (no doubled goal)');
  assert.equal(A.game.events.filter((e) => e === 'goal').length, 1);
  assert.equal(A.game.kickoffs, 2);
  assert.equal(B.game.kickoffs, 2);
});

// ---- staggered joins, lock release, the room's non-fatal errors, the debug log ----------------

/** queue -> p2p room -> welcome as `mySlot` with `slots`; the session is left in 'connecting'. */
async function connectingSession(slots, mySlot = 0, mode = '1v1') {
  const env = makeSession();
  const { session, client } = env;
  session.quickMatch(mode);
  client.queued[0].resolve({ kind: 'p2p', roomId: 'room1', ticket: 'TICKET', wsUrl: '/room/room1' });
  await flush();
  env.room.onWelcome(welcomeFor(mySlot, slots));
  assert.equal(session.state, 'connecting');
  return env;
}

test('staggered join: the first joiner adds the peer on peerJoined (re-offer), the fallback window restarts from that join, and an un-joined slot is never "nobody left"', async () => {
  const absent = [SLOTS_1V1[0], { ...SLOTS_1V1[1], connected: false, peerId: undefined }];
  const env = await connectingSession(absent, 0);
  const { session, game } = env;
  assert.deepEqual(env.mesh.peers, [], 'the welcome lists slot 1 as not connected: nothing to negotiate yet');
  assert.equal(session.remainingPeers(), 1, 'slot 1 has not joined: it is still expected');
  // 8 s later still nobody: no fallback of either kind (the window is 10 s, the slot is not "left").
  env.t += 8000;
  session.advance(0);
  assert.equal(session.state, 'connecting');
  assert.equal(game.log.some((l) => l[0] === 'handover'), false, 'no nobodyLeft fallback for a slot that merely has not joined');
  // The peer joins 8 s after the welcome: the mesh gets it, the pending offer is re-sent, the window restarts.
  env.room.onPeerJoined({ ...SLOTS_1V1[1] });
  assert.deepEqual(env.mesh.peers, [1], 'addPeer on peerJoined (the lower slot offers)');
  assert.deepEqual(env.mesh.reoffered, [1], 'a pending offer to that slot is re-sent');
  assert.ok(session.log.has('fallback.restart'));
  env.t += FALLBACK_MS - 100; // 17.9 s after the welcome, 9.9 s after the join
  session.advance(0);
  assert.equal(session.state, 'connecting', 'the 10 s window counts from the last peerJoined, not from the welcome');
  env.t += 200;
  session.advance(0);
  assert.equal(session.state, 'idle', '10 s after the join without a mesh: fallback');
  assert.deepEqual(game.log.at(-1), ['handover', '1v1', null, STATUS.fallback]);
  assert.equal(env.client.leaves, 1, 'the room lock is released through POST /api/leave on the way out');
  assert.ok(session.log.has('handover'));
});

test('staggered join: the LOWER slot joining later offers on its own welcome (the other is connected); a peerJoined for a known peer only re-offers', async () => {
  const env = await connectingSession(SLOTS_1V1, 0);
  assert.deepEqual(env.mesh.peers, [1], 'slot 1 is connected in the welcome: addPeer at once (we are slot 0: we offer)');
  env.room.onPeerJoined({ ...SLOTS_1V1[1] }); // a duplicate join notice (e.g. its socket replaced)
  assert.deepEqual(env.mesh.peers, [1], 'addPeer is idempotent');
  assert.deepEqual(env.mesh.reoffered, [1]);
  env.mesh.connected = true;
  env.session.advance(0);
  assert.equal(env.room.sent.filter((m) => m.type === 'ready').length, 1);
});

test('a slot flagged `left` in the welcome counts as gone: alone with it -> immediate server fallback; with a live peer, no fallback', async () => {
  const leftSlots = [SLOTS_1V1[0], { ...SLOTS_1V1[1], connected: false, peerId: undefined, left: true }];
  const env = await connectingSession(leftSlots, 0);
  assert.equal(env.session.remainingPeers(), 0);
  env.session.advance(0);
  assert.equal(env.session.state, 'idle');
  assert.deepEqual(env.game.log.at(-1), ['handover', '1v1', null, STATUS.nobodyLeft]);

  const three = [
    { slot: 0, team: 0, name: 'Me', kind: 'peer', peerId: 'me', connected: true },
    { slot: 1, team: 0, name: 'Bot 2', kind: 'bot', connected: false },
    { slot: 2, team: 1, name: 'Ana', kind: 'peer', peerId: 'p2', connected: true },
    { slot: 3, team: 1, name: 'Bea', kind: 'peer', connected: false, left: true },
  ];
  const env2 = await connectingSession(three, 0, '2v2');
  assert.equal(env2.session.remainingPeers(), 1, 'Bea left, Ana is there');
  assert.deepEqual(env2.mesh.peers, [2]);
  env2.mesh.connected = true;
  env2.session.advance(0);
  assert.equal(env2.session.state, 'connecting');
  assert.equal(env2.room.sent.filter((m) => m.type === 'ready').length, 1, 'ready with Ana alone');
});

test('leaving a room releases the lock (POST /api/leave) on fallback, leave, cancel and failure; a queue cancel before any room does not', async () => {
  // cancel while queueing: nothing to release (cancelQueue already leaves the queue)
  const q = makeSession();
  q.session.quickMatch('1v1');
  q.session.cancel();
  assert.equal(q.client.leaves, 0);
  assert.equal(q.client.cancelled, 1);
  // cancel while connecting
  const c = await connectingSession(SLOTS_1V1, 0);
  c.session.cancel();
  assert.equal(c.client.leaves, 1);
  assert.ok(c.room.disposed && c.mesh.closed);
  // a room error before the start (fail)
  const f = await connectingSession(SLOTS_1V1, 0);
  f.room.onError('bad', 'room says no');
  assert.equal(f.session.state, 'idle');
  assert.equal(f.session.error, 'room says no', 'the code goes to the console only');
  assert.equal(f.client.leaves, 1);
  // leave after the start (the final whistle / menu)
  const s = await startedSession();
  s.session.leave();
  assert.equal(s.client.leaves, 1);
  assert.equal(s.session.state, 'idle');
  // the other peer leaves before the start: fallback releases too
  const n = await connectingSession(SLOTS_1V1, 0);
  n.room.onPeerLeft(1, 'p1');
  n.session.advance(0);
  assert.equal(n.session.state, 'idle');
  assert.equal(n.client.leaves, 1);
});

test("the room's 'signal_dropped' error goes to the mesh (re-offer bookkeeping) and never fails the session; other errors still do", async () => {
  const env = await connectingSession(SLOTS_1V1, 0);
  assert.equal(typeof env.room.onSignalDropped, 'function', 'the session wires onSignalDropped');
  env.room.onSignalDropped(1);
  assert.equal(env.session.state, 'connecting');
  assert.deepEqual(env.mesh.dropped, [1]);
  env.room.onError('rate', 'too fast');
  assert.equal(env.session.state, 'idle');
  assert.equal(env.session.error, 'too fast', 'the code goes to the console only');
});

test('debug log: queue result, state changes, welcome, ready, start, drop and leave are recorded; lines() formats them oldest first', async () => {
  const env = await startedSession();
  const { session } = env;
  env.room.onDrop(1, 500);
  session.leave();
  const log = session.log;
  for (const ev of ['state', 'queue.result', 'ready', 'start', 'drop', 'leave', 'release']) assert.ok(log.has(ev), `log has '${ev}'`);
  const lines = log.lines();
  assert.equal(lines.length, log.length);
  assert.ok(lines.length < 60, `a whole session is a few dozen lines (${lines.length})`);
  assert.match(lines[0], /^\d+\.\d{3} #0 state idle -> queue \(quickMatch 1v1\)$/);
  assert.ok(lines.some((l) => /queue\.result p2p room room1/.test(l)));
  assert.ok(lines.some((l) => /state countdown -> idle \(leave\)|state connecting -> countdown/.test(l)));
  assert.deepEqual(JSON.parse(JSON.stringify(log)), lines, 'toJSON gives the same lines');
  assert.equal(log.text(), lines.join('\n'));
});

test('RoomClient: an error with code signal_dropped is routed to onSignalDropped (with the target slot), not to onError', () => {
  const log = [];
  const sent = [];
  const makeWs = () => ({
    binaryType: 'blob',
    readyState: 1,
    protocol: 'tg1',
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: (d) => sent.push(JSON.parse(d)),
    close() {
      this.readyState = 3;
    },
  });
  const rc = new RoomClient({ webSocketFactory: makeWs, now: () => 0, pingIntervalMs: 1e9, log: { push: (e, d) => log.push([e, d ?? '']) } });
  const errors = [];
  const dropped = [];
  rc.onError = (c, m) => errors.push([c, m]);
  rc.onSignalDropped = (to) => dropped.push(to);
  rc.connect('ws://x/room/r', 'T');
  const ws = rc.ws;
  ws.onopen({});
  ws.onmessage({ data: JSON.stringify({ type: 'error', code: 'signal_dropped', message: 'slot 1 has no socket', to: 1 }) });
  assert.deepEqual(dropped, [1]);
  assert.deepEqual(errors, []);
  ws.onmessage({ data: JSON.stringify({ type: 'error', code: 'rate', message: 'too fast' }) });
  assert.deepEqual(errors, [['rate', 'too fast']]);
  rc.signal(1, { sdp: { type: 'offer', sdp: 'x' } });
  assert.equal(sent.filter((m) => m.type === 'signal').length, 1);
  assert.ok(log.some(([e, d]) => e === 'room.sig.dropped' && d === 'to 1'), 'logged');
  assert.ok(log.some(([e]) => e === 'room.error'));
  assert.ok(log.some(([e, d]) => e === 'room.connect' && d === 'ws://x/room/r'));
  rc.dispose();
});


// ---- 2v2 / 3v3 staggered joins: ready only with every expected human, the room's no-show path ----

const SLOTS_2V2_THREE = [
  { slot: 0, team: 0, name: 'Me', kind: 'peer', peerId: 'me', connected: true },
  { slot: 1, team: 0, name: 'Bot 2', kind: 'bot', connected: false },
  { slot: 2, team: 1, name: 'Ana', kind: 'peer', peerId: 'p2', connected: true },
  { slot: 3, team: 1, name: 'Bea', kind: 'peer', connected: false },
];

test("2v2 staggered join: one peer connected and one absent (not left) -> no 'ready' until the absent one joins and connects", async () => {
  const env = await connectingSession(SLOTS_2V2_THREE, 0, '2v2');
  const { session } = env;
  assert.deepEqual(env.mesh.peers, [2], 'only Ana is there to negotiate with');
  assert.equal(session.remainingPeers(), 2, 'Bea has not joined: still expected');
  env.mesh.connected = true; // the link to Ana is complete
  session.advance(0);
  assert.equal(env.room.sent.some((m) => m.type === 'ready'), false, 'the mesh with Ana alone is not the whole room: no ready (it could not be taken back)');
  assert.equal(session.statusText, connectingStatus(1, 2), 'the status counts the absent peer');
  env.t += 2000;
  session.advance(0);
  assert.equal(env.room.sent.some((m) => m.type === 'ready'), false, 'still waiting for Bea 2 s later');
  // Bea joins: the mesh gets her (negotiating: not connected yet).
  env.mesh.connected = false;
  env.room.onPeerJoined({ ...SLOTS_2V2_THREE[3], peerId: 'p3', connected: true });
  assert.deepEqual(env.mesh.peers, [2, 3]);
  session.advance(0);
  assert.equal(env.room.sent.some((m) => m.type === 'ready'), false, 'Bea is in the mesh but not connected yet');
  env.mesh.connected = true;
  session.advance(0);
  assert.equal(env.room.sent.filter((m) => m.type === 'ready').length, 1, 'ready once every expected human is connected');
  assert.equal(session.statusText, STATUS.readyWait);
  assert.ok(session.log.lines().some((l) => /ready mesh complete \(2 of 2 peers\)/.test(l)));
});

test('no-show: the room declares the absent slot left -> ready with the present peers, fallback window restarted; start + drop { slot, 0 } -> the team AI owns it from the first tick', async () => {
  const env = await connectingSession(SLOTS_2V2_THREE, 0, '2v2');
  const { session, game } = env;
  env.mesh.connected = true;
  session.advance(0);
  assert.equal(env.room.sent.some((m) => m.type === 'ready'), false);
  // The room's no-show pass (P2P_NO_SHOW_MS after the room was created): peerLeft with an empty peerId.
  env.t += P.P2P_NO_SHOW_MS;
  env.room.onPeerLeft(3, '');
  assert.equal(session.remainingPeers(), 1);
  assert.deepEqual(env.mesh.removed, [3], 'removePeer of a slot the mesh never had (a no-op in the real mesh)');
  session.advance(0);
  assert.equal(env.room.sent.filter((m) => m.type === 'ready').length, 1, 'ready with Ana: Bea is gone for good');
  assert.equal(session.state, 'connecting');
  assert.ok(session.log.has('peerLeft'));
  // The window restarted at the peerLeft: no fallback 9.9 s later (16 s after the welcome).
  env.t += FALLBACK_MS - 100;
  session.advance(0);
  assert.equal(session.state, 'connecting', 'the peerLeft restarted the FALLBACK_MS window');
  // The room starts and drops the no-show at tick 0, right after the start (same socket, in order).
  env.room.onStart(env.t + 1500, env.t);
  assert.equal(session.state, 'countdown');
  env.room.onDrop(3, 0);
  const engine = env.engine;
  assert.deepEqual(engine.humanSlots, [0, 2, 3], 'the engine was built with Bea as a human slot');
  assert.deepEqual(engine.drops, [{ slot: 3, atTick: 0 }], 'every peer gets the same drop tick 0');
  assert.deepEqual(game.log.at(-1), ['dropped', 3, 'Bea']);
  // From the first confirmed tick the BotTeam drives slot 3 (frozen countdown: zeroed, but a bot).
  assert.equal(session.isBotSlot(3), false, 'nothing confirmed yet');
  engine.hooks.botInputs(1, new Int8Array(4 * PACKED_INPUT_BYTES));
  assert.deepEqual([0, 1, 2, 3].map((s) => session.isBotSlot(s)), [false, true, false, true], 'Bea is a bot from tick 1 on');
});

test('the fallback window outlasts the room no-show grace with a margin for the ready / start round trip', () => {
  assert.equal(SESSION.FALLBACK_MARGIN_MS, FALLBACK_MS - P.P2P_NO_SHOW_MS);
  assert.ok(SESSION.FALLBACK_MARGIN_MS >= 3000, `FALLBACK_MS ${FALLBACK_MS} vs no-show ${P.P2P_NO_SHOW_MS}`);
});

test('queue refusals with a server code get a clear menu line: 429 no_show (retryAfterMs), 426 reload_required, 503 capacity; without one a generic line', async () => {
  const env = makeSession();
  const { session, client } = env;
  const unit = (n, u) => new Intl.NumberFormat('en', { style: 'unit', unit: u, unitDisplay: 'short' }).format(n);
  session.quickMatch('1v1');
  client.queued[0].reject(new NetError('http', 'queue failed (429 no_show: 3 room tickets)', 429, { code: 'no_show', message: '3 room tickets', retryAfterMs: 299_500 }));
  await flush();
  assert.equal(session.state, 'idle');
  assert.equal(session.statusText, SESSION.noShowStatus(299_500));
  assert.match(session.statusText, new RegExp(`^P2P matches locked for ${unit(5, 'minute')}:`));
  assert.equal(session.statusIsError, true);
  assert.match(SESSION.noShowStatus(42_100), new RegExp(`locked for ${unit(43, 'second')}:`));
  assert.match(SESSION.noShowStatus(90_000), new RegExp(`locked for ${unit(90, 'second')}:`), 'seconds below two minutes');
  session.quickMatch('1v1');
  client.queued[1].reject(new NetError('http', 'queue failed (426 reload_required: reload)', 426, { code: 'reload_required', message: 'reload the page', retryAfterMs: 0 }));
  await flush();
  assert.equal(session.statusText, STATUS.reload);
  session.quickMatch('1v1');
  client.queued[2].reject(new NetError('http', 'queue failed (503 capacity: all rooms are busy, try again in a minute)', 503, { code: 'capacity', message: 'all rooms are busy, try again in a minute', retryAfterMs: 0 }));
  await flush();
  assert.equal(session.statusText, 'All servers are busy, try again in a minute');
  // Without a server code: the generic line for the kind of failure, never the developer message.
  session.quickMatch('1v1');
  client.queued[3].reject(new NetError('http', 'queue failed (503)', 503));
  await flush();
  assert.equal(session.statusText, 'Server error');
  session.quickMatch('1v1');
  client.queued[4].reject(new NetError('network', 'queue request failed: TypeError: fetch failed'));
  await flush();
  assert.equal(session.statusText, 'No connection to the server');
  assert.ok(session.log.text().includes('queue request failed'), 'the debug log keeps the developer message');
});

test("a welcome of another P2P protocol: RoomClient fails with 'reload_required' and the session shows STATUS.reload", async () => {
  const errors = [];
  const makeWs = () => ({
    binaryType: 'blob',
    readyState: 1,
    protocol: 'tg1',
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send() {},
    close() {
      this.readyState = 3;
    },
  });
  const rc = new RoomClient({ webSocketFactory: makeWs, now: () => 0, pingIntervalMs: 1e9 });
  rc.onError = (c, m) => errors.push([c, m]);
  rc.connect('ws://x/room/r', 'T');
  const ws = rc.ws;
  ws.onopen({});
  ws.onmessage({ data: JSON.stringify({ ...welcomeFor(0, SLOTS_1V1), protocol: P.P2P_PROTOCOL_VERSION + 1 }) });
  assert.deepEqual(errors, [[P.P2P_ERROR_RELOAD, `room protocol ${P.P2P_PROTOCOL_VERSION + 1} (client ${P.P2P_PROTOCOL_VERSION})`]]);
  assert.equal(rc.welcome, null);
  rc.dispose();

  const env = makeSession();
  env.session.quickMatch('1v1');
  env.client.queued[0].resolve({ kind: 'p2p', roomId: 'room1', ticket: 'TICKET', wsUrl: '/room/room1' });
  await flush();
  env.room.onError(P.P2P_ERROR_RELOAD, 'room protocol 3 (client 2)');
  assert.equal(env.session.state, 'idle');
  assert.equal(env.session.statusText, STATUS.reload);
  assert.equal(env.client.leaves, 1, 'the room lock is released on the way out');
});

// ---- experimental rules (a custom lobby's RoomWelcome.physics) ----------------------------------

const MUT = await import('../src/sim/mutators.ts');
const LAYOUT = await import('../src/sim/mutatorLayout.ts');
const { STOCK_BOT_PHYSICS } = await import('../src/ai/math.ts');
const RULES_LOW = { v: 1, name: 'Low gravity', values: { gravity: 50, ballDrag: 50 } };

/** A RoomClient on a scripted socket (as in the clock test): `deliver(msg)` feeds one frame. */
function scriptedRoomClient() {
  const sent = [];
  let socket = null;
  const client = new RoomClient({
    now: () => 10_000,
    pingIntervalMs: 1_000_000,
    webSocketFactory: (url, protocols) => {
      socket = { url, protocols, binaryType: 'blob', readyState: 0, protocol: '', onopen: null, onmessage: null, onclose: null, onerror: null, send: (d) => sent.push(JSON.parse(d)), close() {} };
      return socket;
    },
  });
  const welcomes = [];
  const errors = [];
  client.onWelcome = (w) => welcomes.push(w);
  client.onError = (code) => errors.push(code);
  client.connect('/room/r1', 'TK');
  socket.readyState = 1;
  socket.onopen({});
  return { client, sent, welcomes, errors, deliver: (m) => socket.onmessage({ data: JSON.stringify(m) }) };
}

test('RoomClient: the welcome must carry rules this build reads (strict); they arrive parsed, standard as null; ready(fp) sends the fingerprint', () => {
  // No `physics` at all (a room of another build): refused, never handed on.
  let r = scriptedRoomClient();
  const missing = welcomeFor(0, SLOTS_1V1);
  delete missing.physics;
  r.deliver(missing);
  assert.deepEqual(r.errors, [P.P2P_ERROR_BAD_PHYSICS]);
  assert.equal(r.welcomes.length, 0);
  assert.equal(r.client.welcome, null);
  // Rules this build does not read: a free-play key, an off-grid value, another table version.
  for (const bad of [{ ...RULES_LOW, values: { gameSpeed: 50 } }, { ...RULES_LOW, values: { gravity: 55 } }, { ...RULES_LOW, v: 2 }, 'Low gravity']) {
    r = scriptedRoomClient();
    r.deliver({ ...welcomeFor(0, SLOTS_1V1), physics: bad });
    assert.deepEqual(r.errors, [P.P2P_ERROR_BAD_PHYSICS], JSON.stringify(bad));
    assert.equal(r.welcomes.length, 0);
  }
  // Good rules arrive in the canonical form; a snapshot that changes nothing is standard (null).
  r = scriptedRoomClient();
  r.deliver({ ...welcomeFor(0, SLOTS_1V1), physics: { v: 1, name: 'Low gravity', values: { ballDrag: 50, gravity: 50, ballHit: 100 } } });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.welcomes[0].physics, RULES_LOW);
  assert.deepEqual(r.client.welcome.physics, RULES_LOW);
  r = scriptedRoomClient();
  r.deliver({ ...welcomeFor(0, SLOTS_1V1), physics: { v: 1, name: 'Standard', values: {} } });
  assert.equal(r.welcomes[0].physics, null);
  r.client.ready(MUT.physicsFingerprint(RULES_LOW));
  assert.deepEqual(r.sent.at(-1), { type: 'ready', physicsFp: MUT.physicsFingerprint(RULES_LOW) });
  r.client.ready();
  assert.deepEqual(r.sent.at(-1), { type: 'ready' }, 'none without one');
});

/** A session in an experimental lobby room (joinAssigned), welcomed with `physics`; the sim reads back `arenaRules`' mutators. */
function experimentalSession(physics, arenaRules = physics, slots = SLOTS_1V1) {
  const env = makeSession();
  const { session, game, sim } = env;
  sim.getMutators = (out) => {
    out.set(MUT.toMutators(arenaRules === null ? {} : arenaRules.values));
    return out;
  };
  env.failed = [];
  game.p2pFailed = (m) => env.failed.push(m);
  const apply = game.applyP2PRoster;
  game.applyP2PRoster = function (w) {
    this.log.push(['rules', w.physics]);
    apply.call(this, w);
  };
  env.room = null;
  session.joinAssigned(slots.length === 2 ? '1v1' : '2v2', { kind: 'p2p', roomId: 'room1', ticket: 'TICKET', wsUrl: '/room/room1' });
  env.room.onWelcome({ ...welcomeFor(0, slots), physics });
  return env;
}

test('an experimental room: the arena gets the rules, both BotTeams their physics profile, ready carries the arena fingerprint', () => {
  const env = experimentalSession(RULES_LOW);
  const { session, game } = env;
  assert.equal(session.state, 'connecting');
  assert.deepEqual(game.log.find((l) => l[0] === 'rules'), ['rules', RULES_LOW], 'applyP2PRoster gets the room rules');
  assert.equal(session.experimental, true);
  assert.deepEqual(session.rules, RULES_LOW);
  const profile = MUT.botPhysicsOf(RULES_LOW.values);
  assert.deepEqual(session['blueTeam'].physics, profile, 'blue bots plan with the rules');
  assert.deepEqual(session['redTeam'].physics, profile, 'red bots too');
  assert.equal(session['blueTeam'].physics.gravity, -325);
  env.mesh.connected = true;
  session.advance(0);
  assert.deepEqual(env.room.sent.filter((m) => m.type === 'ready'), [{ type: 'ready', physicsFp: MUT.physicsFingerprint(RULES_LOW) }]);
  // A standard room: the stock profile, the stock fingerprint.
  const plain = experimentalSession(null);
  assert.equal(plain.session.experimental, false);
  assert.equal(plain.session['blueTeam'].physics, STOCK_BOT_PHYSICS, 'the stock profile object itself');
  plain.mesh.connected = true;
  plain.session.advance(0);
  assert.deepEqual(plain.room.sent.filter((m) => m.type === 'ready'), [{ type: 'ready', physicsFp: MUT.physicsFingerprint(null) }]);
});

test('an experimental room has no server fallback: a mesh that never completes, or everybody else gone before the start, fails back to the lobby (lock released, nothing handed over)', () => {
  let env = experimentalSession(RULES_LOW);
  env.session.advance(0);
  env.t += FALLBACK_MS + 1;
  env.session.advance(0);
  assert.equal(env.session.state, 'idle');
  assert.equal(env.session.error, STATUS.experimentalFailed);
  assert.equal(env.game.log.filter((l) => l[0] === 'handover').length, 0, 'never a casual server match');
  assert.deepEqual(env.game.log.at(-1), ['restore'], 'the offline roster (stock arena) is back');
  assert.deepEqual(env.failed, [STATUS.experimentalFailed], 'the Game takes the member back to its lobby');
  assert.equal(env.client.leaves, 1, 'the room lock is released');
  assert.equal(env.session.rules, null);

  env = experimentalSession(RULES_LOW);
  env.mesh.connected = true;
  env.session.advance(0);
  env.room.onPeerLeft(1, 'p1');
  env.session.advance(0);
  assert.equal(env.session.state, 'idle');
  assert.equal(env.session.error, STATUS.experimentalFailed);
  assert.equal(env.game.log.filter((l) => l[0] === 'handover').length, 0);
});

test("a lobby's room with standard rules never falls back to the public queue: a mesh that fails (or everybody else gone) goes back to the lobby; a quick match's still hands over", async () => {
  let env = experimentalSession(null);
  env.session.advance(0);
  env.t += FALLBACK_MS + 1;
  env.session.advance(0);
  assert.equal(env.session.state, 'idle');
  assert.equal(env.session.error, STATUS.lobbyFailed);
  assert.equal(env.game.log.filter((l) => l[0] === 'handover').length, 0, 'never the Casual server queue');
  assert.deepEqual(env.failed, [STATUS.lobbyFailed], 'the Game takes the member back to its lobby');
  assert.equal(env.client.leaves, 1, 'the room lock is released');
  assert.ok(env.session.log.has('handover.refused'));
  env = experimentalSession(null);
  env.mesh.connected = true;
  env.session.advance(0);
  env.room.onPeerLeft(1, 'p1');
  env.session.advance(0);
  assert.equal(env.session.error, STATUS.lobbyFailed);
  assert.equal(env.game.log.filter((l) => l[0] === 'handover').length, 0);
  // The same session, then a quick match: its fallback still hands over (the lobby room's rule went with it).
  const { session, client, game } = env;
  session.quickMatch('1v1');
  client.queued.at(-1).resolve({ kind: 'p2p', roomId: 'room2', ticket: 'T2', wsUrl: '/room/room2' });
  await flush();
  env.room.onWelcome(welcomeFor(0, SLOTS_1V1));
  session.advance(0);
  env.t += FALLBACK_MS + 1;
  session.advance(0);
  assert.deepEqual(game.log.at(-1), ['handover', '1v1', null, STATUS.fallback]);
});

test("the room's physics_mismatch fails the session with its own line; a welcome the client cannot read says reload", () => {
  const env = experimentalSession(RULES_LOW, null); // this page's arena would run the stock physics
  env.mesh.connected = true;
  env.session.advance(0);
  assert.equal(env.room.sent.at(-1).physicsFp, MUT.physicsFingerprint(null), 'what the wasm read back, not what the room asked for');
  env.room.onError(P.ROOM_ERROR_PHYSICS_MISMATCH, "your arena does not run this room's rules");
  assert.equal(env.session.state, 'idle');
  assert.equal(env.session.error, STATUS.physicsMismatch);
  assert.deepEqual(env.failed, [STATUS.physicsMismatch]);
  const e2 = makeSession();
  e2.session.joinAssigned('1v1', { kind: 'p2p', roomId: 'room1', ticket: 'T', wsUrl: '/room/room1' });
  e2.room.onError(P.P2P_ERROR_BAD_PHYSICS, 'room rules this page cannot read');
  assert.equal(e2.session.error, STATUS.reload);
});

test('a roster the Game cannot build (the wasm refused the rules: its arena is gone) fails the session and rebuilds the offline roster', () => {
  const env = makeSession();
  const { session, game } = env;
  env.failed = [];
  game.p2pFailed = (m) => env.failed.push(m);
  game.applyP2PRoster = function () {
    this.log.push(['roster-throws']);
    throw new Error('rs_set_mutators failed with code 1');
  };
  session.joinAssigned('1v1', { kind: 'p2p', roomId: 'room1', ticket: 'T', wsUrl: '/room/room1' });
  env.room.onWelcome({ ...welcomeFor(0, SLOTS_1V1), physics: RULES_LOW });
  assert.equal(session.state, 'idle');
  assert.match(session.error, /^Roster: /);
  assert.deepEqual(game.log.slice(-2), [['roster-throws'], ['restore']], 'never left without an arena');
  assert.equal(env.failed.length, 1, 'back to the lobby');
  assert.equal(session.rules, null);
});

/** Game hooks over a real RocketSim that build the arena with the room's rules (as Game.applyP2PRoster does). */
function realRulesGame(sim, mesh, script) {
  const g = realGame(sim, mesh, script);
  g.applyP2PRoster = (w) => {
    sim.initArena(mesh);
    sim.createArena(120, MUT.arenaMutators(w.physics));
    for (const s of w.slots.slice().sort((a, b) => a.slot - b.slot)) sim.addCar(s.team === 1 ? T.Team.Red : T.Team.Blue, T.CarPreset.Standard);
    sim.resetKickoff(w.seed);
    sim.sync();
  };
  return g;
}

test('kickoffSeedOf: the room seed plus n as a non-negative int31 (the wasm deals random spots for a negative int), the same on every peer', async () => {
  const { kickoffSeedOf } = SESSION;
  assert.equal(kickoffSeedOf(4242, 0), 4242, 'a seed below 2^31 deals as before');
  assert.equal(kickoffSeedOf(4242, 3), 4245);
  for (const seed of [2147483647, 2147483648, 2446418727, 4294967295]) {
    for (let n = 0; n < 40; n++) {
      const k = kickoffSeedOf(seed, n);
      assert.ok(Number.isInteger(k) && k >= 0 && k <= 0x7fffffff, `${seed} + ${n} -> ${k}`);
    }
  }
  // Two arenas dealt with a big room seed hold the same state (a raw negative int would be random).
  const mesh = buildArenaMesh().physics;
  const hashes = [];
  for (let i = 0; i < 2; i++) {
    const sim = await RocketSim.load();
    sim.initArena(mesh);
    sim.createArena(120);
    for (let c = 0; c < 4; c++) sim.addCar(c < 2 ? T.Team.Blue : T.Team.Red, T.CarPreset.Standard);
    sim.resetKickoff(kickoffSeedOf(2446418727, 0));
    sim.step(30);
    hashes.push(sim.stateHash());
  }
  assert.equal(hashes[0], hashes[1]);
});

test('two sessions on the real RollbackEngine + wasm + BotTeams with experimental rules (2v2, 20 ms links): both arenas run the rules, the same fingerprint goes out, no desyncs, the same match', async () => {
  const rules = { v: 1, name: 'Arcade moon', values: { gravity: 50, ballBounce: 150, carMaxSpeed: 2600, boostPower: 130, boostUse: 0, spawnBoost: 100, unlimitedFlips: 1, bumpForce: 150 } };
  const mesh = buildArenaMesh().physics;
  const sims = [await RocketSim.load(), await RocketSim.load()];
  let t = 10_000;
  const inbox = [];
  const sessions = [];
  const fakes = [];
  const LATENCY = 20;
  let tickA = 0;
  const scripts = [
    (out) => {
      tickA++;
      out.throttle = 1;
      out.steer = Math.floor(tickA / 60) % 2 === 0 ? 0.6 : -0.6;
      out.boost = tickA % 180 < 90;
      out.jump = tickA % 240 === 5;
    },
    (out) => {
      out.throttle = 1;
      out.steer = 0.2;
      out.boost = true;
    },
  ];
  for (let i = 0; i < 2; i++) {
    const game = realRulesGame(sims[i], mesh, scripts[i]);
    const fake = { room: null, mesh: null };
    fakes.push(fake);
    const session = new P2PSession(game, {
      client: new FakeClient(),
      now: () => t,
      engineFactory: (s, n, humans, me, hooks, opts) => new RollbackEngine(s, n, humans, me, hooks, opts),
      roomFactory: (o) => {
        fake.room = new FakeRoom(o);
        fake.room.ready = (fp) => {
          fake.room.sent.push({ type: 'ready', physicsFp: fp });
          return true;
        };
        return fake.room;
      },
      meshFactory: (o) => {
        const m = new FakeMesh(o);
        m.sendGame = (slot, buf, len) => {
          inbox.push({ at: t + LATENCY, to: slot === 0 ? 0 : 1, kind: 'game', from: o.mySlot, bytes: Uint8Array.from(buf.subarray(0, len)) });
          return true;
        };
        m.sendCtl = (slot, buf, len) => {
          inbox.push({ at: t + LATENCY, to: slot === 0 ? 0 : 1, kind: 'ctl', from: o.mySlot, bytes: Uint8Array.from(buf.subarray(0, len)) });
          return true;
        };
        m.broadcastCtl = (buf, len) => {
          m.sendCtl(o.mySlot === 0 ? 2 : 0, buf, len);
          return 1;
        };
        fake.mesh = m;
        return m;
      },
    });
    sessions.push({ session, game });
  }
  const slots = [
    { slot: 0, team: 0, name: 'A', kind: 'peer', peerId: 'a', connected: true },
    { slot: 1, team: 0, name: 'Bot 2', kind: 'bot', connected: false },
    { slot: 2, team: 1, name: 'B', kind: 'peer', peerId: 'b', connected: true },
    { slot: 3, team: 1, name: 'Bot 2', kind: 'bot', connected: false },
  ];
  for (let i = 0; i < 2; i++) sessions[i].session.joinAssigned('2v2', { kind: 'p2p', roomId: 'r', ticket: 'T', wsUrl: '/room/r' });
  const startAt = t + 100;
  for (let i = 0; i < 2; i++) {
    const { session } = sessions[i];
    // A room seed from 2^31 up: every peer must deal the same kickoff (kickoffSeedOf).
    fakes[i].room.onWelcome({ ...welcomeFor(i === 0 ? 0 : 2, slots), seed: 2446418727, physics: rules });
    assert.equal(session.state, 'connecting');
    fakes[i].mesh.connected = true;
    session.advance(0);
    fakes[i].room.onStart(startAt, t);
  }
  // Both arenas read back exactly the rules' layout, and both peers said so to the room.
  const want = MUT.toMutators(rules.values);
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(Array.from(sims[i].getMutators()), Array.from(want), `peer ${i}: the arena runs the rules`);
    assert.deepEqual(fakes[i].room.sent.filter((m) => m.type === 'ready'), [{ type: 'ready', physicsFp: MUT.physicsFingerprint(rules) }]);
  }
  assert.equal(sims[0].getMutators()[LAYOUT.M_GRAVITY_Z], Math.fround(-325));
  const deliver = () => {
    for (let k = 0; k < inbox.length; k++) {
      const m = inbox[k];
      if (m.at > t) continue;
      inbox.splice(k--, 1);
      const target = fakes[m.to].mesh;
      if (m.kind === 'game') target.onGame(m.from, m.bytes);
      else target.onCtl(m.from, m.bytes);
    }
  };
  const FRAME = 1000 / 60;
  const frames = Math.ceil((6 * 1000 + 100) / FRAME); // 3 s countdown + 3 s of play
  for (let f = 0; f < frames; f++) {
    t += FRAME;
    deliver();
    sessions[f % 2].session.advance(FRAME / 1000);
    sessions[(f + 1) % 2].session.advance(FRAME / 1000);
  }
  const [A, B] = sessions;
  assert.equal(A.session.state, 'playing');
  assert.equal(B.session.state, 'playing');
  assert.ok(A.session.engine.confirmedTick > 600 && B.session.engine.confirmedTick > 600);
  assert.equal(A.session.engine.stats.desyncs + B.session.engine.stats.desyncs, 0, 'the hash votes never disagreed');
  assert.equal(A.session.hashesDisagreed + B.session.hashesDisagreed, 0);
  assert.ok(A.session.hashesAgreed >= 15 && B.session.hashesAgreed >= 15, `agreed ${A.session.hashesAgreed} / ${B.session.hashesAgreed}`);
  assert.deepEqual(A.game.events, B.game.events, 'identical match flow');
  assert.deepEqual(A.session.score, B.session.score);
  // The kickoff boost follows the rules (spawnBoost 100): the bots' cars start full. Boost use 0: never drops.
  const boost = sims[0].buf[sims[0].carOffset(1) + T.C_BOOST];
  assert.ok(boost > 99, `a bot car keeps a full tank under boost use 0 (${boost})`);
});

test('a page from before the cars: room slots that carry `car` (src/net/cosmetics.ts) build the same roster and start as before', async () => {
  const slots = SLOTS_2V2.map((s) => (s.kind === 'peer' ? { ...s, car: 'tero' } : s));
  const env = await startedSession(slots, 0);
  assert.deepEqual(env.engine.humanSlots, [0, 2]);
  assert.equal(env.session.state, 'countdown');
  // RoomClient itself: the welcome goes through untouched.
  let socket = null;
  const client = new RoomClient({ now: () => 0, pingIntervalMs: 1_000_000, webSocketFactory: () => (socket = { readyState: 0, protocol: '', send() {}, close() {} }) });
  const welcomes = [];
  const errors = [];
  client.onWelcome = (w) => welcomes.push(w);
  client.onError = (code) => errors.push(code);
  client.connect('/room/r1', 'TK');
  socket.readyState = 1;
  socket.onopen({});
  socket.onmessage({ data: JSON.stringify(welcomeFor(0, slots)) });
  assert.deepEqual(errors, []);
  assert.deepEqual(welcomes[0].slots.map((s) => s.car ?? null), ['tero', null, 'tero', null]);
});
