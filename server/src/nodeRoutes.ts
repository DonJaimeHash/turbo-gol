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
 *                                     signature before it reads the body; 413 over 16 MiB; 60 a minute each per
 *                                     network, 1,200 per /24 or /48 (limits.ts nodeReplay*)
 *   GET      /nodes/replays           the public replay list (anyone, guests included; src/net/replays.ts): the
 *                                     matches settled 1 hour to 30 days ago, by the hour (rounded) and then by
 *                                     id; ?before=<cursor> pages it, a cursor this Worker signed (anything else
 *                                     is the first page); the first page cached 30 s per isolate, a later one 5
 *                                     minutes in the location's edge cache; replayList / replaySite count only
 *                                     the pages that reach the object
 *   GET      /nodes/replays/<id>/view a served match's replay made public (replayIndex.ts: the header rebuilt
 *                                     from the control plane's record, no account or node id, no start time,
 *                                     hidden names as 'Jugador N'), its SHA-256 checked against the index;
 *                                     x-replay-verified 1 or 0; 404 for a void, unlisted, too recent, expired or
 *                                     delisted match, kept 5 minutes in the edge cache (a day, with an ALERT
 *                                     line, for a listed one that fails the checks); edge- and browser-cached 3
 *                                     hours (a delist, a hidden name reach every copy by then); replayView /
 *                                     replaySite count only the edge-cache misses
 *     Both carry X-Robots-Tag: noindex, and the KV flag replays_off turns both off (404, cached copies
 *     too, the object never asked) and nothing else.
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
 *   POST     /nodes/admin/unfreeze    the account (NodeRegistryDO.ts);
 *   POST     /nodes/admin/delist      { matchId, reason? }: a match out of the public replays (its row and its R2
 *                                     object), then its view purged here (Cache API) and, with CF_ZONE_ID and
 *                                     CF_PURGE_TOKEN, in every location (purgeEverywhere)
 *   GET      /nodes/shop              aliases of GET /api/me/shop and POST /api/me/shop/claim (accountRoutes.ts,
 *   POST     /nodes/shop/claim        AccountsDO): answered with or without the node settings
 *   GET      /nodes/admin/account-stats  the owner's account counts (AccountsDO, accountStore.ts AccountStats): counts
 *                                     and booleans only, never an id or an address; behind the maintainer gate (a
 *                                     trusted account's own session, not a TV's, fresh within MAINTAINER_FRESH_S),
 *                                     10 a minute per account (limits.ts accountStats), no-store, no CORS. The node
 *                                     operators' ids come from the object (/internal/operators) and go on to AccountsDO
 *                                     only; without the node settings the node counts are null
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
import { accountsCall, requireAccount, requireFresh, requirePrimary, shopClaim, shopGet } from './accountRoutes';
import { STATS_OPERATORS_MAX, STATS_TRUSTED_MAX } from './AccountsDO';
import type { SessionClaims } from './auth';
import { INTERNAL_HEADER, internalSecret } from './auth';
import { JSON_MAX_BYTES, error, flag, isHex, json, limitKey, nodesConfigured, trustedOperatorIds, withTimeout } from './env';
import type { Env, NodesEnv } from './env';
import { NODE_ROUTES, OPERATORS_ROUTE, nodesStub } from './nodeApi';
import { accountGate, edgeCache, overLimit, sitePrefix, subjectsOf, widePrefix } from './limits';
import type { LimitName, Limiter } from './limits';
import { REGISTER_PER_IP_PER_HOUR, REPLAY_MAX_BYTES, TOKENS_PER_ACCOUNT_PER_DAY } from './NodeRegistryDO';
import { PUBLIC_REPLAY_MAX_BYTES, publicReplay } from './replayIndex';
import type { ReplayIndexRow } from './replayIndex';
import { REPLAY_VERIFIED_HEADER } from '../../src/net/replays';
import type { ReplayList } from '../../src/net/replays';
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
const LIMIT_STATUS_PER_IP = 60;
const LIMIT_MINE_PER_ACCOUNT = 30;
const LIMIT_ADMIN_PER_ACCOUNT = 30;
/**
 * A maintainer's session must come from a sign-in (or a re-authentication) this recent: a stolen
 * 1-hour Bearer or refresh cookie alone grants no item, mints no trusted node and drains nothing.
 */
