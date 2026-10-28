/**
 * CLASIFICACIÓN (plan PR 13, dir-hub §6.7): the top 100 of the season per playlist (placed players
 * only), and the ranked result dialog shown after a rated match: win / loss, MMR before -> after,
 * the tier change, placement progress and an abandon ban when there was one. RankedResults waits
 * for that result and keeps what comes while the menus are away until they are back.
 *
 * The board: the tabs 1v1 · 2v2 · 3v3 in place (M tiles, your badge and rank on each when signed
 * in), your standing beside them (GO TO MY POSITION, a guest's SIGN IN to see it, or the placement
 * matches still to play: each one a button), then ONE scroller of 56 px rows (`data-nav`: #,
 * badge, name, the rank in words, rating, matches; yours in gold, pinned under the list when you
 * are outside the top). What the list cannot show (loading, an error with RETRY, nobody placed yet)
 * takes its place. A phone shows the rows as cards (leaderboard.css).
 *
 * Keys (leaderboardModel.ts): ▲ ▼ step the rows (held: the key's and the D-pad's repeat), ◀ ▶ on a
 * row or a tab step the playlist (not past 1v1 or 3v3: the phone's rail is that way), LT / RT (pad)
 * and PgUp / PgDn (keyboard) move a page, X (pad X, keyboard X while no search runs, Delete) goes to
 * your row; Q / E step the tabs (Menu.stepTabs). The playlist is remembered (prefs.ts).
 * In development (or a VITE_UI_FIT=1 build) window.__board(kind | null) shows sample rows
 * (scripts/ui-fit.mjs).
 */
import { h, setChildren, clock } from '../dom';
import type { AccountClient } from '../../net/AccountClient';
import { PLAYLISTS } from '../../net/account';
import type { LeaderboardAnswer, LeaderboardEntry, Playlist, RankedResultAnswer } from '../../net/account';
import { TIERS, tierProgress } from '../../net/rating';
import { t, type Key } from '../../i18n';
import { rankBadge, tierById } from '../badges';
import { playlistName, tierName } from '../names';
import type { Menu, MenuCommand, Screen } from '../Menu';
import { onNavSide } from '../nav';
import { icon } from '../components/icons';
import { glyph } from '../components/glyphs';
import { screenHead } from './common';
import { listNotice, pageStep, rowsPerPage, standing, stepPlaylist, youIndex } from './leaderboardModel';
import type { Standing } from './leaderboardModel';

const STAND_TEXT: Readonly<Record<Standing, Key>> = { guest: 'board.signIn', placement: 'board.playPlacement', you: 'board.goToMe' };

/** The last input (device.ts `data-input` on <html>): a controller's LT / RT page the list, the keyboard's Q / E step the tabs. */
function lastInput(): string {
  return document.documentElement.dataset.input ?? 'mouse';
}

