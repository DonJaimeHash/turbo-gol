/**
 * Browser network client for the phase 1 online mode (docs/online/PHASE1.md):
 *
 *   config          GET /api/config once per page load (ServerConfig: turnstileSiteKey, protocol,
 *                   version, region), fetched lazily before the first guest registration; a failed
 *                   fetch is not cached
 *   guest session   POST /api/guest { name, turnstileToken? } -> GuestSession, kept in localStorage
 *                   (GUEST_STORAGE_KEY). With a sitekey the token comes from a Turnstile widget
 *                   rendered into the Hud's container (Turnstile.getToken; onTurnstile reports the
 *                   challenge to the UI); 403 turnstile_failed / 503 turnstile_unconfigured and a
 *                   client-side challenge failure reject with NetError 'turnstile'
 *   matchmaking     POST /api/queue { mode, kind, p2pProtocol? } (Bearer session) long-poll loop
 *                   until 'matched' (a 'p2p' queue states P2P_PROTOCOL_VERSION: a stale page gets
 *                   426 reload_required);
 *                   kind 'server' (phase 1, a Durable Object host) or 'p2p' (phase 2, a signaling
 *                   room; the server may still answer with a server match, QueueAssignment says
 *                   which). cancelQueue() aborts it and POSTs /api/leave (best effort) so the
 *                   matchmaker drops us. 409 active_match on a 'server' queue: a 'server' match of
 *                   ours is alive -> rejoin it with a fresh ticket (the phase 1 reconnect), and if
 *                   the rejoin says the match is gone (404 / 410: the Worker freed the lock) queue
 *                   again once; a 'p2p' room cannot be rejoined -> POST /api/leave { matchId } (the
 *                   matchmaker frees the room lock and kicks our room socket) and queue again
 *                   once. 409 on a 'p2p' queue: the player asked for P2P, so whatever holds the
 *                   lock (a P2P room or a server match, e.g. one quit before the release reached
 *                   the server) is never rejoined: POST /api/leave { matchId } (a server match
 *                   hands our car to its bots) and queue again once. A second 409 rejects with
 *                   the server's reason in the message (the menu shows it)
 *   accounts        a signed-in player (AccountClient) queues under its account: `sessionProvider`
 *                   answers before the guest session (ensureGuest), `onSessionRejected` refreshes it
 *                   after a 401; leave / ice / cancel reuse the Bearer of the last queue (`lastBearer`),
 *                   which refreshBearer renews early for a match on a community node
 *   menus           `queueModes` (several playlists searched at once) and `region` (a REGIONS id, or
 *                   null = automatic) go into every queue body; the region also into leave / rejoin
 *                   so they reach the same matchmaker; kind 'ranked' (accounts only) is a server
 *                   match tagged `ranked` (rated by the server; AccountClient.waitRankedResult)
 *   errors          every failed API call rejects with NetError: `status`, `serverCode` = the
 *                   body's `error` code (callers branch on it, never on the message text: 410
 *                   p2p_room, 429 no_show, 426 reload_required, 403 turnstile_failed...),
 *                   `serverMessage` and `retryAfterMs` (429 no_show); the message itself is
 *                   developer text (logs), the menus show netErrorText (src/net/netErrorText.ts)
 *   leaveMatch      POST /api/leave after a P2P room (P2PSession.teardown, no matchId: a server
 *                   lock is kept) or with the matchId of a server match the player quits
 *                   (OnlineSession.leave: the lock is freed, the slot goes to the host's bots, no
 *                   rejoin); the next queue() waits for it first so its join is never refused by
 *                   our own stale lock. A quit before the Welcome says `connected: false`. On a
 *                   community node a 401 is retried once with a refreshed account session
 *                   (`retryRejected`)
 *   ice             GET /api/ice -> the STUN / TURN servers for the P2P mesh (fetchIce)
 *   match socket    new WebSocket(wsUrl, ['tg1', 'ticket.<jwt>']), binaryType 'arraybuffer';
 *                   Welcome / Snapshot / Event / Error / Kick are dispatched to the callbacks
 *   inputs          sendInputs(firstTick, count, packed, ackTick) into one reusable buffer
 *   clock           a ping 4x/s; the pong feeds ClockSync (median rtt / jitter / offset, host tick
 *                   estimate); snapshot tick gaps feed the loss estimate; bytes in / out are counted
 *   reconnect       one POST /api/rejoin { matchId } + reconnect when the socket closes with a code
 *                   other than 1000 or 4000 'replaced' (a newer socket of ours took the slot: final),
 *                   unless the client closed it or was kicked
 *
 * The HTTP and WebSocket implementations are injectable (fetch / WebSocket by default) so the
 * logic runs in node tests with fakes. No allocations on the per-message path beyond the
 * Uint8Array view over each incoming frame.
 */
import { MAX_CARS, PACKED_INPUT_BYTES } from '../sim/types';
import { STORAGE_PREFIX } from '../brand';
import { ClockSync } from './ClockSync';
import { LossEstimator } from './NetStats';
import { P2P_PROTOCOL_VERSION, type IceServer, type QueueRequestP2p, type QueueResultP2p } from './p2p/protocol';
import { getToken as turnstileToken, type TurnstileLoader } from './Turnstile';
import {
  INPUT_HEADER,
  INPUT_MAX_BATCH,
  MsgType,
  PING_LEN,
  PROTOCOL_VERSION,
  WS_SUBPROTOCOL,
  WS_TICKET_PREFIX,
  decodeJson,
  decodePong,
  decodeSnapshot,
  encodeInput,
  encodeJson,
  encodePing,
  msgType,
  type GuestSession,
  type MatchEvent,
  type PongPacket,
  type QueueResult,
  type SnapshotPacket,
  type Welcome,
} from './protocol';

export const GUEST_STORAGE_KEY = STORAGE_PREFIX + 'guest';
export const PING_INTERVAL_MS = 250;
/** A guest session is renewed when it expires within this many ms. */
const SESSION_MIN_REMAINING_MS = 60_000;

