/**
 * Leaderboard (top 100 of the season per playlist, placed players only) and the ranked result
 * dialog shown after a rated match: win / loss, MMR before -> after, the tier change, placement
 * progress and an abandon ban when there was one. RankedResults waits for that result and keeps
 * what comes while the menus are away until they are back.
 */
import { h, setChildren, navButton, clock } from '../dom';
import type { AccountClient } from '../../net/AccountClient';
import { PLAYLISTS } from '../../net/account';
import type { LeaderboardEntry, RankedResultAnswer } from '../../net/account';
import { tierProgress } from '../../net/rating';
import { t, type Key } from '../../i18n';
import { rankBadge, tierById } from '../badges';
import { playlistName, tierName } from '../names';
import type { Menu, Screen } from '../Menu';
import { screenHead } from './common';

export function leaderboardScreen(menu: Menu): Screen {
  const tabs = h('div.mn-tabs');
  const table = h('div.mn-board');
  const foot = h('div.mn-board-foot');
  let seq = 0;
  const row = (e: LeaderboardEntry, you: boolean): HTMLElement => {
    const tier = tierById(e.tier);
    return h(
      `div.mn-board-row${you ? '.mn-board-you' : ''}` as 'div',
      null,
      h('span.mn-board-rank', null, `#${e.rank}`),
      h('span.mn-board-name', null, rankBadge(tier, 26), e.name),
      h('span.mn-board-tier', null, tier ? tierName(tier) : t('board.unranked')),
      h('span.mn-board-mmr', null, String(e.mmr)),
      h('span.mn-board-games', null, String(e.games)),
      h('span.mn-board-wr', null, e.games > 0 ? t('board.winRate', { percent: Math.round((100 * e.wins) / e.games) }) : '-'),
    );
  };
  const load = async (): Promise<void> => {
    const p = menu.prefs.leaderboardPlaylist;
    const my = ++seq;
    // Rebuilt on each pick: the key (Menu's focus memory) keeps the controller on the tab it picked.
    setChildren(tabs, ...PLAYLISTS.map((x) => navButton(`mn-tab${x === p ? ' mn-tab-on' : ''}`, playlistName(x), () => {
      menu.prefs.leaderboardPlaylist = x;
      menu.savePrefs();
      void load();
    }, { 'data-key': 'board-' + x })));
    setChildren(table, h('div.mn-empty', null, t('board.loading')));
    try {
      const b = await menu.host.accounts.leaderboard(p);
      if (my !== seq) return;
      const youName = b.you?.name;
      const head = h('div.mn-board-row.mn-board-head', null, h('span', null, '#'), h('span', null, t('board.colPlayer')), h('span', null, t('board.colTier')), h('span', null, 'MMR'), h('span', null, t('board.colGames')), h('span', null, t('board.colWinRate')));
      setChildren(table, head, ...(b.entries.length > 0 ? b.entries.map((e) => row(e, e.name === youName)) : [h('div.mn-empty', null, t('board.empty'))]));
      foot.textContent = '';
      if (b.you && !b.entries.some((e) => e.name === b.you?.name)) setChildren(foot, row(b.you, true));
      else if (!b.you) foot.textContent = menu.host.accounts.signedIn ? t('board.playPlacement') : t('board.signIn');
      foot.appendChild(h('div.mn-note', null, t('board.total', { count: b.total, season: b.season })));
    } catch (e) {
      if (my === seq) setChildren(table, h('div.mn-empty', null, e instanceof Error ? e.message : String(e)));
    }
    menu.refocus();
  };
  const el = h('div.mn-leaderboard', null, screenHead(t('board.title'), t('board.subtitle')), tabs, table, foot);
  return { id: 'leaderboard', title: t('board.screenTitle'), el, show: () => void load() };
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
