/**
 * Edge Worker: HTTP control plane + WebSocket gate in front of the Durable Objects.
 *
 *   POST /api/guest   { turnstileToken? }               -> GuestSession (24 h HS256 session). The name is the
 *                       server's, 'Invitado 4821' from the player id (src/net/guestName.ts); a `name` sent is
 *                       ignored
 *   POST /api/queue   { mode, kind?, p2pProtocol? }  Bearer session
 *                    -> long-poll <= 25 s: QueueResultP2p (kind 'p2p', the default:
 *                       a RoomDO signaling room, wsUrl ws(s)://host/room/<roomId>) or the phase 1 QueueResult
 *                       (kind 'server', or the p2p fallback for a lone human: a MatchDO match, wsUrl /ws/<matchId>;
 *                       or, with the nodes on, a match on a community node: node: true, wsUrl the node's own wss://);
 *                       426 'reload_required' for kind 'p2p' without this server's P2P protocol in p2pProtocol (a stale
 *                       page); 429 'no_show' { retryAfterMs } from the matchmaker (room tickets left unused, p2p only);
 *                       400 'experimental_lobby_only' for a body that carries `physics`: experimental rules
 *                       exist only in custom P2P lobbies, never in the casual or ranked queues. The seat's
 *                       car comes from the session (an account's `car` claim, seatFields), never from the
 *                       body; a node match's result carries the match's `cars` by slot (src/net/cosmetics.ts)
 *   POST /api/rejoin  { matchId } Bearer session        -> QueueResult with a fresh ticket (MatchDO and node matches, a node
 *                       match's with its `cars`; a RoomDO room id answers 410 'p2p_room': a P2P room is never
 *                       rejoined, POST /api/leave frees its lock;
 *                       a match the player quit with POST /api/leave { matchId } answers 410 'left', or 404 once
 *                       that quit was its last human's: the match ended). An id no MatchDO, RoomDO or node match
 *                       has: 404 and its lock freed; a node out of reach for now: 503 and the lock kept (nodeRejoin)
 *   POST /api/leave   { matchId?, connected? } Bearer   -> { ok, left, released }: drop the player from the queue (while still
 *                       waiting) and free its P2P room lock (the room closes the player's socket: 'peerLeft' to the others);
 *                       with the matchId of its SERVER match (an explicit quit) that lock is freed too and the MatchDO
 *                       closes the player's socket, flags the slot left (no rejoin) and hands its car to the host's bots
 *                       (the last human's quit ends the match: locks and capacity released).
 *                       Without a matchId a server lock stays (a reload / network drop rejoins on the next queue's 409).
 *                       A node match is quit the same way, the node first: its lock stays (released: false) when the
 *                       node did not take the leave. connected: false (never got in) is passed on to the node only
 *   POST /api/lobbies { name?, password?, mode, visibility, net, matchLengthSeconds, physics?, region? } Bearer
 *                    -> LobbyTicketAnswer (LobbyDO.ts); `physics` (experimental rules) from a guest session:
 *                       403 'account_required' (a lobby with them takes signed-in players only). The title is
 *                       the host's name unless an account sends one: a guest's `name` is ignored, an account's
 *                       reserved one (src/net/account.ts lobbyNameIssue) answers 400 'name_reserved'
 *   POST /api/lobbies/join { code, password? } Bearer -> LobbyTicketAnswer; a guest into a lobby with
 *                       experimental rules: 403 'account_required' (LobbyDO)
 *   GET  /api/lobbies/peek?code= (no auth)            -> LobbySummary of the lobby with that code (a join
 *                       link's "Join lobby ABC234 · 2v2 · 2/4?"); 404 no_lobby, 410 closed
 *   GET  /api/ice     Bearer session                    -> { iceServers }: Cloudflare STUN always, plus 10-minute TURN
 *                       credentials minted per request when TURN_KEY_ID / TURN_KEY_TOKEN are set (env.ts)
 *   GET  /ws/:matchId   Sec-WebSocket-Protocol: tg1, ticket.<jwt>  -> 101 (ticket verified here,
 *                       claims forwarded to the MatchDO in x-* headers plus the internal header;
 *                       bad tickets never touch a DO)
 *   GET  /room/:roomId  same gate with a role 'peer' ticket whose mid is the room id -> RoomDO (phase 2 signaling)
 *   GET  /api/config  -> { turnstileSiteKey: TURNSTILE_SITEKEY | null, protocol, version, region: cf.colo | 'local',
 *                        autoRegion, regions, oauth, accounts, botFillMs: the server queue's bot fill (BOT_FILL_MS) }
 *                        (no auth; the client fetches it once per page load before its first POST /api/guest)
 *   GET  /api/health, GET /api/time
 *   GET  /api/where     -> { edgeColo, country, city?, asn?, ip }: the Cloudflare colo that served the
 *                       request (request.cf), the client address masked to /24 (IPv6: /48); for the
 *                       deploy measurements (docs/online/PHASE1.md), no secret needed
 *   /nodes/*            -> the community nodes: their registration, control socket, replays and
 *                       releases, and the project's operator and maintainer routes (nodeRoutes.ts,
 *                       NodeRegistryDO.ts)
 *   cron                every 5 minutes (wrangler.jsonc triggers): the community nodes' health check
 *                       (nodeRoutes.ts nodeHealthCheck), one NodeRegistryDO call; none without the node settings
 *   everything else     -> the game: Workers Assets (wrangler.jsonc `assets` = the Vite build in
 *                       ../dist, SPA fallback). Only /api/*, /ws/*, /room/*, /lobby/* and /nodes/* are
 *                       routed to this code (run_worker_first); the asset fallback below covers what
 *                       still arrives.
 *
 * Rate limits (fixed windows, one minute unless a route says otherwise, in-memory per isolate, best
 * effort; 429 'rate_limited'):
 *   /api/guest   10 per client IP (CF-Connecting-IP)        every guest can open a room: bound it
 *   /api/queue   20 per playerId
 *   /api/rejoin  10 per playerId and 30 per client IP      each call mints a ticket (join banner spam)
 *   /api/leave   30 per client IP
 *   /api/ice     30 per playerId                           each call may mint TURN credentials
 *   /nodes/*     see nodeRoutes.ts (the NodeRegistryDO holds the hourly and daily ones)
 * Turnstile: outside local dev (wrangler dev on localhost / 127.0.0.1) POST /api/guest requires
 * TURNSTILE_SECRET; a deploy without it answers 503 'turnstile_unconfigured', as does one with the
 * secret but no TURNSTILE_SITEKEY var when the request carries no token (the browser only renders
 * the widget when /api/config hands it a sitekey). A bad / missing token -> 403 'turnstile_failed'.
 * TURNSTILE_DISABLED="1" (var) turns the whole check off and hides the sitekey (pre-production only).
 * CORS: VITE_ORIGINS (comma list) or '*' when unset (dev). When VITE_ORIGINS is set a WebSocket
 * upgrade whose Origin is outside the list is refused (403 'bad_origin'); a request without Origin
 * (non-browser client) is let through to the ticket check.
 * Flags (KV FLAGS): matchmaking_off, do_disabled -> 503. do_disabled also stops /api/queue, so no
 * new room is created while its sockets would be refused; for a player the nodes are on for, only
 * its p2p queue (server and ranked matches then wait for a node; where none can host now, the
 * matchmaker refuses them itself: doDisabled in its /join). nodes_on (absent: off; '1':
 * everyone; a list of account ids: a canary) lets matches go to community nodes, vm_disabled turns
 * them off again (env.ts nodesMode; the matchmaker decides per match, MatchmakerDO.ts).
 */
