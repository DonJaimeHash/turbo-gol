// Sign-in PR 13 (the design's §8 "the news consent and unsubscribing", §2.11, §3.14 and review point
// S-L1): the consent log only grows and its newest news row is the state; the switch at sign-up and
// at the OAuth create writes a grant only when it is on; PERFIL's switch (POST /api/me/consent) needs
// a verified address to grant; every grant mints an opaque unsubscribe id (16 random bytes, never
// the user id); POST /api/news/unsubscribe withdraws the news of that id's account and rotates the
// id, answers 200 { ok: true } for any id, and is the one POST that takes RFC 8058's one-click form
// with no Origin: every other auth route keeps the Origin + JSON rule. No news is sent. Through the
// real Worker (index.ts) in front of a real AccountsDO on node:sqlite, as deletion.test.mjs runs them;
// the providers, the mail binding and Turnstile are fakes: nothing leaves this machine.
// Run from server/: npm test
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

const DO = await import('../src/AccountsDO.ts');
const { AccountsDO } = DO;
const A = await import('../src/accountRoutes.ts');
const ACC = await import('../../src/net/account.ts');
const AUTH = await import('../src/auth.ts');
const L = await import('../src/limits.ts');
const S = await import('../src/accountStore.ts');
const worker = (await import('../src/index.ts')).default;

const SECRET = 'news-consent-test-secret';
const ORIGIN = 'https://turbo-gol.com';
const TOK = { turnstileToken: 'good-token' };
const PW = 'la clave larga de prueba';
const KEY = await ACC.passwordKey(PW);
const ONE_CLICK = 'List-Unsubscribe=One-Click';
const FORM = 'application/x-www-form-urlencoded';
/** An unsubscribe id as the design gives it (§1.1): 16 random bytes in base64url, 22 characters. */
const ID_RE = /^[A-Za-z0-9_-]{22}$/;

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

/** The AccountsDO on `db` (a new one by default): a second object on the same database is a restart. */
function objectOn(db, env) {
  let alarm = null;
  const ctx = { storage: { sql: sqlOn(db), transactionSync: txOn(db), getAlarm: async () => alarm, setAlarm: async (t) => void (alarm = t) }, blockConcurrencyWhile: (fn) => fn() };
  const obj = new AccountsDO(ctx, env);
  env.ACCOUNTS = { idFromName: (n) => ({ n }), get: () => ({ fetch: (url, init) => obj.fetch(new Request(url, init)) }) };
  return obj;
}

function makeEnv(extra = {}, db = new DatabaseSync(':memory:')) {
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
    DELETION_OPEN: '1',
    // A live deploy's mail settings with a fake binding that records every message (nothing can send).
    EMAIL: { send: async (m) => void outbox.push(m) },
    MAIL_LIVE: '1',
    MAIL_FROM: 'Turbogol <no-reply@turbo-gol.com>',
    MAIL_LINK_ORIGIN: ORIGIN,
    ...extra,
  };
  const obj = objectOn(db, env);
  return { env, obj, outbox, db };
}

let ipBase = 0;
const ips = () => {
  const base = ++ipBase;
  return (i = 0) => `198.21.${base}.${i + 1}`;
};

const setCookies = (r) => (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean));
const cookieOf = (r, name) => {
  for (const c of setCookies(r)) {
    const m = new RegExp('^' + name + '=([^;]*)').exec(c ?? '');
    if (m) return m[1];
  }
  return null;
};

/**
 * One request through the Worker. `body`: an object goes as JSON; a string or a FormData as it is,
 * with `type` as its Content-Type (a FormData sets its own multipart boundary). `origin: null`: no
 * Origin header, as a mail provider's one-click POST.
 */
async function req(env, method, path, { ip = '198.21.0.1', origin = ORIGIN, bearer, cookie, body, type } = {}) {
  const headers = { 'CF-Connecting-IP': ip };
  if (origin !== null) headers.Origin = origin;
  if (bearer) headers.authorization = 'Bearer ' + bearer;
  if (cookie) headers.cookie = cookie;
  let payload;
  if (typeof body === 'string' || body instanceof FormData) payload = body;
  else if (body !== undefined) payload = JSON.stringify(body);
  if (type !== undefined) headers['content-type'] = type;
  else if (body !== undefined && !(body instanceof FormData)) headers['content-type'] = 'application/json';
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p), passThroughOnException() {} };
  const res = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: payload }), env, ctx);
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
const consent = (env, session, granted, ip, extra = {}) => post(env, '/api/me/consent', { ip, bearer: session, body: { kind: 'news', granted, ...extra } });
/** RFC 8058's one-click, as a mail provider sends it: the id in the URL, the form body, no Origin, no cookie. */
const oneClick = (env, u, ip, o = {}) => post(env, '/api/news/unsubscribe?u=' + encodeURIComponent(u), { ip, origin: null, body: ONE_CLICK, type: FORM, ...o });
/** The page's form (/account#unsub=<id>): JSON { u } from the game's origin. */
const pageUnsub = (env, u, ip, o = {}) => post(env, '/api/news/unsubscribe', { ip, body: { u }, ...o });

