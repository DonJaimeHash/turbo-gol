/**
 * Team-aware coordination for 2v2 / 3v3 (car-soccer rotation). Every tick the BotTeam measures each
 * teammate's intercept time to the predicted ball, ranks them, and hands every Bot a role
 * (attacker / support / defender) plus a kickoff duty (go / cheat / stay) through `bot.teamCtx`;
 * the Bots keep all the low-level driving. Roles are documented in src/ai/README.md.
 *
 * Passive members (the human on the bots' team): `setSlots(slots, passiveSlots)` ranks them like
 * any teammate (intercept time, kickoff order, lane / yield, attacker stall) but allocates no Bot
 * and never writes controls for them, so the bots rotate around the human instead of
 * double-committing with it.
 *
 * Pure TypeScript (no three, no DOM). Allocation-free after setSlots(): every per-member array is
 * preallocated for MAX_CARS and the ranking is an in-place insertion sort.
 */
import {
  BALL_OFFSET,
  BALL_PRED_STRIDE,
  B_POS,
  B_VEL,
  C_BALL_HIT_TICK,
  C_BOOST,
  C_IS_DEMOED,
  C_POS,
  C_ROT,
  C_TEAM,
  C_VEL,
  MAX_CARS,
  Team,
  type CarControls,
  type SimStateView,
} from '../sim/types';
import { KICKOFF_SPAWNS } from '../sim/constants';
import { Bot, DUTIES, ROLES, TUNING, firstReachable, type BotRole, type Difficulty, type KickoffDuty } from './Bot';
import { dist2D, v3len2, v3read, v3set, vec3 } from './math';

export interface BotTeamOptions {
  team: Team;
  difficulty: Difficulty;
  seed?: number;
}

/** Midway between the ball distances of the farthest kickoff spot (the keeper spot) and the next one. */
function keeperSpotDist(): number {
  const d = KICKOFF_SPAWNS.map((s) => Math.hypot(s[0], s[1])).sort((a, b) => a - b);
  return d.length >= 2 ? (d[d.length - 1] + d[d.length - 2]) / 2 : d.length === 1 ? d[0] : 0;
}

/** Team-level tunables (mutable on purpose, like Bot's TUNING). */
export const TEAM_TUNING = {
  /** A challenger takes the attacker (or support) role only when its score is below the holder's * switchRatio ... */
  switchRatio: 0.85,
  /** ...AND below the holder's score - switchMargin (seconds). */
  switchMargin: 0.2,
  /** No attacker / support switch within this many ticks of the previous one of the same kind. */
  switchMinTicks: 30,
  /** Score (seconds) of a car with no ground intercept inside the horizon, plus ballDist / 2300. */
  unreachableBase: 6,
  /** The attacker is "beaten" when the nearest opponent is this much closer to the ball. */
  beatenRatio: 0.85,
  /** Two teammates closer than this (uu): the lower-ranked one yields. */
  yieldDist: 400,
  /** Kickoff distances within this (uu) are a tie: the car with the lower x goes. */
  kickoffTieEps: 2,
  /**
   * In a 2-car kickoff a second car farther than this from the ball is on the keeper spot and stays
   * (from constants.ts KICKOFF_SPAWNS: midway between the keeper spot and the inside spots, ~4520).
   */
  kickoffStayDist: keeperSpotDist(),
  /** Seed spacing between the member bots (member i uses seed + i * seedStride). */
  seedStride: 7919,
  /** An attacker within this (uu) of a low ball (z < TUNING.groundMaxBallZ)... */
  stallBallDist: 450,
  /** ...for this many ticks without touching it is stalled: the next best member takes over. */
  stallTicks: 90,
  /** A member switched out for stalling cannot retake the attacker role this long (ticks) unless it touches the ball. */
  stallLockoutTicks: 240,
};

/**
 * Drives up to MAX_CARS bots of one team. Usage:
 *
 *   const team = new BotTeam({ team: Team.Red, difficulty: 'hard', seed: 7 });
 *   team.setSlots([1, 3, 5]);                 // state-buffer slots of the team's cars
 *   team.setSlots([1], [0]);                  // ...or one bot next to the human in slot 0
 *   // every tick, before sim.setControls():
 *   team.think(state, outs);                  // outs[i] receives the controls for slots[i]
 *
 * With a single slot the bot behaves exactly like a standalone Bot (always the attacker).
 * Members are indexed bots first (0 .. size-1, in `slots` order), passive members after them
 * (size .. memberCount-1); `roleAt` / `dutyAt` / `slotAt` / `attackerIndex` use member indices.
 */
