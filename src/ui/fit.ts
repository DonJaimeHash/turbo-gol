/**
 * `data-fit="<min px>"` (plan §2.4): a box whose text could outgrow it (the section bar, a rail
 * label, a crumb) declares the smallest size it may take; fitAll shrinks its font 1 px at a time,
 * only while its content overflows it, never below that minimum, and then swaps in the short forms
 * it has (`data-fit-alt`). Its children size in em (or inherit), so a whole tab strip shrinks as one. The insurance for the fallback fonts (Roboto on
 * a phone or a TV without the display font, #widetext) and for a larger interface size. The Menu
 * runs it on every mount, resize and once the fonts are in.
 *
 * In development (or a build with VITE_UI_FIT=1) `window.__uiFit()` reports what a layout check
 * needs (scripts/ui-fit.mjs, plan §2.6): the shell's bars overflowing, `data-fit` boxes still
 * overflowing at their minimum, a horizontal scroll, the stage scrolling, focus rings a clipping
 * ancestor would cut, and the menus' DOM size.
 */

/** Overflowing by more than half a pixel (sub-pixel layout). */
function overflows(el: HTMLElement): boolean {
  return el.scrollWidth > el.clientWidth + 0.5;
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

/**
 * One data-fit box: its full texts back, shrunk while it overflows; still overflowing at its
 * minimum, the texts that have a short form (`data-fit-alt`, on the box or inside it: ENTRENAR for
 * ENTRENAMIENTO) take it and the box is fitted again.
 */
function fitOne(el: HTMLElement): void {
  const alts = [el, ...el.querySelectorAll<HTMLElement>('[data-fit-alt]')].filter((e) => e.dataset.fitAlt !== undefined);
  for (const a of alts) if (a.dataset.fitFull !== undefined) a.textContent = a.dataset.fitFull;
  el.style.fontSize = '';
  if (el.offsetParent === null || el.clientWidth === 0) return; // not laid out (hidden in this layout)
  const min = Number(el.dataset.fit) || 12;
  if (shrink(el, min) || alts.length === 0) return;
  for (const a of alts) {
    a.dataset.fitFull = a.textContent ?? '';
    a.textContent = a.dataset.fitAlt ?? '';
  }
  shrink(el, min);
}

export function fitAll(root: ParentNode): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-fit]')) fitOne(el);
}

export interface UiFitReport {
  layout: string;
  width: number;
  height: number;
  scale: string;
  screen: string;
  /** Bars of the shell (top, rail, hint, tabs) whose content overflows them or leaves the screen. */
  shellOverflow: string[];
  /** data-fit boxes that still overflow at their minimum. */
  fitOverflow: string[];
  /** The page scrolls sideways. */
  hScroll: boolean;
  /** The stage scrolls (allowed for long lists; a screen's main action may not need it). */
  stageScroll: boolean;
  /** Focusable controls whose ring or heel a clipping (overflow: hidden) ancestor would cut. */
  clippedFocus: string[];
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
    for (const el of bar.querySelectorAll<HTMLElement>('button, a, .mn-pill, .mn-hint-item, .mn-crumbs')) {
      if (!shown(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.right > box.right + 1 || r.left < box.left - 1 || r.bottom > box.bottom + 1 || r.top < box.top - 1 || r.right > W + 1) shellOverflow.push(describe(el));
    }
  }
  const fitOverflow: string[] = [];
  for (const el of root.querySelectorAll<HTMLElement>('[data-fit]')) if (shown(el) && overflows(el)) fitOverflow.push(describe(el));
  const clippedFocus: string[] = [];
  const ring = 6; // --focus-w + --focus-gap
  const heel = 15; // --focus-heel-y + --focus-heel
  for (const el of root.querySelectorAll<HTMLElement>('[data-nav]')) {
    if (!shown(el) || el.closest('[hidden], [inert]') !== null) continue;
    const r = el.getBoundingClientRect();
    for (let a = el.parentElement; a !== null && a !== root; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX !== 'hidden' && cs.overflowY !== 'hidden' && cs.overflowX !== 'clip' && cs.overflowY !== 'clip') continue;
      const b = a.getBoundingClientRect();
      if (r.left - ring < b.left - 0.5 || r.right + ring > b.right + 0.5 || r.top - ring < b.top - 0.5 || r.bottom + heel > b.bottom + 0.5) {
        clippedFocus.push(describe(el) + ' in ' + describe(a));
        break;
      }
    }
  }
  const stage = root.querySelector<HTMLElement>('.mn-stage');
  return {
    layout: html.dataset.layout ?? '',
    width: W,
    height: H,
    scale: html.style.getPropertyValue('--ui-scale'),
    screen,
    shellOverflow,
    fitOverflow,
    hScroll: html.scrollWidth > W + 1 || document.body.scrollWidth > W + 1,
    stageScroll: stage !== null && stage.scrollHeight > stage.clientHeight + 1,
    clippedFocus,
    nodes: root.querySelectorAll('*').length,
  };
}
