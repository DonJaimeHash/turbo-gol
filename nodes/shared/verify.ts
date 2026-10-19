/**
 * Replay verification: re-simulate a match from its replay and check that the node told the truth.
 *
 * The verifier builds a fresh arena with the same roster and kickoff seed, wraps it in the SAME
 * RoomHost the node ran (server/src/roomHost.ts: match rules, bot teams, kickoff seeds), feeds
 * every human slot the recorded applied controls tick by tick, applies the recorded takeovers and
 * compares the state hash at every checkpoint. Bots are recomputed, never read from the replay.
 *
 * Takeovers: a slot only becomes a bot when its player asked to leave (POST /api/leave, relayed by
 * the control plane). The job lists those players; a takeover of anyone else fails the replay
 * ('bad_takeover'), so a node cannot invent a leave.
 *
 * Then the end of the match must be consistent with the recorded END, and every ending needs its
 * proof in the replay:
 *
 *   rules    the rules engine itself ended the match exactly at the END tick, same score and winner
 *   forfeit  the rules had not ended it; every human of the forfeiting team either left (takeover)
 *            or applied all-zero controls for the last 60 s (what a disconnected slot gets)
 *   ttl      the match was in overtime (the wall-clock TTL can only catch an overtime: a regulation
 *            that ends untied ends by the rules); tied, so a draw. The control plane also checks
 *            the TTL against its own clock.
 *   left     every human left (a takeover each; the last one lands at end + 1)
 *   empty    every human left or was gone (all-zero controls) for the last EMPTY_PROOF_TICKS
 *
 * The verdict also carries what the control plane must take from the replay instead of the node's
 * word: the end reason, the forfeiting team, the proven leaves and each slot's present ticks (the
 * host's reward is computed from those).
 *
 * Platform-agnostic: the caller supplies the arena factory (node: shared/nodeArena.ts; workerd:
 * server/src/wasm.ts createHostArena), so the same code can run on a verifier node, in tests or in
 * a Durable Object.
 */
import { RoomHost } from '../../server/src/roomHost';
import type { HostSim, RosterEntry } from '../../server/src/roomHost';
import { PACKED_INPUT_BYTES, TICK_RATE } from '../../src/sim/types';
import { TTL_AFTER_MATCH_SECONDS } from './controlProtocol';
import type { MatchAssignment, VerifyCode, VerifyVerdict } from './controlProtocol';

export { TTL_AFTER_MATCH_SECONDS };
import { ReplayError, decodeReplay } from './replay';
import type { Replay } from './replay';

/** MatchDO's RANKED_DC_FORFEIT_MS (60 s) in ticks. */
export const FORFEIT_DC_TICKS = 60 * TICK_RATE;
/** An 'empty' ending: every human still in the match applied all-zero controls at least this long before the end. */
export const EMPTY_PROOF_TICKS = 1 * TICK_RATE;
/** All-zero controls this long count as absent for the reward (a disconnected slot gets zeros). */
export const ABSENT_TICKS = 10 * TICK_RATE;
/** Hard cap for unlimited matches (length 0). */
export const UNLIMITED_CAP_SECONDS = 2 * 60 * 60;
/** The re-simulation yields to the event loop this often (ticks), so a node that also hosts keeps ticking its matches. */
const YIELD_EVERY_TICKS = 60;

export type SimFactory = (roster: readonly RosterEntry[], kickoffSeed: number) => Promise<HostSim>;

