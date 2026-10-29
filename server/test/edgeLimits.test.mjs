// The Worker's HTTP rate limits (server/src/limits.ts) and the edge routes, without workerd: the
// table against wrangler.jsonc's `ratelimits`, each rule counted by its session, account or
// network (an IPv6 /64 as one network, an IPv4 address shared by a whole school still served),
// the Workers Rate Limiting binding consulted after the in-isolate count (a fake one stands for the
// other isolates of the location; one that throws lets the request through), the queue limit
// before any KV read, the lobby peek before the single LobbyDirectoryDO, the account routes limited
// before the single AccountsDO (a fake that counts its calls; an IPv6 /48 counted as one site on the
// anonymous ones, and accountRoutes' own per-address windows kept apart from the table's), logout
// and refresh with a cookie no refresh token has, the leaderboard's own row cached, the OAuth
// callback's state used once, and GET /api/ice gone.
// 'cloudflare:workers' and MatchDO's wasm are stubbed by the resolve hook (match.test.mjs).
// Run from server/: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
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

const worker = (await import('../src/index.ts')).default;
const { createSession, signJwt } = await import('../src/auth.ts');

const SECRET = 'edge-limits-test-secret';
const ORIGIN = 'https://turbo-gol.com';
const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

/** An AccountsDO stand-in: answers each path and records every call (path and query). */
function accountsNs() {
  const calls = [];
  const answers = {
    '/me': () => ({ name: 'Ana', hasPassword: false }),
    '/leaderboard': (u) => ({ playlist: u.searchParams.get('playlist'), entries: [], total: 0, you: u.searchParams.get('userId') ? { rank: 7, mu: 30 } : null }),
    '/ranked-result': () => ({ status: 'pending' }),
    '/logout': () => ({ ok: true }),
    '/refresh': () => null,
  };
  return {
    calls,
    idFromName: (name) => ({ name }),
    get: () => ({
      fetch: async (url) => {
        const u = new URL(url);
        calls.push(u.pathname + u.search);
        const a = answers[u.pathname];
        const body = a ? a(u) : null;
        return body === null ? new Response(JSON.stringify({ error: 'bad_refresh' }), { status: 401 }) : new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
      },
    }),
  };
}

/** A Workers Rate Limiting binding: `limit` per key, as if the location's other isolates counted too (`seen` adds to it). */
function fakeBinding(limit, seen = new Map()) {
  const keys = [];
  return {
    keys,
    seen,
    async limit({ key }) {
      keys.push(key);
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      return { success: n <= limit };
    },
  };
}

function makeEnv(over = {}) {
  return {
    JWT_SECRET: SECRET,
    VITE_ORIGINS: ORIGIN,
    TURNSTILE_DISABLED: '1',
    FLAGS: { get: async () => null },
    ACCOUNTS: accountsNs(),
    ...over,
  };
}

let v4 = 0;
/** A fresh IPv4 address (every test keeps to its own: the in-isolate windows are this file's). */
const ip4 = () => `10.${(++v4 >> 16) & 255}.${(v4 >> 8) & 255}.${v4 & 255}`;
let v6 = 0;
/** A fresh IPv6 /64, and an address in it. */
const net6 = () => `2001:db8:${(++v6).toString(16)}:1`;

