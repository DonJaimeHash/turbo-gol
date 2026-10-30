/**
 * AccountsDO: the one Durable Object that owns every registered account, rating and ranked
 * result (SQLite storage: AccountStore). Reached only from this deployment (internal header): the
 * Worker routes in accountRoutes.ts do the hashing / cookies / OAuth and call these endpoints; the
 * MatchDO reports ranked matches; the matchmaker never talks to it (the Worker passes ratings in).
 *
 *   POST /register        { username, pw, recovery, refresh }        -> UserRef | 409 username_taken
 *   POST /auth-begin      { username, ip, account?, device?, charge? } -> Credentials | { found: false } | 429 throttled
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
 *   POST /password        { userId, pw, keep?, signOutOthers?, proved? } -> { ok } (other sessions signed out unless
 *                                                                     signOutOthers is false: a first password) | 401
 *                                                                     bad_credentials (`proved` is no longer the hash)
 *   POST /recovery        { userId, hashes }                         -> { ok }
 *   POST /recover         { username, code, pw, refresh, ip, device? } -> UserRef & { codesLeft } (level 2, method
 *                                                                     'reset') | 401 (an account with a verified email
 *                                                                     too) | 429
 *   POST /oauth           { provider, providerId, name, linkTo, refresh, replace?, lvl } -> UserRef & { created } | 409
 *                                                                     already_linked (another account's) | 409 provider_set
 *                                                                     (the account has another of it) | 403 no_user (suspended);
 *                                                                     `replace`: the device that asked (its tokens go: the
 *                                                                     browser takes the new one), gone meanwhile = 401 link_expired
 *     `lvl`: the level of the press on the provider's page (R6: 1 for Google's account chooser and
 *     Discord's Authorize, 0 for a start from before levels), at most 1 here
 *   POST /oauth-reauth    { provider, providerId, userId, refresh, replace, lvl } -> UserRef | 409 reauth_mismatch
 *   POST /reauth          { userId, hash, proved, rekey? }           -> UserRef (that token proves a credential now, at
 *                                                                     level 2) | 401
 *   POST /unlink          { userId, provider, level }                -> { ok } | 409 last_method | 404 not_linked | 403
 *                                                                     reauth_required { level: 2 } (one way in would be
 *                                                                     left and the session is below the account's ceiling)
 *   POST /rename          { userId, username }                       -> UserRef | 409 taken | 429 too_soon
 *   GET  /me?userId=                                                 -> MeInfo | 404
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
 *   POST /tv-start        { ip, secret, where? }                     -> { code, expiresAt } | 503 busy (the table, or the
 *                                                                     caller's /48 or /24, is full)
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
 *   POST /account-stats   { operatorIds, trusted } (a maintainer, nodeRoutes.ts) -> AccountStats: counts and
 *                                                                     booleans only (accountStore.ts accountStats);
 *                                                                     operatorIds null = unknown (no node settings)
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
import { EXPERIMENTAL_REFUSED, carriesPhysics, error, json, limitKey } from './env';
import { checkInternal } from './auth';
import { AccountStore } from './accountStore';
import { TvCodes, tvCode } from './tvCodes';
import type { TvWhere } from './tvCodes';
import { sitePrefix } from './limits';
import type { HostCredit, PasswordRecord, RankedResultInput, RefreshGrant, ThrottleEntry } from './accountStore';
import { isPlaylist, OAUTH_PROVIDERS, usernameKey, usernameProblem } from '../../src/net/account';
import { parseTrainingRecords } from '../../src/game/trainingRecords';
import { PRESET_ID_RE, parseStoredPreset } from '../../src/game/physicsRules';
import type { OAuthProvider, Playlist } from '../../src/net/account';
import { isCarId } from '../../src/game/cosmetics';
import { ITEM_ID_RE } from '../../nodes/control-plane/shop';

const LOGIN_WINDOW_MS = 15 * 60_000;
/** The most accounts one /equipped asks for (a lobby's members: a 3v3). */
const EQUIPPED_MAX = 6;
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

