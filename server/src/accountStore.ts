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
 *                    and when each was linked (null for a link from before it was kept). A linked id is
 *                    never replaced: linking another one needs the unlink first (unlink refuses the
 *                    last way in), and linking needs a device that proved a credential just before
 *   refresh          sha256(refresh token) -> user, sliding expiry (REFRESH_TTL_MS); its family (one sign-in
 *                    on one device: every token rotated from it), kind ('web' | 'tv': a TV signed in with
 *                    the phone, a limited scope), when that device signed in and last proved a credential
 *                    (auth_at: a re-authentication moves it), the token it was rotated from (prev_hash)
 *                    and where the device signed in (country, city: the device list). A token of a known
 *                    family that is no longer its live one comes back only from a copy: the family is
 *                    revoked (rotate 'reused'), except within REFRESH_RACE_MS of its rotation (two tabs).
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
 *
 * The sign-in work (the design's data model, schema version 2: migrateTo2). Columns added to users:
 * the verified address (email, email_canon: UNIQUE where set, only from a proof of the mailbox or an
 * authoritative provider; email_verified_at, email_proof), a provider's unproved address
 * (email_hint, email_hint_canon, email_hint_from: never mailed, cleared when any account claims that
 * canon), email_locked_until, the password's format (pw_v 0 none, 1 the legacy key salted with the
 * username, 2 the current key; pw_kid, the server pepper), lang and tz for mail, dev_sub, the
 * deletion (delete_requested_at, delete_purge_at) and unsub_id; to refresh: auth_lvl and method.
 * New tables (only hashes or HMACs of secrets and of throttle keys; an address only while its token
 * lives, or its undo):
 *   mail_tokens      one mailed proof (a link and maybe a code), by its token's hash
 *   email_holds      an old canon held during an email change's 7-day undo (counts as taken)
 *   consents         append-only: the state is the newest row per (user, kind)
 *   auth_throttle    durable failure counters; mail_rate, mail_day: the mail caps and the day's lanes
 *   deleted_ids      ids of purged accounts: freshId never hands one out again (nodes are keyed by it)
 *   sanction_marks   a ban or abandon penalty that outlives a purge; protected_skel: names to protect
 *   meta             schema_version (absent = 1), legacy_seen
 */
import { PLACEMENT_MATCHES, abandonBanMs, ABANDON_WINDOW_MS, mmrOf, newRating, rateRankedMatch, tierOf } from '../../src/net/rating';
import type { Rating } from '../../src/net/rating';
import { emailCanon, looksLikeDomain, nameSkeleton, normalizeEmail, PLAYLISTS, USERNAME_MAX, usernameIssue, usernameKey } from '../../src/net/account';
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
import type { MailLane, MailWindow } from './mailCaps';
import type { MailData, MailLang, WayIn } from './mailTemplates';

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
/** A TV's tokens, counted apart: approving TVs never signs a browser out. */
export const TV_REFRESH_PER_USER = 5;
/** A TV's sign-in lasts this long from its start, refreshed or not (no sliding). */
export const TV_FAMILY_MAX_MS = 30 * 24 * 60 * 60_000;
/** A rotated token presented again this soon after its rotation is two tabs racing, not a copy. */
export const REFRESH_RACE_MS = 30_000;
export const RENAME_EVERY_MS = 30 * 24 * 60 * 60_000;
/** Ranked results / cancellations are kept this long (GET /api/ranked/result, idempotency). */
const RANKED_KEEP_MS = 30 * 24 * 60 * 60_000;
export const LEADERBOARD_MAX = 100;
/** meta.schema_version this build migrates to (migrateTo2); absent = 1, main before the sign-in work. */
export const SCHEMA_VERSION = 2;
/** users.pw_v of a password hashed from the legacy client key (account.ts legacyPasswordKey, salted with the username). */
export const PW_V_LEGACY = 1;
/** users.pw_v of a password hashed from the current client key (account.ts passwordKey: one fixed salt, no username). */
export const PW_V_CURRENT = 2;
const DAY_MS = 24 * 60 * 60_000;
/** The daily prune keeps a used or expired mail token this long past its expiry. */
export const MAIL_TOKEN_KEEP_MS = DAY_MS;
/** A throttle row outside its window (the longest is a day) and not locked goes at the daily prune. */
export const THROTTLE_KEEP_MS = DAY_MS;
/** A mail_rate row whose hour and day windows both started this long ago goes (both are over). */
export const MAIL_RATE_KEEP_MS = DAY_MS;
/** mail_day rows (one per UTC day and lane) are kept this many days. */
export const MAIL_DAY_KEEP_DAYS = 30;
/** How many of each playlist's leaderboard a new name may not imitate (protected_skel, section 5.2). */
export const PROTECTED_TOP = 50;

/** How an account's address was proved (users.email_proof): a code or link of ours, Google as authoritative, or the dev sign-in. */
export type EmailProof = 'mail' | 'google' | 'dev';

/** What a mailed proof is for (mail_tokens.purpose, section 1.6). */
export type MailPurpose = 'signup' | 'add_email' | 'change_email' | 'reset' | 'undo_email' | 'cancel_delete' | 'reauth';
/** Wrong codes an attempt takes: the last one is code_expired (section 1.6). */
export const CODE_TRIES = 5;
/** A finish that comes back this soon after the one that made the account answers already_created (section 2.2). */
export const ALREADY_CREATED_MS = 10 * 60_000;
/** consents.version of the news opt-in (section 3.14). */
export const NEWS_CONSENT_VERSION = 'news-v1';

/** A mail_tokens row (section 1.3): hashes only, and the address while the row lives. */
export interface MailTokenRow {
  hash: string;
  nonce: string;
  purpose: MailPurpose;
  userId: string | null;
  email: string;
  canon: string;
  attemptHash: string | null;
  codeHash: string | null;
  codeExpiresAt: number;
  codeTries: number;
  resends: number;
  /** { lang?, sentAt? }: '{}' once used. */
  payload: { lang?: string; sentAt?: number; [k: string]: unknown };
  createdAt: number;
  expiresAt: number;
  usedAt: number;
  usedBy: string | null;
}

/** A row to store (addMailToken). */
export interface NewMailToken {
  hash: string;
  nonce: string;
  purpose: MailPurpose;
  userId: string | null;
  email: string;
  canon: string;
  attemptHash: string | null;
  codeHash: string | null;
  codeExpiresAt: number;
  payload: { lang?: string };
  expiresAt: number;
}

/** What a mail to or about an account needs (mailTemplates.ts {name}, {methods}, the language and the zone). */
export interface MailProfile {
  userId: string;
  name: string;
  /** The verified address, where its mail goes; null: none. */
  email: string | null;
  canon: string | null;
  lang: string;
  tz: string;
  hasPassword: boolean;
  pwV: number;
  ways: WayIn[];
  banned: boolean;
}

/**
 * A mail the AccountsDO asks the Worker to send once it has answered (R7: in waitUntil): one
 * recipient, its language and zone, and what the template needs (mailTemplates.ts renders it with
 * the request's link origin, mail.ts sends it). It never reaches a client.
 */
export interface MailOrder {
  to: string;
  lang: MailLang;
  tz?: string;
  data: MailData;
}

function mailTokenOf(r: Row): MailTokenRow {
  let payload: MailTokenRow['payload'] = {};
  try {
    const p = JSON.parse(str(r.payload) || '{}') as unknown;
    if (p && typeof p === 'object' && !Array.isArray(p)) payload = p as MailTokenRow['payload'];
  } catch {
    /* a broken payload reads as none */
  }
  const opt = (v: SqlValue | undefined): string | null => (v === null || v === undefined ? null : str(v));
  return {
    hash: str(r.hash),
    nonce: str(r.nonce),
    purpose: str(r.purpose) as MailPurpose,
    userId: opt(r.user_id),
    email: str(r.email),
    canon: str(r.email_canon),
    attemptHash: opt(r.attempt_hash),
    codeHash: opt(r.code_hash),
    codeExpiresAt: num(r.code_expires_at),
    codeTries: num(r.code_tries),
    resends: num(r.resends),
    payload,
    createdAt: num(r.created_at),
    expiresAt: num(r.expires_at),
    usedAt: num(r.used_at),
    usedBy: opt(r.used_by),
  };
}

/** Two hex hashes are equal, in a time that does not depend on where they differ. */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export interface PasswordRecord {
  hash: string;
  salt: string;
  iter: number;
  /** Which client key it hashes (users.pw_v): 1 the legacy one (absent: 1, a record from before), 2 the current one. */
  v?: 1 | 2;
  /** The pepper of the server stage (users.pw_kid): '' none (absent: ''), 'p1' the first PASSWORD_PEPPER. */
  kid?: string;
}

export interface Credentials extends Partial<PasswordRecord> {
  userId: string;
  username: string;
  banned: boolean;
  /** users.pw_v: 0 no password, 1 the legacy key, 2 the current key. */
  pwV: number;
  /** The account has a verified address: it signs in by email, never by the legacy username path. */
  emailVerified: boolean;
}

/** A family's primary method (refresh.method): how its device signed in. '' for a row from before it was kept. */
export type SignInMethod = 'password' | 'legacy' | 'google' | 'discord' | 'tv' | 'dev' | 'reset' | '';

/**
 * A credential event (the sign-in design's R6): its level, which the session signs as `aal`, and
 * the method. 2 a typed password or a recovery; 1 a press on the provider's own page; 0 nothing
 * proved (a TV, a silent provider sign-in). A refresh keeps the family's level and never raises it.
 */
