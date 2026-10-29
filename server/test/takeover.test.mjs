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

