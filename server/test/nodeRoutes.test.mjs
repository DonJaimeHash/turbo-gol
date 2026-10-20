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

/** An R2 bucket in memory; `asked` records every key looked up. */
function bucket(files = {}) {
  const objects = new Map(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? enc.encode(v) : v]));
  const asked = [];
  const meta = (k, b) => ({ key: k, size: b.byteLength, httpEtag: `"etag-${k.length}-${b.byteLength}"` });
  return {
    objects,
    asked,
    async get(k) {
      asked.push(k);
      const b = objects.get(k);
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

const accountToken = (sub, name = 'Proyecto') => signJwt(SECRET, { sub, name, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, acct: 1 });

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

test('the channel: its own route (and channel.json), { stable, minimum } only, never cached; a bad or missing one is refused', async () => {
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
  for (const body of ['{"stable":"0.2.0"}', '{"stable":"0.2","minimum":"0.2.0"}', '{"stable":"0.2.0-rc1","minimum":"0.2.0"}', 'not json', '[]']) {
    await env.NODE_RELEASES.put('channel.json', body);
    const res = await req(env, 'GET', '/nodes/releases/channel');
    assert.equal(res.status, 503, body);
    assert.equal((await jsonOf(res)).error, 'bad_channel');
  }
  env.NODE_RELEASES.objects.delete('channel.json');
  assert.equal((await req(env, 'GET', '/nodes/releases/channel')).status, 404);
});

// ---- what is not served ------------------------------------------------------------------------------

test('no /dev/*, no WebRTC signaling, no shop, nothing unknown: 404, and the object never hears of them', async () => {
  const env = makeEnv();
  const routes = [
    ['POST', '/dev/login'],
    ['POST', '/dev/match'],
    ['GET', '/dev/outcome/' + 'ab'.repeat(32)],
    ['POST', '/nodes/dev/login'],
    ['POST', `/nodes/rtc/${'a'.repeat(16)}/${'ab'.repeat(32)}/ice`],
    ['POST', `/nodes/rtc/${'a'.repeat(16)}/${'ab'.repeat(32)}/offer`],
    ['GET', '/nodes/shop'],
    ['POST', '/nodes/shop/claim'],
    ['GET', '/nodes/inventory'],
    ['GET', '/nodes/'],
    ['GET', '/nodes/register'],
    ['DELETE', '/nodes/replays/' + 'ab'.repeat(32)],
    ['GET', '/nodes/replays/abc'],
    ['PUT', '/nodes/replays/' + 'AB'.repeat(32)],
  ];
  for (const [method, path] of routes) assert.equal((await req(env, method, path)).status, 404, `${method} ${path}`);
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

test('admin: 401 without a session, 403 for a guest and for any other account, forwarded for a trusted one with the operator headers overwritten; 30 a minute per account; no CORS', async () => {
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
  for (const [m, w] of [['GET', 'nodes'], ['POST', 'status'], ['POST', 'drain'], ['POST', 'update'], ['POST', 'reprobe']]) {
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
  for (const [m, w] of [['POST', 'nodes'], ['GET', 'drain'], ['POST', 'reboot'], ['POST', 'toString'], ['GET', '']]) assert.equal((await ask(m, w, auth)).status, 404, `${m} /nodes/admin/${w}`);
  assert.equal((await ask('POST', 'status', auth, { body, headers: { 'content-length': '4097' } })).status, 413);
  assert.equal(env.NODES.seen.length, forwarded, 'none of these reached the object');
  for (let i = 5; i < 30; i++) assert.equal((await ask('GET', 'nodes', auth)).status, 200);
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
