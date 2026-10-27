/**
 * Control bindings model + the DEFAULT layouts for keyboard/mouse and controller.
 * Pure data (no DOM): shared by Input.ts (reads), Hud.ts (rebind UI) and settings.ts (persist).
 * Never imported by the Worker, so the action labels come from src/i18n.ts (action.* keys).
 *
 * Defaults (the common layout of car-ball games, every action rebindable): PC jump = right mouse button, boost = left mouse button, powerslide and
 * air roll share Left Shift, ball cam ("focus on ball") = Space, rear view = middle mouse, scoreboard
 * = Tab; controller: A/Cross jump, B/Circle boost, X/Square powerslide + air roll, Y/Triangle ball
 * cam, RT/LT throttle/reverse, left stick steer + air pitch/yaw, right stick camera swivel, right
 * stick click rear view, Back/Select scoreboard, Start menu; air roll left/right are unbound.
 *
 * The arrow keys drive too (KBM_SECONDARY: throttle / reverse / steer, pitch / yaw in the air, as
 * W A S D), the first guess of a driving game in the browser; a player's own binding of an arrow
 * key wins over it.
 *
 * Training (src/game/TrainingSession.ts): Backspace resets the shot, Page Up / Page Down step
 * through the shots, F puts the car back and T toggles unlimited boost (free play): keys nobody
 * drives with (R is the reset to kickoff); on a controller View / Back is the scoreboard, so the
 * training actions live on the D-pad (free in a match: the D-pad only navigates menus) and LB. None
 * of them shares a key or button with another default binding (secondary keys included).
 *   reset shot / ball   Backspace   D-pad ↓     next shot     PgDn   D-pad →
 *   previous shot       PgUp        D-pad ←     reset car     F      D-pad ↑   (free play)
 *   unlimited boost     T           LB          (free play toggle)
 */
import { t } from '../i18n';

/** Everything a player can bind. Axis-like actions are split into a +/- pair for digital sources. */
export type ActionId =
  | 'throttle'
  | 'reverse'
  | 'steerLeft'
  | 'steerRight'
  | 'pitchUp' // nose up (stick pulled back / S)
  | 'pitchDown' // nose down (stick forward / W)
  | 'yawLeft'
  | 'yawRight'
  | 'jump'
  | 'boost'
  | 'powerslide'
  | 'airRoll' // hold: steer axis rolls instead of yawing
  | 'airRollLeft'
  | 'airRollRight'
  | 'ballCam'
  | 'rearView'
  | 'lookLeft' // camera swivel (digital sources; the stick/mouse bind the axis versions)
  | 'lookRight'
  | 'lookUp'
  | 'lookDown'
  | 'scoreboard'
  | 'pause'
  | 'reset'
  | 'trainingReset' // training: reset the shot (pack) / the ball (free play)
  | 'trainingPrev'
  | 'trainingNext'
  | 'trainingResetCar' // free play: car back to its spawn
  | 'trainingBoost'; // free play: toggle unlimited boost

export type Device = 'kbm' | 'pad';

export type Binding =
  | { kind: 'key'; code: string } // KeyboardEvent.code
  | { kind: 'mouse'; button: number } // MouseEvent.button: 0 left, 1 middle, 2 right, 3 back, 4 forward
  | { kind: 'mouseAxis'; axis: 'x' | 'y'; sign: 1 | -1 } // mouse movement (camera swivel / mouse steering)
  | { kind: 'wheel'; sign: 1 | -1 } // mouse wheel up (-1) / down (+1)
  | { kind: 'gpButton'; index: number } // standard gamepad mapping button index
  | { kind: 'gpAxis'; index: number; sign: 1 | -1 }; // standard gamepad axis index; sign = direction that triggers

/** One binding slot per action per device (one column per device on the controls screen). */
export type BindingProfile = { [A in ActionId]: Binding | null };
export interface BindingProfiles {
  kbm: BindingProfile;
  pad: BindingProfile;
}

/**
 * Hardware limits shared by Input.ts (table sizes) and settings.ts (saved-binding validation).
 * The standard gamepad mapping needs 17 buttons / 4 axes; the extra room covers extended pads.
 */
