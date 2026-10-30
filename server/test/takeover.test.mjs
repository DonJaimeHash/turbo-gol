// Security 3: the account-takeover paths, through the real Worker (index.ts) in front of a real
// AccountsDO on node:sqlite, as tv-signin.test.mjs runs them. OAuth runs against a fake provider:
// globalThis.fetch answers only the fake Google and Discord token / user URLs below and throws on
// anything else, so nothing leaves this machine. Run from server/: npm test
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

// ---- the fake providers: the identity the next callback reads, per provider ------------------
const identity = { google: { sub: 'g-default', given_name: 'Ana' }, discord: { id: 'd-default', username: 'ana' } };
const realFetch = globalThis.fetch;
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
void realFetch;

const { AccountsDO } = await import('../src/AccountsDO.ts');
const A = await import('../src/accountRoutes.ts');
const AUTH = await import('../src/auth.ts');
const worker = (await import('../src/index.ts')).default;

const SECRET = 'takeover-test-secret';
const ORIGIN = 'https://turbo-gol.com';
const KEY = 'c'.repeat(64);
const KEY2 = 'd'.repeat(64);

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

function makeEnv(extra = {}) {
  const db = new DatabaseSync(':memory:');
  let alarm = null;
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
  const ctx = {
    storage: { sql: sqlOn(db), transactionSync: txOn(db), getAlarm: async () => alarm, setAlarm: async (t) => void (alarm = t) },
    blockConcurrencyWhile: (fn) => fn(),
  };
  const obj = new AccountsDO(ctx, env);
  env.ACCOUNTS = { idFromName: (n) => ({ n }), get: () => ({ fetch: (url, init) => obj.fetch(new Request(url, init)) }) };
  return { env, obj, db };
}

// The Worker's rate limiter is per isolate (index.ts): every test takes addresses of its own.
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

/** One request to the Worker: JSON by default, from this origin. `origin: null` sends none. */
async function req(env, method, path, { ip = '198.18.0.1', origin = ORIGIN, bearer, cookie, body, contentType = 'application/json', cf } = {}) {
  const headers = { 'CF-Connecting-IP': ip };
  if (origin !== null) headers.Origin = origin;
  if (bearer) headers.authorization = 'Bearer ' + bearer;
  if (cookie) headers.cookie = cookie;
  if (body !== undefined && contentType !== null) headers['content-type'] = contentType;
  const r = new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  if (cf) Object.defineProperty(r, 'cf', { value: cf });
  const res = await worker.fetch(r, env);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, headers: res.headers, json, location: res.headers.get('location') };
}
const post = (env, path, o = {}) => req(env, 'POST', path, { body: {}, ...o });

/** A password account signed in through the real login route: its Bearer and refresh cookie. `extra`: more of the body (a Turnstile token where the check is on). */
async function passwordAccount(env, obj, name, ip = '198.18.200.1', extra = {}) {
  const id = obj.store.register(name, await A.newPasswordRecord(KEY), [], 'f'.repeat(63) + String(name.length % 10), Date.now()).userId;
  const r = await post(env, '/api/auth/login', { ip, body: { username: name, password: KEY, ...extra } });
  assert.equal(r.status, 200, 'login ' + JSON.stringify(r.json));
  return { id, bearer: r.json.session, rt: cookieOf(r, '__Host-tg_rt'), session: r.json };
}

/** A full OAuth round trip through the Worker with the fake provider answering `who`. */
async function oauth(env, provider, who, { query = '', cookie, ip = '198.18.201.1' } = {}) {
  identity[provider] = provider === 'google' ? { sub: who, given_name: 'Ana' } : { id: who, username: who };
  const start = await req(env, 'GET', `/api/auth/oauth/${provider}/start${query}`, { ip, cookie, origin: null });
  if (start.status !== 302 || !start.location.startsWith('https://')) return { start, done: null };
  const state = cookieOf(start, '__Host-tg_oa');
  const nonce = new URL(start.location).searchParams.get('state');
  // The provider's redirect back is a cross-site navigation: the SameSite=Strict refresh cookie is not sent.
  const done = await req(env, 'GET', `/api/auth/oauth/${provider}/callback?code=x&state=${nonce}`, { ip, cookie: '__Host-tg_oa=' + state, origin: null });
  return { start, done, rt: cookieOf(done, '__Host-tg_rt') };
}

/** Refresh with a cookie: the session and the next cookie. */
async function refresh(env, rt, ip = '198.18.202.1') {
  const r = await post(env, '/api/auth/refresh', { ip, cookie: '__Host-tg_rt=' + rt });
  return { ...r, rt: cookieOf(r, '__Host-tg_rt') };
}

const claims = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());

// ---- auth-9 -------------------------------------------------------------------------------------

test('auth-9: a 90 s ticket is no Bearer session at the Worker (401: no session at all); a guest session still is one (403: a guest)', async () => {
  const { env } = makeEnv();
  const ip = ips();
  const ticket = await AUTH.createTicket(SECRET, { sub: 'ab'.repeat(8), mid: 'f'.repeat(64), team: 0, slot: 0, name: 'Ana', role: 'peer' });
  const t = await req(env, 'GET', '/api/me', { ip: ip(0), bearer: ticket });
  assert.deepEqual([t.status, t.json.error], [401, 'unauthorized']);
  const s = await AUTH.createSession(SECRET, 'ab'.repeat(8), 'Ana');
  const g = await req(env, 'GET', '/api/me', { ip: ip(0), bearer: s.token });
  assert.deepEqual([g.status, g.json.error], [403, 'account_required'], 'the session is read (a guest)');
});

test('auth-9: an OAuth state cookie says typ oa and a callback refuses a state without it', async () => {
  const { env } = makeEnv();
  const start = await req(env, 'GET', '/api/auth/oauth/google/start', { origin: null });
  assert.equal(claims(cookieOf(start, '__Host-tg_oa')).typ, 'oa');
  // The same state signed without its typ (any other JWT of this key with the right fields).
  const st = claims(cookieOf(start, '__Host-tg_oa'));
  delete st.typ;
  const forged = await AUTH.signJwt(SECRET, st);
  const nonce = new URL(start.location).searchParams.get('state');
  const cb = await req(env, 'GET', `/api/auth/oauth/google/callback?code=x&state=${nonce}`, { cookie: '__Host-tg_oa=' + forged, origin: null });
  assert.equal(cb.location, '/#auth=error:bad_state');
});


// ---- auth-4: refresh token families, reuse detection, the device list, sign out everywhere -----

test('auth-4: a copied refresh token used after its rotation revokes the whole family (the thief\'s chain too)', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const ana = await passwordAccount(env, obj, 'Ana', ip(0));
  assert.match(ana.rt, /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/, 'a family part and a secret');
  const stolen = ana.rt; // a copy (malware, a shared computer) before the owner's next refresh
  // The thief refreshes first and keeps rotating: its own chain.
  const t1 = await refresh(env, stolen, ip(1));
  assert.equal(t1.status, 200);
  const t2 = await refresh(env, t1.rt, ip(1));
  assert.equal(t2.status, 200);
  assert.equal(t2.rt.split('.')[0], stolen.split('.')[0], 'every rotation keeps the family part');
  // A minute later the owner's browser presents its (now rotated) token: a reuse.
  const t0 = Date.now();
  obj.now = () => t0 + 60_000;
  const owner = await refresh(env, stolen, ip(0));
  assert.equal(owner.status, 401);
  assert.equal(owner.json.error, 'refresh_reused');
  // The family is gone: the thief's latest token no longer refreshes.
  const thief = await refresh(env, t2.rt, ip(1));
  assert.equal(thief.status, 401, "the thief's chain is revoked with it");
});

test('auth-4: two tabs racing on one token: the loser hears 409 refresh_race, its cookie kept, nothing revoked', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const ana = await passwordAccount(env, obj, 'Ana', ip(0));
  const a = await refresh(env, ana.rt, ip(0));
  assert.equal(a.status, 200);
  const b = await refresh(env, ana.rt, ip(0));
  assert.equal(b.status, 409);
  assert.equal(b.json.error, 'refresh_race');
  assert.equal(b.rt, null, 'no Set-Cookie: the browser keeps the one tab A got');
  assert.equal((await refresh(env, a.rt, ip(0))).status, 200, 'tab A\'s token still works');
});

