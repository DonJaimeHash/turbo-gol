/**
 * AccountsDO: the one Durable Object that owns every registered account, rating and ranked
 * result (SQLite storage: AccountStore). Reached only from this deployment (internal header): the
 * Worker routes in accountRoutes.ts do the hashing / cookies / OAuth and call these endpoints; the
 * MatchDO reports ranked matches; the matchmaker never talks to it (the Worker passes ratings in).
 *
 *   POST /register        { username, pw, recovery, refresh }        -> UserRef | 409 username_taken
 *   POST /auth-begin      { username, ip }                           -> Credentials | { found: false } | 429 throttled
 *   POST /auth-finish     { userId?, username, ip, ok, refresh? }    -> UserRef (ok) | { ok: false }
 *   POST /refresh         { old, next }                              -> UserRef | 401
 *   POST /refresh-owner   { hash }                                   -> UserRef | 404
 *   POST /logout          { hash }
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
 *
 * Brute force (in memory, per object = global): a username with LOGIN_FAILS_FREE failures in the
 * window is throttled with a doubling delay up to LOGIN_LOCK_MAX_MS; an IP with LOGIN_IP_MAX failures
 * per window too. Recovery attempts share the same counters. A daily alarm prunes old rows.
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import { error, json } from './env';
import { checkInternal } from './auth';
import { AccountStore } from './accountStore';
import type { PasswordRecord, RankedResultInput } from './accountStore';
import { isPlaylist, OAUTH_PROVIDERS, usernameKey, usernameProblem } from '../../src/net/account';
import type { OAuthProvider, Playlist } from '../../src/net/account';

const LOGIN_WINDOW_MS = 15 * 60_000;
export const LOGIN_FAILS_FREE = 5;
const LOGIN_LOCK_BASE_MS = 30_000;
export const LOGIN_LOCK_MAX_MS = 15 * 60_000;
const LOGIN_IP_MAX = 30;
const PRUNE_EVERY_MS = 24 * 60 * 60_000;
const BODY_MAX = 16_384;

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
    const s = this.store;
    switch (path) {
      case '/register': {
        if (typeof b.username !== 'string' || usernameProblem(b.username) !== null || !isPw(b.pw) || !isHashList(b.recovery, 16) || !isHex(b.refresh, 64)) return error(400, 'bad_request');
        const r = s.register(b.username, b.pw, b.recovery, b.refresh, now);
        return r === 'taken' ? error(409, 'username_taken', 'Ese usuario ya existe') : json(r);
      }
      case '/auth-begin': {
        if (typeof b.username !== 'string' || b.username.length > 64) return error(400, 'bad_request');
        const wait = this.throttled(this.failKeys(b.username, b.ip), now);
        if (wait > 0) return json({ error: 'throttled', message: 'Demasiados intentos, esperá un momento', retryAfterMs: wait }, 429);
        const c = s.credentials(b.username);
        return json(c === null ? { found: false } : { found: true, ...c });
      }
      case '/auth-finish': {
        if (typeof b.username !== 'string') return error(400, 'bad_request');
        const keys = this.failKeys(b.username, b.ip);
        if (b.ok !== true || typeof b.userId !== 'string' || !isHex(b.refresh, 64)) {
          this.fail(keys, now);
          return json({ ok: false });
        }
        const r = s.signedIn(b.userId, b.refresh, now);
        if (r === null) return error(403, 'banned');
        this.fails.delete(keys[0]);
        return json(r);
      }
      case '/refresh': {
        if (!isHex(b.old, 64) || !isHex(b.next, 64)) return error(400, 'bad_request');
        const r = s.rotateRefresh(b.old, b.next, now);
        return r ? json(r) : error(401, 'bad_refresh');
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
        if (typeof b.username !== 'string' || !isHex(b.code, 64) || !isPw(b.pw) || !isHex(b.refresh, 64)) return error(400, 'bad_request');
        const keys = this.failKeys(b.username, b.ip);
        const wait = this.throttled(keys, now);
        if (wait > 0) return json({ error: 'throttled', message: 'Demasiados intentos, esperá un momento', retryAfterMs: wait }, 429);
        const r = s.recover(b.username, b.code, b.pw, b.refresh, now);
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
        if (typeof b.name !== 'string' || !isHex(b.refresh, 64)) return error(400, 'bad_request');
        const linkTo = typeof b.linkTo === 'string' ? b.linkTo : null;
        const r = s.oauth(provider, b.providerId, b.name, linkTo, b.refresh, now);
        if (r === 'already_linked') return error(409, 'already_linked', 'Esa cuenta ya está vinculada a otro usuario');
        if (r === 'no_user') return error(403, 'no_user');
        return json(r);
      }
      case '/rename': {
        if (typeof b.userId !== 'string' || typeof b.username !== 'string' || usernameProblem(b.username) !== null) return error(400, 'bad_request');
        const r = s.rename(b.userId, b.username, now);
        if (r === 'taken') return error(409, 'username_taken', 'Ese usuario ya existe');
        if (r === 'too_soon') return error(429, 'rename_too_soon', 'Podés cambiar el nombre una vez cada 30 días');
        if (r === 'no_user') return error(404, 'no_user');
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