export const GP_MAX_BUTTONS = 32;
export const GP_MAX_AXES = 8;
/** Highest MouseEvent.button a binding may use (buttons are tracked as `1 << button` bit masks). */
export const MAX_MOUSE_BUTTON = 30;

// Standard gamepad mapping indices (https://w3c.github.io/gamepad/#remapping).
export const GP = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  BACK: 8,
  START: 9,
  LS: 10, // left stick click
  RS: 11, // right stick click
  DPAD_UP: 12,
  DPAD_DOWN: 13,
  DPAD_LEFT: 14,
  DPAD_RIGHT: 15,
  HOME: 16,
  AXIS_LX: 0,
  AXIS_LY: 1,
  AXIS_RX: 2,
  AXIS_RY: 3,
} as const;

const key = (code: string): Binding => ({ kind: 'key', code });
const mouse = (button: number): Binding => ({ kind: 'mouse', button });
const mouseAxis = (axis: 'x' | 'y', sign: 1 | -1): Binding => ({ kind: 'mouseAxis', axis, sign });
const gpb = (index: number): Binding => ({ kind: 'gpButton', index });
const gpa = (index: number, sign: 1 | -1): Binding => ({ kind: 'gpAxis', index, sign });

/** The default keyboard + mouse layout. */
export const DEFAULT_KBM: Readonly<BindingProfile> = {
  throttle: key('KeyW'),
  reverse: key('KeyS'),
  steerLeft: key('KeyA'),
  steerRight: key('KeyD'),
  pitchDown: key('KeyW'),
  pitchUp: key('KeyS'),
  yawLeft: key('KeyA'),
  yawRight: key('KeyD'),
  jump: mouse(2), // right mouse button
  boost: mouse(0), // left mouse button
  powerslide: key('ShiftLeft'),
  airRoll: key('ShiftLeft'),
  airRollLeft: key('KeyQ'),
  airRollRight: key('KeyE'),
  ballCam: key('Space'),
  rearView: mouse(1), // middle mouse button
  lookLeft: mouseAxis('x', -1),
  lookRight: mouseAxis('x', 1),
  lookUp: mouseAxis('y', -1),
  lookDown: mouseAxis('y', 1),
  scoreboard: key('Tab'),
  pause: key('Escape'),
  reset: key('KeyR'), // reset to kickoff (training resets the shot with Backspace)
  trainingReset: key('Backspace'), // "reset shot"; while paused Backspace resumes (fixed menu key)
  trainingPrev: key('PageUp'),
  trainingNext: key('PageDown'),
  trainingResetCar: key('KeyF'),
  trainingBoost: key('KeyT'),
};

/**
 * Second keys of the keyboard + mouse column, in every preset (fixed, not on the controls screen):
 * the arrow keys drive like W A S D (Input.ts sample). One is ignored while the player's profile
 * binds that key to any action (Input.refreshDerived): their own binding wins, nothing doubles.
 */
export const KBM_SECONDARY: Readonly<Partial<Record<ActionId, string>>> = {
  throttle: 'ArrowUp',
  reverse: 'ArrowDown',
  steerLeft: 'ArrowLeft',
  steerRight: 'ArrowRight',
  pitchDown: 'ArrowUp',
  pitchUp: 'ArrowDown',
  yawLeft: 'ArrowLeft',
  yawRight: 'ArrowRight',
};

/**
 * The training keys of the layouts before KBM_SECONDARY (the arrows): settings.ts moves a saved
 * binding still equal to one of these to today's default (SETTINGS_REV 2), so the arrows drive for
 * a player who never changed them.
 */
export const LEGACY_TRAINING_KBM: Readonly<Partial<Record<ActionId, string>>> = {
  trainingPrev: 'ArrowLeft',
  trainingNext: 'ArrowRight',
  trainingResetCar: 'ArrowDown',
  trainingBoost: 'ArrowUp',
};

