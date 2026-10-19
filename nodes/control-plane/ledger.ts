/**
 * Rewards ledger (docs/RECOMPENSAS.md). Pure logic.
 *
 * Unit: one point per VERIFIED player-minute served. What counts is useful work proven by the
 * re-simulation, never hardware or money: a home PC and a rented VPS earn the same for the same
 * minutes. The minutes come from the verifier (each human slot's present ticks in the replay);
 * the node's own connected time can only lower them. Points are not money and cannot be transferred: they are spent in the hosts' shop
 * (control-plane/shop.ts) on new cars and other items that only people who share their machine
 * can get.
 *
 *   points = sum over counted players of minutes x weight
 *            x regionFactor   (0.5 .. 3: scarce regions pay more, oversupplied ones less; taken
 *                              when the match is placed, see ControlPlane.regionFactorAt)
 *            x quality        (0.5 / 1.0 from the node's tick lag and the players' underruns.
 *                              The node measures both itself, so they can only lower the points:
 *                              the 1.2 bonus waits for quality measured by the players' clients)
 *            x repeat         (1 / (1 + same group on the same operator in the last 24 h))
 *
 * Anti-farming:
 *   - only matches the matchmaker placed (a node cannot create matches) and that verified
 *   - the operator's own minutes never count (and they never play ranked on their own nodes)
 *   - guests and accounts younger than NEW_ACCOUNT_DAYS weigh 0.25
 *   - the same group of players on the same operator decays within 24 h
 *   - a failed verification is worth 0, suspends the node and freezes the operator's wallet
 */
import type { EndReason, GameMode } from '../shared/controlProtocol';

export interface LedgerPlayer {
  playerId: string;
  connectedMs: number;
  /** A registered account (false = guest). */
  account: boolean;
  accountAgeDays: number;
}

export interface CreditInput {
  matchId: string;
  nodeId: string;
  operatorId: string;
  region: string;
  mode: GameMode;
  ranked: boolean;
  verified: boolean;
  endReason: EndReason;
  players: LedgerPlayer[];
  tickLagP99Ms: number;
  /** Underruns / (ticks x humans), 0..1. */
  underrunRate: number;
  at: number;
  /**
   * The share of such matches that get verified (1 = every one). Casual matches of an active node
   * are verified by sample, and only verified matches earn: each one counts 1 / sampleRate, so the
   * operator earns the same on average.
   */
  sampleRate?: number;
}

export interface LedgerEntry extends CreditInput {
  points: number;
  playerMinutes: number;
  weightedMinutes: number;
  regionFactor: number;
  quality: number;
  repeat: number;
}

export const WINDOW_DAYS = 30;
export const NEW_ACCOUNT_DAYS = 7;
export const LOW_WEIGHT = 0.25;
export const REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Self-reported quality (tick lag, underruns measured by the node) never raises the points. */
export const SELF_REPORTED_QUALITY_CAP = 1.0;

/** 1.2 / 1.0 / 0.5 from the tick lag and the underrun rate (the 1.2 tier only with client-measured inputs). */
export function qualityFactor(tickLagP99Ms: number, underrunRate: number, selfReported = true): number {
  let q = 0.5;
  if (tickLagP99Ms <= 4 && underrunRate <= 0.01) q = 1.2;
  else if (tickLagP99Ms <= 12 && underrunRate <= 0.05) q = 1.0;
  return selfReported ? Math.min(SELF_REPORTED_QUALITY_CAP, q) : q;
}

/**
 * Region factor from demand (matches running or wanted in the region, the credited one included)
 * and supply (match slots the region's online hosts offer): 0.5 + demand / supply, clamped to
 * 0.5 .. 3. One node with one slot hosting one match at a time: 1.5.
 */
