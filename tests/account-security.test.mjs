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
