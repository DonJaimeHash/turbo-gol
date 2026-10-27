/**
 * The queue screens on Inicio's tiles: Casual (several playlists at once, region, P2P or server),
 * Competitive (accounts only: rank per playlist, placement, abandon ban) and Friendly (offline
 * against the AI). Their FIND MATCH and PLAY start through Menu.beforeMatch (a TV asks for a
 * controller, a new PC player how they will play), and a search started here is the queue JUGAR
 * AHORA repeats (Menu.startSearch). Inicio itself is screens/home.ts; the language picker moved to
 * PERFIL (components/language.ts).
 */
import { h, setChildren, clock } from '../dom';
import { PLAYLISTS } from '../../net/account';
import type { Playlist } from '../../net/account';
import { MODES } from '../../sim/constants';
import type { GameMode } from '../../sim/constants';
import { DIFFICULTIES } from '../../render/Hud';
import type { Difficulty } from '../../render/Hud';
import { THEME_IDS, type ThemeId } from '../../render/theme';
import { t } from '../../i18n';
import { difficultyName, playlistName, themeName, tierName } from '../names';
import { rankBadge, tierById } from '../badges';
import type { Menu, Screen } from '../Menu';
import { cycler, primary, regionCycler, screenHead, section } from './common';

/**
 * Toggle cards for the playlists; at least one stays selected. `extra(p)` builds the per-playlist
 * line, `extraKey(p)` says what it shows (a plain string). `refresh` runs on the menu's tick: the
 * line is built and the DOM written only when a card's state or that key changed.
 */
function playlistPicker(
  get: () => GameMode[],
  set: (m: GameMode[]) => void,
  extraKey: (p: Playlist) => string,
  extra: (p: Playlist) => Node | null,
): { el: HTMLElement; refresh: () => void } {
  // A row (nav.ts): ▼ from any card goes to what is under the row (the Region row), ▲ back to that card.
  const wrap = h('div.mn-playlists', { 'data-nav-row': true });
  const cards = new Map<Playlist, HTMLButtonElement>();
  const shown = new Map<Playlist, string>();
  const refresh = (): void => {
    const sel = get();
    for (const [p, c] of cards) {
      const pressed = String(sel.includes(p));
      if (c.getAttribute('aria-pressed') !== pressed) c.setAttribute('aria-pressed', pressed);
      const slot = c.querySelector('.mn-pl-extra');
      const key = extraKey(p);
      if (slot && shown.get(p) !== key) {
        shown.set(p, key);
        setChildren(slot, extra(p));
      }
    }
  };
  for (const p of PLAYLISTS) {
    const c = h(
      'button.mn-pl',
      { type: 'button', 'data-nav': true, 'data-key': 'playlist-' + p, 'aria-pressed': 'false' },
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

/** The search button: FIND MATCH while idle (`start`), CANCEL while this kind of search runs. */
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
  // On the screen's tick (4 Hz): the label is written only when it changes; toggle() with a force
  // writes nothing when the class is already so.
  const refresh = (): void => {
    const v = menu.host.searchView();
    const text = v.active ? (v.kind === kind ? cancel : cancelOther) : idle;
    if (el.textContent !== text) el.textContent = text;
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
    (p) => (menu.population ? String(menu.population.casual[p]) : ''),
    (p) => (menu.population ? h('span', null, t('play.searching', { count: menu.population.casual[p] })) : null),
  );
  const region = regionCycler(menu);
  const net = cycler<'p2p' | 'server'>(
    t('play.connection'),
    [
      { value: 'p2p', label: t('play.netP2p') },
      { value: 'server', label: t('play.netServer') },
    ],
    () => (menu.prefs.net === 'server' ? 'server' : 'p2p'),
    (v) => {
      menu.prefs.net = v;
      menu.savePrefs();
    },
  );
  const go = searchButton(menu, 'casual', () =>
    menu.beforeMatch(() => menu.startSearch({ kind: 'casual', modes: menu.prefs.casualModes, region: menu.prefs.region, net: menu.prefs.net === 'server' ? 'server' : 'p2p' })),
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
      const waiting = menu.population ? menu.population.ranked[p] : -1;
      return r ? `${waiting}|${r.tier}|${r.placementLeft}|${r.games}|${r.mmr}` : String(waiting);
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
  const go = searchButton(menu, 'ranked', () => menu.beforeMatch(() => menu.startSearch({ kind: 'ranked', modes: menu.prefs.rankedModes, region: menu.prefs.region, net: 'server' })));
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
    // The tick's writes: only what changed (the ban's clock moves once a second).
    const until = acc.me?.rankedBanUntil ?? 0;
    const left = until - Date.now();
    if (ban.hidden !== left <= 0) ban.hidden = left <= 0;
    if (left > 0) {
      const text = t('play.rankedBan', { time: clock(left) });
      if (ban.textContent !== text) ban.textContent = text;
    }
    const disabled = left > 0 && !menu.host.searchView().active;
    if (go.el.disabled !== disabled) go.el.disabled = disabled;
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
    h('div.mn-actions', null, primary(t('friendly.play'), () => menu.beforeMatch(() => menu.host.playFriendly(mode, difficulty)), { 'data-autofocus': true })),
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
