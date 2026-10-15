/**
 * RoomHost: the authoritative match loop. Environment-agnostic (no Date.now, no timers, no
 * workerd / DOM / node APIs): the owner (MatchDO today, a node server later) decides WHEN to call
 * tick() and how to ship the snapshots. Imports only the shared sim / ai / net / game modules.
 *
 * Per tick:
 *   1. every human slot takes the input queued for this tick (per-slot ring buffer keyed by tick)
 *      or repeats its last applied input (an "underrun"); bufferHint = queued - target (+-8)
 *   2. bot slots are driven by one BotTeam per team (the humans of that team are passive members
 *      so the bots rotate around them, like the offline teammates); a human slot whose player left
 *      the match for good (convertToBot, between two ticks) is a bot of its team from then on
 *   3. frozen phases (countdown, goal pause, ended, before start) apply zero controls
 *   4. sim.setControlsPacked + step(1) + sync(); the match state machine advances; its events are
 *      mapped to protocol MatchEvents (with the tick) and queued for the owner
 *
 * Snapshots: prepareSnapshot() saves the state blob + hash once per snapshot tick; snapshot(out,
 * slot) encodes it for one client with that slot's lastInputTick / bufferHint and the inputs
 * applied at this tick (echo), so every client can rs_load_state the blob and replay.
 *
 * Determinism: kickoff seeds are a counter (kickoffSeed option + resets so far); the ball is NOT
 * pinned during the goal pause (the offline Game pins it for looks; here the clients must be able
 * to reproduce every tick from the snapshot + inputs alone, so nothing touches the ball).
 * No allocations on the per-tick path: rings, scratch controls and the packed array are
 * preallocated; events are rare (a few per second at most) and allocate.
 */
import { Match } from '../../src/game/Match';
import type { MatchEvent as RulesEvent } from '../../src/game/Match';
import { BotTeam } from '../../src/ai/Team';
import type { Difficulty } from '../../src/ai/Bot';
import { MAX_CARS, PACKED_INPUT_BYTES, TICK_DT, Team, emptyControls, packControls } from '../../src/sim/types';
import type { CarControls, SimEvents, SimStateView } from '../../src/sim/types';
import { encodeSnapshot } from '../../src/net/protocol';
import type { MatchEvent } from '../../src/net/protocol';

/** The slice of RocketSim (src/sim/RocketSimBridge.ts) the host needs; a fake satisfies it in tests. */
export interface HostSim extends SimStateView {
  readonly events: SimEvents;
  updateBallPrediction(): void;
  setControlsPacked(packed: Int8Array, numSlots: number): void;
  step(n: number): void;
  sync(): void;
  resetKickoff(seed: number): void;
  /** rs_save_state into `out`; returns the byte length (throws / -1 when `out` is too small). */
  saveState(out: Uint8Array): number;
  stateHash(): number;
  stateSizeMax(): number;
}

export interface RosterEntry {
  slot: number;
  team: 0 | 1;
  kind: 'player' | 'bot';
  name: string;
  playerId?: string;
}

export interface RoomHostOptions {
  tickRate?: number;
  /** Ticks between snapshots (4 = 30 Hz at 120 Hz). */
  snapshotEvery?: number;
  /** Ideal number of queued input ticks per human slot (1-2). */
  inputBufferTarget?: number;
  /** Clamp of bufferHint and the "too far ahead" threshold for the stats. */
  inputBufferMax?: number;
  /** Inputs for ticks further ahead than this are dropped. */
  inputFutureCap?: number;
  matchLengthSeconds?: number;
  /** Kickoff countdown (default 3 s) and goal celebration pause (default 3 s). */
  kickoffCountdownSeconds?: number;
  goalPauseSeconds?: number;
  kickoffSeed?: number;
  botDifficulty?: Difficulty;
}

export interface SlotStats {
  received: number;
  dropped: number;
  underruns: number;
  overruns: number;
}

