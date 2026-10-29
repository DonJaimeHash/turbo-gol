// The Worker's /nodes/* routes (server/src/nodeRoutes.ts, dispatched by server/src/index.ts) without
// workerd: the route matrix, the release keys (path traversal included), the channel, the account
// and trust checks of the operator and maintainer routes, the headers the Worker overwrites, the
// limits, the cron's one call, and the Worker in front of a real NodeRegistryDO on node:sqlite.
// 'cloudflare:workers' and MatchDO's wasm are stubbed by the resolve hook (match.test.mjs). Run
// from server/: npm test
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

// The control plane's auth timer (10 s) must never keep the test process alive.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  const t = realSetTimeout(fn, ms, ...args);
  t.unref?.();
  return t;
};

const worker = (await import('../src/index.ts')).default;
const { NodeRegistryDO, REPLAY_MAX_BYTES } = await import('../src/NodeRegistryDO.ts');
const { INTERNAL_HEADER, internalSecret, signJwt, createSession } = await import('../src/auth.ts');
const { generateEd25519 } = await import('../../nodes/shared/edcrypto.ts');

const SECRET = 'node-routes-test-secret';
const RealResponse = globalThis.Response;
globalThis.Response = class Response extends RealResponse {
  constructor(body, init) {
    if (init && init.status === 101) {
      super(body, { ...init, status: 200 });
      this.upgraded = true;
      this.webSocket = init.webSocket;
    } else super(body, init);
  }
};

/** The object's log lines (nodeRegistry.test.mjs checks them); NODELOG=1 prints them. */
const realLog = console.log;
console.log = (...args) => {
  if (process.env.NODELOG) realLog(...args);
};

const PROJECT = 'a1b2c3d4e5f60718';
const PLAYER = '0123456789abcdef';
const ORIGIN = 'https://turbo-gol.com';
const CONTROL = await generateEd25519();
const secret = await internalSecret(SECRET);
const enc = new TextEncoder();

/**
 * An R2 bucket in memory; `asked` records every key looked up, `bodies` every body handed out. A
 * get with `onlyIf` (Headers) whose If-None-Match is the object's ETag answers it without a body, as R2 does.
 */
function bucket(files = {}) {
  const objects = new Map(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? enc.encode(v) : v]));
  const asked = [];
  const bodies = [];
  const meta = (k, b) => ({ key: k, size: b.byteLength, httpEtag: `"etag-${k.length}-${b.byteLength}"` });
  return {
    objects,
    asked,
    bodies,
    async get(k, opts) {
      asked.push(k);
      const b = objects.get(k);
      if (b && opts?.onlyIf instanceof Headers && opts.onlyIf.get('if-none-match') === meta(k, b).httpEtag) return meta(k, b);
      if (b) bodies.push(k);
      return b ? { ...meta(k, b), body: new Blob([b]).stream(), text: async () => new TextDecoder().decode(b), arrayBuffer: async () => b.slice().buffer } : null;
    },
    async head(k) {
      asked.push(k);
      const b = objects.get(k);
      return b ? meta(k, b) : null;
    },
    async put(k, v) {
      objects.set(k, typeof v === 'string' ? enc.encode(v) : new Uint8Array(v));
    },
    async delete(k) {
      for (const key of Array.isArray(k) ? k : [k]) objects.delete(key);
    },
  };
}

const RELEASES = {
  'channel.json': JSON.stringify({ stable: '0.2.0', minimum: '0.2.0', canary: '0.3.0', note: 'dropped' }),
  'launcher.mjs': 'export {}',
  'launcher.mjs.sig': 'c2ln',
  'install.sh': '#!/bin/bash\n',
  '0.2.0/manifest.json': '{"version":"0.2.0"}',
  '0.2.0/manifest.sig': 'c2ln',
  '0.2.0/node.mjs': 'export {}',
  '0.2.0/rocketsim.wasm': new Uint8Array([0, 97, 115, 109]),
  '0.2.0/index.html': '<script>alert(1)</script>',
  secret: 'never served without its key',
};

/** NODES whose one object answers with `handler(request)`; `seen` records each forwarded request. */
function nodesNs(handler = () => new RealResponse('{"ok":true}', { headers: { 'content-type': 'application/json' } })) {
  const seen = [];
  const ns = {
    seen,
    handler,
    idFromName: (name) => ({ name }),
    get: (id, opts) => ({
      fetch: async (req) => {
        seen.push({ id, opts, req, path: new URL(req.url).pathname, headers: Object.fromEntries(req.headers) });
        return ns.handler(req);
      },
    }),
  };
  return ns;
}

function makeEnv(over = {}) {
  return {
    JWT_SECRET: SECRET,
    VITE_ORIGINS: ORIGIN,
    FLAGS: { get: async () => null },
    NODES: nodesNs(),
    NODE_REPLAYS: bucket(),
    NODE_RELEASES: bucket(RELEASES),
    NODE_CONTROL_PRIVATE_KEY: CONTROL.privateKey,
    NODE_CONTROL_PUBLIC_KEY: CONTROL.publicKey,
    NODE_TRUSTED_OPERATORS: PROJECT,
    NODES_PUBLIC_BASE: ORIGIN,
    ...over,
  };
}

let ipCount = 0;
/** A fresh client address: the Worker's limits are per isolate, and this file is one isolate. */
const freshIp = () => `198.51.100.${++ipCount}`;

async function req(env, method, path, { headers = {}, body, ip = freshIp() } = {}) {
  const res = await worker.fetch(new Request(ORIGIN + path, { method, headers: { 'CF-Connecting-IP': ip, Origin: ORIGIN, ...headers }, body }), env);
  return res;
}

async function jsonOf(res) {
  return JSON.parse(await res.text());
}

// aat: signed in just now (Security 3: the maintainer routes need a fresh sign-in; takeover.test.mjs).
const accountToken = (sub, name = 'Proyecto') => signJwt(SECRET, { sub, name, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, acct: 1, aat: Math.floor(Date.now() / 1000) });

// ---- whoami, releases, channel -------------------------------------------------------------------

test('whoami answers the caller’s address as compact JSON, uncached, without the object', async () => {
  const env = makeEnv();
  const res = await req(env, 'GET', '/nodes/whoami', { ip: '203.0.113.9' });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '{"ip":"203.0.113.9"}', 'install.sh parses "ip":"..." out of it');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('access-control-allow-origin'), null, 'no CORS outside tokens, mine and status');
  assert.equal(env.NODES.seen.length, 0);
});

test('releases: types by extension, a version’s files immutable, root files revalidated by ETag, HEAD without a body', async () => {
  const env = makeEnv();
  const cases = [
    ['launcher.mjs', 'text/javascript; charset=utf-8', 'no-cache'],
    ['launcher.mjs.sig', 'text/plain; charset=utf-8', 'no-cache'],
    ['install.sh', 'text/plain; charset=utf-8', 'no-cache'],
    ['0.2.0/manifest.json', 'application/json', 'public, max-age=31536000, immutable'],
    ['0.2.0/manifest.sig', 'text/plain; charset=utf-8', 'public, max-age=31536000, immutable'],
    ['0.2.0/node.mjs', 'text/javascript; charset=utf-8', 'public, max-age=31536000, immutable'],
    ['0.2.0/rocketsim.wasm', 'application/wasm', 'public, max-age=31536000, immutable'],
    ['0.2.0/index.html', 'application/octet-stream', 'public, max-age=31536000, immutable'],
  ];
  for (const [key, type, cache] of cases) {
    const res = await req(env, 'GET', '/nodes/releases/' + key);
    assert.equal(res.status, 200, key);
    assert.equal(res.headers.get('content-type'), type, key);
    assert.equal(res.headers.get('cache-control'), cache, key);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), env.NODE_RELEASES.objects.get(key), key);
  }
  const first = await req(env, 'GET', '/nodes/releases/launcher.mjs');
  const etag = first.headers.get('etag');
  assert.ok(etag);
  const again = await req(env, 'GET', '/nodes/releases/launcher.mjs', { headers: { 'If-None-Match': etag } });
  assert.equal(again.status, 304);
  const head = await req(env, 'HEAD', '/nodes/releases/install.sh');
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(RELEASES['install.sh'].length));
  assert.equal(await head.text(), '');
  assert.equal((await req(env, 'GET', '/nodes/releases/0.9.9/node.mjs')).status, 404);
  assert.equal((await req(env, 'POST', '/nodes/releases/launcher.mjs')).status, 404, 'read only');
  assert.equal(env.NODES.seen.length, 0);
});

test('releases: only an allowed key reaches the bucket; traversal, listings and odd names are 404', async () => {
  const env = makeEnv();
  const asked = env.NODE_RELEASES.asked;
  const bad = [
    '', // the listing
    '0.2.0/', // a version's listing
    'a..b',
    '..%2Fsecret',
    '0.2.0%2F..%2Fsecret',
    '0.2.0%2f..%2fsecret',
    '%2e%2e%2fsecret',
    '.hidden',
    '0.2/node.mjs',
    '0.2.0/sub/node.mjs',
    'x'.repeat(65),
    '9'.repeat(5000) + '.0.0/node.mjs', // past R2's 1,024-byte key limit
    '1234567.0.0/node.mjs',
    '%ZZ',
    'launcher.mjs%00',
    'install.sh%0A',
  ];
  for (const key of bad) {
    const res = await req(env, 'GET', '/nodes/releases/' + key);
    assert.equal(res.status, 404, JSON.stringify(key));
  }
  // The URL parser resolves dot segments, encoded ones too, before any route sees them.
  for (const path of ['/nodes/releases/../secret', '/nodes/releases/%2e%2e/secret', '/nodes/releases/0.2.0/../../secret', '/nodes/releases']) {
    assert.equal((await req(env, 'GET', path)).status, 404, path);
  }
  assert.deepEqual(asked, [], 'never asked for anything but an allowed key');
  assert.equal((await req(env, 'GET', '/nodes/releases/secret')).status, 200, 'a plain root key is allowed (the bucket only holds releases)');
});

