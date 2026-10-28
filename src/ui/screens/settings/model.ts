/**
 * Ajustes, pure (the Tablero plan PR 10; the owner's hub-ajustes-pc): the six tabs of the rail, the
 * device sections of CONTROLES (only the devices detected, the last one used first), the camera
 * preset the live values match, the quality trial (a tier applied comes back by itself 10 s later
 * unless kept), the memory tag of the heavy tiers, a binding's conflict and the sliders' maths.
 * No DOM: tests/settings-model.test.mjs and tests/hud-menu.test.mjs import it.
 */
import { t, type Key } from '../../../i18n';
import { ACTION_ROWS, actionsSharingBinding, type ActionId, type Binding, type BindingProfile } from '../../../input/bindings';
import type { CameraSettings } from '../../../render/Camera';
import type { Quality } from '../../../render/quality';
import type { InputKind } from '../../device';
import type { IconName } from '../../components/icons';

/** The rail, in the artboard's order. */
export type SettingsTab = 'controls' | 'camera' | 'game' | 'audio' | 'graphics' | 'experimental';

export const SETTINGS_TABS: ReadonlyArray<{ id: SettingsTab; label: Key; icon: IconName }> = [
  { id: 'controls', label: 'settings.tabControls', icon: 'pad' },
  { id: 'camera', label: 'settings.tabCamera', icon: 'camera' },
  { id: 'game', label: 'settings.tabGameplay', icon: 'ball' },
  { id: 'audio', label: 'settings.tabAudio', icon: 'audio' },
  { id: 'graphics', label: 'settings.tabGraphics', icon: 'graphics' },
  // Always listed (no hidden tab for L / R): a guest's says it needs a sign-in.
  { id: 'experimental', label: 'settings.tabExperimental', icon: 'lab' },
];

/** The tab `d` steps from `tab`, round (L / R, Q / E, LB / RB, LT / RT). */
export function stepSettingsTab(tab: SettingsTab, d: -1 | 1): SettingsTab {
  const i = SETTINGS_TABS.findIndex((x) => x.id === tab);
  const n = SETTINGS_TABS.length;
  return SETTINGS_TABS[(i + d + n) % n].id;
}

/** Menu.open's `tab` (a string from a hash or a caller), or null when it names no tab. */
export function asSettingsTab(id: string | undefined): SettingsTab | null {
  return SETTINGS_TABS.some((x) => x.id === id) ? (id as SettingsTab) : null;
}

/**
 * The Experimental tab's label, a guest's too: their lock is the rail's icon and line ("Sign in"),
 * no emoji in the text (plan §2.6). `available` stays for the callers that pass the account's state.
 */
export function experimentalTabLabel(_available: boolean): string {
  return t('settings.tabExperimental');
}

// ---- CONTROLES ------------------------------------------------------------------------------

/** A device section of CONTROLES. */
export type ControlSection = 'touch' | 'pad' | 'kbm';

export const SECTION_ORDER: readonly ControlSection[] = ['touch', 'pad', 'kbm'];

export interface DevicesSeen {
  /** A touch screen (navigator.maxTouchPoints > 0). */
  readonly touch: boolean;
  /** A controller connected now (Input.hasGamepad). */
  readonly pad: boolean;
  /** A fine pointer, or a key pressed on this page (a keyboard is there). */
  readonly kbm: boolean;
}

/** The sections shown, in the artboard's order: only the devices detected; none (a TV's remote alone): CONTROL, to say none is connected. */
export function controlSections(d: DevicesSeen): ControlSection[] {
  const out = SECTION_ORDER.filter((s) => d[s]);
  return out.length > 0 ? out : ['pad'];
}

/** The section CONTROLES opens on: the last input's device when it is shown, else the first shown. */
export function openingSection(last: InputKind, shown: readonly ControlSection[]): ControlSection {
  const want: ControlSection = last === 'touch' ? 'touch' : last === 'pad' || last === 'remote' ? 'pad' : 'kbm';
  return shown.includes(want) ? want : shown[0];
}

/** The section kept when the detected devices change: the one picked, while it is still shown. */
export function keptSection(picked: ControlSection, shown: readonly ControlSection[], last: InputKind): ControlSection {
  return shown.includes(picked) ? picked : openingSection(last, shown);
}

/** The display group of an action (ACTION_ROWS). */
function groupOf(action: ActionId): string | undefined {
  return ACTION_ROWS.find((r) => r.action === action)?.group;
}

/**
 * Another action of `profile` already on `b` (the first in display order), or null: CONTROLES says
 * so after a capture ("B is also Boost"). A driving action and an air one sharing a key is the
 * standard layout's own (W throttles and pitches, Shift drifts and air-rolls): no conflict. Shared
 * bindings stay allowed, so nothing is swapped.
 */
