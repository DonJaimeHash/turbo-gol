/**
 * Accounts, ranked, playlists, custom lobbies: the JSON contract between the browser and the
 * Worker (server/src/accountRoutes.ts, AccountsDO, LobbyDO), plus the client-side password
 * pre-hash both sides must agree on. Pure (WebCrypto only), node-importable.
 *
 * Passwords never leave the browser: the client derives `clientPasswordKey` (PBKDF2-SHA256,
 * CLIENT_KDF_ITERATIONS, salted with the normalised username) and sends that hex string; the
 * server stores PBKDF2 of it again with a random salt (100,000 iterations, the Workers WebCrypto
 * ceiling). An offline attacker of a leaked table pays both stages per guess, and a key seen in
 * transit or in a log is useless on any other site.
 */

import type { RulesSnapshot, StoredPreset } from '../game/physicsRules';

export const CLIENT_KDF_ITERATIONS = 200_000;
const CLIENT_KDF_SALT_PREFIX = 'turbogol/account/v1/';

/** Game playlists (team size). Casual and ranked use the same three. */
export type Playlist = '1v1' | '2v2' | '3v3';
export const PLAYLISTS: readonly Playlist[] = ['1v1', '2v2', '3v3'];
export const PLAYLIST_NAMES: Readonly<Record<Playlist, string>> = { '1v1': 'Mano a mano', '2v2': 'Parejas', '3v3': 'Tríos' };

export function isPlaylist(v: unknown): v is Playlist {
  return v === '1v1' || v === '2v2' || v === '3v3';
}

/**
 * Matchmaking regions (one matchmaker per region). 'auto' = the continent Cloudflare sees the
 * request from. The ids are Cloudflare's continent codes.
 */
export type RegionId = 'SA' | 'NA' | 'EU' | 'AS' | 'OC' | 'AF';
export const REGIONS: ReadonlyArray<{ id: RegionId; name: string }> = [
  { id: 'SA', name: 'Sudamérica' },
  { id: 'NA', name: 'Norteamérica' },
  { id: 'EU', name: 'Europa' },
  { id: 'AS', name: 'Asia' },
  { id: 'OC', name: 'Oceanía' },
  { id: 'AF', name: 'África' },
];

export function isRegion(v: unknown): v is RegionId {
  return typeof v === 'string' && REGIONS.some((r) => r.id === v);
}

// ---- usernames / passwords ----------------------------------------------------------------------

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 16;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

const RESERVED = new Set(['admin', 'administrator', 'moderator', 'mod', 'system', 'server', 'bot', 'guest', 'invitado', 'support', 'soporte', 'root', 'null', 'undefined', 'anonymous']);
/** A few of the passwords every breach list starts with (NIST 800-63B: refuse known-bad secrets). */
const WEAK_PASSWORDS = new Set([
  '12345678', '123456789', '1234567890', 'password', 'password1', 'qwertyui', 'qwerty123', '11111111', '00000000', 'iloveyou',
  'contraseña', 'contrasena', 'abcd1234', '87654321', 'asdfghjk', 'turbogol123', 'football', 'futbol123', 'passw0rd', 'qwertyuiop',
]);

/** Case-insensitive, NFKC-normalised key of a username (uniqueness and the KDF salt). */
export function usernameKey(name: string): string {
  return name.normalize('NFKC').toLowerCase();
}

/**
 * Why a username or password is refused: a machine code plus the numbers its text shows.
 * usernameIssue / passwordIssue are the only copy of the rules. The menus show
 * t('account.issue.<code>', params) (src/i18n.ts); usernameProblem / passwordProblem turn the same
 * codes into the Spanish text the Worker sends (this file is shared with it: no i18n import here).
 */
export type AccountIssueCode =
  | 'usernameMissing'
  | 'usernameLength'
  | 'usernameChars'
  | 'usernameReserved'
  | 'passwordShort'
  | 'passwordLong'
  | 'passwordCommon'
  | 'passwordHasUsername'
  | 'passwordRepeated';

export interface AccountIssue {
  code: AccountIssueCode;
  /** { min, max } for usernameLength, { count } for passwordShort / passwordLong. */
  params?: Record<string, number>;
}

