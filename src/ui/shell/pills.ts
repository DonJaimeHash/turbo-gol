/**
 * The top bar's pills (`mn-pill`, plan §1.3), focusable in zone 1:
 * - region: the region and the connection ("● Online", "● 12 playing" from PLAYING_SHOWN up: a
 *   small count reads as an empty game), "Connecting…", or "Offline · RETRY"; it opens the region
 *   sheet, or retries when offline;
 * - search: spinner · "CASUAL · 2v2 · 0:42" (the search's own screen), and ✕ (cancel; pad Y,
 *   keyboard X anywhere in the menus); a copy without focus floats over Settings (Menu.float);
 * - update: "UPDATE TO PLAY" (--warn) once the server refused this page's version (the sheet again).
 * Each writes the page only when its text changed (Menu.tick runs at 4 Hz). In a crowded bar (a
 * TV's hint bar or Inicio's plate row, the top bar of a tablet or a phone) their words give way
 * (`data-fit-give`, fit.ts) in two steps: first what is said beside them too (2: the region's
 * status, which its dot says; the search's queue, which Inicio's hero and the search's screen
 * say), then the rest (3: the region's name, offline and RETRY, the update's words), down to their
 * icons and dot, the search's spinner, clock and ✕. Built on call.
 */
import { h, clock } from '../dom';
import { t } from '../../i18n';
import { icon } from '../components/icons';
import type { SearchView } from '../Menu';

/** The words of a pill, which a crowded bar may take away (fit.ts): those said beside it too first. */
const ECHO = { 'data-fit-give': '2' };
const WORDS = { 'data-fit-give': '3' };

/** Below this many players in a match the pill says "Online" instead of a count. */
export const PLAYING_SHOWN = 5;

export type RegionPillState = { kind: 'connecting' } | { kind: 'offline' } | { kind: 'online'; region: string; playing: number | null };

export class RegionPill {
  readonly el: HTMLButtonElement;
  private key = '';

  constructor(onClick: () => void) {
    this.el = h('button.mn-pill.mn-pill-region.mn-hit', { type: 'button', 'data-nav': true, 'data-key': 'region', onclick: onClick });
  }

  /** Show `s`; false (and nothing written) when the pill already shows it. */
  set(s: RegionPillState): boolean {
    const key = JSON.stringify(s);
    if (key === this.key) return false;
    this.key = key;
    this.el.textContent = '';
    this.el.classList.toggle('mn-pill-off', s.kind === 'offline');
    if (s.kind === 'connecting') {
      this.el.append(h('span.mn-spinner'), h('span.mn-pill-sub', WORDS, t('pill.connecting')));
      this.el.setAttribute('aria-label', t('pill.connecting'));
      return true;
    }
    if (s.kind === 'offline') {
      this.el.append(icon('offline'), h('span.mn-pill-sub', WORDS, t('pill.offline')), h('span.mn-pill-sep', WORDS), h('b.mn-pill-act', WORDS, t('pill.retry')));
      this.el.setAttribute('aria-label', t('pill.offline') + '. ' + t('pill.retry'));
      return true;
    }
    const status = s.playing !== null && s.playing >= PLAYING_SHOWN ? t('menu.playing', { count: s.playing }) : t('pill.online');
    this.el.append(icon('globe'), h('span.mn-pill-main', WORDS, s.region), h('span.mn-pill-sep', ECHO), h('span.mn-dot.on'), h('span.mn-pill-sub', ECHO, status));
    this.el.setAttribute('aria-label', t('pill.regionLabel', { region: s.region, state: status }));
    return true;
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
    this.label = h('span.mn-pill-main', ECHO);
    this.time = h('span.mn-pill-time');
    this.el = h(
      'div.mn-pill.mn-pill-search',
      { hidden: true },
      h('button.mn-pill-open.mn-hit', { type: 'button', 'data-key': 'search', onclick: onOpen, ...nav }, h('span.mn-spinner'), this.label, this.time),
      h('button.mn-pill-x.mn-hit', { type: 'button', 'data-key': 'search-x', title: t('nav.cancelSearch'), 'aria-label': t('nav.cancelSearch'), onclick: onCancel, ...nav }, icon('close')),
    );
  }

  set(v: SearchView, now: number): void {
    if (this.el.hidden === v.active) this.el.hidden = !v.active;
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
  return h('button.mn-pill.mn-pill-update.mn-hit', { type: 'button', 'data-nav': true, 'data-key': 'update', hidden: true, onclick: onClick }, icon('refresh'), h('span.mn-pill-main', WORDS, t('update.pill')));
}

/** What the lobby pill shows: the lobby's code, its players and places (null before its first state), the socket away. */
export interface LobbyPillState {
  code: string;
  count: number | null;
  max: number | null;
  reconnecting: boolean;
}

/**
 * The lobby pill (plan §6.4, PR 12): "LOBBY ABC234 · 2/4 · BACK" while the player is in a lobby
 * and not on its screen (the Sala kept with MANTENER LA SALA, a section switched to); it opens the
 * lobby. A spinner instead of the icon while the lobby socket reconnects.
 */
export class LobbyPill {
  readonly el: HTMLButtonElement;
  private key = '';

  constructor(onClick: () => void) {
    this.el = h('button.mn-pill.mn-pill-lobby.mn-hit', { type: 'button', 'data-nav': true, 'data-key': 'lobby-pill', hidden: true, onclick: onClick });
  }

  /** Show `s` (null: hidden); false (and nothing written) when the pill already shows it. */
  set(s: LobbyPillState | null): boolean {
    const key = s === null ? '' : JSON.stringify(s);
    if (key === this.key) return false;
    this.key = key;
    this.el.hidden = s === null;
    this.el.textContent = '';
    if (s === null) return true;
    // In a crowded bar the count goes first, then the words, down to the icon (Inicio's hero, the
    // Sala and the label say them).
    const main = t('lobby.pill', { code: s.code });
    const count = ` · ${s.count ?? '—'}/${s.max ?? '—'}`;
    this.el.append(s.reconnecting ? h('span.mn-spinner') : icon('friends'), h('span.mn-pill-main', WORDS, main), h('span.mn-pill-sub', ECHO, count), h('span.mn-pill-sep', WORDS), h('b.mn-pill-act', WORDS, t('lobby.pillBack')));
    this.el.setAttribute('aria-label', `${main}${count}. ${t('lobby.pillBack')}`);
    return true;
  }
}
