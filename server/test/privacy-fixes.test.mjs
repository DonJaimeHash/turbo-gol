// The privacy and maintainer fixes (the data inventory and the review of sign-in PR 10): an unlink
// takes that provider's email hint with it; the purge keeps a proof of each consent and withdrawal
// with no personal data (consent_proofs, CONSENT_PROOF_KEEP_MS); a TV's /api/me carries no
// maintainer checklist; the project account (NODE_TRUSTED_OPERATORS) links a new way in only at
// level 2 (its password), adds an address at level 2 too while it has a password, and its address
// never moves to another account, which posts its ALERT;
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

/** A provider's round trip: start (with `query`, `cookie`), then the callback with the state it set; `email`: the address the provider says it verified. */
async function oauth(env, provider, who, { query = '', cookie, ip = '198.18.201.1', code = 'x', email } = {}) {
  const mail = email === undefined ? {} : provider === 'google' ? { email, email_verified: true } : { email, verified: true };
  identity[provider] = provider === 'google' ? { sub: who, ...mail } : { id: who, ...mail };
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

// ---- data inventory I8: an unlink takes that provider's email hint with it ------------------------

const hintOf = (obj, id) => {
  const u = row(obj, id);
  return { hint: u.email_hint, canon: u.email_hint_canon, from: u.email_hint_from };
};
const NO_HINT = { hint: null, canon: null, from: '' };

test("an unlink takes the email hint that provider gave (DESVINCULAR DISCORD: Discord's address is no longer kept); a hint another provider gave stays", async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  // Google only, no password and no address: Discord linked with its address, which becomes the hint.
  const id = await account(obj, 'Ana', { pw: false, google: 'g-ana' });
  const g = await oauth(env, 'google', 'g-ana', { ip: ip(0) });
  assert.equal(g.done.location, '/#auth=ok');
  const l = await oauth(env, 'discord', 'd-ana', { ip: ip(0), query: '?link=1', cookie: '__Host-tg_rt=' + g.rt, email: 'Ana@Discord-Mail.com' });
  assert.equal(l.done.location, '/#auth=linked');
  assert.deepEqual(hintOf(obj, id), { hint: 'ana@discord-mail.com', canon: 'ana@discord-mail.com', from: 'discord' });
  const s = await refresh(env, l.rt, ip(0));
  assert.equal(s.status, 200);
  assert.equal((await req(env, 'GET', '/api/me', { ip: ip(0), bearer: s.json.session })).json.emailHint, 'ana@discord-mail.com');
  // DESVINCULAR DISCORD (level 1 is this account's ceiling): Discord and its address go.
  const u = await post(env, '/api/auth/unlink', { ip: ip(0), bearer: s.json.session, body: { provider: 'discord' } });
  assert.equal(u.status, 200, JSON.stringify(u.json));
  assert.equal(row(obj, id).discord_id, null);
  assert.deepEqual(hintOf(obj, id), NO_HINT, "Discord's address is not kept after the unlink");
  assert.equal((await req(env, 'GET', '/api/me', { ip: ip(0), bearer: s.json.session })).json.emailHint, null);
  // Nobody finds the account by that address any more (the confirm step's match).
  assert.equal(obj.store.emailMatch({ email: 'ana@discord-mail.com', trust: 'asserted' }, Date.now()), null);
  // A hint Google gave stays when Discord goes.
  obj.store.sql.exec("UPDATE users SET discord_id = 'd-ana', discord_linked_at = ?, email_hint = 'ana@gmail.com', email_hint_canon = 'ana@gmail.com', email_hint_from = 'google' WHERE id = ?", Date.now(), id);
  assert.equal((await post(env, '/api/auth/unlink', { ip: ip(0), bearer: s.json.session, body: { provider: 'discord' } })).status, 200);
  assert.deepEqual(hintOf(obj, id), { hint: 'ana@gmail.com', canon: 'ana@gmail.com', from: 'google' }, "Google's hint is Google's");
});

