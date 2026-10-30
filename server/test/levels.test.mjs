// Sign-in PR 4 (the design's section 8, "levels and legacy hardening"; audit auth-5, cost-10, auth-11):
// the legacy sign-in re-keys a password of before to the current key, the server stage is peppered,
// the sign-in throttles are durable, every anonymous sign-in has Turnstile and one answer, and each
// session carries the level of its proof (R6). Through the real Worker (index.ts) in front of a real
// AccountsDO on node:sqlite, as takeover.test.mjs runs them; OAuth against a fake provider (nothing
// leaves this machine). Run from server/: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

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

// ---- the fake providers and Turnstile ------------------------------------------------------------
const identity = { google: { sub: 'g-default', given_name: 'Ana' }, discord: { id: 'd-default', username: 'ana' } };
globalThis.fetch = async (url, init) => {
  const u = String(url instanceof Request ? url.url : url);
  const ok = (b) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });
  if (u === 'https://oauth2.googleapis.com/token' || u === 'https://discord.com/api/v10/oauth2/token') return ok({ access_token: 'fake-access' });
  if (u === 'https://openidconnect.googleapis.com/v1/userinfo') return ok(identity.google);
  if (u === 'https://discord.com/api/v10/users/@me') return ok(identity.discord);
  if (u === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
    const body = new URLSearchParams(await new Response(init?.body).text());
    return ok({ success: body.get('response') === 'good-token' });
  }
  throw new Error('BLOCKED network call in a test: ' + u);
};

const { AccountsDO, LOGIN_NET4_MAX, LOGIN_NET6_MAX, LOGIN_NET_PAUSE_MS } = await import('../src/AccountsDO.ts');
const A = await import('../src/accountRoutes.ts');
const AUTH = await import('../src/auth.ts');
const ACC = await import('../../src/net/account.ts');
const worker = (await import('../src/index.ts')).default;

const SECRET = 'levels-test-secret';
const ORIGIN = 'https://turbo-gol.com';
/** A throwaway pepper of the real secret's shape (32 random bytes as hex). */
const PEPPER = 'a1b2c3d4'.repeat(8);
const TURNSTILE_ON = { TURNSTILE_DISABLED: '0', TURNSTILE_SECRET: 'ts-secret', TURNSTILE_SITEKEY: 'ts-site' };
const TOK = { turnstileToken: 'good-token' };

// One typed password and its two client keys (src/net/account.ts), derived once.
const PW = 'una contraseña larga';
const keysOf = async (name, pw = PW) => ({ v1: await ACC.legacyPasswordKey(name, pw), v2: await ACC.passwordKey(pw) });
const WRONG = 'e'.repeat(64);
const H = (c) => c.repeat(64);

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
  let depth = 0;
  return (fn) => {
    if (depth > 0) return fn();
    depth++;
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    } finally {
      depth--;
    }
  };
}

/** A fresh AccountsDO on `db` (a restart when `db` already holds one's data), wired as env.ACCOUNTS; `calls` counts what reaches it. */
function attach(env, db) {
  let alarm = null;
  const ctx = {
    storage: { sql: sqlOn(db), transactionSync: txOn(db), getAlarm: async () => alarm, setAlarm: async (t) => void (alarm = t) },
    blockConcurrencyWhile: (fn) => fn(),
  };
  const obj = new AccountsDO(ctx, env);
  const calls = [];
  env.ACCOUNTS = { idFromName: (n) => ({ n }), get: () => ({ fetch: (url, init) => (calls.push(new URL(url).pathname), obj.fetch(new Request(url, init))) }) };
  return { obj, calls };
}

function makeEnv(extra = {}) {
  const db = new DatabaseSync(':memory:');
  const env = {
    JWT_SECRET: SECRET,
    VITE_ORIGINS: ORIGIN,
    FLAGS: { get: async () => null },
    GOOGLE_CLIENT_ID: 'gid',
    GOOGLE_CLIENT_SECRET: 'gsec',
    DISCORD_CLIENT_ID: 'did',
    DISCORD_CLIENT_SECRET: 'dsec',
    TURNSTILE_DISABLED: '1',
    ...extra,
  };
  const { obj, calls } = attach(env, db);
  return { env, obj, db, calls };
}

let ipBase = 0;
const ips = () => {
  const base = ++ipBase;
  return (i = 0) => `198.19.${base}.${i + 1}`;
};

const setCookies = (r) => (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean));
const cookieOf = (r, name) => {
  for (const c of setCookies(r)) {
    const m = new RegExp('^' + name + '=([^;]*)').exec(c ?? '');
    if (m) return m[1];
  }
  return null;
};

