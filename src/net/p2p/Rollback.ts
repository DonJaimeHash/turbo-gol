/**
 * RollbackEngine: deterministic lockstep with rollback (GGPO style) for the P2P mesh, see
 * docs/online/PHASE2.md "Motor de rollback". Pure TypeScript (no DOM, no node APIs); the sim is the
 * RollbackSim slice of RocketSimBridge (tests/p2p-rollback-wasm.test.mjs runs it on the real wasm).
 *
 * Two timelines live in ONE sim instance:
 *   - confirmed (F = confirmedTick): every active human slot's input for every tick <= F is
 *     known. Each tick is simulated here exactly once, in order, with the bots
 *     (hooks.botInputs) and the match flow (hooks.onConfirmedTick) evaluated per tick; the
 *     rs_save_state blob of every confirmed tick is kept in a ring of historyTicks and the hash
 *     of every tick multiple of hashEvery is recorded for the peer vote (confirmedHashes /
 *     receiveHash) together with its blob (stateAt / resync).
 *   - predicted (tick): F+1..tick simulated with hold-last inputs for every slot whose input is
 *     unknown (bot slots hold their last confirmed bot input). The hooks never run here; this is
 *     what the views render.
 *
 * advance() produces tick+1: when a received input differed from what a predicted tick applied
 * (dirty) or when the confirmed timeline can move (F' > F, F' = highest tick every active human
 * slot has an input for, capped at tick+1), it loads snapshot F, confirms F+1..F', re-predicts
 * F'+1..tick+1 and syncs; otherwise it only predicts tick+1 from the current state.
 *
 * Determinism contract (binding for every peer): same wasm, same roster, rs_reset_kickoff(seed)
 * with the room seed BEFORE constructing the engine (tick 0 = the kickoff layout), bots and Match
 * only ever run inside the hooks (confirmed timeline). The hooks see `buf` synced: the engine
 * syncs after every confirmed step (loadState refreshes `buf` too), so botInputs(t) reads the
 * confirmed state at t-1 and onConfirmedTick(t) the confirmed state at t. A hook may mutate the
 * sim deterministically (kickoff reset after a goal): the snapshot of t is taken AFTER
 * onConfirmedTick(t). Bots that read the ball prediction must refresh it on the confirmed
 * timeline only (e.g. updateBallPrediction() inside botInputs on every confirmed tick, never on
 * the predicted ones: the predictor's age after a load would differ between peers otherwise).
 *
 * Timesync (noteRemoteTick / framesAhead / leadEstimate / canAdvance): every input packet carries
 * the sender's tick (myTick) and ackTick = the newest tick it has from me. framesAhead() is the
 * raw lead of the spec, tick - min(reported myTick): it includes the one-way latency L (the
 * report is L old), so a caller using it must subtract its rtt / 2 estimate. When noteRemoteTick
 * also gets ackTick, the engine derives a latency-free estimate: `ackTick - myTick - inputDelay`
 * (my newest input tick is my tick + inputDelay when I send) is deflated by L exactly as the raw
 * lead is inflated, so their mean is my true lead over that peer (+-1 tick from the 2-tick send
 * cadence); leadEstimate() is the min of the last AHEAD_SAMPLES such estimates per peer (against
 * jitter), max over peers. canAdvance() is false when the confirmed timeline cannot get within
 * `window` of the predicted one even with the inputs received so far ("stall": waiting for
 * inputs) or when leadEstimate() > aheadMax ("throttle": the session skips one tick; never
 * without ackTick samples); stats and blockReason tell which.
 *
 * Drops: from drop(slot, atTick) on the slot never blocks confirmation. Ticks >= atTick are
 * bot-driven; ticks < atTick use the slot's inputs. The room picks atTick = min over the peers of
 * contiguousInputTick(slot) + 1 (what each peer reports when the link dies), so no peer ever has
 * to guess an input below it; a peer that had already confirmed past atTick (it got the dead
 * peer's last packets, the others did not) rewinds to the snapshot of atTick - 1 (hooks.onRewind)
 * and re-confirms with the bot driving the slot from atTick, exactly like everyone else. Only
 * when that snapshot is gone does atTick move to confirmedTick + 1 (stats.lateDrops: the peers
 * may then disagree on a hash tick, which the vote + resync repair).
 *
 * Events: the confirmed and re-predicted steps sync the sim quietly (RollbackSim.syncQuiet when
 * the sim has it) so a rollback never re-fires the bridge's FX events for ticks it already
 * reported; only the final sync of advance() / resync() / drop() fires, for the newest tick.
 *
 * Allocation-free on the per-tick path: rings, scratch frames, snapshots, the hash table and the
 * confirmedHashes() output are preallocated. Allocations happen at construction, on a drop
 * transition (the bot / human slot lists are rebuilt once) and in error paths.
 */
import { MAX_CARS, MAX_STATE_BYTES, PACKED_INPUT_BYTES } from '../../sim/types';
import { fnv1a32 } from '../protocol';
import { P2P_HASH_EVERY, P2P_INPUT_DELAY_DEFAULT, P2P_INPUT_MAX_BATCH, P2P_WINDOW_DEFAULT } from './protocol';
import { INPUT_STORE_TICKS, InputStore } from './InputStore';

/** What the engine needs from the sim (structurally satisfied by RocketSimBridge.RocketSim). */
export interface RollbackSim {
  /** rs_save_state into `out` (>= stateSizeMax() bytes); returns the byte length. */
  saveState(out: Uint8Array): number;
  /** Restore a blob of exactly `len` bytes on the same roster (throws on error). Refreshes `buf`. */
  loadState(blob: Uint8Array, len?: number): void;
  /** FNV-1a 32 of the bytes saveState would produce now (== fnv1a32(blob, len)). */
  stateHash(): number;
  stateSizeMax(): number;
  setControlsPacked(packed: Int8Array, numSlots: number): void;
  step(n?: number): void;
  sync(): void;
  /** Like sync() but without firing the sim's events (RocketSimBridge.syncQuiet); sync() is used when absent. */
  syncQuiet?(): void;
  readonly tickCount: number;
}

