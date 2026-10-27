/**
 * `data-fit="<min px>"` (plan §2.4): a box whose text could outgrow it (the section bar, a rail
 * label, a crumb, the hint bar) declares the smallest size it may take (a stylesheet may raise it
 * for a layout with the `--fit-min` custom property: 16 on a TV); fitAll shrinks its font 1 px at a
 * time, only while its content overflows it, never below that minimum, and then swaps in the short
 * forms it has (`data-fit-alt`). Still too wide, the parts that may give way go, level by level
 * (`data-fit-give="<n>"`, 1 first, each level with the ones before it), each time fitted again from
 * the full size: inside the box, or inside the ancestor its `data-fit-scope` names (the section
 * strip's ‹ › / L R / Q E beside it). The TV's hint bar: the controller's Settings hint (the gear
 * says it), then the pills' words (their icons stay, the search its clock and ✕), then the hint to
 * cancel the search (the pill's ✕ beside it). Its children size in em (or inherit), so a whole tab
 * strip shrinks as one. The insurance for the fallback fonts (Roboto on a phone or a TV without the
 * display font, a Linux face wider than Arial, #widetext), the longer Spanish texts, and a larger
 * interface size.
 *
 * The minimum is in px at the layout class's reference view (plan §1.2.3): on a TV that is its
 * width / 960 (--ui-scale, 1 to 2), so a 1920 wide TV keeps 32 CSS px where a 960 one keeps 16; a
 * phone's and a PC's px are the screen's own.
 *
 * The Menu runs it right after every mount and every change of the hints, the input, the chip or
 * a pill (before that frame is drawn: a pad's press mounts inside the game loop's frame), on the
 * frame after a resize, and once the fonts are in. A box that is not laid out (the section strip
 * under a stacked screen's crumbs) keeps the size, the texts and the parts gone it was fitted to,
 * so it comes back fitted.
 *
 * In development (or a build with VITE_UI_FIT=1) `window.__uiFit()` reports, after running the fit
 * the last change queued for the next frame (Menu), what a layout check
 * needs (scripts/ui-fit.mjs, plan §2.6): the shell's bars overflowing, `data-fit` boxes still
 * overflowing at their minimum, a horizontal scroll, the stage scrolling, focus rings a clipping
 * ancestor or the screen's edge would cut, shell text under the class's minimum (plan §1.2.3: 14 px
 * on a phone, 16 on a TV at its reference view) and the menus' DOM size.
 */

/** CSS px per px of the layout class's reference view: --ui-scale on a TV (its width / 960), 1 elsewhere. */
function referencePx(): number {
  const html = document.documentElement;
  if (html.dataset.layout !== 'tv') return 1;
  const s = Number.parseFloat(html.style.getPropertyValue('--ui-scale'));
  return Number.isFinite(s) && s > 0 ? s : 1;
}

/** The left and right of `el`'s content box (inside its border and padding: a bar's overscan, the rail's gesture margin). */
function contentX(el: HTMLElement): [number, number] {
  const cs = getComputedStyle(el);
  const b = el.getBoundingClientRect();
  return [b.left + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0), b.right - (parseFloat(cs.borderRightWidth) || 0) - (parseFloat(cs.paddingRight) || 0)];
}

/**
 * Overflowing by more than half a pixel (sub-pixel layout): its scroll width, or (a padded bar) a
 * child out of its content box, into the padding that scrollWidth does not count.
 */
function overflows(el: HTMLElement): boolean {
  if (el.scrollWidth > el.clientWidth + 0.5) return true;
  if (el.children.length === 0) return false;
  const [left, right] = contentX(el);
  for (const c of el.children) {
    const r = c.getBoundingClientRect();
    if (r.width > 0 && (r.right > right + 0.5 || r.left < left - 0.5)) return true;
  }
  return false;
}

/** Shrink `el` 1 px at a time while it overflows, down to its minimum; true when it fits. */
function shrink(el: HTMLElement, min: number): boolean {
  el.style.fontSize = '';
  let size = parseFloat(getComputedStyle(el).fontSize);
  for (let i = 0; i < 48 && size > min && overflows(el); i++) {
    size = Math.max(min, size - 1);
    el.style.fontSize = size + 'px';
  }
  return !overflows(el);
}

/** The level a part gives way at (`data-fit-give`), 0 for none. */
const giveLevel = (g: HTMLElement): number => Number(g.dataset.fitGive) || 0;

