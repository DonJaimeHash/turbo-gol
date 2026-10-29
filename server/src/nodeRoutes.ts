/**
 * The Worker's /nodes/* routes (wrangler.jsonc run_worker_first): what the community nodes, their
 * installers and launchers, and the project's operator pages reach on the game's own domain. Most
 * of them go on to the NodeRegistryDO with the internal header; whoami and the releases are
 * answered here.
 *
 *   GET      /nodes/whoami            { ip }: the address the installer is seen from (CF-Connecting-IP)
 *   GET|HEAD /nodes/releases/channel  channel.json of R2 NODE_RELEASES, checked ({ stable, minimum } as X.Y.Z;
 *                                     503 otherwise, so a launcher keeps the release it runs), no-store on the
 *                                     wire and read from R2 at most every 30 s per isolate (CHANNEL_TTL_MS).
 *                                     Its own route: the launcher asks for 'channel', with no extension
 *   GET|HEAD /nodes/releases/<key>    a release file: <version>/<file> (immutable: from the edge cache after
 *                                     its first copy) or a root file such as launcher.mjs or install.sh
 *                                     (revalidated by ETag, without a body read); never a listing.
 *                                     Every release route: 1,200 a minute per network (limits.ts nodeReleases)
 *   POST     /nodes/register          RegisterRequest -> the object, with the caller's address (x-client-ip); 413
 *                                     over 4 KB declared (the object reads at most that much of any body)
 *   GET      /nodes/connect           a node's control WebSocket -> the object, with the caller's address
 *                                     (x-client-ip: the object caps the sockets still to log in per address and
 *                                     prefix, NodeRegistryDO.ts); its 101 passes through as it is. 30 a minute
 *                                     per /64 and 1,200 per /48 (limits.ts nodeConnect, nodeConnectWide). No
 *                                     Origin check: the object's challenge is the gate
 *   PUT|GET  /nodes/replays/<id>      a replay (id: 64 hex), signed by the node -> the object, which checks the
 *                                     signature before it reads the body; 413 over 16 MiB
 *   GET      /nodes/replays           the public replay list (anyone, guests included; src/net/replays.ts):
 *                                     ?before=<ms> pages it; the first page cached 30 s per isolate; 60 a minute
 *   GET      /nodes/replays/<id>/view a listed match's replay made public (replayIndex.ts: the header rebuilt
 *                                     from the control plane's record, no account or node id), its SHA-256
 *                                     checked against the index; 404 for a void, unlisted or expired match;
 *                                     edge-cached, immutable; 30 a minute
 *   POST     /nodes/tokens            { region, name? }, Bearer account session of a NODE_TRUSTED_OPERATORS account
 *                                     -> a one-time registration token and the Linux install line; 413 over 4 KB.
 *                                     Like every maintainer route: never a TV's session (403 tv_session), and one
 *                                     whose device proved a credential in the last MAINTAINER_FRESH_S (a sign-in
 *                                     or PERFIL's "confirm it's you"; else 403 reauth_required)
 *   GET      /nodes/mine              Bearer account session -> the caller's own nodes
 *   GET      /nodes/status            the public list of nodes, cached 10 s
 *   GET      /nodes/admin/nodes       the maintainers' routes, Bearer account session of a NODE_TRUSTED_OPERATORS
 *   POST     /nodes/admin/status      account (401 without one, 403 for any other), 30 a minute per account, 413
 *   POST     /nodes/admin/drain       over 4 KB: every node in full; { nodeId, status, reason }; { nodeId, reason };
 *   POST     /nodes/admin/update      the channel read again and the nodes below its minimum told to update;
 *   POST     /nodes/admin/reprobe     { nodeId };
 *   POST     /nodes/admin/grant       { account, item }, /revoke { account, item }, /unfreeze { account }: an
 *   POST     /nodes/admin/revoke      account's items and wallet in AccountsDO. Every call is an ALERT line naming
 *   POST     /nodes/admin/unfreeze    the account (NodeRegistryDO.ts)
 *   GET      /nodes/shop              aliases of GET /api/me/shop and POST /api/me/shop/claim (accountRoutes.ts,
 *   POST     /nodes/shop/claim        AccountsDO): answered with or without the node settings
 * The KV flag nodes_off (server/README.md, "Kill switches") stops every route here that would reach
 * the object, and the cron's call: 503 'nodes_off', the object never asked. The releases and the
 * shop aliases go on.
 * Anything else under /nodes/ is a 404: the WebRTC signaling is not open in stage 1, and the
 * reference server's /dev/* routes never exist here. Without the node settings (nodesConfigured: a
 * fork, local dev) every route that needs the object is a 404 too.
 *
 * The object trusts what the Worker forwards: only the headers a node sends get through
 * (FORWARDED), and x-client-ip, x-operator-id and x-operator-name are always set here. CORS only on
 * tokens, mine, status, the shop and the replay list, the routes a page calls; the rest is for nodes and curl. The limits
 * here are per isolate (index.ts rateLimited), per minute except two: registrations per address
 * per hour and tokens per account per day, the object's own limits, which only the object holds
 * across isolates. Here they keep junk from reaching it: every route that reaches the object has
 * one, per address (an IPv6 address counted by its /64, env.ts limitKey) or per account.
 *
 * The cron (index.ts scheduled, every 5 minutes) calls nodeHealthCheck: one call to the object,
 * which probes the trusted nodes' /healthz; nothing at all without the node settings.
 */