export interface RollbackHooks {
  /**
   * Inputs of the bot slots (engine.botSlots) for confirmed tick `tick`: write 6 int8 per bot slot
   * at slot * 6 into `packedOut`, which already holds the known inputs of the human slots for this
   * tick (a hook may override them deterministically, e.g. zero while the confirmed Match is
   * frozen). The confirmed state at tick-1 is in the sim (`buf` synced). Called once per confirmed
   * tick, in order, only on the confirmed timeline. `packedOut` is the engine's scratch: do not keep it.
   */
  botInputs(tick: number, packedOut: Int8Array): void;
  /** The confirmed state at `tick` is in the sim (`buf` synced): Match.tick(TICK_DT), goals read from the state. Once per confirmed tick, in order. */
  onConfirmedTick(tick: number): void;
  /**
   * resync(tick, ...) loaded the majority's confirmed state at `tick`: the confirmed timeline
   * restarts there (onConfirmedTick runs again from tick+1, ticks the hooks may have seen before
   * when the resync goes backwards). Realign the confirmed-timeline objects (Match, BotTeam).
   */
  onResync?(tick: number): void;
  /**
   * drop(slot, atTick) found atTick already confirmed and reloaded the snapshot of `tick` =
   * atTick - 1 (the confirmed timeline restarts there; the hooks run again from tick + 1).
   * Restore the confirmed-timeline objects (Match, BotTeam) to their state at `tick`.
   */
  onRewind?(tick: number): void;
}

export interface RollbackOptions {
  /** Ticks between sampling a local input and the tick it applies to (P2P_INPUT_DELAY_DEFAULT). */
  inputDelay?: number;
  /** Max predicted ticks ahead of the confirmed tick before canAdvance() stalls (P2P_WINDOW_DEFAULT). */
  window?: number;
  /** Confirmed-tick snapshots kept for stateAt (P2P_HISTORY_TICKS_DEFAULT). */
  historyTicks?: number;
  /** Hash (and keep the blob of) every confirmed tick multiple of this (P2P_HASH_EVERY). */
  hashEvery?: number;
  /** Throttle when more than this many ticks ahead of the slowest peer (P2P_AHEAD_MAX_DEFAULT). */
  aheadMax?: number;
}

export interface RollbackStats {
  /** advance() / resync() calls that loaded a snapshot and re-simulated ticks already simulated. */
  rollbacks: number;
  /** Ticks simulated a second time (confirmed re-runs + re-predictions). */
  resimTicks: number;
  confirmedTicks: number;
  /** Received inputs that differed from what the predicted tick had applied. */
  mispredictions: number;
  /** canAdvance() false because the confirmed timeline is `window` behind (inputs missing). */
  stalls: number;
  /** canAdvance() false because leadEstimate() > aheadMax. */
  throttles: number;
  desyncs: number;
  resyncs: number;
  /** tick - confirmedTick after the last advance(). */
  predictedAhead: number;
  /** Local ticks advance() had to fill with hold-last because addLocalInput was not called. */
  localAutoFilled: number;
  /** Remote inputs ignored (unknown / local / dropped slot, too far in the future). */
  ignoredInputs: number;
  /** drop() calls whose atTick was already confirmed and whose snapshot of atTick - 1 was gone (moved to confirmedTick + 1). */
  lateDrops: number;
  /** drop() calls whose atTick was already confirmed and that rewound to the snapshot of atTick - 1. */
  rewinds: number;
  /** advance() calls refused because the predicted timeline hit the ring limit. */
  refused: number;
}

export type HashVerdict = 'agree' | 'disagree' | 'unknown';
export type BlockReason = 'none' | 'stall' | 'throttle';
export type DesyncHandler = (tick: number, mine: number, majority: number, agree: number, disagree: number) => void;
/** The vote of a hash tick was decided: `agreed` = my hash is the majority's. */
export type HashDecidedHandler = (tick: number, agreed: boolean) => void;
export interface ConfirmedHash {
  tick: number;
  hash: number;
}
/** Result of stateAt(): `blob` is a view into the engine's ring (valid until the next confirmed tick / resync; copy if kept). */
export interface StateAt {
  blob: Uint8Array;
  len: number;
  hash: number;
}

export const P2P_HISTORY_TICKS_DEFAULT = 64;
export const P2P_AHEAD_MAX_DEFAULT = 2;
/** Hash ticks remembered for the vote and for stateAt (16 x hashEvery ticks = 4 s at 30). */
export const HASH_RING = 16;
/** Hard limit of predicted ticks ahead of the confirmed tick (the rings are INPUT_STORE_TICKS deep). */
export const MAX_PREDICTED = 128;
const AHEAD_SAMPLES = 4;
const NONE = -1;
const BIG = 0x7fffffff;
/** Remote inputs further than this past the predicted tick are ignored. */
const FUTURE_CAP = 96;
const APPLIED_RING = INPUT_STORE_TICKS;
const APPLIED_MASK = APPLIED_RING - 1;

export class RollbackEngine {
  readonly sim: RollbackSim;
  readonly numSlots: number;
  readonly localSlot: number;
  readonly hooks: RollbackHooks;
  readonly inputDelay: number;
  readonly window: number;
  readonly historyTicks: number;
  readonly hashEvery: number;
  readonly aheadMax: number;
  readonly stats: RollbackStats = {
    rollbacks: 0,
    resimTicks: 0,
    confirmedTicks: 0,
    mispredictions: 0,
    stalls: 0,
    throttles: 0,
    desyncs: 0,
    resyncs: 0,
    predictedAhead: 0,
    localAutoFilled: 0,
    ignoredInputs: 0,
    lateDrops: 0,
    rewinds: 0,
    refused: 0,
  };
  /** Called once per hash tick whose majority hash differs from mine (see receiveHash). */
  onDesync: DesyncHandler | null = null;
  /** Called once per hash tick when its vote is decided, before onDesync (agreed = mine is the majority). */
  onHashDecided: HashDecidedHandler | null = null;

