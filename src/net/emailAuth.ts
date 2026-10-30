/**
 * The pure part of email accounts in the browser (sign-in PR 8, the sign-in design's §3.0 to §3.7
 * and §4.3; the routes are PR 7's, server/src/accountRoutes.ts "email accounts"). No DOM, no i18n:
 * AccountClient keeps what these read and write, PERFIL and the /account sheets
 * (src/ui/screens/profile.ts, accountLinks.ts) show it. Unit-tested in tests/account-client.test.mjs
 * and tests/menu-accounts.test.mjs.
 *
 * What a browser keeps (I5: never a code, a password or its key; a token only until its POST is done):
 * - sessionStorage ATTEMPT_KEY `{ attempt, purpose, email, resendAt, at }`, ATTEMPT_MS at most: the
 *   sign-up's code step comes back after a reload (a phone that dropped the tab while its owner read
 *   the mail). The attempt id is what binds a code to this browser; the address is the one typed here.
 * - sessionStorage LINK_KEY `{ kind, token, at }`: a mailed link's token, from the moment the page
 *   took it out of the URL until its POST settled, so a slow first load can try again.
 * - localStorage LAST_SIGN_IN_KEY `{ name, method }`: "Continue as Ana · Discord" on the sign-in tab
 *   (a per-device convenience; never the address).
 */
import { STORAGE_PREFIX } from '../brand';
import { normalizeEmail } from './account';
import type { OAuthProvider } from './account';

/** Session storage keys (the design's §3.0). */
export const ATTEMPT_KEY = STORAGE_PREFIX + 'auth.attempt';
export const LINK_KEY = STORAGE_PREFIX + 'auth.link';
/** Local storage: the last way this device signed in. */
export const LAST_SIGN_IN_KEY = STORAGE_PREFIX + 'lastSignIn';
/** A sign-up attempt is kept this long (the server's code lives 15 minutes past a resend, 60 at most; 30 is the design's). */
export const ATTEMPT_MS = 30 * 60_000;
/** A link's token waits this long for its POST (the reset link itself lives an hour on the server). */
export const LINK_MS = 60 * 60_000;
/** The code's length (CodeStartAnswer.codeLength). */
export const CODE_LENGTH = 6;
/** REENVIAR's wait when the server's clock and this one disagree (the server's own is 60 s). */
export const RESEND_MS = 60_000;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function read(store: Store | null, key: string): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(store: Store | null, key: string, value: string | null): void {
  try {
    if (value === null) store?.removeItem(key);
    else store?.setItem(key, value);
  } catch {
    /* private mode, storage off: it lasts this page */
  }
}

// ---- the sign-up attempt -------------------------------------------------------------------------------

/** A sign-up started in this browser (signup/start's answer and the address typed). */
export interface StoredAttempt {
  attempt: string;
  purpose: 'signup';
  /** The address as normalizeEmail gives it. */
  email: string;
  /** When REENVIAR may be pressed, on this browser's clock (ms). */
  resendAt: number;
  /** When it started, on this browser's clock (ms). */
  at: number;
}

/** A kept attempt (its JSON), null when there is none, it is stale, from the future or malformed. */
export function attemptOf(raw: string | null, now: number): StoredAttempt | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof StoredAttempt, unknown>>;
    if (typeof v.attempt !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(v.attempt) || v.purpose !== 'signup') return null;
    const email = normalizeEmail(v.email);
    if (email === null || typeof v.at !== 'number' || typeof v.resendAt !== 'number') return null;
    if (now - v.at > ATTEMPT_MS || v.at > now + 60_000) return null;
    return { attempt: v.attempt, purpose: 'signup', email, resendAt: v.resendAt, at: v.at };
  } catch {
    return null;
  }
}

export function readAttempt(store: Store | null, now: number): StoredAttempt | null {
  return attemptOf(read(store, ATTEMPT_KEY), now);
}

