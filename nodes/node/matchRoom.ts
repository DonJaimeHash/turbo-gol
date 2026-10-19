/**
 * MatchRoom: one authoritative match on a community node. A faithful port of server/src/MatchDO.ts
 * to Node.js, so the browser cannot tell the difference: same RoomHost, same wire protocol
 * (src/net/protocol.ts), same Welcome, events, guards, start rules, ranked join / forfeit rules and
 * close codes. What changes:
 *
 *   - Memory only. A node restart loses its matches; the control plane sees the node go silent and
 *     voids its ranked matches without penalties (MatchDO does the same after an eviction).
 *   - Every tick is recorded (shared/replay.ts). The node never rates anything: when a started
 *     match stops, the room hands the result AND the replay to the agent, which uploads both; the
 *     control plane re-simulates before any rating or reward is written.
 *   - Leaves come from the control plane (the player's POST /api/leave), never from the node.
 *   - Every ending carries its proof in the replay (shared/verify.ts), so the rules that end a
 *     match are measured in SIM TICKS, not wall time: the clock can stall (GC, a busy PC) and the
 *     sim falls behind, but the verifier only sees ticks.
 *       forfeit by leaving    the last leaver's takeover at end + 1
 *       forfeit by disconnect FORFEIT_DC_TICKS (60 s of sim) of all-zero applied controls: a slot
 *                             whose socket went at tick D gets zeros from D + 1, so the room
 *                             whistles at D + FORFEIT_DC_TICKS at the earliest
 *       left                  every human has a takeover; the last leaver's lands at end + 1
 *       empty                 MatchDO's wall-clock delay AND the same delay in ticks (never fewer
 *                             than EMPTY_PROOF_TICKS + 1) since the last socket went: a stall cannot
 *                             let 'empty' overtake a ranked disconnect forfeit that is due first
 *       ttl                   by the control plane's clock (RoomContext.serverNow), and only in
 *                             overtime or in an unlimited match: a regulation still running waits
 *   - A replay needs at least one simulated tick (decodeReplay refuses records at tick 0), so a
 *     match that started but has not ticked yet ends like one that never started: a cancel.
 *   - 'Disconnected at the whistle' does not make a player a leaver here: only explicit leaves do
 *     (a node could otherwise frame players). The control plane knows every explicit leave.
 *
 * Driven by the node-wide Ticker (advance(now)); everything else is socket callbacks and timers.
 */
import { RoomHost } from '../../server/src/roomHost';
import {
  INPUT_MAX_BATCH,
  MsgType,
  PING_LEN,
  PONG_LEN,
  PROTOCOL_VERSION,
  TICK_RATE,
  decodeInput,
  decodePing,
  encodeJson,
  encodePong,
} from '../../src/net/protocol';
import type { InputPacket, MatchEvent, Welcome } from '../../src/net/protocol';
import { MAX_CARS, PACKED_INPUT_BYTES } from '../../src/sim/types';
import { TTL_AFTER_MATCH_SECONDS } from '../shared/controlProtocol';
import type { BuildId, EndReason, LeaveAnswer, MatchAssignment, MatchResult, MatchStats, SlotStatsReport } from '../shared/controlProtocol';
import { CHECKPOINT_EVERY, ReplayRecorder } from '../shared/replay';
import { EMPTY_PROOF_TICKS, FORFEIT_DC_TICKS } from '../shared/verify';
import type { ReplayHeader } from '../shared/replay';
import type { NodeTicketClaims } from '../shared/nodeTickets';
import { createNodeArena } from '../shared/nodeArena';
import type { NodeArena } from '../shared/nodeArena';
import type { WsConn } from './wsServer';
import { LagHistogram } from './ticker';
import type { Ticker, Tickable } from './ticker';

const TICK_MS = 1000 / TICK_RATE;
const MAX_TICKS_PER_CALLBACK = 8;
const MAX_SOCKETS = 8;
export const MAX_FRAME_BYTES = 512;
const MSG_BURST = 128;
const MSG_REFILL_PER_MS = 150 / 1000;
const INPUT_BURST = 6;
const SNAPSHOT_EVERY = 4;
const CLOSE_REPLACED = 4000;
/** A TTL that fires during regulation (goal pauses stop the regulation clock) looks again this often. */
const TTL_RECHECK_MS = 1_000;

