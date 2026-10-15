/**
 * Leaderboard (top 100 of the season per playlist, placed players only) and the ranked result
 * dialog shown after a rated match: win / loss, MMR before -> after, the tier change, placement
 * progress and an abandon ban when there was one.
 */
import { h, setChildren, navButton, clock } from '../dom';
import { PLAYLISTS, PLAYLIST_NAMES } from '../../net/account';
import type { LeaderboardEntry, RankedResultAnswer } from '../../net/account';
import { tierProgress } from '../../net/rating';
import { rankBadge, tierById, tierName } from '../badges';
import type { Menu, Screen } from '../Menu';
import { screenHead } from './common';

export function leaderboardScreen(menu: Menu): Screen {
  const tabs = h('div.mn-tabs');
  const table = h('div.mn-board');
  const foot = h('div.mn-board-foot');
  let seq = 0;
  const row = (e: LeaderboardEntry, you: boolean): HTMLElement =>
    h(
      `div.mn-board-row${you ? '.mn-board-you' : ''}` as 'div',
      null,
      h('span.mn-board-rank', null, `#${e.rank}`),
      h('span.mn-board-name', null, rankBadge(tierById(e.tier), 26), e.name),
      h('span.mn-board-tier', null, tierName(e.tier)),
      h('span.mn-board-mmr', null, String(e.mmr)),
      h('span.mn-board-games', null, String(e.games)),
      h('span.mn-board-wr', null, e.games > 0 ? `${Math.round((100 * e.wins) / e.games)}%` : '-'),
    );
  const load = async (): Promise<void> => {
    const p = menu.prefs.leaderboardPlaylist;
    const my = ++seq;
    setChildren(tabs, ...PLAYLISTS.map((x) => navButton(`mn-tab${x === p ? ' mn-tab-on' : ''}`, `${PLAYLIST_NAMES[x]} ${x}`, () => {
      menu.prefs.leaderboardPlaylist = x;
      menu.savePrefs();
      void load();
    })));
    setChildren(table, h('div.mn-empty', null, 'Cargando…'));
    try {
      const b = await menu.host.accounts.leaderboard(p);
      if (my !== seq) return;
      const youName = b.you?.name;
      const head = h('div.mn-board-row.mn-board-head', null, h('span', null, '#'), h('span', null, 'Jugador'), h('span', null, 'Rango'), h('span', null, 'MMR'), h('span', null, 'Partidas'), h('span', null, '% victorias'));
      setChildren(table, head, ...(b.entries.length > 0 ? b.entries.map((e) => row(e, e.name === youName)) : [h('div.mn-empty', null, 'Todavía nadie terminó la clasificación en esta playlist.')]));
      foot.textContent = '';
      if (b.you && !b.entries.some((e) => e.name === b.you?.name)) setChildren(foot, row(b.you, true));
      else if (!b.you) foot.textContent = menu.host.accounts.signedIn ? 'Jugá 5 partidas de clasificación para aparecer.' : 'Iniciá sesión para ver tu posición.';
      foot.appendChild(h('div.mn-note', null, `${b.total} jugadores clasificados · Temporada ${b.season}`));
    } catch (e) {
      if (my === seq) setChildren(table, h('div.mn-empty', null, e instanceof Error ? e.message : String(e)));
    }
    menu.refocus();
  };
  const el = h('div.mn-leaderboard', null, screenHead('CLASIFICACIÓN', 'Los mejores MMR de la temporada (después de las 5 partidas de clasificación).'), tabs, table, foot);
  return { id: 'leaderboard', title: 'Clasificación', el, show: () => void load() };
}

/** The rating change of a finished ranked match (AccountClient.waitRankedResult's answer). */
export function showRankedResult(menu: Menu, r: RankedResultAnswer): void {
  if (r.status === 'pending') {
    menu.toast('El resultado del ranked todavía se está calculando: miralo en tu perfil.', 'info');
    return;
  }
  if (r.status === 'cancelled') {
    menu.toast(r.reason === 'not_rated' ? 'Esa partida no contó para el rango' : 'La partida competitiva se canceló y no contó', 'info');
    return;
  }
  const delta = r.mmrAfter - r.mmrBefore;
  const before = tierById(r.tierBefore);
  const after = tierById(r.tierAfter);
  const placed = r.placementLeft === 0;
  const title = r.outcome === 'win' ? 'VICTORIA' : r.outcome === 'draw' ? 'EMPATE' : 'DERROTA';
  const bar = h('div.mn-progress', null, h('div.mn-progress-fill'));
  (bar.firstElementChild as HTMLElement).style.width = `${Math.round(tierProgress(r.mmrAfter) * 100)}%`;
  const change = before && after && before.id !== after.id ? (after.min > before.min ? `¡Subiste a ${after.name}!` : `Bajaste a ${after.name}`) : null;
  menu.modal({
    title: `${title} · ${PLAYLIST_NAMES[r.playlist]}`,
    body: [
      h(
        `div.mn-result.mn-result-${r.outcome}` as 'div',
        null,
        rankBadge(after, 96),
        h(
          'div',
          null,
          h('div.mn-result-tier', null, placed ? (after?.name ?? '') : 'Sin clasificar'),
          placed ? h('div.mn-result-mmr', null, `${r.mmrAfter} MMR `, h('span', { class: delta >= 0 ? 'up' : 'down' }, `${delta >= 0 ? '+' : ''}${delta}`)) : h('div.mn-result-mmr', null, `Clasificación: faltan ${r.placementLeft} partidas`),
          placed ? bar : null,
          change ? h('div.mn-result-change', null, change) : null,
        ),
      ),
      r.left ? h('div.mn-ban', null, `Abandonaste: cuenta como derrota${r.banUntil > Date.now() ? ` y Competitivo queda bloqueado ${clock(r.banUntil - Date.now())}` : ''}.`) : null,
    ],
    actions: [{ label: 'CONTINUAR', primary: true, onClick: () => true }],
  });
}
