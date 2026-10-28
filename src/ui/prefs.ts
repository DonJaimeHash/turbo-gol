/**
 * The menus' own preferences, in localStorage `turbogol.menu.v1` (Menu.ts loads and saves them):
 * the region, the playlists picked for Casual and for Competitive, Casual's connection (MODOS ›
 * Advanced: auto, P2P or server; screens/modesModel.ts queueNet), the
 * leaderboard's playlist, and the kind of the last search started anywhere, which JUGAR AHORA plays
 * again in one press (screens/homeModel.ts heroQueue). Pure, no DOM: node tests import it.
 */
import { isRegion } from '../net/account';
import type { RegionId } from '../net/account';
import type { GameMode } from '../sim/constants';
import { STORAGE_PREFIX } from '../brand';

export interface MenuPrefs {
  region: RegionId | null;
  casualModes: GameMode[];
  rankedModes: GameMode[];
  net: 'auto' | 'p2p' | 'server';
  leaderboardPlaylist: GameMode;
  /** The kind of the last search started anywhere (hero, Casual, Competitive): what JUGAR AHORA repeats. */
  lastQueue: 'casual' | 'ranked';
}

/** The same key as before lastQueue: an older object reads as Casual, no migration. */
export const PREFS_KEY = STORAGE_PREFIX + 'menu.v1';

/** A first visit: Casual 2v2 in the automatic region (the connection's continent), the automatic connection. */
export const DEFAULT_PREFS: Readonly<MenuPrefs> = { region: null, casualModes: ['2v2'], rankedModes: ['2v2'], net: 'auto', leaderboardPlaylist: '2v2', lastQueue: 'casual' };

/** The prefs stored as `raw` (null when none); anything unreadable takes its default. Pure. */
export function parsePrefs(raw: string | null): MenuPrefs {
  const d: MenuPrefs = { ...DEFAULT_PREFS, casualModes: DEFAULT_PREFS.casualModes.slice(), rankedModes: DEFAULT_PREFS.rankedModes.slice() };
  if (!raw) return d;
  let o: Partial<MenuPrefs>;
  try {
    const v: unknown = JSON.parse(raw);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return d;
    o = v as Partial<MenuPrefs>;
  } catch {
    return d;
  }
  const modes = (v: unknown): GameMode[] | null => (Array.isArray(v) && v.length > 0 && v.every((m) => m === '1v1' || m === '2v2' || m === '3v3') ? (v as GameMode[]) : null);
  return {
    region: isRegion(o.region) ? o.region : null,
    casualModes: modes(o.casualModes) ?? d.casualModes,
    rankedModes: modes(o.rankedModes) ?? d.rankedModes,
    net: o.net === 'server' || o.net === 'p2p' ? o.net : 'auto',
    leaderboardPlaylist: o.leaderboardPlaylist === '1v1' || o.leaderboardPlaylist === '3v3' ? o.leaderboardPlaylist : '2v2',
    lastQueue: o.lastQueue === 'ranked' ? 'ranked' : 'casual',
  };
}