function isHashList(v: unknown, max: number): v is string[] {
  return Array.isArray(v) && v.length <= max && v.every((h) => isHex(h, 64));
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
      if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now() + PRUNE_EVERY_MS);
    });
  }

  override async alarm(): Promise<void> {
    this.store.prune(this.now());
    this.tv.sweep(this.now(), true);
    await this.ctx.storage.setAlarm(Date.now() + PRUNE_EVERY_MS);
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
      case '/me': {
        const me = this.store.me(p.get('userId') ?? '', now);
        return me ? json(me) : error(404, 'no_user');
      }
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
  private async checkKeys(username: string, ip: unknown, b: Record<string, unknown>): Promise<{ keys: ThrottleKey[]; clear: string[]; account: boolean }> {
    const R = THROTTLE_RULES;
    if (typeof b.account === 'string' && b.account.length > 0 && b.account.length <= 64) {
      const pa = await this.throttleKey('pa', b.account);
      return { keys: [{ key: pa, rule: R.pair }], clear: [pa], account: true };
    }
    const user = usernameKey(username);
    const addr = typeof ip === 'string' && ip.length > 0 && ip.length < 64 ? ip : '';
    const net = addr === '' ? '' : limitKey(addr);
    const v6 = addr.includes(':') && !addr.includes('.');
    const site = v6 ? sitePrefix(addr) : null;
    const known = this.knownDevice(username, b);
    const pair = await this.throttleKey('up', user + '|' + net);
    const who = known !== null ? await this.throttleKey('d', known) : await this.throttleKey('u', user);
    const keys: ThrottleKey[] = [{ key: pair, rule: R.pair }, { key: who, rule: known !== null ? R.pair : R.user }];
    // A known browser proved this account's password here before: its 'd:' counter bounds it, so a
    // network's or a /48's pause (a classroom's typos, a sprayer next door) never stops it, and its
    // own typos never count toward one.
    if (known === null) {
      if (net !== '') keys.push({ key: await this.throttleKey('ip', net), rule: v6 ? R.net6 : R.net4 });
      if (site !== null) keys.push({ key: await this.throttleKey('w', site), rule: R.site });
    }
    const clear = [pair, who];
    if (known !== null) clear.push(await this.throttleKey('u', user));
    return { keys, clear, account: false };
  }

  /** This browser's device id when its device cookie is one of the account `username` names (it signed in there before); null otherwise. */
  private knownDevice(username: string, b: Record<string, unknown>): string | null {
    const d = b.device as { user?: unknown; id?: unknown } | null | undefined;
    if (!d || typeof d !== 'object' || typeof d.user !== 'string' || typeof d.id !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(d.id)) return null;
    return this.store.credentials(username)?.userId === d.user ? d.id : null;
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

  private async post(path: string, request: Request, now: number): Promise<Response> {
    const b = await body<Record<string, unknown>>(request);
    if (!b) return error(400, 'bad_request');
    // A match with experimental rules counts for nothing: no rating, no ranked lock, no abandon or
    // no-show penalty, no training record. Such a report is refused, whoever sent it.
    if ((path === '/ranked-result' || path === '/ranked-cancel' || path === '/ranked-lock' || path === '/training') && carriesPhysics(b)) {
      return error(400, EXPERIMENTAL_REFUSED, 'a match with experimental rules records nothing');
    }
    const s = this.store;
    switch (path) {
      case '/register': {
        const refresh = grantOf(b.refresh);
        if (typeof b.username !== 'string' || usernameProblem(b.username) !== null || !isPw(b.pw) || !isHashList(b.recovery, 16) || refresh === null) return error(400, 'bad_request');
        const r = s.register(b.username, b.pw, b.recovery, { ...refresh, kind: 'web' }, now);
        return r === 'taken' ? error(409, 'username_taken', 'Ese usuario ya existe') : json(r);
      }
      case '/auth-begin': {
        if (typeof b.username !== 'string' || b.username.length > 64) return error(400, 'bad_request');
        const { keys } = await this.checkKeys(b.username, b.ip, b);
        const wait = this.throttled(keys, now);
        if (wait > 0) return throttledAnswer(wait);
        // The check the Worker is about to make counts now, in this synchronous step with the test
        // above: a burst of requests in flight at once gets no more checks than the counters allow.
        if (b.charge === true) this.fail(keys, now);
        const c = s.credentials(b.username);
        return json(c === null ? { found: false } : { found: true, ...c });
      }
      case '/auth-finish': {
        if (typeof b.username !== 'string' || b.username.length > 64) return error(400, 'bad_request');
        const { keys, clear, account } = await this.checkKeys(b.username, b.ip, b);
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
          return error(401, 'bad_credentials', 'Usuario o contraseña incorrectos');
        }
        const r = s.signedIn(b.userId, { ...refresh, kind: 'web' }, now, { lvl: 2, method: 'legacy' }, rekey);
        if (r === null) return error(403, 'banned');
        s.throttleClear(clear);
        // The network's and the /48's counters keep failures only: this check's charge goes back.
        if (charged) this.refund(keys.filter((k) => !clear.includes(k.key)));
        return json(r);
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
      case '/password': {
        if (typeof b.userId !== 'string' || !isPw(b.pw)) return error(400, 'bad_request');
        // A change that proved the old password: that password must still be the account's.
        if (typeof b.proved === 'string' && s.passwordHash(b.userId) !== b.proved) return error(401, 'bad_credentials', 'Usuario o contraseña incorrectos');
        if (!s.setPassword(b.userId, b.pw)) return error(404, 'no_user');
        if (b.signOutOthers !== false) s.deleteRefreshOf(b.userId, isHex(b.keep, 64) ? b.keep : undefined);
        return json({ ok: true });
      }
      case '/recovery': {
        if (typeof b.userId !== 'string' || !isHashList(b.hashes, 16)) return error(400, 'bad_request');
        s.setRecovery(b.userId, b.hashes);
        return json({ ok: true });
      }
      case '/recover': {
        const refresh = grantOf(b.refresh);
        if (typeof b.username !== 'string' || b.username.length > 64 || !isHex(b.code, 64) || !isPw(b.pw) || refresh === null) return error(400, 'bad_request');
        const { keys, clear } = await this.checkKeys(b.username, b.ip, b);
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
        if (typeof b.name !== 'string' || refresh === null) return error(400, 'bad_request');
        const linkTo = typeof b.linkTo === 'string' ? b.linkTo : null;
        // A link comes from a device that is still signed in (PERFIL's): signed out meanwhile, nothing links.
        const replace = typeof b.replace === 'string' && /^[0-9a-f]{32}$/.test(b.replace) ? b.replace : null;
        if (linkTo !== null && (replace === null || !s.devices(linkTo, now, null).some((d) => d.id === replace && d.kind === 'web'))) return error(401, 'link_expired');
        const r = s.oauth(provider, b.providerId, b.name, linkTo, { ...refresh, kind: 'web' }, now, oauthLevel(b.lvl));
        if (r === 'already_linked') return error(409, 'already_linked', 'Esa cuenta ya está vinculada a otro usuario');
        if (r === 'provider_set') return error(409, 'provider_set', 'Tu cuenta ya tiene otra cuenta de ese proveedor: desvincúlala primero');
        if (r === 'no_user') return error(403, 'no_user');
        if (linkTo !== null && replace !== null) s.revokeDevice(linkTo, replace);
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
        const r = s.unlink(b.userId, provider, level);
        if (r === 'level2') return json({ error: 'reauth_required', message: 'Confirma que eres tú: vuelve a entrar con tu cuenta', level: 2 }, 403);
        if (r === 'last_method') return error(409, 'last_method', 'Es tu única forma de entrar: vincula otra antes');
        if (r === 'not_linked') return error(404, 'not_linked', 'Esa cuenta no está vinculada');
        if (r === 'no_user') return error(404, 'no_user');
        return json({ ok: true });
      }
      case '/tv-start': {
        if (!isHex(b.secret, 64) || typeof b.ip !== 'string' || b.ip.length > 64) return error(400, 'bad_request');
        const r = this.tv.start(b.ip, b.secret, now, whereOf(b.where));
        if (r === 'busy') return error(503, 'busy', 'Demasiados códigos desde tu red, inténtalo en unos minutos');
        return r === 'full' ? error(503, 'busy', 'Demasiados códigos ahora, inténtalo en un minuto') : json(r);
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
        if (r === 'taken') return error(409, 'username_taken', 'Ese usuario ya existe');
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
