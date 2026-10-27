/**
 * Spatial focus navigation for the menus, the same for the keyboard, the controller and a TV
 * remote: every focusable thing carries `data-nav`; arrows / D-pad move the real DOM focus to the
 * nearest visible target in that direction (so Enter / Space activate buttons natively and text
 * fields take typing). An element can claim left / right for itself (a choice control cycling
 * values) through `navLeft` / `navRight` properties, attached with `onNavSide`. The focused element
 * also carries the class `mn-focus` (controller users get a visible highlight; :focus-visible
 * alone would not show after a programmatic focus that followed a click).
 *
 * Around that spatial pick (pickTarget, unchanged: tests/menu-accounts.test.mjs) come the pure
 * pieces below (tests/nav-rows.test.mjs), which FocusNav puts on the DOM:
 * - Zones (NavZone): the top bar, the stage, the footer, the phone's tabs, or a modal alone. An
 *   arrow ▲ ▼ with no target in its zone goes on to the next zone that way, onto the target
 *   remembered there, else its `[data-nav-entry]`, else the nearest one (zoneEntryIndex). A side
 *   zone (the phone's rail, at the left) is crossed with ◀ ▶ instead: from any zone into it, and
 *   from it into the main zone. A held (repeated) arrow stops at a zone's edge: crossing takes a
 *   fresh press.
 * - Rows (`data-nav-row` on a container): ◀ ▶ walk its targets in DOM order, wrapped or stacked too
 *   (rowStep); ▲ ▼ leave it from the row's whole box (unionBox), so what is under a row does not
 *   depend on which member had the focus, and coming back into it lands on the member focused last.
 * - The way back (NavPath): the opposite arrow undoes the last move, as a stack (▼ ▼ ▲ ▲ retraces
 *   the path), while that target is still visible and still that way.
 * - Memory (FocusMemory): the last focus per scope (Menu: per screen and per zone), found again by
 *   the element itself or by its `data-key` once the screen rebuilt it.
 * - Fields: a text field reached with the arrows is in navigation mode (the 4 arrows move on, no
 *   caret: menu.css); OK / Enter / pad A, a typed character, a click, a tap or Tab put it in editing
 *   mode (`data-editing`: ← → move the caret, the pad's ← → too); Enter, pad A again, Esc / B
 *   (Menu.back) and ↑ ↓ leave it.
 * - Edges: an arrow with nowhere to go nudges the focused control 2 px that way (`mn-bounce-*`,
 *   menu.css; none in Super low or with reduced motion).
 * - Boxes (layoutBox): every pick reads a target where it sits in the layout, without its own lift
 *   (a focused or hovered tile, --focus-lift) or nudge, so a lifted tile has no neighbour "below"
 *   it on its own row.
 * No DOM at module level: node tests import it.
 */

export type NavDir = 'up' | 'down' | 'left' | 'right';

/** The geometry the picks read: a DOMRect, or a plain object in the tests. */
export interface NavBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export const OPPOSITE: Readonly<Record<NavDir, NavDir>> = { up: 'down', down: 'up', left: 'right', right: 'left' };
const DIRS: readonly NavDir[] = ['up', 'down', 'left', 'right'];
/** How long an edge's nudge lasts (menu.css `.mn-bounce-*`). */
const BOUNCE_MS = 120;
/** Moves the way back keeps. */
const PATH_MAX = 24;

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

/** A text field in editing mode (the header: typing, ← → move the caret). */
export function isEditing(el: Element | null): boolean {
  return isEditable(el) && (el as HTMLElement).hasAttribute('data-editing');
}

export function setEditing(el: HTMLElement, on: boolean): void {
  if (on) el.setAttribute('data-editing', '');
  else el.removeAttribute('data-editing');
}

