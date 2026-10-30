/**
 * Worker routes for registered accounts (the guest flow stays in index.ts):
 *
 *   The email accounts (sign-in PR 7: signup/*, code/resend, signin, forgot, reset/*, reauth/code*,
 *   /api/me/password and its link) are listed with their section below ("email accounts").
 *   POST /api/auth/register, /api/auth/recovery-codes, /api/auth/password -> 410 gone (sign-in PR 7):
 *                             accounts are made by email, and a Bearer alone never adds a way in (I4)
 *   POST /api/auth/login      { username, password, passwordV2, turnstileToken } -> AccountSession + refresh cookie
 *                             (level 2) | 401 bad_credentials for every refusal (an account with a verified email
 *                             too: it signs in by email) | 403 turnstile_failed | 429 throttled { retryAfterMs }
 *   POST /api/auth/refresh    (refresh cookie)                  -> AccountSession (token rotated) | 401 (a copied token:
 *                             its whole family revoked) | 409 refresh_race (another tab rotated it: retry, cookie kept)
 *   POST /api/auth/logout     (refresh cookie)                  -> { ok } + cookie cleared (this device: its whole
 *                             family, a copy rotated meanwhile too)
 *   GET  /api/auth/sessions   Bearer (account, not a TV) [cookie] -> SessionsAnswer: the signed-in devices
 *   POST /api/auth/sessions/revoke Bearer { id }                -> { revoked } (that device signed out)
 *   POST /api/auth/sessions/revoke-all Bearer                   -> { revoked } + cookie cleared (every device, this one too)
 *   POST /api/auth/recover    { username, code, passwordV2, turnstileToken } -> AccountSession + { codesLeft } + cookie
 *   POST /api/me/username     Bearer { username } -> AccountSession (new name in the token) | 409 username_taken /
 *                             name_lookalike { suggest } | 403 reauth_required { level: 2 } for a legacy password
 *                             (salted with the name: "confirm it's you" re-keys it first). Not from a TV.
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
 *   GET  /api/leaderboard?playlist=1v1  [Bearer]                -> LeaderboardAnswer (cached 30 s per playlist; an
 *                             account's own row 15 s per account)
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
 *   POST /api/auth/reauth     Bearer { legacy, password } (refresh cookie) -> AccountSession: the password re-proved
 *                             (a legacy record re-keyed), the cookie's credential proof now at level 2
 *   POST /api/auth/unlink     Bearer (fresh(1)) { provider }    -> { ok } | 409 last_method (the only way in left) |
 *                             404 not_linked | 403 reauth_required { level } (level 2 when one way in would be left)
 *
 * Levels (the sign-in design's R6). Each credential event gives the device's refresh family a
 * level, stored with it (accountStore.ts refresh.auth_lvl, method) and signed into the session as
 * `aal` beside `aat`: 2 a typed password (signin, login, recover, reauth) or a mailbox proof that
 * sets one (signup/finish, reset) or a code from the account's mailbox (reauth/code/verify), 1 a
 * press on the provider's page (Google's account chooser, Discord's prompt=consent), 0 nothing (a
 * TV, a family from before levels). A refresh keeps it and never raises it. requireFresh(c, level)
 * asks for it: a link needs 1; an unlink 1, or 2 when one way in would be left; the maintainer
 * routes (nodeRoutes.ts) always 2, which a maintainer reaches with its password only (reauth/code
 * refuses NODE_TRUSTED_OPERATORS).
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
 * A password field is always a client key (PBKDF2 in the browser), never the typed password: the
 * current key (src/net/account.ts passwordKey, one fixed salt: `passwordV2`, and `password` in
 * reauth) or the legacy one (legacyPasswordKey, salted with the username: `password` elsewhere,
 * `legacy` in reauth), which every successful proof re-keys to the current one (users.pw_v 1 -> 2).
 * A page of before the current key sends only the legacy one, which is never stored as current. The
 * server stores PBKDF2-SHA256(HMAC-SHA256(PASSWORD_PEPPER, clientKey), random salt, 100,000) — the
 * Workers WebCrypto iteration ceiling — (users.pw_kid 'p1'), or without the HMAC where the secret
 * is not set, or for a legacy key, or while the AccountsDO cannot keep the label (pw_kid ''; storeEnv),
 * and re-hashes a current record of another pepper at its next sign-in. Hashing
 * happens here, in parallel isolates, and the single AccountsDO only stores and compares rows.
 * Nothing logs a request body or a password field (server/test/no-secret-logs.test.mjs checks it).
 *
 * Tokens: an account session is the same HS256 session as a guest's (index.ts bearerSession) with
 * `acct: 1` and a 1 h life, the car the account drives (`car`, only when it is not the default one:
 * AccountsDO hands the session only a car the account still owns) and when it was created
 * (`since`, seconds: its rewards weight on a community node); the refresh token (32 random bytes, stored as SHA-256) travels only in
 * the `__Host-tg_rt` cookie (HttpOnly, Secure, SameSite=Strict, Path=/, 30 days sliding, rotated on
 * every refresh). SameSite=Strict plus the Origin check below keep other sites from using it.
 * The device cookie `__Host-tg_dv` (HttpOnly, Secure, SameSite=Strict, 180 days), set at each
 * password sign-in (signin, signup/finish, reset, login, recover): "<userId>.<id>.<HMAC>", the HMAC under a key of its
 * own (HKDF of JWT_SECRET, never a token signature). It is no credential and logout keeps it: it
 * only says this browser signed in to that account before, so a username past AccountsDO's daily
 * cap of failures from unknown browsers still takes this browser's sign-ins (counted per device).
 * OAuth: the state cookie `__Host-tg_oa` (SameSite=Lax: it must survive the provider's redirect back)
 * holds a signed JWT with the PKCE verifier, the state nonce and the account to link, 10 minutes.
 * Providers are enabled by their secrets (GOOGLE_CLIENT_ID / _SECRET, DISCORD_CLIENT_ID / _SECRET);
 * GET /api/config lists the enabled ones. Redirect URI = <origin>/api/auth/oauth/<provider>/callback,
 * origin = PUBLIC_ORIGIN when set, else the request's own.
 */
import type { Env } from './env';
import { EXPERIMENTAL_REFUSED, carriesPhysics, error, json, readJson, trustedOperatorIds } from './env';
import { base64urlDecode, base64urlEncode, internalSecret, INTERNAL_HEADER, nowSeconds, signJwt, verifyJwt } from './auth';
import type { SessionClaims } from './auth';
import { isClientKey, isPlaylist, normalizeEmail, OAUTH_PROVIDERS, usernameProblem } from '../../src/net/account';
import type { AccountSession, CodeResendAnswer, CodeStartAnswer, LeaderboardAnswer, OAuthProvider, PasswordLinkAnswer, TvInfoAnswer, TvPollAnswer, TvStartAnswer } from '../../src/net/account';
import type { Credentials, PasswordRecord, RefreshGrant, UserRef } from './accountStore';
import { TV_POLL_MS, ipKey, tvCode } from './tvCodes';
import { firstUse } from './limits';
import { PRESET_ID_RE, parseStoredPreset } from '../../src/game/physicsRules';
import { DEFAULT_CAR, isCarId } from '../../src/game/cosmetics';
import { ITEM_ID_RE } from '../../nodes/control-plane/shop';
import { composeMail, deliver, isLocalDev, linkOrigin } from './mail';
import type { Mailer, MailMessage } from './mail';
import { FAILURES, mailKilled } from './mailCaps';
import { renderMail } from './mailTemplates';
import type { MailOrder } from './accountStore';

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
const DEVICE_COOKIE = '__Host-tg_dv';
const REFRESH_MAX_AGE_S = 30 * 24 * 60 * 60;
const DEVICE_MAX_AGE_S = 180 * 24 * 60 * 60;
const OAUTH_TTL_S = 600;
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