export class BotTeam {
  readonly team: Team;
  private difficulty: Difficulty;
  private readonly seed: number;
  private readonly bots: Bot[] = [];
  private readonly slots = new Int32Array(MAX_CARS);
  /** Bots (members 0 .. n-1) and passive members (n .. n+p-1). */
  private n = 0;
  private p = 0;

  // per-member scratch (index = position in slots)
  private readonly active = new Uint8Array(MAX_CARS);
  private readonly posX = new Float64Array(MAX_CARS);
  private readonly posY = new Float64Array(MAX_CARS);
  private readonly ballDist = new Float64Array(MAX_CARS);
  private readonly interceptT = new Float64Array(MAX_CARS);
  private readonly score = new Float64Array(MAX_CARS);
  private readonly order = new Int32Array(MAX_CARS); // member indices sorted by rank
  private readonly rankOf = new Int32Array(MAX_CARS);
  private readonly roles: BotRole[] = [];
  private readonly duties: KickoffDuty[] = [];
  private readonly preds: Float32Array[] = []; // intercept entry per member ([x,y,z,vx,vy,vz])
  // attacker stall: ticks near a low ball since the member's last touch, and the lockout after a hand-over
  private readonly nearTicks = new Int32Array(MAX_CARS);
  private readonly lastHitTick = new Float32Array(MAX_CARS);
  private readonly stallLockout = new Int32Array(MAX_CARS);
  private activeCount = 0;

  private attacker = -1;
  private support = -1;
  private lastAttackerSwitch = -1e9;
  private lastSupportSwitch = -1e9;
  private tick = 0;
  private kickoffActive = false;
  private attackerBeaten = false;

  // scratch
  private readonly carPos = vec3();
  private readonly carVel = vec3();
  private readonly carFwd = vec3();

  constructor(opts: BotTeamOptions) {
    this.team = opts.team;
    this.difficulty = opts.difficulty;
    this.seed = opts.seed ?? 12345;
    for (let i = 0; i < MAX_CARS; i++) {
      this.roles.push('attacker');
      this.duties.push('go');
      this.preds.push(new Float32Array(BALL_PRED_STRIDE));
      this.slots[i] = -1;
      this.order[i] = i;
      this.rankOf[i] = i;
    }
  }

  /** Number of cars this team drives (bots; passive members are not counted). */
  get size(): number {
    return this.n;
  }

  /** Number of passive members (ranked, never driven). */
  get passiveCount(): number {
    return this.p;
  }

  /** Bots plus passive members. */
  get memberCount(): number {
    return this.n + this.p;
  }

  /** Member index of the current attacker (-1 before the first think / with no live car); may be a passive member. */
  get attackerIndex(): number {
    return this.attacker;
  }

  /** True while the team is executing its kickoff duties. */
  get inKickoff(): boolean {
    return this.kickoffActive;
  }

  slotAt(i: number): number {
    return i >= 0 && i < this.n + this.p ? this.slots[i] : -1;
  }

  /** True for a passive member index (no Bot behind it; `botAt` is undefined there). */
  isPassive(i: number): boolean {
    return i >= this.n && i < this.n + this.p;
  }

  botAt(i: number): Bot {
    return this.bots[i];
  }

  roleAt(i: number): BotRole {
    return this.roles[i];
  }

  dutyAt(i: number): KickoffDuty {
    return this.duties[i];
  }

  /** Ticks member i has spent within stallBallDist of a low ball without touching it (debug / tests). */
  stallTicksOf(i: number): number {
    return i >= 0 && i < this.n + this.p ? this.nearTicks[i] : 0;
  }

  setDifficulty(d: Difficulty): void {
    this.difficulty = d;
    for (let i = 0; i < this.bots.length; i++) this.bots[i].setDifficulty(d);
  }

  /** Forget transient state (roles, hysteresis timers, every bot's state). */
  reset(): void {
    for (let i = 0; i < this.bots.length; i++) {
      this.bots[i].reset();
      this.bots[i].teamCtx.reset();
    }
    this.attacker = -1;
    this.support = -1;
    this.lastAttackerSwitch = -1e9;
    this.lastSupportSwitch = -1e9;
    this.kickoffActive = false;
    this.attackerBeaten = false;
    this.nearTicks.fill(0);
    this.lastHitTick.fill(-2);
    this.stallLockout.fill(0);
  }