async function req(env, method, path, { ip = '198.19.0.1', origin = ORIGIN, bearer, cookie, body } = {}) {
  const headers = { 'CF-Connecting-IP': ip };
  if (origin !== null) headers.Origin = origin;
  if (bearer) headers.authorization = 'Bearer ' + bearer;
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, headers: res.headers, json, location: res.headers.get('location'), raw: res };
}
const post = (env, path, o = {}) => req(env, 'POST', path, { body: {}, ...o });
const login = (env, body, ip, cookie) => post(env, '/api/auth/login', { ip, cookie, body });

async function oauth(env, provider, who, { query = '', cookie, ip = '198.19.201.1' } = {}) {
  identity[provider] = provider === 'google' ? { sub: who, given_name: 'Ana' } : { id: who, username: who };
  const start = await req(env, 'GET', `/api/auth/oauth/${provider}/start${query}`, { ip, cookie, origin: null });
  if (start.status !== 302 || !start.location.startsWith('https://')) return { start, done: null };
  const state = cookieOf(start.raw, '__Host-tg_oa');
  const nonce = new URL(start.location).searchParams.get('state');
  const done = await req(env, 'GET', `/api/auth/oauth/${provider}/callback?code=x&state=${nonce}`, { ip, cookie: '__Host-tg_oa=' + state, origin: null });
  return { start, done, rt: cookieOf(done.raw, '__Host-tg_rt') };
}

async function refresh(env, rt, ip = '198.19.202.1') {
  const r = await post(env, '/api/auth/refresh', { ip, cookie: '__Host-tg_rt=' + rt });
  return { ...r, rt: cookieOf(r.raw, '__Host-tg_rt') };
}

const claims = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
const row = (obj, id) => obj.store.sql.exec('SELECT * FROM users WHERE id = ?', id).toArray()[0];
/** A legacy account (users.pw_v 1, the key salted with its name), as every production password is today. */
async function legacyAccount(obj, name, extra = {}) {
  const k = await keysOf(name);
  const id = obj.store.register(name, await A.newPasswordRecord(k.v1, 1, extra), [], H(String(name.length % 10)), Date.now()).userId;
  return { id, ...k };
}

// ---- the legacy sign-in: the re-key -------------------------------------------------------------

test('legacy login: a pw_v 1 sign-in stores the current key (pw_v 2) in its transaction, and the next sign-in is checked with it', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const ana = await legacyAccount(obj, 'Ana');
  const before = row(obj, ana.id);
  assert.equal(before.pw_v, 1);
  const r = await login(env, { username: 'Ana', password: ana.v1, passwordV2: ana.v2 }, ip(0));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const after = row(obj, ana.id);
  assert.equal(after.pw_v, 2, 're-keyed');
  assert.notEqual(after.pw_hash, before.pw_hash);
  assert.notEqual(after.pw_salt, before.pw_salt, 'a new salt with it');
  assert.equal(after.pw_iter, A.SERVER_KDF_ITERATIONS);
  // From now on the current key is what counts: the legacy key alone no longer signs in, whatever comes with it.
  assert.equal((await login(env, { username: 'Ana', password: ana.v1 }, ip(1))).status, 401, 'a legacy key alone (a page of before)');
  assert.equal((await login(env, { username: 'Ana', password: ana.v1, passwordV2: WRONG }, ip(2))).status, 401);
  assert.equal((await login(env, { username: 'Ana', password: WRONG, passwordV2: ana.v2 }, ip(3))).status, 200, 'the legacy key is not even read');
  // A cookie-restored player of before re-keys with "confirm it's you"; a page of before (one key) re-keys nothing.
  const beto = await legacyAccount(obj, 'Beto');
  obj.store.addRefresh(beto.id, await A.sha256Hex('x'.repeat(43)), Date.now());
  const s = await refresh(env, 'x'.repeat(43), ip(4));
  assert.equal(s.status, 200);
  const old = await post(env, '/api/auth/reauth', { ip: ip(4), bearer: s.json.session, cookie: '__Host-tg_rt=' + s.rt, body: { password: beto.v1 } });
  assert.equal(old.status, 200, 'a page of before still confirms with its legacy key');
  assert.equal(row(obj, beto.id).pw_v, 1, 'and re-keys nothing: alone, its key may be the legacy one');
  const re = await post(env, '/api/auth/reauth', { ip: ip(4), bearer: s.json.session, cookie: '__Host-tg_rt=' + s.rt, body: { legacy: beto.v1, password: beto.v2 } });
  assert.equal(re.status, 200, JSON.stringify(re.json));
  assert.equal(claims(re.json.session).aal, 2);
  assert.equal(row(obj, beto.id).pw_v, 2, 'both keys: re-keyed');
  assert.equal((await login(env, { username: 'Beto', password: WRONG, passwordV2: beto.v2 }, ip(5))).status, 200);
});

