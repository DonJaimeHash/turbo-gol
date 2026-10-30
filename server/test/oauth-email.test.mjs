// Sign-in PR 6 (the design's section 8, "Discord email and the confirm step"; §2.7, §2.8, §2.14,
// §3.8, §3.11): Google and Discord give their address, never a name; the OAuth callback creates no
// account (I3) but holds the identity in the pending cookie, and "¿Ya tienes cuenta en Turbogol?"
// comes first (POST /api/auth/pending, /pending/create with Turnstile and a per-network cap,
// /pending/cancel); a verified address that matches an account (claimed or as a hint) sends the
// person to sign in there and link (login with linkPending, start?pend=1), never to a second
// account; the trust of an address is the server's (I9); a TV renews its code (POST
// /api/auth/tv/renew) and, when its Turnstile check wants a press a remote cannot give, starts
// without one under tighter caps. Through the real Worker (index.ts) in front of a real AccountsDO
// on node:sqlite, as levels.test.mjs runs them; Google, Discord and Turnstile are fakes (nothing
// leaves this machine). Run from server/: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

// ---- the fake providers and Turnstile --------------------------------------------------------------
/** What each fake provider answers for the next callback (its userinfo or /users/@me body). */
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

const { AccountsDO, NEW_ACCOUNTS, NEW_ACCOUNTS_SITE } = await import('../src/AccountsDO.ts');
const A = await import('../src/accountRoutes.ts');
const TV = await import('../src/tvCodes.ts');
const AUTH = await import('../src/auth.ts');
const ACC = await import('../../src/net/account.ts');
const worker = (await import('../src/index.ts')).default;

const SECRET = 'oauth-email-test-secret';
const ORIGIN = 'https://turbo-gol.com';
const TURNSTILE_ON = { TURNSTILE_DISABLED: '0', TURNSTILE_SECRET: 'ts-secret', TURNSTILE_SITEKEY: 'ts-site' };
const PW = 'una contraseña larga';

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

/** A fresh AccountsDO on `db` (a restart when `db` already holds one's data), wired as env.ACCOUNTS; `calls` lists what reaches it. */
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

// Every test speaks from networks of its own: the Worker's per-network pre-filters live for the file.
let ipBase = 0;
const ips = () => {
  const base = ++ipBase;
  return (i = 0) => `198.20.${base}.${i + 1}`;
};

const setCookies = (r) => (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean));
const cookieLine = (r, name) => setCookies(r).find((c) => c.startsWith(name + '=')) ?? null;
const cookieOf = (r, name) => {
  const line = cookieLine(r, name);
  const v = line === null ? null : /^[^=]+=([^;]*)/.exec(line)[1];
  return v === '' ? null : v;
};

async function req(env, method, path, { ip = '198.20.0.1', origin = ORIGIN, bearer, cookie, body } = {}) {
  const headers = { 'CF-Connecting-IP': ip };
  if (origin !== null) headers.Origin = origin;
  if (bearer) headers.authorization = 'Bearer ' + bearer;
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  // What the Worker sends after it answers (waitUntil: the email routes' mail) has gone out when this returns.
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p), passThroughOnException() {} };
  const res = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
  await Promise.all(pending);
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

/**
 * The provider's round trip: start (with `query` and `cookie`), the fake provider answers `who`
 * (its body as the provider gives it), the callback with the state cookie (and the pending cookie
 * `pend` the browser holds: SameSite=Lax, sent on the redirect back).
 */
async function oauth(env, provider, who, { query = '', cookie, pend, ip = '198.20.250.1' } = {}) {
  identity[provider] = who;
  const start = await req(env, 'GET', `/api/auth/oauth/${provider}/start${query}`, { ip, cookie, origin: null });
  assert.equal(start.status, 302, JSON.stringify(start.json));
  const state = cookieOf(start.raw, '__Host-tg_oa');
  const nonce = new URL(start.location).searchParams.get('state');
  const jar = ['__Host-tg_oa=' + state, ...(pend ? ['__Host-tg_pend=' + pend] : [])].join('; ');
  const done = await req(env, 'GET', `/api/auth/oauth/${provider}/callback?code=x&state=${nonce}`, { ip, cookie: jar, origin: null });
  return { start, done, rt: cookieOf(done.raw, '__Host-tg_rt'), pend: cookieOf(done.raw, '__Host-tg_pend'), pendLine: cookieLine(done.raw, '__Host-tg_pend') };
}
const discord = (id, extra = {}) => ({ id, username: 'admin', global_name: 'Soporte Turbogol', ...extra });
const google = (sub, extra = {}) => ({ sub, name: 'Ana Pérez', given_name: 'Admin', ...extra });

const pendingOf = (env, pend, ip) => post(env, '/api/auth/pending', { ip, cookie: '__Host-tg_pend=' + pend });
const create = (env, pend, username, ip, extra = {}) => post(env, '/api/auth/pending/create', { ip, cookie: '__Host-tg_pend=' + pend, body: { username, ...extra } });
const claims = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
const users = (obj) => obj.store.sql.exec('SELECT * FROM users ORDER BY created_at, id').toArray();
const row = (obj, id) => obj.store.sql.exec('SELECT * FROM users WHERE id = ?', id).toArray()[0];

/** A legacy password account (users.pw_v 1), as every production password is today, and its two client keys. */
async function legacyAccount(obj, name) {
  const v1 = await ACC.legacyPasswordKey(name, PW);
  const v2 = await ACC.passwordKey(PW);
  const id = obj.store.register(name, await A.newPasswordRecord(v1, 1), [], 'e'.repeat(64), Date.now()).userId;
  return { id, v1, v2 };
}
const login = (env, acct, username, ip, extra = {}, cookie) => post(env, '/api/auth/login', { ip, cookie, body: { username, password: acct.v1, passwordV2: acct.v2, ...extra } });

// ---- the callback ------------------------------------------------------------------------------------

test('the callback: an identity nobody owns sets the pending cookie (HttpOnly, Lax, 30 minutes) and creates no account; CREAR does, with the name the player typed', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const r = await oauth(env, 'discord', discord('d-nueva', { email: 'Nueva@Example.org', verified: true }), { ip: ip(0) });
  assert.equal(r.done.location, '/#auth=confirm');
  assert.equal(r.rt, null, 'nobody is signed in');
  assert.equal(users(obj).length, 0, 'no account (I3)');
  assert.match(r.pendLine, /^__Host-tg_pend=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=1800$/);
  const c = claims(r.pend);
  assert.deepEqual([c.typ, c.p, c.id, c.email, c.trust, c.lvl, c.exp - c.iat], ['pend', 'discord', 'd-nueva', 'nueva@example.org', 'asserted', 1, 1800]);
  // The pending JWT is never a session.
  assert.equal(await AUTH.verifySession(SECRET, r.pend), null);
  assert.equal((await req(env, 'GET', '/api/me', { ip: ip(0), bearer: r.pend })).status, 401);
  const info = await pendingOf(env, r.pend, ip(0));
  assert.equal(info.status, 200);
  assert.deepEqual(info.json, { provider: 'discord', email: 'nueva@example.org', trust: 'asserted', second: null, match: null });
  assert.equal((await post(env, '/api/auth/pending', { ip: ip(0) })).json.error, 'no_pending');
  const made = await create(env, r.pend, 'Nadia', ip(0), { news: false, lang: 'es', tz: 'America/Argentina/Cordoba' });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  assert.equal(made.json.name, 'Nadia');
  assert.equal(claims(made.json.session).aal, 1, "the callback's level: a press on Discord's page");
  assert.ok(cookieOf(made.raw, '__Host-tg_rt'), 'signed in now');
  assert.match(cookieLine(made.raw, '__Host-tg_pend'), /Max-Age=0/, 'the pending cookie cleared');
  const u = row(obj, made.json.playerId);
  assert.deepEqual([u.discord_id, u.username, u.lang, u.tz, u.email_canon, u.email_hint], ['d-nueva', 'Nadia', 'es', 'America/Argentina/Cordoba', null, 'nueva@example.org']);
  // The same identity signs in from now on.
  const again = await oauth(env, 'discord', discord('d-nueva', { email: 'nueva@example.org', verified: true }), { ip: ip(1) });
  assert.equal(again.done.location, '/#auth=ok');
  assert.equal(users(obj).length, 1);
  // CANCELAR clears the cookie.
  const p = await oauth(env, 'discord', discord('d-otra'), { ip: ip(2) });
  const cancel = await post(env, '/api/auth/pending/cancel', { ip: ip(2), cookie: '__Host-tg_pend=' + p.pend });
  assert.equal(cancel.status, 200);
  assert.match(cookieLine(cancel.raw, '__Host-tg_pend'), /Max-Age=0/);
});