/**
 * MatchDO's wall-clock timings; tests and demos shorten them. The ranked disconnect forfeit is not
 * here: it is FORFEIT_DC_TICKS of simulation (shared/verify.ts), what the verifier checks.
 */
export interface RoomTimings {
  startGraceMs: number;
  emptyShutdownMs: number;
  endLingerMs: number;
  ttlAfterMatchMs: number;
  unusedMs: number;
  rankedJoinMs: number;
}

export const DEFAULT_TIMINGS: RoomTimings = {
  startGraceMs: 5_000,
  emptyShutdownMs: 15_000,
  endLingerMs: 2_000,
  ttlAfterMatchMs: TTL_AFTER_MATCH_SECONDS * 1000,
  unusedMs: 90_000,
  rankedJoinMs: 45_000,
};

export interface RoomHooks {
  /** A STARTED match stopped (any reason): result, replay and stats. Called once, before the sockets close. */
  onEnded(room: MatchRoom, result: MatchResult, replay: Uint8Array, stats: MatchStats): void;
  /** A match that never started is over: ranked no-show / dodge, or nobody ever came. */
  onCancelled(room: MatchRoom, reason: string, noShows: string[]): void;
  /** The match broke without a trustworthy replay (a tick threw). */
  onLost(room: MatchRoom, reason: string): void;
  /** The room is gone (sockets closed, timers cleared). Always the last call. */
  onClosed(room: MatchRoom, reason: string): void;
}

export interface RoomContext {
  nodeId: string;
  /** Shown to clients as Welcome.hostColo (MatchDO puts the Cloudflare colo there). */
  label: string;
  build: BuildId;
  ticker: Ticker;
  hooks: RoomHooks;
  timings?: Partial<RoomTimings>;
  /**
   * The control plane's clock (ms since the epoch), for MatchAssignment.createdAt: the TTL is armed
   * against it, since the control plane checks a 'ttl' ending by its own clock. The runtime passes
   * Date.now() + the offset learned from the welcome's serverTime. Default: Date.now.
   */
  serverNow?: () => number;
}

export type Precheck = { ok: true } | { ok: false; status: number; code: string; message?: string };

interface Client {
  ws: WsConn;
  slot: number;
  playerId: string;
  name: string;
  ready: boolean;
  attached: boolean;
  attachedAt: number;
  tokens: number;
  tokensAt: number;
  inputTokens: number;
  inputTick: number;
}

export class MatchRoom implements Tickable {
  readonly assign: MatchAssignment;
  readonly matchId: string;
  readonly host: RoomHost;
  readonly arena: NodeArena;
  readonly lag = new LagHistogram();

  private readonly ctx: RoomContext;
  private readonly t: RoomTimings;
  private readonly recorder: ReplayRecorder;
  private readonly clients: Array<Client | null> = new Array<Client | null>(MAX_CARS).fill(null);
  private readonly usedJti = new Set<string>();
  private readonly reservedJti = new Set<string>();
  private readonly leftSlots = new Uint8Array(MAX_CARS);
  /** host.currentTick when the slot's socket went (it gets zero controls from the next tick on); -1 while connected. */
  private readonly discTick = new Int32Array(MAX_CARS).fill(-1);
  private readonly connectedMs = new Float64Array(MAX_CARS);
  private liveSockets = 0;
  private running = false;
  private ended = false;
  private shutDown = false;
  private startedAtWall = 0;
  private lastNow = 0;
  private acc = 0;
  /** Wall clock (Date.now) and host tick when the last socket went; -1 while someone is connected. */
  private emptySince = -1;
  private emptyTick = -1;
  /** Ticks of nobody before 'empty': emptyShutdownMs of sim, and at least the verifier's proof. */
  private readonly emptyTicks: number;
  private egressBytes = 0;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private earlyTimer: ReturnType<typeof setTimeout> | null = null;
  private ttlTimer: ReturnType<typeof setTimeout> | null = null;
  private outBuf: Uint8Array;
  private readonly pongBuf = new Uint8Array(PONG_LEN);
  private readonly inputPkt: InputPacket = { firstTick: 0, count: 0, ackTick: 0, packed: new Int8Array(INPUT_MAX_BATCH * PACKED_INPUT_BYTES) };
  private readonly eventScratch: MatchEvent[] = [];