test('legacy login: a wrong legacy key changes nothing; the rename and the password change of a legacy account re-key it (no name salts the current key)', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const ana = await legacyAccount(obj, 'Ana');
  const before = row(obj, ana.id);
  const bad = await login(env, { username: 'Ana', password: WRONG, passwordV2: ana.v2 }, ip(0));
  assert.deepEqual([bad.status, bad.json.error], [401, 'bad_credentials']);
  const after = row(obj, ana.id);
  assert.deepEqual([after.pw_v, after.pw_hash, after.pw_salt, after.pw_kid], [before.pw_v, before.pw_hash, before.pw_salt, before.pw_kid], 'nothing stored');
  // A rename proves the old name's legacy key and stores the current key: the new name signs in with it.
  const s = await login(env, { username: 'Ana', password: ana.v1 }, ip(1));
  assert.equal(row(obj, ana.id).pw_v, 1, 'one key: no re-key');
  const ren = await post(env, '/api/me/username', { ip: ip(1), bearer: s.json.session, cookie: '__Host-tg_rt=' + cookieOf(s.raw, '__Host-tg_rt'), body: { username: 'Anabel', password: ana.v1, passwordV2: ana.v2 } });
  assert.equal(ren.status, 200, JSON.stringify(ren.json));
  assert.equal(row(obj, ana.id).pw_v, 2);
  assert.equal((await login(env, { username: 'Anabel', password: WRONG, passwordV2: ana.v2 }, ip(2))).status, 200, 'the same password, under the new name');
  // A password change proves the old one by its current key and stores the new one as current.
  const next = await ACC.passwordKey('otra clave larga');
  const s2 = await login(env, { username: 'Anabel', password: WRONG, passwordV2: ana.v2 }, ip(3));
  const ch = await post(env, '/api/auth/password', { ip: ip(3), bearer: s2.json.session, cookie: '__Host-tg_rt=' + cookieOf(s2.raw, '__Host-tg_rt'), body: { oldPassword: WRONG, oldPasswordV2: ana.v2, passwordV2: next } });
  assert.equal(ch.status, 200, JSON.stringify(ch.json));
  assert.equal(row(obj, ana.id).pw_v, 2);
  assert.equal((await login(env, { username: 'Anabel', password: WRONG, passwordV2: next }, ip(4))).status, 200);
});

// ---- the pepper ---------------------------------------------------------------------------------