test('the channel: its own route (and channel.json), { stable, minimum } only, no-store; a bad or missing one is refused', async () => {
  const env = makeEnv();
  for (const key of ['channel', 'channel.json']) {
    const res = await req(env, 'GET', '/nodes/releases/' + key);
    assert.equal(res.status, 200);
    assert.deepEqual(await jsonOf(res), { stable: '0.2.0', minimum: '0.2.0' });
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
  const head = await req(env, 'HEAD', '/nodes/releases/channel');
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  // Each on a bucket of its own: an isolate keeps the answer of one for CHANNEL_TTL_MS (the next test).
  for (const body of ['{"stable":"0.2.0"}', '{"stable":"0.2","minimum":"0.2.0"}', '{"stable":"0.2.0-rc1","minimum":"0.2.0"}', 'not json', '[]']) {
    const res = await req(makeEnv({ NODE_RELEASES: bucket({ 'channel.json': body }) }), 'GET', '/nodes/releases/channel');
    assert.equal(res.status, 503, body);
    assert.equal((await jsonOf(res)).error, 'bad_channel');
  }
  assert.equal((await req(makeEnv({ NODE_RELEASES: bucket({}) }), 'GET', '/nodes/releases/channel')).status, 404);
});

test('the channel is read from R2 once per 30 s per isolate, whoever asks; a new one shows once that passed', async () => {
  const env = makeEnv();
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    for (let i = 0; i < 20; i++) assert.deepEqual(await jsonOf(await req(env, 'GET', '/nodes/releases/channel')), { stable: '0.2.0', minimum: '0.2.0' });
    assert.equal(env.NODE_RELEASES.asked.length, 1, 'one R2 read for twenty launchers');
    await env.NODE_RELEASES.put('channel.json', JSON.stringify({ stable: '0.3.0', minimum: '0.2.0' }));
    now += 30_001;
    assert.deepEqual(await jsonOf(await req(env, 'GET', '/nodes/releases/channel')), { stable: '0.3.0', minimum: '0.2.0' });
    assert.equal(env.NODE_RELEASES.asked.length, 2);
  } finally {
    Date.now = realNow;
  }
});

