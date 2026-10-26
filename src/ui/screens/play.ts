/**
 * Home, the Play hub and the queue screens: Casual (several playlists at once, region, P2P or
 * server), Competitive (accounts only: rank per playlist, placement, abandon ban) and Friendly
 * (offline against the AI). Play -> Casual / Competitive / Custom lobbies / Friendly; Training
 * lives next to Play. The home screen also holds the language picker (src/i18n.ts).
 */
import { h, setChildren, clock } from '../dom';
import { PLAYLISTS } from '../../net/account';
import type { Playlist } from '../../net/account';
import { MODES } from '../../sim/constants';
import type { GameMode } from '../../sim/constants';
import { DIFFICULTIES } from '../../render/Hud';
import type { Difficulty } from '../../render/Hud';
import { THEME_IDS, type ThemeId } from '../../render/theme';
import { LOCALES, language, savedLanguage, setLanguage, systemLanguage, t } from '../../i18n';
import type { LanguageCode } from '../../i18n';
import { difficultyName, playlistName, themeName, tierName } from '../names';
import { rankBadge, ratingCard, tierById } from '../badges';
import type { Menu, Screen } from '../Menu';
import { cycler, primary, regionCycler, screenHead, secondary, section, tile } from './common';

/**
 * The language list: automatic (the system's language) first, then every shipped language by its
 * own name; the saved choice is marked. A change reloads the page (setLanguage), which would drop
 * a search or a lobby, so then the picker only explains why.
 */
function openLanguagePicker(menu: Menu): void {
  const busy = (): boolean => menu.host.searchView().active || menu.host.lobby.inLobby;
  if (busy()) {
    menu.toast(t('lang.busy'));
    return;
  }
  const saved = savedLanguage();
  let close = (): void => undefined;
  const choose = (code: LanguageCode | null): void => {
    if (code === saved) close();
    else if (busy()) {
      close();
      menu.toast(t('lang.busy'));
    } else setLanguage(code);
  };
  const option = (code: LanguageCode | null, label: string): HTMLButtonElement => {
    const on = code === saved;
    return h(
      `button.mn-btn${on ? '.mn-btn-primary' : ''}` as 'button',
      { type: 'button', 'data-nav': true, 'data-autofocus': on, 'aria-current': on ? 'true' : undefined, lang: code ?? undefined, onclick: () => choose(code) },
      on ? h('span', { 'aria-hidden': 'true' }, '✓ ') : null,
      label,
    );
  };
  const codes = Object.keys(LOCALES) as LanguageCode[];
  close = menu.modal({
    title: t('lang.title'),
    body: h('div.mn-oauth.mn-lang-list', null, option(null, t('lang.auto', { language: LOCALES[systemLanguage()].name })), ...codes.map((c) => option(c, LOCALES[c].name))),
    actions: [{ label: t('lang.cancel'), onClick: () => true }],
  });
}

export function homeScreen(menu: Menu): Screen {
  const side = h('aside.mn-home-side');
  const el = h(
    'div.mn-home',
    null,
    h(
      'div.mn-home-tiles',
      null,
      tile('mn-tile-hero', 'play', t('home.play'), t('home.playSub'), () => menu.open('play'), null),
      tile('', 'training', t('home.training'), t('home.trainingSub'), () => menu.open('training')),
      tile('', 'leaderboard', t('home.leaderboard'), t('home.leaderboardSub'), () => menu.open('leaderboard')),
      tile('', 'profile', t('home.profile'), t('home.profileSub'), () => menu.open('profile')),
      tile('', 'settings', t('home.settings'), t('home.settingsSub'), () => menu.host.openSettings(() => menu.refocus())),
      // Static: render() rebuilds only `side`, so keyboard / controller focus here survives a refresh.
      tile('mn-tile-lang', 'globe', t('home.language'), LOCALES[language()].name, () => openLanguagePicker(menu)),
    ),
    side,
  );
  const render = (): void => {
    const acc = menu.host.accounts;
    if (acc.signedIn && acc.me) {
      setChildren(side, h('div.mn-side-title', null, t('home.season', { season: acc.me.season })), ...acc.me.ratings.map((r) => ratingCard(r)));
    } else if (acc.signedIn) {
      setChildren(side, h('div.mn-side-title', null, t('home.loadingProfile')));
    } else {
      setChildren(
        side,
        h('div.mn-side-title', null, t('home.guestTitle')),
        h('p.mn-side-text', null, t('home.guestText', { playlist1: playlistName('1v1'), playlist2: playlistName('2v2'), playlist3: playlistName('3v3') })),
        secondary(t('home.signIn'), () => menu.open('profile')),
      );
    }
  };
  return {
    id: 'home',
    title: t('home.title'),
    el,
    show: () => {
      render();
      if (menu.host.accounts.signedIn) void menu.host.accounts.fetchMe().then(render, () => undefined);
    },
  };
}

