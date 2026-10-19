/**
 * The front-end menus: a top bar (brand, breadcrumb, region / players
 * online, the account chip), a stack of screens in the middle, a bottom bar with the key hints and
 * the matchmaking banner (search timer + cancel) that follows the player across screens. Screens
 * live in src/ui/screens/*; this file owns navigation (keyboard, controller through `action`, mouse),
 * the shared preferences (region, playlists, connection), population polling, toasts and modals.
 *
 * Touch mode (`tg-touch` on <html>, src/input/TouchControls.ts: the last input used was a finger)
 * adds a '‹' back button to the top bar and drops the key hints and focus rings (menu.css); the
 * menus then focus nothing by themselves (`autoFocus`), so no text field pops up the keyboard.
 *
 * The Game implements MenuHost (what the menus can ask of it) and calls show() / hide() /
 * action(); the menu never touches the sim or the renderer. Styling: src/ui/menu.css (`mn-`).
 */
import './menu.css';
import { h, setChildren, clock } from './dom';
import type { Child } from './dom';
import { FocusNav, isEditable, trackFocusClass } from './nav';
import type { NavDir } from './nav';
import { rankBadge, tierById } from './badges';
import { playlistName, regionName, tierName } from './names';
import { t } from '../i18n';
import type { AccountClient } from '../net/AccountClient';
import type { LobbyClient } from '../net/LobbyClient';
import type { TrainingRecordsView } from '../game/trainingStore';
import type { PopulationAnswer, RegionId } from '../net/account';
import { REGIONS, isRegion } from '../net/account';
import type { QueueResult } from '../net/protocol';
import type { QueueResultP2p } from '../net/p2p/protocol';
import type { GameMode } from '../sim/constants';
import type { Difficulty } from '../render/Hud';
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

/** What the menus need from the Game. */
export interface MenuHost {
  readonly accounts: AccountClient;
  readonly lobby: LobbyClient;
  /** Training records of the current player (guest: this browser; account: synced with the server). */
  readonly training: TrainingRecordsView;
  config(): Promise<MenuConfig>;
  /** The guest name (online as a guest) and its setter. */
  guestName(): string;
  setGuestName(name: string): void;
  /** A Bearer for API calls (account or guest). */
  bearer(): Promise<string>;
  readonly mode: GameMode;
  readonly difficulty: Difficulty;
  quality: 0 | 1;
  setQuality(q: 0 | 1): void;
  /** An offline friendly match against the bots. */
  playFriendly(mode: GameMode, difficulty: Difficulty): void;
  startTraining(id: string): void;
  search(req: SearchRequest): void;
  cancelSearch(): void;
  searchView(): SearchView;
  /** A custom lobby started: join this member's match. */
  playLobbyMatch(result: QueueResult | QueueResultP2p): void;
  /** The Controls & Settings screen (the Hud's); `onClose` when it is left. */
  openSettings(onClose: () => void): void;
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
}

export type ScreenFactory = (menu: Menu) => Screen;

interface ModalSpec {
  title: string;
  body: Child | Child[];
  actions: Array<{ label: string; primary?: boolean; onClick: () => void | boolean | Promise<void | boolean> }>;
  /** Esc / B closes it (default true). */
  dismissable?: boolean;
}

export class Menu {
  readonly host: MenuHost;
  readonly root: HTMLElement;
  prefs: MenuPrefs;
  /** Last /api/population answer for the selected region (null before the first, or offline). */
  population: PopulationAnswer | null = null;
  cfg: MenuConfig | null = null;