export interface SignInProof {
  lvl: 0 | 1 | 2;
  method: SignInMethod;
}

const NO_PROOF: SignInProof = { lvl: 0, method: '' };

/** A level as stored (refresh.auth_lvl): 0, 1 or 2, anything else 0. */
function levelOf(v: SqlValue | undefined): 0 | 1 | 2 {
  const n = num(v);
  return n === 1 || n === 2 ? n : 0;
}

/** A failure counter's row (auth_throttle): its count in the window that started at `first`, locked until `lockedUntil`. */
export interface ThrottleEntry {
  count: number;
  first: number;
  lockedUntil: number;
}

/** What kind of device a refresh family signs in: a browser, or a TV signed in with the phone (a limited scope). */
export type SessionKind = 'web' | 'tv';

/**
 * A refresh token to store: its hash, its family (accountRoutes.ts familyOf: from the token's
 * family part; absent = a family of its own, as before families), its kind and where the device
 * signed in (request.cf, coarse).
 */
export interface RefreshGrant {
  hash: string;
  family?: string | null;
  kind?: SessionKind;
  country?: string | null;
  city?: string | null;
}

/** One signed-in device of an account (GET /api/auth/sessions). */
export interface DeviceRow {
  id: string;
  kind: SessionKind;
  signedInAt: number;
  lastUsedAt: number;
  country: string | null;
  city: string | null;
  current: boolean;
}

export interface UserRef {
  userId: string;
  username: string;
  /** The session is a TV's (refresh kind 'tv'): its token carries the limited scope. */
  tv?: boolean;
  /** When the device last proved a credential (ms); absent or 0 = never (a TV, a token from before families). */
  authAt?: number;
  /** That proof's level (refresh.auth_lvl, SignInProof): absent or 0 = nothing proved. */
  authLvl?: 0 | 1 | 2;
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

/** An account counts as active when it signed in, renewed a session or played a rated match this recently. */
export const STATS_ACTIVE_MS = 30 * 24 * 60 * 60_000;

/**
 * GET /nodes/admin/account-stats (AccountStore.accountStats): what the owner needs before choosing
 * the cutoff for passwords without an email. Counts and booleans only: never an id, a name or an address.
 */
export interface AccountStats {
  /** Every account, suspended ones included, and how many of them are suspended. */
  total: number;
  banned: number;
  /** By their ways in: 'password', 'google', 'discord' joined with '+' ('password+google'), 'none'. Every combination is listed. */
  byWays: Record<string, number>;
  /** By the password's format (users.pw_v): '0' none, '1' the legacy key salted with the username, '2' the current key. */
  byPwV: Record<string, number>;
  /** With a verified address, and with a provider's unproved address (a hint). */
  verifiedEmail: number;
  emailHint: number;
  /** Signed in, renewed a session or played a rated match in the last 30 days (STATS_ACTIVE_MS). */
  active30d: number;
  /**
   * A password and nothing else: no Google, no Discord, no verified address. What the cutoff would
   * leave without a way in, and what such accounts hold: rated games, host points, items, nodes
   * (null when the node settings are absent or the registry did not answer) and any of them
   * (withAny: without the nodes when they are unknown).
   */
  passwordOnly: { total: number; active30d: number; emailHint: number; rated: number; hostPoints: number; items: number; nodes: number | null; withAny: number };
  /** Accounts that operate a registered community node (null as for nodes). */
  operators: number | null;
  /** Each NODE_TRUSTED_OPERATORS account, in that list's order: booleans only. */
  trusted: Array<{ found: boolean; password: boolean; verifiedEmail: boolean; google: boolean; discord: boolean }>;
}

export interface RankedCheck {
  banUntil: number;
  ratings: Record<string, { mu: number; sigma: number; mmr: number; games: number }>;
  active: { matchId: string; region: string } | null;
}

/** ALTER TABLE ADD COLUMN once: SQLite has no IF NOT EXISTS for a column, so a later run's "duplicate column" is the done case. */
function addColumn(s: SqlLike, table: string, def: string): void {
  try {
    s.exec(`ALTER TABLE ${table} ADD COLUMN ${def}`);
  } catch (e) {
    if (!/duplicate column/i.test(String((e as Error)?.message ?? e))) throw e;
  }
}

/** A device's id in the list: its family, or for a token from before families its own hash's first half (never the token). */
function deviceId(r: Row): string {
  return r.family !== null && r.family !== undefined ? str(r.family) : str(r.hash).slice(0, 32);
}

/** AccountStats.byWays' key of a combination of ways in (1 = has it): 'password+google', 'discord', 'none'. */
function waysKey(password: number, google: number, discord: number): string {
  return [password === 1 ? 'password' : '', google === 1 ? 'google' : '', discord === 1 ? 'discord' : ''].filter((w) => w !== '').join('+') || 'none';
}

function num(v: SqlValue | undefined): number {
  return typeof v === 'number' ? v : Number(v ?? 0);
}

function str(v: SqlValue | undefined): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/** users.pw_v of a record to store: 2 only when it says so (a record from before the field is the legacy key). */
function pwVOf(pw: PasswordRecord): 1 | 2 {
  return pw.v === PW_V_CURRENT ? PW_V_CURRENT : PW_V_LEGACY;
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
    // Families (Security 3): columns added to the table of before; a row from before has none (a family of its own).
    for (const col of ['family TEXT', "kind TEXT NOT NULL DEFAULT 'web'", 'auth_at INTEGER NOT NULL DEFAULT 0', 'family_at INTEGER NOT NULL DEFAULT 0', 'prev_hash TEXT', 'country TEXT', 'city TEXT']) addColumn(s, 'refresh', col);
    s.exec('CREATE INDEX IF NOT EXISTS refresh_family ON refresh(family)');
    for (const col of ['google_linked_at INTEGER', 'discord_linked_at INTEGER']) addColumn(s, 'users', col);
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
    this.migrateTo2();
  }

  /** meta.schema_version: 1 when absent (a database from before the sign-in work, or a new one). */
  schemaVersion(): number {
    const r = this.sql.exec("SELECT v FROM meta WHERE k = 'schema_version'").toArray()[0];
    const v = r ? Number(str(r.v)) : 1;
    return Number.isInteger(v) && v >= 1 ? v : 1;
  }

