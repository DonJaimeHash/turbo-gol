/**
 * Worker routes for registered accounts (the guest flow stays in index.ts):
 *
 *   POST /api/auth/register   { username, password, turnstileToken? } -> RegisterAnswer + refresh cookie (the same
 *                             Turnstile gate as POST /api/guest when it is on)
 *   POST /api/auth/login      { username, password }            -> AccountSession + refresh cookie
 *   POST /api/auth/refresh    (refresh cookie)                  -> AccountSession (token rotated) | 401 (a copied token:
 *                             its whole family revoked) | 409 refresh_race (another tab rotated it: retry, cookie kept)
 *   POST /api/auth/logout     (refresh cookie)                  -> { ok } + cookie cleared (this device)
 *   GET  /api/auth/sessions   Bearer (account, not a TV) [cookie] -> SessionsAnswer: the signed-in devices
 *   POST /api/auth/sessions/revoke Bearer { id }                -> { revoked } (that device signed out)
 *   POST /api/auth/sessions/revoke-all Bearer                   -> { revoked } + cookie cleared (every device, this one too)
 *   POST /api/auth/recover    { username, code, password }      -> AccountSession + { codesLeft } + cookie
 *   POST /api/auth/password   Bearer { oldPassword, password }  -> { ok } (every other device signed out); an
 *                             account without a password (Google / Discord only) sets its first one with a
 *                             fresh session instead (403 reauth_required: PERFIL's "confirm it is you"), and
 *                             its other devices stay signed in
 *   POST /api/auth/recovery-codes Bearer { password }           -> { recoveryCodes }; without a password: a fresh session
 *     Neither from a TV's session (403 tv_session). A 1-hour Bearer alone (a leak, a TV, a script)
 *     no longer turns into a permanent username-and-password way in.
 *   POST /api/me/username     Bearer { username, password?, newPassword? } -> AccountSession (new name in the token);
 *                             a password account sends its key for the OLD name (checked) and for the NEW
 *                             name (stored): the client key is salted with the username
 *   GET  /api/me              Bearer (account)                  -> MeInfo
 *   POST /api/me/training     Bearer (account) { records }      -> { records }: the training records of
 *                             src/game/trainingRecords.ts merged into the account (best per pack, the
 *                             client's rule) and returned; invalid entries are dropped, 20 a minute
 *   GET  /api/me/experimental Bearer (account)                  -> ExperimentalAnswer { enabled, presets }
 *   POST /api/me/experimental Bearer (account) { enabled }      -> ExperimentalAnswer (Settings > Experimental's switch)
 *   POST /api/me/presets      Bearer (account) { preset }       -> ExperimentalAnswer | 400 bad_preset | 409 too_many
 *   POST /api/me/presets/delete Bearer (account) { id }         -> ExperimentalAnswer: the physics presets of
 *                             src/game/physicsRules.ts, MAX_PRESETS per account, one per request (a whole
 *                             list would overrun the 4 KB body), last write wins (the server's updatedAt);
 *                             30 writes and 60 reads a minute per account; a guest gets 403 account_required
 *   GET  /api/me/items        Bearer (account)                  -> ItemsAnswer { items, car, cars } (src/net/cosmetics.ts)
 *   POST /api/me/car          Bearer (account) { car }          -> AccountSession with that car (the default
 *                             car, or one the account owns: 409 not_owned; 400 bad_car): its next seats drive it
 *   GET  /api/me/shop         Bearer (account)                  -> ShopAnswer { items, wallet }: the hosts' shop
 *   POST /api/me/shop/claim   Bearer (account) { item }         -> ClaimAnswer { item, claimed, wallet, items } |
 *                             404 unknown_item | 409 not_available / frozen / insufficient / requires_matches;
 *                             items and shop: 60 reads, car and claim 30 writes a minute per account; a guest
 *                             gets 403 account_required (GET /nodes/shop and POST /nodes/shop/claim: the same)
 *   GET  /api/leaderboard?playlist=1v1  [Bearer]                -> LeaderboardAnswer (cached 30 s per playlist)
 *   GET  /api/ranked/result?matchId=    Bearer (account)        -> RankedResultAnswer
 *   GET  /api/auth/oauth/:provider/start[?link=1 | ?reauth=1]   -> 302 to Google / Discord (state + PKCE)
 *   GET  /api/auth/oauth/:provider/callback?code&state          -> 302 to /#auth=ok | new | linked | reauth | error:<code>
 *     link=1 (PERFIL's VINCULAR) needs this browser's refresh cookie, not a TV's, and a credential
 *     proved on it in the last REAUTH_WINDOW_S (a sign-in, or reauth=1 just before); otherwise the
 *     start answers /#auth=error:reauth_required (or link_expired without a valid cookie) and never
 *     turns into a sign-up. A link never replaces the account's own id of that provider (409
 *     provider_set: POST /api/auth/unlink first). reauth=1 signs in again with a provider already
 *     on the account (another identity: /#auth=error:reauth_mismatch, nothing signed in or made)
 *     and moves this browser's credential proof to now. Either way this browser's old token goes
 *     and the callback's new one takes its place.
 *   POST /api/auth/reauth     Bearer { password } (refresh cookie) -> AccountSession: the password re-proved, the
 *                             cookie's credential proof now (a password account's re-authentication)
 *   POST /api/auth/unlink     Bearer (fresh) { provider }       -> { ok } | 409 last_method (the only way in left) |
 *                             404 not_linked | 403 reauth_required
 *   POST /api/auth/tv/start   { turnstileToken? } (no session)  -> TvStartAnswer: a TV signing in with the phone (the
 *                             Turnstile gate as POST /api/guest; 503 busy when its network holds too many codes)
 *   POST /api/auth/tv/info    Bearer (account) { code }         -> TvInfoAnswer: where that TV is (request.cf at its
 *                             start), on the phone's network or in its country; the refusals of confirm (and
 *                             counted with them). The phone shows it before CONFIRMAR, the code always typed
 *   POST /api/auth/tv/confirm Bearer (account) { code }         -> { ok } | 404 tv_code_wrong | 410 tv_code_expired
 *                             | 409 tv_code_used | 429 throttled | 403 banned: the phone binds the code to its
 *                             account, once
 *   POST /api/auth/tv/poll    { code, secret }                  -> { state: 'pending' } | AccountSession & { state:
 *                             'approved', tv: true } + refresh cookie | 410 (a wrong secret too) | 409 | 403 banned
 *     A TV's session has a limited scope (the refresh row's kind 'tv', the Bearer's tv claim, kept
 *     through every refresh, 30 days from its start at most): it plays as the account, picks its
 *     car, its settings and presets, but every route that changes a credential or the account's
 *     ways in (password, recovery codes, rename, linking, unlinking), redeems points, approves a
 *     TV, lists or signs out devices, or is a maintainer's (nodeRoutes.ts) answers it 403
 *     tv_session (requirePrimary).
 *     The device-code pattern (tvCodes.ts in the AccountsDO): the code is 6 of the lobby alphabet and
 *     lives 5 minutes; the secret (32 random bytes) goes only to the TV and only its SHA-256 to the
 *     object, compared in constant time; an approved poll wipes the binding (one use). Limits: start
 *     10 a minute per IP (and 5 live codes per IP), poll 60, confirm 30 a minute per IP plus 10
 *     failed confirms (wrong, expired or used codes) per account and 50 per IP in 15 minutes; an
 *     IPv6 address counts by its /64 (tvCodes.ts ipKey).
 *
 * Every POST /api/auth/* (every route that sets, rotates, clears or uses the refresh cookie, or
 * changes a credential) is refused unless it comes from one of the game's own pages: an Origin
 * header that is this origin (or PUBLIC_ORIGIN, or VITE_ORIGINS; a loopback page under wrangler
 * dev), never missing or "null" (403 bad_origin), and, for a route that reads a body,
 * Content-Type application/json (415 json_required): a cross-site <form> can send neither, so a
 * login CSRF (a text/plain form signing the browser into another account) cannot happen.
 *
 * `password` is always the client key (src/net/account.ts clientPasswordKey: PBKDF2 in the browser),
 * never the typed password. The server stores PBKDF2-SHA256(clientKey, random salt, 100,000) — the
 * Workers WebCrypto iteration ceiling — so hashing happens here, in parallel isolates, and the single
 * AccountsDO only stores and compares rows.
 *
 * Tokens: an account session is the same HS256 session as a guest's (index.ts bearerSession) with
 * `acct: 1` and a 1 h life, the car the account drives (`car`, only when it is not the default one:
 * AccountsDO hands the session only a car the account still owns) and when it was created
 * (`since`, seconds: its rewards weight on a community node); the refresh token (32 random bytes, stored as SHA-256) travels only in
 * the `__Host-tg_rt` cookie (HttpOnly, Secure, SameSite=Strict, Path=/, 30 days sliding, rotated on
 * every refresh). SameSite=Strict plus the Origin check below keep other sites from using it.
 * OAuth: the state cookie `__Host-tg_oa` (SameSite=Lax: it must survive the provider's redirect back)
 * holds a signed JWT with the PKCE verifier, the state nonce and the account to link, 10 minutes.
 * Providers are enabled by their secrets (GOOGLE_CLIENT_ID / _SECRET, DISCORD_CLIENT_ID / _SECRET);
 * GET /api/config lists the enabled ones. Redirect URI = <origin>/api/auth/oauth/<provider>/callback,
 * origin = PUBLIC_ORIGIN when set, else the request's own.
 */