  private constructor(assign: MatchAssignment, arena: NodeArena, ctx: RoomContext) {
    this.assign = assign;
    this.matchId = assign.matchId;
    this.arena = arena;
    this.ctx = ctx;
    this.t = { ...DEFAULT_TIMINGS, ...(ctx.timings ?? {}) };
    if (assign.joinTimeoutMs !== undefined) this.t.rankedJoinMs = assign.joinTimeoutMs;
    this.emptyTicks = Math.max(EMPTY_PROOF_TICKS + 1, Math.ceil((this.t.emptyShutdownMs * TICK_RATE) / 1000));
    this.host = new RoomHost(arena.sim, assign.roster, {
      tickRate: TICK_RATE,
      snapshotEvery: SNAPSHOT_EVERY,
      inputBufferTarget: 2,
      inputBufferMax: 8,
      matchLengthSeconds: assign.matchLengthSeconds,
      kickoffSeed: assign.kickoffSeed,
      botDifficulty: assign.botDifficulty,
      kickoffCountdownSeconds: assign.kickoffCountdownSeconds,
      goalPauseSeconds: assign.goalPauseSeconds,
    });
    this.outBuf = new Uint8Array(this.host.snapshotMaxBytes);
    const header: ReplayHeader = {
      v: 1,
      matchId: assign.matchId,
      nodeId: ctx.nodeId,
      build: ctx.build,
      mode: assign.mode,
      region: assign.region,
      ranked: assign.ranked,
      roster: assign.roster,
      matchLengthSeconds: assign.matchLengthSeconds,
      kickoffSeed: assign.kickoffSeed,
      botDifficulty: assign.botDifficulty,
      ...(assign.kickoffCountdownSeconds !== undefined ? { kickoffCountdownSeconds: assign.kickoffCountdownSeconds } : {}),
      ...(assign.goalPauseSeconds !== undefined ? { goalPauseSeconds: assign.goalPauseSeconds } : {}),
      tickRate: TICK_RATE,
      checkpointEvery: CHECKPOINT_EVERY,
      startedAt: 0,
    };
    this.recorder = new ReplayRecorder(header);
  }

  /** Build the arena (pre-warmed, like MatchDO's create) and arm the early / TTL timers. */
  static async create(assign: MatchAssignment, ctx: RoomContext): Promise<MatchRoom> {
    const arena = await createNodeArena(assign.roster, assign.kickoffSeed);
    const room = new MatchRoom(assign, arena, ctx);
    room.armTimers();
    return room;
  }

  private armTimers(): void {
    const a = this.assign;
    // Ranked: everyone connected and ready in time, or the match is cancelled. Casual: a room
    // nobody joined goes away.
    this.earlyTimer = setTimeout(
      () => {
        this.earlyTimer = null;
        if (this.shutDown || this.host.isStarted) return;
        if (a.ranked) this.cancel('no_show');
        else if (this.liveSockets === 0) this.cancel('unused');
      },
      a.ranked ? this.t.rankedJoinMs : this.t.unusedMs,
    );
    // createdAt is the control plane's clock, and so is its check of a 'ttl' ending.
    const ttlAt = a.createdAt + a.matchLengthSeconds * 1000 + this.t.ttlAfterMatchMs;
    const serverNow = this.ctx.serverNow ?? Date.now;
    this.armTtl(Math.max(1_000, ttlAt - serverNow()));
  }

  private armTtl(ms: number): void {
    if (this.ttlTimer) clearTimeout(this.ttlTimer);
    this.ttlTimer = setTimeout(() => {
      this.ttlTimer = null;
      this.endByTtl();
    }, ms);
  }

  // ---- status -------------------------------------------------------------------------------

  get sockets(): number {
    return this.liveSockets;
  }

  get isEnded(): boolean {
    return this.ended || this.shutDown;
  }

  /**
   * Started AND simulated at least one tick: only then can the room end with a replay (END and
   * every other record must be at tick >= 1). Between host.start() and the first advance (one tick
   * plus the ticker's interval) an ending is a cancel, as before the start.
   */
  private get played(): boolean {
    return this.host.isStarted && this.host.currentTick > 0;
  }

  status(): { matchId: string; tick: number; phase: string; sockets: number } {
    return { matchId: this.matchId, tick: this.host.currentTick, phase: this.shutDown ? 'closed' : this.host.phase, sockets: this.liveSockets };
  }

  // ---- joining ------------------------------------------------------------------------------

  /**
   * WebRTC: the seat is checked when the offer arrives and the ticket reserved right away (the
   * DataChannel opens a few hundred ms later). attach() then re-checks with `reserved`.
   */
  reserve(c: NodeTicketClaims): Precheck {
    const p = this.precheck(c);
    if (p.ok) this.reservedJti.add(c.jti);
    return p;
  }

