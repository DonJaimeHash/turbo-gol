// Email accounts in the browser (sign-in PR 8): every new AccountClient method (src/net/AccountClient.ts,
// the section "email accounts") against a fake fetch, and the pure part they keep their state with
// (src/net/emailAuth.ts): the sign-up's attempt in sessionStorage across a reload, a mailed link's
// token kept until its POST settles, the sign-in field's routing on '@', the last way this device
// signed in. The server's side: server/test/accounts-email.test.mjs (PR 7).
//   node --test tests/account-client.test.mjs
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

const AC = await import('../src/net/AccountClient.ts');
const ACC = await import('../src/net/account.ts');
const E = await import('../src/net/emailAuth.ts');

function res(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m };
}

/** A fake Worker: `handlers[path](body, headers, calls)`; every call is recorded. A handler may throw (no network). */
function fakeServer(handlers) {
  const calls = [];
  const fetchFn = async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method: init.method, body, headers: init.headers });
    const h = handlers[path.split('?')[0]];
    if (!h) return res(404, { error: 'not_found' });
    return h(body, init.headers, calls);
  };
  return { fetchFn, calls };
}

const NOW = 1_800_000_000_000;
const SESSION = (extra = {}) => ({ kind: 'account', playerId: 'abcdef0123456789', name: 'Mariana', session: 'jwt-m', expiresAt: NOW + 3_600_000, authAt: NOW, authLvl: 2, ...extra });
const ATTEMPT = 'Q'.repeat(43);
const TOKEN = 'T'.repeat(43);

function client(handlers, opts = {}) {
  const srv = fakeServer(handlers);
  const storage = opts.storage ?? memStorage();
  const session = opts.session ?? memStorage();
  let now = opts.now ?? NOW;
  const acc = new AC.AccountClient({ storage, session, fetchFn: srv.fetchFn, now: () => now, sleep: async () => undefined, antiBot: opts.antiBot ?? (async () => 'tok'), ...(opts.extra ?? {}) });
  return { acc, calls: srv.calls, storage, session, at: (t) => (now = t), get now() { return now; } };
}

const isKey = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

// ---- GET /api/config's auth ---------------------------------------------------------------------------

test('authConfig: one GET /api/config for the page, its auth read leniently (email, devSignIn, the legacy phase and cutoff); offline asks again next time', async () => {
  const { acc, calls } = client({ '/api/config': () => res(200, { oauth: ['discord'], auth: { email: true, devSignIn: false, legacy: { phase: 'grace', until: NOW + 30 * 86_400_000 } } }) });
  assert.deepEqual(await acc.authConfig(), { email: true, devSignIn: false, legacy: 'grace', legacyUntil: NOW + 30 * 86_400_000 });
  assert.equal(await acc.devSignInOffered(), false, 'the dev sign-in reads the same answer');
  await acc.authConfig();
  assert.deepEqual(calls.map((c) => [c.method, c.path]), [['GET', '/api/config']]);
  for (const [auth, want] of [
    [undefined, { email: false, devSignIn: false, legacy: 'none', legacyUntil: null }],
    [{ email: 'yes', legacy: { phase: 'later' } }, { email: false, devSignIn: false, legacy: 'none', legacyUntil: null }],
    [{ email: true, legacy: { phase: 'closed', until: null } }, { email: true, devSignIn: false, legacy: 'closed', legacyUntil: null }],
  ]) {
    const c = client({ '/api/config': () => res(200, { auth }) });
    assert.deepEqual(await c.acc.authConfig(), want, JSON.stringify(auth));
  }
  let up = false;
  const off = client({ '/api/config': () => (up ? res(200, { auth: { email: true } }) : Promise.reject(new Error('offline'))) });
  assert.equal((await off.acc.authConfig()).email, false);
  up = true;
  await new Promise((r) => setTimeout(r, 0));
  assert.equal((await off.acc.authConfig()).email, true, 'asked again once the network is back');
});

// ---- sign-up: start, the attempt across a reload, check, finish -----------------------------------------

