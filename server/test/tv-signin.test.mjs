// The TV's sign-in with the phone (plan PR 14): tvCodes.ts on its own (codes, the per-IP and global
// caps, the failure counters), then the Worker's POST /api/auth/tv/start | confirm | poll in front of
// a real AccountsDO (node:sqlite): the whole flow and its session as login gives it, one use (a
// replayed poll and a second confirm), expiry at 5 minutes, a wrong device secret, an account only,
// the Origin check, brute force against the attempt limits, the rate limits. 'cloudflare:workers'
// and MatchDO's wasm are stubbed. Run from server/: npm test
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

const TV = await import('../src/tvCodes.ts');
const { AccountsDO } = await import('../src/AccountsDO.ts');
const A = await import('../src/accountRoutes.ts');
const worker = (await import('../src/index.ts')).default;
const { signJwt, createSession } = await import('../src/auth.ts');
const LOBBY = await import('../../src/ui/screens/lobbyModel.ts');

const SECRET = 'tv-signin-test-secret';
const ORIGIN = 'https://turbo-gol.com';
const H = (c) => c.repeat(64).slice(0, 64);
const KEY = 'c'.repeat(64); // a client key (src/net/account.ts clientPasswordKey's shape)

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

function makeEnv() {
  const db = new DatabaseSync(':memory:');
  let alarm = null;
  const env = { JWT_SECRET: SECRET, VITE_ORIGINS: ORIGIN, FLAGS: { get: async () => null } };
  const ctx = {
    storage: { sql: sqlOn(db), transactionSync: txOn(db), getAlarm: async () => alarm, setAlarm: async (t) => void (alarm = t) },
    blockConcurrencyWhile: (fn) => fn(),
  };
  const obj = new AccountsDO(ctx, env);
  env.ACCOUNTS = { idFromName: (n) => ({ n }), get: () => ({ fetch: (url, init) => obj.fetch(new Request(url, init)) }) };
  return { env, obj };
}

// The Worker's rate limiter is per isolate (index.ts): every test takes IPs of its own.
let ipBase = 0;
const ips = () => {
  const base = ++ipBase;
  return (i = 0) => `203.0.${base}.${i + 1}`;
};

async function call(env, path, { ip, token, body, origin = ORIGIN, cookie } = {}) {
  const headers = { 'CF-Connecting-IP': ip, 'content-type': 'application/json' };
  if (origin !== null) headers.Origin = origin;
  if (token) headers.authorization = 'Bearer ' + token;
  if (cookie) headers.cookie = cookie;
  const res = await worker.fetch(new Request(ORIGIN + path, { method: 'POST', headers, body: JSON.stringify(body ?? {}) }), env);
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
}

const accountToken = (sub, name) => signJwt(SECRET, { sub, name, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, acct: 1 });

async function account(obj, name) {
  const id = obj.store.register(name, await A.newPasswordRecord(KEY), [], H(name[0].toLowerCase() === 'a' ? '1' : '2'), Date.now()).userId;
  return { id, token: await accountToken(id, name) };
}

/** The cookie's attributes without its value. */
const cookieFlags = (setCookie) => setCookie.replace(/^__Host-tg_rt=[^;]*/, '');

// ---- tvCodes.ts alone ----------------------------------------------------------------------