test("an unlink never takes the account's verified address: the provider's hint goes, the email stays", async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const id = await account(obj, 'Bea', { email: 'bea@example.com', google: 'g-bea', discord: 'd-bea' });
  assert.equal(obj.store.setEmailHint(id, 'bea@discord-mail.com', 'discord'), 'ok');
  const s = await signin(env, 'bea@example.com', ip(0));
  assert.equal(s.status, 200, JSON.stringify(s.json));
  assert.equal((await post(env, '/api/auth/unlink', { ip: ip(0), bearer: s.json.session, body: { provider: 'discord' } })).status, 200);
  assert.deepEqual(hintOf(obj, id), NO_HINT);
  const me = (await req(env, 'GET', '/api/me', { ip: ip(0), bearer: s.json.session })).json;
  assert.deepEqual([me.email, me.emailVerified, me.emailHint, me.providers], ['bea@example.com', true, null, ['password', 'google']]);
});

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

// ---- the review of sign-in PR 10: a TV's /api/me carries no maintainer checklist -------------------

/** A TV the phone (`bearer`) signs in: the TV's session. */
async function tvSession(env, bearer, phoneIp, tvIp) {
  const st = await post(env, '/api/auth/tv/start', { ip: tvIp });
  assert.equal(st.status, 200, JSON.stringify(st.json));
  assert.equal((await post(env, '/api/auth/tv/confirm', { ip: phoneIp, bearer, body: { code: st.json.code } })).status, 200);
  const tv = await post(env, '/api/auth/tv/poll', { ip: tvIp, body: { code: st.json.code, secret: st.json.secret } });
  assert.equal(tv.json.state, 'approved', JSON.stringify(tv.json));
  return tv.json.session;
}

test("a TV signed in with the phone gets the project account's /api/me without its checklist (`maintainer`), as without its address and hint; the phone keeps it", async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const project = await account(obj, 'Proyecto', { email: 'proyecto@example.com', discord: 'd-proyecto' });
  env.NODE_TRUSTED_OPERATORS = project;
  const s = await signin(env, 'proyecto@example.com', ip(0));
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const onPhone = (await req(env, 'GET', '/api/me', { ip: ip(0), bearer: s.json.session })).json;
  assert.deepEqual(onPhone.maintainer, { password: true, verifiedEmail: true, waysIn: 2 });
  const tv = await tvSession(env, s.json.session, ip(0), ip(1));
  const onTv = await req(env, 'GET', '/api/me', { ip: ip(1), bearer: tv });
  assert.equal(onTv.status, 200);
  assert.equal(onTv.json.name, 'Proyecto');
  for (const k of ['maintainer', 'email', 'emailHint']) assert.equal(k in onTv.json, false, `${k} on a TV: ${JSON.stringify(onTv.json)}`);
  assert.equal(onTv.headers.get('cache-control'), 'no-store');
});

// ---- the review of sign-in PR 10: the project account links a new way in at level 2 only ----------

test('the project account links a provider only at level 2 (its password): VINCULAR after a Discord sign-in answers reauth_required and adds nothing; after the password it links; anyone else links at level 1', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const project = await account(obj, 'Proyecto', { email: 'proyecto@example.com', discord: 'd-proyecto' });
  const ana = await account(obj, 'Ana', { email: 'ana@example.com', discord: 'd-ana' });
  env.NODE_TRUSTED_OPERATORS = project;
  // Whoever holds the project's Discord: a press on Discord's page, level 1, fresh.
  const d = await oauth(env, 'discord', 'd-proyecto', { ip: ip(0) });
  assert.equal(d.done.location, '/#auth=ok');
  const link = await oauth(env, 'google', 'g-intruso', { ip: ip(0), query: '?link=1', cookie: '__Host-tg_rt=' + d.rt });
  assert.equal(link.done, null, 'the start never reaches Google');
  assert.equal(link.start.location, '/#auth=error:reauth_required');
  assert.equal(row(obj, project).google_sub, null, 'no Google added');
  // "Confirm it's you" with Discord and then=link:google: the re-authentication stands, the link does not.
  const chain = await req(env, 'GET', '/api/auth/oauth/discord/start?reauth=1&then=link:google', { ip: ip(0), cookie: '__Host-tg_rt=' + d.rt, origin: null });
  assert.equal(chain.status, 302);
  identity.discord = { id: 'd-proyecto' };
  const st = cookieOf(chain.raw, '__Host-tg_oa');
  const cb = await req(env, 'GET', `/api/auth/oauth/discord/callback?code=x&state=${new URL(chain.location).searchParams.get('state')}`, { ip: ip(0), cookie: '__Host-tg_oa=' + st, origin: null });
  assert.equal(cb.location, '/#auth=error:reauth_required', 'not on to Google');
  assert.ok(cb.rt, "the re-authentication's new token is set: this browser stays signed in");
  const s = await refresh(env, cb.rt, ip(0));
  assert.equal(s.status, 200);
  assert.equal(row(obj, project).google_sub, null);
  // The password ("confirm it's you", level 2): VINCULAR GOOGLE goes through.
  const re = await post(env, '/api/auth/reauth', { ip: ip(0), bearer: s.json.session, cookie: '__Host-tg_rt=' + s.rt, body: { password: KEY } });
  assert.equal(re.status, 200, JSON.stringify(re.json));
  const ok = await oauth(env, 'google', 'g-proyecto', { ip: ip(0), query: '?link=1', cookie: '__Host-tg_rt=' + (re.rt ?? s.rt) });
  assert.equal(ok.done.location, '/#auth=linked');
  assert.equal(row(obj, project).google_sub, 'g-proyecto');
  // Anyone else links at level 1, as before.
  const a = await oauth(env, 'discord', 'd-ana', { ip: ip(1) });
  const al = await oauth(env, 'google', 'g-ana', { ip: ip(1), query: '?link=1', cookie: '__Host-tg_rt=' + a.rt });
  assert.equal(al.done.location, '/#auth=linked');
  assert.equal(row(obj, ana).google_sub, 'g-ana');
});