const row = (obj, id) => obj.store.sql.exec('SELECT * FROM users WHERE id = ?', id).toArray()[0];
const sql = (obj, q, ...b) => obj.store.sql.exec(q, ...b).toArray();
const newsRows = (obj, id) => sql(obj, "SELECT version, granted, source FROM consents WHERE user_id = ? AND kind = 'news' ORDER BY id", id);
const allConsents = (obj) => sql(obj, 'SELECT * FROM consents ORDER BY id');
const nowS = () => Math.floor(Date.now() / 1000);
const session = (id, name, extra) => AUTH.signJwt(SECRET, { typ: 's', sub: id, name, iat: nowS(), exp: nowS() + 600, acct: 1, ...extra });
const codeIn = (m) => /^(\d{6})$/m.exec(m.text)?.[1] ?? null;
const me = async (env, s, ip) => (await req(env, 'GET', '/api/me', { ip, bearer: s })).json;

/** An account made straight in the store: a current password (KEY), a verified address unless `email: null`, providers. */
async function account(obj, name, { email = name.toLowerCase() + '@example.com', discord } = {}) {
  const rec = await A.newPasswordRecord(KEY, 2);
  const id = obj.store.register(name, rec, [], 'f'.repeat(63) + String(name.length % 10), Date.now()).userId;
  obj.store.sql.exec('DELETE FROM refresh WHERE user_id = ?', id);
  if (discord) obj.store.sql.exec('UPDATE users SET discord_id = ?, discord_linked_at = ? WHERE id = ?', discord, Date.now(), id);
  if (email) assert.equal(obj.store.claimEmail(id, email, 'mail', Date.now()), 'ok');
  return id;
}

/** An account with a verified address and its full Bearer (no freshness needed: a full session is enough for the news switch). */
async function withSession(obj, name, opts) {
  const id = await account(obj, name, opts);
  return { id, s: await session(id, name) };
}

async function oauth(env, provider, who, { ip = '198.21.250.1' } = {}) {
  identity[provider] = who;
  const start = await req(env, 'GET', `/api/auth/oauth/${provider}/start`, { ip, origin: null });
  assert.equal(start.status, 302, JSON.stringify(start.json));
  const state = cookieOf(start.raw, '__Host-tg_oa');
  const nonce = new URL(start.location).searchParams.get('state');
  const done = await req(env, 'GET', `/api/auth/oauth/${provider}/callback?code=x&state=${nonce}`, { ip, cookie: '__Host-tg_oa=' + state, origin: null });
  return { done, pend: cookieOf(done.raw, '__Host-tg_pend') };
}

/** A whole email sign-up by code (§2.2), with the news switch as `news`. */
async function signUp(env, outbox, email, ip, news) {
  const st = await post(env, '/api/auth/signup/start', { ip, body: { email, lang: 'es', ...TOK } });
  assert.equal(st.status, 200, JSON.stringify(st.json));
  const code = codeIn(outbox.at(-1));
  const f = await post(env, '/api/auth/signup/finish', { ip, body: { attempt: st.json.attempt, code, username: 'Nueva' + Math.floor(Math.random() * 1e6), password: KEY, lang: 'es', tz: 'America/Argentina/Buenos_Aires', ...(news === undefined ? {} : { news }) } });
  assert.equal(f.status, 200, JSON.stringify(f.json));
  return f.json;
}

// ---- the log, and PERFIL's switch (POST /api/me/consent) --------------------------------------------

