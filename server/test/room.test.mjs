// Unit tests for the pure parts of the phase 2 signaling / matchmaking (server/src/RoomDO.ts,
// server/src/MatchmakerDO.ts, server/src/env.ts): ready/start decision, majority drop logic,
// roster / slot assignment, p2p formation timing, ICE server list, plus the RoomDO / MatchmakerDO
// classes on fakes (storage, sockets, namespaces, a settable clock): start / no-show grace, drops,
// presence / leave, single-use seats, lock verification, no-show strikes. No workerd:
// 'cloudflare:workers' is stubbed by the resolve hook so the DO modules load in node
// (server/test/smoke-p2p.mjs drives the real thing against wrangler dev). Run from server/:
//   npm test        (= node --test "test/*.test.mjs")
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
const M = await import('../src/MatchmakerDO.ts');
const E = await import('../src/env.ts');

// ---- RoomDO: start ------------------------------------------------------------------------------

test('decideStart: every connected peer ready, at least two connected, and no peer slot still absent without being left', () => {
  const p = (connected, ready, left) => (left === undefined ? { connected, ready } : { connected, ready, left });
  assert.equal(R.decideStart([p(true, true), p(true, true)]), true);
  assert.equal(R.decideStart([p(true, true), p(true, false)]), false, 'one connected peer not ready');
  assert.equal(R.decideStart([p(true, true), p(false, false)]), false, 'only one connected');
  assert.equal(R.decideStart([p(true, true), p(false, false), p(true, true)]), false, 'an absent slot that may still join blocks the start (its ticket may be in flight)');
  assert.equal(R.decideStart([p(true, true), p(false, false, true), p(true, true)]), true, 'a left slot (closed, /leave, no-show) does not block: it is dropped at tick 0');
  assert.equal(R.decideStart([p(true, true), p(true, true), p(false, false), p(false, false)]), false, '2v2: two ready, two absent -> wait (the no-show grace decides)');
  assert.equal(R.decideStart([p(true, true), p(true, true), p(false, false, true), p(false, false, true)]), true, '2v2 after the no-show pass');
  assert.equal(R.decideStart([p(true, true), p(false, false, true)]), false, 'a left slot is not a connected human');
  assert.equal(R.decideStart([p(true, true), p(true, true), p(true, false), p(true, true)]), false);
  assert.equal(R.decideStart([]), false);
  assert.equal(R.decideStart([p(true, true)], 1), true, 'minHumans is a parameter');
  assert.equal(R.MIN_HUMANS, 2);
});

// ---- RoomDO: drops ------------------------------------------------------------------------------

test('majorityOf', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(R.majorityOf), [1, 2, 2, 3, 3, 4]);
});

test('decideDrop: 1v1, the only other peer suffices; atTick = the reported tick (no lead)', () => {
  const d = R.decideDrop({ target: 1, reports: [{ slot: 1, from: 0, atTick: 100 }], others: [0], closedAgoMs: null });
  assert.deepEqual(d, { atTick: 100 + R.DROP_LEAD_TICKS });
  assert.equal(R.DROP_LEAD_TICKS, 0, 'the peers report contiguousInputTick + 1: nothing to add');
  assert.deepEqual(R.decideDrop({ target: 1, reports: [{ slot: 1, from: 0, atTick: 100 }], others: [0], closedAgoMs: null, leadTicks: 5 }), { atTick: 105 });
});

test('decideDrop: 3v3, majority of the other live peers; the OLDEST reported tick wins (every reporter can confirm it)', () => {
  const others = [0, 1, 2, 3, 4]; // target 5
  const r = (from, atTick) => ({ slot: 5, from, atTick });
  assert.equal(R.decideDrop({ target: 5, reports: [r(0, 100)], others, closedAgoMs: null }), null, '1 of 5');
  assert.equal(R.decideDrop({ target: 5, reports: [r(0, 100), r(1, 120)], others, closedAgoMs: null }), null, '2 of 5');
  assert.deepEqual(R.decideDrop({ target: 5, reports: [r(0, 100), r(1, 130), r(4, 120)], others, closedAgoMs: null }), { atTick: 100 }, '3 of 5 = majority, min tick 100');
});

test('decideDrop: reports about other slots, from the target, from dropped peers or bots do not count', () => {
  const reports = [
    { slot: 2, from: 0, atTick: 50 }, // about another slot
    { slot: 1, from: 1, atTick: 60 }, // the target about itself
    { slot: 1, from: 3, atTick: 70 }, // from a slot outside `others` (dropped / bot)
  ];
  assert.equal(R.decideDrop({ target: 1, reports, others: [0, 2], closedAgoMs: null }), null);
  assert.deepEqual(R.decideDrop({ target: 1, reports: [...reports, { slot: 1, from: 0, atTick: 80 }, { slot: 1, from: 2, atTick: 75 }], others: [0, 2], closedAgoMs: null }), { atTick: 75 });
});

test('decideDrop: a single report suffices once the slot socket has been closed longer than the grace', () => {
  const others = [0, 1, 2];
  const reports = [{ slot: 3, from: 0, atTick: 500 }];
  assert.equal(R.decideDrop({ target: 3, reports, others, closedAgoMs: null }), null, 'still connected');
  assert.equal(R.decideDrop({ target: 3, reports, others, closedAgoMs: 4000 }), null, 'closed 4 s ago: wait');
  assert.deepEqual(R.decideDrop({ target: 3, reports, others, closedAgoMs: 5001 }), { atTick: 500 }, 'closed > 5 s ago');
  assert.equal(R.decideDrop({ target: 3, reports: [], others, closedAgoMs: 60_000 }), null, 'no report at all: a closed signaling socket alone never drops (the mesh may be fine)');
  assert.equal(R.CLOSE_GRACE_MS, 5000);
});

test('decideDrop: no voters left', () => {
  assert.equal(R.decideDrop({ target: 1, reports: [{ slot: 1, from: 0, atTick: 10 }], others: [], closedAgoMs: null }), null);
});

// ---- MatchmakerDO: roster / slots ---------------------------------------------------------------

test('buildRoster: humans alternate teams, slots are blue humans, blue bots, red humans, red bots', () => {
  const H = (i) => ({ playerId: 'p' + i, name: 'H' + i });
  const r = M.buildRoster(2, [H(1), H(2), H(3)], 'peer');
  assert.deepEqual(
    r.map((s) => [s.slot, s.team, s.kind, s.name, s.playerId]),
    [
      [0, 0, 'peer', 'H1', 'p1'],
      [1, 0, 'peer', 'H3', 'p3'],
      [2, 1, 'peer', 'H2', 'p2'],
      [3, 1, 'bot', 'Bot 2', undefined],
    ],
  );
  const s = M.buildRoster(1, [H(1)], 'player');
  assert.deepEqual(
    s.map((e) => [e.slot, e.team, e.kind, e.name]),
    [
      [0, 0, 'player', 'H1'],
      [1, 1, 'bot', 'Bot 1'],
    ],
  );
  const full = M.buildRoster(3, [H(1), H(2), H(3), H(4), H(5), H(6)], 'peer');
  assert.deepEqual(full.map((e) => e.team), [0, 0, 0, 1, 1, 1]);
  assert.deepEqual(full.map((e) => e.name), ['H1', 'H3', 'H5', 'H2', 'H4', 'H6']);
  assert.ok(full.every((e) => e.kind === 'peer'));
  assert.deepEqual(M.buildRoster(2, [], 'peer').map((e) => e.kind), ['bot', 'bot', 'bot', 'bot']);
});

test('decideP2pFormation: full room at once; after 15 s bots with >= 2 humans, server path alone', () => {
  const W = M.P2P_FILL_WAIT;
  assert.equal(W, 15_000);
  assert.equal(M.decideP2pFormation(2, 2, 0), 'room', '1v1 with two humans');
  assert.equal(M.decideP2pFormation(6, 6, 0), 'room');
  assert.equal(M.decideP2pFormation(7, 6, 0), 'room', 'a surplus waiter stays queued');
  assert.equal(M.decideP2pFormation(1, 2, W - 1), 'wait');
  assert.equal(M.decideP2pFormation(1, 2, W), 'server', 'a lone human goes to the Durable Object path');
  assert.equal(M.decideP2pFormation(3, 4, W - 1), 'wait');
  assert.equal(M.decideP2pFormation(3, 4, W), 'room_bots');
  assert.equal(M.decideP2pFormation(2, 6, W), 'room_bots');
  assert.equal(M.decideP2pFormation(0, 2, W), 'wait');
  assert.equal(M.decideP2pFormation(1, 2, 100, 50), 'server', 'fill wait is a parameter');
});

test('isP2pResult', () => {
  assert.equal(M.isP2pResult({ status: 'matched', kind: 'p2p', roomId: 'r', ticket: 't', wsUrl: 'w' }), true);
  assert.equal(M.isP2pResult({ status: 'matched', matchId: 'm', ticket: 't', wsUrl: 'w' }), false);
  assert.equal(M.isP2pResult({ status: 'waiting', waiting: 1 }), false);
});

test('randomSeed is a uint32', () => {
  for (let i = 0; i < 20; i++) {
    const s = M.randomSeed();
    assert.ok(Number.isInteger(s) && s >= 0 && s <= 0xffffffff);
  }
});

// ---- env: ICE servers ---------------------------------------------------------------------------

test('iceServersFor: STUN only without TURN secrets; nothing fetched', async () => {
  let calls = 0;
  const list = await E.iceServersFor({}, async () => {
    calls++;
    throw new Error('must not be called');
  });
  assert.deepEqual(list, [{ urls: ['stun:stun.cloudflare.com:3478'] }]);
  assert.equal(calls, 0);
  const half = await E.iceServersFor({ TURN_KEY_ID: 'only-id' }, async () => {
    calls++;
    throw new Error('must not be called');
  });
  assert.deepEqual(half, [{ urls: ['stun:stun.cloudflare.com:3478'] }], 'both secrets are needed');
  assert.equal(calls, 0);
});

test('iceServersFor: mints 10-minute TURN credentials through the Realtime TURN API and appends them', async () => {
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url, init });
    return new Response(
      JSON.stringify({
        iceServers: {
          urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:5349?transport=tcp'],
          username: 'user-x',
          credential: 'cred-y',
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const list = await E.iceServersFor({ TURN_KEY_ID: 'key/1', TURN_KEY_TOKEN: 'tok' }, fakeFetch);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://rtc.live.cloudflare.com/v1/turn/keys/key%2F1/credentials/generate-ice-servers');
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.headers.authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(seen[0].init.body), { ttl: 600 });
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], { urls: ['stun:stun.cloudflare.com:3478'] });
  assert.deepEqual(list[1], { urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:5349?transport=tcp'], username: 'user-x', credential: 'cred-y' });
  // called again -> fetched again (nothing cached)
  await E.iceServersFor({ TURN_KEY_ID: 'key/1', TURN_KEY_TOKEN: 'tok' }, fakeFetch);
  assert.equal(seen.length, 2);
});

test('iceServersFor: a list answer, malformed entries, API errors and throws degrade to STUN only', async () => {
  const env = { TURN_KEY_ID: 'k', TURN_KEY_TOKEN: 't' };
  const asList = await E.iceServersFor(env, async () => new Response(JSON.stringify({ iceServers: [{ urls: 'turn:a?transport=udp', username: 'u', credential: 'c' }, { urls: [] }, { nope: 1 }, null] }), { status: 200 }));
  assert.deepEqual(asList, [{ urls: ['stun:stun.cloudflare.com:3478'] }, { urls: 'turn:a?transport=udp', username: 'u', credential: 'c' }]);
  const err = await E.iceServersFor(env, async () => new Response('nope', { status: 401 }));
  assert.deepEqual(err, [{ urls: ['stun:stun.cloudflare.com:3478'] }]);
  const thrown = await E.iceServersFor(env, async () => {
    throw new Error('network');
  });
  assert.deepEqual(thrown, [{ urls: ['stun:stun.cloudflare.com:3478'] }]);
  const notJson = await E.iceServersFor(env, async () => new Response('<html>', { status: 200 }));
  assert.deepEqual(notJson, [{ urls: ['stun:stun.cloudflare.com:3478'] }]);
});

test('isQueueKind', () => {
  assert.equal(E.isQueueKind('p2p'), true);
  assert.equal(E.isQueueKind('server'), true);
  assert.equal(E.isQueueKind('other'), false);
  assert.equal(E.isQueueKind(undefined), false);
});

// ---- RoomDO on fakes: the room logic end to end without workerd ----------------------------------
// A fake DurableObjectState (in-memory storage, accepted sockets), fake WebSocketPair sockets that
// record what the room sends them, and a Response shim for the 101 upgrade (node refuses that
// status). The internal secret header is computed exactly as the Worker does.

const { INTERNAL_HEADER, internalSecret } = await import('../src/auth.ts');
const SECRET = 'room-test-secret';

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

class FakeCtx {
  constructor() {
    this.storage = new FakeStorage();
    this.sockets = [];
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
    Promise.resolve(p).catch(() => undefined);
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
      this.webSocket = init.webSocket;
    } else super(body, init);
  }
};