async function req(env, method, path, { headers = {}, body, ip = ip4(), bearer } = {}) {
  const h = { 'CF-Connecting-IP': ip, Origin: ORIGIN, ...headers };
  if (bearer) h.Authorization = 'Bearer ' + bearer;
  if (body !== undefined) h['content-type'] = 'application/json';
  return worker.fetch(new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
}

let accounts = 0;
const accountId = () => (++accounts).toString(16).padStart(16, 'a');
const accountToken = (sub = accountId()) => signJwt(SECRET, { sub, name: 'Ana', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, acct: 1 });
const guestToken = async (sub = accountId()) => (await createSession(SECRET, sub, 'Guest')).token;

// ---- the table -----------------------------------------------------------------------------------

test('every binding the table uses is in wrangler.jsonc with the same limit and period (10 or 60 s), each with its own namespace id', async () => {
  const { EDGE_BINDINGS, LIMITS } = await import('../src/limits.ts');
  const jsonc = src('../wrangler.jsonc').replace(/^\s*\/\/.*$/gm, '');
  const cfg = JSON.parse(jsonc);
  assert.ok(Array.isArray(cfg.ratelimits), 'wrangler.jsonc declares ratelimits');
  const byName = new Map(cfg.ratelimits.map((r) => [r.name, r]));
  for (const [name, b] of Object.entries(EDGE_BINDINGS)) {
    const r = byName.get(name);
    assert.ok(r, name + ' is declared');
    assert.deepEqual(r.simple, { limit: b.limit, period: b.period }, name);
    assert.ok([10, 60].includes(r.simple.period));
    assert.match(r.namespace_id, /^[1-9]\d*$/);
  }
  assert.equal(new Set(cfg.ratelimits.map((r) => r.namespace_id)).size, cfg.ratelimits.length, 'unique namespace ids');
  for (const [name, rule] of Object.entries(LIMITS)) {
    if (rule.edge) assert.ok(EDGE_BINDINGS[rule.edge], name);
    // A binding can only ever be the stricter count: the pre-filter never stops what the binding would let through.
    if (rule.edge && rule.by !== 'session' && rule.by !== 'account') assert.equal(rule.isolate, EDGE_BINDINGS[rule.edge].limit, name);
  }
});

// ---- GET /api/ice -----------------------------------------------------------------------------------

test('GET /api/ice is gone: a guest session gets a 404, and no TURN credentials are ever minted for it', async () => {
  let minted = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    minted++;
    return new Response('{}');
  };
  try {
    const env = makeEnv({ TURN_KEY_ID: 'k', TURN_KEY_TOKEN: 't' });
    const res = await req(env, 'GET', '/api/ice', { bearer: await guestToken() });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, 'not_found');
    assert.equal(minted, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.doesNotMatch(src('../src/index.ts'), /\/api\/ice|LIMIT_ICE/);
});

// ---- per network, across isolates ----------------------------------------------------------------------

test('guests: an IPv6 /64 is one network (fresh addresses in it share one count), counted by the binding too', async () => {
  const env = makeEnv();
  const net = net6();
  let limitedAt = 0;
  for (let i = 1; i <= 121 && limitedAt === 0; i++) {
    const res = await req(env, 'POST', '/api/guest', { ip: `${net}:${i.toString(16)}:0:0:1`, body: {} });
    if (res.status === 429) limitedAt = i;
    else assert.equal(res.status, 200);
  }
  assert.equal(limitedAt, 121, 'the 121st guest of one /64 in a minute, whatever the address in it');
  const bound = fakeBinding(120);
  const env2 = makeEnv({ RL_120: bound });
  const other = net6();
  await req(env2, 'POST', '/api/guest', { ip: `${other}::5`, body: {} });
  await req(env2, 'POST', '/api/guest', { ip: `${other}:ffff:ffff:ffff:ffff`, body: {} });
  const k = other.split(':').slice(0, 4).join(':') + '::/64';
  assert.deepEqual(bound.keys, ['guest:' + k, 'guest:' + k]);
});

test('guests: a whole school behind one IPv4 address gets its sessions (100 in a minute)', async () => {
  const env = makeEnv({ RL_120: fakeBinding(120) });
  const school = ip4();
  for (let i = 0; i < 100; i++) assert.equal((await req(env, 'POST', '/api/guest', { ip: school, body: {} })).status, 200, `guest #${i + 1}`);
});

test('the binding counts what other isolates saw: over it is a 429 even with this isolate fresh; a binding that throws lets the request through', async () => {
  const ip = ip4();
  const seen = new Map([['guest:' + ip, 120]]);
  const env = makeEnv({ RL_120: fakeBinding(120, seen) });
  const res = await req(env, 'POST', '/api/guest', { ip, body: {} });
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, 'rate_limited');
  const broken = makeEnv({ RL_120: { limit: async () => { throw new Error('binding down'); } } });
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    assert.equal((await req(broken, 'POST', '/api/guest', { body: {} })).status, 200);
  } finally {
    console.warn = warn;
  }
});