// ---- Injectable environment ----------------------------------------------------------------

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface RequestInitLike {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type FetchLike = (url: string, init: RequestInitLike) => Promise<ResponseLike>;

/** The subset of the DOM WebSocket the client uses (a fake implements it in the tests). */
export interface WebSocketLike {
  binaryType: 'blob' | 'arraybuffer';
  readonly readyState: number;
  readonly protocol: string;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  send(data: Uint8Array | string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string, protocols: string[]) => WebSocketLike;

export interface NetClientOptions {
  /** Prefix for the /api/* paths ('' = same origin, through the Vite proxy in dev). */
  apiBase?: string;
  fetchFn?: FetchLike;
  webSocketFactory?: WebSocketFactory;
  /** Clock for t0 / t3 (performance.now by default). */
  now?: () => number;
  /** null disables persistence (tests). Defaults to window.localStorage when available. */
  storage?: StorageLike | null;
  pingIntervalMs?: number;
  /**
   * The element the Turnstile widget renders into (the Hud's container), read when a guest is
   * registered and the server has a sitekey. null / absent = the challenge cannot run.
   */
  turnstileContainer?: () => HTMLElement | null;
  /** Loader of the Turnstile API (the script tag by default; a fake in tests). */
  turnstileLoader?: TurnstileLoader;
}

/** 'turnstile': the anti-bot check failed (status 403 / 503 from the server, 0 = on the client). */
export type NetErrorCode = 'cancelled' | 'http' | 'network' | 'protocol' | 'state' | 'turnstile';

/** What the JSON error body of a failed API response said (absent fields: '' / '' / 0). */
export interface ServerError {
  /** `error`: the machine-readable code ('p2p_room', 'no_show', 'reload_required', ...). */
  code: string;
  message: string;
  /** `retryAfterMs` (429 'no_show'): how long the refusal lasts. */
  retryAfterMs: number;
}

export class NetError extends Error {
  readonly code: NetErrorCode;
  readonly status: number;
  /** The server's `error` code ('' when the failure did not come with one): callers branch on this, never on the message text. */
  readonly serverCode: string;
  /** The server's `message` ('' when absent; the code itself when the server gave no text). */
  readonly serverMessage: string;
  /** The server's `retryAfterMs` (0 when absent). */
  readonly retryAfterMs: number;

  constructor(code: NetErrorCode, message: string, status = 0, server?: ServerError) {
    super(message);
    this.name = 'NetError';
    this.code = code;
    this.status = status;
    this.serverCode = server !== undefined ? server.code : '';
    this.serverMessage = server !== undefined ? server.message : '';
    this.retryAfterMs = server !== undefined ? server.retryAfterMs : 0;
  }
}

/** What /api/queue (or /api/rejoin) resolved to once a match exists. */
export interface MatchAssignment {
  matchId: string;
  ticket: string;
  wsUrl: string;
}

/** POST /api/queue `kind`: a Durable Object host (phase 1) or a P2P signaling room (phase 2). */
export type QueueKind = 'server' | 'p2p' | 'ranked';

/** A server (Durable Object) match: the phase 1 assignment tagged with its kind. */
export interface ServerAssignment extends MatchAssignment {
  kind: 'server';
  /** A ranked match (queue kind 'ranked'): rated when it ends. */
  ranked?: boolean;
}

/** A P2P room: open wsUrl (/room/:roomId) with the ticket in the subprotocol (RoomClient). */
export interface P2pAssignment {
  kind: 'p2p';
  roomId: string;
  ticket: string;
  wsUrl: string;
}

/** What a queue of either kind resolved to; a 'p2p' queue may still get a server match (lone human). */
export type QueueAssignment = ServerAssignment | P2pAssignment;

/** leaveMatch options. */
export interface LeaveOptions {
  /**
   * false: the player never got the match's Welcome (its socket never reached the host). Sent as
   * `connected: false` so a later server can tell a slot that never attached from a quit (stage 2
   * of the community nodes); the Worker ignores it today. true / absent adds nothing to the body.
   */
  connected?: boolean;
  /**
   * A 401 refreshes the account's session and sends the leave once more, as the same player: the
   * match is on a community node, where the leave is the only way out and the Bearer of the queue
   * may have expired during the match (account sessions last 1 h).
   */
  retryRejected?: boolean;
}

/** Default when the server has no /api/ice route (local dev without the phase 2 Worker). */
export const DEFAULT_ICE_SERVERS: readonly IceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];

function isIceServer(v: unknown): v is IceServer {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  const urls = o.urls;
  if (typeof urls === 'string') return urls.length > 0;
  return Array.isArray(urls) && urls.length > 0 && urls.every((u) => typeof u === 'string');
}

/** The ice servers of a GET /api/ice body ({ iceServers: [...] } or a bare array); null when malformed. */
export function parseIceServers(v: unknown): IceServer[] | null {
  const list = Array.isArray(v) ? v : typeof v === 'object' && v !== null ? (v as { iceServers?: unknown }).iceServers : undefined;
  if (!Array.isArray(list)) return null;
  const out: IceServer[] = [];
  for (const e of list) {
    if (!isIceServer(e)) return null;
    const server: IceServer = { urls: e.urls };
    if (typeof e.username === 'string') server.username = e.username;
    if (typeof e.credential === 'string') server.credential = e.credential;
    out.push(server);
  }
  return out;
}

export interface GuestRecord {
  name: string;
  session: GuestSession | null;
}

/** GET /api/config (public, no auth); the Worker builds the same shape in server/src/index.ts. */
export interface ServerConfig {
  /** Turnstile sitekey to render before POST /api/guest; null = no anti-bot check (local dev). */
  turnstileSiteKey: string | null;
  protocol: number;
  version: string;
  /** Cloudflare colo that answered ('local' under wrangler dev). */
  region: string;
  /** The matchmaking region the server picks for "automatic" (the continent of the request; '' when unknown). */
  autoRegion?: string;
  /** Sign-in providers the server has credentials for ('google', 'discord'). */
  oauth?: string[];
}

/** POST /api/guest body. */
interface GuestRequest {
  name: string;
  turnstileToken?: string;
}

export function parseServerConfig(v: unknown): ServerConfig | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const key = o.turnstileSiteKey;
  return {
    turnstileSiteKey: typeof key === 'string' && key.length > 0 ? key : null,
    protocol: typeof o.protocol === 'number' ? o.protocol : 0,
    version: typeof o.version === 'string' ? o.version : '',
    region: typeof o.region === 'string' ? o.region : '',
    autoRegion: typeof o.autoRegion === 'string' ? o.autoRegion : '',
    oauth: Array.isArray(o.oauth) ? o.oauth.filter((x): x is string => typeof x === 'string') : [],
  };
}

// ---- Guest persistence ---------------------------------------------------------------------

export function defaultGuestName(): string {
  return `Guest${Math.floor(100 + Math.random() * 900)}`;
}

