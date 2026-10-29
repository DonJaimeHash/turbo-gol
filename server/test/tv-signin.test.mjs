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
  const { code, secret, expiresAt, ttlMs, pollMs } = s.json;
  assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{6}$/);
  assert.ok(Buffer.from(secret, 'base64url').length >= 16, 'a device secret of at least 128 bits');
  assert.ok(expiresAt - Date.now() <= 5 * 60_000 && expiresAt - Date.now() > 4 * 60_000);
  assert.ok(ttlMs <= 5 * 60_000 && ttlMs > 4 * 60_000, 'the life from now, for a TV whose clock is off the server\'s');
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

test('Worker: a code expires at 5 minutes (confirm and poll say so), a wrong secret answers as an unknown code and consumes nothing', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const ana = await account(obj, 'Ana');
  const { code, secret } = (await call(env, '/api/auth/tv/start', { ip: ip(0) })).json;
  let r = await call(env, '/api/auth/tv/poll', { ip: ip(0), body: { code, secret: secret.slice(0, -2) + (secret.endsWith('AA') ? 'BB' : 'AA') } });
  const unknown = await call(env, '/api/auth/tv/poll', { ip: ip(0), body: { code: code === 'ZZZZZZ' ? 'YYYYYY' : 'ZZZZZZ', secret } });
  assert.equal(unknown.status, 410, 'an unknown code is gone');
  assert.deepEqual([r.status, r.json], [unknown.status, unknown.json], 'a live code with a wrong secret: the same answer, nothing tells it apart');
  assert.deepEqual((await call(env, '/api/auth/tv/poll', { ip: ip(0), body: { code, secret } })).json, { state: 'pending' }, 'the code is still there');
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

test('Worker: brute force: 10 failed confirms per account, then every confirm of it is refused (the right code too)', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const ana = await account(obj, 'Ana');
  const beto = await account(obj, 'Beto');
  const { code } = (await call(env, '/api/auth/tv/start', { ip: ip(0) })).json;
  obj.tv.wokeAt = Date.now() - TV.TV_CODE_TTL_MS; // awake for a code's life: an unknown code is wrong
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
  assert.equal(r.status, 200, 'another account on the same IP (a shared one: a carrier, a school)');
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

// ---- the hardening after PR 14's review (PR 17) --------------------------------------------

test('tvCodes: an IPv6 address counts by its /64; the caps count live codes; the rows past TV_ROWS_MAX lose their oldest tombstones', () => {
  assert.equal(TV.ipKey('203.0.113.7'), '203.0.113.7');
  assert.equal(TV.ipKey('2001:db8::1'), '2001:db8:0:0');
  assert.equal(TV.ipKey('2001:0DB8:0000:0001:aaaa:bbbb:cccc:dddd'), '2001:db8:0:1');
  assert.equal(TV.ipKey('2001:db8:0:1::'), '2001:db8:0:1');
  assert.equal(TV.ipKey('::1'), '0:0:0:0');
  assert.equal(TV.ipKey('fe80::1%eth0'), 'fe80:0:0:0');
  // One /64, many addresses: one IP's five live codes.
  const t = new TV.TvCodes();
  const first = t.start('2001:db8::1', H('a'), 0).code;
  for (let i = 2; i <= 9; i++) t.start(`2001:db8::${i}`, H('a'), 0);
  assert.equal(t.size, TV.TV_CODES_PER_IP, 'the /64 holds five');
  assert.equal(t.poll(first, H('a'), 1), 'expired', 'its oldest went');
  // The global cap counts live codes: expired ones (tombstones until their keep) do not fill it.
  const TTL = TV.TV_CODE_TTL_MS;
  const full = new TV.TvCodes();
  const oldest = full.start('ip0', H('a'), 0).code;
  for (let i = 1; i < TV.TV_CODES_MAX; i++) full.start('ip' + i, H('a'), 0);
  assert.equal(full.start('one-more', H('a'), 0), 'full');
  // Expired (tombstones until their keep), they do not fill it: 2,000 new codes.
  const b0 = full.start('later0', H('b'), TTL).code;
  for (let i = 1; i < TV.TV_CODES_MAX; i++) assert.notEqual(full.start('later' + i, H('b'), TTL), 'full', `new code ${i}`);
  assert.equal(full.size, TV.TV_ROWS_MAX);
  assert.equal(full.start('over', H('b'), TTL), 'full', '2,000 live: refused');
  // One is used (a tombstone now): the next code takes the oldest tombstone's row, never a live code's.
  assert.equal(full.confirm(b0, { userId: 'u', username: 'Ana' }, 'phone', TTL), 'ok');
  assert.equal(full.poll(b0, H('b'), TTL).userId, 'u');
  assert.notEqual(full.start('newest', H('c'), TTL + 1), 'full');
  assert.equal(full.size, TV.TV_ROWS_MAX, 'one tombstone went for it');
  assert.equal(full.codes.has(oldest), false, 'the oldest');
  assert.equal(full.poll(b0, H('b'), TTL + 1), 'used', 'a newer tombstone stays');
});

test('tvCodes: failed confirms: 10 per account, 50 per IP (a shared one); an unknown code just after a wake is expired (maybe lost), later wrong', () => {
  const t = new TV.TvCodes();
  t.start('tv', H('a'), 0);
  t.wokeAt = -TV.TV_CODE_TTL_MS;
  const ip = '198.51.100.9';
  for (let u = 0; u < 5; u++) {
    for (let i = 0; i < TV.TV_CONFIRM_FAILS; i++) assert.equal(t.confirm('ZZZZZZ', { userId: 'u' + u, username: 'P' + u }, ip, 1), 'wrong');
    assert.deepEqual(Object.keys(t.confirm('ZZZZZZ', { userId: 'u' + u, username: 'P' + u }, ip, 1)), ['throttled'], 'that account is throttled');
  }
  assert.equal(TV.TV_CONFIRM_IP_FAILS, 5 * TV.TV_CONFIRM_FAILS);
  assert.deepEqual(Object.keys(t.confirm('ZZZZZZ', { userId: 'fresh', username: 'F' }, ip, 1)), ['throttled'], '50 failures: the IP too');
  assert.equal(t.confirm('ZZZZZZ', { userId: 'fresh', username: 'F' }, '2001:db8::5', 1), 'wrong', 'another IP');
  // A woken object (the codes are in memory: an eviction drops them).
  const w = new TV.TvCodes();
  assert.equal(w.confirm('ZZZZZZ', { userId: 'u', username: 'Ana' }, 'ip', 1000), 'expired', 'just woke: maybe a code it lost');
  assert.equal(w.confirm('YYYYYY', { userId: 'u', username: 'Ana' }, 'ip', 1000 + TV.TV_CODE_TTL_MS), 'wrong', 'a code\'s life later: wrong');
  assert.equal(w.poll('ZZZZZZ', H('a'), 1000), 'expired');
});

test('Worker: a suspended account confirms nothing (403 banned on the phone); suspended or deleted after the confirm, the TV hears banned or expired', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const ana = await account(obj, 'Ana');
  const beto = await account(obj, 'Beto');
  const sql = (q, ...b) => obj.store.sql.exec(q, ...b);
  const one = (await call(env, '/api/auth/tv/start', { ip: ip(0) })).json;
  sql('UPDATE users SET banned = 1 WHERE id = ?', ana.id);
  let r = await call(env, '/api/auth/tv/confirm', { ip: ip(1), token: ana.token, body: { code: one.code } });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'banned');
  assert.deepEqual((await call(env, '/api/auth/tv/poll', { ip: ip(0), body: one })).json, { state: 'pending' }, 'the code stays');
  // Banned between the confirm and the poll.
  assert.equal((await call(env, '/api/auth/tv/confirm', { ip: ip(1), token: beto.token, body: { code: one.code } })).status, 200);
  sql('UPDATE users SET banned = 1 WHERE id = ?', beto.id);
  r = await call(env, '/api/auth/tv/poll', { ip: ip(0), body: one });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'banned');
  assert.equal(r.headers.get('set-cookie'), null);
  // Deleted between the confirm and the poll: the approval went with it.
  const cleo = await account(obj, 'Cleo');
  const two = (await call(env, '/api/auth/tv/start', { ip: ip(0) })).json;
  assert.equal((await call(env, '/api/auth/tv/confirm', { ip: ip(1), token: cleo.token, body: { code: two.code } })).status, 200);
  sql('DELETE FROM users WHERE id = ?', cleo.id);
  r = await call(env, '/api/auth/tv/poll', { ip: ip(0), body: two });
  assert.equal(r.status, 410);
  assert.equal(r.json.error, 'tv_code_expired');
  assert.equal(r.headers.get('set-cookie'), null);
});
