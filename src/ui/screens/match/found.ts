/**
 * PARTIDO ENCONTRADO (plan §1.4, PR 7): an opaque band across the middle of the screen, over the
 * menus, over Settings' search pill and over a free practice alike (z 45, --z-cards), as a search
 * finds a match: "PARTIDO ENCONTRADO", the queue it came from ("Casual · 2v2 · Sudamérica"), a
 * short cue (the Game plays it) and the browser tab's title, then the match takes the screen.
 * The roster is not known yet (it comes with the match's Welcome, after the band), so it is left
 * out. It never takes the focus or the input: the match comes by itself.
 *
 * One entry point: Game.matchFound() (PR 6's free practice hands off to a found match through it).
 */
import { h } from '../../dom';
import { t } from '../../../i18n';
import { icon } from '../../components/icons';

/** How long the band stays (plan §1.7: 1.5 to 2.5 s), and its entry. */
export const FOUND_MS = 1800;

export class MatchFound {
  readonly el: HTMLElement;
  private readonly line: HTMLElement;
  private timer = 0;
  /** The page's own title while the band's is up (restored once the tab is seen again). */
  private title: string | null = null;
  private readonly onVisible = (): void => {
    if (!document.hidden && this.timer === 0) this.restoreTitle();
  };

  constructor(container: HTMLElement) {
    this.line = h('span.mn-found-line');
    this.el = h('div.mn-found', { role: 'status', hidden: true }, h('div.mn-found-band', null, icon('check', 'mn-found-icon'), h('div.mn-found-text', null, h('strong.mn-found-title', null, t('found.title')), this.line)));
    container.appendChild(this.el);
    document.addEventListener('visibilitychange', this.onVisible);
  }

  /** Show the band for FOUND_MS with `line` (the queue: "Casual · 2v2 · Sudamérica"). */
  show(line: string): void {
    this.line.textContent = line;
    this.el.hidden = false;
    this.el.classList.remove('mn-found-in');
    void this.el.offsetWidth;
    this.el.classList.add('mn-found-in');
    if (this.title === null) this.title = document.title;
    document.title = t('found.tab');
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.hide(), FOUND_MS);
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  hide(): void {
    window.clearTimeout(this.timer);
    this.timer = 0;
    this.el.hidden = true;
    // A tab in the background keeps the news in its title until the player looks.
    if (!document.hidden) this.restoreTitle();
  }

  private restoreTitle(): void {
    if (this.title === null) return;
    document.title = this.title;
    this.title = null;
  }
}
