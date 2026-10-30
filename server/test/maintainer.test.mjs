// Sign-in PR 10 (the design's §8 "the maintainer account", §3.12): the project's accounts
// (NODE_TRUSTED_OPERATORS) keep their password and at least two ways in through every unlink, are
// never deleted, and their sign-ins and level-2 re-authentications post an ALERT line to the staff
// channel (NODE_ALERT_WEBHOOK) with the method and the country, never an IP or an email; /api/me
// carries PERFIL's checklist for them only; the maintainer routes keep PR 4's gate (level 2 from a
// password within MAINTAINER_FRESH_S, never a TV). Through the real Worker (index.ts) in front of a
// real AccountsDO on node:sqlite, as accounts-email.test.mjs runs them. The webhook, the providers,
// the mail binding and Turnstile are fakes: nothing leaves this machine.
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
const HOOK = 'https://staff-alerts.invalid/maintainer-test';
const posts = [];
const identity = { google: { sub: 'g-default', given_name: 'Ana' }, discord: { id: 'd-default', username: 'ana' } };
globalThis.fetch = async (url, init) => {
  const u = String(url instanceof Request ? url.url : url);
  const ok = (b) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });
  if (u === HOOK) {
    posts.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(null, { status: 204 });
  }
  if (u === 'https://oauth2.googleapis.com/token' || u === 'https://discord.com/api/v10/oauth2/token') return ok({ access_token: 'fake-access' });
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
const ACC = await import('../../src/net/account.ts');
const worker = (await import('../src/index.ts')).default;

const SECRET = 'maintainer-test-secret';
const ORIGIN = 'https://turbo-gol.com';
const TOK = { turnstileToken: 'good-token' };
const PW = 'la clave larga del proyecto';
const KEY = await ACC.passwordKey(PW);

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
    ...liveMail(outbox),
    ...extra,
  };
  const ctx = { storage: { sql: sqlOn(db), transactionSync: txOn(db), getAlarm: async () => 1, setAlarm: async () => {} }, blockConcurrencyWhile: (fn) => fn() };
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
async function req(env, method, path, { ip = '198.18.0.1', origin = ORIGIN, bearer, cookie, body, cf = { country: 'AR', city: 'Córdoba' } } = {}) {
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
const signin = (env, email, ip, password = KEY) => post(env, '/api/auth/signin', { ip, body: { email, password, ...TOK } });

async function oauth(env, provider, who, { query = '', cookie, ip = '198.18.201.1' } = {}) {
  identity[provider] = provider === 'google' ? { sub: who, given_name: 'Ana' } : { id: who, username: who };
  const start = await req(env, 'GET', `/api/auth/oauth/${provider}/start${query}`, { ip, cookie, origin: null });
  if (start.status !== 302 || !start.location.startsWith('https://')) return { start, done: null };
  const state = cookieOf(start.raw, '__Host-tg_oa');
  const nonce = new URL(start.location).searchParams.get('state');
  const done = await req(env, 'GET', `/api/auth/oauth/${provider}/callback?code=x&state=${nonce}`, { ip, cookie: '__Host-tg_oa=' + state, origin: null });
  return { start, done, rt: done.rt };
}

async function refresh(env, rt, ip) {
  return post(env, '/api/auth/refresh', { ip, cookie: '__Host-tg_rt=' + rt });
}

const row = (obj, id) => obj.store.sql.exec('SELECT * FROM users WHERE id = ?', id).toArray()[0];

/**
 * An account made straight in the store: a current password (KEY) unless `pw: null`, a verified
 * address when `email` is given, Google and Discord identities when named.
 */
async function account(obj, name, { email, google, discord, pw = true } = {}) {
  const rec = await A.newPasswordRecord(KEY, 2);
  const id = obj.store.register(name, rec, [], 'f'.repeat(63) + String(name.length % 10), Date.now()).userId;
  if (!pw) obj.store.sql.exec('UPDATE users SET pw_hash = NULL, pw_salt = NULL, pw_iter = NULL, pw_v = 0 WHERE id = ?', id);
  if (google) obj.store.sql.exec('UPDATE users SET google_sub = ?, google_linked_at = ? WHERE id = ?', google, Date.now(), id);
  if (discord) obj.store.sql.exec('UPDATE users SET discord_id = ?, discord_linked_at = ? WHERE id = ?', discord, Date.now(), id);
  if (email) assert.equal(obj.store.claimEmail(id, email, 'mail', Date.now()), 'ok');
  return id;
}

// ---- unlink keeps the password and one more way in (§2.8, §3.12) ---------------------------------

test('maintainer: an unlink never leaves the project account without its password and one more way in (409 maintainer_two_ways); "unlinking" the password is no route; any other account still unlinks down to one', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const project = await account(obj, 'Proyecto', { email: 'proyecto@example.com', google: 'g-proyecto', discord: 'd-proyecto' });
  const ana = await account(obj, 'Ana', { email: 'ana@example.com', discord: 'd-ana' });
  env.NODE_TRUSTED_OPERATORS = project;
  // A password sign-in: level 2 now, so no refusal below is a level's.
  const s = await signin(env, 'proyecto@example.com', ip(0));
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const unlink = (session, provider) => post(env, '/api/auth/unlink', { ip: ip(0), bearer: session, body: { provider } });
  // Google goes: its password and Discord stay (two ways in).
  assert.equal((await unlink(s.json.session, 'google')).status, 200);
  assert.equal(row(obj, project).google_sub, null);
  // Discord would leave only the password: refused, whatever the level.
  const r = await unlink(s.json.session, 'discord');
  assert.deepEqual([r.status, r.json.error, r.json.message], [409, 'maintainer_two_ways', 'La cuenta del proyecto necesita su contraseña y al menos otra forma de entrar.']);
  assert.equal(row(obj, project).discord_id, 'd-proyecto', 'Discord kept');
  // There is no way to take the password off: the route takes a provider only.
  const pwOff = await unlink(s.json.session, 'password');
  assert.deepEqual([pwOff.status, pwOff.json.error], [400, 'bad_request']);
  assert.notEqual(row(obj, project).pw_hash, null, 'the password kept');
  // Anyone else unlinks down to one way in (level 2: a password sign-in just now).
  const a = await signin(env, 'ana@example.com', ip(1));
  assert.equal((await post(env, '/api/auth/unlink', { ip: ip(1), bearer: a.json.session, body: { provider: 'discord' } })).status, 200);
  assert.equal(row(obj, ana).discord_id, null);
});