/** users.pw_kid of a record hashed with PASSWORD_PEPPER (the first pepper; a leak would add 'p2'). */
export const PEPPER_KID = 'p1';
/** The shortest PASSWORD_PEPPER taken: 32 random bytes are 64 characters in hex, 44 in base64. */
export const PEPPER_MIN_LENGTH = 32;
/** The salt of the dummy server stage: 16 bytes, as a real record's. */
const DUMMY_SALT = '00'.repeat(16);

type PepperEnv = Partial<Pick<Env, 'PASSWORD_PEPPER'>>;

let pepperWarned = false;

/** The pepper id new records get here: PEPPER_KID with a PASSWORD_PEPPER of PEPPER_MIN_LENGTH or more, else '' (a fork, dev, tests). */
export function currentKid(env: PepperEnv): '' | typeof PEPPER_KID {
  const p = env.PASSWORD_PEPPER;
  if (typeof p !== 'string' || p.length === 0) return '';
  if (p.length >= PEPPER_MIN_LENGTH) return PEPPER_KID;
  if (!pepperWarned) {
    pepperWarned = true;
    console.warn(`PASSWORD_PEPPER is shorter than ${PEPPER_MIN_LENGTH} characters: not used (no pepper)`);
  }
  return '';
}

/** The pepper of a record's `kid`: null for none (''), undefined when that pepper is not set here (the record cannot be checked). */
function pepperFor(env: PepperEnv, kid: string): string | null | undefined {
  if (kid === '') return null;
  return kid === PEPPER_KID && currentKid(env) === PEPPER_KID ? (env.PASSWORD_PEPPER as string) : undefined;
}

const pepperKeys = new Map<string, Promise<CryptoKey>>();

function pepperKey(pepper: string): Promise<CryptoKey> {
  let k = pepperKeys.get(pepper);
  if (!k) {
    k = crypto.subtle.importKey('raw', enc.encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    pepperKeys.clear(); // one pepper per deployment
    pepperKeys.set(pepper, k);
  }
  return k;
}

/**
 * The server stage of a password (the design's §1.5): PBKDF2-SHA256 of the client key (hex) with
 * `saltHex`, and with a pepper, of HMAC-SHA256(pepper, client key) instead. The stored hash.
 */
export async function serverHash(clientKey: string, saltHex: string, iter: number = SERVER_KDF_ITERATIONS, pepper: string | null = null): Promise<string> {
  const input = pepper === null ? fromHex(clientKey) : new Uint8Array(await crypto.subtle.sign('HMAC', await pepperKey(pepper), fromHex(clientKey)));
  const key = await crypto.subtle.importKey('raw', input, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex), iterations: iter }, key, 256);
  return hex(new Uint8Array(bits));
}

/**
 * A record to store for `clientKey`: `v` 1 for the legacy key (account.ts legacyPasswordKey), 2 for
 * the current one (passwordKey). A current record gets this deployment's pepper when it has one
 * (pw_kid 'p1'); a legacy one never does (pw_kid ''), so every build agrees on what it is: a build
 * of before (a rollback) writes unpeppered legacy records and leaves pw_kid as it was, and
 * provePassword reads a legacy record without a pepper whatever its pw_kid says. The routes that
 * store one take their env from storeEnv: no pepper until the AccountsDO keeps a record's labels.
 */
export async function newPasswordRecord(clientKey: string, v: 1 | 2 = 1, env: PepperEnv = {}): Promise<PasswordRecord> {
  const salt = hex(randomBytes(16));
  const kid = v === 2 ? currentKid(env) : '';
  return { hash: await serverHash(clientKey, salt, SERVER_KDF_ITERATIONS, kid === '' ? null : (env.PASSWORD_PEPPER as string)), salt, iter: SERVER_KDF_ITERATIONS, v, kid };
}

/**
 * The server stage an unknown username, an account without the asked password, or a key that is
 * missing still pays: the pepper's HMAC when there is one and PBKDF2 at SERVER_KDF_ITERATIONS over
 * a 16-byte salt, exactly a new record's parameters, so the time tells nothing (I6).
 */
export async function dummyStage(clientKey: string, env: PepperEnv = {}): Promise<void> {
  const kid = currentKid(env);
  await serverHash(clientKey, DUMMY_SALT, SERVER_KDF_ITERATIONS, kid === '' ? null : (env.PASSWORD_PEPPER as string));
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** The client key against a stored record, with the record's own pepper (its kid); false when that pepper is not set here. */
export async function verifyPassword(clientKey: string, c: Pick<Credentials, 'hash' | 'salt' | 'iter' | 'kid'>, env: PepperEnv = {}): Promise<boolean> {
  if (!c.hash || !c.salt || !c.iter) return false;
  const pepper = pepperFor(env, c.kid ?? '');
  if (pepper === undefined) {
    console.error(`password check: a record of pepper ${c.kid} and no such PASSWORD_PEPPER here`);
    await dummyStage(clientKey, env);
    return false;
  }
  return constantTimeEqualHex(await serverHash(clientKey, c.salt, c.iter, pepper), c.hash);
}

/**
 * A password as the client proved it: `v1` its legacy key (salted with the username), `v2` its
 * current key. A check reads the one the stored record holds (Credentials.pwV).
 */
export interface PasswordProof {
  v1?: string;
  v2?: string;
}

/** The record's client key version: an AccountsDO still on the code of before (the minutes of a deploy) names none, and all its hashes are legacy. */
function pwVOf(cred: Credentials): number {
  return typeof cred.pwV === 'number' ? cred.pwV : cred.hash ? 1 : 0;
}

/**
 * The proof checks against the account's stored password (the dummy stage when it has none, or the
 * proof lacks its key). A failure of a proof that carries both keys pays a second stage, so the
 * time is the same whatever the record: for a legacy record it is a real check of the current key.
 * That one passes only for a current key stored under pw_v 1, which an AccountsDO still on the
 * code of before writes in the minutes of a deploy (its sign-up, recovery and password change label
 * every record legacy, and storeEnv sends it none with a pepper): its owner still signs in, and the
 * sign-in re-keys it under the right label. A legacy record is read without a pepper, both stages:
 * none is ever written with one, and a build of before (a rollback) leaves a stale pw_kid on it.
 */
export async function provePassword(env: PepperEnv, cred: Credentials, proof: PasswordProof): Promise<boolean> {
  const pwV = pwVOf(cred);
  const key = pwV === 2 ? proof.v2 : pwV === 1 ? proof.v1 : undefined;
  const both = proof.v1 !== undefined && proof.v2 !== undefined;
  const filler = proof.v2 ?? proof.v1 ?? DUMMY_SALT + DUMMY_SALT;
  if (!cred.hash || key === undefined) {
    await dummyStage(filler, env);
    if (both) await dummyStage(filler, env);
    return false;
  }
  const rec = pwV === 1 ? { ...cred, kid: '' } : cred;
  if (await verifyPassword(key, rec, env)) return true;
  if (!both) return false;
  if (pwV === 1) return verifyPassword(proof.v2 as string, rec, env);
  await dummyStage(filler, env);
  return false;
}

/**
 * After a successful proof, what to store again, or null: a legacy record becomes the current
 * key's when the proof carries it (the re-key, §3.10), and a current record of another pepper than
 * this deployment's is re-hashed with it (pw_kid '' once PASSWORD_PEPPER is set). A legacy record
 * without the current key in the proof stays as it is (never peppered).
 */
export async function rekeyFor(env: PepperEnv, cred: Credentials, proof: PasswordProof): Promise<PasswordRecord | null> {
  if (proof.v2 === undefined) return null;
  if (pwVOf(cred) === 1) return newPasswordRecord(proof.v2, 2, env);
  return (cred.kid ?? '') === currentKid(env) ? null : newPasswordRecord(proof.v2, 2, env);
}

/**
 * The env a route makes a record to store with (a sign-up, a recovery, a password change, a
 * rename's re-key): this deployment's, its pepper with it, when the AccountsDO has just said that
 * it keeps a record's labels (GET /pw-labels, this code's); {} otherwise. An object on the code of
 * before (the minutes of a deploy, the #71 case, or of a rollback) stores every record as pw_v 1 and
 * pw_kid '', so a record it gets is made without the pepper: that '' is then true, and
 * provePassword's second stage reads the current key it calls legacy. Either order of deploying
 * this code and setting PASSWORD_PEPPER is safe. Asked at every such write (they are rare): a yes
 * kept for longer could outlive the object's code in a rollback.
 */
async function storeEnv(env: Env): Promise<PepperEnv> {
  const r = await accountsCall(env, '/pw-labels');
  await r.text().catch(() => '');
  return r.ok ? env : {};
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

/**
 * Every refresh cookie this code takes: newRefreshToken's "<22>.<43>", or a token from before
 * families (43 alone, still live for up to 30 days). Any other value names no row. MERGE NOTE:
 * sec/edge-limits has a REFRESH_TOKEN_RE of the 43-character form alone; keep this one, or every
 * rotated cookie is refused (everyone signed out at their next refresh) and logout revokes nothing.
 */
export const REFRESH_TOKEN_RE = /^(?:[A-Za-z0-9_-]{22}\.)?[A-Za-z0-9_-]{43}$/;

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

let deviceKeyCache: { secret: string; key: Promise<CryptoKey> } | null = null;

/** The device cookie's HMAC key: HKDF-SHA256 of JWT_SECRET with an info of its own (auth.ts's salt). */
function deviceKey(secret: string): Promise<CryptoKey> {
  if (deviceKeyCache && deviceKeyCache.secret === secret) return deviceKeyCache.key;
  const key = (async () => {
    const ikm = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('turbogol/hkdf/v2'), info: enc.encode('device-cookie') }, ikm, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']);
  })();
  deviceKeyCache = { secret, key };
  return key;
}

/** Set at a password sign-in: this browser signed in to `userId` (a new device id each time). */
async function deviceCookie(env: Env, userId: string): Promise<string> {
  const id = base64urlEncode(randomBytes(16));
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await deviceKey(env.JWT_SECRET), enc.encode(userId + '.' + id)));
  return `${DEVICE_COOKIE}=${userId}.${id}.${base64urlEncode(mac)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${DEVICE_MAX_AGE_S}`;
}

