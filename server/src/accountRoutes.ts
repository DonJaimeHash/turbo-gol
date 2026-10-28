/**
 * Worker routes for registered accounts (the guest flow stays in index.ts):
 *
 *   POST /api/auth/register   { username, password, turnstileToken? } -> RegisterAnswer + refresh cookie (the same
 *                             Turnstile gate as POST /api/guest when it is on)
 *   POST /api/auth/login      { username, password }            -> AccountSession + refresh cookie
 *   POST /api/auth/refresh    (refresh cookie)                  -> AccountSession (token rotated) | 401
 *   POST /api/auth/logout     (refresh cookie)                  -> { ok } + cookie cleared
 *   POST /api/auth/recover    { username, code, password }      -> AccountSession + { codesLeft } + cookie
 *   POST /api/auth/password   Bearer { oldPassword, password }  -> { ok } (every other device signed out)
 *   POST /api/auth/recovery-codes Bearer { password }           -> { recoveryCodes }
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
 *   GET  /api/auth/oauth/:provider/start[?link=1]               -> 302 to Google / Discord (state + PKCE)
 *   GET  /api/auth/oauth/:provider/callback?code&state          -> 302 to /#auth=ok | /#auth=error:<code>
 *   POST /api/auth/tv/start   (no session)                      -> TvStartAnswer: a TV signing in with the phone
 *   POST /api/auth/tv/confirm Bearer (account) { code }         -> { ok } | 404 tv_code_wrong | 410 tv_code_expired
 *                             | 409 tv_code_used | 429 throttled: the phone binds the code to its account, once
 *   POST /api/auth/tv/poll    { code, secret }                  -> { state: 'pending' } | AccountSession & { state:
 *                             'approved' } + refresh cookie (as login) | 410 | 409 | 403 bad_secret
 *     The device-code pattern (tvCodes.ts in the AccountsDO): the code is 6 of the lobby alphabet and
 *     lives 5 minutes; the secret (32 random bytes) goes only to the TV and only its SHA-256 to the
 *     object, compared in constant time; an approved poll wipes the binding (one use). Limits: start
 *     10 a minute per IP (and 5 live codes per IP), poll 60, confirm 30 a minute per IP plus 10
 *     failed confirms (wrong, expired or used codes) per account and per IP in 15 minutes.
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
import type { AccountSession, LeaderboardAnswer, OAuthProvider, RegisterAnswer, TvPollAnswer, TvStartAnswer } from '../../src/net/account';
import type { Credentials, PasswordRecord, UserRef } from './accountStore';
import { TV_POLL_MS, tvCode } from './tvCodes';
import { PRESET_ID_RE, parseStoredPreset } from '../../src/game/physicsRules';
import { DEFAULT_CAR, isCarId } from '../../src/game/cosmetics';
import { ITEM_ID_RE } from '../../nodes/control-plane/shop';

export const ACCOUNT_SESSION_TTL_SECONDS = 60 * 60;
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

function newRefreshToken(): string {
  return base64urlEncode(randomBytes(32));
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
  const claims: SessionClaims = { sub: u.userId, name: u.username, iat, exp, acct: 1 };
  // Absent = the default car on every path (the seats, the rosters): the token carries only another one.
  if (car !== DEFAULT_CAR) claims.car = car;
  if (typeof u.createdAt === 'number' && u.createdAt > 0) claims.since = nowSeconds(u.createdAt);
  return { kind: 'account', playerId: u.userId, name: u.username, session: await signJwt(env.JWT_SECRET, claims), expiresAt: exp * 1000, car };
}

/** A cookie-carrying POST from a page of another origin is refused (SameSite=Strict already blocks most). */
function sameOriginOk(request: Request, allowed: (origin: string) => boolean): boolean {
  const origin = request.headers.get('Origin');
  return origin === null || allowed(origin);
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
    refresh: await sha256Hex(refresh),
  });
  if (!r.ok) return pass(r.res);
  const out: RegisterAnswer = { ...(await accountSession(c.env, r.data)), recoveryCodes: codes };
  return withCookies(json(out), [refreshCookie(refresh)]);
}