export interface VerifyOptions {
  makeSim: SimFactory;
  /** SHA-256 of the wasm this verifier runs: the match must have been played on the same bytes. */
  wasmSha256: string;
  /** src/net/protocol.ts PROTOCOL_VERSION of this verifier. */
  protocol: number;
  /**
   * The node release this verifier runs (BuildId.version). When given, the replay must come from
   * the same release: the release carries the match's JavaScript (rules, bots, arena mesh).
   */
  version?: string;
  /** The control plane's record of the match: the replay header must agree with it. */
  expect?: MatchAssignment;
  /** The node the control plane placed the match on. */
  expectNodeId?: string;
  /** Players whose leave the control plane relayed (VerifyJob.leaves). Absent: takeovers are not checked (tests). */
  leaves?: readonly string[];
  /** Yield to the event loop every few hundred ticks (a node: setImmediate). Absent: one synchronous loop. */
  yieldFn?: () => Promise<void>;
}

function verdict(code: VerifyCode, extra: Partial<VerifyVerdict> = {}): VerifyVerdict {
  return {
    ok: code === 'ok',
    code,
    ticks: 0,
    score: { blue: 0, red: 0 },
    winner: -1,
    finalHash: 0,
    cpuMs: 0,
    ...extra,
  };
}

function sameRoster(a: readonly RosterEntry[], b: readonly RosterEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.slot !== y.slot || x.team !== y.team || x.kind !== y.kind || (x.playerId ?? null) !== (y.playerId ?? null)) return false;
  }
  return true;
}

/** Why the header disagrees with the control plane's record, or null when it agrees. */
export function headerMismatch(r: Replay, expect: MatchAssignment | undefined, nodeId: string | undefined): string | null {
  const h = r.header;
  if (nodeId !== undefined && h.nodeId !== nodeId) return 'nodeId';
  if (!expect) return null;
  if (h.matchId !== expect.matchId) return 'matchId';
  if (h.mode !== expect.mode) return 'mode';
  if (h.ranked !== expect.ranked) return 'ranked';
  if (h.region !== expect.region) return 'region';
  if (!sameRoster(h.roster, expect.roster)) return 'roster';
  if (h.matchLengthSeconds !== expect.matchLengthSeconds) return 'matchLengthSeconds';
  if (h.kickoffSeed !== expect.kickoffSeed) return 'kickoffSeed';
  if (h.botDifficulty !== expect.botDifficulty) return 'botDifficulty';
  if ((h.kickoffCountdownSeconds ?? null) !== (expect.kickoffCountdownSeconds ?? null)) return 'kickoffCountdownSeconds';
  if ((h.goalPauseSeconds ?? null) !== (expect.goalPauseSeconds ?? null)) return 'goalPauseSeconds';
  return null;
}

function maxTicksFor(lengthSeconds: number): number {
  // The node's TTL whistles any match TTL_AFTER_MATCH_SECONDS after its regulation (an unlimited one
  // after TTL_AFTER_MATCH_SECONDS); 120 s of slack for the join window.
  const s = lengthSeconds > 0 ? lengthSeconds + TTL_AFTER_MATCH_SECONDS + 120 : Math.min(UNLIMITED_CAP_SECONDS, TTL_AFTER_MATCH_SECONDS + 120);
  return Math.ceil(s * TICK_RATE);
}

function allZero(data: Int8Array, off: number): boolean {
  for (let k = 0; k < PACKED_INPUT_BYTES; k++) if (data[off + k] !== 0) return false;
  return true;
}

/** The first takeover of `slot` at or before `limit`, or -1. */
function takeoverTick(r: Replay, slot: number, limit: number): number {
  for (const t of r.takeovers) if (t.slot === slot && t.tick <= limit) return t.tick;
  return -1;
}

/**
 * True when `slot` applied all-zero controls for at least `ticks` ticks before (and through)
 * `endTick`: its last recorded change at or before the end is a zero one, old enough. A slot with
 * no record at all never sent anything (zeros from the first tick).
 */
function zeroAtEnd(r: Replay, slot: number, endTick: number, ticks: number): boolean {
  let lastIdx = -1;
  for (let i = 0; i < r.inputCount; i++) {
    if (r.inputTicks[i] > endTick) break;
    if (r.inputSlots[i] === slot) lastIdx = i;
  }
  if (lastIdx < 0) return endTick >= ticks;
  if (!allZero(r.inputData, lastIdx * PACKED_INPUT_BYTES)) return false;
  return r.inputTicks[lastIdx] <= endTick - ticks + 1;
}

