/**
 * Chase camera (ball cam / car cam) for the three.js frame: y up, car local
 * +x forward / +y up / +z right, 1 uu = 1 unit.
 *
 * Rules:
 *  - A pivot sits `height` above the car. The camera hangs `distance` behind the pivot along the
 *    smoothed view direction; the arm grows with speed by (1 - stiffness) * speed / 20 and the
 *    camera never goes below 10 uu. FOV is horizontal and widens by 3° while supersonic (a hint;
 *    the arm growth is the real speed cue).
 *  - Ball cam: pivot uses world up and rises 0.9 uu per degree of the ball's elevation; yaw points
 *    at the ball; pitch blends from `angle` to the ball's elevation with weight 0 below 22° ramping
 *    to 0.8 at 44°. View direction lags at 8.6/s.
 *  - Car cam: yaw follows the nose. A heading jump past 90° (a flip swinging the nose through
 *    vertical) is held, but only while airborne and for at most 0.7 s (longer than a RocketSim
 *    flip), so a half-flip landing, a wall U-turn or a demo respawn facing the other way recover
 *    at once instead of latching the camera in front of the nose. Near-vertical noses are held.
 *    In the air the pitch is `angle`, roll level. On a surface the pivot rides the car's up, pitch
 *    follows ~75% of the nose pitch and roll a tenth of the bank. Lag 24.7/s.
 *  - Camera swivel (right stick / mouse virtual stick, `look`): the stick DIRECTION, once past a
 *    0.25 deadzone, orbits the view around the pivot: forward = normal view, right = view turned
 *    90° to the car's right (camera on the car's left), back = 180° (camera in front, looking at
 *    the car). A mostly vertical stick also tilts the view by up to ±25° (stick) / ±35° (mouse,
 *    see `swivelPitchDeg`). The offset eases exponentially at 4 * swivelSpeed per second (90° in
 *    ~0.15 s at the default 5) and back to 0 on release. In ball cam an active swivel orbits around the
 *    CAR heading, ignoring the ball; on release the ball is tracked again smoothly.
 *  - Rear view (`look.rearView`): the view cuts (no easing) to yaw + 180° at pitch `angle` in both
 *    modes and cuts back on release; the smoothed state keeps tracking underneath so the return is
 *    where the normal camera would be.
 *  - Arena clamp: the camera is pulled inside the glass (35 uu inset, goal lanes allowed)
 *    along its view direction when the arm would leave the arena, so it never clips through walls,
 *    ceiling or corners.
 *  - A dt of 0 holds the camera (pause); only the first frame / snapTo() places it instantly.
 *
 * No allocations in update(): every vector is a reused scratch member.
 */
import * as THREE from 'three/webgpu';
import { ARENA } from '../sim/constants';
import { DEFAULT_CAMERA } from '../settings';
import type { CameraLook } from '../input/bindings';

const DEG = Math.PI / 180;
/** Floor clamp: the camera never goes below this height (uu). */
const MIN_CAMERA_HEIGHT = 10;
/** Distance kept from the glass / ceiling (uu). */
const ARENA_INSET = 35;
const BALL_CAM_RATE = 8.6;
const CAR_CAM_RATE = 24.7;
const PIVOT_RISE_PER_DEG = 0.9;
const BLEND_START = 22 * DEG;
const BLEND_END = 44 * DEG;
const BLEND_MAX = 0.8;
/** Arm growth per uu/s of speed (uu). */
const SPEED_TRAIL = 1 / 20;
const SUPERSONIC_FOV_BOOST = 3;
const BANK_FOLLOW = 0.1;
const FOV_EASE_RATE = 6;
/** Longest the car-cam heading hold lasts (s); RocketSim's FLIP_TORQUE_TIME is 0.65 s. */
const HOLD_MAX = 0.7;
/** Swivel easing rate per unit of `swivelSpeed` (1/s): the default 5 → 20/s, i.e. 90° in ~0.15 s. */
const SWIVEL_RATE_PER_SPEED = 4;
/** The composed view pitch never gets this close to the poles (lookAt needs a usable up). */
const MAX_VIEW_PITCH = 85 * DEG;
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/** Stick deflection below which the swivel is ignored (the stick is read as a direction). */
export const SWIVEL_DEADZONE = 0.25;
/** Vertical swivel tilt limit for a controller stick, degrees. */
export const SWIVEL_PITCH_STICK_DEG = 25;
/** Vertical swivel tilt limit for the mouse virtual stick, degrees. */
export const SWIVEL_PITCH_MOUSE_DEG = 35;