test('auth-4: a token from before families still refreshes (no sign-out at the deploy) and joins a family', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const id = obj.store.register('Old', await A.newPasswordRecord(KEY), [], 'e'.repeat(64), Date.now()).userId;
  const legacy = Buffer.from(new Uint8Array(32).fill(7)).toString('base64url'); // 43 chars, no family part
  obj.store.addRefresh(id, await A.sha256Hex(legacy), Date.now());
  const r = await refresh(env, legacy, ip(0));
  assert.equal(r.status, 200);
  assert.equal(r.json.playerId, id);
  assert.match(r.rt, /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
  assert.equal((await refresh(env, r.rt, ip(0))).status, 200);
});

test('auth-4: PERFIL\'s devices: each signed-in browser with where it signed in, this one marked; sign one out; sign out everywhere (an OAuth-only account too)', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  // Two browsers of a Discord-only account.
  const a = await oauth(env, 'discord', 'd-ana', { ip: ip(0) });
  assert.equal(a.done.location, '/#auth=new');
  const sa = await refresh(env, a.rt, ip(0));
  const b = await oauth(env, 'discord', 'd-ana', { ip: ip(1) });
  const sb = await refresh(env, b.rt, ip(1));
  assert.equal(sa.json.playerId, sb.json.playerId);
  // A third one, from Córdoba.
  const c = await req(env, 'POST', '/api/auth/refresh', { ip: ip(2), body: {}, cookie: '__Host-tg_rt=' + sb.rt });
  const brt = cookieOf(c, '__Host-tg_rt');
  const list = await req(env, 'GET', '/api/auth/sessions', { ip: ip(0), bearer: sa.json.session, cookie: '__Host-tg_rt=' + sa.rt });
  assert.equal(list.status, 200);
  assert.equal(list.json.sessions.length, 2, 'one row per device, not per token');
  assert.deepEqual(list.json.sessions.map((d) => d.current).sort(), [false, true]);
  for (const d of list.json.sessions) {
    assert.match(d.id, /^[0-9a-f]{32}$/);
    assert.equal(d.kind, 'web');
    assert.ok(d.signedInAt > 0 && d.lastUsedAt >= d.signedInAt);
  }
  assert.equal(JSON.stringify(list.json).includes(sa.rt), false, 'no token in the list');
  // Sign the other browser out.
  const other = list.json.sessions.find((d) => !d.current);
  const rv = await post(env, '/api/auth/sessions/revoke', { ip: ip(0), bearer: sa.json.session, body: { id: other.id } });
  assert.equal(rv.status, 200);
  assert.equal(rv.json.revoked, 1);
  assert.equal((await refresh(env, brt, ip(1))).status, 401, 'that browser is signed out');
  // Another account cannot sign this one's devices out.
  const beto = await passwordAccount(env, obj, 'Beto', ip(3));
  const mine = list.json.sessions.find((d) => d.current);
  assert.equal((await post(env, '/api/auth/sessions/revoke', { ip: ip(3), bearer: beto.bearer, body: { id: mine.id } })).json.revoked, 0);
  // Sign out everywhere, this device too.
  const all = await post(env, '/api/auth/sessions/revoke-all', { ip: ip(0), bearer: sa.json.session, cookie: '__Host-tg_rt=' + sa.rt });
  assert.equal(all.status, 200);
  assert.ok(all.json.revoked >= 1);
  assert.match(all.headers.get('set-cookie') ?? '', /__Host-tg_rt=;.*Max-Age=0/);
  assert.equal((await refresh(env, sa.rt, ip(0))).status, 401);
  // A guest has no devices.
  const g = await AUTH.createSession(SECRET, '0123456789abcdef', 'Invitado');
  assert.equal((await req(env, 'GET', '/api/auth/sessions', { ip: ip(4), bearer: g.token })).status, 403);
});

test('auth-4: the device list keeps where a device signed in (request.cf country and city), coarse', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  obj.store.register('Geo', await A.newPasswordRecord(KEY), [], 'e'.repeat(64), Date.now());
  const r = await req(env, 'POST', '/api/auth/login', { ip: ip(0), body: { username: 'Geo', password: KEY }, cf: { country: 'AR', city: 'Córdoba', asn: 7303 } });
  const list = await req(env, 'GET', '/api/auth/sessions', { ip: ip(0), bearer: r.json.session });
  assert.deepEqual([list.json.sessions[0].country, list.json.sessions[0].city], ['AR', 'Córdoba']);
  assert.equal(JSON.stringify(list.json).includes('7303'), false, 'no network number kept');
});

// ---- auth-1 / tv-1 / client-1 (server side): a TV's session has a limited scope -----------------

/** The community-node settings with a NodeRegistryDO stub that records what reaches it (nodeRoutes.ts). */
function withNodes(env, trusted) {
  const seen = [];
  env.NODES = { idFromName: (n) => ({ n }), get: () => ({ fetch: async (r) => (seen.push(new URL(r.url).pathname), new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })) }) };
  Object.assign(env, { NODE_REPLAYS: {}, NODE_RELEASES: {}, NODE_CONTROL_PRIVATE_KEY: 'k', NODE_CONTROL_PUBLIC_KEY: 'k', NODES_PUBLIC_BASE: ORIGIN, NODE_TRUSTED_OPERATORS: trusted });
  return seen;
}

/** A TV signed in with the phone through the real routes: the TV's session and refresh cookie. */
async function tvSignIn(env, phoneBearer, ip) {
  const st = await post(env, '/api/auth/tv/start', { ip: ip(10) });
  assert.equal(st.status, 200, 'tv/start ' + JSON.stringify(st.json));
  const cf = await post(env, '/api/auth/tv/confirm', { ip: ip(11), bearer: phoneBearer, body: { code: st.json.code } });
  assert.equal(cf.status, 200, 'tv/confirm ' + JSON.stringify(cf.json));
  const pl = await post(env, '/api/auth/tv/poll', { ip: ip(10), body: { code: st.json.code, secret: st.json.secret } });
  assert.equal(pl.json.state, 'approved');
  return { session: pl.json, bearer: pl.json.session, rt: cookieOf(pl, '__Host-tg_rt') };
}

test('auth-1: a TV signed in with the phone gets a limited scope: the tv claim, kept through every refresh', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const ana = await passwordAccount(env, obj, 'Ana', ip(0));
  const tv = await tvSignIn(env, ana.bearer, ip);
  assert.equal(tv.session.tv, true);
  assert.equal(claims(tv.bearer).tv, 1);
  assert.equal(claims(tv.bearer).aat, undefined, 'a TV never proved a credential');
  const r1 = await refresh(env, tv.rt, ip(10));
  assert.equal(claims(r1.json.session).tv, 1, 'refreshed: still a TV');
  // Its car pick re-signs the session: the scope stays.
  obj.store.grant(ana.id, 'pampero', Date.now());
  const car = await post(env, '/api/me/car', { ip: ip(10), bearer: r1.json.session, body: { car: 'pampero' } });
  assert.equal(car.status, 200);
  assert.equal(claims(car.json.session).tv, 1, 'no laundering the scope through /api/me/car');
  // It plays as the account: its profile answers.
  assert.equal((await req(env, 'GET', '/api/me', { ip: ip(10), bearer: r1.json.session })).status, 200);
});