test('queue: the per-session limit comes before the KV flags, so a refused request reads none', async () => {
  let reads = 0;
  const sub = accountId();
  const token = await guestToken(sub);
  const env = makeEnv({ FLAGS: { get: async () => (reads++, null) }, RL_60: fakeBinding(60, new Map([['queue:' + sub, 60]])) });
  const res = await req(env, 'POST', '/api/queue', { bearer: token, body: { mode: '1v1', kind: 'server' } });
  assert.equal(res.status, 429);
  assert.equal(reads, 0);
});

test('rejoin and leave count per session first, and per network only past a crowd (a match of six on one address rejoins freely)', async () => {
  const env = makeEnv({ RL_60: fakeBinding(60), RL_1200: fakeBinding(1200), MATCH: { idFromString: () => { throw new Error('not one'); } }, ROOM: { idFromString: () => { throw new Error('not one'); } }, MATCHMAKER: { idFromName: (n) => n, get: () => ({ fetch: async () => new Response('{"ok":true}') }) } });
  const ip = ip4();
  for (let p = 0; p < 6; p++) {
    const bearer = await guestToken();
    for (let i = 0; i < 5; i++) {
      const r = await req(env, 'POST', '/api/rejoin', { ip, bearer, body: { matchId: 'ab'.repeat(32) } });
      assert.notEqual(r.status, 429, `player ${p} rejoin ${i}`);
    }
    assert.notEqual((await req(env, 'POST', '/api/leave', { ip, bearer, body: {} })).status, 429);
  }
  assert.ok(env.RL_60.keys.some((k) => k.startsWith('rejoin:')) && env.RL_1200.keys.some((k) => k === 'rejoinNet:' + ip));
  assert.ok(env.RL_60.keys.some((k) => k.startsWith('leave:')) && env.RL_1200.keys.some((k) => k === 'leaveNet:' + ip));
});

test("lobby peek: one network reaches the LobbyDirectoryDO at most 120 times a minute, counted across isolates by the binding (it is not cached like the list)", async () => {
  let dirCalls = 0;
  const LOBBY_DIR = { idFromName: (n) => ({ n }), get: () => ({ fetch: async () => (dirCalls++, new Response(JSON.stringify({ error: 'no_lobby' }), { status: 404 })) }) };
  const bound = fakeBinding(120);
  const env = makeEnv({ LOBBY_DIR, RL_120: bound });
  const ip = ip4();
  const st = {};
  for (let i = 0; i < 300; i++) {
    const res = await req(env, 'GET', '/api/lobbies/peek?code=ABC234', { ip });
    st[res.status] = (st[res.status] ?? 0) + 1;
  }
  assert.deepEqual(st, { 404: 120, 429: 180 }, 'a class opening join links is served; a flood stops at 120');
  assert.equal(dirCalls, 120);
  assert.equal(bound.keys[0], 'lobbyPeek:' + ip);
  // What the location's other isolates counted is enforced too, before the directory.
  const other = ip4();
  const env2 = makeEnv({ LOBBY_DIR, RL_120: fakeBinding(120, new Map([['lobbyPeek:' + other, 120]])) });
  dirCalls = 0;
  assert.equal((await req(env2, 'GET', '/api/lobbies/peek?code=ABC234', { ip: other })).status, 429);
  assert.equal(dirCalls, 0);
  // The list keeps its own, higher rule (it is cached 3 s per region).
  assert.notEqual((await req(env, 'GET', '/api/lobbies?region=SA', { ip })).status, 429);
});

// ---- the account routes, before the AccountsDO ---------------------------------------------------------

