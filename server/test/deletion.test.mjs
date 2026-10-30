// Sign-in PR 12 (the design's §8 "account deletion", §2.10 and §3.13): POST /api/me/delete needs
// level 2 capped by the account's ceiling and the name typed, signs every device out, withdraws the
// news consent and mails M9 with its cancel link; the project's account is refused. While the
// deletion is pending, every sign-in answers deletion_pending after the right credential, and the
// same sign-in with cancelDeletion (cancelDel=1 for OAuth) or M9's link calls it off. The alarm's
// purge empties every table of §3.13 for that id and nothing of another account, leaves sanction
// marks for a ban, a live ranked lock or abandons that still weigh, writes the tombstone, tells the
// NodeRegistryDO, and is batched, idempotent and resumable. A later account that binds a marked
// address or provider id gets what is left of the sanction. Through the real Worker (index.ts) in
// front of a real AccountsDO on node:sqlite, as maintainer.test.mjs runs them; the providers, the
// mail binding, Turnstile and the NodeRegistryDO are fakes: nothing leaves this machine.
// Run from server/: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

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

// ---- the fakes: the providers, Turnstile ---------------------------------------------------------
const identity = { google: { sub: 'g-default' }, discord: { id: 'd-default' } };
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

const { AccountsDO, PURGE_BATCH, PURGE_AGAIN_MS, DELETION_REQUESTS } = await import('../src/AccountsDO.ts');
const A = await import('../src/accountRoutes.ts');
const ACC = await import('../../src/net/account.ts');
const AUTH = await import('../src/auth.ts');
const ENV = await import('../src/env.ts');
const L = await import('../src/limits.ts');
const { ABANDON_WINDOW_MS, PLACEMENT_MATCHES } = await import('../../src/net/rating.ts');
const worker = (await import('../src/index.ts')).default;

const SECRET = 'deletion-test-secret';
const ORIGIN = 'https://turbo-gol.com';
const TOK = { turnstileToken: 'good-token' };
const PW = 'la clave larga de prueba';
const KEY = await ACC.passwordKey(PW);
const NEW_PW = 'otra clave larga de prueba';
const NEW_KEY = await ACC.passwordKey(NEW_PW);
const DAY = 24 * 60 * 60_000;
const GRACE = 14 * DAY;

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

/** A live deploy's mail settings with a fake binding that records every message (nothing can send). */
function liveMail(outbox) {
  return { EMAIL: { send: async (m) => void outbox.push(m) }, MAIL_LIVE: '1', MAIL_FROM: 'Turbogol <no-reply@turbo-gol.com>', MAIL_LINK_ORIGIN: ORIGIN };
}

function makeEnv(extra = {}) {
  const db = new DatabaseSync(':memory:');
  const outbox = [];
  const flags = new Map();
  const env = {
    JWT_SECRET: SECRET,
    VITE_ORIGINS: ORIGIN,
    FLAGS: { get: async (k) => flags.get(k) ?? null },
    TURNSTILE_DISABLED: '1',
    GOOGLE_CLIENT_ID: 'gid',
    GOOGLE_CLIENT_SECRET: 'gsec',
    DISCORD_CLIENT_ID: 'did',
    DISCORD_CLIENT_SECRET: 'dsec',
    // The route is open here (env.ts DELETION_OPEN; "0" in wrangler.jsonc until the terms of service).
    DELETION_OPEN: '1',
    ...liveMail(outbox),
    ...extra,
  };
  let alarm = null;
  const ctx = { storage: { sql: sqlOn(db), transactionSync: txOn(db), getAlarm: async () => alarm, setAlarm: async (t) => void (alarm = t) }, blockConcurrencyWhile: (fn) => fn() };
  const obj = new AccountsDO(ctx, env);
  env.ACCOUNTS = { idFromName: (n) => ({ n }), get: () => ({ fetch: (url, init) => obj.fetch(new Request(url, init)) }) };
  return { env, obj, outbox, flags, alarm: () => alarm };
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

/** One request through the Worker; what it sends in waitUntil has gone out when this returns. */
async function req(env, method, path, { ip = '198.19.0.1', origin = ORIGIN, bearer, cookie, body, cf = { country: 'AR' } } = {}) {
  const headers = { 'CF-Connecting-IP': ip };
  if (origin !== null) headers.Origin = origin;
  if (bearer) headers.authorization = 'Bearer ' + bearer;
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p), passThroughOnException() {} };
  const request = new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (cf !== null) Object.defineProperty(request, 'cf', { value: cf });
  const res = await worker.fetch(request, env, ctx);
  await Promise.all(pending);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, headers: res.headers, json, location: res.headers.get('location'), raw: res, rt: cookieOf(res, '__Host-tg_rt') };
}
const post = (env, path, o = {}) => req(env, 'POST', path, { body: {}, ...o });
const signin = (env, email, ip, extra = {}, password = KEY) => post(env, '/api/auth/signin', { ip, body: { email, password, ...TOK, ...extra } });
const del = (env, session, confirm, ip, extra = {}) => post(env, '/api/me/delete', { ip, bearer: session, body: { confirm, lang: 'es', ...extra } });

async function oauth(env, provider, who, { query = '', cookie, ip = '198.19.201.1' } = {}) {
  identity[provider] = provider === 'google' ? { sub: who } : { id: who };
  const start = await req(env, 'GET', `/api/auth/oauth/${provider}/start${query}`, { ip, cookie, origin: null });
  if (start.status !== 302 || !start.location.startsWith('https://')) return { start, done: null };
  const state = cookieOf(start.raw, '__Host-tg_oa');
  const nonce = new URL(start.location).searchParams.get('state');
  const done = await req(env, 'GET', `/api/auth/oauth/${provider}/callback?code=x&state=${nonce}`, { ip, cookie: '__Host-tg_oa=' + state, origin: null });
  return { start, done, rt: done.rt, pend: cookieOf(done.raw, '__Host-tg_pend') };
}

const refresh = (env, rt, ip) => post(env, '/api/auth/refresh', { ip, cookie: '__Host-tg_rt=' + rt });
const row = (obj, id) => obj.store.sql.exec('SELECT * FROM users WHERE id = ?', id).toArray()[0];
const sql = (obj, q, ...b) => obj.store.sql.exec(q, ...b).toArray();
const count = (obj, q, ...b) => Number(sql(obj, q, ...b)[0].n);
const nowS = () => Math.floor(Date.now() / 1000);
const session = (id, name, extra) => AUTH.signJwt(SECRET, { typ: 's', sub: id, name, iat: nowS(), exp: nowS() + 600, acct: 1, ...extra });
/** A mail's link token of `kind` (its text part). */
const linkIn = (m, kind) => new RegExp(`/account#${kind}=([A-Za-z0-9_-]+)`).exec(m.text)?.[1] ?? null;
const codeIn = (m) => /^(\d{6})$/m.exec(m.text)?.[1] ?? null;

/** An account made straight in the store: a current password (KEY) unless `pw: false`, a verified address, providers. */
async function account(obj, name, { email, google, discord, pw = true } = {}) {
  const rec = await A.newPasswordRecord(KEY, 2);
  const id = obj.store.register(name, rec, [], 'f'.repeat(63) + String(name.length % 10), Date.now()).userId;
  obj.store.sql.exec('DELETE FROM refresh WHERE user_id = ?', id);
  if (!pw) obj.store.sql.exec('UPDATE users SET pw_hash = NULL, pw_salt = NULL, pw_iter = NULL, pw_v = 0 WHERE id = ?', id);
  if (google) obj.store.sql.exec('UPDATE users SET google_sub = ?, google_linked_at = ? WHERE id = ?', google, Date.now(), id);
  if (discord) obj.store.sql.exec('UPDATE users SET discord_id = ?, discord_linked_at = ? WHERE id = ?', discord, Date.now(), id);
  if (email) assert.equal(obj.store.claimEmail(id, email, 'mail', Date.now()), 'ok');
  return id;
}