test('auth-1 / auth-11: every credential, linking, redeem, TV-approval, device and maintainer route refuses a TV session (403 tv_session)', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const seen = withNodes(env, null);
  const ana = await passwordAccount(env, obj, 'Ana', ip(0));
  env.NODE_TRUSTED_OPERATORS = ana.id; // the owner's own account is a maintainer
  const tv = await tvSignIn(env, ana.bearer, ip);
  const other = await post(env, '/api/auth/tv/start', { ip: ip(20) });
  const calls = [
    ['POST', '/api/auth/password', { password: KEY2, oldPassword: KEY }],
    ['POST', '/api/auth/recovery-codes', { password: KEY }],
    ['POST', '/api/me/username', { username: 'Robado', password: KEY, newPassword: KEY2 }],
    ['POST', '/api/me/shop/claim', { item: 'pampero' }],
    ['POST', '/nodes/shop/claim', { item: 'pampero' }],
    ['POST', '/api/auth/tv/confirm', { code: other.json.code }],
    ['GET', '/api/auth/sessions', undefined],
    ['POST', '/api/auth/sessions/revoke', { id: 'a'.repeat(32) }],
    ['POST', '/api/auth/sessions/revoke-all', {}],
    ['POST', '/nodes/tokens', { region: 'SA' }],
    ['GET', '/nodes/admin/nodes', undefined],
    ['POST', '/nodes/admin/grant', { account: ana.id, item: 'pampero' }],
    ['POST', '/nodes/admin/drain', { nodeId: 'n1', reason: 'x' }],
  ];
  for (const [method, path, body] of calls) {
    const r = await req(env, method, path, { ip: ip(10), bearer: tv.bearer, body });
    assert.equal(r.status, 403, `${method} ${path}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.error, 'tv_session', `${method} ${path}`);
  }
  assert.deepEqual(seen, [], 'nothing reached the NodeRegistryDO');
  assert.equal(obj.store.credentials('Ana').hash !== undefined, true);
  assert.equal(obj.store.me(ana.id, Date.now()).name, 'Ana', 'not renamed');
  // The TV's own refresh cookie cannot start a link either (the start reads it).
  const link = await req(env, 'GET', '/api/auth/oauth/google/start?link=1', { ip: ip(10), cookie: '__Host-tg_rt=' + tv.rt, origin: null });
  assert.equal(link.location, '/#auth=error:tv_session');
});

test('auth-1: a TV\'s sign-in lasts 30 days from its start, refreshed or not; approving TVs never signs a browser out', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const ana = await passwordAccount(env, obj, 'Ana', ip(0));
  const tv = await tvSignIn(env, ana.bearer, ip);
  const t0 = Date.now();
  let rt = tv.rt;
  for (const day of [10, 20, 29]) {
    obj.now = () => t0 + day * 86_400_000;
    const r = await refresh(env, rt, ip(10));
    assert.equal(r.status, 200, `day ${day}`);
    rt = r.rt;
  }
  obj.now = () => t0 + 31 * 86_400_000;
  assert.equal((await refresh(env, rt, ip(10))).status, 401, 'past 30 days from its start: signed out, however often it refreshed');
  // Browsers and TVs are counted apart: ten browsers, then six TVs approved, the browsers stay.
  obj.now = () => Date.now();
  const browsers = [ana.rt];
  for (let i = 1; i < 10; i++) browsers.push((await post(env, '/api/auth/login', { ip: ip(30 + i), body: { username: 'Ana', password: KEY } })).headers.get('set-cookie').split(';')[0].split('=')[1]);
  for (let i = 0; i < 6; i++) await tvSignIn(env, ana.bearer, ips());
  for (const b of browsers) assert.ok(obj.store.refreshOwner(await A.sha256Hex(b), Date.now()), 'every browser is still signed in');
  const kinds = obj.store.devices(ana.id, Date.now(), null).map((d) => d.kind);
  assert.equal(kinds.filter((k) => k === 'tv').length, 5, 'five TVs at most');
  assert.equal(kinds.filter((k) => k === 'web').length, 10);
});

// ---- auth-1 / client-1 / tv-1: where the TV is, Turnstile; auth-7 / cost-7 / client-3: the code table ----

test('auth-1 / auth-7: POST /api/auth/tv/start asks a solved Turnstile check when the gate is on', async () => {
  const { env } = makeEnv({ TURNSTILE_DISABLED: '0', TURNSTILE_SECRET: 'ts-secret', TURNSTILE_SITEKEY: 'ts-site' });
  const ip = ips();
  for (const body of [{}, { turnstileToken: 'bad-token' }]) {
    const r = await post(env, '/api/auth/tv/start', { ip: ip(0), body });
    assert.equal(r.status, 403, JSON.stringify(body));
    assert.equal(r.json.error, 'turnstile_failed');
  }
  const ok = await post(env, '/api/auth/tv/start', { ip: ip(0), body: { turnstileToken: 'good-token' } });
  assert.equal(ok.status, 200);
  assert.match(ok.json.code, /^[A-Z2-9]{6}$/);
});

test('auth-7 / cost-7 / client-3: one IPv6 /48 holds 20 live codes at most (the 21st start from it: 503 busy); the table never fills for other networks', async () => {
  const { env, obj } = makeEnv();
  for (let i = 0; i < 20; i++) assert.equal((await post(env, '/api/auth/tv/start', { ip: `2001:db8:77:${i.toString(16)}::1` })).status, 200, `/64 number ${i}`);
  const busy = await post(env, '/api/auth/tv/start', { ip: '2001:db8:77:ff::1' });
  assert.equal(busy.status, 503);
  assert.equal(busy.json.error, 'busy');
  assert.equal((await post(env, '/api/auth/tv/start', { ip: '2001:db8:78::1' })).status, 200, 'another /48');
  assert.equal((await post(env, '/api/auth/tv/start', { ip: '198.51.100.20' })).status, 200, 'a real TV elsewhere');
  // The audit's run: 400 /64s of one /48, 5 starts each, straight at the object.
  const t = obj.tv;
  for (let i = 0; i < 400; i++) for (let j = 0; j < 5; j++) t.start(`2001:db8:99:${i.toString(16)}::${j + 1}`, 'a'.repeat(64), Date.now());
  assert.ok(t.size < 100, `the /48 holds ${t.size} codes, not 2,000`);
  assert.notEqual(t.start('203.0.113.50', 'a'.repeat(64), Date.now()), 'full');
});

test('auth-7: the table: 20 live codes per IPv4 address (a carrier NAT), 100 per /24, 20,000 in all; an unclaimed code lives 4 minutes, a confirmed one 30 s more for its poll', async () => {
  const TV = await import('../src/tvCodes.ts');
  assert.equal(TV.TV_CODES_PER_IPV4, 20);
  assert.equal(TV.TV_CODES_PER_24, 100);
  assert.equal(TV.TV_CODES_PER_48, 20);
  assert.equal(TV.TV_CODES_MAX, 20_000);
  assert.equal(TV.TV_CODE_TTL_MS, 4 * 60_000);
  assert.equal(TV.wideKey('203.0.113.7'), '203.0.113');
  assert.equal(TV.wideKey('2001:db8:5:6::1'), '2001:db8:5');
  assert.equal(TV.wideKey('local'), null);
  const t = new TV.TvCodes();
  for (let i = 0; i < 100; i++) assert.notEqual(t.start(`203.0.113.${i % 5}`, 'a'.repeat(64), 0), 'busy', `start ${i}`);
  assert.equal(t.start('203.0.113.99', 'a'.repeat(64), 0), 'busy', 'the /24 holds 100');
  assert.notEqual(t.start('203.0.114.1', 'a'.repeat(64), 0), 'busy');
  const { code } = t.start('198.51.100.1', 'b'.repeat(64), 0);
  assert.equal(t.confirm(code, { userId: 'u', username: 'Ana' }, '198.51.100.1', TV.TV_CODE_TTL_MS - 1000), 'ok');
  assert.equal(t.poll(code, 'b'.repeat(64), TV.TV_CODE_TTL_MS + 20_000).userId, 'u', 'confirmed at the last second, polled after: still the TV\'s');
  const late = t.start('198.51.100.2', 'c'.repeat(64), 0).code;
  assert.equal(t.poll(late, 'c'.repeat(64), TV.TV_CODE_TTL_MS), 'expired');
});

test('auth-1 / client-1: the phone sees where the TV is before it confirms (country, city, network at its start), and whether it is on its network or in its country', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const ana = await passwordAccount(env, obj, 'Ana', ip(0));
  const st = await post(env, '/api/auth/tv/start', { ip: ip(1), cf: { country: 'NG', city: 'Lagos', asn: 64500, asOrganization: 'Some Hosting Ltd' } });
  // The phone at home in Argentina: another country, another network.
  const far = await post(env, '/api/auth/tv/info', { ip: ip(2), bearer: ana.bearer, body: { code: st.json.code }, cf: { country: 'AR', city: 'Córdoba' } });
  assert.equal(far.status, 200);
  assert.deepEqual(far.json.where, { country: 'NG', city: 'Lagos', asn: 64500, org: 'Some Hosting Ltd' });
  assert.equal(far.json.sameNetwork, false);
  assert.equal(far.json.sameCountry, false);
  // On the TV's own Wi-Fi.
  const home = await post(env, '/api/auth/tv/info', { ip: ip(1), bearer: ana.bearer, body: { code: st.json.code }, cf: { country: 'NG' } });
  assert.deepEqual([home.json.sameNetwork, home.json.sameCountry], [true, true]);
  // Info binds nothing: the TV still waits.
  assert.deepEqual((await post(env, '/api/auth/tv/poll', { ip: ip(1), body: { code: st.json.code, secret: st.json.secret } })).json, { state: 'pending' });
  // A guest, or a TV session, asks nothing.
  const g = await AUTH.createSession(SECRET, '0123456789abcdef', 'Invitado');
  assert.equal((await post(env, '/api/auth/tv/info', { ip: ip(2), bearer: g.token, body: { code: st.json.code } })).status, 403);
  const tv = await tvSignIn(env, ana.bearer, ip);
  const r = await post(env, '/api/auth/tv/info', { ip: ip(2), bearer: tv.bearer, body: { code: st.json.code } });
  assert.equal(r.json.error, 'tv_session');
});

test('auth-1: a wrong code asked at /tv/info counts as a failed confirm (10 per account, then throttled)', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const ana = await passwordAccount(env, obj, 'Ana', ip(0));
  obj.tv.wokeAt = Date.now() - 10 * 60_000; // awake for longer than a code's life: an unknown code is wrong
  for (let i = 0; i < 10; i++) assert.equal((await post(env, '/api/auth/tv/info', { ip: ip(1), bearer: ana.bearer, body: { code: 'ZZZZZZ' } })).status, 404);
  const st = await post(env, '/api/auth/tv/start', { ip: ip(2) });
  const r = await post(env, '/api/auth/tv/confirm', { ip: ip(3), bearer: ana.bearer, body: { code: st.json.code } });
  assert.equal(r.status, 429, 'enumerating codes through info spends the same budget');
});

// ---- auth-2 / authz-1: linking never overwrites, needs a fresh primary sign-in, and unlink ------

const MIN = 60_000;
/** Run fn with the AccountsDO's clock moved by ms (a sign-in "11 minutes ago"). */
async function at(obj, ms, fn) {
  obj.now = () => Date.now() + ms;
  try {
    return await fn();
  } finally {
    obj.now = () => Date.now();
  }
}
const userRow = (obj, id) => obj.store.sql.exec('SELECT * FROM users WHERE id = ?', id).toArray()[0];

test('auth-2: a link never replaces the account\'s own Google id (409 provider_set), even from a fresh session', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const v = await oauth(env, 'google', 'victim-sub', { ip: ip(0) });
  const fresh = await refresh(env, v.rt, ip(0));
  const victimId = fresh.json.playerId;
  // Whoever holds this browser's cookie right after the victim's sign-in links the attacker's own Google.
  const atk = await oauth(env, 'google', 'attacker-sub', { query: '?link=1', cookie: '__Host-tg_rt=' + fresh.rt, ip: ip(1) });
  assert.equal(atk.done.location, '/#auth=error:provider_set');
  assert.equal(userRow(obj, victimId).google_sub, 'victim-sub', 'unchanged');
  const back = await oauth(env, 'google', 'victim-sub', { ip: ip(0) });
  assert.equal((await refresh(env, back.rt, ip(0))).json.playerId, victimId, "the victim's Google still opens the victim's account");
  const atkSignIn = await oauth(env, 'google', 'attacker-sub', { ip: ip(1) });
  assert.equal(atkSignIn.done.location, '/#auth=new', "the attacker's Google is a new account of its own");
});

test('authz-1: a second provider needs a credential proved on this browser in the last 10 minutes; a stolen older cookie links nothing', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  // A Google-only account that signed in 11 minutes ago: its cookie (stolen or not) is not fresh.
  const old = await at(obj, -11 * MIN, () => oauth(env, 'google', 'g-ana', { ip: ip(0) }));
  const s0 = await refresh(env, old.rt, ip(0));
  const id = s0.json.playerId;
  const rt = s0.rt;
  const tryLink = await req(env, 'GET', '/api/auth/oauth/discord/start?link=1', { ip: ip(1), cookie: '__Host-tg_rt=' + rt, origin: null });
  assert.equal(tryLink.location, '/#auth=error:reauth_required', 'never sent to the provider');
  assert.equal(userRow(obj, id).discord_id, null);
  // The owner confirms it is them with the Google already on the account, then links Discord.
  const re = await oauth(env, 'google', 'g-ana', { query: '?reauth=1', cookie: '__Host-tg_rt=' + rt, ip: ip(0) });
  assert.equal(re.done.location, '/#auth=reauth');
  assert.equal((await refresh(env, rt, ip(0))).status, 401, 'the old token of this browser was replaced');
  const s = await refresh(env, re.rt, ip(0));
  assert.ok(Math.abs(claims(s.json.session).aat - Date.now() / 1000) < 5, 'the session says the credential is fresh');
  const link = await oauth(env, 'discord', 'd-ana', { query: '?link=1', cookie: '__Host-tg_rt=' + s.rt, ip: ip(0) });
  assert.equal(link.done.location, '/#auth=linked');
  assert.equal(userRow(obj, id).discord_id, 'd-ana');
  assert.ok(userRow(obj, id).discord_linked_at > 0);
  const me = await req(env, 'GET', '/api/me', { ip: ip(0), bearer: (await refresh(env, link.rt, ip(0))).json.session });
  assert.deepEqual(me.json.providers, ['google', 'discord']);
  assert.ok(me.json.linkedAt.google > 0 && me.json.linkedAt.discord > 0, 'PERFIL shows when each was linked');
});

test('authz-1: re-authenticating with an identity that is not the account\'s signs nobody in and makes nothing; a link without a valid cookie never turns into a sign-up', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const a = await oauth(env, 'google', 'g-ana', { ip: ip(0) });
  const users = () => obj.store.sql.exec('SELECT COUNT(*) AS n FROM users').toArray()[0].n;
  const before = users();
  const rt = (await refresh(env, a.rt, ip(0))).rt;
  const wrong = await oauth(env, 'google', 'g-someone-else', { query: '?reauth=1', cookie: '__Host-tg_rt=' + rt, ip: ip(0) });
  assert.equal(wrong.done.location, '/#auth=error:reauth_mismatch');
  assert.equal(wrong.rt, null, 'no cookie');
  assert.equal(users(), before, 'no account made');
  assert.equal((await refresh(env, rt, ip(0))).status, 200, 'and this browser is still signed in');
  for (const cookie of [undefined, '__Host-tg_rt=nope.nope']) {
    const r = await req(env, 'GET', '/api/auth/oauth/discord/start?link=1', { ip: ip(1), cookie, origin: null });
    assert.equal(r.location, '/#auth=error:link_expired', String(cookie));
  }
  assert.equal(users(), before);
});

test('authz-1: a suspended account links nothing', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const a = await oauth(env, 'google', 'g-ban', { ip: ip(0) });
  const s = await refresh(env, a.rt, ip(0));
  const id = s.json.playerId;
  // Suspended between its fresh sign-in and the link's callback.
  const start = await req(env, 'GET', '/api/auth/oauth/discord/start?link=1', { ip: ip(0), cookie: '__Host-tg_rt=' + s.rt, origin: null });
  obj.store.sql.exec('UPDATE users SET banned = 1 WHERE id = ?', id);
  identity.discord = { id: 'd-ban', username: 'x' };
  const nonce = new URL(start.location).searchParams.get('state');
  const cb = await req(env, 'GET', `/api/auth/oauth/discord/callback?code=x&state=${nonce}`, { ip: ip(0), cookie: '__Host-tg_oa=' + cookieOf(start, '__Host-tg_oa'), origin: null });
  assert.match(cb.location, /^\/#auth=error:/);
  assert.equal(userRow(obj, id).discord_id, null);
});

test('authz-1: unlink: a fresh session only, never the last way in; then another one links', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const a = await oauth(env, 'google', 'g-uno', { ip: ip(0) });
  let s = await refresh(env, a.rt, ip(0));
  const id = s.json.playerId;
  // Google only: its last way in.
  let r = await post(env, '/api/auth/unlink', { ip: ip(0), bearer: s.json.session, body: { provider: 'google' } });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'last_method');
  const l = await oauth(env, 'discord', 'd-uno', { query: '?link=1', cookie: '__Host-tg_rt=' + s.rt, ip: ip(0) });
  assert.equal(l.done.location, '/#auth=linked');
  s = await refresh(env, l.rt, ip(0));
  // A Bearer whose sign-in is 11 minutes old is refused.
  const nowS = Math.floor(Date.now() / 1000);
  const stale = await AUTH.signJwt(SECRET, { typ: 's', sub: id, name: 'x', iat: nowS, exp: nowS + 600, acct: 1, aat: nowS - 11 * 60 });
  r = await post(env, '/api/auth/unlink', { ip: ip(0), bearer: stale, body: { provider: 'google' } });
  assert.equal(r.json.error, 'reauth_required');
  r = await post(env, '/api/auth/unlink', { ip: ip(0), bearer: s.json.session, body: { provider: 'google' } });
  assert.equal(r.status, 200);
  assert.equal(userRow(obj, id).google_sub, null);
  assert.equal((await post(env, '/api/auth/unlink', { ip: ip(0), bearer: s.json.session, body: { provider: 'discord' } })).json.error, 'last_method');
  assert.equal((await post(env, '/api/auth/unlink', { ip: ip(0), bearer: s.json.session, body: { provider: 'google' } })).status, 404, 'not linked');
  // Now another Google may be linked.
  const g2 = await oauth(env, 'google', 'g-dos', { query: '?link=1', cookie: '__Host-tg_rt=' + s.rt, ip: ip(0) });
  assert.equal(g2.done.location, '/#auth=linked');
  assert.equal(userRow(obj, id).google_sub, 'g-dos');
});

test('authz-1: a password account re-authenticates with its password (POST /api/auth/reauth): its session and cookie become fresh', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const ana = await at(obj, -11 * MIN, () => passwordAccount(env, obj, 'Ana', ip(0)));
  const s = await refresh(env, ana.rt, ip(0));
  assert.ok(claims(s.json.session).aat < Date.now() / 1000 - 600, 'signed in 11 minutes ago');
  const bad = await post(env, '/api/auth/reauth', { ip: ip(0), bearer: s.json.session, cookie: '__Host-tg_rt=' + s.rt, body: { password: KEY2 } });
  assert.equal(bad.status, 401);
  const ok = await post(env, '/api/auth/reauth', { ip: ip(0), bearer: s.json.session, cookie: '__Host-tg_rt=' + s.rt, body: { password: KEY } });
  assert.equal(ok.status, 200);
  assert.ok(Math.abs(claims(ok.json.session).aat - Date.now() / 1000) < 5);
  const link = await oauth(env, 'discord', 'd-ana', { query: '?link=1', cookie: '__Host-tg_rt=' + s.rt, ip: ip(0) });
  assert.equal(link.done.location, '/#auth=linked', 'the cookie is fresh too');
});

// ---- auth-3 / authz-2 / auth-persist-1: a first password and recovery codes need a fresh re-auth ----

test('auth-3: an OAuth-only account\'s 1-hour Bearer alone sets no password and mints no recovery codes (403 reauth_required)', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  // A Discord-only account signed in 11 minutes ago, on two devices; its current Bearer is valid but not fresh.
  const a = await at(obj, -11 * MIN, () => oauth(env, 'discord', 'd-victim', { ip: ip(0) }));
  const b = await at(obj, -11 * MIN, () => oauth(env, 'discord', 'd-victim', { ip: ip(1) }));
  const s = await refresh(env, a.rt, ip(0));
  const id = s.json.playerId;
  const pw = await post(env, '/api/auth/password', { ip: ip(2), bearer: s.json.session, body: { password: KEY2 } });
  assert.equal(pw.status, 403);
  assert.equal(pw.json.error, 'reauth_required');
  const rc = await post(env, '/api/auth/recovery-codes', { ip: ip(2), bearer: s.json.session, body: {} });
  assert.equal(rc.status, 403);
  assert.equal(rc.json.error, 'reauth_required');
  assert.equal(obj.store.credentials(userRow(obj, id).username).hash, undefined, 'still no password');
  assert.deepEqual(JSON.parse(userRow(obj, id).recovery), [], 'no codes');
  assert.equal((await refresh(env, b.rt, ip(1))).status, 200, 'the other device is still signed in');
  // A login with the attacker's chosen key: nothing to sign in to.
  const login = await post(env, '/api/auth/login', { ip: ip(2), body: { username: userRow(obj, id).username, password: KEY2 } });
  assert.equal(login.status, 401);
});

test('auth-persist-1: after "confirm it is you" the owner sets a first password and gets codes; the other devices stay signed in', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const other = await oauth(env, 'discord', 'd-ana', { ip: ip(1) });
  const a = await oauth(env, 'discord', 'd-ana', { ip: ip(0) }); // a fresh sign-in on this browser
  const s = await refresh(env, a.rt, ip(0));
  const id = s.json.playerId;
  const pw = await post(env, '/api/auth/password', { ip: ip(0), bearer: s.json.session, cookie: '__Host-tg_rt=' + s.rt, body: { password: KEY2 } });
  assert.equal(pw.status, 200);
  assert.ok(obj.store.credentials(userRow(obj, id).username).hash, 'a password now');
  const o2 = await refresh(env, other.rt, ip(1));
  assert.equal(o2.status, 200, 'a first password signs nobody out');
  const s2 = await refresh(env, s.rt, ip(0));
  const rc = await post(env, '/api/auth/recovery-codes', { ip: ip(0), bearer: s2.json.session, body: { password: KEY2 } });
  assert.equal(rc.status, 200);
  assert.equal(rc.json.recoveryCodes.length, 8);
  // A password account changes its password with the old one, fresh or not (as before), and that signs the others out.
  const stale = await AUTH.signJwt(SECRET, { typ: 's', sub: id, name: userRow(obj, id).username, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600, acct: 1 });
  assert.equal((await post(env, '/api/auth/password', { ip: ip(0), bearer: stale, body: { password: KEY } })).status, 400, 'no old password: refused');
  const ch = await post(env, '/api/auth/password', { ip: ip(0), bearer: stale, cookie: '__Host-tg_rt=' + s2.rt, body: { oldPassword: KEY2, password: KEY } });
  assert.equal(ch.status, 200);
  assert.equal((await refresh(env, o2.rt, ip(1))).status, 401, 'a change signs the other devices out');
});

// ---- auth-11 / econ-2: the maintainer routes need a fresh primary sign-in, never a TV's ----------

test('auth-11 / econ-2: a maintainer\'s 1-hour Bearer or refresh cookie alone grants nothing: /nodes/tokens and /nodes/admin/* need a password proof (level 2) from the last 15 minutes; Discord\'s press (level 1) is not enough', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const seen = withNodes(env, null);
  // The project account (a password, and Discord linked) signed in 20 minutes ago; its cookie still refreshes (a stolen copy would too).
  const owner = await at(obj, -20 * MIN, () => passwordAccount(env, obj, 'Proyecto', ip(0)));
  obj.store.sql.exec("UPDATE users SET discord_id = 'd-owner' WHERE id = ?", owner.id);
  const s = await refresh(env, owner.rt, ip(0));
  env.NODE_TRUSTED_OPERATORS = s.json.playerId;
  const calls = [
    ['POST', '/nodes/tokens', { region: 'SA' }],
    ['GET', '/nodes/admin/nodes', undefined],
    ['POST', '/nodes/admin/grant', { account: s.json.playerId, item: 'pampero' }],
    ['POST', '/nodes/admin/status', { nodeId: 'n1', status: 'banned', reason: 'x' }],
    ['POST', '/nodes/admin/drain', { nodeId: 'n1', reason: 'x' }],
    ['POST', '/nodes/admin/unfreeze', { account: s.json.playerId }],
  ];
  for (const [method, path, body] of calls) {
    const r = await req(env, method, path, { ip: ip(0), bearer: s.json.session, body });
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.equal(r.json.error, 'reauth_required', `${method} ${path}`);
  }
  assert.deepEqual(seen, [], 'nothing reached the NodeRegistryDO');
  // Confirming with Discord (a press on discord.com: level 1, which a phished or silent provider sign-in gives) is refused.
  const re = await oauth(env, 'discord', 'd-owner', { query: '?reauth=1', cookie: '__Host-tg_rt=' + s.rt, ip: ip(0) });
  assert.equal(re.done.location, '/#auth=reauth');
  const viaDiscord = await refresh(env, re.rt, ip(0));
  assert.equal(claims(viaDiscord.json.session).aal, 1);
  for (const [method, path, body] of calls) {
    const r = await req(env, method, path, { ip: ip(0), bearer: viaDiscord.json.session, body });
    assert.deepEqual([r.status, r.json.error, r.json.level], [403, 'reauth_required', 2], `${method} ${path} at level 1`);
  }
  assert.deepEqual(seen, [], 'still nothing reached it');
  // The maintainer confirms it is them with the password (level 2), then works.
  const pw = await post(env, '/api/auth/reauth', { ip: ip(0), bearer: viaDiscord.json.session, cookie: '__Host-tg_rt=' + viaDiscord.rt, body: { password: KEY } });
  assert.equal(pw.status, 200, JSON.stringify(pw.json));
  const fresh = await refresh(env, viaDiscord.rt, ip(0));
  assert.equal(claims(fresh.json.session).aal, 2);
  for (const [method, path, body] of calls) assert.equal((await req(env, method, path, { ip: ip(0), bearer: fresh.json.session, body })).status, 200, `${method} ${path} fresh`);
  assert.equal(seen.length, calls.length);
  // A non-maintainer still hears not_trusted, fresh or not.
  const other = await oauth(env, 'discord', 'd-other', { ip: ip(1) });
  const o = await refresh(env, other.rt, ip(1));
  assert.equal((await req(env, 'POST', '/nodes/tokens', { ip: ip(1), bearer: o.json.session, body: { region: 'SA' } })).json.error, 'not_trusted');
  // Twenty minutes after that sign-in, the routes ask again.
  const later = await AUTH.signJwt(SECRET, { ...claims(fresh.json.session), aat: Math.floor(Date.now() / 1000) - 16 * 60 });
  assert.equal((await req(env, 'GET', '/nodes/admin/nodes', { ip: ip(0), bearer: later })).json.error, 'reauth_required');
});

// ---- auth-8: login CSRF: every POST /api/auth/* needs the game's Origin, and JSON when it reads a body ----

test('auth-8: a cross-site text/plain form POST to login, register or recover sets no cookie (403 bad_origin; 415 when same-origin but not JSON)', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  obj.store.register('atacante', await A.newPasswordRecord(KEY), [], 'e'.repeat(64), Date.now());
  // What <form enctype="text/plain"> with name='{"username":"atacante","password":"<key>","x":"' value='"}' sends.
  const body = `{"username":"atacante","password":"${KEY}","x":"` + '=' + '"}';
  for (const path of ['/api/auth/login', '/api/auth/register', '/api/auth/recover']) {
    for (const origin of ['https://evil.example', 'null', null]) {
      const r = await req(env, 'POST', path, { ip: ip(0), origin, contentType: 'text/plain', body });
      assert.equal(r.status, 403, `${path} from ${origin}`);
      assert.equal(r.json.error, 'bad_origin');
      assert.equal(r.headers.get('set-cookie'), null);
    }
    const same = await req(env, 'POST', path, { ip: ip(0), contentType: 'text/plain', body });
    assert.equal(same.status, 415, `${path}: text/plain from this origin`);
    assert.equal(same.headers.get('set-cookie'), null);
  }
  const ok = await req(env, 'POST', '/api/auth/login', { ip: ip(0), body: JSON.parse(body) });
  assert.equal(ok.status, 200, 'the game page itself (JSON, its Origin) still signs in');
});

test('auth-8: every state-changing auth route fails closed without the game\'s Origin; bodyless refresh needs no JSON type (the maintainer console line)', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const ana = await passwordAccount(env, obj, 'Ana', ip(0));
  const paths = ['/api/auth/register', '/api/auth/login', '/api/auth/refresh', '/api/auth/logout', '/api/auth/recover', '/api/auth/password', '/api/auth/recovery-codes', '/api/auth/reauth', '/api/auth/unlink', '/api/auth/sessions/revoke', '/api/auth/sessions/revoke-all', '/api/auth/tv/start', '/api/auth/tv/info', '/api/auth/tv/confirm', '/api/auth/tv/poll'];
  for (const path of paths) {
    const r = await req(env, 'POST', path, { ip: ip(1), origin: null, bearer: ana.bearer, cookie: '__Host-tg_rt=' + ana.rt, body: {} });
    assert.equal(r.status, 403, path);
    assert.equal(r.json.error, 'bad_origin', path);
  }
  const s = await refresh(env, ana.rt, ip(0));
  assert.equal(s.status, 200, 'nothing above touched the session');
  // fetch('/api/auth/refresh', { method: 'POST' }) from a tab of the game: no body, no content type.
  const bare = await req(env, 'POST', '/api/auth/refresh', { ip: ip(0), cookie: '__Host-tg_rt=' + s.rt });
  assert.equal(bare.status, 200);
});

