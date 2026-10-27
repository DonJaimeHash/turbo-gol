/**
 * Which device the player is using, for the menus (the Tablero plan §1.6: hints and glyphs speak
 * the language of the LAST input, never another device's) and the TV class. Pure decisions plus one
 * installer (installDevice, called by the Game):
 *
 * - `lastInput`: 'pad' (a gamepad button: Input.gamepadPresses), 'remote' (the arrows, OK / Enter or
 *   Back on a TV with no controller connected: what a TV remote sends), 'keyboard', 'mouse',
 *   'touch' (a finger or a pen). Mirrored as `data-input` on <html> for the stylesheets.
 * - `html.tg-tv`: a device with no pointer at all, neither fine nor coarse (a TV driven by a remote
 *   or a controller: bootTier.ts pointerKind, the same test that starts a slow TV GPU on Super low),
 *   or the `#tv` emulation (hashFlags.ts).
 * - `finePointer()`: some pointer is fine (a mouse, a trackpad) and this is no TV: only then may a
 *   text field take a screen's first focus (a phone or a TV would pop the system keyboard up).
 * - The tap guard (`tapGuarded`, Menu): a tap whose finger went down before a menu screen or sheet
 *   was mounted, or within TAP_GUARD_MS after, is no press on it (a double tap on a tile landing on
 *   the next screen, a sheet that came up under a finger).
 * No DOM at module level: node tests import it (tests/device.test.mjs).
 */
import { BACK_KEYS } from './backGuard';
import { pointerKind, type PointerKind } from '../render/bootTier';

export type InputKind = 'pad' | 'remote' | 'keyboard' | 'mouse' | 'touch';

/** A tap that went down before a mount, or this soon after it, is not a press on what was mounted. */
export const TAP_GUARD_MS = 450;

/** The tap guard: a finger that went down at `downAt` (ms) presses nothing mounted at `mountedAt`. Pure. */
export function tapGuarded(downAt: number, mountedAt: number): boolean {
  return downAt < mountedAt + TAP_GUARD_MS;
}

/** What a TV remote sends: on a TV with no controller connected these keys are the remote. */
const REMOTE_CODES: ReadonlySet<string> = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'NumpadEnter', 'Escape', 'Backspace']);
/** Codes that say nothing about the device: volume, media, launcher and browser keys, a modifier alone. */
const SILENT_CODES = /^(Media|Audio|Launch|Browser|Shift|Control|Alt|Meta|OS|CapsLock|Fn)/;

/**
 * The device behind a keydown (`code`, `key` of the event): 'remote' for the remote's keys on a TV
 * with no controller connected, else 'keyboard'; null for keys that say nothing (a virtual
 * keyboard's empty code, volume / media keys, a modifier alone, a back key outside a TV). Pure.
 */
export function keyInput(code: unknown, key: unknown, tv: boolean, padConnected: boolean): InputKind | null {
  const c = typeof code === 'string' ? code : '';
  const back = (typeof key === 'string' && BACK_KEYS.has(key)) || c === 'BrowserBack';
  if (back) return tv && !padConnected ? 'remote' : null;
  if (c === '' || SILENT_CODES.test(c)) return null;
  return tv && !padConnected && REMOTE_CODES.has(c) ? 'remote' : 'keyboard';
}

/** The device behind a pointerdown: 'mouse', 'touch' (a finger or a pen), null otherwise. Pure. */
export function pointerInput(pointerType: unknown): InputKind | null {
  if (pointerType === 'mouse') return 'mouse';
  if (pointerType === 'touch' || pointerType === 'pen') return 'touch';
  return null;
}

/** A TV: no pointer at all (bootTier.ts pointerKind), or the `#tv` emulation. Pure. */
export function isTv(pointer: PointerKind, tvFlag: boolean): boolean {
  return tvFlag || pointer === 'none';
}

/** The last input before any press: the remote on a TV, a finger where the primary pointer is one, else the mouse. Pure. */
export function initialInput(pointer: PointerKind, tvFlag: boolean): InputKind {
  return isTv(pointer, tvFlag) ? 'remote' : pointer === 'coarse' ? 'touch' : 'mouse';
}

/**
 * The shell's layout class (plan §1.4), by height and orientation, never by width alone:
 *   tv        html.tg-tv (no pointer at all, or #tv), whatever its size
 *   phone     landscape, at most 500 tall (a phone held sideways: the 123 px rail)
 *   portrait  upright, at most 600 wide (an upright phone: tabs at the bottom)
 *   tablet    upright, wider (as portrait, more columns)
 *   short     at least 900 wide and at most 600 tall (a 1366 x 600 laptop)
 *   pc        the rest
 * Mirrored as `data-layout` on <html> (installLayout), with `data-shell` (shellOf: bar, rail, tabs,
 * tv), which src/ui/styles/shell.css keys on. Pure.
 */
export type LayoutClass = 'pc' | 'short' | 'phone' | 'portrait' | 'tablet' | 'tv';

/** Where the shell puts the sections for a class: the top bar, the rail, the tab bar, or the TV's bar. Pure. */
export type ShellKind = 'bar' | 'rail' | 'tabs' | 'tv';

export function shellOf(cls: LayoutClass): ShellKind {
  return cls === 'tv' ? 'tv' : cls === 'phone' ? 'rail' : cls === 'portrait' || cls === 'tablet' ? 'tabs' : 'bar';
}