test('consent: the log only grows and the newest row wins; PERFIL\'s switch writes a "perfil" row per change, none for a press that changes nothing; the answer is { news, terms }', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const { id, s } = await withSession(obj, 'Ana');
  assert.equal((await me(env, s, ip(0))).news, false, 'no row: no news (never by default)');
  // A withdrawal of an account that never granted changes nothing: no row.
  const off0 = await consent(env, s, false, ip(0));
  assert.deepEqual([off0.status, off0.json], [200, { news: false, terms: null }]);
  assert.equal(off0.headers.get('cache-control'), 'no-store');
  assert.deepEqual(newsRows(obj, id), []);
  const on = await consent(env, s, true, ip(0));
  assert.deepEqual([on.status, on.json], [200, { news: true, terms: null }]);
  assert.equal((await me(env, s, ip(0))).news, true);
  // The same state again: no second row.
  assert.deepEqual((await consent(env, s, true, ip(0))).json, { news: true, terms: null });
  assert.equal(newsRows(obj, id).length, 1);
  const before = allConsents(obj);
  assert.deepEqual((await consent(env, s, false, ip(0))).json, { news: false, terms: null });
  assert.equal((await me(env, s, ip(0))).news, false, 'the newest row wins');
  assert.deepEqual((await consent(env, s, true, ip(0))).json, { news: true, terms: null });
  assert.equal((await me(env, s, ip(0))).news, true);
  // Append-only: the rows from before are all still there, unchanged, and new ones came after them.
  const after = allConsents(obj);
  assert.deepEqual(after.slice(0, before.length), before, 'no row is updated or deleted');
  assert.deepEqual(newsRows(obj, id), [
    { version: 'news-v1', granted: 1, source: 'perfil' },
    { version: 'news-v1', granted: 0, source: 'perfil' },
    { version: 'news-v1', granted: 1, source: 'perfil' },
  ]);
  assert.ok(after.every((r, i) => i === 0 || r.id > after[i - 1].id && r.at >= after[i - 1].at));
  // The terms' newest grant is the answer's `terms` (sign-up writes one with acceptTerms).
  obj.store.sql.exec("INSERT INTO consents (user_id, kind, version, granted, source, at) VALUES (?, 'terms', 'tos-2027-01', 1, 'signup', ?)", id, Date.now());
  assert.deepEqual((await consent(env, s, true, ip(0))).json, { news: true, terms: 'tos-2027-01' });
});

test('consent: a grant needs a verified address (409 email_required; a withdrawal always goes); a hint is not one; a TV, a guest and no session are refused; only the news kind with a boolean', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  // A legacy-style account without an email, and a Discord one with only a provider's hint.
  const { id: noMail, s: s1 } = await withSession(obj, 'Sinmail', { email: null });
  const r = await consent(env, s1, true, ip(0));
  assert.deepEqual([r.status, r.json.error], [409, 'email_required']);
  assert.deepEqual(newsRows(obj, noMail), [], 'nothing written');
  assert.equal(row(obj, noMail).unsub_id, null, 'no id minted');
  const { id: hinted, s: s2 } = await withSession(obj, 'Pista', { email: null, discord: 'd-pista' });
  assert.equal(obj.store.setEmailHint(hinted, 'pista@example.org', 'discord'), 'ok');
  assert.equal((await consent(env, s2, true, ip(1))).json.error, 'email_required', 'an unproved address is not where news may go');
  // An account that opted in at its OAuth create, before it proved its address, can still withdraw.
  obj.store.sql.exec("INSERT INTO consents (user_id, kind, version, granted, source, at) VALUES (?, 'news', 'news-v1', 1, 'oauth_signup', ?)", hinted, Date.now());
  const off = await consent(env, s2, false, ip(1));
  assert.deepEqual([off.status, off.json], [200, { news: false, terms: null }]);
  assert.equal(newsRows(obj, hinted).at(-1).source, 'perfil');
  // Scope: a full account session.
  const { id, s } = await withSession(obj, 'Tele');
  const tv = await consent(env, await session(id, 'Tele', { tv: 1 }), true, ip(2));
  assert.deepEqual([tv.status, tv.json.error], [403, 'tv_session']);
  const guest = await post(env, '/api/guest', { ip: ip(3), body: {} });
  assert.equal((await consent(env, guest.json.session, true, ip(3))).status, 403);
  assert.equal((await post(env, '/api/me/consent', { ip: ip(2), body: { kind: 'news', granted: true } })).status, 401);
  for (const body of [{ kind: 'news', granted: 'yes' }, { kind: 'news' }, { kind: 'terms', version: 'x', granted: true }, { kind: 'privacy', granted: true }, { granted: true }]) {
    const bad = await post(env, '/api/me/consent', { ip: ip(2), bearer: s, body });
    assert.deepEqual([bad.status, bad.json.error], [400, 'bad_consent'], JSON.stringify(body));
  }
  assert.deepEqual(newsRows(obj, id), [], 'no refusal writes a row');
});

