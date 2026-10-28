/**
 * DOM HUD (the Tablero plan PR 7; the owner's hub-partido-pc): the scorebug (top left, in the
 * order TAG n │ clock │ n TAG, a lime notch under the player's team, the network bars by the
 * clock online), the boost plate (bottom left, the speed readout above it in debug mode), fps,
 * camera mode, the off-screen ball indicator (kept off the HUD's plates), the countdown (with the
 * overtime line over it), the centre for ¡GOOOL! (the scoring team's slab and the scorer's chip)
 * and the final whistle only, a feed of at most two chips at the top (joined, left, a bot takes
 * over, DEMOLIDO), the pause as a dock (FocusNav, PARTIDO EN JUEGO online, SALIR held), the Tab
 * scoreboard, a pointer-lock hint and the settings screen (rebinding for keyboard/mouse and
 * controller, camera and gameplay sliders, the master volume, the graphics quality, the
 * account-only experimental switch and physics preset editor: experimentalPage.ts). Every
 * per-frame setter caches its last value and touches the DOM only when something changed, so
 * calling them every frame costs nothing and allocates nothing.
 *
 * The controls card (bottom right, src/render/controlsCard.ts: the first matches' kickoff countdown
 * and free play, then a slim strip) is drawn by `setControlsCard` from rows the Game builds.
 *
 * Debug readouts (speed, fps / draw calls / GPU time) are hidden by default; F3 toggles them,
 * and `#stats` or `#debug` in the URL shows them from the start.
 *
 * Settings navigation: the Hud listens to window keydown itself (keyboard); the Game forwards
 * gamepad edges through `menuAction`. While a rebind capture is in progress (`capturing`) both
 * paths are ignored so the captured key / button only reaches Input.startRebind. The pause dock is
 * driven by the Game instead (`pauseAction`, from Input's menu edges: keyboard and pad alike, onto
 * src/ui/nav.ts FocusNav), since the pause / back keys it shares with the match are Input's.
 *
 * Styling lives in src/style.css (classes prefixed `hud-`).
 */
import {
  ACTION_ROWS,
  bindingsEqual,
  type ActionId,
  type Binding,
  type BindingPreset,
  type Device,
} from '../input/bindings';
import {
  CAMERA_RANGES,
  CONTROL_RANGES,
  DEFAULT_AUDIO,
  DEFAULT_CAMERA,
  DEFAULT_CONTROL_SETTINGS,
  CLASSIC_CAMERA_DEFAULTS,
  VOLUME_RANGE,
  type ControlSettings,
  type Settings,
} from '../settings';
import { PEER_CAND_LABELS, PEER_STATE_LABELS, type NetStatsView } from '../net/NetStats';
import { isNodeHost } from '../net/protocol';
import type { GameMode } from '../sim/constants';
import { t, type Key } from '../i18n';
import type { CameraSettings } from './Camera';
import { pageFlags } from './hashFlags';
import { QUALITIES, type Quality } from './quality';
import { buildExperimentalPage, type ExperimentalOptions, type ExperimentalPage } from './experimentalPage';
import type { CardKey, CardView, ControlsCardContent } from './controlsCard';
import { pauseResumeKeys } from '../game/pauseKeys';
import { DEFAULT_MATCH_SECONDS, formatClockSeconds } from '../game/Match';
import { FocusNav } from '../ui/nav';

export type Difficulty = 'easy' | 'medium' | 'hard';
export const DIFFICULTIES: readonly Difficulty[] = ['easy', 'medium', 'hard'];
/** Menu order of the game modes (every key of MODES). */
export const GAME_MODES: readonly GameMode[] = ['1v1', '2v2', '3v3'];

/** How the clock is displayed: counting down, counting up (unlimited match) or overtime (+m:ss, red). */
export type ClockMode = 'regulation' | 'unlimited' | 'overtime';

/** An online session's kind: 'p2p' = the mesh (phase 2), 'server' = a server match (phase 1). */
export type OnlineKind = 'p2p' | 'server';

/** The network bars by the clock (3 good, 1 poor) from the round trip and the loss; 0: nothing to show yet. */
export function netBars(rttMs: number, lossPct: number): 0 | 1 | 2 | 3 {
  if (!(rttMs > 0)) return 0;
  if (rttMs >= 200 || lossPct >= 8) return 1;
  if (rttMs >= 110 || lossPct >= 3) return 2;
  return 3;
}

/** A box on the HUD (CSS px of its root) the ball indicator stays out of. */
export interface HudRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Where the ball indicator goes when (x, y) falls inside one of `rects` grown by `r` (the glyph's
 * reach): out along the shortest way that stays on the `w` x `h` screen, else where it was. Pure;
 * writes `out` (no allocation per frame).
 */
export function avoidRects(x: number, y: number, r: number, rects: readonly HudRect[], w: number, h: number, out: { x: number; y: number }): void {
  out.x = x;
  out.y = y;
  for (const b of rects) {
    const l = b.left - r;
    const tp = b.top - r;
    const rt = b.right + r;
    const bt = b.bottom + r;
    if (out.x <= l || out.x >= rt || out.y <= tp || out.y >= bt) continue;
    let best = Infinity;
    let nx = out.x;
    let ny = out.y;
    const tryAt = (cx: number, cy: number): void => {
      if (cx < r || cx > w - r || cy < r || cy > h - r) return;
      const d = Math.abs(cx - out.x) + Math.abs(cy - out.y);
      if (d < best) {
        best = d;
        nx = cx;
        ny = cy;
      }
    };
    tryAt(l, out.y);
    tryAt(rt, out.y);
    tryAt(out.x, tp);
    tryAt(out.x, bt);
    out.x = nx;
    out.y = ny;
  }
}

/**
 * Menu status string of the online flow's anti-bot step (Turnstile in front of POST /api/guest):
 * OnlineSession shows `verifying` while the widget is up. A failed check (NetError 'turnstile')
 * reads as error.queue.turnstile_* (src/net/netErrorText.ts).
 */
export const ONLINE_STATUS = {
  verifying: t('online.verifying'),
} as const;

/**
 * What the settings screen needs from the input layer (implemented by Input).
 *
 * `startRebind` resolves with the captured binding, or null when the capture was cancelled
 * (Esc on either device / timeout / `cancelRebind` from BACK or the capturing cell). The Hud then
 * calls `setBinding` if the stored binding differs from the result (so Input may or may not apply
 * it itself), refreshes every label of that device (a swap / unbind of a conflicting action shows
 * up) and fires onSettingsChanged. The capture must listen on `window` (keydown / mousedown /
 * wheel in the capture phase, and gamepad polling): the menu overlay sits above the canvas and
 * swallows pointer events. The Hud passes the capturing cell as `wheelTarget` so only a wheel
 * turned over it binds (the list may be scrolled meanwhile).
 */
export interface RebindSource {
  getBinding(action: ActionId, device: Device): Binding | null;
  getLabel(action: ActionId, device: Device): string;
  startRebind(action: ActionId, device: Device, wheelTarget?: EventTarget | null): Promise<Binding | null>;
  /** Abort the pending capture (its promise resolves with null). Without it only Esc / timeout end one. */
  cancelRebind?(): void;
  setBinding(action: ActionId, device: Device, b: Binding | null): void;
  resetBindings(device: Device, preset?: BindingPreset): void;
  /** settings.controls changed (sensitivities, deadzones, mouse steering, vibration...). */
  settingsChanged(): void;
  readonly hasGamepad: boolean;
  readonly gamepadName: string | null;
}

export interface MenuOptions {
  quality: Quality;
  /**
   * The tiers Settings > Graphics lists (quality.ts menuQualities: Super low only for a signed-in
   * player with experimental features on); every tier when absent. A running tier outside the
   * list lights no chip and shows `qualityNote` under the row.
   */
  qualities?: readonly Quality[];
  /** The line under the quality row while the running tier is not listed (default settings.qualityAuto). */
  qualityNote?: string;
  /** Settings > Experimental (absent: the page shows the guest's locked line). */
  experimental?: ExperimentalOptions;
  /** The quality tier picked (the settings screen's Graphics tab). */
  onQualityChange?: (quality: Quality) => void;
  /**
   * The live settings object (src/settings.ts). The Camera / Gameplay tabs write into
   * `settings.camera` / `settings.controls` in place. The screen opens only with it and `input`.
   */
  settings?: Settings;
  /** Rebinding API (Input). */
  input?: RebindSource;
  /**
   * Fired after every change made in the settings screen (a slider, a toggle, a rebind, a
   * clear, a preset). The Game saves the settings and re-applies camera / dodge deadzone.
   */
  onSettingsChanged?: () => void;
  /**
   * Camera preset buttons. When this fires the preset has already been copied into
   * `settings.camera` and the sliders refreshed; `onSettingsChanged` fires right after it.
   */
  onCameraPreset?: (which: 'default' | 'classic') => void;
}

/**
 * Gamepad / input layer routes these while the settings screen is shown (the keyboard goes
 * through the Hud's own listener). 'settings' = the next tab, 'back' = leave the screen, 'up' /
 * 'down' = move the focus, 'tabPrev' / 'tabNext' = the previous / next tab (pad LB / RB and
 * LT / RT; Q / E).
 */
export type MenuAction = 'accept' | 'left' | 'right' | 'settings' | 'up' | 'down' | 'back' | 'tabPrev' | 'tabNext';

export type SettingsTab = 'kbm' | 'pad' | 'camera' | 'gameplay' | 'audio' | 'graphics' | 'experimental';

/**
 * One entry of the pause menu (setPaused): RESUME, SETTINGS, QUIT, and the training entries in
 * between. The Game builds the list; the Hud draws it and moves the focus.
 */
export interface PauseEntry {
  /** Stable id ('resume', 'settings', 'quit'...): setPauseCovered(false, id) focuses it again. */
  readonly id: string;
  /** The button text, read again after every activation (a toggle changes it). */
  readonly label: () => string;
  /**
   * 'primary': RESUME's lime look; 'quit': the red edge; 'row': a smaller button on a shared row
   * (training), one focus stop for the row (left / right pick); default: a plain wide button.
   */
  readonly kind?: 'primary' | 'quit' | 'row';
  /**
   * Leaving a match: held for HOLD_MS (A / Enter, a finger) or double-clicked with a mouse; a
   * plain press or click only says how (the plan's mn-hold, pause.holdHint).
   */
  readonly hold?: boolean;
  /** A line under the label (QUIT in Competitivo: it counts as an abandon). */
  readonly sub?: () => string | null;
  /** `mouse`: a real mouse click picked it (the Game captures the mouse again on a resume). */
  readonly select: (mouse: boolean) => void;
}

/** How long QUIT is held (plan §1.7: 1000 ms to leave). */
export const HOLD_MS = 1000;

/** The feed: chips at once, and how long each stays. */
const FEED_MAX = 2;
const FEED_MS = 2500;

/** How far the ball indicator's glyph reaches round its point (the dot, its arrow and its distance). */
const IND_REACH = 34;

/** The last input was a finger (device.ts: touch draws no ring, focuses nothing). */
function touchMode(): boolean {
  return document.documentElement.classList.contains('tg-touch');
}

/** A real mouse click (not a tap, not a key / pad activation through `.click()`). */
function isMouseClick(e: MouseEvent): boolean {
  if (!e.isTrusted) return false;
  const type = (e as Partial<PointerEvent>).pointerType;
  return type !== undefined ? type === 'mouse' : e.detail > 0;
}

/** What the pause menu takes from the Game: Input's menu edges (keyboard and pad). */
export type PauseAction = 'up' | 'down' | 'left' | 'right' | 'accept';

/** One car on the Tab scoreboard. */
export interface ScoreboardRow {
  name: string;
  team: 0 | 1;
  /** The human's car: 'YOU' tag. */
  you: boolean;
  /** 'BOT' tag (default true for every other car); false = a remote human (online). */
  bot?: boolean;
}

/**
 * Data for the Tab scoreboard. Reuse one object per frame: the Hud compares field by field (the
 * `rows` are compared by content, so an in-place refill is fine too).
 */
export interface ScoreboardData {
  blue: number;
  red: number;
  /** Preformatted clock text (e.g. '3:21' or '+0:42'). */
  clock: string;
  difficulty: string;
  /** Game mode for the footer ('3v3'). */
  mode?: string;
  /** Every car, any order (listed under its team). Without it the two legacy fields below make two rows. */
  rows?: readonly ScoreboardRow[];
  playerName?: string;
  botName?: string;
  /** Which team the human plays on (default 0 = blue). */
  playerTeam?: 0 | 1;
}

