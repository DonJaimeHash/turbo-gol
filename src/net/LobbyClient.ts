/**
 * Custom lobbies, browser side (server/src/LobbyDO.ts, LobbyDirectoryDO.ts): the public list
 * (GET /api/lobbies), create (POST /api/lobbies), join by code (POST /api/lobbies/join), then one
 * lobby socket (/lobby/<id>, ['tg1', 'ticket.<jwt>'], JSON text frames) that carries the live state
 * (members, teams, host, settings) and, when the host starts, this player's own queue result: the
 * same QueueResult / QueueResultP2p POST /api/queue answers, handed to the Game as an assignment.
 *
 * The lobby socket stays open during the match (it hibernates on the server: no cost), so the
 * player comes back to the same lobby afterwards (`back()`); a ping every PING_MS keeps proxies from
 * dropping the idle socket (answered by the server's auto-response, without waking it).
 *
 * A lobby may carry experimental rules (LobbySettings.physics: signed-in members only, P2P only,
 * the match counts for nothing): create sends them, `settings` changes them, the state shows them.
 *
 * A refused request (AccountError) or a lobby socket 'error' (onError) carries the player's text:
 * the error.lobby.* text of the server's code (serverText, src/i18n.ts), else the server's message,
 * else a generic one (error.server, the status to the console only; error.lobby.start_failed on the
 * socket).
 *
 * Reconnection (plan PR 12): a socket that drops without a reason that ends the stay (kicked,
 * closed, replaced by another tab, left) puts the client in 'reconnecting' and it joins again by
 * code, quietly, with RECONNECT_DELAYS_MS between tries for RECONNECT_WINDOW_MS (the server keeps
 * the place for LobbyDO's LOBBY_GRACE_MS, and an existing member is admitted again as it was, host
 * included). The tab coming back into view (visibilitychange) and the network coming back (online)
 * try at once; a visible tab whose open socket answers no ping within PONG_WAIT_MS (a phone that put
 * the browser away keeps a dead socket) counts as dropped. A refusal that ends it (kicked, no lobby,
 * closed, full) or the window running out closes the stay (onClosed).
 *
 * peek(code): GET /api/lobbies/peek, the summary a join link's sheet shows before the join.
 */
import { WS_SUBPROTOCOL, WS_TICKET_PREFIX } from './protocol';
import type { QueueResult } from './protocol';
import type { QueueResultP2p } from './p2p/protocol';
import type { LobbyClientMsg, LobbyServerMsg, LobbySettings, LobbyState, LobbySummary, LobbyTicketAnswer, RegionId } from './account';
import { AccountError } from './AccountClient';
import { resolveWsUrl } from './NetClient';
import type { FetchLike, ResponseLike, WebSocketFactory, WebSocketLike } from './NetClient';
import { hasServerText, serverText, t } from '../i18n';

const PING_MS = 25_000;
/** Waits between reconnection tries (ms; the last one repeats) and how long they go on. */
export const RECONNECT_DELAYS_MS: readonly number[] = [500, 1_500, 3_000, 5_000, 8_000];
export const RECONNECT_WINDOW_MS = 90_000;
/** A visible tab's check of an open socket: no pong (or any frame) this soon after a ping -> dropped. */
export const PONG_WAIT_MS = 4_000;
/** Lobby socket closes that end the stay (LobbyDO): kicked, closed, replaced by another tab; 1000 = left. */
const CLOSE_FINAL: Record<number, string> = { 4003: 'kicked', 4004: 'ended', 4000: 'replaced', 1000: 'left' };
/** Refusals of the join again that end it: the lobby is gone, or this player has no place in it any more. */
const JOIN_FINAL: Record<string, string> = { kicked: 'kicked', no_lobby: 'ended', closed: 'ended', full: 'lost', bad_password: 'lost', account_required: 'lost' };

export type LobbyStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface LobbyClientOptions {
  apiBase?: string;
  fetchFn?: FetchLike;
  webSocketFactory?: WebSocketFactory;
  /** The Bearer session to use (NetClient.ensureGuest: the account when signed in, else the guest). */
  bearer: () => Promise<string>;
  /** Where visibilitychange / online come from (default the page's document and window; null in tests: none). */
  events?: { doc: Pick<Document, 'addEventListener'> & { readonly hidden: boolean }; win: Pick<Window, 'addEventListener'> } | null;
  /** Reconnection timing (tests). */
  reconnectDelaysMs?: readonly number[];
  reconnectWindowMs?: number;
  pongWaitMs?: number;
  now?: () => number;
}

export interface LobbyCreate {
  settings: LobbySettings;
  password: string | null;
  region: RegionId | null;
}

