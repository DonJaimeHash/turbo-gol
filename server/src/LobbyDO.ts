/**
 * LobbyDO: one custom-match lobby (private by code, or listed in the public lobby browser): a
 * join code, an optional password, public or private, the host's settings (name,
 * playlist, P2P or server, match length) and the members on two teams. Hibernating WebSockets
 * (JSON text frames, src/net/account.ts LobbyServerMsg / LobbyClientMsg): a lobby where nobody
 * talks costs nothing; the whole state lives in one storage record so a wake-up rebuilds it.
 *
 *   POST /internal/create { lobbyId, code, region, socketBase, settings, password?, host: { playerId, name, guest, car? } }
 *   POST /internal/admit  { playerId, name, guest, password?, car? } -> { ok } | 403 bad_password / kicked | 409 full | 410 closed
 *                         (car: the session's, src/net/cosmetics.ts; the member's seat drives it, LobbyMember shows it;
 *                         each start reads every signed-in member's car again from AccountsDO /equipped)
 *   GET  /internal/peek   -> LobbySummary | 410 closed (the join link's sheet: GET /api/lobbies/peek)
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
 *
 * A dropped socket is no leave (plan PR 12): the member is `away` for LOBBY_GRACE_MS, its place and
 * its host role kept, and a socket of the same player (POST /api/lobbies/join again: an existing
 * member is admitted without the password or the room check) brings it back; the alarm removes it
 * once the grace is over and only then hands the host on (to a member still connected first). An
 * explicit { t: 'leave' } or a kick removes at once. A member in the lobby's match keeps its place
 * without a socket while the match lasts (a reload comes back by code); once somebody is back from
 * it, the grace runs for that member too, and the last one in the match going (a kick, the end of
 * the grace) opens the lobby, as the last 'back' does. The start waits for nobody away
 * ('member_away'). The host may also hand the lobby over ({ t: 'host' }) and move another member
 * ({ t: 'move' }); a member says LISTO ({ t: 'ready' }: shown to all, the start never waits for it,
 * cleared by a team change and by the start).
 *
 * Experimental rules (LobbySettings.physics, a copy of a signed-in host's preset: src/game/
 * physicsRules.ts parseLobbyRules, strict; a snapshot that changes nothing is standard physics):
 * only with net 'p2p' (else 'experimental_p2p_only') and only while EVERY member is signed in. A
 * guest is refused at every door: create (403 account_required, the Worker checks the session
 * first), /internal/admit (403 account_required), the socket upgrade of an admit (403: an admit
 * taken up to ADMIT_TTL_MS before the rules were set), settings with rules while a guest is a
 * member ('guests_present'; pending guest admits are dropped), and the start ('guests_present').
 * The start hands the rules and every member's `guest` to the matchmaker's /custom, which checks
 * them again (P2P with >= 2 humans, every member signed in, never a MatchDO or a node) and puts
 * them in the RoomDO (which refuses them with a guest seat too). Nothing of such a match is ever
 * rated or recorded: custom lobbies never are, and the P2P path reports no result at all.
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import { error, json, readJson } from './env';
import { INTERNAL_HEADER, checkInternal, internalSecret } from './auth';
import { MODES } from '../../src/sim/constants';
import { LOBBY_LENGTHS, isPlaylist, lobbyNameIssue, sanitizeLobbyName } from '../../src/net/account';
import { guestNameOf } from '../../src/net/guestName';
import { DEFAULT_MATCH_SECONDS } from '../../src/game/Match';
import { parseLobbyRules } from '../../src/game/physicsRules';
import type { RulesSnapshot } from '../../src/game/physicsRules';
import type { LobbyClientMsg, LobbyMember, LobbyServerMsg, LobbySettings, LobbyState, LobbySummary } from '../../src/net/account';
import { seatCar } from '../../src/net/cosmetics';
import { DEFAULT_CAR } from '../../src/game/cosmetics';
import type { CarId } from '../../src/game/cosmetics';

const ADMIT_TTL_MS = 90_000;
const IDLE_CLOSE_MS = 2 * 60_000;
const MAX_AGE_MS = 6 * 60 * 60_000;
/** How long a start waits for AccountsDO's cars (equippedCars) before it seats the admits' ones. */
const EQUIPPED_TIMEOUT_MS = 1500;
const ALARM_MS = 60_000;
const IN_GAME_RESET_MS = 40 * 60_000;
const MAX_FRAME = 2048;
const CLOSE_KICKED = 4003;
const CLOSE_CLOSED = 4004;
/**
 * Message budget per socket (every frame that changes the lobby is a storage write, a broadcast and,
 * through publish, a request to the one LobbyDirectoryDO): LOBBY_MSG_BURST, refilled 5 a second.
 * A lobby screen sends a handful a minute (LISTO, a team, the settings, INICIAR); a frame over the
 * budget is dropped, and LOBBY_OVER_BURST dropped frames (refilled 1 a second) close the socket
 * with 1008 'rate' (held arrow keys on a TV stay far below it).
 */
