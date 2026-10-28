/**
 * JUGAR's root, Inicio (plan §1.4 "JUGAR (Inicio)", PR 5; the owner's artboards): the player plate
 * (who you are · GARAJE · Dune), then a row of tiles anchored at the bottom over the live stadium:
 * the hero, JUGAR AHORA (JUGAR on a TV), which plays the last queue in one press (Casual 2v2 the
 * first time: homeModel.ts heroQueue), and the four modes, CASUAL, CON AMIGOS, CONTRA LA IA and
 * COMPETITIVO (a guest sees "Iniciar sesión" on its lock), each opening MODOS on its tab
 * (screens/modes.ts). One DOM order on every device; the CSS grid moves the tiles
 * (styles/screens/home.css): the hero at the left on a PC and a TV, at the right on a phone held
 * sideways (the thumb), on top upright.
 *
 * The hero follows the player (homeModel.ts heroState): RELOAD NOW after a refused version, back
 * to your match (PR 12), back to the lobby, the running search (its clock and ✕ CANCEL), VS AI
 * when offline, else JUGAR AHORA. A TV without a controller says so in the hero's slot, and a
 * match's start asks for one first (Menu.beforeMatch); so does "How will you play?" on a new PC.
 * The hero renders on a change only (the tick builds a key: 4 Hz, 1 Hz on super low; the Menu
 * ticks it at once when a search starts or ends), its clock on a new second, its name for a
 * screen reader on a state change, never with the clock. The plate and COMPETITIVO's lock follow
 * the account on their own keys; the profile is fetched as the screen shows (the plate's rank,
 * the ban, the chip's rank), and once more when a session restored after that.
 *
 * In development (or a VITE_UI_FIT=1 build) window.__homeHero(kind | null, { pad, ranked }) forces
 * a hero state with sample data for the layout check (scripts/ui-fit.mjs).
 */
import { h, clock } from '../dom';
import { t } from '../../i18n';
import { PLAYLISTS, isRegion } from '../../net/account';
import type { RegionId } from '../../net/account';
import { MODES } from '../../sim/constants';
import { rejoinLeftMs } from '../../game/rejoinStore';
import type { GameMode } from '../../sim/constants';
import type { Menu, Screen } from '../Menu';
import { heroTile, modeTile, slot } from '../components/tile';
import type { HeroSub, HeroView } from '../components/tile';
import { plate as createPlate } from '../components/plate';
import { rankBadge, tierById } from '../badges';
import { regionName, tierName } from '../names';
import { DEFAULT_CAR_NAME, HERO_SEP, HERO_SEP_TV, heroQueue, heroState, plateRank, queueParts, subParts } from './homeModel';
import type { HeroInput, HeroKind, HeroState, QueuePick } from './homeModel';

const UI_FIT = import.meta.env.DEV || import.meta.env.VITE_UI_FIT === '1';

