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

/** A password account signed in through the real login route: its Bearer and refresh cookie. */
async function passwordAccount(env, obj, name, ip = '198.18.200.1') {
  const id = obj.store.register(name, await A.newPasswordRecord(KEY), [], 'f'.repeat(63) + String(name.length % 10), Date.now()).userId;
  const r = await post(env, '/api/auth/login', { ip, body: { username: name, password: KEY } });
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
