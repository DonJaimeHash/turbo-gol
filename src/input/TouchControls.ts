/**
 * On-screen touch controls for phones and tablets (the Tablero plan PR 9; the owner's
 * hub-partido-tel): a floating stick (no chevrons), JUMP, BOOST with the boost amount and its level
 * inside, a neutral DRIFT, CAM in the thumb's arc (RESET above it in training), PAUSE alone in the
 * top right corner, the scorebug as a tap target for the full scoreboard, the three first-match
 * cards, touch mode and the rotate-your-phone screen (translucent over a live online match, the
 * scorebug above it). Styled by ./touch.css (classes prefixed `tc-`). The Game creates it only on
 * a device with a touch screen (`hasTouchScreen()`: navigator.maxTouchPoints > 0); without one
 * there is no DOM and no listener.
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
 *     the page going hidden and when the overlay hides;
 *   - a finger on a first-match card is the card's (it never reaches the router): lifted on it,
 *     the next card; one that lands within CARD_GUARD_MS of a card showing does nothing (a double
 *     tap on PLAY in the menus). Online (`setLive`), where the match goes on under the card, a
 *     finger on it in the stick zone is the stick's.
 *
 * Settings > Controls > Touch (`applySettings`, the player's settings.touch): the size (--tc-k) and
 * the opacity (--tc-alpha) of the stick and the buttons, the mirrored layout for the left-handed
 * (`tc-lefty`: touch.css's logical insets under direction: rtl; PAUSE stays in its corner), a
 * fixed stick and its deadzone (the router's), and a short pulse on each new press of a button
 * (`canVibrate`: navigator.vibrate, Android). The layout is measured again after a change.
 *
 * BOOST shows `setBoost`'s amount (the Game, every frame; written at 10 Hz from precomputed
 * strings, so it allocates nothing either) with the Hud plate's empty / low / full states; in
 * touch mode the plate itself is hidden (touch.css). A tap on the scorebug (TouchRouter's
 * `scoreTaps`) opens the full scoreboard (`scoreboardOpen`, which the Game shows as it shows the
 * held Tab one) and a tap on it or on the board closes it, as does a thumb landing on the board in
 * the stick zone (it drives); it closes as the overlay hides.
 *
 * The cards (plan §6.10, C3): the first time the controls come up on a device, three cards one at
 * a time (how to drive; JUMP and BOOST; CAM and PAUSE), remembered in localStorage (how many were
 * seen, so a match that ends half way shows the rest next time; storage that cannot be read counts
 * as seen). `cardsUp` while one is up: offline the Game holds the match meanwhile.
 *
 * Phone platform helpers (their decisions are in ./touchMode.ts), used by the Game on touch
 * screens only:
 *   - `autoFullscreen`: on Android a finger tap outside the controls goes fullscreen in landscape;
 *   - `installHintDue` / `noteInstallHintShown`: the iPhone's one-time add-to-home-screen hint;
 *   - iOS Safari's pinch zoom (gesturestart) is cancelled but in the menus (`.mn-open`: the
 *     front-end menus and the settings over them), never on the controls or the game's canvas:
 *     the menus may be zoomed (the Tablero plan, PR 4), a match and its pause not (the menus
 *     undo a zoom when they hide: device.ts resetPageZoom). Never without a touch screen: on a
 *     Mac it would block the trackpad's pinch zoom.
 */
import './touch.css';
import { STORAGE_PREFIX } from '../brand';
import { t, type Key } from '../i18n';
import { icon, type IconName } from '../ui/components/icons';
import type { BindingProfile } from './bindings';
import { TOUCH_SIZE_SCALE, type TouchSettings } from '../settings';
import { TB, TOUCH_BUTTON_COUNT, TouchState, type TouchButton } from './touchState';
import { TouchRouter, emptyLayout, type TouchLayout } from './touchRouter';
import { keyLeavesTouchMode, pointerTouchMode, shouldAutoFullscreen, shouldShowInstallHint, type PlatformEnv } from './touchMode';

/** The device has a touch screen (phone, tablet, touch laptop): the Game then creates the controls. */
export function hasTouchScreen(): boolean {
  return typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
}

