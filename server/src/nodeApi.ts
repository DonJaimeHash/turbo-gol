/**
 * The Worker's side of the community nodes (nodes/): where the NodeRegistryDO lives, the build it
 * holds the nodes to, and the internal routes the Worker and the matchmaker call it on. Only types
 * come from nodes/ (`import type`): the control plane's code is bundled with the NodeRegistryDO
 * alone.
 *
 * Internal routes (INTERNAL_HEADER, like every Durable Object call; JSON bodies; a refusal answers
 * its status with { error: code }, as env.ts error() does):
 *   POST /internal/place   PlaceBody -> 200 PlaceAnswer: the placement, or null when no node took
 *                          the match (the matchmaker then uses a MatchDO), and the region's hosts
 *   POST /internal/rejoin  NodePlayerBody -> 200 RejoinTicket, or REJOIN_STATUS[code]
 *   POST /internal/leave   LeaveBody -> 200 LeaveResult (the leave is recorded: free the lock), or
 *                          LEAVE_STATUS[code]
 *   GET  /internal/status  ?matchId=&playerId= -> 200 StatusAnswer, or 404 when the control plane
 *                          knows neither the match nor the player in it (the lock is free)
 *   POST /internal/health  the cron's (index.ts scheduled) -> 200 { probed, problems }: the /healthz
 *                          of the trusted wss nodes, each problem an ALERT (nodeWatch.ts)
 */
import type { ControlPlane, LeaveResult, PlaceRequest, Placement, RejoinAnswer } from '../../nodes/control-plane/controlPlane';
import type { BuildId } from '../../nodes/shared/controlProtocol';
import { PROTOCOL_VERSION } from '../../src/net/protocol';
import { ROCKETSIM_WASM_SHA256 } from '../../src/sim/wasm/rocketsim.sha256';
import { carsOf } from '../../src/net/cosmetics';
import { INTERNAL_HEADER, internalSecret } from './auth';
import { SERVER_VERSION, isHex, withTimeout } from './env';
import type { Env } from './env';

/** The one NodeRegistryDO object: every node's control link and every placement go through it. */
export const NODES_OBJECT = 'nodes-v1';

/**
 * The NodeRegistryDO, created near São Paulo ('sam'; a location hint only counts when the object
 * is created): every heartbeat of the first nodes, and every placement for the players they host,
 * makes a round trip to it.
 */
export function nodesStub(env: Required<Pick<Env, 'NODES'>>): DurableObjectStub {
  return env.NODES.get(env.NODES.idFromName(NODES_OBJECT), { locationHint: 'sam' });
}

/**
 * The build this deploy's web client runs. The control plane places matches only on nodes with the
 * same wasm and protocol (the version is not compared): the hash is committed with the wasm
 * because the Worker cannot compute it.
 */
export const CLIENT_BUILD: BuildId = { version: SERVER_VERSION, protocol: PROTOCOL_VERSION, wasmSha256: ROCKETSIM_WASM_SHA256 };

/** The internal routes of the NodeRegistryDO (https://nodes<path>). */
export const NODE_ROUTES = {
  place: '/internal/place',
  rejoin: '/internal/rejoin',
  leave: '/internal/leave',
  status: '/internal/status',
  health: '/internal/health',
} as const;

/** POST /internal/place: a match the matchmaker formed (its humans, fixed teams, length). */
export type PlaceBody = PlaceRequest;

export interface PlaceAnswer {
  /** The node and every player's ticket; null: no node took the match. */
  placement: Placement | null;
  /** Hosts online in the region that may take matches (ControlPlane.hostsOnline). 0: stop asking for a while. */
  hosts: number;
}

/** POST /internal/rejoin: one player of one node match. */
export interface NodePlayerBody {
  matchId: string;
  playerId: string;
}

/** POST /internal/leave: an explicit quit. `connected: false`: the client never got into the match (never a dodge). */
export interface LeaveBody extends NodePlayerBody {
  connected?: boolean;
}

/** The 200 of /internal/rejoin: a fresh ticket and the node's own URL (absolute: not the Worker's /ws/), and the match's cars. */
export type RejoinTicket = Omit<Extract<RejoinAnswer, { ok: true }>, 'ok'>;

/** Why a player cannot rejoin (ControlPlane.rejoin). */
export type RejoinRefusal = Extract<RejoinAnswer, { ok: false }>['code'];

/**
 * The status of each rejoin refusal, as the Worker answers a MatchDO rejoin. 404: the lock points
 * at nothing, free it. 410: the match is over for this player, free the lock too, except on 'left'
 * (the quit freed it already, and the match still runs). 503: the node is out of reach for now;
 * keep the lock, it may come back.
 */
export const REJOIN_STATUS: Readonly<Record<RejoinRefusal, 404 | 410 | 503>> = {
  no_match: 404,
  not_in_match: 404,
  left: 410,
  match_over: 410,
  offline: 503,
};