test('pepper: with PASSWORD_PEPPER a record is written with pw_kid p1, and a copy of the database without the pepper checks nothing', async () => {
  const { env, obj } = makeEnv({ PASSWORD_PEPPER: PEPPER });
  const ip = ips();
  const k = await keysOf('Pepa');
  const r = await post(env, '/api/auth/register', { ip: ip(0), body: { username: 'Pepa', passwordV2: k.v2 } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const u = row(obj, r.json.playerId);
  assert.deepEqual([u.pw_v, u.pw_kid], [2, 'p1']);
  const cred = obj.store.credentials('Pepa');
  assert.equal(await A.verifyPassword(k.v2, cred, { PASSWORD_PEPPER: PEPPER }), true);
  assert.equal(await A.verifyPassword(k.v2, cred, {}), false, 'without the pepper the hash cannot be tested');
  assert.notEqual(await A.serverHash(k.v2, u.pw_salt, u.pw_iter), u.pw_hash, 'it is not the plain PBKDF2 of the key');
  // A deployment that lost the secret refuses that record, and never re-hashes it without the pepper.
  const lost = { ...env, PASSWORD_PEPPER: undefined };
  const no = await login(lost, { username: 'Pepa', password: WRONG, passwordV2: k.v2 }, ip(1));
  assert.deepEqual([no.status, no.json.error], [401, 'bad_credentials']);
  assert.deepEqual([row(obj, r.json.playerId).pw_kid, row(obj, r.json.playerId).pw_hash], ['p1', u.pw_hash]);
  // A pepper shorter than 32 characters is not taken.
  assert.equal(A.currentKid({ PASSWORD_PEPPER: 'short' }), '');
  assert.equal(A.currentKid({ PASSWORD_PEPPER: PEPPER }), 'p1');
  assert.equal(A.currentKid({}), '');
});

test('pepper: a record of before it (pw_kid \'\') is re-hashed at its next sign-in, a legacy one re-keyed too; nothing before that changes', async () => {
  const k = await keysOf('Rita');
  // Production today: no pepper. The records are written with pw_kid ''.
  const { env, obj } = makeEnv();
  const ip = ips();
  const rita = obj.store.register('Rita', await A.newPasswordRecord(k.v2, 2), [], H('1'), Date.now()).userId;
  const leo = await legacyAccount(obj, 'Leo');
  assert.equal((await login(env, { username: 'Rita', password: WRONG, passwordV2: k.v2 }, ip(0))).status, 200);
  assert.equal(row(obj, rita).pw_kid, '', 'without the secret nothing is re-hashed');
  // The owner sets PASSWORD_PEPPER: each record moves to it at its own next sign-in.
  env.PASSWORD_PEPPER = PEPPER;
  const before = row(obj, rita);
  assert.equal((await login(env, { username: 'Rita', password: WRONG, passwordV2: k.v2 }, ip(1))).status, 200);
  const after = row(obj, rita);
  assert.deepEqual([after.pw_v, after.pw_kid], [2, 'p1']);
  assert.notEqual(after.pw_hash, before.pw_hash);
  assert.equal((await login(env, { username: 'Rita', password: WRONG, passwordV2: k.v2 }, ip(2))).status, 200, 'and checks with it next time');
  assert.equal(row(obj, rita).pw_hash, after.pw_hash, 'once');
  assert.equal(row(obj, leo.id).pw_kid, '', 'an account that has not signed in keeps its record');
  assert.equal((await login(env, { username: 'Leo', password: leo.v1, passwordV2: leo.v2 }, ip(3))).status, 200);
  assert.deepEqual([row(obj, leo.id).pw_v, row(obj, leo.id).pw_kid], [2, 'p1'], 'a legacy record: re-keyed and peppered in one step');
});

test('pepper: the dummy stage (an unknown username, an account without a password, a wrong one) runs exactly a real record\'s stage: one HMAC of the key with the pepper, one PBKDF2 at 100,000 over 16 bytes', async () => {
  const { env, obj } = makeEnv({ PASSWORD_PEPPER: PEPPER });
  const ip = ips();
  const k = await keysOf('Real');
  obj.store.register('Real', await A.newPasswordRecord(k.v2, 2, env), [], H('1'), Date.now());
  const o = await oauth(env, 'discord', 'd-solo', { ip: ip(9) });
  const oauthName = (await refresh(env, o.rt, ip(9))).json.name;
  const stored = obj.store.credentials('Real');
  assert.deepEqual([stored.iter, stored.salt.length / 2], [A.SERVER_KDF_ITERATIONS, 16], "a real record's parameters");
  const subtle = crypto.subtle;
  const [derive, sign] = [subtle.deriveBits, subtle.sign];
  const hex = (b) => Buffer.from(b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength)).toString('hex');
  let seen = [];
  subtle.deriveBits = async function (alg, key, len) {
    if (alg.name === 'PBKDF2') seen.push(`pbkdf2:${alg.iterations}:${new Uint8Array(alg.salt).byteLength}`);
    return derive.call(this, alg, key, len);
  };
  subtle.sign = async function (alg, key, data) {
    if (hex(data) === WRONG) seen.push('hmac(key)');
    return sign.call(this, alg, key, data);
  };
  try {
    const stage = async (username) => {
      seen = [];
      const r = await login(env, { username, password: WRONG, passwordV2: WRONG }, ip(seen.length));
      assert.deepEqual([r.status, r.json.error], [401, 'bad_credentials'], username);
      return seen.filter((s) => s !== 'pbkdf2:200000:0');
    };
    const real = await stage('Real');
    assert.deepEqual(real, ['hmac(key)', 'pbkdf2:100000:16'], 'a wrong password on a real record');
    assert.deepEqual(await stage('nadie-existe'), real, 'an unknown username');
    assert.deepEqual(await stage(oauthName), real, 'an account without a password');
  } finally {
    subtle.deriveBits = derive;
    subtle.sign = sign;
  }
});

// ---- durable throttles --------------------------------------------------------------------------

test('throttles: the counters survive an AccountsDO restart (SQLite, not memory), and hold no username or address', async () => {
  const { env, obj, db } = makeEnv();
  const ana = await legacyAccount(obj, 'Ana');
  for (let i = 0; i < 5; i++) assert.equal((await login(env, { username: 'Ana', password: WRONG }, '203.0.113.50')).status, 401);
  assert.equal((await login(env, { username: 'Ana', password: ana.v1 }, '203.0.113.50')).status, 429, 'the pair is locked');
  // The object restarts (a deploy, an eviction): a new instance on the same storage.
  attach(env, db);
  const again = await login(env, { username: 'Ana', password: ana.v1 }, '203.0.113.50');
  assert.deepEqual([again.status, again.json.error], [429, 'throttled'], 'still locked after the restart');
  assert.ok(again.json.retryAfterMs > 0);
  assert.equal((await login(env, { username: 'Ana', password: ana.v1 }, '203.0.113.51')).status, 200, 'another network signs in');
  const rows = db.prepare('SELECT key FROM auth_throttle').all().map((r) => r.key);
  assert.ok(rows.length > 0);
  for (const k of rows) {
    assert.match(k, /^(up|u|ip|w|d|pa):[0-9a-f]{32}$/, k);
    assert.equal(/ana|203\.0\.113/i.test(k), false, 'an HMAC, never the value');
  }
});

/** One failed password check straight at the AccountsDO (what the Worker sends after a wrong key): no hashing, so 600 are quick. */
async function doFail(obj, username, ip) {
  const headers = { [AUTH.INTERNAL_HEADER]: await AUTH.internalSecret(SECRET), 'content-type': 'application/json' };
  const begin = await obj.fetch(new Request('https://accounts/auth-begin', { method: 'POST', headers, body: JSON.stringify({ username, ip }) }));
  if (begin.status !== 200) return begin.status;
  await obj.fetch(new Request('https://accounts/auth-finish', { method: 'POST', headers, body: JSON.stringify({ username, ip, ok: false }) }));
  return 401;
}

test('throttles: an IPv4 address gets 600 failures and an IPv6 /64 30 before the network pause (15 minutes); a school behind one IPv4 address is not paused by a classroom of typos', async () => {
  const { obj } = makeEnv();
  assert.deepEqual([LOGIN_NET4_MAX, LOGIN_NET6_MAX, LOGIN_NET_PAUSE_MS], [600, 30, 15 * 60_000], 'the design\'s §2.3 caps');
  const t0 = Date.now();
  obj.now = () => t0;
  const tally4 = {};
  for (let i = 0; i < 601; i++) {
    const s = await doFail(obj, 'alumno' + i, '203.0.113.9'); // each guess on a username of its own: no pair lock
    tally4[s] = (tally4[s] ?? 0) + 1;
  }
  assert.deepEqual(tally4, { 401: 600, 429: 1 }, 'IPv4: 600 failures, then the pause');
  const tally6 = {};
  for (let i = 0; i < 31; i++) {
    const s = await doFail(obj, 'vecino' + i, `2001:db8:77:1::${(i + 1).toString(16)}`); // every address of one /64
    tally6[s] = (tally6[s] ?? 0) + 1;
  }
  assert.deepEqual(tally6, { 401: 30, 429: 1 }, 'IPv6: 30 failures across the /64, then the pause');
  assert.equal(await doFail(obj, 'otro', '2001:db8:77:2::1'), 401, 'the next /64 is not paused');
  assert.equal(await doFail(obj, 'otro2', '203.0.113.10'), 401, 'nor the next IPv4 address');
  obj.now = () => t0 + LOGIN_NET_PAUSE_MS + 1_000;
  assert.equal(await doFail(obj, 'alumno-tarde', '203.0.113.9'), 401, 'the pause ends after 15 minutes');
});

// ---- request rules ------------------------------------------------------------------------------

test('request rules: login and recover need a solved Turnstile check every time, before the AccountsDO hears of them', async () => {
  const { env, obj, calls } = makeEnv(TURNSTILE_ON);
  const ip = ips();
  const ana = await legacyAccount(obj, 'Ana');
  const n0 = calls.length;
  for (const body of [{}, { turnstileToken: 'bad-token' }]) {
    const r = await login(env, { username: 'Ana', password: ana.v1, passwordV2: ana.v2, ...body }, ip(0));
    assert.deepEqual([r.status, r.json.error], [403, 'turnstile_failed'], JSON.stringify(body));
    const rc = await post(env, '/api/auth/recover', { ip: ip(0), body: { username: 'Ana', code: 'AAAA-BBBB', passwordV2: ana.v2, ...body } });
    assert.deepEqual([rc.status, rc.json.error], [403, 'turnstile_failed']);
  }
  assert.equal(calls.length, n0, 'nothing reached the AccountsDO');
  assert.equal((await login(env, { username: 'Ana', password: ana.v1, passwordV2: ana.v2, ...TOK }, ip(0))).status, 200);
  // A recovery stores the current key, with a solved check.
  const codes = await post(env, '/api/auth/recovery-codes', { ip: ip(1), bearer: (await login(env, { username: 'Ana', password: WRONG, passwordV2: ana.v2, ...TOK }, ip(1))).json.session, body: { passwordV2: ana.v2 } });
  assert.equal(codes.status, 200, JSON.stringify(codes.json));
  const next = await ACC.passwordKey('una nueva clave');
  const rec = await post(env, '/api/auth/recover', { ip: ip(2), body: { username: 'Ana', code: codes.json.recoveryCodes[0], passwordV2: next, ...TOK } });
  assert.equal(rec.status, 200, JSON.stringify(rec.json));
  assert.equal(row(obj, ana.id).pw_v, 2);
  assert.equal(claims(rec.json.session).aal, 2, 'a recovery is level 2');
});

test('request rules: every refusal of a sign-in is one 401 bad_credentials (an unknown name, a wrong key, an OAuth-only account, a missing key, an account with a verified email even with its password)', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const ana = await legacyAccount(obj, 'Ana');
  const vera = await legacyAccount(obj, 'Vera');
  assert.equal(obj.store.claimEmail(vera.id, 'vera@example.org', 'mail', Date.now()), 'ok');
  const o = await oauth(env, 'discord', 'd-solo', { ip: ip(0) });
  const oauthName = (await refresh(env, o.rt, ip(0))).json.name;
  const cur = obj.store.register('Cora', await A.newPasswordRecord(ana.v2, 2), [], H('3'), Date.now()).userId;
  void cur;
  const answers = [
    await login(env, { username: 'nadie-existe', password: ana.v1, passwordV2: ana.v2 }, ip(1)),
    await login(env, { username: 'Ana', password: WRONG, passwordV2: WRONG }, ip(2)),
    await login(env, { username: oauthName, password: WRONG, passwordV2: WRONG }, ip(3)),
    await login(env, { username: 'Cora', password: await ACC.legacyPasswordKey('Cora', PW) }, ip(4)), // a current record, only the legacy key
    await login(env, { username: 'Vera', password: vera.v1, passwordV2: vera.v2 }, ip(5)), // the right password: Vera signs in by email
  ];
  for (const a of answers) assert.deepEqual([a.status, a.json], [401, { error: 'bad_credentials', message: 'Usuario o contraseña incorrectos' }]);
  assert.equal(row(obj, vera.id).pw_v, 1, 'and the refused one is not re-keyed');
  assert.equal(JSON.stringify(answers.map((a) => a.json)).includes('no_password'), false, 'no more no_password (audit auth-5)');
  // A recovery code of an account with a verified email does nothing either (it resets by email).
  const codes = ['AAAA-BBBB'];
  obj.store.setRecovery(vera.id, [await A.recoveryCodeHash(codes[0])]);
  const rec = await post(env, '/api/auth/recover', { ip: ip(6), body: { username: 'Vera', code: codes[0], passwordV2: WRONG } });
  assert.deepEqual([rec.status, rec.json.error], [401, 'bad_recovery']);
  assert.equal(row(obj, vera.id).pw_v, 1);
});