/** A fake MATCHMAKER namespace that records the RoomDO's /release calls. */
function makeMatchmakerNs() {
  const releases = [];
  return {
    releases,
    ns: {
      idFromName: (n) => n,
      get: () => ({
        fetch: async (url, init) => {
          releases.push({ url, body: JSON.parse(init.body) });
          return new RealResponse('{"ok":true}');
        },
      }),
    },
  };
}

const ENV = {
  JWT_SECRET: SECRET,
  MATCHMAKER: { idFromName: (n) => n, get: () => ({ fetch: async () => new RealResponse('{"ok":true}') }) },
};

const PEERS_2V2 = [
  { slot: 0, team: 0, kind: 'peer', name: 'A', playerId: 'pa' },
  { slot: 1, team: 0, kind: 'peer', name: 'B', playerId: 'pb' },
  { slot: 2, team: 1, kind: 'peer', name: 'C', playerId: 'pc' },
  { slot: 3, team: 1, kind: 'bot', name: 'Bot 2' },
];

/** Peer seats as the matchmaker sends them for a room with experimental rules (signed-in players). */
const signedIn = (slots) => slots.map((s) => (s.kind === 'peer' ? { ...s, guest: false } : s));

/** `extra`: more /internal/create fields (an experimental room's `physics`: its peer seats are signed in). */
async function makeRoom(slots, mode = '2v2', env = ENV, extra = {}) {
  const ctx = new FakeCtx();
  const room = new R.RoomDO(ctx, env);
  const secret = await internalSecret(SECRET);
  const res = await room.fetch(
    new Request('https://room/internal/create', {
      method: 'POST',
      headers: { [INTERNAL_HEADER]: secret, 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'r1', mode, region: 'test', seed: 7, slots: extra.physics ? signedIn(slots) : slots, matchLengthSeconds: 300, createdAt: Date.now(), ...extra }),
    }),
  );
  assert.equal(res.status, 200, 'create');
  const h = { ctx, room, secret, sockets: [] };
  /** The Worker's forwarded upgrade for `slot` with a fresh ticket id (the raw Response). */
  h.upgrade = (slot) => {
    const e = slots[slot];
    const jti = Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
    return room.fetch(
      new Request('https://room/room/r1', {
        headers: { Upgrade: 'websocket', [INTERNAL_HEADER]: secret, 'x-player-id': e.playerId, 'x-slot': String(slot), 'x-team': String(e.team), 'x-jti': jti },
      }),
    );
  };
  h.join = async (slot) => {
    const r = await h.upgrade(slot);
    assert.equal(r.upgraded, true, `upgrade of slot ${slot} (${r.status} ${await r.text()})`);
    const ws = ctx.sockets.at(-1);
    h.sockets[slot] = ws;
    assert.equal(ws.of('room').length, 1, 'welcome sent');
    return ws;
  };
  h.send = (ws, msg) => room.webSocketMessage(ws, JSON.stringify(msg));
  h.close = (ws, code = 1000) => room.webSocketClose(ws, code, '', true);
  h.internal = async (path, body) => {
    const res = await room.fetch(
      new Request('https://room' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { [INTERNAL_HEADER]: secret, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    return { status: res.status, json: await res.json() };
  };
  return h;
}

test('RoomDO: an unready peer closing its socket before the start completes the start for the ready ones (start + drop at tick 0)', async () => {
  const h = await makeRoom(PEERS_2V2);
  const [a, b, c] = [await h.join(0), await h.join(1), await h.join(2)];
  await h.send(a, { type: 'ready' });
  await h.send(b, { type: 'ready' });
  assert.equal(a.of('start').length, 0, 'C is connected and not ready: no start');
  await h.close(c);
  assert.equal(a.of('peerLeft').length, 1);
  assert.equal(a.of('start').length, 1, 'A got the start once C was gone');
  assert.equal(b.of('start').length, 1, 'B too');
  assert.equal(a.of('start')[0].startAt, b.of('start')[0].startAt);
  assert.deepEqual(a.of('drop'), [{ type: 'drop', slot: 2, atTick: 0 }], 'C is the team AI from tick 0');
  assert.deepEqual(b.of('drop'), [{ type: 'drop', slot: 2, atTick: 0 }]);
  assert.equal(c.readyState, 3);
  // 'ready' again from A is idempotent and nothing starts twice.
  await h.send(a, { type: 'ready' });
  assert.equal(a.of('start').length, 1);
});

test('RoomDO: unreachable before the start is ignored; after the start the drop tick is the smallest reported one (no lead), to everyone', async () => {
  const h = await makeRoom(PEERS_2V2);
  const [a, b, c] = [await h.join(0), await h.join(1), await h.join(2)];
  await h.send(a, { type: 'unreachable', slot: 2, atTick: 100 });
  await h.send(b, { type: 'unreachable', slot: 2, atTick: 100 });
  assert.equal(a.of('drop').length + b.of('drop').length + c.of('drop').length, 0, 'before the start a dead link is the client fallback, never a drop');
  for (const ws of [a, b, c]) await h.send(ws, { type: 'ready' });
  assert.equal(c.of('start').length, 1);
  await h.send(a, { type: 'unreachable', slot: 2, atTick: 388 });
  assert.equal(a.of('drop').length, 0, '1 of 2 voters');
  await h.send(b, { type: 'unreachable', slot: 2, atTick: 381 });
  for (const ws of [a, b, c]) assert.deepEqual(ws.of('drop'), [{ type: 'drop', slot: 2, atTick: 381 }], 'min over the reports, no lead');
  await h.send(a, { type: 'unreachable', slot: 2, atTick: 400 });
  assert.equal(a.of('drop').length, 2, 'a repeated report gets the same drop again');
  assert.equal(a.of('drop')[1].atTick, 381);
});

test('RoomDO: a signal to a slot without a socket answers the sender error signal_dropped { to }; the slot is relayed to once it joins', async () => {
  const h = await makeRoom(PEERS_2V2);
  const a = await h.join(0);
  await h.send(a, { type: 'signal', to: 1, data: { sdp: { type: 'offer', sdp: 'o1' } } });
  assert.deepEqual(a.of('error'), [{ type: 'error', code: R.SIGNAL_DROPPED, message: 'slot 1 has no socket', to: 1 }]);
  assert.equal(R.SIGNAL_DROPPED, 'signal_dropped');
  assert.equal(a.readyState, 1, 'not fatal: the socket stays');
  const b = await h.join(1);
  assert.equal(a.of('peerJoined').length, 1);
  await h.send(a, { type: 'signal', to: 1, data: { sdp: { type: 'offer', sdp: 'o1' } } });
  assert.deepEqual(b.of('signal'), [{ type: 'signal', from: 0, data: { sdp: { type: 'offer', sdp: 'o1' } } }], 'the re-sent offer reaches B');
  assert.equal(a.of('error').length, 1, 'no second error');
});

test('RoomDO: presence answers the matchmaker per player (connected / everConnected / left / dropped), 404 for strangers and for a cleaned room', async () => {
  const h = await makeRoom(PEERS_2V2);
  assert.equal((await h.internal('/internal/presence?playerId=zz')).status, 404, 'not a member');
  assert.equal((await h.internal('/internal/presence?playerId=')).status, 404);
  let p = await h.internal('/internal/presence?playerId=pb');
  assert.equal(p.status, 200);
  assert.deepEqual(p.json, { roomId: 'r1', slot: 1, connected: false, everConnected: false, left: false, dropped: false, started: false }, 'never connected: the ticket may still be in flight');
  const b = await h.join(1);
  p = await h.internal('/internal/presence?playerId=pb');
  assert.deepEqual(p.json, { roomId: 'r1', slot: 1, connected: true, everConnected: true, left: false, dropped: false, started: false });
  await h.close(b);
  p = await h.internal('/internal/presence?playerId=pb');
  assert.deepEqual(p.json, { roomId: 'r1', slot: 1, connected: false, everConnected: true, left: true, dropped: false, started: false }, 'closed: gone for good');
  // A later joiner's welcome carries `left: true` for that slot (and no `left` for a slot that never connected).
  const a = await h.join(0);
  const slots = a.of('room')[0].slots;
  assert.equal(slots[1].connected, false);
  assert.equal(slots[1].left, true, 'B left: a later joiner does not wait for it');
  assert.equal(slots[2].left, undefined, 'C never connected: it may still come');
  assert.equal(slots[0].left, undefined);
  // The lock of B was released with its close (scoped to this room, closeRoom false).
  await h.room.fetch(new Request('https://room/internal/status', { headers: { [INTERNAL_HEADER]: h.secret } }));
});

test('RoomDO: /internal/leave closes a live socket (peerLeft to the others, lock released, start re-evaluated) or marks a never-connected slot left and announces it', async () => {
  const mm = makeMatchmakerNs();
  const h = await makeRoom(PEERS_2V2, '2v2', { JWT_SECRET: SECRET, MATCHMAKER: mm.ns });
  const [a, b] = [await h.join(0), await h.join(1)];
  // C never connected: it leaves through the matchmaker (before any start).
  let r = await h.internal('/internal/leave', { playerId: 'pc' });
  assert.deepEqual(r.json, { ok: true, slot: 2, closed: false, everConnected: false, noShow: true }, 'noShow: no socket, no ticket ever reached the room (the matchmaker counts a strike)');
  assert.deepEqual(a.of('peerLeft'), [{ type: 'peerLeft', slot: 2, peerId: '' }], 'announced with an empty peerId');
  assert.deepEqual(b.of('peerLeft'), [{ type: 'peerLeft', slot: 2, peerId: '' }]);
  r = await h.internal('/internal/leave', { playerId: 'pc' });
  assert.deepEqual(r.json, { ok: true, slot: 2, closed: false, everConnected: false, noShow: true }, 'idempotent');
  assert.equal(a.of('peerLeft').length, 1, 'announced once');
  assert.equal((await h.internal('/internal/presence?playerId=pc')).json.left, true);
  // B is live: /internal/leave kicks its socket -> the close path (peerLeft with its peerId, release).
  const before = mm.releases.length;
  r = await h.internal('/internal/leave', { playerId: 'pb' });
  assert.deepEqual(r.json, { ok: true, slot: 1, closed: true, everConnected: true, noShow: false });
  assert.equal(b.readyState, 3);
  assert.deepEqual(b.closed, { code: 1000, reason: 'left' });
  assert.equal(a.of('peerLeft').length, 2);
  assert.equal(a.of('peerLeft')[1].slot, 1);
  assert.ok(a.of('peerLeft')[1].peerId.length > 0);
  await new Promise((res) => setTimeout(res, 0));
  const rel = mm.releases.slice(before);
  assert.equal(rel.length, 1, 'one release call for B');
  assert.deepEqual(rel[0].body, { matchId: 'r1', playerIds: ['pb'], closeRoom: false });
  assert.equal((await h.internal('/internal/leave', { playerId: 'nobody' })).status, 404);
  assert.equal((await h.internal('/internal/leave', {})).status, 400);
  // The start is re-evaluated by the kick path: A alone (ready) cannot start (MIN_HUMANS 2).
  await h.send(a, { type: 'ready' });
  assert.equal(a.of('start').length, 0);
  assert.equal(a.readyState, 1);
});

// ---- RoomDO: staggered joins, the no-show grace, single-use seats ---------------------------------

const PEERS_2V2_FULL = [
  { slot: 0, team: 0, kind: 'peer', name: 'A', playerId: 'pa' },
  { slot: 1, team: 0, kind: 'peer', name: 'B', playerId: 'pb' },
  { slot: 2, team: 1, kind: 'peer', name: 'C', playerId: 'pc' },
  { slot: 3, team: 1, kind: 'peer', name: 'D', playerId: 'pd' },
];

/** Run `fn(clock)` with Date.now() = clock.t (the RoomDO reads Date.now for createdAt, the grace and the start). */
async function withClock(t0, fn) {
  const real = Date.now;
  const clock = { t: t0 };
  Date.now = () => clock.t;
  try {
    return await fn(clock);
  } finally {
    Date.now = real;
  }
}

const settle = () => new Promise((res) => setTimeout(res, 0));

test('RoomDO: staggered 2v2 join: two peers ready, the other two join 2 s later -> no start until all four are connected and ready, and no drop', async () => {
  await withClock(5_000_000, async (clock) => {
    const h = await makeRoom(PEERS_2V2_FULL);
    assert.equal(h.ctx.storage.alarm, clock.t + R.NO_SHOW_MS, 'the first alarm is the no-show pass');
    const [a, b] = [await h.join(0), await h.join(1)];
    await h.send(a, { type: 'ready' });
    await h.send(b, { type: 'ready' });
    assert.equal(a.of('start').length + b.of('start').length, 0, 'two of four ready, two tickets in flight: no start (they would be dropped at tick 0)');
    clock.t += 2000;
    const c = await h.join(2);
    assert.equal(c.of('room')[0].slots[3].left, undefined, 'D is still expected by the late joiner');
    const d = await h.join(3);
    assert.equal(a.of('peerJoined').length, 3, 'B, then C and D 2 s later');
    await h.send(c, { type: 'ready' });
    assert.equal(a.of('start').length, 0, 'D connected, not ready');
    await h.send(d, { type: 'ready' });
    for (const ws of [a, b, c, d]) assert.equal(ws.of('start').length, 1, 'start to all four');
    assert.equal(a.of('start')[0].startAt, clock.t + R.START_DELAY_MS);
    for (const ws of [a, b, c, d]) assert.deepEqual(ws.of('drop'), [], 'nobody dropped at tick 0');
    // The grace passing later changes nothing.
    clock.t += R.NO_SHOW_MS;
    await h.room.alarm();
    for (const ws of [a, b, c, d]) assert.deepEqual(ws.of('peerLeft'), []);
  });
});

test('RoomDO: 2 of 4 ready and 2 absent -> no start before the no-show grace; after it: peerLeft for the absent, start + drop { slot, 0 }, tickets refused, locks released as no-shows', async () => {
  await withClock(6_000_000, async (clock) => {
    const mm = makeMatchmakerNs();
    const h = await makeRoom(PEERS_2V2_FULL, '2v2', { JWT_SECRET: SECRET, MATCHMAKER: mm.ns });
    const t0 = clock.t;
    const [a, c] = [await h.join(0), await h.join(2)];
    await h.send(a, { type: 'ready' });
    await h.send(c, { type: 'ready' });
    clock.t = t0 + R.NO_SHOW_MS - 1000;
    await h.room.alarm(); // early wake-up: nothing to do yet
    assert.equal(a.of('start').length, 0, 'no start before the grace');
    assert.deepEqual(a.of('peerLeft'), []);
    clock.t = t0 + R.NO_SHOW_MS;
    await h.room.alarm();
    for (const ws of [a, c]) {
      assert.deepEqual(ws.of('peerLeft'), [{ type: 'peerLeft', slot: 1, peerId: '' }, { type: 'peerLeft', slot: 3, peerId: '' }], 'the no-shows are announced');
      assert.equal(ws.of('start').length, 1, 'the present (ready) peers start');
      assert.deepEqual(ws.of('drop'), [{ type: 'drop', slot: 1, atTick: 0 }, { type: 'drop', slot: 3, atTick: 0 }], 'every peer hands the absent cars to the AI from tick 0');
    }
    assert.equal(a.of('start')[0].startAt, clock.t + R.START_DELAY_MS);
    // A ticket of a no-show is refused from now on (its lock is being freed; the match runs without it).
    const late = await h.upgrade(1);
    assert.equal(late.status, 403);
    assert.equal((await late.json()).error, 'left');
    await settle();
    const noShows = mm.releases.map((r) => r.body).filter((b) => b.noShow !== undefined);
    assert.deepEqual(noShows, [
      { matchId: 'r1', playerIds: ['pb'], closeRoom: false, noShow: ['pb'] },
      { matchId: 'r1', playerIds: ['pd'], closeRoom: false, noShow: ['pd'] },
    ], 'the start drop frees their locks naming them no-shows (the matchmaker counts the strike)');
    const p = await h.internal('/internal/presence?playerId=pb');
    assert.deepEqual(p.json, { roomId: 'r1', slot: 1, connected: false, everConnected: false, left: true, dropped: true, started: true });
    assert.notEqual(h.ctx.storage.alarm, t0 + R.NO_SHOW_MS, 'the no-show alarm is not re-armed');
  });
});

test('RoomDO: the no-show pass with the present peers not ready yet (the client gate) -> start as soon as they say ready', async () => {
  await withClock(7_000_000, async (clock) => {
    const h = await makeRoom(PEERS_2V2_FULL);
    const t0 = clock.t;
    const [a, b, c] = [await h.join(0), await h.join(1), await h.join(2)];
    clock.t = t0 + R.NO_SHOW_MS;
    await h.room.alarm();
    assert.deepEqual(a.of('peerLeft'), [{ type: 'peerLeft', slot: 3, peerId: '' }]);
    assert.equal(a.of('start').length, 0, 'nobody said ready yet');
    for (const ws of [a, b]) await h.send(ws, { type: 'ready' });
    assert.equal(a.of('start').length, 0);
    await h.send(c, { type: 'ready' });
    for (const ws of [a, b, c]) {
      assert.equal(ws.of('start').length, 1);
      assert.deepEqual(ws.of('drop'), [{ type: 'drop', slot: 3, atTick: 0 }]);
    }
  });
});

test('RoomDO: a slot flagged left is refused on upgrade (403 left): after /internal/leave, after its socket closed (single-use seat)', async () => {
  const h = await makeRoom(PEERS_2V2);
  const a = await h.join(0);
  await h.internal('/internal/leave', { playerId: 'pc' });
  let r = await h.upgrade(2);
  assert.equal(r.status, 403, 'C left through the matchmaker before connecting: its ticket is dead');
  assert.equal((await r.json()).error, 'left');
  assert.equal(a.of('peerJoined').length, 0, 'nobody joined');
  const b = await h.join(1);
  await h.close(b);
  r = await h.upgrade(1);
  assert.equal(r.status, 403, 'B closed its socket: it cannot come back with another ticket');
  assert.equal((await r.json()).error, 'left');
  assert.equal(a.readyState, 1);
});

// ---- MatchmakerDO on fakes: locks verified against the room, /leave releases ------------------------

class FakeMmStorage extends FakeStorage {
  async list({ prefix }) {
    const out = new Map();
    for (const [k, v] of this.map) if (k.startsWith(prefix)) out.set(k, v);
    return out;
  }
}

/** A fake DO namespace: ids are random hex, `handler(path, body, query)` answers every fetch. */
function makeNs(handler) {
  const calls = [];
  return {
    calls,
    ns: {
      newUniqueId: () => ({ toString: () => Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('') }),
      idFromString: (s) => s,
      get: (id) => ({
        fetch: async (url, init) => {
          const u = new URL(url);
          const body = init && init.body ? JSON.parse(init.body) : null;
          calls.push({ id: String(id), path: u.pathname, body, query: Object.fromEntries(u.searchParams) });
          const r = handler(u.pathname, body, Object.fromEntries(u.searchParams), String(id));
          return r instanceof RealResponse ? r : new RealResponse(JSON.stringify(r.body ?? r), { status: r.status ?? 200 });
        },
      }),
    },
  };
}

async function makeMatchmaker() {
  const presence = new Map(); // playerId -> PresenceInfo | number (status)
  const leaveInfo = new Map(); // playerId -> the RoomDO's /internal/leave answer (default: a live socket closed)
  const roomNs = makeNs((path, body, query) => {
    if (path === '/internal/create') return { ok: true };
    if (path === '/internal/leave') return leaveInfo.get(body.playerId) ?? { ok: true, slot: 0, closed: true, everConnected: true, noShow: false };
    if (path === '/internal/presence') {
      const p = presence.get(query.playerId);
      if (p === undefined) return new RealResponse('{"error":"no_room"}', { status: 404 });
      if (typeof p === 'number') return new RealResponse('{}', { status: p });
      return p;
    }
    return new RealResponse('{}', { status: 404 });
  });
  const matchStatus = { matchId: 'x', ended: false, reset: false };
  const matchNs = makeNs((path) => {
    if (path === '/internal/create') return { ok: true };
    if (path === '/internal/status') return matchStatus;
    if (path === '/internal/leave') return { ok: true, slot: 0, closed: true, already: false, ended: false };
    return new RealResponse('{}', { status: 404 });
  });
  const ctx = { storage: new FakeMmStorage(), blockConcurrencyWhile: (fn) => fn() };
  const env = { JWT_SECRET: SECRET, ROOM: roomNs.ns, MATCH: matchNs.ns, MATCH_LENGTH_SECONDS: 300, REGION_OVERRIDE: '' };
  const mm = new M.MatchmakerDO(ctx, env);
  await new Promise((r) => setTimeout(r, 0)); // the constructor's storage load
  let t = 1_000_000;
  mm.now = () => t;
  const secret = await internalSecret(SECRET);
  const call = async (path, body) => {
    const res = await mm.fetch(
      new Request('https://matchmaker' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { [INTERNAL_HEADER]: secret, 'content-type': 'application/json', 'x-region': 'test' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    return { status: res.status, json: await res.json() };
  };
  const join = (playerId, kind = 'p2p', mode = '1v1') => call('/join', { playerId, name: playerId, mode, kind });
  /** Two p2p 1v1 joins: the first answers 'waiting', the second forms the room; the first's result is collected by its next join (as the Worker's poll would). */
  const pair = async (a, b) => {
    const first = await join(a);
    assert.equal(first.json.status, 'waiting');
    const qb = await join(b);
    const qa = await join(a);
    return [qa, qb];
  };
  return { mm, call, join, pair, presence, leaveInfo, roomNs, matchNs, matchStatus, setTime: (v) => (t = v), time: () => t };
}

test('roomHoldsPlayer: connected holds; dropped / left / had-a-socket-and-lost-it do not; never connected holds only within the join grace', () => {
  const p = (o) => ({ roomId: 'r', slot: 0, connected: false, everConnected: false, left: false, dropped: false, started: false, ...o });
  assert.equal(M.roomHoldsPlayer(p({ connected: true, everConnected: true }), 60_000), true);
  assert.equal(M.roomHoldsPlayer(p({ connected: true, everConnected: true, dropped: true }), 0), false, 'dropped mid-match: free');
  assert.equal(M.roomHoldsPlayer(p({ left: true }), 0), false);
  assert.equal(M.roomHoldsPlayer(p({ everConnected: true }), 0), false, 'socket closed: free (single-use ticket)');
  assert.equal(M.roomHoldsPlayer(p({}), M.JOIN_GRACE_MS - 1), true, 'ticket may still be in flight');
  assert.equal(M.roomHoldsPlayer(p({}), M.JOIN_GRACE_MS), false, 'never came: free');
  assert.equal(M.roomHoldsPlayer(p({}), 100, 50), false, 'grace is a parameter');
  assert.equal(M.LOCK_VERIFY_AFTER_MS, 2000);
  assert.equal(M.JOIN_GRACE_MS, 10_000);
});

test('MatchmakerDO: a p2p lock is trusted while fresh, then verified with the room: a player still connected gets 409 (with a reason), one whose socket closed queues again', async () => {
  const h = await makeMatchmaker();
  const [qa, qb] = await h.pair('pa', 'pb');
  assert.equal(qa.json.status, 'matched');
  assert.equal(qa.json.kind, 'p2p');
  assert.equal(qb.json.roomId, qa.json.roomId, 'one room for both');
  assert.equal(h.roomNs.calls.filter((c) => c.path === '/internal/create').length, 1);
  // Fresh lock: 409 without asking the room.
  let r = await h.join('pa');
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'active_match');
  assert.equal(r.json.kind, 'p2p');
  assert.equal(r.json.matchId, qa.json.roomId);
  assert.match(r.json.message, /P2P room/);
  assert.equal(h.roomNs.calls.filter((c) => c.path === '/internal/presence').length, 0, 'not verified yet');
  // Older lock, the room says A is connected: still 409, verified.
  h.setTime(h.time() + M.LOCK_VERIFY_AFTER_MS);
  h.presence.set('pa', { roomId: qa.json.roomId, slot: 0, connected: true, everConnected: true, left: false, dropped: false, started: false });
  r = await h.join('pa');
  assert.equal(r.status, 409);
  assert.equal(h.roomNs.calls.filter((c) => c.path === '/internal/presence').length, 1);
  assert.equal(h.roomNs.calls.at(-1).query.playerId, 'pa');
  // A's socket closed (its release may be in flight): the lock is dropped and A queues.
  h.presence.set('pa', { roomId: qa.json.roomId, slot: 0, connected: false, everConnected: true, left: true, dropped: false, started: false });
  r = await h.join('pa');
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'waiting', `A is queued again: ${JSON.stringify(r.json)}`);
  assert.equal((await h.call('/stats')).json.active, 1, 'only B keeps a lock');
  // The room is gone (404): B is freed too.
  h.setTime(h.time() + 1000);
  r = await h.join('pb');
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'matched', 'A was waiting: B joining forms a new room at once');
  assert.notEqual(r.json.roomId, qa.json.roomId);
  // Leave both queues / rooms so nothing lingers.
  for (const p of ['pa', 'pb']) await h.call('/leave', { playerId: p });
});

test('MatchmakerDO: a lock whose slot never connected is kept for the join grace, then freed; a room that cannot be reached keeps the lock', async () => {
  const h = await makeMatchmaker();
  const [qa] = await h.pair('pa', 'pb');
  const never = { roomId: qa.json.roomId, slot: 0, connected: false, everConnected: false, left: false, dropped: false, started: false };
  h.presence.set('pa', never);
  h.setTime(h.time() + M.LOCK_VERIFY_AFTER_MS + 1);
  let r = await h.join('pa');
  assert.equal(r.status, 409, 'the ticket may still be in flight');
  h.setTime(h.time() + M.JOIN_GRACE_MS);
  r = await h.join('pa');
  assert.equal(r.json.status, 'waiting', 'never came within the grace: freed');
  h.presence.set('pb', 500);
  r = await h.join('pb');
  assert.equal(r.status, 409, 'the room errored: fail safe, the lock stays (/leave frees it)');
  for (const p of ['pa', 'pb']) await h.call('/leave', { playerId: p });
});

test('MatchmakerDO: /leave frees a p2p room lock first (a join right after is not 409) and tells the room; a waiter is dropped too; a server lock is not released', async () => {
  const h = await makeMatchmaker();
  const [qa] = await h.pair('pa', 'pb');
  let r = await h.call('/leave', { playerId: 'pa' });
  assert.deepEqual(r.json, { ok: true, left: false, released: true });
  const leaves = h.roomNs.calls.filter((c) => c.path === '/internal/leave');
  assert.equal(leaves.length, 1);
  assert.deepEqual(leaves[0].body, { playerId: 'pa' });
  assert.equal(leaves[0].id, qa.json.roomId);
  r = await h.join('pa');
  assert.equal(r.json.status, 'waiting', 'queued again at once, no 409');
  r = await h.call('/leave', { playerId: 'pa' });
  assert.deepEqual(r.json, { ok: true, left: true, released: false }, 'a waiter: left, nothing to release');
  // A matchId that is not the lock's room: ignored.
  r = await h.call('/leave', { playerId: 'pb', matchId: 'f'.repeat(64) });
  assert.deepEqual(r.json, { ok: true, left: false, released: false });
  r = await h.call('/leave', { playerId: 'pb', matchId: qa.json.roomId });
  assert.deepEqual(r.json, { ok: true, left: false, released: true });
  assert.equal((await h.call('/stats')).json.active, 0);
  // A lone p2p human after the fill wait gets a server match; that lock is verified with the MatchDO and not released by /leave.
  r = await h.join('pc');
  assert.equal(r.json.status, 'waiting');
  h.setTime(h.time() + M.P2P_FILL_WAIT + 1);
  r = await h.join('pc');
  assert.equal(r.json.status, 'matched');
  assert.equal(r.json.kind, undefined, 'phase 1 shape');
  assert.ok(r.json.matchId);
  r = await h.call('/leave', { playerId: 'pc' });
  assert.deepEqual(r.json, { ok: true, left: false, released: false }, 'a server match lock stays (rejoin path)');
  h.setTime(h.time() + M.LOCK_VERIFY_AFTER_MS + 1);
  r = await h.join('pc');
  assert.equal(r.status, 409);
  assert.equal(r.json.kind, 'server');
  assert.match(r.json.message, /rejoin/);
  assert.equal(h.matchNs.calls.filter((c) => c.path === '/internal/status').length, 1, 'verified with the MatchDO');
  h.matchStatus.ended = true;
  r = await h.join('pc');
  assert.equal(r.json.status, 'waiting', 'the match ended: freed');
  await h.call('/leave', { playerId: 'pc' });
});

test('leaveReleases: a p2p lock without an id or with its own; a server lock only when the leave names that match', () => {
  const id = 'a'.repeat(64);
  const other = 'b'.repeat(64);
  assert.equal(M.leaveReleases('p2p', id, null), true);
  assert.equal(M.leaveReleases('p2p', id, id), true);
  assert.equal(M.leaveReleases('p2p', id, other), false);
  assert.equal(M.leaveReleases('server', id, null), false, 'Esc in the queue / a P2P teardown keep the server lock (rejoin path)');
  assert.equal(M.leaveReleases('server', id, id), true, 'an explicit quit of that match');
  assert.equal(M.leaveReleases('server', id, other), false, 'a wrong id frees nothing');
  assert.match(M.lockMessage('server'), /rejoin/);
  assert.match(M.lockMessage('server'), /api\/leave/);
});

/** A server (MatchDO) match for `playerId` through the bot fill: join, wait BOT_FILL_MS, join again. */
async function serverMatch(h, playerId) {
  let r = await h.join(playerId, 'server');
  assert.equal(r.json.status, 'waiting');
  h.setTime(h.time() + M.BOT_FILL_MS);
  r = await h.join(playerId, 'server');
  assert.equal(r.json.status, 'matched', JSON.stringify(r.json));
  assert.ok(/^[0-9a-f]{64}$/.test(r.json.matchId));
  return r.json.matchId;
}

test('MatchmakerDO: /leave naming the server match frees that lock first (a p2p join right after is not 409) and tells the MatchDO; a wrong matchId frees nothing', async () => {
  const h = await makeMatchmaker();
  const matchId = await serverMatch(h, 'ps');
  let r = await h.join('ps', 'p2p');
  assert.equal(r.status, 409, 'the server lock refuses a p2p queue');
  assert.equal(r.json.kind, 'server');
  assert.equal(r.json.matchId, matchId);

  // A wrong id (an older match, a typo): nothing released, the MatchDO is not called.
  r = await h.call('/leave', { playerId: 'ps', matchId: 'f'.repeat(64) });
  assert.deepEqual(r.json, { ok: true, left: false, released: false });
  assert.equal(h.matchNs.calls.filter((c) => c.path === '/internal/leave').length, 0);
  // No id at all (Esc in a queue, a P2P teardown): the server lock stays too.
  r = await h.call('/leave', { playerId: 'ps' });
  assert.deepEqual(r.json, { ok: true, left: false, released: false });
  h.setTime(h.time() + M.LOCK_VERIFY_AFTER_MS + 1);
  r = await h.join('ps', 'p2p');
  assert.equal(r.status, 409, 'still locked (verified with the MatchDO: alive)');

  // The explicit quit: that match's id.
  r = await h.call('/leave', { playerId: 'ps', matchId });
  assert.deepEqual(r.json, { ok: true, left: false, released: true });
  const leaves = h.matchNs.calls.filter((c) => c.path === '/internal/leave');
  assert.equal(leaves.length, 1, 'the MatchDO is told once');
  assert.equal(leaves[0].id, matchId);
  assert.deepEqual(leaves[0].body, { playerId: 'ps' });
  assert.equal((await h.call('/stats')).json.active, 0, 'lock gone');
  r = await h.join('ps', 'p2p');
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'waiting', 'queued for P2P at once');
  // Repeating the leave once the lock is gone: the waiter is dropped, nothing else.
  r = await h.call('/leave', { playerId: 'ps', matchId });
  assert.deepEqual(r.json, { ok: true, left: true, released: false });
  assert.equal(h.matchNs.calls.filter((c) => c.path === '/internal/leave').length, 1);
});

test('MatchmakerDO: queue + quit back to back holds no capacity: the MatchDO leave of the last human re-enters with /release before answering (no deadlock) and the room is forgotten', async () => {
  const h = await makeMatchmaker();
  const realGet = h.matchNs.ns.get;
  // What MatchDO.leave does for the last human: shutdown('left') sends the scoped /release
  // (waitUntil) while the matchmaker is still waiting on this /internal/leave answer.
  h.matchNs.ns.get = (id) => ({
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      if (path !== '/internal/leave') return realGet(id).fetch(url, init);
      const body = JSON.parse(init.body);
      const rel = await h.call('/release', { matchId: String(id), playerIds: [body.playerId] });
      assert.equal(rel.status, 200);
      return new RealResponse(JSON.stringify({ ok: true, slot: 0, closed: false, already: false, ended: true }));
    },
  });
  try {
    for (let i = 0; i < 3; i++) {
      const matchId = await serverMatch(h, 'pq');
      assert.equal((await h.call('/stats')).json.rooms, 1, `match ${i} counts against MAX_ACTIVE_ROOMS while it lives`);
      const r = await h.call('/leave', { playerId: 'pq', matchId });
      assert.deepEqual(r.json, { ok: true, left: false, released: true });
      const st = (await h.call('/stats')).json;
      assert.equal(st.rooms, 0, `match ${i}: its capacity entry went with the quit`);
      assert.equal(st.active, 0);
    }
  } finally {
    h.matchNs.ns.get = realGet;
  }
});