export function keepAttempt(store: Store | null, a: StoredAttempt | null): void {
  write(store, ATTEMPT_KEY, a === null ? null : JSON.stringify(a));
}

/**
 * When REENVIAR may be pressed on this browser's clock: the server's `resendAt` is on its own clock,
 * which can be minutes off this one (a TV's, a phone's), so a wait that does not read as the
 * server's minute or less is the server's minute from now.
 */
export function localResendAt(serverResendAt: number, now: number): number {
  const wait = serverResendAt - now;
  return wait >= 0 && wait <= 2 * RESEND_MS ? now + wait : now + RESEND_MS;
}

/** A typed or pasted code as the server reads it: its digits only (spaces and dashes of a paste dropped), CODE_LENGTH at most. */
export function cleanCode(v: string): string {
  return v.replace(/\D/g, '').slice(0, CODE_LENGTH);
}

// ---- the mailed links (/account#<kind>=<token>, the design's §4.3) ------------------------------------

/** The kinds a mail links to; `forgot` carries no token. */
export type LinkKind = 'verify' | 'email' | 'reset' | 'undo' | 'keep' | 'unsub' | 'forgot';
const LINK_KINDS: readonly LinkKind[] = ['verify', 'email', 'reset', 'undo', 'keep', 'unsub', 'forgot'];

export interface AccountLink {
  kind: LinkKind;
  /** The link's token (43 base64url characters from a mail), null for `forgot`. */
  token: string | null;
}

/** The SPA path the mails link to. */
export function isAccountPath(pathname: string): boolean {
  return /^\/account\/?$/.test(pathname);
}

/**
 * The link on this page: `/account#<kind>=<token>` or `/account#forgot`, null for any other page or
 * fragment. A token is base64url of 16 to 128 characters (the server's tokenOf takes up to 128).
 */
export function parseAccountLink(pathname: string, hash: string): AccountLink | null {
  if (!isAccountPath(pathname)) return null;
  if (/^#forgot$/.test(hash)) return { kind: 'forgot', token: null };
  const m = /^#([a-z]+)=([A-Za-z0-9_-]{16,128})$/.exec(hash);
  if (m === null || !LINK_KINDS.includes(m[1] as LinkKind) || m[1] === 'forgot') return null;
  return { kind: m[1] as LinkKind, token: m[2] };
}

interface StoredLink extends AccountLink {
  at: number;
}

/** A kept link (its JSON) that still waits for its POST, null when none, stale or malformed. */
export function linkOf(raw: string | null, now: number): AccountLink | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof StoredLink, unknown>>;
    if (typeof v.at !== 'number' || now - v.at > LINK_MS || v.at > now + 60_000) return null;
    if (typeof v.kind !== 'string' || !LINK_KINDS.includes(v.kind as LinkKind) || v.kind === 'forgot') return null;
    if (typeof v.token !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(v.token)) return null;
    return { kind: v.kind as LinkKind, token: v.token };
  } catch {
    return null;
  }
}

export function readLink(store: Store | null, now: number): AccountLink | null {
  return linkOf(read(store, LINK_KEY), now);
}

export function keepLink(store: Store | null, link: AccountLink | null, now: number): void {
  write(store, LINK_KEY, link === null || link.token === null ? null : JSON.stringify({ kind: link.kind, token: link.token, at: now } satisfies StoredLink));
}

/**
 * The refusals after which a link's token is spent or dead, so it is dropped from storage: the
 * server says so (link_invalid, code_expired), its account exists already (already_created,
 * email_taken), it may never sign in (banned), or the route is gone. A name refused, a password
 * refused, a throttle, a 5xx or no network keep it: the same link can be sent again.
 */
export const DEAD_LINK_CODES: ReadonlySet<string> = new Set(['link_invalid', 'code_expired', 'already_created', 'email_taken', 'banned', 'gone', 'bad_request']);