  /** The reserved DataChannel never opened: the ticket may be tried once more until it expires. */
  unreserve(jti: string): void {
    this.reservedJti.delete(jti);
  }

  /** Everything MatchDO checks before accepting an upgrade, given verified ticket claims. */
  precheck(c: NodeTicketClaims, opts: { reserved?: boolean } = {}): Precheck {
    if (this.shutDown) return { ok: false, status: 404, code: 'no_match' };
    if (this.ended) return { ok: false, status: 410, code: 'match_over' };
    const roster = this.assign.roster;
    if (!Number.isInteger(c.slot) || c.slot < 0 || c.slot >= roster.length) return { ok: false, status: 403, code: 'bad_slot' };
    const e = roster[c.slot];
    if (e.kind !== 'player' || e.playerId !== c.sub || e.team !== c.team) return { ok: false, status: 403, code: 'not_your_slot' };
    if (this.leftSlots[c.slot] === 1) return { ok: false, status: 410, code: 'left', message: 'you left this match' };
    if (this.usedJti.has(c.jti)) return { ok: false, status: 403, code: 'ticket_used' };
    if (this.reservedJti.has(c.jti) && !opts.reserved) return { ok: false, status: 403, code: 'ticket_used' };
    const existing = this.clients[c.slot];
    if (existing !== null && existing.playerId !== c.sub) return { ok: false, status: 409, code: 'slot_taken' };
    if (existing === null && this.liveSockets >= MAX_SOCKETS) return { ok: false, status: 503, code: 'full' };
    return { ok: true };
  }

  /** Attach an accepted socket (precheck passed in the same synchronous turn). */
  attach(ws: WsConn, c: NodeTicketClaims): void {
    this.usedJti.add(c.jti);
    this.reservedJti.delete(c.jti);
    const slot = c.slot;
    const entry = this.assign.roster[slot];
    const existing = this.clients[slot];
    const replaced = existing !== null;
    if (existing !== null) this.detach(existing, CLOSE_REPLACED, 'replaced');
    const now = Date.now();
    const cl: Client = {
      ws,
      slot,
      playerId: c.sub,
      name: entry.name,
      ready: false,
      attached: true,
      attachedAt: now,
      tokens: MSG_BURST,
      tokensAt: now,
      inputTokens: INPUT_BURST,
      inputTick: this.host.currentTick,
    };
    this.clients[slot] = cl;
    this.liveSockets++;
    this.emptySince = -1;
    this.emptyTick = -1;
    this.discTick[slot] = -1;
    this.host.setConnected(slot, true);
    ws.onmessage = (data, text) => this.onMessage(cl, data, text);
    ws.onclose = () => this.onClose(cl);

    const welcome: Welcome = {
      protocol: PROTOCOL_VERSION,
      matchId: this.matchId,
      mode: this.assign.mode,
      tickRate: TICK_RATE,
      carId: this.arena.carIds[slot],
      slot,
      roster: this.assign.roster.map((e, i) => ({ carId: this.arena.carIds[i], slot: e.slot, team: e.team, name: e.name, kind: this.leftSlots[i] === 1 ? 'bot' : e.kind })),
      tick: this.host.currentTick,
      matchLengthSeconds: this.assign.matchLengthSeconds,
      hostColo: this.ctx.label,
    };
    this.safeSend(cl, encodeJson(MsgType.Welcome, welcome));
    if (!replaced) this.broadcast(encodeJson(MsgType.Event, { type: 'playerJoined', slot, name: cl.name } satisfies MatchEvent), cl);
    if (!this.host.isStarted && !this.startTimer && !this.assign.ranked) {
      this.startTimer = setTimeout(() => {
        this.startTimer = null;
        this.startLoop();
      }, this.t.startGraceMs);
    }
  }

  // ---- socket traffic -----------------------------------------------------------------------