export function layoutClass(w: number, h: number, tv: boolean): LayoutClass {
  if (tv) return 'tv';
  if (w > h) {
    if (h <= 500) return 'phone';
    if (h <= 600 && w >= 900) return 'short';
    return 'pc';
  }
  if (w <= 600) return 'portrait';
  return 'tablet';
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * The device factor of `--ui-scale` (1 rem = 16 px x the factor at each class's reference view):
 * a PC by height (768 tall = 1, 0.9 to 1.35); a short screen by height too, but 1 at its own 600
 * (0.9 to 1: the plan's "Bajo" column, a 56 bar and 18 px sections at 1366 x 600); a phone held
 * sideways by height (390 = 1, up to 1.1) and an upright phone or tablet by width (390 = 1, up to
 * 1.1), never under 1: a phone's text stays at 14 px or more and the rail at the owner's 123 px with
 * 24 clear of Android's back gesture (5 x 56 + 56 + 16 = 352 fits a 360 tall phone at 1; the plan's
 * 0.92 floor took them to 12.9 and 113 there); a TV by width (960 = 1, up to 2: the real TV reports
 * 962 x 541). The "Interface size" setting (PR 11) multiplies it. Pure.
 */
export function uiScale(cls: LayoutClass, w: number, h: number): number {
  switch (cls) {
    case 'tv':
      return clamp(w / 960, 1, 2);
    case 'phone':
      return clamp(h / 390, 1, 1.1);
    case 'portrait':
    case 'tablet':
      return clamp(w / 390, 1, 1.1);
    case 'short':
      return clamp(h / 600, 0.9, 1);
    default:
      return clamp(h / 768, 0.9, 1.35);
  }
}

/**
 * Once, in the browser (installDevice, after `tg-tv`): `data-layout` and `--ui-scale` on <html>,
 * again on every resize and turn. The root font size follows (src/ui/styles/shell.css), so everything the
 * shell writes in rem scales with the screen; the old screens' px do not.
 */
export function installLayout(): void {
  const html = document.documentElement;
  const apply = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const cls = layoutClass(w, h, html.classList.contains('tg-tv'));
    if (html.dataset.layout !== cls) html.dataset.layout = cls;
    const shell = shellOf(cls);
    if (html.dataset.shell !== shell) html.dataset.shell = shell;
    const s = uiScale(cls, w, h).toFixed(3);
    if (html.style.getPropertyValue('--ui-scale') !== s) html.style.setProperty('--ui-scale', s);
  };
  apply();
  window.addEventListener('resize', apply);
}

/**
 * Undo a pinch zoom (the menus may be zoomed: plan PR 4) when a match takes the screen, where the
 * touch controls must sit where they belong: the viewport is pinned to scale 1 for a moment, then
 * free again. Nothing when not zoomed, or without a visual viewport.
 */
export function resetPageZoom(): void {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!vv || vv.scale <= 1.01) return;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (meta === null) return;
  const was = meta.content;
  meta.content = was + ', maximum-scale=1';
  window.setTimeout(() => {
    meta.content = was;
  }, 300);
}

/** The last input used (no DOM: installDevice feeds it). */
export class DeviceTracker {
  private kind: InputKind;
  private pads = 0;
  private readonly listeners: Array<(k: InputKind) => void> = [];

  constructor(initial: InputKind) {
    this.kind = initial;
  }

  get lastInput(): InputKind {
    return this.kind;
  }

  /** An input of `kind` was used (null: one that says nothing). True when the last input changed. */
  note(kind: InputKind | null): boolean {
    if (kind === null || kind === this.kind) return false;
    this.kind = kind;
    for (const fn of this.listeners) fn(kind);
    return true;
  }

  /** Per frame: Input.gamepadPresses; a change is a gamepad press. */
  notePadPresses(count: number): void {
    if (count === this.pads) return;
    this.pads = count;
    this.note('pad');
  }

  /** Called on each change of the last input. */
  subscribe(fn: (k: InputKind) => void): void {
    this.listeners.push(fn);
  }
}

/** Some pointer is fine and this is no TV (`tg-tv`): a text field may take a screen's first focus. */
export function finePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  if (document.documentElement.classList.contains('tg-tv')) return false;
  try {
    return window.matchMedia('(any-pointer: fine)').matches;
  } catch {
    return true;
  }
}

/**
 * A keydown typed into a text field (a character, or Chrome autofill's keydown with no `key`): it
 * says nothing about the device, the field's keys stay its own. Pure (a node test feeds it objects).
 */
export function typedInField(e: Pick<KeyboardEvent, 'target' | 'key'>): boolean {
  const t = e.target as HTMLElement | null;
  if (t === null || typeof t !== 'object' || typeof t.tagName !== 'string') return false;
  const field = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable === true;
  return field && (typeof e.key !== 'string' || e.key.length === 1);
}

/**
 * Once, in the browser: `tg-tv` on <html> (`tvFlag`: the #tv emulation), the layout class and the
 * UI scale (installLayout), the tracker of the last input fed by keydown / pointerdown (capture,
 * passive: nothing is cancelled) and mirrored as `data-input` on <html>. `padConnected` (Input.hasGamepad) tells a remote's arrows from a
 * keyboard's on a TV; the Game reports pad presses per frame (DeviceTracker.notePadPresses).
 */
export function installDevice(opts: { tvFlag: boolean; padConnected: () => boolean }): DeviceTracker {
  const html = document.documentElement;
  const pointer = pointerKind();
  const tv = isTv(pointer, opts.tvFlag);
  html.classList.toggle('tg-tv', tv);
  const d = new DeviceTracker(initialInput(pointer, opts.tvFlag));
  html.dataset.input = d.lastInput;
  d.subscribe((k) => {
    html.dataset.input = k;
  });
  window.addEventListener(
    'keydown',
    (e) => {
      if (!typedInField(e)) d.note(keyInput(e.code, e.key, tv, opts.padConnected()));
    },
    { capture: true, passive: true },
  );
  window.addEventListener('pointerdown', (e) => d.note(pointerInput(e.pointerType)), { capture: true, passive: true });
  installLayout();
  return d;
}
