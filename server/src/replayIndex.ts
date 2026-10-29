/**
 * The public replay index (src/net/replays.ts): one row per settled, not voided community-node
 * match with a replay, written by NodeStore.finished right after the transaction that settles it,
 * the public form of a row (publicItem), and the header rewrite that makes a stored replay public.
 *
 * What a viewer gets is safe to give anyone: the names, teams and score come from the control
 * plane's record (assign.roster, the outcome), never from the node's replay header (a node writes
 * whatever names it likes there; verify.ts does not compare them). Account ids and the node id are
 * never listed and are blanked from the served header: an account id is stable across renames, so
 * publishing it would link every match an account plays. The ids stay in the object (nodeStore.ts
 * replay_players, from replaySeats) for one thing: the names of the accounts that hide theirs
 * (PERFIL; AccountsDO replay_names) become 'Jugador N' when a row is served (publicItem), so a
 * choice reaches the matches listed before it too.
 *
 * Privacy by time: a match is served an hour after it settled (REPLAY_LIST_DELAY_MS), its time
 * rounded down to the hour, and never after REPLAY_INDEX_DAYS: a list that refreshes every 30 s
 * would otherwise say who is playing right now.
 */
import type { MatchEntry, MatchOutcome } from '../../nodes/control-plane/controlPlane';
import { hiddenNameOf } from '../../src/net/replays';
import type { ReplayListItem } from '../../src/net/replays';

/** R2's lifecycle rule (docs/replays.md): a replay lives 30 days, its row the same; nothing older is served. */
export const REPLAY_INDEX_DAYS = 30;
export const HOUR_MS = 60 * 60_000;
/** A settled match is served (listed, viewed) this long after it settled, not before. */
export const REPLAY_LIST_DELAY_MS = HOUR_MS;

/** The row of a settled match, or null when it is not listed (void, no replay, or a replay too big to serve). */
export function replayIndexItem(m: MatchEntry, o: MatchOutcome): ReplayListItem | null {
  if (o.kind === 'void' || !m.replaySha) return null;
  // The node's own count: a bigger one could never be served (replayView refuses it unread), so it is not listed.
  if (m.report?.kind === 'ended' && m.report.replayBytes > PUBLIC_REPLAY_MAX_BYTES) return null;
  const a = m.assign;
  return {
    matchId: a.matchId,
    at: m.doneAt,
    mode: a.mode,
    region: a.region,
    ranked: a.ranked,
    verified: o.kind === 'rated' ? true : o.verified,
    blue: o.blue,
    red: o.red,
    ticks: m.verdict?.ticks ?? (m.report?.kind === 'ended' ? m.report.result.endTick : 0),
    players: a.roster.map((e) => ({ team: e.team, name: e.name, bot: e.kind === 'bot' })),
    build: { version: m.build.version, protocol: m.build.protocol, wasmSha256: m.build.wasmSha256 },
  };
}

/** A human seat of a listed match, kept in the object only: whose choice to ask AccountsDO for (a guest's id finds none). */
export interface ReplaySeat {
  slot: number;
  /** The session's id: an account's or a guest's. */
  playerId: string;
}

/** The human seats of a settled match that carry a player id (bots have none). */
export function replaySeats(m: MatchEntry): ReplaySeat[] {
  const out: ReplaySeat[] = [];
  m.assign.roster.forEach((e, slot) => {
    if (e.kind === 'player' && typeof e.playerId === 'string' && e.playerId !== '') out.push({ slot, playerId: e.playerId });
  });
  return out;
}

/**
 * A stored row as the public sees it: the time rounded down to the hour, and the name of each
 * slot in `hidden` replaced by 'Jugador N'. A new object: the stored one is never changed.
 */
export function publicItem(item: ReplayListItem, hidden: ReadonlySet<number>): ReplayListItem {
  return {
    ...item,
    at: Math.floor(item.at / HOUR_MS) * HOUR_MS,
    players: item.players.map((p, slot) => (!p.bot && hidden.has(slot) ? { ...p, name: hiddenNameOf(slot) } : { ...p })),
    build: { ...item.build },
  };
}

/** The listed row as stored (the sha is kept apart: the Worker checks the R2 object against it). */
export interface ReplayIndexRow {
  item: ReplayListItem;
  sha: string;
}

/** nodes/shared/replay.ts's magic, header cap and record sizes (not imported: that file is a node release input). */
const MAGIC = [0x54, 0x47, 0x52, 0x31];
const HEADER_MAX = 64 * 1024;
const REC_INPUT = 1;
const REC_TAKEOVER = 2;
const REC_HASH = 3;
const REC_END = 4;
const REC_SIZE: Record<number, number> = { [REC_INPUT]: 12, [REC_TAKEOVER]: 6, [REC_HASH]: 9, [REC_END]: 12 };

/**
 * The largest replay served to the public. A node may upload up to 16 MiB (REPLAY_MAX_BYTES), but a
 * real match is far smaller: a human changes controls a few times a second (12 bytes each), so a
 * 3-minute 3v3 is a few hundred KB at the very most. A bigger object is junk a node stored, and the
 * Worker would read, hash and copy all of it for every view.
 */
