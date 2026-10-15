/**
 * Training content: the free-play id and the nine shot packs (Shooting / Saving / Aerials x
 * Beginner / Intermediate / Expert; ids `shooting` / `saving` / `aerial` x `easy` / `medium` /
 * `hard`). Pure data + tiny pure helpers, no DOM, no three.js: node-importable (the shot validity
 * test runs every shot through the real wasm, tests/training-shots.test.mjs).
 *
 * Names (free play, categories, difficulties, packs, shots) are translated once at module load
 * (src/i18n.ts, 'training.*' keys); ids and the records keyed by them never change.
 *
 * Every shot is our own design, placed on our field (constants.ts: goal lines at y = +-5600, side
 * walls at x = +-4400, 2000 x 720 goals). A shot is the car pose (position on the floor, heading,
 * optional initial velocity, boost) and the ball state (position, velocity, spin) at the moment
 * the player's first input releases it. Units are uu (uu, uu/s, rad/s; x right, y toward the
 * RED goal at +y, z up; yaw 0 = facing +x, pi/2 = facing the red goal). three.js never sees
 * these numbers: the Game places them in the sim.
 *
 * Contract checked by the wasm test for every shot (left completely alone, no player input):
 *   - Shooting / Aerial: the ball scores in NEITHER goal for the whole time limit plus the
 *     airborne grace (TRAINING_GRACE_SECONDS): the player has to do the scoring.
 *   - Saving: the ball DOES end in the blue goal (y < 0) before the time limit runs out: there is
 *     always something to save.
 *   - Car and ball start inside the arena and do not touch each other.
 *
 * Ground balls: RocketSim caps the ball's spin at 6 rad/s, so a ball rolling faster than ~550 uu/s
 * slides and loses ~250 uu/s per second until it rolls; below that a rolling ball keeps going for
 * a long time (~2 %/s). `rolling()` gives balls the matching roll spin so slow ones do not visibly
 * brake at release; the saving ground shots are fast enough to arrive anyway, and no shooting
 * ball rolls toward the red goal (it would get there by itself).
 */
import { BALL, GRAVITY_Z, KICKOFF_SPAWNS, CAR_STANDARD } from '../sim/constants';
import { t } from '../i18n';

export type TrainingCategory = 'shooting' | 'saving' | 'aerial';
export type TrainingDifficulty = 'easy' | 'medium' | 'hard';

export type Vec3 = readonly [number, number, number];

/** Where the player's car starts a shot. */
export interface TrainingCarPose {
  /** Car origin (uu). On the floor z = 17, the Standard's rest height. */
  readonly pos: Vec3;
  /** Heading in radians (0 faces +x, pi/2 faces the red goal, -pi/2 the blue goal). */
  readonly yaw: number;
  /** Velocity given to the car on release (uu/s); absent = at rest. */
  readonly vel?: Vec3;
  /** Boost at the start of the attempt (0..100). */
  readonly boost: number;
}

/** The ball at release: placed at `pos` and frozen until the first input, then given vel / angVel. */
export interface TrainingBallState {
  readonly pos: Vec3;
  readonly vel: Vec3;
  /** Spin (rad/s; RocketSim clamps the magnitude to 6). */
  readonly angVel: Vec3;
}

export interface TrainingShot {
  /** Short label for the HUD ("Open goal", "Rolling to the left post"...), in the current language. */
  readonly name: string;
  readonly car: TrainingCarPose;
  readonly ball: TrainingBallState;
}

export interface TrainingPack {
  /** `${category}-${difficulty}`, e.g. 'shooting-easy'. Also the records key. */
  id: string;
  /** Display name in the current language ('Shooting · Beginner'). */
  name: string;
  category: TrainingCategory;
  difficulty: TrainingDifficulty;
  description: string;
  /** Per-shot timer, started by the first input. */
  timeLimitSeconds: number;
  shots: readonly TrainingShot[];
}

/** `Game.startTraining(FREEPLAY_ID)`: only the player's car and the ball, no clock, unlimited boost. */
export const FREEPLAY_ID = 'freeplay';
export const FREEPLAY_NAME = t('training.freePlay');