  private onMessage(c: Client, buf: Uint8Array, text: boolean): void {
    if (!c.attached || this.clients[c.slot] !== c) return;
    const now = Date.now();
    const dt = now - c.tokensAt;
    let tokens = dt > 0 ? c.tokens + dt * MSG_REFILL_PER_MS : c.tokens;
    if (tokens > MSG_BURST) tokens = MSG_BURST;
    c.tokensAt = now;
    if (tokens < 1) {
      c.tokens = tokens;
      return this.kick(c, 1008, 'rate');
    }
    c.tokens = tokens - 1;
    if (text) return this.kick(c, 1008, 'binary frames only');
    if (buf.length === 0 || buf.length > MAX_FRAME_BYTES) return this.kick(c, 1008, 'frame size');
    const host = this.host;
    switch (buf[0]) {
      case MsgType.Input: {
        const t = host.currentTick;
        if (t !== c.inputTick) {
          let n = c.inputTokens + (t - c.inputTick);
          if (n > INPUT_BURST) n = INPUT_BURST;
          c.inputTokens = n;
          c.inputTick = t;
        }
        if (c.inputTokens < 1) return;
        c.inputTokens--;
        const pkt = this.inputPkt;
        if (!decodeInput(buf, pkt)) return this.kick(c, 1008, 'bad input');
        host.addInputs(c.slot, pkt.firstTick, pkt.count, pkt.packed, 0);
        return;
      }
      case MsgType.Ping: {
        if (buf.length < PING_LEN) return this.kick(c, 1008, 'bad ping');
        const len = encodePong(this.pongBuf, decodePing(buf), now, now, host.currentTick);
        this.safeSend(c, this.pongBuf.subarray(0, len));
        return;
      }
      case MsgType.Ready: {
        if (!c.ready) {
          c.ready = true;
          this.maybeStart();
        }
        return;
      }
      default:
        return this.kick(c, 1008, 'unknown message');
    }
  }

  private onClose(c: Client): void {
    if (!this.unlink(c)) return;
    if (!this.shutDown) this.broadcast(encodeJson(MsgType.Event, { type: 'playerLeft', slot: c.slot } satisfies MatchEvent), null);
  }

  /**
   * Take `c` out of the room exactly once. When it was the slot's current socket the slot is now
   * disconnected (closed, kicked or replaced; attach() clears the mark again): zero controls from
   * the next tick on, and discTick remembers when, for the ranked disconnect forfeit.
   */
  private unlink(c: Client): boolean {
    if (!c.attached) return false;
    c.attached = false;
    this.liveSockets--;
    this.egressBytes += c.ws.bytesSent;
    if (this.startedAtWall > 0) this.connectedMs[c.slot] += Math.max(0, Date.now() - Math.max(c.attachedAt, this.startedAtWall));
    if (this.liveSockets === 0) {
      this.emptySince = Date.now();
      this.emptyTick = this.host.currentTick;
    }
    if (this.clients[c.slot] !== c) return false;
    this.clients[c.slot] = null;
    this.host.setConnected(c.slot, false);
    this.discTick[c.slot] = this.host.currentTick;
    return true;
  }

  private detach(c: Client, code: number, reason: string): boolean {
    const wasCurrent = this.unlink(c);
    try {
      c.ws.close(code, reason);
    } catch {
      /* already closed */
    }
    return wasCurrent;
  }

  private kick(c: Client, code: number, reason: string): void {
    if (this.detach(c, code, reason) && !this.shutDown) {
      this.broadcast(encodeJson(MsgType.Event, { type: 'playerLeft', slot: c.slot } satisfies MatchEvent), null);
    }
  }

  private safeSend(c: Client, bytes: Uint8Array): void {
    try {
      c.ws.send(bytes);
    } catch {
      this.onClose(c);
    }
  }

  private broadcast(bytes: Uint8Array, except: Client | null): void {
    for (let i = 0; i < MAX_CARS; i++) {
      const c = this.clients[i];
      if (c && c !== except) this.safeSend(c, bytes);
    }
  }

  // ---- leave (from the control plane) ------------------------------------------------------

