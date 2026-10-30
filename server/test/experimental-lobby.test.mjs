// Experimental P2P lobbies on the server (the experimental design, section 8), and the owner's rule
// that comes with them: "what matters for P2P and ranked matches is the DEFAULT physics; the
// experimental counts for nothing". Covered here:
//   - LobbyDO: the rules in the settings (strict, P2P only), every guest gate (create, admit, the
//     socket upgrade, settings, start), the summary's EXP flag, the /custom body (and, beside the
//     rules, the cosmetic car each member's seat keeps);
//   - the Worker: a guest's lobby with rules (403 account_required), the casual and ranked queues
//     never take rules (400 experimental_lobby_only);
//   - the standard-physics-only paths refuse rules whoever sends them: MatchDO /internal/create,
//     a community node placement (NodeRegistryDO parsePlace), every AccountsDO report that rates,
//     locks, penalises or records (/ranked-result, /ranked-cancel, /ranked-lock, /training) and the
//     player's own /api/me/training; a node's outcome never carries rules to AccountsDO;
//   - the server arenas (MatchDO's wasm.ts, a node's nodeArena.ts) are created without mutators,
//     and RoomHost never creates one.
// RoomDO and the matchmaker's side are in room.test.mjs and nodeMatchmaker.test.mjs.
// 'cloudflare:workers' and MatchDO's wasm are stubbed. Run from server/: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { makeAccount } from './helpers/accounts.mjs';

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
const { MatchDO } = await import('../src/MatchDO.ts');
const { AccountsDO } = await import('../src/AccountsDO.ts');
const { AccountStore } = await import('../src/accountStore.ts');
const { parsePlace } = await import('../src/NodeRegistryDO.ts');
const { outcomeCalls } = await import('../src/nodeOutcome.ts');
const { carriesPhysics } = await import('../src/env.ts');
const worker = (await import('../src/index.ts')).default;
const { INTERNAL_HEADER, internalSecret, signJwt, createSession } = await import('../src/auth.ts');

const SECRET = 'experimental-lobby-test-secret';
const ORIGIN = 'https://turbo-gol.com';
const RULES = { v: 1, name: 'Low gravity', values: { gravity: 50, ballDrag: 50 } };

test('carriesPhysics: rules are a `physics` that is neither absent nor null', () => {
  assert.equal(carriesPhysics({ physics: RULES }), true);
  assert.equal(carriesPhysics({ physics: 'x' }), true, 'anything there counts: refused, never read');
  assert.equal(carriesPhysics({ physics: null }), false);
  assert.equal(carriesPhysics({}), false);
  assert.equal(carriesPhysics(null), false);
});

// ---- LobbyDO: the settings ------------------------------------------------------------------------

test('parseLobbySettings: rules are strict snapshots, P2P only; absent keeps them, null clears them, one that changes nothing is standard', () => {
  const base = L.defaultLobbySettings('Sala');
  assert.equal(base.physics, null, 'a new lobby plays the standard physics');
  const exp = L.parseLobbySettings({ physics: RULES }, base);
  assert.deepEqual(exp.physics, RULES);
  assert.deepEqual(L.parseLobbySettings({ mode: '3v3' }, exp).physics, RULES, 'absent: kept');
  assert.equal(L.parseLobbySettings({ physics: null }, exp).physics, null, 'null: standard');
  assert.equal(L.parseLobbySettings({ physics: { v: 1, name: 'My rules 1', values: {} } }, base).physics, null, 'changes nothing: standard');
  for (const bad of [{ ...RULES, values: { gameSpeed: 50 } }, { ...RULES, values: { gravity: 55 } }, { ...RULES, name: 'x' }, { ...RULES, v: 0 }, 'Low gravity', 7, []]) {
    assert.equal(L.parseLobbySettings({ physics: bad }, base), 'bad_physics', JSON.stringify(bad));
  }
  assert.equal(L.parseLobbySettings({ physics: RULES, net: 'server' }, base), 'experimental_p2p_only');
  assert.equal(L.parseLobbySettings({ net: 'server' }, exp), 'experimental_p2p_only', 'switching to a server match keeps no rules: they must be cleared');
  assert.equal(L.parseLobbySettings({ net: 'server', physics: null }, exp).net, 'server');
  assert.equal(L.lobbyPhysics({ ...base, physics: undefined }), null, 'a record from before the field');
});

