/**
 * Field and physics constants in uu (1 uu = 1 cm). The physics values (gravity, ball, car) mirror
 * what RocketSim simulates (its constants header; RocketSim is MIT, ZealanL); the FIELD is our own design
 * and is the single source of truth for it: the arena mesh (arenaMesh.ts), the wrapper's field
 * layout (RocketSimBridge.initArena sends the walls, goal line, pads and spawn spots below to the
 * wasm), the renderer, the camera clamp, the bots and the training packs all read from here.
 *
 * Our field (top view, blue goal at -y, red at +y):
 *
 *   - 8800 x 11200 floor (x = +-4400 side walls, y = +-5600 goal lines), ceiling at z = 2250.
 *   - Rounded corners: each corner is a vertical quarter cylinder of radius 1700 (centres at
 *     (+-2700, +-3900)), so the outline is a rounded rectangle, no flat chamfers.
 *   - Floor ramps: radius 320 into the side walls and corners, 240 into the back walls (eased
 *     across each corner); every wall meets the ceiling through a radius 600 arc.
 *   - Goals: 2000 wide x 720 high mouths, 960 deep chambers (a box whose back edges are rounded:
 *     r 240 at the floor, a car can ride up the back of the net, and r 360 under the roof). A goal
 *     counts when the whole ball is past the goal line: |ball.y| > 5600 + ball radius.
 *   - 4 big + 28 small boost pads, mirrored in x and y (BOOST_PADS_BIG / BOOST_PADS_SMALL).
 *   - 5 kickoff spots and 4 demolition respawn spots per team (KICKOFF_SPAWNS / RESPAWN_SPOTS).
 */

export const GRAVITY_Z = -650;

const EXTENT_X = 4400;
const EXTENT_Y = 5600;
const CORNER_RADIUS = 1700;

export const ARENA = {
  extentX: EXTENT_X, // flat side walls at x = +-4400
  extentY: EXTENT_Y, // goal lines / back walls at y = +-5600
  height: 2250, // ceiling plane
  /** Plan-view radius of the rounded corners (vertical quarter cylinders). */
  cornerRadius: CORNER_RADIUS,
  /** Corner arc centres at (+-cornerCentreX, +-cornerCentreY): where the straight walls end. */
  cornerCentreX: EXTENT_X - CORNER_RADIUS, // 2700
  cornerCentreY: EXTENT_Y - CORNER_RADIUS, // 3900
  goalHalfWidth: 1000, // mouth 2000 wide (inner face of the side netting)
  goalHeight: 720, // underside of the crossbar
  goalDepth: 960, // back of the net at |y| = 6560
  goalScoreThresholdY: EXTENT_Y, // goal when |ball.y| > threshold + ball radius (the whole ball past the line)
  sideRampRadius: 320, // floor -> side walls and corners
  backRampRadius: 240, // floor -> back walls (eases from the side value across each corner)
  ceilingRadius: 600, // walls -> ceiling
};

/**
 * Goal chamber profile (depth behind the mouth plane, height): a box 960 deep and 720 high whose
 * two back edges are rounded. The floor is RocketSim's floor plane.
 */
export const GOAL_PROFILE = {
  /** Floor -> back of the net: a small quarter pipe a car can drive up. */
  backBottomRadius: 240,
  /** Back of the net -> roof. */
  backTopRadius: 360,
};

/**
 * RocketSim broadphase bounds (custom grid): must enclose the whole arena including both goal
 * chambers, with some margin. Sent to the wasm with the field layout.
 */
export const BROADPHASE_MIN: readonly [number, number, number] = [-(EXTENT_X + 300), -(EXTENT_Y + 960 + 300), 0];
export const BROADPHASE_MAX: readonly [number, number, number] = [EXTENT_X + 300, EXTENT_Y + 960 + 300, 2250 + 200];

export const BALL = {
  radius: 91.25, // collision
  visualRadius: 92.75,
  restZ: 93.15,
  maxSpeed: 6000,
};

export const CAR = {
  maxSpeed: 2300,
  supersonicSpeed: 2200,
  boostMax: 100,
  boostSpawn: 100 / 3,
};

/** Standard visual reference (the WASM is the source of truth via rs_get_car_config). */
export const CAR_STANDARD = {
  hitboxSize: [120.507, 86.6994, 38.6591] as const,
  hitboxOffset: [13.8757, 0, 20.755] as const,
  frontWheelRadius: 12.5,
  backWheelRadius: 15,
  frontWheelOffset: [51.25, 25.9, 20.755] as const,
  backWheelOffset: [-33.75, 29.5, 20.755] as const,
  restZ: 17,
};

/** Heights of the pad pickup cylinders' centres (the cylinder is 95 uu tall in RocketSim). */
const PAD_Z_BIG = 73;
const PAD_Z_SMALL = 70;

/**
 * Boost pads in the wasm's order: the big pads first, then the small ones (the state buffer pad
 * slots follow this order). [x, y, z]. Mirrored in x and y. Big pads sit in the side lanes 2400
 * in front of each goal line; the small ones form a centre spine, two midfield rows and a ring
 * around each goal area.
 */
