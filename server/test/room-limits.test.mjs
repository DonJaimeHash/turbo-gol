// Security limits of the P2P signaling room (server/src/RoomDO.ts): the drop vote against a live
// target (audit rt-4), the 'unreachable' write budget (rt-m2), the room that never starts (rt-3)
// and the on-demand TURN credentials (cost-2). RoomDO on fakes (storage that counts its writes,
// sockets with attachments, a settable clock); 'cloudflare:workers' is stubbed. Run from server/:
// npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const DO_STUB = 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:workers') return { url: DO_STUB, shortCircuit: true };
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

const R = await import('../src/RoomDO.ts');
const { INTERNAL_HEADER, internalSecret } = await import('../src/auth.ts');
const SECRET = 'room-limits-test-secret';

// ---- the clock ----------------------------------------------------------------------------------

const realNow = Date.now;
let clock = 50_000_000;
Date.now = () => clock;
const advance = (ms) => (clock += ms);
test.after(() => {
  Date.now = realNow;
});

// ---- fakes --------------------------------------------------------------------------------------

class FakeSocket {
  constructor() {
    this.readyState = 1;
    this.sent = [];
    this.closed = null;
    this.att = null;
  }
  send(text) {
    if (this.readyState !== 1) throw new Error('send on a closed socket');
    this.sent.push(JSON.parse(text));
  }
  close(code, reason) {
    if (this.readyState === 3) throw new Error('already closed');
    this.readyState = 3;
    this.closed = { code, reason };
  }
  serializeAttachment(a) {
    this.att = JSON.parse(JSON.stringify(a));
  }
  deserializeAttachment() {
    return this.att;
  }
  of(type) {
    return this.sent.filter((m) => m.type === type);
  }
}

class FakeStorage {
  constructor() {
    this.map = new Map();
    this.alarm = null;
    this.puts = 0;
    this.alarms = 0;
  }
  async get(k) {
    return this.map.get(k);
  }
  async put(k, v) {
    this.puts++;
    this.map.set(k, structuredClone(v));
  }
  async delete(k) {
    return this.map.delete(k);
  }
  async deleteAll() {
    this.map.clear();
  }
  async setAlarm(t) {
    this.alarms++;
    this.alarm = t;
  }
  async deleteAlarm() {
    this.alarm = null;
  }
}

class FakeCtx {
  constructor() {
    this.storage = new FakeStorage();
    this.sockets = [];
    this.waits = [];
  }
  blockConcurrencyWhile(fn) {
    return fn();
  }
  acceptWebSocket(ws, tags) {
    ws.tags = tags;
    this.sockets.push(ws);
  }
  getWebSockets() {
    return this.sockets.filter((w) => w.readyState === 1);
  }
  waitUntil(p) {
    this.waits.push(Promise.resolve(p).catch(() => undefined));
  }
}

