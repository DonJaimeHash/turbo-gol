// The dev-only sign-in (the sign-in design's §2.12, §3.15 and §8 PR 5): POST /api/dev/signin and
// GET /api/dev/mail behind mail.ts isDevAuth (DEV_AUTH=1, a loopback request host, no Origin or a
// loopback one), in front of a real AccountsDO (node:sqlite). What it holds:
//   - closed, both answer 404 not_found exactly as an unknown route does, reach no AccountsDO and are
//     counted by no limit (a flood on production's host is 404 every time, never 429);
//   - open, a name signs in to the account of that dev identity, made at its first use: an
//     AccountSession and the refresh cookie, its address <name>@dev.invalid verified with proof
//     'dev' (the design's I1), its family at level 2 with method 'dev';
//   - GET /api/config says auth.devSignIn only where the gate passes;
//   - the AccountsDO refuses the path without DEV_AUTH too; no committed file sets DEV_AUTH;
//   - the fixture helper (helpers/accounts.mjs makeAccount) makes accounts without a password.
// 'cloudflare:workers' and MatchDO's wasm are stubbed by the resolve hook. Run from server/: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeAccount } from './helpers/accounts.mjs';

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

const { AccountsDO } = await import('../src/AccountsDO.ts');
const STORE = await import('../src/accountStore.ts');
const LIMITS = await import('../src/limits.ts');
const worker = (await import('../src/index.ts')).default;
const { INTERNAL_HEADER, internalSecret, verifySession } = await import('../src/auth.ts');
const { normalizeEmail } = await import('../../src/net/account.ts');

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(SERVER, '..');
const SECRET = 'dev-signin-test-secret';
const PROD = 'https://turbo-gol.com';
const LOCAL = 'http://127.0.0.1:8787';
const VITE = 'http://localhost:5173';

function sqlOn(db) {
  return {
    exec(query, ...bindings) {
      const stmt = db.prepare(query);
      const rows = /^\s*(SELECT|WITH)/i.test(query) ? stmt.all(...bindings) : (stmt.run(...bindings), []);
      return { toArray: () => rows.map((r) => ({ ...r })) };
    },
  };
}

function txOn(db) {
  return (fn) => {
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };
}

/** A Worker env as production's (VITE_ORIGINS set) with a real AccountsDO; `calls` counts the Worker's calls into it. */
function makeEnv(over = {}) {
  const db = new DatabaseSync(':memory:');
  let alarm = null;
  const env = { JWT_SECRET: SECRET, VITE_ORIGINS: PROD, FLAGS: { get: async () => null }, TURNSTILE_DISABLED: '1', ...over };
  const ctx = {
    storage: { sql: sqlOn(db), transactionSync: txOn(db), getAlarm: async () => alarm, setAlarm: async (t) => void (alarm = t) },
    blockConcurrencyWhile: (fn) => fn(),
  };
  const obj = new AccountsDO(ctx, env);
  const calls = [];
  env.ACCOUNTS = {
    idFromName: (n) => ({ n }),
    get: () => ({
      fetch: (url, init) => {
        calls.push(new URL(url).pathname);
        return obj.fetch(new Request(url, init));
      },
    }),
  };
  return { env, obj, db, calls };
}

let ipBase = 0;
/** An address of its own per call site: the Worker's in-isolate windows are this file's. */
const freshIp = () => `198.51.${(++ipBase >> 8) & 255}.${ipBase & 255}`;

async function call(env, base, path, { method = 'POST', body, origin, ip = freshIp(), token, cookie, type = 'application/json' } = {}) {
  const headers = { 'CF-Connecting-IP': ip };
  if (origin !== undefined) headers.Origin = origin;
  if (body !== undefined) headers['content-type'] = type;
  if (token) headers.authorization = 'Bearer ' + token;
  if (cookie) headers.cookie = cookie;
  const res = await worker.fetch(new Request(base + path, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }), env);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}