test('releases: a version file comes from the edge cache after its first copy (no R2 read), 304 and HEAD from it too; a root file revalidates without a body read', async () => {
  const store = new Map();
  const realCaches = globalThis.caches;
  globalThis.caches = {
    default: {
      async match(k) {
        const r = store.get(String(k));
        return r ? r.clone() : undefined;
      },
      async put(k, r) {
        store.set(String(k), new RealResponse(await r.arrayBuffer(), r));
      },
    },
  };
  try {
    const env = makeEnv();
    const waits = [];
    const ctx = { waitUntil: (p) => waits.push(p) };
    const get = (path, headers = {}, method = 'GET') => worker.fetch(new Request(ORIGIN + path, { method, headers: { 'CF-Connecting-IP': freshIp(), ...headers } }), env, ctx);
    const first = await get('/nodes/releases/0.2.0/node.mjs');
    assert.equal(await first.text(), 'export {}');
    await Promise.all(waits);
    const etag = first.headers.get('etag');
    const second = await get('/nodes/releases/0.2.0/node.mjs?x=1');
    assert.equal(await second.text(), 'export {}');
    assert.equal(second.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal((await get('/nodes/releases/0.2.0/node.mjs', { 'If-None-Match': etag })).status, 304);
    const head = await get('/nodes/releases/0.2.0/node.mjs', {}, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.deepEqual(env.NODE_RELEASES.asked, ['0.2.0/node.mjs'], 'one R2 read in all');
    const root = await get('/nodes/releases/launcher.mjs');
    await root.text();
    const again = await get('/nodes/releases/launcher.mjs', { 'If-None-Match': root.headers.get('etag') });
    assert.equal(again.status, 304);
    assert.deepEqual(env.NODE_RELEASES.bodies, ['0.2.0/node.mjs', 'launcher.mjs'], 'the 304 read no body');
    assert.equal(store.has(ORIGIN + '/nodes/releases/launcher.mjs'), false, 'a root file is not kept at the edge');
  } finally {
    globalThis.caches = realCaches;
  }
});

test('releases and the channel: limited per network before R2 (the binding refuses: no bucket read)', async () => {
  const ip = freshIp();
  const env = makeEnv({ RL_1200: { limit: async ({ key }) => ({ success: key !== 'nodeReleases:' + ip }) } });
  for (const path of ['/nodes/releases/channel', '/nodes/releases/0.2.0/node.mjs', '/nodes/releases/install.sh']) {
    assert.equal((await req(env, 'GET', path, { ip })).status, 429, path);
  }
  assert.deepEqual(env.NODE_RELEASES.asked, []);
  assert.equal((await req(env, 'GET', '/nodes/releases/install.sh')).status, 200, 'another network');
});

// ---- what is not served ------------------------------------------------------------------------------

test('no /dev/*, no WebRTC signaling, nothing unknown: 404, and the object never hears of them', async () => {
  const env = makeEnv();
  const routes = [
    ['POST', '/dev/login'],
    ['POST', '/dev/match'],
    ['GET', '/dev/outcome/' + 'ab'.repeat(32)],
    ['POST', '/nodes/dev/login'],
    ['POST', `/nodes/rtc/${'a'.repeat(16)}/${'ab'.repeat(32)}/ice`],
    ['POST', `/nodes/rtc/${'a'.repeat(16)}/${'ab'.repeat(32)}/offer`],
    ['GET', '/nodes/inventory'],
    ['GET', '/nodes/'],
    ['GET', '/nodes/register'],
    ['DELETE', '/nodes/replays/' + 'ab'.repeat(32)],
    ['GET', '/nodes/replays/abc'],
    ['PUT', '/nodes/replays/' + 'AB'.repeat(32)],
  ];
  for (const [method, path] of routes) assert.equal((await req(env, method, path)).status, 404, `${method} ${path}`);
  // The shop's aliases are AccountsDO's (hostShop.test.mjs): an account session first, never the object.
  assert.equal((await req(env, 'GET', '/nodes/shop')).status, 401);
  assert.equal((await req(env, 'POST', '/nodes/shop/claim', { body: '{}' })).status, 401);
  assert.equal(env.NODES.seen.length, 0);
});

test('without the node settings (a fork, local dev) every route that needs the object is a 404; whoami and the releases still answer', async () => {
  const env = makeEnv({ NODE_CONTROL_PRIVATE_KEY: undefined });
  assert.equal((await req(env, 'POST', '/nodes/register', { body: '{}' })).status, 404);
  assert.equal((await req(env, 'GET', '/nodes/connect', { headers: { Upgrade: 'websocket' } })).status, 404);
  assert.equal((await req(env, 'GET', '/nodes/status')).status, 404);
  assert.equal((await req(env, 'GET', '/nodes/whoami')).status, 200);
  assert.equal((await req(env, 'GET', '/nodes/releases/channel')).status, 200);
  assert.equal(env.NODES.seen.length, 0);
});

// ---- forwarded routes --------------------------------------------------------------------------------

test('register: to nodes-v1 near São Paulo with the internal header and the caller’s address; a forged one is overwritten; 5 an hour per address, as in the object', async () => {
  const env = makeEnv();
  const ip = freshIp();
  const res = await req(env, 'POST', '/nodes/register', { ip, body: '{"token":"tgn1_x"}', headers: { 'content-type': 'application/json', 'x-client-ip': '1.2.3.4', 'x-operator-id': PROJECT, [INTERNAL_HEADER]: 'forged' } });
  assert.equal(res.status, 200);
  const [seen] = env.NODES.seen;
  assert.deepEqual([seen.id, seen.opts, seen.path, seen.req.method], [{ name: 'nodes-v1' }, { locationHint: 'sam' }, '/nodes/register', 'POST']);
  assert.equal(seen.headers['x-client-ip'], ip);
  assert.equal(seen.headers[INTERNAL_HEADER], secret);
  assert.equal(seen.headers['x-operator-id'], undefined, 'only the headers a node sends get through');
  assert.equal(seen.headers['cf-connecting-ip'], undefined);
  assert.equal(await seen.req.text(), '{"token":"tgn1_x"}');
  for (let i = 1; i < 5; i++) assert.equal((await req(env, 'POST', '/nodes/register', { ip, body: '{}' })).status, 200);
  assert.equal((await req(env, 'POST', '/nodes/register', { ip, body: '{}' })).status, 429);
  assert.equal(env.NODES.seen.length, 5);
  const big = await req(env, 'POST', '/nodes/register', { headers: { 'content-length': '4097' } });
  assert.equal(big.status, 413, 'over 4 KB declared');
  assert.equal(env.NODES.seen.length, 5, 'refused before the object');
});

test('per-address limits count an IPv6 /64 as one address: a subscriber cannot step past them with fresh addresses', async () => {
  const env = makeEnv();
  const in64 = (i) => `2001:db8:a:b:${i.toString(16)}::1`;
  for (let i = 1; i <= 5; i++) assert.equal((await req(env, 'POST', '/nodes/register', { ip: in64(i), body: '{}' })).status, 200);
  const sixth = await req(env, 'POST', '/nodes/register', { ip: in64(6), body: '{}' });
  assert.equal(sixth.status, 429);
  assert.equal(env.NODES.seen.at(-1).headers['x-client-ip'], in64(5), 'the object still hears the full address');
  assert.equal((await req(env, 'POST', '/nodes/register', { ip: '2001:db8:a:c::1', body: '{}' })).status, 200, 'another /64');
  for (let i = 1; i <= 30; i++) await req(env, 'GET', '/nodes/connect', { ip: in64(100 + i), headers: { Upgrade: 'websocket' } });
  assert.equal((await req(env, 'GET', '/nodes/connect', { ip: in64(200), headers: { Upgrade: 'websocket' } })).status, 429);
});

test('connect: an upgrade only (426), its 101 passed through as the object made it; 30 a minute per address', async () => {
  const env = makeEnv();
  const upgraded = new Response(null, { status: 101, webSocket: { fake: true } });
  env.NODES.handler = () => upgraded;
  assert.equal((await req(env, 'GET', '/nodes/connect')).status, 426);
  const ip = freshIp();
  const res = await req(env, 'GET', '/nodes/connect', { ip, headers: { Upgrade: 'websocket', 'Sec-WebSocket-Key': 'k', 'Sec-WebSocket-Version': '13' } });
  assert.equal(res, upgraded, 'not re-wrapped');
  const [seen] = env.NODES.seen;
  assert.deepEqual([seen.headers.upgrade, seen.headers['sec-websocket-key'], seen.headers[INTERNAL_HEADER]], ['websocket', 'k', secret]);
  for (let i = 1; i < 30; i++) await req(env, 'GET', '/nodes/connect', { ip, headers: { Upgrade: 'websocket' } });
  assert.equal((await req(env, 'GET', '/nodes/connect', { ip, headers: { Upgrade: 'websocket' } })).status, 429);
});

test('connect: the object hears the caller address (x-client-ip, a forged one overwritten); the limits are counted on the bindings, per /64 and per /48', async () => {
  const env = makeEnv();
  env.NODES.handler = () => new Response(null, { status: 101, webSocket: { fake: true } });
  const ip = '2001:db8:77:1::9';
  await req(env, 'GET', '/nodes/connect', { ip, headers: { Upgrade: 'websocket', 'x-client-ip': '1.2.3.4' } });
  assert.equal(env.NODES.seen.at(-1).headers['x-client-ip'], ip);
  const keys = [];
  const refused = makeEnv({
    RL_30: { limit: async ({ key }) => (keys.push(key), { success: key !== 'nodeConnect:2001:db8:77:2::/64' }) },
    RL_1200: { limit: async ({ key }) => (keys.push(key), { success: key !== 'nodeConnectWide:2001:db8:78::/48' }) },
  });
  assert.notEqual((await req(refused, 'GET', '/nodes/connect', { ip: '2001:db8:77:1::9', headers: { Upgrade: 'websocket' } })).status, 429);
  assert.equal((await req(refused, 'GET', '/nodes/connect', { ip: '2001:db8:77:2::9', headers: { Upgrade: 'websocket' } })).status, 429, 'over its /64');
  assert.equal((await req(refused, 'GET', '/nodes/connect', { ip: '2001:db8:78:5::9', headers: { Upgrade: 'websocket' } })).status, 429, 'over its /48');
  assert.equal(refused.NODES.seen.length, 1, 'the refused ones never reach the object');
  assert.deepEqual(keys.slice(0, 2), ['nodeConnect:2001:db8:77:1::/64', 'nodeConnectWide:2001:db8:77::/48']);
});

test('replays: a 64-hex id; the node’s signed headers and the body go through; 413 past 16 MiB before the object; 60 uploads and 60 downloads a minute per address', async () => {
  const env = makeEnv();
  env.NODES.handler = async (r) => new RealResponse(JSON.stringify({ got: (await r.arrayBuffer()).byteLength }), { headers: { 'content-type': 'application/json' } });
  const id = 'ab'.repeat(32);
  const node = { 'x-node-id': 'f'.repeat(16), 'x-node-ts': '1', 'x-node-sig': 'sig', 'x-replay-sha256': 'c'.repeat(64), 'content-type': 'application/octet-stream' };
  const ip = freshIp();
  const res = await req(env, 'PUT', '/nodes/replays/' + id, { ip, headers: node, body: new Uint8Array(1000) });
  assert.deepEqual(await jsonOf(res), { got: 1000 });
  const [seen] = env.NODES.seen;
  for (const k of Object.keys(node)) assert.equal(seen.headers[k], node[k], k);
  const big = await req(env, 'PUT', '/nodes/replays/' + id, { ip, headers: { ...node, 'content-length': String(REPLAY_MAX_BYTES + 1) } });
  assert.equal(big.status, 413);
  assert.equal(env.NODES.seen.length, 1, 'refused before the object');
  const get = await req(env, 'GET', '/nodes/replays/' + id, { ip, headers: node });
  assert.equal(get.status, 200);
  assert.equal(env.NODES.seen[1].req.method, 'GET');
  for (let i = 1; i < 60; i++) await req(env, 'PUT', '/nodes/replays/' + id, { ip, headers: node, body: new Uint8Array(1) });
  assert.equal((await req(env, 'PUT', '/nodes/replays/' + id, { ip, headers: node, body: new Uint8Array(1) })).status, 429);
  assert.equal((await req(env, 'GET', '/nodes/replays/' + id, { ip, headers: node })).status, 200, 'downloads are counted apart');
  for (let i = 2; i < 60; i++) await req(env, 'GET', '/nodes/replays/' + id, { ip, headers: node });
  const forwarded = env.NODES.seen.length;
  assert.equal((await req(env, 'GET', '/nodes/replays/' + id, { ip, headers: node })).status, 429, 'the 61st download in a minute');
  assert.equal(env.NODES.seen.length, forwarded, 'stopped before the object');
});

test('tokens: 401 without a session, 403 for a guest, 403 not_trusted for another account, forwarded for a trusted one with the operator headers overwritten; CORS on every answer', async () => {
  const env = makeEnv();
  env.NODES.handler = () => new RealResponse('{"token":"tgn1_x"}', { headers: { 'content-type': 'application/json' } });
  const body = JSON.stringify({ region: 'SA' });
  const ask = (auth, extra = {}) => req(env, 'POST', '/nodes/tokens', { body, headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer ' + auth } : {}), ...extra } });
  const guest = (await createSession(SECRET, PROJECT, 'Proyecto')).token;
  const cases = [
    [null, 401, 'unauthorized'],
    ['not.a.jwt', 401, 'unauthorized'],
    [guest, 403, 'account_required'],
    [await accountToken(PLAYER, 'Jugador'), 403, 'not_trusted'],
  ];
  for (const [auth, status, code] of cases) {
    const res = await ask(auth);
    assert.deepEqual([res.status, (await jsonOf(res)).error], [status, code], code);
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  }
  assert.equal(env.NODES.seen.length, 0);
  const res = await ask(await accountToken(PROJECT, 'Proyecto Ñandú'), { 'x-operator-id': PLAYER, 'x-operator-name': 'Mallory' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  const [seen] = env.NODES.seen;
  assert.equal(seen.path, '/nodes/tokens');
  assert.equal(seen.headers['x-operator-id'], PROJECT);
  assert.equal(seen.headers['x-operator-name'], encodeURIComponent('Proyecto Ñandú'));
  assert.equal(await seen.req.text(), body);
  const big = await ask(await accountToken(PROJECT, 'Proyecto'), { 'content-length': '4097' });
  assert.equal(big.status, 413);
  assert.equal(big.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(env.NODES.seen.length, 1, 'refused before the object');
  const pre = await req(env, 'OPTIONS', '/nodes/tokens', { headers: { 'Access-Control-Request-Method': 'POST' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-headers'), 'authorization, content-type');
});

test('mine: an account session, forwarded with the caller’s id, 30 a minute per account; status: public and cached 10 s; both with CORS', async () => {
  const env = makeEnv();
  env.NODES.handler = (r) => new RealResponse(JSON.stringify({ path: new URL(r.url).pathname }), { headers: { 'content-type': 'application/json' } });
  assert.equal((await req(env, 'GET', '/nodes/mine')).status, 401);
  const mine = await req(env, 'GET', '/nodes/mine', { headers: { authorization: 'Bearer ' + (await accountToken(PLAYER, 'Jugador')) } });
  assert.equal(mine.status, 200);
  assert.equal(env.NODES.seen[0].headers['x-operator-id'], PLAYER);
  assert.equal(mine.headers.get('access-control-allow-origin'), ORIGIN);
  const auth = { authorization: 'Bearer ' + (await accountToken(PLAYER, 'Jugador')) };
  for (let i = 1; i < 30; i++) assert.equal((await req(env, 'GET', '/nodes/mine', { headers: auth })).status, 200);
  assert.equal((await req(env, 'GET', '/nodes/mine', { headers: auth })).status, 429, 'from any address');
  env.NODES.seen.length = 0;
  const s1 = await req(env, 'GET', '/nodes/status');
  const s2 = await req(env, 'GET', '/nodes/status');
  assert.deepEqual([await jsonOf(s1), await jsonOf(s2)], [{ path: '/nodes/status' }, { path: '/nodes/status' }]);
  assert.equal(env.NODES.seen.length, 1, 'the second status came from the cache');
  assert.equal(s2.headers.get('cache-control'), 'public, max-age=10');
  assert.equal(s2.headers.get('access-control-allow-origin'), ORIGIN);
});

// ---- the maintainers' routes and the cron ------------------------------------------------------------

/** Another account of the project: this file's limits are one isolate's, and the admin test spends this one's. */
const MAINTAINER = 'b1b2c3d4e5f60718';

test('admin: 401 without a session, 403 for a guest and for any other account, forwarded for a trusted one (the inventory routes too) with the operator headers overwritten; 30 a minute per account; no CORS', async () => {
  const env = makeEnv({ NODE_TRUSTED_OPERATORS: `${PROJECT},${MAINTAINER}` });
  env.NODES.handler = (r) => new RealResponse(JSON.stringify({ path: new URL(r.url).pathname, method: r.method }), { headers: { 'content-type': 'application/json' } });
  const ask = (method, what, auth, { body, headers = {} } = {}) => req(env, method, '/nodes/admin/' + what, { body, headers: { ...(auth ? { authorization: 'Bearer ' + auth } : {}), ...headers } });
  const guest = (await createSession(SECRET, MAINTAINER, 'Proyecto')).token;
  for (const [auth, status, code] of [
    [null, 401, 'unauthorized'],
    [guest, 403, 'account_required'],
    [await accountToken(PLAYER, 'Jugador'), 403, 'not_trusted'],
  ]) {
    const res = await ask('POST', 'drain', auth, { body: '{}' });
    assert.deepEqual([res.status, (await jsonOf(res)).error], [status, code], code);
  }
  assert.equal(env.NODES.seen.length, 0);
  const auth = await accountToken(MAINTAINER, 'Proyecto Ñandú');
  const body = JSON.stringify({ nodeId: 'ab'.repeat(8), status: 'suspended', reason: 'x' });
  const forwards = [['GET', 'nodes'], ['POST', 'status'], ['POST', 'drain'], ['POST', 'update'], ['POST', 'reprobe'], ['POST', 'grant'], ['POST', 'revoke'], ['POST', 'unfreeze']];
  for (const [m, w] of forwards) {
    const res = await ask(m, w, auth, { body: m === 'POST' ? body : undefined, headers: { 'x-operator-id': PLAYER, 'x-operator-name': 'Mallory' } });
    assert.deepEqual([res.status, await jsonOf(res)], [200, { path: '/nodes/admin/' + w, method: m }], w);
    assert.equal(res.headers.get('access-control-allow-origin'), null, 'for curl and same-origin pages: no CORS');
  }
  const seen = env.NODES.seen.at(-1);
  assert.deepEqual([seen.id, seen.opts], [{ name: 'nodes-v1' }, { locationHint: 'sam' }]);
  assert.equal(seen.headers['x-operator-id'], MAINTAINER);
  assert.equal(seen.headers['x-operator-name'], encodeURIComponent('Proyecto Ñandú'));
  assert.equal(seen.headers[INTERNAL_HEADER], secret);
  assert.equal(await seen.req.text(), body);
  const forwarded = env.NODES.seen.length;
  for (const [m, w] of [['POST', 'nodes'], ['GET', 'drain'], ['GET', 'grant'], ['POST', 'reboot'], ['POST', 'toString'], ['GET', '']]) assert.equal((await ask(m, w, auth)).status, 404, `${m} /nodes/admin/${w}`);
  assert.equal((await ask('POST', 'status', auth, { body, headers: { 'content-length': '4097' } })).status, 413);
  assert.equal(env.NODES.seen.length, forwarded, 'none of these reached the object');
  for (let i = forwards.length; i < 30; i++) assert.equal((await ask('GET', 'nodes', auth)).status, 200);
  assert.equal((await ask('GET', 'nodes', auth)).status, 429, 'the 31st in a minute');
});

test('the cron: one call to the object, with the internal header; never a throw; nothing at all without the node settings', async () => {
  const run = async (env) => {
    const waits = [];
    await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() }, env, { waitUntil: (p) => waits.push(p), passThroughOnException() {} });
    await Promise.all(waits);
  };
  const env = makeEnv();
  env.NODES.handler = () => new RealResponse('{"probed":1,"problems":0}', { headers: { 'content-type': 'application/json' } });
  await run(env);
  assert.equal(env.NODES.seen.length, 1, 'one call a run');
  const [s] = env.NODES.seen;
  assert.deepEqual([s.path, s.req.method, s.headers[INTERNAL_HEADER], s.id, s.opts], ['/internal/health', 'POST', secret, { name: 'nodes-v1' }, { locationHint: 'sam' }]);
  for (const over of [{ NODE_CONTROL_PRIVATE_KEY: undefined }, { NODE_RELEASES: undefined }, { NODES_PUBLIC_BASE: undefined }, { JWT_SECRET: undefined }]) {
    const off = makeEnv(over);
    await run(off);
    assert.equal(off.NODES.seen.length, 0, Object.keys(over)[0]);
  }
  await run(makeEnv({ NODES: undefined }));
  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args.map(String).join(' '));
  try {
    env.NODES.handler = () => new RealResponse('{"error":"nodes_unavailable"}', { status: 503 });
    await run(env);
    env.NODES.handler = () => {
      throw new Error('object reset');
    };
    await run(env);
  } finally {
    console.error = realError;
  }
  assert.deepEqual(errors, ['nodes health check: 503 {"error":"nodes_unavailable"}', 'nodes health check failed Error: object reset']);
});

// ---- the Worker in front of a real NodeRegistryDO ----------------------------------------------------

class FakeSocket {
  constructor() {
    this.readyState = 1;
    this.sent = [];
  }
  send(text) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.readyState = 3;
  }
  serializeAttachment() {}
  deserializeAttachment() {
    return null;
  }
}
globalThis.WebSocketPair = class WebSocketPair {
  constructor() {
    this[0] = new FakeSocket();
    this[1] = new FakeSocket();
  }
};

function realRegistry(env) {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(query, ...bindings) {
      const stmt = db.prepare(query);
      const rows = /^\s*(SELECT|WITH)/i.test(query) ? stmt.all(...bindings) : (stmt.run(...bindings), []);
      return { toArray: () => rows.map((r) => ({ ...r })) };
    },
  };
  const sockets = [];
  let alarm = null;
  const ctx = {
    storage: { sql, transactionSync: (fn) => fn(), getAlarm: async () => alarm, setAlarm: async (t) => void (alarm = t), deleteAlarm: async () => void (alarm = null) },
    blockConcurrencyWhile: (fn) => fn(),
    acceptWebSocket: (ws) => sockets.push(ws),
    getWebSockets: () => sockets.filter((w) => w.readyState === 1),
    waitUntil: () => undefined,
  };
  const obj = new NodeRegistryDO(ctx, env);
  return { obj, sockets };
}

test('end to end: a trusted account mints a token, the installer registers with it and the node opens its control socket', async () => {
  const env = makeEnv();
  const reg = realRegistry(env);
  env.NODES.handler = (r) => reg.obj.fetch(r);
  const t = await req(env, 'POST', '/nodes/tokens', { body: JSON.stringify({ region: 'SA', name: 'sao-paulo-1' }), headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (await accountToken(PROJECT)) } });
  assert.equal(t.status, 200);
  const token = await jsonOf(t);
  assert.equal(token.install.linux, `curl -fsSL ${ORIGIN}/nodes/releases/install.sh | sudo bash -s -- --control ${ORIGIN} --token ${token.token}`);
  const keys = await generateEd25519();
  const build = { version: '0.2.0', protocol: 1, wasmSha256: 'a'.repeat(64) };
  const capacity = { matches: 4, cpuMsPerMatchSecond: 1, memMBPerMatch: 20, uplinkMbps: null, source: 'bench' };
  const r = await req(env, 'POST', '/nodes/register', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: token.token, publicKey: keys.publicKey, roles: ['host', 'verify'], publicUrl: 'wss://sp1.turbo-gol.com', build, specs: {}, capacity }),
  });
  assert.equal(r.status, 200);
  const node = await jsonOf(r);
  assert.deepEqual([node.name, node.status, node.controlUrl, node.controlPublicKey], ['sao-paulo-1', 'pending', 'wss://turbo-gol.com/nodes/connect', CONTROL.publicKey]);
  const c = await req(env, 'GET', '/nodes/connect', { headers: { Upgrade: 'websocket' } });
  assert.equal(c.upgraded, true);
  assert.equal(reg.sockets.length, 1);
  assert.equal(reg.sockets[0].sent[0].t, 'challenge');
});

test('end to end: the cron’s call reaches a real NodeRegistryDO, which answers it', async () => {
  const env = makeEnv();
  const reg = realRegistry(env);
  const answers = [];
  env.NODES.handler = async (r) => {
    const res = await reg.obj.fetch(r);
    answers.push([res.status, await res.clone().json()]);
    return res;
  };
  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args.map(String).join(' '));
  try {
    const waits = [];
    await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() }, env, { waitUntil: (p) => waits.push(p), passThroughOnException() {} });
    await Promise.all(waits);
  } finally {
    console.error = realError;
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(answers, [[200, { probed: 0, problems: 0 }]], 'no node yet');
});