test('maintainer: the refusal comes before any "confirm it is you" (a level-1 session is not sent to type its password for nothing); without a password the project account unlinks nothing', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  // A password of before without an email (it signs in by its username until the cutoff) and Discord.
  const project = await account(obj, 'Proyecto', { discord: 'd-proyecto' });
  env.NODE_TRUSTED_OPERATORS = project;
  // Discord's press: level 1, fresh enough for an unlink, not for one that leaves a single way in.
  const o = await oauth(env, 'discord', 'd-proyecto', { ip: ip(0) });
  assert.equal(o.done.location, '/#auth=ok');
  const s = await refresh(env, o.rt, ip(0));
  assert.equal(s.status, 200);
  const r = await post(env, '/api/auth/unlink', { ip: ip(0), bearer: s.json.session, body: { provider: 'discord' } });
  assert.deepEqual([r.status, r.json.error], [409, 'maintainer_two_ways'], 'not 403 reauth_required { level: 2 }');
  // Off the list, the same unlink asks for level 2 first (PR 4's rule for any account).
  env.NODE_TRUSTED_OPERATORS = '';
  const other = await post(env, '/api/auth/unlink', { ip: ip(0), bearer: s.json.session, body: { provider: 'discord' } });
  assert.deepEqual([other.status, other.json.error, other.json.level], [403, 'reauth_required', 2]);
  assert.equal(row(obj, project).discord_id, 'd-proyecto');
  // No password, Google and Discord: two ways in, but neither unlinks (the password is what it must keep).
  const bare = await account(obj, 'Proyecto2', { pw: false, google: 'g-proyecto2', discord: 'd-proyecto2' });
  env.NODE_TRUSTED_OPERATORS = `${project},${bare}`;
  const b = await refresh(env, (await oauth(env, 'discord', 'd-proyecto2', { ip: ip(1) })).rt, ip(1));
  for (const provider of ['google', 'discord']) {
    const u = await post(env, '/api/auth/unlink', { ip: ip(1), bearer: b.json.session, body: { provider } });
    assert.deepEqual([u.status, u.json.error], [409, 'maintainer_two_ways'], provider);
  }
  assert.deepEqual([row(obj, bare).google_sub, row(obj, bare).discord_id], ['g-proyecto2', 'd-proyecto2']);
  // Off the list it unlinks Google at level 1 (its ceiling: no password, no email).
  env.NODE_TRUSTED_OPERATORS = project;
  assert.equal((await post(env, '/api/auth/unlink', { ip: ip(1), bearer: b.json.session, body: { provider: 'google' } })).status, 200);
});