// The settings screen's tables hold text keys: t() runs when the screen is built (once per page).
// The language is fixed for the page, so resolving them at import would work too (ACTION_ROWS does).
const SETTINGS_TABS: ReadonlyArray<{ id: SettingsTab; label: Key }> = [
  { id: 'kbm', label: 'settings.tabKbm' },
  { id: 'pad', label: 'settings.tabPad' },
  { id: 'camera', label: 'settings.tabCamera' },
  { id: 'gameplay', label: 'settings.tabGameplay' },
  { id: 'audio', label: 'settings.tabAudio' },
  { id: 'graphics', label: 'settings.tabGraphics' },
  // Always listed (no hidden-tab logic for the strip and Q / E): a guest's says it is locked.
  { id: 'experimental', label: 'settings.tabExperimental' },
];

/** The Experimental tab's label: a lock for a guest, like Competitive's. */
export function experimentalTabLabel(available: boolean): string {
  return available ? t('settings.tabExperimental') : `${t('settings.tabExperimental')} 🔒`;
}

/**
 * A segmented choice whose options may be partly listed (Settings > Graphics: Super low only when
 * unlocked): the value `dir` steps reach from `value` among `listed`, in the order of `all`. Left /
 * right (-1 / +1) stop at the ends; accept (0) wraps. From a value that is not listed (a device
 * running Super low on its own) the first step lands on the nearest listed option that way (none
 * below: null), accept on the first one above it. Null: nothing to pick. Pure.
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

/** The line under the Graphics tab's quality row, per tier. */
const QUALITY_HINTS: Readonly<Record<Quality, Key>> = {
  superlow: 'settings.qualitySuperlowHint',
  low: 'settings.qualityLowHint',
  high: 'settings.qualityHighHint',
  ultra: 'settings.qualityUltraHint',
};

const GROUP_TITLES: Readonly<Record<'driving' | 'air' | 'camera' | 'game', Key>> = {
  driving: 'settings.groupDriving',
  air: 'settings.groupAir',
  camera: 'settings.groupCamera',
  game: 'settings.groupGame',
};

const CAMERA_SLIDERS: ReadonlyArray<{ key: keyof CameraSettings; label: Key; suffix: string }> = [
  { key: 'fov', label: 'settings.cameraFov', suffix: '°' },
  { key: 'distance', label: 'settings.cameraDistance', suffix: '' },
  { key: 'height', label: 'settings.cameraHeight', suffix: '' },
  { key: 'angle', label: 'settings.cameraAngle', suffix: '°' },
  { key: 'stiffness', label: 'settings.cameraStiffness', suffix: '' },
  { key: 'swivelSpeed', label: 'settings.cameraSwivelSpeed', suffix: '' },
  { key: 'transitionSpeed', label: 'settings.cameraTransitionSpeed', suffix: '' },
];

const GAMEPLAY_ROWS: ReadonlyArray<{ key: keyof ControlSettings; label: Key }> = [
  { key: 'steeringSensitivity', label: 'settings.steeringSensitivity' },
  { key: 'aerialSensitivity', label: 'settings.aerialSensitivity' },
  { key: 'controllerDeadzone', label: 'settings.controllerDeadzone' },
  { key: 'dodgeDeadzone', label: 'settings.dodgeDeadzone' },
  { key: 'mouseSensitivity', label: 'settings.mouseSensitivity' },
  { key: 'mouseSteering', label: 'settings.mouseSteering' },
  { key: 'mouseSteeringSensitivity', label: 'settings.mouseSteeringSensitivity' },
  { key: 'invertAirPitch', label: 'settings.invertAirPitch' },
  { key: 'vibration', label: 'settings.vibration' },
];

/** Key names shown in the settings screen's texts: never translated, passed as {placeholders}. */
const SETTINGS_KEYS = {
  nav: '↑ ↓',
  adjust: '← →',
  select: 'Enter / A',
  clear: 'Del',
  tabs: 'Q E / X',
  back: 'Esc / B',
  cancel: 'Esc',
} as const;

/** The camera presets' values (field of view / distance / height), shown after their names. */
const PRESET_WIDE_VALUES = '110/270/100';
const PRESET_CLASSIC_VALUES = '90/270/100';

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

/** One keyboard / gamepad focusable thing in a menu. Handlers are optional per item. */
interface FocusItem {
  /** Element that receives the `hud-focus` class. */
  el: HTMLElement;
  left?: () => void;
  right?: () => void;
  accept?: () => void;
  /** Delete key: unbind. */
  clear?: () => void;
  /** left / right follow a held arrow's auto-repeat (a slider); every other row steps once per press. */
  repeat?: boolean;
}

interface BindRow {
  action: ActionId;
  device: Device;
  row: HTMLElement;
  cell: HTMLButtonElement;
}

interface PageBuild {
  page: HTMLElement;
  /** The page's focus stops; a function when they depend on what the page shows now. */
  items: FocusItem[] | (() => FocusItem[]);
  /** Footer buttons of the page (shown only while its tab is active). */
  actions: HTMLElement;
  /** Their focus stop; null when the page has no footer buttons. */
  footer: FocusItem | null;
}

/** Wrapping focus over a list of items (an arrow's auto-repeat stops at the ends); keeps the `hud-focus` class on the current one. */
class FocusRing {
  items: FocusItem[] = [];
  index = 0;
  private current: FocusItem | null = null;

  get item(): FocusItem | null {
    return this.current;
  }

  use(items: FocusItem[], index = 0): void {
    this.clear();
    this.items = items;
    this.set(index, false);
  }

  set(i: number, scroll = true): void {
    const items = this.items;
    if (items.length === 0) {
      this.clear();
      return;
    }
    const n = ((i % items.length) + items.length) % items.length;
    const next = items[n];
    if (next !== this.current) {
      if (this.current !== null) this.current.el.classList.remove('hud-focus');
      next.el.classList.add('hud-focus');
      this.current = next;
    }
    this.index = n;
    if (scroll) next.el.scrollIntoView({ block: 'nearest' });
  }

  /** One step; `wrap` false (an arrow's auto-repeat): nothing past the first / last item. */
  move(dir: number, wrap = true): void {
    const j = this.index + dir;
    if (!wrap && (j < 0 || j >= this.items.length)) return;
    this.set(j);
  }

  /** Pointer interaction: focus the row that was touched (no scrolling). */
  focusItem(item: FocusItem): void {
    const i = this.items.indexOf(item);
    if (i >= 0) this.set(i, false);
  }

  clear(): void {
    if (this.current !== null) this.current.el.classList.remove('hud-focus');
    this.current = null;
    this.index = 0;
  }
}

export class Hud {
  readonly root: HTMLElement;

  /** Labels the per-frame / per-event setters swap in, translated once here (never t() per frame). */
  private readonly labelBallCam = t('hud.ballCam');
  private readonly labelCarCam = t('hud.carCam');
  private readonly labelGo = t('hud.go');
  private readonly labelYou = t('hud.you');
  private readonly labelBot = t('hud.bot');

  private readonly scoreBlue: HTMLElement;
  private readonly scoreRed: HTMLElement;
  private readonly clock: HTMLElement;
  private readonly scoreBox: HTMLElement;
  /** The network bars by the clock (online; netBars). */
  private readonly netBarsEl: HTMLElement;
  private lastBars = -1;
  private lastTeam = -1;
  private readonly boostValue: HTMLElement;
  private readonly boostFill: HTMLElement;
  private readonly boostBox: HTMLElement;
  private readonly speedValue: HTMLElement;
  private readonly speedBox: HTMLElement;
  private readonly fps: HTMLElement;
  private readonly fpsInfo: HTMLElement;
  private readonly camMode: HTMLElement;
  private readonly ballInd: HTMLElement;
  private readonly ballIndArrow: HTMLElement;
  private readonly ballIndDist: HTMLElement;
  /** The plates the ball indicator stays out of (measured on a resize and as the controls card comes and goes). */
  private readonly indRects: HudRect[] = [];
  private indRectsKey = '';
  private readonly indAt = { x: 0, y: 0 };
  private readonly countdown: HTMLElement;
  /** TIEMPO EXTRA over the overtime kickoff's countdown (showOvertime). */
  private readonly countdownCaption: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly bannerTitle: HTMLElement;
  private readonly bannerSub: HTMLElement;
  /** ¡GOOOL!: the scoring team's slab, the scorer's chip under it. */
  private readonly goal: HTMLElement;
  private readonly goalChip: HTMLElement;
  private goalTimer = 0;
  /** The feed (top centre): at most FEED_MAX chips, each FEED_MS. */
  private readonly feedEl: HTMLElement;
  private readonly paused: HTMLElement;
  private readonly pausedTitle: HTMLElement;
  private readonly pausedLive: HTMLElement;
  private readonly pausedSub: HTMLElement;
  /** The pause dock's buttons (setPaused rebuilds them from the Game's entries). */
  private readonly pauseMenu: HTMLElement;
  /** Spatial focus over the dock (src/ui/nav.ts), driven by pauseAction. */
  private readonly pauseNav: FocusNav;
  private pauseOpen = false;
  /** The settings screen is open over the pause menu (setPauseCovered). */
  private pauseCovered = false;
  private pauseEntries: readonly PauseEntry[] = [];
  /** One button per entry, in entry order. */
  private readonly pauseButtons: HTMLButtonElement[] = [];
  /** The held entry (PauseEntry.hold), its timer and its button's fill. */
  private holding: PauseEntry | null = null;
  private holdTimer = 0;
  /** The hold came from A / Enter: the Game ends it when they are let go (pauseHoldRelease). */
  private holdByKey = false;
  private readonly hint: HTMLElement;
  private readonly controls: HTMLElement;
  private readonly controlsTag: HTMLElement;
  private readonly controlsRows: HTMLElement;
  private readonly controlsFoot: HTMLElement;
  private controlsView: CardView = 'off';
  private controlsContent: ControlsCardContent | null = null;

  // Scoreboard (Tab).
  private readonly scoreboard: HTMLElement;
  private readonly sbBlue: HTMLElement;
  private readonly sbRed: HTMLElement;
  private readonly sbClock: HTMLElement;
  /** Row containers per team and the rows currently in the DOM (content cache for the diff). */
  private readonly sbRowsEl: readonly [HTMLElement, HTMLElement];
  private readonly sbShown: ScoreboardRow[] = [];
  /** Rows synthesised from the legacy playerName / botName fields (refilled in place). */
  private readonly sbLegacy: [ScoreboardRow, ScoreboardRow] = [
    { name: 'Player', team: 0, you: true },
    { name: 'Bot', team: 1, you: false },
  ];
  private readonly sbFoot: HTMLElement;

  // The settings overlay (openSettingsScreen), the Turnstile slot, the network panel.
  private menu: HTMLElement | null = null;
  private readonly turnstileBox: HTMLElement;
  private readonly net: HTMLElement;
  private readonly netBody: HTMLElement;
  private readonly netWait: HTMLElement;
  private lastNetWait: string | null = null;
  private netToggle = false;
  private netAuto = false;
  private netShown = false;
  private lastNetAt = -1e9;
  private lastNetText = '';
  private menuOptions: MenuOptions | null = null;
  private quality: Quality = 'high';
  /** A picked tier that waits for the online match to end (Game.switchQuality): its line on the Graphics tab. */
  private qualityPending: Quality | null = null;
  private debug = false;

  // Settings screen.
  private settingsPanel: HTMLElement | null = null;
  private settingsBody: HTMLElement | null = null;
  private settingsOpen = false;
  /** openSettingsScreen: the settings screen alone over the front-end menus; BACK calls this and hides the overlay. */
  private settingsOnlyClose: (() => void) | null = null;
  private tab: SettingsTab = 'kbm';
  private readonly tabButtons: HTMLButtonElement[] = [];
  private pages: Record<SettingsTab, HTMLElement> | null = null;
  private pageActions: Record<SettingsTab, HTMLElement> | null = null;
  /** Each tab's focus stops, read when the tab is selected or refreshed (a page may show or hide rows). */
  private tabItems: Record<SettingsTab, () => FocusItem[]> | null = null;
  private experimentalPage: ExperimentalPage | null = null;
  private readonly settingsRing = new FocusRing();
  private readonly bindRows: BindRow[] = [];
  private captureRow: BindRow | null = null;
  private readonly refreshers: Array<() => void> = [];
  private padStatus: HTMLElement | null = null;
  private lastPadPresent: boolean | null = null;
  private lastPadName: string | null = null;
  private padTimer = 0;