/**
 * A keyboard-only alternative (the layout this project shipped with before mouse support):
 * Space jump, Left Shift boost, Z powerslide / air roll, C ball cam, X rear view.
 *
 * No preset binds a browser modifier: Ctrl + W / T / N (close / new tab) and Ctrl + Q cannot be
 * blocked by preventDefault outside the Keyboard Lock API, and air roll + pitch (modifier + W / S)
 * is the most common keyboard combo; Alt + Space opens the window menu and an Alt tap focuses
 * Firefox's menu bar; Caps Lock toggles the OS lock state. Players may still rebind to them.
 */
export const KEYBOARD_ONLY_KBM: Readonly<BindingProfile> = {
  ...DEFAULT_KBM,
  jump: key('Space'),
  boost: key('ShiftLeft'),
  powerslide: key('KeyZ'),
  airRoll: key('KeyZ'),
  ballCam: key('KeyC'),
  rearView: key('KeyX'),
};

/** The default controller layout (standard gamepad mapping, Xbox names). */
export const DEFAULT_PAD: Readonly<BindingProfile> = {
  throttle: gpb(GP.RT),
  reverse: gpb(GP.LT),
  steerLeft: gpa(GP.AXIS_LX, -1),
  steerRight: gpa(GP.AXIS_LX, 1),
  pitchDown: gpa(GP.AXIS_LY, -1), // stick forward
  pitchUp: gpa(GP.AXIS_LY, 1), // stick back
  yawLeft: gpa(GP.AXIS_LX, -1),
  yawRight: gpa(GP.AXIS_LX, 1),
  jump: gpb(GP.A),
  boost: gpb(GP.B),
  powerslide: gpb(GP.X),
  airRoll: gpb(GP.X),
  airRollLeft: null, // unbound by default
  airRollRight: null,
  ballCam: gpb(GP.Y),
  rearView: gpb(GP.RS),
  lookLeft: gpa(GP.AXIS_RX, -1),
  lookRight: gpa(GP.AXIS_RX, 1),
  lookUp: gpa(GP.AXIS_RY, -1),
  lookDown: gpa(GP.AXIS_RY, 1),
  scoreboard: gpb(GP.BACK),
  pause: gpb(GP.START),
  reset: null,
  // Back is the scoreboard: the training actions use the D-pad, which is free in game.
  trainingReset: gpb(GP.DPAD_DOWN),
  trainingPrev: gpb(GP.DPAD_LEFT),
  trainingNext: gpb(GP.DPAD_RIGHT),
  trainingResetCar: gpb(GP.DPAD_UP),
  trainingBoost: gpb(GP.LB),
};

export function defaultProfiles(): BindingProfiles {
  return { kbm: { ...DEFAULT_KBM }, pad: { ...DEFAULT_PAD } };
}

/** Named default layouts selectable from the controls screen (Input.resetBindings / applyPreset). */
export type BindingPreset = 'standard' | 'keyboardOnly';

/** The default profile for a device + preset ('keyboardOnly' only differs for the keyboard). */
export function presetProfile(device: Device, preset: BindingPreset = 'standard'): Readonly<BindingProfile> {
  if (device === 'pad') return DEFAULT_PAD;
  return preset === 'keyboardOnly' ? KEYBOARD_ONLY_KBM : DEFAULT_KBM;
}

const ACTION_ID_TUPLE = [
  'throttle',
  'reverse',
  'steerLeft',
  'steerRight',
  'pitchUp',
  'pitchDown',
  'yawLeft',
  'yawRight',
  'jump',
  'boost',
  'powerslide',
  'airRoll',
  'airRollLeft',
  'airRollRight',
  'ballCam',
  'rearView',
  'lookLeft',
  'lookRight',
  'lookUp',
  'lookDown',
  'scoreboard',
  'pause',
  'reset',
  'trainingReset',
  'trainingPrev',
  'trainingNext',
  'trainingResetCar',
  'trainingBoost',
] as const;

/** Resolves to the tuple type only when it lists every ActionId (compile-time completeness check). */
type AllActionIds<T extends readonly ActionId[]> = Exclude<ActionId, T[number]> extends never ? T : never;