  /** Floats of the team header (everything but the bots). */
  static readonly HEADER_FLOATS = 7 + 2 + MAX_CARS + 6 * MAX_CARS + 1;

  /** Upper bound of saveState's output with up to `maxBots` member bots allocated. */
  static stateFloatsMax(maxBots: number = MAX_CARS): number {
    return BotTeam.HEADER_FLOATS + maxBots * Bot.STATE_FLOATS;
  }

  /**
   * Write the team's memory (roles, hysteresis timers, stall counters, the member layout) and
   * every allocated bot (Bot.saveState) at out[off..]; returns the next offset. The per-think
   * measurements (positions, scores, ranking scratch) are not included: think() recomputes them.
   * Allocation-free. Used by the P2P rollback checkpoints.
   */
  saveState(out: Float64Array, off: number): number {
    let o = off;
    out[o++] = this.tick;
    out[o++] = this.attacker;
    out[o++] = this.support;
    out[o++] = this.lastAttackerSwitch;
    out[o++] = this.lastSupportSwitch;
    out[o++] = this.kickoffActive ? 1 : 0;
    out[o++] = this.attackerBeaten ? 1 : 0;
    out[o++] = this.n;
    out[o++] = this.p;
    for (let i = 0; i < MAX_CARS; i++) out[o++] = this.slots[i];
    for (let i = 0; i < MAX_CARS; i++) out[o++] = this.nearTicks[i];
    for (let i = 0; i < MAX_CARS; i++) out[o++] = this.lastHitTick[i];
    for (let i = 0; i < MAX_CARS; i++) out[o++] = this.stallLockout[i];
    for (let i = 0; i < MAX_CARS; i++) out[o++] = ROLES.indexOf(this.roles[i]);
    for (let i = 0; i < MAX_CARS; i++) out[o++] = DUTIES.indexOf(this.duties[i]);
    for (let i = 0; i < MAX_CARS; i++) out[o++] = this.rankOf[i];
    const bots = this.bots;
    out[o++] = bots.length;
    for (let i = 0; i < bots.length; i++) o = bots[i].saveState(out, o);
    return o;
  }

  /**
   * Restore what saveState wrote at src[off..]; returns the next offset. Bots allocated after the
   * save are discarded (a later setSlots re-creates them with their seeds, as fresh as they were).
   */
  loadState(src: Float64Array, off: number): number {
    let o = off;
    this.tick = src[o++];
    this.attacker = src[o++];
    this.support = src[o++];
    this.lastAttackerSwitch = src[o++];
    this.lastSupportSwitch = src[o++];
    this.kickoffActive = src[o++] !== 0;
    this.attackerBeaten = src[o++] !== 0;
    this.n = src[o++];
    this.p = src[o++];
    for (let i = 0; i < MAX_CARS; i++) this.slots[i] = src[o++];
    for (let i = 0; i < MAX_CARS; i++) this.nearTicks[i] = src[o++];
    for (let i = 0; i < MAX_CARS; i++) this.lastHitTick[i] = src[o++];
    for (let i = 0; i < MAX_CARS; i++) this.stallLockout[i] = src[o++];
    for (let i = 0; i < MAX_CARS; i++) this.roles[i] = ROLES[src[o++]] ?? 'attacker';
    for (let i = 0; i < MAX_CARS; i++) this.duties[i] = DUTIES[src[o++]] ?? 'go';
    for (let i = 0; i < MAX_CARS; i++) this.rankOf[i] = src[o++];
    const count = src[o++];
    const bots = this.bots;
    while (bots.length < count) {
      const i = bots.length;
      bots.push(new Bot({ team: this.team, difficulty: this.difficulty, seed: this.seed + i * TEAM_TUNING.seedStride }));
    }
    bots.length = count;
    for (let i = 0; i < count; i++) o = bots[i].loadState(src, o);
    return o;
  }

