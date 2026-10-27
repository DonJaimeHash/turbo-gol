/**
 * The Tablero's tiles (plan §1.3 `mn-tile`; styles/tiles.css): the hero (XL: JUGAR AHORA, and the
 * states that take its place: screens/home.ts), a mode tile (M) and the slot (`mn-slot`, the
 * slanted tag in a tile's top row).
 *
 * Text that may not fit says how it gives way (fit.ts): a title shrinks to its class's minimum,
 * then takes its two-line form; a long subtitle takes the short one; a top row (icon and slot)
 * drops the slot's text, never its size (a text-only slot then goes). The fit caches a full text
 * (data-fit-full), so a new text is a new span, never an edit of the old one: the hero rebuilds its
 * parts on a state change and keeps only its button (the focus stays on it when a search starts or
 * ends). `aria-hidden` is the string 'true' (dom.ts writes `true` as an empty value). Built on
 * call, nothing at import.
 */
import { h, setChildren } from '../dom';
import { icon } from './icons';
import type { IconName } from './icons';
import { twoLines } from '../screens/homeModel';
import type { HeroKind } from '../screens/homeModel';
import { t } from '../../i18n';

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface SlotOptions {
  /** An icon before the text (a lock, a controller). */
  icon?: IconName;
  /** Lime on ink: the hero's. */
  ink?: boolean;
  /** Sentence case in the body face (the display face has no lower case): "Iniciar sesión". */
  body?: boolean;
  /** A crowded top row takes the text away (fit.ts data-fit-alt ""); an icon stays. */
  drop?: boolean;
  /** Its short form, which a crowded top row takes first ("Entrar" for "Iniciar sesión"), then (`drop`) none. */
  short?: string;
}

/** A slot: its text, after an icon when it has one (an icon alone: an empty text). */
export function slot(text: string, opts: SlotOptions = {}): HTMLElement {
  const cls = `span.mn-slot${opts.ink === true ? '.mn-slot-ink' : ''}${opts.body === true ? '.mn-slot-body' : ''}`;
  // A short form first (data-fit-alt), then the text goes (data-fit-give); without one, it goes at once.
  const alt = opts.short !== undefined ? { 'data-fit-alt': opts.short, 'data-fit-give': opts.drop === true ? '1' : undefined } : opts.drop === true ? { 'data-fit-alt': '' } : null;
  if (opts.icon === undefined) return h(cls as 'span', alt, text);
  return h(cls as 'span', null, icon(opts.icon), text !== '' ? h('span', alt, text) : null);
}

/** A title that shrinks to its class's minimum, then takes two lines (fit.ts; white-space: pre). */
function fitTitle(cls: string, text: string, min: number): HTMLElement {
  return h(`span.${cls}` as 'span', { 'data-fit': String(min), 'data-fit-alt': twoLines(text), 'data-fit-lines': '2' }, text);
}

/** The owner's speed lines (ink at 5 to 8 %), stretched over the hero: x on its 550 x 312 artboard. */
const LINES: ReadonlyArray<readonly [string, number]> = [
  ['402,0 412,0 298,312 288,312', 0.07],
  ['436,0 474,0 360,312 322,312', 0.06],
  ['492,0 500,0 386,312 378,312', 0.08],
  ['524,0 590,0 476,312 410,312', 0.05],
  ['604,0 618,0 504,312 490,312', 0.07],
];

function speedLines(): HTMLElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 550 312');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('fill', 'currentColor');
  for (const [points, opacity] of LINES) {
    const p = document.createElementNS(SVG_NS, 'polygon');
    p.setAttribute('points', points);
    p.setAttribute('fill-opacity', String(opacity));
    svg.appendChild(p);
  }
  return h('span.mn-hero-lines', { 'aria-hidden': 'true' }, svg);
}

/**
 * The hero's subtitle: one text, or a queue and its region (the dot between them: ' · ', a TV's
 * ' - '; a two-part text such as "Partido de 3 min · sin conexión" takes the same form). A phone and
 * a tablet set the region on its own line; a TV keeps one line and lets it step aside.
 */
export type HeroSub = string | { queue: string; dot: string; region: string | null };

/** What the hero shows (screens/home.ts heroView). */
export interface HeroView {
  kind: HeroKind;
  icon: IconName;
  /** Its slot (top right, lime on ink), null for none; `icon`: a TV's controller message, which never drops its text. */
  slot: { text: string; icon?: IconName } | null;
  title: string;
  /** Searching: the clock under the title. */
  clock: string | null;
  sub: HeroSub;
  /** A TV without a controller: the slot is the message (aria-describedby). */
  needPad: boolean;
  /** The button's name: the title and the subtitle (never the clock). */
  label: string;
}

export interface HeroTile {
  readonly el: HTMLElement;
  /** The main button: the same element in every state. */
  readonly main: HTMLButtonElement;
  set(v: HeroView): void;
  setClock(text: string): void;
}

/**
 * The hero: `div.mn-hero` (a nav row) holding the main button and, while searching, ✕ CANCEL in
 * the same grid cell (no absolute position: the focus ring's position: relative would undo it).
 * `lines`: the speed lines (none on super low: flat lime). `oneLine`: a TV's subtitle on one line,
 * which shrinks to the class's minimum, then lets its region go (fit.ts; the region pill is by the
 * plate there). `press` / `cancel`: the two buttons. The main button is as tall as both rows of
 * tiles beside it (but upright): ▲ ▼ leave it for what lies wholly above or below, else the next
 * zone (nav.ts data-nav-span: the hint bar's links under it, the top bar over a phone's).
 */