export const MAINTAINER_FRESH_S = 15 * 60;
const STATUS_TTL_MS = 10_000;
/** The public replay list's first page, kept by each isolate (and by browsers). */
const REPLAY_LIST_TTL_MS = 30_000;
/** A later page (a signed cursor) in the location's edge cache: it changes only as rows age out, a delist or a hidden name. */
export const REPLAY_PAGE_EDGE_S = 300;
/** A public replay's copies, in the edge cache and in browsers: a delist or a hidden name reaches every copy within this. */
export const REPLAY_VIEW_MAX_AGE_S = 3 * 3600;
/** A view the object does not serve (never listed, its hour not released yet, expired, delisted): kept this long in the edge cache. */
export const REPLAY_MISSING_S = 300;
/** A listed replay that fails the public checks (junk a node stored), and a delisted one here: this long. */
export const REPLAY_BROKEN_S = 86_400;
/** How long an isolate keeps the KV flag replays_off: one KV read per isolate this often, cache hits included. */
const REPLAYS_OFF_TTL_MS = 30_000;
/** The maintainers' routes and the method of each. */
const ADMIN_ROUTES: Readonly<Record<string, 'GET' | 'POST'>> = { nodes: 'GET', status: 'POST', drain: 'POST', update: 'POST', reprobe: 'POST', grant: 'POST', revoke: 'POST', unfreeze: 'POST', delist: 'POST' };

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
/** The replay list's first page per NodeRegistryDO namespace (one per isolate in production, as channelCache keys its bucket). */
const replayListCache = new WeakMap<object, { at: number; body: string }>();

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
  // The public replays are no search engine's to keep: every answer of theirs says so (replay.html has its meta tag).
  const robots = path === '/nodes/replays' || REPLAY_VIEW_PATH.test(path);
  if (!cors && !robots) return res; // a 101 among them: passed through untouched
  const out = new Response(res.body, res);
  if (cors) for (const k in c.cors) out.headers.set(k, c.cors[k]);
  if (robots) out.headers.set('x-robots-tag', 'noindex');
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
  // The account counts live in AccountsDO: a fork without nodes has them too, without the node columns.
  if (method === 'GET' && path === ACCOUNT_STATS_PATH) return env.JWT_SECRET ? accountStats(c, env) : error(404, 'not_found');
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
    // Counted across the location's isolates: the object checks the signature, so junk reaches it until then.
    if ((await c.limit('nodeReplayPut', who)) || (await c.limit('nodeReplayWide', widePrefix(c.ip)))) return error(429, 'rate_limited');
    return toRegistry(env, c.request, path);
  }
  if (replay && method === 'GET') {
    if ((await c.limit('nodeReplayGet', who)) || (await c.limit('nodeReplayWide', widePrefix(c.ip)))) return error(429, 'rate_limited');
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
  if (method === 'GET' && path === '/nodes/replays') return replayList(c, env);
  const view = REPLAY_VIEW_PATH.exec(path);
  if (view && method === 'GET') return replayView(c, env, view[1]);
  const admin = path.startsWith('/nodes/admin/') ? path.slice('/nodes/admin/'.length) : '';
  if (Object.hasOwn(ADMIN_ROUTES, admin) && ADMIN_ROUTES[admin] === method) {
    if (declared(c.request) > JSON_MAX_BYTES) return error(413, 'too_large');
    const s = requirePrimary({ session: await c.session() });
    if (s instanceof Response) return s;
    if (!trustedOperatorIds(env).has(s.sub)) return error(403, 'not_trusted', 'only the project maintains the nodes');
    const fresh = requireFresh({ session: s }, MAINTAINER_FRESH_S);
    if (fresh instanceof Response) return fresh;
    if (c.limited('nadm:' + s.sub, LIMIT_ADMIN_PER_ACCOUNT)) return error(429, 'rate_limited');
    const res = await toRegistry(env, c.request, path, operator(s));
    return admin === 'delist' && res.ok ? delisted(c, env, res) : res;
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

const ACCOUNT_STATS_PATH = '/nodes/admin/account-stats';

/**
 * GET /nodes/admin/account-stats: the owner's account counts (accountStore.ts AccountStats), behind
 * the maintainer gate of every /nodes/admin/* route (a trusted account's own session, not a TV's,
 * that proved a credential within MAINTAINER_FRESH_S), then its limit. The answer is AccountsDO's,
 * counts and booleans only; the node operators' ids travel from the object to AccountsDO and never
 * into it.
 */
async function accountStats(c: NodeRouteContext, env: Env): Promise<Response> {
  const s = requirePrimary({ session: await c.session() });
  if (s instanceof Response) return s;
  const trusted = trustedOperatorIds(env);
  if (!trusted.has(s.sub)) return error(403, 'not_trusted', 'only the project reads the account counts');
  const fresh = requireFresh({ session: s }, MAINTAINER_FRESH_S);
  if (fresh instanceof Response) return fresh;
  if ((await overLimit(c.limit, accountGate('GET', ACCOUNT_STATS_PATH), subjectsOf(c.ip, s))) !== null) return error(429, 'rate_limited');
  const operatorIds = nodesConfigured(env) ? await operatorIdsOf(env) : null;
  const res = await accountsCall(env, '/account-stats', { operatorIds, trusted: [...trusted].slice(0, STATS_TRUSTED_MAX) });
  const out = new Response(res.body, res);
  out.headers.set('cache-control', 'no-store');
  return out;
}

/** The object's node operators (/internal/operators), or null when it cannot say (paused, unavailable, more than one body holds). */
async function operatorIdsOf(env: NodesEnv): Promise<string[] | null> {
  try {
    const res = await toRegistry(env, new Request('https://nodes' + OPERATORS_ROUTE, { method: 'GET' }), OPERATORS_ROUTE);
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const b = (await res.json()) as { operators?: unknown };
    if (!Array.isArray(b.operators) || b.operators.length > STATS_OPERATORS_MAX) return null;
    return b.operators.filter((id): id is string => isHex(id, 16));
  } catch {
    return null;
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

// ---- the public replays (src/net/replays.ts, docs/replays.md) ----------------------------------------

const enc = new TextEncoder();
const replaysOffMemo = new WeakMap<object, { at: number; on: boolean }>();

/**
 * The KV flag replays_off (server/README.md, "Kill switches"): the public list and view only, the
 * nodes and everything else go on. Kept REPLAYS_OFF_TTL_MS per isolate: it is read before the
 * caches (a cached copy must stop too), so it must not cost a KV read per request.
 */
async function replaysOff(env: NodesEnv, now: number = Date.now()): Promise<boolean> {
  const m = replaysOffMemo.get(env.FLAGS);
  if (m && now - m.at < REPLAYS_OFF_TTL_MS) return m.on;
  const on = await flag(env, 'replays_off');
  replaysOffMemo.set(env.FLAGS, { at: now, on });
  return on;
}

/** The 404 of a replay that is not served; never kept by a browser (it may be listed within the hour). */
function noReplay(): Response {
  return error(404, 'no_replay', 'this replay is not available');
}

/** Over the public replays' limits (limits.ts): `rule` per network, and replaySite per IPv6 /48. Only the requests that reach the object are counted. */
async function overReplayLimit(c: NodeRouteContext, rule: LimitName): Promise<boolean> {
  return (await c.limit(rule, limitKey(c.ip))) || (await c.limit('replaySite', sitePrefix(c.ip)));
}

let cursorKeyCache: { secret: string; key: Promise<CryptoKey> } | null = null;

/** The key that signs the list's cursors: HKDF of JWT_SECRET under a label of its own, never a token's key. */
function cursorKey(secret: string): Promise<CryptoKey> {
  if (cursorKeyCache && cursorKeyCache.secret === secret) return cursorKeyCache.key;
  const key = (async () => {
    const ikm = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('turbogol/hkdf/v2'), info: enc.encode('replay-cursor') }, ikm, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
  })();
  cursorKeyCache = { secret, key };
  return key;
}

async function cursorMac(secret: string, plain: string): Promise<string> {
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await cursorKey(secret), enc.encode(plain)));
  let s = '';
  for (let i = 0; i < 16; i++) s += (mac[i] < 16 ? '0' : '') + mac[i].toString(16);
  return s;
}

/** A page's cursor as the public gets it: the object's `<hour>.<matchId>` and its MAC. */
async function signCursor(secret: string, plain: string): Promise<string> {
  return `${plain}.${await cursorMac(secret, plain)}`;
}

const SIGNED_CURSOR = /^(\d{1,10}\.[0-9a-f]{64})\.([0-9a-f]{32})$/;

/** The object's cursor in a signed one, or null for anything this Worker did not sign (the first page then). */
async function readCursor(secret: string, raw: string | null): Promise<string | null> {
  const m = SIGNED_CURSOR.exec(raw ?? '');
  if (!m) return null;
  const want = await cursorMac(secret, m[1]);
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ m[2].charCodeAt(i);
  return diff === 0 ? m[1] : null;
}

/** Keep, under `key` in the location's edge cache, that this view is not served (a 200 marker: any status may be cached so). */
async function rememberMissing(cache: Cache | null, key: string, seconds: number): Promise<void> {
  if (!cache) return;
  try {
    await cache.put(key, new Response('no_replay', { headers: { 'content-type': 'text/plain', 'cache-control': `public, max-age=${seconds}` } }));
  } catch {
    /* the next request asks the object again */
  }
}

/** The edge-cache keys of a match's view and of its "not served" marker (never a path the router answers). */
function viewKeys(c: NodeRouteContext, matchId: string): { view: string; missing: string } {
  const view = `${c.url.origin}/nodes/replays/${matchId}/view`;
  return { view, missing: `${c.url.origin}/nodes/_cache/replay-missing/${matchId}` };
}

/**
 * GET /nodes/replays[?before=<cursor>]: the public replay list (src/net/replays.ts), a page of the
 * object's index as the public sees it (NodeRegistryDO replays: whole settle hours, 1 to 2 hours
 * after they settled, the time rounded to the hour, hidden names). The first page is kept REPLAY_LIST_TTL_MS by each
 * isolate; a later one needs a cursor this Worker signed (`next`, HMAC: the object is never asked
 * about a cursor anyone made up, which reads as the first page) and is kept REPLAY_PAGE_EDGE_S in
 * the location's edge cache, so the keys that can reach the object are as many as the rows. Only a
 * page that reaches the object counts against replayList and replaySite.
 */
async function replayList(c: NodeRouteContext, env: NodesEnv): Promise<Response> {
  if (await replaysOff(env)) return error(404, 'not_found', 'the public replays are off');
  const now = Date.now();
  const raw = c.url.searchParams.get('before');
  const after = await readCursor(env.JWT_SECRET, raw);
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${REPLAY_LIST_TTL_MS / 1000}` };
  const first = after === null ? replayListCache.get(env.NODES) : undefined;
  if (first && now - first.at <= REPLAY_LIST_TTL_MS) return new Response(first.body, { headers });
  const cache = after !== null ? edgeCache() : null;
  const key = `${c.url.origin}/nodes/replays?before=${encodeURIComponent(raw ?? '')}`;
  if (cache) {
    const hit = await cache.match(key).catch(() => undefined);
    if (hit) return new Response(hit.body, { headers });
  }
  if (await overReplayLimit(c, 'replayList')) return error(429, 'rate_limited');
  const res = await toRegistry(env, new Request(c.request.url, { method: 'GET' }), NODE_ROUTES.replays + (after !== null ? `?after=${after}` : ''));
  if (!res.ok) {
    await res.body?.cancel();
    return error(503, 'nodes_unavailable');
  }
  const page = (await res.json()) as ReplayList;
  const body = JSON.stringify({ matches: page.matches, next: page.next !== null ? await signCursor(env.JWT_SECRET, page.next) : null } satisfies ReplayList);
  if (after === null) replayListCache.set(env.NODES, { at: now, body });
  else if (cache) {
    try {
      await cache.put(key, new Response(body, { headers: { ...headers, 'cache-control': `public, max-age=${REPLAY_PAGE_EDGE_S}` } }));
    } catch {
      /* the next request asks the object again */
    }
  }
  return new Response(body, { headers });
}

/**
 * GET /nodes/replays/<matchId>/view: a served match's replay, made public (replayIndex.ts
 * publicReplay: the header rebuilt from the control plane's record as the object serves it, no
 * account id, no node id, no start time, hidden names). The bytes come from R2 here, never through
 * the object, and must still be the ones the node uploaded (their SHA-256 is the index's). The
 * answer is kept REPLAY_VIEW_MAX_AGE_S in the location's edge cache (Cache API: a Worker's own
 * responses are not cached otherwise) and in browsers, so a match watched by many asks neither the
 * object nor R2 again, and a delist or a hidden name still reaches every copy within hours. A view
 * the object does not serve is remembered REPLAY_MISSING_S (random ids, a match not released yet);
 * a listed one that fails the checks REPLAY_BROKEN_S, with an ALERT line: its up to 4 MiB are read,
 * hashed and walked once a day per location, not at every view. Only a request past both caches
 * counts against replayView and replaySite.
 */
async function replayView(c: NodeRouteContext, env: NodesEnv, matchId: string): Promise<Response> {
  if (await replaysOff(env)) return noReplay();
  const cache = edgeCache();
  const keys = viewKeys(c, matchId);
  if (cache) {
    const hit = await cache.match(keys.view).catch(() => undefined);
    if (hit) return hit;
    const gone = await cache.match(keys.missing).catch(() => undefined);
    if (gone) {
      void gone.body?.cancel(); // as fromCopy: a copy's body is never waited on
      return noReplay();
    }
  }
  if (await overReplayLimit(c, 'replayView')) return error(429, 'rate_limited');
  const res = await toRegistry(env, new Request(c.request.url, { method: 'GET' }), `${NODE_ROUTES.replays}/${matchId}`);
  if (!res.ok) {
    await res.body?.cancel();
    if (res.status !== 404) return error(503, 'nodes_unavailable');
    await rememberMissing(cache, keys.missing, REPLAY_MISSING_S);
    return noReplay();
  }
  const entry = (await res.json()) as ReplayIndexRow;
  const broken = async (why: string): Promise<Response> => {
    console.error(`ALERT replay ${matchId} is listed but not served (${why}): its 404 is kept a day here; delist it (POST /nodes/admin/delist)`);
    await rememberMissing(cache, keys.missing, REPLAY_BROKEN_S);
    return noReplay();
  };
  const obj = await env.NODE_REPLAYS.get(matchId);
  if (!obj) return broken('no R2 object');
  if (obj.size > PUBLIC_REPLAY_MAX_BYTES) {
    await obj.body.cancel();
    return broken(`${obj.size} bytes`);
  }
  const bytes = new Uint8Array(await obj.arrayBuffer());
  if ((await sha256Hex(bytes)) !== entry.sha) return broken('not the bytes the node uploaded');
  let out: Uint8Array;
  try {
    out = publicReplay(bytes, entry.item);
  } catch (e) {
    return broken(String(e));
  }
  const headers = {
    'content-type': 'application/octet-stream',
    'content-length': String(out.length),
    'cache-control': `public, max-age=${REPLAY_VIEW_MAX_AGE_S}`,
    'x-content-type-options': 'nosniff',
    'x-robots-tag': 'noindex',
    [REPLAY_VERIFIED_HEADER]: entry.item.verified ? '1' : '0',
  };
  if (cache) {
    try {
      await cache.put(keys.view, new Response(out.slice(), { headers }));
    } catch {
      /* a miss next time */
    }
  }
  return new Response(out, { headers });
}

/**
 * After the object delisted a match (POST /nodes/admin/delist): its view purged from this
 * location's edge cache and remembered as gone here for REPLAY_BROKEN_S, this isolate's first page
 * dropped, and with CF_ZONE_ID and CF_PURGE_TOKEN the view purged in every location too
 * (purgeEverywhere). Without them, another location's copy lasts REPLAY_VIEW_MAX_AGE_S at most.
 */
async function delisted(c: NodeRouteContext, env: NodesEnv, res: Response): Promise<Response> {
  const answer = (await res.json()) as { matchId: string };
  replayListCache.delete(env.NODES);
  const cache = edgeCache();
  const keys = viewKeys(c, answer.matchId);
  let here = false;
  if (cache) {
    try {
      await cache.delete(keys.view);
      here = true;
    } catch {
      /* reported below */
    }
    await rememberMissing(cache, keys.missing, REPLAY_BROKEN_S);
  }
  const everywhere = await purgeEverywhere(env, keys.view);
  return json({ ...answer, purged: { here, everywhere } }, 200, { 'cache-control': 'no-store' });
}

/**
 * One URL purged from the zone's cache in every Cloudflare location (the API's purge by URL, which
 * covers Cache API copies). null without CF_ZONE_ID and CF_PURGE_TOKEN, else whether the API said
 * it was done (5 s at most). Never throws.
 */
async function purgeEverywhere(env: NodesEnv, url: string): Promise<boolean | null> {
  if (!env.CF_ZONE_ID || !env.CF_PURGE_TOKEN) return null;
  try {
    const res = await withTimeout(
      fetch(`https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(env.CF_ZONE_ID)}/purge_cache`, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.CF_PURGE_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ files: [url] }),
      }),
      5000,
    );
    const body = (await res.json().catch(() => null)) as { success?: unknown } | null;
    if (res.ok && body?.success === true) return true;
    console.error(`replay delist: the zone purge of ${url} answered ${res.status}`);
    return false;
  } catch (e) {
    console.error(`replay delist: the zone purge of ${url} failed: ${String(e)}`);
    return false;
  }
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