/** The player's text for a lobby socket close / error the menu shows. */
export function lobbyCloseText(reason: string): string {
  switch (reason) {
    case 'kicked':
      return t('net.lobby.closedKicked');
    case 'idle':
    case 'empty':
      return t('net.lobby.closedEnded');
    case 'expired':
      return t('net.lobby.closedExpired');
    case 'replaced':
      return t('net.lobby.closedReplaced');
    default:
      return t('net.lobby.closedLost');
  }
}

export class LobbyClient {
  status: LobbyStatus = 'idle';
  state: LobbyState | null = null;
  lobbyId: string | null = null;
  code: string | null = null;
  /** The password typed to join / create, or the host's new one (kept so a rejoin, a reload's too, works). */
  password: string | null = null;

  onState: ((s: LobbyState) => void) | null = null;
  /** The host started: this member's queue result. */
  onMatch: ((r: QueueResult | QueueResultP2p) => void) | null = null;
  /** The server refused something in the lobby: its code and the player's text for it. */
  onError: ((code: string, message: string) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  /** The status changed between 'open' and 'reconnecting' ("Reconectando a la sala…"). */
  onStatus: (() => void) | null = null;

  private readonly apiBase: string;
  private readonly fetchFn: FetchLike;
  private readonly makeWs: WebSocketFactory;
  private readonly bearer: () => Promise<string>;
  private ws: WebSocketLike | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private readonly delays: readonly number[];
  private readonly windowMs: number;
  private readonly pongWaitMs: number;
  private readonly now: () => number;
  /** Reconnecting: when the tries stop, the next try's timer, the tries so far, a try in flight. */
  private reconnectUntil = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private tries = 0;
  private trying = false;
  /** The visible tab's ping check (PONG_WAIT_MS). */
  private pongTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: LobbyClientOptions) {
    this.apiBase = opts.apiBase ?? '';
    this.fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init) as unknown as Promise<ResponseLike>);
    this.makeWs = opts.webSocketFactory ?? ((url, protocols) => new WebSocket(url, protocols) as unknown as WebSocketLike);
    this.bearer = opts.bearer;
    this.delays = opts.reconnectDelaysMs ?? RECONNECT_DELAYS_MS;
    this.windowMs = opts.reconnectWindowMs ?? RECONNECT_WINDOW_MS;
    this.pongWaitMs = opts.pongWaitMs ?? PONG_WAIT_MS;
    this.now = opts.now ?? (() => Date.now());
    const ev = opts.events === undefined ? (typeof document !== 'undefined' && typeof window !== 'undefined' ? { doc: document, win: window } : null) : opts.events;
    if (ev !== null) {
      ev.doc.addEventListener('visibilitychange', () => {
        if (!ev.doc.hidden) this.wake();
      });
      ev.win.addEventListener('online', () => this.wake());
    }
  }

  get inLobby(): boolean {
    return this.status === 'connecting' || this.status === 'open' || this.status === 'reconnecting';
  }

  get reconnecting(): boolean {
    return this.status === 'reconnecting';
  }

  get me(): LobbyState['members'][number] | null {
    const s = this.state;
    return s ? (s.members.find((m) => m.id === s.you) ?? null) : null;
  }

  get isHost(): boolean {
    return this.me?.host === true;
  }

  /** `auth` false: no session (GET /api/lobbies is public, so browsing never registers a guest). */
  private async call<T>(path: string, body?: unknown, auth = true): Promise<T> {
    const headers: Record<string, string> = body === undefined ? {} : { 'content-type': 'application/json' };
    if (auth) {
      try {
        headers.authorization = 'Bearer ' + (await this.bearer());
      } catch (e) {
        throw e instanceof AccountError ? e : new AccountError(t('net.lobby.sessionFailed'), 0, 'session');
      }
    }
    let res: ResponseLike;
    try {
      res = await this.fetchFn(this.apiBase + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new AccountError(t('error.network'), 0, 'network');
    }
    if (!res.ok) {
      let code = 'http';
      let serverMessage = '';
      try {
        const b = (await res.json()) as { error?: unknown; message?: unknown };
        if (typeof b.error === 'string') code = b.error;
        if (typeof b.message === 'string' && b.message !== b.error) serverMessage = b.message;
      } catch {
        /* no body */
      }
      // Never an empty fallback: a code the Spanish server details but sent bare (a lobby list
      // rate_limited, a create refused with matchmaking_off) keeps the generic text in Spanish, as
      // before. The status goes to the console, never into the player's text.
      if (!hasServerText('lobby', code) && serverMessage === '') console.warn(`lobby: ${path} answered ${res.status} ${code}`);
      throw new AccountError(serverText('lobby', code, serverMessage || t('error.server')), res.status, code);
    }
    return (await res.json()) as T;
  }

  /** The lobby a join link names, before joining it (no session: a first visit by a link has none). */
  peek(code: string): Promise<LobbySummary> {
    return this.call<LobbySummary>('/api/lobbies/peek?code=' + encodeURIComponent(code), undefined, false);
  }

  async list(region: RegionId | null): Promise<LobbySummary[]> {
    const r = await this.call<{ lobbies: LobbySummary[] }>('/api/lobbies' + (region ? '?region=' + region : ''), undefined, false);
    return r.lobbies;
  }

  async create(c: LobbyCreate): Promise<void> {
    this.leave();
    const answer = await this.call<LobbyTicketAnswer>('/api/lobbies', {
      name: c.settings.name,
      mode: c.settings.mode,
      visibility: c.settings.visibility,
      net: c.settings.net,
      matchLengthSeconds: c.settings.matchLengthSeconds,
      // Experimental rules (a signed-in host only: the Worker answers a guest 403 account_required).
      physics: c.settings.physics ?? undefined,
      password: c.password ?? undefined,
      region: c.region ?? undefined,
    });
    this.password = c.password;
    this.open(answer);
  }

  async join(code: string, password: string | null): Promise<void> {
    this.leave();
    const answer = await this.call<LobbyTicketAnswer>('/api/lobbies/join', { code, password: password ?? undefined });
    this.password = password;
    this.open(answer);
  }

  private open(answer: LobbyTicketAnswer): void {
    this.lobbyId = answer.lobbyId;
    this.code = answer.code;
    if (this.status !== 'reconnecting') this.status = 'connecting';
    const ws = this.makeWs(resolveWsUrl(answer.wsUrl), [WS_SUBPROTOCOL, WS_TICKET_PREFIX + answer.ticket]);
    this.ws = ws;
    ws.onopen = () => {
      if (ws !== this.ws) return;
      const back = this.status === 'reconnecting';
      this.status = 'open';
      this.stopRetry();
      if (back && this.onStatus) this.onStatus();
      this.ping = setInterval(() => {
        try {
          ws.send('ping');
        } catch {
          /* closing */
        }
      }, PING_MS);
    };
    ws.onmessage = (ev) => {
      if (ws !== this.ws || typeof ev.data !== 'string') return;
      this.stopPongCheck(); // any frame says the socket lives
      if (ev.data === 'pong') return;
      let m: LobbyServerMsg;
      try {
        m = JSON.parse(ev.data) as LobbyServerMsg;
      } catch {
        return;
      }
      if (m.t === 'state') {
        this.state = m.lobby;
        this.code = m.lobby.code;
        if (this.onState) this.onState(m.lobby);
      } else if (m.t === 'match') {
        if (this.onMatch) this.onMatch(m.result as QueueResult | QueueResultP2p);
      } else if (m.t === 'error') {
        // Every refusal of a lobby action has a server text; a bare code is a start the matchmaker refused.
        const serverMessage = typeof m.message === 'string' && m.message !== m.code ? m.message : '';
        if (this.onError) this.onError(m.code, serverText('lobby', m.code, serverMessage || t('error.lobby.start_failed')));
      } else if (m.t === 'closed') {
        this.finish(m.reason);
      }
    };
    ws.onclose = (ev) => {
      if (ws !== this.ws) return;
      const final = CLOSE_FINAL[ev.code];
      if (final !== undefined) this.finish(ev.code === 4004 && ev.reason ? ev.reason : final);
      else this.dropped(`${ev.code}${ev.reason ? ' ' + ev.reason : ''}`);
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  /**
   * The socket dropped without ending the stay: 'reconnecting', the join again by code at once and
   * then every RECONNECT_DELAYS_MS while the window lasts. `why` (the close code) goes to the console.
   */
  private dropped(why: string): void {
    console.warn(`lobby: the socket dropped (${why}): reconnecting`);
    this.stopPing();
    this.stopPongCheck();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      try {
        ws.close(1000, 'reconnect');
      } catch {
        /* closed */
      }
    }
    if (this.status !== 'reconnecting') {
      this.status = 'reconnecting';
      this.reconnectUntil = this.now() + this.windowMs;
      this.tries = 0;
      if (this.onStatus) this.onStatus();
      this.scheduleRetry(0);
      return;
    }
    // A reconnection's socket that did not hold: the next try after the wait.
    if (this.now() >= this.reconnectUntil) this.finish('lost');
    else this.scheduleRetry(this.delays[Math.min(this.tries++, this.delays.length - 1)]);
  }

  private scheduleRetry(ms: number): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.retry();
    }, ms);
  }

  private stopRetry(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.tries = 0;
  }

  /** One join again by code (an existing member: the same place); a refusal that ends it closes the stay. */
  private async retry(): Promise<void> {
    if (this.status !== 'reconnecting' || this.trying || this.code === null) return;
    this.trying = true;
    const code = this.code;
    let answer: LobbyTicketAnswer | null = null;
    let final: string | null = null;
    try {
      answer = await this.call<LobbyTicketAnswer>('/api/lobbies/join', { code, password: this.password ?? undefined });
    } catch (e) {
      final = e instanceof AccountError ? (JOIN_FINAL[e.code] ?? null) : null;
      console.warn(`lobby: reconnect try ${this.tries + 1} failed: ${e instanceof AccountError ? `${e.status} ${e.code}` : String(e)}`);
    } finally {
      this.trying = false;
    }
    if (this.status !== 'reconnecting' || this.code !== code) return; // left meanwhile
    if (answer !== null) {
      this.open(answer);
      return;
    }
    if (final !== null || this.now() >= this.reconnectUntil) {
      this.finish(final ?? 'lost');
      return;
    }
    this.scheduleRetry(this.delays[Math.min(this.tries++, this.delays.length - 1)]);
  }

  /**
   * The tab is visible again or the network is back: a reconnection tries at once; an open socket
   * is pinged and counts as dropped when nothing comes back within PONG_WAIT_MS.
   */
  private wake(): void {
    if (this.status === 'reconnecting') {
      if (this.trying || this.ws !== null) return; // a try, or its socket, on the way
      this.scheduleRetry(0);
      return;
    }
    const ws = this.ws;
    if (this.status !== 'open' || ws === null || this.pongTimer !== null) return;
    try {
      ws.send('ping');
    } catch {
      this.dropped('send failed');
      return;
    }
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      if (this.ws === ws && this.status === 'open') this.dropped('no pong');
    }, this.pongWaitMs);
  }

  private stopPongCheck(): void {
    if (this.pongTimer !== null) clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }

  private finish(reason: string): void {
    const was = this.inLobby;
    this.stopPing();
    this.stopPongCheck();
    this.stopRetry();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      try {
        ws.close(1000, 'bye');
      } catch {
        /* closed */
      }
    }
    this.status = 'closed';
    if (was && this.onClosed) this.onClosed(reason);
  }

  private stopPing(): void {
    if (this.ping !== null) {
      clearInterval(this.ping);
      this.ping = null;
    }
  }

  send(msg: LobbyClientMsg): void {
    const ws = this.ws;
    if (!ws || this.status !== 'open') return;
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* closing */
    }
  }

  setTeam(team: 0 | 1): void {
    this.send({ t: 'team', team });
  }

  updateSettings(settings: Partial<LobbySettings>, password?: string | null): void {
    // The host's new password opens the lobby again after a reload past the grace (rejoinStore.ts LobbyStay).
    if (password !== undefined) this.password = password;
    this.send(password === undefined ? { t: 'settings', settings } : { t: 'settings', settings, password });
  }

  kick(member: string): void {
    this.send({ t: 'kick', member });
  }

  /** The host hands the lobby to `member`. */
  makeHost(member: string): void {
    this.send({ t: 'host', member });
  }

  /** The host moves `member` to `team` (one's own move: setTeam). */
  move(member: string, team: 0 | 1): void {
    this.send({ t: 'move', member, team });
  }

  setReady(ready: boolean): void {
    this.send({ t: 'ready', ready });
  }

  start(): void {
    this.send({ t: 'start' });
  }

  /** Back from the lobby's match (the lobby opens again when every member is back). */
  back(): void {
    this.send({ t: 'back' });
  }

  /**
   * Leave the lobby for good (closes the socket). Silent: no onClosed. A socket still connecting (a
   * reconnection's try, a join's) is let go to say the leave once it opens, so the server frees the
   * place and hands the host on now rather than after its grace.
   */
  leave(): void {
    if (!this.ws) {
      // Reconnecting between tries: no socket to say it on; the server's grace removes the place.
      this.stopRetry();
      this.status = 'idle';
      this.state = null;
      this.lobbyId = null;
      this.code = null;
      return;
    }
    if (this.status === 'open') this.send({ t: 'leave' });
    else {
      const ws = this.ws;
      this.ws = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onopen = () => {
        try {
          ws.send(JSON.stringify({ t: 'leave' } satisfies LobbyClientMsg));
          ws.close(1000, 'bye');
        } catch {
          /* closed */
        }
      };
    }
    const cb = this.onClosed;
    this.onClosed = null;
    this.finish('left');
    this.onClosed = cb;
    this.state = null;
    this.lobbyId = null;
    this.code = null;
    this.status = 'idle';
  }
}
