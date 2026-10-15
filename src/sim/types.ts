/**
 * CONTRACT between the RocketSim WebAssembly wrapper (native/wrapper.cpp), the TS bridge
 * (src/sim/RocketSimBridge.ts), the renderer, the AI and the input layer.
 *
 * Coordinate system (everywhere in src/sim, src/ai, src/input): SIM UNITS (uu).
 *   - x: side axis, y: length axis (blue goal at -y, red goal at +y), z: up.
 *   - 1 uu = 1 cm. Velocities uu/s. Angular velocities rad/s.
 *   - Car local frame: +x forward, +y right, +z up (Unreal, left-handed).
 *   - RotMat columns: forward, right, up (as RocketSim's RotMat).
 *
 * Mapping to three.js (right-handed, y up) is done ONLY in src/render:
 *   three.x = sim.x, three.y = sim.z, three.z = sim.y   (this preserves handedness, no mirroring)
 *   Car model local frame in three: +x forward, +y up, +z right.
 *
 * The WASM module exposes ONE Float32Array "state buffer" that the C++ side refreshes on
 * rs_sync(). JS reads it through typed-array views (zero copies, zero allocations per frame).
 * Layout below. All booleans are 0/1 floats. All indices are float offsets.
 */

export const TICK_RATE = 120;
export const TICK_DT = 1 / TICK_RATE;

export const MAX_CARS = 8; // up to 4v4 (3v3 is the largest mode exposed in the UI)
/** Our field: 4 big + 28 small (constants.ts BOOST_PADS_BIG / BOOST_PADS_SMALL; big pads first). */
export const NUM_BOOST_PADS = 32;

// ---- Header -----------------------------------------------------------------------------
export const H_TICK_COUNT = 0;
export const H_NUM_CARS = 1;
export const H_GOAL_COUNT = 2; // increments on every goal scored (never resets)
export const H_LAST_GOAL_TEAM = 3; // 0 = blue scored, 1 = red scored
/**
 * Increments once per physical car-car bump (never resets). RocketSim reports a mutual head-on bump
 * once per direction in the same tick; the wrapper merges those into one count and keeps the
 * demolition direction when one of them is a demo (so H_LAST_BUMP_IS_DEMO is always reliable).
 * For a non-demo mutual bump the bumper/victim order is Bullet's manifold order, i.e. not
 * meaningful. The bridge fires onBump at most once per sync() regardless of the delta.
 */
export const H_BUMP_COUNT = 4;
export const H_LAST_BUMP_BUMPER = 5; // car id
export const H_LAST_BUMP_VICTIM = 6; // car id
export const H_LAST_BUMP_IS_DEMO = 7;
export const H_BALL_SCORED = 8; // 1 while the ball is inside a net
export const HEADER_SIZE = 16;

// ---- Ball ---------------------------------------------------------------------------------
export const BALL_OFFSET = 16;
export const B_POS = 0; // 3
export const B_ROT = 3; // 9: forward(3), right(3), up(3)
export const B_VEL = 12; // 3
export const B_ANG_VEL = 15; // 3
export const B_HIT_VALID = 18;
export const B_HIT_TICK = 19; // tick count when the last car hit happened
export const B_HIT_CAR_ID = 20;
export const B_HIT_REL_POS = 21; // 3, hit point relative to ball centre
export const B_HIT_EXTRA_VEL = 24; // 3, extra impulse velocity added
export const BALL_SIZE = 32;

// ---- Cars ---------------------------------------------------------------------------------
export const CARS_OFFSET = BALL_OFFSET + BALL_SIZE; // 48
export const CAR_STRIDE = 64;
export const C_ID = 0;
export const C_TEAM = 1; // 0 blue, 1 red
export const C_POS = 2; // 3
export const C_ROT = 5; // 9: forward(3), right(3), up(3)
export const C_VEL = 14; // 3
export const C_ANG_VEL = 17; // 3
export const C_BOOST = 20; // 0..100
export const C_IS_ON_GROUND = 21;
export const C_IS_SUPERSONIC = 22;
export const C_IS_JUMPING = 23;
export const C_IS_FLIPPING = 24;
export const C_HAS_JUMPED = 25;
export const C_HAS_DOUBLE_JUMPED = 26;
export const C_HAS_FLIPPED = 27;
export const C_IS_DEMOED = 28;
export const C_DEMO_RESPAWN_TIMER = 29;
export const C_HANDBRAKE_VAL = 30;
export const C_IS_BOOSTING = 31;
export const C_JUMP_TIME = 32;
export const C_FLIP_TIME = 33;
export const C_AIR_TIME = 34;
export const C_IS_AUTO_FLIPPING = 35;
export const C_WHEEL_CONTACT = 36; // 4 (FL, FR, BL, BR)
export const C_WHEEL_SUSPENSION = 40; // 4, current suspension length in uu (hardpoint to wheel centre)
export const C_WHEEL_STEER = 44; // 4, steering angle in radians
export const C_WORLD_CONTACT_NORMAL = 48; // 3
export const C_WORLD_CONTACT = 51;
export const C_BALL_HIT_TICK = 52; // tick of this car's last ball touch (-1 if never)
export const C_FLIP_REL_TORQUE = 53; // 3
export const C_SUPERSONIC_TIME = 56;
export const C_TIME_SINCE_BOOSTED = 57;
export const C_LAST_JUMP_PRESSED = 58;