const RING = 64;
const RING_MASK = RING - 1;
const BALL_PRED_EVERY = 4;

export class RoomHost {
  readonly roster: readonly RosterEntry[];
  readonly numCars: number;
  readonly tickRate: number;
  readonly snapshotEvery: number;
  readonly inputBufferTarget: number;
  readonly inputBufferMax: number;
  readonly inputFutureCap: number;
  readonly matchLengthSeconds: number;
  readonly match: Match;
  /** Protocol events produced since the owner last drained them (push only; drain with takeEvents). */
  readonly events: MatchEvent[] = [];
  /** Per-slot counters (index = slot). */
  readonly slotStats: SlotStats[] = [];

  /** Ticks simulated so far; the snapshot tick. Inputs are keyed by the tick they apply to (>= 1). */
  private hostTick = 0;
  private started = false;
  private readonly sim: HostSim;
  private readonly isHuman = new Uint8Array(MAX_CARS);
  private readonly connected = new Uint8Array(MAX_CARS);
  private readonly ring: Int8Array; // MAX_CARS x RING x 6
  private readonly ringTick: Int32Array; // MAX_CARS x RING
  private readonly newest = new Int32Array(MAX_CARS);
  private readonly lastApplied = new Int32Array(MAX_CARS);
  private readonly last = new Int8Array(MAX_CARS * PACKED_INPUT_BYTES);
  private readonly hint = new Int8Array(MAX_CARS);
  private readonly queuedNow = new Int32Array(MAX_CARS);
  /** Controls applied at the current host tick, slot order (the snapshot echo). */
  private readonly packed = new Int8Array(MAX_CARS * PACKED_INPUT_BYTES);
  private readonly teams: BotTeam[] = [];
  private readonly teamOuts: CarControls[][] = [];
  private readonly teamSlots: number[][] = [];
  private readonly stateBuf: Uint8Array;
  private stateLen = 0;
  private stateHashValue = 0;
  private snapshotTick = -1;
  private kickoffCount = 0;
  private readonly kickoffSeed: number;
  private readonly botDifficulty: Difficulty;
  private lastClockSeconds = -1;

  constructor(sim: HostSim, roster: readonly RosterEntry[], opts: RoomHostOptions = {}) {
    if (roster.length < 1 || roster.length > MAX_CARS) throw new Error(`RoomHost: roster size ${roster.length}`);
    for (let i = 0; i < roster.length; i++) if (roster[i].slot !== i) throw new Error(`RoomHost: roster[${i}].slot must be ${i}`);
    this.sim = sim;
    this.roster = roster;
    this.numCars = roster.length;
    this.tickRate = opts.tickRate ?? 120;
    this.snapshotEvery = Math.max(1, opts.snapshotEvery ?? 4);
    this.inputBufferTarget = opts.inputBufferTarget ?? 2;
    this.inputBufferMax = opts.inputBufferMax ?? 8;
    this.inputFutureCap = opts.inputFutureCap ?? 32;
    this.matchLengthSeconds = opts.matchLengthSeconds ?? 300;
    this.kickoffSeed = opts.kickoffSeed ?? 1;
    this.match = new Match({
      lengthSeconds: this.matchLengthSeconds,
      kickoffCountdownSeconds: opts.kickoffCountdownSeconds,
      goalPauseSeconds: opts.goalPauseSeconds,
    });
    this.ring = new Int8Array(MAX_CARS * RING * PACKED_INPUT_BYTES);
    this.ringTick = new Int32Array(MAX_CARS * RING).fill(-1);
    this.newest.fill(-1);
    this.lastApplied.fill(0);
    this.stateBuf = new Uint8Array(Math.max(64, sim.stateSizeMax()));
    for (let i = 0; i < MAX_CARS; i++) this.slotStats.push({ received: 0, dropped: 0, underruns: 0, overruns: 0 });

    // Bots: one BotTeam per team that has bot slots; that team's humans are passive members.
    this.botDifficulty = opts.botDifficulty ?? 'medium';
    for (const e of roster) if (e.kind !== 'bot') this.isHuman[e.slot] = 1;
    for (const team of [Team.Blue, Team.Red] as const) this.seatTeam(team);
    sim.events.onGoal = (team) => {
      this.match.onGoal(team);
    };
  }

