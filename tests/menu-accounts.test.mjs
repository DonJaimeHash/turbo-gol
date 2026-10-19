// Front-end menus and their network clients without a browser: the spatial navigation picker
// (src/ui/nav.ts), the OAuth hash parsing, AccountClient (src/net/AccountClient.ts) and
// LobbyClient (src/net/LobbyClient.ts) on fake fetch / WebSocket.
//   node --test tests/menu-accounts.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (relative && err && err.code === 'ERR_MODULE_NOT_FOUND' && !/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + '.ts', context);
      throw err;
    }
  },
});

const NAV = await import('../src/ui/nav.ts');
const AC = await import('../src/net/AccountClient.ts');
const LC = await import('../src/net/LobbyClient.ts');
const ACC = await import('../src/net/account.ts');

const R = (left, top, width = 100, height = 40) => ({ left, top, width, height, right: left + width, bottom: top + height });

test('pickTarget: the row / column aimed at wins over a nearer diagonal; nothing behind', () => {
  const from = R(100, 100);
  // A 2x2 grid around: right neighbour, below neighbour, a diagonal.
  const rects = [R(260, 100), R(100, 200), R(240, 160), R(-100, 100)];
  assert.equal(NAV.pickTarget(from, 'right', rects), 0);
  assert.equal(NAV.pickTarget(from, 'down', rects), 1);
  assert.equal(NAV.pickTarget(from, 'left', rects), 3);
  assert.equal(NAV.pickTarget(from, 'up', rects), -1);
  // A wide button under two narrow ones is reachable from either.
  assert.equal(NAV.pickTarget(R(300, 100), 'down', [R(0, 200, 600, 50)]), 0);
});

test('parseAuthHash / oauthErrorText', () => {
  assert.deepEqual(AC.parseAuthHash('#auth=ok'), { kind: 'ok' });
  assert.deepEqual(AC.parseAuthHash('#x=1&auth=new'), { kind: 'new' });
  assert.deepEqual(AC.parseAuthHash('#auth=error:already_linked'), { kind: 'error', code: 'already_linked' });
  assert.equal(AC.parseAuthHash('#nancheck'), null);
  assert.equal(AC.parseAuthHash(''), null);
  assert.match(AC.oauthErrorText('cancelled'), /You cancelled the sign-in/);
});

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), map: m };
}

function res(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function fakeServer(handlers) {
  const calls = [];
  const fetchFn = async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method: init.method, body, headers: init.headers });
    const h = handlers[path.split('?')[0]];
    if (!h) return res(404, { error: 'not_found' });
    return h(body, init.headers, path);
  };
  return { fetchFn, calls };
}

const SESSION = (name, expiresAt) => ({ kind: 'account', playerId: 'abcdef0123456789', name, session: 'jwt-' + name, expiresAt });

test('AccountClient: login sends the client key (never the password), adopts the session, keeps a hint; logout clears both', async () => {
  const srv = fakeServer({
    '/api/auth/login': (b) => res(200, SESSION('Tomi', Date.now() + 3600_000)),
    '/api/auth/logout': () => res(200, { ok: true }),
  });
  const storage = memStorage();
  const a = new AC.AccountClient({ fetchFn: srv.fetchFn, storage });
  let changes = 0;
  a.onChange = () => changes++;
  await a.login('Tomi', 'correct horse battery');
  const sent = srv.calls[0].body;
  assert.equal(sent.username, 'Tomi');
  assert.notEqual(sent.password, 'correct horse battery');
  assert.equal(sent.password, await ACC.clientPasswordKey('Tomi', 'correct horse battery'));
  assert.equal(a.signedIn, true);
  assert.equal(a.hintName, 'Tomi');
  assert.ok(changes >= 1);
  await a.logout();
  assert.equal(a.signedIn, false);
  assert.equal(a.hintName, null);
  await assert.rejects(a.login('', ''), (e) => e instanceof AC.AccountError && e.code === 'empty');
});

