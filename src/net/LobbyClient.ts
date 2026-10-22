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
 * else a generic one (error.server with the status; error.lobby.start_failed on the socket).
 */
import { WS_SUBPROTOCOL, WS_TICKET_PREFIX } from './protocol';
import type { QueueResult } from './protocol';
import type { QueueResultP2p } from './p2p/protocol';
import type { LobbyClientMsg, LobbyServerMsg, LobbySettings, LobbyState, LobbySummary, LobbyTicketAnswer, RegionId } from './account';
import { AccountError } from './AccountClient';
import { resolveWsUrl } from './NetClient';
import type { FetchLike, ResponseLike, WebSocketFactory, WebSocketLike } from './NetClient';
import { serverText, t } from '../i18n';

const PING_MS = 25_000;

export type LobbyStatus = 'idle' | 'connecting' | 'open' | 'closed';

export interface LobbyClientOptions {
  apiBase?: string;
  fetchFn?: FetchLike;
  webSocketFactory?: WebSocketFactory;
  /** The Bearer session to use (NetClient.ensureGuest: the account when signed in, else the guest). */
  bearer: () => Promise<string>;
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
  /** The password typed to join / create (kept so a reload-free rejoin works). */
  password: string | null = null;

  onState: ((s: LobbyState) => void) | null = null;
  /** The host started: this member's queue result. */
  onMatch: ((r: QueueResult | QueueResultP2p) => void) | null = null;
  /** The server refused something in the lobby: its code and the player's text for it. */
  onError: ((code: string, message: string) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;

  private readonly apiBase: string;
  private readonly fetchFn: FetchLike;
  private readonly makeWs: WebSocketFactory;
  private readonly bearer: () => Promise<string>;
  private ws: WebSocketLike | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;

  constructor(opts: LobbyClientOptions) {
    this.apiBase = opts.apiBase ?? '';
    this.fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init) as unknown as Promise<ResponseLike>);
    this.makeWs = opts.webSocketFactory ?? ((url, protocols) => new WebSocket(url, protocols) as unknown as WebSocketLike);
    this.bearer = opts.bearer;
  }

  get inLobby(): boolean {
    return this.status === 'connecting' || this.status === 'open';
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
      // rate_limited, a create refused with matchmaking_off) keeps the generic text in Spanish, as before.
      throw new AccountError(serverText('lobby', code, serverMessage || t('error.server', { status: res.status })), res.status, code);
    }
    return (await res.json()) as T;
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
    this.status = 'connecting';
    const ws = this.makeWs(resolveWsUrl(answer.wsUrl), [WS_SUBPROTOCOL, WS_TICKET_PREFIX + answer.ticket]);
    this.ws = ws;
    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.status = 'open';
      this.ping = setInterval(() => {
        try {
          ws.send('ping');
        } catch {
          /* closing */
        }
      }, PING_MS);
    };
    ws.onmessage = (ev) => {
      if (ws !== this.ws || typeof ev.data !== 'string' || ev.data === 'pong') return;
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
      this.finish(ev.reason || (ev.code === 4003 ? 'kicked' : 'lost'));
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private finish(reason: string): void {
    const was = this.inLobby;
    this.stopPing();
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
    this.send(password === undefined ? { t: 'settings', settings } : { t: 'settings', settings, password });
  }

  kick(member: string): void {
    this.send({ t: 'kick', member });
  }

  start(): void {
    this.send({ t: 'start' });
  }

  /** Back from the lobby's match (the lobby opens again when every member is back). */
  back(): void {
    this.send({ t: 'back' });
  }

  /** Leave the lobby for good (closes the socket). Silent: no onClosed. */
  leave(): void {
    if (!this.ws) {
      this.status = 'idle';
      return;
    }
    this.send({ t: 'leave' });
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
