// Security 3, the browser's side (src/net/AccountClient.ts on a fake fetch): a refresh another tab
// won is asked again, not taken for a sign-out; the device list and sign out everywhere; the TV's
// limited scope as the session says it; the TV code typed (never confirmed from the link); linking,
// a first password and new codes behind a fresh sign-in; the login's anti-bot step when the server
// slows a username down. The server's side: server/test/takeover.test.mjs.
//   node --test tests/account-security.test.mjs
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
    return h(body, init.headers, path, calls);
  };
  return { fetchFn, calls };
}

const SESSION = (extra = {}) => ({ kind: 'account', playerId: 'abcdef0123456789', name: 'Ana', session: 'jwt-ana', expiresAt: Date.now() + 3_600_000, ...extra });
const client = (handlers, opts = {}) => {
  const srv = fakeServer(handlers);
  return { acc: new AC.AccountClient({ storage: null, fetchFn: srv.fetchFn, sleep: async () => undefined, ...opts }), calls: srv.calls };
};

// ---- auth-4 ---------------------------------------------------------------------------------------

test('auth-4: a refresh another tab won (409 refresh_race) is asked once more and the session kept, not signed out', async () => {
  let n = 0;
  const { acc, calls } = client({ '/api/auth/refresh': () => (++n === 1 ? res(409, { error: 'refresh_race' }) : res(200, SESSION())) });
  const s = await acc.restore();
  assert.equal(s?.name, 'Ana');
  assert.equal(calls.filter((c) => c.path === '/api/auth/refresh').length, 2);
  assert.equal(acc.signedIn, true);
});

test('auth-4: the device list and sign out everywhere (any account), which signs this browser out too', async () => {
  const devices = [
    { id: 'a'.repeat(32), kind: 'web', signedInAt: 1, lastUsedAt: 2, country: 'AR', city: 'Córdoba', current: true },
    { id: 'b'.repeat(32), kind: 'tv', signedInAt: 1, lastUsedAt: 3, country: null, city: null, current: false },
    { id: 5, kind: 'web' }, // junk is dropped
  ];
  const { acc, calls } = client({
    '/api/auth/refresh': () => res(200, SESSION()),
    '/api/auth/sessions': () => res(200, { sessions: devices }),
    '/api/auth/sessions/revoke': () => res(200, { revoked: 1 }),
    '/api/auth/sessions/revoke-all': () => res(200, { revoked: 3 }),
  });
  await acc.restore();
  const list = await acc.sessions();
  assert.deepEqual(list.map((d) => d.id), ['a'.repeat(32), 'b'.repeat(32)]);
  await acc.revokeSession('b'.repeat(32));
  assert.deepEqual(calls.at(-1).body, { id: 'b'.repeat(32) });
  assert.equal(calls.at(-1).headers.authorization, 'Bearer jwt-ana');
  assert.equal(acc.signedIn, true, 'another device: this one stays');
  await acc.signOutEverywhere();
  assert.equal(calls.at(-1).path, '/api/auth/sessions/revoke-all');
  assert.equal(acc.signedIn, false, 'every device, this one too');
});

// ---- auth-1: the TV's limited scope as the session carries it ------------------------------------