test('MatchmakerDO: a server-match /leave whose MatchDO is unreachable still frees the lock (best effort)', async () => {
  const h = await makeMatchmaker();
  const matchId = await serverMatch(h, 'pt');
  const realGet = h.matchNs.ns.get;
  h.matchNs.ns.get = () => ({
    fetch: async () => {
      throw new Error('object unreachable');
    },
  });
  const realError = console.error;
  console.error = () => {};
  try {
    const r = await h.call('/leave', { playerId: 'pt', matchId });
    assert.deepEqual(r.json, { ok: true, left: false, released: true });
  } finally {
    console.error = realError;
    h.matchNs.ns.get = realGet;
  }
  const q = await h.join('pt', 'p2p');
  assert.equal(q.json.status, 'waiting');
  await h.call('/leave', { playerId: 'pt' });
});

test('RoomDO: a burst of 200 ICE candidates in one second is relayed without tripping the rate limit', async () => {
  const h = await makeRoom(PEERS_2V2);
  const [a, b] = [await h.join(0), await h.join(1)];
  for (let i = 0; i < 200; i++) await h.send(a, { type: 'signal', to: 1, data: { candidate: { candidate: 'candidate:' + i, sdpMid: '0', sdpMLineIndex: 0 } } });
  assert.equal(a.readyState, 1, 'A not kicked');
  assert.equal(b.of('signal').length, 200, 'B got every candidate');
  assert.ok(R.MSG_BURST >= 400);
  for (let i = 0; i < R.MSG_BURST + 10; i++) await h.send(a, { type: 'ping', t0: i });
  assert.equal(a.readyState, 3, 'a real flood is still kicked');
  assert.equal(a.closed.reason, 'rate');
});