test('logout: a cookie that is no refresh token never reaches the AccountsDO (the answer is the same); a real one does', async () => {
  const env = makeEnv();
  for (const junk of ['x', 'y'.repeat(128), 'a'.repeat(42), 'a'.repeat(44), 'a'.repeat(42) + '=']) {
    const res = await req(env, 'POST', '/api/auth/logout', { headers: { Cookie: '__Host-tg_rt=' + junk } });
    assert.equal(res.status, 200, junk);
    assert.deepEqual(await res.json(), { ok: true });
    assert.match(res.headers.get('set-cookie') ?? '', /__Host-tg_rt=;.*Max-Age=0/);
  }
  assert.deepEqual(env.ACCOUNTS.calls, []);
  const res = await req(env, 'POST', '/api/auth/logout', { headers: { Cookie: '__Host-tg_rt=' + 'Ab9_-'.repeat(8) + 'xyz' } });
  assert.equal(res.status, 200);
  assert.deepEqual(env.ACCOUNTS.calls, ['/logout']);
});

test('refresh: a cookie that is no refresh token is 401 bad_refresh with the cookie cleared, as the object answers, without asking it', async () => {
  const env = makeEnv();
  const res = await req(env, 'POST', '/api/auth/refresh', { headers: { Cookie: '__Host-tg_rt=' + 'z'.repeat(100) } });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'bad_refresh');
  assert.match(res.headers.get('set-cookie') ?? '', /__Host-tg_rt=;.*Max-Age=0/);
  assert.deepEqual(env.ACCOUNTS.calls, []);
  const real = await req(env, 'POST', '/api/auth/refresh', { headers: { Cookie: '__Host-tg_rt=' + 'Q'.repeat(43) } });
  assert.equal(real.status, 401, 'the fake object holds no row');
  assert.equal(env.ACCOUNTS.calls.length, 1);
});

test('logout and refresh: limited per network before the object (the binding refuses: no AccountsDO call)', async () => {
  const ip = ip4();
  const seen = new Map([
    ['logout:' + ip, 1200],
    ['refresh:' + ip, 1200],
  ]);
  const env = makeEnv({ RL_1200: fakeBinding(1200, seen) });
  const cookie = { Cookie: '__Host-tg_rt=' + 'Q'.repeat(43) };
  assert.equal((await req(env, 'POST', '/api/auth/logout', { ip, headers: cookie })).status, 429);
  assert.equal((await req(env, 'POST', '/api/auth/refresh', { ip, headers: cookie })).status, 429);
  assert.deepEqual(env.ACCOUNTS.calls, []);
});

let sites = 0;
/** A fresh IPv6 /48 (apart from net6's), and the base of a /64 `n` in it. */
const site48 = () => {
  const s = `2001:470:${(++sites).toString(16)}`;
  return (n) => `${s}:${n.toString(16)}`;
};
const rand = (enc) => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(enc);

test('the site of an address: an IPv6 /48; IPv4, IPv4-mapped and local addresses have none (their network rule counts them)', async () => {
  const { sitePrefix } = await import('../src/limits.ts');
  assert.equal(sitePrefix('2001:470:abcd:5::1'), '2001:470:abcd::/48');
  assert.equal(sitePrefix('2001:0470:ABCD:ffff:1:2:3:4'), '2001:470:abcd::/48');
  assert.equal(sitePrefix('2001:470::1'), '2001:470:0::/48');
  for (const ip of ['100.64.1.9', '::ffff:100.64.1.9', 'local', '']) assert.equal(sitePrefix(ip), null, ip);
});

test('logout and refresh: the /64s of one /48 share 1,200 a minute, so rotating them no longer drives the AccountsDO without limit', async () => {
  for (const path of ['/api/auth/logout', '/api/auth/refresh']) {
    const env = makeEnv({ RL_1200: fakeBinding(1200) });
    const net = site48();
    const st = {};
    // 50 /64s x 30: each /64 far below its own 1,200; a fresh refresh-token-shaped cookie each time.
    for (let n = 1; n <= 50; n++) {
      for (let i = 1; i <= 30; i++) {
        const res = await req(env, 'POST', path, { ip: `${net(n)}::${i.toString(16)}`, headers: { Cookie: '__Host-tg_rt=' + rand('base64url') } });
        st[res.status === 429 ? 'limited' : 'served'] = (st[res.status === 429 ? 'limited' : 'served'] ?? 0) + 1;
      }
    }
    assert.deepEqual(st, { served: 1200, limited: 300 }, path);
    assert.equal(env.ACCOUNTS.calls.length, 1200, path + ': AccountsDO calls');
    assert.ok(env.RL_1200.keys.includes((path.endsWith('logout') ? 'logoutSite:' : 'refreshSite:') + net(1).split(':').slice(0, 3).join(':') + '::/48'), 'counted by the binding too');
    // Another /48 is another site.
    assert.notEqual((await req(env, 'POST', path, { ip: `${site48()(1)}::1`, headers: { Cookie: '__Host-tg_rt=' + rand('base64url') } })).status, 429);
  }
});