/** A password account, signed in by email just now (level 2): its id, session and refresh token. */
async function signedInAccount(env, obj, name, email, ip, opts = {}) {
  const id = await account(obj, name, { email, ...opts });
  const s = await signin(env, email, ip);
  assert.equal(s.status, 200, JSON.stringify(s.json));
  return { id, session: s.json.session, rt: s.rt };
}

// ---- the request (§2.10) ----------------------------------------------------------------------------

test('deletion: a password account needs level 2 within 10 minutes and its name typed; then the purge date, every device signed out, the news withdrawn and M9 with its cancel link in both languages', async () => {
  const { env, obj, outbox } = makeEnv();
  const ip = ips();
  const { id, session: s2, rt } = await signedInAccount(env, obj, 'Ana', 'ana@example.com', ip(0), { discord: 'd-ana' });
  obj.store.sql.exec("INSERT INTO consents (user_id, kind, version, granted, source, at) VALUES (?, 'news', 'news-v1', 1, 'signup', ?)", id, Date.now());
  // A second device, by Discord's press: level 1, below what a password account can reach.
  const viaDiscord = await refresh(env, (await oauth(env, 'discord', 'd-ana', { ip: ip(1) })).rt, ip(1));
  assert.equal(viaDiscord.json.authLvl, 1);
  const lvl1 = await del(env, viaDiscord.json.session, 'Ana', ip(1));
  assert.deepEqual([lvl1.status, lvl1.json.error, lvl1.json.level], [403, 'reauth_required', 2]);
  // A password 11 minutes ago: not fresh any more.
  const stale = await del(env, await session(id, 'Ana', { aat: nowS() - 11 * 60, aal: 2 }), 'Ana', ip(0));
  assert.deepEqual([stale.status, stale.json.error, stale.json.level], [403, 'reauth_required', 2]);
  // The name typed wrong; case and surrounding spaces do not matter.
  const wrong = await del(env, s2, 'Anna', ip(0));
  assert.deepEqual([wrong.status, wrong.json.error], [400, 'bad_confirm']);
  assert.equal((await del(env, s2, undefined, ip(0))).json.error, 'bad_confirm');
  assert.equal(row(obj, id).delete_purge_at, 0, 'no refusal writes anything');
  assert.equal(outbox.length, 0, 'nor mails');
  const before = Date.now();
  const r = await del(env, s2, '  ana ', ip(0));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(Object.keys(r.json), ['purgeAt']);
  assert.ok(r.json.purgeAt >= before + GRACE && r.json.purgeAt <= Date.now() + GRACE, 'DELETE_GRACE: 14 days');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.ok(setCookies(r.raw).some((c) => /^__Host-tg_rt=;.*Max-Age=0/.test(c)), 'this device forgets its cookie');
  const u = row(obj, id);
  assert.deepEqual([u.delete_purge_at, u.delete_requested_at > 0], [r.json.purgeAt, true]);
  assert.equal(count(obj, 'SELECT COUNT(*) AS n FROM refresh WHERE user_id = ?', id), 0, 'every family revoked');
  assert.equal((await refresh(env, rt, ip(0))).status, 401, "this device's own token is dead");
  assert.equal((await refresh(env, viaDiscord.rt, ip(1))).status, 401, "and the other device's");
  const news = sql(obj, "SELECT granted, source FROM consents WHERE user_id = ? AND kind = 'news' ORDER BY id DESC LIMIT 1", id)[0];
  assert.deepEqual(news, { granted: 0, source: 'deletion' }, 'the newest news row is a withdrawal');
  // M9: to the address, both languages (the account's first), the cancel link in the fragment.
  assert.equal(outbox.length, 1);
  const m = outbox[0];
  assert.equal(m.to, 'ana@example.com');
  assert.match(m.subject, /se borra el .* · .*will be deleted on/);
  assert.ok(m.text.includes('Pediste borrar tu cuenta') && m.text.includes('You asked to delete your account'));
  const token = linkIn(m, 'keep');
  assert.ok(token, 'M9 carries /account#keep=<token>');
  const cancelRow = sql(obj, "SELECT * FROM mail_tokens WHERE user_id = ? AND purpose = 'cancel_delete'", id);
  assert.equal(cancelRow.length, 1);
  assert.equal(cancelRow[0].expires_at, r.json.purgeAt, 'the link lives until the purge');
  assert.notEqual(cancelRow[0].hash, token, 'only its hash is stored');
  // The Bearer still runs out its hour: /api/me says when; a second request is 409.
  const me = await req(env, 'GET', '/api/me', { ip: ip(0), bearer: s2 });
  assert.equal(me.json.deletionAt, r.json.purgeAt);
  assert.equal(me.json.news, false);
  const again = await del(env, s2, 'Ana', ip(0));
  assert.deepEqual([again.status, again.json.error, again.json.purgeAt], [409, 'deletion_pending', r.json.purgeAt]);
  assert.equal(outbox.length, 1, 'no second M9');
});

test('deletion: a Discord-only account without an email deletes at level 1, its ceiling (no M9: no address); level 0 is asked for level 1; a TV is refused', async () => {
  const { env, obj, outbox } = makeEnv();
  const ip = ips();
  const id = await account(obj, 'Dora', { pw: false, discord: 'd-dora' });
  const o = await oauth(env, 'discord', 'd-dora', { ip: ip(0) });
  assert.equal(o.done.location, '/#auth=ok');
  const s = await refresh(env, o.rt, ip(0));
  assert.equal(s.json.authLvl, 1);
  const none = await del(env, await session(id, 'Dora', {}), 'Dora', ip(0));
  assert.deepEqual([none.status, none.json.error, none.json.level], [403, 'reauth_required', 1], 'nothing proved: level 1 is what it can show');
  const tv = await del(env, await session(id, 'Dora', { tv: 1 }), 'Dora', ip(0));
  assert.deepEqual([tv.status, tv.json.error], [403, 'tv_session']);
  const r = await del(env, s.json.session, 'Dora', ip(0));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(outbox.length, 0);
  assert.equal(count(obj, "SELECT COUNT(*) AS n FROM mail_tokens WHERE user_id = ? AND purpose = 'cancel_delete'", id), 0, 'no cancel row without an address');
  assert.ok(row(obj, id).delete_purge_at > 0);
});

test('deletion: the project account (NODE_TRUSTED_OPERATORS) gets 409 maintainer_account and nothing changes; a guest 403; mail off refuses an account with an address (503, nothing changes) and not one without', async () => {
  const { env, obj, outbox, flags } = makeEnv();
  const ip = ips();
  const p = await signedInAccount(env, obj, 'Proyecto', 'proyecto@example.com', ip(0));
  env.NODE_TRUSTED_OPERATORS = p.id;
  const r = await del(env, p.session, 'Proyecto', ip(0));
  assert.deepEqual([r.status, r.json.error], [409, 'maintainer_account']);
  assert.equal(row(obj, p.id).delete_purge_at, 0);
  assert.ok(count(obj, 'SELECT COUNT(*) AS n FROM refresh WHERE user_id = ?', p.id) > 0, 'still signed in');
  const guest = await post(env, '/api/guest', { ip: ip(1), body: {} });
  assert.equal((await del(env, guest.json.session, 'x', ip(1))).status, 403);
  // The kill flag: M9 could not go, so the request waits.
  const a = await signedInAccount(env, obj, 'Ana', 'ana@example.com', ip(2));
  flags.set('email_off', '1');
  const off = await del(env, a.session, 'Ana', ip(2));
  assert.deepEqual([off.status, off.json.error], [503, 'email_paused']);
  assert.equal(row(obj, a.id).delete_purge_at, 0);
  assert.equal(outbox.length, 0);
  const d = await account(obj, 'Dora', { pw: false, discord: 'd-dora2' });
  const ds = await refresh(env, (await oauth(env, 'discord', 'd-dora2', { ip: ip(3) })).rt, ip(3));
  assert.equal((await del(env, ds.json.session, 'Dora', ip(3))).status, 200, 'no address, no M9 to wait for');
  assert.ok(row(obj, d).delete_purge_at > 0);
});

