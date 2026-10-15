/**
 * On-screen touch controls for phones and tablets: a floating stick, JUMP / BOOST / DRIFT, small
 * PAUSE / CAM / RESET buttons, touch mode and the rotate-your-phone screen. Styled by ./touch.css
 * (classes prefixed `tc-`). The Game creates it only on a device with a touch screen
 * (`hasTouchScreen()`: navigator.maxTouchPoints > 0); without one there is no DOM and no listener.
 *
 * Touch mode is the class `tg-touch` on <html>. It starts on when the primary pointer is a finger
 * ((pointer: coarse)), so the first tap does not move the layout; after that the last input used
 * wins (./touchMode.ts): a touch or pen press turns it on; a mouse press, a key the game uses (one
 * bound in the keyboard profile or a fixed menu key; volume / media / launcher / browser keys
 * never count) or a gamepad button press (`notePadPresses`, Input.gamepadPresses) turns it off.
 * A mouse press on a button or a link switches only once its click is through: RESUME / QUIT and
 * the menus' '‹' exist only in touch mode and would vanish under the pointer before the click.
 *
 * The overlay ('.tc-root', right after the Hud root inside #hud, outside .hud-root) shows while
 * the Game says so (`setVisible`: a match being played in touch mode). `tc-on` on #hud lets
 * touch.css move or hide the parts of the HUD the controls replace; it stays while that match is
 * paused, so the HUD does not reshuffle behind the pause screen. It feeds `state`
 * (Input.setTouchSource) through a TouchRouter (./touchRouter.ts: stick, hold / slide, taps):
 *   - the root routes every pointer itself (setPointerCapture, hit tests on circles measured from
 *     the CSS layout); its children ignore the pointer;
 *   - a mouse is ignored (no preventDefault, no capture: it is not a finger); a pen is a finger;
 *   - pointerdown is preventDefault'ed (its compatibility mousedown would reach Input as a click:
 *     a boost tick), touchstart / touchmove too (no scroll, zoom or pull-to-refresh), and the
 *     long-press context menu; the CSS adds touch-action: none and -webkit-touch-callout: none;
 *   - nothing here calls stopPropagation: the Game's audio unlock listens on window;
 *   - every finger is released on pointerup / pointercancel / lostpointercapture, window blur,
 *     the page going hidden and when the overlay hides.
 */
import './touch.css';
import { t } from '../i18n';
import type { BindingProfile } from './bindings';
import { TB, TOUCH_BUTTON_COUNT, TouchState, type TouchButton } from './touchState';
import { TouchRouter, emptyLayout, type TouchLayout } from './touchRouter';
import { keyLeavesTouchMode, pointerTouchMode } from './touchMode';

/** The device has a touch screen (phone, tablet, touch laptop): the Game then creates the controls. */
export function hasTouchScreen(): boolean {
  return typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
}

export interface TouchControlsOptions {
  /** The live keyboard + mouse profile (settings.bindings.kbm): a press of a key bound there turns touch mode off. */
  kbm(): Readonly<BindingProfile>;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Pause: two bars. */
const PAUSE_ICON: ReadonlyArray<Readonly<Record<string, string>>> = [{ d: 'M7 5h3.6v14H7zM13.4 5H17v14h-3.4z' }];
/** Reset: an open ring with an arrowhead at the top, pointing back (anticlockwise). */
const RESET_ICON: ReadonlyArray<Readonly<Record<string, string>>> = [
  { d: 'M12 6A7 7 0 1 1 5.94 9.5', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.4', 'stroke-linecap': 'round' },
  { d: 'M8 6l4.5-3.6v7.2z' },
];

function el(tag: string, className: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function icon(paths: ReadonlyArray<Readonly<Record<string, string>>>): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'currentColor');
  for (const attrs of paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    for (const name of Object.keys(attrs)) p.setAttribute(name, attrs[name]);
    svg.appendChild(p);
  }
  return svg;
}

/** Text entry elements: keys typed there are not game input. */
function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/** A button or a link (or inside one): a mouse press there leaves touch mode only after its click. */
function isClickControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('button, a') !== null;
}