test('the sign-in routes of one /48 share 600 a minute (login, register, recover, OAuth start and callback together); IPv4 is not counted by the site', async () => {
  const env = makeEnv({ DISCORD_CLIENT_ID: 'cid', DISCORD_CLIENT_SECRET: 'csecret', RL_120: fakeBinding(120), RL_600: fakeBinding(600) });
  const net = site48();
  const key = () => rand('hex');
  const calls = [
    (ip) => req(env, 'POST', '/api/auth/login', { ip, body: { username: 'kid' + key().slice(0, 6), password: key() } }),
    (ip) => req(env, 'GET', '/api/auth/oauth/discord/start', { ip }),
    (ip) => req(env, 'GET', '/api/auth/oauth/discord/callback?code=x&state=y', { ip }),
    // These two hash a new password each (PBKDF2): a few per /64 keep the test quick.
    (ip) => req(env, 'POST', '/api/auth/register', { ip, body: { username: 'kid' + key().slice(0, 6), password: key() } }),
    (ip) => req(env, 'POST', '/api/auth/recover', { ip, body: { username: 'kid' + key().slice(0, 6), code: 'abcd-efgh-ijkl', password: key() } }),
  ];
  let served = 0;
  let limited = 0;
  // 10 /64s x 70 (two sign-ups, two recoveries, the rest logins and OAuth): each /64 well below
  // its own 120 per route.
  for (let n = 1; n <= 10; n++) {
    for (let i = 1; i <= 70; i++) {
      const route = i === 10 || i === 20 ? 3 : i === 30 || i === 40 ? 4 : i % 3;
      const res = await calls[route](`${net(n)}::${i.toString(16)}`);
      if (res.status === 429) limited++;
      else served++;
    }
  }
  assert.deepEqual({ served, limited }, { served: 600, limited: 100 });
  const school = ip4();
  for (let i = 0; i < 5; i++) await calls[i](school);
  assert.ok(!env.RL_600.keys.some((k) => k.includes(school)), 'an IPv4 address has no site');
});

test("a school behind one IPv4 address: 40 page loads, 20 sign-ins and 10 recoveries in a minute are all served (the table's windows never add to accountRoutes' own)", async () => {
  // accountRoutes.ts keeps main's 'refresh:' / 'login:' / 'recover:' + address in-isolate limits
  // (60, 30, 10); the table's rules of the same name, keyed by the same IPv4 address, must not
  // count into those windows too (that halved them: 30, 15 and 5).
  const env = makeEnv({ RL_120: fakeBinding(120), RL_1200: fakeBinding(1200) });
  const school = ip4();
  const key = () => rand('hex');
  const tally = {};
  const run = async (label, n, path, body) => {
    for (let i = 1; i <= n; i++) {
      const res = await req(env, 'POST', path, { ip: school, headers: { Cookie: '__Host-tg_rt=' + rand('base64url') }, body: body?.() ?? {} });
      tally[label] = (tally[label] ?? 0) + (res.status === 429 ? 0 : 1);
    }
  };
  await run('refresh', 40, '/api/auth/refresh');
  await run('login', 20, '/api/auth/login', () => ({ username: 'kid' + key().slice(0, 6), password: key() }));
  await run('recover', 10, '/api/auth/recover', () => ({ username: 'kid' + key().slice(0, 6), code: 'abcd-efgh-ijkl', password: key() }));
  assert.deepEqual(tally, { refresh: 40, login: 20, recover: 10 }, 'served (not 429) of each');
});