test("the project account takes a pending identity only at level 2: a Discord sign-in from the confirm sheet (pend=1) signs in and links nothing (ok:reauth_required); the password's sign-in links it", async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const project = await account(obj, 'Proyecto', { email: 'proyecto@example.com', discord: 'd-proyecto' });
  env.NODE_TRUSTED_OPERATORS = project;
  // An identity nobody owns waits in this browser (the confirm sheet: "I already have an account").
  const g = await oauth(env, 'google', 'g-intruso', { ip: ip(0) });
  assert.equal(g.done.location, '/#auth=confirm');
  assert.ok(g.pend);
  // Signing in with the project's Discord from there: signed in, the Google identity not linked.
  const p = await oauth(env, 'discord', 'd-proyecto', { ip: ip(0), query: '?pend=1', cookie: '__Host-tg_pend=' + g.pend });
  assert.equal(p.done.location, '/#auth=ok:reauth_required');
  assert.ok(p.rt, 'the sign-in stands');
  assert.equal(row(obj, project).google_sub, null, 'no Google added');
  // The same with the password (level 2): linked.
  const s = await post(env, '/api/auth/signin', { ip: ip(0), cookie: '__Host-tg_pend=' + g.pend, body: { email: 'proyecto@example.com', password: KEY, linkPending: true, ...TOK } });
  assert.equal(s.status, 200, JSON.stringify(s.json));
  assert.deepEqual(s.json.linked, ['google']);
  assert.equal(row(obj, project).google_sub, 'g-intruso');
  // The store's rule, for any sign-in it rides on: below level 2 nothing for the project account.
  obj.store.sql.exec('UPDATE users SET google_sub = NULL, google_linked_at = NULL WHERE id = ?', project);
  const pend = { p: 'google', id: 'g-otro', email: null, trust: 'none' };
  assert.equal(obj.store.linkPending(project, pend, Date.now(), new Map(), 1), 'reauth_required');
  assert.equal(obj.store.linkPending(project, pend, Date.now(), new Map()), 'reauth_required', 'no level said: none');
  assert.equal(obj.store.linkPending(project, pend, Date.now(), new Map(), 2), 'linked');
});

// The review of this PR: an address is a way in too (its reset link is level 2), so the project
// account adds one at level 2 while it has a password (accountRoutes.ts emailLevel).
const claimsOf = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
const mailCode = (m) => /^(\d{6})$/m.exec(m?.text ?? '')?.[1] ?? null;
const postsSince = (from) => posts.slice(from).map((p) => p.content);

