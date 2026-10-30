/**
 * AccountsDO: the one Durable Object that owns every registered account, rating and ranked
 * result (SQLite storage: AccountStore). Reached only from this deployment (internal header): the
 * Worker routes in accountRoutes.ts do the hashing / cookies / OAuth and call these endpoints; the
 * MatchDO reports ranked matches; the matchmaker never talks to it (the Worker passes ratings in).
 *
 *   (POST /register, /password and /recovery went with sign-in PR 7: accounts are made by email
 *   (/signup-finish), a password changes by /me-password or /reset, and no recovery code is minted.)
 *   POST /auth-begin      { username | email, ip, account?, device?, charge? } -> Credentials | { found: false } | 429
 *                         throttled (`email`: the email sign-in, the account and its counters by the typed canon)
 *   POST /auth-finish     { username, ip, account?, device?, ok: false, charged? } -> { ok: false } (one failure
 *                         counted, unless the begin charged it)
 *                         { username, ip, account, ok: true, charged } -> { ok: true } (a password proved behind
 *                         a session: its 'pa:' counter starts again)
 *                         { userId, username, ip, device?, ok: true, refresh, proved, rekey?, charged? } -> UserRef
 *                         (signed in at level 2, method 'legacy') | 401 bad_credentials (the password changed meanwhile)
 *     `charge`: the Worker is about to check a password, and that check counts as a failure now, in
 *     the same synchronous step as the test of the locks: requests in flight at once never get more
 *     checks than a counter lets through (a burst). `charged` at the finish: so counted already; a
 *     success clears the pair's and who's counters and gives the network's and the /48's back. A
 *     Worker of before (the minutes of a deploy) sends neither, and its failure counts at the finish.
 *     The Worker's recovery only asks (no charge): /recover tests and counts in one step itself.
 *     `account`: the password is checked behind a session of that account (the 'pa:' counter);
 *     `device`: { user, id } of this browser's device cookie (accountRoutes.ts deviceOf, its MAC
 *     checked): it signed in to that account before (the 'd:' counter, not the username's cap).
 *     `proved`: the hash the Worker checked the password against, which must still be the stored
 *     one (a body without it, from a Worker of before in the minutes of a deploy, stores nothing);
 *     `rekey`: the password stored again with it (the legacy key re-keyed to the current one, or
 *     re-hashed with the current pepper), in the sign-in's transaction.
 *   POST /refresh         { old, oldFamily?, next }                  -> UserRef | 401 bad_refresh | 401 refresh_reused
 *                                                                     (the family revoked) | 409 refresh_race (two tabs)
 *   POST /refresh-owner   { hash }                                   -> UserRef & { kind, device } | 404
 *   POST /logout          { hash, family? }                          (that device: its whole family, the one the
 *                                                                     token names too, live or rotated)
 *   POST /sessions        { userId, current? }                       -> { sessions: DeviceRow[] }
 *   POST /sessions/revoke { userId, id }                             -> { revoked } (that device's tokens)
 *   POST /sessions/revoke-all { userId }                             -> { revoked } (every device, this one too)
 *     `refresh` / `next` in every call that stores one: a RefreshGrant { hash, family?, kind?, country?,
 *     city? } (accountStore.ts), or the hash alone (a family of its own).
 *   POST /recover         { username, code, pw, refresh, ip, device? } -> UserRef & { codesLeft } (level 2, method
 *                                                                     'reset') | 401 (an account with a verified email
 *                                                                     too) | 429
 *   POST /oauth           { provider, providerId, email, trust, linkTo, refresh, replace?, lvl, pending? } -> UserRef
 *                                                                     (& { linked } | { linkError } with `pending`) |
 *                                                                     { pending: true } (nobody has it: nothing is made) |
 *                                                                     409 already_linked (another account's) | 409 provider_set
 *                                                                     (the account has another of it) | 403 no_user (suspended);
 *                                                                     `replace`: the device that asked (its tokens go: the
 *                                                                     browser takes the new one), gone meanwhile = 401 link_expired
 *     `lvl`: the level of the press on the provider's page (R6: 1 for Google's account chooser and
 *     Discord's Authorize, 0 for a start from before levels), at most 1 here. `email`, `trust`: the
 *     provider's address and how far it vouches for it (accountRoutes.ts providerTrust), which an
 *     account without a verified one takes as its email or its hint. `pending`: the identity pending
 *     in this browser ("I already have one", pend=1), linked to the account that signs in.
 *   POST /pending-match   { pending }                                -> { match: { name, methods, via, email } | null }
 *   POST /pending-create  { pending, username, refresh, ip, lvl, lang?, tz?, news? } -> UserRef | 400 bad_username /
 *                                                                     name_reserved { suggest } | 409 username_taken /
 *                                                                     name_lookalike { suggest } | 409 email_has_account |
 *                                                                     409 already_linked | 429 rate_limited (the network's
 *                                                                     new accounts: NEW_ACCOUNTS, one budget with
 *                                                                     /signup-finish)
 *     The confirm step (the sign-in design's §2.7): `pending` is the Worker's signed pending cookie,
 *     { p, id, email, trust, p2? }. /auth-finish takes it too (linkPending: the legacy sign-in's and
 *     the email sign-in's), and so does /reset.
 *   POST /oauth-reauth    { provider, providerId, userId, refresh, replace, lvl } -> UserRef | 409 reauth_mismatch
 *   POST /reauth          { userId, hash, proved, rekey? }           -> UserRef (that token proves a credential now, at
 *                                                                     level 2) | 401
 *   POST /unlink          { userId, provider, level }                -> { ok } | 409 last_method | 404 not_linked | 403
 *                                                                     reauth_required { level: 2 } (one way in would be
 *                                                                     left and the session is below the account's ceiling)
 *   POST /rename          { userId, username, lang? }                -> UserRef | 409 username_taken { suggest } | 409
 *                                                                     name_lookalike { suggest } (the skeleton of a protected
 *                                                                     account: accountStore.ts protected_skel) | 429 too_soon
 *   GET  /me?userId=                                                 -> MeInfo | 404
 *   GET  /pw-labels                                                  -> { ok } (this code keeps a password record's
 *                                                                     pw_v and pw_kid: the Worker peppers a record only
 *                                                                     then; an object of before answers 404)
 *   POST /ranked-check    { userId, playlists }                      -> RankedCheck
 *   POST /ranked-lock     { matchId, region, userIds, until }
 *   POST /ranked-result   RankedResultInput                          -> { ok, applied }
 *   POST /ranked-cancel   { matchId, playlist, region, players, noShows, reason } -> { ok, applied }
 *   GET  /ranked-result?matchId=&userId=                             -> RankedResultAnswer
 *   GET  /leaderboard?playlist=&limit=&userId=                       -> LeaderboardAnswer
 *   POST /training        { userId, records }                        -> { records } (merged, best per pack) | 404
 *   GET  /experimental?userId=                                       -> ExperimentalAnswer | 404
 *   POST /experimental/set { userId, enabled }                       -> ExperimentalAnswer | 404
 *   POST /presets/upsert  { userId, preset }                         -> ExperimentalAnswer | 400 bad_preset | 409 too_many | 404
 *   POST /presets/delete  { userId, id }                             -> ExperimentalAnswer | 400 bad_preset | 404
 *   GET  /replay-name?userId=                                        -> { hidden } | 404 (PERFIL's "hide my name")
 *   POST /replay-name/set { userId, hidden }                         -> { hidden } | 404
 *   POST /replay-hidden   { ids, names } (the NodeRegistryDO)        -> { ids, names }: those of an account that hides
 *                                                                     its name in the public replays (256 each at most)
 *   POST /tv-start        { ip, secret, where?, checked? }           -> { code, expiresAt } | 503 busy (the table, or the
 *                                                                     caller's /48 or /24, is full; `checked` false: started
 *                                                                     without a solved check, tvCodes.ts TV_OPEN_* too)
 *   POST /tv-renew        { code, secret, ip, where? }               -> { code, expiresAt } (a new code, the same secret;
 *                                                                     a code renewed already: that one again) | 409
 *                                                                     tv_code_used | 409 tv_renew_early (more than its
 *                                                                     last minute left) | 410 tv_code_expired | 503 busy
 *   POST /tv-info         { code, userId, username, ip, phone? }     -> TvInfo (where the TV is, the phone's network and
 *                                                                     country beside it) | the refusals of /tv-confirm
 *   POST /tv-confirm      { code, userId, username, ip }             -> { ok } | 404 tv_code_wrong | 410 tv_code_expired
 *                                                                     | 409 tv_code_used | 429 throttled | 403 banned
 *   POST /tv-poll         { code, secret, refresh }                  -> { state: 'pending' } | UserRef (approved: the
 *                                                                     refresh row added) | 410 (a wrong secret too: as
 *                                                                     an unknown code) | 409 | 403 banned
 *     The TV's sign-in with the phone (tvCodes.ts, in memory): `secret` is the SHA-256 of the
 *     device secret the Worker made, `refresh` the hash of the refresh token it issues on approval.
 *   GET  /items?userId=                                              -> ItemsAnswer | 404
 *   POST /car             { userId, car }                            -> UserRef (the session to mint) | 400 bad_car | 409 not_owned | 404
 *   POST /equipped        { userIds } (a lobby's start, LobbyDO)     -> { cars: { [userId]: CarId } } (unknown / banned left out)
 *   GET  /shop?userId=                                               -> ShopAnswer | 404
 *   POST /shop/claim      { userId, item }                           -> ClaimAnswer | 404 unknown_item | 409 <ClaimRefusal> | 404
 *   POST /host-credit     HostCredit (the NodeRegistryDO's outbox)    -> { ok, applied } (once per matchId)
 *   POST /host-freeze     { userId, reason, at } (the outbox)        -> { ok, applied }
 *   POST /host-grant      { userId, item } (a maintainer, through the NodeRegistryDO) -> { granted, items } | 404
 *   POST /host-revoke     { userId, item }                           -> { revoked, refunded, items }
 *   POST /host-unfreeze   { userId }                                 -> { unfrozen }
 *   The email accounts (sign-in PR 7; emailPost): each answer's `mail` is what the Worker sends after
 *   it answers (R7), never shown to a client; the caps and lanes are mail_rate's and mail_day's.
 *   POST /signup-start    { email, attempt, lang?, ip }              -> { resendAt, codeLength, mail } | 400 bad_email | 429
 *                                                                     | 503 email_paused (one row for any address, I6)
 *   POST /signup-check    { attempt, code } | { token }              -> { email } | 400 code_wrong | 410 | 409 already_created
 *   POST /signup-finish   proof, { username, pw, news, lang, tz, terms?, refresh, ip } -> UserRef & { email } | 400 | 409 | 410 | 429
 *                                                                     (429: the network's new accounts, NEW_ACCOUNTS, one
 *                                                                     budget with /pending-create)
 *   POST /code-resend     { attempt, ip, userId? }                   -> { resendAt, resendsLeft, mail } | 410 | 429 | 503
 *   POST /mail-failed     { kind, lane }                             -> { paused, alert } (the signup lane's automatic pause)
 *   Adding and changing the email, and the cutoff (sign-in PR 9, the design's §2.6, §2.9, §3.10):
 *   POST /me-email        { userId, email, attempt, lang?, ip }      -> { resendAt, to, mail } | 400 bad_email / same_email
 *                                                                     | 409 email_locked { until } | 429 | 503 (one row for any
 *                                                                     address: M5, M7 "move" with its code, or a decoy, I6)
 *   POST /me-email-verify { userId, attempt, code, keep?, providers?, lang? } -> MeInfo & { mail } | 400 code_wrong | 410
 *                                                                     | 409 email_taken / move_refused
 *   POST /email-confirm   { token, keep?, providers?, lang? }        -> { ok, name, email, mail } | 410 link_invalid | 409
 *   POST /email-undo-peek { token }                                  -> { name, email } | 410 link_invalid
 *   POST /email-undo      { token, pw, refresh }                     -> UserRef (level 2) | 410 link_invalid
 *   POST /me-prefs        { userId, lang, tz }                       -> { ok } | 400 bad_prefs
 *   GET  /legacy                                                     -> { phase, until }: LEGACY_PASSWORD_UNTIL's phase and
 *                                                                     cutoff (meta.legacy_seen + 30 days at least); after
 *                                                                     it /auth-begin (a username, no session) and /recover
 *                                                                     answer 410 legacy_closed, and the daily alarm sends M10
 *                                                                     in its last 7 days
 *   POST /account-stats   { operatorIds, trusted } (a maintainer, nodeRoutes.ts) -> AccountStats: counts and
 *                                                                     booleans only (accountStore.ts accountStats);
 *                                                                     operatorIds null = unknown (no node settings)
 *   POST /dev-signin      { name, refresh }                          -> UserRef & { created } (accountStore.ts devSignIn) |
 *                                                                     400 bad_name | 403 banned; 404 unless DEV_AUTH is '1'
 *                                                                     (the Worker's gate: mail.ts isDevAuth)
 *
 * Brute force: durable counters in SQLite (accountStore.ts auth_throttle), exact and global, so a
 * restart or an eviction forgets none and memory never grows with them. Each key is a kind and an
 * HMAC of its value under a key of its own (HKDF of JWT_SECRET, info 'limits'): the table holds no
 * username or address. Every counter counts the typed username whether or not an account has it
 * (I6). A sign-in or a recovery (every one also needs a solved Turnstile check, accountRoutes.ts):
 *   (username, network)  LOGIN_FAILS_FREE failures, then waits of 30 s doubling to LOGIN_LOCK_MAX_MS:
 *                        failures from elsewhere never lock the owner out of their own account
 *   network              an IPv4 address or an IPv6 /64, from browsers the account does not know:
 *                        LOGIN_NET4_MAX / LOGIN_NET6_MAX failures in 15 minutes (a carrier's CGNAT, a
 *                        school, a LAN party share one address, and a dual-stack school or LAN is one
 *                        /64), then a LOGIN_NET_PAUSE_MS pause for that network; an IPv6 /48 (65,536
 *                        /64s, one free allocation) LOGIN_WIDE_MAX, the same pause, which a single /64
 *                        reaches first: rotating /64s inside one allocation gains nothing
 *   username             from browsers it does not know: LOGIN_USER_DAY_MAX failures in a day, then its
 *                        password sign-in pauses for 15 minutes, doubling to an hour (OAuth still works)
 *   known browser        a browser with the account's device cookie (set at each password sign-in)
 *                        counts on its own 'd:' counter instead of the username's, which locks like a
 *                        pair, and on its pair; never on a network or a /48, whose pause never stops it
 * Each check counts as it starts (/auth-begin `charge`, in the step that tests the locks), so checks
 * in flight at once never pass a cap; a success gives the network's and the /48's charge back, and
 * clears the pair, the username and the device's counters. A password checked behind a
 * session of the account (no Turnstile token to ask) counts only per account ('pa:'), locked like a
 * pair from any network. The daily alarm prunes the rows that are over (accountStore.ts prune).
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import { EXPERIMENTAL_REFUSED, carriesPhysics, error, json, limitKey, trustedOperatorIds } from './env';
import { base64urlEncode, checkInternal } from './auth';
import { AccountStore, DEV_NAME_PROBLEM } from './accountStore';
import { CODE_TRIES, LEGACY_CLOSED, LEGACY_REMIND_MS, legacyDateOf } from './accountStore';
import type { EmailApplied, LegacyState, MailOrder, MailProfile, MailTokenRow } from './accountStore';
import { FAILURES, MAIL_CAPS, RESEND, alertAfterFailures, dailyCap, laneAllows, mailDay, mailKilled, networkCap, pauseAfterFailures, takeSlot } from './mailCaps';
import type { MailLane, MailWindow, WindowCap } from './mailCaps';
import { mailLang, renderMail } from './mailTemplates';
import type { MailLang, Provider } from './mailTemplates';
import { chooseMailer, composeMail, deliver, linkOrigin } from './mail';
import { TvCodes, tvCode } from './tvCodes';
import type { TvWhere } from './tvCodes';
import { sitePrefix } from './limits';
import type { Credentials, HostCredit, LinkPendingResult, PasswordRecord, PendingIdent, PendingIdentity, ProviderEmail, ProviderTrust, RankedResultInput, RefreshGrant, ThrottleEntry } from './accountStore';
import { emailCanon, isPlaylist, maskEmail, normalizeEmail, OAUTH_PROVIDERS, usernameIssue, usernameKey, usernameProblem } from '../../src/net/account';
import { parseTrainingRecords } from '../../src/game/trainingRecords';
import { PRESET_ID_RE, parseStoredPreset } from '../../src/game/physicsRules';
import type { OAuthProvider, Playlist } from '../../src/net/account';
import { isCarId } from '../../src/game/cosmetics';
import { ITEM_ID_RE } from '../../nodes/control-plane/shop';

const LOGIN_WINDOW_MS = 15 * 60_000;
/** The most accounts one /equipped asks for (a lobby's members: a 3v3). */
const EQUIPPED_MAX = 6;
/** /replay-hidden: a page of the public replays at most (31 rows of 8 seats), ids and names each. */
const REPLAY_HIDDEN_MAX = 256;
export const LOGIN_FAILS_FREE = 5;
const LOGIN_LOCK_BASE_MS = 30_000;
export const LOGIN_LOCK_MAX_MS = 15 * 60_000;
/** Failures per IPv4 address in LOGIN_WINDOW_MS before it pauses: a carrier's CGNAT, a school or a LAN party shares one. */
export const LOGIN_NET4_MAX = 600;
/**
 * Failures per IPv6 /64 in LOGIN_WINDOW_MS before it pauses: an IPv4 address's (the review of
 * sign-in PR 4; the design's §2.3 said 30). A dual-stack school or LAN party is one /64 (SLAAC), and
 * 30 typos of a classroom would pause everyone's password sign-in in it. Its /48's LOGIN_WIDE_MAX
 * still binds first, so one /64 gets that many.
 */
