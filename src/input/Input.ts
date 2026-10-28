/**
 * Keyboard + mouse + gamepad → CarControls, camera look, held states and one-shot UI actions,
 * driven by the rebindable profiles in Settings (src/settings.ts + src/input/bindings.ts).
 *
 * `sample(out)` is called once per 120 Hz tick (and once per frame while a menu is open); it
 * writes into the caller's CarControls object and allocates nothing. Every ActionId is resolved
 * for BOTH devices each sample and the two are summed and clamped, so either device works at any
 * time. One-shot actions (ball cam, reset, pause, menu navigation) are edge-triggered flags on
 * `actions`, cleared by `consumeActions()`; `padActions` mirrors the gamepad-originated subset
 * (the DOM menu in Hud.ts listens to the keyboard itself, so the game forwards only those).
 * Scoreboard and rear view are HELD states on `held`; the camera swivel lives on `look`.
 *
 * Default bindings (DEFAULT_KBM / DEFAULT_PAD in bindings.ts)
 *
 *   Action              Keyboard + mouse         Controller (standard mapping, Xbox names)
 *   ------------------  -----------------------  ----------------------------------------
 *   Throttle / reverse  W / S  (and ↑ / ↓)       RT / LT (analog 0..1)
 *   Steer               A / D  (and ← / →)       Left stick X (× steering sensitivity)
 *   Air pitch           W nose down, S nose up   Left stick Y (forward = nose down)
 *   Air yaw             A / D                    Left stick X (× aerial sensitivity)
 *   Jump                Right mouse button       A
 *   Boost               Left mouse button        B
 *   Powerslide          Left Shift               X
 *   Air roll (hold)     Left Shift (A/D roll)    X (stick X rolls instead of yawing)
 *   Air roll left/right Q / E                    unbound
 *   Ball cam            Space                    Y
 *   Rear view (hold)    Middle mouse button      Right stick click
 *   Camera swivel       Mouse movement           Right stick
 *   Scoreboard (hold)   Tab                      Back
 *   Pause / menu        Esc                      Start
 *   Reset to kickoff    R                        unbound
 *   Training: reset     Backspace                D-pad ↓  (shot in a pack, ball in free play)
 *   Training: prev/next PgUp / PgDn              D-pad ← / →
 *   Free play: car      F                        D-pad ↑  (reset car to its spawn)
 *   Free play: boost    T                        LB       (toggle unlimited boost)
 *
 *   The arrows are second keys (KBM_SECONDARY, fixed): ↑ / ↓ as W / S, ← / → as A / D, on the
 *   ground and in the air, unless the player bound that arrow to an action of their own.
 *
 *   Fixed (not rebindable) menu keys: Enter / Numpad Enter accept, Esc / Backspace back, arrows and
 *   WASD navigate; gamepad A accept, B back, X controls & settings (the menus' context action),
 *   D-pad or left stick navigate (held: repeated, NAV_REPEAT_DELAY_MS then every NAV_REPEAT_MS),
 *   and for the menus only LB / RB (menuPrev / menuNext), LT / RT (menuTabPrev / menuTabNext, an
 *   analog trigger past NAV_TRIGGER_ON), Y (menuCancel) and Start (menuStart: Start is also the
 *   pause binding's edge). Nothing reads those in a match: the keyboard's menu shortcuts (Q / E / X /
 *   Delete) are src/ui/Menu.ts's own, only while the menus are up. (Space is deliberately not a menu
 *   key: it is the ball cam toggle.)
 *
 *   KEYBOARD_ONLY_KBM (preset 'keyboardOnly') differs in: Space jump, Left Shift boost, Z
 *   powerslide / air roll, C ball cam, X rear view (no browser modifier, see bindings.ts).
 *
 * Per frame: `beginFrame()` polls the gamepad once (navigator.getGamepads() allocates) and every
 * `sample()` of that frame reuses it; `latchEdges()` turns presses made while a menu was closing
 * into "already held" so they fire no one-shot edge on the first tick; `readEdges()` polls and
 * samples on a frame that runs no logic, keeping the edges for the next one.
 *
 * Mouse: the camera swivel is a VIRTUAL STICK. Each tick the mouse delta (pixels × k, where
 * sensitivity 5 ≈ a 300 px swipe for full deflection) is added to a 2D vector clamped to unit
 * length that decays toward 0 with a ~0.25 s time constant once the mouse stops, a smooth mouse
 * camera. Movement is only read while the pointer is locked (`requestPointerLock(canvas)`).
 * With `controls.mouseSteering` the mouse feeds steer / yaw (X) and pitch (Y) instead, through a
 * similar quickly-decaying stick, and `look` stays at 0.
 *
 * Touch: an optional `TouchSource` (`setTouchSource`, src/input/touchState.ts) adds one 0..1
 * value per action to the keyboard + mouse column each sample, so on-screen controls drive the
 * same actions, modifiers and edges as the keyboard (their edges never reach `padActions`).
 * Without a source the output is exactly what it is without touch support.
 */
import type { CarControls } from '../sim/types';
import { TICK_DT, emptyControls } from '../sim/types';
import type { Settings } from '../settings';
import {
  ACTION_IDS,
  GP,
  GP_MAX_AXES,
  GP_MAX_BUTTONS,
  KBM_SECONDARY,
  MAX_MOUSE_BUTTON,
  bindingLabel,
  bindingMatchesDevice,
  presetProfile,
  type ActionId,
  type Binding,
  type BindingPreset,
  type CameraLook,
  type Device,
} from './bindings';
import { isBackKey } from '../ui/backGuard';

/** Edge-triggered one-shot actions. Read after `sample()`, then call `consumeActions()`. */
export interface InputActions {
  toggleBallCam: boolean;
  reset: boolean;
  pause: boolean;
  accept: boolean;
  back: boolean;
  menuUp: boolean;
  menuDown: boolean;
  menuLeft: boolean;
  menuRight: boolean;
  /** The menuUp / Down / Left / Right of this sample are a held direction's auto-repeat, not a press. */
  menuRepeat: boolean;
  /** Menu edges of the pad only (src/ui/Menu.ts MenuCommand): LB / RB, LT / RT, Y, Start. */
  menuPrev: boolean;
  menuNext: boolean;
  menuTabPrev: boolean;
  menuTabNext: boolean;
  menuCancel: boolean;
  menuStart: boolean;
  /** Open the controls & settings screen / next tab; the menus' context action (fixed: gamepad X; the Hud handles the O key itself). */
  settings: boolean;
  /** Training edges (bindable; src/game/TrainingSession.ts): reset shot / ball, previous / next shot, reset car, unlimited boost. */
  trainingReset: boolean;
  trainingPrev: boolean;
  trainingNext: boolean;
  trainingResetCar: boolean;
  trainingBoost: boolean;
}

/** Actions that are true while their binding is held. Updated by `sample()`. */
export interface InputHeld {
  scoreboard: boolean;
  rearView: boolean;
}

/** The subset of Document that Input uses; injectable so node tests can fake pointer lock. */
export interface DocumentLike extends EventTarget {
  readonly pointerLockElement: unknown;
  readonly visibilityState: string;
  exitPointerLock(): void;
}

export interface InputOptions {
  /** Called after any change to settings.bindings / settings.controls made through Input. */
  onChange?: () => void;
  /** Defaults to the global `document` when there is one. */
  document?: DocumentLike | null;
  /** The clock of the menu auto-repeat (ms; default performance.now), injectable for tests. */
  now?: () => number;
}

/**
 * On-screen touch controls (TouchState in src/input/touchState.ts). `read` is called once per
 * `sample()`, before the actions are resolved, and must write every index of `out` (one value
 * in 0..1 per ACTION_IDS index, 0 for the actions it does not drive) without allocating. Input
 * clamps each value to 0..1 (NaN = 0), so a faulty source can add at most one full press per
 * action and never cancels the keyboard or the pad. The values are summed into the keyboard +
 * mouse column, so they count as keyboard input for the edges (`actions`, never
 * `padActions`); the camera look actions ignore them.
 */
export interface TouchSource {
  read(out: Float64Array): void;
  /**
   * Optional: forget every finger. Called with Input's own release (window blur, page hidden,
   * `dispose`), so a finger down when focus is lost does not stay pressed. The overlay still
   * releases on its own pointer events.
   */
  releaseAll?(): void;
}