export function playScreen(menu: Menu): Screen {
  const casualSub = h('span');
  const rankedSub = h('span');
  const customSub = h('span');
  const rankedTag = h('span');
  const locked = t('play.accountLocked');
  const el = h(
    'div.mn-play',
    null,
    screenHead(t('home.play')),
    h(
      'div.mn-play-tiles',
      null,
      tile('mn-tile-casual', 'ball', t('play.casual'), t('play.casualSub'), () => menu.open('casual'), casualSub),
      tile('mn-tile-ranked', 'trophy', t('play.ranked'), t('play.rankedSub'), () => menu.open('ranked'), rankedTag),
      tile('mn-tile-custom', 'friends', t('play.custom'), t('play.customSub'), () => menu.open('custom'), customSub),
      tile('mn-tile-offline', 'bot', t('play.friendly'), t('play.friendlySub'), () => menu.open('friendly')),
    ),
    h('div.mn-play-foot', null, rankedSub),
  );
  const tick = (): void => {
    const p = menu.population;
    const sum = (r: Record<Playlist, number>): number => r['1v1'] + r['2v2'] + r['3v3'];
    casualSub.textContent = p ? t('play.searching', { count: sum(p.casual) }) : '';
    customSub.textContent = p ? t('play.lobbies', { count: p.lobbies }) : '';
    rankedTag.textContent = menu.host.accounts.signedIn ? (p ? t('play.searching', { count: sum(p.ranked) }) : '') : locked;
    rankedSub.textContent = p ? t('play.playingNow', { region: menu.regionLabel, count: p.playing }) : '';
  };
  return { id: 'play', title: t('play.title'), el, show: tick, tick };
}

/** Toggle cards for the playlists; at least one stays selected. `extra(p)` adds the per-playlist line. */
function playlistPicker(get: () => GameMode[], set: (m: GameMode[]) => void, extra: (p: Playlist) => Node | null): { el: HTMLElement; refresh: () => void } {
  const wrap = h('div.mn-playlists');
  const cards = new Map<Playlist, HTMLButtonElement>();
  const refresh = (): void => {
    const sel = get();
    for (const [p, c] of cards) {
      c.setAttribute('aria-pressed', String(sel.includes(p)));
      const slot = c.querySelector('.mn-pl-extra');
      if (slot) setChildren(slot, extra(p));
    }
  };
  for (const p of PLAYLISTS) {
    const c = h(
      'button.mn-pl',
      { type: 'button', 'data-nav': true, 'aria-pressed': 'false' },
      h('span.mn-pl-check', { 'aria-hidden': 'true' }),
      h('span.mn-pl-name', null, playlistName(p)),
      h('span.mn-pl-size', null, t('play.playlistCars', { playlist: p, count: MODES[p] * 2 })),
      h('span.mn-pl-extra'),
    );
    c.addEventListener('click', () => {
      const sel = get();
      const next = sel.includes(p) ? sel.filter((x) => x !== p) : [...sel, p];
      if (next.length === 0) return; // one playlist at least
      set(PLAYLISTS.filter((x) => next.includes(x)));
      refresh();
    });
    cards.set(p, c);
    wrap.appendChild(c);
  }
  return { el: wrap, refresh };
}

/** The search button: FIND MATCH while idle, CANCEL while this kind of search runs. */
function searchButton(menu: Menu, kind: 'casual' | 'ranked', start: () => void): { el: HTMLButtonElement; refresh: () => void } {
  const idle = t('play.search');
  const cancel = t('play.cancelSearch');
  const cancelOther = t('play.cancelOtherSearch');
  const el = primary(idle, () => {
    const v = menu.host.searchView();
    if (v.active) menu.host.cancelSearch();
    else start();
    refresh();
  });
  const refresh = (): void => {
    const v = menu.host.searchView();
    el.textContent = v.active ? (v.kind === kind ? cancel : cancelOther) : idle;
    // CANCEL is no lime primary (its hover / pressed lime would outrank the red and leave white text
    // on lime, menu.css); FIND MATCH is again.
    el.classList.toggle('mn-btn-cancel', v.active);
    el.classList.toggle('mn-btn-primary', !v.active);
  };
  return { el, refresh };
}

export function casualScreen(menu: Menu): Screen {
  const picker = playlistPicker(
    () => menu.prefs.casualModes,
    (m) => {
      menu.prefs.casualModes = m;
      menu.savePrefs();
    },
    (p) => (menu.population ? h('span', null, t('play.searching', { count: menu.population.casual[p] })) : null),
  );
  const region = regionCycler(menu);
  const net = cycler<'p2p' | 'server'>(
    t('play.connection'),
    [
      { value: 'p2p', label: t('play.netP2p') },
      { value: 'server', label: t('play.netServer') },
    ],
    () => menu.prefs.net,
    (v) => {
      menu.prefs.net = v;
      menu.savePrefs();
    },
  );
  const go = searchButton(menu, 'casual', () =>
    menu.host.search({ kind: 'casual', modes: menu.prefs.casualModes, region: menu.prefs.region, net: menu.prefs.net }),
  );
  const el = h(
    'div.mn-queue',
    null,
    screenHead(t('play.casual'), t('play.casualIntro')),
    section(t('play.playlists'), picker.el),
    section(t('play.options'), region.el, net.el, h('p.mn-note', null, t('play.casualNote'))),
    h('div.mn-actions', null, go.el),
  );
  return {
    id: 'casual',
    title: t('play.casualTitle'),
    el,
    show: () => {
      picker.refresh();
      region.refresh();
      net.refresh();
      go.refresh();
    },
    tick: () => {
      picker.refresh();
      go.refresh();
    },
  };
}