// ---- MatchmakerDO: the verification tells the room; no-show strikes ---------------------------------

const NEVER = { closed: false, everConnected: false, noShow: true };

test('MatchmakerDO: a lock freed by the verification also tells the room (/internal/leave), exactly like /leave', async () => {
  const h = await makeMatchmaker();
  const [qa] = await h.pair('pa', 'pb');
  h.setTime(h.time() + M.LOCK_VERIFY_AFTER_MS);
  // The room says A's slot never connected and the join grace is over: stale.
  h.presence.set('pa', { roomId: qa.json.roomId, slot: 0, connected: false, everConnected: false, left: false, dropped: false, started: false });
  h.setTime(h.time() + M.JOIN_GRACE_MS);
  const r = await h.join('pa');
  assert.equal(r.json.status, 'waiting', 'freed and queued');
  const leaves = h.roomNs.calls.filter((c) => c.path === '/internal/leave');
  assert.equal(leaves.length, 1, 'the room was told: the slot is left there and its ticket refused');
  assert.deepEqual(leaves[0].body, { playerId: 'pa' });
  assert.equal(leaves[0].id, qa.json.roomId);
  for (const p of ['pa', 'pb']) await h.call('/leave', { playerId: p });
});

test('MatchmakerDO: three room tickets left unused -> p2p queue 429 no_show with retryAfterMs (server queues still work), lifted after the block', async () => {
  const h = await makeMatchmaker();
  h.leaveInfo.set('pa', { ok: true, slot: 0, ...NEVER });
  for (let i = 1; i <= M.NO_SHOW_LIMIT; i++) {
    const [qa] = await h.pair('pa', 'px' + i);
    assert.equal(qa.json.status, 'matched', `round ${i}: A got its ticket`);
    const r = await h.call('/leave', { playerId: 'pa' });
    assert.equal(r.json.released, true);
    await h.call('/leave', { playerId: 'px' + i }); // the partner had a socket: no strike
    assert.equal((await h.call('/stats')).json.noShows, 1, 'one player with strikes (the partners have none)');
    h.setTime(h.time() + 1000);
  }
  let r = await h.join('pa');
  assert.equal(r.status, 429);
  assert.equal(r.json.error, 'no_show');
  assert.ok(r.json.retryAfterMs > M.NO_SHOW_BLOCK_MS - 2000 && r.json.retryAfterMs <= M.NO_SHOW_BLOCK_MS, `retryAfterMs ${r.json.retryAfterMs}`);
  assert.match(r.json.message, /3 room tickets/);
  r = await h.join('pa', 'server');
  assert.equal(r.status, 200, 'a server queue is not refused');
  assert.equal(r.json.status, 'waiting');
  await h.call('/leave', { playerId: 'pa' });
  h.setTime(h.time() + M.NO_SHOW_BLOCK_MS);
  r = await h.join('pa');
  assert.equal(r.status, 200, 'the block is over');
  await h.call('/leave', { playerId: 'pa' });
});