// ---- levels (R6) --------------------------------------------------------------------------------

test('levels: every provider start asks for a press on the provider\'s page (Discord prompt=consent, Google select_account) and yields level 1; a password yields 2; a TV none', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const ana = await legacyAccount(obj, 'Ana');
  const pw = await login(env, { username: 'Ana', password: ana.v1, passwordV2: ana.v2 }, ip(0));
  assert.equal(claims(pw.json.session).aal, 2);
  assert.equal(pw.json.authLvl, 2);
  obj.store.sql.exec("UPDATE users SET discord_id = 'd-ana' WHERE id = ?", ana.id);
  const rt = cookieOf(pw.raw, '__Host-tg_rt');
  const re = await oauth(env, 'discord', 'd-ana', { query: '?reauth=1', cookie: '__Host-tg_rt=' + rt, ip: ip(0) });
  const q = new URL(re.start.location).searchParams;
  assert.equal(q.get('prompt'), 'consent', 'a reauth on Discord asks again');
  assert.equal(re.done.location, '/#auth=reauth');
  const s = await refresh(env, re.rt, ip(0));
  assert.equal(claims(s.json.session).aal, 1, 'a Discord re-authentication is level 1');
  assert.ok(Math.abs(claims(s.json.session).aat - Date.now() / 1000) < 5);
  const r2 = await refresh(env, s.rt, ip(0));
  assert.equal(claims(r2.json.session).aal, 1, 'a refresh keeps the level, never raises it');
  for (const [p, query, want] of [['discord', '', 'consent'], ['discord', '?link=1', 'consent'], ['google', '', 'select_account'], ['google', '?reauth=1', 'select_account']]) {
    const st = await req(env, 'GET', `/api/auth/oauth/${p}/start${query}`, { ip: ip(1), cookie: '__Host-tg_rt=' + r2.rt, origin: null });
    assert.equal(new URL(st.location).searchParams.get('prompt'), want, p + query);
  }
  const signIn = await oauth(env, 'discord', 'd-otro', { ip: ip(2) });
  assert.equal(claims((await refresh(env, signIn.rt, ip(2))).json.session).aal, 1, 'a Discord sign-in too');
  // A forged or junk level never survives verifySession.
  const nowS = Math.floor(Date.now() / 1000);
  for (const bad of [{ aal: 3, aat: nowS }, { aal: 2 }, { aal: '2', aat: nowS }, { aal: 2, aat: nowS, tv: 1 }]) {
    const c = await AUTH.verifySession(SECRET, await AUTH.signJwt(SECRET, { typ: 's', sub: ana.id, name: 'Ana', iat: nowS, exp: nowS + 600, acct: 1, ...bad }));
    assert.notEqual(c.aal, 2, JSON.stringify(bad));
    assert.notEqual(c.aal, 3);
  }
});