  private tickNow: number;
  private F: number;
  /** The tick the engine was built on (the sim's tick then): its state is given, no input is ever applied AT it. */
  private readonly baseTick: number;
  private dirty = false;
  private blocked: BlockReason = 'none';
  private readonly store: InputStore;
  /** Per slot: highest tick t such that every tick in (base, t] is known (base = the confirmed tick of the last resync / construction). */
  private readonly contig: Int32Array;
  /** Running packed frame (scratch): what the next step applies, 6 int8 per slot. */
  private readonly frame: Int8Array;
  /** The frame applied at F (seeds hold-last for the predicted pass). */
  private readonly confirmedFrame: Int8Array;
  /** What every simulated tick applied (APPLIED_RING x numSlots x 6), labelled by tick. */
  private readonly applied: Int8Array;
  private readonly appliedTick: Int32Array;
  private readonly isHuman: Uint8Array;
  /** Human and not dropped. */
  private readonly humanActive: Uint8Array;
  private readonly dropAt: Int32Array;
  /** Bot-driven as of the confirmed pass position (bots + dropped slots from their tick on). */
  private readonly botNow: Uint8Array;
  private botList: number[] = [];
  private humanList: number[] = [];
  private pendingDrops = 0;
  // confirmed-tick snapshots
  private readonly snapBlob: Uint8Array[] = [];
  private readonly snapTick: Int32Array;
  private readonly snapLen: Int32Array;
  private readonly snapHash: Uint32Array;
  private readonly snapHasHash: Uint8Array;
  // hash ticks: my hash, the blob, the votes
  private readonly hTick = new Int32Array(HASH_RING).fill(NONE);
  private readonly hMine = new Uint32Array(HASH_RING);
  private readonly hMineKnown = new Uint8Array(HASH_RING);
  private readonly hPending = new Uint8Array(HASH_RING);
  private readonly hDecided = new Uint8Array(HASH_RING);
  private readonly hVotes: Uint32Array;
  private readonly hVoted: Uint8Array;
  private readonly hBlob: Uint8Array[] = [];
  private readonly hLen = new Int32Array(HASH_RING);
  private readonly hashPool: ConfirmedHash[] = [];
  private readonly hashOut: ConfirmedHash[] = [];
  // timesync
  private readonly remoteTick: Int32Array;
  private readonly aheadSamples: Int32Array;
  private readonly aheadCount: Int32Array;
  private readonly aheadNext: Int32Array;
  private readonly stateAtOut: StateAt;

  constructor(sim: RollbackSim, numSlots: number, humanSlots: readonly number[], localSlot: number, hooks: RollbackHooks, opts: RollbackOptions = {}) {
    if (numSlots < 1 || numSlots > MAX_CARS) throw new Error(`RollbackEngine: numSlots ${numSlots} out of range`);
    if (localSlot < 0 || localSlot >= numSlots) throw new Error(`RollbackEngine: localSlot ${localSlot} out of range`);
    this.inputDelay = opts.inputDelay ?? P2P_INPUT_DELAY_DEFAULT;
    this.window = opts.window ?? P2P_WINDOW_DEFAULT;
    this.historyTicks = opts.historyTicks ?? P2P_HISTORY_TICKS_DEFAULT;
    this.hashEvery = opts.hashEvery ?? P2P_HASH_EVERY;
    this.aheadMax = opts.aheadMax ?? P2P_AHEAD_MAX_DEFAULT;
    if (this.inputDelay < 0 || this.inputDelay > 32) throw new Error(`RollbackEngine: inputDelay ${this.inputDelay}`);
    if (this.window < 1 || this.window > MAX_PREDICTED) throw new Error(`RollbackEngine: window ${this.window}`);
    if (this.historyTicks < 1 || this.historyTicks > 1024) throw new Error(`RollbackEngine: historyTicks ${this.historyTicks}`);
    if (this.hashEvery < 1) throw new Error(`RollbackEngine: hashEvery ${this.hashEvery}`);
    const stateMax = sim.stateSizeMax();
    if (stateMax <= 0 || stateMax > MAX_STATE_BYTES) throw new Error(`RollbackEngine: state blob size ${stateMax}`);

    this.sim = sim;
    this.numSlots = numSlots;
    this.localSlot = localSlot;
    this.hooks = hooks;
    const n = numSlots;
    this.isHuman = new Uint8Array(n);
    this.humanActive = new Uint8Array(n);
    this.dropAt = new Int32Array(n).fill(NONE);
    this.botNow = new Uint8Array(n);
    for (const s of humanSlots) {
      if (s < 0 || s >= n) throw new Error(`RollbackEngine: human slot ${s} out of range`);
      if (this.isHuman[s]) throw new Error(`RollbackEngine: human slot ${s} repeated`);
      this.isHuman[s] = 1;
      this.humanActive[s] = 1;
    }
    if (!this.isHuman[localSlot]) throw new Error(`RollbackEngine: localSlot ${localSlot} is not a human slot`);
    for (let s = 0; s < n; s++) this.botNow[s] = this.isHuman[s] ? 0 : 1;
    this.rebuildBotList();
    this.rebuildHumanList();

    this.store = new InputStore(n, INPUT_STORE_TICKS);
    this.contig = new Int32Array(n);
    this.frame = new Int8Array(n * PACKED_INPUT_BYTES);
    this.confirmedFrame = new Int8Array(n * PACKED_INPUT_BYTES);
    this.applied = new Int8Array(APPLIED_RING * n * PACKED_INPUT_BYTES);
    this.appliedTick = new Int32Array(APPLIED_RING).fill(NONE);
    // Blobs are MAX_STATE_BYTES so the bridge's saveState takes its whole-scratch copy path (no
    // subarray per call); `len` says how much is meaningful.
    for (let i = 0; i < this.historyTicks; i++) this.snapBlob.push(new Uint8Array(MAX_STATE_BYTES));
    this.snapTick = new Int32Array(this.historyTicks).fill(NONE);
    this.snapLen = new Int32Array(this.historyTicks);
    this.snapHash = new Uint32Array(this.historyTicks);
    this.snapHasHash = new Uint8Array(this.historyTicks);
    this.hVotes = new Uint32Array(HASH_RING * n);
    this.hVoted = new Uint8Array(HASH_RING * n);
    for (let e = 0; e < HASH_RING; e++) {
      this.hBlob.push(new Uint8Array(MAX_STATE_BYTES));
      this.hashPool.push({ tick: 0, hash: 0 });
    }
    this.remoteTick = new Int32Array(n).fill(NONE);
    this.aheadSamples = new Int32Array(n * AHEAD_SAMPLES);
    this.aheadCount = new Int32Array(n);
    this.aheadNext = new Int32Array(n);
    this.stateAtOut = { blob: this.snapBlob[0], len: 0, hash: 0 };

    // Tick 0 (or wherever the sim is) is the confirmed base; the local inputs of the first
    // inputDelay ticks are zero (every peer does the same and ships them in its first batch).
    const t0 = sim.tickCount;
    this.baseTick = t0;
    this.tickNow = t0;
    this.F = t0;
    this.contig.fill(t0);
    this.fillLocalThrough(t0 + this.inputDelay, true);
    this.saveSnapshot(t0);
  }

