/**
 * Finger routing for the on-screen touch controls (src/input/TouchControls.ts): which finger drives
 * the stick, which one holds which button, and what a slide between buttons does. Pure (no DOM, no
 * CSS) so node tests drive it with plain coordinates; the overlay measures the layout from its CSS
 * and feeds it the pointer events of its root, in client px.
 *
 *   Stick        a finger that lands in the stick zone (the left half below the top strip) while
 *                no other finger owns the stick: the landing point is the stick centre and the
 *                offset from it the deflection (stickVector), until the finger lifts. The centre
 *                is kept STICK_EDGE_REACH radii inside the screen, so a thumb that lands near the
 *                bottom or left edge can still reach full reverse / pitch up / left (it then
 *                starts slightly deflected toward that edge). A second finger in the zone does
 *                nothing.
 *   JUMP, BOOST,  a finger that lands on one (a forgiving hit circle, HIT_SLOP) holds it. Sliding
 *   DRIFT        into another of the three switches to it, except that a finger which held BOOST
 *                keeps it held until it lifts (boost + jump or drift with one thumb). Leaving a
 *                button for empty space keeps it held: only reaching another one switches, so a
 *                thumb resting in the gap never flickers between two buttons (each new press of
 *                JUMP would be another jump). A finger that lands in the right half off every
 *                button holds nothing until it slides onto one.
 *   PAUSE, CAM,  tap only: a finger that lands on one fires it once when it lifts there; sliding
 *   RESET        away cancels it, and no slide ever reaches them.
 *
 * Each finger releases what it holds exactly once (the first of up / cancel / lost capture), so
 * TouchState's per-button finger counts stay right with any number of fingers.
 */
import { TB, TOUCH_BUTTON_COUNT, hitCircle, stickVector, type StickVector, type TouchButton, type TouchState } from './touchState';

/** A button's hit circle (r 0 = not shown: never hit). */
export interface TouchCircle {
  cx: number;
  cy: number;
  r: number;
}

/** A rectangle in client px. */
export interface TouchRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Where the controls are, in client px. */
export interface TouchLayout {
  /** The whole overlay (the screen): how far a finger can go. Empty = no limit. */
  bounds: TouchRect;
  /** Where a finger can start the stick (right and bottom excluded). */
  zone: TouchRect;
  /** Finger offset from the stick centre for full deflection, px. */
  stickRadius: number;
  /** One circle per TB index. */
  buttons: TouchCircle[];
}

/** The buttons a finger holds and slides between. */
export const HOLD_BUTTONS: readonly TouchButton[] = [TB.JUMP, TB.BOOST, TB.DRIFT];
/** The buttons that only take a tap. */
export const TAP_BUTTONS: readonly TouchButton[] = [TB.PAUSE, TB.CAM, TB.RESET];

/** A landing up to this many radii from a button's centre hits it (thumbs land off-centre). */
export const HIT_SLOP = 1.2;

/**
 * The stick centre stays this many radii inside the screen bounds: a full deflection along an
 * axis needs about 0.82 radii (stickVector's deadzone and gain), so a finger can always get there
 * before the screen edge.
 */
export const STICK_EDGE_REACH = 0.85;

const F_STICK = 0;
const F_HOLD = 1;
const F_TAP = 2;
const F_NONE = 3;

interface Finger {
  kind: number;
  /** F_HOLD: the button it is on (-1 none yet); F_TAP: the button it landed on. */
  button: number;
  /** F_HOLD: the finger left BOOST for another button and still holds it. */
  keepBoost: boolean;
}

/** An empty layout: nothing is hit and every landing does nothing. */
export function emptyLayout(): TouchLayout {
  return {
    bounds: { left: 0, top: 0, right: 0, bottom: 0 },
    zone: { left: 0, top: 0, right: 0, bottom: 0 },
    stickRadius: 0,
    buttons: Array.from({ length: TOUCH_BUTTON_COUNT }, () => ({ cx: 0, cy: 0, r: 0 })),
  };
}

/** The button of `list` nearest to (x, y) in radii, if within `slop` radii; -1 for none. */
function buttonAt(layout: TouchLayout, list: readonly TouchButton[], x: number, y: number, slop: number): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    const c = layout.buttons[b];
    if (c === undefined || !(c.r > 0)) continue;
    const d = Math.hypot(x - c.cx, y - c.cy) / c.r;
    if (d <= slop && d < bestD) {
      best = b;
      bestD = d;
    }
  }
  return best;
}

/** `v` kept within lo..hi + the reach margin on each side; an axis too short for both margins takes its middle. Empty = `v`. */
function inside(v: number, lo: number, hi: number, reach: number): number {
  if (!(hi > lo)) return v;
  const a = lo + reach;
  const b = hi - reach;
  if (a > b) return (lo + hi) / 2;
  return v < a ? a : v > b ? b : v;
}

export class TouchRouter {
  private readonly state: TouchState;
  private layout: TouchLayout;
  private readonly fingers = new Map<number, Finger>();
  /** Fingers on each tap button that would fire it if lifted now (pendingTaps without walking the fingers). */
  private readonly taps = new Uint8Array(TOUCH_BUTTON_COUNT);
  private stickId = -1;
  private cx = 0;
  private cy = 0;
  private kx = 0;
  private ky = 0;
  private readonly vec: StickVector = { x: 0, y: 0 };

  constructor(state: TouchState, layout: TouchLayout = emptyLayout()) {
    this.state = state;
    this.layout = layout;
  }

  /** A new layout (resize, RESET shown or hidden). Fingers keep what they hold; the stick keeps its centre. */
  setLayout(layout: TouchLayout): void {
    this.layout = layout;
  }