/** The browser can vibrate (navigator.vibrate: Android's; iOS has none): Settings > Controls > Touch lists the row only then. */
export function canVibrate(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

/** A press's pulse (ms): felt, not a buzz. */
const PRESS_PULSE_MS = 12;

export interface TouchControlsOptions {
  /** The live keyboard + mouse profile (settings.bindings.kbm): a press of a key bound there turns touch mode off. */
  kbm(): Readonly<BindingProfile>;
  /** The player's M29 preference (settings.controls.touchHoldJump): JUMP held through a slide, as BOOST. */
  holdJump(): boolean;
  /** The player's touch settings (settings.touch), read again by applySettings. */
  settings(): Readonly<TouchSettings>;
}

/** BOOST's number and level per whole amount, built once: setBoost writes them without allocating. */
const BOOST_TEXT: readonly string[] = Array.from({ length: 101 }, (_, i) => String(i));
const BOOST_LEVEL: readonly string[] = Array.from({ length: 101 }, (_, i) => `translateY(${100 - i}%)`);
/** BOOST's number is written at most this often (s): 10 Hz. */
const BOOST_PERIOD = 0.1;

/** The first-match cards, in order: an icon of the shared set, a title and a line. */
const CARDS: ReadonlyArray<{ icon: IconName; title: Key; text: Key }> = [
  { icon: 'touch', title: 'touch.card1Title', text: 'touch.card1Text' },
  { icon: 'boost', title: 'touch.card2Title', text: 'touch.card2Text' },
  { icon: 'camera', title: 'touch.card3Title', text: 'touch.card3Text' },
];
const CARDS_KEY = STORAGE_PREFIX + 'touchCards';
/** A finger that lands this soon after a card shows does nothing (ms): a double tap on PLAY. */
const CARD_GUARD_MS = 450;
/** The scorebug's tap area reaches this far round it (px): a 36 px bug is a small target. */
const SCORE_SLOP = 8;

function el(tag: string, className: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** How many first-match cards this browser has seen (0..CARDS.length). Storage that cannot be read counts as all: it could not remember, so it never nags. */
function cardsSeen(): number {
  try {
    const v = Number(window.localStorage.getItem(CARDS_KEY) ?? 0);
    return Number.isInteger(v) && v >= 0 ? Math.min(v, CARDS.length) : 0;
  } catch {
    return CARDS.length;
  }
}

function noteCardsSeen(count: number): void {
  try {
    window.localStorage.setItem(CARDS_KEY, String(count));
  } catch {
    /* ignore */
  }
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

function mediaMatches(query: string): boolean {
  if (typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

/** The primary pointer is a finger (phones, tablets): touch mode starts on. */
function coarsePointer(): boolean {
  return mediaMatches('(pointer: coarse)');
}

/** The browser's side of the phone platform decisions (touchMode.ts). */
export function platformEnv(): PlatformEnv {
  // Typed as always there; Safari before 16.4 lacks it.
  const orientation: ScreenOrientation | undefined = screen.orientation;
  const root = document.documentElement;
  return {
    coarse: coarsePointer(),
    orientationLock: orientation !== undefined && typeof orientation.lock === 'function',
    elementFullscreen: document.fullscreenEnabled === true && typeof root.requestFullscreen === 'function',
    fullscreen: document.fullscreenElement != null,
    standalone: mediaMatches('(display-mode: standalone)') || (navigator as Navigator & { standalone?: boolean }).standalone === true,
  };
}

/**
 * Taps that never go fullscreen: on the controls (mid-match), a link (a new tab), a text field or
 * a field's label (it focuses the field: the keyboard).
 */
const NO_FULLSCREEN_TARGETS = '.tc-root, a, input, textarea, select, label';
/** How long after its pointerup a tap's click may still ask for the fullscreen (ms). */
const FULLSCREEN_CLICK_MS = 1000;
/** timeStamp of the finger's pointerup that left the request to its click (see autoFullscreen); -Infinity: none. */
let fullscreenClickFrom = -Infinity;

/**
 * Android phones (shouldAutoFullscreen): a finger lifted anywhere but on the controls, a link or a
 * text field (or its label) goes fullscreen without the navigation bar and locks landscape. The
 * Game listens with it on window while it runs: pointerup (capture phase, passive) and click
 * (bubble phase, passive). requestFullscreen needs the user activation of that very event, so it
 * is called right here, never from a later callback; only the orientation lock waits for the
 * fullscreen.
 *
 * Firefox may not count a touch pointerup as an activation: when navigator.userActivation says
 * there is none, the pointerup decides (target, gate) and leaves the request to that tap's own
 * click (after touchend, which is one): a trusted click within FULLSCREEN_CLICK_MS, so a
 * programmatic element.click() (the pad's FocusNav accept) or a tap with no click (a long press)
 * never asks later. That click is heard in the bubble phase: the tapped control's own handler uses
 * the activation first (the clipboard needs it; requestFullscreen consumes it).
 */
export function autoFullscreen(e: MouseEvent): void {
  if (e.type === 'click') {
    const due = e.isTrusted && e.timeStamp - fullscreenClickFrom <= FULLSCREEN_CLICK_MS;
    fullscreenClickFrom = -Infinity;
    if (due && document.fullscreenElement == null) requestLandscapeFullscreen();
    return;
  }
  fullscreenClickFrom = -Infinity;
  const pointerType = (e as PointerEvent).pointerType;
  if (pointerType !== 'touch' && pointerType !== 'pen') return;
  if (document.fullscreenElement != null) return;
  if (e.target instanceof Element && e.target.closest(NO_FULLSCREEN_TARGETS) !== null) return;
  if (!shouldAutoFullscreen(platformEnv())) return;
  const activation: UserActivation | undefined = navigator.userActivation;
  if (activation !== undefined && !activation.isActive) {
    fullscreenClickFrom = e.timeStamp;
    return;
  }
  requestLandscapeFullscreen();
}

/** Called only inside an input event's own listener (autoFullscreen): it needs its user activation. */
function requestLandscapeFullscreen(): void {
  document.documentElement
    .requestFullscreen({ navigationUI: 'hide' })
    .then(() => screen.orientation.lock('landscape'))
    .catch(() => undefined);
}

const INSTALL_HINT_KEY = STORAGE_PREFIX + 'installHint';

/**
 * The iPhone's add-to-home-screen hint is due (shouldShowInstallHint): not shown in this browser
 * yet. Storage that cannot be read counts as shown: it could not remember, so it never nags.
 */
export function installHintDue(): boolean {
  let shown = true;
  try {
    shown = window.localStorage.getItem(INSTALL_HINT_KEY) !== null;
  } catch {
    /* private mode / storage disabled */
  }
  return shouldShowInstallHint(platformEnv(), shown);
}

/** The hint was shown: never again in this browser. */
export function noteInstallHintShown(): void {
  try {
    window.localStorage.setItem(INSTALL_HINT_KEY, '1');
  } catch {
    /* ignore */
  }
}

export class TouchControls {
  /** What the controls press (Input.setTouchSource). */
  readonly state = new TouchState();
  /** The overlay ('.tc-root'). */
  readonly root: HTMLElement;

  private readonly container: HTMLElement;
  private readonly rotate: HTMLElement;
  private readonly rotateText: HTMLElement;
  /** The Hud's scorebug (its tap area) and the scoreboard's panel (the board, while open). */
  private readonly scoreBug: Element | null;
  private readonly boardPanel: Element | null;
  private readonly boostNum: HTMLElement;
  private readonly boostLevel: HTMLElement;
  private readonly cards: HTMLElement;
  private readonly card: HTMLElement;
  private readonly cardIcon: HTMLElement;
  private readonly cardStep: HTMLElement;
  private readonly cardTitle: HTMLElement;
  private readonly cardText: HTMLElement;
  private readonly holdJump: () => boolean;
  private readonly settings: () => Readonly<TouchSettings>;
  /** A pulse on each new press (settings.touch.vibration, where the browser can). */
  private vibrate = false;
  private readonly zone: HTMLElement;
  private readonly stick: HTMLElement;
  private readonly knob: HTMLElement;
  /** One element per TB index. */
  private readonly buttons: HTMLElement[] = [];
  private readonly layout: TouchLayout = emptyLayout();
  private readonly router: TouchRouter;
  private readonly kbm: () => Readonly<BindingProfile>;

  private mode = false;
  /** BOOST: the amount shown, its state (0 plain, 1 empty, 2 low, 3 full), when it was last written (s). */
  private boostShown = -1;
  private boostState = -1;
  private boostAt = -Infinity;
  /** The full scoreboard opened by a tap on the scorebug; the router's scoreTaps last seen. */
  private boardOpen = false;
  private scoreTapsSeen = 0;
  /** The live rotate notice (an online match goes on under it). */
  private live = false;
  /** The card up (index into CARDS, -1 none), how many this browser has seen, when it showed (ms), the finger on it. */
  private cardIndex = -1;
  private seen: number;
  private cardAt = 0;
  private cardFinger = -1;
  /** The card's box (client px), measured with the rest. */
  private cardLeft = 0;
  private cardTop = 0;
  private cardRight = 0;
  private cardBottom = 0;
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
    try {
      this.root.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer is already gone */
    }
    if (this.onCard(e.clientX, e.clientY) && !(this.live && this.inZone(e.clientX, e.clientY))) {
      // The card's (lifted on it: the next one); too soon after it showed, nothing. Online the
      // match goes on under it: a finger there in the stick zone drives (GOT IT is outside it).
      if (this.cardFinger < 0 && e.timeStamp - this.cardAt >= CARD_GUARD_MS) this.cardFinger = e.pointerId;
      return;
    }
    this.router.holdJump = this.holdJump();
    this.router.down(e.pointerId, e.clientX, e.clientY);
    this.syncBoard();
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
    if (e.pointerId === this.cardFinger) {
      this.cardFinger = -1;
      if (e.type === 'pointerup' && this.onCard(e.clientX, e.clientY)) this.nextCard();
      return;
    }
    this.router.up(e.pointerId, e.clientX, e.clientY, e.type !== 'pointerup');
    this.syncBoard();
    this.paint();
  };

  /** No scroll, pinch zoom, pull-to-refresh or compatibility mouse events for fingers on the controls. */
  private readonly onTouch = (e: TouchEvent): void => {
    if (e.cancelable) e.preventDefault();
  };

  private readonly onContextMenu = (e: Event): void => {
    e.preventDefault();
  };

  /** iOS Safari's pinch zoom (it ignores user-scalable=no): in the menus only, never on the controls, the canvas or a match's pause (document, not passive). */
  private readonly onGestureStart = (e: Event): void => {
    const t = e.target;
    if (!(t instanceof Element) || t.closest('.mn-open') === null || t.closest('.tc-root') !== null || t.tagName === 'CANVAS') e.preventDefault();
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
    this.holdJump = opts.holdJump;
    this.settings = opts.settings;
    const container = hudRoot.parentElement ?? hudRoot;
    this.container = container;
    this.router = new TouchRouter(this.state, this.layout);
    this.scoreBug = hudRoot.querySelector('.hud-top');
    this.boardPanel = hudRoot.querySelector('.hud-sb-panel');
    this.seen = cardsSeen();

    const root = el('div', 'tc-root');
    root.setAttribute('aria-hidden', 'true'); // finger-only game controls: the keyboard and the pad have their own
    this.root = root;
    this.zone = el('div', 'tc-zone');
    this.stick = el('div', 'tc-stick');
    this.knob = el('div', 'tc-knob');
    this.stick.appendChild(this.knob);
    const b = this.buttons;
    b[TB.JUMP] = el('div', 'tc-btn tc-big tc-jump', t('touch.jump'));
    // BOOST: the level rising from the bottom (a layer moved up, clipped by the circle), the amount, the name.
    b[TB.BOOST] = el('div', 'tc-btn tc-big tc-boost');
    this.boostLevel = el('div', 'tc-boost-level');
    this.boostNum = el('div', 'tc-boost-num', '0');
    b[TB.BOOST].append(this.boostLevel, this.boostNum, el('div', 'tc-boost-name', t('touch.boost')));
    b[TB.DRIFT] = el('div', 'tc-btn tc-big tc-drift', t('touch.drift'));
    // The small ones in the shared icon set (B5), CAM with its short name.
    b[TB.CAM] = el('div', 'tc-btn tc-small tc-cam');
    b[TB.CAM].append(icon('camera', 'tc-icon'), el('span', 'tc-cam-name', t('touch.cam')));
    b[TB.PAUSE] = el('div', 'tc-btn tc-small tc-pause');
    b[TB.PAUSE].appendChild(icon('pause', 'tc-icon'));
    b[TB.RESET] = el('div', 'tc-btn tc-small tc-reset');
    b[TB.RESET].appendChild(icon('refresh', 'tc-icon'));
    // The first-match card: one element, filled per card (showCard).
    this.cards = el('div', 'tc-cards');
    this.card = el('div', 'tc-card');
    this.cardIcon = el('div', 'tc-card-icon');
    this.cardStep = el('div', 'tc-card-step');
    this.cardTitle = el('div', 'tc-card-title');
    this.cardText = el('div', 'tc-card-text');
    const words = el('div', 'tc-card-words');
    words.append(this.cardStep, this.cardTitle, this.cardText);
    this.card.append(this.cardIcon, words, el('div', 'tc-card-ok', t('touch.cardOk')));
    this.cards.appendChild(this.card);
    this.cards.hidden = true;
    root.append(this.zone, this.stick, ...b, this.cards);
    if (hudRoot.parentElement !== null) hudRoot.after(root);
    else hudRoot.appendChild(root);

    // Portrait on a phone: a full-screen notice above every layer (touch.css shows it by media
    // query); over a live online match it is translucent with the scorebug above it (setLive).
    this.rotate = el('div', 'tc-rotate');
    this.rotateText = el('div', 'tc-rotate-text', t('touch.rotate'));
    this.rotate.append(el('div', 'tc-rotate-phone'), this.rotateText);
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
    // Only here, with a touch screen: on a Mac it would also block the trackpad's pinch zoom.
    document.addEventListener('gesturestart', this.onGestureStart, { passive: false });

    this.setTouchMode(coarsePointer());
    this.applySettings();
  }

  /** Settings > Controls > Touch changed (and once at the start): size, opacity, side, stick, deadzone, vibration. */
  applySettings(): void {
    const st = this.settings();
    const root = this.root;
    const k = String(TOUCH_SIZE_SCALE[st.size] ?? 1);
    if (root.style.getPropertyValue('--tc-k') !== k) root.style.setProperty('--tc-k', k);
    const alpha = String(Math.min(1, Math.max(0.3, st.opacity / 100)));
    if (root.style.getPropertyValue('--tc-alpha') !== alpha) root.style.setProperty('--tc-alpha', alpha);
    root.classList.toggle('tc-lefty', st.lefty);
    this.router.mirrored = st.lefty;
    this.router.fixedStick = st.stick === 'fixed';
    this.router.deadzone = st.deadzone;
    this.vibrate = st.vibration && canVibrate();
    this.dirty = true;
  }

  /** The last input used was a finger (or a pen): `tg-touch` is on <html>. */
  get touchMode(): boolean {
    return this.mode;
  }

  /** The overlay is up (`tc-show` on the root). */
  get visible(): boolean {
    return this.shown;
  }

  /** The full scoreboard was opened by a tap on the scorebug (the Game shows it as the held Tab one). */
  get scoreboardOpen(): boolean {
    return this.boardOpen;
  }

  /** A first-match card is up: offline the Game holds the match until the last one goes. */
  get cardsUp(): boolean {
    return this.cardIndex >= 0;
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
    if (on) {
      this.dirty = true;
      this.boostAt = -Infinity; // the amount at once
      if (this.seen < CARDS.length) this.showCard(this.seen);
    } else {
      this.release();
      this.setBoard(false);
      this.hideCard();
    }
  }

  /**
   * Per frame: the player's boost (0..100) on BOOST, written at most every BOOST_PERIOD of `time`
   * (the Game's clock, s) and only when the whole amount or its state changed. Precomputed strings
   * only: it allocates nothing.
   */
  setBoost(amount: number, time: number): void {
    if (!this.shown || (time - this.boostAt < BOOST_PERIOD && time >= this.boostAt)) return;
    this.boostAt = time;
    const v = Math.round(amount > 0 ? (amount < 100 ? amount : 100) : 0);
    if (v === this.boostShown) return;
    this.boostShown = v;
    this.boostNum.textContent = BOOST_TEXT[v];
    this.boostLevel.style.transform = BOOST_LEVEL[v];
    const state = v === 0 ? 1 : v < 20 ? 2 : v === 100 ? 3 : 0;
    if (state === this.boostState) return;
    this.boostState = state;
    const cl = this.buttons[TB.BOOST].classList;
    cl.toggle('tc-boost-empty', state === 1);
    cl.toggle('tc-boost-low', state === 2);
    cl.toggle('tc-boost-full', state === 3);
  }

  /** Per frame: an online match is on (the rotate notice is then translucent, the scorebug over it). Cached. */
  setLive(live: boolean): void {
    if (live === this.live) return;
    this.live = live;
    this.rotate.classList.toggle('tc-rotate-live', live);
    this.container.classList.toggle('tc-live', live);
    this.rotateText.textContent = t(live ? 'touch.rotateLive' : 'touch.rotate');
  }

  /**
   * Show first-match card `i` (0..2) while the controls are up; past the last, none. The overlay
   * calls it as the controls first come up; public for the layout check (scripts/ui-fit.mjs).
   */
  showCard(i: number): void {
    if (!this.shown || i < 0 || i >= CARDS.length) {
      this.hideCard();
      return;
    }
    const c = CARDS[i];
    this.cardIndex = i;
    this.cardAt = performance.now();
    this.cardFinger = -1;
    this.cardIcon.replaceChildren(icon(c.icon, 'tc-icon'));
    this.cardStep.textContent = t('touch.cardStep', { n: i + 1, total: CARDS.length });
    this.cardTitle.textContent = t(c.title);
    this.cardText.textContent = t(c.text);
    this.cards.hidden = false;
    this.dirty = true;
  }

  /** The card was tapped: remembered, and the next one (or none). */
  private nextCard(): void {
    const i = this.cardIndex;
    if (i < 0) return;
    if (i + 1 > this.seen) {
      this.seen = i + 1;
      noteCardsSeen(this.seen);
    }
    this.showCard(i + 1);
  }

  private hideCard(): void {
    if (this.cardIndex < 0) return;
    this.cardIndex = -1;
    this.cardFinger = -1;
    this.cards.hidden = true;
    this.dirty = true;
  }

  /** (x, y) on the card that is up. */
  private onCard(x: number, y: number): boolean {
    return this.cardIndex >= 0 && x >= this.cardLeft && x < this.cardRight && y >= this.cardTop && y < this.cardBottom;
  }

  /** (x, y) in the stick zone (as measured). */
  private inZone(x: number, y: number): boolean {
    const z = this.layout.zone;
    return x >= z.left && x < z.right && y >= z.top && y < z.bottom;
  }

  /** The router counted a tap on the scorebug or the board (on a lift, or a thumb landing on the board to drive): open / close it. */
  private syncBoard(): void {
    if (this.router.scoreTaps === this.scoreTapsSeen) return;
    this.scoreTapsSeen = this.router.scoreTaps;
    this.setBoard(!this.boardOpen);
  }

  /** Open or close the full scoreboard; the board's box is measured again before the next finger. */
  private setBoard(open: boolean): void {
    if (open === this.boardOpen) return;
    this.boardOpen = open;
    this.dirty = true;
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
    document.removeEventListener('gesturestart', this.onGestureStart);
    this.router.releaseAll();
    this.container.classList.remove('tc-on', 'tc-live');
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
    this.cardFinger = -1;
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
    layout.stickHome.x = this.stickRestX;
    layout.stickHome.y = this.stickRestY;
    for (let i = 0; i < TOUCH_BUTTON_COUNT; i++) {
      const e = this.buttons[i];
      const c = layout.buttons[i];
      const w = e.offsetWidth;
      c.r = w / 2;
      c.cx = ox + e.offsetLeft + w / 2;
      c.cy = oy + e.offsetTop + e.offsetHeight / 2;
    }
    // The scorebug (with a slop: a small target), the board while it is open, the card while up.
    const bug = this.scoreBug !== null ? this.scoreBug.getBoundingClientRect() : null;
    const score = layout.score;
    score.left = bug !== null && bug.width > 0 ? bug.left - SCORE_SLOP : 0;
    score.top = bug !== null && bug.width > 0 ? bug.top - SCORE_SLOP : 0;
    score.right = bug !== null && bug.width > 0 ? bug.right + SCORE_SLOP : 0;
    score.bottom = bug !== null && bug.width > 0 ? bug.bottom + SCORE_SLOP : 0;
    const panel = this.boardOpen && this.boardPanel !== null ? this.boardPanel.getBoundingClientRect() : null;
    const board = layout.board;
    board.left = panel !== null ? panel.left : 0;
    board.top = panel !== null ? panel.top : 0;
    board.right = panel !== null ? panel.right : 0;
    board.bottom = panel !== null ? panel.bottom : 0;
    // Opened, but the Game draws the board on its next frame: measured again until it is there.
    if (this.boardOpen && (panel === null || panel.width === 0)) this.dirty = true;
    const card = this.cardIndex >= 0 ? this.card.getBoundingClientRect() : null;
    this.cardLeft = card !== null ? card.left : 0;
    this.cardTop = card !== null ? card.top : 0;
    this.cardRight = card !== null ? card.right : 0;
    this.cardBottom = card !== null ? card.bottom : 0;
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
    // A button newly pressed: the player's pulse (a tap's lift clears its bit, never pulses).
    if (this.vibrate && (changed & mask) !== 0) navigator.vibrate(PRESS_PULSE_MS);
    this.paintedMask = mask;
    for (let i = 0; i < TOUCH_BUTTON_COUNT; i++) if ((changed & (1 << i)) !== 0) this.buttons[i].classList.toggle('tc-down', (mask & (1 << i)) !== 0);
  }
}
