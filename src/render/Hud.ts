/**
 * DOM HUD: the scorebug (top left: BLU / RED chips with their scores, then the clock), the
 * segmented boost bar (bottom left, the speed readout sits above it in debug mode), fps, camera
 * mode, off-screen ball indicator, countdown, banners, the pause menu, the Tab scoreboard, a
 * pointer-lock hint, the start menu and the settings screen (rebinding for keyboard/mouse and
 * controller, camera and gameplay sliders, the master volume, the graphics quality). Every
 * per-frame setter caches its last value and touches the DOM only when something changed, so
 * calling them every frame costs nothing and allocates nothing.
 *
 * Debug readouts (speed, fps / draw calls / GPU time) are hidden by default; F3 toggles them,
 * and `#stats` or `#debug` in the URL shows them from the start.
 *
 * Menu navigation: the Hud listens to window keydown itself (keyboard); the Game forwards gamepad
 * edges through `menuAction`. While a rebind capture is in progress (`capturing`) both paths are
 * ignored so the captured key / button only reaches Input.startRebind. The pause menu is driven by
 * the Game instead (`pauseAction`, from Input's menu edges: keyboard and pad alike), since the
 * pause / back keys it shares with the match are Input's.
 *
 * Styling lives in src/style.css (classes prefixed `hud-`).
 */
import {
  ACTION_ROWS,
  bindingLabel,
  bindingsEqual,
  DEFAULT_KBM,
  DEFAULT_PAD,
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
import { MODES, type GameMode } from '../sim/constants';
import { t, type Key } from '../i18n';
import type { CameraSettings } from './Camera';
import { QUALITIES, type Quality } from './quality';
import { DEFAULT_MATCH_SECONDS, formatClockSeconds } from '../game/Match';

export type Difficulty = 'easy' | 'medium' | 'hard';
export const DIFFICULTIES: readonly Difficulty[] = ['easy', 'medium', 'hard'];
/** Menu order of the game modes (every key of MODES). */
export const GAME_MODES: readonly GameMode[] = ['1v1', '2v2', '3v3'];

/** Info-line text for a mode: '3v3 · 6 cars'. */
export function modeInfo(mode: GameMode): string {
  return `${mode} · ${MODES[mode] * 2} cars`;
}

/** How the clock is displayed: counting down, counting up (unlimited match) or overtime (+m:ss, red). */
export type ClockMode = 'regulation' | 'unlimited' | 'overtime';

/** ONLINE submenu entries: 'p2p' = Quick match (mesh, phase 2), 'server' = Partida en servidor (phase 1). */
export type OnlineKind = 'p2p' | 'server';
export const ONLINE_KINDS: readonly OnlineKind[] = ['p2p', 'server'];
export const ONLINE_KIND_LABELS: Readonly<Record<OnlineKind, string>> = {
  p2p: 'QUICK MATCH  (P2P)',
  server: 'PARTIDA EN SERVIDOR',
};

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
  title?: string;
  subtitle?: string;
  difficulty: Difficulty;
  quality: Quality;
  /** Game mode shown in the Mode row (1v1 / 2v2 / 3v3). */
  mode: GameMode;
  onPlay: (difficulty: Difficulty, quality: Quality, mode: GameMode) => void;
  /** The quality tier picked (the settings screen's Graphics tab; Q in the legacy main menu). */
  onQualityChange?: (quality: Quality) => void;
  onDifficultyChange?: (difficulty: Difficulty) => void;
  /** The Mode row changed (arrows, M, pad left / right); the Game rebuilds the roster at once. */
  onModeChange?: (mode: GameMode) => void;
  /**
   * The live settings object (src/settings.ts). The Camera / Gameplay tabs write into
   * `settings.camera` / `settings.controls` in place. Together with `input` this enables the
   * "CONTROLS & SETTINGS" button; without either the button is hidden.
   */
  settings?: Settings;
  /** Rebinding API (Input). Also used for the live controls list under the main menu. */
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
  /** [action, binding] rows for the controls list; overrides the generated list when given. */
  controls?: ReadonlyArray<readonly [string, string]>;
  /** Small line under the controls (e.g. the active backend). */
  info?: string;
  /** Online: shows the ONLINE button and the guest name field (default: when onOnline is given). */
  onlineEnabled?: boolean;
  /** Which ONLINE submenu entries exist (default both). */
  p2pEnabled?: boolean;
  serverEnabled?: boolean;
  /** An ONLINE submenu entry was chosen (click, Enter / A on it): quick match of that kind with the selected mode. */
  onOnline?: (mode: GameMode, kind: OnlineKind) => void;
  /** Esc / Backspace / pad B in the main menu while a status line is shown: cancel matchmaking. */
  onOnlineCancel?: () => void;
  /** Initial value of the guest name field. */
  guestName?: string;
  /** The guest name field changed (on blur / Enter). */
  onNameChange?: (name: string) => void;
}

/**
 * Gamepad / input layer routes these while the menu is shown (the keyboard goes through the
 * Hud's own listener). 'settings' = open the settings screen (next tab while inside it),
 * 'back' = leave the settings screen, 'up' / 'down' = move the focus, 'mode' = next game mode
 * (M), 'quality' = the next quality tier (Q: low -> high -> ultra -> low).
 */
export type MenuAction = 'accept' | 'left' | 'right' | 'quality' | 'mode' | 'settings' | 'up' | 'down' | 'back' | 'online';

export type SettingsTab = 'kbm' | 'pad' | 'camera' | 'gameplay' | 'audio' | 'graphics';

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
  /** Ask for a second activation first (its label turns into pause.quitConfirm): leaving an online match. */
  readonly confirm?: boolean;
  readonly select: () => void;
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

