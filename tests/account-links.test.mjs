// Sign-in PR 6, the client parts without a browser: the arbiter of URL-driven sheets and the phone's
// /tv continuation (it survives #auth=confirm in either order of the sheets), the MODOS / GARAJE
// detour kept across a provider's round trip, the confirm sheet's name, and AccountClient's confirm
// step (pending, create, cancel, the sign-in with linkPending, the start flags, the TV's renewal).
// The server side: server/test/oauth-email.test.mjs. Run: node --test tests/account-links.test.mjs
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

const L = await import('../src/ui/screens/accountLinksModel.ts');
const M = await import('../src/ui/screens/tvSignInModel.ts');
const AC = await import('../src/net/AccountClient.ts');
const ACC = await import('../src/net/account.ts');

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---- the arbiter and the TV continuation ---------------------------------------------------------

test('UrlSheets: a step starts once every step before it is done, whichever asks first', async () => {
  const u = new L.UrlSheets(['auth', 'tv']);
  const order = [];
  void u.turn('tv').then(() => order.push('tv'));
  void u.turn('auth').then(() => order.push('auth'));
  await tick();
  assert.deepEqual(order, ['auth'], 'the first step has no one before it');
  u.done('auth');
  await tick();
  assert.deepEqual(order, ['auth', 'tv']);
  assert.equal(u.isDone('auth'), true);
  // A late asker of a finished turn goes at once.
  let late = false;
  await u.turn('tv').then(() => (late = true));
  assert.equal(late, true);
});

/** A fake phone: an account that signs in when told, its listeners, the sheets the continuation opens. */
function phone({ signedIn = false } = {}) {
  const p = { signedIn, listeners: [], shown: [], ready: 0, restores: 0 };
  p.signIn = () => {
    p.signedIn = true;
    for (const fn of p.listeners) fn();
  };
  p.deps = (turn) => ({
    turn,
    ready: async () => {
      p.ready++;
    },
    signedIn: () => p.signedIn,
    restore: async () => {
      p.restores++;
    },
    codeEntry: () => p.shown.push('code'),
    signInFirst: () => p.shown.push('signInFirst'),
    subscribe: (fn) => p.listeners.push(fn),
  });
  return p;
}

test('the TV continuation survives #auth=confirm: the TV installed first waits for the confirm sheet, which creates the account; then the code entry, once', async () => {
  const u = new L.UrlSheets(['auth', 'tv']);
  const p = phone();
  M.tvContinuation(p.deps(() => u.turn('tv')));
  await tick();
  assert.deepEqual(p.shown, [], 'nothing over the confirm sheet');
  assert.equal(p.ready, 0, 'it does not even wait for the menus yet');
  p.signIn(); // CREAR on the confirm sheet: the account adopted, every listener told
  await tick();
  assert.deepEqual(p.shown, [], 'an account change during the auth step starts nothing');
  u.done('auth');
  await tick();
  assert.deepEqual(p.shown, ['code']);
  p.signIn(); // a later refresh, a rename: no second sheet
  await tick();
  assert.deepEqual(p.shown, ['code']);
});

test('the TV continuation survives #auth=confirm the other way round: the auth step finished before the TV asked', async () => {
  const u = new L.UrlSheets(['auth', 'tv']);
  const p = phone();
  p.signIn();
  u.done('auth');
  M.tvContinuation(p.deps(() => u.turn('tv')));
  await tick();
  assert.deepEqual(p.shown, ['code']);
  assert.equal(p.restores, 0, 'signed in: no restore');
});

test('the TV continuation: the confirm sheet closed without an account: "sign in first", then any later sign-in brings the code entry, once', async () => {
  const u = new L.UrlSheets(['auth', 'tv']);
  const p = phone();
  M.tvContinuation(p.deps(() => u.turn('tv')));
  u.done('auth');
  await tick();
  assert.deepEqual(p.shown, ['signInFirst']);
  assert.equal(p.restores, 1, 'it tried the refresh cookie first');
  p.signIn(); // PERFIL, a provider's round trip in this page, the confirm sheet of a later round
  await tick();
  assert.deepEqual(p.shown, ['signInFirst', 'code']);
  p.signIn();
  await tick();
  assert.deepEqual(p.shown, ['signInFirst', 'code']);
});

test('the TV renews 20 s before its code ends, at once when that is past; six renewals', () => {
  assert.equal(M.renewDelay(100_000, 0), 80_000);
  assert.equal(M.renewDelay(10_000, 0), 0);
  assert.equal(M.RENEW_BEFORE_MS, 20_000);
  assert.equal(M.TV_RENEWS, 6);
});

