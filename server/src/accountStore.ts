/**
 * AccountStore: every account / ranked table of the game, on SQLite. In production it runs on the
 * AccountsDO's own SQLite storage (ctx.storage.sql, one object for every account: 25,000 accounts
 * are a few MB); server/test/accounts.test.mjs runs the same code on node:sqlite. Synchronous by
 * design: a Durable Object's SQL calls are synchronous and a handler that never awaits between two
 * statements is atomic; multi-statement writes still go through `tx` (transactionSync).
 *
 * Nothing here hashes: the Worker derives password hashes (server/src/accountRoutes.ts) and hands
 * hex strings; refresh tokens and recovery codes arrive as SHA-256 hex. Ids are 16 hex chars like
 * guest ids (the session `sub`).
 *
 * Tables
 *   users            id, username (display), ukey (unique, usernameKey), password hash/salt/iterations
 *                    (null for an OAuth-only account), recovery code hashes (JSON), google / discord ids
 *   refresh          sha256(refresh token) -> user, sliding expiry (REFRESH_TTL_MS)
 *   ratings          (user, playlist, season) -> mu, sigma, games, wins, losses, peak
 *   ranked_matches   one row per reported / cancelled ranked match (idempotency + results)
 *   ranked_players   per player of a ranked match: before / after, outcome, ban started
 *   abandons, bans   ranked abandon history (24 h window) and the queue ban it causes
 *   ranked_locks     a player's live ranked match (one at a time across every region matchmaker)
 *   training         (user, pack) -> best run of a training pack (src/game/trainingRecords.ts)
 *   experimental     user -> Settings > Experimental's switch (src/game/experimentalStore.ts)
 *   presets          (user, preset) -> one physics preset: its name and canonical values as JSON
 *                    (src/game/physicsRules.ts), MAX_PRESETS per account, last write wins
 *
 * The hosts' shop (nodes/control-plane/shop.ts: its catalog and its claim rule, one source with the
 * reference server; nodes/docs/RECOMPENSAS.md: points come only from hosting a community node, are
 * never bought, won or traded). Never pruned:
 *   host_credits     match_id -> the points a verified match on one of the account's nodes earned
 *                    (the NodeRegistryDO's outbox, /host-credit: idempotent by match_id)
 *   host_claims      (user, item) -> what the account owns: a claim (its cost) or a maintainer's
 *                    grant (cost 0); one row per item, so a retried claim spends nothing twice
 *   host_freeze      user -> a failed verification on one of its nodes (/host-freeze): no claims
 *                    while `at` > `cleared_at` (a maintainer's unfreeze); an event from before the
 *                    unfreeze, delivered again by the outbox, freezes nothing
 *   loadout          user -> the car it picked (src/game/cosmetics.ts CarId); it drives it while it
 *                    owns it (the default car is everyone's), else the default car
 * Balance = sum(credits) - sum(claims), never below 0: a claim needs its whole cost, credits never go.
 */
import { PLACEMENT_MATCHES, abandonBanMs, ABANDON_WINDOW_MS, mmrOf, newRating, rateRankedMatch, tierOf } from '../../src/net/rating';
import type { Rating } from '../../src/net/rating';
import { looksLikeDomain, PLAYLISTS, usernameKey } from '../../src/net/account';
import type { LeaderboardAnswer, LeaderboardEntry, MeInfo, OAuthProvider, Playlist, PlaylistRating, RankedResultAnswer } from '../../src/net/account';
import { mergeTrainingRecords, parseTrainingRecords } from '../../src/game/trainingRecords';
import type { TrainingRecords } from '../../src/game/trainingRecords';
import { MAX_PRESETS, parsePresetList } from '../../src/game/physicsRules';
import type { StoredPreset } from '../../src/game/physicsRules';
import type { ExperimentalAnswer } from '../../src/net/account';
import { DEFAULT_CAR, isCarId } from '../../src/game/cosmetics';
import type { CarId } from '../../src/game/cosmetics';
import { CATALOG, catalogItem, catalogView, claimBlock, round2 } from '../../nodes/control-plane/shop';
import type { ClaimState } from '../../nodes/control-plane/shop';
import { entitledCarsOf } from '../../src/net/cosmetics';
import type { ClaimAnswer, ClaimRefusal, ItemsAnswer, ShopAnswer, Wallet } from '../../src/net/cosmetics';

export type SqlValue = ArrayBuffer | string | number | null;
export type Row = Record<string, SqlValue>;

export interface SqlCursorLike<T> {
  toArray(): T[];
}

/** The slice of DurableObjectStorage.sql (and of the node:sqlite test adapter) the store uses. */
export interface SqlLike {
  exec<T extends Row = Row>(query: string, ...bindings: unknown[]): SqlCursorLike<T>;
}

export const SEASON = 1;
/** Sliding lifetime of a refresh token (every refresh pushes it out again). */
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
/** Refresh tokens kept per account (oldest dropped): one per browser / device. */
export const REFRESH_PER_USER = 10;
export const RENAME_EVERY_MS = 30 * 24 * 60 * 60_000;
/** Ranked results / cancellations are kept this long (GET /api/ranked/result, idempotency). */
const RANKED_KEEP_MS = 30 * 24 * 60 * 60_000;
export const LEADERBOARD_MAX = 100;

export interface PasswordRecord {
  hash: string;
  salt: string;
  iter: number;
}

export interface Credentials extends Partial<PasswordRecord> {
  userId: string;
  username: string;
  banned: boolean;
}

export interface UserRef {
  userId: string;
  username: string;
  /** The car the account drives (equippedCar: one it still owns, else the default): what its session carries. */
  car?: CarId;
  /** When the account was created (ms): its age weighs its minutes on a community node (ledger.ts). */
  createdAt?: number;
}

/** POST /host-credit: one verified match on a community node of the account (nodeOutcome.ts). */
export interface HostCredit {
  matchId: string;
  userId: string;
  nodeId: string;
  points: number;
  verified: boolean;
  at: number;
}

export interface RankedPlayerInput {
  id: string;
  team: 0 | 1;
  left: boolean;
}