test("the project account with a password and no address adds one only at level 2: after a Discord sign-in POST /api/me/email answers reauth_required { level: 2 } and mails nothing, so no reset link reaches the intruder's mailbox; after the password it goes; without a password it adds at level 1 and the staff channel hears of it; anyone else adds at level 1", async () => {
  const { env, obj, outbox } = makeEnv();
  const ip = ips();
  // A password and Discord, no verified address (PERFIL's checklist: verifiedEmail false).
  const mant = await account(obj, 'Mantdos', { discord: 'd-mantdos' });
  // A project account with Discord only, no password yet: level 1 is all it can reach.
  const bare = await account(obj, 'Mantres', { pw: false, discord: 'd-mantres' });
  const ana = await account(obj, 'Ana', { discord: 'd-ana' });
  env.NODE_TRUSTED_OPERATORS = [mant, bare].join(',');
  // Whoever holds the project's Discord: a press on Discord's page, level 1, fresh.
  const d = await oauth(env, 'discord', 'd-mantdos', { ip: ip(0) });
  assert.ok(d.rt, JSON.stringify(d.done?.location));
  const s = await refresh(env, d.rt, ip(0));
  assert.equal(s.status, 200);
  assert.equal(claimsOf(s.json.session).aal, 1);
  assert.deepEqual((await req(env, 'GET', '/api/me', { ip: ip(0), bearer: s.json.session })).json.maintainer, { password: true, verifiedEmail: false, waysIn: 2 });
  const sent = outbox.length;
  const add = await post(env, '/api/me/email', { ip: ip(0), bearer: s.json.session, body: { email: 'intruso@example.net', lang: 'es' } });
  assert.deepEqual([add.status, add.json.error, add.json.level], [403, 'reauth_required', 2], JSON.stringify(add.json));
  assert.deepEqual(outbox.slice(sent).map((m) => m.to), [], 'no code to the intruder mailbox');
  assert.equal(row(obj, mant).email, null);
  // The review's next step, a reset link to that address: there is no account behind it to mail.
  assert.equal((await post(env, '/api/auth/forgot', { ip: ip(2), body: { email: 'intruso@example.net', lang: 'es', ...TOK } })).status, 200);
  assert.deepEqual(outbox.slice(sent).map((m) => m.to), [], 'no reset link either');
  // The password ("confirm it's you", level 2): the add goes, with its code to the address.
  const re = await post(env, '/api/auth/reauth', { ip: ip(0), bearer: s.json.session, cookie: '__Host-tg_rt=' + s.rt, body: { password: KEY } });
  assert.equal(re.status, 200, JSON.stringify(re.json));
  assert.equal(claimsOf(re.json.session).aal, 2);
  const ok = await post(env, '/api/me/email', { ip: ip(0), bearer: re.json.session, body: { email: 'mantdos@example.com', lang: 'es' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const m5 = outbox.filter((m) => m.to === 'mantdos@example.com').at(-1);
  assert.ok(mailCode(m5), 'M5 with its code');
  const v = await post(env, '/api/me/email/verify', { ip: ip(0), bearer: re.json.session, body: { attempt: ok.json.attempt, code: mailCode(m5), lang: 'es' } });
  assert.equal(v.status, 200, JSON.stringify(v.json));
  assert.equal(row(obj, mant).email, 'mantdos@example.com');
  // No password yet: the add stays at level 1 (no lockout of the first address), and the ALERT says so.
  const b = await oauth(env, 'discord', 'd-mantres', { ip: ip(1) });
  const bs = await refresh(env, b.rt, ip(1));
  assert.equal(claimsOf(bs.json.session).aal, 1);
  const from = posts.length;
  const badd = await post(env, '/api/me/email', { ip: ip(1), bearer: bs.json.session, body: { email: 'mantres@example.com', lang: 'es' } });
  assert.equal(badd.status, 200, JSON.stringify(badd.json));
  const got = postsSince(from);
  assert.deepEqual(got, [`**ALERT** \`maintainer Mantres (${bare}) asked to add an email at level 1 (it has no password yet), from AR\``]);
  for (const x of ['@', '198.18.']) assert.ok(!got[0].includes(x), `no ${x} in ${got[0]}`);
  // Anyone else with a password and no address adds at level 1, as before, and no ALERT.
  const a = await oauth(env, 'discord', 'd-ana', { ip: ip(3) });
  const as = await refresh(env, a.rt, ip(3));
  assert.equal(claimsOf(as.json.session).aal, 1);
  const before = posts.length;
  const aadd = await post(env, '/api/me/email', { ip: ip(3), bearer: as.json.session, body: { email: 'ana@example.com', lang: 'es' } });
  assert.equal(aadd.status, 200, JSON.stringify(aadd.json));
  assert.deepEqual(postsSince(before), []);
  assert.equal(row(obj, ana).email, null, 'not before its code');
});

// ---- the review of sign-in PR 10: the project account's address never moves to another account ----

const codeIn = (m) => /^(\d{6})$/m.exec(m.text)?.[1] ?? null;
const alertsSince = (from) => posts.slice(from).map((p) => p.content);

test("another account that asks for the project account's address gets the same answer as for any address, no code reaches the project mailbox, nothing moves, and the staff channel gets the maintainer ALERT", async () => {
  const { env, obj, outbox } = makeEnv();
  const ip = ips();
  // The project account keeps a way in without its address (Discord): what lets an address move from any other account.
  const project = await account(obj, 'Proyecto', { email: 'proyecto@example.com', discord: 'd-proyecto' });
  const ana = await account(obj, 'Ana', { email: 'ana@example.com', discord: 'd-ana' });
  await account(obj, 'Otra', { email: 'otra@example.com' });
  env.NODE_TRUSTED_OPERATORS = project;
  const o = await signin(env, 'otra@example.com', ip(0));
  assert.equal(o.status, 200, JSON.stringify(o.json));
  const ask = (email) => post(env, '/api/me/email', { ip: ip(0), bearer: o.json.session, body: { email, lang: 'es' } });
  // A free address: the answer's shape.
  const free = await ask('libre@example.com');
  assert.equal(free.status, 200, JSON.stringify(free.json));
  const sent = outbox.length;
  const from = posts.length;
  const r = await ask('Proyecto@Example.com');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(Object.keys(r.json).sort(), Object.keys(free.json).sort(), 'the same answer (I6)');
  assert.equal(r.json.to, 'proyecto@example.com');
  assert.deepEqual(outbox.slice(sent).map((m) => m.to), [], 'no M7 move code to the project mailbox');
  // The ALERT: the project account, what was refused and the country; not the other account, an address or an IP.
  const got = alertsSince(from);
  assert.deepEqual(got, [`**ALERT** \`maintainer Proyecto (${project}) kept its email: another account asked for it (refused), from AR\``]);
  for (const x of ['Otra', '@', '198.18.']) assert.ok(!got[0].includes(x), `no ${x} in ${got[0]}`);
  // Whatever code it types, nothing moves (the row was a decoy).
  const v = await post(env, '/api/me/email/verify', { ip: ip(0), bearer: o.json.session, body: { attempt: r.json.attempt, code: codeIn(outbox.at(-1) ?? { text: '' }) ?? '000000', lang: 'es' } });
  assert.notEqual(v.status, 200, JSON.stringify(v.json));
  assert.deepEqual([row(obj, project).email, row(obj, project).email_canon], ['proyecto@example.com', 'proyecto@example.com']);
  // Anyone else's address still moves the usual way: M7 with its code to Ana, and no ALERT.
  const before = posts.length;
  const m = await ask('ana@example.com');
  assert.equal(m.status, 200);
  const toAna = outbox.filter((x) => x.to === 'ana@example.com').at(-1);
  assert.ok(toAna && codeIn(toAna), 'M7 "move" with its code');
  assert.deepEqual(alertsSince(before), []);
  const moved = await post(env, '/api/me/email/verify', { ip: ip(0), bearer: o.json.session, body: { attempt: m.json.attempt, code: codeIn(toAna), lang: 'es' } });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.equal(row(obj, ana).email, null, 'moved from Ana');
});

test("a move row made before the account was trusted cannot take the project account's address either (409 move_refused)", async () => {
  const { env, obj, outbox } = makeEnv();
  const ip = ips();
  const project = await account(obj, 'Proyecto', { email: 'proyecto@example.com', discord: 'd-proyecto' });
  await account(obj, 'Otra', { email: 'otra@example.com' });
  env.NODE_TRUSTED_OPERATORS = '';
  const o = await signin(env, 'otra@example.com', ip(0));
  const r = await post(env, '/api/me/email', { ip: ip(0), bearer: o.json.session, body: { email: 'proyecto@example.com', lang: 'es' } });
  assert.equal(r.status, 200);
  const m7 = outbox.filter((x) => x.to === 'proyecto@example.com').at(-1);
  const code = m7 ? codeIn(m7) : null;
  assert.ok(code, 'a real move row (the account was not trusted yet)');
  // Then the deploy that trusts it: the code no longer moves the address.
  env.NODE_TRUSTED_OPERATORS = project;
  const v = await post(env, '/api/me/email/verify', { ip: ip(0), bearer: o.json.session, body: { attempt: r.json.attempt, code, lang: 'es' } });
  assert.deepEqual([v.status, v.json.error], [409, 'move_refused']);
  assert.equal(row(obj, project).email, 'proyecto@example.com');
});

// ---- data inventory I20: no console line of ours carries a callback's code or an unsubscribe id -----

/** Every console line written while `fn` runs (the Worker's own lines: what Workers Logs keeps besides each request's URL). */
async function consoleDuring(fn) {
  const lines = [];
  const saved = {};
  for (const k of ['log', 'warn', 'error', 'info', 'debug']) {
    saved[k] = console[k];
    console[k] = (...a) => lines.push(a.map((x) => (x instanceof Error ? `${x.name}: ${x.message} ${x.stack ?? ''}` : typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  }
  try {
    await fn();
  } finally {
    Object.assign(console, saved);
  }
  return lines;
}

test("the URLs that carry an identifier in their query (the OAuth callback's code and state, the one-click unsubscribe's id) reach no console line, on success or failure", async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const id = await account(obj, 'Ana', { email: 'ana@example.com', discord: 'd-ana' });
  assert.deepEqual(obj.store.setNews(id, true, Date.now()), { news: true, terms: null });
  const unsub = row(obj, id).unsub_id;
  assert.match(unsub, S.UNSUB_ID_RE);
  const CODE = 'Zq7callbackCodeSecret';
  let states = [];
  const lines = await consoleDuring(async () => {
    // A sign-in, a callback whose token exchange fails (its status line), a replayed state, a provider's refusal.
    const ok = await oauth(env, 'discord', 'd-ana', { ip: ip(0), code: CODE });
    assert.equal(ok.done.location, '/#auth=ok');
    tokenStatus.code = 400;
    const bad = await oauth(env, 'discord', 'd-ana', { ip: ip(0), code: CODE });
    tokenStatus.code = 200;
    assert.equal(bad.done.location, '/#auth=error:provider_error');
    states = [ok, bad].map((x) => new URL(x.start.location).searchParams.get('state'));
    const replay = await req(env, 'GET', `/api/auth/oauth/discord/callback?code=${CODE}&state=${states[0]}`, { ip: ip(0), cookie: '__Host-tg_oa=' + cookieOf(ok.start.raw, '__Host-tg_oa'), origin: null });
    assert.equal(replay.location, '/#auth=error:bad_state');
    const refused = await req(env, 'GET', `/api/auth/oauth/discord/callback?error=access_denied&state=${states[0]}&code=${CODE}`, { ip: ip(0), origin: null });
    assert.equal(refused.location, '/#auth=error:cancelled');
    // RFC 8058's one-click (the id in the query), a malformed body, then the page's JSON form with a spent id.
    const one = await req(env, 'POST', `/api/news/unsubscribe?u=${unsub}`, { ip: ip(1), origin: null, form: 'List-Unsubscribe=One-Click' });
    assert.deepEqual([one.status, one.json], [200, { ok: true }]);
    const malformed = await req(env, 'POST', `/api/news/unsubscribe?u=${unsub}`, { ip: ip(1), origin: null, form: 'List-Unsubscribe=Nope' });
    assert.equal(malformed.status, 400);
    assert.equal((await post(env, '/api/news/unsubscribe', { ip: ip(1), body: { u: unsub } })).status, 200);
  });
  assert.equal(obj.store.consentState(id).news, false, 'the one-click withdrew the news');
  const all = lines.join('\n');
  for (const secret of [CODE, unsub, ...states]) assert.ok(!all.includes(secret), `${secret} in a console line:\n${all}`);
  assert.ok(lines.some((l) => l.includes('oauth discord: token 400')), 'the failed exchange did log its status line (the capture works)');
});
