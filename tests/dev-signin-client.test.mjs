// The dev-only sign-in on the client (the sign-in design's §3.15): AccountClient asks GET /api/config
// once whether it is open (auth.devSignIn) and signs in with POST /api/dev/signin { name }; PERFIL
// shows ENTRAR (DEV) only from a page served from this machine and only when the config says so.
// The server side: server/test/dev-signin.test.mjs.
//   node --test tests/dev-signin-client.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';

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
    calls.push({ path, method: init.method, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
    const h = handlers[path];
    if (!h) return res(404, { error: 'not_found', message: 'not_found' });
    return h(init.body ? JSON.parse(init.body) : undefined);
  };
  return { fetchFn, calls };
}

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
}

const SESSION = (name) => ({ kind: 'account', playerId: 'abcdef0123456789', name, session: 'jwt-' + name, expiresAt: Date.now() + 3600_000, authAt: Date.now() });

test('devSignInOffered: one GET /api/config per page, true only for auth.devSignIn === true; false when the config fails', async () => {
  const cases = [
    [res(200, { oauth: [], auth: { devSignIn: true } }), true],
    [res(200, { oauth: [], auth: { devSignIn: false } }), false],
    [res(200, { oauth: [], auth: { devSignIn: 'true' } }), false],
    [res(200, { oauth: [] }), false],
    [res(200, null), false],
    [res(500, { error: 'internal' }), false],
  ];
  for (const [answer, want] of cases) {
    const srv = fakeServer({ '/api/config': () => answer });
    const a = new AC.AccountClient({ fetchFn: srv.fetchFn, storage: null });
    assert.equal(await a.devSignInOffered(), want, JSON.stringify(answer));
    assert.equal(await a.devSignInOffered(), want);
    assert.deepEqual(srv.calls.map((c) => [c.method, c.path]), [['GET', '/api/config']], 'asked once');
  }
  const offline = new AC.AccountClient({ fetchFn: async () => { throw new Error('offline'); }, storage: null });
  assert.equal(await offline.devSignInOffered(), false);
  // Nothing asks unless a caller does (a deployed page never spends the request).
  const idle = fakeServer({});
  void new AC.AccountClient({ fetchFn: idle.fetchFn, storage: null });
  assert.deepEqual(idle.calls, []);
});

test('devSignIn: POST /api/dev/signin { name } (trimmed), the session adopted as a sign-in; a refusal is an AccountError with its code', async () => {
  const srv = fakeServer({ '/api/dev/signin': (b) => (b.name === 'Ana' ? res(200, SESSION('Ana')) : res(400, { error: 'bad_name', message: 'Usa de 1 a 32 letras, números, "_" o "-"' })) });
  const storage = memStorage();
  const a = new AC.AccountClient({ fetchFn: srv.fetchFn, storage });
  let changes = 0;
  a.subscribe(() => changes++);
  const s = await a.devSignIn('  Ana ');
  assert.equal(s.name, 'Ana');
  assert.deepEqual(srv.calls[0], { path: '/api/dev/signin', method: 'POST', body: { name: 'Ana' }, headers: { 'content-type': 'application/json' } });
  assert.equal(a.signedIn, true);
  assert.equal(a.account.session, 'jwt-Ana');
  assert.equal(a.hintName, 'Ana');
  assert.ok(changes >= 1);
  await assert.rejects(a.devSignIn('a b'), (e) => e instanceof AC.AccountError && e.code === 'bad_name' && e.status === 400);
  // A closed gate is an unknown route (404).
  const closed = new AC.AccountClient({ fetchFn: fakeServer({}).fetchFn, storage: null });
  await assert.rejects(closed.devSignIn('Ana'), (e) => e instanceof AC.AccountError && e.status === 404);
  assert.equal(closed.signedIn, false);
});

test('PERFIL: ENTRAR (DEV) only from a page on this machine and only when the config says so; a dev-only label outside the locales', () => {
  const src = readFileSync(new URL('../src/ui/screens/profile.ts', import.meta.url), 'utf8');
  const box = /const devBox = \(\): HTMLElement \| null => \{([\s\S]*?)\n {2}\};/.exec(src);
  assert.ok(box, 'devBox');
  const body = box[1];
  assert.ok(body.indexOf('if (!loopbackPage()) return null;') < body.indexOf('acc.devSignInOffered()'), 'a deployed page never asks');
  assert.match(body, /if \(!open \|\| !box\.isConnected\) return;/, 'nothing shows when it is closed');
  assert.match(body, /h\('div\.mn-prof-dev', \{ hidden: true \}\)/, 'hidden until the answer: no grid gap');
  assert.match(body, /await acc\.devSignIn\(name\.input\.value\)/);
  assert.match(src, /h\('div\.mn-prof-form', null, form\),\n\s+devBox\(\),/, 'in the guest view, under the form');
  const loop = /function loopbackPage\(\): boolean \{([\s\S]*?)\n\}/.exec(src);
  assert.ok(loop);
  assert.match(loop[1], /host === 'localhost' \|\| host === '127\.0\.0\.1' \|\| host === '\[::1\]' \|\| host\.endsWith\('\.localhost'\)/);
  for (const loc of ['es', 'en']) assert.doesNotMatch(readFileSync(new URL(`../src/locales/${loc}.ts`, import.meta.url), 'utf8'), /ENTRAR \(DEV\)|devSignIn/, loc);
});
