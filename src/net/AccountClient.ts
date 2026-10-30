/**
 * Browser side of registered accounts (server/src/accountRoutes.ts): email accounts (sign-in PR 8:
 * a sign-up proved by a mailed code or link, the email sign-in, forgot and reset, the password by
 * its owner: the section "email accounts" at the end of the class), the legacy sign-in with a
 * username and its recovery code (a password is turned into client keys here and never sent: the
 * current passwordKey, and the legacyPasswordKey of before wherever a stored legacy password is
 * proved, so the server re-keys it), each anonymous request with a solved Turnstile check (antiBot),
 * Google / Discord sign-in (a full-page redirect; the server answers back to `/#auth=<result>`),
 * the short Bearer session (1 h) refreshed from the HttpOnly refresh cookie, the profile (/api/me:
 * ratings per playlist, ranked ban, the experimental switch), the leaderboard, the rating change of
 * a ranked match, the account's training records (/api/me/training), its experimental switch
 * and physics presets (/api/me/experimental, /api/me/presets: src/game/experimentalStore.ts), a
 * TV's sign-in with the phone (/api/auth/tv/*: the TV starts and polls, the phone confirms), and
 * its cars and the hosts' shop (/api/me/items, /api/me/car, /api/me/shop, /api/me/shop/claim:
 * src/game/garage.ts). The session carries the car the account drives online (`car`); picking
 * another hands back a fresh session, adopted like a rename's.
 *
 * Persistence: the refresh token is an HttpOnly cookie the page cannot read; localStorage only keeps
 * a hint (ACCOUNT_HINT_KEY: "this browser was signed in as X", `{ name, id }`) so a guest's page
 * load does not spend a refresh request, and so the boot knows whose experimental switch to read
 * before the account is restored (main.ts; a hint from before the id counts as nobody's). NetClient
 * asks `sessionForQueue()` before using its guest session: a signed-in player queues, joins lobbies
 * and plays under the account. Every change reaches each `subscribe`r (the menus, the Game).
 *
 * Errors reject with AccountError, its message already the player's text: a server error code by
 * its error.account.* text (serverText, src/i18n.ts), else the server's message, else
 * error.server with the status; a username / password refused here by its account.issue.* text.
 *
 * The HTTP implementation is injectable for node tests (tests/account-client.test.mjs).
 */
import { legacyPasswordKey, normalizeEmail, passwordIssue, passwordKey, usernameIssue } from './account';
import type { AccountIssue, AccountSession, CodeResendAnswer, CodeStartAnswer, DeviceSession, EmailConfirmAnswer, ExperimentalAnswer, LeaderboardAnswer, MeInfo, MyNode, OAuthProvider, PasswordLinkAnswer, Playlist, RankedResultAnswer, ResetPeekAnswer, SignupCheckAnswer, TvInfoAnswer, TvPollAnswer, TvStartAnswer, UndoPeekAnswer } from './account';
import { DEAD_LINK_CODES, keepAttempt, keepLastSignIn, keepLink, localResendAt, pageStore, readAttempt, readLastSignIn, readLink } from './emailAuth';
import type { AccountLink, LastSignIn, LegacyPhase, StoredAttempt } from './emailAuth';
import type { FetchLike, ResponseLike, StorageLike } from './NetClient';
import { claimAnswerOf, itemsAnswerOf, shopAnswerOf } from './cosmetics';
import type { ClaimAnswer, ItemsAnswer, ShopAnswer } from './cosmetics';
import { STORAGE_PREFIX } from '../brand';
import { isCarId, type CarId } from '../game/cosmetics';
import { MAX_PRESETS, parsePresetList } from '../game/physicsRules';
import type { StoredPreset } from '../game/physicsRules';
import { parseTrainingRecords } from '../game/trainingRecords';
import type { TrainingRecords } from '../game/trainingRecords';
import { language, serverText, t } from '../i18n';

export const ACCOUNT_HINT_KEY = STORAGE_PREFIX + 'account';
/** Refresh when less than this is left on the Bearer session. */
const REFRESH_MARGIN_MS = 2 * 60_000;
/**
 * A ranked match on a community node is rated only after the control plane re-simulated its
 * replay: once the fast polls run out, waitRankedResult asks this often, up to this long after
 * its first poll.
 */
const NODE_RESULT_EVERY_MS = 3000;
const NODE_RESULT_MAX_WAIT_MS = 120_000;

/** The fields of a refusal besides its code (the email routes of sign-in PR 7). */
export interface AccountErrorDetail {
  /** code_wrong: the tries this code has left. */
  triesLeft?: number;
  /** username_taken, name_lookalike, name_reserved: a free name near the one asked for (the form puts it in the field). */
  suggest?: string;
  /** already_created: the address whose account exists (the sign-in tab opens with it). */
  email?: string;
  /** deletion_pending (sign-in PR 12): when the account is purged (ms); the sign-in sent again with cancelDeletion calls it off. */
  purgeAt?: number;
}

/** A password sign-in's options (signIn, legacySignIn). */
export interface SignInOptions {
  /** The player answered "cancel the deletion?" (deletion_pending): the sign-in calls the account's pending deletion off (sign-in PR 12). */
  cancelDeletion?: boolean;
}

/** A refusal's detail from its body (each field only when it has its shape). */
function detailOf(b: { triesLeft?: unknown; suggest?: unknown; email?: unknown; purgeAt?: unknown }): AccountErrorDetail {
  const d: AccountErrorDetail = {};
  if (typeof b.triesLeft === 'number' && Number.isInteger(b.triesLeft) && b.triesLeft >= 0) d.triesLeft = b.triesLeft;
  if (typeof b.suggest === 'string' && usernameIssue(b.suggest) === null) d.suggest = b.suggest;
  if (typeof b.email === 'string' && normalizeEmail(b.email) !== null) d.email = b.email;
  if (typeof b.purgeAt === 'number' && Number.isFinite(b.purgeAt) && b.purgeAt > 0) d.purgeAt = b.purgeAt;
  return d;
}

/** The player's text for a refusal whose detail it names (the tries left, the free name), null for the code's own text. */
function detailText(code: string, d: AccountErrorDetail): string | null {
  if (code === 'code_wrong' && d.triesLeft !== undefined) return t('auth.codeWrong', { count: d.triesLeft });
  if (d.suggest === undefined) return null;
  if (code === 'username_taken') return t('auth.signupNameTaken', { name: d.suggest });
  if (code === 'name_lookalike') return t('account.issue.usernameLookalike', { name: d.suggest });
  if (code === 'name_reserved') return t('auth.signupNameReserved', { name: d.suggest });
  return null;
}

/**
 * `e` with the text of where it was asked when its code is `code` (one code, a text per form: the
 * server's bad_credentials reads "username" on the legacy sign-in, "password" on a session's own
 * check); anything else as it is.
 */
function withText(e: unknown, code: string, text: string): unknown {
  if (!(e instanceof AccountError) || e.code !== code) return e;
  const out = new AccountError(text, e.status, e.code, e.retryAfterMs, e.level, e.suggest);
  out.detail = e.detail;
  return out;
}

/** What a sign-in sent with linkPending says of the identity pending in this browser: the providers linked, or why none. */
function linkOutcome(s: { linked?: unknown; linkError?: unknown }): { linked: OAuthProvider[]; linkError: string | null } {
  const linked = Array.isArray(s.linked) ? s.linked.filter((p): p is OAuthProvider => p === 'google' || p === 'discord') : [];
  return { linked, linkError: linked.length === 0 ? (typeof s.linkError === 'string' ? s.linkError : 'no_pending') : null };
}

export class AccountError extends Error {
  /** What a refusal carried besides its code (sign-in PR 8, AccountClient.fail): AccountErrorDetail. */
  detail: AccountErrorDetail = {};
  readonly status: number;
  /** The server's `error` code ('bad_credentials', 'username_taken', 'throttled', ...) or a local one. */
  readonly code: string;
  readonly retryAfterMs: number;
  /** reauth_required's level (the sign-in design's R6): 1 a provider or the password, 2 the password only; 0 otherwise. */
  readonly level: 0 | 1 | 2;
  /** username_taken's free name near the one asked for (the confirm step's 409), null otherwise. */
  readonly suggest: string | null;

  constructor(message: string, status: number, code: string, retryAfterMs = 0, level: 0 | 1 | 2 = 0, suggest: string | null = null) {
    super(message);
    this.name = 'AccountError';
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.level = level;
    this.suggest = suggest;
  }
}

/** The confirm step's refusals of a name that carry a free `suggest` (POST /api/auth/pending/create, the email sign-up's rules), and their text. */
const NAME_REFUSALS: ReadonlyMap<string, 'auth.nameTaken' | 'auth.nameLookalike' | 'auth.nameReserved'> = new Map([
  ['username_taken', 'auth.nameTaken'],
  ['name_lookalike', 'auth.nameLookalike'],
  ['name_reserved', 'auth.nameReserved'],
] as const);

/** A username / password the client refuses before any request (the same rules as the server). */
function issueError(issue: AccountIssue, code: 'bad_username' | 'bad_password'): AccountError {
  return new AccountError(t(`account.issue.${issue.code}`, issue.params), 400, code);
}

/**
 * What `#auth=...` in the URL says after an OAuth round trip (consumed once): 'ok' signed in (with
 * `linkError`: the identity pending in this browser was not linked, and why), 'linked', 'reauth'
 * (PERFIL's "confirm it is you" came back), 'confirm' (an identity no account owns: the confirm
 * sheet asks first, accountLinks.ts), 'new' only from a server of before the confirm step.
 */
export type AuthHashResult = { kind: 'ok'; linkError?: string } | { kind: 'new' | 'linked' | 'reauth' | 'confirm' } | { kind: 'error'; code: string };