export const BOOST_PADS_BIG: ReadonlyArray<readonly [number, number, number]> = [
  [-3600, -3200, PAD_Z_BIG],
  [3600, -3200, PAD_Z_BIG],
  [-3600, 3200, PAD_Z_BIG],
  [3600, 3200, PAD_Z_BIG],
];
export const BOOST_PADS_SMALL: ReadonlyArray<readonly [number, number, number]> = [
  // blue end, from the goal outward
  [-1400, -4800, PAD_Z_SMALL], [1400, -4800, PAD_Z_SMALL],
  [-2500, -4400, PAD_Z_SMALL], [2500, -4400, PAD_Z_SMALL],
  [0, -3500, PAD_Z_SMALL],
  [-1400, -2700, PAD_Z_SMALL], [1400, -2700, PAD_Z_SMALL],
  [0, -1800, PAD_Z_SMALL],
  [-3700, -1600, PAD_Z_SMALL], [3700, -1600, PAD_Z_SMALL],
  [-2000, -1200, PAD_Z_SMALL], [2000, -1200, PAD_Z_SMALL],
  // midfield
  [-3100, 0, PAD_Z_SMALL], [-1300, 0, PAD_Z_SMALL], [1300, 0, PAD_Z_SMALL], [3100, 0, PAD_Z_SMALL],
  // red end, from midfield toward the goal
  [-2000, 1200, PAD_Z_SMALL], [2000, 1200, PAD_Z_SMALL],
  [-3700, 1600, PAD_Z_SMALL], [3700, 1600, PAD_Z_SMALL],
  [0, 1800, PAD_Z_SMALL],
  [-1400, 2700, PAD_Z_SMALL], [1400, 2700, PAD_Z_SMALL],
  [0, 3500, PAD_Z_SMALL],
  [-2500, 4400, PAD_Z_SMALL], [2500, 4400, PAD_Z_SMALL],
  [-1400, 4800, PAD_Z_SMALL], [1400, 4800, PAD_Z_SMALL],
];
/** Pickup cylinder radii (RocketSim's values; also the visual pad size). */
export const BOOST_PAD_BIG_RADIUS = 208;
export const BOOST_PAD_SMALL_RADIUS = 144;

/** Yaw of a car at (x, y) facing the centre spot. */
function yawToCentre(x: number, y: number): number {
  return Math.atan2(-y, -x);
}

/**
 * Blue-team kickoff spots [x, y, yaw] (cars face the ball); red is mirrored (x, y negated,
 * yaw + pi). Two wings, two inside spots and the keeper spot. A kickoff seed shuffles which
 * spots a team uses and deals them in car creation order, the same for both teams (wrapper).
 */
export const KICKOFF_SPAWNS: ReadonlyArray<readonly [number, number, number]> = [
  [-1800, -3300, yawToCentre(-1800, -3300)],
  [1800, -3300, yawToCentre(1800, -3300)],
  [-600, -4000, yawToCentre(-600, -4000)],
  [600, -4000, yawToCentre(600, -4000)],
  [0, -5000, Math.PI / 2],
];

/**
 * Blue-team demolition respawn spots [x, y, yaw] (facing upfield); red mirrored. The wrapper
 * moves a car that finishes its respawn timer onto one of these (chosen deterministically from
 * the tick and the car id, skipping a spot another car is standing on). A car added to the arena
 * also starts on one of them (the k-th car of a team on spot k % 4).
 */
export const RESPAWN_SPOTS: ReadonlyArray<readonly [number, number, number]> = [
  [-3000, -4300, Math.PI / 2],
  [-1900, -5050, Math.PI / 2],
  [1900, -5050, Math.PI / 2],
  [3000, -4300, Math.PI / 2],
];

export const UU_TO_KMH = 0.036;

/** Largest team the sim is sized for (MAX_CARS / 2 in types.ts); the UI stops at 3v3. */
export const TEAM_SIZE_MAX = 4;

/** Game modes exposed in the UI → cars per team. */
export const MODES = { '1v1': 1, '2v2': 2, '3v3': 3 } as const;
export type GameMode = keyof typeof MODES;

/**
 * Pulls the floor point (x, y) inside the field outline shrunk by `margin` (side walls, back walls
 * and the rounded corners; the goal mouths are not special) and writes it to out[0], out[1]. Pure
 * and allocation-free; for camera / AI clamps, not for collision.
 */
export function clampToOutline(x: number, y: number, margin: number, out: { 0: number; 1: number }): void {
  const maxX = ARENA.extentX - margin;
  const maxY = ARENA.extentY - margin;
  let ax = Math.abs(x);
  let ay = Math.abs(y);
  if (ax > maxX) ax = maxX;
  if (ay > maxY) ay = maxY;
  const dx = ax - ARENA.cornerCentreX;
  const dy = ay - ARENA.cornerCentreY;
  if (dx > 0 && dy > 0) {
    const r = ARENA.cornerRadius - margin;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > r) {
      const k = r / d;
      ax = ARENA.cornerCentreX + dx * k;
      ay = ARENA.cornerCentreY + dy * k;
    }
  }
  out[0] = x < 0 ? -ax : ax;
  out[1] = y < 0 ? -ay : ay;
}