// ---- the detour ----------------------------------------------------------------------------------

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m };
}

test('the detour: MODOS (its tab) or GARAJE kept in sessionStorage across a provider\'s round trip, read once, 30 minutes', () => {
  const s = memStorage();
  const at = 1_000_000;
  L.keepDetour({ screen: 'modes', tab: 'ranked' }, at, s);
  assert.equal(L.DETOUR_KEY, 'turbogol.auth.detour');
  assert.deepEqual(JSON.parse(s.getItem(L.DETOUR_KEY)), { screen: 'modes', tab: 'ranked', at });
  assert.deepEqual(L.takeDetour(at + 60_000, s), { screen: 'modes', tab: 'ranked' });
  assert.equal(L.takeDetour(at + 60_000, s), null, 'once');
  L.keepDetour({ screen: 'garage' }, at, s);
  assert.equal(L.takeDetour(at + L.DETOUR_MS + 1, s), null, 'stale');
  assert.equal(s.getItem(L.DETOUR_KEY), null, 'and gone');
  L.keepDetour({ screen: 'garage' }, at, s);
  L.dropDetour(s);
  assert.equal(L.takeDetour(at, s), null, 'dropped when the screen came back');
  for (const raw of ['{', JSON.stringify({ screen: 'profile', at }), JSON.stringify({ screen: 'modes', at: 'x' }), JSON.stringify({ screen: 'modes', at: at + 5 })]) assert.equal(L.detourOf(raw, at), null, raw);
  assert.deepEqual(L.detourOf(JSON.stringify({ screen: 'modes', tab: 'x</script>', at }), at), { screen: 'modes' }, 'a tab that is no tab id is dropped');
});

test('the confirm sheet\'s name: the word and the guest\'s digits, never anything of the provider; valid under the name rules', () => {
  assert.equal(L.namePrefill('Jugador', '4821'), 'Jugador4821');
  assert.equal(L.namePrefill('Player', '4821'), 'Player4821');
  assert.equal(L.namePrefill('Jugador', null, () => 0.5), 'Jugador5500');
  assert.equal(L.namePrefill('Jugador', 'abcd', () => 0), 'Jugador1000');
  for (const n of [L.namePrefill('Jugador', '1000'), L.namePrefill('Player', null)]) assert.equal(ACC.usernameIssue(n), null, n);
});

// ---- AccountClient: the confirm step -------------------------------------------------------------

function fakeServer(handlers) {
  const calls = [];
  const fetchFn = async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, body });
    const h = handlers[path.split('?')[0]];
    return h ? h(body) : res(404, { error: 'not_found' });
  };
  return { fetchFn, calls };
}
const SESSION = (extra = {}) => ({ kind: 'account', playerId: 'abcdef0123456789', name: 'Nadia', session: 'jwt', expiresAt: Date.now() + 3_600_000, authAt: Date.now(), authLvl: 1, ...extra });

test('parseAuthHash: confirm, ok with the link\'s refusal, no_account; their texts', () => {
  assert.deepEqual(AC.parseAuthHash('#auth=confirm'), { kind: 'confirm' });
  assert.deepEqual(AC.parseAuthHash('#auth=ok:provider_set'), { kind: 'ok', linkError: 'provider_set' });
  assert.deepEqual(AC.parseAuthHash('#auth=ok'), { kind: 'ok' });
  assert.deepEqual(AC.parseAuthHash('#auth=error:no_account'), { kind: 'error', code: 'no_account' });
  assert.match(AC.oauthErrorText('no_account'), /no Turbogol account either/);
  assert.match(AC.oauthErrorText('wrong_account'), /another Turbogol account/);
  assert.match(AC.oauthErrorText('email_has_account'), /already belongs to a Turbogol account/);
  assert.match(AC.oauthErrorText('no_pending'), /expired/);
});

