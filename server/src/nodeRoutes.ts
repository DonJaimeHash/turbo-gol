/**
 * The Worker's /nodes/* routes (wrangler.jsonc run_worker_first): what the community nodes, their
 * installers and launchers, and the project's operator pages reach on the game's own domain. Most
 * of them go on to the NodeRegistryDO with the internal header; whoami and the releases are
 * answered here.
 *
 *   GET      /nodes/whoami            { ip }: the address the installer is seen from (CF-Connecting-IP)
 *   GET|HEAD /nodes/releases/channel  channel.json of R2 NODE_RELEASES, checked ({ stable, minimum } as X.Y.Z;
 *                                     503 otherwise, so a launcher keeps the release it runs), never cached.
 *                                     Its own route: the launcher asks for 'channel', with no extension
 *   GET|HEAD /nodes/releases/<key>    a release file: <version>/<file> (immutable) or a root file such as
 *                                     launcher.mjs or install.sh (revalidated by ETag); never a listing
 *   POST     /nodes/register          RegisterRequest -> the object, with the caller's address (x-client-ip); 413
 *                                     over 4 KB declared (the object reads at most that much of any body)
 *   GET      /nodes/connect           a node's control WebSocket -> the object; its 101 passes through as it is.
 *                                     No Origin check: the object's challenge is the gate
 *   PUT|GET  /nodes/replays/<id>      a replay (id: 64 hex), signed by the node -> the object, which checks the
 *                                     signature before it reads the body; 413 over 16 MiB
 *   POST     /nodes/tokens            { region, name? }, Bearer account session of a NODE_TRUSTED_OPERATORS account
 *                                     -> a one-time registration token and the Linux install line; 413 over 4 KB
 *   GET      /nodes/mine              Bearer account session -> the caller's own nodes
 *   GET      /nodes/status            the public list of nodes, cached 10 s
 *   GET      /nodes/admin/nodes       the maintainers' routes, Bearer account session of a NODE_TRUSTED_OPERATORS
 *   POST     /nodes/admin/status      account (401 without one, 403 for any other), 30 a minute per account, 413
 *   POST     /nodes/admin/drain       over 4 KB: every node in full; { nodeId, status, reason }; { nodeId, reason };
 *   POST     /nodes/admin/update      the channel read again and the nodes below its minimum told to update;
 *   POST     /nodes/admin/reprobe     { nodeId }. Every call is an ALERT line naming the account (NodeRegistryDO.ts)
 * Anything else under /nodes/ is a 404: the WebRTC signaling and the shop are not open in stage 1,
 * and the reference server's /dev/* routes never exist here. Without the node settings
 * (nodesConfigured: a fork, local dev) every route that needs the object is a 404 too.
 *
 * The object trusts what the Worker forwards: only the headers a node sends get through
 * (FORWARDED), and x-client-ip, x-operator-id and x-operator-name are always set here. CORS only on
 * tokens, mine and status, the routes a page calls; the rest is for nodes and curl. The limits
 * here are per isolate (index.ts rateLimited), per minute except two: registrations per address
 * per hour and tokens per account per day, the object's own limits, which only the object holds
 * across isolates. Here they keep junk from reaching it: every route that reaches the object has
 * one, per address (an IPv6 address counted by its /64, env.ts limitKey) or per account.
 *
 * The cron (index.ts scheduled, every 5 minutes) calls nodeHealthCheck: one call to the object,
 * which probes the trusted nodes' /healthz; nothing at all without the node settings.
 */
import { requireAccount } from './accountRoutes';
import type { SessionClaims } from './auth';
import { INTERNAL_HEADER, internalSecret } from './auth';
import { JSON_MAX_BYTES, error, json, limitKey, nodesConfigured, trustedOperatorIds } from './env';
import type { Env, NodesEnv } from './env';
import { NODE_ROUTES, nodesStub } from './nodeApi';
import { REGISTER_PER_IP_PER_HOUR, REPLAY_MAX_BYTES, TOKENS_PER_ACCOUNT_PER_DAY } from './NodeRegistryDO';