test('I9: the trust of an address is the server\'s: an unverified address is none; a forged email, canon, trust or verified flag in the create body changes nothing; a forged pending cookie is refused', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const r = await oauth(env, 'discord', discord('d-sin', { email: 'sin@example.org', verified: false }), { ip: ip(0) });
  assert.deepEqual((await pendingOf(env, r.pend, ip(0))).json, { provider: 'discord', email: null, trust: 'none', second: null, match: null });
  const made = await create(env, r.pend, 'Sinmail', ip(0), { email: 'victim@gmail.com', canon: 'victim@gmail.com', emailCanon: 'victim@gmail.com', trust: 'auth', verified: true, emailVerified: true, provider: 'google', id: 'g-victim' });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const u = row(obj, made.json.playerId);
  assert.deepEqual([u.email, u.email_canon, u.email_hint, u.google_sub, u.discord_id], [null, null, null, null, 'd-sin']);
  // The cookie is signed by the Worker: another secret's, or one with its payload changed, is no pending identity.
  const fake = await AUTH.signJwt('another-secret', { typ: 'pend', p: 'discord', id: 'd-x', email: 'victim@gmail.com', trust: 'auth', lvl: 1, iat: 1, exp: 4e9 });
  assert.equal((await pendingOf(env, fake, ip(1))).status, 404);
  const r2 = await oauth(env, 'discord', discord('d-dos'), { ip: ip(2) });
  const [h, , s] = r2.pend.split('.');
  const forged = h + '.' + Buffer.from(JSON.stringify({ ...claims(r2.pend), email: 'victim@gmail.com', trust: 'auth' })).toString('base64url') + '.' + s;
  assert.equal((await create(env, forged, 'Forjado', ip(2))).status, 404);
  // Google is never authoritative in this build: a Gmail address is a hint, not a claim (the Google PR claims it).
  const g = await oauth(env, 'google', google('g-gmail', { email: 'Ana.Perez@gmail.com', email_verified: true }), { ip: ip(3) });
  assert.equal(claims(g.pend).trust, 'asserted');
  const gm = await create(env, g.pend, 'AnaG', ip(3));
  assert.deepEqual([row(obj, gm.json.playerId).email_canon, row(obj, gm.json.playerId).email_hint_canon], [null, 'anaperez@gmail.com']);
});

// ---- pending: the match ----------------------------------------------------------------------------

test('pending: /pending reports a match through a claim and through a hint; create with a match is 409 email_has_account; a Discord create stores a hint and no canon', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const ana = await legacyAccount(obj, 'Ana');
  assert.equal(obj.store.claimEmail(ana.id, 'ana@gmail.com', 'mail', Date.now()), 'ok');
  // A Discord account made now: its address is a hint (Discord's `verified` is no proof of today's owner).
  const b = await oauth(env, 'discord', discord('d-beto', { email: 'Beto@Example.org', verified: true }), { ip: ip(0) });
  const beto = await create(env, b.pend, 'Beto', ip(0));
  assert.equal(beto.status, 200);
  const br = row(obj, beto.json.playerId);
  assert.deepEqual([br.email, br.email_canon, br.email_hint, br.email_hint_canon, br.email_hint_from], [null, null, 'beto@example.org', 'beto@example.org', 'discord']);
  // Another Discord account whose verified address is Ana's (another spelling of it): the claim matches.
  const x = await oauth(env, 'discord', discord('d-ana2', { email: 'A.na+tg@GoogleMail.com', verified: true }), { ip: ip(1) });
  assert.deepEqual((await pendingOf(env, x.pend, ip(1))).json, { provider: 'discord', email: 'a.na+tg@googlemail.com', trust: 'asserted', second: null, match: { name: 'Ana', methods: ['password'], via: 'email', email: 'a.na+tg@googlemail.com' } });
  const before = users(obj).length;
  const refused = await create(env, x.pend, 'Ana_2', ip(1));
  assert.deepEqual([refused.status, refused.json.error], [409, 'email_has_account']);
  assert.equal(users(obj).length, before, 'one email, one account');
  // Beto's hint matches too.
  const y = await oauth(env, 'discord', discord('d-beto2', { email: 'beto@example.org', verified: true }), { ip: ip(2) });
  assert.deepEqual((await pendingOf(env, y.pend, ip(2))).json.match, { name: 'Beto', methods: ['discord'], via: 'hint', email: 'beto@example.org' });
  assert.equal((await create(env, y.pend, 'Beto2', ip(2))).json.error, 'email_has_account');
  // An address the provider never verified finds nothing.
  const z = await oauth(env, 'discord', discord('d-sinver', { email: 'ana@gmail.com', verified: false }), { ip: ip(3) });
  assert.equal((await pendingOf(env, z.pend, ip(3))).json.match, null);
  // A taken name is 409 with a free suggestion.
  const t = await oauth(env, 'discord', discord('d-tomado'), { ip: ip(4) });
  const taken = await create(env, t.pend, 'beto', ip(4));
  assert.equal(taken.json.error, 'username_taken');
  assert.equal(ACC.usernameProblem(taken.json.suggest), null);
  assert.equal(obj.store.usernameTaken(taken.json.suggest), false);
  // The name rules hold, the email sign-up's (section 5.2; the merge with sign-in PR 7): a guest's
  // name is reserved (400 name_reserved, a free suggestion), one that is no username is bad_username.
  const guest = await create(env, t.pend, 'Guest_1', ip(4));
  assert.deepEqual([guest.status, guest.json.error], [400, 'name_reserved'], "the name rules hold (a guest's)");
  assert.equal(ACC.usernameIssue(guest.json.suggest), null);
  assert.deepEqual([(await create(env, t.pend, 'tg-verify.com', ip(4))).json.error], ['bad_username']);
});

// ---- linking -----------------------------------------------------------------------------------------

test('linking: the legacy login with linkPending links only to the match; another account signs in but links nothing (wrong_account); with no match any account links it', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  // Ana carries the address as a hint (an account with a verified one signs in by email, never by
  // username: the legacy sign-in refuses it, the design's downgrade rule).
  const ana = await legacyAccount(obj, 'Ana');
  assert.equal(obj.store.setEmailHint(ana.id, 'ana@gmail.com', 'google'), 'ok');
  const carla = await legacyAccount(obj, 'Carla');
  const p = await oauth(env, 'discord', discord('d-ana', { email: 'ana@gmail.com', verified: true }), { ip: ip(0) });
  assert.equal((await pendingOf(env, p.pend, ip(0))).json.match.name, 'Ana');
  const wrong = await login(env, carla, 'Carla', ip(0), { linkPending: true }, '__Host-tg_pend=' + p.pend);
  assert.equal(wrong.status, 200, 'the sign-in stands');
  assert.deepEqual([wrong.json.name, wrong.json.linkError, wrong.json.linked], ['Carla', 'wrong_account', undefined]);
  assert.equal(row(obj, carla.id).discord_id, null);
  assert.match(cookieLine(wrong.raw, '__Host-tg_pend'), /Max-Age=0/);
  const right = await login(env, ana, 'Ana', ip(1), { linkPending: true }, '__Host-tg_pend=' + p.pend);
  assert.deepEqual([right.status, right.json.linked], [200, ['discord']]);
  assert.equal(row(obj, ana.id).discord_id, 'd-ana');
  assert.ok(row(obj, ana.id).discord_linked_at > 0);
  // The Discord identity now signs in to Ana.
  const back = await oauth(env, 'discord', discord('d-ana', { email: 'ana@gmail.com', verified: true }), { ip: ip(2) });
  assert.equal(back.done.location, '/#auth=ok');
  // No match: whoever signs in links it.
  const q = await oauth(env, 'discord', discord('d-libre'), { ip: ip(3) });
  const free = await login(env, carla, 'Carla', ip(3), { linkPending: true }, '__Host-tg_pend=' + q.pend);
  assert.deepEqual(free.json.linked, ['discord']);
  assert.equal(row(obj, carla.id).discord_id, 'd-libre');
  // linkPending without a pending cookie: signed in, nothing linked.
  const none = await login(env, carla, 'Carla', ip(4), { linkPending: true });
  assert.deepEqual([none.status, none.json.linkError], [200, 'no_pending']);
  // A login without linkPending leaves a pending cookie alone.
  const r = await oauth(env, 'discord', discord('d-aparte'), { ip: ip(5) });
  const plain = await login(env, carla, 'Carla', ip(5), {}, '__Host-tg_pend=' + r.pend);
  assert.equal(cookieLine(plain.raw, '__Host-tg_pend'), null);
  assert.equal(plain.json.linked, undefined);
});