export const LOGIN_NET6_MAX = LOGIN_NET4_MAX;
/** Failures per IPv6 /48 in LOGIN_WINDOW_MS before it pauses. */
export const LOGIN_WIDE_MAX = 300;
/** How long a network (or a /48) over its cap pauses password sign-in. */
export const LOGIN_NET_PAUSE_MS = 15 * 60_000;
/**
 * Failures on one username in LOGIN_DAY_MS from browsers it does not know (no device cookie of
 * the account, no session of it) before its password sign-in pauses for LOGIN_USER_PAUSE_MS,
 * doubling up to LOGIN_USER_PAUSE_MAX_MS: a targeted guesser gets about this many a day, however
 * many networks and solved checks it buys, and nobody locks an owner out for good.
 */
export const LOGIN_USER_DAY_MAX = 50;
export const LOGIN_DAY_MS = 24 * 60 * 60_000;
export const LOGIN_USER_PAUSE_MS = 15 * 60_000;
export const LOGIN_USER_PAUSE_MAX_MS = 60 * 60_000;

/** One counter's policy: its window, the failures it lets through, then a wait of baseMs doubling to maxMs. */
export interface ThrottleRule {
  windowMs: number;
  free: number;
  baseMs: number;
  maxMs: number;
}

/** The counters of the header comment. */
export const THROTTLE_RULES = {
  /** A (username, network) pair, a known browser ('d:'), a session's own checks ('pa:'). */
  pair: { windowMs: LOGIN_WINDOW_MS, free: LOGIN_FAILS_FREE, baseMs: LOGIN_LOCK_BASE_MS, maxMs: LOGIN_LOCK_MAX_MS },
  user: { windowMs: LOGIN_DAY_MS, free: LOGIN_USER_DAY_MAX, baseMs: LOGIN_USER_PAUSE_MS, maxMs: LOGIN_USER_PAUSE_MAX_MS },
  net4: { windowMs: LOGIN_WINDOW_MS, free: LOGIN_NET4_MAX, baseMs: LOGIN_NET_PAUSE_MS, maxMs: LOGIN_NET_PAUSE_MS },
  net6: { windowMs: LOGIN_WINDOW_MS, free: LOGIN_NET6_MAX, baseMs: LOGIN_NET_PAUSE_MS, maxMs: LOGIN_NET_PAUSE_MS },
  site: { windowMs: LOGIN_WINDOW_MS, free: LOGIN_WIDE_MAX, baseMs: LOGIN_NET_PAUSE_MS, maxMs: LOGIN_NET_PAUSE_MS },
} as const satisfies Record<string, ThrottleRule>;

/** A counter of one sign-in: its stored key (kind ':' HMAC) and its policy. */
interface ThrottleKey {
  key: string;
  rule: ThrottleRule;
}
const PRUNE_EVERY_MS = 24 * 60 * 60_000;
const BODY_MAX = 16_384;
/**
 * More points than one match can earn (six players for an hour at the top region factor, sampled
 * at 1 in 5 is about 5,400): a /host-credit that says more is junk, refused.
 */
const HOST_CREDIT_MAX = 100_000;
/** The most node operators /account-stats takes (the body stays under BODY_MAX); more is answered as unknown upstream. */
export const STATS_OPERATORS_MAX = 500;
/** The most NODE_TRUSTED_OPERATORS ids /account-stats reports on. */
export const STATS_TRUSTED_MAX = 32;

function isIdList(v: unknown, max: number): v is string[] {
  return Array.isArray(v) && v.length <= max && v.every((id) => isHex(id, 16));
}

/**
 * A counter after one more failure (pure, unit-tested): a new window once `rule.windowMs` passed
 * since its first failure; from the `rule.free`-th failure on, locked for `rule.baseMs` doubling with
 * each further one up to `rule.maxMs`.
 */
export function nextFail(prev: ThrottleEntry | undefined, now: number, rule: ThrottleRule = THROTTLE_RULES.pair): ThrottleEntry {
  const e = prev === undefined || now - prev.first > rule.windowMs ? { count: 0, first: now, lockedUntil: 0 } : { ...prev };
  e.count++;
  if (e.count >= rule.free) e.lockedUntil = now + Math.min(rule.maxMs, rule.baseMs * 2 ** (e.count - rule.free));
  return e;
}

/** The 429 of a counter that is locked: how long to wait. */
function throttledAnswer(waitMs: number): Response {
  return json({ error: 'throttled', message: 'Demasiados intentos, espera un momento', retryAfterMs: waitMs }, 429);
}

function isHex(v: unknown, len: number): v is string {
  return typeof v === 'string' && v.length === len && /^[0-9a-f]+$/.test(v);
}

function isPw(v: unknown): v is PasswordRecord {
  if (!v || typeof v !== 'object') return false;
  const p = v as PasswordRecord;
  if (p.v !== undefined && p.v !== 1 && p.v !== 2) return false;
  if (p.kid !== undefined && !(typeof p.kid === 'string' && /^(?:p[0-9]{1,3})?$/.test(p.kid))) return false;
  return isHex(p.hash, 64) && isHex(p.salt, 32) && Number.isInteger(p.iter) && p.iter >= 10_000 && p.iter <= 10_000_000;
}

/**
 * The level an OAuth sign-in, link or re-authentication carries (R6): what the Worker's start asked
 * the provider for, at most 1 in this build (a press on the provider's page; Google's forced
 * password, level 2, comes with its own change). Anything else is 0.
 */
function oauthLevel(v: unknown): 0 | 1 {
  return v === 1 ? 1 : 0;
}

/**
 * The password a sign-in or a re-authentication proved is still the stored one (`stored`): the
 * body's `proved` names the hash the Worker checked. A re-key needs it; without one, a body from a
 * Worker of before `proved` (the minutes of a deploy) passes as it did then, and stores nothing.
 */
function provedStill(b: Record<string, unknown>, stored: string | null, rekey: PasswordRecord | null): boolean {
  if (b.proved === undefined) return rekey === null;
  return typeof b.proved === 'string' && b.proved === stored;
}

// ---- the confirm step's identities (the Worker reads them from the provider and its signed pending cookie) ----

const TRUSTS: readonly ProviderTrust[] = ['auth', 'asserted', 'none'];

/** A provider's address and trust as the Worker sent them; anything malformed is no address. */
function foundOf(v: Record<string, unknown> | null | undefined): ProviderEmail {
  const email = v && typeof v.email === 'string' && v.email.length > 0 && v.email.length <= 254 ? v.email : null;
  const trust = v && TRUSTS.includes(v.trust as ProviderTrust) ? (v.trust as ProviderTrust) : 'none';
  return email === null ? { email: null, trust: 'none' } : { email, trust };
}

function identOf(v: unknown): PendingIdent | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!OAUTH_PROVIDERS.includes(o.p as OAuthProvider) || typeof o.id !== 'string' || o.id.length === 0 || o.id.length > 128) return null;
  return { p: o.p as OAuthProvider, id: o.id, ...foundOf(o) };
}

/** A pending identity (and its second one) from a body: null when absent or malformed. */
export function pendingOf(v: unknown): PendingIdentity | null {
  const first = identOf(v);
  if (first === null) return null;
  const p2 = identOf((v as Record<string, unknown>).p2);
  return p2 !== null && p2.p !== first.p ? { ...first, p2 } : first;
}

/** What a sign-in answers about the pending identity it was asked to link: the providers it linked, or why not. */
function linkAnswer(r: LinkPendingResult, pend: PendingIdentity): { linked: OAuthProvider[] } | { linkError: Exclude<LinkPendingResult, 'linked'> } {
  return r === 'linked' ? { linked: [pend.p, ...(pend.p2 ? [pend.p2.p] : [])] } : { linkError: r };
}

/** Who a password check names: the legacy username, or the email sign-in's address by its canon (derived here from what was typed, I9). */
type SignInSubject = { username: string } | { canon: string };

function subjectOf(b: Record<string, unknown>): SignInSubject | null {
  if (typeof b.email === 'string') {
    const canon = b.email.length <= 254 ? emailCanon(b.email) : null;
    return canon === null ? null : { canon };
  }
  return typeof b.username === 'string' && b.username.length <= 64 ? { username: b.username } : null;
}

/** A body's optional `rekey`: null when absent, undefined when malformed. */
function rekeyOf(v: unknown): PasswordRecord | null | undefined {
  if (v === undefined || v === null) return null;
  return isPw(v) ? v : undefined;
}

const enc = new TextEncoder();

/** A RefreshGrant from a request: the hash alone (hex) or { hash, family?, kind?, country?, city? }; null when malformed. */
export function grantOf(v: unknown): RefreshGrant | null {
  if (isHex(v, 64)) return { hash: v };
  if (!v || typeof v !== 'object') return null;
  const g = v as Record<string, unknown>;
  if (!isHex(g.hash, 64)) return null;
  if (g.family !== undefined && g.family !== null && !isHex(g.family, 32)) return null;
  if (g.kind !== undefined && g.kind !== 'web' && g.kind !== 'tv') return null;
  const country = typeof g.country === 'string' && /^[A-Z]{2}$/.test(g.country) ? g.country : null;
  const city = typeof g.city === 'string' && g.city.length > 0 && g.city.length <= 64 ? g.city : null;
  return { hash: g.hash, family: typeof g.family === 'string' ? g.family : null, kind: g.kind === 'tv' ? 'tv' : 'web', country, city };
}

/** A TvWhere from a request (the Worker's request.cf), each part checked; null when there is none. */
export function whereOf(v: unknown): TvWhere | null {
  if (!v || typeof v !== 'object') return null;
  const w = v as Record<string, unknown>;
  const text = (x: unknown): string | null => (typeof x === 'string' && x.length > 0 && x.length <= 64 ? x : null);
  return {
    country: typeof w.country === 'string' && /^[A-Z]{2}$/.test(w.country) ? w.country : null,
    city: text(w.city),
    asn: Number.isInteger(w.asn) && (w.asn as number) > 0 ? (w.asn as number) : null,
    org: text(w.org),
  };
}


// ---- email accounts (sign-in PR 7): the lives, caps and answers of the mailed proofs ------------

/** A code's life after each mail of it (a resend moves it), and its longest from the start (section 1.6). */
export const CODE_TTL_MS = 15 * 60_000;
export const CODE_MAX_MS = 60 * 60_000;
/** A "confirm it's you" code (M11). */
export const REAUTH_CODE_TTL_MS = 10 * 60_000;
/** A sign-up link (M1). */
export const SIGNUP_LINK_TTL_MS = 24 * 60 * 60_000;
/** A reset link (M2, M3): 30 minutes, one use. */
export const RESET_TTL_MS = 30 * 60_000;
/** Failed codes per address (its canon) in 24 hours; past them its codes are refused for a day, its links still work. */
export const CODE_FAILS_PER_CANON = 10;
/** "Confirm it's you" codes an account may ask for in 24 hours. */
export const REAUTH_CODES_PER_DAY = 5;
/**
 * New accounts per network in 24 hours (sections 2.2 and 2.7): an IPv6 /64 as an IPv4 address (a
 * carrier's CGNAT or a school shares one address, and a dual-stack school or LAN is one /64), not
 * the section's 10 for a /64, which a class signing up on its first day passed. One budget for
 * every way an account is made: an email sign-up (/signup-finish, which also needs a mailbox of
 * its own, proved by a code) and the OAuth confirm step's CREAR (/pending-create, a provider
 * identity of its own and a solved check) take from the same counters (newAccountCaps), so a
 * network gets NEW_ACCOUNTS a day in all, never that many of each.
 */
export const NEW_ACCOUNTS: Readonly<{ v6: WindowCap; v4: WindowCap }> = { v6: { day: 200 }, v4: { day: 200 } };
/**
 * ... and per IPv6 /48 (65,536 /64s, one free allocation), which a single /64 cannot reach alone:
 * rotating /64s inside one allocation gains little. Both ways in count here too.
 */
export const NEW_ACCOUNTS_SITE: WindowCap = { day: 300 };

/** The codes of one address: CODE_FAILS_PER_CANON failures in a day, then a day's pause (auth_throttle). */
const CODE_FAIL_RULE: ThrottleRule = { windowMs: LOGIN_DAY_MS, free: CODE_FAILS_PER_CANON, baseMs: LOGIN_DAY_MS, maxMs: LOGIN_DAY_MS };
/** An attempt id (32 random bytes the starting browser holds) and a link token (32 bytes): base64url. */
const B64_43 = /^[A-Za-z0-9_-]{43}$/;
const CODE_RE = /^[0-9]{6}$/;
/** A sign-up's codes, a "confirm it's you" code and an add or change of the email count their failures apart: a stranger's sign-up guesses never stop an owner's codes. */
const CODE_CLASS: Readonly<Record<string, string>> = { signup: 'cfs', reauth: 'cfr', add_email: 'cfe', change_email: 'cfe' };

/** M10s the daily alarm sends at most (the account lane's share of the day bounds it before that). */
export const LEGACY_REMINDERS_PER_ALARM = 200;

/** LEGACY_PASSWORD_UNTIL (sign-in PR 9, §3.10): a wrangler var, absent until the owner sets the cutoff. */
type LegacyEnv = { LEGACY_PASSWORD_UNTIL?: string };

