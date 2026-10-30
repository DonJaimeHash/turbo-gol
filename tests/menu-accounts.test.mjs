// Front-end menus and their network clients without a browser: the spatial navigation picker
// (src/ui/nav.ts), the OAuth hash parsing, AccountClient (src/net/AccountClient.ts) and
// LobbyClient (src/net/LobbyClient.ts) on fake fetch / WebSocket.
//   node --test tests/menu-accounts.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
  // The screens import package.json as Vite does (no `with { type: 'json' }`): its version, as a module.
  load(url, context, nextLoad) {
    if (url.endsWith('/package.json') && context.importAttributes?.type !== 'json') {
      const { version } = JSON.parse(readFileSync(fileURLToPath(url), 'utf8'));
      return { format: 'module', shortCircuit: true, source: `export const version = ${JSON.stringify(version)}; export default { version: ${JSON.stringify(version)} };` };
    }
    return nextLoad(url, context);
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

test('AccountClient: the username sign-in sends the client key (never the password), adopts the session, keeps a hint; logout clears both', async () => {
  const srv = fakeServer({
    '/api/auth/login': (b) => res(200, SESSION('Tomi', Date.now() + 3600_000)),
    '/api/auth/logout': () => res(200, { ok: true }),
  });
  const storage = memStorage();
  const a = new AC.AccountClient({ fetchFn: srv.fetchFn, storage });
  let changes = 0;
  a.subscribe(() => changes++);
  await a.legacySignIn('Tomi', 'correct horse battery');
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
  await assert.rejects(a.legacySignIn('', ''), (e) => e instanceof AC.AccountError && e.code === 'empty');
});

test("AccountClient: server errors become AccountError with the code and the player's text for it (one bad_credentials, a text per form); the sign-up checks the name and the password first", async () => {
  const srv = fakeServer({
    '/api/auth/login': () => res(401, { error: 'bad_credentials', message: 'Usuario o contraseña incorrectos' }),
    '/api/auth/signin': () => res(401, { error: 'bad_credentials', message: 'Correo o contraseña incorrectos' }),
    '/api/auth/signup/finish': (b) => res(200, SESSION(b.username, Date.now() + 3600_000)),
  });
  const a = new AC.AccountClient({ fetchFn: srv.fetchFn, storage: null, session: null, antiBot: async () => 'tok' });
  // The client's text for the code (English outside a browser; src/locales/es.ts has the server's Spanish).
  await assert.rejects(a.legacySignIn('x', 'y'), (e) => e instanceof AC.AccountError && e.status === 401 && e.code === 'bad_credentials' && e.message === 'Wrong username or password');
  await assert.rejects(a.signIn('x@example.com', 'y'), (e) => e instanceof AC.AccountError && e.status === 401 && e.code === 'bad_credentials' && e.message === 'Wrong email or password');
  const proof = { attempt: 'a'.repeat(43), code: '123456' };
  await assert.rejects(a.signupFinish(proof, { username: 'ab', password: 'a fine password', news: false, email: 'mariana@example.com' }), (e) => e.code === 'bad_username' && e.message === 'The username must be 3 to 16 characters long');
  await assert.rejects(a.signupFinish(proof, { username: 'Mariana', password: 'short', news: false, email: 'mariana@example.com' }), (e) => e.code === 'bad_password' && e.message === 'The password must be at least 8 characters');
  await assert.rejects(a.signupFinish(proof, { username: 'Mariana', password: 'my mariana box', news: false, email: 'mariana@example.com' }), (e) => e.code === 'bad_password' && e.message === "The password can't contain your username");
  await assert.rejects(a.signupFinish(proof, { username: 'Juana', password: 'mariana.perez22', news: false, email: 'Mariana.Perez+tg@gmail.com' }), (e) => e.code === 'bad_password' && e.message === "The password can't contain your email");
  assert.equal(srv.calls.length, 2, 'invalid input never reaches the server');
  const s = await a.signupFinish(proof, { username: 'Mariana', password: 'a fine password', news: true, email: 'mariana@example.com' });
  assert.equal(s.name, 'Mariana');
  assert.equal(srv.calls.at(-1).body.turnstileToken, undefined, 'the finish carries the mailbox proof, no anti-bot token');
  assert.equal(a.account.name, 'Mariana');
});

test("AccountClient: a code without a server text still gets the client's text; an unknown code keeps the server's message; no body: the generic one", async () => {
  let answer = res(429, { error: 'rate_limited', message: 'rate_limited' });
  const srv = fakeServer({ '/api/auth/login': () => answer });
  const a = new AC.AccountClient({ fetchFn: srv.fetchFn, storage: null });
  const rejects = (check) => assert.rejects(a.legacySignIn('Tomi', 'a fine password'), (e) => e instanceof AC.AccountError && check(e));
  await rejects((e) => e.code === 'rate_limited' && e.status === 429 && e.message === 'Too many attempts, wait a minute');
  answer = res(429, { error: 'throttled', message: 'Demasiados intentos, espera un momento', retryAfterMs: 5000 });
  await rejects((e) => e.code === 'throttled' && e.retryAfterMs === 5000 && e.message === 'Too many attempts, wait a moment');
  answer = res(400, { error: 'new_code', message: 'A server text' });
  await rejects((e) => e.code === 'new_code' && e.message === 'A server text');
  answer = res(400, { error: 'bad_request', message: 'bad_request' });
  await rejects((e) => e.code === 'bad_request' && e.message === 'Server error');
  answer = { ok: false, status: 502, json: async () => JSON.parse('<html>') };
  await rejects((e) => e.code === 'http' && e.status === 502 && e.message === 'Server error');
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

test("AccountClient.sessionForQueue during a page load's restore: the account's session, not a guest's", async () => {
  let answer = null;
  const srv = fakeServer({ '/api/auth/refresh': () => new Promise((r) => (answer = r)) });
  const a = new AC.AccountClient({ fetchFn: srv.fetchFn, storage: memStorage(), now: () => 1_000_000 });
  const restoring = a.restore();
  // A Sala joined again after a reload asks while the refresh cookie is still being read.
  const asked = a.sessionForQueue();
  while (answer === null) await new Promise((r) => setTimeout(r, 1));
  answer(res(200, SESSION('Tomi', 1_000_000 + 3600_000)));
  assert.equal((await asked)?.session, 'jwt-Tomi', 'waited for the restore');
  assert.equal((await restoring).name, 'Tomi');
  assert.equal(srv.calls.length, 1, 'one refresh');
});

test('AccountClient.sessionForQueue(minValidMs): a match on a community node asks for a Bearer that outlasts it', async () => {
  let now = 1_000_000;
  let refreshes = 0;
  const srv = fakeServer({
    '/api/auth/refresh': () => {
      refreshes++;
      return res(200, SESSION('Tomi', now + 3600_000));
    },
  });
  const a = new AC.AccountClient({ fetchFn: srv.fetchFn, storage: memStorage(), now: () => now });
  await a.restore();
  now += 3600_000 - 10 * 60_000; // ten minutes left
  assert.equal((await a.sessionForQueue()).expiresAt, 1_000_000 + 3600_000, 'enough for a queue: no refresh');
  assert.equal(refreshes, 1);
  assert.equal((await a.sessionForQueue(15 * 60_000)).expiresAt, now + 3600_000);
  assert.equal(refreshes, 2);
  assert.equal((await a.sessionForQueue(15 * 60_000)).expiresAt, now + 3600_000, 'fresh now: no second refresh');
  assert.equal(refreshes, 2);
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

const DONE = { status: 'done', playlist: '1v1', outcome: 'win', left: false, mmrBefore: 1000, mmrAfter: 1105, tierBefore: null, tierAfter: null, placementLeft: 4, banUntil: 0 };

/** An AccountClient on a fake clock that only the waits between polls move; `answer(n)` is the n-th /api/ranked/result answer. */
function rankedPoller(answer) {
  let t = 5_000_000;
  const asked = [];
  const srv = fakeServer({
    '/api/ranked/result': () => {
      asked.push(t);
      return res(200, answer(asked.length));
    },
  });
  const a = new AC.AccountClient({ fetchFn: srv.fetchFn, storage: null, now: () => t, sleep: async (ms) => void (t += ms) });
  a.account = SESSION('Tomi', t + 3600_000);
  const p = { a, asked, verifying: 0, onVerifying: () => p.verifying++, at: () => asked.map((x) => x - asked[0]) };
  return p;
}

test('AccountClient.waitRankedResult on a community node: past the fast tries it says "verifying" once and asks every 3 s', async () => {
  const p = rankedPoller((n) => (n <= 3 ? { status: 'pending' } : DONE));
  const r = await p.a.waitRankedResult('f'.repeat(64), 2, 1000, { node: true, onVerifying: p.onVerifying });
  assert.equal(r.status, 'done', 'three pending answers, then the result');
  assert.equal(p.verifying, 1);
  assert.deepEqual(p.at(), [0, 1000, 5000, 8000]);
  // The result inside the fast tries: nothing to announce.
  const quick = rankedPoller((n) => (n <= 3 ? { status: 'pending' } : DONE));
  assert.equal((await quick.a.waitRankedResult('f'.repeat(64), 15, 1000, { node: true, onVerifying: quick.onVerifying })).status, 'done');
  assert.equal(quick.verifying, 0);
  assert.equal(quick.asked.length, 4);
  // A Durable Object host: the fast tries are all there is.
  const server = rankedPoller(() => ({ status: 'pending' }));
  assert.equal((await server.a.waitRankedResult('f'.repeat(64), 2, 1000, { onVerifying: server.onVerifying })).status, 'pending');
  assert.equal(server.verifying, 0);
  assert.deepEqual(server.at(), [0, 1000]);
});

test('AccountClient.waitRankedResult on a community node gives up 120 s after its first poll, still pending', async () => {
  const p = rankedPoller(() => ({ status: 'pending' }));
  const r = await p.a.waitRankedResult('f'.repeat(64), undefined, undefined, { node: true, onVerifying: p.onVerifying });
  assert.equal(r.status, 'pending');
  assert.equal(p.verifying, 1);
  const at = p.at();
  assert.equal(at.length, 15 + 35, '15 fast polls a second apart, then one every 3 s');
  assert.equal(at[14], 14_000);
  assert.equal(at[15], 18_000);
  assert.equal(at.at(-1), 120_000, 'the last poll is at the cap, none after it');
});

test('showRankedResult: a node match still pending is being verified; a failed or missing replay check voids it', async () => {
  const { showRankedResult } = await import('../src/ui/screens/leaderboard.ts');
  const toasts = [];
  const menu = { toast: (text, kind) => toasts.push([text, kind]) };
  showRankedResult(menu, { status: 'pending' });
  showRankedResult(menu, { status: 'pending' }, true);
  // AccountsDO keeps 32 characters of the reason: 'verification_failed:' + a cut 'bad_takeover_time'.
  showRankedResult(menu, { status: 'cancelled', reason: 'verification_failed:bad_takeover' }, true);
  showRankedResult(menu, { status: 'cancelled', reason: 'unverified' }, true);
  showRankedResult(menu, { status: 'cancelled', reason: 'not_rated' });
  showRankedResult(menu, { status: 'cancelled', reason: 'no_show' });
  assert.deepEqual(toasts, [
    ['Your Competitive result is still being calculated: check your profile.', 'info'],
    ['Your Competitive result is still being verified: check your profile in a few minutes.', 'info'],
    ["The Competitive match couldn't be verified and didn't count", 'info'],
    ["The Competitive match couldn't be verified and didn't count", 'info'],
    ["That match didn't count for your rank", 'info'],
    ["The Competitive match was cancelled and didn't count", 'info'],
  ]);
});

const OTHER = (expiresAt) => ({ ...SESSION('Other', expiresAt), playerId: '0123456789abcdef' });

test('AccountClient.waitRankedResult stops asking once another account is signed in: the match is not theirs', async () => {
  const p = rankedPoller((n) => {
    if (n === 3) p.a.account = OTHER(p.a.account.expiresAt);
    return { status: 'pending' };
  });
  assert.equal((await p.a.waitRankedResult('f'.repeat(64), undefined, undefined, { node: true, onVerifying: p.onVerifying })).status, 'pending');
  assert.equal(p.asked.length, 3, 'never asked as the other account');
  assert.equal(p.verifying, 0);
  // During the replay check's wait.
  const q = rankedPoller((n) => {
    if (n === 17) q.a.account = OTHER(q.a.account.expiresAt);
    return { status: 'pending' };
  });
  await q.a.waitRankedResult('f'.repeat(64), undefined, undefined, { node: true, onVerifying: q.onVerifying });
  assert.equal(q.asked.length, 17);
  assert.equal(q.verifying, 1);
});

const VERIFYING = 'Your Competitive result is being verified: it will show up here once it is ready.';
const VERIFYING_SLOW = 'Your Competitive result is still being verified: check your profile in a few minutes.';
const VOIDED = "The Competitive match couldn't be verified and didn't count";

/** A RankedResults on a rankedPoller and a fake menu that records its toasts (no DOM: no dialogs). */
async function rankedResults(answer, onScreen = () => true) {
  const { RankedResults } = await import('../src/ui/screens/leaderboard.ts');
  const p = rankedPoller(answer);
  const toasts = [];
  const menu = { toast: (text) => toasts.push(text), modal: () => assert.fail('no dialog for these answers') };
  return { p, toasts, results: new RankedResults({ accounts: p.a, menu, onScreen }) };
}

test('RankedResults (Game.showMenu): a node match says it is being verified once, then that it still is; a Durable Object match only waits the fast tries', async () => {
  const node = await rankedResults(() => ({ status: 'pending' }));
  await node.results.watch('f'.repeat(64), true);
  assert.deepEqual(node.toasts, [VERIFYING, VERIFYING_SLOW]);
  assert.equal(node.p.asked.length, 15 + 35, 'the whole two-minute wait');
  const server = await rankedResults(() => ({ status: 'pending' }));
  await server.results.watch('f'.repeat(64), false);
  assert.deepEqual(server.toasts, ['Your Competitive result is still being calculated: check your profile.']);
  assert.equal(server.p.asked.length, 15);
});

test('RankedResults: what comes while the menus are away waits for them, the result replacing "verifying"; another account never sees it', async () => {
  const voided = { status: 'cancelled', reason: 'verification_failed:bad_takeover' };
  // The player goes into another match 3 s after the menu came back; the replay check fails at about a minute.
  let onScreen = true;
  const away = await rankedResults((n) => {
    if (n === 4) onScreen = false;
    return n < 20 ? { status: 'pending' } : voided;
  }, () => onScreen);
  await away.results.watch('f'.repeat(64), true);
  assert.deepEqual(away.toasts, [], 'a toast now would fade behind the match');
  away.results.showHeld();
  assert.deepEqual(away.toasts, []);
  onScreen = true;
  away.results.showHeld();
  assert.deepEqual(away.toasts, [VOIDED], 'the result alone: "verifying" is stale by now');
  away.results.showHeld();
  assert.deepEqual(away.toasts, [VOIDED], 'once');

  // Back in the menus while the check still runs: "verifying" then, the result when it comes.
  let back = true;
  const mid = await rankedResults((n) => {
    if (n === 4) back = false;
    if (n === 18) {
      back = true;
      mid.results.showHeld();
    }
    return n < 20 ? { status: 'pending' } : voided;
  }, () => back);
  await mid.results.watch('f'.repeat(64), true);
  assert.deepEqual(mid.toasts, [VERIFYING, VOIDED]);

  // Held, then another account signs in before the menus are back: dropped.
  let shown = false;
  const other = await rankedResults((n) => (n < 20 ? { status: 'pending' } : voided), () => shown);
  await other.results.watch('f'.repeat(64), true);
  other.p.a.account = OTHER(other.p.a.account.expiresAt);
  shown = true;
  other.results.showHeld();
  assert.deepEqual(other.toasts, []);
});

test('RankedResults into the FINAL (plan PR 7): the rank card takes the answer while it is up; once it is not, the old way', async () => {
  const voided = { status: 'cancelled', reason: 'verification_failed:bad_takeover' };
  // The FINAL is up: the card takes it, no toast, nothing held.
  const up = await rankedResults((n) => (n < 3 ? { status: 'pending' } : voided));
  const card = [];
  await up.results.watch('f'.repeat(64), false, (r) => (card.push(r.status), true));
  assert.deepEqual(card, ['cancelled']);
  assert.deepEqual(up.toasts, []);
  up.results.showHeld();
  assert.deepEqual(up.toasts, [], 'nothing held for later');
  // The player left the FINAL first: the card declines, the toast comes as before.
  const left = await rankedResults((n) => (n < 3 ? { status: 'pending' } : voided));
  await left.results.watch('f'.repeat(64), false, () => false);
  assert.deepEqual(left.toasts, [VOIDED]);
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
  await rejects((e) => e.code === 'unauthorized' && e.message === 'Server error');
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

// ---- experimental features: the listener list, the { name, id } hint, the API calls ----------------

test('AccountClient.subscribe: every listener hears each change, an unsubscribed one does not, a throwing one stops nobody', async () => {
  const srv = fakeServer({
    '/api/auth/login': () => res(200, SESSION('Tomi', Date.now() + 3600_000)),
    '/api/auth/logout': () => res(200, { ok: true }),
  });
  const a = new AC.AccountClient({ fetchFn: srv.fetchFn, storage: memStorage() });
  const heard = [];
  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    a.subscribe(() => heard.push('menu'));
    a.subscribe(() => {
      throw new Error('boom');
    });
    const off = a.subscribe(() => heard.push('game'));
    await a.legacySignIn('Tomi', 'correct horse battery');
    assert.deepEqual(heard, ['menu', 'game']);
    off();
    await a.logout();
    assert.deepEqual(heard, ['menu', 'game', 'menu']);
    assert.equal(errors.length, 2, 'the throwing listener is logged each time');
  } finally {
    console.error = realError;
  }
});

test('the account hint keeps { name, id }; a hint from before the id reads as no id; sign-out removes it', async () => {
  const storage = memStorage();
  const srv = fakeServer({
    '/api/auth/login': () => res(200, SESSION('Tomi', Date.now() + 3600_000)),
    '/api/auth/logout': () => res(200, { ok: true }),
  });
  const a = new AC.AccountClient({ fetchFn: srv.fetchFn, storage });
  await a.legacySignIn('Tomi', 'correct horse battery');
  assert.deepEqual(JSON.parse(storage.getItem(AC.ACCOUNT_HINT_KEY)), { name: 'Tomi', id: 'abcdef0123456789' });
  assert.deepEqual(AC.readAccountHint(storage), { name: 'Tomi', id: 'abcdef0123456789' });
  assert.equal(a.hintId, 'abcdef0123456789');
  storage.setItem(AC.ACCOUNT_HINT_KEY, JSON.stringify({ name: 'Tomi' }));
  assert.deepEqual(AC.readAccountHint(storage), { name: 'Tomi', id: null }, 'written before this release');
  assert.equal(a.hintName, 'Tomi');
  assert.equal(a.hintId, null);
  storage.setItem(AC.ACCOUNT_HINT_KEY, JSON.stringify({ name: 'Tomi', id: '../x' }));
  assert.equal(AC.readAccountHint(storage).id, null, 'only an account id');
  storage.setItem(AC.ACCOUNT_HINT_KEY, '{nope');
  assert.equal(AC.readAccountHint(storage), null);
  assert.equal(AC.readAccountHint(null), null);
  await a.logout();
  assert.equal(storage.getItem(AC.ACCOUNT_HINT_KEY), null);
});

test('AccountClient experimental calls: Bearer, paths and bodies, the answer parsed leniently, 409 too_many and a refused session', async () => {
  const PRESET = { id: '0123456789ab', name: 'Low gravity', values: { gravity: 50 }, updatedAt: 0 };
  let presetStatus = 200;
  let getStatus = 200;
  const srv = fakeServer({
    '/api/me/experimental': (b, h) => {
      if (b === undefined) return getStatus === 200 ? res(200, { enabled: true, presets: [{ ...PRESET, values: { gravity: 47, nope: 3 }, updatedAt: 5 }, { id: 'bad', name: 'x' }] }) : res(getStatus, { error: 'unauthorized' });
      return res(200, { enabled: b.enabled, presets: [] });
    },
    '/api/me/presets': (b) => (presetStatus === 200 ? res(200, { enabled: false, presets: [{ ...b.preset, updatedAt: 9 }] }) : res(409, { error: 'too_many', message: 'too_many' })),
    '/api/me/presets/delete': (b) => res(200, { enabled: false, presets: [] }),
    '/api/auth/refresh': () => res(401, { error: 'bad_refresh' }),
  });
  const a = new AC.AccountClient({ fetchFn: srv.fetchFn, storage: null });
  await assert.rejects(a.fetchExperimental(), (e) => e instanceof AC.AccountError && e.code === 'unauthorized', 'a guest: no request');
  assert.equal(srv.calls.length, 0);
  a.account = SESSION('Tomi', Date.now() + 3600_000);
  const got = await a.fetchExperimental();
  assert.equal(srv.calls[0].method, 'GET');
  assert.equal(srv.calls[0].headers.authorization, 'Bearer jwt-Tomi');
  assert.deepEqual(got, { enabled: true, presets: [{ id: '0123456789ab', name: 'Low gravity', values: { gravity: 50 }, updatedAt: 5 }] }, 'snapped, unknown key and bad preset dropped');
  assert.deepEqual(await a.setExperimental(false), { enabled: false, presets: [] });
  assert.deepEqual(srv.calls.at(-1).body, { enabled: false });
  assert.equal(srv.calls.at(-1).method, 'POST');
  const up = await a.upsertPreset({ ...PRESET, updatedAt: 123 });
  assert.deepEqual(srv.calls.at(-1).body, { preset: { id: '0123456789ab', name: 'Low gravity', values: { gravity: 50 } } }, 'the server stamps updatedAt');
  assert.equal(up.presets[0].updatedAt, 9);
  presetStatus = 409;
  await assert.rejects(a.upsertPreset(PRESET), (e) => e instanceof AC.AccountError && e.code === 'too_many' && e.status === 409 && e.message === '10 presets at most: delete one first');
  await a.deletePreset('0123456789ab');
  assert.deepEqual(srv.calls.at(-1), { path: '/api/me/presets/delete', method: 'POST', body: { id: '0123456789ab' }, headers: srv.calls.at(-1).headers });
  getStatus = 401;
  await assert.rejects(a.fetchExperimental(), (e) => e.code === 'unauthorized');
  assert.equal(a.signedIn, false, 'the refresh after the 401 failed: signed out');
});

test('AccountClient experimental calls: a 401 refreshes the session and sends the write again, once', async () => {
  const PRESET = { id: '0123456789ab', name: 'Low gravity', values: { gravity: 50 }, updatedAt: 0 };
  const sent = [];
  let refreshes = 0;
  let fresh = 'Fresh';
  const srv = fakeServer({
    '/api/me/presets': (b, h) => {
      sent.push(h.authorization);
      return h.authorization === 'Bearer jwt-Fresh' ? res(200, { enabled: true, presets: [{ ...b.preset, updatedAt: 3 }] }) : res(401, { error: 'unauthorized' });
    },
    '/api/auth/refresh': () => {
      refreshes++;
      return res(200, SESSION(fresh, Date.now() + 3600_000));
    },
  });
  const a = new AC.AccountClient({ fetchFn: srv.fetchFn, storage: null });
  a.account = SESSION('Tomi', Date.now() + 3600_000);
  const ans = await a.upsertPreset(PRESET);
  assert.deepEqual(sent, ['Bearer jwt-Tomi', 'Bearer jwt-Fresh'], 'the same write again with the new session');
  assert.equal(refreshes, 1);
  assert.equal(ans.presets[0].updatedAt, 3);
  assert.equal(a.signedIn, true);
  // Refused again with the refreshed session: it rejects, with no second refresh.
  fresh = 'Other';
  a.account = SESSION('Tomi', Date.now() + 3600_000);
  sent.length = 0;
  await assert.rejects(a.upsertPreset(PRESET), (e) => e instanceof AC.AccountError && e.code === 'unauthorized' && e.status === 401);
  assert.deepEqual(sent, ['Bearer jwt-Tomi', 'Bearer jwt-Other']);
  assert.equal(refreshes, 2);
});

test('AccountClient experimental calls: a refresh that hands back another account (another tab signed in) never gets the write', async () => {
  const PRESET = { id: '0123456789ab', name: 'Low gravity', values: { gravity: 50 }, updatedAt: 0 };
  const OTHER = (name, expiresAt) => ({ kind: 'account', playerId: '9876543210fedcba', name, session: 'jwt-' + name, expiresAt });
  const sent = [];
  const srv = fakeServer({
    '/api/me/presets': (b, h) => {
      sent.push(h.authorization);
      return res(401, { error: 'unauthorized' });
    },
    '/api/me/experimental': (b, h) => {
      sent.push(h.authorization);
      return res(200, { enabled: b?.enabled === true, presets: [] });
    },
    '/api/auth/refresh': () => res(200, OTHER('Bea', Date.now() + 3600_000)),
  });
  const a = new AC.AccountClient({ fetchFn: srv.fetchFn, storage: null });
  // Refused with this account's session, and the refresh comes back as someone else: no second send.
  a.account = SESSION('Tomi', Date.now() + 3600_000);
  await assert.rejects(a.upsertPreset(PRESET), (e) => e instanceof AC.AccountError && e.code === 'unauthorized');
  assert.deepEqual(sent, ['Bearer jwt-Tomi'], "Tomi's preset never goes up with Bea's session");
  assert.equal(a.account.playerId, '9876543210fedcba', 'the client follows the cookie (the store then works for Bea)');
  // The session near its end: the refresh before the call turns into another account: nothing is sent.
  sent.length = 0;
  a.account = SESSION('Tomi', Date.now() + 1000);
  await assert.rejects(a.setExperimental(true), (e) => e.code === 'unauthorized');
  assert.deepEqual(sent, [], "Tomi's switch never reaches Bea's account");
});

test("AccountClient cars and the hosts' shop: Bearer, paths and bodies; a car pick adopts the session it answers; refusals carry the player's text", async () => {
  let carStatus = 200;
  const srv = fakeServer({
    '/api/me/items': () => res(200, { items: ['host-badge', 'pampero'], car: 'pampero', cars: ['dune', 'pampero'] }),
    '/api/me/car': (b) => (carStatus === 200 ? res(200, { ...SESSION('Tomi', Date.now() + 3600_000), session: 'jwt-Tomi-2', car: b.car }) : res(409, { error: 'not_owned', message: 'Ese auto no es tuyo todavía' })),
    '/api/me/shop': () => res(200, { items: [{ id: 'pampero', kind: 'car', name: 'Pampero', description: '', cost: 1500, status: 'soon', owned: true, claimable: false, nameKey: 'car.pampero' }], wallet: { earned: 40, spent: 0, balance: 40, frozen: null } }),
    '/api/me/shop/claim': (b) => (b.item === 'tero' ? res(409, { error: 'insufficient', message: 'insufficient' }) : res(200, { item: b.item, claimed: true, wallet: { earned: 1600, spent: 1500, balance: 100, frozen: null }, items: [b.item] })),
    '/api/auth/refresh': () => res(401, { error: 'bad_refresh' }),
  });
  const a = new AC.AccountClient({ fetchFn: srv.fetchFn, storage: null });
  await assert.rejects(a.fetchItems(), (e) => e instanceof AC.AccountError && e.code === 'unauthorized', 'a guest: no request');
  assert.equal(srv.calls.length, 0);
  a.account = SESSION('Tomi', Date.now() + 3600_000);
  assert.deepEqual(await a.fetchItems(), { items: ['host-badge', 'pampero'], car: 'pampero', cars: ['dune', 'pampero'] });
  assert.deepEqual(srv.calls.at(-1), { path: '/api/me/items', method: 'GET', body: undefined, headers: srv.calls.at(-1).headers });
  assert.equal(srv.calls.at(-1).headers.authorization, 'Bearer jwt-Tomi');
  let changes = 0;
  a.subscribe(() => changes++);
  const s = await a.selectCar('pampero');
  assert.deepEqual(srv.calls.at(-1).body, { car: 'pampero' });
  assert.equal(s.car, 'pampero');
  assert.equal(a.account.session, 'jwt-Tomi-2', 'the fresh session is the one the next queue carries');
  assert.equal(a.account.car, 'pampero');
  assert.equal(changes, 1, 'the listeners (the Garage) hear of it');
  carStatus = 409;
  await assert.rejects(a.selectCar('tero'), (e) => e instanceof AC.AccountError && e.code === 'not_owned' && e.status === 409 && e.message === 'That car is not yours yet');
  assert.equal(a.account.car, 'pampero', 'refused: nothing adopted');
  const shop = await a.fetchShop();
  assert.equal(shop.items[0].owned, true);
  assert.deepEqual(shop.wallet, { earned: 40, spent: 0, balance: 40, frozen: null });
  const c = await a.claimItem('condor');
  assert.deepEqual(srv.calls.at(-1).body, { item: 'condor' });
  assert.deepEqual(c, { item: 'condor', claimed: true, wallet: { earned: 1600, spent: 1500, balance: 100, frozen: null }, items: ['condor'] });
  await assert.rejects(a.claimItem('tero'), (e) => e instanceof AC.AccountError && e.code === 'insufficient' && e.message === 'Not enough server points');
  // A session whose car this page does not know: no car (the default one).
  a.account = null;
  srv.calls.length = 0;
  const odd = new AC.AccountClient({ fetchFn: fakeServer({ '/api/auth/login': () => res(200, { ...SESSION('Tomi', Date.now() + 3600_000), car: 'batmobile' }) }).fetchFn, storage: null });
  await odd.legacySignIn('Tomi', 'correct horse battery');
  assert.equal('car' in odd.account, false);
});

// ---- sign-in PR 8: PERFIL's email forms (src/ui/screens/profile.ts, accountLinks.ts, common.ts) -------------
//
// The fields run on a small fake DOM (enough for src/ui/dom.ts h()); the screens, which need the
// browser, are read as source, as the tests above read profile.ts.

/** A fake element: attributes, properties, children, listeners, classList. */
class FakeEl {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.attrs = new Map();
    this.children = [];
    this.listeners = new Map();
    this.className = '';
    this.text = '';
    this.dataset = {};
    this.classList = {
      add: (c) => (this.className = [...new Set([...this.className.split(' ').filter(Boolean), c])].join(' ')),
      remove: (c) => (this.className = this.className.split(' ').filter((x) => x && x !== c).join(' ')),
      toggle: (c, on) => ((on ?? !this.classList.contains(c)) ? this.classList.add(c) : this.classList.remove(c)),
      contains: (c) => this.className.split(' ').includes(c),
    };
  }
  setAttribute(k, v) {
    this.attrs.set(k, String(v));
  }
  getAttribute(k) {
    return this.attrs.has(k) ? this.attrs.get(k) : null;
  }
  removeAttribute(k) {
    this.attrs.delete(k);
  }
  hasAttribute(k) {
    return this.attrs.has(k);
  }
  appendChild(c) {
    this.children.push(c);
    if (c instanceof FakeEl) c.parentNode = this;
    return c;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  dispatch(type, init = {}) {
    const e = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...init };
    for (const fn of this.listeners.get(type) ?? []) fn(e);
    return e;
  }
  /** A button's click() (none while disabled, as a browser's), an input's focus() (document.activeElement). */
  click() {
    if (this.disabled !== true) this.dispatch('click');
  }
  focus() {
    globalThis.document.activeElement = this;
  }
  /** One compound of classes and a tag ('button.mn-btn-primary', '.mn-sheet'). */
  is(compound) {
    const [tag, ...classes] = compound.split('.');
    return (tag === '' || this.tagName === tag.toUpperCase()) && classes.every((c) => this.classList.contains(c));
  }
  closest(sel) {
    for (let e = this; e; e = e.parentNode) if (e.is(sel)) return e;
    return null;
  }
  /** Descendant selectors of compounds ('.mn-sheet-actions .mn-btn-primary'). */
  querySelector(sel) {
    const parts = sel.trim().split(/\s+/);
    const last = parts.pop();
    const within = (e) => {
      const up = [];
      for (let a = e.parentNode; a; a = a === this ? null : a.parentNode) up.push(a);
      return up;
    };
    return (
      this.all()
        .slice(1)
        .find((e) => {
          if (!e.is(last)) return false;
          const up = within(e);
          let at = 0;
          for (let i = parts.length - 1; i >= 0; i--) {
            while (at < up.length && !up[at].is(parts[i])) at++;
            if (at === up.length) return false;
            at++;
          }
          return true;
        }) ?? null
    );
  }
  set textContent(v) {
    this.text = String(v);
    this.children = [];
  }
  get textContent() {
    return this.text + this.children.map((c) => c.textContent ?? '').join('');
  }
  /** Every element under this one, this one first. */
  all() {
    return [this, ...this.children.filter((c) => c instanceof FakeEl).flatMap((c) => c.all())];
  }
}

const withDom = async (fn) => {
  const before = globalThis.document;
  globalThis.document = { createElement: (tag) => new FakeEl(tag), createTextNode: (t) => ({ textContent: String(t) }), documentElement: new FakeEl('html'), getElementById: () => null };
  try {
    return await fn();
  } finally {
    globalThis.document = before;
  }
};

const C = await import('../src/ui/screens/common.ts');
const K = await import('../src/ui/components/keypad.ts');
const { readFile } = await import('node:fs/promises');
const PROFILE = await readFile(new URL('../src/ui/screens/profile.ts', import.meta.url), 'utf8');
const LINKS = await readFile(new URL('../src/ui/screens/accountLinks.ts', import.meta.url), 'utf8');
/** One `const name = …` function of a screen's source, up to the next one at its indent. */
const fnOf = (src, name) => {
  const m = new RegExp(`\\n( *)(?:export )?(?:async )?(?:const|function) ${name}\\b`).exec(src);
  assert.ok(m, name);
  const rest = src.slice(m.index + 1);
  const next = rest.slice(1).search(new RegExp(`\\n${m[1]}(?:/\\*\\*|//|(?:export )?(?:async )?(?:const|function|let) )`));
  return next < 0 ? rest : rest.slice(0, next + 1);
};

test('field(): its hint and its error name the input (aria-describedby), the error sets aria-invalid in a polite live line; a note is no error', async () => {
  await withDom(() => {
    const f = C.field('Email', { type: 'email', autocomplete: 'email', inputmode: 'email', hint: 'We send a code.', keypad: 'email' });
    const [hint, err] = f.el.all().filter((e) => e.className === 'mn-field-hint' || e.className.startsWith('mn-field-error'));
    assert.equal(f.input.autocomplete, 'email');
    assert.equal(f.input.inputMode, 'email');
    assert.equal(K.keypadSpec(f.input).kind, 'email', "mn-keypad's address keys where there is no fine pointer");
    assert.equal(f.input.getAttribute('aria-describedby'), hint.id);
    assert.equal(err.getAttribute('aria-live'), 'polite');
    f.error('Check the email');
    assert.equal(f.input.getAttribute('aria-invalid'), 'true');
    assert.equal(f.input.getAttribute('aria-describedby'), `${hint.id} ${err.id}`);
    assert.equal(err.hidden, false);
    f.note('Code accepted');
    assert.equal(f.input.getAttribute('aria-invalid'), null, 'a note is no error');
    assert.ok(err.classList.contains('mn-field-ok'));
    f.error(null);
    assert.equal(err.hidden, true);
    assert.equal(f.input.getAttribute('aria-describedby'), hint.id);
    const ro = C.field('Email', { readOnly: true, value: 'ana@example.com' });
    assert.equal(ro.input.readOnly, true);
    assert.equal(ro.input.getAttribute('data-nav'), null, 'a read-only field is no stop for the arrows');
  });
});

test('MOSTRAR / SHOW beside a password: aria-pressed, the text shown while pressed, dots again on a second press', async () => {
  await withDom(() => {
    const f = C.field('Password', { type: 'password', autocomplete: 'current-password', reveal: true });
    const show = f.el.all().find((e) => e.className.includes('mn-field-show'));
    assert.ok(show, 'the button');
    assert.equal(show.textContent, 'SHOW');
    assert.equal(show.getAttribute('aria-pressed'), 'false');
    assert.equal(show.getAttribute('data-nav'), '', 'the arrows reach it');
    assert.equal(show.dispatch('click').defaultPrevented, true, 'inside the label: no click on the field');
    assert.equal(f.input.type, 'text');
    assert.equal(show.getAttribute('aria-pressed'), 'true');
    show.dispatch('click');
    assert.equal(f.input.type, 'password');
    assert.equal(show.getAttribute('aria-pressed'), 'false');
  });
});

test("the code field: one input, numeric, one-time-code, read out as '6-digit code'; a paste's spaces and dashes go and the sixth digit checks it, once", async () => {
  await withDom(() => {
    const got = [];
    const f = C.codeField((c) => got.push(c));
    assert.equal(f.input.autocomplete, 'one-time-code');
    assert.equal(f.input.inputMode, 'numeric');
    assert.equal(f.input.getAttribute('aria-label'), '6-digit code');
    assert.ok(f.input.maxLength >= 7, 'a pasted "123 456" is not cut before it is cleaned');
    assert.equal(K.keypadSpec(f.input).kind, 'digits');
    f.input.value = '12';
    f.input.dispatch('input');
    assert.deepEqual(got, []);
    f.input.value = '123 - 456';
    f.input.dispatch('input');
    assert.equal(f.input.value, '123456');
    assert.deepEqual(got, ['123456']);
    f.input.dispatch('input');
    assert.deepEqual(got, ['123456'], 'the same six digits are checked once');
    f.input.value = '12345';
    f.input.dispatch('input');
    f.input.value = '123457';
    f.input.dispatch('input');
    assert.deepEqual(got, ['123456', '123457'], 'a retyped code checks again');
  });
});

test("mn-keypad's digits (a mailed code: six, 0-9) and email (lower case, + and @, no space) kinds", () => {
  assert.deepEqual(K.keypadRows('digits'), ['123', '456', '789', '0']);
  assert.deepEqual(K.keypadActions('digits'), ['delete', 'done']);
  let v = '';
  for (const k of ['1', 'a', '2', '3', '4', '5', '6', '7']) v = K.keypadType(v, k, 'digits', 16);
  assert.equal(v, '123456', 'digits only, six at most');
  const rows = K.keypadRows('email').join('');
  for (const ch of ['+', '@', '.', '-', '_']) assert.ok(rows.includes(ch), ch);
  assert.equal(rows, rows.toLowerCase());
  assert.deepEqual(K.keypadActions('email'), ['delete', 'done'], 'no case, no space');
  v = '';
  for (const k of ['A', 'n', 'a', '+', 't', 'g', '@', 'x', '.', 'c', 'o', 'space', ' ']) v = K.keypadType(v, k, 'email', 254);
  assert.equal(v, 'ana+tg@x.co');
});

test("PERFIL's sign-in routes on '@': an address by email, a username by the legacy sign-in, and after the cutoff legacy_closed and CREAR CUENTA NUEVA with no request", () => {
  const login = fnOf(PROFILE, 'loginForm');
  assert.match(login, /const route = signInRoute\(user\.input\.value, legacyPhase\(\)\);/);
  const closed = login.indexOf("if (route.kind === 'closed')");
  assert.ok(closed > 0 && closed < login.indexOf('await acc.'), 'the cutoff answers before any request');
  assert.match(login.slice(closed, login.indexOf('try {', closed)), /user\.error\(legacyClosedText\(\)\);\s*newAccount\.hidden = false;\s*return;/);
  assert.match(login, /if \(route\.kind === 'email'\) await acc\.signIn\(route\.email, pass\.input\.value\);\s*else await acc\.legacySignIn\(route\.username, pass\.input\.value\);/);
  assert.match(login, /route\.kind === 'legacy' \? t\('auth\.badLegacyHint'\) : providers\.length > 0 \? t\('auth\.badCredentialsHint', \{ providers \}\) : null/, "bad_credentials' hint by branch");
  assert.match(login, /field\(closed \? t\('auth\.email'\) : t\('auth\.identity'\)/, '"Email or username" while usernames sign in');
});

test('PERFIL creates an account on one screen: the code, the name, the password, the news switch, CREAR CUENTA, REENVIAR, another email, YA TENGO CUENTA', () => {
  const code = fnOf(PROFILE, 'signupCodeForm');
  for (const part of ['codeField(', 'signupFinishFields(menu, a.email', "primary(t('profile.createAccount')", "'aria-disabled': 'true'", "t('auth.otherEmail')", "t('auth.haveAccount')", "t('auth.notThere')", 'resendTick = paint']) assert.ok(code.includes(part), part);
  assert.match(code, /acc\.signupCheck\(\{ attempt: a\.attempt, code: c \}\)/, 'the sixth digit checks it');
  assert.match(code, /resend\.disabled = left > 0;/, 'REENVIAR is off (the arrows skip it) until its minute');
  assert.match(code, /if \(waited && left <= 0\) live\.textContent = t\('auth\.resendReady'\);/, 'said once when it turns on');
  const finish = fnOf(LINKS, 'signupFinishFields');
  assert.match(finish, /toggleSwitch\('auth-news', t\('auth\.signupNews'\), \(\) => news/);
  assert.match(finish, /let news = false;/, 'the news switch starts at NO');
  assert.match(finish, /if \(e\.detail\.suggest !== undefined\) name\.input\.value = e\.detail\.suggest;/, "a refused name: the server's free one in the field");
  const email = fnOf(PROFILE, 'signupEmailForm');
  assert.match(email, /if \(kept === null \|\| kept\.email !== address\)/, 'Back then CONTINUAR with the same address: the same code, no new mail');
});

test('the autocomplete attributes: username and current-password to sign in; email to sign up; nickname for the name; the address as a read-only username before every new-password', () => {
  const login = fnOf(PROFILE, 'loginForm');
  assert.match(login, /autocomplete: 'username'/);
  assert.match(login, /autocomplete: 'current-password', maxLength: 128, enterkeyhint: 'go', reveal: true/);
  assert.match(fnOf(PROFILE, 'signupEmailForm'), /type: 'email', autocomplete: 'email'/);
  const finish = fnOf(LINKS, 'signupFinishFields');
  assert.match(finish, /autocomplete: 'nickname'/);
  const pw = fnOf(LINKS, 'newPasswordFields');
  assert.match(pw, /autocomplete: 'new-password'/);
  assert.match(pw, /nodes: \[\.\.\.\(user !== null \? \[user\] : \[\]\), pass\.el/, 'the username first');
  assert.match(fnOf(LINKS, 'passwordManagerUser'), /autocomplete: 'username', readOnly: true, value, tabindex: '-1', 'aria-hidden': 'true'/);
  assert.match(fnOf(PROFILE, 'passwordDialog'), /body: \[passwordManagerUser\(who\), old\.el, \.\.\.pw\.nodes/);
  assert.match(fnOf(LINKS, 'resetSheet'), /newPasswordFields\(who\.email, t\('profile\.newPassword'\)\)/);
});

test('the code step comes back after a reload: PERFIL opens on it while sessionStorage keeps the attempt, and the page brings PERFIL up for it', () => {
  assert.match(PROFILE, /else if \(!acc\.signedIn && firstShow && acc\.signupAttempt\(\) !== null\) \{\s*tab = 'register';\s*step = 'code';/);
  assert.match(fnOf(PROFILE, 'guestView'), /const kept = tab === 'register' && step === 'code' \? acc\.signupAttempt\(\) : null;/);
  const install = fnOf(LINKS, 'installAccountLinks');
  assert.match(install, /if \(acc\.signupAttempt\(\) !== null && !acc\.signedIn\) \{\s*await sheetsReady\(menu\);\s*if \(!acc\.signedIn && acc\.signupAttempt\(\) !== null\) openProfileTab\(menu, 'register', null\);/);
});

test("a mailed link's token leaves the URL at once and is kept until its POST settles; the sheet waits for the menus", () => {
  const install = fnOf(LINKS, 'installAccountLinks');
  const firstAwait = install.indexOf('await ');
  for (const step of ['parseAccountLink(location.pathname, location.hash)', "history.replaceState(history.state, '', '/' + location.search)", 'acc.keepPendingLink(fromUrl)', 'acc.pendingLink()']) {
    const at = install.indexOf(step);
    assert.ok(at > 0 && at < firstAwait, step + ' before the first wait');
  }
  assert.match(fnOf(LINKS, 'openAccountLink'), /^[\s\S]*?await sheetsReady\(menu\);/, 'the menus up, no other sheet');
});

test('Back, B or Esc steps back: the code step to the address (the attempt kept), the recovery form to the sign-in; else PERFIL goes', () => {
  const back = /back: \(\) => \{([\s\S]*?)\n {4}\},\n/.exec(PROFILE);
  assert.ok(back, 'the screen handles Back');
  assert.match(back[1], /if \(tab === 'register' && step === 'code'\) \{\s*step = 'email';[\s\S]*?return true;/);
  assert.match(back[1], /if \(tab === 'recover'\) \{\s*tab = 'login';[\s\S]*?return true;/);
  assert.doesNotMatch(back[1], /dropSignupAttempt/, 'the attempt stays: CONTINUAR with the same address comes back to its code');
  assert.match(back[1], /return false;\s*$/);
});

test('a TV makes no account and types no email: its PERFIL is the phone tile and "create one on your phone"', () => {
  const guest = fnOf(PROFILE, 'guestView');
  const tvBranch = guest.slice(guest.indexOf('if (tv())'), guest.indexOf('loadAuthConfig();'));
  assert.match(tvBranch, /openTvSignIn\(menu\)/);
  assert.match(tvBranch, /t\('profile\.tvNoAccount'\)/);
  assert.doesNotMatch(tvBranch, /Form\(\)|field\(|oauthButtons/, 'no form and no provider button on a TV');
});

// ---- sign-in PR 8's review: the mail caps' text, the code step on a pad, Enter, storage off ---------------

/** accountLinks.ts itself (its sheets and texts run on the fake DOM; profile.ts's package.json comes through the load hook). */
const linksModule = () => import('../src/ui/screens/accountLinks.ts');

test("email_rate_limited (spec §4.7): a full sign-up lane claims no earlier mail and offers a guest the providers; a signed-in account only waits", async () => {
  const L = await linksModule();
  // The Worker's one answer for a full lane and a full address alike (AccountsDO capAnswer).
  const srv = fakeServer({ '/api/auth/signup/start': () => res(429, { error: 'email_rate_limited', message: 'Ya te enviamos varios correos. Espera un rato antes de pedir otro.', retryAfterMs: 58_719_872 }) });
  const acc = new AC.AccountClient({ fetchFn: srv.fetchFn, storage: memStorage(), session: memStorage(), antiBot: async () => 'tok' });
  const e = await acc.signupStart('first.time@example.com').then(() => null, (x) => x);
  assert.equal(e?.code, 'email_rate_limited');
  const menu = (oauth, signedIn = false) => ({ cfg: { oauth }, host: { accounts: { signedIn } } });
  const guest = L.authErrText(menu(['discord']), e);
  assert.doesNotMatch(guest, /already sent|several/i, 'a first-time player was never mailed');
  assert.equal(guest, "We can't send more emails right now. Try again later, or sign in with Discord.");
  assert.equal(L.authErrText(menu(['google', 'discord']), e), "We can't send more emails right now. Try again later, or sign in with Google or Discord.");
  assert.equal(L.authErrText(menu([]), e), "We can't send more emails right now. Try again later.", 'the variant without providers');
  assert.equal(L.authErrText(menu(['discord'], true), e), "We can't send more emails right now. Try again later.", "an account's own code: no sign-in to offer");
  const ES = (await import('../src/locales/es.ts')).default;
  assert.equal(ES['auth.mailCapProviders'], 'Ahora no podemos enviar más correos. Inténtalo más tarde o entra con {providers}.');
  assert.equal(ES['auth.mailCap'], 'Ahora no podemos enviar más correos. Inténtalo más tarde.');
});

test("a pad or a remote is never put on a field by script: after CONTINUAR the code is reached with the arrows (navigation mode: A opens the digits keypad)", () => {
  // FocusNav (nav.ts install): a focus that is no arrow's puts a field in editing mode, where A opens no keypad (Menu.action).
  assert.match(PROFILE, /const typesHere = \(\): boolean => !touch\(\) && finePointer\(\);/, "pickTab's rule: a fine pointer, untouched");
  assert.match(fnOf(PROFILE, 'signupEmailForm'), /if \(typesHere\(\)\) body\.querySelector<HTMLElement>\('\.mn-code-input'\)\?\.focus\(\);/, 'CONTINUAR: the code field only for a fine pointer');
  assert.match(fnOf(PROFILE, 'signupCodeForm'), /if \(typesHere\(\)\) code\.input\.focus\(\);\s*else menu\.refocus\(\);/, "REENVIAR's minute: the menus' refocus for a pad");
  assert.match(fnOf(PROFILE, 'lastButton'), /if \(touch\(\) \|\| finePointer\(\)\) identity\.focus\(\);\s*else menu\.openKeypad\(identity\);/, '"continue as · email" with a pad: its keypad');
  // Every other script focus in PERFIL: a keyboard's own Enter (onEnter's next field), or one of the guarded ones above.
  for (const line of PROFILE.split('\n').filter((l) => /\.focus\(\)/.test(l))) assert.match(line, /typesHere\(\)|^\s*next\.focus\(\);|^\s*if \(touch\(\) \|\| finePointer\(\)\) identity\.focus\(\);/, line.trim());
});

const SHEET = await import('../src/ui/components/sheet.ts');

/** A Menu for accountLinks' sheets: modal() mounts the real sheet (components/sheet.ts), toast() records. */
function sheetMenu(accounts, oauth = ['discord']) {
  const m = { cfg: { oauth }, sheet: null, closed: 0, toasts: [], host: { accounts, guestName: () => 'Guest4821' } };
  m.toast = (text, kind) => m.toasts.push([kind, text]);
  m.modal = (spec) => {
    const close = () => {
      m.closed++;
      m.sheet = null;
      spec.onClose?.();
    };
    m.sheet = SHEET.sheetBox(spec, close);
    return close;
  };
  m.refocus = () => undefined;
  return m;
}
const settle = () => new Promise((r) => setTimeout(r, 0));
const enter = (input) => input.dispatch('keydown', { key: 'Enter' });

test("Enter in the verify link's sheet: the name, then the password, then CREAR CUENTA, once (a phone keyboard's Siguiente / Ir)", async () => {
  const L = await linksModule();
  await withDom(async () => {
    let finishes = 0;
    let answer = null;
    const acc = {
      account: null,
      signedIn: false,
      keepPendingLink: () => undefined,
      fetchMe: async () => undefined,
      signupFinish: (proof, f) => {
        finishes++;
        assert.deepEqual(proof, { token: 'T'.repeat(43) });
        assert.equal(f.password, 'una clave bastante larga');
        return new Promise((r) => (answer = () => r(SESSION(f.username, Date.now() + 3_600_000))));
      },
    };
    const menu = sheetMenu(acc);
    L.verifySheet(menu, 'T'.repeat(43), 'ana@example.com');
    const inputs = menu.sheet.all().filter((e) => e.tagName === 'INPUT');
    const name = inputs.find((e) => e.autocomplete === 'nickname');
    const pass = inputs.find((e) => e.autocomplete === 'new-password');
    assert.equal(name.enterKeyHint, 'next');
    assert.equal(pass.enterKeyHint, 'go');
    pass.value = 'una clave bastante larga';
    const e1 = enter(name);
    assert.equal(e1.defaultPrevented, true);
    assert.equal(globalThis.document.activeElement, pass, 'Siguiente: the password');
    assert.equal(finishes, 0);
    enter(pass);
    assert.equal(finishes, 1, 'Ir: CREAR CUENTA');
    enter(pass);
    assert.equal(finishes, 1, 'a second Enter while it runs is the same press (the sheet disabled its button)');
    answer();
    await settle();
    assert.equal(menu.closed, 1, 'signed in: the sheet closes');
    assert.match(menu.toasts.at(-1)[1], /^Welcome, Player\d{4}!$/);
    // An Enter the menus took (OK on a field in navigation mode starts editing) is no submit.
    L.verifySheet(menu, 'T'.repeat(43), 'ana@example.com');
    const again = menu.sheet.all().find((e) => e.tagName === 'INPUT' && e.autocomplete === 'new-password');
    again.dispatch('keydown', { key: 'Enter', defaultPrevented: true });
    assert.equal(finishes, 1);
  });
});

test("Enter in the reset link's sheet: the password, its repeat where the keypad shows dots, then GUARDAR Y ENTRAR, once", async () => {
  const L = await linksModule();
  await withDom(async () => {
    const win = globalThis.window;
    // No fine pointer and no finger (a TV, a phone's pad): the keypad's dots, so a repeat field.
    globalThis.window = { matchMedia: () => ({ matches: false }) };
    try {
      const resets = [];
      const acc = { account: null, keepPendingLink: () => undefined, fetchMe: async () => undefined, resetPassword: async (token, password) => void resets.push([token, password]) };
      const menu = sheetMenu(acc);
      L.resetSheet(menu, 'R'.repeat(43), { name: 'Ana', email: 'ana@example.com', hasPassword: true });
      const [pass, repeat] = menu.sheet.all().filter((e) => e.tagName === 'INPUT' && e.autocomplete === 'new-password');
      assert.ok(repeat, 'the repeat field');
      assert.deepEqual([pass.enterKeyHint, repeat.enterKeyHint], ['next', 'go']);
      pass.value = repeat.value = 'otra clave bastante larga';
      enter(pass);
      assert.equal(globalThis.document.activeElement, repeat);
      assert.equal(resets.length, 0);
      enter(repeat);
      enter(repeat);
      await settle();
      assert.deepEqual(resets, [['R'.repeat(43), 'otra clave bastante larga']], 'saved once');
      assert.equal(menu.closed, 1);
    } finally {
      globalThis.window = win;
    }
  });
});

test("Enter on PERFIL's code step and in CAMBIAR CONTRASEÑA: the fields in order, the last one submits as its button does", () => {
  const code = fnOf(PROFILE, 'signupCodeForm');
  assert.match(code, /const submit = \(\): void => void busyWhile\(create, async \(\) => void \(await fields\.create\(\)\)\);\s*const create = primary\(t\('profile\.createAccount'\), submit,/);
  assert.match(code, /onEnter\(fields\.inputs, submit\);/, 'the name, the password (its repeat), then CREAR CUENTA');
  assert.match(fnOf(LINKS, 'signupFinishFields'), /inputs: \[name\.input, \.\.\.pw\.inputs\]/);
  assert.match(fnOf(PROFILE, 'passwordDialog'), /sheetEnter\(\[old\.input, \.\.\.pw\.inputs\]\);/);
  assert.match(fnOf(LINKS, 'verifySheet'), /sheetEnter\(fields\.inputs\);/);
  assert.match(fnOf(LINKS, 'resetSheet'), /sheetEnter\(pw\.inputs\);/);
});

// ---- the merge with sign-in PR 6: "Entra con tu cuenta" by email, the arbiter's 'account' step ---------------

const MODEL = await import('../src/ui/screens/accountLinksModel.ts');

/** A Menu whose modal() replaces the sheet up as Menu.modal does (the old one's onClose runs), the menus up. */
function replacingMenu(accounts, oauth = ['discord']) {
  const m = { cfg: { oauth }, visible: true, sheet: null, spec: null, closer: null, toasts: [], host: { accounts, guestName: () => 'Guest4821' } };
  Object.defineProperty(m, 'modalOpen', { get: () => m.sheet !== null });
  m.toast = (text, kind) => m.toasts.push([kind, text]);
  m.modal = (spec) => {
    m.closer?.();
    let up = true;
    const close = () => {
      if (!up) return;
      up = false;
      if (m.closer === close) {
        m.sheet = null;
        m.spec = null;
        m.closer = null;
      }
      spec.onClose?.();
    };
    m.closer = close;
    m.spec = spec;
    m.sheet = SHEET.sheetBox(spec, close);
    return close;
  };
  m.refocus = () => undefined;
  return m;
}
const button = (menu, label) => menu.sheet?.all().find((e) => e.tagName === 'BUTTON' && e.textContent === label) ?? null;
const PENDING = { provider: 'discord', email: 'ana@example.com', trust: 'asserted', second: null, match: null };

/** The confirm step's account calls, recorded; `signIn(branch)` answers both sign-ins when given. */
function pendingAccounts({ legacy = 'none', info = PENDING, signIn = null } = {}) {
  const calls = [];
  const linked = (name) => ({ session: SESSION(name, Date.now() + 3_600_000), linked: ['discord'], linkError: null });
  return {
    account: null,
    signedIn: false,
    hintName: null,
    calls,
    authConfig: async () => ({ email: true, devSignIn: false, legacy, legacyUntil: null }),
    pending: async () => info,
    cancelPending: async () => void calls.push(['cancelPending']),
    fetchMe: async () => undefined,
    providerStarted: () => undefined,
    oauthUrl: (p, f) => `/api/auth/oauth/${p}/start?${f}=1`,
    signInAndLink: async (email, password) => (calls.push(['signInAndLink', email, password]), signIn ? signIn('email') : linked('Ana')),
    loginAndLink: async (username, password) => (calls.push(['loginAndLink', username, password]), signIn ? signIn('legacy') : linked(username)),
  };
}

/** confirmPending up to "Entra con tu cuenta" (through SÍ, YA TENGO UNA, or the match sheet's password way). */
async function haveOne(acc, oauth = ['discord'], way = 'YES, I HAVE ONE') {
  const L = await linksModule();
  const menu = replacingMenu(acc, oauth);
  const outcome = L.confirmPending(menu);
  for (let i = 0; i < 50 && button(menu, way) === null; i++) await settle();
  button(menu, way).click();
  await settle();
  assert.equal(menu.spec.title, 'Sign in to your account');
  const inputs = menu.sheet.all().filter((e) => e.tagName === 'INPUT');
  const user = inputs.find((e) => e.autocomplete === 'username');
  const pass = inputs.find((e) => e.autocomplete === 'current-password');
  const label = menu.sheet.all().find((e) => e.is('span.mn-field-label')).textContent;
  return { menu, outcome, user, pass, label };
}

test("\"Entra con tu cuenta\" (PR 6's \"I have one\") is PERFIL's one field routed on '@': an address signs in by email with linkPending (an email account takes the identity), a username by the legacy sign-in", async () => {
  await withDom(async () => {
    // An address: POST /api/auth/signin with linkPending (AccountClient.signInAndLink), never the username sign-in.
    const acc = pendingAccounts();
    const s = await haveOne(acc);
    assert.equal(s.label, 'Email or username', "\"Correo o usuario\", as PERFIL's sign-in");
    assert.equal(s.user.inputMode, 'email');
    assert.equal(s.user.enterKeyHint, 'next');
    assert.ok(s.menu.sheet.all().some((e) => e.tagName === 'BUTTON' && e.getAttribute('aria-pressed') !== null), 'MOSTRAR beside the password');
    s.user.value = ' Ana@Example.com ';
    s.pass.value = 'una clave bastante larga';
    enter(s.user);
    assert.equal(globalThis.document.activeElement, s.pass, 'Siguiente: the password');
    enter(s.pass);
    assert.equal(await s.outcome, 'signedIn');
    assert.deepEqual(acc.calls, [['signInAndLink', 'ana@example.com', 'una clave bastante larga']]);
    assert.deepEqual(s.menu.toasts.at(-1), ['ok', 'Discord is now linked to your account']);
    assert.equal(s.menu.sheet, null, 'the sheet closed, the pending identity not cancelled');

    // A username of before: the legacy sign-in, with linkPending (AccountClient.loginAndLink).
    const old = pendingAccounts();
    const u = await haveOne(old);
    u.user.value = 'Ana';
    u.pass.value = 'una clave bastante larga';
    button(u.menu, 'SIGN IN').click();
    assert.equal(await u.outcome, 'signedIn');
    assert.deepEqual(old.calls, [['loginAndLink', 'Ana', 'una clave bastante larga']]);

    // After the cutoff (sign-in PR 9): "Email", and a username gets legacy_closed with no request.
    const closed = pendingAccounts({ legacy: 'closed' });
    const c = await haveOne(closed);
    assert.equal(c.label, 'Email');
    c.user.value = 'Ana';
    c.pass.value = 'una clave bastante larga';
    button(c.menu, 'SIGN IN').click();
    await settle();
    assert.deepEqual(closed.calls, [], 'no request');
    assert.match(c.menu.sheet.textContent, /You can't sign in with a username anymore/);
    // Something with an '@' that is no address: no request either.
    c.user.value = 'ana@';
    button(c.menu, 'SIGN IN').click();
    await settle();
    assert.deepEqual(closed.calls, []);
  });
});

test("\"Entra con tu cuenta\": one bad_credentials, the text and hint of its branch; the match sheet's password way is prefilled with the address its account claimed", async () => {
  await withDom(async () => {
    const wrong = (branch) => Promise.reject(new AC.AccountError(branch === 'email' ? 'Wrong email or password' : 'Wrong username or password', 401, 'bad_credentials'));
    const acc = pendingAccounts({ signIn: wrong });
    const s = await haveOne(acc, ['google', 'discord']);
    s.user.value = 'ana@example.com';
    s.pass.value = 'otra clave cualquiera';
    button(s.menu, 'SIGN IN').click();
    await settle();
    await settle();
    assert.match(s.menu.sheet.textContent, /Wrong email or password/);
    assert.match(s.menu.sheet.textContent, /Created your account with Google\? Use that button\./, 'the other provider, never the pending one');
    s.user.value = 'Ana';
    button(s.menu, 'SIGN IN').click();
    await settle();
    await settle();
    assert.match(s.menu.sheet.textContent, /Wrong username or password[\s\S]*If you already added an email to your account, sign in with it\./);
    assert.ok(button(s.menu, 'SIGN IN WITH GOOGLE'), 'the other provider (start?pend=1)');

    // The match (one email, one account): its claimed address, which signs in by email; a hint: the name.
    const match = { ...PENDING, match: { name: 'Ana', methods: ['password'], via: 'email', email: 'ana@example.com' } };
    const m = await haveOne(pendingAccounts({ info: match }), ['discord'], 'SIGN IN WITH PASSWORD');
    assert.equal(m.user.value, 'ana@example.com');
    const hinted = { ...PENDING, match: { name: 'Ana', methods: ['password'], via: 'hint', email: 'ana@example.com' } };
    const n = await haveOne(pendingAccounts({ info: hinted }), ['discord'], 'SIGN IN WITH PASSWORD');
    assert.equal(n.user.value, 'Ana', 'a hint: the account of before signs in by its name');
  });
});

test("the arbiter's 'account' step: an /account#reset link waits while #auth=confirm asks, even with no sheet up; the phone's /tv waits for the reset sheet to close", async () => {
  const L = await linksModule();
  const keep = { location: globalThis.location, history: globalThis.history };
  const token = 'R'.repeat(43);
  globalThis.location = { pathname: '/account', hash: '#reset=' + token, search: '' };
  const urls = [];
  globalThis.history = {
    state: null,
    replaceState: (_s, _t, url) => {
      urls.push(url);
      globalThis.location.pathname = '/';
      globalThis.location.hash = '';
    },
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let menu = null;
  try {
    await withDom(async () => {
      let kept = null;
      const peeks = [];
      const acc = {
        account: null,
        signedIn: false,
        keepPendingLink: (l) => (kept = l),
        pendingLink: () => kept,
        sessionForQueue: async () => null,
        signupAttempt: () => null,
        resetPeek: async (t) => (peeks.push(t), { name: 'Ana', email: 'ana@example.com', hasPassword: true }),
        fetchMe: async () => undefined,
        authConfig: async () => ({ email: true, devSignIn: false, legacy: 'none', legacyUntil: null }),
      };
      menu = replacingMenu(acc);
      const u = new MODEL.UrlSheets(['auth', 'account', 'tv']);
      const order = [];
      void u.turn('tv').then(() => order.push('tv'));
      const install = L.installAccountLinks(menu, () => u.turn('account')).then(() => {
        order.push('account');
        u.done('account');
      });
      assert.deepEqual(urls, ['/'], 'the token left the URL at once');
      assert.deepEqual(kept, { kind: 'reset', token });
      // The confirm step before its sheet is up (POST /api/auth/pending on its way), then its sheet, then its answer.
      await wait(450);
      assert.deepEqual(peeks, [], 'no sheet over the confirm step, even while no sheet is up');
      const closeConfirm = menu.modal({ title: 'Already have a Turbogol account?', body: [], actions: [] });
      await wait(250);
      closeConfirm();
      await wait(250);
      assert.deepEqual(peeks, [], 'the confirm sheet closed, its step not done yet (a restore after it)');
      u.done('auth');
      for (let i = 0; i < 50 && menu.spec?.title !== 'New password'; i++) await wait(50);
      assert.deepEqual(peeks, [token], 'its turn: reset/peek, then the sheet');
      assert.equal(menu.spec.title, 'New password');
      await wait(450);
      assert.deepEqual(order, [], "the phone's /tv waits while the reset sheet is up");
      button(menu, 'CANCEL').click();
      await install;
      await settle();
      assert.deepEqual(order, ['account', 'tv']);
      assert.equal(kept, null, 'closed: the next load does not bring it back');
    });
  } finally {
    // A failed check leaves no sheet up (its wait would keep the run alive).
    for (let i = 0; i < 5 && menu?.closer; i++) menu.closer();
    globalThis.location = keep.location;
    globalThis.history = keep.history;
  }
});

test("Game.ts runs the mailed links in the arbiter: 'auth', then 'account', then 'tv'", async () => {
  const game = await readFile(new URL('../src/game/Game.ts', import.meta.url), 'utf8');
  assert.match(game, /new UrlSheets\(\['auth', 'account', 'tv'\] as const\)/);
  assert.match(game, /installAccountLinks\(this\.menu, \(\) => this\.urlSheets\.turn\('account'\)\)[\s\S]{0,160}\.finally\(\(\) => this\.urlSheets\.done\('account'\)\)/);
  assert.match(game, /installTvLink\(this\.menu, \(\) => this\.urlSheets\.turn\('tv'\)\)/);
  assert.match(fnOf(LINKS, 'installAccountLinks'), /await turn\(\);[\s\S]*await openAccountLink\(menu, link\);\s*return sheetsClosed\(menu\);/, 'done once its sheets are over');
});

test("the phone's /tv after the 'account' step: no \"sign in first\" over PERFIL's code step (the account it makes brings the code entry); its provider buttons are PERFIL's (Google hidden in another app's browser, \"continue as\" learns them)", async () => {
  const tv = await readFile(new URL('../src/ui/screens/tvSignIn.ts', import.meta.url), 'utf8');
  assert.match(tv, /signInFirst: \(dropped\) => \{\s*keep\(\);[\s\S]{0,260}if \(acc\.signupAttempt\(\) !== null\) return;\s*signInFirstSheet\(/);
  const first = fnOf(tv, 'signInFirstSheet');
  assert.match(first, /const providers = emailProviders\(menu\);/);
  assert.match(first, /acc\.providerStarted\(p\);\s*window\.location\.href = acc\.oauthUrl\(p\);/);
  // The confirm step's own round trips (start?pend=1) too.
  assert.match(fnOf(LINKS, 'goPend'), /acc\.providerStarted\(p\);\s*window\.location\.href = acc\.oauthUrl\(p, 'pend'\);/);
});