/** This browser's device cookie, its MAC checked: the account it signed in to and its id; undefined without a good one. */
export async function deviceOf(env: Env, request: Request): Promise<{ user: string; id: string } | undefined> {
  const m = /^([0-9a-f]{16})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(cookieOf(request, DEVICE_COOKIE) ?? '');
  const mac = m ? base64urlDecode(m[3]) : null;
  if (!m || !mac) return undefined;
  const good = await crypto.subtle.verify('HMAC', await deviceKey(env.JWT_SECRET), mac, enc.encode(m[1] + '.' + m[2]));
  return good ? { user: m[1], id: m[2] } : undefined;
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
  // The device's scope (accountStore.ts refresh kind, auth_at and auth_lvl): a TV's, or when it last
  // proved a credential and at what level (R6; 0 is no aal at all).
  if (u.tv === true) claims.tv = 1;
  else if (typeof u.authAt === 'number' && u.authAt > 0) {
    claims.aat = nowSeconds(u.authAt);
    if (u.authLvl === 1 || u.authLvl === 2) claims.aal = u.authLvl;
  }
  const out: AccountSession = { kind: 'account', playerId: u.userId, name: u.username, session: await signJwt(env.JWT_SECRET, claims), expiresAt: exp * 1000, car };
  if (claims.tv === 1) out.tv = true;
  if (claims.aat !== undefined) out.authAt = claims.aat * 1000;
  if (claims.aal !== undefined) out.authLvl = claims.aal;
  return out;
}

/** The scope a Bearer carries, for a route that re-signs it (a car, a rename): never widened, never dropped. */
function scopeOf(s: SessionClaims): Pick<UserRef, 'tv' | 'authAt' | 'authLvl'> {
  return s.tv === 1 ? { tv: true } : s.aat !== undefined ? { authAt: s.aat * 1000, authLvl: s.aal ?? 0 } : {};
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
  /** The request's ctx.waitUntil (index.ts): a mail goes out after the answer (R7). Absent (tests): the send still runs. */
  waitUntil?: (p: Promise<unknown>) => void;
  /** mail.ts chooseMailer's for this request (the stub off production): the email routes refuse with 503 without one. */
  mailer?: Mailer;
}

/**
 * A request's new password: `passwordV2` (the current client key, stored as pw_v 2) or, from a
 * page of before it, `legacy` (the legacy key, pw_v 1). Never the other way round: a page that
 * predates the current key sends no `passwordV2`, so a legacy key is never stored as a current one.
 */
function newKeyOf(passwordV2: unknown, legacy: unknown): { key: string; v: 1 | 2 } | null {
  if (isClientKey(passwordV2)) return { key: passwordV2, v: 2 };
  return isClientKey(legacy) ? { key: legacy, v: 1 } : null;
}

/** A proof's keys from a body's fields (each only when it is a client key's shape). */
function proofOf(v1: unknown, v2: unknown): PasswordProof {
  return { ...(isClientKey(v1) ? { v1 } : {}), ...(isClientKey(v2) ? { v2 } : {}) };
}

/**
 * Who checks a password: a sign-in (anonymous: it has already passed Turnstile, and AccountsDO
 * counts it on the username, the network and this browser's device cookie), or a session of the
 * account itself (a password change, new codes, a rename, a re-authentication), whose failures count
 * only per account (AccountsDO's 'pa:' counter, locked like a pair from any network): a stolen
 * session cannot guess the old password at the network caps' rate, and that lock never touches the
 * owner's sign-in.
 */
type PasswordChecker = { signIn: true } | { account: string };

const BAD_CREDENTIALS = 'Usuario o contraseña incorrectos';
const BAD_EMAIL_CREDENTIALS = 'Correo o contraseña incorrectos';

/**
 * Look the user up and check the proof against its stored password. Every refusal is the same 401
 * bad_credentials after the same server stage (an unknown username, a wrong password, an account
 * without a password or without the key the proof lacks: nothing tells an OAuth-only account
 * apart, audit auth-5). `legacyOnly`: the username sign-in and its recovery, which refuse an
 * account with a verified email (it signs in by email: the design's downgrade rule (a)).
 */
async function checkPassword(c: RouteContext, subject: string | { email: string }, proof: PasswordProof, who: PasswordChecker, legacyOnly = false): Promise<{ ok: true; cred: Credentials } | { ok: false; res: Response }> {
  // The email sign-in (sign-in PR 7) names the account by the typed address (the AccountsDO derives
  // its canon and counts it as the legacy path counts the username); the legacy paths by its name.
  const named = typeof subject === 'string' ? { username: subject } : { email: subject.email };
  const username = typeof subject === 'string' ? subject : '';
  const refusal = typeof subject === 'string' ? BAD_CREDENTIALS : BAD_EMAIL_CREDENTIALS;
  // A sign-in also says whether this browser signed in to the account before (its device cookie).
  const as = 'account' in who ? { account: who.account } : { device: await deviceOf(c.env, c.request) };
  // `charge`: this check counts as a failure as it starts, in the step that tests the locks, so a
  // burst of requests in flight at once gets no more checks than the counters let through; a
  // success gives it back (`charged` at the finish).
  const begin = await accountsJson<{ found: boolean } & Partial<Credentials>>(c.env, '/auth-begin', { ...named, ip: ipOf(c.request), ...as, charge: true });
  if (!begin.ok) return { ok: false, res: pass(begin.res) };
  const failed = async (): Promise<{ ok: false; res: Response }> => {
    // Counted at the begin already; an AccountsDO of before (the minutes of a deploy) counts it here.
    await accountsCall(c.env, '/auth-finish', { ...named, ip: ipOf(c.request), ok: false, charged: true, ...as });
    return { ok: false, res: error(401, 'bad_credentials', refusal) };
  };
  // An unknown username, and an account with a verified email at the username routes (it signs in by
  // email): its password is never checked here, so neither the answer nor the time says whether it
  // was right. The stages of an account without a password: the same time as any refusal.
  const cred = begin.data as Credentials;
  if (!begin.data.found || (legacyOnly && cred.emailVerified)) {
    await provePassword(c.env, { userId: '', username, banned: false, pwV: 0, emailVerified: false }, proof);
    return failed();
  }
  if (!(await provePassword(c.env, cred, proof))) return failed();
  if (cred.banned) return { ok: false, res: error(403, 'banned', 'Cuenta suspendida') };
  // A session's own check proved the password: its charge goes back now (a sign-in's at its finish).
  if ('account' in who) await accountsCall(c.env, '/auth-finish', { ...named, ip: ipOf(c.request), ok: true, charged: true, ...as });
  return { ok: true, cred };
}