test('consent: the Origin + JSON rule (R1) holds on POST /api/me/consent: no Origin, a foreign one, or a form body is refused before anything is read', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const { id, s } = await withSession(obj, 'Ana');
  const none = await post(env, '/api/me/consent', { ip: ip(0), origin: null, bearer: s, body: { kind: 'news', granted: true } });
  assert.deepEqual([none.status, none.json.error], [403, 'bad_origin']);
  const foreign = await post(env, '/api/me/consent', { ip: ip(0), origin: 'https://evil.example', bearer: s, body: { kind: 'news', granted: true } });
  assert.deepEqual([foreign.status, foreign.json.error], [403, 'bad_origin']);
  const form = await post(env, '/api/me/consent', { ip: ip(0), bearer: s, body: 'kind=news&granted=true', type: FORM });
  assert.deepEqual([form.status, form.json.error], [415, 'json_required']);
  assert.deepEqual(newsRows(obj, id), []);
});

test('consent: a deletion request withdraws the news (source "deletion"); while it is pending the Bearer still alive cannot grant again (409 deletion_pending) but can withdraw; called off, the news stays off', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const { id, s } = await withSession(obj, 'Borra');
  assert.equal((await consent(env, s, true, ip(0))).json.news, true);
  const lvl2 = await session(id, 'Borra', { aat: nowS(), aal: 2 });
  const del = await post(env, '/api/me/delete', { ip: ip(0), bearer: lvl2, body: { confirm: 'Borra', lang: 'es' } });
  assert.equal(del.status, 200, JSON.stringify(del.json));
  assert.deepEqual(newsRows(obj, id).at(-1), { version: 'news-v1', granted: 0, source: 'deletion' });
  const again = await consent(env, s, true, ip(0));
  assert.deepEqual([again.status, again.json.error, again.json.purgeAt], [409, 'deletion_pending', del.json.purgeAt]);
  assert.deepEqual((await consent(env, s, false, ip(0))).json, { news: false, terms: null }, 'a withdrawal always goes (no row: the state is already off)');
  assert.equal(newsRows(obj, id).length, 2);
  // Called off: the account is back, its news still withdrawn until it turns them on again.
  obj.store.sql.exec('UPDATE users SET delete_requested_at = 0, delete_purge_at = 0 WHERE id = ?', id);
  assert.equal((await me(env, s, ip(0))).news, false);
  assert.equal((await consent(env, s, true, ip(0))).json.news, true);
});

test('consent: NEWS_CHANGES caps the switch\'s changes per account and day (each is a row of a log that only grows); a press that changes nothing takes no slot; another account is not counted', async () => {
  const { env, obj } = makeEnv();
  const { id } = await withSession(obj, 'Flip');
  assert.equal(DO.NEWS_CHANGES.day, 20);
  // The object's own count, as the Worker asks it (the edge's authAcct, 10 a minute, comes before it):
  // a day's presses of one account, over many minutes.
  const ask = async (userId, granted) => {
    const r = await A.accountsCall(env, '/me-consent', { userId, kind: 'news', granted });
    return { status: r.status, json: await r.json() };
  };
  for (let i = 0; i < DO.NEWS_CHANGES.day; i++) {
    const r = await ask(id, i % 2 === 0);
    assert.equal(r.status, 200, `change ${i + 1}: ${JSON.stringify(r.json)}`);
  }
  assert.equal(newsRows(obj, id).length, DO.NEWS_CHANGES.day);
  const same = await ask(id, false);
  assert.deepEqual([same.status, same.json.news], [200, false], 'the same state again: no slot, no row');
  const over = await ask(id, true);
  assert.deepEqual([over.status, over.json.error], [429, 'rate_limited']);
  assert.ok(over.json.retryAfterMs > 0);
  assert.equal(newsRows(obj, id).length, DO.NEWS_CHANGES.day, 'nothing written');
  assert.equal((await ask(id, false)).status, 200, 'a withdrawal that changes nothing still answers');
  const other = await withSession(obj, 'Otra');
  assert.equal((await ask(other.id, true)).status, 200, 'per account');
  // And a refusal takes no slot either.
  const bare = await withSession(obj, 'Sinmail', { email: null });
  for (let i = 0; i < DO.NEWS_CHANGES.day + 5; i++) assert.equal((await ask(bare.id, true)).json.error, 'email_required');
  assert.equal(obj.store.claimEmail(bare.id, 'sinmail@example.com', 'mail', Date.now()), 'ok');
  assert.equal((await ask(bare.id, true)).status, 200);
});

