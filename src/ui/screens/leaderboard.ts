/**
 * Leaderboard (top 100 of the season per playlist, placed players only) and the ranked result
 * dialog shown after a rated match: win / loss, MMR before -> after, the tier change, placement
 * progress and an abandon ban when there was one.
 */
import { h, setChildren, navButton, clock } from '../dom';
import { PLAYLISTS } from '../../net/account';
import type { LeaderboardEntry, RankedResultAnswer } from '../../net/account';
import { tierProgress } from '../../net/rating';
import { t } from '../../i18n';
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
    setChildren(tabs, ...PLAYLISTS.map((x) => navButton(`mn-tab${x === p ? ' mn-tab-on' : ''}`, `${playlistName(x)} ${x}`, () => {
      menu.prefs.leaderboardPlaylist = x;
      menu.savePrefs();
      void load();
    })));
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

/** The rating change of a finished ranked match (AccountClient.waitRankedResult's answer). */
export function showRankedResult(menu: Menu, r: RankedResultAnswer): void {
  if (r.status === 'pending') {
    menu.toast(t('board.resultPending'), 'info');
    return;
  }
  if (r.status === 'cancelled') {
    menu.toast(r.reason === 'not_rated' ? t('board.notRated') : t('board.cancelled'), 'info');
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