// ---- deletion is refused (§2.10, §3.12; the route comes with sign-in PR 12) ------------------------

test('maintainer: the store refuses to delete a NODE_TRUSTED_OPERATORS account (maintainer_account), the list as the AccountsDO hears it', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const project = await account(obj, 'Proyecto', { email: 'proyecto@example.com', discord: 'd-proyecto' });
  const ana = await account(obj, 'Ana', { email: 'ana@example.com' });
  env.NODE_TRUSTED_OPERATORS = `${project},not-an-id`;
  // Any request hands the AccountsDO's store the list as this deploy has it.
  assert.equal((await signin(env, 'ana@example.com', ip(0))).status, 200);
  assert.equal(obj.store.isMaintainer(project), true);
  assert.equal(obj.store.deletionRefusal(project), 'maintainer_account');
  assert.equal(obj.store.deletionRefusal(ana), null, 'any other account may ask');
  assert.equal(obj.store.deletionRefusal('0123456789abcdef'), 'no_user');
  // The list changes with the secret (a deploy): the next request sees it.
  env.NODE_TRUSTED_OPERATORS = ana;
  assert.equal((await signin(env, 'ana@example.com', ip(1))).status, 200);
  assert.equal(obj.store.deletionRefusal(project), null);
  assert.equal(obj.store.deletionRefusal(ana), 'maintainer_account');
});

// ---- the ALERT on every sign-in and level-2 re-authentication (§3.12) ------------------------------

const AUTH = await import('../src/auth.ts');
const nowS = () => Math.floor(Date.now() / 1000);
/** The ALERT posts since `from` (their text). */
const alertsSince = (from) => posts.slice(from).map((p) => p.content);
/** A mail's link token of `kind` (its text part). */
const linkIn = (m, kind) => new RegExp(`/account#${kind}=([A-Za-z0-9_-]+)`).exec(m.text)?.[1] ?? null;