/**
 * Every ActionId exactly once, in a fixed order. Input.ts indexes its per-tick value tables by the
 * position in this list; the HUD can use it to iterate a profile without `Object.keys`.
 */
export const ACTION_IDS: AllActionIds<typeof ACTION_ID_TUPLE> = ACTION_ID_TUPLE;

/**
 * Other actions of the same profile bound to an identical binding (shared keys are allowed, e.g.
 * powerslide + air roll on Left Shift). For the controls screen's "also used by" hint; allocates.
 */
export function actionsSharingBinding(profile: Readonly<BindingProfile>, b: Binding | null, except?: ActionId): ActionId[] {
  const out: ActionId[] = [];
  if (b === null) return out;
  for (const action of ACTION_IDS) {
    if (action === except) continue;
    if (bindingsEqual(profile[action], b)) out.push(action);
  }
  return out;
}

/**
 * Display order + labels for the controls screen. The labels are in the page's language (action.*
 * texts, resolved once at import: the language is fixed for the page); key and button names are not.
 */
export const ACTION_ROWS: ReadonlyArray<{ action: ActionId; label: string; group: 'driving' | 'air' | 'camera' | 'game' }> = [
  { action: 'throttle', label: t('action.throttle'), group: 'driving' },
  { action: 'reverse', label: t('action.reverse'), group: 'driving' },
  { action: 'steerLeft', label: t('action.steerLeft'), group: 'driving' },
  { action: 'steerRight', label: t('action.steerRight'), group: 'driving' },
  { action: 'jump', label: t('action.jump'), group: 'driving' },
  { action: 'boost', label: t('action.boost'), group: 'driving' },
  { action: 'powerslide', label: t('action.powerslide'), group: 'driving' },
  { action: 'pitchUp', label: t('action.pitchUp'), group: 'air' },
  { action: 'pitchDown', label: t('action.pitchDown'), group: 'air' },
  { action: 'yawLeft', label: t('action.yawLeft'), group: 'air' },
  { action: 'yawRight', label: t('action.yawRight'), group: 'air' },
  { action: 'airRoll', label: t('action.airRoll'), group: 'air' },
  { action: 'airRollLeft', label: t('action.airRollLeft'), group: 'air' },
  { action: 'airRollRight', label: t('action.airRollRight'), group: 'air' },
  { action: 'ballCam', label: t('action.ballCam'), group: 'camera' },
  { action: 'rearView', label: t('action.rearView'), group: 'camera' },
  { action: 'lookLeft', label: t('action.lookLeft'), group: 'camera' },
  { action: 'lookRight', label: t('action.lookRight'), group: 'camera' },
  { action: 'lookUp', label: t('action.lookUp'), group: 'camera' },
  { action: 'lookDown', label: t('action.lookDown'), group: 'camera' },
  { action: 'scoreboard', label: t('action.scoreboard'), group: 'game' },
  { action: 'pause', label: t('action.pause'), group: 'game' },
  { action: 'reset', label: t('action.reset'), group: 'game' },
  { action: 'trainingReset', label: t('action.trainingReset'), group: 'game' },
  { action: 'trainingPrev', label: t('action.trainingPrev'), group: 'game' },
  { action: 'trainingNext', label: t('action.trainingNext'), group: 'game' },
  { action: 'trainingResetCar', label: t('action.trainingResetCar'), group: 'game' },
  { action: 'trainingBoost', label: t('action.trainingBoost'), group: 'game' },
];

const KEY_LABELS: Readonly<Record<string, string>> = {
  Space: 'Space',
  ShiftLeft: 'L Shift',
  ShiftRight: 'R Shift',
  ControlLeft: 'L Ctrl',
  ControlRight: 'R Ctrl',
  AltLeft: 'L Alt',
  AltRight: 'R Alt',
  Escape: 'Esc',
  Enter: 'Enter',
  NumpadEnter: 'Num Enter',
  Backspace: 'Backspace',
  Tab: 'Tab',
  CapsLock: 'Caps',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
};

