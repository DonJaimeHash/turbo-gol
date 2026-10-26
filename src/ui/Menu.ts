/**
 * The front-end menus: a top bar (brand, breadcrumb, region / players
 * online, the account chip), a stack of screens in the middle, a bottom bar with the key hints and
 * the matchmaking banner (search timer + cancel) that follows the player across screens. Screens
 * live in src/ui/screens/*; this file owns navigation (keyboard, controller through `action`, mouse),
 * the shared preferences (region, playlists, connection), population polling, toasts and modals.
 *
 * Touch mode (`tg-touch` on <html>, src/input/TouchControls.ts: the last input used was a finger)
 * adds a '‹' back button to the top bar and drops the key hints and focus rings (menu.css); the
 * menus then focus nothing by themselves (`autoFocus`), so no text field pops up the keyboard, and
 * a tap that began before a screen or a modal came up (or within TAP_GUARD_MS after) presses
 * nothing on it (src/ui/device.ts tapGuarded).
 *
 * Focus (src/ui/nav.ts): three zones, the top bar, the stage and the footer (a modal alone while it
 * is up); the last focus is remembered per screen (FocusMemory, by element or `data-key`), so going
 * back to a screen, or closing a modal, puts it where it was (`data-autofocus` counts on a first
 * visit only). Esc / B / Back (`back`): the modal closes, else a field being edited stops editing,
 * else the screen's own back, else the screen pops. Shortcuts (`MenuCommand`): Q / E, pad LB / RB
 * and LT / RT (a screen's own tabs first, then the sections the shell brings), keyboard X / pad Y
 * cancel the search, pad Start opens the settings, pad X / Delete the screen's context action.
 *
 * The Game implements MenuHost (what the menus can ask of it) and calls show() / hide() /
 * action(); the menu never touches the sim or the renderer. Styling: src/ui/menu.css (`mn-`).
 */
import './menu.css';
import { h, setChildren, clock } from './dom';
import type { Child } from './dom';
import { FocusMemory, FocusNav, isEditable, isEditing, navKey, setEditing } from './nav';
import type { NavDir, NavZone } from './nav';
import { finePointer, tapGuarded } from './device';
import { rankBadge, tierById } from './badges';
import { playlistName, regionName, tierName } from './names';
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
import { DISCORD_URL, LICENSE_NAME, SOURCE_URL, STORAGE_PREFIX } from '../brand';

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
   * on `opts.tab` when given; `onClose` when it is left.
   */
  openSettings(onClose: () => void, opts?: { tab?: SettingsTab }): void;
  /** The key / button name of an action's live binding on `device`, for a hint text ('—' unbound). */
  keyLabel(action: ActionId, device: Device): string;
  /** One line about the build (WebGPU / RocketSim version), shown in the footer. */
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
const TICK_MS = 250;
/** The navigation keys in the hint line (key names stay untranslated). */
const NAV_KEYS = { moveKeys: '↑↓←→ / D-pad', selectKeys: 'Enter / A', backKeys: 'Esc / B' };