test('MatchmakerDO: a ticket that never reached the player is not a strike; the room release naming a no-show is one, once per lock', async () => {
  const h = await makeMatchmaker();
  h.leaveInfo.set('pa', { ok: true, slot: 0, ...NEVER });
  // A waits, B forms the room; A's result is never collected (no pending poll) and A leaves (Esc).
  for (let i = 1; i <= M.NO_SHOW_LIMIT; i++) {
    assert.equal((await h.join('pa')).json.status, 'waiting');
    assert.equal((await h.join('py' + i)).json.status, 'matched');
    assert.equal((await h.call('/leave', { playerId: 'pa' })).json.released, true);
    await h.call('/leave', { playerId: 'py' + i });
  }
  assert.equal((await h.call('/stats')).json.noShows, 0, 'never delivered: no strike');
  assert.equal((await h.join('pa')).json.status, 'waiting', 'not blocked');
  await h.call('/leave', { playerId: 'pa' });
  // Delivered, then the room's start drop names A a no-show (POST /release with noShow): one strike.
  const [qa] = await h.pair('pa', 'pz');
  let r = await h.call('/release', { matchId: qa.json.roomId, playerIds: ['pa'], closeRoom: false, noShow: ['pa'] });
  assert.equal(r.json.released, 1);
  assert.equal((await h.call('/stats')).json.noShows, 1);
  r = await h.call('/release', { matchId: qa.json.roomId, playerIds: ['pa'], closeRoom: true, noShow: ['pa'] });
  assert.equal(r.json.released, 0, 'the cleanup finds no lock: no second strike');
  await h.call('/leave', { playerId: 'pz' });
  // Strike 2 through /leave; had the cleanup counted again this would be the third (429).
  const [qa2] = await h.pair('pa', 'pw');
  assert.equal(qa2.json.status, 'matched');
  await h.call('/leave', { playerId: 'pa' });
  await h.call('/leave', { playerId: 'pw' });
  r = await h.join('pa');
  assert.equal(r.status, 200, `two strikes: not blocked yet (${JSON.stringify(r.json)})`);
  await h.call('/leave', { playerId: 'pa' });
  const [qa3] = await h.pair('pa', 'pv');
  assert.equal(qa3.json.status, 'matched');
  await h.call('/leave', { playerId: 'pa' });
  await h.call('/leave', { playerId: 'pv' });
  assert.equal((await h.join('pa')).status, 429, 'the third strike blocks');
});

// ---- RoomDO: an upgrade waiting for TURN, late tickets, forgiven strikes ------------------------------
// The TURN credential fetch in upgrade() opens the input gate (up to 3 s): the no-show pass, a
// /internal/leave or the start may run meanwhile. A verified ticket reaching the room is never a
// no-show: a joining slot is waited for, and a late one (refused 403 'left') is forgiven.

/**
 * globalThis.fetch (what iceServersFor calls for the TURN credentials) under the test's control:
 * after hold() the calls wait until release(); otherwise they answer at once.
 */
function controlTurn() {
  const real = globalThis.fetch;
  const waiting = [];
  let holding = false;
  const answer = () => new RealResponse(JSON.stringify({ iceServers: { urls: ['turn:turn.example:3478?transport=udp'], username: 'u', credential: 'c' } }), { status: 200 });
  globalThis.fetch = () => (holding ? new Promise((resolve) => waiting.push(() => resolve(answer()))) : Promise.resolve(answer()));
  return {
    hold() {
      holding = true;
    },
    release() {
      holding = false;
      for (const w of waiting.splice(0)) w();
    },
    pending: () => waiting.length,
    restore() {
      globalThis.fetch = real;
    },
  };
}

const turnEnv = (mmNs) => ({ JWT_SECRET: SECRET, MATCHMAKER: mmNs, TURN_KEY_ID: 'key', TURN_KEY_TOKEN: 'tok' });
const forgivesOf = (mm) => mm.releases.filter((x) => x.url === 'https://matchmaker/forgive').map((x) => x.body);
const releasesOf = (mm) => mm.releases.filter((x) => x.url === 'https://matchmaker/release').map((x) => x.body);

test('RoomDO: an upgrade still waiting for TURN when the no-show grace passes is not a no-show: the start waits, it is admitted (welcome, no drop) and plays', async () => {
  const turn = controlTurn();
  try {
    await withClock(8_000_000, async (clock) => {
      const mm = makeMatchmakerNs();
      const h = await makeRoom(PEERS_2V2_FULL, '2v2', turnEnv(mm.ns));
      const t0 = clock.t;
      const [a, b, c] = [await h.join(0), await h.join(1), await h.join(2)];
      assert.equal(a.of('room')[0].iceServers.length, 2, 'STUN + the minted TURN entry');
      clock.t = t0 + R.NO_SHOW_MS - 500; // D reaches the room inside the grace; the TURN API is slow
      turn.hold();
      const pendingD = h.upgrade(3);
      await settle();
      assert.equal(turn.pending(), 1, 'D waits for its TURN credentials');
      clock.t = t0 + R.NO_SHOW_MS;
      await h.room.alarm();
      for (const ws of [a, b, c]) assert.deepEqual(ws.of('peerLeft'), [], 'D is joining: not declared a no-show');
      for (const ws of [a, b, c]) await h.send(ws, { type: 'ready' });
      assert.equal(a.of('start').length, 0, 'the start waits for the joining slot');
      turn.release();
      const rd = await pendingD;
      assert.equal(rd.upgraded, true, `D admitted (${rd.status})`);
      const d = h.ctx.sockets.at(-1);
      const w = d.of('room')[0];
      assert.equal(w.you.slot, 3);
      assert.ok(w.slots.every((s) => s.connected && s.left === undefined), 'D sees everyone connected, nobody left');
      assert.deepEqual(d.of('start'), []);
      assert.deepEqual(d.of('drop'), []);
      assert.equal(a.of('peerJoined').at(-1).slot.slot, 3, 'the others learn D joined');
      const p = await h.internal('/internal/presence?playerId=pd');
      assert.deepEqual(p.json, { roomId: 'r1', slot: 3, connected: true, everConnected: true, left: false, dropped: false, started: false });
      await h.send(d, { type: 'ready' });
      for (const ws of [a, b, c, d]) {
        assert.equal(ws.of('start').length, 1, 'start to all four');
        assert.deepEqual(ws.of('drop'), [], 'nobody dropped at tick 0');
      }
      await settle();
      assert.deepEqual(mm.releases, [], 'no lock released, no strike, nothing to forgive');
    });
  } finally {
    turn.restore();
  }
});

test('RoomDO: a slot given up while its upgrade waits for TURN (/internal/leave) is refused 403 left when it resumes; it showed up: the leave answer and the start drop name no no-show, no forgive', async () => {
  const turn = controlTurn();
  try {
    await withClock(9_000_000, async () => {
      const mm = makeMatchmakerNs();
      const h = await makeRoom(PEERS_2V2_FULL, '2v2', turnEnv(mm.ns));
      const [a, b, c] = [await h.join(0), await h.join(1), await h.join(2)];
      const accepted = h.ctx.sockets.length;
      turn.hold();
      const pendingD = h.upgrade(3);
      await settle();
      const r = await h.internal('/internal/leave', { playerId: 'pd' });
      assert.deepEqual(r.json, { ok: true, slot: 3, closed: false, everConnected: false, noShow: false }, 'its ticket reached the room: not a no-show');
      assert.deepEqual(a.of('peerLeft'), [{ type: 'peerLeft', slot: 3, peerId: '' }]);
      turn.release();
      const rd = await pendingD;
      assert.equal(rd.status, 403);
      assert.equal((await rd.json()).error, 'left', 'given up during the await: refused when it resumes');
      assert.equal(h.ctx.sockets.length, accepted, 'no socket accepted');
      assert.equal(a.of('peerJoined').length, 2, 'B and C only');
      const p = await h.internal('/internal/presence?playerId=pd');
      assert.equal(p.json.connected, false);
      assert.equal(p.json.left, true);
      for (const ws of [a, b, c]) await h.send(ws, { type: 'ready' });
      for (const ws of [a, b, c]) {
        assert.equal(ws.of('start').length, 1);
        assert.deepEqual(ws.of('drop'), [{ type: 'drop', slot: 3, atTick: 0 }]);
      }
      await settle();
      assert.deepEqual(releasesOf(mm), [{ matchId: 'r1', playerIds: ['pd'], closeRoom: false }], 'the start drop frees its lock without naming it a no-show');
      assert.deepEqual(forgivesOf(mm), [], 'nothing was counted: nothing to forgive');
    });
  } finally {
    turn.restore();
  }
});

