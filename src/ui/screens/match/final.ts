/**
 * The FINAL (plan §1.4 "FINAL", PR 7; the owner's hub-final-pc): a Menu screen stacked on Inicio
 * that the Game opens about 2 s after the whistle (never over a match that goes on). Over the
 * veil, a card: the slot "FINAL · COMPETITIVO · 2V2 · SUDAMÉRICA", VICTORIA / DERROTA / EMPATE,
 * the score with a notch under your team, the players by team (TÚ, MVP, goals: the client's own
 * last-touch attribution, finalModel.ts goalScorer), for a ranked match the rank card (the
 * rating change the old result dialog showed: RankedResults hands it over here while the FINAL is
 * up), and a community node's line. Under it the dock: JUGAR OTRA VEZ (focused: the same queue,
 * a new match against the AI, or back to the lobby), CAMBIAR MODO, MENÚ. The shell's top bar,
 * rail and tab bar step aside (final.css); the hint bar, FocusNav, the tap guard and Back (= MENÚ:
 * the stack pops to Inicio) are the shell's.
 *
 * In development (or a VITE_UI_FIT=1 build) window.__final(kind | null) shows sample data for the
 * layout check (scripts/ui-fit.mjs).
 */
import { h, setChildren, clock } from '../../dom';
import { t } from '../../../i18n';
import type { RankedResultAnswer, RegionId } from '../../../net/account';
import type { GameMode } from '../../../sim/constants';
import type { Menu, Screen } from '../../Menu';
import { icon } from '../../components/icons';
import { slot } from '../../components/tile';
import { rankBadge, tierById } from '../../badges';
import { difficultyName, regionName, tierName } from '../../names';
import { cancelledKey } from '../leaderboard';
import { HERO_SEP } from '../homeModel';
import { againAction, changeTab, finalOutcome, finalRows, pickMvp, rankCard } from './finalModel';
import type { FinalKind, FinalPlayer, FinalView } from './finalModel';

const UI_FIT = import.meta.env.DEV || import.meta.env.VITE_UI_FIT === '1';

/** What the FINAL needs besides the menus (the Game: Menu.host carries it). */
export interface FinalSource {
  /** The match that ended, null when none (the screen then shows nothing and goes back). */
  finalView(): FinalView | null;
  /**
   * A tier picked during the online match waits for the FINAL to go: its reload (Game.pendingRestart),
   * by the tier's name (the main button says what it will do), null when none waits.
   */
  reloadWaits(): string | null;
  /** The FINAL is off the stack (MENÚ, Back, a section, a crumb, CAMBIAR MODO): what waited for it runs. */
  left(): void;
}

const KIND_NAME: Readonly<Record<FinalKind, 'play.casualTitle' | 'play.rankedTitle' | 'final.vsAi' | 'final.lobby'>> = {
  casual: 'play.casualTitle',
  ranked: 'play.rankedTitle',
  ai: 'final.vsAi',
  lobby: 'final.lobby',
};

/**
 * The FINAL screen. `setRank` puts a ranked result (or "still waiting") in its card; it returns
 * false when the FINAL is not up for that match any more (RankedResults then keeps it for later).
 */
export interface FinalScreen extends Screen {
  setRank(matchId: string, r: RankedResultAnswer | null): boolean;
}