globalThis.WebSocketPair = class WebSocketPair {
  constructor() {
    this[0] = new FakeSocket();
    this[1] = new FakeSocket();
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

/** A fake MATCHMAKER namespace: records every call; `answer(path, body)` may answer one. */
function makeMm(answer = () => null) {
  const calls = [];
  return {
    calls,
    ns: {
      idFromName: (n) => n,
      get: () => ({
        fetch: async (url, init) => {
          const path = new URL(url).pathname;
          const body = JSON.parse(init.body);
          calls.push({ path, body });
          const r = answer(path, body);
          return new RealResponse(JSON.stringify(r ?? { ok: true }), { status: 200 });
        },
      }),
    },
  };
}

const peer = (slot, team, name) => ({ slot, team, kind: 'peer', name, playerId: 'p' + name.toLowerCase() });
const bot = (slot, team) => ({ slot, team, kind: 'bot', name: 'Bot ' + slot });
const ONE_V_ONE = [peer(0, 0, 'A'), peer(1, 1, 'B')];
const TWO_HUMANS_2V2 = [peer(0, 0, 'A'), bot(1, 0), peer(2, 1, 'B'), bot(3, 1)];
const THREE_HUMANS = [peer(0, 0, 'A'), peer(1, 0, 'B'), peer(2, 1, 'C'), bot(3, 1)];
const SIX = [peer(0, 0, 'A'), peer(1, 0, 'B'), peer(2, 0, 'C'), peer(3, 1, 'D'), peer(4, 1, 'E'), peer(5, 1, 'F')];

async function makeRoom(slots, env = {}) {
  const mode = slots.length === 2 ? '1v1' : slots.length === 4 ? '2v2' : '3v3';
  const ctx = new FakeCtx();
  const mm = env.mm ?? makeMm();
  const room = new R.RoomDO(ctx, { JWT_SECRET: SECRET, MATCHMAKER: mm.ns, ...env.vars });
  const secret = await internalSecret(SECRET);
  const res = await room.fetch(
    new Request('https://room/internal/create', {
      method: 'POST',
      headers: { [INTERNAL_HEADER]: secret, 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'r1', mode, region: 'SA', seed: 7, slots, matchLengthSeconds: 300, createdAt: Date.now() }),
    }),
  );
  assert.equal(res.status, 200, 'create');
  const h = { ctx, room, mm, sockets: [] };
  h.join = async (slot) => {
    const e = slots[slot];
    const jti = Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
    const r = await room.fetch(new Request('https://room/room/r1', { headers: { Upgrade: 'websocket', [INTERNAL_HEADER]: secret, 'x-player-id': e.playerId, 'x-slot': String(slot), 'x-team': String(e.team), 'x-jti': jti } }));
    assert.equal(r.upgraded, true, `upgrade of slot ${slot} (${r.status})`);
    const ws = ctx.sockets.at(-1);
    h.sockets[slot] = ws;
    return ws;
  };
  h.send = (ws, msg) => room.webSocketMessage(ws, JSON.stringify(msg));
  h.alarm = () => room.alarm();
  /** Every human joins and says ready: the match starts. */
  h.started = async () => {
    const out = [];
    for (const s of slots) if (s.kind === 'peer') out[s.slot] = await h.join(s.slot);
    for (const ws of out) if (ws) await h.send(ws, { type: 'ready' });
    for (const ws of out) if (ws) assert.equal(ws.of('start').length, 1, 'started');
    return out;
  };
  return h;
}

const dropsOf = (ws) => ws.of('drop').map((d) => [d.slot, d.atTick]);

// ---- rt-4: one report does not drop a live peer -------------------------------------------------

test('RoomDO 1v1: a lone unreachable report about a peer whose room socket is alive drops nobody; once it reports back (a link dead both ways) both are dropped', async () => {
  const h = await makeRoom(ONE_V_ONE);
  const [a, b] = await h.started();
  advance(10_000);
  await h.send(b, { type: 'hashReport', tick: 600, hash: 1, agree: 1, disagree: 0 }); // B's match loop runs
  await h.send(a, { type: 'unreachable', slot: 1, atTick: 500 });
  assert.deepEqual(dropsOf(b), [], 'B is not dropped on A\'s word');
  assert.deepEqual(dropsOf(a), []);
  assert.equal(b.readyState, 1);
  // B's link to A is dead as well: it reports A. Neither gets to pick: both go, each at its tick.
  await h.send(b, { type: 'unreachable', slot: 0, atTick: 520 });
  for (const ws of [a, b]) assert.deepEqual(dropsOf(ws).sort(), [[0, 520], [1, 500]]);
});

test('RoomDO with two humans and bots: the lone report stands until the target goes quiet, then the alarm drops it', async () => {
  const h = await makeRoom(TWO_HUMANS_2V2);
  const [a, , b] = await h.started();
  await h.send(a, { type: 'unreachable', slot: 2, atTick: 300 });
  assert.deepEqual(dropsOf(a), []);
  // B's match loop keeps reporting its hashes (every 10 s) for a while: alive at every re-check.
  for (let i = 0; i < 6; i++) {
    advance(10_000);
    await h.send(b, { type: 'hashReport', tick: 300 + i, hash: 1, agree: 1, disagree: 0 });
    await h.send(a, { type: 'hashReport', tick: 300, hash: 1, agree: 1, disagree: 0 });
    if (h.ctx.storage.alarm !== null && h.ctx.storage.alarm <= clock) await h.alarm();
  }
  assert.deepEqual(dropsOf(a), [], 'alive: no drop');
  // B's loop stops (a frozen page): past TARGET_SILENT_MS the re-check drops it at A's tick.
  advance(R.TARGET_SILENT_MS + 1_000);
  await h.send(a, { type: 'hashReport', tick: 300, hash: 1, agree: 1, disagree: 0 });
  assert.ok(h.ctx.storage.alarm !== null && h.ctx.storage.alarm <= clock, 'a re-check is due');
  await h.alarm();
  assert.deepEqual(dropsOf(a), [[2, 300]]);
});

const loopFrame = (h, ws, tick) => h.send(ws, { type: 'hashReport', tick, hash: 7, agree: 1, disagree: 0 });

// Review: a hidden tab stops requestAnimationFrame (no game packets, no hashReport) while RoomClient's
// timer keeps pinging every 15 s (ROOM_PING_INTERVAL_MATCH_MS). Its peer must not wait for it for good.
for (const [name, slots, bSlot] of [['1v1', ONE_V_ONE, 1], ['two humans and bots', TWO_HUMANS_2V2, 2]]) {
  test(`RoomDO ${name}: a peer whose tab is hidden (pings only) is dropped once its match loop has been quiet TARGET_SILENT_MS; the one that waited is never dropped`, async () => {
    const h = await makeRoom(slots);
    const ws = await h.started();
    const a = ws[0];
    const b = ws[bSlot];
    for (let i = 0; i < 3; i++) {
      advance(10_000);
      await loopFrame(h, a, 600 * (i + 1));
      await loopFrame(h, b, 600 * (i + 1));
    }
    const lastLoopOfB = clock;
    advance(4_000); // B's tab goes hidden; A's mesh finds it silent 2 s later and reports it
    await h.send(a, { type: 'unreachable', slot: bSlot, atTick: 2000 });
    let droppedAt = -1;
    for (let t = 0; t < 600_000 && droppedAt < 0; t += 1_000) {
      advance(1_000);
      if (t % 15_000 === 0) await h.send(b, { type: 'ping', t0: t }); // the timer, not the loop
      if (t % 10_000 === 0) await loopFrame(h, a, 2000); // A's loop runs (stalled, waiting for B)
      if (h.ctx.storage.alarm !== null && h.ctx.storage.alarm <= clock) await h.alarm();
      if (dropsOf(a).length > 0) droppedAt = clock;
    }
    assert.deepEqual(dropsOf(a), [[bSlot, 2000]], 'B is dropped at the tick A reported');
    // (main has no TARGET_SILENT_MS: it drops B on A's first report)
    assert.ok(droppedAt - lastLoopOfB <= (R.TARGET_SILENT_MS ?? 25_000) + 2_000, `A waited ${(droppedAt - lastLoopOfB) / 1000} s after B's loop stopped`);
    // B comes back: its mesh finds the link A closed and reports A. A stays: B's word no longer counts.
    await h.send(b, { type: 'unreachable', slot: 0, atTick: 1990 });
    assert.deepEqual(dropsOf(a), [[bSlot, 2000]], 'A, who waited, is not dropped');
    assert.equal(a.readyState, 1);
  });
}

test('RoomDO: a closed target is still dropped on one report after the close grace; three or more humans still vote by majority', async () => {
  const h = await makeRoom(ONE_V_ONE);
  const [a, b] = await h.started();
  await h.room.webSocketClose(b, 1006, '', false);
  await h.send(a, { type: 'unreachable', slot: 1, atTick: 77 });
  advance(R.CLOSE_GRACE_MS + 100);
  await h.alarm();
  assert.deepEqual(dropsOf(a), [[1, 77]]);
  const h3 = await makeRoom(SIX);
  const ws = await h3.started();
  for (const s of [0, 1, 2]) await h3.send(ws[s], { type: 'unreachable', slot: 5, atTick: 900 + s });
  assert.deepEqual(dropsOf(ws[0]), [[5, 900]], '3 of 5 voters: a majority, live or not');
});

// ---- rt-m2: repeated reports cost nothing; changing ones are budgeted -----------------------------

test('RoomDO: 3600 unreachable frames at 60/s from one socket of a 3-human room write state a bounded number of times', async () => {
  const h = await makeRoom(THREE_HUMANS);
  const [a, b] = await h.started();
  const puts0 = h.ctx.storage.puts;
  const alarms0 = h.ctx.storage.alarms;
  for (let i = 0; i < 3600; i++) {
    // Half the frames repeat the report, half lower its tick by one (a dedupe dodge).
    await h.send(a, { type: 'unreachable', slot: 1, atTick: i % 2 === 0 ? 100_000 : 100_000 - i });
    advance(1000 / 60);
    if (i % 900 === 0) await h.send(b, { type: 'ping', t0: i });
  }
  const writes = h.ctx.storage.puts - puts0;
  const alarms = h.ctx.storage.alarms - alarms0;
  assert.ok(writes <= R.REPORT_BURST + 60_000 / R.REPORT_REFILL_MS + 2, `state writes bounded (${writes})`);
  assert.ok(alarms <= 2, `setAlarm bounded (${alarms})`);
  assert.equal(a.readyState, 1, 'within the socket budget: not kicked');
  assert.deepEqual(dropsOf(a), [], 'one vote of two: nobody dropped');
});

test('RoomDO 3v3: a peer that really dies is dropped by the others\' first reports (no budget hit), at the smallest tick', async () => {
  const h = await makeRoom(SIX);
  const ws = await h.started();
  await h.room.webSocketClose(ws[5], 1006, '', false);
  for (const s of [0, 1, 2, 3, 4]) await h.send(ws[s], { type: 'unreachable', slot: 5, atTick: 1200 - s });
  // (the two later reporters get the drop repeated to them: the same one)
  for (const s of [0, 1, 2, 3, 4]) assert.deepEqual([...new Set(dropsOf(ws[s]).map(String))], ['5,1198'], 'majority of 5 reached at the third report');
});

test('decideDrop / mutualDrop: a lone vote never drops a live target; a closed one past the grace still goes; two live peers that report each other both go', () => {
  const reports = [{ slot: 1, from: 0, atTick: 40 }];
  assert.deepEqual(R.decideDrop({ target: 1, reports, others: [0], closedAgoMs: null }), { atTick: 40 }, 'not live (silent): as before');
  assert.equal(R.decideDrop({ target: 1, reports, others: [0], closedAgoMs: null, targetLive: true }), null);
  assert.deepEqual(R.decideDrop({ target: 1, reports, others: [0], closedAgoMs: R.CLOSE_GRACE_MS + 1, targetLive: true }), { atTick: 40 });
  const two = [...reports, { slot: 1, from: 2, atTick: 35 }];
  assert.deepEqual(R.decideDrop({ target: 1, reports: two, others: [0, 2], closedAgoMs: null, targetLive: true }), { atTick: 35 }, 'two votes: a majority even of a live target');
  assert.equal(R.mutualDrop(reports, 1, 0), null);
  assert.deepEqual(R.mutualDrop([...reports, { slot: 0, from: 1, atTick: 44 }], 1, 0), { a: 40, b: 44 });
});

// ---- rt-3: a room that never starts is cleaned up -------------------------------------------------

test('RoomDO: sockets open and nobody ready: NOT_READY_MS after the last peer joined the room is cleaned up and frees its locks and capacity', async () => {
  const h = await makeRoom(ONE_V_ONE);
  const a = await h.join(0);
  advance(2_000);
  const b = await h.join(1);
  const joinedAt = clock;
  advance(R.NO_SHOW_MS);
  await h.alarm(); // the no-show pass: both here
  assert.equal(h.ctx.storage.alarm, joinedAt + R.NOT_READY_MS, 'the alarm is armed for it');
  advance(R.NOT_READY_MS - R.NO_SHOW_MS - 5_000);
  await h.alarm(); // an early wake-up changes nothing
  assert.equal(a.readyState, 1);
  advance(5_000);
  await h.alarm();
  assert.deepEqual(a.closed, { code: 1000, reason: 'not_ready' });
  assert.deepEqual(b.closed, { code: 1000, reason: 'not_ready' });
  await Promise.all(h.ctx.waits);
  const rel = h.mm.calls.filter((c) => c.path === '/release').at(-1);
  assert.equal(rel.body.closeRoom, true, 'the capacity entry goes too');
  assert.deepEqual(rel.body.playerIds.sort(), ['pa', 'pb']);
});

test('RoomDO: a room whose peers connect and say ready within seconds starts as before, and NOT_READY_MS never touches a running match', async () => {
  const h = await makeRoom(ONE_V_ONE);
  const [a] = await h.started();
  advance(R.NOT_READY_MS * 3);
  await h.alarm();
  assert.equal(a.readyState, 1, 'started: the match runs to its TTL');
});

// ---- cost-2: TURN only on demand, revoked, counted, with a kill switch ------------------------------

const E = await import('../src/env.ts');

/** globalThis.fetch as the TURN API: mints `u<n>` credentials, records every call (generate and revoke). */
function fakeTurnApi() {
  const real = globalThis.fetch;
  const calls = [];
  let n = 0;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, body: init && init.body ? JSON.parse(init.body) : null });
    if (u.endsWith('/revoke')) return new RealResponse(null, { status: 204 });
    n++;
    return new RealResponse(JSON.stringify({ iceServers: { urls: ['turn:turn.example:3478?transport=udp'], username: 'u' + n, credential: 'c' + n } }), { status: 200 });
  };
  return {
    calls,
    mints: () => calls.filter((c) => c.url.endsWith('/generate-ice-servers')),
    revokes: () => calls.filter((c) => c.url.endsWith('/revoke')).map((c) => decodeURIComponent(c.url.split('/credentials/')[1].replace('/revoke', ''))),
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

const TURN_VARS = { TURN_KEY_ID: 'key', TURN_KEY_TOKEN: 'tok' };
const STUN = [{ urls: ['stun:stun.cloudflare.com:3478'] }];

test("RoomDO: TURN is minted only when a seat asks for it (never in a welcome), for the room's remaining life, at most TURN_PER_SLOT per seat", async () => {
  const api = fakeTurnApi();
  try {
    const h = await makeRoom(ONE_V_ONE, { vars: TURN_VARS });
    const a = await h.join(0);
    await h.join(1);
    assert.deepEqual(a.of('room')[0].iceServers, STUN, 'the welcome: STUN only');
    assert.equal(api.calls.length, 0, 'no TURN API call for the welcomes');
    advance(120_000);
    await h.send(a, { type: 'turn' });
    const got = a.of('turn').at(-1).iceServers;
    assert.equal(got.length, 2, 'STUN + TURN');
    assert.equal(got[1].username, 'u1');
    assert.equal(api.mints().length, 1);
    const ttl = api.mints()[0].body.ttl;
    assert.ok(ttl <= (R.ROOM_TTL_MS - 120_000) / 1000 && ttl >= (R.ROOM_TTL_MS - 125_000) / 1000, `ttl = the room's remaining life (${ttl} s)`);
    assert.deepEqual(h.mm.calls.filter((c) => c.path === '/turn-quota').map((c) => c.body.playerId), ['pa'], 'counted for the player at the matchmaker');
    await h.send(a, { type: 'turn' });
    assert.equal(api.mints().length, 1, 'a second ask within TURN_ASK_GAP_MS gets nothing');
    advance(E.TURN_ASK_GAP_MS);
    await h.send(a, { type: 'turn' });
    advance(E.TURN_ASK_GAP_MS);
    await h.send(a, { type: 'turn' });
    assert.equal(api.mints().length, 2, 'TURN_PER_SLOT: one more, then none');
    assert.deepEqual(a.of('turn').at(-1).iceServers, []);
  } finally {
    api.restore();
  }
});

test("RoomDO: a seat's TURN credentials are revoked when its socket goes, and the room's at its cleanup", async () => {
  const api = fakeTurnApi();
  try {
    const h = await makeRoom(ONE_V_ONE, { vars: TURN_VARS });
    const a = await h.join(0);
    const b = await h.join(1);
    await h.send(a, { type: 'turn' });
    await h.send(b, { type: 'turn' });
    await h.room.webSocketClose(a, 1000, '', true);
    await Promise.all(h.ctx.waits);
    assert.deepEqual(api.revokes(), ['u1'], "A's credential dies with A's seat");
    advance(R.ROOM_TTL_MS);
    await h.alarm(); // the hard TTL: cleanup
    await Promise.all(h.ctx.waits);
    assert.deepEqual(api.revokes().sort(), ['u1', 'u2'], "B's at the cleanup");
  } finally {
    api.restore();
  }
});

test("RoomDO: no TURN without the secrets, with turn_cf_disabled set, or past the player's daily quota: an empty answer, nothing minted", async () => {
  const api = fakeTurnApi();
  try {
    const none = await makeRoom(ONE_V_ONE);
    const a0 = await none.join(0);
    await none.send(a0, { type: 'turn' });
    assert.deepEqual(a0.of('turn').at(-1).iceServers, []);
    const killed = await makeRoom(ONE_V_ONE, { vars: { ...TURN_VARS, FLAGS: { get: async (k) => (k === 'turn_cf_disabled' ? '1' : null) } } });
    const a1 = await killed.join(0);
    await killed.send(a1, { type: 'turn' });
    assert.deepEqual(a1.of('turn').at(-1).iceServers, [], 'the kill switch: no TURN');
    const quota = await makeRoom(ONE_V_ONE, { vars: TURN_VARS, mm: makeMm((path) => (path === '/turn-quota' ? { ok: false } : null)) });
    const a2 = await quota.join(0);
    await quota.send(a2, { type: 'turn' });
    assert.deepEqual(a2.of('turn').at(-1).iceServers, []);
    assert.equal(api.mints().length, 0, 'nothing minted in any of them');
  } finally {
    api.restore();
  }
});

test("RoomDO: a seat whose quota is refused asks the matchmaker TURN_PER_SLOT times at most, however many 'turn' frames it sends", async () => {
  const api = fakeTurnApi();
  try {
    const h = await makeRoom(ONE_V_ONE, { vars: TURN_VARS, mm: makeMm((path) => (path === '/turn-quota' ? { ok: false } : null)) });
    const a = await h.join(0);
    await h.join(1);
    for (let i = 0; i < 100; i++) await h.send(a, { type: 'turn' }); // a burst
    const quota = () => h.mm.calls.filter((c) => c.path === '/turn-quota').length;
    assert.equal(quota(), 1, `a burst of 100 frames: one quota call (${quota()})`);
    for (let i = 0; i < 100; i++) {
      advance(E.TURN_ASK_GAP_MS + 1); // spaced past the gap
      await h.send(a, { type: 'turn' });
    }
    assert.equal(quota(), E.TURN_PER_SLOT, `100 spaced frames: TURN_PER_SLOT quota calls in all (${quota()})`);
    assert.equal(api.mints().length, 0);
    assert.equal(a.of('turn').length, 200, 'every frame is answered (an empty list)');
    assert.ok(a.of('turn').every((m) => m.iceServers.length === 0));
  } finally {
    api.restore();
  }
});

test("RoomDO: with turn_cf_disabled set a 'turn' never reaches the player's quota (the flag is read first)", async () => {
  const api = fakeTurnApi();
  try {
    let reads = 0;
    const FLAGS = { get: async (k) => (k === 'turn_cf_disabled' ? (reads++, '1') : null) };
    const h = await makeRoom(ONE_V_ONE, { vars: { ...TURN_VARS, FLAGS } });
    const a = await h.join(0);
    for (let i = 0; i < 20; i++) {
      advance(E.TURN_ASK_GAP_MS + 1);
      await h.send(a, { type: 'turn' });
    }
    assert.equal(h.mm.calls.filter((c) => c.path === '/turn-quota').length, 0, 'no quota unit spent while TURN is off');
    assert.equal(api.mints().length, 0);
    assert.ok(reads >= 1, 'the flag was read');
    // The flag goes off: the seat still has its asks.
    FLAGS.get = async () => null;
    advance(E.TURN_ASK_GAP_MS + 1);
    await h.send(a, { type: 'turn' });
    assert.equal(api.mints().length, 1, 'TURN back on: minted');
  } finally {
    api.restore();
  }
});

test('MatchmakerDO /turn-quota: TURN_PER_PLAYER_PER_DAY credentials a player a day, then no; a new day starts over', async () => {
  const M = await import('../src/MatchmakerDO.ts');
  const storage = new FakeStorage();
  storage.list = async ({ prefix }) => new Map([...storage.map].filter(([k]) => k.startsWith(prefix)));
  storage.getAlarm = async () => storage.alarm;
  const mm = new M.MatchmakerDO({ storage, blockConcurrencyWhile: (fn) => fn() }, { JWT_SECRET: SECRET });
  await new Promise((r) => setTimeout(r, 0));
  let t = 3 * 86_400_000 + 1000;
  mm.now = () => t;
  const secret = await internalSecret(SECRET);
  const ask = async (playerId) => (await (await mm.fetch(new Request('https://matchmaker/turn-quota', { method: 'POST', headers: { [INTERNAL_HEADER]: secret, 'content-type': 'application/json' }, body: JSON.stringify({ playerId }) }))).json()).ok;
  for (let i = 0; i < E.TURN_PER_PLAYER_PER_DAY; i++) assert.equal(await ask('p1'), true);
  assert.equal(await ask('p1'), false, 'the day is used up');
  assert.equal(await ask('p2'), true, 'per player');
  t += 86_400_000;
  assert.equal(await ask('p1'), true, 'a new day');
  await mm.alarm();
  assert.equal(storage.map.size, 1, "yesterday's rows swept");
});

test('env: iceServersFor takes a ttl (clamped to 60..1200 s) and the kill flag; revokeTurnCredential posts to .../credentials/<username>/revoke', async () => {
  const seen = [];
  const f = async (url, init) => {
    seen.push({ url: String(url), init });
    return String(url).endsWith('/revoke') ? new RealResponse(null, { status: 204 }) : new RealResponse(JSON.stringify({ iceServers: { urls: 'turn:x', username: 'uu', credential: 'cc' } }), { status: 200 });
  };
  await E.iceServersFor(TURN_VARS, f, 5);
  await E.iceServersFor(TURN_VARS, f, 99_999);
  assert.deepEqual(seen.map((s) => JSON.parse(s.init.body).ttl), [60, 1200]);
  const off = await E.iceServersFor({ ...TURN_VARS, FLAGS: { get: async () => 'on' } }, f);
  assert.deepEqual(off, STUN);
  assert.equal(seen.length, 2, 'the kill flag: nothing fetched');
  assert.equal(await E.revokeTurnCredential({ TURN_KEY_ID: 'k/1', TURN_KEY_TOKEN: 't' }, 'user:1', f), true);
  assert.equal(seen.at(-1).url, 'https://rtc.live.cloudflare.com/v1/turn/keys/k%2F1/credentials/user%3A1/revoke');
  assert.equal(seen.at(-1).init.headers.authorization, 'Bearer t');
  assert.deepEqual(E.turnUsernames([{ urls: 'stun:a' }, { urls: 'turn:b', username: 'x', credential: 'y' }]), ['x']);
});