test('deletion: DELETE_GRACE (env.ts deleteGraceMs) takes whole days from 1 to 60, else 14; the route limits (limits.ts accountGate)', async () => {
  for (const [v, days] of [[undefined, 14], ['14', 14], [7, 7], [' 3 ', 3], ['0', 14], [61, 14], ['2.5', 14], ['x', 14], [1, 1], ['60', 60]]) assert.equal(ENV.deleteGraceMs({ DELETE_GRACE: v }), days * DAY, String(v));
  assert.deepEqual(L.accountGate('POST', '/api/me/delete'), ['authAcct']);
  assert.deepEqual(L.accountGate('POST', '/api/auth/delete/cancel'), ['authCode', 'signInSite']);
  const { env, obj } = makeEnv({ DELETE_GRACE: '3' });
  const ip = ips();
  const a = await signedInAccount(env, obj, 'Ana', 'ana@example.com', ip(0));
  const r = await del(env, a.session, 'Ana', ip(0));
  assert.ok(Math.abs(r.json.purgeAt - (Date.now() + 3 * DAY)) < 5_000);
});

test('deletion: closed until the terms of service (DELETION_OPEN, "0" in wrangler.jsonc): POST /api/me/delete answers 404 not_found as an unknown route and changes nothing; the way back stays live; "1" opens it', async () => {
  const { env, obj, outbox } = makeEnv({ DELETION_OPEN: undefined });
  const ip = ips();
  const a = await signedInAccount(env, obj, 'Ana', 'ana@example.com', ip(0));
  const closed = await del(env, a.session, 'Ana', ip(0));
  assert.deepEqual([closed.status, closed.json.error], [404, 'not_found']);
  const unknown = await post(env, '/api/me/no-such-route', { ip: ip(0), bearer: a.session });
  assert.deepEqual([unknown.status, unknown.json.error], [404, 'not_found'], 'the same answer as a route that does not exist');
  assert.equal(row(obj, a.id).delete_purge_at, 0, 'not pending');
  assert.ok(count(obj, 'SELECT COUNT(*) AS n FROM refresh WHERE user_id = ?', a.id) > 0, 'still signed in');
  assert.equal(count(obj, "SELECT COUNT(*) AS n FROM consents WHERE user_id = ? AND source = 'deletion'", a.id), 0);
  assert.equal(outbox.length, 0, 'no M9');
  assert.equal((await signin(env, 'ana@example.com', ip(0))).status, 200, 'signs in as ever');
  env.DELETION_OPEN = '1';
  const open = await del(env, a.session, 'Ana', ip(0));
  assert.equal(open.status, 200, JSON.stringify(open.json));
  assert.ok(row(obj, a.id).delete_purge_at > 0);
  // Closed again (a rollback of the var): a deletion already pending can still be called off.
  env.DELETION_OPEN = '0';
  const c = await post(env, '/api/auth/delete/cancel', { ip: ip(0), body: { token: linkIn(outbox.at(-1), 'keep') } });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.equal(row(obj, a.id).delete_purge_at, 0);
  // The switch: only '1' opens it, and the committed wrangler.jsonc keeps production closed.
  for (const v of [undefined, '', '0', 'true', 1, ' 1 ', '1']) assert.equal(ENV.deletionOpen({ DELETION_OPEN: v }), v === '1' || v === ' 1 ' || v === 1, String(v));
  assert.match(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'), /\n\s*"DELETION_OPEN": "0"\s*\n/, 'production keeps it closed');
});

test("deletion: M9 counts in the account's own caps (§2.16: 5 notices a day, 10 /api/me/* mails), taken before anything changes; a loop of requests and cancels with one Bearer stops at the 6th, and the day's notice lane stays for everyone else", async () => {
  const { env, obj, outbox } = makeEnv({ EMAIL_DAILY_CAP: '20' });
  const ip = ips();
  const a = await signedInAccount(env, obj, 'Ciclo', 'ciclo@example.com', ip(0));
  const window = async (kind, id) => obj.store.mailWindows([await obj.throttleKey(kind, id)]).get(await obj.throttleKey(kind, id))?.day_n ?? 0;
  // A refusal before the caps (the name typed wrong) takes none of them. (7 requests in all: below authAcct's 10 a minute.)
  assert.equal((await del(env, a.session, 'Otro', ip(0))).json.error, 'bad_confirm');
  for (let i = 0; i < 5; i++) {
    const r = await del(env, a.session, 'Ciclo', ip(0));
    assert.equal(r.status, 200, `request ${i + 1}: ${JSON.stringify(r.json)}`);
    const c = await post(env, '/api/auth/delete/cancel', { ip: ip(0), body: { token: linkIn(outbox.at(-1), 'keep') } });
    assert.equal(c.status, 200, JSON.stringify(c.json));
  }
  assert.deepEqual([await window('nt', a.id), await window('ma', a.id), await window('dq', a.id)], [5, 5, 5], 'each request took one slot of each cap, the refusals none');
  const sixth = await del(env, a.session, 'Ciclo', ip(0));
  assert.deepEqual([sixth.status, sixth.json.error], [429, 'email_rate_limited'], JSON.stringify(sixth.json));
  assert.ok(sixth.json.retryAfterMs > 23 * 3_600_000, 'until its 24 hours end');
  assert.equal(row(obj, a.id).delete_purge_at, 0, 'not pending: nothing changed');
  assert.equal(count(obj, "SELECT COUNT(*) AS n FROM consents WHERE user_id = ? AND source = 'deletion'", a.id), 5, 'no sixth consent row');
  assert.equal(outbox.length, 5, 'five M9, no sixth');
  assert.equal(sql(obj, "SELECT sent FROM mail_day WHERE lane = 'notice'")[0].sent, 5, 'the notice lane counted five');
  // The lane (20 a day here) still has room for another player's sign-up code and reset.
  const st = await post(env, '/api/auth/signup/start', { ip: ip(3), body: { email: 'nuevo@example.com', lang: 'es', ...TOK } });
  assert.equal(st.status, 200, JSON.stringify(st.json));
  // Another account whose /api/me/* mail is spent for the day (10): its request waits, nothing changes.
  const b = await signedInAccount(env, obj, 'Bea', 'bea@example.com', ip(1));
  obj.store.mailWindowsWrite(new Map([[await obj.throttleKey('ma', b.id), { hour_at: Date.now(), hour_n: 0, day_at: Date.now(), day_n: 10 }]]));
  const full = await del(env, b.session, 'Bea', ip(1));
  assert.deepEqual([full.status, full.json.error], [429, 'email_rate_limited']);
  assert.equal(row(obj, b.id).delete_purge_at, 0);
  assert.equal(await window('nt', b.id), 0, 'a refusal counts nothing');
  // An account without an address sends no M9: DELETION_REQUESTS (5 a day) still bounds its requests.
  assert.deepEqual(DELETION_REQUESTS, { day: 5 });
  const d = await account(obj, 'Dora', { pw: false, discord: 'd-dora-caps' });
  const ds = await refresh(env, (await oauth(env, 'discord', 'd-dora-caps', { ip: ip(2) })).rt, ip(2));
  obj.store.mailWindowsWrite(new Map([[await obj.throttleKey('dq', d), { hour_at: Date.now(), hour_n: 0, day_at: Date.now(), day_n: 5 }]]));
  const dq = await del(env, ds.json.session, 'Dora', ip(2));
  assert.deepEqual([dq.status, dq.json.error], [429, 'rate_limited']);
  assert.equal(row(obj, d).delete_purge_at, 0);
  assert.equal(outbox.length, 5 + 1, 'only the sign-up code went since');
});

// ---- while it is pending: the ways back (§2.10, §3.13 step 2) --------------------------------------------

test('pending: signin answers deletion_pending { purgeAt } only after the right password; sent again with cancelDeletion it calls the deletion off and signs in; M9 is then dead', async () => {
  const { env, obj, outbox } = makeEnv();
  const ip = ips();
  const a = await signedInAccount(env, obj, 'Ana', 'ana@example.com', ip(0));
  const purgeAt = (await del(env, a.session, 'Ana', ip(0))).json.purgeAt;
  const token = linkIn(outbox.at(-1), 'keep');
  const bad = await signin(env, 'ana@example.com', ip(1), {}, 'e'.repeat(64));
  assert.deepEqual([bad.status, bad.json.error], [401, 'bad_credentials'], 'nothing said before the password');
  const p = await signin(env, 'ana@example.com', ip(1));
  assert.deepEqual([p.status, p.json.error, p.json.purgeAt], [409, 'deletion_pending', purgeAt]);
  assert.equal(p.rt, null, 'no session');
  assert.equal(count(obj, 'SELECT COUNT(*) AS n FROM refresh WHERE user_id = ?', a.id), 0);
  const c = await signin(env, 'ana@example.com', ip(1), { cancelDeletion: true });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.ok(c.rt);
  assert.deepEqual([row(obj, a.id).delete_purge_at, row(obj, a.id).delete_requested_at], [0, 0]);
  assert.equal((await post(env, '/api/auth/delete/cancel', { ip: ip(2), body: { token } })).status, 200, 'the same deletion: called off already, within 10 minutes it says ok');
  // A new request supersedes the old link: it never calls off a later deletion.
  assert.equal((await del(env, c.json.session, 'Ana', ip(1))).status, 200);
  const late = await post(env, '/api/auth/delete/cancel', { ip: ip(2), body: { token } });
  assert.deepEqual([late.status, late.json.error], [410, 'link_invalid']);
  // A signin with cancelDeletion of an account with nothing pending is a plain sign-in.
  const b = await signedInAccount(env, obj, 'Bea', 'bea@example.com', ip(3));
  assert.equal((await signin(env, 'bea@example.com', ip(3), { cancelDeletion: true })).status, 200);
  assert.equal(row(obj, b.id).delete_purge_at, 0);
});

test("pending: M9's link calls the deletion off (200), the same link again within 10 minutes is ok, later or a forged one 410 link_invalid; the account then signs in", async () => {
  const { env, obj, outbox } = makeEnv();
  const ip = ips();
  const a = await signedInAccount(env, obj, 'Ana', 'ana@example.com', ip(0));
  await del(env, a.session, 'Ana', ip(0));
  const token = linkIn(outbox.at(-1), 'keep');
  for (const forged of ['A'.repeat(43), 'short', undefined]) {
    const f = await post(env, '/api/auth/delete/cancel', { ip: ip(1), body: { token: forged } });
    assert.ok([400, 410].includes(f.status), String(forged));
  }
  assert.ok(row(obj, a.id).delete_purge_at > 0);
  // GET never consumes (a mail scanner's prefetch): only the POST.
  const noGet = await req(env, 'GET', '/api/auth/delete/cancel', { ip: ip(1) });
  assert.equal(noGet.status, 404);
  const ok = await post(env, '/api/auth/delete/cancel', { ip: ip(1), body: { token } });
  assert.deepEqual([ok.status, ok.json], [200, { ok: true }]);
  assert.equal(row(obj, a.id).delete_purge_at, 0);
  assert.equal((await post(env, '/api/auth/delete/cancel', { ip: ip(1), body: { token } })).status, 200, 'a lost answer, POSTed again');
  obj.now = () => Date.now() + 11 * 60_000;
  assert.equal((await post(env, '/api/auth/delete/cancel', { ip: ip(1), body: { token } })).status, 410);
  obj.now = () => Date.now();
  assert.equal((await signin(env, 'ana@example.com', ip(2))).status, 200);
  // Another origin cannot post it (every POST /api/auth/*).
  assert.equal((await post(env, '/api/auth/delete/cancel', { ip: ip(1), origin: 'https://evil.example', body: { token } })).status, 403);
});

test('pending: the OAuth callback says /#auth=error:deletion_pending and signs nobody in; cancelDel=1 calls it off and signs in; the legacy login and a recovery code too', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const d = await account(obj, 'Dora', { pw: false, discord: 'd-dora' });
  const s = await refresh(env, (await oauth(env, 'discord', 'd-dora', { ip: ip(0) })).rt, ip(0));
  assert.equal((await del(env, s.json.session, 'Dora', ip(0))).status, 200);
  const o = await oauth(env, 'discord', 'd-dora', { ip: ip(1) });
  assert.equal(o.done.location, '/#auth=error:deletion_pending');
  assert.equal(o.rt, null);
  const c = await oauth(env, 'discord', 'd-dora', { ip: ip(1), query: '?cancelDel=1' });
  assert.equal(c.done.location, '/#auth=ok');
  assert.ok(c.rt);
  assert.equal(row(obj, d).delete_purge_at, 0);
  // A username of before (no address): its password is the only way back.
  const code = A.newRecoveryCode();
  const leg = obj.store.register('Viejo', await A.newPasswordRecord(KEY, 2), [await A.recoveryCodeHash(code)], 'e'.repeat(64), Date.now()).userId;
  const login = (extra = {}, passwordV2 = KEY) => post(env, '/api/auth/login', { ip: ip(2), body: { username: 'Viejo', passwordV2, ...TOK, ...extra } });
  const l = await login();
  assert.equal(l.status, 200, JSON.stringify(l.json));
  assert.equal((await del(env, l.json.session, 'viejo', ip(2))).status, 200);
  assert.deepEqual([(await login()).status, (await login()).json.error], [409, 'deletion_pending']);
  assert.equal((await login({}, 'e'.repeat(64))).status, 401);
  // A recovery code sets the password and signs nothing in; that password then calls the deletion off.
  const rec = await post(env, '/api/auth/recover', { ip: ip(2), body: { username: 'Viejo', code, passwordV2: NEW_KEY, ...TOK } });
  assert.deepEqual([rec.status, rec.json.error], [409, 'deletion_pending']);
  assert.equal(rec.rt, null);
  assert.equal(count(obj, 'SELECT COUNT(*) AS n FROM refresh WHERE user_id = ?', leg), 0);
  const back = await login({ cancelDeletion: true }, NEW_KEY);
  assert.equal(back.status, 200, JSON.stringify(back.json));
  assert.equal(row(obj, leg).delete_purge_at, 0);
});