/** Touch mode: the last input used was a finger (`tg-touch` on <html>, set by src/input/TouchControls.ts). */
function touchMode(): boolean {
  return document.documentElement.classList.contains('tg-touch');
}

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
 * RB, keyboard Q / E without tabs of the screen's own: the sections, from the Tablero shell on),
 * 'tabPrev' / 'tabNext' (pad LT / RT, keyboard Q / E: a screen's own tabs), 'cancel' (pad Y,
 * keyboard X: cancel the search), 'menu' (pad Start: the settings), 'context' (pad X, Delete: the
 * screen's context action).
 */
export type MenuCommand = 'prev' | 'next' | 'tabPrev' | 'tabNext' | 'cancel' | 'menu' | 'context';

/** One screen of the stack. `el` is built once; show / hide / tick are optional. */
export interface Screen {
  readonly id: string;
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
}

export type ScreenFactory = (menu: Menu) => Screen;

interface ModalSpec {
  title: string;
  body: Child | Child[];
  actions: Array<{ label: string; primary?: boolean; onClick: () => void | boolean | Promise<void | boolean> }>;
  /** Esc / B closes it (default true). */
  dismissable?: boolean;
  /** Called once when it closes, however (an action, Esc / B, another modal, the menus hiding). */
  onClose?: () => void;
}

export class Menu {
  readonly host: MenuHost;
  readonly root: HTMLElement;
  prefs: MenuPrefs;
  /** Last /api/population answer for the selected region (null before the first, or offline). */
  population: PopulationAnswer | null = null;
  cfg: MenuConfig | null = null;

  private readonly stage: HTMLElement;
  private readonly topBar: HTMLElement;
  private readonly bottomBar: HTMLElement;
  private readonly crumbs: HTMLElement;
  private readonly chip: HTMLElement;
  private readonly backButton: HTMLButtonElement;
  private readonly online: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly hints: HTMLElement;
  private readonly toasts: HTMLElement;
  private readonly modalLayer: HTMLElement;
  private readonly screens = new Map<string, Screen>();
  private readonly factories = new Map<string, ScreenFactory>();
  private stack: Screen[] = [];
  private readonly nav: FocusNav;
  /** Last focus: 'last:<screen>' anywhere while that screen was on top, 'stage:<screen>' on its stage, 'top' / 'bottom' in the bars. */
  private readonly memory = new FocusMemory<HTMLElement>();
  private modalEl: HTMLElement | null = null;
  private modalDismiss: (() => void) | null = null;
  private modalOnClose: (() => void) | null = null;
  /** What had the focus when the modal opened: it gets it back when the modal closes. */
  private modalOpener: HTMLElement | null = null;
  /** performance.now() of the last screen or modal mounted (or modal closed): the tap guard's reference. */
  private mountedAt = -Infinity;
  /** The last finger / pen down and up (performance.now()), for the tap guard. */
  private touchDownAt = -Infinity;
  private touchUpAt = -Infinity;
  /** A keydown the fields' capture listener already handled (onKey leaves it). */
  private keyDone: Event | null = null;
  private timer = 0;
  private popAt = 0;
  private lastError: string | null = null;
  private bannerKey = '';
  private visibleNow = false;

  constructor(host: MenuHost, container: HTMLElement) {
    this.host = host;
    this.prefs = loadPrefs();
    this.crumbs = h('div.mn-crumbs');
    this.online = h('button.mn-online', { type: 'button', 'data-nav': true, onclick: () => this.open('play') });
    this.chip = h('button.mn-chip', { type: 'button', 'data-nav': true, onclick: () => this.open('profile') });
    // Touch mode only (menu.css): a finger has no Esc / B. On the home screen it is hidden but keeps
    // its place (mount), so the brand does not move when a screen opens.
    this.backButton = h('button.mn-back', { type: 'button', title: t('menu.back'), 'aria-label': t('menu.back'), onclick: () => this.back() }, '‹');
    this.topBar = h('header.mn-top', null, this.backButton, h('div.mn-brand', null, h('span.mn-brand-a', null, 'TURBO'), h('span.mn-brand-b', null, 'GOL')), this.crumbs, h('div.mn-top-right', null, this.online, this.chip));
    this.stage = h('main.mn-stage');
    this.banner = h('div.mn-banner', { hidden: true });
    this.hints = h('div.mn-hints');
    // AGPL-3.0 section 13: a network game offers its source to the players. The links are focus
    // targets of the footer zone (↓ past the stage's last control), so a controller reaches them too.
    const link = (href: string, text: string, title?: string): HTMLAnchorElement => h('a.mn-source', { href, target: '_blank', rel: 'noopener', title, 'data-nav': true }, text);
    const source = link(SOURCE_URL, t('menu.source'), t('menu.sourceTitle', { license: LICENSE_NAME }));
    const discord = link(DISCORD_URL, 'Discord', t('menu.discordTitle'));
    // Narrow screens drop the build line (.mn-info-build), never the source link.
    this.bottomBar = h('footer.mn-bottom', null, this.banner, this.hints, h('div.mn-info', null, h('span.mn-info-build', null, host.info, ' · '), source, ' · ', link('./third-party-licenses.txt', t('menu.licenses')), ' · ', discord));
    this.toasts = h('div.mn-toasts');
    this.modalLayer = h('div.mn-modal-layer', { hidden: true });
    this.root = h('div.mn', { hidden: true }, this.topBar, this.stage, this.bottomBar, this.toasts, this.modalLayer);
    // RMB is bindable in game: no context menu over the menus.
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    container.appendChild(this.root);
    this.nav = new FocusNav(() => this.zones(), {
      remembered: (zone, targets) => this.memory.recall(zone.name === 'stage' ? 'stage:' + (this.top()?.id ?? '') : zone.name, targets, navKey),
      restore: () => this.restoreFocus(),
      onFocus: (el, zone) => this.noteFocus(el, zone),
    });
    this.nav.install(this.root);
    // Capture, before a field's own Enter (custom.ts JOIN, profile.ts sign-in): the fields' modes.
    this.root.addEventListener('keydown', (e) => this.onFieldKey(e), true);
    this.installTapGuard();
    window.addEventListener('keydown', (e) => this.onKey(e));
    host.accounts.subscribe(() => this.refreshChrome());
    void host
      .config()
      .then((c) => {
        this.cfg = c;
        this.populationNow();
        this.refreshChrome();
        if (this.visibleNow) this.top()?.show?.();
      })
      .catch(() => {
        this.cfg = { regions: REGIONS, autoRegion: '', oauth: [], online: false };
      });
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
    if (this.stack.length === 0) this.stack = [this.screen('home')];
    if (screenId !== undefined) this.open(screenId, true);
    this.root.hidden = false;
    this.root.parentElement?.classList.add('mn-open'); // menu.css hides the in-game HUD behind it
    this.visibleNow = true;
    this.mount();
    if (this.timer === 0) this.timer = window.setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  hide(): void {
    this.root.hidden = true;
    this.root.parentElement?.classList.remove('mn-open');
    this.visibleNow = false;
    this.closeModal();
    if (this.timer !== 0) {
      window.clearInterval(this.timer);
      this.timer = 0;
    }
    this.top()?.hide?.();
  }

  /** Push screen `id` (or bring it back to the top when it is already in the stack; `reset` = from home). */
  open(id: string, reset = false): void {
    const s = this.screen(id);
    this.top()?.hide?.();
    if (reset) this.stack = id === 'home' ? [s] : [this.screen('home'), s];
    else {
      const i = this.stack.indexOf(s);
      if (i >= 0) this.stack.length = i + 1;
      else this.stack.push(s);
    }
    if (this.visibleNow) this.mount();
  }

  /** Replace the top screen (a form that turns into its result). */
  replace(id: string): void {
    this.top()?.hide?.();
    this.stack.pop();
    this.open(id);
  }

  /**
   * Esc / B / the '‹' button / the system Back (Game.onSystemBack): close the modal (unless it is not
   * dismissable), else stop editing the field being edited (in touch mode that step is skipped: a
   * finger's field has no navigation mode to go back to, and Android's first Back already hid the
   * keyboard), else the screen's own back, else pop one screen. False when there was nothing to go
   * back from (the home screen, no modal): the system Back then asks to leave the game.
   */
  back(): boolean {
    if (this.modalEl && this.modalDismiss) {
      this.modalDismiss();
      return true;
    }
    const a = document.activeElement;
    if (a instanceof HTMLElement && isEditing(a) && this.root.contains(a)) {
      setEditing(a, false);
      if (!touchMode()) return true;
      a.blur();
    }
    const t = this.top();
    if (t?.back?.()) return true;
    if (this.stack.length <= 1) return false;
    t?.hide?.();
    this.stack.pop();
    this.mount();
    return true;
  }

  private mount(): void {
    const top = this.top();
    if (!top) return;
    this.mountedAt = performance.now();
    this.nav.reset();
    setChildren(this.stage, top.el);
    // A screen opens at its top. With the keyboard / pad the first control's focus scrolls there
    // (autoFocus); touch mode focuses nothing, and the stage would keep the last screen's offset.
    if (touchMode()) this.stage.scrollTop = 0;
    setChildren(this.crumbs, ...this.stack.slice(1).flatMap((s, i) => [i > 0 ? h('span.mn-crumb-sep', null, '›') : null, h('span.mn-crumb', null, s.title)]));
    this.hints.textContent = t(this.stack.length > 1 ? 'menu.hintsBack' : 'menu.hints', NAV_KEYS);
    this.backButton.classList.toggle('mn-back-off', this.stack.length <= 1);
    top.show?.();
    this.refreshChrome();
    this.autoFocus();
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
   * The modal's first control; else the control focused last on the screen on top (anywhere, then
   * on its stage, by element or `data-key`); else its `data-autofocus` or first one (a first visit).
   * Without a fine pointer a text field is never the first (the system keyboard would come up).
   */
  private restoreFocus(): void {
    const skipFields = !finePointer();
    if (this.modalEl !== null) {
      this.nav.first(skipFields);
      return;
    }
    const top = this.top();
    if (top === null) return;
    const targets = this.nav.targets();
    const el = this.memory.recall('last:' + top.id, targets, navKey) ?? this.memory.recall('stage:' + top.id, targets, navKey);
    if (el !== null) this.nav.focus(el);
    else this.nav.first(skipFields);
  }

  /** The focus zones (nav.ts): a modal alone, else the top bar, the stage and the footer. */
  private zones(): NavZone[] {
    if (this.modalEl !== null) return [{ name: 'modal', el: this.modalEl, main: true }];
    return [
      { name: 'top', el: this.topBar },
      { name: 'stage', el: this.stage, main: true },
      { name: 'bottom', el: this.bottomBar },
    ];
  }

  /** A menu control got the focus: remember it for the screen on top and for its zone. */
  private noteFocus(el: HTMLElement, zone: NavZone | null): void {
    const top = this.top();
    if (zone === null || zone.name === 'modal' || top === null) return;
    const key = navKey(el);
    this.memory.remember('last:' + top.id, el, key);
    this.memory.remember(zone.name === 'stage' ? 'stage:' + top.id : zone.name, el, key);
  }

  /**
   * Touch: a tap whose finger went down before the last screen or modal was mounted, or within
   * TAP_GUARD_MS after (device.ts), is no click on it (a double tap on a tile would press what the
   * next screen has under it; a modal that came up under a finger). Trusted pointer clicks only:
   * Enter / Space and the controller's A (FocusNav.accept: el.click()) always go through.
   */
  private installTapGuard(): void {
    const finger = (e: Event): boolean => {
      const p = (e as PointerEvent).pointerType;
      return p === 'touch' || p === 'pen';
    };
    this.root.addEventListener('pointerdown', (e) => {
      if (finger(e)) this.touchDownAt = performance.now();
    }, true);
    this.root.addEventListener('pointerup', (e) => {
      if (finger(e)) this.touchUpAt = performance.now();
    }, true);
    this.root.addEventListener(
      'click',
      (e) => {
        if (!e.isTrusted || (e as MouseEvent).detail === 0) return; // a key's or FocusNav's click
        const p = (e as PointerEvent).pointerType;
        // Older engines' clicks are plain MouseEvents: a finger's when one just lifted.
        const byFinger = p === 'touch' || p === 'pen' || (p === undefined && performance.now() - this.touchUpAt < 800);
        if (byFinger && tapGuarded(this.touchDownAt, this.mountedAt)) {
          e.preventDefault();
          e.stopImmediatePropagation();
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
    if (e.ctrlKey || e.metaKey || e.altKey) return;
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
    if (document.querySelector('.hud-settings-panel:not([hidden])')) return; // the Hud's settings screen owns the keys
    if (e.altKey) return; // Alt + ← is the browser's Back: the system Back goes back (BackGuard), the focus stays
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
        this.back();
        return;
      case 'Backspace':
        if (!field) {
          e.preventDefault();
          this.back();
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
      this.nav.move(dir, e.repeat);
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
    else if (a === 'back') this.back();
    else if (a === 'up' || a === 'down' || a === 'left' || a === 'right') this.nav.move(a, repeat);
    else this.command(a);
  }

  /**
   * A shortcut: the screen on top first (Screen.command), else the menus' own: 'cancel' cancels the
   * search, 'menu' opens the settings. The sections ('prev' / 'next') arrive with the Tablero
   * shell. False when nothing took it. Nothing while a modal is up (it keeps the focus).
   */
  command(c: MenuCommand): boolean {
    if (!this.visibleNow || this.modalEl !== null) return false;
    if (this.top()?.command?.(c)) return true;
    if (c === 'cancel' && this.host.searchView().active) {
      this.host.cancelSearch();
      return true;
    }
    if (c === 'menu') {
      this.host.openSettings(() => this.refocus());
      return true;
    }
    return false;
  }

  // ---- chrome: top bar, banner, population ---------------------------------------------------

  refreshChrome(): void {
    const acc = this.host.accounts;
    const me = acc.me;
    let best: string | null = null;
    if (me) {
      const placed = me.ratings.filter((r) => r.tier !== null).sort((a, b) => b.mmr - a.mmr);
      best = placed[0]?.tier ?? null;
    }
    if (acc.signedIn && acc.account) {
      const bestTier = tierById(best);
      setChildren(this.chip, rankBadge(bestTier, 30), h('span.mn-chip-text', null, h('b', null, acc.account.name), h('small', null, best ? bestTier && tierName(bestTier) : t('menu.account'))));
    } else {
      setChildren(this.chip, h('span.mn-chip-avatar', null, '?'), h('span.mn-chip-text', null, h('b', null, this.host.guestName()), h('small', null, t('menu.guestSignIn'))));
    }
    const p = this.population;
    setChildren(this.online, h('span.mn-dot', { class: p ? 'on' : '' }), h('span', null, this.regionLabel), p ? h('small', null, t('menu.playing', { count: p.playing })) : null);
  }

  private async pollPopulation(): Promise<void> {
    if (!this.cfg?.online) return;
    try {
      const q = this.prefs.region ? '?region=' + this.prefs.region : '';
      const res = await fetch('/api/population' + q, { credentials: 'same-origin' });
      if (res.ok) this.population = (await res.json()) as PopulationAnswer;
    } catch {
      this.population = null;
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
    this.renderBanner(now);
    this.top()?.tick?.(now);
  }

  private renderBanner(now: number): void {
    const v = this.host.searchView();
    if (v.error !== null && v.error !== this.lastError) this.toast(v.error, 'error');
    this.lastError = v.error;
    if (!v.active) {
      if (!this.banner.hidden) {
        this.banner.hidden = true;
        this.bannerKey = '';
      }
      return;
    }
    const key = v.kind + v.modes.join();
    if (key !== this.bannerKey) {
      this.bannerKey = key;
      setChildren(
        this.banner,
        h('span.mn-spinner'),
        h('span.mn-banner-kind', null, v.kind === 'ranked' ? t('menu.searchRanked') : t('menu.searchCasual')),
        h('span.mn-banner-modes', null, v.modes.map((m) => playlistName(m)).join(' · ')),
        h('span.mn-banner-time'),
        h('span.mn-banner-text'),
        // The footer zone's entry: ↓ past the stage's last control lands on it while a search runs.
        h('button.mn-banner-cancel', { type: 'button', 'data-nav': true, 'data-nav-entry': true, onclick: () => this.host.cancelSearch() }, t('menu.searchCancel')),
      );
    }
    this.banner.hidden = false;
    (this.banner.querySelector('.mn-banner-time') as HTMLElement).textContent = clock(now - v.since);
    (this.banner.querySelector('.mn-banner-text') as HTMLElement).textContent = v.text;
  }

  // ---- toasts / modals --------------------------------------------------------------------------

  toast(text: string, kind: 'info' | 'error' | 'ok' = 'info'): void {
    const t = h(`div.mn-toast.mn-toast-${kind}`, null, text);
    this.toasts.appendChild(t);
    window.setTimeout(() => t.classList.add('out'), 4200);
    window.setTimeout(() => t.remove(), 4800);
  }

  /**
   * A modal dialog over the current screen; an action returning false keeps it open. Returns a
   * closer. While it is up the rest of the menus is inert (no focus, no click, no screen reader),
   * and when it closes the focus goes back to what had it when it opened (the tile that opened it).
   */
  modal(spec: ModalSpec): () => void {
    const prev = this.modalEl !== null ? this.modalOpener : null;
    this.closeModal(false);
    const a = document.activeElement;
    this.modalOpener = prev ?? (a instanceof HTMLElement && a !== document.body && this.root.contains(a) ? a : null);
    const close = (): void => {
      if (this.modalEl === box) this.closeModal();
    };
    const actions = h('div.mn-modal-actions', { 'data-nav-row': true });
    for (const a of spec.actions) {
      const b = h(`button.mn-btn${a.primary ? '.mn-btn-primary' : ''}` as 'button', { type: 'button', 'data-nav': true }, a.label);
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          const r = await a.onClick();
          if (r !== false) close();
        } finally {
          b.disabled = false;
        }
      });
      actions.appendChild(b);
    }
    const body = Array.isArray(spec.body) ? spec.body : [spec.body];
    const box = h('div.mn-modal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': spec.title }, h('div.mn-modal-title', null, spec.title), h('div.mn-modal-body', null, ...body), actions);
    this.modalEl = box;
    this.modalDismiss = spec.dismissable === false ? () => undefined : close;
    this.modalOnClose = spec.onClose ?? null;
    setChildren(this.modalLayer, box);
    this.modalLayer.hidden = false;
    this.setBackgroundInert(true);
    this.mountedAt = performance.now();
    this.nav.reset();
    this.autoFocus();
    return close;
  }

  /** The menus under a modal: inert while it is up (the focus cannot leave it, a click on them does nothing). */
  private setBackgroundInert(on: boolean): void {
    this.topBar.inert = on;
    this.stage.inert = on;
    this.bottomBar.inert = on;
  }

  /**
   * Close the modal; `refocus`: give the focus back to what had it when the modal opened (when it
   * is still there; else the screen's remembered one, restoreFocus). Not when another modal replaces it.
   */
  private closeModal(refocus = true): void {
    if (!this.modalEl) return;
    const onClose = this.modalOnClose;
    const opener = this.modalOpener;
    this.modalEl = null;
    this.modalDismiss = null;
    this.modalOnClose = null;
    this.modalOpener = null;
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
}