test('auth-8: under wrangler dev a loopback page (Vite on another port) passes; with VITE_ORIGINS empty only the Worker\'s own origin does', async () => {
  const { env, obj } = makeEnv();
  obj.store.register('Dev', await A.newPasswordRecord(KEY), [], 'e'.repeat(64), Date.now());
  const at = async (url, origin) => (await worker.fetch(new Request(url, { method: 'POST', headers: { Origin: origin, 'content-type': 'application/json', 'CF-Connecting-IP': '127.0.0.1' }, body: JSON.stringify({ username: 'Dev', password: KEY }) }), env)).status;
  assert.equal(await at('http://127.0.0.1:8967/api/auth/login', 'http://127.0.0.1:5467'), 200);
  assert.equal(await at('http://127.0.0.1:8967/api/auth/login', 'https://evil.example'), 403);
  env.VITE_ORIGINS = '';
  assert.equal(await at('https://turbo-gol.com/api/auth/login', 'https://evil.example'), 403, 'an empty list lets no stranger in here');
  assert.equal(await at('https://turbo-gol.com/api/auth/login', 'https://turbo-gol.com'), 200);
});

// ---- auth-5: sign-in lockout per (username, network), a slow-down rather than a lock, one answer ----

const login = (env, username, password, ip, extra = {}, cookie) => post(env, '/api/auth/login', { ip, cookie, body: { username, password, ...extra } });

