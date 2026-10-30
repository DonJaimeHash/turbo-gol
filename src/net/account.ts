/**
 * Accounts, ranked, playlists, custom lobbies: the JSON contract between the browser and the
 * Worker (server/src/accountRoutes.ts, AccountsDO, LobbyDO), plus the client-side password
 * pre-hash both sides must agree on. Pure (WebCrypto only), node-importable.
 *
 * Passwords never leave the browser: the client derives `passwordKey` (PBKDF2-SHA256,
 * CLIENT_KDF_ITERATIONS, one fixed salt: the sign-in design's v2 key) and sends that hex string;
 * the server stores PBKDF2 of it again with a random salt (100,000 iterations, the Workers WebCrypto
 * ceiling) over an HMAC with its pepper. An offline attacker of a leaked table pays both stages per
 * guess and needs the pepper, and a key seen in transit or in a log is useless on any other site.
 * The legacy key (`legacyPasswordKey`, salted with the normalised username) only proves a password
 * of before: every proof also sends the current key, and the server re-keys the account to it.
 */

import type { RulesSnapshot, StoredPreset } from '../game/physicsRules';
import type { CarId } from '../game/cosmetics';

export const CLIENT_KDF_ITERATIONS = 200_000;
const CLIENT_KDF_SALT_PREFIX = 'turbogol/account/v1/';
/**
 * The current key's salt: fixed on purpose (§1.5), so the key does not depend on the username or
 * the email, and a rename, an email change or a reset needs no re-key. Changing it would sign
 * nobody in again: never change it.
 */
export const CLIENT_KDF_SALT_V2 = 'turbogol/account/v2';

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

/**
 * Names nobody may take (the sign-in design, section 5.2), compared by skeleton (nameSkeleton): the
 * whole name, or one of its parts between '_', '.' and '-' ('Ana_Admin', 'R00t').
 */
const RESERVED_WORDS = [
  'admin', 'administrator', 'moderator', 'mod', 'system', 'server', 'bot', 'guest', 'invitado', 'support', 'soporte', 'root', 'null', 'undefined', 'anonymous',
  'turbogol', 'equipo', 'team', 'dev', 'developer', 'desarrollador', 'owner', 'mantenedor', 'maintainer', 'help', 'ayuda', 'anonimo',
];
/** Skeletons a name may not start with: it would read as a guest, a bot, the game or its staff ('Invitado4821', 'B0t', 'Soporte_TG'). */
const RESERVED_PREFIXES = ['guest', 'invitado', 'bot', 'turbogol', 'admin', 'staff', 'soporte', 'support', 'moderador', 'moderator', 'sistema', 'system', 'oficial', 'official', 'server', 'servidor'];
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
  | 'usernameDomain'
  | 'passwordShort'
  | 'passwordLong'
  | 'passwordCommon'
  | 'passwordHasUsername'
  | 'passwordHasEmail'
  | 'passwordRepeated';

export interface AccountIssue {
  code: AccountIssueCode;
  /** { min, max } for usernameLength, { count } for passwordShort / passwordLong. */
  params?: Record<string, number>;
}

/**
 * A name that reads as a web address: 'www.' first, or a last '.label' of two or more letters
 * ('tg-verify.com', 'www.x.gg'). Such a name could pass for a link to another site in a lobby, the
 * leaderboard or a mail. 'jv.77' and 'ana.b' are not refused.
 */
export function looksLikeDomain(name: string): boolean {
  return /^www\./i.test(name) || /\.[a-z]{2,}$/i.test(name);
}

let reservedSkeletons: { words: Set<string>; prefixes: string[] } | null = null;

/** RESERVED_WORDS and RESERVED_PREFIXES as skeletons ('turbogol' reads 'turbogoi'), made once. */
function reserved(): { words: Set<string>; prefixes: string[] } {
  reservedSkeletons ??= { words: new Set(RESERVED_WORDS.map(wordSkeleton)), prefixes: RESERVED_PREFIXES.map(wordSkeleton) };
  return reservedSkeletons;
}