/** POST /api/auth/pending: the identity a provider proved in this browser that no account owns, as the confirm sheet shows it. */
export interface PendingInfo {
  provider: OAuthProvider;
  /** The provider's verified address (null: none, or never verified: trust 'none'). */
  email: string | null;
  trust: 'auth' | 'asserted' | 'none';
  /** A second identity proved after it ("I have one" with the other provider, which had no account either). */
  second: OAuthProvider | null;
  /** The account that address leads to: it signs in and links, never a second account. */
  match: { name: string; methods: Array<'password' | OAuthProvider>; via: 'email' | 'hint'; email: string } | null;
}

/** A sign-in sent with linkPending: the session, and the providers linked to it, or why not. */
export interface LinkedSignIn {
  session: AccountSession;
  linked: OAuthProvider[];
  linkError: string | null;
}

/** POST /api/auth/tv/renew: the TV's next code (the same secret), its end on the server's clock and its life from now. */
export interface TvRenewAnswer {
  code: string;
  expiresAt: number;
  ttlMs: number;
}

/** What the confirm step sends with CREAR: the news switch, and the language and time zone of the account's mail. */
export interface CreateOptions {
  news: boolean;
  lang: string;
  tz: string;
}

/** How long after a credential proof (a sign-in, a re-authentication) the client counts it fresh: a little under the server's 10 minutes. */
export const FRESH_MS = 9 * 60_000;

/** Both client keys of one typed password: the legacy one of `username` (proves a password of before) and the current one. */
async function bothKeys(username: string, password: string): Promise<{ legacy: string; current: string }> {
  const [legacy, current] = await Promise.all([legacyPasswordKey(username, password), passwordKey(password)]);
  return { legacy, current };
}