  private lastBlue = -1;
  private lastRed = -1;
  private lastClockSec = -1;
  private lastClockMode: ClockMode | null = null;
  private lastBoost = -1;
  private lastSpeed = -1;
  private lastSupersonic = false;
  private lastFps = -1;
  private lastInfo = '';
  private lastBallCam: boolean | null = null;
  private lastCountdown: string | null = null;
  private bannerTimer = 0;
  private indVisible = false;
  private indX = -1;
  private indY = -1;
  private indAngle = -1;
  private indDist = -1;
  private rootW = 0;
  private rootH = 0;
  private sbVisible = false;
  private lastSbBlue = -1;
  private lastSbRed = -1;
  private lastSbClock = '';
  private lastSbDifficulty = '';
  private lastSbMode: string | undefined = '';
  private lastHint: string | null = null;

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    // A rebind capture owns the keyboard: Enter / Esc / anything must reach Input only.
    if (this.captureRow !== null) return;
    // The Hud's own text fields (the preset name, the legacy guest name): letters must type, not
    // navigate; Enter / Esc leave them. The menus' fields are the menus' (src/ui/nav.ts: editing mode).
    if (e.target instanceof HTMLInputElement && e.target.type === 'text' && this.root.contains(e.target)) {
      if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Escape') {
        e.target.blur();
        e.preventDefault();
      }
      return;
    }
    if (e.code === 'F3') {
      this.setDebug(!this.debug);
      e.preventDefault();
      return;
    }
    if (e.code === 'F4') {
      this.setNetToggle(!this.netToggle);
      e.preventDefault();
      return;
    }
    if (this.menu === null || this.menu.hidden || !this.settingsOpen) return;
    // Alt + ← is the browser's Back (BackGuard: the screen goes back), not a value step.
    if (e.altKey) return;
    const action = settingsKeyAction(e.code);
    if (action !== null) {
      this.menuAction(action, e.repeat); // the key's own repeat: as the pad's (menuAction)
      e.preventDefault();
      return;
    }
    switch (e.code) {
      case 'Delete':
        this.clearFocused();
        break;
      case 'KeyQ':
      case 'KeyE':
        if (!e.repeat) this.menuAction(e.code === 'KeyQ' ? 'tabPrev' : 'tabNext');
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  private readonly onResize = (): void => {
    this.rootW = 0;
    this.rootH = 0;
    this.indRectsKey = '';
  };

  constructor(container: HTMLElement) {
    this.root = el('div', 'hud-root');
    container.appendChild(this.root);

    // Turnstile widget slot: the online client renders the anti-bot widget here while it registers a
    // guest or an account (appearance 'interaction-only': nothing shows unless Cloudflare asks for a
    // click). It sits on the root, above every menu layer (the src/ui front-end and the settings screen).
    this.turnstileBox = el('div', 'hud-turnstile');
    this.turnstileBox.hidden = true;
    this.root.appendChild(this.turnstileBox);

    // Scorebug (top left), as the owner kept it: [BLU 0 │ 3:00 │ 0 RED], the network bars by the
    // clock online, a lime notch under the player's team (setTeam). The three-letter tags keep the
    // teams apart without relying on colour alone. It sits over the pause's veil (--z-score).
    const top = el('div', 'hud-top');
    const board = el('div', 'hud-score');
    this.scoreBlue = el('span', 'hud-score-goals', '0');
    this.scoreRed = el('span', 'hud-score-goals', '0');
    this.clock = el('span', 'hud-clock-time', formatClockSeconds(DEFAULT_MATCH_SECONDS));
    this.netBarsEl = el('span', 'hud-bars');
    this.netBarsEl.append(el('i', ''), el('i', ''), el('i', ''));
    this.netBarsEl.hidden = true;
    const clockBox = el('span', 'hud-clock');
    clockBox.append(this.clock, this.netBarsEl);
    board.append(el('span', 'hud-score-tag hud-blue', t('hud.tagBlue')), this.scoreBlue, clockBox, this.scoreRed, el('span', 'hud-score-tag hud-red', t('hud.tagRed')));
    this.scoreBox = board;
    top.append(board, el('span', 'hud-notch'));
    this.root.appendChild(top);

    const fpsBox = el('div', 'hud-fps');
    this.fps = el('span', 'hud-fps-value', '');
    this.fpsInfo = el('span', 'hud-fps-info', '');
    fpsBox.append(this.fps, this.fpsInfo);
    this.root.appendChild(fpsBox);

    this.camMode = el('div', 'hud-cam', this.labelBallCam);
    this.root.appendChild(this.camMode);

    this.hint = el('div', 'hud-hint');
    this.hint.hidden = true;
    this.root.appendChild(this.hint);

    // Controls card (bottom right): opaque graphite, no blur over the live canvas; the rows come
    // from the Game (setControlsCard), the strip layout is a class on the same element.
    this.controls = el('section', 'hud-controls');
    this.controls.setAttribute('aria-label', t('controls.title'));
    const controlsHead = el('div', 'hud-controls-head');
    this.controlsTag = el('span', 'hud-controls-tag', '');
    controlsHead.append(el('span', 'hud-controls-title', t('controls.title')), this.controlsTag);
    this.controlsRows = el('div', 'hud-controls-rows');
    this.controlsFoot = el('div', 'hud-controls-foot', '');
    this.controls.append(controlsHead, this.controlsRows, this.controlsFoot);
    this.controls.hidden = true;
    this.root.appendChild(this.controls);

    this.speedBox = el('div', 'hud-speed');
    this.speedValue = el('div', 'hud-speed-value', '0');
    const speedUnit = el('div', 'hud-speed-unit', 'km/h');
    this.speedBox.append(this.speedValue, speedUnit);
    this.root.appendChild(this.speedBox);

    // Boost (bottom left): a slanted bar of ten segments with the amount beside it. The fill is
    // one element scaled along x; the segment gaps are a static overlay.
    this.boostBox = el('div', 'hud-boost');
    const boostBar = el('div', 'hud-boost-bar');
    this.boostFill = el('div', 'hud-boost-fill');
    boostBar.append(this.boostFill, el('div', 'hud-boost-segs'));
    this.boostValue = el('div', 'hud-boost-value', '33');
    this.boostBox.append(el('div', 'hud-boost-label', t('hud.boost')), boostBar, this.boostValue);
    this.root.appendChild(this.boostBox);

    // Off-screen ball indicator: a ball glyph pinned to the screen edge with an arrow and distance.
    this.ballInd = el('div', 'hud-ball-ind');
    this.ballIndArrow = el('span', 'hud-ball-ind-arrow');
    const dot = el('span', 'hud-ball-ind-dot');
    this.ballIndDist = el('span', 'hud-ball-ind-dist', '');
    this.ballInd.append(this.ballIndArrow, dot, this.ballIndDist);
    this.ballInd.hidden = true;
    this.root.appendChild(this.ballInd);

    this.countdown = el('div', 'hud-countdown');
    this.countdown.hidden = true;
    this.root.appendChild(this.countdown);
    this.countdownCaption = el('div', 'hud-countdown-caption');
    this.countdownCaption.append(el('b', '', t('game.overtime')), el('span', '', t('game.nextGoalWins')));
    this.countdownCaption.hidden = true;
    this.root.appendChild(this.countdownCaption);

    this.banner = el('div', 'hud-banner');
    this.bannerTitle = el('div', 'hud-banner-title');
    this.bannerSub = el('div', 'hud-banner-sub');
    this.banner.append(this.bannerTitle, this.bannerSub);
    this.banner.hidden = true;
    this.root.appendChild(this.banner);

    // ¡GOOOL! (the owner's banner): the word on a slab of the scoring team's colour with a lime
    // heel, the scorer and the score on a chip under it (showGoal).
    this.goal = el('div', 'hud-goal');
    this.goal.setAttribute('role', 'status');
    const slab = el('div', 'hud-goal-slab');
    slab.append(el('span', 'hud-goal-word', t('hud.goal')));
    this.goalChip = el('div', 'hud-goal-chip');
    this.goal.append(slab, this.goalChip);
    this.goal.hidden = true;
    this.root.appendChild(this.goal);

    // The feed (top centre): who joined or left, a bot taking over, your demolitions.
    this.feedEl = el('div', 'hud-feed');
    this.feedEl.setAttribute('role', 'status');
    this.root.appendChild(this.feedEl);

    // Scoreboard (held Tab / Back): team scores, clock, who is who.
    this.scoreboard = el('div', 'hud-scoreboard');
    const sbPanel = el('div', 'hud-sb-panel');
    const sbHead = el('div', 'hud-sb-head');
    this.sbBlue = el('div', 'hud-sb-score hud-blue', '0');
    this.sbClock = el('div', 'hud-sb-clock', '5:00');
    this.sbRed = el('div', 'hud-sb-score hud-red', '0');
    sbHead.append(this.sbBlue, this.sbClock, this.sbRed);
    const sbTeams = el('div', 'hud-sb-teams');
    const blueCol = el('div', 'hud-sb-team hud-blue');
    const blueRows = el('div', 'hud-sb-rows');
    blueCol.append(el('div', 'hud-sb-team-name', t('hud.teamBlue')), blueRows);
    const redCol = el('div', 'hud-sb-team hud-red');
    const redRows = el('div', 'hud-sb-rows');
    redCol.append(el('div', 'hud-sb-team-name', t('hud.teamRed')), redRows);
    this.sbRowsEl = [blueRows, redRows];
    sbTeams.append(blueCol, redCol);
    this.sbFoot = el('div', 'hud-sb-foot', '');
    sbPanel.append(sbHead, sbTeams, this.sbFoot);
    this.scoreboard.appendChild(sbPanel);
    this.scoreboard.hidden = true;
    this.root.appendChild(this.scoreboard);

    // The pause (plan §1.4 "Pausa"): the veil without blur, the scorebug above it (--z-score), a
    // title plate (PAUSA; online "● PARTIDO EN JUEGO": the match goes on, the car stands still) and
    // the dock at the bottom, for every input: the mouse and a finger click its buttons, the
    // keyboard and the pad move the focus over it (FocusNav; the Game routes Input's menu edges to
    // pauseAction). Only the plate and the dock take the pointer: a click or tap on the veil still
    // reaches the canvas (resume). The key line stays for the keyboard (style.css hides it in touch
    // mode). QUIT is held (PauseEntry.hold): a slip next to RESUME leaves no match.
    this.paused = el('div', 'hud-paused');
    this.pausedTitle = el('div', 'hud-paused-title', t('pause.title'));
    this.pausedLive = el('div', 'hud-paused-live');
    this.pausedLive.append(el('b', '', t('pause.live')), el('span', '', t('pause.liveSub')));
    this.pausedLive.hidden = true;
    this.pausedSub = el('div', 'hud-paused-sub', t('pause.hintDefault', { resumeKeys: pauseResumeKeys('Esc', 'Start') }));
    const plate = el('div', 'hud-paused-plate');
    plate.append(this.pausedTitle, this.pausedLive, this.pausedSub);
    this.pauseMenu = el('div', 'hud-pause-menu');
    // DOM focus stays off a clicked button (a mouse has no ring), and Enter / Space never click the
    // focused one natively: the Game's accept does (pauseAction), once.
    this.pauseMenu.addEventListener('mousedown', (e: MouseEvent) => e.preventDefault());
    const noNative = (e: KeyboardEvent): void => {
      if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space') e.preventDefault();
    };
    this.pauseMenu.addEventListener('keydown', noNative);
    this.pauseMenu.addEventListener('keyup', noNative);
    this.pauseNav = new FocusNav(() => [{ name: 'dock', el: this.pauseMenu, main: true }], {
      onFocus: (target) => {
        for (const b of this.pauseMenu.querySelectorAll('.hud-focus')) b.classList.remove('hud-focus');
        target.classList.add('hud-focus');
        target.parentElement?.classList.toggle('hud-focus', target.parentElement.classList.contains('hud-pause-row'));
      },
    });
    this.pauseNav.install(this.pauseMenu);
    this.paused.append(plate, this.pauseMenu);
    this.paused.hidden = true;
    this.root.appendChild(this.paused);

    // Network panel (online): F4 toggles it, `#net` shows it from the start, debug mode shows it
    // while a match is online (setNetAuto).
    this.net = el('div', 'hud-net');
    this.netBody = el('pre', 'hud-net-body', '');
    this.net.append(el('div', 'hud-net-title', 'NETWORK  (F4)'), this.netBody);
    this.net.hidden = true;
    this.root.appendChild(this.net);
    // In-match wait line (P2P stall: 'Esperando a <name>…').
    this.netWait = el('div', 'hud-netwait');
    this.netWait.hidden = true;
    this.root.appendChild(this.netWait);

    // Whole words of the hash (hashFlags.ts): `#hide=stadium-netting` is not `#net`.
    const flags = pageFlags();
    this.setDebug(flags.stats || flags.debug);
    this.setNetToggle(flags.net);

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('resize', this.onResize);
  }

  /** Show / hide the debug readouts (speed, fps, draw calls, GPU time). F3 toggles this. */
  setDebug(on: boolean): void {
    this.debug = on;
    this.root.classList.toggle('hud-debug', on);
  }

  get debugVisible(): boolean {
    return this.debug;
  }

  // ---- network panel -----------------------------------------------------------------------

  /** Manual switch of the network panel (F4 / #net). */
  setNetToggle(on: boolean): void {
    this.netToggle = on;
    this.refreshNet();
  }

  /** Online match in progress: with the debug readouts (F3) on, the panel shows by itself. */
  setNetAuto(on: boolean): void {
    if (on === this.netAuto) return;
    this.netAuto = on;
    this.refreshNet();
  }

  get netVisible(): boolean {
    return this.netShown;
  }

  private refreshNet(): void {
    const show = this.netToggle || (this.netAuto && this.debug);
    if (show === this.netShown) return;
    this.netShown = show;
    this.net.hidden = !show;
    if (!show) this.lastNetText = '';
  }

  /** Fill the network panel (at most 4x/s; the text is rebuilt only when it changed). */
  setNetStats(s: NetStatsView): void {
    if (!this.netShown) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - this.lastNetAt < 250) return;
    this.lastNetAt = now;
    const text = formatNetStats(s);
    if (text === this.lastNetText) return;
    this.lastNetText = text;
    this.netBody.textContent = text;
  }

  /** In-match wait line (a P2P stall: 'Esperando a <name>…'); null hides it. Cached. */
  /** The in-match wait line (top centre); `ok`: good news ("Back in the match"), steady and in --ok. */
  setNetWait(text: string | null, ok = false): void {
    if (text === this.lastNetWait) return;
    this.lastNetWait = text;
    this.netWait.classList.toggle('hud-netwait-ok', ok);
    if (text === null) {
      this.netWait.hidden = true;
      return;
    }
    this.netWait.textContent = text;
    this.netWait.hidden = false;
  }

  /** The player's team: the lime notch under its side of the scorebug. */
  setTeam(team: 0 | 1): void {
    if (team === this.lastTeam) return;
    this.lastTeam = team;
    this.scoreBox.parentElement?.classList.toggle('hud-mine-red', team === 1);
  }

  /** The network bars by the clock (netBars: 1 to 3); 0 hides them (offline, nothing measured yet). Cached. */
  setNetBars(bars: 0 | 1 | 2 | 3): void {
    if (bars === this.lastBars) return;
    this.lastBars = bars;
    this.netBarsEl.hidden = bars === 0;
    this.netBarsEl.dataset.bars = String(bars);
  }

  /**
   * Slot for the Turnstile widget, above every menu layer (NetClient renders into it and unhides it
   * only while a challenge lives).
   */
  get turnstileContainer(): HTMLElement {
    return this.turnstileBox;
  }

  setScore(blue: number, red: number): void {
    if (blue !== this.lastBlue) {
      this.lastBlue = blue;
      this.scoreBlue.textContent = String(blue);
    }
    if (red !== this.lastRed) {
      this.lastRed = red;
      this.scoreRed.textContent = String(red);
    }
  }

  /**
   * Match clock. `seconds` is what to show (Match.displaySeconds: already an integer that counts
   * down in regulation and up in overtime / unlimited matches). `mode` picks the styling: the
   * low-time amber only in regulation, '+m:ss' blinking red in overtime. A boolean is accepted
   * for the old (seconds, overtime) signature.
   */
  setClock(seconds: number, mode: ClockMode | boolean = 'regulation'): void {
    const m: ClockMode = typeof mode === 'boolean' ? (mode ? 'overtime' : 'regulation') : mode;
    // Regulation callers may still pass fractional countdown seconds: round up like a stopwatch.
    const s = Math.max(0, m === 'regulation' ? Math.ceil(seconds - 1e-6) : Math.floor(seconds + 1e-6));
    if (s === this.lastClockSec && m === this.lastClockMode) return;
    this.lastClockSec = s;
    this.lastClockMode = m;
    const mins = Math.floor(s / 60);
    const r = s % 60;
    const overtime = m === 'overtime';
    this.clock.textContent = `${overtime ? '+' : ''}${mins}:${r < 10 ? '0' : ''}${r}`;
    this.clock.classList.toggle('hud-overtime', overtime);
    this.clock.classList.toggle('hud-clock-low', m === 'regulation' && s <= 10);
  }

  /** Boost 0..100: the bar's fill scale and the number (empty / low / full restyle the bar). */
  setBoost(amount: number): void {
    const b = Math.round(amount < 0 ? 0 : amount > 100 ? 100 : amount);
    if (b === this.lastBoost) return;
    this.lastBoost = b;
    this.boostValue.textContent = String(b);
    this.boostFill.style.transform = `scaleX(${b / 100})`;
    this.boostBox.classList.toggle('hud-boost-empty', b === 0);
    this.boostBox.classList.toggle('hud-boost-low', b > 0 && b < 20);
    this.boostBox.classList.toggle('hud-boost-full', b === 100);
  }

  /** Speed in uu/s, displayed in km/h (1 uu = 1 cm: 2300 uu/s is about 83 km/h). */
  setSpeed(uuPerSec: number, supersonic: boolean): void {
    const kmh = Math.round(uuPerSec * 0.036);
    if (kmh !== this.lastSpeed) {
      this.lastSpeed = kmh;
      this.speedValue.textContent = String(kmh);
    }
    if (supersonic !== this.lastSupersonic) {
      this.lastSupersonic = supersonic;
      this.speedBox.classList.toggle('hud-supersonic', supersonic);
    }
  }

  /** Frames per second plus an info line (backend, draw calls, GPU time...). Only shown in debug mode. */
  setFps(fps: number, info?: string): void {
    const f = Math.round(fps);
    if (f !== this.lastFps) {
      this.lastFps = f;
      this.fps.textContent = `${f} fps`;
    }
    const i = info ?? '';
    if (i !== this.lastInfo) {
      this.lastInfo = i;
      this.fpsInfo.textContent = i;
    }
  }

  setCameraMode(ballCam: boolean): void {
    if (ballCam === this.lastBallCam) return;
    this.lastBallCam = ballCam;
    this.camMode.textContent = ballCam ? this.labelBallCam : this.labelCarCam;
    this.camMode.classList.toggle('hud-cam-off', !ballCam);
  }

  /**
   * Off-screen ball indicator. `nx`/`ny` is the screen position in NDC (-1..1, y up) where the
   * glyph is pinned (the caller clamps it to the screen edge), `angleDeg` the arrow direction
   * (0 = right, counter-clockwise like atan2 in NDC), `distanceM` the distance to the ball in
   * metres. Rounded values are cached so the DOM is written only when something moved.
   */
  setBallIndicator(visible: boolean, nx = 0, ny = 0, angleDeg = 0, distanceM = 0): void {
    if (visible !== this.indVisible) {
      this.indVisible = visible;
      this.ballInd.hidden = !visible;
    }
    if (!visible) return;
    if (this.rootW === 0) {
      this.rootW = this.root.clientWidth;
      this.rootH = this.root.clientHeight;
    }
    this.measurePlates();
    const at = this.indAt;
    avoidRects((nx + 1) * 0.5 * this.rootW, (1 - ny) * 0.5 * this.rootH, IND_REACH, this.indRects, this.rootW, this.rootH, at);
    const x = Math.round(at.x / 2) * 2;
    const y = Math.round(at.y / 2) * 2;
    const a = Math.round(angleDeg / 2) * 2;
    if (x !== this.indX || y !== this.indY) {
      this.indX = x;
      this.indY = y;
      this.ballInd.style.transform = `translate(${x}px, ${y}px)`;
    }
    if (a !== this.indAngle) {
      this.indAngle = a;
      // CSS rotates clockwise; NDC angles are counter-clockwise.
      this.ballIndArrow.style.transform = `rotate(${-a}deg) translateX(22px)`;
    }
    const d = Math.round(distanceM);
    if (d !== this.indDist) {
      this.indDist = d;
      this.ballIndDist.textContent = `${d} m`;
    }
  }

  /** The scorebug's, the boost plate's and the controls card's boxes: again after a resize or as the card comes or goes (a few times a match). */
  private measurePlates(): void {
    const key = this.controls.hidden ? 'off' : this.controlsView;
    if (key === this.indRectsKey && this.indRects.length > 0) return;
    this.indRectsKey = key;
    const o = this.root.getBoundingClientRect();
    this.indRects.length = 0;
    for (const e of [this.scoreBox, this.boostBox, this.controls]) {
      if (e.hidden) continue;
      const r = e.getBoundingClientRect();
      if (r.width > 0) this.indRects.push({ left: r.left - o.left, top: r.top - o.top, right: r.right - o.left, bottom: r.bottom - o.top });
    }
  }

  /** Kickoff countdown: 3, 2, 1, 'GO' (a token: shown as hud.go); null hides it. GO and null end the overtime line. */
  showCountdown(n: number | 'GO' | null): void {
    if (n === null || n === 'GO') this.countdownCaption.hidden = true;
    const text = n === null ? null : n === 'GO' ? this.labelGo : String(n);
    if (text === this.lastCountdown) return;
    this.lastCountdown = text;
    if (text === null) {
      this.countdown.hidden = true;
      return;
    }
    this.countdown.textContent = text;
    this.countdown.hidden = false;
    this.countdown.classList.toggle('hud-countdown-go', n === 'GO');
    // Restart the pop animation.
    this.countdown.classList.remove('hud-pop');
    void this.countdown.offsetWidth;
    this.countdown.classList.add('hud-pop');
  }

  /** Overtime: "TIEMPO EXTRA · next goal wins" over the overtime kickoff's countdown, until its GO (the centre stays the goal's and the whistle's). */
  showOvertime(): void {
    this.countdownCaption.hidden = false;
  }

  /** Centre banner (the final whistle; a goal is showGoal's), hidden after `ms` (0 = until the next banner). */
  showBanner(title: string, sub = '', ms = 2500, team: 0 | 1 | null = null): void {
    this.hideGoal();
    this.bannerTitle.textContent = title;
    this.bannerSub.textContent = sub;
    this.bannerSub.hidden = sub.length === 0;
    this.banner.classList.toggle('hud-blue', team === 0);
    this.banner.classList.toggle('hud-red', team === 1);
    this.banner.hidden = false;
    this.banner.classList.remove('hud-pop');
    void this.banner.offsetWidth;
    this.banner.classList.add('hud-pop');
    if (this.bannerTimer !== 0) window.clearTimeout(this.bannerTimer);
    this.bannerTimer = 0;
    if (ms > 0) {
      this.bannerTimer = window.setTimeout(() => {
        this.banner.hidden = true;
        this.bannerTimer = 0;
      }, ms);
    }
  }

  hideBanner(): void {
    if (this.bannerTimer !== 0) window.clearTimeout(this.bannerTimer);
    this.bannerTimer = 0;
    this.banner.hidden = true;
    this.hideGoal();
  }

  /**
   * ¡GOOOL! for `team`: its slab, and the chip "● scorer │ Azul 1 – 0 Rojo" (the scorer left out
   * when nobody of that team touched the ball in the play: finalModel.ts goalScorer), for `ms`.
   */
  showGoal(team: 0 | 1, scorer: string | null, blue: number, red: number, ms = 2500): void {
    if (this.bannerTimer !== 0) window.clearTimeout(this.bannerTimer);
    this.bannerTimer = 0;
    this.banner.hidden = true;
    this.goal.classList.toggle('hud-blue', team === 0);
    this.goal.classList.toggle('hud-red', team === 1);
    const score = el('span', 'hud-goal-score', t('hud.goalScore', { blue, red, blueName: t('hud.teamBlue'), redName: t('hud.teamRed') }));
    if (scorer !== null) this.goalChip.replaceChildren(el('i', 'hud-goal-dot'), el('b', 'hud-goal-name', scorer), el('i', 'hud-goal-sep'), score);
    else this.goalChip.replaceChildren(score);
    this.goal.setAttribute('aria-label', scorer !== null ? t('hud.goalBy', { name: scorer, blue, red }) : t('hud.goalLabel', { blue, red }));
    this.goal.hidden = false;
    this.goal.classList.remove('hud-pop');
    void this.goal.offsetWidth;
    this.goal.classList.add('hud-pop');
    if (this.goalTimer !== 0) window.clearTimeout(this.goalTimer);
    this.goalTimer = window.setTimeout(() => this.hideGoal(), ms);
  }

  private hideGoal(): void {
    if (this.goalTimer !== 0) window.clearTimeout(this.goalTimer);
    this.goalTimer = 0;
    this.goal.hidden = true;
  }

  /** A chip on the feed (top centre) for FEED_MS; the oldest goes when a third comes. `kind` picks its mark. */
  feed(text: string, kind: 'join' | 'leave' | 'bot' | 'demo' = 'join'): void {
    const chip = el('div', `hud-feed-chip hud-feed-${kind}`, text);
    this.feedEl.appendChild(chip);
    while (this.feedEl.childElementCount > FEED_MAX) this.feedEl.firstElementChild?.remove();
    window.setTimeout(() => chip.remove(), FEED_MS);
  }

  /** The feed and the overtime line emptied (a match leaves the screen). */
  clearFeed(): void {
    this.feedEl.replaceChildren();
    this.countdownCaption.hidden = true;
  }

  /**
   * Show the pause dock with `entries` (the focus on the first; on none for a finger) and `hint` as
   * its key line, or hide it. `live`: an online match, which goes on meanwhile ("● PARTIDO EN
   * JUEGO"). Called on pause only (it rebuilds the buttons), never per frame.
   */
  setPaused(paused: boolean, entries: readonly PauseEntry[] = [], hint?: string, live = false): void {
    this.pauseOpen = paused;
    this.pauseCovered = false;
    this.endHold(false);
    this.paused.hidden = !paused;
    this.root.classList.toggle('hud-pausing', paused);
    if (!paused) {
      this.pauseMenu.textContent = '';
      this.pauseButtons.length = 0;
      return;
    }
    this.pausedTitle.hidden = live;
    this.pausedLive.hidden = !live;
    if (hint !== undefined) this.pausedSub.textContent = hint;
    this.buildPauseMenu(entries);
  }

  /** The pause menu is up (and not covered by the settings screen). */
  get pauseMenuVisible(): boolean {
    return this.pauseOpen && !this.pauseCovered;
  }

  /**
   * The settings screen opens over the pause menu (`covered`: the menu hides, the game stays
   * paused) or closes again: the menu comes back with the focus on entry `focusId`.
   */
  setPauseCovered(covered: boolean, focusId?: string): void {
    if (!this.pauseOpen) return;
    this.pauseCovered = covered;
    this.paused.hidden = covered;
    this.endHold(false);
    if (!covered && focusId !== undefined) {
      const i = this.pauseEntries.findIndex((e) => e.id === focusId);
      if (i >= 0 && !touchMode()) this.pauseNav.focus(this.pauseButtons[i]);
    }
  }

  /** The pause menu's key line (the pause binding may have changed in the settings screen). */
  setPauseHint(hint: string): void {
    if (this.pausedSub.textContent !== hint) this.pausedSub.textContent = hint;
  }

  /** Keyboard / pad on the pause dock (Input's menu edges, routed by the Game while paused). */
  pauseAction(action: PauseAction): void {
    if (!this.pauseMenuVisible) return;
    if (action !== 'accept') {
      this.endHold(false);
      this.pauseNav.move(action);
      return;
    }
    const cur = this.pauseNav.current;
    if (cur === null) {
      this.pauseNav.first();
      return;
    }
    const entry = this.pauseEntries[this.pauseButtons.indexOf(cur as HTMLButtonElement)];
    if (entry === undefined) return;
    if (entry.hold === true) this.startHold(entry, true);
    else this.activatePause(entry, false);
  }

  /** A hold started by A / Enter: still waiting for them to be let go (the Game asks Input.acceptHeld). */
  get pauseHoldByKey(): boolean {
    return this.holding !== null && this.holdByKey;
  }

  /** A / Enter let go before the hold filled: it empties again. */
  pauseHoldRelease(): void {
    if (this.holdByKey) this.endHold(false);
  }

  private buildPauseMenu(entries: readonly PauseEntry[]): void {
    const menu = this.pauseMenu;
    menu.textContent = '';
    this.pauseEntries = entries;
    const buttons = this.pauseButtons;
    buttons.length = 0;
    // A run of 'row' entries shares one line (left / right walk it: data-nav-row).
    let row: HTMLElement | null = null;
    for (const entry of entries) {
      const kind = entry.kind ?? 'plain';
      const b = button(`hud-pause-btn hud-pause-${kind}${entry.hold === true ? ' hud-pause-hold' : ''}`, '');
      b.setAttribute('data-nav', '');
      this.fillPauseButton(b, entry);
      b.addEventListener('click', (e: MouseEvent) => {
        // A press of a held entry says how (its line lights up); the hold or a double click leaves.
        if (entry.hold === true) this.armHold(b);
        else this.activatePause(entry, isMouseClick(e));
      });
      if (entry.hold === true) {
        b.addEventListener('dblclick', (e: MouseEvent) => {
          if (isMouseClick(e)) this.activatePause(entry, true);
        });
        b.addEventListener('pointerdown', (e: PointerEvent) => {
          if (e.pointerType !== 'mouse') this.startHold(entry, false);
        });
        const up = (e: PointerEvent): void => {
          if (e.pointerType !== 'mouse' && !this.holdByKey) this.endHold(false);
        };
        b.addEventListener('pointerup', up);
        b.addEventListener('pointercancel', up);
        b.addEventListener('pointerleave', up);
      }
      if (kind === 'row') {
        if (row === null) {
          row = el('div', 'hud-pause-row');
          row.setAttribute('data-nav-row', '');
          menu.appendChild(row);
        }
        row.appendChild(b);
      } else {
        row = null;
        menu.appendChild(b);
      }
      buttons.push(b);
    }
    // The focus starts on the first entry (RESUME), as before; a finger's pause focuses nothing (no ring).
    if (buttons.length > 0 && !touchMode()) this.pauseNav.focus(buttons[0]);
  }

  /** A button's label and its line (read again after every activation: a toggle changes its label). */
  private fillPauseButton(b: HTMLButtonElement, entry: PauseEntry): void {
    const sub = entry.sub?.() ?? null;
    const parts: HTMLElement[] = [];
    if (entry.hold === true) parts.push(el('span', 'hud-hold-fill'));
    parts.push(el('span', 'hud-pause-label', entry.label()));
    if (sub !== null) parts.push(el('span', 'hud-pause-sub', sub));
    if (entry.hold === true) parts.push(el('span', 'hud-pause-howto hud-howto-hold', t('pause.holdHint')), el('span', 'hud-pause-howto hud-howto-dbl', t('pause.dblHint')));
    b.replaceChildren(...parts);
  }

  private activatePause(entry: PauseEntry, mouse: boolean): void {
    if (!this.pauseMenuVisible || !this.pauseEntries.includes(entry)) return;
    this.endHold(false);
    const entries = this.pauseEntries;
    entry.select(mouse);
    // Still the same menu (a toggle, not resume / quit): its labels may have changed.
    if (this.pauseOpen && this.pauseEntries === entries) {
      for (let k = 0; k < entries.length; k++) this.fillPauseButton(this.pauseButtons[k], entries[k]);
    }
  }

  /** Start filling `entry`'s button: HOLD_MS later it is picked, unless let go first. */
  private startHold(entry: PauseEntry, byKey: boolean): void {
    if (!this.pauseMenuVisible || this.holding === entry) return;
    this.endHold(false);
    const b = this.pauseButtons[this.pauseEntries.indexOf(entry)];
    if (b === undefined) return;
    this.holding = entry;
    this.holdByKey = byKey;
    b.classList.add('hud-holding');
    this.holdTimer = window.setTimeout(() => this.endHold(true), HOLD_MS);
  }

  /** The hold ends: `done` picks the entry, else its button empties again. */
  private endHold(done: boolean): void {
    const entry = this.holding;
    if (entry === null) return;
    this.holding = null;
    this.holdByKey = false;
    window.clearTimeout(this.holdTimer);
    this.holdTimer = 0;
    const b = this.pauseButtons[this.pauseEntries.indexOf(entry)];
    if (b !== undefined) b.classList.remove('hud-holding');
    if (done) this.activatePause(entry, false);
  }

  /** A plain press of a held entry: its how-to line lights up a moment. */
  private armHold(b: HTMLButtonElement): void {
    b.classList.remove('hud-pause-armed');
    void b.offsetWidth;
    b.classList.add('hud-pause-armed');
  }

  /**
   * The Tab scoreboard: translucent centred table with both scores, the clock and who plays on
   * each team. Safe to call every frame with the same `data` object: every field is cached.
   */
  showScoreboard(visible: boolean, data: ScoreboardData): void {
    if (visible !== this.sbVisible) {
      this.sbVisible = visible;
      this.scoreboard.hidden = !visible;
    }
    if (!visible) return;
    if (data.blue !== this.lastSbBlue) {
      this.lastSbBlue = data.blue;
      this.sbBlue.textContent = String(data.blue);
    }
    if (data.red !== this.lastSbRed) {
      this.lastSbRed = data.red;
      this.sbRed.textContent = String(data.red);
    }
    if (data.clock !== this.lastSbClock) {
      this.lastSbClock = data.clock;
      this.sbClock.textContent = data.clock;
    }
    let rows = data.rows;
    if (rows === undefined) {
      const youBlue = (data.playerTeam ?? 0) === 0;
      const legacy = this.sbLegacy;
      legacy[0].name = data.playerName ?? 'Player';
      legacy[0].team = youBlue ? 0 : 1;
      legacy[1].name = data.botName ?? 'Bot';
      legacy[1].team = youBlue ? 1 : 0;
      rows = legacy;
    }
    if (this.sbRowsChanged(rows)) this.renderScoreboardRows(rows);
    if (data.difficulty !== this.lastSbDifficulty || data.mode !== this.lastSbMode) {
      this.lastSbDifficulty = data.difficulty;
      this.lastSbMode = data.mode;
      const difficulty = t('hud.botDifficulty', { difficulty: data.difficulty });
      this.sbFoot.textContent = data.mode !== undefined ? `${data.mode}  ·  ${difficulty}` : difficulty;
    }
  }

  /** Content diff against the rows in the DOM (no allocations; at most MAX_CARS rows). */
  private sbRowsChanged(rows: readonly ScoreboardRow[]): boolean {
    const shown = this.sbShown;
    if (shown.length !== rows.length) return true;
    for (let i = 0; i < rows.length; i++) {
      const a = shown[i];
      const b = rows[i];
      if (a.name !== b.name || a.team !== b.team || a.you !== b.you || a.bot !== (b.bot !== false)) return true;
    }
    return false;
  }

  /** Rebuild both team columns (only when a roster / name changed: a few times per session). */
  private renderScoreboardRows(rows: readonly ScoreboardRow[]): void {
    const shown = this.sbShown;
    shown.length = 0;
    const cols = this.sbRowsEl;
    cols[0].textContent = '';
    cols[1].textContent = '';
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const bot = r.bot !== false;
      const row = el('div', r.you ? 'hud-sb-row hud-sb-you' : 'hud-sb-row');
      row.append(el('span', r.you ? 'hud-sb-tag hud-you' : 'hud-sb-tag', r.you ? this.labelYou : bot ? this.labelBot : ''), el('span', 'hud-sb-name', r.name));
      cols[r.team === 1 ? 1 : 0].appendChild(row);
      shown.push({ name: r.name, team: r.team, you: r.you, bot });
    }
  }

  /** Small bottom-centre hint (e.g. 'Click to capture the mouse'); null hides it. Cached. */
  showHint(text: string | null): void {
    if (text === this.lastHint) return;
    this.lastHint = text;
    if (text === null) {
      this.hint.hidden = true;
      return;
    }
    this.hint.textContent = text;
    this.hint.hidden = false;
  }

  /**
   * The controls card: 'full' the big card, 'strip' the slim corner strip, 'off' hidden (also
   * without content). A new `content` object rebuilds the rows (the Game makes one only when the
   * device, a binding or the tag changes), so a per-frame call with the same arguments costs nothing.
   */
  setControlsCard(view: CardView, content: ControlsCardContent | null): void {
    if (content !== null && content !== this.controlsContent) {
      this.controlsContent = content;
      this.controlsTag.textContent = content.tag;
      this.controlsFoot.textContent = content.foot;
      const rows: HTMLElement[] = [];
      for (const r of content.rows) {
        const keys = el('span', 'hud-controls-keys');
        for (const k of r.keys) keys.appendChild(k.kind === 'mouse' ? mouseKey(k) : el('kbd', k.kind === 'pad' ? 'hud-key hud-key-pad' : 'hud-key', k.label));
        const row = el('div', 'hud-controls-row');
        row.append(el('span', 'hud-controls-label', r.label), keys);
        rows.push(row);
      }
      this.controlsRows.replaceChildren(...rows);
    }
    const shown = view !== 'off' && this.controlsContent !== null;
    if (view === this.controlsView && shown === !this.controls.hidden) return;
    this.controlsView = view;
    this.controls.hidden = !shown;
    this.controls.classList.toggle('hud-controls-strip', view === 'strip');
  }

  get menuVisible(): boolean {
    return this.menu !== null && !this.menu.hidden;
  }

  /** The settings screen is shown (inside the menu). */
  get settingsVisible(): boolean {
    return this.menuVisible && this.settingsOpen;
  }

  /** A rebind capture is in progress: keyboard / gamepad navigation is suspended until it resolves. */
  get capturing(): boolean {
    return this.captureRow !== null;
  }

  hideMenu(): void {
    if (this.menu !== null) {
      this.menu.hidden = true;
    }
    // Menu.settingsUp reads the panel: shown, it would keep the menus' keys after Settings closed.
    if (this.settingsPanel !== null) this.settingsPanel.hidden = true;
    this.settingsOnlyClose = null;
    this.stopPadPoll();
  }

  /**
   * The Controls & Settings screen on its own (the front-end menus in src/ui own every other
   * screen): the overlay opens straight on the settings panel and its BACK (button, Esc, pad B)
   * hides the overlay again and calls `onClose`. Rebinding, sliders and presets work as before
   * through `opts` (settings, input, onSettingsChanged, onCameraPreset).
   */
  openSettingsScreen(opts: MenuOptions, onClose: () => void, tab?: SettingsTab): void {
    this.menuOptions = opts;
    this.quality = opts.quality;
    if (this.menu === null) this.buildMenu();
    const menu = this.menu as HTMLElement;
    menu.hidden = false;
    this.settingsOnlyClose = onClose;
    // `tab`: open on that tab (a screen that sends the player to one: the presets' editor).
    if (tab !== undefined) this.tab = tab;
    // A finger has no use for the binding tabs: touch mode opens on Graphics instead.
    else if ((this.tab === 'kbm' || this.tab === 'pad') && document.documentElement.classList.contains('tg-touch')) this.tab = 'graphics';
    this.openSettings();
  }

  /**
   * Route gamepad / keyboard navigation to the settings screen (no-op while hidden or while a
   * rebind capture is running): up/down focus, left/right adjust (tabs on the tab strip), accept
   * activates (rebind / toggle / button), 'settings' or 'tabNext' = next tab, 'tabPrev' = the
   * previous one, back closes. `repeat`: an arrow's auto-repeat (Input's NAV_REPEAT_*, a key's
   * own): up / down stop at the first / last row instead of wrapping round, left / right only step
   * a slider (a choice, the tabs or Graphics, a reload, once per press).
   */
  menuAction(action: MenuAction, repeat = false): void {
    if (!this.menuVisible || !this.settingsOpen || this.menuOptions === null || this.captureRow !== null) return;
    // A text field of the screen is being typed in (the preset name: the keyboard is up): pad A
    // or B leaves it (that saves it), up / down leave it and move on; left / right are the field's.
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    if (active instanceof HTMLInputElement && active.type === 'text' && this.settingsPanel !== null && this.settingsPanel.contains(active)) {
      if (action === 'left' || action === 'right') return;
      active.blur();
      if (action !== 'up' && action !== 'down') return;
    }
    if (dispatchFocus(this.settingsRing, action, repeat)) return;
    if (action === 'back') this.closeSettings();
    else if (action === 'settings' || action === 'tabNext') this.cycleTab(1);
    else if (action === 'tabPrev') this.cycleTab(-1);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('resize', this.onResize);
    if (this.bannerTimer !== 0) window.clearTimeout(this.bannerTimer);
    this.hideGoal();
    this.endHold(false);
    this.stopPadPoll();
    this.root.remove();
  }

  /** The settings overlay (the panel itself is built on its first open: buildSettings). */
  private buildMenu(): void {
    const menu = el('div', 'hud-menu');
    // Keep DOM focus off the buttons so Enter / Space never fire a native click on top of the
    // screen's own key handling; RMB over it must not open the context menu (it is bindable).
    menu.addEventListener('mousedown', (e: MouseEvent) => {
      if (e.target instanceof HTMLButtonElement) e.preventDefault();
    });
    menu.addEventListener('contextmenu', (e: Event) => e.preventDefault());
    menu.hidden = true;
    this.root.appendChild(menu);
    this.menu = menu;
  }

  /**
   * A tier picked in an online match that needs a reload (into or out of super low) waits for the
   * menus (Game.switchQuality): the Graphics tab says so under it; null when nothing waits.
   */
  setQualityPending(q: Quality | null): void {
    this.qualityPending = q;
  }

  // ---- settings screen ---------------------------------------------------------------------

  private get liveSettings(): Settings | null {
    return this.menuOptions?.settings ?? null;
  }

  private openSettings(): void {
    const opts = this.menuOptions;
    if (opts === null || opts.settings === undefined || opts.input === undefined) return;
    if (this.settingsPanel === null) this.buildSettings();
    this.settingsOpen = true;
    if (this.settingsPanel !== null) this.settingsPanel.hidden = false;
    this.refreshBindLabels('kbm');
    this.refreshBindLabels('pad');
    this.refreshSliders();
    this.refreshTabLabels();
    if (this.experimentalPage !== null) this.experimentalPage.disarm();
    this.selectTab(this.tab);
    this.updatePadStatus();
    if (this.padTimer === 0) this.padTimer = window.setInterval(() => this.updatePadStatus(), 500);
  }

  private closeSettings(): void {
    if (this.captureRow !== null) {
      this.cancelCapture(); // BACK during a capture aborts the capture, not the screen
      return;
    }
    if (this.experimentalPage !== null) this.experimentalPage.disarm();
    const only = this.settingsOnlyClose;
    this.settingsOpen = false;
    this.hideMenu();
    if (only !== null) only();
  }

  private stopPadPoll(): void {
    if (this.padTimer !== 0) {
      window.clearInterval(this.padTimer);
      this.padTimer = 0;
    }
  }

  private buildSettings(): void {
    const panel = el('div', 'hud-menu-panel hud-settings-panel');

    const head = el('div', 'hud-settings-head');
    const back = button('hud-settings-back', `‹ ${t('settings.back')}`);
    back.addEventListener('click', () => this.closeSettings());
    head.append(back, el('div', 'hud-settings-title', t('settings.title')));
    panel.appendChild(head);

    const tabs = el('div', 'hud-settings-tabs');
    const tabsItem: FocusItem = { el: tabs, left: () => this.cycleTab(-1), right: () => this.cycleTab(1) };
    for (const tab of SETTINGS_TABS) {
      const b = button('hud-settings-tab', t(tab.label));
      b.addEventListener('click', () => this.selectTab(tab.id));
      this.tabButtons.push(b);
      tabs.appendChild(b);
    }
    tabs.addEventListener('pointerdown', () => this.settingsRing.focusItem(tabsItem));
    panel.appendChild(tabs);

    const body = el('div', 'hud-settings-body');
    const built: Record<SettingsTab, PageBuild> = {
      kbm: this.buildBindPage('kbm'),
      pad: this.buildBindPage('pad'),
      camera: this.buildCameraPage(),
      gameplay: this.buildGameplayPage(),
      audio: this.buildAudioPage(),
      graphics: this.buildGraphicsPage(),
      experimental: this.buildExperimentalPage(),
    };
    const foot = el('div', 'hud-settings-foot');
    const pages = {} as Record<SettingsTab, HTMLElement>;
    const pageActions = {} as Record<SettingsTab, HTMLElement>;
    const tabItems = {} as Record<SettingsTab, () => FocusItem[]>;
    for (const tab of SETTINGS_TABS) {
      const b = built[tab.id];
      body.appendChild(b.page);
      foot.appendChild(b.actions);
      pages[tab.id] = b.page;
      pageActions[tab.id] = b.actions;
      const items = b.items;
      const footer = b.footer;
      tabItems[tab.id] = () => {
        const list = typeof items === 'function' ? items() : items;
        return footer !== null ? [tabsItem, ...list, footer] : [tabsItem, ...list];
      };
    }
    panel.appendChild(body);

    const k = SETTINGS_KEYS;
    foot.appendChild(
      el(
        'div',
        'hud-settings-keys',
        t('settings.keys', { navKeys: k.nav, adjustKeys: k.adjust, selectKeys: k.select, clearKeys: k.clear, tabKeys: k.tabs, backKeys: k.back }),
      ),
    );
    panel.appendChild(foot);

    this.pages = pages;
    this.pageActions = pageActions;
    this.tabItems = tabItems;
    this.settingsBody = body;
    panel.hidden = true;
    (this.menu as HTMLElement).appendChild(panel);
    this.settingsPanel = panel;
  }

  private buildBindPage(device: Device): PageBuild {
    const page = el('div', 'hud-settings-page');
    const items: FocusItem[] = [];
    const status = el('div', 'hud-settings-device');
    if (device === 'pad') this.padStatus = status;
    else status.textContent = t('settings.mouseNote');
    page.appendChild(status);
    // The arrows' second bindings (bindings.ts KBM_SECONDARY) have no row: said once here.
    if (device === 'kbm') page.appendChild(el('div', 'hud-settings-device', t('settings.arrowsNote')));

    // Built once per page: the same texts for every row.
    const rebindTitle = t('settings.rebindTitle');
    const pauseLockedTitle = t('settings.pauseLockedTitle');
    const unbindTitle = t('settings.unbindTitle', { key: SETTINGS_KEYS.clear });
    let group: string | null = null;
    for (const row of ACTION_ROWS) {
      if (row.group !== group) {
        group = row.group;
        page.appendChild(el('div', 'hud-settings-group', t(GROUP_TITLES[row.group])));
      }
      const r = el('div', 'hud-settings-row hud-bind-row');
      r.appendChild(el('span', 'hud-settings-label', row.label));
      const cell = button('hud-bind-cell', '—');
      cell.title = rebindTitle;
      const clear = button('hud-bind-clear', '×');
      const ctl = el('span', 'hud-settings-ctl');
      ctl.append(cell, clear);
      r.appendChild(ctl);
      const bind: BindRow = { action: row.action, device, row: r, cell };
      const item: FocusItem = { el: r, accept: () => this.beginCapture(bind) };
      if (row.action === 'pause') {
        // Pause stays bound (it can never be unbound): nothing could resume a paused game.
        clear.classList.add('hud-bind-locked');
        clear.disabled = true;
        clear.title = pauseLockedTitle;
      } else {
        clear.title = unbindTitle;
        clear.addEventListener('click', () => this.clearBinding(bind));
        item.clear = () => this.clearBinding(bind);
      }
      // While this cell is capturing (the rest of the panel ignores the pointer) a click on it cancels.
      cell.addEventListener('click', () => (this.captureRow === bind ? this.cancelCapture() : this.beginCapture(bind)));
      r.addEventListener('pointerdown', () => this.settingsRing.focusItem(item));
      this.bindRows.push(bind);
      items.push(item);
      page.appendChild(r);
    }

    const buttons: HTMLButtonElement[] = [];
    const std = button('hud-settings-action', t('settings.defaultLayout'));
    std.addEventListener('click', () => this.resetBindings(device, 'standard'));
    buttons.push(std);
    if (device === 'kbm') {
      const ko = button('hud-settings-action', t('settings.keyboardOnly'));
      ko.addEventListener('click', () => this.resetBindings(device, 'keyboardOnly'));
      buttons.push(ko);
    }
    const actions = el('div', 'hud-settings-actions');
    for (const b of buttons) actions.appendChild(b);
    return { page, items, actions, footer: this.groupItem(actions, buttons) };
  }

  private buildCameraPage(): PageBuild {
    const page = el('div', 'hud-settings-page');
    const items: FocusItem[] = [];
    page.appendChild(el('div', 'hud-settings-device', t('settings.cameraNote')));
    for (const s of CAMERA_SLIDERS) {
      const key = s.key;
      const built = this.sliderRow(
        t(s.label),
        CAMERA_RANGES[key],
        s.suffix,
        () => {
          const st = this.liveSettings;
          return st === null ? DEFAULT_CAMERA[key] : st.camera[key];
        },
        (v) => {
          const st = this.liveSettings;
          if (st === null) return;
          st.camera[key] = v;
          this.notifySettingsChanged();
        },
      );
      items.push(built.item);
      page.appendChild(built.row);
    }
    const def = button('hud-settings-action', t('settings.presetWide', { values: PRESET_WIDE_VALUES }));
    def.addEventListener('click', () => this.applyCameraPreset('default'));
    const classic = button('hud-settings-action', t('settings.presetClassic', { values: PRESET_CLASSIC_VALUES }));
    classic.addEventListener('click', () => this.applyCameraPreset('classic'));
    const buttons = [def, classic];
    const actions = el('div', 'hud-settings-actions');
    actions.append(def, classic);
    return { page, items, actions, footer: this.groupItem(actions, buttons) };
  }

  private buildGameplayPage(): PageBuild {
    const page = el('div', 'hud-settings-page');
    const items: FocusItem[] = [];
    page.appendChild(el('div', 'hud-settings-device', t('settings.gameplayNote')));
    for (const g of GAMEPLAY_ROWS) {
      const key = g.key;
      const range = CONTROL_RANGES[key];
      const built =
        range === null
          ? this.toggleRow(
              t(g.label),
              () => this.controlFlag(key),
              (v) => this.setControl(key, v),
            )
          : this.sliderRow(
              t(g.label),
              range,
              '',
              () => this.controlNumber(key),
              (v) => this.setControl(key, v),
            );
      items.push(built.item);
      page.appendChild(built.row);
    }
    const reset = button('hud-settings-action', t('settings.resetGameplay'));
    reset.addEventListener('click', () => {
      const st = this.liveSettings;
      if (st === null) return;
      Object.assign(st.controls, DEFAULT_CONTROL_SETTINGS);
      this.refreshSliders();
      this.notifyControlsChanged();
    });
    const actions = el('div', 'hud-settings-actions');
    actions.appendChild(reset);
    return { page, items, actions, footer: this.groupItem(actions, [reset]) };
  }

  /** Audio: the master volume (settings.audio, applied by the Game's onSettingsChanged). */
  private buildAudioPage(): PageBuild {
    const page = el('div', 'hud-settings-page');
    page.appendChild(el('div', 'hud-settings-device', t('settings.audioNote')));
    const volume = this.sliderRow(
      t('settings.volume'),
      VOLUME_RANGE,
      '%',
      () => this.liveSettings?.audio.volume ?? DEFAULT_AUDIO.volume,
      (v) => {
        const st = this.liveSettings;
        if (st === null) return;
        st.audio.volume = v;
        this.notifySettingsChanged();
      },
    );
    page.appendChild(volume.row);
    const reset = button('hud-settings-action', t('settings.resetAudio'));
    reset.addEventListener('click', () => {
      const st = this.liveSettings;
      if (st === null) return;
      Object.assign(st.audio, DEFAULT_AUDIO);
      this.refreshSliders();
      this.notifySettingsChanged();
    });
    const actions = el('div', 'hud-settings-actions');
    actions.appendChild(reset);
    return { page, items: [volume.item], actions, footer: this.groupItem(actions, [reset]) };
  }

  /**
   * Graphics: the quality tier, a line about the selected one. Lists MenuOptions.qualities (Super
   * low only for a signed-in player with experimental features on); a running tier outside the
   * list (a TV running Super low on its own) lights no chip and says so (MenuOptions.qualityNote).
   * A pick goes to MenuOptions.onQualityChange, which runs the switch behind the loading screen.
   */
  private buildGraphicsPage(): PageBuild {
    const page = el('div', 'hud-settings-page');
    page.appendChild(el('div', 'hud-settings-device', t('settings.graphicsNote')));
    const hint = el('div', 'hud-settings-hint');
    const hints: Record<Quality, string> = {
      superlow: t(QUALITY_HINTS.superlow),
      low: t(QUALITY_HINTS.low),
      high: t(QUALITY_HINTS.high),
      ultra: t(QUALITY_HINTS.ultra),
    };
    const quality = this.choiceRow<Quality>(
      t('settings.quality'),
      QUALITIES.map((q) => ({ value: q, label: t(`quality.${q}`) })),
      () => this.quality,
      (q) => {
        // The lit chip too: it makes the running tier the player's pick when the prefs hold
        // another one (a Super low pick locked earlier this session; Game.switchQuality).
        this.quality = q;
        const opts = this.menuOptions;
        if (opts !== null && opts.onQualityChange) opts.onQualityChange(q);
      },
      (q, listed) => {
        if (!listed) hint.textContent = this.menuOptions?.qualityNote ?? t('settings.qualityAuto');
        else hint.textContent = q === this.qualityPending ? t('settings.qualityAfterOnline') : hints[q];
      },
      () => this.menuOptions?.qualities ?? QUALITIES,
    );
    page.append(quality.row, hint);
    return { page, items: [quality.item], actions: el('div', 'hud-settings-actions'), footer: null };
  }

  /**
   * Experimental: experimentalPage.ts (a locked line for a guest; the switch and the preset editor
   * for a signed-in player). Its rows come and go with the switch and the preset picked, so its
   * focus stops are read again whenever it asks (`relayout`); its footer button (Reset to standard)
   * is one of those stops, not a fixed footer.
   */
  private buildExperimentalPage(): PageBuild {
    const built = buildExperimentalPage(
      {
        line: (className, text) => el('div', className, text),
        button: (className, text, onClick) => {
          const b = button(className, text);
          b.addEventListener('click', onClick);
          return b;
        },
        textInput: (className, maxLength, onCommit) => {
          const input = document.createElement('input');
          input.type = 'text';
          input.className = className;
          input.maxLength = maxLength;
          input.spellcheck = false;
          input.autocomplete = 'off';
          input.enterKeyHint = 'done';
          input.addEventListener('change', () => onCommit(input.value));
          return input;
        },
        toggleRow: (label, get, set) => this.toggleRow(label, get, set),
        bindFocus: (target, item) => target.addEventListener('pointerdown', () => this.settingsRing.focusItem(item)),
        relayout: () => {
          if (this.settingsOpen && this.tab === 'experimental') this.refreshFocusItems();
        },
      },
      () => this.menuOptions?.experimental ?? null,
    );
    this.experimentalPage = built;
    return { page: built.page, items: () => built.items(), actions: built.actions, footer: null };
  }

  /**
   * "Label   [A] [B] [C]": a segmented choice. Left / right step (no wrap: a quality switch is a
   * reload, ultra never jumps to low), accept steps with wrap, a click picks. `listed` (default
   * every option) hides the others; a value outside it lights nothing (choiceStep). `onShow` gets
   * the value after every refresh, and whether it is listed (a line about it).
   */
  private choiceRow<T>(
    label: string,
    options: ReadonlyArray<{ value: T; label: string }>,
    get: () => T,
    set: (v: T) => void,
    onShow?: (v: T, listed: boolean) => void,
    listed?: () => readonly T[],
  ): { row: HTMLElement; item: FocusItem } {
    const row = el('div', 'hud-settings-row hud-choice-row');
    row.appendChild(el('span', 'hud-settings-label', label));
    const ctl = el('span', 'hud-settings-ctl hud-choice');
    const buttons = options.map((o) => button('hud-choice-opt', o.label));
    ctl.append(...buttons);
    row.appendChild(ctl);
    const all = options.map((o) => o.value);
    const shown = (): readonly T[] => (listed ? listed() : all);
    const refresh = (): void => {
      const list = shown();
      const v = get();
      const on = list.includes(v) ? all.indexOf(v) : -1;
      for (let k = 0; k < buttons.length; k++) {
        buttons[k].hidden = !list.includes(all[k]);
        buttons[k].classList.toggle('hud-on', k === on);
        buttons[k].setAttribute('aria-pressed', String(k === on));
      }
      if (onShow) onShow(v, on >= 0);
    };
    const pickValue = (v: T | null): void => {
      if (v === null) return;
      set(v);
      refresh();
    };
    buttons.forEach((b, k) => b.addEventListener('click', () => pickValue(all[k])));
    const item: FocusItem = {
      el: row,
      left: () => pickValue(choiceStep(all, shown(), get(), -1)),
      right: () => pickValue(choiceStep(all, shown(), get(), 1)),
      accept: () => pickValue(choiceStep(all, shown(), get(), 0)),
    };
    row.addEventListener('pointerdown', () => this.settingsRing.focusItem(item));
    this.refreshers.push(refresh);
    refresh();
    return { row, item };
  }

  /** A horizontal group of buttons as one focus item: left/right pick, accept clicks. */
  private groupItem(container: HTMLElement, buttons: HTMLButtonElement[], ring: FocusRing = this.settingsRing): FocusItem {
    let index = 0;
    const highlight = (): void => {
      for (let i = 0; i < buttons.length; i++) buttons[i].classList.toggle('hud-focus', i === index);
    };
    for (let i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener('pointerdown', () => {
        index = i;
        highlight();
      });
    }
    highlight();
    const item: FocusItem = {
      el: container,
      left: () => {
        index = (index + buttons.length - 1) % buttons.length;
        highlight();
      },
      right: () => {
        index = (index + 1) % buttons.length;
        highlight();
      },
      accept: () => buttons[index].click(),
    };
    container.addEventListener('pointerdown', () => ring.focusItem(item));
    return item;
  }

  private sliderRow(
    label: string,
    range: readonly [number, number, number],
    suffix: string,
    get: () => number,
    set: (v: number) => void,
  ): { row: HTMLElement; item: FocusItem } {
    const [min, max, step] = range;
    const row = el('div', 'hud-settings-row hud-slider-row');
    row.appendChild(el('span', 'hud-settings-label', label));
    const ctl = el('span', 'hud-settings-ctl');
    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'hud-slider';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.tabIndex = -1;
    const value = el('span', 'hud-slider-value');
    ctl.append(input, value);
    row.appendChild(ctl);
    const refresh = (): void => {
      const v = get();
      input.value = String(v);
      value.textContent = formatSettingValue(v, step, suffix);
      input.style.setProperty('--p', `${((v - min) / (max - min)) * 100}%`);
    };
    const apply = (v: number): void => {
      if (v !== get()) set(v);
      refresh();
    };
    input.addEventListener('input', () => apply(stepSettingValue(Number(input.value), 0, min, max, step)));
    const nudge = (dir: number): void => apply(stepSettingValue(get(), dir, min, max, step));
    const item: FocusItem = { el: row, left: () => nudge(-1), right: () => nudge(1), repeat: true }; // a held ◀ ▶ slides (FOV: 50 steps)
    row.addEventListener('pointerdown', () => this.settingsRing.focusItem(item));
    this.refreshers.push(refresh);
    return { row, item };
  }

  private toggleRow(label: string, get: () => boolean, set: (v: boolean) => void): { row: HTMLElement; item: FocusItem; refresh: () => void } {
    const row = el('div', 'hud-settings-row hud-toggle-row');
    row.appendChild(el('span', 'hud-settings-label', label));
    const ctl = el('span', 'hud-settings-ctl');
    const onLabel = t('settings.on');
    const offLabel = t('settings.off');
    const btn = button('hud-toggle', offLabel);
    ctl.appendChild(btn);
    row.appendChild(ctl);
    const refresh = (): void => {
      const on = get();
      btn.textContent = on ? onLabel : offLabel;
      btn.classList.toggle('hud-on', on);
    };
    const flip = (): void => {
      set(!get());
      refresh();
    };
    btn.addEventListener('click', flip);
    const item: FocusItem = { el: row, left: flip, right: flip, accept: flip };
    row.addEventListener('pointerdown', () => this.settingsRing.focusItem(item));
    this.refreshers.push(refresh);
    return { row, item, refresh };
  }

  private controlNumber(key: keyof ControlSettings): number {
    const st = this.liveSettings;
    const v = st === null ? DEFAULT_CONTROL_SETTINGS[key] : st.controls[key];
    return typeof v === 'number' ? v : 0;
  }

  private controlFlag(key: keyof ControlSettings): boolean {
    const st = this.liveSettings;
    const v = st === null ? DEFAULT_CONTROL_SETTINGS[key] : st.controls[key];
    return v === true;
  }

  private setControl(key: keyof ControlSettings, v: number | boolean): void {
    const st = this.liveSettings;
    if (st === null) return;
    (st.controls as unknown as Record<string, number | boolean>)[key] = v;
    this.notifyControlsChanged();
  }

  private applyCameraPreset(which: 'default' | 'classic'): void {
    const opts = this.menuOptions;
    if (opts === null || opts.settings === undefined) return;
    Object.assign(opts.settings.camera, which === 'classic' ? CLASSIC_CAMERA_DEFAULTS : DEFAULT_CAMERA);
    this.refreshSliders();
    if (opts.onCameraPreset) opts.onCameraPreset(which);
    this.notifySettingsChanged();
  }

  private refreshSliders(): void {
    for (const r of this.refreshers) r();
  }

  private notifySettingsChanged(): void {
    const opts = this.menuOptions;
    if (opts !== null && opts.onSettingsChanged) opts.onSettingsChanged();
  }

  private notifyControlsChanged(): void {
    const opts = this.menuOptions;
    if (opts === null) return;
    if (opts.input !== undefined) opts.input.settingsChanged();
    if (opts.onSettingsChanged) opts.onSettingsChanged();
  }

  private selectTab(tab: SettingsTab): void {
    if (this.pages === null || this.pageActions === null || this.tabItems === null) return;
    this.tab = tab;
    for (let i = 0; i < SETTINGS_TABS.length; i++) {
      const id = SETTINGS_TABS[i].id;
      const btn = this.tabButtons[i];
      btn.classList.toggle('hud-active', id === tab);
      // The strip scrolls horizontally (hidden scrollbar) when the panel is narrow: keep the
      // active tab visible when Q / E / X cycle to one that is off the edge.
      if (id === tab) btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      this.pages[id].hidden = id !== tab;
      this.pageActions[id].hidden = id !== tab;
    }
    if (this.settingsBody !== null) this.settingsBody.scrollTop = 0;
    if (this.experimentalPage !== null && tab !== 'experimental') this.experimentalPage.disarm();
    this.settingsRing.use(this.tabItems[tab](), 0);
    if (tab === 'pad') this.updatePadStatus();
    if (tab === 'experimental') this.menuOptions?.experimental?.onOpen?.();
  }

  /**
   * The settings screen's state changed under it (an account change, the experimental switch, a
   * sync): take `opts` as its options when given and redraw the rows, the tab labels and the focus
   * stops of the tab on screen (the focus keeps its place). Nothing when the screen is not open.
   */
  refreshSettings(opts?: MenuOptions): void {
    if (!this.settingsOpen || this.settingsPanel === null) return;
    if (opts !== undefined) {
      this.menuOptions = opts;
      this.quality = opts.quality;
    }
    this.refreshTabLabels();
    this.refreshSliders();
    if (this.experimentalPage !== null) this.experimentalPage.refresh();
    this.refreshFocusItems();
  }

  /**
   * Read the focus stops of the tab on screen again: the focus stays on the same row when it is
   * still shown, else at its place in the list.
   */
  private refreshFocusItems(): void {
    if (this.tabItems === null || this.captureRow !== null) return;
    const ring = this.settingsRing;
    const was = ring.item;
    const index = ring.index;
    const items = this.tabItems[this.tab]();
    ring.use(items, 0);
    const keep = was !== null ? items.indexOf(was) : -1;
    ring.set(keep >= 0 ? keep : Math.min(index, items.length - 1), false);
  }

  private refreshTabLabels(): void {
    for (let i = 0; i < SETTINGS_TABS.length; i++) {
      if (SETTINGS_TABS[i].id === 'experimental' && this.tabButtons[i] !== undefined) {
        this.tabButtons[i].textContent = experimentalTabLabel(this.menuOptions?.experimental?.state().available === true);
      }
    }
  }

  private cycleTab(dir: number): void {
    let i = 0;
    for (; i < SETTINGS_TABS.length; i++) if (SETTINGS_TABS[i].id === this.tab) break;
    const n = (i + dir + SETTINGS_TABS.length) % SETTINGS_TABS.length;
    this.selectTab(SETTINGS_TABS[n].id);
  }

  private refreshBindLabels(device: Device): void {
    const input = this.menuOptions?.input;
    if (input === undefined) return;
    for (const r of this.bindRows) {
      if (r.device !== device || r === this.captureRow) continue;
      r.cell.textContent = input.getLabel(r.action, device);
      r.row.classList.toggle('hud-unbound', input.getBinding(r.action, device) === null);
    }
  }

  private beginCapture(bind: BindRow): void {
    const input = this.menuOptions?.input;
    if (input === undefined || this.captureRow !== null || !this.settingsOpen) return;
    this.captureRow = bind;
    this.settingsRing.focusItem(this.findItem(bind.row));
    bind.cell.textContent = t(bind.device === 'pad' ? 'settings.pressButton' : 'settings.pressKey', { cancelKey: SETTINGS_KEYS.cancel });
    bind.cell.classList.add('hud-capturing');
    bind.row.classList.remove('hud-unbound');
    if (this.settingsPanel !== null) this.settingsPanel.classList.add('hud-settings-capturing');
    const finish = (b: Binding | null): void => {
      if (this.captureRow !== bind) return;
      // The promise settles in a microtask, i.e. between the listeners of the very keydown /
      // mousedown that ended the capture. Leave `capturing` set until that dispatch (and the
      // Game's current tick) is over, so the Esc / Enter / button that ended it never doubles as
      // 'back' / 'accept' here.
      window.setTimeout(() => {
        if (this.captureRow !== bind) return;
        this.captureRow = null;
        bind.cell.classList.remove('hud-capturing');
        if (this.settingsPanel !== null) this.settingsPanel.classList.remove('hud-settings-capturing');
        if (b !== null && !bindingsEqual(input.getBinding(bind.action, bind.device), b)) {
          input.setBinding(bind.action, bind.device, b);
        }
        this.refreshBindLabels(bind.device);
        if (b !== null) this.notifySettingsChanged();
      }, 0);
    };
    input.startRebind(bind.action, bind.device, bind.cell).then(finish, () => finish(null));
  }

  /** Abort the pending capture (BACK or the capturing cell clicked); its `finish` restores the cell. */
  private cancelCapture(): void {
    const input = this.menuOptions?.input;
    if (this.captureRow === null || input === undefined || !input.cancelRebind) return;
    input.cancelRebind();
  }

  private findItem(rowEl: HTMLElement): FocusItem {
    const items = this.settingsRing.items;
    for (const it of items) if (it.el === rowEl) return it;
    return items[0];
  }

  private clearBinding(bind: BindRow): void {
    const input = this.menuOptions?.input;
    if (input === undefined || this.captureRow !== null || bind.action === 'pause') return;
    if (input.getBinding(bind.action, bind.device) === null) return;
    input.setBinding(bind.action, bind.device, null);
    this.refreshBindLabels(bind.device);
    this.notifySettingsChanged();
  }

  private clearFocused(): void {
    const item = this.settingsRing.item;
    if (item !== null && item.clear) item.clear();
  }

  private resetBindings(device: Device, preset: BindingPreset): void {
    const input = this.menuOptions?.input;
    if (input === undefined || this.captureRow !== null) return;
    input.resetBindings(device, preset);
    this.refreshBindLabels(device);
    this.notifySettingsChanged();
  }

  private updatePadStatus(): void {
    const input = this.menuOptions?.input;
    const status = this.padStatus;
    if (input === undefined || status === null) return;
    const present = input.hasGamepad;
    const name = present ? input.gamepadName : null;
    if (present === this.lastPadPresent && name === this.lastPadName) return;
    this.lastPadPresent = present;
    this.lastPadName = name;
    status.textContent = present
      ? name !== null
        ? t('settings.padNamed', { name })
        : t('settings.padConnected')
      : t('settings.padMissing');
    status.classList.toggle('hud-pad-missing', !present);
  }
}