/**
 * The name reads as a guest, a bot, the game or its staff (the sign-in design, section 5.2), by its
 * skeleton (nameSkeleton): it starts with a reserved prefix ('Invitado4821', 'lnvitado', 'B0t'), it
 * is a reserved word ('Adm1n', 'R00t', 'Turb0G0l') or one of its parts is ('Ana_Admin', 'Soporte_TG').
 */
export function isReservedName(name: string): boolean {
  const r = reserved();
  const skel = nameSkeleton(name);
  if (r.words.has(skel) || r.prefixes.some((p) => skel.startsWith(p))) return true;
  return usernameKey(name)
    .split(/[_.-]+/)
    .filter((part) => part.length > 0)
    .some((part) => r.words.has(wordSkeleton(part)));
}

/**
 * Null when `name` is a valid username: 3-16 chars of ASCII letters, digits, '_', '-', '.', starting
 * with a letter or digit, not shaped like a web address (looksLikeDomain), not reserved by its
 * skeleton (isReservedName: 'guest…', 'invitado…' (a guest's name is the server's 'Invitado 4821',
 * src/net/guestName.ts), 'bot…', the game's and the staff's words, their look-alikes). Otherwise what
 * is wrong with it. Checked on sign-up and rename only: a name taken before a rule existed stays
 * until its owner renames.
 */
export function usernameIssue(name: unknown): AccountIssue | null {
  if (typeof name !== 'string') return { code: 'usernameMissing' };
  if (name.length < USERNAME_MIN || name.length > USERNAME_MAX) return { code: 'usernameLength', params: { min: USERNAME_MIN, max: USERNAME_MAX } };
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) return { code: 'usernameChars' };
  if (looksLikeDomain(name)) return { code: 'usernameDomain' };
  if (isReservedName(name)) return { code: 'usernameReserved' };
  return null;
}

/** Whose password it is: its username, and its email once it has one (a string is the username alone, as before). */
export type PasswordOwner = string | { username?: string; email?: string };

/**
 * Null when `pw` is acceptable for its owner; otherwise what is wrong with it: 8 to 128
 * characters, not on the common list, not one repeated character, not holding the username, nor
 * the email's local part (without its +tag) when that part has 4 characters or more.
 */
export function passwordIssue(pw: unknown, owner: PasswordOwner = ''): AccountIssue | null {
  if (typeof pw !== 'string' || pw.length < PASSWORD_MIN) return { code: 'passwordShort', params: { count: PASSWORD_MIN } };
  if (pw.length > PASSWORD_MAX) return { code: 'passwordLong', params: { count: PASSWORD_MAX } };
  const k = pw.toLowerCase();
  if (WEAK_PASSWORDS.has(k)) return { code: 'passwordCommon' };
  const username = typeof owner === 'string' ? owner : (owner.username ?? '');
  if (username.length > 0 && k.includes(usernameKey(username))) return { code: 'passwordHasUsername' };
  // The local part as typed (its +tag dropped) and as its canon reads it (a Gmail address without its dots).
  const locals = typeof owner === 'string' ? [] : [normalizeEmail(owner.email), emailCanon(owner.email)].map((e) => (e === null ? '' : e.slice(0, e.indexOf('@')).split('+')[0]));
  if (locals.some((local) => local.length >= 4 && k.includes(local))) return { code: 'passwordHasEmail' };
  if (/^(.)\1+$/.test(pw)) return { code: 'passwordRepeated' };
  return null;
}

/** Spanish text of each issue: the server's bad_username message (the client shows account.issue.* texts). */
const ISSUE_SPANISH: Readonly<Record<AccountIssueCode, string>> = {
  usernameMissing: 'Elige un nombre de usuario',
  usernameLength: `El usuario tiene que tener entre ${USERNAME_MIN} y ${USERNAME_MAX} caracteres`,
  usernameChars: 'Usa solo letras, números, "_", "-" o "." (empezando con letra o número)',
  usernameReserved: 'Ese nombre está reservado',
  usernameDomain: 'El usuario no puede parecer una dirección web (como "nombre.com")',
  passwordShort: `La contraseña tiene que tener al menos ${PASSWORD_MIN} caracteres`,
  passwordLong: `La contraseña puede tener hasta ${PASSWORD_MAX} caracteres`,
  passwordCommon: 'Esa contraseña es demasiado común',
  passwordHasUsername: 'La contraseña no puede contener tu usuario',
  passwordHasEmail: 'La contraseña no puede contener tu correo',
  passwordRepeated: 'La contraseña no puede ser un solo carácter repetido',
};