test("AccountClient: server errors become AccountError with the code and the player's text for it; register validates first and sends the anti-bot token", async () => {
  const srv = fakeServer({
    '/api/auth/login': () => res(401, { error: 'bad_credentials', message: 'Usuario o contraseña incorrectos' }),
    '/api/auth/register': (b) => (b.turnstileToken === 'tok' ? res(200, { ...SESSION(b.username, Date.now() + 3600_000), recoveryCodes: ['AAAA-BBBB'] }) : res(403, { error: 'turnstile_failed' })),
  });
  const a = new AC.AccountClient({ fetchFn: srv.fetchFn, storage: null, antiBot: async () => 'tok' });
  // The client's text for the code (English outside a browser; src/locales/es.ts has the server's Spanish).
  await assert.rejects(a.login('x', 'y'), (e) => e instanceof AC.AccountError && e.status === 401 && e.code === 'bad_credentials' && e.message === 'Wrong username or password');
  await assert.rejects(a.register('ab', 'a fine password'), (e) => e.code === 'bad_username' && e.message === 'The username must be 3 to 16 characters long');
  await assert.rejects(a.register('Mariana', 'short'), (e) => e.code === 'bad_password' && e.message === 'The password must be at least 8 characters');
  const n = srv.calls.length;
  assert.equal(n, 1, 'invalid input never reaches the server');
  const r = await a.register('Mariana', 'a fine password');
  assert.deepEqual(r.recoveryCodes, ['AAAA-BBBB']);
  assert.equal(srv.calls.at(-1).body.turnstileToken, 'tok');
  assert.equal(a.account.name, 'Mariana');
});

test("AccountClient: a code without a server text still gets the client's text; an unknown code keeps the server's message; no body: the generic one", async () => {
  let answer = res(429, { error: 'rate_limited', message: 'rate_limited' });
  const srv = fakeServer({ '/api/auth/login': () => answer });
  const a = new AC.AccountClient({ fetchFn: srv.fetchFn, storage: null });
  const rejects = (check) => assert.rejects(a.login('Tomi', 'a fine password'), (e) => e instanceof AC.AccountError && check(e));
  await rejects((e) => e.code === 'rate_limited' && e.status === 429 && e.message === 'Too many attempts, wait a minute');
  answer = res(429, { error: 'throttled', message: 'Demasiados intentos, espera un momento', retryAfterMs: 5000 });
  await rejects((e) => e.code === 'throttled' && e.retryAfterMs === 5000 && e.message === 'Too many attempts, wait a moment');
  answer = res(400, { error: 'new_code', message: 'A server text' });
  await rejects((e) => e.code === 'new_code' && e.message === 'A server text');
  answer = res(400, { error: 'bad_request', message: 'bad_request' });
  await rejects((e) => e.code === 'bad_request' && e.message === 'Server error (400)');
  answer = { ok: false, status: 502, json: async () => JSON.parse('<html>') };
  await rejects((e) => e.code === 'http' && e.status === 502 && e.message === 'Server error (502)');
});

test('AccountClient: sessionForQueue refreshes near expiry (one request for concurrent callers); a 401 refresh signs out', async () => {
  let now = 1_000_000;
  let refreshes = 0;
  let refreshStatus = 200;
  const srv = fakeServer({
    '/api/auth/refresh': () => {
      refreshes++;
      return refreshStatus === 200 ? res(200, SESSION('Tomi', now + 3600_000)) : res(401, { error: 'bad_refresh' });
    },
  });
  const a = new AC.AccountClient({ fetchFn: srv.fetchFn, storage: memStorage(), now: () => now });
  assert.equal(await a.sessionForQueue(), null, 'guest');
  assert.equal((await a.restore()).name, 'Tomi');
  assert.equal(refreshes, 1);
  assert.equal((await a.sessionForQueue()).session, 'jwt-Tomi', 'fresh: no refresh');
  assert.equal(refreshes, 1);
  now += 3600_000 - 60_000; // one minute left
  await Promise.all([a.sessionForQueue(), a.sessionForQueue()]);
  assert.equal(refreshes, 2, 'one refresh for both');
  refreshStatus = 401;
  assert.equal(await a.sessionRejected(), null);
  assert.equal(a.signedIn, false);
  assert.equal(a.hintName, null);
});