test('pending: a reset link and an email undo set the password and answer deletion_pending with no session (M4 still goes, never in the answer); the new password with cancelDeletion signs in', async () => {
  const { env, obj, outbox } = makeEnv();
  const ip = ips();
  const a = await signedInAccount(env, obj, 'Ana', 'ana@example.com', ip(0));
  await del(env, a.session, 'Ana', ip(0));
  assert.equal((await post(env, '/api/auth/forgot', { ip: ip(1), body: { email: 'ana@example.com', lang: 'es', ...TOK } })).status, 200);
  const token = linkIn(outbox.at(-1), 'reset');
  assert.ok(token, 'forgot still mails a reset link: the way back for a forgotten password');
  const n = outbox.length;
  const r = await post(env, '/api/auth/reset', { ip: ip(1), body: { token, password: NEW_KEY } });
  assert.deepEqual([r.status, r.json.error, typeof r.json.purgeAt], [409, 'deletion_pending', 'number']);
  assert.equal('mail' in r.json, false, 'the mail order never reaches the client');
  assert.equal(r.rt, null);
  assert.equal(outbox.length, n + 1, 'M4 (password changed) went');
  assert.match(outbox.at(-1).subject, /contraseña/i);
  assert.equal((await signin(env, 'ana@example.com', ip(1), {}, KEY)).status, 401, 'the old password is gone');
  assert.equal((await signin(env, 'ana@example.com', ip(1), { cancelDeletion: true }, NEW_KEY)).status, 200);
  // An email change's undo: the owner takes the address back with a new password, then calls the deletion off.
  const b = await signedInAccount(env, obj, 'Bea', 'bea@example.com', ip(2));
  const st = await post(env, '/api/me/email', { ip: ip(2), bearer: b.session, body: { email: 'bea.nueva@example.com', lang: 'es' } });
  assert.equal(st.status, 200, JSON.stringify(st.json));
  const v = await post(env, '/api/me/email/verify', { ip: ip(2), bearer: b.session, cookie: '__Host-tg_rt=' + b.rt, body: { attempt: st.json.attempt, code: codeIn(outbox.at(-1)) } });
  assert.equal(v.status, 200, JSON.stringify(v.json));
  const undo = linkIn(outbox.find((m) => m.to === 'bea@example.com' && linkIn(m, 'undo')), 'undo');
  assert.ok(undo);
  assert.equal((await del(env, b.session, 'Bea', ip(2))).status, 200);
  const u = await post(env, '/api/auth/email/undo', { ip: ip(3), body: { token: undo, password: NEW_KEY } });
  assert.deepEqual([u.status, u.json.error], [409, 'deletion_pending']);
  assert.equal(u.rt, null);
  assert.equal(row(obj, b.id).email, 'bea@example.com', 'the address is back');
  assert.equal((await signin(env, 'bea@example.com', ip(3), { cancelDeletion: true }, NEW_KEY)).status, 200);
  assert.equal(row(obj, b.id).delete_purge_at, 0);
});