test('auth-1: an approved TV session keeps its tv flag (PERFIL then shows only its own sign-out); the OAuth refusal has words', async () => {
  const { acc } = client({});
  acc.signInWith({ ...SESSION({ tv: true }), state: 'approved' });
  assert.equal(acc.account.tv, true);
  assert.equal('state' in acc.account, false, 'only the session is adopted');
  assert.doesNotMatch(AC.oauthErrorText('tv_session'), /^error\.|Couldn't sign in/);
});

// ---- auth-1 / client-1 / tv-1: the phone types the code and sees where the TV is; the TV solves the check ----

test('auth-1: the TV\'s start sends the anti-bot token (one per code), a failed check says so', async () => {
  let n = 0;
  const { acc, calls } = client(
    { '/api/auth/tv/start': () => res(200, { code: 'ABC234', secret: 's'.repeat(43), expiresAt: Date.now() + 240_000, ttlMs: 240_000, pollMs: 3000 }) },
    { antiBot: async () => 'tok-' + ++n },
  );
  await acc.tvStart();
  await acc.tvStart();
  assert.deepEqual(calls.map((c) => c.body), [{ turnstileToken: 'tok-1' }, { turnstileToken: 'tok-2' }]);
  const { acc: broken } = client({}, { antiBot: async () => Promise.reject(new Error('widget')) });
  await assert.rejects(broken.tvStart(), (e) => e.code === 'turnstile_failed');
});

test('auth-1: the phone asks where the TV is with its Bearer (POST /api/auth/tv/info), and words it', async () => {
  const where = { country: 'AR', city: 'Córdoba', asn: 7303, org: 'Telecom Argentina' };
  const { acc, calls } = client({
    '/api/auth/refresh': () => res(200, SESSION()),
    '/api/auth/tv/info': () => res(200, { where, sameNetwork: false, sameCountry: true, createdAt: 1 }),
  });
  await acc.restore();
  const info = await acc.tvInfo('ABC234');
  assert.deepEqual(calls.at(-1).body, { code: 'ABC234' });
  assert.equal(calls.at(-1).headers.authorization, 'Bearer jwt-ana');
  const M = await import('../src/ui/screens/tvSignInModel.ts');
  assert.equal(M.tvPlace(info.where), 'Córdoba, AR · Telecom Argentina');
  assert.equal(M.tvPlace({ country: 'AR', city: null, asn: null, org: null }), 'AR');
  assert.equal(M.tvPlace({ country: 'AR', city: 'Rosario', asn: 1, org: 'Coop. Ltda.' }), 'Rosario, AR · Coop. Ltda', 'the sentence puts its own dot');
  assert.equal(M.tvPlace({ country: null, city: null, asn: null, org: null }), null);
  assert.equal(M.tvPlace(null), null);
});

test('auth-1 / client-1: the /tv page never confirms the link\'s code in one tap: the entry is always empty and typed, the place shown before CONFIRMAR', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/ui/screens/tvSignIn.ts', import.meta.url), 'utf8');
  const install = src.slice(src.indexOf('export function installTvLink'));
  assert.match(install, /codeSheet\(menu, '', ask\)/, 'the code cells start empty');
  assert.doesNotMatch(install, /\bask\(code\)/, 'the link\'s code never goes to the CONFIRMAR sheet');
  assert.doesNotMatch(install, /codeSheet\(menu, code\b/, 'nor into the cells');
  assert.match(install, /acc\.tvInfo\(c\)/, 'where the TV is, asked before the sheet');
});

// ---- auth-2 / authz-1: a link after a fresh sign-in, re-authentication, unlink -------------------

test('auth-2: PERFIL links only right after a sign-in (fresh), else it asks "confirm it is you"; a TV never is fresh', async () => {
  let now = 1_800_000_000_000;
  const { acc } = client({ '/api/auth/refresh': () => res(200, SESSION({ authAt: now - 60_000 })) }, { now: () => now });
  await acc.restore();
  assert.equal(acc.fresh(), true, 'signed in a minute ago');
  now += 9 * 60_000;
  assert.equal(acc.fresh(), false, 'nine minutes later: confirm first');
  acc.signInWith({ ...SESSION({ tv: true, authAt: now }) });
  assert.equal(acc.fresh(), false, 'a TV, whatever it says');
  assert.equal(acc.oauthUrl('discord', true), '/api/auth/oauth/discord/start?link=1');
  assert.equal(acc.oauthUrl('google', 'reauth'), '/api/auth/oauth/google/start?reauth=1');
  assert.equal(acc.oauthUrl('google'), '/api/auth/oauth/google/start');
  assert.deepEqual(AC.parseAuthHash('#auth=reauth'), { kind: 'reauth' });
  for (const code of ['provider_set', 'reauth_required', 'reauth_mismatch', 'link_expired']) assert.doesNotMatch(AC.oauthErrorText(code), /^error\.|^auth\.|Couldn't sign in/, code);
});

test('authz-1: a password re-authentication sends the client key with the Bearer and adopts the fresh session; unlink asks the server and reloads the profile', async () => {
  const { acc, calls } = client({
    '/api/auth/refresh': () => res(200, SESSION()),
    '/api/auth/reauth': (body) => (body.password.length === 64 ? res(200, SESSION({ session: 'jwt-fresh', authAt: Date.now() })) : res(400, {})),
    '/api/auth/unlink': () => res(200, { ok: true }),
    '/api/me': () => res(200, { playerId: 'abcdef0123456789', name: 'Ana', providers: ['discord'], hasPassword: false, linkedAt: { discord: 5 } }),
  });
  await acc.restore();
  await acc.reauth('una contraseña');
  const r = calls.find((c) => c.path === '/api/auth/reauth');
  assert.match(r.body.password, /^[0-9a-f]{64}$/, 'never the typed password');
  assert.equal(r.headers.authorization, 'Bearer jwt-ana');
  assert.equal(acc.account.session, 'jwt-fresh');
  assert.equal(acc.fresh(), true);
  await acc.unlink('google');
  assert.deepEqual(calls.find((c) => c.path === '/api/auth/unlink').body, { provider: 'google' });
  assert.deepEqual(acc.me.linkedAt, { discord: 5 });
});