export interface RankedResultInput {
  matchId: string;
  playlist: Playlist;
  region: string;
  winner: 0 | 1 | -1;
  blue: number;
  red: number;
  players: RankedPlayerInput[];
}

export interface RankedCheck {
  banUntil: number;
  ratings: Record<string, { mu: number; sigma: number; mmr: number; games: number }>;
  active: { matchId: string; region: string } | null;
}

function num(v: SqlValue | undefined): number {
  return typeof v === 'number' ? v : Number(v ?? 0);
}

function str(v: SqlValue | undefined): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

export function randomId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  let s = '';
  for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
  return s;
}

/**
 * An OAuth display name turned into a valid username candidate: ASCII letters / digits / _ . -,
 * diacritics stripped, 3-16 chars (padded with digits when too short). Uniqueness is the caller's.
 */
export function usernameFromDisplay(display: string): string {
  let s = display
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_.-]/g, '')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[_.-]+$/, '');
  s = s.slice(0, 16);
  if (looksLikeDomain(s)) s = s.replace(/\./g, '_'); // a Discord name 'tg-verify.com' never becomes a web-address username
  const k = s.toLowerCase();
  if (k.startsWith('guest') || k.startsWith('bot') || k === 'admin') s = 'P' + s.slice(0, 15);
  while (s.length < 3) s += String(Math.floor(Math.random() * 10));
  return s;
}

export class AccountStore {
  private readonly sql: SqlLike;
  private readonly tx: <T>(fn: () => T) => T;

  constructor(sql: SqlLike, tx: <T>(fn: () => T) => T) {
    this.sql = sql;
    this.tx = tx;
  }

