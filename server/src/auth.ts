/**
 * HS256 JSON Web Tokens on WebCrypto (works in workerd and in node >= 20). Every token says what it
 * is in `typ` and every verify checks it, so one kind never passes as another:
 *
 *   session  { typ: 's', sub, name, iat, exp }                    24 h, Bearer for /api/*; an account's
 *            (accountRoutes.ts, 1 h) adds { acct: 1, car?, since?, tv?, aat? }
 *   ticket   { typ: 't', sub, mid, team, slot, role, name, iat, exp, jti }  90 s, one WebSocket upgrade;
 *            role 'player' -> /ws/<mid> (MatchDO, phase 1), role 'peer' -> /room/<mid> (RoomDO, phase 2)
 *   OAuth state (accountRoutes.ts) { typ: 'oa', p, v, n, ... }     10 min, the __Host-tg_oa cookie
 *
 * Tokens signed before `typ` existed have none: an untyped session (24 h at most) still verifies
 * as a session while it carries none of a ticket's claims, and an untyped ticket (90 s) as a
 * ticket, so a deploy signs nobody out. The internal Worker <-> Durable Object header is no HMAC
 * under the JWT key: it is a value of its own, HKDF-derived (internalSecret).
 *
 * Signatures are checked with crypto.subtle.verify (constant time inside the runtime); the
 * exported timingSafeEqual is for comparing the internal shared-secret header. Nothing here
 * touches storage: single use of a ticket's jti is enforced by the MatchDO / RoomDO.
 */
import { isCarId } from '../../src/game/cosmetics';
import type { CarId } from '../../src/game/cosmetics';
import { guestNameOf } from '../../src/net/guestName';

export const SESSION_TTL_SECONDS = 24 * 60 * 60;
export const TICKET_TTL_SECONDS = 90;

export interface SessionClaims {
  /** 's'; absent on a session signed before token types (verifySession tells it apart by shape). */
  typ?: 's';
  sub: string;
  name: string;
  iat: number;
  exp: number;
  /** 1 = a registered account (accountRoutes.ts, 1 h, refreshed from the cookie); absent = a guest. Only accounts may queue ranked. */
  acct?: 1;
  /**
   * An account's car (src/game/cosmetics.ts CarId): AccountsDO signs only one the account owns at
   * that moment, and never the default car (absent = the default). The matchmaker seats it from
   * here, never from a request body. Kept by verifySession only on an account session.
   */
  car?: CarId;
  /** An account's creation time (seconds): its age weighs its minutes on a community node (nodes/control-plane/ledger.ts). */
  since?: number;
  /**
   * 1 = a TV signed in with the phone (tvCodes.ts): a limited scope. It plays as the account but
   * never changes a credential, links or unlinks a provider, redeems points, confirms another TV,
   * lists or signs out devices, or reaches a maintainer route (accountRoutes.ts requirePrimary).
   * Kept only on an account's session.
   */
  tv?: 1;
  /**
   * When this device last proved a credential (seconds): its sign-in with a password or a
   * provider, or a re-authentication since. Linking, unlinking, a first password, new recovery
   * codes without a password and the maintainer routes need it recent (accountRoutes.ts
   * requireFresh). Absent = never (a TV, a session from before it existed). Kept only on an
   * account's session that is not a TV's.
   */
  aat?: number;
}

/** 'player': a seat in a MatchDO match (phase 1); 'peer': a seat in a RoomDO signaling room (phase 2); 'lobby': a custom lobby's socket (LobbyDO). */
export type TicketRole = 'player' | 'peer' | 'lobby';

export interface TicketClaims {
  /** 't'; absent on a ticket signed before token types (90 s: only around a deploy). */
  typ?: 't';
  sub: string;
  /** Match id or room id (Durable Object id as a hex string). */
  mid: string;
  team: 0 | 1;
  slot: number;
  role: TicketRole;
  name: string;
  iat: number;
  exp: number;
  jti: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const HEADER = base64urlEncode(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));

const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let p = keyCache.get(secret);
  if (!p) {
    p = crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    keyCache.set(secret, p);
  }
  return p;
}

export function base64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Constant-time byte comparison (length leaks, contents do not). */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  let s = '';
  for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
  return s;
}

export function nowSeconds(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000);
}

/** Sign an arbitrary claims object. The caller sets iat / exp. */
export async function signJwt(secret: string, claims: object): Promise<string> {
  const body = HEADER + '.' + base64urlEncode(enc.encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body));
  return body + '.' + base64urlEncode(new Uint8Array(sig));
}

/**
 * Verify signature, header and expiry; returns the claims or null. `nowSec` is injectable for
 * tests. Tokens without a numeric exp are rejected.
 */
export async function verifyJwt<T extends { exp: number }>(secret: string, token: string, nowSec: number = nowSeconds()): Promise<T | null> {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  if (parts[0] !== HEADER) {
    // Accept a differently serialised header only if it still says HS256 / JWT.
    const hb = base64urlDecode(parts[0]);
    if (!hb) return null;
    try {
      const h = JSON.parse(dec.decode(hb)) as { alg?: unknown; typ?: unknown };
      if (h.alg !== 'HS256' || (h.typ !== undefined && h.typ !== 'JWT')) return null;
    } catch {
      return null;
    }
  }
  const sig = base64urlDecode(parts[2]);
  if (!sig || sig.length !== 32) return null;
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), sig, enc.encode(parts[0] + '.' + parts[1]));
  if (!ok) return null;
  const pb = base64urlDecode(parts[1]);
  if (!pb) return null;
  let claims: T;
  try {
    claims = JSON.parse(dec.decode(pb)) as T;
  } catch {
    return null;
  }
  if (!claims || typeof claims !== 'object' || typeof claims.exp !== 'number' || !(claims.exp > nowSec)) return null;
  return claims;
}