test('tvCodes: six of the lobby alphabet, unique, 5 minutes; the per-IP cap replaces the oldest; the global cap refuses', () => {
  assert.equal(TV.TV_CODE_ALPHABET, LOBBY.CODE_ALPHABET, 'the lobby code alphabet (no I, O, 0 or 1)');
  assert.equal(TV.TV_CODE_LENGTH, LOBBY.CODE_LENGTH);
  assert.ok(TV.TV_CODE_TTL_MS <= 5 * 60_000);
  const t = new TV.TvCodes();
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const r = t.start('ip' + i, H('a'), 1000);
    assert.match(r.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{6}$/);
    assert.equal(r.expiresAt, 1000 + TV.TV_CODE_TTL_MS);
    assert.ok(!seen.has(r.code));
    seen.add(r.code);
  }
  // A forced collision draws again.
  let n = 0;
  const fixed = new TV.TvCodes((len) => new Uint8Array(len).fill(n++ < 6 ? 0 : 1));
  assert.equal(fixed.start('x', H('a'), 0).code, 'AAAAAA');
  assert.equal(fixed.start('x', H('a'), 0).code, 'BBBBBB');
  const p = new TV.TvCodes();
  const first = p.start('home', H('a'), 0).code;
  for (let i = 1; i < TV.TV_CODES_PER_IP; i++) p.start('home', H('a'), 0);
  assert.equal(p.size, TV.TV_CODES_PER_IP);
  p.start('home', H('a'), 0);
  assert.equal(p.size, TV.TV_CODES_PER_IP, 'still five live codes for that IP');
  assert.equal(p.poll(first, H('a'), 1), 'expired', 'the oldest went');
  const full = new TV.TvCodes();
  for (let i = 0; i < TV.TV_CODES_MAX; i++) full.start('ip' + i, H('a'), 0);
  assert.equal(full.start('one-more', H('a'), 0), 'full');
});

test('tvCodes: parse, constant-time compare, sweep of expired codes and finished windows', () => {
  assert.equal(TV.tvCode('abc 234'), 'ABC234');
  assert.equal(TV.tvCode('ABC-234'), 'ABC234');
  for (const bad of ['ABC23', 'ABC2345', 'ABCO23', 'ABC123', 12, null, 'x'.repeat(40)]) assert.equal(TV.tvCode(bad), null, String(bad));
  assert.ok(TV.sameHex(H('a'), H('a')));
  assert.ok(!TV.sameHex(H('a'), H('b')));
  assert.ok(!TV.sameHex(H('a'), H('a').slice(1)));
  const t = new TV.TvCodes();
  const { code } = t.start('ip', H('a'), 0);
  t.confirm('ZZZZZZ', { userId: 'u', username: 'Ana' }, 'ip', 0);
  assert.equal(t.poll(code, H('a'), TV.TV_CODE_TTL_MS), 'expired', 'expired at its time');
  t.sweep(TV.TV_CODE_TTL_MS + TV.TV_KEEP_MS - 1, true);
  assert.equal(t.size, 1, 'still known: a late phone hears expired, not wrong');
  assert.equal(t.confirm(code, { userId: 'v', username: 'Beto' }, 'ip2', TV.TV_CODE_TTL_MS + 1), 'expired');
  t.sweep(TV.TV_CODE_TTL_MS + TV.TV_KEEP_MS, true);
  assert.equal(t.size, 0, 'gone after its keep');
  assert.equal(t.confirm(code, { userId: 'v', username: 'Beto' }, 'ip3', TV.TV_CODE_TTL_MS + TV.TV_KEEP_MS), 'wrong');
});

// ---- the Worker in front of a real AccountsDO ---------------------------------------------

