/**
 * The sections where a phone has them (plan §1.3):
 * - `mn-rail` (a phone held sideways): 123 px plus the left safe area, 24 px clear of Android's back
 *   gesture, the five sections as 56 px items (icon + label; the active one on --surface-3 with a
 *   lime bar slanted at its inner edge, `mn-sl-mark`), and at its foot the source link
 *   (AGPL-3.0, always on screen) with the About sheet beside it. On a stacked screen a ‹ item comes
 *   first and the items come down to 48 px (7 x 48 + 16 fits 360).
 * - `mn-tabbar` (an upright phone or tablet): 64 px plus the bottom safe area, the five sections
 *   with their short names, the active one with a lime bar on top.
 * Focus = selection, as the top bar's tabs. A tap on the section already shown goes to its root.
 * Built on call, nothing at import.
 */
import { h } from '../dom';
import { t } from '../../i18n';
import { icon } from '../components/icons';
import { SECTIONS } from './sections';
import type { SectionId } from './sections';
import { LICENSE_NAME, SOURCE_URL } from '../../brand';

export interface SectionListHandlers {
  focus(id: SectionId): void;
  click(id: SectionId): void;
  back(): void;
  about(): void;
}

export class SectionList {
  readonly el: HTMLElement;
  private readonly items = new Map<SectionId, HTMLButtonElement>();

  constructor(kind: 'rail' | 'tabbar', hd: SectionListHandlers) {
    const rail = kind === 'rail';
    const list = h('div.mn-sl-items', { role: 'tablist', 'aria-label': t('nav.sections'), 'aria-orientation': rail ? 'vertical' : 'horizontal' });
    for (const s of SECTIONS) {
      const b = h(
        'button.mn-sl-item',
        { type: 'button', role: 'tab', 'aria-selected': 'false', 'data-nav': true, 'data-key': `${kind}-${s.id}`, onclick: () => hd.click(s.id) },
        icon(s.icon),
        h('span.mn-sl-label', { 'data-fit': '12', 'data-fit-alt': rail && s.short !== s.label ? t(s.short) : undefined }, t(rail ? s.label : s.short)),
        h('span.mn-sl-mark', { 'aria-hidden': 'true' }),
      );
      b.addEventListener('focusin', () => hd.focus(s.id));
      this.items.set(s.id, b);
      list.appendChild(b);
    }
    if (rail) {
      const back = h('button.mn-sl-item.mn-sl-back', { type: 'button', 'data-nav': true, 'data-key': 'rail-back', title: t('menu.back'), 'aria-label': t('menu.back'), onclick: () => hd.back() }, icon('back'));
      const foot = h(
        'div.mn-sl-foot',
        { 'data-fit': '10', 'data-nav-row': true },
        h('a.mn-sl-agpl', { href: SOURCE_URL, target: '_blank', rel: 'noopener', title: t('menu.sourceTitle', { license: LICENSE_NAME }), 'data-nav': true, 'data-key': 'rail-source' }, icon('code'), h('span', null, 'AGPL')),
        h('button.mn-sl-about', { type: 'button', 'data-nav': true, 'data-key': 'rail-about', title: t('nav.about'), 'aria-label': t('nav.about'), onclick: () => hd.about() }, icon('info')),
      );
      this.el = h('nav.mn-rail', { 'aria-label': t('nav.sections') }, back, list, foot);
    } else {
      this.el = h('nav.mn-tabbar', { 'aria-label': t('nav.sections') }, list);
    }
  }

  setSection(id: SectionId): void {
    for (const [sid, b] of this.items) {
      const on = sid === id;
      b.classList.toggle('mn-sl-on', on);
      b.setAttribute('aria-selected', String(on));
      b.toggleAttribute('data-nav-entry', on);
    }
  }

  setStacked(on: boolean): void {
    this.el.classList.toggle('mn-sl-stacked', on);
  }
}