// ---- the opt-in at sign-up and at create (§3.14 step 1), and the unsubscribe id (S-L1) -----------------

test('opt-in: the email sign-up\'s switch at YES writes one "signup" grant and mints the unsubscribe id; at NO (or absent) no row and no id', async () => {
  const { env, obj, outbox } = makeEnv();
  const ip = ips();
  const yes = await signUp(env, outbox, 'si.novedades@example.com', ip(0), true);
  assert.deepEqual(newsRows(obj, yes.playerId), [{ version: 'news-v1', granted: 1, source: 'signup' }]);
  assert.match(row(obj, yes.playerId).unsub_id, ID_RE);
  assert.equal((await me(env, yes.session, ip(0))).news, true);
  for (const [email, news] of [['no.novedades@example.com', false], ['sin.casilla@example.com', undefined]]) {
    const no = await signUp(env, outbox, email, ip(1), news);
    assert.deepEqual(newsRows(obj, no.playerId), [], String(news));
    assert.equal(row(obj, no.playerId).unsub_id, null);
    assert.equal((await me(env, no.session, ip(1))).news, false);
  }
  // A string, a number: only true is a yes.
  const odd = await signUp(env, outbox, 'raro@example.com', ip(2), 'true');
  assert.deepEqual(newsRows(obj, odd.playerId), []);
});

test('opt-in: the OAuth confirm step\'s create at YES writes one "oauth_signup" grant and mints the id; at NO nothing', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const a = await oauth(env, 'google', { sub: 'g-nueva', email: 'nueva.cuenta@gmail.com', email_verified: true }, { ip: ip(0) });
  assert.equal(a.done.location, '/#auth=confirm');
  const made = await post(env, '/api/auth/pending/create', { ip: ip(0), cookie: '__Host-tg_pend=' + a.pend, body: { username: 'Nueva', news: true, lang: 'es', tz: '', ...TOK } });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  assert.deepEqual(newsRows(obj, made.json.playerId), [{ version: 'news-v1', granted: 1, source: 'oauth_signup' }]);
  assert.match(row(obj, made.json.playerId).unsub_id, ID_RE);
  const b = await oauth(env, 'google', { sub: 'g-otra', email: 'otra.cuenta@gmail.com', email_verified: true }, { ip: ip(1) });
  const no = await post(env, '/api/auth/pending/create', { ip: ip(1), cookie: '__Host-tg_pend=' + b.pend, body: { username: 'Otra', news: false, lang: 'es', tz: '', ...TOK } });
  assert.equal(no.status, 200, JSON.stringify(no.json));
  assert.deepEqual(newsRows(obj, no.json.playerId), []);
  assert.equal(row(obj, no.json.playerId).unsub_id, null);
});

