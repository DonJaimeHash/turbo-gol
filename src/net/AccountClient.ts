/**
 * Browser side of registered accounts (server/src/accountRoutes.ts): sign-up / sign-in with a
 * username and password (the password is turned into clientPasswordKey here and never sent),
 * Google / Discord sign-in (a full-page redirect; the server answers back to `/#auth=<result>`),
 * the short Bearer session (1 h) refreshed from the HttpOnly refresh cookie, the profile (/api/me:
 * ratings per playlist, ranked ban), the leaderboard and the rating change of a ranked match.
 *
 * Persistence: the refresh token is an HttpOnly cookie the page cannot read; localStorage only keeps
 * a hint (ACCOUNT_HINT_KEY: "this browser was signed in as X") so a guest's page load does not
 * spend a refresh request. NetClient asks `sessionForQueue()` before using its guest session: a
 * signed-in player queues, joins lobbies and plays under the account.
 *
 * The HTTP implementation is injectable for node tests (tests/account-client.test.mjs).
 */
import { clientPasswordKey, passwordProblem, usernameProblem } from './account';
import type { AccountSession, LeaderboardAnswer, MeInfo, OAuthProvider, Playlist, RankedResultAnswer, RegisterAnswer } from './account';
import type { FetchLike, ResponseLike, StorageLike } from './NetClient';
import { STORAGE_PREFIX } from '../brand';

export const ACCOUNT_HINT_KEY = STORAGE_PREFIX + 'account';
/** Refresh when less than this is left on the Bearer session. */
const REFRESH_MARGIN_MS = 2 * 60_000;

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

/** What `#auth=...` in the URL says after an OAuth round trip (consumed once). */
export type AuthHashResult = { kind: 'ok' | 'new' | 'linked' } | { kind: 'error'; code: string };