test('RoomDO: an upgrade that waited for TURN through the grace and then fails is declared a no-show right away (peerLeft, the ready ones start)', async () => {
  const turn = controlTurn();
  try {
    await withClock(10_000_000, async (clock) => {
      const h = await makeRoom(PEERS_2V2_FULL, '2v2', turnEnv(ENV.MATCHMAKER));
      const t0 = clock.t;
      const [a, b, c] = [await h.join(0), await h.join(1), await h.join(2)];
      for (const ws of [a, b, c]) await h.send(ws, { type: 'ready' });
      turn.hold();
      const pendingD = h.upgrade(3);
      await settle();
      clock.t = t0 + R.NO_SHOW_MS;
      await h.room.alarm();
      assert.deepEqual(a.of('peerLeft'), [], 'joining: waited for');
      assert.equal(a.of('start').length, 0);
      const get = h.ctx.storage.get.bind(h.ctx.storage);
      h.ctx.storage.get = async (k) => {
        if (String(k).startsWith('jti:')) throw new Error('storage down');
        return get(k);
      };
      turn.release();
      await assert.rejects(pendingD, /storage down/);
      for (const ws of [a, b, c]) {
        assert.deepEqual(ws.of('peerLeft'), [{ type: 'peerLeft', slot: 3, peerId: '' }], 'declared once its upgrade failed');
        assert.equal(ws.of('start').length, 1, 'the ready ones start');
        assert.deepEqual(ws.of('drop'), [{ type: 'drop', slot: 3, atTick: 0 }]);
      }
    });
  } finally {
    turn.restore();
  }
});

test('RoomDO: a ticket arriving after its slot was declared a no-show and dropped -> 403 left + one /forgive (the strike of this room is taken back); the cleanup names nobody', async () => {
  await withClock(11_000_000, async (clock) => {
    const mm = makeMatchmakerNs();
    const h = await makeRoom(PEERS_2V2_FULL, '2v2', { JWT_SECRET: SECRET, MATCHMAKER: mm.ns });
    const t0 = clock.t;
    const [a, b, c] = [await h.join(0), await h.join(1), await h.join(2)];
    clock.t = t0 + R.NO_SHOW_MS;
    await h.room.alarm();
    for (const ws of [a, b, c]) await h.send(ws, { type: 'ready' });
    assert.deepEqual(a.of('drop'), [{ type: 'drop', slot: 3, atTick: 0 }]);
    await settle();
    assert.deepEqual(releasesOf(mm), [{ matchId: 'r1', playerIds: ['pd'], closeRoom: false, noShow: ['pd'] }], 'the start drop names D a no-show (a strike)');
    clock.t += 3000; // a slow mobile join
    let r = await h.upgrade(3);
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error, 'left');
    await settle();
    assert.deepEqual(forgivesOf(mm), [{ matchId: 'r1', playerId: 'pd' }], 'the room asks the matchmaker to take the strike back');
    r = await h.upgrade(3);
    assert.equal(r.status, 403);
    await settle();
    assert.equal(forgivesOf(mm).length, 1, 'once per slot');
    // A slot that had a socket and closed it was never a no-show: refused without a forgive.
    await h.close(c);
    r = await h.upgrade(2);
    assert.equal(r.status, 403);
    await settle();
    assert.equal(forgivesOf(mm).length, 1);
    clock.t = t0 + R.ROOM_TTL_MS;
    await h.room.alarm(); // hard TTL: cleanup
    await settle();
    const last = releasesOf(mm).at(-1);
    assert.equal(last.closeRoom, true, 'the cleanup release');
    assert.equal(last.noShow, undefined, 'D showed up (late): the cleanup names nobody');
  });
});

test('RoomDO: a ticket arriving after the no-show pass but before the start -> 403 left; the start then drops the slot without naming it a no-show', async () => {
  await withClock(12_000_000, async (clock) => {
    const mm = makeMatchmakerNs();
    const h = await makeRoom(PEERS_2V2_FULL, '2v2', { JWT_SECRET: SECRET, MATCHMAKER: mm.ns });
    const t0 = clock.t;
    const [a, b, c] = [await h.join(0), await h.join(1), await h.join(2)];
    clock.t = t0 + R.NO_SHOW_MS;
    await h.room.alarm();
    assert.deepEqual(a.of('peerLeft'), [{ type: 'peerLeft', slot: 3, peerId: '' }]);
    clock.t += 500;
    const r = await h.upgrade(3);
    assert.equal(r.status, 403);
    for (const ws of [a, b, c]) await h.send(ws, { type: 'ready' });
    assert.deepEqual(a.of('drop'), [{ type: 'drop', slot: 3, atTick: 0 }], 'still the team AI from tick 0 (the others stopped waiting)');
    await settle();
    assert.deepEqual(releasesOf(mm), [{ matchId: 'r1', playerIds: ['pd'], closeRoom: false }], 'no noShow: it showed up, late');
    assert.equal((await h.internal('/internal/leave', { playerId: 'pd' })).json.noShow, false);
  });
});

// ---- MatchmakerDO: strikes per room, /forgive ------------------------------------------------------

test('recordNoShow / forgiveNoShow: one strike per room, the window starts over, a forgive takes back only its room', () => {
  let e = M.recordNoShow(undefined, 'r1', 1000);
  assert.deepEqual(e, { count: 1, lastAt: 1000, rooms: ['r1'] });
  assert.equal(M.recordNoShow(e, 'r1', 2000), e, 'the same room again: no second strike');
  e = M.recordNoShow(e, 'r2', 2000);
  e = M.recordNoShow(e, 'r3', 3000);
  assert.deepEqual(e, { count: 3, lastAt: 3000, rooms: ['r1', 'r2', 'r3'] });
  assert.ok(M.noShowBlockedFor(e, 3000) > 0, 'three strikes block');
  const f = M.forgiveNoShow(e, 'r2');
  assert.deepEqual(f, { count: 2, lastAt: 3000, rooms: ['r1', 'r3'] });
  assert.equal(M.noShowBlockedFor(f, 3000), 0, 'below the limit again');
  assert.equal(M.forgiveNoShow(f, 'r9'), f, 'another room: untouched');
  assert.equal(M.forgiveNoShow(M.recordNoShow(undefined, 'r1', 0), 'r1'), null, 'the last strike gone: no entry');
  assert.deepEqual(M.recordNoShow(e, 'r4', 3000 + M.NO_SHOW_WINDOW_MS), { count: 1, lastAt: 3000 + M.NO_SHOW_WINDOW_MS, rooms: ['r4'] }, 'older than the window: the count starts over');
  let g;
  for (let i = 0; i < M.NO_SHOW_ROOMS_KEPT + 3; i++) g = M.recordNoShow(g, 'x' + i, i);
  assert.equal(g.count, M.NO_SHOW_ROOMS_KEPT + 3, 'every room counts');
  assert.equal(g.rooms.length, M.NO_SHOW_ROOMS_KEPT, 'only the newest rooms are kept');
  assert.equal(g.rooms[0], 'x3');
});

test('MatchmakerDO: /forgive takes back the strike of that room only (idempotent); a forgive that overtakes its strike cancels it', async () => {
  const h = await makeMatchmaker();
  /** A room of pa and `partner`; the room's start drop names pa a no-show (optionally after its forgive). */
  const strikeRound = async (partner, forgiveFirst) => {
    const [qa] = await h.pair('pa', partner);
    const roomId = qa.json.roomId;
    if (forgiveFirst) assert.deepEqual((await h.call('/forgive', { matchId: roomId, playerId: 'pa' })).json, { ok: true, forgiven: false }, 'nothing counted yet: remembered');
    assert.equal((await h.call('/release', { matchId: roomId, playerIds: ['pa'], closeRoom: false, noShow: ['pa'] })).json.released, 1);
    await h.call('/leave', { playerId: partner });
    h.setTime(h.time() + 1000);
    return roomId;
  };
  const r1 = await strikeRound('p1', false);
  assert.equal((await h.call('/stats')).json.noShows, 1, 'struck');
  assert.deepEqual((await h.call('/forgive', { matchId: 'f'.repeat(64), playerId: 'pa' })).json, { ok: true, forgiven: false }, 'another room: nothing taken back');
  assert.equal((await h.call('/stats')).json.noShows, 1);
  assert.deepEqual((await h.call('/forgive', { matchId: r1, playerId: 'pa' })).json, { ok: true, forgiven: true });
  assert.equal((await h.call('/stats')).json.noShows, 0);
  assert.deepEqual((await h.call('/forgive', { matchId: r1, playerId: 'pa' })).json, { ok: true, forgiven: false }, 'idempotent');
  for (let i = 2; i <= 4; i++) await strikeRound('p' + i, true);
  assert.equal((await h.call('/stats')).json.noShows, 0, 'each strike was cancelled by the forgive that came first');
  const r = await h.join('pa');
  assert.equal(r.status, 200, `not blocked (${JSON.stringify(r.json)})`);
  await h.call('/leave', { playerId: 'pa' });
  assert.equal((await h.call('/forgive', { playerId: 'pa' })).status, 400);
});

// ---- RoomDO + MatchmakerDO wired together (the Worker's ticket gate in between) ----------------------

const { verifyTicket } = await import('../src/auth.ts');

class WorldCtx extends FakeCtx {
  constructor(pending) {
    super();
    this.pending = pending;
  }
  waitUntil(p) {
    this.pending.push(Promise.resolve(p).catch(() => undefined));
  }
}

