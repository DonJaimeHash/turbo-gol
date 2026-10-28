// LobbyDO's lobby keeps a member whose socket dropped (plan PR 12): the grace before the member is
// removed and the host passed on, the way back (the same player's socket within it), the start that
// waits for nobody away, the host's own actions (hand the lobby over, move a member) and LISTO, and
// the Worker's GET /api/lobbies/peek (a join link's sheet). 'cloudflare:workers' is stubbed; the
// clock is Date.now, moved by hand. Run from server/: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const DO_STUB = 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }';
const WASM_STUB = 'data:text/javascript,export const createHostArena = () => { throw new Error("no wasm in this test"); };';
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

const L = await import('../src/LobbyDO.ts');
const worker = (await import('../src/index.ts')).default;
const { INTERNAL_HEADER, internalSecret, createSession } = await import('../src/auth.ts');

const SECRET = 'lobby-grace-test-secret';
const ORIGIN = 'https://turbo-gol.com';

// ---- the clock ----------------------------------------------------------------------------------

const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;
const advance = (ms) => (clock += ms);

// ---- LobbyDO on fakes (as experimental-lobby.test.mjs, plus getAlarm) ----------------------------

class FakeSocket {
  constructor() {
    this.readyState = 1;
    this.sent = [];
    this.closed = null;
  }
  send(text) {
    if (this.readyState !== 1) throw new Error('send on a closed socket');
    this.sent.push(JSON.parse(text));
  }
  close(code, reason) {
    this.readyState = 3;
    this.closed = { code, reason };
  }
  of(t) {
    return this.sent.filter((m) => m.t === t);
  }
  last() {
    return this.of('state').at(-1).lobby;
  }
}

globalThis.WebSocketPair = class WebSocketPair {
  constructor() {
    this[0] = new FakeSocket();
    this[1] = new FakeSocket();
  }
};
globalThis.WebSocketRequestResponsePair = class WebSocketRequestResponsePair {};
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
  async getAlarm() {
    return this.alarm;
  }
  async setAlarm(t) {
    this.alarm = t;
  }
  async deleteAlarm() {
    this.alarm = null;
  }
}

class FakeLobbyCtx {
  constructor() {
    this.storage = new FakeStorage();
    this.sockets = [];
  }
  blockConcurrencyWhile(fn) {
    return fn();
  }
  setWebSocketAutoResponse() {}
  acceptWebSocket(ws, tags) {
    ws.tags = tags;
    this.sockets.push(ws);
  }
  getWebSockets(tag) {
    return this.sockets.filter((w) => w.readyState === 1 && (tag === undefined || w.tags.includes(tag)));
  }
  getTags(ws) {
    return ws.tags ?? [];
  }
}

