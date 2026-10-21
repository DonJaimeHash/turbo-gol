/**
 * Heuristic car-soccer bot. Pure TypeScript (no three, no DOM): reads a SimStateView (state
 * buffer + ball prediction, layout in src/sim/types.ts) and writes CarControls for one car slot.
 * The same brain drives the AI opponent or, in a demo mode, the player's car.
 *
 * Team play: a BotTeam (src/ai/Team.ts) writes a role (attacker / support / defender) and a
 * kickoff duty into `bot.teamCtx` before every think(); a standalone Bot keeps the defaults, which
 * reproduce the 1v1 behaviour exactly.
 *
 * Decision tree, roles, tunables and difficulty table are documented in src/ai/README.md.
 *
 * Hot-path rule: no allocations in think(). All vectors are Float32Array scratch objects created
 * in the constructor; the prediction scan indexes the Float32Array directly.
 */
import {
  BALL_OFFSET,
  BALL_PRED_STRIDE,
  BALL_PRED_TICKS,
  B_POS,
  B_VEL,
  C_ANG_VEL,
  C_BALL_HIT_TICK,
  C_BOOST,
  C_HAS_DOUBLE_JUMPED,
  C_HAS_FLIPPED,
  C_HAS_JUMPED,
  C_IS_DEMOED,
  C_IS_FLIPPING,
  C_IS_ON_GROUND,
  C_POS,
  C_ROT,
  C_TEAM,
  C_VEL,
  NUM_BOOST_PADS,
  PADS_OFFSET,
  PAD_STRIDE,
  P_IS_ACTIVE,
  TICK_DT,
  TICK_RATE,
  Team,
  type CarControls,
  type SimStateView,
} from '../sim/types';
import { ARENA, BALL, BOOST_PADS_BIG, BOOST_PADS_SMALL, CAR_STANDARD } from '../sim/constants';
import {
  Rng,
  STOCK_BOT_PHYSICS,
  angleToPoint2D,
  clamp,
  clamp1,
  dist2D,
  groundAccel,
  MAX_DRIVE_SPEED,
  turnRadius,
  v3copy,
  v3cross,
  v3dist,
  v3dist2D,
  v3dot,
  v3dot2D,
  v3len,
  v3len2,
  v3len2D,
  v3lerp,
  v3normalize,
  v3normalize2D,
  v3read,
  v3set,
  v3sub,
  vec3,
  wrapAngle,
  type BotPhysics,
  type Vec3,
} from './math';

export type Difficulty = 'easy' | 'medium' | 'hard';

/** High-level behaviour the bot is currently executing (exposed for HUD/debug overlays). */
export type BotMode = 'kickoff' | 'attack' | 'defend' | 'support' | 'boost' | 'recover' | 'aerial';

/**
 * Team role (see README "Roles"). A standalone bot is always the attacker, which is the 1v1
 * behaviour; support and defender are positioning roles assigned by a BotTeam.
 */
export type BotRole = 'attacker' | 'support' | 'defender';

/** What this car does at a kickoff: drive at the ball, cheat up to midfield, or stay in goal. */
export type KickoffDuty = 'go' | 'cheat' | 'stay';

/** Jump / dodge micro-sequence (runs every tick, independent of the think cadence). */
type JumpSeq = 'none' | 'jump' | 'wait' | 'flip' | 'air';

export interface BotOptions {
  team: Team;
  difficulty?: Difficulty;
  seed?: number;
  /**
   * Physics the bot plans with (gravity, jumps, boost, top speed): STOCK_BOT_PHYSICS by default; an
   * experimental preset passes the same profile to every bot of the match (src/sim/mutators.ts
   * botPhysicsOf). The ball comes from the wasm prediction, which follows the preset by itself.
   */
  physics?: BotPhysics;
}

export interface DifficultyParams {
  /** Decisions (mode, target, steering) are refreshed every N ticks; outputs are held in between. */
  thinkEvery: number;
  /** Throttle cap while driving. */
  throttleMax: number;
  /** Boost allowed outside kickoff. */
  useBoost: boolean;
  /** Minimum distance to the target before boosting. */
  boostMinDist: number;
  /** Probability of dodging into the ball when a shot is on (evaluated once per approach). */
  dodgeProb: number;
  /** Probability of single-jumping for a bouncing ball (evaluated once per approach). */
  jumpProb: number;
  /** Aerials allowed. */
  aerials: boolean;
  /** Longest aerial it plans (s of flight). */
  aerialMaxT: number;
  /**
   * Constant acceleration an aerial may need (uu/s^2). Boost in the air gives ~1060, but the
   * take-off (the nose turning up) costs some: plans close to the limit fail half way.
   */
  aerialMaxAccel: number;
  /** Highest ball it goes up for (uu). */
  aerialMaxZ: number;
  /** Double jump on take-off for high balls. */
  aerialDoubleJump: boolean;
  /** How far ahead an aerial target must be: cosine of the angle off the car's nose. */
  aerialAheadCos: number;
  /** Steering noise amplitude (rad) added as a slow random walk. */
  steerNoise: number;
  /** Shot-aim noise (uu) applied sideways to the hit point as a slow random walk. */
  aimNoise: number;
  /** Shadow depth = clamp(ballToGoalDist * shadowFactor, 1000, shadowMax). */
  shadowFactor: number;
  shadowMax: number;
}

export const DIFFICULTY_PARAMS: Readonly<Record<Difficulty, DifficultyParams>> = {
  easy: {
    thinkEvery: 8,
    throttleMax: 0.8,
    useBoost: false,
    boostMinDist: 2000,
    dodgeProb: 0.15,
    jumpProb: 0.5,
    aerials: false,
    aerialMaxT: 1,
    aerialMaxAccel: 600,
    aerialMaxZ: 800,
    aerialDoubleJump: false,
    aerialAheadCos: 0.9,
    steerNoise: 0.1,
    aimNoise: 220,
    shadowFactor: 0.3,
    shadowMax: 2000,
  },
  medium: {
    thinkEvery: 6,
    throttleMax: 1,
    useBoost: true,
    boostMinDist: 1500,
    dodgeProb: 0.6,
    jumpProb: 0.8,
    aerials: true,
    aerialMaxT: 1.1,
    aerialMaxAccel: 780,
    aerialMaxZ: 950,
    aerialDoubleJump: false,
    aerialAheadCos: 0.85,
    steerNoise: 0.05,
    aimNoise: 90,
    shadowFactor: 0.35,
    shadowMax: 2000,
  },
  hard: {
    thinkEvery: 2,
    throttleMax: 1,
    useBoost: true,
    boostMinDist: 900,
    dodgeProb: 1,
    jumpProb: 1,
    aerials: true,
    aerialMaxT: 1.8,
    aerialMaxAccel: 900,
    aerialMaxZ: ARENA.height - 250,
    aerialDoubleJump: true,
    aerialAheadCos: 0.75,
    steerNoise: 0,
    aimNoise: 0,
    shadowFactor: 0.5,
    shadowMax: 3500,
  },
};

/** Distance from the car origin at which the hitbox front touches the ball centre (Standard). */
export const CONTACT_DIST = BALL.radius + CAR_STANDARD.hitboxSize[0] / 2 + CAR_STANDARD.hitboxOffset[0];

/** Global tunables (mutable on purpose so a debug panel can tweak them live). */
export const TUNING = {
  steerGain: 3.5,
  handbrakeAngle: 1.05, // rad (~60°)
  handbrakeMinSpeed: 600,
  reverseAngle: 2.1, // rad (~120°)
  reverseMaxDist: 600,
  boostAlignAngle: 0.26, // rad (~15°)
  boostMaxSpeed: 2250,
  boostSeekBelow: 30,
  groundMaxBallZ: 300,
  hitMargin: 25,
  goalAimClampX: ARENA.goalHalfWidth - 200,
  kickoffDodgeDist: 500,
  kickoffDodgeSpeed: 1800,
  dodgeBaseDist: 280,
  dodgeSpeedScale: 0.08,
  dodgeMaxDist: 480,
  dodgeAlign: 0.26,
  dodgeMaxBallZ: 200,
  jumpMinBallZ: 150,
  jumpMaxBallZ: 300,
  jumpDist: 400,
  aerialMinBallZ: 350,
  aerialMinT: 0.3,
  /** In flight (after aerialAbortAfter s), give up when the acceleration needed exceeds this. */
  aerialAbortAccel: 1250,
  aerialAbortAfter: 0.3,
  /** The car aims this far behind the ball on its push direction (its nose meets the ball there). */
  aerialHitOffset: CONTACT_DIST - 30,
  /** A double jump for a ball above this (difficulties with aerialDoubleJump). */
  aerialDoubleZ: 650,
  /**
   * Upward speed (uu/s) the jump hold adds on take-off (RocketSim's jump acceleration ~1458 uu/s^2):
   * a single jump is held aerialHoldSingle s, a double jump's first one aerialHoldDouble s.
   */
  aerialJumpHoldVel: 220,
  aerialJumpHoldVelDouble: 140,
  aerialHoldSingle: 0.18,
  aerialHoldDouble: 0.1,
  /** The last part of an aerial (s): the nose turns from the approach to the push direction. */
  aerialStrikeT: 0.15,
  /** Shots aim this far (uu) to the side away from the opponent nearest the ball. */
  shotAimAway: 300,
  aerialMinBoost: 25,
  aerialCooldownTicks: 90,
  modeMinTicks: 20,
  targetSmoothing: 0.35,
  targetSnapDist: 800,
  shadowMinDepth: 1000,
  shadowXClamp: 900,
  airKp: 3.0,
  airKd: 0.5,
  rollKp: 3.0,
  rollKd: 0.25,
  dodgeWaitTicks: 2,
  dodgeWaitMax: 8,
  goAroundEnter: -60,
  goAroundExit: -450,
  goAroundMaxDist: 1600,
  goAroundBack: 750,
  goAroundSide: 700,
  goAroundReachDist: 200, // the (clamped) go-around point reached: the go-around is over (corners squeeze it)
  // a slow ball right in front of us is driven THROUGH (target = the ball itself, no line-up
  // backoff, no reverse rule, dodge allowed): the hit point is deliberately short of contact and a
  // car that targets it from close by parks beside a resting ball, reversing every time it passes
  // the point (the 3v3 dead-ball deadlock)
  nearBallDist: 450,
  nearBallSpeed: 500, // ball ground speed (uu/s) below which it counts as slow
  nearBallStallTicks: 60, // within nearBallDist of a low ball this long without a touch -> drive at it
  // clears: a car this close to the ball that is not at least this far behind it on the clear line
  // goes around first (a contact from the goal side would push the ball at our own net)
  clearGoAroundAlong: -100,
  clearGoAroundDist: 600,
  fieldClampX: ARENA.extentX - 200,
  fieldClampY: ARENA.extentY - 170,
  cornerClampRadius: ARENA.cornerRadius - 350, // in a rounded corner, targets stay this close to the corner centre (1350 of 1700)
  // stall / unstick (nose wedged against a wall or the goal netting with the throttle held)
  stallSpeed: 150, // uu/s: slower than this with throttle held counts as stalled
  stallTicks: 30, // consecutive stalled ticks before the unstick phase
  unstickTicks: 45, // length of the unstick phase (reverse + opposite steer)
  stallMaxZ: 80, // car z below which a stall is a wedge (not a wall ride)
  // goal mouth: inside / at the posts of a goal, drive out through the mouth first
  goalMouthY: ARENA.extentY - 220, // |y| beyond this (5380) and goalMouthX < |x| < goalMouthXMax = at the posts
  goalMouthX: 700,
  goalMouthXMax: ARENA.goalHalfWidth + 500, // beyond this (1500) the back wall is just the back wall (the corner is not a goal mouth)
  goalMouthWaypointY: ARENA.extentY - 420, // waypoint (0, +-5180) in front of the goal
  // wall riding: 3+ wheels on a wall (|up.z| < wallUpZ) with the ball not playable from there
  wallUpZ: 0.6,
  wallBallDist: 700, // 3D ball distance beyond which the wall is left
  wallHighZ: 250, // ...or the car is this high on the wall while the ball is on the floor
  wallBallLowZ: 150,
  wallStallSpeed: 300, // slower than this on a wall for wallStallTicks -> jump off
  wallStallTicks: 60,
  wallJumpMaxVz: 200,
  // airborne (no wheel contact) but not moving: balanced on the nose / roof against another car or
  // a wall; the air controller's constant torque cannot break the wedge -> rock free
  airStuckSpeed: 80,
  airStuckTicks: 60,
  airStuckPhase: 20, // ticks per rocking phase (roll +, pitch/yaw, roll -, pitch/yaw)
  // ---- team roles (only used when a BotTeam assigns support / defender / kickoff duties) ----
  // SUPPORT: depth behind the ball on our side = clamp(ballToGoalDist * factor, min, max)
  supportDepthFactor: 0.45,
  supportDepthMin: 1800,
  supportDepthMax: 2400,
  supportSide: 900, // sideways offset from the ball (toward the field centre / away from the attacker)
  supportHoldDist: 300, // within this of the spot: stop and face the ball
  supportReboundDist: 1100, // a ball this close and coming at us is played even as support
  supportBoostBelow: 40,
  supportDefenderSep: 1400, // 3v3: the support spot keeps this far from the goalie spot (slides to the far post)
  supportSideFactor: 0.45, // wall balls: the side offset grows to |ball.x| * factor (stay out of the corner lane)
  // 3v3 with the ball deep in our half (goalie clearing): support / shadowing attacker wait at the top of the box
  boxDeepGoalDist: 2600, // ball within this of our goal centre...
  boxDeepY: 2200, // ...or within this of our goal line (the whole back strip, corners included)
  boxX: 1300,
  boxDepth: 2800,
  // a car playing the ball this close to it does not yield to a positioning teammate
  playingBallDist: 1200,
  // DEFENDER: depth in front of our goal line = clamp(ballToGoalDist * factor, min, max)
  defenderDepthFactor: 0.25,
  defenderDepthMin: 800,
  defenderDepthMax: 1500,
  defenderXFactor: 0.6, // x = ball.x * factor, clamped
  defenderXClamp: 1100,
  defenderHoldDist: 250,
  defenderComeOutY: ARENA.extentY / 3, // "our third": ball.y * goalDir beyond this
  defenderComeOutGoalDist: 1800, // ...or the ball this close to our goal regardless of the attacker
  defenderBoostBelow: 40,
  defenderBoostBallDist: 4500, // only wander for boost while the ball is at least this far from our goal
  // KICKOFF duties
  kickoffCheatX: 700,
  kickoffCheatY: 1300, // our side of midfield
  kickoffCheatHold: 350,
  // positioning modes slow down near the spot instead of overshooting it
  arriveSlowDist: 700,
  arriveStopDist: 200,
  // never double-commit: a non-attacker keeps its target out of the attacker -> ball lane
  laneHalfWidth: 450,
  laneMargin: 200,
  laneExtend: 600, // lane continues this far past the ball
  // two teammates within BotTeam's yield distance: the lower-ranked one brakes / steers away
  yieldBrakeSpeed: 300,
  // bump / demo avoidance: an opponent this close, this fast and closing this quickly -> hop
  demoDodgeDist: 650,
  demoDodgeSpeed: 2000,
  demoDodgeClosing: 1500,
};

