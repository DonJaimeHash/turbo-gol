/**
 * Player settings (the settings screen: controls, camera, gameplay, audio, the touch controls, the
 * interface), persisted in localStorage. Pure data + load/save. Input.ts mutates `controls` and
 * `bindings` in place, Camera.ts reads `camera`, the Game hands `audio` to the sound engine,
 * `touch` to the touch controls and `ui` to src/ui/device.ts; call saveSettings() after a change.
 * The graphics quality is not here: it is saved with the Game's prefs (Game.ts), and so are the
 * other Graphics rows (resolution scale, frame limit, the menus' stadium). Every group and field is
 * read over its default (mergeSettings): a save from before a field reads as its default.
 */
import type { CameraSettings } from './render/Camera';
import { STORAGE_PREFIX } from './brand';
import {
  DEFAULT_KBM,
  GP_MAX_AXES,
  GP_MAX_BUTTONS,
  LEGACY_TRAINING_KBM,
  MAX_MOUSE_BUTTON,
  actionsSharingBinding,
  bindingMatchesDevice,
  defaultProfiles,
  type ActionId,
  type Binding,
  type BindingProfiles,
} from './input/bindings';

export interface ControlSettings {
  /** 1..3. Scales stick X for ground steering before clamping. */
  steeringSensitivity: number;
  /** 1..3. Scales stick X/Y for air pitch / yaw / roll. */
  aerialSensitivity: number;
  /** 0.05..0.5 (radial stick deadzone). */
  controllerDeadzone: number;
  /** 0.1..0.9: minimum |pitch|+|yaw|+|roll| for a second jump to dodge. Applied by the sim. */
  dodgeDeadzone: number;
  /** Mouse camera swivel sensitivity, 1..10. */
  mouseSensitivity: number;
  /** "Mouse steering": mouse X steers / yaws and mouse Y pitches instead of swivelling the camera. */
  mouseSteering: boolean;
  /** 1..10 when mouseSteering is on. */
  mouseSteeringSensitivity: number;
  invertAirPitch: boolean;
  /** Controller vibration. */
  vibration: boolean;
  /** Touch: a thumb that slides from JUMP to BOOST keeps the jump held until it lifts, as BOOST does (plan M29). */
  touchHoldJump: boolean;
}

export interface AudioSettings {
  /** Master volume, 0..100 (%). */
  volume: number;
  /** Music volume under the master, 0..100 (%). */
  music: number;
}

/** The on-screen touch controls (Settings > Controls > Touch; src/input/TouchControls.ts). */
export interface TouchSettings {
  /** The buttons' and the stick's size: S 85 %, M 100 %, L 115 % (TOUCH_SIZE_SCALE). */
  size: TouchSize;
  /** The buttons' and the stick's opacity, 30..100 (%). */
  opacity: number;
  /** Mirrored: the stick on the right, the buttons on the left (PAUSE stays in its corner). */
  lefty: boolean;
  /** 'floating': the stick starts where the thumb lands; 'fixed': it stays at its resting place. */
  stick: 'floating' | 'fixed';
  /** The stick's radial deadzone, 0.05..0.3 (touchState.ts stickVector). */
  deadzone: number;
  /** A short pulse on each press of a button (navigator.vibrate: Android). */
  vibration: boolean;
}

export type TouchSize = 'S' | 'M' | 'L';

/** --tc-k per size (src/input/touch.css). */
export const TOUCH_SIZE_SCALE: Readonly<Record<TouchSize, number>> = { S: 0.85, M: 1, L: 1.15 };

/** The interface (Settings > Game; src/ui/device.ts). */
export interface UiSettings {
  /** Interface size, % (device.ts INTERFACE_SIZES); 0: the device's own (125 on a TV, 100 elsewhere). */
  size: number;
  /** Reduced motion: 'system' follows prefers-reduced-motion, 'on' always, 'off' never. */
  motion: MotionPref;
}

export type MotionPref = 'system' | 'on' | 'off';

export interface Settings {
  controls: ControlSettings;
  camera: CameraSettings;
  bindings: BindingProfiles;
  audio: AudioSettings;
  touch: TouchSettings;
  ui: UiSettings;
}

export const DEFAULT_CONTROL_SETTINGS: Readonly<ControlSettings> = {
  steeringSensitivity: 1,
  aerialSensitivity: 1,
  controllerDeadzone: 0.1,
  dodgeDeadzone: 0.5,
  mouseSensitivity: 5,
  mouseSteering: false,
  mouseSteeringSensitivity: 5,
  invertAirPitch: false,
  vibration: true,
  touchHoldJump: false,
};