test('end to end: a maintainer lists the nodes through the Worker on a real NodeRegistryDO', async () => {
  const env = makeEnv();
  const reg = realRegistry(env);
  env.NODES.handler = (r) => reg.obj.fetch(r);
  const res = await req(env, 'GET', '/nodes/admin/nodes', { headers: { authorization: 'Bearer ' + (await accountToken(PROJECT)) } });
  assert.equal(res.status, 200);
  const list = await jsonOf(res);
  assert.deepEqual([list.nodes, list.channel, list.verifying], [[], { stable: '0.2.0', minimum: '0.2.0' }, 0]);
  const other = await req(env, 'GET', '/nodes/admin/nodes', { headers: { authorization: 'Bearer ' + (await accountToken(PLAYER, 'Jugador')) } });
  assert.equal(other.status, 403);
});

// ---- the public replays (replayIndex.ts, src/net/replays.ts, docs/replays.md) ------------------------

const { ReplayWriter, decodeReplay } = await import('../../nodes/shared/replay.ts');
const RI = await import('../src/replayIndex.ts');
const { PUBLIC_REPLAY_MAX_BYTES, publicReplay, replayIndexItem } = RI;
const { sha256Hex } = await import('../../nodes/shared/edcrypto.ts');
const { NodeStore } = await import('../src/nodeStore.ts');