/** One real MatchmakerDO and the real RoomDOs it creates, each other's namespace; drain() awaits the rooms' background calls. */
async function makeWorld() {
  const pending = [];
  const rooms = new Map();
  let mm = null;
  const mmNs = { idFromName: (n) => n, get: () => ({ fetch: (url, init) => mm.fetch(new Request(url, init)) }) };
  const roomEnv = { JWT_SECRET: SECRET, MATCHMAKER: mmNs };
  const roomOf = (id) => {
    const key = String(id);
    let r = rooms.get(key);
    if (r === undefined) {
      const ctx = new WorldCtx(pending);
      r = { ctx, room: new R.RoomDO(ctx, roomEnv) };
      rooms.set(key, r);
    }
    return r;
  };
  const roomNs = {
    newUniqueId: () => {
      const id = Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
      return { toString: () => id };
    },
    idFromString: (s) => s,
    get: (id) => ({ fetch: (url, init) => roomOf(id).room.fetch(new Request(url, init)) }),
  };
  const ctx = { storage: new FakeMmStorage(), blockConcurrencyWhile: (fn) => fn() };
  mm = new M.MatchmakerDO(ctx, { JWT_SECRET: SECRET, ROOM: roomNs, MATCH: roomNs, MATCH_LENGTH_SECONDS: 300, REGION_OVERRIDE: '' });
  await settle();
  const secret = await internalSecret(SECRET);
  const call = async (path, body) => {
    const res = await mm.fetch(
      new Request('https://matchmaker' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { [INTERNAL_HEADER]: secret, 'content-type': 'application/json', 'x-region': 'test' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    return { status: res.status, json: await res.json() };
  };
  /** What the Worker's /room gate does: verify the ticket, forward the upgrade with its claims. */
  const upgrade = async (result) => {
    const c = await verifyTicket(SECRET, result.ticket, result.roomId, Date.now(), 'peer');
    assert.ok(c, 'a valid ticket');
    const r = roomOf(result.roomId);
    const res = await r.room.fetch(
      new Request('https://room/room/' + result.roomId, {
        headers: { Upgrade: 'websocket', [INTERNAL_HEADER]: secret, 'x-player-id': c.sub, 'x-slot': String(c.slot), 'x-team': String(c.team), 'x-jti': c.jti },
      }),
    );
    return { res, ws: res.upgraded === true ? r.ctx.sockets.at(-1) : null };
  };
  const drain = async () => {
    while (pending.length > 0) await Promise.all(pending.splice(0));
  };
  return { call, upgrade, drain, roomOf, join: (playerId, mode) => call('/join', { playerId, name: playerId, mode, kind: 'p2p' }) };
}

test('RoomDO + MatchmakerDO: a slow joiner refused after the no-show grace, three rooms in a row, is forgiven each time and never blocked', async () => {
  await withClock(20_000_000, async (clock) => {
    const w = await makeWorld();
    for (let round = 1; round <= M.NO_SHOW_LIMIT; round++) {
      // 2v2 with three humans: the room forms with a bot after the fill wait (A blue, C blue, B red, bot).
      const ids = ['pa', 'pb' + round, 'pc' + round];
      for (const id of ids) assert.equal((await w.join(id, '2v2')).json.status, 'waiting');
      clock.t += M.P2P_FILL_WAIT;
      const res = [];
      for (const id of ids) res.push((await w.join(id, '2v2')).json);
      assert.ok(res.every((r) => r.status === 'matched' && r.kind === 'p2p' && r.roomId === res[0].roomId), `round ${round}: one room for the three`);
      const room = w.roomOf(res[0].roomId).room;
      const t0 = clock.t;
      const b = await w.upgrade(res[1]);
      const c = await w.upgrade(res[2]);
      assert.ok(b.ws !== null && c.ws !== null, 'B and C in');
      clock.t = t0 + R.NO_SHOW_MS;
      await room.alarm();
      for (const ws of [b.ws, c.ws]) await room.webSocketMessage(ws, JSON.stringify({ type: 'ready' }));
      assert.equal(b.ws.of('start').length, 1, 'B and C start without A');
      await w.drain();
      assert.equal((await w.call('/stats')).json.noShows, 1, `round ${round}: the start drop counted A's strike`);
      clock.t += 2500; // A's socket finally gets there
      const a = await w.upgrade(res[0]);
      assert.equal(a.res.status, 403, 'refused: its slot was given up');
      await w.drain();
      assert.equal((await w.call('/stats')).json.noShows, 0, `round ${round}: forgiven`);
      for (const ws of [b.ws, c.ws]) await room.webSocketClose(ws, 1000, '', true);
      await w.drain();
      clock.t += 1000;
    }
    const r = await w.join('pa', '1v1');
    assert.equal(r.status, 200, `A is not blocked: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.status, 'waiting');
    await w.call('/leave', { playerId: 'pa' });
  });
});

// ---- experimental rules (a custom lobby's physics, src/game/physicsRules.ts) ---------------------
// The owner's rule: what matters for P2P and ranked matches is the standard physics; a room with
// experimental rules counts for nothing. RoomDO keeps the rules and hands them to every socket,
// checks every peer's 'ready' fingerprint, never names a no-show; the matchmaker takes rules only
// from a custom lobby's P2P start and never counts a strike for such a room.

const { physicsFingerprint } = await import('../../src/sim/mutators.ts');
const RULES = { v: 1, name: 'Low gravity', values: { gravity: 50, ballDrag: 50 } };
const RULES_FP = physicsFingerprint(RULES);
const STOCK_FP = physicsFingerprint(null);
const PEERS_1V1 = [
  { slot: 0, team: 0, kind: 'peer', name: 'A', playerId: 'pa' },
  { slot: 1, team: 1, kind: 'peer', name: 'B', playerId: 'pb' },
];
const errorsOf = (ws) => ws.of('error').map((e) => e.code);

test('RoomDO: ROOM_PROTOCOL is 5 (experimental rules in the welcome, the ready fingerprint)', () => {
  assert.equal(R.ROOM_PROTOCOL, 5);
  assert.equal(R.PHYSICS_MISMATCH, 'physics_mismatch');
  assert.notEqual(RULES_FP, STOCK_FP);
});

test('RoomDO: physicsReady: with rules the fingerprint is required and must be theirs; standard rooms check one that is present', () => {
  assert.equal(R.physicsReady(RULES, RULES_FP), true);
  assert.equal(R.physicsReady(RULES, STOCK_FP), false, 'a stock arena in an experimental room');
  assert.equal(R.physicsReady(RULES, undefined), false, 'required with rules');
  assert.equal(R.physicsReady(RULES, String(RULES_FP)), false, 'a number, nothing else');
  assert.equal(R.physicsReady(null, undefined), true, 'a standard room lets a ready without one through (headless tools)');
  assert.equal(R.physicsReady(null, STOCK_FP), true);
  assert.equal(R.physicsReady(null, RULES_FP), false, 'a preset arena in a standard room');
});

test('RoomDO: experimental rules are persisted at create and carried by every welcome (first, late, replacement) and /internal/status', async () => {
  const h = await makeRoom(PEERS_1V1, '1v1', ENV, { physics: RULES });
  assert.deepEqual(h.ctx.storage.map.get('record').physics, RULES, 'persisted with the record');
  const a = await h.join(0);
  assert.deepEqual(a.of('room')[0].physics, RULES, 'first socket');
  assert.equal(a.of('room')[0].protocol, 5);
  const b = await h.join(1);
  assert.deepEqual(b.of('room')[0].physics, RULES, 'second socket');
  await h.send(a, { type: 'ready', physicsFp: RULES_FP });
  await h.send(b, { type: 'ready', physicsFp: RULES_FP });
  assert.equal(a.of('start').length, 1, 'the right fingerprints start the match');
  // A replacement socket of a slot after the start (another tab): the same rules again.
  const b2 = await h.join(1);
  assert.deepEqual(b2.of('room')[0].physics, RULES, 'replacement socket');
  assert.equal(b2.of('start').length, 1, 'with the running timeline');
  assert.deepEqual((await h.internal('/internal/status')).json.physics, RULES);
  // A standard room says so (null) in its welcome.
  const s = await makeRoom(PEERS_1V1, '1v1');
  assert.equal((await s.join(0)).of('room')[0].physics, null);
});

test('RoomDO: rules that are not exactly a match snapshot are refused at create (400 bad_physics); a snapshot that changes nothing is standard; rules need signed-in seats (403 account_required)', async () => {
  const secret = await internalSecret(SECRET);
  const create = async (physics, slots = signedIn(PEERS_1V1)) => {
    const room = new R.RoomDO(new FakeCtx(), ENV);
    const res = await room.fetch(
      new Request('https://room/internal/create', {
        method: 'POST',
        headers: { [INTERNAL_HEADER]: secret, 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: 'r9', mode: '1v1', region: 'test', seed: 1, slots, matchLengthSeconds: 300, createdAt: Date.now(), physics }),
      }),
    );
    return { status: res.status, json: await res.json() };
  };
  const bads = [
    { ...RULES, values: { gravity: 47 } }, // off the grid
    { ...RULES, values: { gameSpeed: 50 } }, // free play only
    { ...RULES, values: { gravity: 50, wings: 1 } }, // unknown key
    { ...RULES, v: 2 }, // another table version
    { ...RULES, name: '(copy)' }, // a name the sanitizer would change
    [RULES],
    'Low gravity',
  ];
  for (const bad of bads) {
    const r = await create(bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(r.json.error, 'bad_physics');
  }
  assert.equal((await create({ v: 1, name: 'Standard', values: {} })).status, 200, 'a snapshot that changes nothing');
  const plain = await makeRoom(PEERS_1V1, '1v1', ENV, { physics: { v: 1, name: 'My rules 1', values: {} } });
  assert.equal(plain.ctx.storage.map.get('record').physics, null, 'is a standard room');
  // Signed-in players only: a guest seat, or a seat that does not say guest: false, is refused with rules.
  const guestSeat = [{ ...PEERS_1V1[0], guest: false }, { ...PEERS_1V1[1], guest: true }];
  for (const slots of [guestSeat, PEERS_1V1]) {
    const r = await create(RULES, slots);
    assert.equal(r.status, 403, JSON.stringify(slots));
    assert.equal(r.json.error, 'account_required');
  }
  assert.equal((await create(null, guestSeat)).status, 200, 'a standard room takes guests');
  assert.equal((await create({ v: 1, name: 'Standard', values: {} }, guestSeat)).status, 200, 'so does one whose rules change nothing');
});

test('RoomDO: a ready with another physicsFp gets error physics_mismatch and its socket closed (left, never a no-show); the others start with its car the team AI from tick 0', async () => {
  const mm = makeMatchmakerNs();
  const h = await makeRoom(PEERS_2V2, '2v2', { JWT_SECRET: SECRET, MATCHMAKER: mm.ns }, { physics: RULES });
  const [a, b, c] = [await h.join(0), await h.join(1), await h.join(2)];
  await h.send(a, { type: 'ready', physicsFp: RULES_FP });
  await h.send(b, { type: 'ready', physicsFp: RULES_FP });
  assert.equal(a.of('start').length, 0, 'C connected, not ready');
  await h.send(c, { type: 'ready', physicsFp: STOCK_FP }); // its arena runs the standard physics
  assert.deepEqual(errorsOf(c), ['physics_mismatch']);
  assert.equal(c.readyState, 3, 'its socket is closed');
  assert.equal(c.closed.code, R.CLOSE_PHYSICS_MISMATCH);
  assert.equal(c.of('start').length, 0, 'it never gets the start');
  for (const ws of [a, b]) {
    assert.deepEqual(ws.of('peerLeft').map((m) => m.slot), [2]);
    assert.equal(ws.of('start').length, 1, 'the others start without it');
    assert.deepEqual(ws.of('drop'), [{ type: 'drop', slot: 2, atTick: 0 }], 'its car is the team AI from tick 0');
  }
  await settle();
  assert.ok(mm.releases.every((r) => r.body.noShow === undefined), 'nobody is named a no-show');
  // With rules, a ready that carries no fingerprint is refused as well.
  const h2 = await makeRoom(PEERS_1V1, '1v1', ENV, { physics: RULES });
  const [x, y] = [await h2.join(0), await h2.join(1)];
  await h2.send(x, { type: 'ready' });
  assert.deepEqual(errorsOf(x), ['physics_mismatch']);
  assert.equal(x.readyState, 3);
  await h2.send(y, { type: 'ready', physicsFp: RULES_FP });
  assert.equal(y.of('start').length, 0, 'one human left: no start (the client goes back to its lobby)');
});

test('RoomDO: a standard room starts on a ready without a fingerprint or with the stock one, and refuses a preset arena', async () => {
  const h = await makeRoom(PEERS_2V2, '2v2');
  const [a, b, c] = [await h.join(0), await h.join(1), await h.join(2)];
  await h.send(a, { type: 'ready' });
  await h.send(b, { type: 'ready', physicsFp: STOCK_FP });
  await h.send(c, { type: 'ready', physicsFp: RULES_FP });
  assert.deepEqual(errorsOf(c), ['physics_mismatch'], 'a preset arena in a standard room');
  assert.equal(a.of('start').length, 1);
  assert.deepEqual(a.of('drop'), [{ type: 'drop', slot: 2, atTick: 0 }]);
});

test('RoomDO: a room with experimental rules never names a no-show: not at the start drop, not in /internal/leave, not at the cleanup; no forgive either', async () => {
  await withClock(30_000_000, async (clock) => {
    const mm = makeMatchmakerNs();
    const h = await makeRoom(PEERS_2V2_FULL, '2v2', { JWT_SECRET: SECRET, MATCHMAKER: mm.ns }, { physics: RULES });
    const t0 = clock.t;
    const [a, c] = [await h.join(0), await h.join(2)];
    for (const ws of [a, c]) await h.send(ws, { type: 'ready', physicsFp: RULES_FP });
    // D leaves through the matchmaker before connecting: no no-show in the answer.
    const left = await h.internal('/internal/leave', { playerId: 'pd' });
    assert.equal(left.json.noShow, false, 'never a strike in an experimental room');
    clock.t = t0 + R.NO_SHOW_MS;
    await h.room.alarm(); // B never came: declared left, the start drops it
    assert.deepEqual(a.of('drop'), [{ type: 'drop', slot: 1, atTick: 0 }, { type: 'drop', slot: 3, atTick: 0 }]);
    // B's ticket arrives late: refused, and nothing to forgive.
    assert.equal((await h.upgrade(1)).status, 403);
    clock.t = t0 + R.ROOM_TTL_MS;
    await h.room.alarm(); // the TTL cleanup
    await settle();
    assert.ok(mm.releases.length >= 2, 'the locks were released');
    assert.ok(mm.releases.every((r) => r.body.noShow === undefined), `no release names a no-show: ${JSON.stringify(mm.releases.map((r) => r.body))}`);
    assert.equal(mm.releases.filter((r) => r.url === 'https://matchmaker/forgive').length, 0, 'no forgive');
  });
});

test('MatchmakerDO: /custom takes rules for a P2P room with >= 2 signed-in humans only (400 experimental_p2p_only / bad_physics, 403 account_required), hands them to the RoomDO and marks its locks', async () => {
  const h = await makeMatchmaker();
  const members = [{ playerId: 'pa', name: 'A', team: 0, guest: false }, { playerId: 'pb', name: 'B', team: 1, guest: false }];
  let r = await h.call('/custom', { kind: 'server', mode: '1v1', members, matchLengthSeconds: 300, physics: RULES });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'experimental_p2p_only', 'never a server match');
  r = await h.call('/custom', { kind: 'p2p', mode: '1v1', members: members.slice(0, 1), matchLengthSeconds: 300, physics: RULES });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'experimental_p2p_only', 'a lone human never falls back to a MatchDO with rules');
  r = await h.call('/custom', { kind: 'p2p', mode: '1v1', members, matchLengthSeconds: 300, physics: { ...RULES, values: { gameSpeed: 50 } } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'bad_physics');
  // A guest member (or one the lobby did not mark as signed in) never plays rules.
  for (const second of [{ ...members[1], guest: true }, { playerId: 'pb', name: 'B', team: 1 }]) {
    r = await h.call('/custom', { kind: 'p2p', mode: '1v1', members: [members[0], second], matchLengthSeconds: 300, physics: RULES });
    assert.equal(r.status, 403, JSON.stringify(second));
    assert.equal(r.json.error, 'account_required');
  }
  assert.equal(h.matchNs.calls.length + h.roomNs.calls.length, 0, 'nothing was created for the refused starts');
  r = await h.call('/custom', { kind: 'p2p', mode: '1v1', members, matchLengthSeconds: 300, physics: RULES });
  assert.equal(r.status, 200);
  const create = h.roomNs.calls.find((c) => c.path === '/internal/create');
  assert.deepEqual(create.body.physics, RULES, 'the RoomDO gets the rules');
  assert.deepEqual(create.body.slots.map((x) => x.guest), [false, false], 'and every peer seat signed in');
  assert.equal(h.matchNs.calls.length, 0, 'no MatchDO');
  assert.equal(r.json.results.pa.kind, 'p2p');
  const roomId = r.json.results.pa.roomId;
  assert.equal((await h.mm.ctx.storage.get('active:pa')).exp, true, 'the lock is marked (and persisted)');
  assert.equal((await h.mm.ctx.storage.get('room:' + roomId)).exp, true, 'the capacity entry too');
  // A standard lobby's start (guests welcome): physics null, an ordinary room, its seats as before.
  r = await h.call('/custom', { kind: 'p2p', mode: '1v1', members: [{ playerId: 'pc', name: 'C', team: 0, guest: true }, { playerId: 'pd', name: 'D', team: 1 }], matchLengthSeconds: 300, physics: null });
  assert.equal(r.status, 200);
  const plainCreate = h.roomNs.calls.filter((c) => c.path === '/internal/create').at(-1).body;
  assert.equal(plainCreate.physics, null);
  assert.equal(plainCreate.slots.some((x) => 'guest' in x), false, 'a standard room create is unchanged');
  assert.equal((await h.mm.ctx.storage.get('active:pc')).exp, undefined);
});

test('MatchmakerDO: /join refuses rules (400 experimental_lobby_only): the casual and ranked queues run the standard physics', async () => {
  const h = await makeMatchmaker();
  for (const kind of ['p2p', 'server', 'ranked']) {
    const r = await h.call('/join', { playerId: 'pa', name: 'A', mode: '1v1', kind, physics: RULES, ratings: { '1v1': { mu: 25, sigma: 8 } } });
    assert.equal(r.status, 400, kind);
    assert.equal(r.json.error, 'experimental_lobby_only');
  }
  assert.equal((await h.call('/stats')).json.active, 0, 'nobody queued');
  const ok = await h.call('/join', { playerId: 'pa', name: 'A', mode: '1v1', kind: 'p2p', physics: null });
  assert.equal(ok.json.status, 'waiting', 'null is the standard physics');
  await h.call('/leave', { playerId: 'pa' });
});

test('MatchmakerDO: a room with experimental rules never counts a no-show strike, even from a release or a leave that names one', async () => {
  const h = await makeMatchmaker();
  h.leaveInfo.set('pa', { ok: true, slot: 0, ...NEVER }); // a room answer that would be a strike
  const members = [{ playerId: 'pa', name: 'A', team: 0, guest: false }, { playerId: 'pb', name: 'B', team: 1, guest: false }];
  for (let i = 0; i < M.NO_SHOW_LIMIT + 1; i++) {
    const r = await h.call('/custom', { kind: 'p2p', mode: '1v1', members, matchLengthSeconds: 300, physics: RULES });
    assert.equal(r.status, 200, `round ${i}`);
    const roomId = r.json.results.pa.roomId;
    if (i % 2 === 0) await h.call('/release', { matchId: roomId, playerIds: ['pa', 'pb'], closeRoom: true, noShow: ['pa'] });
    else {
      await h.call('/leave', { playerId: 'pa' });
      await h.call('/leave', { playerId: 'pb' });
    }
    h.setTime(h.time() + 1000);
  }
  assert.equal((await h.call('/stats')).json.noShows, 0, 'no strike at all');
  const q = await h.join('pa');
  assert.equal(q.status, 200, 'the p2p queue is not blocked');
  await h.call('/leave', { playerId: 'pa' });
});

test('RoomDO + MatchmakerDO: an experimental lobby start: the rules reach every welcome, a peer that never comes is dropped without a strike', async () => {
  await withClock(40_000_000, async (clock) => {
    const w = await makeWorld();
    const members = [{ playerId: 'pa', name: 'A', team: 0, guest: false }, { playerId: 'pb', name: 'B', team: 0, guest: false }, { playerId: 'pc', name: 'C', team: 1, guest: false }];
    const r = await w.call('/custom', { kind: 'p2p', mode: '2v2', members, matchLengthSeconds: 300, physics: RULES });
    assert.equal(r.status, 200);
    const res = r.json.results;
    const room = w.roomOf(res.pa.roomId).room;
    const t0 = clock.t;
    const a = await w.upgrade(res.pa);
    const b = await w.upgrade(res.pb);
    assert.deepEqual(a.ws.of('room')[0].physics, RULES);
    assert.deepEqual(b.ws.of('room')[0].physics, RULES);
    for (const ws of [a.ws, b.ws]) await room.webSocketMessage(ws, JSON.stringify({ type: 'ready', physicsFp: RULES_FP }));
    clock.t = t0 + R.NO_SHOW_MS;
    await room.alarm();
    assert.equal(a.ws.of('start').length, 1, 'A and B start without C');
    assert.equal(a.ws.of('drop').length, 1, "C's car is the team AI from tick 0");
    await w.drain();
    assert.equal((await w.call('/stats')).json.noShows, 0, 'C never showed up: no strike in an experimental room');
  });
});

// ---- cosmetic cars: a seat's car from the queue to every welcome (src/net/cosmetics.ts) ---------------

test('buildRoster / buildTeamRoster: a human seat carries its car, a bot none; a roster without cars is the same as before', () => {
  const humans = [{ playerId: 'a', name: 'A', car: 'tero' }, { playerId: 'b', name: 'B' }];
  const r = M.buildRoster(2, humans, 'peer');
  assert.deepEqual(r.map((e) => [e.slot, e.kind, e.playerId ?? null, e.car ?? null]), [[0, 'peer', 'a', 'tero'], [1, 'bot', null, null], [2, 'peer', 'b', null], [3, 'bot', null, null]]);
  assert.equal('car' in r[2], false, 'no car key at all for the default car');
  const t = M.buildTeamRoster(1, [[{ playerId: 'b', name: 'B' }], [{ playerId: 'a', name: 'A', car: 'condor' }]], 'player');
  assert.deepEqual(t.map((e) => e.car ?? null), [null, 'condor']);
  assert.deepEqual(M.buildRoster(1, [{ playerId: 'a', name: 'A' }], 'player'), [
    { slot: 0, team: 0, kind: 'player', name: 'A', playerId: 'a' },
    { slot: 1, team: 1, kind: 'bot', name: 'Bot 1' },
  ]);
});

test('RoomDO: every welcome and peerJoined carry each peer seat\'s car; a car the catalog does not know is dropped, a bot has none; persisted with the record', async () => {
  const slots = [
    { slot: 0, team: 0, kind: 'peer', name: 'A', playerId: 'pa', car: 'tero' },
    { slot: 1, team: 0, kind: 'peer', name: 'B', playerId: 'pb', car: 'lamborghini' },
    { slot: 2, team: 1, kind: 'peer', name: 'C', playerId: 'pc' },
    { slot: 3, team: 1, kind: 'bot', name: 'Bot 2', car: 'pampero' },
  ];
  const h = await makeRoom(slots);
  assert.deepEqual(h.ctx.storage.map.get('record').slots.map((s) => s.car ?? null), ['tero', null, null, null]);
  const a = await h.join(0);
  assert.deepEqual(a.of('room')[0].slots.map((s) => s.car ?? null), ['tero', null, null, null]);
  assert.equal('car' in a.of('room')[0].slots[2], false, 'the default car: no field, as before cars');
  const b = await h.join(1);
  assert.deepEqual(b.of('room')[0].slots.map((s) => s.car ?? null), ['tero', null, null, null], 'a late welcome too');
  assert.equal(a.of('peerJoined')[0].slot.car, undefined, 'B drives the default car');
  await h.join(2);
  assert.equal(a.of('peerJoined').length, 2);
  const a2 = await h.join(0);
  assert.equal(a2.of('room')[0].slots[0].car, 'tero', 'a replacement socket (the others hear no peerJoined for it)');
});

test('MatchmakerDO: the /join car sits with the seat: a P2P room\'s slots and a server match\'s roster carry it; a junk one is dropped; a rejoin with a new session takes the new car', async () => {
  const h = await makeMatchmaker();
  const join = (playerId, kind, car) => h.call('/join', { playerId, name: playerId, mode: '1v1', kind, ...(car !== undefined ? { car } : {}) });
  assert.equal((await join('pa', 'p2p', 'tero')).json.status, 'waiting');
  assert.equal((await join('pa', 'p2p', 'pampero')).json.status, 'waiting', 'the same waiter, a newer session');
  await join('pb', 'p2p', 'ferrari');
  const room = h.roomNs.calls.find((c) => c.path === '/internal/create');
  assert.deepEqual(room.body.slots.map((s) => [s.playerId ?? null, s.car ?? null]), [['pa', 'pampero'], ['pb', null]]);
  await join('sa', 'server', 'condor');
  await join('sb', 'server');
  const match = h.matchNs.calls.find((c) => c.path === '/internal/create');
  assert.deepEqual(match.body.roster.map((e) => [e.kind, e.car ?? null]), [['player', 'condor'], ['player', null]]);
});

test('MatchmakerDO /custom: each lobby member\'s car into the room slots and the MatchDO roster (a junk one dropped)', async () => {
  const h = await makeMatchmaker();
  const members = [{ playerId: 'pa', name: 'A', team: 0, guest: false, car: 'tero' }, { playerId: 'pb', name: 'B', team: 1, guest: true, car: 7 }];
  assert.equal((await h.call('/custom', { kind: 'p2p', mode: '2v2', members, matchLengthSeconds: 300 })).status, 200);
  const room = h.roomNs.calls.filter((c) => c.path === '/internal/create').at(-1);
  assert.deepEqual(room.body.slots.map((s) => [s.kind, s.car ?? null]), [['peer', 'tero'], ['bot', null], ['peer', null], ['bot', null]]);
  assert.equal((await h.call('/custom', { kind: 'server', mode: '1v1', members: [{ playerId: 'pc', name: 'C', team: 1, guest: false, car: 'carpincho' }], matchLengthSeconds: 300 })).status, 200);
  const match = h.matchNs.calls.filter((c) => c.path === '/internal/create').at(-1);
  assert.deepEqual(match.body.roster.map((e) => [e.kind, e.car ?? null]), [['bot', null], ['player', 'carpincho']]);
});

test('RoomDO + MatchmakerDO: a lobby start with cars: each peer\'s welcome shows every seat\'s car', async () => {
  await withClock(50_000_000, async () => {
    const w = await makeWorld();
    const members = [{ playerId: 'pa', name: 'A', team: 0, guest: false, car: 'condor' }, { playerId: 'pb', name: 'B', team: 1, guest: false }];
    const r = await w.call('/custom', { kind: 'p2p', mode: '1v1', members, matchLengthSeconds: 300 });
    assert.equal(r.status, 200);
    const a = await w.upgrade(r.json.results.pa);
    const b = await w.upgrade(r.json.results.pb);
    for (const ws of [a.ws, b.ws]) assert.deepEqual(ws.of('room')[0].slots.map((s) => s.car ?? null), ['condor', null]);
    await w.drain();
  });
});