function visible(el: HTMLElement): boolean {
  if ((el as HTMLButtonElement).disabled) return false;
  if (el.closest('[hidden], [inert]')) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** A computed length in px ('2px', '0'); anything else (a percentage, 'none') counts 0. */
function px(v: string | undefined): number {
  if (v === undefined || !(v === '0' || v.endsWith('px'))) return 0;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * `b` without the translation an element's own `transform` and `translate` put on it (their
 * computed values: 'matrix(...)', 'matrix3d(...)', '0px -2px', 'none'): a focused or hovered
 * tile's lift (--focus-lift, 3 px up) or an edge's nudge (mn-bounce) is no move, so a neighbour
 * on the same row never counts as below the lifted tile. Pure.
 */
export function layoutBox(b: NavBox, transform: string, translate: string): NavBox {
  let dx = 0;
  let dy = 0;
  const m = /^matrix(3d)?\(([^)]*)\)$/.exec(transform.trim());
  if (m !== null) {
    const v = m[2].split(',').map((s) => Number(s));
    const x = m[1] !== undefined ? v[12] : v[4];
    const y = m[1] !== undefined ? v[13] : v[5];
    if (Number.isFinite(x) && Number.isFinite(y)) {
      dx += x;
      dy += y;
    }
  }
  if (translate !== '' && translate !== 'none') {
    const [x, y] = translate.trim().split(/\s+/);
    dx += px(x);
    dy += px(y);
  }
  if (dx === 0 && dy === 0) return b;
  return { left: b.left - dx, top: b.top - dy, right: b.right - dx, bottom: b.bottom - dy, width: b.width, height: b.height };
}

/** Where `el` sits in the layout (layoutBox: its own lift or nudge taken off). */
function box(el: Element): NavBox {
  const cs = getComputedStyle(el);
  return layoutBox(el.getBoundingClientRect(), cs.transform, cs.translate);
}

/**
 * The best target from `from` in `dir` among `rects` (pure, unit-tested): candidates must lie in
 * the direction (centre beyond the source edge); the score is the distance along the direction
 * plus twice the sideways offset, so the row / column the user aims at wins over a nearer diagonal.
 */