export const TRAINING_CATEGORIES: readonly TrainingCategory[] = ['shooting', 'saving', 'aerial'];
export const TRAINING_DIFFICULTIES: readonly TrainingDifficulty[] = ['easy', 'medium', 'hard'];
export const CATEGORY_LABELS: Readonly<Record<TrainingCategory, string>> = { shooting: t('training.catShooting'), saving: t('training.catSaving'), aerial: t('training.catAerial') };
export const DIFFICULTY_LABELS: Readonly<Record<TrainingDifficulty, string>> = { easy: t('training.levelEasy'), medium: t('training.levelMedium'), hard: t('training.levelHard') };

/**
 * When the timer runs out with the ball still in the air (or, in a saving shot, still heading for
 * the goal) the attempt goes on until that is over, a goal is scored or this many extra seconds
 * pass: a shot in flight gets to finish.
 */
export const TRAINING_GRACE_SECONDS = 3;

/** Free play spawn: the blue keeper kickoff spot, facing the red goal. */
const KEEPER_SPOT = KICKOFF_SPAWNS[KICKOFF_SPAWNS.length - 1];
export const FREEPLAY_CAR_SPAWN: TrainingCarPose = { pos: [KEEPER_SPOT[0], KEEPER_SPOT[1], CAR_STANDARD.restZ], yaw: KEEPER_SPOT[2], boost: 100 };
/** Free play ball: centre spot at rest. */
export const FREEPLAY_BALL: TrainingBallState = { pos: [0, 0, BALL.restZ], vel: [0, 0, 0], angVel: [0, 0, 0] };

// ---- authoring helpers (pure; evaluated once at module load) ---------------------------------

const DEG = Math.PI / 180;
/** Rolling without slipping needs |w| = v / r; RocketSim clamps |w| to this. */
const BALL_MAX_SPIN = 6;
const ZERO: Vec3 = [0, 0, 0];

/** A car on the floor at (x, y) facing `yawDeg` degrees, optionally already moving. */
function car(x: number, y: number, yawDeg: number, boost: number, vel?: Vec3): TrainingCarPose {
  const pose: TrainingCarPose = { pos: [x, y, CAR_STANDARD.restZ], yaw: yawDeg * DEG, boost };
  return vel === undefined ? pose : { ...pose, vel };
}

/** A car on the floor at (x, y) facing the point (tx, ty). */
function carFacing(x: number, y: number, tx: number, ty: number, boost: number): TrainingCarPose {
  return { pos: [x, y, CAR_STANDARD.restZ], yaw: Math.atan2(ty - y, tx - x), boost };
}

/** A ball at rest (placed in the air it falls on release). */
function still(x: number, y: number, z: number = BALL.restZ): TrainingBallState {
  return { pos: [x, y, z], vel: ZERO, angVel: ZERO };
}

/** A ball in flight (no spin). */
function flying(x: number, y: number, z: number, vx: number, vy: number, vz: number): TrainingBallState {
  return { pos: [x, y, z], vel: [vx, vy, vz], angVel: ZERO };
}

/**
 * A ball on the floor moving at (vx, vy) with roll spin: w = (-vy, vx, 0) / r keeps the contact
 * point still (v + w x (0, 0, -r) = 0), clamped to RocketSim's 6 rad/s.
 */
function rolling(x: number, y: number, vx: number, vy: number): TrainingBallState {
  let wx = -vy / BALL.radius;
  let wy = vx / BALL.radius;
  const w = Math.sqrt(wx * wx + wy * wy);
  if (w > BALL_MAX_SPIN) {
    wx *= BALL_MAX_SPIN / w;
    wy *= BALL_MAX_SPIN / w;
  }
  return { pos: [x, y, BALL.restZ], vel: [vx, vy, 0], angVel: [wx, wy, 0] };
}

/** A ground ball from (x, y) rolling toward (tx, ty) at `speed`. */
function rollToward(x: number, y: number, tx: number, ty: number, speed: number): TrainingBallState {
  const dx = tx - x;
  const dy = ty - y;
  const k = speed / Math.sqrt(dx * dx + dy * dy);
  return rolling(x, y, dx * k, dy * k);
}

/**
 * Ballistic launch from `from` that reaches `to` after `t` seconds under the sim's gravity (air
 * drag ignored: RocketSim's ball drag is a few % per second, so lobs land a little short, which
 * the saving shots absorb by aiming behind the goal line).
 */
