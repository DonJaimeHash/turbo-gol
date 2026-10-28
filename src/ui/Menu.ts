/**
 * The front-end menus: the Tablero shell (plan §1.3-1.5) around a stack of screens per section.
 *
 * Sections (shell/sections.ts): JUGAR · ENTRENAMIENTO · GARAJE · CLASIFICACIÓN · PERFIL, each with a
 * root screen (JUGAR's: Inicio, screens/home.ts); every other screen is stacked on its section's
 * root (MODOS, a lobby, its creation... on Inicio). Switching sections always lands on the new
 * one's root (a section is a place, not a history): the top bar's tabs on a PC or a TV
 * (focus = selection), the rail of a phone held sideways, the tabs of an upright phone, pad LB /
 * RB, keyboard Q / E (a screen's own tabs first), the account chip (PERFIL) and the wordmark
 * (JUGAR). A section's root opened by a stacked screen
 * of another (Competitive's SIGN IN opens PERFIL) is a detour on top of it instead, so Back comes
 * back (backModel.ts stackAfterOpen). A screen that asks before it goes (Screen.leaveGuard: a
 * lobby) asks before any of those, or a crumb, takes the player off it.
 *
 * The shell, by layout class (device.ts layoutClass, `data-layout` on <html>; src/ui/styles/shell.css):
 * - the top bar (shell/topbar.ts): wordmark, sections, pills, account chip, Settings; on a stacked
 *   screen ‹ and the breadcrumbs, each crumb a way back;
 * - the rail (phone sideways) or the tab bar (upright), shell/rail.ts;
 * - the hint bar (shell/hintbar.ts): the last input's verbs (shell/hints.ts) and the source link
 *   (AGPL-3.0) with About; a TV keeps its pills there, but on Inicio, by the plate (Screen.pillSlot);
 * - pills (shell/pills.ts): the lobby the player is in when not on its screen ("LOBBY ABC234 ·
 *   2/4 · BACK", plan PR 12), the region with the connection, the running search (cancel from any
 *   section, and over Settings: a copy floats above them, `float`), "UPDATE TO PLAY";
 * - sheets (components/sheet.ts, `modal()`), toasts (components/toast.ts), the blocking "There's a
 *   new version" sheet when the server refused this page (it waits for Settings to close; z 65
 *   would keep it above them should both ever be up), and a failed online step's sheet
 *   (`failure()`: its text and the one action src/net/outcome.ts gives it; a search's REINTENTAR
 *   searches the same again).
 *
 * A match's start (Menu.beforeMatch: the hero, MODOS' FIND MATCH and PLAY): a TV without a
 * controller asks for one first (a sheet that closes by itself when one connects, the press that
 * revealed it starting nothing), and a new PC player is asked "How will you play?" once (howPlay.ts).
 * A search started anywhere is the queue JUGAR AHORA repeats (startSearch: MenuPrefs.lastQueue).
 *
 * Back (backModel.ts menuBack): the sheet closes, else a field being edited stops editing, else the
 * screen's own back, else the stack pops, else another section goes to JUGAR, else JUGAR's root
 * asks "Leave Turbogol?" (MenuHost.confirmLeave; the system Back reaches it through the Game).
 *
 * Focus (src/ui/nav.ts): zones top bar, stage, footer and the phone's tabs, the rail a side zone (◀
 * from the stage); ↑ from the stage lands on the active section (or ‹), ↓ from the bar on the
 * stage's remembered control. The last focus is remembered per screen (FocusMemory, by element or
 * `data-key`); `data-autofocus` counts on a first visit only. Shortcuts (`MenuCommand`): Q / E, pad
 * LB / RB and LT / RT (a stacked screen's own tabs take all of them: MODOS, Screen.command),
 * keyboard X / pad Y cancel the search (over Settings too), pad Start opens Settings, pad X /
 * Delete the screen's context action.
 *
 * Touch mode (`tg-touch` on <html>): no focus rings, nothing focused by itself, and a tap that began
 * before a screen or a sheet came up (or within TAP_GUARD_MS after) presses nothing on it (on the
 * rail and the top bar: after a stacked screen came or went and moved their items).
 *
 * The scene behind (plan §2.7, "UI at rest"): the menus tell the Game what they leave of the 3D
 * scene (MenuHost.setMenuCover, reportCover): part of it while they are up, with the share a touch
 * screen's menus hide (cover.ts, measureCover: on a mount, a section switch, a sheet closed,
 * Settings closed, a resize or a layout change, and once a second on the tick), all of it under a
 * sheet and while the shell's own backdrop is opaque (super low's flat page, but on Inicio, whose
 * tiles sit on the live stadium: `data-screen` on the root, readBackdrop), none once hidden; the
 * Game adds its own layers (Settings, the rotate screen) and draws the scene at the menus' rate or
 * holds one frame (src/render/quality.ts sceneFps). The tick (`tick`: the pills, the screen's
 * counters, the hints) runs at 4 Hz, 1 Hz on super low (`tg-superlow` on <html>), and writes the
 * DOM only when a text changed.
 *
 * The Game implements MenuHost (what the menus can ask of it) and calls show() / hide() / action();
 * the menu never touches the sim or the renderer. Styling: src/ui/styles/ (`mn-`) and menu.css.
 */
