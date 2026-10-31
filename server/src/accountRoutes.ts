/**
 * Worker routes for registered accounts (the guest flow stays in index.ts):
 *
 *   The email accounts (sign-in PR 7: signup/*, code/resend, signin, forgot, reset/*, reauth/code*,
 *   /api/me/password and its link) are listed with their section below ("email accounts").
 *   POST /api/auth/register, /api/auth/recovery-codes, /api/auth/password -> 410 gone (sign-in PR 7):
 *                             accounts are made by email, and a Bearer alone never adds a way in (I4)
 *   POST /api/auth/login      { username, password, passwordV2, turnstileToken, linkPending?, cancelDeletion? } ->
 *                             AccountSession + refresh cookie (level 2; with linkPending & { linked } | { linkError }:
 *                             the identity pending in this browser linked, or why not) | 401 bad_credentials for every
 *                             refusal (an account with a verified email too: it signs in by email) | 403
 *                             turnstile_failed | 409 deletion_pending { purgeAt } (the right password; cancelDeletion
 *                             calls the deletion off, sign-in PR 12) | 429 throttled { retryAfterMs }
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
 *                             (salted with the name: "confirm it's you" re-keys it first), and without fresh(2)
 *                             for a password that signs in by the username (no verified email). Not from a TV.
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
 *   GET  /api/me/replay-name  Bearer (account)                  -> { hidden }: PERFIL's "hide my name in public replays"
 *   POST /api/me/replay-name  Bearer (account) { hidden }       -> { hidden } (default off); 30 a minute per account
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
 *   GET  /api/auth/oauth/:provider/start[?link=1 | ?reauth=1[&then=link:<p>] | ?pend=1 | ?cancelDel=1] -> 302 to Google /
 *                             Discord (state + PKCE; scopes: the id and the address, never a name; cancelDel: an
 *                             account whose deletion is pending signs in and calls it off, else its callback is
 *                             /#auth=error:deletion_pending, sign-in PR 12)
 *   GET  /api/auth/oauth/:provider/callback?code&state          -> 302 to /#auth=ok | linked | reauth | confirm |
 *                             ok:<linkError> | error:<code>
 *     The callback never creates an account (the sign-in design's I3): an identity nobody owns goes
 *     into the pending cookie `__Host-tg_pend` (JWT typ 'pend': { p, id, email, trust, p2? }, HttpOnly,
 *     SameSite=Lax, 30 minutes) and /#auth=confirm asks "do you already have a Turbogol account?":
 *   POST /api/auth/pending    {} (pending cookie)                 -> { provider, email, trust, second, match } | 404 no_pending
 *   POST /api/auth/pending/create { username, news, lang, tz, turnstileToken } (pending cookie) -> AccountSession +
 *                             refresh cookie | 400 bad_username / name_reserved { suggest } | 409 username_taken /
 *                             name_lookalike { suggest } (the email sign-up's name rules) | email_has_account |
 *                             already_linked | 403 turnstile_failed | 404 no_pending | 429 (new accounts per network:
 *                             one budget with signup/finish)
 *   POST /api/auth/pending/cancel {}                            -> { ok } (the cookie cleared)
 *     A verified provider address that leads to an account (claimed, held or hinted) refuses the
 *     create: that account signs in (login or signin with linkPending, reset, or start?pend=1) and the
 *     identity is linked to it; one email, one account. A Discord address is only a hint (trust
 *     'asserted'); an address an email sign-up claimed leads to that account (via 'email').
 *     link=1 (PERFIL's VINCULAR) needs this browser's refresh cookie, not a TV's, and a credential
 *     proved on it in the last REAUTH_WINDOW_S (a sign-in, or reauth=1 just before), at level 2
 *     for the project's accounts (linkLevel: their password; a pend=1 sign-in below it links
 *     nothing either, linkError reauth_required); otherwise the start answers
 *     /#auth=error:reauth_required (or link_expired without a valid cookie) and never turns into a
 *     sign-up. A link never replaces the account's own id of that provider (409
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
 * asks for it: a link needs 1 (2 for a maintainer: linkLevel); an email's add 1 (2 for a maintainer
 * with a password: emailLevel), its change 2; an unlink 1, or 2 when one way in would be left; the
 * maintainer routes (nodeRoutes.ts) always 2, which a maintainer reaches with its password only
 * (reauth/code refuses NODE_TRUSTED_OPERATORS). Every primary sign-in of such an
 * account (login, signin, recover, reset, the email undo, a provider's callback) and every level-2
 * re-authentication of it posts an ALERT line to the staff channel, with the method and the
 * country only (maintainerAlert, §3.12).
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
 *   POST /api/auth/tv/renew   { code, secret }                  -> { code, expiresAt, ttlMs }: the TV's next code, 20 s
 *                             before this one ends (once per code, in its last minute; 6 per start) | 409
 *                             tv_code_used | 409 tv_renew_early | 410 tv_code_expired | 503 busy
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
 *   POST /api/dev/signin      { name }                          -> AccountSession + refresh cookie, and
 *   GET  /api/dev/mail                                          -> the stub mailer's outbox: local work only,
 *                             404 not_found unless DEV_AUTH=1 on a loopback host (devRoute below)
 *
 * Every POST /api/auth/* (every route that sets, rotates, clears or uses the refresh cookie, or
 * changes a credential) is refused unless it comes from one of the game's own pages: an Origin
 * header that is this origin (or PUBLIC_ORIGIN, or VITE_ORIGINS; a loopback page under wrangler
 * dev), never missing or "null" (403 bad_origin), and, for a route that reads a body,
 * Content-Type application/json (415 json_required): a cross-site <form> can send neither, so a
 * login CSRF (a text/plain form signing the browser into another account) cannot happen. POST
 * /api/me/consent and the page's form of POST /api/news/unsubscribe ask the same. The one POST that
 * takes a form with no Origin is RFC 8058's one-click unsubscribe (sign-in PR 13, below): it
 * carries no cookie or Bearer, and can only withdraw the news consent of the id in its URL.
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
import { EXPERIMENTAL_REFUSED, JSON_MAX_BYTES, carriesPhysics, deletionOpen, error, json, readCapped, readJson, trustedOperatorIds } from './env';
import { base64urlDecode, base64urlEncode, internalSecret, INTERNAL_HEADER, nowSeconds, signJwt, verifyJwt } from './auth';
import type { SessionClaims } from './auth';
import { isClientKey, isPlaylist, normalizeEmail, OAUTH_PROVIDERS, usernameIssue, usernameProblem } from '../../src/net/account';
import type { AccountSession, CodeResendAnswer, CodeStartAnswer, EmailConfirmAnswer, LeaderboardAnswer, OAuthProvider, PasswordLinkAnswer, TvInfoAnswer, TvPollAnswer, TvStartAnswer } from '../../src/net/account';
import type { Credentials, LegacyState, PasswordRecord, PendingIdent, PendingIdentity, ProviderEmail, ProviderTrust, RefreshGrant, UserRef } from './accountStore';
import { DEV_NAME_PROBLEM, LEGACY_CLOSED, UNSUB_ID_RE, devSubOf, legacyDateOf } from './accountStore';
import { TV_POLL_MS, ipKey, tvCode } from './tvCodes';
import { firstUse } from './limits';
import { PRESET_ID_RE, parseStoredPreset } from '../../src/game/physicsRules';
import { DEFAULT_CAR, isCarId } from '../../src/game/cosmetics';
import { ITEM_ID_RE } from '../../nodes/control-plane/shop';
import { composeMail, deliver, devMailResponse, isDevAuth, isLocalDev, linkOrigin } from './mail';
import type { Mailer, MailMessage } from './mail';
import { FAILURES, mailKilled } from './mailCaps';
import { AlertHook } from './nodeAlerts';
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
  // After the cutoff (sign-in PR 9, §3.10): 410 for everyone, before any check or lookup.
  const closed = await legacyGate(c);
  if (closed !== null) return closed;
  const b = await readJson<{ username?: unknown; password?: unknown; passwordV2?: unknown; turnstileToken?: unknown; linkPending?: unknown; cancelDeletion?: unknown }>(c.request);
  const proof = proofOf(b?.password, b?.passwordV2);
  if (!b || typeof b.username !== 'string' || b.username.length > 64 || (proof.v1 === undefined && proof.v2 === undefined)) return error(400, 'bad_request');
  // Before the AccountsDO hears of it (R3): a page from before the check sends no token and reloads.
  const blocked = await c.antiBot(b.turnstileToken);
  if (blocked !== null) return blocked;
  const chk = await checkPassword(c, b.username, proof, { signIn: true }, true);
  if (!chk.ok) return chk.res;
  // This deployment's env, not storeEnv's: an AccountsDO of before ignores a sign-in's `rekey`.
  const rekey = await rekeyFor(c.env, chk.cred, proof);
  // linkPending (the confirm sheet's "I already have one"): the identity pending in this browser goes
  // on this account in the sign-in's step, under §3.8's rules; the sign-in stands either way.
  const linking = b.linkPending === true;
  const pending = linking ? await readPending(c) : null;
  const refresh = newRefreshToken();
  const fin = await accountsJson<UserRef & { linked?: OAuthProvider[]; linkError?: string }>(c.env, '/auth-finish', {
    userId: chk.cred.userId,
    username: b.username,
    ip: ipOf(c.request),
    ok: true,
    refresh: await grantFor(refresh, c.request),
    device: await deviceOf(c.env, c.request),
    proved: chk.cred.hash,
    charged: true,
    ...(rekey !== null ? { rekey } : {}),
    ...(pending !== null ? { pending: pendingBody(pending) } : {}),
    // A deletion pending answers 409 deletion_pending { purgeAt }; this flag, sent again after the question, calls it off (§2.10).
    ...(b.cancelDeletion === true ? { cancelDeletion: true } : {}),
  });
  if (!fin.ok) return pass(fin.res);
  maintainerAlert(c, fin.data, 'legacy');
  return signedInAnswer(c, fin.data, [refreshCookie(refresh), await deviceCookie(c.env, fin.data.userId)], linking, pending);
}

/**
 * A password sign-in's answer (the legacy login, the email signin, a reset): the session and its
 * cookies. With linkPending, also what became of the identity pending in this browser ({ linked }
 * or { linkError }; no_pending without a live cookie), and the pending cookie goes either way: the
 * sign-in itself stands whether or not the link was made (§3.8).
 */