function lob(from: Vec3, to: Vec3, t: number): TrainingBallState {
  return {
    pos: from,
    vel: [(to[0] - from[0]) / t, (to[1] - from[1]) / t, (to[2] - from[2]) / t - 0.5 * GRAVITY_Z * t],
    angVel: ZERO,
  };
}

function shot(name: string, c: TrainingCarPose, b: TrainingBallState): TrainingShot {
  return { name, car: c, ball: b };
}

// ---- Definición (shooting): score in the red goal (+y) ---------------------------------------

const SHOOTING_EASY: readonly TrainingShot[] = [
  shot(t('training.shotOpenGoal'), car(0, 440, 90, 100), still(0, 2410)),
  shot(t('training.shotLeftLane'), carFacing(-1610, 770, -1180, 2950, 100), still(-1180, 2950)),
  shot(t('training.shotRightLane'), carFacing(1610, 770, 1180, 2950, 100), still(1180, 2950)),
  shot(t('training.shotBouncingBall'), car(0, 1310, 90, 100), still(0, 3280, 600)),
  shot(t('training.shotComingBack'), carFacing(-750, 1310, 0, 2840, 100), rolling(0, 3940, 0, -490)),
  shot(t('training.shotSlowCross'), car(-640, 1420, 80, 100), rolling(-2580, 3500, 480, 0)),
  shot(t('training.shotTightAngle'), carFacing(-2470, 1750, -2040, 3830, 100), still(-2040, 3830)),
  shot(t('training.shotFromMidfield'), car(0, -1750, 90, 100), still(0, 330)),
];

const SHOOTING_MEDIUM: readonly TrainingShot[] = [
  shot(t('training.shotCrossLeft'), car(0, 1640, 90, 66), rolling(-3440, 3610, 970, 0)),
  shot(t('training.shotCrossRight'), car(0, 1970, 95, 66), rolling(3440, 3940, -970, -110)),
  shot(t('training.shotPopUp'), carFacing(970, 1200, 0, 3170, 66), flying(0, 3170, BALL.restZ, 0, 0, 900)),
  shot(t('training.shotReturnPass'), car(970, 1420, 110, 66), rolling(540, 4590, -160, -870)),
  shot(t('training.shotBouncePass'), carFacing(1930, 660, 1070, 2840, 66), flying(1500, 2840, 800, -380, 0, 0)),
  shot(t('training.shotTurnaround'), car(0, 3500, -90, 66), still(0, 1750)),
  shot(t('training.shotOffTheWall'), car(2360, 550, 70, 66), still(4000, 3060, 700)),
];

const SHOOTING_HARD: readonly TrainingShot[] = [
  shot(t('training.shotFastCross'), car(320, 1750, 90, 50), flying(-3540, 3940, BALL.restZ, 1400, 0, 250)),
  shot(t('training.shotHighBounce'), car(210, 440, 90, 50), flying(-750, 2840, 1300, 160, 0, 0)),
  shot(t('training.shotBackDrop'), carFacing(-210, 2410, 1720, 5030, 50), still(1720, 5030, 1400)),
  shot(t('training.shotRunawayBall'), car(-1720, 2630, 20, 50), rolling(1930, 4700, -270, -1310)),
  shot(t('training.shotLobFromWing'), car(-640, 1310, 60, 50), flying(-3220, 2190, 300, 970, 0, 900)),
  shot(t('training.shotMovingStart'), car(0, -550, 90, 50, [0, 1310, 0]), rolling(-1610, 3060, 750, 0)),
];

// ---- Atajadas (saving): keep the ball out of the blue goal (-y) ----------------------------------

const SAVING_EASY: readonly TrainingShot[] = [
  shot(t('training.shotRollingMiddle'), car(-700, -5470, 90, 100), rolling(0, -2620, 0, -1420)),
  shot(t('training.shotRollingLeftPost'), car(590, -5470, 90, 100), rollToward(970, -2840, -480, -6020, 1420)),
  shot(t('training.shotRollingRightPost'), car(-590, -5470, 90, 100), rollToward(-970, -2840, 480, -6020, 1420)),
  shot(t('training.shotBouncingIn'), car(590, -5470, 90, 100), flying(0, -2840, 700, 0, -1200, 0)),
  shot(t('training.shotSoftLob'), car(540, -5470, 90, 100), lob([0, -2190, 150], [-270, -6020, 280], 2.6)),
  shot(t('training.shotRollingFromWing'), car(640, -5470, 90, 100), rollToward(-2580, -3500, 270, -6020, 1530)),
  shot(t('training.shotLowShot'), car(-590, -5470, 90, 100), rollToward(1720, -2410, -320, -6020, 1640)),
  shot(t('training.shotHopMiddle'), car(640, -5470, 90, 100), flying(0, -1750, BALL.restZ, 0, -1310, 600)),
];

