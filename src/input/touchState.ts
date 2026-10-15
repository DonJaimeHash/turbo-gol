/**
 * On-screen touch controls → per-action values for Input (`Input.setTouchSource`).
 *
 * Pure state (no DOM, no CSS): the overlay feeds it the stick deflection and button presses, Input
 * reads it once per `sample()`, and node tests import it directly. The values join Input's
 * keyboard + mouse column, so the air-roll modifier, invertAirPitch, blockJumpUntilRelease,
 * latchEdges, the rebind capture and the one-shot edges (`actions`, never `padActions`) work for
 * touch exactly as for the keyboard.
 *
 * Mapping (copied from the default keyboard layout, DEFAULT_KBM in bindings.ts):
 *
 *   Touch control  Actions
 *   -------------  ------------------------------------------------------------------
 *   Stick up       throttle + pitchDown (nose down, like W)
 *   Stick down     reverse + pitchUp (like S)
 *   Stick X        steerLeft / steerRight + yawLeft / yawRight (like A / D)
 *   JUMP           jump (the stick gives the dodge direction on the second jump)
 *   BOOST          boost
 *   DRIFT          powerslide + airRoll (stick X then rolls instead of yawing)
 *   CAM            ballCam
 *   PAUSE          pause
 *   RESET          trainingReset (training only)
 *
 * The stick is analog (0..1 per direction); a button counts while any finger holds it, or once
 * when it was pressed since the last read (a tap shorter than one tick, like a keyboard tap).
 */
import { ACTION_IDS, type ActionId } from './bindings';
import type { TouchSource } from './Input';

/** On-screen buttons (indices into TouchState's per-button tables). */
export const TB = {
  JUMP: 0,
  BOOST: 1,
  DRIFT: 2,
  CAM: 3,
  PAUSE: 4,
  RESET: 5,
} as const;

export type TouchButton = (typeof TB)[keyof typeof TB];

export const TOUCH_BUTTON_COUNT: number = Object.keys(TB).length;

/** Actions each stick direction drives, at the deflection along that direction. */
export const TOUCH_STICK_ACTIONS: Readonly<Record<'up' | 'down' | 'left' | 'right', readonly ActionId[]>> = {
  up: ['throttle', 'pitchDown'],
  down: ['reverse', 'pitchUp'],
  left: ['steerLeft', 'yawLeft'],
  right: ['steerRight', 'yawRight'],
};

/** Actions each button drives (1 while it counts as pressed). */
export const TOUCH_BUTTON_ACTIONS: Readonly<Record<TouchButton, readonly ActionId[]>> = {
  [TB.JUMP]: ['jump'],
  [TB.BOOST]: ['boost'],
  [TB.DRIFT]: ['powerslide', 'airRoll'],
  [TB.CAM]: ['ballCam'],
  [TB.PAUSE]: ['pause'],
  [TB.RESET]: ['trainingReset'],
};

/** Stick deflection, up on screen = +y. */
export interface StickVector {
  x: number;
  y: number;
}

/** Clamp to ±1; NaN and -0 become 0. */
function clamp1(v: number): number {
  return v > 1 ? 1 : v < -1 ? -1 : v === v && v !== 0 ? v : 0;
}

/**
 * Stick deflection of a finger at (dx, dy) px from the stick centre (screen axes, y down): the
 * offset over `radius`, a radial deadzone rescaled so the first usable value is 0 (the math of
 * Input's gamepad radialDeadzone), then a per-axis `gain` and a clamp to ±1, so a 45° drag still
 * gives ≥ 0.85 per axis. Up on screen is +y. Garbage input gives 0. Pass `out` to reuse an object.
 */
export function stickVector(dx: number, dy: number, radius: number, deadzone = 0.12, gain = 1.25, out: StickVector = { x: 0, y: 0 }): StickVector {
  const dz = deadzone > 0 ? (deadzone < 0.9 ? deadzone : 0.9) : 0;
  const g = gain > 0 ? gain : 1;
  let x = 0;
  let y = 0;
  if (radius > 0) {
    x = dx / radius;
    y = -dy / radius;
    const mag = Math.hypot(x, y); // not sqrt(x² + y²): no overflow on a huge offset
    if (mag <= dz || mag === 0) {
      x = 0;
      y = 0;
    } else {
      const k = (Math.min(1, (mag - dz) / (1 - dz)) / mag) * g;
      x *= k;
      y *= k;
    }
  }
  out.x = clamp1(x);
  out.y = clamp1(y);
  return out;
}

