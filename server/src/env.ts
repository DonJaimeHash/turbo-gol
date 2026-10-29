import type { IceServer } from '../../src/net/p2p/protocol';
import { DEFAULT_MATCH_SECONDS } from '../../src/game/Match';

/** Bindings and vars declared in wrangler.jsonc (+ secrets from .dev.vars / `wrangler secret put`). */
export interface Env {
  MATCH: DurableObjectNamespace;
  MATCHMAKER: DurableObjectNamespace;
  /** Phase 2: signaling rooms of the peer-to-peer matches (RoomDO, Hibernation API). */
  ROOM: DurableObjectNamespace;
  /** Every registered account, rating and ranked result (AccountsDO, SQLite, one object 'accounts-v1'). */
  ACCOUNTS: DurableObjectNamespace;
  /** Custom-match lobbies (LobbyDO, one per lobby, Hibernation API) and their directory (LobbyDirectoryDO, one object). */
  LOBBY: DurableObjectNamespace;
  LOBBY_DIR: DurableObjectNamespace;
  /**
   * Secrets, optional, OAuth sign-in (both of a pair or none). Google: Cloud console -> APIs & Services
   * -> Credentials -> OAuth client ID (Web application); Discord: Developer Portal -> Applications ->
   * OAuth2. Authorized redirect URI: <origin>/api/auth/oauth/google|discord/callback.
   */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  /** Var, optional: the public origin for OAuth redirect URIs (default: the request's own origin). */
  PUBLIC_ORIGIN?: string;
  FLAGS: KVNamespace;
  /** Workers Assets (wrangler.jsonc `assets`): the Vite build in ../dist, served for every path outside /api, /ws, /room and /lobby. */
  ASSETS?: Fetcher;
  MATCH_LENGTH_SECONDS: string | number;
  REGION_OVERRIDE: string;
  /** Secret. Signs sessions, tickets and the internal Worker <-> DO header. */
  JWT_SECRET: string;
  /** Secret, optional: when set, POST /api/guest requires a valid Turnstile token. */
  TURNSTILE_SECRET?: string;
  /**
   * Var (public, wrangler.jsonc `vars` / dashboard), optional: the Turnstile sitekey paired with
   * TURNSTILE_SECRET. Served to the browser by GET /api/config so it can render the widget; unset
   * (local dev) = no widget. A deploy with the secret but no sitekey cannot create guests.
   */
  TURNSTILE_SITEKEY?: string;
  /**
   * Var, optional: "1" switches the anti-bot check OFF everywhere (pre-production only): POST
   * /api/guest accepts any request and GET /api/config reports no sitekey so the browser never
   * renders the widget. Remove it (or set "0") before opening the game to the public.
   */
  TURNSTILE_DISABLED?: string;
  /** Optional comma-separated list of allowed browser origins; unset = '*' (dev). */
  VITE_ORIGINS?: string;
  /**
   * Secrets, optional, phase 2 (both or none): a Cloudflare Realtime TURN key (dashboard ->
   * Realtime -> TURN -> create key; `npx wrangler secret put TURN_KEY_ID` / `TURN_KEY_TOKEN`).
   * When both are set, GET /api/ice and the RoomDO's welcome append 10-minute TURN credentials,
   * minted per request (nothing cached) through
   *   POST https://rtc.live.cloudflare.com/v1/turn/keys/{TURN_KEY_ID}/credentials/generate-ice-servers
   *   Authorization: Bearer TURN_KEY_TOKEN, body { ttl: 600 }
   * Without them (local dev) peers get STUN only (stun.cloudflare.com:3478), so a pair that needs a
   * relay cannot connect. Budget (DECISIONS.md): Cloudflare TURN includes 1,000 GB/month.
   */
  TURN_KEY_ID?: string;
  TURN_KEY_TOKEN?: string;
  /**
   * Community nodes (nodes/), all optional: a fork or a test env without them never reaches a node
   * (nodesConfigured). NODES: the NodeRegistryDO, one object 'nodes-v1' (nodeApi.ts) around the
   * control plane.
   */
  NODES?: DurableObjectNamespace;
  /** R2: the replays the nodes upload, re-simulated before a ranked result counts. */
  NODE_REPLAYS?: R2Bucket;
  /** R2: the signed node releases, the installers and channel.json (the release the nodes are held to). */
  NODE_RELEASES?: R2Bucket;
  /** Secret: the Ed25519 private key (PKCS#8, `npm run keys` in nodes/) that signs the players' node tickets. */
  NODE_CONTROL_PRIVATE_KEY?: string;
  /** Var: its public half, which the nodes check those tickets with. */
  NODE_CONTROL_PUBLIC_KEY?: string;
  /**
   * Secret: the project's account ids, comma-separated (trustedOperatorIds). Their nodes are
   * trusted: they verify ranked replays, their own included. A secret rather than a var: it
   * survives deploys, keeps the ids out of the public repo, and a fork without it trusts nobody.
   */
  NODE_TRUSTED_OPERATORS?: string;
  /** Secret, optional: a staff-only Discord channel's webhook URL the control plane posts its ALERT lines to (nodeAlerts.ts). */
  NODE_ALERT_WEBHOOK?: string;
  /** Var: the public origin the nodes and the installers reach the control plane at (https://turbo-gol.com). */
  NODES_PUBLIC_BASE?: string;
  /**
   * Workers Rate Limiting bindings (wrangler.jsonc `ratelimits`), named after their limit per 60 s:
   * the counters behind limits.ts's table, shared by the isolates of one Cloudflare location.
   * Optional: without them (tests, a fork) only the in-isolate counts apply.
   */
  RL_10?: RateLimit;
  RL_30?: RateLimit;
  RL_60?: RateLimit;
  RL_120?: RateLimit;
  RL_1200?: RateLimit;
}

