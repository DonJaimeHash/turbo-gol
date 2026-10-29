/**
 * MODOS (plan §1.4 "Modos", §1.4.1, PR 6; the owner's artboard): the screen Inicio's four tiles open,
 * stacked on JUGAR (crumbs JUGAR › MODOS), with vertical tabs CASUAL · COMPETITIVO · SALAS · CONTRA LA
 * IA (the tile that opened it says which: Menu.open's tab, Screen.setTab). Three columns on a PC:
 * the tabs, the tab's own content, and the action zone aligned at the bottom.
 *
 * - CASUAL / COMPETITIVO: FORMAT as a 2 x 2 grid, 1v1, 2v2, 3v3 and ANY (named by format only). A
 *   format's press picks it and searches (from Inicio, a Casual search of a chosen format is two
 *   presses), and while that kind searches it restarts the search, as the note under the grid
 *   says. Then Region (the region sheet) and, for Casual, Advanced (Connection: auto, P2P, server).
 *   The action zone: the queue, one line, FIND MATCH (focused on a first visit); a guest's
 *   Competitive is SIGN IN (PERFIL as a detour: a sign-in there comes back here, FIND MATCH
 *   focused), a banned player's says why and for how long (duration()) and offers PLAY CASUAL.
 * - The searching panel, as drawn and without "play with bots now": FINDING A MATCH, UNRANKED (or
 *   RANKED), the clock, the queue, where and (over the threshold) how many play, "bots join in"
 *   only when true for the path the search takes (modesModel.ts botsCountdown: the server queue's
 *   botFillMs from /api/config, the P2P queue's P2P_FILL_WAIT_MS), CANCEL SEARCH (keyboard X, pad
 *   Y, the pill's ✕ too) and "While you wait: Free play" (MenuHost.practiceWhileSearching).
 * - SALAS (PR 12): JOIN WITH CODE, the region and the public list (custom.ts lobbyBrowser) in the tab;
 *   the action is CREATE LOBBY AND SHARE (screens/lobby.ts createAndShare), BACK TO LOBBY ABC 234
 *   while the player is in one (kept with KEEP THE LOBBY: the screen no longer comes back by itself).
 * - CONTRA LA IA: mode and difficulty as mn-seg, the Stadium row (GARAJE, where the stadiums are),
 *   PLAY.
 *
 * Shortcuts (Screen.command): Q / E (keyboard), LB / RB and LT / RT (pad) step the tabs, round: on
 * a stacked screen the section bar is not there (plan §1.5); the hint bar calls them "Modes"
 * (tabsVerb). A tab switches on its press, not on its focus (a remote walks ▲ ▼ over them, OK
 * picks). Written on a change only (the Menu's tick: 4 Hz, 1 Hz on super low).
 */
import { h, clock, setChildren } from '../dom';
import { duration, t } from '../../i18n';
import type { Key } from '../../i18n';
import { PLAYLISTS } from '../../net/account';
import type { RegionId } from '../../net/account';
import { P2P_FILL_WAIT_MS } from '../../net/p2p/protocol';
import { MODES } from '../../sim/constants';
import type { GameMode } from '../../sim/constants';
import { DIFFICULTIES } from '../../render/Hud';
import type { Difficulty } from '../../render/Hud';
import { regionName, themeName, tierName, difficultyName } from '../names';
import { tierById } from '../badges';
import type { Menu, MenuCommand, Screen, SearchView } from '../Menu';
import { icon } from '../components/icons';
import type { IconName } from '../components/icons';
import { glyph } from '../components/glyphs';
import { slot } from '../components/tile';
import { seg } from '../components/seg';
import { picker } from '../components/picker';
import { PLAYING_SHOWN } from '../shell/pills';
import { lobbyBrowser } from './custom';
import { createAndShare } from './lobby';
import { spacedCode } from './lobbyModel';
import { FORMATS, MODE_TABS, NET_PICKS, actionKind, botsCountdown, botsSegments, countShown, formatOf, isModeTab, modesOf, queueNet, stepTab } from './modesModel';
import type { ActionKind, Format, ModeTab, NetPick } from './modesModel';

/** The bots countdown's bar (as drawn). */
const SEGMENTS = 18;

