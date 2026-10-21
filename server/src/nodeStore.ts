/**
 * NodeStore: the NodeRegistryDO's tables on its SQLite storage (ctx.storage.sql);
 * server/test/nodeRegistry.test.mjs runs the same SQL on node:sqlite. The rows are persist.ts's:
 * the columns the object indexes plus a JSON `data` column with the rest. Synchronous like
 * AccountStore, and on purpose: the control plane writes a row before the message that depends on
 * it goes out, and a Durable Object holds its outgoing messages only for the writes issued before
 * the send.
 *
 * Tables
 *   meta          k -> v; 'state_version': the persist.ts STATE_VERSION the rows were written in;
 *                 'drains_asked': the node processes the object told to drain (NodeRegistryDO)
 *   node_tokens   registration tokens (only their hash), pruned an hour after they expire
 *   nodes         every registered node
 *   node_matches  the matches the control plane keeps (settled ones until its retention ends)
 *   outbox        the calls of each settled match (nodeOutcome.ts), until each is delivered
 */
import { STATE_VERSION, matchToRow, nodeToRow, tokenToRow } from '../../nodes/control-plane/persist';
import type { MatchRow, MatchStore, NodeRow, RegistryStore, TokenRow } from '../../nodes/control-plane/persist';
import type { MatchEntry, MatchOutcome, MatchState } from '../../nodes/control-plane/controlPlane';
import { TOKEN_TTL_MS } from '../../nodes/control-plane/registry';
import type { NodeRecord, TokenRecord } from '../../nodes/control-plane/registry';
import type { SqlLike } from './accountStore';
import { outcomeCalls } from './nodeOutcome';
import type { OutcomeCall } from './nodeOutcome';

/** One undelivered call. */
export interface OutboxRow extends OutcomeCall {
  id: number;
  /** Failed deliveries so far. */
  attempts: number;
  createdAt: number;
}

export class NodeStore implements RegistryStore, MatchStore {
  private readonly sql: SqlLike;
  private readonly tx: <T>(fn: () => T) => T;
  /** Called after outbox rows were written: the object delivers them right away. */
  private readonly onOutbox: () => void;
  private readonly now: () => number;

  constructor(sql: SqlLike, tx: <T>(fn: () => T) => T, onOutbox: () => void = () => undefined, now: () => number = () => Date.now()) {
    this.sql = sql;
    this.tx = tx;
    this.onOutbox = onOutbox;
    this.now = now;
  }

  /**
   * Create the tables (idempotent). Throws when the rows were written in another state version:
   * a newer one means a rollback below the build that wrote them, and reading them with this
   * build's meaning (or writing over them) would lose what they hold.
   */
  migrate(): void {
    const s = this.sql;
    s.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    s.exec('CREATE TABLE IF NOT EXISTS node_tokens (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, data TEXT NOT NULL)');
    s.exec('CREATE TABLE IF NOT EXISTS nodes (node_id TEXT PRIMARY KEY, operator_id TEXT NOT NULL, public_key TEXT NOT NULL UNIQUE, data TEXT NOT NULL)');
    s.exec('CREATE TABLE IF NOT EXISTS node_matches (match_id TEXT PRIMARY KEY, node_id TEXT NOT NULL, state TEXT NOT NULL, done_at INTEGER NOT NULL, data TEXT NOT NULL)');
    s.exec('CREATE INDEX IF NOT EXISTS node_matches_state ON node_matches (state, done_at)');
    s.exec(`CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT, match_id TEXT NOT NULL, target TEXT NOT NULL, path TEXT NOT NULL,
      body TEXT NOT NULL, attempts INTEGER NOT NULL, next_at INTEGER NOT NULL, created_at INTEGER NOT NULL)`);
    s.exec('CREATE INDEX IF NOT EXISTS outbox_next ON outbox (next_at)');
    const v = s.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'state_version'").toArray()[0]?.v;
    if (v === undefined) {
      s.exec("INSERT INTO meta (k, v) VALUES ('state_version', ?)", String(STATE_VERSION));
    } else if (Number(v) !== STATE_VERSION) {
      throw new Error(`the rows are in state version ${v} and this build reads version ${STATE_VERSION}${Number(v) > STATE_VERSION ? ': a newer build wrote them' : ''}`);
    }
  }