export const LOBBY_MSG_BURST = 20;
const LOBBY_MSG_REFILL_PER_MS = 5 / 1000;
export const LOBBY_OVER_BURST = 40;
const LOBBY_OVER_REFILL_PER_MS = 1 / 1000;
/**
 * The directory row is upserted at most this often; a change in between goes out with the next alarm
 * (alarmBy). The window counts from the last row with somebody in the lobby: the row of a lobby with
 * no member (create, before its host's socket) is unlisted and starts no window, so the host's row
 * goes out the moment its socket is in (publish).
 */
export const PUBLISH_MIN_MS = 5_000;
/**
 * INICIAR at most this often (each one reaches the region's matchmaker, a lock check of every busy
 * member and, with a signed-in member, AccountsDO): START_MIN_MS after any start, START_AGAIN_MS
 * after one that formed a match, and after a refused one a wait that doubles (3, 6, 12 s) up to
 * START_MAX_BACKOFF_MS; a start inside the wait answers 'start_cooldown'.
 */
export const START_MIN_MS = 3_000;
/**
 * A server match (net 'server', or a lone member's) with a guest in it lasts at most this long
 * (mirrors MatchmakerDO GUEST_MAX_MATCH_SECONDS, which refuses it too: 400 guest_length): a guest
 * cannot hold a MatchDO for 600 s or an unlimited match.
 */
export const GUEST_SERVER_MAX_SECONDS = 300;
export const START_AGAIN_MS = 5_000;
export const START_MAX_BACKOFF_MS = 30_000;

/**
 * Password guesses (authz-6, rt-6). A wrong guess takes a token from the lobby's bucket
 * (PW_LOBBY_BURST, one back every PW_LOBBY_REFILL_MS) and counts against the guessing player
 * (PW_PLAYER_MAX per PW_WINDOW_MS); with the bucket empty or the player over its count every
 * password attempt on the lobby answers 429 'password_locked' (retryAfterMs) before the password
 * is even looked at, and the host is told once. Persisted with the lobby (a guess wakes it).
 * A new password needs PW_MIN_LENGTH characters; guesses of 1 to 32 are still compared (a lobby
 * made before the rule keeps its password).
 */
export const PW_LOBBY_BURST = 10;
export const PW_LOBBY_REFILL_MS = 30_000;
export const PW_PLAYER_MAX = 5;
export const PW_WINDOW_MS = 10 * 60_000;
export const PW_MIN_LENGTH = 4;
/** Guessing players remembered per lobby (the oldest goes first). */
const PW_PLAYERS_KEPT = 64;

/** When the next start may go after `fails` refused starts in a row (0: one that formed a match), from `now`. Pure. */
export function nextStartAt(fails: number, now: number): number {
  if (fails <= 0) return now + START_AGAIN_MS;
  return now + Math.min(START_MAX_BACKOFF_MS, START_MIN_MS * 2 ** (fails - 1));
}
/** How long a member whose socket dropped keeps its place (and the host role): plan PR 12, 30 to 45 s. */
export const LOBBY_GRACE_MS = 40_000;

interface MemberRec {
  id: string;
  playerId: string;
  name: string;
  guest: boolean;
  team: 0 | 1;
  joinedAt: number;
  inGame: boolean;
  /** When its last socket dropped (absent: connected); removed LOBBY_GRACE_MS later by the alarm. */
  awayAt?: number;
  /** Said LISTO. */
  ready?: boolean;
  /**
   * The car the member's seat drives (absent = the default car): its admit's, then what AccountsDO
   * says at each start (equippedCars); the start hands it to /custom.
   */
  car?: CarId;
}

interface AdmitRec {
  playerId: string;
  name: string;
  guest: boolean;
  until: number;
  /** The admitted session's car (the Worker's, from the session claim; never the client's body). */
  car?: CarId;
}

/** `{ car }` when `v` is a car the catalog knows, else nothing: a field of another shape is dropped. */
function carField(v: unknown): { car?: CarId } {
  const car = seatCar(v);
  return car !== undefined ? { car } : {};
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
  /** No start before this (START_MIN_MS, nextStartAt; absent in records of older builds = now). */
  startNext?: number;
  /** Refused starts in a row (the back-off of nextStartAt). */
  startFails?: number;
  /** The lobby's password-guess bucket (absent: full). */
  pwBucket?: { tokens: number; at: number };
  /** Wrong guesses per player in the current PW_WINDOW_MS window (absent: none). */
  pwFails?: Array<{ playerId: string; n: number; first: number }>;
  /** When the host was last told its password is being guessed (once per PW_WINDOW_MS). */
  pwWarnedAt?: number;
}