/** Trim and bound a display name; empty falls back to a generated one. */
export function sanitizeName(name: string): string {
  const n = name.replace(/\s+/g, ' ').trim().slice(0, 16);
  return n.length > 0 ? n : defaultGuestName();
}

function isGuestSession(v: unknown): v is GuestSession {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.playerId === 'string' && typeof o.name === 'string' && typeof o.session === 'string' && typeof o.expiresAt === 'number';
}

export function loadGuestRecord(storage: StorageLike | null): GuestRecord {
  const rec: GuestRecord = { name: '', session: null };
  if (storage === null) {
    rec.name = defaultGuestName();
    return rec;
  }
  try {
    const raw = storage.getItem(GUEST_STORAGE_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.name === 'string') rec.name = parsed.name;
      if (isGuestSession(parsed.session)) rec.session = parsed.session;
    }
  } catch {
    /* storage disabled / corrupt */
  }
  if (rec.name.length === 0) rec.name = rec.session?.name ?? defaultGuestName();
  return rec;
}

export function saveGuestRecord(storage: StorageLike | null, rec: GuestRecord): void {
  if (storage === null) return;
  try {
    storage.setItem(GUEST_STORAGE_KEY, JSON.stringify(rec));
  } catch {
    /* ignore */
  }
}

/** expiresAt in ms (the server may send seconds or milliseconds since the epoch). */
export function sessionExpiryMs(s: GuestSession): number {
  return s.expiresAt > 1e11 ? s.expiresAt : s.expiresAt * 1000;
}

export function sessionValid(s: GuestSession | null, nowEpochMs = Date.now()): s is GuestSession {
  return s !== null && sessionExpiryMs(s) - nowEpochMs > SESSION_MIN_REMAINING_MS;
}