test('auth-5: failures from other networks never lock the owner out: 20 wrong passwords from 20 IPs, the owner signs in from home', async () => {
  const { env, obj } = makeEnv();
  obj.store.register('victima', await A.newPasswordRecord(KEY), [], 'e'.repeat(64), Date.now());
  for (let i = 0; i < 20; i++) assert.equal((await login(env, 'victima', KEY2, `192.0.2.${i + 1}`)).status, 401, `attacker ${i + 1}`);
  const own = await login(env, 'victima', KEY, '198.51.100.200');
  assert.equal(own.status, 200, JSON.stringify(own.json));
  // Recovery shares the counters: the owner's code still works from home too.
  const r = await post(env, '/api/auth/recover', { ip: '198.51.100.200', body: { username: 'victima', code: 'XXXX-XXXX', password: KEY } });
  assert.equal(r.status, 401, 'a wrong code: wrong, not throttled');
  assert.equal(r.json.error, 'bad_recovery');
});

test('auth-5: one (username, network) pair is throttled after 5 failures; the same username from another network is not', async () => {
  const { env, obj } = makeEnv();
  obj.store.register('pareja', await A.newPasswordRecord(KEY), [], 'e'.repeat(64), Date.now());
  for (let i = 0; i < 5; i++) await login(env, 'pareja', KEY2, '203.0.113.77');
  const same = await login(env, 'pareja', KEY, '203.0.113.77');
  assert.equal(same.status, 429);
  assert.equal(same.json.error, 'throttled');
  assert.equal((await login(env, 'pareja', KEY, '203.0.113.78')).status, 200);
});

