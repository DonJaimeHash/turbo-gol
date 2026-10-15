/**
 * Training session rules: free play, or one shot pack played shot by shot. Pure TypeScript (no
 * DOM, no three.js, no sim): the Game feeds it the player's input, goals, touches and the ball
 * state each tick and it calls back through TrainingHooks when something must happen in the sim
 * or on screen. Node-tested in tests/training-session.test.mjs.
 *
 * Pack flow per shot:
 *
 *   waiting   car and ball placed (placeShot); the sim does NOT step (`frozen`), so nothing moves
 *             until the first car input (throttle, steer, air axes, jump, boost, powerslide)
 *   running   that input released the ball (releaseShot: velocities applied, attempt counted)
 *             and the per-shot timer runs (pack.timeLimitSeconds)
 *   grace     the timer ran out with the ball in the air (or, saving, still heading for the blue
 *             goal): the attempt goes on until that is over, a goal or TRAINING_GRACE_SECONDS
 *   result    pass / fail decided (shotResult); RESULT_SECONDS of banner while the sim keeps
 *             running (the car stays drivable, a scored ball stays pinned by the Game), then:
 *               - every shot has a result (first time this run) -> summary
 *               - passed -> the next shot without a result (or simply the next one)
 *               - failed -> the same shot again
 *   summary   every shot has a result: passed / total, best record saved (saveTrainingResult);
 *             frozen until retryPack() / a shot is picked / the player leaves
 *
 * Judging:
 *   Shooting / Aerial  pass = ball in the RED goal (scoring team blue); fail = blue goal (own
 *                      goal) or timeout
 *   Saving             fail = ball in the BLUE goal; pass = timeout without a goal, or the early
 *                      save: GOALIE_SAVE_SECONDS after the player's latest touch with no goal and
 *                      the ball not heading into the goal (the attempt ends ~1 s after a touch
 *                      that cleared it); a ball cleared into the red goal also passes
 *
 * A shot's result is its best attempt: 'pass' is sticky, 'fail' only fills an empty result. A shot
 * abandoned with resetShot / next / previous before its result keeps what it had. Attempts count
 * releases. After the summary was shown once, results no longer re-open it (the player is just
 * practising); retryPack() starts a clean run.
 *
 * Free play (pack = null): only `onGoal` matters: a goal returns true (the Game plays the goal
 * effect), shows freeplayGoal and FREEPLAY_GOAL_PAUSE_SECONDS later puts the ball back at the
 * centre (freeplayReset). resetBall() / resetCar() are the free play actions.
 *
 * No allocations per tick: every array is created in the constructor, the ball sample is the
 * caller's reusable object, and hooks are plain method calls.
 */
import { ARENA } from '../sim/constants';
import type { CarControls } from '../sim/types';
import { TRAINING_GRACE_SECONDS, type TrainingPack, type TrainingShot } from './trainingPacks';
import { saveTrainingResult, type StorageLike } from './trainingRecords';

export type TrainingPhase = 'freeplay' | 'waiting' | 'running' | 'grace' | 'result' | 'summary';
export type ShotOutcome = 'pass' | 'fail';
/** Why an attempt ended: goal (shooting / aerial scored), save (saving), ownGoal, conceded, timeout. */
export type ResultReason = 'goal' | 'save' | 'ownGoal' | 'conceded' | 'timeout';

/** Seconds the success / fail banner stays before the next shot (or the retry). */
export const RESULT_SECONDS = 1.5;
/** Free play: seconds between a goal and the ball going back to the centre. */
export const FREEPLAY_GOAL_PAUSE_SECONDS = 2;
/** Saving: a touch followed by this many seconds without a goal is a save. */
export const GOALIE_SAVE_SECONDS = 1;
/** Ball centre height (uu) above which the ball counts as airborne (rest height 93). */
export const AIRBORNE_Z = 140;
/**
 * Saving: the ball is still dangerous while it is in this part of the field (within 1800 uu of the
 * blue goal line) moving toward the goal.
 */
export const GOALIE_DANGER_Y = -(ARENA.extentY - 1800);
export const GOALIE_DANGER_VY = -150;