  migrate(): void {
    const s = this.sql;
    s.exec(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL, ukey TEXT NOT NULL UNIQUE,
      pw_hash TEXT, pw_salt TEXT, pw_iter INTEGER,
      recovery TEXT NOT NULL DEFAULT '[]', google_sub TEXT UNIQUE, discord_id TEXT UNIQUE,
      created_at INTEGER NOT NULL, last_login INTEGER NOT NULL DEFAULT 0, renamed_at INTEGER NOT NULL DEFAULT 0,
      banned INTEGER NOT NULL DEFAULT 0)`);
    s.exec(`CREATE TABLE IF NOT EXISTS refresh (
      hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);
    s.exec('CREATE INDEX IF NOT EXISTS refresh_user ON refresh(user_id)');
    s.exec(`CREATE TABLE IF NOT EXISTS ratings (
      user_id TEXT NOT NULL, playlist TEXT NOT NULL, season INTEGER NOT NULL,
      mu REAL NOT NULL, sigma REAL NOT NULL, games INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0,
      peak_mmr INTEGER NOT NULL DEFAULT 0, last_played INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, playlist, season))`);
    s.exec('CREATE INDEX IF NOT EXISTS ratings_board ON ratings(playlist, season, mu)');
    s.exec(`CREATE TABLE IF NOT EXISTS ranked_matches (
      match_id TEXT PRIMARY KEY, playlist TEXT NOT NULL, region TEXT NOT NULL, status TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '', blue INTEGER NOT NULL DEFAULT 0, red INTEGER NOT NULL DEFAULT 0,
      winner INTEGER NOT NULL DEFAULT -1, ended_at INTEGER NOT NULL)`);
    s.exec('CREATE INDEX IF NOT EXISTS ranked_matches_ended ON ranked_matches(ended_at)');
    s.exec(`CREATE TABLE IF NOT EXISTS ranked_players (
      match_id TEXT NOT NULL, user_id TEXT NOT NULL, team INTEGER NOT NULL, left_match INTEGER NOT NULL,
      outcome TEXT NOT NULL, mu_before REAL NOT NULL, sigma_before REAL NOT NULL, mu_after REAL NOT NULL,
      sigma_after REAL NOT NULL, games_after INTEGER NOT NULL, ban_until INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (match_id, user_id))`);
    s.exec('CREATE TABLE IF NOT EXISTS abandons (user_id TEXT NOT NULL, at INTEGER NOT NULL, match_id TEXT NOT NULL)');
    s.exec('CREATE INDEX IF NOT EXISTS abandons_user ON abandons(user_id, at)');
    s.exec('CREATE TABLE IF NOT EXISTS bans (user_id TEXT PRIMARY KEY, until INTEGER NOT NULL)');
    s.exec('CREATE TABLE IF NOT EXISTS ranked_locks (user_id TEXT PRIMARY KEY, match_id TEXT NOT NULL, region TEXT NOT NULL, until INTEGER NOT NULL)');
    s.exec(`CREATE TABLE IF NOT EXISTS training (
      user_id TEXT NOT NULL, pack_id TEXT NOT NULL, best INTEGER NOT NULL, shots INTEGER NOT NULL,
      completed_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, pack_id))`);
    s.exec('CREATE TABLE IF NOT EXISTS experimental (user_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)');
    s.exec(`CREATE TABLE IF NOT EXISTS presets (
      user_id TEXT NOT NULL, preset_id TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, preset_id))`);
    s.exec(`CREATE TABLE IF NOT EXISTS host_credits (
      match_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, node_id TEXT NOT NULL, points REAL NOT NULL,
      verified INTEGER NOT NULL, at INTEGER NOT NULL)`);
    s.exec('CREATE INDEX IF NOT EXISTS host_credits_user ON host_credits(user_id)');
    s.exec(`CREATE TABLE IF NOT EXISTS host_claims (
      user_id TEXT NOT NULL, item_id TEXT NOT NULL, cost REAL NOT NULL, at INTEGER NOT NULL, source TEXT NOT NULL,
      PRIMARY KEY (user_id, item_id))`);
    s.exec('CREATE TABLE IF NOT EXISTS host_freeze (user_id TEXT PRIMARY KEY, reason TEXT NOT NULL, at INTEGER NOT NULL, cleared_at INTEGER NOT NULL DEFAULT 0)');
    s.exec('CREATE TABLE IF NOT EXISTS loadout (user_id TEXT PRIMARY KEY, car TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  }

  // ---- users ------------------------------------------------------------------------------------

  private userByKey(ukey: string): Row | null {
    return this.sql.exec('SELECT * FROM users WHERE ukey = ?', ukey).toArray()[0] ?? null;
  }

  private userById(id: string): Row | null {
    return this.sql.exec('SELECT * FROM users WHERE id = ?', id).toArray()[0] ?? null;
  }

  usernameTaken(username: string): boolean {
    return this.userByKey(usernameKey(username)) !== null;
  }

  private freshId(): string {
    for (;;) {
      const id = randomId();
      if (this.userById(id) === null) return id;
    }
  }

  /** A new password account; 'taken' when the username (case-insensitive) exists. */
  register(username: string, pw: PasswordRecord, recoveryHashes: readonly string[], refreshHash: string, now: number): UserRef | 'taken' {
    return this.tx(() => {
      if (this.usernameTaken(username)) return 'taken' as const;
      const id = this.freshId();
      this.sql.exec(
        'INSERT INTO users (id, username, ukey, pw_hash, pw_salt, pw_iter, recovery, created_at, last_login) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, username, usernameKey(username), pw.hash, pw.salt, pw.iter, JSON.stringify(recoveryHashes), now, now,
      );
      this.addRefresh(id, refreshHash, now);
      return { userId: id, username, car: DEFAULT_CAR, createdAt: now };
    });
  }

  /** What a session of the account carries: its name, the car it drives and its creation time. */
  private refOf(u: Row): UserRef {
    const userId = str(u.id);
    return { userId, username: str(u.username), car: this.equippedCar(userId), createdAt: num(u.created_at) };
  }

  credentials(username: string): Credentials | null {
    const u = this.userByKey(usernameKey(username));
    if (u === null) return null;
    const out: Credentials = { userId: str(u.id), username: str(u.username), banned: num(u.banned) === 1 };
    if (u.pw_hash !== null && u.pw_hash !== undefined) {
      out.hash = str(u.pw_hash);
      out.salt = str(u.pw_salt);
      out.iter = num(u.pw_iter);
    }
    return out;
  }

  credentialsById(userId: string): Credentials | null {
    const u = this.userById(userId);
    return u === null ? null : this.credentials(str(u.username));
  }

  /** A successful sign-in: last_login and a new refresh token. */
  signedIn(userId: string, refreshHash: string, now: number): UserRef | null {
    return this.tx(() => {
      const u = this.userById(userId);
      if (u === null || num(u.banned) === 1) return null;
      this.sql.exec('UPDATE users SET last_login = ? WHERE id = ?', now, userId);
      this.addRefresh(userId, refreshHash, now);
      return this.refOf(u);
    });
  }

  addRefresh(userId: string, hash: string, now: number): void {
    this.sql.exec('INSERT OR REPLACE INTO refresh (hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', hash, userId, now, now + REFRESH_TTL_MS);
    const rows = this.sql.exec<{ hash: string }>('SELECT hash FROM refresh WHERE user_id = ? ORDER BY created_at DESC', userId).toArray();
    for (let i = REFRESH_PER_USER; i < rows.length; i++) this.sql.exec('DELETE FROM refresh WHERE hash = ?', rows[i].hash);
  }

  /** Swap a refresh token for a new one (rotation); null when unknown, expired or the account is banned. */
  rotateRefresh(oldHash: string, newHash: string, now: number): UserRef | null {
    return this.tx(() => {
      const r = this.sql.exec('SELECT user_id, expires_at FROM refresh WHERE hash = ?', oldHash).toArray()[0];
      if (!r) return null;
      this.sql.exec('DELETE FROM refresh WHERE hash = ?', oldHash);
      if (num(r.expires_at) <= now) return null;
      const u = this.userById(str(r.user_id));
      if (u === null || num(u.banned) === 1) return null;
      this.addRefresh(str(u.id), newHash, now);
      return this.refOf(u);
    });
  }

  /** The account behind a refresh token without rotating it (OAuth linking); null when invalid. */
  refreshOwner(hash: string, now: number): UserRef | null {
    const r = this.sql.exec('SELECT user_id, expires_at FROM refresh WHERE hash = ?', hash).toArray()[0];
    if (!r || num(r.expires_at) <= now) return null;
    const u = this.userById(str(r.user_id));
    return u === null ? null : this.refOf(u);
  }

  deleteRefresh(hash: string): void {
    this.sql.exec('DELETE FROM refresh WHERE hash = ?', hash);
  }

  /** Sign out everywhere (password change / recovery), keeping `except` (the caller's own token) when given. */
  deleteRefreshOf(userId: string, except?: string): void {
    if (except) this.sql.exec('DELETE FROM refresh WHERE user_id = ? AND hash != ?', userId, except);
    else this.sql.exec('DELETE FROM refresh WHERE user_id = ?', userId);
  }

  setPassword(userId: string, pw: PasswordRecord): boolean {
    const u = this.userById(userId);
    if (u === null) return false;
    this.sql.exec('UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iter = ? WHERE id = ?', pw.hash, pw.salt, pw.iter, userId);
    return true;
  }

  setRecovery(userId: string, hashes: readonly string[]): void {
    this.sql.exec('UPDATE users SET recovery = ? WHERE id = ?', JSON.stringify(hashes), userId);
  }

  recoveryLeft(userId: string): number {
    const u = this.userById(userId);
    return u === null ? 0 : (JSON.parse(str(u.recovery) || '[]') as string[]).length;
  }

  /**
   * Password reset with a recovery code: the code (its hash) is consumed, the password replaced and
   * every session signed out; a new refresh token for this browser. Null when the user / code do not match.
   */
  recover(username: string, codeHash: string, pw: PasswordRecord, refreshHash: string, now: number): (UserRef & { codesLeft: number }) | null {
    return this.tx(() => {
      const u = this.userByKey(usernameKey(username));
      if (u === null || num(u.banned) === 1) return null;
      const codes = JSON.parse(str(u.recovery) || '[]') as string[];
      const i = codes.indexOf(codeHash);
      if (i < 0) return null;
      codes.splice(i, 1);
      const id = str(u.id);
      this.sql.exec('UPDATE users SET recovery = ?, pw_hash = ?, pw_salt = ?, pw_iter = ?, last_login = ? WHERE id = ?', JSON.stringify(codes), pw.hash, pw.salt, pw.iter, now, id);
      this.deleteRefreshOf(id);
      this.addRefresh(id, refreshHash, now);
      return { ...this.refOf(u), codesLeft: codes.length };
    });
  }

  /**
   * Sign in (or sign up) with an OAuth identity. `linkTo` = the signed-in account that asked to
   * link it (profile screen). A new account takes `suggested` (made unique with a numeric suffix).
   */
  oauth(provider: OAuthProvider, providerId: string, suggested: string, linkTo: string | null, refreshHash: string, now: number): (UserRef & { created: boolean }) | 'already_linked' | 'no_user' {
    const col = provider === 'google' ? 'google_sub' : 'discord_id';
    return this.tx(() => {
      const owner = this.sql.exec(`SELECT id, username, banned, created_at FROM users WHERE ${col} = ?`, providerId).toArray()[0];
      if (linkTo !== null) {
        const me = this.userById(linkTo);
        if (me === null) return 'no_user' as const;
        if (owner && str(owner.id) !== linkTo) return 'already_linked' as const;
        this.sql.exec(`UPDATE users SET ${col} = ? WHERE id = ?`, providerId, linkTo);
        this.addRefresh(linkTo, refreshHash, now);
        return { ...this.refOf(me), created: false };
      }
      if (owner) {
        if (num(owner.banned) === 1) return 'no_user' as const;
        const id = str(owner.id);
        this.sql.exec('UPDATE users SET last_login = ? WHERE id = ?', now, id);
        this.addRefresh(id, refreshHash, now);
        return { ...this.refOf(owner), created: false };
      }
      let name = usernameFromDisplay(suggested);
      for (let n = 0; this.usernameTaken(name); n++) {
        const suffix = String(n < 5 ? Math.floor(Math.random() * 100) : Math.floor(Math.random() * 100000));
        name = name.slice(0, 16 - suffix.length) + suffix;
      }
      const id = this.freshId();
      this.sql.exec(`INSERT INTO users (id, username, ukey, ${col}, created_at, last_login) VALUES (?, ?, ?, ?, ?, ?)`, id, name, usernameKey(name), providerId, now, now);
      this.addRefresh(id, refreshHash, now);
      return { userId: id, username: name, car: DEFAULT_CAR, createdAt: now, created: true };
    });
  }

  /** Change the username (once per RENAME_EVERY_MS; a fresh OAuth account may rename at once). */
  rename(userId: string, username: string, now: number): UserRef | 'taken' | 'too_soon' | 'no_user' {
    return this.tx(() => {
      const u = this.userById(userId);
      if (u === null) return 'no_user' as const;
      if (num(u.renamed_at) + RENAME_EVERY_MS > now) return 'too_soon' as const;
      const other = this.userByKey(usernameKey(username));
      if (other !== null && str(other.id) !== userId) return 'taken' as const;
      this.sql.exec('UPDATE users SET username = ?, ukey = ?, renamed_at = ? WHERE id = ?', username, usernameKey(username), now, userId);
      return { ...this.refOf(u), username };
    });
  }

  // ---- ratings ----------------------------------------------------------------------------------

  rating(userId: string, playlist: Playlist): { rating: Rating; games: number; wins: number; losses: number; peak: number } {
    const r = this.sql.exec('SELECT * FROM ratings WHERE user_id = ? AND playlist = ? AND season = ?', userId, playlist, SEASON).toArray()[0];
    if (!r) return { rating: newRating(), games: 0, wins: 0, losses: 0, peak: 0 };
    return { rating: { mu: num(r.mu), sigma: num(r.sigma) }, games: num(r.games), wins: num(r.wins), losses: num(r.losses), peak: num(r.peak_mmr) };
  }

  playlistView(userId: string, playlist: Playlist): PlaylistRating {
    const r = this.rating(userId, playlist);
    const mmr = mmrOf(r.rating.mu);
    const placementLeft = Math.max(0, PLACEMENT_MATCHES - r.games);
    return { playlist, mmr, tier: placementLeft === 0 ? tierOf(mmr).id : null, games: r.games, wins: r.wins, losses: r.losses, placementLeft, peakMmr: r.peak };
  }

  banUntil(userId: string, now: number): number {
    const b = this.sql.exec('SELECT until FROM bans WHERE user_id = ?', userId).toArray()[0];
    const until = b ? num(b.until) : 0;
    return until > now ? until : 0;
  }

  abandonsInWindow(userId: string, now: number): number {
    const r = this.sql.exec('SELECT COUNT(*) AS n FROM abandons WHERE user_id = ? AND at > ?', userId, now - ABANDON_WINDOW_MS).toArray()[0];
    return r ? num(r.n) : 0;
  }

  me(userId: string, now: number): MeInfo | null {
    const u = this.userById(userId);
    if (u === null) return null;
    const providers: MeInfo['providers'] = [];
    if (u.pw_hash !== null && u.pw_hash !== undefined) providers.push('password');
    if (u.google_sub !== null && u.google_sub !== undefined) providers.push('google');
    if (u.discord_id !== null && u.discord_id !== undefined) providers.push('discord');
    const renamedAt = num(u.renamed_at);
    return {
      playerId: userId,
      name: str(u.username),
      createdAt: num(u.created_at),
      providers,
      hasPassword: providers.includes('password'),
      renameAt: renamedAt === 0 ? 0 : Math.max(0, renamedAt + RENAME_EVERY_MS),
      ratings: PLAYLISTS.map((p) => this.playlistView(userId, p)),
      rankedBanUntil: this.banUntil(userId, now),
      abandons24h: this.abandonsInWindow(userId, now),
      season: SEASON,
      experimental: this.experimentalEnabled(userId),
    };
  }

  /** Before a ranked queue: ban, ratings of the asked playlists, and a live ranked match (one at a time). */
  rankedCheck(userId: string, playlists: readonly Playlist[], now: number): RankedCheck {
    const ratings: RankedCheck['ratings'] = {};
    for (const p of playlists) {
      const r = this.rating(userId, p);
      ratings[p] = { mu: r.rating.mu, sigma: r.rating.sigma, mmr: mmrOf(r.rating.mu), games: r.games };
    }
    const l = this.sql.exec('SELECT match_id, region, until FROM ranked_locks WHERE user_id = ?', userId).toArray()[0];
    let active: RankedCheck['active'] = null;
    if (l && num(l.until) > now) active = { matchId: str(l.match_id), region: str(l.region) };
    else if (l) this.sql.exec('DELETE FROM ranked_locks WHERE user_id = ?', userId);
    return { banUntil: this.banUntil(userId, now), ratings, active };
  }

  rankedLock(matchId: string, region: string, userIds: readonly string[], until: number): void {
    this.tx(() => {
      for (const id of userIds) this.sql.exec('INSERT OR REPLACE INTO ranked_locks (user_id, match_id, region, until) VALUES (?, ?, ?, ?)', id, matchId, region, until);
    });
  }

  private unlock(matchId: string, userIds: readonly string[]): void {
    for (const id of userIds) this.sql.exec('DELETE FROM ranked_locks WHERE user_id = ? AND match_id = ?', id, matchId);
  }

  /** One abandon (quit / no-show / disconnected at the end) -> the escalating queue ban; returns its end. */
  private abandon(userId: string, matchId: string, now: number): number {
    this.sql.exec('INSERT INTO abandons (user_id, at, match_id) VALUES (?, ?, ?)', userId, now, matchId);
    const n = this.abandonsInWindow(userId, now);
    const until = now + abandonBanMs(n);
    const cur = this.banUntil(userId, now);
    if (until > cur) this.sql.exec('INSERT OR REPLACE INTO bans (user_id, until) VALUES (?, ?)', userId, until);
    return Math.max(until, cur);
  }

  /**
   * A finished ranked match (MatchDO): every account is rated (rating.ts rateRankedMatch: leavers
   * lose, their teammates lose half), leavers get an abandon, locks are freed. Idempotent on matchId
   * (false = already recorded). Players without an account row are rated from the defaults.
   */
  applyRankedResult(r: RankedResultInput, now: number): boolean {
    return this.tx(() => {
      if (this.sql.exec('SELECT 1 AS x FROM ranked_matches WHERE match_id = ?', r.matchId).toArray().length > 0) return false;
      const known = r.players.filter((p) => this.userById(p.id) !== null);
      const state = new Map(known.map((p) => [p.id, this.rating(p.id, r.playlist)]));
      const teams = new Set(known.map((p) => p.team));
      this.sql.exec(
        'INSERT INTO ranked_matches (match_id, playlist, region, status, blue, red, winner, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        r.matchId, r.playlist, r.region, 'done', r.blue, r.red, r.winner, now,
      );
      if (teams.size === 2) {
        const rated = rateRankedMatch(known.map((p) => ({ id: p.id, team: p.team, left: p.left, rating: (state.get(p.id) as { rating: Rating }).rating })), r.winner);
        for (const res of rated) {
          const p = known.find((x) => x.id === res.id) as RankedPlayerInput;
          const s = state.get(res.id) as { games: number; wins: number; losses: number; peak: number };
          const games = s.games + 1;
          const wins = s.wins + (res.outcome === 'win' ? 1 : 0);
          const losses = s.losses + (res.outcome === 'loss' ? 1 : 0);
          const mmr = mmrOf(res.after.mu);
          const peak = games >= PLACEMENT_MATCHES ? Math.max(s.peak, mmr) : s.peak;
          this.sql.exec(
            `INSERT INTO ratings (user_id, playlist, season, mu, sigma, games, wins, losses, peak_mmr, last_played) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (user_id, playlist, season) DO UPDATE SET mu = excluded.mu, sigma = excluded.sigma, games = excluded.games,
             wins = excluded.wins, losses = excluded.losses, peak_mmr = excluded.peak_mmr, last_played = excluded.last_played`,
            res.id, r.playlist, SEASON, res.after.mu, res.after.sigma, games, wins, losses, peak, now,
          );
          const banUntil = p.left ? this.abandon(res.id, r.matchId, now) : 0;
          this.sql.exec(
            'INSERT INTO ranked_players (match_id, user_id, team, left_match, outcome, mu_before, sigma_before, mu_after, sigma_after, games_after, ban_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            r.matchId, res.id, p.team, p.left ? 1 : 0, res.outcome, res.before.mu, res.before.sigma, res.after.mu, res.after.sigma, games, banUntil,
          );
        }
      }
      this.unlock(r.matchId, r.players.map((p) => p.id));
      return true;
    });
  }

  /** A ranked match that never started (a player never connected): no rating, the no-shows get an abandon. */
  cancelRanked(matchId: string, playlist: Playlist, region: string, players: readonly string[], noShows: readonly string[], reason: string, now: number): boolean {
    return this.tx(() => {
      if (this.sql.exec('SELECT 1 AS x FROM ranked_matches WHERE match_id = ?', matchId).toArray().length > 0) return false;
      this.sql.exec('INSERT INTO ranked_matches (match_id, playlist, region, status, reason, ended_at) VALUES (?, ?, ?, ?, ?, ?)', matchId, playlist, region, 'cancelled', reason, now);
      for (const id of noShows) if (this.userById(id) !== null) this.abandon(id, matchId, now);
      this.unlock(matchId, players);
      return true;
    });
  }

  rankedResultFor(matchId: string, userId: string, now: number): RankedResultAnswer {
    const m = this.sql.exec('SELECT * FROM ranked_matches WHERE match_id = ?', matchId).toArray()[0];
    if (!m) return { status: 'pending' };
    if (str(m.status) === 'cancelled') return { status: 'cancelled', reason: str(m.reason) };
    const p = this.sql.exec('SELECT * FROM ranked_players WHERE match_id = ? AND user_id = ?', matchId, userId).toArray()[0];
    if (!p) return { status: 'cancelled', reason: 'not_rated' };
    const gamesAfter = num(p.games_after);
    const before = mmrOf(num(p.mu_before));
    const after = mmrOf(num(p.mu_after));
    const placedBefore = gamesAfter - 1 >= PLACEMENT_MATCHES;
    const placedAfter = gamesAfter >= PLACEMENT_MATCHES;
    const ban = num(p.ban_until);
    return {
      status: 'done',
      playlist: str(m.playlist) as Playlist,
      outcome: str(p.outcome) as 'win' | 'loss' | 'draw',
      left: num(p.left_match) === 1,
      mmrBefore: before,
      mmrAfter: after,
      tierBefore: placedBefore ? tierOf(before).id : null,
      tierAfter: placedAfter ? tierOf(after).id : null,
      placementLeft: Math.max(0, PLACEMENT_MATCHES - gamesAfter),
      banUntil: ban > now ? ban : 0,
    };
  }

  leaderboard(playlist: Playlist, limit: number, userId: string | null): LeaderboardAnswer {
    const n = Math.max(1, Math.min(LEADERBOARD_MAX, Math.floor(limit)));
    const rows = this.sql
      .exec(
        `SELECT u.username AS name, r.mu AS mu, r.games AS games, r.wins AS wins FROM ratings r JOIN users u ON u.id = r.user_id
         WHERE r.playlist = ? AND r.season = ? AND r.games >= ? AND u.banned = 0 ORDER BY r.mu DESC LIMIT ?`,
        playlist, SEASON, PLACEMENT_MATCHES, n,
      )
      .toArray();
    const entries: LeaderboardEntry[] = rows.map((r, i) => {
      const mmr = mmrOf(num(r.mu));
      return { rank: i + 1, name: str(r.name), mmr, tier: tierOf(mmr).id, games: num(r.games), wins: num(r.wins) };
    });
    const totalRow = this.sql.exec('SELECT COUNT(*) AS n FROM ratings WHERE playlist = ? AND season = ? AND games >= ?', playlist, SEASON, PLACEMENT_MATCHES).toArray()[0];
    let you: LeaderboardEntry | null = null;
    if (userId !== null) {
      const u = this.userById(userId);
      const r = this.rating(userId, playlist);
      if (u !== null && r.games >= PLACEMENT_MATCHES) {
        const above = this.sql.exec('SELECT COUNT(*) AS n FROM ratings WHERE playlist = ? AND season = ? AND games >= ? AND mu > ?', playlist, SEASON, PLACEMENT_MATCHES, r.rating.mu).toArray()[0];
        const mmr = mmrOf(r.rating.mu);
        you = { rank: num(above?.n) + 1, name: str(u.username), mmr, tier: tierOf(mmr).id, games: r.games, wins: r.wins };
      }
    }
    return { playlist, season: SEASON, entries, you, total: num(totalRow?.n) };
  }

  // ---- training -----------------------------------------------------------------------------------

  /** The account's best run per training pack ({} for an account without any). */
  trainingRecords(userId: string): TrainingRecords {
    const raw: Record<string, unknown> = {};
    for (const r of this.sql.exec('SELECT pack_id, best, shots, completed_at FROM training WHERE user_id = ? ORDER BY pack_id', userId).toArray()) {
      raw[str(r.pack_id)] = { best: num(r.best), shots: num(r.shots), completedAt: num(r.completed_at) };
    }
    return parseTrainingRecords(raw);
  }

  /**
   * Merge `incoming` (already parsed) into the account's records, keeping the better record per
   * pack (mergeTrainingRecords, the client's rule); dates from the future are clamped to `now`.
   * Only changed packs are written. Returns the account's records after the merge, or 'no_user'.
   */
  mergeTraining(userId: string, incoming: TrainingRecords, now: number): TrainingRecords | 'no_user' {
    return this.tx(() => {
      if (this.userById(userId) === null) return 'no_user' as const;
      const clamped: TrainingRecords = {};
      for (const id of Object.keys(incoming)) {
        const r = incoming[id];
        clamped[id] = { best: r.best, shots: r.shots, completedAt: Math.min(now, r.completedAt ?? 0) };
      }
      const current = this.trainingRecords(userId);
      const merged = mergeTrainingRecords(current, clamped);
      for (const id of Object.keys(merged)) {
        const a = current[id];
        const b = merged[id];
        if (a !== undefined && a.best === b.best && a.shots === b.shots && a.completedAt === b.completedAt) continue;
        this.sql.exec('INSERT OR REPLACE INTO training (user_id, pack_id, best, shots, completed_at) VALUES (?, ?, ?, ?, ?)', userId, id, b.best, b.shots, b.completedAt ?? 0);
      }
      return merged;
    });
  }

  // ---- experimental features ----------------------------------------------------------------------

  /** Settings > Experimental's switch (false for an account that never set it). */
  experimentalEnabled(userId: string): boolean {
    const r = this.sql.exec('SELECT enabled FROM experimental WHERE user_id = ?', userId).toArray()[0];
    return r !== undefined && num(r.enabled) === 1;
  }

  /** The account's presets, oldest first (each re-parsed leniently: a stored row of an older schema still reads). */
  presets(userId: string): StoredPreset[] {
    const raw = this.sql
      .exec('SELECT preset_id, name, data, updated_at FROM presets WHERE user_id = ? ORDER BY created_at, preset_id', userId)
      .toArray()
      .map((r) => {
        let values: unknown = {};
        try {
          values = JSON.parse(str(r.data));
        } catch {
          /* a broken row reads as standard values */
        }
        return { id: str(r.preset_id), name: str(r.name), values, updatedAt: num(r.updated_at) };
      });
    return parsePresetList(raw, MAX_PRESETS);
  }

  /** GET /api/me/experimental: the switch and the presets; 'no_user' for an unknown account. */
  experimental(userId: string): ExperimentalAnswer | 'no_user' {
    if (this.userById(userId) === null) return 'no_user';
    return { enabled: this.experimentalEnabled(userId), presets: this.presets(userId) };
  }

  setExperimental(userId: string, on: boolean, now: number): ExperimentalAnswer | 'no_user' {
    return this.tx(() => {
      if (this.userById(userId) === null) return 'no_user' as const;
      this.sql.exec(
        'INSERT INTO experimental (user_id, enabled, updated_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at',
        userId, on ? 1 : 0, now,
      );
      return { enabled: on, presets: this.presets(userId) };
    });
  }

  /**
   * Create or replace one preset (already parsed: parseStoredPreset); the server stamps updatedAt
   * (last write wins). 'too_many' when a new id would make MAX_PRESETS + 1. Returns the presets after it.
   */
  upsertPreset(userId: string, p: StoredPreset, now: number): ExperimentalAnswer | 'too_many' | 'no_user' {
    return this.tx(() => {
      if (this.userById(userId) === null) return 'no_user' as const;
      const exists = this.sql.exec('SELECT 1 AS x FROM presets WHERE user_id = ? AND preset_id = ?', userId, p.id).toArray().length > 0;
      if (!exists) {
        const n = this.sql.exec('SELECT COUNT(*) AS n FROM presets WHERE user_id = ?', userId).toArray()[0];
        if (num(n?.n) >= MAX_PRESETS) return 'too_many' as const;
      }
      this.sql.exec(
        `INSERT INTO presets (user_id, preset_id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, preset_id) DO UPDATE SET name = excluded.name, data = excluded.data, updated_at = excluded.updated_at`,
        userId, p.id, p.name, JSON.stringify(p.values), now, now,
      );
      return { enabled: this.experimentalEnabled(userId), presets: this.presets(userId) };
    });
  }

  /** Delete one preset (an unknown id is fine: the answer is the same list). */
  deletePreset(userId: string, presetId: string): ExperimentalAnswer | 'no_user' {
    return this.tx(() => {
      if (this.userById(userId) === null) return 'no_user' as const;
      this.sql.exec('DELETE FROM presets WHERE user_id = ? AND preset_id = ?', userId, presetId);
      return { enabled: this.experimentalEnabled(userId), presets: this.presets(userId) };
    });
  }

  // ---- cars and the hosts' shop -------------------------------------------------------------------

  /** Item ids the account owns (claimed or granted), sorted. */
  itemIds(userId: string): string[] {
    return this.sql
      .exec('SELECT item_id FROM host_claims WHERE user_id = ? ORDER BY item_id', userId)
      .toArray()
      .map((r) => str(r.item_id));
  }

  ownsItem(userId: string, itemId: string): boolean {
    return this.sql.exec('SELECT 1 AS x FROM host_claims WHERE user_id = ? AND item_id = ?', userId, itemId).toArray().length > 0;
  }

  /** The car the account drives: its pick while it still owns that car (the default car is everyone's), else the default car. */
  equippedCar(userId: string): CarId {
    const r = this.sql.exec('SELECT car FROM loadout WHERE user_id = ?', userId).toArray()[0];
    const car = r ? str(r.car) : '';
    return isCarId(car) && (car === DEFAULT_CAR || this.ownsItem(userId, car)) ? car : DEFAULT_CAR;
  }

  /** POST /equipped (a lobby's start, LobbyDO): the car each of `userIds` drives now; an unknown or banned account is left out. */
  equippedCars(userIds: readonly string[]): Record<string, CarId> {
    const out: Record<string, CarId> = {};
    for (const id of userIds) {
      const u = this.userById(id);
      if (u !== null && num(u.banned) !== 1) out[id] = this.equippedCar(id);
    }
    return out;
  }

  /** GET /api/me/items: the owned item ids, the car driven and every car the account may drive. */
  items(userId: string): ItemsAnswer | 'no_user' {
    if (this.userById(userId) === null) return 'no_user';
    const items = this.itemIds(userId);
    return { items, car: this.equippedCar(userId), cars: entitledCarsOf(items) };
  }

  /**
   * POST /api/me/car: drive `car` from the next session on (the default car, or one the account
   * owns); that session's UserRef. A banned account is 'no_user', as signedIn and refresh refuse it.
   */
  setCar(userId: string, car: CarId, now: number): UserRef | 'not_owned' | 'no_user' {
    return this.tx(() => {
      const u = this.userById(userId);
      if (u === null || num(u.banned) === 1) return 'no_user' as const;
      if (car !== DEFAULT_CAR && !this.ownsItem(userId, car)) return 'not_owned' as const;
      this.sql.exec(
        'INSERT INTO loadout (user_id, car, updated_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET car = excluded.car, updated_at = excluded.updated_at',
        userId, car, now,
      );
      return this.refOf(u);
    });
  }

  /** Why the account's claims are paused (a failed verification not cleared yet), or null. */
  frozen(userId: string): string | null {
    const r = this.sql.exec('SELECT reason, at, cleared_at FROM host_freeze WHERE user_id = ?', userId).toArray()[0];
    return r && num(r.at) > num(r.cleared_at) ? str(r.reason) : null;
  }

  /**
   * Verified matches the account's nodes hosted for someone else (nodes/control-plane/ledger.ts
   * countsAsHosted: verified and worth points): one the operator played alone counts for nothing,
   * not even toward the free badge.
   */
  private verifiedHosted(userId: string): number {
    return num(this.sql.exec('SELECT COUNT(*) AS n FROM host_credits WHERE user_id = ? AND verified = 1 AND points > 0', userId).toArray()[0]?.n);
  }

  /** Points earned hosting (all time), spent on claims, the balance (never below 0) and the freeze. */
  wallet(userId: string): Wallet {
    const earned = round2(num(this.sql.exec('SELECT COALESCE(SUM(points), 0) AS p FROM host_credits WHERE user_id = ?', userId).toArray()[0]?.p));
    const spent = round2(num(this.sql.exec('SELECT COALESCE(SUM(cost), 0) AS c FROM host_claims WHERE user_id = ?', userId).toArray()[0]?.c));
    return { earned, spent, balance: Math.max(0, round2(earned - spent)), frozen: this.frozen(userId) };
  }

  private claimState(userId: string): ClaimState {
    const owned = new Set(this.itemIds(userId));
    return { owns: (id) => owned.has(id), frozen: this.frozen(userId), verifiedMatches: this.verifiedHosted(userId), balance: this.wallet(userId).balance };
  }

  /** GET /api/me/shop: the catalog as the account sees it (shop.ts catalogView) and its wallet. */
  shop(userId: string): ShopAnswer | 'no_user' {
    if (this.userById(userId) === null) return 'no_user';
    return { items: catalogView(CATALOG, this.claimState(userId)), wallet: this.wallet(userId) };
  }

  /**
   * POST /api/me/shop/claim, one transaction: the item is in the catalog and available, the wallet is
   * not frozen and holds its cost (shop.ts claimBlock) -> it is owned and its cost spent. Idempotent
   * per (account, item): an item already owned answers claimed: false and spends nothing.
   */
  claim(userId: string, itemId: string, now: number): ClaimAnswer | Exclude<ClaimRefusal, 'owned'> | 'no_user' {
    return this.tx(() => {
      const u = this.userById(userId);
      if (u === null || num(u.banned) === 1) return 'no_user' as const;
      const it = catalogItem(itemId);
      if (!it) return 'unknown_item' as const;
      const done = (claimed: boolean): ClaimAnswer => ({ item: it.id, claimed, wallet: this.wallet(userId), items: this.itemIds(userId) });
      if (this.ownsItem(userId, it.id)) return done(false);
      const blocked = claimBlock(it, this.claimState(userId));
      if (blocked !== null && blocked !== 'owned') return blocked;
      this.sql.exec("INSERT INTO host_claims (user_id, item_id, cost, at, source) VALUES (?, ?, ?, ?, 'claim')", userId, it.id, it.cost, now);
      return done(true);
    });
  }

  /** POST /host-credit (the outbox of a settled node match): recorded once per match id; false when it already was. */
  hostCredit(c: HostCredit): boolean {
    return this.tx(() => {
      if (this.sql.exec('SELECT 1 AS x FROM host_credits WHERE match_id = ?', c.matchId).toArray().length > 0) return false;
      this.sql.exec('INSERT INTO host_credits (match_id, user_id, node_id, points, verified, at) VALUES (?, ?, ?, ?, ?, ?)', c.matchId, c.userId, c.nodeId, round2(c.points), c.verified ? 1 : 0, c.at);
      return true;
    });
  }

  /**
   * POST /host-freeze (a failed verification on a node of the account, at `at`): claims pause. A
   * freeze in force keeps its first reason; an event from before the last unfreeze (the outbox
   * delivering it again) changes nothing. True when it froze the wallet.
   */
  hostFreeze(userId: string, reason: string, at: number): boolean {
    return this.tx(() => {
      const r = this.sql.exec('SELECT at, cleared_at FROM host_freeze WHERE user_id = ?', userId).toArray()[0];
      if (r && (num(r.at) > num(r.cleared_at) || at <= num(r.cleared_at))) return false;
      this.sql.exec(
        'INSERT INTO host_freeze (user_id, reason, at, cleared_at) VALUES (?, ?, ?, 0) ON CONFLICT (user_id) DO UPDATE SET reason = excluded.reason, at = excluded.at',
        userId, reason, at,
      );
      return true;
    });
  }

  /** POST /host-unfreeze (a maintainer, after the review): claims go on. True when the wallet was frozen. */
  unfreeze(userId: string, now: number): boolean {
    return this.tx(() => {
      const r = this.sql.exec('SELECT at, cleared_at FROM host_freeze WHERE user_id = ?', userId).toArray()[0];
      if (!r || num(r.at) <= num(r.cleared_at)) return false;
      // Cleared from the event on at least: a clock behind the event's must not leave it in force.
      this.sql.exec('UPDATE host_freeze SET cleared_at = ? WHERE user_id = ?', Math.max(now, num(r.at)), userId);
      return true;
    });
  }

  /**
   * POST /host-grant (a maintainer): the account owns `itemId`, whatever its status, for nothing (a
   * test account's car, or what a mistake took). `granted` false when it already owned it.
   */
  grant(userId: string, itemId: string, now: number): { granted: boolean; items: string[] } | 'unknown_item' | 'no_user' {
    return this.tx(() => {
      if (this.userById(userId) === null) return 'no_user' as const;
      if (!catalogItem(itemId)) return 'unknown_item' as const;
      const owned = this.ownsItem(userId, itemId);
      if (!owned) this.sql.exec("INSERT INTO host_claims (user_id, item_id, cost, at, source) VALUES (?, ?, 0, ?, 'grant')", userId, itemId, now);
      return { granted: !owned, items: this.itemIds(userId) };
    });
  }

  /**
   * POST /host-revoke (a maintainer): the account no longer owns `itemId`. A claim's cost goes back
   * to its balance (points are never taken away), and a revoked car it drove gives way to the default.
   */
  revoke(userId: string, itemId: string): { revoked: boolean; refunded: number; items: string[] } {
    return this.tx(() => {
      const r = this.sql.exec('SELECT cost FROM host_claims WHERE user_id = ? AND item_id = ?', userId, itemId).toArray()[0];
      if (r) {
        this.sql.exec('DELETE FROM host_claims WHERE user_id = ? AND item_id = ?', userId, itemId);
        this.sql.exec('DELETE FROM loadout WHERE user_id = ? AND car = ?', userId, itemId);
      }
      return { revoked: r !== undefined, refunded: r ? round2(num(r.cost)) : 0, items: this.itemIds(userId) };
    });
  }

  /** Daily cleanup: expired refresh tokens, locks and bans, old abandons and ranked results (never the hosts' shop). */
  prune(now: number): void {
    this.tx(() => {
      this.sql.exec('DELETE FROM refresh WHERE expires_at <= ?', now);
      this.sql.exec('DELETE FROM ranked_locks WHERE until <= ?', now);
      this.sql.exec('DELETE FROM bans WHERE until <= ?', now);
      this.sql.exec('DELETE FROM abandons WHERE at <= ?', now - ABANDON_WINDOW_MS);
      const old = now - RANKED_KEEP_MS;
      this.sql.exec('DELETE FROM ranked_players WHERE match_id IN (SELECT match_id FROM ranked_matches WHERE ended_at <= ?)', old);
      this.sql.exec('DELETE FROM ranked_matches WHERE ended_at <= ?', old);
    });
  }
}
