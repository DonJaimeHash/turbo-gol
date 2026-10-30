/**
 * Browser side of registered accounts (server/src/accountRoutes.ts): sign-up / sign-in with a
 * username and password (the password is turned into client keys here and never sent: the current
 * passwordKey, and the legacyPasswordKey of before wherever a stored legacy password is proved, so
 * the server re-keys it), each anonymous request with a solved Turnstile check (antiBot),
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
import { legacyPasswordKey, passwordIssue, passwordKey, usernameIssue } from './account';
import type { AccountIssue, AccountSession, DeviceSession, ExperimentalAnswer, LeaderboardAnswer, MeInfo, MyNode, OAuthProvider, Playlist, RankedResultAnswer, RegisterAnswer, TvInfoAnswer, TvPollAnswer, TvStartAnswer } from './account';
import type { FetchLike, ResponseLike, StorageLike } from './NetClient';
import { claimAnswerOf, itemsAnswerOf, shopAnswerOf } from './cosmetics';
import type { ClaimAnswer, ItemsAnswer, ShopAnswer } from './cosmetics';
import { STORAGE_PREFIX } from '../brand';
import { isCarId, type CarId } from '../game/cosmetics';
import { MAX_PRESETS, parsePresetList } from '../game/physicsRules';
import type { StoredPreset } from '../game/physicsRules';
import { parseTrainingRecords } from '../game/trainingRecords';
import type { TrainingRecords } from '../game/trainingRecords';
import { serverText, t } from '../i18n';

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

export class AccountError extends Error {
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

export class AccountClient {
  /** The signed-in account's Bearer session, null for a guest. */
  account: AccountSession | null = null;
  /** Last /api/me answer (null for a guest or before the first fetch). */
  me: MeInfo | null = null;
  /** Sign-in / sign-out / rename / profile refresh: every `subscribe`r is called (the menus redraw, the Game re-checks). */
  private readonly listeners = new Set<() => void>();
  /** devSignInOffered's one GET /api/config, once asked. */
  private devOffered: Promise<boolean> | null = null;

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
    try {
      const b = (await res.json()) as { error?: unknown; message?: unknown; retryAfterMs?: unknown; level?: unknown };
      if (typeof b.error === 'string') code = b.error;
      if (typeof b.message === 'string' && b.message !== b.error) serverMessage = b.message;
      if (typeof b.retryAfterMs === 'number') retry = b.retryAfterMs;
      if (b.level === 1 || b.level === 2) level = b.level;
    } catch {
      /* no JSON body */
    }
    // A code without a server text (a sign-in rate_limited...) still gets its own text when the client has one.
    const message = serverText('account', code, serverMessage) || t('error.server');
    if (message === t('error.server')) console.warn(`account: answered ${res.status} ${code}`);
    throw new AccountError(message, res.status, code, retry, code === 'reauth_required' ? level || 1 : 0);
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

  async register(username: string, password: string): Promise<RegisterAnswer> {
    const u = usernameIssue(username);
    if (u !== null) throw issueError(u, 'bad_username');
    const p = passwordIssue(password, username);
    if (p !== null) throw issueError(p, 'bad_password');
    const res = await this.callAnonymous('/api/auth/register', { username, passwordV2: await passwordKey(password) });
    const r = await this.jsonOrFail<RegisterAnswer>(res);
    this.adopt(sessionPart(r));
    return r;
  }

  /** A solved anti-bot check (NetClient.antiBotToken), null when the server asks for none; a failed one rejects. */
  private async antiBotToken(): Promise<string | null> {
    try {
      return await this.antiBot();
    } catch {
      throw new AccountError(t('auth.antiBotFailed'), 403, 'turnstile_failed');
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
   * The username sign-in: both keys of the typed password (a stored legacy password is checked with
   * the legacy key and re-keyed by the server to the current one), and a solved anti-bot check.
   */
  async login(username: string, password: string): Promise<AccountSession> {
    if (username.trim().length === 0 || password.length === 0) throw new AccountError(t('auth.empty'), 400, 'empty');
    const keys = await bothKeys(username.trim(), password);
    const res = await this.callAnonymous('/api/auth/login', { username: username.trim(), password: keys.legacy, passwordV2: keys.current });
    const s = await this.jsonOrFail<AccountSession>(res);
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
    return this.adopt(sessionPart(s));
  }

  /** The confirm sheet's CANCELAR (POST /api/auth/pending/cancel): the pending identity goes. Never rejects. */
  async cancelPending(): Promise<void> {
    try {
      await this.call('/api/auth/pending/cancel', {});
    } catch {
      /* it ends in 30 minutes anyway */
    }
  }

  /**
   * "I already have one": the username sign-in with linkPending, so the identity pending in this
   * browser goes on that account (only the one its address leads to, when it leads to one). The
   * sign-in stands either way: `linkError` says why nothing was linked.
   */
  async loginAndLink(username: string, password: string): Promise<LinkedSignIn> {
    if (username.trim().length === 0 || password.length === 0) throw new AccountError(t('auth.empty'), 400, 'empty');
    const keys = await bothKeys(username.trim(), password);
    const res = await this.callAnonymous('/api/auth/login', { username: username.trim(), password: keys.legacy, passwordV2: keys.current, linkPending: true });
    const s = await this.jsonOrFail<AccountSession & { linked?: unknown; linkError?: unknown }>(res);
    const linked = Array.isArray(s.linked) ? s.linked.filter((p): p is OAuthProvider => p === 'google' || p === 'discord') : [];
    const linkError = linked.length === 0 ? (typeof s.linkError === 'string' ? s.linkError : 'no_pending') : null;
    return { session: this.adopt(sessionPart(s)), linked, linkError };
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
    if (this.devOffered === null) {
      this.devOffered = (async () => {
        try {
          const res = await this.call('/api/config');
          if (!res.ok) return false;
          const c = (await res.json()) as { auth?: { devSignIn?: unknown } } | null;
          return c?.auth?.devSignIn === true;
        } catch {
          return false;
        }
      })();
    }
    return this.devOffered;
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
  oauthUrl(provider: OAuthProvider, link: boolean | 'link' | 'reauth' | 'pend' = false, then?: OAuthProvider): string {
    const q = link === 'reauth' ? '?reauth=1' + (then !== undefined ? '&then=link:' + then : '') : link === 'pend' ? '?pend=1' : link ? '?link=1' : '';
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
    const s = await this.jsonOrFail<AccountSession>(await this.call('/api/auth/reauth', { legacy: keys.legacy, password: keys.current }, await this.bearer()));
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

  /** The old password proved by both keys (the server reads the one its record holds); the new one stored as the current key. */
  async changePassword(oldPassword: string | null, newPassword: string): Promise<void> {
    const name = this.account?.name ?? '';
    const p = passwordIssue(newPassword, name);
    if (p !== null) throw issueError(p, 'bad_password');
    const body: Record<string, string> = { passwordV2: await passwordKey(newPassword) };
    if (oldPassword !== null) {
      const old = await bothKeys(name, oldPassword);
      body.oldPassword = old.legacy;
      body.oldPasswordV2 = old.current;
    }
    await this.jsonOrFail(await this.call('/api/auth/password', body, await this.bearer()));
  }

  async newRecoveryCodes(password: string | null): Promise<string[]> {
    const name = this.account?.name ?? '';
    const body: Record<string, string> = {};
    if (password !== null) {
      const keys = await bothKeys(name, password);
      body.password = keys.legacy;
      body.passwordV2 = keys.current;
    }
    const r = await this.jsonOrFail<{ recoveryCodes: string[] }>(await this.call('/api/auth/recovery-codes', body, await this.bearer()));
    return r.recoveryCodes;
  }

  /**
   * Change the username (once per 30 days). A password account gives its password: both keys, the
   * legacy one of the old name (a password of before is salted with it) and the current one, which
   * no name salts, so the server re-keys a legacy password and the new name needs nothing (other
   * devices are signed out when it re-keys). An OAuth-only account passes null.
   */
  async rename(username: string, password: string | null): Promise<AccountSession> {
    const u = usernameIssue(username);
    if (u !== null) throw issueError(u, 'bad_username');
    const body: Record<string, string> = { username };
    if (password !== null) {
      const keys = await bothKeys(this.account?.name ?? '', password);
      body.password = keys.legacy;
      body.passwordV2 = keys.current;
    }
    const s = await this.jsonOrFail<AccountSession>(await this.call('/api/me/username', body, await this.bearer()));
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
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}