async function signedInAnswer(c: RouteContext, data: UserRef & { linked?: OAuthProvider[]; linkError?: string }, cookies: string[], linking: boolean, pending: PendingIdentity | null): Promise<Response> {
  if (!linking) return withCookies(json(await accountSession(c.env, data)), cookies);
  const link = pending === null ? { linkError: 'no_pending' } : Array.isArray(data.linked) ? { linked: data.linked } : { linkError: typeof data.linkError === 'string' ? data.linkError : 'no_pending' };
  return withCookies(json({ ...(await accountSession(c.env, data)), ...link }), [...cookies, clearCookie(PENDING_COOKIE, 'Lax')]);
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
  const closed = await legacyGate(c);
  if (closed !== null) return closed;
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
  maintainerAlert(c, r.data, 'recover');
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
  if (freshLevel(s, windowS, nowS) < level) return reauthRequired(level);
  return s;
}

/**
 * The level a link of `userId` needs (R6): 1, a press on a provider's page; 2 for the project's
 * accounts (NODE_TRUSTED_OPERATORS, §3.12), which only a password reaches (reauth/code refuses them
 * the mailbox's), so whoever holds one of its providers cannot add a provider of their own.
 */
export function linkLevel(env: Pick<Env, 'NODE_TRUSTED_OPERATORS'>, userId: string): 1 | 2 {
  return trustedOperatorIds(env).has(userId) ? 2 : 1;
}

/**
 * The level POST /api/me/email needs (R6): 1 to add an address, 2 to change one (an account that has
 * one reaches 2). The project's accounts with a password add one at 2 as well (§3.12): an address
 * added at level 1 would reach 2 by its reset link, so whoever holds one of their providers would
 * get past linkLevel. Without a password a project account adds at 1, its ceiling, so the owner is
 * never locked out of its first address; the staff channel hears of it (maintainerAlert 'emailAdd').
 */
export function emailLevel(env: Pick<Env, 'NODE_TRUSTED_OPERATORS'>, userId: string, me: { emailVerified?: boolean; hasPassword?: boolean }): 1 | 2 {
  return me.emailVerified === true || (me.hasPassword === true && trustedOperatorIds(env).has(userId)) ? 2 : 1;
}

/** The level a session is fresh at (R6): its aal while its aat is within `windowS`, else 0 (requireFresh's rule; a route whose need the AccountsDO decides passes it on). */
export function freshLevel(s: SessionClaims, windowS: number = REAUTH_WINDOW_S, nowS: number = nowSeconds()): 0 | 1 | 2 {
  if (s.tv === 1 || typeof s.aat !== 'number' || nowS - s.aat > windowS || s.aat > nowS + 60) return 0;
  return s.aal === 1 || s.aal === 2 ? s.aal : 0;
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

/** How a maintainer account proved itself (or what was refused it), in its ALERT line's words: the method only, never an address. */
const MAINTAINER_PROOF = {
  password: 'signed in with its email and password',
  legacy: 'signed in with its username and password',
  recover: 'signed in with a recovery code',
  reset: 'signed in with a password reset link',
  undo: "signed in with an email change's undo link",
  google: 'signed in with Google',
  discord: 'signed in with Discord',
  reauth: 'confirmed it is them with its password (level 2)',
  reauthCode: 'confirmed it is them with a code by email (level 2)',
  // Not a sign-in: another account asked for its address (POST /api/me/email), which never moves (§3.12).
  emailMove: 'kept its email: another account asked for it (refused)',
  // Not a sign-in: a project account with no password yet asked to add an address at level 1 (emailLevel).
  emailAdd: 'asked to add an email at level 1 (it has no password yet)',
} as const;
export type MaintainerProof = keyof typeof MAINTAINER_PROOF;

/**
 * Every primary sign-in of a NODE_TRUSTED_OPERATORS account, every level-2 re-authentication of one
 * and every request of another account for its address (emailMove, refused: §3.12, within that
 * address's mail cap) or of one with no password for a first address at level 1 (emailAdd, within
 * its account's mail cap, 10 a day): an ALERT line in the Worker's log and on the staff channel
 * (NODE_ALERT_WEBHOOK, nodeAlerts.ts AlertHook.audit: each one posted, none merged with another or
 * left out by a limit), after the answer (waitUntil). It names the account, the method and the
 * country of the request (request.cf), and never an IP or an email, nor the other account, so a
 * project session in the wrong hands shows on the channel when it starts. A TV is no primary
 * sign-in (it never reaches a maintainer route). True when the account is one of them.
 */
export function maintainerAlert(c: Pick<RouteContext, 'env' | 'request' | 'waitUntil'>, who: Pick<UserRef, 'userId' | 'username'>, proof: MaintainerProof): boolean {
  if (!trustedOperatorIds(c.env).has(who.userId)) return false;
  const line = `ALERT maintainer ${who.username} (${who.userId}) ${MAINTAINER_PROOF[proof]}, from ${geoOf(c.request).country ?? 'an unknown country'}`;
  console.log(`[accounts] ${line}`);
  const hook = new AlertHook({
    url: c.env.NODE_ALERT_WEBHOOK,
    waitUntil: c.waitUntil ?? ((p) => void p.catch(() => undefined)),
    fetch: (url, init) => fetch(url, init),
    log: (m) => console.warn(`[accounts] ${m}`),
  });
  hook.audit(line);
  return true;
}

/**
 * POST /api/me/username { username, lang? }: the name salts no password any more (design §2.15,
 * §5.3). An account that signs in by email or with a provider renames with a full Bearer, nothing
 * more: its name is no way in. An account whose password is still the legacy key (salted with the
 * name it has) is asked to confirm it is them first, 403 reauth_required { level: 2 }: the client's
 * "confirm it's you" with its password re-keys it (POST /api/auth/reauth), then it renames. So is an
 * account whose password signs in by its username (a password and no verified email, the legacy
 * sign-in /api/auth/login and its recovery): there the name is the only sign-in name it has, so a
 * rename by a stolen Bearer would lock the owner out of it for RENAME_EVERY_MS and free the name
 * for someone else. It needs fresh(2), as changing an email does (R6): a typed password in the last
 * REAUTH_WINDOW_S, which a sign-in or "confirm it's you" gives.
 * A taken name or a look-alike of a protected account is 409 with a free `suggest`.
 */
async function rename(c: RouteContext): Promise<Response> {
  const s = requirePrimary(c);
  if (s instanceof Response) return s;
  if (c.limited('rename:' + s.sub, 5)) return error(429, 'rate_limited');
  const b = await readJson<{ username?: unknown; lang?: unknown }>(c.request);
  const problem = usernameProblem(b?.username);
  if (problem !== null) return error(400, 'bad_username', problem);
  const me = await accountsJson<{ name: string; hasPassword?: boolean; emailVerified?: boolean; legacy?: boolean }>(c.env, '/me?userId=' + encodeURIComponent(s.sub));
  if (!me.ok) return pass(me.res);
  if (me.data.legacy === true) return reauthRequired(2);
  if (me.data.hasPassword === true && me.data.emailVerified !== true) {
    const fresh = requireFresh(c, 2);
    if (fresh instanceof Response) return fresh;
  }
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

/**
 * GET /api/me/replay-name, POST /api/me/replay-name { hidden }: PERFIL's "hide my name in public
 * replays" (src/net/replays.ts; default off: the name shows). Limited per account by limits.ts
 * (replayName), before AccountsDO. The public rows read it at each serve (the NodeRegistryDO keeps
 * an answer a minute), the matches already listed too.
 */
async function replayName(c: RouteContext): Promise<Response> {
  const s = requireAccount(c);
  if (s instanceof Response) return s;
  if (c.request.method === 'GET') return noStore(await accountsCall(c.env, '/replay-name?userId=' + encodeURIComponent(s.sub)));
  const b = await readJson<{ hidden?: unknown }>(c.request);
  if (!b || typeof b.hidden !== 'boolean') return error(400, 'bad_request');
  return noStore(await accountsCall(c.env, '/replay-name/set', { userId: s.sub, hidden: b.hidden }));
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

/**
 * MeInfo's fields a TV's session never gets (the design's §3.11): the account's address and a
 * provider's, and the project account's checklist (`maintainer`: its ways in, none of a TV's work).
 */
const TV_HIDDEN = ['email', 'emailHint', 'maintainer'] as const;

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
      // The address, never the name (§5.1): no `profile`.
      scope: 'openid email',
    };
  }
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) return null;
  return {
    clientId: env.DISCORD_CLIENT_ID,
    clientSecret: env.DISCORD_CLIENT_SECRET,
    authorize: 'https://discord.com/oauth2/authorize',
    token: 'https://discord.com/api/v10/oauth2/token',
    user: 'https://discord.com/api/v10/users/@me',
    scope: 'identify email',
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
  /** pend=1, the confirm sheet's "I already have one": an owned identity signs in and links the pending one; an unowned one joins it (p2). */
  pend?: 1;
  /** then=link:<p> on a re-authentication: the callback goes straight on to linking <p> (one round trip less, §3.9). */
  then?: OAuthProvider;
  /** A silent Discord sign-in (DISCORD_SILENT, prompt=none, level 0): a callback that needs consent starts once more with prompt=consent. */
  sil?: 1;
  /** cancelDel=1 (§2.10): the sign-in after "cancel the deletion?"; an owner whose deletion is pending signs in and calls it off. */
  cancelDel?: 1;
  exp: number;
}