/**
 * POST /api/auth/login: the legacy sign-in, a username and both keys of the typed password
 * (`password` the legacy key, `passwordV2` the current one) and a solved Turnstile check, every
 * time. A legacy record is checked with the legacy key and re-keyed to the current one in the
 * sign-in's transaction; a current one is checked with `passwordV2`. Level 2, method 'legacy'.
 */
async function login(c: RouteContext): Promise<Response> {
  if (c.limited('login:' + ipOf(c.request), 30)) return error(429, 'rate_limited');
  const b = await readJson<{ username?: unknown; password?: unknown; passwordV2?: unknown; turnstileToken?: unknown }>(c.request);
  const proof = proofOf(b?.password, b?.passwordV2);
  if (!b || typeof b.username !== 'string' || b.username.length > 64 || (proof.v1 === undefined && proof.v2 === undefined)) return error(400, 'bad_request');
  // Before the AccountsDO hears of it (R3): a page from before the check sends no token and reloads.
  const blocked = await c.antiBot(b.turnstileToken);
  if (blocked !== null) return blocked;
  const chk = await checkPassword(c, b.username, proof, { signIn: true }, true);
  if (!chk.ok) return chk.res;
  // This deployment's env, not storeEnv's: an AccountsDO of before ignores a sign-in's `rekey`.
  const rekey = await rekeyFor(c.env, chk.cred, proof);
  const refresh = newRefreshToken();
  const fin = await accountsJson<UserRef>(c.env, '/auth-finish', {
    userId: chk.cred.userId,
    username: b.username,
    ip: ipOf(c.request),
    ok: true,
    refresh: await grantFor(refresh, c.request),
    device: await deviceOf(c.env, c.request),
    proved: chk.cred.hash,
    charged: true,
    ...(rekey !== null ? { rekey } : {}),
  });
  if (!fin.ok) return pass(fin.res);
  return withCookies(json(await accountSession(c.env, fin.data)), [refreshCookie(refresh), await deviceCookie(c.env, fin.data.userId)]);
}

async function refresh(c: RouteContext): Promise<Response> {
  if (!sameOriginOk(c.request, c.originAllowed)) return error(403, 'bad_origin');
  if (c.limited('refresh:' + ipOf(c.request), 60)) return error(429, 'rate_limited');
  const token = cookieOf(c.request, REFRESH_COOKIE);
  if (!token || token.length > 128) return withCookies(error(401, 'no_refresh'), []);
  // What the object answers for a token it does not hold, without asking it.
  if (!REFRESH_TOKEN_RE.test(token)) return withCookies(error(401, 'bad_refresh'), [clearCookie(REFRESH_COOKIE)]);
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
  // The whole family the cookie names goes, even when this copy was rotated meanwhile (a thief's newer chain).
  if (token && REFRESH_TOKEN_RE.test(token)) await accountsCall(c.env, '/logout', { hash: await sha256Hex(token), family: await familyOf(token) });
  return withCookies(json({ ok: true }), [clearCookie(REFRESH_COOKIE)]);
}

/**
 * POST /api/auth/recover: the legacy recovery code, a new password (`passwordV2`, stored as the
 * current key; `password`, the legacy key, only from a page of before it) and a solved Turnstile
 * check, every time. Never for an account with a verified email (AccountsDO answers it as a wrong
 * code). Level 2, method 'reset'.
 */
async function recover(c: RouteContext): Promise<Response> {
  if (c.limited('recover:' + ipOf(c.request), 10)) return error(429, 'rate_limited');
  const b = await readJson<{ username?: unknown; code?: unknown; password?: unknown; passwordV2?: unknown; turnstileToken?: unknown }>(c.request);
  const nk = newKeyOf(b?.passwordV2, b?.password);
  if (!b || typeof b.username !== 'string' || b.username.length > 64 || typeof b.code !== 'string' || b.code.length > 32 || nk === null) return error(400, 'bad_request');
  const blocked = await c.antiBot(b.turnstileToken);
  if (blocked !== null) return blocked;
  // The same counters as a sign-in's, only asked here (no charge): AccountsDO /recover tests and counts them in one step.
  const device = await deviceOf(c.env, c.request);
  const begin = await accountsJson<unknown>(c.env, '/auth-begin', { username: b.username, ip: ipOf(c.request), device });
  if (!begin.ok) return pass(begin.res);
  const refreshTok = newRefreshToken();
  const r = await accountsJson<UserRef & { codesLeft: number }>(c.env, '/recover', {
    username: b.username,
    code: await recoveryCodeHash(b.code),
    pw: await newPasswordRecord(nk.key, nk.v, await storeEnv(c.env)),
    refresh: await grantFor(refreshTok, c.request),
    ip: ipOf(c.request),
    device,
  });
  if (!r.ok) return pass(r.res);
  return withCookies(json({ ...(await accountSession(c.env, r.data)), codesLeft: r.data.codesLeft }), [refreshCookie(refreshTok), await deviceCookie(c.env, r.data.userId)]);
}

/** The session, when it is an account's: 401 without a session, 403 for a guest. Also the /nodes/* operator routes (nodeRoutes.ts). */
export function requireAccount(c: Pick<RouteContext, 'session'>): SessionClaims | Response {
  if (!c.session) return error(401, 'unauthorized');
  if (c.session.acct !== 1) return error(403, 'account_required', 'Necesitas una cuenta (no de invitado)');
  return c.session;
}

/** A credential proof's level (R6): 1 a press on the provider's own page, 2 a typed password. */
export type AuthLevel = 1 | 2;

/** 403 reauth_required, naming the level asked for: PERFIL's "confirm it's you" offers only what reaches it. */
export function reauthRequired(level: AuthLevel): Response {
  return json({ error: 'reauth_required', message: 'Confirma que eres tú: vuelve a entrar con tu cuenta', level }, 403);
}

/**
 * fresh(level) of the sign-in design's R6: an account's session, not a TV's, whose device proved a
 * credential (a sign-in or a re-authentication: the aat claim) within `windowS`, at `level` or above
 * (the aal claim; none = 0, so a TV, a silent provider sign-in and a family from before levels are
 * never fresh). Otherwise 403 reauth_required { level }, and PERFIL asks the player to confirm it is
 * them first. A route that needs level 2 of an account that cannot reach it (no password) asks for
 * level 1 instead: the AccountsDO knows the ceiling (accountStore.ts ceilingOf).
 */