/** The tick `slot` was gone from: its takeover, or the start of its final all-zero stretch; -1 when still playing at the end. */
function goneTick(r: Replay, slot: number, endTick: number): number {
  const tk = takeoverTick(r, slot, endTick + 1);
  if (tk >= 0) return tk;
  let lastIdx = -1;
  for (let i = 0; i < r.inputCount; i++) {
    if (r.inputTicks[i] > endTick) break;
    if (r.inputSlots[i] === slot) lastIdx = i;
  }
  if (lastIdx < 0) return 1;
  return allZero(r.inputData, lastIdx * PACKED_INPUT_BYTES) ? r.inputTicks[lastIdx] : -1;
}

/**
 * Forfeit proof for `team`: at least one human, and each of them left (a takeover at or before
 * end + 1) or held all-zero applied controls for the FORFEIT_DC_TICKS before the end.
 */
function forfeitProven(r: Replay, team: 0 | 1, endTick: number): boolean {
  let humans = 0;
  for (const e of r.header.roster) {
    if (e.kind !== 'player' || e.team !== team) continue;
    humans++;
    if (takeoverTick(r, e.slot, endTick + 1) >= 0) continue;
    if (!zeroAtEnd(r, e.slot, endTick, FORFEIT_DC_TICKS)) return false;
  }
  return humans > 0;
}

/** Every human left (a takeover at or before end + 1). */
function allLeft(r: Replay, endTick: number): boolean {
  let humans = 0;
  for (const e of r.header.roster) {
    if (e.kind !== 'player') continue;
    humans++;
    if (takeoverTick(r, e.slot, endTick + 1) < 0) return false;
  }
  return humans > 0;
}

/** Every human left or was gone (all-zero controls) for the last EMPTY_PROOF_TICKS. */
function allGone(r: Replay, endTick: number): boolean {
  for (const e of r.header.roster) {
    if (e.kind !== 'player') continue;
    if (takeoverTick(r, e.slot, endTick + 1) >= 0) continue;
    if (!zeroAtEnd(r, e.slot, endTick, EMPTY_PROOF_TICKS)) return false;
  }
  return true;
}

/**
 * Ticks each human slot was present: from tick 1 to the end (or to its takeover), minus every
 * all-zero stretch of ABSENT_TICKS or more (before the first input, or a disconnection).
 */
export function presentTicks(r: Replay, endTick: number): number[] {
  const roster = r.header.roster;
  const out = new Array<number>(roster.length).fill(0);
  for (const e of roster) {
    if (e.kind !== 'player') continue;
    const tk = takeoverTick(r, e.slot, endTick + 1);
    const last = tk >= 0 ? Math.min(endTick, tk - 1) : endTick;
    if (last < 1) continue;
    let present = 0;
    let segStart = 1;
    let segZero = true; // every slot starts with zero controls
    const close = (until: number) => {
      const len = Math.max(0, Math.min(until, last + 1) - segStart);
      if (!(segZero && len >= ABSENT_TICKS)) present += len;
    };
    for (let i = 0; i < r.inputCount; i++) {
      const t = r.inputTicks[i];
      if (t > last) break;
      if (r.inputSlots[i] !== e.slot) continue;
      const zero = allZero(r.inputData, i * PACKED_INPUT_BYTES);
      if (zero === segZero) continue;
      close(t);
      segStart = t;
      segZero = zero;
    }
    close(last + 1);
    out[e.slot] = present;
  }
  return out;
}

