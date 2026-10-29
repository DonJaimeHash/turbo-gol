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

