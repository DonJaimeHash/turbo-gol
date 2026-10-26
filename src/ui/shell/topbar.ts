/**
 * The top bar (`mn-topbar`, plan §1.3), focus zone 1. On a section root: the wordmark (to JUGAR),
 * the five sections (`role=tablist`, focus = selection: arrowing onto one opens it at once) with
 * the way to step them beside it in the last input's language (‹ › buttons for a mouse, L / R for
 * a controller, Q / E keys for a keyboard; a remote reads "▲ Sections" in the hint bar), then the
 * pills, the account chip and Settings. On a stacked screen: ‹ and the breadcrumbs, every crumb
 * but the last a button back to that screen. Which parts show for which layout (a phone's sections
 * are in the rail) is src/ui/styles/shell.css. Built on call, nothing at import.
 */
import { h } from '../dom';
import { t } from '../../i18n';
import { icon } from '../components/icons';
import { glyph } from '../components/glyphs';
import { SECTIONS } from './sections';
import type { SectionId } from './sections';

export interface TopBarHandlers {
  /** The wordmark: JUGAR's root. */
  brand(): void;
  back(): void;
  /** Crumb `i` (0: the section's root). */
  crumb(i: number): void;
  /** A section tab got the focus (arrows, a click, Tab): focus = selection. */
  sectionFocus(id: SectionId): void;
  /** A section tab was clicked or tapped. */
  sectionClick(id: SectionId): void;
  /** The ‹ › beside the tabs (mouse). */
  step(d: -1 | 1): void;
  chip(): void;
  settings(): void;
}

export class TopBar {
  readonly el: HTMLElement;
  /** Where the Menu puts the pills (search, update, region). */
  readonly pills: HTMLElement;
  readonly chip: HTMLButtonElement;
  private readonly tabs = new Map<SectionId, HTMLButtonElement>();
  private readonly crumbs: HTMLElement;
  private readonly hd: TopBarHandlers;

  constructor(hd: TopBarHandlers) {
    this.hd = hd;
    const side = (d: -1 | 1): HTMLElement =>
      h(
        'span.mn-sec-side',
        { 'aria-hidden': 'true' },
        h('button.mn-sec-arrow', { type: 'button', tabindex: '-1', title: t(d < 0 ? 'nav.prevSection' : 'nav.nextSection'), onclick: () => hd.step(d) }, icon(d < 0 ? 'back' : 'next')),
        h('span.mn-sec-pad', null, glyph(d < 0 ? 'pad-lb' : 'pad-rb')),
        h('span.mn-sec-key', null, glyph(d < 0 ? 'key-q' : 'key-e')),
      );
    // data-fit (fit.ts): the strip shrinks as one, to 14 px, then takes the short names (ENTRENAR, RANKING).
    const list = h('div.mn-secs', { role: 'tablist', 'aria-label': t('nav.sections'), 'data-nav-row': true, 'data-fit': '14' });
    for (const s of SECTIONS) {
      const label = h('span.mn-sec-label', { 'data-fit-alt': s.short !== s.label ? t(s.short) : undefined }, t(s.label));
      const b = h('button.mn-sec', { type: 'button', role: 'tab', 'aria-selected': 'false', 'data-nav': true, 'data-key': 'sec-' + s.id, onclick: () => hd.sectionClick(s.id) }, label, h('span.mn-sec-bar', { 'aria-hidden': 'true' }));
      b.addEventListener('focusin', () => hd.sectionFocus(s.id));
      this.tabs.set(s.id, b);
      list.appendChild(b);
    }
    this.crumbs = h('nav.mn-crumbs', { 'aria-label': t('menu.back'), 'data-fit': '14' });
    this.pills = h('div.mn-pills');
    this.chip = h('button.mn-chip', { type: 'button', 'data-nav': true, 'data-key': 'chip', onclick: () => hd.chip() });
    this.el = h(
      'header.mn-top',
      null,
      h('button.mn-back', { type: 'button', 'data-nav': true, 'data-nav-entry': true, 'data-key': 'back', title: t('menu.back'), 'aria-label': t('menu.back'), onclick: () => hd.back() }, icon('back')),
      this.crumbs,
      h('button.mn-brand', { type: 'button', tabindex: '-1', title: t('nav.play'), 'aria-label': 'Turbogol', onclick: () => hd.brand() }, h('span.mn-brand-a', null, 'TURBO'), h('span.mn-brand-b', null, 'GOL')),
      h('div.mn-secbar', null, side(-1), list, side(1)),
      h('div.mn-top-right', null, this.pills, this.chip, h('button.mn-gear', { type: 'button', 'data-nav': true, 'data-key': 'gear', title: t('nav.settings'), 'aria-label': t('nav.settings'), onclick: () => hd.settings() }, icon('settings'))),
    );
  }

  /** The section shown: its tab selected and the zone's entry (↑ from the stage lands on it). */
  setSection(id: SectionId): void {
    for (const [sid, b] of this.tabs) {
      const on = sid === id;
      b.classList.toggle('mn-sec-on', on);
      b.setAttribute('aria-selected', String(on));
      b.toggleAttribute('data-nav-entry', on);
    }
  }

  /** The breadcrumbs of a stacked screen: the section, then each screen; all but the last go back there. */
  setCrumbs(labels: readonly string[]): void {
    this.crumbs.textContent = '';
    labels.forEach((label, i) => {
      if (i > 0) this.crumbs.appendChild(h('span.mn-crumb-sep', { 'aria-hidden': 'true' }, '›'));
      const last = i === labels.length - 1;
      this.crumbs.appendChild(last ? h('span.mn-crumb', { 'aria-current': 'page' }, label) : h('button.mn-crumb', { type: 'button', 'data-nav': true, 'data-key': 'crumb-' + i, onclick: () => this.hd.crumb(i) }, label));
    });
  }

  setStacked(on: boolean): void {
    this.el.classList.toggle('mn-top-stacked', on);
  }
}