import { requireAccount, requireFresh, requirePrimary, shopClaim, shopGet } from './accountRoutes';
import type { SessionClaims } from './auth';
import { INTERNAL_HEADER, internalSecret } from './auth';
import { JSON_MAX_BYTES, error, flag, json, limitKey, nodesConfigured, trustedOperatorIds } from './env';
import type { Env, NodesEnv } from './env';
import { NODE_ROUTES, nodesStub } from './nodeApi';
import { edgeCache, widePrefix } from './limits';
import type { Limiter } from './limits';
import { REGISTER_PER_IP_PER_HOUR, REPLAY_MAX_BYTES, TOKENS_PER_ACCOUNT_PER_DAY } from './NodeRegistryDO';
import { PUBLIC_REPLAY_MAX_BYTES, publicReplay } from './replayIndex';
import type { ReplayIndexRow } from './replayIndex';
import { sha256Hex } from '../../nodes/shared/edcrypto';

/** What the index.ts router hands over: its rate limiter, the session and its CORS headers. */
export interface NodeRouteContext {
  env: Env;
  request: Request;
  url: URL;
  /** The client address (CF-Connecting-IP; 'local' under wrangler dev without it). */
  ip: string;
  /** The verified Bearer session, read only by the routes that need one. */
  session: () => Promise<SessionClaims | null>;
  /** limits.ts isolateLimited: true = over `max` in the current window (default one minute), in this isolate. */
  limited: (key: string, max: number, windowMs?: number) => boolean;
  /** limits.ts limiter: a rule of its table, counted across the location's isolates when the Worker has its binding. */
  limit: Limiter;
  /** CORS headers for this request (index.ts corsHeaders). */
  cors: Record<string, string>;
  /** The request's waitUntil (index.ts fetch's context): the edge cache's copy of a release file is written after the answer. */
  waitUntil?: (p: Promise<unknown>) => void;
}

/** The object's own limits (NodeRegistryDO.ts), here per isolate: junk stops before the object. */
const LIMIT_REGISTER_PER_IP = REGISTER_PER_IP_PER_HOUR;
const LIMIT_TOKENS_PER_ACCOUNT = TOKENS_PER_ACCOUNT_PER_DAY;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** A node uploads one replay per match: a full VPS ends a few matches a minute. */
const LIMIT_REPLAY_PUT_PER_IP = 60;
/** A verifier downloads one replay per job; counted apart from the uploads, which the same node makes. */
const LIMIT_REPLAY_GET_PER_IP = 60;
const LIMIT_STATUS_PER_IP = 60;
const LIMIT_MINE_PER_ACCOUNT = 30;
const LIMIT_ADMIN_PER_ACCOUNT = 30;
/**
 * A maintainer's session must come from a sign-in (or a re-authentication) this recent: a stolen
 * 1-hour Bearer or refresh cookie alone grants no item, mints no trusted node and drains nothing.
 */
export const MAINTAINER_FRESH_S = 15 * 60;
const STATUS_TTL_MS = 10_000;
/** The public replay list (anyone, guests included): a page per request at most, the first one cached. */
const LIMIT_REPLAY_LIST_PER_IP = 60;
/** A public replay: read from R2, hashed and rewritten (replayIndex.ts publicReplay) on an edge-cache miss. */
const LIMIT_REPLAY_VIEW_PER_IP = 30;
const REPLAY_LIST_TTL_MS = 30_000;
/** The maintainers' routes and the method of each. */
const ADMIN_ROUTES: Readonly<Record<string, 'GET' | 'POST'>> = { nodes: 'GET', status: 'POST', drain: 'POST', update: 'POST', reprobe: 'POST', grant: 'POST', revoke: 'POST', unfreeze: 'POST' };