/** Module-level scratch for the pure helpers (single-threaded, never retained). */
const _reach = new Float32Array(BALL_PRED_TICKS);
const _dir = vec3();
const _tmp = vec3();

// ---- pure helpers -------------------------------------------------------------------------

/**
 * Ticks elapsed since the ball prediction buffer was refreshed. The game refreshes it every few
 * ticks, and entry t holds the ball state t+1 ticks after the REFRESH tick (types.ts), so a
 * consumer that wants the state n ticks from now must read entry n - 1 + age. Views without a
 * predTick (hand-built test states) are treated as fresh.
 */
export function predAge(state: SimStateView): number {
  const pt = state.predTick;
  if (pt === undefined) return 0;
  const age = state.tickCount - pt;
  return age > 0 ? age : 0;
}

/**
 * Predicted ball state `tSeconds` ahead, written to `out` as [x,y,z,vx,vy,vz]. t <= 0 returns the
 * current ball state; t beyond the prediction horizon returns the last entry.
 */
export function predictBallAt(state: SimStateView, tSeconds: number, out: Float32Array): Float32Array {
  const idx = Math.round(tSeconds * TICK_RATE) - 1;
  if (idx < 0) {
    const b = state.buf;
    out[0] = b[BALL_OFFSET + B_POS];
    out[1] = b[BALL_OFFSET + B_POS + 1];
    out[2] = b[BALL_OFFSET + B_POS + 2];
    out[3] = b[BALL_OFFSET + B_VEL];
    out[4] = b[BALL_OFFSET + B_VEL + 1];
    out[5] = b[BALL_OFFSET + B_VEL + 2];
    return out;
  }
  const aged = idx + predAge(state);
  const i = (aged >= BALL_PRED_TICKS ? BALL_PRED_TICKS - 1 : aged) * BALL_PRED_STRIDE;
  const p = state.ballPred;
  out[0] = p[i];
  out[1] = p[i + 1];
  out[2] = p[i + 2];
  out[3] = p[i + 3];
  out[4] = p[i + 4];
  out[5] = p[i + 5];
  return out;
}

/**
 * Intercept search over the ball prediction. Returns the earliest time (s) at which a car at
 * `carPos` (velocity `carVel`, forward axis `carFwd`, `boost` units) can be at the predicted ball
 * ground position, considering acceleration, boost and a turning penalty; -1 when nothing within
 * the horizon is reachable. Entries with ball z > `maxZ` (airborne ball) are skipped, so for a high
 * ball the result is naturally its landing approach. `out` receives [x,y,z,vx,vy,vz] of the chosen
 * entry (or the current ball state when none is reachable).
 */
export function firstReachable(
  state: SimStateView,
  carPos: Vec3,
  carVel: Vec3,
  carFwd: Vec3,
  boost: number,
  out: Float32Array,
  maxZ = TUNING.groundMaxBallZ,
  step = 2,
  phys: BotPhysics = STOCK_BOT_PHYSICS,
): number {
  const pred = state.ballPred;
  const n = BALL_PRED_TICKS;
  const dt = TICK_DT * step;

  // 1) reachable straight-line distance per prediction entry (monotonic in time)
  let v = carFwd[0] * carVel[0] + carFwd[1] * carVel[1];
  if (v < 0) v = 0;
  let b = boost;
  let d = 0;
  for (let i = 0; i < n; i += step) {
    const boosting = b > 0;
    const vmax = boosting ? phys.maxBoostSpeed : MAX_DRIVE_SPEED;
    v += groundAccel(v, boosting, phys.boostAccelGround) * dt;
    if (v > vmax) v = Math.max(vmax, v - 200 * dt);
    d += v * dt;
    if (boosting) b -= phys.boostPerSecond * dt;
    _reach[i] = d;
  }

  // 2) earliest entry whose required path length fits in the reachable distance
  const speed2D = Math.sqrt(carVel[0] * carVel[0] + carVel[1] * carVel[1]);
  const rTurn = turnRadius(clamp(speed2D, 400, 1400));
  const fx = carFwd[0];
  const fy = carFwd[1];
  const fl = Math.sqrt(fx * fx + fy * fy);
  const nfx = fl > 1e-6 ? fx / fl : 1;
  const nfy = fl > 1e-6 ? fy / fl : 0;
  const yLimit = ARENA.extentY - 100;
  // Entry i + age is the ball state (i + 1) ticks from now (the buffer is `age` ticks old).
  const age = predAge(state);
  for (let i = 0; i + age < n; i += step) {
    const o = (i + age) * BALL_PRED_STRIDE;
    const pz = pred[o + 2];
    if (pz > maxZ) continue;
    const px = pred[o];
    const py = pred[o + 1];
    if (py > yLimit || py < -yLimit) continue; // inside a goal: nothing to do
    const dx = px - carPos[0];
    const dy = py - carPos[1];
    const dist = Math.sqrt(dx * dx + dy * dy);
    let penalty = 0;
    if (dist > 1e-3) {
      const cosA = clamp((dx * nfx + dy * nfy) / dist, -1, 1);
      const ang = Math.acos(cosA);
      if (ang > 0.2) penalty = Math.min(ang * rTurn, 2500);
    }
    const need = Math.max(0, dist - CONTACT_DIST) + penalty;
    if (_reach[i] >= need) {
      out[0] = px;
      out[1] = py;
      out[2] = pz;
      out[3] = pred[o + 3];
      out[4] = pred[o + 4];
      out[5] = pred[o + 5];
      return (i + 1) * TICK_DT;
    }
  }
  predictBallAt(state, 0, out);
  return -1;
}

/** Steering value (clamped) that turns the car at `from` (basis `fwd`/`right`) toward point `to`. */
export function steerToward(fwd: Vec3, right: Vec3, from: Vec3, to: Vec3, gain = TUNING.steerGain): number {
  return clamp1(gain * angleToPoint2D(fwd, right, from, to));
}

/**
 * Shot geometry: the point the car should drive through so that its hit sends the ball toward
 * `goalTarget`. Writes the ground-plane shot direction to `outDir` and the hit point to `outHit`.
 */
export function shotHitPoint(ballPos: Vec3, goalTarget: Vec3, outHit: Vec3, outDir: Vec3, offset = CONTACT_DIST + TUNING.hitMargin): Vec3 {
  v3sub(_tmp, goalTarget, ballPos);
  if (v3normalize2D(outDir, _tmp) === 0) v3set(outDir, 0, 1, 0);
  outHit[0] = ballPos[0] - outDir[0] * offset;
  outHit[1] = ballPos[1] - outDir[1] * offset;
  outHit[2] = ballPos[2];
  return outHit;
}

/**
 * PD attitude controller for airborne cars: pitch/yaw so the nose points along `dir`, roll so the
 * roof points to world +z. Angular-rate damping uses the kinematic relations dFwd/dt = ω × fwd and
 * dUp/dt = ω × up, so no handedness assumptions are needed.
 */
export function aimInAir(fwd: Vec3, right: Vec3, up: Vec3, angVel: Vec3, dir: Vec3, out: CarControls): void {
  const f = v3dot(dir, fwd);
  const r = v3dot(dir, right);
  const u = v3dot(dir, up);
  const pitchErr = Math.atan2(u, f);
  const yawErr = Math.atan2(r, f);
  const rollErr = Math.atan2(right[2], up[2]);
  v3cross(_tmp, angVel, fwd);
  const pitchRate = v3dot(_tmp, up);
  const yawRate = v3dot(_tmp, right);
  v3cross(_tmp, angVel, up);
  const rollRate = v3dot(_tmp, right);
  out.pitch = clamp1(TUNING.airKp * pitchErr - TUNING.airKd * pitchRate);
  out.yaw = clamp1(TUNING.airKp * yawErr - TUNING.airKd * yawRate);
  out.roll = clamp1(TUNING.rollKp * rollErr - TUNING.rollKd * rollRate);
}

export function neutralControls(out: CarControls): void {
  out.throttle = 0;
  out.steer = 0;
  out.pitch = 0;
  out.yaw = 0;
  out.roll = 0;
  out.jump = false;
  out.boost = false;
  out.handbrake = false;
}

function finite(x: number): number {
  return Number.isFinite(x) ? x : 0;
}

// ---- team context -------------------------------------------------------------------------

// Index tables for the save / load of the string-typed fields (saveState / loadState).
export const BOT_MODES: readonly BotMode[] = ['kickoff', 'attack', 'defend', 'support', 'boost', 'recover', 'aerial'];
export const ROLES: readonly BotRole[] = ['attacker', 'support', 'defender'];
export const DUTIES: readonly KickoffDuty[] = ['go', 'cheat', 'stay'];
const SEQS: readonly JumpSeq[] = ['none', 'jump', 'wait', 'flip', 'air'];

function v3save(out: Float64Array, o: number, v: Vec3): number {
  out[o] = v[0];
  out[o + 1] = v[1];
  out[o + 2] = v[2];
  return o + 3;
}

function v3load(src: Float64Array, o: number, v: Vec3): number {
  v[0] = src[o];
  v[1] = src[o + 1];
  v[2] = src[o + 2];
  return o + 3;
}

/**
 * Per-tick team information a BotTeam writes into a Bot before think(). Owned by the Bot (all
 * vectors preallocated); a standalone Bot keeps the defaults, which are exactly the 1v1 behaviour
 * (attacker, kickoff 'go', no teammates).
 */