import type { Env } from './env';
import { EXPERIMENTAL_REFUSED, carriesPhysics, error, json, readJson } from './env';
import { base64urlEncode, internalSecret, INTERNAL_HEADER, nowSeconds, signJwt, verifyJwt } from './auth';
import type { SessionClaims } from './auth';
import { isClientKey, isPlaylist, OAUTH_PROVIDERS, usernameProblem } from '../../src/net/account';
import type { AccountSession, LeaderboardAnswer, OAuthProvider, RegisterAnswer, TvInfoAnswer, TvPollAnswer, TvStartAnswer } from '../../src/net/account';
import type { Credentials, PasswordRecord, RefreshGrant, UserRef } from './accountStore';
import { TV_POLL_MS, ipKey, tvCode } from './tvCodes';
import { PRESET_ID_RE, parseStoredPreset } from '../../src/game/physicsRules';
import { DEFAULT_CAR, isCarId } from '../../src/game/cosmetics';
import { ITEM_ID_RE } from '../../nodes/control-plane/shop';

export const ACCOUNT_SESSION_TTL_SECONDS = 60 * 60;
/**
 * How recent a device's credential proof must be (its sign-in, or a re-authentication) to change
 * the account's ways in: link or unlink a provider, set a first password, new recovery codes for an
 * account without one.
 */
export const REAUTH_WINDOW_S = 10 * 60;
export const SERVER_KDF_ITERATIONS = 100_000;
export const REFRESH_COOKIE = '__Host-tg_rt';
const OAUTH_COOKIE = '__Host-tg_oa';
const REFRESH_MAX_AGE_S = 30 * 24 * 60 * 60;
const OAUTH_TTL_S = 600;
const RECOVERY_CODES = 8;
/** Crockford base32 without I L O U: unambiguous when typed from a screenshot. */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const enc = new TextEncoder();

// ---- crypto helpers -----------------------------------------------------------------------------

function hex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return s;
}

function fromHex(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export async function sha256Hex(s: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))));
}

/** PBKDF2-SHA256 of the client key (hex) with `saltHex`: the stored password hash. */
export async function serverHash(clientKey: string, saltHex: string, iter: number = SERVER_KDF_ITERATIONS): Promise<string> {
  const key = await crypto.subtle.importKey('raw', fromHex(clientKey), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex), iterations: iter }, key, 256);
  return hex(new Uint8Array(bits));
}