  /** POST /api/leave { matchId } relayed by the control plane: MatchDO.leave semantics. */
  leave(playerId: string): LeaveAnswer | { error: number; code: string } {
    if (this.shutDown) return { error: 404, code: 'no_match' };
    if (this.ended) return { error: 410, code: 'match_over' };
    const e = this.assign.roster.find((r) => r.kind === 'player' && r.playerId === playerId);
    if (!e) return { error: 404, code: 'not_in_match' };
    const slot = e.slot;
    if (this.leftSlots[slot] === 1) return { slot, closed: false, already: true, ended: false };
    this.leftSlots[slot] = 1;
    const c = this.clients[slot];
    const closed = c !== null && this.detach(c, 1000, 'left');
    const host = this.host;
    if (this.assign.ranked) {
      if (!this.played) {
        this.cancel('dodge', [playerId]);
        return { slot, closed, already: false, ended: true };
      }
      if (this.teamGone(e.team, true)) {
        // Proof for the verifier: the leaver's takeover lands at end + 1 (never simulated).
        this.recorder.takeover(host.currentTick + 1, slot);
        this.forceEnd(e.team === 0 ? 1 : 0, e.team);
        return { slot, closed, already: false, ended: true };
      }
    }
    if (!this.humansRemain()) {
      // A 'left' ending is proven by a takeover for every human: the last leaver's lands at
      // end + 1 (never simulated), like the ranked forfeit by leaving. Before the first tick it is a cancel.
      if (this.played) this.recorder.takeover(host.currentTick + 1, slot);
      this.stop('left');
      return { slot, closed, already: false, ended: true };
    }
    const takeoverTick = host.currentTick + 1;
    host.convertToBot(slot);
    this.recorder.takeover(takeoverTick, slot);
    this.broadcast(encodeJson(MsgType.Event, { type: 'botTakeover', slot, tick: takeoverTick } satisfies MatchEvent), null);
    this.maybeStart();
    return { slot, closed, already: false, ended: false };
  }

  private humansRemain(): boolean {
    const r = this.assign.roster;
    for (let i = 0; i < r.length; i++) if (r[i].kind === 'player' && this.leftSlots[i] === 0) return true;
    return false;
  }

  // ---- loop ---------------------------------------------------------------------------------

  private maybeStart(): void {
    if (this.host.isStarted || this.shutDown) return;
    if (this.liveSockets === 0) return;
    const r = this.assign.roster;
    for (let i = 0; i < r.length; i++) {
      if (r[i].kind !== 'player' || this.leftSlots[i] === 1) continue;
      const c = this.clients[i];
      if (!c || !c.ready) return;
    }
    this.startLoop();
  }

  private startLoop(): void {
    if (this.host.isStarted || this.shutDown || this.ended) return;
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    if (this.earlyTimer) {
      clearTimeout(this.earlyTimer);
      this.earlyTimer = null;
    }
    this.host.start();
    // (The replay header's startedAt stays 0: replays of the same match are byte-identical.)
    this.startedAtWall = Date.now();
    this.running = true;
    this.lastNow = performance.now();
    this.acc = 0;
    for (const c of this.clients) if (c) c.attachedAt = Math.max(c.attachedAt, this.startedAtWall);
    this.ctx.ticker.add(this);
  }

  advance(now: number): void {
    if (!this.running || this.shutDown || this.ended) return;
    const host = this.host;
    try {
      let dt = now - this.lastNow;
      this.lastNow = now;
      if (dt < 0) dt = 0;
      if (dt > 250) dt = 250;
      this.acc += dt;
      let n = Math.floor(this.acc / TICK_MS);
      if (n > 0) {
        const lagMs = this.acc - TICK_MS;
        this.lag.add(lagMs);
        this.ctx.ticker.lag.add(lagMs);
      }
      if (n > MAX_TICKS_PER_CALLBACK) n = MAX_TICKS_PER_CALLBACK;
      this.acc -= n * TICK_MS;
      if (this.acc > TICK_MS * MAX_TICKS_PER_CALLBACK) this.acc = TICK_MS * MAX_TICKS_PER_CALLBACK;
      for (let i = 0; i < n; i++) {
        host.tick();
        this.recorder.afterTick(host, this.arena.sim);
        if (host.snapshotDue) this.sendSnapshots();
        if (host.events.length > 0) this.flushEvents();
        if (host.ended) {
          const w = host.match.winner;
          this.finish('rules', w === 0 || w === 1 ? w : -1);
          return;
        }
      }
      // Ranked disconnect forfeit, in sim ticks (a few array reads per team, so every advance).
      if (this.assign.ranked) {
        for (const team of [0, 1] as const) {
          if (this.teamGone(team, false)) {
            this.forceEnd(team === 0 ? 1 : 0, team);
            return;
          }
        }
      }
      if (this.liveSockets === 0) {
        // MatchDO's wall-clock delay, and the same delay in ticks: the verifier's 'empty' proof
        // (every slot got zero controls from emptyTick + 1 on) and, since the ranked disconnect
        // forfeit is in ticks too, a stall while the room is empty cannot turn a forfeit that
        // MatchDO would whistle first into an 'empty' (void) ending.
        const wall = Date.now();
        if (this.emptySince < 0) {
          this.emptySince = wall;
          this.emptyTick = host.currentTick;
        } else if (wall - this.emptySince >= this.t.emptyShutdownMs && host.currentTick - this.emptyTick >= this.emptyTicks) {
          this.stop('empty');
        }
      }
    } catch (e) {
      console.error(`match ${this.matchId}: tick failed`, e);
      this.lose('tick_error');
    }
  }