// ---- Boost pads -------------------------------------------------------------------------
export const PADS_OFFSET = CARS_OFFSET + MAX_CARS * CAR_STRIDE; // 560
export const PAD_STRIDE = 2;
export const P_IS_ACTIVE = 0;
export const P_COOLDOWN = 1;

export const STATE_BUFFER_SIZE = PADS_OFFSET + NUM_BOOST_PADS * PAD_STRIDE; // 624
export const STATE_BUFFER_FLOATS = 1024; // allocated size (padded)

// ---- Ball prediction buffer --------------------------------------------------------------
/** Number of predicted ticks stored by rs_ball_pred_update (6 seconds). */
export const BALL_PRED_TICKS = 720;
export const BALL_PRED_STRIDE = 6; // pos(3) vel(3)

// ---- Car presets (index passed to rs_add_car) ---------------------------------------------
export const CarPreset = {
  Standard: 0,
  Low: 1,
  Flat: 2,
  Long: 3,
  Mid: 4,
  Tall: 5,
} as const;
export type CarPreset = (typeof CarPreset)[keyof typeof CarPreset];

/** Static car config, as read back from the WASM (rs_get_car_config). All uu. */
export interface CarConfigInfo {
  hitboxSize: [number, number, number]; // full size (x length, y width, z height)
  hitboxOffset: [number, number, number]; // hitbox centre relative to the car origin
  frontWheelRadius: number;
  backWheelRadius: number;
  frontSuspensionRest: number;
  backSuspensionRest: number;
  frontWheelOffset: [number, number, number]; // hardpoint, y > 0 (mirrored for the left wheel)
  backWheelOffset: [number, number, number];
  dodgeDeadzone: number;
}

export const Team = { Blue: 0, Red: 1 } as const;
export type Team = (typeof Team)[keyof typeof Team];

/** Per-tick control inputs for one car. Analog values in [-1, 1]. Same semantics as RocketSim's CarControls. */
export interface CarControls {
  throttle: number; // +1 forward
  steer: number; // +1 right
  pitch: number; // +1 nose up
  yaw: number; // +1 right (airborne)
  roll: number; // +1 roll right (airborne)
  jump: boolean;
  boost: boolean;
  handbrake: boolean;
}

export function emptyControls(): CarControls {
  return { throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false };
}

/**
 * Read-only view over the state buffer. Implemented by RocketSimBridge. The renderer, AI and HUD
 * consume ONLY this interface so they never touch WASM memory directly.
 */
export interface SimStateView {
  /** The whole state buffer (Float32Array over WASM memory, refreshed by sync()). */
  readonly buf: Float32Array;
  readonly tickCount: number;
  readonly numCars: number;
  /** Float offset of car i (0-based slot) inside buf. */
  carOffset(slot: number): number;
  /** Slot index of a car id, or -1. */
  slotOf(carId: number): number;
  /**
   * Ball prediction buffer: BALL_PRED_TICKS entries of [x,y,z,vx,vy,vz]. Entry t = the ball state at
   * absolute tick `predTick + t + 1`, i.e. t+1 ticks after the refresh, NOT after the current tick.
   * Consumers add `tickCount - predTick` to their entry index (see Bot.ts predictBallAt).
   */
  readonly ballPred: Float32Array;
  /** tickCount at the last updateBallPrediction() (undefined/absent = treat as tickCount, age 0). */
  readonly predTick?: number;
}

export interface SimEvents {
  onGoal?(team: Team): void;
  onBump?(bumperId: number, victimId: number, isDemo: boolean): void;
  onBallHit?(carId: number, relSpeed: number): void;
}

// ---- Full state blobs (rollback netcode) -------------------------------------------------
/** Upper bound for an rs_save_state blob with MAX_CARS cars (allocation size for JS buffers). */
export const MAX_STATE_BYTES = 8192;
/** Packed controls: 6 int8 per car (throttle, steer, pitch, yaw, roll in [-127,127]; buttons byte). */
export const PACKED_INPUT_BYTES = 6;
export const BTN_JUMP = 1;
export const BTN_BOOST = 2;
export const BTN_HANDBRAKE = 4;

/** Quantise a CarControls into 6 bytes at `off` (int8 view). Allocation-free. */
export function packControls(c: CarControls, out: Int8Array, off: number): void {
  out[off] = Math.round(Math.max(-1, Math.min(1, c.throttle)) * 127);
  out[off + 1] = Math.round(Math.max(-1, Math.min(1, c.steer)) * 127);
  out[off + 2] = Math.round(Math.max(-1, Math.min(1, c.pitch)) * 127);
  out[off + 3] = Math.round(Math.max(-1, Math.min(1, c.yaw)) * 127);
  out[off + 4] = Math.round(Math.max(-1, Math.min(1, c.roll)) * 127);
  out[off + 5] = (c.jump ? BTN_JUMP : 0) | (c.boost ? BTN_BOOST : 0) | (c.handbrake ? BTN_HANDBRAKE : 0);
}

/** Inverse of packControls. */
export function unpackControls(src: Int8Array, off: number, out: CarControls): void {
  out.throttle = src[off] / 127;
  out.steer = src[off + 1] / 127;
  out.pitch = src[off + 2] / 127;
  out.yaw = src[off + 3] / 127;
  out.roll = src[off + 4] / 127;
  const b = src[off + 5];
  out.jump = (b & BTN_JUMP) !== 0;
  out.boost = (b & BTN_BOOST) !== 0;
  out.handbrake = (b & BTN_HANDBRAKE) !== 0;
}