export function finalScreen(menu: Menu, source: FinalSource): FinalScreen {
  const card = h('section.mn-final-card', { role: 'group' });
  const again = h('button.mn-final-again', { type: 'button', 'data-nav': true, 'data-key': 'final-again', 'data-autofocus': true, onclick: () => playAgain() });
  const change = h('button.mn-final-alt', { type: 'button', 'data-nav': true, 'data-key': 'final-change', onclick: () => changeMode() });
  const home = h('button.mn-final-alt', { type: 'button', 'data-nav': true, 'data-key': 'final-menu', onclick: () => menu.back() });
  const el = h('div.mn-final', { 'data-tablero': true }, card, h('div.mn-final-dock', { 'data-nav-row': true }, again, change, home));
  const rankBox = h('div.mn-final-rank');
  let view: FinalView | null = null;
  /** The ranked result in the card and the match it belongs to. */
  let rankFor: string | null = null;
  let rank: RankedResultAnswer | null = null;

  const current = (): FinalView | null => (sampleKind !== null ? sampleView(sampleKind) : source.finalView());

  const playAgain = (): void => {
    const v = view;
    if (v === null) {
      menu.back();
      return;
    }
    const a = againAction(v.kind, menu.prefs, source.reloadWaits() !== null);
    if (a.kind === 'home') {
      menu.back();
      return;
    }
    if (a.kind === 'lobby') return menu.replace('lobby');
    if (a.kind === 'restart') {
      // Off the FINAL first: the menus that come back after this match open on Inicio.
      menu.beforeMatch(() => {
        menu.back();
        menu.host.playFriendly(menu.host.mode, menu.host.difficulty);
      });
      return;
    }
    // The search runs from Inicio, whose hero shows it (and cancels it): the FINAL goes first.
    menu.beforeMatch(() => {
      menu.back();
      menu.startSearch(a.queue);
    });
  };

  const changeMode = (): void => {
    const v = view;
    menu.replace('modes', v !== null ? changeTab(v.kind) : 'casual');
  };

  const regionText = (r: RegionId | null): string | null => {
    const id = r ?? menu.regionId;
    return id !== null ? regionName(id) : null;
  };

  /** "Casual · 2v2 · Sudamérica", "Amistoso · 2v2 · Normal". */
  const queueLine = (v: FinalView): string => {
    if (v.kind === 'ai') return [t('final.vsAi'), v.mode, difficultyName(menu.host.difficulty)].join(HERO_SEP);
    if (v.kind === 'lobby') return t('final.backToLobby');
    const modes = v.kind === 'ranked' ? menu.prefs.rankedModes : menu.prefs.casualModes;
    const region = regionText(menu.prefs.region);
    return [t(KIND_NAME[v.kind]), ...modes, region].filter((x) => x !== null).join(HERO_SEP);
  };

  const teamName = (team: 0 | 1): string => t(team === 0 ? 'hud.teamBlue' : 'hud.teamRed');

  const playerRow = (p: FinalPlayer, mvp: boolean): HTMLElement =>
    h(
      `div.mn-final-row${p.you ? '.mn-final-you' : ''}.mn-final-t${p.team}` as 'div',
      { role: 'row' },
      h(
        'span.mn-final-name',
        { role: 'cell' },
        h('span.mn-final-player', null, p.name),
        p.you ? slot(t('hud.you'), { ink: true }) : null,
        p.bot ? slot(t('hud.bot')) : null,
        mvp ? h('span.mn-slot.mn-final-mvp', null, icon('trophy'), 'MVP') : null,
      ),
      h('span.mn-final-goals', { role: 'cell' }, String(p.goals)),
    );

  const renderRank = (): void => {
    const v = view;
    if (v === null || v.rankedMatchId === null) {
      rankBox.hidden = true;
      return;
    }
    rankBox.hidden = false;
    const c = rankCard(rank);
    const head = h('span.mn-final-label', null, t('final.yourRank', { mode: v.mode.toUpperCase() }));
    if (c.state !== 'done') {
      const line = c.state === 'waiting' ? t('final.rankWaiting') : c.state === 'pending' ? t('board.resultPending') : t(cancelledKey(c.reason));
      setChildren(rankBox, head, h('span.mn-final-rank-wait', null, c.state === 'waiting' ? h('span.mn-spinner') : null, line));
      return;
    }
    const tier = tierById(c.tierId);
    const placed = c.placementLeft === 0;
    const up = c.delta >= 0;
    const bar = h('span.mn-final-bar', { 'aria-hidden': 'true' }, h('span.mn-final-bar-was'), h(`span.mn-final-bar-${up ? 'up' : 'down'}` as 'span'));
    (bar.children[0] as HTMLElement).style.width = `${Math.round(c.from * 100)}%`;
    const delta = bar.children[1] as HTMLElement;
    delta.style.left = `${Math.round(c.from * 100)}%`;
    delta.style.width = `${Math.round((c.to - c.from) * 100)}%`;
    const next = tierById(c.nextId);
    const ban = c.banUntil - Date.now();
    setChildren(
      rankBox,
      head,
      h(
        'div.mn-final-rank-main',
        null,
        rankBadge(tier, 56),
        h(
          'span.mn-final-rank-text',
          null,
          h('b', null, placed && tier !== null ? tierName(tier) : t('board.unranked')),
          h('span', null, placed ? `${c.mmr} MMR` : t('board.placementLeft', { count: c.placementLeft })),
        ),
        placed ? h(`span.mn-final-delta.mn-final-delta-${up ? 'up' : 'down'}` as 'span', { 'aria-label': t(up ? 'final.rankUp' : 'final.rankDown', { mmr: Math.abs(c.delta) }) }, `${up ? '+' : '−'}${Math.abs(c.delta)}`) : null,
      ),
      placed ? bar : null,
      placed && next !== null ? h('span.mn-final-rank-next', null, t('final.toNext', { mmr: c.toNext, tier: tierName(next) })) : null,
      ban > 0 ? h('span.mn-final-rank-ban', null, t('board.leftBanned', { time: clock(ban) })) : null,
    );
  };

  const render = (v: FinalView): void => {
    const outcome = finalOutcome(v);
    const mvp = pickMvp(v.players, v.winner);
    const mvpPlayer = mvp >= 0 ? v.players[mvp] : null;
    const tag = [t('final.slot'), t(KIND_NAME[v.kind]).toUpperCase(), v.mode.toUpperCase(), v.kind === 'casual' || v.kind === 'ranked' ? regionText(menu.prefs.region)?.toUpperCase() ?? null : null]
      .filter((x) => x !== null)
      .join(HERO_SEP);
    const score = h(
      `div.mn-final-score.mn-final-mine${v.team}` as 'div',
      { role: 'img', 'aria-label': t('final.scoreLabel', { blue: v.blue, red: v.red, team: teamName(v.team) }) },
      h('span.mn-final-tag.mn-final-t0', null, t('hud.tagBlue')),
      h('span.mn-final-num', null, String(v.blue)),
      h('span.mn-final-dash', { 'aria-hidden': 'true' }, '–'),
      h('span.mn-final-num', null, String(v.red)),
      h('span.mn-final-tag.mn-final-t1', null, t('hud.tagRed')),
    );
    const team = (k: 0 | 1): HTMLElement[] => [
      h(`div.mn-final-team.mn-final-t${k}` as 'div', null, teamName(k).toUpperCase()),
      ...finalRows(v.players, k).map((p) => playerRow(p, p === mvpPlayer)),
    ];
    const table = h(
      'div.mn-final-table',
      { role: 'table', 'aria-label': t('final.players') },
      h('div.mn-final-row.mn-final-headrow', { role: 'row' }, h('span', { role: 'columnheader' }, t('final.colPlayer')), h('span', { role: 'columnheader' }, t('final.colGoals'))),
      ...team(0),
      ...team(1),
    );
    renderRank();
    const side = h(
      'div.mn-final-side',
      null,
      v.rankedMatchId !== null ? rankBox : null,
      mvpPlayer !== null
        ? h('div.mn-final-mvpcard', null, icon('trophy'), h('span', null, h('span.mn-final-label', null, t('final.mvpLabel')), h('span', null, h('b', null, mvpPlayer.name), HERO_SEP, t('final.goals', { count: mvpPlayer.goals }))))
        : null,
    );
    const node =
      v.node !== null
        ? h('div.mn-final-node', null, icon('server'), h('span', null, t('final.server', { name: v.node })), slot(t('final.community')), h('span.mn-final-rules', null, t(v.kind === 'ranked' ? 'final.rulesRanked' : 'final.rules')))
        : null;
    setChildren(
      card,
      h(
        'div.mn-final-head',
        null,
        h('div.mn-final-title', null, slot(tag), h(`h2.mn-final-outcome.mn-final-${outcome}.mn-final-mine${v.team}` as 'h2', null, t(`final.${outcome}`))),
        score,
      ),
      h('div.mn-final-body', { class: side.childElementCount > 0 ? 'mn-final-split' : '' }, table, side.childElementCount > 0 ? side : null),
      node,
    );
    card.setAttribute('aria-label', t('final.label', { outcome: t(`final.${outcome}`), blue: v.blue, red: v.red }));
    // A reload waiting (Súper bajo picked in the match): the button restarts the game first, and says so.
    const reload = source.reloadWaits();
    const againSlot = reload !== null ? t('final.slotRestart') : v.kind === 'lobby' ? t('final.slotLobby') : v.kind === 'ai' ? t('final.slotAi') : t('final.slotQueue');
    const title = reload !== null ? t('final.restart') : t('final.again');
    const sub = reload === null ? queueLine(v) : t(v.kind === 'lobby' ? 'final.restartLobby' : 'final.restartHome', { quality: reload });
    setChildren(
      again,
      h('span.mn-final-again-icon', { 'aria-hidden': 'true' }, icon('refresh')),
      h('span.mn-final-again-text', null, slot(againSlot, { ink: true }), h('span.mn-final-again-title', { 'data-fit': '24' }, title), h('span.mn-final-again-sub', null, sub)),
      h('span.mn-hero-go', { 'aria-hidden': 'true' }, icon('arrow')),
    );
    setChildren(change, icon('refresh', 'mn-final-alt-icon'), h('span.mn-final-alt-text', null, h('b', null, t('final.change')), h('span', null, t('final.changeSub'))));
    setChildren(home, icon('play', 'mn-final-alt-icon'), h('span.mn-final-alt-text', null, h('b', null, t('final.menu')), h('span', null, t('final.menuSub'))));
  };

  const show = (): void => {
    const v = current();
    view = v;
    if (v === null) {
      // Nothing ended (a reload on #ui=final without samples): back to Inicio.
      queueMicrotask(() => menu.back());
      return;
    }
    if (v.rankedMatchId !== rankFor) {
      rankFor = v.rankedMatchId;
      rank = sampleKind === 'ranked' ? SAMPLE_RANK : null;
    }
    render(v);
  };

  if (UI_FIT) redraw = () => {
    show();
    menu.refit();
  };

  return {
    id: 'final',
    title: t('final.slot'),
    el,
    show,
    hide: () => {
      sampleKind = null;
      // Off the stack, not under a screen on top of it (Ajustes) or the menus hidden: Menu.mount
      // calls this again once the stack no longer holds it.
      if (!menu.stacked('final')) source.left();
    },
    setRank: (matchId, r) => {
      if (view === null || view.rankedMatchId !== matchId || menu.top()?.id !== 'final' || !menu.visible) return false;
      rankFor = matchId;
      rank = r;
      renderRank();
      menu.refit();
      return true;
    },
  };
}