export function parseAuthHash(hash: string): AuthHashResult | null {
  const m = /(?:^#|&)auth=([a-z]+)(?::([a-z_]+))?/.exec(hash);
  if (!m) return null;
  if (m[1] === 'ok') return m[2] !== undefined ? { kind: 'ok', linkError: m[2] } : { kind: 'ok' };
  if (m[1] === 'new' || m[1] === 'linked' || m[1] === 'reauth' || m[1] === 'confirm') return { kind: m[1] };
  if (m[1] === 'error') return { kind: 'error', code: m[2] ?? 'unknown' };
  return null;
}

/** The player's text for an OAuth error code coming back in the hash. */
export function oauthErrorText(code: string): string {
  switch (code) {
    case 'cancelled':
      return t('auth.oauthCancelled');
    case 'already_linked':
      return t('auth.oauthAlreadyLinked');
    case 'provider_disabled':
      return t('auth.oauthDisabled');
    case 'bad_state':
      return t('auth.oauthExpired');
    case 'tv_session':
      return t('error.account.tv_session');
    case 'provider_set':
      return t('error.account.provider_set');
    case 'reauth_required':
      return t('error.account.reauth_required');
    case 'reauth_mismatch':
      return t('error.account.reauth_mismatch');
    case 'link_expired':
      return t('auth.oauthLinkExpired');
    case 'no_account':
      return t('auth.noAccount');
    case 'no_pending':
      return t('auth.pendingExpired');
    case 'wrong_account':
    case 'email_has_account':
    case 'deletion_pending':
      return t(`error.account.${code}`);
    default:
      return t('auth.oauthFailed');
  }
}

function isSession(v: unknown): v is AccountSession {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return o.kind === 'account' && typeof o.playerId === 'string' && typeof o.name === 'string' && typeof o.session === 'string' && typeof o.expiresAt === 'number';
}

/** Only an AccountSession's own fields of an answer that carries more (a sign-up's codes, a TV poll's state). */
function sessionPart(s: AccountSession): AccountSession {
  const out: AccountSession = { kind: 'account', playerId: s.playerId, name: s.name, session: s.session, expiresAt: s.expiresAt };
  if (s.car !== undefined) out.car = s.car;
  if (s.tv === true) out.tv = true;
  if (typeof s.authAt === 'number' && s.authAt > 0) out.authAt = s.authAt;
  if (out.authAt !== undefined && (s.authLvl === 1 || s.authLvl === 2)) out.authLvl = s.authLvl;
  return out;
}

function isDevice(v: unknown): v is DeviceSession {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === 'string' && (o.kind === 'web' || o.kind === 'tv') && typeof o.signedInAt === 'number' && typeof o.lastUsedAt === 'number' && typeof o.current === 'boolean';
}

/** The wait before a refresh that another tab won is asked again (its cookie is the new one by then). */
const REFRESH_RACE_RETRY_MS = 400;

export interface AccountClientOptions {
  /** sessionStorage (a sign-up's attempt, a mailed link's token: src/net/emailAuth.ts); null: none (a browser with storage off, tests), this page's own copy only (pageStore). */
  session?: StorageLike | null;
  apiBase?: string;
  fetchFn?: FetchLike;
  /** null disables the hint (tests). */
  storage?: StorageLike | null;
  now?: () => number;
  /** The wait between two polls of waitRankedResult (setTimeout by default; tests move a fake `now`). */
  sleep?: (ms: number) => Promise<void>;
  /** A Turnstile token for every anonymous account request (sign-up, sign-in, recovery, a TV's start) when the server wants one (NetClient.antiBotToken), null = none. */
  antiBot?: () => Promise<string | null>;
  /**
   * The same check, never asking the player (NetClient.antiBotToken's `quiet`): it rejects when it
   * wants a press or cannot load. A TV's start uses it (a remote cannot answer the challenge), and
   * without a token the server counts the code under tighter caps. Absent: `antiBot`.
   */
  antiBotQuiet?: () => Promise<string | null>;
}

/** waitRankedResult options. */
export interface RankedWaitOptions {
  /** The match ran on a community node (Welcome.hostColo 'node:<name>'): keep polling after the fast tries. */
  node?: boolean;
  /** Called once when a node match is still pending after the fast tries (the menu says it is being verified). */
  onVerifying?: () => void;
}

/** What ACCOUNT_HINT_KEY holds: the name, and the account id since experimental features (null in an older hint). */
export interface AccountHint {
  name: string;
  id: string | null;
}

/**
 * The hint this browser keeps ("signed in as X"), read without an AccountClient (main.ts reads it
 * before the account is restored: the boot tier, src/game/experimentalStore.ts). Null when none or
 * unreadable.
 */
export function readAccountHint(storage: Pick<StorageLike, 'getItem'> | null): AccountHint | null {
  try {
    const raw = storage?.getItem(ACCOUNT_HINT_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as { name?: unknown; id?: unknown };
    if (typeof o.name !== 'string') return null;
    return { name: o.name, id: typeof o.id === 'string' && /^[0-9a-f]{16}$/.test(o.id) ? o.id : null };
  } catch {
    return null;
  }
}

/**
 * What GET /api/config's `auth` says about signing in (the sign-in design's §2.1), each false or
 * 'none' from a server without it: `email` the flows that send mail may show (sign-up, forgot, a
 * first password: sign-in PR 7's mailer, its kill flag off), `devSignIn` the dev-only sign-in
 * (§3.15), `legacy` the username sign-in's phase and its cutoff (sign-in PR 9).
 */
export interface AuthConfig {
  email: boolean;
  devSignIn: boolean;
  legacy: LegacyPhase;
  legacyUntil: number | null;
}

/** A sign-up's proof of the mailbox: the code typed in the browser that started it, or the mailed link's token. */
export type CodeProof = { attempt: string; code: string } | { token: string };

/** Settings › Game's Idioma chosen while signed in (sign-in PR 9): sent as the mail's language once the reloaded page has the account back. */
const LANG_CHOICE_KEY = STORAGE_PREFIX + 'auth.lang';
/** That choice counts this long (a reload, a slow restore). */
const LANG_CHOICE_MS = 10 * 60_000;
/** PERFIL's dialog to reopen after a provider's "confirm it's you" round trip (keepResume), and how long it counts. */
const RESUME_KEY = STORAGE_PREFIX + 'auth.dialog';
const RESUME_MS = 10 * 60_000;

/** The sessionStorage marker of a provider button pressed on this device ("Continue as Ana · Discord" once it comes back). */
const PROVIDER_TRY_KEY = STORAGE_PREFIX + 'auth.provider';
/** That marker counts this long: a provider's round trip. */
const PROVIDER_TRY_MS = 10 * 60_000;

export class AccountClient {
  /** The signed-in account's Bearer session, null for a guest. */
  account: AccountSession | null = null;
  /** Last /api/me answer (null for a guest or before the first fetch). */
  me: MeInfo | null = null;
  /** Sign-in / sign-out / rename / profile refresh: every `subscribe`r is called (the menus redraw, the Game re-checks). */
  private readonly listeners = new Set<() => void>();
  /** authConfig's one GET /api/config (devSignInOffered's too), once asked. */
  private authCfg: Promise<AuthConfig> | null = null;
  /** sessionStorage: the sign-up's attempt and a mailed link's token (src/net/emailAuth.ts), with this page's copy (pageStore: storage off, it lasts the page). */
  private readonly sessionStore: StorageLike;

  private readonly apiBase: string;
  private readonly fetchFn: FetchLike;
  private readonly storage: StorageLike | null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private refreshing: Promise<AccountSession | null> | null = null;
  private readonly antiBot: () => Promise<string | null>;
  private readonly antiBotQuiet: () => Promise<string | null>;

  constructor(opts: AccountClientOptions = {}) {
    this.antiBot = opts.antiBot ?? (() => Promise.resolve(null));
    this.antiBotQuiet = opts.antiBotQuiet ?? this.antiBot;
    this.apiBase = opts.apiBase ?? '';
    this.fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, { ...init, credentials: 'same-origin' } as RequestInit) as unknown as Promise<ResponseLike>);
    this.storage = opts.storage === undefined ? defaultStorage() : opts.storage;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.sessionStore = pageStore(opts.session === undefined ? defaultSessionStorage() : opts.session);
  }

  get signedIn(): boolean {
    return this.account !== null;
  }

  /** The name this browser was last signed in with (the refresh cookie probably still works), null for a guest. */
  get hintName(): string | null {
    return readAccountHint(this.storage)?.name ?? null;
  }

  /** The account id of the hint (null for a guest, or a hint written before it carried the id). */
  get hintId(): string | null {
    return readAccountHint(this.storage)?.id ?? null;
  }

  private setHint(s: AccountSession | null): void {
    try {
      if (s === null) this.storage?.removeItem(ACCOUNT_HINT_KEY);
      else this.storage?.setItem(ACCOUNT_HINT_KEY, JSON.stringify({ name: s.name, id: s.playerId } satisfies AccountHint));
    } catch {
      /* storage disabled */
    }
  }

  /** Call `fn` after every account change (sign-in / out, rename, profile refresh); returns the unsubscribe. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch (err) {
        console.error('[accounts] listener failed', err);
      }
    }
  }

  private adopt(s: AccountSession): AccountSession {
    // The session's car (src/net/cosmetics.ts): a catalog id, else none (the default car).
    if (s.car !== undefined && !isCarId(s.car)) delete s.car;
    this.account = s;
    this.setHint(s);
    this.changed();
    return s;
  }

  private async call(path: string, body?: unknown, bearer?: string): Promise<ResponseLike> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (bearer) headers.authorization = 'Bearer ' + bearer;
    try {
      return await this.fetchFn(this.apiBase + path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new AccountError(t('error.network'), 0, 'network');
    }
  }

  private async fail(res: ResponseLike): Promise<never> {
    let code = 'http';
    let serverMessage = '';
    let retry = 0;
    let level: 0 | 1 | 2 = 0;
    let detail: AccountErrorDetail = {};
    try {
      const b = (await res.json()) as { error?: unknown; message?: unknown; retryAfterMs?: unknown; level?: unknown; triesLeft?: unknown; suggest?: unknown; email?: unknown; purgeAt?: unknown };
      if (typeof b.error === 'string') code = b.error;
      if (typeof b.message === 'string' && b.message !== b.error) serverMessage = b.message;
      if (typeof b.retryAfterMs === 'number') retry = b.retryAfterMs;
      if (b.level === 1 || b.level === 2) level = b.level;
      detail = detailOf(b);
    } catch {
      /* no JSON body */
    }
    // A code without a server text (a sign-in rate_limited...) still gets its own text when the client has one.
    const message = detailText(code, detail) ?? (serverText('account', code, serverMessage) || t('error.server'));
    if (message === t('error.server')) console.warn(`account: answered ${res.status} ${code}`);
    const err = new AccountError(message, res.status, code, retry, code === 'reauth_required' ? level || 1 : 0);
    err.detail = detail;
    throw err;
  }

  private async jsonOrFail<T>(res: ResponseLike): Promise<T> {
    if (!res.ok) return this.fail(res);
    return (await res.json()) as T;
  }

  // ---- sign-in -----------------------------------------------------------------------------

  /** Restore the session from the refresh cookie (page load, after an OAuth redirect). Resolves null when there is none. */
  restore(): Promise<AccountSession | null> {
    return this.refresh();
  }

  private refresh(): Promise<AccountSession | null> {
    if (this.refreshing) return this.refreshing;
    const p = (async () => {
      let res: ResponseLike;
      try {
        res = await this.call('/api/auth/refresh', {});
        // 409 refresh_race: another tab of this browser rotated the shared cookie a moment ago; the
        // browser holds the new one now, so asking again succeeds (once: nothing is revoked by it).
        if (res.status === 409) {
          await this.sleep(REFRESH_RACE_RETRY_MS);
          res = await this.call('/api/auth/refresh', {});
        }
      } catch {
        return this.account; // offline: keep what we have
      }
      if (res.status === 401 || res.status === 403) {
        const had = this.account !== null;
        this.account = null;
        this.me = null;
        this.setHint(null);
        if (had) this.changed();
        return null;
      }
      if (!res.ok) return this.account;
      const s = await res.json();
      if (isSession(s)) this.providerReturned(s.name);
      return isSession(s) ? this.adopt(s) : null;
    })();
    this.refreshing = p;
    void p.finally(() => {
      if (this.refreshing === p) this.refreshing = null;
    });
    return p;
  }

  /**
   * A Bearer session that is valid for a few more minutes (refreshed when needed), null for a
   * guest. `minValidMs` asks for longer: a match on a community node is left only through
   * POST /api/leave, with the Bearer the match started with (NetClient.refreshBearer). A restore
   * still on its way (a page load) is waited for: a Sala joined again after a reload joins as the
   * account's member, not as a new guest.
   */
  async sessionForQueue(minValidMs = REFRESH_MARGIN_MS): Promise<AccountSession | null> {
    const a = this.account ?? (this.refreshing !== null ? await this.refreshing : null);
    if (a === null) return null;
    if (a.expiresAt - this.now() > minValidMs) return a;
    return this.refresh();
  }

  /**
   * Re-sign the session now through the refresh cookie (AccountsDO signs the car the account drives
   * now, src/net/cosmetics.ts): the Garage asks for it when an answer shows the session's car is no
   * longer the account's (a maintainer's revoke, a pick in another tab), so the next queue seats the
   * right one. Resolves null when signed out (or the cookie is gone: signed out then too).
   */
  renewSession(): Promise<AccountSession | null> {
    if (this.account === null) return Promise.resolve(null);
    return this.refresh();
  }

  /** The server refused our session (401): refresh once. */
  async sessionRejected(): Promise<AccountSession | null> {
    if (this.account === null) return null;
    return this.refresh();
  }

  /**
   * A solved anti-bot check (NetClient.antiBotToken), null when the server asks for none. One that
   * could not run here (a blocker kept its script out, the challenge failed) rejects turnstile_failed
   * with status 0, which PERFIL words as "allow the site in your blocker, or use a provider"; the
   * server's own refusal of a token is a 403.
   */
  private async antiBotToken(): Promise<string | null> {
    try {
      return await this.antiBot();
    } catch {
      throw new AccountError(t('auth.antiBotFailed'), 0, 'turnstile_failed');
    }
  }

  /**
   * POST an anonymous account request (sign-up, sign-in, recovery) with a solved anti-bot token,
   * every time (the server's R3). A 403 turnstile_failed is a warmed token that died (300 s) or was
   * spent: it is sent once more with a new one, silently; any other answer is the caller's.
   */
  private async callAnonymous(path: string, body: Record<string, unknown>): Promise<ResponseLike> {
    const token = await this.antiBotToken();
    const res = await this.call(path, token !== null ? { ...body, turnstileToken: token } : body);
    if (res.status !== 403 || token === null) return res;
    // Read once, handed on as read: the caller's jsonOrFail reads it again.
    const data: unknown = await res.json().catch(() => null);
    const read: ResponseLike = { ok: res.ok, status: res.status, json: async () => data, text: async () => JSON.stringify(data) };
    if ((data as { error?: unknown } | null)?.error !== 'turnstile_failed') return read;
    const again = await this.antiBotToken();
    return again === null ? read : this.call(path, { ...body, turnstileToken: again });
  }

  /**
   * The username sign-in of before (POST /api/auth/login, until the cutoff of sign-in PR 9): both
   * keys of the typed password (a stored legacy password is checked with the legacy key and re-keyed
   * by the server to the current one), and a solved anti-bot check. PERFIL sends a typed value
   * without '@' here (emailAuth.ts signInRoute); bad_credentials says "username" here. An account
   * whose deletion is pending rejects with deletion_pending (detail.purgeAt); `cancelDeletion`, once
   * the player said so, calls it off and signs in (sign-in PR 12; no screen asks it yet).
   */
  async legacySignIn(username: string, password: string, opts: SignInOptions = {}): Promise<AccountSession> {
    if (username.trim().length === 0 || password.length === 0) throw new AccountError(t('auth.empty'), 400, 'empty');
    const keys = await bothKeys(username.trim(), password);
    const res = await this.callAnonymous('/api/auth/login', { username: username.trim(), password: keys.legacy, passwordV2: keys.current, ...(opts.cancelDeletion === true ? { cancelDeletion: true } : {}) });
    const s = await this.jsonOrFail<AccountSession>(res).catch((e: unknown) => Promise.reject(withText(e, 'bad_credentials', t('auth.badLegacyCredentials'))));
    return this.adopt(sessionPart(s));
  }

  // ---- the confirm step: an identity no account owns (server/src/accountRoutes.ts pendingInfo) ----

  /** The identity pending in this browser (POST /api/auth/pending), null when there is none any more (404: its 30 minutes, another tab). */
  async pending(): Promise<PendingInfo | null> {
    const res = await this.call('/api/auth/pending', {});
    if (res.status === 404) return null;
    return this.jsonOrFail<PendingInfo>(res);
  }

  /**
   * The confirm sheet's CREAR (POST /api/auth/pending/create): the account, with the name the player
   * chose and the pending identity (and its second one), after a solved anti-bot check. Refusals
   * reject with their code: username_taken, name_lookalike and name_reserved (the email sign-up's
   * name rules; each with its `suggest`, a free name the sheet puts in the field), email_has_account,
   * already_linked, no_pending.
   */
  async createAccount(username: string, opts: CreateOptions): Promise<AccountSession> {
    const u = usernameIssue(username);
    if (u !== null) throw issueError(u, 'bad_username');
    const res = await this.callAnonymous('/api/auth/pending/create', { username, news: opts.news, lang: opts.lang, tz: opts.tz });
    if (res.status === 409 || res.status === 400) {
      const b = (await res.json().catch(() => null)) as { error?: unknown; suggest?: unknown } | null;
      const read: ResponseLike = { ok: false, status: res.status, json: async () => b, text: async () => JSON.stringify(b) };
      const named = NAME_REFUSALS.get(typeof b?.error === 'string' ? b.error : '');
      if (named !== undefined && typeof b?.suggest === 'string') throw new AccountError(t(named, { name: b.suggest }), res.status, b.error as string, 0, 0, b.suggest);
      return this.fail(read);
    }
    const s = await this.jsonOrFail<AccountSession>(res);
    // The provider's round trip made this account: "continue as" offers that provider.
    if (isSession(s)) this.providerReturned(s.name);
    return this.adopt(sessionPart(s));
  }

  /**
   * The confirm sheet's CANCELAR, Back or Esc (POST /api/auth/pending/cancel): the pending identity
   * goes, and so does the provider mark of its round trip, which signed nobody in ("continue as"
   * never learns a provider from it). Never rejects.
   */
  async cancelPending(): Promise<void> {
    this.providerAbandoned();
    try {
      await this.call('/api/auth/pending/cancel', {});
    } catch {
      /* it ends in 30 minutes anyway */
    }
  }

  /**
   * "I already have one" with a username of before (no '@': accountLinks.ts routes as PERFIL does):
   * the legacy sign-in with linkPending, so the identity pending in this browser goes on that
   * account (only the one its address leads to, when it leads to one). The sign-in stands either
   * way: `linkError` says why nothing was linked. bad_credentials says "username" here.
   */
  async loginAndLink(username: string, password: string): Promise<LinkedSignIn> {
    if (username.trim().length === 0 || password.length === 0) throw new AccountError(t('auth.empty'), 400, 'empty');
    const keys = await bothKeys(username.trim(), password);
    const res = await this.callAnonymous('/api/auth/login', { username: username.trim(), password: keys.legacy, passwordV2: keys.current, linkPending: true });
    const s = await this.jsonOrFail<AccountSession & { linked?: unknown; linkError?: unknown }>(res).catch((e: unknown) => Promise.reject(withText(e, 'bad_credentials', t('auth.badLegacyCredentials'))));
    // A password signed in, not the provider's round trip that led here.
    this.providerReturned(null);
    return { session: this.adopt(sessionPart(s)), ...linkOutcome(s) };
  }

  /**
   * "I already have one" with an address (an '@'): the email sign-in (POST /api/auth/signin, as
   * signIn) with linkPending, so an email account (sign-in PR 7) takes the identity pending in this
   * browser too, under the same rules as loginAndLink. The sign-in stands either way.
   */
  async signInAndLink(email: string, password: string): Promise<LinkedSignIn> {
    const s = await this.emailSignIn(email, password, true);
    return { session: this.adopt(sessionPart(s)), ...linkOutcome(s) };
  }

  async recover(username: string, code: string, newPassword: string): Promise<AccountSession & { codesLeft: number }> {
    const p = passwordIssue(newPassword, username);
    if (p !== null) throw issueError(p, 'bad_password');
    const res = await this.callAnonymous('/api/auth/recover', { username: username.trim(), code, passwordV2: await passwordKey(newPassword) });
    const s = await this.jsonOrFail<AccountSession & { codesLeft: number }>(res);
    this.adopt(sessionPart(s));
    return s;
  }

  async logout(): Promise<void> {
    try {
      await this.call('/api/auth/logout', {});
    } catch {
      /* the local state goes anyway */
    }
    this.signedOutHere();
  }

  private signedOutHere(): void {
    this.account = null;
    this.me = null;
    this.setHint(null);
    this.changed();
  }

  // ---- signed-in devices (PERFIL) -------------------------------------------------------------

  /** The account's signed-in devices (GET /api/auth/sessions), this browser marked `current`. */
  async sessions(): Promise<DeviceSession[]> {
    const r = (await this.ownCall('/api/auth/sessions')) as { sessions?: unknown } | null;
    return Array.isArray(r?.sessions) ? r.sessions.filter(isDevice) : [];
  }

  /** Sign another device out (POST /api/auth/sessions/revoke; PERFIL offers it for the others only: this one signs out with logout). */
  async revokeSession(id: string): Promise<void> {
    await this.ownCall('/api/auth/sessions/revoke', { id });
  }

  /** Sign out on every device, this one too (POST /api/auth/sessions/revoke-all): an OAuth-only account's way to end a stolen session. */
  async signOutEverywhere(): Promise<void> {
    await this.ownCall('/api/auth/sessions/revoke-all', {});
    this.signedOutHere();
  }

  /** Full-page redirect target of the "Sign in with Google / Discord" buttons (`link`: add it to the signed-in account). */
  // ---- the TV's sign-in with the phone (server/src/tvCodes.ts) -----------------------------------

  /**
   * A TV: a code to show and the device secret to poll with (POST /api/auth/tv/start, no session),
   * after the anti-bot check (NetClient.antiBotToken: a token per code when the server wants one).
   */
  async tvStart(): Promise<TvStartAnswer> {
    // Never the sheet that asks the player: a remote cannot answer Cloudflare's challenge (the live
    // check's TV). A check that wants a press, or cannot load, sends no token, and the server counts
    // that code under tighter caps of its own (server/src/tvCodes.ts TV_OPEN_*).
    let token: string | null;
    try {
      token = await this.antiBotQuiet();
    } catch {
      token = null;
    }
    const res = await this.call('/api/auth/tv/start', token !== null ? { turnstileToken: token } : {});
    if (res.status !== 403 || token === null) return this.jsonOrFail<TvStartAnswer>(res);
    // A token the server refused (a warmed one that died): once more without one.
    const data: unknown = await res.json().catch(() => null);
    if ((data as { error?: unknown } | null)?.error !== 'turnstile_failed') return this.fail({ ok: false, status: 403, json: async () => data, text: async () => JSON.stringify(data) });
    return this.jsonOrFail<TvStartAnswer>(await this.call('/api/auth/tv/start', {}));
  }

  /**
   * A TV, 20 s before its code ends (POST /api/auth/tv/renew): the next code, bound to the same
   * secret. Rejects tv_code_used (the phone confirmed this one: keep polling it), tv_code_expired
   * (gone, or the renewals used up), tv_renew_early (more than the code's last minute left: the
   * server renews a code once, in its last minute) and busy (the network's caps).
   */
  async tvRenew(code: string, secret: string): Promise<TvRenewAnswer> {
    const r = await this.jsonOrFail<TvRenewAnswer>(await this.call('/api/auth/tv/renew', { code, secret }));
    if (typeof r?.code !== 'string' || typeof r.ttlMs !== 'number') throw new AccountError(t('error.server'), 200, 'protocol');
    return r;
  }

  /** The phone (/tv), before it confirms: where the TV showing `code` is (POST /api/auth/tv/info). */
  async tvInfo(code: string): Promise<TvInfoAnswer> {
    return this.jsonOrFail<TvInfoAnswer>(await this.call('/api/auth/tv/info', { code }, await this.bearer()));
  }

  /**
   * A TV: the phone's answer so far. Approved, the session comes back NOT adopted yet: the caller
   * closes its sheet first, then signInWith (the return with intent runs on the change).
   */
  async tvPoll(code: string, secret: string): Promise<TvPollAnswer> {
    const r = await this.jsonOrFail<TvPollAnswer>(await this.call('/api/auth/tv/poll', { code, secret }));
    if (r.state === 'approved' && !isSession(r)) throw new AccountError(t('error.server'), 200, 'protocol');
    return r;
  }

  /** The approved TV's session (tvPoll), adopted as a sign-in's, with the car it carries. */
  signInWith(s: AccountSession): AccountSession {
    return this.adopt(sessionPart(s));
  }

  /** The phone (/tv): this account signs the TV showing `code` in (POST /api/auth/tv/confirm). */
  async tvConfirm(code: string): Promise<void> {
    await this.jsonOrFail<{ ok: true }>(await this.call('/api/auth/tv/confirm', { code }, await this.bearer()));
  }

  // ---- the dev-only sign-in (the sign-in design's §3.15; local work and forks) ---------------------

  /**
   * GET /api/config says the dev sign-in is open (`auth.devSignIn`: DEV_AUTH=1 on a loopback
   * Worker). Asked once per page, and only by a caller that wants it (PERFIL on a page served from
   * this machine), so a deployed page never spends a request on it. False when the config fails.
   */
  devSignInOffered(): Promise<boolean> {
    return this.authConfig().then((c) => c.devSignIn);
  }

  /** POST /api/dev/signin { name }: the account of that dev name (made at its first use), adopted as a sign-in's. */
  async devSignIn(name: string): Promise<AccountSession> {
    const s = await this.jsonOrFail<AccountSession>(await this.call('/api/dev/signin', { name: name.trim() }));
    if (!isSession(s)) throw new AccountError(t('error.server'), 200, 'protocol');
    return this.adopt(sessionPart(s));
  }

  /**
   * Full-page redirect target of the provider buttons: a sign-in, `link` (PERFIL's VINCULAR, true
   * or 'link': this browser must have proved a credential in the last minutes, see fresh),
   * 'reauth' (PERFIL's "confirm it is you" with a provider already on the account; `then`: go
   * straight on to linking that provider) or 'pend' (the confirm sheet's "I already have one": the
   * identity pending in this browser goes on the account it signs in to).
   */
  oauthUrl(provider: OAuthProvider, link: boolean | 'link' | 'reauth' | 'pend' | 'cancelDel' = false, then?: OAuthProvider): string {
    // 'cancelDel' (sign-in PR 12): the sign-in after /#auth=error:deletion_pending and "cancel the deletion?".
    const q = link === 'reauth' ? '?reauth=1' + (then !== undefined ? '&then=link:' + then : '') : link === 'pend' ? '?pend=1' : link === 'cancelDel' ? '?cancelDel=1' : link ? '?link=1' : '';
    return `${this.apiBase}/api/auth/oauth/${provider}/start${q}`;
  }

  /**
   * This browser proved a credential a few minutes ago at `level` or above (a sign-in or a
   * re-authentication: the session's authAt and authLvl, R6), so a link, an unlink, a first
   * password or a maintainer's work goes straight through; false for a TV (its scope never allows
   * them), for a proof below `level` (a session of before levels has none) and when it is too old.
   */
  fresh(level: 1 | 2 = 1): boolean {
    const a = this.account;
    return a !== null && a.tv !== true && typeof a.authAt === 'number' && this.now() - a.authAt < FRESH_MS && (a.authLvl ?? 0) >= level;
  }

  /**
   * A password account confirms it is them (POST /api/auth/reauth): the session comes back fresh at
   * level 2. Both keys: a password of before is re-keyed by the server on the way.
   */
  async reauth(password: string): Promise<AccountSession> {
    const name = this.account?.name ?? '';
    if (password.length === 0) throw new AccountError(t('auth.empty'), 400, 'empty');
    const keys = await bothKeys(name, password);
    const s = await this.jsonOrFail<AccountSession>(await this.call('/api/auth/reauth', { legacy: keys.legacy, password: keys.current }, await this.bearer())).catch((e: unknown) => Promise.reject(withText(e, 'bad_credentials', t('profile.wrongPassword'))));
    if (!isSession(s) || s.playerId !== this.account?.playerId) throw new AccountError(t('auth.signInFirst'), 401, 'unauthorized');
    return this.adopt(sessionPart(s));
  }

  /** Take a provider off the account (POST /api/auth/unlink; never its last way in: 409 last_method). */
  async unlink(provider: OAuthProvider): Promise<void> {
    await this.ownCall('/api/auth/unlink', { provider });
    await this.fetchMe();
  }

  private async bearer(): Promise<string> {
    const s = await this.sessionForQueue();
    if (s === null) throw new AccountError(t('auth.signInFirst'), 401, 'unauthorized');
    return s.session;
  }

  /**
   * CAMBIAR CONTRASEÑA (POST /api/me/password { current, legacy, password, lang }): the current
   * password proves it, by both keys (the server reads the one its record holds: `legacy` for a
   * password of before, salted with the name, `current` otherwise); the new one is stored as the
   * current key. The other devices are signed out, this one stays; M4 is mailed. A first password
   * is never set here: it comes from the account's mailbox (passwordLink, I4).
   */
  async changePassword(current: string, next: string): Promise<void> {
    const name = this.account?.name ?? '';
    if (current.length === 0) throw new AccountError(t('profile.wrongPassword'), 400, 'bad_credentials');
    const p = passwordIssue(next, { username: name, email: this.me?.email ?? undefined });
    if (p !== null) throw issueError(p, 'bad_password');
    const [old, key] = await Promise.all([bothKeys(name, current), passwordKey(next)]);
    const res = await this.call('/api/me/password', { current: old.current, legacy: old.legacy, password: key, lang: language() }, await this.bearer());
    await this.jsonOrFail(res).catch((e: unknown) => Promise.reject(withText(e, 'bad_credentials', t('profile.wrongPassword'))));
  }

  /**
   * Change the username (once per 30 days), POST /api/me/username { username, lang } with the Bearer
   * (sign-in PR 7: the name salts no password any more). An account whose password is still the
   * legacy key, or that signs in by its username and proved no password in the last minutes, is
   * refused 403 reauth_required { level: 2 }: PERFIL then asks "confirm it's you" (its password
   * re-keys it) and renames again. A taken name or a look-alike rejects with a free `detail.suggest`.
   */
  async rename(username: string): Promise<AccountSession> {
    const u = usernameIssue(username);
    if (u !== null) throw issueError(u, 'bad_username');
    const before = this.account?.name;
    const s = await this.jsonOrFail<AccountSession>(await this.call('/api/me/username', { username, lang: language() }, await this.bearer()));
    // "Continue as …" follows the new name.
    const last = this.lastSignIn();
    if (last !== null && last.name === before && typeof s?.name === 'string') this.rememberSignIn(s.name, last.method);
    this.adopt(s);
    await this.fetchMe();
    return s;
  }

  // ---- profile / ranked ----------------------------------------------------------------------

  async fetchMe(): Promise<MeInfo | null> {
    if (this.account === null) return null;
    const res = await this.call('/api/me', undefined, await this.bearer());
    if (res.status === 401) {
      await this.sessionRejected();
      return null;
    }
    this.me = await this.jsonOrFail<MeInfo>(res);
    this.changed();
    return this.me;
  }

  /**
   * Merge `records` into the signed-in account's training records (the server keeps the best per
   * pack) and resolve the account's records after the merge. Rejects for a guest or on failure.
   */
  async pushTraining(records: TrainingRecords): Promise<TrainingRecords> {
    const res = await this.call('/api/me/training', { records }, await this.bearer());
    if (res.status === 401) {
      await this.sessionRejected();
      throw new AccountError(t('auth.signInFirst'), 401, 'unauthorized');
    }
    const r = await this.jsonOrFail<{ records?: unknown }>(res);
    return parseTrainingRecords(r.records);
  }

  // ---- experimental features (src/game/experimentalStore.ts) -------------------------------------

  /**
   * A Bearer call of a per-account route (the experimental switch and presets, the cars and the
   * shop), for the account signed in when the call starts (the stores' copies are per account);
   * resolves the answer's JSON (an error status rejects, as jsonOrFail). A 401 refreshes the
   * session once and sends the call again with the new one (a write is not lost to a session that
   * expired early); a second 401, a refresh that signs out, or a session of another account
   * rejects. The refresh cookie is shared by the tabs (one may have signed in as someone else
   * meanwhile), so a refresh can hand back another account: one player's switch, preset, car or
   * claim must never reach it.
   */
  private async ownCall(path: string, body?: unknown): Promise<unknown> {
    const owner = this.account?.playerId ?? null;
    const refused = (): AccountError => new AccountError(t('auth.signInFirst'), 401, 'unauthorized');
    const first = owner === null ? null : await this.sessionForQueue();
    if (first === null || first.playerId !== owner) throw refused();
    let res = await this.call(path, body, first.session);
    if (res.status === 401) {
      const s = await this.sessionRejected();
      if (s === null || s.session === first.session || s.playerId !== owner) throw refused();
      res = await this.call(path, body, s.session);
      if (res.status === 401) throw refused();
    }
    return this.jsonOrFail<unknown>(res);
  }

  /** The experimental routes' answer, parsed leniently (ownCall). */
  private async experimentalCall(path: string, body?: unknown): Promise<ExperimentalAnswer> {
    const r = (await this.ownCall(path, body)) as { enabled?: unknown; presets?: unknown } | null;
    return { enabled: r?.enabled === true, presets: parsePresetList(r?.presets, MAX_PRESETS * 2) };
  }

  /** The account's switch and presets (GET /api/me/experimental). */
  fetchExperimental(): Promise<ExperimentalAnswer> {
    return this.experimentalCall('/api/me/experimental');
  }

  /** Settings > Experimental's switch on the account; resolves the account's state after it. */
  setExperimental(enabled: boolean): Promise<ExperimentalAnswer> {
    return this.experimentalCall('/api/me/experimental', { enabled });
  }

  /** Create or replace one preset (409 too_many past MAX_PRESETS: AccountError code 'too_many'). */
  upsertPreset(preset: StoredPreset): Promise<ExperimentalAnswer> {
    return this.experimentalCall('/api/me/presets', { preset: { id: preset.id, name: preset.name, values: preset.values } });
  }

  deletePreset(id: string): Promise<ExperimentalAnswer> {
    return this.experimentalCall('/api/me/presets/delete', { id });
  }

  // ---- public replays (src/net/replays.ts) ------------------------------------------------------

  /** Whether this account's name is hidden in the public replays (GET /api/me/replay-name; default false). */
  async replayNameHidden(): Promise<boolean> {
    return ((await this.ownCall('/api/me/replay-name')) as { hidden?: unknown } | null)?.hidden === true;
  }

  /** PERFIL's switch: hide the name ('Jugador N') in the public replays or show it again; resolves the server's state after it. */
  async setReplayNameHidden(hidden: boolean): Promise<boolean> {
    return ((await this.ownCall('/api/me/replay-name', { hidden })) as { hidden?: unknown } | null)?.hidden === true;
  }

  // ---- cars and the hosts' shop (src/game/garage.ts; the answers: src/net/cosmetics.ts) ----------

  /** The account's items, the car it drives online and every car it may drive (GET /api/me/items). */
  async fetchItems(): Promise<ItemsAnswer> {
    return itemsAnswerOf(await this.ownCall('/api/me/items'));
  }

  /**
   * Drive `car` online from now on (POST /api/me/car): the default car or one the account owns
   * (409 not_owned, 400 bad_car otherwise). The answer is a fresh session that carries it, adopted
   * as a rename's is: the next queue or lobby seats the account with it (a match already formed
   * keeps the car it was formed with). An answer that comes back once another account is signed in
   * (another tab, a sign-out) is not adopted.
   */
  async selectCar(car: CarId): Promise<AccountSession> {
    const owner = this.account?.playerId ?? null;
    const s = await this.ownCall('/api/me/car', { car });
    if (!isSession(s) || s.playerId !== owner || this.account?.playerId !== owner) throw new AccountError(t('auth.signInFirst'), 401, 'unauthorized');
    return this.adopt(s);
  }

  /** The hosts' shop as this account sees it (claimable, owned, why not) and its wallet (GET /api/me/shop). */
  async fetchShop(): Promise<ShopAnswer> {
    return shopAnswerOf(await this.ownCall('/api/me/shop'));
  }

  /**
   * Claim `item` with the account's host points (POST /api/me/shop/claim), one transaction on the
   * server: `claimed` false when the account owned it already (a retry spends nothing twice).
   * Refusals reject with their code: 404 unknown_item, 409 not_available / frozen / insufficient /
   * requires_matches.
   */
  async claimItem(item: string): Promise<ClaimAnswer> {
    return claimAnswerOf(await this.ownCall('/api/me/shop/claim', { item }));
  }

  async leaderboard(playlist: Playlist): Promise<LeaderboardAnswer> {
    const s = await this.sessionForQueue().catch(() => null);
    return this.jsonOrFail<LeaderboardAnswer>(await this.call('/api/leaderboard?playlist=' + playlist, undefined, s?.session));
  }

  /**
   * The signed-in account's community nodes (GET /nodes/mine, the operator route the node pages
   * use): [] for an account without one, and where the Worker has no nodes (a fork, local dev: 404,
   * or an answer that is not the route's JSON). Rejects for a guest or on a network / server error.
   */
  async myNodes(): Promise<MyNode[]> {
    const res = await this.call('/nodes/mine', undefined, await this.bearer());
    if (res.status === 404) return [];
    const b = await this.jsonOrFail<{ nodes?: unknown }>(res).catch((e: unknown): { nodes?: unknown } => {
      if (e instanceof AccountError) throw e;
      return {}; // not JSON: the dev server's page
    });
    return Array.isArray(b.nodes) ? (b.nodes as MyNode[]) : [];
  }

  async rankedResult(matchId: string): Promise<RankedResultAnswer> {
    return this.jsonOrFail<RankedResultAnswer>(await this.call('/api/ranked/result?matchId=' + encodeURIComponent(matchId), undefined, await this.bearer()));
  }

  /**
   * Poll the rating change of a finished ranked match until AccountsDO has it (the MatchDO reports
   * within a second of the whistle): up to `tries` x `everyMs`. A match on a community node
   * (`opts.node`) is rated only once the control plane re-simulated its replay, which can take
   * longer: still pending after the fast tries, it calls `onVerifying` once and keeps asking every
   * 3 s up to 120 s after the first poll. Resolves the last answer. Stops asking, still pending,
   * once the signed-in account is no longer the one it started with (a sign-out, another
   * account): the match is not the new one's, and AccountsDO would answer it `not_rated`.
   */
  async waitRankedResult(matchId: string, tries = 15, everyMs = 1000, opts: RankedWaitOptions = {}): Promise<RankedResultAnswer> {
    const start = this.now();
    const who = this.account?.playerId;
    let last: RankedResultAnswer = { status: 'pending' };
    for (let i = 0; i < tries; i++) {
      try {
        last = await this.rankedResult(matchId);
      } catch {
        /* keep polling */
      }
      if (last.status !== 'pending') break;
      await this.sleep(everyMs);
      if (this.account?.playerId !== who) return last;
    }
    if (last.status !== 'pending' || opts.node !== true) return last;
    if (opts.onVerifying) opts.onVerifying();
    const until = start + NODE_RESULT_MAX_WAIT_MS;
    while (last.status === 'pending' && this.now() + NODE_RESULT_EVERY_MS <= until) {
      await this.sleep(NODE_RESULT_EVERY_MS);
      if (this.account?.playerId !== who) break;
      try {
        last = await this.rankedResult(matchId);
      } catch {
        /* keep polling */
      }
    }
    return last;
  }

  // ---- email accounts (sign-in PR 8: PR 7's routes, server/src/accountRoutes.ts "email accounts") ----
  //
  // A sign-up proves the mailbox before the account exists: signupStart mails a 6-digit code (and a
  // link) and keeps the attempt in sessionStorage (emailAuth.ts: 30 minutes, so the code step comes
  // back after a reload), signupCheck answers at the sixth digit (it consumes nothing), signupFinish
  // makes the account with its name and password, signed in at level 2. A mailed link's token is
  // kept from the moment the page took it out of the URL until its POST settles (emailAuth.ts
  // DEAD_LINK_CODES). Every anonymous POST carries a solved anti-bot check (callAnonymous, with its
  // silent retry); passwords leave as their key only.

  /**
   * GET /api/config's `auth` (AuthConfig), asked once per page and only by a caller that wants it
   * (PERFIL's guest view, the dev sign-in). A server that answered anything else counts as none of
   * them; no network is asked again next time.
   */
  authConfig(): Promise<AuthConfig> {
    if (this.authCfg !== null) return this.authCfg;
    const none: AuthConfig = { email: false, devSignIn: false, legacy: 'none', legacyUntil: null };
    let offline = false;
    const p = (async (): Promise<AuthConfig> => {
      let res: ResponseLike;
      try {
        res = await this.call('/api/config');
      } catch {
        offline = true;
        return none;
      }
      if (!res.ok) return none;
      try {
        const c = (await res.json()) as { auth?: { email?: unknown; devSignIn?: unknown; legacy?: { phase?: unknown; until?: unknown } } } | null;
        const a = c?.auth;
        const phase = a?.legacy?.phase;
        const until = a?.legacy?.until;
        return { email: a?.email === true, devSignIn: a?.devSignIn === true, legacy: phase === 'grace' || phase === 'closed' ? phase : 'none', legacyUntil: typeof until === 'number' && Number.isFinite(until) ? until : null };
      } catch {
        return none;
      }
    })();
    this.authCfg = p;
    // Offline: the next caller asks again.
    void p.then(() => {
      if (offline && this.authCfg === p) this.authCfg = null;
    });
    return p;
  }

  /** The sign-up this browser started and has not finished (sessionStorage, 30 minutes), null when none. */
  signupAttempt(): StoredAttempt | null {
    return readAttempt(this.sessionStore, this.now());
  }

  /** "Use another email", a dead code: the attempt goes. */
  dropSignupAttempt(): void {
    keepAttempt(this.sessionStore, null);
  }

  /**
   * CONTINUAR (POST /api/auth/signup/start { email, lang }): the same answer for any address (a new
   * one gets the code, one with an account a mail that says how to sign in, I6). The attempt is kept
   * (signupAttempt), its resendAt on this browser's clock. An address that is none rejects bad_email
   * before any request.
   */
  async signupStart(email: string): Promise<StoredAttempt> {
    const address = normalizeEmail(email);
    if (address === null) throw new AccountError(t('error.account.bad_email'), 400, 'bad_email');
    const r = await this.jsonOrFail<CodeStartAnswer>(await this.callAnonymous('/api/auth/signup/start', { email: address, lang: language() }));
    if (typeof r?.attempt !== 'string' || typeof r.resendAt !== 'number') throw new AccountError(t('error.server'), 200, 'protocol');
    const now = this.now();
    const a: StoredAttempt = { attempt: r.attempt, purpose: 'signup', email: address, resendAt: localResendAt(r.resendAt, now), at: now };
    keepAttempt(this.sessionStore, a);
    return a;
  }

  /**
   * The sixth digit, or a mailed link (POST /api/auth/signup/check): the address the proof is for.
   * Consumes nothing. Rejects code_wrong (detail.triesLeft), code_expired, link_invalid and
   * already_created (detail.email: that sign-up made its account in the last minutes).
   */
  async signupCheck(proof: CodeProof): Promise<string> {
    const r = await this.settleLink(proof, false, async () => this.jsonOrFail<SignupCheckAnswer>(await this.call('/api/auth/signup/check', proofBody(proof))));
    if (typeof r?.email !== 'string') throw new AccountError(t('error.server'), 200, 'protocol');
    return r.email;
  }

  /**
   * CREAR CUENTA (POST /api/auth/signup/finish): the proof, the in-game name, the password's key, the
   * news switch, the language and time zone of the account's mail. The name and the password are
   * checked here first (the rules the server applies). Signed in at level 2; the attempt goes, and
   * this device remembers an email sign-in. Name refusals reject with detail.suggest (the form puts
   * it in the field); the proof is never spent by them.
   */
  async signupFinish(proof: CodeProof, f: { username: string; password: string; news: boolean; email: string }): Promise<AccountSession> {
    const u = usernameIssue(f.username);
    if (u !== null) throw issueError(u, 'bad_username');
    const p = passwordIssue(f.password, { username: f.username, email: f.email });
    if (p !== null) throw issueError(p, 'bad_password');
    const body = { ...proofBody(proof), username: f.username, password: await passwordKey(f.password), news: f.news, lang: language(), tz: timeZone() };
    const s = await this.settleLink(proof, true, async () => this.jsonOrFail<AccountSession>(await this.call('/api/auth/signup/finish', body)));
    if (!isSession(s)) throw new AccountError(t('error.server'), 200, 'protocol');
    keepAttempt(this.sessionStore, null);
    this.rememberSignIn(s.name, 'email');
    return this.adopt(sessionPart(s));
  }

  /**
   * REENVIAR (POST /api/auth/code/resend { attempt }): the same code and link again (whichever mail
   * comes first works). `reauth`: an account's own code ("confirm it's you"), which needs its Bearer.
   * Resolves the next resendAt on this browser's clock and the resends left (3 per attempt).
   */
  async codeResend(attempt: string, reauth = false): Promise<CodeResendAnswer> {
    const r = await this.jsonOrFail<CodeResendAnswer>(await this.call('/api/auth/code/resend', { attempt }, reauth ? await this.bearer() : undefined));
    const resendAt = localResendAt(typeof r?.resendAt === 'number' ? r.resendAt : 0, this.now());
    const kept = this.signupAttempt();
    if (kept !== null && kept.attempt === attempt) keepAttempt(this.sessionStore, { ...kept, resendAt });
    return { resendAt, resendsLeft: typeof r?.resendsLeft === 'number' ? r.resendsLeft : 0 };
  }

  /**
   * ENTRAR with an address (POST /api/auth/signin { email, password }): the current key only (a
   * password of before signs in by its username, and re-keys there). One bad_credentials for an
   * unknown address and a wrong password alike (I6). Level 2; this device remembers it. A pending
   * deletion rejects with deletion_pending (detail.purgeAt), and `cancelDeletion` calls it off, as
   * legacySignIn.
   */
  async signIn(email: string, password: string, opts: SignInOptions = {}): Promise<AccountSession> {
    return this.adopt(sessionPart(await this.emailSignIn(email, password, false, opts.cancelDeletion === true)));
  }

  /** signIn's request, and signInAndLink's with `linkPending`: the session as answered (not adopted yet). */
  private async emailSignIn(email: string, password: string, linkPending: boolean, cancelDeletion = false): Promise<AccountSession & { linked?: unknown; linkError?: unknown }> {
    const address = normalizeEmail(email);
    if (address === null) throw new AccountError(t('error.account.bad_email'), 400, 'bad_email');
    if (password.length === 0) throw new AccountError(t('auth.emptyPassword'), 400, 'empty');
    const body = { email: address, password: await passwordKey(password), ...(linkPending ? { linkPending: true } : {}), ...(cancelDeletion ? { cancelDeletion: true } : {}) };
    const s = await this.jsonOrFail<AccountSession & { linked?: unknown; linkError?: unknown }>(await this.callAnonymous('/api/auth/signin', body));
    if (!isSession(s)) throw new AccountError(t('error.server'), 200, 'protocol');
    // An email sign-in, even after a provider's round trip led here ("I have one"): "continue as" says email.
    this.providerReturned(null);
    this.rememberSignIn(s.name, 'email');
    return s;
  }

  /** ENVIAR ENLACE (POST /api/auth/forgot { email, lang }): always ok for an address (a link goes only to an account that claimed it, I6). */
  async forgot(email: string): Promise<void> {
    const address = normalizeEmail(email);
    if (address === null) throw new AccountError(t('error.account.bad_email'), 400, 'bad_email');
    await this.jsonOrFail<{ ok: true }>(await this.callAnonymous('/api/auth/forgot', { email: address, lang: language() }));
  }

  /** A reset link's sheet (POST /api/auth/reset/peek { token }): who it is for. Consumes nothing; a dead link rejects link_invalid (and goes from storage). */
  async resetPeek(token: string): Promise<ResetPeekAnswer> {
    const r = await this.settleLink({ token }, false, async () => this.jsonOrFail<ResetPeekAnswer>(await this.call('/api/auth/reset/peek', { token })));
    if (typeof r?.name !== 'string' || typeof r.email !== 'string') throw new AccountError(t('error.server'), 200, 'protocol');
    return { name: r.name, email: r.email, hasPassword: r.hasPassword === true };
  }

  /**
   * GUARDAR Y ENTRAR (POST /api/auth/reset { token, password, lang }): the password stored, every
   * other device signed out, this browser signed in (level 2). `who`: the peek's answer, whose name
   * and address the password may not hold. A refresh still on its way (a page load) settles first:
   * its old cookie must not come back after the reset revoked it.
   */
  async resetPassword(token: string, password: string, who: Pick<ResetPeekAnswer, 'name' | 'email'>): Promise<AccountSession> {
    const p = passwordIssue(password, { username: who.name, email: who.email });
    if (p !== null) throw issueError(p, 'bad_password');
    const key = await passwordKey(password);
    if (this.refreshing !== null) await this.refreshing.catch(() => null);
    const s = await this.settleLink({ token }, true, async () => this.jsonOrFail<AccountSession>(await this.call('/api/auth/reset', { token, password: key, lang: language() })));
    if (!isSession(s)) throw new AccountError(t('error.server'), 200, 'protocol');
    this.rememberSignIn(s.name, 'email');
    return this.adopt(sessionPart(s));
  }

  /** CREAR CONTRASEÑA (POST /api/me/password/link): a link to the account's own verified address, which it resolves (409 email_required without one). */
  async passwordLink(): Promise<string> {
    const r = (await this.ownCall('/api/me/password/link', { lang: language() })) as Partial<PasswordLinkAnswer> | null;
    return typeof r?.sentTo === 'string' ? r.sentTo : (this.me?.email ?? '');
  }

  /**
   * "Confirm it's you" by a code to the account's own mailbox (POST /api/auth/reauth/code): its
   * attempt (kept by the sheet only), when REENVIAR may be pressed on this clock, and where it went.
   * A maintainer account is refused password_required: it confirms with its password.
   */
  async reauthCodeStart(): Promise<{ attempt: string; resendAt: number; to: string }> {
    const r = await this.jsonOrFail<CodeStartAnswer>(await this.call('/api/auth/reauth/code', { lang: language() }, await this.bearer()));
    if (typeof r?.attempt !== 'string') throw new AccountError(t('error.server'), 200, 'protocol');
    return { attempt: r.attempt, resendAt: localResendAt(typeof r.resendAt === 'number' ? r.resendAt : 0, this.now()), to: typeof r.to === 'string' ? r.to : (this.me?.email ?? '') };
  }

  /** The code of reauthCodeStart (POST /api/auth/reauth/code/verify): this browser's session comes back at level 2. */
  async reauthCodeVerify(attempt: string, code: string): Promise<AccountSession> {
    const s = await this.jsonOrFail<AccountSession>(await this.call('/api/auth/reauth/code/verify', { attempt, code }, await this.bearer()));
    if (!isSession(s) || s.playerId !== this.account?.playerId) throw new AccountError(t('auth.signInFirst'), 401, 'unauthorized');
    return this.adopt(sessionPart(s));
  }

  // ---- adding and changing the email, the mail's language (sign-in PR 9: the design's §2.6, §2.9, §3.6) ----

  /**
   * ENVIAR CÓDIGO (POST /api/me/email { email, lang }): a code to the new address (an add when the
   * account has none, a change otherwise), the same answer whoever holds that address (I6: when
   * another account does, its mailbox gets M7 instead). Its attempt stays with the sheet that asked
   * (a reload drops it; the mail's link still works). Rejects bad_email before any request, and
   * reauth_required { level } when this browser must confirm it is them first (an add fresh(1), a
   * change fresh(2), a password of before once at level 2: its re-key), same_email, email_locked.
   */
  async emailStart(email: string): Promise<{ attempt: string; resendAt: number; to: string }> {
    const address = normalizeEmail(email);
    if (address === null) throw new AccountError(t('error.account.bad_email'), 400, 'bad_email');
    const r = await this.jsonOrFail<CodeStartAnswer>(await this.call('/api/me/email', { email: address, lang: language() }, await this.bearer()));
    if (typeof r?.attempt !== 'string') throw new AccountError(t('error.server'), 200, 'protocol');
    return { attempt: r.attempt, resendAt: localResendAt(typeof r.resendAt === 'number' ? r.resendAt : 0, this.now()), to: typeof r.to === 'string' ? r.to : address };
  }

  /**
   * The code of emailStart (POST /api/me/email/verify { attempt, code }): the address is the
   * account's now (a change also signed the other devices out and mailed the old address its undo).
   * Resolves the account's profile as it is now (adopted as `me`). Rejects code_wrong
   * (detail.triesLeft), code_expired, email_taken (a race), move_refused.
   */
  async emailVerify(attempt: string, code: string): Promise<MeInfo> {
    const me = await this.jsonOrFail<MeInfo>(await this.call('/api/me/email/verify', { attempt, code, lang: language() }, await this.bearer()));
    if (typeof me?.playerId !== 'string' || me.playerId !== this.account?.playerId) throw new AccountError(t('error.server'), 200, 'protocol');
    this.me = me;
    this.changed();
    return me;
  }

  /** REENVIAR of emailStart's code (POST /api/auth/code/resend with the Bearer): the same code and link again. */
  emailResend(attempt: string): Promise<CodeResendAnswer> {
    return this.codeResend(attempt, true);
  }

  /**
   * /account#email=<token> (POST /api/auth/email/confirm { token }): the mailed link of an add or a
   * change, from any device, no session needed. Resolves the account's name and its address now; the
   * kept token goes once it took (or the server says it is dead).
   */
  async emailConfirm(token: string): Promise<EmailConfirmAnswer> {
    const r = await this.settleLink({ token }, true, async () => this.jsonOrFail<EmailConfirmAnswer>(await this.call('/api/auth/email/confirm', { token, lang: language() })));
    if (typeof r?.name !== 'string' || typeof r.email !== 'string') throw new AccountError(t('error.server'), 200, 'protocol');
    if (this.account !== null) void this.fetchMe().catch(() => undefined);
    return { ok: true, name: r.name, email: r.email };
  }

  /** /account#undo=<token>'s sheet (POST /api/auth/email/undo/peek): whom it is for and the address it brings back. Consumes nothing. */
  async undoPeek(token: string): Promise<UndoPeekAnswer> {
    const r = await this.settleLink({ token }, false, async () => this.jsonOrFail<UndoPeekAnswer>(await this.call('/api/auth/email/undo/peek', { token })));
    if (typeof r?.name !== 'string' || typeof r.email !== 'string') throw new AccountError(t('error.server'), 200, 'protocol');
    return { name: r.name, email: r.email };
  }

  /**
   * GUARDAR Y ENTRAR on the undo sheet (POST /api/auth/email/undo { token, password }): the account
   * goes back to `who.email` with this new password; every device is signed out and this browser
   * signed in (level 2). The password is checked here first, against the name and that address.
   */
  async emailUndo(token: string, password: string, who: UndoPeekAnswer): Promise<AccountSession> {
    const p = passwordIssue(password, { username: who.name, email: who.email });
    if (p !== null) throw issueError(p, 'bad_password');
    const key = await passwordKey(password);
    if (this.refreshing !== null) await this.refreshing.catch(() => null);
    const s = await this.settleLink({ token }, true, async () => this.jsonOrFail<AccountSession>(await this.call('/api/auth/email/undo', { token, password: key })));
    if (!isSession(s)) throw new AccountError(t('error.server'), 200, 'protocol');
    this.rememberSignIn(s.name, 'email');
    return this.adopt(sessionPart(s));
  }

  // ---- account deletion (sign-in PR 12: the design's §2.10; the API only, the screens come with the terms) ----

  /**
   * POST /api/me/delete { confirm, lang }: the account is deleted after DELETE_GRACE (14 days); the
   * purge date (ms). `confirm` is the username as the player typed it. Every device is signed out,
   * this one too, so it forgets its session. Refusals: reauth_required (its `level`: confirm it is
   * you first; 1 for an account whose most is a provider's press), bad_confirm, maintainer_account,
   * deletion_pending, tv_session, and email_paused / email_rate_limited when M9 cannot go.
   */
  async deleteAccount(confirm: string): Promise<number> {
    const r = (await this.ownCall('/api/me/delete', { confirm, lang: language() })) as { purgeAt?: unknown } | null;
    if (typeof r?.purgeAt !== 'number') throw new AccountError(t('error.server'), 200, 'protocol');
    this.signedOutHere();
    return r.purgeAt;
  }

  /**
   * PERFIL's "News by email" switch (§2.11, §3.14): POST /api/me/consent { kind: 'news', granted }
   * with the Bearer; resolves the server's state after it, which this account's MeInfo keeps too
   * (in place: only that switch reads it, so nothing redraws). Refusals: email_required (a grant
   * needs a verified address), tv_session, deletion_pending, rate_limited.
   */
  async setNews(granted: boolean): Promise<boolean> {
    const owner = this.account?.playerId ?? null;
    const r = (await this.ownCall('/api/me/consent', { kind: 'news', granted })) as { news?: unknown } | null;
    const news = r?.news === true;
    if (this.me !== null && this.me.playerId === owner) this.me.news = news;
    return news;
  }

  /**
   * A news mail's footer link (/account#unsub=<id>): POST /api/news/unsubscribe { u }, the page's
   * form (the mail's one-click goes from the mail provider to the server). The server answers ok
   * for any id, so the kept link is spent either way; no session needed.
   */
  async unsubscribeNews(id: string): Promise<void> {
    await this.settleLink({ token: id }, true, async () => this.jsonOrFail<{ ok: true }>(await this.call('/api/news/unsubscribe', { u: id })));
  }

  /** M9's link (/account#keep=<token>): POST /api/auth/delete/cancel { token } calls the deletion off; link_invalid when it cannot any more. */
  async cancelDeletion(token: string): Promise<void> {
    await this.settleLink({ token }, true, async () => this.jsonOrFail<{ ok: true }>(await this.call('/api/auth/delete/cancel', { token })));
  }

  /**
   * Settings › Game's Idioma, while signed in (§2.9, §4.2): the choice is kept for this tab
   * (sessionStorage) before the page reloads in the new language, and sendLanguageChoice sends it
   * once the account is back. Never from a TV (its session never sets the mail's language).
   */
  noteLanguageChoice(lang: string): void {
    if (this.account === null || this.account.tv === true || (lang !== 'es' && lang !== 'en')) return;
    try {
      this.sessionStore.setItem(LANG_CHOICE_KEY, JSON.stringify({ lang, id: this.account.playerId, at: this.now() }));
    } catch {
      /* storage off: the mail keeps its language */
    }
  }

  /**
   * The Idioma choice noteLanguageChoice kept (POST /api/me/prefs { lang, tz }): the language and
   * zone of the account's mail follow the person's choice, never a sign-in or a device. Sent once,
   * for the account that chose it; a refusal drops it too. Resolves whether it went.
   */
  async sendLanguageChoice(): Promise<boolean> {
    let v: { lang?: unknown; id?: unknown; at?: unknown } | null = null;
    try {
      const raw = this.sessionStore.getItem(LANG_CHOICE_KEY);
      v = raw === null ? null : (JSON.parse(raw) as { lang?: unknown; id?: unknown; at?: unknown });
    } catch {
      v = null;
    }
    if (v === null) return false;
    const a = this.account;
    const fresh = typeof v.at === 'number' && this.now() - v.at < LANG_CHOICE_MS;
    if (a === null || a.tv === true || v.id !== a.playerId || !fresh || (v.lang !== 'es' && v.lang !== 'en')) {
      if (a !== null || !fresh) this.sessionStore.removeItem(LANG_CHOICE_KEY);
      return false;
    }
    let sent = true;
    try {
      await this.ownCall('/api/me/prefs', { lang: v.lang, tz: timeZone() });
    } catch (e) {
      // No network: kept for the next load. Anything the server said: dropped.
      if (e instanceof AccountError && e.code === 'network') return false;
      sent = false;
    }
    this.sessionStore.removeItem(LANG_CHOICE_KEY);
    return sent;
  }

  /**
   * PERFIL's dialog to come back to after a provider's "confirm it's you" round trip (§3.6 step 2:
   * only a marker crosses the redirect, nothing typed): 'email:add', 'email:change' or
   * 'email:confirm', for 10 minutes in this tab. null forgets it.
   */
  keepResume(dialog: string | null): void {
    try {
      if (dialog === null) this.sessionStore.removeItem(RESUME_KEY);
      else this.sessionStore.setItem(RESUME_KEY, JSON.stringify({ dialog, at: this.now() }));
    } catch {
      /* storage off: PERFIL opens without it */
    }
  }

  /** The marker of keepResume, taken once (null: none, stale, or malformed). */
  takeResume(): string | null {
    try {
      const raw = this.sessionStore.getItem(RESUME_KEY);
      if (raw === null) return null;
      this.sessionStore.removeItem(RESUME_KEY);
      const v = JSON.parse(raw) as { dialog?: unknown; at?: unknown };
      return typeof v.dialog === 'string' && /^email:(add|change|confirm)$/.test(v.dialog) && typeof v.at === 'number' && this.now() - v.at < RESUME_MS ? v.dialog : null;
    } catch {
      return null;
    }
  }

  /** A mailed link the page took out of its URL and has not settled (sessionStorage), null when none. */
  pendingLink(): AccountLink | null {
    return readLink(this.sessionStore, this.now());
  }

  /** Keep `link` until its POST settles (null: forget it). */
  keepPendingLink(link: AccountLink | null): void {
    keepLink(this.sessionStore, link, this.now());
  }

  /**
   * Run a request that may carry a link's token and settle the kept token by its answer: spent when
   * it succeeds and `spends`, or when the server says the link is dead (emailAuth.ts
   * DEAD_LINK_CODES); kept otherwise (a refused name, no network: the same link can go again).
   */
  private async settleLink<T>(proof: CodeProof, spends: boolean, run: () => Promise<T>): Promise<T> {
    const token = 'token' in proof ? proof.token : null;
    const drop = (): void => {
      if (token !== null && this.pendingLink()?.token === token) this.keepPendingLink(null);
    };
    try {
      const r = await run();
      if (spends) drop();
      return r;
    } catch (e) {
      // deletion_pending from a reset or an undo: the link set the password and is spent (sign-in PR 12).
      if (e instanceof AccountError && (DEAD_LINK_CODES.has(e.code) || (spends && e.code === 'deletion_pending'))) drop();
      throw e;
    }
  }

  /** How this device last signed in (localStorage), for "Continue as Ana · Discord"; null when never or unreadable. */
  lastSignIn(): LastSignIn | null {
    return readLastSignIn(this.storage);
  }

  private rememberSignIn(name: string, method: LastSignIn['method']): void {
    keepLastSignIn(this.storage, { name, method });
  }

  /** A provider button is pressed (before the redirect): once its round trip signs this browser in, the sign-in tab offers it first. */
  providerStarted(p: OAuthProvider): void {
    try {
      this.sessionStore.setItem(PROVIDER_TRY_KEY, JSON.stringify({ p, at: this.now() }));
    } catch {
      /* storage off: no "continue as" */
    }
  }

  /**
   * A provider's round trip that signed nobody in (the confirm sheet cancelled, a refusal or an error
   * back in #auth=error:…): its mark goes, so a later restore of another sign-in never names that
   * provider in "continue as".
   */
  providerAbandoned(): void {
    try {
      this.sessionStore.removeItem(PROVIDER_TRY_KEY);
    } catch {
      /* storage off: there is no mark */
    }
  }

  /**
   * A restore (or the confirm sheet's CREAR) signed `name` in: right after a provider's round trip,
   * this device remembers that provider. null: a password signed in instead ("I have one"), so the
   * mark only goes.
   */
  private providerReturned(name: string | null): void {
    try {
      const raw = this.sessionStore.getItem(PROVIDER_TRY_KEY) ?? null;
      if (raw === null) return;
      this.sessionStore.removeItem(PROVIDER_TRY_KEY);
      const v = JSON.parse(raw) as { p?: unknown; at?: unknown };
      if (name !== null && (v.p === 'google' || v.p === 'discord') && typeof v.at === 'number' && this.now() - v.at < PROVIDER_TRY_MS) this.rememberSignIn(name, v.p);
    } catch {
      /* storage off or malformed: nothing remembered */
    }
  }
}

/** A proof as the routes read it (the code's spaces and dashes go on the server too). */
function proofBody(proof: CodeProof): Record<string, string> {
  return 'token' in proof ? { token: proof.token } : { attempt: proof.attempt, code: proof.code };
}

/** The player's IANA time zone for the dates of the account's mail ('' when the browser names none). */
function timeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    return '';
  }
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

function defaultSessionStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : null;
  } catch {
    return null;
  }
}
