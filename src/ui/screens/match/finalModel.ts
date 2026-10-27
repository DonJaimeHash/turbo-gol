/**
 * The FINAL's decisions, pure (no DOM, no texts: tests/final-model.test.mjs): what the Game hands
 * over when a match ends (FinalView), who scored a goal (the last toucher of the scoring team since
 * the kickoff, read from the state buffer's per-car ball-hit tick: nothing new from the sim or the
 * host), the MVP, what JUGAR OTRA VEZ and CAMBIAR MODO do for each kind of match, and the rank
 * card from the ranked result. src/ui/screens/match/final.ts puts them on the page.
 */
import { CARS_OFFSET, CAR_STRIDE, C_BALL_HIT_TICK, C_TEAM, H_NUM_CARS, MAX_CARS } from '../../../sim/types';
import type { GameMode } from '../../../sim/constants';
import type { RankedResultAnswer, RegionId } from '../../../net/account';
import { TIERS, tierOf, tierProgress } from '../../../net/rating';
import type { MenuPrefs } from '../../prefs';
import type { QueuePick } from '../homeModel';
import { queueNet, type ModeTab } from '../modesModel';

/** Which kind of match ended: what JUGAR OTRA VEZ repeats. */
export type FinalKind = 'casual' | 'ranked' | 'ai' | 'lobby';

export interface FinalPlayer {
  readonly name: string;
  readonly team: 0 | 1;
  /** The player's own car. */
  readonly you: boolean;
  readonly bot: boolean;
  /** Goals credited by goalScorer. */
  readonly goals: number;
}

/** What the Game knows when a match ends; the FINAL draws it. */
export interface FinalView {
  readonly kind: FinalKind;
  /** null: a draw. */
  readonly winner: 0 | 1 | null;
  /** The player's team. */
  readonly team: 0 | 1;
  readonly blue: number;
  readonly red: number;
  readonly mode: GameMode;
  /** The region searched (null: automatic, or a match with no region: Contra la IA). */
  readonly region: RegionId | null;
  readonly players: readonly FinalPlayer[];
  /** A community node's name when the match ran on one (Welcome.hostColo 'node:<name>'), else null. */
  readonly node: string | null;
  /** The ranked match's id: its rating change is waited for (RankedResults), null otherwise. */
  readonly rankedMatchId: string | null;
}

export type FinalOutcome = 'win' | 'loss' | 'draw';

export function finalOutcome(v: Pick<FinalView, 'winner' | 'team'>): FinalOutcome {
  return v.winner === null ? 'draw' : v.winner === v.team ? 'win' : 'loss';
}

/**
 * The slot of the car credited with a goal for `team`: of that team's cars, the one whose last
 * ball touch is the latest, at or after `sinceTick` (the play's kickoff). -1 when none of them
 * touched the ball in that play (an own goal with no touch of theirs). `buf` is the sim's state
 * buffer (src/sim/types.ts layout).
 */
export function goalScorer(buf: ArrayLike<number>, team: 0 | 1, sinceTick: number): number {
  const n = Math.min(MAX_CARS, buf[H_NUM_CARS] | 0);
  let best = -1;
  let bestTick = -1;
  for (let slot = 0; slot < n; slot++) {
    const off = CARS_OFFSET + slot * CAR_STRIDE;
    if ((buf[off + C_TEAM] === 1 ? 1 : 0) !== team) continue;
    const tick = buf[off + C_BALL_HIT_TICK];
    if (tick < 0 || tick < sinceTick || tick <= bestTick) continue;
    bestTick = tick;
    best = slot;
  }
  return best;
}

/** The MVP: the winning team's top scorer, when one stands alone (index in `players`, -1: none; a draw has none). */
export function pickMvp(players: readonly FinalPlayer[], winner: 0 | 1 | null): number {
  if (winner === null) return -1;
  let best = -1;
  let tie = false;
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (p.team !== winner || p.goals === 0) continue;
    if (best < 0 || p.goals > players[best].goals) {
      best = i;
      tie = false;
    } else if (p.goals === players[best].goals) tie = true;
  }
  return tie ? -1 : best;
}

/** The players by team, blue first, the player's own row first in its team. */
export function finalRows(players: readonly FinalPlayer[], team: 0 | 1): FinalPlayer[] {
  return players.filter((p) => p.team === team).sort((a, b) => Number(b.you) - Number(a.you));
}

/** What JUGAR OTRA VEZ does: the same queue (that kind's playlists, as Inicio's hero repeats it), a new match against the AI, or back to the lobby. */
export type AgainAction = { readonly kind: 'search'; readonly queue: QueuePick } | { readonly kind: 'restart' } | { readonly kind: 'lobby' };

export function againAction(kind: FinalKind, prefs: MenuPrefs): AgainAction {
  if (kind === 'ai') return { kind: 'restart' };
  if (kind === 'lobby') return { kind: 'lobby' };
  if (kind === 'ranked') return { kind: 'search', queue: { kind: 'ranked', modes: prefs.rankedModes, region: prefs.region, net: 'server' } };
  return { kind: 'search', queue: { kind: 'casual', modes: prefs.casualModes, region: prefs.region, net: queueNet(prefs.net) } };
}

/** CAMBIAR MODO: MODOS' tab where this kind's format is picked. */
export function changeTab(kind: FinalKind): ModeTab {
  return kind === 'ranked' ? 'ranked' : kind === 'ai' ? 'ai' : kind === 'lobby' ? 'lobbies' : 'casual';
}

/** The rank card: a rating change on its way, done (tier, MMR, change, the way to the next tier), or none to show. */
export type RankCard =
  | { readonly state: 'waiting' }
  | { readonly state: 'pending' }
  | { readonly state: 'cancelled'; readonly reason: string }
  | {
      readonly state: 'done';
      readonly tierId: string | null;
      readonly mmr: number;
      readonly delta: number;
      /** Placement matches still to play (0: placed). */
      readonly placementLeft: number;
      /** 0..1 along the tier before the change, and after it. */
      readonly from: number;
      readonly to: number;
      /** The next tier's id and the MMR it still takes, null at the top. */
      readonly nextId: string | null;
      readonly toNext: number;
      readonly banUntil: number;
    };

export function rankCard(r: RankedResultAnswer | null): RankCard {
  if (r === null) return { state: 'waiting' };
  if (r.status === 'pending') return { state: 'pending' };
  if (r.status === 'cancelled') return { state: 'cancelled', reason: r.reason };
  const tier = tierOf(r.mmrAfter);
  const next = TIERS[TIERS.indexOf(tier) + 1] ?? null;
  const to = tierProgress(r.mmrAfter);
  // The bar shows the change inside the tier the player is in now (a promotion starts it at 0).
  const from = tierOf(r.mmrBefore).id === tier.id ? tierProgress(r.mmrBefore) : r.mmrAfter >= r.mmrBefore ? 0 : 1;
  return {
    state: 'done',
    tierId: r.tierAfter,
    mmr: r.mmrAfter,
    delta: r.mmrAfter - r.mmrBefore,
    placementLeft: r.placementLeft,
    from: Math.min(from, to),
    to: Math.max(from, to),
    nextId: next !== null ? next.id : null,
    toNext: next !== null ? Math.max(0, next.min - r.mmrAfter) : 0,
    banUntil: r.banUntil,
  };
}