export const PUBLIC_REPLAY_MAX_BYTES = 4 * 1024 * 1024;

const DIFFICULTIES = new Set(['easy', 'medium', 'hard']);

function fail(msg: string): never {
  throw new Error(msg);
}

/** A number the header may carry: finite, within [min, max], an integer when asked. */
function num(v: unknown, what: string, min: number, max: number, integer = false): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) fail(`header ${what}`);
  return v;
}

/**
 * The records after the header, walked as decodeReplay walks them: known types and sizes only, the
 * slots inside the roster, END last and exactly at the end of the bytes. The viewer validates the
 * rest (order, ticks) with decodeReplay itself; this keeps the public route from serving anything
 * that is not a replay's records.
 */
function checkRecords(bytes: Uint8Array, from: number, slots: number): void {
  let p = from;
  while (p < bytes.length) {
    const type = bytes[p];
    const size = REC_SIZE[type];
    if (size === undefined) fail(`unknown record type ${type}`);
    if (p + size > bytes.length) fail('truncated record');
    if ((type === REC_INPUT || type === REC_TAKEOVER) && bytes[p + 5] >= slots) fail('record slot');
    if (type === REC_END && p + size !== bytes.length) fail('record after END');
    p += size;
  }
}

/**
 * The stored replay made public. Its header is rebuilt from an allow-list, never copied: the
 * match's identity, mode, region, ranked flag and build are the control plane's (`item`); the
 * simulation settings (length, seed, bots, timings, checkpoints) are the node's, type-checked; the
 * roster must be the control plane's one slot for slot (same teams, same humans and bots), with its
 * names (`item` as publicItem made it: a hidden one is 'Jugador N') and no account id (an empty
 * playerId still decodes); the node id is blank and the start time 0. Anything else a
 * node wrote is dropped. The records after the header are checked (checkRecords) and kept byte for
 * byte, so the simulation is the recorded one. Throws on anything that does not read or agree.
 */
export function publicReplay(bytes: Uint8Array, item: ReplayListItem): Uint8Array {
  if (bytes.length > PUBLIC_REPLAY_MAX_BYTES) fail('replay too large');
  if (bytes.length < 8) fail('replay too short');
  for (let i = 0; i < 4; i++) if (bytes[i] !== MAGIC[i]) fail('bad magic');
  const hlen = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  if (hlen > HEADER_MAX || 8 + hlen > bytes.length) fail('bad header length');
  const raw: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + hlen)));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('bad header');
  const h = raw as Record<string, unknown>;
  if (h.v !== 1) fail('header version');
  const roster = h.roster;
  const players = item.players;
  if (!Array.isArray(roster) || roster.length !== players.length || roster.length < 1 || roster.length > 8) fail('header roster');
  const outRoster = roster.map((e: unknown, i: number) => {
    const x = (e && typeof e === 'object' ? e : {}) as { slot?: unknown; team?: unknown; kind?: unknown };
    const p = players[i];
    if (x.slot !== i || x.team !== p.team || (x.kind !== 'player' && x.kind !== 'bot') || (x.kind === 'bot') !== p.bot) fail(`roster[${i}]`);
    return x.kind === 'player' ? { slot: i, team: p.team, kind: 'player', name: p.name, playerId: '' } : { slot: i, team: p.team, kind: 'bot', name: p.name };
  });
  if (typeof h.botDifficulty !== 'string' || !DIFFICULTIES.has(h.botDifficulty)) fail('header botDifficulty');
  const header: Record<string, unknown> = {
    v: 1,
    matchId: item.matchId,
    nodeId: '',
    build: { version: item.build.version, protocol: item.build.protocol, wasmSha256: item.build.wasmSha256 },
    mode: item.mode,
    region: item.region,
    ranked: item.ranked,
    roster: outRoster,
    matchLengthSeconds: num(h.matchLengthSeconds, 'matchLengthSeconds', 0, 24 * 3600),
    kickoffSeed: num(h.kickoffSeed, 'kickoffSeed', -(2 ** 31), 2 ** 32, true),
    botDifficulty: h.botDifficulty,
    tickRate: num(h.tickRate, 'tickRate', 120, 120),
    checkpointEvery: num(h.checkpointEvery, 'checkpointEvery', 1, 1_000_000, true),
    // When it started is not the public's (a node may write the wall clock): the list says the hour.
    startedAt: 0,
  };
  for (const k of ['kickoffCountdownSeconds', 'goalPauseSeconds'] as const) if (h[k] !== undefined) header[k] = num(h[k], k, 0, 30);
  checkRecords(bytes, 8 + hlen, roster.length);
  const json = new TextEncoder().encode(JSON.stringify(header));
  const rest = bytes.subarray(8 + hlen);
  const out = new Uint8Array(8 + json.length + rest.length);
  out.set(bytes.subarray(0, 4), 0);
  new DataView(out.buffer).setUint32(4, json.length, true);
  out.set(json, 8);
  out.set(rest, 8 + json.length);
  return out;
}
