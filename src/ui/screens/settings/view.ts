/**
 * Ajustes (the Tablero plan PR 10, the owner's hub-ajustes-pc, dir-hub §6.9): one component for the
 * menus (screen.ts, a stacked mn- screen) and the pause (overlay.ts, z 60). A rail of six tabs and
 * the tab's page, every setting of the old Hud screen with its saved key and value:
 *
 * - CONTROLES: a section per device detected (TÁCTIL, CONTROL, TECLADO Y MOUSE; an mn-seg picks one
 *   when there are more, the last input's first), its sensitivities first, then its bindings
 *   (mn-bind: the key or button cell, A captures it, ✕ / Delete / pad X clears it; Esc cancels a
 *   capture, a controller's B held 1 s too, Input.ts; another action on the same key is said, not
 *   swapped) and its layouts. TÁCTIL: the hold-JUMP switch, then the controls' size, opacity, side,
 *   stick, deadzone and vibration (settings.touch; vibration only where the browser can).
 * - CÁMARA: the presets by name (the default marked), then the sliders with the default's mark.
 * - JUEGO: the rest of the old Gameplay rows, then INTERFAZ: the language (the menus only: a picker
 *   sheet, a reload), the interface size (the sizes the layout class lists) and reduced motion
 *   (settings.ui, src/ui/device.ts); its reset. AUDIO: the master volume and its reset.
 * - GRÁFICOS: Performance, High and Ultra as cards (quality.ts CARD_QUALITIES); the running one
 *   always lit (ACTUAL); ◀ ▶ only move the focus, A applies; the old tier comes back by itself 10 s
 *   later unless kept (a tier that reloads the page has no trial: it restarts). Then OPCIONES: the
 *   resolution scale, the frame limit, the menus' animated stadium and the Super low switch
 *   (everyone's; A only: it restarts the game, online once the match is left); RESTABLECER
 *   GRÁFICOS puts the three options back (the tier is a pick of its own).
 * - EXPERIMENTAL: src/render/experimentalPage.ts through expKit.ts; a guest gets its locked line and,
 *   in the menus, SIGN IN (PERFIL as a detour: a sign-in comes back here).
 *
 * Under the rail, "Se guarda solo": every change is saved at once, in this browser.
 *
 * Back, inside: a capture cancels, then the focus goes from the page to its tab; the host closes it
 * after (backModel's sheet and field steps are the host's). Built on the first open; nothing runs
 * per frame (a 500 ms timer while open and in sight: the controller's status, the trial's clock).
 */
import { h, navButton, setChildren } from '../../dom';
import { LOCALES, savedLanguage, systemLanguage, t, type Key } from '../../../i18n';
import { ACTION_ROWS, bindingsEqual, type ActionId, type Binding, type BindingPreset, type Device } from '../../../input/bindings';
import {
  CAMERA_RANGES,
  CLASSIC_CAMERA_DEFAULTS,
  CONTROL_RANGES,
  DEFAULT_AUDIO,
  DEFAULT_CAMERA,
  DEFAULT_CONTROL_SETTINGS,
  DEFAULT_TOUCH,
  DEFAULT_UI,
  TOUCH_DEADZONE_RANGE,
  TOUCH_OPACITY_RANGE,
  VOLUME_RANGE,
  type ControlSettings,
  type MotionPref,
  type Settings,
  type TouchSize,
} from '../../../settings';
import type { CameraSettings } from '../../../render/Camera';
import { CARD_QUALITIES, DEFAULT_RESOLUTION_SCALE, RESOLUTION_SCALE_RANGE, needsReload, type FpsCap, type Quality } from '../../../render/quality';
import { canVibrate } from '../../../input/TouchControls';
import { buildExperimentalPage, type ExperimentalOptions, type ExperimentalPage } from '../../../render/experimentalPage';
import { icon } from '../../components/icons';
import { glyph } from '../../components/glyphs';
import { seg, type Seg } from '../../components/seg';
import { setRow, slider, toggleSwitch, type Slider, type Switch } from '../../components/rows';
import { finePointer, interfaceSize, interfaceSizes, layoutClass, type InputKind, type LayoutClass } from '../../device';
import { experimentalKit, pageItemOf } from './expKit';
import {
  SETTINGS_TABS,
  bindConflict,
  cameraPresetOf,
  controlSections,
  experimentalTabLabel,
  keptSection,
  memoryTag,
  openingSection,
  qualityLine,
  startTrial,
  stepSettingsTab,
  trialSecondsLeft,
  type CameraPreset,
  type ControlSection,
  type QualityTrial,
  type SettingsTab,
} from './model';

/** Rebinding (Input), as the settings need it. */
export interface RebindSource {
  getBinding(action: ActionId, device: Device): Binding | null;
  getLabel(action: ActionId, device: Device): string;
  startRebind(action: ActionId, device: Device, wheelTarget?: EventTarget | null): Promise<Binding | null>;
  /** Abort the pending capture (its promise resolves with null). */
  cancelRebind(): void;
  setBinding(action: ActionId, device: Device, b: Binding | null): void;
  resetBindings(device: Device, preset?: BindingPreset): void;
  /** settings.controls changed (sensitivities, deadzones, mouse steering, vibration...). */
  settingsChanged(): void;
  readonly hasGamepad: boolean;
  readonly gamepadName: string | null;
}

/** What Ajustes works on, from the Game (Game.settingsOptions), read on every open and refresh. */
export interface SettingsOptions {
  /** The tier lit: the running one, or a pick waiting for the online match to end. */
  readonly quality: Quality;
  /** The tiers shown as cards (quality.ts CARD_QUALITIES: Super low is the switch under them). */
  readonly qualities: readonly Quality[];
  /** The line while the running tier is no card (a device on Super low by itself; '' for the player's own pick). */
  readonly qualityNote: string;
  /** A pick that waits for the online match to end (it reloads the page), or null. */
  readonly pending: Quality | null;
  /** Absent: the guest's locked line. */
  readonly experimental?: ExperimentalOptions;
  /** The live settings: the rows write into it in place. */
  readonly settings: Settings;
  readonly input: RebindSource;
  /** After every change (a slider, a switch, a binding, a preset, a reset): saved and applied. */
  onSettingsChanged(): void;
  /** A camera preset was copied into settings.camera (the projection follows). */
  onCameraPreset(): void;
  /** A tier picked: switched behind the loading screen (settled when it is done). */
  onQualityChange(q: Quality): Promise<void>;
  /** The Super low switch: on restarts into it, off back to Performance (or drops a pick still waiting for the online match). */
  onSuperlow(on: boolean): Promise<void>;
  /** GRÁFICOS' options (the Game's prefs). */
  graphics(): { readonly resolutionScale: number; readonly fpsCap: FpsCap; readonly menuSceneAnimated: boolean };
  setResolutionScale(pct: number): void;
  setFpsCap(cap: FpsCap): void;
  setMenuSceneAnimated(on: boolean): void;
}