export function requireFresh(c: Pick<RouteContext, 'session'>, level: AuthLevel, windowS: number = REAUTH_WINDOW_S, nowS: number = nowSeconds()): SessionClaims | Response {
  const s = requirePrimary(c);
  if (s instanceof Response) return s;
  if (typeof s.aat !== 'number' || nowS - s.aat > windowS || s.aat > nowS + 60 || (s.aal ?? 0) < level) return reauthRequired(level);
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

/**
 * POST /api/me/username { username, lang? }: a full Bearer, nothing more (design §2.15, §5.3): the
 * name salts no password any more. An account whose password is still the legacy key (salted with
 * the name it has) is asked to confirm it is them first, 403 reauth_required { level: 2 }: the
 * client's "confirm it's you" with its password re-keys it (POST /api/auth/reauth), then it renames.
 * A taken name or a look-alike of a protected account is 409 with a free `suggest`.
 */
async function rename(c: RouteContext): Promise<Response> {
  const s = requirePrimary(c);
  if (s instanceof Response) return s;
  if (c.limited('rename:' + s.sub, 5)) return error(429, 'rate_limited');
  const b = await readJson<{ username?: unknown; lang?: unknown }>(c.request);
  const problem = usernameProblem(b?.username);
  if (problem !== null) return error(400, 'bad_username', problem);
  const me = await accountsJson<{ name: string; legacy?: boolean }>(c.env, '/me?userId=' + encodeURIComponent(s.sub));
  if (!me.ok) return pass(me.res);
  if (me.data.legacy === true) return reauthRequired(2);
  const r = await accountsJson<UserRef>(c.env, '/rename', { userId: s.sub, username: b?.username, lang: langOf(b?.lang) });
  if (!r.ok) return pass(r.res);
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

/** MeInfo's fields a TV's session never gets (the design's §3.11): the account's address and a provider's. */
const TV_HIDDEN = ['email', 'emailHint'] as const;

async function me(c: RouteContext): Promise<Response> {
  const s = requireAccount(c);
  if (s instanceof Response) return s;
  const r = await accountsCall(c.env, '/me?userId=' + encodeURIComponent(s.sub));
  if (s.tv === 1 && r.ok) {
    // A TV plays as the account in a living room: its screen shows no address.
    const info = (await r.json()) as Record<string, unknown>;
    for (const k of TV_HIDDEN) delete info[k];
    return json(info, 200, { 'cache-control': 'no-store' });
  }
  const out = pass(r);
  out.headers.set('cache-control', 'no-store');
  return out;
}

const boardCache = new Map<string, { at: number; data: LeaderboardAnswer }>();
const BOARD_TTL_MS = 30_000;
/** An account's own row ('you'), per playlist and account, this long per isolate: the board around it is cached 30 s. */
export const YOU_TTL_MS = 15_000;
const YOU_CACHE_MAX = 10_000;
const youCache = new Map<string, { at: number; you: LeaderboardAnswer['you'] }>();

/** The cached 'you' of `key`, or undefined when there is none fresh. */
function cachedYou(key: string, now: number): LeaderboardAnswer['you'] | undefined {
  const e = youCache.get(key);
  return e && now - e.at <= YOU_TTL_MS ? e.you : undefined;
}

function keepYou(key: string, now: number, you: LeaderboardAnswer['you']): void {
  youCache.delete(key);
  if (youCache.size >= YOU_CACHE_MAX) youCache.delete(youCache.keys().next().value as string);
  youCache.set(key, { at: now, you });
}

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
    const key = playlist + ':' + c.session.sub;
    const hit = cachedYou(key, now);
    if (hit !== undefined) you = hit;
    else {
      const r = await accountsJson<LeaderboardAnswer>(c.env, `/leaderboard?playlist=${playlist}&limit=1&userId=${c.session.sub}`);
      if (r.ok) {
        you = r.data.you;
        keepYou(key, now, you);
      }
    }
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
  /**
   * The level the identity proves (R6), from the prompt this start asked for: 1 for Google's
   * account chooser and Discord's Authorize (prompt=consent). Absent (a state from before levels): 0.
   */
  lvl?: 1;
  exp: number;
}

/** The provider's prompt for a start, and the level a press on it proves (R6): a person must press there, script on our origin cannot. */
const OAUTH_PROMPT: Readonly<Record<OAuthProvider, { prompt: string; lvl: 1 }>> = {
  google: { prompt: 'select_account', lvl: 1 },
  discord: { prompt: 'consent', lvl: 1 },
};

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
    // A link adds a way in: fresh(1) (R6), so a silent sign-in, a refresh of before levels or a TV never links.
    if (mode === 'link' && (authAt <= 0 || Date.now() - authAt > REAUTH_WINDOW_S * 1000 || (r.data.authLvl ?? 0) < 1)) return redirect('/#auth=error:reauth_required');
    if (mode === 'link') link = r.data.userId;
    else re = r.data.userId;
    dev = r.data.device;
  }
  const verifier = base64urlEncode(randomBytes(32));
  const challenge = base64urlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(verifier))));
  const nonce = base64urlEncode(randomBytes(16));
  const asked = OAUTH_PROMPT[provider];
  const state: OAuthState = { typ: 'oa', p: provider, v: verifier, n: nonce, link, ...(re !== undefined ? { re } : {}), ...(dev !== undefined ? { dev } : {}), lvl: asked.lvl, exp: nowSeconds() + OAUTH_TTL_S };
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
  // Every start (a sign-in, a link, "confirm it's you") asks for a press on the provider's page:
  // Discord's prompt=consent never lets an earlier authorization answer silently (level 1, not 0).
  q.set('prompt', asked.prompt);
  return redirect(`${cfg.authorize}?${q.toString()}`, [cookie]);
}