/** The provider's prompt for a start, and the level a press on it proves (R6): a person must press there, script on our origin cannot. */
const OAUTH_PROMPT: Readonly<Record<OAuthProvider, { prompt: string; lvl: 1 }>> = {
  google: { prompt: 'select_account', lvl: 1 },
  discord: { prompt: 'consent', lvl: 1 },
};

/**
 * Var, optional (the sign-in design's §3.8 step 0): '1' asks Discord for prompt=none on a plain
 * sign-in, which skips its Authorize screen for a returning player (level 0). Off until a developer
 * has checked with a test Discord application what a never-authorized user sees then.
 */
type OAuthEnv = Env & { DISCORD_SILENT?: string };

/** The provider's answers to a silent start that needed a person after all: the callback asks once more, with the press. */
const SILENT_RETRY = new Set(['consent_required', 'interaction_required', 'login_required']);

/** What a start asks for, apart from the PKCE pair and the nonce authorizeRedirect makes. */
type StateFlags = Omit<OAuthState, 'typ' | 'p' | 'v' | 'n' | 'exp' | 'lvl'>;

/**
 * The redirect to the provider's authorize page, with a new state cookie (PKCE verifier, nonce,
 * `flags`, the level its prompt proves). `silent`: Discord's prompt=none, level 0. `cookies`: set
 * with it (a callback that chains a link sets the refresh cookie of its re-authentication too).
 */
async function authorizeRedirect(c: RouteContext, provider: OAuthProvider, cfg: ProviderConfig, flags: StateFlags, silent = false, cookies: readonly string[] = []): Promise<Response> {
  const verifier = base64urlEncode(randomBytes(32));
  const challenge = base64urlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(verifier))));
  const nonce = base64urlEncode(randomBytes(16));
  const asked = OAUTH_PROMPT[provider];
  const state: OAuthState = { typ: 'oa', p: provider, v: verifier, n: nonce, ...flags, ...(silent ? { sil: 1 as const } : { lvl: asked.lvl }), exp: nowSeconds() + OAUTH_TTL_S };
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
  // Discord's prompt=consent never lets an earlier authorization answer silently (level 1, not 0),
  // unless DISCORD_SILENT asks for a silent sign-in (level 0, which every sensitive route refuses).
  q.set('prompt', silent ? 'none' : asked.prompt);
  return redirect(`${cfg.authorize}?${q.toString()}`, [...cookies, cookie]);
}

async function oauthStart(c: RouteContext, provider: OAuthProvider, url: URL): Promise<Response> {
  const cfg = providerConfig(c.env, provider);
  if (!cfg) return error(404, 'provider_disabled');
  if (c.limited('oauth:' + ipOf(c.request), 20)) return error(429, 'rate_limited');
  let link: string | null = null;
  let re: string | undefined;
  let dev: string | undefined;
  const mode = url.searchParams.get('link') === '1' ? 'link' : url.searchParams.get('reauth') === '1' ? 'reauth' : 'signin';
  // The flags of §2.7, none a secret: pend=1 (a sign-in from the confirm sheet), then=link:<p> (after a re-authentication).
  const pend = mode === 'signin' && url.searchParams.get('pend') === '1';
  const cancelDel = mode === 'signin' && url.searchParams.get('cancelDel') === '1';
  const thenOf = /^link:(google|discord)$/.exec(url.searchParams.get('then') ?? '');
  const then = mode === 'reauth' && thenOf !== null && providerConfig(c.env, thenOf[1] as OAuthProvider) !== null ? (thenOf[1] as OAuthProvider) : undefined;
  if (mode !== 'signin') {
    // This browser's own signed-in device: never a TV's, and for a link one that just proved a
    // credential. Without one the start says so, it never turns into a sign-in or a sign-up.
    const token = cookieOf(c.request, REFRESH_COOKIE);
    const r = token && token.length <= 128 ? await accountsJson<UserRef & { kind: string; device: string }>(c.env, '/refresh-owner', { hash: await sha256Hex(token) }) : null;
    if (r === null || !r.ok) return redirect('/#auth=error:link_expired');
    if (r.data.kind === 'tv') return redirect('/#auth=error:tv_session');
    const authAt = typeof r.data.authAt === 'number' ? r.data.authAt : 0;
    // A link adds a way in: fresh(1) (R6), so a silent sign-in, a refresh of before levels or a TV never links; the project's accounts fresh(2) (linkLevel).
    if (mode === 'link' && (authAt <= 0 || Date.now() - authAt > REAUTH_WINDOW_S * 1000 || (r.data.authLvl ?? 0) < linkLevel(c.env, r.data.userId))) return redirect('/#auth=error:reauth_required');
    if (mode === 'link') link = r.data.userId;
    else re = r.data.userId;
    dev = r.data.device;
  }
  // Calling a deletion off takes a press on the provider's page too (never a silent start).
  const silent = provider === 'discord' && mode === 'signin' && !pend && !cancelDel && (c.env as OAuthEnv).DISCORD_SILENT === '1';
  return authorizeRedirect(c, provider, cfg, { link, ...(re !== undefined ? { re } : {}), ...(dev !== undefined ? { dev } : {}), ...(pend ? { pend: 1 as const } : {}), ...(then !== undefined ? { then } : {}), ...(cancelDel ? { cancelDel: 1 as const } : {}) }, silent);
}

/** A provider identity as the callback reads it (§2.7): the id, the address and how far the provider vouches for it. Never a name. */
export interface ProviderIdentity extends ProviderEmail {
  id: string;
}

/**
 * The trust of a provider's address (§3.8), computed here from the provider's own answer and never
 * taken from a client (I9). Discord's `verified` only says the address was confirmed once (it may
 * have changed hands since): 'asserted' at most, a hint. Google is authoritative only for a Gmail
 * address outside Workspace (`hd` absent): 'auth', which claims the canon; any other verified Google
 * address is 'asserted'. In this build Google is read through its userinfo endpoint, and the claim
 * comes with the Google change that reads its id_token (the design's PR 11): until then a Google
 * address is 'asserted' too. An address that does not normalize is none.
 */
export function providerTrust(provider: OAuthProvider, u: { email?: unknown; verified?: unknown; email_verified?: unknown; hd?: unknown }): ProviderEmail {
  const email = normalizeEmail(u.email);
  const verified = provider === 'google' ? u.email_verified === true || u.email_verified === 'true' : u.verified === true;
  if (email === null || !verified) return { email: null, trust: 'none' };
  return { email, trust: 'asserted' };
}

/** Code -> provider identity { id, email, trust } (token exchange + user endpoint). `fetchFn` for tests. */
export async function oauthIdentity(cfg: ProviderConfig, provider: OAuthProvider, code: string, verifier: string, redirectUri: string, fetchFn: typeof fetch = fetch): Promise<ProviderIdentity | null> {
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
  // The id and the address only: no field of a name is read (given_name, name, global_name, username).
  const id = provider === 'google' ? u.sub : u.id;
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) return null;
  return { id, ...providerTrust(provider, u) };
}

/**
 * A state cookie is good for one callback (limits.ts firstUse, for the state's whole life): a
 * replay of it is refused before our client secret goes to the provider again. The callback's
 * per-network limit is index.ts's (limits.ts accountGate).
 */
function oauthStateUnused(c: RouteContext, st: OAuthState): Promise<boolean> {
  return firstUse('oauth-state', st.n, OAUTH_TTL_S * 1000, new URL(c.request.url).origin);
}