test('the unsubscribe id is opaque (review point S-L1): 16 random bytes as base64url, no user id inside, one per account, kept by a grant again; an account that granted before this build gets one at the next start', async () => {
  const { env, obj, db } = makeEnv();
  const ip = ips();
  const ids = [];
  assert.equal(S.UNSUB_ID_RE?.source, ID_RE.source, 'the store and the Worker read ids by the same rule');
  for (const name of ['Uno', 'Dos', 'Tres']) {
    const { id, s } = await withSession(obj, name);
    await consent(env, s, true, ip(0));
    const u = row(obj, id).unsub_id;
    assert.match(u, ID_RE);
    const bytes = Buffer.from(u, 'base64url');
    assert.equal(bytes.length, 16);
    assert.ok(!u.includes(id) && !bytes.toString('hex').includes(id) && !Buffer.from(id).toString('base64url').includes(u.slice(0, 8)), 'nothing of the user id');
    // Withdrawn and granted again in PERFIL: the same id (only an unsubscribe rotates it).
    await consent(env, s, false, ip(0));
    await consent(env, s, true, ip(0));
    assert.equal(row(obj, id).unsub_id, u);
    ids.push(u);
  }
  assert.equal(new Set(ids).size, 3);
  // A sign-up of before this build: its grant, no id. The next start of the object mints one.
  const old = await account(obj, 'Antigua');
  obj.store.sql.exec("INSERT INTO consents (user_id, kind, version, granted, source, at) VALUES (?, 'news', 'news-v1', 1, 'signup', ?)", old, Date.now());
  const never = await account(obj, 'Nunca');
  assert.equal(row(obj, old).unsub_id, null);
  const restarted = objectOn(db, env);
  assert.match(row(restarted, old).unsub_id, ID_RE);
  assert.equal(row(restarted, never).unsub_id, null, 'no grant, no id');
  assert.deepEqual(ids.map((_, i) => row(restarted, sql(restarted, 'SELECT id FROM users WHERE username = ?', ['Uno', 'Dos', 'Tres'][i])[0].id).unsub_id), ids, 'the ids it had stay');
  // It reads only the rows after the last one it read: a grant a rolled-back build writes later is found at the next start.
  const top = sql(restarted, 'SELECT MAX(id) AS m FROM consents')[0].m;
  assert.deepEqual(sql(restarted, "SELECT v FROM meta WHERE k = 'unsub_scan'"), [{ v: String(top) }]);
  restarted.store.sql.exec("INSERT INTO consents (user_id, kind, version, granted, source, at) VALUES (?, 'news', 'news-v1', 1, 'signup', ?)", never, Date.now());
  const again = objectOn(db, env);
  assert.match(row(again, never).unsub_id, ID_RE);
  assert.equal(row(again, old).unsub_id, row(restarted, old).unsub_id, 'an id once minted stays');
});

// ---- POST /api/news/unsubscribe ---------------------------------------------------------------------

test('unsubscribe: the one-click (no Origin, a form body, the id in the URL) withdraws the news (source "unsubscribe") and rotates the id; the old id then answers the same and changes nothing; news is false after it', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const { id, s } = await withSession(obj, 'Ana');
  await consent(env, s, true, ip(0));
  const u1 = row(obj, id).unsub_id;
  const r = await oneClick(env, u1, ip(1));
  assert.deepEqual([r.status, r.json], [200, { ok: true }]);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.location, null, 'no redirect (RFC 8058)');
  assert.deepEqual(newsRows(obj, id).at(-1), { version: 'news-v1', granted: 0, source: 'unsubscribe' });
  const u2 = row(obj, id).unsub_id;
  assert.match(u2, ID_RE);
  assert.notEqual(u2, u1, 'rotated: an older mail\'s link does nothing now');
  assert.equal((await me(env, s, ip(0))).news, false);
  // The old id again (a second click, a mail scanner, a replay): the same answer, nothing changes.
  const rows = allConsents(obj).length;
  const again = await oneClick(env, u1, ip(1));
  assert.deepEqual([again.status, again.json], [200, { ok: true }]);
  assert.equal(allConsents(obj).length, rows);
  assert.equal(row(obj, id).unsub_id, u2);
  // The page's form with the new id works too, and rotates it again.
  const page = await pageUnsub(env, u2, ip(2));
  assert.deepEqual([page.status, page.json], [200, { ok: true }]);
  assert.deepEqual(newsRows(obj, id).at(-1).source, 'unsubscribe');
  assert.notEqual(row(obj, id).unsub_id, u2);
  // Turned on again in PERFIL: it keeps its current id (minted only when there is none).
  const u3 = row(obj, id).unsub_id;
  await consent(env, s, true, ip(0));
  assert.equal(row(obj, id).unsub_id, u3);
  assert.equal((await me(env, s, ip(0))).news, true);
});