  // ---- state --------------------------------------------------------------------------------

  /** Current predicted tick (the state in the sim after advance(); what the views render). */
  get tick(): number {
    return this.tickNow;
  }

  /** F: last tick with every active human input known, simulated on the confirmed timeline. */
  get confirmedTick(): number {
    return this.F;
  }

  /** Why the last canAdvance() said no ('none' when it said yes). */
  get blockReason(): BlockReason {
    return this.blocked;
  }

  /** Bot-driven slots as of the confirmed pass (bots + dropped slots from their drop tick on), ascending. */
  get botSlots(): readonly number[] {
    return this.botList;
  }

  /** Human slots not dropped, ascending (drop() removes a slot at once). */
  get humanSlots(): readonly number[] {
    return this.humanList;
  }

  /** Newest local input tick registered (contiguous from the base: everything up to it is known). */
  get newestLocalTick(): number {
    return this.contig[this.localSlot];
  }

  isHumanSlot(slot: number): boolean {
    return slot >= 0 && slot < this.numSlots && this.isHuman[slot] === 1;
  }

  isDropped(slot: number): boolean {
    return slot >= 0 && slot < this.numSlots && this.dropAt[slot] !== NONE;
  }

  /** Tick from which a dropped slot is bot-driven, or -1. */
  dropTickOf(slot: number): number {
    return slot >= 0 && slot < this.numSlots ? this.dropAt[slot] : NONE;
  }

  /** Newest myTick reported by a remote human slot (-1 = none yet). */
  remoteTickOf(slot: number): number {
    return slot >= 0 && slot < this.numSlots ? this.remoteTick[slot] : NONE;
  }

  /** True when the input of (slot, tick) is known (received, local, or confirmed bot input). */
  inputKnown(slot: number, tick: number): boolean {
    return slot >= 0 && slot < this.numSlots && this.store.has(slot, tick);
  }

  /** Highest tick up to which every input of `slot` is known (what to report when it goes unreachable). */
  contiguousInputTick(slot: number): number {
    return slot >= 0 && slot < this.numSlots ? this.contig[slot] : NONE;
  }

  /** The active human slot whose missing input holds the confirmed timeline back (-1 when none). */
  waitingFor(): number {
    let worst = -1;
    let m = BIG;
    const n = this.numSlots;
    for (let s = 0; s < n; s++) {
      if (!this.isHuman[s] || s === this.localSlot || this.dropAt[s] !== NONE) continue;
      const c = this.contig[s];
      if (c < m) {
        m = c;
        worst = s;
      }
    }
    return m < this.tickNow ? worst : -1;
  }

  // ---- inputs ---------------------------------------------------------------------------------

  /**
   * Register the local input (6 int8 at packed[off..]) for the tick it applies to:
   * tick + 1 + inputDelay (the tick the next advance() produces, delayed by inputDelay). Call once
   * per tick BEFORE advance(); the first registration of a tick wins (it may have been sent
   * already). Returns that tick. Ticks a session never registers are filled with hold-last by
   * advance() (stats.localAutoFilled).
   */
  addLocalInput(packed: Int8Array, off: number = 0): number {
    const t = this.tickNow + 1 + this.inputDelay;
    if (!this.store.has(this.localSlot, t)) {
      this.store.set(this.localSlot, t, packed, off);
      this.advanceContig(this.localSlot);
    }
    return t;
  }

  /**
   * `count` consecutive ticks of a remote human slot (6 int8 each, oldest first, at packed[off..]).
   * Ticks already confirmed, already known, of a dropped slot from its drop tick on, or further
   * than FUTURE_CAP ahead are ignored. A tick already predicted with a different input marks a
   * rollback (dirty); the confirmed timeline moves on the next advance() when it can.
   */
  addRemoteInput(slot: number, firstTick: number, count: number, packed: Int8Array, off: number = 0): void {
    if (slot < 0 || slot >= this.numSlots || slot === this.localSlot || !this.isHuman[slot] || count <= 0) {
      this.stats.ignoredInputs += count > 0 ? count : 0;
      return;
    }
    const store = this.store;
    const dropAt = this.dropAt[slot];
    const futureCap = this.tickNow + FUTURE_CAP;
    for (let i = 0; i < count; i++) {
      const t = firstTick + i;
      if (t <= this.F) continue;
      if (dropAt !== NONE && t >= dropAt) continue;
      if (t > futureCap) {
        this.stats.ignoredInputs++;
        continue;
      }
      if (store.has(slot, t)) continue;
      const o = off + i * PACKED_INPUT_BYTES;
      store.set(slot, t, packed, o);
      if (t <= this.tickNow && !this.appliedEquals(slot, t, packed, o)) {
        this.dirty = true;
        this.stats.mispredictions++;
      }
    }
    this.advanceContig(slot);
  }

  /**
   * The input a predicted tick applied (or would apply) for `slot`: the known input when there is
   * one, else hold-last. Copies 6 int8 to out[off..]; returns true when it came from a known input.
   */
  predictedInputFor(slot: number, tick: number, out: Int8Array, off: number = 0): boolean {
    if (slot < 0 || slot >= this.numSlots) return false;
    if (this.store.copyTo(slot, tick, out, off)) return true;
    const r = tick & APPLIED_MASK;
    const base = slot * PACKED_INPUT_BYTES;
    if (tick <= this.tickNow && this.appliedTick[r] === tick) {
      const src = r * this.numSlots * PACKED_INPUT_BYTES + base;
      for (let i = 0; i < PACKED_INPUT_BYTES; i++) out[off + i] = this.applied[src + i];
      return false;
    }
    for (let i = 0; i < PACKED_INPUT_BYTES; i++) out[off + i] = this.frame[base + i];
    return false;
  }