/** The lobby bucket refilled to `now` (PW_LOBBY_BURST, one token per PW_LOBBY_REFILL_MS). Pure. */
export function pwTokens(b: { tokens: number; at: number } | undefined, now: number): number {
  if (b === undefined) return PW_LOBBY_BURST;
  return Math.min(PW_LOBBY_BURST, b.tokens + Math.max(0, now - b.at) / PW_LOBBY_REFILL_MS);
}

// ---- pure helpers (server/test/lobby.test.mjs) ------------------------------------------------

/**
 * The lobby name rules (src/net/account.ts: the client and the physics presets share them,
 * src/game/physicsRules.ts), re-exported for the Worker and the tests.
 */
export { sanitizeLobbyName };

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

/** A guess worth comparing (1 to 32 characters: lobbies made before PW_MIN_LENGTH keep theirs). */
function validPassword(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= 32;
}

/** A password a host may set now: PW_MIN_LENGTH to 32 characters. */
function validNewPassword(v: unknown): v is string {
  return typeof v === 'string' && v.length >= PW_MIN_LENGTH && v.length <= 32;
}

/** The lobby's experimental rules (null = standard; a record written before the field: none). */
export function lobbyPhysics(s: LobbySettings): RulesSnapshot | null {
  return s.physics ?? null;
}