/** usernameIssue as a Spanish message (the Worker sends it as the bad_username message), null when valid. */
export function usernameProblem(name: unknown): string | null {
  const issue = usernameIssue(name);
  return issue === null ? null : ISSUE_SPANISH[issue.code];
}

/** passwordIssue as a Spanish message, null when acceptable. */
export function passwordProblem(pw: unknown, owner: PasswordOwner): string | null {
  const issue = passwordIssue(pw, owner);
  return issue === null ? null : ISSUE_SPANISH[issue.code];
}

function hex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return s;
}

/** PBKDF2-SHA256(NFKC(password), salt, CLIENT_KDF_ITERATIONS) as 64 hex chars. ~0.1-0.3 s in a browser. */
async function clientKdf(password: string, salt: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: CLIENT_KDF_ITERATIONS }, key, 256);
  return hex(new Uint8Array(bits));
}

/**
 * The current client key (the sign-in design's v2, users.pw_v 2): PBKDF2-SHA256(NFKC(password),
 * CLIENT_KDF_SALT_V2, CLIENT_KDF_ITERATIONS). What every request that sets a password stores.
 */
export function passwordKey(password: string): Promise<string> {
  return clientKdf(password, CLIENT_KDF_SALT_V2);
}

/**
 * The legacy client key (users.pw_v 1): PBKDF2-SHA256(NFKC(password), 'turbogol/account/v1/' +
 * usernameKey, CLIENT_KDF_ITERATIONS). Only to prove a password set before the current key (the
 * legacy sign-in, its recovery, "confirm it's you", a password change or a rename of such an
 * account), always sent with passwordKey of the same password so the server re-keys it.
 */
export function legacyPasswordKey(username: string, password: string): Promise<string> {
  return clientKdf(password, CLIENT_KDF_SALT_PREFIX + usernameKey(username));
}

/** legacyPasswordKey's name of before (the server's tests and scripts still call it so). */
export const clientPasswordKey = legacyPasswordKey;

export function isClientKey(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
}

// ---- email addresses (the sign-in design, section 1.4) ---------------------------------------------
//
// The Worker and the client import these same functions, and server/test/accounts-migrate.test.mjs
// pins a table of vectors: changing a rule later would split one person's address into two
// accounts, or merge two people's. The Worker always derives the address and its canon from what
// was typed (I9); no request ever carries a canon.

export const EMAIL_MAX = 254;
const EMAIL_LOCAL_MAX = 64;
const EMAIL_LABEL_MAX = 63;
/** An unquoted local part: RFC 5322 atext and dots, never a leading, trailing or doubled dot. */
const EMAIL_LOCAL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
/** One DNS label: letters, digits and '-', never at either end. */
const EMAIL_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
/** A top-level domain: letters, or an IDN's punycode. */
const EMAIL_TLD_RE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
/** Top-level domains that never receive mail (RFC 2606, RFC 6761). */
const EMAIL_DEAD_TLDS = new Set(['invalid', 'test', 'example', 'localhost']);

/**
 * The address as the account keeps it, or null when it is not one we can mail: trimmed, lowercased,
 * at most EMAIL_MAX characters, exactly one '@'; a local part of 1-64 printable ASCII characters
 * (atext and single inner dots: no spaces, quotes, '\' or the specials ( ) , : ; < > [ ]); a domain
 * of ASCII labels (letters, digits, inner '-', at most 63 each) with at least one dot. An IDN must be
 * typed in punycode (xn--), and the top-level domains invalid, test, example and localhost are refused.
 */