const BUILD = { version: '0.3.0', protocol: 3, wasmSha256: 'd'.repeat(64) };
const ACCOUNT_A = 'a1a1a1a1a1a1a1a1';
const ACCOUNT_B = 'b2b2b2b2b2b2b2b2';
const hex64 = (c) => c.repeat(64);
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
/** Half past an hour that ended 2 to 3 hours ago: served (past the first hour), with half an hour on each side in the same hour. */
const BASE = Math.floor((Date.now() - 3 * HOUR) / HOUR) * HOUR + HOUR / 2;
const hourOf = (t) => Math.floor(t / HOUR) * HOUR;

/** A small valid TGR1 replay of a 1v1 between two accounts, as a node wrote it (its own names, its own start time). */
function tgr(matchId, names = ['nodeA', 'nodeB'], { startedAt = 0, botDifficulty = 'medium' } = {}) {
  const w = new ReplayWriter({
    v: 1,
    matchId,
    nodeId: 'feedfacefeedface',
    build: BUILD,
    mode: '1v1',
    region: 'SA',
    ranked: true,
    roster: [
      { slot: 0, team: 0, kind: 'player', name: names[0], playerId: ACCOUNT_A },
      { slot: 1, team: 1, kind: 'player', name: names[1], playerId: ACCOUNT_B },
    ],
    matchLengthSeconds: 180,
    kickoffSeed: 7,
    botDifficulty,
    tickRate: 120,
    checkpointEvery: 120,
    startedAt,
  });
  w.input(1, 0, new Int8Array([1, 0, 0, 0, 0, 0]), 0);
  w.input(1, 1, new Int8Array([0, 1, 0, 0, 0, 0]), 0);
  w.hash(120, 12345);
  w.end({ tick: 200, winner: 1, blue: 1, red: 4, reason: 'rules', forfeitTeam: -1 });
  return w.finish();
}

/** A settled MatchEntry, enough for NodeStore.finished and replayIndexItem: two accounts, 'Javier' and 'Rival'. */
function settled(matchId, { doneAt = BASE, replaySha = 'e'.repeat(64), ranked = true, replayBytes = 9818 } = {}) {
  return {
    assign: {
      matchId,
      mode: '1v1',
      region: 'SA',
      ranked,
      roster: [
        { slot: 0, team: 0, kind: 'player', name: 'Javier', playerId: ACCOUNT_A },
        { slot: 1, team: 1, kind: 'player', name: 'Rival', playerId: ACCOUNT_B },
      ],
      matchLengthSeconds: 180,
      kickoffSeed: 7,
      botDifficulty: 'medium',
      createdAt: doneAt - 200_000,
    },
    nodeId: 'feedfacefeedface',
    state: 'done',
    humans: [
      { playerId: ACCOUNT_A, name: 'Javier', account: true },
      { playerId: ACCOUNT_B, name: 'Rival', account: true },
    ],
    leaves: new Set(),
    leaveAt: new Map(),
    neverJoined: new Set(),
    left: new Set(),
    offered: new Set(),
    build: BUILD,
    replaySha,
    report: { kind: 'ended', matchId, result: { winner: 1, blue: 1, red: 4, endTick: 25_560, endReason: 'rules' }, replaySha256: replaySha, replayBytes },
    verdict: null,
    ledger: null,
    doneAt,
  };
}

const rated = (matchId) => ({ kind: 'rated', matchId, playlist: '1v1', region: 'SA', winner: 1, blue: 1, red: 4, players: [], nodeId: 'feedfacefeedface' });
const unverified = (matchId) => ({ kind: 'unrated', matchId, nodeId: 'n', blue: 2, red: 2, verified: false });

function memStore(now = () => Date.now()) {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(query, ...bindings) {
      const stmt = db.prepare(query);
      const rows = /^\s*(SELECT|WITH)/i.test(query) ? stmt.all(...bindings) : (stmt.run(...bindings), []);
      return { toArray: () => rows.map((r) => ({ ...r })) };
    },
  };
  const store = new NodeStore(sql, (fn) => fn(), () => undefined, now);
  store.migrate();
  return store;
}

/**
 * AccountsDO as the NodeRegistryDO asks it (POST /replay-hidden): `hidden.ids` and `hidden.names`
 * are the accounts that hide their names; `calls` records each ask, `down` makes it fail.
 */
function accountsNs({ ids = [], names = [] } = {}) {
  const ns = {
    calls: [],
    /** The bodies of the /replay-hidden asks (the outbox's deliveries of the settled matches come here too). */
    asked: () => ns.calls.filter((c) => c.path === '/replay-hidden').map((c) => c.body),
    down: false,
    hidden: { ids: new Set(ids), names: new Set(names) },
    idFromName: (name) => ({ name }),
    get: () => ({
      fetch: async (url, init) => {
        const path = new URL(url).pathname;
        const body = init?.body ? JSON.parse(init.body) : null;
        ns.calls.push({ path, body });
        if (ns.down) return new RealResponse('{"error":"internal"}', { status: 500 });
        if (path !== '/replay-hidden') return new RealResponse('{"error":"not_found"}', { status: 404 });
        return new RealResponse(JSON.stringify({ ids: body.ids.filter((i) => ns.hidden.ids.has(i)), names: body.names.filter((n) => ns.hidden.names.has(n)) }), { headers: { 'content-type': 'application/json' } });
      },
    }),
  };
  return ns;
}

/** A Cache API stand-in (caches.default): every match, put and delete in `log`, the stored copies in `store`. */
function fakeCaches() {
  const store = new Map();
  const log = [];
  const k = (key) => String(key?.url ?? key);
  return {
    store,
    log,
    default: {
      async match(key) {
        log.push(['match', k(key)]);
        const r = store.get(k(key));
        return r ? r.clone() : undefined;
      },
      async put(key, r) {
        log.push(['put', k(key), r.headers.get('cache-control')]);
        store.set(k(key), new RealResponse(await r.arrayBuffer(), r));
      },
      async delete(key) {
        log.push(['delete', k(key)]);
        return store.delete(k(key));
      },
    },
  };
}

async function withCaches(c, fn) {
  const real = globalThis.caches;
  globalThis.caches = c;
  try {
    return await fn();
  } finally {
    globalThis.caches = real;
  }
}

/** A Workers Rate Limiting binding: `limit` per key; `keys` every key it was asked about. */
function fakeBinding(limit) {
  const keys = [];
  const seen = new Map();
  return {
    keys,
    async limit({ key }) {
      keys.push(key);
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      return { success: n <= limit };
    },
  };
}

/** A real NodeRegistryDO behind the Worker, its index holding `entries`, their replays in R2, AccountsDO's answers from `accounts`. */
async function replayWorld(entries, { accounts = accountsNs(), over = {} } = {}) {
  const env = makeEnv({ ACCOUNTS: accounts, ...over });
  const reg = realRegistry(env);
  env.NODES.handler = (r) => reg.obj.fetch(r);
  await reg.obj.ready;
  for (const { id, doneAt, bytes, sha, outcome } of entries) {
    reg.obj.store.finished(settled(id, { doneAt, replaySha: sha ?? (await sha256Hex(bytes)) }), (outcome ?? rated)(id));
    if (bytes) await env.NODE_REPLAYS.put(id, bytes);
  }
  return { env, reg, accounts };
}

test('replay index: rated and unrated matches are listed with the control plane’s names and no account id; void ones, matches without a replay and one its node says is too big are not', () => {
  const store = memStore();
  store.finished(settled(hex64('1'), { doneAt: BASE - 3000 }), rated(hex64('1')));
  store.finished(settled(hex64('2'), { doneAt: BASE - 2000, ranked: false }), unverified(hex64('2')));
  store.finished(settled(hex64('3'), { doneAt: BASE - 1000 }), { kind: 'void', matchId: hex64('3'), nodeId: 'n', ranked: true, reason: 'hash_mismatch', players: [], noShows: [] });
  store.finished(settled(hex64('4'), { doneAt: BASE, replaySha: null }), rated(hex64('4')));
  store.finished(settled(hex64('5'), { doneAt: BASE, replayBytes: PUBLIC_REPLAY_MAX_BYTES + 1 }), rated(hex64('5')));
  const list = store.replayList(null, 30);
  assert.deepEqual(
    list.map((r) => [r.item.matchId[0], r.item.verified, r.item.blue, r.item.red]),
    [
      ['2', false, 2, 2],
      ['1', true, 1, 4],
    ],
    'the tampered (void) match, the one without a replay and the oversized one are never listed',
  );
  assert.deepEqual(list[1].item.players, [
    { team: 0, name: 'Javier', bot: false },
    { team: 1, name: 'Rival', bot: false },
  ]);
  assert.equal(list[1].item.ticks, 25_560);
  assert.deepEqual(list[1].item.build, BUILD);
  assert.deepEqual(list[1].seats, [
    { slot: 0, playerId: ACCOUNT_A },
    { slot: 1, playerId: ACCOUNT_B },
  ], 'the seats stay in the object, beside the row');
  const text = JSON.stringify(list.map((r) => r.item));
  assert.ok(!text.includes(ACCOUNT_A) && !text.includes(ACCOUNT_B) && !text.includes('feedface'), 'no account id, no node id');
  const e = store.replayEntry(hex64('1'));
  assert.deepEqual([e.item, e.sha], [list[1].item, 'e'.repeat(64)]);
  assert.equal(store.replayEntry(hex64('3')), null);
  assert.deepEqual(
    store.replayList({ hour: Math.floor(BASE / HOUR), matchId: hex64('2') }, 30).map((r) => r.item.matchId[0]),
    ['1'],
    'paged in the public order',
  );
});