/** (px, py) lies inside the circle of radius `r` around (cx, cy) (edge included). */
export function hitCircle(px: number, py: number, cx: number, cy: number, r: number): boolean {
  const dx = px - cx;
  const dy = py - cy;
  return r > 0 && dx * dx + dy * dy <= r * r;
}

function actionIndices(actions: readonly ActionId[]): Uint8Array {
  const out = new Uint8Array(actions.length);
  for (let i = 0; i < actions.length; i++) out[i] = ACTION_IDS.indexOf(actions[i]);
  return out;
}

const STICK_UP = actionIndices(TOUCH_STICK_ACTIONS.up);
const STICK_DOWN = actionIndices(TOUCH_STICK_ACTIONS.down);
const STICK_LEFT = actionIndices(TOUCH_STICK_ACTIONS.left);
const STICK_RIGHT = actionIndices(TOUCH_STICK_ACTIONS.right);
const BUTTON_ACTIONS: readonly Uint8Array[] = Array.from({ length: TOUCH_BUTTON_COUNT }, (_, b) =>
  actionIndices(TOUCH_BUTTON_ACTIONS[b as TouchButton]),
);

function writeAll(out: Float64Array, actions: Uint8Array, v: number): void {
  for (let i = 0; i < actions.length; i++) out[actions[i]] = v;
}

/** The touch controls' state, read by Input once per sample. */
export class TouchState implements TouchSource {
  private x = 0;
  private y = 0;
  /** Fingers holding each button (several fingers may share one). */
  private readonly held = new Int32Array(TOUCH_BUTTON_COUNT);
  /** Buttons pressed since the last read (a tap between two reads still counts once). */
  private readonly tapped = new Uint8Array(TOUCH_BUTTON_COUNT);

  /** Stick X, -1..1 (right = +1). */
  get stickX(): number {
    return this.x;
  }

  /** Stick Y, -1..1 (up on screen = +1). */
  get stickY(): number {
    return this.y;
  }

  /** Set the stick deflection (each axis clamped to ±1, NaN = 0); (0, 0) releases it. */
  setStick(x: number, y: number): void {
    this.x = clamp1(x);
    this.y = clamp1(y);
  }

  /** A finger went down on (or slid onto) button `b`. Pair it with exactly one `release`. */
  press(b: TouchButton): void {
    this.held[b]++;
    this.tapped[b] = 1;
  }

  /**
   * A finger left button `b` (lifted or slid off). Fingers are counted per button, not per
   * pointer, so the caller must release each press exactly once: a second release for the same
   * finger would drop another finger's hold on that button. Keep a pointerId → button map and
   * release on the first of pointerup / pointercancel / lostpointercapture. Only a release with
   * no finger left on `b` is ignored (the count never goes negative).
   */
  release(b: TouchButton): void {
    if (this.held[b] > 0) this.held[b]--;
  }

  /** At least one finger holds button `b`. */
  isHeld(b: TouchButton): boolean {
    return this.held[b] > 0;
  }

  /**
   * Forget the stick, every held button and every pending tap (focus lost, hidden, overlay off).
   * Input calls it too on its own release (window blur, page hidden, dispose) while this is its
   * touch source.
   */
  releaseAll(): void {
    this.x = 0;
    this.y = 0;
    this.held.fill(0);
    this.tapped.fill(0);
  }

  /**
   * Write one value in 0..1 per ACTION_IDS index into `out` (0 for the actions touch does not
   * drive) and forget the taps reported. No allocations.
   */
  read(out: Float64Array): void {
    out.fill(0);
    const x = this.x;
    const y = this.y;
    writeAll(out, STICK_UP, y > 0 ? y : 0);
    writeAll(out, STICK_DOWN, y < 0 ? -y : 0);
    writeAll(out, STICK_LEFT, x < 0 ? -x : 0);
    writeAll(out, STICK_RIGHT, x > 0 ? x : 0);
    const held = this.held;
    const tapped = this.tapped;
    for (let b = 0; b < TOUCH_BUTTON_COUNT; b++) {
      if (held[b] > 0 || tapped[b] !== 0) writeAll(out, BUTTON_ACTIONS[b], 1);
      tapped[b] = 0;
    }
  }
}