function parseSettings(v: unknown, base: LobbySettings): LobbySettings | string {
  if (!v || typeof v !== 'object') return 'bad_settings';
  const o = v as Partial<Record<keyof LobbySettings, unknown>>;
  const out: LobbySettings = { ...base, physics: lobbyPhysics(base) };
  if (o.name !== undefined) {
    const n = sanitizeLobbyName(o.name);
    if (n === null) return 'bad_name';
    if (lobbyNameIssue(n) !== null) return 'name_reserved';
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
  // Absent: the rules stay; null: standard physics; else a strict snapshot (one that changes
  // nothing is standard). Experimental rules exist only for P2P matches.
  if (o.physics !== undefined) {
    const rules = parseLobbyRules(o.physics);
    if (rules === 'bad') return 'bad_physics';
    out.physics = rules;
  }
  if (out.physics !== null && out.net !== 'p2p') return 'experimental_p2p_only';
  return out;
}

export function defaultLobbySettings(name: string): LobbySettings {
  return { name, mode: '2v2', visibility: 'public', net: 'p2p', matchLengthSeconds: DEFAULT_MATCH_SECONDS, physics: null };
}

export { parseSettings as parseLobbySettings };

/**
 * The settings a host's message may change (guest names, spec PR 1): a guest host never titles the
 * lobby, so its `name` is dropped; an account's `name` equal to the stored title is no change (a lobby
 * inherited from a guest keeps 'Invitado 4821', and saving the format does not trip the title check).
 */
export function hostSettings(v: unknown, guestHost: boolean, title: string): unknown {
  if (!v || typeof v !== 'object' || !('name' in v)) return v;
  const o = v as Record<string, unknown>;
  if (!guestHost && o.name !== title) return v;
  const { name: _drop, ...rest } = o;
  return rest;
}

const PLAYER_ID = /^[0-9a-f]{16}$/;

/**
 * A record written before guests got the server's names (src/net/guestName.ts): each guest member
 * and admit gets its 'Invitado NNNN', and a title refused now (a guest's 'Soporte Turbogol' of
 * before) becomes the host's name. Run on load; true when anything changed.
 */
export function settleGuestNames(rec: LobbyRecord): boolean {
  let changed = false;
  for (const m of [...rec.members, ...rec.admits]) {
    if (!m.guest || !PLAYER_ID.test(m.playerId)) continue;
    const name = guestNameOf(m.playerId);
    if (m.name !== name) {
      m.name = name;
      changed = true;
    }
  }
  const host = rec.members.find((m) => m.id === rec.hostId);
  const title = rec.settings.name;
  if (host !== undefined && lobbyNameIssue(title) !== null && !rec.members.some((m) => m.name === title)) {
    rec.settings = { ...rec.settings, name: host.name };
    changed = true;
  }
  return changed;
}

// ---- the object -------------------------------------------------------------------------------

export class LobbyDO extends DurableObject<Env> {
  private rec: LobbyRecord | null = null;
  private loaded: Promise<void>;
  private closed = false;
  /** Per-socket message budget (in memory: a wake-up starts every socket full). */
  private readonly buckets = new WeakMap<WebSocket, { tokens: number; over: number; at: number }>();
  /** The last directory payload sent, and when the last listed one went (publish); a change within PUBLISH_MIN_MS waits for the alarm. */
  private pubKey: string | null = null;
  private pubAt = -Infinity;
  /** When the row held back by the window is due (the alarm must come by then), else null. */
  private pubDue: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.loaded = ctx.blockConcurrencyWhile(async () => {
      this.rec = (await ctx.storage.get<LobbyRecord>('lobby')) ?? null;
      if (this.rec !== null) settleGuestNames(this.rec); // the alarm's save and publish keep it
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
    if (request.method === 'GET' && url.pathname === '/internal/peek') return this.rec && !this.closed ? json(this.summary()) : error(410, 'closed', 'La sala ya no existe');
    return error(404, 'not_found');
  }

  private async create(request: Request): Promise<Response> {
    if (this.rec) return error(409, 'exists');
    const b = await readJson<{ lobbyId?: unknown; code?: unknown; region?: unknown; socketBase?: unknown; settings?: unknown; password?: unknown; host?: { playerId?: unknown; name?: unknown; guest?: unknown; car?: unknown } }>(request);
    if (!b || typeof b.lobbyId !== 'string' || typeof b.code !== 'string' || typeof b.region !== 'string' || typeof b.socketBase !== 'string' || !b.host || typeof b.host.playerId !== 'string' || typeof b.host.name !== 'string') {
      return error(400, 'bad_request');
    }
    // The default title is the host's name (a guest's 'Invitado 4821': every viewer reads it in their own
    // language, src/ui/names.ts lobbyTitle); a guest's `name` is dropped, an account's is checked.
    const settings = parseSettings(hostSettings(b.settings, b.host.guest === true, ''), defaultLobbySettings(b.host.name));
    if (typeof settings === 'string') return error(400, settings);
    // The Worker refuses a guest's rules already; checked again here (every door checks).
    if (lobbyPhysics(settings) !== null && b.host.guest === true) return error(403, 'account_required', 'Inicia sesión para crear una sala experimental');
    if (b.password !== undefined && b.password !== null && !validNewPassword(b.password)) return error(400, 'short_password', `La contraseña tiene que tener entre ${PW_MIN_LENGTH} y 32 caracteres`);
    const now = Date.now();
    this.rec = {
      lobbyId: b.lobbyId,
      code: b.code,
      region: b.region,
      socketBase: b.socketBase,
      createdAt: now,
      settings,
      pwHash: validNewPassword(b.password) ? await lobbyPasswordHash(b.lobbyId, b.password) : null,
      members: [],
      hostId: '',
      nextMember: 1,
      status: 'open',
      statusAt: now,
      admits: [{ playerId: b.host.playerId, name: b.host.name, guest: b.host.guest === true, until: now + ADMIT_TTL_MS, ...carField(b.host.car) }],
      kicked: [],
      lastSocketAt: now,
    };
    await this.save();
    await this.ctx.storage.setAlarm(now + ALARM_MS);
    await this.publish(); // unlisted until the host's socket is in (publish)
    return json({ ok: true });
  }

  private async admit(request: Request): Promise<Response> {
    const rec = this.rec;
    if (!rec || this.closed) return error(410, 'closed', 'La sala ya no existe');
    const b = await readJson<{ playerId?: unknown; name?: unknown; guest?: unknown; password?: unknown; car?: unknown }>(request);
    if (!b || typeof b.playerId !== 'string' || typeof b.name !== 'string') return error(400, 'bad_request');
    if (rec.kicked.includes(b.playerId)) return error(403, 'kicked', 'El anfitrión te expulsó de esta sala');
    if (b.guest === true && lobbyPhysics(rec.settings) !== null) return error(403, 'account_required', 'Sala experimental: inicia sesión para entrar');
    const now = Date.now();
    const member = rec.members.find((m) => m.playerId === b.playerId);
    if (!member) {
      if (rec.pwHash !== null) {
        if (!validPassword(b.password)) return error(403, 'bad_password', 'Contraseña incorrecta');
        const locked = this.passwordLocked(b.playerId, now);
        if (locked > 0) return json({ error: 'password_locked', message: 'Demasiados intentos con la contraseña de esta sala, espera unos minutos', retryAfterMs: locked }, 429);
        if ((await lobbyPasswordHash(rec.lobbyId, b.password)) !== rec.pwHash) {
          await this.wrongPassword(b.playerId, now);
          return error(403, 'bad_password', 'Contraseña incorrecta');
        }
      }
      // Pending seats: admits of players who are not members yet (a member's fresh admit, a reload's, holds no extra seat).
      const pending = rec.admits.filter((a) => a.until > now && a.playerId !== b.playerId && !rec.members.some((m) => m.playerId === a.playerId)).length;
      if (rec.members.length + pending >= this.perTeam() * 2) return error(409, 'full', 'La sala está llena');
    }
    rec.admits = rec.admits.filter((a) => a.until > now && a.playerId !== b.playerId);
    rec.admits.push({ playerId: b.playerId, name: b.name, guest: b.guest === true, until: now + ADMIT_TTL_MS, ...carField(b.car) });
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
    // Kicked: whatever admit it holds (one taken while it was still a member) brings it back no more.
    if (rec.kicked.includes(playerId)) return error(403, 'kicked', 'El anfitrión te expulsó de esta sala');
    const now = Date.now();
    let member = rec.members.find((m) => m.playerId === playerId);
    const admit = rec.admits.find((a) => a.playerId === playerId && a.until > now);
    if (!member) {
      if (!admit) return error(403, 'not_admitted');
      // An admit taken before the host picked experimental rules: a guest cannot come in now.
      if (admit.guest && lobbyPhysics(rec.settings) !== null) return error(403, 'account_required');
      const team = teamForNewMember(rec.members, this.perTeam());
      if (team === null) return error(409, 'full');
      member = { id: 'm' + rec.nextMember++, playerId, name: admit.name, guest: admit.guest, team, joinedAt: now, inGame: false, ...carField(admit.car) };
      rec.members.push(member);
      if (rec.hostId === '') rec.hostId = member.id;
    } else if (admit) {
      // A member back through a fresh admit (another tab, a reload) sits in the car its session has now.
      if (admit.car !== undefined) member.car = admit.car;
      else delete member.car;
    }
    // Back within the grace: the same place, the same role.
    delete member.awayAt;
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
    const budget = this.takeToken(ws, Date.now());
    if (budget === 'close') return ws.close(1008, 'rate');
    if (budget === 'drop') return;
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
    // A frame that changes nothing (LISTO again, the settings as they are) writes, broadcasts and publishes nothing.
    const before = JSON.stringify(rec);
    switch (msg.t) {
      case 'team': {
        if (rec.status !== 'open') return fail('busy', 'Espera a que termine la partida');
        if (msg.team !== 0 && msg.team !== 1) return fail('bad_team', 'Equipo inválido');
        if (msg.team === me.team) return;
        if (rec.members.filter((m) => m.team === msg.team).length >= this.perTeam()) return fail('team_full', 'Ese equipo está completo');
        me.team = msg.team;
        me.ready = false;
        break;
      }
      case 'move': {
        if (!isHost) return fail('not_host', 'Solo el anfitrión mueve jugadores');
        if (rec.status !== 'open') return fail('busy', 'Espera a que termine la partida');
        if (msg.team !== 0 && msg.team !== 1) return fail('bad_team', 'Equipo inválido');
        const target = rec.members.find((m) => m.id === msg.member);
        if (!target || target.team === msg.team) return;
        if (rec.members.filter((m) => m.team === msg.team).length >= this.perTeam()) return fail('team_full', 'Ese equipo está completo');
        target.team = msg.team;
        target.ready = false;
        break;
      }
      case 'host': {
        if (!isHost) return fail('not_host', 'Solo el anfitrión puede pasar la sala');
        const target = rec.members.find((m) => m.id === msg.member);
        if (!target || target.id === me.id) return;
        rec.hostId = target.id;
        break;
      }
      case 'ready': {
        me.ready = msg.ready === true;
        break;
      }
      case 'settings': {
        if (!isHost) return fail('not_host', 'Solo el anfitrión cambia la configuración');
        if (rec.status !== 'open') return fail('busy', 'Espera a que termine la partida');
        const next = parseSettings(hostSettings(msg.settings, me.guest, rec.settings.name), rec.settings);
        if (typeof next === 'string') return fail(next, next === 'experimental_p2p_only' ? 'Las reglas experimentales necesitan una partida P2P' : next === 'name_reserved' ? 'Ese nombre de sala no está permitido' : 'Configuración inválida');
        // Experimental rules: every member signed in.
        if (lobbyPhysics(next) !== null && rec.members.some((m) => m.guest)) return fail('guests_present', 'Hay invitados en la sala: deben iniciar sesión o salir');
        if (next.mode !== rec.settings.mode) {
          const fit = refitTeams(rec.members, MODES[next.mode]);
          if (fit === null) return fail('too_many', 'Hay más jugadores que lugares en ese modo');
          for (const m of rec.members) m.team = fit.get(m.id) ?? m.team;
        }
        // Checked before anything changes: a refused password leaves the settings as they were.
        if (msg.password !== undefined && msg.password !== null && !validNewPassword(msg.password)) return fail('short_password', `La contraseña tiene que tener entre ${PW_MIN_LENGTH} y 32 caracteres`);
        const pwHash = msg.password === undefined ? rec.pwHash : msg.password === null ? null : await lobbyPasswordHash(rec.lobbyId, msg.password);
        rec.settings = next;
        // ... and no guest admitted before may still come in (its socket would be refused anyway).
        if (lobbyPhysics(next) !== null) rec.admits = rec.admits.filter((a) => !a.guest);
        if (pwHash !== rec.pwHash) {
          // A new password: the guesses at the old one count no more.
          rec.pwHash = pwHash;
          delete rec.pwBucket;
          delete rec.pwFails;
          delete rec.pwWarnedAt;
        }
        break;
      }
      case 'kick': {
        if (!isHost) return fail('not_host', 'Solo el anfitrión puede expulsar jugadores');
        const target = rec.members.find((m) => m.id === msg.member);
        if (!target || target.id === me.id) return;
        rec.kicked.push(target.playerId);
        rec.admits = rec.admits.filter((a) => a.playerId !== target.playerId);
        this.removeMember(target);
        for (const s of this.ctx.getWebSockets(target.id)) s.close(CLOSE_KICKED, 'kicked');
        break;
      }
      case 'start': {
        if (!isHost) return fail('not_host', 'Solo el anfitrión inicia la partida');
        if (rec.status !== 'open') return fail('busy', 'La partida ya empezó');
        if (rec.members.some((m) => m.inGame)) return fail('busy', 'Hay jugadores que todavía están en la partida anterior');
        if (rec.members.some((m) => m.awayAt !== undefined)) return fail('member_away', 'Alguien se está reconectando');
        if (lobbyPhysics(rec.settings) !== null) {
          if (rec.members.some((m) => m.guest)) return fail('guests_present', 'Hay invitados en la sala: deben iniciar sesión o salir');
          if (rec.settings.net !== 'p2p' || rec.members.length < 2) return fail('experimental_p2p_only', 'Las reglas experimentales necesitan una partida P2P con al menos 2 jugadores');
        }
        if (Date.now() < (rec.startNext ?? 0)) return fail('start_cooldown', 'Espera unos segundos antes de volver a iniciar');
        const length = rec.settings.matchLengthSeconds;
        if ((rec.settings.net === 'server' || rec.members.length < 2) && rec.members.some((m) => m.guest) && (length === 0 || length > GUEST_SERVER_MAX_SECONDS)) {
          return fail('guest_length', 'Las partidas en servidor con invitados duran hasta 5 minutos: elige una duración más corta');
        }
        await this.start(ws);
        return;
      }
      case 'back': {
        me.inGame = false;
        // Somebody is back, so the match is over (or this one left it): a member still in it with no
        // socket (a reload that never came back to the lobby, a closed tab) gets the grace from now.
        const now = Date.now();
        let away = false;
        for (const m of rec.members) {
          if (m.inGame && m.awayAt === undefined && this.ctx.getWebSockets(m.id).every((s) => s.readyState !== WebSocket.OPEN)) {
            m.awayAt = now;
            away = true;
          }
        }
        if (away) await this.alarmBy(now + LOBBY_GRACE_MS);
        this.reopenIfOver();
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
    if (this.rec !== null && JSON.stringify(this.rec) === before) return;
    await this.afterChange();
  }

  /** Milliseconds `playerId`'s password attempts stay refused on this lobby (0: it may guess). */
  private passwordLocked(playerId: string, now: number): number {
    const rec = this.rec as LobbyRecord;
    const tokens = pwTokens(rec.pwBucket, now);
    const lobbyWait = tokens >= 1 ? 0 : Math.ceil((1 - tokens) * PW_LOBBY_REFILL_MS);
    const mine = rec.pwFails?.find((f) => f.playerId === playerId && now - f.first < PW_WINDOW_MS);
    const playerWait = mine !== undefined && mine.n >= PW_PLAYER_MAX ? mine.first + PW_WINDOW_MS - now : 0;
    return Math.max(lobbyWait, playerWait);
  }

  /** A wrong guess: a token of the lobby's bucket and one more for the player (persisted); the host hears of an empty bucket once. */
  private async wrongPassword(playerId: string, now: number): Promise<void> {
    const rec = this.rec as LobbyRecord;
    const left = pwTokens(rec.pwBucket, now) - 1;
    rec.pwBucket = { tokens: Math.max(0, left), at: now };
    const fails = (rec.pwFails ?? []).filter((f) => now - f.first < PW_WINDOW_MS);
    const mine = fails.find((f) => f.playerId === playerId);
    if (mine !== undefined) mine.n++;
    else fails.push({ playerId, n: 1, first: now });
    rec.pwFails = fails.length > PW_PLAYERS_KEPT ? fails.slice(fails.length - PW_PLAYERS_KEPT) : fails;
    // The bucket ran dry (the next attempts are refused before the compare): the host hears it once per window.
    const warn = left < 1 && (rec.pwWarnedAt === undefined || now - rec.pwWarnedAt >= PW_WINDOW_MS);
    if (warn) rec.pwWarnedAt = now;
    await this.save();
    if (warn) {
      const host = rec.members.find((m) => m.id === rec.hostId);
      if (host !== undefined) for (const ws of this.ctx.getWebSockets(host.id)) this.send(ws, { t: 'error', code: 'password_attempts', message: 'Alguien está probando contraseñas en tu sala: las entradas con contraseña quedan en pausa unos minutos' });
    }
  }

  /** One frame of `ws`'s budget: 'ok', 'drop' (over it) or 'close' (LOBBY_OVER_BURST dropped). */
  private takeToken(ws: WebSocket, now: number): 'ok' | 'drop' | 'close' {
    let b = this.buckets.get(ws);
    if (b === undefined) {
      b = { tokens: LOBBY_MSG_BURST, over: LOBBY_OVER_BURST, at: now };
      this.buckets.set(ws, b);
    }
    const dt = now > b.at ? now - b.at : 0;
    b.at = now;
    b.tokens = Math.min(LOBBY_MSG_BURST, b.tokens + dt * LOBBY_MSG_REFILL_PER_MS);
    b.over = Math.min(LOBBY_OVER_BURST, b.over + dt * LOBBY_OVER_REFILL_PER_MS);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 'ok';
    }
    if (b.over < 1) return 'close';
    b.over -= 1;
    return 'drop';
  }

  override async webSocketClose(ws: WebSocket, _code: number, _reason: string): Promise<void> {
    await this.loaded;
    const rec = this.rec;
    if (!rec || this.closed) return;
    const me = this.memberOf(ws);
    const now = Date.now();
    rec.lastSocketAt = now;
    // A member playing the lobby's match keeps its place while it lasts (a reload during the match
    // comes back by code: lobby.ts installLobbyReturn), until somebody is back from it (a member from
    // before the start no longer in it: its 'back'); any other is away for the grace (the alarm
    // removes it then), unless another socket of its is open.
    const playing = me !== null && me.inGame && !rec.members.some((m) => !m.inGame && m.joinedAt < rec.statusAt);
    if (me && !playing && me.awayAt === undefined && this.ctx.getWebSockets(me.id).every((s) => s === ws || s.readyState !== WebSocket.OPEN)) {
      me.awayAt = now;
      await this.alarmBy(now + LOBBY_GRACE_MS);
    }
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
    // The grace is over: the member goes, and the host role with it.
    const gone = rec.members.filter((m) => m.awayAt !== undefined && now - m.awayAt >= LOBBY_GRACE_MS);
    for (const m of gone) this.removeMember(m);
    if (gone.length > 0) {
      await this.afterChange();
      if (this.closed) return;
    }
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
    await this.publish(true); // directory heartbeat (and any change publish held back)
    // The next heartbeat, or the next grace to end, or a row held back meanwhile (a change that came
    // in while the heartbeat's upsert was on its way: its alarmBy is overwritten here), whichever is first.
    const graceEnd = Math.min(...rec.members.map((m) => (m.awayAt !== undefined ? m.awayAt + LOBBY_GRACE_MS : Infinity)));
    await this.ctx.storage.setAlarm(Math.min(now + ALARM_MS, graceEnd, this.pubDue ?? Infinity));
  }

  /** The alarm at `at` at the latest (an earlier one stays). */
  private async alarmBy(at: number): Promise<void> {
    const storage = this.ctx.storage;
    const cur = typeof storage.getAlarm === 'function' ? await storage.getAlarm() : null;
    if (cur === null || cur === undefined || at < cur) await storage.setAlarm(at);
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
    // The longest-standing member takes over, one still connected first.
    if (rec.hostId === m.id) rec.hostId = rec.members.slice().sort((a, b) => Number(a.awayAt !== undefined) - Number(b.awayAt !== undefined) || a.joinedAt - b.joinedAt)[0]?.id ?? '';
    // The last one still in the lobby's match gone (a kick, the grace): the lobby opens.
    this.reopenIfOver();
  }

  /** The lobby's match is over once no member plays it any more: 'open' again (INICIAR). */
  private reopenIfOver(): void {
    const rec = this.rec;
    if (rec && rec.status === 'in_game' && !rec.members.some((m) => m.inGame)) {
      rec.status = 'open';
      rec.statusAt = Date.now();
    }
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

  /**
   * The car each signed-in member drives now (AccountsDO POST /equipped: the loadout while it is
   * still owned), read at every start: an admit's car would otherwise stay for the lobby's whole
   * life (up to MAX_AGE_MS, the socket stays open through the matches), past a maintainer's revoke,
   * and a car equipped in the garage meanwhile would never apply. An account the answer leaves out
   * (banned, gone) drives the default car. Null without a signed-in member, or when AccountsDO
   * does not answer within EQUIPPED_TIMEOUT_MS: the start keeps the admits' cars.
   */
  private async equippedCars(members: readonly MemberRec[]): Promise<Record<string, unknown> | null> {
    const userIds = members.filter((m) => !m.guest).map((m) => m.playerId);
    if (userIds.length === 0) return null;
    const env = this.env;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const ask = (async (): Promise<Record<string, unknown> | null> => {
        const res = await env.ACCOUNTS.get(env.ACCOUNTS.idFromName('accounts-v1')).fetch('https://accounts/equipped', {
          method: 'POST',
          headers: { [INTERNAL_HEADER]: await internalSecret(env.JWT_SECRET), 'content-type': 'application/json' },
          body: JSON.stringify({ userIds }),
        });
        if (!res.ok) {
          await res.body?.cancel();
          return null;
        }
        const b = (await res.json()) as { cars?: unknown };
        return typeof b.cars === 'object' && b.cars !== null && !Array.isArray(b.cars) ? (b.cars as Record<string, unknown>) : null;
      })();
      const late = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), EQUIPPED_TIMEOUT_MS);
      });
      return await Promise.race([ask, late]);
    } catch (e) {
      console.error('LobbyDO: equipped cars failed', e);
      return null;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  private async start(hostWs: WebSocket): Promise<void> {
    const rec = this.rec as LobbyRecord;
    rec.status = 'starting';
    rec.startNext = Date.now() + START_MIN_MS;
    this.broadcastState();
    const env = this.env;
    const fresh = await this.equippedCars(rec.members);
    if (this.closed || this.rec === null) return;
    if (fresh !== null) {
      for (const m of rec.members) {
        if (m.guest) continue;
        const car = seatCar(fresh[m.playerId]);
        if (car !== undefined && car !== DEFAULT_CAR) m.car = car;
        else delete m.car;
      }
    }
    let res: Response;
    try {
      res = await env.MATCHMAKER.get(env.MATCHMAKER.idFromName('mm:' + rec.region)).fetch('https://matchmaker/custom', {
        method: 'POST',
        headers: { [INTERNAL_HEADER]: await internalSecret(env.JWT_SECRET), 'content-type': 'application/json', 'x-region': rec.region },
        body: JSON.stringify({
          kind: rec.settings.net,
          mode: rec.settings.mode,
          matchLengthSeconds: rec.settings.matchLengthSeconds,
          // `guest`: the matchmaker and RoomDO refuse experimental rules for a guest too.
          members: rec.members.map((m) => ({ playerId: m.playerId, name: m.name, team: m.team, guest: m.guest, ...(m.car !== undefined ? { car: m.car } : {}) })),
          // Experimental rules travel as the copy the lobby holds (the matchmaker checks them again).
          physics: lobbyPhysics(rec.settings),
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
      rec.startFails = (rec.startFails ?? 0) + 1;
      rec.startNext = nextStartAt(rec.startFails, Date.now());
      this.send(hostWs, { t: 'error', code: body.error ?? 'start_failed', message: body.message ?? 'No se pudo iniciar la partida, inténtalo de nuevo' });
      await this.afterChange();
      return;
    }
    const { results } = (await res.json()) as { results: Record<string, { wsUrl?: string }> };
    const now = Date.now();
    rec.status = 'in_game';
    rec.statusAt = now;
    rec.startFails = 0;
    rec.startNext = nextStartAt(0, now);
    for (const m of rec.members) {
      m.ready = false;
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
    const members: LobbyMember[] = rec.members.map((m) => ({ id: m.id, name: m.name, team: m.team, host: m.id === rec.hostId, guest: m.guest, inGame: m.inGame, away: m.awayAt !== undefined, ready: m.ready === true, ...(m.car !== undefined ? { car: m.car } : {}) }));
    return { code: rec.code, settings: { ...rec.settings, physics: lobbyPhysics(rec.settings) }, hasPassword: rec.pwHash !== null, region: rec.region, members, you: memberId, status: rec.status };
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
      experimental: lobbyPhysics(rec.settings) !== null,
      physics: lobbyPhysics(rec.settings),
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

  /**
   * The lobby's row in LobbyDirectoryDO, the one object every lobby, list, join and population count
   * shares: sent when it changed, at most once every PUBLISH_MIN_MS (a change in between is sent by
   * the alarm, armed for then); `heartbeat` (the alarm) sends it whatever it is, keeping it fresh.
   *
   * A lobby nobody is in (create, before its host's socket; the last member gone while an admit is
   * pending) is sent unlisted: no public row with 0 players and no host, and none in the population
   * count, for as long as it lasts (a host that never connects: until the idle close). Its code still
   * resolves: the row exists since /allocate. Such a row waits for the window like any other but
   * starts none, so the host's row, a few milliseconds after create, goes out at once instead of 5 s
   * later with the alarm (plus the Worker's 3 s list cache). No flood repeats it: a lobby with no
   * member has no socket to send frames, and each new member takes a join. (The game's own CREATE
   * LOBBY AND SHARE creates its lobby private, and SETTINGS makes it public later: the host's row
   * going out at once matters to a lobby created public through the API.)
   */
  private async publish(heartbeat = false): Promise<void> {
    const rec = this.rec;
    if (!rec || this.closed) return;
    const listed = rec.members.length > 0;
    const payload = { code: rec.code, lobbyId: rec.lobbyId, visibility: listed ? rec.settings.visibility : 'private', summary: this.summary() };
    const key = JSON.stringify(payload);
    const now = Date.now();
    if (!heartbeat) {
      if (key === this.pubKey) return;
      if (now - this.pubAt < PUBLISH_MIN_MS) {
        this.pubDue = this.pubAt + PUBLISH_MIN_MS;
        await this.alarmBy(this.pubDue);
        return;
      }
    }
    this.pubKey = key;
    if (listed) this.pubAt = now;
    this.pubDue = null;
    await this.directory('/upsert', payload);
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