test('Worker: start, pending, confirm, approved: the session and the refresh cookie as login gives them; the code is one use', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const ana = await account(obj, 'Ana');
  const s = await call(env, '/api/auth/tv/start', { ip: ip(0), origin: null });
  assert.equal(s.status, 200);
  assert.equal(s.headers.get('cache-control'), 'no-store');
  const { code, secret, expiresAt, pollMs } = s.json;
  assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{6}$/);
  assert.ok(Buffer.from(secret, 'base64url').length >= 16, 'a device secret of at least 128 bits');
  assert.ok(expiresAt - Date.now() <= 5 * 60_000 && expiresAt - Date.now() > 4 * 60_000);
  assert.ok(pollMs >= 1000);
  assert.equal(JSON.stringify([...obj.tv.codes.values()]).includes(secret), false, 'the object keeps only its hash');
  let r = await call(env, '/api/auth/tv/poll', { ip: ip(0), body: { code, secret } });
  assert.deepEqual(r.json, { state: 'pending' });
  r = await call(env, '/api/auth/tv/confirm', { ip: ip(1), token: ana.token, body: { code: code.toLowerCase() } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
  r = await call(env, '/api/auth/tv/confirm', { ip: ip(1), token: ana.token, body: { code } });
  assert.equal(r.status, 409, 'a second confirm');
  assert.equal(r.json.error, 'tv_code_used');
  r = await call(env, '/api/auth/tv/poll', { ip: ip(0), body: { code, secret } });
  assert.equal(r.status, 200);
  assert.equal(r.json.state, 'approved');
  assert.equal(r.json.kind, 'account');
  assert.equal(r.json.playerId, ana.id);
  assert.equal(r.json.name, 'Ana');
  assert.ok(r.json.expiresAt > Date.now());
  const tvCookie = r.headers.get('set-cookie');
  assert.match(tvCookie, /^__Host-tg_rt=[A-Za-z0-9_-]{43};/);
  const login = await call(env, '/api/auth/login', { ip: ip(2), body: { username: 'Ana', password: KEY } });
  assert.equal(login.status, 200);
  assert.equal(cookieFlags(tvCookie), cookieFlags(login.headers.get('set-cookie')), 'the same cookie flags as login');
  assert.match(cookieFlags(tvCookie), /HttpOnly; Secure; SameSite=Strict/);
  // The TV's refresh cookie is a real session: it refreshes.
  const again = await call(env, '/api/auth/refresh', { ip: ip(0), cookie: tvCookie.split(';')[0] });
  assert.equal(again.status, 200);
  assert.equal(again.json.playerId, ana.id);
  // Replays: the poll and the confirm both say used.
  r = await call(env, '/api/auth/tv/poll', { ip: ip(0), body: { code, secret } });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'tv_code_used');
  assert.equal(r.headers.get('set-cookie'), null);
  r = await call(env, '/api/auth/tv/confirm', { ip: ip(3), token: ana.token, body: { code } });
  assert.equal(r.json.error, 'tv_code_used');
});

test('Worker: a code expires at 5 minutes (confirm and poll say so), a wrong secret is refused and consumes nothing', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const ana = await account(obj, 'Ana');
  const { code, secret } = (await call(env, '/api/auth/tv/start', { ip: ip(0) })).json;
  let r = await call(env, '/api/auth/tv/poll', { ip: ip(0), body: { code, secret: secret.slice(0, -2) + (secret.endsWith('AA') ? 'BB' : 'AA') } });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'bad_secret');
  r = await call(env, '/api/auth/tv/poll', { ip: ip(0), body: { code: 'ZZZZZZ', secret } });
  assert.equal(r.status, 410, 'an unknown code is gone');
  for (const body of [{}, { code }, { code, secret: 5 }, { code: 'ABC', secret }]) assert.equal((await call(env, '/api/auth/tv/poll', { ip: ip(0), body })).status, 400, JSON.stringify(body));
  const t0 = Date.now();
  obj.now = () => t0 + 5 * 60_000 + 1;
  r = await call(env, '/api/auth/tv/confirm', { ip: ip(1), token: ana.token, body: { code } });
  assert.equal(r.status, 410);
  assert.equal(r.json.error, 'tv_code_expired');
  r = await call(env, '/api/auth/tv/poll', { ip: ip(0), body: { code, secret } });
  assert.equal(r.status, 410);
  // Confirmed in time, polled too late: expired all the same.
  obj.now = () => Date.now();
  const second = (await call(env, '/api/auth/tv/start', { ip: ip(0) })).json;
  assert.equal((await call(env, '/api/auth/tv/confirm', { ip: ip(1), token: ana.token, body: { code: second.code } })).status, 200);
  obj.now = () => Date.now() + 5 * 60_000 + 1;
  r = await call(env, '/api/auth/tv/poll', { ip: ip(0), body: { code: second.code, secret: second.secret } });
  assert.equal(r.status, 410);
  assert.equal(r.headers.get('set-cookie'), null);
  obj.now = () => Date.now() + 5 * 60_000 + TV.TV_KEEP_MS + 1;
  await obj.alarm();
  assert.equal(obj.tv.size, 0, 'the alarm sweeps what expired');
});