export class TeamContext {
  role: BotRole = 'attacker';
  kickoff: KickoffDuty = 'go';
  /** Another teammate holds the attacker role (false for the attacker itself and for solo bots). */
  hasAttacker = false;
  /** A live teammate holds the defender role (3v3): the support keeps clear of the goalie spot. */
  hasDefender = false;
  readonly attackerPos = vec3();
  attackerBallDist = Infinity;
  /** The attacker cannot get to the ball first (no intercept, or an opponent clearly closer). */
  attackerBeaten = false;
  /** A higher-ranked teammate is within the yield distance: brake / steer away from `yieldPos`. */
  yield = false;
  readonly yieldPos = vec3();
  /**
   * Intercept estimate the team already computed for this tick from the same state (saves the
   * bot its own firstReachable on decision ticks). Consumed (cleared) by the bot.
   */
  interceptFresh = false;
  interceptT = -1;
  readonly interceptPred = new Float32Array(BALL_PRED_STRIDE);

  /** Floats saveState writes. */
  static readonly STATE_FLOATS = 15 + BALL_PRED_STRIDE;

  /** Write the context as STATE_FLOATS numbers at out[off..]; returns the next offset. */
  saveState(out: Float64Array, off: number): number {
    let o = off;
    out[o++] = ROLES.indexOf(this.role);
    out[o++] = DUTIES.indexOf(this.kickoff);
    out[o++] = this.hasAttacker ? 1 : 0;
    out[o++] = this.hasDefender ? 1 : 0;
    out[o++] = this.attackerPos[0];
    out[o++] = this.attackerPos[1];
    out[o++] = this.attackerPos[2];
    out[o++] = this.attackerBallDist;
    out[o++] = this.attackerBeaten ? 1 : 0;
    out[o++] = this.yield ? 1 : 0;
    out[o++] = this.yieldPos[0];
    out[o++] = this.yieldPos[1];
    out[o++] = this.yieldPos[2];
    out[o++] = this.interceptFresh ? 1 : 0;
    out[o++] = this.interceptT;
    for (let i = 0; i < BALL_PRED_STRIDE; i++) out[o++] = this.interceptPred[i];
    return o;
  }

  /** Restore what saveState wrote at src[off..]; returns the next offset. */
  loadState(src: Float64Array, off: number): number {
    let o = off;
    this.role = ROLES[src[o++]] ?? 'attacker';
    this.kickoff = DUTIES[src[o++]] ?? 'go';
    this.hasAttacker = src[o++] !== 0;
    this.hasDefender = src[o++] !== 0;
    this.attackerPos[0] = src[o++];
    this.attackerPos[1] = src[o++];
    this.attackerPos[2] = src[o++];
    this.attackerBallDist = src[o++];
    this.attackerBeaten = src[o++] !== 0;
    this.yield = src[o++] !== 0;
    this.yieldPos[0] = src[o++];
    this.yieldPos[1] = src[o++];
    this.yieldPos[2] = src[o++];
    this.interceptFresh = src[o++] !== 0;
    this.interceptT = src[o++];
    for (let i = 0; i < BALL_PRED_STRIDE; i++) this.interceptPred[i] = src[o++];
    return o;
  }

  reset(): void {
    this.role = 'attacker';
    this.kickoff = 'go';
    this.hasAttacker = false;
    this.hasDefender = false;
    v3set(this.attackerPos, 0, 0, 0);
    this.attackerBallDist = Infinity;
    this.attackerBeaten = false;
    this.yield = false;
    v3set(this.yieldPos, 0, 0, 0);
    this.interceptFresh = false;
    this.interceptT = -1;
  }
}

// ---- the bot ------------------------------------------------------------------------------

export class Bot {
  readonly team: Team;
  private params: DifficultyParams;
  private difficultyName: Difficulty;
  private readonly rng: Rng;

  /** Current high-level mode (read-only for HUD/debug). */
  mode: BotMode = 'attack';
  /** Current driving target in uu (read-only for debug drawing). */
  readonly target: Vec3 = vec3();
  /** Time (s) until the targeted ball event, -1 when the target is not time-bound. */
  targetT = -1;
  /** Team role / kickoff duty / teammate info, written by a BotTeam before each think(). */
  readonly teamCtx = new TeamContext();

  private tick = 0;
  private modeTicks = 0;
  private goalDir = -1; // own goal is at y = goalDir * ARENA.extentY
  private lastRole: BotRole = 'attacker';
  private lastDuty: KickoffDuty = 'go';

  // jump / dodge sequence
  private seq: JumpSeq = 'none';
  private seqTick = 0;
  private seqHold = 0;
  private seqDodge = false;
  private flipPitch = 0;
  private flipYaw = 0;
  private dodgeRolled = false;
  private dodgeAllowed = false;
  private jumpRolled = false;
  private jumpAllowed = false;

  // aerial
  private aerialT = 0;
  private aerialStartTick = 0;
  private aerialCooldown = 0;
  /** This aerial double-jumps on take-off. */
  private aerialDouble = false;
  /** This aerial is a save / clear (push away from our goal) rather than a shot (toward goalT). */
  private aerialDefensive = false;

  // play state
  private boostPad = -1;
  private goingAround = false;
  private shotOn = false;
  /** Driving through a slow ball right in front of us (approachTarget / ballStalled): no reverse rule. */
  private nearBall = false;
  /** Ticks spent within nearBallDist of a low ball without this car touching it (readState). */
  private nearBallTicks = 0;
  private lastHitTick = -2;
  private holdPosition = false;
  private stopAtTarget = false;
  private clearing = false;
  private interceptT = -1;
  private aimErr = 0;
  private steerErr = 0;

  // held driving outputs between decisions
  private hThrottle = 0;
  private hSteer = 0;
  private hBoost = false;
  private hHandbrake = false;

  // stall / unstick (see detectStall)
  private stallTicks = 0;
  private unstickTicks = 0;
  private unstickThrottle = -1;
  private unstickSteer = 1;
  // wall riding (see wallRecovery)
  private onWall = false;
  private wallSlowTicks = 0;
  // airborne without moving (see airStuckControl)
  private airStuckTicks = 0;
  // latched while driving out of a goal mouth (set by inGoalMouth, cleared past the waypoint)
  private goalEscape = false;

  // per-tick derived car state
  private speed = 0;
  private fwdSpeed = 0;
  private onGround = false;
  private boostAmt = 0;
  private hasOpp = false;
  private isFlipping = false;
  private hasJumped = false;
  private hasFlipped = false;
  private hasDoubleJumped = false;
  private myBallDist = 0;
  private ballClosing = 0; // closing speed between us and the ball (uu/s, + = approaching)
  private oppBallDist = 0; // nearest opponent to the ball
  private oppNearDist = Infinity; // nearest opponent to us
  // attacker lane test results (see laneTest)
  private laneDx = 0;
  private laneDy = 0;
  private laneLen = 0;
  private laneAlong = 0;
  private laneLateral = 0;

  // scratch vectors
  private readonly carPos = vec3();
  private readonly carVel = vec3();
  private readonly carFwd = vec3();
  private readonly carRight = vec3();
  private readonly carUp = vec3();
  private readonly carAng = vec3();
  private readonly ballPos = vec3();
  private readonly ballVel = vec3();
  private readonly oppPos = vec3();
  private readonly oppVel = vec3();
  private readonly oppNearPos = vec3();
  private readonly oppNearVel = vec3();
  private readonly rawTarget = vec3();
  private readonly spot = vec3(); // role positioning spot (support / defender)
  private readonly bp = vec3(); // ball position at the targeted event
  private readonly hit = vec3();
  private readonly goalT = vec3();
  private readonly shotDir = vec3();
  private readonly perp = vec3();
  private readonly aim = vec3();
  private readonly delta = vec3();
  private readonly tmpA = vec3();
  private readonly tmpB = vec3();
  private readonly pred = new Float32Array(BALL_PRED_STRIDE);

  /** The physics this bot plans with (constant for its life, the same for every bot of a match). */
  private readonly phys: BotPhysics;
  /** 0.5 * gravity (the aerial reach model). */
  private readonly gravHalf: number;
  /** Velocity a double-jump take-off adds: first jump + double jump. */
  private readonly doubleJumpVel: number;

  constructor(opts: BotOptions) {
    this.team = opts.team;
    this.goalDir = opts.team === Team.Red ? 1 : -1;
    this.difficultyName = opts.difficulty ?? 'hard';
    this.params = DIFFICULTY_PARAMS[this.difficultyName];
    this.rng = new Rng(opts.seed ?? 12345);
    this.phys = opts.physics ?? STOCK_BOT_PHYSICS;
    this.gravHalf = 0.5 * this.phys.gravity;
    // Stock: JUMP_IMPULSE + JUMP_IMPULSE, exactly the former 2 * JUMP_IMPULSE (x + x == 2x in IEEE).
    this.doubleJumpVel = this.phys.jumpImpulse + this.phys.doubleJumpImpulse;
  }

  /** The physics profile this bot plans with. */
  get physics(): BotPhysics {
    return this.phys;
  }

  get difficulty(): Difficulty {
    return this.difficultyName;
  }

  setDifficulty(d: Difficulty): void {
    this.difficultyName = d;
    this.params = DIFFICULTY_PARAMS[d];
  }

  /** Current team role (from teamCtx; 'attacker' for a standalone bot). */
  get role(): BotRole {
    return this.teamCtx.role;
  }

  /** Forget all transient state (call on kickoff reset / car respawn if desired). */
  reset(): void {
    this.mode = 'attack';
    this.modeTicks = 0;
    this.seq = 'none';
    this.seqTick = 0;
    this.boostPad = -1;
    this.goingAround = false;
    this.aerialCooldown = 0;
    this.interceptT = -1;
    this.targetT = -1;
    this.stallTicks = 0;
    this.unstickTicks = 0;
    this.wallSlowTicks = 0;
    this.airStuckTicks = 0;
    this.goalEscape = false;
    this.holdPosition = false;
    this.stopAtTarget = false;
    this.nearBall = false;
    this.nearBallTicks = 0;
    this.lastHitTick = -2;
  }

  /** Floats saveState writes (the bot's own memory plus its TeamContext). */
  static readonly STATE_FLOATS = 46 + 33 + TeamContext.STATE_FLOATS;

  /**
   * Write everything that persists between think() calls (mode, timers, jump sequence, held
   * outputs, noise filters, the RNG, the smoothed target, the team context) as STATE_FLOATS
   * numbers at out[off..]; returns the next offset. The per-tick derived car state (readState) is
   * not included: think() recomputes it. Allocation-free. Used by the P2P rollback checkpoints.
   */
  saveState(out: Float64Array, off: number): number {
    let o = off;
    out[o++] = this.tick;
    out[o++] = this.modeTicks;
    out[o++] = BOT_MODES.indexOf(this.mode);
    out[o++] = ROLES.indexOf(this.lastRole);
    out[o++] = DUTIES.indexOf(this.lastDuty);
    out[o++] = this.goalDir;
    out[o++] = SEQS.indexOf(this.seq);
    out[o++] = this.seqTick;
    out[o++] = this.seqHold;
    out[o++] = this.seqDodge ? 1 : 0;
    out[o++] = this.flipPitch;
    out[o++] = this.flipYaw;
    out[o++] = this.dodgeRolled ? 1 : 0;
    out[o++] = this.dodgeAllowed ? 1 : 0;
    out[o++] = this.jumpRolled ? 1 : 0;
    out[o++] = this.jumpAllowed ? 1 : 0;
    out[o++] = this.aerialT;
    out[o++] = this.aerialStartTick;
    out[o++] = this.aerialCooldown;
    out[o++] = this.aerialDouble ? 1 : 0;
    out[o++] = this.aerialDefensive ? 1 : 0;
    out[o++] = this.boostPad;
    out[o++] = this.goingAround ? 1 : 0;
    out[o++] = this.shotOn ? 1 : 0;
    out[o++] = this.nearBall ? 1 : 0;
    out[o++] = this.nearBallTicks;
    out[o++] = this.lastHitTick;
    out[o++] = this.holdPosition ? 1 : 0;
    out[o++] = this.stopAtTarget ? 1 : 0;
    out[o++] = this.clearing ? 1 : 0;
    out[o++] = this.interceptT;
    out[o++] = this.aimErr;
    out[o++] = this.steerErr;
    out[o++] = this.hThrottle;
    out[o++] = this.hSteer;
    out[o++] = this.hBoost ? 1 : 0;
    out[o++] = this.hHandbrake ? 1 : 0;
    out[o++] = this.stallTicks;
    out[o++] = this.unstickTicks;
    out[o++] = this.unstickThrottle;
    out[o++] = this.unstickSteer;
    out[o++] = this.wallSlowTicks;
    out[o++] = this.airStuckTicks;
    out[o++] = this.goalEscape ? 1 : 0;
    out[o++] = this.targetT;
    out[o++] = this.rng.state;
    o = v3save(out, o, this.target);
    for (let i = 0; i < BALL_PRED_STRIDE; i++) out[o++] = this.pred[i];
    o = v3save(out, o, this.bp);
    o = v3save(out, o, this.spot);
    o = v3save(out, o, this.rawTarget);
    o = v3save(out, o, this.hit);
    o = v3save(out, o, this.shotDir);
    o = v3save(out, o, this.goalT);
    o = v3save(out, o, this.perp);
    o = v3save(out, o, this.aim);
    return this.teamCtx.saveState(out, o);
  }