  /**
   * (Re)build the BotTeam of `team` from the current human / bot split: its bot slots in slot
   * order, its humans as passive members. The team's BotTeam is created on first use (fixed seed
   * per team, blue thinks first) and an existing one is re-seated (BotTeam.setSlots resets the
   * team's transient state, as a kickoff does). Construction and convertToBot only: allocates.
   */
  private seatTeam(team: Team): void {
    const bots: number[] = [];
    const humans: number[] = [];
    for (const e of this.roster) {
      if (e.team !== team) continue;
      if (this.isHuman[e.slot] === 1) humans.push(e.slot);
      else bots.push(e.slot);
    }
    if (bots.length === 0) return;
    let t = -1;
    for (let i = 0; i < this.teams.length; i++) if (this.teams[i].team === team) t = i;
    if (t < 0) {
      t = team === Team.Blue ? 0 : this.teams.length;
      this.teams.splice(t, 0, new BotTeam({ team, difficulty: this.botDifficulty, seed: team === Team.Blue ? 777 : 7 }));
      this.teamSlots.splice(t, 0, []);
      this.teamOuts.splice(t, 0, []);
    }
    this.teams[t].setSlots(bots, humans);
    this.teamSlots[t] = bots;
    const outs = this.teamOuts[t];
    while (outs.length < bots.length) outs.push(emptyControls());
  }

  /**
   * The human of `slot` left the match for good (MatchDO /internal/leave: an explicit quit, never a
   * network drop): from the next tick (currentTick + 1) on the slot is a bot of its team's BotTeam,
   * the team's other humans stay passive members. Called between two ticks, so the takeover tick is
   * a pure function of the call order: two hosts fed the same inputs and the same takeover tick
   * stay identical. Its input queue is dropped and later inputs for it are refused. Allocates (once
   * per leave). False when `slot` is not a human slot (already a bot, or out of range).
   */
  convertToBot(slot: number): boolean {
    if (!this.isHumanSlot(slot)) return false;
    this.setConnected(slot, false); // empties the ring, the hint and the held input
    this.isHuman[slot] = 0;
    this.queuedNow[slot] = 0;
    this.seatTeam(this.roster[slot].team);
    return true;
  }

  // ---- state ------------------------------------------------------------------------------

  /** Ticks simulated so far (the tick of the latest state); tick() advances it. */
  get currentTick(): number {
    return this.hostTick;
  }

  get phase(): Match['phase'] {
    return this.match.phase;
  }

  get ended(): boolean {
    return this.match.phase === 'ended';
  }

  get isStarted(): boolean {
    return this.started;
  }

  /** Cars take no input: before start, countdown, goal pause, after the whistle. */
  get frozen(): boolean {
    const m = this.match;
    return !this.started || m.frozen || m.inGoalPause || m.phase === 'ended' || m.phase === 'menu';
  }

  get score(): { blue: number; red: number } {
    return this.match.score;
  }

  isHumanSlot(slot: number): boolean {
    return slot >= 0 && slot < this.numCars && this.isHuman[slot] === 1;
  }

  lastInputTick(slot: number): number {
    return this.lastApplied[slot];
  }

  bufferHint(slot: number): number {
    return this.hint[slot];
  }

  /** Newest buffered tick minus the next tick to simulate (negative = the client is behind). */
  queued(slot: number): number {
    return this.queuedNow[slot];
  }