/** What `startRebind` is currently waiting for. */
export interface RebindTarget {
  readonly action: ActionId;
  readonly device: Device;
}

/** Which device moved the camera swivel last (the chase camera picks its tilt limit from it). */
export type LookSource = 'none' | 'mouse' | 'pad' | 'keys';

interface Capture {
  target: RebindTarget;
  resolve: (b: Binding | null) => void;
  timer: ReturnType<typeof setTimeout> | null;
  /**
   * False until the macrotask after `startRebind`: the key / button press whose handler started
   * the capture must not be the press that ends it, whichever listener (Hud or Input) ran first.
   */
  armed: boolean;
  /** Keys / mouse buttons already held when the capture started (ignored until released). */
  ignoreKeys: Set<string>;
  ignoreMouse: number;
  /** Wheel events are captured only over this element (null = anywhere). */
  wheelTarget: EventTarget | null;
  /** A pad capture's B went down then (the clock's ms; -1: not held): its release binds it, CAPTURE_CANCEL_HOLD_MS held cancels. */
  holdB: number;
}

// Duck-typed event views (node has no KeyboardEvent / MouseEvent classes).
interface KeyLike {
  key?: unknown;
  code?: unknown;
  repeat?: unknown;
  altKey?: unknown;
  ctrlKey?: unknown;
  metaKey?: unknown;
}
interface MouseLike {
  button?: unknown;
  movementX?: unknown;
  movementY?: unknown;
  deltaY?: unknown;
}

/** Minimal structural view of the (still evolving) Gamepad haptics API. */
interface HapticActuatorLike {
  playEffect?: (type: string, params: { duration: number; startDelay: number; strongMagnitude: number; weakMagnitude: number }) => Promise<unknown>;
}

interface PointerLockable {
  requestPointerLock?: (options?: { unadjustedMovement: boolean }) => unknown;
}

const N = ACTION_IDS.length;
function idx(a: ActionId): number {
  return ACTION_IDS.indexOf(a);
}
const I_THROTTLE = idx('throttle');
const I_REVERSE = idx('reverse');
const I_STEER_L = idx('steerLeft');
const I_STEER_R = idx('steerRight');
const I_PITCH_UP = idx('pitchUp');
const I_PITCH_DOWN = idx('pitchDown');
const I_YAW_L = idx('yawLeft');
const I_YAW_R = idx('yawRight');
const I_JUMP = idx('jump');
const I_BOOST = idx('boost');
const I_POWERSLIDE = idx('powerslide');
const I_AIRROLL = idx('airRoll');
const I_ROLL_L = idx('airRollLeft');
const I_ROLL_R = idx('airRollRight');
const I_BALLCAM = idx('ballCam');
const I_REARVIEW = idx('rearView');
const I_LOOK_L = idx('lookLeft');
const I_LOOK_R = idx('lookRight');
const I_LOOK_U = idx('lookUp');
const I_LOOK_D = idx('lookDown');
const I_SCOREBOARD = idx('scoreboard');
const I_PAUSE = idx('pause');
const I_RESET = idx('reset');
const I_TRN_RESET = idx('trainingReset');
const I_TRN_PREV = idx('trainingPrev');
const I_TRN_NEXT = idx('trainingNext');
const I_TRN_CAR = idx('trainingResetCar');
const I_TRN_BOOST = idx('trainingBoost');
const I_LOOK_FIRST = Math.min(I_LOOK_L, I_LOOK_R, I_LOOK_U, I_LOOK_D);
const I_LOOK_LAST = Math.max(I_LOOK_L, I_LOOK_R, I_LOOK_U, I_LOOK_D);

/** Which sensitivity scales a gamepad AXIS bound to the action: 0 none, 1 steering, 2 aerial. */
const AXIS_SENS = new Uint8Array(N);
AXIS_SENS[I_STEER_L] = AXIS_SENS[I_STEER_R] = 1;
AXIS_SENS[I_PITCH_UP] = AXIS_SENS[I_PITCH_DOWN] = AXIS_SENS[I_YAW_L] = AXIS_SENS[I_YAW_R] = AXIS_SENS[I_ROLL_L] = AXIS_SENS[I_ROLL_R] = 2;

/** Left stick deflection that counts as a menu navigation press. */
const NAV_STICK_THRESHOLD = 0.6;
/** A held menu direction repeats after this (ms), then every NAV_REPEAT_MS: a TV list walked by holding ↓. */
export const NAV_REPEAT_DELAY_MS = 400;
export const NAV_REPEAT_MS = 80;
/** LT / RT as menu edges: past ON (some TV pads' analog triggers rest a little pressed), re-armed under OFF. */
const NAV_TRIGGER_ON = 0.5;
const NAV_TRIGGER_OFF = 0.3;
/** Menu directions (navHeld). */
const NAV_NONE = 0;
const NAV_UP = 1;
const NAV_DOWN = 2;
const NAV_LEFT = 3;
const NAV_RIGHT = 4;
/** Axis deflection that is captured as a binding by startRebind. */
const CAPTURE_AXIS_THRESHOLD = 0.6;
const REBIND_TIMEOUT_MS = 10_000;
/** A controller's B held this long during a pad capture cancels it (Ajustes: "Hold B to cancel"); a shorter press binds B. */
export const CAPTURE_CANCEL_HOLD_MS = 1000;
/** Mouse travel for full deflection at sensitivity 5 (k = sensitivity / (5 × this)). */
const PX_FULL_DEFLECTION_AT_5 = 300;
const SENS_REF = 5;
/** Per-tick decay factors (time constants 0.25 s for the camera stick, 0.06 s for mouse steering). */
const LOOK_DECAY = Math.exp(-TICK_DT / 0.25);
const STEER_DECAY = Math.exp(-TICK_DT / 0.06);
/** Ticks without a mousemove before a virtual stick starts decaying (mice report at ≥125 Hz). */
const IDLE_TICKS_BEFORE_DECAY = 2;
/** Below this deflection a decaying virtual stick snaps to 0 (the camera stick gets there in ~1 s). */
const STICK_EPS = 0.02;
const MAX_MOUSE_DELTA = 10_000;

const PREVENT_DEFAULT_KEYS: ReadonlySet<string> = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']);

/** NaN-safe clamp to ±1 (NaN → 0). */
function clamp1(v: number): number {
  return v > 1 ? 1 : v < -1 ? -1 : v === v ? v : 0;
}

function finiteOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function clampRange(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function buttonPressed(gp: Gamepad, i: number): boolean {
  if (i < 0 || i >= gp.buttons.length) return false;
  const b = gp.buttons[i];
  return b.pressed || b.value > 0.5;
}

/** Analog value of a button (triggers), 1 for a pressed digital button, else 0. Never NaN. */
function buttonValue(gp: Gamepad, i: number): number {
  if (i < 0 || i >= gp.buttons.length) return 0;
  const b = gp.buttons[i];
  const v = b.value;
  return v > 0 ? (v > 1 ? 1 : v) : b.pressed ? 1 : 0;
}

/** Menu direction `dir` (NAV_UP...) still held: its D-pad button, or the left stick past the threshold that way. */
function navStillHeld(gp: Gamepad, dir: number, x: number, y: number): boolean {
  switch (dir) {
    case NAV_UP:
      return buttonPressed(gp, GP.DPAD_UP) || y < -NAV_STICK_THRESHOLD;
    case NAV_DOWN:
      return buttonPressed(gp, GP.DPAD_DOWN) || y > NAV_STICK_THRESHOLD;
    case NAV_LEFT:
      return buttonPressed(gp, GP.DPAD_LEFT) || x < -NAV_STICK_THRESHOLD;
    default:
      return buttonPressed(gp, GP.DPAD_RIGHT) || x > NAV_STICK_THRESHOLD;
  }
}

function clearActions(a: InputActions): void {
  a.toggleBallCam = false;
  a.reset = false;
  a.pause = false;
  a.accept = false;
  a.back = false;
  a.menuUp = false;
  a.menuDown = false;
  a.menuLeft = false;
  a.menuRight = false;
  a.menuRepeat = false;
  a.menuPrev = false;
  a.menuNext = false;
  a.menuTabPrev = false;
  a.menuTabNext = false;
  a.menuCancel = false;
  a.menuStart = false;
  a.settings = false;
  a.trainingReset = false;
  a.trainingPrev = false;
  a.trainingNext = false;
  a.trainingResetCar = false;
  a.trainingBoost = false;
}

function newActions(): InputActions {
  return {
    toggleBallCam: false,
    reset: false,
    pause: false,
    accept: false,
    back: false,
    menuUp: false,
    menuDown: false,
    menuLeft: false,
    menuRight: false,
    menuRepeat: false,
    menuPrev: false,
    menuNext: false,
    menuTabPrev: false,
    menuTabNext: false,
    menuCancel: false,
    menuStart: false,
    settings: false,
    trainingReset: false,
    trainingPrev: false,
    trainingNext: false,
    trainingResetCar: false,
    trainingBoost: false,
  };
}

function tagOf(target: EventTarget | null): string | null {
  if (target === null || typeof target !== 'object') return null;
  const tag = (target as { tagName?: unknown }).tagName;
  return typeof tag === 'string' ? tag : null;
}

/** Text entry elements: the keyboard belongs to them. */
function isTextField(target: EventTarget | null): boolean {
  const tag = tagOf(target);
  if (tag === null) return false;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (target as { isContentEditable?: unknown }).isContentEditable === true;
}

/** HUD controls: mouse presses on them are clicks, not game input. */
function isUiControl(target: EventTarget | null): boolean {
  if (isTextField(target)) return true;
  const tag = tagOf(target);
  return tag === 'BUTTON' || tag === 'A' || tag === 'LABEL' || tag === 'SUMMARY';
}

function isPromiseLike(v: unknown): v is Promise<unknown> {
  return typeof v === 'object' && v !== null && typeof (v as { catch?: unknown }).catch === 'function';
}

/** `target` is `container` or inside it (duck-typed `Node.contains`; node has no DOM). */
function isWithin(target: EventTarget | null, container: EventTarget): boolean {
  if (target === container) return true;
  if (target === null) return false;
  const contains = (container as { contains?: unknown }).contains;
  return typeof contains === 'function' && (contains as (n: EventTarget) => boolean).call(container, target) === true;
}

function validMouseButton(button: unknown): button is number {
  return typeof button === 'number' && Number.isInteger(button) && button >= 0 && button <= MAX_MOUSE_BUTTON;
}

export class Input {
  /** The live settings object (Input mutates `controls` and `bindings` in place). */
  readonly settings: Settings;

  readonly actions: InputActions = newActions();

  /**
   * The subset of `actions` that came from the GAMEPAD. The DOM menu in Hud.ts already listens
   * to the keyboard itself, so the game forwards only these to it; the keyboard copy in
   * `actions` would otherwise trigger every menu action twice.
   */
  readonly padActions: InputActions = newActions();

  /** Held (non-edge) actions, valid after `sample()`. */
  readonly held: InputHeld = { scoreboard: false, rearView: false };

  /** Camera swivel for the chase camera, valid after `sample()`. */
  readonly look: CameraLook = { x: 0, y: 0, rearView: false };

  /** Fired from the document's pointerlockchange / pointerlockerror events. */
  onPointerLockChange?: (locked: boolean) => void;

  private readonly target: EventTarget;
  /** Where mouseup / mousemove are listened to (window when there is one, so releases outside an element target are seen). */
  private readonly upTarget: EventTarget;
  private readonly doc: DocumentLike | null;
  private readonly onChange: (() => void) | null;

  private readonly keys = new Set<string>();
  /** Keys pressed since the last sample(); keeps a tap shorter than one tick alive for one tick. */
  private readonly tapped = new Set<string>();
  /** Keyboard codes bound to any kbm action (their default browser action is suppressed). */
  private readonly boundKeys = new Set<string>();
  /** Per action: its KBM_SECONDARY key while no kbm binding uses that key, else null (refreshDerived). */
  private readonly secondary: (string | null)[] = new Array<string | null>(N).fill(null);
  private mouseHeld = 0;
  private mouseTapped = 0;
  /** Buttons whose current press is the click that captured the mouse (ignored until released). */
  private mouseMask = 0;
  /** Back / forward buttons whose press ended a rebind capture: their release is cancelled (no history walk). */
  private mouseEat = 0;
  /** Bit 1 = wheel up, bit 2 = wheel down, since the last sample. */
  private wheelTaps = 0;
  private mouseDX = 0;
  private mouseDY = 0;
  private lockElement: HTMLElement | null = null;
  private locked = false;

  private padIndex = -1;
  private padId: string | null = null;
  private gamepadsUnavailable = false;
  /** Gamepad snapshot of the current animation frame (see beginFrame). */
  private framePad: Gamepad | null = null;
  private framePadValid = false;
  private lookSrc: LookSource = 'none';
  /** Output of latchEdges() (discarded). */
  private readonly scratch: CarControls = emptyControls();
  private readonly prevButtons = new Uint8Array(GP_MAX_BUTTONS);
  /** Raw (clamped) axis values of the previous sample, for capture crossings. */
  private readonly prevAxes = new Float64Array(GP_MAX_AXES);
  /** Dead-zoned axis values of the current sample. */
  private readonly stick = new Float64Array(GP_MAX_AXES);
  private prevNavX = 0;
  private prevNavY = 0;
  /** The menu direction held for the auto-repeat (the one pressed last; NAV_NONE when none) and when it fires next. */
  private navHeld = NAV_NONE;
  private navNextAt = 0;
  /** LT (bit 1) / RT (bit 2) past NAV_TRIGGER_ON and not yet back under NAV_TRIGGER_OFF. */
  private triggers = 0;
  private readonly now: () => number;
  /** Gamepad button presses seen so far (see gamepadPresses). */
  private padPresses = 0;

  /** Per-action values of this sample: keyboard/mouse digital, mouse-axis (look only), gamepad. */
  private readonly kd = new Float64Array(N);
  private readonly km = new Float64Array(N);
  private readonly pv = new Float64Array(N);
  private readonly prevKd = new Uint8Array(N);
  private readonly prevPv = new Uint8Array(N);
  /** Touch values of this sample, one per action (all 0 without a touch source). */
  private readonly tv = new Float64Array(N);
  private touch: TouchSource | null = null;

  private lookVX = 0;
  private lookVY = 0;
  private lookIdle = IDLE_TICKS_BEFORE_DECAY;
  private steerVX = 0;
  private steerVY = 0;
  private steerIdle = IDLE_TICKS_BEFORE_DECAY;

  // Derived from settings.controls by refreshDerived() (constructor / settingsChanged / setBinding).
  private deadzone = 0.1;
  private steerSens = 1;
  private airSens = 1;
  private kLook = 1 / PX_FULL_DEFLECTION_AT_5;
  private kSteer = 1 / PX_FULL_DEFLECTION_AT_5;

  private jumpBlocked = false;
  private boostBlocked = false;
  private capture: Capture | null = null;
  private disposed = false;

  private readonly onKeyDown = (e: Event): void => {
    const code = (e as KeyLike).code;
    if (typeof code !== 'string' || code === '') return;
    if (isTextField(e.target)) return;
    const ke = e as KeyLike;
    const cap = this.capture;
    if (cap !== null) {
      // Escape cancels a capture on EITHER device (a pad capture has no other keyboard exit).
      if (code === 'Escape') {
        e.preventDefault();
        this.endCapture(null);
        return;
      }
      if (cap.target.device === 'kbm') {
        // A back key is the system Back (src/ui/backGuard.ts), whose step cancels the capture
        // (Game.onSystemBack), as Esc does: never a binding (it would pause the match on each press).
        if (isBackKey(ke)) return;
        e.preventDefault();
        if (!cap.armed || ke.repeat === true || cap.ignoreKeys.has(code)) return;
        this.endCapture({ kind: 'key', code });
        return;
      }
    }
    // Bound keys lose their browser default, except with Ctrl / Meta so reload, DevTools and the
    // like keep working. (Ctrl + W / T / N / Q are browser-reserved anyway: preventDefault cannot
    // stop them outside the Keyboard Lock API, which is why no preset binds Ctrl.) Alt + ← / → keep
    // theirs, the browser's Back / Forward (Windows, Linux; the system Back: backGuard.ts), unless
    // the player binds an Alt key (air roll on L Alt + the arrows that steer is a game combo).
    const historyKey = ke.altKey === true && (code === 'ArrowLeft' || code === 'ArrowRight') && !this.boundKeys.has('AltLeft') && !this.boundKeys.has('AltRight');
    if (!historyKey && (PREVENT_DEFAULT_KEYS.has(code) || (this.boundKeys.has(code) && ke.ctrlKey !== true && ke.metaKey !== true))) e.preventDefault();
    if (ke.repeat === true) return;
    this.keys.add(code);
    this.tapped.add(code);
    // Fixed menu navigation (keyboard → `actions` only; the Hud listens to the keyboard itself).
    const a = this.actions;
    switch (code) {
      case 'Enter':
      case 'NumpadEnter':
        a.accept = true;
        break;
      case 'Escape':
      case 'Backspace':
        a.back = true;
        break;
      case 'ArrowUp':
      case 'KeyW':
        a.menuUp = true;
        break;
      case 'ArrowDown':
      case 'KeyS':
        a.menuDown = true;
        break;
      case 'ArrowLeft':
      case 'KeyA':
        a.menuLeft = true;
        break;
      case 'ArrowRight':
      case 'KeyD':
        a.menuRight = true;
        break;
      default:
        break;
    }
  };

  private readonly onKeyUp = (e: Event): void => {
    const code = (e as KeyLike).code;
    if (typeof code !== 'string') return;
    this.keys.delete(code);
    const cap = this.capture;
    if (cap !== null) cap.ignoreKeys.delete(code);
  };

  private readonly onMouseDown = (e: Event): void => {
    const button = (e as MouseLike).button;
    if (!validMouseButton(button)) return;
    if (isUiControl(e.target)) return;
    if (this.locked || e.target === this.lockElement || e.target === this.target) e.preventDefault();
    const bit = 1 << button;
    const cap = this.capture;
    if (cap !== null && cap.target.device === 'kbm') {
      if (cap.armed && button <= 4 && (cap.ignoreMouse & bit) === 0) {
        // A back / forward button bound here walks the history on its release unless cancelled.
        if (button >= 3) this.mouseEat |= bit;
        this.endCapture({ kind: 'mouse', button });
      }
      return;
    }
    this.mouseHeld |= bit;
    this.mouseTapped |= bit;
  };

  private readonly onMouseUp = (e: Event): void => {
    const button = (e as MouseLike).button;
    if (!validMouseButton(button)) return;
    // Back / forward buttons navigate on release; keep them for the game when it has the mouse,
    // and for the rebind capture that just took one (wherever the pointer is).
    const bit = 1 << button;
    if (button >= 3 && ((this.mouseEat & bit) !== 0 || this.locked || e.target === this.lockElement || e.target === this.target)) e.preventDefault();
    this.mouseEat &= ~bit;
    this.mouseHeld &= ~bit;
    if ((this.mouseMask & bit) !== 0) {
      // The click that captured the mouse is over: it was not a tap either.
      this.mouseMask &= ~bit;
      this.mouseTapped &= ~bit;
    }
    const cap = this.capture;
    if (cap !== null) cap.ignoreMouse &= ~bit;
  };

  private readonly onContextMenu = (e: Event): void => {
    if (this.locked || e.target === this.lockElement || e.target === this.target) e.preventDefault();
  };

  private readonly onWheel = (e: Event): void => {
    const dy = (e as MouseLike).deltaY;
    if (typeof dy !== 'number' || !Number.isFinite(dy) || dy === 0) return;
    if (this.locked) e.preventDefault();
    const sign: 1 | -1 = dy < 0 ? -1 : 1;
    const cap = this.capture;
    if (cap !== null) {
      // Only a wheel turned over the capturing cell binds (scrolling the list must not).
      if (cap.armed && cap.target.device === 'kbm' && (cap.wheelTarget === null || isWithin(e.target, cap.wheelTarget))) {
        this.endCapture({ kind: 'wheel', sign });
      }
      return;
    }
    this.wheelTaps |= sign < 0 ? 1 : 2;
  };

  private readonly onMouseMove = (e: Event): void => {
    if (!this.locked) return;
    const me = e as MouseLike;
    const mx = me.movementX;
    const my = me.movementY;
    if (typeof mx === 'number' && Number.isFinite(mx)) this.mouseDX = clampRange(this.mouseDX + mx, -MAX_MOUSE_DELTA, MAX_MOUSE_DELTA);
    if (typeof my === 'number' && Number.isFinite(my)) this.mouseDY = clampRange(this.mouseDY + my, -MAX_MOUSE_DELTA, MAX_MOUSE_DELTA);
  };

  private readonly onBlur = (): void => {
    this.releaseAll();
  };

  private readonly onVisibility = (): void => {
    if (this.doc !== null && this.doc.visibilityState !== 'visible') this.releaseAll();
  };

  private readonly onLockChange = (): void => {
    const doc = this.doc;
    const el = doc === null ? null : doc.pointerLockElement;
    const locked = el !== null && el !== undefined;
    if (locked === this.locked) return;
    this.locked = locked;
    this.mouseDX = 0;
    this.mouseDY = 0;
    const cb = this.onPointerLockChange;
    if (cb !== undefined) cb(locked);
  };

  private readonly onPadConnected = (e: GamepadEvent): void => {
    if (this.padIndex < 0) this.setPad(e.gamepad);
  };

  private readonly onPadDisconnected = (e: GamepadEvent): void => {
    if (this.padIndex === e.gamepad.index) this.setPad(null);
  };

  constructor(target: Window | HTMLElement, settings: Settings, opts?: InputOptions) {
    this.settings = settings;
    this.onChange = opts?.onChange ?? null;
    this.now = opts?.now ?? (() => performance.now());
    this.doc = opts?.document !== undefined ? opts.document : typeof document !== 'undefined' ? document : null;
    this.target = target;
    const win: EventTarget | null = typeof window !== 'undefined' ? window : null;
    this.upTarget = win !== null ? win : target;
    this.refreshDerived();

    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('blur', this.onBlur);
    target.addEventListener('mousedown', this.onMouseDown);
    target.addEventListener('contextmenu', this.onContextMenu);
    target.addEventListener('wheel', this.onWheel, { passive: false });
    this.upTarget.addEventListener('mouseup', this.onMouseUp);
    this.upTarget.addEventListener('mousemove', this.onMouseMove, { passive: true });
    if (win !== null) {
      win.addEventListener('gamepadconnected', this.onPadConnected as EventListener);
      win.addEventListener('gamepaddisconnected', this.onPadDisconnected as EventListener);
      if (target !== win) win.addEventListener('blur', this.onBlur);
    }
    const doc = this.doc;
    if (doc !== null) {
      doc.addEventListener('visibilitychange', this.onVisibility);
      doc.addEventListener('pointerlockchange', this.onLockChange);
      doc.addEventListener('pointerlockerror', this.onLockChange);
      this.locked = doc.pointerLockElement !== null && doc.pointerLockElement !== undefined;
    }
  }

  /** `Gamepad.id` of the active controller, or null when driving with the keyboard. */
  get gamepadName(): string | null {
    return this.padId;
  }

  /** True while a controller is connected. */
  get hasGamepad(): boolean {
    return this.padIndex >= 0;
  }

  /**
   * Gamepad button presses (rising edges of any button) seen by `sample()` so far. A change means
   * the pad is being used, which `hasGamepad` (merely connected) cannot tell; the touch controls
   * turn touch mode off on it.
   */
  get gamepadPresses(): number {
    return this.padPresses;
  }

  /** Enter (either) or the pad's A is down now: the pause's QUIT is held with them (Hud.pauseHoldRelease). */
  get acceptHeld(): boolean {
    return this.keys.has('Enter') || this.keys.has('NumpadEnter') || this.prevButtons[GP.A] === 1;
  }

  /** True while the game owns the mouse (document.pointerLockElement is set). */
  get pointerLocked(): boolean {
    return this.locked;
  }

  /** True while `startRebind` is waiting for a press (driving input is ignored meanwhile). */
  get rebinding(): boolean {
    return this.capture !== null;
  }

  /** The action / device `startRebind` is waiting for, or null. */
  get rebindTarget(): RebindTarget | null {
    return this.capture === null ? null : this.capture.target;
  }

  /**
   * The device that last moved the camera swivel ('none' until something does). The chase camera
   * uses the wider mouse tilt limit only for 'mouse', whether or not a controller is connected.
   */
  get lookSource(): LookSource {
    return this.lookSrc;
  }

  // ---- Pointer lock -------------------------------------------------------------------------

  /**
   * Ask for pointer lock on `element` (call from a user gesture, e.g. a click on the canvas).
   * Tries raw (`unadjustedMovement`) input first and falls back to the plain request; failures
   * are swallowed — watch `onPointerLockChange` / `pointerLocked` for the result. Pass the
   * `button` of the click that asks for the lock: that press is then not game input (the
   * capture click must not boost / jump) until it is released.
   */
  requestPointerLock(element: HTMLElement, button?: number): void {
    if (validMouseButton(button)) this.mouseMask |= 1 << button;
    this.lockElement = element;
    const el = element as unknown as PointerLockable;
    const req = el.requestPointerLock;
    if (typeof req !== 'function') return;
    if (this.doc !== null && this.doc.pointerLockElement === element) return;
    const plain = (): void => {
      try {
        const r = req.call(el);
        if (isPromiseLike(r)) r.catch(() => undefined);
      } catch {
        /* unsupported */
      }
    };
    try {
      const r = req.call(el, { unadjustedMovement: true });
      if (isPromiseLike(r)) r.catch(plain);
    } catch {
      plain();
    }
  }

  exitPointerLock(): void {
    const doc = this.doc;
    if (doc === null) return;
    try {
      doc.exitPointerLock();
    } catch {
      /* not locked / unsupported */
    }
  }

  // ---- Sampling -----------------------------------------------------------------------------

  /**
   * Plug in the on-screen touch controls, or remove them with null. Every `sample()` reads the
   * source once and sums it into the keyboard + mouse column (see TouchSource).
   */
  setTouchSource(src: TouchSource | null): void {
    this.touch = src;
  }

  /**
   * Poll the gamepad once for this animation frame; every `sample()` until the next
   * `beginFrame()` reuses the snapshot (navigator.getGamepads() allocates a fresh array / pad
   * objects per call, and pad state only changes once per frame). Call at the top of the frame,
   * before the tick loop. Callers that never call it get one poll per sample.
   */
  beginFrame(): void {
    this.framePad = this.pollGamepad();
    this.framePadValid = true;
  }

  /**
   * Sample the current control state into `out`, and update `actions` / `padActions` edges,
   * `held`, `look` and `lookSource`. Call once per sim tick. Analog values are keyboard + mouse +
   * touch + gamepad, clamped to ±1; booleans are OR-ed. While a rebind capture is pending every
   * driving output is zero and no one-shot action fires. No allocations.
   */
  sample(out: CarControls): void {
    const gp = this.framePadValid ? this.framePad : this.pollGamepad();
    const capturing = this.capture !== null;
    if (gp !== null) this.processGamepad(gp);
    else this.clearStick();

    const bindings = this.settings.bindings;
    const kbm = bindings.kbm;
    const pad = bindings.pad;
    const s = this.settings.controls;
    const mouseSteering = s.mouseSteering === true;

    // Mouse travel since the last sample (consumed here).
    let dx = this.mouseDX;
    let dy = this.mouseDY;
    this.mouseDX = 0;
    this.mouseDY = 0;
    if (capturing) {
      dx = 0;
      dy = 0;
    }
    const lookDX = mouseSteering ? 0 : dx;
    const lookDY = mouseSteering ? 0 : dy;

    // --- Resolve every action for both devices -------------------------------------------
    const kd = this.kd;
    const km = this.km;
    const pv = this.pv;
    const keys = this.keys;
    const tapped = this.tapped;
    const stick = this.stick;
    const mouseBits = (this.mouseHeld | this.mouseTapped) & ~this.mouseMask;
    const wheelTaps = this.wheelTaps;
    const kLook = this.kLook;
    // Touch (setTouchSource): read once, joins the keyboard + mouse column below.
    const tv = this.tv;
    const touch = this.touch;
    if (touch !== null) touch.read(tv);
    else tv.fill(0);
    for (let i = 0; i < N; i++) {
      const action = ACTION_IDS[i];
      let d = 0;
      let m = 0;
      const kb = kbm[action];
      if (kb) {
        switch (kb.kind) {
          case 'key':
            d = keys.has(kb.code) || tapped.has(kb.code) ? 1 : 0;
            break;
          case 'mouse':
            d = (mouseBits & (1 << kb.button)) !== 0 ? 1 : 0;
            break;
          case 'wheel':
            d = (wheelTaps & (kb.sign < 0 ? 1 : 2)) !== 0 ? 1 : 0;
            break;
          case 'mouseAxis': {
            const v = kb.sign * (kb.axis === 'x' ? lookDX : lookDY);
            m = v > 0 ? v * kLook : 0;
            break;
          }
          default:
            break;
        }
      }
      const sk = this.secondary[i]; // the arrows drive too (KBM_SECONDARY)
      if (sk !== null && d === 0 && (keys.has(sk) || tapped.has(sk))) d = 1;
      if (i >= I_LOOK_FIRST && i <= I_LOOK_LAST) {
        kd[i] = d;
        km[i] = m; // look: mouse travel goes through the virtual stick below
      } else {
        const t = tv[i]; // touch counts as keyboard (edges bit 1), clamped to 0..1 (NaN = 0)
        kd[i] = d + m + (t > 0 ? (t < 1 ? t : 1) : 0);
        km[i] = 0;
      }
      let p = 0;
      const pb = pad[action];
      if (gp !== null && pb) {
        switch (pb.kind) {
          case 'gpButton':
            p = buttonValue(gp, pb.index);
            break;
          case 'gpAxis': {
            const ai = pb.index;
            if (ai >= 0 && ai < GP_MAX_AXES) {
              const v = pb.sign * stick[ai];
              if (v > 0) {
                const sk = AXIS_SENS[i];
                p = sk === 1 ? v * this.steerSens : sk === 2 ? v * this.airSens : v;
              }
            }
            break;
          }
          default:
            break;
        }
      }
      pv[i] = p;
    }
    tapped.clear();
    this.mouseTapped = 0;
    this.wheelTaps = 0;

    // --- One-shot edges (prev state is tracked even while capturing so the captured press does not fire) ---
    const a = this.actions;
    const pa = this.padActions;
    const fire = !capturing;
    let e = this.edges(I_BALLCAM);
    if (fire && e !== 0) {
      a.toggleBallCam = true;
      if ((e & 2) !== 0) pa.toggleBallCam = true;
    }
    e = this.edges(I_RESET);
    if (fire && e !== 0) {
      a.reset = true;
      if ((e & 2) !== 0) pa.reset = true;
    }
    e = this.edges(I_PAUSE);
    if (fire && e !== 0) {
      a.pause = true;
      a.back = true;
      if ((e & 2) !== 0) {
        pa.pause = true;
        pa.back = true;
      }
    }
    // Training edges (only the Game's training mode reads them; in a match they do nothing).
    e = this.edges(I_TRN_RESET);
    if (fire && e !== 0) {
      a.trainingReset = true;
      if ((e & 2) !== 0) pa.trainingReset = true;
    }
    e = this.edges(I_TRN_PREV);
    if (fire && e !== 0) {
      a.trainingPrev = true;
      if ((e & 2) !== 0) pa.trainingPrev = true;
    }
    e = this.edges(I_TRN_NEXT);
    if (fire && e !== 0) {
      a.trainingNext = true;
      if ((e & 2) !== 0) pa.trainingNext = true;
    }
    e = this.edges(I_TRN_CAR);
    if (fire && e !== 0) {
      a.trainingResetCar = true;
      if ((e & 2) !== 0) pa.trainingResetCar = true;
    }
    e = this.edges(I_TRN_BOOST);
    if (fire && e !== 0) {
      a.trainingBoost = true;
      if ((e & 2) !== 0) pa.trainingBoost = true;
    }

    // --- Held states ---------------------------------------------------------------------
    const held = this.held;
    held.scoreboard = fire && kd[I_SCOREBOARD] + pv[I_SCOREBOARD] > 0.5;
    held.rearView = fire && kd[I_REARVIEW] + pv[I_REARVIEW] > 0.5;

    // --- Camera look: mouse virtual stick + digital + right stick ------------------------
    const mx = km[I_LOOK_R] - km[I_LOOK_L];
    const my = km[I_LOOK_D] - km[I_LOOK_U];
    let vx = this.lookVX;
    let vy = this.lookVY;
    if (mx !== 0 || my !== 0) {
      vx += mx;
      vy += my;
      const len = Math.sqrt(vx * vx + vy * vy);
      if (len > 1) {
        vx /= len;
        vy /= len;
      }
      this.lookIdle = 0;
    } else if (this.lookIdle >= IDLE_TICKS_BEFORE_DECAY) {
      vx *= LOOK_DECAY;
      vy *= LOOK_DECAY;
      if (vx < STICK_EPS && vx > -STICK_EPS && vy < STICK_EPS && vy > -STICK_EPS) {
        vx = 0;
        vy = 0;
      }
    } else {
      this.lookIdle++;
    }
    this.lookVX = vx;
    this.lookVY = vy;
    const plx = pv[I_LOOK_R] - pv[I_LOOK_L];
    const ply = pv[I_LOOK_D] - pv[I_LOOK_U];
    const klx = kd[I_LOOK_R] - kd[I_LOOK_L];
    const kly = kd[I_LOOK_D] - kd[I_LOOK_U];
    const look = this.look;
    look.x = fire ? clamp1(vx + klx + plx) : 0;
    look.y = fire ? clamp1(vy + kly + ply) : 0;
    look.rearView = held.rearView;
    // Whichever source deflects the most owns the swivel (an idle pad never demotes the mouse).
    const m2 = vx * vx + vy * vy;
    const p2 = plx * plx + ply * ply;
    const k2 = klx * klx + kly * kly;
    if (m2 > 0 || p2 > 0 || k2 > 0) this.lookSrc = m2 >= p2 && m2 >= k2 ? 'mouse' : p2 >= k2 ? 'pad' : 'keys';

    // --- Mouse steering virtual stick ---------------------------------------------------
    if (mouseSteering) {
      if (dx !== 0 || dy !== 0) {
        const k = this.kSteer;
        this.steerVX = clamp1(this.steerVX + dx * k);
        this.steerVY = clamp1(this.steerVY + dy * k);
        this.steerIdle = 0;
      } else if (this.steerIdle >= IDLE_TICKS_BEFORE_DECAY) {
        let sx = this.steerVX * STEER_DECAY;
        let sy = this.steerVY * STEER_DECAY;
        if (sx < STICK_EPS && sx > -STICK_EPS && sy < STICK_EPS && sy > -STICK_EPS) {
          sx = 0;
          sy = 0;
        }
        this.steerVX = sx;
        this.steerVY = sy;
      } else {
        this.steerIdle++;
      }
    } else if (this.steerVX !== 0 || this.steerVY !== 0) {
      this.steerVX = 0;
      this.steerVY = 0;
    }

    // --- Driving -------------------------------------------------------------------------
    let throttle = kd[I_THROTTLE] + pv[I_THROTTLE] - kd[I_REVERSE] - pv[I_REVERSE];
    let steer = kd[I_STEER_R] - kd[I_STEER_L] + pv[I_STEER_R] - pv[I_STEER_L];
    let yawIn = kd[I_YAW_R] - kd[I_YAW_L] + pv[I_YAW_R] - pv[I_YAW_L];
    let pitch = kd[I_PITCH_UP] - kd[I_PITCH_DOWN] + pv[I_PITCH_UP] - pv[I_PITCH_DOWN];
    let rollIn = kd[I_ROLL_R] - kd[I_ROLL_L] + pv[I_ROLL_R] - pv[I_ROLL_L];
    let airRoll = kd[I_AIRROLL] + pv[I_AIRROLL] > 0.5;
    let jump = kd[I_JUMP] + pv[I_JUMP] > 0.5;
    let boost = kd[I_BOOST] + pv[I_BOOST] > 0.5;
    let handbrake = kd[I_POWERSLIDE] + pv[I_POWERSLIDE] > 0.5;
    if (mouseSteering) {
      steer += this.steerVX;
      yawIn += this.steerVX;
      pitch += this.steerVY;
    }
    if (s.invertAirPitch === true) pitch = -pitch;
    if (capturing) {
      throttle = 0;
      steer = 0;
      yawIn = 0;
      pitch = 0;
      rollIn = 0;
      airRoll = false;
      jump = false;
      boost = false;
      handbrake = false;
    }

    out.throttle = clamp1(throttle);
    out.steer = clamp1(steer);
    out.pitch = clamp1(pitch);
    if (airRoll) {
      // Air-roll modifier: the yaw source rolls instead of yawing.
      out.yaw = 0;
      out.roll = clamp1(yawIn + rollIn);
    } else {
      out.yaw = clamp1(yawIn);
      out.roll = clamp1(rollIn);
    }
    if (this.jumpBlocked) {
      if (!jump) this.jumpBlocked = false;
      jump = false;
    }
    if (this.boostBlocked) {
      if (!boost) this.boostBlocked = false;
      boost = false;
    }
    out.jump = jump;
    out.boost = boost;
    out.handbrake = handbrake;
  }

  /** Clear all one-shot action flags. Call once per tick after reading `actions`. */
  consumeActions(): void {
    clearActions(this.actions);
    clearActions(this.padActions);
  }

  /**
   * Sample once and discard the result, so presses made since the last sample count as already
   * held: no one-shot edge (ball cam, reset, pause) fires for them on the next sample. Call when
   * a menu closes synchronously on a key / button that may also be bound in game (the first tick
   * would otherwise see the press as a fresh rising edge: Space = ball cam, pad A...). A menu
   * direction held through it repeats no more (resetMenuRepeat).
   */
  latchEdges(): void {
    this.sample(this.scratch);
    this.consumeActions();
    this.navHeld = NAV_NONE;
  }

  /**
   * Forget the menu direction held for the auto-repeat: it repeats again only after a new press.
   * Call where a menu takes over from play (the menus after a match, the pause, the pause's
   * settings): a stick steering hard, or a D-pad held, through that hand-off would otherwise walk
   * the focus by itself 400 ms later. Nothing is sampled or consumed (safe inside processActions).
   */
  resetMenuRepeat(): void {
    this.navHeld = NAV_NONE;
  }

  /**
   * Poll the gamepad and sample once into a scratch, keeping the edges: for an animation frame
   * that runs no logic while a menu is up over a match that keeps its frame cap (Game.ts frame: an
   * online pause on super low). The edges wait in `actions` / `padActions` for the next frame's
   * consumeActions, so a press shorter than one frame of logic still reaches the menu.
   */
  readEdges(): void {
    this.beginFrame();
    this.sample(this.scratch);
  }

  /** Ignore jump until it is released (so the button press that closed a menu does not jump). */
  blockJumpUntilRelease(): void {
    this.jumpBlocked = true;
  }

  /** Ignore boost until it is released (pad B, boost by default, resumes the pause: Game.processActions). */
  blockBoostUntilRelease(): void {
    this.boostBlocked = true;
  }

  /**
   * Controller vibration if supported and enabled (settings.controls.vibration). Magnitudes
   * 0..1, duration in ms. Safe to call without a pad.
   */
  rumble(strong: number, weak: number, ms: number): void {
    if (this.settings.controls.vibration === false) return;
    const gp = this.pollGamepad();
    if (gp === null) return;
    const actuator = (gp as unknown as { vibrationActuator?: HapticActuatorLike }).vibrationActuator;
    if (!actuator || typeof actuator.playEffect !== 'function') return;
    try {
      void actuator
        .playEffect('dual-rumble', {
          startDelay: 0,
          duration: ms,
          strongMagnitude: Math.min(1, Math.max(0, finiteOr(strong, 0))),
          weakMagnitude: Math.min(1, Math.max(0, finiteOr(weak, 0))),
        })
        .catch(() => undefined);
    } catch {
      /* unsupported effect type */
    }
  }

  // ---- Bindings (controls screen) -----------------------------------------------------------

  getBinding(action: ActionId, device: Device): Binding | null {
    return this.settings.bindings[device][action] ?? null;
  }

  getLabel(action: ActionId, device: Device): string {
    return bindingLabel(this.getBinding(action, device));
  }

  /**
   * Set (or clear with null) the binding of one action. Shared bindings are allowed (e.g.
   * powerslide and air roll share Left Shift), so nothing else is touched. A binding of the
   * wrong device kind is ignored. Calls onChange.
   */
  setBinding(action: ActionId, device: Device, b: Binding | null): void {
    if (b !== null && !bindingMatchesDevice(b, device)) return;
    this.settings.bindings[device][action] = b;
    this.refreshDerived();
    this.emitChange();
  }

  /**
   * Capture the next press on `device` as the binding of `action`: kbm = any key, mouse button
   * 0–4 or a wheel turn over `wheelTarget` (anywhere when omitted); pad = a button edge or an
   * axis crossing ±0.6, B on its release (held CAPTURE_CANCEL_HOLD_MS it cancels). Escape cancels a
   * capture on either device. Resolves with the new binding
   * (already applied with setBinding) or null on cancel / 10 s timeout. Driving input is ignored
   * while capturing. A pending capture is cancelled by a new one. The capture arms on the next
   * macrotask, so the press whose handler called this never ends it, and keys / buttons already
   * held are ignored until released.
   */
  startRebind(action: ActionId, device: Device, wheelTarget?: EventTarget | null): Promise<Binding | null> {
    this.cancelRebind();
    return new Promise<Binding | null>((resolve) => {
      const cap: Capture = {
        target: { action, device },
        resolve,
        timer: null,
        armed: false,
        ignoreKeys: new Set(this.keys),
        ignoreMouse: this.mouseHeld,
        wheelTarget: wheelTarget ?? null,
        holdB: -1,
      };
      setTimeout(() => {
        cap.armed = true;
      }, 0);
      cap.timer = setTimeout(() => {
        if (this.capture === cap) this.endCapture(null);
      }, REBIND_TIMEOUT_MS);
      this.capture = cap;
    });
  }

  /** Abort a pending `startRebind` (its promise resolves with null). */
  cancelRebind(): void {
    if (this.capture !== null) this.endCapture(null);
  }

  /** Restore a device's default layout in place ('standard' for both devices, 'keyboardOnly' for kbm). Calls onChange. */
  resetBindings(device: Device, preset: BindingPreset = 'standard'): void {
    const src = presetProfile(device, preset);
    const dst = this.settings.bindings[device];
    for (let i = 0; i < N; i++) {
      const action = ACTION_IDS[i];
      dst[action] = src[action];
    }
    this.refreshDerived();
    this.emitChange();
  }

  /** Same as resetBindings. */
  applyPreset(device: Device, preset: BindingPreset = 'standard'): void {
    this.resetBindings(device, preset);
  }

  /** Call after settings.controls was edited (sliders): re-reads the sensitivities and calls onChange. */
  settingsChanged(): void {
    this.refreshDerived();
    this.emitChange();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelRebind();
    if (this.locked) this.exitPointerLock();
    const t = this.target;
    t.removeEventListener('keydown', this.onKeyDown);
    t.removeEventListener('keyup', this.onKeyUp);
    t.removeEventListener('blur', this.onBlur);
    t.removeEventListener('mousedown', this.onMouseDown);
    t.removeEventListener('contextmenu', this.onContextMenu);
    t.removeEventListener('wheel', this.onWheel);
    this.upTarget.removeEventListener('mouseup', this.onMouseUp);
    this.upTarget.removeEventListener('mousemove', this.onMouseMove);
    if (typeof window !== 'undefined') {
      window.removeEventListener('gamepadconnected', this.onPadConnected as EventListener);
      window.removeEventListener('gamepaddisconnected', this.onPadDisconnected as EventListener);
      window.removeEventListener('blur', this.onBlur);
    }
    const doc = this.doc;
    if (doc !== null) {
      doc.removeEventListener('visibilitychange', this.onVisibility);
      doc.removeEventListener('pointerlockchange', this.onLockChange);
      doc.removeEventListener('pointerlockerror', this.onLockChange);
    }
    this.releaseAll();
    this.framePad = null;
    this.framePadValid = false;
  }

  // ---- Internals ----------------------------------------------------------------------------

  private emitChange(): void {
    if (this.onChange !== null) this.onChange();
  }

  /** Sanitise settings.controls into the cached per-sample constants (never NaN). */
  private refreshDerived(): void {
    const c = this.settings.controls;
    this.deadzone = clampRange(finiteOr(c.controllerDeadzone, 0.1), 0, 0.9);
    this.steerSens = clampRange(finiteOr(c.steeringSensitivity, 1), 0.1, 10);
    this.airSens = clampRange(finiteOr(c.aerialSensitivity, 1), 0.1, 10);
    this.kLook = clampRange(finiteOr(c.mouseSensitivity, SENS_REF), 0, 100) / (SENS_REF * PX_FULL_DEFLECTION_AT_5);
    this.kSteer = clampRange(finiteOr(c.mouseSteeringSensitivity, SENS_REF), 0, 100) / (SENS_REF * PX_FULL_DEFLECTION_AT_5);
    const bound = this.boundKeys;
    bound.clear();
    const kbm = this.settings.bindings.kbm;
    for (let i = 0; i < N; i++) {
      const b = kbm[ACTION_IDS[i]];
      if (b && b.kind === 'key') bound.add(b.code);
    }
    // A second key only while the player's own profile leaves it free (their binding wins).
    const sec = this.secondary;
    for (let i = 0; i < N; i++) {
      const code = KBM_SECONDARY[ACTION_IDS[i]];
      sec[i] = code !== undefined && !bound.has(code) ? code : null;
    }
  }

  /** Rising edges of a bool-ish action: bit 1 = keyboard/mouse, bit 2 = gamepad. */
  private edges(i: number): number {
    const k = this.kd[i] > 0.5 ? 1 : 0;
    const p = this.pv[i] > 0.5 ? 1 : 0;
    let e = 0;
    if (k === 1 && this.prevKd[i] === 0) e |= 1;
    if (p === 1 && this.prevPv[i] === 0) e |= 2;
    this.prevKd[i] = k;
    this.prevPv[i] = p;
    return e;
  }

  private endCapture(b: Binding | null): void {
    const cap = this.capture;
    if (cap === null) return;
    this.capture = null;
    if (cap.timer !== null) clearTimeout(cap.timer);
    if (b !== null) this.setBinding(cap.target.action, cap.target.device, b);
    cap.resolve(b);
  }

  /** Forget every held key / button / mouse delta / touch (focus lost, hidden, disposed). */
  private releaseAll(): void {
    this.touch?.releaseAll?.();
    this.keys.clear();
    this.tapped.clear();
    this.mouseHeld = 0;
    this.mouseTapped = 0;
    this.mouseMask = 0;
    this.mouseEat = 0;
    this.wheelTaps = 0;
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.lookVX = 0;
    this.lookVY = 0;
    this.steerVX = 0;
    this.steerVY = 0;
    const cap = this.capture;
    if (cap !== null) {
      cap.ignoreKeys.clear();
      cap.ignoreMouse = 0;
    }
  }

  private clearStick(): void {
    this.stick.fill(0);
  }

  /** Dead zones, capture crossings, fixed menu navigation edges. */
  private processGamepad(gp: Gamepad): void {
    const wasCapturing = this.capture !== null; // a press that ends a capture below fires no menu edge
    const axes = gp.axes;
    const na = Math.min(axes.length, GP_MAX_AXES);
    const stick = this.stick;
    const prevAxes = this.prevAxes;
    for (let i = 0; i < na; i++) {
      const v = clamp1(axes[i]);
      const cap = this.capture;
      if (cap !== null && cap.armed && cap.target.device === 'pad') {
        const pa = prevAxes[i];
        if (v >= CAPTURE_AXIS_THRESHOLD && pa < CAPTURE_AXIS_THRESHOLD) this.endCapture({ kind: 'gpAxis', index: i, sign: 1 });
        else if (v <= -CAPTURE_AXIS_THRESHOLD && pa > -CAPTURE_AXIS_THRESHOLD) this.endCapture({ kind: 'gpAxis', index: i, sign: -1 });
      }
      prevAxes[i] = v;
      stick[i] = v;
    }
    for (let i = na; i < GP_MAX_AXES; i++) {
      prevAxes[i] = 0;
      stick[i] = 0;
    }
    this.radialDeadzone(GP.AXIS_LX, GP.AXIS_LY);
    this.radialDeadzone(GP.AXIS_RX, GP.AXIS_RY);
    const dz = this.deadzone;
    for (let i = 4; i < na; i++) {
      const v = stick[i];
      const mag = v < 0 ? -v : v;
      stick[i] = mag <= dz ? 0 : (v < 0 ? -1 : 1) * Math.min(1, (mag - dz) / (1 - dz));
    }

    // Button edges: binding capture, then the fixed menu navigation (mirrored into padActions).
    const a = this.actions;
    const pa = this.padActions;
    const prev = this.prevButtons;
    const nb = Math.min(gp.buttons.length, GP_MAX_BUTTONS);
    let pressed = NAV_NONE; // a menu direction pressed in this sample (the last one is the one repeated)
    for (let i = 0; i < nb; i++) {
      const now = buttonPressed(gp, i) ? 1 : 0;
      if (now === 1 && prev[i] === 0) {
        this.padPresses++;
        const cap = this.capture;
        if (cap !== null) {
          // B binds on its release: held CAPTURE_CANCEL_HOLD_MS it cancels instead (below).
          if (cap.armed && cap.target.device === 'pad') {
            if (i === GP.B) cap.holdB = this.now();
            else this.endCapture({ kind: 'gpButton', index: i });
          }
        } else {
          switch (i) {
            case GP.A:
              a.accept = pa.accept = true;
              break;
            case GP.B:
              a.back = pa.back = true;
              break;
            case GP.X:
              a.settings = pa.settings = true;
              break;
            case GP.Y:
              a.menuCancel = pa.menuCancel = true;
              break;
            case GP.LB:
              a.menuPrev = pa.menuPrev = true;
              break;
            case GP.RB:
              a.menuNext = pa.menuNext = true;
              break;
            case GP.START:
              a.menuStart = pa.menuStart = true;
              break;
            case GP.DPAD_UP:
              a.menuUp = pa.menuUp = true;
              pressed = NAV_UP;
              break;
            case GP.DPAD_DOWN:
              a.menuDown = pa.menuDown = true;
              pressed = NAV_DOWN;
              break;
            case GP.DPAD_LEFT:
              a.menuLeft = pa.menuLeft = true;
              pressed = NAV_LEFT;
              break;
            case GP.DPAD_RIGHT:
              a.menuRight = pa.menuRight = true;
              pressed = NAV_RIGHT;
              break;
            default:
              break;
          }
        }
      }
      if (now === 0 && prev[i] === 1 && i === GP.B && this.capture !== null && this.capture.holdB >= 0) this.endCapture({ kind: 'gpButton', index: GP.B });
      prev[i] = now;
    }
    for (let i = nb; i < GP_MAX_BUTTONS; i++) prev[i] = 0;
    const held = this.capture;
    if (held !== null && held.holdB >= 0 && this.now() - held.holdB >= CAPTURE_CANCEL_HOLD_MS) this.endCapture(null);

    // LT / RT as menu edges: past NAV_TRIGGER_ON, and again only once back under NAV_TRIGGER_OFF
    // (a trigger resting a little pressed, or a noisy one, fires once). Tracked during a capture
    // too, so the press a capture took (in this very sample too) fires nothing afterwards.
    const lt = buttonValue(gp, GP.LT);
    const rt = buttonValue(gp, GP.RT);
    let trig = this.triggers;
    if (lt >= NAV_TRIGGER_ON && (trig & 1) === 0) {
      trig |= 1;
      if (!wasCapturing) a.menuTabPrev = pa.menuTabPrev = true;
    } else if (lt <= NAV_TRIGGER_OFF) trig &= ~1;
    if (rt >= NAV_TRIGGER_ON && (trig & 2) === 0) {
      trig |= 2;
      if (!wasCapturing) a.menuTabNext = pa.menuTabNext = true;
    } else if (rt <= NAV_TRIGGER_OFF) trig &= ~2;
    this.triggers = trig;

    // Left stick as a D-pad for menus (edge on crossing the threshold, raw axes).
    const rawX = prevAxes[GP.AXIS_LX];
    const rawY = prevAxes[GP.AXIS_LY];
    if (this.capture === null) {
      if (rawY < -NAV_STICK_THRESHOLD && this.prevNavY >= -NAV_STICK_THRESHOLD) {
        a.menuUp = pa.menuUp = true;
        pressed = NAV_UP;
      }
      if (rawY > NAV_STICK_THRESHOLD && this.prevNavY <= NAV_STICK_THRESHOLD) {
        a.menuDown = pa.menuDown = true;
        pressed = NAV_DOWN;
      }
      if (rawX < -NAV_STICK_THRESHOLD && this.prevNavX >= -NAV_STICK_THRESHOLD) {
        a.menuLeft = pa.menuLeft = true;
        pressed = NAV_LEFT;
      }
      if (rawX > NAV_STICK_THRESHOLD && this.prevNavX <= NAV_STICK_THRESHOLD) {
        a.menuRight = pa.menuRight = true;
        pressed = NAV_RIGHT;
      }
    }
    this.prevNavX = rawX;
    this.prevNavY = rawY;

    // Auto-repeat of the direction pressed last, while its D-pad button or the stick holds it:
    // NAV_REPEAT_DELAY_MS after the press, then every NAV_REPEAT_MS, on the clock (the same at 20
    // fps and at 144; one repeat at most per sample). A capture stops it.
    const t = this.now();
    if (pressed !== NAV_NONE) {
      this.navHeld = pressed;
      this.navNextAt = t + NAV_REPEAT_DELAY_MS;
    } else if (this.navHeld !== NAV_NONE) {
      if (this.capture !== null || !navStillHeld(gp, this.navHeld, rawX, rawY)) this.navHeld = NAV_NONE;
      else if (t >= this.navNextAt) {
        this.navNextAt = t + NAV_REPEAT_MS;
        a.menuRepeat = pa.menuRepeat = true;
        switch (this.navHeld) {
          case NAV_UP:
            a.menuUp = pa.menuUp = true;
            break;
          case NAV_DOWN:
            a.menuDown = pa.menuDown = true;
            break;
          case NAV_LEFT:
            a.menuLeft = pa.menuLeft = true;
            break;
          default:
            a.menuRight = pa.menuRight = true;
            break;
        }
      }
    }
  }

  /** Radial deadzone with rescaling so the first usable value is 0, not `deadzone`. */
  private radialDeadzone(ix: number, iy: number): void {
    const st = this.stick;
    let x = st[ix];
    let y = st[iy];
    const mag = Math.sqrt(x * x + y * y);
    const dz = this.deadzone;
    if (mag <= dz || mag === 0) {
      x = 0;
      y = 0;
    } else {
      const k = Math.min(1, (mag - dz) / (1 - dz)) / mag;
      x *= k;
      y *= k;
    }
    st[ix] = x;
    st[iy] = y;
  }

  /**
   * Switch the active pad. Its axes seed the "previous" values so an axis that rests away from 0
   * (DirectInput / many Linux drivers report triggers as axes resting at -1) is not a crossing on
   * the first sample: it would end a pending capture as a spurious axis binding and press the
   * menu stick. Buttons are NOT seeded: Chrome exposes a pad only after a button press, and that
   * press should still count (it is the button the player is trying to bind / the A that accepts).
   */
  private setPad(gp: Gamepad | null): void {
    this.padIndex = gp ? gp.index : -1;
    this.padId = gp ? gp.id : null;
    const prevAxes = this.prevAxes;
    this.prevButtons.fill(0);
    prevAxes.fill(0);
    this.stick.fill(0);
    if (gp) {
      const axes = gp.axes;
      const na = Math.min(axes.length, GP_MAX_AXES);
      for (let i = 0; i < na; i++) prevAxes[i] = clamp1(axes[i]);
    }
    this.prevNavX = prevAxes[GP.AXIS_LX];
    this.prevNavY = prevAxes[GP.AXIS_LY];
    this.navHeld = NAV_NONE;
    this.triggers = 0;
  }

  /**
   * The active gamepad, re-read from navigator.getGamepads() (the snapshot objects go stale).
   * Chrome only exposes a pad after a button press and does not always fire `gamepadconnected`,
   * so when no pad is active the list is scanned for one (standard mapping preferred).
   */
  private pollGamepad(): Gamepad | null {
    if (this.gamepadsUnavailable || typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return null;
    let pads: (Gamepad | null)[];
    try {
      pads = navigator.getGamepads();
    } catch {
      this.gamepadsUnavailable = true; // permissions policy / insecure context
      return null;
    }
    if (this.padIndex >= 0) {
      const gp = this.padIndex < pads.length ? pads[this.padIndex] : null;
      if (gp !== null && gp !== undefined && gp.connected) return gp;
      this.setPad(null);
    }
    let fallback: Gamepad | null = null;
    for (let i = 0; i < pads.length; i++) {
      const gp = pads[i];
      if (gp === null || gp === undefined || !gp.connected) continue;
      if (gp.mapping === 'standard') {
        this.setPad(gp);
        return gp;
      }
      if (fallback === null) fallback = gp;
    }
    if (fallback !== null) this.setPad(fallback);
    return fallback;
  }
}
