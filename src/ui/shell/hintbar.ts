/**
 * The hint bar (`mn-hintbar`, plan §1.3 and §1.6), the footer zone: the verbs of the last input on
 * the left (hints.ts: glyph + verb pairs, none for a mouse or a finger), and on the right the
 * source link (AGPL-3.0, section 13: a network game offers its source to its players; it never
 * goes, though it may take its short form, "Source (AGPL-3.0)") and About (a sheet with the build
 * line, the third-party licenses and Discord). A TV keeps its pills here (Menu.placePills: its top
 * bar has no room at 3 m). On an upright phone it is the
 * 32 px link line above the tabs; a phone held sideways has the rail's foot instead.
 * Built on call, nothing at import.
 */
import { h } from '../dom';
import { t } from '../../i18n';
import { glyph } from '../components/glyphs';
import type { HintItem } from './hints';
import { LICENSE_NAME, SOURCE_URL } from '../../brand';

export class HintBar {
  readonly el: HTMLElement;
  /** Between the hints and the links: the pills on a TV. */
  readonly mid: HTMLElement;
  private readonly hints: HTMLElement;
  private key = '';

  constructor(about: () => void) {
    this.hints = h('div.mn-hints');
    this.mid = h('div.mn-hint-mid');
    // data-fit (fit.ts): crowded (a TV's pills with the wide fallback text), the bar's text comes
    // down to 14 px (16 on a TV) as one, then the source link takes its short form; never gone.
    this.el = h(
      'footer.mn-hint',
      { 'data-fit': '14' },
      this.hints,
      this.mid,
      h(
        'div.mn-links',
        null,
        h(
          'a.mn-link',
          { href: SOURCE_URL, target: '_blank', rel: 'noopener', title: t('menu.sourceTitle', { license: LICENSE_NAME }), 'data-nav': true, 'data-key': 'source' },
          h('span', { 'data-fit-alt': t('menu.sourceShort', { license: LICENSE_NAME }) }, t('menu.sourceTitle', { license: LICENSE_NAME })),
        ),
        h('span.mn-link-sep', { 'aria-hidden': 'true' }, '·'),
        h('button.mn-link.mn-link-about', { type: 'button', 'data-nav': true, 'data-key': 'about', onclick: about }, t('nav.about')),
      ),
    );
  }

  /** The hints; nothing is written when they did not change. */
  render(items: readonly HintItem[]): void {
    const key = items.map((i) => i.glyphs.join('+') + ':' + i.verb).join('|');
    if (key === this.key) return;
    this.key = key;
    this.hints.textContent = '';
    for (const it of items) this.hints.appendChild(h('span.mn-hint-item', null, ...it.glyphs.map(glyph), h('span.mn-hint-verb', null, t(it.verb))));
  }
}