  /** Begin the match: the first tick() starts the kickoff countdown. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.match.start();
  }

  /** A human's socket came (true) or went (false): a disconnected slot gets zero controls. */
  setConnected(slot: number, connected: boolean): void {
    if (!this.isHumanSlot(slot)) return;
    this.connected[slot] = connected ? 1 : 0;
    if (!connected) {
      this.newest[slot] = -1;
      this.hint[slot] = 0;
      this.last.fill(0, slot * PACKED_INPUT_BYTES, (slot + 1) * PACKED_INPUT_BYTES);
      for (let i = 0; i < RING; i++) this.ringTick[slot * RING + i] = -1;
    }
  }

  // ---- inputs -----------------------------------------------------------------------------

  /**
   * Queue `count` consecutive ticks of packed controls (6 int8 each, oldest first, starting at
   * `packed[off]`) for `slot`. Ticks already simulated are ignored, ticks further than
   * inputFutureCap ahead are dropped. Returns how many ticks were stored.
   */
  addInputs(slot: number, firstTick: number, count: number, packed: Int8Array, off: number = 0): number {
    if (!this.isHumanSlot(slot) || count <= 0) return 0;
    const st = this.slotStats[slot];
    const minTick = this.hostTick + 1;
    const maxTick = this.hostTick + this.inputFutureCap;
    let stored = 0;
    for (let i = 0; i < count; i++) {
      const t = firstTick + i;
      if (t < minTick) continue;
      if (t > maxTick) {
        st.dropped += count - i;
        break;
      }
      const r = slot * RING + (t & RING_MASK);
      this.ringTick[r] = t;
      const dst = r * PACKED_INPUT_BYTES;
      const src = off + i * PACKED_INPUT_BYTES;
      for (let k = 0; k < PACKED_INPUT_BYTES; k++) this.ring[dst + k] = packed[src + k];
      if (t > this.newest[slot]) this.newest[slot] = t;
      stored++;
    }
    st.received += stored;
    return stored;
  }

  // ---- tick -------------------------------------------------------------------------------

  tick(): void {
    const sim = this.sim;
    const T = this.hostTick + 1;
    const packed = this.packed;
    const frozen = this.frozen;
    const n = this.numCars;

    // 1) humans
    for (let slot = 0; slot < n; slot++) {
      if (this.isHuman[slot] === 0) continue;
      const base = slot * PACKED_INPUT_BYTES;
      const r = slot * RING + (T & RING_MASK);
      const st = this.slotStats[slot];
      if (this.ringTick[r] === T) {
        const src = r * PACKED_INPUT_BYTES;
        for (let k = 0; k < PACKED_INPUT_BYTES; k++) this.last[base + k] = this.ring[src + k];
        this.ringTick[r] = -1;
        this.lastApplied[slot] = T;
      } else if (this.connected[slot] === 1 && this.newest[slot] >= 0 && this.started) {
        st.underruns++;
      }
      const queued = this.newest[slot] >= 0 ? this.newest[slot] - T : 0;
      this.queuedNow[slot] = queued;
      if (this.newest[slot] < 0 || this.connected[slot] === 0) {
        this.hint[slot] = 0;
      } else {
        let h = queued - this.inputBufferTarget;
        if (h > this.inputBufferMax) {
          h = this.inputBufferMax;
          st.overruns++;
        } else if (h < -this.inputBufferMax) h = -this.inputBufferMax;
        this.hint[slot] = h;
      }
      for (let k = 0; k < PACKED_INPUT_BYTES; k++) packed[base + k] = frozen ? 0 : this.last[base + k];
    }

    // 2) bots
    if (frozen) {
      for (let t = 0; t < this.teams.length; t++) {
        const slots = this.teamSlots[t];
        for (let i = 0; i < slots.length; i++) packed.fill(0, slots[i] * PACKED_INPUT_BYTES, (slots[i] + 1) * PACKED_INPUT_BYTES);
      }
    } else if (this.teams.length > 0) {
      const age = sim.tickCount - (sim.predTick ?? sim.tickCount);
      if (age >= BALL_PRED_EVERY || age < 0) sim.updateBallPrediction();
      for (let t = 0; t < this.teams.length; t++) {
        const outs = this.teamOuts[t];
        const slots = this.teamSlots[t];
        this.teams[t].think(sim, outs);
        for (let i = 0; i < slots.length; i++) packControls(outs[i], packed, slots[i] * PACKED_INPUT_BYTES);
      }
    }

    // 3) sim
    sim.setControlsPacked(packed, n);
    sim.step(1);
    sim.sync(); // fires onGoal -> match.onGoal
    this.hostTick = T;

    // 4) rules
    const evs = this.match.tick(TICK_DT);
    for (let i = 0; i < evs.length; i++) this.onRulesEvent(evs[i]);
    if (this.match.phase === 'playing') {
      const s = this.match.displaySeconds;
      if (s !== this.lastClockSeconds) {
        this.lastClockSeconds = s;
        this.events.push({ type: 'clock', seconds: s, tick: T });
      }
    }
  }