/** Actions listed under the main menu: the driving basics plus ball cam, rear view and pause. */
export const MENU_CONTROL_ROWS = ACTION_ROWS.filter(
  (r) => r.group === 'driving' || r.action === 'ballCam' || r.action === 'rearView' || r.action === 'pause',
);

// The settings screen's tables hold text keys: t() runs when the screen is built (once per page).
// The language is fixed for the page, so resolving them at import would work too (ACTION_ROWS does).
const SETTINGS_TABS: ReadonlyArray<{ id: SettingsTab; label: Key }> = [
  { id: 'kbm', label: 'settings.tabKbm' },
  { id: 'pad', label: 'settings.tabPad' },
  { id: 'camera', label: 'settings.tabCamera' },
  { id: 'gameplay', label: 'settings.tabGameplay' },
  { id: 'audio', label: 'settings.tabAudio' },
  { id: 'graphics', label: 'settings.tabGraphics' },
];

/** The line under the Graphics tab's quality row, per tier. */
const QUALITY_HINTS: Readonly<Record<Quality, Key>> = {
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

/** The pause menu's quit keys (fixed: Game handles Backspace / pad B while paused). */
export const PAUSE_QUIT_KEYS = 'Backspace / B';

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
}

interface BindRow {
  action: ActionId;
  device: Device;
  row: HTMLElement;
  cell: HTMLButtonElement;
}

interface PageBuild {
  page: HTMLElement;
  items: FocusItem[];
  /** Footer buttons of the page (shown only while its tab is active). */
  actions: HTMLElement;
  /** Their focus stop; null when the page has no footer buttons. */
  footer: FocusItem | null;
}