/** The primary pointer is a finger (phones, tablets): touch mode starts on. */
function coarsePointer(): boolean {
  if (typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

export class TouchControls {
  /** What the controls press (Input.setTouchSource). */
  readonly state = new TouchState();
  /** The overlay ('.tc-root'). */
  readonly root: HTMLElement;

  private readonly container: HTMLElement;
  private readonly rotate: HTMLElement;
  private readonly zone: HTMLElement;
  private readonly stick: HTMLElement;
  private readonly knob: HTMLElement;
  /** One element per TB index. */
  private readonly buttons: HTMLElement[] = [];
  private readonly layout: TouchLayout = emptyLayout();
  private readonly router: TouchRouter;
  private readonly kbm: () => Readonly<BindingProfile>;

  private mode = false;
  /** A mouse pressed a button or a link in touch mode: touch mode goes off once that click is through. */
  private offAfterClick = false;
  private offTimer = 0;
  private shown = false;
  /** `tc-on` on #hud: the HUD in its touch layout. */
  private layoutOn = false;
  private training = false;
  /** The layout must be measured again before the next hit test (shown, resized, RESET toggled). */
  private dirty = true;
  private padPresses = 0;
  private ballCam: boolean | null = null;
  /** Centre of the resting stick (its CSS position), client px. */
  private stickRestX = 0;
  private stickRestY = 0;
  /** What paint() last wrote: the stick lit, its offset from the rest, the knob offset, the pressed-look bit per button. */
  private paintedStick = false;
  private paintedSx = 0;
  private paintedSy = 0;
  private paintedKx = 0;
  private paintedKy = 0;
  private paintedMask = 0;
  private disposed = false;

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse') return;
    e.preventDefault();
    if (!this.shown) return;
    if (this.dirty) this.measure();
    this.router.down(e.pointerId, e.clientX, e.clientY);
    try {
      this.root.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer is already gone */
    }
    this.paint();
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse') return;
    this.router.move(e.pointerId, e.clientX, e.clientY);
    this.paint();
  };

  /** pointerup lifts a finger; pointercancel / lostpointercapture take it away (a pending tap does not fire). */
  private readonly onPointerEnd = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse') return;
    this.router.up(e.pointerId, e.clientX, e.clientY, e.type !== 'pointerup');
    this.paint();
  };

  /** No scroll, pinch zoom, pull-to-refresh or compatibility mouse events for fingers on the controls. */
  private readonly onTouch = (e: TouchEvent): void => {
    if (e.cancelable) e.preventDefault();
  };

  private readonly onContextMenu = (e: Event): void => {
    e.preventDefault();
  };

  /** Touch mode: the last pointer pressed anywhere (window, capture phase, passive). */
  private readonly onAnyPointerDown = (e: PointerEvent): void => {
    const on = pointerTouchMode(e.pointerType);
    if (on === null) return;
    // A mouse on a button or link: RESUME / QUIT and '‹' exist only in touch mode, and switching
    // now would hide them before the click lands (onAnyPointerUp switches after it).
    if (!on && this.mode && isClickControl(e.target)) {
      this.offAfterClick = true;
      return;
    }
    this.offAfterClick = false;
    this.setTouchMode(on);
  };

  /** The mouse press that deferred the switch is over (window, capture phase, passive). */
  private readonly onAnyPointerUp = (e: PointerEvent): void => {
    if (!this.offAfterClick || e.pointerType !== 'mouse' || this.offTimer !== 0) return;
    // pointerup, mouseup and click go out in one task: the timer runs once the click is through.
    this.offTimer = window.setTimeout(this.onOffTimer, 0);
  };

  private readonly onOffTimer = (): void => {
    this.offTimer = 0;
    if (!this.offAfterClick) return; // a finger came first
    this.offAfterClick = false;
    this.setTouchMode(false);
  };

  /** Touch mode off on a key the game uses (window, capture phase, passive). */
  private readonly onAnyKeyDown = (e: KeyboardEvent): void => {
    if (!this.mode) return;
    // Virtual keyboards send code '' (and type into text fields); volume / media keys are not play.
    if (keyLeavesTouchMode(e.code, isTextField(e.target), this.kbm())) this.setTouchMode(false);
  };

  private readonly onBlur = (): void => {
    this.release();
  };

  private readonly onVisibility = (): void => {
    if (document.visibilityState !== 'visible') this.release();
  };

  private readonly onResize = (): void => {
    this.dirty = true;
  };

  /** Build the overlay right after `hudRoot` (the Hud's root, inside #hud) and start watching the input. */
  constructor(hudRoot: HTMLElement, opts: TouchControlsOptions) {
    this.kbm = opts.kbm;
    const container = hudRoot.parentElement ?? hudRoot;
    this.container = container;
    this.router = new TouchRouter(this.state, this.layout);

    const root = el('div', 'tc-root');
    root.setAttribute('aria-hidden', 'true'); // finger-only game controls: the keyboard and the pad have their own
    this.root = root;
    this.zone = el('div', 'tc-zone');
    this.stick = el('div', 'tc-stick');
    this.knob = el('div', 'tc-knob');
    this.stick.appendChild(this.knob);
    const b = this.buttons;
    b[TB.JUMP] = el('div', 'tc-btn tc-big tc-jump', t('touch.jump'));
    b[TB.BOOST] = el('div', 'tc-btn tc-big tc-boost', t('touch.boost'));
    b[TB.DRIFT] = el('div', 'tc-btn tc-big tc-drift', t('touch.drift'));
    b[TB.CAM] = el('div', 'tc-btn tc-small tc-cam', t('touch.cam'));
    b[TB.PAUSE] = el('div', 'tc-btn tc-small tc-pause');
    b[TB.PAUSE].appendChild(icon(PAUSE_ICON));
    b[TB.RESET] = el('div', 'tc-btn tc-small tc-reset');
    b[TB.RESET].appendChild(icon(RESET_ICON));
    root.append(this.zone, this.stick, ...b);
    if (hudRoot.parentElement !== null) hudRoot.after(root);
    else hudRoot.appendChild(root);

    // Portrait on a phone: a full-screen notice above every layer (touch.css shows it by media query).
    this.rotate = el('div', 'tc-rotate');
    this.rotate.append(el('div', 'tc-rotate-phone'), el('div', 'tc-rotate-text', t('touch.rotate')));
    container.appendChild(this.rotate);

    root.addEventListener('pointerdown', this.onPointerDown);
    root.addEventListener('pointermove', this.onPointerMove);
    root.addEventListener('pointerup', this.onPointerEnd);
    root.addEventListener('pointercancel', this.onPointerEnd);
    root.addEventListener('lostpointercapture', this.onPointerEnd);
    root.addEventListener('touchstart', this.onTouch, { passive: false });
    root.addEventListener('touchmove', this.onTouch, { passive: false });
    root.addEventListener('contextmenu', this.onContextMenu);
    this.rotate.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('pointerdown', this.onAnyPointerDown, { capture: true, passive: true });
    window.addEventListener('pointerup', this.onAnyPointerUp, { capture: true, passive: true });
    window.addEventListener('pointercancel', this.onAnyPointerUp, { capture: true, passive: true });
    window.addEventListener('keydown', this.onAnyKeyDown, { capture: true, passive: true });
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('resize', this.onResize);
    document.addEventListener('visibilitychange', this.onVisibility);

    this.setTouchMode(coarsePointer());
  }

  /** The last input used was a finger (or a pen): `tg-touch` is on <html>. */
  get touchMode(): boolean {
    return this.mode;
  }

  /** The overlay is up (`tc-show` on the root). */
  get visible(): boolean {
    return this.shown;
  }

  /**
   * Per frame: show the overlay while `on` (a match is being played in touch mode); `training`
   * adds the RESET button; `layout` (that match is on screen, played or paused) keeps the HUD in
   * its touch layout (`tc-on` on #hud, also on while `on`). Hiding releases every finger. Cached:
   * only a change touches the DOM.
   */
  setVisible(on: boolean, training: boolean, layout = on): void {
    if (training !== this.training) {
      this.training = training;
      this.root.classList.toggle('tc-train', training);
      this.dirty = true;
    }
    const hudLayout = on || layout;
    if (hudLayout !== this.layoutOn) {
      this.layoutOn = hudLayout;
      this.container.classList.toggle('tc-on', hudLayout);
    }
    if (on === this.shown) return;
    this.shown = on;
    this.root.classList.toggle('tc-show', on);
    if (on) this.dirty = true;
    else this.release();
  }

  /** Per frame: Input.gamepadPresses. A change means a pad button was pressed: touch mode off. */
  notePadPresses(count: number): void {
    if (count === this.padPresses) return;
    this.padPresses = count;
    this.setTouchMode(false);
  }

  /** The CAM button shows the ball cam state (lit while on), like the Hud's camera pill. */
  setBallCam(on: boolean): void {
    if (on === this.ballCam) return;
    this.ballCam = on;
    this.buttons[TB.CAM].classList.toggle('tc-cam-on', on);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const root = this.root;
    root.removeEventListener('pointerdown', this.onPointerDown);
    root.removeEventListener('pointermove', this.onPointerMove);
    root.removeEventListener('pointerup', this.onPointerEnd);
    root.removeEventListener('pointercancel', this.onPointerEnd);
    root.removeEventListener('lostpointercapture', this.onPointerEnd);
    root.removeEventListener('touchstart', this.onTouch);
    root.removeEventListener('touchmove', this.onTouch);
    root.removeEventListener('contextmenu', this.onContextMenu);
    this.rotate.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('pointerdown', this.onAnyPointerDown, { capture: true });
    window.removeEventListener('pointerup', this.onAnyPointerUp, { capture: true });
    window.removeEventListener('pointercancel', this.onAnyPointerUp, { capture: true });
    window.removeEventListener('keydown', this.onAnyKeyDown, { capture: true });
    if (this.offTimer !== 0) window.clearTimeout(this.offTimer);
    this.offTimer = 0;
    this.offAfterClick = false;
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.router.releaseAll();
    this.container.classList.remove('tc-on');
    document.documentElement.classList.remove('tg-touch');
    root.remove();
    this.rotate.remove();
  }

  private setTouchMode(on: boolean): void {
    if (on === this.mode) return;
    this.mode = on;
    document.documentElement.classList.toggle('tg-touch', on);
  }

  /** Forget every finger (and what it pressed), back to the resting look. */
  private release(): void {
    this.router.releaseAll();
    this.paint();
  }

  /**
   * Hit circles from the CSS layout. Layout boxes (offset*) ignore the pressed-look transforms;
   * the root sits at the viewport origin but its own box is added anyway. A hidden button (RESET
   * outside training) measures 0 and is never hit.
   */
  private measure(): void {
    this.dirty = false;
    const box = this.root.getBoundingClientRect();
    const ox = box.left;
    const oy = box.top;
    const layout = this.layout;
    const bounds = layout.bounds;
    bounds.left = box.left;
    bounds.top = box.top;
    bounds.right = box.right;
    bounds.bottom = box.bottom;
    const z = this.zone;
    const zone = layout.zone;
    zone.left = ox + z.offsetLeft;
    zone.top = oy + z.offsetTop;
    zone.right = zone.left + z.offsetWidth;
    zone.bottom = zone.top + z.offsetHeight;
    const s = this.stick;
    layout.stickRadius = s.offsetWidth / 2;
    this.stickRestX = ox + s.offsetLeft + s.offsetWidth / 2;
    this.stickRestY = oy + s.offsetTop + s.offsetHeight / 2;
    for (let i = 0; i < TOUCH_BUTTON_COUNT; i++) {
      const e = this.buttons[i];
      const c = layout.buttons[i];
      const w = e.offsetWidth;
      c.r = w / 2;
      c.cx = ox + e.offsetLeft + w / 2;
      c.cy = oy + e.offsetTop + e.offsetHeight / 2;
    }
    this.router.setLayout(layout);
  }

  /**
   * Mirror the router / state on the elements: stick position and knob, pressed buttons. Runs on
   * every pointer event, so it allocates nothing and writes only what changed.
   */
  private paint(): void {
    const r = this.router;
    const stickOn = r.stickActive;
    if (stickOn !== this.paintedStick) {
      this.paintedStick = stickOn;
      this.stick.classList.toggle('tc-stick-on', stickOn);
    }
    const sx = stickOn ? r.stickX - this.stickRestX : 0;
    const sy = stickOn ? r.stickY - this.stickRestY : 0;
    if (sx !== this.paintedSx || sy !== this.paintedSy) {
      this.paintedSx = sx;
      this.paintedSy = sy;
      this.stick.style.transform = sx === 0 && sy === 0 ? '' : `translate(${sx}px, ${sy}px)`;
    }
    const kx = stickOn ? r.knobX : 0;
    const ky = stickOn ? r.knobY : 0;
    if (kx !== this.paintedKx || ky !== this.paintedKy) {
      this.paintedKx = kx;
      this.paintedKy = ky;
      this.knob.style.transform = kx === 0 && ky === 0 ? '' : `translate(${kx}px, ${ky}px)`;
    }
    let mask = r.pendingTaps;
    const state = this.state;
    for (let i = 0; i < TOUCH_BUTTON_COUNT; i++) if (state.isHeld(i as TouchButton)) mask |= 1 << i;
    const changed = mask ^ this.paintedMask;
    if (changed === 0) return;
    this.paintedMask = mask;
    for (let i = 0; i < TOUCH_BUTTON_COUNT; i++) if ((changed & (1 << i)) !== 0) this.buttons[i].classList.toggle('tc-down', (mask & (1 << i)) !== 0);
  }
}