const signIn = (env, name, opts = {}) => call(env, LOCAL, '/api/dev/signin', { body: { name }, origin: VITE, ...opts });
const userRow = (db, id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
const refreshRows = (db, id) => db.prepare('SELECT * FROM refresh WHERE user_id = ?').all(id);

/** What a client can see of an answer: the status, the body and the headers a page or a script reads. */
const visible = (r) => ({ status: r.status, text: r.text, type: r.headers.get('content-type'), cors: r.headers.get('access-control-allow-origin'), cookie: r.headers.get('set-cookie') });

// ---- Closed: an unknown route -------------------------------------------------------------------

test('closed: 404 not_found, the answer of an unknown route, without DEV_AUTH, off loopback or from another site; no AccountsDO call', async () => {
  const cases = [
    ['no DEV_AUTH, loopback', {}, LOCAL, VITE],
    ['no DEV_AUTH, loopback, no Origin', {}, LOCAL, undefined],
    ["DEV_AUTH '0'", { DEV_AUTH: '0' }, LOCAL, VITE],
    ["DEV_AUTH 'true'", { DEV_AUTH: 'true' }, LOCAL, VITE],
    ["DEV_AUTH ' 1'", { DEV_AUTH: ' 1' }, LOCAL, undefined],
    ["DEV_AUTH '1' on production's host", { DEV_AUTH: '1' }, PROD, PROD],
    ["DEV_AUTH '1' on production's host, no Origin", { DEV_AUTH: '1' }, PROD, undefined],
    ["DEV_AUTH '1' on production's host, a loopback Origin", { DEV_AUTH: '1' }, PROD, VITE],
    ["DEV_AUTH '1' on a fork's own host", { DEV_AUTH: '1' }, 'https://fork.example', 'https://fork.example'],
    ["DEV_AUTH '1', loopback, another site's page", { DEV_AUTH: '1' }, LOCAL, 'https://evil.example'],
    ["DEV_AUTH '1', loopback, a sandboxed page (Origin null)", { DEV_AUTH: '1' }, LOCAL, 'null'],
    ["DEV_AUTH '1', loopback, a page on the LAN's address", { DEV_AUTH: '1' }, LOCAL, 'http://192.168.1.20:5173'],
  ];
  for (const [what, over, base, origin] of cases) {
    const { env, calls } = makeEnv(over);
    const unknown = await call(env, base, '/api/no-such-route', { body: { name: 'ana' }, origin });
    assert.equal(unknown.status, 404, what);
    for (const [method, path, body] of [['POST', '/api/dev/signin', { name: 'ana' }], ['GET', '/api/dev/mail', undefined], ['POST', '/api/dev/mail', {}], ['GET', '/api/dev/signin', undefined], ['POST', '/api/dev/other', {}]]) {
      const r = await call(env, base, path, { method, body, origin });
      assert.deepEqual(visible(r), visible(unknown), `${what}: ${method} ${path}`);
      assert.deepEqual(r.json, { error: 'not_found', message: 'not_found' });
    }
    assert.deepEqual(calls, [], `${what}: the AccountsDO is never asked`);
  }
});

test("closed: never counted by a limit, so a flood on production's host is 404 every time (never a 429 that says the route is there)", async () => {
  const refusing = { keys: [], async limit({ key }) { this.keys.push(key); return { success: false }; } };
  const { env, calls } = makeEnv({ DEV_AUTH: '1', RL_120: refusing });
  const ip = freshIp();
  for (let i = 0; i < 300; i++) {
    const r = await call(env, PROD, '/api/dev/signin', { body: { name: 'ana' }, origin: PROD, ip });
    assert.equal(r.status, 404, `request ${i + 1}`);
  }
  assert.deepEqual(refusing.keys, [], 'the binding is never asked');
  assert.deepEqual(calls, []);
});

// ---- Open: loopback with DEV_AUTH=1 ---------------------------------------------------------------

test('open on loopback: 200, an AccountSession and the refresh cookie; the account satisfies I1 (name@dev.invalid, verified, proof dev)', async () => {
  const { env, db } = makeEnv({ DEV_AUTH: '1' });
  const t0 = Date.now();
  const r = await signIn(env, 'Ana');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.kind, 'account');
  assert.equal(r.json.name, 'Ana', 'a valid free name is the username');
  assert.match(r.json.playerId, /^[0-9a-f]{16}$/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const cookies = r.headers.getSetCookie();
  assert.equal(cookies.length, 1, 'the refresh cookie only: no device cookie, no password was typed');
  assert.match(cookies[0], /^__Host-tg_rt=[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000$/);
  // The session: an account's, and this device proved a credential just now.
  const claims = await verifySession(SECRET, r.json.session);
  assert.equal(claims.acct, 1);
  assert.equal(claims.sub, r.json.playerId);
  assert.ok(claims.aat * 1000 >= t0 - 1000, 'aat: now');
  assert.ok(r.json.authAt >= t0 - 1000);
  // I1: the address is the dev identity's own, proved by the dev sign-in, never a typed one.
  const u = userRow(db, r.json.playerId);
  assert.equal(u.dev_sub, 'ana');
  assert.equal(u.email, 'ana@dev.invalid');
  assert.equal(u.email_canon, 'ana@dev.invalid');
  assert.equal(u.email_proof, 'dev');
  assert.ok(u.email_verified_at >= t0);
  assert.equal(u.pw_hash, null, 'no password');
  assert.equal(u.pw_v, 0);
  assert.equal(u.google_sub, null);
  assert.equal(u.discord_id, null);
  assert.equal(normalizeEmail(u.email), null, 'an address no flow of the game can mail (RFC 2606 .invalid)');
  // The family: level 2, method dev (the design's R6), a browser's.
  const [rt] = refreshRows(db, r.json.playerId);
  assert.equal(rt.auth_lvl, 2);
  assert.equal(rt.method, 'dev');
  assert.equal(rt.kind, 'web');
  assert.ok(rt.auth_at >= t0);
  // /api/me shows the verified address; the refresh cookie is a real session.
  const me = await call(env, LOCAL, '/api/me', { method: 'GET', token: r.json.session, origin: VITE });
  assert.equal(me.status, 200);
  assert.equal(me.json.email, 'ana@dev.invalid');
  assert.equal(me.json.emailVerified, true);
  assert.equal(me.json.hasPassword, false);
  const again = await call(env, LOCAL, '/api/auth/refresh', { body: {}, origin: VITE, cookie: cookies[0].split(';')[0] });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json.playerId, r.json.playerId);
});

test('open: no Origin (a curl or an agent on this machine) and any loopback page pass; localhost and [::1] are loopback hosts too', async () => {
  const { env } = makeEnv({ DEV_AUTH: '1' });
  for (const [base, origin] of [[LOCAL, undefined], [LOCAL, 'http://127.0.0.1:5510'], ['http://localhost:9010', 'http://localhost:5173'], ['http://[::1]:8787', undefined], ['http://tg.localhost:8787', 'http://tg.localhost:5173']]) {
    const r = await call(env, base, '/api/dev/signin', { body: { name: 'beto' }, origin });
    assert.equal(r.status, 200, `${base} ${origin}: ${r.text}`);
  }
});

test('open: the same name (any case) is the same account; a name that is no free username gets Dev and digits; a bad name is 400 before the object', async () => {
  const { env, db, obj, calls } = makeEnv({ DEV_AUTH: '1' });
  const a = await signIn(env, 'Ana');
  const b = await signIn(env, '  ANA ');
  assert.equal(b.status, 200);
  assert.equal(b.json.playerId, a.json.playerId, 'one dev identity, one account');
  assert.equal(b.json.name, 'Ana');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE dev_sub = 'ana'").get().n, 1);
  assert.equal(refreshRows(db, a.json.playerId).length, 2, 'a family per sign-in');
  // Not a username (too short, reserved, a guest's or a bot's prefix) or taken by another account.
  makeAccount(obj.store, 'Caro');
  for (const name of ['ab', 'x', 'admin', 'Guest7', 'invitado_1', 'bot-9', 'caro']) {
    const r = await signIn(env, name);
    assert.equal(r.status, 200, name);
    assert.match(r.json.name, /^Dev\d+$/, name);
    const u = userRow(db, r.json.playerId);
    assert.equal(u.dev_sub, name.toLowerCase());
    assert.equal(u.email, name.toLowerCase() + '@dev.invalid');
  }
  // A bad name: no AccountsDO call at all.
  const before = calls.length;
  for (const name of ['', '   ', 'a b', 'a+b', 'a@b', 'a.b', '-ab', '_ab', 'ñandu', 'x'.repeat(33), 42, null, undefined]) {
    const r = await signIn(env, name);
    assert.equal(r.status, 400, JSON.stringify(name));
    assert.equal(r.json.error, 'bad_name');
    assert.equal(r.headers.get('set-cookie'), null);
  }
  assert.equal((await call(env, LOCAL, '/api/dev/signin', { body: 'not json', origin: VITE })).json.error, 'bad_name');
  const form = await call(env, LOCAL, '/api/dev/signin', { body: 'name=ana', origin: VITE, type: 'application/x-www-form-urlencoded' });
  assert.equal(form.status, 415, 'JSON only, as every sign-in');
  assert.equal(calls.length, before);
  // 32 characters is the longest name.
  assert.equal((await signIn(env, 'a'.repeat(32))).status, 200);
});

test('open: a suspended dev account is refused (403 banned, no cookie)', async () => {
  const { env, db } = makeEnv({ DEV_AUTH: '1' });
  const a = await signIn(env, 'dani');
  db.prepare('UPDATE users SET banned = 1 WHERE id = ?').run(a.json.playerId);
  const r = await signIn(env, 'dani');
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'banned');
  assert.equal(r.headers.get('set-cookie'), null);
});