export function homeScreen(menu: Menu): Screen {
  const host = menu.host;
  const acc = host.accounts;
  const html = document.documentElement;
  // Fixed for the page: device.ts sets tg-tv and the Game tg-superlow before the menus first show.
  const tv = html.classList.contains('tg-tv');
  const lines = !html.classList.contains('tg-superlow');
  const touch = (): boolean => html.classList.contains('tg-touch');
  const car = DEFAULT_CAR_NAME;
  const plate = createPlate({ profile: () => menu.open('profile'), garage: () => menu.open('garage') });
  // A TV's pills by the plate (Screen.pillSlot), fitted as the hint bar fits them there.
  const pills = h('div.mn-home-pills', { 'data-fit': '16' });
  const hero = heroTile({
    lines,
    oneLine: tv,
    press: () => press(),
    cancel: () => {
      menu.cancelSearch();
      if (!touch()) hero.main.focus({ preventScroll: true });
    },
  });
  const ranked = modeTile({ cls: 'mn-mtile-ranked', key: 'mode-ranked', icon: 'rank', slot: null, title: t('modes.ranked'), sub: t('modes.rankedSub'), short: t('modes.rankedSubShort'), open: () => menu.open('modes', false, 'ranked') });
  const tiles = [
    modeTile({ cls: 'mn-mtile-casual', key: 'mode-casual', icon: 'ball', slot: slot(PLAYLISTS.join(HERO_SEP), { drop: true }), title: t('modes.casual'), sub: t('modes.casualSub'), short: t('modes.casualSubShort'), open: () => menu.open('modes', false, 'casual') }),
    // A TV has no link to share: a code (PR 14 types it on the phone).
    modeTile({ cls: 'mn-mtile-friends', key: 'mode-friends', icon: 'friends', slot: slot(t('modes.lobbies'), { drop: true }), title: t('modes.friends'), sub: t('modes.friendsSub'), short: t(tv ? 'modes.friendsSubTv' : 'modes.friendsSubShort'), open: () => menu.open('modes', false, 'lobbies') }),
    modeTile({ cls: 'mn-mtile-ai', key: 'mode-ai', icon: 'bot', slot: slot(t('modes.vsAiSlot'), { drop: true }), title: t('modes.vsAi'), sub: t('modes.vsAiSub'), short: t('modes.vsAiSubShort'), open: () => menu.open('modes', false, 'ai') }),
    ranked,
  ];
  const el = h('section.mn-home', { 'data-tablero': true }, h('div.mn-home-top', { 'data-nav-row': true }, plate.el, pills), h('div.mn-tiles', null, hero.el, ...tiles.map((x) => x.el)));

  let state: HeroState = { kind: 'play', queue: heroQueue(menu.prefs, false, false) };
  let heroKey = '';
  let clockText = '';
  let plateKey = '';
  let rankedKey = '';
  let banText = '';
  /** The profile was fetched for this session (the plate, the ban): signed in after the screen showed, it is fetched once more. */
  let fetchedFor = '';
  let forced: HeroState | null = null;
  let forcePad = false;

  const banLeft = (): number => (acc.me?.rankedBanUntil ?? 0) - Date.now();
  /** A region's name: the queue's own, else the automatic one (the connection's continent); null when none is known yet. */
  const regionOf = (id: RegionId | null): string | null => {
    const auto = menu.cfg?.autoRegion;
    const r = id ?? (isRegion(auto) ? auto : null);
    return r === null ? null : regionName(r);
  };
  const names = { casual: t('play.casualTitle'), ranked: t('play.rankedTitle') };

  /** The server match this tab may join again (rejoinStore.ts), while no search runs (a rejoin under way is one). */
  const rejoinOf = (searching: boolean): HeroInput['rejoin'] => {
    const r = searching ? null : host.rejoinable();
    return r === null ? null : { kind: r.kind, modes: r.modes, leftMs: rejoinLeftMs(r) };
  };

  const input = (): HeroInput => {
    const v = host.searchView();
    const lobby = host.lobby;
    const st = lobby.state;
    return {
      updateNeeded: menu.updateNeeded,
      rejoin: rejoinOf(v.active),
      lobby: !lobby.inLobby ? null : st !== null ? { code: st.code, count: st.members.length, max: MODES[st.settings.mode] * 2 } : { code: lobby.code ?? '', count: null, max: null },
      search: v.active && v.kind !== null ? { kind: v.kind, modes: v.modes, region: v.region, since: v.since } : null,
      offline: menu.offline,
      queue: heroQueue(menu.prefs, acc.signedIn, banLeft() > 0),
    };
  };

  /** What the hero shows for state `s` (plan PR 5's table); `key` changes with any text but the clock. */
  const heroView = (s: HeroState, needPad: boolean, now: number): HeroView & { key: string } => {
    const padSlot: HeroView['slot'] = { text: t('tv.needPad'), icon: 'pad' };
    const queueSub = (kind: 'casual' | 'ranked', modes: readonly GameMode[], region: RegionId | null): { sub: HeroSub; text: string } => {
      const p = queueParts(kind, modes, regionOf(region), names);
      const dot = tv ? HERO_SEP_TV : HERO_SEP;
      return { sub: { queue: p.queue, dot, region: p.region }, text: p.region === null ? p.queue : p.queue + dot + p.region };
    };
    let icon: HeroView['icon'] = 'play';
    let tag: HeroView['slot'] = null;
    let title: string;
    let sub: HeroSub;
    let subText: string;
    let clockNow: string | null = null;
    const kind: HeroKind = s.kind;
    switch (s.kind) {
      case 'play': {
        const q = queueSub(s.queue.kind, s.queue.modes, s.queue.region);
        tag = needPad ? padSlot : { text: t('home.alwaysMatch') };
        title = t(tv ? 'home.playNowTv' : 'home.playNow');
        sub = q.sub;
        subText = q.text;
        break;
      }
      case 'search': {
        const q = queueSub(s.search.kind, s.search.modes, s.search.region);
        icon = 'search';
        tag = needPad ? padSlot : null;
        title = t('home.searching');
        clockNow = clock(now - s.search.since);
        sub = q.sub;
        subText = q.text;
        break;
      }
      case 'offline': {
        // In two parts, as a queue and its region: "sin conexión" on its own line on a phone, the
        // part that steps aside on a TV (whose short form is the CONTRA LA IA tile's there).
        subText = t(tv ? 'modes.vsAiSubShort' : 'modes.vsAiSub');
        const p = subParts(subText);
        icon = 'bot';
        tag = needPad ? padSlot : { text: t('pill.offline') };
        title = t('modes.vsAi');
        sub = { queue: p.queue, dot: HERO_SEP, region: p.region };
        break;
      }
      case 'lobby':
        icon = 'friends';
        title = t('home.backToLobby');
        sub = subText = t('home.lobbySub', { code: s.lobby.code, count: s.lobby.count ?? '—', max: s.lobby.max ?? '—' });
        break;
      case 'update':
        icon = 'refresh';
        title = t('update.reload');
        sub = subText = t('update.title');
        break;
      case 'rejoin': {
        const q = queueParts(s.rejoin.kind, s.rejoin.modes, null, names).queue;
        tag = needPad ? padSlot : null;
        title = t('home.rejoin');
        subText = t('home.rejoinSub', { queue: q, time: clock(s.rejoin.leftMs) });
        const p = subParts(subText); // the time left as the offline hero's second part
        sub = { queue: p.queue, dot: HERO_SEP, region: p.region };
        break;
      }
    }
    const pad = tag !== null && needPad;
    return { kind, icon, slot: tag, title, clock: clockNow, sub, needPad: pad, label: title + '. ' + subText, key: [kind, title, subText, tag?.text ?? '', pad].join('|') };
  };

  /** The plate, on a change of who and which rank (true when it was written). */
  const renderPlate = (): boolean => {
    const signed = acc.signedIn && acc.account !== null;
    const name = signed && acc.account !== null ? acc.account.name : host.guestName();
    const best = signed ? plateRank(acc.me) : null;
    const key = [signed, name, best?.tier ?? '', best?.playlist ?? ''].join('|');
    if (key === plateKey) return false;
    plateKey = key;
    const tier = best !== null ? tierById(best.tier) : null;
    const rank = best !== null && tier !== null ? `${tierName(tier)}${HERO_SEP}${best.playlist}` : t('home.unranked');
    const carLine = t('home.carLine', { car });
    plate.set({
      avatar: signed ? rankBadge(tier, 44) : h('span.mn-plate-avatar', { 'aria-hidden': 'true' }, '?'),
      name,
      line: tv ? rank + HERO_SEP + carLine : signed ? rank : t('home.guestRank'),
      carName: car,
      profileLabel: t('home.plateProfile', { name, rank }) + (tv ? '. ' + carLine : ''),
      garageLabel: t('home.plateGarage', { car }),
    });
    return true;
  };

  /**
   * COMPETITIVO's lock: a guest's "Sign in", a banned player's lock alone, the time left as its
   * description (true when the slot was rebuilt).
   */
  const renderRanked = (): boolean => {
    const left = acc.signedIn ? banLeft() : 0;
    const key = !acc.signedIn ? 'guest' : left > 0 ? 'ban' : '';
    const text = left > 0 ? t('play.rankedBan', { time: clock(left) }) : '';
    if (text !== banText) {
      banText = text;
      if (text !== '') ranked.el.title = text;
      else ranked.el.removeAttribute('title');
    }
    if (key === rankedKey) return false;
    rankedKey = key;
    // A guest's "Iniciar sesión" takes its short form in a narrow tile (a phone, a tablet), before
    // the lock would stand alone.
    ranked.setSlot(key === 'guest' ? slot(t('menu.guestSignIn'), { icon: 'lock', body: true, short: t('modes.signInShort'), drop: true }) : key === 'ban' ? slot('', { icon: 'lock' }) : null);
    return true;
  };

  const fetchMe = (): void => {
    if (!acc.signedIn) return;
    fetchedFor = acc.account?.name ?? '?';
    void acc.fetchMe().then(() => render(performance.now()), () => undefined);
  };

  /** Everything that changed, then one fit (`fit`: false as the screen shows: the mount fits right after). */
  const render = (now: number, fit = true): void => {
    state = forced ?? heroState(input());
    const needPad = tv && !forcePad && !host.padConnected();
    const view = heroView(state, needPad, now);
    let changed = false;
    if (view.key !== heroKey) {
      heroKey = view.key;
      clockText = view.clock ?? '';
      hero.set(view);
      changed = true;
    } else if (view.clock !== null && view.clock !== clockText) {
      clockText = view.clock;
      hero.setClock(view.clock);
    }
    // A session restored after the screen showed: its profile once (the plate's rank, the ban).
    if (acc.signedIn && acc.me === null && fetchedFor !== (acc.account?.name ?? '?')) fetchMe();
    if (renderPlate()) changed = true;
    if (renderRanked()) changed = true;
    if (changed && fit) menu.refit();
  };

  /** The hero's press, for the state it shows now. */
  const press = (): void => {
    render(performance.now());
    const s = state;
    switch (s.kind) {
      case 'play':
        menu.beforeMatch(() => menu.startSearch({ kind: s.queue.kind, modes: s.queue.modes, region: s.queue.region, net: s.queue.net }));
        return;
      case 'search':
        menu.openSearchScreen();
        return;
      case 'offline':
        menu.beforeMatch(() => host.playFriendly(host.mode, host.difficulty));
        return;
      case 'lobby':
        menu.open('lobby');
        return;
      case 'update':
        location.reload();
        return;
      case 'rejoin':
        menu.beforeMatch(() => menu.rejoin());
        return;
    }
  };

  if (UI_FIT) {
    // `ranked`: the samples' queue is Competitive in every format (the longest subtitle).
    (window as unknown as { __homeHero: (kind: HeroKind | null, opts?: { pad?: boolean; ranked?: boolean }) => void }).__homeHero = (kind, opts) => {
      const now = performance.now();
      const q: QueuePick = opts?.ranked === true ? { kind: 'ranked', modes: [...PLAYLISTS], region: null, net: 'server' } : heroQueue(menu.prefs, false, false);
      const sample: Record<HeroKind, HeroState> = {
        play: { kind: 'play', queue: q },
        search: { kind: 'search', search: { kind: q.kind, modes: q.modes, region: q.region, since: now - 42_000 } },
        offline: { kind: 'offline' },
        lobby: { kind: 'lobby', lobby: { code: 'ABC234', count: 2, max: 4 } },
        update: { kind: 'update' },
        rejoin: { kind: 'rejoin', rejoin: { kind: q.kind, modes: q.modes, leftMs: 192_000 } },
      };
      forced = kind === null ? null : sample[kind];
      forcePad = opts?.pad === true;
      render(now);
    };
  }

  return {
    id: 'home',
    title: t('home.title'),
    el,
    pillSlot: pills,
    show: () => {
      heroKey = clockText = plateKey = rankedKey = '';
      fetchMe();
      menu.host.prewarmAntiBot?.(); // a guest's first JUGAR then rarely waits for the anti-bot check
      render(performance.now(), false);
    },
    tick: render,
  };
}
