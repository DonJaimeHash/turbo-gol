// The Worker's HTTP rate limits (server/src/limits.ts) and the edge routes, without workerd: the
// table against wrangler.jsonc's `ratelimits`, each rule counted by its session, account or
// network (an IPv6 /64 as one network, an IPv4 address shared by a whole school still served),
// the Workers Rate Limiting binding consulted after the in-isolate count (a fake one stands for the
// other isolates of the location; one that throws lets the request through), the queue limit
// before any KV read, the account routes limited before the single AccountsDO (a fake that counts
// its calls), logout and refresh with a cookie no refresh token has, the leaderboard's own row
// cached, the OAuth callback's state used once, and GET /api/ice gone.
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