test('GET /api/me and GET /api/ranked/result: 60 a minute per account, the 61st never reaches the object; another account is not affected', async () => {
  for (const path of ['/api/me', '/api/ranked/result?matchId=' + 'cd'.repeat(32)]) {
    const env = makeEnv();
    const bearer = await accountToken();
    for (let i = 1; i <= 60; i++) assert.equal((await req(env, 'GET', path, { bearer })).status, 200, `${path} #${i}`);
    const over = await req(env, 'GET', path, { bearer });
    assert.equal(over.status, 429, path);
    assert.equal(env.ACCOUNTS.calls.length, 60, path);
    assert.equal((await req(env, 'GET', path, { bearer: await accountToken() })).status, 200, 'another account');
  }
});

test('GET /api/me: a hundred accounts behind one IPv4 address are all served', async () => {
  const env = makeEnv({ RL_60: fakeBinding(60), RL_1200: fakeBinding(1200) });
  const school = ip4();
  for (let i = 0; i < 100; i++) assert.equal((await req(env, 'GET', '/api/me', { ip: school, bearer: await accountToken() })).status, 200, `account #${i + 1}`);
});

test("the leaderboard: an account's own row is asked once per 15 s per playlist, and its lookups are limited per account", async () => {
  const env = makeEnv();
  const sub = accountId();
  const bearer = await accountToken(sub);
  const a = await (await req(env, 'GET', '/api/leaderboard?playlist=1v1', { bearer })).json();
  const b = await (await req(env, 'GET', '/api/leaderboard?playlist=1v1', { bearer })).json();
  assert.deepEqual(a.you, { rank: 7, mu: 30 });
  assert.deepEqual(b.you, a.you);
  const you = env.ACCOUNTS.calls.filter((c) => c.includes('userId='));
  assert.deepEqual(you, [`/leaderboard?playlist=1v1&limit=1&userId=${sub}`], 'one lookup for both');
  await req(env, 'GET', '/api/leaderboard?playlist=2v2', { bearer });
  assert.equal(env.ACCOUNTS.calls.filter((c) => c.includes('userId=')).length, 2, 'another playlist is its own row');
  for (let i = 4; i <= 60; i++) await req(env, 'GET', '/api/leaderboard?playlist=1v1', { bearer });
  assert.equal((await req(env, 'GET', '/api/leaderboard?playlist=1v1', { bearer })).status, 429);
  assert.equal((await req(env, 'GET', '/api/leaderboard?playlist=1v1')).status, 200, 'the board without a session is not counted per account');
});

test('password and recovery codes: 10 a minute per account, before the object', async () => {
  for (const path of ['/api/auth/password', '/api/auth/recovery-codes']) {
    const env = makeEnv();
    const bearer = await accountToken();
    for (let i = 1; i <= 10; i++) assert.notEqual((await req(env, 'POST', path, { bearer, body: {} })).status, 429, `${path} #${i}`);
    const before = env.ACCOUNTS.calls.length;
    assert.equal((await req(env, 'POST', path, { bearer, body: {} })).status, 429);
    assert.equal(env.ACCOUNTS.calls.length, before, 'no object call for the 11th');
  }
});