  /**
   * Local input batch for a peer (the sender's helper): the newest `cap` ticks after `ackTick`
   * (what that peer already has), at least the newest one, oldest first into `out`; returns the
   * count (firstTick = newestLocalTick - count + 1). A backlog longer than `cap` needs several
   * packets: use copyLocalInputs for the older chunks.
   */
  assembleLocalInputs(ackTick: number, out: Int8Array, cap: number = P2P_INPUT_MAX_BATCH): number {
    const newest = this.contig[this.localSlot];
    if (newest < 1) return 0;
    let first = ackTick + 1;
    if (first < 1) first = 1;
    if (first < newest - cap + 1) first = newest - cap + 1;
    if (first < newest - INPUT_STORE_TICKS + 1) first = newest - INPUT_STORE_TICKS + 1;
    if (first > newest) first = newest;
    for (let t = newest; t >= first; t--) if (!this.store.has(this.localSlot, t)) first = t + 1;
    const count = newest - first + 1;
    for (let i = 0; i < count; i++) this.store.copyTo(this.localSlot, first + i, out, i * PACKED_INPUT_BYTES);
    return count;
  }

  /** Copy `count` local inputs from `firstTick` into out[0..]; false when any is unknown. */
  copyLocalInputs(firstTick: number, count: number, out: Int8Array): boolean {
    for (let i = 0; i < count; i++) if (!this.store.copyTo(this.localSlot, firstTick + i, out, i * PACKED_INPUT_BYTES)) return false;
    return true;
  }

  // ---- timing ---------------------------------------------------------------------------------

  /**
   * False when the predicted timeline must wait: stall (even after confirming every input received
   * so far the confirmed tick would stay `window` behind) or throttle (leadEstimate() > aheadMax).
   * The stall test looks at the inputs, not at confirmedTick, which only moves inside advance().
   */
  canAdvance(): boolean {
    let Fp = this.confirmable();
    if (Fp > this.tickNow) Fp = this.tickNow;
    if (this.tickNow - Fp >= this.window) {
      this.stats.stalls++;
      this.blocked = 'stall';
      return false;
    }
    if (this.leadEstimate() > this.aheadMax) {
      this.stats.throttles++;
      this.blocked = 'throttle';
      return false;
    }
    this.blocked = 'none';
    return true;
  }

  /**
   * A remote peer's input packet said it was at `myTick` (feeds framesAhead()) and, when given,
   * that `ackTick` is the newest tick it has from me (feeds the latency-free leadEstimate() that
   * canAdvance() throttles on). See the header.
   */
  noteRemoteTick(slot: number, myTick: number, ackTick: number = NONE): void {
    if (slot < 0 || slot >= this.numSlots || slot === this.localSlot || !this.isHuman[slot]) return;
    if (myTick > this.remoteTick[slot]) this.remoteTick[slot] = myTick;
    if (ackTick < 0) return;
    const sample = Math.floor((this.tickNow - myTick + (ackTick - myTick - this.inputDelay)) / 2);
    const i = slot * AHEAD_SAMPLES + this.aheadNext[slot];
    this.aheadSamples[i] = sample;
    this.aheadNext[slot] = (this.aheadNext[slot] + 1) % AHEAD_SAMPLES;
    if (this.aheadCount[slot] < AHEAD_SAMPLES) this.aheadCount[slot]++;
  }

  /** tick - min(myTick reported by the active remote peers): the raw lead, one-way latency included; 0 without reports. */
  framesAhead(): number {
    let worst = -BIG;
    let any = false;
    const n = this.numSlots;
    for (let s = 0; s < n; s++) {
      if (s === this.localSlot || !this.humanActive[s] || this.remoteTick[s] < 0) continue;
      const lead = this.tickNow - this.remoteTick[s];
      if (lead > worst) worst = lead;
      any = true;
    }
    return any ? worst : 0;
  }

  /** Latency-free estimate of how many ticks I am ahead of the slowest active remote peer (needs ackTick samples); 0 without them. */
  leadEstimate(): number {
    let worst = -BIG;
    let any = false;
    const n = this.numSlots;
    for (let s = 0; s < n; s++) {
      if (s === this.localSlot || !this.humanActive[s] || this.aheadCount[s] === 0) continue;
      let m = BIG;
      const base = s * AHEAD_SAMPLES;
      for (let k = 0; k < this.aheadCount[s]; k++) if (this.aheadSamples[base + k] < m) m = this.aheadSamples[base + k];
      if (m > worst) worst = m;
      any = true;
    }
    return any ? worst : 0;
  }

  // ---- simulation -----------------------------------------------------------------------------

  /**
   * Produce tick + 1 (see the header). The sim ends at tick + 1 with `buf` synced. Refused (no
   * change, stats.refused) when MAX_PREDICTED ticks are already predicted ahead of the confirmed tick.
   */
  advance(): void {
    if (this.tickNow - this.F >= MAX_PREDICTED) {
      this.stats.refused++;
      return;
    }
    const newTick = this.tickNow + 1;
    this.fillLocalThrough(newTick + this.inputDelay, false);
    let Fp = this.confirmable();
    if (Fp > newTick) Fp = newTick;
    if (this.dirty || Fp > this.F) {
      const redo = this.tickNow - this.F;
      if (redo > 0) this.loadSnapshot(this.F);
      this.frame.set(this.confirmedFrame);
      this.resimulate(Fp, newTick);
      if (redo > 0) {
        this.stats.rollbacks++;
        this.stats.resimTicks += redo;
      }
    } else {
      this.predictStep(newTick);
    }
    this.tickNow = newTick;
    this.stats.predictedAhead = newTick - this.F;
    this.sim.sync();
  }

  /**
   * Confirm F+1..Fp then predict Fp+1..target, from a sim holding the confirmed state F with
   * `frame` = confirmedFrame. Every step but the last syncs quietly (the caller's final sync()
   * fires the events of the newest tick only).
   */
  private resimulate(Fp: number, target: number): void {
    for (let t = this.F + 1; t <= Fp; t++) this.confirmStep(t);
    for (let t = Fp + 1; t <= target; t++) {
      this.predictStep(t);
      if (t < target) this.syncQuiet();
    }
    this.dirty = false;
  }