test('signupStart: the address normalized, the anti-bot token, the language; the attempt kept in sessionStorage (never localStorage), its resendAt on this clock', async () => {
  const { acc, calls, storage, session } = client({ '/api/auth/signup/start': () => res(200, { attempt: ATTEMPT, resendAt: NOW + 60_000, codeLength: 6 }) });
  const a = await acc.signupStart('  Mariana.Perez+TG@Example.com ');
  assert.deepEqual(calls[0].body, { email: 'mariana.perez+tg@example.com', lang: 'en', turnstileToken: 'tok' });
  assert.equal(calls[0].headers.authorization, undefined, 'anonymous');
  assert.deepEqual(a, { attempt: ATTEMPT, purpose: 'signup', email: 'mariana.perez+tg@example.com', resendAt: NOW + 60_000, at: NOW });
  assert.deepEqual(JSON.parse(session.getItem(E.ATTEMPT_KEY)), a);
  assert.equal(storage.map.size, 0, 'nothing in localStorage (I5)');
  await assert.rejects(acc.signupStart('mariana@'), (e) => e instanceof AC.AccountError && e.code === 'bad_email' && e.message === "Check the email: it doesn't look valid");
  await assert.rejects(acc.signupStart('ana@site.invalid'), (e) => e.code === 'bad_email');
  assert.equal(calls.length, 1, 'no request for an address that is none');
});

test('signupStart: a warmed token that died (403 turnstile_failed) is replaced once, silently; a server clock minutes off gets the server\'s minute from now', async () => {
  let tokens = 0;
  const { acc, calls } = client(
    { '/api/auth/signup/start': (b) => (b.turnstileToken === 'tok-2' ? res(200, { attempt: ATTEMPT, resendAt: NOW + 7 * 60_000 }) : res(403, { error: 'turnstile_failed' })) },
    { antiBot: async () => 'tok-' + ++tokens },
  );
  const a = await acc.signupStart('ana@example.com');
  assert.deepEqual(calls.map((c) => c.body.turnstileToken), ['tok-1', 'tok-2']);
  assert.equal(a.resendAt, NOW + E.RESEND_MS, 'a resendAt that does not read as a minute: a minute from now');
  const { acc: blocked } = client({}, { antiBot: async () => Promise.reject(new Error('blocked')) });
  await assert.rejects(blocked.signupStart('ana@example.com'), (e) => e.code === 'turnstile_failed' && e.status === 0, 'the check never ran here (a blocker)');
});

test('the attempt survives a reload (a new client on the same sessionStorage) for 30 minutes, and goes with "use another email"', async () => {
  const session = memStorage();
  const first = client({ '/api/auth/signup/start': () => res(200, { attempt: ATTEMPT, resendAt: NOW + 60_000 }) }, { session });
  await first.acc.signupStart('ana@example.com');
  const reloaded = client({}, { session, now: NOW + 29 * 60_000 });
  assert.equal(reloaded.acc.signupAttempt()?.attempt, ATTEMPT, 'the code step comes back after a reload');
  reloaded.at(NOW + 31 * 60_000);
  assert.equal(reloaded.acc.signupAttempt(), null, 'stale after 30 minutes');
  reloaded.at(NOW + 60_000);
  reloaded.acc.dropSignupAttempt();
  assert.equal(session.getItem(E.ATTEMPT_KEY), null);
  // What sessionStorage can hold that is not an attempt.
  for (const raw of ['{', '"x"', JSON.stringify({ attempt: 'short', purpose: 'signup', email: 'a@b.co', resendAt: 0, at: NOW }), JSON.stringify({ attempt: ATTEMPT, purpose: 'reauth', email: 'a@b.co', resendAt: 0, at: NOW }), JSON.stringify({ attempt: ATTEMPT, purpose: 'signup', email: 'nope', resendAt: 0, at: NOW }), JSON.stringify({ attempt: ATTEMPT, purpose: 'signup', email: 'a@b.co', resendAt: 0, at: NOW + 3_600_000 })]) assert.equal(E.attemptOf(raw, NOW), null, raw);
});