test('pending: the Bearer left alive approves no TV, cannot queue ranked, links nothing; the account leaves the leaderboard; a TV never calls a deletion off', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const a = await signedInAccount(env, obj, 'Ana', 'ana@example.com', ip(0));
  obj.store.sql.exec('INSERT INTO ratings (user_id, playlist, season, mu, sigma, games, wins) VALUES (?, ?, 1, 40, 2, ?, 3)', a.id, '1v1', PLACEMENT_MATCHES + 1);
  assert.deepEqual(obj.store.leaderboard('1v1', 10, null).entries.map((e) => e.name), ['Ana']);
  const tvStart = (await post(env, '/api/auth/tv/start', { ip: ip(1) })).json;
  assert.equal((await del(env, a.session, 'Ana', ip(0))).status, 200);
  const conf = await post(env, '/api/auth/tv/confirm', { ip: ip(0), bearer: a.session, body: { code: tvStart.code } });
  assert.deepEqual([conf.status, conf.json.error], [409, 'deletion_pending']);
  const rc = await A.accountsCall(env, '/ranked-check', { userId: a.id, playlists: ['1v1'] });
  assert.deepEqual([rc.status, (await rc.json()).error], [409, 'deletion_pending']);
  assert.deepEqual(obj.store.leaderboard('1v1', 10, null).entries, [], 'hidden from the leaderboard');
  // A TV the phone approved before the request: its poll gets no session, and the deletion stays.
  obj.store.sql.exec('UPDATE users SET delete_purge_at = 0, delete_requested_at = 0 WHERE id = ?', a.id);
  const tv2 = (await post(env, '/api/auth/tv/start', { ip: ip(1) })).json;
  assert.equal((await post(env, '/api/auth/tv/confirm', { ip: ip(0), bearer: a.session, body: { code: tv2.code } })).status, 200);
  obj.store.sql.exec('UPDATE users SET delete_purge_at = ?, delete_requested_at = ? WHERE id = ?', Date.now() + GRACE, Date.now(), a.id);
  const poll = await post(env, '/api/auth/tv/poll', { ip: ip(1), body: { code: tv2.code, secret: tv2.secret } });
  assert.equal(poll.status, 410);
  assert.ok(row(obj, a.id).delete_purge_at > 0);
  assert.equal(obj.store.linkPending(a.id, { p: 'google', id: 'g-x', email: null, trust: 'none' }, Date.now()), 'no_user');
  assert.equal(row(obj, a.id).google_sub, null);
});

// ---- the purge (§3.13 step 3) -----------------------------------------------------------------------------

/** A row in every table an account has (and its mailed rows: one of its own, a sign-up row it was made from). */
function seed(obj, id, tag, at) {
  const x = (q, ...b) => obj.store.sql.exec(q, ...b);
  obj.store.addRefresh(id, (tag + 'r').padEnd(64, '0').replace(/[^0-9a-f]/g, 'a'), at);
  x('INSERT INTO ratings (user_id, playlist, season, mu, sigma, games) VALUES (?, ?, 1, 25, 8, 3)', id, '2v2');
  x("INSERT INTO ranked_players (match_id, user_id, team, left_match, outcome, mu_before, sigma_before, mu_after, sigma_after, games_after) VALUES (?, ?, 0, 0, 'win', 25, 8, 26, 7, 1)", 'm-' + tag, id);
  x('INSERT INTO abandons (user_id, at, match_id) VALUES (?, ?, ?)', id, at - 60_000, 'a-' + tag);
  x('INSERT INTO bans (user_id, until) VALUES (?, ?)', id, at + 2 * 3_600_000);
  x('INSERT INTO ranked_locks (user_id, match_id, region, until) VALUES (?, ?, ?, ?)', id, 'l-' + tag, 'SA', at + 30 * 60_000);
  x('INSERT INTO training (user_id, pack_id, best, shots) VALUES (?, ?, 3, 5)', id, 'pack-' + tag);
  x('INSERT INTO experimental (user_id, enabled, updated_at) VALUES (?, 1, ?)', id, at);
  x("INSERT INTO presets (user_id, preset_id, name, data, created_at, updated_at) VALUES (?, ?, 'p', '{}', ?, ?)", id, 'p-' + tag, at, at);
  x("INSERT INTO loadout (user_id, car, updated_at) VALUES (?, 'octane', ?)", id, at);
  x("INSERT INTO host_credits (match_id, user_id, node_id, points, verified, at) VALUES (?, ?, 'n1', 2, 1, ?)", 'h-' + tag, id, at);
  x("INSERT INTO host_claims (user_id, item_id, cost, at, source) VALUES (?, 'badge', 0, ?, 'claim')", id, at);
  x("INSERT INTO host_freeze (user_id, reason, at) VALUES (?, 'x', ?)", id, at);
  x("INSERT INTO consents (user_id, kind, version, granted, source, at) VALUES (?, 'terms', 't1', 1, 'signup', ?)", id, at);
  x("INSERT INTO mail_tokens (hash, nonce, purpose, user_id, email, email_canon, created_at, expires_at) VALUES (?, 'n', 'reset', ?, 'x@x.com', 'x@x.com', ?, ?)", 'mt-' + tag, id, at, at + DAY);
  x("INSERT INTO mail_tokens (hash, nonce, purpose, user_id, email, email_canon, created_at, expires_at, used_at, used_by) VALUES (?, 'n', 'signup', NULL, '', '', ?, ?, ?, ?)", 'su-' + tag, at, at + DAY, at, id);
  x('INSERT INTO email_holds (canon, user_id, email, until) VALUES (?, ?, ?, ?)', 'old-' + tag + '@x.com', id, 'old-' + tag + '@x.com', at + DAY);
  x('INSERT INTO replay_names (user_id, hidden, updated_at) VALUES (?, 1, ?)', id, at);
  x('INSERT INTO legacy_reminders (user_id, cutoff, at) VALUES (?, 1, ?)', id, at);
  x("INSERT INTO protected_skel (skel, user_id, why) VALUES (?, ?, 'top:1v1')", 'skel-' + tag, id);
}