  /** Every row the Registry and the ControlPlane restore. Tokens are pruned as Registry.createToken prunes them. */
  load(now: number): { tokens: TokenRow[]; nodes: NodeRow[]; matches: MatchRow[] } {
    const s = this.sql;
    s.exec('DELETE FROM node_tokens WHERE expires_at < ?', now - TOKEN_TTL_MS);
    const tokens = s
      .exec<{ hash: string; expires_at: number; data: string }>('SELECT hash, expires_at, data FROM node_tokens')
      .toArray()
      .map((r) => ({ hash: r.hash, expiresAt: Number(r.expires_at), data: r.data }));
    const nodes = s
      .exec<{ node_id: string; operator_id: string; public_key: string; data: string }>('SELECT node_id, operator_id, public_key, data FROM nodes')
      .toArray()
      .map((r) => ({ nodeId: r.node_id, operatorId: r.operator_id, publicKey: r.public_key, data: r.data }));
    const matches = s
      .exec<{ match_id: string; node_id: string; state: string; done_at: number; data: string }>('SELECT match_id, node_id, state, done_at, data FROM node_matches')
      .toArray()
      .map((r) => ({ matchId: r.match_id, nodeId: r.node_id, state: r.state as MatchState, doneAt: Number(r.done_at), data: r.data }));
    return { tokens, nodes, matches };
  }

  /** A meta value of the object's own (not a control plane row), or null. */
  meta(k: string): string | null {
    return this.sql.exec<{ v: string }>('SELECT v FROM meta WHERE k = ?', k).toArray()[0]?.v ?? null;
  }

  setMeta(k: string, v: string): void {
    this.sql.exec('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, v);
  }

  // ---- RegistryStore ------------------------------------------------------------------------

  node(n: NodeRecord): void {
    const r = nodeToRow(n);
    this.sql.exec(
      'INSERT INTO nodes (node_id, operator_id, public_key, data) VALUES (?, ?, ?, ?) ON CONFLICT(node_id) DO UPDATE SET operator_id = excluded.operator_id, public_key = excluded.public_key, data = excluded.data',
      r.nodeId,
      r.operatorId,
      r.publicKey,
      r.data,
    );
  }

  register(t: TokenRecord, n: NodeRecord): void {
    this.tx(() => {
      this.tokens([t]);
      this.node(n);
    });
  }

  tokens(ts: TokenRecord[]): void {
    for (const t of ts) {
      const r = tokenToRow(t);
      this.sql.exec('INSERT INTO node_tokens (hash, expires_at, data) VALUES (?, ?, ?) ON CONFLICT(hash) DO UPDATE SET expires_at = excluded.expires_at, data = excluded.data', r.hash, r.expiresAt, r.data);
    }
  }

  dropTokens(hashes: string[]): void {
    for (const h of hashes) this.sql.exec('DELETE FROM node_tokens WHERE hash = ?', h);
  }

  // ---- MatchStore ---------------------------------------------------------------------------

  save(m: MatchEntry): void {
    const r = matchToRow(m);
    this.sql.exec(
      'INSERT INTO node_matches (match_id, node_id, state, done_at, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(match_id) DO UPDATE SET node_id = excluded.node_id, state = excluded.state, done_at = excluded.done_at, data = excluded.data',
      r.matchId,
      r.nodeId,
      r.state,
      r.doneAt,
      r.data,
    );
  }

  /**
   * The settled row and the calls that deliver its outcome, in one transaction: a match is never
   * settled without them, nor delivered without being settled. The object is told afterwards.
   */
  finished(m: MatchEntry, o: MatchOutcome): void {
    const humans = m.assign.roster.filter((e) => e.kind === 'player' && e.playerId).map((e) => e.playerId as string);
    const calls = outcomeCalls(o, m.assign, humans);
    const now = this.now();
    this.tx(() => {
      this.save(m);
      for (const c of calls) {
        this.sql.exec('INSERT INTO outbox (match_id, target, path, body, attempts, next_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)', c.matchId, c.target, c.path, c.body, now, now);
      }
    });
    this.onOutbox();
  }

  drop(matchId: string): void {
    this.sql.exec('DELETE FROM node_matches WHERE match_id = ?', matchId);
  }

  // ---- outbox -------------------------------------------------------------------------------

  /** Rows whose next try is due, oldest first. */
  due(now: number, limit: number): OutboxRow[] {
    return this.sql
      .exec<{ id: number; match_id: string; target: string; path: string; body: string; attempts: number; created_at: number }>(
        'SELECT id, match_id, target, path, body, attempts, created_at FROM outbox WHERE next_at <= ? ORDER BY id LIMIT ?',
        now,
        limit,
      )
      .toArray()
      .map((r) => ({ id: Number(r.id), matchId: r.match_id, target: r.target, path: r.path as OutcomeCall['path'], body: r.body, attempts: Number(r.attempts), createdAt: Number(r.created_at) }));
  }

  delivered(id: number): void {
    this.sql.exec('DELETE FROM outbox WHERE id = ?', id);
  }

  retryAt(id: number, attempts: number, nextAt: number): void {
    this.sql.exec('UPDATE outbox SET attempts = ?, next_at = ? WHERE id = ?', attempts, nextAt, id);
  }

  outboxSize(): number {
    return Number(this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM outbox').toArray()[0]?.n ?? 0);
  }
}