test('pend=1: an unowned identity of the other provider joins as p2 and CREAR makes one account with both; the same provider says no_account and keeps the cookie; an owned one signs in and links (/#auth=linked)', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const d = await oauth(env, 'discord', discord('d-uno'), { ip: ip(0) });
  const g = await oauth(env, 'google', google('g-uno', { email: 'uno@gmail.com', email_verified: true }), { query: '?pend=1', pend: d.pend, ip: ip(0) });
  assert.equal(g.done.location, '/#auth=confirm');
  assert.equal(g.rt, null);
  assert.equal(users(obj).length, 0);
  assert.deepEqual(claims(g.pend).p2, { p: 'google', id: 'g-uno', email: 'uno@gmail.com', trust: 'asserted' });
  assert.equal((await pendingOf(env, g.pend, ip(0))).json.second, 'google');
  const made = await create(env, g.pend, 'Uno', ip(0));
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const u = row(obj, made.json.playerId);
  assert.deepEqual([u.discord_id, u.google_sub, u.email_hint], ['d-uno', 'g-uno', 'uno@gmail.com']);
  // The same provider again: "that one has no account either", and the pending identity stays.
  const d2 = await oauth(env, 'discord', discord('d-dos'), { ip: ip(1) });
  const again = await oauth(env, 'discord', discord('d-tres'), { query: '?pend=1', pend: d2.pend, ip: ip(1) });
  assert.equal(again.done.location, '/#auth=error:no_account');
  assert.equal(again.pendLine, null, 'the cookie is kept');
  assert.equal((await pendingOf(env, d2.pend, ip(1))).json.provider, 'discord');
  // "I have one" with an identity that has an account: it signs in, and the pending one is linked to it.
  const e = await oauth(env, 'google', google('g-eva'), { ip: ip(2) });
  const eva = await create(env, e.pend, 'Eva', ip(2));
  const d4 = await oauth(env, 'discord', discord('d-eva'), { ip: ip(2) });
  const link = await oauth(env, 'google', google('g-eva'), { query: '?pend=1', pend: d4.pend, ip: ip(2) });
  assert.equal(link.done.location, '/#auth=linked');
  assert.ok(link.rt, 'signed in');
  assert.match(link.pendLine, /Max-Age=0/);
  assert.equal(row(obj, eva.json.playerId).discord_id, 'd-eva');
  // pend=1 with no pending cookie (30 minutes passed): an unowned identity is a plain confirm.
  const late = await oauth(env, 'discord', discord('d-tarde'), { query: '?pend=1', ip: ip(3) });
  assert.equal(late.done.location, '/#auth=confirm');
  assert.equal(claims(late.pend).p2, undefined);
});

test('overwrite is refused: a pending identity never replaces the provider an account has (provider_set), by password or by pend=1', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const fede = await legacyAccount(obj, 'Fede');
  obj.store.oauth('discord', 'd-fede', fede.id, 'f'.repeat(64), Date.now());
  const p = await oauth(env, 'discord', discord('d-intruso'), { ip: ip(0) });
  const r = await login(env, fede, 'Fede', ip(0), { linkPending: true }, '__Host-tg_pend=' + p.pend);
  assert.deepEqual([r.status, r.json.linkError], [200, 'provider_set']);
  assert.equal(row(obj, fede.id).discord_id, 'd-fede');
  // pend=1: an account with both providers signs in with Google; the pending Discord is not taken.
  const h = await oauth(env, 'google', google('g-hugo'), { ip: ip(1) });
  const hugo = await create(env, h.pend, 'Hugo', ip(1));
  obj.store.oauth('discord', 'd-hugo', hugo.json.playerId, 'a'.repeat(64), Date.now());
  const q = await oauth(env, 'discord', discord('d-otro'), { ip: ip(1) });
  const s = await oauth(env, 'google', google('g-hugo'), { query: '?pend=1', pend: q.pend, ip: ip(1) });
  assert.equal(s.done.location, '/#auth=ok:provider_set');
  assert.equal(row(obj, hugo.json.playerId).discord_id, 'd-hugo');
  // An identity that got an owner meanwhile (another tab linked it): CREAR refuses it (already_linked).
  const w = await oauth(env, 'discord', discord('d-carrera'), { ip: ip(2) });
  const ivan = await legacyAccount(obj, 'Ivan');
  assert.equal(obj.store.oauth('discord', 'd-carrera', ivan.id, 'c'.repeat(64), Date.now()).userId, ivan.id);
  assert.equal((await create(env, w.pend, 'Carrera', ip(2))).json.error, 'already_linked');
});

// ---- the identity ------------------------------------------------------------------------------------

test('identity: a changed provider address replaces the hint and nothing else; no address keeps it; a verified email never follows the provider; a claimed canon never becomes a hint', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const p = await oauth(env, 'discord', discord('d-juan', { email: 'one@example.org', verified: true }), { ip: ip(0) });
  const juan = (await create(env, p.pend, 'Juan', ip(0))).json.playerId;
  const before = row(obj, juan);
  await oauth(env, 'discord', discord('d-juan', { email: 'Two@Example.org', verified: true }), { ip: ip(1) });
  const after = row(obj, juan);
  assert.deepEqual([after.email_hint, after.email_hint_canon, after.email_hint_from], ['two@example.org', 'two@example.org', 'discord']);
  for (const k of ['username', 'ukey', 'discord_id', 'google_sub', 'email', 'email_canon', 'pw_hash', 'created_at', 'renamed_at']) assert.equal(after[k], before[k], k);
  await oauth(env, 'discord', discord('d-juan'), { ip: ip(2) });
  assert.equal(row(obj, juan).email_hint, 'two@example.org', 'no address: the hint stays');
  await oauth(env, 'discord', discord('d-juan', { email: 'three@example.org', verified: false }), { ip: ip(3) });
  assert.equal(row(obj, juan).email_hint, 'two@example.org', 'an unverified one changes nothing');
  // A verified email is the account's own.
  assert.equal(obj.store.claimEmail(juan, 'juan@turbo-mail.org', 'mail', Date.now()), 'ok');
  await oauth(env, 'discord', discord('d-juan', { email: 'four@example.org', verified: true }), { ip: ip(4) });
  assert.deepEqual([row(obj, juan).email, row(obj, juan).email_hint], ['juan@turbo-mail.org', null]);
  // Another account claimed this address: no hint of it on this one.
  const p2 = await oauth(env, 'discord', discord('d-kim'), { ip: ip(5) });
  const kim = (await create(env, p2.pend, 'Kim', ip(5))).json.playerId;
  await oauth(env, 'discord', discord('d-kim', { email: 'juan@turbo-mail.org', verified: true }), { ip: ip(6) });
  assert.equal(row(obj, kim).email_hint, null);
  // A link fills it in too (§3.8 step 6).
  const lia = await legacyAccount(obj, 'Lia');
  const s = await login(env, lia, 'Lia', ip(7));
  const l = await oauth(env, 'google', google('g-lia', { email: 'lia@example.org', email_verified: true }), { query: '?link=1', cookie: '__Host-tg_rt=' + cookieOf(s.raw, '__Host-tg_rt'), ip: ip(7) });
  assert.equal(l.done.location, '/#auth=linked');
  assert.deepEqual([row(obj, lia.id).google_sub, row(obj, lia.id).email_hint, row(obj, lia.id).email_hint_from], ['g-lia', 'lia@example.org', 'google']);
});