const TABLES = ['refresh', 'ratings', 'ranked_players', 'abandons', 'bans', 'ranked_locks', 'training', 'experimental', 'presets', 'loadout', 'host_credits', 'host_claims', 'host_freeze', 'consents', 'email_holds', 'replay_names', 'legacy_reminders', 'protected_skel'];
/** How many rows of every table belong to `id`. */
function rowsOf(obj, id) {
  const out = { users: count(obj, 'SELECT COUNT(*) AS n FROM users WHERE id = ?', id), mail_tokens: count(obj, 'SELECT COUNT(*) AS n FROM mail_tokens WHERE user_id = ? OR used_by = ?', id, id) };
  for (const t of TABLES) out[t] = count(obj, `SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`, id);
  return out;
}

/** An account whose deletion was asked for through the route (level 2 by its password). */
async function requested(env, obj, name, email, ip, opts) {
  const a = await signedInAccount(env, obj, name, email, ip, opts);
  const r = await del(env, a.session, name, ip);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { ...a, purgeAt: r.json.purgeAt };
}

test('the purge: due accounts only; it empties every table of §3.13 for that id (and the rows born after the list), touches nothing of another account, and writes the tombstone', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const a = await requested(env, obj, 'Ana', 'ana@example.com', ip(0), { google: 'g-ana', discord: 'd-ana' });
  const b = await signedInAccount(env, obj, 'Bea', 'bea@example.com', ip(1), { discord: 'd-bea' });
  const at = a.purgeAt + 1;
  seed(obj, a.id, 'a', at);
  seed(obj, b.id, 'b', at);
  const bBefore = rowsOf(obj, b.id);
  const bRow = row(obj, b.id);
  assert.ok(Object.values(rowsOf(obj, a.id)).every((n) => n >= 1), JSON.stringify(rowsOf(obj, a.id)));
  // A day early: nothing.
  assert.deepEqual(await obj.purgeDue(a.purgeAt - DAY), { purged: [], more: false });
  assert.equal(rowsOf(obj, a.id).users, 1);
  const r = await obj.purgeDue(at);
  assert.deepEqual(r, { purged: [a.id], more: false });
  assert.deepEqual(rowsOf(obj, a.id), Object.fromEntries(Object.keys(rowsOf(obj, a.id)).map((k) => [k, 0])), 'every row of the account');
  assert.deepEqual(rowsOf(obj, b.id), bBefore, 'nothing of the other account');
  assert.deepEqual(row(obj, b.id), bRow);
  assert.deepEqual(sql(obj, 'SELECT id FROM deleted_ids'), [{ id: a.id }], 'the tombstone');
  assert.equal(count(obj, "SELECT COUNT(*) AS n FROM users WHERE email_canon = 'ana@example.com' OR google_sub = 'g-ana' OR discord_id = 'd-ana'"), 0, 'its address and ids are free');
  // Idempotent: again, nothing more goes and nothing breaks.
  assert.deepEqual(await obj.purgeDue(at + DAY), { purged: [], more: false });
  assert.equal(obj.store.purgeAccount(a.id, new Map(), at).result, 'gone');
  assert.deepEqual(rowsOf(obj, b.id), bBefore);
  // The tombstone outlives the daily prune; a purged id's points and freezes are dropped; its name hides in the public replays.
  obj.store.prune(at + 400 * DAY);
  assert.equal(obj.store.isDeleted(a.id), true);
  assert.equal(obj.store.hostCredit({ matchId: 'z'.repeat(64), userId: a.id, nodeId: 'n1', points: 3, verified: true, at }), false);
  assert.equal(obj.store.hostFreeze(a.id, 'x', at), false);
  assert.equal(rowsOf(obj, a.id).host_credits + rowsOf(obj, a.id).host_freeze, 0);
  assert.deepEqual(obj.store.replayHidden([a.id, b.id, 'guest-1'], []).ids, [a.id, b.id], 'a purged id reads as hidden (Bea hid hers)');
});

test('the purge marks a sanction: a ban, a live ranked lock or abandons that still weigh leave one HMAC-keyed mark per canon (its own, its hint, a held one) and provider id, until it ends, a year at most; none without one', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const a = await requested(env, obj, 'Ana', 'ana@example.com', ip(0), { google: 'g-ana', discord: 'd-ana' });
  const at = a.purgeAt + 1;
  obj.store.sql.exec("UPDATE users SET email_hint = 'ana.d@example.org', email_hint_canon = 'ana.d@example.org', email_hint_from = 'discord' WHERE id = ?", a.id);
  obj.store.sql.exec('INSERT INTO email_holds (canon, user_id, email, until) VALUES (?, ?, ?, ?)', 'ana.vieja@example.com', a.id, 'ana.vieja@example.com', at + DAY);
  obj.store.sql.exec('INSERT INTO bans (user_id, until) VALUES (?, ?)', a.id, at + 2 * 3_600_000);
  obj.store.sql.exec('INSERT INTO ranked_locks (user_id, match_id, region, until) VALUES (?, ?, ?, ?)', a.id, 'm1', 'SA', at + 30 * 60_000);
  for (let i = 0; i < 3; i++) obj.store.sql.exec('INSERT INTO abandons (user_id, at, match_id) VALUES (?, ?, ?)', a.id, at - 3_600_000 + i, 'm' + i);
  // One abandon out of the window weighs nothing.
  obj.store.sql.exec('INSERT INTO abandons (user_id, at, match_id) VALUES (?, ?, ?)', a.id, at - ABANDON_WINDOW_MS - 1, 'old');
  const r = obj.store.purgeCandidates(at, 10);
  assert.deepEqual(r.map((c) => c.userId), [a.id]);
  assert.deepEqual(r[0].values.sort(), [['d', 'd-ana'], ['e', 'ana.d@example.org'], ['e', 'ana.vieja@example.com'], ['e', 'ana@example.com'], ['g', 'g-ana']]);
  assert.deepEqual((await obj.purgeDue(at)).purged, [a.id]);
  const marks = sql(obj, 'SELECT * FROM sanction_marks ORDER BY key');
  assert.equal(marks.length, 5, 'one per key');
  for (const m of marks) {
    assert.match(m.key, /^[egd]:[0-9a-f]{32}$/);
    assert.deepEqual([m.until, m.ban_until, m.lock_until, m.abandons, m.at], [at - 3_600_000 + 2 + ABANDON_WINDOW_MS, at + 2 * 3_600_000, at + 30 * 60_000, 3, at]);
  }
  const all = JSON.stringify(sql(obj, 'SELECT * FROM sanction_marks'));
  for (const v of ['ana@example.com', 'ana.d', 'ana.vieja', 'g-ana', 'd-ana', a.id]) assert.ok(!all.includes(v), 'no ' + v + ' at rest');
  assert.deepEqual(new Set(marks.map((m) => m.key[0])), new Set(['e', 'g', 'd']));
  // A suspended account (users.banned): a year, no more.
  const s = await requested(env, obj, 'Sus', 'sus@example.com', ip(1));
  obj.store.sql.exec('UPDATE users SET banned = 1 WHERE id = ?', s.id);
  const at2 = s.purgeAt + 1;
  assert.deepEqual((await obj.purgeDue(at2)).purged, [s.id]);
  const sm = sql(obj, 'SELECT * FROM sanction_marks WHERE at = ?', at2);
  assert.deepEqual(sm.map((m) => [m.until, m.ban_until]), [[at2 + 365 * DAY, at2 + 365 * DAY]]);
  // Nothing in force: no mark at all.
  const c = await requested(env, obj, 'Clara', 'clara@example.com', ip(2), { discord: 'd-clara' });
  obj.store.sql.exec('INSERT INTO bans (user_id, until) VALUES (?, ?)', c.id, c.purgeAt - 1);
  const n = count(obj, 'SELECT COUNT(*) AS n FROM sanction_marks');
  assert.deepEqual((await obj.purgeDue(c.purgeAt + 1)).purged, [c.id]);
  assert.equal(count(obj, 'SELECT COUNT(*) AS n FROM sanction_marks'), n);
  // The marks are pruned once they end; the tombstones never are.
  obj.store.prune(at2 + 366 * DAY);
  assert.equal(count(obj, 'SELECT COUNT(*) AS n FROM sanction_marks'), 0);
  assert.equal(count(obj, 'SELECT COUNT(*) AS n FROM deleted_ids'), 3);
});