test('the AccountsDO refuses /dev-signin as an unknown path wherever DEV_AUTH is not 1, even with the internal header', async () => {
  const header = { [INTERNAL_HEADER]: await internalSecret(SECRET), 'content-type': 'application/json' };
  const body = JSON.stringify({ name: 'eva', refresh: 'e'.repeat(64) });
  for (const over of [{}, { DEV_AUTH: '0' }, { DEV_AUTH: 'yes' }]) {
    const { obj, db } = makeEnv(over);
    const r = await obj.fetch(new Request('https://accounts/dev-signin', { method: 'POST', headers: header, body }));
    assert.equal(r.status, 404, JSON.stringify(over));
    assert.deepEqual(await r.json(), { error: 'not_found', message: 'not_found' });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
  }
  const { obj } = makeEnv({ DEV_AUTH: '1' });
  const ok = await obj.fetch(new Request('https://accounts/dev-signin', { method: 'POST', headers: header, body }));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).created, true);
  assert.equal((await obj.fetch(new Request('https://accounts/dev-signin', { method: 'POST', headers: { 'content-type': 'application/json' }, body }))).status, 403, 'without the internal header: forbidden, as every path');
});

// ---- Configuration, the outbox, the limits -----------------------------------------------------------

test('GET /api/config: auth.devSignIn is true only where the gate passes', async () => {
  const cases = [
    [{ DEV_AUTH: '1' }, LOCAL, undefined, true],
    [{ DEV_AUTH: '1' }, LOCAL, VITE, true],
    [{}, LOCAL, VITE, false],
    [{ DEV_AUTH: 'true' }, LOCAL, undefined, false],
    [{ DEV_AUTH: '1' }, PROD, undefined, false],
    [{ DEV_AUTH: '1' }, PROD, VITE, false],
    [{ DEV_AUTH: '1' }, LOCAL, 'https://evil.example', false],
    [{}, PROD, PROD, false],
  ];
  for (const [over, base, origin, want] of cases) {
    const { env } = makeEnv(over);
    const r = await call(env, base, '/api/config', { method: 'GET', origin });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.auth, { devSignIn: want }, `${JSON.stringify(over)} ${base} ${origin}`);
  }
});