/** 410 legacy_closed { until }: usernames no longer sign in (the cutoff passed), answered with no lookup. */
function legacyClosed(until: number | null): Response {
  return json({ ...LEGACY_CLOSED, until }, 410);
}

function codeExpired(): Response {
  return error(410, 'code_expired', 'El código caducó. Pide otro.');
}

function linkInvalid(): Response {
  return error(410, 'link_invalid', 'El enlace caducó o ya se usó');
}

/** A finish that came back after it made the account (a lost answer, another tab): sign in with this address. */
function alreadyCreated(email: string): Response {
  return json({ error: 'already_created', message: 'Tu cuenta ya está creada: inicia sesión.', email }, 409);
}

function codeWrong(triesLeft: number): Response {
  return json({ error: 'code_wrong', message: 'Ese código no es correcto', triesLeft }, 400);
}

/** The 429 of a full cap: how long until it has room (`email_rate_limited` for an address, an account or the day's lane; `rate_limited` for a network). */
function capAnswer(code: 'email_rate_limited' | 'rate_limited', waitMs: number): Response {
  const message = code === 'email_rate_limited' ? 'Ya te enviamos varios correos. Espera un rato antes de pedir otro.' : 'Demasiados pedidos desde tu red, inténtalo más tarde';
  return json({ error: code, message, retryAfterMs: Math.max(0, Math.ceil(waitMs)) }, 429);
}

/** How long until a full window of `cap` has room again. */
function windowWait(w: MailWindow, cap: WindowCap, now: number): number {
  if (cap.hour !== undefined && w.hour_n >= cap.hour) return w.hour_at + 3_600_000 - now;
  return w.day_at + LOGIN_DAY_MS - now;
}

/** The network a request counts in (env.ts limitKey: an IPv4 address, an IPv6 /64), '' without an address. */
function netOf(ip: unknown): string {
  return typeof ip === 'string' && ip.length > 0 && ip.length < 64 ? limitKey(ip) : '';
}

function randomHex(n: number): string {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  let s = '';
  for (let i = 0; i < n; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
  return s;
}

async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
  let h = '';
  for (let i = 0; i < d.length; i++) h += (d[i] < 16 ? '0' : '') + d[i].toString(16);
  return h;
}

/** A row's code hash (section 1.6): bound to the attempt, so a copy of the database cannot test a code without the browser's id. */
function codeHashOf(attempt: string, code: string): Promise<string> {
  return sha256Hex('code|' + attempt + '|' + code);
}

/** An account's language for its mail ('' when it never chose: the request's then), as a sign-up stores it. */
function langField(v: unknown): '' | MailLang {
  return v === 'es' || v === 'en' ? v : '';
}

/** An IANA zone as a sign-up stores it (mailTemplates.ts checks it again before it prints a date), '' otherwise. */
function tzField(v: unknown): string {
  return typeof v === 'string' && v.length <= 64 && /^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(v) ? v : '';
}