  private readonly stage: HTMLElement;
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
  private modalEl: HTMLElement | null = null;
  private modalDismiss: (() => void) | null = null;
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
    const top = h('header.mn-top', null, this.backButton, h('div.mn-brand', null, h('span.mn-brand-a', null, 'TURBO'), h('span.mn-brand-b', null, 'GOL')), this.crumbs, h('div.mn-top-right', null, this.online, this.chip));
    this.stage = h('main.mn-stage');
    this.banner = h('div.mn-banner', { hidden: true });
    this.hints = h('div.mn-hints');
    // AGPL-3.0 section 13: a network game offers its source to the players.
    const source = h('a.mn-source', { href: SOURCE_URL, target: '_blank', rel: 'noopener', title: t('menu.sourceTitle', { license: LICENSE_NAME }) }, t('menu.source'));
    const discord = h('a.mn-source', { href: DISCORD_URL, target: '_blank', rel: 'noopener', title: t('menu.discordTitle') }, 'Discord');
    // Narrow screens drop the build line (.mn-info-build), never the source link.
    const bottom = h('footer.mn-bottom', null, this.banner, this.hints, h('div.mn-info', null, h('span.mn-info-build', null, host.info, ' · '), source, ' · ', h('a.mn-source', { href: './third-party-licenses.txt', target: '_blank', rel: 'noopener' }, t('menu.licenses')), ' · ', discord));
    this.toasts = h('div.mn-toasts');
    this.modalLayer = h('div.mn-modal-layer', { hidden: true });
    this.root = h('div.mn', { hidden: true }, top, this.stage, bottom, this.toasts, this.modalLayer);
    // RMB is bindable in game: no context menu over the menus.
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    trackFocusClass(this.root);
    container.appendChild(this.root);
    this.nav = new FocusNav(() => this.modalEl ?? this.stack.at(-1)?.el ?? null);
    window.addEventListener('keydown', (e) => this.onKey(e));
    host.accounts.onChange = () => this.refreshChrome();
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

  back(): void {
    if (this.modalEl && this.modalDismiss) {
      this.modalDismiss();
      return;
    }
    const t = this.top();
    if (t?.back?.()) return;
    if (this.stack.length <= 1) return;
    t?.hide?.();
    this.stack.pop();
    this.mount();
  }

  private mount(): void {
    const top = this.top();
    if (!top) return;
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

  /** Refocus the first control of the current screen (after it rebuilt its content). */
  refocus(): void {
    this.autoFocus(true);
  }

  /**
   * On the next frame, focus the first control of the modal or the screen on top (`ifNone`: only
   * when nothing there has the focus), where the keyboard and the controller start from. Not in
   * touch mode: a focused text field would pop up the phone's keyboard and a finger needs no focus
   * ring. The controller still gets one there: FocusNav focuses the first control on its first
   * press (and a pad press leaves touch mode).
   */
  private autoFocus(ifNone = false): void {
    requestAnimationFrame(() => {
      if (touchMode()) return;
      if (ifNone && this.nav.current !== null) return;
      this.nav.first();
    });
  }

  // ---- input -----------------------------------------------------------------------------------

  private onKey(e: KeyboardEvent): void {
    if (!this.visibleNow || this.root.hidden) return;
    if (document.querySelector('.hud-settings-panel:not([hidden])')) return; // the Hud's settings screen owns the keys
    const editing = isEditable(document.activeElement);
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
        if (editing) (document.activeElement as HTMLElement).blur();
        this.back();
        return;
      case 'Backspace':
        if (!editing) {
          e.preventDefault();
          this.back();
        }
        return;
      default:
        return;
    }
    if (dir !== null) {
      e.preventDefault();
      this.nav.move(dir);
    }
  }

  /** Controller (and any other non-keyboard source) routed by the Game. */
  action(a: NavDir | 'accept' | 'back'): void {
    if (!this.visibleNow) return;
    if (a === 'accept') this.nav.accept();
    else if (a === 'back') this.back();
    else this.nav.move(a);
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
        h('button.mn-banner-cancel', { type: 'button', 'data-nav': true, onclick: () => this.host.cancelSearch() }, t('menu.searchCancel')),
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

  /** A modal dialog over the current screen; an action returning false keeps it open. Returns a closer. */
  modal(spec: ModalSpec): () => void {
    this.closeModal();
    const close = (): void => {
      if (this.modalEl === box) this.closeModal();
    };
    const actions = h('div.mn-modal-actions');
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
    const box = h('div.mn-modal', { role: 'dialog', 'aria-label': spec.title }, h('div.mn-modal-title', null, spec.title), h('div.mn-modal-body', null, ...body), actions);
    this.modalEl = box;
    this.modalDismiss = spec.dismissable === false ? () => undefined : close;
    setChildren(this.modalLayer, box);
    this.modalLayer.hidden = false;
    this.autoFocus();
    return close;
  }

  private closeModal(): void {
    if (!this.modalEl) return;
    this.modalEl = null;
    this.modalDismiss = null;
    this.modalLayer.hidden = true;
    this.modalLayer.textContent = '';
    this.refocus();
  }

  get modalOpen(): boolean {
    return this.modalEl !== null;
  }
}