test('auth-5: an IPv6 /64 counts as one network (30 failures across its addresses, then paused), and a /48 as one block (300)', async () => {
  const { env, obj } = makeEnv();
  const ADO = await import('../src/AccountsDO.ts');
  // Sign-in PR 4 (the design's §2.3): 30 per /64, 20 times that per IPv4 address (levels.test.mjs).
  assert.equal(ADO.LOGIN_NET6_MAX, 30);
  assert.equal(ADO.LOGIN_WIDE_MAX, 300);
  obj.store.register('objetivo', await A.newPasswordRecord(KEY), [], 'e'.repeat(64), Date.now());
  // A sprayer: one guess for each of 30 usernames, each from a fresh address of one /64.
  for (let i = 0; i < 30; i++) assert.equal((await login(env, 'user' + i, KEY2, `2001:db8:5:6::${(i + 1).toString(16)}`)).status, 401);
  const r = await login(env, 'objetivo', KEY, '2001:db8:5:6::ffff');
  assert.equal(r.status, 429, 'the /64 is one network');
  assert.equal((await login(env, 'objetivo', KEY, '2001:db8:5:7::1')).status, 200, 'the next /64 is not');
  // The /48: 300 failures across its /64s.
  for (let i = 0; i < 300; i++) await login(env, 'u' + i, KEY2, `2001:db8:9:${i.toString(16)}::1`);
  assert.equal((await login(env, 'objetivo', KEY, '2001:db8:9:ffff::1')).status, 429, 'the /48 is one block');
});

