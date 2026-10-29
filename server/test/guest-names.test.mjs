// Guest names assigned by the server (spec PR 1; audit auth-10, authz-5, rt-7): POST /api/guest
// ignores a chosen name and answers 'Invitado NNNN' from the player id; verifySession rewrites the
// name an older guest session carries (an account's stays), so every route reads the server's.
// 'cloudflare:workers' is stubbed. Run from server/: npm test
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
const { usernameIssue } = await import('../../src/net/account.ts');

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
const hexId = (n) => n.toString(16).padStart(16, '0');

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