  /** Restore what saveState wrote at src[off..]; returns the next offset. */
  loadState(src: Float64Array, off: number): number {
    let o = off;
    this.tick = src[o++];
    this.modeTicks = src[o++];
    this.mode = BOT_MODES[src[o++]] ?? 'attack';
    this.lastRole = ROLES[src[o++]] ?? 'attacker';
    this.lastDuty = DUTIES[src[o++]] ?? 'go';
    this.goalDir = src[o++];
    this.seq = SEQS[src[o++]] ?? 'none';
    this.seqTick = src[o++];
    this.seqHold = src[o++];
    this.seqDodge = src[o++] !== 0;
    this.flipPitch = src[o++];
    this.flipYaw = src[o++];
    this.dodgeRolled = src[o++] !== 0;
    this.dodgeAllowed = src[o++] !== 0;
    this.jumpRolled = src[o++] !== 0;
    this.jumpAllowed = src[o++] !== 0;
    this.aerialT = src[o++];
    this.aerialStartTick = src[o++];
    this.aerialCooldown = src[o++];
    this.aerialDouble = src[o++] !== 0;
    this.aerialDefensive = src[o++] !== 0;
    this.boostPad = src[o++];
    this.goingAround = src[o++] !== 0;
    this.shotOn = src[o++] !== 0;
    this.nearBall = src[o++] !== 0;
    this.nearBallTicks = src[o++];
    this.lastHitTick = src[o++];
    this.holdPosition = src[o++] !== 0;
    this.stopAtTarget = src[o++] !== 0;
    this.clearing = src[o++] !== 0;
    this.interceptT = src[o++];
    this.aimErr = src[o++];
    this.steerErr = src[o++];
    this.hThrottle = src[o++];
    this.hSteer = src[o++];
    this.hBoost = src[o++] !== 0;
    this.hHandbrake = src[o++] !== 0;
    this.stallTicks = src[o++];
    this.unstickTicks = src[o++];
    this.unstickThrottle = src[o++];
    this.unstickSteer = src[o++];
    this.wallSlowTicks = src[o++];
    this.airStuckTicks = src[o++];
    this.goalEscape = src[o++] !== 0;
    this.targetT = src[o++];
    this.rng.state = src[o++];
    o = v3load(src, o, this.target);
    for (let i = 0; i < BALL_PRED_STRIDE; i++) this.pred[i] = src[o++];
    o = v3load(src, o, this.bp);
    o = v3load(src, o, this.spot);
    o = v3load(src, o, this.rawTarget);
    o = v3load(src, o, this.hit);
    o = v3load(src, o, this.shotDir);
    o = v3load(src, o, this.goalT);
    o = v3load(src, o, this.perp);
    o = v3load(src, o, this.aim);
    return this.teamCtx.loadState(src, o);
  }

  /** Near a low ball for nearBallStallTicks without touching it: the approach is dithering. */
  get ballStalled(): boolean {
    return this.nearBallTicks >= TUNING.nearBallStallTicks;
  }

  /**
   * Produce controls for the car in `mySlot` (team read from the state, falling back to the
   * constructor team). Call every tick; writes into `out`. Every car in the state is considered:
   * the nearest opponent (to the ball / to us) for decisions and bump avoidance, teammates
   * through `teamCtx`. `opponentSlot` is kept for backward compatibility: -1 (or any value) means
   * "all other cars"; it is only used as the opponent when the state reports no cars at all.
   */
  think(state: SimStateView, mySlot: number, opponentSlot: number, out: CarControls): void {
    this.tick++;
    neutralControls(out);
    if (mySlot < 0 || (state.numCars > 0 && mySlot >= state.numCars)) return;

    this.readState(state, mySlot, opponentSlot);
    const buf = state.buf;
    const co = state.carOffset(mySlot);
    if (buf[co + C_IS_DEMOED] > 0.5) {
      this.seq = 'none';
      this.teamCtx.interceptFresh = false;
      return;
    }

    if (this.aerialCooldown > 0) this.aerialCooldown--;

    // Reflex layer: an in-flight jump/dodge sequence owns jump/pitch/yaw this tick.
    if (this.seq !== 'none') this.runJumpSeq(out);

    const p = this.params;
    const ctx = this.teamCtx;
    const roleChanged = ctx.role !== this.lastRole || ctx.kickoff !== this.lastDuty;
    const decide = this.seq === 'none' && (this.tick % p.thinkEvery === 0 || this.modeTicks === 0 || roleChanged);
    if (decide) this.decide(state);
    this.lastRole = ctx.role;
    this.lastDuty = ctx.kickoff;
    ctx.interceptFresh = false;
    this.modeTicks++;

    switch (this.mode) {
      case 'aerial':
        this.aerialControl(state, out);
        break;
      case 'recover':
        // A car wedged nose-up on a goal post flickers isOnGround and lands here every other tick;
        // the stall detector still counts and the unstick phase applies on the grounded ticks.
        this.detectStall();
        if (this.unstickTicks > 0 && this.onGround) this.unstickControl(out);
        else this.recoverControl(out);
        break;
      default: {
        if (decide) this.computeDriving();
        this.detectStall();
        if (this.onWall && this.seq === 'none' && this.wallRecovery(out)) break;
        if (this.unstickTicks > 0 && this.onGround && this.seq === 'none') {
          this.unstickControl(out);
          break;
        }
        if (ctx.yield && this.onGround && this.seq === 'none' && !this.playingBall()) {
          this.yieldControl(out);
          break;
        }
        out.throttle = this.hThrottle;
        out.steer = this.hSteer;
        // held boost only applies on the ground (kickoff speed-flips keep boosting through the dodge)
        out.boost = this.hBoost && (this.onGround || this.mode === 'kickoff');
        out.handbrake = this.hHandbrake && this.onGround;
        if (this.seq === 'none' && this.onGround) this.checkJumpTriggers(out);
        else if (!this.onGround && this.seq === 'none') this.recoverControl(out);
        break;
      }
    }

    if (this.isFlipping) {
      // never feed pitch during a flip (same-sign pitch cancels it)
      out.pitch = 0;
      out.yaw = 0;
      out.roll = 0;
    }
    // Last reflex: wedged in the air (balanced on the nose against another car after a head-on
    // kickoff flip, on the roof against a wall): no sequence or mode can end while the car never
    // lands, so this runs whatever the mode says.
    if (!this.onGround && !this.isFlipping && this.speed < TUNING.airStuckSpeed) this.airStuckTicks++;
    else this.airStuckTicks = 0;
    if (this.airStuckTicks > TUNING.airStuckTicks) this.airStuckControl(out);

    out.throttle = finite(clamp1(out.throttle));
    out.steer = finite(clamp1(out.steer));
    out.pitch = finite(clamp1(out.pitch));
    out.yaw = finite(clamp1(out.yaw));
    out.roll = finite(clamp1(out.roll));
    out.jump = !!out.jump;
    out.boost = !!out.boost && this.boostAmt > 0;
    out.handbrake = !!out.handbrake;
  }

  // ---- state ------------------------------------------------------------------------------

  private readState(state: SimStateView, mySlot: number, opponentSlot: number): void {
    const buf = state.buf;
    const co = state.carOffset(mySlot);
    const teamVal = buf[co + C_TEAM];
    this.goalDir = teamVal === 1 ? 1 : teamVal === 0 ? -1 : this.team === Team.Red ? 1 : -1;

    v3read(this.carPos, buf, co + C_POS);
    v3read(this.carFwd, buf, co + C_ROT);
    v3read(this.carRight, buf, co + C_ROT + 3);
    v3read(this.carUp, buf, co + C_ROT + 6);
    if (v3len2(this.carFwd) < 0.5) {
      // uninitialised rotation (e.g. a blank test buffer): assume facing +y, upright
      v3set(this.carFwd, 0, 1, 0);
      v3set(this.carRight, 1, 0, 0);
      v3set(this.carUp, 0, 0, 1);
    }
    v3read(this.carVel, buf, co + C_VEL);
    v3read(this.carAng, buf, co + C_ANG_VEL);
    this.speed = v3len(this.carVel);
    this.fwdSpeed = v3dot(this.carVel, this.carFwd);
    this.onGround = buf[co + C_IS_ON_GROUND] > 0.5;
    // RocketSim isOnGround = "3+ wheels in contact" on ANY surface; on a wall up.z is ~0.
    this.onWall = this.onGround && Math.abs(this.carUp[2]) < TUNING.wallUpZ;
    this.boostAmt = buf[co + C_BOOST];
    this.isFlipping = buf[co + C_IS_FLIPPING] > 0.5;
    this.hasJumped = buf[co + C_HAS_JUMPED] > 0.5;
    this.hasFlipped = buf[co + C_HAS_FLIPPED] > 0.5;
    this.hasDoubleJumped = buf[co + C_HAS_DOUBLE_JUMPED] > 0.5;

    v3read(this.ballPos, buf, BALL_OFFSET + B_POS);
    v3read(this.ballVel, buf, BALL_OFFSET + B_VEL);
    this.myBallDist = v3dist2D(this.carPos, this.ballPos);
    v3sub(this.tmpA, this.ballPos, this.carPos);
    v3normalize2D(this.tmpB, this.tmpA);
    v3sub(this.tmpA, this.carVel, this.ballVel);
    this.ballClosing = v3dot2D(this.tmpA, this.tmpB);
    // Near-ball stall counter: ticks within nearBallDist of a low ball since our last touch of it
    // (C_BALL_HIT_TICK changes on every touch). Cleared by a touch or by leaving the radius.
    const hitTick = buf[co + C_BALL_HIT_TICK];
    if (hitTick !== this.lastHitTick) {
      this.lastHitTick = hitTick;
      this.nearBallTicks = 0;
    } else if (this.myBallDist < TUNING.nearBallDist && this.ballPos[2] < TUNING.groundMaxBallZ) {
      this.nearBallTicks++;
    } else {
      this.nearBallTicks = 0;
    }

    // Every other car: the nearest live opponent to the ball drives the decisions, the nearest
    // one to us the bump avoidance. Teammates are handled by the BotTeam through teamCtx.
    this.hasOpp = false;
    this.oppBallDist = Infinity;
    this.oppNearDist = Infinity;
    const n = state.numCars;
    if (n > 0) {
      const myTeam = teamVal === 1 ? 1 : 0;
      for (let s = 0; s < n; s++) {
        if (s === mySlot) continue;
        const so = state.carOffset(s);
        if ((buf[so + C_TEAM] === 1 ? 1 : 0) === myTeam) continue;
        this.considerOpponent(buf, so);
      }
    } else if (opponentSlot >= 0 && opponentSlot !== mySlot) {
      // state without a car count (hand-built buffers): trust the caller's opponent slot
      this.considerOpponent(buf, state.carOffset(opponentSlot));
    }
  }

  private considerOpponent(buf: Float32Array, so: number): void {
    if (buf[so + C_IS_DEMOED] > 0.5) return;
    const px = buf[so + C_POS];
    const py = buf[so + C_POS + 1];
    const dBall = dist2D(px, py, this.ballPos[0], this.ballPos[1]);
    if (dBall < this.oppBallDist) {
      this.oppBallDist = dBall;
      this.hasOpp = true;
      v3read(this.oppPos, buf, so + C_POS);
      v3read(this.oppVel, buf, so + C_VEL);
    }
    const dMe = dist2D(px, py, this.carPos[0], this.carPos[1]);
    if (dMe < this.oppNearDist) {
      this.oppNearDist = dMe;
      v3read(this.oppNearPos, buf, so + C_POS);
      v3read(this.oppNearVel, buf, so + C_VEL);
    }
  }

  // ---- decisions --------------------------------------------------------------------------