/** What the index.ts router hands over: its rate limiter, the session and its CORS headers. */
export interface NodeRouteContext {
  env: Env;
  request: Request;
  url: URL;
  /** The client address (CF-Connecting-IP; 'local' under wrangler dev without it). */
  ip: string;
  /** The verified Bearer session, read only by the routes that need one. */
  session: () => Promise<SessionClaims | null>;
  /** index.ts rateLimited: true = over `max` in the current window (default one minute). */
  limited: (key: string, max: number, windowMs?: number) => boolean;
  /** CORS headers for this request (index.ts corsHeaders). */
  cors: Record<string, string>;
}

/** The object's own limits (NodeRegistryDO.ts), here per isolate: junk stops before the object. */
const LIMIT_REGISTER_PER_IP = REGISTER_PER_IP_PER_HOUR;
const LIMIT_TOKENS_PER_ACCOUNT = TOKENS_PER_ACCOUNT_PER_DAY;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const LIMIT_CONNECT_PER_IP = 30;
/** A node uploads one replay per match: a full VPS ends a few matches a minute. */
const LIMIT_REPLAY_PUT_PER_IP = 60;
/** A verifier downloads one replay per job; counted apart from the uploads, which the same node makes. */
const LIMIT_REPLAY_GET_PER_IP = 60;
const LIMIT_STATUS_PER_IP = 60;
const LIMIT_MINE_PER_ACCOUNT = 30;
const LIMIT_ADMIN_PER_ACCOUNT = 30;
const STATUS_TTL_MS = 10_000;
/** The maintainers' routes and the method of each. */
const ADMIN_ROUTES: Readonly<Record<string, 'GET' | 'POST'>> = { nodes: 'GET', status: 'POST', drain: 'POST', update: 'POST', reprobe: 'POST' };

/**
 * A release key: an optional X.Y.Z/ directory, then one file name. Nothing else is ever looked up in
 * the bucket, and no key comes near R2's 1,024-byte limit (a longer one would make the lookup throw).
 */