export function normalizeEmail(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (s.length === 0 || s.length > EMAIL_MAX || !/^[\x21-\x7e]+$/.test(s)) return null;
  const at = s.indexOf('@');
  if (at < 1 || at !== s.lastIndexOf('@')) return null;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  if (local.length > EMAIL_LOCAL_MAX || !EMAIL_LOCAL_RE.test(local)) return null;
  const labels = domain.split('.');
  if (labels.length < 2 || labels.some((l) => l.length === 0 || l.length > EMAIL_LABEL_MAX || !EMAIL_LABEL_RE.test(l))) return null;
  const tld = labels[labels.length - 1];
  if (!EMAIL_TLD_RE.test(tld) || EMAIL_DEAD_TLDS.has(tld)) return null;
  return s;
}

/**
 * The canonical key of an address (users.email_canon, the one-account-per-email rule), or null when
 * `email` is not an address (normalizeEmail): the '+tag' dropped from the local part, googlemail.com
 * read as gmail.com, and for gmail.com the dots of the local part removed.
 * 'Ana.Perez+tg@GoogleMail.com' -> 'anaperez@gmail.com'. A local part that starts with '+' keeps it all.
 */
export function emailCanon(email: unknown): string | null {
  const n = normalizeEmail(email);
  if (n === null) return null;
  const at = n.indexOf('@');
  let local = n.slice(0, at);
  let domain = n.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return local + '@' + domain;
}

/**
 * An address with its local part hidden but for its first characters (at most 2, never half of it):
 * 'ana.perez@gmail.com' -> 'an***@gmail.com'. Only for mail sent to another address (the design's
 * M6); a screen the person owns shows the full address. '' for something that is not an address.
 */
export function maskEmail(email: unknown): string {
  const n = normalizeEmail(email);
  if (n === null) return '';
  const at = n.indexOf('@');
  const local = n.slice(0, at);
  return local.slice(0, Math.min(2, Math.floor(local.length / 2))) + '***' + n.slice(at);
}

/** Common typos of the big providers' domains, and what was meant. */
const EMAIL_TYPOS: Readonly<Record<string, string>> = {
  'gmial.com': 'gmail.com',
  'gmal.com': 'gmail.com',
  'gmai.com': 'gmail.com',
  'gamil.com': 'gmail.com',
  'gnail.com': 'gmail.com',
  'gmail.con': 'gmail.com',
  'gmail.co': 'gmail.com',
  'gmail.cm': 'gmail.com',
  'hotmial.com': 'hotmail.com',
  'hotmal.com': 'hotmail.com',
  'hotmail.con': 'hotmail.com',
  'outlok.com': 'outlook.com',
  'outlook.con': 'outlook.com',
  'yahoo.con': 'yahoo.com',
  'yaho.com': 'yahoo.com',
};

/**
 * The client only (the sign-up form's "Did you mean …?"): the address with a common domain typo
 * fixed ('ana@gmial.com' -> 'ana@gmail.com'), or null when there is nothing to suggest.
 */
export function emailTypo(email: unknown): string | null {
  const n = normalizeEmail(email);
  if (n === null) return null;
  const at = n.indexOf('@');
  const fix = EMAIL_TYPOS[n.slice(at + 1)];
  return fix === undefined ? null : n.slice(0, at + 1) + fix;
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
  /**
   * The car this session seats the account with online (src/net/cosmetics.ts): the one it picked
   * while it owns it, else the default car. Absent from servers before cars: the default car.
   */
  car?: CarId;
  /** A TV signed in with the phone: a limited scope (no credential, link, redeem or device changes there). */
  tv?: true;
  /** When this device last proved a credential (ms): a sign-in or a re-authentication. Absent = never (a TV). */
  authAt?: number;
  /**
   * That proof's level (the session's aal, the sign-in design's R6): 2 a typed password, 1 a press
   * on the provider's page. Absent = 0, nothing proved: the routes that need a level ask first.
   */
  authLvl?: 1 | 2;
}

/** One signed-in device of the account (GET /api/auth/sessions): PERFIL's device list. */
export interface DeviceSession {
  /** Opaque: POST /api/auth/sessions/revoke { id }. */
  id: string;
  kind: 'web' | 'tv';
  /** When the device signed in, and when it last renewed its session (ms). */
  signedInAt: number;
  lastUsedAt: number;
  /** Where it signed in (ISO country code, city), when known. */
  country: string | null;
  city: string | null;
  /** This browser. */
  current: boolean;
}