/**
 * The provider's redirect back (§3.8). A re-authentication moves this browser's proof to now (and
 * with then=link:<p> goes straight on to linking <p>); a link adds the identity to the account; an
 * identity an account owns signs in (and with pend=1 links the identity pending in this browser);
 * an identity nobody owns creates NOTHING (I3): the pending cookie holds it, and /#auth=confirm
 * asks "do you already have a Turbogol account?" (POST /api/auth/pending, /pending/create). With
 * pend=1 an unowned identity of the other provider joins the pending one (p2); of the same
 * provider it is /#auth=error:no_account, the cookie kept. Every redirect carries only #auth=…,
 * and nothing of the provider's answers is logged.
 */
async function oauthCallback(c: RouteContext, provider: OAuthProvider, url: URL): Promise<Response> {
  const fail = (code: string): Response => redirect('/#auth=error:' + code, [clearCookie(OAUTH_COOKIE, 'Lax')]);
  const cfg = providerConfig(c.env, provider);
  if (!cfg) return fail('provider_disabled');
  const raw = cookieOf(c.request, OAUTH_COOKIE);
  const st = raw ? await verifyJwt<OAuthState>(c.env.JWT_SECRET, raw) : null;
  const ours = st !== null && st.typ === 'oa' && st.p === provider && st.n === url.searchParams.get('state');
  const refused = url.searchParams.get('error');
  if (refused) {
    // A silent Discord sign-in that needed a person after all: once more, asking for the press.
    if (ours && st.sil === 1 && SILENT_RETRY.has(refused) && (await oauthStateUnused(c, st))) return authorizeRedirect(c, provider, cfg, { link: null });
    return fail('cancelled');
  }
  const code = url.searchParams.get('code');
  if (!ours || !code || code.length > 2048) return fail('bad_state');
  if (!(await oauthStateUnused(c, st))) return fail('bad_state');
  const ident = await oauthIdentity(cfg, provider, code, st.v, `${publicOrigin(c.env, c.request)}/api/auth/oauth/${provider}/callback`);
  if (!ident) return fail('provider_error');
  const found: ProviderEmail = { email: ident.email, trust: ident.trust };
  const refreshTok = newRefreshToken();
  const refresh = await grantFor(refreshTok, c.request);
  // The level the start's prompt proves (R6); a state from before levels, or a silent one, proves none.
  const lvl = st.lvl === 1 ? 1 : 0;
  if (typeof st.re === 'string') {
    const r = await accountsJson<UserRef>(c.env, '/oauth-reauth', { provider, providerId: ident.id, userId: st.re, refresh, replace: st.dev, lvl });
    if (!r.ok) return fail(await codeOf(r.res, 'account_error'));
    // then=link:<p>: this device just proved the account at level 1 (fresh(1), what a link needs),
    // so the link's state is made here, for this browser's new token, instead of a start that reads
    // the SameSite=Strict cookie (a redirect chain from the provider would not send it).
    const next = st.then !== undefined ? providerConfig(c.env, st.then) : null;
    if (st.then !== undefined && next !== null && lvl >= 1 && typeof refresh.family === 'string') {
      // A project account links at level 2 only (linkLevel): a provider's press goes no further than this re-authentication.
      if (lvl < linkLevel(c.env, st.re)) return redirect('/#auth=error:reauth_required', [clearCookie(OAUTH_COOKIE, 'Lax'), refreshCookie(refreshTok)]);
      return authorizeRedirect(c, st.then, next, { link: st.re, dev: refresh.family }, false, [refreshCookie(refreshTok)]);
    }
    return redirect('/#auth=reauth', [clearCookie(OAUTH_COOKIE, 'Lax'), refreshCookie(refreshTok)]);
  }
  const pending = st.link === null && st.pend === 1 ? await readPending(c) : null;
  const r = await accountsJson<UserRef & { pending?: true; linked?: OAuthProvider[]; linkError?: string }>(c.env, '/oauth', {
    provider,
    providerId: ident.id,
    ...found,
    linkTo: st.link,
    refresh,
    lvl,
    ...(st.link !== null ? { replace: st.dev } : {}),
    ...(pending !== null ? { pending: pendingBody(pending) } : {}),
    // An owner whose deletion is pending: /#auth=error:deletion_pending, unless this start was cancelDel=1 (§2.10).
    ...(st.cancelDel === 1 ? { cancelDeletion: true } : {}),
  });
  if (!r.ok) return fail(await codeOf(r.res, 'account_error'));
  if (r.data.pending === true) {
    const mine: PendingIdent = { p: provider, id: ident.id, ...found };
    if (pending === null) return redirect('/#auth=confirm', [clearCookie(OAUTH_COOKIE, 'Lax'), await pendingCookie(c.env, { ...mine, lvl })]);
    // "I already have one", and that one has no account either: the same provider says so (the
    // pending identity kept), the other one joins it and CREAR makes one account with both.
    if (pending.p === provider) return fail('no_account');
    return redirect('/#auth=confirm', [clearCookie(OAUTH_COOKIE, 'Lax'), await pendingCookie(c.env, { ...pending, p2: mine, lvl })]);
  }
  const cookies = [clearCookie(OAUTH_COOKIE, 'Lax'), refreshCookie(refreshTok)];
  if (st.link !== null) return redirect('/#auth=linked', cookies);
  maintainerAlert(c, r.data, provider);
  if (pending === null) return redirect('/#auth=ok', cookies);
  // Signed in either way (§3.8): the pending identity linked, or the reason it was not.
  cookies.push(clearCookie(PENDING_COOKIE, 'Lax'));
  return redirect(r.data.linkError !== undefined && /^[a-z_]{1,32}$/.test(r.data.linkError) ? '/#auth=ok:' + r.data.linkError : '/#auth=linked', cookies);
}

// ---- the confirm step: an identity nobody owns, held for this browser (§2.7, §3.8) -----------------

const PENDING_COOKIE = '__Host-tg_pend';
/** The pending identity's life: long enough to sign in to an old account, or to come back from the other provider. */
export const PENDING_TTL_S = 30 * 60;

/**
 * The pending cookie's JWT (typ 'pend': never a session, a ticket or a state): the identity a
 * provider proved in this browser that no account owns, its address and trust as the Worker read
 * them (never a client), a second identity of the other provider (p2), and the callback's level.
 * HttpOnly, in the person's own browser, 30 minutes at most.
 */
interface PendingClaims extends PendingIdentity {
  typ: 'pend';
  lvl: 0 | 1;
  iat: number;
  exp: number;
}

async function pendingCookie(env: Env, p: PendingIdentity & { lvl: 0 | 1 }): Promise<string> {
  const iat = nowSeconds();
  const claims: PendingClaims = { typ: 'pend', p: p.p, id: p.id, email: p.email, trust: p.trust, ...(p.p2 ? { p2: { p: p.p2.p, id: p.p2.id, email: p.p2.email, trust: p.p2.trust } } : {}), lvl: p.lvl, iat, exp: iat + PENDING_TTL_S };
  return `${PENDING_COOKIE}=${await signJwt(env.JWT_SECRET, claims)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${PENDING_TTL_S}`;
}

const TRUSTS: readonly ProviderTrust[] = ['auth', 'asserted', 'none'];

function pendIdentOf(v: unknown): PendingIdent | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!OAUTH_PROVIDERS.includes(o.p as OAuthProvider) || typeof o.id !== 'string' || o.id.length === 0 || o.id.length > 128) return null;
  if (!(o.email === null || typeof o.email === 'string') || !TRUSTS.includes(o.trust as ProviderTrust)) return null;
  return { p: o.p as OAuthProvider, id: o.id, email: o.email as string | null, trust: o.trust as ProviderTrust };
}

/** This browser's pending identity (its cookie, signed and live), null without one. */
async function readPending(c: Pick<RouteContext, 'env' | 'request'>): Promise<(PendingIdentity & { lvl: 0 | 1 }) | null> {
  const raw = cookieOf(c.request, PENDING_COOKIE);
  const v = raw ? await verifyJwt<PendingClaims>(c.env.JWT_SECRET, raw) : null;
  if (v === null || v.typ !== 'pend') return null;
  const first = pendIdentOf(v);
  if (first === null) return null;
  const p2 = pendIdentOf(v.p2);
  return { ...first, ...(p2 !== null && p2.p !== first.p ? { p2 } : {}), lvl: v.lvl === 1 ? 1 : 0 };
}

/** The pending identity as AccountsDO takes it (accountStore.ts PendingIdentity). */
function pendingBody(p: PendingIdentity): PendingIdentity {
  return { p: p.p, id: p.id, email: p.email, trust: p.trust, ...(p.p2 ? { p2: p.p2 } : {}) };
}

/** 404 no_pending, the cookie cleared: the 30 minutes passed, or another tab used it. */
function noPending(): Response {
  return withCookies(error(404, 'no_pending', 'Ese inicio de sesión caducó: vuelve a entrar'), [clearCookie(PENDING_COOKIE, 'Lax')]);
}