/** Look the user up and check the password; a missing user still costs one hash (no timing oracle). */
async function checkCredentials(c: RouteContext, username: string, clientKey: string): Promise<{ ok: true; cred: Credentials } | { ok: false; res: Response }> {
  const begin = await accountsJson<{ found: boolean } & Partial<Credentials>>(c.env, '/auth-begin', { username, ip: ipOf(c.request) });
  if (!begin.ok) return { ok: false, res: pass(begin.res) };
  const d = begin.data;
  if (!d.found) {
    await serverHash(clientKey, '00'.repeat(16));
    await accountsCall(c.env, '/auth-finish', { username, ip: ipOf(c.request), ok: false });
    return { ok: false, res: error(401, 'bad_credentials', 'Usuario o contraseña incorrectos') };
  }
  const cred = d as Credentials;
  const good = await verifyPassword(clientKey, cred);
  if (!good) {
    await accountsCall(c.env, '/auth-finish', { username, ip: ipOf(c.request), ok: false });
    return { ok: false, res: error(401, cred.hash ? 'bad_credentials' : 'no_password', cred.hash ? 'Usuario o contraseña incorrectos' : 'Esta cuenta entra con Google o Discord') };
  }
  if (cred.banned) return { ok: false, res: error(403, 'banned', 'Cuenta suspendida') };
  return { ok: true, cred };
}

async function login(c: RouteContext): Promise<Response> {
  if (c.limited('login:' + ipOf(c.request), 30)) return error(429, 'rate_limited');
  const b = await readJson<{ username?: unknown; password?: unknown }>(c.request);
  if (!b || typeof b.username !== 'string' || b.username.length > 64 || !isClientKey(b.password)) return error(400, 'bad_request');
  const chk = await checkCredentials(c, b.username, b.password);
  if (!chk.ok) return chk.res;
  const refresh = newRefreshToken();
  const fin = await accountsJson<UserRef>(c.env, '/auth-finish', { userId: chk.cred.userId, username: b.username, ip: ipOf(c.request), ok: true, refresh: await sha256Hex(refresh) });
  if (!fin.ok) return pass(fin.res);
  return withCookies(json(await accountSession(c.env, fin.data)), [refreshCookie(refresh)]);
}