test("sec/account-takeover's routes (reauth, unlink, the devices, tv/info) are gated per account before the object, across isolates too", async () => {
  const { accountGate } = await import('../src/limits.ts');
  assert.deepEqual(accountGate('POST', '/api/auth/reauth'), ['reauth']);
  assert.deepEqual(accountGate('POST', '/api/auth/unlink'), ['unlink']);
  for (const [m, path] of [['GET', '/api/auth/sessions'], ['POST', '/api/auth/sessions/revoke'], ['POST', '/api/auth/sessions/revoke-all']]) assert.deepEqual(accountGate(m, path), ['sessions'], path);
  assert.deepEqual(accountGate('POST', '/api/auth/tv/info'), ['tvInfo']);
  assert.deepEqual(accountGate('GET', '/api/auth/reauth'), [], 'by method');
  // Each route alone: its limit, then a 429 with no object call. Whatever a route answers below it
  // (404 on this branch alone; 400 / 401 / 403 with sec/account-takeover's routes) is no 429.
  for (const [path, n] of [['/api/auth/reauth', 10], ['/api/auth/unlink', 10], ['/api/auth/tv/info', 30]]) {
    const env = makeEnv();
    const bearer = await accountToken();
    for (let i = 1; i <= n; i++) assert.notEqual((await req(env, 'POST', path, { bearer, body: {} })).status, 429, `${path} #${i}`);
    const before = env.ACCOUNTS.calls.length;
    assert.equal((await req(env, 'POST', path, { bearer, body: {} })).status, 429, path);
    assert.equal(env.ACCOUNTS.calls.length, before, 'no object call over the limit: ' + path);
    assert.notEqual((await req(env, 'POST', path, { bearer: await accountToken(), body: {} })).status, 429, 'another account');
  }
  // The devices list and both sign-outs share one count of 30.
  const env = makeEnv();
  const bearer = await accountToken();
  for (let i = 0; i < 10; i++) {
    assert.notEqual((await req(env, 'GET', '/api/auth/sessions', { bearer })).status, 429);
    assert.notEqual((await req(env, 'POST', '/api/auth/sessions/revoke', { bearer, body: {} })).status, 429);
    assert.notEqual((await req(env, 'POST', '/api/auth/sessions/revoke-all', { bearer })).status, 429);
  }
  const before = env.ACCOUNTS.calls.length;
  assert.equal((await req(env, 'GET', '/api/auth/sessions', { bearer })).status, 429);
  assert.equal(env.ACCOUNTS.calls.length, before);
  // Counted by the binding: other isolates' count refuses a fresh isolate's first request.
  const sub = accountId();
  const busy = makeEnv({ RL_10: fakeBinding(10, new Map([['reauth:' + sub, 10]])), RL_30: fakeBinding(30, new Map([['tvInfo:' + sub, 30]])) });
  const b = await accountToken(sub);
  assert.equal((await req(busy, 'POST', '/api/auth/reauth', { bearer: b, body: {} })).status, 429);
  assert.equal((await req(busy, 'POST', '/api/auth/tv/info', { bearer: b, body: {} })).status, 429);
  assert.equal(busy.ACCOUNTS.calls.length, 0);
});

// ---- OAuth ---------------------------------------------------------------------------------------------

test('the OAuth callback: one state cookie is good for one token request; a replay is bad_state and the provider is not asked again', async () => {
  const env = makeEnv({ DISCORD_CLIENT_ID: 'cid', DISCORD_CLIENT_SECRET: 'csecret' });
  const ip = ip4();
  const start = await req(env, 'GET', '/api/auth/oauth/discord/start', { ip });
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const cookie = /__Host-tg_oa=([^;]+)/.exec(start.headers.get('set-cookie'))[1];
  const asked = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    return new Response('{"error":"invalid_grant"}', { status: 400 });
  };
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    const callback = () => req(env, 'GET', `/api/auth/oauth/discord/callback?code=junk&state=${state}`, { ip, headers: { Cookie: '__Host-tg_oa=' + cookie } });
    const first = await callback();
    assert.equal(first.headers.get('location'), '/#auth=error:provider_error');
    for (let i = 0; i < 5; i++) assert.equal((await callback()).headers.get('location'), '/#auth=error:bad_state');
  } finally {
    globalThis.fetch = realFetch;
    console.warn = warn;
  }
  assert.deepEqual(asked, ['https://discord.com/api/v10/oauth2/token'], 'one token request in all');
});

test('the OAuth callback is limited per network before anything else', async () => {
  const ip = ip4();
  const env = makeEnv({ DISCORD_CLIENT_ID: 'cid', DISCORD_CLIENT_SECRET: 'csecret', RL_120: fakeBinding(120, new Map([['oauthCallback:' + ip, 120]])) });
  const res = await req(env, 'GET', '/api/auth/oauth/discord/callback?code=x&state=y', { ip });
  assert.equal(res.status, 429);
});