export interface SessionsAnswer {
  sessions: DeviceSession[];
}

// ---- the email accounts (sign-in PR 7: server/src/accountRoutes.ts "email accounts") ------------------
//
// Every code and link answer is the same for any address (I6). `attempt` binds a code to the browser
// that started (keep it in sessionStorage, never localStorage: I5). A refused name's 409 carries a
// free `suggest`. Errors are { error, message } with these codes: bad_email, code_wrong { triesLeft },
// code_expired, link_invalid, already_created { email }, email_taken, name_reserved / username_taken /
// name_lookalike { suggest }, email_rate_limited / rate_limited { retryAfterMs }, email_paused,
// email_unconfigured, email_required, no_password, password_required, gone.

/** POST /api/auth/signup/start; POST /api/auth/reauth/code adds `to` (the account's own address). */
export interface CodeStartAnswer {
  attempt: string;
  /** When REENVIAR may be pressed (server ms). */
  resendAt: number;
  codeLength?: 6;
  to?: string;
}

/** POST /api/auth/signup/check: the address the code or the link proves. */
export interface SignupCheckAnswer {
  email: string;
}

/** POST /api/auth/code/resend: the same code and link went again. */
export interface CodeResendAnswer {
  resendAt: number;
  resendsLeft: number;
}

/** POST /api/auth/reset/peek: who a reset link is for ("create" when the account has no password). */
export interface ResetPeekAnswer {
  name: string;
  email: string;
  hasPassword: boolean;
}

/** POST /api/me/password/link: where the link went. */
export interface PasswordLinkAnswer {
  sentTo: string;
}

export interface RegisterAnswer extends AccountSession {
  /** Shown once: each one resets the password (POST /api/auth/recover) when it is forgotten. */
  recoveryCodes: string[];
}

/**
 * POST /api/auth/tv/start (a TV signing in with the phone): the code the TV shows, the device
 * secret only the TV holds (it polls with it), when the code expires (the server's epoch ms), its
 * life from now (`ttlMs`: what the TV counts down on its own clock, which can be minutes off the
 * server's) and how often to poll.
 */
export interface TvStartAnswer {
  code: string;
  secret: string;
  expiresAt: number;
  ttlMs: number;
  pollMs: number;
}

/**
 * POST /api/auth/tv/info: where the TV showing a code is (Cloudflare's view of its start: country
 * code, city, network name, each null when unknown), whether the phone asking is on its network
 * (the same address or IPv6 /64) or in its country, and when the code was made (server ms).
 */
export interface TvInfoAnswer {
  where: { country: string | null; city: string | null; asn: number | null; org: string | null } | null;
  sameNetwork: boolean;
  sameCountry: boolean;
  createdAt: number;
}

/** POST /api/auth/tv/poll: still waiting for the phone, or the session (and the refresh cookie) as a sign-in gives. */
export type TvPollAnswer = { state: 'pending' } | (AccountSession & { state: 'approved' });

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
  /** When each linked provider was linked (ms); absent for a link from before it was kept. Absent from older servers. */
  linkedAt?: Partial<Record<OAuthProvider, number>>;
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
  // The sign-in work (the design's data model): every field below is absent from older servers.
  /** The account's verified address (normalizeEmail), where its mail goes; null: none. */
  email?: string | null;
  /** A provider's address that is not proved (Discord's, or a Google address that is not authoritative): it prefills "confirm your email"; null: none. */
  emailHint?: string | null;
  /** The account has a verified address (`email` is set). */
  emailVerified?: boolean;
  /** Its password is still the legacy key, salted with the username: the next password sign-in or "confirm it's you" re-keys it. */
  legacy?: boolean;
  /** The newest news consent is a grant (news by email, never by default). */
  news?: boolean;
  /** A deletion was asked: the account is purged at this time (ms); 0 = none. */
  deletionAt?: number;
  /** How many ways in it has: Google, Discord, and a password while it can still sign in with one. */
  waysIn?: number;
  /** Only for the project's maintainer accounts (NODE_TRUSTED_OPERATORS): PERFIL's checklist. */
  maintainer?: { password: boolean; verifiedEmail: boolean; waysIn: number };
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