test('AccountClient.waitRankedResult polls until the result is there', async () => {
  let n = 0;
  const srv = fakeServer({
    '/api/ranked/result': () => res(200, ++n < 3 ? { status: 'pending' } : { status: 'done', playlist: '1v1', outcome: 'win', left: false, mmrBefore: 1000, mmrAfter: 1105, tierBefore: null, tierAfter: null, placementLeft: 4, banUntil: 0 }),
  });
  const a = new AC.AccountClient({ fetchFn: srv.fetchFn, storage: null });
  a.account = SESSION('Tomi', Date.now() + 3600_000);
  const r = await a.waitRankedResult('f'.repeat(64), 10, 1);
  assert.equal(r.status, 'done');
  assert.equal(n, 3);
  assert.match(srv.calls[0].headers.authorization, /^Bearer jwt-Tomi$/);
});

class FakeWs {
  static last = null;
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.sent = [];
    this.readyState = 0;
    FakeWs.last = this;
  }
  send(d) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(msg) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

test('LobbyClient: create -> socket with the ticket -> state -> match -> leave', async () => {
  const srv = fakeServer({
    '/api/lobbies': (b, h) => {
      assert.equal(h.authorization, 'Bearer guest-jwt');
      assert.equal(b.password, 'pw');
      return res(200, { lobbyId: 'L'.repeat(64), code: 'ABC234', ticket: 'TICKET', wsUrl: 'ws://x/lobby/L' });
    },
    '/api/lobbies/join': () => res(403, { error: 'bad_password', message: 'Contraseña incorrecta' }),
  });
  const lc = new LC.LobbyClient({ fetchFn: srv.fetchFn, webSocketFactory: (u, p) => new FakeWs(u, p), bearer: async () => 'guest-jwt' });
  const states = [];
  const matches = [];
  lc.onState = (s) => states.push(s);
  lc.onMatch = (r) => matches.push(r);
  await lc.create({ settings: { name: 'Sala', mode: '2v2', visibility: 'public', net: 'p2p', matchLengthSeconds: 300 }, password: 'pw', region: 'SA' });
  const ws = FakeWs.last;
  assert.deepEqual(ws.protocols, ['tg1', 'ticket.TICKET']);
  assert.equal(lc.status, 'connecting');
  ws.open();
  assert.equal(lc.status, 'open');
  ws.receive({ t: 'state', lobby: { code: 'ABC234', settings: {}, hasPassword: true, region: 'SA', members: [{ id: 'm1', name: 'A', team: 0, host: true, guest: true, inGame: false }], you: 'm1', status: 'open' } });
  assert.equal(states.length, 1);
  assert.equal(lc.isHost, true);
  lc.start();
  assert.deepEqual(JSON.parse(ws.sent.at(-1)), { t: 'start' });
  // Socket refusals reach onError with the client's text for the code (a bare code: a refused start).
  const errors = [];
  lc.onError = (code, message) => errors.push([code, message]);
  ws.receive({ t: 'error', code: 'team_full', message: 'Ese equipo está completo' });
  ws.receive({ t: 'error', code: 'not_host', message: 'Solo el anfitrión inicia la partida' });
  ws.receive({ t: 'error', code: 'new_code', message: 'A server text' });
  ws.receive({ t: 'error', code: 'unavailable', message: 'unavailable' });
  assert.deepEqual(errors, [
    ['team_full', 'That team is full'],
    ['not_host', 'Only the host can do that'],
    ['new_code', 'A server text'],
    ['unavailable', "Couldn't start the match, try again"],
  ]);
  ws.receive({ t: 'match', result: { status: 'matched', kind: 'p2p', roomId: 'r', ticket: 't', wsUrl: 'ws://x/room/r' } });
  assert.equal(matches[0].roomId, 'r');
  lc.updateSettings({ mode: '3v3' }, null);
  assert.deepEqual(JSON.parse(ws.sent.at(-1)), { t: 'settings', settings: { mode: '3v3' }, password: null });
  let closed = null;
  lc.onClosed = (r) => (closed = r);
  lc.leave();
  assert.deepEqual(JSON.parse(ws.sent.at(-1)), { t: 'leave' });
  assert.equal(closed, null, 'leave() is silent');
  assert.equal(lc.status, 'idle');
  await assert.rejects(lc.join('ABC234', 'nope'), (e) => e.code === 'bad_password' && e.message === 'Invalid password');
});