/** Car cam on a surface follows the nose pitch by this fraction (slightly less at steep angles). */
function noseFollow(noseRad: number): number {
  return 0.785 - (0.001 * Math.abs(noseRad)) / DEG;
}

export interface CameraSettings {
  /** Horizontal field of view, degrees (the camera setting). */
  fov: number;
  /** Arm length behind the pivot, uu. */
  distance: number;
  /** Pivot height above the car, uu. */
  height: number;
  /** Base pitch, degrees (negative looks down). */
  angle: number;
  /** 0..1; lower values let the arm stretch more with speed. */
  stiffness: number;
  /** 1..10: how fast the camera swivel reaches the stick direction (rate = 4 * value per s). */
  swivelSpeed: number;
  /** Multiplier on the view-direction lag rates. */
  transitionSpeed: number;
}

/** Same object as settings.ts DEFAULT_CAMERA (re-exported so the two can never drift). */
export const DEFAULT_CAMERA_SETTINGS: Readonly<CameraSettings> = DEFAULT_CAMERA;

const CAMERA_KEYS = Object.keys(DEFAULT_CAMERA) as ReadonlyArray<keyof CameraSettings>;

function isFullCameraSettings(s: Partial<CameraSettings>): s is CameraSettings {
  for (let i = 0; i < CAMERA_KEYS.length; i++) if (typeof s[CAMERA_KEYS[i]] !== 'number') return false;
  return true;
}

export interface CameraCarState {
  /** Three or more wheels on a surface. */
  grounded: boolean;
  /** Car speed, uu/s. */
  speed: number;
  supersonic: boolean;
}

/** What a swivel stick asks for: the yaw/pitch offsets (radians) relative to the normal view. */
export interface SwivelTarget {
  /** Deflection past SWIVEL_DEADZONE. When false, yaw and pitch are 0. */
  active: boolean;
  /** Orbit offset: 0 forward, +π/2 looks to the car's right, ±π looks back at the car. */
  yaw: number;
  /** Tilt offset: positive up, only when the vertical component dominates. */
  pitch: number;
}

/**
 * Pure mapping from a swivel stick (x right, y back as in CameraLook) to the view offsets. Only
 * the DIRECTION matters once the deflection passes the deadzone: yaw = atan2(x, -y), so
 * forward = 0, right = +90°, back = ±180°. A mostly vertical stick adds a tilt of up to
 * ±maxPitchDeg (ramping from 0 on the diagonal to the full value straight up / down; up = positive).
 * NaN or tiny inputs are inactive. Pass `out` to avoid the allocation.
 */
export function swivelTarget(
  x: number,
  y: number,
  maxPitchDeg: number = SWIVEL_PITCH_STICK_DEG,
  out: SwivelTarget = { active: false, yaw: 0, pitch: 0 },
): SwivelTarget {
  const d = Math.hypot(x, y);
  if (!(d >= SWIVEL_DEADZONE)) {
    out.active = false;
    out.yaw = 0;
    out.pitch = 0;
    return out;
  }
  const ux = x / d;
  const uy = y / d;
  out.active = true;
  out.yaw = Math.atan2(ux, -uy);
  const vertical = Math.abs(uy) - Math.abs(ux); // 0 on the diagonal, 1 straight up / down
  out.pitch = vertical > 0 ? -uy * vertical * maxPitchDeg * DEG : 0;
  return out;
}

const SNAP_STATE: CameraCarState = { grounded: true, speed: 0, supersonic: false };
const NO_LOOK: Readonly<CameraLook> = { x: 0, y: 0, rearView: false };