  private decide(state: SimStateView): void {
    const p = this.params;
    const ctx = this.teamCtx;
    // intercept estimate (ground play); bp = where we expect to meet the ball
    if (ctx.interceptFresh) {
      this.interceptT = ctx.interceptT;
      this.pred.set(ctx.interceptPred);
    } else {
      this.interceptT = firstReachable(state, this.carPos, this.carVel, this.carFwd, this.boostAmt, this.pred, TUNING.groundMaxBallZ, 2, this.phys);
    }
    v3read(this.bp, this.pred, 0);

    // slow-varying noise for the lower difficulties
    if (p.steerNoise > 0) this.steerErr = this.steerErr * 0.8 + this.rng.range(-1, 1) * p.steerNoise * 0.5;
    else this.steerErr = 0;
    if (p.aimNoise > 0) this.aimErr = this.aimErr * 0.9 + this.rng.range(-1, 1) * p.aimNoise * 0.3;
    else this.aimErr = 0;

    const roleChanged = ctx.role !== this.lastRole || ctx.kickoff !== this.lastDuty;
    const desired = this.chooseMode(state);
    if (desired !== this.mode) {
      const from = this.mode;
      const urgent =
        roleChanged ||
        desired === 'kickoff' ||
        desired === 'recover' ||
        desired === 'aerial' ||
        from === 'kickoff' ||
        from === 'recover' ||
        from === 'aerial' ||
        (desired === 'defend' && this.ballThreatFast()) ||
        (desired === 'attack' && ctx.role !== 'attacker' && this.myBallDist < TUNING.supportReboundDist) ||
        (from === 'boost' && (this.boostPad < 0 || !this.padActive(state, this.boostPad)));
      if (urgent || this.modeTicks >= TUNING.modeMinTicks) {
        this.mode = desired;
        this.modeTicks = 0;
        this.goingAround = false;
        if (desired === 'aerial') {
          this.aerialStartTick = this.tick;
        }
        if (desired === 'aerial' || desired === 'kickoff') {
          this.stallTicks = 0;
          this.unstickTicks = 0;
        }
      }
    }

    // target for the chosen mode
    const prevX = this.target[0];
    const prevY = this.target[1];
    this.shotOn = false;
    this.nearBall = false;
    this.holdPosition = false;
    this.stopAtTarget = false;
    this.clearing = false;
    this.targetT = -1;
    switch (this.mode) {
      case 'kickoff':
        this.kickoffTarget();
        break;
      case 'attack':
        this.attackTarget();
        break;
      case 'defend':
        this.defendTarget();
        break;
      case 'support':
        this.supportTarget();
        break;
      case 'boost':
        this.boostTarget(state);
        break;
      case 'recover':
      case 'aerial':
        v3copy(this.rawTarget, this.ballPos);
        break;
      default:
        v3copy(this.rawTarget, this.ballPos);
        break;
    }
    // Playing the ball (attack / clear) but near it for nearBallStallTicks without a touch: the
    // approach geometry is dithering (hit point behind us, reverse, line up, repeat). Drive
    // straight through the ball; the go-around keeps its priority (never push it toward our net).
    if (this.ballStalled && !this.goingAround && (this.mode === 'attack' || (this.mode === 'defend' && this.clearing))) {
      this.driveThroughBall();
    }
    // A non-attacker never drives into the attacker's shot lane (positioning / boost targets only;
    // a rebound attack or a clear is deliberate ball play). pickPad never chooses a pad inside the
    // lane, so a boost target that is now inside it means the lane moved: give the pad up. (Only a
    // non-attacker reaches this block: hasAttacker means ANOTHER member holds the role.)
    if (ctx.hasAttacker && (this.mode === 'support' || this.mode === 'boost' || (this.mode === 'defend' && !this.clearing))) {
      if (this.avoidLane() && this.mode === 'boost') {
        this.boostPad = -1;
        v3copy(this.rawTarget, this.spot);
        this.avoidLane();
      }
    }
    // Inside a goal (or wedged on a post) the netting is between us and any field target, so the
    // first waypoint is the goal mouth; the inside-goal reverse rule (computeDriving) and the stall
    // detector get the car out even when its nose is pressed into the side netting.
    // Latched with hysteresis: the waypoint stays until the car has actually passed it, otherwise
    // a car at the post line dithers across the |x| = goalMouthX boundary (forward in, reverse out).
    if (this.mode === 'kickoff') this.goalEscape = false;
    else if (this.inGoalMouth()) this.goalEscape = true;
    else if (this.goalEscape && Math.abs(this.carPos[1]) < TUNING.goalMouthWaypointY) this.goalEscape = false;
    if (this.goalEscape) {
      v3set(this.rawTarget, 0, Math.sign(this.carPos[1]) * TUNING.goalMouthWaypointY, 0);
      this.shotOn = false;
      this.nearBall = false;
      this.holdPosition = false;
      this.stopAtTarget = false;
      this.targetT = -1;
    }
    this.clampToField(this.rawTarget);

    // target smoothing (kills steering jitter from a moving prediction)
    const jump = dist2D(prevX, prevY, this.rawTarget[0], this.rawTarget[1]);
    if (this.modeTicks === 0 || jump > TUNING.targetSnapDist || this.mode === 'kickoff') {
      v3copy(this.target, this.rawTarget);
    } else {
      v3lerp(this.target, this.target, this.rawTarget, TUNING.targetSmoothing);
    }
  }

  /**
   * Keep a driving target inside the drivable floor: the side / back wall margins and, in the
   * rounded corners, within cornerClampRadius of the corner centre (pulled back along the radius,
   * i.e. the wall normal). Without the corner clamp a go-around point behind a corner ball is in
   * the wall.
   */
  private clampToField(t: Vec3): void {
    t[0] = clamp(t[0], -TUNING.fieldClampX, TUNING.fieldClampX);
    t[1] = clamp(t[1], -TUNING.fieldClampY, TUNING.fieldClampY);
    const dx = Math.abs(t[0]) - ARENA.cornerCentreX;
    const dy = Math.abs(t[1]) - ARENA.cornerCentreY;
    if (dx > 0 && dy > 0) {
      const d = Math.sqrt(dx * dx + dy * dy);
      const r = TUNING.cornerClampRadius;
      if (d > r) {
        const k = r / d;
        t[0] = Math.sign(t[0]) * (ARENA.cornerCentreX + dx * k);
        t[1] = Math.sign(t[1]) * (ARENA.cornerCentreY + dy * k);
      }
    }
  }

  private isKickoff(): boolean {
    const b = this.ballPos;
    return Math.abs(b[0]) < 5 && Math.abs(b[1]) < 5 && v3len2(this.ballVel) < 1;
  }

  private ballOnOurHalf(): boolean {
    return this.ballPos[1] * this.goalDir > 0;
  }

  private ballInOurThird(): boolean {
    return this.ballPos[1] * this.goalDir > TUNING.defenderComeOutY;
  }

  /** Ball in the strip in front of our goal (corners included): the goalie's clearing zone. */
  private ballDeep(): boolean {
    return this.ballToOwnGoalDist() < TUNING.boxDeepGoalDist || Math.abs(this.ballPos[1] - this.goalDir * ARENA.extentY) < TUNING.boxDeepY;
  }

  /** Actively on the ball (a clear or an attack within playingBallDist): never yields to a teammate. */
  private playingBall(): boolean {
    return (this.clearing || this.mode === 'attack') && this.myBallDist < TUNING.playingBallDist;
  }

  private ballTowardOurGoal(): boolean {
    return this.ballVel[1] * this.goalDir > 150;
  }

  private ballToOwnGoalDist(): number {
    return dist2D(this.ballPos[0], this.ballPos[1], 0, this.goalDir * ARENA.extentY);
  }

  private ballThreatFast(): boolean {
    return this.ballOnOurHalf() && this.ballVel[1] * this.goalDir > 800;
  }

  private padActive(state: SimStateView, i: number): boolean {
    return state.buf[PADS_OFFSET + i * PAD_STRIDE + P_IS_ACTIVE] > 0.5;
  }

  private chooseMode(state: SimStateView): BotMode {
    const p = this.params;
    if (this.isKickoff()) return 'kickoff';

    if (!this.onGround) {
      if (this.mode === 'aerial') return 'aerial';
      return 'recover';
    }
    if (this.mode === 'aerial' && this.tick - this.aerialStartTick < 12) return 'aerial'; // taking off

    const role = this.teamCtx.role;
    if (role === 'support') return this.chooseSupportMode(state);
    if (role === 'defender') return this.chooseDefenderMode(state);

    const threat = (this.ballOnOurHalf() && this.ballTowardOurGoal()) || this.ballToOwnGoalDist() < 2200;
    const urgent = threat || (this.interceptT >= 0 && this.interceptT < 1.2) || this.myBallDist < 1500;

    if (p.aerials && this.aerialCooldown === 0 && this.boostAmt >= TUNING.aerialMinBoost && !this.isFlipping && this.findAerial(state)) {
      return 'aerial';
    }

    const oppCloser = this.hasOpp && this.oppBallDist < this.myBallDist * 0.85;
    const oppMuchCloser = this.hasOpp && this.oppBallDist < this.myBallDist * 0.5 && this.myBallDist > 2500;
    const defend = (threat && oppCloser) || (this.interceptT < 0 && this.ballOnOurHalf()) || (!this.ballOnOurHalf() && oppMuchCloser);
    if (defend) return 'defend';

    if (this.mode === 'boost' && this.boostPad >= 0 && this.padActive(state, this.boostPad) && this.boostAmt < 60 && !urgent) {
      return 'boost';
    }
    if (this.boostAmt < TUNING.boostSeekBelow && !urgent) {
      const pad = this.pickPad(state, this.bp[0], this.bp[1], 1500, 900, 1200);
      if (pad >= 0) {
        this.boostPad = pad;
        return 'boost';
      }
    }
    return 'attack';
  }

  /**
   * SUPPORT: sit behind the ball on our side, off to the far side, ready for a rebound; play the
   * ball only when it comes to us (or the attacker is beaten and we are next), gather boost when
   * low and nothing is urgent.
   */
  private chooseSupportMode(state: SimStateView): BotMode {
    const ctx = this.teamCtx;
    const p = this.params;
    const rebound = this.myBallDist < TUNING.supportReboundDist && this.ballClosing > 200 && ctx.attackerBallDist > this.myBallDist;
    const stepUp = ctx.attackerBeaten && this.interceptT >= 0 && this.interceptT < 1.0;
    if (rebound || stepUp) return 'attack';
    if (p.aerials && ctx.attackerBeaten && this.aerialCooldown === 0 && this.boostAmt >= TUNING.aerialMinBoost && !this.isFlipping && this.findAerial(state)) {
      return 'aerial';
    }
    this.supportSpot();
    const urgent = this.ballThreatFast() || this.myBallDist < 1500;
    if (this.mode === 'boost' && this.boostPad >= 0 && this.padActive(state, this.boostPad) && this.boostAmt < 60 && !urgent) {
      return 'boost';
    }
    if (this.boostAmt < TUNING.supportBoostBelow && !urgent) {
      const pad = this.pickPad(state, this.spot[0], this.spot[1], 2000, 900, 1200);
      if (pad >= 0) {
        this.boostPad = pad;
        return 'boost';
      }
    }
    return 'support';
  }

  /**
   * DEFENDER: hold the goalie spot (defendTarget decides between holding and clearing); grab the
   * back boost while the ball is far away.
   */
  private chooseDefenderMode(state: SimStateView): BotMode {
    const p = this.params;
    // A high ball flying at our goal: go up for it (a save / clear in the air).
    if (p.aerials && this.ballThreatFast() && this.aerialCooldown === 0 && this.boostAmt >= TUNING.aerialMinBoost && !this.isFlipping && this.findAerial(state)) {
      return 'aerial';
    }
    this.defenderSpot();
    const ballFar = this.ballToOwnGoalDist() > TUNING.defenderBoostBallDist && !this.ballTowardOurGoal();
    const urgent = this.ballThreatFast() || this.myBallDist < 1500 || !ballFar;
    if (this.mode === 'boost' && this.boostPad >= 0 && this.padActive(state, this.boostPad) && this.boostAmt < 60 && !urgent) {
      return 'boost';
    }
    if (this.boostAmt < TUNING.defenderBoostBelow && !urgent) {
      // the ball is far: the corner ("back") boost is worth the trip
      const pad = this.pickPad(state, this.spot[0], this.spot[1], 6500, 1200, 2800);
      if (pad >= 0) {
        this.boostPad = pad;
        return 'boost';
      }
    }
    return 'defend';
  }