/**
 * Null when `name` is a valid username: 3-16 chars of ASCII letters, digits, '_', '-', '.', starting
 * with a letter or digit, not reserved, not 'guest-…'. Otherwise what is wrong with it.
 */
export function usernameIssue(name: unknown): AccountIssue | null {
  if (typeof name !== 'string') return { code: 'usernameMissing' };
  if (name.length < USERNAME_MIN || name.length > USERNAME_MAX) return { code: 'usernameLength', params: { min: USERNAME_MIN, max: USERNAME_MAX } };
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) return { code: 'usernameChars' };
  const k = usernameKey(name);
  if (RESERVED.has(k) || k.startsWith('guest') || k.startsWith('bot')) return { code: 'usernameReserved' };
  return null;
}

/** Null when `pw` is acceptable for `username`; otherwise what is wrong with it. */
export function passwordIssue(pw: unknown, username: string): AccountIssue | null {
  if (typeof pw !== 'string' || pw.length < PASSWORD_MIN) return { code: 'passwordShort', params: { count: PASSWORD_MIN } };
  if (pw.length > PASSWORD_MAX) return { code: 'passwordLong', params: { count: PASSWORD_MAX } };
  const k = pw.toLowerCase();
  if (WEAK_PASSWORDS.has(k)) return { code: 'passwordCommon' };
  if (username.length > 0 && k.includes(usernameKey(username))) return { code: 'passwordHasUsername' };
  if (/^(.)\1+$/.test(pw)) return { code: 'passwordRepeated' };
  return null;
}

/** Spanish text of each issue: the server's bad_username message (the client shows account.issue.* texts). */
const ISSUE_SPANISH: Readonly<Record<AccountIssueCode, string>> = {
  usernameMissing: 'Elige un nombre de usuario',
  usernameLength: `El usuario tiene que tener entre ${USERNAME_MIN} y ${USERNAME_MAX} caracteres`,
  usernameChars: 'Usa solo letras, números, "_", "-" o "." (empezando con letra o número)',
  usernameReserved: 'Ese nombre está reservado',
  passwordShort: `La contraseña tiene que tener al menos ${PASSWORD_MIN} caracteres`,
  passwordLong: `La contraseña puede tener hasta ${PASSWORD_MAX} caracteres`,
  passwordCommon: 'Esa contraseña es demasiado común',
  passwordHasUsername: 'La contraseña no puede contener tu usuario',
  passwordRepeated: 'La contraseña no puede ser un solo carácter repetido',
};

/** usernameIssue as a Spanish message (the Worker sends it as the bad_username message), null when valid. */
export function usernameProblem(name: unknown): string | null {
  const issue = usernameIssue(name);
  return issue === null ? null : ISSUE_SPANISH[issue.code];
}

/** passwordIssue as a Spanish message, null when acceptable. */
export function passwordProblem(pw: unknown, username: string): string | null {
  const issue = passwordIssue(pw, username);
  return issue === null ? null : ISSUE_SPANISH[issue.code];
}

function hex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return s;
}

/**
 * The value sent as `password` to /api/auth/*: PBKDF2-SHA256(password, prefix + usernameKey,
 * CLIENT_KDF_ITERATIONS) as 64 hex chars. ~0.1-0.3 s in a browser.
 */
export async function clientPasswordKey(username: string, password: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(CLIENT_KDF_SALT_PREFIX + usernameKey(username)), iterations: CLIENT_KDF_ITERATIONS },
    key,
    256,
  );
  return hex(new Uint8Array(bits));
}

export function isClientKey(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
}

// ---- API shapes -------------------------------------------------------------------------------

export type OAuthProvider = 'google' | 'discord';
export const OAUTH_PROVIDERS: readonly OAuthProvider[] = ['google', 'discord'];

/**
 * A registered player's session (POST /api/auth/register | login | refresh, OAuth callback then
 * refresh). `session` is a short HS256 Bearer token (1 h); the long-lived refresh token lives in
 * an HttpOnly cookie the page never sees.
 */
export interface AccountSession {
  kind: 'account';
  playerId: string;
  name: string;
  session: string;
  expiresAt: number;
}

