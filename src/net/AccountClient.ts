/**
 * Browser side of registered accounts (server/src/accountRoutes.ts): sign-up / sign-in with a
 * username and password (the password is turned into clientPasswordKey here and never sent),
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
import { clientPasswordKey, passwordIssue, usernameIssue } from './account';
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

  constructor(message: string, status: number, code: string, retryAfterMs = 0) {
    super(message);
    this.name = 'AccountError';
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

/** A username / password the client refuses before any request (the same rules as the server). */
function issueError(issue: AccountIssue, code: 'bad_username' | 'bad_password'): AccountError {
  return new AccountError(t(`account.issue.${issue.code}`, issue.params), 400, code);
}

/** What `#auth=...` in the URL says after an OAuth round trip (consumed once); 'reauth': PERFIL's "confirm it is you" came back. */
export type AuthHashResult = { kind: 'ok' | 'new' | 'linked' | 'reauth' } | { kind: 'error'; code: string };

/** How long after a credential proof (a sign-in, a re-authentication) the client counts it fresh: a little under the server's 10 minutes. */
export const FRESH_MS = 9 * 60_000;

export function parseAuthHash(hash: string): AuthHashResult | null {
  const m = /(?:^#|&)auth=([a-z]+)(?::([a-z_]+))?/.exec(hash);
  if (!m) return null;
  if (m[1] === 'ok' || m[1] === 'new' || m[1] === 'linked' || m[1] === 'reauth') return { kind: m[1] };
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
  /** A Turnstile token for registration when the server wants one (NetClient.antiBotToken), null = none. */
  antiBot?: () => Promise<string | null>;
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

  private readonly apiBase: string;
  private readonly fetchFn: FetchLike;
  private readonly storage: StorageLike | null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private refreshing: Promise<AccountSession | null> | null = null;
  private readonly antiBot: () => Promise<string | null>;

  constructor(opts: AccountClientOptions = {}) {
    this.antiBot = opts.antiBot ?? (() => Promise.resolve(null));
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
    try {
      const b = (await res.json()) as { error?: unknown; message?: unknown; retryAfterMs?: unknown };
      if (typeof b.error === 'string') code = b.error;
      if (typeof b.message === 'string' && b.message !== b.error) serverMessage = b.message;
      if (typeof b.retryAfterMs === 'number') retry = b.retryAfterMs;
    } catch {
      /* no JSON body */
    }
    // A code without a server text (a sign-in rate_limited...) still gets its own text when the client has one.
    const message = serverText('account', code, serverMessage) || t('error.server');
    if (message === t('error.server')) console.warn(`account: answered ${res.status} ${code}`);
    throw new AccountError(message, res.status, code, retry);
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
    let token: string | null;
    try {
      token = await this.antiBot();
    } catch {
      throw new AccountError(t('auth.antiBotFailed'), 403, 'turnstile_failed');
    }
    const body: Record<string, string> = { username, password: await clientPasswordKey(username, password) };
    if (token !== null) body.turnstileToken = token;
    const res = await this.call('/api/auth/register', body);
    const r = await this.jsonOrFail<RegisterAnswer>(res);
    this.adopt(sessionPart(r));
    return r;
  }

  async login(username: string, password: string): Promise<AccountSession> {
    if (username.trim().length === 0 || password.length === 0) throw new AccountError(t('auth.empty'), 400, 'empty');
    const res = await this.call('/api/auth/login', { username: username.trim(), password: await clientPasswordKey(username.trim(), password) });
    const s = await this.jsonOrFail<AccountSession>(res);
    return this.adopt(s);
  }

  async recover(username: string, code: string, newPassword: string): Promise<AccountSession & { codesLeft: number }> {
    const p = passwordIssue(newPassword, username);
    if (p !== null) throw issueError(p, 'bad_password');
    const res = await this.call('/api/auth/recover', { username: username.trim(), code, password: await clientPasswordKey(username.trim(), newPassword) });
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
    let token: string | null;
    try {
      token = await this.antiBot();
    } catch {
      throw new AccountError(t('auth.antiBotFailed'), 403, 'turnstile_failed');
    }
    return this.jsonOrFail<TvStartAnswer>(await this.call('/api/auth/tv/start', token !== null ? { turnstileToken: token } : {}));
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

  /**
   * Full-page redirect target of the provider buttons: a sign-in, `link` (PERFIL's VINCULAR, true
   * or 'link': this browser must have proved a credential in the last minutes, see fresh) or
   * 'reauth' (PERFIL's "confirm it is you" with a provider already on the account).
   */
  oauthUrl(provider: OAuthProvider, link: boolean | 'link' | 'reauth' = false): string {
    const q = link === 'reauth' ? '?reauth=1' : link ? '?link=1' : '';
    return `${this.apiBase}/api/auth/oauth/${provider}/start${q}`;
  }

  /**
   * This browser proved a credential a few minutes ago (a sign-in or a re-authentication: the
   * session's authAt), so a link, an unlink, a first password or a maintainer's work goes straight
   * through; false for a TV (its scope never allows them) and when it is too old.
   */
  fresh(): boolean {
    const a = this.account;
    return a !== null && a.tv !== true && typeof a.authAt === 'number' && this.now() - a.authAt < FRESH_MS;
  }

  /** A password account confirms it is them (POST /api/auth/reauth): the session comes back fresh. */
  async reauth(password: string): Promise<AccountSession> {
    const name = this.account?.name ?? '';
    if (password.length === 0) throw new AccountError(t('auth.empty'), 400, 'empty');
    const s = await this.jsonOrFail<AccountSession>(await this.call('/api/auth/reauth', { password: await clientPasswordKey(name, password) }, await this.bearer()));
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

  async changePassword(oldPassword: string | null, newPassword: string): Promise<void> {
    const name = this.account?.name ?? '';
    const p = passwordIssue(newPassword, name);
    if (p !== null) throw issueError(p, 'bad_password');
    const body: Record<string, string> = { password: await clientPasswordKey(name, newPassword) };
    if (oldPassword !== null) body.oldPassword = await clientPasswordKey(name, oldPassword);
    await this.jsonOrFail(await this.call('/api/auth/password', body, await this.bearer()));
  }

  async newRecoveryCodes(password: string | null): Promise<string[]> {
    const name = this.account?.name ?? '';
    const body: Record<string, string> = {};
    if (password !== null) body.password = await clientPasswordKey(name, password);
    const r = await this.jsonOrFail<{ recoveryCodes: string[] }>(await this.call('/api/auth/recovery-codes', body, await this.bearer()));
    return r.recoveryCodes;
  }

  /**
   * Change the username (once per 30 days). The client key is salted with the username, so a
   * password account gives its password: the server checks the key of the old name and stores the
   * key of the new one (other devices are signed out). An OAuth-only account passes null.
   */
  async rename(username: string, password: string | null): Promise<AccountSession> {
    const u = usernameIssue(username);
    if (u !== null) throw issueError(u, 'bad_username');
    const body: Record<string, string> = { username };
    if (password !== null) {
      body.password = await clientPasswordKey(this.account?.name ?? '', password);
      body.newPassword = await clientPasswordKey(username, password);
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