  /**
   * Common approach geometry for shots and clears: drive through the hit point behind the ball on
   * the shot line, lining up when misaligned, and go around the ball when we are on the wrong side
   * of it (never push it toward our own goal).
   */
  private approachTarget(): void {
    const bp = this.bp;
    const sd = this.shotDir;
    // perpendicular to the shot line in the ground plane (consistent "side" sign)
    v3set(this.perp, sd[1], -sd[0], 0);
    v3sub(this.tmpA, this.carPos, bp);
    const along = v3dot2D(this.tmpA, sd);
    const lateral = v3dot2D(this.tmpA, this.perp);
    const distBp = v3dist2D(this.carPos, bp);

    if (!this.goingAround && along > TUNING.goAroundEnter && distBp < TUNING.goAroundMaxDist) this.goingAround = true;
    else if (this.goingAround && (along < TUNING.goAroundExit || distBp > TUNING.goAroundMaxDist + 600)) this.goingAround = false;

    if (this.goingAround) {
      const side = lateral >= 0 ? 1 : -1;
      this.rawTarget[0] = bp[0] - sd[0] * TUNING.goAroundBack + this.perp[0] * side * TUNING.goAroundSide;
      this.rawTarget[1] = bp[1] - sd[1] * TUNING.goAroundBack + this.perp[1] * side * TUNING.goAroundSide;
      this.rawTarget[2] = 0;
      // In a corner the point lands behind the walls; clamped, it can sit well inside the exit
      // threshold, so reaching it ends the go-around (otherwise the car parks on it forever).
      this.clampToField(this.rawTarget);
      if (v3dist2D(this.carPos, this.rawTarget) > TUNING.goAroundReachDist) {
        this.shotOn = false;
        return;
      }
      this.goingAround = false;
    }
    // A slow, low ball within nearBallDist: drive through it (see TUNING.nearBallDist).
    if (distBp < TUNING.nearBallDist && bp[2] < TUNING.groundMaxBallZ && v3len2D(this.ballVel) < TUNING.nearBallSpeed) {
      this.driveThroughBall();
      return;
    }
    const align = clamp(this.carFwd[0] * sd[0] + this.carFwd[1] * sd[1], -1, 1);
    const backoff = clamp(distBp * 0.4, 0, 800) * (1 - Math.max(0, align));
    this.rawTarget[0] = this.hit[0] - sd[0] * backoff + this.perp[0] * this.aimErr;
    this.rawTarget[1] = this.hit[1] - sd[1] * backoff + this.perp[1] * this.aimErr;
    this.rawTarget[2] = 0;
    this.shotOn = align > 0.85;
  }

  /**
   * Target the ball itself at full throttle with the shot "on" (the dodge may fire once aligned),
   * no time bound (no coasting) and the reverse rule off (computeDriving): the car drives through
   * the ball instead of parking at a hit point short of it.
   */
  private driveThroughBall(): void {
    v3copy(this.rawTarget, this.ballPos);
    this.rawTarget[2] = 0;
    this.shotOn = true;
    this.nearBall = true;
    this.targetT = -1;
    this.stopAtTarget = false;
    this.holdPosition = false;
  }

  /**
   * x of the shot's aim point inside the opponent goal: a little to the side away from the
   * opponent nearest the ball (aiming further out, at the far post, missed more than it beat
   * keepers in the bot bench).
   */
  private shotAimX(): number {
    const aimX = this.hasOpp ? -Math.sign(this.oppPos[0]) * TUNING.shotAimAway : 0;
    return clamp(aimX, -TUNING.goalAimClampX, TUNING.goalAimClampX);
  }

  private attackTarget(): void {
    this.targetT = this.interceptT;
    v3set(this.goalT, this.shotAimX(), -this.goalDir * ARENA.extentY, 0);
    shotHitPoint(this.bp, this.goalT, this.hit, this.shotDir);
    this.approachTarget();
  }

  private kickoffTarget(): void {
    const ctx = this.teamCtx;
    switch (ctx.kickoff) {
      case 'cheat': {
        // up to our side of midfield, off the kicker's lane, then stop facing the ball
        let side: number;
        if (ctx.hasAttacker && Math.abs(ctx.attackerPos[0]) > 100) side = -Math.sign(ctx.attackerPos[0]);
        else side = this.carPos[0] < 0 ? -1 : 1;
        v3set(this.rawTarget, side * TUNING.kickoffCheatX, this.goalDir * TUNING.kickoffCheatY, 0);
        this.stopAtTarget = true;
        this.holdPosition = v3dist2D(this.carPos, this.rawTarget) < TUNING.kickoffCheatHold;
        break;
      }
      case 'stay':
        // back centre: hold the spawn facing the ball (the back boost comes after the kickoff)
        v3copy(this.rawTarget, this.carPos);
        this.rawTarget[2] = 0;
        this.holdPosition = true;
        break;
      default:
        v3copy(this.rawTarget, this.ballPos);
        this.shotOn = true;
        break;
    }
  }

  /** Support spot -> this.spot: behind the ball on our side, offset to the far side. */
  private supportSpot(): void {
    const ctx = this.teamCtx;
    const ownGoalY = this.goalDir * ARENA.extentY;
    const goalDist = this.ballToOwnGoalDist();
    let depth = clamp(goalDist * TUNING.supportDepthFactor, TUNING.supportDepthMin, TUNING.supportDepthMax);
    // never behind our goal line
    const dy = Math.abs(this.ballPos[1] - ownGoalY) - 500;
    if (depth > dy) depth = Math.max(300, dy);
    const bx = this.ballPos[0];
    let side: number;
    if (Math.abs(bx) > 200) side = bx < 0 ? 1 : -1; // far side of the ball = toward the centre
    else if (ctx.hasAttacker && Math.abs(ctx.attackerPos[0]) > 50) side = ctx.attackerPos[0] < 0 ? 1 : -1; // away from the attacker
    else side = this.carPos[0] < 0 ? -1 : 1;
    const xLimit = TUNING.fieldClampX - 400;
    // a ball near a side wall pushes the spot further toward the centre (out of the corner lane)
    const sideOff = Math.max(TUNING.supportSide, Math.abs(bx) * TUNING.supportSideFactor);
    this.spot[0] = clamp(bx + side * sideOff, -xLimit, xLimit);
    this.spot[1] = this.ballPos[1] + this.goalDir * depth;
    this.spot[2] = 0;
    if (ctx.hasDefender) {
      // 3v3: the goalie owns the area in front of the goal. Ball deep in our half (the goalie is
      // clearing, its go-around path runs behind the ball): wait at the top of the box on the far
      // side. Otherwise keep clear of the goalie spot by sliding to the far-post side of it (then
      // forward if the side wall is in the way).
      if (this.ballDeep()) {
        this.boxSpot(this.spot, side);
        return;
      }
      const g = this.tmpA;
      this.defenderSpotInto(g);
      const sep = TUNING.supportDefenderSep;
      if (v3dist2D(this.spot, g) < sep) {
        const gSide = g[0] > 0 ? -1 : g[0] < 0 ? 1 : this.carPos[0] < 0 ? -1 : 1;
        this.spot[0] = clamp(g[0] + gSide * sep, -xLimit, xLimit);
        const dx = Math.abs(this.spot[0] - g[0]);
        if (dx < sep) this.spot[1] = g[1] - this.goalDir * Math.sqrt(sep * sep - dx * dx);
      }
    }
  }

  /** "Top of the box" waiting spot on `side`: out of the goalie's way, ready for the clear. */
  private boxSpot(out: Vec3, side: number): void {
    out[0] = side * TUNING.boxX;
    out[1] = this.goalDir * ARENA.extentY - this.goalDir * TUNING.boxDepth;
    out[2] = 0;
  }

  private supportTarget(): void {
    this.supportSpot();
    v3copy(this.rawTarget, this.spot);
    this.stopAtTarget = true;
    this.holdPosition = v3dist2D(this.carPos, this.rawTarget) < TUNING.supportHoldDist;
  }

  /** Defender (goalie) spot: in front of our goal line, tracking the ball's x. */
  private defenderSpotInto(out: Vec3): void {
    const ownGoalY = this.goalDir * ARENA.extentY;
    const goalDist = this.ballToOwnGoalDist();
    let depth = clamp(goalDist * TUNING.defenderDepthFactor, TUNING.defenderDepthMin, TUNING.defenderDepthMax);
    const dy = Math.abs(this.ballPos[1] - ownGoalY) - 300;
    if (depth > dy) depth = Math.max(400, dy);
    out[0] = clamp(this.ballPos[0] * TUNING.defenderXFactor, -TUNING.defenderXClamp, TUNING.defenderXClamp);
    out[1] = ownGoalY - this.goalDir * depth;
    out[2] = 0;
  }

  private defenderSpot(): void {
    this.defenderSpotInto(this.spot);
  }

  private defendTarget(): void {
    const p = this.params;
    const ctx = this.teamCtx;
    const ownGoalY = this.goalDir * ARENA.extentY;
    const goalDist = this.ballToOwnGoalDist();
    const clear =
      ctx.role === 'defender'
        ? (this.ballInOurThird() && ctx.attackerBeaten) || goalDist < TUNING.defenderComeOutGoalDist || this.myBallDist < 900
        : goalDist < 2600 || this.myBallDist < 900 || (this.interceptT >= 0 && this.interceptT < 1.0 && this.ballTowardOurGoal());
    if (clear) {
      this.clearing = true;
      this.targetT = this.interceptT;
      const bp = this.bp;
      const sideX = bp[0] !== 0 ? Math.sign(bp[0]) : this.carPos[0] < 0 ? -1 : 1;
      v3set(this.goalT, sideX * ARENA.extentX, bp[1] - this.goalDir * 3000, 0);
      shotHitPoint(bp, this.goalT, this.hit, this.shotDir);
      // Close to the ball but not clearly behind it on the clear line (the car is beside it or on
      // the far side, i.e. between the ball and the wall it should go to): committing to the hit
      // point from here pushes the ball back toward our net before the normal go-around threshold
      // (goAroundEnter) is crossed. Go around first.
      if (!this.goingAround) {
        v3sub(this.tmpA, this.carPos, bp);
        if (v3dot2D(this.tmpA, this.shotDir) > TUNING.clearGoAroundAlong && v3dist2D(this.carPos, bp) < TUNING.clearGoAroundDist) this.goingAround = true;
      }
      this.approachTarget();
      return;
    }
    if (ctx.role === 'defender') {
      // goalie: between the ball and our goal, close to the line
      this.defenderSpot();
      v3copy(this.rawTarget, this.spot);
      this.stopAtTarget = true;
      this.holdPosition = v3dist2D(this.carPos, this.rawTarget) < TUNING.defenderHoldDist;
      return;
    }
    // shadow: between the ball and our goal, facing the ball
    if (ctx.hasDefender && this.ballDeep()) {
      // a goalie is clearing a deep ball: wait at the top of the box on the ball's side
      const bx = this.ballPos[0];
      this.boxSpot(this.rawTarget, bx > 200 ? 1 : bx < -200 ? -1 : this.carPos[0] < 0 ? -1 : 1);
      this.stopAtTarget = true;
      this.holdPosition = v3dist2D(this.carPos, this.rawTarget) < 250;
      return;
    }
    let depth = clamp(goalDist * p.shadowFactor, TUNING.shadowMinDepth, p.shadowMax);
    // with a goalie behind us the shadow stays well in front of its spot
    if (ctx.hasDefender) depth = Math.max(depth, TUNING.defenderDepthMax + TUNING.supportDefenderSep);
    const dy = Math.abs(this.ballPos[1] - ownGoalY) - 300;
    if (depth > dy) depth = Math.max(400, dy);
    this.rawTarget[0] = clamp(this.ballPos[0] * 0.5, -TUNING.shadowXClamp, TUNING.shadowXClamp);
    this.rawTarget[1] = ownGoalY - this.goalDir * depth;
    this.rawTarget[2] = 0;
    this.holdPosition = v3dist2D(this.carPos, this.rawTarget) < 250;
  }