import './menu.css';
import './styles/index.css';
import { h, setChildren } from './dom';
import { FocusMemory, FocusNav, heldOver, isEditable, isEditing, navKey, setEditing } from './nav';
import { installKeyboardInset } from './keyboard';
import type { NavDir, NavZone } from './nav';
import { finePointer, resetPageZoom, tapGuarded } from './device';
import type { InputKind } from './device';
import { rankBadge, tierById } from './badges';
import { regionName, tierName } from './names';
import { t } from '../i18n';
import type { Key } from '../i18n';
import type { AccountClient } from '../net/AccountClient';
import type { LobbyClient } from '../net/LobbyClient';
import type { TrainingRecordsView } from '../game/trainingStore';
import type { ExperimentalStore } from '../game/experimentalStore';
import type { PopulationAnswer, RegionId } from '../net/account';
import { REGIONS, isRegion } from '../net/account';
import type { QueueResult } from '../net/protocol';
import type { QueueResultP2p } from '../net/p2p/protocol';
import type { GameMode } from '../sim/constants';
import type { Difficulty } from '../render/Hud';
import type { SettingsTab } from './screens/settings/model';
import type { ThemeId } from '../render/theme';
import type { ActionId, Device } from '../input/bindings';
import { DISCORD_URL, GAME_NAME, LICENSE_NAME, SOURCE_URL } from '../brand';
import { hashValue } from '../render/hashFlags';
import { menuBack, stackAfterOpen } from './backModel';
import { HOME_SECTION, sectionDef, stepSection } from './shell/sections';
import type { SectionId } from './shell/sections';
import { hintItems } from './shell/hints';
import { TopBar } from './shell/topbar';
import { SectionList } from './shell/rail';
import { HintBar } from './shell/hintbar';
import { LobbyPill, RegionPill, SearchPill, updatePill } from './shell/pills';
import type { RegionPillState } from './shell/pills';
import { sheetBox } from './components/sheet';
import type { SheetSpec } from './components/sheet';
import { Toasts } from './components/toast';
import { icon } from './components/icons';
import type { IconName } from './components/icons';
import { fitAll, restoreGiven, uiFitReport } from './fit';
import { PREFS_KEY, parsePrefs } from './prefs';
import type { MenuPrefs } from './prefs';
import { howPlayAsk, readHowPlay, writeHowPlay } from './howPlay';
import type { ControlScheme } from './howPlay';
import { isOffline } from './screens/homeModel';
import { localCardSeen } from '../render/controlsCard';
import { atOverlays, coverShare, menuCover, opaqueBackground, paintsBackground } from './cover';
import type { OverlayBox } from './cover';
import type { SceneCover } from '../render/quality';
import { MODES } from '../sim/constants';
import { OUTCOME_ACTION } from '../net/outcome';
import type { Outcome } from '../net/outcome';
import type { RejoinRecord } from '../game/rejoinStore';

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
  /** The running search's region (null = automatic). */
  region: RegionId | null;
  /** The queue it joined (MODOS' bots countdown: which path fills with bots, and when); null when none runs. */
  net?: 'p2p' | 'server' | null;
  /** The last failure (shown once as a toast), null when none. */
  error: string | null;
  /** That failure is the server refusing this page's version (426 reload_required): reload to play online. */
  reload?: boolean;
  /** What that failure leaves the player to do (src/net/outcome.ts); absent: retry. */
  outcome?: Outcome;
  /**
   * That failure ended what the menus started (a search, a rejoin: REINTENTAR runs it again);
   * false for a lobby's match (its member goes back to the Sala): the sheet only closes.
   */
  retry?: boolean;
}

export interface MenuConfig {
  regions: ReadonlyArray<{ id: RegionId; name: string }>;
  autoRegion: string;
  oauth: string[];
  online: boolean;
  /** The server queue's bot fill, ms (GET /api/config botFillMs: MODOS' "bots join in"), null when the Worker did not say. */
  botFillMs: number | null;
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
  /**
   * Free play with the running search alive (MODOS' "While you wait: Free play"): a match found
   * ends it and plays (Game.practiceToMatch); quitting it comes back to the menus still searching.
   */
  practiceWhileSearching(): void;
  /** A custom lobby started: join this member's match. */
  playLobbyMatch(result: QueueResult | QueueResultP2p): void;
  /** The server match this tab may join again (rejoinStore.ts: a reload, a lost connection), or null. */
  rejoinable(): RejoinRecord | null;
  /** Join it again (POST /api/rejoin; Inicio's BACK TO YOUR MATCH, a lost connection's REJOIN). */
  rejoinMatch(): void;
  /** A guest that never played online in this browser (no session yet): a join link asks for a name. */
  firstOnline(): boolean;
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
   * `covered`, the share of a touch screen they hide: cover.ts), 'opaque' under a sheet or an
   * opaque backdrop (super low), 'none' once hidden. The Game draws the scene at the menus' rate
   * or holds one frame.
   */
  setMenuCover(level: SceneCover, covered?: number): void;
  /** One line about the build (WebGPU / RocketSim version), shown in About. */
  readonly info: string;
  /** A controller is connected (Input.hasGamepad): a TV without one asks for it before a match. */
  padConnected(): boolean;
  /** "How will you play?" answered (howPlay.ts): keyboard only applies its preset (saved as Settings › Controls saves it). */
  setControlScheme(s: ControlScheme): void;
  /** Presses made so far count as held (Input.latchEdges): the A that revealed a controller presses nothing more. */
  latchInput(): void;
  /** The keyboard + mouse bindings are the player's own (bindings.ts kbmCustomised): a returning player. */
  controlsCustomised(): boolean;
}