export function parseAuthHash(hash: string): AuthHashResult | null {
  const m = /(?:^#|&)auth=([a-z]+)(?::([a-z_]+))?/.exec(hash);
  if (!m) return null;
  if (m[1] === 'ok' || m[1] === 'new' || m[1] === 'linked') return { kind: m[1] };
  if (m[1] === 'error') return { kind: 'error', code: m[2] ?? 'unknown' };
  return null;
}

/** Spanish text for an OAuth error code coming back in the hash. */
export function oauthErrorText(code: string): string {
  switch (code) {
    case 'cancelled':
      return 'Cancelaste el inicio de sesión';
    case 'already_linked':
      return 'Esa cuenta ya está vinculada a otro usuario';
    case 'provider_disabled':
      return 'Ese método de inicio de sesión no está habilitado';
    case 'bad_state':
      return 'El inicio de sesión expiró, probá de nuevo';
    default:
      return 'No se pudo iniciar sesión, probá de nuevo';
  }
}

function isSession(v: unknown): v is AccountSession {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return o.kind === 'account' && typeof o.playerId === 'string' && typeof o.name === 'string' && typeof o.session === 'string' && typeof o.expiresAt === 'number';
}

export interface AccountClientOptions {
  apiBase?: string;
  fetchFn?: FetchLike;
  /** null disables the hint (tests). */
  storage?: StorageLike | null;
  now?: () => number;
  /** A Turnstile token for registration when the server wants one (NetClient.antiBotToken), null = none. */
  antiBot?: () => Promise<string | null>;
}

export class AccountClient {
  /** The signed-in account's Bearer session, null for a guest. */
  account: AccountSession | null = null;
  /** Last /api/me answer (null for a guest or before the first fetch). */
  me: MeInfo | null = null;
  /** Sign-in / sign-out / rename / profile refresh happened (menus redraw). */
  onChange: (() => void) | null = null;

  private readonly apiBase: string;
  private readonly fetchFn: FetchLike;
  private readonly storage: StorageLike | null;
  private readonly now: () => number;
  private refreshing: Promise<AccountSession | null> | null = null;
  private readonly antiBot: () => Promise<string | null>;

  constructor(opts: AccountClientOptions = {}) {
    this.antiBot = opts.antiBot ?? (() => Promise.resolve(null));
    this.apiBase = opts.apiBase ?? '';
    this.fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, { ...init, credentials: 'same-origin' } as RequestInit) as unknown as Promise<ResponseLike>);
    this.storage = opts.storage === undefined ? defaultStorage() : opts.storage;
    this.now = opts.now ?? Date.now;
  }

  get signedIn(): boolean {
    return this.account !== null;
  }

  /** The name this browser was last signed in with (the refresh cookie probably still works), null for a guest. */
  get hintName(): string | null {
    try {
      const raw = this.storage?.getItem(ACCOUNT_HINT_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw) as { name?: unknown };
      return typeof o.name === 'string' ? o.name : null;
    } catch {
      return null;
    }
  }

  private setHint(name: string | null): void {
    try {
      if (name === null) this.storage?.removeItem(ACCOUNT_HINT_KEY);
      else this.storage?.setItem(ACCOUNT_HINT_KEY, JSON.stringify({ name }));
    } catch {
      /* storage disabled */
    }
  }

  private changed(): void {
    if (this.onChange) this.onChange();
  }

  private adopt(s: AccountSession): AccountSession {
    this.account = s;
    this.setHint(s.name);
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
      throw new AccountError('No hay conexión con el servidor', 0, 'network');
    }
  }

  private async fail(res: ResponseLike): Promise<never> {
    let code = 'http';
    let message = `Error del servidor (${res.status})`;
    let retry = 0;
    try {
      const b = (await res.json()) as { error?: unknown; message?: unknown; retryAfterMs?: unknown };
      if (typeof b.error === 'string') code = b.error;
      if (typeof b.message === 'string' && b.message !== b.error) message = b.message;
      if (typeof b.retryAfterMs === 'number') retry = b.retryAfterMs;
    } catch {
      /* no JSON body */
    }
    if (code === 'rate_limited' && message.startsWith('Error')) message = 'Demasiados intentos, esperá un minuto';
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

  /** A Bearer session that is valid for a few more minutes (refreshed when needed), null for a guest. */
  async sessionForQueue(): Promise<AccountSession | null> {
    const a = this.account;
    if (a === null) return null;
    if (a.expiresAt - this.now() > REFRESH_MARGIN_MS) return a;
    return this.refresh();
  }

  /** The server refused our session (401): refresh once. */
  async sessionRejected(): Promise<AccountSession | null> {
    if (this.account === null) return null;
    return this.refresh();
  }

  async register(username: string, password: string): Promise<RegisterAnswer> {
    const u = usernameProblem(username);
    if (u !== null) throw new AccountError(u, 400, 'bad_username');
    const p = passwordProblem(password, username);
    if (p !== null) throw new AccountError(p, 400, 'bad_password');
    let token: string | null;
    try {
      token = await this.antiBot();
    } catch {
      throw new AccountError('Verificación anti-bots falló, reintentá', 403, 'turnstile_failed');
    }
    const body: Record<string, string> = { username, password: await clientPasswordKey(username, password) };
    if (token !== null) body.turnstileToken = token;
    const res = await this.call('/api/auth/register', body);
    const r = await this.jsonOrFail<RegisterAnswer>(res);
    this.adopt({ kind: 'account', playerId: r.playerId, name: r.name, session: r.session, expiresAt: r.expiresAt });
    return r;
  }

  async login(username: string, password: string): Promise<AccountSession> {
    if (username.trim().length === 0 || password.length === 0) throw new AccountError('Completá usuario y contraseña', 400, 'empty');
    const res = await this.call('/api/auth/login', { username: username.trim(), password: await clientPasswordKey(username.trim(), password) });
    const s = await this.jsonOrFail<AccountSession>(res);
    return this.adopt(s);
  }

  async recover(username: string, code: string, newPassword: string): Promise<AccountSession & { codesLeft: number }> {
    const p = passwordProblem(newPassword, username);
    if (p !== null) throw new AccountError(p, 400, 'bad_password');
    const res = await this.call('/api/auth/recover', { username: username.trim(), code, password: await clientPasswordKey(username.trim(), newPassword) });
    const s = await this.jsonOrFail<AccountSession & { codesLeft: number }>(res);
    this.adopt({ kind: 'account', playerId: s.playerId, name: s.name, session: s.session, expiresAt: s.expiresAt });
    return s;
  }

  async logout(): Promise<void> {
    try {
      await this.call('/api/auth/logout', {});
    } catch {
      /* the local state goes anyway */
    }
    this.account = null;
    this.me = null;
    this.setHint(null);
    this.changed();
  }

  /** Full-page redirect target of the "Sign in with Google / Discord" buttons (`link`: add it to the signed-in account). */
  oauthUrl(provider: OAuthProvider, link = false): string {
    return `${this.apiBase}/api/auth/oauth/${provider}/start${link ? '?link=1' : ''}`;
  }

  private async bearer(): Promise<string> {
    const s = await this.sessionForQueue();
    if (s === null) throw new AccountError('Iniciá sesión primero', 401, 'unauthorized');
    return s.session;
  }

  async changePassword(oldPassword: string | null, newPassword: string): Promise<void> {
    const name = this.account?.name ?? '';
    const p = passwordProblem(newPassword, name);
    if (p !== null) throw new AccountError(p, 400, 'bad_password');
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
    const u = usernameProblem(username);
    if (u !== null) throw new AccountError(u, 400, 'bad_username');
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

  async leaderboard(playlist: Playlist): Promise<LeaderboardAnswer> {
    const s = await this.sessionForQueue().catch(() => null);
    return this.jsonOrFail<LeaderboardAnswer>(await this.call('/api/leaderboard?playlist=' + playlist, undefined, s?.session));
  }

  async rankedResult(matchId: string): Promise<RankedResultAnswer> {
    return this.jsonOrFail<RankedResultAnswer>(await this.call('/api/ranked/result?matchId=' + encodeURIComponent(matchId), undefined, await this.bearer()));
  }

  /**
   * Poll the rating change of a finished ranked match until AccountsDO has it (the MatchDO reports
   * within a second of the whistle): up to `tries` x `everyMs`. Resolves the last answer.
   */
  async waitRankedResult(matchId: string, tries = 15, everyMs = 1000): Promise<RankedResultAnswer> {
    let last: RankedResultAnswer = { status: 'pending' };
    for (let i = 0; i < tries; i++) {
      try {
        last = await this.rankedResult(matchId);
      } catch {
        /* keep polling */
      }
      if (last.status !== 'pending') break;
      await new Promise((r) => setTimeout(r, everyMs));
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
