// The privacy and maintainer fixes (the data inventory and the review of sign-in PR 10): an unlink
// takes that provider's email hint with it; the purge keeps a proof of each consent and withdrawal
// with no personal data (consent_proofs, CONSENT_PROOF_KEEP_MS); a TV's /api/me carries no
// maintainer checklist; the project account (NODE_TRUSTED_OPERATORS) links a new way in only at
// level 2 (its password), and its address never moves to another account, which posts its ALERT;
// no console line carries a callback's code or an unsubscribe id. Through the real Worker (index.ts)
// in front of a real AccountsDO on node:sqlite, as maintainer.test.mjs runs them. The webhook, the
// providers, the mail binding and Turnstile are fakes: nothing leaves this machine.
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

// ---- the fakes: the staff channel's webhook, the providers, Turnstile -----------------------------
/** The staff channel (a name that never resolves): every post's JSON body lands here. */
const HOOK = 'https://staff-alerts.invalid/privacy-test';
const posts = [];
const identity = { google: { sub: 'g-default' }, discord: { id: 'd-default' } };
/** The token endpoints answer this status (a failed exchange logs its status line). */
const tokenStatus = { code: 200 };
globalThis.fetch = async (url, init) => {
  const u = String(url instanceof Request ? url.url : url);
  const ok = (b) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });
  if (u === HOOK) {
    posts.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(null, { status: 204 });
  }
  if (u === 'https://oauth2.googleapis.com/token' || u === 'https://discord.com/api/v10/oauth2/token') return tokenStatus.code === 200 ? ok({ access_token: 'fake-access' }) : new Response('{"error":"invalid_grant"}', { status: tokenStatus.code });
  if (u === 'https://openidconnect.googleapis.com/v1/userinfo') return ok(identity.google);
  if (u === 'https://discord.com/api/v10/users/@me') return ok(identity.discord);
  if (u === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
    const body = new URLSearchParams(await new Response(init?.body).text());
    return ok({ success: body.get('response') === 'good-token' });
  }
  throw new Error('BLOCKED network call in a test: ' + u);
};

const { AccountsDO } = await import('../src/AccountsDO.ts');
const A = await import('../src/accountRoutes.ts');
const S = await import('../src/accountStore.ts');
const AUTH = await import('../src/auth.ts');
const ACC = await import('../../src/net/account.ts');
const worker = (await import('../src/index.ts')).default;

const SECRET = 'privacy-fixes-test-secret';
const ORIGIN = 'https://turbo-gol.com';
const TOK = { turnstileToken: 'good-token' };
const PW = 'la clave larga de esta prueba';
const KEY = await ACC.passwordKey(PW);
const DAY = 24 * 60 * 60_000;