/**
 * POST /api/auth/pending {}: what the confirm sheet shows. The provider, its address when it gave
 * a verified one, the trust, the second identity's provider, and the match: the account that
 * address leads to (its name and ways in), looked up only for a verified address and shown only to
 * whoever just proved a provider identity with that address (§7).
 */
async function pendingInfo(c: RouteContext): Promise<Response> {
  const pend = await readPending(c);
  if (pend === null) return noPending();
  const r = await accountsJson<{ match: { name: string; methods: string[]; via: string; email: string } | null }>(c.env, '/pending-match', { pending: pendingBody(pend) });
  if (!r.ok) return noStore(r.res);
  return json({ provider: pend.p, email: pend.trust === 'none' ? null : pend.email, trust: pend.trust, second: pend.p2?.p ?? null, match: r.data.match }, 200, { 'cache-control': 'no-store' });
}

/** An IANA time zone this runtime knows ('' for none or another value): users.tz, for dates in mail. */
function timeZoneOf(v: unknown): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(v)) return '';
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: v });
    return v;
  } catch {
    return '';
  }
}

/**
 * POST /api/auth/pending/create { username, news, lang, tz, turnstileToken }: the confirm sheet's
 * CREAR. A solved check first (it restores the sign-up's anti-bot for OAuth), then the account with
 * the name the player chose, never a provider's (§5.1), under the email sign-up's name rules
 * (§5.2). AccountsDO caps new accounts per network, one budget with signup/finish.
 */
async function pendingCreate(c: RouteContext): Promise<Response> {
  const pend = await readPending(c);
  if (pend === null) return noPending();
  const b = await readJson<{ username?: unknown; news?: unknown; lang?: unknown; tz?: unknown; turnstileToken?: unknown }>(c.request);
  if (!b) return error(400, 'bad_request');
  const blocked = await c.antiBot(b.turnstileToken);
  if (blocked !== null) return blocked;
  // The name rules are the email sign-up's (section 5.2), in the AccountsDO: a reserved word (400
  // name_reserved), a taken name and a look-alike of a protected account (409 username_taken /
  // name_lookalike), each with a free `suggest`. Only a name that is no username at all stops here.
  const issue = usernameIssue(b.username);
  if (issue !== null && issue.code !== 'usernameReserved') return error(400, 'bad_username', usernameProblem(b.username) ?? 'Nombre inválido');
  const refreshTok = newRefreshToken();
  const r = await accountsJson<UserRef>(c.env, '/pending-create', {
    pending: pendingBody(pend),
    username: b.username,
    refresh: await grantFor(refreshTok, c.request),
    ip: ipOf(c.request),
    lvl: pend.lvl,
    lang: b.lang === 'es' || b.lang === 'en' ? b.lang : '',
    tz: timeZoneOf(b.tz),
    news: b.news === true,
  });
  if (!r.ok) return noStore(r.res);
  return withCookies(json(await accountSession(c.env, r.data)), [refreshCookie(refreshTok), clearCookie(PENDING_COOKIE, 'Lax')]);
}

/** POST /api/auth/pending/cancel {}: the confirm sheet's CANCELAR. */
function pendingCancel(): Response {
  return withCookies(json({ ok: true }), [clearCookie(PENDING_COOKIE, 'Lax')]);
}