export async function verifyReplay(input: Uint8Array | Replay, opts: VerifyOptions): Promise<VerifyVerdict> {
  const t0 = performance.now();
  let r: Replay;
  try {
    r = input instanceof Uint8Array ? decodeReplay(input) : input;
  } catch (e) {
    return verdict('bad_replay', { message: e instanceof ReplayError ? e.message : String(e) });
  }
  const h = r.header;
  const end = r.end;
  if (!end) return verdict('bad_replay', { message: 'no END record' });
  if (h.build.wasmSha256 !== opts.wasmSha256 || h.build.protocol !== opts.protocol || (opts.version !== undefined && h.build.version !== opts.version)) {
    return verdict('build_mismatch', { message: `replay wasm ${h.build.wasmSha256.slice(0, 12)} / protocol ${h.build.protocol} / release ${h.build.version}` });
  }
  const mismatch = headerMismatch(r, opts.expect, opts.expectNodeId);
  if (mismatch) return verdict('header_mismatch', { message: mismatch });
  if (end.tick > maxTicksFor(h.matchLengthSeconds)) return verdict('too_long', { message: `${end.tick} ticks` });
  // Every checkpoint must be there: a node that drops hashes would make divergences invisible.
  const every = h.checkpointEvery;
  const wantHashes = Math.floor(end.tick / every);
  if (r.hashCount !== wantHashes) return verdict('bad_replay', { message: `checkpoints ${r.hashCount}, expected ${wantHashes}` });
  for (let k = 0; k < r.hashCount; k++) if (r.hashTicks[k] !== (k + 1) * every) return verdict('bad_replay', { message: 'checkpoint ticks' });
  // A takeover is a player's explicit leave: a human slot, during the match, asked through the control plane.
  const leaves = opts.leaves ? new Set(opts.leaves) : null;
  for (const t of r.takeovers) {
    const e = h.roster[t.slot];
    if (!e || e.kind !== 'player' || t.tick < 1 || t.tick > end.tick + 1) return verdict('bad_takeover', { message: `slot ${t.slot} at ${t.tick}` });
    if (leaves && !leaves.has(e.playerId ?? '')) return verdict('bad_takeover', { message: `slot ${t.slot}: no leave was relayed for this player` });
  }

  try {
    const sim = await opts.makeSim(h.roster, h.kickoffSeed);
    const host = new RoomHost(sim, h.roster, {
      tickRate: TICK_RATE,
      snapshotEvery: 4,
      matchLengthSeconds: h.matchLengthSeconds,
      kickoffSeed: h.kickoffSeed,
      botDifficulty: h.botDifficulty,
      kickoffCountdownSeconds: h.kickoffCountdownSeconds,
      goalPauseSeconds: h.goalPauseSeconds,
    });
    host.start();
    const slots = h.roster.length;
    const cur = new Int8Array(slots * PACKED_INPUT_BYTES);
    let ii = 0;
    let ti = 0;
    let hi = 0;
    const E = end.tick;
    for (let T = 1; T <= E; T++) {
      if (opts.yieldFn && T % YIELD_EVERY_TICKS === 0) await opts.yieldFn();
      while (ti < r.takeovers.length && r.takeovers[ti].tick <= T) {
        host.convertToBot(r.takeovers[ti].slot);
        ti++;
      }
      while (ii < r.inputCount && r.inputTicks[ii] === T) {
        const s = r.inputSlots[ii];
        for (let k = 0; k < PACKED_INPUT_BYTES; k++) cur[s * PACKED_INPUT_BYTES + k] = r.inputData[ii * PACKED_INPUT_BYTES + k];
        ii++;
      }
      for (let s = 0; s < slots; s++) if (host.isHumanSlot(s)) host.addInputs(s, T, 1, cur, s * PACKED_INPUT_BYTES);
      host.tick();
      if (hi < r.hashCount && r.hashTicks[hi] === T) {
        const got = sim.stateHash() >>> 0;
        if (got !== r.hashValues[hi]) {
          return verdict('hash_mismatch', { divergedAtTick: T, ticks: T, score: { ...host.score }, cpuMs: performance.now() - t0, message: `tick ${T}: ${got} != ${r.hashValues[hi]}` });
        }
        hi++;
      }
      if (host.ended && T < E) {
        return verdict('end_mismatch', { ticks: T, score: { ...host.score }, cpuMs: performance.now() - t0, message: `the rules ended the match at tick ${T}, the replay ends at ${E}` });
      }
    }

    const score = { blue: host.score.blue, red: host.score.red };
    const leader: 0 | 1 | -1 = score.blue > score.red ? 0 : score.red > score.blue ? 1 : -1;
    const leftSlots = h.roster.filter((e) => e.kind === 'player' && takeoverTick(r, e.slot, E + 1) >= 0).map((e) => e.slot);
    const leftTicks = leftSlots.map((s) => takeoverTick(r, s, E + 1));
    const goneTicks = h.roster.map((e) => (e.kind === 'player' ? goneTick(r, e.slot, E) : -1));
    const base: Partial<VerifyVerdict> = {
      ticks: E,
      score,
      finalHash: sim.stateHash() >>> 0,
      endReason: end.reason,
      ...(end.forfeitTeam === 0 || end.forfeitTeam === 1 ? { forfeitTeam: end.forfeitTeam } : {}),
      presentTicks: presentTicks(r, E),
      leftSlots,
      leftTicks,
      goneTicks,
    };
    const done = (code: VerifyCode, winner: 0 | 1 | -1, message?: string): VerifyVerdict =>
      verdict(code, { ...base, winner, cpuMs: performance.now() - t0, ...(message ? { message } : {}) });

    if (score.blue !== end.blue || score.red !== end.red) return done('score_mismatch', leader, `recorded ${end.blue}-${end.red}`);
    switch (end.reason) {
      case 'rules': {
        if (!host.ended) return done('end_mismatch', leader, 'the rules had not ended the match');
        const w = host.match.winner;
        const winner: 0 | 1 | -1 = w === 0 || w === 1 ? w : -1;
        if (winner !== end.winner) return done('end_mismatch', winner, 'winner');
        return done('ok', winner);
      }
      case 'forfeit': {
        if (host.ended) return done('end_mismatch', leader, 'the rules had already ended the match');
        if (end.forfeitTeam !== 0 && end.forfeitTeam !== 1) return done('end_mismatch', leader, 'no forfeit team');
        const winner: 0 | 1 = end.forfeitTeam === 0 ? 1 : 0;
        if (end.winner !== winner) return done('end_mismatch', winner, 'forfeit winner');
        if (!forfeitProven(r, end.forfeitTeam, E)) return done('forfeit_unproven', winner);
        return done('ok', winner);
      }
      case 'ttl': {
        if (host.ended) return done('end_mismatch', leader, 'the rules had already ended the match');
        if (h.matchLengthSeconds > 0 && !host.match.overtime) return done('end_mismatch', leader, 'ttl outside overtime');
        if (end.winner !== leader) return done('end_mismatch', leader, 'ttl winner');
        return done('ok', leader);
      }
      case 'left': {
        if (host.ended) return done('end_mismatch', leader, 'the rules had already ended the match');
        if (!allLeft(r, E)) return done('end_mismatch', leader, "'left' but not every human left");
        if (end.winner !== leader) return done('end_mismatch', leader, 'winner');
        return done('ok', leader);
      }
      case 'empty': {
        if (host.ended) return done('end_mismatch', leader, 'the rules had already ended the match');
        if (!allGone(r, E)) return done('end_mismatch', leader, "'empty' but a human was still playing");
        if (end.winner !== leader) return done('end_mismatch', leader, 'winner');
        return done('ok', leader);
      }
      default:
        return done('end_mismatch', leader, `unknown end reason ${String(end.reason)}`);
    }
  } catch (e) {
    return verdict('error', { message: String(e instanceof Error ? e.message : e), cpuMs: performance.now() - t0 });
  }
}