// ---- Sessions ------------------------------------------------------------------------------

export async function createSession(secret: string, playerId: string, name: string, nowMs: number = Date.now()): Promise<{ token: string; expiresAt: number }> {
  const iat = nowSeconds(nowMs);
  const exp = iat + SESSION_TTL_SECONDS;
  const claims: SessionClaims = { typ: 's', sub: playerId, name, iat, exp };
  return { token: await signJwt(secret, claims), expiresAt: exp * 1000 };
}

/** A ticket's own claims: an untyped token that carries one is a ticket from before `typ`, never a session. */
const TICKET_ONLY = ['mid', 'jti', 'role', 'slot', 'team'] as const;

export async function verifySession(secret: string, token: string, nowMs: number = Date.now()): Promise<SessionClaims | null> {
  const c = await verifyJwt<SessionClaims>(secret, token, nowSeconds(nowMs));
  if (!c || typeof c.sub !== 'string' || !/^[0-9a-f]{16}$/.test(c.sub) || typeof c.name !== 'string') return null;
  if (c.typ !== 's') {
    // A ticket, an OAuth state or anything else typed is never a session. Untyped: a session
    // signed before the types (24 h at most), unless it carries a ticket's claims.
    if (c.typ !== undefined) return null;
    const raw = c as unknown as Record<string, unknown>;
    if (TICKET_ONLY.some((k) => k in raw)) return null;
  }
  // An account's claims only, and only a car the catalog knows (one retired later, or a guest
  // session that carries one, drives the default car): dropped, never a refused session.
  if (c.car !== undefined && !(c.acct === 1 && isCarId(c.car))) delete c.car;
  // A guest's name is the server's, from its id (src/net/guestName.ts): one a session from before
  // that rule carries (a name the guest chose) is replaced here, the one place every route reads.
  if (c.acct !== 1) c.name = guestNameOf(c.sub);
  if (c.since !== undefined && !(c.acct === 1 && typeof c.since === 'number' && Number.isFinite(c.since))) delete c.since;
  // The TV's scope belongs to an account's session; a fresh sign-in never to a TV's or a guest's.
  if (c.tv !== undefined && !(c.acct === 1 && c.tv === 1)) delete c.tv;
  if (c.aat !== undefined && !(c.acct === 1 && c.tv !== 1 && typeof c.aat === 'number' && Number.isFinite(c.aat))) delete c.aat;
  return c;
}

// ---- Match tickets -------------------------------------------------------------------------

export interface TicketInput {
  sub: string;
  mid: string;
  team: 0 | 1;
  slot: number;
  name: string;
  /** Default 'player'. */
  role?: TicketRole;
}

export async function createTicket(secret: string, t: TicketInput, nowMs: number = Date.now()): Promise<string> {
  const iat = nowSeconds(nowMs);
  const claims: TicketClaims = {
    typ: 't',
    sub: t.sub,
    mid: t.mid,
    team: t.team,
    slot: t.slot,
    role: t.role ?? 'player',
    name: t.name,
    iat,
    exp: iat + TICKET_TTL_SECONDS,
    jti: randomHex(16),
  };
  return signJwt(secret, claims);
}

/** Verify a ticket for `matchId` (a match or room id) and `role`; checks shape and expiry too. */
export async function verifyTicket(secret: string, token: string, matchId: string, nowMs: number = Date.now(), role: TicketRole = 'player'): Promise<TicketClaims | null> {
  const c = await verifyJwt<TicketClaims>(secret, token, nowSeconds(nowMs));
  if (!c) return null;
  if (c.typ !== undefined && c.typ !== 't') return null; // untyped: a ticket signed before the types (90 s)
  if (c.role !== role || c.mid !== matchId) return null;
  if (typeof c.sub !== 'string' || typeof c.jti !== 'string' || !/^[0-9a-f]{32}$/.test(c.jti)) return null;
  if ((c.team !== 0 && c.team !== 1) || !Number.isInteger(c.slot) || c.slot < 0 || c.slot > 7) return null;
  if (typeof c.name !== 'string') return null;
  return c;
}

// ---- Internal (Worker <-> Durable Object) shared secret ------------------------------------

export const INTERNAL_HEADER = 'x-internal-auth';
let internalCache: { secret: string; value: Promise<string> } | null = null;

/** HKDF-SHA256's salt and info for the internal header: a domain of its own, apart from the token signatures. */
const INTERNAL_SALT = 'turbogol/hkdf/v2';
const INTERNAL_INFO = 'internal-auth';

/**
 * Proves a request came from this deployment: 32 bytes of HKDF-SHA256(JWT_SECRET, INTERNAL_SALT,
 * INTERNAL_INFO) as hex. Derived apart from the key that signs the tokens (HMAC with the secret
 * itself), so no signature this code makes can ever equal it. It changes with JWT_SECRET; the
 * Worker and every Durable Object deploy together, so nothing holds the old value (v1, an HMAC of
 * a label under the token key) past a deploy.
 */
export function internalSecret(secret: string): Promise<string> {
  if (internalCache && internalCache.secret === secret) return internalCache.value;
  const value = (async () => {
    const ikm = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(INTERNAL_SALT), info: enc.encode(INTERNAL_INFO) }, ikm, 256);
    const b = new Uint8Array(bits);
    let s = '';
    for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return s;
  })();
  internalCache = { secret, value };
  return value;
}

export async function checkInternal(secret: string, request: Request): Promise<boolean> {
  const got = request.headers.get(INTERNAL_HEADER);
  if (!got) return false;
  const want = await internalSecret(secret);
  return timingSafeEqual(enc.encode(got), enc.encode(want));
}
