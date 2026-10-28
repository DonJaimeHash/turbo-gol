/**
 * MODOS' decisions, pure (no DOM, no texts: tests/modes.test.mjs): its four tabs and their order,
 * the formats a search is named by (1v1, 2v2, 3v3 or any of them, never "pairs"), the connection
 * picked under Advanced and the queue it sends, the "bots join in" countdown (only for the path the
 * search really takes), the threshold under which a count is not shown, and what the action zone
 * offers on each tab. src/ui/screens/modes.ts puts them on the page.
 */
import type { MenuPrefs } from '../prefs';
import type { GameMode } from '../../sim/constants';

/** The vertical tabs, in their order on every device. */
export type ModeTab = 'casual' | 'ranked' | 'lobbies' | 'ai';
export const MODE_TABS: readonly ModeTab[] = ['casual', 'ranked', 'lobbies', 'ai'];

export function isModeTab(v: unknown): v is ModeTab {
  return typeof v === 'string' && (MODE_TABS as readonly string[]).includes(v);
}

/** The tab `d` places from `tab`, round (Q / E, LB / RB, LT / RT). */
export function stepTab(tab: ModeTab, d: -1 | 1): ModeTab {
  const i = MODE_TABS.indexOf(tab);
  return MODE_TABS[(i + d + MODE_TABS.length) % MODE_TABS.length];
}

/** A search's format: one playlist, or any of the three (whichever fills first). */
export type Format = GameMode | 'any';
export const FORMATS: readonly Format[] = ['1v1', '2v2', '3v3', 'any'];
const ALL: readonly GameMode[] = ['1v1', '2v2', '3v3'];

/** The format of a stored playlist pick: one playlist is itself, anything else (an older pick of two) any. */
export function formatOf(modes: readonly GameMode[]): Format {
  return modes.length === 1 ? modes[0] : 'any';
}

/** The playlists a format searches. */
export function modesOf(f: Format): GameMode[] {
  return f === 'any' ? ALL.slice() : [f];
}

/** Advanced › Connection. */
export type NetPick = MenuPrefs['net'];
export const NET_PICKS: readonly NetPick[] = ['auto', 'p2p', 'server'];

/**
 * The queue a Casual search joins: Auto and P2P the P2P queue (the matchmaker forms a room with the
 * other players, or a server match with bots for a lone one), Server the server queue.
 */
export function queueNet(n: NetPick): 'p2p' | 'server' {
  return n === 'server' ? 'server' : 'p2p';
}

/** What decides when bots fill a search's match. */
export interface BotsInput {
  kind: 'casual' | 'ranked';
  net: 'p2p' | 'server';
  /** performance.now() when the search started, and now. */
  since: number;
  now: number;
  /** The server queue's bot fill (GET /api/config botFillMs), null when the Worker did not say. */
  botFillMs: number | null;
  /** The P2P queue's wait (P2P_FILL_WAIT_MS): then a room forms with bots, or a lone player gets a server match with bots. */
  p2pFillMs: number;
}

/**
 * The countdown "bots join in" for a running search, as `{ left, total }` ms, or null when it would
 * not be true: Competitive never fills with bots, a server queue whose delay the Worker did not
 * say, and a wait that already ran out (a full region keeps waiters waiting: the box goes rather
 * than stand at 0:00). Counted from the search's start: the matchmaker counts from the oldest
 * waiter, so the bots come at the latest then (sooner when another player is waiting). Pure.
 */
export function botsCountdown(b: BotsInput): { left: number; total: number } | null {
  if (b.kind === 'ranked') return null;
  const total = b.net === 'server' ? b.botFillMs : b.p2pFillMs;
  if (total === null || !(total > 0)) return null;
  const left = total - Math.max(0, b.now - b.since);
  return left > 0 ? { left, total } : null;
}

/** How many of `segments` the countdown's bar fills (the time left, rounded up). */
export function botsSegments(left: number, total: number, segments: number): number {
  if (!(total > 0)) return 0;
  return Math.min(segments, Math.max(0, Math.ceil((left / total) * segments)));
}

/** Below this many players a count is not shown (a small one reads as an empty game; shell/pills.ts PLAYING_SHOWN). */
export function countShown(n: number | null | undefined, threshold: number): boolean {
  return typeof n === 'number' && n >= threshold;
}

/** What the action zone offers on a tab. */
export type ActionKind = 'search' | 'searching' | 'signIn' | 'banned' | 'play' | 'lobbies';

export interface ActionInput {
  tab: ModeTab;
  signedIn: boolean;
  /** Competitive's abandon ban, ms left (0: none). */
  banLeft: number;
  /** The kind of the search running, null when none. */
  searching: 'casual' | 'ranked' | null;
}

/**
 * The action zone of `tab`: the searching panel on the tab of the running search; Competitive asks a
 * guest to sign in and tells a banned player why; VS AI plays, LOBBIES makes a lobby; else FIND MATCH. Pure.
 */
export function actionKind(a: ActionInput): ActionKind {
  if (a.tab === 'ai') return 'play';
  if (a.tab === 'lobbies') return 'lobbies';
  if (a.searching === a.tab) return 'searching';
  if (a.tab === 'ranked') {
    if (!a.signedIn) return 'signIn';
    if (a.banLeft > 0) return 'banned';
  }
  return 'search';
}
