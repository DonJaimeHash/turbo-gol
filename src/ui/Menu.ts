/**
 * The front-end menus: the Tablero shell (plan §1.3-1.5) around a stack of screens per section.
 *
 * Sections (shell/sections.ts): JUGAR · ENTRENAMIENTO · GARAJE · CLASIFICACIÓN · PERFIL, each with a
 * root screen; every other screen is stacked on its section's root (Play hub, Casual, the lobbies...
 * on JUGAR's). Switching sections always lands on the new one's root (a section is a place, not a
 * history): the top bar's tabs on a PC or a TV (focus = selection), the rail of a phone held
 * sideways, the tabs of an upright phone, pad LB / RB, keyboard Q / E (a screen's own tabs first),
 * the account chip (PERFIL) and the wordmark (JUGAR). A section's root opened by a stacked screen
 * of another (Competitive's SIGN IN opens PERFIL) is a detour on top of it instead, so Back comes
 * back (backModel.ts stackAfterOpen). A screen that asks before it goes (Screen.leaveGuard: a
 * lobby) asks before any of those, or a crumb, takes the player off it.
 *
 * The shell, by layout class (device.ts layoutClass, `data-layout` on <html>; src/ui/styles/shell.css):
 * - the top bar (shell/topbar.ts): wordmark, sections, pills, account chip, Settings; on a stacked
 *   screen ‹ and the breadcrumbs, each crumb a way back;
 * - the rail (phone sideways) or the tab bar (upright), shell/rail.ts;
 * - the hint bar (shell/hintbar.ts): the last input's verbs (shell/hints.ts) and the source link
 *   (AGPL-3.0) with About; a TV keeps its pills there;
 * - pills (shell/pills.ts): the region with the connection, the running search (cancel from any
 *   section, and over Settings: a copy floats above them, `float`), "UPDATE TO PLAY";
 * - sheets (components/sheet.ts, `modal()`), toasts (components/toast.ts), the blocking "There's a
 *   new version" sheet (z 65, over Settings too) when the server refused this page.
 *
 * Back (backModel.ts menuBack): the sheet closes, else a field being edited stops editing, else the
 * screen's own back, else the stack pops, else another section goes to JUGAR, else JUGAR's root
 * asks "Leave Turbogol?" (MenuHost.confirmLeave; the system Back reaches it through the Game).
 *
 * Focus (src/ui/nav.ts): zones top bar, stage, footer and the phone's tabs, the rail a side zone (◀
 * from the stage); ↑ from the stage lands on the active section (or ‹), ↓ from the bar on the
 * stage's remembered control. The last focus is remembered per screen (FocusMemory, by element or
 * `data-key`); `data-autofocus` counts on a first visit only. Shortcuts (`MenuCommand`): Q / E, pad
 * LB / RB and LT / RT, keyboard X / pad Y cancel the search (over Settings too), pad Start opens
 * Settings, pad X / Delete the screen's context action.
 *
 * Touch mode (`tg-touch` on <html>): no focus rings, nothing focused by itself, and a tap that began
 * before a screen or a sheet came up (or within TAP_GUARD_MS after) presses nothing on it (on the
 * rail and the top bar: after a stacked screen came or went and moved their items).
 *
 * The Game implements MenuHost (what the menus can ask of it) and calls show() / hide() / action();
 * the menu never touches the sim or the renderer. Styling: src/ui/styles/ (`mn-`) and menu.css.
 */
import './menu.css';
import './styles/index.css';
import { h, setChildren } from './dom';
import { FocusMemory, FocusNav, isEditable, isEditing, navKey, setEditing } from './nav';
import type { NavDir, NavZone } from './nav';
import { finePointer, resetPageZoom, tapGuarded } from './device';
import type { InputKind } from './device';
import { rankBadge, tierById } from './badges';
import { regionName, tierName } from './names';
import { t } from '../i18n';
import type { AccountClient } from '../net/AccountClient';
import type { LobbyClient } from '../net/LobbyClient';
import type { TrainingRecordsView } from '../game/trainingStore';
import type { ExperimentalStore } from '../game/experimentalStore';
import type { PopulationAnswer, RegionId } from '../net/account';
import { REGIONS, isRegion } from '../net/account';
import type { QueueResult } from '../net/protocol';
import type { QueueResultP2p } from '../net/p2p/protocol';
import type { GameMode } from '../sim/constants';
import type { Difficulty, SettingsTab } from '../render/Hud';
import type { ThemeId } from '../render/theme';
import type { ActionId, Device } from '../input/bindings';
import { DISCORD_URL, GAME_NAME, LICENSE_NAME, SOURCE_URL, STORAGE_PREFIX } from '../brand';
import { hashValue } from '../render/hashFlags';
import { menuBack, stackAfterOpen } from './backModel';
import { HOME_SECTION, sectionDef, stepSection } from './shell/sections';
import type { SectionId } from './shell/sections';
import { hintItems } from './shell/hints';
import { TopBar } from './shell/topbar';
import { SectionList } from './shell/rail';
import { HintBar } from './shell/hintbar';
import { RegionPill, SearchPill, updatePill } from './shell/pills';
import type { RegionPillState } from './shell/pills';
import { sheetBox } from './components/sheet';
import type { SheetSpec } from './components/sheet';
import { Toasts } from './components/toast';
import { icon } from './components/icons';
import { fitAll, uiFitReport } from './fit';
import type { SceneCover } from '../render/quality';

export type SearchKind = 'casual' | 'ranked';

export interface SearchRequest {
  kind: SearchKind;
  modes: GameMode[];
  /** null = automatic (the continent of the connection). */
  region: RegionId | null;
  /** Casual only: a P2P room (default) or a server match. Ranked is always the server. */
  net: 'p2p' | 'server';
}

export interface SearchView {
  active: boolean;
  kind: SearchKind | null;
  modes: GameMode[];
  /** Status line ('Buscando partido... (2 esperando)', 'Conectando...'). */
  text: string;
  /** performance.now() when the search started. */
  since: number;
  /** The last failure (shown once as a toast), null when none. */
  error: string | null;
  /** That failure is the server refusing this page's version (426 reload_required): reload to play online. */
  reload?: boolean;
}

export interface MenuConfig {
  regions: ReadonlyArray<{ id: RegionId; name: string }>;
  autoRegion: string;
  oauth: string[];
  online: boolean;
}

/** What the menus see of the experimental features (Settings > Experimental). */
export interface ExperimentalMenuView {
  /** Signed in with the switch on: experimental free play and a lobby host's rules row are offered. */
  readonly unlocked: boolean;
  /** The player's presets (the built-ins only for a guest) and the one picked last (lastUsed). */
  readonly store: ExperimentalStore;
}