test('identity: no provider name is ever read: the account takes only the name the player typed, and oauthIdentity names no name field', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const p = await oauth(env, 'discord', discord('d-pepe', { username: 'Moderador', global_name: 'Ana Pérez García' }), { ip: ip(0) });
  assert.doesNotMatch(Buffer.from(p.pend.split('.')[1], 'base64url').toString(), /Moderador|Ana P/, 'the pending cookie holds no name');
  const made = await create(env, p.pend, 'Pepe', ip(0));
  assert.equal(made.json.name, 'Pepe');
  assert.deepEqual(users(obj).map((u) => u.username), ['Pepe']);
  const src = readFileSync(new URL('../src/accountRoutes.ts', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export async function oauthIdentity'), src.indexOf('\n}\n', src.indexOf('export async function oauthIdentity')));
  assert.doesNotMatch(body.replace(/\/\/.*$/gm, ''), /given_name|global_name|u\.name|u\.username/, 'the code, its comments aside');
  assert.doesNotMatch(readFileSync(new URL('../src/accountStore.ts', import.meta.url), 'utf8'), /usernameFromDisplay/);
});

// ---- create: Turnstile and the per-network cap --------------------------------------------------------

test('create: a solved Turnstile check is required before the AccountsDO hears of it; new accounts per network are capped (durable), a school behind one IPv4 address makes 18 in a row', async () => {
  const { env, obj, calls, db } = makeEnv(TURNSTILE_ON);
  const ip = ips();
  const p = await oauth(env, 'discord', discord('d-ts'), { ip: ip(0) });
  for (const body of [{ username: 'Tomas' }, { username: 'Tomas', turnstileToken: 'bad-token' }]) {
    calls.length = 0;
    const r = await create(env, p.pend, body.username, ip(0), body);
    assert.deepEqual([r.status, r.json.error], [403, 'turnstile_failed']);
    assert.ok(!calls.includes('/pending-create'), 'refused before the AccountsDO');
  }
  assert.equal((await create(env, p.pend, 'Tomas', ip(0), { turnstileToken: 'good-token' })).status, 200);
  // A classroom behind one IPv4 address: 18 accounts in a row (each its own Discord and check; the
  // OAuth start's per-isolate pre-filter of main, 20 a minute per address, is the edge PR's).
  const school = '203.0.113.77';
  for (let i = 0; i < 18; i++) {
    const s = await oauth(env, 'discord', discord('d-alumno' + i), { ip: school });
    const r = await create(env, s.pend, 'Alumno' + i, school, { turnstileToken: 'good-token' });
    assert.equal(r.status, 200, `alumno ${i}: ${JSON.stringify(r.json)}`);
  }
  // The cap: NEW_ACCOUNTS a day per network (an IPv4 address or an IPv6 /64), NEW_ACCOUNTS_SITE per
  // /48, the email sign-up's counters (one budget for both ways in: see "one budget" below).
  assert.deepEqual([NEW_ACCOUNTS.v4.day, NEW_ACCOUNTS.v6.day, NEW_ACCOUNTS_SITE.day], [200, 200, 300]);
  const seed = (o, key, n) => o.store.mailWindowsWrite(new Map([[key, { hour_at: Date.now(), hour_n: 0, day_at: Date.now(), day_n: n }]]));
  const net = '198.51.100.9';
  const [na] = await obj.newAccountCaps(net);
  seed(obj, na.key, NEW_ACCOUNTS.v4.day - 1);
  const last = await oauth(env, 'discord', discord('d-ultimo'), { ip: net });
  assert.equal((await create(env, last.pend, 'Ultimo', net, { turnstileToken: 'good-token' })).status, 200);
  const over = await oauth(env, 'discord', discord('d-demas'), { ip: net });
  const refused = await create(env, over.pend, 'Demas', net, { turnstileToken: 'good-token' });
  assert.deepEqual([refused.status, refused.json.error], [429, 'rate_limited']);
  // It survives a restart of the object (SQLite), and another network is not touched.
  const { obj: again } = attach(env, db);
  assert.equal((await create(env, over.pend, 'Demas', net, { turnstileToken: 'good-token' })).status, 429);
  assert.equal((await create(env, over.pend, 'Demas', '198.51.100.10', { turnstileToken: 'good-token' })).status, 200);
  // IPv6: rotating /64s inside one /48 stops at the /48's cap.
  const [, ns] = await again.newAccountCaps('2001:db8:5:1::1');
  seed(again, ns.key, NEW_ACCOUNTS_SITE.day - 1);
  const v6a = await oauth(env, 'discord', discord('d-v6a'), { ip: '2001:db8:5:1::1' });
  assert.equal((await create(env, v6a.pend, 'Seisa', '2001:db8:5:1::1', { turnstileToken: 'good-token' })).status, 200);
  const v6b = await oauth(env, 'discord', discord('d-v6b'), { ip: '2001:db8:5:2::1' });
  assert.equal((await create(env, v6b.pend, 'Seisb', '2001:db8:5:2::1', { turnstileToken: 'good-token' })).status, 429);
  // A day later the window is new.
  again.now = () => Date.now() + 25 * 60 * 60_000;
  assert.equal((await create(env, v6b.pend, 'Seisb', '2001:db8:5:2::1', { turnstileToken: 'good-token' })).status, 200);
});

// ---- then=link and DISCORD_SILENT ----------------------------------------------------------------------

test('then=link:<p>: a re-authentication goes straight on to linking <p> for the device it just proved (no stop on the page, no Strict cookie needed)', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const d = await oauth(env, 'discord', discord('d-tito'), { ip: ip(0) });
  const tito = await create(env, d.pend, 'Tito', ip(0));
  const rt = cookieOf(tito.raw, '__Host-tg_rt');
  // Eleven minutes later the session is not fresh: "confirm it's you" with Discord, then on to Google.
  identity.discord = discord('d-tito');
  const start = await req(env, 'GET', '/api/auth/oauth/discord/start?reauth=1&then=link:google', { ip: ip(0), cookie: '__Host-tg_rt=' + rt, origin: null });
  const st = cookieOf(start.raw, '__Host-tg_oa');
  const back = await req(env, 'GET', `/api/auth/oauth/discord/callback?code=x&state=${new URL(start.location).searchParams.get('state')}`, { ip: ip(0), cookie: '__Host-tg_oa=' + st, origin: null });
  assert.equal(back.status, 302);
  assert.match(back.location, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/, 'straight on to Google');
  assert.equal(new URL(back.location).searchParams.get('prompt'), 'select_account');
  const rt2 = cookieOf(back.raw, '__Host-tg_rt');
  assert.ok(rt2, "the re-authentication's token");
  const st2 = cookieOf(back.raw, '__Host-tg_oa');
  assert.equal(claims(st2).link, tito.json.playerId);
  identity.google = google('g-tito');
  const linked = await req(env, 'GET', `/api/auth/oauth/google/callback?code=x&state=${new URL(back.location).searchParams.get('state')}`, { ip: ip(0), cookie: '__Host-tg_oa=' + st2, origin: null });
  assert.equal(linked.location, '/#auth=linked');
  assert.equal(row(obj, tito.json.playerId).google_sub, 'g-tito');
  // then= names a provider that is not configured, or comes without reauth: no chain.
  const env2 = { ...env, GOOGLE_CLIENT_ID: undefined };
  const s2 = await req(env2, 'GET', '/api/auth/oauth/discord/start?reauth=1&then=link:google', { ip: ip(1), cookie: '__Host-tg_rt=' + cookieOf(linked.raw, '__Host-tg_rt'), origin: null });
  assert.equal(claims(cookieOf(s2.raw, '__Host-tg_oa')).then, undefined);
  const s3 = await req(env, 'GET', '/api/auth/oauth/discord/start?then=link:google', { ip: ip(1), origin: null });
  assert.equal(claims(cookieOf(s3.raw, '__Host-tg_oa')).then, undefined);
});