  /** Refresh the sim's state buffer without firing its events (see the header). */
  private syncQuiet(): void {
    const sim = this.sim;
    if (sim.syncQuiet !== undefined) sim.syncQuiet();
    else sim.sync();
  }

  private confirmStep(t: number): void {
    const n = this.numSlots;
    const frame = this.frame;
    const store = this.store;
    if (this.pendingDrops > 0) this.applyDropsAt(t);
    for (let s = 0; s < n; s++) {
      if (this.botNow[s]) continue;
      const base = s * PACKED_INPUT_BYTES;
      if (store.copyTo(s, t, frame, base)) continue;
      if (this.dropAt[s] === NONE) throw new Error(`RollbackEngine: confirming tick ${t} without the input of slot ${s}`);
      store.set(s, t, frame, base); // dropped before its tick: hold-last, recorded as the input of t
    }
    this.hooks.botInputs(t, frame);
    for (let s = 0; s < n; s++) if (this.botNow[s]) store.set(s, t, frame, s * PACKED_INPUT_BYTES);
    this.sim.setControlsPacked(frame, n);
    this.sim.step(1);
    this.syncQuiet();
    this.recordApplied(t);
    this.F = t;
    this.stats.confirmedTicks++;
    this.hooks.onConfirmedTick(t);
    this.saveSnapshot(t);
    if (t % this.hashEvery === 0) this.recordMyHash(t);
    this.confirmedFrame.set(frame);
  }

  private predictStep(t: number): void {
    const n = this.numSlots;
    const frame = this.frame;
    const store = this.store;
    for (let s = 0; s < n; s++) {
      if (this.botNow[s]) continue;
      if (this.dropAt[s] !== NONE && t >= this.dropAt[s]) continue;
      store.copyTo(s, t, frame, s * PACKED_INPUT_BYTES); // hold-last when unknown
    }
    this.sim.setControlsPacked(frame, n);
    this.sim.step(1);
    this.recordApplied(t);
  }

  /** Highest tick every active human slot has inputs for (dropped slots never constrain). */
  private confirmable(): number {
    let m = BIG;
    const n = this.numSlots;
    for (let s = 0; s < n; s++) {
      if (!this.humanActive[s]) continue;
      const c = this.contig[s];
      if (c < m) m = c;
    }
    return m;
  }

  private advanceContig(slot: number): void {
    let c = this.contig[slot];
    while (this.store.has(slot, c + 1)) c++;
    this.contig[slot] = c;
  }

  /** Make the local inputs known through `upTo` (zeros at construction, hold-last afterwards). */
  private fillLocalThrough(upTo: number, zeros: boolean): void {
    const slot = this.localSlot;
    const store = this.store;
    const base = slot * PACKED_INPUT_BYTES;
    const frame = this.frame;
    let c = this.contig[slot];
    while (c < upTo) {
      c++;
      if (store.has(slot, c)) continue;
      if (zeros || !store.copyTo(slot, c - 1, frame, base)) frame.fill(0, base, base + PACKED_INPUT_BYTES);
      store.set(slot, c, frame, base);
      if (!zeros) this.stats.localAutoFilled++;
    }
    this.advanceContig(slot);
  }

  private recordApplied(t: number): void {
    const r = t & APPLIED_MASK;
    this.applied.set(this.frame, r * this.numSlots * PACKED_INPUT_BYTES);
    this.appliedTick[r] = t;
  }

  private appliedEquals(slot: number, t: number, src: Int8Array, off: number): boolean {
    const r = t & APPLIED_MASK;
    if (this.appliedTick[r] !== t) return false;
    const base = r * this.numSlots * PACKED_INPUT_BYTES + slot * PACKED_INPUT_BYTES;
    const a = this.applied;
    for (let i = 0; i < PACKED_INPUT_BYTES; i++) if (a[base + i] !== src[off + i]) return false;
    return true;
  }

  private applyDropsAt(t: number): void {
    let changed = false;
    const n = this.numSlots;
    for (let s = 0; s < n; s++) {
      if (this.isHuman[s] && this.dropAt[s] !== NONE && this.dropAt[s] <= t && !this.botNow[s]) {
        this.botNow[s] = 1;
        this.pendingDrops--;
        changed = true;
      }
    }
    if (changed) this.rebuildBotList();
  }

  private rebuildBotList(): void {
    const list: number[] = [];
    for (let s = 0; s < this.numSlots; s++) if (this.botNow[s]) list.push(s);
    this.botList = list;
  }

  private rebuildHumanList(): void {
    const list: number[] = [];
    for (let s = 0; s < this.numSlots; s++) if (this.humanActive[s]) list.push(s);
    this.humanList = list;
  }

  // ---- snapshots ------------------------------------------------------------------------------

  private saveSnapshot(t: number): void {
    const i = t % this.historyTicks;
    const len = this.sim.saveState(this.snapBlob[i]);
    if (len <= 0 || len > MAX_STATE_BYTES) throw new Error(`RollbackEngine: saveState returned ${len}`);
    this.snapLen[i] = len;
    this.snapTick[i] = t;
    this.snapHasHash[i] = 0;
  }

  private loadSnapshot(t: number): void {
    const i = t % this.historyTicks;
    if (this.snapTick[i] !== t) throw new Error(`RollbackEngine: no snapshot of confirmed tick ${t}`);
    this.sim.loadState(this.snapBlob[i], this.snapLen[i]);
  }

  /** My hash at a hash tick still in the ring, or -1. */
  hashAt(tick: number): number {
    if (tick <= 0 || tick % this.hashEvery !== 0) return NONE;
    const e = this.hashIndex(tick);
    return this.hTick[e] === tick && this.hMineKnown[e] ? this.hMine[e] : NONE;
  }