const SAVING_MEDIUM: readonly TrainingShot[] = [
  shot(t('training.shotHardRoller'), car(480, -5140, 90, 66), rollToward(540, -1970, -540, -6020, 2080)),
  shot(t('training.shotLobTopCorner'), car(-430, -5360, 90, 66), lob([-540, -2190, 200], [700, -6020, 510], 2.2)),
  shot(t('training.shotShotFromWing'), car(320, -5030, 90, 66), rollToward(-3220, -3060, 540, -6020, 2190)),
  shot(t('training.shotBouncingShot'), car(-540, -5360, 90, 66), flying(0, -2410, 900, 320, -1420, -200)),
  shot(t('training.shotChip'), car(540, -5250, 90, 66), lob([0, -1640, BALL.restZ], [-430, -6020, 340], 1.9)),
  shot(t('training.shotFarPost'), car(-210, -5360, 60, 66), lob([-2360, -2840, 200], [640, -6020, 390], 2.0)),
  shot(t('training.shotLateDrop'), car(0, -4810, 90, 66), lob([640, -1310, 300], [-320, -6020, 230], 2.5)),
];

const SAVING_HARD: readonly TrainingShot[] = [
  shot(t('training.shotBreakaway'), car(-1610, -3940, -45, 50), rollToward(-430, -1640, 320, -6020, 2190)),
  shot(t('training.shotTopCorner'), car(0, -5360, 90, 50), lob([1070, -2730, 300], [-700, -6120, 370], 1.8)),
  shot(t('training.shotLongLob'), car(0, -3830, 90, 50), lob([0, 0, 200], [320, -6020, 450], 3.2)),
  shot(t('training.shotCrossingVolley'), car(640, -5360, 120, 50), lob([-3010, -3280, 500], [320, -6230, 280], 1.7)),
  shot(t('training.shotFastLow'), car(-320, -4920, 90, 50), rollToward(1290, -2620, -210, -6020, 2630)),
  shot(t('training.shotOutOfPosition'), car(1500, -4700, 200, 50), lob([-1290, -1090, 300], [540, -6120, 280], 2.3)),
];

// ---- Aéreos: the ball is in the air; score in the red goal -----------------------------------

const AERIAL_EASY: readonly TrainingShot[] = [
  shot(t('training.shotFloater'), car(0, 2080, 90, 100), flying(0, 3830, 200, 0, 0, 1150)),
  shot(t('training.shotLeftFloater'), carFacing(-750, 2080, -540, 3940, 100), flying(-540, 3940, 200, 0, 0, 1050)),
  shot(t('training.shotRightFloater'), carFacing(750, 2080, 540, 3940, 100), flying(540, 3940, 200, 0, 0, 1050)),
  shot(t('training.shotFallingBall'), car(0, 1860, 90, 100), still(0, 3610, 1200)),
  shot(t('training.shotDriftingBack'), carFacing(-540, 2300, 0, 3940, 100), flying(0, 4380, 200, 0, -270, 1100)),
  shot(t('training.shotCrossingFloater'), car(-640, 1860, 80, 100), flying(-1500, 3610, 200, 270, 0, 1100)),
  shot(t('training.shotHighFloater'), carFacing(320, 1640, 0, 3500, 100), flying(0, 3500, 300, 0, 0, 1400)),
  shot(t('training.shotClosePopUp'), car(0, 2840, 90, 100), flying(320, 4480, 150, 0, -160, 1000)),
];