export interface RegisterAnswer extends AccountSession {
  /** Shown once: each one resets the password (POST /api/auth/recover) when it is forgotten. */
  recoveryCodes: string[];
}

/** One playlist's ranked standing as the menus show it. */
export interface PlaylistRating {
  playlist: Playlist;
  mmr: number;
  /** Tier id (rating.ts TIERS) once placed, null during placement. */
  tier: string | null;
  games: number;
  wins: number;
  losses: number;
  /** Placement games still to play (0 = placed). */
  placementLeft: number;
  peakMmr: number;
}

export interface MeInfo {
  playerId: string;
  name: string;
  createdAt: number;
  /** How this account signs in. */
  providers: Array<'password' | OAuthProvider>;
  /** False for an OAuth account that never set a password (it cannot use the password form). */
  hasPassword: boolean;
  /** The username may be changed again from this time (ms), 0 = now. */
  renameAt: number;
  ratings: PlaylistRating[];
  /** Ranked queue refused until this time (ms) after abandons, 0 = free. */
  rankedBanUntil: number;
  abandons24h: number;
  season: number;
  /**
   * Settings > Experimental's switch as the account holds it (GET /api/me/experimental: also the
   * presets). The client keeps a local copy per account (src/game/experimentalStore.ts).
   */
  experimental: boolean;
}

/** GET /api/me/experimental (and the base of every experimental write's answer). */
export interface ExperimentalAnswer {
  enabled: boolean;
  /** The account's own presets, oldest first (src/game/physicsRules.ts StoredPreset). */
  presets: StoredPreset[];
}

export interface LeaderboardEntry {
  rank: number;
  name: string;
  mmr: number;
  tier: string;
  games: number;
  wins: number;
}

export interface LeaderboardAnswer {
  playlist: Playlist;
  season: number;
  entries: LeaderboardEntry[];
  /** The caller's own row when signed in and placed (it may be outside `entries`). */
  you: LeaderboardEntry | null;
  /** Placed players in this playlist. */
  total: number;
}

/**
 * One of the caller's community nodes (GET /nodes/mine, server/src/NodeRegistryDO.ts mineView): the
 * part PERFIL's MI SERVIDOR shows. `status` as nodes/shared/controlProtocol.ts NodeStatus;
 * `counters.verified`: matches it hosted whose result was verified, all time.
 */
export interface MyNode {
  nodeId: string;
  name: string | null;
  region: string;
  status: 'pending' | 'probation' | 'active' | 'suspended' | 'banned';
  statusReason: string | null;
  suspendedUntil: number | null;
  online: boolean;
  counters: { verified: number; probationVerified: number };
  version: string;
  compatible: boolean;
}

/** GET /api/ranked/result?matchId=: the caller's rating change of a finished ranked match. */
export type RankedResultAnswer =
  | { status: 'pending' }
  | { status: 'cancelled'; reason: string }
  | {
      status: 'done';
      playlist: Playlist;
      outcome: 'win' | 'loss' | 'draw';
      left: boolean;
      mmrBefore: number;
      mmrAfter: number;
      tierBefore: string | null;
      tierAfter: string | null;
      placementLeft: number;
      /** A ranked ban started by this match (abandon), 0 = none. */
      banUntil: number;
    };

/** GET /api/population?region=: players waiting / playing in that region's matchmaker (cached a few seconds). */
export interface PopulationAnswer {
  region: string;
  /** Waiting per queue: casual (p2p + server) and ranked, by playlist. */
  casual: Record<Playlist, number>;
  ranked: Record<Playlist, number>;
  /** Players holding a match / room lock (playing right now). */
  playing: number;
  /** Open public lobbies (custom matches) in the region. */
  lobbies: number;
}

// ---- custom lobbies -----------------------------------------------------------------------------

/** Lobby names: at least this many characters after sanitizeLobbyName, at most LOBBY_NAME_MAX. */
export const LOBBY_NAME_MIN = 3;
export const LOBBY_NAME_MAX = 24;

/**
 * A lobby name (and a physics preset's name, src/game/physicsRules.ts): NFKC, only letters,
 * digits, space and `_ . - ! ? #`, runs of spaces as one, trimmed, 3-24 characters; null
 * otherwise. The server keeps what this returns (server/src/LobbyDO.ts), so a client text that
 * must arrive unchanged has to survive it (tests/i18n-lobby-name.test.mjs).
 */