test('maintainer: one ALERT per sign-in of a project account (email, username, recovery code, reset link, Discord, Google), with the method and the country and never the IP, the address or the city; nothing for anyone else, a refused password or a refresh', async () => {
  const { env, obj, outbox } = makeEnv();
  const ip = ips();
  const project = await account(obj, 'Proyecto', { email: 'proyecto@example.com', google: 'g-proyecto', discord: 'd-proyecto' });
  // A second project account, of before: a username and a recovery code, no address.
  const code = A.newRecoveryCode();
  const old = obj.store.register('Viejo', await A.newPasswordRecord(KEY, 2), [await A.recoveryCodeHash(code)], 'e'.repeat(64), Date.now()).userId;
  await account(obj, 'Ana', { email: 'ana@example.com', discord: 'd-ana' });
  env.NODE_TRUSTED_OPERATORS = `${project},${old}`;
  const one = async (what, run, method) => {
    const from = posts.length;
    const r = await run();
    const got = alertsSince(from);
    assert.equal(got.length, 1, `${what}: one ALERT, got ${JSON.stringify(got)}`);
    assert.match(got[0], /^\*\*ALERT\*\* `maintainer (Proyecto|Viejo) \([0-9a-f]{16}\) signed in with /, what);
    assert.ok(got[0].includes(method), `${what}: ${got[0]}`);
    assert.ok(got[0].endsWith('from AR`'), `${what}: the country`);
    for (const secret of ['198.18.', 'proyecto@example.com', '@', 'Córdoba']) assert.ok(!got[0].includes(secret), `${what}: no ${secret} in ${got[0]}`);
    assert.deepEqual(posts.at(-1).allowed_mentions, { parse: [] }, 'no mention');
    return r;
  };
  const none = async (what, run) => {
    const from = posts.length;
    const r = await run();
    assert.deepEqual(alertsSince(from), [], what);
    return r;
  };
  const s = await one('email', () => signin(env, 'proyecto@example.com', ip(0)), 'with its email and password');
  assert.equal(s.status, 200);
  await one('username', () => post(env, '/api/auth/login', { ip: ip(1), body: { username: 'Viejo', passwordV2: KEY, ...TOK } }), 'with its username and password');
  const rec = await one('recovery code', () => post(env, '/api/auth/recover', { ip: ip(2), body: { username: 'Viejo', code, passwordV2: KEY, ...TOK } }), 'with a recovery code');
  assert.equal(rec.status, 200, JSON.stringify(rec.json));
  assert.equal((await post(env, '/api/auth/forgot', { ip: ip(3), body: { email: 'proyecto@example.com', lang: 'en', ...TOK } })).status, 200);
  const token = linkIn(outbox.at(-1), 'reset');
  assert.ok(token, 'M3 carries a reset link');
  const reset = await one('reset link', () => post(env, '/api/auth/reset', { ip: ip(3), body: { token, password: KEY } }), 'with a password reset link');
  assert.equal(reset.status, 200, JSON.stringify(reset.json));
  const d = await one('Discord', () => oauth(env, 'discord', 'd-proyecto', { ip: ip(4) }), 'with Discord');
  assert.equal(d.done.location, '/#auth=ok');
  const g = await one('Google', () => oauth(env, 'google', 'g-proyecto', { ip: ip(5) }), 'with Google');
  assert.equal(g.done.location, '/#auth=ok');
  // Nothing for another account, a wrong password, or a refresh (no credential proved).
  await none('another account', () => signin(env, 'ana@example.com', ip(6)));
  const bad = await none('a wrong password', () => signin(env, 'proyecto@example.com', ip(7), 'e'.repeat(64)));
  assert.equal(bad.status, 401);
  assert.equal((await none('a refresh', () => refresh(env, d.rt, ip(4)))).status, 200);
  // Without the webhook: the sign-in stands, the line stays in the Worker's log only, without an address either.
  const lines = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    await none('no webhook', () => signin({ ...env, NODE_ALERT_WEBHOOK: undefined }, 'proyecto@example.com', ip(8)));
  } finally {
    console.log = log;
  }
  const ours = lines.filter((l) => l.includes('ALERT maintainer'));
  assert.equal(ours.length, 1, JSON.stringify(lines));
  assert.match(ours[0], /^\[accounts\] ALERT maintainer Proyecto \([0-9a-f]{16}\) signed in with its email and password, from AR$/);
  // An unknown country is said so, not guessed.
  const from = posts.length;
  await req(env, 'POST', '/api/auth/signin', { ip: ip(9), body: { email: 'proyecto@example.com', password: KEY, ...TOK }, cf: null });
  assert.deepEqual(alertsSince(from).map((c) => c.endsWith('from an unknown country`')), [true]);
});