test('replay index: a match is served an hour after it settled and never past 30 days, prune or not; the cron prunes', () => {
  let now = Date.now();
  const store = memStore(() => now);
  store.finished(settled(hex64('a'), { doneAt: now - 30 * 60_000 }), rated(hex64('a')));
  store.finished(settled(hex64('b'), { doneAt: now - 61 * 60_000 }), rated(hex64('b')));
  assert.deepEqual(store.replayList(null, 30).map((r) => r.item.matchId[0]), ['b'], 'its first hour: not listed');
  assert.equal(store.replayEntry(hex64('a')), null, 'nor viewable');
  assert.ok(store.replayEntry(hex64('b')));
  now += 31 * 60_000;
  assert.deepEqual(store.replayList(null, 30).map((r) => r.item.matchId[0]).sort(), ['a', 'b']);
  now += 30 * DAY;
  assert.deepEqual(store.replayList(null, 30), [], 'past 30 days: not listed');
  assert.equal(store.replayEntry(hex64('b')), null, 'nor viewable, though no prune ran');
  assert.deepEqual(store.pruneReplays(now).sort(), [hex64('a'), hex64('b')]);
  assert.deepEqual(store.pruneReplays(now), []);
});

test('replay index: a row that cannot be built leaves the match unlisted and settled all the same', () => {
  const store = memStore();
  const broken = settled(hex64('c'));
  assert.throws(() => replayIndexItem({ ...broken, assign: { ...broken.assign, roster: null } }, rated(hex64('c'))));
  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  store.replayRow = () => {
    throw new Error('disk full');
  };
  try {
    store.finished(broken, rated(hex64('c')));
  } finally {
    console.error = realError;
    delete store.replayRow;
  }
  assert.equal(store.replayEntry(hex64('c')), null);
  assert.equal(store.load(Date.now()).matches.filter((m) => m.matchId === hex64('c')).length, 1, 'the settled row was written');
  assert.equal(errors.length, 1);
});

test('publicReplay: blanks the account ids, the node id and the start time, takes the index’s names and keeps every record byte for byte', () => {
  const bytes = tgr(hex64('7'), ['<img src=x onerror=alert(1)>', 'nodeB'], { startedAt: 1_761_750_123_456 });
  const item = replayIndexItem(settled(hex64('7')), rated(hex64('7')));
  const out = publicReplay(bytes, item);
  const r = decodeReplay(out);
  assert.equal(r.header.nodeId, '');
  assert.equal(r.header.startedAt, 0, 'a node’s wall clock is not the public’s');
  assert.deepEqual(
    r.header.roster.map((e) => [e.name, e.playerId]),
    [
      ['Javier', ''],
      ['Rival', ''],
    ],
  );
  const text = new TextDecoder().decode(out);
  assert.ok(!text.includes(ACCOUNT_A) && !text.includes('feedface') && !text.includes('onerror') && !text.includes('1761750123456'));
  const orig = decodeReplay(bytes);
  assert.deepEqual([r.inputCount, [...r.inputData], [...r.hashValues], r.end], [orig.inputCount, [...orig.inputData], [...orig.hashValues], orig.end]);
  assert.throws(() => publicReplay(new Uint8Array([1, 2, 3, 4, 0, 0, 0, 0]), item), /magic/);
  assert.throws(() => publicReplay(bytes.subarray(0, 20), item), /header length/);
});

/** `bytes` with its header JSON replaced by `mutate(header)` (a node writing what it likes). */
function withHeader(bytes, mutate) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hlen = dv.getUint32(4, true);
  const h = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + hlen)));
  const json = enc.encode(JSON.stringify(mutate(h) ?? h));
  const out = new Uint8Array(8 + json.length + bytes.length - 8 - hlen);
  out.set(bytes.subarray(0, 4));
  new DataView(out.buffer).setUint32(4, json.length, true);
  out.set(json, 8);
  out.set(bytes.subarray(8 + hlen), 8 + json.length);
  return out;
}

test('publicReplay: the header is rebuilt from an allow-list; whatever else a node wrote is dropped', () => {
  const item = replayIndexItem(settled(hex64('7')), rated(hex64('7')));
  const hostile = withHeader(tgr(hex64('7')), (h) => {
    h.leak = [ACCOUNT_A, ACCOUNT_B];
    h.region = `SA ${ACCOUNT_A}`;
    h.build = { ...h.build, version: ACCOUNT_A };
    h.roster[0].extra = ACCOUNT_A;
    h['__proto__'] = { polluted: ACCOUNT_A };
  });
  const out = publicReplay(hostile, item);
  const text = new TextDecoder().decode(out);
  assert.ok(!text.includes(ACCOUNT_A) && !text.includes(ACCOUNT_B), 'no account id survives, wherever the node put it');
  const r = decodeReplay(out);
  assert.deepEqual([r.header.region, r.header.build, r.header.matchId, r.header.ranked], ['SA', BUILD, hex64('7'), true], 'identity and build from the control plane');
  assert.deepEqual(Object.keys(r.header.roster[0]).sort(), ['kind', 'name', 'playerId', 'slot', 'team']);
  assert.equal({}.polluted, undefined);
});

test('publicReplay: refuses a roster that is not the control plane’s, odd types, junk records and oversized bytes', () => {
  const item = replayIndexItem(settled(hex64('7')), rated(hex64('7')));
  const base = tgr(hex64('7'));
  const refused = [
    ['teams swapped', (h) => void ((h.roster[0].team = 1), (h.roster[1].team = 0))],
    ['a human made a bot', (h) => void (h.roster[1].kind = 'bot')],
    ['an object for a slot', (h) => void (h.roster[0].slot = { playerId: ACCOUNT_A })],
    ['an extra car', (h) => void h.roster.push({ slot: 2, team: 1, kind: 'bot', name: 'x' })],
    ['a string seed', (h) => void (h.kickoffSeed = 'seven')],
    ['another tick rate', (h) => void (h.tickRate = 60)],
    ['an unknown difficulty', (h) => void (h.botDifficulty = 'insane')],
    ['a header that is an array', () => [1, 2, 3]],
  ];
  for (const [what, mutate] of refused) assert.throws(() => publicReplay(withHeader(base, mutate), item), Error, what);
  const junk = new Uint8Array(base.length + 5);
  junk.set(base);
  junk.set([9, 0, 0, 0, 0], base.length);
  assert.throws(() => publicReplay(junk, item), /record/, 'bytes after END');
  const big = new Uint8Array(PUBLIC_REPLAY_MAX_BYTES + 1);
  big.set(base);
  assert.throws(() => publicReplay(big, item), /too large/);
});

test('GET /nodes/replays: only matches settled an hour ago, each at its hour (never the minute), by the hour and then the id (not the exact time); paged by a signed cursor; the first page cached by the isolate', async () => {
  const entries = [];
  // 32 in one hour, the later settles with the smaller ids (the list must not give their order away); one 30 minutes old.
  for (let i = 0; i < 32; i++) entries.push({ id: (i + 1).toString(16).padStart(64, '0'), doneAt: BASE - 20 * 60_000 + (32 - i) * 1000, bytes: null, sha: 'e'.repeat(64) });
  entries.push({ id: hex64('f'), doneAt: Date.now() - 30 * 60_000, bytes: null, sha: 'e'.repeat(64) });
  const { env } = await replayWorld(entries);
  const res = await req(env, 'GET', '/nodes/replays');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control'), /max-age=30/);
  assert.equal(res.headers.get('x-robots-tag'), 'noindex');
  const page = await jsonOf(res);
  assert.equal(page.matches.length, 30);
  assert.ok(!page.matches.some((m) => m.matchId === hex64('f')), 'a match in its first hour is not listed');
  assert.deepEqual(new Set(page.matches.map((m) => m.at)), new Set([hourOf(BASE)]), 'the hour, never the minute');
  assert.deepEqual(
    page.matches.map((m) => m.matchId),
    entries
      .slice(0, 32)
      .map((e) => e.id)
      .sort()
      .reverse()
      .slice(0, 30),
    'by id within the hour: the largest id settled first',
  );
  assert.match(page.next, /^\d{1,10}\.[0-9a-f]{64}\.[0-9a-f]{32}$/, 'an opaque, signed cursor');
  const rest = await jsonOf(await req(env, 'GET', `/nodes/replays?before=${encodeURIComponent(page.next)}`));
  assert.deepEqual(
    rest.matches.map((m) => m.matchId),
    [entries[1].id, entries[0].id],
  );
  assert.equal(rest.next, null);
  const seen = env.NODES.seen.length;
  await req(env, 'GET', '/nodes/replays');
  assert.equal(env.NODES.seen.length, seen, 'the first page came from the isolate cache');
});

test('GET /nodes/replays: a forged cursor, a bare settle time (any past ?before= reached the object) or junk is the cached first page, never the object; a signed one is kept at the edge', async () => {
  const entries = [];
  for (let i = 0; i < 31; i++) entries.push({ id: (i + 1).toString(16).padStart(64, '0'), doneAt: BASE - i * 1000, bytes: null, sha: 'e'.repeat(64) });
  const { env } = await replayWorld(entries);
  const c = fakeCaches();
  await withCaches(c, async () => {
    const first = await (await req(env, 'GET', '/nodes/replays')).text();
    const { next } = JSON.parse(first);
    const asked = env.NODES.seen.length;
    const forged = next.slice(0, -1) + (next.endsWith('0') ? '1' : '0');
    const [hour, id] = next.split('.');
    for (const q of [forged, `${hour}.${id}`, `${hour}.${hex64('0')}.${'0'.repeat(32)}`, String(Date.now() - 1000), String(BASE), '0', String(Date.now() + DAY), 'abc', '-5', '99999999999999999']) {
      const res = await req(env, 'GET', `/nodes/replays?before=${encodeURIComponent(q)}`);
      assert.equal(res.status, 200, q);
      assert.equal(await res.text(), first, q);
    }
    assert.equal(env.NODES.seen.length, asked, 'none of them reached the object');
    const page = await jsonOf(await req(env, 'GET', `/nodes/replays?before=${encodeURIComponent(next)}`));
    assert.equal(page.matches.length, 1);
    assert.equal(env.NODES.seen.length, asked + 1);
    const put = c.log.find(([op, key]) => op === 'put' && key.includes('/nodes/replays?before='));
    assert.equal(put[2], 'public, max-age=300', 'a later page is kept 5 minutes at the edge');
    const again = await req(env, 'GET', `/nodes/replays?before=${encodeURIComponent(next)}`);
    assert.deepEqual(await jsonOf(again), page);
    assert.match(again.headers.get('cache-control'), /max-age=30/, 'browsers keep it 30 s');
    assert.equal(env.NODES.seen.length, asked + 1, 'the second ask came from the edge cache');
  });
});