export function pickTarget(from: NavBox, dir: NavDir, rects: readonly NavBox[]): number {
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

/** The member of a row of `n` after `i` moving `dir` (◀ ▶ walk the DOM order), -1 past either end. Pure. */
export function rowStep(i: number, n: number, dir: 'left' | 'right'): number {
  const j = dir === 'left' ? i - 1 : i + 1;
  return i >= 0 && i < n && j >= 0 && j < n ? j : -1;
}

/** The box around `boxes` (a row's members). Pure. */
export function unionBox(boxes: readonly NavBox[]): NavBox {
  if (boxes.length === 0) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  let l = Infinity;
  let t = Infinity;
  let r = -Infinity;
  let b = -Infinity;
  for (const x of boxes) {
    if (x.left < l) l = x.left;
    if (x.top < t) t = x.top;
    if (x.right > r) r = x.right;
    if (x.bottom > b) b = x.bottom;
  }
  return { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t };
}

/**
 * Where an arrow going `dir` from `from` lands entering a zone of `boxes`: the target remembered
 * there (`remembered`, an index or -1), else the zone's entry (`entry`, its `[data-nav-entry]`),
 * else the best one that way (pickTarget), else the nearest centre; -1 for an empty zone. Pure.
 */
export function zoneEntryIndex(from: NavBox, dir: NavDir, boxes: readonly NavBox[], remembered: number, entry: number): number {
  if (boxes.length === 0) return -1;
  if (remembered >= 0 && remembered < boxes.length) return remembered;
  if (entry >= 0 && entry < boxes.length) return entry;
  const i = pickTarget(from, dir, boxes);
  if (i >= 0) return i;
  const cx = from.left + from.width / 2;
  const cy = from.top + from.height / 2;
  let best = 0;
  let bestD = Infinity;
  for (let k = 0; k < boxes.length; k++) {
    const b = boxes[k];
    const dx = b.left + b.width / 2 - cx;
    const dy = b.top + b.height / 2 - cy;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

/** The way back: the moves made with the arrows, so the opposite arrow retraces them. Pure. */
export class NavPath<T> {
  private readonly steps: Array<{ from: T; to: T; dir: NavDir }> = [];

  /** A move from `from` to `to` going `dir`. */
  push(from: T, to: T, dir: NavDir): void {
    if (this.steps.length >= PATH_MAX) this.steps.shift();
    this.steps.push({ from, to, dir });
  }

  /**
   * Where `dir` from `cur` goes back to: the last move's origin when that move came to `cur` the
   * opposite way, else null. A path `cur` is not at the end of is dropped (the focus went elsewhere).
   */
  back(cur: T, dir: NavDir): T | null {
    const s = this.steps[this.steps.length - 1];
    if (s === undefined) return null;
    if (s.to !== cur) {
      this.steps.length = 0;
      return null;
    }
    return s.dir === OPPOSITE[dir] ? s.from : null;
  }

  /** The way back `back` gave was taken. */
  pop(): void {
    this.steps.pop();
  }

  clear(): void {
    this.steps.length = 0;
  }

  get length(): number {
    return this.steps.length;
  }
}

/** The last focus per scope (a screen, a zone), found again by the element itself or by its key (`data-key`) once the screen rebuilt it. Pure. */
export class FocusMemory<T> {
  private readonly last = new Map<string, { el: T; key: string | null }>();

  remember(scope: string, el: T, key: string | null): void {
    this.last.set(scope, { el, key });
  }

  forget(scope: string): void {
    this.last.delete(scope);
  }

  has(scope: string): boolean {
    return this.last.has(scope);
  }

  /** The remembered target of `scope` among `targets`: the same element, else the one with its key; null when neither is there. */
  recall(scope: string, targets: readonly T[], keyOf: (el: T) => string | null): T | null {
    const m = this.last.get(scope);
    if (m === undefined) return null;
    if (targets.includes(m.el)) return m.el;
    if (m.key === null) return null;
    return targets.find((t) => keyOf(t) === m.key) ?? null;
  }
}

/** An element's stable key for the memory (`data-key`), null without one. */
export function navKey(el: Element): string | null {
  return el.getAttribute('data-key');
}

/** Move a field's caret by one character (the pad's ← → while editing); nothing for a type without one. */
function caretStep(el: HTMLElement, d: -1 | 1): void {
  const f = el as HTMLInputElement;
  try {
    const at = d < 0 ? (f.selectionStart ?? 0) : (f.selectionEnd ?? f.value.length);
    const p = Math.max(0, Math.min(f.value.length, at + d));
    f.setSelectionRange(p, p);
  } catch {
    /* email / number fields have no selection API */
  }
}

/**
 * A focus zone: an element whose `[data-nav]` targets the arrows move among. `main`: where a
 * screen's or a modal's first focus goes. `side`: beside the others (the rail), crossed with ◀ ▶,
 * never with ▲ ▼.
 */
export interface NavZone {
  readonly name: string;
  readonly el: HTMLElement;
  readonly main?: boolean;
  readonly side?: boolean;
}

export interface FocusNavOptions {
  /** The target to land on entering `zone` (Menu: the one focused there last), among its `targets`; null for none. */
  remembered?(zone: NavZone, targets: readonly HTMLElement[]): HTMLElement | null;
  /** An arrow or A with nothing focused: where to start (Menu: the remembered focus, else the first). Default: `first()`. */
  restore?(): void;
  /** A target got the focus, any way (the arrows, a click, a tap, Tab, a screen's own focus()). */
  onFocus?(el: HTMLElement, zone: NavZone | null): void;
}

export class FocusNav {
  private readonly zones: () => readonly NavZone[];
  private readonly opts: FocusNavOptions;
  private readonly path = new NavPath<HTMLElement>();
  /** Per row container: its member focused last (coming back into the row lands there). */
  private readonly rowLast = new WeakMap<Element, HTMLElement>();
  /** The element `focus` is focusing right now: its focusin is the arrows', not a click's. */
  private focusing: HTMLElement | null = null;
  /** The control nudged last (its class goes when the next nudge starts or after BOUNCE_MS). */
  private bounced: HTMLElement | null = null;
  private bounceTimer = 0;

  constructor(zones: () => readonly NavZone[], opts: FocusNavOptions = {}) {
    this.zones = zones;
    this.opts = opts;
  }

  /** The visible targets of `zone`, or of every zone. */
  targets(zone?: NavZone): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (const z of zone ? [zone] : this.zones()) for (const e of z.el.querySelectorAll<HTMLElement>('[data-nav]')) if (visible(e)) out.push(e);
    return out;
  }

  /** The zone holding `el`, null outside them. */
  zoneOf(el: Element): NavZone | null {
    for (const z of this.zones()) if (z.el.contains(el)) return z;
    return null;
  }

  private mainZone(): NavZone | null {
    const zs = this.zones();
    return zs.find((z) => z.main === true) ?? zs[0] ?? null;
  }

  get current(): HTMLElement | null {
    const a = document.activeElement;
    return a instanceof HTMLElement && a.hasAttribute('data-nav') && this.zoneOf(a) !== null ? a : null;
  }

  /** Focus `el` as the arrows do (a text field arrives in navigation mode) and scroll it into view. */
  focus(el: HTMLElement | null): void {
    if (!el) return;
    this.focusing = el;
    try {
      el.focus({ preventScroll: true });
    } finally {
      this.focusing = null;
    }
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /**
   * Focus the main zone's `[data-autofocus]` or first target (a screen or a modal shown).
   * `skipFields`: never a text field (no fine pointer: a phone or a TV would pop the system keyboard up).
   */
  first(skipFields = false): void {
    const z = this.mainZone();
    if (z === null) return;
    const t = this.targets(z).filter((e) => !skipFields || !isEditable(e));
    this.focus(t.find((e) => e.hasAttribute('data-autofocus')) ?? t[0] ?? null);
  }

  /** Forget the way back (a new screen or modal). */
  reset(): void {
    this.path.clear();
  }

  private start(): void {
    if (this.opts.restore) this.opts.restore();
    else this.first();
  }

  /**
   * Arrow / D-pad; `repeat`: a held one's auto-repeat (it cycles no choice and crosses no zone).
   * True when something happened (the focus moved, a side control changed, a field's caret moved);
   * false at an edge, where the focused control bounces.
   */
  move(dir: NavDir, repeat = false): boolean {
    const cur = this.current;
    if (cur === null) {
      this.start();
      return true;
    }
    const horizontal = dir === 'left' || dir === 'right';
    if (isEditing(cur)) {
      if (horizontal) {
        caretStep(cur, dir === 'left' ? -1 : 1);
        return true;
      }
      setEditing(cur, false); // ↑ ↓ leave the field's editing and move on
    }
    const side = cur as HTMLElement & SideHandlers;
    const claim = dir === 'left' ? side.navLeft : dir === 'right' ? side.navRight : undefined;
    if (claim) {
      if (!repeat) claim(); // a held arrow does not spin a choice (a stadium switch reloads the scene)
      return true;
    }
    const zone = this.zoneOf(cur);
    if (zone === null) return false;
    const from = box(cur);
    const back = this.path.back(cur, dir);
    if (back !== null && back !== cur && this.targets().includes(back) && pickTarget(from, dir, [box(back)]) === 0) {
      this.path.pop();
      this.focus(back);
      return true;
    }
    const row = cur.closest('[data-nav-row]');
    const members = row !== null ? this.targets(zone).filter((e) => row.contains(e)) : null;
    let next: HTMLElement | null = null;
    if (members !== null) {
      if (horizontal) {
        const j = rowStep(members.indexOf(cur), members.length, dir);
        if (j >= 0) next = members[j];
      } else {
        // A wrapped or stacked row (a narrow screen): its next line first.
        const others = members.filter((e) => e !== cur);
        const i = pickTarget(from, dir, others.map(box));
        if (i >= 0) next = others[i];
      }
    }
    // ◀ ▶ in a side zone (the rail, a column): out of it, past its own other targets (a row's
    // members aside, done above).
    if (next === null && horizontal && zone.side === true) {
      next = repeat ? null : this.crossSide(zone, from, dir);
      if (next === null) {
        this.bounce(cur, dir);
        return false;
      }
      this.path.push(cur, next, dir);
      this.focus(next);
      return true;
    }
    if (next === null) {
      // Leaving a one-line row up or down: from the row's whole box. A stacked row (a narrow screen)
      // is left from its last member, as anything else (its box would reach back up past it).
      const rowBox = members !== null && !horizontal ? unionBox(members.map(box)) : null;
      const src = rowBox !== null && rowBox.height <= from.height * 1.5 ? rowBox : from;
      const all = this.targets(zone).filter((e) => e !== cur && (members === null || !members.includes(e)));
      const i = pickTarget(src, dir, all.map(box));
      if (i >= 0) next = horizontal ? all[i] : this.intoRow(all[i]);
    }
    if (next === null && !repeat) next = horizontal ? this.crossSide(zone, from, dir) : this.crossZone(zone, from, dir);
    if (next === null) {
      this.bounce(cur, dir);
      return false;
    }
    this.path.push(cur, next, dir);
    this.focus(next);
    return true;
  }

  /** Coming into a row from above or below: its member focused last, when it is still there. */
  private intoRow(t: HTMLElement): HTMLElement {
    const row = t.closest('[data-nav-row]');
    if (row === null) return t;
    const last = this.rowLast.get(row);
    return last !== undefined && last !== t && last.isConnected && row.contains(last) && visible(last) ? last : t;
  }

  /** Where an arrow going `dir` lands in zone `z` (zoneEntryIndex), null for an empty zone. */
  private enter(z: NavZone, from: NavBox, dir: NavDir, t: readonly HTMLElement[]): HTMLElement | null {
    const rem = this.opts.remembered?.(z, t) ?? null;
    const i = zoneEntryIndex(from, dir, t.map(box), rem !== null ? t.indexOf(rem) : -1, t.findIndex((e) => e.hasAttribute('data-nav-entry')));
    return i >= 0 ? t[i] : null;
  }

  /** The next zone that way with a target (side zones skipped): where the arrow lands there, null past the last. */
  private crossZone(zone: NavZone, from: NavBox, dir: NavDir): HTMLElement | null {
    const zs = this.zones().filter((z) => z.side !== true);
    const k = zs.findIndex((z) => z.el === zone.el);
    const step = dir === 'down' ? 1 : -1;
    for (let j = k + step; k >= 0 && j >= 0 && j < zs.length; j += step) {
      const t = this.targets(zs[j]);
      if (t.length === 0) continue;
      const next = this.enter(zs[j], from, dir, t);
      if (next !== null) return next;
    }
    return null;
  }

  /** ◀ ▶ past a zone's edge: into a side zone that lies that way, or out of one into the main zone. */
  private crossSide(zone: NavZone, from: NavBox, dir: NavDir): HTMLElement | null {
    for (const z of this.zones()) {
      if (z.el === zone.el || (zone.side === true ? z.main !== true : z.side !== true)) continue;
      const t = this.targets(z);
      if (t.length === 0 || pickTarget(from, dir, t.map(box)) < 0) continue; // nothing of it lies that way
      const next = this.enter(z, from, dir, t);
      if (next !== null) return next;
    }
    return null;
  }

  /** The edge: a 2 px nudge that way (menu.css). */
  private bounce(el: HTMLElement, dir: NavDir): void {
    const clear = (e: HTMLElement): void => {
      for (const d of DIRS) e.classList.remove('mn-bounce-' + d);
    };
    if (this.bounced !== null) clear(this.bounced);
    void el.offsetWidth; // restart the animation at the same edge
    el.classList.add('mn-bounce-' + dir);
    this.bounced = el;
    window.clearTimeout(this.bounceTimer);
    this.bounceTimer = window.setTimeout(() => {
      clear(el);
      this.bounced = null;
    }, BOUNCE_MS + 40);
  }

  /** Controller A / remote OK on a text field: editing on, or off again; anything else is clicked. */
  accept(): void {
    const cur = this.current;
    if (cur === null) {
      this.start();
      return;
    }
    if (isEditable(cur)) setEditing(cur, !isEditing(cur));
    else cur.click();
  }

  /**
   * The DOM side, once per menu root: `mn-focus` on the focused target, the fields' modes (arrived
   * with the arrows: navigation; a click, a tap, Tab: editing), each row's last member, `onFocus`.
   */
  install(root: HTMLElement): void {
    root.addEventListener('focusin', (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement) || !t.hasAttribute('data-nav')) return;
      t.classList.add('mn-focus');
      const byArrows = this.focusing === t;
      if (!byArrows) this.path.clear(); // the way back starts again where a click or Tab put the focus
      if (isEditable(t)) setEditing(t, !byArrows);
      const row = t.closest('[data-nav-row]');
      if (row !== null) this.rowLast.set(row, t);
      if (this.opts.onFocus) this.opts.onFocus(t, this.zoneOf(t));
    });
    root.addEventListener('focusout', (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      t.classList.remove('mn-focus');
      if (isEditable(t)) setEditing(t, false);
    });
    // A click or a tap on the field that already has the focus (navigation mode): editing.
    root.addEventListener(
      'pointerdown',
      (e) => {
        const t = e.target;
        if (t instanceof HTMLElement && t === document.activeElement && isEditable(t)) setEditing(t, true);
      },
      true,
    );
    // Text that arrived without a usable keydown (a virtual keyboard, a paste): editing.
    root.addEventListener('input', (e) => {
      const t = e.target;
      if (t instanceof HTMLElement && isEditable(t) && !isEditing(t)) setEditing(t, true);
    });
  }
}