/** What the host gives the view. */
export interface SettingsHooks {
  /** 'menu': a Menu screen (SIGN IN on a guest's EXPERIMENTAL); 'pause': over the pause. */
  readonly place: 'menu' | 'pause';
  /** Focus `el` as the arrows do (the host's FocusNav). */
  focus(el: HTMLElement): void;
  /** A row came or went under the focus: the host puts it back on the screen. */
  refocus(): void;
  /** A guest's SIGN IN (the menus: PERFIL as a detour). */
  signIn?(): void;
  /** JUEGO's language picker (the menus only: the change reloads the page). */
  language?(): void;
}

const QUALITY_HINTS: Readonly<Record<Quality, Key>> = {
  superlow: 'settings.qualitySuperlowHint',
  low: 'settings.qualityLowHint',
  high: 'settings.qualityHighHint',
  ultra: 'settings.qualityUltraHint',
};

/** Bars lit on a card (the artboard's three slanted bars). */
const QUALITY_BARS: Readonly<Record<Quality, number>> = { superlow: 0, low: 1, high: 2, ultra: 3 };

const GROUP_TITLES: Readonly<Record<'driving' | 'air' | 'camera' | 'game', Key>> = {
  driving: 'settings.groupDriving',
  air: 'settings.groupAir',
  camera: 'settings.groupCamera',
  game: 'settings.groupGame',
};