test('hide my name: an account that chose it shows as Jugador N in the list and in the replay, matches listed before it chose too; the others as they are', async () => {
  const a = hex64('a');
  const accounts = accountsNs();
  const { env, reg } = await replayWorld([{ id: a, doneAt: BASE, bytes: tgr(a) }], { accounts });
  // Listed with both names; then Rival (ACCOUNT_B) turns on "hide my name" in PERFIL.
  assert.ok(reg.obj.store.replayEntry(a));
  accounts.hidden.ids.add(ACCOUNT_B);
  const page = await jsonOf(await req(env, 'GET', '/nodes/replays'));
  assert.deepEqual(page.matches[0].players.map((p) => p.name), ['Javier', 'Jugador 2']);
  assert.ok(!JSON.stringify(page).includes('Rival'));
  const view = await req(env, 'GET', `/nodes/replays/${a}/view`);
  assert.equal(view.status, 200);
  const r = decodeReplay(new Uint8Array(await view.arrayBuffer()));
  assert.deepEqual(
    r.header.roster.map((e) => [e.name, e.playerId]),
    [
      ['Javier', ''],
      ['Jugador 2', ''],
    ],
    'the replay too',
  );
  assert.ok(!new TextDecoder().decode(new Uint8Array(await (await req(env, 'GET', `/nodes/replays/${a}/view`)).arrayBuffer())).includes('Rival'));
  assert.deepEqual(accounts.asked(), [{ ids: [ACCOUNT_A, ACCOUNT_B], names: [] }], 'asked once by id; the answers kept a minute');
});

test('hide my name: a row listed before the seats were kept is looked up by its names; nobody hides by default', async () => {
  const a = hex64('a');
  const b = hex64('b');
  const accounts = accountsNs({ names: ['Rival'] });
  const { env, reg } = await replayWorld(
    [
      { id: a, doneAt: BASE, bytes: tgr(a) },
      { id: b, doneAt: BASE - 1000, bytes: tgr(b) },
    ],
    { accounts },
  );
  reg.obj.store.sql.exec('DELETE FROM replay_players WHERE match_id = ?', a); // a: listed by the build before this one
  const page = await jsonOf(await req(env, 'GET', '/nodes/replays'));
  assert.deepEqual(
    page.matches.map((m) => [m.matchId[0], m.players.map((p) => p.name)]),
    [
      ['b', ['Javier', 'Rival']],
      ['a', ['Javier', 'Jugador 2']],
    ],
    'b by its ids (nobody hides them), a by its names',
  );
  assert.deepEqual(accounts.asked(), [{ ids: [ACCOUNT_A, ACCOUNT_B], names: ['Javier', 'Rival'] }]);
});

test('hide my name: while AccountsDO cannot answer, nothing is served (503, never a hidden name), and nothing is cached', async () => {
  const a = hex64('a');
  const accounts = accountsNs({ ids: [ACCOUNT_B] });
  accounts.down = true;
  const { env } = await replayWorld([{ id: a, doneAt: BASE, bytes: tgr(a) }], { accounts });
  const c = fakeCaches();
  await withCaches(c, async () => {
    const list = await req(env, 'GET', '/nodes/replays');
    assert.equal(list.status, 503);
    const view = await req(env, 'GET', `/nodes/replays/${a}/view`);
    assert.equal(view.status, 503);
    assert.ok(!(await view.text()).includes('Rival'));
    assert.deepEqual(c.log.filter(([op]) => op === 'put'), [], 'no copy and no "missing" marker kept');
    accounts.down = false;
    assert.deepEqual((await jsonOf(await req(env, 'GET', '/nodes/replays'))).matches[0].players.map((p) => p.name), ['Javier', 'Jugador 2']);
  });
});

test('GET /nodes/replays/<id>/view: the public bytes of a served match, kept 3 hours (not immutable), noindex; 404 for an unlisted, a too recent or a missing one', async () => {
  const good = hex64('a');
  const casual = hex64('c');
  const recent = hex64('4');
  const swapped = hex64('2');
  const gone = hex64('3');
  const { env } = await replayWorld([
    { id: good, doneAt: BASE - 3000, bytes: tgr(good) },
    { id: casual, doneAt: BASE - 2500, bytes: tgr(casual), outcome: unverified },
    { id: recent, doneAt: Date.now() - 10 * 60_000, bytes: tgr(recent) },
    { id: swapped, doneAt: BASE - 2000, bytes: tgr(swapped), sha: 'f'.repeat(64) },
    { id: gone, doneAt: BASE - 1000, bytes: null, sha: 'e'.repeat(64) },
  ]);
  const res = await req(env, 'GET', `/nodes/replays/${good}/view`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=10800', 'a delist or a hidden name reaches every copy within 3 hours');
  assert.equal(res.headers.get('x-robots-tag'), 'noindex');
  const r = decodeReplay(new Uint8Array(await res.arrayBuffer()));
  assert.deepEqual(
    r.header.roster.map((e) => [e.name, e.playerId]),
    [
      ['Javier', ''],
      ['Rival', ''],
    ],
  );
  assert.equal((await req(env, 'GET', `/nodes/replays/${casual}/view`)).status, 200, 'an unsampled casual match too');
  const early = await req(env, 'GET', `/nodes/replays/${recent}/view`);
  assert.equal(early.status, 404, 'its first hour: not viewable');
  assert.equal(early.headers.get('x-robots-tag'), 'noindex');
  assert.equal((await req(env, 'GET', `/nodes/replays/${swapped}/view`)).status, 404, 'the R2 object is not the uploaded one');
  assert.equal((await req(env, 'GET', `/nodes/replays/${gone}/view`)).status, 404, 'expired from R2');
  assert.equal((await req(env, 'GET', `/nodes/replays/${hex64('9')}/view`)).status, 404, 'never listed (a void match, say)');
  assert.equal((await req(env, 'GET', `/nodes/replays/${good.toUpperCase()}/view`)).status, 404);
  assert.equal((await req(env, 'GET', `/nodes/replays/${good}`)).status, 404, 'the verifiers’ route still wants a signed request');
});

test('a view the object does not serve is remembered 5 minutes at the edge; a listed one that fails the checks a day, with an ALERT line, its R2 object read once', async () => {
  const junk = hex64('b');
  const { env } = await replayWorld([{ id: junk, doneAt: BASE, bytes: tgr(junk, undefined, { botDifficulty: 'x' }) }]);
  const c = fakeCaches();
  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    await withCaches(c, async () => {
      const random = hex64('7');
      assert.equal((await req(env, 'GET', `/nodes/replays/${random}/view`)).status, 404);
      const asked = env.NODES.seen.length;
      assert.equal((await req(env, 'GET', `/nodes/replays/${random}/view`)).status, 404);
      assert.equal(env.NODES.seen.length, asked, 'the second ask came from the edge');
      assert.ok(c.log.some(([op, key, cc]) => op === 'put' && key.endsWith(random) && cc === 'public, max-age=300'));
      assert.equal((await req(env, 'GET', `/nodes/replays/${junk}/view`)).status, 404);
      const reads = env.NODE_REPLAYS.asked.filter((k) => k === junk).length;
      assert.equal(reads, 1);
      for (let i = 0; i < 3; i++) assert.equal((await req(env, 'GET', `/nodes/replays/${junk}/view`)).status, 404);
      assert.equal(env.NODE_REPLAYS.asked.filter((k) => k === junk).length, reads, 'read, hashed and walked once, not at every view');
      assert.ok(c.log.some(([op, key, cc]) => op === 'put' && key.endsWith(junk) && cc === 'public, max-age=86400'));
    });
  } finally {
    console.error = realError;
  }
  assert.equal(errors.filter((e) => e.startsWith(`ALERT replay ${junk}`)).length, 1);
});

test('the replay routes count, across isolates, only what reaches the object: per network, and per IPv6 /48 for rotated /64s; edge-cache hits are free', async () => {
  const a = hex64('a');
  const RL_120 = fakeBinding(2);
  const RL_600 = fakeBinding(3);
  const { env } = await replayWorld([{ id: a, doneAt: BASE, bytes: tgr(a) }], { over: { RL_120, RL_600 } });
  const c = fakeCaches();
  await withCaches(c, async () => {
    const ip = freshIp();
    assert.equal((await req(env, 'GET', `/nodes/replays/${a}/view`, { ip })).status, 200);
    for (let i = 0; i < 5; i++) assert.equal((await req(env, 'GET', `/nodes/replays/${a}/view`, { ip })).status, 200, 'from the edge cache: not counted');
    assert.equal((await req(env, 'GET', `/nodes/replays/${hex64('1')}/view`, { ip })).status, 404);
    const over = await req(env, 'GET', `/nodes/replays/${hex64('2')}/view`, { ip });
    assert.equal(over.status, 429, 'the third object call from one network in a minute (the binding’s count: every isolate of the location)');
    assert.deepEqual(RL_600.keys, [], 'an IPv4 address has no site');
    // One /48, fresh /64s: each /64 is new to replayView, the /48 is not.
    const statuses = [];
    for (let i = 1; i <= 4; i++) statuses.push((await req(env, 'GET', `/nodes/replays/${hex64(String(i + 2))}/view`, { ip: `2001:db8:77:${i}::1` })).status);
    assert.deepEqual(statuses, [404, 404, 404, 429]);
    assert.ok(RL_600.keys.every((k) => k === 'replaySite:2001:db8:77::/48'));
  });
});