test('Worker: only an account confirms (401 / 403 for a guest), from this origin', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const ana = await account(obj, 'Ana');
  const { code } = (await call(env, '/api/auth/tv/start', { ip: ip(0) })).json;
  assert.equal((await call(env, '/api/auth/tv/confirm', { ip: ip(1), body: { code } })).status, 401);
  const guest = (await createSession(SECRET, '0123456789abcdef', 'Invitado')).token;
  const g = await call(env, '/api/auth/tv/confirm', { ip: ip(1), token: guest, body: { code } });
  assert.equal(g.status, 403);
  assert.equal(g.json.error, 'account_required');
  const x = await call(env, '/api/auth/tv/confirm', { ip: ip(1), token: ana.token, body: { code }, origin: 'https://evil.example' });
  assert.equal(x.status, 403);
  assert.equal(x.json.error, 'bad_origin');
  assert.equal((await call(env, '/api/auth/tv/confirm', { ip: ip(1), token: ana.token, body: { code: 'no' } })).status, 400);
  assert.equal((await call(env, '/api/auth/tv/confirm', { ip: ip(1), token: ana.token, body: { code } })).status, 200, 'the code is still there');
});

test('Worker: brute force: 10 failed confirms per account and per IP, then every confirm is refused (the right code too)', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const ana = await account(obj, 'Ana');
  const beto = await account(obj, 'Beto');
  const { code } = (await call(env, '/api/auth/tv/start', { ip: ip(0) })).json;
  const wrong = code === 'ZZZZZZ' ? 'YYYYYY' : 'ZZZZZZ';
  for (let i = 0; i < TV.TV_CONFIRM_FAILS; i++) {
    const r = await call(env, '/api/auth/tv/confirm', { ip: ip(1), token: ana.token, body: { code: wrong } });
    assert.equal(r.status, 404, `try ${i + 1}`);
    assert.equal(r.json.error, 'tv_code_wrong');
  }
  let r = await call(env, '/api/auth/tv/confirm', { ip: ip(1), token: ana.token, body: { code } });
  assert.equal(r.status, 429, 'the limit: even the right code');
  assert.equal(r.json.error, 'throttled');
  assert.ok(r.json.retryAfterMs > 0 && r.json.retryAfterMs <= TV.TV_FAIL_WINDOW_MS);
  r = await call(env, '/api/auth/tv/confirm', { ip: ip(2), token: ana.token, body: { code } });
  assert.equal(r.status, 429, 'the account, from another IP');
  r = await call(env, '/api/auth/tv/confirm', { ip: ip(1), token: beto.token, body: { code } });
  assert.equal(r.status, 429, 'the IP, with another account');
  r = await call(env, '/api/auth/tv/confirm', { ip: ip(3), token: beto.token, body: { code } });
  assert.equal(r.status, 200, 'another account from another IP');
  // The window ends: the account may try again.
  obj.now = () => Date.now() + TV.TV_FAIL_WINDOW_MS + 1;
  const late = await call(env, '/api/auth/tv/confirm', { ip: ip(4), token: ana.token, body: { code: wrong } });
  assert.equal(late.status, 404);
});

test('Worker: rate limits per IP on start (10 a minute), poll (60) and confirm (30)', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const ana = await account(obj, 'Ana');
  for (let i = 0; i < 10; i++) assert.equal((await call(env, '/api/auth/tv/start', { ip: ip(0) })).status, 200, `start ${i + 1}`);
  assert.equal((await call(env, '/api/auth/tv/start', { ip: ip(0) })).status, 429);
  assert.equal(obj.tv.size, TV.TV_CODES_PER_IP, 'five live codes for that IP at most');
  const { code, secret } = (await call(env, '/api/auth/tv/start', { ip: ip(1) })).json;
  for (let i = 0; i < 60; i++) assert.equal((await call(env, '/api/auth/tv/poll', { ip: ip(1), body: { code, secret } })).status, 200);
  assert.equal((await call(env, '/api/auth/tv/poll', { ip: ip(1), body: { code, secret } })).status, 429);
  for (let i = 0; i < 30; i++) await call(env, '/api/auth/tv/confirm', { ip: ip(2), token: ana.token, body: { code: 'ZZZZZZ' } });
  const r = await call(env, '/api/auth/tv/confirm', { ip: ip(2), token: ana.token, body: { code } });
  assert.equal(r.status, 429);
});