/** Absolute WebSocket URL from what the matchmaker returned (relative paths go through the page origin). */
export function resolveWsUrl(wsUrl: string): string {
  if (wsUrl.startsWith('ws://') || wsUrl.startsWith('wss://')) return wsUrl;
  if (wsUrl.startsWith('http://')) return `ws://${wsUrl.slice(7)}`;
  if (wsUrl.startsWith('https://')) return `wss://${wsUrl.slice(8)}`;
  if (typeof location === 'undefined') return wsUrl;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${wsUrl.startsWith('/') ? '' : '/'}${wsUrl}`;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Resolves once `p` settled; rejects with NetError 'cancelled' if `signal` aborts first. */
function untilSettled(p: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return p;
  if (signal.aborted) return Promise.reject(new NetError('cancelled', 'queue cancelled'));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(new NetError('cancelled', 'queue cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    void p.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const WS_OPEN = 1;
/** Host close code: this socket was replaced by a newer one for the same slot (MatchDO); no rejoin. */
export const CLOSE_REPLACED = 4000;

/** The fields of an API error body this client reads. */
interface ErrorBody {
  error?: unknown;
  message?: unknown;
  retryAfterMs?: unknown;
}

/** The parsed body of a 409 from /api/queue. */
interface ConflictBody extends ErrorBody {
  matchId?: unknown;
  kind?: unknown;
}

/** The ServerError of a parsed error body (anything else: empty). */
function serverErrorFrom(body: unknown): ServerError {
  if (typeof body !== 'object' || body === null) return { code: '', message: '', retryAfterMs: 0 };
  const b = body as ErrorBody;
  const r = b.retryAfterMs;
  return {
    code: typeof b.error === 'string' ? b.error : '',
    message: typeof b.message === 'string' ? b.message : '',
    retryAfterMs: typeof r === 'number' && Number.isFinite(r) && r > 0 ? Math.ceil(r) : 0,
  };
}

/** The error body of a failed response (empty when it is not JSON). */
async function serverErrorOf(res: ResponseLike): Promise<ServerError> {
  try {
    return serverErrorFrom(await res.json());
  } catch {
    return serverErrorFrom(null);
  }
}

/** 'code' or 'code: message' for messages ('' without a code). */
function errorDetail(e: ServerError): string {
  if (e.code.length === 0) return '';
  return e.message.length > 0 && e.message !== e.code ? `${e.code}: ${e.message}` : e.code;
}

/** ' detail' for messages, '' without one. */
function codeSuffix(detail: string): string {
  return detail.length > 0 ? ` ${detail}` : '';
}

/** NetError 'http' of a failed response: "<what> failed (<status> <code>: <message>)", the server's code / retryAfterMs attached. */
async function httpError(what: string, res: ResponseLike): Promise<NetError> {
  const info = await serverErrorOf(res);
  return new NetError('http', `${what} failed (${res.status}${codeSuffix(errorDetail(info))})`, res.status, info);
}

// ---- Client --------------------------------------------------------------------------------

export class NetClient {
  readonly clock = new ClockSync();
  readonly loss = new LossEstimator();

  /** Display name (persisted with the guest record). */
  name: string;
  guest: GuestSession | null;
  welcome: Welcome | null = null;
  matchId: string | null = null;

  // Counters (monotonic; NetStats turns them into rates).
  bytesIn = 0;
  bytesOut = 0;
  messagesIn = 0;
  messagesOut = 0;
  snapshotsIn = 0;
  reconnects = 0;
  /** Client clock (now()) when the last snapshot arrived; -1 before the first. */
  lastSnapshotAt = -1;
  /** From the last snapshot. */
  lastBufferHint = 0;
  lastInputTickAcked = 0;

  onOpen: (() => void) | null = null;
  onWelcome: ((w: Welcome) => void) | null = null;
  /** The packet (and its `state` view) is only valid during the callback: copy what you keep. */
  onSnapshot: ((pkt: SnapshotPacket) => void) | null = null;
  onEvent: ((e: MatchEvent) => void) | null = null;
  /** `reconnecting` = a rejoin is in progress; a second onClose with false follows if it fails. */
  onClose: ((code: number, reason: string, reconnecting: boolean) => void) | null = null;
  /** Error / Kick messages from the host and protocol problems. */
  onError: ((code: string, message: string) => void) | null = null;
  /** A Turnstile challenge started (true) / finished (false), for the menu's status line. */
  onTurnstile: ((active: boolean) => void) | null = null;

  /**
   * Anti-bot flows run one at a time (exclusive): the Hud has a single widget slot that
   * Turnstile.getToken hides on exit, and a caller that waited reuses the guest the one before it
   * registered instead of solving a second challenge.
   */
  private antiBotTail: Promise<void> = Promise.resolve();
  /** Bumped by cancelChallenge: flows queued before it give up instead of rendering a widget. */
  private antiBotEpoch = 0;
  /** Aborts the challenge on screen (cancelChallenge). */
  private challengeAbort: AbortController | null = null;

  private readonly apiBase: string;
  private readonly fetchFn: FetchLike;
  private readonly makeWs: WebSocketFactory;
  private readonly now: () => number;
  private readonly storage: StorageLike | null;
  private readonly pingIntervalMs: number;
  private readonly turnstileContainer: () => HTMLElement | null;
  private readonly turnstileLoader: TurnstileLoader | undefined;
  /** GET /api/config in flight or done (null again after a failure so the next call retries). */
  private configPromise: Promise<ServerConfig> | null = null;

  private ws: WebSocketLike | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closedByUs = false;
  private reconnectUsed = false;
  private allowReconnect = true;
  private queueAbort: AbortController | null = null;
  /** A leaveMatch() in flight: the next queue waits for it (the lock must be free before the join). */
  private leavePending: Promise<boolean> | null = null;
  /** /api/leave calls made for a 409 / leaveMatch (tests, debug). */
  leaves = 0;
  /** Playlists searched by the next queue (several at once); null = only the `mode` argument. */
  queueModes: Welcome['mode'][] | null = null;
  /** Matchmaking region (REGIONS id) of the next queue, null = automatic (the continent of the request). */
  region: string | null = null;
  /**
   * A signed-in account's session (AccountClient.sessionForQueue), valid for at least `minValidMs`
   * more when given (refreshBearer); null / unset = guest.
   */
  sessionProvider: ((minValidMs?: number) => Promise<GuestSession | null>) | null = null;
  /** The server refused the session (401): an account refreshes it (AccountClient.sessionRejected). */
  onSessionRejected: (() => Promise<unknown>) | null = null;
  /** The Bearer of the last queue / rejoin (an account's or the guest's): leave / ice / cancel use it. */
  lastBearer: string | null = null;
  /** Whose `lastBearer` it is: refreshBearer only swaps in a session of the same player. */
  private lastBearerPlayer: string | null = null;
  /** The region the last queue went to (leave / rejoin must reach the same matchmaker). */
  private queuedRegion: string | null = null;

  private readonly inputBuf = new Uint8Array(INPUT_HEADER + INPUT_MAX_BATCH * PACKED_INPUT_BYTES);
  private readonly pingBuf = new Uint8Array(PING_LEN);
  private readonly pong: PongPacket = { t0: 0, t1: 0, t2: 0, hostTick: 0 };
  private readonly snapshot: SnapshotPacket = {
    tick: 0,
    lastInputTick: 0,
    bufferHint: 0,
    numCars: 0,
    inputs: new Int8Array(MAX_CARS * PACKED_INPUT_BYTES),
    stateLen: 0,
    state: new Uint8Array(0),
    stateHash: 0,
  };

  constructor(opts: NetClientOptions = {}) {
    this.apiBase = opts.apiBase ?? '';
    this.fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));
    this.makeWs = opts.webSocketFactory ?? ((url, protocols) => new WebSocket(url, protocols) as unknown as WebSocketLike);
    this.now = opts.now ?? defaultNow;
    this.storage = opts.storage === undefined ? defaultStorage() : opts.storage;
    this.pingIntervalMs = opts.pingIntervalMs ?? PING_INTERVAL_MS;
    this.turnstileContainer = opts.turnstileContainer ?? (() => null);
    this.turnstileLoader = opts.turnstileLoader;
    const rec = loadGuestRecord(this.storage);
    this.name = rec.name;
    this.guest = rec.session;
  }

  // ---- guest / queue ---------------------------------------------------------------------

  setName(name: string): void {
    const n = sanitizeName(name);
    if (n === this.name) return;
    this.name = n;
    saveGuestRecord(this.storage, { name: this.name, session: this.guest });
  }

  /**
   * The server's public configuration, fetched once (GET /api/config) and cached for the life of
   * the client (= the page). A 404 (server without the route) counts as "no sitekey"; any other
   * failure rejects and is retried by the next call.
   */
  config(): Promise<ServerConfig> {
    let p = this.configPromise;
    if (p !== null) return p;
    p = this.fetchConfig();
    this.configPromise = p;
    p.catch(() => {
      if (this.configPromise === p) this.configPromise = null;
    });
    return p;
  }

  private async fetchConfig(): Promise<ServerConfig> {
    let res: ResponseLike;
    try {
      res = await this.fetchFn(this.apiBase + '/api/config', { method: 'GET', headers: {} });
    } catch (err) {
      throw new NetError('network', `config request failed: ${describe(err)}`);
    }
    // 404: a server without the route (before Turnstile) -> no sitekey, nothing else known.
    if (res.status === 404) return { turnstileSiteKey: null, protocol: 0, version: '', region: '' };
    if (!res.ok) throw await httpError('config', res);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new NetError('protocol', 'malformed config');
    }
    const cfg = parseServerConfig(body);
    if (cfg === null) throw new NetError('protocol', 'malformed config');
    if (cfg.protocol !== 0 && cfg.protocol !== PROTOCOL_VERSION) {
      throw new NetError('protocol', `server protocol ${cfg.protocol} (client ${PROTOCOL_VERSION})`);
    }
    return cfg;
  }

  /**
   * The stored session, or a fresh one from POST /api/guest (also when the name changed). With a
   * sitekey in the config a Turnstile token is obtained first (the widget lives in the container
   * from the options; `signal` cancels the challenge). Rejects with NetError 'turnstile' when the
   * check fails on either side.
   */
  async ensureGuest(signal?: AbortSignal): Promise<GuestSession> {
    if (this.sessionProvider !== null) {
      const a = await this.sessionProvider();
      if (a !== null) {
        this.lastBearer = a.session;
        this.lastBearerPlayer = a.playerId;
        return a;
      }
    }
    const g = this.storedGuest();
    if (g !== null) return g;
    // A lobby join, a queue and a sign-up can ask together: one registration (and one widget) at a
    // time; whoever waited re-checks and reuses the session registered before it.
    return this.exclusive(signal, () => {
      const again = this.storedGuest();
      return again !== null ? Promise.resolve(again) : this.registerGuest(signal);
    });
  }

  /** The stored guest session when it is still valid for the current name (and remembered as the bearer). */
  private storedGuest(): GuestSession | null {
    const g = this.guest;
    if (!sessionValid(g) || g.name !== this.name) return null;
    this.lastBearer = g.session;
    this.lastBearerPlayer = g.playerId;
    return g;
  }

  /** POST /api/guest, with a Turnstile token first when the config has a sitekey. Run under exclusive(). */
  private async registerGuest(signal?: AbortSignal): Promise<GuestSession> {
    const cfg = await this.config();
    const req: GuestRequest = { name: this.name };
    if (cfg.turnstileSiteKey !== null) req.turnstileToken = await this.challenge(cfg.turnstileSiteKey, signal);
    const res = await this.post('/api/guest', req, null);
    if (!res.ok) {
      const info = await serverErrorOf(res);
      if (info.code === 'turnstile_failed' || info.code === 'turnstile_unconfigured') {
        throw new NetError('turnstile', `guest registration refused (${res.status} ${info.code})`, res.status, info);
      }
      throw new NetError('http', `guest registration failed (${res.status}${codeSuffix(errorDetail(info))})`, res.status, info);
    }
    const body = await res.json();
    if (!isGuestSession(body)) throw new NetError('protocol', 'malformed guest session');
    this.guest = body;
    this.lastBearer = body.session;
    this.lastBearerPlayer = body.playerId;
    if (body.name.length > 0) this.name = body.name;
    saveGuestRecord(this.storage, { name: this.name, session: body });
    return body;
  }

  /**
   * A Turnstile token when the server asks for one (its config has a sitekey), else null: account
   * registration (AccountClient) goes through the same anti-bot check as guests.
   */
  async antiBotToken(signal?: AbortSignal): Promise<string | null> {
    const siteKey = (await this.config()).turnstileSiteKey;
    return siteKey === null ? null : this.exclusive(signal, () => this.challenge(siteKey, signal));
  }

  /**
   * Ends the anti-bot challenge on screen and drops the flows waiting for the widget (the menus
   * closed into a match: nobody is there to solve it). They reject with NetError 'cancelled'.
   */
  cancelChallenge(): void {
    this.antiBotEpoch++;
    if (this.challengeAbort !== null) this.challengeAbort.abort();
  }

  /**
   * Run `fn` after every anti-bot flow queued before it settled. `signal` (or a cancelChallenge
   * meanwhile) gives up the wait with NetError 'cancelled'; the next flow still waits for the ones
   * before this one.
   */
  private async exclusive<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    const prev = this.antiBotTail;
    let release!: () => void;
    this.antiBotTail = new Promise<void>((r) => (release = r));
    const epoch = this.antiBotEpoch;
    let running = false;
    try {
      await untilSettled(prev, signal);
      if (epoch !== this.antiBotEpoch) throw new NetError('cancelled', 'challenge cancelled');
      running = true;
      return await fn();
    } finally {
      if (running) release();
      else void prev.then(release);
    }
  }

  /** One Turnstile challenge in the Hud's container; onTurnstile brackets it for the status line. Run under exclusive(). */
  private async challenge(siteKey: string, signal?: AbortSignal): Promise<string> {
    const container = this.turnstileContainer();
    if (container === null) throw new NetError('turnstile', 'no element to render the Turnstile widget into');
    const ctrl = new AbortController();
    const onAbort = (): void => ctrl.abort();
    if (signal !== undefined) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener('abort', onAbort);
    }
    this.challengeAbort = ctrl;
    if (this.onTurnstile) this.onTurnstile(true);
    try {
      return await turnstileToken(siteKey, container, { load: this.turnstileLoader, signal: ctrl.signal });
    } catch (err) {
      if (signal !== undefined && signal.aborted) throw new NetError('cancelled', 'queue cancelled');
      if (ctrl.signal.aborted) throw new NetError('cancelled', 'challenge cancelled');
      throw new NetError('turnstile', describe(err));
    } finally {
      if (signal !== undefined) signal.removeEventListener('abort', onAbort);
      if (this.challengeAbort === ctrl) this.challengeAbort = null;
      if (this.onTurnstile) this.onTurnstile(false);
    }
  }

  /**
   * Quick match: long-poll POST /api/queue until the matchmaker assigns a match. `onWaiting`
   * reports the players waiting after each poll. Rejects with NetError 'cancelled' on cancelQueue().
   * Without a kind (phase 1 callers) the queue is a server match and resolves to a MatchAssignment;
   * with one it resolves to the QueueAssignment the server formed ('p2p' may come back 'server').
   */
  queue(mode: Welcome['mode'], onWaiting?: (waiting: number) => void): Promise<MatchAssignment>;
  queue(mode: Welcome['mode'], kind: QueueKind, onWaiting?: (waiting: number) => void): Promise<QueueAssignment>;
  queue(mode: Welcome['mode'], kindOrWaiting?: QueueKind | ((waiting: number) => void), onWaiting?: (waiting: number) => void): Promise<MatchAssignment | QueueAssignment> {
    if (typeof kindOrWaiting === 'string') return this.queueKind(mode, kindOrWaiting, onWaiting);
    // Phase 1 shape: the plain server assignment (a p2p answer to a server queue is a protocol error).
    return this.queueKind(mode, 'server', kindOrWaiting).then((a) => {
      if (a.kind !== 'server') throw new NetError('protocol', 'server queue answered with a p2p room');
      return { matchId: a.matchId, ticket: a.ticket, wsUrl: a.wsUrl };
    });
  }

  private async queueKind(mode: Welcome['mode'], kind: QueueKind, onWaiting?: (waiting: number) => void): Promise<QueueAssignment> {
    if (this.queueAbort !== null) throw new NetError('state', 'already queueing');
    const ctrl = new AbortController();
    this.queueAbort = ctrl;
    try {
      let session = await this.ensureGuest(ctrl.signal);
      let reRegistered = false;
      let recovered = false;
      for (;;) {
        if (ctrl.signal.aborted) throw new NetError('cancelled', 'queue cancelled');
        // A room lock being released (leaveMatch): the join must land after it, or it answers 409.
        const leaving = this.leavePending;
        if (leaving !== null) await leaving.catch(() => false);
        if (ctrl.signal.aborted) throw new NetError('cancelled', 'queue cancelled');
        let res: ResponseLike;
        try {
          res = await this.post('/api/queue', this.queueBody(mode, kind), session.session, ctrl.signal);
        } catch (err) {
          if (ctrl.signal.aborted) throw new NetError('cancelled', 'queue cancelled');
          throw new NetError('network', `queue request failed: ${describe(err)}`);
        }
        if (res.status === 401) {
          // Expired / unknown session: register again, once. A second 401 (a proxy stripping
          // Authorization, a server misconfiguration) is an error, not a loop.
          if (reRegistered) throw new NetError('http', 'session rejected', 401);
          reRegistered = true;
          if (this.onSessionRejected !== null) await this.onSessionRejected().catch(() => undefined);
          this.guest = null;
          session = await this.ensureGuest(ctrl.signal);
          continue;
        }
        if (res.status === 409) {
          let body: ConflictBody = {};
          try {
            const parsed: unknown = await res.json();
            if (typeof parsed === 'object' && parsed !== null) body = parsed as ConflictBody;
          } catch {
            /* no body */
          }
          const info = serverErrorFrom(body);
          if (body.error === 'active_match' && typeof body.matchId === 'string') {
            if (body.kind === 'p2p' || kind === 'p2p') {
              // A P2P room of ours is (or looks) alive: it cannot be rejoined (single-use ticket, no
              // authority to resync from). A server match on a P2P queue is not rejoined either: the
              // player asked for P2P (a match it quit whose release never reached the server would
              // pull it back in). Free that lock (POST /api/leave { matchId }: a server match hands
              // our car to its bots) and queue again, once.
              if (!recovered) {
                recovered = true;
                await this.leaveActive(session.session, body.matchId, ctrl.signal);
                continue;
              }
              const what = body.kind === 'p2p' ? `la sala P2P ${body.matchId.slice(0, 8)} sigue activa` : `el partido en servidor ${body.matchId.slice(0, 8)} sigue activo`;
              throw new NetError('http', `queue failed (409 ${errorDetail(info) || 'active_match'}: ${what})`, 409, info);
            }
            // A server match of ours is alive (e.g. the matchmaker filled a room we had stopped
            // polling for): rejoin it with a fresh ticket instead of failing. Gone (404 / 410: the
            // Worker freed the lock) -> queue again, once.
            try {
              const m = await this.rejoin(body.matchId);
              this.reconnectUsed = false; // a fresh assignment gets its own reconnect budget
              this.allowReconnect = true;
              return { kind: 'server', matchId: m.matchId, ticket: m.ticket, wsUrl: m.wsUrl, ...(kind === 'ranked' ? { ranked: true } : {}) };
            } catch (err) {
              if (recovered || !(err instanceof NetError) || (err.status !== 404 && err.status !== 410)) throw err;
              recovered = true;
              // 410 p2p_room: that id is a P2P room (an older server 409 without its kind): free it first.
              if (err.serverCode === 'p2p_room') await this.leaveActive(session.session, body.matchId, ctrl.signal);
              continue;
            }
          }
          throw new NetError('http', `queue failed (409 ${errorDetail(info) || 'conflict'})`, 409, info);
        }
        // 429 no_show (with retryAfterMs), 426 reload_required, 503 capacity: the code rides on the error.
        if (!res.ok) throw await httpError('queue', res);
        const q = (await res.json()) as QueueResult | QueueResultP2p;
        if (q.status === 'matched') {
          if (typeof q.ticket !== 'string' || typeof q.wsUrl !== 'string') throw new NetError('protocol', 'matched without ticket / wsUrl');
          if ((q as QueueResultP2p).kind === 'p2p') {
            const roomId = (q as QueueResultP2p).roomId;
            if (typeof roomId !== 'string') throw new NetError('protocol', 'p2p match without roomId');
            return { kind: 'p2p', roomId, ticket: q.ticket, wsUrl: q.wsUrl };
          }
          const matchId = (q as QueueResult).matchId;
          if (typeof matchId !== 'string') throw new NetError('protocol', 'matched without matchId');
          this.matchId = matchId;
          this.reconnectUsed = false;
          this.allowReconnect = true;
          const out: ServerAssignment = { kind: 'server', matchId, ticket: q.ticket, wsUrl: q.wsUrl };
          if ((q as QueueResult).ranked === true) out.ranked = true;
          return out;
        }
        const waiting = (q as QueueResult).waiting;
        if (onWaiting) onWaiting(typeof waiting === 'number' ? waiting : 0);
      }
    } finally {
      if (this.queueAbort === ctrl) this.queueAbort = null;
    }
  }

  /**
   * GET /api/ice: the STUN / TURN servers for the P2P mesh (TURN credentials are short-lived, so
   * fetch right before the room). A server without the route (404) gives DEFAULT_ICE_SERVERS; a
   * malformed body rejects with NetError 'protocol'. Sent with the session when there is one.
   */
  async fetchIce(): Promise<IceServer[]> {
    const headers: Record<string, string> = {};
    const bearer = this.lastBearer ?? this.guest?.session ?? null;
    if (bearer !== null) headers.authorization = `Bearer ${bearer}`;
    let res: ResponseLike;
    try {
      res = await this.fetchFn(this.apiBase + '/api/ice', { method: 'GET', headers });
    } catch (err) {
      throw new NetError('network', `ice request failed: ${describe(err)}`);
    }
    if (res.status === 404) return DEFAULT_ICE_SERVERS.slice();
    if (!res.ok) throw await httpError('ice', res);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new NetError('protocol', 'malformed ice servers');
    }
    const servers = parseIceServers(body);
    if (servers === null) throw new NetError('protocol', 'malformed ice servers');
    return servers.length > 0 ? servers : DEFAULT_ICE_SERVERS.slice();
  }

  get queueing(): boolean {
    return this.queueAbort !== null;
  }

  /**
   * Stop waiting: aborts the long-poll (queue() rejects with 'cancelled') and tells the matchmaker
   * to drop us (POST /api/leave, best effort, no retry) so the bot fill does not open a room we
   * never join. Without a session yet nothing was queued server-side (the join is skipped).
   */
  cancelQueue(): void {
    const ctrl = this.queueAbort;
    if (ctrl === null) return;
    ctrl.abort();
    const bearer = this.lastBearer ?? this.guest?.session ?? null;
    if (bearer !== null) void this.post('/api/leave', this.withRegion({}), bearer).catch(() => undefined);
  }

  /**
   * POST /api/leave after a P2P room (fallback, leave, cancel, failure, the final whistle; no
   * `matchId`): the matchmaker frees our one-active-match lock for the room at once and kicks our
   * room socket if it is still open. With the `matchId` of a server match (OnlineSession.leave: an
   * explicit quit) that match's lock is freed too and the MatchDO hands our car to its bots for
   * good (no rejoin); without one a server lock is kept (the rejoin path). Resolves with the
   * server's `released` flag (false without a session, on a network error or when there was
   * nothing to release). The next queue() waits for it. `opts.connected` false adds
   * `connected: false` (no Welcome came). `opts.retryRejected` (a match on a community node, which
   * this POST is the only way out of): a 401 is retried once with a refreshed account session
   * (leaveAgain).
   */
  leaveMatch(matchId?: string, opts: LeaveOptions = {}): Promise<boolean> {
    const bearer = this.lastBearer ?? this.guest?.session ?? null;
    if (bearer === null) return Promise.resolve(false);
    // Whose leave it is: lastBearer may belong to someone else by the time a retry goes out.
    const who = this.lastBearerPlayer;
    this.leaves++;
    const fields: { matchId?: string; connected?: false } = matchId !== undefined ? { matchId } : {};
    if (opts.connected === false) fields.connected = false;
    const payload = this.withRegion(fields);
    // The first POST goes out now, before the caller closes the socket; only a retry waits.
    let answer = this.post('/api/leave', payload, bearer);
    if (opts.retryRejected === true) answer = answer.then((res) => (res.status === 401 ? this.leaveAgain(payload, bearer, who, res) : res));
    const p = answer
      .then(async (res) => {
        if (!res.ok) return false;
        try {
          const body = (await res.json()) as { released?: unknown };
          return body.released === true;
        } catch {
          return false;
        }
      })
      .catch(() => false)
      .finally(() => {
        if (this.leavePending === p) this.leavePending = null;
      });
    this.leavePending = p;
    return p;
  }

  /**
   * A leave refused with 401: refresh the account's session (onSessionRejected) and POST the same
   * body with it, once. Only a fresh session of `who`, the player the leave was sent as, is used:
   * another flow (the menu starting a queue) may have moved lastBearer to a guest or another
   * account meanwhile. Resolves the refusal when there is none (a guest, a sign-out, a refresh
   * that failed) or the retry does not get through.
   */
  private async leaveAgain(body: object, bearer: string, who: string | null, refused: ResponseLike): Promise<ResponseLike> {
    if (this.onSessionRejected !== null) await this.onSessionRejected().catch(() => undefined);
    const fresh = await this.refreshBearer();
    if (fresh === null || fresh.playerId !== who || fresh.session === bearer) return refused;
    this.leaves++;
    return this.post('/api/leave', body, fresh.session).catch(() => refused);
  }

  /**
   * Make `lastBearer` (what leave / ice / cancel send) good for `minValidMs` more: an account's
   * session is refreshed early through sessionProvider, a guest's (24 h) stays. Only a session of
   * the player `lastBearer` belongs to replaces it (a sign-in since the queue must not leave as
   * someone else). Resolves the session it adopted, null when the old Bearer stays. Never rejects:
   * on a failure the old Bearer stays and a 401 on the leave asks again.
   */
  async refreshBearer(minValidMs?: number): Promise<GuestSession | null> {
    const provider = this.sessionProvider;
    if (provider === null) return null;
    let s: GuestSession | null;
    try {
      s = await provider(minValidMs);
    } catch {
      return null;
    }
    if (s === null || s.playerId !== this.lastBearerPlayer) return null;
    this.lastBearer = s.session;
    return s;
  }

  /**
   * POST /api/queue body: the playlists (`queueModes`, else `mode`), the region when one is
   * chosen; a P2P queue states this page's P2P protocol (a stale page is refused with 426 reload_required).
   */
  private queueBody(mode: Welcome['mode'], kind: QueueKind): QueueRequestP2p | { mode: Welcome['mode']; kind: QueueKind } {
    const body: Record<string, unknown> = { mode, kind };
    const modes = this.queueModes;
    if (modes !== null && modes.length > 0) body.modes = modes.slice();
    if (this.region !== null) body.region = this.region;
    if (kind === 'p2p') body.p2pProtocol = P2P_PROTOCOL_VERSION;
    this.queuedRegion = this.region;
    return body as unknown as QueueRequestP2p;
  }

  /** `body` plus the region of the last queue (leave / rejoin reach the matchmaker that holds our lock). */
  private withRegion<T extends object>(body: T): T & { region?: string } {
    return this.queuedRegion !== null ? { ...body, region: this.queuedRegion } : body;
  }

  /** The 409 recovery: POST /api/leave { matchId } (awaited; errors are swallowed: the retry's answer decides). */
  private async leaveActive(bearer: string, matchId: string, signal: AbortSignal): Promise<void> {
    this.leaves++;
    try {
      await this.post('/api/leave', this.withRegion({ matchId }), bearer, signal);
    } catch {
      /* the retry below reports the real reason */
    }
  }

  // ---- socket ----------------------------------------------------------------------------

  /** Open the match socket; the ticket travels in the subprotocol list (browsers cannot set headers). */
  connect(wsUrl: string, ticket: string): void {
    this.closeSocket(1000, 'reconnect');
    this.closedByUs = false;
    this.welcome = null;
    this.clock.reset();
    this.loss.reset();
    this.lastSnapshotAt = -1;
    const ws = this.makeWs(resolveWsUrl(wsUrl), [WS_SUBPROTOCOL, WS_TICKET_PREFIX + ticket]);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.startPing();
      if (this.onOpen) this.onOpen();
    };
    ws.onmessage = (ev) => {
      if (ws === this.ws) this.handleMessage(ev.data);
    };
    ws.onclose = (ev) => this.handleClose(ws, ev.code, ev.reason);
    ws.onerror = () => {
      /* a close event follows */
    };
    this.ws = ws;
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WS_OPEN;
  }

  /** Close the socket (code 1000 = leaving on purpose: no reconnect). */
  close(code = 1000, reason = ''): void {
    this.closedByUs = true;
    this.cancelQueue();
    this.closeSocket(code, reason);
  }

  /** Batched inputs: `count` ticks from `firstTick`, 6 int8 each at packed[packedOff..], oldest first. */
  sendInputs(firstTick: number, count: number, packed: Int8Array, ackTick: number, packedOff = 0): boolean {
    const ws = this.ws;
    if (ws === null || ws.readyState !== WS_OPEN || count < 1 || count > INPUT_MAX_BATCH) return false;
    const len = encodeInput(this.inputBuf, firstTick, count, ackTick, packed, packedOff);
    ws.send(this.inputBuf.subarray(0, len));
    this.bytesOut += len;
    this.messagesOut++;
    return true;
  }

  sendReady(): void {
    this.sendJson(MsgType.Ready, {});
  }

  /** Estimated host tick now (fractional); 0 until the first pong. */
  hostTickEstimate(nowMs = this.now()): number {
    return this.clock.hostTickEstimate(nowMs);
  }

  get rtt(): number {
    return this.clock.rtt;
  }

  get jitter(): number {
    return this.clock.jitter;
  }

  /** ms since the last snapshot arrived (-1 before the first). */
  snapshotAge(nowMs = this.now()): number {
    return this.lastSnapshotAt < 0 ? -1 : nowMs - this.lastSnapshotAt;
  }

  /** Drop everything (leaving the menu); counters stay for the panel. */
  dispose(): void {
    this.close(1000, 'dispose');
    this.onOpen = null;
    this.onWelcome = null;
    this.onSnapshot = null;
    this.onEvent = null;
    this.onClose = null;
    this.onError = null;
  }

  // ---- internals -------------------------------------------------------------------------

  private async post(path: string, body: unknown, bearer: string | null, signal?: AbortSignal): Promise<ResponseLike> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (bearer !== null) headers.authorization = `Bearer ${bearer}`;
    const init: RequestInitLike = { method: 'POST', headers, body: JSON.stringify(body) };
    if (signal !== undefined) init.signal = signal;
    return this.fetchFn(this.apiBase + path, init);
  }

  private sendJson(type: MsgType, payload: unknown): void {
    const ws = this.ws;
    if (ws === null || ws.readyState !== WS_OPEN) return;
    const frame = encodeJson(type, payload);
    ws.send(frame);
    this.bytesOut += frame.length;
    this.messagesOut++;
  }

  private startPing(): void {
    this.stopPing();
    this.sendPing();
    const timer: unknown = setInterval(() => this.sendPing(), this.pingIntervalMs);
    // Under node (tests) a live interval would keep the process alive after the test ends.
    if (typeof timer === 'object' && timer !== null && typeof (timer as { unref?: unknown }).unref === 'function') {
      (timer as { unref(): void }).unref();
    }
    this.pingTimer = timer as ReturnType<typeof setInterval>;
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /** Public for tests / manual clock probes. */
  sendPing(): void {
    const ws = this.ws;
    if (ws === null || ws.readyState !== WS_OPEN) return;
    const len = encodePing(this.pingBuf, this.now());
    ws.send(this.pingBuf.subarray(0, len));
    this.bytesOut += len;
    this.messagesOut++;
  }

  private handleMessage(data: unknown): void {
    if (!(data instanceof ArrayBuffer)) return;
    const buf = new Uint8Array(data);
    this.bytesIn += buf.length;
    this.messagesIn++;
    if (buf.length === 0) return;
    switch (msgType(buf)) {
      case MsgType.Snapshot: {
        const pkt = this.snapshot;
        if (!decodeSnapshot(buf, pkt)) return;
        this.snapshotsIn++;
        this.lastSnapshotAt = this.now();
        this.lastBufferHint = pkt.bufferHint;
        this.lastInputTickAcked = pkt.lastInputTick;
        this.loss.onSnapshotTick(pkt.tick);
        if (this.onSnapshot) this.onSnapshot(pkt);
        return;
      }
      case MsgType.Pong: {
        const p = this.pong;
        if (!decodePong(buf, p)) return;
        this.clock.addPong(p.t0, p.t1, p.t2, this.now(), p.hostTick);
        return;
      }
      case MsgType.Welcome: {
        const w = decodeJson<Welcome>(buf);
        if (w.protocol !== PROTOCOL_VERSION) {
          this.fail('protocol', `protocol ${w.protocol} (client ${PROTOCOL_VERSION})`);
          return;
        }
        this.welcome = w;
        this.matchId = w.matchId;
        if (this.onWelcome) this.onWelcome(w);
        return;
      }
      case MsgType.Event: {
        const e = decodeJson<MatchEvent>(buf);
        if (e.type === 'ended') this.allowReconnect = false;
        if (this.onEvent) this.onEvent(e);
        return;
      }
      case MsgType.Error: {
        const e = decodeJson<{ code?: string; message?: string }>(buf);
        if (this.onError) this.onError(e.code ?? 'error', e.message ?? 'host error');
        return;
      }
      case MsgType.Kick: {
        const k = decodeJson<{ reason?: string }>(buf);
        this.allowReconnect = false;
        if (this.onError) this.onError('kick', k.reason ?? 'kicked');
        return;
      }
      default:
        return;
    }
  }

  private fail(code: string, message: string): void {
    this.allowReconnect = false;
    if (this.onError) this.onError(code, message);
    this.close(1002, message);
  }

  private handleClose(ws: WebSocketLike, code: number, reason: string): void {
    if (ws !== this.ws) return;
    this.ws = null;
    this.stopPing();
    const canRejoin =
      !this.closedByUs && this.allowReconnect && !this.reconnectUsed && code !== 1000 && code !== CLOSE_REPLACED && this.matchId !== null;
    if (!canRejoin) {
      if (this.onClose) this.onClose(code, reason, false);
      return;
    }
    this.reconnectUsed = true;
    this.reconnects++;
    if (this.onClose) this.onClose(code, reason, true);
    this.rejoin(this.matchId as string).then(
      (m) => {
        if (this.closedByUs) return;
        this.connect(m.wsUrl, m.ticket);
      },
      (err: unknown) => {
        if (this.onClose) this.onClose(code, err instanceof NetError ? err.message : `rejoin failed: ${describe(err)}`, false);
      },
    );
  }

  /**
   * POST /api/rejoin { matchId } with the session -> a fresh ticket for a match that still lists
   * us (reconnection, or a room the matchmaker formed while we were not polling).
   */
  async rejoin(matchId: string): Promise<MatchAssignment> {
    const session = await this.ensureGuest();
    const res = await this.post('/api/rejoin', this.withRegion({ matchId }), session.session);
    // 404 no_match / 410 match_over, match_reset: the room is gone (the Worker frees our lock);
    // 410 p2p_room: a P2P room id (never rejoinable; POST /api/leave frees that lock).
    if (!res.ok) throw await httpError('rejoin', res);
    const q = (await res.json()) as QueueResult;
    if (typeof q.ticket !== 'string' || typeof q.wsUrl !== 'string') throw new NetError('protocol', 'rejoin without ticket / wsUrl');
    this.matchId = q.matchId ?? matchId;
    return { matchId: this.matchId, ticket: q.ticket, wsUrl: q.wsUrl };
  }

  private closeSocket(code: number, reason: string): void {
    const ws = this.ws;
    this.stopPing();
    if (ws === null) return;
    this.ws = null;
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
  }
}