test('DISCORD_SILENT=1: a plain Discord sign-in asks prompt=none (level 0); consent_required starts once more with the press; a link, a reauth and pend=1 always ask for the press', async () => {
  const { env, obj } = makeEnv({ DISCORD_SILENT: '1' });
  const ip = ips();
  const start = await req(env, 'GET', '/api/auth/oauth/discord/start', { ip: ip(0), origin: null });
  assert.equal(new URL(start.location).searchParams.get('prompt'), 'none');
  const st = cookieOf(start.raw, '__Host-tg_oa');
  assert.deepEqual([claims(st).sil, claims(st).lvl], [1, undefined]);
  const nonce = new URL(start.location).searchParams.get('state');
  const retry = await req(env, 'GET', `/api/auth/oauth/discord/callback?error=consent_required&state=${nonce}`, { ip: ip(0), cookie: '__Host-tg_oa=' + st, origin: null });
  assert.match(retry.location, /^https:\/\/discord\.com\/oauth2\/authorize\?/);
  assert.equal(new URL(retry.location).searchParams.get('prompt'), 'consent');
  assert.equal(claims(cookieOf(retry.raw, '__Host-tg_oa')).lvl, 1);
  const twice = await req(env, 'GET', `/api/auth/oauth/discord/callback?error=consent_required&state=${nonce}`, { ip: ip(0), cookie: '__Host-tg_oa=' + st, origin: null });
  assert.equal(twice.location, '/#auth=error:cancelled', 'once only');
  // A silent sign-in of an account is level 0: never fresh.
  const p = await oauth(env, 'discord', discord('d-silencio'), { ip: ip(1) });
  const made = await create(env, p.pend, 'Silencio', ip(1));
  assert.equal(claims(made.json.session).aal, undefined, 'level 0');
  const s = await oauth(env, 'discord', discord('d-silencio'), { ip: ip(2) });
  const ref = await post(env, '/api/auth/refresh', { ip: ip(2), cookie: '__Host-tg_rt=' + s.rt });
  assert.equal(claims(ref.json.session).aal, undefined);
  assert.equal(row(obj, made.json.playerId).discord_id, 'd-silencio');
  // The others press.
  const pend = await req(env, 'GET', '/api/auth/oauth/discord/start?pend=1', { ip: ip(3), origin: null });
  assert.equal(new URL(pend.location).searchParams.get('prompt'), 'consent');
  const re = await req(env, 'GET', '/api/auth/oauth/discord/start?reauth=1', { ip: ip(3), cookie: '__Host-tg_rt=' + cookieOf(ref.raw, '__Host-tg_rt'), origin: null });
  assert.equal(new URL(re.location).searchParams.get('prompt'), 'consent', '"confirm it\'s you" is a press');
  const off = makeEnv();
  const plain = await req(off.env, 'GET', '/api/auth/oauth/discord/start', { ip: ip(4), origin: null });
  assert.equal(new URL(plain.location).searchParams.get('prompt'), 'consent', 'off by default');
});

// ---- the TV ------------------------------------------------------------------------------------------