test('GET /api/dev/mail: mounted behind the same gate, the stub outbox newest first', async () => {
  const { env } = makeEnv({ DEV_AUTH: '1' });
  const r = await call(env, LOCAL, '/api/dev/mail', { method: 'GET', origin: VITE });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.ok(Array.isArray(r.json.messages));
  assert.equal((await call(env, LOCAL, '/api/dev/mail', { method: 'GET' })).status, 200, 'no Origin');
  assert.equal((await call(env, PROD, '/api/dev/mail', { method: 'GET' })).status, 404);
});

test("limits: the dev routes' rule (accountGate), counted per network only while the gate is open", async () => {
  assert.deepEqual(LIMITS.accountGate('POST', '/api/dev/signin'), ['dev']);
  assert.deepEqual(LIMITS.accountGate('GET', '/api/dev/mail'), ['dev']);
  assert.deepEqual(LIMITS.accountGate('GET', '/api/dev/signin'), [], 'by method');
  assert.deepEqual(LIMITS.LIMITS.dev, { by: 'network', isolate: 120, edge: 'RL_120' });
  const refusing = { keys: [], async limit({ key }) { this.keys.push(key); return { success: false }; } };
  const { env, calls } = makeEnv({ DEV_AUTH: '1', RL_120: refusing });
  const ip = freshIp();
  const r = await signIn(env, 'ana', { ip });
  assert.equal(r.status, 429);
  assert.equal(r.json.error, 'rate_limited');
  assert.deepEqual(refusing.keys, ['dev:' + ip]);
  assert.deepEqual(calls, [], 'refused before the object');
  // Under it, a developer signs in as often as they like (the in-isolate window is 120 a minute).
  const { env: env2 } = makeEnv({ DEV_AUTH: '1' });
  const ip2 = freshIp();
  for (let i = 0; i < 20; i++) assert.equal((await signIn(env2, 'u' + i, { ip: ip2 })).status, 200);
});