export class ChaseCamera {
  ballCam = true;
  /**
   * Live settings. When the constructor receives a complete CameraSettings object (e.g.
   * Settings.camera) this IS that object, so slider changes apply on the next frame.
   */
  readonly settings: CameraSettings;
  /** Vertical swivel limit, degrees: SWIVEL_PITCH_STICK_DEG for a pad, SWIVEL_PITCH_MOUSE_DEG for the mouse. */
  swivelPitchDeg = SWIVEL_PITCH_STICK_DEG;

  private initialized = false;
  /** Composed view direction (unit) the camera looks along this frame. */
  private readonly viewDir = new THREE.Vector3(0, 0, 1);
  /** Smoothed base heading (rad, wrapped to ±π): yaw = atan2(dir.z, dir.x), 0 faces +x. */
  private yaw = 0;
  /** Smoothed base pitch (rad, positive up). */
  private pitch = 0;
  /** Eased swivel offsets (rad), added on top of the base yaw / pitch. */
  private swivelYaw = 0;
  private swivelPitch = 0;
  private readonly swivel: SwivelTarget = { active: false, yaw: 0, pitch: 0 };
  /** The car's own heading last accepted, to spot the jump a flip makes. NaN until first seen. */
  private lastCarYaw = Number.NaN;
  /** How long the car-cam heading hold has been active (s). */
  private holdTime = 0;
  private readonly upRef = new THREE.Vector3(0, 1, 0);
  private readonly camUp = new THREE.Vector3(0, 1, 0);
  private fovBoost = 0;
  private appliedFov = Number.NaN;
  private appliedAspect = Number.NaN;

  private readonly carFwd = new THREE.Vector3();
  private readonly carUp = new THREE.Vector3();
  private readonly carRight = new THREE.Vector3();
  private readonly pivot = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private readonly axis = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();

  /**
   * A complete settings object is kept BY REFERENCE (pass Settings.camera for live tuning); a
   * partial one (or none) is merged over the defaults into a private copy.
   */
  constructor(settings?: CameraSettings | Partial<CameraSettings>) {
    this.settings =
      settings !== undefined && isFullCameraSettings(settings) ? settings : { ...DEFAULT_CAMERA_SETTINGS, ...settings };
  }

  toggle(): void {
    this.ballCam = !this.ballCam;
  }

  /** The FOV setting is horizontal; three.js wants vertical. Supersonic adds up to 3°. */
  applyProjection(camera: THREE.PerspectiveCamera): void {
    const hfov = (this.settings.fov + this.fovBoost) * DEG;
    camera.fov = (2 * Math.atan(Math.tan(hfov / 2) / camera.aspect)) / DEG;
    camera.updateProjectionMatrix();
    this.appliedFov = this.settings.fov + this.fovBoost;
    this.appliedAspect = camera.aspect;
  }

  /** Kickoff / respawn: drop all smoothing (swivel included) and place the camera immediately. */
  snapTo(
    camera: THREE.PerspectiveCamera,
    carPos: THREE.Vector3,
    carQuat: THREE.Quaternion,
    ballPos: THREE.Vector3,
    state: CameraCarState = SNAP_STATE,
    look: CameraLook = NO_LOOK,
  ): void {
    this.initialized = false;
    this.lastCarYaw = Number.NaN;
    this.holdTime = 0;
    this.update(camera, carPos, carQuat, ballPos, state, 0, look);
  }