test('signupCheck at the sixth digit: { attempt, code }; a wrong code says the tries left, a dead one to ask again, an account made already its address', async () => {
  let answer = res(200, { email: 'ana@example.com' });
  const { acc, calls } = client({ '/api/auth/signup/check': () => answer });
  assert.equal(await acc.signupCheck({ attempt: ATTEMPT, code: '123456' }), 'ana@example.com');
  assert.deepEqual(calls[0].body, { attempt: ATTEMPT, code: '123456' });
  answer = res(400, { error: 'code_wrong', message: 'Código incorrecto', triesLeft: 2 });
  await assert.rejects(acc.signupCheck({ attempt: ATTEMPT, code: '000000' }), (e) => e.code === 'code_wrong' && e.detail.triesLeft === 2 && e.message === 'Wrong code. 2 tries left.');
  answer = res(400, { error: 'code_wrong', message: 'Código incorrecto', triesLeft: 1 });
  await assert.rejects(acc.signupCheck({ attempt: ATTEMPT, code: '000000' }), (e) => e.message === 'Wrong code. 1 try left.');
  answer = res(410, { error: 'code_expired', message: 'El código caducó. Pide otro.' });
  await assert.rejects(acc.signupCheck({ attempt: ATTEMPT, code: '000000' }), (e) => e.code === 'code_expired' && e.message === 'The code expired. Ask for a new one.');
  answer = res(409, { error: 'already_created', message: 'Tu cuenta ya está creada: inicia sesión.', email: 'ana@example.com' });
  await assert.rejects(acc.signupCheck({ attempt: ATTEMPT, code: '123456' }), (e) => e.code === 'already_created' && e.detail.email === 'ana@example.com' && e.message === 'Your account is already created: sign in.');
});

test('signupFinish: the proof, the name, the password key (never the password), the news switch, the language and time zone; signed in, the attempt gone, an email sign-in remembered', async () => {
  const session = memStorage();
  const storage = memStorage();
  const { acc, calls } = client(
    {
      '/api/auth/signup/start': () => res(200, { attempt: ATTEMPT, resendAt: NOW + 60_000 }),
      '/api/auth/signup/finish': (b) => res(200, SESSION({ name: b.username })),
    },
    { session, storage },
  );
  await acc.signupStart('mariana@example.com');
  let changes = 0;
  acc.subscribe(() => changes++);
  const s = await acc.signupFinish({ attempt: ATTEMPT, code: '975318' }, { username: 'Jugador4821', password: 'una clave larga', news: true, email: 'mariana@example.com' });
  const body = calls.at(-1).body;
  assert.equal(calls.at(-1).path, '/api/auth/signup/finish');
  assert.deepEqual(Object.keys(body).sort(), ['attempt', 'code', 'lang', 'news', 'password', 'tz', 'username']);
  assert.equal(body.password, await ACC.passwordKey('una clave larga'), 'the current key');
  assert.ok(isKey(body.password));
  assert.equal(body.news, true);
  assert.equal(typeof body.tz, 'string');
  assert.equal(s.name, 'Jugador4821');
  assert.equal(acc.signedIn, true);
  assert.equal(changes, 1, 'the menus (and a TV waiting on /tv) hear of it');
  assert.equal(acc.signupAttempt(), null, 'the attempt goes');
  assert.deepEqual(acc.lastSignIn(), { name: 'Jugador4821', method: 'email' });
  assert.doesNotMatch([...storage.map.values()].join(' '), /mariana@|una clave|975318|QQQQ/, 'localStorage keeps no address, password, code or attempt (I5)');
  for (const c of calls) for (const v of Object.values(c.body ?? {})) assert.notEqual(v, 'una clave larga');
});

