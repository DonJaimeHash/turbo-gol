// Guest names assigned by the server (spec PR 1; audit auth-10, authz-5, rt-7): POST /api/guest
// ignores a chosen name and answers 'Invitado NNNN' from the player id; verifySession rewrites the
// name an older guest session carries (an account's stays); a guest never titles a lobby (create
// and the host's settings); an account's title that reads as a guest, the game or its staff
// answers name_reserved, while a lobby inherited from a guest saves its other settings; LobbyDO
// renames the guests of a record written before. 'cloudflare:workers' is stubbed. Run from
// server/: npm test
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
const { INTERNAL_HEADER, internalSecret, signJwt, createSession, verifySession } = await import('../src/auth.ts');
const { GUEST_NAME_RE, guestNameOf } = await import('../../src/net/guestName.ts');
const { lobbyNameIssue, usernameIssue } = await import('../../src/net/account.ts');

const SECRET = 'guest-names-test-secret';
const ORIGIN = 'https://turbo-gol.com';
const GUEST_ID = '0123456789abcdef';
const ACCOUNT_ID = 'a1b2c3d4e5f60718';

// ---- fakes (as lobby-grace.test.mjs) --------------------------------------------------------------

class FakeSocket {
  constructor() {
    this.readyState = 1;
    this.sent = [];
  }
  send(text) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.readyState = 3;
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
  constructor(map = new Map()) {
    this.map = map;
    this.alarm = null;
  }
  async get(k) {
    return structuredClone(this.map.get(k));
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
  constructor(storage = new FakeStorage()) {
    this.storage = storage;
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
/** A 16-hex player id whose first 32 bits are `n` (so each one has its own Invitado NNNN). */
const hexId = (n) => n.toString(16).padStart(8, '0') + '00c0ffee';

/** A LobbyDO on `ctx` (a fresh one, or one over a stored record: a wake-up). */
async function lobbyOn(ctx = new FakeLobbyCtx()) {
  const dir = fakeNs(() => ({ ok: true }));
  const mm = fakeNs(() => ({ ok: true }));
  const lobby = new L.LobbyDO(ctx, { JWT_SECRET: SECRET, MATCHMAKER: mm.ns, LOBBY_DIR: dir.ns });
  const secret = await internalSecret(SECRET);
  const req = async (method, path, body) => {
    const res = await lobby.fetch(new Request('https://lobby' + path, { method, headers: { [INTERNAL_HEADER]: secret, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }));
    return { status: res.status, json: await res.json() };
  };
  const h = { ctx, lobby, dir, req };
  h.create = (settings, host) => req('POST', '/internal/create', { lobbyId: 'L1', code: 'ABCDEF', region: 'SA', socketBase: 'wss://x', settings, host });
  h.admit = (playerId, name, guest) => req('POST', '/internal/admit', { playerId, name, guest });
  h.upgrade = async (playerId) => {
    const res = await lobby.fetch(new Request('https://lobby/lobby', { headers: { Upgrade: 'websocket', [INTERNAL_HEADER]: secret, 'x-player-id': playerId, 'x-jti': jti() } }));
    return res.upgraded === true ? ctx.sockets.at(-1) : null;
  };
  h.join = async (playerId, name, guest) => {
    assert.equal((await h.admit(playerId, name, guest)).status, 200);
    return h.upgrade(playerId);
  };
  h.send = (ws, msg) => lobby.webSocketMessage(ws, JSON.stringify(msg));
  h.summary = () => dir.calls.filter((c) => c.path === '/upsert').at(-1)?.body.summary;
  return h;
}

const SETTINGS = { mode: '2v2', visibility: 'public', net: 'p2p', matchLengthSeconds: 300 };

function workerEnv() {
  const lobby = fakeNs(() => ({ ok: true }));
  const dir = fakeNs((path) => (path === '/allocate' ? { code: 'ABCDEF' } : path === '/resolve' ? { lobbyId: 'ab'.repeat(32) } : { ok: true }));
  const env = { JWT_SECRET: SECRET, VITE_ORIGINS: ORIGIN, TURNSTILE_DISABLED: '1', FLAGS: { get: async () => null }, LOBBY: lobby.ns, LOBBY_DIR: dir.ns };
  return { env, lobby, dir };
}

let ip = 0;
async function call(env, method, path, { token, body } = {}) {
  const headers = { 'CF-Connecting-IP': `198.51.100.${++ip % 250}`, Origin: ORIGIN };
  if (token) headers.authorization = 'Bearer ' + token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const nowS = () => Math.floor(Date.now() / 1000);
const accountToken = (sub = ACCOUNT_ID, name = 'Ana') => signJwt(SECRET, { sub, name, iat: nowS(), exp: nowS() + 3600, acct: 1 });
/** A guest session signed before this rule: it carries the name the guest chose. */
const oldGuestToken = async (name, sub = GUEST_ID) => (await createSession(SECRET, sub, name)).token;

// ---- the name itself ----------------------------------------------------------------------------

test('guestNameOf: Invitado 1000-9999 from the first 32 bits of the id, the same for every holder', () => {
  assert.equal(guestNameOf('0000000000000000'), 'Invitado 1000');
  assert.equal(guestNameOf('0123456789abcdef'), 'Invitado ' + (1000 + (0x01234567 % 9000)));
  assert.equal(guestNameOf('ffffffff00000000'), 'Invitado ' + (1000 + (0xffffffff % 9000)));
  for (let i = 0; i < 2000; i++) {
    const id = Array.from({ length: 16 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
    assert.match(guestNameOf(id), GUEST_NAME_RE, id);
    assert.equal(guestNameOf(id), guestNameOf(id));
  }
  // An account can never be called that: a space, and 'invitado…' is reserved (Invitado4821 too).
  assert.equal(usernameIssue('Invitado 4821')?.code, 'usernameChars');
  assert.equal(usernameIssue('Invitado4821')?.code, 'usernameReserved');
  assert.equal(usernameIssue('invitado_ana')?.code, 'usernameReserved');
  assert.equal(usernameIssue('Ana'), null);
});

// ---- POST /api/guest and verifySession ----------------------------------------------------------

test("POST /api/guest { name: 'Ana' } answers the server's name, Invitado NNNN from the player id, and signs it", async () => {
  const { env } = workerEnv();
  for (const body of [{ name: 'Ana' }, { name: 'Admin' }, { name: 'Bot 1' }, { name: 'Маriana' }, {}]) {
    const r = await call(env, 'POST', '/api/guest', { body });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.match(r.json.playerId, /^[0-9a-f]{16}$/);
    assert.match(r.json.name, GUEST_NAME_RE, JSON.stringify(body));
    assert.equal(r.json.name, guestNameOf(r.json.playerId));
    const c = await verifySession(SECRET, r.json.session);
    assert.equal(c.name, r.json.name, 'the session carries it too');
    assert.equal(c.acct, undefined);
  }
});

test("verifySession: an older guest session named 'Admin' comes back as its Invitado NNNN; an account's name stays", async () => {
  const c = await verifySession(SECRET, await oldGuestToken('Admin'));
  assert.equal(c.name, guestNameOf(GUEST_ID));
  assert.equal(c.sub, GUEST_ID);
  for (const chosen of ['Ana', 'Bot 1', 'Soporte Turbogol', 'Маriana']) assert.equal((await verifySession(SECRET, await oldGuestToken(chosen))).name, guestNameOf(GUEST_ID));
  const a = await verifySession(SECRET, await accountToken(ACCOUNT_ID, 'Ana'));
  assert.equal(a.name, 'Ana', "an account's username is untouched");
  assert.equal(a.acct, 1);
});

test("every route reads the session's name: an older guest session joins a lobby as its Invitado NNNN", async () => {
  const w = workerEnv();
  const r = await call(w.env, 'POST', '/api/lobbies/join', { token: await oldGuestToken('Admin'), body: { code: 'ABCDEF' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const admit = w.lobby.calls.find((c) => c.path === '/internal/admit');
  assert.equal(admit.body.name, guestNameOf(GUEST_ID));
  assert.equal(admit.body.guest, true);
});

// ---- lobby titles ---------------------------------------------------------------------------------

test("Worker: a guest's POST /api/lobbies { name: 'Soporte Turbogol' } gets the host's name as its title; an account's default too", async () => {
  const w = workerEnv();
  const g = await call(w.env, 'POST', '/api/lobbies', { token: await oldGuestToken('Bea'), body: { ...SETTINGS, name: 'Soporte Turbogol' } });
  assert.equal(g.status, 200, JSON.stringify(g.json));
  let create = w.lobby.calls.filter((c) => c.path === '/internal/create').at(-1);
  assert.equal('name' in create.body.settings, false, "a guest's name is never sent on");
  assert.deepEqual(create.body.host, { playerId: GUEST_ID, name: guestNameOf(GUEST_ID), guest: true });
  // An account without a name: the default (its username, LobbyDO's), no 'Sala de ' from the server.
  const a = await call(w.env, 'POST', '/api/lobbies', { token: await accountToken(), body: SETTINGS });
  assert.equal(a.status, 200);
  create = w.lobby.calls.filter((c) => c.path === '/internal/create').at(-1);
  assert.equal('name' in create.body.settings, false);
  assert.equal(create.body.host.name, 'Ana');
  const named = await call(w.env, 'POST', '/api/lobbies', { token: await accountToken(), body: { ...SETTINGS, name: '  Los   del barrio ' } });
  assert.equal(named.status, 200);
  assert.equal(w.lobby.calls.filter((c) => c.path === '/internal/create').at(-1).body.settings.name, 'Los del barrio');
});

test("Worker: an account's title 'Invitado 1234', 'Soporte Turbogol' or 'Ѕoporte' answers 400 name_reserved, nothing created", async () => {
  const w = workerEnv();
  let n = 0;
  for (const name of ['Invitado 1234', 'Soporte Turbogol', 'Ѕoporte', 'TurboGol', 'Turbo Gol', 'Turb0g0l', 'Тurbogol', 'Adm1n', 'Sala oficial', 'Guest 4821', 'staff_room']) {
    // An account each (the create limit counts per player).
    const r = await call(w.env, 'POST', '/api/lobbies', { token: await accountToken(hexId(0xa000 + ++n)), body: { ...SETTINGS, name } });
    assert.equal(r.status, 400, name);
    assert.equal(r.json.error, 'name_reserved', name);
  }
  assert.equal(w.dir.calls.length + w.lobby.calls.length, 0, 'no code, no lobby');
});

test('lobbyNameIssue: what it refuses, and the titles it leaves alone', () => {
  for (const bad of ['Invitado 4821', 'invitado 0001', 'Ιnvitado 4821', 'Soporte', 'SOPORTE TG', 'Ѕoporte', 'S0p0rte', 'Sopórte', 'support', 'Supp0rt', 'Admin', 'Adm1n', 'Ana_Admin', 'staff', 'St4ff', 'Moderador', 'moderator', 'Oficial', 'Sala oficial', 'official', '0fficial', 'turbogol', 'Turbogol', 'TURBO GOL', 'Turbo_Gol', 'Turb0g0l', 'Turbogoi', 'Тurbоgоl', 'Τurbogol', 'Sala Turbogol!']) {
    assert.equal(lobbyNameIssue(bad), 'name_reserved', bad);
  }
  for (const ok of ['Sala de Ana', 'Lobby Ana', 'Los del barrio', 'Turbo', 'Gol de oro', 'Oficina', 'Administradores del 3v3', 'Sala 4821', 'Invitados bienvenidos', 'Bot 1', 'Ana', 'Constantinopla_9', 'Ronda #3!', 'Мой лобби']) {
    assert.equal(lobbyNameIssue(ok), null, ok);
  }
});

test("LobbyDO: a guest host's create and settings never set the title; the account it passes to may, within the rules", async () => {
  const h = await lobbyOn();
  const guest = hexId(0x4242);
  const wire = guestNameOf(guest);
  assert.equal((await h.create({ ...SETTINGS, name: 'Soporte Turbogol' }, { playerId: guest, name: wire, guest: true })).status, 200);
  assert.equal(h.summary().name, wire, 'the title is the host wire name');
  const host = await h.upgrade(guest);
  // The guest host's settings: the name is dropped, the rest applies.
  await h.send(host, { t: 'settings', settings: { name: 'Admin', mode: '3v3' } });
  assert.deepEqual(host.of('error'), []);
  let st = host.last();
  assert.equal(st.settings.name, wire);
  assert.equal(st.settings.mode, '3v3');
  // An account joins and the guest hands it the lobby.
  const acct = await h.join(ACCOUNT_ID, 'Ana', false);
  await h.send(host, { t: 'host', member: acct.last().you });
  // Its format change with no name, or with the stored title as it is: saved, the title kept.
  await h.send(acct, { t: 'settings', settings: { mode: '1v1' } });
  assert.deepEqual(acct.of('error'), [], 'no name: saved');
  await h.send(acct, { t: 'settings', settings: { name: wire, mode: '2v2', visibility: 'private' } });
  assert.deepEqual(acct.of('error'), [], 'the inherited Invitado NNNN: saved as it is');
  st = acct.last();
  assert.equal(st.settings.name, wire);
  assert.equal(st.settings.mode, '2v2');
  assert.equal(st.settings.visibility, 'private');
  // A new title: checked (refused ones answer name_reserved and change nothing), else taken.
  for (const name of ['Invitado 1234', 'Soporte Turbogol', 'Ѕoporte']) {
    await h.send(acct, { t: 'settings', settings: { name, mode: '1v1' } });
    assert.equal(acct.of('error').at(-1).code, 'name_reserved', name);
  }
  assert.equal(acct.last().settings.mode, '2v2', 'a refused title changes nothing');
  await h.send(acct, { t: 'settings', settings: { name: 'Los del barrio' } });
  assert.equal(acct.last().settings.name, 'Los del barrio');
});

test("LobbyDO: an account host's create checks its title (name_reserved), never its default (the username)", async () => {
  const refused = await lobbyOn();
  const r = await refused.create({ ...SETTINGS, name: 'Soporte' }, { playerId: ACCOUNT_ID, name: 'Ana', guest: false });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'name_reserved');
  // A username the title rules would refuse ('TurboGolFan') is still its own lobby's default.
  const own = await lobbyOn();
  assert.equal((await own.create(SETTINGS, { playerId: ACCOUNT_ID, name: 'TurboGolFan', guest: false })).status, 200);
  assert.equal(own.summary().name, 'TurboGolFan');
});

test("LobbyDO: a record written before (chosen guest names, a guest's title) comes back with each guest's Invitado NNNN", async () => {
  const first = await lobbyOn();
  const g1 = hexId(0x1111);
  const g2 = hexId(0x2222);
  assert.equal((await first.create(SETTINGS, { playerId: g1, name: guestNameOf(g1), guest: true })).status, 200);
  await first.upgrade(g1);
  await first.join(ACCOUNT_ID, 'Ana', false);
  await first.join(g2, guestNameOf(g2), true);
  await first.admit(hexId(0x3333), 'Pending', true);
  // As a deploy before this rule left it: the names and the title the guests chose.
  const stored = first.ctx.storage.map.get('lobby');
  stored.members[0].name = 'Admin';
  stored.members[2].name = 'Bot 1';
  stored.admits.find((a) => a.playerId === hexId(0x3333)).name = 'Moderador';
  stored.settings.name = 'Soporte Turbogol';
  // A wake-up: a new object over the same storage.
  const again = await lobbyOn(new FakeLobbyCtx(first.ctx.storage));
  const peek = await again.req('GET', '/internal/peek');
  assert.equal(peek.json.host, guestNameOf(g1), 'the host, renamed');
  assert.equal(peek.json.name, guestNameOf(g1), "the guest's title: the host's name");
  await again.lobby.alarm(); // the heartbeat saves and publishes it
  const rec = again.ctx.storage.map.get('lobby');
  assert.deepEqual(rec.members.map((m) => m.name), [guestNameOf(g1), 'Ana', guestNameOf(g2)], "the account's name stays");
  assert.equal(rec.admits.find((a) => a.playerId === hexId(0x3333)).name, guestNameOf(hexId(0x3333)), 'a pending admit too');
  assert.equal(again.summary().host, guestNameOf(g1));
  assert.equal(L.settleGuestNames(structuredClone(rec)), false, 'nothing left to change');
});
