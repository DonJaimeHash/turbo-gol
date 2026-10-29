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
  await h.send(b, { type: 'ping', t0: 1 }); // B is alive and talking
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
  // B keeps pinging for a while: still alive at every re-check.
  for (let i = 0; i < 3; i++) {
    advance(15_000);
    await h.send(b, { type: 'ping', t0: i });
    await h.send(a, { type: 'ping', t0: i });
    if (h.ctx.storage.alarm !== null && h.ctx.storage.alarm <= clock) await h.alarm();
  }
  assert.deepEqual(dropsOf(a), [], 'alive: no drop');
  // B goes quiet (a half-open socket): past TARGET_SILENT_MS the re-check drops it at A's tick.
  advance(R.TARGET_SILENT_MS + 1_000);
  await h.send(a, { type: 'ping', t0: 9 });
  assert.ok(h.ctx.storage.alarm !== null && h.ctx.storage.alarm <= clock, 'a re-check is due');
  await h.alarm();
  assert.deepEqual(dropsOf(a), [[2, 300]]);
});

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