import type { Env } from './env';
import { EXPERIMENTAL_REFUSED, SERVER_VERSION, carriesPhysics, error, flag, iceServersFor, isHex, isMode, isModeList, isQueueKind, json, nodesAllowed, nodesConfigured, nodesMode, readJson, sanitizeName } from './env';
import type { GameModeId } from './env';
import { accountRoute, accountsCall, enabledProviders } from './accountRoutes';
import type { RankedCheck } from './accountStore';
import { normalizeCode } from './LobbyDirectoryDO';
import { sanitizeLobbyName } from './LobbyDO';
import { isRegion, lobbyNameIssue, REGIONS } from '../../src/net/account';
import { guestNameOf } from '../../src/net/guestName';
import type { LobbySummary, LobbyTicketAnswer, PopulationAnswer, RegionId } from '../../src/net/account';
import { INTERNAL_HEADER, createSession, createTicket, internalSecret, randomHex, verifySession, verifyTicket } from './auth';
import type { SessionClaims, TicketRole } from './auth';
import { BOT_FILL_MS, isP2pResult } from './MatchmakerDO';
import type { AnyQueueResult } from './MatchmakerDO';
import { RELOAD_REQUIRED, ROOM_PROTOCOL } from './RoomDO';
import { nodeHealthCheck, nodeRoute } from './nodeRoutes';
import { NODE_ROUTES, askNodes, rejoinTicketOf, replyCode } from './nodeApi';
import type { NodesReply } from './nodeApi';
import { PROTOCOL_VERSION, WS_SUBPROTOCOL, WS_TICKET_PREFIX } from '../../src/net/protocol';
import type { GuestSession, QueueResult } from '../../src/net/protocol';
import type { CosmeticQueueResult } from '../../src/net/cosmetics';
import type { CarId } from '../../src/game/cosmetics';

export { MatchDO } from './MatchDO';
export { MatchmakerDO } from './MatchmakerDO';
export { RoomDO } from './RoomDO';
export { AccountsDO } from './AccountsDO';
export { LobbyDO } from './LobbyDO';
export { LobbyDirectoryDO } from './LobbyDirectoryDO';
export { NodeRegistryDO } from './NodeRegistryDO';

const LIMIT_WINDOW_MS = 60_000;
const LIMIT_QUEUE_PER_PLAYER = 20;
const LIMIT_GUEST_PER_IP = 10;
const LIMIT_REJOIN_PER_PLAYER = 10;
const LIMIT_REJOIN_PER_IP = 30;
const LIMIT_LEAVE_PER_IP = 30;
const LIMIT_ICE_PER_PLAYER = 30;
const LIMIT_LOBBY_CREATE_PER_PLAYER = 5;
const LIMIT_LOBBY_JOIN_PER_PLAYER = 20;
const LIMIT_LOBBY_LIST_PER_IP = 60;
const LIMIT_POPULATION_PER_IP = 60;

/** The two WebSocket gates: the ticket role each one accepts and the Durable Object it forwards to. */
const SOCKET_GATES = {
  '/ws/': { role: 'player', binding: 'MATCH', badId: 'bad_match_id' },
  '/room/': { role: 'peer', binding: 'ROOM', badId: 'bad_room_id' },
  '/lobby/': { role: 'lobby', binding: 'LOBBY', badId: 'bad_lobby_id' },
} as const satisfies Record<string, { role: TicketRole; binding: 'MATCH' | 'ROOM' | 'LOBBY'; badId: string }>;
type SocketGate = (typeof SOCKET_GATES)[keyof typeof SOCKET_GATES];
const rateLimits = new Map<string, { n: number; resetAt: number }>();
let limitCalls = 0;

/** Fixed-window counter: true when `key` was hit more than `max` times in its current window of `windowMs`. */
function rateLimited(key: string, max: number, now: number, windowMs: number = LIMIT_WINDOW_MS): boolean {
  if (++limitCalls % 256 === 0) for (const [k, v] of rateLimits) if (v.resetAt <= now) rateLimits.delete(k);
  const e = rateLimits.get(key);
  if (!e || e.resetAt <= now) {
    rateLimits.set(key, { n: 1, resetAt: now + windowMs });
    return false;
  }
  return ++e.n > max;
}

/** Cloudflare sets CF-Connecting-IP at the edge (clients cannot forge it); wrangler dev sets it too. */
function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'local';
}

function isLoopbackHost(h: string): boolean {
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost');
}

/** Served from a local host (wrangler dev): Turnstile may stay off. */
function isLocalDev(request: Request): boolean {
  return isLoopbackHost(new URL(request.url).hostname);
}