async function refresh(c: RouteContext): Promise<Response> {
  if (!sameOriginOk(c.request, c.originAllowed)) return error(403, 'bad_origin');
  if (c.limited('refresh:' + ipOf(c.request), 60)) return error(429, 'rate_limited');
  const token = cookieOf(c.request, REFRESH_COOKIE);
  if (!token || token.length > 128) return withCookies(error(401, 'no_refresh'), []);
  const next = newRefreshToken();
  const r = await accountsJson<UserRef>(c.env, '/refresh', { old: await sha256Hex(token), next: await sha256Hex(next) });
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
  const b = await readJson<{ username?: unknown; code?: unknown; password?: unknown }>(c.request);
  if (!b || typeof b.username !== 'string' || b.username.length > 64 || typeof b.code !== 'string' || b.code.length > 32 || !isClientKey(b.password)) return error(400, 'bad_request');
  const refreshTok = newRefreshToken();
  const r = await accountsJson<UserRef & { codesLeft: number }>(c.env, '/recover', {
    username: b.username,
    code: await recoveryCodeHash(b.code),
    pw: await newPasswordRecord(b.password),
    refresh: await sha256Hex(refreshTok),
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

async function changePassword(c: RouteContext): Promise<Response> {
  const s = requireAccount(c);
  if (s instanceof Response) return s;
  const b = await readJson<{ oldPassword?: unknown; password?: unknown }>(c.request);
  if (!b || !isClientKey(b.password)) return error(400, 'bad_request');
  const me = await accountsJson<{ name: string; hasPassword: boolean }>(c.env, '/me?userId=' + s.sub);
  if (!me.ok) return pass(me.res);
  if (me.data.hasPassword) {
    if (!isClientKey(b.oldPassword)) return error(400, 'bad_request');
    const chk = await checkCredentials(c, me.data.name, b.oldPassword);
    if (!chk.ok) return chk.res;
  }
  const token = cookieOf(c.request, REFRESH_COOKIE);
  const r = await accountsCall(c.env, '/password', { userId: s.sub, pw: await newPasswordRecord(b.password), keep: token ? await sha256Hex(token) : undefined });
  return r.ok ? json({ ok: true }) : pass(r);
}

async function newRecoveryCodes(c: RouteContext): Promise<Response> {
  const s = requireAccount(c);
  if (s instanceof Response) return s;
  const b = await readJson<{ password?: unknown }>(c.request);
  const me = await accountsJson<{ name: string; hasPassword: boolean }>(c.env, '/me?userId=' + s.sub);
  if (!me.ok) return pass(me.res);
  if (me.data.hasPassword) {
    if (!b || !isClientKey(b.password)) return error(400, 'bad_request');
    const chk = await checkCredentials(c, me.data.name, b.password);
    if (!chk.ok) return chk.res;
  }
  const codes = Array.from({ length: RECOVERY_CODES }, newRecoveryCode);
  const r = await accountsCall(c.env, '/recovery', { userId: s.sub, hashes: await Promise.all(codes.map(recoveryCodeHash)) });
  return r.ok ? json({ recoveryCodes: codes }) : pass(r);
}

async function rename(c: RouteContext): Promise<Response> {
  const s = requireAccount(c);
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
  return json(await accountSession(c.env, r.data));
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
  return json(await accountSession(c.env, r.data, Date.now(), s.exp), 200, { 'cache-control': 'no-store' });
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
  const s = requireAccount(c);
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
  p: OAuthProvider;
  v: string;
  n: string;
  link: string | null;
  exp: number;
}

async function oauthStart(c: RouteContext, provider: OAuthProvider, url: URL): Promise<Response> {
  const cfg = providerConfig(c.env, provider);
  if (!cfg) return error(404, 'provider_disabled');
  if (c.limited('oauth:' + ipOf(c.request), 20)) return error(429, 'rate_limited');
  let link: string | null = null;
  if (url.searchParams.get('link') === '1') {
    const token = cookieOf(c.request, REFRESH_COOKIE);
    if (token) {
      const r = await accountsJson<UserRef>(c.env, '/refresh-owner', { hash: await sha256Hex(token) });
      if (r.ok) link = r.data.userId;
    }
  }
  const verifier = base64urlEncode(randomBytes(32));
  const challenge = base64urlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(verifier))));
  const nonce = base64urlEncode(randomBytes(16));
  const state: OAuthState = { p: provider, v: verifier, n: nonce, link, exp: nowSeconds() + OAUTH_TTL_S };
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
  if (!st || st.p !== provider || st.n !== url.searchParams.get('state') || !code || code.length > 2048) return fail('bad_state');
  const ident = await oauthIdentity(cfg, provider, code, st.v, `${publicOrigin(c.env, c.request)}/api/auth/oauth/${provider}/callback`);
  if (!ident) return fail('provider_error');
  const refreshTok = newRefreshToken();
  const r = await accountsJson<UserRef & { created: boolean }>(c.env, '/oauth', { provider, providerId: ident.id, name: ident.name, linkTo: st.link, refresh: await sha256Hex(refreshTok) });
  if (!r.ok) return fail(r.res.status === 409 ? 'already_linked' : 'account_error');
  return redirect(r.data.created ? '/#auth=new' : st.link ? '/#auth=linked' : '/#auth=ok', [clearCookie(OAUTH_COOKIE, 'Lax'), refreshCookie(refreshTok)]);
}