const MOUSE_LABELS: readonly string[] = ['LMB', 'MMB', 'RMB', 'Mouse 4', 'Mouse 5'];

const PAD_BUTTON_LABELS: readonly string[] = [
  'A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start', 'LS click', 'RS click',
  'D-pad ↑', 'D-pad ↓', 'D-pad ←', 'D-pad →', 'Home',
];

const PAD_AXIS_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['L stick ←', 'L stick →'],
  ['L stick ↑', 'L stick ↓'],
  ['R stick ←', 'R stick →'],
  ['R stick ↑', 'R stick ↓'],
];

/** Human-readable label for a binding (for the controls screen and the menu's control list). */
export function bindingLabel(b: Binding | null): string {
  if (b === null) return '—';
  switch (b.kind) {
    case 'key': {
      const code = b.code;
      if (KEY_LABELS[code] !== undefined) return KEY_LABELS[code];
      if (code.startsWith('Key')) return code.slice(3);
      if (code.startsWith('Digit')) return code.slice(5);
      if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
      return code;
    }
    case 'mouse':
      return MOUSE_LABELS[b.button] ?? `Mouse ${b.button + 1}`;
    case 'mouseAxis':
      return b.axis === 'x' ? (b.sign < 0 ? 'Mouse ←' : 'Mouse →') : b.sign < 0 ? 'Mouse ↑' : 'Mouse ↓';
    case 'wheel':
      return b.sign < 0 ? 'Wheel ↑' : 'Wheel ↓';
    case 'gpButton':
      return PAD_BUTTON_LABELS[b.index] ?? `Button ${b.index}`;
    case 'gpAxis': {
      const pair = PAD_AXIS_LABELS[b.index];
      if (pair !== undefined) return b.sign < 0 ? pair[0] : pair[1];
      return `Axis ${b.index}${b.sign < 0 ? '-' : '+'}`;
    }
  }
}

export function bindingsEqual(a: Binding | null, b: Binding | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'key':
      return a.code === (b as { code: string }).code;
    case 'mouse':
      return a.button === (b as { button: number }).button;
    case 'mouseAxis':
      return a.axis === (b as { axis: string }).axis && a.sign === (b as { sign: number }).sign;
    case 'wheel':
      return a.sign === (b as { sign: number }).sign;
    case 'gpButton':
      return a.index === (b as { index: number }).index;
    case 'gpAxis':
      return a.index === (b as { index: number }).index && a.sign === (b as { sign: number }).sign;
  }
}

/**
 * Some action of a keyboard + mouse profile is bound otherwise than in DEFAULT_KBM: the player
 * changed it, or picked Keyboard only (src/ui/howPlay.ts asks only a player with the defaults).
 */
export function kbmCustomised(p: Readonly<BindingProfile>): boolean {
  return ACTION_IDS.some((a) => !bindingsEqual(p[a], DEFAULT_KBM[a]));
}

/**
 * Some action is bound to a mouse button (jump, boost and rear view by default): a mouse player.
 * The match's "click to capture the mouse" hint is for them only (Keyboard only keeps the axes).
 * Read per frame in a match (Game.frameLogic): no allocation.
 */
export function usesMouseButton(p: Readonly<BindingProfile>): boolean {
  for (let i = 0; i < ACTION_IDS.length; i++) if (p[ACTION_IDS[i]]?.kind === 'mouse') return true;
  return false;
}

/** True when the binding can be produced by the device's hardware (used to validate saved data). */
export function bindingMatchesDevice(b: Binding, device: Device): boolean {
  switch (b.kind) {
    case 'key':
    case 'mouse':
    case 'mouseAxis':
    case 'wheel':
      return device === 'kbm';
    case 'gpButton':
    case 'gpAxis':
      return device === 'pad';
  }
}

/** Camera-related input produced by Input.sample() for the chase camera (see Camera.ts). */
export interface CameraLook {
  /** Swivel stick: x right, y back (+1 = pulled toward the player = look behind). -1..1 each. */
  x: number;
  y: number;
  /** Rear view held. */
  rearView: boolean;
}