export function sanitizeLobbyName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.normalize('NFKC').replace(/[^\p{L}\p{N} _.\-!?#]/gu, '').replace(/\s+/g, ' ').trim();
  return s.length >= LOBBY_NAME_MIN && s.length <= LOBBY_NAME_MAX ? s : null;
}

export type LobbyNet = 'p2p' | 'server';
export type LobbyVisibility = 'public' | 'private';
/** Match length options of a custom lobby (seconds; 0 = unlimited). */
export const LOBBY_LENGTHS: readonly number[] = [180, 300, 600, 0];

export interface LobbySettings {
  name: string;
  mode: Playlist;
  visibility: LobbyVisibility;
  /** Empty slots get bots (always: a roster has every car of the mode). Kept for the UI line. */
  net: LobbyNet;
  matchLengthSeconds: number;
  /**
   * Experimental physics rules (Settings > Experimental): a COPY of the host's preset at the time
   * (src/game/physicsRules.ts RulesSnapshot, checked strictly by parseLobbyRules), null or absent =
   * standard physics. Only with net 'p2p', and only while every member is signed in: the Worker,
   * LobbyDO, the matchmaker and RoomDO refuse it otherwise (account_required, guests_present,
   * experimental_p2p_only, bad_physics). Such a match counts for nothing: never rated, no stats,
   * no records, no no-show strikes, never on a community node. The server always sends it (null).
   */
  physics?: RulesSnapshot | null;
}

/** A row of the public lobby list (GET /api/lobbies). */
export interface LobbySummary {
  code: string;
  name: string;
  mode: Playlist;
  players: number;
  max: number;
  locked: boolean;
  host: string;
  region: string;
  inGame: boolean;
  net: LobbyNet;
  /** The lobby plays experimental rules: members must be signed in (rows of older builds lack it: false). */
  experimental: boolean;
  /** Those rules (LobbySettings.physics), null for standard physics. */
  physics: RulesSnapshot | null;
}

export interface LobbyMember {
  /** Public per-lobby handle ('m3'): the session subject never leaves the server. */
  id: string;
  name: string;
  /** 0 blue, 1 red. */
  team: 0 | 1;
  host: boolean;
  guest: boolean;
  /** Still playing the lobby's last match. */
  inGame: boolean;
  /** Its socket dropped: the place is kept for the grace (LobbyDO LOBBY_GRACE_MS), then it goes. Absent from an older Worker: false. */
  away?: boolean;
  /** Said LISTO (informative: the host's start never waits for it). Absent from an older Worker: false. */
  ready?: boolean;
}

export interface LobbyState {
  code: string;
  settings: LobbySettings;
  hasPassword: boolean;
  region: string;
  members: LobbyMember[];
  /** The receiving member's handle. */
  you: string;
  status: 'open' | 'starting' | 'in_game';
}

/** POST /api/lobbies (create) and POST /api/lobbies/join: the lobby socket to open. */
export interface LobbyTicketAnswer {
  lobbyId: string;
  code: string;
  ticket: string;
  wsUrl: string;
}

/** Lobby socket, server -> client (JSON text frames). */
export type LobbyServerMsg =
  | { t: 'state'; lobby: LobbyState }
  /** The host started: this member's queue result (the same shapes POST /api/queue answers). */
  | { t: 'match'; result: unknown }
  | { t: 'error'; code: string; message: string }
  | { t: 'closed'; reason: string };

/** Lobby socket, client -> server. */
export type LobbyClientMsg =
  | { t: 'team'; team: 0 | 1 }
  | { t: 'settings'; settings: Partial<LobbySettings>; password?: string | null }
  | { t: 'kick'; member: string }
  /** The host hands the lobby to another member. */
  | { t: 'host'; member: string }
  /** The host moves another member to `team` (a member's own move is 'team'). */
  | { t: 'move'; member: string; team: 0 | 1 }
  | { t: 'ready'; ready: boolean }
  | { t: 'start' }
  | { t: 'back' }
  | { t: 'leave' };
