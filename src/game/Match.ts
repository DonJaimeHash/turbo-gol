/**
 * Match rules state machine. Pure TypeScript, no DOM, no three.js; runnable in node.
 *
 * Phases
 *   menu              nothing runs
 *   kickoff           cars frozen, countdown; then 'playing'
 *   playing           the clock runs (regulation) or counts up (overtime)
 *   goal              goal celebration pause; then 'kickoff', 'overtime-kickoff' or 'ended'
 *   overtime-kickoff  like kickoff, after a tie at 0:00
 *   ended             a winner exists
 *
 * Rule: regulation ends the moment the clock reaches 0:00 when the score is not tied (no waiting
 * for the ball to touch the ground). A tie at 0:00 goes to unlimited
 * overtime, next goal wins.
 *
 * `tick(dt)` returns the events produced since the previous tick (including those queued by
 * `start()` / `onGoal()` in between). The returned array is REUSED: consume it before the next
 * call. No allocations happen in ticks that produce no events.
 */
import type { Team } from '../sim/types';

export type Phase = 'menu' | 'kickoff' | 'playing' | 'goal' | 'overtime-kickoff' | 'ended';

export interface MatchConfig {
  /** Regulation length in seconds. 0 = unlimited (no overtime, never ends by clock). */
  lengthSeconds: number;
  /** Pause after a goal before the next kickoff (or the end of the match). */
  goalPauseSeconds: number;
  /** Kickoff countdown length; the countdown events are n = ceil(seconds) .. 1 then 'go'. */
  kickoffCountdownSeconds: number;
}

/**
 * Regulation length of every match unless a custom lobby picks another (offline, casual, ranked,
 * P2P and server matches). The server's MATCH_LENGTH_SECONDS var defaults to the same value.
 */
export const DEFAULT_MATCH_SECONDS = 180;