export function regionFactor(demandMatches: number, supplyMatchSlots: number): number {
  const f = 0.5 + demandMatches / Math.max(1, supplyMatchSlots);
  return Math.round(Math.max(0.5, Math.min(3, f)) * 100) / 100;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

export interface OperatorSummary {
  operatorId: string;
  /** Points earned over the last WINDOW_DAYS (activity). */
  points30d: number;
  /** Points earned since the beginning (what the shop balance starts from). */
  earned: number;
  matches30d: number;
  playerMinutes30d: number;
  byNode: Record<string, { points: number; matches: number }>;
}

export class Ledger {
  private readonly entries: LedgerEntry[] = [];
  private readonly groups = new Map<string, number[]>();
  private readonly totals = new Map<string, number>();
  private readonly verified = new Map<string, number>();

  /** Score a match and append it. `regionFactorValue` comes from the control plane's demand / supply view. */
  record(input: CreditInput, regionFactorValue: number): LedgerEntry {
    let playerMinutes = 0;
    let weighted = 0;
    const counted: string[] = [];
    for (const p of input.players) {
      const minutes = Math.max(0, p.connectedMs) / 60_000;
      playerMinutes += minutes;
      if (p.playerId === input.operatorId) continue;
      const w = p.account && p.accountAgeDays >= NEW_ACCOUNT_DAYS ? 1 : LOW_WEIGHT;
      weighted += minutes * w;
      counted.push(p.playerId);
    }
    const quality = qualityFactor(input.tickLagP99Ms, input.underrunRate);
    this.prune(input.at);
    const key = input.operatorId + '|' + counted.sort().join(',');
    const times = (this.groups.get(key) ?? []).filter((t) => input.at - t < REPEAT_WINDOW_MS);
    const repeat = counted.length === 0 ? 0 : 1 / (1 + times.length);
    times.push(input.at);
    this.groups.set(key, times);
    const sample = input.sampleRate !== undefined && input.sampleRate > 0 && input.sampleRate <= 1 ? input.sampleRate : 1;
    const points = input.verified ? round2((weighted * regionFactorValue * quality * repeat) / sample) : 0;
    const entry: LedgerEntry = {
      ...input,
      points,
      playerMinutes: round2(playerMinutes),
      weightedMinutes: round2(weighted),
      regionFactor: regionFactorValue,
      quality,
      repeat,
    };
    this.entries.push(entry);
    this.totals.set(input.operatorId, round2((this.totals.get(input.operatorId) ?? 0) + points));
    if (input.verified) this.verified.set(input.operatorId, (this.verified.get(input.operatorId) ?? 0) + 1);
    return entry;
  }

  /**
   * One more match of this group on this operator that earns nothing by itself (a casual match
   * that was not sampled for verification). The repeat decay must still see it: the sampled ones
   * are worth 1 / rate, and without it a group farming one operator would earn more than if every
   * match were verified.
   */
  noteGroup(operatorId: string, playerIds: readonly string[], at: number): void {
    const counted = playerIds.filter((p) => p !== operatorId);
    if (counted.length === 0) return;
    const key = operatorId + '|' + [...counted].sort().join(',');
    const times = (this.groups.get(key) ?? []).filter((t) => at - t < REPEAT_WINDOW_MS);
    times.push(at);
    this.groups.set(key, times);
  }

  /** Drop entries older than the window and stale repeat groups (the totals stay). */
  private prune(now: number): void {
    const since = now - WINDOW_DAYS * DAY_MS;
    let k = 0;
    while (k < this.entries.length && this.entries[k].at < since) k++;
    if (k > 0) this.entries.splice(0, k);
    if (this.groups.size > 1000) {
      for (const [key, times] of this.groups) if (times.every((t) => now - t >= REPEAT_WINDOW_MS)) this.groups.delete(key);
    }
  }

  /** All points an operator ever earned. */
  earned(operatorId: string): number {
    return this.totals.get(operatorId) ?? 0;
  }

  /** Verified matches an operator's nodes ever hosted. */
  verifiedMatches(operatorId: string): number {
    return this.verified.get(operatorId) ?? 0;
  }

  /** Entries of the last `days` days (newest last). */
  recent(now: number, days = WINDOW_DAYS): LedgerEntry[] {
    const since = now - days * DAY_MS;
    return this.entries.filter((e) => e.at >= since);
  }

  summary(operatorId: string, now: number, days = WINDOW_DAYS): OperatorSummary {
    const mine = this.recent(now, days).filter((e) => e.operatorId === operatorId);
    let points = 0;
    let minutes = 0;
    const byNode: Record<string, { points: number; matches: number }> = {};
    for (const e of mine) {
      points += e.points;
      minutes += e.playerMinutes;
      const b = (byNode[e.nodeId] ??= { points: 0, matches: 0 });
      b.points = round2(b.points + e.points);
      b.matches++;
    }
    return { operatorId, points30d: round2(points), earned: this.earned(operatorId), matches30d: mine.length, playerMinutes30d: round2(minutes), byNode };
  }

  /** Operators by points over the window (the public "Anfitriones" page). */
  leaderboard(now: number, days = WINDOW_DAYS, limit = 50): Array<{ operatorId: string; points: number }> {
    const sums = new Map<string, number>();
    for (const e of this.recent(now, days)) sums.set(e.operatorId, (sums.get(e.operatorId) ?? 0) + e.points);
    return [...sums.entries()]
      .map(([operatorId, p]) => ({ operatorId, points: round2(p) }))
      .filter((e) => e.points > 0)
      .sort((a, b) => b.points - a.points)
      .slice(0, limit);
  }
}