/** Analog deflection that counts as "the player moved" (a resting trigger reads a few %). */
export const INPUT_THRESHOLD = 0.1;

/**
 * Any car input in this sample (what releases a frozen shot): a button (jump, boost, powerslide)
 * or an analog axis (throttle, steer, pitch, yaw, roll) beyond INPUT_THRESHOLD. Camera input (ball
 * cam, swivel) does not count.
 */
export function hasCarInput(c: CarControls): boolean {
  const t = INPUT_THRESHOLD;
  return (
    c.jump ||
    c.boost ||
    c.handbrake ||
    c.throttle > t ||
    c.throttle < -t ||
    c.steer > t ||
    c.steer < -t ||
    c.pitch > t ||
    c.pitch < -t ||
    c.yaw > t ||
    c.yaw < -t ||
    c.roll > t ||
    c.roll < -t
  );
}

export interface TrainingSummary {
  passed: number;
  total: number;
  /** Best completed run for this pack after this one. */
  best: number;
  /** This run set (or is) the pack's best. */
  newBest: boolean;
}

/** Ball state the session judges with (filled by the caller each tick; read only). */
export interface TrainingBallSample {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

/** What the session asks of the Game. Called synchronously from the session's methods. */
export interface TrainingHooks {
  /** Put the car and the ball at `shot`, everything at rest (the session keeps the sim frozen). */
  placeShot(shot: TrainingShot, index: number): void;
  /** The first input of the attempt: give the ball (and the car, when the shot says so) their velocities. */
  releaseShot(shot: TrainingShot, index: number): void;
  /** An attempt ended. */
  shotResult(index: number, pass: boolean, reason: ResultReason): void;
  /** Every shot has a result (once per run). */
  packSummary(summary: TrainingSummary): void;
  /** Free play: a goal counted (the ball is reset FREEPLAY_GOAL_PAUSE_SECONDS later). */
  freeplayGoal(team: 0 | 1): void;
  /** Free play: put the car at its spawn and / or the ball at the centre spot, at rest. */
  freeplayReset(car: boolean, ball: boolean): void;
}

export interface TrainingSessionOptions {
  /** Where saveTrainingResult writes (default localStorage; null = never persist). */
  storage?: StorageLike | null;
  /** Clock for the record's completedAt (default Date.now). */
  now?: () => number;
}

export class TrainingSession {
  /** The pack being played, null in free play. */
  readonly pack: TrainingPack | null;
  /** Releases per shot. */
  readonly attempts: number[] = [];
  /** Best outcome per shot (null = no result yet). */
  readonly results: (ShotOutcome | null)[] = [];

  phase: TrainingPhase;
  /** Current shot index (0 in free play). */
  index = 0;
  /** Seconds since the release of the current attempt (frozen at the result). */
  elapsed = 0;
  /** Outcome of the latest result (valid in 'result'). */
  lastPass = false;
  lastReason: ResultReason = 'timeout';
  /** The summary of this run was shown (results then go on without re-opening it). */
  summaryShown = false;
  /** Summary of the last completed run (valid in 'summary'). */
  readonly summary: TrainingSummary = { passed: 0, total: 0, best: 0, newBest: false };

  private readonly hooks: TrainingHooks;
  private readonly storage: StorageLike | null | undefined;
  private readonly now: () => number;
  /** `elapsed` at the player's latest touch of the current attempt, -1 before any. */
  private touchedAt = -1;
  private graceLeft = 0;
  private resultLeft = 0;
  /** Free play: seconds until the scored ball goes back to the centre (0 = no goal pending). */
  private goalPauseLeft = 0;

  constructor(pack: TrainingPack | null, hooks: TrainingHooks, opts: TrainingSessionOptions = {}) {
    this.pack = pack;
    this.hooks = hooks;
    this.storage = opts.storage;
    this.now = opts.now ?? Date.now;
    this.phase = pack === null ? 'freeplay' : 'waiting';
    const n = pack === null ? 0 : pack.shots.length;
    for (let i = 0; i < n; i++) {
      this.attempts.push(0);
      this.results.push(null);
    }
  }

  get isFreeplay(): boolean {
    return this.pack === null;
  }

  get shotCount(): number {
    return this.results.length;
  }

