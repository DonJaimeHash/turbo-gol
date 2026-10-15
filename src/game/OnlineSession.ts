/**
 * OnlineSession: an online match (phase 1, docs/online/PHASE1.md) driven inside the Game's frame
 * loop. States: idle -> queue (matchmaking long-poll) -> connecting (socket open, roster built from
 * the Welcome, waiting for the first snapshot) -> playing -> ended (host whistle) -> idle.
 *
 * Clock: the local sim runs `lead` ticks ahead of the estimated host tick (ClockSync):
 *   lead = ceil((rtt / 2 + jitter margin) / 8.333 ms) + 1, clamped to [2, 24], corrected by the
 *   host's bufferHint stream (+-1 tick per second of consistent hints, LeadAdjuster). The drift
 *   `localTick - (hostTickEstimate + lead)` is absorbed by scaling the tick period (the sim runs
 *   0.95-1.05x real time); beyond HARD_RESYNC_TICKS the local tick jumps (extra steps when behind,
 *   stalled ticks when ahead).
 *
 * Per tick (Game.onlineTick -> stepTick): the player's controls are packed into the predictor's
 * ring (zeroed while the host has the cars frozen) and the sim steps with them and the held remote
 * inputs. At most ONE input packet goes out per advance() (per frame), once two or more ticks were
 * stepped since the last one, carrying the newest 2 ticks plus every tick newer than the host's
 * lastInputTick (cap 16): 60 packets/s at any frame rate >= 60 fps, fewer (and fatter) packets on
 * a slow frame instead of a burst the host would throttle. Snapshots are staged on arrival and
 * applied at the start of the next advance() (RollbackPredictor.applySnapshot: load, replay,
 * visual offsets).
 *
 * The match flow (countdown / go / goal / clock / overtime / ended) comes from host events; the
 * offline Match is never ticked online. Leaving closes the socket with 1000 and puts the offline
 * roster back (Game.restoreOfflineRoster). An explicit quit of a running match (leave() from the
 * menu, cancel() while connecting) also POSTs /api/leave { matchId } as the socket closes: the
 * server frees our lock at once and the host's bots take our car for good, so the next queue
 * (P2P or server) is a fresh one instead of a rejoin. A connection lost for good (the one
 * automatic rejoin failed, a kick) or a reload sends nothing: the lock stays and the next server
 * queue rejoins through its 409; after the final whistle the match frees the locks itself.
 */
import { TICK_MS, LeadAdjuster, computeLead } from '../net/ClockSync';
import { assembleInputs, INPUT_MAX_PER_PACKET } from '../net/InputRing';
import { NetClient, NetError, type MatchAssignment, type NetClientOptions } from '../net/NetClient';
import { RateMeter, newNetStatsView, resetNetStatsView, type NetStatsView } from '../net/NetStats';
import { RollbackPredictor, type RollbackSim } from '../net/Prediction';
import { TICK_RATE, type MatchEvent, type SnapshotPacket, type Welcome } from '../net/protocol';
import { ONLINE_STATUS, type ClockMode } from '../render/Hud';
import type { GameMode } from '../sim/constants';
import type { RocketSim } from '../sim/RocketSimBridge';
import { MAX_CARS, MAX_STATE_BYTES, PACKED_INPUT_BYTES, TICK_DT, packControls, type CarControls } from '../sim/types';
import type { Game } from './Game';

/**
 * The bridge as the predictor sees it. The save / load / hash / packed-controls methods are added
 * to RocketSimBridge.ts together with the new wasm exports (rs_save_state, rs_load_state,
 * rs_state_hash, rs_state_size_max, rs_set_controls_packed); an older build fails here with a
 * readable menu error instead of inside the first snapshot.
 */