test('maintainer: a level-2 re-authentication posts its ALERT (the password, "confirm it is you"); a provider\'s level-1 re-authentication and a TV signed in with the phone do not', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const project = await account(obj, 'Proyecto', { email: 'proyecto@example.com', discord: 'd-proyecto' });
  env.NODE_TRUSTED_OPERATORS = project;
  const o = await oauth(env, 'discord', 'd-proyecto', { ip: ip(0) });
  const s = await refresh(env, o.rt, ip(0));
  // Discord's "confirm it's you": level 1, no ALERT (it reaches no maintainer route).
  let from = posts.length;
  const re1 = await oauth(env, 'discord', 'd-proyecto', { ip: ip(0), query: '?reauth=1', cookie: '__Host-tg_rt=' + s.rt });
  assert.equal(re1.done.location, '/#auth=reauth');
  assert.deepEqual(alertsSince(from), []);
  const s1 = await refresh(env, re1.rt, ip(0));
  // The password: level 2, one ALERT.
  from = posts.length;
  const re2 = await post(env, '/api/auth/reauth', { ip: ip(0), bearer: s1.json.session, cookie: '__Host-tg_rt=' + s1.rt, body: { password: KEY } });
  assert.equal(re2.status, 200, JSON.stringify(re2.json));
  const got = alertsSince(from);
  assert.equal(got.length, 1);
  assert.match(got[0], /^\*\*ALERT\*\* `maintainer Proyecto \([0-9a-f]{16}\) confirmed it is them with its password \(level 2\), from AR`$/);
  // A refused password re-authentication: nothing.
  from = posts.length;
  assert.equal((await post(env, '/api/auth/reauth', { ip: ip(0), bearer: s1.json.session, cookie: '__Host-tg_rt=' + s1.rt, body: { password: 'e'.repeat(64) } })).status, 401);
  assert.deepEqual(alertsSince(from), []);
  // A TV the phone signs in: not a primary sign-in (its scope never reaches a maintainer route).
  from = posts.length;
  const st = await post(env, '/api/auth/tv/start', { ip: ip(1) });
  assert.equal(st.status, 200, JSON.stringify(st.json));
  assert.equal((await post(env, '/api/auth/tv/confirm', { ip: ip(0), bearer: re2.json.session, body: { code: st.json.code } })).status, 200);
  const tv = await post(env, '/api/auth/tv/poll', { ip: ip(1), body: { code: st.json.code, secret: st.json.secret } });
  assert.equal(tv.json.state, 'approved');
  assert.deepEqual(alertsSince(from), []);
});

// ---- the maintainer routes' gate (PR 4's, kept: §3.12 "what the code enforces") --------------------

test('maintainer: /nodes/tokens and /nodes/admin/* refuse a level-1 or stale session (403 reauth_required { level: 2 }) and a TV (403 tv_session), and take level 2 from a password', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  env.NODES = { idFromName: (n) => ({ n }), get: () => ({ fetch: async () => new Response('{"ok":true,"operators":[]}', { headers: { 'content-type': 'application/json' } }) }) };
  Object.assign(env, { NODE_REPLAYS: {}, NODE_RELEASES: {}, NODE_CONTROL_PRIVATE_KEY: 'k', NODE_CONTROL_PUBLIC_KEY: 'k', NODES_PUBLIC_BASE: ORIGIN });
  const project = await account(obj, 'Proyecto', { email: 'proyecto@example.com', discord: 'd-proyecto' });
  env.NODE_TRUSTED_OPERATORS = project;
  const routes = [['GET', '/nodes/admin/nodes'], ['GET', '/nodes/admin/account-stats'], ['POST', '/nodes/tokens']];
  const ask = (session) => Promise.all(routes.map(([m, p]) => req(env, m, p, { ip: ip(0), bearer: session, body: m === 'POST' ? { region: 'SA' } : undefined })));
  const session = (extra) => AUTH.signJwt(SECRET, { typ: 's', sub: project, name: 'Proyecto', iat: nowS(), exp: nowS() + 600, acct: 1, ...extra });
  // Discord's press: level 1.
  const viaDiscord = await refresh(env, (await oauth(env, 'discord', 'd-proyecto', { ip: ip(0) })).rt, ip(0));
  for (const r of await ask(viaDiscord.json.session)) assert.deepEqual([r.status, r.json.error, r.json.level], [403, 'reauth_required', 2]);
  // A password 16 minutes ago: stale (MAINTAINER_FRESH_S is 15 minutes).
  for (const r of await ask(await session({ aat: nowS() - 16 * 60, aal: 2 }))) assert.deepEqual([r.status, r.json.error, r.json.level], [403, 'reauth_required', 2]);
  // A TV's session, whatever its level.
  for (const r of await ask(await session({ aat: nowS(), aal: 2, tv: 1 }))) assert.deepEqual([r.status, r.json.error], [403, 'tv_session']);
  // A password sign-in: level 2, now.
  const s = await signin(env, 'proyecto@example.com', ip(1));
  for (const r of await ask(s.json.session)) assert.equal(r.status, 200, JSON.stringify(r.json));
});