/** The levels that occur among `gives`, lowest first. Pure. */
export function giveLevels(levels: readonly number[]): number[] {
  return [...new Set(levels.filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
}

/**
 * One data-fit box: its full texts back and every part it hid shown, shrunk while it overflows;
 * still overflowing at its minimum, the texts that have a short form (`data-fit-alt`, on the box or
 * inside it: ENTRENAR for ENTRENAMIENTO) take it and the box is fitted again; still overflowing,
 * the parts that give way (`data-fit-give`) go, a level at a time, each time fitted again. A box
 * that is not laid out is left as it is. A part the fit hid is `display: none` inline and marked
 * `data-fit-gone`; a part rebuilt since (a pill's new text) shows until the next fit.
 */
function fitOne(el: HTMLElement): void {
  // Not laid out (hidden in this layout, or under a stacked screen): nothing to measure, and the
  // last fit stays, so the box shows fitted when it comes back (the next pass refits it from scratch).
  if (el.offsetParent === null || el.clientWidth === 0) return;
  const alts = [el, ...el.querySelectorAll<HTMLElement>('[data-fit-alt]')].filter((e) => e.dataset.fitAlt !== undefined);
  for (const a of alts) if (a.dataset.fitFull !== undefined) a.textContent = a.dataset.fitFull;
  const scope = (el.dataset.fitScope !== undefined ? el.closest<HTMLElement>(el.dataset.fitScope) : null) ?? el;
  const gives = Array.from(scope.querySelectorAll<HTMLElement>('[data-fit-give]'));
  for (const g of gives) {
    if (g.dataset.fitGone === undefined) continue;
    delete g.dataset.fitGone;
    g.style.removeProperty('display');
  }
  el.style.fontSize = '';
  const min = (Number(getComputedStyle(el).getPropertyValue('--fit-min')) || Number(el.dataset.fit) || 12) * referencePx();
  if (shrink(el, min)) return;
  if (alts.length > 0) {
    for (const a of alts) {
      a.dataset.fitFull = a.textContent ?? '';
      a.textContent = a.dataset.fitAlt ?? '';
    }
    if (shrink(el, min)) return;
  }
  for (const n of giveLevels(gives.map(giveLevel))) {
    for (const g of gives) {
      if (giveLevel(g) > n || g.dataset.fitGone !== undefined) continue;
      g.dataset.fitGone = '';
      g.style.display = 'none';
    }
    if (shrink(el, min)) return;
  }
}

export function fitAll(root: ParentNode): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-fit]')) fitOne(el);
}

/**
 * Show again every part a fit took away inside `el` (data-fit-gone): moved out of the box that
 * hid them, no fit of that box brings them back (a TV's pills, from its hint bar to Inicio's
 * plate row: Menu.placePills).
 */
export function restoreGiven(el: ParentNode): void {
  for (const g of el.querySelectorAll<HTMLElement>('[data-fit-gone]')) {
    delete g.dataset.fitGone;
    g.style.removeProperty('display');
  }
}

export interface UiFitReport {
  layout: string;
  width: number;
  height: number;
  scale: string;
  screen: string;
  /** Bars of the shell (top, rail, hint, tabs) whose content overflows them (sideways: their content box, the overscan and the gesture margin kept clear) or leaves the screen. */
  shellOverflow: string[];
  /** data-fit boxes that still overflow at their minimum. */
  fitOverflow: string[];
  /** The page scrolls sideways. */
  hScroll: boolean;
  /** The stage scrolls (allowed for long lists; a screen's main action may not need it). */
  stageScroll: boolean;
  /** Focusable controls whose ring or heel a clipping ancestor (the menus' root too) or the screen's edge would cut. */
  clippedFocus: string[];
  /**
   * Text in the shell's bars under the class's minimum (14 px on a phone, upright or sideways; 16
   * on a TV at its reference view: times --ui-scale), "(data-fit)" when the data-fit box of a
   * section list's label or of the rail's foot shrank it (allowed down to its own minimum for the
   * fallback fonts: the rail's 12, which the upright tab bar's labels share).
   */
  smallText: string[];
  nodes: number;
}

const describe = (el: Element): string => {
  const c = typeof el.className === 'string' ? el.className.split(/\s+/).filter((x) => x.startsWith('mn-'))[0] : '';
  const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 24);
  return `${el.tagName.toLowerCase()}${c ? '.' + c : ''}${text ? ' "' + text + '"' : ''}`;
};

const shown = (el: Element): boolean => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
};