  private sendSnapshots(): void {
    const host = this.host;
    host.prepareSnapshot();
    for (let i = 0; i < MAX_CARS; i++) {
      const c = this.clients[i];
      if (!c) continue;
      const len = host.snapshot(this.outBuf, i);
      this.safeSend(c, this.outBuf.subarray(0, len));
    }
  }

  private flushEvents(): void {
    const n = this.host.takeEvents(this.eventScratch);
    for (let i = 0; i < n; i++) this.broadcast(encodeJson(MsgType.Event, this.eventScratch[i]), null);
    this.eventScratch.length = 0;
  }

  // ---- ranked rules -------------------------------------------------------------------------

  /**
   * Every human of `team` left (leftOnly), or left or has been disconnected for FORFEIT_DC_TICKS.
   * A slot disconnected at tick D applies zeros from D + 1 (setConnected(false) empties its queue
   * and nothing can refill it without a socket), so at end = currentTick >= D + FORFEIT_DC_TICKS
   * its last recorded change is at <= D + 1 <= end - FORFEIT_DC_TICKS + 1: the verifier's proof.
   * A team without humans at all (cannot happen in ranked) is never gone.
   */
  private teamGone(team: 0 | 1, leftOnly: boolean): boolean {
    let humans = 0;
    const r = this.assign.roster;
    const now = this.host.currentTick;
    for (let i = 0; i < r.length; i++) {
      const e = r[i];
      if (e.kind !== 'player' || e.team !== team) continue;
      humans++;
      if (this.leftSlots[i] === 1) continue;
      if (leftOnly) return false;
      if (this.clients[i] !== null) return false;
      const since = this.discTick[i];
      if (since < 0 || now - since < FORFEIT_DC_TICKS) return false;
    }
    return humans > 0;
  }

  // ---- endings ------------------------------------------------------------------------------

  /** Ranked forfeit: whistle now, `winner` wins. */
  private forceEnd(winner: 0 | 1, forfeitTeam: 0 | 1): void {
    if (!this.host.isStarted || this.ended || this.shutDown) return;
    this.whistle(winner, true);
    this.finish('forfeit', winner, forfeitTeam);
  }

  /**
   * The wall-clock TTL caught a match still running (unlimited overtime): leader wins, -1 when tied.
   * Only an overtime (or an unlimited match) can be whistled: a regulation that ran late (goal
   * pauses stop its clock, a stalled node falls behind) ends by the rules or reaches overtime, so
   * the TTL looks again every TTL_RECHECK_MS. The verifier rejects a 'ttl' outside overtime.
   */
  private endByTtl(): void {
    if (this.shutDown || this.ended) return;
    if (!this.played) {
      this.cancel('ttl');
      return;
    }
    if (this.assign.matchLengthSeconds > 0 && !this.host.match.overtime) {
      this.armTtl(TTL_RECHECK_MS);
      return;
    }
    const s = this.host.score;
    const winner: 0 | 1 | -1 = s.blue > s.red ? 0 : s.red > s.blue ? 1 : -1;
    this.whistle(winner, false);
    this.finish('ttl', winner);
  }

  /** Final snapshot + 'ended' event for an ending the rules did not produce themselves. */
  private whistle(winner: 0 | 1 | -1, forfeit: boolean): void {
    const host = this.host;
    try {
      this.sendSnapshots();
    } catch (e) {
      console.error('final snapshot failed', e);
    }
    const s = host.score;
    this.broadcast(encodeJson(MsgType.Event, { type: 'ended', winner, blue: s.blue, red: s.red, tick: host.currentTick, ...(forfeit ? { forfeit: true } : {}) } satisfies MatchEvent), null);
  }

