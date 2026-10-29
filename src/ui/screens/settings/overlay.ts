/**
 * Ajustes over the pause (dir-hub §6.11; the pause's CONFIGURACIÓN, pad X there, RULES in
 * experimental free play): the same SettingsView at z 60, on a `.mn` root so the shell's tokens,
 * rows, pressed states and focus ring apply. A bar with ‹ and AJUSTES (online the live scorebug is
 * raised into its right end: html.tg-set-live, styles/screens/settings.css), then the rail and the
 * page. Its own FocusNav (the bar, the rail as a side zone, the page), the keys while it is up (the
 * arrows, Esc / Backspace Back, Q / E the tabs, Delete clears), the controller's edges from the
 * Game (action). Back: a field being edited stops, then the view's own steps (a capture, the page
 * to its tab), then it closes back to the pause dock. Online the match goes on under it.
 */
import { h, navButton } from '../../dom';
import { FocusNav, isEditable, isEditing, setEditing, type NavDir } from '../../nav';
import { t } from '../../../i18n';
import { icon } from '../../components/icons';
import type { SettingsTab } from './model';
import { SettingsView, type SettingsOptions } from './view';

export type OverlayAction = NavDir | 'accept' | 'back' | 'prev' | 'next' | 'tabPrev' | 'tabNext' | 'context';

const touchMode = (): boolean => document.documentElement.classList.contains('tg-touch');

export class SettingsOverlay {
  readonly root: HTMLElement;
  private readonly view: SettingsView;
  private readonly nav: FocusNav;
  private readonly bar: HTMLElement;
  private onClose: (() => void) | null = null;

  constructor(container: HTMLElement, options: () => SettingsOptions) {
    this.view = new SettingsView(options, {
      place: 'pause',
      focus: (el) => this.nav.focus(el),
      refocus: () => this.refocus(),
    });
    const back = navButton('mn-set-back', [icon('back')], () => this.back(), { 'aria-label': t('nav.back'), 'data-key': 'set-back' });
    this.bar = h('header.mn-top.mn-set-bar', null, back, h('span.mn-set-bar-title', null, t('nav.settings').toLocaleUpperCase()));
    this.root = h('div.mn.mn-set-over', { hidden: true }, this.bar, h('main.mn-stage', null, this.view.el));
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    container.appendChild(this.root);
    this.nav = new FocusNav(
      () => [
        { name: 'bar', el: this.bar },
        { name: 'rail', el: this.view.rail, side: true },
        { name: 'page', el: this.view.page, main: true },
      ],
      { restore: () => this.refocus() },
    );
    this.nav.install(this.root);
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  get isOpen(): boolean {
    return this.view.isOpen;
  }

  get capturing(): boolean {
    return this.view.capturing;
  }

  /** Over the pause, on `tab` (CONTROLES without); `live`: an online match (its scorebug stays up); `onClose` when Back leaves it. */
  open(tab: SettingsTab | null, live: boolean, onClose: () => void): void {
    this.onClose = onClose;
    this.root.hidden = false;
    document.documentElement.classList.toggle('tg-set-live', live);
    this.view.open(tab);
    this.nav.reset();
    this.refocus();
  }

  /** Gone without its Back (the game resumed, the menus took over): nothing is called. */
  close(): void {
    this.onClose = null;
    this.hide();
  }

  refresh(): void {
    this.view.refresh();
  }

  /** Back: a field being edited stops, then the view's own steps, then the pause dock again. */
  back(): void {
    const a = document.activeElement;
    if (a instanceof HTMLElement && this.root.contains(a) && isEditing(a)) {
      setEditing(a, false);
      if (touchMode()) a.blur();
      return;
    }
    if (this.view.back()) return;
    const done = this.onClose;
    this.onClose = null;
    this.hide();
    done?.();
  }

  /** The controller's edges (Game.processActions); `repeat`: a held direction's auto-repeat. */
  action(a: OverlayAction, repeat = false): void {
    if (!this.isOpen || this.view.capturing) return;
    if (a === 'accept') this.nav.accept();
    else if (a === 'back') this.back();
    else if (a === 'up' || a === 'down' || a === 'left' || a === 'right') this.nav.move(a, repeat);
    else this.view.command(a);
  }

  private hide(): void {
    this.view.close();
    this.root.hidden = true;
    document.documentElement.classList.remove('tg-set-live');
  }

  /** The page's first control when nothing of the overlay has the focus, as in the menus (no ring on a touch screen). */
  private refocus(): void {
    if (touchMode() || !this.isOpen) return;
    const a = document.activeElement;
    if (a instanceof HTMLElement && this.root.contains(a) && a.hasAttribute('data-nav') && a.getClientRects().length > 0) return;
    const own = this.view.firstControl();
    if (own !== null && !isEditable(own)) this.nav.focus(own);
    else this.nav.first(true);
    if (this.nav.current === null) this.nav.focus(this.view.activeTab);
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.isOpen || this.view.capturing || e.altKey || e.ctrlKey || e.metaKey) return;
    const a = document.activeElement;
    const field = isEditable(a);
    const editing = field && isEditing(a);
    let dir: NavDir | null = null;
    switch (e.code) {
      case 'ArrowUp':
        dir = 'up';
        break;
      case 'ArrowDown':
        dir = 'down';
        break;
      case 'ArrowLeft':
        if (!editing) dir = 'left';
        break;
      case 'ArrowRight':
        if (!editing) dir = 'right';
        break;
      case 'Enter':
      case 'NumpadEnter':
        if (field && a instanceof HTMLElement) {
          e.preventDefault();
          setEditing(a, !editing);
        }
        return;
      case 'Escape':
        e.preventDefault();
        if (!e.repeat) this.back();
        return;
      case 'Backspace':
        if (field) return;
        e.preventDefault();
        if (!e.repeat) this.back();
        return;
      case 'KeyQ':
      case 'KeyE':
        if (field || e.repeat) return;
        e.preventDefault();
        this.view.command(e.code === 'KeyQ' ? 'tabPrev' : 'tabNext');
        return;
      case 'Delete':
        if (field || e.repeat) return;
        e.preventDefault();
        this.view.command('context');
        return;
      default:
        if (field && !editing && e.key.length === 1 && a instanceof HTMLElement) setEditing(a, true);
        return;
    }
    if (dir === null) return;
    e.preventDefault();
    this.nav.move(dir, e.repeat);
  }
}