const SECTION_LABELS: Readonly<Record<ControlSection, Key>> = {
  touch: 'settings.tabTouch',
  pad: 'settings.tabPad',
  kbm: 'settings.tabKbm',
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

/** The old Gameplay rows, by where they act: a device's section, or JUEGO for every device. */
const CONTROL_ROWS: Readonly<Record<ControlSection | 'game', ReadonlyArray<{ key: keyof ControlSettings; label: Key }>>> = {
  touch: [{ key: 'touchHoldJump', label: 'settings.touchHoldJump' }],
  pad: [
    { key: 'controllerDeadzone', label: 'settings.controllerDeadzone' },
    { key: 'dodgeDeadzone', label: 'settings.dodgeDeadzone' },
    { key: 'vibration', label: 'settings.vibration' },
  ],
  kbm: [
    { key: 'mouseSensitivity', label: 'settings.mouseSensitivity' },
    { key: 'mouseSteering', label: 'settings.mouseSteering' },
    { key: 'mouseSteeringSensitivity', label: 'settings.mouseSteeringSensitivity' },
  ],
  game: [
    { key: 'steeringSensitivity', label: 'settings.steeringSensitivity' },
    { key: 'aerialSensitivity', label: 'settings.aerialSensitivity' },
    { key: 'invertAirPitch', label: 'settings.invertAirPitch' },
  ],
};

/** TÁCTIL's sizes, in order. */
const TOUCH_SIZES: readonly TouchSize[] = ['S', 'M', 'L'];

/** Every interface size a class may list (device.ts interfaceSizes): the seg shows its class's. */
const ALL_UI_SIZES: readonly number[] = [100, 115, 125, 130, 150];

/** The camera presets' values (field of view / distance / height), shown after their names. */
const PRESET_VALUES: Readonly<Record<CameraPreset, string>> = { default: '110/270/100', classic: '90/270/100' };

interface BindRow {
  readonly action: ActionId;
  readonly device: Device;
  readonly row: HTMLElement;
  readonly cell: HTMLButtonElement;
}

/** The layout class now (device.ts, `data-layout` on <html>; before it is set, from the window). */
function layoutNow(): LayoutClass {
  const v = document.documentElement.dataset.layout;
  return v === 'pc' || v === 'short' || v === 'phone' || v === 'portrait' || v === 'tablet' || v === 'tv' ? v : layoutClass(window.innerWidth, window.innerHeight, false);
}

/** The last input (device.ts, `data-input` on <html>). */
function lastInput(): InputKind {
  const v = document.documentElement.dataset.input;
  return v === 'pad' || v === 'remote' || v === 'keyboard' || v === 'touch' ? v : 'mouse';
}

const touchMode = (): boolean => document.documentElement.classList.contains('tg-touch');

const setText = (el: HTMLElement, text: string): void => {
  if (el.textContent !== text) el.textContent = text;
};

export class SettingsView {
  readonly el: HTMLElement;
  private readonly options: () => SettingsOptions;
  private readonly hooks: SettingsHooks;
  private opts: SettingsOptions | null = null;
  private built = false;
  private openNow = false;
  /** Open but out of sight (suspend): under PERFIL's detour, or the menus hidden by a match. */
  private held = false;
  private tab: SettingsTab = 'controls';
  private onClose: (() => void) | null = null;
  private timer = 0;
  /** Opened, and nothing of it focused yet (the rail's focus listener). */
  private firstFocus = false;

  /** The rail of tabs and the page (the overlay's focus zones). */
  readonly rail: HTMLElement;
  readonly page: HTMLElement;
  private readonly tabButtons = new Map<SettingsTab, HTMLButtonElement>();
  private readonly expLock: HTMLElement;
  private readonly title: HTMLElement;
  private readonly sub: HTMLElement;
  private readonly headActions: HTMLElement;
  private readonly body: HTMLElement;
  private readonly pages = new Map<SettingsTab, HTMLElement>();
  private readonly pageActions = new Map<SettingsTab, HTMLElement | null>();
  private readonly refreshers: Array<() => void> = [];

  // CONTROLES
  private section: ControlSection = 'kbm';
  /** The player picked the section (its mn-seg): kept while shown; else it follows the last input. */
  private sectionPicked = false;
  private sections: ControlSection[] = [];
  private sectionSeg: Seg<ControlSection> | null = null;
  private readonly sectionSlot = h('div.mn-set-secseg');
  private readonly sectionEls = new Map<ControlSection, HTMLElement>();
  private readonly bindRows: BindRow[] = [];
  private readonly conflictLines = new Map<Device, HTMLElement>();
  private capture: BindRow | null = null;
  private padStatus: HTMLElement | null = null;
  private padKey = '';

  // GRÁFICOS
  private readonly cards = new Map<Quality, { el: HTMLButtonElement; tag: HTMLElement }>();
  private uiSizes: Seg<number> | null = null;
  private uiSizeRow: HTMLElement | null = null;
  private langValue: HTMLElement | null = null;
  private readonly savedLine: HTMLElement;
  private qualityLine: HTMLElement | null = null;
  private trialBar: HTMLElement | null = null;
  private trialText: HTMLElement | null = null;
  private trialRevert: HTMLButtonElement | null = null;
  private trialKeep: HTMLButtonElement | null = null;
  private trial: QualityTrial | null = null;
  /** A tier being switched to from a card (the loading screen is up): the cards wait. */
  private switching = false;

  // EXPERIMENTAL
  private exp: ExperimentalPage | null = null;
  private expSignIn: HTMLButtonElement | null = null;
  /** A guest's SIGN IN opened PERFIL: a sign-in there comes back here (refresh). */
  waitingSignIn = false;

  constructor(options: () => SettingsOptions, hooks: SettingsHooks) {
    this.options = options;
    this.hooks = hooks;
    for (const tab of SETTINGS_TABS) {
      const label = h('span.mn-set-tab-name', { 'data-fit': '14' }, t(tab.label));
      const b = h(
        'button.mn-tab.mn-set-tab',
        { type: 'button', role: 'tab', 'aria-selected': 'false', 'data-nav': true, 'data-key': 'set-tab-' + tab.id, onclick: () => this.selectTab(tab.id) },
        icon(tab.icon),
        h('span.mn-set-tab-text', null, label),
        h('span.mn-set-tab-mark', { 'aria-hidden': 'true' }),
      );
      // Focus = selection with the arrows (the page follows the rail); a pointer's click picks. The
      // host's first focus of an open lands on the tab it opened on, not the one remembered.
      b.addEventListener('focus', () => {
        const first = this.firstFocus;
        this.firstFocus = false;
        if (touchMode() || !this.openNow || this.tab === tab.id) return;
        if (first) this.hooks.focus(this.activeTab);
        else this.selectTab(tab.id);
      });
      this.tabButtons.set(tab.id, b);
    }
    this.expLock = h('small.mn-set-tab-sub', { hidden: true }, t('settings.signInShort'));
    this.tabButtons.get('experimental')?.querySelector('.mn-set-tab-text')?.append(this.expLock);
    const keys = h('span.mn-modes-keys', { 'aria-hidden': 'true' }, h('span.mn-keys-kb', null, glyph('key-q'), glyph('key-e')), h('span.mn-keys-pad', null, glyph('pad-lb'), glyph('pad-rb')));
    this.savedLine = h('p.mn-set-saved-text');
    this.rail = h(
      'nav.mn-set-side',
      { 'aria-label': t('settings.tabsLabel') },
      h('div.mn-set-side-head', null, h('span.mn-set-label', null, t('settings.section')), keys),
      h('div.mn-tabs.mn-set-tabs', { role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': t('settings.tabsLabel') }, ...this.tabButtons.values()),
      h('div.mn-set-saved', null, h('span.mn-set-saved-title', null, icon('check'), t('settings.savedTitle')), this.savedLine),
    );
    this.title = h('h1.mn-set-title', { 'data-fit': '20' });
    this.sub = h('p.mn-set-sub');
    this.headActions = h('div.mn-set-head-actions');
    this.body = h('div.mn-set-body');
    this.page = h('section.mn-set-page', null, h('div.mn-set-head', null, h('div.mn-set-head-text', null, this.title, this.sub), this.headActions), this.body);
    this.el = h('div.mn-set', null, this.rail, this.page);
    this.page.addEventListener('focusin', () => (this.firstFocus = false));
  }

  get isOpen(): boolean {
    return this.openNow;
  }

  /** A binding capture waits for its key or button: every key and button is Input's. */
  get capturing(): boolean {
    return this.capture !== null;
  }

  /** The tab shown. */
  get currentTab(): SettingsTab {
    return this.tab;
  }

  /** Its button on the rail (Back from the page lands there; a first focus too). */
  get activeTab(): HTMLButtonElement {
    return this.tabButtons.get(this.tab)!;
  }

  /**
   * Show the view on `tab` (CONTROLES on the last input's device without one); `onClose` once it is
   * left (close). Its first open builds the pages.
   */
  open(tab: SettingsTab | null, onClose: (() => void) | null = null): void {
    this.opts = this.options();
    if (!this.built) this.build();
    this.openNow = true;
    this.held = false;
    this.firstFocus = true;
    this.onClose = onClose;
    this.exp?.disarm();
    this.updateSections(true);
    this.refreshAll();
    this.selectTab(tab ?? 'controls');
    this.startTimer();
  }

  /** Left (the host's Back, a pop, the match taking over): a capture is cancelled, a tier on trial kept. */
  close(): void {
    if (!this.openNow) return;
    this.openNow = false;
    this.held = false;
    if (this.capture !== null) this.opts?.input.cancelRebind();
    this.endTrial();
    this.exp?.disarm();
    this.stopTimer();
    this.waitingSignIn = false;
    const done = this.onClose;
    this.onClose = null;
    done?.();
  }

  /**
   * Out of sight but still stacked (PERFIL's detour over it, the menus hidden by a match found): as
   * on close, a capture is cancelled and a tier on trial kept; the timer stops until resume.
   */
  suspend(): void {
    if (!this.openNow || this.held) return;
    this.held = true;
    if (this.capture !== null) this.opts?.input.cancelRebind();
    this.endTrial();
    this.stopTimer();
  }

  /** Shown again after suspend: the options read again, the timer back. */
  resume(): void {
    if (!this.openNow) return;
    this.held = false;
    this.refresh();
    this.startTimer();
  }

  private startTimer(): void {
    if (this.timer === 0) this.timer = window.setInterval(() => this.tick(), 500);
  }

  private stopTimer(): void {
    if (this.timer === 0) return;
    window.clearInterval(this.timer);
    this.timer = 0;
  }

  /** Read the options again and redraw (an account change, the experimental switch, a tier waiting). */
  refresh(): void {
    if (!this.openNow) return;
    this.opts = this.options();
    this.refreshAll();
  }

  /** Show `tab` (L / R, a click, the arrows on the rail, Menu.open's tab). */
  selectTab(tab: SettingsTab): void {
    if (!this.built) {
      this.tab = tab;
      return;
    }
    if (tab !== this.tab) this.exp?.disarm();
    this.tab = tab;
    for (const [id, b] of this.tabButtons) {
      const on = id === tab;
      b.classList.toggle('mn-tab-on', on);
      b.setAttribute('aria-selected', String(on));
      b.toggleAttribute('data-nav-entry', on);
      this.pages.get(id)!.hidden = !on;
    }
    const def = SETTINGS_TABS.find((x) => x.id === tab)!;
    setText(this.title, t(def.label).toLocaleUpperCase());
    setText(this.sub, this.subtitle(tab));
    this.sub.hidden = this.sub.textContent === '';
    const actions = this.pageActions.get(tab) ?? null;
    setChildren(this.headActions, actions);
    this.body.scrollTop = 0;
    if (tab === 'controls') this.updatePadStatus();
    if (tab === 'experimental') this.opts?.experimental?.onOpen?.();
  }

  /**
   * Back inside the view: a capture cancels; the focus in the page goes to its tab. False when
   * nothing is left to undo here (the host closes the view).
   */
  back(): boolean {
    if (this.capture !== null) {
      this.opts?.input.cancelRebind();
      return true;
    }
    const a = document.activeElement;
    if (!touchMode() && a instanceof HTMLElement && this.body.contains(a)) {
      this.hooks.focus(this.activeTab);
      return true;
    }
    return false;
  }

  /** L / R and LT / RT (Q / E): the tab before / after; Delete / pad X: clear the focused binding or value. */
  command(c: 'prev' | 'next' | 'tabPrev' | 'tabNext' | 'context' | 'cancel' | 'menu'): boolean {
    if (!this.openNow || this.capture !== null) return this.capture !== null;
    if (c === 'context') return this.clearFocused();
    if (c === 'menu') return true; // Start: Ajustes is up already
    if (c === 'cancel') return false;
    const next = stepSettingsTab(this.tab, c === 'prev' || c === 'tabPrev' ? -1 : 1);
    this.selectTab(next);
    if (!touchMode()) this.hooks.focus(this.tabButtons.get(next)!);
    return true;
  }

  // ---- build ----------------------------------------------------------------------------------

  private build(): void {
    this.built = true;
    const pages: Record<SettingsTab, () => [HTMLElement, HTMLElement | null]> = {
      controls: () => this.buildControls(),
      camera: () => this.buildCamera(),
      game: () => this.buildGame(),
      audio: () => this.buildAudio(),
      graphics: () => this.buildGraphics(),
      experimental: () => this.buildExperimental(),
    };
    for (const tab of SETTINGS_TABS) {
      const [page, actions] = pages[tab.id]();
      page.classList.add('mn-set-tabpage');
      page.hidden = true;
      this.pages.set(tab.id, page);
      this.pageActions.set(tab.id, actions);
      this.body.append(page);
    }
  }

  private subtitle(tab: SettingsTab): string {
    switch (tab) {
      case 'camera':
        return t('settings.cameraNote');
      case 'game':
        return t('settings.gameplayNote');
      case 'audio':
        return t('settings.audioNote');
      case 'graphics':
        return t('settings.graphicsNote');
      default:
        return '';
    }
  }

  private get live(): Settings | null {
    return this.opts?.settings ?? null;
  }

  private changed(controls = false): void {
    const o = this.opts;
    if (o === null) return;
    if (controls) o.input.settingsChanged();
    o.onSettingsChanged();
  }

  private group(title: string): HTMLElement {
    return h('h2.mn-set-group', null, title);
  }

  /** A row of settings.controls: a slider for a range, a switch for a flag, each with its default. */
  private controlRow(key: keyof ControlSettings, label: Key): HTMLElement {
    const range = CONTROL_RANGES[key];
    const text = t(label);
    const value = (): number | boolean => this.live?.controls[key] ?? DEFAULT_CONTROL_SETTINGS[key];
    const set = (v: number | boolean): void => {
      const st = this.live;
      if (st === null) return;
      (st.controls as unknown as Record<string, number | boolean>)[key] = v;
      this.changed(true);
    };
    let ctl: Slider | Switch;
    if (range === null) ctl = toggleSwitch('set-' + key, text, () => value() === true, set);
    else {
      const def = DEFAULT_CONTROL_SETTINGS[key];
      ctl = slider('set-' + key, text, range, '', () => Number(value()), set, typeof def === 'number' ? def : undefined);
    }
    this.refreshers.push(ctl.refresh);
    return setRow(text, ctl.el);
  }

  private actionButton(key: string, label: string, onClick: () => void): HTMLButtonElement {
    return navButton('mn-set-action', label, onClick, { 'data-key': key });
  }

  private buildControls(): [HTMLElement, HTMLElement | null] {
    const page = h('div.mn-set-controls', null, this.sectionSlot);
    for (const s of ['touch', 'pad', 'kbm'] as const) {
      const el = h('div.mn-set-section', { hidden: true });
      if (s === 'pad') {
        this.padStatus = h('p.mn-set-note.mn-set-status');
        el.append(this.padStatus);
      } else if (s === 'kbm') el.append(h('p.mn-set-note', null, t('settings.mouseNote')), h('p.mn-set-note', null, t('settings.arrowsNote')));
      for (const r of CONTROL_ROWS[s]) el.append(this.controlRow(r.key, r.label));
      if (s === 'touch') el.append(...this.touchRows());
      else el.append(...this.bindList(s));
      this.sectionEls.set(s, el);
      page.append(el);
    }
    return [page, null];
  }

  /** A device's bindings: the help line, the rows by group, the conflict line, its layouts. */
  private bindList(device: Device): HTMLElement[] {
    const out: HTMLElement[] = [h('p.mn-set-note.mn-set-bindhelp', null, t(device === 'pad' ? 'settings.bindHelpPad' : 'settings.bindHelpKbm'))];
    const conflict = h('p.mn-set-note.mn-set-conflict', { role: 'status', hidden: true });
    this.conflictLines.set(device, conflict);
    let group: string | null = null;
    for (const r of ACTION_ROWS) {
      if (r.group !== group) {
        group = r.group;
        out.push(this.group(t(GROUP_TITLES[r.group])));
      }
      const cell = h('button.mn-bind-cell.mn-set-row-ctl', { type: 'button', 'data-nav': true, 'data-key': `bind-${device}-${r.action}`, 'aria-label': r.label }, '—');
      const locked = r.action === 'pause'; // Pause stays bound: nothing could resume a paused game
      const clear = locked
        ? h('span.mn-bind-lock', { title: t('settings.pauseLockedTitle'), 'aria-label': t('settings.pauseLockedTitle') }, icon('lock'))
        : h('button.mn-bind-clear.mn-set-row-ctl', { type: 'button', 'data-nav': true, 'data-key': `unbind-${device}-${r.action}`, 'aria-label': t('settings.unbindTitle', { key: r.label }) }, icon('close'));
      const row = h('div.mn-bind', { 'data-nav-row': true }, h('span.mn-bind-label', null, r.label), cell, clear);
      const bind: BindRow = { action: r.action, device, row, cell };
      cell.addEventListener('click', () => (this.capture === bind ? this.opts?.input.cancelRebind() : this.beginCapture(bind)));
      if (!locked) clear.addEventListener('click', () => this.clearBinding(bind));
      this.bindRows.push(bind);
      out.push(row);
    }
    const layouts = h(
      'div.mn-set-buttons',
      { 'data-nav-row': true },
      this.actionButton(`layout-${device}`, t('settings.defaultLayout'), () => this.resetBindings(device, 'standard')),
      device === 'kbm' ? this.actionButton('layout-kbm-only', t('settings.keyboardOnly'), () => this.resetBindings(device, 'keyboardOnly')) : null,
    );
    out.push(conflict, layouts);
    return out;
  }

  private buildCamera(): [HTMLElement, HTMLElement | null] {
    const presetLabel = (p: CameraPreset): string => {
      const name = t(p === 'default' ? 'settings.presetWide' : 'settings.presetClassic', { values: PRESET_VALUES[p] });
      return p === 'default' ? `${name} · ${t('settings.default')}` : name;
    };
    const presets = seg<CameraPreset | null>(
      'cam-preset',
      t('settings.cameraPreset'),
      (['default', 'classic'] as const).map((p) => ({ value: p, label: presetLabel(p) })),
      () => {
        const cam = this.live?.camera;
        return cam === undefined ? null : cameraPresetOf(cam, DEFAULT_CAMERA, CLASSIC_CAMERA_DEFAULTS);
      },
      (p) => {
        const st = this.live;
        if (st === null || p === null) return;
        Object.assign(st.camera, p === 'classic' ? CLASSIC_CAMERA_DEFAULTS : DEFAULT_CAMERA);
        this.opts?.onCameraPreset();
        this.changed();
        this.refreshAll();
      },
    );
    this.refreshers.push(presets.refresh);
    const page = h('div.mn-set-camera', null, setRow(t('settings.cameraPreset'), presets.el));
    for (const s of CAMERA_SLIDERS) {
      const key = s.key;
      const text = t(s.label);
      const sl = slider(
        'cam-' + key,
        text,
        CAMERA_RANGES[key],
        s.suffix,
        () => this.live?.camera[key] ?? DEFAULT_CAMERA[key],
        (v) => {
          const st = this.live;
          if (st === null) return;
          st.camera[key] = v;
          this.changed();
          presets.refresh();
        },
        DEFAULT_CAMERA[key],
      );
      this.refreshers.push(sl.refresh);
      page.append(setRow(text, sl.el));
    }
    return [page, null];
  }

  private buildGame(): [HTMLElement, HTMLElement | null] {
    const page = h('div.mn-set-game', null, ...CONTROL_ROWS.game.map((r) => this.controlRow(r.key, r.label)), this.group(t('settings.groupInterface')));
    const language = this.hooks.language;
    if (language !== undefined) {
      this.langValue = h('span.mn-set-picker-value');
      const picker = navButton('mn-set-picker.mn-set-row-ctl', [this.langValue, icon('next')], language, { 'data-key': 'set-language', 'aria-label': t('lang.title') });
      page.append(setRow(t('lang.title'), picker, t('lang.reloadNote')));
    }
    const sizeText = t('settings.uiSize');
    const sizes = seg<number>(
      'set-ui-size',
      sizeText,
      ALL_UI_SIZES.map((v) => ({ value: v, label: `${v} %` })),
      () => interfaceSize(layoutNow(), this.live?.ui.size ?? DEFAULT_UI.size),
      (v) => {
        const st = this.live;
        if (st === null) return;
        st.ui.size = v;
        this.changed();
      },
    );
    this.uiSizes = sizes;
    this.refreshers.push(sizes.refresh);
    this.uiSizeRow = setRow(sizeText, sizes.el);
    page.append(this.uiSizeRow);
    const motionText = t('settings.reducedMotion');
    const motion = seg<MotionPref>(
      'set-motion',
      motionText,
      [
        { value: 'system', label: t('settings.motionSystem') },
        { value: 'on', label: t('settings.on') },
        { value: 'off', label: t('settings.off') },
      ],
      () => this.live?.ui.motion ?? DEFAULT_UI.motion,
      (v) => {
        const st = this.live;
        if (st === null) return;
        st.ui.motion = v;
        this.changed();
      },
    );
    this.refreshers.push(motion.refresh);
    page.append(setRow(motionText, motion.el, t('settings.reducedMotionHelp')));
    const reset = this.actionButton('reset-game', t('settings.resetGameplay'), () => {
      const st = this.live;
      if (st === null) return;
      Object.assign(st.controls, DEFAULT_CONTROL_SETTINGS);
      Object.assign(st.ui, DEFAULT_UI);
      this.refreshAll();
      this.changed(true);
    });
    return [page, reset];
  }

  /** TÁCTIL's rows of settings.touch, after the hold-JUMP switch. */
  private touchRows(): HTMLElement[] {
    const touch = (): Settings['touch'] => this.live?.touch ?? DEFAULT_TOUCH;
    const write = (fn: (t: Settings['touch']) => void): void => {
      const st = this.live;
      if (st === null) return;
      fn(st.touch);
      this.changed();
    };
    const rows: HTMLElement[] = [];
    const add = (label: Key, ctl: { el: HTMLElement; refresh(): void }, help?: Key): void => {
      this.refreshers.push(ctl.refresh);
      rows.push(setRow(t(label), ctl.el, help !== undefined ? t(help) : undefined));
    };
    add('settings.touchSize', seg<TouchSize>('set-tc-size', t('settings.touchSize'), TOUCH_SIZES.map((v) => ({ value: v, label: v })), () => touch().size, (v) => write((x) => (x.size = v))));
    add('settings.touchOpacity', slider('set-tc-opacity', t('settings.touchOpacity'), TOUCH_OPACITY_RANGE, ' %', () => touch().opacity, (v) => write((x) => (x.opacity = v)), DEFAULT_TOUCH.opacity));
    add('settings.touchLefty', toggleSwitch('set-tc-lefty', t('settings.touchLefty'), () => touch().lefty, (v) => write((x) => (x.lefty = v))), 'settings.touchLeftyHelp');
    add(
      'settings.touchStick',
      seg<'floating' | 'fixed'>(
        'set-tc-stick',
        t('settings.touchStick'),
        [
          { value: 'floating', label: t('settings.touchStickFloating') },
          { value: 'fixed', label: t('settings.touchStickFixed') },
        ],
        () => touch().stick,
        (v) => write((x) => (x.stick = v)),
      ),
    );
    add('settings.touchDeadzone', slider('set-tc-deadzone', t('settings.touchDeadzone'), TOUCH_DEADZONE_RANGE, '', () => touch().deadzone, (v) => write((x) => (x.deadzone = v)), DEFAULT_TOUCH.deadzone));
    if (canVibrate()) add('settings.touchVibration', toggleSwitch('set-tc-vibration', t('settings.touchVibration'), () => touch().vibration, (v) => write((x) => (x.vibration = v))));
    return rows;
  }

  private buildAudio(): [HTMLElement, HTMLElement | null] {
    const page = h('div.mn-set-audio');
    // The master volume, then the music's own level under it.
    for (const [key, label] of [['volume', 'settings.volume'], ['music', 'settings.music']] as const) {
      const text = t(label);
      const sl = slider(
        key,
        text,
        VOLUME_RANGE,
        ' %',
        () => this.live?.audio[key] ?? DEFAULT_AUDIO[key],
        (v) => {
          const st = this.live;
          if (st === null) return;
          st.audio[key] = v;
          this.changed();
        },
        DEFAULT_AUDIO[key],
      );
      this.refreshers.push(sl.refresh);
      page.append(setRow(text, sl.el));
    }
    const reset = this.actionButton('reset-audio', t('settings.resetAudio'), () => {
      const st = this.live;
      if (st === null) return;
      Object.assign(st.audio, DEFAULT_AUDIO);
      this.refreshAll();
      this.changed();
    });
    return [page, reset];
  }

  private buildGraphics(): [HTMLElement, HTMLElement | null] {
    const row = h('div.mn-qcards', { role: 'radiogroup', 'aria-label': t('settings.quality'), 'data-nav-row': true });
    for (const q of CARD_QUALITIES) {
      const tag = h('span.mn-qcard-tag');
      const bars = h('span.mn-qcard-bars', { 'aria-hidden': 'true' }, ...[1, 2, 3].map((i) => h(`span.mn-qcard-bar${i <= QUALITY_BARS[q] ? '.mn-qcard-bar-on' : ''}` as 'span')));
      const el = h(
        'button.mn-qcard',
        { type: 'button', role: 'radio', 'aria-checked': 'false', 'data-nav': true, 'data-key': 'q-' + q, onclick: () => void this.pickQuality(q) },
        h('span.mn-qcard-top', null, bars, tag),
        h('span.mn-qcard-name', null, t(`quality.${q}`).toLocaleUpperCase()),
        h('span.mn-qcard-text', null, t(QUALITY_HINTS[q])),
      );
      this.cards.set(q, { el, tag });
      row.append(el);
    }
    this.qualityLine = h('p.mn-set-note.mn-qline', { role: 'status' });
    this.trialText = h('span.mn-qtrial-text');
    this.trialKeep = this.actionButton('q-keep', t('settings.qualityKeep'), () => this.endTrial());
    this.trialRevert = this.actionButton('q-revert', '', () => this.revertTrial());
    this.trialBar = h('div.mn-qtrial', { hidden: true, role: 'alert' }, this.trialText, h('div.mn-set-buttons', { 'data-nav-row': true }, this.trialKeep, this.trialRevert));
    const page = h('div.mn-set-graphics', null, h('h2.mn-set-group', null, t('settings.quality')), row, this.trialBar, this.qualityLine, h('p.mn-set-note', null, icon('info'), t('settings.qualityTrialNote')));
    page.append(this.group(t('settings.graphicsOptions')));
    const g = () => this.opts?.graphics() ?? null;
    const add = (label: Key, ctl: { el: HTMLElement; refresh(): void }, help: Key): void => {
      this.refreshers.push(ctl.refresh);
      page.append(setRow(t(label), ctl.el, t(help)));
    };
    add(
      'settings.resolutionScale',
      slider('set-res-scale', t('settings.resolutionScale'), RESOLUTION_SCALE_RANGE, ' %', () => g()?.resolutionScale ?? DEFAULT_RESOLUTION_SCALE, (v) => this.opts?.setResolutionScale(v), DEFAULT_RESOLUTION_SCALE),
      'settings.resolutionScaleHelp',
    );
    add(
      'settings.fpsCap',
      seg<FpsCap>(
        'set-fps-cap',
        t('settings.fpsCap'),
        [
          { value: 30, label: '30' },
          { value: 60, label: '60' },
          { value: 0, label: t('settings.fpsNone') },
        ],
        () => g()?.fpsCap ?? 0,
        (v) => this.opts?.setFpsCap(v),
      ),
      'settings.fpsCapHelp',
    );
    add('settings.menuScene', toggleSwitch('set-menu-scene', t('settings.menuScene'), () => g()?.menuSceneAnimated ?? true, (v) => this.opts?.setMenuSceneAnimated(v)), 'settings.menuSceneHelp');
    // Super low restarts the game: A (or a click) only, never ◀ ▶ (as the cards).
    add('settings.superlow', toggleSwitch('set-superlow', t('settings.superlow'), () => this.opts?.quality === 'superlow', (v) => void this.pickSuperlow(v), false), 'settings.superlowHelp');
    const reset = this.actionButton('reset-graphics', t('settings.resetGraphics'), () => {
      const o = this.opts;
      if (o === null) return;
      o.setResolutionScale(DEFAULT_RESOLUTION_SCALE);
      o.setFpsCap(0);
      o.setMenuSceneAnimated(true);
      this.refreshAll();
    });
    reset.prepend(icon('refresh'));
    return [page, reset];
  }

  private buildExperimental(): [HTMLElement, HTMLElement | null] {
    const page = buildExperimentalPage(
      experimentalKit(() => {
        if (this.openNow && this.tab === 'experimental') this.hooks.refocus();
      }),
      () => this.opts?.experimental ?? null,
    );
    this.exp = page;
    const box = h('div.mn-set-exp', null, page.page);
    if (this.hooks.place === 'menu' && this.hooks.signIn !== undefined) {
      const signIn = this.hooks.signIn;
      this.expSignIn = this.actionButton('exp-signin', t('search.signIn'), () => {
        this.waitingSignIn = true;
        signIn();
      });
      this.expSignIn.classList.add('mn-set-primary');
      box.append(this.expSignIn);
    }
    return [box, page.actions];
  }

  // ---- refresh --------------------------------------------------------------------------------

  private refreshAll(): void {
    for (const r of this.refreshers) r();
    this.refreshBindLabels();
    this.refreshQuality();
    this.exp?.refresh();
    const guest = this.opts?.experimental?.state().available !== true;
    this.expLock.hidden = !guest;
    this.tabButtons.get('experimental')?.setAttribute('aria-label', guest ? `${experimentalTabLabel(false)}: ${t('settings.signInShort')}` : experimentalTabLabel(true));
    if (this.expSignIn !== null) this.expSignIn.hidden = !guest;
    setText(this.savedLine, t(guest ? 'settings.savedGuest' : 'settings.savedAccount'));
    if (this.langValue !== null) {
      const saved = savedLanguage();
      setText(this.langValue, saved === null ? t('lang.auto', { language: LOCALES[systemLanguage()].name }) : LOCALES[saved].name);
    }
    if (this.uiSizes !== null && this.uiSizeRow !== null) {
      // This screen's sizes (a turn changes them); one alone (a small phone): no row.
      const listed = interfaceSizes(layoutNow(), window.innerWidth, window.innerHeight);
      this.uiSizes.buttons.forEach((b, i) => {
        const off = !listed.includes(ALL_UI_SIZES[i]);
        if (b.hidden !== off) b.hidden = off;
      });
      const alone = listed.length < 2;
      if (this.uiSizeRow.hidden !== alone) this.uiSizeRow.hidden = alone;
    }
  }

  /** The devices detected now (a controller comes and goes): the sections and their picker. */
  private updateSections(opening = false): void {
    const input = this.opts?.input;
    const shown = controlSections({
      touch: typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0,
      pad: input?.hasGamepad === true,
      kbm: finePointer() || lastInput() === 'keyboard',
    });
    const same = shown.length === this.sections.length && shown.every((s, i) => s === this.sections[i]);
    // Chrome shows a controller only after its first press (Start opening Ajustes): until the player
    // picks one, the section follows the last input.
    if (opening) this.sectionPicked = false;
    const next = this.sectionPicked ? keptSection(this.section, shown, lastInput()) : openingSection(lastInput(), shown);
    const prev = this.section;
    const rebuild = !same || this.sections.length === 0;
    if (!rebuild && next === prev) return;
    const hadFocus = this.sectionSlot.contains(document.activeElement) || this.sectionEls.get(prev)?.contains(document.activeElement) === true;
    this.sections = shown;
    if (rebuild) {
      this.sectionSeg =
        shown.length > 1
          ? seg<ControlSection>('set-section', t('settings.tabControls'), shown.map((s) => ({ value: s, label: t(SECTION_LABELS[s]) })), () => this.section, (s) => {
              this.sectionPicked = true;
              this.showSection(s);
            })
          : null;
      setChildren(this.sectionSlot, this.sectionSeg?.el ?? this.group(t(SECTION_LABELS[shown[0]])));
    }
    this.showSection(next);
    // The focus was on what just went (a section, its picker): back on the screen.
    if (hadFocus && !opening) this.hooks.refocus();
  }

  private showSection(s: ControlSection): void {
    this.section = s;
    for (const [id, el] of this.sectionEls) el.hidden = id !== s;
    this.sectionSeg?.refresh();
  }

  private refreshBindLabels(): void {
    const input = this.opts?.input;
    if (input === undefined) return;
    for (const r of this.bindRows) {
      if (r === this.capture) continue;
      setText(r.cell, input.getLabel(r.action, r.device));
      r.row.classList.toggle('mn-bind-unbound', input.getBinding(r.action, r.device) === null);
    }
  }

  private tick(): void {
    if (!this.openNow || this.held) return;
    if (this.tab === 'controls') {
      this.updatePadStatus();
      if (this.capture === null) this.updateSections();
    }
    const tr = this.trial;
    if (tr !== null && !this.switching) {
      if (trialSecondsLeft(tr, performance.now()) <= 0) this.revertTrial();
      else this.refreshQuality();
    }
  }

  private updatePadStatus(): void {
    const input = this.opts?.input;
    const status = this.padStatus;
    if (input === undefined || status === null) return;
    const present = input.hasGamepad;
    const name = present ? input.gamepadName : null;
    const key = `${present}|${name}`;
    if (key === this.padKey) return;
    this.padKey = key;
    status.textContent = present ? (name !== null ? t('settings.padNamed', { name }) : t('settings.padConnected')) : t('settings.padMissing');
    status.classList.toggle('mn-set-warn', !present);
  }

  // ---- bindings -------------------------------------------------------------------------------

  private beginCapture(bind: BindRow): void {
    const input = this.opts?.input;
    if (input === undefined || this.capture !== null || !this.openNow) return;
    this.capture = bind;
    this.conflictLines.get(bind.device)!.hidden = true;
    bind.cell.textContent = t(bind.device === 'pad' ? 'settings.pressButton' : 'settings.pressKey', { cancelKey: bind.device === 'pad' ? t('settings.holdB') : 'Esc' });
    bind.cell.classList.add('mn-bind-capturing');
    bind.row.classList.remove('mn-bind-unbound');
    this.el.classList.add('mn-set-capturing');
    const finish = (b: Binding | null): void => {
      if (this.capture !== bind) return;
      // The promise settles in a microtask, between the listeners of the very keydown / button
      // that ended the capture: `capturing` stays set until that dispatch (and the Game's tick) is
      // over, so the Esc / Enter / button that ended it never doubles as Back or A here.
      window.setTimeout(() => {
        if (this.capture !== bind) return;
        this.capture = null;
        bind.cell.classList.remove('mn-bind-capturing');
        this.el.classList.remove('mn-set-capturing');
        if (b !== null && !bindingsEqual(input.getBinding(bind.action, bind.device), b)) input.setBinding(bind.action, bind.device, b);
        this.refreshBindLabels();
        if (b !== null) {
          this.announceConflict(bind, b);
          this.opts?.onSettingsChanged();
        }
      }, 0);
    };
    input.startRebind(bind.action, bind.device, bind.cell).then(finish, () => finish(null));
  }

  /** "B is also Boost": another action of the device on the key just bound (shared keys stay allowed). */
  private announceConflict(bind: BindRow, b: Binding): void {
    const st = this.live;
    const line = this.conflictLines.get(bind.device)!;
    const other = st === null ? null : bindConflict(st.bindings[bind.device], bind.action, b);
    line.hidden = other === null;
    if (other === null) return;
    const label = ACTION_ROWS.find((r) => r.action === other)?.label ?? other;
    line.textContent = t('settings.bindConflict', { key: this.opts?.input.getLabel(bind.action, bind.device) ?? '', action: label });
  }

  private clearBinding(bind: BindRow): void {
    const input = this.opts?.input;
    if (input === undefined || this.capture !== null || bind.action === 'pause') return;
    if (input.getBinding(bind.action, bind.device) === null) return;
    input.setBinding(bind.action, bind.device, null);
    this.conflictLines.get(bind.device)!.hidden = true;
    this.refreshBindLabels();
    this.opts?.onSettingsChanged();
  }

  /** Delete / pad X on the focused binding (its cell or its ✕), or on an Experimental value (back to standard). */
  private clearFocused(): boolean {
    const a = document.activeElement;
    if (!(a instanceof HTMLElement) || !this.el.contains(a)) return false;
    const row = a.closest('.mn-bind');
    const bind = row !== null ? this.bindRows.find((r) => r.row === row) : undefined;
    if (bind !== undefined) {
      this.clearBinding(bind);
      return true;
    }
    const item = pageItemOf(a);
    if (item?.clear) {
      item.clear();
      return true;
    }
    return false;
  }

  private resetBindings(device: Device, preset: BindingPreset): void {
    const input = this.opts?.input;
    if (input === undefined || this.capture !== null) return;
    input.resetBindings(device, preset);
    this.conflictLines.get(device)!.hidden = true;
    this.refreshBindLabels();
    this.opts?.onSettingsChanged();
  }

  // ---- graphics -------------------------------------------------------------------------------

  private refreshQuality(): void {
    const o = this.opts;
    if (o === null || this.qualityLine === null) return;
    const lit = o.quality;
    const memory = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
    const tv = document.documentElement.classList.contains('tg-tv');
    for (const [q, c] of this.cards) {
      const listed = o.qualities.includes(q);
      if (c.el.hidden === listed) c.el.hidden = !listed;
      const on = q === lit;
      c.el.setAttribute('aria-checked', String(on));
      c.el.classList.toggle('mn-qcard-on', on);
      const tag = on ? t('settings.qualityCurrent') : memoryTag(q, tv ? 1 : memory) ? t('settings.qualityMemory') : '';
      setText(c.tag, tag);
      c.tag.classList.toggle('mn-qcard-tag-on', on);
      c.tag.hidden = tag === '';
    }
    const tr = this.trial;
    if (this.trialBar !== null) this.trialBar.hidden = tr === null || this.switching;
    if (tr !== null && this.trialText !== null && this.trialRevert !== null) {
      setText(this.trialText, t('settings.qualityReverting', { quality: t(`quality.${tr.from}`), seconds: trialSecondsLeft(tr, performance.now()) }));
      setText(this.trialRevert, t('settings.qualityRevert', { quality: t(`quality.${tr.from}`).toLocaleUpperCase() }));
    }
    const kind = qualityLine(lit, o.qualities, o.pending);
    const line = kind === 'afterOnline' ? t('settings.qualityAfterOnline') : kind === 'note' ? o.qualityNote : '';
    setText(this.qualityLine, line);
    this.qualityLine.hidden = line === '';
  }

  /**
   * A card's A / click: the running tier picked makes it the player's pick (as before); another one
   * switches behind the loading screen, then KEEP waits 10 s (QUALITY_TRIAL_MS) before the old tier
   * comes back. One that reloads the page (into or out of Super low) applies at once: it restarts
   * the game (online it waits for the menus, its line says so).
   */
  private async pickQuality(q: Quality): Promise<void> {
    const o = this.opts;
    if (o === null || this.switching || !o.qualities.includes(q)) return;
    const from = o.quality;
    if (q === from || needsReload(from, q) || o.pending !== null) {
      this.endTrial();
      await o.onQualityChange(q);
      this.refresh();
      return;
    }
    // A trial on: the first tier stays the one to come back to.
    const back = this.trial?.from ?? from;
    this.switching = true;
    this.refreshQuality();
    try {
      await o.onQualityChange(q);
    } finally {
      this.switching = false;
    }
    this.opts = this.options();
    // Out of sight by now (a match found during the switch): the new tier stays, as on leaving.
    this.trial = back === q || this.held ? null : startTrial(back, q, performance.now());
    this.refreshQuality();
    if (this.trial !== null && this.trialKeep !== null && !touchMode() && this.openNow) this.hooks.focus(this.trialKeep);
  }

  /** The Super low switch: on restarts into it, off back to Performance (Game.settingsOptions onSuperlow). */
  private async pickSuperlow(on: boolean): Promise<void> {
    const o = this.opts;
    if (o === null || this.switching || on === (o.quality === 'superlow')) return;
    this.endTrial();
    await o.onSuperlow(on);
    this.refresh();
  }

  /** KEEP (or Ajustes left): the tier stays. */
  private endTrial(): void {
    if (this.trial === null) return;
    const keep = this.trialBar?.contains(document.activeElement) === true;
    this.trial = null;
    this.refreshQuality();
    const card = this.cards.get(this.opts?.quality ?? 'high')?.el;
    if (keep && card !== undefined && this.openNow && !this.held && !touchMode()) this.hooks.focus(card);
  }

  /** BACK TO, or the trial's 10 s ran out: the old tier again. */
  private revertTrial(): void {
    const tr = this.trial;
    if (tr === null || this.held) return;
    const focusBack = this.trialBar?.contains(document.activeElement) === true;
    this.trial = null;
    const o = this.opts;
    if (o === null) return;
    this.switching = true;
    this.refreshQuality();
    void o.onQualityChange(tr.from).finally(() => {
      this.switching = false;
      this.refresh();
      const card = this.cards.get(tr.from)?.el;
      if (focusBack && card !== undefined && this.openNow && !this.held && !touchMode()) this.hooks.focus(card);
    });
  }
}