export function leaderboardScreen(menu: Menu): Screen {
  const acc = menu.host.accounts;
  let board: LeaderboardAnswer | null = null;
  let loading = true;
  let failed = false;
  /** window.__board's sample (UI_FIT), null: the server's answer. */
  let sample: { board: LeaderboardAnswer; signedIn: boolean } | null = null;
  let seq = 0;
  /** After a playlist switch from the list: the row index to focus once the new one is in (-1: none). */
  let wantRow = -1;
  const touch = (): boolean => document.documentElement.classList.contains('tg-touch');
  const signedIn = (): boolean => sample?.signedIn ?? acc.signedIn;

  // ---- the tabs and your standing ----
  const tabEls = new Map<Playlist, { el: HTMLButtonElement; rank: HTMLElement }>();
  PLAYLISTS.forEach((p, i) => {
    const rank = h('span.mn-lb-tab-rank');
    const el = h(
      'button.mn-tab.mn-lb-tab',
      { type: 'button', role: 'tab', 'aria-selected': 'false', 'data-nav': true, 'data-key': 'board-' + p, onclick: () => pick(p) },
      h('b.mn-lb-tab-name', null, playlistName(p)),
      rank,
      h('span.mn-mtab-mark', { 'aria-hidden': 'true' }),
    );
    // ◀ ▶ on a tab: the tab beside it, picked, the focus with it (focus = selection); past either end the arrow goes on.
    const beside = (d: -1 | 1): (() => void) | null => {
      const q = PLAYLISTS[i + d];
      return q === undefined
        ? null
        : () => {
            pick(q);
            if (!touch()) tabEls.get(q)?.el.focus({ preventScroll: true });
          };
    };
    onNavSide(el, beside(-1), beside(1));
    tabEls.set(p, { el, rank });
  });
  const tabs = h('div.mn-tabs.mn-lb-tabs', { role: 'tablist', 'aria-label': t('board.title'), 'data-nav-row': true }, ...[...tabEls.values()].map((x) => x.el));
  const standLabel = h('span.mn-lb-stand-label');
  const standKeys = h('span.mn-act-keys.mn-lb-stand-keys', { 'aria-hidden': 'true' }, h('span.mn-keys-kb', null, glyph('key-x')), h('span.mn-keys-pad', null, glyph('pad-x')));
  const stand = h('button.mn-btn.mn-lb-stand', { type: 'button', 'data-nav': true, 'data-key': 'board-stand', onclick: () => onStand() }, icon('rank'), standLabel, standKeys);
  const top = h('div.mn-lb-top', null, tabs, stand);

  // ---- the one scroller ----
  const colHead = h(
    'div.mn-lb-row.mn-lb-cols',
    { 'aria-hidden': 'true' },
    h('span.mn-lb-pos', null, '#'),
    h('span.mn-lb-badge'),
    h('span.mn-lb-name', null, t('board.colPlayer')),
    h('span.mn-lb-tier', null, t('board.colTier')),
    h('span.mn-lb-mmr', null, t('board.colRating')),
    h('span.mn-lb-games', null, t('board.colGames')),
  );
  const list = h('div.mn-lb-list', { role: 'list' });
  const pinned = h('div.mn-lb-pinned', { hidden: true });
  const total = h('p.mn-lb-total');
  const el = h('section.mn-board', { 'data-tablero': true }, screenHead(t('board.title'), t('board.subtitle')), top, colHead, list, pinned, total);

  const current = (): Playlist => menu.prefs.leaderboardPlaylist;
  const rows = (): HTMLElement[] => [...el.querySelectorAll<HTMLElement>('.mn-lb-row[data-nav]')];

  /** One row: `you` in gold. ◀ ▶ step the playlist from it (not past either end). */
  const row = (e: LeaderboardEntry, key: string, you: boolean): HTMLElement => {
    const tier = tierById(e.tier);
    const words = tier ? tierName(tier) : t('board.unranked');
    const r = h(
      `div.mn-lb-row${you ? '.mn-lb-you' : ''}` as 'div',
      { role: 'listitem', tabindex: '-1', 'data-nav': true, 'data-key': key, 'aria-label': t('board.rowLabel', { rank: e.rank, name: e.name, tier: words, mmr: e.mmr, games: e.games }) },
      h('span.mn-lb-pos', null, `#${e.rank}`),
      h('span.mn-lb-badge', null, rankBadge(tier, 32)),
      h('span.mn-lb-name', null, e.name),
      h('span.mn-lb-tier', null, words),
      h('span.mn-lb-mmr', null, String(e.mmr)),
      h('span.mn-lb-games', null, String(e.games)),
    );
    // ◀ past 1v1 goes on (a phone's rail is that way); ▶ past 3v3 does nothing (no tab "beside" a row).
    const i = PLAYLISTS.indexOf(current());
    onNavSide(r, i > 0 ? () => step(-1) : null, () => step(1));
    return r;
  };

  /** Focus a row as the arrows do, in sight inside the one scroller (`center`: GO TO MY POSITION). */
  const focusRow = (r: HTMLElement | undefined, center = false): void => {
    if (r === undefined || touch()) {
      r?.scrollIntoView({ block: 'center' });
      return;
    }
    r.focus({ preventScroll: true });
    r.scrollIntoView({ block: center ? 'center' : 'nearest' });
  };

  const draw = (): void => {
    const p = current();
    for (const [id, x] of tabEls) {
      const on = id === p;
      x.el.classList.toggle('mn-tab-on', on);
      x.el.setAttribute('aria-selected', String(on));
      // Your rank in each playlist (an account's, from /api/me).
      const r = signedIn() ? (sample !== null ? null : acc.me?.ratings.find((x2) => x2.playlist === id)) : null;
      const tier = r ? tierById(r.tier) : null;
      const placed = r !== null && r !== undefined && r.placementLeft === 0;
      setChildren(x.rank, r ? rankBadge(placed ? tier : null, 24) : null, r ? h('span', null, placed && tier ? tierName(tier) : t('board.placementShort', { played: r.games, total: r.games + r.placementLeft })) : null);
    }
    const b = board;
    const notice = listNotice(loading, failed, b?.entries.length ?? 0);
    const you = b?.you ?? null;
    const yi = b !== null ? youIndex(b.entries, you) : -1;
    const had = el.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.key ?? null : null;
    if (notice === null && b !== null) setChildren(list, ...b.entries.map((e, i) => row(e, i === yi ? 'board-you' : 'row-' + i, i === yi)));
    else
      setChildren(
        list,
        notice === 'error'
          ? h('button.mn-btn.mn-lb-notice', { type: 'button', 'data-nav': true, 'data-key': 'board-retry', onclick: () => void load() }, icon('refresh'), h('span', null, t('board.failed')))
          : h('p.mn-lb-note', null, t(notice === 'loading' ? 'board.loading' : 'board.empty')),
      );
    // You, below the top: your row pinned under the list.
    const below = notice === null && you !== null && yi < 0;
    pinned.hidden = !below;
    setChildren(pinned, below && you !== null ? row(you, 'board-you', true) : null);
    total.textContent = b !== null && notice === null ? t('board.total', { count: b.total, season: b.season }) : '';
    // Your standing beside the tabs (nothing while loading or after an error).
    const s = standing(signedIn(), you !== null);
    stand.hidden = loading || failed;
    stand.dataset.kind = s;
    standLabel.textContent = t(STAND_TEXT[s]);
    standKeys.hidden = s !== 'you';
    // The focus: the row asked for (a playlist switch from the list), else back on what had it (the retry, a tab).
    if (wantRow >= 0 && notice === null) {
      const rs = [...list.children] as HTMLElement[];
      focusRow(rs[Math.min(wantRow, rs.length - 1)]);
      wantRow = -1;
    } else if (had !== null && !el.contains(document.activeElement)) menu.refocus();
  };

  const load = async (): Promise<void> => {
    const my = ++seq;
    if (sample !== null) {
      board = { ...sample.board, playlist: current() };
      loading = failed = false;
      draw();
      return;
    }
    loading = true;
    failed = false;
    draw();
    try {
      const b = await acc.leaderboard(current());
      if (my !== seq) return;
      board = b;
      loading = false;
    } catch {
      if (my !== seq) return;
      board = null;
      loading = false;
      failed = true;
    }
    if (el.isConnected) draw();
  };

  /** A playlist (a tab's press, ◀ ▶, Q / E through Menu.stepTabs). */
  const pick = (p: Playlist): void => {
    if (p === current()) return;
    menu.prefs.leaderboardPlaylist = p;
    menu.savePrefs();
    void load();
  };
  /** ◀ ▶ on a row: the playlist beside this one, the focus at that row's place in it. */
  const step = (d: -1 | 1): void => {
    const p = stepPlaylist(PLAYLISTS, current(), d);
    if (p === null) return;
    wantRow = Math.max(0, rows().indexOf(document.activeElement as HTMLElement));
    pick(p);
  };

  /** LT / RT, PgUp / PgDn: a page of rows (the focus on none yet: the first). */
  const page = (d: -1 | 1): void => {
    const rs = [...list.querySelectorAll<HTMLElement>('.mn-lb-row')];
    if (rs.length === 0) return;
    const n = rowsPerPage(list.clientHeight, rs[0].offsetHeight);
    focusRow(rs[pageStep(rs.indexOf(document.activeElement as HTMLElement), rs.length, n, d)]);
  };
  const goToMe = (): boolean => {
    const me = el.querySelector<HTMLElement>('.mn-lb-you');
    if (me === null) return false;
    focusRow(me, true);
    return true;
  };
  const onStand = (): void => {
    switch (stand.dataset.kind as Standing) {
      case 'guest':
        menu.open('profile');
        break;
      case 'placement':
        menu.open('modes', false, 'ranked');
        break;
      default:
        goToMe();
    }
  };

  el.addEventListener('keydown', (e) => {
    if ((e.code !== 'PageUp' && e.code !== 'PageDown') || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    page(e.code === 'PageUp' ? -1 : 1);
  });

  const command = (c: MenuCommand): boolean => {
    // A controller's triggers page the list; the keyboard's Q / E (the same commands) step the tabs (Menu.stepTabs).
    if ((c === 'tabPrev' || c === 'tabNext') && lastInput() === 'pad') {
      page(c === 'tabPrev' ? -1 : 1);
      return true;
    }
    // Pad X ('context'), Delete; the keyboard's X ('cancel') only while no search runs (it cancels that first).
    if (c === 'context' || (c === 'cancel' && lastInput() === 'keyboard' && !menu.host.searchView().active)) return goToMe();
    return false;
  };

  // The samples exist in development and in a VITE_UI_FIT=1 build only (read here: node tests import this module).
  if (import.meta.env.DEV || import.meta.env.VITE_UI_FIT === '1') {
    (window as unknown as { __board: (kind: 'rows' | 'below' | 'guest' | null) => void }).__board = (kind) => {
      sample = kind === null ? null : { board: sampleBoard(kind), signedIn: kind !== 'guest' };
      void load();
    };
  }

  return {
    id: 'leaderboard',
    title: t('board.screenTitle'),
    el,
    show: () => {
      void load();
      if (acc.signedIn) void acc.fetchMe().then(() => el.isConnected && draw(), () => undefined);
    },
    command,
  };
}

/** Sample rows for the layout check (window.__board): 100 placed players, long names; yours 7th, 140th or none. */
function sampleBoard(kind: 'rows' | 'below' | 'guest'): LeaderboardAnswer {
  const names = ['MaximilianoGomez', 'Ñandú_Veloz', 'xX_Turbo_Xx', 'Carpincho', 'Pampero99', 'LaTeroDeOro'];
  const placed = TIERS.filter((x) => x.min > 0);
  const entries: LeaderboardEntry[] = Array.from({ length: 100 }, (_, i) => {
    const tier = placed[Math.max(0, placed.length - 1 - Math.floor(i / 6))] ?? TIERS[0];
    return { rank: i + 1, name: i === 6 && kind === 'rows' ? 'MiCuenta' : `${names[i % names.length]}${i > 5 ? i : ''}`, mmr: 2400 - i * 9, tier: tier.id, games: 300 - i, wins: 160 - i };
  });
  const you = kind === 'rows' ? entries[6] : kind === 'below' ? { rank: 140, name: 'MaximilianoGomez', mmr: 1210, tier: TIERS[4]?.id ?? TIERS[0].id, games: 41, wins: 20 } : null;
  return { playlist: '2v2', season: 1, entries, you, total: 1234 };
}

/**
 * The rating change of a finished ranked match (AccountClient.waitRankedResult's answer). `node`:
 * the match ran on a community node, whose result may still be waiting for the replay check.
 */
export function showRankedResult(menu: Pick<Menu, 'toast' | 'modal'>, r: RankedResultAnswer, node = false): void {
  if (r.status === 'pending') {
    menu.toast(t(node ? 'board.resultVerifyingSlow' : 'board.resultPending'), 'info');
    return;
  }
  if (r.status === 'cancelled') {
    menu.toast(t(cancelledKey(r.reason)), 'info');
    return;
  }
  const delta = r.mmrAfter - r.mmrBefore;
  const before = tierById(r.tierBefore);
  const after = tierById(r.tierAfter);
  const placed = r.placementLeft === 0;
  const title = r.outcome === 'win' ? 'board.titleWin' : r.outcome === 'draw' ? 'board.titleDraw' : 'board.titleLoss';
  const bar = h('div.mn-progress', null, h('div.mn-progress-fill'));
  (bar.firstElementChild as HTMLElement).style.width = `${Math.round(tierProgress(r.mmrAfter) * 100)}%`;
  const change = before && after && before.id !== after.id ? t(after.min > before.min ? 'board.promoted' : 'board.demoted', { tier: tierName(after) }) : null;
  const banLeft = r.banUntil - Date.now();
  menu.modal({
    title: t(title, { playlist: playlistName(r.playlist) }),
    body: [
      h(
        `div.mn-result.mn-result-${r.outcome}` as 'div',
        null,
        rankBadge(after, 96),
        h(
          'div',
          null,
          h('div.mn-result-tier', null, placed ? (after ? tierName(after) : '') : t('board.unranked')),
          placed ? h('div.mn-result-mmr', null, `${r.mmrAfter} MMR `, h('span', { class: delta >= 0 ? 'up' : 'down' }, `${delta >= 0 ? '+' : ''}${delta}`)) : h('div.mn-result-mmr', null, t('board.placementLeft', { count: r.placementLeft })),
          placed ? bar : null,
          change ? h('div.mn-result-change', null, change) : null,
        ),
      ),
      r.left ? h('div.mn-ban', null, banLeft > 0 ? t('board.leftBanned', { time: clock(banLeft) }) : t('board.left')) : null,
    ],
    actions: [{ label: t('board.continue'), primary: true, onClick: () => true }],
  });
}

/**
 * The toast of a cancelled ranked result. A community node's match is voided when its replay check
 * fails ('verification_failed:<why>') or cannot run ('unverified'; nodes/control-plane).
 */
export function cancelledKey(reason: string): Key {
  if (reason === 'not_rated') return 'board.notRated';
  if (reason === 'unverified' || reason.startsWith('verification_failed')) return 'board.voided';
  return 'board.cancelled';
}

/** What RankedResults needs from the Game (fakes in tests). */
export interface RankedResultsHost {
  readonly accounts: Pick<AccountClient, 'account' | 'waitRankedResult' | 'fetchMe'>;
  readonly menu: Pick<Menu, 'toast' | 'modal'>;
  /**
   * The menus are where the player looks: on screen, not under the settings screen, no online
   * match being set up or played.
   */
  onScreen(): boolean;
}

/**
 * The rating change of each finished ranked match, over the menus (Game.showMenu starts one per
 * match). The wait lasts up to two minutes on a community node, so the player may be in another
 * match, in training or in the settings by the time the answer comes: a toast there would fade
 * unseen and a modal would wait in the hidden menu, to turn up over some later match. What comes
 * while the menus are away is held, one notice per match (its latest: the result replaces the
 * "verifying" one), and shown by showHeld() once they are back. A notice for an account that is
 * no longer the signed-in one is dropped.
 */
export class RankedResults {
  private readonly host: RankedResultsHost;
  /** Held notices by matchId, oldest match first. */
  private readonly held = new Map<string, { who: string | null; show: () => void }>();

  constructor(host: RankedResultsHost) {
    this.host = host;
  }

  /**
   * A ranked match just ended (`node`: on a community node): wait for its result and show it.
   * `into`: the FINAL's rank card, which takes the answer while it is up for that match (true);
   * otherwise, or once the player has left it, the answer goes the old way (a toast or the dialog).
   */
  async watch(matchId: string, node: boolean, into?: (r: RankedResultAnswer) => boolean): Promise<void> {
    const { accounts, menu } = this.host;
    const who = accounts.account?.playerId ?? null;
    const onVerifying = (): void => this.notice(matchId, who, () => menu.toast(t('board.resultVerifying'), 'info'));
    const r = await accounts.waitRankedResult(matchId, undefined, undefined, { node, onVerifying });
    if (into !== undefined && (accounts.account?.playerId ?? null) === who && into(r)) {
      this.held.delete(matchId); // a held "verifying" is stale: the card says it all
      void accounts.fetchMe().catch(() => undefined);
      return;
    }
    this.notice(matchId, who, () => showRankedResult(menu, r, node));
    void accounts.fetchMe().catch(() => undefined);
  }

  /** Show what came while the menus were away, when they are back (Game: showMenu and every few frames). */
  showHeld(): void {
    if (this.held.size === 0 || !this.host.onScreen()) return;
    const who = this.host.accounts.account?.playerId ?? null;
    const notices = [...this.held.values()];
    this.held.clear();
    for (const n of notices) if (n.who === who) n.show();
  }

  private notice(matchId: string, who: string | null, show: () => void): void {
    this.held.set(matchId, { who, show });
    this.showHeld();
  }
}
