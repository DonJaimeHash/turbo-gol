/**
 * AccountsDO: the one Durable Object that owns every registered account, rating and ranked
 * result (SQLite storage: AccountStore). Reached only from this deployment (internal header): the
 * Worker routes in accountRoutes.ts do the hashing / cookies / OAuth and call these endpoints; the
 * MatchDO reports ranked matches; the matchmaker never talks to it (the Worker passes ratings in).
 *
 *   POST /register        { username, pw, recovery, refresh }        -> UserRef | 409 username_taken
 *   POST /auth-begin      { username, ip }                           -> Credentials | { found: false } | 429 throttled
 *   POST /auth-finish     { userId?, username, ip, ok, refresh? }    -> UserRef (ok) | { ok: false }
 *   POST /refresh         { old, oldFamily?, next }                  -> UserRef | 401 bad_refresh | 401 refresh_reused
 *                                                                     (the family revoked) | 409 refresh_race (two tabs)
 *   POST /refresh-owner   { hash }                                   -> UserRef & { kind, device } | 404
 *   POST /logout          { hash }                                   (that device: its whole family)
 *   POST /sessions        { userId, current? }                       -> { sessions: DeviceRow[] }
 *   POST /sessions/revoke { userId, id }                             -> { revoked } (that device's tokens)
 *   POST /sessions/revoke-all { userId }                             -> { revoked } (every device, this one too)
 *     `refresh` / `next` in every call that stores one: a RefreshGrant { hash, family?, kind?, country?,
 *     city? } (accountStore.ts), or the hash alone (a family of its own).
 *   POST /password        { userId, pw, keep? }                      -> { ok } (other sessions signed out)
 *   POST /recovery        { userId, hashes }                         -> { ok }
 *   POST /recover         { username, code, pw, refresh, ip }        -> UserRef & { codesLeft } | 401 | 429
 *   POST /oauth           { provider, providerId, name, linkTo, refresh } -> UserRef & { created } | 409
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
 *   POST /tv-start        { ip, secret }                             -> { code, expiresAt } | 503 busy
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
 *
 * Brute force (in memory, per object = global): a username with LOGIN_FAILS_FREE failures in the
 * window is throttled with a doubling delay up to LOGIN_LOCK_MAX_MS; an IP with LOGIN_IP_MAX failures
 * per window too. Recovery attempts share the same counters. A daily alarm prunes old rows.
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import { EXPERIMENTAL_REFUSED, carriesPhysics, error, json } from './env';
import { checkInternal } from './auth';
import { AccountStore } from './accountStore';
import { TvCodes, tvCode } from './tvCodes';
import type { HostCredit, PasswordRecord, RankedResultInput, RefreshGrant } from './accountStore';
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
const LOGIN_IP_MAX = 30;
const PRUNE_EVERY_MS = 24 * 60 * 60_000;
const BODY_MAX = 16_384;
/**
 * More points than one match can earn (six players for an hour at the top region factor, sampled
 * at 1 in 5 is about 5,400): a /host-credit that says more is junk, refused.
 */
const HOST_CREDIT_MAX = 100_000;

interface FailEntry {
  count: number;
  first: number;
  lockedUntil: number;
}

/** Throttle state after one more failure (pure, unit-tested). */
export function nextFail(prev: FailEntry | undefined, now: number): FailEntry {
  const e = prev === undefined || now - prev.first > LOGIN_WINDOW_MS ? { count: 0, first: now, lockedUntil: 0 } : { ...prev };
  e.count++;
  if (e.count >= LOGIN_FAILS_FREE) e.lockedUntil = now + Math.min(LOGIN_LOCK_MAX_MS, LOGIN_LOCK_BASE_MS * 2 ** (e.count - LOGIN_FAILS_FREE));
  return e;
}

function isHex(v: unknown, len: number): v is string {
  return typeof v === 'string' && v.length === len && /^[0-9a-f]+$/.test(v);
}