test('levels: a maintainer route refuses level 1 (403 reauth_required { level: 2 }) and takes a password re-authentication; the account counts too (PR 3 review)', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  env.NODES = { idFromName: (n) => ({ n }), get: () => ({ fetch: async () => new Response('{"ok":true,"operators":[]}', { headers: { 'content-type': 'application/json' } }) }) };
  Object.assign(env, { NODE_REPLAYS: {}, NODE_RELEASES: {}, NODE_CONTROL_PRIVATE_KEY: 'k', NODE_CONTROL_PUBLIC_KEY: 'k', NODES_PUBLIC_BASE: ORIGIN });
  const p = await legacyAccount(obj, 'Proyecto');
  obj.store.sql.exec("UPDATE users SET discord_id = 'd-proyecto' WHERE id = ?", p.id);
  env.NODE_TRUSTED_OPERATORS = p.id;
  const viaDiscord = await oauth(env, 'discord', 'd-proyecto', { ip: ip(0) });
  const s1 = await refresh(env, viaDiscord.rt, ip(0));
  assert.equal(claims(s1.json.session).aal, 1);
  for (const [method, path] of [['GET', '/nodes/admin/nodes'], ['GET', '/nodes/admin/account-stats'], ['POST', '/nodes/tokens']]) {
    const r = await req(env, method, path, { ip: ip(0), bearer: s1.json.session, body: method === 'POST' ? { region: 'SA' } : undefined });
    assert.deepEqual([r.status, r.json.error, r.json.level], [403, 'reauth_required', 2], path);
  }
  const re = await post(env, '/api/auth/reauth', { ip: ip(0), bearer: s1.json.session, cookie: '__Host-tg_rt=' + s1.rt, body: { legacy: p.v1, password: p.v2 } });
  assert.equal(re.status, 200);
  assert.equal(claims(re.json.session).aal, 2);
  assert.equal((await req(env, 'GET', '/nodes/admin/nodes', { ip: ip(0), bearer: re.json.session })).status, 200);
  assert.equal((await req(env, 'GET', '/nodes/admin/account-stats', { ip: ip(0), bearer: re.json.session })).status, 200);
});