export function rollbackSimOf(sim: RocketSim): RollbackSim {
  const s = sim as unknown as Partial<Record<keyof RollbackSim, unknown>>;
  const missing: string[] = [];
  for (const m of ['saveState', 'loadState', 'stateHash', 'stateSizeMax', 'setControlsPacked'] as const) {
    if (typeof s[m] !== 'function') missing.push(m);
  }
  if (missing.length > 0) throw new Error(`the physics build has no rollback support (${missing.join(', ')}): npm run build:wasm`);
  return sim as RocketSim & RollbackSim;
}

export type OnlineState = 'idle' | 'queue' | 'connecting' | 'playing' | 'ended';

export interface OnlineSessionOptions {
  client?: NetClient;
  clientOptions?: NetClientOptions;
  now?: () => number;
}

/** |drift| beyond this many ticks jumps the local tick instead of slewing. */
export const HARD_RESYNC_TICKS = 8;
/** Most ticks stepped in one frame to catch up after a hard resync / a long frame. */
const MAX_CATCHUP_TICKS = 64;
/** Tick-rate scaling range and gain (per tick of drift). */
const RATE_MIN = 0.95;
const RATE_MAX = 1.05;
const RATE_GAIN = 0.02;
/** Longest frame the loop catches up on (s), like Game's MAX_FRAME_DT. */
const MAX_FRAME_DT = 0.1;
/** Input packet cadence: a packet goes out once this many ticks were stepped since the last one. */
const SEND_EVERY = 2;
const STATS_INTERVAL_MS = 250;
const QUEUE_STATUS = 'Buscando partido...';