  /** A started match stops: write END, hand over result + replay, linger, close. */
  private finish(reason: EndReason, winner: 0 | 1 | -1, forfeitTeam: 0 | 1 | -1 = -1): void {
    if (this.ended || this.shutDown) return;
    this.ended = true;
    this.running = false;
    this.ctx.ticker.remove(this);
    const host = this.host;
    const s = host.score;
    const endTick = host.currentTick;
    this.recorder.end({ tick: endTick, winner, blue: s.blue, red: s.red, reason, forfeitTeam });
    const replay = this.recorder.finish();
    const result: MatchResult = { winner, blue: s.blue, red: s.red, endTick, endReason: reason, ...(forfeitTeam !== -1 ? { forfeitTeam } : {}) };
    const stats = this.collectStats(endTick);
    try {
      this.ctx.hooks.onEnded(this, result, replay, stats);
    } catch (e) {
      console.error('onEnded hook threw', e);
    }
    const linger = reason === 'left' || reason === 'empty' ? 0 : this.t.endLingerMs;
    this.endTimer = setTimeout(() => {
      this.endTimer = null;
      this.close(reason === 'rules' || reason === 'forfeit' || reason === 'ttl' ? 'ended' : reason);
    }, linger);
  }

  /** stop() for a started match ('left', 'empty'); before the first tick it is a cancel. */
  private stop(reason: 'left' | 'empty'): void {
    if (!this.played) {
      this.cancel(reason);
      return;
    }
    const s = this.host.score;
    this.finish(reason, s.blue > s.red ? 0 : s.red > s.blue ? 1 : -1);
  }

  /** A match that never started: tell the clients (ranked), report, close. */
  private cancel(reason: string, noShows?: string[]): void {
    if (this.ended || this.shutDown) return;
    this.ended = true;
    const r = this.assign.roster;
    const absent =
      noShows ??
      (this.assign.ranked && this.liveSockets > 0 ? r.filter((e) => e.kind === 'player' && e.playerId && !this.clients[e.slot]?.ready).map((e) => e.playerId as string) : []);
    if (this.assign.ranked) this.broadcast(encodeJson(MsgType.Event, { type: 'cancelled', reason } satisfies MatchEvent), null);
    try {
      this.ctx.hooks.onCancelled(this, reason, absent);
    } catch (e) {
      console.error('onCancelled hook threw', e);
    }
    this.close('cancelled');
  }

  private lose(reason: string): void {
    if (this.shutDown) return;
    this.ended = true;
    this.running = false;
    this.ctx.ticker.remove(this);
    try {
      this.ctx.hooks.onLost(this, reason);
    } catch (e) {
      console.error('onLost hook threw', e);
    }
    this.close(reason);
  }

  /** Node shutdown without a drain: the match is lost. */
  dispose(reason = 'node_shutdown'): void {
    if (this.shutDown) return;
    if (!this.ended && this.host.isStarted) this.lose(reason);
    else if (!this.ended) this.cancel(reason, []);
    else this.close(reason);
  }

  private collectStats(endTick: number): MatchStats {
    const now = Date.now();
    const slots: SlotStatsReport[] = [];
    const st = this.host.slotStats;
    for (let i = 0; i < this.assign.roster.length; i++) {
      if (this.assign.roster[i].kind !== 'player') continue;
      const c = this.clients[i];
      const live = c && c.attached ? now - Math.max(c.attachedAt, this.startedAtWall) : 0;
      slots.push({ slot: i, received: st[i].received, dropped: st[i].dropped, underruns: st[i].underruns, overruns: st[i].overruns, connectedMs: Math.round(this.connectedMs[i] + live) });
    }
    let egress = this.egressBytes;
    for (const c of this.clients) if (c && c.attached) egress += c.ws.bytesSent;
    return { ticks: endTick, durationMs: this.startedAtWall > 0 ? now - this.startedAtWall : 0, slots, tickLagP99Ms: this.lag.quantile(0.99), egressBytes: egress };
  }

  /** Close every socket, clear every timer, tell the node. Idempotent. */
  private close(reason: string): void {
    if (this.shutDown) return;
    this.shutDown = true;
    this.running = false;
    this.ctx.ticker.remove(this);
    for (const tm of [this.startTimer, this.endTimer, this.earlyTimer, this.ttlTimer]) if (tm) clearTimeout(tm);
    this.startTimer = this.endTimer = this.earlyTimer = this.ttlTimer = null;
    for (let i = 0; i < MAX_CARS; i++) {
      const c = this.clients[i];
      if (c) this.detach(c, 1000, reason);
    }
    try {
      this.ctx.hooks.onClosed(this, reason);
    } catch (e) {
      console.error('onClosed hook threw', e);
    }
  }
}