test('the purge is batched (PURGE_BATCH a run, the alarm back in a minute while more are due, the daily part once a day), resumable, and skips what changed under it', async () => {
  const { env, obj, alarm } = makeEnv();
  const ip = ips();
  const t0 = Date.now();
  const ids = [];
  for (let i = 0; i < PURGE_BATCH + 5; i++) {
    const id = await account(obj, 'Jugador' + (1000 + i), { pw: false, discord: 'd-' + i });
    obj.store.sql.exec('UPDATE users SET delete_requested_at = ?, delete_purge_at = ? WHERE id = ?', t0, t0 + GRACE + i, id);
    ids.push(id);
  }
  const keep = await account(obj, 'Queda', { email: 'queda@example.com' });
  const at = t0 + GRACE + PURGE_BATCH + 10;
  let prunes = 0;
  const prune = obj.store.prune.bind(obj.store);
  obj.store.prune = (n) => {
    prunes++;
    return prune(n);
  };
  obj.now = () => at;
  await obj.alarm();
  assert.equal(prunes, 1, 'the daily part ran');
  assert.equal(count(obj, 'SELECT COUNT(*) AS n FROM deleted_ids'), PURGE_BATCH, 'one batch');
  assert.ok(alarm() - Date.now() <= PURGE_AGAIN_MS && alarm() - Date.now() > PURGE_AGAIN_MS - 5_000, 'back in a minute');
  // Its first PURGE_BATCH, the earliest first.
  assert.deepEqual(sql(obj, 'SELECT id FROM deleted_ids ORDER BY id').map((r) => r.id), ids.slice(0, PURGE_BATCH).sort());
  obj.now = () => at + PURGE_AGAIN_MS;
  await obj.alarm();
  assert.equal(prunes, 1, 'not the daily part again');
  assert.equal(count(obj, 'SELECT COUNT(*) AS n FROM deleted_ids'), PURGE_BATCH + 5);
  assert.ok(alarm() - Date.now() > 23 * 60 * 60_000, 'nothing more due: the next day');
  assert.equal(row(obj, keep).username, 'Queda');
  // Called off between the candidates' read and its transaction: not_due; a value changed: retry, nothing deleted.
  const x = await account(obj, 'Equis', { email: 'x@example.com' });
  obj.store.sql.exec('UPDATE users SET delete_requested_at = ?, delete_purge_at = ? WHERE id = ?', t0, t0 + 1, x);
  const [cand] = obj.store.purgeCandidates(at, 5);
  assert.equal(cand.userId, x);
  assert.equal(obj.store.purgeAccount(x, new Map(), at).result, 'retry');
  assert.equal(row(obj, x).username, 'Equis');
  obj.store.sql.exec('UPDATE users SET delete_purge_at = 0 WHERE id = ?', x);
  assert.equal(obj.store.purgeAccount(x, new Map([['e|x@example.com', 'e:' + '0'.repeat(32)]]), at).result, 'not_due');
  assert.equal(row(obj, x).username, 'Equis');
  // A run whose step throws still re-arms the alarm.
  obj.store.sql.exec('UPDATE users SET delete_purge_at = ? WHERE id = ?', t0 + 1, x);
  const real = obj.store.purgeAccount.bind(obj.store);
  obj.store.purgeAccount = () => {
    throw new Error('boom');
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    await obj.alarm();
  } finally {
    console.warn = warn;
    obj.store.purgeAccount = real;
  }
  assert.ok(alarm() > Date.now(), 're-armed');
  await obj.alarm();
  assert.equal(obj.store.isDeleted(x), true, 'the next run purges it');
});

test('the purge never deletes the project account: a deletion it got before it was trusted is called off', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const p = await requested(env, obj, 'Proyecto', 'proyecto@example.com', ip(0));
  env.NODE_TRUSTED_OPERATORS = p.id;
  // The list reaches the store with the next request.
  await req(env, 'GET', '/api/config', { ip: ip(1) });
  await signin(env, 'proyecto@example.com', ip(1));
  const warn = console.warn;
  const lines = [];
  console.warn = (m) => lines.push(String(m));
  try {
    assert.deepEqual((await obj.purgeDue(p.purgeAt + 1)).purged, []);
  } finally {
    console.warn = warn;
  }
  assert.equal(row(obj, p.id).delete_purge_at, 0);
  assert.equal(obj.store.isDeleted(p.id), false);
  assert.ok(lines.some((l) => l.includes('never deleted')), lines.join('\n'));
});

test('the purge never deletes the project account even when the alarm is the first event after a restart (the deploy that trusts it, or an eviction): the list reaches the store at start and on every alarm', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const p = await requested(env, obj, 'Proyecto', 'proyecto@example.com', ip(0));
  const other = await requested(env, obj, 'Otra', 'otra@example.com', ip(1));
  // The owner adds the id to NODE_TRUSTED_OPERATORS: a deploy, so a fresh object over the same storage, and no request before its alarm.
  const fresh = new AccountsDO(obj.ctx, { ...env, NODE_TRUSTED_OPERATORS: p.id });
  fresh.now = () => Math.max(p.purgeAt, other.purgeAt) + 1;
  const warn = console.warn;
  const log = console.log;
  const lines = [];
  console.warn = (m) => lines.push(String(m));
  console.log = (m) => lines.push(String(m));
  try {
    await fresh.alarm();
  } finally {
    console.warn = warn;
    console.log = log;
  }
  assert.equal(row(fresh, p.id)?.delete_purge_at, 0, 'its deletion is called off, never purged');
  assert.equal(fresh.store.isDeleted(p.id), false);
  assert.ok(lines.some((l) => l.includes('never deleted')), lines.join('\n'));
  assert.equal(fresh.store.isDeleted(other.id), true, 'the other due account is purged as usual');
  // The same with the alarm alone (an object whose start told it nothing yet, then a list that changed).
  const q = await requested(env, obj, 'Proyecto2', 'proyecto2@example.com', ip(2));
  const env3 = { ...env, NODE_TRUSTED_OPERATORS: '' };
  const later = new AccountsDO(obj.ctx, env3);
  env3.NODE_TRUSTED_OPERATORS = q.id;
  later.now = () => q.purgeAt + 1;
  console.warn = () => {};
  try {
    await later.alarm();
  } finally {
    console.warn = warn;
  }
  assert.equal(row(later, q.id)?.delete_purge_at, 0);
  assert.equal(later.store.isDeleted(q.id), false);
});

// ---- after the purge (§3.13 steps 4 and 5) -----------------------------------------------------------------

/** A sanctioned account (a queue ban for 2 hours, 3 abandons in the window) purged at `at`: what it had. */
async function purgedSanctioned(env, obj, ip, { email, discord, google }) {
  const s = await requested(env, obj, 'Castigado', email, ip, { discord, google });
  const at = s.purgeAt + 1;
  obj.store.sql.exec('INSERT INTO bans (user_id, until) VALUES (?, ?)', s.id, at + 2 * 3_600_000);
  for (let i = 0; i < 3; i++) obj.store.sql.exec('INSERT INTO abandons (user_id, at, match_id) VALUES (?, ?, ?)', s.id, at - 3_600_000, 'm' + i);
  assert.deepEqual((await obj.purgeDue(at)).purged, [s.id]);
  return { ...s, at };
}