// ---- LobbyDO on fakes -----------------------------------------------------------------------------

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
}

globalThis.WebSocketPair = class WebSocketPair {
  constructor() {
    this[0] = new FakeSocket();
    this[1] = new FakeSocket();
  }
};
globalThis.WebSocketRequestResponsePair = class WebSocketRequestResponsePair {
  constructor(req, res) {
    this.req = req;
    this.res = res;
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
  waitUntil(p) {
    Promise.resolve(p).catch(() => undefined);
  }
}

/** A fake namespace whose one object answers every fetch with `handler(path, body)` and records the calls. */
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
          const r = handler(u.pathname, body);
          return r instanceof RealResponse ? r : new RealResponse(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
        },
      }),
    },
  };
}

const jti = () => Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

/** A LobbyDO created by `host` with `settings` (`env` adds bindings: ACCOUNTS); returns helpers for admits, sockets and messages. */
async function makeLobby(settings, host = { playerId: 'host1', name: 'Ana', guest: false }, env = {}) {
  const ctx = new FakeLobbyCtx();
  const mm = fakeNs((path, body) => (path === '/custom' ? { results: Object.fromEntries(body.members.map((m) => [m.playerId, { status: 'matched', kind: 'p2p', roomId: 'r', ticket: 't', wsUrl: '/room/r' }])) } : { ok: true }));
  const dir = fakeNs(() => ({ ok: true }));
  const lobby = new L.LobbyDO(ctx, { JWT_SECRET: SECRET, MATCHMAKER: mm.ns, LOBBY_DIR: dir.ns, ...env });
  const secret = await internalSecret(SECRET);
  const post = async (path, body) => {
    const res = await lobby.fetch(new Request('https://lobby' + path, { method: 'POST', headers: { [INTERNAL_HEADER]: secret, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    return { status: res.status, json: await res.json() };
  };
  const created = await post('/internal/create', { lobbyId: 'L1', code: 'ABCDEF', region: 'SA', socketBase: 'wss://x', settings, host });
  const h = { ctx, lobby, mm, dir, created, post };
  h.admit = (playerId, guest) => post('/internal/admit', { playerId, name: playerId, guest });
  /** The socket upgrade of `playerId` (the Worker's gate forwards it with these headers). */
  h.upgrade = async (playerId) => {
    const res = await lobby.fetch(new Request('https://lobby/lobby', { headers: { Upgrade: 'websocket', [INTERNAL_HEADER]: secret, 'x-player-id': playerId, 'x-jti': jti() } }));
    return { status: res.status, ws: res.upgraded === true ? ctx.sockets.at(-1) : null, json: res.upgraded === true ? null : await res.json() };
  };
  h.send = (ws, msg) => lobby.webSocketMessage(ws, JSON.stringify(msg));
  h.summary = () => dir.calls.filter((c) => c.path === '/upsert').at(-1)?.body.summary;
  return h;
}

test('LobbyDO: create with rules: P2P only (400 experimental_p2p_only), a guest host is refused (403 account_required), a bad snapshot 400 bad_physics', async () => {
  const base = { name: 'Sala', mode: '1v1', visibility: 'public', net: 'p2p', matchLengthSeconds: 300 };
  assert.equal((await makeLobby({ ...base, physics: RULES }, { playerId: 'g1', name: 'Invitado', guest: true })).created.status, 403);
  assert.equal((await makeLobby({ ...base, physics: RULES }, { playerId: 'g1', name: 'Invitado', guest: true })).created.json.error, 'account_required');
  const server = await makeLobby({ ...base, net: 'server', physics: RULES });
  assert.equal(server.created.status, 400);
  assert.equal(server.created.json.error, 'experimental_p2p_only');
  assert.equal((await makeLobby({ ...base, physics: { ...RULES, values: { gameSpeed: 50 } } })).created.json.error, 'bad_physics');
  const ok = await makeLobby({ ...base, physics: RULES });
  assert.equal(ok.created.status, 200);
  assert.deepEqual(ok.summary().physics, RULES);
  assert.equal(ok.summary().experimental, true, 'the lobby list tags it EXP');
  const plain = await makeLobby(base, { playerId: 'g1', name: 'Invitado', guest: true });
  assert.equal(plain.created.status, 200, 'a guest hosts a standard lobby as before');
  assert.equal(plain.summary().experimental, false);
  assert.equal(plain.summary().physics, null);
});

test('LobbyDO: an experimental lobby admits signed-in players only: a guest admit is 403 account_required; members see the rules in the state', async () => {
  const h = await makeLobby({ name: 'Sala', mode: '2v2', visibility: 'public', net: 'p2p', matchLengthSeconds: 300, physics: RULES });
  const host = await h.upgrade('host1');
  assert.ok(host.ws, 'the host comes in');
  const g = await h.admit('guest1', true);
  assert.equal(g.status, 403);
  assert.equal(g.json.error, 'account_required');
  assert.equal((await h.admit('acct2', false)).status, 200);
  const m = await h.upgrade('acct2');
  assert.ok(m.ws);
  const st = m.ws.of('state').at(-1).lobby;
  assert.deepEqual(st.settings.physics, RULES, 'every member sees the rules before the start');
  assert.equal(st.members.length, 2);
});

test('LobbyDO: rules set while a guest is a member: guests_present; a guest admitted before the rules is refused at its upgrade', async () => {
  const h = await makeLobby({ name: 'Sala', mode: '2v2', visibility: 'public', net: 'p2p', matchLengthSeconds: 300 });
  const host = (await h.upgrade('host1')).ws;
  assert.equal((await h.admit('guest1', true)).status, 200, 'a standard lobby takes guests');
  // The guest's socket has not come yet: the rules can be set, and its admit goes.
  await h.send(host, { t: 'settings', settings: { physics: RULES } });
  assert.deepEqual(host.of('error'), []);
  assert.deepEqual(host.of('state').at(-1).lobby.settings.physics, RULES);
  const late = await h.upgrade('guest1');
  assert.equal(late.status, 403, `the guest admitted before the rules cannot come in now (${JSON.stringify(late.json)})`);
  // Back to standard; now a guest is a member: the rules are refused.
  await h.send(host, { t: 'settings', settings: { physics: null } });
  assert.equal((await h.admit('guest2', true)).status, 200);
  assert.ok((await h.upgrade('guest2')).ws);
  await h.send(host, { t: 'settings', settings: { physics: RULES } });
  assert.deepEqual(host.of('error').map((e) => e.code), ['guests_present']);
  assert.equal(host.of('state').at(-1).lobby.settings.physics, null, 'unchanged');
  // A server match with rules: refused; standard rules with a server match: fine.
  await h.send(host, { t: 'settings', settings: { net: 'server', physics: RULES } });
  assert.deepEqual(host.of('error').map((e) => e.code), ['guests_present', 'experimental_p2p_only']);
});

test('LobbyDO: the start hands the rules to the matchmaker (/custom physics); with one member it is refused (experimental_p2p_only); a standard start sends null', async () => {
  const h = await makeLobby({ name: 'Sala', mode: '2v2', visibility: 'public', net: 'p2p', matchLengthSeconds: 300, physics: RULES });
  const host = (await h.upgrade('host1')).ws;
  await h.send(host, { t: 'start' });
  assert.deepEqual(host.of('error').map((e) => e.code), ['experimental_p2p_only'], 'a lone member never gets a server match with bots');
  assert.equal(h.mm.calls.length, 0);
  await h.admit('acct2', false);
  const m = (await h.upgrade('acct2')).ws;
  await h.send(host, { t: 'start' });
  const custom = h.mm.calls.find((c) => c.path === '/custom');
  assert.equal(custom.body.kind, 'p2p');
  assert.deepEqual(custom.body.physics, RULES, 'the copy the lobby holds');
  assert.deepEqual(custom.body.members.map((x) => x.guest), [false, false], 'with every member\'s guest flag (the matchmaker and RoomDO check it again)');
  assert.equal(m.of('match').length, 1, 'each member gets its room');
  const plain = await makeLobby({ name: 'Sala', mode: '1v1', visibility: 'public', net: 'p2p', matchLengthSeconds: 300 });
  const p = (await plain.upgrade('host1')).ws;
  await plain.admit('acct2', false);
  await plain.upgrade('acct2');
  await plain.send(p, { t: 'start' });
  assert.equal(plain.mm.calls.find((c) => c.path === '/custom').body.physics, null);
});

test("LobbyDO (cosmetic cars, not rules): each member's seat keeps the car its admit brought; the state shows it, the start hands it to /custom, a fresh admit takes the new one", async () => {
  const h = await makeLobby({ name: 'Sala', mode: '2v2', visibility: 'public', net: 'p2p', matchLengthSeconds: 300 }, { playerId: 'host1', name: 'Ana', guest: false, car: 'tero' });
  const host = (await h.upgrade('host1')).ws;
  assert.equal((await h.post('/internal/admit', { playerId: 'acct2', name: 'Beto', guest: false, car: 'pampero' })).status, 200);
  const b = (await h.upgrade('acct2')).ws;
  assert.equal((await h.post('/internal/admit', { playerId: 'guest3', name: 'Caro', guest: true, car: 'ferrari' })).status, 200);
  await h.upgrade('guest3');
  const members = () => host.of('state').at(-1).lobby.members.map((m) => [m.name, m.car ?? null]);
  assert.deepEqual(members(), [['Ana', 'tero'], ['Beto', 'pampero'], ['Caro', null]], 'a junk car is dropped');
  // Beto picked another car and came back through a fresh admit (another tab).
  await h.post('/internal/admit', { playerId: 'acct2', name: 'Beto', guest: false, car: 'condor' });
  await h.upgrade('acct2');
  assert.deepEqual(members()[1], ['Beto', 'condor']);
  await h.post('/internal/admit', { playerId: 'acct2', name: 'Beto', guest: false });
  await h.upgrade('acct2');
  assert.deepEqual(members()[1], ['Beto', null], 'back on the default car');
  await h.send(host, { t: 'start' });
  const custom = h.mm.calls.find((c) => c.path === '/custom');
  assert.deepEqual(custom.body.members.map((m) => [m.playerId, m.car ?? null]), [['host1', 'tero'], ['acct2', null], ['guest3', null]]);
  assert.equal(b.of('match').length, 0, 'the replaced socket gets nothing');
});

test('LobbyDO (cosmetic cars): each start reads the signed-in members\' cars again from AccountsDO (a pick or a revoke since the admit applies); no answer in time keeps the admits\' cars', async () => {
  const SETTINGS = { name: 'Sala', mode: '2v2', visibility: 'public', net: 'p2p', matchLengthSeconds: 300 };
  let answer = { cars: { host1: 'dune', acct2: 'condor', guest3: 'tero' } };
  const accounts = fakeNs((path) => (typeof answer === 'function' ? answer(path) : answer));
  const h = await makeLobby(SETTINGS, { playerId: 'host1', name: 'Ana', guest: false, car: 'tero' }, { ACCOUNTS: accounts.ns });
  const host = (await h.upgrade('host1')).ws;
  await h.post('/internal/admit', { playerId: 'acct2', name: 'Beto', guest: false, car: 'pampero' });
  await h.upgrade('acct2');
  await h.post('/internal/admit', { playerId: 'guest3', name: 'Caro', guest: true });
  await h.upgrade('guest3');
  await h.post('/internal/admit', { playerId: 'acct4', name: 'Dani', guest: false, car: 'carpincho' });
  await h.upgrade('acct4');
  await h.send(host, { t: 'start' });
  // Ana's tero was revoked (dune now), Beto equipped condor in the garage, Dani's account is gone
  // (left out: the default car); a guest is never asked for, whatever an answer says of it.
  assert.deepEqual(accounts.calls.map((c) => [c.path, c.body.userIds]), [['/equipped', ['host1', 'acct2', 'acct4']]]);
  const custom = (n) => h.mm.calls.filter((c) => c.path === '/custom')[n].body.members.map((m) => [m.playerId, m.car ?? null]);
  assert.deepEqual(custom(0), [['host1', null], ['acct2', 'condor'], ['guest3', null], ['acct4', null]]);
  assert.deepEqual(host.of('state').at(-1).lobby.members.map((m) => [m.name, m.car ?? null]), [['Ana', null], ['Beto', 'condor'], ['Caro', null], ['Dani', null]], 'the state shows them too');
  // Next match: AccountsDO is down (a 500, then a hang): the cars stay as the last start left them.
  for (const ws of h.ctx.getWebSockets()) await h.send(ws, { t: 'back' });
  answer = () => new RealResponse('{}', { status: 500 });
  await h.post('/internal/admit', { playerId: 'acct2', name: 'Beto', guest: false, car: 'pampero' });
  await h.upgrade('acct2');
  // The next match starts at least START_AGAIN_MS after the last one (LobbyDO's start throttle).
  const realNow = Date.now;
  Date.now = () => realNow() + L.START_AGAIN_MS;
  try {
    await h.send(host, { t: 'start' });
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(custom(1), [['host1', null], ['acct2', 'pampero'], ['guest3', null], ['acct4', null]], 'a 500: the admits\' cars');
});

test('LobbyDO (cosmetic cars): a start waits at most EQUIPPED_TIMEOUT_MS for AccountsDO, then seats the admits\' cars', async (t) => {
  let asked = false;
  const hang = { idFromName: (n) => n, get: () => ({ fetch: () => ((asked = true), new Promise(() => {})) }) };
  const h = await makeLobby({ name: 'Sala', mode: '1v1', visibility: 'public', net: 'p2p', matchLengthSeconds: 300 }, { playerId: 'host1', name: 'Ana', guest: false, car: 'tero' }, { ACCOUNTS: hang });
  const host = (await h.upgrade('host1')).ws;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const started = h.send(host, { t: 'start' });
  // The wait is armed before AccountsDO is asked (which never answers here).
  for (let i = 0; i < 100 && !asked; i++) await new Promise((r) => setImmediate(r));
  assert.equal(asked, true);
  assert.equal(h.mm.calls.filter((c) => c.path === '/custom').length, 0, 'still waiting');
  t.mock.timers.tick(1500);
  await started;
  assert.deepEqual(h.mm.calls.find((c) => c.path === '/custom').body.members.map((m) => m.car ?? null), ['tero']);
});

// ---- the Worker -----------------------------------------------------------------------------------

function workerEnv() {
  const lobby = fakeNs((path) => (path === '/internal/create' || path === '/internal/admit' ? { ok: true } : { ok: true }));
  const dir = fakeNs((path) => (path === '/allocate' ? { code: 'ABCDEF' } : path === '/resolve' ? { lobbyId: 'ab'.repeat(32) } : { ok: true }));
  const mm = fakeNs(() => new RealResponse(JSON.stringify({ error: 'capacity' }), { status: 503 }));
  const accounts = fakeNs(() => ({ banUntil: 0, active: null, ratings: { '1v1': { mu: 25, sigma: 8, mmr: 1000 } } }));
  const env = { JWT_SECRET: SECRET, VITE_ORIGINS: ORIGIN, FLAGS: { get: async () => null }, LOBBY: lobby.ns, LOBBY_DIR: dir.ns, MATCHMAKER: mm.ns, ACCOUNTS: accounts.ns };
  return { env, lobby, dir, mm, accounts };
}

let ip = 0;
async function call(env, method, path, { token, body } = {}) {
  const headers = { 'CF-Connecting-IP': `203.0.113.${++ip % 250}`, Origin: ORIGIN };
  if (token) headers.authorization = 'Bearer ' + token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const accountToken = (sub, name = 'Ana') => signJwt(SECRET, { sub, name, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, acct: 1 });
const guestToken = async () => (await createSession(SECRET, '0123456789abcdef', 'Invitado')).token;

test('Worker: POST /api/lobbies with rules: a guest gets 403 account_required (nothing created), an account hands them to LobbyDO', async () => {
  const w = workerEnv();
  const lobbyBody = { name: 'Sala exp', mode: '2v2', visibility: 'public', net: 'p2p', matchLengthSeconds: 300, physics: RULES };
  const g = await call(w.env, 'POST', '/api/lobbies', { token: await guestToken(), body: lobbyBody });
  assert.equal(g.status, 403);
  assert.equal(g.json.error, 'account_required');
  assert.equal(w.dir.calls.length + w.lobby.calls.length, 0, 'no code, no lobby');
  const plain = await call(w.env, 'POST', '/api/lobbies', { token: await guestToken(), body: { ...lobbyBody, physics: null } });
  assert.equal(plain.status, 200, 'a guest still hosts a standard lobby');
  const a = await call(w.env, 'POST', '/api/lobbies', { token: await accountToken('a1b2c3d4e5f60718'), body: lobbyBody });
  assert.equal(a.status, 200);
  const create = w.lobby.calls.filter((c) => c.path === '/internal/create').at(-1);
  assert.deepEqual(create.body.settings.physics, RULES);
  assert.equal(create.body.host.guest, false);
});

test('Worker: POST /api/queue never takes rules: 400 experimental_lobby_only for casual and ranked, before the matchmaker is asked', async () => {
  const w = workerEnv();
  const guest = await guestToken();
  const acct = await accountToken('a1b2c3d4e5f60718');
  for (const [token, body] of [
    [guest, { mode: '1v1', kind: 'p2p', p2pProtocol: 5, physics: RULES }],
    [guest, { mode: '1v1', kind: 'server', physics: RULES }],
    [acct, { mode: '1v1', kind: 'ranked', physics: RULES }],
    [guest, { mode: '1v1', physics: { v: 1, name: 'x', values: {} } }],
  ]) {
    const r = await call(w.env, 'POST', '/api/queue', { token, body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.error, 'experimental_lobby_only');
  }
  assert.equal(w.mm.calls.length + w.accounts.calls.length, 0, 'neither the matchmaker nor AccountsDO was asked');
  const r = await call(w.env, 'POST', '/api/queue', { token: guest, body: { mode: '1v1', kind: 'server', physics: null } });
  assert.equal(r.status, 503, 'null is the standard physics: on to the matchmaker');
  assert.equal(w.mm.calls.length, 1);
});

// ---- the standard-physics-only paths ---------------------------------------------------------------

test('MatchDO: /internal/create with rules is refused (a server match runs the standard physics only)', async () => {
  const ctx = { storage: new FakeStorage(), blockConcurrencyWhile: (fn) => fn(), getWebSockets: () => [], acceptWebSocket() {}, setWebSocketAutoResponse() {} };
  const match = new MatchDO(ctx, { JWT_SECRET: SECRET });
  const secret = await internalSecret(SECRET);
  const roster = [{ slot: 0, team: 0, kind: 'player', name: 'A', playerId: 'pa' }, { slot: 1, team: 1, kind: 'bot', name: 'Bot 1' }];
  const create = async (extra) => {
    const res = await match.fetch(new Request('https://match/internal/create', { method: 'POST', headers: { [INTERNAL_HEADER]: secret, 'content-type': 'application/json' }, body: JSON.stringify({ matchId: 'ab'.repeat(32), mode: '1v1', region: 'SA', roster, matchLengthSeconds: 300, ...extra }) }));
    return { status: res.status, json: await res.json() };
  };
  const r = await create({ physics: RULES });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'experimental_lobby_only');
  assert.equal(ctx.storage.map.size, 0, 'nothing stored');
  const plain = await create({ physics: null });
  assert.equal(plain.json.error, 'host_init_failed', 'without rules it goes on (to the stubbed wasm)');
});

test('a community node placement with rules is refused (NodeRegistryDO parsePlace); a node outcome never carries rules to AccountsDO', () => {
  const place = { mode: '1v1', region: 'SA', ranked: false, matchLengthSeconds: 300, humans: [{ playerId: 'a'.repeat(16), name: 'Ana' }] };
  assert.ok(parsePlace(place), 'a plain placement parses');
  assert.equal(parsePlace({ ...place, physics: RULES }), null);
  assert.ok(parsePlace({ ...place, physics: null }));
  const assign = { mode: '2v2', region: 'SA' };
  const rated = { kind: 'rated', matchId: 'ab'.repeat(32), playlist: '2v2', region: 'SA', winner: 0, blue: 2, red: 1, players: [{ id: 'p1', team: 0, left: false }], physics: RULES };
  const voided = { kind: 'void', ranked: true, matchId: 'ab'.repeat(32), players: ['p1'], noShows: ['p2'], reason: 'no_show', physics: RULES };
  for (const o of [rated, voided]) {
    for (const c of outcomeCalls(o, assign, ['p1', 'p2'])) assert.equal(JSON.parse(c.body).physics, undefined, `${c.path}: built field by field, never passed through`);
  }
});

function sqlOn(db) {
  return {
    exec(query, ...bindings) {
      const stmt = db.prepare(query);
      const rows = /^\s*(SELECT|WITH)/i.test(query) ? stmt.all(...bindings) : (stmt.run(...bindings), []);
      return { toArray: () => rows.map((r) => ({ ...r })) };
    },
  };
}
function txOn(db) {
  return (fn) => {
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };
}

test('AccountsDO: a ranked result, cancel, lock or training upload that carries rules is refused: no rating, no ban, no record, no leaderboard entry', async () => {
  const db = new DatabaseSync(':memory:');
  const env = { JWT_SECRET: SECRET, VITE_ORIGINS: ORIGIN, FLAGS: { get: async () => null } };
  const ctx = { storage: { sql: sqlOn(db), transactionSync: txOn(db), getAlarm: async () => null, setAlarm: async () => undefined }, blockConcurrencyWhile: (fn) => fn() };
  const obj = new AccountsDO(ctx, env);
  env.ACCOUNTS = { idFromName: (n) => ({ n }), get: () => ({ fetch: (url, init) => obj.fetch(new Request(url, init)) }) };
  const H = (c) => c.repeat(64).slice(0, 64);
  const ids = ['ana', 'beto'].map((n, i) => makeAccount(obj.store, n, { now: Date.now(), refresh: H(String(i)) }).userId);
  const secret = await internalSecret(SECRET);
  const post = async (path, body) => {
    const res = await obj.fetch(new Request('https://accounts' + path, { method: 'POST', headers: { [INTERNAL_HEADER]: secret, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    return { status: res.status, json: await res.json() };
  };
  const result = { matchId: 'm1', playlist: '1v1', region: 'SA', winner: 0, blue: 3, red: 0, players: [{ id: ids[0], team: 0, left: false }, { id: ids[1], team: 1, left: true }] };
  for (const [path, body] of [
    ['/ranked-result', { ...result, physics: RULES }],
    ['/ranked-cancel', { matchId: 'm2', playlist: '1v1', region: 'SA', players: ids, noShows: [ids[1]], reason: 'no_show', physics: RULES }],
    ['/ranked-lock', { matchId: 'm3', region: 'SA', userIds: ids, until: Date.now() + 600_000, physics: RULES }],
    ['/training', { userId: ids[0], records: { 'shooting-easy': { shots: 5, made: 5, ms: 10000, at: Date.now() } }, physics: RULES }],
  ]) {
    const r = await post(path, body);
    assert.equal(r.status, 400, path);
    assert.equal(r.json.error, 'experimental_lobby_only', path);
  }
  const me = obj.store.me(ids[0], Date.now());
  assert.equal(me.ratings.find((x) => x.playlist === '1v1').games, 0, 'no rating');
  assert.equal(obj.store.me(ids[1], Date.now()).rankedBanUntil, 0, 'no abandon ban');
  assert.equal(obj.store.rankedCheck(ids[0], ['1v1'], Date.now()).active, null, 'no ranked lock');
  assert.equal(obj.store.leaderboard('1v1', 10, null).total, 0, 'no leaderboard entry');
  // The same report without rules is rated: the refusal is the rules'.
  assert.equal((await post('/ranked-result', result)).json.applied, true);
  assert.equal(obj.store.me(ids[0], Date.now()).ratings.find((x) => x.playlist === '1v1').games, 1);
  // The player's own upload (POST /api/me/training) with rules: refused at the Worker.
  const r = await call(env, 'POST', '/api/me/training', { token: await accountToken(ids[0]), body: { records: {}, physics: RULES } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'experimental_lobby_only');
});

test('the server arenas are stock: MatchDO (wasm.ts) and a community node (nodeArena.ts) create theirs without mutators; RoomHost never creates one', () => {
  const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  for (const file of ['../src/wasm.ts', '../../nodes/shared/nodeArena.ts']) {
    const calls = src(file).match(/createArena\([^)]*\)/g) ?? [];
    assert.deepEqual(calls, ['createArena(TICK_RATE)'], `${file}: one stock arena (no mutators argument)`);
    assert.doesNotMatch(src(file), /mutator|rulesOf|arenaMutators/i, `${file}: no rules anywhere`);
  }
  const host = src('../src/roomHost.ts');
  assert.doesNotMatch(host, /createArena|setMutators|mutator/i, 'RoomHost only steps the arena its owner made');
});