function fakeNs(handler) {
  const calls = [];
  return {
    calls,
    ns: {
      idFromName: (n) => n,
      idFromString: (s) => s,
      newUniqueId: () => ({ toString: () => 'ab'.repeat(32) }),
      get: () => ({
        fetch: async (url, init) => {
          const u = new URL(url);
          const body = init && init.body ? JSON.parse(init.body) : null;
          calls.push({ path: u.pathname, body });
          const r = await handler(u.pathname, body);
          return r instanceof RealResponse ? r : new RealResponse(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
        },
      }),
    },
  };
}

const jti = () => Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

async function makeLobby(settings = { name: 'Sala', mode: '2v2', visibility: 'private', net: 'p2p', matchLengthSeconds: 300 }) {
  const ctx = new FakeLobbyCtx();
  const mm = fakeNs((path, body) => (path === '/custom' ? { results: Object.fromEntries(body.members.map((m) => [m.playerId, { status: 'matched', kind: 'p2p', roomId: 'r', ticket: 't', wsUrl: '/room/r' }])) } : { ok: true }));
  const dir = fakeNs(() => ({ ok: true }));
  const lobby = new L.LobbyDO(ctx, { JWT_SECRET: SECRET, MATCHMAKER: mm.ns, LOBBY_DIR: dir.ns });
  const secret = await internalSecret(SECRET);
  const req = async (method, path, body) => {
    const res = await lobby.fetch(new Request('https://lobby' + path, { method, headers: { [INTERNAL_HEADER]: secret, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }));
    return { status: res.status, json: await res.json() };
  };
  await req('POST', '/internal/create', { lobbyId: 'L1', code: 'ABCDEF', region: 'SA', socketBase: 'wss://x', settings, host: { playerId: 'host1', name: 'Ana', guest: true } });
  const h = { ctx, lobby, mm, dir, req };
  h.admit = (playerId) => req('POST', '/internal/admit', { playerId, name: playerId, guest: true });
  h.upgrade = async (playerId) => {
    const res = await lobby.fetch(new Request('https://lobby/lobby', { headers: { Upgrade: 'websocket', [INTERNAL_HEADER]: secret, 'x-player-id': playerId, 'x-jti': jti() } }));
    return res.upgraded === true ? ctx.sockets.at(-1) : null;
  };
  /** A member that joins (admit + socket). */
  h.join = async (playerId) => {
    assert.equal((await h.admit(playerId)).status, 200);
    return h.upgrade(playerId);
  };
  h.send = (ws, msg) => lobby.webSocketMessage(ws, JSON.stringify(msg));
  /** The socket drops (no leave): the network, a phone that put the tab away. */
  h.drop = async (ws) => {
    ws.readyState = 3;
    await lobby.webSocketClose(ws, 1006, '');
  };
  h.alarm = () => lobby.alarm();
  return h;
}

const byName = (st, name) => st.members.find((m) => m.name === name);

test('a dropped socket keeps the member and the host role for the grace; the same player back within it is still host', async () => {
  const h = await makeLobby();
  const host = await h.upgrade('host1');
  const bea = await h.join('bea');
  await h.drop(host);
  let st = bea.last();
  assert.equal(st.members.length, 2, 'still in the lobby');
  assert.equal(byName(st, 'Ana').host, true, 'still the host');
  assert.equal(byName(st, 'Ana').away, true, 'shown as away');
  assert.ok(h.ctx.storage.alarm !== null && h.ctx.storage.alarm <= clock + L.LOBBY_GRACE_MS, 'an alarm by the end of the grace');
  // 20 s later (WhatsApp, then back): the join again goes through (an existing member), the socket too.
  advance(20_000);
  await h.alarm();
  assert.equal(bea.last().members.length, 2, 'not removed before the grace');
  assert.equal((await h.admit('host1')).status, 200);
  const again = await h.upgrade('host1');
  assert.ok(again, 'the socket is taken');
  st = again.last();
  assert.equal(st.members.find((m) => m.id === st.you).host, true, 'back as host');
  assert.equal(byName(st, 'Ana').away, false);
  advance(L.LOBBY_GRACE_MS);
  await h.alarm();
  assert.equal(bea.last().members.length, 2, 'nobody removed once back');
});

test('past the grace the member goes and the host passes to the longest-standing member still connected', async () => {
  assert.ok(L.LOBBY_GRACE_MS >= 30_000 && L.LOBBY_GRACE_MS <= 45_000, 'the plan: 30 to 45 s');
  const h = await makeLobby({ name: 'Sala', mode: '3v3', visibility: 'private', net: 'p2p', matchLengthSeconds: 300 });
  const host = await h.upgrade('host1');
  advance(10);
  const bea = await h.join('bea');
  advance(10);
  const caro = await h.join('caro');
  await h.drop(bea); // the next in line is away too: the host skips her
  await h.drop(host);
  advance(L.LOBBY_GRACE_MS - 1);
  await h.alarm();
  assert.equal(caro.last().members.length, 3);
  advance(1);
  await h.alarm();
  const st = caro.last();
  assert.deepEqual(st.members.map((m) => m.name), ['caro'], 'both removed at the end of their grace');
  assert.equal(st.members[0].host, true);
  // The last member away past the grace: the lobby closes.
  await h.drop(caro);
  advance(L.LOBBY_GRACE_MS);
  await h.alarm();
  assert.equal(h.dir.calls.at(-1).path, '/remove', 'gone from the directory');
  assert.equal((await h.admit('caro')).status, 410);
});

test('an explicit leave or a kick removes at once (no grace); the kicked player cannot come back', async () => {
  const h = await makeLobby();
  const host = await h.upgrade('host1');
  const bea = await h.join('bea');
  const caro = await h.join('caro');
  await h.send(bea, { t: 'leave' });
  assert.deepEqual(host.last().members.map((m) => m.name), ['Ana', 'caro']);
  await h.send(host, { t: 'kick', member: byName(host.last(), 'caro').id });
  assert.equal(caro.closed.code, 4003);
  assert.deepEqual(host.last().members.map((m) => m.name), ['Ana']);
  assert.equal((await h.admit('caro')).json.error, 'kicked');
});

test('the start waits for nobody away (member_away); back in, it goes', async () => {
  const h = await makeLobby();
  const host = await h.upgrade('host1');
  const bea = await h.join('bea');
  await h.drop(bea);
  await h.send(host, { t: 'start' });
  assert.deepEqual(host.of('error').map((e) => e.code), ['member_away']);
  assert.equal(h.mm.calls.length, 0);
  await h.admit('bea');
  await h.upgrade('bea');
  await h.send(host, { t: 'start' });
  assert.equal(h.mm.calls.filter((c) => c.path === '/custom').length, 1);
});

test('the host hands the lobby over and moves a member; only the host; LISTO is shown and cleared by a move and the start', async () => {
  const h = await makeLobby();
  const host = await h.upgrade('host1');
  const bea = await h.join('bea');
  const beaId = byName(host.last(), 'bea').id;
  assert.equal(byName(host.last(), 'bea').team, 1, 'the team with fewer members');
  await h.send(bea, { t: 'ready', ready: true });
  assert.equal(byName(host.last(), 'bea').ready, true);
  await h.send(host, { t: 'move', member: beaId, team: 0 });
  assert.equal(byName(host.last(), 'bea').team, 0);
  assert.equal(byName(host.last(), 'bea').ready, false, 'a move clears LISTO');
  await h.send(bea, { t: 'move', member: byName(bea.last(), 'Ana').id, team: 1 });
  await h.send(bea, { t: 'host', member: byName(bea.last(), 'Ana').id });
  assert.deepEqual(bea.of('error').map((e) => e.code), ['not_host', 'not_host']);
  await h.send(host, { t: 'host', member: beaId });
  assert.equal(byName(host.last(), 'bea').host, true);
  assert.equal(byName(host.last(), 'Ana').host, false);
  // Now bea starts; LISTO goes with the start.
  await h.send(host, { t: 'ready', ready: true });
  await h.send(bea, { t: 'start' });
  assert.equal(h.mm.calls.filter((c) => c.path === '/custom').length, 1);
  assert.equal(byName(host.last(), 'Ana').ready, false);
});

test('a full team refuses the move (team_full)', async () => {
  const h = await makeLobby({ name: 'Sala', mode: '1v1', visibility: 'private', net: 'p2p', matchLengthSeconds: 300 });
  const host = await h.upgrade('host1');
  await h.join('bea');
  await h.send(host, { t: 'move', member: byName(host.last(), 'bea').id, team: 0 });
  assert.deepEqual(host.of('error').map((e) => e.code), ['team_full']);
});

test('LobbyDO /internal/peek: the summary while the lobby lives, 410 once closed', async () => {
  const h = await makeLobby();
  const host = await h.upgrade('host1');
  await h.join('bea');
  const p = await h.req('GET', '/internal/peek');
  assert.equal(p.status, 200);
  assert.equal(p.json.code, 'ABCDEF');
  assert.equal(p.json.mode, '2v2');
  assert.equal(p.json.players, 2);
  assert.equal(p.json.max, 4);
  await h.send(host, { t: 'leave' });
  const bea = h.ctx.sockets.at(-1);
  await h.send(bea, { t: 'leave' });
  assert.equal((await h.req('GET', '/internal/peek')).status, 410);
});

test('Worker: GET /api/lobbies/peek?code= resolves the code and answers the lobby summary; a bad code 400, an unknown one 404', async () => {
  const summary = { code: 'ABCDEF', name: 'Sala de Ana', mode: '2v2', players: 2, max: 4, locked: false, host: 'Ana', region: 'SA', inGame: false, net: 'p2p', experimental: false, physics: null };
  const lobby = fakeNs((path) => (path === '/internal/peek' ? summary : { ok: true }));
  const dir = fakeNs((path) => (path === '/resolve' ? { lobbyId: 'ab'.repeat(32) } : { ok: true }));
  const env = { JWT_SECRET: SECRET, VITE_ORIGINS: ORIGIN, FLAGS: { get: async () => null }, LOBBY: lobby.ns, LOBBY_DIR: dir.ns };
  const call = async (path) => {
    const res = await worker.fetch(new Request(ORIGIN + path, { headers: { 'CF-Connecting-IP': '203.0.113.7', Origin: ORIGIN } }), env);
    return { status: res.status, json: await res.json() };
  };
  const ok = await call('/api/lobbies/peek?code=abc-def');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, summary);
  assert.equal(dir.calls[0].path, '/resolve');
  assert.equal((await call('/api/lobbies/peek?code=AB1')).json.error, 'bad_code');
  const none = fakeNs(() => new RealResponse(JSON.stringify({ error: 'no_lobby' }), { status: 404 }));
  const res = await worker.fetch(new Request(ORIGIN + '/api/lobbies/peek?code=ABCDEF', { headers: { 'CF-Connecting-IP': '203.0.113.8', Origin: ORIGIN } }), { ...env, LOBBY_DIR: none.ns });
  assert.equal(res.status, 404);
  // No session needed (a guest's first visit by a link has none yet).
  assert.ok(await createSession(SECRET, '0123456789abcdef', 'x'));
});

test.after(() => {
  Date.now = realNow;
});