  /**
   * Is (x, y) inside the attacker's lane (attacker -> ball, extended laneExtend past the ball,
   * half width laneHalfWidth)? Leaves the lane frame in laneDx/Dy/Len and the point's
   * along / lateral coordinates in laneAlong / laneLateral (perp = (-dy, dx)).
   */
  private laneTest(x: number, y: number): boolean {
    const ctx = this.teamCtx;
    const ax = ctx.attackerPos[0];
    const ay = ctx.attackerPos[1];
    let dx = this.ballPos[0] - ax;
    let dy = this.ballPos[1] - ay;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) return false;
    dx /= len;
    dy /= len;
    const tx = x - ax;
    const ty = y - ay;
    this.laneDx = dx;
    this.laneDy = dy;
    this.laneLen = len;
    this.laneAlong = tx * dx + ty * dy;
    this.laneLateral = -tx * dy + ty * dx;
    if (this.laneAlong < -200 || this.laneAlong > len + TUNING.laneExtend) return false;
    return Math.abs(this.laneLateral) < TUNING.laneHalfWidth;
  }

  /**
   * Keep rawTarget out of the attacker's lane: a target inside it is pushed sideways to the lane
   * edge, on the side it (or we) already are. Returns true when the target was moved.
   */
  private avoidLane(): boolean {
    if (!this.laneTest(this.rawTarget[0], this.rawTarget[1])) return false;
    const ctx = this.teamCtx;
    const ax = ctx.attackerPos[0];
    const ay = ctx.attackerPos[1];
    const dx = this.laneDx;
    const dy = this.laneDy;
    const along = this.laneAlong;
    const lateral = this.laneLateral;
    let side: number;
    if (lateral !== 0) side = lateral < 0 ? -1 : 1;
    else {
      const carLat = -(this.carPos[0] - ax) * dy + (this.carPos[1] - ay) * dx;
      side = carLat !== 0 ? (carLat < 0 ? -1 : 1) : ax + dx * along > 0 ? -1 : 1;
    }
    const push = (TUNING.laneHalfWidth + TUNING.laneMargin) * side;
    this.rawTarget[0] = ax + dx * along - dy * push;
    this.rawTarget[1] = ay + dy * along + dx * push;
    return true;
  }

  /**
   * Best active pad on the way from the car to (destX, destY): minimises `dCar + 0.7 * detour -
   * bigBonus` among pads within 3500 whose detour (vs the straight path) is below maxDetourBig /
   * maxDetourSmall and that are not inside the attacker's lane. Returns the pad index or -1.
   */
  private pickPad(state: SimStateView, destX: number, destY: number, maxDetourBig: number, maxDetourSmall: number, bigBonus: number): number {
    const buf = state.buf;
    const cx = this.carPos[0];
    const cy = this.carPos[1];
    const direct = dist2D(cx, cy, destX, destY);
    const laneCheck = this.teamCtx.hasAttacker;
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < NUM_BOOST_PADS; i++) {
      if (buf[PADS_OFFSET + i * PAD_STRIDE + P_IS_ACTIVE] < 0.5) continue;
      const big = i < BOOST_PADS_BIG.length;
      const pad = big ? BOOST_PADS_BIG[i] : BOOST_PADS_SMALL[i - BOOST_PADS_BIG.length];
      const dCar = dist2D(cx, cy, pad[0], pad[1]);
      if (dCar > 3500) continue;
      if (laneCheck && this.laneTest(pad[0], pad[1])) continue;
      const detour = dCar + dist2D(pad[0], pad[1], destX, destY) - direct;
      if (detour > (big ? maxDetourBig : maxDetourSmall)) continue;
      const score = dCar + detour * 0.7 - (big ? bigBonus : 0);
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  }

  private boostTarget(state: SimStateView): void {
    const i = this.boostPad;
    if (i < 0 || !this.padActive(state, i)) {
      this.boostPad = -1;
      // pad gone: fall back to the role's natural target until the next decision
      if (this.teamCtx.role === 'attacker') v3copy(this.rawTarget, this.ballPos);
      else v3copy(this.rawTarget, this.spot);
      return;
    }
    const pad = i < BOOST_PADS_BIG.length ? BOOST_PADS_BIG[i] : BOOST_PADS_SMALL[i - BOOST_PADS_BIG.length];
    v3set(this.rawTarget, pad[0], pad[1], 0);
  }

  // ---- ground driving ---------------------------------------------------------------------

  private computeDriving(): void {
    const p = this.params;
    const K = TUNING.steerGain;
    let throttle = p.throttleMax;
    let steer = 0;
    let boost = false;
    let handbrake = false;

    if (this.holdPosition) {
      // goalie stance: rotate to face the ball without leaving the spot
      const a = angleToPoint2D(this.carFwd, this.carRight, this.carPos, this.ballPos);
      steer = clamp1(K * a);
      throttle = this.speed > 300 ? -0.2 : Math.abs(a) > 0.35 ? 0.4 : 0;
    } else {
      const dx = this.target[0] - this.carPos[0];
      const dy = this.target[1] - this.carPos[1];
      const dist = Math.sqrt(dx * dx + dy * dy);
      let angle = angleToPoint2D(this.carFwd, this.carRight, this.carPos, this.target) + this.steerErr;
      angle = wrapAngle(angle);

      // Reverse when the target is behind and close; inside a goal, reverse out whenever the mouth
      // is behind at all (driving forward there only presses the nose into the netting). Never on
      // a wall: the 2D projections are degenerate there and the rule toggles the throttle. Never
      // while driving through a slow ball next to us (nearBall): a tight forward turn reaches it,
      // reversing away from it is what the dead-ball dither was made of.
      const reverse =
        !this.onWall &&
        ((dist < TUNING.reverseMaxDist && Math.abs(angle) > TUNING.reverseAngle && !this.nearBall) || (this.goalEscape && Math.abs(angle) > Math.PI / 2));
      if (reverse) {
        throttle = -p.throttleMax;
        const angRear = wrapAngle(angle - Math.PI);
        steer = clamp1(-K * angRear);
      } else {
        steer = clamp1(K * angle);
        if (Math.abs(angle) > TUNING.handbrakeAngle && this.speed > TUNING.handbrakeMinSpeed) {
          handbrake = true;
          throttle *= 0.5;
        }
        // don't arrive early at a time-bound target (e.g. a landing spot): coast
        if (this.targetT > 0.25 && dist > 300) {
          const need = dist / this.targetT;
          if (this.speed > need * 1.25) throttle = 0;
        }
        // positioning spot: ease off near it, brake when overshooting
        if (this.stopAtTarget) {
          const slow = clamp((dist - TUNING.arriveStopDist) / TUNING.arriveSlowDist, 0, 1);
          throttle *= slow;
          if (this.speed > 500 + dist * 1.2) throttle = -0.4;
        }
        const aligned = Math.abs(angle) < TUNING.boostAlignAngle;
        if (this.mode === 'kickoff' && this.teamCtx.kickoff === 'go') {
          boost = Math.abs(angle) < 0.5;
        } else {
          boost =
            p.useBoost &&
            this.onGround &&
            !handbrake &&
            aligned &&
            throttle > 0.9 &&
            dist > p.boostMinDist &&
            this.speed < TUNING.boostMaxSpeed;
        }
      }
    }
    this.hThrottle = throttle;
    this.hSteer = steer;
    this.hBoost = boost && this.boostAmt > 0;
    this.hHandbrake = handbrake;
  }

  /**
   * Inside a goal or at its posts: |y| beyond the goal-line region and off the mouth centre but
   * still next to the goal (further out along the back wall there is no netting to escape from,
   * and sending a corner car to the goal-mouth waypoint loops it against the corner go-around).
   */
  private inGoalMouth(): boolean {
    const x = Math.abs(this.carPos[0]);
    const y = Math.abs(this.carPos[1]);
    return y > TUNING.goalMouthY && ((x > TUNING.goalMouthX && x < TUNING.goalMouthXMax) || y > ARENA.extentY);
  }

  /**
   * A higher-ranked teammate is right next to us: get out of its way. Brake when it is ahead
   * (we would cut across its path) and back off slowly once we are slow, keep rolling when it is
   * behind, and steer away from it.
   */
  private yieldControl(out: CarControls): void {
    const a = angleToPoint2D(this.carFwd, this.carRight, this.carPos, this.teamCtx.yieldPos);
    out.steer = a >= 0 ? -1 : 1;
    if (Math.abs(a) < Math.PI / 2) out.throttle = this.speed > TUNING.yieldBrakeSpeed ? -0.5 : -0.3;
    else out.throttle = 0.6;
    out.boost = false;
    out.handbrake = false;
    out.jump = false;
  }

  // ---- stall / wall recovery --------------------------------------------------------------

  /**
   * Runs every driving tick. A car that holds the throttle but does not move (nose against a wall
   * or the goal netting, where full steer cannot yaw it) is stalled; after stallTicks of that an
   * unstick phase of unstickTicks reverses the throttle and mirrors the steer, which swings the
   * nose toward where it wanted to go. The count ignores isOnGround on purpose: a car wedged on a
   * goal post flickers it every few ticks. Cleared by reset() and on kickoff / aerial.
   */
  private detectStall(): void {
    if (this.unstickTicks > 0) {
      this.unstickTicks--;
      return;
    }
    const pushing = this.mode === 'recover' || Math.abs(this.hThrottle) > 0.3;
    const driving = this.seq === 'none' && !this.isFlipping && !this.holdPosition && this.mode !== 'kickoff' && this.mode !== 'aerial';
    if (driving && pushing && this.speed < TUNING.stallSpeed && this.carPos[2] < TUNING.stallMaxZ) {
      if (++this.stallTicks >= TUNING.stallTicks) {
        this.stallTicks = 0;
        this.unstickTicks = TUNING.unstickTicks;
        this.unstickThrottle = this.hThrottle < 0 ? 1 : -1;
        this.unstickSteer = this.hSteer > 0 ? -1 : 1;
      }
    } else if (!driving || !pushing || this.speed >= TUNING.stallSpeed) {
      this.stallTicks = 0;
    }
  }

  private unstickControl(out: CarControls): void {
    out.throttle = this.unstickThrottle;
    out.steer = this.unstickSteer;
    out.boost = false;
    out.handbrake = false;
    out.jump = false;
  }

  /**
   * Wall riding: with 3+ wheels on a wall the sim says "on ground", but the 2D steering projections
   * are degenerate (nose up/down the wall: fwd_xy ~ 0; nose horizontal: right_xy ~ 0), so the car
   * creeps along the wall for 15-20 s. When the ball is not playable from here, steer toward world
   * down projected on the wall plane using 3D dots, full throttle, no boost / handbrake / reverse,
   * and take over the held outputs. A car that has stalled on the wall (slow, not climbing) hops
   * off instead and recoverControl lands it. Returns true when it wrote the controls.
   */
  private wallRecovery(out: CarControls): boolean {
    const ball = this.ballPos;
    const pos = this.carPos;
    const dx = ball[0] - pos[0];
    const dy = ball[1] - pos[1];
    const dz = ball[2] - pos[2];
    const ballDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const playable = ballDist < TUNING.wallBallDist && !(pos[2] > TUNING.wallHighZ && ball[2] < TUNING.wallBallLowZ);
    if (playable) {
      this.wallSlowTicks = 0;
      return false;
    }
    if (this.speed < TUNING.wallStallSpeed) this.wallSlowTicks++;
    else this.wallSlowTicks = 0;
    if (this.wallSlowTicks >= TUNING.wallStallTicks && Math.abs(this.carVel[2]) < TUNING.wallJumpMaxVz) {
      this.wallSlowTicks = 0;
      this.startJump(2);
      this.runJumpSeq(out);
      return true;
    }
    // d = world down (0,0,-1) projected on the wall plane (normal = the car's up): d = g - up (g.up).
    const up = this.carUp;
    const uz = up[2];
    const ddx = up[0] * uz;
    const ddy = up[1] * uz;
    const ddz = uz * uz - 1;
    const fwd = this.carFwd;
    const right = this.carRight;
    const f = ddx * fwd[0] + ddy * fwd[1] + ddz * fwd[2];
    const r = ddx * right[0] + ddy * right[1] + ddz * right[2];
    out.steer = Math.abs(f) < 1e-6 && Math.abs(r) < 1e-6 ? 0 : clamp1(TUNING.steerGain * Math.atan2(r, f));
    out.throttle = 1;
    out.boost = false;
    out.handbrake = false;
    out.jump = false;
    this.hThrottle = 1;
    this.hSteer = out.steer;
    this.hBoost = false;
    this.hHandbrake = false;
    return true;
  }

  // ---- jumps and dodges -------------------------------------------------------------------

  private startJump(holdTicks: number): void {
    this.seq = 'jump';
    this.seqTick = 0;
    this.seqHold = Math.max(1, holdTicks);
    this.seqDodge = false;
  }

  private startDodge(pitch: number, yaw: number): void {
    this.seq = 'jump';
    this.seqTick = 0;
    this.seqHold = 2;
    this.seqDodge = true;
    this.flipPitch = pitch;
    this.flipYaw = yaw;
  }

  private runJumpSeq(out: CarControls): void {
    this.seqTick++;
    switch (this.seq) {
      case 'jump':
        out.jump = true;
        if (this.seqTick >= this.seqHold) {
          this.seq = this.seqDodge ? 'wait' : 'air';
          this.seqTick = 0;
        }
        break;
      case 'wait':
        out.jump = false;
        if ((this.seqTick >= TUNING.dodgeWaitTicks && !this.onGround) || this.seqTick >= TUNING.dodgeWaitMax) {
          this.seq = this.onGround ? 'air' : 'flip';
          this.seqTick = 0;
        }
        break;
      case 'flip':
        out.jump = true;
        out.pitch = this.flipPitch;
        out.yaw = this.flipYaw;
        out.roll = 0;
        this.seq = 'air';
        this.seqTick = 0;
        break;
      case 'air':
        out.jump = false;
        if (this.onGround && this.seqTick > 6) {
          this.seq = 'none';
          this.seqTick = 0;
        } else if (!this.onGround && !this.isFlipping && this.seqTick > 2) {
          this.recoverControl(out);
        }
        break;
      default:
        break;
    }
  }

  /** An opponent charging at us at (near) supersonic speed from close range: hop over the bump. */
  private demoThreat(): boolean {
    if (this.oppNearDist >= TUNING.demoDodgeDist) return false;
    const ov = this.oppNearVel;
    const oppSpeed = Math.sqrt(ov[0] * ov[0] + ov[1] * ov[1]);
    if (oppSpeed < TUNING.demoDodgeSpeed) return false;
    // closing speed of the opponent along the line from it to us
    v3sub(this.tmpA, this.carPos, this.oppNearPos);
    if (v3normalize2D(this.tmpB, this.tmpA) === 0) return false;
    v3sub(this.tmpA, ov, this.carVel);
    return v3dot2D(this.tmpA, this.tmpB) > TUNING.demoDodgeClosing;
  }

  private checkJumpTriggers(out: CarControls): void {
    const p = this.params;
    const ballDist = this.myBallDist;
    const ballZ = this.ballPos[2];
    const angleBall = angleToPoint2D(this.carFwd, this.carRight, this.carPos, this.ballPos);

    if (this.mode === 'kickoff') {
      if (this.teamCtx.kickoff !== 'go') return;
      if ((ballDist < TUNING.kickoffDodgeDist && this.speed > TUNING.kickoffDodgeSpeed) || ballDist < 300) {
        this.startDodge(-1, 0);
        this.runJumpSeq(out);
      }
      return;
    }
    if (this.demoThreat()) {
      this.startJump(3);
      this.runJumpSeq(out);
      return;
    }
    if (this.mode === 'boost' || this.mode === 'support' || this.holdPosition) return;

    if (ballDist > 700) {
      this.dodgeRolled = false;
      this.jumpRolled = false;
    }

    const closing = this.ballClosing;

    // dodge into the ball for power when the shot is on
    const dodgeDist = clamp(TUNING.dodgeBaseDist + this.speed * TUNING.dodgeSpeedScale, 300, TUNING.dodgeMaxDist);
    if (this.shotOn && ballZ < TUNING.dodgeMaxBallZ && ballDist < dodgeDist && Math.abs(angleBall) < TUNING.dodgeAlign && closing > 200) {
      if (!this.dodgeRolled) {
        this.dodgeRolled = true;
        this.dodgeAllowed = this.rng.chance(p.dodgeProb);
      }
      if (this.dodgeAllowed) {
        this.startDodge(-1, clamp1(angleBall * 3) * 0.6);
        this.runJumpSeq(out);
        return;
      }
    }

    // single jump for a ball slightly off the ground
    if (ballZ >= TUNING.jumpMinBallZ && ballZ <= TUNING.jumpMaxBallZ && ballDist < TUNING.jumpDist && Math.abs(angleBall) < 0.5 && closing > 0) {
      if (!this.jumpRolled) {
        this.jumpRolled = true;
        this.jumpAllowed = this.rng.chance(p.jumpProb);
      }
      if (this.jumpAllowed) {
        this.startJump(ballZ > 230 ? 20 : 8);
        this.runJumpSeq(out);
      }
    }
  }

  // ---- air --------------------------------------------------------------------------------

  /**
   * Rock a wedged airborne car free: full roll one way, then pitch + yaw, then roll the other way,
   * in airStuckPhase-tick phases, boosting on the roll phases when there is boost (a nose-up car
   * lifts off its wedge). Throttle stays on so the wheels bite the moment they touch.
   */
  private airStuckControl(out: CarControls): void {
    const phase = Math.floor((this.airStuckTicks - TUNING.airStuckTicks) / TUNING.airStuckPhase) % 4;
    out.roll = phase === 0 ? 1 : phase === 2 ? -1 : 0;
    out.pitch = phase === 1 ? -1 : phase === 3 ? 1 : 0;
    out.yaw = phase === 1 ? 1 : phase === 3 ? -1 : 0;
    out.boost = this.boostAmt > 0 && phase % 2 === 0;
    out.throttle = 1;
    out.jump = false;
    out.handbrake = false;
  }

  /** Level out and land on the wheels pointing along the velocity. */
  private recoverControl(out: CarControls): void {
    out.throttle = 1;
    out.boost = false;
    out.jump = false;
    if (this.isFlipping) return;
    if (v3normalize2D(this.aim, this.carVel) < 300 || this.speed < 300) {
      if (v3normalize2D(this.aim, this.carFwd) === 0) v3set(this.aim, 1, 0, 0);
    }
    aimInAir(this.carFwd, this.carRight, this.carUp, this.carAng, this.aim, out);
  }

  /**
   * The direction an aerial pushes the ball (unit, into this.shotDir): a shot toward the shot's
   * aim point in the goal we attack (goalT), or for a save / clear (ball on our half flying at our
   * goal) up-field and out to the ball's side. `px, py, pz` = where the ball will be met.
   */
  private aerialPushDir(px: number, py: number, pz: number, defensive: boolean): void {
    const d = this.shotDir;
    if (defensive) {
      v3set(d, (px >= 0 ? 1 : -1) * 0.6, -this.goalDir, 0.35);
    } else {
      v3set(this.goalT, this.shotAimX(), -this.goalDir * ARENA.extentY, ARENA.goalHeight * 0.4);
      v3set(d, this.goalT[0] - px, this.goalT[1] - py, this.goalT[2] - pz);
    }
    if (v3normalize(d, d) === 0) v3set(d, 0, -this.goalDir, 0);
  }

  /**
   * Is there a predicted ball position in the air we could reach with a jump (and, for high balls
   * on the difficulties that do it, a double jump) plus boost, within the difficulty's flight
   * time, acceleration and height limits? The car aims aerialHitOffset behind the ball on the push
   * direction (aerialPushDir), so its nose sends the ball there. Stores the flight time in aerialT.
   */
  private findAerial(state: SimStateView): boolean {
    const p = this.params;
    const pred = state.ballPred;
    const iMin = Math.max(0, Math.round(TUNING.aerialMinT * TICK_RATE) - 1);
    const iMax = Math.min(BALL_PRED_TICKS - 1, Math.round(p.aerialMaxT * TICK_RATE) - 1);
    const fx = this.carFwd[0];
    const fy = this.carFwd[1];
    const age = predAge(state);
    const defensive = this.ballOnOurHalf() && this.ballTowardOurGoal();
    const off = TUNING.aerialHitOffset;
    for (let i = iMin; i <= iMax && i + age < BALL_PRED_TICKS; i += 6) {
      const o = (i + age) * BALL_PRED_STRIDE;
      const pz = pred[o + 2];
      if (pz < TUNING.aerialMinBallZ || pz > p.aerialMaxZ) continue;
      const t = (i + 1) * TICK_DT;
      const dbl = p.aerialDoubleJump && pz > TUNING.aerialDoubleZ && t > 0.4;
      const jv = dbl ? this.doubleJumpVel + TUNING.aerialJumpHoldVelDouble : this.phys.jumpImpulse + TUNING.aerialJumpHoldVel;
      this.aerialPushDir(pred[o], pred[o + 1], pz, defensive);
      const sd = this.shotDir;
      const tx = pred[o] - sd[0] * off;
      const ty = pred[o + 1] - sd[1] * off;
      const tz = pz - sd[2] * off;
      const dx = tx - this.carPos[0] - (this.carVel[0] + this.carUp[0] * jv) * t;
      const dy = ty - this.carPos[1] - (this.carVel[1] + this.carUp[1] * jv) * t;
      const dz = tz - this.carPos[2] - (this.carVel[2] + this.carUp[2] * jv) * t - this.gravHalf * t * t;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const need = (2 * len) / (t * t);
      if (need > p.aerialMaxAccel) continue;
      const h = Math.sqrt(dx * dx + dy * dy);
      if (h > 1 && (dx * fx + dy * fy) / h < p.aerialAheadCos) continue; // must be roughly ahead
      const boostNeeded = ((need / this.phys.boostAccelAir) * t + 0.3) * this.phys.boostPerSecond;
      // Without boost there is no aerial: with stock boost use boostNeeded > 0 already says so; with
      // a preset where boost never runs out boostNeeded is 0, so check the tank itself.
      if (boostNeeded > this.boostAmt || this.boostAmt <= 0) continue;
      this.aerialT = t;
      this.aerialDouble = dbl;
      this.aerialDefensive = defensive;
      return true;
    }
    return false;
  }

  private endAerial(): void {
    this.mode = 'recover';
    this.modeTicks = 0;
    this.aerialCooldown = TUNING.aerialCooldownTicks;
  }

  private aerialControl(state: SimStateView, out: CarControls): void {
    const elapsed = (this.tick - this.aerialStartTick) * TICK_DT;
    const tRem = this.aerialT - elapsed;
    if (tRem < 0.03) {
      this.endAerial();
      this.recoverControl(out);
      return;
    }
    predictBallAt(state, tRem, this.pred);
    // Meet the ball aerialHitOffset behind it on the push direction (recomputed: the ball moves).
    this.aerialPushDir(this.pred[0], this.pred[1], this.pred[2], this.aerialDefensive);
    const sd = this.shotDir;
    const off = TUNING.aerialHitOffset;
    // required constant acceleration to reach that point: delta = p - x - v t - ½ g t². Until the
    // jumps have happened, count the velocity they are about to add (as findAerial did).
    let jv = 0;
    if (this.onGround) jv = this.aerialDouble ? this.doubleJumpVel + TUNING.aerialJumpHoldVelDouble : this.phys.jumpImpulse + TUNING.aerialJumpHoldVel;
    else if (this.aerialDouble && !this.hasDoubleJumped) jv = this.phys.doubleJumpImpulse;
    const d = this.delta;
    d[0] = this.pred[0] - sd[0] * off - this.carPos[0] - (this.carVel[0] + this.carUp[0] * jv) * tRem;
    d[1] = this.pred[1] - sd[1] * off - this.carPos[1] - (this.carVel[1] + this.carUp[1] * jv) * tRem;
    d[2] = this.pred[2] - sd[2] * off - this.carPos[2] - (this.carVel[2] + this.carUp[2] * jv) * tRem - this.gravHalf * tRem * tRem;
    const len = v3normalize(this.aim, d);
    const need = (2 * len) / (tRem * tRem);
    const ballDist = v3dist(this.carPos, this.ballPos); // 3D: under a high ball the 2D distance is ~0
    // (No acceleration abort during the take-off: the nose is still turning up.)
    if ((need > TUNING.aerialAbortAccel && elapsed > TUNING.aerialAbortAfter) || (elapsed > 0.25 && ballDist < 150) || this.boostAmt <= 0) {
      this.endAerial();
      this.recoverControl(out);
      return;
    }
    out.throttle = 1;
    const takeoff = elapsed < (this.aerialDouble ? TUNING.aerialHoldDouble : TUNING.aerialHoldSingle);
    // Hold the first jump for extra height; a double jump presses it again with the stick centred.
    const second = this.aerialDouble && elapsed >= 0.15 && elapsed < 0.17 && !this.hasDoubleJumped;
    out.jump = takeoff || second;
    if (this.isFlipping) return;
    // The last moments: the nose turns to the push direction, so the touch sends the ball along it.
    if (tRem < TUNING.aerialStrikeT) v3copy(this.aim, sd);
    aimInAir(this.carFwd, this.carRight, this.carUp, this.carAng, this.aim, out);
    if (second) {
      out.pitch = 0;
      out.yaw = 0;
      out.roll = 0;
    }
    if (takeoff && this.onGround) {
      // leave the ground nose-up before the controller takes over
      out.pitch = Math.max(out.pitch, 0.6);
    }
    const cosA = v3dot(this.carFwd, this.aim);
    // Boost as soon as the nose is roughly on the line (the controller finishes the turn under boost).
    out.boost = elapsed > 0.03 && cosA > 0.8 && need > 120;
  }
}