test('tv/renew: a new code bound to the same secret, the old one live to its end; a confirm of the old one in its last seconds reaches the TV; at most 6 renewals; a wrong secret is an unknown code; a confirmed code is 409', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  // The object's clock: the TV renews 20 s before its code ends (tvSignInModel.ts RENEW_BEFORE_MS).
  let clock = Date.now();
  obj.now = () => clock;
  const st = await post(env, '/api/auth/tv/start', { ip: ip(0) });
  assert.equal(st.status, 200);
  clock = st.json.expiresAt - 20_000;
  const r = await post(env, '/api/auth/tv/renew', { ip: ip(0), body: { code: st.json.code, secret: st.json.secret } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(r.json.code, /^[A-Z2-9]{6}$/);
  assert.notEqual(r.json.code, st.json.code);
  assert.equal(r.json.expiresAt, clock + TV.TV_CODE_TTL_MS, 'a whole new life');
  assert.ok(Math.abs(r.json.ttlMs - (r.json.expiresAt - Date.now())) < 5000);
  assert.equal((await post(env, '/api/auth/tv/poll', { ip: ip(0), body: { code: r.json.code, secret: st.json.secret } })).json.state, 'pending');
  // The phone types the old code (still on the screen it read): the TV, polling the new one, is approved.
  const phone = await legacyAccount(obj, 'Telefono');
  const ps = await login(env, phone, 'Telefono', ip(1));
  assert.equal((await post(env, '/api/auth/tv/confirm', { ip: ip(1), bearer: ps.json.session, body: { code: st.json.code } })).status, 200);
  const ok = await post(env, '/api/auth/tv/poll', { ip: ip(0), body: { code: r.json.code, secret: st.json.secret } });
  assert.deepEqual([ok.json.state, ok.json.name, ok.json.tv], ['approved', 'Telefono', true]);
  assert.equal((await post(env, '/api/auth/tv/poll', { ip: ip(0), body: { code: st.json.code, secret: st.json.secret } })).status, 409, 'one use, both codes');
  // Six renewals, then the code is over.
  const t = await post(env, '/api/auth/tv/start', { ip: ip(2) });
  let code = t.json.code;
  let ends = t.json.expiresAt;
  for (let i = 0; i < TV.TV_RENEWS_MAX; i++) {
    clock = ends - 20_000;
    const n = await post(env, '/api/auth/tv/renew', { ip: ip(2), body: { code, secret: t.json.secret } });
    assert.equal(n.status, 200, `renewal ${i + 1}`);
    code = n.json.code;
    ends = n.json.expiresAt;
  }
  clock = ends - 20_000;
  assert.deepEqual([(await post(env, '/api/auth/tv/renew', { ip: ip(2), body: { code, secret: t.json.secret } })).json.error], ['tv_code_expired']);
  assert.equal((await post(env, '/api/auth/tv/renew', { ip: ip(2), body: { code, secret: 'x'.repeat(43) } })).status, 410, 'a wrong secret');
  // A confirmed code: the TV polls it instead.
  const u = await post(env, '/api/auth/tv/start', { ip: ip(3) });
  await post(env, '/api/auth/tv/confirm', { ip: ip(1), bearer: ps.json.session, body: { code: u.json.code } });
  assert.deepEqual([(await post(env, '/api/auth/tv/renew', { ip: ip(3), body: { code: u.json.code, secret: u.json.secret } })).status], [409]);
});

test('tv/renew counts toward the start\'s caps and never takes another TV\'s code: a /48 that holds its 20 renews one (its old code not counted), and a second is 503 busy until that old code ends', async () => {
  const { env, obj } = makeEnv();
  const starts = [];
  for (let i = 0; i < TV.TV_CODES_PER_48; i++) starts.push((await post(env, '/api/auth/tv/start', { ip: `2001:db8:61:${i.toString(16)}::1` })).json);
  obj.now = () => Date.now() + TV.TV_CODE_TTL_MS - 20_000; // the TVs renew 20 s before their codes end
  const one =await post(env, '/api/auth/tv/renew', { ip: '2001:db8:61:0::1', body: { code: starts[0].code, secret: starts[0].secret } });
  assert.equal(one.status, 200);
  const two = await post(env, '/api/auth/tv/renew', { ip: '2001:db8:61:1::1', body: { code: starts[1].code, secret: starts[1].secret } });
  assert.deepEqual([two.status, two.json.error], [503, 'busy']);
  for (const s of starts.slice(1)) assert.equal((await post(env, '/api/auth/tv/poll', { ip: '2001:db8:61:1::1', body: { code: s.code, secret: s.secret } })).json.state, 'pending', 'every other TV keeps its code');
  assert.ok(obj);
  // On the table's own clock: once the first old code has ended, the second TV renews.
  const t = new TV.TvCodes();
  const T0 = 1_000_000;
  const h = (i) => i.toString(16).padStart(64, '0');
  const codes = [];
  for (let i = 0; i < TV.TV_CODES_PER_48; i++) codes.push(t.start(`2001:db8:62:${i.toString(16)}::1`, h(i), T0 + i * 1000).code);
  const renewAt = T0 + TV.TV_CODE_TTL_MS - 20_000;
  assert.equal(typeof t.renew(codes[0], h(0), '2001:db8:62:0::1', renewAt), 'object');
  assert.equal(t.renew(codes[1], h(1), '2001:db8:62:1::1', renewAt + 1000), 'busy', "the /48 holds 21 live codes until the first one's old code ends");
  assert.equal(typeof t.renew(codes[1], h(1), '2001:db8:62:1::1', T0 + TV.TV_CODE_TTL_MS + 1), 'object');
});

// The review of PR 6: renewing the same code again minted another live code each time (one solved
// check filled a network's whole cap, and from many networks a tenth of the table). A code is
// renewed once, in its last minute, and a repeat answers the same new code.
/** The live codes bound to `secret` in a TvCodes, at `now`. */
const liveFor = (t, secret, now) => [...t.codes.values()].filter((e) => e.secretHash === secret && !e.used && e.expiresAt > now).length;

test('tv/renew renews a code once: the same code renewed again, from its own address or from 40 other networks, answers the same new code; before its last minute it is refused; one start then holds two live codes', () => {
  const t = new TV.TvCodes();
  const T0 = 5_000_000;
  const secret = 'ab'.repeat(32);
  const s = t.start('203.0.113.7', secret, T0);
  assert.equal(t.renew(s.code, secret, '203.0.113.7', T0 + 1000), 'early', 'right after the start');
  assert.equal(t.renew(s.code, secret, '203.0.113.7', s.expiresAt - TV.TV_RENEW_WINDOW_MS - 1), 'early', 'before its last minute');
  assert.ok(TV.TV_RENEW_WINDOW_MS >= 3 * 20_000, 'the TV asks 20 s before the end: a slow one has room');
  const at = s.expiresAt - 20_000;
  const first = t.renew(s.code, secret, '203.0.113.7', at);
  assert.equal(typeof first, 'object');
  for (let i = 0; i < 25; i++) assert.deepEqual(t.renew(s.code, secret, '203.0.113.7', at + i), first, `a repeat from the same address (${i})`);
  for (let n = 0; n < 40; n++) assert.deepEqual(t.renew(s.code, secret, `2001:db8:${(0x100 + n).toString(16)}::1`, at + 100 + n), first, `a repeat from another network (${n})`);
  assert.equal(liveFor(t, secret, at + 200), 2, 'the old code (to its end) and one new one');
  assert.equal(t.size, 2, 'nothing else in the table');
  // The old code ends: a repeat now is over, and still mints nothing.
  assert.equal(t.renew(s.code, secret, '203.0.113.7', s.expiresAt), 'expired');
  assert.equal(t.size, 2);
});

test('tv/renew: one start is one chain, never a tree: every code it ever held, renewed again and again from three networks, right away and in the last seconds, makes TV_RENEWS_MAX + 1 codes in all and two live at once', () => {
  const t = new TV.TvCodes();
  const secret = 'cd'.repeat(32);
  let now = 7_000_000;
  const s = t.start('198.51.100.9', secret, now);
  const held = new Map([[s.code, s.expiresAt]]);
  const nets = ['198.51.100.9', '2001:db8:aa::1', '192.0.2.77'];
  let most = 1;
  for (let round = 0; round < 3 * TV.TV_RENEWS_MAX; round++) {
    for (const when of [now + 1, Math.max(...held.values()) - 20_000]) {
      now = Math.max(now, when);
      for (const c of [...held.keys()]) for (const ip of nets) for (let k = 0; k < 3; k++) {
        const r = t.renew(c, secret, ip, now);
        if (typeof r === 'object') held.set(r.code, r.expiresAt);
      }
      most = Math.max(most, liveFor(t, secret, now));
    }
  }
  assert.equal(held.size, TV.TV_RENEWS_MAX + 1, 'the start and its six renewals');
  assert.equal(most, 2);
  assert.equal(t.renew([...held.keys()].at(-1), secret, nets[0], Math.max(...held.values()) - 20_000), 'expired', 'the renewals are used up');
});

test('tv/renew: a repeat never answers another TV\'s code that took the new one\'s letters after it went', () => {
  const queue = [];
  const t = new TV.TvCodes((n) => queue.shift() ?? crypto.getRandomValues(new Uint8Array(n)));
  const letters = (k) => new Uint8Array(TV.TV_CODE_LENGTH).fill(k);
  const T0 = 9_000_000;
  const mine = 'ee'.repeat(32);
  queue.push(letters(0));
  const s = t.start('203.0.113.50', mine, T0);
  assert.equal(s.code, 'AAAAAA');
  queue.push(letters(1));
  const at = s.expiresAt - 20_000;
  assert.deepEqual(t.renew(s.code, mine, '2001:db8:400:1::1', at), { code: 'BBBBBB', expiresAt: at + TV.TV_CODE_TTL_MS });
  // Its /64 asks NUEVO CÓDIGO again and again: the new code is the oldest there and goes.
  for (let k = 2; k < 2 + TV.TV_CODES_PER_IP; k++) {
    queue.push(letters(k));
    assert.equal(typeof t.start('2001:db8:400:1::2', 'f'.repeat(64), at + k), 'object');
  }
  assert.equal(t.codes.has('BBBBBB'), false);
  queue.push(letters(1));
  assert.equal(t.start('198.51.100.200', '1'.repeat(64), at + 100).code, 'BBBBBB', "another TV's code, the same letters");
  assert.equal(t.renew(s.code, mine, '203.0.113.50', at + 200), 'expired');
});

test('tv/renew through the Worker: at once after the start it is 409 tv_renew_early; in the last seconds the same code renewed 25 times from one address and once from each of 40 /48s gives one new code', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const st = await post(env, '/api/auth/tv/start', { ip: ip(0) });
  assert.equal(st.status, 200);
  const early = await post(env, '/api/auth/tv/renew', { ip: ip(0), body: { code: st.json.code, secret: st.json.secret } });
  assert.deepEqual([early.status, early.json.error], [409, 'tv_renew_early']);
  obj.now = () => st.json.expiresAt - 20_000;
  const answers = [];
  for (let i = 0; i < 25; i++) answers.push(await post(env, '/api/auth/tv/renew', { ip: ip(0), body: { code: st.json.code, secret: st.json.secret } }));
  for (let n = 0; n < 40; n++) answers.push(await post(env, '/api/auth/tv/renew', { ip: `2001:db8:${(0x300 + n).toString(16)}::1`, body: { code: st.json.code, secret: st.json.secret } }));
  assert.deepEqual([...new Set(answers.map((a) => a.status))], [200]);
  assert.equal(new Set(answers.map((a) => a.json.code)).size, 1, 'one new code');
  assert.equal(obj.tv.size, 2, 'the start and its one renewal');
  assert.equal((await post(env, '/api/auth/tv/poll', { ip: ip(0), body: { code: answers[0].json.code, secret: st.json.secret } })).json.state, 'pending');
});