test('unsubscribe: an unknown, a malformed or a missing id answers 200 { ok: true } and changes nothing (ids cannot be tested); another account is never touched', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const { id, s } = await withSession(obj, 'Ana');
  await consent(env, s, true, ip(0));
  const mine = row(obj, id).unsub_id;
  const before = { rows: allConsents(obj), users: sql(obj, 'SELECT id, unsub_id FROM users ORDER BY id') };
  const unknown = 'A'.repeat(22);
  const shapes = [];
  for (const u of [unknown, mine.slice(0, 21), mine + 'x', id, '', ' '.repeat(22), "' OR 1=1 --", 'a'.repeat(300)]) {
    for (const r of [await oneClick(env, u, ip(1)), await pageUnsub(env, u, ip(2))]) shapes.push([r.status, JSON.stringify(r.json), r.headers.get('cache-control')]);
  }
  for (const r of [await post(env, '/api/news/unsubscribe', { ip: ip(1), origin: null, body: ONE_CLICK, type: FORM }), await pageUnsub(env, undefined, ip(2)), await pageUnsub(env, 42, ip(2))]) shapes.push([r.status, JSON.stringify(r.json), r.headers.get('cache-control')]);
  assert.deepEqual(new Set(shapes.map((x) => x.join(' '))), new Set(['200 {"ok":true} no-store']), 'one answer for every id');
  assert.deepEqual({ rows: allConsents(obj), users: sql(obj, 'SELECT id, unsub_id FROM users ORDER BY id') }, before, 'nothing changed');
  assert.equal((await me(env, s, ip(0))).news, true);
  // The store itself: false for any of them.
  assert.equal(obj.store.unsubscribe(unknown, Date.now()), false);
  assert.equal(obj.store.unsubscribe(id, Date.now()), false, 'the raw user id is not an unsubscribe id');
});

test('unsubscribe: RFC 8058\'s one-click is accepted on that route only, with no Origin or any Origin, urlencoded or multipart; its JSON form keeps the Origin + JSON rule, and every other auth route keeps it for that very form', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const { id, s } = await withSession(obj, 'Ana');
  const fresh = async () => {
    await consent(env, s, false, ip(9));
    await consent(env, s, true, ip(9));
    return row(obj, id).unsub_id;
  };
  // The one-click: no Origin (a mail provider's servers), a foreign one (a webmail page), "null".
  for (const origin of [null, 'https://mail.example.com', 'null']) {
    const u = await fresh();
    const r = await oneClick(env, u, ip(0), { origin });
    assert.deepEqual([r.status, r.json], [200, { ok: true }], String(origin));
    assert.equal(newsRows(obj, id).at(-1).source, 'unsubscribe', String(origin));
    assert.notEqual(row(obj, id).unsub_id, u);
  }
  // multipart/form-data (RFC 8058: SHOULD), with its boundary.
  {
    const u = await fresh();
    const fd = new FormData();
    fd.append('List-Unsubscribe', 'One-Click');
    const r = await post(env, '/api/news/unsubscribe?u=' + u, { ip: ip(0), origin: null, body: fd });
    assert.deepEqual([r.status, r.json], [200, { ok: true }]);
    assert.notEqual(row(obj, id).unsub_id, u);
  }
  // A form without List-Unsubscribe=One-Click is not the one-click: 400, nothing changes.
  {
    const u = await fresh();
    for (const body of ['List-Unsubscribe=Yes', 'u=' + u, '', 'list-unsubscribe=one-click']) {
      const r = await post(env, '/api/news/unsubscribe?u=' + u, { ip: ip(0), origin: null, body, type: FORM });
      assert.deepEqual([r.status, r.json.error], [400, 'bad_request'], body);
    }
    const big = await post(env, '/api/news/unsubscribe?u=' + u, { ip: ip(0), origin: null, body: ONE_CLICK + '&x=' + 'y'.repeat(5000), type: FORM });
    assert.equal(big.status, 400, 'over 4 KB');
    assert.equal(row(obj, id).unsub_id, u);
    assert.equal(newsRows(obj, id).at(-1).granted, 1);
    // The page's JSON form: the game's Origin and JSON (R1), its id in the body only (R8).
    const noOrigin = await pageUnsub(env, u, ip(0), { origin: null });
    assert.deepEqual([noOrigin.status, noOrigin.json.error], [403, 'bad_origin']);
    const foreign = await pageUnsub(env, u, ip(0), { origin: 'https://evil.example' });
    assert.deepEqual([foreign.status, foreign.json.error], [403, 'bad_origin']);
    const plain = await post(env, '/api/news/unsubscribe', { ip: ip(0), body: JSON.stringify({ u }), type: 'text/plain' });
    assert.deepEqual([plain.status, plain.json.error], [415, 'json_required'], 'a text/plain form is not JSON');
    const fromQuery = await post(env, '/api/news/unsubscribe?u=' + u, { ip: ip(0), body: {} });
    assert.deepEqual([fromQuery.status, fromQuery.json], [200, { ok: true }]);
    assert.equal(row(obj, id).unsub_id, u, "the JSON form never reads the query's id");
    assert.equal(newsRows(obj, id).at(-1).granted, 1, 'nothing changed');
    // A GET (a link scanner, a mail client that opens the URL) unsubscribes nobody.
    assert.equal((await req(env, 'GET', '/api/news/unsubscribe?u=' + u, { ip: ip(0), origin: null })).status, 404);
    assert.equal(row(obj, id).unsub_id, u);
  }
  // The same cross-origin one-click form, with no Origin, on every other POST that reads a body or a
  // cookie under /api/auth/ (and the news switch): 403 bad_origin; with the game's Origin, 415.
  const others = [
    '/api/auth/login', '/api/auth/signin', '/api/auth/signup/start', '/api/auth/signup/check', '/api/auth/signup/finish',
    '/api/auth/forgot', '/api/auth/reset/peek', '/api/auth/reset', '/api/auth/code/resend', '/api/auth/recover',
    '/api/auth/email/confirm', '/api/auth/email/undo/peek', '/api/auth/email/undo', '/api/auth/delete/cancel',
    '/api/auth/pending', '/api/auth/pending/create', '/api/auth/pending/cancel', '/api/auth/reauth', '/api/auth/reauth/code',
    '/api/auth/reauth/code/verify', '/api/auth/unlink', '/api/auth/tv/start', '/api/auth/tv/poll', '/api/auth/tv/renew',
    '/api/auth/refresh', '/api/auth/logout', '/api/auth/sessions/revoke-all', '/api/me/consent',
  ];
  // Another account's Bearer (the switch above took this minute's authAcct of Ana's).
  const t = await withSession(obj, 'Otra');
  const unchanged = { rows: allConsents(obj), users: sql(obj, 'SELECT * FROM users ORDER BY id') };
  for (const path of others) {
    const none = await post(env, path + '?u=x', { ip: ip(1), origin: null, body: ONE_CLICK, type: FORM, cookie: '__Host-tg_rt=x', bearer: t.s });
    assert.deepEqual([none.status, none.json?.error], [403, 'bad_origin'], path + ' with no Origin');
    const foreign = await post(env, path, { ip: ip(1), origin: 'https://mail.example.com', body: ONE_CLICK, type: FORM, bearer: t.s });
    assert.deepEqual([foreign.status, foreign.json?.error], [403, 'bad_origin'], path + ' with a foreign Origin');
  }
  for (const path of others.filter((p) => !['/api/auth/refresh', '/api/auth/logout', '/api/auth/sessions/revoke-all'].includes(p))) {
    const own = await post(env, path, { ip: ip(2), body: ONE_CLICK, type: FORM, bearer: t.s });
    assert.deepEqual([own.status, own.json?.error], [415, 'json_required'], path + ' with a form body');
  }
  assert.deepEqual({ rows: allConsents(obj), users: sql(obj, 'SELECT * FROM users ORDER BY id') }, unchanged, 'none of them changed anything');
});