  /**
   * Version 2 (the sign-in design's data model), on production's live accounts: additive only. It
   * adds columns with defaults and new tables and indexes, never drops, renames or rewrites a
   * column, and runs in the AccountsDO's blockConcurrencyWhile, so no request sees it half done. The
   * once-only part is one transaction: the columns, the tables, pw_v = 1 for every password of
   * before (all of them are the legacy key) and schema_version 2 go together, or none does and the
   * next start does it all again. Later starts only repair pw_v: a build from before it (a
   * rollback) writes a password with pw_v 0, which always means a legacy key.
   */
  private migrateTo2(): void {
    const s = this.sql;
    s.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    if (this.schemaVersion() >= 2) {
      s.exec('UPDATE users SET pw_v = ? WHERE pw_hash IS NOT NULL AND pw_v = 0', PW_V_LEGACY);
      return;
    }
    this.tx(() => {
      for (const col of [
        'email TEXT',
        'email_canon TEXT',
        'email_verified_at INTEGER NOT NULL DEFAULT 0',
        "email_proof TEXT NOT NULL DEFAULT ''",
        'email_hint TEXT',
        'email_hint_canon TEXT',
        "email_hint_from TEXT NOT NULL DEFAULT ''",
        'email_locked_until INTEGER NOT NULL DEFAULT 0',
        'pw_v INTEGER NOT NULL DEFAULT 0',
        "pw_kid TEXT NOT NULL DEFAULT ''",
        "lang TEXT NOT NULL DEFAULT ''",
        "tz TEXT NOT NULL DEFAULT ''",
        'dev_sub TEXT',
        'delete_requested_at INTEGER NOT NULL DEFAULT 0',
        'delete_purge_at INTEGER NOT NULL DEFAULT 0',
        'unsub_id TEXT',
      ]) addColumn(s, 'users', col);
      for (const col of ['auth_lvl INTEGER NOT NULL DEFAULT 0', "method TEXT NOT NULL DEFAULT ''"]) addColumn(s, 'refresh', col);
      // SQLite cannot add UNIQUE with ADD COLUMN: partial indexes do it (every value is NULL here).
      s.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_email_canon ON users(email_canon) WHERE email_canon IS NOT NULL');
      s.exec('CREATE INDEX IF NOT EXISTS users_email_hint ON users(email_hint_canon) WHERE email_hint_canon IS NOT NULL');
      s.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_dev_sub ON users(dev_sub) WHERE dev_sub IS NOT NULL');
      s.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_unsub ON users(unsub_id) WHERE unsub_id IS NOT NULL');
      s.exec('CREATE INDEX IF NOT EXISTS users_purge ON users(delete_purge_at) WHERE delete_purge_at > 0');
      s.exec(`CREATE TABLE IF NOT EXISTS mail_tokens (
        hash TEXT PRIMARY KEY, nonce TEXT NOT NULL, purpose TEXT NOT NULL, user_id TEXT,
        email TEXT NOT NULL, email_canon TEXT NOT NULL, attempt_hash TEXT, code_hash TEXT,
        code_expires_at INTEGER NOT NULL DEFAULT 0, code_tries INTEGER NOT NULL DEFAULT 0, resends INTEGER NOT NULL DEFAULT 0,
        payload TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        used_at INTEGER NOT NULL DEFAULT 0, used_by TEXT)`);
      s.exec('CREATE INDEX IF NOT EXISTS mail_tokens_user ON mail_tokens(user_id, purpose)');
      s.exec('CREATE INDEX IF NOT EXISTS mail_tokens_canon ON mail_tokens(email_canon, purpose)');
      s.exec('CREATE INDEX IF NOT EXISTS mail_tokens_attempt ON mail_tokens(attempt_hash)');
      s.exec('CREATE INDEX IF NOT EXISTS mail_tokens_exp ON mail_tokens(expires_at)');
      s.exec('CREATE TABLE IF NOT EXISTS email_holds (canon TEXT PRIMARY KEY, user_id TEXT NOT NULL, email TEXT NOT NULL, until INTEGER NOT NULL)');
      s.exec(`CREATE TABLE IF NOT EXISTS consents (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, kind TEXT NOT NULL, version TEXT NOT NULL,
        granted INTEGER NOT NULL, source TEXT NOT NULL, at INTEGER NOT NULL)`);
      s.exec('CREATE INDEX IF NOT EXISTS consents_user ON consents(user_id, kind, id)');
      s.exec('CREATE TABLE IF NOT EXISTS auth_throttle (key TEXT PRIMARY KEY, count INTEGER NOT NULL, first_at INTEGER NOT NULL, locked_until INTEGER NOT NULL DEFAULT 0)');
      s.exec('CREATE TABLE IF NOT EXISTS mail_rate (key TEXT PRIMARY KEY, hour_at INTEGER NOT NULL, hour_n INTEGER NOT NULL, day_at INTEGER NOT NULL, day_n INTEGER NOT NULL)');
      s.exec(`CREATE TABLE IF NOT EXISTS mail_day (
        day TEXT NOT NULL, lane TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
        paused_until INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, lane))`);
      s.exec('CREATE TABLE IF NOT EXISTS deleted_ids (id TEXT PRIMARY KEY, at INTEGER NOT NULL)');
      s.exec(`CREATE TABLE IF NOT EXISTS sanction_marks (
        key TEXT PRIMARY KEY, until INTEGER NOT NULL, ban_until INTEGER NOT NULL DEFAULT 0,
        lock_until INTEGER NOT NULL DEFAULT 0, abandons INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL)`);
      s.exec('CREATE TABLE IF NOT EXISTS protected_skel (skel TEXT PRIMARY KEY, user_id TEXT NOT NULL, why TEXT NOT NULL)');
      s.exec('UPDATE users SET pw_v = ? WHERE pw_hash IS NOT NULL', PW_V_LEGACY);
      s.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('schema_version', ?)", String(SCHEMA_VERSION));
    });
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

  /** A new account id: never one in use, nor one of a purged account (deleted_ids: nodes and their points are keyed by it). */
  private freshId(): string {
    for (;;) {
      const id = randomId();
      if (this.userById(id) === null && this.sql.exec('SELECT 1 AS x FROM deleted_ids WHERE id = ?', id).toArray().length === 0) return id;
    }
  }

  /** A new password account; 'taken' when the username (case-insensitive) exists. */
  register(username: string, pw: PasswordRecord, recoveryHashes: readonly string[], refreshHash: string | RefreshGrant, now: number): UserRef | 'taken' {
    return this.tx(() => {
      if (this.usernameTaken(username)) return 'taken' as const;
      const id = this.freshId();
      this.sql.exec(
        'INSERT INTO users (id, username, ukey, pw_hash, pw_salt, pw_iter, pw_v, pw_kid, recovery, created_at, last_login) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, username, usernameKey(username), pw.hash, pw.salt, pw.iter, pwVOf(pw), pw.kid ?? '', JSON.stringify(recoveryHashes), now, now,
      );
      // The password was just typed: the sign-up's device is at level 2.
      this.addRefresh(id, refreshHash, now, now, now, null, { lvl: 2, method: 'legacy' });
      return { userId: id, username, car: DEFAULT_CAR, createdAt: now, authAt: now, authLvl: 2 };
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
    const hasPw = u.pw_hash !== null && u.pw_hash !== undefined;
    // A hash with pw_v 0 comes only from a build before the column (a rollback): the legacy key (migrateTo2).
    const pwV = hasPw ? (num(u.pw_v) === PW_V_CURRENT ? PW_V_CURRENT : PW_V_LEGACY) : 0;
    const out: Credentials = { userId: str(u.id), username: str(u.username), banned: num(u.banned) === 1, pwV, emailVerified: u.email_canon !== null && u.email_canon !== undefined };
    if (hasPw) {
      out.hash = str(u.pw_hash);
      out.salt = str(u.pw_salt);
      out.iter = num(u.pw_iter);
      out.v = pwV === PW_V_CURRENT ? 2 : 1;
      out.kid = str(u.pw_kid);
    }
    return out;
  }

  /** The credentials of the account whose verified address has `canon` (the email sign-in), or null. */
  credentialsByCanon(canon: string): Credentials | null {
    const u = this.sql.exec('SELECT username FROM users WHERE email_canon = ?', canon).toArray()[0];
    return u ? this.credentials(str(u.username)) : null;
  }

  credentialsById(userId: string): Credentials | null {
    const u = this.userById(userId);
    return u === null ? null : this.credentials(str(u.username));
  }

  /**
   * A successful sign-in: last_login and a new refresh token at the level and method of `proof`
   * (`kind` 'tv': a TV the phone approved, which proved no credential: level 0, method 'tv').
   * `rekey`: the password the sign-in proved, stored again in the same transaction (a legacy key
   * re-keyed to the current one, or a record re-hashed with the current pepper).
   */
  signedIn(userId: string, refreshHash: string | RefreshGrant, now: number, proof: SignInProof = NO_PROOF, rekey: PasswordRecord | null = null): UserRef | null {
    return this.tx(() => {
      const u = this.userById(userId);
      if (u === null || num(u.banned) === 1) return null;
      this.sql.exec('UPDATE users SET last_login = ? WHERE id = ?', now, userId);
      if (rekey !== null) this.setPassword(userId, rekey);
      const tv = typeof refreshHash !== 'string' && refreshHash.kind === 'tv';
      const p: SignInProof = tv ? { lvl: 0, method: 'tv' } : proof;
      this.addRefresh(userId, refreshHash, now, tv ? 0 : now, now, null, p);
      return { ...this.refOf(u), ...(tv ? { tv: true } : { authAt: now, authLvl: p.lvl }) };
    });
  }

  /**
   * Store a refresh token. `authAt`: when the device proved a credential (a sign-in: now; a TV:
   * never), and `proof` that proof's level and the family's method; `familyAt` and `prevHash`: a
   * rotation's (the family's start, the token it replaced). Past REFRESH_PER_USER browsers
   * (TV_REFRESH_PER_USER TVs) the oldest of that kind goes.
   */
  addRefresh(userId: string, grant: string | RefreshGrant, now: number, authAt: number = now, familyAt: number = now, prevHash: string | null = null, proof: SignInProof = NO_PROOF): void {
    const g: RefreshGrant = typeof grant === 'string' ? { hash: grant } : grant;
    const kind: SessionKind = g.kind === 'tv' ? 'tv' : 'web';
    const expires = kind === 'tv' ? Math.min(now + REFRESH_TTL_MS, familyAt + TV_FAMILY_MAX_MS) : now + REFRESH_TTL_MS;
    this.sql.exec(
      'INSERT OR REPLACE INTO refresh (hash, user_id, created_at, expires_at, family, kind, auth_at, family_at, prev_hash, country, city, auth_lvl, method) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      g.hash, userId, now, expires, g.family ?? null, kind, kind === 'tv' ? 0 : authAt, familyAt, prevHash, g.country ?? null, g.city ?? null, kind === 'tv' ? 0 : proof.lvl, kind === 'tv' ? 'tv' : proof.method,
    );
    const rows = this.sql.exec<{ hash: string }>('SELECT hash FROM refresh WHERE user_id = ? AND kind = ? ORDER BY created_at DESC', userId, kind).toArray();
    for (let i = kind === 'tv' ? TV_REFRESH_PER_USER : REFRESH_PER_USER; i < rows.length; i++) this.sql.exec('DELETE FROM refresh WHERE hash = ?', rows[i].hash);
  }

  /** Swap a refresh token for a new one (rotation); null when unknown, expired, reused or the account is banned. */
  rotateRefresh(oldHash: string, next: string | RefreshGrant, now: number): UserRef | null {
    const r = this.rotate(oldHash, null, next, now);
    return typeof r === 'string' ? null : r;
  }

  /**
   * A rotation with reuse detection: the token's row goes and `next` takes its place in the same
   * family (its kind, sign-in time, credential proof and place kept). `oldFamily`: the family the
   * presented token names (accountRoutes.ts familyOf). A token that is not a live one, of a family
   * that has a live token, was copied (a thief's, or the owner's after a thief rotated it): the
   * whole family is revoked ('reused'), unless the live token was rotated from this very one less
   * than REFRESH_RACE_MS ago ('race': two tabs of one browser; its cookie already holds the new
   * one). 'unknown': no such token or family, expired, or a banned account.
   */
  rotate(oldHash: string, oldFamily: string | null, next: string | RefreshGrant, now: number): UserRef | 'unknown' | 'race' | 'reused' {
    return this.tx(() => {
      const r = this.sql.exec('SELECT * FROM refresh WHERE hash = ?', oldHash).toArray()[0];
      if (!r) {
        if (oldFamily === null) return 'unknown' as const;
        const live = this.sql.exec('SELECT prev_hash, created_at FROM refresh WHERE family = ?', oldFamily).toArray();
        if (live.length === 0) return 'unknown' as const;
        if (live.some((x) => str(x.prev_hash) === oldHash && now - num(x.created_at) < REFRESH_RACE_MS)) return 'race' as const;
        this.sql.exec('DELETE FROM refresh WHERE family = ?', oldFamily);
        return 'reused' as const;
      }
      this.sql.exec('DELETE FROM refresh WHERE hash = ?', oldHash);
      if (num(r.expires_at) <= now) return 'unknown' as const;
      const u = this.userById(str(r.user_id));
      if (u === null || num(u.banned) === 1) return 'unknown' as const;
      const g: RefreshGrant = typeof next === 'string' ? { hash: next } : next;
      const had = r.family !== null && r.family !== undefined;
      // A family's token always rotates into the same family (the Worker keeps its family part).
      if (had && g.family !== undefined && g.family !== null && g.family !== str(r.family)) return 'unknown' as const;
      const family = had ? str(r.family) : (g.family ?? null);
      const kind: SessionKind = str(r.kind) === 'tv' ? 'tv' : 'web';
      const familyAt = num(r.family_at) > 0 ? num(r.family_at) : num(r.created_at);
      const authAt = num(r.auth_at);
      // The proof's level and the method go with it: a refresh never raises a level (a row from before levels: 0).
      const proof: SignInProof = { lvl: authAt > 0 ? levelOf(r.auth_lvl) : 0, method: str(r.method) as SignInMethod };
      const where = { country: r.country === null || r.country === undefined ? null : str(r.country), city: r.city === null || r.city === undefined ? null : str(r.city) };
      this.addRefresh(str(u.id), { hash: g.hash, family, kind, ...where }, now, authAt, familyAt, oldHash, proof);
      return { ...this.refOf(u), ...(kind === 'tv' ? { tv: true } : authAt > 0 ? { authAt, authLvl: proof.lvl } : {}) };
    });
  }

  /** The account behind a refresh token without rotating it, the device's kind, id and credential proof; null when invalid or banned. */
  refreshOwner(hash: string, now: number): (UserRef & { kind: SessionKind; device: string }) | null {
    const r = this.sql.exec('SELECT * FROM refresh WHERE hash = ?', hash).toArray()[0];
    if (!r || num(r.expires_at) <= now) return null;
    const u = this.userById(str(r.user_id));
    if (u === null || num(u.banned) === 1) return null;
    const kind: SessionKind = str(r.kind) === 'tv' ? 'tv' : 'web';
    return { ...this.refOf(u), kind, device: deviceId(r), ...(kind === 'tv' ? { tv: true } : { authAt: num(r.auth_at), authLvl: num(r.auth_at) > 0 ? levelOf(r.auth_lvl) : 0 }) };
  }

  /**
   * Sign this device out: its token and every other one of its family. `family`: the family the
   * presented token names (accountRoutes.ts familyOf), revoked even when that token is no longer
   * the live one: a copy rotated by someone else first (the thief's newer chain) goes too.
   */
  deleteRefresh(hash: string, family: string | null = null): void {
    const r = this.sql.exec('SELECT family FROM refresh WHERE hash = ?', hash).toArray()[0];
    this.sql.exec('DELETE FROM refresh WHERE hash = ?', hash);
    if (r && r.family !== null && r.family !== undefined) this.sql.exec('DELETE FROM refresh WHERE family = ?', str(r.family));
    if (family !== null) this.sql.exec('DELETE FROM refresh WHERE family = ?', family);
  }

  /** The account's signed-in devices (one per family), the latest used first; `currentHash`: the caller's token, marked current. */
  devices(userId: string, now: number, currentHash: string | null): DeviceRow[] {
    const rows = this.sql.exec('SELECT * FROM refresh WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC', userId, now).toArray();
    const out = new Map<string, DeviceRow>();
    for (const r of rows) {
      const id = deviceId(r);
      const known = out.get(id);
      if (known !== undefined) {
        if (str(r.hash) === currentHash) known.current = true;
        continue;
      }
      out.set(id, {
        id,
        kind: str(r.kind) === 'tv' ? 'tv' : 'web',
        signedInAt: num(r.family_at) > 0 ? num(r.family_at) : num(r.created_at),
        lastUsedAt: num(r.created_at),
        country: r.country === null || r.country === undefined ? null : str(r.country),
        city: r.city === null || r.city === undefined ? null : str(r.city),
        current: currentHash !== null && str(r.hash) === currentHash,
      });
    }
    return [...out.values()];
  }

  /** Sign out the device `id` (devices) of the account; how many tokens went. */
  revokeDevice(userId: string, id: string): number {
    return this.tx(() => {
      const rows = this.sql.exec('SELECT hash, family FROM refresh WHERE user_id = ?', userId).toArray().filter((r) => deviceId(r) === id);
      for (const r of rows) this.sql.exec('DELETE FROM refresh WHERE hash = ?', str(r.hash));
      return rows.length;
    });
  }

  /** Sign out everywhere (PERFIL's every device, a password change, a recovery), keeping `except` (the caller's own token) when given; how many went. */
  deleteRefreshOf(userId: string, except?: string): number {
    const n = except
      ? this.sql.exec('SELECT COUNT(*) AS n FROM refresh WHERE user_id = ? AND hash != ?', userId, except).toArray()[0]
      : this.sql.exec('SELECT COUNT(*) AS n FROM refresh WHERE user_id = ?', userId).toArray()[0];
    if (except) this.sql.exec('DELETE FROM refresh WHERE user_id = ? AND hash != ?', userId, except);
    else this.sql.exec('DELETE FROM refresh WHERE user_id = ?', userId);
    return n ? num(n.n) : 0;
  }

  /** Store a password record: its client key's version (pw_v) and its pepper (pw_kid) with it. */
  setPassword(userId: string, pw: PasswordRecord): boolean {
    const u = this.userById(userId);
    if (u === null) return false;
    this.sql.exec('UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iter = ?, pw_v = ?, pw_kid = ? WHERE id = ?', pw.hash, pw.salt, pw.iter, pwVOf(pw), pw.kid ?? '', userId);
    return true;
  }

  /** The account's stored password hash right now (null: none, or no such account): what a check proved must still be it. */
  passwordHash(userId: string): string | null {
    const u = this.userById(userId);
    return u === null || u.pw_hash === null || u.pw_hash === undefined ? null : str(u.pw_hash);
  }

  setRecovery(userId: string, hashes: readonly string[]): void {
    this.sql.exec('UPDATE users SET recovery = ? WHERE id = ?', JSON.stringify(hashes), userId);
  }

  recoveryLeft(userId: string): number {
    const u = this.userById(userId);
    return u === null ? 0 : (JSON.parse(str(u.recovery) || '[]') as string[]).length;
  }

  /**
   * Password reset with a recovery code (the legacy path): the code (its hash) is consumed, the
   * password replaced and every session signed out; a new refresh token for this browser, at level
   * 2. Null when the user / code do not match, and for an account with a verified email, which
   * resets by email instead (the design's downgrade rule (a)).
   */
  recover(username: string, codeHash: string, pw: PasswordRecord, refreshHash: string | RefreshGrant, now: number): (UserRef & { codesLeft: number }) | null {
    return this.tx(() => {
      const u = this.userByKey(usernameKey(username));
      if (u === null || num(u.banned) === 1) return null;
      if (u.email_canon !== null && u.email_canon !== undefined) return null;
      const codes = JSON.parse(str(u.recovery) || '[]') as string[];
      const i = codes.indexOf(codeHash);
      if (i < 0) return null;
      codes.splice(i, 1);
      const id = str(u.id);
      this.sql.exec('UPDATE users SET recovery = ?, pw_hash = ?, pw_salt = ?, pw_iter = ?, pw_v = ?, pw_kid = ?, last_login = ? WHERE id = ?', JSON.stringify(codes), pw.hash, pw.salt, pw.iter, pwVOf(pw), pw.kid ?? '', now, id);
      this.deleteRefreshOf(id);
      this.addRefresh(id, refreshHash, now, now, now, null, { lvl: 2, method: 'reset' });
      return { ...this.refOf(u), authAt: now, authLvl: 2 as const, codesLeft: codes.length };
    });
  }

  /**
   * Sign in (or sign up) with an OAuth identity. `linkTo` = the signed-in account that asked to
   * link it (profile screen). A new account takes `suggested` (made unique with a numeric suffix).
   * A link never replaces the account's own id of that provider ('provider_set': an unlink comes
   * first) and a suspended account links nothing ('no_user'). `lvl`: the level of the press on the
   * provider's page that brought the identity (R6; the Worker knows the prompt it asked for), the
   * new token's; its method is the provider.
   */
  oauth(provider: OAuthProvider, providerId: string, suggested: string, linkTo: string | null, refreshHash: string | RefreshGrant, now: number, lvl: 0 | 1 | 2 = 0): (UserRef & { created: boolean }) | 'already_linked' | 'provider_set' | 'no_user' {
    const col = provider === 'google' ? 'google_sub' : 'discord_id';
    const proof: SignInProof = { lvl, method: provider };
    return this.tx(() => {
      const owner = this.sql.exec(`SELECT id, username, banned, created_at FROM users WHERE ${col} = ?`, providerId).toArray()[0];
      if (linkTo !== null) {
        const me = this.userById(linkTo);
        if (me === null || num(me.banned) === 1) return 'no_user' as const;
        if (owner && str(owner.id) !== linkTo) return 'already_linked' as const;
        const current = me[col];
        if (current !== null && current !== undefined && str(current) !== providerId) return 'provider_set' as const;
        if (current === null || current === undefined) this.sql.exec(`UPDATE users SET ${col} = ?, ${col === 'google_sub' ? 'google' : 'discord'}_linked_at = ? WHERE id = ? AND ${col} IS NULL`, providerId, now, linkTo);
        this.addRefresh(linkTo, refreshHash, now, now, now, null, proof);
        return { ...this.refOf(me), authAt: now, authLvl: lvl, created: false };
      }
      if (owner) {
        if (num(owner.banned) === 1) return 'no_user' as const;
        const id = str(owner.id);
        this.sql.exec('UPDATE users SET last_login = ? WHERE id = ?', now, id);
        this.addRefresh(id, refreshHash, now, now, now, null, proof);
        return { ...this.refOf(owner), authAt: now, authLvl: lvl, created: false };
      }
      let name = usernameFromDisplay(suggested);
      for (let n = 0; this.usernameTaken(name); n++) {
        const suffix = String(n < 5 ? Math.floor(Math.random() * 100) : Math.floor(Math.random() * 100000));
        name = name.slice(0, 16 - suffix.length) + suffix;
      }
      const id = this.freshId();
      this.sql.exec(`INSERT INTO users (id, username, ukey, ${col}, ${provider}_linked_at, created_at, last_login) VALUES (?, ?, ?, ?, ?, ?, ?)`, id, name, usernameKey(name), providerId, now, now, now);
      this.addRefresh(id, refreshHash, now, now, now, null, proof);
      return { userId: id, username: name, car: DEFAULT_CAR, createdAt: now, authAt: now, authLvl: lvl, created: true };
    });
  }

  /**
   * A re-authentication with a provider (PERFIL's "confirm it is you"): the identity must already
   * be one of `userId`'s; then a new token for this browser, its credential proof now at `lvl`
   * (the press on the provider's page, R6). 'mismatch' for another account's identity or none
   * (nothing signs in, nothing is created).
   */
  oauthReauth(provider: OAuthProvider, providerId: string, userId: string, refreshHash: string | RefreshGrant, now: number, lvl: 0 | 1 | 2 = 0): UserRef | 'mismatch' | 'no_user' {
    const col = provider === 'google' ? 'google_sub' : 'discord_id';
    return this.tx(() => {
      const me = this.userById(userId);
      if (me === null || num(me.banned) === 1) return 'no_user' as const;
      if (me[col] === null || me[col] === undefined || str(me[col]) !== providerId) return 'mismatch' as const;
      this.sql.exec('UPDATE users SET last_login = ? WHERE id = ?', now, userId);
      this.addRefresh(userId, refreshHash, now, now, now, null, { lvl, method: provider });
      return { ...this.refOf(me), authAt: now, authLvl: lvl };
    });
  }

  /**
   * A re-authentication with the password (the Worker checked it): this browser's token proves a
   * credential now, at level 2 (a typed password); null when it is not the account's or a TV's.
   * `rekey`: the password it proved, stored again in the same transaction (a legacy key re-keyed).
   */
  markFresh(userId: string, refreshHash: string, now: number, rekey: PasswordRecord | null = null): UserRef | null {
    return this.tx(() => {
      const r = this.sql.exec("SELECT expires_at FROM refresh WHERE hash = ? AND user_id = ? AND kind = 'web'", refreshHash, userId).toArray()[0];
      if (!r || num(r.expires_at) <= now) return null;
      const u = this.userById(userId);
      if (u === null || num(u.banned) === 1) return null;
      if (rekey !== null) this.setPassword(userId, rekey);
      this.sql.exec('UPDATE refresh SET auth_at = ?, auth_lvl = 2 WHERE hash = ?', now, refreshHash);
      return { ...this.refOf(u), authAt: now, authLvl: 2 };
    });
  }

  /**
   * The highest level the account can reach (R6's ceiling) with the proofs this build takes: 2 with
   * a password (a v1 or v2 key: "confirm it's you" takes either) or a verified address (a code from
   * its mailbox, sign-in PR 7), else 1, a press on a provider's page. Google's forced login joins it
   * with the Google PR.
   */
  private ceilingOf(u: Row): 1 | 2 {
    return (u.pw_hash !== null && u.pw_hash !== undefined) || (u.email_canon !== null && u.email_canon !== undefined) ? 2 : 1;
  }

  /**
   * Remove a provider from the account (PERFIL's unlink): 'last_method' when it is the only way in
   * left (no password and no other provider), 'not_linked' when the account has none of it.
   * `level`: the caller's session level (fresh). Leaving exactly one way in needs level 2, capped
   * by the account's ceiling (ceilingOf), so no account is locked out of it: 'level2' when the
   * session is below what it needs. Leaving two or more needs level 1, which the route checks.
   */
  unlink(userId: string, provider: OAuthProvider, level: 0 | 1 | 2 = 2): 'ok' | 'last_method' | 'not_linked' | 'no_user' | 'level2' {
    const col = provider === 'google' ? 'google_sub' : 'discord_id';
    return this.tx(() => {
      const u = this.userById(userId);
      if (u === null || num(u.banned) === 1) return 'no_user' as const;
      if (u[col] === null || u[col] === undefined) return 'not_linked' as const;
      const ways = [u.pw_hash, u.google_sub, u.discord_id].filter((v) => v !== null && v !== undefined).length;
      if (ways <= 1) return 'last_method' as const;
      if (ways - 1 === 1 && level < Math.min(2, this.ceilingOf(u))) return 'level2' as const;
      this.sql.exec(`UPDATE users SET ${col} = NULL, ${provider}_linked_at = NULL WHERE id = ?`, userId);
      return 'ok' as const;
    });
  }

  // ---- durable sign-in throttles (auth_throttle; the policy and the HMAC'd keys are AccountsDO's) ----

  /** The rows of `keys` that exist. */
  throttleRows(keys: readonly string[]): Map<string, ThrottleEntry> {
    const out = new Map<string, ThrottleEntry>();
    for (const k of keys) {
      const r = this.sql.exec('SELECT count, first_at, locked_until FROM auth_throttle WHERE key = ?', k).toArray()[0];
      if (r) out.set(k, { count: num(r.count), first: num(r.first_at), lockedUntil: num(r.locked_until) });
    }
    return out;
  }

  /** Write counters, in one transaction. */
  throttleWrite(rows: ReadonlyMap<string, ThrottleEntry>): void {
    this.tx(() => {
      for (const [k, e] of rows) this.sql.exec('INSERT OR REPLACE INTO auth_throttle (key, count, first_at, locked_until) VALUES (?, ?, ?, ?)', k, e.count, e.first, e.lockedUntil);
    });
  }

  /** A success: these counters start again. */
  throttleClear(keys: readonly string[]): void {
    for (const k of keys) this.sql.exec('DELETE FROM auth_throttle WHERE key = ?', k);
  }

  // ---- email (the sign-in design's data model; the routes that prove a mailbox come later) ---------

  /** Some account other than `userId` claims `canon`, or an email change's undo holds it for another account (I2). */
  private canonTaken(canon: string, userId: string): boolean {
    if (this.sql.exec('SELECT 1 AS x FROM users WHERE email_canon = ? AND id != ?', canon, userId).toArray().length > 0) return true;
    return this.sql.exec('SELECT 1 AS x FROM email_holds WHERE canon = ? AND user_id != ?', canon, userId).toArray().length > 0;
  }

  /**
   * The account's verified address becomes `email`, which the caller proved (I1: a code or link of
   * ours, or an authoritative Google address). The address and its canon are derived here from what
   * was typed (I9). 'taken' when another account claims that canon or holds it for an undo (I2; the
   * partial UNIQUE index stands behind this). In the same transaction the account's own hint goes,
   * and so does every other account's hint of that canon (a hint never points at a claimed address).
   */
  claimEmail(userId: string, email: string, proof: EmailProof, now: number): 'ok' | 'taken' | 'bad_email' | 'no_user' {
    const address = normalizeEmail(email);
    const canon = emailCanon(email);
    if (address === null || canon === null) return 'bad_email';
    return this.tx(() => {
      if (this.userById(userId) === null) return 'no_user' as const;
      if (this.canonTaken(canon, userId)) return 'taken' as const;
      this.sql.exec(
        "UPDATE users SET email = ?, email_canon = ?, email_verified_at = ?, email_proof = ?, email_hint = NULL, email_hint_canon = NULL, email_hint_from = '' WHERE id = ?",
        address, canon, now, proof, userId,
      );
      this.sql.exec("UPDATE users SET email_hint = NULL, email_hint_canon = NULL, email_hint_from = '' WHERE email_hint_canon = ? AND id != ?", canon, userId);
      return 'ok' as const;
    });
  }

  /**
   * A provider's address that is not proved (Discord's, or a Google address that is not
   * authoritative) becomes the account's hint: it finds a match and prefills "confirm your email",
   * and is never mailed. 'claimed' when an account (this one too) claims its canon or an undo holds
   * it: no hint is ever written for such a canon.
   */
  setEmailHint(userId: string, email: string, from: OAuthProvider): 'ok' | 'claimed' | 'bad_email' | 'no_user' {
    const address = normalizeEmail(email);
    const canon = emailCanon(email);
    if (address === null || canon === null) return 'bad_email';
    return this.tx(() => {
      if (this.userById(userId) === null) return 'no_user' as const;
      const claimed = this.sql.exec('SELECT 1 AS x FROM users WHERE email_canon = ?', canon).toArray().length > 0;
      if (claimed || this.sql.exec('SELECT 1 AS x FROM email_holds WHERE canon = ?', canon).toArray().length > 0) return 'claimed' as const;
      this.sql.exec('UPDATE users SET email_hint = ?, email_hint_canon = ?, email_hint_from = ? WHERE id = ?', address, canon, from, userId);
      return 'ok' as const;
    });
  }

  // ---- names a new one may not imitate (the sign-in design, section 5.2) -------------------------

  /**
   * protected_skel again from scratch: the skeletons (account.ts nameSkeleton) of the project's
   * accounts (`trustedIds`, NODE_TRUSTED_OPERATORS) and of the top PROTECTED_TOP of each playlist's
   * leaderboard. The AccountsDO runs it at every start (a change of the trusted list is a deploy) and
   * with the daily prune. How many rows it wrote.
   */
  rebuildProtectedSkeletons(trustedIds: readonly string[]): number {
    return this.tx(() => {
      this.sql.exec('DELETE FROM protected_skel');
      let n = 0;
      const add = (id: string, name: string, why: string): void => {
        this.sql.exec('INSERT OR IGNORE INTO protected_skel (skel, user_id, why) VALUES (?, ?, ?)', nameSkeleton(name), id, why);
        n++;
      };
      for (const id of trustedIds) {
        const u = this.userById(id);
        if (u !== null) add(id, str(u.username), 'trusted');
      }
      for (const p of PLAYLISTS) {
        const top = this.sql
          .exec('SELECT u.id AS id, u.username AS name FROM ratings r JOIN users u ON u.id = r.user_id WHERE r.playlist = ? AND r.season = ? AND r.games >= ? AND u.banned = 0 ORDER BY r.mu DESC LIMIT ?', p, SEASON, PLACEMENT_MATCHES, PROTECTED_TOP)
          .toArray();
        for (const r of top) add(str(r.id), str(r.name), 'top:' + p);
      }
      return n;
    });
  }

  /** `name` has the skeleton of a protected account other than `selfId` (an account is never refused its own). */
  isLookalike(name: string, selfId: string | null): boolean {
    return this.sql.exec('SELECT 1 AS x FROM protected_skel WHERE skel = ? AND user_id != ?', nameSkeleton(name), selfId ?? '').toArray().length > 0;
  }

  /**
   * What a refused name's 409 offers (`suggest`, section 5.1): the same word with four new digits,
   * valid, free and no look-alike at this moment ('Ana' -> 'Ana4821'); a reserved or invalid name
   * gets 'Jugador' or 'Player' with digits instead.
   */
  suggestName(base: string, lang: 'es' | 'en', selfId: string | null = null): string {
    const word0 = typeof base === 'string' ? base.replace(/[0-9]+$/, '').slice(0, USERNAME_MAX - 4) : '';
    const usable = word0.length > 0 && usernameIssue(word0 + '1000') === null;
    const word = usable ? word0 : lang === 'es' ? 'Jugador' : 'Player';
    for (let i = 0; i < 40; i++) {
      const name = word + String(1000 + Math.floor(Math.random() * 9000));
      if (usernameIssue(name) === null && !this.usernameTaken(name) && !this.isLookalike(name, selfId)) return name;
    }
    return (lang === 'es' ? 'Jugador' : 'Player') + String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
  }

  /** Change the username (once per RENAME_EVERY_MS; a fresh OAuth account may rename at once). */
  rename(userId: string, username: string, now: number): UserRef | 'taken' | 'lookalike' | 'too_soon' | 'no_user' {
    return this.tx(() => {
      const u = this.userById(userId);
      if (u === null) return 'no_user' as const;
      if (num(u.renamed_at) + RENAME_EVERY_MS > now) return 'too_soon' as const;
      const other = this.userByKey(usernameKey(username));
      if (other !== null && str(other.id) !== userId) return 'taken' as const;
      if (this.isLookalike(username, userId)) return 'lookalike' as const;
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

  /** The newest news consent of the account is a grant (consents: append-only, the newest row per kind counts). */
  private newsGranted(userId: string): boolean {
    const r = this.sql.exec("SELECT granted FROM consents WHERE user_id = ? AND kind = 'news' ORDER BY id DESC LIMIT 1", userId).toArray()[0];
    return r !== undefined && num(r.granted) === 1;
  }

  /**
   * `legacyClosed`: the cutoff for passwords without a verified email has passed (the design's
   * LEGACY_PASSWORD_UNTIL; none yet), so such a password no longer counts as a way in.
   */
  me(userId: string, now: number, legacyClosed: boolean = false): MeInfo | null {
    const u = this.userById(userId);
    if (u === null) return null;
    const providers: MeInfo['providers'] = [];
    if (u.pw_hash !== null && u.pw_hash !== undefined) providers.push('password');
    if (u.google_sub !== null && u.google_sub !== undefined) providers.push('google');
    if (u.discord_id !== null && u.discord_id !== undefined) providers.push('discord');
    const renamedAt = num(u.renamed_at);
    const linkedAt: NonNullable<MeInfo['linkedAt']> = {};
    if (providers.includes('google') && num(u.google_linked_at) > 0) linkedAt.google = num(u.google_linked_at);
    if (providers.includes('discord') && num(u.discord_linked_at) > 0) linkedAt.discord = num(u.discord_linked_at);
    const email = u.email_canon !== null && u.email_canon !== undefined && u.email !== null && u.email !== undefined ? str(u.email) : null;
    const passwordCounts = providers.includes('password') && (email !== null || !legacyClosed);
    return {
      linkedAt,
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
      email,
      emailHint: u.email_hint !== null && u.email_hint !== undefined ? str(u.email_hint) : null,
      emailVerified: email !== null,
      legacy: num(u.pw_v) === PW_V_LEGACY,
      news: this.newsGranted(userId),
      deletionAt: num(u.delete_purge_at),
      waysIn: providers.filter((p) => p !== 'password').length + (passwordCounts ? 1 : 0),
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

  // ---- email accounts (sign-in PR 7: the design's sections 1.3, 1.6, 2.2 to 2.5, 4.6 and 4.7) ------
  //
  // The AccountsDO derives every secret (the link token and the code, from a row's nonce under a key
  // of JWT_SECRET: AccountsDO.ts mailSecrets) and hashes what it stores; these methods only read and
  // write rows, synchronously, so a handler that calls them without an await in between is atomic.

  /** A mail_tokens row by the hash of its link token, or the newest one of an attempt (the hash of its id). */
  mailToken(by: 'hash' | 'attempt', value: string): MailTokenRow | null {
    const r =
      by === 'hash'
        ? this.sql.exec('SELECT * FROM mail_tokens WHERE hash = ?', value).toArray()[0]
        : this.sql.exec('SELECT * FROM mail_tokens WHERE attempt_hash = ? ORDER BY created_at DESC LIMIT 1', value).toArray()[0];
    return r ? mailTokenOf(r) : null;
  }

  /** Store a mailed proof (its hashes only; a decoy's code hash is random, section 1.6). */
  addMailToken(t: NewMailToken, now: number): void {
    this.sql.exec(
      'INSERT INTO mail_tokens (hash, nonce, purpose, user_id, email, email_canon, attempt_hash, code_hash, code_expires_at, payload, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      t.hash, t.nonce, t.purpose, t.userId, t.email, t.canon, t.attemptHash, t.codeHash, t.codeExpiresAt, JSON.stringify({ ...t.payload, sentAt: now }), now, t.expiresAt,
    );
  }

  /**
   * A code typed for `row` (`codeHash`: SHA-256 of 'code|' + attempt + '|' + code): 'ok', or a wrong
   * one counted on the row ({ triesLeft }: 0 for the CODE_TRIES-th, which the answer calls expired),
   * or 'expired' (used, past its life, out of tries). Consumes nothing.
   */
  codeVerdict(row: MailTokenRow, codeHash: string, now: number): 'ok' | 'expired' | { triesLeft: number } {
    if (row.usedAt > 0 || now >= row.expiresAt || now >= row.codeExpiresAt || row.codeTries >= CODE_TRIES || row.codeHash === null) return 'expired';
    if (sameHex(row.codeHash, codeHash)) return 'ok';
    const tries = row.codeTries + 1;
    this.sql.exec('UPDATE mail_tokens SET code_tries = ? WHERE hash = ?', tries, row.hash);
    return { triesLeft: Math.max(0, CODE_TRIES - tries) };
  }

  /** The row is used: its address, canon and payload blanked (section 1.3); `usedBy` the account it made or changed. */
  useMailToken(hash: string, usedBy: string | null, now: number): void {
    this.sql.exec("UPDATE mail_tokens SET used_at = ?, used_by = ?, email = '', email_canon = '', payload = '{}' WHERE hash = ? AND used_at = 0", now, usedBy, hash);
  }

  /**
   * Every live row of `purposes` of an account (or of a canon) used, but `except`: a newer one
   * supersedes them, a password change kills them. `usedBy` goes on them (a sign-up's other attempts
   * then answer already_created). How many went.
   */
  killMailTokens(by: { userId: string } | { canon: string }, purposes: readonly MailPurpose[], now: number, except: string | null = null, usedBy: string | null = null): number {
    let n = 0;
    for (const p of purposes) {
      const rows =
        'userId' in by
          ? this.sql.exec('SELECT hash FROM mail_tokens WHERE user_id = ? AND purpose = ? AND used_at = 0', by.userId, p).toArray()
          : this.sql.exec('SELECT hash FROM mail_tokens WHERE email_canon = ? AND purpose = ? AND used_at = 0', by.canon, p).toArray();
      for (const r of rows) {
        if (str(r.hash) === except) continue;
        this.useMailToken(str(r.hash), usedBy, now);
        n++;
      }
    }
    return n;
  }

  /** A resend: one more, the code's new life, and its hash when the row's mail now carries a code (a decoy turned real, a rotated key). */
  resentMailToken(row: MailTokenRow, codeHash: string | null, codeExpiresAt: number, now: number): void {
    this.sql.exec(
      'UPDATE mail_tokens SET resends = resends + 1, code_expires_at = ?, code_hash = COALESCE(?, code_hash), payload = ? WHERE hash = ?',
      codeExpiresAt, codeHash, JSON.stringify({ ...row.payload, sentAt: now }), row.hash,
    );
  }

  /**
   * Who holds `canon` right now (I2): an account that claimed it, an undo's hold (email_holds) for
   * an account, a hint some account carries (only a hint: the canon is free), or nobody.
   */
  canonState(canon: string, now: number): { kind: 'claimed'; userId: string } | { kind: 'held'; userId: string; email: string } | { kind: 'hint'; from: OAuthProvider } | { kind: 'free' } {
    const owner = this.sql.exec('SELECT id FROM users WHERE email_canon = ?', canon).toArray()[0];
    if (owner) return { kind: 'claimed', userId: str(owner.id) };
    const hold = this.sql.exec('SELECT user_id, email FROM email_holds WHERE canon = ? AND until > ?', canon, now).toArray()[0];
    if (hold) return { kind: 'held', userId: str(hold.user_id), email: str(hold.email) };
    const hint = this.sql.exec('SELECT email_hint_from FROM users WHERE email_hint_canon = ? LIMIT 1', canon).toArray()[0];
    const from = hint ? str(hint.email_hint_from) : '';
    return from === 'google' || from === 'discord' ? { kind: 'hint', from } : { kind: 'free' };
  }

  /** What a mail to or about the account needs (the templates' {name}, {methods}, its language and zone), or null. */
  mailProfile(userId: string): MailProfile | null {
    const u = this.userById(userId);
    if (u === null) return null;
    const email = u.email_canon !== null && u.email_canon !== undefined && u.email !== null && u.email !== undefined ? str(u.email) : null;
    const hasPassword = u.pw_hash !== null && u.pw_hash !== undefined;
    const ways: MailProfile['ways'] = [];
    // The password signs in by email with a current key once there is an email, by the username
    // while there is none (the legacy path, which refuses an account with one: a legacy key beside a
    // verified email signs in nowhere until a reset).
    if (hasPassword && email === null) ways.push('username');
    else if (hasPassword && num(u.pw_v) === PW_V_CURRENT) ways.push('email');
    if (u.google_sub !== null && u.google_sub !== undefined) ways.push('google');
    if (u.discord_id !== null && u.discord_id !== undefined) ways.push('discord');
    if (ways.length === 0) ways.push('email');
    return { userId, name: str(u.username), email, canon: email === null ? null : str(u.email_canon), lang: str(u.lang), tz: str(u.tz), hasPassword, pwV: num(u.pw_v), ways, banned: num(u.banned) === 1 };
  }

  // The mail caps (mail_rate: fixed hour and day windows per HMAC'd key; mailCaps.ts takeSlot) and
  // the day's lanes (mail_day).

  mailWindows(keys: readonly string[]): Map<string, MailWindow> {
    const out = new Map<string, MailWindow>();
    for (const k of keys) {
      const r = this.sql.exec('SELECT hour_at, hour_n, day_at, day_n FROM mail_rate WHERE key = ?', k).toArray()[0];
      if (r) out.set(k, { hour_at: num(r.hour_at), hour_n: num(r.hour_n), day_at: num(r.day_at), day_n: num(r.day_n) });
    }
    return out;
  }

  mailWindowsWrite(rows: ReadonlyMap<string, MailWindow>): void {
    for (const [k, w] of rows) this.sql.exec('INSERT OR REPLACE INTO mail_rate (key, hour_at, hour_n, day_at, day_n) VALUES (?, ?, ?, ?, ?)', k, w.hour_at, w.hour_n, w.day_at, w.day_n);
  }

  /** The day's mail_day rows by lane (absent lanes: nothing sent, nothing failed, no pause). */
  mailDay(day: string): Record<MailLane, { sent: number; failed: number; pausedUntil: number }> {
    const out: Record<MailLane, { sent: number; failed: number; pausedUntil: number }> = {
      signup: { sent: 0, failed: 0, pausedUntil: 0 },
      account: { sent: 0, failed: 0, pausedUntil: 0 },
      notice: { sent: 0, failed: 0, pausedUntil: 0 },
    };
    for (const r of this.sql.exec('SELECT lane, sent, failed, paused_until FROM mail_day WHERE day = ?', day).toArray()) {
      const lane = str(r.lane) as MailLane;
      if (lane in out) out[lane] = { sent: num(r.sent), failed: num(r.failed), pausedUntil: num(r.paused_until) };
    }
    return out;
  }

  /** One more mail sent (or failed) in the day's lane; `pausedUntil` when the lane pauses (mailCaps.ts pauseAfterFailures). */
  mailDayCount(day: string, lane: MailLane, what: 'sent' | 'failed', pausedUntil = 0): void {
    this.sql.exec('INSERT OR IGNORE INTO mail_day (day, lane) VALUES (?, ?)', day, lane);
    if (what === 'sent') this.sql.exec('UPDATE mail_day SET sent = sent + 1 WHERE day = ? AND lane = ?', day, lane);
    else this.sql.exec('UPDATE mail_day SET failed = failed + 1, paused_until = MAX(paused_until, ?) WHERE day = ? AND lane = ?', pausedUntil, day, lane);
  }

  /**
   * reset (section 2.4), one transaction: the reset row's account gets the password (pw_v 2), every
   * refresh family goes and one starts for this browser (level 2, method 'reset'), the row is used
   * and every reset, add_email, change_email and reauth row of the account dies. Null when the row
   * is no longer a live reset, or the account is gone or suspended.
   */
  resetPassword(row: MailTokenRow, pw: PasswordRecord, refresh: RefreshGrant, now: number): UserRef | null {
    return this.tx(() => {
      const r = this.mailToken('hash', row.hash);
      if (r === null || r.purpose !== 'reset' || r.usedAt > 0 || now >= r.expiresAt || r.userId === null) return null;
      const u = this.userById(r.userId);
      if (u === null || num(u.banned) === 1) return null;
      const id = str(u.id);
      this.setPassword(id, pw);
      this.sql.exec('UPDATE users SET last_login = ? WHERE id = ?', now, id);
      this.deleteRefreshOf(id);
      this.addRefresh(id, refresh, now, now, now, null, { lvl: 2, method: 'reset' });
      this.useMailToken(r.hash, id, now);
      this.killMailTokens({ userId: id }, ['reset', 'add_email', 'change_email', 'reauth'], now);
      return { ...this.refOf(u), authAt: now, authLvl: 2 as const };
    });
  }

  /**
   * POST /api/me/password (section 2.5), one transaction: the new password, every other refresh
   * family signed out (`keep`: the caller's token), every reset and reauth row dead. False: no account.
   */
  changePassword(userId: string, pw: PasswordRecord, keep: string | null, now: number): boolean {
    return this.tx(() => {
      if (!this.setPassword(userId, pw)) return false;
      this.deleteRefreshOf(userId, keep ?? undefined);
      this.killMailTokens({ userId }, ['reset', 'reauth'], now);
      return true;
    });
  }

  /**
   * The address of the account a used sign-up row made in the last ALREADY_CREATED_MS, when the
   * proof is its own (the same code for the attempt, or its link: `codeHash` null); null otherwise.
   */
  alreadyCreated(row: MailTokenRow, codeHash: string | null, now: number): string | null {
    if (row.usedAt <= 0 || row.usedBy === null || now - row.usedAt >= ALREADY_CREATED_MS) return null;
    if (codeHash !== null && (row.codeHash === null || !sameHex(row.codeHash, codeHash))) return null;
    return this.mailProfile(row.usedBy)?.email ?? null;
  }

  /**
   * signup/finish (section 2.2), one transaction: the proof checked again (`proof`: the row and the
   * hash of the typed code, or the link alone), the name free and no look-alike, the canon free of
   * an account and a hold (I2); then the account with its verified address (email_proof 'mail',
   * pw_v 2), every other account's hint of that canon cleared, the consents, a refresh family at
   * level 2 (method 'password'), and every sign-up row of the canon used (`used_by` the new account:
   * another attempt's finish then answers already_created). A proof that already made an account in
   * the last ALREADY_CREATED_MS answers 'already_created' with that account's address.
   */
  finishSignup(
    proof: { row: MailTokenRow; codeHash: string | null },
    a: { username: string; pw: PasswordRecord; lang: string; tz: string; news: boolean; terms: string | null; refresh: RefreshGrant },
    now: number,
    name: 'ok' | 'reserved' | 'bad' = 'ok',
  ): (UserRef & { email: string }) | 'expired' | 'invalid' | { triesLeft: number } | { already: string } | 'bad_username' | 'name_reserved' | 'username_taken' | 'lookalike' | 'email_taken' {
    return this.tx(() => {
      const row = this.mailToken('hash', proof.row.hash);
      if (row === null || row.purpose !== 'signup') return proof.codeHash === null ? ('invalid' as const) : ('expired' as const);
      const byCode = proof.codeHash !== null;
      if (row.usedAt > 0) {
        const already = this.alreadyCreated(row, proof.codeHash, now);
        if (already !== null) return { already };
        return byCode ? ('expired' as const) : ('invalid' as const);
      }
      if (now >= row.expiresAt) return byCode ? ('expired' as const) : ('invalid' as const);
      if (byCode) {
        const v = this.codeVerdict(row, proof.codeHash as string, now);
        if (v !== 'ok') return v;
      }
      // The name after the proof: a refused one consumes nothing, and the person tries another.
      if (name === 'bad') return 'bad_username' as const;
      if (name === 'reserved') return 'name_reserved' as const;
      if (this.usernameTaken(a.username)) return 'username_taken' as const;
      if (this.isLookalike(a.username, null)) return 'lookalike' as const;
      const st = this.canonState(row.canon, now);
      if (st.kind === 'claimed' || st.kind === 'held') return 'email_taken' as const;
      const id = this.freshId();
      this.sql.exec(
        `INSERT INTO users (id, username, ukey, pw_hash, pw_salt, pw_iter, pw_v, pw_kid, email, email_canon, email_verified_at, email_proof, lang, tz, created_at, last_login)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'mail', ?, ?, ?, ?)`,
        id, a.username, usernameKey(a.username), a.pw.hash, a.pw.salt, a.pw.iter, PW_V_CURRENT, a.pw.kid ?? '', row.email, row.canon, now, a.lang, a.tz, now, now,
      );
      this.sql.exec("UPDATE users SET email_hint = NULL, email_hint_canon = NULL, email_hint_from = '' WHERE email_hint_canon = ? AND id != ?", row.canon, id);
      if (a.news) this.sql.exec("INSERT INTO consents (user_id, kind, version, granted, source, at) VALUES (?, 'news', ?, 1, 'signup', ?)", id, NEWS_CONSENT_VERSION, now);
      if (a.terms !== null) this.sql.exec("INSERT INTO consents (user_id, kind, version, granted, source, at) VALUES (?, 'terms', ?, 1, 'signup', ?)", id, a.terms, now);
      this.addRefresh(id, a.refresh, now, now, now, null, { lvl: 2, method: 'password' });
      const email = row.email;
      this.useMailToken(row.hash, id, now);
      this.killMailTokens({ canon: row.canon }, ['signup'], now, row.hash, id);
      return { userId: id, username: a.username, car: DEFAULT_CAR, createdAt: now, authAt: now, authLvl: 2 as const, email };
    });
  }

  // ---- the owner's counts --------------------------------------------------------------------------

  /**
   * The account counts (AccountStats): counts and booleans only. `operatorIds`: the accounts that
   * operate a community node (the NodeRegistryDO's, passed between the objects only), null when
   * unknown; `trustedIds`: NODE_TRUSTED_OPERATORS in its order. A few scans of the users table: at
   * 25,000 accounts a few milliseconds, for a maintainer's call.
   */
  accountStats(operatorIds: readonly string[] | null, trustedIds: readonly string[], now: number): AccountStats {
    const since = now - STATS_ACTIVE_MS;
    const ACTIVE = '(u.last_login > ? OR EXISTS (SELECT 1 FROM refresh r WHERE r.user_id = u.id AND r.created_at > ?) OR EXISTS (SELECT 1 FROM ratings a WHERE a.user_id = u.id AND a.last_played > ?))';
    const ONLY_PASSWORD = '(u.pw_hash IS NOT NULL AND u.google_sub IS NULL AND u.discord_id IS NULL AND u.email_canon IS NULL)';
    const RATED = 'EXISTS (SELECT 1 FROM ratings a WHERE a.user_id = u.id AND a.games > 0)';
    const POINTS = 'EXISTS (SELECT 1 FROM host_credits h WHERE h.user_id = u.id AND h.points > 0)';
    const ITEMS = 'EXISTS (SELECT 1 FROM host_claims c WHERE c.user_id = u.id)';
    const one = (q: string, ...b: unknown[]): Row => this.sql.exec(q, ...b).toArray()[0] ?? {};
    const t = one('SELECT COUNT(*) AS total, SUM(banned = 1) AS banned, SUM(email_canon IS NOT NULL) AS verified, SUM(email_hint_canon IS NOT NULL) AS hint FROM users');
    const byWays: Record<string, number> = {};
    for (const p of [1, 0]) for (const g of [1, 0]) for (const d of [1, 0]) byWays[waysKey(p, g, d)] = 0;
    for (const r of this.sql.exec('SELECT (pw_hash IS NOT NULL) AS p, (google_sub IS NOT NULL) AS g, (discord_id IS NOT NULL) AS d, COUNT(*) AS n FROM users GROUP BY p, g, d').toArray()) {
      byWays[waysKey(num(r.p), num(r.g), num(r.d))] = num(r.n);
    }
    const byPwV: Record<string, number> = { '0': 0, '1': 0, '2': 0 };
    for (const r of this.sql.exec('SELECT pw_v AS v, COUNT(*) AS n FROM users GROUP BY pw_v').toArray()) byPwV[String(num(r.v))] = num(r.n);
    const active = one(`SELECT COUNT(*) AS n FROM users u WHERE ${ACTIVE}`, since, since, since);
    const po = one(
      `SELECT COUNT(*) AS total, SUM(${ACTIVE}) AS active, SUM(u.email_hint_canon IS NOT NULL) AS hint, SUM(${RATED}) AS rated, SUM(${POINTS}) AS points,
       SUM(${ITEMS}) AS items, SUM(${RATED} OR ${POINTS} OR ${ITEMS}) AS anyOf FROM users u WHERE ${ONLY_PASSWORD}`,
      since, since, since,
    );
    let operators: number | null = null;
    let nodes: number | null = null;
    let nodesOnly = 0;
    if (operatorIds !== null) {
      operators = 0;
      nodes = 0;
      for (const id of new Set(operatorIds)) {
        const r = this.sql.exec(`SELECT ${ONLY_PASSWORD} AS po, (${RATED} OR ${POINTS} OR ${ITEMS}) AS other FROM users u WHERE u.id = ?`, id).toArray()[0];
        if (!r) continue;
        operators++;
        if (num(r.po) === 1) {
          nodes++;
          if (num(r.other) !== 1) nodesOnly++;
        }
      }
    }
    const trusted = trustedIds.map((id) => {
      const r = this.sql.exec('SELECT (pw_hash IS NOT NULL) AS p, (email_canon IS NOT NULL) AS e, (google_sub IS NOT NULL) AS g, (discord_id IS NOT NULL) AS d FROM users WHERE id = ?', id).toArray()[0];
      return { found: r !== undefined, password: num(r?.p) === 1, verifiedEmail: num(r?.e) === 1, google: num(r?.g) === 1, discord: num(r?.d) === 1 };
    });
    return {
      total: num(t.total),
      banned: num(t.banned),
      byWays,
      byPwV,
      verifiedEmail: num(t.verified),
      emailHint: num(t.hint),
      active30d: num(active.n),
      passwordOnly: { total: num(po.total), active30d: num(po.active), emailHint: num(po.hint), rated: num(po.rated), hostPoints: num(po.points), items: num(po.items), nodes, withAny: num(po.anyOf) + nodesOnly },
      operators,
      trusted,
    };
  }

  /**
   * Daily cleanup: expired refresh tokens, locks and bans, old abandons and ranked results (never
   * the hosts' shop); and the sign-in tables: mail tokens a day past their expiry, undo holds past
   * their end, throttle rows outside their window and unlocked, mail caps whose windows are over,
   * the mail days older than 30 days and sanction marks past their end. Never the consents (the
   * log), the tombstones (deleted_ids) or meta.
   */
  prune(now: number): void {
    this.tx(() => {
      this.sql.exec('DELETE FROM refresh WHERE expires_at <= ?', now);
      this.sql.exec('DELETE FROM ranked_locks WHERE until <= ?', now);
      this.sql.exec('DELETE FROM bans WHERE until <= ?', now);
      this.sql.exec('DELETE FROM abandons WHERE at <= ?', now - ABANDON_WINDOW_MS);
      const old = now - RANKED_KEEP_MS;
      this.sql.exec('DELETE FROM ranked_players WHERE match_id IN (SELECT match_id FROM ranked_matches WHERE ended_at <= ?)', old);
      this.sql.exec('DELETE FROM ranked_matches WHERE ended_at <= ?', old);
      this.sql.exec('DELETE FROM mail_tokens WHERE expires_at <= ?', now - MAIL_TOKEN_KEEP_MS);
      this.sql.exec('DELETE FROM email_holds WHERE until <= ?', now);
      this.sql.exec('DELETE FROM auth_throttle WHERE first_at <= ? AND locked_until <= ?', now - THROTTLE_KEEP_MS, now);
      this.sql.exec('DELETE FROM mail_rate WHERE hour_at <= ? AND day_at <= ?', now - MAIL_RATE_KEEP_MS, now - MAIL_RATE_KEEP_MS);
      // mail_day.day is a UTC date (mailCaps.ts mailDay): the rows of days before the kept ones go.
      this.sql.exec('DELETE FROM mail_day WHERE day < ?', new Date(now - MAIL_DAY_KEEP_DAYS * DAY_MS).toISOString().slice(0, 10));
      this.sql.exec('DELETE FROM sanction_marks WHERE until <= ?', now);
    });
  }
}