const AERIAL_MEDIUM: readonly TrainingShot[] = [
  shot(t('training.shotFloatingCross'), car(0, 1970, 90, 100), flying(-2690, 3940, 300, 750, 0, 1100)),
  shot(t('training.shotCeilingDrop'), carFacing(-320, 1530, 0, 3280, 100), still(0, 3280, 1800)),
  shot(t('training.shotDeepFloater'), car(0, 2730, 90, 100), flying(-640, 4920, 300, 0, -110, 1300)),
  shot(t('training.shotHighPopUp'), carFacing(640, 1310, 540, 3060, 100), flying(540, 3060, 200, -110, 0, 1450)),
  shot(t('training.shotCornerPass'), carFacing(-860, 2190, 1610, 4050, 100), flying(3440, 4380, 300, -970, -330, 1000)),
  shot(t('training.shotRetreating'), car(0, 1640, 90, 100), flying(0, 4700, 300, 0, -660, 1200)),
  shot(t('training.shotDoubleDrop'), car(-970, 1090, 90, 100), flying(-970, 3390, 1500, 210, 0, 0)),
];

const AERIAL_HARD: readonly TrainingShot[] = [
  shot(t('training.shotCeilingBall'), car(0, 880, 90, 100), still(0, 2730, 1850)),
  shot(t('training.shotFastCross'), car(540, 1750, 90, 100), flying(-3540, 4160, 400, 1290, -110, 1100)),
  shot(t('training.shotFarPostFloater'), carFacing(-1070, 2410, 1500, 4700, 100), flying(1930, 4700, 300, -540, 0, 1300)),
  shot(t('training.shotHighDeep'), car(0, 3060, 90, 100), flying(0, 5250, 1500, 0, -220, 300)),
  shot(t('training.shotLongRange'), car(0, -550, 90, 100), flying(0, 1640, 300, 0, 0, 1450)),
  shot(t('training.shotLobFromCorner'), carFacing(0, 2190, -2150, 4160, 100), flying(-3650, 4590, 200, 860, -440, 1300)),
];

/** `description` is never displayed (kept in Spanish, not translated yet). */
function pack(
  category: TrainingCategory,
  difficulty: TrainingDifficulty,
  timeLimitSeconds: number,
  description: string,
  shots: readonly TrainingShot[],
): TrainingPack {
  return {
    id: `${category}-${difficulty}`,
    name: t('training.packName', { category: CATEGORY_LABELS[category], difficulty: DIFFICULTY_LABELS[difficulty] }),
    category,
    difficulty,
    description,
    timeLimitSeconds,
    shots,
  };
}

/** The nine packs, category-major (shooting, saving, aerial) and easy -> hard within each. */
export const TRAINING_PACKS: readonly TrainingPack[] = [
  pack('shooting', 'easy', 10, 'Pelotas quietas y lentas con el arco a la vista. Aprendé a acomodar el tiro.', SHOOTING_EASY),
  pack('shooting', 'medium', 8, 'Centros, globitos y una media vuelta: tomale el tiempo a la pelota en movimiento.', SHOOTING_MEDIUM),
  pack('shooting', 'hard', 7, 'Centros rápidos, piques altos y pelotas que se escapan del arco, con medio tanque.', SHOOTING_HARD),
  pack('saving', 'easy', 10, 'Pelotas rodando y globos suaves al arco azul. Ponete adelante y despejá.', SAVING_EASY),
  pack('saving', 'medium', 8, 'Remates más fuertes, vaselinas y globos a los ángulos.', SAVING_MEDIUM),
  pack('saving', 'hard', 7, 'Mano a mano, tiros al ángulo y atajadas fuera de posición.', SAVING_HARD),
  pack('aerial', 'easy', 10, 'Pelotas flotando frente al arco. Saltá, inclinate hacia atrás y dale boost.', AERIAL_EASY),
  pack('aerial', 'medium', 9, 'Más altas y en movimiento: centros, caídas del techo y pelotas que se alejan.', AERIAL_MEDIUM),
  pack('aerial', 'hard', 8, 'Pelotas de techo, centros rápidos y aéreos de lejos.', AERIAL_HARD),
];

/** The pack with this id, or undefined (FREEPLAY_ID is not a pack). */
export function packById(id: string): TrainingPack | undefined {
  for (let i = 0; i < TRAINING_PACKS.length; i++) if (TRAINING_PACKS[i].id === id) return TRAINING_PACKS[i];
  return undefined;
}