test("LobbyClient: a refused request carries the client's text for the code, else the server's message, else the generic one", async () => {
  let answer = res(404, { error: 'no_lobby', message: 'No existe una sala con ese código' });
  const srv = fakeServer({ '/api/lobbies/join': () => answer });
  const lc = new LC.LobbyClient({ fetchFn: srv.fetchFn, webSocketFactory: (u, p) => new FakeWs(u, p), bearer: async () => 'b' });
  const rejects = (check) => assert.rejects(lc.join('ABC234', null), (e) => e instanceof AC.AccountError && check(e));
  await rejects((e) => e.code === 'no_lobby' && e.status === 404 && e.message === "There's no lobby with that code");
  answer = res(429, { error: 'rate_limited', message: 'Demasiados intentos, espera un minuto' });
  await rejects((e) => e.code === 'rate_limited' && e.message === 'Too many attempts, wait a minute');
  answer = res(400, { error: 'new_code', message: 'A server text' });
  await rejects((e) => e.code === 'new_code' && e.message === 'A server text');
  answer = res(503, { error: 'matchmaking_off', message: 'matchmaking_off' });
  await rejects((e) => e.code === 'matchmaking_off' && e.message === 'Matchmaking is paused, try again later');
  answer = res(401, { error: 'unauthorized', message: 'unauthorized' });
  await rejects((e) => e.code === 'unauthorized' && e.message === 'Server error (401)');
});

test('LobbyClient: a server close reports the reason once (kicked)', async () => {
  const srv = fakeServer({ '/api/lobbies/join': () => res(200, { lobbyId: 'L', code: 'ABC234', ticket: 'T', wsUrl: 'ws://x/lobby/L' }) });
  const lc = new LC.LobbyClient({ fetchFn: srv.fetchFn, webSocketFactory: (u, p) => new FakeWs(u, p), bearer: async () => 'b' });
  const reasons = [];
  lc.onClosed = (r) => reasons.push(r);
  await lc.join('abc-234', null);
  const ws = FakeWs.last;
  ws.open();
  ws.onclose({ code: 4003, reason: '' });
  assert.deepEqual(reasons, ['kicked']);
  assert.equal(lc.inLobby, false);
  assert.match(LC.lobbyCloseText('kicked'), /kicked you from the lobby/);
});

test('LobbyClient: the public list needs no session (browsing never registers a guest)', async () => {
  const srv = fakeServer({
    '/api/lobbies': (b, h) => {
      assert.equal(h.authorization, undefined);
      return res(200, { lobbies: [{ id: 'L1' }] });
    },
  });
  let bearers = 0;
  const lc = new LC.LobbyClient({
    fetchFn: srv.fetchFn,
    webSocketFactory: (u, p) => new FakeWs(u, p),
    bearer: async () => {
      bearers++;
      return 'guest-jwt';
    },
  });
  assert.deepEqual(await lc.list('SA'), [{ id: 'L1' }]);
  assert.equal(bearers, 0);
  assert.equal(srv.calls[0].path, '/api/lobbies?region=SA');
  assert.equal(srv.calls[0].method, 'GET');
});
