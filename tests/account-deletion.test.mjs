// Account deletion in the browser (sign-in PR 12, the design's §2.10): the API methods of
// src/net/AccountClient.ts only (the screens come with the terms of service): deleteAccount,
// cancelDeletion (M9's link), the cancelDeletion flag of the password sign-ins and the OAuth start,
// and how a deletion_pending refusal reads (its purgeAt, its text in the player's language). Against
// a fake fetch, as tests/account-client.test.mjs. The server's side: server/test/deletion.test.mjs.
//   node --test tests/account-deletion.test.mjs
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
const I = await import('../src/i18n.ts');
const en = (await import('../src/locales/en.ts')).default;
const es = (await import('../src/locales/es.ts')).default;

function res(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m };
}

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
const TOKEN = 'K'.repeat(43);
const PURGE = NOW + 14 * 86_400_000;

function client(handlers) {
  const srv = fakeServer(handlers);
  const acc = new AC.AccountClient({ storage: memStorage(), session: memStorage(), fetchFn: srv.fetchFn, now: () => NOW, sleep: async () => undefined, antiBot: async () => 'tok' });
  return { acc, calls: srv.calls };
}

const pending = () => res(409, { error: 'deletion_pending', message: 'Esta cuenta tiene un borrado pendiente', purgeAt: PURGE });

test('deleteAccount: POST /api/me/delete { confirm, lang } with the Bearer; the purge date; this device forgets its session (the server signed every one out)', async () => {
  const { acc, calls } = client({
    '/api/auth/signin': () => res(200, SESSION()),
    '/api/me/delete': (b, h) => (h.authorization === 'Bearer jwt-m' && b.confirm === 'Mariana' ? res(200, { purgeAt: PURGE }) : res(400, { error: 'bad_confirm', message: 'Escribe tu nombre de usuario para confirmar' })),
  });
  await acc.signIn('mariana@example.com', 'una clave larga');
  let changes = 0;
  acc.subscribe(() => changes++);
  assert.equal(await acc.deleteAccount('Mariana'), PURGE);
  assert.deepEqual(calls.at(-1).body, { confirm: 'Mariana', lang: 'en' });
  assert.equal(acc.signedIn, false);
  assert.ok(changes > 0, 'the menus hear it');
  // Signed out: nothing more goes.
  await assert.rejects(acc.deleteAccount('Mariana'), (e) => e.code === 'unauthorized');
});

test('deleteAccount refusals: reauth_required carries its level, bad_confirm / maintainer_account / deletion_pending their own text; the session stays', async () => {
  let answer = res(403, { error: 'reauth_required', message: 'x', level: 2 });
  const { acc } = client({ '/api/auth/signin': () => res(200, SESSION()), '/api/me/delete': () => answer });
  await acc.signIn('mariana@example.com', 'una clave larga');
  await assert.rejects(acc.deleteAccount('Mariana'), (e) => e.code === 'reauth_required' && e.level === 2);
  answer = res(403, { error: 'reauth_required', message: 'x', level: 1 });
  await assert.rejects(acc.deleteAccount('Mariana'), (e) => e.level === 1, 'an account whose most is a provider press');
  answer = res(400, { error: 'bad_confirm', message: 'Escribe tu nombre de usuario para confirmar' });
  await assert.rejects(acc.deleteAccount('Mari'), (e) => e.code === 'bad_confirm' && e.message === en['error.account.bad_confirm']);
  answer = res(409, { error: 'maintainer_account', message: 'La cuenta del proyecto no se puede borrar.' });
  await assert.rejects(acc.deleteAccount('Mariana'), (e) => e.code === 'maintainer_account' && e.message === en['error.account.maintainer_account']);
  answer = pending();
  await assert.rejects(acc.deleteAccount('Mariana'), (e) => e.code === 'deletion_pending' && e.detail.purgeAt === PURGE);
  assert.equal(acc.signedIn, true, 'a refusal changes nothing');
});