test("signupFinish: a refused name puts the server's free one in the error (username_taken, name_lookalike, name_reserved); the proof is not spent by it", async () => {
  let answer;
  const { acc, session } = client({ '/api/auth/signup/finish': () => answer });
  acc.keepPendingLink({ kind: 'verify', token: TOKEN });
  const proof = { token: TOKEN };
  const f = { username: 'Mariana', password: 'una clave larga', news: false, email: 'mariana@example.com' };
  const cases = [
    [res(409, { error: 'username_taken', message: 'Ese nombre ya existe', suggest: 'Mariana27' }), 'username_taken', 'That name is taken. Try Mariana27.', 'Mariana27'],
    [res(409, { error: 'name_lookalike', message: 'Se parece', suggest: 'Mariana28' }), 'name_lookalike', 'That name is too close to another. Try Mariana28.', 'Mariana28'],
    [res(400, { error: 'name_reserved', message: 'Reservado', suggest: 'Player4821' }), 'name_reserved', 'That name is reserved. Try Player4821.', 'Player4821'],
    [res(409, { error: 'username_taken', message: 'x', suggest: 'Admin' }), 'username_taken', 'That name is taken', undefined], // a suggest that breaks the rules is never offered
  ];
  for (const [a, code, text, suggest] of cases) {
    answer = a;
    await assert.rejects(acc.signupFinish(proof, f), (e) => e.code === code && e.message === text && e.detail.suggest === suggest, code);
    assert.equal(acc.pendingLink()?.token, TOKEN, 'the link can go again with another name');
  }
  answer = res(409, { error: 'email_taken', message: 'Ese correo ya tiene una cuenta. Entra con ella.' });
  await assert.rejects(acc.signupFinish(proof, f), (e) => e.code === 'email_taken' && e.message === 'That email already has an account. Sign in with it.');
  assert.equal(acc.pendingLink(), null, 'an account owns the address now: the link is dead');
  assert.equal(session.getItem(E.LINK_KEY), null);
});

test('codeResend: { attempt } with no Bearer for a sign-up (with it for an account\'s own code); the kept attempt\'s resendAt moves; the caps say so in words', async () => {
  let answer = res(200, { resendAt: NOW + 60_000, resendsLeft: 2 });
  const { acc, calls } = client({ '/api/auth/signup/start': () => res(200, { attempt: ATTEMPT, resendAt: NOW + 60_000 }), '/api/auth/code/resend': () => answer, '/api/auth/refresh': () => res(200, SESSION()) });
  await acc.signupStart('ana@example.com');
  const r = await acc.codeResend(ATTEMPT);
  assert.deepEqual(calls.at(-1).body, { attempt: ATTEMPT });
  assert.equal(calls.at(-1).headers.authorization, undefined);
  assert.deepEqual(r, { resendAt: NOW + 60_000, resendsLeft: 2 });
  assert.equal(acc.signupAttempt().resendAt, NOW + 60_000);
  answer = res(429, { error: 'email_rate_limited', message: 'Ya te enviamos varios correos.', retryAfterMs: 50_000 });
  await assert.rejects(acc.codeResend(ATTEMPT), (e) => e.code === 'email_rate_limited' && e.message === 'We already sent you several emails. Wait a while before asking for another.');
  answer = res(503, { error: 'email_paused', message: 'Ahora no podemos enviar correos.' });
  await assert.rejects(acc.codeResend(ATTEMPT), (e) => e.code === 'email_paused' && e.message === "We can't send emails right now. Try again in a few minutes.");
  answer = res(200, { resendAt: NOW + 60_000, resendsLeft: 1 });
  await acc.restore();
  await acc.codeResend('R'.repeat(43), true);
  assert.equal(calls.at(-1).headers.authorization, 'Bearer jwt-m', "an account's own code: its Bearer");
});

// ---- sign-in, forgot, reset ------------------------------------------------------------------------------------