export async function newPasswordRecord(clientKey: string): Promise<PasswordRecord> {
  const salt = hex(randomBytes(16));
  return { hash: await serverHash(clientKey, salt), salt, iter: SERVER_KDF_ITERATIONS };
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function verifyPassword(clientKey: string, c: Pick<Credentials, 'hash' | 'salt' | 'iter'>): Promise<boolean> {
  if (!c.hash || !c.salt || !c.iter) return false;
  return constantTimeEqualHex(await serverHash(clientKey, c.salt, c.iter), c.hash);
}

/** 'XXXX-XXXX' (40 bits each). */
export function newRecoveryCode(): string {
  const b = randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[b[i] & 31];
  return s.slice(0, 4) + '-' + s.slice(4);
}

/** What a recovery code is stored as: SHA-256 of its canonical form (upper case, no separators, O->0, I/L->1). */
export function recoveryCodeHash(code: string): Promise<string> {
  const canon = code.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return sha256Hex('turbogol-recovery:' + canon);
}

/**
 * A refresh token: "<family part>.<secret>" (16 and 32 random bytes, base64url). Every token rotated
 * from one sign-in keeps its family part, so a copy presented after the rotation names the family
 * it belongs to (familyOf) and AccountsDO revokes the family. A token from before families is the
 * secret alone; it rotates into a family of its own.
 */
function newRefreshToken(familyPart?: string): string {
  return (familyPart ?? base64urlEncode(randomBytes(16))) + '.' + base64urlEncode(randomBytes(32));
}

/** A token's family part, or null for a token from before families. */
function familyPartOf(token: string): string | null {
  const i = token.indexOf('.');
  return i > 0 && /^[A-Za-z0-9_-]{16,32}$/.test(token.slice(0, i)) ? token.slice(0, i) : null;
}

/** The family a token names, as AccountsDO stores it (32 hex: never the family part itself). */
async function familyOf(token: string): Promise<string | null> {
  const part = familyPartOf(token);
  return part === null ? null : (await sha256Hex('turbogol-family:' + part)).slice(0, 32);
}

/** Where a request comes from, coarsely (request.cf): the device list shows it. */
function geoOf(request: Request): { country: string | null; city: string | null } {
  const cf = request.cf;
  const country = cf && typeof cf.country === 'string' && /^[A-Z]{2}$/.test(cf.country) ? cf.country : null;
  const city = cf && typeof cf.city === 'string' && cf.city.length > 0 ? cf.city.slice(0, 64) : null;
  return { country, city };
}

/** Where a request comes from with its network (request.cf): what the phone sees of a TV before it confirms. */
function whereOfRequest(request: Request): { country: string | null; city: string | null; asn: number | null; org: string | null } {
  const cf = request.cf;
  return {
    ...geoOf(request),
    asn: cf && typeof cf.asn === 'number' && Number.isInteger(cf.asn) ? cf.asn : null,
    org: cf && typeof cf.asOrganization === 'string' && cf.asOrganization.length > 0 ? cf.asOrganization.slice(0, 64) : null,
  };
}

/** What AccountsDO stores of a new refresh token (accountStore.ts RefreshGrant): never the token. */
async function grantFor(token: string, request: Request): Promise<RefreshGrant> {
  return { hash: await sha256Hex(token), family: await familyOf(token), ...geoOf(request) };
}

// ---- cookies -----------------------------------------------------------------------------------

export function cookieOf(request: Request, name: string): string | null {
  const raw = request.headers.get('Cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function refreshCookie(token: string): string {
  return `${REFRESH_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${REFRESH_MAX_AGE_S}`;
}

function clearCookie(name: string, sameSite: 'Strict' | 'Lax' = 'Strict'): string {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=0`;
}

function withCookies(res: Response, cookies: readonly string[]): Response {
  const out = new Response(res.body, res);
  for (const c of cookies) out.headers.append('Set-Cookie', c);
  out.headers.set('cache-control', 'no-store');
  return out;
}

// ---- AccountsDO access --------------------------------------------------------------------------

function accounts(env: Env): DurableObjectStub {
  return env.ACCOUNTS.get(env.ACCOUNTS.idFromName('accounts-v1'));
}

export async function accountsCall(env: Env, path: string, payload?: unknown): Promise<Response> {
  const headers: Record<string, string> = { [INTERNAL_HEADER]: await internalSecret(env.JWT_SECRET) };
  if (payload === undefined) return accounts(env).fetch('https://accounts' + path, { headers });
  headers['content-type'] = 'application/json';
  return accounts(env).fetch('https://accounts' + path, { method: 'POST', headers, body: JSON.stringify(payload) });
}

async function accountsJson<T>(env: Env, path: string, payload?: unknown): Promise<{ ok: true; data: T } | { ok: false; res: Response }> {
  const res = await accountsCall(env, path, payload);
  if (!res.ok) return { ok: false, res };
  return { ok: true, data: (await res.json()) as T };
}

function pass(res: Response): Response {
  return new Response(res.body, res);
}

// ---- sessions -----------------------------------------------------------------------------------

/**
 * `capExp` (seconds): the session never outlives it. A route that re-signs from the Bearer alone
 * (POST /api/me/car) passes the Bearer's own exp, so only a sign-in or the refresh cookie (both
 * refuse a banned account, and a password change or logout drops the cookies) ever extends one.
 */
export async function accountSession(env: Env, u: UserRef, nowMs: number = Date.now(), capExp?: number): Promise<AccountSession> {
  const iat = nowSeconds(nowMs);
  const exp = Math.min(iat + ACCOUNT_SESSION_TTL_SECONDS, capExp ?? Infinity);
  const car = u.car ?? DEFAULT_CAR;
  const claims: SessionClaims = { typ: 's', sub: u.userId, name: u.username, iat, exp, acct: 1 };
  // Absent = the default car on every path (the seats, the rosters): the token carries only another one.
  if (car !== DEFAULT_CAR) claims.car = car;
  if (typeof u.createdAt === 'number' && u.createdAt > 0) claims.since = nowSeconds(u.createdAt);
  // The device's scope (accountStore.ts refresh kind and auth_at): a TV's, or when it last proved a credential.
  if (u.tv === true) claims.tv = 1;
  else if (typeof u.authAt === 'number' && u.authAt > 0) claims.aat = nowSeconds(u.authAt);
  const out: AccountSession = { kind: 'account', playerId: u.userId, name: u.username, session: await signJwt(env.JWT_SECRET, claims), expiresAt: exp * 1000, car };
  if (claims.tv === 1) out.tv = true;
  if (claims.aat !== undefined) out.authAt = claims.aat * 1000;
  return out;
}

/** The scope a Bearer carries, for a route that re-signs it (a car, a rename): never widened, never dropped. */
function scopeOf(s: SessionClaims): Pick<UserRef, 'tv' | 'authAt'> {
  return s.tv === 1 ? { tv: true } : s.aat !== undefined ? { authAt: s.aat * 1000 } : {};
}

/** A cookie-carrying POST from a page of another origin is refused (SameSite=Strict already blocks most). */
function sameOriginOk(request: Request, allowed: (origin: string) => boolean): boolean {
  const origin = request.headers.get('Origin');
  return origin === null || allowed(origin);
}

/** A loopback host (wrangler dev, the Vite dev server). */
function isLoopback(origin: string): boolean {
  try {
    const h = new URL(origin).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost');
  } catch {
    return false;
  }
}

/**
 * An origin the game's own pages are served from: this request's, PUBLIC_ORIGIN, the VITE_ORIGINS
 * list (index.ts originAllowed: production's), or, under wrangler dev, a loopback page (Vite on
 * another port). With VITE_ORIGINS empty, no other origin passes here (originAllowed lets any).
 */
function ownOrigin(c: Pick<RouteContext, 'env' | 'request' | 'originAllowed'>, origin: string): boolean {
  const self = new URL(c.request.url).origin;
  if (origin === self) return true;
  if (c.env.PUBLIC_ORIGIN && origin === c.env.PUBLIC_ORIGIN.replace(/\/$/, '')) return true;
  const listed = (c.env.VITE_ORIGINS ?? '').split(',').some((s) => s.trim().length > 0);
  return listed ? c.originAllowed(origin) : isLoopback(self) && isLoopback(origin);
}

/** The POST /api/auth/* routes that read no body (the console line of nodes/docs/VPS-SAO-PAULO.md refreshes with none). */
const BODYLESS = new Set(['/api/auth/refresh', '/api/auth/logout', '/api/auth/sessions/revoke-all']);

/** The login-CSRF gate of every POST /api/auth/*: null = from one of the game's pages, else the refusal (the header). */
function crossSiteRefusal(c: RouteContext, path: string): Response | null {
  const origin = c.request.headers.get('Origin');
  if (origin === null || origin === 'null' || !ownOrigin(c, origin)) return error(403, 'bad_origin', 'Esta petición no viene de la página del juego');
  if (BODYLESS.has(path)) return null;
  const type = (c.request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  return type === 'application/json' ? null : error(415, 'json_required', 'Se espera JSON');
}

function ipOf(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'local';
}

// ---- handlers -----------------------------------------------------------------------------------

export interface RouteContext {
  env: Env;
  request: Request;
  /** The verified Bearer session (guest or account), null without one. */
  session: SessionClaims | null;
  originAllowed: (origin: string) => boolean;
  /** Worker rate limiter: true = over the limit. */
  limited: (key: string, max: number) => boolean;
  /** The Turnstile gate (index.ts): null = pass, else the refusal. Guards account creation like guest creation. */
  antiBot: (token: unknown) => Promise<Response | null>;
}

async function register(c: RouteContext): Promise<Response> {
  if (c.limited('reg:' + ipOf(c.request), 5)) return error(429, 'rate_limited', 'Demasiados registros desde tu red, inténtalo más tarde');
  const b = await readJson<{ username?: unknown; password?: unknown; turnstileToken?: unknown }>(c.request);
  if (!b) return error(400, 'bad_request');
  const blocked = await c.antiBot(b.turnstileToken);
  if (blocked !== null) return blocked;
  const problem = usernameProblem(b.username);
  if (problem !== null) return error(400, 'bad_username', problem);
  if (!isClientKey(b.password)) return error(400, 'bad_password', 'Contraseña inválida');
  const codes = Array.from({ length: RECOVERY_CODES }, newRecoveryCode);
  const refresh = newRefreshToken();
  const r = await accountsJson<UserRef>(c.env, '/register', {
    username: b.username,
    pw: await newPasswordRecord(b.password),
    recovery: await Promise.all(codes.map(recoveryCodeHash)),
    refresh: await grantFor(refresh, c.request),
  });
  if (!r.ok) return pass(r.res);
  const out: RegisterAnswer = { ...(await accountSession(c.env, r.data)), recoveryCodes: codes };
  return withCookies(json(out), [refreshCookie(refresh)]);
}

/**
 * A username under attack (AccountsDO auth-begin's `slow`: many failures on it from anywhere) is
 * slowed down, never locked: each sign-in on it needs a solved Turnstile check. Null = go on; else
 * the refusal (403 turnstile_required asks the client for one). Where the gate is off (local dev,
 * TURNSTILE_DISABLED) nothing can be asked, and the per-network counters are what remains.
 */
async function slowDown(c: RouteContext, slow: boolean | undefined, token: unknown): Promise<Response | null> {
  if (slow !== true) return null;
  if (token === undefined) return (await c.antiBot(undefined)) === null ? null : error(403, 'turnstile_required', 'Confirma que no eres un robot para seguir');
  return c.antiBot(token);
}

/**
 * Look the user up and check the password; a missing user, or one without a password, still costs
 * one hash (no timing oracle) and gets the same answer (bad_credentials: nothing tells an OAuth-only
 * account apart). `human`: a sign-in's Turnstile token (the slow-down of a username under attack);
 * absent for a check behind a Bearer (a password change, a re-authentication), which has none.
 */
async function checkCredentials(c: RouteContext, username: string, clientKey: string, human?: { token: unknown }): Promise<{ ok: true; cred: Credentials } | { ok: false; res: Response }> {
  const begin = await accountsJson<{ found: boolean; slow?: boolean } & Partial<Credentials>>(c.env, '/auth-begin', { username, ip: ipOf(c.request) });
  if (!begin.ok) return { ok: false, res: pass(begin.res) };
  const d = begin.data;
  if (human !== undefined) {
    const blocked = await slowDown(c, d.slow, human.token);
    if (blocked !== null) return { ok: false, res: blocked };
  }
  const refused = { ok: false as const, res: error(401, 'bad_credentials', 'Usuario o contraseña incorrectos') };
  if (!d.found) {
    await serverHash(clientKey, '00'.repeat(16));
    await accountsCall(c.env, '/auth-finish', { username, ip: ipOf(c.request), ok: false });
    return refused;
  }
  const cred = d as Credentials;
  if (!cred.hash) await serverHash(clientKey, '00'.repeat(16)); // the same time as a wrong password's
  const good = await verifyPassword(clientKey, cred);
  if (!good) {
    await accountsCall(c.env, '/auth-finish', { username, ip: ipOf(c.request), ok: false });
    return refused;
  }
  if (cred.banned) return { ok: false, res: error(403, 'banned', 'Cuenta suspendida') };
  return { ok: true, cred };
}

async function login(c: RouteContext): Promise<Response> {
  if (c.limited('login:' + ipOf(c.request), 30)) return error(429, 'rate_limited');
  const b = await readJson<{ username?: unknown; password?: unknown; turnstileToken?: unknown }>(c.request);
  if (!b || typeof b.username !== 'string' || b.username.length > 64 || !isClientKey(b.password)) return error(400, 'bad_request');
  const chk = await checkCredentials(c, b.username, b.password, { token: b.turnstileToken });
  if (!chk.ok) return chk.res;
  const refresh = newRefreshToken();
  const fin = await accountsJson<UserRef>(c.env, '/auth-finish', { userId: chk.cred.userId, username: b.username, ip: ipOf(c.request), ok: true, refresh: await grantFor(refresh, c.request) });
  if (!fin.ok) return pass(fin.res);
  return withCookies(json(await accountSession(c.env, fin.data)), [refreshCookie(refresh)]);
}

async function refresh(c: RouteContext): Promise<Response> {
  if (!sameOriginOk(c.request, c.originAllowed)) return error(403, 'bad_origin');
  if (c.limited('refresh:' + ipOf(c.request), 60)) return error(429, 'rate_limited');
  const token = cookieOf(c.request, REFRESH_COOKIE);
  if (!token || token.length > 128) return withCookies(error(401, 'no_refresh'), []);
  // The next token keeps this one's family part: a copy of either names the same family.
  const next = newRefreshToken(familyPartOf(token) ?? undefined);
  const r = await accountsJson<UserRef>(c.env, '/refresh', { old: await sha256Hex(token), oldFamily: await familyOf(token), next: await grantFor(next, c.request) });
  // Another tab rotated this very token a moment ago: its cookie is already the new one, keep it.
  if (!r.ok && r.res.status === 409) return withCookies(pass(r.res), []);
  if (!r.ok) return withCookies(pass(r.res), [clearCookie(REFRESH_COOKIE)]);
  return withCookies(json(await accountSession(c.env, r.data)), [refreshCookie(next)]);
}

async function logout(c: RouteContext): Promise<Response> {
  if (!sameOriginOk(c.request, c.originAllowed)) return error(403, 'bad_origin');
  const token = cookieOf(c.request, REFRESH_COOKIE);
  if (token && token.length <= 128) await accountsCall(c.env, '/logout', { hash: await sha256Hex(token) });
  return withCookies(json({ ok: true }), [clearCookie(REFRESH_COOKIE)]);
}

async function recover(c: RouteContext): Promise<Response> {
  if (c.limited('recover:' + ipOf(c.request), 10)) return error(429, 'rate_limited');
  const b = await readJson<{ username?: unknown; code?: unknown; password?: unknown; turnstileToken?: unknown }>(c.request);
  if (!b || typeof b.username !== 'string' || b.username.length > 64 || typeof b.code !== 'string' || b.code.length > 32 || !isClientKey(b.password)) return error(400, 'bad_request');
  // The same counters and slow-down as a sign-in's (AccountsDO /recover throttles the pair again).
  const begin = await accountsJson<{ slow?: boolean }>(c.env, '/auth-begin', { username: b.username, ip: ipOf(c.request) });
  if (!begin.ok) return pass(begin.res);
  const blocked = await slowDown(c, begin.data.slow, b.turnstileToken);
  if (blocked !== null) return blocked;
  const refreshTok = newRefreshToken();
  const r = await accountsJson<UserRef & { codesLeft: number }>(c.env, '/recover', {
    username: b.username,
    code: await recoveryCodeHash(b.code),
    pw: await newPasswordRecord(b.password),
    refresh: await grantFor(refreshTok, c.request),
    ip: ipOf(c.request),
  });
  if (!r.ok) return pass(r.res);
  return withCookies(json({ ...(await accountSession(c.env, r.data)), codesLeft: r.data.codesLeft }), [refreshCookie(refreshTok)]);
}

/** The session, when it is an account's: 401 without a session, 403 for a guest. Also the /nodes/* operator routes (nodeRoutes.ts). */
export function requireAccount(c: Pick<RouteContext, 'session'>): SessionClaims | Response {
  if (!c.session) return error(401, 'unauthorized');
  if (c.session.acct !== 1) return error(403, 'account_required', 'Necesitas una cuenta (no de invitado)');
  return c.session;
}

/**
 * An account's session, not a TV's, whose device proved a credential (a sign-in or a
 * re-authentication: the aat claim) within `windowS`: otherwise 403 reauth_required, and PERFIL
 * asks the player to confirm it is them first.
 */
export function requireFresh(c: Pick<RouteContext, 'session'>, windowS: number = REAUTH_WINDOW_S, nowS: number = nowSeconds()): SessionClaims | Response {
  const s = requirePrimary(c);
  if (s instanceof Response) return s;
  if (typeof s.aat !== 'number' || nowS - s.aat > windowS || s.aat > nowS + 60) return error(403, 'reauth_required', 'Confirma que eres tú: vuelve a entrar con tu cuenta');
  return s;
}

/**
 * An account's session that is not a TV's (requireAccount, then 403 tv_session for the limited
 * scope of a TV signed in with the phone): every route that changes a credential or a way in,
 * redeems, approves a TV, handles devices, or is a maintainer's.
 */
export function requirePrimary(c: Pick<RouteContext, 'session'>): SessionClaims | Response {
  const s = requireAccount(c);
  if (s instanceof Response) return s;
  if (s.tv === 1) return error(403, 'tv_session', 'Una TV con la sesión del teléfono no puede hacer eso: hazlo en tu teléfono');
  return s;
}

async function changePassword(c: RouteContext): Promise<Response> {
  const s = requirePrimary(c);
  if (s instanceof Response) return s;
  const b = await readJson<{ oldPassword?: unknown; password?: unknown }>(c.request);
  if (!b || !isClientKey(b.password)) return error(400, 'bad_request');
  const me = await accountsJson<{ name: string; hasPassword: boolean }>(c.env, '/me?userId=' + s.sub);
  if (!me.ok) return pass(me.res);
  if (me.data.hasPassword) {
    if (!isClientKey(b.oldPassword)) return error(400, 'bad_request');
    const chk = await checkCredentials(c, me.data.name, b.oldPassword);
    if (!chk.ok) return chk.res;
  } else {
    // A first password is a new way in: only a device that just proved the account's provider adds it.
    const f = requireFresh(c);
    if (f instanceof Response) return f;
  }
  const token = cookieOf(c.request, REFRESH_COOKIE);
  // A change signs the other devices out (the old password may have leaked); a first password does not.
  const r = await accountsCall(c.env, '/password', { userId: s.sub, pw: await newPasswordRecord(b.password), keep: token ? await sha256Hex(token) : undefined, signOutOthers: me.data.hasPassword });
  return r.ok ? json({ ok: true }) : pass(r);
}

async function newRecoveryCodes(c: RouteContext): Promise<Response> {
  const s = requirePrimary(c);
  if (s instanceof Response) return s;
  const b = await readJson<{ password?: unknown }>(c.request);
  const me = await accountsJson<{ name: string; hasPassword: boolean }>(c.env, '/me?userId=' + s.sub);
  if (!me.ok) return pass(me.res);
  if (me.data.hasPassword) {
    if (!b || !isClientKey(b.password)) return error(400, 'bad_request');
    const chk = await checkCredentials(c, me.data.name, b.password);
    if (!chk.ok) return chk.res;
  } else {
    // Without a password, the codes would be the way to make one: a fresh session only.
    const f = requireFresh(c);
    if (f instanceof Response) return f;
  }
  const codes = Array.from({ length: RECOVERY_CODES }, newRecoveryCode);
  const r = await accountsCall(c.env, '/recovery', { userId: s.sub, hashes: await Promise.all(codes.map(recoveryCodeHash)) });
  return r.ok ? json({ recoveryCodes: codes }) : pass(r);
}

async function rename(c: RouteContext): Promise<Response> {
  const s = requirePrimary(c);
  if (s instanceof Response) return s;
  if (c.limited('rename:' + s.sub, 5)) return error(429, 'rate_limited');
  const b = await readJson<{ username?: unknown; password?: unknown; newPassword?: unknown }>(c.request);
  const problem = usernameProblem(b?.username);
  if (problem !== null) return error(400, 'bad_username', problem);
  const me = await accountsJson<{ name: string; hasPassword: boolean }>(c.env, '/me?userId=' + s.sub);
  if (!me.ok) return pass(me.res);
  let pw: PasswordRecord | null = null;
  if (me.data.hasPassword) {
    // The stored hash is of clientKey(oldName, password): check it, and store the new name's key.
    if (!isClientKey(b?.password) || !isClientKey(b?.newPassword)) return error(400, 'password_required', 'Ingresa tu contraseña para cambiar el nombre');
    const chk = await checkCredentials(c, me.data.name, b.password);
    if (!chk.ok) return chk.res;
    pw = await newPasswordRecord(b.newPassword);
  }
  const r = await accountsJson<UserRef>(c.env, '/rename', { userId: s.sub, username: b?.username });
  if (!r.ok) return pass(r.res);
  if (pw !== null) {
    const token = cookieOf(c.request, REFRESH_COOKIE);
    await accountsCall(c.env, '/password', { userId: s.sub, pw, keep: token ? await sha256Hex(token) : undefined });
  }
  return json(await accountSession(c.env, { ...r.data, ...scopeOf(s) }));
}

// ---- signed-in devices ------------------------------------------------------------------------------

const LIMIT_SESSIONS_PER_ACCOUNT = 30;

/** GET /api/auth/sessions: the account's devices (accountStore.ts devices), this one marked. */
async function sessionsList(c: RouteContext): Promise<Response> {
  const s = requirePrimary(c);
  if (s instanceof Response) return s;
  if (c.limited('ses:' + s.sub, LIMIT_SESSIONS_PER_ACCOUNT)) return error(429, 'rate_limited');
  const token = cookieOf(c.request, REFRESH_COOKIE);
  const current = token && token.length <= 128 ? await sha256Hex(token) : undefined;
  return noStore(await accountsCall(c.env, '/sessions', { userId: s.sub, current }));
}

/** POST /api/auth/sessions/revoke { id }: one device signed out (this one too, when it is its id: the cookie goes). */
async function sessionRevoke(c: RouteContext): Promise<Response> {
  const s = requirePrimary(c);
  if (s instanceof Response) return s;
  if (c.limited('ses:' + s.sub, LIMIT_SESSIONS_PER_ACCOUNT)) return error(429, 'rate_limited');
  const b = await readJson<{ id?: unknown }>(c.request);
  if (!b || typeof b.id !== 'string' || !/^[0-9a-f]{32}$/.test(b.id)) return error(400, 'bad_request');
  return noStore(await accountsCall(c.env, '/sessions/revoke', { userId: s.sub, id: b.id }));
}

/**
 * POST /api/auth/sessions/revoke-all: PERFIL's sign out on every device, an OAuth-only account's
 * too. This device included (its cookie cleared): a thief holding one device gains nothing by it.
 */
async function sessionsRevokeAll(c: RouteContext): Promise<Response> {
  const s = requirePrimary(c);
  if (s instanceof Response) return s;
  if (c.limited('ses:' + s.sub, LIMIT_SESSIONS_PER_ACCOUNT)) return error(429, 'rate_limited');
  const r = await accountsCall(c.env, '/sessions/revoke-all', { userId: s.sub });
  return r.ok ? withCookies(pass(r), [clearCookie(REFRESH_COOKIE)]) : pass(r);
}

const LIMIT_TRAINING_PER_ACCOUNT = 20;

async function training(c: RouteContext): Promise<Response> {
  const s = requireAccount(c);
  if (s instanceof Response) return s;
  if (c.limited('tr:' + s.sub, LIMIT_TRAINING_PER_ACCOUNT)) return error(429, 'rate_limited');
  const b = await readJson<{ records?: unknown }>(c.request);
  if (!b || typeof b.records !== 'object' || b.records === null || Array.isArray(b.records)) return error(400, 'bad_request');
  // Records come from the standard training packs only: never from a run with experimental rules.
  if (carriesPhysics(b)) return error(400, EXPERIMENTAL_REFUSED, 'experimental rules record nothing');
  const r = await accountsCall(c.env, '/training', { userId: s.sub, records: b.records });
  const out = pass(r);
  out.headers.set('cache-control', 'no-store');
  return out;
}

/** Experimental writes (the switch, a preset saved or deleted) per account and minute; reads have their own budget. */
export const LIMIT_EXPERIMENTAL_WRITES = 30;
export const LIMIT_EXPERIMENTAL_READS = 60;

function noStore(res: Response): Response {
  const out = pass(res);
  out.headers.set('cache-control', 'no-store');
  return out;
}

/** GET /api/me/experimental: the switch and the presets (src/game/experimentalStore.ts syncs with it). */
async function experimentalGet(c: RouteContext): Promise<Response> {
  const s = requireAccount(c);
  if (s instanceof Response) return s;
  if (c.limited('xpr:' + s.sub, LIMIT_EXPERIMENTAL_READS)) return error(429, 'rate_limited');
  return noStore(await accountsCall(c.env, '/experimental?userId=' + encodeURIComponent(s.sub)));
}

/** POST /api/me/experimental { enabled }: Settings > Experimental's switch. */
async function experimentalSet(c: RouteContext): Promise<Response> {
  const s = requireAccount(c);
  if (s instanceof Response) return s;
  if (c.limited('xp:' + s.sub, LIMIT_EXPERIMENTAL_WRITES)) return error(429, 'rate_limited');
  const b = await readJson<{ enabled?: unknown }>(c.request);
  if (!b || typeof b.enabled !== 'boolean') return error(400, 'bad_request');
  return noStore(await accountsCall(c.env, '/experimental/set', { userId: s.sub, enabled: b.enabled }));
}

/**
 * POST /api/me/presets { preset }: one preset created or replaced (src/game/physicsRules.ts
 * parseStoredPreset: a 12-hex id, a lobby-style name, values snapped to the table's grid);
 * 409 too_many past MAX_PRESETS. One preset is a few hundred bytes, well inside readJson's 4 KB.
 */
async function presetUpsert(c: RouteContext): Promise<Response> {
  const s = requireAccount(c);
  if (s instanceof Response) return s;
  if (c.limited('xp:' + s.sub, LIMIT_EXPERIMENTAL_WRITES)) return error(429, 'rate_limited');
  const b = await readJson<{ preset?: unknown }>(c.request);
  if (!b) return error(400, 'bad_request');
  const preset = parseStoredPreset(b.preset);
  if (preset === null) return error(400, 'bad_preset', 'Preset inválido');
  return noStore(await accountsCall(c.env, '/presets/upsert', { userId: s.sub, preset }));
}

/** POST /api/me/presets/delete { id }. */
async function presetDelete(c: RouteContext): Promise<Response> {
  const s = requireAccount(c);
  if (s instanceof Response) return s;
  if (c.limited('xp:' + s.sub, LIMIT_EXPERIMENTAL_WRITES)) return error(429, 'rate_limited');
  const b = await readJson<{ id?: unknown }>(c.request);
  if (!b) return error(400, 'bad_request');
  if (typeof b.id !== 'string' || !PRESET_ID_RE.test(b.id)) return error(400, 'bad_preset', 'Preset inválido');
  return noStore(await accountsCall(c.env, '/presets/delete', { userId: s.sub, id: b.id }));
}

// ---- cars and the hosts' shop ---------------------------------------------------------------------

/** Inventory and shop reads per account and minute; picking a car and claiming share the writes. */
export const LIMIT_COSMETIC_READS = 60;
export const LIMIT_COSMETIC_WRITES = 30;

/** What the cosmetic routes read of a request (the /nodes/shop aliases hand in nodeRoutes.ts's). */
export type CosmeticContext = Pick<RouteContext, 'env' | 'request' | 'session' | 'limited'>;

/** GET /api/me/items: the account's items, its car and the cars it may drive (CarSelection's entitlement). */
async function itemsGet(c: CosmeticContext): Promise<Response> {
  const s = requireAccount(c);
  if (s instanceof Response) return s;
  if (c.limited('cos:' + s.sub, LIMIT_COSMETIC_READS)) return error(429, 'rate_limited');
  return noStore(await accountsCall(c.env, '/items?userId=' + encodeURIComponent(s.sub)));
}

/**
 * POST /api/me/car { car }: the default car or one the account owns (AccountsDO checks it, and
 * refuses a banned account), then the session re-signed with it: the next queue or lobby seats the
 * account with it. It keeps the Bearer's exp: unlike a rename (once per 30 days) this route can be
 * called every minute, and a fresh hour each time would keep a stolen or banned token alive forever.
 */
async function carSet(c: CosmeticContext): Promise<Response> {
  const s = requireAccount(c);
  if (s instanceof Response) return s;
  if (c.limited('cow:' + s.sub, LIMIT_COSMETIC_WRITES)) return error(429, 'rate_limited');
  const b = await readJson<{ car?: unknown }>(c.request);
  if (!b || !isCarId(b.car)) return error(400, 'bad_car', 'Auto desconocido');
  const r = await accountsJson<UserRef>(c.env, '/car', { userId: s.sub, car: b.car });
  if (!r.ok) return noStore(r.res);
  return json(await accountSession(c.env, { ...r.data, ...scopeOf(s) }, Date.now(), s.exp), 200, { 'cache-control': 'no-store' });
}

/** GET /api/me/shop: the hosts' shop as the account sees it, and its wallet. */
export async function shopGet(c: CosmeticContext): Promise<Response> {
  const s = requireAccount(c);
  if (s instanceof Response) return s;
  if (c.limited('cos:' + s.sub, LIMIT_COSMETIC_READS)) return error(429, 'rate_limited');
  return noStore(await accountsCall(c.env, '/shop?userId=' + encodeURIComponent(s.sub)));
}

/** POST /api/me/shop/claim { item }: one claim, in AccountsDO's transaction (a retry spends nothing twice). */
export async function shopClaim(c: CosmeticContext): Promise<Response> {
  const s = requirePrimary(c);
  if (s instanceof Response) return s;
  if (c.limited('cow:' + s.sub, LIMIT_COSMETIC_WRITES)) return error(429, 'rate_limited');
  const b = await readJson<{ item?: unknown; itemId?: unknown }>(c.request);
  // `itemId`: the reference server's name for it (nodes/control-plane/devServer.ts, nodes/web/host.html).
  const item = b?.item ?? b?.itemId;
  if (typeof item !== 'string' || !ITEM_ID_RE.test(item)) return error(400, 'bad_item');
  return noStore(await accountsCall(c.env, '/shop/claim', { userId: s.sub, item }));
}

async function me(c: RouteContext): Promise<Response> {
  const s = requireAccount(c);
  if (s instanceof Response) return s;
  const r = await accountsCall(c.env, '/me?userId=' + encodeURIComponent(s.sub));
  const out = pass(r);
  out.headers.set('cache-control', 'no-store');
  return out;
}

const boardCache = new Map<string, { at: number; data: LeaderboardAnswer }>();
const BOARD_TTL_MS = 30_000;

async function leaderboard(c: RouteContext, url: URL): Promise<Response> {
  const playlist = url.searchParams.get('playlist');
  if (!isPlaylist(playlist)) return error(400, 'bad_playlist');
  const now = Date.now();
  let cached = boardCache.get(playlist);
  if (!cached || now - cached.at > BOARD_TTL_MS) {
    const r = await accountsJson<LeaderboardAnswer>(c.env, `/leaderboard?playlist=${playlist}&limit=100`);
    if (!r.ok) return pass(r.res);
    cached = { at: now, data: r.data };
    boardCache.set(playlist, cached);
  }
  let you = null;
  if (c.session?.acct === 1) {
    const r = await accountsJson<LeaderboardAnswer>(c.env, `/leaderboard?playlist=${playlist}&limit=1&userId=${c.session.sub}`);
    if (r.ok) you = r.data.you;
  }
  return json({ ...cached.data, you } satisfies LeaderboardAnswer, 200, { 'cache-control': 'no-store' });
}

async function rankedResult(c: RouteContext, url: URL): Promise<Response> {
  const s = requireAccount(c);
  if (s instanceof Response) return s;
  const matchId = url.searchParams.get('matchId') ?? '';
  if (!/^[0-9a-f]{64}$/.test(matchId)) return error(400, 'bad_match_id');
  const r = await accountsCall(c.env, `/ranked-result?matchId=${matchId}&userId=${s.sub}`);
  const out = pass(r);
  out.headers.set('cache-control', 'no-store');
  return out;
}

// ---- OAuth --------------------------------------------------------------------------------------

interface ProviderConfig {
  clientId: string;
  clientSecret: string;
  authorize: string;
  token: string;
  user: string;
  scope: string;
}

export function providerConfig(env: Env, p: OAuthProvider): ProviderConfig | null {
  if (p === 'google') {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
    return {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
      token: 'https://oauth2.googleapis.com/token',
      user: 'https://openidconnect.googleapis.com/v1/userinfo',
      scope: 'openid profile',
    };
  }
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) return null;
  return {
    clientId: env.DISCORD_CLIENT_ID,
    clientSecret: env.DISCORD_CLIENT_SECRET,
    authorize: 'https://discord.com/oauth2/authorize',
    token: 'https://discord.com/api/v10/oauth2/token',
    user: 'https://discord.com/api/v10/users/@me',
    scope: 'identify',
  };
}

export function enabledProviders(env: Env): OAuthProvider[] {
  return OAUTH_PROVIDERS.filter((p) => providerConfig(env, p) !== null);
}

function publicOrigin(env: Env, request: Request): string {
  return env.PUBLIC_ORIGIN && env.PUBLIC_ORIGIN.length > 0 ? env.PUBLIC_ORIGIN.replace(/\/$/, '') : new URL(request.url).origin;
}

function redirect(location: string, cookies: readonly string[] = []): Response {
  const h = new Headers({ Location: location, 'cache-control': 'no-store' });
  for (const c of cookies) h.append('Set-Cookie', c);
  return new Response(null, { status: 302, headers: h });
}

interface OAuthState {
  /** 'oa' (auth.ts): an OAuth state is never a session or a ticket, nor they one. */
  typ: 'oa';
  p: OAuthProvider;
  v: string;
  n: string;
  /** The account to link the identity to (link=1), or null. */
  link: string | null;
  /** The account to re-authenticate (reauth=1): the identity must already be its. */
  re?: string;
  /** The device that asked (accountStore.ts devices id): its token is replaced by the callback's. */
  dev?: string;
  exp: number;
}

async function oauthStart(c: RouteContext, provider: OAuthProvider, url: URL): Promise<Response> {
  const cfg = providerConfig(c.env, provider);
  if (!cfg) return error(404, 'provider_disabled');
  if (c.limited('oauth:' + ipOf(c.request), 20)) return error(429, 'rate_limited');
  let link: string | null = null;
  let re: string | undefined;
  let dev: string | undefined;
  const mode = url.searchParams.get('link') === '1' ? 'link' : url.searchParams.get('reauth') === '1' ? 'reauth' : 'signin';
  if (mode !== 'signin') {
    // This browser's own signed-in device: never a TV's, and for a link one that just proved a
    // credential. Without one the start says so, it never turns into a sign-in or a sign-up.
    const token = cookieOf(c.request, REFRESH_COOKIE);
    const r = token && token.length <= 128 ? await accountsJson<UserRef & { kind: string; device: string }>(c.env, '/refresh-owner', { hash: await sha256Hex(token) }) : null;
    if (r === null || !r.ok) return redirect('/#auth=error:link_expired');
    if (r.data.kind === 'tv') return redirect('/#auth=error:tv_session');
    const authAt = typeof r.data.authAt === 'number' ? r.data.authAt : 0;
    if (mode === 'link' && (authAt <= 0 || Date.now() - authAt > REAUTH_WINDOW_S * 1000)) return redirect('/#auth=error:reauth_required');
    if (mode === 'link') link = r.data.userId;
    else re = r.data.userId;
    dev = r.data.device;
  }
  const verifier = base64urlEncode(randomBytes(32));
  const challenge = base64urlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(verifier))));
  const nonce = base64urlEncode(randomBytes(16));
  const state: OAuthState = { typ: 'oa', p: provider, v: verifier, n: nonce, link, ...(re !== undefined ? { re } : {}), ...(dev !== undefined ? { dev } : {}), exp: nowSeconds() + OAUTH_TTL_S };
  const cookie = `${OAUTH_COOKIE}=${await signJwt(c.env.JWT_SECRET, state)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${OAUTH_TTL_S}`;
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: `${publicOrigin(c.env, c.request)}/api/auth/oauth/${provider}/callback`,
    response_type: 'code',
    scope: cfg.scope,
    state: nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  if (provider === 'google') q.set('prompt', 'select_account');
  return redirect(`${cfg.authorize}?${q.toString()}`, [cookie]);
}

/** Code -> provider identity { id, name } (token exchange + user endpoint). `fetchFn` for tests. */
export async function oauthIdentity(cfg: ProviderConfig, provider: OAuthProvider, code: string, verifier: string, redirectUri: string, fetchFn: typeof fetch = fetch): Promise<{ id: string; name: string } | null> {
  const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier, client_id: cfg.clientId, client_secret: cfg.clientSecret });
  const tr = await fetchFn(cfg.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form });
  if (!tr.ok) {
    console.warn(`oauth ${provider}: token ${tr.status} ${(await tr.text()).slice(0, 200)}`);
    return null;
  }
  const tok = (await tr.json()) as { access_token?: unknown };
  if (typeof tok.access_token !== 'string') return null;
  const ur = await fetchFn(cfg.user, { headers: { authorization: 'Bearer ' + tok.access_token, accept: 'application/json' } });
  if (!ur.ok) return null;
  const u = (await ur.json()) as Record<string, unknown>;
  if (provider === 'google') {
    if (typeof u.sub !== 'string') return null;
    return { id: u.sub, name: typeof u.given_name === 'string' ? u.given_name : typeof u.name === 'string' ? u.name : 'Player' };
  }
  if (typeof u.id !== 'string') return null;
  return { id: u.id, name: typeof u.global_name === 'string' && u.global_name ? u.global_name : typeof u.username === 'string' ? u.username : 'Player' };
}

async function oauthCallback(c: RouteContext, provider: OAuthProvider, url: URL): Promise<Response> {
  const fail = (code: string): Response => redirect('/#auth=error:' + code, [clearCookie(OAUTH_COOKIE, 'Lax')]);
  const cfg = providerConfig(c.env, provider);
  if (!cfg) return fail('provider_disabled');
  if (url.searchParams.get('error')) return fail('cancelled');
  const raw = cookieOf(c.request, OAUTH_COOKIE);
  const st = raw ? await verifyJwt<OAuthState>(c.env.JWT_SECRET, raw) : null;
  const code = url.searchParams.get('code');
  if (!st || st.typ !== 'oa' || st.p !== provider || st.n !== url.searchParams.get('state') || !code || code.length > 2048) return fail('bad_state');
  const ident = await oauthIdentity(cfg, provider, code, st.v, `${publicOrigin(c.env, c.request)}/api/auth/oauth/${provider}/callback`);
  if (!ident) return fail('provider_error');
  const refreshTok = newRefreshToken();
  const refresh = await grantFor(refreshTok, c.request);
  if (typeof st.re === 'string') {
    const r = await accountsJson<UserRef>(c.env, '/oauth-reauth', { provider, providerId: ident.id, userId: st.re, refresh, replace: st.dev });
    if (!r.ok) return fail(await codeOf(r.res, 'account_error'));
    return redirect('/#auth=reauth', [clearCookie(OAUTH_COOKIE, 'Lax'), refreshCookie(refreshTok)]);
  }
  const r = await accountsJson<UserRef & { created: boolean }>(c.env, '/oauth', { provider, providerId: ident.id, name: ident.name, linkTo: st.link, refresh, ...(st.link !== null ? { replace: st.dev } : {}) });
  if (!r.ok) return fail(await codeOf(r.res, 'account_error'));
  return redirect(r.data.created ? '/#auth=new' : st.link ? '/#auth=linked' : '/#auth=ok', [clearCookie(OAUTH_COOKIE, 'Lax'), refreshCookie(refreshTok)]);
}

/** An AccountsDO refusal's code for the /#auth=error: hash (only the ones the client words), else `fallback`. */
async function codeOf(res: Response, fallback: string): Promise<string> {
  try {
    const b = (await res.json()) as { error?: unknown };
    return typeof b.error === 'string' && ['already_linked', 'provider_set', 'reauth_mismatch', 'link_expired'].includes(b.error) ? b.error : fallback;
  } catch {
    return fallback;
  }
}

/**
 * POST /api/auth/reauth { password }: a password account confirms it is them (PERFIL, before a
 * link, an unlink or a maintainer's work): the password checked as a sign-in's (the same throttles),
 * then this browser's token proves a credential now and the session says so (aat).
 */
async function reauth(c: RouteContext): Promise<Response> {
  const s = requirePrimary(c);
  if (s instanceof Response) return s;
  if (c.limited('reauth:' + s.sub, 10)) return error(429, 'rate_limited');
  const b = await readJson<{ password?: unknown }>(c.request);
  if (!b || !isClientKey(b.password)) return error(400, 'bad_request');
  const token = cookieOf(c.request, REFRESH_COOKIE);
  if (!token || token.length > 128) return error(401, 'no_refresh');
  const me = await accountsJson<{ name: string; hasPassword: boolean }>(c.env, '/me?userId=' + s.sub);
  if (!me.ok) return pass(me.res);
  if (!me.data.hasPassword) return error(400, 'no_password', 'Esta cuenta entra con Google o Discord');
  const chk = await checkCredentials(c, me.data.name, b.password);
  if (!chk.ok) return chk.res;
  if (chk.cred.userId !== s.sub) return error(401, 'bad_credentials', 'Usuario o contraseña incorrectos');
  const r = await accountsJson<UserRef>(c.env, '/reauth', { userId: s.sub, hash: await sha256Hex(token) });
  if (!r.ok) return pass(r.res);
  return json(await accountSession(c.env, r.data), 200, { 'cache-control': 'no-store' });
}

/** POST /api/auth/unlink { provider }: one provider off the account, never its last way in. */
async function unlink(c: RouteContext): Promise<Response> {
  const s = requireFresh(c);
  if (s instanceof Response) return s;
  if (c.limited('unlink:' + s.sub, 10)) return error(429, 'rate_limited');
  const b = await readJson<{ provider?: unknown }>(c.request);
  if (!b || !OAUTH_PROVIDERS.includes(b.provider as OAuthProvider)) return error(400, 'bad_request');
  return noStore(await accountsCall(c.env, '/unlink', { userId: s.sub, provider: b.provider }));
}

// ---- TV sign-in with the phone ------------------------------------------------------------------

const LIMIT_TV_START = 10;
const LIMIT_TV_POLL = 60;
const LIMIT_TV_CONFIRM = 30;

async function tvStart(c: RouteContext): Promise<Response> {
  if (c.limited('tvs:' + ipKey(ipOf(c.request)), LIMIT_TV_START)) return error(429, 'rate_limited');
  // Each code costs a solved check (the TV renders it as a guest's start does): a script filling
  // the table, or minting a code per phishing click, pays one per code.
  const b = await readJson<{ turnstileToken?: unknown }>(c.request);
  if (!b) return error(400, 'bad_request');
  const blocked = await c.antiBot(b.turnstileToken);
  if (blocked !== null) return blocked;
  const secret = base64urlEncode(randomBytes(32));
  const r = await accountsJson<{ code: string; expiresAt: number }>(c.env, '/tv-start', { ip: ipOf(c.request), secret: await sha256Hex(secret), where: whereOfRequest(c.request) });
  if (!r.ok) return pass(r.res);
  const out: TvStartAnswer = { code: r.data.code, secret, expiresAt: r.data.expiresAt, ttlMs: Math.max(0, r.data.expiresAt - Date.now()), pollMs: TV_POLL_MS };
  return noStore(json(out));
}

/** POST /api/auth/tv/info { code }: where the TV is, for the phone's sheet before CONFIRMAR (RFC 8628 section 5.4). */
async function tvInfo(c: RouteContext): Promise<Response> {
  if (!sameOriginOk(c.request, c.originAllowed)) return error(403, 'bad_origin');
  const s = requirePrimary(c);
  if (s instanceof Response) return s;
  if (c.limited('tvc:' + ipKey(ipOf(c.request)), LIMIT_TV_CONFIRM)) return error(429, 'rate_limited');
  const b = await readJson<{ code?: unknown }>(c.request);
  const code = tvCode(b?.code);
  if (code === null) return error(400, 'bad_request');
  const r = await accountsJson<TvInfoAnswer>(c.env, '/tv-info', { code, userId: s.sub, username: s.name, ip: ipOf(c.request), phone: whereOfRequest(c.request) });
  return noStore(r.ok ? json(r.data) : pass(r.res));
}

async function tvConfirm(c: RouteContext): Promise<Response> {
  if (!sameOriginOk(c.request, c.originAllowed)) return error(403, 'bad_origin');
  // A TV never approves another TV: its own scope would pass on as a full one otherwise.
  const s = requirePrimary(c);
  if (s instanceof Response) return s;
  if (c.limited('tvc:' + ipKey(ipOf(c.request)), LIMIT_TV_CONFIRM)) return error(429, 'rate_limited');
  const b = await readJson<{ code?: unknown }>(c.request);
  const code = tvCode(b?.code);
  if (code === null) return error(400, 'bad_request');
  return pass(await accountsCall(c.env, '/tv-confirm', { code, userId: s.sub, username: s.name, ip: ipOf(c.request) }));
}

async function tvPoll(c: RouteContext): Promise<Response> {
  if (!sameOriginOk(c.request, c.originAllowed)) return error(403, 'bad_origin');
  if (c.limited('tvp:' + ipKey(ipOf(c.request)), LIMIT_TV_POLL)) return error(429, 'rate_limited');
  const b = await readJson<{ code?: unknown; secret?: unknown }>(c.request);
  const code = tvCode(b?.code);
  if (code === null || typeof b?.secret !== 'string' || b.secret.length === 0 || b.secret.length > 128) return error(400, 'bad_request');
  const refreshTok = newRefreshToken();
  const r = await accountsJson<UserRef | { state: 'pending' }>(c.env, '/tv-poll', { code, secret: await sha256Hex(b.secret), refresh: await grantFor(refreshTok, c.request) });
  if (!r.ok) return noStore(pass(r.res));
  if ('state' in r.data) return noStore(json(r.data));
  // The TV's limited scope (AccountsDO stores the row as kind 'tv'): the session says it too.
  const out: TvPollAnswer = { ...(await accountSession(c.env, { ...r.data, tv: true })), state: 'approved' };
  return withCookies(json(out), [refreshCookie(refreshTok)]);
}

/** Dispatch; null when the path is not an account route. */
export async function accountRoute(c: RouteContext, url: URL): Promise<Response | null> {
  const p = url.pathname;
  const m = c.request.method;
  if (m === 'POST' && p.startsWith('/api/auth/')) {
    const refused = crossSiteRefusal(c, p);
    if (refused !== null) return refused;
  }
  if (m === 'POST') {
    if (p === '/api/auth/register') return register(c);
    if (p === '/api/auth/login') return login(c);
    if (p === '/api/auth/refresh') return refresh(c);
    if (p === '/api/auth/logout') return logout(c);
    if (p === '/api/auth/recover') return recover(c);
    if (p === '/api/auth/password') return changePassword(c);
    if (p === '/api/auth/recovery-codes') return newRecoveryCodes(c);
    if (p === '/api/me/username') return rename(c);
    if (p === '/api/me/training') return training(c);
    if (p === '/api/me/experimental') return experimentalSet(c);
    if (p === '/api/me/presets') return presetUpsert(c);
    if (p === '/api/me/presets/delete') return presetDelete(c);
    if (p === '/api/auth/tv/start') return tvStart(c);
    if (p === '/api/auth/tv/info') return tvInfo(c);
    if (p === '/api/auth/tv/confirm') return tvConfirm(c);
    if (p === '/api/auth/tv/poll') return tvPoll(c);
    if (p === '/api/me/car') return carSet(c);
    if (p === '/api/me/shop/claim') return shopClaim(c);
    if (p === '/api/auth/sessions/revoke') return sessionRevoke(c);
    if (p === '/api/auth/reauth') return reauth(c);
    if (p === '/api/auth/unlink') return unlink(c);
    if (p === '/api/auth/sessions/revoke-all') return sessionsRevokeAll(c);
  }
  if (m === 'GET') {
    if (p === '/api/me') return me(c);
    if (p === '/api/me/experimental') return experimentalGet(c);
    if (p === '/api/me/items') return itemsGet(c);
    if (p === '/api/me/shop') return shopGet(c);
    if (p === '/api/leaderboard') return leaderboard(c, url);
    if (p === '/api/ranked/result') return rankedResult(c, url);
    if (p === '/api/auth/sessions') return sessionsList(c);
    const o = /^\/api\/auth\/oauth\/(google|discord)\/(start|callback)$/.exec(p);
    if (o) return o[2] === 'start' ? oauthStart(c, o[1] as OAuthProvider, url) : oauthCallback(c, o[1] as OAuthProvider, url);
  }
  return null;
}