test('GET /nodes/replays/<id>/view without a binding: 120 object calls a minute per network in an isolate', async () => {
  const id = hex64('1');
  const { env } = await replayWorld([{ id, doneAt: BASE, bytes: tgr(id) }]);
  const ip = freshIp();
  let last = 0;
  for (let i = 0; i < 121; i++) last = (await req(env, 'GET', `/nodes/replays/${id}/view`, { ip })).status;
  assert.equal(last, 429);
});

test('replay uploads and downloads are counted across isolates too (the binding refuses: no object call)', async () => {
  const env = makeEnv({ RL_60: fakeBinding(0) });
  const node = { 'x-node-id': 'f'.repeat(16), 'x-node-ts': '1', 'x-node-sig': 'sig', 'x-replay-sha256': 'c'.repeat(64) };
  assert.equal((await req(env, 'PUT', '/nodes/replays/' + 'ab'.repeat(32), { headers: node, body: new Uint8Array(10) })).status, 429);
  assert.equal((await req(env, 'GET', '/nodes/replays/' + 'ab'.repeat(32), { headers: node })).status, 429);
  assert.equal(env.NODES.seen.length, 0);
  assert.deepEqual(env.RL_60.keys.map((k) => k.split(':')[0]), ['nodeReplayPut', 'nodeReplayGet']);
});

test('the kill switch replays_off: the public list and view answer 404, edge-cached copies too, the object never asked; the nodes go on; one KV read per isolate', async () => {
  const a = hex64('a');
  const { env } = await replayWorld([{ id: a, doneAt: BASE, bytes: tgr(a) }]);
  const c = fakeCaches();
  await withCaches(c, async () => {
    assert.equal((await req(env, 'GET', `/nodes/replays/${a}/view`)).status, 200);
    assert.ok(c.store.has(`${ORIGIN}/nodes/replays/${a}/view`), 'a copy at the edge');
    const reads = [];
    const off = { ...env, FLAGS: { get: async (name) => (reads.push(name), name === 'replays_off' ? '1' : null) }, NODES: nodesNs(env.NODES.handler) };
    for (const path of ['/nodes/replays', `/nodes/replays/${a}/view`, `/nodes/replays?before=x`]) {
      const res = await req(off, 'GET', path);
      assert.equal(res.status, 404, path);
      assert.equal(res.headers.get('x-robots-tag'), 'noindex');
    }
    assert.equal(off.NODES.seen.length, 0, 'the object never heard of them');
    assert.deepEqual(reads, ['replays_off'], 'kept by the isolate');
    assert.equal((await req(off, 'GET', '/nodes/status')).status, 200, 'the nodes go on');
  });
});

test('delist: a maintainer with a fresh sign-in takes one match out of the public replays (its row, its R2 object, its edge copies, every location’s with the purge token); nobody else can', async () => {
  const a = hex64('a');
  const b = hex64('b');
  const purges = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    purges.push({ url: String(url), auth: init.headers.authorization, body: JSON.parse(init.body) });
    return new RealResponse('{"success":true,"result":{"id":"x"}}', { headers: { 'content-type': 'application/json' } });
  };
  const { env } = await replayWorld(
    [
      { id: a, doneAt: BASE, bytes: tgr(a) },
      { id: b, doneAt: BASE - 1000, bytes: tgr(b) },
    ],
    { over: { CF_ZONE_ID: 'zone123', CF_PURGE_TOKEN: 'purge-token' } },
  );
  const c = fakeCaches();
  const now = Math.floor(Date.now() / 1000);
  const stale = await signJwt(SECRET, { sub: PROJECT, name: 'Proyecto', iat: now, exp: now + 3600, acct: 1, aat: now - 3600 });
  const delist = (token, body) => req(env, 'POST', '/nodes/admin/delist', { headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    await withCaches(c, async () => {
      assert.equal((await req(env, 'GET', `/nodes/replays/${a}/view`)).status, 200);
      assert.equal((await delist(await accountToken(PLAYER), { matchId: a })).status, 403, 'not a maintainer');
      const r = await delist(stale, { matchId: a });
      assert.equal(r.status, 403);
      assert.equal((await jsonOf(r)).error, 'reauth_required', 'a maintainer’s session an hour after its sign-in');
      assert.equal(env.NODE_REPLAYS.objects.has(a), true, 'nothing happened yet');
      const ok = await delist(await accountToken(PROJECT), { matchId: a, reason: 'asked by the player' });
      assert.equal(ok.status, 200);
      assert.deepEqual(await jsonOf(ok), { matchId: a, delisted: true, replayDeleted: true, purged: { here: true, everywhere: true } });
      assert.equal(env.NODE_REPLAYS.objects.has(a), false, 'its R2 object is gone');
      assert.equal(env.NODE_REPLAYS.objects.has(b), true);
      assert.ok(c.log.some(([op, key]) => op === 'delete' && key === `${ORIGIN}/nodes/replays/${a}/view`), 'the edge copy here');
      assert.deepEqual(purges, [{ url: 'https://api.cloudflare.com/client/v4/zones/zone123/purge_cache', auth: 'Bearer purge-token', body: { files: [`${ORIGIN}/nodes/replays/${a}/view`] } }], 'and in every location');
      assert.equal((await req(env, 'GET', `/nodes/replays/${a}/view`)).status, 404);
      assert.deepEqual((await jsonOf(await req(env, 'GET', '/nodes/replays'))).matches.map((m) => m.matchId), [b], 'out of the list (this isolate’s first page dropped)');
      assert.equal((await delist(await accountToken(PROJECT), { matchId: a })).status, 404, 'already gone');
      assert.equal((await delist(await accountToken(PROJECT), { matchId: 'nope' })).status, 400);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  // Without the purge settings: this location only.
  const { env: plain } = await replayWorld([{ id: a, doneAt: BASE, bytes: tgr(a) }]);
  const res = await req(plain, 'POST', '/nodes/admin/delist', { headers: { authorization: 'Bearer ' + (await accountToken(PROJECT)), 'content-type': 'application/json' }, body: JSON.stringify({ matchId: a }) });
  assert.deepEqual((await jsonOf(res)).purged, { here: false, everywhere: null });
});

test('retention: the cron prunes the rows past 30 days and their R2 objects with no new match settling; the others stay', async () => {
  const old = hex64('a');
  const fresh = hex64('b');
  const { env } = await replayWorld([
    { id: old, doneAt: Date.now() - 31 * DAY, bytes: tgr(old) },
    { id: fresh, doneAt: BASE, bytes: tgr(fresh) },
  ]);
  assert.equal((await req(env, 'GET', `/nodes/replays/${old}/view`)).status, 404, 'never served past 30 days');
  const waits = [];
  await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() }, env, { waitUntil: (p) => waits.push(p), passThroughOnException() {} });
  await Promise.all(waits);
  assert.equal(env.NODE_REPLAYS.objects.has(old), false, 'its R2 object went with its row');
  assert.equal(env.NODE_REPLAYS.objects.has(fresh), true);
  assert.equal((await req(env, 'GET', `/nodes/replays/${fresh}/view`)).status, 200);
});

test('without the node settings the replay routes are a 404', async () => {
  const env = makeEnv({ NODES: undefined });
  assert.equal((await req(env, 'GET', '/nodes/replays')).status, 404);
  assert.equal((await req(env, 'GET', `/nodes/replays/${hex64('1')}/view`)).status, 404);
});


test('the kill switch nodes_off: every route that reaches the object answers 503 nodes_off before it, the cron calls nothing; releases and the shop go on', async () => {
  const reads = [];
  const env = makeEnv({ FLAGS: { get: async (name) => (reads.push(name), name === 'nodes_off' ? '1' : null) } });
  const op = { Authorization: 'Bearer ' + (await accountToken(PROJECT)) };
  const node = { 'x-node-id': 'f'.repeat(16), 'x-node-ts': '1', 'x-node-sig': 'sig', 'x-replay-sha256': 'c'.repeat(64) };
  const routes = [
    ['POST', '/nodes/register', { body: '{}' }],
    ['GET', '/nodes/connect', { headers: { Upgrade: 'websocket' } }],
    ['PUT', '/nodes/replays/' + 'ab'.repeat(32), { headers: node, body: new Uint8Array(10) }],
    ['GET', '/nodes/replays/' + 'ab'.repeat(32), { headers: node }],
    ['POST', '/nodes/tokens', { headers: op, body: '{"region":"SA"}' }],
    ['GET', '/nodes/mine', { headers: op }],
    ['GET', '/nodes/admin/nodes', { headers: op }],
  ];
  for (const [method, path, o] of routes) {
    const res = await req(env, method, path, o);
    assert.equal(res.status, 503, path);
    assert.equal((await jsonOf(res)).error, 'nodes_off', path);
  }
  assert.equal(env.NODES.seen.length, 0, 'the object never heard of them');
  const waits = [];
  await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() }, env, { waitUntil: (p) => waits.push(p), passThroughOnException() {} });
  await Promise.all(waits);
  assert.equal(env.NODES.seen.length, 0, 'nor of the cron');
  assert.equal((await req(env, 'GET', '/nodes/releases/install.sh')).status, 200, 'the installers go on');
  assert.ok(reads.every((n) => n === 'nodes_off'));
});
