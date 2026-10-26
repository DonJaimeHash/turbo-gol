/**
 * The top bar's pills (`mn-pill`, plan §1.3), focusable in zone 1:
 * - region: the region and the connection ("● Online", "● 12 playing" from PLAYING_SHOWN up: a
 *   small count reads as an empty game), "Connecting…", or "Offline · RETRY"; it opens the region
 *   sheet, or retries when offline;
 * - search: spinner · "CASUAL · 2v2 · 0:42" (the search's own screen), and ✕ (cancel; pad Y,
 *   keyboard X anywhere in the menus); a copy without focus floats over Settings (Menu.float);
 * - update: "UPDATE TO PLAY" (--warn) once the server refused this page's version (the sheet again).
 * Each writes the page only when its text changed (Menu.tick runs at 4 Hz). Built on call.
 */
import { h, clock } from '../dom';
import { t } from '../../i18n';
import { icon } from '../components/icons';
import type { SearchView } from '../Menu';

/** Below this many players in a match the pill says "Online" instead of a count. */
export const PLAYING_SHOWN = 5;

export type RegionPillState = { kind: 'connecting' } | { kind: 'offline' } | { kind: 'online'; region: string; playing: number | null };

export class RegionPill {
  readonly el: HTMLButtonElement;
  private key = '';

  constructor(onClick: () => void) {
    this.el = h('button.mn-pill.mn-pill-region', { type: 'button', 'data-nav': true, 'data-key': 'region', onclick: onClick });
  }

  set(s: RegionPillState): void {
    const key = JSON.stringify(s);
    if (key === this.key) return;
    this.key = key;
    this.el.textContent = '';
    this.el.classList.toggle('mn-pill-off', s.kind === 'offline');
    if (s.kind === 'connecting') {
      this.el.append(h('span.mn-spinner'), h('span.mn-pill-sub', null, t('pill.connecting')));
      this.el.setAttribute('aria-label', t('pill.connecting'));
      return;
    }
    if (s.kind === 'offline') {
      this.el.append(icon('offline'), h('span.mn-pill-sub', null, t('pill.offline')), h('span.mn-pill-sep'), h('b.mn-pill-act', null, t('pill.retry')));
      this.el.setAttribute('aria-label', t('pill.offline') + '. ' + t('pill.retry'));
      return;
    }
    const status = s.playing !== null && s.playing >= PLAYING_SHOWN ? t('menu.playing', { count: s.playing }) : t('pill.online');
    this.el.append(icon('globe'), h('span.mn-pill-main', null, s.region), h('span.mn-pill-sep'), h('span.mn-dot.on'), h('span.mn-pill-sub', null, status));
    this.el.setAttribute('aria-label', t('pill.regionLabel', { region: s.region, status }));
  }
}

export class SearchPill {
  readonly el: HTMLElement;
  private readonly label: HTMLElement;
  private readonly time: HTMLElement;
  private key = '';

  /** `focusable`: the top bar's (a target of zone 1); the copy over Settings is pointer-only. */
  constructor(onOpen: () => void, onCancel: () => void, focusable: boolean) {
    const nav = focusable ? { 'data-nav': true } : { tabindex: '-1' };
    this.label = h('span.mn-pill-main');
    this.time = h('span.mn-pill-time');
    this.el = h(
      'div.mn-pill.mn-pill-search',
      { hidden: true },
      h('button.mn-pill-open', { type: 'button', 'data-key': 'search', onclick: onOpen, ...nav }, h('span.mn-spinner'), this.label, this.time),
      h('button.mn-pill-x', { type: 'button', 'data-key': 'search-x', title: t('nav.cancelSearch'), 'aria-label': t('nav.cancelSearch'), onclick: onCancel, ...nav }, icon('close')),
    );
  }

  set(v: SearchView, now: number): void {
    this.el.hidden = !v.active;
    if (!v.active) {
      this.key = '';
      return;
    }
    const key = (v.kind ?? '') + v.modes.join();
    if (key !== this.key) {
      this.key = key;
      this.label.textContent = (v.kind === 'ranked' ? t('menu.searchRanked') : t('menu.searchCasual')) + (v.modes.length > 0 ? ' · ' + v.modes.join(' · ') : '');
    }
    const c = clock(now - v.since);
    if (this.time.textContent !== c) this.time.textContent = c;
  }
}

export function updatePill(onClick: () => void): HTMLButtonElement {
  return h('button.mn-pill.mn-pill-update', { type: 'button', 'data-nav': true, 'data-key': 'update', hidden: true, onclick: onClick }, icon('refresh'), h('span.mn-pill-main', null, t('update.pill')));
}