/** User-facing text for a failure (NetError 'turnstile' gets the Hud's readable strings). */
function describe(err: unknown): string {
  if (err instanceof NetError) {
    if (err.code === 'turnstile') return err.status === 503 ? ONLINE_STATUS.turnstileUnconfigured : ONLINE_STATUS.turnstileFailed;
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export class OnlineSession {
  readonly kind = 'server' as const;
  state: OnlineState = 'idle';
  /** Menu status line while queueing / connecting ('' otherwise). */
  status = '';
  /** Prefix of the status line (a P2P fallback explains why it ended up here); cleared by quickMatch. */
  notice = '';
  /** Last failure (shown in the menu until the next attempt). */
  error: string | null = null;
  mode: GameMode = '1v1';
  /** The current match is ranked (queue kind 'ranked'): rated by the server when it ends. */
  ranked = false;
  /**
   * The last ranked match that reached its whistle (forfeit included): the menu fetches its rating
   * change (AccountClient.waitRankedResult) and clears this. Survives the teardown.
   */
  lastRankedMatchId: string | null = null;

  readonly client: NetClient;
  predictor: RollbackPredictor | null = null;
  welcome: Welcome | null = null;
  readonly stats: NetStatsView = newNetStatsView();

  // Clock.
  lead = 4;
  rateScale = 1;
  drift = 0;
  hardResyncs = 0;

  // Match flow from host events.
  readonly score: { blue: number; red: number } = { blue: 0, red: 0 };
  frozen = true;
  overtime = false;
  winner: -1 | 0 | 1 = -1;

  private readonly game: Game;
  private readonly now: () => number;
  private readonly adjuster = new LeadAdjuster();
  private clockSeconds = 0;
  private clockTick = 0;
  private clockKnown = false;
  private matchLength = 300;

  /** Staged copy of the newest snapshot (applied at the next advance()). */
  private readonly pending: SnapshotPacket = {
    tick: 0,
    lastInputTick: 0,
    bufferHint: 0,
    numCars: 0,
    inputs: new Int8Array(MAX_CARS * PACKED_INPUT_BYTES),
    stateLen: 0,
    state: new Uint8Array(MAX_STATE_BYTES),
    stateHash: 0,
  };
  private hasPending = false;

  private acc = 0;
  private stallTicks = 0;
  /** Local ticks stepped since the last input packet (advance() sends once it reaches SEND_EVERY). */
  private ticksSinceSend = 0;
  private readonly packed = new Int8Array(PACKED_INPUT_BYTES);
  private readonly sendBuf = new Int8Array(INPUT_MAX_PER_PACKET * PACKED_INPUT_BYTES);
  private readonly rollbackMeter = new RateMeter(STATS_INTERVAL_MS);
  private readonly replayMeter = new RateMeter(STATS_INTERVAL_MS);
  private readonly bytesInMeter = new RateMeter(STATS_INTERVAL_MS);
  private readonly bytesOutMeter = new RateMeter(STATS_INTERVAL_MS);
  private statsAt = -1e9;
  /** Bumped by cancel() / leave(): async results of an older attempt are ignored. */
  private attempt = 0;
  /** The match assigned to this attempt (queue / joinAssigned / Welcome), what an explicit quit names in POST /api/leave. */
  private matchId: string | null = null;
  /** The connection was lost for good (disconnect()): leaving then keeps the server lock (the rejoin path). */
  private lost = false;

  constructor(game: Game, opts: OnlineSessionOptions = {}) {
    this.game = game;
    this.now = opts.now ?? (() => performance.now());
    // The Turnstile widget (guest registration behind a sitekey) renders into the Hud's menu slot.
    this.client = opts.client ?? new NetClient({ turnstileContainer: () => game.hud.turnstileContainer, ...opts.clientOptions });
    const c = this.client;
    c.onTurnstile = (active) => this.handleTurnstile(active);
    c.onWelcome = (w) => this.handleWelcome(w);
    c.onSnapshot = (pkt) => this.handleSnapshot(pkt);
    c.onEvent = (e) => this.handleEvent(e);
    c.onClose = (code, reason, reconnecting) => this.handleClose(code, reason, reconnecting);
    c.onError = (code, message) => this.handleError(code, message);
  }

  /** A match is being set up, played or just ended: the Game runs the online loop and roster. */
  get active(): boolean {
    return this.state === 'connecting' || this.state === 'playing' || this.state === 'ended';
  }

  /** Matchmaking / connecting: the menu shows `status` and Esc / B cancels. */
  get busy(): boolean {
    return this.state === 'queue' || this.state === 'connecting';
  }

  get name(): string {
    return this.client.name;
  }

  setName(name: string): void {
    this.client.setName(name);
  }

  /** A match is on screen and taking input (the GameSession view; 'ended' keeps rendering but takes none). */
  get inMatch(): boolean {
    return this.state === 'playing';
  }

  /** Visual error offsets of the rollback (uu), null before the first snapshot. */
  get errorOffsetCar(): Float32Array | null {
    return this.predictor !== null ? this.predictor.errorOffsetCar : null;
  }

  get errorOffsetBall(): Float32Array | null {
    return this.predictor !== null ? this.predictor.errorOffsetBall : null;
  }

  /** In-match hint line (none in phase 1: the host never waits for a player). */
  get hint(): string | null {
    return null;
  }

  /** Text for the menu status line (null = nothing to show). */
  get statusText(): string | null {
    if (this.busy) return this.notice.length > 0 ? `${this.notice} · ${this.status}` : this.status;
    return this.error;
  }

  get statusIsError(): boolean {
    return !this.busy && this.error !== null;
  }

  // ---- lifecycle -------------------------------------------------------------------------

  /** Quick match in `mode`: guest session, queue long-poll, connect. No-op unless idle. `notice` prefixes the status line. */
  quickMatch(mode: GameMode, notice = '', kind: 'server' | 'ranked' = 'server'): void {
    if (this.state !== 'idle') return;
    this.mode = mode;
    this.error = null;
    this.notice = notice;
    this.state = 'queue';
    this.status = QUEUE_STATUS;
    this.matchId = null;
    this.lost = false;
    this.ranked = kind === 'ranked';
    const attempt = ++this.attempt;
    this.client
      .queue(mode, kind, (waiting) => {
        if (attempt === this.attempt && this.state === 'queue') this.status = `Buscando partido... (${waiting} esperando)`;
      })
      .then(
        (m) => {
          if (attempt !== this.attempt || this.state !== 'queue') return;
          if (m.kind !== 'server') {
            this.fail('El servidor respondió con una sala P2P a una búsqueda de servidor');
            return;
          }
          this.state = 'connecting';
          this.status = 'Conectando...';
          this.matchId = m.matchId;
          this.ranked = m.ranked === true || kind === 'ranked';
          this.client.connect(m.wsUrl, m.ticket);
        },
        (err: unknown) => {
          if (attempt !== this.attempt) return;
          if (err instanceof NetError && err.code === 'cancelled') {
            this.state = 'idle';
            this.status = '';
            return;
          }
          this.fail(describe(err));
        },
      );
  }

  /**
   * Join a match the matchmaker already assigned (a P2P queue answered with a server match): skip
   * the queue and connect. No-op unless idle. `notice` prefixes the status line while connecting.
   */
  joinAssigned(mode: GameMode, m: MatchAssignment, notice = ''): void {
    if (this.state !== 'idle') return;
    this.mode = mode;
    this.ranked = false;
    this.error = null;
    this.notice = notice;
    this.attempt++;
    this.state = 'connecting';
    this.status = 'Conectando...';
    this.matchId = m.matchId;
    this.lost = false;
    this.client.connect(m.wsUrl, m.ticket);
  }

  /** Abort matchmaking / connecting (Esc, B, PLAY). The roster is restored if it was rebuilt. */
  cancel(): void {
    if (!this.busy) return;
    this.attempt++;
    // Connecting: the match is assigned (our slot waits for us), so this is a quit of that match.
    if (this.state === 'connecting') this.quitMatch();
    this.client.close(1000, 'cancel');
    const hadRoster = this.predictor !== null;
    this.teardown();
    this.state = 'idle';
    this.status = '';
    if (hadRoster) this.game.restoreOfflineRoster();
  }

  /** Leave the match (menu, quit, final whistle): POST /api/leave { matchId } (quitMatch), close 1000 and restore the offline roster. */
  leave(): void {
    if (this.state === 'idle') return;
    if (this.busy) {
      this.cancel();
      return;
    }
    this.attempt++;
    this.quitMatch();
    this.client.close(1000, 'leave');
    this.teardown();
    this.state = 'idle';
    this.status = '';
    this.game.restoreOfflineRoster();
  }

  /**
   * An explicit quit of the assigned match: POST /api/leave { matchId } (fire and forget; the
   * client's next queue waits for it), sent before the socket closes. The server frees our lock,
   * closes our slot's socket if it is still open and hands the car to the host's bots; the slot
   * is never rejoined. Skipped after the whistle (the match is over and frees the locks itself)
   * and once the connection was lost for good (disconnect(): the lock is kept so the next server
   * queue rejoins, as after a reload). Once per match.
   */
  private quitMatch(): void {
    const id = this.matchId;
    this.matchId = null;
    if (id === null || this.lost || this.state === 'ended') return;
    void this.client.leaveMatch(id);
  }

  dispose(): void {
    this.leave();
    this.client.dispose();
  }

  // ---- loop ------------------------------------------------------------------------------

  /**
   * Run the online ticks for a frame of `dt` seconds: apply the staged snapshot, slew / resync the
   * local tick towards hostTickEstimate + lead, step through Game.onlineTick(). Returns the
   * interpolation alpha.
   */
  advance(dt: number): number {
    const pred = this.predictor;
    if (pred === null || (this.state !== 'playing' && this.state !== 'ended')) return 0;
    if (this.hasPending) {
      this.hasPending = false;
      pred.applySnapshot(this.pending);
      this.game.afterRollback();
    }
    const now = this.now();
    const client = this.client;
    if (client.clock.samples > 0) {
      this.lead = computeLead(client.rtt, client.jitter, this.adjuster.adjust);
      const target = client.hostTickEstimate(now) + this.lead;
      let drift = pred.localTick - target;
      if (drift < -HARD_RESYNC_TICKS) {
        // Behind: step straight to the target (held remote inputs, live own input), then one
        // packet with the newest ticks (the host budgets input packets per tick).
        let n = Math.floor(-drift);
        if (n > MAX_CATCHUP_TICKS) n = MAX_CATCHUP_TICKS;
        for (let i = 0; i < n; i++) this.game.onlineTick();
        this.sendInputs();
        this.hardResyncs++;
        this.stallTicks = 0;
        drift = pred.localTick - target;
      } else if (drift > HARD_RESYNC_TICKS) {
        // Ahead: hold the sim until the host catches up. The stall spans several frames (the
        // drift shrinks as the host advances); it is one resync, counted when it begins.
        if (this.stallTicks === 0) this.hardResyncs++;
        this.stallTicks = Math.floor(drift);
      }
      this.drift = drift;
      let rate = 1 - drift * RATE_GAIN;
      if (rate < RATE_MIN) rate = RATE_MIN;
      else if (rate > RATE_MAX) rate = RATE_MAX;
      this.rateScale = rate;
    } else {
      this.rateScale = 1;
      this.drift = 0;
    }
    const period = TICK_DT / this.rateScale;
    this.acc += dt;
    if (this.acc > MAX_FRAME_DT) this.acc = MAX_FRAME_DT;
    while (this.acc >= period) {
      if (this.stallTicks > 0) this.stallTicks--;
      else this.game.onlineTick();
      this.acc -= period;
    }
    // One packet per frame at most: a 6-12 tick frame (slow tab) sends a single fat packet (the
    // unacked ticks ride along, cap 16) instead of a burst the host would partly drop.
    if (this.ticksSinceSend >= SEND_EVERY) this.sendInputs();
    if (now - this.statsAt >= STATS_INTERVAL_MS) {
      this.statsAt = now;
      this.updateStats(now);
    }
    return this.acc / period;
  }

  /**
   * One local tick with the player's controls (Game.onlineTick calls it between input sampling
   * and sim.sync()): pack, step, decay the visual offsets. The packet goes out from advance().
   */
  stepTick(controls: CarControls): void {
    const pred = this.predictor;
    if (pred === null) return;
    const packed = this.packed;
    if (this.frozen) packed.fill(0);
    else packControls(controls, packed, 0);
    const tick = pred.localTick + 1;
    pred.stepLocal(tick, packed, 0);
    this.ticksSinceSend++;
    pred.decayOffsets();
  }

  // ---- HUD helpers -----------------------------------------------------------------------

  /** Host tick now: the extrapolated estimate, never behind the newest snapshot. */
  hostTickNow(): number {
    const est = Math.floor(this.client.hostTickEstimate(this.now()));
    const snap = this.predictor !== null ? this.predictor.lastSnapshotTick : 0;
    return est > snap ? est : snap;
  }

  /** Whole seconds for the HUD clock, extrapolated from the last 'clock' event by host ticks. */
  get displaySeconds(): number {
    if (!this.clockKnown) return this.matchLength;
    const elapsed = this.hostTickNow() - this.clockTick;
    const dsec = elapsed > 0 ? Math.floor(elapsed / TICK_RATE) : 0;
    if (this.overtime || this.matchLength <= 0) return this.clockSeconds + dsec;
    const s = this.clockSeconds - dsec;
    return s > 0 ? s : 0;
  }

  get clockMode(): ClockMode {
    return this.overtime ? 'overtime' : this.matchLength <= 0 ? 'unlimited' : 'regulation';
  }

  /** Allocates a string: call only when displaySeconds changed. */
  formatClock(): string {
    const total = this.displaySeconds;
    const m = Math.floor(total / 60);
    const s = total - m * 60;
    return `${this.overtime ? '+' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
  }

  // ---- host messages ---------------------------------------------------------------------

  private handleWelcome(w: Welcome): void {
    if (this.state !== 'connecting' && this.state !== 'playing') return;
    this.welcome = w;
    this.matchId = w.matchId;
    this.matchLength = w.matchLengthSeconds;
    if (!this.clockKnown) {
      this.clockSeconds = w.matchLengthSeconds;
      this.clockTick = w.tick;
    }
    const existing = this.predictor;
    if (existing === null) {
      let sim: RollbackSim;
      try {
        sim = rollbackSimOf(this.game.sim);
        this.game.applyOnlineRoster(w);
      } catch (err) {
        this.fail(`Roster: ${describe(err)}`);
        return;
      }
      const pred = new RollbackPredictor(sim, w.slot, w.roster.length);
      pred.trackHashes = this.game.hud.netVisible;
      this.predictor = pred;
      this.score.blue = 0;
      this.score.red = 0;
      this.frozen = true;
      this.overtime = false;
      this.winner = -1;
      this.status = 'Esperando al host...';
    } else {
      // Same match after a rejoin: the next snapshot resyncs the state; forget the stale ring.
      existing.reset();
      this.status = '';
    }
    this.client.sendReady();
  }

  private handleSnapshot(pkt: SnapshotPacket): void {
    const pred = this.predictor;
    if (pred === null) return;
    const p = this.pending;
    p.tick = pkt.tick;
    p.lastInputTick = pkt.lastInputTick;
    p.bufferHint = pkt.bufferHint;
    p.numCars = pkt.numCars;
    p.inputs.set(pkt.inputs.subarray(0, pkt.numCars * PACKED_INPUT_BYTES));
    p.stateLen = pkt.stateLen;
    p.state.set(pkt.state.subarray(0, pkt.stateLen));
    p.stateHash = pkt.stateHash;
    this.adjuster.onHint(pkt.bufferHint);
    if (this.state === 'connecting') {
      // First authoritative state: load it now and start the match on screen.
      pred.applySnapshot(p);
      this.hasPending = false;
      this.state = 'playing';
      this.status = '';
      this.acc = 0;
      this.stallTicks = 0;
      this.game.startOnlineMatch();
      return;
    }
    this.hasPending = true;
  }

  private handleEvent(e: MatchEvent): void {
    if (!this.active) return;
    switch (e.type) {
      case 'countdown':
      case 'kickoff':
        this.frozen = true;
        break;
      case 'go':
        this.frozen = false;
        break;
      case 'goal':
        this.score.blue = e.blue;
        this.score.red = e.red;
        this.frozen = true;
        break;
      case 'overtime':
        this.overtime = true;
        this.clockSeconds = 0;
        this.clockTick = e.tick;
        this.clockKnown = true;
        break;
      case 'clock':
        this.clockSeconds = e.seconds;
        this.clockTick = e.tick;
        this.clockKnown = true;
        break;
      case 'ended':
        this.score.blue = e.blue;
        this.score.red = e.red;
        this.winner = e.winner;
        this.frozen = true;
        this.state = 'ended';
        if (this.ranked && this.matchId !== null) this.lastRankedMatchId = this.matchId;
        if (this.predictor !== null) this.predictor.hold.fill(0);
        break;
      case 'cancelled':
        // A ranked match that never started (someone did not connect): nothing to rejoin, the
        // server freed our lock; back to the menu with the reason.
        this.game.onOnlineEvent(e);
        this.error = e.reason === 'dodge' ? 'Partida cancelada: un jugador salió antes de empezar' : 'Partida cancelada: un jugador no se conectó a tiempo';
        this.lost = false;
        this.game.onOnlineDisconnected(this.error);
        return;
      default:
        break;
    }
    this.game.onOnlineEvent(e);
  }

  /** The anti-bot challenge brackets the guest registration at the start of the queue step. */
  private handleTurnstile(active: boolean): void {
    if (this.state !== 'queue') return;
    this.status = active ? ONLINE_STATUS.verifying : QUEUE_STATUS;
  }

  private handleClose(code: number, reason: string, reconnecting: boolean): void {
    if (!this.active) return;
    if (reconnecting) {
      this.status = 'Reconectando...';
      return;
    }
    if (this.state === 'ended') return; // the whistle already scheduled the menu
    this.disconnect(`Conexión perdida (${code}${reason.length > 0 ? `: ${reason}` : ''})`);
  }

  private handleError(code: string, message: string): void {
    if (code === 'kick') {
      if (this.active) this.disconnect(`Expulsado: ${message}`);
      else this.fail(`Expulsado: ${message}`);
      return;
    }
    if (this.state === 'connecting' || this.state === 'queue') {
      this.fail(message);
      return;
    }
    this.error = message;
  }

  // ---- internals -------------------------------------------------------------------------

  /** Matchmaking / connecting failed: back to idle with the error on the menu. */
  private fail(message: string): void {
    this.attempt++;
    this.client.close(1000, 'failed');
    const hadRoster = this.predictor !== null;
    this.teardown();
    this.state = 'idle';
    this.status = '';
    this.error = message;
    if (hadRoster) this.game.restoreOfflineRoster();
  }

  /** The socket died mid-match: the Game shows the menu (which leaves the session, keeping the server lock). */
  private disconnect(message: string): void {
    this.error = message;
    this.lost = true;
    this.game.onOnlineDisconnected(message);
  }

  private teardown(): void {
    this.predictor = null;
    this.welcome = null;
    this.matchId = null;
    this.hasPending = false;
    this.acc = 0;
    this.stallTicks = 0;
    this.ticksSinceSend = 0;
    this.drift = 0;
    this.rateScale = 1;
    this.clockKnown = false;
    this.overtime = false;
    this.frozen = true;
    this.winner = -1;
    this.adjuster.reset();
    this.rollbackMeter.reset();
    this.replayMeter.reset();
    this.bytesInMeter.reset();
    this.bytesOutMeter.reset();
    resetNetStatsView(this.stats); // the HUD panel keeps this object: no stale rates after the match
  }

  private sendInputs(): void {
    this.ticksSinceSend = 0;
    const pred = this.predictor;
    if (pred === null) return;
    const count = assembleInputs(pred.inputs, this.client.lastInputTickAcked, this.sendBuf);
    if (count === 0) return;
    const first = pred.inputs.newestTick - count + 1;
    this.client.sendInputs(first, count, this.sendBuf, pred.lastSnapshotTick);
  }

  private updateStats(now: number): void {
    const s = this.stats;
    const c = this.client;
    const p = this.predictor;
    s.state = this.state;
    s.kind = 'server';
    s.rttMs = c.rtt;
    s.jitterMs = c.jitter;
    s.lossPct = c.loss.loss * 100;
    s.lead = this.lead;
    s.leadAdjust = this.adjuster.adjust;
    s.hostTick = this.hostTickNow();
    s.localTick = p !== null ? p.localTick : 0;
    s.rateScale = this.rateScale;
    s.rollbacksPerSec = this.rollbackMeter.sample(now, p !== null ? p.rollbacks : 0);
    s.replayedPerSec = this.replayMeter.sample(now, p !== null ? p.replayedTicks : 0);
    s.desyncs = p !== null ? p.desyncs + p.loadErrors : 0;
    s.resyncs = (p !== null ? p.resyncs : 0) + this.hardResyncs;
    s.mispredictions = p !== null ? p.mispredictions : 0;
    s.errorCar = p !== null ? p.lastErrorCar : 0;
    s.bufferHint = c.lastBufferHint;
    s.bytesInPerSec = this.bytesInMeter.sample(now, c.bytesIn);
    s.bytesOutPerSec = this.bytesOutMeter.sample(now, c.bytesOut);
    s.snapshotAgeMs = c.snapshotAge(now);
    s.reconnects = c.reconnects;
  }
}

/** Milliseconds per tick re-exported for the Game's HUD readouts. */
export { TICK_MS };