test('levels: a family from before levels (auth_lvl 0) is level 0: never fresh, so a link, a first password and an unlink ask first', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  // A Discord-only account and a device that signed in a minute ago with the code of before (auth_at set, no level).
  const o = await oauth(env, 'discord', 'd-vieja', { ip: ip(0) });
  const id = (await refresh(env, o.rt, ip(0))).json.playerId;
  obj.store.sql.exec("UPDATE users SET google_sub = 'g-vieja' WHERE id = ?", id);
  const tok = 'y'.repeat(43);
  obj.store.sql.exec("INSERT INTO refresh (hash, user_id, created_at, expires_at, kind, auth_at, family_at) VALUES (?, ?, ?, ?, 'web', ?, ?)", await A.sha256Hex(tok), id, Date.now(), Date.now() + 86_400_000, Date.now() - 60_000, Date.now() - 60_000);
  const s = await refresh(env, tok, ip(1));
  assert.equal(s.status, 200);
  const c = claims(s.json.session);
  assert.ok(c.aat > 0, 'it proved a credential a minute ago');
  assert.equal(c.aal, undefined, 'at no level');
  const link = await req(env, 'GET', '/api/auth/oauth/discord/start?link=1', { ip: ip(1), cookie: '__Host-tg_rt=' + s.rt, origin: null });
  assert.equal(link.location, '/#auth=error:reauth_required');
  const pw = await post(env, '/api/auth/password', { ip: ip(1), bearer: s.json.session, body: { passwordV2: WRONG } });
  assert.deepEqual([pw.status, pw.json.error, pw.json.level], [403, 'reauth_required', 1]);
  const un = await post(env, '/api/auth/unlink', { ip: ip(1), bearer: s.json.session, body: { provider: 'google' } });
  assert.deepEqual([un.status, un.json.error, un.json.level], [403, 'reauth_required', 1]);
  assert.equal(row(obj, id).google_sub, 'g-vieja');
});

