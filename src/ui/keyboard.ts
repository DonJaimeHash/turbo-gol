/**
 * A phone's on-screen keyboard over the menus' forms (plan PR 13: PERFIL's sign-up upright, the
 * account sheets, a lobby's code). Chrome on Android resizes only the visual viewport when the
 * keyboard opens (the layout viewport, and the menus' fixed shell, keep their height), so a field
 * low on the page would type unseen under it. While a keyboard covers the bottom, the menus' root
 * carries its height as `--kb-inset` (the stage and the phone's sheets make that much room at
 * their end: shell.css, components.css) and the focused field is scrolled to sit above it, in its
 * own scroller. keyboardInset is pure (tests/keyboard-inset.test.mjs).
 */

/** Under this many px the bottom is a browser bar or rounding, not a keyboard. */
const MIN_KEYBOARD = 80;
/** Room kept between the field and the keyboard's top. */
const MARGIN = 16;

/** What the keyboard covers of the layout viewport (`layoutHeight`, innerHeight), from the visual viewport's top and height; 0 for none. */
export function keyboardInset(layoutHeight: number, vvTop: number, vvHeight: number): number {
  const covered = layoutHeight - (vvTop + vvHeight);
  return covered >= MIN_KEYBOARD ? Math.round(covered) : 0;
}

/** How far `el`'s scroller must move down so that a box from `top` to `bottom` ends above `limit` (and starts below `ceiling`); 0 when it does. */
export function scrollToShow(top: number, bottom: number, ceiling: number, limit: number): number {
  if (bottom > limit) return Math.min(bottom - limit, Math.max(0, top - ceiling));
  return top < ceiling ? top - ceiling : 0;
}

/** A field that takes typing (nav.ts isEditable; kept here so the pure part needs no import). */
function typing(el: Element | null): el is HTMLElement {
  if (el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLInputElement && !['button', 'checkbox', 'radio', 'submit', 'range'].includes(el.type);
}

function scroller(el: HTMLElement, root: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p !== null && p !== root.parentElement; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/** Once, by the Menu: follow the visual viewport and the focus of `root`'s fields. */
export function installKeyboardInset(root: HTMLElement): void {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (vv == null) return;
  let last = 0;
  const apply = (): void => {
    const inset = keyboardInset(window.innerHeight, vv.offsetTop, vv.height);
    if (inset !== last) {
      last = inset;
      if (inset > 0) root.style.setProperty('--kb-inset', `${inset}px`);
      else root.style.removeProperty('--kb-inset');
    }
    const a = document.activeElement;
    if (inset === 0 || !typing(a) || !root.contains(a)) return;
    const sc = scroller(a, root);
    if (sc === null) return;
    const r = a.getBoundingClientRect();
    // The field's label sits over it (the label's box): it comes into view with the field.
    const box = (a.closest('.mn-field') ?? a).getBoundingClientRect();
    const d = scrollToShow(box.top, r.bottom, Math.max(vv.offsetTop, sc.getBoundingClientRect().top) + MARGIN, vv.offsetTop + vv.height - MARGIN);
    if (d !== 0) sc.scrollTop += d;
  };
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  // A field focused with the keyboard already up (the next field, ENTER on enterkeyhint "next").
  root.addEventListener('focusin', () => requestAnimationFrame(apply));
}