/** Wrapping focus over a list of items; keeps the `hud-focus` class on the current one. */
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

  move(dir: number): void {
    this.set(this.index + dir);
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
  private readonly countdown: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly bannerTitle: HTMLElement;
  private readonly bannerSub: HTMLElement;
  private readonly paused: HTMLElement;
  private readonly pausedSub: HTMLElement;
  /** The pause menu's buttons (setPaused rebuilds them from the Game's entries). */
  private readonly pauseMenu: HTMLElement;
  private readonly pauseRing = new FocusRing();
  private pauseOpen = false;
  /** The settings screen is open over the pause menu (setPauseCovered). */
  private pauseCovered = false;
  private pauseEntries: readonly PauseEntry[] = [];
  /** One button per entry, in entry order. */
  private readonly pauseButtons: HTMLButtonElement[] = [];
  /** The focus stop of each entry, in entry order (the entries of a row share one). */
  private readonly pauseItemOf: FocusItem[] = [];
  /** The entry waiting for its second activation (PauseEntry.confirm), or null. */
  private pauseArmed: PauseEntry | null = null;
  private readonly hint: HTMLElement;

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

  // Main menu.
  private menu: HTMLElement | null = null;
  private mainPanel: HTMLElement | null = null;
  private menuTitle: HTMLElement | null = null;
  private menuSubtitle: HTMLElement | null = null;
  private menuHint: HTMLElement | null = null;
  private menuDifficulty: HTMLElement | null = null;
  private menuMode: HTMLElement | null = null;
  private menuQuality: HTMLElement | null = null;
  private menuControls: HTMLElement | null = null;
  private menuInfo: HTMLElement | null = null;
  private settingsButton: HTMLButtonElement | null = null;
  // Online (phase 1): ONLINE button, matchmaking status line, guest name field, network panel.
  private menuOnline: HTMLButtonElement | null = null;
  private onlineSub: HTMLElement | null = null;
  private readonly onlineButtons: Partial<Record<OnlineKind, HTMLButtonElement>> = {};
  private readonly onlineKindItems: FocusItem[] = [];
  private onlineSubOpen = false;
  private menuStatus: HTMLElement | null = null;
  private readonly turnstileBox: HTMLElement;
  private nameRow: HTMLElement | null = null;
  private nameInput: HTMLInputElement | null = null;
  private onlineItem: FocusItem | null = null;
  private nameItem: FocusItem | null = null;
  private lastStatus: string | null = null;
  private lastStatusError = false;
  private readonly net: HTMLElement;
  private readonly netBody: HTMLElement;
  private readonly netWait: HTMLElement;
  private lastNetWait: string | null = null;
  private netToggle = false;
  private netAuto = false;
  private netShown = false;
  private lastNetAt = -1e9;
  private lastNetText = '';
  private mainItemsAll: FocusItem[] = [];
  private mainItemsBasic: FocusItem[] = [];
  private readonly mainRing = new FocusRing();
  private menuOptions: MenuOptions | null = null;
  private difficulty: Difficulty = 'medium';
  private quality: Quality = 'high';
  private mode: GameMode = '1v1';
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
  private tabItems: Record<SettingsTab, FocusItem[]> | null = null;
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
    // The guest name field: letters must type, not navigate; Enter / Esc leave it.
    if (e.target instanceof HTMLInputElement && e.target.type === 'text') {
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
    if (this.menu === null || this.menu.hidden) return;
    const action = this.settingsOpen ? settingsKeyAction(e.code) : mainKeyAction(e.code);
    if (action !== null) {
      this.menuAction(action);
      e.preventDefault();
      return;
    }
    if (!this.settingsOpen) return;
    switch (e.code) {
      case 'Delete':
        this.clearFocused();
        break;
      case 'KeyQ':
        this.cycleTab(-1);
        break;
      case 'KeyE':
        this.cycleTab(1);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  private readonly onResize = (): void => {
    this.rootW = 0;
    this.rootH = 0;
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

    // Scorebug (top left): [BLU 0] [RED 0] [3:00]. The three-letter tags keep the teams apart
    // without relying on colour alone.
    const top = el('div', 'hud-top');
    const board = el('div', 'hud-score');
    const blue = el('div', 'hud-score-team hud-blue');
    this.scoreBlue = el('span', 'hud-score-goals', '0');
    blue.append(el('span', 'hud-score-tag', t('hud.tagBlue')), this.scoreBlue);
    const red = el('div', 'hud-score-team hud-red');
    this.scoreRed = el('span', 'hud-score-goals', '0');
    red.append(el('span', 'hud-score-tag', t('hud.tagRed')), this.scoreRed);
    this.clock = el('div', 'hud-clock', formatClockSeconds(DEFAULT_MATCH_SECONDS));
    board.append(blue, red, this.clock);
    top.appendChild(board);
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

    this.banner = el('div', 'hud-banner');
    this.bannerTitle = el('div', 'hud-banner-title');
    this.bannerSub = el('div', 'hud-banner-sub');
    this.banner.append(this.bannerTitle, this.bannerSub);
    this.banner.hidden = true;
    this.root.appendChild(this.banner);

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

    this.paused = el('div', 'hud-paused');
    this.pausedSub = el('div', 'hud-paused-sub', t('pause.hintDefault', { resumeKeys: 'Esc / Start', quitKeys: PAUSE_QUIT_KEYS }));
    // The pause menu, for every input: the mouse and a finger click its buttons, the keyboard and
    // the pad move the focus (the Game routes Input's menu edges to pauseAction). Only the buttons
    // take the pointer: a click or tap on the veil still reaches the canvas (resume). The key line
    // stays for the keyboard (style.css hides it in touch mode). Online, QUIT asks for a second
    // press: a slip next to RESUME would leave the match (an abandon in ranked).
    this.pauseMenu = el('div', 'hud-pause-menu');
    // DOM focus stays off the buttons: Enter on a clicked button would click it natively on top of
    // the Game's accept.
    this.pauseMenu.addEventListener('mousedown', (e: MouseEvent) => e.preventDefault());
    this.paused.append(el('div', 'hud-paused-title', t('pause.title')), this.pausedSub, this.pauseMenu);
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

    const hash = typeof location !== 'undefined' ? location.hash : '';
    this.setDebug(hash.includes('stats') || hash.includes('debug'));
    this.setNetToggle(hash.includes('net'));

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
  setNetWait(text: string | null): void {
    if (text === this.lastNetWait) return;
    this.lastNetWait = text;
    if (text === null) {
      this.netWait.hidden = true;
      return;
    }
    this.netWait.textContent = text;
    this.netWait.hidden = false;
  }

  /**
   * Matchmaking / connection status under the ONLINE button ('Buscando partido... (2 esperando)',
   * 'Conectando...', an error); null hides the line. Cached. A visible status closes the submenu.
   */
  setOnlineStatus(text: string | null, error = false): void {
    if (text === this.lastStatus && error === this.lastStatusError) return;
    this.lastStatus = text;
    this.lastStatusError = error;
    const line = this.menuStatus;
    if (line === null) return;
    if (text === null) {
      line.hidden = true;
      return;
    }
    if (!error && this.onlineSubOpen) this.setOnlineSub(false);
    line.textContent = text;
    line.hidden = false;
    line.classList.toggle('hud-error', error);
  }

  /** The ONLINE submenu (Quick match (P2P) / Partida en servidor) is open. */
  get onlineMenuOpen(): boolean {
    return this.onlineSubOpen;
  }

  /** Current value of the guest name field ('' when the menu was never built). */
  get guestName(): string {
    return this.nameInput !== null ? this.nameInput.value : '';
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
    const x = Math.round(((nx + 1) * 0.5 * this.rootW) / 2) * 2;
    const y = Math.round(((1 - ny) * 0.5 * this.rootH) / 2) * 2;
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

  /** Kickoff countdown: 3, 2, 1, 'GO' (a token: shown as hud.go); null hides it. */
  showCountdown(n: number | 'GO' | null): void {
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

  /** Centre banner (goal, overtime, winner...), hidden after `ms` (0 = until the next banner). */
  showBanner(title: string, sub = '', ms = 2500, team: 0 | 1 | null = null): void {
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
  }

  /**
   * Show the pause menu with `entries` (the focus on the first) and `hint` as its key line, or hide
   * it. Called on pause only (it rebuilds the buttons), never per frame.
   */
  setPaused(paused: boolean, entries: readonly PauseEntry[] = [], hint?: string): void {
    this.pauseOpen = paused;
    this.pauseCovered = false;
    this.pauseArmed = null;
    this.paused.hidden = !paused;
    if (!paused) {
      this.pauseRing.use([]);
      return;
    }
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
    this.disarmPause();
    if (!covered && focusId !== undefined) {
      const i = this.pauseEntries.findIndex((e) => e.id === focusId);
      if (i >= 0) this.focusPauseEntry(i);
    }
  }

  /** Keyboard / pad on the pause menu (Input's menu edges, routed by the Game while paused). */
  pauseAction(action: PauseAction): void {
    if (!this.pauseMenuVisible) return;
    if (action !== 'accept') this.disarmPause();
    dispatchFocus(this.pauseRing, action);
  }

  private buildPauseMenu(entries: readonly PauseEntry[]): void {
    const menu = this.pauseMenu;
    menu.textContent = '';
    this.pauseEntries = entries;
    const buttons = this.pauseButtons;
    const itemOf = this.pauseItemOf;
    buttons.length = 0;
    itemOf.length = 0;
    const items: FocusItem[] = [];
    // A run of 'row' entries shares one line and one focus stop (left / right pick, accept clicks).
    let row: HTMLElement | null = null;
    let rowStart = 0;
    const closeRow = (): void => {
      if (row === null) return;
      const item = this.groupItem(row, buttons.slice(rowStart), this.pauseRing);
      for (let k = rowStart; k < buttons.length; k++) itemOf[k] = item;
      items.push(item);
      row = null;
    };
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const kind = entry.kind ?? 'plain';
      const b = button(`hud-pause-btn hud-pause-${kind}`, entry.label());
      b.addEventListener('click', () => this.activatePause(entry));
      if (kind === 'row') {
        if (row === null) {
          row = el('div', 'hud-pause-row');
          rowStart = buttons.length;
          menu.appendChild(row);
        }
        row.appendChild(b);
        buttons.push(b);
        continue;
      }
      closeRow();
      menu.appendChild(b);
      buttons.push(b);
      const item: FocusItem = { el: b, accept: () => this.activatePause(entry) };
      b.addEventListener('pointerdown', () => this.pauseRing.focusItem(item));
      itemOf[i] = item;
      items.push(item);
    }
    closeRow();
    this.pauseRing.use(items, 0);
  }

  /** Put the focus on entry `i` (and pick it inside its row when it is in one). */
  private focusPauseEntry(i: number): void {
    const item = this.pauseItemOf[i];
    const b = this.pauseButtons[i];
    if (item === undefined || b === undefined) return;
    this.pauseRing.focusItem(item);
    if (item.el !== b) b.dispatchEvent(new Event('pointerdown')); // groupItem picks the button on pointerdown
  }

  private activatePause(entry: PauseEntry): void {
    if (!this.pauseMenuVisible) return;
    const i = this.pauseEntries.indexOf(entry);
    if (i < 0) return;
    if (entry.confirm === true && this.pauseArmed !== entry) {
      this.disarmPause();
      this.pauseArmed = entry;
      const b = this.pauseButtons[i];
      b.textContent = t('pause.quitConfirm');
      b.classList.add('hud-pause-armed');
      return;
    }
    this.disarmPause();
    const entries = this.pauseEntries;
    entry.select();
    // Still the same menu (a toggle, not resume / quit): its labels may have changed.
    if (this.pauseOpen && this.pauseEntries === entries) {
      for (let k = 0; k < entries.length; k++) this.pauseButtons[k].textContent = entries[k].label();
    }
  }

  private disarmPause(): void {
    const armed = this.pauseArmed;
    if (armed === null) return;
    this.pauseArmed = null;
    const i = this.pauseEntries.indexOf(armed);
    if (i < 0) return;
    const b = this.pauseButtons[i];
    b.textContent = armed.label();
    b.classList.remove('hud-pause-armed');
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

  get selectedDifficulty(): Difficulty {
    return this.difficulty;
  }

  get selectedQuality(): Quality {
    return this.quality;
  }

  get selectedMode(): GameMode {
    return this.mode;
  }

  /**
   * Make the Mode row show `mode` without firing onModeChange: the Game calls it when it could
   * not honour the requested mode (a wasm build with a smaller MAX_CARS falls back to 1v1).
   */
  setSelectedMode(mode: GameMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.refreshMenu();
  }

  showMenu(opts: MenuOptions): void {
    this.menuOptions = opts;
    this.difficulty = opts.difficulty;
    this.quality = opts.quality;
    this.mode = opts.mode;
    if (this.menu === null) this.buildMenu();
    const menu = this.menu as HTMLElement;
    if (this.menuTitle !== null) this.menuTitle.textContent = opts.title ?? 'TURBOGOL';
    if (this.menuSubtitle !== null) this.menuSubtitle.textContent = opts.subtitle ?? 'RocketSim physics · WebGPU';
    const canSettings = opts.settings !== undefined && opts.input !== undefined;
    if (this.settingsButton !== null) this.settingsButton.hidden = !canSettings;
    const canOnline = opts.onlineEnabled ?? opts.onOnline !== undefined;
    if (this.menuOnline !== null) this.menuOnline.hidden = !canOnline;
    if (this.nameRow !== null) this.nameRow.hidden = !canOnline;
    const p2pBtn = this.onlineButtons.p2p;
    const serverBtn = this.onlineButtons.server;
    if (p2pBtn !== undefined) p2pBtn.hidden = !(opts.p2pEnabled ?? true);
    if (serverBtn !== undefined) serverBtn.hidden = !(opts.serverEnabled ?? true);
    this.setOnlineSub(false);
    if (this.nameInput !== null && opts.guestName !== undefined && document.activeElement !== this.nameInput) {
      this.nameInput.value = opts.guestName;
    }
    this.setOnlineStatus(null);
    if (this.menuHint !== null) {
      const online = canOnline ? '   ·   N / Y  online (P2P or server)' : '';
      this.menuHint.textContent = canSettings
        ? `Enter / A  play${online}   ·   M  mode   ·   Q  quality   ·   O / X  controls & settings`
        : `Enter / A  play${online}   ·   M  mode   ·   Q  quality`;
    }
    this.renderControlsList();
    this.refreshMenu();
    this.showMainPanel();
    this.mainRing.use(this.mainItems(canSettings, canOnline), 0);
    menu.hidden = false;
    this.setBallIndicator(false);
  }

  /** Focusable main-menu items in order, skipping the hidden ONLINE / name / settings entries. */
  private mainItems(canSettings: boolean, canOnline: boolean): FocusItem[] {
    const out: FocusItem[] = [];
    for (const item of this.mainItemsAll) {
      if (!canOnline && (item === this.onlineItem || item === this.nameItem)) continue;
      if (!canSettings && item.el === this.settingsButton) continue;
      out.push(item);
    }
    return out;
  }

  hideMenu(): void {
    if (this.menu !== null) {
      this.menu.hidden = true;
      this.menu.classList.remove('hud-menu-settings-only');
    }
    this.settingsOnlyClose = null;
    this.stopPadPoll();
  }

  /**
   * The Controls & Settings screen on its own (the front-end menus in src/ui own every other
   * screen): the overlay opens straight on the settings panel and its BACK (button, Esc, pad B)
   * hides the overlay again and calls `onClose`. Rebinding, sliders and presets work as before
   * through `opts` (settings, input, onSettingsChanged, onCameraPreset).
   */
  openSettingsScreen(opts: MenuOptions, onClose: () => void): void {
    this.menuOptions = opts;
    this.quality = opts.quality;
    if (this.menu === null) this.buildMenu();
    const menu = this.menu as HTMLElement;
    menu.classList.add('hud-menu-settings-only');
    menu.hidden = false;
    this.settingsOnlyClose = onClose;
    // A finger has no use for the binding tabs: touch mode opens on Graphics instead.
    if ((this.tab === 'kbm' || this.tab === 'pad') && document.documentElement.classList.contains('tg-touch')) this.tab = 'graphics';
    this.openSettings();
  }

  /**
   * Route gamepad / keyboard navigation to the menu (no-op while hidden or while a rebind
   * capture is running). Main menu: up/down move the focus (PLAY, Difficulty, Mode, Quality,
   * Controls & settings), accept activates the focused row (PLAY by default), left/right change
   * the focused row's value (difficulty / mode; the next quality tier on its row), 'mode' (M)
   * cycles the mode, 'quality' (Q) steps to the next quality tier, 'settings' opens the settings
   * screen. Settings screen: up/down focus, left/right adjust (tabs on the tab strip), accept
   * activates (rebind / toggle / button), 'settings' or 'quality' = next tab, back closes ('mode'
   * does nothing there).
   */
  menuAction(action: MenuAction): void {
    if (!this.menuVisible || this.menuOptions === null || this.captureRow !== null) return;
    if (this.settingsOpen) {
      if (dispatchFocus(this.settingsRing, action)) return;
      if (action === 'back') this.closeSettings();
      else if (action === 'quality' || action === 'settings') this.cycleTab(1);
      return;
    }
    if (dispatchFocus(this.mainRing, action)) return;
    if (action === 'quality') this.stepQuality(1);
    else if (action === 'mode') this.cycleMode(1);
    else if (action === 'settings') this.openSettings();
    else if (action === 'online') this.online();
    // 'back' in the main menu closes the ONLINE submenu, else cancels matchmaking.
    else if (action === 'back') {
      if (this.onlineSubOpen) this.setOnlineSub(false);
      else if (this.lastStatus !== null && this.menuOptions.onOnlineCancel) this.menuOptions.onOnlineCancel();
    }
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('resize', this.onResize);
    if (this.bannerTimer !== 0) window.clearTimeout(this.bannerTimer);
    this.stopPadPoll();
    this.root.remove();
  }

  // ---- main menu ---------------------------------------------------------------------------

  /**
   * The overlay plus the legacy main panel. Nothing shows that panel any more (showMenu has no
   * caller; openSettingsScreen hides it behind the settings panel), so its texts stay in English,
   * like modeInfo's.
   */
  private buildMenu(): void {
    const menu = el('div', 'hud-menu');
    // Keep DOM focus off the buttons so Enter / Space never fire a native click on top of the
    // menu's own key handling; RMB over the menu must not open the context menu (it is bindable).
    menu.addEventListener('mousedown', (e: MouseEvent) => {
      if (e.target instanceof HTMLButtonElement) e.preventDefault();
    });
    menu.addEventListener('contextmenu', (e: Event) => e.preventDefault());

    const panel = el('div', 'hud-menu-panel');
    this.menuTitle = el('div', 'hud-menu-title');
    this.menuSubtitle = el('div', 'hud-menu-subtitle');
    panel.append(this.menuTitle, this.menuSubtitle);

    const play = button('hud-menu-play', 'PLAY');
    play.addEventListener('click', () => this.play());
    panel.appendChild(play);
    // Online (phase 1): quick match in the selected mode, with a status line while it searches.
    const online = button('hud-menu-online', 'ONLINE');
    online.addEventListener('click', () => this.online());
    online.hidden = true;
    this.menuOnline = online;
    panel.appendChild(online);
    // ONLINE submenu: one button per kind (Quick match (P2P) / Partida en servidor).
    const sub = el('div', 'hud-menu-online-sub');
    sub.hidden = true;
    for (const kind of ONLINE_KINDS) {
      const b = button('hud-menu-online-opt', ONLINE_KIND_LABELS[kind]);
      b.addEventListener('click', () => this.startOnline(kind));
      this.onlineButtons[kind] = b;
      sub.appendChild(b);
      const item: FocusItem = { el: b, accept: () => this.startOnline(kind), left: () => this.cycleMode(-1), right: () => this.cycleMode(1) };
      b.addEventListener('pointerdown', () => this.mainRing.focusItem(item));
      this.onlineKindItems.push(item);
    }
    this.onlineSub = sub;
    panel.appendChild(sub);
    this.menuStatus = el('div', 'hud-menu-status');
    this.menuStatus.hidden = true;
    panel.appendChild(this.menuStatus);
    this.menuHint = el('div', 'hud-menu-hint', 'Press Enter / A to play');
    panel.appendChild(this.menuHint);

    const rows = el('div', 'hud-menu-rows');
    // Guest name (persisted by the online client); typing never reaches the menu keys.
    const nameRow = el('div', 'hud-menu-row hud-menu-name-row');
    nameRow.appendChild(el('span', 'hud-menu-row-label', 'Name'));
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'hud-menu-name';
    nameInput.maxLength = 16;
    nameInput.placeholder = 'Guest';
    nameInput.autocomplete = 'off';
    nameInput.spellcheck = false;
    nameInput.tabIndex = -1;
    nameInput.addEventListener('change', () => {
      const opts = this.menuOptions;
      if (opts !== null && opts.onNameChange) opts.onNameChange(nameInput.value);
    });
    nameRow.appendChild(nameInput);
    nameRow.hidden = true;
    this.nameRow = nameRow;
    this.nameInput = nameInput;
    rows.appendChild(nameRow);
    const diffRow = el('div', 'hud-menu-row');
    diffRow.appendChild(el('span', 'hud-menu-row-label', 'Difficulty'));
    const diffCtl = el('span', 'hud-menu-select');
    const dl = button('hud-menu-arrow', '‹');
    dl.addEventListener('click', () => this.cycleDifficulty(-1));
    this.menuDifficulty = el('span', 'hud-menu-value');
    const dr = button('hud-menu-arrow', '›');
    dr.addEventListener('click', () => this.cycleDifficulty(1));
    diffCtl.append(dl, this.menuDifficulty, dr);
    diffRow.appendChild(diffCtl);

    const modeRow = el('div', 'hud-menu-row');
    modeRow.appendChild(el('span', 'hud-menu-row-label', 'Mode'));
    const modeCtl = el('span', 'hud-menu-select');
    const ml = button('hud-menu-arrow', '‹');
    ml.addEventListener('click', () => this.cycleMode(-1));
    this.menuMode = el('span', 'hud-menu-value');
    const mr = button('hud-menu-arrow', '›');
    mr.addEventListener('click', () => this.cycleMode(1));
    modeCtl.append(ml, this.menuMode, mr);
    modeRow.appendChild(modeCtl);

    const qRow = el('div', 'hud-menu-row');
    qRow.appendChild(el('span', 'hud-menu-row-label', 'Quality'));
    const qBtn = button('hud-menu-toggle', '');
    qBtn.addEventListener('click', () => this.stepQuality(1));
    this.menuQuality = qBtn;
    qRow.appendChild(qBtn);
    rows.append(diffRow, modeRow, qRow);
    panel.appendChild(rows);

    const settingsBtn = button('hud-menu-settings', 'CONTROLS & SETTINGS');
    settingsBtn.addEventListener('click', () => this.openSettings());
    settingsBtn.hidden = true;
    this.settingsButton = settingsBtn;
    panel.appendChild(settingsBtn);

    this.menuControls = el('div', 'hud-menu-controls');
    panel.appendChild(this.menuControls);
    this.menuInfo = el('div', 'hud-menu-info');
    panel.appendChild(this.menuInfo);
    menu.appendChild(panel);

    const diffLeft = (): void => this.cycleDifficulty(-1);
    const diffRight = (): void => this.cycleDifficulty(1);
    const modeLeft = (): void => this.cycleMode(-1);
    const modeRight = (): void => this.cycleMode(1);
    const qualityLeft = (): void => this.stepQuality(-1);
    const qualityRight = (): void => this.stepQuality(1);
    const playItem: FocusItem = { el: play, accept: () => this.play(), left: diffLeft, right: diffRight };
    const onlineItem: FocusItem = { el: online, accept: () => this.online(), left: modeLeft, right: modeRight };
    const nameItem: FocusItem = { el: nameRow, accept: () => nameInput.focus() };
    const diffItem: FocusItem = { el: diffRow, accept: diffRight, left: diffLeft, right: diffRight };
    const modeItem: FocusItem = { el: modeRow, accept: modeRight, left: modeLeft, right: modeRight };
    const qualItem: FocusItem = { el: qRow, accept: qualityRight, left: qualityLeft, right: qualityRight };
    const settingsItem: FocusItem = { el: settingsBtn, accept: () => this.openSettings(), left: diffLeft, right: diffRight };
    this.onlineItem = onlineItem;
    this.nameItem = nameItem;
    this.mainItemsBasic = [playItem, diffItem, modeItem, qualItem];
    this.mainItemsAll = [playItem, onlineItem, nameItem, diffItem, modeItem, qualItem, settingsItem];
    for (const item of this.mainItemsAll) item.el.addEventListener('pointerdown', () => this.mainRing.focusItem(item));

    menu.hidden = true;
    this.root.appendChild(menu);
    this.menu = menu;
    this.mainPanel = panel;
  }

  private play(): void {
    if (this.menuOptions === null) return;
    this.menuOptions.onPlay(this.difficulty, this.quality, this.mode);
  }

  /** ONLINE (button, N, pad Y): toggle the submenu; while matchmaking it does nothing. */
  private online(): void {
    const opts = this.menuOptions;
    if (opts === null || !opts.onOnline || (this.menuOnline !== null && this.menuOnline.hidden)) return;
    if (this.nameInput !== null && document.activeElement === this.nameInput) this.nameInput.blur();
    if (this.lastStatus !== null && !this.lastStatusError) return;
    this.setOnlineSub(!this.onlineSubOpen);
  }

  private startOnline(kind: OnlineKind): void {
    const opts = this.menuOptions;
    const btn = this.onlineButtons[kind];
    if (opts === null || !opts.onOnline || btn === undefined || btn.hidden) return;
    if (this.nameInput !== null && document.activeElement === this.nameInput) this.nameInput.blur();
    this.setOnlineSub(false);
    opts.onOnline(this.mode, kind);
  }

  /** Open / close the ONLINE submenu; open, the focus ring holds its entries (Esc / B closes it). */
  private setOnlineSub(open: boolean): void {
    if (open === this.onlineSubOpen) return;
    this.onlineSubOpen = open;
    if (this.onlineSub !== null) this.onlineSub.hidden = !open;
    if (this.menuOnline !== null) this.menuOnline.classList.toggle('hud-active', open);
    const opts = this.menuOptions;
    if (opts === null) return;
    if (open) {
      const items: FocusItem[] = [];
      for (let i = 0; i < ONLINE_KINDS.length; i++) {
        const b = this.onlineButtons[ONLINE_KINDS[i]];
        if (b !== undefined && !b.hidden) items.push(this.onlineKindItems[i]);
      }
      this.mainRing.use(items, 0);
    } else {
      const canSettings = opts.settings !== undefined && opts.input !== undefined;
      const canOnline = opts.onlineEnabled ?? opts.onOnline !== undefined;
      const items = this.mainItems(canSettings, canOnline);
      let index = 0;
      for (let i = 0; i < items.length; i++) if (items[i] === this.onlineItem) index = i;
      this.mainRing.use(items, index);
    }
  }

  private cycleMode(dir: number): void {
    const i = GAME_MODES.indexOf(this.mode);
    const n = (i + dir + GAME_MODES.length) % GAME_MODES.length;
    this.mode = GAME_MODES[n];
    this.refreshMenu();
    const opts = this.menuOptions;
    if (opts !== null && opts.onModeChange) opts.onModeChange(this.mode);
  }

  private cycleDifficulty(dir: number): void {
    const i = DIFFICULTIES.indexOf(this.difficulty);
    const n = (i + dir + DIFFICULTIES.length) % DIFFICULTIES.length;
    this.difficulty = DIFFICULTIES[n];
    this.refreshMenu();
    const opts = this.menuOptions;
    if (opts !== null && opts.onDifficultyChange) opts.onDifficultyChange(this.difficulty);
  }

  /**
   * Step the tier in menu order (low -> high -> ultra, wrapping): +1 for Q, a click, accept or
   * right on the Quality row, -1 for left.
   */
  private stepQuality(d: 1 | -1): void {
    const n = QUALITIES.length;
    this.quality = QUALITIES[(QUALITIES.indexOf(this.quality) + d + n) % n];
    this.refreshMenu();
    const opts = this.menuOptions;
    if (opts !== null && opts.onQualityChange) opts.onQualityChange(this.quality);
  }

  /** Row values plus the info line ('3v3 · 6 cars · WebGPU · RocketSim 2.2.1 · 120 Hz'). */
  private refreshMenu(): void {
    if (this.menuDifficulty !== null) this.menuDifficulty.textContent = this.difficulty.toUpperCase();
    if (this.menuMode !== null) this.menuMode.textContent = this.mode.toUpperCase();
    if (this.menuQuality !== null) this.menuQuality.textContent = `${t(`quality.${this.quality}`).toUpperCase()}  (Q)`;
    if (this.menuInfo !== null) {
      const info = this.menuOptions?.info ?? '';
      this.menuInfo.textContent = info.length > 0 ? `${modeInfo(this.mode)}  ·  ${info}` : modeInfo(this.mode);
    }
  }

  /** Controls list under the main menu, generated from the live bindings ('<kbm> · <pad>'). */
  private renderControlsList(): void {
    const list = this.menuControls;
    const opts = this.menuOptions;
    if (list === null || opts === null) return;
    list.textContent = '';
    if (opts.controls !== undefined) {
      for (const [action, keys] of opts.controls) list.appendChild(controlRow(action, keys));
      return;
    }
    for (const row of MENU_CONTROL_ROWS) {
      list.appendChild(controlRow(row.label, `${this.labelFor(row.action, 'kbm')}  ·  ${this.labelFor(row.action, 'pad')}`));
    }
    list.appendChild(controlRow('Debug readouts', 'F3'));
    if (opts.onlineEnabled ?? opts.onOnline !== undefined) list.appendChild(controlRow('Network panel', 'F4'));
  }

  private labelFor(action: ActionId, device: Device): string {
    const input = this.menuOptions?.input;
    if (input !== undefined) return input.getLabel(action, device);
    return bindingLabel((device === 'kbm' ? DEFAULT_KBM : DEFAULT_PAD)[action]);
  }

  private showMainPanel(): void {
    this.settingsOpen = false;
    if (this.mainPanel !== null) this.mainPanel.hidden = false;
    if (this.settingsPanel !== null) this.settingsPanel.hidden = true;
    this.stopPadPoll();
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
    if (this.mainPanel !== null) this.mainPanel.hidden = true;
    if (this.settingsPanel !== null) this.settingsPanel.hidden = false;
    this.refreshBindLabels('kbm');
    this.refreshBindLabels('pad');
    this.refreshSliders();
    this.selectTab(this.tab);
    this.updatePadStatus();
    if (this.padTimer === 0) this.padTimer = window.setInterval(() => this.updatePadStatus(), 500);
  }

  private closeSettings(): void {
    if (this.captureRow !== null) {
      this.cancelCapture(); // BACK during a capture aborts the capture, not the screen
      return;
    }
    const only = this.settingsOnlyClose;
    if (only !== null) {
      this.showMainPanel();
      this.hideMenu();
      only();
      return;
    }
    this.showMainPanel();
    // Bindings may have changed.
    this.renderControlsList();
    this.mainRing.set(this.mainRing.index, false);
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
    };
    const foot = el('div', 'hud-settings-foot');
    const pages = {} as Record<SettingsTab, HTMLElement>;
    const pageActions = {} as Record<SettingsTab, HTMLElement>;
    const tabItems = {} as Record<SettingsTab, FocusItem[]>;
    for (const tab of SETTINGS_TABS) {
      const b = built[tab.id];
      body.appendChild(b.page);
      foot.appendChild(b.actions);
      pages[tab.id] = b.page;
      pageActions[tab.id] = b.actions;
      tabItems[tab.id] = b.footer !== null ? [tabsItem, ...b.items, b.footer] : [tabsItem, ...b.items];
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
   * Graphics: the quality tier (low / high / ultra), a line about the selected one. A pick goes to
   * MenuOptions.onQualityChange, which runs the switch behind the loading screen.
   */
  private buildGraphicsPage(): PageBuild {
    const page = el('div', 'hud-settings-page');
    page.appendChild(el('div', 'hud-settings-device', t('settings.graphicsNote')));
    const hint = el('div', 'hud-settings-hint');
    const hints: Record<Quality, string> = { low: t(QUALITY_HINTS.low), high: t(QUALITY_HINTS.high), ultra: t(QUALITY_HINTS.ultra) };
    const quality = this.choiceRow<Quality>(
      t('settings.quality'),
      QUALITIES.map((q) => ({ value: q, label: t(`quality.${q}`) })),
      () => this.quality,
      (q) => {
        if (q === this.quality) return;
        this.quality = q;
        const opts = this.menuOptions;
        if (opts !== null && opts.onQualityChange) opts.onQualityChange(q);
      },
      (q) => (hint.textContent = hints[q]),
    );
    page.append(quality.row, hint);
    return { page, items: [quality.item], actions: el('div', 'hud-settings-actions'), footer: null };
  }

  /**
   * "Label   [A] [B] [C]": a segmented choice. Left / right step (no wrap: a quality switch is a
   * reload, ultra never jumps to low), accept steps with wrap, a click picks. `onShow` gets the
   * value after every refresh (a line about it).
   */
  private choiceRow<T>(
    label: string,
    options: ReadonlyArray<{ value: T; label: string }>,
    get: () => T,
    set: (v: T) => void,
    onShow?: (v: T) => void,
  ): { row: HTMLElement; item: FocusItem } {
    const row = el('div', 'hud-settings-row hud-choice-row');
    row.appendChild(el('span', 'hud-settings-label', label));
    const ctl = el('span', 'hud-settings-ctl hud-choice');
    const buttons = options.map((o) => button('hud-choice-opt', o.label));
    ctl.append(...buttons);
    row.appendChild(ctl);
    const index = (): number => Math.max(0, options.findIndex((o) => o.value === get()));
    const refresh = (): void => {
      const i = index();
      for (let k = 0; k < buttons.length; k++) {
        buttons[k].classList.toggle('hud-on', k === i);
        buttons[k].setAttribute('aria-pressed', String(k === i));
      }
      if (onShow) onShow(options[i].value);
    };
    const pick = (i: number): void => {
      set(options[i].value);
      refresh();
    };
    buttons.forEach((b, k) => b.addEventListener('click', () => pick(k)));
    const n = options.length;
    const item: FocusItem = {
      el: row,
      left: () => pick(Math.max(0, index() - 1)),
      right: () => pick(Math.min(n - 1, index() + 1)),
      accept: () => pick((index() + 1) % n),
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
    const item: FocusItem = { el: row, left: () => nudge(-1), right: () => nudge(1) };
    row.addEventListener('pointerdown', () => this.settingsRing.focusItem(item));
    this.refreshers.push(refresh);
    return { row, item };
  }

  private toggleRow(label: string, get: () => boolean, set: (v: boolean) => void): { row: HTMLElement; item: FocusItem } {
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
    return { row, item };
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
    this.settingsRing.use(this.tabItems[tab], 0);
    if (tab === 'pad') this.updatePadStatus();
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

/** up/down/left/right/accept on a focus ring; false when the action is not a focus action. */
function dispatchFocus(ring: FocusRing, action: MenuAction): boolean {
  switch (action) {
    case 'up':
      ring.move(-1);
      return true;
    case 'down':
      ring.move(1);
      return true;
    case 'left': {
      const it = ring.item;
      if (it !== null && it.left) it.left();
      return true;
    }
    case 'right': {
      const it = ring.item;
      if (it !== null && it.right) it.right();
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
 * Main menu keys. Space is deliberately NOT accept: it is the ball cam toggle, and the key that
 * starts the match is still held when the first tick samples (Enter / A play, as the hint says).
 */
function mainKeyAction(code: string): MenuAction | null {
  switch (code) {
    case 'Enter':
    case 'NumpadEnter':
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
    case 'KeyQ':
      return 'quality';
    case 'KeyM':
      return 'mode';
    case 'KeyO':
      return 'settings';
    case 'KeyN':
      return 'online';
    case 'Escape':
    case 'Backspace':
      return 'back';
    default:
      return null;
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

function controlRow(action: string, keys: string): HTMLElement {
  const row = el('div', 'hud-menu-control');
  row.append(el('span', 'hud-menu-control-action', action), el('span', 'hud-menu-control-keys', keys));
  return row;
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