/** "3:00", "+0:12" (overtime): whole seconds as the HUD clock shows them. Allocates a string. */
export function formatClockSeconds(total: number, overtime = false): string {
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${overtime ? '+' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
}

export const DEFAULT_MATCH_CONFIG: Readonly<MatchConfig> = {
  lengthSeconds: DEFAULT_MATCH_SECONDS,
  goalPauseSeconds: 3,
  kickoffCountdownSeconds: 3,
};

export type MatchEvent =
  /** Countdown number to display ("3", "2", "1"). */
  | { readonly type: 'countdown'; readonly n: number }
  /** Countdown over: cars unfrozen, play starts. */
  | { readonly type: 'go' }
  /** The sim must reset ball and cars to kickoff positions. */
  | { readonly type: 'kickoffReset' }
  /** Cars frozen (true during the countdown) / released. */
  | { readonly type: 'freeze'; readonly frozen: boolean }
  /** A goal was scored by `team`; the score is already updated. */
  | { readonly type: 'goal'; readonly team: Team; readonly blue: number; readonly red: number }
  /** Regulation ended tied; overtime starts (followed by kickoffReset/freeze/countdown events). */
  | { readonly type: 'overtime' }
  /** The match is over. */
  | { readonly type: 'ended'; readonly winner: Team };

export type MatchEventType = MatchEvent['type'];

const EPS = 1e-6;

const PHASES: readonly Phase[] = ['menu', 'kickoff', 'playing', 'goal', 'overtime-kickoff', 'ended'];

// Parameterless events are singletons so a match never allocates for them.
const EV_GO: MatchEvent = { type: 'go' };
const EV_KICKOFF_RESET: MatchEvent = { type: 'kickoffReset' };
const EV_FREEZE: MatchEvent = { type: 'freeze', frozen: true };
const EV_UNFREEZE: MatchEvent = { type: 'freeze', frozen: false };
const EV_OVERTIME: MatchEvent = { type: 'overtime' };

export class Match {
  phase: Phase = 'menu';
  readonly score: { blue: number; red: number } = { blue: 0, red: 0 };
  /** Seconds remaining in regulation (0 in overtime and in unlimited matches). */
  clock: number;
  overtime = false;
  /** Seconds elapsed in overtime. */
  overtimeClock = 0;
  /** Total seconds spent in the 'playing' phase (regulation + overtime). */
  elapsed = 0;
  /** While true, tick() advances nothing (events queued by start/onGoal are still delivered). */
  paused = false;
  readonly config: Readonly<MatchConfig>;

  private countdownRemaining = 0;
  private nextCountdown = 0;
  private shownCountdown = 0;
  private goalTimer = 0;
  private lastScorer: Team | null = null;
  private winnerTeam: Team | null = null;
  private readonly out: MatchEvent[] = [];
  private readonly queued: MatchEvent[] = [];
  private readonly countdownEvents: MatchEvent[] = [];

  constructor(cfg?: Partial<MatchConfig>) {
    this.config = {
      lengthSeconds: cfg?.lengthSeconds ?? DEFAULT_MATCH_CONFIG.lengthSeconds,
      goalPauseSeconds: cfg?.goalPauseSeconds ?? DEFAULT_MATCH_CONFIG.goalPauseSeconds,
      kickoffCountdownSeconds: cfg?.kickoffCountdownSeconds ?? DEFAULT_MATCH_CONFIG.kickoffCountdownSeconds,
    };
    this.clock = this.config.lengthSeconds;
  }

  // ---- HUD getters ------------------------------------------------------------------------

  /** Winner once `phase === 'ended'`, else null. */
  get winner(): Team | null {
    return this.winnerTeam;
  }

  /** True while cars must not move (kickoff countdown). */
  get frozen(): boolean {
    return this.phase === 'kickoff' || this.phase === 'overtime-kickoff';
  }

  /** Countdown number currently on screen (3, 2, 1), 0 when no countdown is running. */
  get countdownNumber(): number {
    return this.frozen ? this.shownCountdown : 0;
  }

  /** Seconds left in the current countdown (0 when none). */
  get countdownRemainingSeconds(): number {
    return this.frozen ? Math.max(0, this.countdownRemaining) : 0;
  }

  get isUnlimited(): boolean {
    return this.config.lengthSeconds <= 0;
  }

  /** True while a goal celebration pause is running. */
  get inGoalPause(): boolean {
    return this.phase === 'goal';
  }

  /** The team that scored last, or null. */
  get lastGoalTeam(): Team | null {
    return this.lastScorer;
  }

  /** Lead team, or null when tied. */
  get leader(): Team | null {
    if (this.score.blue === this.score.red) return null;
    return this.score.blue > this.score.red ? 0 : 1;
  }

  /**
   * Whole seconds for the HUD clock: ceil of the remaining time in regulation ("3:00"
   * until a full second has elapsed), floor of the elapsed time in overtime / unlimited matches.
   * Compare against the previous value and only reformat the string when it changes.
   */
  get displaySeconds(): number {
    if (this.overtime) return Math.floor(this.overtimeClock + EPS);
    if (this.isUnlimited) return Math.floor(this.elapsed + EPS);
    return Math.max(0, Math.ceil(this.clock - EPS));
  }

  /** "4:59", "+0:12" in overtime, "12:34" counting up in unlimited matches. Allocates a string. */
  formatClock(): string {
    return formatClockSeconds(this.displaySeconds, this.overtime);
  }

  // ---- Control --------------------------------------------------------------------------

  /** Start a fresh match: score 0-0, full clock, kickoff countdown. */
  start(): void {
    this.resetState();
    this.beginKickoff('kickoff');
  }

  /** Back to the menu with everything cleared. */
  reset(): void {
    this.resetState();
    this.phase = 'menu';
  }

  /**
   * Register a goal for `team` (the team that scored). Returns true when the goal counted; false
   * (and nothing changes) unless the match is in 'playing', e.g. the ball bouncing back out of the
   * net and in again during the goal pause, or a goal after the final whistle.
   * Call this BEFORE tick() in a frame so a goal on the final tick still counts.
   */
  onGoal(team: Team): boolean {
    if (this.phase !== 'playing') return false;
    if (team === 0) this.score.blue++;
    else this.score.red++;
    this.lastScorer = team;
    this.phase = 'goal';
    this.goalTimer = this.config.goalPauseSeconds;
    this.emit({ type: 'goal', team, blue: this.score.blue, red: this.score.red });
    return true;
  }

  /** Floats saveState writes. */
  static readonly STATE_FLOATS = 14;

  /**
   * Write the whole match state (phase, score, clocks, countdown, goal pause, scorer, winner) as
   * STATE_FLOATS numbers at out[off..] and return the next offset. Meant between ticks (after
   * tick() the event queue is empty; events still queued are not saved). Allocation-free.
   */
  saveState(out: Float64Array, off: number = 0): number {
    let o = off;
    out[o++] = PHASES.indexOf(this.phase);
    out[o++] = this.score.blue;
    out[o++] = this.score.red;
    out[o++] = this.clock;
    out[o++] = this.overtime ? 1 : 0;
    out[o++] = this.overtimeClock;
    out[o++] = this.elapsed;
    out[o++] = this.paused ? 1 : 0;
    out[o++] = this.countdownRemaining;
    out[o++] = this.nextCountdown;
    out[o++] = this.shownCountdown;
    out[o++] = this.goalTimer;
    out[o++] = this.lastScorer === null ? -1 : this.lastScorer;
    out[o++] = this.winnerTeam === null ? -1 : this.winnerTeam;
    return o;
  }

  /** Restore what saveState wrote at src[off..] (queued events are dropped); returns the next offset. */
  loadState(src: Float64Array, off: number = 0): number {
    let o = off;
    const phase = PHASES[src[o++]];
    this.phase = phase === undefined ? 'menu' : phase;
    this.score.blue = src[o++];
    this.score.red = src[o++];
    this.clock = src[o++];
    this.overtime = src[o++] !== 0;
    this.overtimeClock = src[o++];
    this.elapsed = src[o++];
    this.paused = src[o++] !== 0;
    this.countdownRemaining = src[o++];
    this.nextCountdown = src[o++];
    this.shownCountdown = src[o++];
    this.goalTimer = src[o++];
    const scorer = src[o++];
    this.lastScorer = scorer < 0 ? null : scorer === 0 ? 0 : 1;
    const winner = src[o++];
    this.winnerTeam = winner < 0 ? null : winner === 0 ? 0 : 1;
    this.queued.length = 0;
    return o;
  }

  /** Advance timers by `dt` seconds and return the events produced (reused array). */
  tick(dt: number): MatchEvent[] {
    const out = this.out;
    out.length = 0;
    this.drain();
    if (this.paused || !(dt > 0)) return out;
    switch (this.phase) {
      case 'kickoff':
      case 'overtime-kickoff':
        this.tickCountdown(dt);
        break;
      case 'playing':
        this.tickPlaying(dt);
        break;
      case 'goal':
        this.tickGoalPause(dt);
        break;
      case 'menu':
      case 'ended':
        break;
    }
    this.drain();
    return out;
  }

  // ---- Internals ------------------------------------------------------------------------

  private resetState(): void {
    this.score.blue = 0;
    this.score.red = 0;
    this.clock = this.config.lengthSeconds;
    this.overtime = false;
    this.overtimeClock = 0;
    this.elapsed = 0;
    this.paused = false;
    this.countdownRemaining = 0;
    this.nextCountdown = 0;
    this.shownCountdown = 0;
    this.goalTimer = 0;
    this.lastScorer = null;
    this.winnerTeam = null;
    this.queued.length = 0;
  }

  private emit(e: MatchEvent): void {
    this.queued.push(e);
  }

  private drain(): void {
    const q = this.queued;
    if (q.length === 0) return;
    for (let i = 0; i < q.length; i++) this.out.push(q[i]);
    q.length = 0;
  }

  private countdownEvent(n: number): MatchEvent {
    const cache = this.countdownEvents;
    while (cache.length <= n) cache.push({ type: 'countdown', n: cache.length });
    return cache[n];
  }

  private beginKickoff(phase: 'kickoff' | 'overtime-kickoff'): void {
    this.phase = phase;
    this.emit(EV_KICKOFF_RESET);
    this.emit(EV_FREEZE);
    const secs = Math.max(0, this.config.kickoffCountdownSeconds);
    this.countdownRemaining = secs;
    const first = Math.ceil(secs - EPS);
    if (first >= 1) {
      this.shownCountdown = first;
      this.emit(this.countdownEvent(first));
      this.nextCountdown = first - 1;
    } else {
      this.shownCountdown = 0;
      this.nextCountdown = 0;
    }
  }

  private tickCountdown(dt: number): void {
    this.countdownRemaining -= dt;
    while (this.nextCountdown >= 1 && this.countdownRemaining <= this.nextCountdown + EPS) {
      this.shownCountdown = this.nextCountdown;
      this.emit(this.countdownEvent(this.nextCountdown));
      this.nextCountdown--;
    }
    if (this.countdownRemaining <= EPS) {
      this.countdownRemaining = 0;
      this.shownCountdown = 0;
      this.phase = 'playing';
      this.emit(EV_GO);
      this.emit(EV_UNFREEZE);
    }
  }

  private tickPlaying(dt: number): void {
    this.elapsed += dt;
    if (this.overtime) {
      this.overtimeClock += dt;
      return;
    }
    if (this.isUnlimited) return;
    this.clock -= dt;
    if (this.clock <= EPS) {
      this.clock = 0;
      this.endOfRegulation();
    }
  }

  private tickGoalPause(dt: number): void {
    this.goalTimer -= dt;
    if (this.goalTimer > EPS) return;
    this.goalTimer = 0;
    if (this.overtime) {
      // Golden goal.
      this.endMatch(this.lastScorer ?? this.leader ?? 0);
    } else if (!this.isUnlimited && this.clock <= 0) {
      this.endOfRegulation();
    } else {
      this.beginKickoff('kickoff');
    }
  }

  private endOfRegulation(): void {
    const leader = this.leader;
    if (leader === null) {
      this.overtime = true;
      this.overtimeClock = 0;
      this.emit(EV_OVERTIME);
      this.beginKickoff('overtime-kickoff');
    } else {
      this.endMatch(leader);
    }
  }

  private endMatch(winner: Team): void {
    this.phase = 'ended';
    this.winnerTeam = winner;
    this.emit({ type: 'ended', winner });
  }
}