/** An AccountsDO refusal's code for the /#auth=error: hash (only the ones the client words), else `fallback`. */
async function codeOf(res: Response, fallback: string): Promise<string> {
  try {
    const b = (await res.json()) as { error?: unknown };
    return typeof b.error === 'string' && ['already_linked', 'provider_set', 'reauth_mismatch', 'link_expired', 'deletion_pending'].includes(b.error) ? b.error : fallback;
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
  maintainerAlert(c, r.data, 'reauth');
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

/**
 * A refusal of the AccountsDO as the client gets it, never with a mail order in it: a 409
 * deletion_pending of a reset (the password set, nothing signed in, §2.4) carries its M4, which goes
 * out here, after the answer, as any other.
 */
async function withoutMail(c: RouteContext, res: Response): Promise<Response> {
  const text = await res.text().catch(() => '');
  let b: Record<string, unknown> | null = null;
  try {
    const v = JSON.parse(text) as unknown;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) b = v as Record<string, unknown>;
  } catch {
    /* not JSON: passed on as it is */
  }
  if (b === null || !('mail' in b)) return noStore(new Response(text, res));
  const { mail, ...rest } = b;
  sendMail(c, mail as MailOrder | null);
  return json(rest, res.status, NO_STORE);
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

//   POST /api/auth/signin         { email, password, turnstileToken, linkPending?, cancelDeletion? } -> AccountSession +
//                                 refresh and device cookies (level 2, method 'password'; with linkPending & { linked } |
//                                 { linkError }, as the legacy login) | 401 bad_credentials (an unknown address, a
//                                 wrong password, no current password, a legacy one not re-keyed: one answer, one
//                                 server stage) | 403 turnstile_failed / banned (after the right password) | 409
//                                 deletion_pending { purgeAt } (after the right password; cancelDeletion calls the
//                                 deletion off and signs in, sign-in PR 12) | 429 throttled { retryAfterMs }
//   POST /api/auth/forgot         { email, lang?, turnstileToken }           -> { ok: true } always (M3 only to an account
//                                 that claimed that address) | 403 | 429 | 503
//   POST /api/auth/reset/peek     { token }                                  -> { name, email, hasPassword } | 410 link_invalid
//   POST /api/auth/reset          { token, password, linkPending? }          -> AccountSession + cookies (level 2, method
//                                 'reset'; every other device signed out; M4; with linkPending & { linked } |
//                                 { linkError }) | 400 bad_password | 410 | 403 banned
//   POST /api/me/password         Bearer + cookie { current | legacy, password } -> { ok } (the other devices signed out;
//                                 M4) | 401 bad_credentials | 409 no_password | 429 throttled (per account, 'pa:')
//   POST /api/me/password/link    Bearer {}                                  -> { sentTo }: a reset link to the account's own
//                                 address (M3 "create" without a password) | 409 email_required | 429 | 503
//   POST /api/auth/reauth/code    Bearer {}                                  -> { attempt, resendAt, to }: M11 | 409
//                                 email_required | 403 password_required (a maintainer confirms with its password)
//   POST /api/auth/reauth/code/verify Bearer + cookie { attempt, code }      -> AccountSession (level 2) | 400 | 410
//   POST /api/auth/register, /api/auth/recovery-codes, /api/auth/password    -> 410 gone (P6, auth-3: a Bearer alone never
//                                 adds a way in, I4)

/**
 * POST /api/auth/signin: the email sign-in. Its throttles are the legacy sign-in's (AccountsDO.ts
 * THROTTLE_RULES), keyed by the typed canon. linkPending, as at the legacy login (§2.3, §3.8): once
 * the password is proved, the identity pending in this browser goes on this account in the
 * sign-in's step (only the account its address leads to, when it leads to one).
 */
async function signin(c: RouteContext): Promise<Response> {
  const b = await readJson<{ email?: unknown; password?: unknown; turnstileToken?: unknown; linkPending?: unknown; cancelDeletion?: unknown }>(c.request);
  if (!b || typeof b.email !== 'string' || b.email.length > 254 || !isClientKey(b.password)) return error(400, 'bad_request');
  if (normalizeEmail(b.email) === null) return error(400, 'bad_email', 'Revisa el correo: no parece una dirección válida');
  const blocked = await c.antiBot(b.turnstileToken);
  if (blocked !== null) return blocked;
  // Only the current key: an account whose password is still the legacy one signs in by its username (and re-keys there).
  const proof: PasswordProof = { v2: b.password };
  const chk = await checkPassword(c, { email: b.email }, proof, { signIn: true });
  if (!chk.ok) return chk.res;
  const rekey = await rekeyFor(c.env, chk.cred, proof);
  const linking = b.linkPending === true;
  const pending = linking ? await readPending(c) : null;
  const refreshTok = newRefreshToken();
  const fin = await accountsJson<UserRef & { linked?: OAuthProvider[]; linkError?: string }>(c.env, '/auth-finish', {
    userId: chk.cred.userId,
    email: b.email,
    ip: ipOf(c.request),
    ok: true,
    refresh: await grantFor(refreshTok, c.request),
    device: await deviceOf(c.env, c.request),
    proved: chk.cred.hash,
    charged: true,
    ...(rekey !== null ? { rekey } : {}),
    ...(pending !== null ? { pending: pendingBody(pending) } : {}),
    ...(b.cancelDeletion === true ? { cancelDeletion: true } : {}),
  });
  if (!fin.ok) return pass(fin.res);
  maintainerAlert(c, fin.data, 'password');
  return signedInAnswer(c, fin.data, [refreshCookie(refreshTok), await deviceCookie(c.env, fin.data.userId)], linking, pending);
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

/**
 * POST /api/auth/reset: the link checked first (a dead one costs no PBKDF2), then the password
 * stored and this browser signed in. linkPending (§2.4): the reset proved that account's mailbox,
 * so the identity pending in this browser goes on it under §3.8's rules (the match sheet's
 * "¿Olvidaste tu contraseña?"); a link the mail app opened in another browser links nothing.
 */
async function reset(c: RouteContext): Promise<Response> {
  const b = await readJson<{ token?: unknown; password?: unknown; lang?: unknown; linkPending?: unknown }>(c.request);
  const token = tokenOf(b);
  if (!b || token === null) return error(400, 'bad_request');
  if (!isClientKey(b.password)) return error(400, 'bad_password', 'Contraseña inválida');
  const peek = await accountsCall(c.env, '/reset-peek', { token });
  if (!peek.ok) return noStore(peek);
  await peek.text().catch(() => '');
  const linking = b.linkPending === true;
  const pending = linking ? await readPending(c) : null;
  const refreshTok = newRefreshToken();
  const r = await accountsJson<UserRef & { mail?: MailOrder | null; linked?: OAuthProvider[]; linkError?: string }>(c.env, '/reset', {
    token,
    pw: await newPasswordRecord(b.password, 2, await storeEnv(c.env)),
    refresh: await grantFor(refreshTok, c.request),
    ip: ipOf(c.request),
    lang: langOf(b.lang),
    ...(pending !== null ? { pending: pendingBody(pending) } : {}),
  });
  if (!r.ok) return withoutMail(c, r.res);
  sendMail(c, r.data.mail);
  const { mail: _mail, ...ref } = r.data;
  maintainerAlert(c, ref, 'reset');
  return signedInAnswer(c, ref, [refreshCookie(refreshTok), await deviceCookie(c.env, ref.userId)], linking, pending);
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
  maintainerAlert(c, r.data, 'reauthCode');
  return json(await accountSession(c.env, r.data), 200, NO_STORE);
}

// ---- adding and changing the email, preferences, the cutoff (sign-in PR 9: §2.1, §2.6, §2.9, §3.10) ----
//
//   POST /api/me/email            Bearer { email, lang } -> { attempt, resendAt, to }: the same answer for any
//                                 address (I6; M5 with the code, or M7 to an address another account holds) |
//                                 400 bad_email / same_email | 403 reauth_required { level } (an add fresh(1), a
//                                 change fresh(2); a legacy key first re-keyed: level 2; a project account's add
//                                 fresh(2) while it has a password: emailLevel) | 409 email_locked { until } | 429 |
//                                 503. Not from a TV.
//   POST /api/me/email/verify     Bearer (+ cookie) { attempt, code } -> MeInfo: the add, the change (M6 with the
//                                 7-day undo to the old address, which is held; the other devices signed out) or
//                                 the move (M12) | 400 code_wrong | 410 code_expired | 409 email_taken / move_refused |
//                                 429 / 503 when M6 or M12 could not go (mail off, the day's notice lane full):
//                                 then nothing changes, so no change ever applies without its undo link
//   POST /api/auth/email/confirm  { token } -> { ok, name, email }: the same by the mailed link, from any device
//   POST /api/auth/email/undo/peek { token } -> { name, email }: whom M6's undo is for (consumes nothing)
//   POST /api/auth/email/undo     { token, password } -> AccountSession + cookies (level 2): the old address back,
//                                 a new password, every device signed out, providers linked in the last 7 days
//                                 unlinked, the email locked for 7 days | 400 bad_password | 410 link_invalid
//   POST /api/me/prefs            Bearer { lang, tz } -> { ok }: the language and zone of the account's mail (Idioma
//                                 while signed in) | 400 bad_prefs. Not from a TV (it never sets the language).
//   GET  /api/config auth.legacy  { phase, until } (legacyConfig below): 'none' while LEGACY_PASSWORD_UNTIL is unset,
//                                 'grace' before its cutoff, 'closed' after it, when login and recover answer 410
//                                 legacy_closed { until } with no lookup

/** LEGACY_PASSWORD_UNTIL: a var (an ISO date), absent until the owner sets the cutoff (§3.10). Not in env.ts: this file reads it. */
type LegacyEnv = Env & { LEGACY_PASSWORD_UNTIL?: string };

/** The cutoff this isolate has heard of, by the var's value (it changes only with a deploy, the cutoff only with the var). */
let legacyCache: { value: string; until: number } | null = null;

/**
 * GET /api/config's auth.legacy (§2.1): with LEGACY_PASSWORD_UNTIL unset, { phase: 'none', until: null }
 * and no AccountsDO call; with a date, the cutoff the AccountsDO keeps (its date at 12:00 UTC, never
 * before 30 days after it first saw a value), asked once per isolate and value, and the phase from
 * this clock. An object that cannot answer: 'grace' with the var's own date, asked again next time.
 */
export async function legacyConfig(env: Env, now: number = Date.now()): Promise<LegacyState> {
  const value = (env as LegacyEnv).LEGACY_PASSWORD_UNTIL;
  const date = legacyDateOf(value);
  if (date === null || typeof value !== 'string') return { phase: 'none', until: null };
  let until = legacyCache !== null && legacyCache.value === value ? legacyCache.until : null;
  if (until === null) {
    const r = await accountsJson<LegacyState>(env, '/legacy').catch(() => null);
    if (r === null || !r.ok || typeof r.data.until !== 'number') return { phase: now >= date ? 'closed' : 'grace', until: date };
    until = r.data.until;
    legacyCache = { value, until };
  }
  return { phase: now >= until ? 'closed' : 'grace', until };
}

/** login's and recover's first step: after the cutoff, 410 legacy_closed { until } for every request, with no lookup. */
async function legacyGate(c: RouteContext): Promise<Response | null> {
  const L = await legacyConfig(c.env);
  return L.phase === 'closed' ? json({ ...LEGACY_CLOSED, until: L.until }, 410) : null;
}

/** POST /api/me/email (§2.6): an add (fresh(1); a project account's, fresh(2) with a password) or a change (fresh(2)) of the account's address, proved by a code to it. */
async function meEmail(c: RouteContext): Promise<Response> {
  const s = requirePrimary(c);
  if (s instanceof Response) return s;
  const b = await readJson<{ email?: unknown; lang?: unknown }>(c.request);
  if (!b) return error(400, 'bad_request');
  if (normalizeEmail(b.email) === null) return error(400, 'bad_email', 'Revisa el correo: no parece una dirección válida');
  const me = await accountsJson<{ name?: string; emailVerified?: boolean; hasPassword?: boolean; legacy?: boolean }>(c.env, '/me?userId=' + encodeURIComponent(s.sub));
  if (!me.ok) return pass(me.res);
  // A password still salted with the name is re-keyed first ("confirm it's you" with it): an address
  // never sits beside a key no route signs in with (§3.10 step 8: reauth works at any time).
  if (me.data.legacy === true) return reauthRequired(2);
  // An add needs fresh(1), a change fresh(2) (R6); an account that has an address has a level-2 proof.
  // A project account's add needs fresh(2) while it has a password (emailLevel): its reset link is level 2.
  const level = emailLevel(c.env, s.sub, me.data);
  const fresh = requireFresh(c, level);
  if (fresh instanceof Response) return fresh;
  const off = await mailRefusal(c);
  if (off !== null) return off;
  const attempt = base64urlEncode(randomBytes(32));
  const r = await accountsJson<{ resendAt: number; to: string; mail?: MailOrder | null; alert?: Pick<UserRef, 'userId' | 'username'> }>(c.env, '/me-email', { userId: s.sub, email: b.email, attempt, lang: langOf(b.lang), ip: ipOf(c.request) });
  if (!r.ok) return noStore(r.res);
  sendMail(c, r.data.mail);
  // The project account's address asked for: never moved (a decoy row, the same answer), and the staff channel hears of it.
  if (r.data.alert !== undefined) maintainerAlert(c, r.data.alert, 'emailMove');
  // A project account with no password adds its first address at level 1 (no lockout): the staff channel hears of it.
  if (level === 1 && me.data.emailVerified !== true) maintainerAlert(c, { userId: s.sub, username: typeof me.data.name === 'string' ? me.data.name : s.sub }, 'emailAdd');
  return json({ attempt, resendAt: r.data.resendAt, to: r.data.to } satisfies CodeStartAnswer, 200, NO_STORE);
}

/** The mails an applied add, change or move asks for (M6, M12), after the answer. */
function sendMails(c: RouteContext, orders: unknown): void {
  if (Array.isArray(orders)) for (const o of orders) sendMail(c, o as MailOrder);
}

/** The refresh cookie's hash, when there is one: a change keeps this device signed in, and only it. */
async function keepOf(c: RouteContext): Promise<string | undefined> {
  const token = cookieOf(c.request, REFRESH_COOKIE);
  return token && token.length <= 128 ? sha256Hex(token) : undefined;
}

/** POST /api/me/email/verify: the code of the account's own attempt, then the add, the change or the move. */
async function meEmailVerify(c: RouteContext): Promise<Response> {
  const s = requirePrimary(c);
  if (s instanceof Response) return s;
  const b = await readJson<{ attempt?: unknown; code?: unknown; lang?: unknown }>(c.request);
  const proof = proofBody(b);
  if (proof === null || 'token' in proof) return error(400, 'bad_request');
  const mailOff = (await mailRefusal(c)) !== null;
  const r = await accountsJson<Record<string, unknown> & { mail?: unknown }>(c.env, '/me-email-verify', { userId: s.sub, attempt: proof.attempt, code: proof.code, keep: await keepOf(c), providers: enabledProviders(c.env), lang: langOf(b?.lang), mailOff });
  if (!r.ok) return noStore(r.res);
  const { mail, ...me } = r.data;
  sendMails(c, mail);
  return json(me, 200, NO_STORE);
}

/** POST /api/auth/email/confirm: the mailed link of an add or a change, from any device (no session: the link proves the mailbox). */
async function emailConfirm(c: RouteContext): Promise<Response> {
  const b = await readJson<{ token?: unknown; lang?: unknown }>(c.request);
  const token = tokenOf(b);
  if (token === null) return error(400, 'bad_request');
  const mailOff = (await mailRefusal(c)) !== null;
  const r = await accountsJson<{ ok: true; name: string; email: string; mail?: unknown }>(c.env, '/email-confirm', { token, keep: await keepOf(c), providers: enabledProviders(c.env), lang: langOf(b?.lang), mailOff });
  if (!r.ok) return noStore(r.res);
  sendMails(c, r.data.mail);
  return json({ ok: true, name: r.data.name, email: r.data.email } satisfies EmailConfirmAnswer, 200, NO_STORE);
}

/** POST /api/auth/email/undo/peek: whom the undo sheet is for. Consumes nothing. */
async function emailUndoPeek(c: RouteContext): Promise<Response> {
  const token = tokenOf(await readJson<{ token?: unknown }>(c.request));
  if (token === null) return error(400, 'bad_request');
  return noStore(await accountsCall(c.env, '/email-undo-peek', { token }));
}

/** POST /api/auth/email/undo: M6's link, checked first (a dead one costs no PBKDF2), then the account back on its old address. */
async function emailUndo(c: RouteContext): Promise<Response> {
  const b = await readJson<{ token?: unknown; password?: unknown }>(c.request);
  const token = tokenOf(b);
  if (!b || token === null) return error(400, 'bad_request');
  if (!isClientKey(b.password)) return error(400, 'bad_password', 'Contraseña inválida');
  const peek = await accountsCall(c.env, '/email-undo-peek', { token });
  if (!peek.ok) return noStore(peek);
  await peek.text().catch(() => '');
  const refreshTok = newRefreshToken();
  const r = await accountsJson<UserRef>(c.env, '/email-undo', { token, pw: await newPasswordRecord(b.password, 2, await storeEnv(c.env)), refresh: await grantFor(refreshTok, c.request) });
  if (!r.ok) return noStore(r.res);
  maintainerAlert(c, r.data, 'undo');
  return withCookies(json(await accountSession(c.env, r.data)), [refreshCookie(refreshTok), await deviceCookie(c.env, r.data.userId)]);
}

/** POST /api/me/prefs { lang, tz } (§2.9): Idioma while signed in, never from a TV. */
async function mePrefs(c: RouteContext): Promise<Response> {
  const s = requirePrimary(c);
  if (s instanceof Response) return s;
  const b = await readJson<{ lang?: unknown; tz?: unknown }>(c.request);
  const tz = typeof b?.tz === 'string' ? b.tz : '';
  if (!b || (b.lang !== 'es' && b.lang !== 'en') || (tz !== '' && timeZoneOf(tz) === '')) return error(400, 'bad_prefs', 'Idioma o zona horaria inválidos');
  return noStore(await accountsCall(c.env, '/me-prefs', { userId: s.sub, lang: b.lang, tz }));
}

// ---- account deletion (sign-in PR 12: §2.10, §3.13; no button until the terms) ----------------------
//
//   POST /api/me/delete           Bearer { confirm: <the username, typed>, lang? } -> { purgeAt } + the refresh
//                                 cookie cleared (every device signed out, this one too; M9 with its cancel link
//                                 to a verified address, both languages) | 400 bad_confirm | 403 reauth_required
//                                 { level } (fresh(2), capped by the account's ceiling: a Discord-only account
//                                 without an email deletes at level 1) / tv_session / banned | 409
//                                 maintainer_account (NODE_TRUSTED_OPERATORS) / deletion_pending { purgeAt } |
//                                 429 / 503 when M9 cannot go or the account's caps are full (nothing changes).
//                                 Closed (404 not_found, as an unknown route) unless DELETION_OPEN=1 (env.ts):
//                                 it opens with the terms of service and the screens that call a deletion off.
//   POST /api/auth/delete/cancel  { token } -> { ok } | 410 link_invalid: M9's link calls the deletion off
//   Until the purge (DELETE_GRACE days, 14), signin and login answer 409 deletion_pending { purgeAt } after
//   the right password, and the OAuth callback /#auth=error:deletion_pending; sent again with
//   cancelDeletion: true (cancelDel=1 on the OAuth start) they call it off and sign in. reset, the email
//   undo and recover set the password and answer the same 409, with no session.

/** POST /api/me/delete { confirm, lang? } (§2.10): the AccountsDO decides the level the account needs (its ceiling) and every refusal. */
async function meDelete(c: RouteContext): Promise<Response> {
  // Until the terms of service and their screens (env.ts DELETION_OPEN): the answer of a route that does not exist.
  if (!deletionOpen(c.env)) return error(404, 'not_found');
  const s = requirePrimary(c);
  if (s instanceof Response) return s;
  const b = await readJson<{ confirm?: unknown; lang?: unknown }>(c.request);
  if (!b) return error(400, 'bad_request');
  const mailOff = (await mailRefusal(c)) !== null;
  const r = await accountsJson<{ purgeAt: number; mail?: MailOrder | null }>(c.env, '/me-delete', {
    userId: s.sub,
    confirm: typeof b.confirm === 'string' ? b.confirm.slice(0, 128) : null,
    level: freshLevel(s),
    mailOff,
    lang: langOf(b.lang),
  });
  if (!r.ok) return noStore(r.res);
  sendMail(c, r.data.mail);
  // Every family was revoked, this device's too: its cookie goes (its Bearer ends within the hour).
  return withCookies(json({ purgeAt: r.data.purgeAt }, 200, NO_STORE), [clearCookie(REFRESH_COOKIE)]);
}

/** POST /api/auth/delete/cancel { token }: M9's link, from any device (no session: the link proves the mailbox). */
async function deleteCancel(c: RouteContext): Promise<Response> {
  const token = tokenOf(await readJson<{ token?: unknown }>(c.request));
  if (token === null) return error(400, 'bad_request');
  return noStore(await accountsCall(c.env, '/delete-cancel', { token }));
}

// ---- the news consent and unsubscribing (sign-in PR 13: §2.11, §3.14; no news is sent yet) ----------
//
//   POST /api/me/consent          Bearer (account, not a TV) { kind: 'news', granted } -> { news, terms } | 400
//                                 bad_consent | 403 tv_session | 409 email_required (a grant needs a verified address)
//                                 / deletion_pending { purgeAt } | 429. PERFIL's switch, the game's Origin and JSON (R1).
//   POST /api/news/unsubscribe    two forms, one answer, { ok: true } for any id (an unknown or spent one too), so
//                                 ids cannot be tested; that id's account gets a news withdrawal and a new id:
//                                 1. the page's (/account#unsub=<id>): JSON { u }, the game's Origin (R1);
//                                 2. RFC 8058's one-click, the mail provider's POST: ?u=<id> with the body
//                                    List-Unsubscribe=One-Click (application/x-www-form-urlencoded, or
//                                    multipart/form-data), no Origin needed. The one route that reads a value from
//                                    the query (R8) and takes a form: it can only withdraw the news consent, and
//                                    the id carries nothing of the account (16 random bytes, rotated on use).
//                                 Outside /api/auth/*, so the login-CSRF gate (crossSiteRefusal) does not run
//                                 before it: its JSON form asks for it itself.

/** POST /api/me/consent { kind: 'news', granted } (§2.11): a full Bearer (not a TV's); the AccountsDO decides every refusal. */
async function meConsent(c: RouteContext): Promise<Response> {
  const refused = crossSiteRefusal(c, '/api/me/consent');
  if (refused !== null) return refused;
  const s = requirePrimary(c);
  if (s instanceof Response) return s;
  const b = await readJson<{ kind?: unknown; granted?: unknown }>(c.request);
  if (!b || b.kind !== 'news' || typeof b.granted !== 'boolean') return error(400, 'bad_consent', 'Consentimiento inválido');
  return noStore(await accountsCall(c.env, '/me-consent', { userId: s.sub, kind: 'news', granted: b.granted }));
}

/** The media type of a request's body, lower case, without its parameters. */
function bodyType(request: Request): string {
  return (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
}

/** The one-click form's body (RFC 8058 §3.1): List-Unsubscribe=One-Click, as either form encoding, at most 4 KB. */
async function oneClickBody(request: Request, type: string): Promise<boolean> {
  const bytes = await readCapped(request, JSON_MAX_BYTES);
  if (bytes === null) return false;
  try {
    if (type === 'application/x-www-form-urlencoded') return new URLSearchParams(new TextDecoder().decode(bytes)).get('List-Unsubscribe') === 'One-Click';
    const form = await new Response(bytes, { headers: { 'content-type': request.headers.get('content-type') ?? '' } }).formData();
    return form.get('List-Unsubscribe') === 'One-Click';
  } catch {
    return false;
  }
}

/** POST /api/news/unsubscribe (§2.11): the page's JSON form or RFC 8058's one-click; the same answer for any id. */
async function newsUnsubscribe(c: RouteContext, url: URL): Promise<Response> {
  const type = bodyType(c.request);
  let u: unknown;
  if (type === 'application/x-www-form-urlencoded' || type === 'multipart/form-data') {
    // The one-click: no cookie, no Bearer, often no Origin (the mail provider's servers send it).
    if (!(await oneClickBody(c.request, type))) return error(400, 'bad_request', 'Se espera List-Unsubscribe=One-Click');
    u = url.searchParams.get('u');
  } else {
    // The page's: every other POST's rule (R1). Its id is in the body, never in the query (R8).
    const refused = crossSiteRefusal(c, '/api/news/unsubscribe');
    if (refused !== null) return refused;
    const b = await readJson<{ u?: unknown }>(c.request);
    if (!b) return error(400, 'bad_request');
    u = b.u;
  }
  // A malformed id is answered as an unknown one, without the AccountsDO.
  if (typeof u === 'string' && UNSUB_ID_RE.test(u)) {
    const r = await accountsCall(c.env, '/news-unsubscribe', { u });
    if (!r.ok) return noStore(r);
    await r.text().catch(() => '');
  }
  return json({ ok: true }, 200, NO_STORE);
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
/** A TV renews once in a code's life (about every 3.7 minutes): this many a minute per /64 is a few hundred TVs behind one address. */
const LIMIT_TV_RENEW = 60;

/**
 * POST /api/auth/tv/start { turnstileToken? }. A solved check makes the code cost one (the TV
 * renders it as a guest's start does): a script filling the table, or minting a code per phishing
 * click, pays one per code. A TV whose check wants a press (a remote cannot answer Cloudflare's
 * challenge) or cannot load it asks with no token: its code counts under tighter caps of its own
 * (tvCodes.ts TV_OPEN_*: a few per network, a tenth of the table), so a TV is never locked out and
 * a script that skips the check gets those few codes and no more. A token that fails is refused.
 */
async function tvStart(c: RouteContext): Promise<Response> {
  if (c.limited('tvs:' + ipKey(ipOf(c.request)), LIMIT_TV_START)) return error(429, 'rate_limited');
  const b = await readJson<{ turnstileToken?: unknown }>(c.request);
  if (!b) return error(400, 'bad_request');
  let checked = true;
  if (b.turnstileToken === undefined || b.turnstileToken === null) {
    // No token: checked anyway where the gate is off (local dev, TURNSTILE_DISABLED), else the open caps.
    checked = (await c.antiBot(undefined)) === null;
  } else {
    const blocked = await c.antiBot(b.turnstileToken);
    if (blocked !== null) return blocked;
  }
  const secret = base64urlEncode(randomBytes(32));
  const r = await accountsJson<{ code: string; expiresAt: number }>(c.env, '/tv-start', { ip: ipOf(c.request), secret: await sha256Hex(secret), where: whereOfRequest(c.request), checked });
  if (!r.ok) return pass(r.res);
  const out: TvStartAnswer = { code: r.data.code, secret, expiresAt: r.data.expiresAt, ttlMs: Math.max(0, r.data.expiresAt - Date.now()), pollMs: TV_POLL_MS };
  return noStore(json(out));
}

/**
 * POST /api/auth/tv/renew { code, secret } (§2.14): the TV, 20 s before its code ends, gets a new
 * one bound to the same secret, so it shows a live code for about 28 minutes and nobody presses
 * NUEVO CÓDIGO. No check (a TV cannot answer one again): the secret is the proof, and each renewal
 * counts toward the start's caps, at most 6 per start. A code is renewed once, in its last minute (a
 * repeat answers the same new code), so one solved check is one chain, never a tree of codes
 * (tvCodes.ts renew). 409 tv_code_used: the phone confirmed the old code (the TV polls it); 409
 * tv_renew_early: more than its last minute left; 410 tv_code_expired: gone, or the renewals used
 * up; 503 busy: the caps.
 */
async function tvRenew(c: RouteContext): Promise<Response> {
  if (c.limited('tvr:' + ipKey(ipOf(c.request)), LIMIT_TV_RENEW)) return error(429, 'rate_limited');
  const b = await readJson<{ code?: unknown; secret?: unknown }>(c.request);
  const code = tvCode(b?.code);
  if (code === null || typeof b?.secret !== 'string' || b.secret.length === 0 || b.secret.length > 128) return error(400, 'bad_request');
  const r = await accountsJson<{ code: string; expiresAt: number }>(c.env, '/tv-renew', { code, secret: await sha256Hex(b.secret), ip: ipOf(c.request), where: whereOfRequest(c.request) });
  if (!r.ok) return noStore(pass(r.res));
  return noStore(json({ code: r.data.code, expiresAt: r.data.expiresAt, ttlMs: Math.max(0, r.data.expiresAt - Date.now()) }));
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

// ---- dev only (the sign-in design's §2.12 and §3.15) -----------------------------------------------

/**
 * The dev-only routes, for local work and for forks without provider secrets. They open only
 * behind mail.ts isDevAuth: DEV_AUTH=1 (in your own server/.dev.vars), a loopback request host
 * (wrangler dev; production's is turbo-gol.com) and no Origin or a loopback one. Closed, each one
 * answers 404 not_found, the answer of any unknown route (index.ts does not even route them here
 * then, so a closed one is never counted by a limit either).
 *   POST /api/dev/signin { name } -> AccountSession + refresh cookie: the account of that dev name,
 *        made at its first use (accountStore.ts devSignIn: <name>@dev.invalid, verified; level 2,
 *        method 'dev'); 400 bad_name (1-32 of A-Z a-z 0-9 _ -); 403 banned
 *   GET  /api/dev/mail -> { messages }: what the stub mailer "sent", newest first (mail.ts devMailResponse)
 */
async function devRoute(c: RouteContext, p: string, m: string): Promise<Response> {
  if (m === 'GET' && p === '/api/dev/mail') return devMailResponse(c.request, c.env);
  if (m !== 'POST' || p !== '/api/dev/signin' || !isDevAuth(c.request, c.env)) return error(404, 'not_found');
  if ((c.request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') return error(415, 'json_required', 'Se espera JSON');
  const b = await readJson<{ name?: unknown }>(c.request);
  if (!b || devSubOf(b.name) === null) return error(400, 'bad_name', DEV_NAME_PROBLEM);
  const refreshTok = newRefreshToken();
  const r = await accountsJson<UserRef>(c.env, '/dev-signin', { name: b.name, refresh: await grantFor(refreshTok, c.request) });
  if (!r.ok) return pass(r.res);
  return withCookies(json(await accountSession(c.env, r.data)), [refreshCookie(refreshTok)]);
}

/** Dispatch; null when the path is not an account route. */
export async function accountRoute(c: RouteContext, url: URL): Promise<Response | null> {
  const p = url.pathname;
  const m = c.request.method;
  if (p.startsWith('/api/dev/')) return devRoute(c, p, m);
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
    if (p === '/api/me/replay-name') return replayName(c);
    if (p === '/api/auth/tv/start') return tvStart(c);
    if (p === '/api/auth/tv/info') return tvInfo(c);
    if (p === '/api/auth/tv/confirm') return tvConfirm(c);
    if (p === '/api/auth/tv/poll') return tvPoll(c);
    if (p === '/api/auth/tv/renew') return tvRenew(c);
    if (p === '/api/auth/pending') return pendingInfo(c);
    if (p === '/api/auth/pending/create') return pendingCreate(c);
    if (p === '/api/auth/pending/cancel') return pendingCancel();
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
    // Adding and changing the email, and the mail's language (sign-in PR 9).
    if (p === '/api/me/email') return meEmail(c);
    if (p === '/api/me/email/verify') return meEmailVerify(c);
    if (p === '/api/auth/email/confirm') return emailConfirm(c);
    if (p === '/api/auth/email/undo/peek') return emailUndoPeek(c);
    if (p === '/api/auth/email/undo') return emailUndo(c);
    if (p === '/api/me/prefs') return mePrefs(c);
    // Account deletion (sign-in PR 12).
    if (p === '/api/me/delete') return meDelete(c);
    if (p === '/api/auth/delete/cancel') return deleteCancel(c);
    // The news consent and unsubscribing (sign-in PR 13).
    if (p === '/api/me/consent') return meConsent(c);
    if (p === '/api/news/unsubscribe') return newsUnsubscribe(c, url);
  }
  if (m === 'GET') {
    if (p === '/api/me') return me(c);
    if (p === '/api/me/experimental') return experimentalGet(c);
    if (p === '/api/me/replay-name') return replayName(c);
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