  /** The current shot (null in free play). */
  get shot(): TrainingShot | null {
    return this.pack === null ? null : this.pack.shots[this.index];
  }

  /** The sim must not step: waiting for the first input, or the summary is up. */
  get frozen(): boolean {
    return this.phase === 'waiting' || this.phase === 'summary';
  }

  get timeLimit(): number {
    return this.pack === null ? 0 : this.pack.timeLimitSeconds;
  }

  /** Seconds left on the shot timer (the full limit while waiting, 0 in grace). */
  get timeLeft(): number {
    if (this.pack === null) return 0;
    const left = this.pack.timeLimitSeconds - this.elapsed;
    return left > 0 ? left : 0;
  }

  /** Shots passed in this run. */
  get passedCount(): number {
    let n = 0;
    for (let i = 0; i < this.results.length; i++) if (this.results[i] === 'pass') n++;
    return n;
  }

  /** Every shot has a result. */
  get allResolved(): boolean {
    for (let i = 0; i < this.results.length; i++) if (this.results[i] === null) return false;
    return this.results.length > 0;
  }

  /** Begin: the first shot (pack) or the free play layout. */
  start(): void {
    if (this.pack === null) {
      this.goalPauseLeft = 0;
      this.hooks.freeplayReset(true, true);
    } else {
      this.goTo(0);
    }
  }

  // ---- per tick ------------------------------------------------------------------------------

  /** Before the sim step: `any` = the player gave a car input this tick (releases a waiting shot). */
  input(any: boolean): void {
    if (this.phase !== 'waiting' || !any || this.pack === null) return;
    this.phase = 'running';
    this.elapsed = 0;
    this.touchedAt = -1;
    this.attempts[this.index]++;
    this.hooks.releaseShot(this.pack.shots[this.index], this.index);
  }

  /**
   * A goal by `team` (the SCORING team: 0 = ball in the red goal, 1 = ball in the blue goal),
   * from the sim's goal event. Returns true when it counts (the Game then plays the goal effect).
   */
  onGoal(team: 0 | 1): boolean {
    const pack = this.pack;
    if (pack === null) {
      if (this.goalPauseLeft > 0) return false;
      this.goalPauseLeft = FREEPLAY_GOAL_PAUSE_SECONDS;
      this.hooks.freeplayGoal(team);
      return true;
    }
    if (this.phase !== 'running' && this.phase !== 'grace') return false;
    if (pack.category === 'saving') {
      if (team === 1) this.finish(false, 'conceded');
      else this.finish(true, 'save');
    } else if (team === 0) {
      this.finish(true, 'goal');
    } else {
      this.finish(false, 'ownGoal');
    }
    return true;
  }

  /** The player's car touched the ball (any touch, from the sim's ball-hit event). */
  onPlayerTouch(): void {
    if (this.phase === 'running' || this.phase === 'grace') this.touchedAt = this.elapsed;
  }

  /** After the sim step: timers and judging. */
  tick(dt: number, ball: TrainingBallSample): void {
    if (!(dt > 0)) return;
    switch (this.phase) {
      case 'freeplay':
        if (this.goalPauseLeft > 0) {
          this.goalPauseLeft -= dt;
          if (this.goalPauseLeft <= 0) {
            this.goalPauseLeft = 0;
            this.hooks.freeplayReset(false, true);
          }
        }
        break;
      case 'running':
        this.elapsed += dt;
        if (this.checkSave(ball)) break;
        if (this.elapsed >= this.timeLimit) {
          if (this.inFlight(ball)) {
            this.phase = 'grace';
            this.graceLeft = TRAINING_GRACE_SECONDS;
          } else {
            this.timeout();
          }
        }
        break;
      case 'grace':
        this.elapsed += dt;
        if (this.checkSave(ball)) break;
        this.graceLeft -= dt;
        if (this.graceLeft <= 0 || !this.inFlight(ball)) this.timeout();
        break;
      case 'result':
        this.resultLeft -= dt;
        if (this.resultLeft <= 0) this.afterResult();
        break;
      case 'waiting':
      case 'summary':
        break;
    }
  }

  // ---- actions -------------------------------------------------------------------------------