  private onRulesEvent(e: RulesEvent): void {
    const tick = this.hostTick;
    switch (e.type) {
      case 'kickoffReset': {
        const seed = this.kickoffSeed + this.kickoffCount++;
        this.sim.resetKickoff(seed);
        this.sim.sync();
        for (let t = 0; t < this.teams.length; t++) this.teams[t].reset();
        this.events.push({ type: 'kickoff', tick });
        break;
      }
      case 'countdown':
        this.events.push({ type: 'countdown', n: e.n, tick });
        break;
      case 'go':
        this.lastClockSeconds = -1;
        this.events.push({ type: 'go', tick });
        break;
      case 'goal':
        this.events.push({ type: 'goal', team: e.team, blue: e.blue, red: e.red, tick });
        break;
      case 'overtime':
        this.events.push({ type: 'overtime', tick });
        break;
      case 'ended':
        this.events.push({ type: 'ended', winner: e.winner, blue: this.match.score.blue, red: this.match.score.red, tick });
        break;
      case 'freeze':
        break;
    }
  }

  /** Move the queued events into `out` (cleared first) and return how many there were. */
  takeEvents(out: MatchEvent[]): number {
    out.length = 0;
    const n = this.events.length;
    for (let i = 0; i < n; i++) out.push(this.events[i]);
    this.events.length = 0;
    return n;
  }

  // ---- snapshots --------------------------------------------------------------------------

  /** True right after a tick on which the owner should send snapshots. */
  get snapshotDue(): boolean {
    return this.hostTick > 0 && this.hostTick % this.snapshotEvery === 0;
  }

  /** Save the state blob + hash for the current tick (once; snapshot() calls it lazily). */
  prepareSnapshot(): void {
    if (this.snapshotTick === this.hostTick) return;
    const len = this.sim.saveState(this.stateBuf);
    if (len <= 0 || len > this.stateBuf.length) throw new Error(`RoomHost: saveState returned ${len}`);
    this.stateLen = len;
    this.stateHashValue = this.sim.stateHash();
    this.snapshotTick = this.hostTick;
  }

  /** Encode the current tick's snapshot for `slot` into `out`; returns the byte length. */
  snapshot(out: Uint8Array, slot: number): number {
    this.prepareSnapshot();
    return encodeSnapshot(
      out,
      this.hostTick,
      this.isHuman[slot] === 1 ? this.lastApplied[slot] : 0,
      this.hint[slot],
      this.numCars,
      this.packed,
      this.stateBuf,
      this.stateLen,
      this.stateHashValue,
    );
  }

  /** Bytes a snapshot needs at most (for the owner's out buffer). */
  get snapshotMaxBytes(): number {
    return 13 + this.numCars * PACKED_INPUT_BYTES + this.stateBuf.length + 4;
  }

  get stateHash(): number {
    return this.stateHashValue;
  }

  get stateLength(): number {
    return this.stateLen;
  }

  /** The controls applied at the latest tick (slot order, 6 int8 per slot). Read-only view. */
  get appliedInputs(): Int8Array {
    return this.packed;
  }
}