// ---- TV sign-in with the phone ------------------------------------------------------------------

const LIMIT_TV_START = 10;
const LIMIT_TV_POLL = 60;
const LIMIT_TV_CONFIRM = 30;

async function tvStart(c: RouteContext): Promise<Response> {
  if (c.limited('tvs:' + ipOf(c.request), LIMIT_TV_START)) return error(429, 'rate_limited');
  const secret = base64urlEncode(randomBytes(32));
  const r = await accountsJson<{ code: string; expiresAt: number }>(c.env, '/tv-start', { ip: ipOf(c.request), secret: await sha256Hex(secret) });
  if (!r.ok) return pass(r.res);
  const out: TvStartAnswer = { code: r.data.code, secret, expiresAt: r.data.expiresAt, ttlMs: Math.max(0, r.data.expiresAt - Date.now()), pollMs: TV_POLL_MS };
  return noStore(json(out));
}

async function tvConfirm(c: RouteContext): Promise<Response> {
  if (!sameOriginOk(c.request, c.originAllowed)) return error(403, 'bad_origin');
  const s = requireAccount(c);
  if (s instanceof Response) return s;
  if (c.limited('tvc:' + ipOf(c.request), LIMIT_TV_CONFIRM)) return error(429, 'rate_limited');
  const b = await readJson<{ code?: unknown }>(c.request);
  const code = tvCode(b?.code);
  if (code === null) return error(400, 'bad_request');
  return pass(await accountsCall(c.env, '/tv-confirm', { code, userId: s.sub, username: s.name, ip: ipOf(c.request) }));
}

async function tvPoll(c: RouteContext): Promise<Response> {
  if (!sameOriginOk(c.request, c.originAllowed)) return error(403, 'bad_origin');
  if (c.limited('tvp:' + ipOf(c.request), LIMIT_TV_POLL)) return error(429, 'rate_limited');
  const b = await readJson<{ code?: unknown; secret?: unknown }>(c.request);
  const code = tvCode(b?.code);
  if (code === null || typeof b?.secret !== 'string' || b.secret.length === 0 || b.secret.length > 128) return error(400, 'bad_request');
  const refreshTok = newRefreshToken();
  const r = await accountsJson<UserRef | { state: 'pending' }>(c.env, '/tv-poll', { code, secret: await sha256Hex(b.secret), refresh: await sha256Hex(refreshTok) });
  if (!r.ok) return noStore(pass(r.res));
  if ('state' in r.data) return noStore(json(r.data));
  const out: TvPollAnswer = { ...(await accountSession(c.env, r.data)), state: 'approved' };
  return withCookies(json(out), [refreshCookie(refreshTok)]);
}

/** Dispatch; null when the path is not an account route. */
export async function accountRoute(c: RouteContext, url: URL): Promise<Response | null> {
  const p = url.pathname;
  const m = c.request.method;
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
    if (p === '/api/auth/tv/confirm') return tvConfirm(c);
    if (p === '/api/auth/tv/poll') return tvPoll(c);
    if (p === '/api/me/car') return carSet(c);
    if (p === '/api/me/shop/claim') return shopClaim(c);
  }
  if (m === 'GET') {
    if (p === '/api/me') return me(c);
    if (p === '/api/me/experimental') return experimentalGet(c);
    if (p === '/api/me/items') return itemsGet(c);
    if (p === '/api/me/shop') return shopGet(c);
    if (p === '/api/leaderboard') return leaderboard(c, url);
    if (p === '/api/ranked/result') return rankedResult(c, url);
    const o = /^\/api\/auth\/oauth\/(google|discord)\/(start|callback)$/.exec(p);
    if (o) return o[2] === 'start' ? oauthStart(c, o[1] as OAuthProvider, url) : oauthCallback(c, o[1] as OAuthProvider, url);
  }
  return null;
}