test('the live check\'s TV: a remote cannot answer Turnstile\'s challenge, so tv/start without a token gets a code under tighter caps; a script that skips the check gets a few per network and a tenth of the table; a TV that solves it is never stopped by them', async () => {
  const { env, obj } = makeEnv(TURNSTILE_ON);
  const st = await post(env, '/api/auth/tv/start', { ip: '198.51.100.40', body: {} });
  assert.equal(st.status, 200, 'a TV with only a remote still gets its code: ' + JSON.stringify(st.json));
  assert.match(st.json.code, /^[A-Z2-9]{6}$/);
  // The renewal of an unchecked code (20 s before its end, on the object's clock) stays unchecked.
  obj.now = () => Date.now() + TV.TV_CODE_TTL_MS - 20_000;
  const rn = await post(env, '/api/auth/tv/renew', { ip: '198.51.100.40', body: { code: st.json.code, secret: st.json.secret } });
  obj.now = () => Date.now();
  assert.equal(rn.status, 200);
  assert.equal(obj.tv.codes.get(rn.json.code).checked, false);
  // A failed token is still refused (it is not the TV's fallback).
  assert.equal((await post(env, '/api/auth/tv/start', { ip: '198.51.100.40', body: { turnstileToken: 'bad-token' } })).status, 403);
  const t = obj.tv;
  const live = (codes) => codes.filter((c) => t.codes.get(c) && !t.codes.get(c).used && t.codes.get(c).expiresAt > Date.now()).length;
  // One IPv4 address (a carrier's NAT): TV_OPEN_PER_IPV4 unchecked codes live at once, a new one for the oldest.
  const v4 = [];
  for (let i = 0; i < TV.TV_OPEN_PER_IPV4 + 3; i++) v4.push(t.start('198.51.101.7', 'a'.repeat(64), Date.now(), null, false).code);
  assert.equal(live(v4), TV.TV_OPEN_PER_IPV4);
  // Its /24: TV_OPEN_PER_24 unchecked, then busy; a checked start from it still passes.
  for (let i = 0; i < TV.TV_OPEN_PER_24 - TV.TV_OPEN_PER_IPV4; i++) assert.equal(typeof t.start(`198.51.101.${100 + i}`, 'a'.repeat(64), Date.now(), null, false), 'object', `open ${i}`);
  assert.equal(t.start('198.51.101.250', 'a'.repeat(64), Date.now(), null, false), 'busy');
  assert.equal(typeof t.start('198.51.101.250', 'a'.repeat(64), Date.now(), null, true), 'object', 'a TV that solved the check');
  // IPv6: TV_OPEN_PER_IP per /64 and TV_OPEN_PER_48 per /48.
  for (let i = 0; i < TV.TV_OPEN_PER_48; i++) assert.equal(typeof t.start(`2001:db8:66:${i}::1`, 'a'.repeat(64), Date.now(), null, false), 'object');
  assert.equal(t.start('2001:db8:66:ff::1', 'a'.repeat(64), Date.now(), null, false), 'busy');
  assert.equal(typeof t.start('2001:db8:66:ff::1', 'a'.repeat(64), Date.now(), null, true), 'object');
  // The whole table: TV_OPEN_MAX unchecked codes at most, the rest is for checked ones.
  for (let i = 0; t.start(`10.${(i >> 8) & 255}.${i & 255}.1`, 'a'.repeat(64), Date.now(), null, false) !== 'full'; i++) assert.ok(i < 3 * TV.TV_OPEN_MAX, 'never stops');
  let open = 0;
  for (const e of t.codes.values()) if (!e.checked && !e.used && e.expiresAt > Date.now()) open++;
  assert.equal(open, TV.TV_OPEN_MAX);
  assert.equal(typeof t.start('192.0.2.1', 'a'.repeat(64), Date.now(), null, true), 'object');
  // Where the gate is off (local dev) a start without a token is a checked one.
  const dev = makeEnv();
  await post(dev.env, '/api/auth/tv/start', { ip: '198.51.102.1', body: {} });
  assert.equal([...dev.obj.tv.codes.values()][0].checked, true);
});

// ---- where sign-in PR 7 (email accounts) meets this PR (the merge of main) ----------------------------
//
// The email sign-up claims an address with a mailed code; a provider gives an address the Worker
// trusts so far. One email, one account across both: a claim by either way in is the match of the
// other; linkPending works on the email sign-in and on a reset as on the legacy login; the confirm
// step's names follow the email sign-up's rules; and new accounts per network are one budget.

/** A live deploy's mail settings with a fake binding that only records (MAIL_LIVE in a test env: nothing can send). */
function mailEnv(extra = {}) {
  const outbox = [];
  const made = makeEnv({ EMAIL: { send: async (m) => void outbox.push(m) }, MAIL_LIVE: '1', MAIL_FROM: 'Turbogol <no-reply@turbo-gol.com>', MAIL_LINK_ORIGIN: ORIGIN, ...extra });
  return { ...made, outbox };
}
const codeIn = (m) => /^(\d{6})$/m.exec(m.text)?.[1] ?? null;
const resetLinkIn = (m) => /\/account#reset=([A-Za-z0-9_-]+)/.exec(m.text)?.[1] ?? null;
const KEY = await ACC.passwordKey(PW);

/** A whole email sign-up through the Worker (start, the mailed code, finish): its finish's answer. */
async function emailSignUp(env, outbox, email, username, ip) {
  const s = await post(env, '/api/auth/signup/start', { ip, body: { email, lang: 'es' } });
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const code = codeIn(outbox.at(-1));
  assert.match(code ?? '', /^\d{6}$/, 'M1 carries the code');
  return post(env, '/api/auth/signup/finish', { ip, body: { attempt: s.json.attempt, code, username, password: KEY, lang: 'es', tz: 'America/Argentina/Buenos_Aires' } });
}
const signin = (env, email, ip, extra = {}, cookie) => post(env, '/api/auth/signin', { ip, cookie, body: { email, password: KEY, ...extra } });

test('merge: one email, one account: an address an email sign-up claimed is the match of a provider\'s (via email), the create is refused, and the email sign-in with linkPending links it; a later Discord sign-in opens that account', async () => {
  const { env, obj, outbox } = mailEnv();
  const ip = ips();
  const made = await emailSignUp(env, outbox, 'ana.p@example.org', 'AnaPe', ip(0));
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const ana = made.json.playerId;
  assert.equal(row(obj, ana).email_canon, 'ana.p@example.org');
  // The same mailbox through Discord (verified there, another case): the email account is the match.
  const d = await oauth(env, 'discord', discord('d-anape', { email: 'Ana.P@Example.org', verified: true }), { ip: ip(1) });
  assert.equal(d.done.location, '/#auth=confirm');
  const info = await pendingOf(env, d.pend, ip(1));
  assert.deepEqual(info.json.match, { name: 'AnaPe', methods: ['password'], via: 'email', email: 'ana.p@example.org' });
  const refused = await create(env, d.pend, 'OtraAna', ip(1));
  assert.deepEqual([refused.status, refused.json.error], [409, 'email_has_account'], 'never a second account');
  // The match sheet's email form: POST /api/auth/signin with linkPending (section 2.3).
  const s = await signin(env, 'ana.p@example.org', ip(1), { linkPending: true }, '__Host-tg_pend=' + d.pend);
  assert.equal(s.status, 200, JSON.stringify(s.json));
  assert.equal(s.json.playerId, ana);
  assert.deepEqual(s.json.linked, ['discord']);
  assert.match(cookieLine(s.raw, '__Host-tg_pend') ?? '', /Max-Age=0/, 'the pending cookie goes');
  assert.ok(cookieOf(s.raw, '__Host-tg_rt'), 'signed in');
  assert.equal(row(obj, ana).discord_id, 'd-anape');
  assert.equal(users(obj).length, 1);
  const back = await oauth(env, 'discord', discord('d-anape', { email: 'ana.p@example.org', verified: true }), { ip: ip(2) });
  assert.equal(back.done.location, '/#auth=ok');
  assert.equal((await post(env, '/api/auth/refresh', { ip: ip(2), cookie: '__Host-tg_rt=' + back.rt })).json.playerId, ana);
  // Without linkPending the email sign-in answers as before; with it and no pending cookie, no_pending.
  const plain = await signin(env, 'ana.p@example.org', ip(3));
  assert.equal(plain.status, 200);
  assert.equal(plain.json.linked, undefined);
  assert.equal(plain.json.linkError, undefined);
  const none = await signin(env, 'ana.p@example.org', ip(3), { linkPending: true });
  assert.deepEqual([none.status, none.json.linkError], [200, 'no_pending']);
});