test('levels: an unlink that leaves one way in needs level 2 where the account has a password; an account without one (its ceiling is 1) still unlinks at level 1', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const ana = await legacyAccount(obj, 'Ana');
  obj.store.sql.exec("UPDATE users SET discord_id = 'd-ana' WHERE id = ?", ana.id);
  const viaDiscord = await oauth(env, 'discord', 'd-ana', { ip: ip(0) });
  const s = await refresh(env, viaDiscord.rt, ip(0));
  const r = await post(env, '/api/auth/unlink', { ip: ip(0), bearer: s.json.session, body: { provider: 'discord' } });
  assert.deepEqual([r.status, r.json.error, r.json.level], [403, 'reauth_required', 2], 'only the password would be left: level 2');
  assert.equal(row(obj, ana.id).discord_id, 'd-ana');
  const re = await post(env, '/api/auth/reauth', { ip: ip(0), bearer: s.json.session, cookie: '__Host-tg_rt=' + s.rt, body: { legacy: ana.v1, password: ana.v2 } });
  assert.equal((await post(env, '/api/auth/unlink', { ip: ip(0), bearer: re.json.session, body: { provider: 'discord' } })).status, 200);
  // Google and Discord, no password: a press on a provider is the most it can show.
  const g = await oauth(env, 'google', 'g-bea', { ip: ip(1) });
  const gs = await refresh(env, g.rt, ip(1));
  const l = await oauth(env, 'discord', 'd-bea', { query: '?link=1', cookie: '__Host-tg_rt=' + gs.rt, ip: ip(1) });
  assert.equal(l.done.location, '/#auth=linked');
  const ls = await refresh(env, l.rt, ip(1));
  assert.equal(claims(ls.json.session).aal, 1);
  assert.equal((await post(env, '/api/auth/unlink', { ip: ip(1), bearer: ls.json.session, body: { provider: 'google' } })).status, 200, 'its ceiling is 1');
});

// ---- the TV's /api/me (PR 3 review: the design's §3.11) ----------------------------------------

test('a TV\'s /api/me leaves out the email and the hint; the phone\'s keeps them', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const ana = await legacyAccount(obj, 'Ana');
  const phone = await login(env, { username: 'Ana', password: ana.v1, passwordV2: ana.v2 }, ip(0));
  assert.equal(phone.status, 200);
  // Then an address (from PR 7 on, proved by mail) and a provider's hint, written straight for the shape.
  assert.equal(obj.store.claimEmail(ana.id, 'ana@example.org', 'mail', Date.now()), 'ok');
  obj.store.sql.exec("UPDATE users SET email_hint = 'ana@discord.example' WHERE id = ?", ana.id);
  const st = await post(env, '/api/auth/tv/start', { ip: ip(1) });
  assert.equal((await post(env, '/api/auth/tv/confirm', { ip: ip(2), bearer: phone.json.session, body: { code: st.json.code } })).status, 200);
  const tv = await post(env, '/api/auth/tv/poll', { ip: ip(1), body: { code: st.json.code, secret: st.json.secret } });
  assert.equal(tv.json.tv, true);
  assert.equal(claims(tv.json.session).aal, undefined, 'a TV is level 0');
  const onTv = await req(env, 'GET', '/api/me', { ip: ip(1), bearer: tv.json.session });
  assert.equal(onTv.status, 200);
  assert.equal(onTv.headers.get('cache-control'), 'no-store');
  assert.equal('email' in onTv.json || 'emailHint' in onTv.json, false, JSON.stringify(onTv.json));
  assert.equal(JSON.stringify(onTv.json).includes('@'), false, 'no address at all');
  assert.equal(onTv.json.name, 'Ana', 'the rest as before');
  const onPhone = await req(env, 'GET', '/api/me', { ip: ip(0), bearer: phone.json.session });
  assert.deepEqual([onPhone.json.email, onPhone.json.emailHint], ['ana@example.org', 'ana@discord.example']);
});