test('signIn by email: the address normalized, the current key only, the anti-bot token (its silent retry); level 2 adopted; this device remembers "email", never the address', async () => {
  let tokens = 0;
  const storage = memStorage();
  const { acc, calls } = client({ '/api/auth/signin': (b) => (b.turnstileToken === 'tok-2' ? res(200, SESSION()) : res(403, { error: 'turnstile_failed' })) }, { storage, antiBot: async () => 'tok-' + ++tokens });
  const s = await acc.signIn(' Mariana@Example.com', 'una clave larga');
  assert.equal(s.authLvl, 2);
  assert.deepEqual(calls.map((c) => c.body), [
    { email: 'mariana@example.com', password: await ACC.passwordKey('una clave larga'), turnstileToken: 'tok-1' },
    { email: 'mariana@example.com', password: await ACC.passwordKey('una clave larga'), turnstileToken: 'tok-2' },
  ]);
  assert.deepEqual(acc.lastSignIn(), { name: 'Mariana', method: 'email' });
  assert.doesNotMatch(storage.getItem(E.LAST_SIGN_IN_KEY), /@/);
  await assert.rejects(acc.signIn('mariana', 'x'), (e) => e.code === 'bad_email');
  await assert.rejects(acc.signIn('mariana@example.com', ''), (e) => e.code === 'empty' && e.message === 'Enter your password');
  assert.equal(calls.length, 2, 'refused here: no request');
});

test('forgot: { email, lang } with the anti-bot token, the same ok for any address; a non-address never leaves', async () => {
  const { acc, calls } = client({ '/api/auth/forgot': () => res(200, { ok: true }) });
  await acc.forgot('Ana@Example.com');
  assert.deepEqual(calls[0].body, { email: 'ana@example.com', lang: 'en', turnstileToken: 'tok' });
  await assert.rejects(acc.forgot('ana'), (e) => e.code === 'bad_email');
  assert.equal(calls.length, 1);
});

test("a reset link's token is kept until its POST settles: peek consumes nothing, no network and a refused password keep it, the reset spends it and signs in; a dead link drops it", async () => {
  let answer = null;
  const { acc, calls } = client({
    '/api/auth/reset/peek': () => res(200, { name: 'Mariana', email: 'mariana@example.com', hasPassword: false }),
    '/api/auth/reset': () => (answer === null ? Promise.reject(new Error('offline')) : answer),
  });
  acc.keepPendingLink({ kind: 'reset', token: TOKEN });
  const who = await acc.resetPeek(TOKEN);
  assert.deepEqual(who, { name: 'Mariana', email: 'mariana@example.com', hasPassword: false });
  assert.deepEqual(calls[0].body, { token: TOKEN }, 'in the body, never a query (I5)');
  assert.equal(acc.pendingLink()?.token, TOKEN, 'a peek consumes nothing');
  await assert.rejects(acc.resetPassword(TOKEN, 'mariana2026', who), (e) => e.code === 'bad_password' && e.message === "The password can't contain your username");
  assert.equal(calls.length, 1, 'refused here: no request');
  await assert.rejects(acc.resetPassword(TOKEN, 'una clave larga', who), (e) => e.code === 'network');
  assert.equal(acc.pendingLink()?.token, TOKEN, 'no network: the same link goes again');
  answer = res(429, { error: 'rate_limited', message: 'rate_limited' });
  await assert.rejects(acc.resetPassword(TOKEN, 'una clave larga', who), (e) => e.code === 'rate_limited');
  assert.equal(acc.pendingLink()?.token, TOKEN);
  answer = res(200, SESSION({ authLvl: 2 }));
  const s = await acc.resetPassword(TOKEN, 'una clave larga', who);
  assert.deepEqual(calls.at(-1).body, { token: TOKEN, password: await ACC.passwordKey('una clave larga'), lang: 'en' });
  assert.equal(s.name, 'Mariana');
  assert.equal(acc.signedIn, true);
  assert.equal(acc.pendingLink(), null, 'spent');
  assert.deepEqual(acc.lastSignIn(), { name: 'Mariana', method: 'email' });
  // A dead one.
  const dead = client({ '/api/auth/reset/peek': () => res(410, { error: 'link_invalid', message: 'El enlace caducó' }) });
  dead.acc.keepPendingLink({ kind: 'reset', token: TOKEN });
  await assert.rejects(dead.acc.resetPeek(TOKEN), (e) => e.code === 'link_invalid' && e.message === 'This link expired or was already used. Ask for a new one.');
  assert.equal(dead.acc.pendingLink(), null);
});

