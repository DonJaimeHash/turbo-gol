/**
 * Hold to confirm (plan §1.3 `mn-hold`, §1.7: 700 ms to redeem a car): a primary button that fills
 * while it is held and acts once full; let go first and it empties, nothing done. Every input holds
 * it its own way:
 * - a mouse button or a finger, pressed on it (pointer capture: sliding off still counts; a long
 *   press opens no context menu; a finger still down once it is full presses nothing under it);
 * - Enter, Space or a TV remote's OK, down on it (its own keydown / keyup; the native click is
 *   taken, so a tap of the key does nothing, a repeat starts nothing and, once it is full, presses
 *   nothing on the next sheet);
 * - a controller's A, which reaches it as a click (Menu.action → FocusNav.accept) with no pointer
 *   and no key on it: `held` (MenuHost.acceptHeld, Input's A or Enter down) is read every frame
 *   until the button is full or let go.
 * The fill is a transform (super low and reduced motion keep it: style.css spares .mn-hold).
 * Built on call.
 */
import { h } from '../dom';

export interface HoldOptions {
  readonly label: string;
  /** How long it is held, ms. */
  readonly ms: number;
  /** Is the press that clicked it (a controller's A) still down? Read every frame of such a hold. */
  readonly held?: () => boolean;
  /** Full: the action. */
  readonly onDone: () => void;
}

const HOLD_KEYS = new Set(['Enter', 'NumpadEnter', 'Space']);

/**
 * Full while the finger or the button is still down: its sheet goes, and the click its release
 * fires would land on whatever is under it now (a phone's tab bar). That one click is taken, up to
 * the release (a few seconds at most).
 */
function swallowRelease(): void {
  const take = (e: Event): void => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const end = (): void => {
    window.setTimeout(() => window.removeEventListener('click', take, true), 50);
  };
  window.addEventListener('click', take, true);
  window.addEventListener('pointerup', end, { capture: true, once: true });
  window.addEventListener('pointercancel', end, { capture: true, once: true });
  window.setTimeout(() => window.removeEventListener('click', take, true), 5000);
}

/** Full while Enter / OK is still down: its repeats would press what the next sheet focuses; they are taken up to its keyup. */
function swallowRepeats(code: string): void {
  const take = (e: KeyboardEvent): void => {
    if (e.code !== code) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const up = (e: KeyboardEvent): void => {
    if (e.code !== code) return;
    window.removeEventListener('keydown', take, true);
    window.removeEventListener('keyup', up, true);
  };
  window.addEventListener('keydown', take, true);
  window.addEventListener('keyup', up, true);
}

export function holdButton(o: HoldOptions): HTMLButtonElement {
  const fill = h('span.mn-hold', { 'aria-hidden': 'true' });
  const b = h('button.mn-btn.mn-btn-primary.mn-hold-btn', { type: 'button', 'data-nav': true }, fill, h('span.mn-hold-label', null, o.label));
  let by: 'pointer' | 'key' | 'press' | null = null;
  let timer = 0;
  let frame = 0;
  /** The key holding it (its repeats are taken once it is full). */
  let keyCode = '';
  /** A pointer started the hold: the click its release fires is not a controller's. */
  let pointerClick = false;

  const stop = (done: boolean): void => {
    if (by === null) return;
    if (done && by === 'pointer') swallowRelease();
    if (done && by === 'key') swallowRepeats(keyCode);
    by = null;
    window.clearTimeout(timer);
    cancelAnimationFrame(frame);
    b.classList.remove('mn-holding');
    if (done) o.onDone();
  };
  const start = (kind: 'pointer' | 'key' | 'press'): void => {
    if (by !== null || b.disabled) return;
    by = kind;
    b.style.setProperty('--hold-ms', `${o.ms}ms`);
    b.classList.add('mn-holding');
    timer = window.setTimeout(() => stop(true), o.ms);
    if (kind === 'press') watch();
  };
  const watch = (): void => {
    frame = requestAnimationFrame(() => {
      if (by !== 'press') return;
      if (o.held?.() === true) watch();
      else stop(false);
    });
  };

  b.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    pointerClick = true;
    b.setPointerCapture?.(e.pointerId);
    start('pointer');
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
    b.addEventListener(type, () => {
      if (by === 'pointer') stop(false);
    });
  }
  b.addEventListener('contextmenu', (e) => e.preventDefault());
  b.addEventListener('keydown', (e) => {
    if (!HOLD_KEYS.has(e.code)) return;
    e.preventDefault();
    if (e.repeat || by !== null) return;
    keyCode = e.code;
    start('key');
  });
  b.addEventListener('keyup', (e) => {
    if (!HOLD_KEYS.has(e.code)) return;
    e.preventDefault();
    if (by === 'key') stop(false);
  });
  b.addEventListener('blur', () => stop(false));
  b.addEventListener('click', (e) => {
    e.preventDefault();
    if (pointerClick) {
      pointerClick = false;
      return;
    }
    start('press');
  });
  return b;
}