  /** Reset shot (pack: the current shot again, the attempt is dropped) / reset ball (free play). */
  resetShot(): void {
    if (this.pack === null) {
      this.resetBall();
      return;
    }
    if (this.phase === 'summary') return;
    this.goTo(this.index);
  }

  nextShot(): void {
    if (this.pack !== null) this.goTo(this.index + 1);
  }

  prevShot(): void {
    if (this.pack !== null) this.goTo(this.index - 1);
  }

  /** A clean run of the same pack from shot 1 (summary's "retry pack"). */
  retryPack(): void {
    if (this.pack === null) return;
    this.attempts.fill(0);
    this.results.fill(null);
    this.summaryShown = false;
    this.goTo(0);
  }

  /** Jump to shot `i` (wraps around), frozen until the first input. */
  goTo(i: number): void {
    const pack = this.pack;
    if (pack === null) return;
    const n = pack.shots.length;
    this.index = ((i % n) + n) % n;
    this.phase = 'waiting';
    this.elapsed = 0;
    this.touchedAt = -1;
    this.graceLeft = 0;
    this.resultLeft = 0;
    this.hooks.placeShot(pack.shots[this.index], this.index);
  }

  /** Free play: ball back to the centre at rest (also ends a pending goal pause). */
  resetBall(): void {
    if (this.pack !== null) return;
    this.goalPauseLeft = 0;
    this.hooks.freeplayReset(false, true);
  }

  /** Free play: car back to its spawn. */
  resetCar(): void {
    if (this.pack === null) this.hooks.freeplayReset(true, false);
  }

  // ---- internals -----------------------------------------------------------------------------

  /** Saving early save: a touch, GOALIE_SAVE_SECONDS without a goal, ball no longer heading in. */
  private checkSave(ball: TrainingBallSample): boolean {
    const pack = this.pack;
    if (pack === null || pack.category !== 'saving' || this.touchedAt < 0) return false;
    if (this.elapsed - this.touchedAt < GOALIE_SAVE_SECONDS || this.dangerous(ball)) return false;
    this.finish(true, 'save');
    return true;
  }

  /** Saving: the ball is in the defensive end and moving toward the blue goal. */
  private dangerous(ball: TrainingBallSample): boolean {
    return ball.y < GOALIE_DANGER_Y && ball.vy < GOALIE_DANGER_VY;
  }

  /** The attempt is not over at the buzzer: ball airborne, or (saving) still heading for the goal. */
  private inFlight(ball: TrainingBallSample): boolean {
    if (ball.z > AIRBORNE_Z) return true;
    return this.pack !== null && this.pack.category === 'saving' && this.dangerous(ball);
  }

  private timeout(): void {
    const saving = this.pack !== null && this.pack.category === 'saving';
    this.finish(saving, saving ? 'save' : 'timeout');
  }

  private finish(pass: boolean, reason: ResultReason): void {
    const i = this.index;
    if (pass) this.results[i] = 'pass';
    else if (this.results[i] === null) this.results[i] = 'fail';
    this.phase = 'result';
    this.resultLeft = RESULT_SECONDS;
    this.lastPass = pass;
    this.lastReason = reason;
    this.hooks.shotResult(i, pass, reason);
  }

  private afterResult(): void {
    const pack = this.pack;
    if (pack === null) return;
    if (!this.summaryShown && this.allResolved) {
      this.showSummary(pack);
      return;
    }
    if (!this.lastPass) {
      this.goTo(this.index);
      return;
    }
    // The next shot still without a result, else simply the next one.
    const n = pack.shots.length;
    let next = (this.index + 1) % n;
    for (let k = 1; k <= n; k++) {
      const j = (this.index + k) % n;
      if (this.results[j] === null) {
        next = j;
        break;
      }
    }
    this.goTo(next);
  }

  private showSummary(pack: TrainingPack): void {
    this.phase = 'summary';
    this.summaryShown = true;
    const passed = this.passedCount;
    const total = pack.shots.length;
    const upd = saveTrainingResult(pack.id, passed, total, this.now(), this.storage);
    const s = this.summary;
    s.passed = passed;
    s.total = total;
    s.best = upd.record.best;
    s.newBest = upd.newBest;
    this.hooks.packSummary(s);
  }
}