test('auth-5: one answer: an OAuth-only account\'s username and a wrong password say bad_credentials, as any other', async () => {
  const { env } = makeEnv();
  const ip = ips();
  const o = await oauth(env, 'discord', 'd-solo', { ip: ip(0) });
  const name = (await refresh(env, o.rt, ip(0))).json.name;
  const a = await login(env, name, KEY2, ip(1));
  const b = await login(env, 'nadie-existe', KEY2, ip(1));
  assert.deepEqual([a.status, a.json.error], [401, 'bad_credentials']);
  assert.deepEqual([a.json], [b.json], 'the same body as an unknown username');
});

// The slow-down of a username under attack (403 turnstile_required past 10 failures) is gone with
// sign-in PR 4: every sign-in and recovery needs a solved Turnstile check (levels.test.mjs).

// ---- review round: the password checks behind a session, the per-username cap, logout ------------

test('auth-5 (review): a password checked behind a stolen session is throttled per account: 400 guesses at the old password from 80 /64s stop after 5, and the owner still signs in', async () => {
  const { env, obj } = makeEnv({ TURNSTILE_DISABLED: '0', TURNSTILE_SECRET: 'ts-secret', TURNSTILE_SITEKEY: 'ts-site' });
  const ana = await passwordAccount(env, obj, 'Robada', '198.18.230.1', { turnstileToken: 'good-token' });
  const t0 = Date.now();
  obj.now = () => t0;
  const cookie = '__Host-tg_rt=' + ana.rt;
  const tally = {};
  for (let i = 0; i < 400; i++) {
    // 80 /64s in 2 /48s, 5 addresses each: no network cap is ever reached.
    const ip = `2001:db8:${i % 160 < 80 ? 'a' : 'b'}:${(Math.floor(i / 5) % 80).toString(16)}::${(i % 5) + 1}`;
    const r = await post(env, '/api/auth/password', { ip, bearer: ana.bearer, cookie, body: { oldPassword: (i + 1).toString(16).padStart(64, '0'), password: 'e'.repeat(64) } });
    const k = r.status + ':' + (r.json?.error ?? 'ok');
    tally[k] = (tally[k] ?? 0) + 1;
  }
  // 5 wrong answers, then refusals: AccountsDO's 'throttled' (and, merged with sec/edge-limits, its
  // per-account rate limit on this route too: 'rate_limited'), never another password check.
  assert.equal(tally['401:bad_credentials'], 5, JSON.stringify(tally));
  assert.equal(Object.entries(tally).filter(([k]) => !k.startsWith('429:') && k !== '401:bad_credentials').length, 0, JSON.stringify(tally));
  assert.ok(tally['429:throttled'] >= 5, JSON.stringify(tally));
  // The right old password is refused too while the lock lasts, and nothing changed.
  const right = await post(env, '/api/auth/password', { ip: '2001:db8:c:1::1', bearer: ana.bearer, cookie, body: { oldPassword: KEY, password: 'e'.repeat(64) } });
  assert.equal(right.status, 429);
  // The other checks behind a session share the account's counter.
  const codes = await post(env, '/api/auth/recovery-codes', { ip: '2001:db8:c:2::1', bearer: ana.bearer, cookie, body: { password: KEY } });
  assert.deepEqual([codes.status, codes.json.error], [429, 'throttled']);
  const ren = await post(env, '/api/me/username', { ip: '2001:db8:c:3::1', bearer: ana.bearer, cookie, body: { username: 'Robada2', password: KEY, newPassword: KEY2 } });
  assert.deepEqual([ren.status, ren.json.error], [429, 'throttled']);
  // The lock stops only the checks behind a session: the owner signs in from home (with the anti-bot check every sign-in has).
  const own = await login(env, 'Robada', KEY, '198.18.230.9', { turnstileToken: 'good-token' });
  assert.equal(own.status, 200, 'the owner is never locked out of signing in: ' + JSON.stringify(own.json));
  const re = await post(env, '/api/auth/reauth', { ip: '2001:db8:c:4::1', bearer: ana.bearer, cookie, body: { password: KEY } });
  assert.deepEqual([re.status, re.json.error], [429, 'throttled'], 'a re-authentication (the way to aat) too');
  // Then the doubling delay of before: one more guess after 30 s, the next one waits 60 s.
  obj.now = () => t0 + 31_000;
  assert.equal((await post(env, '/api/auth/reauth', { ip: '2001:db8:c:5::1', bearer: ana.bearer, cookie, body: { password: KEY2 } })).status, 401);
  const again = await post(env, '/api/auth/reauth', { ip: '2001:db8:c:6::1', bearer: ana.bearer, cookie, body: { password: KEY } });
  assert.deepEqual([again.status, again.json.error], [429, 'throttled']);
  assert.ok(again.json.retryAfterMs > 55_000, 'the next wait is 60 s');
});