/** Code -> provider identity { id, name } (token exchange + user endpoint). `fetchFn` for tests. */
export async function oauthIdentity(cfg: ProviderConfig, provider: OAuthProvider, code: string, verifier: string, redirectUri: string, fetchFn: typeof fetch = fetch): Promise<{ id: string; name: string } | null> {
  const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier, client_id: cfg.clientId, client_secret: cfg.clientSecret });
  const tr = await fetchFn(cfg.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form });
  if (!tr.ok) {
    // The status only: nothing of a provider's answer reaches a log line (the design's §1.5 guard 2).
    console.warn(`oauth ${provider}: token ${tr.status}`);
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

/**
 * A state cookie is good for one callback (limits.ts firstUse, for the state's whole life): a
 * replay of it is refused before our client secret goes to the provider again. The callback's
 * per-network limit is index.ts's (limits.ts accountGate).
 */
function oauthStateUnused(c: RouteContext, st: OAuthState): Promise<boolean> {
  return firstUse('oauth-state', st.n, OAUTH_TTL_S * 1000, new URL(c.request.url).origin);
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
  if (!(await oauthStateUnused(c, st))) return fail('bad_state');
  const ident = await oauthIdentity(cfg, provider, code, st.v, `${publicOrigin(c.env, c.request)}/api/auth/oauth/${provider}/callback`);
  if (!ident) return fail('provider_error');
  const refreshTok = newRefreshToken();
  const refresh = await grantFor(refreshTok, c.request);
  // The level the start's prompt proves (R6); a state from before levels proves none.
  const lvl = st.lvl === 1 ? 1 : 0;
  if (typeof st.re === 'string') {
    const r = await accountsJson<UserRef>(c.env, '/oauth-reauth', { provider, providerId: ident.id, userId: st.re, refresh, replace: st.dev, lvl });
    if (!r.ok) return fail(await codeOf(r.res, 'account_error'));
    return redirect('/#auth=reauth', [clearCookie(OAUTH_COOKIE, 'Lax'), refreshCookie(refreshTok)]);
  }
  const r = await accountsJson<UserRef & { created: boolean }>(c.env, '/oauth', { provider, providerId: ident.id, name: ident.name, linkTo: st.link, refresh, lvl, ...(st.link !== null ? { replace: st.dev } : {}) });
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
 * POST /api/auth/reauth { legacy, password }: a password account confirms it is them (PERFIL, before
 * a link, an unlink or a maintainer's work), with no time limit (it is "confirm it's you", not a way
 * in). `password` is the current key and `legacy` the legacy one: a legacy record is checked with
 * `legacy` and re-keyed to `password` in the same transaction; a current one is checked with
 * `password`. Without `legacy` (a page of before it), `password` is checked as the record's own
 * key and nothing is re-keyed. The failures count per account (AccountsDO 'pa:'). Then this
 * browser's token proves a credential now at level 2 and the session says so (aat, aal).
 */
async function reauth(c: RouteContext): Promise<Response> {
  const s = requirePrimary(c);
  if (s instanceof Response) return s;
  if (c.limited('reauth:' + s.sub, 10)) return error(429, 'rate_limited');
  const b = await readJson<{ password?: unknown; legacy?: unknown }>(c.request);
  if (!b || !isClientKey(b.password)) return error(400, 'bad_request');
  const token = cookieOf(c.request, REFRESH_COOKIE);
  if (!token || token.length > 128) return error(401, 'no_refresh');
  const me = await accountsJson<{ name: string; hasPassword: boolean }>(c.env, '/me?userId=' + s.sub);
  if (!me.ok) return pass(me.res);
  if (!me.data.hasPassword) return error(400, 'no_password', 'Esta cuenta entra con Google o Discord');
  const both = isClientKey(b.legacy);
  const proof: PasswordProof = both ? { v1: b.legacy as string, v2: b.password } : { v1: b.password, v2: b.password };
  const chk = await checkPassword(c, me.data.name, proof, { account: s.sub });
  if (!chk.ok) return chk.res;
  if (chk.cred.userId !== s.sub) return error(401, 'bad_credentials', BAD_CREDENTIALS);
  // Only a proof that carried both keys can re-key: alone, `password` may be a page's legacy key.
  const rekey = await rekeyFor(c.env, chk.cred, both ? proof : pwVOf(chk.cred) === 2 ? { v2: b.password } : { v1: b.password });
  const r = await accountsJson<UserRef>(c.env, '/reauth', { userId: s.sub, hash: await sha256Hex(token), proved: chk.cred.hash, ...(rekey !== null ? { rekey } : {}) });
  if (!r.ok) return pass(r.res);
  return json(await accountSession(c.env, r.data), 200, { 'cache-control': 'no-store' });
}

/**
 * POST /api/auth/unlink { provider }: one provider off the account, never its last way in. It needs
 * fresh(1); leaving exactly one way in needs fresh(2), capped by the account's ceiling, which the
 * AccountsDO decides (403 reauth_required { level: 2 }).
 */
async function unlink(c: RouteContext): Promise<Response> {
  const s = requireFresh(c, 1);
  if (s instanceof Response) return s;
  if (c.limited('unlink:' + s.sub, 10)) return error(429, 'rate_limited');
  const b = await readJson<{ provider?: unknown }>(c.request);
  if (!b || !OAUTH_PROVIDERS.includes(b.provider as OAuthProvider)) return error(400, 'bad_request');
  return noStore(await accountsCall(c.env, '/unlink', { userId: s.sub, provider: b.provider, level: s.aal ?? 0 }));
}

// ---- email accounts (sign-in PR 7: the design's sections 2.2 to 2.5) -----------------------------
//
//   POST /api/auth/signup/start   { email, lang?, turnstileToken }          -> { attempt, resendAt, codeLength: 6 }
//                                 (the same for any address: M1, M1 "hint" or M2 goes to the mailbox) | 400
//                                 bad_email | 403 turnstile_failed | 429 rate_limited / email_rate_limited
//                                 { retryAfterMs } | 503 email_paused / email_unconfigured
//   POST /api/auth/signup/check   { attempt, code } | { token }             -> { email } | 400 code_wrong { triesLeft }
//                                 | 410 code_expired / link_invalid | 409 already_created { email }; consumes nothing
//   POST /api/auth/signup/finish  { attempt, code } | { token }, { username, password, news?, lang?, tz?,
//                                 acceptTerms? } -> AccountSession + refresh and device cookies (level 2, method
//                                 'password') | 400 bad_username / bad_password / name_reserved { suggest } | 409
//                                 username_taken / name_lookalike { suggest }, email_taken, already_created { email }
//                                 | 410 | 429
//   POST /api/auth/code/resend    { attempt } (a reauth code: its account's Bearer) -> { resendAt, resendsLeft }:
//                                 the same code and link again | 410 code_expired | 429 email_rate_limited | 503
//
// `attempt` is 32 random bytes only the starting browser holds (sessionStorage, 30 minutes): a code
// works only with it. Tokens and codes travel in bodies only, never a query (R8, I5). The Worker
// derives the address and its canon from what was typed (I9); a body's canon, trust or verified
// field is never read. Mail goes out after the answer (R7), through mail.ts, whose stub captures
// everything off production: live mail needs MAIL_LIVE=1 on a host that is not loopback.

/** The request's language for its mail (the account's wins once it has one). */
function langOf(v: unknown): 'es' | 'en' | undefined {
  return v === 'es' || v === 'en' ? v : undefined;
}

const NO_STORE = { 'cache-control': 'no-store' };

/**
 * The email routes' 503 before anything is counted: the kill flag (KV email_off) is set
 * (email_paused), or this deployment cannot deliver: no link origin (MAIL_LINK_ORIGIN off
 * loopback) or a deploy whose mailer is the stub (MAIL_LIVE unset): email_unconfigured. The same
 * for every address. /api/config's auth.email says it beforehand (mail.ts emailAvailable).
 */
async function mailRefusal(c: RouteContext): Promise<Response | null> {
  if (await mailKilled(c.env)) return error(503, 'email_paused', 'Ahora no podemos enviar correos. Inténtalo en unos minutos.');
  const deliverable = c.mailer !== undefined && (c.mailer.live || isLocalDev(c.request));
  if (linkOrigin(c.request, c.env) === null || !deliverable) return error(503, 'email_unconfigured', 'Este servidor todavía no envía correos');
  return null;
}

/**
 * Send what the AccountsDO ordered, once this request has answered (R7: waitUntil; without a
 * context, the node tests, it runs all the same). Every URL comes from linkOrigin, never from the
 * request's Host. A failed send logs its kind and lane only (mail.ts deliver) and counts in its lane
 * (/mail-failed), which may pause the signup lane or raise an alert line.
 */
function sendMail(c: RouteContext, order: MailOrder | null | undefined): void {
  if (!order) return;
  const origin = linkOrigin(c.request, c.env);
  const mailer = c.mailer;
  if (origin === null || mailer === undefined) return;
  let msg: MailMessage;
  try {
    msg = composeMail(order.to, renderMail(order.data, { origin, lang: order.lang, ...(order.tz ? { tz: order.tz } : {}) }));
  } catch {
    console.warn(`mail_failed kind=${order.data.kind} err=render`);
    return;
  }
  const sent = deliver(mailer, msg, async (kind, lane) => {
    const r = await accountsJson<{ alert?: boolean }>(c.env, '/mail-failed', { kind, lane });
    if (r.ok && r.data.alert === true) console.warn(`ALERT mail_failures lane=${lane}: ${FAILURES.failures} failed sends in 10 minutes`);
  });
  if (c.waitUntil) c.waitUntil(sent);
  else void sent;
}

/** A proof in a body: a link's token, or an attempt and its code (a pasted code's spaces and dashes dropped). */
function proofBody(b: { attempt?: unknown; code?: unknown; token?: unknown } | null): { token: string } | { attempt: string; code: string } | null {
  if (!b) return null;
  if (typeof b.token === 'string') return b.token.length <= 128 ? { token: b.token } : null;
  if (typeof b.attempt !== 'string' || b.attempt.length > 64 || (typeof b.code !== 'string' && typeof b.code !== 'number')) return null;
  const code = String(b.code).replace(/[\s-]/g, '');
  return code.length <= 16 ? { attempt: b.attempt, code } : null;
}

/** POST /api/auth/signup/start: the address checked, then the anti-bot check, then the AccountsDO's caps and row. */
async function signupStart(c: RouteContext): Promise<Response> {
  const b = await readJson<{ email?: unknown; lang?: unknown; turnstileToken?: unknown }>(c.request);
  if (!b) return error(400, 'bad_request');
  if (normalizeEmail(b.email) === null) return error(400, 'bad_email', 'Revisa el correo: no parece una dirección válida');
  const off = await mailRefusal(c);
  if (off !== null) return off;
  const blocked = await c.antiBot(b.turnstileToken);
  if (blocked !== null) return blocked;
  const attempt = base64urlEncode(randomBytes(32));
  const r = await accountsJson<{ resendAt: number; codeLength: number; mail?: MailOrder | null }>(c.env, '/signup-start', { email: b.email, lang: langOf(b.lang), attempt, ip: ipOf(c.request) });
  if (!r.ok) return noStore(r.res);
  sendMail(c, r.data.mail);
  return json({ attempt, resendAt: r.data.resendAt, codeLength: 6 } satisfies CodeStartAnswer, 200, NO_STORE);
}

/** POST /api/auth/signup/check: the client asks at the sixth digit, so a wrong code shows at once. */
async function signupCheck(c: RouteContext): Promise<Response> {
  const proof = proofBody(await readJson<{ attempt?: unknown; code?: unknown; token?: unknown }>(c.request));
  if (proof === null) return error(400, 'bad_request');
  return noStore(await accountsCall(c.env, '/signup-check', proof));
}

/**
 * POST /api/auth/signup/finish: the proof checked first (a cheap AccountsDO call: a junk finish
 * costs no PBKDF2), then the password's server stage, then the account in one transaction there.
 */
async function signupFinish(c: RouteContext): Promise<Response> {
  const b = await readJson<{ attempt?: unknown; code?: unknown; token?: unknown; username?: unknown; password?: unknown; news?: unknown; lang?: unknown; tz?: unknown; acceptTerms?: unknown }>(c.request);
  const proof = proofBody(b);
  if (!b || proof === null) return error(400, 'bad_request');
  if (typeof b.username !== 'string' || b.username.length > 64) return error(400, 'bad_username', usernameProblem(b.username) ?? 'Elige un nombre de usuario');
  if (!isClientKey(b.password)) return error(400, 'bad_password', 'Contraseña inválida');
  const pre = await accountsCall(c.env, '/signup-check', proof);
  if (!pre.ok) return noStore(pre);
  await pre.text().catch(() => '');
  const refreshTok = newRefreshToken();
  const r = await accountsJson<UserRef>(c.env, '/signup-finish', {
    ...proof,
    username: b.username,
    pw: await newPasswordRecord(b.password, 2, await storeEnv(c.env)),
    news: b.news === true,
    lang: langOf(b.lang),
    tz: b.tz,
    terms: b.acceptTerms,
    refresh: await grantFor(refreshTok, c.request),
    ip: ipOf(c.request),
  });
  if (!r.ok) return noStore(r.res);
  return withCookies(json(await accountSession(c.env, r.data)), [refreshCookie(refreshTok), await deviceCookie(c.env, r.data.userId)]);
}

/**
 * POST /api/auth/code/resend { attempt }: a sign-up's needs nothing more (the attempt id is the
 * browser's); an account's own code (reauth) only its full Bearer, which the AccountsDO matches to
 * the row's account.
 */
async function codeResend(c: RouteContext): Promise<Response> {
  const b = await readJson<{ attempt?: unknown }>(c.request);
  if (!b || typeof b.attempt !== 'string' || b.attempt.length > 64) return error(400, 'bad_request');
  const off = await mailRefusal(c);
  if (off !== null) return off;
  const s = c.session;
  const userId = s !== null && s.acct === 1 && s.tv !== 1 ? s.sub : undefined;
  const r = await accountsJson<{ resendAt: number; resendsLeft: number; mail?: MailOrder | null }>(c.env, '/code-resend', { attempt: b.attempt, ip: ipOf(c.request), ...(userId !== undefined ? { userId } : {}) });
  if (!r.ok) return noStore(r.res);
  sendMail(c, r.data.mail);
  return json({ resendAt: r.data.resendAt, resendsLeft: r.data.resendsLeft } satisfies CodeResendAnswer, 200, NO_STORE);
}

//   POST /api/auth/signin         { email, password, turnstileToken }        -> AccountSession + refresh and device
//                                 cookies (level 2, method 'password') | 401 bad_credentials (an unknown address, a
//                                 wrong password, no current password, a legacy one not re-keyed: one answer, one
//                                 server stage) | 403 turnstile_failed / banned (after the right password) | 429
//                                 throttled { retryAfterMs }
//   POST /api/auth/forgot         { email, lang?, turnstileToken }           -> { ok: true } always (M3 only to an account
//                                 that claimed that address) | 403 | 429 | 503
//   POST /api/auth/reset/peek     { token }                                  -> { name, email, hasPassword } | 410 link_invalid
//   POST /api/auth/reset          { token, password }                        -> AccountSession + cookies (level 2, method
//                                 'reset'; every other device signed out; M4) | 400 bad_password | 410 | 403 banned
//   POST /api/me/password         Bearer + cookie { current | legacy, password } -> { ok } (the other devices signed out;
//                                 M4) | 401 bad_credentials | 409 no_password | 429 throttled (per account, 'pa:')
//   POST /api/me/password/link    Bearer {}                                  -> { sentTo }: a reset link to the account's own
//                                 address (M3 "create" without a password) | 409 email_required | 429 | 503
//   POST /api/auth/reauth/code    Bearer {}                                  -> { attempt, resendAt, to }: M11 | 409
//                                 email_required | 403 password_required (a maintainer confirms with its password)
//   POST /api/auth/reauth/code/verify Bearer + cookie { attempt, code }      -> AccountSession (level 2) | 400 | 410
//   POST /api/auth/register, /api/auth/recovery-codes, /api/auth/password    -> 410 gone (P6, auth-3: a Bearer alone never
//                                 adds a way in, I4)

/** POST /api/auth/signin: the email sign-in. Its throttles are the legacy sign-in's (AccountsDO.ts THROTTLE_RULES), keyed by the typed canon. */
async function signin(c: RouteContext): Promise<Response> {
  const b = await readJson<{ email?: unknown; password?: unknown; turnstileToken?: unknown }>(c.request);
  if (!b || typeof b.email !== 'string' || b.email.length > 254 || !isClientKey(b.password)) return error(400, 'bad_request');
  if (normalizeEmail(b.email) === null) return error(400, 'bad_email', 'Revisa el correo: no parece una dirección válida');
  const blocked = await c.antiBot(b.turnstileToken);
  if (blocked !== null) return blocked;
  // Only the current key: an account whose password is still the legacy one signs in by its username (and re-keys there).
  const proof: PasswordProof = { v2: b.password };
  const chk = await checkPassword(c, { email: b.email }, proof, { signIn: true });
  if (!chk.ok) return chk.res;
  const rekey = await rekeyFor(c.env, chk.cred, proof);
  const refreshTok = newRefreshToken();
  const fin = await accountsJson<UserRef>(c.env, '/auth-finish', {
    userId: chk.cred.userId,
    email: b.email,
    ip: ipOf(c.request),
    ok: true,
    refresh: await grantFor(refreshTok, c.request),
    device: await deviceOf(c.env, c.request),
    proved: chk.cred.hash,
    charged: true,
    ...(rekey !== null ? { rekey } : {}),
  });
  if (!fin.ok) return pass(fin.res);
  return withCookies(json(await accountSession(c.env, fin.data)), [refreshCookie(refreshTok), await deviceCookie(c.env, fin.data.userId)]);
}

/** POST /api/auth/forgot: always { ok: true } (I6); the mail, when there is one, after the answer. */
async function forgot(c: RouteContext): Promise<Response> {
  const b = await readJson<{ email?: unknown; lang?: unknown; turnstileToken?: unknown }>(c.request);
  if (!b) return error(400, 'bad_request');
  if (normalizeEmail(b.email) === null) return error(400, 'bad_email', 'Revisa el correo: no parece una dirección válida');
  const off = await mailRefusal(c);
  if (off !== null) return off;
  const blocked = await c.antiBot(b.turnstileToken);
  if (blocked !== null) return blocked;
  const r = await accountsJson<{ mail?: MailOrder | null }>(c.env, '/forgot', { email: b.email, lang: langOf(b.lang), ip: ipOf(c.request) });
  if (!r.ok) return noStore(r.res);
  sendMail(c, r.data.mail);
  return json({ ok: true }, 200, NO_STORE);
}

/** A reset link's token from a body (the 43 base64url of a mail; the AccountsDO answers anything else as link_invalid). */
function tokenOf(b: { token?: unknown } | null): string | null {
  return b && typeof b.token === 'string' && b.token.length <= 128 ? b.token : null;
}

/** POST /api/auth/reset/peek: who the link is for, before the password sheet. Consumes nothing. */
async function resetPeek(c: RouteContext): Promise<Response> {
  const token = tokenOf(await readJson<{ token?: unknown }>(c.request));
  if (token === null) return error(400, 'bad_request');
  return noStore(await accountsCall(c.env, '/reset-peek', { token }));
}

/** POST /api/auth/reset: the link checked first (a dead one costs no PBKDF2), then the password stored and this browser signed in. */
async function reset(c: RouteContext): Promise<Response> {
  const b = await readJson<{ token?: unknown; password?: unknown; lang?: unknown }>(c.request);
  const token = tokenOf(b);
  if (!b || token === null) return error(400, 'bad_request');
  if (!isClientKey(b.password)) return error(400, 'bad_password', 'Contraseña inválida');
  const peek = await accountsCall(c.env, '/reset-peek', { token });
  if (!peek.ok) return noStore(peek);
  await peek.text().catch(() => '');
  const refreshTok = newRefreshToken();
  const r = await accountsJson<UserRef & { mail?: MailOrder | null }>(c.env, '/reset', { token, pw: await newPasswordRecord(b.password, 2, await storeEnv(c.env)), refresh: await grantFor(refreshTok, c.request), ip: ipOf(c.request), lang: langOf(b.lang) });
  if (!r.ok) return noStore(r.res);
  sendMail(c, r.data.mail);
  const { mail: _mail, ...ref } = r.data;
  return withCookies(json(await accountSession(c.env, ref)), [refreshCookie(refreshTok), await deviceCookie(c.env, ref.userId)]);
}

/**
 * POST /api/me/password { current | legacy, password }: the current password itself proves it (no
 * freshness), by the key its record holds (`legacy` for pw_v 1, `current` for 2; both may come),
 * counted per account ('pa:'). The new one is always the current key. This device stays signed in.
 */
async function mePassword(c: RouteContext): Promise<Response> {
  const s = requirePrimary(c);
  if (s instanceof Response) return s;
  const b = await readJson<{ current?: unknown; legacy?: unknown; password?: unknown; lang?: unknown }>(c.request);
  if (!b) return error(400, 'bad_request');
  if (!isClientKey(b.password)) return error(400, 'bad_password', 'Contraseña inválida');
  const token = cookieOf(c.request, REFRESH_COOKIE);
  if (!token || token.length > 128) return error(401, 'no_refresh');
  const me = await accountsJson<{ name: string; hasPassword: boolean }>(c.env, '/me?userId=' + encodeURIComponent(s.sub));
  if (!me.ok) return pass(me.res);
  if (!me.data.hasPassword) return error(409, 'no_password', 'Esta cuenta no tiene contraseña: créala con un enlace a tu correo');
  const proof = proofOf(b.legacy, b.current);
  if (proof.v1 === undefined && proof.v2 === undefined) return error(400, 'bad_request');
  const chk = await checkPassword(c, me.data.name, proof, { account: s.sub });
  if (!chk.ok) return chk.res;
  if (chk.cred.userId !== s.sub || chk.cred.hash === undefined) return error(401, 'bad_credentials', BAD_CREDENTIALS);
  const r = await accountsJson<{ mail?: MailOrder | null }>(c.env, '/me-password', { userId: s.sub, pw: await newPasswordRecord(b.password, 2, await storeEnv(c.env)), keep: await sha256Hex(token), proved: chk.cred.hash, lang: langOf(b.lang) });
  if (!r.ok) return noStore(r.res);
  sendMail(c, r.data.mail);
  return json({ ok: true }, 200, NO_STORE);
}

/** POST /api/me/password/link: a link to the account's own mailbox; the Bearer itself never sets a password (I4). */
async function mePasswordLink(c: RouteContext): Promise<Response> {
  const s = requirePrimary(c);
  if (s instanceof Response) return s;
  const b = await readJson<{ lang?: unknown }>(c.request);
  if (!b) return error(400, 'bad_request');
  const off = await mailRefusal(c);
  if (off !== null) return off;
  const r = await accountsJson<{ sentTo: string; mail?: MailOrder | null }>(c.env, '/password-link', { userId: s.sub, lang: langOf(b.lang) });
  if (!r.ok) return noStore(r.res);
  sendMail(c, r.data.mail);
  return json({ sentTo: r.data.sentTo } satisfies PasswordLinkAnswer, 200, NO_STORE);
}

/**
 * POST /api/auth/reauth/code: "confirm it's you" by a code from the account's own mailbox (level 2,
 * R6). The project's maintainer accounts (NODE_TRUSTED_OPERATORS) confirm with their password
 * instead: the maintainer routes' level 2 comes from a typed password (design §3.12).
 */
async function reauthCode(c: RouteContext): Promise<Response> {
  const s = requirePrimary(c);
  if (s instanceof Response) return s;
  const b = await readJson<{ lang?: unknown }>(c.request);
  if (!b) return error(400, 'bad_request');
  if (trustedOperatorIds(c.env).has(s.sub)) return error(403, 'password_required', 'Esta cuenta confirma que eres tú con su contraseña');
  const off = await mailRefusal(c);
  if (off !== null) return off;
  const attempt = base64urlEncode(randomBytes(32));
  const r = await accountsJson<{ resendAt: number; to: string; mail?: MailOrder | null }>(c.env, '/reauth-code', { userId: s.sub, attempt, lang: langOf(b.lang) });
  if (!r.ok) return noStore(r.res);
  sendMail(c, r.data.mail);
  return json({ attempt, resendAt: r.data.resendAt, to: r.data.to } satisfies CodeStartAnswer, 200, NO_STORE);
}

/** POST /api/auth/reauth/code/verify: the code proves the mailbox; this browser's token moves to level 2 now. */
async function reauthCodeVerify(c: RouteContext): Promise<Response> {
  const s = requirePrimary(c);
  if (s instanceof Response) return s;
  const proof = proofBody(await readJson<{ attempt?: unknown; code?: unknown }>(c.request));
  if (proof === null || 'token' in proof) return error(400, 'bad_request');
  const token = cookieOf(c.request, REFRESH_COOKIE);
  if (!token || token.length > 128) return error(401, 'no_refresh');
  const r = await accountsJson<UserRef>(c.env, '/reauth-code-verify', { userId: s.sub, attempt: proof.attempt, code: proof.code, hash: await sha256Hex(token) });
  if (!r.ok) return noStore(r.res);
  return json(await accountSession(c.env, r.data), 200, NO_STORE);
}

/** The routes sign-in PR 7 retires (design §2.15): a page of before is told to reload. */
function gone(path: string): Response {
  const message = path === '/api/auth/register' ? 'Actualiza la página: ahora las cuentas se crean con un correo.' : 'Actualiza la página: esto ahora se hace desde PERFIL con tu correo.';
  return error(410, 'gone', message);
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
    if (p === '/api/auth/register' || p === '/api/auth/recovery-codes' || p === '/api/auth/password') return gone(p);
    if (p === '/api/auth/login') return login(c);
    if (p === '/api/auth/refresh') return refresh(c);
    if (p === '/api/auth/logout') return logout(c);
    if (p === '/api/auth/recover') return recover(c);
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
    // The email accounts (sign-in PR 7).
    if (p === '/api/auth/signup/start') return signupStart(c);
    if (p === '/api/auth/signup/check') return signupCheck(c);
    if (p === '/api/auth/signup/finish') return signupFinish(c);
    if (p === '/api/auth/code/resend') return codeResend(c);
    if (p === '/api/auth/signin') return signin(c);
    if (p === '/api/auth/forgot') return forgot(c);
    if (p === '/api/auth/reset/peek') return resetPeek(c);
    if (p === '/api/auth/reset') return reset(c);
    if (p === '/api/me/password') return mePassword(c);
    if (p === '/api/me/password/link') return mePasswordLink(c);
    if (p === '/api/auth/reauth/code') return reauthCode(c);
    if (p === '/api/auth/reauth/code/verify') return reauthCodeVerify(c);
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