/**
 * up/down/left/right/accept on a focus ring; false when the action is not a focus action.
 * `repeat` (a held arrow's auto-repeat): up / down never wrap, left / right only on a `repeat` item.
 */
function dispatchFocus(ring: FocusRing, action: MenuAction, repeat = false): boolean {
  switch (action) {
    case 'up':
      ring.move(-1, !repeat);
      return true;
    case 'down':
      ring.move(1, !repeat);
      return true;
    case 'left': {
      const it = ring.item;
      if (it !== null && it.left && (!repeat || it.repeat === true)) it.left();
      return true;
    }
    case 'right': {
      const it = ring.item;
      if (it !== null && it.right && (!repeat || it.repeat === true)) it.right();
      return true;
    }
    case 'accept': {
      const it = ring.item;
      if (it !== null && it.accept) it.accept();
      return true;
    }
    default:
      return false;
  }
}

/**
 * Network panel text (NetStatsView -> a few fixed-width lines; called at most 4x/s). A match on a
 * community node gets a `host` line with the node's name, so testers can tell which node they got.
 */
export function formatNetStats(s: NetStatsView): string {
  if (s.kind === 'p2p') return formatP2pStats(s);
  const age = s.snapshotAgeMs < 0 ? '—' : `${Math.round(s.snapshotAgeMs)} ms`;
  return (
    `state     ${s.state}\n` +
    (isNodeHost(s.host) ? `host      ${s.host}\n` : '') +
    `ping      ${s.rttMs.toFixed(1)} ms  jitter ${s.jitterMs.toFixed(1)} ms  loss ${s.lossPct.toFixed(1)} %\n` +
    `lead      ${s.lead} ticks (adj ${s.leadAdjust >= 0 ? '+' : ''}${s.leadAdjust})  rate ${s.rateScale.toFixed(3)}x\n` +
    `tick      host ${s.hostTick}  local ${s.localTick}\n` +
    `rollback  ${s.rollbacksPerSec.toFixed(1)} /s  replayed ${s.replayedPerSec.toFixed(0)} ticks/s\n` +
    `desyncs   ${s.desyncs}  resyncs ${s.resyncs}  mispred ${s.mispredictions}  err ${s.errorCar.toFixed(0)} uu\n` +
    `buffer    hint ${s.bufferHint >= 0 ? '+' : ''}${s.bufferHint}\n` +
    `bytes     in ${formatBytesPerSec(s.bytesInPerSec)}  out ${formatBytesPerSec(s.bytesOutPerSec)}\n` +
    `snapshot  age ${age}  reconnects ${s.reconnects}`
  );
}