export const SERVER_VERSION = '0.1.0';

export function matchLengthSeconds(env: Env): number {
  const n = Number(env.MATCH_LENGTH_SECONDS);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_MATCH_SECONDS;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

export function json(body: unknown, status: number = 200, extra?: HeadersInit): Response {
  const h = new Headers(JSON_HEADERS);
  if (extra) new Headers(extra).forEach((v, k) => h.set(k, v));
  return new Response(JSON.stringify(body), { status, headers: h });
}

export function error(status: number, code: string, message?: string): Response {
  return json({ error: code, message: message ?? code }, status);
}

/** The largest body readJson reads. */
export const JSON_MAX_BYTES = 4096;

/**
 * The body (of a request, or of a response: a node's /healthz answer), or null when it is longer
 * than `max` bytes. Reading stops there: a body sent without a Content-Length (chunked, HTTP/2) is
 * never buffered whole before it is found too big.
 */
export async function readCapped(request: Pick<Request, 'headers' | 'body'>, max: number): Promise<Uint8Array | null> {
  if (Number(request.headers.get('content-length') ?? 0) > max) {
    await request.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value as Uint8Array;
    size += chunk.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** Parse a JSON body (<= 4 KB, readCapped) or return null. */
export async function readJson<T>(request: Request): Promise<T | null> {
  try {
    const bytes = await readCapped(request, JSON_MAX_BYTES);
    if (!bytes) return null;
    if (bytes.byteLength === 0) return {} as T;
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

/**
 * The owner's rule for experimental physics (src/game/physicsRules.ts): every ranked or counted
 * match, P2P included, runs the standard physics, and a match with experimental rules counts for
 * nothing. True when a decoded body carries rules (a `physics` that is neither absent nor null):
 * the queues, server matches (MatchDO), community node placements and every report that rates,
 * strikes or records something refuse such a body, whoever sent it.
 */
export function carriesPhysics(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const v = (body as { physics?: unknown }).physics;
  return v !== undefined && v !== null;
}

/** The refusal of a body that carries experimental rules where only standard physics may run. */
export const EXPERIMENTAL_REFUSED = 'experimental_lobby_only';

/** `p`, or a rejection once `ms` passed without it settling. The work itself goes on; nothing waits for it. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${ms / 1000} s`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/**
 * The key a per-address limit counts under: an IPv4 address as it is, an IPv6 one by its /64.
 * One subscriber gets a whole /64 and picks the other 64 bits freely, so counting full IPv6
 * addresses would give each caller as many fresh windows as it likes.
 */
export function limitKey(ip: string): string {
  if (!ip.includes(':') || ip.includes('.')) return ip; // IPv4, IPv4-mapped, or 'local' under wrangler dev
  const [head, tail] = ip.toLowerCase().split('::', 2);
  const front = head ? head.split(':') : [];
  const back = tail ? tail.split(':') : [];
  const groups = tail === undefined ? front : [...front, ...Array<string>(Math.max(0, 8 - front.length - back.length)).fill('0'), ...back];
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

export type GameModeId = '1v1' | '2v2' | '3v3';

export function isMode(v: unknown): v is GameModeId {
  return v === '1v1' || v === '2v2' || v === '3v3';
}

/** 3-16 visible chars, letters / digits / space / _ - . ; otherwise null. */
export function sanitizeName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.normalize('NFKC').replace(/[^\p{L}\p{N} _.\-]/gu, '').replace(/\s+/g, ' ').trim();
  if (s.length < 3 || s.length > 16) return null;
  return s;
}

export function isHex(v: unknown, len: number): v is string {
  return typeof v === 'string' && v.length === len && /^[0-9a-f]+$/.test(v);
}

/**
 * POST /api/queue `kind`: casual in a peer-to-peer room (phase 2, the default), casual in a Durable
 * Object match (phase 1), or ranked (accounts only; a server-authoritative MatchDO match, rated).
 */
export type QueueKind = 'p2p' | 'server' | 'ranked';
/** What a match / room lock points at: a RoomDO signaling room or a MatchDO match (ranked ones included). */
export type RoomKind = 'p2p' | 'server';
/** A matchmaker lock: one of the Worker's own rooms, or a match on a community node (NodeRegistryDO). */
export type LockKind = RoomKind | 'node';

export function isQueueKind(v: unknown): v is QueueKind {
  return v === 'p2p' || v === 'server' || v === 'ranked';
}

export function isModeList(v: unknown): v is GameModeId[] {
  return Array.isArray(v) && v.length >= 1 && v.length <= 3 && v.every(isMode) && new Set(v).size === v.length;
}

// ---- KV flags ----------------------------------------------------------------------------------

/** A KV flag's raw value: null when it is not set, or KV cannot be read (every flag then reads as off). */
async function flagValue(env: Pick<Env, 'FLAGS'>, name: string): Promise<string | null> {
  try {
    return await env.FLAGS.get(name, { cacheTtl: 60 });
  } catch {
    return null;
  }
}

/** A KV flag is set: '1', 'true' or 'on'. Edge-cached 60 s: a flip takes up to a minute to land. */
export async function flag(env: Pick<Env, 'FLAGS'>, name: string): Promise<boolean> {
  const v = await flagValue(env, name);
  return v === '1' || v === 'true' || v === 'on';
}

// ---- Community nodes ---------------------------------------------------------------------------

/** An account id (accountStore.ts randomId): 16 lowercase hex characters. */
const ACCOUNT_ID = /^[0-9a-f]{16}$/;

/** The account ids of a comma-separated list. Anything else is dropped: a typo names nobody. */
function accountIds(list: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const s of (list ?? '').split(',')) {
    const id = s.trim();
    if (ACCOUNT_ID.test(id)) out.add(id);
  }
  return out;
}

/** Whose matches community nodes may host: nobody, everybody, or a canary of account ids. */
export type NodesMode = 'off' | 'all' | ReadonlySet<string>;

/**
 * The KV flag nodes_on: absent or '0' is 'off' (matchmaking as without nodes), '1' is 'all', and a
 * comma-separated list of account ids is a canary (nodesAllowed). Anything else, a list without a
 * single valid id included, is off: a mistyped flag fails closed. vm_disabled is the emergency
 * switch (every match back on the Worker's own servers, no deploy): it wins over nodes_on.
 */
export async function nodesMode(env: Pick<Env, 'FLAGS'>): Promise<NodesMode> {
  const [on, disabled] = await Promise.all([flagValue(env, 'nodes_on'), flag(env, 'vm_disabled')]);
  if (disabled || on === null) return 'off';
  const v = on.trim();
  if (v === '1') return 'all';
  const ids = accountIds(v);
  return ids.size > 0 ? ids : 'off';
}

/** A match of these players may go to a node: nodes are on for all, or every one of them is in the canary. */
export function nodesAllowed(mode: NodesMode, playerIds: readonly string[]): boolean {
  if (mode === 'off') return false;
  if (mode === 'all') return true;
  return playerIds.length > 0 && playerIds.every((id) => mode.has(id));
}

/** NODE_TRUSTED_OPERATORS as account ids (an entry that is not one is dropped, so it trusts nobody). */
export function trustedOperatorIds(env: Pick<Env, 'NODE_TRUSTED_OPERATORS'>): Set<string> {
  return accountIds(env.NODE_TRUSTED_OPERATORS);
}

/** An Env with everything the node control plane needs (nodesConfigured). */
export type NodesEnv = Env & Required<Pick<Env, 'NODES' | 'NODE_REPLAYS' | 'NODE_RELEASES' | 'NODE_CONTROL_PRIVATE_KEY' | 'NODE_CONTROL_PUBLIC_KEY' | 'NODES_PUBLIC_BASE'>>;

/**
 * The node control plane can run: its Durable Object, both R2 buckets, both halves of its key and
 * the public origin the nodes reach it at (the registration answer and the install line carry it)
 * are there. Without any of them nothing is sent to a node, whatever nodes_on says.
 */
export function nodesConfigured(env: Env): env is NodesEnv {
  return !!env.NODES && !!env.NODE_REPLAYS && !!env.NODE_RELEASES && !!env.NODE_CONTROL_PRIVATE_KEY && !!env.NODE_CONTROL_PUBLIC_KEY && !!env.NODES_PUBLIC_BASE;
}

// ---- ICE servers (GET /api/ice and the RoomDO welcome) -------------------------------------------

/** Always offered: Cloudflare's public STUN. */
export const STUN_URLS: readonly string[] = ['stun:stun.cloudflare.com:3478'];
export const TURN_TTL_SECONDS = 600;
const TURN_API = 'https://rtc.live.cloudflare.com/v1/turn/keys/';
const TURN_TIMEOUT_MS = 3_000;

function asIceServer(v: unknown): IceServer | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { urls?: unknown; username?: unknown; credential?: unknown };
  let urls: string | string[];
  if (typeof o.urls === 'string') urls = o.urls;
  else if (Array.isArray(o.urls) && o.urls.length > 0 && o.urls.every((u): u is string => typeof u === 'string')) urls = o.urls;
  else return null;
  const out: IceServer = { urls };
  if (typeof o.username === 'string') out.username = o.username;
  if (typeof o.credential === 'string') out.credential = o.credential;
  return out;
}

/**
 * The ICE servers a peer should hand to RTCPeerConnection: STUN always; when TURN_KEY_ID and
 * TURN_KEY_TOKEN are configured, fresh TURN credentials (TURN_TTL_SECONDS) from Cloudflare's TURN
 * API are appended. Minted per call, never cached; a TURN API failure or timeout (3 s) logs and
 * degrades to STUN only. `fetchFn` is injectable for tests.
 */
export async function iceServersFor(env: Pick<Env, 'TURN_KEY_ID' | 'TURN_KEY_TOKEN'>, fetchFn: typeof fetch = fetch): Promise<IceServer[]> {
  const out: IceServer[] = [{ urls: STUN_URLS.slice() }];
  const keyId = env.TURN_KEY_ID;
  const token = env.TURN_KEY_TOKEN;
  if (!keyId || !token) return out;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TURN_TIMEOUT_MS);
  try {
    const res = await fetchFn(TURN_API + encodeURIComponent(keyId) + '/credentials/generate-ice-servers', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.warn(`TURN credentials: ${res.status} ${(await res.text()).slice(0, 200)}`);
      return out;
    }
    const data = (await res.json()) as { iceServers?: unknown };
    // The API answers { iceServers: { urls: [...], username, credential } }; a list is accepted too.
    const list: unknown[] = Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers];
    for (const s of list) {
      const e = asIceServer(s);
      if (e) out.push(e);
    }
  } catch (e) {
    console.warn('TURN credentials failed', e);
  } finally {
    clearTimeout(timer);
  }
  return out;
}