export const DEFAULT_AUDIO: Readonly<AudioSettings> = {
  volume: 70,
  music: 50,
};

/** Slider range of the master and music volumes: [min, max, step]. */
export const VOLUME_RANGE: readonly [number, number, number] = [0, 100, 5];

export const DEFAULT_TOUCH: Readonly<TouchSettings> = {
  size: 'M',
  opacity: 100,
  lefty: false,
  stick: 'floating',
  deadzone: 0.12,
  vibration: true,
};

/** Slider ranges of the touch controls: [min, max, step]. */
export const TOUCH_OPACITY_RANGE: readonly [number, number, number] = [30, 100, 5];
export const TOUCH_DEADZONE_RANGE: readonly [number, number, number] = [0.05, 0.3, 0.01];

export const DEFAULT_UI: Readonly<UiSettings> = { size: 0, motion: 'system' };

/** The interface sizes a save may hold (%; 0: the device's own). */
export const UI_SIZES: readonly number[] = [0, 100, 115, 125, 130, 150];

/** Ranges for the settings sliders. */
export const CONTROL_RANGES: Readonly<Record<keyof ControlSettings, readonly [number, number, number] | null>> = {
  steeringSensitivity: [1, 3, 0.05],
  aerialSensitivity: [1, 3, 0.05],
  controllerDeadzone: [0.05, 0.5, 0.01],
  dodgeDeadzone: [0.1, 0.9, 0.05],
  mouseSensitivity: [1, 10, 0.5],
  mouseSteering: null,
  mouseSteeringSensitivity: [1, 10, 0.5],
  invertAirPitch: null,
  vibration: null,
  touchHoldJump: null,
};

export const CAMERA_RANGES: Readonly<Record<keyof CameraSettings, readonly [number, number, number]>> = {
  fov: [60, 110, 1],
  distance: [100, 400, 10],
  height: [40, 200, 10],
  angle: [-15, 0, 1],
  stiffness: [0, 1, 0.05],
  swivelSpeed: [1, 10, 0.5],
  transitionSpeed: [1, 2, 0.1],
};

/** The "classic" camera preset (narrower FOV); the game ships with the wider DEFAULT_CAMERA. */
export const CLASSIC_CAMERA_DEFAULTS: Readonly<CameraSettings> = {
  fov: 90,
  distance: 270,
  height: 100,
  angle: -3,
  stiffness: 0.5,
  swivelSpeed: 2.5,
  transitionSpeed: 1,
};

export const DEFAULT_CAMERA: Readonly<CameraSettings> = {
  fov: 110,
  distance: 270,
  height: 100,
  angle: -3,
  stiffness: 0.45,
  swivelSpeed: 5,
  transitionSpeed: 1,
};

const STORAGE_KEY = STORAGE_PREFIX + 'settings.v1';
/**
 * Revision of the saved defaults, written next to the settings (`rev`). 2: the training keys left
 * the arrows (bindings.ts LEGACY_TRAINING_KBM), which drive now; settings saved before (no `rev`)
 * get today's training keys wherever they still held the old default and the new key is free.
 */
export const SETTINGS_REV = 2;

export function defaultSettings(): Settings {
  return { controls: { ...DEFAULT_CONTROL_SETTINGS }, camera: { ...DEFAULT_CAMERA }, bindings: defaultProfiles(), audio: { ...DEFAULT_AUDIO }, touch: { ...DEFAULT_TOUCH }, ui: { ...DEFAULT_UI } };
}

