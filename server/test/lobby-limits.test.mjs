// Security limits of the custom lobbies (server/src/LobbyDO.ts, server/src/LobbyDirectoryDO.ts and
// the Worker's POST /api/lobbies): the per-socket message budget, frames that change nothing, the
// coalesced directory publish and the cap on live lobbies per session / IPv6 /64 (audit cost-3,
// rt-1). 'cloudflare:workers' is stubbed; the clock is Date.now, moved by hand. Run from server/:
// npm test
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
const D = await import('../src/LobbyDirectoryDO.ts');
const worker = (await import('../src/index.ts')).default;
const { INTERNAL_HEADER, internalSecret, createSession } = await import('../src/auth.ts');

const SECRET = 'lobby-limits-test-secret';
const ORIGIN = 'https://turbo-gol.com';

// ---- the clock ----------------------------------------------------------------------------------

const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;
const advance = (ms) => (clock += ms);
test.after(() => {
  Date.now = realNow;
});

// ---- fakes (as lobby-grace.test.mjs, plus a count of storage writes) -----------------------------

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
    this.puts = 0;
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
  async list({ prefix }) {
    const out = new Map();
    for (const [k, v] of this.map) if (k.startsWith(prefix)) out.set(k, structuredClone(v));
    return out;
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

async function makeLobby(settings = { name: 'Sala', mode: '2v2', visibility: 'public', net: 'p2p', matchLengthSeconds: 300 }) {
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
  h.admit = (playerId, extra = {}) => req('POST', '/internal/admit', { playerId, name: playerId, guest: true, ...extra });
  h.upgrade = async (playerId) => {
    const res = await lobby.fetch(new Request('https://lobby/lobby', { headers: { Upgrade: 'websocket', [INTERNAL_HEADER]: secret, 'x-player-id': playerId, 'x-jti': jti() } }));
    return res.upgraded === true ? ctx.sockets.at(-1) : { refused: res.status, json: await res.json() };
  };
  h.join = async (playerId) => {
    assert.equal((await h.admit(playerId)).status, 200);
    return h.upgrade(playerId);
  };
  h.send = (ws, msg) => lobby.webSocketMessage(ws, JSON.stringify(msg));
  h.upserts = () => dir.calls.filter((c) => c.path === '/upsert').length;
  h.customs = () => mm.calls.filter((c) => c.path === '/custom').length;
  h.alarm = () => lobby.alarm();
  return h;
}

const byName = (st, name) => st.members.find((m) => m.name === name);

// ---- cost-3 / rt-1: the message budget ------------------------------------------------------------

test('LobbyDO: a flood of 1000 frames from one socket is cut off: a bounded number of writes and directory upserts, then 1008 rate', async () => {
  const h = await makeLobby();
  const host = await h.upgrade('host1');
  const bea = await h.join('bea');
  advance(10_000);
  const puts0 = h.ctx.storage.puts;
  const ups0 = h.upserts();
  let ready = false;
  for (let i = 0; i < 1000 && bea.readyState === 1; i++) {
    ready = !ready; // every frame a real change: LISTO on, off, on...
    await h.send(bea, { t: 'ready', ready });
  }
  assert.deepEqual(bea.closed, { code: 1008, reason: 'rate' }, 'the flooding socket is closed');
  assert.ok(h.ctx.storage.puts - puts0 <= 25, `writes bounded by the budget (${h.ctx.storage.puts - puts0})`);
  assert.ok(h.upserts() - ups0 <= 1, `directory upserts bounded (${h.upserts() - ups0})`);
  assert.equal(host.readyState, 1, 'the others stay');
});

test('LobbyDO: frames that change nothing (LISTO again, the same team, the same settings) write, broadcast and publish nothing', async () => {
  const h = await makeLobby();
  const host = await h.upgrade('host1');
  const bea = await h.join('bea');
  await h.send(bea, { t: 'ready', ready: true });
  advance(60_000);
  const puts0 = h.ctx.storage.puts;
  const ups0 = h.upserts();
  const states0 = host.of('state').length;
  for (let i = 0; i < 10; i++) {
    await h.send(bea, { t: 'ready', ready: true });
    await h.send(bea, { t: 'team', team: byName(bea.last(), 'bea').team });
    await h.send(host, { t: 'settings', settings: {} });
    advance(1_000);
  }
  assert.equal(h.ctx.storage.puts - puts0, 0, 'no storage write');
  assert.equal(h.upserts() - ups0, 0, 'no directory upsert');
  assert.equal(host.of('state').length - states0, 0, 'no broadcast');
  assert.equal(bea.readyState, 1);
});

test('LobbyDO: the directory hears of changes at most every PUBLISH_MIN_MS; one held back goes out with the alarm armed for then', async () => {
  const h = await makeLobby();
  await h.upgrade('host1');
  advance(10_000);
  const ups0 = h.upserts();
  const bea = await h.join('bea'); // players 1 -> 2: published at once (the last one is old)
  assert.equal(h.upserts() - ups0, 1);
  await h.join('caro'); // 2 -> 3 within the window: held back
  await h.send(bea, { t: 'leave' }); // 3 -> 2: still held back
  assert.equal(h.upserts() - ups0, 1, 'nothing more inside the window');
  assert.ok(h.ctx.storage.alarm !== null && h.ctx.storage.alarm <= clock + 5_000, 'the alarm is armed for the end of the window');
  advance(5_000);
  await h.alarm();
  assert.equal(h.upserts() - ups0, 2, 'the alarm sends the row as it is now');
  assert.equal(h.dir.calls.filter((c) => c.path === '/upsert').at(-1).body.summary.players, 2);
});

test('LobbyDO: a full 3v3 lobby used normally (joins, LISTO, teams, settings, a start and FINAL) never trips the budget', async () => {
  const h = await makeLobby({ name: 'Sala', mode: '3v3', visibility: 'private', net: 'p2p', matchLengthSeconds: 300 });
  const host = await h.upgrade('host1');
  const others = [];
  for (const p of ['b', 'c', 'd', 'e', 'f']) others.push(await h.join(p));
  // Everybody flips LISTO and the team a few times in quick succession (a TV's arrows, a phone's taps).
  for (let round = 0; round < 3; round++) {
    for (const ws of [host, ...others]) {
      await h.send(ws, { t: 'ready', ready: true });
      await h.send(ws, { t: 'ready', ready: false });
    }
    await h.send(host, { t: 'settings', settings: { name: 'Sala ' + round } });
    advance(300);
  }
  await h.send(host, { t: 'start' });
  assert.equal(h.customs(), 1, 'the start went through');
  for (const ws of [host, ...others]) await h.send(ws, { t: 'back' });
  for (const ws of [host, ...others]) assert.equal(ws.readyState, 1, 'no socket closed');
  assert.equal(host.last().members.length, 6);
});

// ---- cost-3 / rt-1: live lobbies per session and per IPv6 /64 -------------------------------------

async function makeDirectory() {
  const storage = new FakeStorage();
  const ctx = { storage, blockConcurrencyWhile: (fn) => fn() };
  const dir = new D.LobbyDirectoryDO(ctx, { JWT_SECRET: SECRET });
  const secret = await internalSecret(SECRET);
  let n = 0;
  const post = async (path, body) => {
    const res = await dir.fetch(new Request('https://lobbies' + path, { method: 'POST', headers: { [INTERNAL_HEADER]: secret, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    return { status: res.status, json: await res.json() };
  };
  const allocate = (owner, ip) => post('/allocate', { lobbyId: 'lobby' + ++n, owner, ip });
  return { dir, post, allocate };
}

test('LobbyDirectoryDO: a session has at most 3 live lobbies (429 too_many_lobbies); one removed frees its place; stale rows do not count', async () => {
  const d = await makeDirectory();
  const codes = [];
  for (let i = 0; i < 3; i++) {
    const r = await d.allocate('guest1', '198.51.100.7');
    assert.equal(r.status, 200);
    codes.push({ code: r.json.code, lobbyId: 'lobby' + (i + 1) });
  }
  const refused = await d.allocate('guest1', '198.51.100.7');
  assert.equal(refused.status, 429);
  assert.equal(refused.json.error, 'too_many_lobbies');
  // The lobby's own upsert keeps its owner.
  assert.equal((await d.post('/upsert', { ...codes[0], visibility: 'public', summary: null })).status, 200);
  assert.equal((await d.allocate('guest1', '198.51.100.7')).status, 429, 'an upsert does not reset the owner');
  assert.equal((await d.post('/remove', codes[1])).status, 200);
  assert.equal((await d.allocate('guest1', '198.51.100.7')).status, 200, 'a closed lobby frees its place');
  advance(16 * 60_000);
  assert.equal((await d.allocate('guest1', '198.51.100.7')).status, 200, 'rows past STALE_MS do not count');
});

test('LobbyDirectoryDO: an IPv4 address is never capped (a school, a carrier NAT); an IPv6 /64 has at most 10 live lobbies', async () => {
  const d = await makeDirectory();
  for (let i = 0; i < 30; i++) assert.equal((await d.allocate('school' + i, '203.0.113.50')).status, 200, `school session ${i}`);
  for (let i = 0; i < 10; i++) assert.equal((await d.allocate('home' + i, `2001:db8:1:2:${i.toString(16)}::1`)).status, 200);
  const r = await d.allocate('home-next', '2001:db8:1:2:ffff::9');
  assert.equal(r.status, 429, 'the same /64');
  assert.equal(r.json.error, 'too_many_lobbies');
  assert.equal((await d.allocate('other-net', '2001:db8:1:3::1')).status, 200, 'another /64');
});

test('Worker: POST /api/lobbies hands the directory the session and the address, and passes its 429 on', async () => {
  const lobby = fakeNs(() => ({ ok: true }));
  let refuse = false;
  const dir = fakeNs((path) => (path === '/allocate' ? (refuse ? new RealResponse(JSON.stringify({ error: 'too_many_lobbies', message: 'x' }), { status: 429 }) : { code: 'ABCDEF' }) : { ok: true }));
  const env = { JWT_SECRET: SECRET, VITE_ORIGINS: ORIGIN, FLAGS: { get: async () => null }, LOBBY: lobby.ns, LOBBY_DIR: dir.ns };
  const { token } = await createSession(SECRET, '0123456789abcdef', 'Invitado');
  const create = () =>
    worker.fetch(
      new Request(ORIGIN + '/api/lobbies', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': '2001:db8::7', Origin: ORIGIN, authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ mode: '2v2', visibility: 'private', net: 'p2p', matchLengthSeconds: 300 }),
      }),
      env,
    );
  assert.equal((await create()).status, 200);
  assert.equal(dir.calls[0].body.owner, '0123456789abcdef');
  assert.equal(dir.calls[0].body.ip, '2001:db8::7');
  refuse = true;
  const r = await create();
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error, 'too_many_lobbies');
});

// ---- rt-m1: INICIAR is throttled per lobby --------------------------------------------------------

test('LobbyDO: a host repeating INICIAR against a refusing matchmaker reaches it a handful of times a minute (3, 6, 12, 24, 30 s back-off), not once per frame', async () => {
  const h = await makeLobby({ name: 'Sala', mode: '1v1', visibility: 'private', net: 'server', matchLengthSeconds: 300 });
  const host = await h.upgrade('host1');
  let busy = true;
  const realGet = h.mm.ns.get;
  h.mm.ns.get = (id) => ({
    fetch: async (url, init) => {
      if (!busy) return realGet(id).fetch(url, init);
      h.mm.calls.push({ path: new URL(url).pathname, body: JSON.parse(init.body) });
      return new RealResponse(JSON.stringify({ error: 'member_busy', playerId: 'host1', message: 'Ana todavía está en otra partida' }), { status: 409 });
    },
  });
  // 4 frames a second for a minute: under the socket budget, so only the start throttle bounds it.
  for (let i = 0; i < 240; i++) {
    await h.send(host, { t: 'start' });
    advance(250);
  }
  assert.equal(host.readyState, 1, 'within the socket budget: not closed');
  assert.ok(h.customs() <= 6, `/custom calls bounded (${h.customs()})`);
  assert.ok(host.of('error').some((e) => e.code === 'start_cooldown'), 'the host is told to wait');
  // The member is free again: once the wait is over the next INICIAR goes through.
  busy = false;
  advance(30_000);
  await h.send(host, { t: 'start' });
  assert.equal(host.last().status, 'in_game', 'started');
});

test('LobbyDO: normal starts are never throttled: a refused start (capacity) can be retried 3 s later; after FINAL the next match starts', async () => {
  const h = await makeLobby();
  const host = await h.upgrade('host1');
  const bea = await h.join('bea');
  let full = true;
  const realGet = h.mm.ns.get;
  h.mm.ns.get = (id) => ({
    fetch: async (url, init) => (full ? new RealResponse(JSON.stringify({ error: 'capacity', message: 'all rooms are busy' }), { status: 503 }) : realGet(id).fetch(url, init)),
  });
  await h.send(host, { t: 'start' });
  assert.equal(host.of('error').at(-1).code, 'capacity');
  full = false;
  advance(3_000); // REINTENTAR
  await h.send(host, { t: 'start' });
  assert.equal(host.last().status, 'in_game');
  advance(4 * 60_000); // the match
  await h.send(host, { t: 'back' });
  await h.send(bea, { t: 'back' });
  await h.send(host, { t: 'start' });
  assert.equal(host.last().status, 'in_game', 'the next match');
  assert.equal(host.of('error').filter((e) => e.code === 'start_cooldown').length, 0);
});

// ---- rt-5: a kick sticks ---------------------------------------------------------------------------

test('LobbyDO: a kicked member cannot come back with an admit taken before the kick (403 kicked at the socket); its admit no longer holds a seat', async () => {
  const h = await makeLobby({ name: 'Sala', mode: '1v1', visibility: 'private', net: 'p2p', matchLengthSeconds: 300 });
  const host = await h.upgrade('host1');
  const grief = await h.join('grief');
  // Still a member: a fresh join skips the password and the room check and leaves an admit behind.
  assert.equal((await h.admit('grief')).status, 200);
  await h.send(host, { t: 'kick', member: byName(host.last(), 'grief').id });
  assert.equal(grief.closed.code, 4003);
  const back = await h.upgrade('grief');
  assert.equal(back.refused, 403, 'the pre-kick admit is refused at the socket');
  assert.equal(back.json.error, 'kicked');
  assert.deepEqual(host.last().members.map((m) => m.name), ['Ana'], 'still out');
  assert.equal((await h.admit('grief')).json.error, 'kicked', 'and a new admit too');
  // The seat is free for somebody else at once.
  assert.equal((await h.admit('bea')).status, 200, 'not full: the kicked admit is gone');
});

test("LobbyDO: a member's fresh admit (a reload, another tab) does not count as a pending seat for the others", async () => {
  const h = await makeLobby({ name: 'Sala', mode: '1v1', visibility: 'private', net: 'p2p', matchLengthSeconds: 300 });
  await h.upgrade('host1');
  assert.equal((await h.admit('host1')).status, 200, 'the host joins again by code (a reload)');
  assert.equal((await h.admit('bea')).status, 200, 'one seat of two is taken: bea gets the other');
  assert.equal((await h.admit('caro')).status, 409, 'now it is full');
});

// ---- authz-6 / rt-6: password guesses -------------------------------------------------------------

async function lockedLobby(password = 'tero2026') {
  const h = await makeLobby({ name: 'Sala', mode: '3v3', visibility: 'private', net: 'p2p', matchLengthSeconds: 300 });
  const host = await h.upgrade('host1');
  await h.send(host, { t: 'settings', settings: {}, password });
  assert.equal(host.last().hasPassword, true);
  return { h, host };
}

test('LobbyDO: password guesses from many fresh sessions are bounded per lobby (10, then one per 30 s): 429 password_locked; the host is told once', async () => {
  const { h, host } = await lockedLobby();
  advance(60_000);
  let compared = 0;
  let locked = 0;
  const t0 = clock;
  for (let i = 0; i < 200; i++) {
    const r = await h.admit('guess' + i, { password: 'pw' + i }); // a fresh guest session per guess
    if (r.status === 403) compared++;
    else if (r.status === 429) {
      locked++;
      assert.equal(r.json.error, 'password_locked');
      assert.ok(r.json.retryAfterMs > 0 && r.json.retryAfterMs <= L.PW_LOBBY_REFILL_MS);
    }
    advance(3_000); // 200 guesses over 10 minutes
  }
  const allowed = 10 + Math.floor((clock - t0) / 30_000);
  assert.ok(compared <= allowed, `guesses compared ${compared} <= ${allowed}`);
  assert.ok(locked >= 200 - allowed);
  assert.equal(host.of('error').filter((e) => e.code === 'password_attempts').length, 1, 'the host hears it once');
  // Unlocked again after the window: the right password still opens the lobby.
  advance(L.PW_LOBBY_REFILL_MS * L.PW_LOBBY_BURST);
  assert.equal((await h.admit('friend', { password: 'tero2026' })).status, 200);
});

test('LobbyDO: one player gets 5 wrong guesses per 10 minutes; a friend with the right password is not held up by it; a new password starts the count over', async () => {
  const { h, host } = await lockedLobby();
  for (let i = 0; i < 5; i++) assert.equal((await h.admit('grief', { password: 'nope' + i })).status, 403);
  const r = await h.admit('grief', { password: 'tero2026' });
  assert.equal(r.status, 429, 'over its count: refused even with the right password');
  assert.equal(r.json.error, 'password_locked');
  assert.equal((await h.admit('friend', { password: 'wrong' })).status, 403, 'a typo');
  assert.equal((await h.admit('friend', { password: 'tero2026' })).status, 200, 'then in');
  await h.send(host, { t: 'settings', settings: {}, password: 'otra-clave' });
  assert.equal((await h.admit('grief', { password: 'otra-clave' })).status, 200, 'a new password: the old guesses count no more');
  advance(L.PW_WINDOW_MS);
});

test('LobbyDO: a new password needs 4 characters (create 400 short_password, settings error short_password with nothing changed); a lobby made before keeps its short one', async () => {
  const h = await makeLobby();
  const host = await h.upgrade('host1');
  // The host is a guest: a setting a guest host may change (sec/guest-names drops a guest's title).
  await h.send(host, { t: 'settings', settings: { visibility: 'private' }, password: 'abc' });
  assert.equal(host.of('error').at(-1).code, 'short_password');
  assert.equal(host.last().settings.visibility, 'public', 'the refused save changed nothing');
  assert.equal(host.last().hasPassword, false);
  await h.send(host, { t: 'settings', settings: { visibility: 'private' }, password: 'abcd' });
  assert.equal(host.last().settings.visibility, 'private');
  assert.equal(host.last().hasPassword, true);
  // POST /internal/create with a short password.
  const ctx = new FakeLobbyCtx();
  const lobby = new L.LobbyDO(ctx, { JWT_SECRET: SECRET, MATCHMAKER: h.mm.ns, LOBBY_DIR: h.dir.ns });
  const secret = await internalSecret(SECRET);
  const create = (password) =>
    lobby.fetch(new Request('https://lobby/internal/create', { method: 'POST', headers: { [INTERNAL_HEADER]: secret, 'content-type': 'application/json' }, body: JSON.stringify({ lobbyId: 'L2', code: 'BCDEFG', region: 'SA', socketBase: 'wss://x', settings: { name: 'Sala', mode: '2v2', visibility: 'private', net: 'p2p', matchLengthSeconds: 300 }, password, host: { playerId: 'h2', name: 'Bea', guest: true } }) }));
  const short = await create('x');
  assert.equal(short.status, 400);
  assert.equal((await short.json()).error, 'short_password');
  // A lobby whose 1-character password was set before the rule: guesses of it are still compared.
  h.lobby.rec.pwHash = await L.lobbyPasswordHash('L1', 'x');
  assert.equal((await h.admit('bea', { password: 'x' })).status, 200);
});

// ---- rt-3 / cost-6: a guest's server lobby match is 5 minutes at most ------------------------------

test("LobbyDO: a server start with a guest in the lobby and 600 s or unlimited answers guest_length without reaching the matchmaker; 300 s goes; P2P with two humans keeps any length", async () => {
  for (const len of [600, 0]) {
    const h = await makeLobby({ name: 'Sala', mode: '1v1', visibility: 'private', net: 'server', matchLengthSeconds: len });
    const host = await h.upgrade('host1');
    await h.send(host, { t: 'start' });
    assert.equal(host.of('error').at(-1).code, 'guest_length', `length ${len}`);
    assert.equal(h.customs(), 0);
  }
  const ok = await makeLobby({ name: 'Sala', mode: '1v1', visibility: 'private', net: 'server', matchLengthSeconds: 300 });
  const host = await ok.upgrade('host1');
  await ok.send(host, { t: 'start' });
  assert.equal(ok.customs(), 1);
  const p2p = await makeLobby({ name: 'Sala', mode: '1v1', visibility: 'private', net: 'p2p', matchLengthSeconds: 0 });
  const h2 = await p2p.upgrade('host1');
  await p2p.join('bea');
  await p2p.send(h2, { t: 'start' });
  assert.equal(p2p.customs(), 1, 'a P2P room runs on the players: any length');
});