test('resetPassword waits for a refresh on its way (a page load): the old cookie never comes back after the reset revoked it', async () => {
  const order = [];
  let release;
  const { acc } = client({
    '/api/auth/refresh': () => new Promise((r) => (release = () => (order.push('refresh'), r(res(401, { error: 'no_refresh' }))))),
    '/api/auth/reset': () => (order.push('reset'), res(200, SESSION())),
  });
  const restoring = acc.restore();
  const resetting = acc.resetPassword(TOKEN, 'una clave larga', { name: 'Mariana', email: 'mariana@example.com' });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, [], 'the reset waits');
  release();
  await restoring;
  await resetting;
  assert.deepEqual(order, ['refresh', 'reset']);
  assert.equal(acc.signedIn, true, 'the reset\'s session stands');
});

test('the verify link: check { token } consumes nothing, finish { token, … } spends it; link_invalid and already_created drop it', async () => {
  let finish = res(200, SESSION());
  const { acc, calls } = client({ '/api/auth/signup/check': (b) => (b.token === TOKEN ? res(200, { email: 'mariana@example.com' }) : res(410, { error: 'link_invalid' })), '/api/auth/signup/finish': () => finish });
  acc.keepPendingLink({ kind: 'verify', token: TOKEN });
  assert.equal(await acc.signupCheck({ token: TOKEN }), 'mariana@example.com');
  assert.equal(acc.pendingLink()?.token, TOKEN);
  await acc.signupFinish({ token: TOKEN }, { username: 'Mariana', password: 'una clave larga', news: false, email: 'mariana@example.com' });
  assert.deepEqual(Object.keys(calls.at(-1).body).sort(), ['lang', 'news', 'password', 'token', 'tz', 'username']);
  assert.equal(acc.pendingLink(), null);
  const other = 'U'.repeat(43);
  acc.keepPendingLink({ kind: 'verify', token: other });
  await assert.rejects(acc.signupCheck({ token: other }), (e) => e.code === 'link_invalid');
  assert.equal(acc.pendingLink(), null);
  acc.keepPendingLink({ kind: 'verify', token: TOKEN });
  finish = res(409, { error: 'already_created', email: 'mariana@example.com' });
  await assert.rejects(acc.signupFinish({ token: TOKEN }, { username: 'Mariana', password: 'una clave larga', news: false, email: 'mariana@example.com' }), (e) => e.code === 'already_created' && e.detail.email === 'mariana@example.com');
  assert.equal(acc.pendingLink(), null);
});

// ---- the account's own: a first password by mail, "confirm it's you" by a code, a rename asked to confirm ----

test('passwordLink: POST /api/me/password/link with the Bearer, where the link went; an account without a verified address is told to add one', async () => {
  let answer = res(200, { sentTo: 'mariana@example.com' });
  const { acc, calls } = client({ '/api/auth/refresh': () => res(200, SESSION()), '/api/me/password/link': () => answer });
  await acc.restore();
  assert.equal(await acc.passwordLink(), 'mariana@example.com');
  assert.deepEqual(calls.at(-1).body, { lang: 'en' });
  assert.equal(calls.at(-1).headers.authorization, 'Bearer jwt-m');
  answer = res(409, { error: 'email_required', message: 'Primero agrega un correo' });
  await assert.rejects(acc.passwordLink(), (e) => e.code === 'email_required' && e.message === 'Add an email to your account first.');
});