const TAB_ICON: Record<ModeTab, IconName> = { casual: 'ball', ranked: 'rank', lobbies: 'friends', ai: 'bot' };
const TAB_TITLE: Record<ModeTab, Key> = { casual: 'modes.casual', ranked: 'modes.ranked', lobbies: 'modes.lobbies', ai: 'modes.vsAi' };
const TAB_INTRO: Record<ModeTab, Key> = { casual: 'modes.casualSub', ranked: 'modes.rankedIntro', lobbies: 'custom.subtitle', ai: 'friendly.intro' };
const NET_LABEL: Record<NetPick, Key> = { auto: 'modes.netAuto', p2p: 'modes.netP2p', server: 'modes.netServer' };
const NET_HELP: Record<NetPick, Key> = { auto: 'modes.netAutoHelp', p2p: 'modes.netP2pHelp', server: 'modes.netServerHelp' };

const setText = (el: HTMLElement, text: string): void => {
  if (el.textContent !== text) el.textContent = text;
};
const setHidden = (el: HTMLElement, hidden: boolean): void => {
  if (el.hidden !== hidden) el.hidden = hidden;
};

/** A format's name: '2v2', or ANY. */
const formatName = (f: Format): string => (f === 'any' ? t('format.any') : f);
/** A format inside a sentence: '2v2', or '1v1, 2v2 or 3v3'. */
const formatWords = (f: Format): string => (f === 'any' ? t('format.anySub') : f);

/** The two teams of a format, drawn as the artboard does (blue bars, VS, red bars). */
function teams(m: GameMode): HTMLElement {
  const bars = (cls: string): HTMLElement[] => Array.from({ length: MODES[m] }, () => h(`span.mn-format-car.${cls}` as 'span'));
  return h('span.mn-format-teams', { 'aria-hidden': 'true' }, ...bars('mn-format-blue'), h('span.mn-format-vs', null, 'VS'), ...bars('mn-format-red'));
}