test('after the purge: a new account with the same email (signup/finish) gets the rest of the sanction, untold; another address gets nothing', async () => {
  const { env, obj, outbox } = makeEnv();
  const ip = ips();
  const s = await purgedSanctioned(env, obj, ip(0), { email: 'castigo@example.com', discord: 'd-castigo' });
  obj.now = () => s.at + 3_600_000;
  const signUp = async (email, i) => {
    const st = await post(env, '/api/auth/signup/start', { ip: ip(i), body: { email, lang: 'es', ...TOK } });
    assert.equal(st.status, 200, JSON.stringify(st.json));
    const f = await post(env, '/api/auth/signup/finish', { ip: ip(i), body: { attempt: st.json.attempt, code: codeIn(outbox.at(-1)), username: 'Nuevo' + i, password: KEY, lang: 'es' } });
    assert.equal(f.status, 200, JSON.stringify(f.json));
    return f.json;
  };
  // Gmail-style variants share the canon: Castigo+x@... is the same address.
  const n = await signUp('castigo+otra@example.com', 1);
  assert.notEqual(n.playerId, s.id);
  const me = (await req(env, 'GET', '/api/me', { ip: ip(1), bearer: n.session })).json;
  assert.equal(me.rankedBanUntil, s.at + 2 * 3_600_000, 'the queue ban, to its end');
  assert.equal(me.abandons24h, 3, 'the abandons, in the window');
  assert.ok(!JSON.stringify(n).includes('sanction') && !JSON.stringify(me).includes('mark'), 'nothing tells the person');
  const clean = await signUp('limpio@example.com', 2);
  const me2 = (await req(env, 'GET', '/api/me', { ip: ip(2), bearer: clean.session })).json;
  assert.deepEqual([me2.rankedBanUntil, me2.abandons24h], [0, 0]);
  // Applied once: binding the same canon again (its mark's key) adds no abandons and no longer ban.
  const ekey = sql(obj, "SELECT key FROM sanction_marks WHERE key LIKE 'e:%'")[0].key;
  assert.equal(obj.store.claimEmail(n.playerId, 'castigo@example.com', 'mail', obj.now(), new Map([['e|castigo@example.com', ekey]])), 'ok');
  assert.equal(count(obj, "SELECT COUNT(*) AS n FROM abandons WHERE user_id = ? AND match_id LIKE 'mark:%'", n.playerId), 3);
  assert.equal(obj.store.banUntil(n.playerId, obj.now()), s.at + 2 * 3_600_000);
});

test('after the purge: the same Discord in a new account (the confirm step) or linked to another one, and the same Google linked, get the rest of the sanction; the ban is never shortened', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const s = await purgedSanctioned(env, obj, ip(0), { email: 'castigo@example.com', discord: 'd-castigo', google: 'g-castigo' });
  obj.now = () => s.at + 3_600_000;
  // The confirm step's CREAR with the same Discord identity.
  const o = await oauth(env, 'discord', 'd-castigo', { ip: ip(1) });
  assert.equal(o.done.location, '/#auth=confirm');
  const c = await post(env, '/api/auth/pending/create', { ip: ip(1), cookie: '__Host-tg_pend=' + o.pend, body: { username: 'Renacido', news: false, lang: 'es', ...TOK } });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.equal(obj.store.banUntil(c.json.playerId, obj.now()), s.at + 2 * 3_600_000);
  assert.equal(obj.store.abandonsInWindow(c.json.playerId, obj.now()), 3);
  // Google linked to an account that already had a longer ban: kept as it was.
  const l = await signedInAccount(env, obj, 'Lina', 'lina@example.com', ip(2));
  obj.store.sql.exec('INSERT INTO bans (user_id, until) VALUES (?, ?)', l.id, s.at + 5 * 3_600_000);
  const linked = await oauth(env, 'google', 'g-castigo', { ip: ip(2), query: '?link=1', cookie: '__Host-tg_rt=' + l.rt });
  assert.equal(linked.done.location, '/#auth=linked');
  assert.equal(row(obj, l.id).google_sub, 'g-castigo');
  const t = s.at + 3_600_000;
  assert.equal(obj.store.banUntil(l.id, t), s.at + 5 * 3_600_000, 'never shortened');
  assert.equal(obj.store.abandonsInWindow(l.id, t), 3);
  // Past the mark's end: nothing comes back.
  const late = await account(obj, 'Tarde', { pw: false });
  assert.equal(obj.store.linkPending(late, { p: 'discord', id: 'd-otro', email: null, trust: 'none' }, s.at + 2 * DAY, new Map()), 'linked');
  assert.equal(obj.store.banUntil(late, s.at + 2 * DAY), 0);
});

test('after the purge: freshId never hands out a tombstoned id', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const a = await requested(env, obj, 'Ana', 'ana@example.com', ip(0));
  assert.deepEqual((await obj.purgeDue(a.purgeAt + 1)).purged, [a.id]);
  const dead = Buffer.from(a.id, 'hex');
  const fresh = Buffer.from('0123456789abcdef', 'hex');
  const real = crypto.getRandomValues.bind(crypto);
  let calls = 0;
  crypto.getRandomValues = (b) => {
    // The id's 8 bytes: the tombstoned one first, then another.
    if (b.length === 8) {
      b.set(calls++ === 0 ? dead : fresh);
      return b;
    }
    return real(b);
  };
  let id;
  try {
    id = obj.store.register('Nueva', await A.newPasswordRecord(KEY, 2), [], 'c'.repeat(64), Date.now()).userId;
  } finally {
    crypto.getRandomValues = real;
  }
  assert.equal(calls, 2, 'the tombstoned id was drawn and refused');
  assert.equal(id, '0123456789abcdef');
});

test('after the purge: the NodeRegistryDO is told (/internal/operator-deleted { userId }), again on the next runs until it answers; without the node settings nobody is', async () => {
  const calls = [];
  let answer = 503;
  const NODES = {
    idFromName: (n) => ({ n }),
    get: () => ({
      fetch: async (url, init) => {
        calls.push({ path: new URL(url).pathname, body: JSON.parse(init.body), internal: init.headers['x-internal'] ?? Object.keys(init.headers).length });
        return new Response(JSON.stringify(answer === 200 ? { ok: true, banned: 1 } : { error: 'nodes_unavailable' }), { status: answer });
      },
    }),
  };
  const nodes = { NODES, NODE_REPLAYS: {}, NODE_RELEASES: {}, NODE_CONTROL_PRIVATE_KEY: 'k', NODE_CONTROL_PUBLIC_KEY: 'k', NODES_PUBLIC_BASE: ORIGIN };
  const { env, obj } = makeEnv(nodes);
  const ip = ips();
  const a = await requested(env, obj, 'Ana', 'ana@example.com', ip(0));
  obj.now = () => a.purgeAt + 1;
  await obj.alarm();
  assert.equal(obj.store.isDeleted(a.id), true);
  assert.deepEqual(calls.map((c) => [c.path, c.body]), [['/internal/operator-deleted', { userId: a.id }]]);
  assert.deepEqual(obj.store.deletedUntold(10), [a.id], 'a 503: told again');
  answer = 200;
  obj.now = () => a.purgeAt + 1 + DAY;
  await obj.alarm();
  assert.equal(calls.length, 2);
  assert.deepEqual(obj.store.deletedUntold(10), []);
  await obj.alarm();
  assert.equal(calls.length, 2, 'answered: never again');
  // A deploy without nodes: nothing to tell, nothing kept to tell.
  const plain = makeEnv();
  const b = await requested(plain.env, plain.obj, 'Bea', 'bea@example.com', ip(1));
  plain.obj.now = () => b.purgeAt + 1;
  await plain.obj.alarm();
  assert.equal(plain.obj.store.isDeleted(b.id), true);
  assert.deepEqual(plain.obj.store.deletedUntold(10), []);
});