test('"confirm it\'s you" by a code: reauth/code with the Bearer, then verify { attempt, code }: this browser at level 2; a maintainer is sent to its password', async () => {
  let start = res(200, { attempt: ATTEMPT, resendAt: NOW + 60_000, to: 'mariana@example.com' });
  const { acc, calls } = client({
    '/api/auth/refresh': () => res(200, SESSION({ authAt: NOW - 3_600_000, authLvl: 1 })),
    '/api/auth/reauth/code': () => start,
    '/api/auth/reauth/code/verify': () => res(200, SESSION({ session: 'jwt-fresh', authAt: NOW, authLvl: 2 })),
  });
  await acc.restore();
  assert.equal(acc.fresh(2), false);
  const s = await acc.reauthCodeStart();
  assert.deepEqual(s, { attempt: ATTEMPT, resendAt: NOW + 60_000, to: 'mariana@example.com' });
  assert.equal(calls.at(-1).headers.authorization, 'Bearer jwt-m');
  await acc.reauthCodeVerify(ATTEMPT, '123456');
  assert.deepEqual(calls.at(-1).body, { attempt: ATTEMPT, code: '123456' });
  assert.equal(acc.account.session, 'jwt-fresh');
  assert.equal(acc.fresh(2), true);
  start = res(403, { error: 'password_required', message: 'Esta cuenta confirma que eres tú con su contraseña' });
  await assert.rejects(acc.reauthCodeStart(), (e) => e.code === 'password_required' && e.message === 'This account confirms it is you with its password');
});

test("rename with the Bearer only; a 403 reauth_required { level: 2 } comes back with its level (PERFIL's \"confirm it's you\", as for a legacy key); a wrong password there reads \"Wrong password\"", async () => {
  const { acc, calls } = client({
    '/api/auth/refresh': () => res(200, SESSION({ authAt: NOW - 3_600_000, authLvl: 2 })),
    '/api/me/username': () => res(403, { error: 'reauth_required', message: 'Confirma que eres tú', level: 2 }),
    '/api/auth/reauth': () => res(401, { error: 'bad_credentials', message: 'Usuario o contraseña incorrectos' }),
    '/api/me/password': () => res(401, { error: 'bad_credentials', message: 'Usuario o contraseña incorrectos' }),
  });
  await acc.restore();
  const e = await acc.rename('Mariana2').then(() => null, (err) => err);
  assert.ok(e instanceof AC.AccountError && e.code === 'reauth_required' && e.level === 2);
  assert.deepEqual(calls.at(-1).body, { username: 'Mariana2', lang: 'en' });
  await assert.rejects(acc.reauth('otra clave'), (err) => err.code === 'bad_credentials' && err.message === 'Wrong password');
  await assert.rejects(acc.changePassword('otra clave', 'una clave larga'), (err) => err.code === 'bad_credentials' && err.message === 'Wrong password');
});

test('the last way in: a provider button pressed, then the restore of its round trip, remembers the provider (a stale mark does not); "email" after an email sign-in', async () => {
  const session = memStorage();
  const storage = memStorage();
  const { acc } = client({ '/api/auth/refresh': () => res(200, SESSION({ name: 'Bea' })) }, { session, storage });
  acc.providerStarted('discord');
  await acc.restore();
  assert.deepEqual(acc.lastSignIn(), { name: 'Bea', method: 'discord' });
  assert.equal(session.getItem('turbogol.auth.provider'), null, 'used once');
  const late = client({ '/api/auth/refresh': () => res(200, SESSION({ name: 'Bea' })) }, { now: NOW });
  late.acc.providerStarted('google');
  late.at(NOW + 11 * 60_000);
  await late.acc.restore();
  assert.equal(late.acc.lastSignIn(), null, 'a mark from long ago is no round trip');
  for (const raw of ['{', JSON.stringify({ name: 'Bea', method: 'password' }), JSON.stringify({ name: 'a@b.co', method: 'email' }), JSON.stringify({ name: '', method: 'email' })]) assert.equal(E.lastSignInOf(raw), null, raw);
});

// ---- the pure part ---------------------------------------------------------------------------------------------