export function modesScreen(menu: Menu): Screen {
  const host = menu.host;
  const acc = host.accounts;
  const touch = (): boolean => document.documentElement.classList.contains('tg-touch');
  let tab: ModeTab = 'casual';
  /** Competitive's SIGN IN opened PERFIL: a sign-in there comes back here. */
  let waitSignIn = false;
  let aiMode: GameMode = host.mode;
  let aiDifficulty: Difficulty = host.difficulty;
  let shown = false;

  // ---- the tabs ----
  const tabEls = new Map<ModeTab, { el: HTMLButtonElement; sub: HTMLElement; end: HTMLElement }>();
  for (const id of MODE_TABS) {
    const sub = h('small.mn-mtab-sub');
    const end = h('span.mn-mtab-end');
    const el = h(
      'button.mn-tab.mn-mtab',
      { type: 'button', role: 'tab', 'aria-selected': 'false', 'data-nav': true, 'data-key': 'tab-' + id, onclick: () => pick(id) },
      icon(TAB_ICON[id]),
      h('span.mn-mtab-text', null, h('b.mn-mtab-name', { 'data-fit': '14' }, t(TAB_TITLE[id])), sub),
      end,
      h('span.mn-mtab-mark', { 'aria-hidden': 'true' }),
    );
    tabEls.set(id, { el, sub, end });
  }
  const tabList = h('div.mn-tabs.mn-mtabs', { role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': t('nav.modes') }, ...[...tabEls.values()].map((x) => x.el));
  const keys = h('span.mn-modes-keys', { 'aria-hidden': 'true' }, h('span.mn-keys-kb', null, glyph('key-q'), glyph('key-e')), h('span.mn-keys-pad', null, glyph('pad-lb'), glyph('pad-rb')));
  const side = h('div.mn-modes-side', null, h('div.mn-modes-head', null, h('span.mn-modes-label', null, t('nav.modes')), keys), tabList);

  // ---- the center: title, intro, and the tab's own part ----
  const title = h('h1.mn-modes-title', { 'data-fit': '20' });
  const intro = h('p.mn-modes-intro');
  const formatEls = new Map<Format, { el: HTMLButtonElement; tag: HTMLElement; sub: HTMLElement }>();
  for (const f of FORMATS) {
    const tag = h('span.mn-format-tag');
    const sub = h('span.mn-format-sub');
    const el = h(
      'button.mn-format',
      { type: 'button', 'data-nav': true, 'data-key': 'format-' + f, 'aria-pressed': 'false', onclick: () => pickFormat(f) },
      h('span.mn-format-top', null, f === 'any' ? icon('ball') : teams(f), tag),
      h('span.mn-format-text', null, h('span.mn-format-name', null, formatName(f)), sub),
    );
    formatEls.set(f, { el, tag, sub });
  }
  const formats = h('div.mn-formats', null, ...[...formatEls.values()].map((x) => x.el));
  const note = h('p.mn-modes-note', { hidden: true }, icon('info'), t('search.formatRestarts'));
  const region = picker('modes-region', 'globe', t('common.region'), () => menu.openRegionSheet());
  const advanced = picker('modes-advanced', 'settings', t('modes.advanced'), () => openNet());
  const queuePart = h('div.mn-modes-queue', null, h('span.mn-modes-label', null, t('modes.format')), formats, note, h('div.mn-modes-rows', null, region.el, advanced.el));
  const lobbies = lobbyBrowser(menu);
  const lobbiesPart = h('div.mn-modes-lobbies', { hidden: true }, lobbies.el);
  const modeSeg = seg<GameMode>('ai-mode', t('friendly.mode'), PLAYLISTS.map((p) => ({ value: p, label: p })), () => aiMode, (v) => (aiMode = v));
  const diffSeg = seg<Difficulty>('ai-diff', t('friendly.difficulty'), DIFFICULTIES.map((d) => ({ value: d, label: difficultyName(d) })), () => aiDifficulty, (v) => (aiDifficulty = v));
  const stadium = picker('ai-stadium', 'stadium', t('friendly.theme'), () => menu.open('garage', false, 'stadiums'));
  const aiPart = h(
    'div.mn-modes-ai',
    { hidden: true },
    h('div.mn-modes-field', null, h('span.mn-modes-label', null, t('friendly.mode')), modeSeg.el),
    h('div.mn-modes-field', null, h('span.mn-modes-label', null, t('friendly.difficulty')), diffSeg.el),
    h('div.mn-modes-rows', null, stadium.el),
  );
  const main = h('div.mn-modes-main', null, title, intro, queuePart, lobbiesPart, aiPart);

  // ---- the action zone: idle (summary, line, the primary) or the searching panel ----
  const summary = h('div.mn-act-summary', { 'data-fit': '16' });
  const line = h('p.mn-act-line');
  const go = h('button.mn-btn.mn-btn-primary.mn-act-go', { type: 'button', 'data-nav': true, 'data-key': 'modes-go', 'data-autofocus': true, onclick: () => primary() }, h('span.mn-act-go-label'), icon('next'));
  const goLabel = go.firstElementChild as HTMLElement;
  const idle = h('div.mn-act-idle', null, summary, line, go);
  const sTag = h('span.mn-act-tag');
  const sClock = h('div.mn-act-clock');
  const sQueue = h('div.mn-act-queue');
  const sWhere = h('div.mn-act-where');
  const botsTime = h('b.mn-act-bots-time');
  const botsBar = h('span.mn-act-bar', { 'aria-hidden': 'true' }, ...Array.from({ length: SEGMENTS }, () => h('span')));
  const bots = h('div.mn-act-bots', { hidden: true }, h('div.mn-act-bots-row', null, icon('bot'), h('span', null, t('search.bots')), botsTime), botsBar, h('p.mn-act-always', null, t('search.always')));
  const cancel = h(
    'button.mn-btn.mn-act-cancel',
    {
      type: 'button',
      'data-nav': true,
      'data-key': 'modes-cancel',
      'data-autofocus': true, // a first visit while searching (the pill, the hero): FIND MATCH is hidden
      onclick: () => {
        menu.cancelSearch();
        render(performance.now());
        if (!touch()) go.focus({ preventScroll: true });
      },
    },
    icon('close'),
    h('span', null, t('search.cancel')),
    h('span.mn-act-keys', { 'aria-hidden': 'true' }, h('span.mn-keys-kb', null, glyph('key-x')), h('span.mn-keys-pad', null, glyph('pad-y'))),
  );
  const practice = h('button.mn-act-practice', { type: 'button', 'data-nav': true, 'data-key': 'modes-practice', onclick: () => host.practiceWhileSearching() }, icon('training'), h('span', null, t('search.whileWaiting'), ' ', h('u', null, t('training.freePlay'))));
  const searching = h(
    'div.mn-act-search',
    { hidden: true, role: 'status' },
    h('div.mn-act-head', null, h('span.mn-act-title', null, h('span.mn-spinner'), t('search.title')), sTag),
    sClock,
    sQueue,
    sWhere,
    bots,
    cancel,
    practice,
    h('span.mn-act-stripe', { 'aria-hidden': 'true' }, h('span.mn-busy')),
  );
  const act = h('section.mn-act', null, idle, searching);
  const el = h('section.mn-modes', { 'data-tablero': true }, side, main, h('div.mn-modes-act', null, act));

  // ---- state ----
  const kindOf = (x: ModeTab): 'casual' | 'ranked' => (x === 'ranked' ? 'ranked' : 'casual');
  const banLeft = (): number => (acc.signedIn ? (acc.me?.rankedBanUntil ?? 0) - Date.now() : 0);
  const modesFor = (kind: 'casual' | 'ranked'): GameMode[] => (kind === 'ranked' ? menu.prefs.rankedModes : menu.prefs.casualModes);
  /** A region's name: the queue's own, else the automatic one; "Automatic" before the server said which. */
  const regionText = (id: RegionId | null): string => {
    const r = id ?? menu.regionId;
    return r !== null ? regionName(r) : t('common.regionAuto');
  };
  const kindName = (kind: 'casual' | 'ranked'): string => t(kind === 'ranked' ? 'modes.ranked' : 'modes.casual');
  const searchView = (): SearchView => host.searchView();
  const runningKind = (v: SearchView): 'casual' | 'ranked' | null => (v.active ? v.kind : null);
  const state = (): ActionKind => actionKind({ tab, signedIn: acc.signedIn, banLeft: banLeft(), searching: runningKind(searchView()) });

  /** Search `kind` with its playlists (a running one of another queue is replaced: Game.menuSearch). */
  const search = (kind: 'casual' | 'ranked'): void => {
    const modes = modesOf(formatOf(modesFor(kind)));
    menu.beforeMatch(() => menu.startSearch({ kind, modes, region: menu.prefs.region, net: kind === 'ranked' ? 'server' : queueNet(menu.prefs.net) }));
  };

  const pickFormat = (f: Format): void => {
    const kind = kindOf(tab);
    const modes = modesOf(f);
    if (kind === 'ranked') menu.prefs.rankedModes = modes;
    else menu.prefs.casualModes = modes;
    menu.savePrefs();
    const s = state();
    if (s === 'signIn' || s === 'banned') return render(performance.now());
    // The same format searching already: nothing to restart.
    const v = searchView();
    if (v.active && v.kind === kind && formatOf(v.modes) === f) return render(performance.now());
    search(kind);
    render(performance.now());
  };

  const primary = (): void => {
    switch (state()) {
      case 'search':
        search(kindOf(tab));
        break;
      case 'signIn':
        waitSignIn = true;
        menu.open('profile');
        return;
      case 'banned':
        tab = 'casual';
        search('casual');
        break;
      case 'play':
        menu.beforeMatch(() => host.playFriendly(aiMode, aiDifficulty));
        return;
      case 'lobbies':
        void createAndShare(menu); // in a lobby: its screen
        return;
      case 'searching':
        break;
    }
    render(performance.now());
  };

  /** Advanced › Connection: a sheet of the three, the current one marked and focused. */
  const openNet = (): void => {
    let close = (): void => undefined;
    const option = (n: NetPick): HTMLButtonElement => {
      const on = menu.prefs.net === n;
      return h(
        `button.mn-btn.mn-sheet-option.mn-net-option${on ? '.mn-sheet-option-on' : ''}` as 'button',
        {
          type: 'button',
          'data-nav': true,
          'data-autofocus': on,
          'aria-current': on ? 'true' : undefined,
          onclick: () => {
            menu.prefs.net = n;
            menu.savePrefs();
            close();
            render(performance.now());
          },
        },
        on ? icon('check') : null,
        h('span.mn-net-text', null, h('b', null, t(NET_LABEL[n])), h('small', null, t(NET_HELP[n]))),
      );
    };
    close = menu.modal({ title: t('modes.connection'), body: h('div.mn-sheet-list', null, ...NET_PICKS.map(option)), actions: [{ label: t('lang.cancel'), onClick: () => true }] });
  };

  /** Switch to `id` (a tab's press, Q / E, LB / RB). The focus follows to the new tab when it was on the tabs, else to its action. */
  const pick = (id: ModeTab): void => {
    const onTabs = tabList.contains(document.activeElement);
    const changed = id !== tab;
    tab = id;
    render(performance.now());
    if (changed) {
      if (tab === 'lobbies') lobbies.show();
      menu.refit();
    }
    if (touch()) return;
    if (onTabs) tabEls.get(id)?.el.focus({ preventScroll: true });
    else if (changed) go.focus({ preventScroll: true });
  };

  // ---- render: only what changed ----
  let lastTab: ModeTab | null = null;
  let lastState: ActionKind | null = null;
  const render = (now: number): void => {
    const v = searchView();
    const running = runningKind(v);
    const s = state();
    const casualLike = tab === 'casual' || tab === 'ranked';
    if (tab !== lastTab) {
      lastTab = tab;
      for (const [id, x] of tabEls) {
        const on = id === tab;
        x.el.classList.toggle('mn-tab-on', on);
        x.el.setAttribute('aria-selected', String(on));
      }
      el.dataset.tab = tab;
      setText(title, t(TAB_TITLE[tab]));
      setText(intro, t(TAB_INTRO[tab]));
      setHidden(queuePart, !casualLike);
      setHidden(advanced.el, tab !== 'casual');
      setHidden(lobbiesPart, tab !== 'lobbies');
      setHidden(aiPart, tab !== 'ai');
    }
    // The tabs' second lines: Competitive's lock for a guest, a ban's time; the searching tab's clock.
    for (const [id, x] of tabEls) {
      const lockText = id === 'ranked' && !acc.signedIn ? t('modes.rankedLocked') : '';
      const subKey: Key = id === 'casual' ? 'modes.casualSubShort' : id === 'ranked' ? 'modes.rankedSubShort' : id === 'lobbies' ? 'modes.tabLobbiesSub' : 'modes.tabAiSub';
      setText(x.sub, lockText !== '' ? lockText : t(subKey));
      const busy = running !== null && running === id;
      const endKey = busy ? 'busy' : lockText !== '' || (id === 'ranked' && banLeft() > 0) ? 'lock' : '';
      if (x.end.dataset.kind !== endKey) {
        x.end.dataset.kind = endKey;
        setChildren(x.end, endKey === 'busy' ? h('span.mn-spinner') : null, endKey === 'busy' ? h('span.mn-mtab-clock') : endKey === 'lock' ? icon('lock') : null);
      }
      if (busy) setText(x.end.lastElementChild as HTMLElement, clock(now - v.since));
    }
    if (casualLike) {
      const kind = kindOf(tab);
      const picked = formatOf(modesFor(kind));
      const searchingHere = running === kind;
      const searchingFormat = searchingHere ? formatOf(v.modes) : null;
      for (const [f, x] of formatEls) {
        const pressed = String(f === picked);
        if (x.el.getAttribute('aria-pressed') !== pressed) x.el.setAttribute('aria-pressed', pressed);
        const tagKey = f === searchingFormat ? 'busy' : f === 'any' ? 'any' : '';
        if (x.tag.dataset.kind !== tagKey) {
          x.tag.dataset.kind = tagKey;
          setChildren(x.tag, tagKey === 'busy' ? slot(t('home.searching'), { ink: true }) : tagKey === 'any' ? slot(t('format.fastest'), { drop: true }) : null);
        }
        let sub = f === 'any' ? t('format.anySub') : '';
        if (kind === 'ranked' && f !== 'any') {
          const r = acc.me?.ratings.find((x2) => x2.playlist === f);
          const tier = r ? tierById(r.tier) : null;
          sub = r ? (r.placementLeft > 0 ? t('play.placement', { games: r.games, total: r.games + r.placementLeft }) : tier ? tierName(tier) : '') : '';
        }
        setText(x.sub, sub);
        setHidden(x.sub, sub === '');
      }
      setHidden(note, !searchingHere);
      region.set(menu.regionLabel);
      advanced.set(t('modes.connectionValue', { net: t(NET_LABEL[menu.prefs.net]) }));
    }
    if (tab === 'ai') {
      modeSeg.refresh();
      diffSeg.refresh();
      stadium.set(themeName(host.theme));
    }
    // The action zone.
    const isSearching = s === 'searching';
    if (s !== lastState) {
      lastState = s;
      const lost = act.contains(document.activeElement) && (document.activeElement as HTMLElement).closest('[hidden]') === null;
      setHidden(idle, isSearching);
      setHidden(searching, !isSearching);
      act.classList.toggle('mn-act-on', isSearching);
      // The focus that was in the zone stays in it (FIND MATCH <-> CANCEL SEARCH).
      if (lost && !touch()) (isSearching ? cancel : go).focus({ preventScroll: true });
      menu.refit();
    }
    if (isSearching) {
      const kind = v.kind ?? 'casual';
      const f = formatOf(v.modes);
      if (sTag.dataset.kind !== kind) {
        sTag.dataset.kind = kind;
        setChildren(sTag, slot(t(kind === 'ranked' ? 'search.rankedTag' : 'search.unranked')));
      }
      setText(sClock, clock(now - v.since));
      setText(sQueue, `${kindName(kind)} · ${formatName(f)}`);
      const playing = menu.population?.playing ?? null;
      const where = t('search.where', { format: formatWords(f), region: regionText(v.region) });
      setText(sWhere, countShown(playing, PLAYING_SHOWN) ? `${where} · ${t('menu.playing', { count: playing ?? 0 })}` : where);
      const net = kind === 'ranked' ? 'server' : queueNet(menu.prefs.net);
      const left = botsCountdown({ kind, net: v.net ?? net, since: v.since, now, botFillMs: menu.cfg?.botFillMs ?? null, p2pFillMs: P2P_FILL_WAIT_MS });
      setHidden(bots, left === null);
      if (left !== null) {
        setText(botsTime, clock(left.left + 999));
        const on = botsSegments(left.left, left.total, SEGMENTS);
        botsBar.childNodes.forEach((n, i) => (n as HTMLElement).classList.toggle('on', i < on));
      }
    } else {
      let sum: string;
      let lineText: string;
      let label: string;
      const kind = kindOf(tab);
      const queue = `${kindName(kind)} · ${formatName(formatOf(modesFor(kind)))} · ${regionText(menu.prefs.region)}`;
      switch (s) {
        case 'signIn':
          sum = t('search.needsAccount');
          lineText = '';
          label = t('search.signIn');
          break;
        case 'banned':
          sum = t('search.banned', { time: duration(banLeft()) });
          lineText = t('search.bannedLine');
          label = t('search.playCasual');
          break;
        case 'play':
          sum = `${t('modes.vsAi')} · ${aiMode} · ${difficultyName(aiDifficulty)}`;
          lineText = t('modes.vsAiSub');
          label = t('friendly.play');
          break;
        case 'lobbies': {
          const code = host.lobby.inLobby ? (host.lobby.state?.code ?? host.lobby.code) : null;
          sum = t('modes.lobbies');
          lineText = code !== null ? '' : t('modes.lobbiesAction');
          label = code !== null ? t('lobby.backTo', { code: spacedCode(code) }) : t('lobby.createShare');
          break;
        }
        default:
          sum = queue;
          lineText = kind === 'ranked' ? t('modes.rankedSub') : t('search.always');
          label = t('search.find');
      }
      setText(summary, sum);
      setText(line, lineText);
      setHidden(line, lineText === '');
      setText(goLabel, label);
    }
  };

  // A sign-in on PERFIL (Competitive's SIGN IN): back here, FIND MATCH focused (the same control, data-key).
  acc.subscribe(() => {
    if (!waitSignIn || !acc.signedIn) return;
    waitSignIn = false;
    if (menu.top()?.id === 'profile') menu.back();
  });

  const command = (c: MenuCommand): boolean => {
    if (c !== 'prev' && c !== 'next' && c !== 'tabPrev' && c !== 'tabNext') return false;
    pick(stepTab(tab, c === 'prev' || c === 'tabPrev' ? -1 : 1));
    return true;
  };

  return {
    id: 'modes',
    title: t('nav.modes'),
    el,
    tabsVerb: 'nav.tabsModes',
    setTab: (id) => {
      if (isModeTab(id)) tab = id;
    },
    show: () => {
      shown = true;
      aiMode = host.mode;
      aiDifficulty = host.difficulty;
      lastTab = null;
      lastState = null;
      if (tab === 'lobbies') lobbies.show();
      if (acc.signedIn) void acc.fetchMe().then(() => shown && render(performance.now()), () => undefined);
      render(performance.now());
    },
    hide: () => {
      shown = false;
    },
    tick: (now) => {
      render(now);
      if (tab === 'lobbies') lobbies.tick(now);
    },
    command,
  };
}
