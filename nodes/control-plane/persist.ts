/**
 * Persistence: the rows the NodeRegistryDO keeps in SQLite, so a Worker deploy or a Durable Object
 * restart loses no registration token, no node and no unfinished match. The row functions are
 * pure: a row is the columns the DO indexes plus a JSON `data` column with the rest. The reference
 * server keeps the same rows in a MemoryStore.
 *
 * Only what cannot be rebuilt is written:
 *   tokens   as they are: a deploy between minting a token and running the installer must not
 *            break the registration.
 *   nodes    everything but the fields only heartbeats update (online, lastSeen, active, draining,
 *            tickLagP99Ms, egressGB, cpuLoad): a reconnecting node sends them again within one
 *            heartbeat, and writing them would mean one write per node every 5 s. `trusted` is
 *            recomputed from the trusted operators at every load, so taking an operator out of
 *            NODE_TRUSTED_OPERATORS revokes its nodes at the next start.
 *   matches  without the verification dispatch in flight (inFlight, lastTry, verifiedBy): it does
 *            not survive a restart, the queue sends the job again. A match caught in 'reporting'
 *            (a state that only lasts across the replay read in ControlPlane.onReport) loads as
 *            'assigned' with no report: restored as is, it would refuse the node's report forever
 *            and the deadline would void it. The node sends its unacked reports again at every
 *            welcome, so the report comes back.
 *
 * Every `data` carries STATE_VERSION. A row of another version is refused (the load throws)
 * rather than read with the wrong meaning.
 */
import type { MatchEntry, MatchOutcome, MatchState } from './controlPlane';
import type { NodeRecord, TokenRecord } from './registry';

export const STATE_VERSION = 1;

export interface TokenRow {
  hash: string;
  expiresAt: number;
  data: string;
}

export interface NodeRow {
  nodeId: string;
  operatorId: string;
  publicKey: string;
  data: string;
}

export interface MatchRow {
  matchId: string;
  nodeId: string;
  state: MatchState;
  doneAt: number;
  data: string;
}

/**
 * What the Registry writes through at each durable change; heartbeats never write. Synchronous on
 * purpose: a Durable Object holds its outgoing messages only for the writes issued before the send.
 */
export interface RegistryStore {
  /** Insert or replace one node. */
  node(n: NodeRecord): void;
  /** A registration: the token, now used, and the new node, in one transaction. */
  register(t: TokenRecord, n: NodeRecord): void;
  /** Insert or replace tokens. */
  tokens(t: TokenRecord[]): void;
  /** Delete tokens by hash (expired ones the Registry pruned). */
  dropTokens(hashes: string[]): void;
}

/** What the ControlPlane writes through, before the message that depends on the write goes out. */
export interface MatchStore {
  /** Insert or replace one match. */
  save(m: MatchEntry): void;
  /** The match settled: its last row and, in the DO, the outbox rows of `o`, in one transaction. */
  finished(m: MatchEntry, o: MatchOutcome): void;
  /** A settled match the control plane no longer keeps. */
  drop(matchId: string): void;
}

/** The fields a node record has before its first heartbeat: never written, reset at every load. */
const HEARTBEAT_RESET = { online: false, lastSeen: 0, active: 0, draining: false, tickLagP99Ms: 0, egressGB: 0, cpuLoad: 0 } satisfies Partial<NodeRecord>;

type NodeData = Omit<NodeRecord, 'nodeId' | 'operatorId' | 'publicKey' | keyof typeof HEARTBEAT_RESET>;
type TokenData = Omit<TokenRecord, 'hash' | 'expiresAt'>;
type MatchData = Omit<MatchEntry, 'nodeId' | 'state' | 'doneAt' | 'inFlight' | 'lastTry' | 'verifiedBy' | 'leaves' | 'leaveAt' | 'neverJoined' | 'left' | 'offered'> & {
  leaves: string[];
  leaveAt: Array<[string, number]>;
  neverJoined: string[];
  left: string[];
  offered: string[];
};

function writeData(data: object): string {
  return JSON.stringify({ v: STATE_VERSION, ...data });
}

function readData<T>(data: string, what: string): T {
  const { v, ...d } = JSON.parse(data) as { v?: unknown };
  if (v !== STATE_VERSION) throw new Error(`${what} row of state version ${String(v)}: this build reads version ${STATE_VERSION}`);
  return d as T;
}

