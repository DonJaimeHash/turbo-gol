/**
 * LobbyDO: one custom-match lobby (private by code, or listed in the public lobby browser): a
 * join code, an optional password, public or private, the host's settings (name,
 * playlist, P2P or server, match length) and the members on two teams. Hibernating WebSockets
 * (JSON text frames, src/net/account.ts LobbyServerMsg / LobbyClientMsg): a lobby where nobody
 * talks costs nothing; the whole state lives in one storage record so a wake-up rebuilds it.
 *
 *   POST /internal/create { lobbyId, code, region, socketBase, settings, password?, host: { playerId, name, guest } }
 *   POST /internal/admit  { playerId, name, guest, password? } -> { ok } | 403 bad_password / kicked | 409 full | 410 closed
 *   GET  /lobby (upgrade, through the Worker's /lobby/<id> gate with a role 'lobby' ticket)
 *
 * Flow: the Worker admits a player (password, room, kick list), mints a lobby ticket and the
 * socket follows within ADMIT_TTL_MS; the member lands on the team with fewer players. The host
 * starts -> the region's matchmaker forms the match with these exact teams (POST /custom: P2P room
 * or MatchDO, bots in the free slots, the usual locks) -> every member gets its own result on the
 * socket ({ t: 'match' }) and plays; the lobby stays open meanwhile (status 'in_game') and each
 * member's { t: 'back' } brings it back to 'open'. The host leaving hands the lobby to the
 * longest-standing member; the last member leaving (or idling past IDLE_CLOSE_MS without sockets)
 * closes it and removes it from LobbyDirectoryDO. Custom matches are never rated.
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import { error, json, readJson } from './env';
import { INTERNAL_HEADER, checkInternal, internalSecret } from './auth';
import { MODES } from '../../src/sim/constants';
import { LOBBY_LENGTHS, isPlaylist } from '../../src/net/account';
import { DEFAULT_MATCH_SECONDS } from '../../src/game/Match';
import type { LobbyClientMsg, LobbyMember, LobbyServerMsg, LobbySettings, LobbyState, LobbySummary } from '../../src/net/account';

const ADMIT_TTL_MS = 90_000;
const IDLE_CLOSE_MS = 2 * 60_000;
const MAX_AGE_MS = 6 * 60 * 60_000;
const ALARM_MS = 60_000;
const IN_GAME_RESET_MS = 40 * 60_000;
const MAX_FRAME = 2048;
const CLOSE_KICKED = 4003;
const CLOSE_CLOSED = 4004;

interface MemberRec {
  id: string;
  playerId: string;
  name: string;
  guest: boolean;
  team: 0 | 1;
  joinedAt: number;
  inGame: boolean;
}

interface AdmitRec {
  playerId: string;
  name: string;
  guest: boolean;
  until: number;
}

export interface LobbyRecord {
  lobbyId: string;
  code: string;
  region: string;
  /** wss://host of the deployment: the match results carry absolute socket URLs. */
  socketBase: string;
  createdAt: number;
  settings: LobbySettings;
  pwHash: string | null;
  members: MemberRec[];
  hostId: string;
  nextMember: number;
  status: LobbyState['status'];
  statusAt: number;
  admits: AdmitRec[];
  kicked: string[];
  lastSocketAt: number;
}

// ---- pure helpers (server/test/lobby.test.mjs) ------------------------------------------------

/** 3-24 visible chars (letters, digits, space, _ . - ! ?), else null. */
export function sanitizeLobbyName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.normalize('NFKC').replace(/[^\p{L}\p{N} _.\-!?#]/gu, '').replace(/\s+/g, ' ').trim();
  return s.length >= 3 && s.length <= 24 ? s : null;
}

/** The team a new member joins: the one with fewer members (blue on a tie); null when both are full. */
export function teamForNewMember(members: readonly { team: 0 | 1 }[], perTeam: number): 0 | 1 | null {
  const blue = members.filter((m) => m.team === 0).length;
  const red = members.length - blue;
  if (blue >= perTeam && red >= perTeam) return null;
  if (blue >= perTeam) return 1;
  if (red >= perTeam) return 0;
  return red < blue ? 1 : 0;
}

/**
 * Teams after a playlist change to `perTeam` per side: members move from an overfull team to the
 * other when it has room (newest first); null when they do not fit at all. Pure (returns new teams).
 */
export function refitTeams(members: readonly { id: string; team: 0 | 1; joinedAt: number }[], perTeam: number): Map<string, 0 | 1> | null {
  if (members.length > perTeam * 2) return null;
  const out = new Map<string, 0 | 1>(members.map((m) => [m.id, m.team]));
  for (const team of [0, 1] as const) {
    const mine = members.filter((m) => out.get(m.id) === team).sort((a, b) => b.joinedAt - a.joinedAt);
    let extra = mine.length - perTeam;
    for (const m of mine) {
      if (extra <= 0) break;
      out.set(m.id, team === 0 ? 1 : 0);
      extra--;
    }
  }
  return out;
}

export function lobbyPasswordHash(lobbyId: string, pw: string): Promise<string> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode('turbogol-lobby:' + lobbyId + ':' + pw)).then((d) => {
    const b = new Uint8Array(d);
    let s = '';
    for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return s;
  });
}