function sqlOn(db) {
  return {
    exec(query, ...bindings) {
      const stmt = db.prepare(query);
      const rows = /^\s*(SELECT|WITH|PRAGMA)/i.test(query) ? stmt.all(...bindings) : (stmt.run(...bindings), []);
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
  const env = {
    JWT_SECRET: SECRET,
    VITE_ORIGINS: ORIGIN,
    FLAGS: { get: async () => null },
    TURNSTILE_DISABLED: '1',
    GOOGLE_CLIENT_ID: 'gid',
    GOOGLE_CLIENT_SECRET: 'gsec',
    DISCORD_CLIENT_ID: 'did',
    DISCORD_CLIENT_SECRET: 'dsec',
    NODE_ALERT_WEBHOOK: HOOK,
    DELETION_OPEN: '1',
    ...liveMail(outbox),
    ...extra,
  };
  let alarm = null;
  const ctx = { storage: { sql: sqlOn(db), transactionSync: txOn(db), getAlarm: async () => alarm, setAlarm: async (t) => void (alarm = t) }, blockConcurrencyWhile: (fn) => fn() };
  const obj = new AccountsDO(ctx, env);
  env.ACCOUNTS = { idFromName: (n) => ({ n }), get: () => ({ fetch: (url, init) => obj.fetch(new Request(url, init)) }) };
  return { env, obj, outbox };
}

let ipBase = 0;
const ips = () => {
  const base = ++ipBase;
  return (i = 0) => `198.18.${base}.${i + 1}`;
};

const setCookies = (r) => (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean));
const cookieOf = (r, name) => {
  for (const c of setCookies(r)) {
    const m = new RegExp('^' + name + '=([^;]*)').exec(c ?? '');
    if (m) return m[1];
  }
  return null;
};

/** One request through the Worker (request.cf as Cloudflare would set it); what it sends in waitUntil has gone out when this returns. */
async function req(env, method, path, { ip = '198.18.0.1', origin = ORIGIN, bearer, cookie, body, form, cf = { country: 'AR', city: 'Córdoba' } } = {}) {
  const headers = { 'CF-Connecting-IP': ip };
  if (origin !== null) headers.Origin = origin;
  if (bearer) headers.authorization = 'Bearer ' + bearer;
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (form !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p), passThroughOnException() {} };
  const request = new Request(ORIGIN + path, { method, headers, body: form !== undefined ? form : body === undefined ? undefined : JSON.stringify(body) });
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
const signin = (env, email, ip, extra = {}) => post(env, '/api/auth/signin', { ip, body: { email, password: KEY, ...TOK, ...extra } });

/** A provider's round trip: start (with `query`, `cookie`), then the callback with the state it set. */
async function oauth(env, provider, who, { query = '', cookie, ip = '198.18.201.1', code = 'x' } = {}) {
  identity[provider] = provider === 'google' ? { sub: who } : { id: who };
  const start = await req(env, 'GET', `/api/auth/oauth/${provider}/start${query}`, { ip, cookie, origin: null });
  if (start.status !== 302 || !start.location.startsWith('https://')) return { start, done: null };
  const state = cookieOf(start.raw, '__Host-tg_oa');
  const nonce = new URL(start.location).searchParams.get('state');
  const jar = ['__Host-tg_oa=' + state, ...(cookie ? [cookie] : [])].join('; ');
  const done = await req(env, 'GET', `/api/auth/oauth/${provider}/callback?code=${code}&state=${nonce}`, { ip, cookie: jar, origin: null });
  return { start, done, rt: done.rt, pend: cookieOf(done.raw, '__Host-tg_pend') };
}

const refresh = (env, rt, ip) => post(env, '/api/auth/refresh', { ip, cookie: '__Host-tg_rt=' + rt });
const row = (obj, id) => obj.store.sql.exec('SELECT * FROM users WHERE id = ?', id).toArray()[0];
const sql = (obj, q, ...b) => obj.store.sql.exec(q, ...b).toArray();
const nowS = () => Math.floor(Date.now() / 1000);

/**
 * An account made straight in the store: a current password (KEY) unless `pw: false`, a verified
 * address when `email` is given, Google and Discord identities when named.
 */
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

// ---- data inventory I7: the purge keeps a proof of each consent and withdrawal --------------------

test('the purge keeps a proof of every consent and withdrawal (kind, version, granted, time) by the tombstoned id, with no source, address or name, for 2 years from the purge; the log itself goes', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const id = await account(obj, 'Ana', { email: 'ana@example.com' });
  const other = await account(obj, 'Bea', { email: 'bea@example.com' });
  const t0 = Date.now() - 3 * 60_000;
  // PERFIL's switch on, then off; Bea's on (another account's log is never touched).
  assert.deepEqual(obj.store.setNews(id, true, t0), { news: true, terms: null });
  assert.deepEqual(obj.store.setNews(id, false, t0 + 60_000), { news: false, terms: null });
  assert.deepEqual(obj.store.setNews(other, true, t0), { news: true, terms: null });
  // The deletion through the route: its own news withdrawal (source 'deletion'), then the purge date.
  const s = await signin(env, 'ana@example.com', ip(0));
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const d = await post(env, '/api/me/delete', { ip: ip(0), bearer: s.json.session, body: { confirm: 'Ana', lang: 'es' } });
  assert.equal(d.status, 200, JSON.stringify(d.json));
  const log = sql(obj, 'SELECT kind, version, granted, at FROM consents WHERE user_id = ? ORDER BY id', id).map((r) => ({ kind: r.kind, version: r.version, granted: r.granted === 1, at: r.at }));
  assert.equal(log.length, 3, 'a grant, a withdrawal from PERFIL and the deletion\'s');
  const at = d.json.purgeAt + 1;
  assert.deepEqual(await obj.purgeDue(at), { purged: [id], more: false });
  assert.equal(obj.store.isDeleted(id), true, 'the tombstone');
  assert.equal(sql(obj, 'SELECT COUNT(*) AS n FROM consents WHERE user_id = ?', id)[0].n, 0, 'the log itself goes');
  // The proof: the same rows, in order, by the tombstoned id.
  assert.deepEqual(obj.store.consentProofs(id), log);
  // No personal data: the columns are the id, the kind, the version, granted, the time and its end.
  assert.deepEqual(sql(obj, 'PRAGMA table_info(consent_proofs)').map((c) => c.name), ['deleted_id', 'kind', 'version', 'granted', 'at', 'until']);
  const stored = JSON.stringify(sql(obj, 'SELECT * FROM consent_proofs'));
  for (const x of ['ana@example.com', 'Ana', 'perfil', 'deletion', 'signup']) assert.ok(!stored.includes(x), `no ${x} in ${stored}`);
  assert.deepEqual(new Set(sql(obj, 'SELECT until FROM consent_proofs').map((r) => r.until)), new Set([at + S.CONSENT_PROOF_KEEP_MS]));
  assert.equal(S.CONSENT_PROOF_KEEP_MS, 730 * DAY, 'the draft\'s [2 años] (D39)');
  // Bea's log is hers, untouched; no proof of a live account.
  assert.equal(sql(obj, 'SELECT COUNT(*) AS n FROM consents WHERE user_id = ?', other)[0].n, 1);
  assert.deepEqual(obj.store.consentProofs(other), []);
  // The daily prune keeps it to the end, then it goes; the tombstone stays.
  obj.store.prune(at + S.CONSENT_PROOF_KEEP_MS - DAY);
  assert.equal(obj.store.consentProofs(id).length, 3);
  obj.store.prune(at + S.CONSENT_PROOF_KEEP_MS);
  assert.deepEqual(obj.store.consentProofs(id), []);
  assert.equal(obj.store.isDeleted(id), true);
  // A purge again (idempotent) writes nothing more.
  assert.equal(obj.store.purgeAccount(id, new Map(), at + DAY).result, 'gone');
  assert.equal(sql(obj, 'SELECT COUNT(*) AS n FROM consent_proofs')[0].n, 0);
});