export function tokenToRow(t: TokenRecord): TokenRow {
  const { hash, expiresAt, ...data } = t;
  return { hash, expiresAt, data: writeData(data satisfies TokenData) };
}

export function tokenFromRow(row: TokenRow): TokenRecord {
  return { ...readData<TokenData>(row.data, 'token'), hash: row.hash, expiresAt: row.expiresAt };
}

export function nodeToRow(n: NodeRecord): NodeRow {
  const { nodeId, operatorId, publicKey, online, lastSeen, active, draining, tickLagP99Ms, egressGB, cpuLoad, ...data } = n;
  return { nodeId, operatorId, publicKey, data: writeData(data satisfies NodeData) };
}

/** `trustedOps`: the operators trusted now (NODE_TRUSTED_OPERATORS), whatever the node was when written. */
export function nodeFromRow(row: NodeRow, trustedOps: ReadonlySet<string>): NodeRecord {
  const d = readData<NodeData>(row.data, 'node');
  return {
    ...d,
    ...HEARTBEAT_RESET,
    nodeId: row.nodeId,
    operatorId: row.operatorId,
    publicKey: row.publicKey,
    trusted: trustedOps.has(row.operatorId),
    // Fields added after the first nodes registered: the registry tolerates them missing too.
    capacityMax: d.capacityMax ?? d.capacity.matches,
    pauseTimes: d.pauseTimes ?? [],
    counters: { ...d.counters, probationVerified: d.counters.probationVerified ?? 0 },
  };
}

export function matchToRow(m: MatchEntry): MatchRow {
  const { nodeId, state, doneAt, inFlight, lastTry, verifiedBy, leaves, leaveAt, neverJoined, left, offered, ...rest } = m;
  const data: MatchData = { ...rest, leaves: [...leaves], leaveAt: [...leaveAt], neverJoined: [...neverJoined], left: [...left], offered: [...offered] };
  return { matchId: m.assign.matchId, nodeId, state, doneAt, data: writeData(data) };
}

export function matchFromRow(row: MatchRow): MatchEntry {
  const d = readData<MatchData>(row.data, 'match');
  const m: MatchEntry = {
    ...d,
    nodeId: row.nodeId,
    state: row.state,
    doneAt: row.doneAt,
    leaves: new Set(d.leaves),
    leaveAt: new Map(d.leaveAt),
    neverJoined: new Set(d.neverJoined),
    left: new Set(d.left),
    offered: new Set(d.offered),
    inFlight: false,
    lastTry: 0,
    verifiedBy: null,
  };
  if (m.state === 'reporting') {
    m.state = 'assigned';
    m.report = null;
    m.reportedAt = 0;
  }
  return m;
}

/**
 * Both stores over maps of rows (the reference server, tests). Every write goes through the row
 * functions, so a restart from it loses exactly what the DO's would.
 */
export class MemoryStore implements RegistryStore, MatchStore {
  readonly tokenRows = new Map<string, TokenRow>();
  readonly nodeRows = new Map<string, NodeRow>();
  readonly matchRows = new Map<string, MatchRow>();

  node(n: NodeRecord): void {
    this.nodeRows.set(n.nodeId, nodeToRow(n));
  }

  register(t: TokenRecord, n: NodeRecord): void {
    this.tokens([t]);
    this.node(n);
  }

  tokens(ts: TokenRecord[]): void {
    for (const t of ts) this.tokenRows.set(t.hash, tokenToRow(t));
  }

  dropTokens(hashes: string[]): void {
    for (const h of hashes) this.tokenRows.delete(h);
  }

  save(m: MatchEntry): void {
    const row = matchToRow(m);
    this.matchRows.set(row.matchId, row);
  }

  /** No outbox here: the reference server hands outcomes to onOutcome directly. */
  finished(m: MatchEntry): void {
    this.save(m);
  }

  drop(matchId: string): void {
    this.matchRows.delete(matchId);
  }

  /** Every row, as the DO's constructor reads them back (Registry.restore takes the tokens and nodes). */
  rows(): { tokens: TokenRow[]; nodes: NodeRow[]; matches: MatchRow[] } {
    return { tokens: [...this.tokenRows.values()], nodes: [...this.nodeRows.values()], matches: [...this.matchRows.values()] };
  }
}