export function heroTile(o: { lines: boolean; oneLine: boolean; press: () => void; cancel: () => void }): HeroTile {
  const main = h('button.mn-hero-main', { type: 'button', 'data-nav': true, 'data-nav-span': true, 'data-key': 'hero', 'data-autofocus': true, 'data-fit-box': true, onclick: () => o.press() });
  const lines = o.lines ? speedLines() : null;
  const x = h('button.mn-hero-x', { type: 'button', 'data-nav': true, 'data-key': 'hero-x', 'aria-label': t('nav.cancelSearch'), onclick: () => o.cancel() }, icon('close'), t('lang.cancel'));
  const el = h('div.mn-hero', { 'data-nav-row': true }, main);
  let clock: HTMLElement | null = null;
  const set = (v: HeroView): void => {
    const busy = v.kind === 'search';
    el.className = `mn-hero mn-hero-${v.kind}${busy ? ' mn-hero-busy' : ''}${v.needPad ? ' mn-hero-needpad' : ''}`;
    const tag = v.slot === null ? null : slot(v.slot.text, { icon: v.slot.icon, ink: true, drop: v.slot.icon === undefined });
    if (tag !== null) tag.id = 'mn-hero-slot';
    clock = v.clock !== null ? h('span.mn-hero-clock', null, v.clock) : null;
    // Beside ✕ (searching), a face wider than Arial may take it under the floor, as the controller
    // message's (a data-fit shrink).
    const fit = o.oneLine ? { 'data-fit': busy ? '14' : '16' } : null;
    const gone = o.oneLine ? { 'data-fit-alt': '' } : null;
    const sub =
      typeof v.sub === 'string'
        ? h('span.mn-hero-sub', fit, v.sub)
        : h('span.mn-hero-sub', fit, h('span.mn-hero-queue', null, v.sub.queue), v.sub.region !== null ? h('span.mn-hero-dot', gone, v.sub.dot) : null, v.sub.region !== null ? h('span.mn-hero-region', gone, v.sub.region) : null);
    setChildren(
      main,
      lines,
      // The slot never shrinks: past its row it drops its text (data-fit-alt), but a TV's
      // controller message, which shrinks instead (home.css --fit-min there).
      h('span.mn-tile-top', { 'data-fit': '12' }, icon(v.icon, 'mn-hero-icon'), tag),
      h('span.mn-hero-bottom', null, fitTitle('mn-hero-title', v.title, 40), clock, h('span.mn-hero-row', null, sub, h('span.mn-hero-go', { 'aria-hidden': 'true' }, icon('arrow'), h('b.mn-hero-ok', null, 'OK')))),
      busy ? h('span.mn-hero-track', null, h('span.mn-busy')) : null,
    );
    main.setAttribute('aria-label', v.label);
    if (v.needPad && tag !== null) main.setAttribute('aria-describedby', 'mn-hero-slot');
    else main.removeAttribute('aria-describedby');
    if (busy && x.parentElement !== el) el.appendChild(x);
    else if (!busy && x.parentElement === el) {
      // ✕ goes with the search: its focus comes back to the hero, not to the page's body (touch
      // mode focuses nothing).
      if (document.activeElement === x) {
        if (document.documentElement.classList.contains('tg-touch')) x.blur();
        else main.focus({ preventScroll: true });
      }
      x.remove();
    }
  };
  const setClock = (text: string): void => {
    if (clock !== null && clock.textContent !== text) clock.textContent = text;
  };
  return { el, main, set, setClock };
}

export interface ModeTileSpec {
  /** `mn-mtile-<casual|friends|ai|ranked>`: its grid area. */
  cls: string;
  /** Its `data-key` (focus memory). */
  key: string;
  icon: IconName;
  slot: HTMLElement | null;
  title: string;
  /** The long subtitle (PC, short) and the short one (phone, tablet, TV). */
  sub: string;
  short: string;
  open: () => void;
}

/** A mode tile: icon and slot on top, the title and its subtitles, the arrow circle (a PC's, on focus or hover). */
export function modeTile(s: ModeTileSpec): { el: HTMLButtonElement; setSlot(node: HTMLElement | null): void } {
  const top = h('span.mn-tile-top', { 'data-fit': '12' }, icon(s.icon, 'mn-mtile-icon'), s.slot);
  const el = h(
    `button.mn-mtile.${s.cls}` as 'button',
    { type: 'button', 'data-nav': true, 'data-key': s.key, 'data-fit-box': true, onclick: () => s.open() },
    top,
    h(
      'span.mn-mtile-text',
      null,
      fitTitle('mn-mtile-title', s.title, 20),
      h('span.mn-mtile-sub', { 'data-fit': '14', 'data-fit-alt': s.short }, s.sub),
      h('span.mn-mtile-short', null, s.short),
    ),
    h('span.mn-mtile-go', { 'aria-hidden': 'true' }, icon('arrow')),
  );
  const setSlot = (node: HTMLElement | null): void => {
    const old = top.querySelector('.mn-slot');
    if (old !== null) old.remove();
    if (node !== null) top.appendChild(node);
  };
  return { el, setSlot };
}