function allowedOrigins(env: Env): string[] {
  return (env.VITE_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * VITE_ORIGINS lists the browser origins allowed for CORS and WebSocket upgrades (empty = any).
 * While the Worker itself is reached on a loopback host (wrangler dev) a page from a loopback
 * origin, i.e. the Vite dev server on any port, is allowed as well: a deployed Worker never sees a
 * loopback request host, so the production list stays exact.
 */
function originAllowed(request: Request, env: Env, origin: string): boolean {
  const list = allowedOrigins(env);
  if (list.length === 0 || list.includes(origin)) return true;
  if (!isLocalDev(request)) return false;
  try {
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin');
  const list = allowedOrigins(env);
  const allow = list.length === 0 ? '*' : origin && originAllowed(request, env, origin) ? origin : list[0];
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

function withCors(res: Response, cors: Record<string, string>): Response {
  const out = new Response(res.body, res);
  for (const k in cors) out.headers.set(k, cors[k]);
  return out;
}

async function bearerSession(request: Request, env: Env): Promise<SessionClaims | null> {
  const auth = request.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return null;
  return verifySession(env.JWT_SECRET, auth.slice(7).trim());
}

/** The continent Cloudflare sees the request from ('dev' under wrangler dev without cf data). */
function autoRegion(request: Request, env: Env): string {
  if (env.REGION_OVERRIDE) return env.REGION_OVERRIDE;
  const cf = request.cf;
  const continent = cf && typeof cf.continent === 'string' ? cf.continent : '';
  return continent || 'dev';
}

/**
 * The matchmaking region: the one the player picked in the menu (a REGIONS id; the client sends
 * it on queue, leave and rejoin so all three reach the same matchmaker), else the automatic one.
 */
function regionOf(request: Request, env: Env, chosen?: unknown): string {
  if (env.REGION_OVERRIDE) return env.REGION_OVERRIDE;
  return isRegion(chosen) ? chosen : autoRegion(request, env);
}

function matchmakerOf(request: Request, env: Env, chosen?: unknown): { stub: DurableObjectStub; region: string } {
  const region = regionOf(request, env, chosen);
  return { stub: env.MATCHMAKER.get(env.MATCHMAKER.idFromName('mm:' + region)), region };
}

async function internalHeaders(env: Env, region?: string): Promise<Record<string, string>> {
  const h: Record<string, string> = { [INTERNAL_HEADER]: await internalSecret(env.JWT_SECRET), 'content-type': 'application/json' };
  if (region !== undefined) h['x-region'] = region;
  return h;
}

/** Public client configuration (GET /api/config, no auth): mirrors ServerConfig in src/net/NetClient.ts. */
function serverConfig(
  request: Request,
  env: Env,
): { turnstileSiteKey: string | null; protocol: number; version: string; region: string; autoRegion: string; regions: typeof REGIONS; oauth: string[]; accounts: boolean; botFillMs: number } {
  const cf = request.cf;
  const colo = cf && typeof cf.colo === 'string' ? cf.colo : '';
  return {
    turnstileSiteKey: env.TURNSTILE_DISABLED === '1' ? null : env.TURNSTILE_SITEKEY ? env.TURNSTILE_SITEKEY : null,
    protocol: PROTOCOL_VERSION,
    version: SERVER_VERSION,
    region: colo || 'local',
    autoRegion: autoRegion(request, env),
    regions: REGIONS,
    oauth: enabledProviders(env),
    accounts: true,
    // When a server queue fills with bots: the menus count it down (MODOS' searching panel).
    botFillMs: BOT_FILL_MS,
  };
}

/** Absolute socket URL on this Worker's own origin (ws for http, wss for https). */
function socketUrl(request: Request, path: string): string {
  const u = new URL(request.url);
  const scheme = u.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${u.host}${path}`;
}

// ---- static client + /api/where ---------------------------------------------------------------

/** The Vite build (wrangler.jsonc `assets` -> ../dist); JSON 404 when the binding is absent. */
function serveAsset(request: Request, env: Env): Promise<Response> {
  const assets = env.ASSETS;
  if (!assets) return Promise.resolve(error(404, 'not_found', 'no static assets (npm run build at the repo root)'));
  return assets.fetch(request);
}

/** Client address for the logs: IPv4 masked to /24, IPv6 to /48, null without CF-Connecting-IP. */
function maskIp(ip: string | null): string | null {
  if (ip === null || ip.length === 0) return null;
  if (ip.includes(':')) {
    const i = ip.indexOf('::');
    const groups = (i === -1 ? ip : ip.slice(0, i)).split(':').filter(Boolean).slice(0, 3);
    while (groups.length < 3) groups.push('0');
    return `${groups.join(':')}::/48`;
  }
  const parts = ip.split('.');
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.0/24` : null;
}

interface WhereInfo {
  edgeColo: string | null;
  country: string | null;
  city?: string;
  asn?: number;
  ip: string | null;
}

/** GET /api/where: where the edge served this request from (request.cf; under wrangler dev it describes the developer's own connection). */
function where(request: Request): Response {
  const cf = request.cf;
  const out: WhereInfo = {
    edgeColo: cf && typeof cf.colo === 'string' ? cf.colo : null,
    country: cf && typeof cf.country === 'string' ? cf.country : null,
    ip: maskIp(request.headers.get('CF-Connecting-IP')),
  };
  if (cf && typeof cf.city === 'string') out.city = cf.city;
  if (cf && typeof cf.asn === 'number') out.asn = cf.asn;
  return json(out, 200, { 'cache-control': 'no-store' });
}

/**
 * The anti-bot gate of POST /api/guest and POST /api/auth/register: null = let it through, else the
 * error response (403 turnstile_failed / 503 turnstile_unconfigured). Off with TURNSTILE_DISABLED=1.
 */
async function turnstileGate(request: Request, env: Env, token: unknown): Promise<Response | null> {
  if (env.TURNSTILE_DISABLED === '1') return null; // pre-production switch (wrangler var), see env.ts
  if (env.TURNSTILE_SECRET) {
    if (!env.TURNSTILE_SITEKEY && token === undefined) {
      // Secret without the public sitekey: no browser can obtain a token, so say so instead of 403.
      return error(503, 'turnstile_unconfigured', 'TURNSTILE_SITEKEY (wrangler var) must be set with TURNSTILE_SECRET so the client can render the widget');
    }
    const ok = await verifyTurnstile(env.TURNSTILE_SECRET, token, request.headers.get('CF-Connecting-IP'));
    return ok ? null : error(403, 'turnstile_failed');
  }
  if (!isLocalDev(request)) return error(503, 'turnstile_unconfigured', 'TURNSTILE_SECRET must be set outside local dev (npx wrangler secret put TURNSTILE_SECRET)');
  return null;
}

async function verifyTurnstile(secret: string, token: unknown, ip: string | null): Promise<boolean> {
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) return false;
  const form = new URLSearchParams({ secret, response: token });
  if (ip) form.set('remoteip', ip);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

/**
 * Free a player's one-active-match lock for `matchId` in the region matchmaker (the room is gone:
 * shut down, reset after a redeploy, or never existed). Best effort: the lock also expires by itself.
 */
async function releaseLock(request: Request, env: Env, playerId: string, matchId: string, chosenRegion?: unknown): Promise<void> {
  try {
    const { stub, region } = matchmakerOf(request, env, chosenRegion);
    await stub.fetch('https://matchmaker/release', {
      method: 'POST',
      headers: await internalHeaders(env, region),
      body: JSON.stringify({ matchId, playerIds: [playerId] }),
    });
  } catch (e) {
    console.error('release failed', e);
  }
}

// ---- handlers -----------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60_000;

/**
 * What a seat takes from the session (MatchmakerDO HumanEntry), never from the request body: the
 * car an account drives (src/net/cosmetics.ts: absent = the default car, a guest's always) and, for
 * the rewards weight of a match on a community node (nodes/control-plane/ledger.ts), that it is an
 * account and how many days old.
 */
function seatFields(session: SessionClaims, nowMs: number): { car?: CarId; account?: true; accountAgeDays?: number } {
  if (session.acct !== 1) return {};
  return {
    ...(session.car !== undefined ? { car: session.car } : {}),
    account: true,
    ...(session.since !== undefined ? { accountAgeDays: Math.max(0, Math.floor((nowMs - session.since * 1000) / DAY_MS)) } : {}),
  };
}

async function guest(request: Request, env: Env): Promise<Response> {
  if (rateLimited('g:' + clientIp(request), LIMIT_GUEST_PER_IP, Date.now())) return error(429, 'rate_limited');
  const body = (await readJson<{ name?: unknown; turnstileToken?: unknown }>(request)) ?? {};
  const blocked = await turnstileGate(request, env, body.turnstileToken);
  if (blocked !== null) return blocked;
  const playerId = randomHex(8);
  // The server names every guest ('Invitado 4821', from the id): a `name` in the body is ignored.
  const name = guestNameOf(playerId);
  const s = await createSession(env.JWT_SECRET, playerId, name);
  const out: GuestSession = { playerId, name, session: s.token, expiresAt: s.expiresAt };
  return json(out);
}

async function queue(request: Request, env: Env): Promise<Response> {
  const session = await bearerSession(request, env);
  if (!session) return error(401, 'unauthorized');
  if (await flag(env, 'matchmaking_off')) return error(503, 'matchmaking_off');
  // No new rooms while their sockets would be refused. With the nodes on for this player (D9) a
  // server or ranked queue goes on: its match waits for a node, and no MatchDO is created for it.
  const doDisabled = await flag(env, 'do_disabled');
  if (doDisabled && !(nodesConfigured(env) && nodesAllowed(await nodesMode(env), [session.sub]))) return error(503, 'do_disabled');
  const body = await readJson<{ mode?: unknown; modes?: unknown; kind?: unknown; p2pProtocol?: unknown; region?: unknown; physics?: unknown }>(request);
  // The owner's rule: every ranked or counted match, P2P included, runs the standard physics.
  // Experimental rules exist only in custom P2P lobbies; a queue never accepts or carries them.
  if (carriesPhysics(body)) return error(400, EXPERIMENTAL_REFUSED, 'experimental rules exist only in custom P2P lobbies, never in the casual or ranked queues');
  const modes: GameModeId[] | null = body && isModeList(body.modes) ? body.modes : body && isMode(body.mode) ? [body.mode] : null;
  if (!body || modes === null) return error(400, 'bad_mode', "mode must be '1v1' | '2v2' | '3v3' (or modes: a list of them)");
  if (body.kind !== undefined && !isQueueKind(body.kind)) return error(400, 'bad_kind', "kind must be 'p2p' | 'server' | 'ranked'");
  const kind = body.kind ?? 'p2p';
  if (doDisabled && kind === 'p2p') return error(503, 'do_disabled'); // a P2P room is a RoomDO: never on a node
  if (body.region !== undefined && !isRegion(body.region)) return error(400, 'bad_region');
  // A P2P client states its P2P protocol; a page cached from before a deploy (version 1 sends
  // kind 'p2p' without it) would fail on the room's welcome after taking a seat (its partner then
  // waits for a no-show): refuse it here with a code that reads as the fix. Callers without a kind
  // (scripts, the phase 1 default) are not affected.
  if ((body.kind === 'p2p' || body.p2pProtocol !== undefined) && body.p2pProtocol !== ROOM_PROTOCOL) {
    return json({ error: RELOAD_REQUIRED, message: `this page speaks P2P protocol ${typeof body.p2pProtocol === 'number' ? body.p2pProtocol : 1}, the server ${ROOM_PROTOCOL}: reload the page`, p2pProtocol: ROOM_PROTOCOL }, 426);
  }
  const now = Date.now();
  if (rateLimited('q:' + session.sub, LIMIT_QUEUE_PER_PLAYER, now)) return error(429, 'rate_limited');
  const { stub, region } = matchmakerOf(request, env, body.region);
  let ratings: RankedCheck['ratings'] | undefined;
  if (kind === 'ranked') {
    // Ranked: accounts only; the ban, the one-ranked-match-at-a-time lock (every region) and the
    // ratings the matchmaker pairs by come from AccountsDO, never from the client.
    if (session.acct !== 1) return error(403, 'account_required', 'Inicia sesión para jugar Competitivo');
    const chk = await accountsCall(env, '/ranked-check', { userId: session.sub, playlists: modes });
    if (!chk.ok) return new Response(chk.body, chk);
    const c = (await chk.json()) as RankedCheck;
    if (c.banUntil > now) return json({ error: 'ranked_ban', message: 'Competitivo bloqueado por abandonar partidas', retryAfterMs: c.banUntil - now }, 429);
    if (c.active && c.active.region !== region) {
      return json({ error: 'active_match', matchId: c.active.matchId, kind: 'server', region: c.active.region, message: 'you still have a ranked match in another region: rejoin it (POST /api/rejoin)' }, 409);
    }
    ratings = c.ratings;
  }
  const headers = await internalHeaders(env, region);
  let res = await stub.fetch('https://matchmaker/join', {
    method: 'POST',
    headers,
    // doDisabled: where no node can host now, the matchmaker refuses this queue as above (503).
    // guest / ip: the matchmaker's guest caps (one MatchDO match per guest session across the regions, per IPv6 /64).
    body: JSON.stringify({ playerId: session.sub, name: session.name, modes, kind, ratings, doDisabled: doDisabled ? true : undefined, ...seatFields(session, now), ...(session.acct !== 1 ? { guest: true, ip: clientIp(request) } : {}) }),
  });
  if (!res.ok) return new Response(res.body, res);
  let result = (await res.json()) as AnyQueueResult;
  if (result.status === 'waiting') {
    res = await stub.fetch('https://matchmaker/poll?playerId=' + session.sub, { headers });
    if (!res.ok) return new Response(res.body, res);
    result = (await res.json()) as AnyQueueResult;
  }
  if (result.status === 'matched') {
    if (isP2pResult(result)) result.wsUrl = socketUrl(request, '/room/' + result.roomId);
    else if (result.matchId && result.node !== true) result.wsUrl = socketUrl(request, '/ws/' + result.matchId); // a node match keeps the node's own wss:// URL
  }
  return json({ ...result, region });
}

// ---- population / lobbies ------------------------------------------------------------------------

const populationCache = new Map<string, { at: number; data: PopulationAnswer }>();
const POPULATION_TTL_MS = 5_000;

/** GET /api/population?region=: queue sizes of that region's matchmaker plus its public lobbies (cached 5 s per region per isolate). */
async function population(request: Request, env: Env, url: URL): Promise<Response> {
  if (rateLimited('pop:' + clientIp(request), LIMIT_POPULATION_PER_IP, Date.now())) return error(429, 'rate_limited');
  const region = regionOf(request, env, url.searchParams.get('region') ?? undefined);
  const now = Date.now();
  let c = populationCache.get(region);
  if (!c || now - c.at > POPULATION_TTL_MS) {
    const [mm, dir] = await Promise.all([
      env.MATCHMAKER.get(env.MATCHMAKER.idFromName('mm:' + region)).fetch('https://matchmaker/population', { headers: await internalHeaders(env, region) }),
      lobbyDir(env).fetch('https://lobbies/count?region=' + encodeURIComponent(region), { headers: await internalHeaders(env) }),
    ]);
    if (!mm.ok) return new Response(mm.body, mm);
    const m = (await mm.json()) as Omit<PopulationAnswer, 'lobbies' | 'region'>;
    const d = dir.ok ? ((await dir.json()) as { count: number }) : { count: 0 };
    c = { at: now, data: { region, casual: m.casual, ranked: m.ranked, playing: m.playing, lobbies: d.count } };
    populationCache.set(region, c);
  }
  return json(c.data, 200, { 'cache-control': 'no-store' });
}

function lobbyDir(env: Env): DurableObjectStub {
  return env.LOBBY_DIR.get(env.LOBBY_DIR.idFromName('lobbies-v1'));
}

const lobbyListCache = new Map<string, { at: number; data: LobbySummary[] }>();
const LOBBY_LIST_TTL_MS = 3_000;

async function listLobbies(request: Request, env: Env, url: URL): Promise<Response> {
  if (rateLimited('ll:' + clientIp(request), LIMIT_LOBBY_LIST_PER_IP, Date.now())) return error(429, 'rate_limited');
  const region = regionOf(request, env, url.searchParams.get('region') ?? undefined);
  const now = Date.now();
  let c = lobbyListCache.get(region);
  if (!c || now - c.at > LOBBY_LIST_TTL_MS) {
    const res = await lobbyDir(env).fetch('https://lobbies/list?region=' + encodeURIComponent(region), { headers: await internalHeaders(env) });
    if (!res.ok) return new Response(res.body, res);
    c = { at: now, data: ((await res.json()) as { lobbies: LobbySummary[] }).lobbies };
    lobbyListCache.set(region, c);
  }
  return json({ region, lobbies: c.data }, 200, { 'cache-control': 'no-store' });
}

async function lobbyTicket(request: Request, env: Env, session: SessionClaims, lobbyId: string, code: string): Promise<LobbyTicketAnswer> {
  const ticket = await createTicket(env.JWT_SECRET, { sub: session.sub, mid: lobbyId, team: 0, slot: 0, name: session.name, role: 'lobby' });
  return { lobbyId, code, ticket, wsUrl: socketUrl(request, '/lobby/' + lobbyId) };
}

/**
 * GET /api/lobbies/peek?code=: the summary of the lobby a join link names (public or private: the
 * code is what a private lobby shares), before the player joins. Rate-limited like the list.
 */
async function peekLobby(request: Request, env: Env, url: URL): Promise<Response> {
  if (rateLimited('ll:' + clientIp(request), LIMIT_LOBBY_LIST_PER_IP, Date.now())) return error(429, 'rate_limited');
  const code = normalizeCode(url.searchParams.get('code'));
  if (code === null) return error(400, 'bad_code', 'El código tiene 6 letras o números');
  const r = await lobbyDir(env).fetch('https://lobbies/resolve?code=' + code, { headers: await internalHeaders(env) });
  if (!r.ok) return new Response(r.body, r);
  const { lobbyId } = (await r.json()) as { lobbyId: string };
  let id: DurableObjectId;
  try {
    id = env.LOBBY.idFromString(lobbyId);
  } catch {
    return error(404, 'no_lobby');
  }
  const res = await env.LOBBY.get(id).fetch('https://lobby/internal/peek', { headers: await internalHeaders(env) });
  if (!res.ok) return new Response(res.body, res);
  return json(await res.json(), 200, { 'cache-control': 'no-store' });
}

/**
 * POST /api/lobbies { name, password?, mode, visibility, net, matchLengthSeconds, physics?, region? }:
 * a new lobby hosted by the caller (guests too, but never with experimental rules: `physics` needs
 * an account session, 403 account_required; LobbyDO checks the rules themselves).
 */
async function createLobby(request: Request, env: Env): Promise<Response> {
  const session = await bearerSession(request, env);
  if (!session) return error(401, 'unauthorized');
  if (await flag(env, 'matchmaking_off')) return error(503, 'matchmaking_off');
  if (rateLimited('lc:' + session.sub, LIMIT_LOBBY_CREATE_PER_PLAYER, Date.now())) return error(429, 'rate_limited', 'Creaste demasiadas salas, espera un minuto');
  const b = await readJson<{ name?: unknown; password?: unknown; mode?: unknown; visibility?: unknown; net?: unknown; matchLengthSeconds?: unknown; physics?: unknown; region?: unknown }>(request);
  if (!b) return error(400, 'bad_request');
  if (b.region !== undefined && !isRegion(b.region)) return error(400, 'bad_region');
  // Experimental rules are for signed-in players only (null = standard physics, anyone).
  if (carriesPhysics(b) && session.acct !== 1) return error(403, 'account_required', 'Inicia sesión para crear una sala experimental');
  // The title: the host's name (LobbyDO's default, each viewer reads it in their own language) unless an
  // account names it. A guest never titles a lobby: its `name` is ignored.
  const name = session.acct !== 1 || b.name === undefined ? undefined : sanitizeLobbyName(b.name);
  if (name === null) return error(400, 'bad_name', 'El nombre de la sala tiene que tener entre 3 y 24 caracteres');
  if (name !== undefined && lobbyNameIssue(name) !== null) return error(400, 'name_reserved', 'Ese nombre de sala no está permitido');
  const region = regionOf(request, env, b.region);
  const id = env.LOBBY.newUniqueId();
  const lobbyId = id.toString();
  // owner / ip: the directory caps live lobbies per session and per IPv6 /64 (429 too_many_lobbies).
  const alloc = await lobbyDir(env).fetch('https://lobbies/allocate', { method: 'POST', headers: await internalHeaders(env), body: JSON.stringify({ lobbyId, owner: session.sub, ip: clientIp(request) }) });
  if (!alloc.ok) return new Response(alloc.body, alloc);
  const { code } = (await alloc.json()) as { code: string };
  const u = new URL(request.url);
  const res = await env.LOBBY.get(id).fetch('https://lobby/internal/create', {
    method: 'POST',
    headers: await internalHeaders(env),
    body: JSON.stringify({
      lobbyId,
      code,
      region,
      socketBase: (u.protocol === 'https:' ? 'wss://' : 'ws://') + u.host,
      settings: { ...(name !== undefined ? { name } : {}), mode: b.mode, visibility: b.visibility, net: b.net, matchLengthSeconds: b.matchLengthSeconds, physics: b.physics },
      password: typeof b.password === 'string' && b.password.length > 0 ? b.password : null,
      host: { playerId: session.sub, name: session.name, guest: session.acct !== 1, ...(session.car !== undefined ? { car: session.car } : {}) },
    }),
  });
  if (!res.ok) return new Response(res.body, res);
  return json(await lobbyTicket(request, env, session, lobbyId, code));
}

/** POST /api/lobbies/join { code, password? }: admission (password / room / kick list) then a lobby ticket. */
async function joinLobby(request: Request, env: Env): Promise<Response> {
  const session = await bearerSession(request, env);
  if (!session) return error(401, 'unauthorized');
  if (rateLimited('lj:' + session.sub, LIMIT_LOBBY_JOIN_PER_PLAYER, Date.now()) || rateLimited('ljip:' + clientIp(request), LIMIT_LOBBY_JOIN_PER_PLAYER * 3, Date.now())) {
    return error(429, 'rate_limited', 'Demasiados intentos, espera un minuto');
  }
  const b = await readJson<{ code?: unknown; password?: unknown }>(request);
  const code = normalizeCode(b?.code);
  if (!b || code === null) return error(400, 'bad_code', 'El código tiene 6 letras o números');
  const r = await lobbyDir(env).fetch('https://lobbies/resolve?code=' + code, { headers: await internalHeaders(env) });
  if (!r.ok) return new Response(r.body, r);
  const { lobbyId } = (await r.json()) as { lobbyId: string };
  let id: DurableObjectId;
  try {
    id = env.LOBBY.idFromString(lobbyId);
  } catch {
    return error(404, 'no_lobby');
  }
  const res = await env.LOBBY.get(id).fetch('https://lobby/internal/admit', {
    method: 'POST',
    headers: await internalHeaders(env),
    body: JSON.stringify({ playerId: session.sub, name: session.name, guest: session.acct !== 1, password: typeof b.password === 'string' ? b.password : undefined, ...(session.car !== undefined ? { car: session.car } : {}) }),
  });
  if (!res.ok) return new Response(res.body, res);
  return json(await lobbyTicket(request, env, session, lobbyId, code));
}

/** GET /api/ice: what to hand RTCPeerConnection (see env.ts: STUN always, TURN when configured; minted per call). */
async function ice(request: Request, env: Env): Promise<Response> {
  const session = await bearerSession(request, env);
  if (!session) return error(401, 'unauthorized');
  if (rateLimited('i:' + session.sub, LIMIT_ICE_PER_PLAYER, Date.now())) return error(429, 'rate_limited');
  return json({ iceServers: await iceServersFor(env) }, 200, { 'cache-control': 'no-store' });
}

async function rejoin(request: Request, env: Env): Promise<Response> {
  const session = await bearerSession(request, env);
  if (!session) return error(401, 'unauthorized');
  const now = Date.now();
  if (rateLimited('r:' + session.sub, LIMIT_REJOIN_PER_PLAYER, now) || rateLimited('rip:' + clientIp(request), LIMIT_REJOIN_PER_IP, now)) {
    return error(429, 'rate_limited');
  }
  const body = await readJson<{ matchId?: unknown; region?: unknown }>(request);
  if (!body || !isHex(body.matchId, 64)) return error(400, 'bad_match_id');
  let id: DurableObjectId;
  try {
    id = env.MATCH.idFromString(body.matchId);
  } catch {
    // Not a MatchDO id. A RoomDO id (a 409 'active_match' of kind p2p) gets a clear answer: P2P
    // rooms are never rejoined (single-use ticket, no authority to resync from); /api/leave frees the lock.
    if (isRoomId(env, body.matchId)) return error(410, 'p2p_room', 'a P2P room cannot be rejoined; POST /api/leave frees its lock');
    return nodeRejoin(request, env, session.sub, body.matchId, body.region);
  }
  const res = await env.MATCH.get(id).fetch('https://match/internal/rejoin', {
    method: 'POST',
    headers: await internalHeaders(env),
    body: JSON.stringify({ playerId: session.sub }),
  });
  if (!res.ok) {
    // 404 (room gone) / 410 (match over or reset): free the player's lock now so a new queue
    // works at once instead of answering 409 active_match until the lock expires. Not for 410
    // 'left' (the player quit with /api/leave { matchId }): that lock is gone already and the match
    // still runs, so the release (which also takes the match out of the capacity count) must not go out.
    if (res.status === 404 || (res.status === 410 && (await errorCodeOf(res.clone())) !== 'left')) await releaseLock(request, env, session.sub, body.matchId, body.region);
    return new Response(res.body, res);
  }
  const info = (await res.json()) as { slot: number; team: 0 | 1; name: string };
  const ticket = await createTicket(env.JWT_SECRET, { sub: session.sub, mid: body.matchId, team: info.team, slot: info.slot, name: info.name });
  const out: QueueResult = { status: 'matched', matchId: body.matchId, ticket, wsUrl: socketUrl(request, '/ws/' + body.matchId) };
  return json(out);
}

/**
 * POST /api/rejoin for an id that is neither a MatchDO's nor a RoomDO's: a match on a community
 * node, which the NodeRegistryDO knows, or nothing at all. 200: the node's fresh ticket and its
 * own wss:// URL. 404, or 410 other than 'left': the lock that points at the id is freed, as for a
 * MatchDO. 410 'left' (the player quit, the match goes on) and 503 (the node is out of reach for
 * now, or the control plane does not answer, or answers a 200 that is no ticket for a wss:// URL:
 * it may come back) keep it. Without the nodes
 * configured the id names nothing here: 404, and the lock goes (a lock left over from a node match
 * must not answer 409 until it expires).
 */
async function nodeRejoin(request: Request, env: Env, playerId: string, matchId: string, region: unknown): Promise<Response> {
  if (!nodesConfigured(env)) {
    await releaseLock(request, env, playerId, matchId, region);
    return error(404, 'no_match', 'no match with this id');
  }
  let r: NodesReply;
  try {
    r = await askNodes(env, NODE_ROUTES.rejoin, { matchId, playerId });
  } catch (e) {
    console.error('node rejoin failed', e);
    return error(503, 'offline', 'the node match cannot be reached right now: try again in a moment');
  }
  if (r.status === 200) {
    const t = rejoinTicketOf(r.body);
    if (t === null) {
      // Not a ticket for the node's own wss:// URL: as if the node were out of reach, the lock stays.
      console.error('node rejoin: the 200 is not a ticket');
      return error(503, 'offline', 'the node match cannot be reached right now: try again in a moment');
    }
    // The match's cars (src/net/cosmetics.ts): a node's own welcome never carries them.
    const out: CosmeticQueueResult = { status: 'matched', matchId, ticket: t.ticket, wsUrl: t.wsUrl, node: true, ...(t.cars ? { cars: t.cars } : {}) };
    return json(out);
  }
  if (r.status === 404 || (r.status === 410 && replyCode(r.body) !== 'left')) await releaseLock(request, env, playerId, matchId, region);
  return r.body === null ? error(r.status, 'node_error') : json(r.body, r.status);
}

/** The `error` code of a JSON error body ('' when there is none); consumes `res`. */
async function errorCodeOf(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (typeof body !== 'object' || body === null) return '';
    const code = (body as { error?: unknown }).error;
    return typeof code === 'string' ? code : '';
  } catch {
    return '';
  }
}

/** `id` is a RoomDO id (idFromString validates the namespace); never throws. */
function isRoomId(env: Env, id: string): boolean {
  try {
    env.ROOM.idFromString(id);
    return true;
  } catch {
    return false;
  }
}

async function leave(request: Request, env: Env): Promise<Response> {
  const session = await bearerSession(request, env);
  if (!session) return error(401, 'unauthorized');
  if (rateLimited('l:' + clientIp(request), LIMIT_LEAVE_PER_IP, Date.now())) return error(429, 'rate_limited');
  const body = (await readJson<{ matchId?: unknown; region?: unknown; connected?: unknown }>(request)) ?? {};
  const { stub, region } = matchmakerOf(request, env, body.region);
  const res = await stub.fetch('https://matchmaker/leave', {
    method: 'POST',
    headers: await internalHeaders(env, region),
    // connected: false (the client never got into the match) only matters to a node match.
    body: JSON.stringify({ playerId: session.sub, matchId: isHex(body.matchId, 64) ? body.matchId : undefined, connected: body.connected === false ? false : undefined }),
  });
  return new Response(res.body, res);
}

/**
 * WebSocket gate shared by /ws/:matchId (MatchDO, role 'player') and /room/:roomId (RoomDO, role
 * 'peer'): the ticket is verified here and only a verified upgrade reaches a Durable Object.
 */
async function websocket(request: Request, env: Env, gate: SocketGate, matchId: string): Promise<Response> {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return error(426, 'upgrade_required');
  if (!isHex(matchId, 64)) return error(400, gate.badId);
  // Browsers always send Origin on a WebSocket upgrade and CORS does not apply to it: refuse
  // pages outside VITE_ORIGINS here (a non-browser client without Origin still needs a ticket).
  const origin = request.headers.get('Origin');
  if (origin !== null && !originAllowed(request, env, origin)) return error(403, 'bad_origin');
  const protocols = (request.headers.get('Sec-WebSocket-Protocol') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!protocols.includes(WS_SUBPROTOCOL)) return error(400, 'bad_subprotocol', `expected '${WS_SUBPROTOCOL}'`);
  const ticketProto = protocols.find((p) => p.startsWith(WS_TICKET_PREFIX));
  if (!ticketProto) return error(401, 'no_ticket');
  const claims = await verifyTicket(env.JWT_SECRET, ticketProto.slice(WS_TICKET_PREFIX.length), matchId, Date.now(), gate.role);
  if (!claims) return error(401, 'bad_ticket');
  if (await flag(env, 'do_disabled')) return error(503, 'do_disabled');
  const ns = env[gate.binding];
  let id: DurableObjectId;
  try {
    id = ns.idFromString(matchId);
  } catch {
    return error(400, gate.badId);
  }
  // The DO takes the slot ownership from these headers, so they are overwritten from the verified
  // claims and the internal header proves the upgrade went through this gate. The name travels
  // URL-encoded (header values are Latin-1); both DOs prefer the roster's copy anyway.
  const headers = new Headers(request.headers);
  headers.set(INTERNAL_HEADER, await internalSecret(env.JWT_SECRET));
  headers.set('x-player-id', claims.sub);
  headers.set('x-slot', String(claims.slot));
  headers.set('x-team', String(claims.team));
  headers.set('x-jti', claims.jti);
  headers.set('x-name', encodeURIComponent(claims.name));
  const res = await ns.get(id).fetch(new Request(request.url, { method: 'GET', headers }));
  // The DO's 101 response (with 'Sec-WebSocket-Protocol: tg1') is passed through untouched; re-wrapping
  // the WebSocket in a new Response works too but makes wrangler dev log 'Network connection lost' on close.
  if (res.status === 101 && res.webSocket && res.headers.get('Sec-WebSocket-Protocol') !== WS_SUBPROTOCOL) {
    return new Response(null, { status: 101, webSocket: res.webSocket, headers: { 'Sec-WebSocket-Protocol': WS_SUBPROTOCOL } });
  }
  return res;
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    for (const prefix of ['/ws/', '/room/', '/lobby/'] as const) {
      if (!path.startsWith(prefix)) continue;
      if (!env.JWT_SECRET) return error(500, 'no_secret', 'JWT_SECRET is not configured (server/.dev.vars or wrangler secret put)');
      return websocket(request, env, SOCKET_GATES[prefix], path.slice(prefix.length));
    }
    // ---- community nodes: before the assets, which would answer index.html for any of these ----
    if (path.startsWith('/nodes/')) {
      return nodeRoute({
        env,
        request,
        url,
        ip: clientIp(request),
        session: () => (env.JWT_SECRET ? bearerSession(request, env) : Promise.resolve(null)),
        limited: (key, max, windowMs) => rateLimited(key, max, Date.now(), windowMs),
        cors: corsHeaders(request, env),
      });
    }
    // ---- the game (Workers Assets): everything outside /api, /ws, /room, /lobby and /nodes ----
    if (!path.startsWith('/api/')) return serveAsset(request, env);
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (path === '/api/health') return withCors(json({ ok: true, version: SERVER_VERSION, protocol: PROTOCOL_VERSION }), cors);
    if (path === '/api/time') return withCors(json({ now: Date.now() }), cors);
    if (path === '/api/config') return withCors(json(serverConfig(request, env), 200, { 'cache-control': 'no-store' }), cors);
    // ---- /api/where (edge colo / country / masked ip; no secret needed) ----
    if (path === '/api/where') return withCors(where(request), cors);
    if (!env.JWT_SECRET) return withCors(error(500, 'no_secret', 'JWT_SECRET is not configured (server/.dev.vars or wrangler secret put)'), cors);
    let res: Response;
    try {
      const acct = path.startsWith('/api/auth/') || path === '/api/me' || path.startsWith('/api/me/') || path === '/api/leaderboard' || path === '/api/ranked/result';
      const routed = acct
        ? await accountRoute(
            {
              env,
              request,
              session: await bearerSession(request, env),
              originAllowed: (o) => originAllowed(request, env, o),
              antiBot: (token) => turnstileGate(request, env, token),
              limited: (key, max) => rateLimited(key, max, Date.now()),
            },
            url,
          )
        : null;
      if (routed !== null) res = routed;
      else if (request.method === 'GET' && path === '/api/population') res = await population(request, env, url);
      else if (request.method === 'GET' && path === '/api/lobbies') res = await listLobbies(request, env, url);
      else if (request.method === 'POST' && path === '/api/lobbies') res = await createLobby(request, env);
      else if (request.method === 'POST' && path === '/api/lobbies/join') res = await joinLobby(request, env);
      else if (request.method === 'GET' && path === '/api/lobbies/peek') res = await peekLobby(request, env, url);
      else if (request.method === 'POST' && path === '/api/guest') res = await guest(request, env);
      else if (request.method === 'POST' && path === '/api/queue') res = await queue(request, env);
      else if (request.method === 'POST' && path === '/api/rejoin') res = await rejoin(request, env);
      else if (request.method === 'POST' && path === '/api/leave') res = await leave(request, env);
      else if (request.method === 'GET' && path === '/api/ice') res = await ice(request, env);
      else res = error(404, 'not_found');
    } catch (e) {
      console.error('api error', e);
      res = error(500, 'internal');
    }
    return withCors(res, cors);
  },

  /** The cron trigger (wrangler.jsonc, every 5 minutes): the community nodes' health check. */
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(nodeHealthCheck(env));
  },
} satisfies ExportedHandler<Env>;