test('auth-4 (review): signing out revokes the whole family: that cookie, an older copy, and a thief\'s newer chain all get 401; the account\'s other devices stay', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  // The cookie this browser holds and an older copy of its family; a second browser of the account.
  const ana = await passwordAccount(env, obj, 'Salida', ip(0));
  const older = ana.rt;
  const now = await refresh(env, older, ip(0));
  assert.equal(now.status, 200);
  const other = await login(env, 'Salida', KEY, ip(3));
  assert.equal(other.status, 200);
  const out = await post(env, '/api/auth/logout', { ip: ip(0), cookie: '__Host-tg_rt=' + now.rt });
  assert.equal(out.status, 200);
  assert.match(setCookies(out).join('\n'), /__Host-tg_rt=;[^\n]*Max-Age=0/, 'the cookie is cleared');
  assert.equal((await refresh(env, now.rt, ip(0))).status, 401, 'the signed-out cookie no longer refreshes');
  assert.equal((await refresh(env, older, ip(0))).status, 401, 'nor does an older copy of its family');
  assert.equal((await refresh(env, cookieOf(other, '__Host-tg_rt'), ip(3))).status, 200, 'another device of the account stays signed in');
  // A thief copied a cookie and rotated it first; the owner signs out with the copy the browser still holds.
  const bea = await passwordAccount(env, obj, 'Salida2', ip(1));
  const t1 = await refresh(env, bea.rt, ip(2));
  const t2 = await refresh(env, t1.rt, ip(2));
  assert.equal(t2.status, 200);
  assert.equal((await post(env, '/api/auth/logout', { ip: ip(1), cookie: '__Host-tg_rt=' + bea.rt })).status, 200);
  assert.equal((await refresh(env, t2.rt, ip(2))).status, 401, "the thief's newer token goes with the family");
});

test('auth-4 (review): REFRESH_TOKEN_RE takes every cookie this code mints and every token from before families, nothing else (the merge with sec/edge-limits keeps it)', async () => {
  const { env, obj } = makeEnv();
  const ana = await passwordAccount(env, obj, 'Forma', ips()(0));
  assert.match(ana.rt, A.REFRESH_TOKEN_RE, 'a family token');
  assert.match(Buffer.from(new Uint8Array(32).fill(9)).toString('base64url'), A.REFRESH_TOKEN_RE, 'a 43-character token from before');
  for (const bad of ['', 'x', 'a'.repeat(42), 'a'.repeat(44), 'a'.repeat(21) + '.' + 'b'.repeat(43), 'a'.repeat(22) + '.' + 'b'.repeat(42), 'a'.repeat(22) + '!' + 'b'.repeat(43)]) {
    assert.doesNotMatch(bad, A.REFRESH_TOKEN_RE, JSON.stringify(bad));
  }
});

test('auth-5 (review): a targeted guesser gets 50 failures a day on one username, whatever its networks and solved checks, then pauses of 15 minutes doubling to an hour; the owner\'s own browsers still sign in', async () => {
  const { env, obj } = makeEnv({ TURNSTILE_DISABLED: '0', TURNSTILE_SECRET: 'ts-secret', TURNSTILE_SITEKEY: 'ts-site' });
  const ADO = await import('../src/AccountsDO.ts');
  const tok = { turnstileToken: 'good-token' };
  obj.store.register('blanco', await A.newPasswordRecord(KEY), [await A.recoveryCodeHash('AAAA-BBBB')], 'e'.repeat(64), Date.now());
  obj.store.register('vecina', await A.newPasswordRecord(KEY), [], 'd'.repeat(64), Date.now());
  const t0 = Date.now();
  obj.now = () => t0;
  // The owner signed in once on two browsers (home, phone): each keeps its device cookie, logout or not.
  const home = await login(env, 'blanco', KEY, '198.18.240.1', tok);
  const homeDv = cookieOf(home, '__Host-tg_dv');
  const phoneDv = cookieOf(await login(env, 'blanco', KEY, '198.18.240.2', tok), '__Host-tg_dv');
  assert.equal((await post(env, '/api/auth/logout', { ip: '198.18.240.1', cookie: '__Host-tg_rt=' + cookieOf(home, '__Host-tg_rt') })).status, 200);
  const otherDv = cookieOf(await login(env, 'vecina', KEY, '198.18.240.3', tok), '__Host-tg_dv');
  // 300 guesses with solved checks, each from a fresh /64 of 3 /48s: no network cap is ever reached.
  const tally = {};
  for (let i = 0; i < 300; i++) {
    const ip = `2001:db8:${(0x10 + (i % 3)).toString(16)}:${Math.floor(i / 3).toString(16)}::1`;
    const r = await login(env, 'blanco', (i + 1).toString(16).padStart(64, '0'), ip, tok);
    const k = r.status + ':' + (r.json?.error ?? 'ok');
    tally[k] = (tally[k] ?? 0) + 1;
  }
  // Sign-in PR 4 (the design's §2.3): 50 a day, then a pause (it was 100, then the rest of the day).
  assert.deepEqual(tally, { '401:bad_credentials': 50, '429:throttled': 250 });
  assert.equal(ADO.LOGIN_USER_DAY_MAX, 50);
  assert.match(homeDv, /^[0-9a-f]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
  assert.match(setCookies(home).find((c) => c.startsWith('__Host-tg_dv=')), /HttpOnly; Secure; SameSite=Strict; Max-Age=15552000/);
  // A right guess from a browser the account does not know is refused too, and so is its recovery.
  const guess = await login(env, 'blanco', KEY, '2001:db8:20:1::1', tok);
  assert.deepEqual([guess.status, guess.json.error], [429, 'throttled']);
  assert.ok(guess.json.retryAfterMs > 14 * 60_000 && guess.json.retryAfterMs <= 15 * 60_000, 'a 15-minute pause: ' + guess.json.retryAfterMs);
  const rec = await post(env, '/api/auth/recover', { ip: '2001:db8:20:2::1', body: { username: 'blanco', code: 'AAAA-BBBB', password: KEY2, ...tok } });
  assert.equal(rec.status, 429);
  // Nor does a forged device cookie, or a good one of another account, open it.
  const [homeUser, , homeMac] = homeDv.split('.');
  const forged = homeUser + '.' + 'Z'.repeat(22) + '.' + homeMac; // another device id under the same MAC
  assert.equal((await login(env, 'blanco', KEY, '2001:db8:20:3::1', tok, '__Host-tg_dv=' + forged)).status, 429);
  assert.equal((await login(env, 'blanco', KEY, '2001:db8:20:4::1', tok, '__Host-tg_dv=' + otherDv)).status, 429);
  // The pause over, one more failure pauses it for twice as long, up to an hour.
  obj.now = () => t0 + 15 * 60_000 + 1_000;
  assert.equal((await login(env, 'blanco', KEY2, '2001:db8:20:6::1', tok)).status, 401);
  const twice = await login(env, 'blanco', KEY, '2001:db8:20:7::1', tok);
  assert.ok(twice.status === 429 && twice.json.retryAfterMs > 29 * 60_000 && twice.json.retryAfterMs <= 30 * 60_000, JSON.stringify(twice.json));
  // The owner's browsers sign in, from home or from anywhere.
  const back = await login(env, 'blanco', KEY, '198.18.240.1', tok, '__Host-tg_dv=' + homeDv);
  assert.equal(back.status, 200, JSON.stringify(back.json));
  assert.equal((await login(env, 'blanco', KEY, '2001:db8:30:1::1', tok, '__Host-tg_dv=' + phoneDv)).status, 200);
  // A stolen device cookie guesses like one pair: 5 failures, then even the right password waits; the owner's other browser does not.
  for (let i = 0; i < 5; i++) assert.equal((await login(env, 'blanco', KEY2, `2001:db8:40:${i}::1`, tok, '__Host-tg_dv=' + phoneDv)).status, 401);
  assert.equal((await login(env, 'blanco', KEY, '2001:db8:40:9::1', tok, '__Host-tg_dv=' + phoneDv)).status, 429);
  assert.equal((await login(env, 'blanco', KEY, '198.18.240.1', tok, '__Host-tg_dv=' + cookieOf(back, '__Host-tg_dv'))).status, 200);
  // The owner's success cleared the username's count: an unknown browser may try again, and the next day too.
  assert.equal((await login(env, 'blanco', KEY, '2001:db8:20:8::1', tok)).status, 200);
  obj.now = () => t0 + ADO.LOGIN_DAY_MS + 1_000;
  assert.equal((await login(env, 'blanco', KEY, '2001:db8:20:5::1', tok)).status, 200);
});