function isPw(v: unknown): v is PasswordRecord {
  if (!v || typeof v !== 'object') return false;
  const p = v as PasswordRecord;
  return isHex(p.hash, 64) && isHex(p.salt, 32) && Number.isInteger(p.iter) && p.iter >= 10_000 && p.iter <= 10_000_000;
}

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
  private readonly fails = new Map<string, FailEntry>();
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
    for (const [k, e] of this.fails) if (this.now() - e.first > LOGIN_WINDOW_MS && e.lockedUntil <= this.now()) this.fails.delete(k);
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

  private throttled(keys: readonly string[], now: number): number {
    let wait = 0;
    for (const k of keys) {
      const e = this.fails.get(k);
      if (e && e.lockedUntil > now) wait = Math.max(wait, e.lockedUntil - now);
    }
    return wait;
  }

  private fail(keys: readonly string[], now: number): void {
    for (const k of keys) {
      const e = nextFail(this.fails.get(k), now);
      // An IP gets more room than one username (a household / campus shares an address).
      if (k.startsWith('ip:') && e.count < LOGIN_IP_MAX) e.lockedUntil = 0;
      this.fails.set(k, e);
    }
  }

  private failKeys(username: string, ip: unknown): string[] {
    const keys = ['u:' + usernameKey(username)];
    if (typeof ip === 'string' && ip.length > 0 && ip.length < 64) keys.push('ip:' + ip);
    return keys;
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
        const wait = this.throttled(this.failKeys(b.username, b.ip), now);
        if (wait > 0) return json({ error: 'throttled', message: 'Demasiados intentos, espera un momento', retryAfterMs: wait }, 429);
        const c = s.credentials(b.username);
        return json(c === null ? { found: false } : { found: true, ...c });
      }
      case '/auth-finish': {
        if (typeof b.username !== 'string') return error(400, 'bad_request');
        const keys = this.failKeys(b.username, b.ip);
        const refresh = grantOf(b.refresh);
        if (b.ok !== true || typeof b.userId !== 'string' || refresh === null) {
          this.fail(keys, now);
          return json({ ok: false });
        }
        const r = s.signedIn(b.userId, { ...refresh, kind: 'web' }, now);
        if (r === null) return error(403, 'banned');
        this.fails.delete(keys[0]);
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
        if (isHex(b.hash, 64)) s.deleteRefresh(b.hash);
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
        if (!s.setPassword(b.userId, b.pw)) return error(404, 'no_user');
        s.deleteRefreshOf(b.userId, isHex(b.keep, 64) ? b.keep : undefined);
        return json({ ok: true });
      }
      case '/recovery': {
        if (typeof b.userId !== 'string' || !isHashList(b.hashes, 16)) return error(400, 'bad_request');
        s.setRecovery(b.userId, b.hashes);
        return json({ ok: true });
      }
      case '/recover': {
        const refresh = grantOf(b.refresh);
        if (typeof b.username !== 'string' || !isHex(b.code, 64) || !isPw(b.pw) || refresh === null) return error(400, 'bad_request');
        const keys = this.failKeys(b.username, b.ip);
        const wait = this.throttled(keys, now);
        if (wait > 0) return json({ error: 'throttled', message: 'Demasiados intentos, espera un momento', retryAfterMs: wait }, 429);
        const r = s.recover(b.username, b.code, b.pw, { ...refresh, kind: 'web' }, now);
        if (r === null) {
          this.fail(keys, now);
          return error(401, 'bad_recovery', 'Usuario o código de recuperación incorrecto');
        }
        this.fails.delete(keys[0]);
        return json(r);
      }
      case '/oauth': {
        const provider = b.provider as OAuthProvider;
        if (!OAUTH_PROVIDERS.includes(provider) || typeof b.providerId !== 'string' || b.providerId.length === 0 || b.providerId.length > 128) return error(400, 'bad_request');
        const refresh = grantOf(b.refresh);
        if (typeof b.name !== 'string' || refresh === null) return error(400, 'bad_request');
        const linkTo = typeof b.linkTo === 'string' ? b.linkTo : null;
        const r = s.oauth(provider, b.providerId, b.name, linkTo, { ...refresh, kind: 'web' }, now);
        if (r === 'already_linked') return error(409, 'already_linked', 'Esa cuenta ya está vinculada a otro usuario');
        if (r === 'no_user') return error(403, 'no_user');
        return json(r);
      }
      case '/tv-start': {
        if (!isHex(b.secret, 64) || typeof b.ip !== 'string' || b.ip.length > 64) return error(400, 'bad_request');
        const r = this.tv.start(b.ip, b.secret, now);
        return r === 'full' ? error(503, 'busy', 'Demasiados códigos ahora, inténtalo en un minuto') : json(r);
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