  /**
   * State-buffer slots of the team's cars (not car ids) and, optionally, of the team's passive
   * members (the human teammate): ranked and given roles like any member, never driven. Allocates
   * the member bots on first use; call once per match setup, not per tick.
   */
  setSlots(slots: readonly number[], passiveSlots: readonly number[] = []): void {
    const n = Math.min(slots.length, MAX_CARS);
    const p = Math.min(passiveSlots.length, MAX_CARS - n);
    while (this.bots.length < n) {
      const i = this.bots.length;
      this.bots.push(new Bot({ team: this.team, difficulty: this.difficulty, seed: this.seed + i * TEAM_TUNING.seedStride }));
    }
    for (let i = 0; i < MAX_CARS; i++) this.slots[i] = i < n ? slots[i] : i < n + p ? passiveSlots[i - n] : -1;
    this.n = n;
    this.p = p;
    this.reset();
  }

  /**
   * Produce controls for every bot: outs[i] receives the controls for slots[i]. Call every tick
   * (the bots' reflexes are tick-level). Allocation-free.
   */
  think(state: SimStateView, outs: CarControls[]): void {
    this.tick++;
    const n = this.n;
    if (n === 0) return;
    const total = n + this.p;
    const buf = state.buf;
    const bx = buf[BALL_OFFSET + B_POS];
    const by = buf[BALL_OFFSET + B_POS + 1];
    const ballLow = buf[BALL_OFFSET + B_POS + 2] < TUNING.groundMaxBallZ;
    const bvx = buf[BALL_OFFSET + B_VEL];
    const bvy = buf[BALL_OFFSET + B_VEL + 1];
    const bvz = buf[BALL_OFFSET + B_VEL + 2];
    const kickoff = Math.abs(bx) < 5 && Math.abs(by) < 5 && bvx * bvx + bvy * bvy + bvz * bvz < 1;

    // 1) measure every member (same inputs as Bot.readState / decide, so the intercept estimate
    //    handed over through teamCtx is identical to what the bot would compute itself)
    const numCars = state.numCars;
    let myTeam = this.team === Team.Red ? 1 : 0;
    this.activeCount = 0;
    for (let i = 0; i < total; i++) {
      const slot = this.slots[i];
      const valid = slot >= 0 && (numCars === 0 || slot < numCars);
      const o = valid ? state.carOffset(slot) : 0;
      const live = valid && buf[o + C_IS_DEMOED] < 0.5;
      if (this.stallLockout[i] > 0) this.stallLockout[i]--;
      if (!live) {
        this.active[i] = 0;
        this.interceptT[i] = -1;
        this.score[i] = Infinity;
        this.ballDist[i] = Infinity;
        this.posX[i] = 0;
        this.posY[i] = 0;
        this.nearTicks[i] = 0;
        continue;
      }
      this.active[i] = 1;
      this.activeCount++;
      myTeam = buf[o + C_TEAM] === 1 ? 1 : 0;
      v3read(this.carPos, buf, o + C_POS);
      v3read(this.carFwd, buf, o + C_ROT);
      if (v3len2(this.carFwd) < 0.5) v3set(this.carFwd, 0, 1, 0);
      v3read(this.carVel, buf, o + C_VEL);
      this.posX[i] = this.carPos[0];
      this.posY[i] = this.carPos[1];
      this.ballDist[i] = dist2D(this.carPos[0], this.carPos[1], bx, by);
      const t = firstReachable(state, this.carPos, this.carVel, this.carFwd, buf[o + C_BOOST], this.preds[i]);
      this.interceptT[i] = t;
      this.score[i] = t >= 0 ? t : TEAM_TUNING.unreachableBase + this.ballDist[i] / 2300;
      // near-ball stall counter: a touch (C_BALL_HIT_TICK changes) clears it and any lockout
      const hitTick = buf[o + C_BALL_HIT_TICK];
      if (hitTick !== this.lastHitTick[i]) {
        this.lastHitTick[i] = hitTick;
        this.nearTicks[i] = 0;
        this.stallLockout[i] = 0;
      } else if (ballLow && this.ballDist[i] < TEAM_TUNING.stallBallDist) {
        this.nearTicks[i]++;
      } else {
        this.nearTicks[i] = 0;
      }
    }

    // nearest live opponent to the ball (for "attacker beaten")
    let oppBallDist = Infinity;
    for (let s = 0; s < numCars; s++) {
      const o = state.carOffset(s);
      if ((buf[o + C_TEAM] === 1 ? 1 : 0) === myTeam) continue;
      if (buf[o + C_IS_DEMOED] > 0.5) continue;
      const d = dist2D(buf[o + C_POS], buf[o + C_POS + 1], bx, by);
      if (d < oppBallDist) oppBallDist = d;
    }

    // 2) roles
    if (kickoff) {
      if (!this.kickoffActive) {
        this.assignKickoff();
        this.kickoffActive = true;
      }
    } else {
      this.kickoffActive = false;
      this.assignRoles();
    }
    const att = this.attacker;
    this.attackerBeaten =
      att >= 0 && this.active[att] === 1 && (this.interceptT[att] < 0 || oppBallDist < this.ballDist[att] * TEAM_TUNING.beatenRatio);

    // 3) context + think (bots only; a passive member is ranked above but never driven)
    let hasDefender = false;
    for (let i = 0; i < total; i++) if (this.active[i] === 1 && this.roles[i] === 'defender') hasDefender = true;
    const m = n < outs.length ? n : outs.length;
    for (let i = 0; i < m; i++) {
      const bot = this.bots[i];
      const ctx = bot.teamCtx;
      ctx.role = this.roles[i];
      ctx.kickoff = kickoff ? this.duties[i] : 'go';
      const hasAtt = att >= 0 && att !== i && this.active[att] === 1;
      ctx.hasAttacker = hasAtt;
      ctx.hasDefender = hasDefender && this.roles[i] !== 'defender';
      if (hasAtt) {
        v3set(ctx.attackerPos, this.posX[att], this.posY[att], 0);
        ctx.attackerBallDist = this.ballDist[att];
        ctx.attackerBeaten = this.attackerBeaten;
      } else {
        v3set(ctx.attackerPos, 0, 0, 0);
        ctx.attackerBallDist = Infinity;
        ctx.attackerBeaten = false;
      }
      // never double-commit: a higher-ranked teammate right next to us -> we yield
      ctx.yield = false;
      if (this.active[i] === 1 && i !== att) {
        const ri = this.rankOf[i];
        for (let j = 0; j < total; j++) {
          if (j === i || this.active[j] === 0 || this.rankOf[j] >= ri) continue;
          if (dist2D(this.posX[i], this.posY[i], this.posX[j], this.posY[j]) < TEAM_TUNING.yieldDist) {
            ctx.yield = true;
            v3set(ctx.yieldPos, this.posX[j], this.posY[j], 0);
            break;
          }
        }
      }
      ctx.interceptFresh = this.active[i] === 1;
      ctx.interceptT = this.interceptT[i];
      ctx.interceptPred.set(this.preds[i]);
      bot.think(state, this.slots[i], -1, outs[i]);
    }
  }