  /** A finger owns the stick. */
  get stickActive(): boolean {
    return this.stickId >= 0;
  }

  /** Stick centre (where its finger landed, kept inside the screen), client px. */
  get stickX(): number {
    return this.cx;
  }

  get stickY(): number {
    return this.cy;
  }

  /** The stick finger's offset from the centre, clamped to the stick radius (the knob), px. */
  get knobX(): number {
    return this.kx;
  }

  get knobY(): number {
    return this.ky;
  }

  /** Fingers being tracked. */
  get fingerCount(): number {
    return this.fingers.size;
  }

  /** Bit per TB index: a finger is on that tap button and would fire it if lifted now. */
  get pendingTaps(): number {
    const taps = this.taps;
    let mask = 0;
    for (let b = 0; b < TOUCH_BUTTON_COUNT; b++) if (taps[b] > 0) mask |= 1 << b;
    return mask;
  }

  /** A finger landed at (x, y). A finger already tracked under `id` is cancelled first. */
  down(id: number, x: number, y: number): void {
    if (this.fingers.has(id)) this.up(id, x, y, true);
    const layout = this.layout;
    let b = buttonAt(layout, HOLD_BUTTONS, x, y, HIT_SLOP);
    if (b >= 0) {
      this.state.press(b as TouchButton);
      this.fingers.set(id, { kind: F_HOLD, button: b, keepBoost: false });
      return;
    }
    b = buttonAt(layout, TAP_BUTTONS, x, y, HIT_SLOP);
    if (b >= 0) {
      this.taps[b]++;
      this.fingers.set(id, { kind: F_TAP, button: b, keepBoost: false });
      return;
    }
    const z = layout.zone;
    if (x >= z.left && x < z.right && y >= z.top && y < z.bottom) {
      if (this.stickId < 0) {
        this.stickId = id;
        const s = layout.bounds;
        const reach = STICK_EDGE_REACH * layout.stickRadius;
        this.cx = inside(x, s.left, s.right, reach);
        this.cy = inside(y, s.top, s.bottom, reach);
        this.aim(x, y);
        this.fingers.set(id, { kind: F_STICK, button: -1, keepBoost: false });
      } else {
        this.fingers.set(id, { kind: F_NONE, button: -1, keepBoost: false });
      }
      return;
    }
    // The right half: nothing yet, a slide onto JUMP / BOOST / DRIFT presses it.
    this.fingers.set(id, { kind: x >= z.right ? F_HOLD : F_NONE, button: -1, keepBoost: false });
  }

  /** A tracked finger moved to (x, y). */
  move(id: number, x: number, y: number): void {
    const f = this.fingers.get(id);
    if (f === undefined) return;
    switch (f.kind) {
      case F_STICK:
        this.aim(x, y);
        break;
      case F_HOLD: {
        // Only a button's own circle switches (no slop): the gap between two buttons keeps the current one.
        const b = buttonAt(this.layout, HOLD_BUTTONS, x, y, 1);
        if (b >= 0 && b !== f.button) this.slide(f, b);
        break;
      }
      case F_TAP: {
        const c = this.layout.buttons[f.button];
        if (c === undefined || !hitCircle(x, y, c.cx, c.cy, c.r * HIT_SLOP)) {
          f.kind = F_NONE; // slid away: no tap
          this.taps[f.button]--;
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * A finger lifted at (x, y) (`cancel` = the browser took it: pointercancel, lost capture). It
   * releases what it held; a tap button fires once (TouchState's tap latch) when the finger lifts
   * on it. Unknown or already released ids are ignored.
   */
  up(id: number, x: number, y: number, cancel = false): void {
    const f = this.fingers.get(id);
    if (f === undefined) return;
    this.fingers.delete(id);
    const state = this.state;
    switch (f.kind) {
      case F_STICK:
        this.stickId = -1;
        this.kx = 0;
        this.ky = 0;
        state.setStick(0, 0);
        break;
      case F_HOLD:
        if (f.button >= 0) state.release(f.button as TouchButton);
        if (f.keepBoost) state.release(TB.BOOST);
        break;
      case F_TAP: {
        this.taps[f.button]--;
        const c = this.layout.buttons[f.button];
        if (!cancel && c !== undefined && hitCircle(x, y, c.cx, c.cy, c.r * HIT_SLOP)) {
          state.press(f.button as TouchButton);
          state.release(f.button as TouchButton);
        }
        break;
      }
      default:
        break;
    }
  }

  /** Forget every finger and everything they hold (TouchState included). */
  releaseAll(): void {
    this.fingers.clear();
    this.taps.fill(0);
    this.stickId = -1;
    this.kx = 0;
    this.ky = 0;
    this.state.releaseAll();
  }

  /** Point the stick at (x, y): the deflection for the state, the clamped offset for the knob. */
  private aim(x: number, y: number): void {
    const dx = x - this.cx;
    const dy = y - this.cy;
    const r = this.layout.stickRadius;
    const v = stickVector(dx, dy, r, undefined, undefined, this.vec);
    this.state.setStick(v.x, v.y);
    const d = Math.hypot(dx, dy);
    const k = d > r && d > 0 ? r / d : 1;
    this.kx = dx * k;
    this.ky = dy * k;
  }

  /** A holding finger reached button `b`: switch to it (BOOST, once held, stays held). */
  private slide(f: Finger, b: number): void {
    const state = this.state;
    const from = f.button;
    if (from === TB.BOOST) f.keepBoost = true;
    else if (from >= 0) state.release(from as TouchButton);
    if (b === TB.BOOST && f.keepBoost) f.keepBoost = false; // back on BOOST, which this finger still holds
    else state.press(b as TouchButton);
    f.button = b;
  }
}