test('merge: the email sign-in with linkPending links only to the match (wrong_account, signed in all the same); with no match any account links it; a hint is cleared by the email sign-up that claims its address', async () => {
  const { env, obj, outbox } = mailEnv();
  const ip = ips();
  const ana = (await emailSignUp(env, outbox, 'ana@example.org', 'AnaMail', ip(0))).json.playerId;
  const beto = (await emailSignUp(env, outbox, 'beto@example.org', 'BetoMail', ip(1))).json.playerId;
  const d = await oauth(env, 'discord', discord('d-de-ana', { email: 'ana@example.org', verified: true }), { ip: ip(2) });
  const wrong = await signin(env, 'beto@example.org', ip(2), { linkPending: true }, '__Host-tg_pend=' + d.pend);
  assert.deepEqual([wrong.status, wrong.json.playerId, wrong.json.linkError], [200, beto, 'wrong_account']);
  assert.equal(row(obj, beto).discord_id, null);
  assert.equal(row(obj, ana).discord_id, null);
  // No address from the provider: no match, so the account that signs in takes it.
  const n = await oauth(env, 'discord', discord('d-sin-correo'), { ip: ip(3) });
  const ok = await signin(env, 'beto@example.org', ip(3), { linkPending: true }, '__Host-tg_pend=' + n.pend);
  assert.deepEqual(ok.json.linked, ['discord']);
  assert.equal(row(obj, beto).discord_id, 'd-sin-correo');
  // A Discord account made by the confirm step carries its address as a hint; the email sign-up of
  // that address gets M1 "hint", claims it and clears the hint: from then on it is that account's.
  const h = await oauth(env, 'discord', discord('d-pista', { email: 'pista@example.org', verified: true }), { ip: ip(4) });
  const hinted = (await create(env, h.pend, 'Pista', ip(4))).json.playerId;
  assert.equal(row(obj, hinted).email_hint_canon, 'pista@example.org');
  const claimer = await emailSignUp(env, outbox, 'pista@example.org', 'PistaMail', ip(5));
  assert.equal(claimer.status, 200, JSON.stringify(claimer.json));
  assert.equal(row(obj, hinted).email_hint_canon, null, 'the claim cleared the hint');
  const g = await oauth(env, 'google', google('g-pista', { email: 'pista@example.org', email_verified: true }), { ip: ip(6) });
  assert.deepEqual((await pendingOf(env, g.pend, ip(6))).json.match, { name: 'PistaMail', methods: ['password'], via: 'email', email: 'pista@example.org' });
});

test('merge: a reset with linkPending (the match sheet\'s "forgot your password?") links the pending identity to the account whose mailbox it proved', async () => {
  const { env, obj, outbox } = mailEnv();
  const ip = ips();
  const ana = (await emailSignUp(env, outbox, 'olvido@example.org', 'Olvido', ip(0))).json.playerId;
  const d = await oauth(env, 'discord', discord('d-olvido', { email: 'olvido@example.org', verified: true }), { ip: ip(1) });
  assert.equal((await post(env, '/api/auth/forgot', { ip: ip(1), body: { email: 'olvido@example.org', lang: 'es' } })).status, 200);
  const token = resetLinkIn(outbox.at(-1));
  assert.ok(token, 'M3 carries a reset link');
  const r = await post(env, '/api/auth/reset', { ip: ip(1), cookie: '__Host-tg_pend=' + d.pend, body: { token, password: await ACC.passwordKey('otra contraseña larga'), linkPending: true } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.playerId, r.json.linked], [ana, ['discord']]);
  assert.match(cookieLine(r.raw, '__Host-tg_pend') ?? '', /Max-Age=0/);
  assert.equal(row(obj, ana).discord_id, 'd-olvido');
  assert.equal(r.json.mail, undefined, 'the mail order never reaches the client');
});

test('merge: the confirm step\'s names are the email sign-up\'s (section 5.2): a look-alike of a protected account is 409 name_lookalike with a free suggestion, a reserved word 400 name_reserved', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const owner = (await create(env, (await oauth(env, 'discord', discord('d-proyecto'), { ip: ip(0) })).pend, 'Proyecto', ip(0))).json.playerId;
  assert.equal(obj.store.rebuildProtectedSkeletons([owner]), 1);
  const d = await oauth(env, 'discord', discord('d-imita'), { ip: ip(1) });
  const look = await create(env, d.pend, 'Pr0yect0', ip(1));
  assert.deepEqual([look.status, look.json.error], [409, 'name_lookalike']);
  assert.equal(ACC.usernameIssue(look.json.suggest), null);
  assert.equal(obj.store.isLookalike(look.json.suggest, null) || obj.store.usernameTaken(look.json.suggest), false);
  const reserved = await create(env, d.pend, 'Soporte_TG', ip(1), { lang: 'en' });
  assert.deepEqual([reserved.status, reserved.json.error], [400, 'name_reserved']);
  assert.match(reserved.json.suggest, /^Player\d{4}$/, 'the request\'s language');
  assert.equal(users(obj).length, 1, 'nothing made, the pending identity kept');
  assert.equal((await create(env, d.pend, look.json.suggest, ip(1))).status, 200);
});

test('merge: new accounts per network are one budget for the email sign-up and the OAuth confirm step (NEW_ACCOUNTS per IPv4 address or /64, NEW_ACCOUNTS_SITE per /48)', async () => {
  const { env, obj, outbox } = mailEnv({ EMAIL_DAILY_CAP: '1000' });
  const seed = async (ip, which, n) => {
    const caps = await obj.newAccountCaps(ip);
    obj.store.mailWindowsWrite(new Map([[caps[which].key, { hour_at: Date.now(), hour_n: 0, day_at: Date.now(), day_n: n }]]));
  };
  // An IPv4 address two short of its day: one email sign-up and one OAuth create, then neither.
  const v4 = '198.51.100.77';
  await seed(v4, 0, NEW_ACCOUNTS.v4.day - 2);
  assert.equal((await emailSignUp(env, outbox, 'uno@example.org', 'PorCorreo', v4)).status, 200);
  const a = await oauth(env, 'discord', discord('d-presupuesto-a'), { ip: v4 });
  assert.equal((await create(env, a.pend, 'PorDiscord', v4)).status, 200, 'the 200th of the network');
  const late = await emailSignUp(env, outbox, 'dos@example.org', 'TardeCorreo', v4);
  assert.deepEqual([late.status, late.json.error], [429, 'rate_limited'], 'the OAuth create took the email sign-up\'s last slot');
  assert.ok(late.json.retryAfterMs > 23 * 60 * 60_000);
  const b = await oauth(env, 'discord', discord('d-presupuesto-b'), { ip: v4 });
  assert.equal((await create(env, b.pend, 'TardeDiscord', v4)).status, 429);
  // A refusal counts nothing, and another network is untouched.
  assert.equal((await create(env, b.pend, 'TardeDiscord', '198.51.100.78')).status, 200);
  // An IPv6 /48 one short of its day: an email sign-up from one /64 takes it, a create from another /64 is refused.
  await seed('2001:db8:9:1::5', 1, NEW_ACCOUNTS_SITE.day - 1);
  assert.equal((await emailSignUp(env, outbox, 'seis@example.org', 'SeisCorreo', '2001:db8:9:1::5')).status, 200);
  const c = await oauth(env, 'discord', discord('d-presupuesto-c'), { ip: '2001:db8:9:2::1' });
  assert.equal((await create(env, c.pend, 'SeisDiscord', '2001:db8:9:2::1')).status, 429);
});
