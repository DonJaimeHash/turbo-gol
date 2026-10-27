/**
 * Inicio's decisions, pure (no DOM, no texts: tests/home-hero.test.mjs): which state the hero
 * shows, the queue JUGAR AHORA repeats, when the game counts as offline, how the subtitle and a
 * two-line title are cut, and the rank on the player's plate. src/ui/screens/home.ts puts them on
 * the page.
 *
 * The hero shows the first state that applies (plan PR 5): a new version (the server refused this
 * page) > back to your match (a match of this tab still running after a reload: PR 12, null until
 * then) > back to the lobby > the running search > offline (the Worker unreachable, or two
 * population polls in a row failed: one slow poll is no reason to swap the match for a bot game) >
 * play (the last queue).
 */
import type { MenuPrefs } from '../prefs';
import type { Playlist, RegionId } from '../../net/account';
import type { GameMode } from '../../sim/constants';

/** A queue to search: what Menu.startSearch takes. */
export interface QueuePick {
  kind: 'casual' | 'ranked';
  modes: GameMode[];
  /** null = automatic (the connection's continent). */
  region: RegionId | null;
  net: 'p2p' | 'server';
}

/**
 * What JUGAR AHORA plays: the kind searched last (MenuPrefs.lastQueue, Casual the first time) with
 * that kind's playlists, the region and Casual's queue (auto and P2P: the P2P one). Competitive only for a signed-in player
 * without an abandon ban; anyone else gets Casual. Pure.
 */
export function heroQueue(p: MenuPrefs, signedIn: boolean, rankedBanned: boolean): QueuePick {
  if (p.lastQueue === 'ranked' && signedIn && !rankedBanned) return { kind: 'ranked', modes: p.rankedModes, region: p.region, net: 'server' };
  return { kind: 'casual', modes: p.casualModes, region: p.region, net: p.net === 'server' ? 'server' : 'p2p' };
}

/**
 * Offline for the hero: the Worker answered nothing (`cfg.online` false), or `popFails` population
 * polls in a row failed, two or more. Still connecting (`cfg` null) is not offline. Pure.
 */
export function isOffline(cfg: { online: boolean } | null, popFails: number): boolean {
  return cfg !== null && (!cfg.online || popFails >= 2);
}

/** The running search. */
export interface HeroSearch {
  kind: 'casual' | 'ranked';
  modes: GameMode[];
  region: RegionId | null;
  /** performance.now() when it started. */
  since: number;
}

/** The lobby this player is in; `count` and `max` are null before its first state message. */
export interface HeroLobby {
  code: string;
  count: number | null;
  max: number | null;
}

/** A match of this tab still running after a reload (PR 12). */
export interface HeroRejoin {
  kind: 'casual' | 'ranked';
  modes: GameMode[];
  /** Its time left, ms. */
  leftMs: number;
}

export interface HeroInput {
  updateNeeded: boolean;
  rejoin: HeroRejoin | null;
  lobby: HeroLobby | null;
  search: HeroSearch | null;
  offline: boolean;
  /** heroQueue's pick, for the play state. */
  queue: QueuePick;
}

export type HeroKind = 'update' | 'rejoin' | 'lobby' | 'search' | 'offline' | 'play';

export type HeroState =
  | { kind: 'update' }
  | { kind: 'rejoin'; rejoin: HeroRejoin }
  | { kind: 'lobby'; lobby: HeroLobby }
  | { kind: 'search'; search: HeroSearch }
  | { kind: 'offline' }
  | { kind: 'play'; queue: QueuePick };

/** The first state that applies, in the order above. Pure. */
export function heroState(i: HeroInput): HeroState {
  if (i.updateNeeded) return { kind: 'update' };
  if (i.rejoin !== null) return { kind: 'rejoin', rejoin: i.rejoin };
  if (i.lobby !== null) return { kind: 'lobby', lobby: i.lobby };
  if (i.search !== null) return { kind: 'search', search: i.search };
  if (i.offline) return { kind: 'offline' };
  return { kind: 'play', queue: i.queue };
}

/** The subtitle's separator, and a TV's before the region (the owner's TV artboard: "Casual · 2v2 - Sudamérica"). */
export const HERO_SEP = ' · ';
export const HERO_SEP_TV = ' - ';

/**
 * The subtitle's two parts: the queue ("Casual · 2v2", "Competitivo · 1v1 · 3v3") and the region's
 * name (`region`, null when none is known yet: then it is left out). `names`: the kinds' names in
 * the page's language (play.casualTitle, play.rankedTitle). Pure.
 */
export function queueParts(kind: 'casual' | 'ranked', modes: readonly GameMode[], region: string | null, names: { casual: string; ranked: string }): { queue: string; region: string | null } {
  return { queue: [kind === 'ranked' ? names.ranked : names.casual, ...modes].join(HERO_SEP), region };
}

/**
 * A two-part subtitle ("Partido de 3 min · sin conexión") split at its last separator, set as a
 * queue and its region are (a phone's second line, the part a TV lets go); one part when it has
 * none. Pure.
 */
export function subParts(text: string): { queue: string; region: string | null } {
  const i = text.lastIndexOf(HERO_SEP);
  return i <= 0 ? { queue: text, region: null } : { queue: text.slice(0, i), region: text.slice(i + HERO_SEP.length) };
}

/**
 * A title's two-line form (fit.ts data-fit-alt): split at the space that balances the two lines
 * best ("JUGAR AHORA" -> "JUGAR\nAHORA"); a single word stays as it is. Pure.
 */
export function twoLines(s: string): string {
  let best = -1;
  let longest = Infinity;
  for (let i = s.indexOf(' '); i >= 0; i = s.indexOf(' ', i + 1)) {
    const m = Math.max(i, s.length - i - 1);
    if (m < longest) {
      longest = m;
      best = i;
    }
  }
  return best < 0 ? s : s.slice(0, best) + '\n' + s.slice(best + 1);
}

/** What plateRank reads of a rating (net/account.ts PlaylistRating). */
export interface PlateRating {
  playlist: Playlist;
  mmr: number;
  /** Tier id once placed, null during placement. */
  tier: string | null;
}

/** The plate's rank: the best placed rating by MMR (the account chip's rule), null when none. Pure. */
export function plateRank(me: { ratings: readonly PlateRating[] } | null): { tier: string; playlist: Playlist } | null {
  let best: PlateRating | null = null;
  for (const r of me?.ratings ?? []) if (r.tier !== null && (best === null || r.mmr > best.mmr)) best = r;
  return best !== null && best.tier !== null ? { tier: best.tier, playlist: best.playlist } : null;
}

/**
 * The car on the plate until the cars land (Dune, the free one): a proper name, the same in every
 * language.
 * PR 8: read menu.host.garage.store.equipped and show t(CARS.find((c) => c.id === id).nameKey).
 */
export const DEFAULT_CAR_NAME = 'Dune';