/**
 * A release key: an optional X.Y.Z/ directory, then one file name. Nothing else is ever looked up in
 * the bucket, and no key comes near R2's 1,024-byte limit (a longer one would make the lookup throw).
 */
const RELEASE_KEY = /^(?:\d{1,6}\.\d{1,6}\.\d{1,6}\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VERSIONED = /^\d+\.\d+\.\d+\//;
const SEMVER = /^\d+\.\d+\.\d+$/;
const REPLAY_PATH = /^\/nodes\/replays\/([0-9a-f]{64})$/;
const REPLAY_VIEW_PATH = /^\/nodes\/replays\/([0-9a-f]{64})\/view$/;
const CORS_PATHS = new Set(['/nodes/tokens', '/nodes/mine', '/nodes/status', '/nodes/shop', '/nodes/shop/claim', '/nodes/replays']);
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
let replayListCache: { at: number; body: string } | null = null;

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
  // The hosts' shop lives in AccountsDO: a fork without nodes still has it (nothing to earn there).
  if ((method === 'GET' && path === '/nodes/shop') || (method === 'POST' && path === '/nodes/shop/claim')) {
    if (!env.JWT_SECRET) return error(404, 'not_found');
    const s = { env, request: c.request, session: await c.session(), limited: (key: string, max: number) => c.limited(key, max) };
    return method === 'GET' ? shopGet(s) : shopClaim(s);
  }
  if (!nodesConfigured(env) || !env.JWT_SECRET) return error(404, 'not_found');
  const who = limitKey(c.ip);
  if (method === 'POST' && path === '/nodes/register') {
    if (declared(c.request) > JSON_MAX_BYTES) return error(413, 'too_large');
    if (c.limited('nreg:' + who, LIMIT_REGISTER_PER_IP, HOUR_MS)) return error(429, 'rate_limited');
    return toRegistry(env, c.request, path, { 'x-client-ip': c.ip });
  }
  if (method === 'GET' && path === '/nodes/connect') {
    if (c.request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return error(426, 'upgrade_required');
    // Counted across the location's isolates: anonymous upgrades must not crowd the object's login slots.
    if ((await c.limit('nodeConnect', who)) || (await c.limit('nodeConnectWide', widePrefix(c.ip)))) return error(429, 'rate_limited');
    return toRegistry(env, c.request, path, { 'x-client-ip': c.ip });
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
    const s = requirePrimary({ session: await c.session() });
    if (s instanceof Response) return s;
    if (!trustedOperatorIds(env).has(s.sub)) return error(403, 'not_trusted', 'only the project creates node tokens for now');
    const fresh = requireFresh({ session: s }, MAINTAINER_FRESH_S);
    if (fresh instanceof Response) return fresh;
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
  if (method === 'GET' && path === '/nodes/replays') return replayList(c, env, who);
  const view = REPLAY_VIEW_PATH.exec(path);
  if (view && method === 'GET') return replayView(c, env, who, view[1]);
  const admin = path.startsWith('/nodes/admin/') ? path.slice('/nodes/admin/'.length) : '';
  if (Object.hasOwn(ADMIN_ROUTES, admin) && ADMIN_ROUTES[admin] === method) {
    if (declared(c.request) > JSON_MAX_BYTES) return error(413, 'too_large');
    const s = requirePrimary({ session: await c.session() });
    if (s instanceof Response) return s;
    if (!trustedOperatorIds(env).has(s.sub)) return error(403, 'not_trusted', 'only the project maintains the nodes');
    const fresh = requireFresh({ session: s }, MAINTAINER_FRESH_S);
    if (fresh instanceof Response) return fresh;
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
  if (!nodesConfigured(env) || !env.JWT_SECRET || (await flag(env, 'nodes_off'))) return;
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
  // The control plane's kill switch: read after the route's own limit, so a refused request costs no KV read.
  if (await flag(env, 'nodes_off')) {
    await request.body?.cancel().catch(() => undefined);
    return error(503, 'nodes_off', 'the community nodes are paused: try again later');
  }
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

/**
 * GET /nodes/replays[?before=<ms>]: the public replay list (src/net/replays.ts), a page of the
 * object's index. The first page is kept REPLAY_LIST_TTL_MS by each isolate (the object also
 * serves every heartbeat); a later page always asks it, under the per-address limit.
 */
async function replayList(c: NodeRouteContext, env: NodesEnv, who: string): Promise<Response> {
  if (c.limited('nrl:' + who, LIMIT_REPLAY_LIST_PER_IP)) return error(429, 'rate_limited');
  const now = Date.now();
  const raw = c.url.searchParams.get('before');
  // A cursor is a settle time in the past; anything else (junk, 0, the future) is the first page, the cached one.
  const before = raw !== null && /^\d{1,16}$/.test(raw) && Number(raw) > 0 && Number(raw) < now ? raw : null;
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${REPLAY_LIST_TTL_MS / 1000}`, ...c.cors };
  if (before === null && replayListCache && now - replayListCache.at <= REPLAY_LIST_TTL_MS) return new Response(replayListCache.body, { headers });
  const res = await toRegistry(env, new Request(c.request.url, { method: 'GET' }), NODE_ROUTES.replays + (before !== null ? `?before=${before}` : ''));
  if (!res.ok) {
    await res.body?.cancel();
    return error(503, 'nodes_unavailable');
  }
  const body = await res.text();
  if (before === null) replayListCache = { at: now, body };
  return new Response(body, { headers });
}

/**
 * GET /nodes/replays/<matchId>/view: a listed match's replay, made public (replayIndex.ts
 * publicReplay: the header rebuilt from the control plane's record, no account id, no node id). The
 * bytes come from R2 here, never through the object, and must still be the ones the node uploaded
 * (their SHA-256 is the index's). The answer never changes once listed: it is kept in the edge cache
 * (Cache API: a Worker's own responses are not cached otherwise), so a match watched by many asks
 * neither the object nor R2 again, and a day in any browser.
 */
async function replayView(c: NodeRouteContext, env: NodesEnv, who: string, matchId: string): Promise<Response> {
  if (c.limited('nrv:' + who, LIMIT_REPLAY_VIEW_PER_IP)) return error(429, 'rate_limited');
  const cache = edgeCache();
  const key = new Request(`${c.url.origin}/nodes/replays/${matchId}/view`, { method: 'GET' });
  const hit = cache ? await cache.match(key) : undefined;
  if (hit) return hit;
  const res = await toRegistry(env, new Request(c.request.url, { method: 'GET' }), `${NODE_ROUTES.replays}/${matchId}`);
  if (!res.ok) {
    await res.body?.cancel();
    return res.status === 404 ? error(404, 'no_replay') : error(503, 'nodes_unavailable');
  }
  const entry = (await res.json()) as ReplayIndexRow;
  const obj = await env.NODE_REPLAYS.get(matchId);
  if (!obj) return error(404, 'no_replay');
  if (obj.size > PUBLIC_REPLAY_MAX_BYTES) {
    await obj.body.cancel();
    return error(404, 'no_replay');
  }
  const bytes = new Uint8Array(await obj.arrayBuffer());
  if ((await sha256Hex(bytes)) !== entry.sha) return error(404, 'no_replay');
  let out: Uint8Array;
  try {
    out = publicReplay(bytes, entry.item);
  } catch {
    return error(404, 'no_replay');
  }
  const headers = {
    'content-type': 'application/octet-stream',
    'content-length': String(out.length),
    'cache-control': 'public, max-age=86400, immutable',
    'x-content-type-options': 'nosniff',
  };
  if (cache) {
    try {
      await cache.put(key, new Response(out.slice(), { headers }));
    } catch {
      /* a miss next time */
    }
  }
  return new Response(out, { headers });
}

/**
 * A file of R2 NODE_RELEASES: a checked key, its type, and caching that fits what it is. Limited
 * per network before the bucket. A version's files never change, so they are served from the
 * location's edge cache (Cache API) once one copy went out, without an R2 read; a HEAD or a
 * conditional GET of a root file reads only what it needs (R2's onlyIf: a matching ETag fetches
 * no body).
 */
async function release(c: NodeRouteContext, raw: string): Promise<Response> {
  const bucket = c.env.NODE_RELEASES;
  if (!bucket) return error(404, 'not_found');
  if (await c.limit('nodeReleases', limitKey(c.ip))) return error(429, 'rate_limited');
  let key: string;
  try {
    key = decodeURIComponent(raw);
  } catch {
    return error(404, 'not_found');
  }
  const head = c.request.method === 'HEAD';
  if (key === 'channel' || key === 'channel.json') return channel(bucket, head);
  // The URL parser already resolved every '..' segment; one hidden behind an encoded slash is refused here.
  if (!RELEASE_KEY.test(key) || key.includes('..')) return error(404, 'not_found');
  const versioned = VERSIONED.test(key);
  const cache = versioned ? edgeCache() : null;
  // One key per file: the query string and the caller's headers never make another copy.
  const cacheKey = cache ? `${c.url.origin}/nodes/releases/${key}` : '';
  const inm = c.request.headers.get('If-None-Match');
  if (cache) {
    const hit = await cache.match(cacheKey).catch(() => undefined);
    if (hit) return fromCopy(hit, head, inm);
  }
  const obj = head ? await bucket.head(key) : await bucket.get(key, inm ? { onlyIf: c.request.headers } : undefined);
  if (!obj) return error(404, 'not_found');
  const dot = key.lastIndexOf('.');
  const headers = new Headers({
    'content-type': (dot > key.lastIndexOf('/') ? TYPES[key.slice(dot)] : undefined) ?? 'application/octet-stream',
    etag: obj.httpEtag,
    // A version's files never change (a new release is a new version); the root ones (the launcher, the installers) do.
    'cache-control': versioned ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  const body = 'body' in obj ? (obj as R2ObjectBody).body : null;
  // R2 sends no body when the condition says the caller's copy is current (a weak or listed ETag too).
  if (inm === obj.httpEtag || (!head && body === null)) {
    await body?.cancel();
    return new Response(null, { status: 304, headers });
  }
  headers.set('content-length', String(obj.size));
  if (head) return new Response(null, { status: 200, headers });
  // A conditional GET whose ETag did not match: R2 skipped nothing, `body` is there (onlyIf only skips on a match).
  const res = new Response(body, { status: 200, headers });
  if (cache && c.waitUntil) c.waitUntil(cache.put(cacheKey, res.clone()).catch(() => undefined));
  return res;
}

/** A versioned file from the edge cache: 304 for its ETag, headers only for a HEAD. */
function fromCopy(hit: Response, head: boolean, inm: string | null): Response {
  const headers = new Headers(hit.headers);
  if (inm !== null && inm === headers.get('etag')) {
    void hit.body?.cancel();
    headers.delete('content-length');
    return new Response(null, { status: 304, headers });
  }
  if (head) {
    void hit.body?.cancel();
    return new Response(null, { status: 200, headers });
  }
  return new Response(hit.body, { status: 200, headers });
}

/** How long an isolate keeps the channel's answer: a new release reaches the launchers this much later. */
export const CHANNEL_TTL_MS = 30_000;
const channelCache = new WeakMap<R2Bucket, { at: number; status: number; body: string }>();

/**
 * GET /nodes/releases/channel: the channel the launchers follow, only when it reads as one. The
 * answer (a 404 or a 503 too) is kept CHANNEL_TTL_MS per isolate: one R2 read per isolate and
 * half minute, whoever asks. On the wire it stays no-store.
 */
async function channel(bucket: R2Bucket, head: boolean, now: number = Date.now()): Promise<Response> {
  let c = channelCache.get(bucket);
  if (!c || now - c.at > CHANNEL_TTL_MS) {
    c = { at: now, ...(await readChannel(bucket)) };
    channelCache.set(bucket, c);
  }
  const res = new Response(head ? null : c.body, { status: c.status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  return res;
}

async function readChannel(bucket: R2Bucket): Promise<{ status: number; body: string }> {
  const answer = (r: Response) => r.text().then((body) => ({ status: r.status, body }));
  const o = await bucket.get('channel.json');
  if (!o) return answer(error(404, 'no_channel'));
  let v: unknown = null;
  try {
    v = JSON.parse(await o.text());
  } catch {
    /* refused below */
  }
  const ch = (typeof v === 'object' && v !== null ? v : {}) as { stable?: unknown; minimum?: unknown };
  if (typeof ch.stable !== 'string' || !SEMVER.test(ch.stable) || typeof ch.minimum !== 'string' || !SEMVER.test(ch.minimum)) {
    // The object raises the ALERT when it reads it; a launcher that gets this keeps the release it runs.
    return answer(error(503, 'bad_channel'));
  }
  return { status: 200, body: JSON.stringify({ stable: ch.stable, minimum: ch.minimum }) };
}