/** The P2P panel: engine lines plus one row per peer (slot / name, link state, RTT, candidate type, newest tick). */
export function formatP2pStats(s: NetStatsView): string {
  let text =
    `state     ${s.state}  (P2P, delay ${s.inputDelay} ticks)\n` +
    `tick      confirmed ${s.confirmedTick}  predicted +${s.predictedAhead}  ahead ${s.bufferHint}\n` +
    `rollback  ${s.rollbacksPerSec.toFixed(1)} /s  resim ${s.replayedPerSec.toFixed(0)} ticks/s\n` +
    `stalls    ${s.stalls}  timesync ${s.timesyncSkips}  desyncs ${s.desyncs}  resyncs ${s.resyncs}\n` +
    `bytes     in ${formatBytesPerSec(s.bytesInPerSec)}  out ${formatBytesPerSec(s.bytesOutPerSec)}\n` +
    `peers     ${s.p2pPeers}`;
  for (let i = 0; i < s.p2pPeers; i++) {
    const cand = PEER_CAND_LABELS[s.p2pPeerCand[i]] ?? '?';
    const state = PEER_STATE_LABELS[s.p2pPeerState[i]] ?? '?';
    text += `\n  #${s.p2pPeerSlot[i]} ${s.p2pPeerName[i].padEnd(12).slice(0, 12)} ${state.padEnd(10)} ${s.p2pPeerRtt[i].toFixed(0).padStart(4)} ms  ${cand.padEnd(5)} tick ${s.p2pPeerTick[i]}`;
  }
  return text;
}

