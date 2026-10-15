/**
 * Spatial focus navigation for the menus, the same for keyboard and controller: every focusable
 * thing carries `data-nav`; arrows / D-pad move the real DOM focus to the nearest visible target in
 * that direction (so Enter / Space activate buttons natively and text fields take typing). An
 * element can claim left / right for itself (a choice control cycling values) through
 * `navLeft` / `navRight` properties, attached with `onNavSide`. The focused element also carries
 * the class `mn-focus` (controller users get a visible highlight; :focus-visible alone would not
 * show after a programmatic focus that followed a click).
 */

export type NavDir = 'up' | 'down' | 'left' | 'right';

interface SideHandlers {
  navLeft?: () => void;
  navRight?: () => void;
}

export function onNavSide(el: HTMLElement, left: () => void, right: () => void): void {
  const s = el as HTMLElement & SideHandlers;
  s.navLeft = left;
  s.navRight = right;
}

export function isEditable(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return !['button', 'checkbox', 'radio', 'submit', 'range'].includes(el.type);
  return el.isContentEditable;
}

function visible(el: HTMLElement): boolean {
  if ((el as HTMLButtonElement).disabled) return false;
  if (el.closest('[hidden]')) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/**
 * The best target from `from` in `dir` among `rects` (pure, unit-tested): candidates must lie in
 * the direction (centre beyond the source edge); the score is the distance along the direction
 * plus twice the sideways offset, so the row / column the user aims at wins over a nearer diagonal.
 */
export function pickTarget(from: DOMRectReadOnly, dir: NavDir, rects: readonly DOMRectReadOnly[]): number {
  const cx = from.left + from.width / 2;
  const cy = from.top + from.height / 2;
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    let along: number;
    let side: number;
    switch (dir) {
      case 'down':
        if (r.top < from.bottom - 2 && y <= cy + 2) continue;
        along = y - cy;
        side = Math.max(0, Math.abs(x - cx) - (r.width + from.width) / 4);
        break;
      case 'up':
        if (r.bottom > from.top + 2 && y >= cy - 2) continue;
        along = cy - y;
        side = Math.max(0, Math.abs(x - cx) - (r.width + from.width) / 4);
        break;
      case 'right':
        if (r.left < from.right - 2 && x <= cx + 2) continue;
        along = x - cx;
        side = Math.max(0, Math.abs(y - cy) - (r.height + from.height) / 4);
        break;
      default:
        if (r.right > from.left + 2 && x >= cx - 2) continue;
        along = cx - x;
        side = Math.max(0, Math.abs(y - cy) - (r.height + from.height) / 4);
        break;
    }
    if (along <= 0) continue;
    const score = along + side * 2;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

export class FocusNav {
  private readonly root: () => HTMLElement | null;

  constructor(root: () => HTMLElement | null) {
    this.root = root;
  }

  targets(): HTMLElement[] {
    const r = this.root();
    if (!r) return [];
    return Array.from(r.querySelectorAll<HTMLElement>('[data-nav]')).filter(visible);
  }

  get current(): HTMLElement | null {
    const a = document.activeElement;
    const r = this.root();
    return a instanceof HTMLElement && r !== null && r.contains(a) && a.hasAttribute('data-nav') ? a : null;
  }

  focus(el: HTMLElement | null): void {
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /** Focus `[data-autofocus]` or the first target (screen shown). */
  first(): void {
    const t = this.targets();
    this.focus(t.find((e) => e.hasAttribute('data-autofocus')) ?? t[0] ?? null);
  }

  /** Arrow / D-pad. True when something happened (focus moved or a side control changed). */
  move(dir: NavDir): boolean {
    const cur = this.current;
    if (cur === null) {
      this.first();
      return true;
    }
    const side = cur as HTMLElement & SideHandlers;
    if (dir === 'left' && side.navLeft) {
      side.navLeft();
      return true;
    }
    if (dir === 'right' && side.navRight) {
      side.navRight();
      return true;
    }
    const all = this.targets().filter((e) => e !== cur);
    const i = pickTarget(cur.getBoundingClientRect(), dir, all.map((e) => e.getBoundingClientRect()));
    if (i < 0) return false;
    this.focus(all[i]);
    return true;
  }

  /** Controller A: activate the focused target (a text field gets the caret). */
  accept(): void {
    const cur = this.current;
    if (cur === null) {
      this.first();
      return;
    }
    if (isEditable(cur)) cur.focus();
    else cur.click();
  }
}

/** Keep `mn-focus` on whatever menu element has the DOM focus (installed once per menu root). */
export function trackFocusClass(root: HTMLElement): void {
  root.addEventListener('focusin', (e) => {
    const t = e.target;
    if (t instanceof HTMLElement && t.hasAttribute('data-nav')) t.classList.add('mn-focus');
  });
  root.addEventListener('focusout', (e) => {
    const t = e.target;
    if (t instanceof HTMLElement) t.classList.remove('mn-focus');
  });
}