export function rankedScreen(menu: Menu): Screen {
  const acc = menu.host.accounts;
  const body = h('div.mn-ranked-body');
  const ban = h('div.mn-ban', { hidden: true });
  const picker = playlistPicker(
    () => menu.prefs.rankedModes,
    (m) => {
      menu.prefs.rankedModes = m;
      menu.savePrefs();
    },
    (p) => {
      const r = acc.me?.ratings.find((x) => x.playlist === p);
      const waiting = menu.population ? t('play.searching', { count: menu.population.ranked[p] }) : '';
      if (!r) return h('span', null, waiting);
      const tier = tierById(r.tier);
      return h(
        'span.mn-pl-rank',
        null,
        rankBadge(tier, 34),
        h(
          'span',
          null,
          h('b', null, r.placementLeft > 0 ? t('play.unranked') : tier ? tierName(tier) : ''),
          h('small', null, r.placementLeft > 0 ? t('play.placement', { games: r.games, total: r.games + r.placementLeft }) : t('play.mmr', { mmr: r.mmr })),
          h('small', null, waiting),
        ),
      );
    },
  );
  const region = regionCycler(menu);
  const go = searchButton(menu, 'ranked', () => menu.host.search({ kind: 'ranked', modes: menu.prefs.rankedModes, region: menu.prefs.region, net: 'server' }));
  const signedInView = h(
    'div',
    null,
    ban,
    section(t('play.playlists'), picker.el),
    section(t('play.options'), region.el, h('p.mn-note', null, t('play.rankedNote'))),
    h('div.mn-actions', null, go.el),
  );
  const guestView = h(
    'div.mn-locked',
    null,
    h('div.mn-locked-icon', { 'aria-hidden': 'true' }, '🔒'),
    h('div.mn-locked-title', null, t('play.rankedNeedsAccount')),
    h('p', null, t('play.rankedGuestText')),
    h('div.mn-actions', null, primary(t('home.signIn'), () => menu.open('profile'))),
  );
  const el = h('div.mn-queue', null, screenHead(t('play.ranked'), t('play.rankedIntro')), body);
  let lastSigned: boolean | null = null;
  const render = (): void => {
    const signed = acc.signedIn;
    if (signed !== lastSigned) {
      setChildren(body, signed ? signedInView : guestView);
      lastSigned = signed;
      menu.refocus();
    }
    if (!signed) return;
    picker.refresh();
    go.refresh();
    const until = acc.me?.rankedBanUntil ?? 0;
    const left = until - Date.now();
    ban.hidden = left <= 0;
    if (left > 0) ban.textContent = t('play.rankedBan', { time: clock(left) });
    go.el.disabled = left > 0 && !menu.host.searchView().active;
  };
  return {
    id: 'ranked',
    title: t('play.rankedTitle'),
    el,
    show: () => {
      lastSigned = null;
      region.refresh();
      render();
      if (acc.signedIn) void acc.fetchMe().then(render, () => undefined);
    },
    tick: render,
  };
}

export function friendlyScreen(menu: Menu): Screen {
  let mode: GameMode = menu.host.mode;
  let difficulty: Difficulty = menu.host.difficulty;
  const modeC = cycler<GameMode>(
    t('friendly.mode'),
    PLAYLISTS.map((p) => ({ value: p, label: `${playlistName(p)} (${p})` })),
    () => mode,
    (v) => (mode = v),
  );
  const diffC = cycler<Difficulty>(
    t('friendly.difficulty'),
    DIFFICULTIES.map((d) => ({ value: d, label: difficultyName(d) })),
    () => difficulty,
    (v) => (difficulty = v),
  );
  // The stadium (purely visual, saved with the prefs; the graphics quality lives in Settings >
  // Graphics): the switch runs behind the loading screen (Game.switchTheme rewrites uniforms and
  // re-bakes or reads the cached sky, it never recompiles).
  const theme = cycler<ThemeId>(
    t('friendly.theme'),
    THEME_IDS.map((id) => ({ value: id, label: themeName(id) })),
    () => menu.host.theme,
    (v) => menu.host.setTheme(v),
  );
  const el = h(
    'div.mn-queue',
    null,
    screenHead(t('play.friendly'), t('friendly.intro')),
    section(t('friendly.match'), modeC.el, diffC.el, theme.el),
    h('div.mn-actions', null, primary(t('friendly.play'), () => menu.host.playFriendly(mode, difficulty), { 'data-autofocus': true })),
  );
  return {
    id: 'friendly',
    title: t('friendly.title'),
    el,
    show: () => {
      mode = menu.host.mode;
      difficulty = menu.host.difficulty;
      modeC.refresh();
      diffC.refresh();
      theme.refresh();
    },
  };
}