  /**
   * @param look camera swivel stick (x right, y back, -1..1) and the rear-view hold; omit for none.
   */
  update(
    camera: THREE.PerspectiveCamera,
    carPos: THREE.Vector3,
    carQuat: THREE.Quaternion,
    ballPos: THREE.Vector3,
    state: CameraCarState,
    dt: number,
    look: CameraLook = NO_LOOK,
  ): void {
    const s = this.settings;
    const angleRad = s.angle * DEG;
    const arm = s.distance + (1 - s.stiffness) * state.speed * SPEED_TRAIL;
    const snap = !this.initialized;
    const swivelRate = SWIVEL_RATE_PER_SPEED * s.swivelSpeed;

    const carFwd = this.carFwd.set(1, 0, 0).applyQuaternion(carQuat);
    const carUp = this.carUp.set(0, 1, 0).applyQuaternion(carQuat);
    const pivot = this.pivot;

    // The car's heading (valid when the nose is not near vertical). Tracked in BOTH modes so a
    // switch to car cam never compares against a stale heading.
    const fh = Math.hypot(carFwd.x, carFwd.z);
    const headingValid = fh > 0.25;
    const carYaw = headingValid ? Math.atan2(carFwd.z, carFwd.x) : this.lastCarYaw;

    // Swivel: the stick direction sets the offset target; the offset eases toward it (and back to
    // 0 on release) at the swivel rate, independently of the base view lag.
    const sw = swivelTarget(look.x, look.y, this.swivelPitchDeg, this.swivel);
    if (snap) {
      this.swivelYaw = sw.yaw;
      this.swivelPitch = sw.pitch;
    } else if (dt > 0) {
      const ks = 1 - Math.exp(-swivelRate * dt);
      this.swivelYaw += shortestAngle(this.swivelYaw, sw.yaw) * ks;
      this.swivelPitch += (sw.pitch - this.swivelPitch) * ks;
    }

    let targetYaw: number;
    let targetPitch: number;
    let rate: number;

    if (this.ballCam) {
      const dx = ballPos.x - carPos.x;
      const dz = ballPos.z - carPos.z;
      const h = Math.max(1e-3, Math.hypot(dx, dz));
      const e0 = Math.atan2(ballPos.y - (carPos.y + s.height), h);
      const rise = (Math.abs(e0) / DEG) * PIVOT_RISE_PER_DEG;
      pivot.set(carPos.x, carPos.y + s.height + rise, carPos.z);
      rate = BALL_CAM_RATE * s.transitionSpeed;
      if (sw.active) {
        // An active swivel orbits around the car (the ball is ignored): base = car heading at the
        // base angle, moved at least as fast as the swivel so the orbit feels like one motion.
        targetYaw = Number.isFinite(carYaw) ? carYaw : this.yaw;
        targetPitch = angleRad;
        if (swivelRate > rate) rate = swivelRate;
      } else {
        const e = Math.atan2(ballPos.y - pivot.y, h);
        const t = BLEND_MAX * clamp01((Math.abs(e) - BLEND_START) / (BLEND_END - BLEND_START));
        targetPitch = angleRad * (1 - t) + e * t;
        targetYaw = h > 0.5 ? Math.atan2(dz, dx) : this.yaw;
      }
      this.upRef.copy(WORLD_UP);
      this.camUp.copy(WORLD_UP);
      if (headingValid) this.lastCarYaw = carYaw;
      this.holdTime = 0;
    } else {
      // Heading from the nose. A flip swings the nose through vertical and the heading jumps by
      // ~180° in one frame: hold through that while airborne, for at most HOLD_MAX. On contact
      // (or when the hold expires) the new heading is accepted, so the hold never latches.
      if (headingValid) {
        const jumped =
          Number.isFinite(this.lastCarYaw) &&
          Math.abs(shortestAngle(this.lastCarYaw, carYaw)) > 0.5 * Math.PI &&
          this.holdTime < HOLD_MAX &&
          !state.grounded;
        targetYaw = jumped ? this.yaw : carYaw;
        if (jumped) this.holdTime += dt;
        else {
          this.holdTime = 0;
          this.lastCarYaw = carYaw;
        }
      } else targetYaw = this.yaw;
      if (state.grounded) {
        const nose = Math.atan2(carFwd.y, fh);
        targetPitch = angleRad + nose * noseFollow(nose);
        this.upRef.copy(carUp);
        // Camera up: a tenth of the car's bank (roll about its nose), applied about the heading.
        const right = this.carRight.set(0, 0, 1).applyQuaternion(carQuat);
        const bank = Math.atan2(-right.y, carUp.y);
        this.axis.set(Math.cos(targetYaw), 0, Math.sin(targetYaw));
        this.camUp.copy(WORLD_UP).applyAxisAngle(this.axis, bank * BANK_FOLLOW);
      } else {
        targetPitch = angleRad;
        this.upRef.copy(WORLD_UP);
        this.camUp.copy(WORLD_UP);
      }
      pivot.copy(carPos).addScaledVector(this.upRef, s.height);
      rate = CAR_CAM_RATE * s.transitionSpeed;
    }

    // Ease the base view (yaw/pitch) toward the target with a first-order lag. The first frame
    // snaps; a zero dt (pause) holds the current lag state instead of snapping. The base state is
    // shared by both modes, so a ball cam / car cam switch swings rather than cuts.
    if (snap) {
      this.yaw = targetYaw;
      this.pitch = targetPitch;
      this.initialized = true;
    } else if (dt > 0) {
      const k = 1 - Math.exp(-rate * dt);
      this.yaw += shortestAngle(this.yaw, targetYaw) * k;
      this.pitch += (targetPitch - this.pitch) * k;
    }
    this.yaw = wrapAngle(this.yaw);

    // Compose the view: rear view cuts to the opposite heading at the base angle (and cuts back);
    // otherwise the eased swivel offsets ride on top of the eased base view.
    if (look.rearView) {
      setDir(this.viewDir, this.yaw + Math.PI, angleRad);
    } else {
      const p = this.pitch + this.swivelPitch;
      setDir(this.viewDir, this.yaw + this.swivelYaw, p > MAX_VIEW_PITCH ? MAX_VIEW_PITCH : p < -MAX_VIEW_PITCH ? -MAX_VIEW_PITCH : p);
    }

    // Camera rigidly on the arm behind the pivot, floor clamped and pulled inside the arena; look
    // along the view direction (the clamp shortens the arm but keeps the aim).
    const desired = this.desired.copy(pivot).addScaledVector(this.viewDir, -arm);
    if (desired.y < MIN_CAMERA_HEIGHT) desired.y = MIN_CAMERA_HEIGHT;
    clampToArena(desired);
    camera.position.copy(desired);
    camera.up.copy(this.camUp);
    camera.lookAt(this.tmp.copy(desired).add(this.viewDir));

    // Supersonic FOV boost, eased; also re-applies the projection after an aspect change.
    const targetBoost = state.supersonic ? SUPERSONIC_FOV_BOOST : 0;
    if (snap) this.fovBoost = targetBoost;
    else if (dt > 0) this.fovBoost += (targetBoost - this.fovBoost) * (1 - Math.exp(-FOV_EASE_RATE * dt));
    if (Math.abs(s.fov + this.fovBoost - this.appliedFov) > 1e-3 || camera.aspect !== this.appliedAspect) {
      this.applyProjection(camera);
    }
  }
}