test('unsubscribe and consent: their limits (limits.ts accountGate, the design\'s §2.16): PERFIL\'s switch per account (authAcct), the unsubscribe per network and /48 (authCode, signInSite); mounted as an account route outside /api/auth/', async () => {
  assert.deepEqual(L.accountGate('POST', '/api/me/consent'), ['authAcct']);
  assert.deepEqual(L.accountGate('POST', '/api/news/unsubscribe'), ['authCode', 'signInSite']);
  assert.deepEqual(L.accountGate('GET', '/api/news/unsubscribe'), []);
  assert.deepEqual([L.LIMITS.authCode.by, L.LIMITS.authCode.isolate, L.LIMITS.authAcct.by, L.LIMITS.authAcct.isolate], ['network', 120, 'account', 10]);
  // The edge counts it: past authCode's 120 a minute from one address, 429 before the AccountsDO.
  const { env, obj } = makeEnv();
  const ip = '198.21.240.7';
  const calls = [];
  const fetchDo = env.ACCOUNTS.get().fetch;
  env.ACCOUNTS = { idFromName: (n) => ({ n }), get: () => ({ fetch: (url, init) => (calls.push(String(url)), fetchDo(url, init)) }) };
  let last = null;
  for (let i = 0; i < L.LIMITS.authCode.isolate + 1; i++) last = await oneClick(env, 'B'.repeat(22), ip);
  assert.deepEqual([last.status, last.json.error], [429, 'rate_limited']);
  assert.equal(calls.filter((u) => u.endsWith('/news-unsubscribe')).length, L.LIMITS.authCode.isolate, 'the one over the limit never reached the object');
  assert.ok(obj);
});