/** What the menus need from the Game. */
export interface MenuHost {
  readonly accounts: AccountClient;
  readonly lobby: LobbyClient;
  /** Training records of the current player (guest: this browser; account: synced with the server). */
  readonly training: TrainingRecordsView;
  readonly experimental: ExperimentalMenuView;
  config(): Promise<MenuConfig>;
  /** The guest name (online as a guest) and its setter. */
  guestName(): string;
  setGuestName(name: string): void;
  /** A Bearer for API calls (account or guest). */
  bearer(): Promise<string>;
  readonly mode: GameMode;
  readonly difficulty: Difficulty;
  /**
   * The stadium theme (saved with the prefs). setTheme switches behind the loading screen
   * (Game.switchTheme: a re-bake or a cached sky, never a recompile); `theme` reads the new one at once.
   */
  readonly theme: ThemeId;
  setTheme(id: ThemeId): void;
  /** An offline friendly match against the bots. */
  playFriendly(mode: GameMode, difficulty: Difficulty): void;
  /**
   * Free play or a shot pack; `opts.rules` (a preset id) makes free play experimental for an
   * unlocked player (packs always run stock physics).
   */
  startTraining(id: string, opts?: { rules?: string }): void;
  search(req: SearchRequest): void;
  cancelSearch(): void;
  searchView(): SearchView;
  /** A custom lobby started: join this member's match. */
  playLobbyMatch(result: QueueResult | QueueResultP2p): void;
  /**
   * The settings screen (the Hud's: controls, camera, gameplay, audio, graphics, experimental),
   * on `opts.tab` when given; `onClose` when it is left. The menus call it through Menu.openSettings.
   */
  openSettings(onClose: () => void, opts?: { tab?: SettingsTab }): void;
  /**
   * Back on JUGAR's root: "Leave Turbogol?" (the Game holds the system Back guard). `systemBack`:
   * the system's own Back asked (another one leaves); else Esc, pad B or ‹ (another of those closes
   * the sheet: its LEAVE button is the way out).
   */
  confirmLeave(systemBack?: boolean): void;
  /** The key / button name of an action's live binding on `device`, for a hint text ('—' unbound). */
  keyLabel(action: ActionId, device: Device): string;
  /**
   * What the menus leave of the 3D scene (Game.setMenuCover): 'partial' while they are up (with
   * `covered`, the share of a touch screen they hide: cover.ts), 'opaque' under a modal, 'none'
   * once hidden. The Game draws the scene at the menus' rate or holds one frame.
   */
  setMenuCover(level: SceneCover, covered?: number): void;
  /** One line about the build (WebGPU / RocketSim version), shown in About. */
  readonly info: string;
}

export interface MenuPrefs {
  region: RegionId | null;
  casualModes: GameMode[];
  rankedModes: GameMode[];
  net: 'p2p' | 'server';
  leaderboardPlaylist: GameMode;
}

const PREFS_KEY = STORAGE_PREFIX + 'menu.v1';
const POPULATION_EVERY_MS = 10_000;
/** A focus this soon after a pointer lifted is that pointer's (a tap focuses between its up and its click). */
const POINTER_FOCUS_MS = 150;
const TICK_MS = 250;

/** Touch mode: the last input used was a finger (`tg-touch` on <html>, set by src/input/TouchControls.ts). */
function touchMode(): boolean {
  return document.documentElement.classList.contains('tg-touch');
}

/** The last input (device.ts, `data-input` on <html>). */
function lastInput(): InputKind {
  const v = document.documentElement.dataset.input;
  return v === 'pad' || v === 'remote' || v === 'keyboard' || v === 'touch' ? v : 'mouse';
}

/** `#ui=<screen>` and `window.__uiFit` exist in development and in a VITE_UI_FIT=1 build only (scripts/ui-fit.mjs). */
const UI_FIT = import.meta.env.DEV || import.meta.env.VITE_UI_FIT === '1';

function loadPrefs(): MenuPrefs {
  const d: MenuPrefs = { region: null, casualModes: ['2v2'], rankedModes: ['2v2'], net: 'p2p', leaderboardPlaylist: '2v2' };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return d;
    const o = JSON.parse(raw) as Partial<MenuPrefs>;
    const modes = (v: unknown): GameMode[] | null => (Array.isArray(v) && v.length > 0 && v.every((m) => m === '1v1' || m === '2v2' || m === '3v3') ? (v as GameMode[]) : null);
    return {
      region: isRegion(o.region) ? o.region : null,
      casualModes: modes(o.casualModes) ?? d.casualModes,
      rankedModes: modes(o.rankedModes) ?? d.rankedModes,
      net: o.net === 'server' ? 'server' : 'p2p',
      leaderboardPlaylist: o.leaderboardPlaylist === '1v1' || o.leaderboardPlaylist === '3v3' ? o.leaderboardPlaylist : '2v2',
    };
  } catch {
    return d;
  }
}

/**
 * What the menus take besides the arrows, accept and back (`Menu.action`): 'prev' / 'next' (pad LB /
 * RB, keyboard Q / E without tabs of the screen's own: the sections), 'tabPrev' / 'tabNext' (pad LT /
 * RT, keyboard Q / E: a screen's own tabs), 'cancel' (pad Y, keyboard X: cancel the search), 'menu'
 * (pad Start: the settings), 'context' (pad X, Delete: the screen's context action).
 */
export type MenuCommand = 'prev' | 'next' | 'tabPrev' | 'tabNext' | 'cancel' | 'menu' | 'context';

/** One screen of the stack. `el` is built once; show / hide / tick are optional. */
export interface Screen {
  readonly id: string;
  /** Its breadcrumb. */
  readonly title: string;
  readonly el: HTMLElement;
  show?(): void;
  hide?(): void;
  /** Every TICK_MS while the screen is on top and the menu is visible. */
  tick?(now: number): void;
  /** Esc / B on this screen: return true to swallow it (e.g. a sub-view closes first). */
  back?(): boolean;
  /** A shortcut (MenuCommand) on this screen: return true when it handled it (its tabs, its context action). */
  command?(c: MenuCommand): boolean;
  /**
   * The shell is about to take the player off this screen without its own Back (a section, a
   * crumb, the wordmark, the chip, the search pill): a function that asks first and calls `go`
   * once the player agrees (after its sheet closed), or null to let them go. A lobby asks
   * "Leave the lobby?" (a member who just walked away would hold the next start for everyone).
   */
  leaveGuard?(): ((go: () => void) => void) | null;
}

export type ScreenFactory = (menu: Menu) => Screen;

type ModalSpec = SheetSpec;

/** How a section switch keeps the focus: on the bar that made it, or the new section's own. */
type SwitchFocus = 'keep' | 'auto';

export class Menu {
  readonly host: MenuHost;
  readonly root: HTMLElement;
  prefs: MenuPrefs;
  /** Last /api/population answer for the selected region (null before the first, or offline). */
  population: PopulationAnswer | null = null;
  cfg: MenuConfig | null = null;