/** Why a leave was not recorded (the NodeRefused codes of ControlPlane.leave, thrown before it records anything). */
export type LeaveRefusal = 'no_match' | 'not_in_match' | 'match_over' | 'offline';

/**
 * The status of each leave refusal. A 404 or 410 has nothing left to quit: free the lock. A 503
 * recorded nothing: keep the lock, or the player could start a second match while the node still
 * holds a slot for them.
 */
export const LEAVE_STATUS: Readonly<Record<LeaveRefusal, 404 | 410 | 503>> = {
  no_match: 404,
  not_in_match: 404,
  match_over: 410,
  offline: 503,
};

/** The 200 of /internal/leave. */
export type LeaveAnswer = LeaveResult;

/** The 200 of /internal/status (ControlPlane.matchStatus). */
export type StatusAnswer = NonNullable<ReturnType<ControlPlane['matchStatus']>>;

/**
 * A node lock still holds: the match is being played or reported, and the player has not left it.
 * An answer that is no status (no string `state`, no boolean `left`) holds it too: only a real
 * status frees a lock.
 */
export function nodeLockHeld(s: unknown): boolean {
  const { state, left } = (typeof s === 'object' && s !== null ? s : {}) as Partial<StatusAnswer>;
  if (typeof state !== 'string' || typeof left !== 'boolean') return true;
  return (state === 'assigned' || state === 'reporting') && !left;
}

/**
 * How long the matchmaker and the Worker wait for the NodeRegistryDO. Longer than one RPC to a
 * node (RPC_TIMEOUT_MS, 5 s: the assign of a placement, the relay of a leave), so the control
 * plane's own answer, the node's timeout included, comes back first. A stuck object costs a caller
 * at most this long; it then goes on without the nodes.
 */
export const NODE_CALL_TIMEOUT_MS = 8_000;

/** An answer of the NodeRegistryDO: its status and JSON body (null when it has none). */
export interface NodesReply {
  status: number;
  body: unknown;
}

/**
 * One internal call to the NodeRegistryDO: a POST of `body`, or a GET without one. Rejects on a
 * network error, and when the whole answer (its body included) took longer than `timeoutMs`.
 */
export function askNodes(env: Pick<Env, 'JWT_SECRET'> & Required<Pick<Env, 'NODES'>>, path: string, body?: unknown, timeoutMs: number = NODE_CALL_TIMEOUT_MS): Promise<NodesReply> {
  const call = async (): Promise<NodesReply> => {
    const headers: Record<string, string> = { [INTERNAL_HEADER]: await internalSecret(env.JWT_SECRET) };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await nodesStub(env).fetch('https://nodes' + path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      /* not JSON: a status only */
    }
    return { status: res.status, body: parsed };
  };
  return withTimeout(call(), timeoutMs);
}

/** The `error` code of an answer body ('' when it has none). */
export function replyCode(body: unknown): string {
  const code = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
  return typeof code === 'string' ? code : '';
}

/**
 * The placement in a POST /internal/place answer, when it is one for exactly these players: a
 * 64-hex match id (the Worker's routes take no other), the node's own wss:// URL and one ticket
 * per player. Anything else is null, and the matchmaker uses its own servers.
 */
export function placementFor(answer: unknown, playerIds: readonly string[]): Placement | null {
  const p = typeof answer === 'object' && answer !== null ? (answer as { placement?: unknown }).placement : null;
  if (typeof p !== 'object' || p === null) return null;
  const { matchId, wsUrl, tickets } = p as Partial<Placement>;
  if (!isHex(matchId, 64) || !isWss(wsUrl) || !Array.isArray(tickets) || tickets.length !== playerIds.length) return null;
  const left = new Set(playerIds);
  for (const t of tickets as unknown[]) {
    const x = (typeof t === 'object' && t !== null ? t : {}) as Partial<Placement['tickets'][number]>;
    if (typeof x.playerId !== 'string' || !left.delete(x.playerId)) return null; // a stranger, or a player twice
    if (typeof x.ticket !== 'string' || x.ticket.length === 0 || !Number.isInteger(x.slot) || (x.team !== 0 && x.team !== 1)) return null;
  }
  return left.size === 0 ? (p as Placement) : null;
}

/**
 * The ticket in a 200 of POST /internal/rejoin when it is one, as placementFor checks a placement's:
 * a non-empty ticket and the node's own wss:// URL; with the match's `cars` when they read as such
 * (src/net/cosmetics.ts carsOf: any other shape is dropped, the ticket still counts).
 */
export function rejoinTicketOf(body: unknown): RejoinTicket | null {
  const { ticket, wsUrl, cars } = (typeof body === 'object' && body !== null ? body : {}) as Partial<Record<keyof RejoinTicket, unknown>>;
  if (typeof ticket !== 'string' || ticket.length === 0 || !isWss(wsUrl)) return null;
  const known = carsOf(cars);
  return known ? { ticket, wsUrl, cars: known } : { ticket, wsUrl };
}

function isWss(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  try {
    return new URL(v).protocol === 'wss:';
  } catch {
    return false;
  }
}