/**
 * Cyrillic and Greek letters that read as Latin ones (lowercase: a capital is lowered first, so
 * 'Ѕ' and 'Τ' come through 'ѕ' and 'τ'): what a lobby title looks like, not what it spells.
 */
const LOOKALIKE: Readonly<Record<string, string>> = {
  а: 'a', в: 'b', е: 'e', ё: 'e', і: 'i', ї: 'i', ј: 'j', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', ѕ: 's', ԁ: 'd', ӏ: 'l', ɡ: 'g', ı: 'i',
  α: 'a', β: 'b', ε: 'e', ι: 'i', κ: 'k', μ: 'm', ν: 'n', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ϲ: 'c',
};
/** Digits and letters that stand in for others (0→o 1→i l→i 3→e 4→a 5→s 7→t 8→b). */
const STAND_IN: Readonly<Record<string, string>> = { '0': 'o', '1': 'i', l: 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b' };

/** NFKC, accents dropped, lowercase, the look-alikes as the Latin letter they read as. */
function foldLookalikes(s: string): string {
  return s
    .normalize('NFKC')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/./gsu, (ch) => LOOKALIKE[ch] ?? ch);
}

/** A word's skeleton: the stand-ins mapped, then rn→m and vv→w ('Adm1n' and 'admin' are one). */
function wordSkeleton(word: string): string {
  return word
    .replace(/./gsu, (ch) => STAND_IN[ch] ?? ch)
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w');
}

/**
 * A username's skeleton (the sign-in design, section 5.2): lowercase, '_' '.' '-' dropped, the
 * stand-ins mapped (0→o 1→i l→i 3→e 4→a 5→s 7→t 8→b), then rn→m and vv→w. 'Adm1n' and 'admin',
 * 'lnvitado' and 'invitado', 'Juan_1' and 'Juani' share one. What a name looks like, for the
 * look-alike checks of names that imitate the project's accounts or the top of a leaderboard.
 */
export function nameSkeleton(name: string): string {
  return wordSkeleton(usernameKey(name).replace(/[_.-]/g, ''));
}

/** A title's words, folded (letters and digits; spaces and _ . - ! ? # separate them). */
function titleWords(title: string): string[] {
  return foldLookalikes(title)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0)
    .map(wordSkeleton);
}

/** Words a lobby title may not hold: it would read as the game's staff or as official. */
const STAFF_WORDS = new Set(['admin', 'soporte', 'support', 'staff', 'moderador', 'moderator', 'oficial', 'official'].map(wordSkeleton));
const GAME_SKELETON = wordSkeleton('turbogol');

/**
 * Why a lobby title is refused for everyone (null: allowed), after sanitizeLobbyName: 'name_reserved'
 * when it reads as a guest's name ('Invitado 4821', 'Guest 4821': a guest's lobby carries that
 * name, src/net/guestName.ts), as the game ('Turbogol', 'Turbo Gol', 'T0rb0g0l', Cyrillic look-alikes)
 * or with a word of the staff ('Soporte', 'Ѕoporte', 'Adm1n', 'Sala oficial'). Folded: accents
 * dropped, Cyrillic and Greek look-alikes as Latin letters, the digit stand-ins mapped. The server's
 * own default title (the host's name) is never checked (server/src/LobbyDO.ts). A title holding a
 * web address ('tg-verify.com', 'www.x.gg', 'https://…', folded the same way) is refused too.
 */
export function lobbyNameIssue(title: string): 'name_reserved' | null {
  if (/^(?:invitado|guest)\s*\d+$/.test(foldLookalikes(title).trim())) return 'name_reserved';
  const tokens = foldLookalikes(title).split(/\s+/);
  if (tokens.some((tok) => tok.includes('://') || looksLikeDomain(tok.replace(/[^\p{L}\p{N}]+$/u, '')))) return 'name_reserved';
  const words = titleWords(title);
  if (words.join('').includes(GAME_SKELETON)) return 'name_reserved';
  if (words.some((w) => STAFF_WORDS.has(w))) return 'name_reserved';
  return null;
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
  /** The car the member's seat drives (its session's when it came in); absent: the default car. */
  car?: CarId;
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