  private readonly stage: HTMLElement;
  private readonly topBar: TopBar;
  private readonly rail: SectionList;
  private readonly tabbar: SectionList;
  private readonly hintBar: HintBar;
  private readonly pills: HTMLElement;
  private readonly regionPill: RegionPill;
  private readonly searchPill: SearchPill;
  private readonly updateBtn: HTMLButtonElement;
  /** The search pill over the Hud's settings screen (outside .mn: above z 60), pointer only. */
  private readonly float: HTMLElement;
  private readonly floatPill: SearchPill;
  private readonly toasts: Toasts;
  private readonly modalLayer: HTMLElement;
  private readonly screens = new Map<string, Screen>();
  private readonly factories = new Map<string, ScreenFactory>();
  private section: SectionId = HOME_SECTION;
  /** The screens of the section shown, its root first. */
  private stack: Screen[] = [];
  private readonly nav: FocusNav;
  /** Last focus: 'last:<screen>' anywhere while that screen was on top, 'stage:<screen>' on its stage, '<zone>' in the bars. */
  private readonly memory = new FocusMemory<HTMLElement>();
  private modalEl: HTMLElement | null = null;
  private modalDismiss: (() => void) | null = null;
  private modalOnClose: (() => void) | null = null;
  /** What had the focus when the modal opened: it gets it back when the modal closes. */
  private modalOpener: HTMLElement | null = null;
  /** The sheet up is not dismissable (Back does nothing). */
  private modalBlocking = false;
  /** performance.now() of the last screen or modal mounted (or modal closed): the tap guard's reference. */
  private mountedAt = -Infinity;
  /** performance.now() when the rail and the top bar last changed shape (a stacked screen came or went: ‹ and the crumbs). */
  private chromeMovedAt = -Infinity;
  private chromeStacked = false;
  /** The last finger / pen down and up (performance.now()), for the tap guard. */
  private touchDownAt = -Infinity;
  private touchUpAt = -Infinity;
  /**
   * A pointer is down (a mouse button), or one just lifted (a finger's tap focuses between its up
   * and its click): the focus it gives a section tab is no selection, its click is (and the tap
   * guard sees that one).
   */
  private pressing = false;
  private pointerUpAt = -Infinity;
  /** A keydown the fields' capture listener already handled (onKey leaves it). */
  private keyDone: Event | null = null;
  /**
   * Keys first pressed while the menus had them (onKey; keyup forgets them). A key's own repeat
   * of any other (an arrow still steering at the final whistle) moves no focus, as the pad's
   * repeat after a hand-off (Input.resetMenuRepeat).
   */
  private readonly keysDown = new Set<string>();
  private timer = 0;
  private popAt = 0;
  /** The last population poll failed (the region pill offers to retry). */
  private popFailed = false;
  private lastError: string | null = null;
  private visibleNow = false;
  private searching = false;
  /** Settings opened from the menus are up (Menu.openSettings). */
  private settingsOpen = false;
  /** Settings just closed, in this task (onKey: the closing key is theirs). */
  private settingsClosing = false;
  /** The server refused this page's version: the update sheet once, then the pill. */
  private reloadNeeded = false;
  private reloadAsked = false;
  private firstShow = true;
  private fitQueued = false;
  /** What the account chip shows (refreshChrome rebuilds it on a change only). */
  private chipKey = '';

  constructor(host: MenuHost, container: HTMLElement) {
    this.host = host;
    this.prefs = loadPrefs();
    this.topBar = new TopBar({
      brand: () => this.selectSection(HOME_SECTION, 'click'),
      back: () => this.backOrLeave(),
      crumb: (i) => this.popTo(i),
      sectionFocus: (id) => this.selectSection(id, 'focus'),
      sectionClick: (id) => this.selectSection(id, 'click'),
      step: (d) => this.stepSection(d),
      chip: () => this.selectSection('profile', 'click'),
      settings: () => this.openSettings(),
    });
    const listHandlers = {
      focus: (id: SectionId) => this.selectSection(id, 'focus'),
      click: (id: SectionId) => this.selectSection(id, 'click'),
      back: () => this.backOrLeave(),
      about: () => this.openAbout(),
    };
    this.rail = new SectionList('rail', listHandlers);
    this.tabbar = new SectionList('tabbar', listHandlers);
    this.hintBar = new HintBar(() => this.openAbout());
    this.regionPill = new RegionPill(() => this.onRegionPill());
    this.searchPill = new SearchPill(() => this.openSearchScreen(), () => this.cancelSearch(), true);
    this.updateBtn = updatePill(() => this.openUpdateSheet());
    this.pills = h('div.mn-pill-row', null, this.searchPill.el, this.updateBtn, this.regionPill.el);
    this.topBar.pills.appendChild(this.pills);
    this.stage = h('main.mn-stage');
    this.toasts = new Toasts();
    this.modalLayer = h('div.mn-modal-layer', { hidden: true });
    this.root = h('div.mn', { hidden: true }, this.rail.el, this.topBar.el, this.stage, this.hintBar.el, this.tabbar.el, this.toasts.el, this.modalLayer);
    this.floatPill = new SearchPill(() => undefined, () => this.cancelSearch(), false);
    this.float = h('div.mn-float', { hidden: true }, this.floatPill.el);
    // RMB is bindable in game: no context menu over the menus.
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    container.appendChild(this.root);
    container.appendChild(this.float);
    this.nav = new FocusNav(() => this.zones(), {
      remembered: (zone, targets) => this.zoneEntry(zone, targets),
      restore: () => this.restoreFocus(),
      onFocus: (el, zone) => this.noteFocus(el, zone),
    });
    this.nav.install(this.root);
    // Capture, before a field's own Enter (custom.ts JOIN, profile.ts sign-in): the fields' modes.
    this.root.addEventListener('keydown', (e) => this.onFieldKey(e), true);
    this.installTapGuard();
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('keyup', (e) => this.keysDown.delete(e.code));
    window.addEventListener('resize', () => this.queueFit());
    // The hints and the pills' place follow the last input and the layout class (device.ts); the
    // other classes of <html> (super low, fullscreen...) change nothing here.
    const html = document.documentElement;
    let shellKey = '';
    new MutationObserver(() => {
      const key = [html.dataset.input, html.dataset.layout, html.classList.contains('tg-touch'), html.classList.contains('tg-tv')].join();
      if (key === shellKey) return;
      shellKey = key;
      this.renderHints();
      this.placePills();
      this.queueFit();
    }).observe(html, { attributes: true, attributeFilter: ['data-input', 'data-layout', 'class'] });
    void document.fonts?.ready.then(() => this.queueFit());
    host.accounts.subscribe(() => this.refreshChrome());
    this.loadConfig();
    if (UI_FIT) (window as unknown as { __uiFit: () => unknown }).__uiFit = () => uiFitReport(this.root, this.top()?.id ?? '');
  }

  register(id: string, f: ScreenFactory): void {
    this.factories.set(id, f);
  }

  private screen(id: string): Screen {
    let s = this.screens.get(id);
    if (!s) {
      const f = this.factories.get(id);
      if (!f) throw new Error('Menu: unknown screen ' + id);
      s = f(this);
      s.el.classList.add('mn-screen');
      this.screens.set(id, s);
    }
    return s;
  }

  get visible(): boolean {
    return this.visibleNow;
  }