function formatBytesPerSec(b: number): string {
  return b >= 10_000 ? `${(b / 1000).toFixed(1)} kB/s` : `${Math.round(b)} B/s`;
}

function settingsKeyAction(code: string): MenuAction | null {
  switch (code) {
    case 'Enter':
    case 'NumpadEnter':
    case 'Space':
      return 'accept';
    case 'ArrowLeft':
    case 'KeyA':
      return 'left';
    case 'ArrowRight':
    case 'KeyD':
      return 'right';
    case 'ArrowUp':
    case 'KeyW':
      return 'up';
    case 'ArrowDown':
    case 'KeyS':
      return 'down';
    case 'Escape':
    case 'Backspace':
      return 'back';
    default:
      return null;
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';
/** The lit part of the controls card's mouse (24 × 24 view box): left half, wheel, right half. */
const MOUSE_LIT: Readonly<Record<number, string>> = {
  0: 'M11.1 4.1A5.1 5.1 0 0 0 6.9 9.2V9.4H11.1Z',
  1: 'M11 5h2v4h-2Z',
  2: 'M12.9 4.1A5.1 5.1 0 0 1 17.1 9.2V9.4H12.9Z',
};

/** A mouse button on the controls card: a small mouse with that button lit, then its name ('Right click'). */
function mouseKey(k: CardKey): HTMLElement {
  const box = el('span', 'hud-controls-mouse');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'hud-mouse');
  const outline = document.createElementNS(SVG_NS, 'path');
  outline.setAttribute('d', 'M12 3a6 6 0 0 1 6 6v6a6 6 0 0 1-12 0V9a6 6 0 0 1 6-6ZM6 10h12M12 3v7');
  svg.appendChild(outline);
  const lit = k.button !== undefined ? MOUSE_LIT[k.button] : undefined;
  if (lit !== undefined) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', lit);
    p.setAttribute('class', 'hud-mouse-lit');
    svg.appendChild(p);
  }
  box.append(svg, el('span', 'hud-controls-mouse-name', k.label));
  return box;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(className: string, text: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = text;
  b.tabIndex = -1;
  return b;
}