// ---- The store, the fixture helper, the DEV form, the committed config ---------------------------

function makeStore() {
  const db = new DatabaseSync(':memory:');
  const store = new STORE.AccountStore(sqlOn(db), txOn(db));
  store.migrate();
  return { store, db };
}

test('AccountStore.devSignIn: made once, reused after; another account loses its hint of that address; the store checks the name too', () => {
  const { store, db } = makeStore();
  const NOW = 1_800_000_000_000;
  const a = store.devSignIn('Ana', 'a'.repeat(64), NOW);
  assert.equal(a.created, true);
  assert.equal(a.authAt, NOW);
  const b = store.devSignIn('ana', 'b'.repeat(64), NOW + 1);
  assert.equal(b.created, false);
  assert.equal(b.userId, a.userId);
  assert.equal(userRow(db, a.userId).last_login, NOW + 1);
  for (const bad of ['', 'a b', 'a@b.c', 'x'.repeat(33)]) assert.equal(store.devSignIn(bad, 'c'.repeat(64), NOW), 'bad_name', bad);
  // A hint is never left pointing at a claimed canon (the design's §1.1); a hand-edited one is cleared.
  const other = makeAccount(store, 'Beto', { provider: 'discord', now: NOW }).userId;
  db.prepare("UPDATE users SET email_hint = 'carla@dev.invalid', email_hint_canon = 'carla@dev.invalid', email_hint_from = 'discord' WHERE id = ?").run(other);
  store.devSignIn('carla', 'd'.repeat(64), NOW);
  assert.equal(userRow(db, other).email_hint_canon, null);
  // Another account holding the address (only a database edited by hand could): refused, nothing made.
  db.prepare("UPDATE users SET email = 'eva@dev.invalid', email_canon = 'eva@dev.invalid' WHERE id = ?").run(other);
  assert.equal(store.devSignIn('eva', 'e'.repeat(64), NOW), 'taken');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE dev_sub = 'eva'").get().n, 0);
  assert.equal(STORE.devSubOf('  Ana '), 'ana');
  assert.equal(STORE.DEV_EMAIL_DOMAIN, 'dev.invalid');
});

test('makeAccount (helpers/accounts.mjs): an account through a provider, no password; a verified email on request; a taken name throws', () => {
  const { store } = makeStore();
  const NOW = 1_800_000_000_000;
  const a = makeAccount(store, 'Ana', { now: NOW });
  assert.equal(a.created, true);
  assert.equal(a.createdAt, NOW);
  const me = store.me(a.userId, NOW);
  assert.deepEqual(me.providers, ['google']);
  assert.equal(me.hasPassword, false);
  assert.equal(me.email, null);
  const b = makeAccount(store, 'Beto', { provider: 'discord', email: 'Beto.R+tg@Example.org', now: NOW });
  const meB = store.me(b.userId, NOW);
  assert.deepEqual(meB.providers, ['discord']);
  assert.equal(meB.email, 'beto.r+tg@example.org');
  assert.equal(meB.emailVerified, true);
  assert.throws(() => makeAccount(store, 'ana'), /makeAccount\(ana\)/, 'the username is taken (case-insensitive)');
  assert.throws(() => makeAccount(store, 'Ana', { provider: 'password' }), /provider/);
  assert.throws(() => makeAccount(store, 'Caro', { email: 'beto.r@example.org' }), /email taken/);
});