function num(v: unknown, lo: number, hi: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

/** A whole number in [0, limit): consumers index tables / build `1 << n` masks with it. */
function isIndex(v: unknown, limit: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < limit;
}

function isBinding(v: unknown): v is Binding {
  if (typeof v !== 'object' || v === null) return false;
  const b = v as Record<string, unknown>;
  switch (b.kind) {
    case 'key':
      return typeof b.code === 'string' && b.code.length > 0;
    case 'mouse':
      // `1 << button` wraps modulo 32: a corrupt 32 / NaN / -1 would alias the left button.
      return isIndex(b.button, MAX_MOUSE_BUTTON + 1);
    case 'mouseAxis':
      return (b.axis === 'x' || b.axis === 'y') && (b.sign === 1 || b.sign === -1);
    case 'wheel':
      return b.sign === 1 || b.sign === -1;
    case 'gpButton':
      return isIndex(b.index, GP_MAX_BUTTONS);
    case 'gpAxis':
      return isIndex(b.index, GP_MAX_AXES) && (b.sign === 1 || b.sign === -1);
    default:
      return false;
  }
}

/** Merge a parsed object over the defaults, validating every field (bad data falls back). */
export function mergeSettings(raw: unknown): Settings {
  const s = defaultSettings();
  if (typeof raw !== 'object' || raw === null) return s;
  const r = raw as {
    controls?: Record<string, unknown>;
    camera?: Record<string, unknown>;
    bindings?: Record<string, unknown>;
    audio?: Record<string, unknown>;
    touch?: Record<string, unknown>;
    ui?: Record<string, unknown>;
    rev?: unknown;
  };
  const c = r.controls ?? {};
  const cs = s.controls;
  for (const k of Object.keys(DEFAULT_CONTROL_SETTINGS) as (keyof ControlSettings)[]) {
    const range = CONTROL_RANGES[k];
    const v = c[k];
    if (range === null) {
      if (typeof v === 'boolean') (cs as unknown as Record<string, boolean>)[k] = v;
    } else {
      (cs as unknown as Record<string, number>)[k] = num(v, range[0], range[1], DEFAULT_CONTROL_SETTINGS[k] as number);
    }
  }
  const cam = r.camera ?? {};
  for (const k of Object.keys(DEFAULT_CAMERA) as (keyof CameraSettings)[]) {
    const range = CAMERA_RANGES[k];
    s.camera[k] = num(cam[k], range[0], range[1], DEFAULT_CAMERA[k]);
  }
  const au = r.audio ?? {};
  s.audio.volume = num(au.volume, VOLUME_RANGE[0], VOLUME_RANGE[1], DEFAULT_AUDIO.volume);
  s.audio.music = num(au.music, VOLUME_RANGE[0], VOLUME_RANGE[1], DEFAULT_AUDIO.music);
  const tc = typeof r.touch === 'object' && r.touch !== null ? r.touch : {};
  if (tc.size === 'S' || tc.size === 'M' || tc.size === 'L') s.touch.size = tc.size;
  s.touch.opacity = num(tc.opacity, TOUCH_OPACITY_RANGE[0], TOUCH_OPACITY_RANGE[1], DEFAULT_TOUCH.opacity);
  if (typeof tc.lefty === 'boolean') s.touch.lefty = tc.lefty;
  if (tc.stick === 'fixed' || tc.stick === 'floating') s.touch.stick = tc.stick;
  s.touch.deadzone = num(tc.deadzone, TOUCH_DEADZONE_RANGE[0], TOUCH_DEADZONE_RANGE[1], DEFAULT_TOUCH.deadzone);
  if (typeof tc.vibration === 'boolean') s.touch.vibration = tc.vibration;
  const ui = typeof r.ui === 'object' && r.ui !== null ? r.ui : {};
  if (typeof ui.size === 'number' && UI_SIZES.includes(ui.size)) s.ui.size = ui.size;
  if (ui.motion === 'on' || ui.motion === 'off' || ui.motion === 'system') s.ui.motion = ui.motion;
  const b = r.bindings ?? {};
  for (const device of ['kbm', 'pad'] as const) {
    const prof = b[device];
    if (typeof prof !== 'object' || prof === null) continue;
    const p = prof as Record<string, unknown>;
    for (const action of Object.keys(s.bindings[device]) as ActionId[]) {
      if (!(action in p)) continue;
      const v = p[action];
      // Pause stays bound on both devices: a paused game
      // with no pause binding anywhere could never be resumed.
      if (v === null) {
        if (action !== 'pause') s.bindings[device][action] = null;
      } else if (isBinding(v) && bindingMatchesDevice(v, device)) s.bindings[device][action] = v;
    }
  }
  // Saved before rev 2: a training key still on its old arrow is the old default, not a choice.
  // It moves to today's key only when no other action of the player has that key (boost on F,
  // ball cam on T: free play would reset the car on every boost); otherwise it keeps its arrow,
  // where the player's own binding wins over the arrow's driving (Input.refreshDerived), as before.
  if (!(typeof r.rev === 'number' && r.rev >= 2)) {
    const kbm = s.bindings.kbm;
    for (const action of Object.keys(LEGACY_TRAINING_KBM) as ActionId[]) {
      const b = kbm[action];
      if (b === null || b.kind !== 'key' || b.code !== LEGACY_TRAINING_KBM[action]) continue;
      const to = DEFAULT_KBM[action];
      if (actionsSharingBinding(kbm, to, action).length === 0) kbm[action] = to;
    }
  }
  return s;
}

export function loadSettings(): Settings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw !== null) return mergeSettings(JSON.parse(raw));
  } catch {
    /* storage unavailable or corrupt */
  }
  return defaultSettings();
}

export function saveSettings(s: Settings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...s, rev: SETTINGS_REV }));
  } catch {
    /* ignore */
  }
}