  // ---- ranking ----------------------------------------------------------------------------

  /** Challenger a beats holder b when it is at least 15 % AND 0.2 s faster (both margins). */
  private better(a: number, b: number): boolean {
    const sa = this.score[a];
    const sb = this.score[b];
    return sa < sb * TEAM_TUNING.switchRatio && sa < sb - TEAM_TUNING.switchMargin;
  }

  /** Sort the live members into order[] by `score` (insertion sort, stable), dead ones last. */
  private sortByScore(): void {
    const n = this.n + this.p;
    let m = 0;
    for (let i = 0; i < n; i++) {
      if (this.active[i] === 0) continue;
      let k = m;
      while (k > 0 && this.score[this.order[k - 1]] > this.score[i]) {
        this.order[k] = this.order[k - 1];
        k--;
      }
      this.order[k] = i;
      m++;
    }
    for (let i = 0; i < n; i++) if (this.active[i] === 0) this.order[m++] = i;
  }

  /**
   * Normal play: attacker = best intercept (with hysteresis), support = next, the rest defend.
   * An attacker that has sat within stallBallDist of a low ball for stallTicks without touching it
   * (its own intercept estimate still looks best, so the hysteresis would keep it forever) hands
   * the role to the best other member and is locked out of it for stallLockoutTicks or until it
   * touches the ball.
   */
  private assignRoles(): void {
    const n = this.n + this.p;
    this.sortByScore();
    const tick = this.tick;
    const att0 = this.attacker;
    if (att0 >= 0 && att0 < n && this.active[att0] === 1 && this.nearTicks[att0] >= TEAM_TUNING.stallTicks) {
      this.stallLockout[att0] = TEAM_TUNING.stallLockoutTicks;
      this.nearTicks[att0] = 0;
    }
    // best = fastest live member that is not locked out (everyone locked out: the fastest anyway)
    let best = -1;
    for (let k = 0; k < this.activeCount; k++) {
      const i = this.order[k];
      if (this.stallLockout[i] === 0) {
        best = i;
        break;
      }
    }
    if (best < 0 && this.activeCount > 0) best = this.order[0];

    // attacker
    if (this.attacker < 0 || this.attacker >= n || this.active[this.attacker] === 0 || (this.stallLockout[this.attacker] > 0 && best !== this.attacker)) {
      this.attacker = best;
      this.lastAttackerSwitch = tick;
    } else if (best >= 0 && best !== this.attacker && tick - this.lastAttackerSwitch >= TEAM_TUNING.switchMinTicks && this.better(best, this.attacker)) {
      this.attacker = best;
      this.lastAttackerSwitch = tick;
    }
    const att = this.attacker;

    // support: best-ranked live non-attacker, same hysteresis
    let cand = -1;
    for (let k = 0; k < this.activeCount; k++) {
      const i = this.order[k];
      if (i !== att) {
        cand = i;
        break;
      }
    }
    if (this.support < 0 || this.support >= n || this.support === att || this.active[this.support] === 0) {
      this.support = cand;
      this.lastSupportSwitch = tick;
    } else if (cand >= 0 && cand !== this.support && tick - this.lastSupportSwitch >= TEAM_TUNING.switchMinTicks && this.better(cand, this.support)) {
      this.support = cand;
      this.lastSupportSwitch = tick;
    }
    const sup = this.support;

    // ranks: attacker 0, support 1, then the rest in score order
    let r = 0;
    if (att >= 0) this.rankOf[att] = r++;
    if (sup >= 0) this.rankOf[sup] = r++;
    for (let k = 0; k < n; k++) {
      const i = this.order[k];
      if (i !== att && i !== sup) this.rankOf[i] = r++;
    }
    for (let i = 0; i < n; i++) {
      this.roles[i] = i === att ? 'attacker' : i === sup ? 'support' : 'defender';
      this.duties[i] = 'go';
    }
  }