  /**
   * The confirmed state at `tick`: any of the last historyTicks confirmed ticks, or a hash tick
   * still in the hash ring. The result object and its blob are reused (copy if kept).
   */
  stateAt(tick: number): StateAt | null {
    const out = this.stateAtOut;
    const i = tick % this.historyTicks;
    if (tick >= 0 && this.snapTick[i] === tick) {
      if (!this.snapHasHash[i]) {
        this.snapHash[i] = fnv1a32(this.snapBlob[i], this.snapLen[i]);
        this.snapHasHash[i] = 1;
      }
      out.blob = this.snapBlob[i];
      out.len = this.snapLen[i];
      out.hash = this.snapHash[i];
      return out;
    }
    if (tick > 0 && tick % this.hashEvery === 0) {
      const e = this.hashIndex(tick);
      if (this.hTick[e] === tick && this.hMineKnown[e]) {
        out.blob = this.hBlob[e];
        out.len = this.hLen[e];
        out.hash = this.hMine[e];
        return out;
      }
    }
    return null;
  }

  /**
   * Load the majority's confirmed state at `tick` (a StateResponse): the confirmed timeline
   * restarts there (snapshots reset, hashes of later ticks forgotten, hooks.onResync), then the
   * confirmed / predicted passes re-run to the previous predicted tick (or the engine jumps to
   * `tick` when that lies ahead). Throws when the sim rejects the blob (nothing changes then).
   */
  resync(tick: number, blob: Uint8Array, len: number = blob.length): void {
    if (len <= 0 || len > MAX_STATE_BYTES || len > blob.length) throw new Error(`RollbackEngine.resync: bad length ${len}`);
    const prev = this.tickNow;
    const n = this.numSlots;
    this.sim.loadState(blob, len);
    if (this.sim.tickCount !== tick) {
      // Not the state of `tick`: put our own timeline back (snapshot F + re-prediction) and refuse.
      const got = this.sim.tickCount;
      this.loadSnapshot(this.F);
      this.frame.set(this.confirmedFrame);
      this.resimulate(this.F, prev);
      this.sim.sync();
      throw new Error(`RollbackEngine.resync: the blob holds tick ${got}, not ${tick}`);
    }
    this.snapTick.fill(NONE);
    const i = tick % this.historyTicks;
    const dst = this.snapBlob[i];
    for (let k = 0; k < len; k++) dst[k] = blob[k];
    this.snapLen[i] = len;
    this.snapTick[i] = tick;
    this.snapHash[i] = fnv1a32(blob, len);
    this.snapHasHash[i] = 1;
    this.restartAt(tick);
    for (let s = 0; s < n; s++) {
      this.contig[s] = tick;
      this.advanceContig(s);
    }
    this.fillLocalThrough(tick + this.inputDelay, false);
    this.stats.resyncs++;
    this.hooks.onResync?.(tick);
    this.resumeTo(prev, tick);
  }

  /**
   * From `atTick` on `slot` is bot-driven (hooks.botInputs covers it through botSlots); before
   * that its known inputs are used, so the slot never blocks confirmation again. Every peer must
   * call this with the same atTick (the room announces the min over the peers of their
   * contiguousInputTick(slot) + 1). An atTick already confirmed rewinds the confirmed timeline to
   * the snapshot of atTick - 1 (hooks.onRewind, stats.rewinds) and re-runs it with the bot in
   * charge from atTick; when that snapshot is gone it moves to confirmedTick + 1 (stats.lateDrops).
   * An atTick at or before the base tick (the room's drop { slot, 0 } of a peer that never joined)
   * is the first simulated tick: nothing of that slot was ever applied, so it is neither late nor a
   * rewind (and every peer gets the same tick: none can confirm a tick without that slot).
   */
  drop(slot: number, atTick: number): void {
    if (slot < 0 || slot >= this.numSlots || !this.isHuman[slot] || this.dropAt[slot] !== NONE) return;
    let at = atTick <= this.baseTick ? this.baseTick + 1 : atTick;
    let rewound = -1;
    let prev = this.tickNow;
    if (at <= this.F) {
      const back = at - 1;
      if (back >= 0 && this.snapTick[back % this.historyTicks] === back) {
        prev = this.tickNow;
        this.loadSnapshot(back);
        for (let i = 0; i < this.historyTicks; i++) if (this.snapTick[i] > back) this.snapTick[i] = NONE;
        this.restartAt(back);
        this.stats.rewinds++;
        rewound = back;
      } else {
        at = this.F + 1;
        this.stats.lateDrops++;
      }
    }
    this.dropAt[slot] = at;
    this.humanActive[slot] = 0;
    this.pendingDrops++;
    this.rebuildHumanList();
    if (this.tickNow >= at) this.dirty = true;
    for (let e = 0; e < HASH_RING; e++) if (this.hTick[e] !== NONE) this.evaluate(e);
    if (rewound >= 0) {
      this.hooks.onRewind?.(rewound);
      this.resumeTo(prev, rewound);
    }
  }

  /**
   * The confirmed timeline restarts at `tick` (the sim holds that state): F and the predicted tick
   * move there, the hash entries of later ticks are forgotten (my vote withdrawn), the bot-driven
   * set and the pending drops are recomputed from the drop ticks, and the frame applied at `tick`
   * (from the applied ring) seeds the hold-last of the re-run.
   */
  private restartAt(tick: number): void {
    const n = this.numSlots;
    this.F = tick;
    this.tickNow = tick;
    for (let e = 0; e < HASH_RING; e++) {
      if (this.hTick[e] > tick) {
        this.hMineKnown[e] = 0;
        this.hPending[e] = 0;
        this.hDecided[e] = 0;
        this.hVoted[e * n + this.localSlot] = 0;
      }
    }
    this.pendingDrops = 0;
    for (let s = 0; s < n; s++) {
      if (!this.isHuman[s]) continue;
      if (this.dropAt[s] !== NONE && this.dropAt[s] <= tick) this.botNow[s] = 1;
      else {
        this.botNow[s] = 0;
        if (this.dropAt[s] !== NONE) this.pendingDrops++;
      }
    }
    this.rebuildBotList();
    const r = tick & APPLIED_MASK;
    if (this.appliedTick[r] === tick) {
      const src = r * n * PACKED_INPUT_BYTES;
      for (let k = 0; k < n * PACKED_INPUT_BYTES; k++) this.confirmedFrame[k] = this.applied[src + k];
    } else {
      this.confirmedFrame.fill(0);
    }
    this.dirty = false;
  }