async function body<T>(request: Request): Promise<T | null> {
  try {
    const text = await request.text();
    if (text.length > BODY_MAX) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export class AccountsDO extends DurableObject<Env> {
  private readonly store: AccountStore;
  /** The throttle keys' HMAC key (limitsKey), per JWT_SECRET. */
  private limits: { secret: string; key: Promise<CryptoKey> } | null = null;
  /** The TV sign-in codes (tvCodes.ts): minutes long, so memory is enough. */
  readonly tv = new TvCodes();
  /** The clock (tests inject their own). */
  now: () => number = () => Date.now();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new AccountStore(ctx.storage.sql, (fn) => ctx.storage.transactionSync(fn));
    void ctx.blockConcurrencyWhile(async () => {
      this.store.migrate();
      // The names a new one may not imitate (section 5.2): the trusted list is a var, so it changes only with a deploy, which restarts this object.
      this.store.rebuildProtectedSkeletons([...trustedOperatorIds(env)]);
      if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now() + PRUNE_EVERY_MS);
    });
  }

  override async alarm(): Promise<void> {
    this.store.prune(this.now());
    this.store.rebuildProtectedSkeletons([...trustedOperatorIds(this.env)]);
    this.tv.sweep(this.now(), true);
    try {
      await this.legacyAlarm(this.now());
    } catch {
      console.warn('legacy reminders failed');
    }
    await this.ctx.storage.setAlarm(Date.now() + PRUNE_EVERY_MS);
  }

  /**
   * The username sign-in's phase now (§3.10): 'none' while LEGACY_PASSWORD_UNTIL is unset (no date),
   * else 'grace' until the cutoff (its date at 12:00 UTC, never before 30 days after this object first
   * saw a value: accountStore.ts legacyCutoff) and 'closed' from then on.
   */
  legacy(now: number): LegacyState {
    const date = legacyDateOf((this.env as LegacyEnv).LEGACY_PASSWORD_UNTIL);
    if (date === null) return { phase: 'none', until: null };
    const until = this.store.legacyCutoff(date, now);
    return { phase: now >= until ? 'closed' : 'grace', until };
  }

  /**
   * The daily alarm's part of the cutoff: with no date, the floor's start is forgotten; in the last
   * LEGACY_REMIND_MS before it, M10 (§4.4) to every account whose password is still the legacy key and
   * that has a verified address, once per account and cutoff, with a reset link (30 minutes), in the
   * account lane under each address's cap. Sent from here (no request: the alarm), only through the
   * live mailer of a deploy (mail.ts chooseMailer, for MAIL_LINK_ORIGIN's host): off it, nothing is
   * written or sent. What the lane leaves for tomorrow goes then.
   */
  async legacyAlarm(now: number): Promise<number> {
    const L = this.legacy(now);
    if (L.until === null) {
      this.store.forgetLegacySeen();
      return 0;
    }
    if (L.phase !== 'grace' || L.until - now > LEGACY_REMIND_MS) return 0;
    const origin = (this.env.MAIL_LINK_ORIGIN ?? '').trim();
    let request: Request;
    try {
      request = new Request(origin + '/');
    } catch {
      return 0;
    }
    const link = linkOrigin(request, this.env);
    const mailer = chooseMailer(request, this.env, []);
    if (link === null || !mailer.live || (await mailKilled(this.env))) return 0;
    let sent = 0;
    for (const userId of this.store.legacyReminderTargets(L.until, LEGACY_REMINDERS_PER_ALARM)) {
      const p0 = this.store.mailProfile(userId);
      if (p0 === null || p0.canon === null) continue;
      const reset = await this.newReset();
      const to = await this.throttleKey('to', p0.canon);
      // ---- one step from here ----
      const p = this.store.mailProfile(userId);
      if (p === null || p.email === null || p.canon !== p0.canon || p.banned) continue;
      if (this.laneRefusal('account', now) !== null) break;
      if (this.takeCaps([{ key: to, cap: MAIL_CAPS.recipient, code: 'email_rate_limited' }], now) !== null) continue;
      this.addReset(p, reset.nonce, reset.hash, now);
      this.store.markReminded(userId, L.until, now);
      this.store.mailDayCount(mailDay(now), 'account', 'sent');
      const order: MailOrder = { to: p.email, lang: mailLang(p.lang, null), ...(p.tz ? { tz: p.tz } : {}), data: { kind: 'legacy_reminder', name: p.name, at: L.until, token: reset.token } };
      try {
        await deliver(mailer, composeMail(order.to, renderMail(order.data, { origin: link, lang: order.lang, ...(order.tz ? { tz: order.tz } : {}) })));
        sent++;
      } catch {
        console.warn('mail_failed kind=legacy_reminder err=render');
      }
    }
    return sent;
  }

  override async fetch(request: Request): Promise<Response> {
    if (!this.env.JWT_SECRET) return error(500, 'no_secret');
    if (!(await checkInternal(this.env.JWT_SECRET, request))) return error(403, 'forbidden');
    const url = new URL(request.url);
    const now = this.now();
    try {
      if (request.method === 'GET') return this.get(url, now);
      if (request.method === 'POST') return await this.post(url.pathname, request, now);
    } catch (e) {
      console.error('AccountsDO error', e);
      return error(500, 'internal');
    }
    return error(404, 'not_found');
  }

  private get(url: URL, now: number): Response {
    const p = url.searchParams;
    switch (url.pathname) {
      case '/pw-labels':
        // This code stores a password record's pw_v and pw_kid as the Worker made them (accountRoutes.ts storeEnv).
        return json({ ok: true });
      case '/me': {
        const me = this.store.me(p.get('userId') ?? '', now, this.legacy(now).phase === 'closed');
        return me ? json(me) : error(404, 'no_user');
      }
      case '/legacy':
        // The username sign-in's phase and cutoff (§3.10): the Worker's /api/config asks once per isolate and value.
        return json(this.legacy(now));
      case '/ranked-result':
        return json(this.store.rankedResultFor(p.get('matchId') ?? '', p.get('userId') ?? '', now));
      case '/leaderboard': {
        const pl = p.get('playlist');
        if (!isPlaylist(pl)) return error(400, 'bad_playlist');
        const userId = p.get('userId');
        return json(this.store.leaderboard(pl, Number(p.get('limit') ?? 100) || 100, userId && userId.length > 0 ? userId : null));
      }
      case '/experimental': {
        const r = this.store.experimental(p.get('userId') ?? '');
        return r === 'no_user' ? error(404, 'no_user') : json(r);
      }
      case '/items': {
        const r = this.store.items(p.get('userId') ?? '');
        return r === 'no_user' ? error(404, 'no_user') : json(r);
      }
      case '/shop': {
        const r = this.store.shop(p.get('userId') ?? '');
        return r === 'no_user' ? error(404, 'no_user') : json(r);
      }
      case '/replay-name': {
        const r = this.store.replayName(p.get('userId') ?? '');
        return r === 'no_user' ? error(404, 'no_user') : json(r);
      }
    }
    return error(404, 'not_found');
  }

  /** HKDF-SHA256(JWT_SECRET, 'turbogol/hkdf/v2', 'limits') as an HMAC key: the throttle keys' (the design's §1.3). */
  private limitsKey(): Promise<CryptoKey> {
    const secret = this.env.JWT_SECRET;
    if (this.limits !== null && this.limits.secret === secret) return this.limits.key;
    const key = (async () => {
      const ikm = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
      return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('turbogol/hkdf/v2'), info: enc.encode('limits') }, ikm, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
    })();
    this.limits = { secret, key };
    return key;
  }

  /** A counter's stored key: its kind, ':' and 32 hex of HMAC(kind + '|' + value) (no username or address at rest). */
  private async throttleKey(kind: string, value: string): Promise<string> {
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await this.limitsKey(), enc.encode(kind + '|' + value)));
    let h = '';
    for (let i = 0; i < 16; i++) h += (mac[i] < 16 ? '0' : '') + mac[i].toString(16);
    return kind + ':' + h;
  }

  /**
   * The counters of one password check (the header comment), and the ones a success clears. A
   * password checked behind a session of the account (`account`: a password change, new codes, a
   * rename, a re-authentication) counts only on that account's 'pa:' counter. A sign-in or a
   * recovery counts on its (username, network) pair and who tries: a browser with the account's
   * device cookie on its 'd:' counter and nothing more, anyone else on the username's, its network
   * (env.ts limitKey: an IPv4 address or an IPv6 /64) and an IPv6 address's /48.
   * Async (the HMACs) and done before any read, so the reads and writes after it stay atomic.
   */
  private async checkKeys(subject: SignInSubject, ip: unknown, b: Record<string, unknown>): Promise<{ keys: ThrottleKey[]; clear: string[]; account: boolean }> {
    const R = THROTTLE_RULES;
    if (typeof b.account === 'string' && b.account.length > 0 && b.account.length <= 64) {
      const pa = await this.throttleKey('pa', b.account);
      return { keys: [{ key: pa, rule: R.pair }], clear: [pa], account: true };
    }
    // The email sign-in (sign-in PR 7) counts the typed canon as the legacy path counts the username,
    // on counters of its own; the network's and the /48's are one budget for both.
    const byEmail = 'canon' in subject;
    const user = byEmail ? subject.canon : usernameKey(subject.username);
    const addr = typeof ip === 'string' && ip.length > 0 && ip.length < 64 ? ip : '';
    const net = addr === '' ? '' : limitKey(addr);
    const v6 = addr.includes(':') && !addr.includes('.');
    const site = v6 ? sitePrefix(addr) : null;
    const known = this.knownDevice(subject, b);
    const pair = await this.throttleKey(byEmail ? 'ep' : 'up', user + '|' + net);
    const who = known !== null ? await this.throttleKey('d', known) : await this.throttleKey(byEmail ? 'e' : 'u', user);
    const keys: ThrottleKey[] = [{ key: pair, rule: R.pair }, { key: who, rule: known !== null ? R.pair : R.user }];
    // A known browser proved this account's password here before: its 'd:' counter bounds it, so a
    // network's or a /48's pause (a classroom's typos, a sprayer next door) never stops it, and its
    // own typos never count toward one.
    if (known === null) {
      if (net !== '') keys.push({ key: await this.throttleKey('ip', net), rule: v6 ? R.net6 : R.net4 });
      if (site !== null) keys.push({ key: await this.throttleKey('w', site), rule: R.site });
    }
    const clear = [pair, who];
    if (known !== null) clear.push(await this.throttleKey(byEmail ? 'e' : 'u', user));
    return { keys, clear, account: false };
  }

  /** The account a sign-in's subject names: by its username, or by the canon of its verified address. */
  private credentialsOf(subject: SignInSubject): Credentials | null {
    return 'canon' in subject ? this.store.credentialsByCanon(subject.canon) : this.store.credentials(subject.username);
  }

  /** This browser's device id when its device cookie is one of the account `subject` names (it signed in there before); null otherwise. */
  private knownDevice(subject: SignInSubject, b: Record<string, unknown>): string | null {
    const d = b.device as { user?: unknown; id?: unknown } | null | undefined;
    if (!d || typeof d !== 'object' || typeof d.user !== 'string' || typeof d.id !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(d.id)) return null;
    return this.credentialsOf(subject)?.userId === d.user ? d.id : null;
  }

  /** The longest wait any of `keys` is locked for at `now` (0: none). */
  private throttled(keys: readonly ThrottleKey[], now: number): number {
    let wait = 0;
    for (const e of this.store.throttleRows(keys.map((k) => k.key)).values()) if (e.lockedUntil > now) wait = Math.max(wait, e.lockedUntil - now);
    return wait;
  }

  /** One failure on every counter of `keys` (one transaction). */
  private fail(keys: readonly ThrottleKey[], now: number): void {
    const rows = this.store.throttleRows(keys.map((k) => k.key));
    const next = new Map<string, ThrottleEntry>();
    for (const k of keys) next.set(k.key, nextFail(rows.get(k.key), now, k.rule));
    this.store.throttleWrite(next);
  }

  /**
   * A charged check that proved the password: one failure taken back from each of `keys` (a
   * network's, a /48's), and a lock its count no longer reaches with it, so successful sign-ins
   * never use up a school's budget.
   */
  private refund(keys: readonly ThrottleKey[]): void {
    const rows = this.store.throttleRows(keys.map((k) => k.key));
    const next = new Map<string, ThrottleEntry>();
    const gone: string[] = [];
    for (const k of keys) {
      const e = rows.get(k.key);
      if (e === undefined) continue;
      if (e.count <= 1) gone.push(k.key);
      else next.set(k.key, { count: e.count - 1, first: e.first, lockedUntil: e.count - 1 < k.rule.free ? 0 : e.lockedUntil });
    }
    this.store.throttleWrite(next);
    this.store.throttleClear(gone);
  }

  /**
   * The new-account counters of a request's address, one budget for every way an account is made
   * (/signup-finish and /pending-create alike): mail_rate 'na:' its network (env.ts limitKey: an
   * IPv4 address or an IPv6 /64, NEW_ACCOUNTS) and 'ns:' an IPv6 address's /48 (NEW_ACCOUNTS_SITE).
   * None without an address.
   */
  private async newAccountCaps(ip: unknown): Promise<Array<{ key: string; cap: WindowCap }>> {
    const net = netOf(ip);
    if (net === '') return [];
    const out = [{ key: await this.throttleKey('na', net), cap: net.endsWith('::/64') ? NEW_ACCOUNTS.v6 : NEW_ACCOUNTS.v4 }];
    const site = sitePrefix(ip as string);
    if (site !== null) out.push({ key: await this.throttleKey('ns', site), cap: NEW_ACCOUNTS_SITE });
    return out;
  }

  /**
   * One slot of each new-account counter, or the 429 of the first full one. Nothing is written here:
   * the caller writes the rows once the account exists (newAccountTaken), in the same step, so a
   * refused create (a taken name, a wrong code, a race) counts nothing.
   */
  private newAccountSlots(caps: ReadonlyArray<{ key: string; cap: WindowCap }>, now: number): Map<string, MailWindow> | Response {
    const cur = this.store.mailWindows(caps.map((c) => c.key));
    const rows = new Map<string, MailWindow>();
    for (const c of caps) {
      const r = takeSlot(cur.get(c.key) ?? null, c.cap, now);
      if (!r.ok) return json({ error: 'rate_limited', message: 'Demasiadas cuentas nuevas desde tu red hoy: inténtalo mañana', retryAfterMs: Math.max(0, Math.ceil(windowWait(r.row, c.cap, now))) }, 429);
      rows.set(c.key, r.row);
    }
    return rows;
  }

  /** The account exists: its slots of newAccountSlots count now. */
  private newAccountTaken(rows: ReadonlyMap<string, MailWindow>): void {
    if (rows.size > 0) this.store.mailWindowsWrite(rows);
  }

  // ---- email accounts (sign-in PR 7) ------------------------------------------------------------
  //
  // Every secret a mail carries derives from its row's nonce (section 1.6): the link token is
  // base64url(HMAC(K_mail, 'link|' + nonce)) and the code 6 uniform digits of HMAC(K_mail, 'code|' +
  // nonce), K_mail = HKDF(JWT_SECRET, 'turbogol/hkdf/v2', 'mail'). So a resend mails the same code
  // and link again, and the row stores only hashes. The HMACs come before any read of a handler, so
  // its reads and writes run in one step (no await between them).

  private mailKeyCache: { secret: string; key: Promise<CryptoKey> } | null = null;

  private mailKey(): Promise<CryptoKey> {
    const secret = this.env.JWT_SECRET;
    if (this.mailKeyCache !== null && this.mailKeyCache.secret === secret) return this.mailKeyCache.key;
    const key = (async () => {
      const ikm = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
      return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('turbogol/hkdf/v2'), info: enc.encode('mail') }, ikm, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
    })();
    this.mailKeyCache = { secret, key };
    return key;
  }

  /** The link token (43 base64url) and the 6-digit code of a row's nonce (rejection sampling: every code equally likely). */
  async mailSecrets(nonce: string): Promise<{ token: string; code: string }> {
    const key = await this.mailKey();
    const token = base64urlEncode(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode('link|' + nonce))));
    const LIMIT = Math.floor(2 ** 32 / 1e6) * 1e6;
    for (let round = 0; ; round++) {
      const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode('code|' + nonce + (round > 0 ? '|' + round : ''))));
      for (let i = 0; i + 4 <= mac.length; i += 4) {
        const n = mac[i] * 2 ** 24 + mac[i + 1] * 2 ** 16 + mac[i + 2] * 2 ** 8 + mac[i + 3];
        if (n < LIMIT) return { token, code: String(n % 1e6).padStart(6, '0') };
      }
    }
  }

  /**
   * The day's lane may carry one more mail (section 4.7): not paused (the signup lane's automatic
   * pause) and below its share of EMAIL_DAILY_CAP; else its refusal, the same for every address.
   */
  private laneRefusal(lane: MailLane, now: number, need = 1): Response | null {
    const day = this.store.mailDay(mailDay(now));
    if (lane === 'signup' && day.signup.pausedUntil > now) return error(503, 'email_paused', 'Ahora no podemos enviar correos. Inténtalo en unos minutos.');
    const total = day.signup.sent + day.account.sent + day.notice.sent;
    // `need` mails at once (an applied change and move: M6 and M12) fit when the last of them does.
    if (laneAllows(lane, total + need - 1, dailyCap(this.env))) return null;
    const tomorrow = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1);
    return capAnswer('email_rate_limited', tomorrow - now);
  }

  /** One slot of every cap, or none (a refusal counts nothing): the first full one answers how long to wait. */
  private takeCaps(caps: ReadonlyArray<{ key: string; cap: WindowCap; code: 'email_rate_limited' | 'rate_limited' }>, now: number): Response | null {
    const rows = this.store.mailWindows(caps.map((c) => c.key));
    const next = new Map<string, MailWindow>();
    for (const c of caps) {
      const r = takeSlot(rows.get(c.key) ?? null, c.cap, now);
      if (!r.ok) return capAnswer(c.code, windowWait(r.row, c.cap, now));
      next.set(c.key, r.row);
    }
    this.store.mailWindowsWrite(next);
    return null;
  }

  /** A reset row for the account (M2's and M3's link: 30 minutes, one use), superseding its older ones. */
  private addReset(p: MailProfile, nonce: string, hash: string, now: number): void {
    this.store.killMailTokens({ userId: p.userId }, ['reset'], now);
    this.store.addMailToken({ hash, nonce, purpose: 'reset', userId: p.userId, email: p.email ?? '', canon: p.canon ?? '', attemptHash: null, codeHash: null, codeExpiresAt: 0, payload: {}, expiresAt: now + RESET_TTL_MS }, now);
  }

  /**
   * The mail of a sign-up's row, chosen from its canon's state now (section 2.2): M1 with the code
   * to a free address (its "hint" variant when an account carries it as a provider's hint); M2 to
   * the account that claimed it, with a reset link; M2 "held" to the address an undo holds. Only
   * the mail differs: the caller's answer is the same in every case (I6).
   */
  private signupMail(canon: string, m: { email: string; lang: MailLang; token: string; code: string; reset: { nonce: string; hash: string; token: string } }, now: number): MailOrder | null {
    const st = this.store.canonState(canon, now);
    if (st.kind === 'free') return { to: m.email, lang: m.lang, data: { kind: 'verify_signup', code: m.code, token: m.token } };
    if (st.kind === 'hint') return { to: m.email, lang: m.lang, data: { kind: 'verify_signup', code: m.code, token: m.token, hint: st.from } };
    const p = this.store.mailProfile(st.userId);
    if (p === null) return null;
    const lang = mailLang(p.lang, m.lang);
    if (st.kind === 'held') return { to: st.email, lang, data: { kind: 'signup_exists', name: p.name, variant: 'held', methods: p.ways } };
    if (p.email === null) return null;
    this.addReset(p, m.reset.nonce, m.reset.hash, now);
    return { to: p.email, lang, ...(p.tz ? { tz: p.tz } : {}), data: { kind: 'signup_exists', name: p.name, variant: 'reset', methods: p.ways, token: m.reset.token } };
  }

  /** A fresh reset row's nonce, token and hash (made before a handler reads anything). */
  private async newReset(): Promise<{ nonce: string; hash: string; token: string }> {
    const nonce = randomHex(16);
    const { token } = await this.mailSecrets(nonce);
    return { nonce, token, hash: await sha256Hex(token) };
  }

  /**
   * The email routes of the AccountsDO (the Worker's accountRoutes.ts calls them), or null for any
   * other path. `mail` in an answer is for the Worker to send after it answers (R7), never for a client.
   */
  private async emailPost(path: string, b: Record<string, unknown>, now: number): Promise<Response | null> {
    switch (path) {
      case '/signup-start':
        return this.signupStart(b, now);
      case '/signup-check':
        return this.signupCheck(b, now);
      case '/signup-finish':
        return this.signupFinish(b, now);
      case '/code-resend':
        return this.codeResend(b, now);
      case '/mail-failed':
        return this.mailFailed(b, now);
      case '/forgot':
        return this.forgot(b, now);
      case '/reset-peek':
        return this.resetPeek(b, now);
      case '/reset':
        return this.reset(b, now);
      case '/me-password':
        return this.mePassword(b, now);
      case '/password-link':
        return this.passwordLink(b, now);
      case '/reauth-code':
        return this.reauthCode(b, now);
      case '/reauth-code-verify':
        return this.reauthCodeVerify(b, now);
      // Adding and changing the email (sign-in PR 9).
      case '/me-email':
        return this.meEmail(b, now);
      case '/me-email-verify':
        return this.meEmailVerify(b, now);
      case '/email-confirm':
        return this.emailConfirm(b, now);
      case '/email-undo-peek':
        return this.emailUndoPeek(b, now);
      case '/email-undo':
        return this.emailUndo(b, now);
      case '/me-prefs':
        return this.mePrefs(b);
    }
    return null;
  }

  // ---- adding and changing the email (sign-in PR 9: the design's §2.6, §3.6, §4.4 M5 to M7, M12) -------

  /**
   * The row and the mail of an add or a change aimed at `canon` (§2.6's table), chosen from the
   * canon's state now, for `userId`'s request: free, a hint (anyone's) or this account's own held old
   * canon: a real row and M5 with the code to the typed address; claimed by another account that keeps
   * a way in without it (a linked provider): a real row with `moveFrom`, and M7 "move" with the code
   * to that account's own address; claimed by an account with no other way in: a decoy, M7 "only";
   * held for another account's undo: a decoy, M7 "held"; a suspended owner: a decoy and no mail. The
   * requester's answer is the same in every case (I6). `code` and `token`: the row's own (its nonce).
   */
  private emailPlan(userId: string, canon: string, typed: string, requestLang: string | null, now: number, code: string, token: string): { real: boolean; moveFrom: string | null; mail: MailOrder | null } {
    const me = this.store.mailProfile(userId);
    if (me === null) return { real: false, moveFrom: null, mail: null };
    const st = this.store.canonState(canon, now);
    // Its own address already (a resend after the link applied it): nothing to prove, nothing to mail.
    if (st.kind === 'claimed' && st.userId === userId) return { real: false, moveFrom: null, mail: null };
    if (st.kind === 'free' || st.kind === 'hint' || (st.kind === 'held' && st.userId === userId)) {
      return { real: true, moveFrom: null, mail: { to: typed, lang: mailLang(me.lang, requestLang), data: { kind: 'verify_email', name: me.name, code, token } } };
    }
    const other = this.store.mailProfile(st.kind === 'claimed' || st.kind === 'held' ? st.userId : '');
    if (other === null || other.banned) return { real: false, moveFrom: null, mail: null };
    const lang = mailLang(other.lang, requestLang);
    if (st.kind === 'held') return { real: false, moveFrom: null, mail: { to: st.email, lang, data: { kind: 'email_in_use', name: other.name, other: me.name, variant: 'held' } } };
    if (other.email === null) return { real: false, moveFrom: null, mail: null };
    const source = this.store.moveSource(other.userId);
    if (source === null) return { real: false, moveFrom: null, mail: { to: other.email, lang, data: { kind: 'email_in_use', name: other.name, other: me.name, variant: 'only' } } };
    return { real: true, moveFrom: other.userId, mail: { to: other.email, lang, ...(other.tz ? { tz: other.tz } : {}), data: { kind: 'email_in_use', name: other.name, other: me.name, variant: 'move', code, methods: source.ways } } };
  }

  /**
   * POST /me-email { userId, email, attempt, lang?, ip } -> { resendAt, to, mail } (§2.6): the account's
   * new address, proved by a code to it (M5) or, when another account holds it, by that mailbox's M7
   * (a move code, or a notice). One row for any address (a decoy where no code may go), the account's
   * older add / change rows superseded, the recipient's and the account's caps and the account lane
   * counted the same either way (I6). 400 bad_email / same_email, 409 email_locked { until }, 403 banned,
   * 429, 503.
   */
  private async meEmail(b: Record<string, unknown>, now: number): Promise<Response> {
    const email = normalizeEmail(b.email);
    const canon = emailCanon(b.email);
    if (email === null || canon === null) return error(400, 'bad_email', 'Revisa el correo: no parece una dirección válida');
    if (typeof b.userId !== 'string' || typeof b.attempt !== 'string' || !B64_43.test(b.attempt)) return error(400, 'bad_request');
    if (this.store.emailOwner(b.userId) === null) return error(404, 'no_user');
    const requestLang = typeof b.lang === 'string' ? b.lang : null;
    const nonce = randomHex(16);
    const { token, code } = await this.mailSecrets(nonce);
    const hashes = { link: await sha256Hex(token), attempt: await sha256Hex(b.attempt), code: await codeHashOf(b.attempt, code), decoy: await sha256Hex('decoy|' + randomHex(32)) };
    const caps: Array<{ key: string; cap: WindowCap; code: 'email_rate_limited' | 'rate_limited' }> = [
      { key: await this.throttleKey('to', canon), cap: MAIL_CAPS.recipient, code: 'email_rate_limited' },
      { key: await this.throttleKey('ma', b.userId), cap: MAIL_CAPS.account, code: 'email_rate_limited' },
    ];
    // ---- one step from here: no await ----
    const owner = this.store.emailOwner(b.userId);
    if (owner === null) return error(404, 'no_user');
    if (owner.banned) return error(403, 'banned', 'Cuenta suspendida');
    if (owner.canon === canon) return error(400, 'same_email', 'Ese ya es tu correo.');
    if (owner.lockedUntil > now) return json({ error: 'email_locked', message: 'Tu correo se restauró hace poco. Puedes cambiarlo otra vez en unos días.', until: owner.lockedUntil }, 409);
    const lane = this.laneRefusal('account', now);
    if (lane !== null) return lane;
    const capped = this.takeCaps(caps, now);
    if (capped !== null) return capped;
    const plan = this.emailPlan(b.userId, canon, email, requestLang, now, code, token);
    // A newer request supersedes the account's older ones (§1.6).
    this.store.killMailTokens({ userId: b.userId }, ['add_email', 'change_email'], now);
    const lang = mailLang(owner.lang, requestLang);
    this.store.addMailToken(
      { hash: hashes.link, nonce, purpose: owner.canon === null ? 'add_email' : 'change_email', userId: b.userId, email, canon, attemptHash: hashes.attempt, codeHash: plan.real ? hashes.code : hashes.decoy, codeExpiresAt: now + CODE_TTL_MS, payload: { lang, ...(plan.moveFrom !== null ? { moveFrom: plan.moveFrom } : {}) }, expiresAt: now + SIGNUP_LINK_TTL_MS },
      now,
    );
    this.store.mailDayCount(mailDay(now), 'account', 'sent');
    return json({ resendAt: now + RESEND.gapMs, to: email, mail: plan.mail });
  }

  /** The undo row's secrets (M6's link), made before a handler's one step (a change needs them). */
  private async newUndo(): Promise<{ nonce: string; hash: string; token: string }> {
    return this.newReset();
  }

  /**
   * What an applied add, change or move mails (§2.6), in the notice lane: a change, M6 to the old
   * address with the undo link (both languages; the new one masked); a move, M12 to the address,
   * naming both accounts (the one that lost it signs in with its providers). An add mails nothing
   * more: its code was the proof. Neither is ever dropped: noticeRoom made sure the lane has room for
   * them before the change applied, and a full cap of the account's notices counts them but does not
   * stop them (else five notices first would switch off the undo).
   */
  private appliedMail(a: EmailApplied, undoToken: string, keys: { me: string; from: string | null }, providers: readonly Provider[], requestLang: unknown, now: number): MailOrder[] {
    const out: MailOrder[] = [];
    const me = this.store.mailProfile(a.userId);
    if (me === null) return out;
    // A change (a move of an account that had an address too): M6 to the old address, with the undo.
    if (a.old !== null) {
      const order = this.notice({ ...me, email: a.old.email }, keys.me, { kind: 'email_changed', name: me.name, masked: maskEmail(a.email), at: now, token: undoToken, providers }, requestLang, now, true);
      if (order !== null) out.push(order);
    }
    if (a.kind === 'move' && a.from !== null) {
      const from = this.store.mailProfile(a.from);
      const source = this.store.moveSource(a.from);
      if (from !== null) {
        const order = this.notice({ ...from, email: a.email }, keys.from, { kind: 'email_moved', name: from.name, other: me.name, at: now, methods: source?.ways ?? [] }, requestLang, now, true);
        if (order !== null) out.push(order);
      }
    }
    return out;
  }

  /**
   * Before an add, a change or a move applies (§2.6, in the handler's one step): the notices it must
   * send (M6 for a change, M12 for a move) can go. Mail off (the kill flag, a deploy that cannot
   * deliver: `mailOff`, the Worker's mailRefusal) answers 503 email_paused, a day's notice lane
   * without room for them its 429 until tomorrow; nothing changes and the code or link stays live. An
   * add sends nothing after its code, so it always may.
   */
  private noticeRoom(userId: string, row: MailTokenRow, mailOff: boolean, now: number): Response | null {
    const owner = this.store.emailOwner(userId);
    const need = (owner !== null && owner.canon !== null ? 1 : 0) + (typeof row.payload.moveFrom === 'string' ? 1 : 0);
    if (need === 0) return null;
    if (mailOff) return error(503, 'email_paused', 'Ahora no podemos enviar correos. Inténtalo en unos minutos.');
    return this.laneRefusal('notice', now, need);
  }

  /** The providers this deployment signs in with, as a request names them (M6's {providers}). */
  private providersOf(v: unknown): Provider[] {
    return Array.isArray(v) ? (['google', 'discord'] as const).filter((p) => v.includes(p)) : [];
  }

  /** applyEmail's refusals as answers (§2.6). */
  private appliedRefusal(r: 'expired' | 'taken' | 'move_refused' | 'no_user', byToken: boolean): Response {
    if (r === 'taken') return error(409, 'email_taken', 'Ese correo ya tiene una cuenta. Entra con ella.');
    if (r === 'move_refused') return error(409, 'move_refused', 'Ese correo es la única forma de entrar a otra cuenta. Revisa el mensaje que te enviamos.');
    if (r === 'no_user') return error(403, 'banned', 'Cuenta suspendida');
    return byToken ? linkInvalid() : codeExpired();
  }

  /**
   * POST /me-email-verify { userId, attempt, code, keep?, providers?, lang?, mailOff? } -> MeInfo & { mail }
   * (§2.6): the code of the account's own attempt (5 tries, the address's failed codes counted apart
   * from a sign-up's), then the add, the change or the move in one transaction (applyEmail), once its
   * notices can go (noticeRoom). 400 code_wrong { triesLeft }, 410 code_expired, 409 email_taken (a
   * race) / move_refused (the other account lost its other way in meanwhile), 429 / 503 (noticeRoom).
   */
  private async meEmailVerify(b: Record<string, unknown>, now: number): Promise<Response> {
    if (typeof b.userId !== 'string' || typeof b.attempt !== 'string' || !B64_43.test(b.attempt) || typeof b.code !== 'string' || !CODE_RE.test(b.code)) return error(400, 'bad_request');
    const first = this.store.mailToken('attempt', await sha256Hex(b.attempt));
    if (first === null || (first.purpose !== 'add_email' && first.purpose !== 'change_email') || first.userId !== b.userId) return codeExpired();
    const undo = await this.newUndo();
    const moveFrom = typeof first.payload.moveFrom === 'string' ? first.payload.moveFrom : null;
    const keys = { me: await this.noticeKey(b.userId), from: moveFrom !== null ? await this.noticeKey(moveFrom) : null };
    const v = await this.codeCheck(first.purpose, b.attempt, b.code, b.userId, now);
    // ---- one step from here (codeCheck's own, then the transaction) ----
    if (v instanceof Response) return v;
    const room = this.noticeRoom(b.userId, v.row, b.mailOff === true, now);
    if (room !== null) return room;
    const r = this.store.applyEmail(v.row.hash, isHex(b.keep, 64) ? b.keep : null, undo, now);
    if (typeof r === 'string') return this.appliedRefusal(r, false);
    const mail = this.appliedMail(r, undo.token, keys, this.providersOf(b.providers), b.lang, now);
    return json({ ...this.store.me(b.userId, now, this.legacy(now).phase === 'closed'), mail });
  }

  /**
   * POST /email-confirm { token, keep?, providers?, lang?, mailOff? } -> { ok, name, email, mail } (§2.6):
   * the mailed link of an add or a change (M5), opened on any device: no session needed, the link is
   * the mailbox's proof and the row names its account. 410 link_invalid; 409 email_taken /
   * move_refused; 429 / 503 (noticeRoom).
   */
  private async emailConfirm(b: Record<string, unknown>, now: number): Promise<Response> {
    if (typeof b.token !== 'string' || !B64_43.test(b.token)) return linkInvalid();
    const first = this.store.mailToken('hash', await sha256Hex(b.token));
    if (first === null || (first.purpose !== 'add_email' && first.purpose !== 'change_email') || first.userId === null) return linkInvalid();
    const undo = await this.newUndo();
    const moveFrom = typeof first.payload.moveFrom === 'string' ? first.payload.moveFrom : null;
    const keys = { me: await this.noticeKey(first.userId), from: moveFrom !== null ? await this.noticeKey(moveFrom) : null };
    // ---- one step from here ----
    const row = this.store.mailToken('hash', first.hash);
    if (row === null || row.usedAt > 0 || now >= row.expiresAt) return linkInvalid();
    const room = this.noticeRoom(first.userId, row, b.mailOff === true, now);
    if (room !== null) return room;
    const r = this.store.applyEmail(first.hash, isHex(b.keep, 64) ? b.keep : null, undo, now);
    if (typeof r === 'string') return this.appliedRefusal(r, true);
    return json({ ok: true, name: r.name, email: r.email, mail: this.appliedMail(r, undo.token, keys, this.providersOf(b.providers), b.lang, now) });
  }

  /** POST /email-undo-peek { token } -> { name, email } | 410 link_invalid: whom the undo sheet is for (the address it brings back). Consumes nothing. */
  private async emailUndoPeek(b: Record<string, unknown>, now: number): Promise<Response> {
    if (typeof b.token !== 'string' || !B64_43.test(b.token)) return linkInvalid();
    const r = this.store.undoRow(await sha256Hex(b.token), now);
    const p = r === null ? null : this.store.mailProfile(r.userId as string);
    if (r === null || p === null || p.banned) return linkInvalid();
    return json({ name: p.name, email: r.email });
  }

  /**
   * POST /email-undo { token, pw, refresh } -> UserRef (level 2, method 'reset') | 410 link_invalid
   * (§2.6): M6's link gives the account back to its old address (accountStore.ts undoEmail: a new
   * password, every device signed out, providers linked in the last 7 days unlinked, the email locked
   * for 7 days, every pending row dead). The old address's throttles start again.
   */
  private async emailUndo(b: Record<string, unknown>, now: number): Promise<Response> {
    const refresh = grantOf(b.refresh);
    if (refresh === null || !isPw(b.pw) || typeof b.token !== 'string' || !B64_43.test(b.token)) return error(400, 'bad_request');
    const hash = await sha256Hex(b.token);
    const first = this.store.undoRow(hash, now);
    if (first === null) return linkInvalid();
    const clear = [await this.throttleKey('e', first.canon)];
    // ---- one step from here ----
    const r = this.store.undoEmail(hash, b.pw, { ...refresh, kind: 'web' }, now);
    if (r === null) return linkInvalid();
    this.store.throttleClear(clear);
    return json(r);
  }

  /** POST /me-prefs { userId, lang, tz } -> { ok } (§2.9): the language and zone of the account's mail ('' zone: none). */
  private mePrefs(b: Record<string, unknown>): Response {
    const lang = langField(b.lang);
    if (typeof b.userId !== 'string' || lang === '' || typeof b.tz !== 'string' || (b.tz !== '' && tzField(b.tz) === '')) return error(400, 'bad_prefs', 'Idioma o zona horaria inválidos');
    return this.store.setPrefs(b.userId, lang, b.tz) ? json({ ok: true }) : error(404, 'no_user');
  }

  /**
   * A security notice about something that already happened (M4 and the others: the notice lane,
   * both languages), within the account's own cap of notices a day and the lane's share; null when
   * either is full (the change stands, the notice is skipped) or the account has no address. `must`
   * (M6 and M12, whose change applied only once noticeRoom saw room for them in the lane): never
   * skipped, and counted in the account's cap while it has room.
   */
  private async noticeKey(userId: string): Promise<string> {
    return this.throttleKey('nt', userId);
  }

  private notice(p: MailProfile | null, key: string | null, data: MailOrder['data'], requestLang: unknown, now: number, must = false): MailOrder | null {
    if (p === null || p.email === null) return null;
    if (must) {
      if (key !== null) this.takeCaps([{ key, cap: MAIL_CAPS.notice, code: 'email_rate_limited' }], now);
    } else if (key === null || this.laneRefusal('notice', now) !== null || this.takeCaps([{ key, cap: MAIL_CAPS.notice, code: 'email_rate_limited' }], now) !== null) return null;
    this.store.mailDayCount(mailDay(now), 'notice', 'sent');
    return { to: p.email, lang: mailLang(p.lang, typeof requestLang === 'string' ? requestLang : null), ...(p.tz ? { tz: p.tz } : {}), data };
  }

  /**
   * POST /forgot { email, lang?, ip } -> { ok, mail } (section 2.4): with an account that claimed that
   * canon, a reset row and M3 ("reset" with a password, "create" without) to its own address. Never
   * a hint, never a stranger: then nothing is mailed, but the recipient's and the network's caps and
   * the account lane's room count as if a mail had gone (I6).
   */
  private async forgot(b: Record<string, unknown>, now: number): Promise<Response> {
    const email = normalizeEmail(b.email);
    const canon = emailCanon(b.email);
    if (email === null || canon === null) return error(400, 'bad_email', 'Revisa el correo: no parece una dirección válida');
    const net = netOf(b.ip);
    const reset = await this.newReset();
    const caps: Array<{ key: string; cap: WindowCap; code: 'email_rate_limited' | 'rate_limited' }> = [{ key: await this.throttleKey('to', canon), cap: MAIL_CAPS.recipient, code: 'email_rate_limited' }];
    if (net !== '') caps.push({ key: await this.throttleKey('mn', net), cap: networkCap(net), code: 'rate_limited' });
    // ---- one step from here ----
    const lane = this.laneRefusal('account', now);
    if (lane !== null) return lane;
    const capped = this.takeCaps(caps, now);
    if (capped !== null) return capped;
    const st = this.store.canonState(canon, now);
    const p = st.kind === 'claimed' ? this.store.mailProfile(st.userId) : null;
    if (p === null || p.email === null || p.banned) return json({ ok: true, mail: null });
    this.addReset(p, reset.nonce, reset.hash, now);
    this.store.mailDayCount(mailDay(now), 'account', 'sent');
    const lang = mailLang(p.lang, typeof b.lang === 'string' ? b.lang : null);
    const data: MailOrder['data'] = p.hasPassword ? { kind: 'reset', name: p.name, variant: 'reset', token: reset.token } : { kind: 'reset', name: p.name, variant: 'create', methods: p.ways, token: reset.token };
    return json({ ok: true, mail: { to: p.email, lang, data } satisfies MailOrder });
  }

  /** A live reset row of `token` and its account, or null (unknown, expired, used, superseded: all one answer). */
  private async resetRow(token: unknown, now: number): Promise<{ row: MailTokenRow; p: MailProfile } | null> {
    if (typeof token !== 'string' || !B64_43.test(token)) return null;
    const row = this.store.mailToken('hash', await sha256Hex(token));
    if (row === null || row.purpose !== 'reset' || row.usedAt > 0 || now >= row.expiresAt || row.userId === null) return null;
    const p = this.store.mailProfile(row.userId);
    return p === null ? null : { row, p };
  }

  /** POST /reset-peek { token } -> { name, email, hasPassword } | 410 link_invalid: what the reset sheet shows. Consumes nothing. */
  private async resetPeek(b: Record<string, unknown>, now: number): Promise<Response> {
    const r = await this.resetRow(b.token, now);
    if (r === null) return linkInvalid();
    return json({ name: r.p.name, email: r.p.email ?? r.row.email, hasPassword: r.p.hasPassword });
  }

  /**
   * POST /reset { token, pw, refresh, ip, lang?, pending? } -> UserRef & { mail } (& { linked } |
   * { linkError } with `pending`) (level 2, method 'reset') | 410 link_invalid | 403 banned, in one
   * transaction: the password stored (pw_v 2), every refresh family revoked and one started for this
   * browser, every reset, email and reauth row of the account dead, the throttles of its address
   * cleared (this network's pair too), then M4; then the pending identity linked (linkPending).
   */
  private async reset(b: Record<string, unknown>, now: number): Promise<Response> {
    const refresh = grantOf(b.refresh);
    if (refresh === null || !isPw(b.pw)) return error(400, 'bad_request');
    const first = await this.resetRow(b.token, now);
    if (first === null) return linkInvalid();
    const clear = first.p.canon === null ? [] : [await this.throttleKey('e', first.p.canon), await this.throttleKey('ep', first.p.canon + '|' + netOf(b.ip))];
    const nt = await this.noticeKey(first.p.userId);
    // ---- one step from here ----
    const row = this.store.mailToken('hash', first.row.hash);
    if (row === null || row.usedAt > 0 || now >= row.expiresAt) return linkInvalid();
    if (first.p.banned) return error(403, 'banned', 'Cuenta suspendida');
    const r = this.store.resetPassword(row, b.pw, { ...refresh, kind: 'web' }, now);
    if (r === null) return linkInvalid();
    this.store.throttleClear(clear);
    const mail = this.notice(this.store.mailProfile(r.userId), nt, { kind: 'password_changed', name: r.username, at: now }, b.lang, now);
    // linkPending (section 2.4): the reset proved this account's mailbox; the identity pending in
    // this browser goes on it under §3.8's rules (only the account its address leads to, if any).
    const pend = pendingOf(b.pending);
    return json({ ...r, mail, ...(pend !== null ? linkAnswer(this.store.linkPending(r.userId, pend, now), pend) : {}) });
  }

  /**
   * POST /me-password { userId, pw, keep, proved } -> { ok, mail } (section 2.5): the password the
   * Worker checked (`proved`, which must still be the stored one) replaced by the new current key,
   * every other refresh family signed out (`keep`: this device's), every reset and reauth row dead,
   * then M4. 401 bad_credentials when the password changed meanwhile.
   */
  private async mePassword(b: Record<string, unknown>, now: number): Promise<Response> {
    if (typeof b.userId !== 'string' || !isPw(b.pw) || typeof b.proved !== 'string') return error(400, 'bad_request');
    const nt = await this.noticeKey(b.userId);
    // ---- one step from here ----
    const s = this.store;
    if (s.passwordHash(b.userId) !== b.proved) return error(401, 'bad_credentials', 'Usuario o contraseña incorrectos');
    if (!s.changePassword(b.userId, b.pw, isHex(b.keep, 64) ? b.keep : null, now)) return error(404, 'no_user');
    const p = s.mailProfile(b.userId);
    return json({ ok: true, mail: this.notice(p, nt, { kind: 'password_changed', name: p?.name ?? '', at: now }, b.lang, now) });
  }

  /**
   * POST /password-link { userId, lang? } -> { sentTo, mail } | 409 email_required (section 2.5):
   * "create a password" (or a new one) by a reset link to the account's own address, M3, in the
   * account lane: the Bearer never sets a password by itself (I4; audit auth-3, P6).
   */
  private async passwordLink(b: Record<string, unknown>, now: number): Promise<Response> {
    if (typeof b.userId !== 'string') return error(400, 'bad_request');
    const p0 = this.store.mailProfile(b.userId);
    if (p0 === null) return error(404, 'no_user');
    if (p0.email === null || p0.canon === null) return error(409, 'email_required', 'Agrega un correo para crear una contraseña.');
    const reset = await this.newReset();
    const caps: Array<{ key: string; cap: WindowCap; code: 'email_rate_limited' | 'rate_limited' }> = [
      { key: await this.throttleKey('to', p0.canon), cap: MAIL_CAPS.recipient, code: 'email_rate_limited' },
      { key: await this.throttleKey('ma', b.userId), cap: MAIL_CAPS.account, code: 'email_rate_limited' },
    ];
    // ---- one step from here ----
    const p = this.store.mailProfile(b.userId);
    if (p === null || p.email !== p0.email || p.email === null) return error(409, 'email_required', 'Agrega un correo para crear una contraseña.');
    if (p.banned) return error(403, 'banned', 'Cuenta suspendida');
    const lane = this.laneRefusal('account', now);
    if (lane !== null) return lane;
    const capped = this.takeCaps(caps, now);
    if (capped !== null) return capped;
    this.addReset(p, reset.nonce, reset.hash, now);
    this.store.mailDayCount(mailDay(now), 'account', 'sent');
    const lang = mailLang(p.lang, typeof b.lang === 'string' ? b.lang : null);
    const data: MailOrder['data'] = p.hasPassword ? { kind: 'reset', name: p.name, variant: 'reset', token: reset.token } : { kind: 'reset', name: p.name, variant: 'create', methods: p.ways, token: reset.token };
    return json({ sentTo: p.email, mail: { to: p.email, lang, data } satisfies MailOrder });
  }

  /**
   * POST /reauth-code { userId, attempt, lang? } -> { resendAt, to, mail } | 409 email_required
   * (section 2.3): "confirm it's you" by a code from the account's own mailbox (M11, 10 minutes,
   * no link), REAUTH_CODES_PER_DAY a day, the account's mail caps; a newer one supersedes it.
   */
  private async reauthCode(b: Record<string, unknown>, now: number): Promise<Response> {
    if (typeof b.userId !== 'string' || typeof b.attempt !== 'string' || !B64_43.test(b.attempt)) return error(400, 'bad_request');
    const p0 = this.store.mailProfile(b.userId);
    if (p0 === null) return error(404, 'no_user');
    if (p0.email === null || p0.canon === null) return error(409, 'email_required', 'Esta cuenta no tiene un correo confirmado');
    const nonce = randomHex(16);
    const { token, code } = await this.mailSecrets(nonce);
    const hashes = { row: await sha256Hex(token), attempt: await sha256Hex(b.attempt), code: await codeHashOf(b.attempt, code) };
    const caps: Array<{ key: string; cap: WindowCap; code: 'email_rate_limited' | 'rate_limited' }> = [
      { key: await this.throttleKey('to', p0.canon), cap: MAIL_CAPS.recipient, code: 'email_rate_limited' },
      { key: await this.throttleKey('ma', b.userId), cap: MAIL_CAPS.account, code: 'email_rate_limited' },
      { key: await this.throttleKey('rc', b.userId), cap: { day: REAUTH_CODES_PER_DAY }, code: 'email_rate_limited' },
    ];
    // ---- one step from here ----
    const p = this.store.mailProfile(b.userId);
    if (p === null || p.email === null || p.canon !== p0.canon) return error(409, 'email_required', 'Esta cuenta no tiene un correo confirmado');
    if (p.banned) return error(403, 'banned', 'Cuenta suspendida');
    const lane = this.laneRefusal('account', now);
    if (lane !== null) return lane;
    const capped = this.takeCaps(caps, now);
    if (capped !== null) return capped;
    const lang = mailLang(p.lang, typeof b.lang === 'string' ? b.lang : null);
    this.store.killMailTokens({ userId: p.userId }, ['reauth'], now);
    // The row's key is its (never mailed) link token's hash: a reauth code has no link.
    this.store.addMailToken({ hash: hashes.row, nonce, purpose: 'reauth', userId: p.userId, email: p.email, canon: p.canon as string, attemptHash: hashes.attempt, codeHash: hashes.code, codeExpiresAt: now + REAUTH_CODE_TTL_MS, payload: { lang }, expiresAt: now + CODE_MAX_MS }, now);
    this.store.mailDayCount(mailDay(now), 'account', 'sent');
    return json({ resendAt: now + RESEND.gapMs, to: p.email, mail: { to: p.email, lang, data: { kind: 'reauth_code', name: p.name, code } } satisfies MailOrder });
  }

  /**
   * POST /reauth-code-verify { userId, attempt, code, hash } -> UserRef (this browser's token, `hash`,
   * proves a credential now at level 2: a mailbox code, R6) | 400 code_wrong | 410 code_expired | 401
   * no_refresh. 5 tries per code; the code is used once.
   */
  private async reauthCodeVerify(b: Record<string, unknown>, now: number): Promise<Response> {
    if (typeof b.userId !== 'string' || !isHex(b.hash, 64) || typeof b.attempt !== 'string' || !B64_43.test(b.attempt) || typeof b.code !== 'string' || !CODE_RE.test(b.code)) return error(400, 'bad_request');
    const v = await this.codeCheck('reauth', b.attempt, b.code, b.userId, now);
    if (v instanceof Response) return v;
    const r = this.store.markFresh(b.userId, b.hash, now);
    if (r === null) return error(401, 'no_refresh');
    this.store.useMailToken(v.row.hash, b.userId, now);
    return json(r);
  }

  /**
   * POST /signup-start { email, attempt, lang?, ip } -> { resendAt, codeLength, mail } | 429 | 503: one
   * row for any address (a decoy, with a random code hash, when the canon is claimed or held), the
   * recipient's and the network's caps and the signup lane counted the same either way (I6).
   */
  private async signupStart(b: Record<string, unknown>, now: number): Promise<Response> {
    const email = normalizeEmail(b.email);
    const canon = emailCanon(b.email);
    if (email === null || canon === null) return error(400, 'bad_email', 'Revisa el correo: no parece una dirección válida');
    if (typeof b.attempt !== 'string' || !B64_43.test(b.attempt)) return error(400, 'bad_request');
    const lang = mailLang(null, typeof b.lang === 'string' ? b.lang : null);
    const net = netOf(b.ip);
    const nonce = randomHex(16);
    const { token, code } = await this.mailSecrets(nonce);
    const reset = await this.newReset();
    const hashes = { link: await sha256Hex(token), attempt: await sha256Hex(b.attempt), code: await codeHashOf(b.attempt, code), decoy: await sha256Hex('decoy|' + randomHex(32)) };
    const caps: Array<{ key: string; cap: WindowCap; code: 'email_rate_limited' | 'rate_limited' }> = [{ key: await this.throttleKey('to', canon), cap: MAIL_CAPS.recipient, code: 'email_rate_limited' }];
    if (net !== '') caps.push({ key: await this.throttleKey('mn', net), cap: networkCap(net), code: 'rate_limited' as const });
    // ---- one step from here: no await ----
    const lane = this.laneRefusal('signup', now);
    if (lane !== null) return lane;
    const capped = this.takeCaps(caps, now);
    if (capped !== null) return capped;
    const st = this.store.canonState(canon, now);
    const real = st.kind === 'free' || st.kind === 'hint';
    this.store.addMailToken({ hash: hashes.link, nonce, purpose: 'signup', userId: null, email, canon, attemptHash: hashes.attempt, codeHash: real ? hashes.code : hashes.decoy, codeExpiresAt: now + CODE_TTL_MS, payload: { lang }, expiresAt: now + SIGNUP_LINK_TTL_MS }, now);
    const mail = this.signupMail(canon, { email, lang, token, code, reset }, now);
    this.store.mailDayCount(mailDay(now), 'signup', 'sent');
    return json({ resendAt: now + RESEND.gapMs, codeLength: 6, mail });
  }

  /**
   * A code typed for an attempt of `purpose` (and of the account `userId`, for an account's own
   * codes): its row when right; else code_wrong { triesLeft }, code_expired (the last try, a used or
   * dead row) or 429 throttled when the address had CODE_FAILS_PER_CANON failures today. Every
   * failure counts on the row and on the address (its canon, per class of code). Consumes nothing.
   */
  private async codeCheck(purpose: string, attempt: string, code: string, userId: string | null, now: number): Promise<{ row: MailTokenRow; codeHash: string } | Response> {
    const first = this.store.mailToken('attempt', await sha256Hex(attempt));
    if (first === null || first.purpose !== purpose || (purpose !== 'signup' && first.userId !== userId)) return codeExpired();
    const codeHash = await codeHashOf(attempt, code);
    const failKey = first.canon === '' ? null : await this.throttleKey(CODE_CLASS[purpose] ?? 'cfx', first.canon);
    // ---- one step from here ----
    const row = this.store.mailToken('hash', first.hash);
    if (row === null) return codeExpired();
    const keys = failKey === null ? [] : [{ key: failKey, rule: CODE_FAIL_RULE }];
    const wait = this.throttled(keys, now);
    if (wait > 0) return throttledAnswer(wait);
    const v = this.store.codeVerdict(row, codeHash, now);
    if (v === 'ok') return { row, codeHash };
    if (v === 'expired') return codeExpired();
    this.fail(keys, now);
    return v.triesLeft > 0 ? codeWrong(v.triesLeft) : codeExpired();
  }

  /**
   * POST /signup-check { attempt, code } | { token } -> { email } (the address the proof is for) |
   * 400 code_wrong | 410 | 409 already_created { email } (the proof made an account in the last 10
   * minutes: the Worker asks this before it hashes a finish's password, so a junk finish costs no
   * PBKDF2).
   */
  private async signupCheck(b: Record<string, unknown>, now: number): Promise<Response> {
    const byToken = typeof b.token === 'string';
    if (byToken ? !B64_43.test(b.token as string) : typeof b.attempt !== 'string' || !B64_43.test(b.attempt) || typeof b.code !== 'string' || !CODE_RE.test(b.code)) return byToken ? linkInvalid() : error(400, 'bad_request');
    const first = byToken ? this.store.mailToken('hash', await sha256Hex(b.token as string)) : this.store.mailToken('attempt', await sha256Hex(b.attempt as string));
    if (first === null || first.purpose !== 'signup') return byToken ? linkInvalid() : codeExpired();
    if (first.usedAt > 0) {
      const already = this.store.alreadyCreated(first, byToken ? null : await codeHashOf(b.attempt as string, b.code as string), now);
      if (already !== null) return alreadyCreated(already);
      return byToken ? linkInvalid() : codeExpired();
    }
    if (byToken) return now >= first.expiresAt ? linkInvalid() : json({ email: first.email });
    const v = await this.codeCheck('signup', b.attempt as string, b.code as string, null, now);
    return v instanceof Response ? v : json({ email: v.row.email });
  }

  /**
   * POST /signup-finish { attempt, code } | { token }, { username, pw, news, lang, tz, terms?, refresh,
   * ip } -> UserRef & { email } (level 2, method 'password') | 400 bad_username / name_reserved
   * { suggest } | 409 username_taken / name_lookalike { suggest }, email_taken, already_created
   * { email } | 410 | 429 (the network's new accounts, or the address's failed codes).
   */
  private async signupFinish(b: Record<string, unknown>, now: number): Promise<Response> {
    const refresh = grantOf(b.refresh);
    if (refresh === null || !isPw(b.pw) || typeof b.username !== 'string' || b.username.length > 64) return error(400, 'bad_request');
    const byToken = typeof b.token === 'string';
    if (byToken ? !B64_43.test(b.token as string) : typeof b.attempt !== 'string' || !B64_43.test(b.attempt) || typeof b.code !== 'string' || !CODE_RE.test(b.code)) return byToken ? linkInvalid() : error(400, 'bad_request');
    const first = byToken ? this.store.mailToken('hash', await sha256Hex(b.token as string)) : this.store.mailToken('attempt', await sha256Hex(b.attempt as string));
    if (first === null || first.purpose !== 'signup') return byToken ? linkInvalid() : codeExpired();
    const codeHash = byToken ? null : await codeHashOf(b.attempt as string, b.code as string);
    const failKey = byToken || first.canon === '' ? null : await this.throttleKey('cfs', first.canon);
    const caps = await this.newAccountCaps(b.ip);
    const lang = langField(b.lang);
    const terms = typeof b.terms === 'string' && /^[a-z0-9._-]{1,32}$/.test(b.terms) ? b.terms : null;
    // ---- one step from here ----
    const failKeys = failKey === null ? [] : [{ key: failKey, rule: CODE_FAIL_RULE }];
    const wait = this.throttled(failKeys, now);
    if (wait > 0) return throttledAnswer(wait);
    // The network's new accounts: one budget with the OAuth confirm step's (/pending-create).
    const slots = this.newAccountSlots(caps, now);
    if (slots instanceof Response) return slots;
    const issue = usernameIssue(b.username);
    const name = b.username;
    const r = this.store.finishSignup({ row: first, codeHash }, { username: name, pw: b.pw, lang, tz: tzField(b.tz), news: b.news === true, terms, refresh: { ...refresh, kind: 'web' } }, now, issue === null ? 'ok' : issue.code === 'usernameReserved' ? 'reserved' : 'bad');
    const sl = lang === '' ? 'en' : lang;
    if (r === 'expired') return codeExpired();
    if (r === 'invalid') return linkInvalid();
    if (r === 'bad_username') return error(400, 'bad_username', usernameProblem(name) ?? 'Nombre inválido');
    if (r === 'name_reserved') return json({ error: 'name_reserved', message: 'Ese nombre está reservado', suggest: this.store.suggestName(name, sl) }, 400);
    if (r === 'username_taken') return json({ error: 'username_taken', message: 'Ese nombre ya está en uso', suggest: this.store.suggestName(name, sl) }, 409);
    if (r === 'lookalike') return json({ error: 'name_lookalike', message: 'Ese nombre se parece mucho a otro', suggest: this.store.suggestName(name, sl) }, 409);
    if (r === 'email_taken') return error(409, 'email_taken', 'Ese correo ya tiene una cuenta');
    if ('already' in r) return alreadyCreated(r.already);
    if ('triesLeft' in r) {
      this.fail(failKeys, now);
      return r.triesLeft > 0 ? codeWrong(r.triesLeft) : codeExpired();
    }
    this.newAccountTaken(slots);
    return json(r);
  }

  /**
   * POST /code-resend { attempt, ip, userId? } -> { resendAt, resendsLeft, mail } (section 2.2): the
   * same code and link again, the code's life moved to CODE_TTL_MS from now (at most CODE_MAX_MS
   * from the start), the tries kept; 1 a minute and RESEND.max per attempt, under the recipient's
   * caps. A sign-up's mail is chosen again from its canon's state. An account's own code (reauth)
   * resends only for that account.
   */
  private async codeResend(b: Record<string, unknown>, now: number): Promise<Response> {
    if (typeof b.attempt !== 'string' || !B64_43.test(b.attempt)) return codeExpired();
    const userId = typeof b.userId === 'string' ? b.userId : null;
    const first = this.store.mailToken('attempt', await sha256Hex(b.attempt));
    const own = first !== null && (first.purpose === 'reauth' || first.purpose === 'add_email' || first.purpose === 'change_email');
    if (first === null || (first.purpose !== 'signup' && !own) || (first.purpose !== 'signup' && first.userId !== userId)) return codeExpired();
    const { token, code } = await this.mailSecrets(first.nonce);
    const codeHash = await codeHashOf(b.attempt, code);
    const reset = await this.newReset();
    const anonymous = first.purpose === 'signup';
    const net = netOf(b.ip);
    const caps: Array<{ key: string; cap: WindowCap; code: 'email_rate_limited' | 'rate_limited' }> = [];
    if (first.canon !== '') caps.push({ key: await this.throttleKey('to', first.canon), cap: MAIL_CAPS.recipient, code: 'email_rate_limited' });
    if (anonymous && net !== '') caps.push({ key: await this.throttleKey('mn', net), cap: networkCap(net), code: 'rate_limited' });
    if (!anonymous && first.userId !== null) caps.push({ key: await this.throttleKey('ma', first.userId), cap: MAIL_CAPS.account, code: 'email_rate_limited' });
    // ---- one step from here ----
    const row = this.store.mailToken('hash', first.hash);
    if (row === null || row.usedAt > 0 || now >= row.expiresAt || row.codeTries >= CODE_TRIES || now >= row.createdAt + CODE_MAX_MS) return codeExpired();
    if (row.resends >= RESEND.max) return capAnswer('email_rate_limited', row.expiresAt - now);
    const sentAt = typeof row.payload.sentAt === 'number' ? row.payload.sentAt : row.createdAt;
    if (now - sentAt < RESEND.gapMs) return capAnswer('email_rate_limited', sentAt + RESEND.gapMs - now);
    const laneName: MailLane = anonymous ? 'signup' : 'account';
    const lane = this.laneRefusal(laneName, now);
    if (lane !== null) return lane;
    const capped = this.takeCaps(caps, now);
    if (capped !== null) return capped;
    let mail: MailOrder | null;
    let real = true;
    let payload: Record<string, unknown> = {};
    const lang = mailLang(null, typeof row.payload.lang === 'string' ? row.payload.lang : null);
    if (anonymous) {
      const st = this.store.canonState(row.canon, now).kind;
      real = st === 'free' || st === 'hint';
      mail = this.signupMail(row.canon, { email: row.email, lang, token, code, reset }, now);
    } else if (row.purpose === 'reauth') {
      const p = this.store.mailProfile(row.userId as string);
      mail = p === null ? null : { to: row.email, lang: mailLang(p.lang, lang), data: { kind: 'reauth_code', name: p.name, code } };
    } else {
      // An add or a change: its mail chosen again from the canon's state now (a move code, a notice, M5).
      const plan = this.emailPlan(row.userId as string, row.canon, row.email, lang, now, code, token);
      real = plan.real;
      mail = plan.mail;
      // A move the canon's owner allows now; one it no longer allows keeps its mark (the verify then says move_refused).
      if (plan.moveFrom !== null) payload = { moveFrom: plan.moveFrom };
    }
    // A decoy whose address is free now (its account went), or a code of a rotated key: the row takes the code this mail carries.
    const ttl = row.purpose === 'reauth' ? REAUTH_CODE_TTL_MS : CODE_TTL_MS;
    this.store.resentMailToken(row, real && row.codeHash !== codeHash ? codeHash : null, Math.min(now + ttl, row.createdAt + CODE_MAX_MS), now, payload);
    this.store.mailDayCount(mailDay(now), laneName, 'sent');
    return json({ resendAt: now + RESEND.gapMs, resendsLeft: RESEND.max - row.resends - 1, mail });
  }

  /**
   * POST /mail-failed { kind, lane } (the Worker's deliver failed: section 4.6) -> { paused, alert }:
   * the lane's failures of the day; FAILURES.failures in FAILURES.windowMs pause the signup lane
   * (503 email_paused for everyone), and the other lanes, which never pause, raise one alert per
   * FAILURES.alertEveryMs instead.
   */
  private mailFailed(b: Record<string, unknown>, now: number): Response {
    const lane = b.lane;
    if (lane !== 'signup' && lane !== 'account' && lane !== 'notice') return error(400, 'bad_request');
    // The lane's window (no address in it): hour_* counts the last FAILURES.windowMs, day_at the last alert.
    const key = 'fail:' + lane;
    const w: MailWindow = this.store.mailWindows([key]).get(key) ?? { hour_at: now, hour_n: 0, day_at: 0, day_n: 0 };
    if (now - w.hour_at >= FAILURES.windowMs || now < w.hour_at) {
      w.hour_at = now;
      w.hour_n = 0;
    }
    w.hour_n++;
    const pausedUntil = pauseAfterFailures(lane, w.hour_n, now);
    const alert = alertAfterFailures(lane, w.hour_n, w.day_at, now);
    if (alert) w.day_at = now;
    this.store.mailWindowsWrite(new Map([[key, w]]));
    this.store.mailDayCount(mailDay(now), lane, 'failed', pausedUntil);
    return json({ ok: true, paused: pausedUntil > 0, alert });
  }

  private async post(path: string, request: Request, now: number): Promise<Response> {
    const b = await body<Record<string, unknown>>(request);
    if (!b) return error(400, 'bad_request');
    // A match with experimental rules counts for nothing: no rating, no ranked lock, no abandon or
    // no-show penalty, no training record. Such a report is refused, whoever sent it.
    if ((path === '/ranked-result' || path === '/ranked-cancel' || path === '/ranked-lock' || path === '/training') && carriesPhysics(b)) {
      return error(400, EXPERIMENTAL_REFUSED, 'a match with experimental rules records nothing');
    }
    const email = await this.emailPost(path, b, now);
    if (email !== null) return email;
    const s = this.store;
    switch (path) {
      case '/auth-begin': {
        const who = subjectOf(b);
        if (who === null) return error(400, 'bad_request');
        // After the cutoff a username signs in nowhere (§3.10; the Worker answers it first): only a
        // session's own check of its password (`account`: "confirm it's you", which re-keys) goes on.
        if ('username' in who && b.account === undefined) {
          const L = this.legacy(now);
          if (L.phase === 'closed') return legacyClosed(L.until);
        }
        const { keys } = await this.checkKeys(who, b.ip, b);
        const wait = this.throttled(keys, now);
        if (wait > 0) return throttledAnswer(wait);
        // The check the Worker is about to make counts now, in this synchronous step with the test
        // above: a burst of requests in flight at once gets no more checks than the counters allow.
        if (b.charge === true) this.fail(keys, now);
        const c = this.credentialsOf(who);
        return json(c === null ? { found: false } : { found: true, ...c });
      }
      case '/auth-finish': {
        const who = subjectOf(b);
        if (who === null) return error(400, 'bad_request');
        const { keys, clear, account } = await this.checkKeys(who, b.ip, b);
        // Charged at /auth-begin: the failure is counted already (a Worker of before charges nothing).
        const charged = b.charged === true;
        const failure = (): void => {
          if (!charged) this.fail(keys, now);
        };
        if (account) {
          // A password proved behind a session of the account: its counter starts again. Never a sign-in.
          if (b.ok === true) s.throttleClear(clear);
          else failure();
          return json({ ok: b.ok === true });
        }
        const refresh = grantOf(b.refresh);
        const rekey = rekeyOf(b.rekey);
        if (b.ok !== true || typeof b.userId !== 'string' || refresh === null || rekey === undefined) {
          failure();
          return json({ ok: false });
        }
        // The hash the Worker checked must still be the account's: a password changed meanwhile wins,
        // and a re-key never writes an older password back over it.
        if (!provedStill(b, s.passwordHash(b.userId), rekey)) {
          failure();
          return error(401, 'bad_credentials', 'canon' in who ? 'Correo o contraseña incorrectos' : 'Usuario o contraseña incorrectos');
        }
        const r = s.signedIn(b.userId, { ...refresh, kind: 'web' }, now, { lvl: 2, method: 'canon' in who ? 'password' : 'legacy' }, rekey);
        if (r === null) return error(403, 'banned');
        s.throttleClear(clear);
        // The network's and the /48's counters keep failures only: this check's charge goes back.
        if (charged) this.refund(keys.filter((k) => !clear.includes(k.key)));
        // linkPending: the identity pending in this browser goes on this account, in the same step (§3.8).
        const pend = pendingOf(b.pending);
        return json(pend !== null ? { ...r, ...linkAnswer(s.linkPending(r.userId, pend, now), pend) } : r);
      }
      case '/refresh': {
        const next = grantOf(b.next);
        if (!isHex(b.old, 64) || next === null || (b.oldFamily !== undefined && b.oldFamily !== null && !isHex(b.oldFamily, 32))) return error(400, 'bad_request');
        const r = s.rotate(b.old, typeof b.oldFamily === 'string' ? b.oldFamily : null, next, now);
        if (r === 'race') return error(409, 'refresh_race', 'Otra pestaña renovó la sesión');
        if (r === 'reused') {
          console.warn('refresh token reused: its family was revoked');
          return error(401, 'refresh_reused');
        }
        return r === 'unknown' ? error(401, 'bad_refresh') : json(r);
      }
      case '/refresh-owner': {
        if (!isHex(b.hash, 64)) return error(400, 'bad_request');
        const r = s.refreshOwner(b.hash, now);
        return r ? json(r) : error(404, 'bad_refresh');
      }
      case '/logout': {
        if (isHex(b.hash, 64)) s.deleteRefresh(b.hash, isHex(b.family, 32) ? b.family : null);
        return json({ ok: true });
      }
      case '/sessions': {
        if (typeof b.userId !== 'string') return error(400, 'bad_request');
        return json({ sessions: s.devices(b.userId, now, isHex(b.current, 64) ? b.current : null) });
      }
      case '/sessions/revoke': {
        if (typeof b.userId !== 'string' || !isHex(b.id, 32)) return error(400, 'bad_request');
        return json({ revoked: s.revokeDevice(b.userId, b.id) });
      }
      case '/sessions/revoke-all': {
        if (typeof b.userId !== 'string') return error(400, 'bad_request');
        return json({ revoked: s.deleteRefreshOf(b.userId) });
      }
      case '/recover': {
        const refresh = grantOf(b.refresh);
        if (typeof b.username !== 'string' || b.username.length > 64 || !isHex(b.code, 64) || !isPw(b.pw) || refresh === null) return error(400, 'bad_request');
        const L = this.legacy(now);
        if (L.phase === 'closed') return legacyClosed(L.until);
        const { keys, clear } = await this.checkKeys({ username: b.username }, b.ip, b);
        const wait = this.throttled(keys, now);
        if (wait > 0) return throttledAnswer(wait);
        const r = s.recover(b.username, b.code, b.pw, { ...refresh, kind: 'web' }, now);
        if (r === null) {
          this.fail(keys, now);
          return error(401, 'bad_recovery', 'Usuario o código de recuperación incorrecto');
        }
        s.throttleClear(clear);
        return json(r);
      }
      case '/oauth': {
        const provider = b.provider as OAuthProvider;
        if (!OAUTH_PROVIDERS.includes(provider) || typeof b.providerId !== 'string' || b.providerId.length === 0 || b.providerId.length > 128) return error(400, 'bad_request');
        const refresh = grantOf(b.refresh);
        if (refresh === null) return error(400, 'bad_request');
        const linkTo = typeof b.linkTo === 'string' ? b.linkTo : null;
        // A link comes from a device that is still signed in (PERFIL's): signed out meanwhile, nothing links.
        const replace = typeof b.replace === 'string' && /^[0-9a-f]{32}$/.test(b.replace) ? b.replace : null;
        if (linkTo !== null && (replace === null || !s.devices(linkTo, now, null).some((d) => d.id === replace && d.kind === 'web'))) return error(401, 'link_expired');
        const r = s.oauth(provider, b.providerId, linkTo, { ...refresh, kind: 'web' }, now, oauthLevel(b.lvl), foundOf(b));
        // Nobody has this identity: nothing is made (I3); the Worker's confirm step asks first.
        if (r === 'pending') return json({ pending: true });
        if (r === 'already_linked') return error(409, 'already_linked', 'Esa cuenta ya está vinculada a otro usuario');
        if (r === 'provider_set') return error(409, 'provider_set', 'Tu cuenta ya tiene otra cuenta de ese proveedor: desvincúlala primero');
        if (r === 'no_user') return error(403, 'no_user');
        if (linkTo !== null && replace !== null) s.revokeDevice(linkTo, replace);
        // "I already have one" (pend=1): the identity pending in this browser goes on the account it signed in to.
        const pend = linkTo === null ? pendingOf(b.pending) : null;
        return json(pend !== null ? { ...r, ...linkAnswer(s.linkPending(r.userId, pend, now), pend) } : r);
      }
      case '/pending-match': {
        const pend = pendingOf(b.pending);
        if (pend === null) return error(400, 'bad_request');
        const m = s.pendingMatch(pend, now);
        return json({ match: m === null ? null : { name: m.name, methods: m.methods, via: m.via, email: m.email } });
      }
      case '/pending-create': {
        const pend = pendingOf(b.pending);
        const refresh = grantOf(b.refresh);
        if (pend === null || refresh === null || typeof b.username !== 'string' || b.username.length > 64 || typeof b.ip !== 'string' || b.ip.length > 64) return error(400, 'bad_request');
        const caps = await this.newAccountCaps(b.ip);
        // ---- one step from here ----
        // New accounts per network and per IPv6 /48 in a day (durable), one budget with /signup-finish:
        // checked first, counted only once the account exists.
        const slots = this.newAccountSlots(caps, now);
        if (slots instanceof Response) return slots;
        const lang = langField(b.lang);
        const sl = lang === '' ? 'en' : lang;
        const name = b.username;
        // The name rules of an email sign-up (section 5.2): the skeleton's reserved words, then (in
        // the store's transaction) a taken name and a look-alike of a protected account. Each refusal
        // offers a free `suggest` and consumes nothing: the pending identity stays for another try.
        const issue = usernameIssue(name);
        if (issue !== null && issue.code === 'usernameReserved') return json({ error: 'name_reserved', message: 'Ese nombre está reservado', suggest: s.suggestName(name, sl) }, 400);
        if (issue !== null) return error(400, 'bad_username', usernameProblem(name) ?? 'Nombre inválido');
        const r = s.createFromPending(pend, name, { ...refresh, kind: 'web' }, now, { lvl: oauthLevel(b.lvl), lang, tz: tzField(b.tz), news: b.news === true });
        if (r === 'username_taken') return json({ error: 'username_taken', message: 'Ese nombre ya está en uso', suggest: s.suggestName(name, sl) }, 409);
        if (r === 'lookalike') return json({ error: 'name_lookalike', message: 'Ese nombre se parece mucho a otro', suggest: s.suggestName(name, sl) }, 409);
        if (r === 'email_has_account') return error(409, 'email_has_account', 'Ese correo ya es de una cuenta de Turbogol: entra con ella para vincular');
        if (r === 'already_linked') return error(409, 'already_linked', 'Esa cuenta ya está vinculada a otro usuario');
        this.newAccountTaken(slots);
        return json(r);
      }
      case '/oauth-reauth': {
        const provider = b.provider as OAuthProvider;
        const refresh = grantOf(b.refresh);
        if (!OAUTH_PROVIDERS.includes(provider) || typeof b.providerId !== 'string' || b.providerId.length === 0 || b.providerId.length > 128) return error(400, 'bad_request');
        if (typeof b.userId !== 'string' || refresh === null || !isHex(b.replace, 32)) return error(400, 'bad_request');
        if (!s.devices(b.userId, now, null).some((d) => d.id === b.replace && d.kind === 'web')) return error(401, 'link_expired');
        const r = s.oauthReauth(provider, b.providerId, b.userId, { ...refresh, kind: 'web' }, now, oauthLevel(b.lvl));
        if (r === 'mismatch') return error(409, 'reauth_mismatch', 'Esa no es la cuenta con la que entras');
        if (r === 'no_user') return error(403, 'no_user');
        s.revokeDevice(b.userId, b.replace);
        return json(r);
      }
      case '/reauth': {
        // The password was checked by the Worker against `proved`, which must still be the hash.
        const rekey = rekeyOf(b.rekey);
        if (typeof b.userId !== 'string' || !isHex(b.hash, 64) || rekey === undefined) return error(400, 'bad_request');
        const pa = await this.throttleKey('pa', b.userId);
        if (!provedStill(b, s.passwordHash(b.userId), rekey)) return error(401, 'bad_credentials', 'Usuario o contraseña incorrectos');
        const r = s.markFresh(b.userId, b.hash, now, rekey);
        if (r === null) return error(401, 'no_refresh');
        s.throttleClear([pa]);
        return json(r);
      }
      case '/unlink': {
        const provider = b.provider as OAuthProvider;
        if (typeof b.userId !== 'string' || !OAUTH_PROVIDERS.includes(provider)) return error(400, 'bad_request');
        const level = b.level === 1 || b.level === 2 ? b.level : 0;
        const r = s.unlink(b.userId, provider, level, this.legacy(now).phase === 'closed');
        if (r === 'level2') return json({ error: 'reauth_required', message: 'Confirma que eres tú: vuelve a entrar con tu cuenta', level: 2 }, 403);
        if (r === 'last_method') return error(409, 'last_method', 'Es tu única forma de entrar: vincula otra antes');
        if (r === 'not_linked') return error(404, 'not_linked', 'Esa cuenta no está vinculada');
        if (r === 'no_user') return error(404, 'no_user');
        return json({ ok: true });
      }
      case '/tv-start': {
        if (!isHex(b.secret, 64) || typeof b.ip !== 'string' || b.ip.length > 64) return error(400, 'bad_request');
        // `checked` false: started without a solved check (a remote cannot answer one): the TV_OPEN_* caps count it too.
        const r = this.tv.start(b.ip, b.secret, now, whereOf(b.where), b.checked !== false);
        if (r === 'busy') return error(503, 'busy', 'Demasiados códigos desde tu red, inténtalo en unos minutos');
        return r === 'full' ? error(503, 'busy', 'Demasiados códigos ahora, inténtalo en un minuto') : json(r);
      }
      case '/tv-renew': {
        const code = tvCode(b.code);
        if (code === null || !isHex(b.secret, 64) || typeof b.ip !== 'string' || b.ip.length > 64) return error(400, 'bad_request');
        const r = this.tv.renew(code, b.secret, b.ip, now, whereOf(b.where));
        if (r === 'used') return error(409, 'tv_code_used', 'Ese código ya se usó');
        if (r === 'early') return error(409, 'tv_renew_early', 'Ese código aún no termina');
        if (r === 'expired') return error(410, 'tv_code_expired', 'El código caducó');
        if (r === 'busy' || r === 'full') return error(503, 'busy', 'Demasiados códigos desde tu red, inténtalo en unos minutos');
        return json(r);
      }
      case '/tv-info': {
        const code = tvCode(b.code);
        if (code === null || typeof b.userId !== 'string' || typeof b.username !== 'string' || typeof b.ip !== 'string' || b.ip.length > 64) return error(400, 'bad_request');
        if (s.credentialsById(b.userId)?.banned === true) return error(403, 'banned', 'Cuenta suspendida');
        const r = this.tv.info(code, { userId: b.userId, username: b.username }, b.ip, now, whereOf(b.phone));
        if (typeof r === 'object' && 'throttled' in r) return json({ error: 'throttled', message: 'Demasiados intentos, espera un momento', retryAfterMs: r.throttled }, 429);
        if (r === 'wrong') return error(404, 'tv_code_wrong', 'Ese código no existe');
        if (r === 'expired') return error(410, 'tv_code_expired', 'El código caducó');
        if (r === 'used') return error(409, 'tv_code_used', 'Ese código ya se usó');
        return json(r);
      }
      case '/tv-confirm': {
        const code = tvCode(b.code);
        if (code === null || typeof b.userId !== 'string' || typeof b.username !== 'string' || typeof b.ip !== 'string' || b.ip.length > 64) return error(400, 'bad_request');
        // A suspended account grants no TV (its Bearer may still be valid): said on the phone, at once.
        if (s.credentialsById(b.userId)?.banned === true) return error(403, 'banned', 'Cuenta suspendida');
        const r = this.tv.confirm(code, { userId: b.userId, username: b.username }, b.ip, now);
        if (typeof r === 'object') return json({ error: 'throttled', message: 'Demasiados intentos, espera un momento', retryAfterMs: r.throttled }, 429);
        if (r === 'wrong') return error(404, 'tv_code_wrong', 'Ese código no existe');
        if (r === 'expired') return error(410, 'tv_code_expired', 'El código caducó');
        if (r === 'used') return error(409, 'tv_code_used', 'Ese código ya se usó');
        return json({ ok: true });
      }
      case '/tv-poll': {
        const code = tvCode(b.code);
        const refresh = grantOf(b.refresh);
        if (code === null || !isHex(b.secret, 64) || refresh === null) return error(400, 'bad_request');
        const r = this.tv.poll(code, b.secret, now);
        if (r === 'pending') return json({ state: 'pending' });
        if (r === 'expired') return error(410, 'tv_code_expired', 'El código caducó');
        if (r === 'used') return error(409, 'tv_code_used', 'Ese código ya se usó');
        // A TV the phone approved: a limited scope (accountStore.ts kind 'tv'), whatever the Worker sent.
        const u = s.signedIn(r.userId, { ...refresh, kind: 'tv' }, now);
        if (u !== null) return json(u);
        // Suspended after the confirm: the TV says so; deleted meanwhile: the approval went with it.
        return s.credentialsById(r.userId)?.banned === true ? error(403, 'banned', 'Cuenta suspendida') : error(410, 'tv_code_expired', 'El código caducó');
      }
      case '/rename': {
        if (typeof b.userId !== 'string' || typeof b.username !== 'string' || usernameProblem(b.username) !== null) return error(400, 'bad_request');
        const r = s.rename(b.userId, b.username, now);
        // A refused name gets one that is free right now (section 5.1), in the account's language when it has one.
        const lang = b.lang === 'es' ? 'es' : 'en';
        if (r === 'taken') return json({ error: 'username_taken', message: 'Ese usuario ya existe', suggest: s.suggestName(b.username, lang, b.userId) }, 409);
        if (r === 'lookalike') return json({ error: 'name_lookalike', message: 'Ese nombre se parece mucho a otro', suggest: s.suggestName(b.username, lang, b.userId) }, 409);
        if (r === 'too_soon') return error(429, 'rename_too_soon', 'Puedes cambiar el nombre una vez cada 30 días');
        if (r === 'no_user') return error(404, 'no_user');
        return json(r);
      }
      case '/training': {
        if (typeof b.userId !== 'string' || typeof b.records !== 'object' || b.records === null) return error(400, 'bad_request');
        const r = s.mergeTraining(b.userId, parseTrainingRecords(b.records), now);
        if (r === 'no_user') return error(404, 'no_user');
        return json({ records: r });
      }
      case '/experimental/set': {
        if (typeof b.userId !== 'string' || typeof b.enabled !== 'boolean') return error(400, 'bad_request');
        const r = s.setExperimental(b.userId, b.enabled, now);
        return r === 'no_user' ? error(404, 'no_user') : json(r);
      }
      case '/presets/upsert': {
        if (typeof b.userId !== 'string') return error(400, 'bad_request');
        const preset = parseStoredPreset(b.preset);
        if (preset === null) return error(400, 'bad_preset');
        const r = s.upsertPreset(b.userId, preset, now);
        if (r === 'too_many') return error(409, 'too_many');
        return r === 'no_user' ? error(404, 'no_user') : json(r);
      }
      case '/replay-name/set': {
        if (typeof b.userId !== 'string' || typeof b.hidden !== 'boolean') return error(400, 'bad_request');
        const r = s.setReplayName(b.userId, b.hidden, now);
        return r === 'no_user' ? error(404, 'no_user') : json(r);
      }
      case '/replay-hidden': {
        const list = (v: unknown): v is string[] => Array.isArray(v) && v.length <= REPLAY_HIDDEN_MAX && v.every((x) => typeof x === 'string' && x.length <= 64);
        if (!list(b.ids) || !list(b.names)) return error(400, 'bad_request');
        return json(s.replayHidden(b.ids, b.names));
      }
      case '/presets/delete': {
        if (typeof b.userId !== 'string') return error(400, 'bad_request');
        if (typeof b.id !== 'string' || !PRESET_ID_RE.test(b.id)) return error(400, 'bad_preset');
        const r = s.deletePreset(b.userId, b.id);
        return r === 'no_user' ? error(404, 'no_user') : json(r);
      }
      case '/car': {
        if (typeof b.userId !== 'string') return error(400, 'bad_request');
        if (!isCarId(b.car)) return error(400, 'bad_car');
        const r = s.setCar(b.userId, b.car, now);
        if (r === 'not_owned') return error(409, 'not_owned', 'Ese auto no es tuyo todavía');
        return r === 'no_user' ? error(404, 'no_user') : json(r);
      }
      case '/equipped': {
        const ids = b.userIds;
        if (!Array.isArray(ids) || ids.length > EQUIPPED_MAX || !ids.every((id): id is string => typeof id === 'string' && id.length <= 64)) return error(400, 'bad_request');
        return json({ cars: s.equippedCars(ids) });
      }
      case '/shop/claim': {
        if (typeof b.userId !== 'string' || typeof b.item !== 'string' || !ITEM_ID_RE.test(b.item)) return error(400, 'bad_request');
        const r = s.claim(b.userId, b.item, now);
        if (r === 'no_user') return error(404, 'no_user');
        if (r === 'unknown_item') return error(404, 'unknown_item');
        return typeof r === 'string' ? error(409, r) : json(r);
      }
      case '/host-credit': {
        const c = b as Partial<HostCredit>;
        if (!isHex(c.matchId, 64) || !isHex(c.userId, 16) || typeof c.nodeId !== 'string' || c.nodeId.length > 64) return error(400, 'bad_request');
        if (typeof c.points !== 'number' || !Number.isFinite(c.points) || c.points < 0 || c.points > HOST_CREDIT_MAX || typeof c.verified !== 'boolean' || typeof c.at !== 'number') return error(400, 'bad_request');
        return json({ ok: true, applied: s.hostCredit({ matchId: c.matchId, userId: c.userId, nodeId: c.nodeId, points: c.points, verified: c.verified, at: c.at }) });
      }
      case '/host-freeze': {
        if (!isHex(b.userId, 16) || typeof b.reason !== 'string' || typeof b.at !== 'number' || !(b.at > 0)) return error(400, 'bad_request');
        return json({ ok: true, applied: s.hostFreeze(b.userId, b.reason.slice(0, 120), b.at) });
      }
      case '/host-grant': {
        if (typeof b.userId !== 'string' || typeof b.item !== 'string') return error(400, 'bad_request');
        const r = s.grant(b.userId, b.item, now);
        if (r === 'no_user') return error(404, 'no_user');
        return r === 'unknown_item' ? error(404, 'unknown_item') : json(r);
      }
      case '/host-revoke': {
        if (typeof b.userId !== 'string' || typeof b.item !== 'string') return error(400, 'bad_request');
        return json(s.revoke(b.userId, b.item));
      }
      case '/host-unfreeze': {
        if (typeof b.userId !== 'string') return error(400, 'bad_request');
        return json({ unfrozen: s.unfreeze(b.userId, now) });
      }
      case '/account-stats': {
        if ((b.operatorIds !== null && !isIdList(b.operatorIds, STATS_OPERATORS_MAX)) || !isIdList(b.trusted, STATS_TRUSTED_MAX)) return error(400, 'bad_request');
        return json(s.accountStats(b.operatorIds, b.trusted, now));
      }
      case '/dev-signin': {
        // The Worker reaches this only through mail.ts isDevAuth (a loopback host); the object
        // refuses it too wherever DEV_AUTH is not '1', as an unknown path (production never sets it).
        if (this.env.DEV_AUTH !== '1') return error(404, 'not_found');
        const refresh = grantOf(b.refresh);
        if (typeof b.name !== 'string' || refresh === null) return error(400, 'bad_request');
        const r = s.devSignIn(b.name, { ...refresh, kind: 'web' }, now);
        if (r === 'bad_name') return error(400, 'bad_name', DEV_NAME_PROBLEM);
        if (r === 'banned') return error(403, 'banned', 'Cuenta suspendida');
        if (r === 'taken') return error(409, 'email_taken');
        return json(r);
      }
      case '/ranked-check': {
        if (typeof b.userId !== 'string' || !Array.isArray(b.playlists) || !b.playlists.every(isPlaylist)) return error(400, 'bad_request');
        return json(s.rankedCheck(b.userId, b.playlists as Playlist[], now));
      }
      case '/ranked-lock': {
        if (typeof b.matchId !== 'string' || typeof b.region !== 'string' || !Array.isArray(b.userIds) || typeof b.until !== 'number') return error(400, 'bad_request');
        s.rankedLock(b.matchId, b.region, b.userIds.filter((x): x is string => typeof x === 'string'), b.until);
        return json({ ok: true });
      }
      case '/ranked-result': {
        const r = b as unknown as RankedResultInput;
        if (typeof r.matchId !== 'string' || !isPlaylist(r.playlist) || typeof r.region !== 'string' || ![0, 1, -1].includes(r.winner) || !Array.isArray(r.players)) return error(400, 'bad_request');
        const players = r.players.filter((p) => p && typeof p.id === 'string' && (p.team === 0 || p.team === 1)).map((p) => ({ id: p.id, team: p.team, left: p.left === true }));
        const applied = s.applyRankedResult({ ...r, blue: Number(r.blue) || 0, red: Number(r.red) || 0, players }, now);
        return json({ ok: true, applied });
      }
      case '/ranked-cancel': {
        if (typeof b.matchId !== 'string' || !isPlaylist(b.playlist) || typeof b.region !== 'string' || !Array.isArray(b.players) || !Array.isArray(b.noShows)) return error(400, 'bad_request');
        const ids = (v: unknown[]): string[] => v.filter((x): x is string => typeof x === 'string');
        const applied = s.cancelRanked(b.matchId, b.playlist, b.region, ids(b.players), ids(b.noShows), typeof b.reason === 'string' ? b.reason.slice(0, 32) : 'cancelled', now);
        return json({ ok: true, applied });
      }
    }
    return error(404, 'not_found');
  }
}