/** The sample window.__final shows (development and VITE_UI_FIT=1 only), null: the real match. */
let sampleKind: FinalKind | null = null;
/** The FINAL on screen draws again (a new sample over the one shown). */
let redraw: (() => void) | null = null;

const SAMPLE_RANK: RankedResultAnswer = { status: 'done', playlist: '2v2', outcome: 'win', left: false, mmrBefore: 1042, mmrAfter: 1060, tierBefore: 'gold-2', tierAfter: 'gold-3', placementLeft: 0, banUntil: 0 };

/** window.__final(kind | null): the FINAL with sample data, for the layout check (scripts/ui-fit.mjs); nothing in a release build. */
export function installFinalSample(menu: Menu): void {
  if (!UI_FIT) return;
  (window as unknown as { __final: (kind: FinalKind | null) => void }).__final = (kind) => {
    sampleKind = kind;
    if (menu.visible && menu.top()?.id === 'final' && redraw !== null) redraw();
    else menu.show('final');
  };
}

/** Sample data for the layout check (window.__final): long names, and a full 3v3 against the AI. */
function sampleView(kind: FinalKind): FinalView {
  const p = (name: string, team: 0 | 1, goals: number, you = false, bot = false): FinalPlayer => ({ name, team, goals, you, bot });
  const bot = (n: number, team: 0 | 1, goals = 0): FinalPlayer => p(t('game.botName', { number: n }), team, goals, false, true);
  const ai = kind === 'ai';
  const mode: GameMode = ai ? '3v3' : '2v2';
  const players = ai
    ? [p('Constantinopla_9', 0, 2, true), bot(1, 0), bot(2, 0), bot(3, 1, 2), bot(4, 1), bot(5, 1)]
    : [p('Constantinopla_9', 0, kind === 'casual' ? 0 : 2, true), p('Ana', 0, 1), p('Leo', 1, kind === 'casual' ? 2 : 1), p('Valentina_Rios', 1, 0)];
  const goals = (team: 0 | 1): number => players.filter((x) => x.team === team).reduce((s, x) => s + x.goals, 0);
  const blue = goals(0);
  const red = goals(1);
  return {
    kind,
    winner: blue === red ? null : blue > red ? 0 : 1,
    team: 0,
    blue,
    red,
    mode,
    region: 'SA',
    players,
    node: kind === 'ranked' ? 'sao-paulo-1' : null,
    rankedMatchId: kind === 'ranked' ? 'f'.repeat(64) : null,
  };
}