const RELEASE_KEY = /^(?:\d{1,6}\.\d{1,6}\.\d{1,6}\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VERSIONED = /^\d+\.\d+\.\d+\//;
const SEMVER = /^\d+\.\d+\.\d+$/;
const REPLAY_PATH = /^\/nodes\/replays\/([0-9a-f]{64})$/;
const CORS_PATHS = new Set(['/nodes/tokens', '/nodes/mine', '/nodes/status']);
/** Request headers the object may see from a caller (the WebSocket upgrade's, a node's signed upload). */
const FORWARDED = new Set([
  'content-type',
  'content-length',
  'upgrade',
  'connection',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-protocol',
  'sec-websocket-extensions',
  'x-node-id',
  'x-node-ts',
  'x-node-sig',
  'x-replay-sha256',
]);
/**
 * Content types by extension (the reference server's, devServer.ts, plus the text files of a
 * release). Anything else is served as bytes: an .html in the bucket never renders on the game's origin.
 */
const TYPES: Record<string, string> = {
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.sh': 'text/plain; charset=utf-8',
  '.ps1': 'text/plain; charset=utf-8',
  '.sig': 'text/plain; charset=utf-8',
  '.pub': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
};

let statusCache: { at: number; body: string } | null = null;

export async function nodeRoute(c: NodeRouteContext): Promise<Response> {
  const path = c.url.pathname;
  const cors = CORS_PATHS.has(path);
  if (cors && c.request.method === 'OPTIONS') return new Response(null, { status: 204, headers: c.cors });
  let res: Response;
  try {
    res = await route(c, path);
  } catch (e) {
    console.error('nodes route error', e);
    res = error(500, 'internal');
  }
  if (!cors) return res; // a 101 among them: passed through untouched
  const out = new Response(res.body, res);
  for (const k in c.cors) out.headers.set(k, c.cors[k]);
  return out;
}

async function route(c: NodeRouteContext, path: string): Promise<Response> {
  const method = c.request.method;
  if (method === 'GET' && path === '/nodes/whoami') return json({ ip: c.request.headers.get('CF-Connecting-IP') }, 200, { 'cache-control': 'no-store' });
  if ((method === 'GET' || method === 'HEAD') && path.startsWith('/nodes/releases/')) return release(c, path.slice('/nodes/releases/'.length));
  const env = c.env;
  if (!nodesConfigured(env) || !env.JWT_SECRET) return error(404, 'not_found');
  const who = limitKey(c.ip);
  if (method === 'POST' && path === '/nodes/register') {
    if (declared(c.request) > JSON_MAX_BYTES) return error(413, 'too_large');
    if (c.limited('nreg:' + who, LIMIT_REGISTER_PER_IP, HOUR_MS)) return error(429, 'rate_limited');
    return toRegistry(env, c.request, path, { 'x-client-ip': c.ip });
  }
  if (method === 'GET' && path === '/nodes/connect') {
    if (c.request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return error(426, 'upgrade_required');
    if (c.limited('ncon:' + who, LIMIT_CONNECT_PER_IP)) return error(429, 'rate_limited');
    return toRegistry(env, c.request, path);
  }
  const replay = REPLAY_PATH.exec(path);
  if (replay && method === 'PUT') {
    if (declared(c.request) > REPLAY_MAX_BYTES) return error(413, 'too_large');
    if (c.limited('nrep:' + who, LIMIT_REPLAY_PUT_PER_IP)) return error(429, 'rate_limited');
    return toRegistry(env, c.request, path);
  }
  if (replay && method === 'GET') {
    if (c.limited('nrget:' + who, LIMIT_REPLAY_GET_PER_IP)) return error(429, 'rate_limited');
    return toRegistry(env, c.request, path);
  }
  if (method === 'POST' && path === '/nodes/tokens') {
    if (declared(c.request) > JSON_MAX_BYTES) return error(413, 'too_large');
    const s = requireAccount({ session: await c.session() });
    if (s instanceof Response) return s;
    if (!trustedOperatorIds(env).has(s.sub)) return error(403, 'not_trusted', 'only the project creates node tokens for now');
    if (c.limited('ntok:' + s.sub, LIMIT_TOKENS_PER_ACCOUNT, DAY_MS)) return error(429, 'rate_limited');
    return toRegistry(env, c.request, path, operator(s));
  }
  if (method === 'GET' && path === '/nodes/mine') {
    const s = requireAccount({ session: await c.session() });
    if (s instanceof Response) return s;
    if (c.limited('nmine:' + s.sub, LIMIT_MINE_PER_ACCOUNT)) return error(429, 'rate_limited');
    return toRegistry(env, c.request, path, operator(s));
  }
  if (method === 'GET' && path === '/nodes/status') return status(c, env, who);
  const admin = path.startsWith('/nodes/admin/') ? path.slice('/nodes/admin/'.length) : '';
  if (Object.hasOwn(ADMIN_ROUTES, admin) && ADMIN_ROUTES[admin] === method) {
    if (declared(c.request) > JSON_MAX_BYTES) return error(413, 'too_large');
    const s = requireAccount({ session: await c.session() });
    if (s instanceof Response) return s;
    if (!trustedOperatorIds(env).has(s.sub)) return error(403, 'not_trusted', 'only the project maintains the nodes');
    if (c.limited('nadm:' + s.sub, LIMIT_ADMIN_PER_ACCOUNT)) return error(429, 'rate_limited');
    return toRegistry(env, c.request, path, operator(s));
  }
  return error(404, 'not_found');
}

/**
 * The cron's health check (index.ts scheduled, every 5 minutes): one call to the NodeRegistryDO,
 * which probes the /healthz of the trusted wss nodes and raises the ALERTs (nodeWatch.ts). Without
 * the node settings (a fork, local dev) it does nothing at all. Never throws.
 */
export async function nodeHealthCheck(env: Env): Promise<void> {
  if (!nodesConfigured(env) || !env.JWT_SECRET) return;
  try {
    const res = await nodesStub(env).fetch(new Request('https://nodes' + NODE_ROUTES.health, { method: 'POST', headers: { [INTERNAL_HEADER]: await internalSecret(env.JWT_SECRET) } }));
    const text = await res.text();
    if (!res.ok) console.error(`nodes health check: ${res.status} ${text.slice(0, 200)}`);
  } catch (e) {
    console.error('nodes health check failed', e);
  }
}

/** The body length the caller declares (0 without a Content-Length: the object's own cap holds then). */
function declared(request: Request): number {
  return Number(request.headers.get('content-length') ?? 0);
}

/** Who asks, as the object reads it: the session's id and name (URL-encoded: header values are Latin-1). */
function operator(s: SessionClaims): Record<string, string> {
  return { 'x-operator-id': s.sub, 'x-operator-name': encodeURIComponent(s.name) };
}

/**
 * Forward a request to the NodeRegistryDO under `path`: its body as it comes (streamed), only the
 * FORWARDED headers, the internal header, and `set`, which overwrites whatever the caller sent.
 */
async function toRegistry(env: NodesEnv, request: Request, path: string, set: Record<string, string> = {}): Promise<Response> {
  const fwd = new Request('https://nodes' + path, request);
  for (const k of [...fwd.headers.keys()]) if (!FORWARDED.has(k)) fwd.headers.delete(k);
  fwd.headers.set(INTERNAL_HEADER, await internalSecret(env.JWT_SECRET));
  for (const k in set) fwd.headers.set(k, set[k]);
  return nodesStub(env).fetch(fwd);
}

/** GET /nodes/status: the object's public list, kept 10 s by each isolate and by caches on the way. */
async function status(c: NodeRouteContext, env: NodesEnv, who: string): Promise<Response> {
  if (c.limited('nst:' + who, LIMIT_STATUS_PER_IP)) return error(429, 'rate_limited');
  const now = Date.now();
  if (!statusCache || now - statusCache.at > STATUS_TTL_MS) {
    const res = await toRegistry(env, c.request, '/nodes/status');
    if (!res.ok) return res;
    statusCache = { at: now, body: await res.text() };
  }
  return new Response(statusCache.body, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${STATUS_TTL_MS / 1000}` } });
}

/** A file of R2 NODE_RELEASES: a checked key, its type, and caching that fits what it is. */
async function release(c: NodeRouteContext, raw: string): Promise<Response> {
  const bucket = c.env.NODE_RELEASES;
  if (!bucket) return error(404, 'not_found');
  let key: string;
  try {
    key = decodeURIComponent(raw);
  } catch {
    return error(404, 'not_found');
  }
  if (key === 'channel' || key === 'channel.json') return channel(bucket, c.request.method === 'HEAD');
  // The URL parser already resolved every '..' segment; one hidden behind an encoded slash is refused here.
  if (!RELEASE_KEY.test(key) || key.includes('..')) return error(404, 'not_found');
  const obj = c.request.method === 'HEAD' ? await bucket.head(key) : await bucket.get(key);
  if (!obj) return error(404, 'not_found');
  const dot = key.lastIndexOf('.');
  const headers = new Headers({
    'content-type': (dot > key.lastIndexOf('/') ? TYPES[key.slice(dot)] : undefined) ?? 'application/octet-stream',
    etag: obj.httpEtag,
    // A version's files never change (a new release is a new version); the root ones (the launcher, the installers) do.
    'cache-control': VERSIONED.test(key) ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  const body = 'body' in obj ? (obj as R2ObjectBody).body : null;
  if (c.request.headers.get('If-None-Match') === obj.httpEtag) {
    await body?.cancel();
    return new Response(null, { status: 304, headers });
  }
  headers.set('content-length', String(obj.size));
  return new Response(body, { status: 200, headers });
}

/** GET /nodes/releases/channel: the channel the launchers follow, only when it reads as one. */
async function channel(bucket: R2Bucket, head: boolean): Promise<Response> {
  const o = await bucket.get('channel.json');
  if (!o) return error(404, 'no_channel');
  let v: unknown = null;
  try {
    v = JSON.parse(await o.text());
  } catch {
    /* refused below */
  }
  const ch = (typeof v === 'object' && v !== null ? v : {}) as { stable?: unknown; minimum?: unknown };
  if (typeof ch.stable !== 'string' || !SEMVER.test(ch.stable) || typeof ch.minimum !== 'string' || !SEMVER.test(ch.minimum)) {
    // The object raises the ALERT when it reads it; a launcher that gets this keeps the release it runs.
    return error(503, 'bad_channel');
  }
  const res = json({ stable: ch.stable, minimum: ch.minimum }, 200, { 'cache-control': 'no-store' });
  return head ? new Response(null, res) : res;
}
