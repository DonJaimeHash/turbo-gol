/**
 * Player settings (Settings > Controls / Camera), persisted in localStorage.
 * Pure data + load/save. Input.ts mutates `controls` and `bindings` in place, Camera.ts reads
 * `camera`; call saveSettings() after a change.
 */
import type { CameraSettings } from './render/Camera';
import { STORAGE_PREFIX } from './brand';
import {
  GP_MAX_AXES,
  GP_MAX_BUTTONS,
  MAX_MOUSE_BUTTON,
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
}

export interface Settings {
  controls: ControlSettings;
  camera: CameraSettings;
  bindings: BindingProfiles;
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
};

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

export function defaultSettings(): Settings {
  return { controls: { ...DEFAULT_CONTROL_SETTINGS }, camera: { ...DEFAULT_CAMERA }, bindings: defaultProfiles() };
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
  const r = raw as { controls?: Record<string, unknown>; camera?: Record<string, unknown>; bindings?: Record<string, unknown> };
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
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
