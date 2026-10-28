/**
 * CLASIFICACIÓN's decisions (plan PR 13, dir-hub §6.7), pure: the playlist ◀ ▶ step to (never round:
 * past 1v1 the arrow goes on to the phone's rail), a page of rows for LT / RT and PgUp / PgDn, the
 * row that is yours, what the list shows instead of rows and your standing beside the tabs (each
 * notice a button: retry, sign in, play the placement matches, go to your row). tests/leaderboard.test.mjs.
 */
import type { LeaderboardEntry, Playlist } from '../../net/account';

/** The playlist beside `p` that way, null at either end. */
export function stepPlaylist(list: readonly Playlist[], p: Playlist, d: -1 | 1): Playlist | null {
  const i = list.indexOf(p);
  return i < 0 ? null : (list[i + d] ?? null);
}

/** Rows a page moves: the rows the scroller shows but one (the last one stays in sight), at least 1. */
export function rowsPerPage(viewHeight: number, rowHeight: number): number {
  return rowHeight > 0 ? Math.max(1, Math.floor(viewHeight / rowHeight) - 1) : 1;
}

/** The row a page up / down lands on, from `index` (-1: no row focused yet: the first), clamped to the rows. */
export function pageStep(index: number, count: number, page: number, d: -1 | 1): number {
  if (count <= 0) return -1;
  if (index < 0) return 0;
  return Math.min(count - 1, Math.max(0, index + d * page));
}

/** Your row among the entries (the answer's `you` by name, as the server matches it), -1 when you are not in the top. */
export function youIndex(entries: readonly LeaderboardEntry[], you: LeaderboardEntry | null | undefined): number {
  return you == null ? -1 : entries.findIndex((e) => e.name === you.name);
}

/** What the list shows instead of rows: 'loading', 'error' (a RETRY button), 'empty' (nobody placed yet), or null (the rows). */
export type ListNotice = 'loading' | 'error' | 'empty' | null;

export function listNotice(loading: boolean, error: boolean, entries: number): ListNotice {
  return loading ? 'loading' : error ? 'error' : entries === 0 ? 'empty' : null;
}

/**
 * Your standing, the button beside the tabs: 'guest' (sign in to see your place: PERFIL),
 * 'placement' (signed in, not placed in this playlist: Competitive's placement matches), 'you'
 * (GO TO MY POSITION: your row in the top, or pinned under it).
 */
export type Standing = 'guest' | 'placement' | 'you';

export function standing(signedIn: boolean, you: boolean): Standing {
  return !signedIn ? 'guest' : you ? 'you' : 'placement';
}