const POPULATION_EVERY_MS = 10_000;
/** A focus this soon after a pointer lifted is that pointer's (a tap focuses between its up and its click). */
const POINTER_FOCUS_MS = 150;
const TICK_MS = 250;
/** The same on super low (`tg-superlow`: the 1 GB TV): the search pill's clock still moves every second. */
const TICK_MS_LITE = 1000;
/** A touch screen re-measures the share its menus hide this often (ms, on the tick): content loads, toasts come and go. */
const COVER_EVERY_MS = 1000;

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

/** The menus' prefs (prefs.ts); the defaults when storage is blocked. */
function loadPrefs(): MenuPrefs {
  try {
    return parsePrefs(localStorage.getItem(PREFS_KEY));
  } catch {
    return parsePrefs(null);
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
  /** Where a TV puts the pills while this screen is on top (Inicio: by the plate); else its hint bar. */
  readonly pillSlot?: HTMLElement;
  /** Esc / B on this screen: return true to swallow it (e.g. a sub-view closes first). */
  back?(): boolean;
  /**
   * A shortcut (MenuCommand) on this screen: return true when it handled it (its tabs, its context
   * action). `pad`: a controller's press (Menu.action; data-input says so only after this frame).
   */
  command?(c: MenuCommand, pad: boolean): boolean;
  /** Menu.open's `tab`, before the screen mounts (MODOS: the tab Inicio's tile or the search asked for). */
  setTab?(tab: string): void;
  /** What its own tabs are, for the hint bar (MODOS: "Modes"); else "Tabs". */
  readonly tabsVerb?: Key;
  /** The scene holds one frame under it (Ajustes: nothing behind it moves, the menus report 'opaque'). */
  readonly holdsScene?: boolean;
  /** It takes every key itself now (Ajustes waiting for a binding's key): the menus' keys stand aside. */
  keysTaken?(): boolean;
  /** Focus zones of its own, before the shell's (Ajustes' rail: a side zone, crossed with ◀ ▶ only). */
  zones?(): NavZone[];
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
  private readonly lobbyPill: LobbyPill;
  private readonly regionPill: RegionPill;
  private readonly searchPill: SearchPill;
  private readonly updateBtn: HTMLButtonElement;
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
  /** Population polls failed in a row (the hero counts two as offline: homeModel.ts isOffline). */
  private popFails = 0;
  private lastError: string | null = null;
  /** What a failed search's REINTENTAR runs again: the last search started, or a rejoin (rejoin()). */
  private lastTry: (() => void) | null = null;
  private visibleNow = false;
  private searching = false;
  /** The lobby pill is up (renderLobbyPill). */
  private lobbyPillUp = false;
  /** Settings opened from the menus are up (Menu.openSettings). */
  private settingsOpen = false;
  /** The server refused this page's version: the update sheet once, then the pill. */
  private reloadNeeded = false;
  private reloadAsked = false;
  private firstShow = true;
  private fitQueued = false;
  /** What the account chip shows (refreshChrome rebuilds it on a change only). */
  private chipKey = '';
  /** A coarse primary pointer (phones, tablets): the share the menus hide is measured (measureCover). */
  private readonly coarse: boolean;
  /** The shell's own backdrop is opaque (super low's flat page, style.css --mn-backdrop): the menus hide all of the scene. */
  private backdropOpaque = false;
  /** The last cover told to the Game (reportCover), the share measured, a measurement queued and its time. */
  private coverSent: SceneCover | null = null;
  private coveredSent = -1;
  private covered = 0;
  private coverQueued = false;
  private coverAt = 0;
  /** The "you need a controller" sheet is up: its closer (a controller connecting closes it). */
  private needPadClose: (() => void) | null = null;
  /** A controller was connected at the last check (tick). */
  private padWas = false;
  /** Menu.action's 'accept' is running: the press is a controller's (data-input says so only after this frame). */
  private padAccept = false;
  /**
   * The section tab the focus fell back to on a stage with nothing to focus (restoreFocus: GARAJE),
   * until anything else takes the focus: no choice of the bar's, so a switch from there (Back to
   * JUGAR) lands where the stage's own focus was, as from any other screen.
   */
  private barFallback: HTMLElement | null = null;

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
    this.lobbyPill = new LobbyPill(() => this.open('lobby'));
    this.pills = h('div.mn-pill-row', null, this.lobbyPill.el, this.searchPill.el, this.updateBtn, this.regionPill.el);
    this.topBar.pills.appendChild(this.pills);
    this.stage = h('main.mn-stage');
    this.toasts = new Toasts();
    this.modalLayer = h('div.mn-modal-layer', { hidden: true });
    this.root = h('div.mn', { hidden: true }, this.rail.el, this.topBar.el, this.stage, this.hintBar.el, this.tabbar.el, this.toasts.el, this.modalLayer);
    // RMB is bindable in game: no context menu over the menus.
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    container.appendChild(this.root);
    this.nav = new FocusNav(() => this.zones(), {
      remembered: (zone, targets) => this.zoneEntry(zone, targets),
      restore: () => this.restoreFocus(),
      onFocus: (el, zone) => this.noteFocus(el, zone),
    });
    this.nav.install(this.root);
    // A phone's keyboard over a form: the focused field stays above it (keyboard.ts).
    installKeyboardInset(this.root);
    // Capture, before a field's own Enter (custom.ts JOIN, profile.ts sign-in): the fields' modes.
    this.root.addEventListener('keydown', (e) => this.onFieldKey(e), true);
    this.installTapGuard();
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('keyup', (e) => this.keysDown.delete(e.code));
    this.coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    window.addEventListener('resize', () => {
      this.queueFit();
      this.measureCover();
    });
    // The hints and the pills' place follow the last input and the layout class (device.ts); the
    // other classes of <html> (super low, fullscreen...) change nothing here.
    const html = document.documentElement;
    let shellKey = '';
    new MutationObserver(() => {
      this.readBackdrop();
      const key = [html.dataset.input, html.dataset.layout, html.classList.contains('tg-touch'), html.classList.contains('tg-tv')].join();
      if (key === shellKey) return;
      shellKey = key;
      this.renderHints();
      this.placePills();
      this.fitNow(); // before the frame that shows the new hints (a pad's first press)
      this.measureCover(); // the bars move (the pills to a TV's hint bar, the rail, the tabs)
    }).observe(html, { attributes: true, attributeFilter: ['data-input', 'data-layout', 'class'] });
    void document.fonts?.ready.then(() => this.queueFit());
    host.accounts.subscribe(() => this.refreshChrome());
    // After Input's own listener (the Game creates the Input first): hasGamepad already says so.
    window.addEventListener('gamepadconnected', () => this.onPadChange());
    this.loadConfig();
    // The report of what the next frame shows: a fit the last change queued runs first (the check
    // reads the page a fixed pause after a mount, and the frame that would run it can come later:
    // a slow headless frame, a background tab), never one nobody asked for.
    if (UI_FIT) (window as unknown as { __uiFit: () => unknown }).__uiFit = () => {
      if (this.fitQueued && this.visibleNow) fitAll(this.root);
      return uiFitReport(this.root, this.top()?.id ?? '');
    };
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

  /** Screen `id` is in the section's stack (on top or under a detour). */
  stacked(id: string): boolean {
    return this.stack.some((s) => s.id === id);
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
    const r = REGIONS.find((x) => x.id === this.regionId);
    if (this.prefs.region !== null) return r ? regionName(r.id) : '?';
    return r ? t('menu.regionAutoNamed', { region: regionName(r.id) }) : t('menu.regionAuto');
  }

  /** The region the matchmaker uses: the chosen one, else the automatic one; null before the server said which. */
  get regionId(): RegionId | null {
    const auto = this.cfg?.autoRegion;
    return this.prefs.region ?? (isRegion(auto) ? auto : null);
  }

  /** The server refused this page's version (Inicio's hero: RELOAD NOW). */
  get updateNeeded(): boolean {
    return this.reloadNeeded;
  }

  /** No Worker, or two population polls in a row failed (homeModel.ts isOffline: the hero's VS AI). */
  get offline(): boolean {
    return isOffline(this.cfg, this.popFails);
  }

  /**
   * Start a search (Inicio's hero, Casual's and Competitive's FIND MATCH): its kind is the queue
   * JUGAR AHORA repeats (MenuPrefs.lastQueue); the pill, the hints and the screen on top follow at
   * once (renderSearch).
   */
  startSearch(req: SearchRequest): void {
    this.lastTry = () => this.beforeMatch(() => this.startSearch(req));
    this.prefs.lastQueue = req.kind;
    this.savePrefs();
    this.host.search(req);
    this.renderSearch(performance.now());
  }

  /** Back into the server match this tab lost (MenuHost.rejoinMatch): Inicio's hero, the lost sheet. */
  rejoin(): void {
    this.lastTry = () => this.beforeMatch(() => this.rejoin());
    this.host.rejoinMatch();
  }

  /**
   * Before a match starts (`go`): a TV without a controller asks for one (openNeedPad); a new PC
   * player is asked how they will play, once (howPlay.ts: never at boot, never for a controller's
   * press, which answers it, never a returning player).
   */
  beforeMatch(go: () => void): void {
    const html = document.documentElement;
    const tv = html.classList.contains('tg-tv');
    if (tv && !this.host.padConnected()) return this.openNeedPad(go);
    const ask = howPlayAsk({
      tv,
      layout: html.dataset.layout ?? '',
      touch: touchMode(),
      input: this.padAccept ? 'pad' : lastInput(),
      answered: readHowPlay() !== null,
      returning: localCardSeen.read() > 0 || this.host.controlsCustomised(),
    });
    if (ask === 'pad') writeHowPlay('pad');
    if (ask === 'ask') return this.openHowPlay(go);
    go();
  }

  /** data-fit (fit.ts) now: a screen's text changed (the frame about to be drawn shows it fitted). */
  refit(): void {
    this.fitNow();
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
    this.readBackdrop();
    this.reportCover();
    this.mount();
    this.placePills();
    if (this.timer === 0) this.timer = window.setInterval(() => this.tick(), document.documentElement.classList.contains('tg-superlow') ? TICK_MS_LITE : TICK_MS);
    this.tick();
  }

  hide(): void {
    this.root.hidden = true;
    this.root.parentElement?.classList.remove('mn-open');
    this.visibleNow = false;
    resetPageZoom(); // a pinch in the menus does not carry into the match (its controls would sit off screen)
    this.keysDown.clear(); // a key held into the match and out again is no menu key
    this.closeModal();
    this.reportCover();
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
   * whatever was stacked). `tab`: the screen's tab to show (Screen.setTab: MODOS').
   */
  open(id: string, reset = false, tab?: string): void {
    const next = stackAfterOpen({ section: this.section, stack: this.stack.map((s) => s.id) }, id, reset);
    const stack = next.stack.map((x) => this.screen(x));
    if (tab !== undefined) this.screen(id).setTab?.(tab);
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

  /** Replace the top screen (a form that turns into its result); `tab` as in open. */
  replace(id: string, tab?: string): void {
    this.top()?.hide?.();
    if (this.stack.length > 1) this.stack.pop();
    this.open(id, false, tab);
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
    const active = document.activeElement;
    const onBar = this.onSectionTab(active) && active !== this.barFallback;
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
    // Which screen is up, for the stylesheets (Inicio's backdrop and stage, a TV's About), where a
    // TV's pills go, and whether the shell's backdrop is opaque here (Inicio drops it).
    this.root.dataset.screen = top.id;
    this.placePills();
    this.readBackdrop();
    this.reportCover(); // a screen that holds the scene (Ajustes) came or went
    // A screen opens at its top. With the keyboard / pad the first control's focus scrolls there
    // (autoFocus); touch mode and a switch from the bar focus nothing on the stage.
    if (touchMode() || focus === 'keep') this.stage.scrollTop = 0;
    this.renderChrome();
    top.show?.();
    this.refreshChrome();
    this.renderLobbyPill();
    // Now, before this frame is drawn: a press of a pad or a remote mounts inside the game loop's
    // animation frame, and a fit on the next one would show a frame of an unfitted bar first.
    this.fitNow();
    if (focus === 'auto') this.autoFocus();
    this.measureCover(); // after the fit (on the next frame, after layout)
    // Ajustes gone from under the screen shown (PERFIL's detour left by a crumb, the chip, a
    // section): it closes as when it is left from the top (screens/settings/screen.ts). The FINAL
    // gone (from under Ajustes too): what waited for it runs (its hide, final.ts).
    if (!this.stacked('settings')) this.screens.get('settings')?.hide?.();
    if (!this.stacked('final')) this.screens.get('final')?.hide?.();
  }

  /**
   * Tell the Game what the menus leave of the 3D scene (MenuHost.setMenuCover; quality.ts
   * sceneFps): nothing once hidden; all of it under a sheet (the update sheet too), while the
   * shell's own backdrop is opaque (super low) or under a screen that holds the scene (Ajustes);
   * else part of it, with the share a touch screen's menus hide (measureCover). Only a change is
   * sent.
   */
  private reportCover(): void {
    const opaque = this.backdropOpaque || this.top()?.holdsScene === true;
    const { level, covered } = menuCover({ visible: this.visibleNow, sheet: this.modalEl !== null, opaqueBackdrop: opaque, covered: this.covered });
    if (level === this.coverSent && covered === this.coveredSent) return;
    this.coverSent = level;
    this.coveredSent = covered;
    this.host.setMenuCover(level, covered);
  }

  /**
   * Whether the shell paints an opaque page of its own under the screens (cover.ts
   * opaqueBackground of .mn's computed background: super low's --mn-backdrop is --ink, a flat
   * colour; elsewhere a translucent gradient lets the stadium through). Read as the menus show and
   * when <html>'s classes change (the tier's class); a change is reported.
   */
  private readBackdrop(): void {
    if (!this.visibleNow) return;
    const opaque = opaqueBackground(getComputedStyle(this.root));
    if (opaque === this.backdropOpaque) return;
    this.backdropOpaque = opaque;
    this.reportCover();
  }

  /**
   * On a touch screen, measure the share of it the menus hide (cover.ts: a 9 x 5 grid of
   * elementFromPoint and computed backgrounds: the bars, the rail or the tabs, the pills, the
   * tiles, a toast) on the next frame, after layout and the fit: when a screen mounts (a section
   * switch, a stacked screen, a crumb), a sheet or Settings close, the viewport or the layout class
   * changes, and once a second on the tick (a list that loaded, a toast, the loading screen gone).
   * GARAJE's almost empty stage measures low like any other. Nothing on other devices (the 20 fps
   * rule is a phone's), under a sheet or an opaque backdrop (all of it is hidden then).
   */
  private measureCover(): void {
    if (!this.coarse || this.coverQueued) return;
    this.coverQueued = true;
    requestAnimationFrame(() => {
      this.coverQueued = false;
      if (!this.visibleNow || this.modalEl !== null || this.backdropOpaque) return;
      this.coverAt = performance.now();
      // A toast lets clicks through (pointer-events: none), so elementFromPoint never returns it:
      // the boxes of those up (not on their way out) are hit-tested first.
      const toasts: OverlayBox[] = [];
      for (const el of this.toasts.el.children) {
        if (el.classList.contains('mn-toast-out')) continue;
        const r = el.getBoundingClientRect();
        toasts.push({ el, left: r.left, top: r.top, right: r.right, bottom: r.bottom });
      }
      const at = atOverlays(toasts, (x, y) => document.elementFromPoint(x, y));
      const share = coverShare(this.root, window.innerWidth, window.innerHeight, at, (el) => paintsBackground(getComputedStyle(el)));
      if (Number.isNaN(share)) return; // another layer on top (Settings, the loading screen): the last share stands
      this.covered = Math.round(share * 100) / 100;
      this.reportCover();
    });
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
   * True when the hints or the keycaps changed (the bars need a new fit).
   */
  private renderHints(): boolean {
    const ownTabs = this.ownTabs() !== null;
    const keycaps = this.root.classList.contains('mn-own-tabs') !== ownTabs;
    if (keycaps) this.root.classList.toggle('mn-own-tabs', ownTabs);
    return this.hintBar.render(hintItems(lastInput(), { searching: this.searching, stacked: this.stack.length > 1, ownTabs, tabsVerb: this.top()?.tabsVerb })) || keycaps;
  }

  /** The tabs of the screen on top (`.mn-tabs` of `.mn-tab`, the picked one `.mn-tab-on`), null without two of them. */
  private ownTabs(): { strip: HTMLElement; tabs: HTMLElement[]; on: number } | null {
    const strip = this.top()?.el.querySelector<HTMLElement>('.mn-tabs') ?? null;
    if (strip === null) return null;
    const tabs = Array.from(strip.querySelectorAll<HTMLElement>('.mn-tab'));
    const on = tabs.findIndex((b) => b.classList.contains('mn-tab-on'));
    return on < 0 || tabs.length < 2 ? null : { strip, tabs, on };
  }

  /**
   * The pills: the top bar's right side, or on a TV (its top bar has no room at 3 m) the screen's
   * own place for them (Screen.pillSlot: Inicio's, by the plate), else the hint bar. Out of a
   * crowded bar, the words it took away come back (fit.ts restoreGiven).
   */
  private placePills(): void {
    const tv = document.documentElement.dataset.layout === 'tv';
    const want = tv ? (this.top()?.pillSlot ?? this.hintBar.mid) : this.topBar.pills;
    if (this.pills.parentElement === want) return;
    want.appendChild(this.pills);
    restoreGiven(this.pills);
  }

  /** data-fit (fit.ts) now: a mount, new hints, another input, a chip or pill that changed (the frame about to be drawn shows them fitted). */
  private fitNow(): void {
    if (this.visibleNow) fitAll(this.root);
  }

  /** data-fit (fit.ts) on the next frame, once per frame (a resize, the fonts once they are in). */
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
    if (this.nav.current !== null) return;
    this.focusSectionEntry();
    this.barFallback = this.nav.current;
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
      ...(this.top()?.zones?.() ?? []),
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
    if (el !== this.barFallback) this.barFallback = null;
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
    if (this.top()?.keysTaken?.() === true) return; // Ajustes' capture: the key is the binding
    if (e.altKey) return; // Alt + ← is the browser's Back: the system Back goes back (BackGuard), the focus stays
    if (!e.repeat && typeof e.code === 'string') this.keysDown.add(e.code);
    // Enter / Space held over from the match (SALIR's hold) would click the focused button on every
    // repeat (the hero's search): only a press the menus had activates.
    if ((e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space') && heldOver(e, this.keysDown)) {
      e.preventDefault();
      return;
    }
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
      if (!heldOver(e, this.keysDown)) this.nav.move(dir, e.repeat);
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
    // The press that revealed a controller (Chrome exposes one on its first press), when the game's
    // frame sees it before the event and the tick do: with "You need a controller" up it only
    // closes the sheet, whichever button had the focus (CONTINUE ANYWAY would play). This call
    // consumes its edge; the event or the tick first: onPadChange, which latches it.
    if (this.needPadClose !== null && !this.padWas && this.host.padConnected()) {
      this.padWas = true;
      this.needPadClose();
      this.top()?.tick?.(performance.now());
      return;
    }
    if (a === 'accept') {
      // Its click runs inside (FocusNav.accept): beforeMatch knows the press is a controller's.
      this.padAccept = true;
      try {
        this.nav.accept();
      } finally {
        this.padAccept = false;
      }
    } else if (a === 'back') this.backOrLeave();
    else if (a === 'up' || a === 'down' || a === 'left' || a === 'right') this.nav.move(a, repeat);
    else this.command(a, true);
  }

  /**
   * A shortcut: the screen on top first (Screen.command), else the menus' own: 'prev' / 'next' the
   * sections, 'tabPrev' / 'tabNext' the screen's inner tabs (stepTabs), 'cancel' the search, 'menu'
   * the settings. False when nothing took it. Nothing while a modal is up (it keeps the focus).
   * `pad`: it came from a controller (action), not the keyboard's Q / E / X / Delete.
   */
  command(c: MenuCommand, pad = false): boolean {
    if (!this.visibleNow || this.modalEl !== null) return false;
    if (this.top()?.command?.(c, pad)) return true;
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
   * Ajustes (screens/settings: the Game's view as a screen stacked on the one shown, whatever its
   * section), on `opts.tab`; `onClose` once it left the stack (by default the focus comes back where
   * it was). The update sheet waits for it to close. Already open (under PERFIL's detour): back to
   * it, on `opts.tab`.
   */
  openSettings(onClose: () => void = () => this.refocus(), opts?: { tab?: SettingsTab }): void {
    if (this.settingsUp()) {
      if (this.stacked('settings') && this.top()?.id !== 'settings') this.open('settings', false, opts?.tab);
      return;
    }
    this.settingsOpen = true;
    this.host.openSettings(() => {
      this.settingsOpen = false;
      onClose();
      if (this.reloadNeeded && !this.reloadAsked) this.openUpdateSheet();
    }, opts);
    this.open('settings');
  }

  /** Ajustes is up (opened by openSettings, or on top any other way: Menu.open). */
  private settingsUp(): boolean {
    return this.settingsOpen || this.top()?.id === 'settings';
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
    // The chip's name or the pill's text may have grown, and a rebuilt pill shows its words again
    // (a crowded TV bar had them give way): the bars fit again before this frame.
    if (changed) this.fitNow();
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
        this.popFails = 0;
        this.populationNow();
        this.refreshChrome();
        if (this.visibleNow) {
          this.top()?.show?.();
          this.fitNow(); // what the screen shows with the config (Inicio's region), as a mount fits it
        }
      })
      .catch(() => {
        this.cfg = { regions: REGIONS, autoRegion: '', oauth: [], online: false, botFillMs: null };
        this.refreshChrome();
      });
  }

  private onRegionPill(): void {
    if (this.cfg !== null && (!this.cfg.online || this.popFailed)) {
      // Offline: RETRY.
      this.cfg = null;
      this.popFailed = false;
      this.popFails = 0;
      this.refreshChrome();
      this.loadConfig();
      return;
    }
    this.openRegionSheet();
  }

  /** The region sheet (the region pill, MODOS' Region row): automatic (the connection's continent) first, then every region; the current one marked and focused. */
  openRegionSheet(): void {
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

  /** The running search's own screen, MODOS on its tab (the pill, Inicio's hero while searching; a lobby on screen asks first). */
  openSearchScreen(): void {
    const v = this.host.searchView();
    if (!v.active) return;
    const guard = this.leaveGuard(1);
    if (guard !== null) guard(() => this.openSearchScreen());
    else this.open('modes', true, v.kind === 'ranked' ? 'ranked' : 'casual');
  }

  /**
   * A TV without a controller, at a match's start: CLOSE focused, CONTINUE ANYWAY plays with the
   * remote. A controller connecting closes it (onPadChange; its press seen first: action), and the
   * press that revealed it starts nothing: the hero then says ALWAYS A MATCH, and one more A plays.
   */
  private openNeedPad(go: () => void): void {
    let close = (): void => undefined;
    close = this.modal({
      title: t('tv.needPad'),
      body: h('p', null, t('tv.needPadText')),
      actions: [
        {
          label: t('tv.needPadGo'),
          onClick: () => {
            close();
            go();
          },
        },
        { label: t('nav.close'), autofocus: true, onClick: () => true },
      ],
      onClose: () => {
        if (this.needPadClose === close) this.needPadClose = null;
      },
    });
    this.needPadClose = close;
  }

  /**
   * A controller connected (its event, or the tick's check): the "you need a controller" sheet
   * goes, its revealing press latched first, and the screen follows at once (a TV's hero).
   */
  private onPadChange(): void {
    if (!this.host.padConnected()) return;
    this.padWas = true;
    const close = this.needPadClose;
    if (close !== null) {
      this.host.latchInput();
      close();
    }
    if (this.visibleNow) this.top()?.tick?.(performance.now());
  }

  /**
   * "How will you play?", once (beforeMatch): MOUSE AND KEYBOARD focused, KEYBOARD ONLY, CONTROLLER.
   * A choice is stored and sets the controls, then the match starts (a controller not connected
   * yet: the "you need a controller" sheet first, from the same opener). CANCEL and Back store
   * nothing and play nothing.
   */
  private openHowPlay(go: () => void): void {
    let close = (): void => undefined;
    const choose = (s: ControlScheme): void => {
      close();
      writeHowPlay(s);
      this.host.setControlScheme(s);
      if (s === 'pad' && !this.host.padConnected()) this.openNeedPad(go);
      else go();
    };
    const option = (s: ControlScheme, icons: readonly IconName[], label: string, autofocus = false): HTMLButtonElement =>
      h('button.mn-btn.mn-sheet-option', { type: 'button', 'data-nav': true, 'data-autofocus': autofocus, onclick: () => choose(s) }, ...icons.map((i) => icon(i)), label);
    close = this.modal({
      title: t('howPlay.title'),
      body: h('div.mn-sheet-list', null, option('kbm', ['mouse', 'keyboard'], t('howPlay.kbm'), true), option('keyboard', ['keyboard'], t('howPlay.keyboard')), option('pad', ['pad'], t('howPlay.pad'))),
      actions: [{ label: t('lang.cancel'), onClick: () => true }],
    });
  }

  /**
   * "There's a new version": RELOAD NOW focused; NOT NOW leaves the pill. Never opened over Settings
   * (renderSearch waits, openSettings' close opens it); `.mn-blocking` (z 65) would keep it above them.
   */
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
      this.popFails = 0;
    } catch {
      this.population = null;
      this.popFailed = true;
      this.popFails++;
    }
    this.refreshChrome();
  }

  /** Re-poll now (region changed). */
  populationNow(): void {
    this.popAt = 0;
  }

  private tick(): void {
    const now = performance.now();
    // Chrome may expose a controller without the event (on its first press): checked here too.
    const pad = this.host.padConnected();
    if (pad !== this.padWas) {
      this.padWas = pad;
      if (pad) this.onPadChange();
    }
    if (now >= this.popAt) {
      this.popAt = now + POPULATION_EVERY_MS;
      void this.pollPopulation();
    }
    this.renderSearch(now);
    this.renderLobbyPill();
    this.top()?.tick?.(now);
    if (this.renderHints()) this.fitNow(); // a screen's own tabs may have come or gone (written on a change only)
    if (this.coarse && now - this.coverAt >= COVER_EVERY_MS) this.measureCover();
  }

  /** The search pills (the bar's and the one over Settings), a failure's toast, the update sheet. */
  private renderSearch(now: number): void {
    const v = this.host.searchView();
    if (v.reload === true && !this.reloadNeeded) {
      this.reloadNeeded = true;
      this.updateBtn.hidden = false;
      this.root.classList.add('mn-pills-more');
      this.fitNow();
      if (!this.settingsUp()) this.openUpdateSheet();
    } else if (v.error !== null && v.error !== this.lastError && v.reload !== true) {
      this.failure(v.error, v.outcome ?? 'retry', v.retry === false ? undefined : (this.lastTry ?? undefined));
    }
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
    if (v.active !== this.searching) {
      this.searching = v.active;
      this.root.classList.toggle('mn-searching', v.active);
      this.root.classList.toggle('mn-pills-more', v.active || this.reloadNeeded || this.lobbyPillUp);
      this.renderHints();
      // The screen follows in this frame (Inicio's hero: SEARCHING and ✕, or JUGAR AHORA again),
      // not on its next tick (a second later on super low).
      if (this.visibleNow) this.top()?.tick?.(now);
      this.fitNow(); // the pill, the cancel hint, a TV's About that gives way
    }
  }

  /**
   * The lobby pill: shown while the player is in a lobby (reconnecting too) and its screen is not on
   * top; written on a change only (the bars fit again then).
   */
  private renderLobbyPill(): void {
    const lobby = this.host.lobby;
    const st = lobby.state;
    const show = this.visibleNow && lobby.inLobby && this.top()?.id !== 'lobby';
    const changed = this.lobbyPill.set(show ? { code: st?.code ?? lobby.code ?? '', count: st !== null ? st.members.length : null, max: st !== null ? MODES[st.settings.mode] * 2 : null, reconnecting: lobby.reconnecting } : null);
    if (!changed) return;
    const a = document.activeElement;
    if (!show && a instanceof HTMLElement && this.lobbyPill.el.contains(a)) {
      a.blur();
      this.refocus();
    }
    // A crowded bar, as beside the search pill: the chip and the region pill give their words first.
    this.lobbyPillUp = show;
    this.root.classList.toggle('mn-pills-more', show || this.searching || this.reloadNeeded);
    this.fitNow();
  }

  // ---- toasts / sheets --------------------------------------------------------------------------

  toast(text: string, kind: 'info' | 'error' | 'ok' = 'info'): void {
    this.toasts.show(text, kind);
  }

  /**
   * A failed online step (src/net/outcome.ts): its text as the title and the one thing left to do,
   * in a sheet (an error that asks for an action never goes in a toast): REINTENTAR runs `retry`,
   * RECARGAR reloads, REINTENTA EN 1 MIN and CERRAR close it. A requeue asks nothing of the player (a
   * toast says it); over Settings or another sheet it is a toast as well.
   */
  failure(text: string, outcome: Outcome, retry?: () => void): void {
    // Nothing to try again here: the sheet only closes, and says so.
    const label = t(outcome === 'retry' && retry === undefined ? 'outcome.close' : OUTCOME_ACTION[outcome]);
    if (outcome === 'requeue' || this.settingsUp() || this.modalEl !== null || !this.visibleNow) {
      this.toast(outcome === 'requeue' ? `${text} · ${label}` : text, outcome === 'requeue' ? 'info' : 'error');
      return;
    }
    const canRetry = outcome === 'retry' && retry !== undefined;
    this.modal({
      title: text,
      body: [],
      actions: [
        {
          label,
          primary: true,
          onClick: () => {
            if (outcome === 'reload') location.reload();
            else if (canRetry) queueMicrotask(retry); // once the sheet is gone (a new one may follow)
          },
        },
        ...(canRetry ? [{ label: t('lobby.cancel'), onClick: () => true }] : []),
      ],
    });
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
    this.reportCover(); // the scene holds one frame under the sheet
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
      // Not when another sheet replaces this one (modal: the cover stays 'opaque').
      this.reportCover();
      this.measureCover();
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