test('AccountClient: pending (404: none), CREAR with a solved check, the name, news, language and zone; a taken name carries its suggestion; cancel', async () => {
  let created = 0;
  const srv = fakeServer({
    '/api/auth/pending': () => res(200, { provider: 'discord', email: 'nadia@example.org', trust: 'asserted', second: null, match: null }),
    '/api/auth/pending/create': (b) => (b.username === 'Ana' ? res(409, { error: 'username_taken', message: 'Ese nombre ya está en uso', suggest: 'Ana4821' }) : (created++, res(200, SESSION({ name: b.username })))),
    '/api/auth/pending/cancel': () => res(200, { ok: true }),
  });
  const acc = new AC.AccountClient({ fetchFn: srv.fetchFn, storage: null, antiBot: async () => 'tok' });
  assert.deepEqual(await acc.pending(), { provider: 'discord', email: 'nadia@example.org', trust: 'asserted', second: null, match: null });
  const e = await acc.createAccount('Ana', { news: false, lang: 'es', tz: 'America/Argentina/Cordoba' }).catch((x) => x);
  assert.ok(e instanceof AC.AccountError);
  assert.deepEqual([e.code, e.suggest, e.status], ['username_taken', 'Ana4821', 409]);
  assert.match(e.message, /Ana4821/);
  const s = await acc.createAccount('Nadia', { news: true, lang: 'es', tz: 'America/Argentina/Cordoba' });
  assert.equal(s.name, 'Nadia');
  assert.equal(acc.account.name, 'Nadia', 'adopted');
  assert.deepEqual(srv.calls.find((c) => c.path === '/api/auth/pending/create' && c.body.username === 'Nadia').body, { username: 'Nadia', news: true, lang: 'es', tz: 'America/Argentina/Cordoba', turnstileToken: 'tok' });
  await assert.rejects(acc.createAccount('Guest_1', { news: false, lang: 'es', tz: '' }), (x) => x.code === 'bad_username', 'refused before any request');
  // The email sign-up's name rules (sign-in PR 7, met in the merge): a look-alike of a protected
  // account (409) and a reserved word only the server knows (400) carry their free name too.
  const rules = fakeServer({
    '/api/auth/pending/create': (b) =>
      b.username === 'Pr0yect0' ? res(409, { error: 'name_lookalike', message: 'Ese nombre se parece mucho a otro', suggest: 'Pr0yect4821' }) : res(400, { error: 'name_reserved', message: 'Ese nombre está reservado', suggest: 'Jugador4821' }),
  });
  const named = new AC.AccountClient({ fetchFn: rules.fetchFn, storage: null, antiBot: async () => 'tok' });
  const look = await named.createAccount('Pr0yect0', { news: false, lang: 'es', tz: '' }).catch((x) => x);
  assert.deepEqual([look.code, look.suggest, look.status], ['name_lookalike', 'Pr0yect4821', 409]);
  assert.match(look.message, /Pr0yect4821/);
  const kept = await named.createAccount('Nombre', { news: false, lang: 'es', tz: '' }).catch((x) => x);
  assert.deepEqual([kept.code, kept.suggest, kept.status], ['name_reserved', 'Jugador4821', 400]);
  assert.equal(named.account, null, 'nothing adopted');
  await acc.cancelPending();
  assert.equal(srv.calls.at(-1).path, '/api/auth/pending/cancel');
  const none = new AC.AccountClient({ fetchFn: fakeServer({ '/api/auth/pending': () => res(404, { error: 'no_pending' }) }).fetchFn, storage: null });
  assert.equal(await none.pending(), null);
});

test('AccountClient: "I have one" signs in with linkPending and says what was linked, or why not; the start flags; the TV\'s renewal', async () => {
  const srv = fakeServer({ '/api/auth/login': (b) => res(200, { ...SESSION({ name: b.username }), ...(b.username === 'Ana' ? { linked: ['discord'] } : { linkError: 'wrong_account' }) }), '/api/auth/tv/renew': () => res(200, { code: 'DEF567', expiresAt: 1, ttlMs: 240_000 }) });
  const acc = new AC.AccountClient({ fetchFn: srv.fetchFn, storage: null, antiBot: async () => 'tok' });
  const a = await acc.loginAndLink('Ana', 'una contraseña larga');
  assert.deepEqual([a.session.name, a.linked, a.linkError], ['Ana', ['discord'], null]);
  const body = srv.calls[0].body;
  assert.equal(body.linkPending, true);
  assert.equal(body.turnstileToken, 'tok');
  assert.match(body.password, /^[0-9a-f]{64}$/, 'keys, never the password');
  const b = await acc.loginAndLink('Carla', 'una contraseña larga');
  assert.deepEqual([b.linked, b.linkError], [[], 'wrong_account']);
  assert.equal(acc.oauthUrl('discord', 'pend'), '/api/auth/oauth/discord/start?pend=1');
  assert.equal(acc.oauthUrl('discord', 'reauth', 'google'), '/api/auth/oauth/discord/start?reauth=1&then=link:google');
  assert.equal(acc.oauthUrl('google'), '/api/auth/oauth/google/start');
  assert.deepEqual(await acc.tvRenew('ABC234', 's'.repeat(43)), { code: 'DEF567', expiresAt: 1, ttlMs: 240_000 });
  assert.deepEqual(srv.calls.at(-1), { path: '/api/auth/tv/renew', body: { code: 'ABC234', secret: 's'.repeat(43) } });
});
