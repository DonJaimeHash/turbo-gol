/**
 * Public match replays (the community nodes' recordings, nodes/shared/replay.ts): what the Worker
 * lists and serves to anyone, guests included, and the client calls the viewer (replay.html) makes.
 *
 *   GET /nodes/replays[?before=<cursor>] the matches settled at least an hour ago, newest hour first
 *                                        (REPLAY_PAGE); `next` is an opaque cursor the Worker signed
 *   GET /nodes/replays/<matchId>/view    that match's replay, made public: the header carries no
 *                                        account id, no node id and no start time, and the names
 *                                        are the control plane's own (never the node's word)
 *
 * Only matches the control plane settled without voiding them are listed (rated, or unrated
 * casual: `verified` says whether a verifier re-simulated it). A match shows up an hour after it
 * settled, its time rounded down to the hour, and goes after 30 days. An account that hides its
 * name (PERFIL, GET/POST /api/me/replay-name) shows as 'Jugador N' (hiddenNameOf), in the list and
 * in the replay, for the matches listed before it chose so too.
 */

export const REPLAY_PAGE = 30;

/**
 * The wire form of a hidden name: 'Jugador N', N the slot + 1 (1-8), Spanish like a guest's
 * 'Invitado 4821' (src/net/guestName.ts); each page shows it in its own language (src/replay/
 * names.ts). No username can be it: usernames have no space.
 */
export const HIDDEN_NAME_RE = /^Jugador ([1-8])$/;

export function hiddenNameOf(slot: number): string {
  return `Jugador ${slot + 1}`;
}

/** The number of a hidden name ('3'), null for any other name. */
export function hiddenNumber(name: string): string | null {
  const m = HIDDEN_NAME_RE.exec(name);
  return m === null ? null : m[1];
}

export interface ReplayPlayer {
  team: 0 | 1;
  /** The control plane's name: a username, a guest's 'Invitado 4821', a bot's, or 'Jugador N' for an account that hides it. */
  name: string;
  bot: boolean;
}

export interface ReplayBuild {
  version: string;
  protocol: number;
  wasmSha256: string;
}

export interface ReplayListItem {
  matchId: string;
  /** When the control plane settled it (ms); in the public list, rounded down to the hour. */
  at: number;
  mode: '1v1' | '2v2' | '3v3';
  region: string;
  ranked: boolean;
  /** A verifier re-simulated it and it held (every ranked match; casual by sample). */
  verified: boolean;
  blue: number;
  red: number;
  /** Ticks played (120 Hz); 0 when unknown. */
  ticks: number;
  players: ReplayPlayer[];
  /** The build the match was played on: the viewer warns when it is not its own. */
  build: ReplayBuild;
}

export interface ReplayList {
  matches: ReplayListItem[];
  /** Pass as ?before= for the next page (opaque); null at the end. */
  next: string | null;
}

/** GET / POST /api/me/replay-name: whether the account's name is hidden in the public replays. */
export interface ReplayNameAnswer {
  hidden: boolean;
}

/** The list (newest first). Throws on a network failure or a refusal (404: no community nodes here, or the list is off). */
export async function fetchReplayList(before: string | null = null): Promise<ReplayList> {
  const res = await fetch('/nodes/replays' + (before !== null ? `?before=${encodeURIComponent(before)}` : ''));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ReplayList;
}

/** URL of a match's public replay. */
export function replayUrl(matchId: string): string {
  return `/nodes/replays/${matchId}/view`;
}