test("the DEV form's name rule is the server's, and PERFIL asks for it only from a page on this machine", () => {
  const src = readFileSync(join(ROOT, 'src', 'ui', 'screens', 'profile.ts'), 'utf8');
  const m = /const DEV_NAME = (\/.+\/);/.exec(src);
  assert.ok(m, 'profile.ts DEV_NAME');
  assert.equal(m[1], String(STORE.DEV_NAME_RE));
  assert.match(src, /if \(!loopbackPage\(\)\) return null;/);
  assert.match(src, /acc\.devSignInOffered\(\)\.then\(/);
  assert.match(src, /secondary\('ENTRAR \(DEV\)'/);
});

/** wrangler.jsonc without its comments and trailing commas. */
function readJsonc(file) {
  const s = readFileSync(file, 'utf8');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      out += s.slice(i, j + 1);
      i = j;
    } else if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && s[i + 1] === '*') {
      i = s.indexOf('*/', i + 2) + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** A file that sets DEV_AUTH to a value: `DEV_AUTH=1`, `DEV_AUTH: '1'`, `"DEV_AUTH": "1"`, `--var DEV_AUTH:1`, `export DEV_AUTH=...`. */
const SETS_DEV_AUTH = /\bDEV_AUTH["']?\s*[:=](?!=)/;

/** A file's text without its comments: a comment may say how to set it in your own .dev.vars; only what runs or configures counts. */
function codeOf(file, text) {
  if (/\.(m?[jt]s|cjs|jsonc)$/i.test(file)) return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
  if (/\.html$/i.test(file)) return text.replace(/<!--[\s\S]*?-->/g, '');
  return text.replace(/^\s*(#|::|rem\b).*$/gim, ''); // yml, toml, sh, ps1, cmd, .env, .dev.vars, .example: a commented line sets nothing
}

test('no committed file sets DEV_AUTH: not wrangler.jsonc (any vars scope), nor any config, script or workflow (only your own .dev.vars)', () => {
  const cfg = readJsonc(join(SERVER, 'wrangler.jsonc'));
  const scopes = [['vars', cfg.vars ?? {}], ...Object.entries(cfg.env ?? {}).map(([n, e]) => [`env.${n}.vars`, e.vars ?? {}])];
  for (const [where, vars] of scopes) assert.ok(!('DEV_AUTH' in vars), `wrangler.jsonc ${where}.DEV_AUTH`);
  assert.doesNotMatch(JSON.stringify(cfg), /DEV_AUTH/, 'nowhere in wrangler.jsonc (define, vars, an env)');
  let files;
  try {
    files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    files = ['server/wrangler.jsonc', 'server/.dev.vars.example', 'package.json', 'server/package.json', '.github/workflows/ci.yml'].filter((f) => existsSync(join(ROOT, f))); // a tarball without git
  }
  // Docs say how to set it in your own .dev.vars; tests build envs with it. Everything else may only read it.
  const scanned = files.filter((f) => !/\.md$/i.test(f) && !/^(server\/test|tests|nodes\/test)\//.test(f) && /(\.(json|jsonc|toml|ya?ml|mjs|cjs|js|ts|sh|ps1|cmd|bat|html|example|txt)|(^|\/)\.(dev\.vars|env)[^/]*)$/i.test(f));
  assert.ok(scanned.includes('server/wrangler.jsonc') && scanned.includes('server/src/mail.ts'), 'the scan covers the config and the sources');
  const hits = scanned.filter((f) => existsSync(join(ROOT, f)) && SETS_DEV_AUTH.test(codeOf(f, readFileSync(join(ROOT, f), 'utf8'))));
  assert.deepEqual(hits, []);
  // The pattern: what sets it, and what only reads it.
  for (const s of ['DEV_AUTH=1', "DEV_AUTH: '1'", '"DEV_AUTH": "1"', '--var DEV_AUTH:1', 'export DEV_AUTH=1', 'env.DEV_AUTH = "1"']) assert.match(s, SETS_DEV_AUTH, s);
  for (const s of ["env.DEV_AUTH !== '1'", "env.DEV_AUTH === '1'", 'DEV_AUTH?: string;', "Pick<Env, 'DEV_AUTH'>"]) assert.doesNotMatch(s, SETS_DEV_AUTH, s);
  // A comment is no setting; code after one, or beside a URL, still counts.
  assert.doesNotMatch(codeOf('a.ts', '// put DEV_AUTH=1 in your .dev.vars\n/* DEV_AUTH=1 */ const x = 1;'), SETS_DEV_AUTH);
  assert.match(codeOf('a.ts', "const u = 'http://x'; env.DEV_AUTH = '1';"), SETS_DEV_AUTH);
  assert.doesNotMatch(codeOf('ci.yml', '  # DEV_AUTH: 1'), SETS_DEV_AUTH);
  assert.match(codeOf('ci.yml', '  env:\n    DEV_AUTH: 1 # for the smoke'), SETS_DEV_AUTH);
  assert.match(codeOf('server/.dev.vars.example', 'JWT_SECRET=x\nDEV_AUTH=1'), SETS_DEV_AUTH);
});