/** The report (see UiFitReport) for the menus' root. */
export function uiFitReport(root: HTMLElement, screen: string): UiFitReport {
  const html = document.documentElement;
  const W = window.innerWidth;
  const H = window.innerHeight;
  const shellOverflow: string[] = [];
  for (const bar of root.querySelectorAll<HTMLElement>('.mn-top, .mn-rail, .mn-hint, .mn-tabbar')) {
    if (!shown(bar)) continue;
    // Sideways only: a focused control's heel may hang below its bar (focus.css), which is no overflow.
    if (bar.scrollWidth > bar.clientWidth + 1) shellOverflow.push(describe(bar) + ' overflows');
    const box = bar.getBoundingClientRect();
    const [left, right] = contentX(bar);
    for (const el of bar.querySelectorAll<HTMLElement>('button, a, .mn-pill, .mn-hint-item, .mn-crumbs')) {
      if (!shown(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.right > right + 1 || r.left < left - 1 || r.bottom > box.bottom + 1 || r.top < box.top - 1 || r.right > W + 1) shellOverflow.push(describe(el));
    }
  }
  const fitOverflow: string[] = [];
  for (const el of root.querySelectorAll<HTMLElement>('[data-fit]')) if (shown(el) && overflows(el)) fitOverflow.push(describe(el));
  // The ring as focus.css draws it, from the tokens (a TV's is thicker): --focus-w + --focus-gap
  // around the box, the heel --focus-heel-y + --focus-heel under it (a row has its bar inside
  // instead), a tile lifted by --focus-lift; an edge control (shell.css: --ring-offset) draws it
  // inside its own box. Checked against every clipping ancestor up to and including the menus' root (the screen),
  // and against the screen; inside a scroller (the stage) only sideways above it: it scrolls a
  // control into view with room for the ring (scroll-padding).
  const clippedFocus: string[] = [];
  const hcs = getComputedStyle(html);
  const token = (name: string, d: number): number => {
    const v = Number.parseFloat(hcs.getPropertyValue(name));
    return Number.isFinite(v) ? v : d;
  };
  const ring = token('--focus-w', 3) + token('--focus-gap', 3);
  const heel = token('--focus-heel-y', 11) + token('--focus-heel', 4);
  const lift = Math.abs(token('--focus-lift', -3));
  for (const el of root.querySelectorAll<HTMLElement>('[data-nav]')) {
    if (!shown(el) || el.closest('[hidden], [inert]') !== null) continue;
    const r = el.getBoundingClientRect();
    const inside = getComputedStyle(el).getPropertyValue('--ring-offset').trim() !== '';
    const row = el.matches('.mn-sl-item, .mn-lobby-row, .mn-pack, .mn-cycle');
    const up = el.matches('.mn-tile') ? lift : 0;
    const o = inside ? 0 : ring;
    const box = { left: r.left - o, right: r.right + o, top: r.top - o - up, bottom: r.bottom + (inside ? 0 : row ? ring : Math.max(ring, heel)) - up };
    let cut: string | null = null;
    let scrolled = false;
    for (let a = el.parentElement; a !== null && cut === null; a = a.parentElement) {
      const cs = getComputedStyle(a);
      const clipX = cs.overflowX !== 'visible';
      const clipY = cs.overflowY === 'hidden' || cs.overflowY === 'clip';
      if (clipX || clipY) {
        const b = a.getBoundingClientRect();
        if ((clipX && (box.left < b.left - 0.5 || box.right > b.right + 0.5)) || (!scrolled && clipY && (box.top < b.top - 0.5 || box.bottom > b.bottom + 0.5))) cut = describe(a);
        if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') scrolled = true;
      }
      if (a === root) break;
    }
    if (cut === null && (box.left < -0.5 || box.right > W + 0.5 || (!scrolled && (box.top < -0.5 || box.bottom > H + 0.5)))) cut = 'the screen';
    if (cut !== null) clippedFocus.push(describe(el) + ' in ' + cut);
  }
  const layout = html.dataset.layout ?? '';
  const floor = layout === 'tv' ? 16 * referencePx() : layout === 'phone' || layout === 'portrait' ? 14 : 0;
  const smallText: string[] = [];
  if (floor > 0) {
    for (const bar of root.querySelectorAll<HTMLElement>('.mn-top, .mn-rail, .mn-hint, .mn-tabbar')) {
      if (!shown(bar)) continue;
      for (const el of bar.querySelectorAll<HTMLElement>('*')) {
        if (!shown(el) || !Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').trim() !== '')) continue;
        const px = parseFloat(getComputedStyle(el).fontSize);
        if (px >= floor - 0.05) continue;
        // Allowed only to the section lists' labels and the rail's foot (plan §1.2.3: the rail's 12;
        // the upright tab bar shares its labels), shrunk by their own data-fit for a fallback face.
        const fit = el.closest<HTMLElement>('[data-fit]');
        const allowed = fit !== null && fit.style.fontSize !== '' && fit.closest('.mn-rail, .mn-tabbar') !== null;
        smallText.push(`${describe(el)} ${px.toFixed(1)}px${allowed ? ' (data-fit)' : ''}`);
      }
    }
  }
  const stage = root.querySelector<HTMLElement>('.mn-stage');
  return {
    layout,
    width: W,
    height: H,
    scale: html.style.getPropertyValue('--ui-scale'),
    screen,
    shellOverflow,
    fitOverflow,
    hScroll: html.scrollWidth > W + 1 || document.body.scrollWidth > W + 1,
    stageScroll: stage !== null && stage.scrollHeight > stage.clientHeight + 1,
    clippedFocus,
    smallText,
    nodes: root.querySelectorAll('*').length,
  };
}