  /** After restartAt(from): re-run the confirmed / predicted passes up to `prev` (the old predicted tick) and sync. */
  private resumeTo(prev: number, from: number): void {
    if (prev > from) {
      let Fp = this.confirmable();
      if (Fp > prev) Fp = prev;
      this.frame.set(this.confirmedFrame);
      this.resimulate(Fp, prev);
      this.tickNow = prev;
      this.stats.rollbacks++;
      this.stats.resimTicks += prev - from;
    }
    this.stats.predictedAhead = this.tickNow - this.F;
    this.sim.sync();
  }

  // ---- hashes ---------------------------------------------------------------------------------

  private hashIndex(tick: number): number {
    return ((tick / this.hashEvery) | 0) % HASH_RING;
  }

  private resetHashEntry(e: number, tick: number): void {
    this.hTick[e] = tick;
    this.hMineKnown[e] = 0;
    this.hPending[e] = 0;
    this.hDecided[e] = 0;
    this.hVoted.fill(0, e * this.numSlots, (e + 1) * this.numSlots);
  }

  private recordMyHash(t: number): void {
    const e = this.hashIndex(t);
    if (this.hTick[e] !== t) this.resetHashEntry(e, t);
    const i = t % this.historyTicks;
    const len = this.snapLen[i];
    const hash = fnv1a32(this.snapBlob[i], len);
    this.snapHash[i] = hash;
    this.snapHasHash[i] = 1;
    this.hBlob[e].set(this.snapBlob[i]);
    this.hLen[e] = len;
    this.hMine[e] = hash;
    this.hMineKnown[e] = 1;
    this.hPending[e] = 1;
    const v = e * this.numSlots + this.localSlot;
    this.hVotes[v] = hash;
    this.hVoted[v] = 1;
    this.evaluate(e);
  }

  /**
   * Hashes of the confirmed ticks multiple of hashEvery recorded since the last call, ascending,
   * for the 'ctl' channel. The array and its objects are reused: consume before the next call.
   */
  confirmedHashes(): readonly ConfirmedHash[] {
    const out = this.hashOut;
    out.length = 0;
    for (let e = 0; e < HASH_RING; e++) {
      if (!this.hPending[e]) continue;
      this.hPending[e] = 0;
      const o = this.hashPool[e];
      o.tick = this.hTick[e];
      o.hash = this.hMine[e];
      out.push(o);
    }
    for (let i = 1; i < out.length; i++) {
      const o = out[i];
      let j = i - 1;
      while (j >= 0 && out[j].tick > o.tick) {
        out[j + 1] = out[j];
        j--;
      }
      out[j + 1] = o;
    }
    return out;
  }

  /**
   * A remote human slot's hash of confirmed tick `tick`. Returns the verdict against MY hash of
   * that tick ('unknown' until I confirm it, or for ticks that are not hash ticks / too old). The
   * majority vote (every active human slot + me; decided by a strict majority or once everyone
   * voted; ties go to the lowest slot's value) fires onDesync(tick, mine, majority, agree,
   * disagree) once per tick when mine differs from the majority, and counts stats.desyncs.
   */
  receiveHash(slot: number, tick: number, hash: number): HashVerdict {
    if (slot < 0 || slot >= this.numSlots || slot === this.localSlot || !this.isHuman[slot]) return 'unknown';
    if (tick <= 0 || tick % this.hashEvery !== 0) return 'unknown';
    // The ring wraps every HASH_RING hash ticks: a far-future (or stale) tick must never reset
    // the live entry of my current hash tick (and the honest votes in it).
    if (tick > this.tickNow + FUTURE_CAP || tick <= this.F - HASH_RING * this.hashEvery) return 'unknown';
    const e = this.hashIndex(tick);
    if (this.hTick[e] !== tick) {
      if (this.hTick[e] > tick) return 'unknown';
      this.resetHashEntry(e, tick);
    }
    const h = hash >>> 0;
    const v = e * this.numSlots + slot;
    this.hVotes[v] = h;
    this.hVoted[v] = 1;
    this.evaluate(e);
    if (!this.hMineKnown[e]) return 'unknown';
    return h === this.hMine[e] ? 'agree' : 'disagree';
  }

  /** The hash `slot` (me included) voted for `tick`, or -1 when it has not voted / the tick left the ring. */
  voteOf(slot: number, tick: number): number {
    if (slot < 0 || slot >= this.numSlots || tick <= 0 || tick % this.hashEvery !== 0) return NONE;
    const e = this.hashIndex(tick);
    if (this.hTick[e] !== tick) return NONE;
    const v = e * this.numSlots + slot;
    return this.hVoted[v] ? this.hVotes[v] : NONE;
  }

  private evaluate(e: number): void {
    if (!this.hMineKnown[e] || this.hDecided[e]) return;
    const n = this.numSlots;
    const base = e * n;
    const votes = this.hVotes;
    const voted = this.hVoted;
    let need = 0;
    let got = 0;
    for (let s = 0; s < n; s++) {
      if (!this.humanActive[s] && s !== this.localSlot) continue;
      need++;
      if (voted[base + s]) got++;
    }
    let bestSlot = -1;
    let bestCount = 0;
    for (let s = 0; s < n; s++) {
      if (!voted[base + s] || (!this.humanActive[s] && s !== this.localSlot)) continue;
      let c = 0;
      for (let v = 0; v < n; v++) if (voted[base + v] && (this.humanActive[v] || v === this.localSlot) && votes[base + v] === votes[base + s]) c++;
      if (c > bestCount) {
        bestCount = c;
        bestSlot = s;
      }
    }
    if (bestSlot < 0) return;
    if (!(bestCount * 2 > need || got >= need)) return;
    this.hDecided[e] = 1;
    const majority = votes[base + bestSlot];
    const mine = this.hMine[e];
    this.onHashDecided?.(this.hTick[e], majority === mine);
    if (majority === mine) return;
    let agree = 0;
    let disagree = 0;
    for (let s = 0; s < n; s++) {
      if (s === this.localSlot || !voted[base + s] || !this.humanActive[s]) continue;
      if (votes[base + s] === mine) agree++;
      else disagree++;
    }
    this.stats.desyncs++;
    this.onDesync?.(this.hTick[e], mine, majority, agree, disagree);
  }
}
