/**
 * Placement: which node hosts a match. Pure function of the registry snapshot and the request.
 *
 * Rules (in order):
 *   1. the node is online (heartbeat within HEARTBEAT_TIMEOUT_MS) and hosts
 *   2. players can reach it with a transport their client supports: 'wss' (proven publicUrl) or
 *      'rtc' (passed its WebRTC self-test; needs a client with the WebRTC socket adapter)
 *   3. status: ranked -> 'active' only; casual -> 'probation' or 'active'
 *   4. same build as the clients (wasm hash + protocol): a different wasm would desync
 *   5. not draining, a free slot (active < capacity), under its monthly egress cap
 *   6. same region as the queue
 *   7. ranked: none of the players is the node's operator (an operator never hosts their own ranked
 *      match: lag games on your own server are the cheapest cheat there is)
 * Among the eligible nodes the least loaded quarter wins and the pick inside it is random, so
 * nobody can predict (or farm) which node a given match lands on.
 *
 * Later (docs/ARQUITECTURA.md): clients probe the region's nodes and the queue carries their RTTs;
 * the score then prefers the lowest worst-player RTT.
 */
import { HEARTBEAT_TIMEOUT_MS, sameBuild, sameSimulation } from '../shared/controlProtocol';
import type { BuildId, GameMode, NodeTransport } from '../shared/controlProtocol';
import { usableTransports } from './registry';
import type { NodeRecord } from './registry';

export interface PlacementRequest {
  region: string;
  mode: GameMode;
  ranked: boolean;
  /** Account / guest ids of the humans in the match. */
  playerIds: string[];
  build: BuildId;
  /** Transports every player's client supports (old clients: ['wss'] only). */
  transports: NodeTransport[];
  now: number;
}

/** The transport players will use on `n` (WebSocket preferred: no ICE, no relay), or null. */
export function transportFor(n: NodeRecord, clientTransports: readonly NodeTransport[]): NodeTransport | null {
  const usable = usableTransports(n);
  if (usable.includes('wss') && clientTransports.includes('wss')) return 'wss';
  if (usable.includes('rtc') && clientTransports.includes('rtc')) return 'rtc';
  return null;
}

/** Why `n` cannot take the match, or null when it can. */
export function ineligibility(n: NodeRecord, req: PlacementRequest): string | null {
  if (!n.online || req.now - n.lastSeen > HEARTBEAT_TIMEOUT_MS) return 'offline';
  if (!n.roles.includes('host')) return 'not_a_host';
  if (usableTransports(n).length === 0) return 'unreachable';
  if (transportFor(n, req.transports) === null) return 'transport';
  if (req.ranked ? n.status !== 'active' : n.status !== 'probation' && n.status !== 'active') return 'status:' + n.status;
  if (!sameBuild(n.build, req.build)) return 'build';
  if (n.draining) return 'draining';
  if (n.active >= n.capacity.matches) return 'full';
  if (n.egressCapGB !== null && n.egressGB >= n.egressCapGB * 0.95) return 'egress_cap';
  if (n.region !== req.region) return 'region';
  if (req.ranked && req.playerIds.includes(n.operatorId)) return 'operator_plays';
  return null;
}

/** Pick a node for the match, or null (the matchmaker then falls back to a MatchDO). */
export function pickNode(nodes: readonly NodeRecord[], req: PlacementRequest, rand: () => number = Math.random): NodeRecord | null {
  const ok = nodes.filter((n) => ineligibility(n, req) === null);
  if (ok.length === 0) return null;
  const bucket = (n: NodeRecord) => Math.floor((n.active / Math.max(1, n.capacity.matches)) * 4);
  let best = Infinity;
  for (const n of ok) best = Math.min(best, bucket(n));
  const pool = ok.filter((n) => bucket(n) === best);
  return pool[Math.floor(rand() * pool.length) % pool.length];
}

/**
 * Who verifies a hosted match: a trusted (project-run) verifier node on the SAME SIMULATION as the
 * match (wasm, protocol and node release), preferably one whose operator did not play in it. A
 * community host is never verified by itself nor by another node of its operator; a trusted host
 * may verify its own matches (still a full re-simulation: it catches determinism bugs). Among the
 * least busy, the pick is random, so nobody can predict which verifier a match gets. null =
 * nobody can right now (the job waits in the queue).
 */
export function pickVerifier(
  nodes: readonly NodeRecord[],
  host: NodeRecord,
  build: BuildId,
  now: number,
  busy: (nodeId: string) => number,
  opts: { playerIds?: readonly string[]; rand?: () => number } = {},
): NodeRecord | null {
  const played = new Set(opts.playerIds ?? []);
  const ok = nodes.filter(
    (n) =>
      n.trusted &&
      n.roles.includes('verify') &&
      n.online &&
      !n.draining &&
      now - n.lastSeen <= HEARTBEAT_TIMEOUT_MS &&
      (host.trusted || (n.nodeId !== host.nodeId && n.operatorId !== host.operatorId)) &&
      (n.status === 'probation' || n.status === 'active') &&
      sameSimulation(n.build, build),
  );
  if (ok.length === 0) return null;
  // Prefer a verifier whose operator did not play; they are all the project's, so fall back to the
  // rest rather than leave the match unverified.
  const clean = ok.filter((n) => !played.has(n.operatorId));
  const from = clean.length > 0 ? clean : ok;
  let least = Infinity;
  for (const n of from) least = Math.min(least, busy(n.nodeId));
  const pool = from.filter((n) => busy(n.nodeId) === least);
  const rand = opts.rand ?? Math.random;
  return pool[Math.floor(rand() * pool.length) % pool.length];
}