function validPassword(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= 32;
}

function parseSettings(v: unknown, base: LobbySettings): LobbySettings | string {
  if (!v || typeof v !== 'object') return 'bad_settings';
  const o = v as Partial<Record<keyof LobbySettings, unknown>>;
  const out = { ...base };
  if (o.name !== undefined) {
    const n = sanitizeLobbyName(o.name);
    if (n === null) return 'bad_name';
    out.name = n;
  }
  if (o.mode !== undefined) {
    if (!isPlaylist(o.mode)) return 'bad_mode';
    out.mode = o.mode;
  }
  if (o.visibility !== undefined) {
    if (o.visibility !== 'public' && o.visibility !== 'private') return 'bad_visibility';
    out.visibility = o.visibility;
  }
  if (o.net !== undefined) {
    if (o.net !== 'p2p' && o.net !== 'server') return 'bad_net';
    out.net = o.net;
  }
  if (o.matchLengthSeconds !== undefined) {
    if (typeof o.matchLengthSeconds !== 'number' || !LOBBY_LENGTHS.includes(o.matchLengthSeconds)) return 'bad_length';
    out.matchLengthSeconds = o.matchLengthSeconds;
  }
  return out;
}

export function defaultLobbySettings(name: string): LobbySettings {
  return { name, mode: '2v2', visibility: 'public', net: 'p2p', matchLengthSeconds: DEFAULT_MATCH_SECONDS };
}

export { parseSettings as parseLobbySettings };

// ---- the object -------------------------------------------------------------------------------

