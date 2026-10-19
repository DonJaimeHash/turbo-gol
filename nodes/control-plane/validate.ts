/**
 * Shape checks for everything a node sends on its control connection. A node runs code nobody
 * reviewed, so nothing it sends is assigned anywhere before it passes through here: the parsers
 * return a fresh object with only the known fields (finite numbers, bounded strings and arrays),
 * or null.
 */
import type { BuildId, EndReason, FromNode, HeartbeatData, HelloData, MatchReport, MatchResult, MatchStats, NodeCapacity, NodeRole, NodeSpecs, NodeTransport, SlotStatsReport } from '../shared/controlProtocol';

const MAX_SLOTS = 8;
const END_REASONS: readonly EndReason[] = ['rules', 'forfeit', 'ttl', 'left', 'empty'];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max ? v : null);
const num = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null);
const int = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | null => (Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? (v as number) : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const HEX64 = /^[0-9a-f]{64}$/;
const ID = /^[0-9A-Za-z_-]{1,64}$/;

export function parseBuild(v: unknown): BuildId | null {
  if (!isObj(v)) return null;
  const version = str(v.version, 32);
  const protocol = int(v.protocol, 0, 1_000_000);
  const wasmSha256 = str(v.wasmSha256, 64);
  if (version === null || !/^[0-9A-Za-z.+-]{1,32}$/.test(version) || protocol === null || wasmSha256 === null || !HEX64.test(wasmSha256)) return null;
  return { version, protocol, wasmSha256 };
}

function parseSpecs(v: unknown): NodeSpecs {
  const o = isObj(v) ? v : {};
  return {
    cpus: int(o.cpus, 0, 4096) ?? 0,
    cpuModel: (str(o.cpuModel, 120) ?? '').replace(/[^\x20-\x7e]/g, ''),
    memMB: int(o.memMB, 0, 1 << 24) ?? 0,
    arch: (str(o.arch, 16) ?? '').replace(/[^\w-]/g, ''),
    os: (str(o.os, 32) ?? '').replace(/[^\w.-]/g, ''),
    node: (str(o.node, 32) ?? '').replace(/[^\w.-]/g, ''),
  };
}

export function parseCapacity(v: unknown, maxMatches: number): NodeCapacity | null {
  if (!isObj(v)) return null;
  const matches = int(v.matches, 1, maxMatches);
  if (matches === null) return null;
  return {
    matches,
    cpuMsPerMatchSecond: num(v.cpuMsPerMatchSecond, 0, 1e6) ?? 0,
    memMBPerMatch: num(v.memMBPerMatch, 0, 1e6) ?? 0,
    uplinkMbps: v.uplinkMbps === null ? null : num(v.uplinkMbps, 0, 1e6),
    source: v.source === 'declared' ? 'declared' : 'bench',
  };
}

export function parseHello(v: unknown, maxMatches: number): HelloData | null {
  if (!isObj(v)) return null;
  const build = parseBuild(v.build);
  const capacity = parseCapacity(v.capacity, maxMatches);
  if (!build || !capacity) return null;
  const roles = Array.isArray(v.roles) ? v.roles.filter((r): r is NodeRole => r === 'host' || r === 'verify').slice(0, 2) : [];
  const transports = Array.isArray(v.transports) ? v.transports.filter((t): t is NodeTransport => t === 'wss' || t === 'rtc').slice(0, 2) : [];
  const publicUrl = v.publicUrl === null || v.publicUrl === undefined ? null : str(v.publicUrl, 200);
  const egressCapGB = v.egressCapGB === null || v.egressCapGB === undefined ? null : num(v.egressCapGB, 0, 1e9);
  const bootId = v.bootId === undefined ? undefined : str(v.bootId, 64);
  if ((v.publicUrl != null && publicUrl === null) || (v.egressCapGB != null && egressCapGB === null) || (bootId !== undefined && (bootId === null || !ID.test(bootId)))) return null;
  return {
    ...(bootId ? { bootId } : {}),
    build,
    roles,
    transports,
    publicUrl,
    rtcReady: v.rtcReady === true,
    rtcRelay: v.rtcRelay === true,
    specs: parseSpecs(v.specs),
    capacity,
    draining: v.draining === true,
    egressCapGB,
  };
}

export function parseHeartbeat(v: unknown, maxMatches: number): HeartbeatData | null {
  if (!isObj(v)) return null;
  const active = int(v.active, 0, maxMatches);
  const capacity = int(v.capacity, 0, maxMatches);
  const draining = bool(v.draining);
  const egressGB = num(v.egressGB, 0, 1e9);
  const egressCapGB = v.egressCapGB == null ? null : num(v.egressCapGB, 0, 1e9);
  const tickLagP99Ms = num(v.tickLagP99Ms, 0, 1e6);
  const cpuLoad = num(v.cpuLoad, 0, 4096);
  const rssMB = num(v.rssMB, 0, 1 << 24);
  if (active === null || capacity === null || draining === null || egressGB === null || (v.egressCapGB != null && egressCapGB === null) || tickLagP99Ms === null || cpuLoad === null || rssMB === null) return null;
  const matches: HeartbeatData['matches'] = [];
  if (Array.isArray(v.matches)) {
    for (const m of v.matches.slice(0, maxMatches)) {
      if (!isObj(m)) continue;
      const matchId = str(m.matchId, 64);
      if (matchId === null) continue;
      matches.push({ matchId, tick: int(m.tick) ?? 0, phase: (str(m.phase, 24) ?? '').replace(/[^\w-]/g, ''), sockets: int(m.sockets, 0, 64) ?? 0 });
    }
  }
  return { active, capacity, draining, egressGB, egressCapGB, tickLagP99Ms, cpuLoad, rssMB, matches };
}

function parseResult(v: unknown): MatchResult | null {
  if (!isObj(v)) return null;
  const winner = v.winner === 0 || v.winner === 1 || v.winner === -1 ? v.winner : null;
  const blue = int(v.blue, 0, 9999);
  const red = int(v.red, 0, 9999);
  const endTick = int(v.endTick, 0, 1e9);
  const endReason = END_REASONS.includes(v.endReason as EndReason) ? (v.endReason as EndReason) : null;
  if (winner === null || blue === null || red === null || endTick === null || endReason === null) return null;
  if (v.forfeitTeam !== undefined && v.forfeitTeam !== 0 && v.forfeitTeam !== 1) return null;
  return { winner, blue, red, endTick, endReason, ...(v.forfeitTeam === 0 || v.forfeitTeam === 1 ? { forfeitTeam: v.forfeitTeam } : {}) };
}

function parseStats(v: unknown): MatchStats | null {
  if (!isObj(v) || !Array.isArray(v.slots)) return null;
  const ticks = int(v.ticks, 0, 1e9);
  const durationMs = num(v.durationMs, 0, 1e10);
  const tickLagP99Ms = num(v.tickLagP99Ms, 0, 1e6);
  const egressBytes = num(v.egressBytes, 0, 1e15);
  if (ticks === null || durationMs === null || tickLagP99Ms === null || egressBytes === null || v.slots.length > MAX_SLOTS) return null;
  const slots: SlotStatsReport[] = [];
  for (const s of v.slots) {
    if (!isObj(s)) return null;
    const slot = int(s.slot, 0, MAX_SLOTS - 1);
    const connectedMs = num(s.connectedMs, 0, 1e10);
    if (slot === null || connectedMs === null) return null;
    slots.push({ slot, received: int(s.received) ?? 0, dropped: int(s.dropped) ?? 0, underruns: int(s.underruns) ?? 0, overruns: int(s.overruns) ?? 0, connectedMs });
  }
  return { ticks, durationMs, slots, tickLagP99Ms, egressBytes };
}

/** A report, or null. Only the match id is read from an invalid one (to settle that match). */
export function parseReport(v: unknown): MatchReport | null {
  if (!isObj(v)) return null;
  const matchId = str(v.matchId, 64);
  if (matchId === null || !ID.test(matchId)) return null;
  switch (v.kind) {
    case 'ended': {
      const result = parseResult(v.result);
      const stats = parseStats(v.stats);
      const replaySha256 = str(v.replaySha256, 64);
      const replayBytes = int(v.replayBytes, 0, 64 * 1024 * 1024);
      if (!result || !stats || replaySha256 === null || !HEX64.test(replaySha256) || replayBytes === null) return null;
      return { kind: 'ended', matchId, result, replaySha256, replayBytes, stats };
    }
    case 'cancelled': {
      const reason = str(v.reason, 32);
      if (reason === null || !Array.isArray(v.noShows) || v.noShows.length > MAX_SLOTS) return null;
      const noShows = v.noShows.filter((p): p is string => typeof p === 'string' && p.length <= 64);
      return { kind: 'cancelled', matchId, reason: reason.replace(/[^\w:-]/g, ''), noShows };
    }
    case 'lost': {
      const reason = str(v.reason, 32);
      if (reason === null) return null;
      return { kind: 'lost', matchId, reason: reason.replace(/[^\w:-]/g, '') };
    }
    default:
      return null;
  }
}

/**
 * A control message: an object with a string `t`. Payloads are validated by the handler of each
 * type (they need the registry's limits); this only rejects what cannot be a message at all.
 */
export function parseFromNode(v: unknown): (FromNode & Obj) | null {
  if (!isObj(v) || typeof v.t !== 'string' || v.t.length > 16) return null;
  if (v.t === 'reply' && (typeof v.rid !== 'string' || v.rid.length > 32 || typeof v.ok !== 'boolean')) return null;
  // Report ids are '<kind>:<matchId>' (node/agent.ts submit): up to 'cancelled:' + a 64-character id.
  if (v.t === 'report' && (typeof v.id !== 'string' || v.id.length > 96)) return null;
  return v as FromNode & Obj;
}

/** The matchId of a report that failed validation, when it has a usable one. */
export function reportMatchId(v: unknown): string | null {
  return isObj(v) && typeof v.matchId === 'string' && ID.test(v.matchId) ? v.matchId : null;
}