test('signIn and legacySignIn: deletion_pending rejects with its purgeAt; sent again with { cancelDeletion: true } the flag goes and it signs in; without it the body never carries one', async () => {
  const { acc, calls } = client({
    '/api/auth/signin': (b) => (b.cancelDeletion === true ? res(200, SESSION()) : pending()),
    '/api/auth/login': (b) => (b.cancelDeletion === true ? res(200, SESSION()) : pending()),
  });
  await assert.rejects(acc.signIn('mariana@example.com', 'una clave larga'), (e) => e instanceof AC.AccountError && e.code === 'deletion_pending' && e.status === 409 && e.detail.purgeAt === PURGE && e.message === en['error.account.deletion_pending']);
  assert.equal('cancelDeletion' in calls.at(-1).body, false);
  assert.equal(acc.signedIn, false);
  const s = await acc.signIn('mariana@example.com', 'una clave larga', { cancelDeletion: true });
  assert.equal(s.playerId, 'abcdef0123456789');
  assert.equal(calls.at(-1).body.cancelDeletion, true);
  await acc.logout();
  await assert.rejects(acc.legacySignIn('Mariana', 'una clave larga'), (e) => e.code === 'deletion_pending' && e.detail.purgeAt === PURGE);
  assert.equal('cancelDeletion' in calls.at(-1).body, false);
  await acc.legacySignIn('Mariana', 'una clave larga', { cancelDeletion: true });
  assert.equal(calls.at(-1).body.cancelDeletion, true);
  assert.equal(acc.signedIn, true);
  // A purgeAt of another shape is no detail.
  const odd = client({ '/api/auth/signin': () => res(409, { error: 'deletion_pending', purgeAt: 'soon' }) });
  await assert.rejects(odd.acc.signIn('mariana@example.com', 'una clave larga'), (e) => e.detail.purgeAt === undefined);
});

test("cancelDeletion (M9's link): POST /api/auth/delete/cancel { token }; the kept link is spent on success and on link_invalid, kept without a network", async () => {
  let answer = () => res(200, { ok: true });
  const { acc, calls } = client({ '/api/auth/delete/cancel': () => answer() });
  acc.keepPendingLink({ kind: 'keep', token: TOKEN });
  answer = () => {
    throw new Error('offline');
  };
  await assert.rejects(acc.cancelDeletion(TOKEN), (e) => e.code === 'network');
  assert.equal(acc.pendingLink()?.token, TOKEN, 'kept: the same link can go again');
  answer = () => res(200, { ok: true });
  await acc.cancelDeletion(TOKEN);
  assert.deepEqual(calls.at(-1), { path: '/api/auth/delete/cancel', method: 'POST', body: { token: TOKEN }, headers: { 'content-type': 'application/json' } });
  assert.equal(acc.pendingLink(), null);
  acc.keepPendingLink({ kind: 'keep', token: TOKEN });
  answer = () => res(410, { error: 'link_invalid', message: 'El enlace caducó o ya se usó' });
  await assert.rejects(acc.cancelDeletion(TOKEN), (e) => e.code === 'link_invalid');
  assert.equal(acc.pendingLink(), null, 'dead: dropped');
});

test('a reset that answers deletion_pending set the password: its kept link is spent; oauthUrl("cancelDel") starts the sign-in that calls a deletion off', async () => {
  const { acc } = client({ '/api/auth/reset': () => pending() });
  acc.keepPendingLink({ kind: 'reset', token: TOKEN });
  await assert.rejects(acc.resetPassword(TOKEN, 'una clave larga', { name: 'Mariana', email: 'mariana@example.com' }), (e) => e.code === 'deletion_pending' && e.detail.purgeAt === PURGE);
  assert.equal(acc.pendingLink(), null);
  assert.equal(acc.signedIn, false);
  assert.equal(acc.oauthUrl('discord', 'cancelDel'), '/api/auth/oauth/discord/start?cancelDel=1');
  assert.equal(acc.oauthUrl('google', 'pend'), '/api/auth/oauth/google/start?pend=1', 'the other flags as they were');
});

test('the deletion codes have their text in both languages (neutral Spanish), and serverText picks it', () => {
  for (const code of ['deletion_pending', 'bad_confirm', 'maintainer_account']) {
    const key = 'error.account.' + code;
    assert.equal(typeof en[key], 'string', key);
    assert.equal(typeof es[key], 'string', key);
    assert.notEqual(es[key], en[key]);
    assert.equal(I.hasServerText('account', code), true);
  }
  assert.doesNotMatch(Object.values({ a: es['error.account.bad_confirm'], b: es['error.account.deletion_pending'] }).join(' '), /escribí|tenés|podés/i);
});

test('a Discord or Google return with /#auth=error:deletion_pending says the deletion is pending, not a generic failure', () => {
  assert.deepEqual(AC.parseAuthHash('#auth=error:deletion_pending'), { kind: 'error', code: 'deletion_pending' });
  assert.equal(AC.oauthErrorText('deletion_pending'), en['error.account.deletion_pending']);
  assert.notEqual(AC.oauthErrorText('deletion_pending'), en['auth.oauthFailed']);
});