export class LobbyDO extends DurableObject<Env> {
  private rec: LobbyRecord | null = null;
  private loaded: Promise<void>;
  private closed = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.loaded = ctx.blockConcurrencyWhile(async () => {
      this.rec = (await ctx.storage.get<LobbyRecord>('lobby')) ?? null;
    });
    // A plain 'ping' text frame is answered without waking the object (keep-alive through proxies).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  private perTeam(): number {
    return MODES[this.rec?.settings.mode ?? '1v1'];
  }

  private async save(): Promise<void> {
    if (this.rec && !this.closed) await this.ctx.storage.put('lobby', this.rec);
  }

  override async fetch(request: Request): Promise<Response> {
    await this.loaded;
    if (!this.env.JWT_SECRET || !(await checkInternal(this.env.JWT_SECRET, request))) return error(403, 'forbidden');
    const url = new URL(request.url);
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') return this.upgrade(request);
    if (request.method === 'POST' && url.pathname === '/internal/create') return this.create(request);
    if (request.method === 'POST' && url.pathname === '/internal/admit') return this.admit(request);
    return error(404, 'not_found');
  }

  private async create(request: Request): Promise<Response> {
    if (this.rec) return error(409, 'exists');
    const b = await readJson<{ lobbyId?: unknown; code?: unknown; region?: unknown; socketBase?: unknown; settings?: unknown; password?: unknown; host?: { playerId?: unknown; name?: unknown; guest?: unknown } }>(request);
    if (!b || typeof b.lobbyId !== 'string' || typeof b.code !== 'string' || typeof b.region !== 'string' || typeof b.socketBase !== 'string' || !b.host || typeof b.host.playerId !== 'string' || typeof b.host.name !== 'string') {
      return error(400, 'bad_request');
    }
    const settings = parseSettings(b.settings, defaultLobbySettings('Sala de ' + b.host.name));
    if (typeof settings === 'string') return error(400, settings);
    if (b.password !== undefined && b.password !== null && !validPassword(b.password)) return error(400, 'bad_password');
    const now = Date.now();
    this.rec = {
      lobbyId: b.lobbyId,
      code: b.code,
      region: b.region,
      socketBase: b.socketBase,
      createdAt: now,
      settings,
      pwHash: validPassword(b.password) ? await lobbyPasswordHash(b.lobbyId, b.password) : null,
      members: [],
      hostId: '',
      nextMember: 1,
      status: 'open',
      statusAt: now,
      admits: [{ playerId: b.host.playerId, name: b.host.name, guest: b.host.guest === true, until: now + ADMIT_TTL_MS }],
      kicked: [],
      lastSocketAt: now,
    };
    await this.save();
    await this.ctx.storage.setAlarm(now + ALARM_MS);
    await this.publish();
    return json({ ok: true });
  }

  private async admit(request: Request): Promise<Response> {
    const rec = this.rec;
    if (!rec || this.closed) return error(410, 'closed', 'La sala ya no existe');
    const b = await readJson<{ playerId?: unknown; name?: unknown; guest?: unknown; password?: unknown }>(request);
    if (!b || typeof b.playerId !== 'string' || typeof b.name !== 'string') return error(400, 'bad_request');
    if (rec.kicked.includes(b.playerId)) return error(403, 'kicked', 'El anfitrión te expulsó de esta sala');
    const now = Date.now();
    const member = rec.members.find((m) => m.playerId === b.playerId);
    if (!member) {
      if (rec.pwHash !== null) {
        if (!validPassword(b.password) || (await lobbyPasswordHash(rec.lobbyId, b.password)) !== rec.pwHash) return error(403, 'bad_password', 'Contraseña incorrecta');
      }
      const pending = rec.admits.filter((a) => a.until > now && a.playerId !== b.playerId).length;
      if (rec.members.length + pending >= this.perTeam() * 2) return error(409, 'full', 'La sala está llena');
    }
    rec.admits = rec.admits.filter((a) => a.until > now && a.playerId !== b.playerId);
    rec.admits.push({ playerId: b.playerId, name: b.name, guest: b.guest === true, until: now + ADMIT_TTL_MS });
    await this.save();
    return json({ ok: true });
  }

  private async upgrade(request: Request): Promise<Response> {
    const rec = this.rec;
    if (!rec || this.closed) return error(410, 'closed');
    const h = request.headers;
    const playerId = h.get('x-player-id') ?? '';
    const jti = h.get('x-jti') ?? '';
    if (!/^[0-9a-f]{32}$/.test(jti)) return error(403, 'bad_ticket');
    if (await this.ctx.storage.get('jti:' + jti)) return error(403, 'ticket_used');
    const now = Date.now();
    let member = rec.members.find((m) => m.playerId === playerId);
    const admit = rec.admits.find((a) => a.playerId === playerId && a.until > now);
    if (!member) {
      if (!admit) return error(403, 'not_admitted');
      const team = teamForNewMember(rec.members, this.perTeam());
      if (team === null) return error(409, 'full');
      member = { id: 'm' + rec.nextMember++, playerId, name: admit.name, guest: admit.guest, team, joinedAt: now, inGame: false };
      rec.members.push(member);
      if (rec.hostId === '') rec.hostId = member.id;
    }
    rec.admits = rec.admits.filter((a) => a.playerId !== playerId && a.until > now);
    rec.lastSocketAt = now;
    await this.ctx.storage.put('jti:' + jti, now);
    // One socket per member: an older one (another tab) is replaced.
    for (const ws of this.ctx.getWebSockets(member.id)) {
      try {
        ws.close(4000, 'replaced');
      } catch {
        // already closing
      }
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [member.id]);
    await this.save();
    this.broadcastState();
    await this.publish();
    return new Response(null, { status: 101, webSocket: pair[0], headers: { 'Sec-WebSocket-Protocol': 'tg1' } });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.loaded;
    const rec = this.rec;
    if (!rec || this.closed) return;
    if (typeof message !== 'string' || message.length > MAX_FRAME) return ws.close(1008, 'bad frame');
    let msg: LobbyClientMsg;
    try {
      msg = JSON.parse(message) as LobbyClientMsg;
    } catch {
      return ws.close(1008, 'bad json');
    }
    const me = this.memberOf(ws);
    if (!me) return ws.close(1008, 'not a member');
    const isHost = me.id === rec.hostId;
    const fail = (code: string, message: string): void => this.send(ws, { t: 'error', code, message });
    switch (msg.t) {
      case 'team': {
        if (rec.status !== 'open') return fail('busy', 'Espera a que termine la partida');
        if (msg.team !== 0 && msg.team !== 1) return fail('bad_team', 'Equipo inválido');
        if (msg.team === me.team) return;
        if (rec.members.filter((m) => m.team === msg.team).length >= this.perTeam()) return fail('team_full', 'Ese equipo está completo');
        me.team = msg.team;
        break;
      }
      case 'settings': {
        if (!isHost) return fail('not_host', 'Solo el anfitrión cambia la configuración');
        if (rec.status !== 'open') return fail('busy', 'Espera a que termine la partida');
        const next = parseSettings(msg.settings, rec.settings);
        if (typeof next === 'string') return fail(next, 'Configuración inválida');
        if (next.mode !== rec.settings.mode) {
          const fit = refitTeams(rec.members, MODES[next.mode]);
          if (fit === null) return fail('too_many', 'Hay más jugadores que lugares en ese modo');
          for (const m of rec.members) m.team = fit.get(m.id) ?? m.team;
        }
        rec.settings = next;
        if (msg.password === null) rec.pwHash = null;
        else if (msg.password !== undefined) {
          if (!validPassword(msg.password)) return fail('bad_password', 'La contraseña puede tener de 1 a 32 caracteres');
          rec.pwHash = await lobbyPasswordHash(rec.lobbyId, msg.password);
        }
        break;
      }
      case 'kick': {
        if (!isHost) return fail('not_host', 'Solo el anfitrión puede expulsar jugadores');
        const target = rec.members.find((m) => m.id === msg.member);
        if (!target || target.id === me.id) return;
        rec.kicked.push(target.playerId);
        this.removeMember(target);
        for (const s of this.ctx.getWebSockets(target.id)) s.close(CLOSE_KICKED, 'kicked');
        break;
      }
      case 'start': {
        if (!isHost) return fail('not_host', 'Solo el anfitrión inicia la partida');
        if (rec.status !== 'open') return fail('busy', 'La partida ya empezó');
        if (rec.members.some((m) => m.inGame)) return fail('busy', 'Hay jugadores que todavía están en la partida anterior');
        await this.start(ws);
        return;
      }
      case 'back': {
        me.inGame = false;
        if (rec.status === 'in_game' && !rec.members.some((m) => m.inGame)) {
          rec.status = 'open';
          rec.statusAt = Date.now();
        }
        break;
      }
      case 'leave': {
        this.removeMember(me);
        ws.close(1000, 'left');
        break;
      }
      default:
        return fail('unknown', 'Mensaje desconocido');
    }
    await this.afterChange();
  }

  override async webSocketClose(ws: WebSocket, _code: number, _reason: string): Promise<void> {
    await this.loaded;
    const rec = this.rec;
    if (!rec || this.closed) return;
    const me = this.memberOf(ws);
    rec.lastSocketAt = Date.now();
    // A member playing the lobby's match keeps its place (a reload during the match rejoins by code).
    if (me && !me.inGame && this.ctx.getWebSockets(me.id).every((s) => s === ws || s.readyState !== WebSocket.OPEN)) this.removeMember(me);
    await this.afterChange();
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1006, 'error');
  }

  override async alarm(): Promise<void> {
    await this.loaded;
    const rec = this.rec;
    if (!rec || this.closed) return;
    const now = Date.now();
    const sockets = this.ctx.getWebSockets().length;
    if (rec.status === 'in_game' && now - rec.statusAt > IN_GAME_RESET_MS) {
      for (const m of rec.members) m.inGame = false;
      rec.status = 'open';
      rec.statusAt = now;
    }
    if ((sockets === 0 && now - rec.lastSocketAt > IDLE_CLOSE_MS) || now - rec.createdAt > MAX_AGE_MS) {
      await this.close(sockets === 0 ? 'idle' : 'expired');
      return;
    }
    await this.save();
    await this.publish(); // directory heartbeat
    await this.ctx.storage.setAlarm(now + ALARM_MS);
  }

  // ---- internals ----------------------------------------------------------------------------

  private memberOf(ws: WebSocket): MemberRec | null {
    const rec = this.rec;
    if (!rec) return null;
    const tags = this.ctx.getTags(ws);
    return rec.members.find((m) => tags.includes(m.id)) ?? null;
  }

  private removeMember(m: MemberRec): void {
    const rec = this.rec;
    if (!rec) return;
    rec.members = rec.members.filter((x) => x !== m);
    if (rec.hostId === m.id) rec.hostId = rec.members.slice().sort((a, b) => a.joinedAt - b.joinedAt)[0]?.id ?? '';
  }

  private async afterChange(): Promise<void> {
    const rec = this.rec;
    if (!rec || this.closed) return;
    const now = Date.now();
    if (rec.members.length === 0 && !rec.admits.some((a) => a.until > now)) {
      await this.close('empty');
      return;
    }
    await this.save();
    this.broadcastState();
    await this.publish();
  }

  private async start(hostWs: WebSocket): Promise<void> {
    const rec = this.rec as LobbyRecord;
    rec.status = 'starting';
    this.broadcastState();
    const env = this.env;
    let res: Response;
    try {
      res = await env.MATCHMAKER.get(env.MATCHMAKER.idFromName('mm:' + rec.region)).fetch('https://matchmaker/custom', {
        method: 'POST',
        headers: { [INTERNAL_HEADER]: await internalSecret(env.JWT_SECRET), 'content-type': 'application/json', 'x-region': rec.region },
        body: JSON.stringify({
          kind: rec.settings.net,
          mode: rec.settings.mode,
          matchLengthSeconds: rec.settings.matchLengthSeconds,
          members: rec.members.map((m) => ({ playerId: m.playerId, name: m.name, team: m.team })),
        }),
      });
    } catch (e) {
      console.error('LobbyDO: custom start failed', e);
      res = error(503, 'unavailable');
    }
    if (this.closed || this.rec === null) return;
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      rec.status = 'open';
      this.send(hostWs, { t: 'error', code: body.error ?? 'start_failed', message: body.message ?? 'No se pudo iniciar la partida, inténtalo de nuevo' });
      await this.afterChange();
      return;
    }
    const { results } = (await res.json()) as { results: Record<string, { wsUrl?: string }> };
    const now = Date.now();
    rec.status = 'in_game';
    rec.statusAt = now;
    for (const m of rec.members) {
      const r = results[m.playerId];
      if (!r) continue;
      if (typeof r.wsUrl === 'string' && r.wsUrl.startsWith('/')) r.wsUrl = rec.socketBase + r.wsUrl;
      m.inGame = true;
      for (const ws of this.ctx.getWebSockets(m.id)) this.send(ws, { t: 'match', result: r });
    }
    await this.afterChange();
  }

  private stateFor(memberId: string): LobbyState {
    const rec = this.rec as LobbyRecord;
    const members: LobbyMember[] = rec.members.map((m) => ({ id: m.id, name: m.name, team: m.team, host: m.id === rec.hostId, guest: m.guest, inGame: m.inGame }));
    return { code: rec.code, settings: rec.settings, hasPassword: rec.pwHash !== null, region: rec.region, members, you: memberId, status: rec.status };
  }

  private send(ws: WebSocket, msg: LobbyServerMsg): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // closing socket
    }
  }

  private broadcastState(): void {
    const rec = this.rec;
    if (!rec) return;
    for (const m of rec.members) for (const ws of this.ctx.getWebSockets(m.id)) this.send(ws, { t: 'state', lobby: this.stateFor(m.id) });
  }

  private summary(): LobbySummary {
    const rec = this.rec as LobbyRecord;
    const host = rec.members.find((m) => m.id === rec.hostId);
    return {
      code: rec.code,
      name: rec.settings.name,
      mode: rec.settings.mode,
      players: rec.members.length,
      max: this.perTeam() * 2,
      locked: rec.pwHash !== null,
      host: host?.name ?? '',
      region: rec.region,
      inGame: rec.status !== 'open',
      net: rec.settings.net,
    };
  }

  private async directory(path: string, payload: unknown): Promise<void> {
    const env = this.env;
    try {
      const res = await env.LOBBY_DIR.get(env.LOBBY_DIR.idFromName('lobbies-v1')).fetch('https://lobbies' + path, {
        method: 'POST',
        headers: { [INTERNAL_HEADER]: await internalSecret(env.JWT_SECRET), 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      await res.body?.cancel();
    } catch (e) {
      console.error('LobbyDO: directory ' + path + ' failed', e);
    }
  }

  private publish(): Promise<void> {
    const rec = this.rec;
    if (!rec || this.closed) return Promise.resolve();
    return this.directory('/upsert', { code: rec.code, lobbyId: rec.lobbyId, visibility: rec.settings.visibility, summary: this.summary() });
  }

  private async close(reason: string): Promise<void> {
    const rec = this.rec;
    if (!rec || this.closed) return;
    for (const ws of this.ctx.getWebSockets()) {
      this.send(ws, { t: 'closed', reason });
      try {
        ws.close(CLOSE_CLOSED, reason);
      } catch {
        // already closed
      }
    }
    await this.directory('/remove', { code: rec.code, lobbyId: rec.lobbyId });
    this.closed = true;
    this.rec = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}
