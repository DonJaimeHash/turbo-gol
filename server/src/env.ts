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

/** Parse a JSON body (<= 4 KB) or return null. */
export async function readJson<T>(request: Request): Promise<T | null> {
  const len = Number(request.headers.get('content-length') ?? '0');
  if (len > 4096) return null;
  try {
    const text = await request.text();
    if (text.length > 4096) return null;
    if (text.length === 0) return {} as T;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
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

export function isQueueKind(v: unknown): v is QueueKind {
  return v === 'p2p' || v === 'server' || v === 'ranked';
}

export function isModeList(v: unknown): v is GameModeId[] {
  return Array.isArray(v) && v.length >= 1 && v.length <= 3 && v.every(isMode) && new Set(v).size === v.length;
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