export function bindConflict(profile: Readonly<BindingProfile>, action: ActionId, b: Binding | null): ActionId | null {
  const mine = groupOf(action);
  const ground = (g: string | undefined): boolean => g === 'driving' || g === 'air';
  return actionsSharingBinding(profile, b, action).find((other) => !(ground(mine) && ground(groupOf(other)) && groupOf(other) !== mine)) ?? null;
}

// ---- CÁMARA ---------------------------------------------------------------------------------

export type CameraPreset = 'default' | 'classic';

/** The preset every value of `cam` equals, or null (the player moved a slider). */
export function cameraPresetOf(cam: Readonly<CameraSettings>, wide: Readonly<CameraSettings>, classic: Readonly<CameraSettings>): CameraPreset | null {
  const same = (p: Readonly<CameraSettings>): boolean => (Object.keys(p) as Array<keyof CameraSettings>).every((k) => cam[k] === p[k]);
  return same(wide) ? 'default' : same(classic) ? 'classic' : null;
}

// ---- GRÁFICOS -------------------------------------------------------------------------------

/** How long an applied tier waits to be kept before the previous one comes back (ms). */
export const QUALITY_TRIAL_MS = 10_000;

/** A tier applied from the cards, waiting for KEEP: `from` comes back at `until` (performance.now()). */
export interface QualityTrial {
  readonly from: Quality;
  readonly to: Quality;
  readonly until: number;
}

export function startTrial(from: Quality, to: Quality, now: number): QualityTrial {
  return { from, to, until: now + QUALITY_TRIAL_MS };
}

/** Whole seconds left on the trial's clock (10 .. 0). */
export function trialSecondsLeft(trial: QualityTrial, now: number): number {
  return Math.max(0, Math.ceil((trial.until - now) / 1000));
}

/** The heavy tiers on a device with little memory (navigator.deviceMemory, GB; a TV counts 1): their cards say so. */
export function memoryTag(q: Quality, memoryGb: number | undefined): boolean {
  return (q === 'high' || q === 'ultra') && memoryGb !== undefined && memoryGb > 0 && memoryGb <= 4;
}

/**
 * A segmented choice whose options may be partly listed (Graphics: Super low only when unlocked):
 * the value `dir` steps reach from `value` among `listed`, in the order of `all`. Left / right (-1 /
 * +1) stop at the ends; accept (0) wraps. From a value that is not listed (a device running Super
 * low on its own) the first step lands on the nearest listed option that way (none below: null),
 * accept on the first one above it. Null: nothing to pick. Pure.
 */
export function choiceStep<T>(all: readonly T[], listed: readonly T[], value: T, dir: -1 | 0 | 1): T | null {
  const opts = all.filter((v) => listed.includes(v));
  if (opts.length === 0) return null;
  const i = opts.indexOf(value);
  if (i >= 0) {
    if (dir === 0) return opts[(i + 1) % opts.length];
    const j = i + dir;
    return j >= 0 && j < opts.length ? opts[j] : null;
  }
  const rank = all.indexOf(value);
  const above = opts.find((v) => all.indexOf(v) > rank);
  if (dir === 1) return above ?? null;
  if (dir === 0) return above ?? opts[0];
  const below = opts.filter((v) => all.indexOf(v) < rank);
  return below.length > 0 ? below[below.length - 1] : null;
}

// ---- sliders --------------------------------------------------------------------------------

/** Decimal places implied by a slider step (1 → 0, 0.5 → 1, 0.05 → 2). */
export function stepDecimals(step: number): number {
  return step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
}

/** Value label for a slider: fixed decimals from the step plus an optional unit suffix. */
export function formatSettingValue(value: number, step: number, suffix = ''): string {
  return value.toFixed(stepDecimals(step)) + suffix;
}

/** Move a slider value by `dir` steps, snapped to the step grid and clamped to [min, max]. */
export function stepSettingValue(value: number, dir: number, min: number, max: number, step: number): number {
  const n = Math.round((value - min) / step) + dir;
  const v = Math.min(max, Math.max(min, min + n * step));
  return Number(v.toFixed(stepDecimals(step)));
}

/** Where `v` sits on [min, max], 0..100 (the track's fill, the thumb, the default's mark). */
export function sliderPercent(v: number, min: number, max: number): number {
  return max > min ? Math.min(100, Math.max(0, ((v - min) / (max - min)) * 100)) : 0;
}

/** The value under a pointer at `x` across a track from `left`, `width` wide, snapped to the grid. */
export function valueAt(x: number, left: number, width: number, min: number, max: number, step: number): number {
  const f = width > 0 ? Math.min(1, Math.max(0, (x - left) / width)) : 0;
  return stepSettingValue(min + f * (max - min), 0, min, max, step);
}