/**
 * Pull a point inside the arena shell (three coords: x side, z length, y up) with ARENA_INSET
 * margin: side / back walls, the ceiling, the rounded corners (pulled back along the corner
 * radius) and the goal lanes (allowed to extend into the chambers while below the crossbar).
 */
export function clampToArena(p: THREE.Vector3): void {
  const inset = ARENA_INSET;
  let ax = Math.abs(p.x);
  let az = Math.abs(p.z);
  if (p.y > ARENA.height - inset) p.y = ARENA.height - inset;
  const maxX = ARENA.extentX - inset;
  if (ax > maxX) ax = maxX;
  const inGoalLane = ax < ARENA.goalHalfWidth - inset && p.y < ARENA.goalHeight - inset;
  const maxZ = inGoalLane ? ARENA.extentY + ARENA.goalDepth - inset : ARENA.extentY - inset;
  if (az > maxZ) az = maxZ;
  const dx = ax - ARENA.cornerCentreX;
  const dz = az - ARENA.cornerCentreY;
  if (dx > 0 && dz > 0) {
    const r = ARENA.cornerRadius - inset;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > r) {
      const k = r / d;
      ax = ARENA.cornerCentreX + dx * k;
      az = ARENA.cornerCentreY + dz * k;
    }
  }
  p.x = p.x < 0 ? -ax : ax;
  p.z = p.z < 0 ? -az : az;
}

/** Direction from yaw (0 faces +x, positive toward +z) and pitch (positive up). */
function setDir(out: THREE.Vector3, yaw: number, pitch: number): void {
  const c = Math.cos(pitch);
  out.set(Math.cos(yaw) * c, Math.sin(pitch), Math.sin(yaw) * c);
}

function shortestAngle(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Wrap an angle to (-π, π]. */
function wrapAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