  /**
   * Kickoff: the car closest to the ball goes (ties between the mirrored wing / inside spots: the
   * one with the lower x goes), the next cheats up to midfield, the farthest (the keeper spot)
   * stays in goal. Decided once when the kickoff starts and held until the ball moves.
   */
  private assignKickoff(): void {
    const n = this.n + this.p;
    const eps = TEAM_TUNING.kickoffTieEps;
    // order live members by ball distance, ties by x
    let m = 0;
    for (let i = 0; i < n; i++) {
      if (this.active[i] === 0) continue;
      let k = m;
      while (k > 0 && this.kickoffBefore(i, this.order[k - 1], eps)) {
        this.order[k] = this.order[k - 1];
        k--;
      }
      this.order[k] = i;
      m++;
    }
    for (let i = 0; i < n; i++) if (this.active[i] === 0) this.order[m++] = i;

    for (let i = 0; i < n; i++) {
      this.duties[i] = 'stay';
      this.roles[i] = 'defender';
      this.rankOf[i] = n - 1;
    }
    this.attacker = -1;
    this.support = -1;
    for (let k = 0; k < m; k++) {
      const i = this.order[k];
      this.rankOf[i] = k;
      let duty: KickoffDuty;
      if (k === 0) duty = 'go';
      else if (m >= 3 && k === m - 1) duty = 'stay';
      else if (m === 2 && this.ballDist[i] > TEAM_TUNING.kickoffStayDist) duty = 'stay';
      else duty = 'cheat';
      this.duties[i] = duty;
      this.roles[i] = duty === 'go' ? 'attacker' : duty === 'cheat' ? 'support' : 'defender';
      if (duty === 'go') this.attacker = i;
      else if (duty === 'cheat' && this.support < 0) this.support = i;
    }
    this.lastAttackerSwitch = this.tick;
    this.lastSupportSwitch = this.tick;
  }

  /** Kickoff ordering: a before b when clearly closer to the ball, or tied and with a lower x. */
  private kickoffBefore(a: number, b: number, eps: number): boolean {
    const da = this.ballDist[a];
    const db = this.ballDist[b];
    if (da < db - eps) return true;
    if (da > db + eps) return false;
    return this.posX[a] < this.posX[b];
  }
}