test("signInRoute: an '@' signs in by email, a username by the legacy sign-in until the cutoff, then no request (legacy_closed)", () => {
  assert.deepEqual(E.signInRoute(' Ana@Example.COM ', 'none'), { kind: 'email', email: 'ana@example.com' });
  assert.deepEqual(E.signInRoute('Ana', 'none'), { kind: 'legacy', username: 'Ana' });
  assert.deepEqual(E.signInRoute(' Ana ', 'grace'), { kind: 'legacy', username: 'Ana' });
  assert.deepEqual(E.signInRoute('Ana', 'closed'), { kind: 'closed' });
  assert.deepEqual(E.signInRoute('ana@example.com', 'closed'), { kind: 'email', email: 'ana@example.com' }, 'an address still signs in after the cutoff');
  assert.deepEqual(E.signInRoute('ana@', 'none'), { kind: 'bad_email' });
  assert.deepEqual(E.signInRoute('   ', 'none'), { kind: 'empty' });
});

test('parseAccountLink: /account#<kind>=<token> and /account#forgot only; kept and read back from storage', () => {
  assert.deepEqual(E.parseAccountLink('/account', '#verify=' + TOKEN), { kind: 'verify', token: TOKEN });
  assert.deepEqual(E.parseAccountLink('/account/', '#reset=' + TOKEN), { kind: 'reset', token: TOKEN });
  for (const k of ['email', 'undo', 'keep', 'unsub']) assert.deepEqual(E.parseAccountLink('/account', `#${k}=${TOKEN}`), { kind: k, token: TOKEN });
  assert.deepEqual(E.parseAccountLink('/account', '#forgot'), { kind: 'forgot', token: null });
  for (const [path, hash] of [['/', '#verify=' + TOKEN], ['/account', '#verify=short'], ['/account', '#verify=' + TOKEN + '&x=1'], ['/account', '#login=' + TOKEN], ['/account', '#forgot=' + TOKEN], ['/accounts', '#verify=' + TOKEN], ['/account', '']]) assert.equal(E.parseAccountLink(path, hash), null, path + hash);
  const s = memStorage();
  E.keepLink(s, { kind: 'reset', token: TOKEN }, NOW);
  assert.deepEqual(E.readLink(s, NOW + 59 * 60_000), { kind: 'reset', token: TOKEN });
  assert.equal(E.readLink(s, NOW + 61 * 60_000), null, 'stale after the link\'s hour');
  E.keepLink(s, { kind: 'forgot', token: null }, NOW);
  assert.equal(s.getItem(E.LINK_KEY), null, 'forgot has nothing to keep');
});

test('cleanCode, localResendAt, providersText, inAppBrowser, signupNamePrefill', () => {
  assert.equal(E.cleanCode(' 123-456 '), '123456');
  assert.equal(E.cleanCode('12 34 56 78'), '123456');
  assert.equal(E.cleanCode('abc'), '');
  assert.equal(E.localResendAt(NOW + 42_000, NOW), NOW + 42_000);
  assert.equal(E.localResendAt(NOW - 5 * 60_000, NOW), NOW + 60_000, 'a server clock behind');
  assert.equal(E.localResendAt(NOW + 9 * 60_000, NOW), NOW + 60_000, 'a server clock ahead');
  assert.equal(E.providersText(['discord'], 'or'), 'Discord');
  assert.equal(E.providersText(['discord', 'google'], 'o'), 'Google o Discord');
  assert.equal(E.providersText([], 'or'), '');
  assert.equal(E.inAppBrowser('Mozilla/5.0 (Linux; Android 14) Instagram/312.0'), true);
  assert.equal(E.inAppBrowser('Mozilla/5.0 (iPhone) Mobile/15E148 [FBAN/FBIOS;FBAV/450.0]'), true);
  assert.equal(E.inAppBrowser('Mozilla/5.0 (Windows NT 10.0) Chrome/140 Safari/537.36 Edg/140'), false);
  const valid = (n) => ACC.usernameIssue(n) === null;
  assert.equal(E.signupNamePrefill('Jugador', '4821', valid), 'Jugador4821', "the guest's digits");
  assert.match(E.signupNamePrefill('Player', null, valid, () => 0.5), /^Player\d{4}$/);
  assert.match(E.signupNamePrefill('Invitado', '4821', valid, () => 0.1), /^Player\d{4}$/, 'a reserved word falls back');
});