// ---- the sign-in field: an address, or a username of before (the design's §3.3) ----------------------

/** The cutoff phase of the username sign-in (GET /api/config auth.legacy.phase, sign-in PR 9; absent: none). */
export type LegacyPhase = 'none' | 'grace' | 'closed';

export type SignInRoute =
  /** POST /api/auth/signin. */
  | { kind: 'email'; email: string }
  /** POST /api/auth/login (both keys of the password). */
  | { kind: 'legacy'; username: string }
  /** No request: usernames no longer sign in (legacy_closed). */
  | { kind: 'closed' }
  /** Something with an '@' that is no address. */
  | { kind: 'bad_email' }
  | { kind: 'empty' };

/** Where "Correo o usuario" goes: an '@' is an address, anything else a username while the legacy sign-in lasts. */
export function signInRoute(identity: string, phase: LegacyPhase): SignInRoute {
  const v = identity.trim();
  if (v.length === 0) return { kind: 'empty' };
  if (v.includes('@')) {
    const email = normalizeEmail(v);
    return email === null ? { kind: 'bad_email' } : { kind: 'email', email };
  }
  return phase === 'closed' ? { kind: 'closed' } : { kind: 'legacy', username: v };
}

// ---- the last sign-in on this device (the design's §3.0) ---------------------------------------------

export type SignInMethod = 'email' | OAuthProvider;

export interface LastSignIn {
  name: string;
  method: SignInMethod;
}

export function lastSignInOf(raw: string | null): LastSignIn | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as { name?: unknown; method?: unknown };
    if (typeof v.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/.test(v.name)) return null;
    if (v.method !== 'email' && v.method !== 'google' && v.method !== 'discord') return null;
    return { name: v.name, method: v.method };
  } catch {
    return null;
  }
}

export function readLastSignIn(store: Store | null): LastSignIn | null {
  return lastSignInOf(read(store, LAST_SIGN_IN_KEY));
}

export function keepLastSignIn(store: Store | null, v: LastSignIn): void {
  write(store, LAST_SIGN_IN_KEY, JSON.stringify({ name: v.name, method: v.method } satisfies LastSignIn));
}

// ---- providers in the copy (the design's §3.0) ---------------------------------------------------------

const PROVIDER_NAMES: Readonly<Record<OAuthProvider, string>> = { google: 'Google', discord: 'Discord' };

/** "Discord", "Google o Discord": the configured providers in the copy's order (`or` is the language's word). */
export function providersText(list: readonly OAuthProvider[], or: string): string {
  const names = (['google', 'discord'] as const).filter((p) => list.includes(p)).map((p) => PROVIDER_NAMES[p]);
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} ${or} ${names[names.length - 1]}`;
}

/**
 * A browser inside another app (Discord, Instagram, Facebook, TikTok, Line): Google refuses to sign
 * in there (disallowed_useragent), so the menus hide its button and say to open the page in a browser.
 */
export function inAppBrowser(userAgent: string): boolean {
  return /\b(?:Discord|Instagram|FBAN|FBAV|FB_IAB|TikTok|musical_ly|BytedanceWebview|Line)\//i.test(userAgent);
}

// ---- the in-game name a new account starts with (the design's §3.1, §5.1) ----------------------------

/**
 * 'Jugador4821' / 'Player4821': the language's word and the guest's four digits when the page has
 * them (else four of `random`), never from the address. `valid` is the username rule (usernameIssue
 * === null): a name it refuses gets new digits, then the English word.
 */
export function signupNamePrefill(word: string, guestDigits: string | null, valid: (name: string) => boolean, random: () => number = Math.random): string {
  const digits = (): string => String(1000 + Math.floor(random() * 9000));
  for (const name of [word + (guestDigits !== null && /^\d{4}$/.test(guestDigits) ? guestDigits : digits()), word + digits(), 'Player' + digits()]) if (valid(name)) return name;
  return 'Player1000';
}
