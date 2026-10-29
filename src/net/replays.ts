/**
 * Public match replays (the community nodes' recordings, nodes/shared/replay.ts): what the Worker
 * lists and serves to anyone, guests included, and the client calls the viewer (replay.html) makes.
 *
 *   GET /nodes/replays[?before=<ms>]     the most recent settled matches, newest first (REPLAY_PAGE)
 *   GET /nodes/replays/<matchId>/view    that match's replay, made public: the header carries no
 *                                        account id and no node id, and the names are the control
 *                                        plane's own (never the node's word)
 *
 * Only matches the control plane settled without voiding them are listed (rated, or unrated
 * casual: `verified` says whether a verifier re-simulated it). R2 keeps a replay 30 days, the list
 * the same.
 */

export const REPLAY_PAGE = 30;

export interface ReplayPlayer {
  team: 0 | 1;
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
  /** When the control plane settled it (ms). */
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
  /** Pass as ?before= for the next page; null at the end. A page may hold fewer than REPLAY_PAGE rows and still have a next one. */
  next: number | null;
}

/** The list (newest first). Throws on a network failure or a refusal (404: no community nodes here). */
export async function fetchReplayList(before: number | null = null): Promise<ReplayList> {
  const res = await fetch('/nodes/replays' + (before !== null ? `?before=${before}` : ''));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ReplayList;
}

/** URL of a match's public replay. */
export function replayUrl(matchId: string): string {
  return `/nodes/replays/${matchId}/view`;
}