  top(): Screen | null {
    return this.stack.at(-1) ?? null;
  }

  savePrefs(): void {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs));
    } catch {
      /* storage disabled */
    }
  }

  /** The region the matchmaker uses: the chosen one, else the automatic one. */
  get regionLabel(): string {
    const id = this.prefs.region ?? (isRegion(this.cfg?.autoRegion) ? this.cfg?.autoRegion : null);
    const r = REGIONS.find((x) => x.id === id);
    if (this.prefs.region !== null) return r ? regionName(r.id) : '?';
    return r ? t('menu.regionAutoNamed', { region: regionName(r.id) }) : t('menu.regionAuto');
  }

  /** Show the menus (the screen on top stays: back from a match lands where the search started). */
  show(screenId?: string): void {
    if (this.stack.length === 0) this.stack = [this.screen(sectionDef(this.section).root)];
    const ui = this.firstShow && UI_FIT ? hashValue(location.hash, 'ui') : null;
    this.firstShow = false;
    if (ui !== null && this.factories.has(ui)) screenId = ui; // #ui=<screen>: scripts/ui-fit.mjs
    if (screenId !== undefined) this.open(screenId, true);
    this.root.hidden = false;
    this.root.parentElement?.classList.add('mn-open'); // menu.css hides the in-game HUD behind it
    this.visibleNow = true;
    this.mount();
    this.placePills();
    if (this.timer === 0) this.timer = window.setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  hide(): void {
    this.root.hidden = true;
    this.float.hidden = true;
    this.root.parentElement?.classList.remove('mn-open');
    this.visibleNow = false;
    resetPageZoom(); // a pinch in the menus does not carry into the match (its controls would sit off screen)
    this.keysDown.clear(); // a key held into the match and out again is no menu key
    this.closeModal();
    if (this.timer !== 0) {
      window.clearInterval(this.timer);
      this.timer = 0;
    }
    this.top()?.hide?.();
  }

  /**
   * Open screen `id` (backModel.ts stackAfterOpen): a section's root opens that section (at its
   * root), but from a stacked screen of another section it is a detour on top of it (Competitive's
   * SIGN IN opens PERFIL: Back comes back to Competitive); another screen is stacked on its
   * section's root (brought back to the top when already in the stack; `reset`: right on the root,
   * whatever was stacked).
   */
  open(id: string, reset = false): void {
    const next = stackAfterOpen({ section: this.section, stack: this.stack.map((s) => s.id) }, id, reset);
    const stack = next.stack.map((x) => this.screen(x));
    this.top()?.hide?.();
    this.section = next.section;
    this.stack = stack;
    if (this.visibleNow) this.mount();
  }

  /** The guard (Screen.leaveGuard) of the first screen above depth `keep` that asks before it goes, null when none does. */
  private leaveGuard(keep: number): ((go: () => void) => void) | null {
    for (let i = this.stack.length - 1; i >= keep; i--) {
      const g = this.stack[i].leaveGuard?.() ?? null;
      if (g !== null) return g;
    }
    return null;
  }

  /** Replace the top screen (a form that turns into its result). */
  replace(id: string): void {
    this.top()?.hide?.();
    if (this.stack.length > 1) this.stack.pop();
    this.open(id);
  }

  /** Back to the `i`-th screen of the stack (0: the section's root): a breadcrumb (a lobby above it asks first). */
  private popTo(i: number): void {
    if (i < 0 || i >= this.stack.length - 1) return;
    const guard = this.leaveGuard(i + 1);
    if (guard !== null) {
      guard(() => this.popTo(i));
      return;
    }
    this.top()?.hide?.();
    this.stack.length = i + 1;
    this.mount();
  }

  /**
   * Show section `id` at its root. `how`: 'focus' (its tab got the focus from the arrows or Tab:
   * the focus stays on the tab; a pointer's focus is not one, its click is), 'click' (a click or a
   * tap: on the section shown, back to its root), 'command' (LB / RB, Q / E: the focus follows to
   * the new tab when it was on the bar, else the new section's own).
   * A screen that asks before it goes (a lobby: Screen.leaveGuard) asks first.
   */
  private selectSection(id: SectionId, how: 'focus' | 'click' | 'command'): void {
    if (!this.visibleNow || this.modalEl !== null || (how === 'focus' && (this.pressing || performance.now() - this.pointerUpAt < POINTER_FOCUS_MS))) return;
    if (id === this.section) {
      if (how !== 'focus' && this.stack.length > 1) this.popTo(0);
      return;
    }
    const guard = this.leaveGuard(0);
    if (guard !== null) {
      // A tab that took the focus is no switch yet: the focus goes back to the section shown, so
      // STAY returns it there (not to that tab, which would ask again), and LEAVE moves it on.
      if (how === 'focus') this.focusSectionEntry();
      guard(() => this.selectSection(id, how === 'focus' ? 'command' : how));
      return;
    }
    const onBar = this.onSectionTab(document.activeElement);
    this.top()?.hide?.();
    this.section = id;
    this.stack = [this.screen(sectionDef(id).root)];
    // From the bar the focus stays on it: on the tab that took it, or (LB / RB, Q / E, Esc's way
    // to JUGAR) on the new one; the stage's first control would pull a remote off the bar.
    const focus: SwitchFocus = how === 'focus' || onBar ? 'keep' : 'auto';
    this.mount(focus);
    if (how === 'command' && onBar && !touchMode()) this.focusSectionEntry();
  }

  /** The section before / after (pad LB / RB, Q / E without a screen's own tabs, the bar's ‹ ›). */
  private stepSection(d: -1 | 1): boolean {
    const next = stepSection(this.section, d);
    if (next === null) return false;
    this.selectSection(next, 'command');
    return true;
  }

  /** A section tab (the bar, the rail, the tabs) has `el`. */
  private onSectionTab(el: Element | null): boolean {
    return el instanceof HTMLElement && el.closest('.mn-secs, .mn-sl-items') !== null && this.root.contains(el);
  }

  /**
   * Esc / B / ‹ / the system Back (Game.onSystemBack), in backModel.ts's order. False on JUGAR's
   * root with no sheet: the caller asks to leave (backOrLeave here, confirmLeave in the Game).
   */
  back(): boolean {
    const a = document.activeElement;
    const editing = a instanceof HTMLElement && isEditing(a) && this.root.contains(a);
    // Touch skips the field step (Android's first Back already hid the keyboard): editing just ends.
    if (editing && touchMode()) {
      setEditing(a, false);
      a.blur();
    }
    const top = this.top();
    let screenBack = typeof top?.back === 'function';
    for (;;) {
      const step = menuBack({
        sheet: this.modalEl === null ? 'none' : this.modalDismiss !== null && !this.modalBlocking ? 'dismissable' : 'blocking',
        editing: editing && !touchMode(),
        touch: touchMode(),
        screenBack,
        depth: this.stack.length,
        section: this.section,
      });
      switch (step) {
        case 'closeSheet':
          this.modalDismiss?.();
          return true;
        case 'blocked':
          return true;
        case 'stopEditing':
          setEditing(a as HTMLElement, false);
          return true;
        case 'screen':
          if (top?.back?.()) return true;
          screenBack = false;
          continue;
        case 'pop':
          this.top()?.hide?.();
          this.stack.pop();
          this.mount();
          return true;
        case 'home':
          this.selectSection(HOME_SECTION, 'command');
          return true;
        default:
          return false;
      }
    }
  }

  /** Back from a key, the pad or ‹: on JUGAR's root it asks to leave, as the system Back does. */
  private backOrLeave(): void {
    if (!this.back() && this.modalEl === null) this.host.confirmLeave(false);
  }

  private mount(focus: SwitchFocus = 'auto'): void {
    const top = this.top();
    if (!top) return;
    this.mountedAt = performance.now();
    this.nav.reset();
    setChildren(this.stage, top.el);
    // A screen opens at its top. With the keyboard / pad the first control's focus scrolls there
    // (autoFocus); touch mode and a switch from the bar focus nothing on the stage.
    if (touchMode() || focus === 'keep') this.stage.scrollTop = 0;
    this.renderChrome();
    top.show?.();
    this.refreshChrome();
    this.queueFit();
    if (focus === 'auto') this.autoFocus();
  }

  /** The bars for the section and the stack shown: tabs, rail, crumbs, stacked or not, hints. */
  private renderChrome(): void {
    const stacked = this.stack.length > 1;
    if (stacked !== this.chromeStacked) {
      this.chromeStacked = stacked;
      this.chromeMovedAt = performance.now();
    }
    this.root.classList.toggle('mn-stacked', stacked);
    this.topBar.setStacked(stacked);
    this.rail.setStacked(stacked);
    this.topBar.setSection(this.section);
    this.rail.setSection(this.section);
    this.tabbar.setSection(this.section);
    if (stacked) this.topBar.setCrumbs([t(sectionDef(this.section).label), ...this.stack.slice(1).map((s) => s.title)]);
    this.renderHints();
  }

  /**
   * The hint bar for the last input and the screen shown (shell/hints.ts); also every tick, as a
   * screen's own tabs come and go (Profile's sign-in forms after signing in). Beside a screen's own
   * tabs Q / E step those: the Q / E keycaps by the section strip step aside (`mn-own-tabs`).
   */
  private renderHints(): void {
    const ownTabs = this.ownTabs() !== null;
    this.root.classList.toggle('mn-own-tabs', ownTabs);
    this.hintBar.render(hintItems(lastInput(), { searching: this.searching, stacked: this.stack.length > 1, ownTabs }));
  }

  /** The tabs of the screen on top (`.mn-tabs` of `.mn-tab`, the picked one `.mn-tab-on`), null without two of them. */
  private ownTabs(): { strip: HTMLElement; tabs: HTMLElement[]; on: number } | null {
    const strip = this.top()?.el.querySelector<HTMLElement>('.mn-tabs') ?? null;
    if (strip === null) return null;
    const tabs = Array.from(strip.querySelectorAll<HTMLElement>('.mn-tab'));
    const on = tabs.findIndex((b) => b.classList.contains('mn-tab-on'));
    return on < 0 || tabs.length < 2 ? null : { strip, tabs, on };
  }

  /** The pills: the top bar's right side, or the hint bar on a TV (its top bar has no room at 3 m). */
  private placePills(): void {
    const tv = document.documentElement.dataset.layout === 'tv';
    const want = tv ? this.hintBar.mid : this.topBar.pills;
    if (this.pills.parentElement !== want) want.appendChild(this.pills);
  }

  /** data-fit (fit.ts) on the next frame, once per frame. */
  private queueFit(): void {
    if (this.fitQueued) return;
    this.fitQueued = true;
    requestAnimationFrame(() => {
      this.fitQueued = false;
      if (this.visibleNow) fitAll(this.root);
    });
  }

  /** Put the focus back on the current screen when nothing has it (after the screen rebuilt its content). */
  refocus(): void {
    this.autoFocus(true);
  }

  /**
   * On the next frame, focus the modal's first control, or the screen's remembered one
   * (restoreFocus; `ifNone`: only when nothing there has the focus), where the keyboard and the
   * controller go on from. Not in touch mode: a focused text field would pop up the phone's keyboard
   * and a finger needs no focus ring. The controller still gets one there: FocusNav starts on its
   * first press (and a pad press leaves touch mode).
   */
  private autoFocus(ifNone = false): void {
    requestAnimationFrame(() => {
      if (touchMode()) return;
      if (ifNone && this.nav.current !== null) return;
      this.restoreFocus();
    });
  }

  /**
   * The modal's first control (its `data-autofocus` one first); else the control focused last on
   * the screen on top (anywhere, then on its stage, by element or `data-key`); else its
   * `data-autofocus` or first one (a first visit); else, on a stage with nothing to focus (GARAJE),
   * the active section. Without a fine pointer a text field is never the first, remembered or not
   * (the system keyboard would come up).
   */
  private restoreFocus(): void {
    const skipFields = !finePointer();
    if (this.modalEl !== null) {
      this.nav.first(skipFields);
      return;
    }
    const top = this.top();
    if (top === null) return;
    const targets = skipFields ? this.nav.targets().filter((t) => !isEditable(t)) : this.nav.targets();
    const el = this.memory.recall('last:' + top.id, targets, navKey) ?? this.memory.recall('stage:' + top.id, targets, navKey);
    if (el !== null) this.nav.focus(el);
    else this.nav.first(skipFields);
    if (this.nav.current === null) this.focusSectionEntry();
  }

  /** The active section's tab (or ‹ on a stacked screen) in whichever bar this layout shows. */
  private focusSectionEntry(): void {
    const entry = this.nav.targets().find((e) => e.hasAttribute('data-nav-entry') && !this.stage.contains(e));
    if (entry !== undefined) this.nav.focus(entry);
  }

  /** The focus zones (nav.ts): a modal alone, else the rail (a side zone), the top bar, the stage, the footer and the tabs. */
  private zones(): NavZone[] {
    if (this.modalEl !== null) return [{ name: 'modal', el: this.modalEl, main: true }];
    return [
      { name: 'rail', el: this.rail.el, side: true },
      { name: 'top', el: this.topBar.el },
      { name: 'stage', el: this.stage, main: true },
      { name: 'bottom', el: this.hintBar.el },
      { name: 'tabs', el: this.tabbar.el },
    ];
  }

  /**
   * Where an arrow lands entering `zone`: the stage's control focused last on this screen; a bar's
   * active section (or ‹), so ↑ from the stage goes to the section shown; else the zone's last.
   */
  private zoneEntry(zone: NavZone, targets: readonly HTMLElement[]): HTMLElement | null {
    if (zone.name === 'stage') return this.memory.recall('stage:' + (this.top()?.id ?? ''), targets, navKey);
    if (zone.name !== 'bottom') {
      const entry = targets.find((e) => e.hasAttribute('data-nav-entry'));
      if (entry !== undefined) return entry;
    }
    return this.memory.recall(zone.name, targets, navKey);
  }

  /** A menu control got the focus: remember it for the screen on top and for its zone (a section tab is the bar's, not the screen's). */
  private noteFocus(el: HTMLElement, zone: NavZone | null): void {
    const top = this.top();
    if (zone === null || zone.name === 'modal' || top === null) return;
    const key = navKey(el);
    if (!this.onSectionTab(el)) this.memory.remember('last:' + top.id, el, key);
    this.memory.remember(zone.name === 'stage' ? 'stage:' + top.id : zone.name, el, key);
  }

  /**
   * Touch: a tap whose finger went down before the last screen or modal was mounted, or within
   * TAP_GUARD_MS after (device.ts), is no click on it (a double tap on a tile would press what the
   * next screen has under it; a modal that came up under a finger). The bars stay put across a
   * mount, so a second tap on them is meant, but for the rail and the top bar when a stacked
   * screen came or went (their ‹ and crumbs moved the items: a double tap on a rail item would
   * press the one that slid under the finger). Trusted pointer clicks only: Enter / Space and the
   * controller's A (FocusNav.accept: el.click()) always go through.
   */
  private installTapGuard(): void {
    const finger = (e: Event): boolean => {
      const p = (e as PointerEvent).pointerType;
      return p === 'touch' || p === 'pen';
    };
    this.root.addEventListener('pointerdown', (e) => {
      this.pressing = true;
      if (finger(e)) this.touchDownAt = performance.now();
    }, true);
    for (const type of ['pointerup', 'pointercancel']) {
      window.addEventListener(type, () => {
        this.pressing = false;
        this.pointerUpAt = performance.now();
      }, true);
    }
    this.root.addEventListener('pointerup', (e) => {
      if (finger(e)) this.touchUpAt = performance.now();
    }, true);
    this.root.addEventListener(
      'click',
      (e) => {
        if (!e.isTrusted || (e as MouseEvent).detail === 0) return; // a key's or FocusNav's click
        const target = e.target;
        const bar = target instanceof Element ? target.closest('.mn-rail, .mn-tabbar, .mn-top') : null;
        const since = bar === null ? this.mountedAt : bar.classList.contains('mn-tabbar') ? -Infinity : this.chromeMovedAt;
        const p = (e as PointerEvent).pointerType;
        // Older engines' clicks are plain MouseEvents: a finger's when one just lifted.
        const byFinger = p === 'touch' || p === 'pen' || (p === undefined && performance.now() - this.touchUpAt < 800);
        if (byFinger && tapGuarded(this.touchDownAt, since)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          // Nor does it leave the focus there (a later pad press would start from that control).
          const hit = target instanceof Element ? target.closest('[data-nav]') : null;
          if (hit instanceof HTMLElement && hit === document.activeElement) hit.blur();
        }
      },
      true,
    );
  }

  // ---- input -----------------------------------------------------------------------------------

  /**
   * A text field's keys, in the capture phase (before the field's own listeners and the window's).
   * Navigation mode (reached with the arrows): Enter / OK starts editing (and is no submit); a
   * character, Backspace or Delete starts it and types. Editing: Enter stops it (the field's own
   * Enter still runs: JOIN, SIGN IN), Esc stops it and is no Back, but in a modal, where Esc closes
   * the modal (`back`'s order, as pad B and the system Back). The arrows are onKey's.
   */
  private onFieldKey(e: KeyboardEvent): void {
    const el = e.target;
    if (!(el instanceof HTMLElement) || !isEditable(el) || !el.hasAttribute('data-nav')) return;
    if (e.ctrlKey || e.metaKey || e.altKey || typeof e.key !== 'string') return; // Chrome's autofill sends keydowns without a key
    if (isEditing(el)) {
      if (e.key === 'Enter') setEditing(el, false);
      else if (e.key === 'Escape' && this.modalEl === null) {
        e.preventDefault();
        setEditing(el, false);
        this.keyDone = e;
      }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      setEditing(el, true);
      this.keyDone = e;
    } else if (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete') setEditing(el, true);
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.visibleNow || this.root.hidden) return;
    if (e === this.keyDone) {
      this.keyDone = null;
      return;
    }
    if (this.settingsClosing) return;
    if (this.settingsUp()) {
      // The Hud's settings screen owns the keys; X cancels the search behind it (not in its text fields).
      if (e.code === 'KeyX' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && !isEditable(document.activeElement) && this.cancelSearch()) e.preventDefault();
      return;
    }
    if (e.altKey) return; // Alt + ← is the browser's Back: the system Back goes back (BackGuard), the focus stays
    if (!e.repeat && typeof e.code === 'string') this.keysDown.add(e.code);
    const active = document.activeElement;
    const field = isEditable(active); // a text field's keys are its own, but for the arrows in navigation mode
    const editing = field && isEditing(active);
    const plain = !e.ctrlKey && !e.metaKey;
    let dir: NavDir | null = null;
    switch (e.code) {
      case 'ArrowUp':
        dir = 'up';
        break;
      case 'ArrowDown':
        dir = 'down';
        break;
      case 'ArrowLeft':
        if (!editing) dir = 'left';
        break;
      case 'ArrowRight':
        if (!editing) dir = 'right';
        break;
      case 'Escape':
        e.preventDefault();
        if (!e.repeat) this.backOrLeave();
        return;
      case 'Backspace':
        if (!field) {
          e.preventDefault();
          if (!e.repeat) this.backOrLeave();
        }
        return;
      // Shortcuts (MenuCommand), never while a text field has the focus (they are letters there).
      case 'KeyQ':
      case 'KeyE':
        if (field || !plain || e.repeat) return;
        e.preventDefault();
        this.tabOrSection(e.code === 'KeyQ' ? -1 : 1);
        return;
      case 'KeyX':
        if (field || !plain || e.repeat) return;
        e.preventDefault();
        this.command('cancel');
        return;
      case 'Delete':
        if (field || !plain || e.repeat) return;
        e.preventDefault();
        this.command('context');
        return;
      default:
        return;
    }
    if (dir !== null) {
      e.preventDefault();
      if (!e.repeat || this.keysDown.has(e.code)) this.nav.move(dir, e.repeat);
    }
  }

  /** Keyboard Q / E: the screen's own tabs when it has them, else the sections (pad: LT / RT and LB / RB apart). */
  private tabOrSection(d: -1 | 1): void {
    if (this.modalEl !== null) return;
    if (!this.command(d < 0 ? 'tabPrev' : 'tabNext')) this.command(d < 0 ? 'prev' : 'next');
  }

  /**
   * Controller (and any other non-keyboard source) routed by the Game (`repeat`: an arrow's
   * auto-repeat while held, Input's NAV_REPEAT_*).
   */
  action(a: NavDir | 'accept' | 'back' | MenuCommand, repeat = false): void {
    if (!this.visibleNow) return;
    if (a === 'accept') this.nav.accept();
    else if (a === 'back') this.backOrLeave();
    else if (a === 'up' || a === 'down' || a === 'left' || a === 'right') this.nav.move(a, repeat);
    else this.command(a);
  }

  /**
   * A shortcut: the screen on top first (Screen.command), else the menus' own: 'prev' / 'next' the
   * sections, 'tabPrev' / 'tabNext' the screen's inner tabs (stepTabs), 'cancel' the search, 'menu'
   * the settings. False when nothing took it. Nothing while a modal is up (it keeps the focus).
   */
  command(c: MenuCommand): boolean {
    if (!this.visibleNow || this.modalEl !== null) return false;
    if (this.top()?.command?.(c)) return true;
    if (c === 'prev' || c === 'next') return this.stepSection(c === 'prev' ? -1 : 1);
    if ((c === 'tabPrev' || c === 'tabNext') && this.stepTabs(c === 'tabPrev' ? -1 : 1)) return true;
    if (c === 'cancel') return this.cancelSearch();
    if (c === 'menu') {
      this.openSettings();
      return true;
    }
    return false;
  }

  /**
   * The screen's inner tabs (`.mn-tabs` of `.mn-tab`, the picked one `.mn-tab-on`: Leaderboard's
   * playlists, Profile's sign-in / register / recover), by pad LT / RT or Q / E: the one before /
   * after is pressed (round), and the focus goes with the pick when it was on the tabs (the screen
   * rebuilds them). False when the screen shows none.
   */
  private stepTabs(d: -1 | 1): boolean {
    const top = this.top();
    const own = this.ownTabs();
    if (top === null || own === null) return false;
    const { strip, tabs, on: i } = own;
    const onTabs = strip.contains(document.activeElement);
    tabs[(i + d + tabs.length) % tabs.length].click();
    const picked = top.el.querySelector<HTMLElement>('.mn-tabs .mn-tab-on');
    if (onTabs && picked !== null && !touchMode()) this.nav.focus(picked);
    return true;
  }

  /** Cancel the running search (pad Y, keyboard X, the pill's ✕; over Settings too). False when none runs. */
  cancelSearch(): boolean {
    if (!this.host.searchView().active) return false;
    this.host.cancelSearch();
    this.renderSearch(performance.now()); // the pill goes (its focus back to the screen)
    return true;
  }

  /**
   * The settings screen over the menus (the Hud's), on `opts.tab`; `onClose` when it is left (by
   * default the focus comes back where it was). While it is up the running search floats above it.
   */
  openSettings(onClose: () => void = () => this.refocus(), opts?: { tab?: SettingsTab }): void {
    if (this.settingsUp()) return;
    this.settingsOpen = true;
    this.host.openSettings(() => {
      this.settingsOpen = false;
      this.float.hidden = true;
      // The key that closed them (Esc / Backspace, the Hud's own listener, earlier on the window) is
      // no Back here too: onKey drops keys until this task ends.
      this.settingsClosing = true;
      window.setTimeout(() => (this.settingsClosing = false), 0);
      onClose();
      if (this.reloadNeeded && !this.reloadAsked) this.openUpdateSheet();
    }, opts);
    this.renderSearch(performance.now());
  }

  /** The Hud's settings screen is on screen (from these menus, or any other way). */
  private settingsUp(): boolean {
    return this.settingsOpen || document.querySelector('.hud-settings-panel:not([hidden])') !== null;
  }

  // ---- chrome: chip, pills, population ---------------------------------------------------------

  /**
   * The account chip and the region pill, written only when what they show changed (the population
   * poll every 10 s and each accounts event call this); then the bars fit again (data-fit).
   */
  refreshChrome(): void {
    const acc = this.host.accounts;
    const me = acc.me;
    let best: string | null = null;
    if (me) {
      const placed = me.ratings.filter((r) => r.tier !== null).sort((a, b) => b.mmr - a.mmr);
      best = placed[0]?.tier ?? null;
    }
    const signed = acc.signedIn && acc.account !== null;
    const chipKey = signed ? 'a|' + (acc.account?.name ?? '') + '|' + (best ?? '') : 'g|' + this.host.guestName();
    let changed = false;
    if (chipKey !== this.chipKey) {
      this.chipKey = chipKey;
      changed = true;
      const chip = this.topBar.chip;
      if (signed && acc.account) {
        const bestTier = tierById(best);
        setChildren(chip, h('span.mn-chip-avatar', null, rankBadge(bestTier, 30)), h('span.mn-chip-text', null, h('b', null, acc.account.name), h('small', null, best ? bestTier && tierName(bestTier) : t('menu.account'))));
        chip.setAttribute('aria-label', acc.account.name + '. ' + t('nav.profile'));
      } else {
        setChildren(chip, h('span.mn-chip-avatar', null, '?'), h('span.mn-chip-text', null, h('b', null, this.host.guestName()), h('small', null, t('menu.guestSignIn'))));
        chip.setAttribute('aria-label', this.host.guestName() + '. ' + t('menu.guestSignIn'));
      }
    }
    if (this.regionPill.set(this.regionState())) changed = true;
    if (changed) this.queueFit(); // the chip's name or the pill's text may have grown: the sections fit again
  }

  private regionState(): RegionPillState {
    if (this.cfg === null) return { kind: 'connecting' };
    if (!this.cfg.online || this.popFailed) return { kind: 'offline' };
    return { kind: 'online', region: this.regionLabel, playing: this.population?.playing ?? null };
  }

  /** The server config (regions, sign-in providers, online at all); again from the region pill when it failed. */
  private loadConfig(): void {
    void this.host
      .config()
      .then((c) => {
        this.cfg = c;
        this.popFailed = false;
        this.populationNow();
        this.refreshChrome();
        if (this.visibleNow) this.top()?.show?.();
      })
      .catch(() => {
        this.cfg = { regions: REGIONS, autoRegion: '', oauth: [], online: false };
        this.refreshChrome();
      });
  }

  private onRegionPill(): void {
    if (this.cfg !== null && (!this.cfg.online || this.popFailed)) {
      // Offline: RETRY.
      this.cfg = null;
      this.popFailed = false;
      this.refreshChrome();
      this.loadConfig();
      return;
    }
    this.openRegionSheet();
  }

  /** The region sheet: automatic (the connection's continent) first, then every region; the current one marked and focused. */
  private openRegionSheet(): void {
    const detected = this.cfg?.autoRegion;
    const auto = isRegion(detected) ? t('common.regionAutoNamed', { region: regionName(detected) }) : t('common.regionAuto');
    let close = (): void => undefined;
    const option = (id: RegionId | null, label: string): HTMLButtonElement => {
      const on = this.prefs.region === id;
      return h(
        `button.mn-btn.mn-sheet-option${on ? '.mn-sheet-option-on' : ''}` as 'button',
        {
          type: 'button',
          'data-nav': true,
          'data-autofocus': on,
          'aria-current': on ? 'true' : undefined,
          onclick: () => {
            this.prefs.region = id;
            this.savePrefs();
            this.populationNow();
            this.refreshChrome();
            close();
          },
        },
        on ? icon('check') : null,
        label,
      );
    };
    close = this.modal({
      title: t('common.region'),
      body: h('div.mn-sheet-list.mn-sheet-grid', null, option(null, auto), ...REGIONS.map((r) => option(r.id, regionName(r.id)))),
      actions: [{ label: t('lang.cancel'), onClick: () => true }],
    });
  }

  /** About: the build, the source (AGPL-3.0), the third-party licenses, Discord. */
  private openAbout(): void {
    const link = (href: string, text: string): HTMLAnchorElement => h('a.mn-btn.mn-sheet-option', { href, target: '_blank', rel: 'noopener', 'data-nav': true }, text);
    this.modal({
      title: t('nav.aboutTitle', { game: GAME_NAME }),
      body: [
        h('p.mn-about-build', null, this.host.info),
        h('div.mn-sheet-list', null, link(SOURCE_URL, t('menu.sourceTitle', { license: LICENSE_NAME })), link('./third-party-licenses.txt', t('menu.licenses')), link(DISCORD_URL, t('menu.discordTitle'))),
      ],
      actions: [{ label: t('nav.close'), onClick: () => true }],
    });
  }

  /** The running search's own screen (the pill; a lobby on screen asks first). */
  private openSearchScreen(): void {
    const v = this.host.searchView();
    if (!v.active) return;
    const guard = this.leaveGuard(1);
    if (guard !== null) guard(() => this.openSearchScreen());
    else this.open(v.kind === 'ranked' ? 'ranked' : 'casual', true);
  }

  /** "There's a new version": RELOAD NOW focused; NOT NOW leaves the pill. Above Settings (z 65). */
  private openUpdateSheet(): void {
    this.reloadAsked = true;
    this.root.classList.add('mn-blocking');
    this.modal({
      title: t('update.title'),
      body: h('p', null, t('update.text')),
      actions: [
        { label: t('update.reload'), primary: true, autofocus: true, onClick: () => location.reload() },
        { label: t('update.later'), onClick: () => true },
      ],
      onClose: () => this.root.classList.remove('mn-blocking'),
    });
  }

  private async pollPopulation(): Promise<void> {
    if (!this.cfg?.online) return;
    try {
      const q = this.prefs.region ? '?region=' + this.prefs.region : '';
      const res = await fetch('/api/population' + q, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(String(res.status));
      this.population = (await res.json()) as PopulationAnswer;
      this.popFailed = false;
    } catch {
      this.population = null;
      this.popFailed = true;
    }
    this.refreshChrome();
  }

  /** Re-poll now (region changed). */
  populationNow(): void {
    this.popAt = 0;
  }

  private tick(): void {
    const now = performance.now();
    if (now >= this.popAt) {
      this.popAt = now + POPULATION_EVERY_MS;
      void this.pollPopulation();
    }
    this.renderSearch(now);
    this.top()?.tick?.(now);
    this.renderHints(); // a screen's own tabs may have come or gone (written on a change only)
  }

  /** The search pills (the bar's and the one over Settings), a failure's toast, the update sheet. */
  private renderSearch(now: number): void {
    const v = this.host.searchView();
    if (v.reload === true && !this.reloadNeeded) {
      this.reloadNeeded = true;
      this.updateBtn.hidden = false;
      this.root.classList.add('mn-pills-more');
      this.queueFit();
      if (!this.settingsUp()) this.openUpdateSheet();
    } else if (v.error !== null && v.error !== this.lastError && v.reload !== true) this.toast(v.error, 'error');
    this.lastError = v.error;
    // A search that ends (cancelled, a failure, the server) takes its pill away: the focus it had
    // goes back to the screen, not to the page's body (blurred first: a hidden control keeps the
    // focus until the next frame's rendering, and refocus fills only an empty focus).
    const a = document.activeElement;
    if (!v.active && a instanceof HTMLElement && this.searchPill.el.contains(a)) {
      a.blur();
      this.refocus();
    }
    this.searchPill.set(v, now);
    const over = v.active && this.settingsUp() && this.visibleNow;
    if (this.float.hidden === over) this.float.hidden = !over; // written on a change only (4 Hz)
    if (over) this.floatPill.set(v, now);
    if (v.active !== this.searching) {
      this.searching = v.active;
      this.root.classList.toggle('mn-searching', v.active);
      this.root.classList.toggle('mn-pills-more', v.active || this.reloadNeeded);
      this.renderHints();
      this.queueFit();
    }
  }

  // ---- toasts / sheets --------------------------------------------------------------------------

  toast(text: string, kind: 'info' | 'error' | 'ok' = 'info'): void {
    this.toasts.show(text, kind);
  }

  /**
   * A sheet (components/sheet.ts) over the current screen; an action returning false keeps it open.
   * Returns a closer. While it is up the rest of the menus is inert (no focus, no click, no screen
   * reader), and when it closes the focus goes back to what had it when it opened.
   */
  modal(spec: ModalSpec): () => void {
    const prev = this.modalEl !== null ? this.modalOpener : null;
    this.closeModal(false);
    const a = document.activeElement;
    this.modalOpener = prev ?? (a instanceof HTMLElement && a !== document.body && this.root.contains(a) ? a : null);
    const close = (): void => {
      if (this.modalEl === box) this.closeModal();
    };
    const box = sheetBox(spec, close);
    this.modalEl = box;
    this.modalBlocking = spec.dismissable === false;
    this.modalDismiss = close;
    this.modalOnClose = spec.onClose ?? null;
    setChildren(this.modalLayer, box);
    this.modalLayer.hidden = false;
    this.setBackgroundInert(true);
    this.mountedAt = performance.now();
    this.nav.reset();
    this.autoFocus();
    return close;
  }

  /** The menus under a sheet: inert while it is up (the focus cannot leave it, a click on them does nothing). */
  private setBackgroundInert(on: boolean): void {
    for (const el of [this.rail.el, this.topBar.el, this.stage, this.hintBar.el, this.tabbar.el]) el.inert = on;
  }

  /**
   * Close the sheet; `refocus`: give the focus back to what had it when the sheet opened (when it
   * is still there; else the screen's remembered one, restoreFocus). Not when another sheet replaces it.
   */
  private closeModal(refocus = true): void {
    if (!this.modalEl) return;
    const onClose = this.modalOnClose;
    const opener = this.modalOpener;
    this.modalEl = null;
    this.modalDismiss = null;
    this.modalOnClose = null;
    this.modalOpener = null;
    this.modalBlocking = false;
    this.modalLayer.hidden = true;
    this.modalLayer.textContent = '';
    if (refocus) {
      this.setBackgroundInert(false);
      this.mountedAt = performance.now();
      this.nav.reset();
      if (!touchMode() && this.visibleNow && opener !== null && opener.isConnected && this.nav.targets().includes(opener)) this.nav.focus(opener);
      else this.refocus();
    }
    if (onClose !== null) onClose();
  }

  get modalOpen(): boolean {
    return this.modalEl !== null;
  }

  /** The section shown (tests, ui-fit). */
  get currentSection(): SectionId {
    return this.section;
  }
}
