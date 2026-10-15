/**
 * Home, the Play hub and the queue screens: Casual (several playlists at once, region, P2P or
 * server), Competitive (accounts only: rank per playlist, placement, abandon ban) and Friendly
 * (offline against the AI). Play -> Casual / Competitive / Custom lobbies / Friendly; Training
 * lives next to Play.
 */
import { h, setChildren, clock } from '../dom';
import { PLAYLISTS, PLAYLIST_NAMES } from '../../net/account';
import type { Playlist } from '../../net/account';
import { MODES } from '../../sim/constants';
import type { GameMode } from '../../sim/constants';
import { DIFFICULTIES } from '../../render/Hud';
import type { Difficulty } from '../../render/Hud';
import { rankBadge, ratingCard, tierById } from '../badges';
import type { Menu, Screen } from '../Menu';
import { cycler, primary, regionCycler, screenHead, secondary, section, tile } from './common';

const DIFFICULTY_LABELS: Readonly<Record<Difficulty, string>> = { easy: 'Fácil', medium: 'Normal', hard: 'Difícil' };

export function homeScreen(menu: Menu): Screen {
  const side = h('aside.mn-home-side');
  const el = h(
    'div.mn-home',
    null,
    h(
      'div.mn-home-tiles',
      null,
      tile('mn-tile-hero', '▶', 'JUGAR', 'Casual · Competitivo · Salas · Amistoso', () => menu.open('play'), null),
      tile('', '◎', 'ENTRENAMIENTO', 'Práctica libre y packs de tiros', () => menu.open('training')),
      tile('', '▲', 'CLASIFICACIÓN', 'Los mejores de la temporada', () => menu.open('leaderboard')),
      tile('', '◆', 'PERFIL', 'Cuenta, rangos y estadísticas', () => menu.open('profile')),
      tile('', '⚙', 'CONFIGURACIÓN', 'Controles, cámara y gráficos', () => menu.host.openSettings(() => menu.refocus())),
    ),
    side,
  );
  const render = (): void => {
    const acc = menu.host.accounts;
    if (acc.signedIn && acc.me) {
      setChildren(side, h('div.mn-side-title', null, `Temporada ${acc.me.season}`), ...acc.me.ratings.map((r) => ratingCard(r)));
    } else if (acc.signedIn) {
      setChildren(side, h('div.mn-side-title', null, 'Cargando tu perfil…'));
    } else {
      setChildren(
        side,
        h('div.mn-side-title', null, 'Jugá Competitivo'),
        h('p.mn-side-text', null, `Creá una cuenta para tener tu rango en ${PLAYLIST_NAMES['1v1']}, ${PLAYLIST_NAMES['2v2']} y ${PLAYLIST_NAMES['3v3']}. Como invitado podés jugar Casual, salas y entrenamiento.`),
        secondary('INICIAR SESIÓN / CREAR CUENTA', () => menu.open('profile')),
      );
    }
  };
  return {
    id: 'home',
    title: 'Inicio',
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
  const el = h(
    'div.mn-play',
    null,
    screenHead('JUGAR'),
    h(
      'div.mn-play-tiles',
      null,
      tile('mn-tile-casual', '◐', 'CASUAL', 'Sin rango · P2P o servidor', () => menu.open('casual'), casualSub),
      tile('mn-tile-ranked', '★', 'COMPETITIVO', 'Rango por playlist · servidor', () => menu.open('ranked'), rankedTag),
      tile('mn-tile-custom', '⌂', 'PARTIDAS PERSONALIZADAS', 'Salas públicas y privadas', () => menu.open('custom'), customSub),
      tile('mn-tile-offline', '◇', 'AMISTOSO', 'Offline contra la IA', () => menu.open('friendly')),
    ),
    h('div.mn-play-foot', null, rankedSub),
  );
  const tick = (): void => {
    const p = menu.population;
    const sum = (r: Record<Playlist, number>): number => r['1v1'] + r['2v2'] + r['3v3'];
    casualSub.textContent = p ? `${sum(p.casual)} buscando` : '';
    customSub.textContent = p ? `${p.lobbies} salas` : '';
    rankedTag.textContent = menu.host.accounts.signedIn ? (p ? `${sum(p.ranked)} buscando` : '') : '🔒 Cuenta';
    rankedSub.textContent = p ? `${menu.regionLabel} · ${p.playing} jugando ahora` : '';
  };
  return { id: 'play', title: 'Jugar', el, show: tick, tick };
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
      h('span.mn-pl-name', null, PLAYLIST_NAMES[p]),
      h('span.mn-pl-size', null, `${p} · ${MODES[p] * 2} autos`),
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

/** The search button: BUSCAR while idle, CANCELAR while this kind of search runs. */
function searchButton(menu: Menu, kind: 'casual' | 'ranked', start: () => void): { el: HTMLButtonElement; refresh: () => void } {
  const el = primary('BUSCAR PARTIDA', () => {
    const v = menu.host.searchView();
    if (v.active) menu.host.cancelSearch();
    else start();
    refresh();
  });
  const refresh = (): void => {
    const v = menu.host.searchView();
    el.textContent = v.active ? (v.kind === kind ? 'CANCELAR BÚSQUEDA' : 'CANCELAR LA OTRA BÚSQUEDA') : 'BUSCAR PARTIDA';
    el.classList.toggle('mn-btn-cancel', v.active);
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
    (p) => (menu.population ? h('span', null, `${menu.population.casual[p]} buscando`) : null),
  );
  const region = regionCycler(menu);
  const net = cycler<'p2p' | 'server'>(
    'Conexión',
    [
      { value: 'p2p', label: 'P2P (recomendada)' },
      { value: 'server', label: 'Servidor' },
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
    screenHead('CASUAL', 'Partidas rápidas sin rango. Elegí una o varias playlists: entrás en la primera que arme partido.'),
    section('PLAYLISTS', picker.el),
    section('OPCIONES', region.el, net.el, h('p.mn-note', null, 'P2P: los autos se sincronizan entre ustedes (menos lag en la misma región). Si nadie más busca, jugás contra bots en un servidor.')),
    h('div.mn-actions', null, go.el),
  );
  return {
    id: 'casual',
    title: 'Casual',
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
      const waiting = menu.population ? `${menu.population.ranked[p]} buscando` : '';
      if (!r) return h('span', null, waiting);
      const tier = tierById(r.tier);
      return h(
        'span.mn-pl-rank',
        null,
        rankBadge(tier, 34),
        h('span', null, h('b', null, r.placementLeft > 0 ? 'Sin clasificar' : (tier?.name ?? '')), h('small', null, r.placementLeft > 0 ? `Clasificación ${r.games}/${r.games + r.placementLeft}` : `${r.mmr} MMR`), h('small', null, waiting)),
      );
    },
  );
  const region = regionCycler(menu);
  const go = searchButton(menu, 'ranked', () => menu.host.search({ kind: 'ranked', modes: menu.prefs.rankedModes, region: menu.prefs.region, net: 'server' }));
  const signedInView = h(
    'div',
    null,
    ban,
    section('PLAYLISTS', picker.el),
    section('OPCIONES', region.el, h('p.mn-note', null, 'Competitivo se juega en servidor con autoridad. Las primeras 5 partidas de cada playlist son de clasificación. Abandonar una partida cuenta como derrota y bloquea Competitivo (5 min, 15 min, 1 h, 24 h).')),
    h('div.mn-actions', null, go.el),
  );
  const guestView = h(
    'div.mn-locked',
    null,
    h('div.mn-locked-icon', { 'aria-hidden': 'true' }, '🔒'),
    h('div.mn-locked-title', null, 'Competitivo necesita una cuenta'),
    h('p', null, 'Los invitados no tienen rango. Creá una cuenta gratis (usuario y contraseña, o Google / Discord si están habilitados) y empezá tus partidas de clasificación.'),
    h('div.mn-actions', null, primary('INICIAR SESIÓN / CREAR CUENTA', () => menu.open('profile'))),
  );
  const el = h('div.mn-queue', null, screenHead('COMPETITIVO', 'Un rango por playlist. El MMR sube o baja según a quién le ganás.'), body);
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
    if (left > 0) ban.textContent = `Competitivo bloqueado por abandonar partidas: ${clock(left)}`;
    go.el.disabled = left > 0 && !menu.host.searchView().active;
  };
  return {
    id: 'ranked',
    title: 'Competitivo',
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
    'Modo',
    PLAYLISTS.map((p) => ({ value: p, label: `${PLAYLIST_NAMES[p]} (${p})` })),
    () => mode,
    (v) => (mode = v),
  );
  const diffC = cycler<Difficulty>(
    'Dificultad de la IA',
    DIFFICULTIES.map((d) => ({ value: d, label: DIFFICULTY_LABELS[d] })),
    () => difficulty,
    (v) => (difficulty = v),
  );
  const quality = cycler<0 | 1>(
    'Calidad gráfica',
    [
      { value: 1, label: 'Alta' },
      { value: 0, label: 'Rendimiento' },
    ],
    () => menu.host.quality,
    (v) => menu.host.setQuality(v),
  );
  const el = h(
    'div.mn-queue',
    null,
    screenHead('AMISTOSO', 'Un partido offline de 5 minutos contra la IA. Tus compañeros, si los hay, también son bots.'),
    section('PARTIDO', modeC.el, diffC.el, quality.el),
    h('div.mn-actions', null, primary('JUGAR', () => menu.host.playFriendly(mode, difficulty), { 'data-autofocus': true })),
  );
  return {
    id: 'friendly',
    title: 'Amistoso',
    el,
    show: () => {
      mode = menu.host.mode;
      difficulty = menu.host.difficulty;
      modeC.refresh();
      diffC.refresh();
      quality.refresh();
    },
  };
}
