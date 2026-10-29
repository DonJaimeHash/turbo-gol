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
 *   ledger_entries the rewards ledger (nodes/control-plane/ledger.ts): one row per scored match,
 *                 written with the match it settles; kept WINDOW_DAYS (the leaderboard, the summaries)
 *   ledger_totals every operator's all-time points and verified matches (countsAsHosted: one that
 *                 served someone else), updated in the same transaction as its entry
 *   ledger_notes  the repeat decay's notes of matches that earned nothing by themselves, kept 24 h
 *   replay_index  the public replay list (replayIndex.ts): one row per settled, not voided match
 *                 with a replay, written with the match it settles; kept as long as R2 keeps replays
 *                 (REPLAY_INDEX_DAYS: pruned with their R2 objects by the cron's health call) and
 *                 served only from an hour after its settle time (REPLAY_LIST_DELAY_MS) until then
 *   replay_players each listed match's human seats and their player ids (replayIndex.ts replaySeats),
 *                 never served: whose name a served row hides ('Jugador N', AccountsDO replay_names).
 *                 A row listed before this table has no seats (a legacy row): its names are looked up
 *                 by name instead (NodeRegistryDO)
 * Ledger.restore reads the three back at every start (ledgerSnapshot): a deploy keeps the decay,
 * the leaderboard and the summaries. The points themselves go to the operator's account (AccountsDO
 * host_credits, through the outbox), which keeps them for good.
 */
import { STATE_VERSION, matchToRow, nodeToRow, tokenToRow } from '../../nodes/control-plane/persist';
import type { MatchRow, MatchStore, NodeRow, RegistryStore, TokenRow } from '../../nodes/control-plane/persist';
import type { MatchEntry, MatchOutcome, MatchState } from '../../nodes/control-plane/controlPlane';
import { REPEAT_WINDOW_MS, WINDOW_DAYS, countsAsHosted } from '../../nodes/control-plane/ledger';
import type { GroupNote, LedgerEntry, LedgerSnapshot } from '../../nodes/control-plane/ledger';
import { TOKEN_TTL_MS } from '../../nodes/control-plane/registry';
import type { NodeRecord, TokenRecord } from '../../nodes/control-plane/registry';
import type { SqlLike } from './accountStore';
import { outcomeCalls } from './nodeOutcome';
import type { OutcomeCall } from './nodeOutcome';
import { HOUR_MS, REPLAY_INDEX_DAYS, REPLAY_LIST_DELAY_MS, replayIndexItem, replaySeats } from './replayIndex';
import type { ReplayIndexRow, ReplaySeat } from './replayIndex';
import type { ReplayListItem } from '../../src/net/replays';

const DAY_MS = 24 * 60 * 60_000;
/** A row's settle hour in SQL (integer division: `at` is an INTEGER), the expression replay_index_hour indexes. */
const REPLAY_HOUR_SQL = `(at / ${HOUR_MS})`;
/** Rows one prune deletes at most (the cron's, every 5 minutes): bounded work on the object's thread. */
const REPLAY_PRUNE_MAX = 2000;

/** A served row as the object reads it: the stored item and its human seats (null: a row from before replay_players). */
export interface ReplayRow {
  item: ReplayListItem;
  seats: ReplaySeat[] | null;
}

/** Where a page of the public list starts: after this row in the public order (its settle hour, then its id). */
export interface ReplayCursor {
  hour: number;
  matchId: string;
}

/** A note's player ids ([] when the row does not read). */
function playersOf(v: string): string[] {
  try {
    const o: unknown = JSON.parse(v);
    return Array.isArray(o) ? o.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

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
  /** Each node's row as last written or read (node(): an unchanged one is not written again). */
  private readonly written = new Map<string, string>();

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
    s.exec('CREATE TABLE IF NOT EXISTS ledger_entries (match_id TEXT PRIMARY KEY, operator_id TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL)');
    s.exec('CREATE INDEX IF NOT EXISTS ledger_entries_at ON ledger_entries (at)');
    s.exec('CREATE TABLE IF NOT EXISTS ledger_totals (operator_id TEXT PRIMARY KEY, earned REAL NOT NULL, verified INTEGER NOT NULL)');
    s.exec('CREATE TABLE IF NOT EXISTS ledger_notes (operator_id TEXT NOT NULL, players TEXT NOT NULL, at INTEGER NOT NULL)');
    s.exec('CREATE INDEX IF NOT EXISTS ledger_notes_at ON ledger_notes (at)');
    s.exec('CREATE TABLE IF NOT EXISTS replay_index (match_id TEXT PRIMARY KEY, at INTEGER NOT NULL, sha TEXT NOT NULL, data TEXT NOT NULL)');
    s.exec('CREATE INDEX IF NOT EXISTS replay_index_at ON replay_index (at)');
    // The public order: the settle hour (what the list shows), then the match id, so nothing orders
    // the matches of one hour by their exact times.
    s.exec(`CREATE INDEX IF NOT EXISTS replay_index_hour ON replay_index (${REPLAY_HOUR_SQL}, match_id)`);
    s.exec('CREATE TABLE IF NOT EXISTS replay_players (match_id TEXT NOT NULL, slot INTEGER NOT NULL, player_id TEXT NOT NULL, PRIMARY KEY (match_id, slot))');
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
    for (const n of nodes) this.written.set(n.nodeId, `${n.operatorId}\n${n.publicKey}\n${n.data}`);
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

  /**
   * A node's row, written only when what it holds changed: the registry saves at every hello (and
   * its live fields, which the row leaves out, change at every heartbeat), and a node repeating the
   * same hello must not cost a row write each time.
   */
  node(n: NodeRecord): void {
    const r = nodeToRow(n);
    const row = `${r.operatorId}\n${r.publicKey}\n${r.data}`;
    if (this.written.get(r.nodeId) === row) return;
    this.sql.exec(
      'INSERT INTO nodes (node_id, operator_id, public_key, data) VALUES (?, ?, ?, ?) ON CONFLICT(node_id) DO UPDATE SET operator_id = excluded.operator_id, public_key = excluded.public_key, data = excluded.data',
      r.nodeId,
      r.operatorId,
      r.publicKey,
      r.data,
    );
    this.written.set(r.nodeId, row);
  }

  register(t: TokenRecord, n: NodeRecord): void {
    try {
      this.tx(() => {
        this.tokens([t]);
        this.node(n);
      });
    } catch (e) {
      this.written.delete(n.nodeId); // rolled back: the row is not what was last written
      throw e;
    }
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
    const calls = outcomeCalls(o, m.assign, humans, m);
    const now = this.now();
    this.tx(() => {
      this.save(m);
      // Its points: the ledger's row and totals, and the operator's credit (an outbox row below).
      if (m.ledger) this.ledgerEntry(m.ledger, now);
      for (const c of calls) {
        this.sql.exec('INSERT INTO outbox (match_id, target, path, body, attempts, next_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)', c.matchId, c.target, c.path, c.body, now, now);
      }
    });
    // Outside the settling transaction and never thrown: a row that fails only leaves the match unlisted.
    try {
      const listed = replayIndexItem(m, o);
      if (listed && m.replaySha) this.replayRow(listed, m.replaySha, replaySeats(m));
    } catch (e) {
      console.error(`replay index ${m.assign.matchId}: ${String(e)}`);
    }
    this.onOutbox();
  }

  // ---- the public replay index -------------------------------------------------------------

  private replayRow(item: ReplayListItem, sha: string, seats: readonly ReplaySeat[]): void {
    this.tx(() => {
      this.sql.exec('INSERT INTO replay_index (match_id, at, sha, data) VALUES (?, ?, ?, ?) ON CONFLICT(match_id) DO NOTHING', item.matchId, item.at, sha, JSON.stringify(item));
      for (const p of seats) this.sql.exec('INSERT INTO replay_players (match_id, slot, player_id) VALUES (?, ?, ?) ON CONFLICT(match_id, slot) DO NOTHING', item.matchId, p.slot, p.playerId);
    });
  }

  /** The rows past REPLAY_INDEX_DAYS go (the oldest `max`), with their seats. Returns their match ids: their R2 objects go too (NodeRegistryDO). */
  pruneReplays(now: number, max: number = REPLAY_PRUNE_MAX): string[] {
    const ids = this.sql
      .exec<{ match_id: string }>('SELECT match_id FROM replay_index WHERE at < ? ORDER BY at LIMIT ?', now - REPLAY_INDEX_DAYS * DAY_MS, max)
      .toArray()
      .map((r) => r.match_id);
    if (ids.length === 0) return [];
    this.tx(() => {
      for (const id of ids) {
        this.sql.exec('DELETE FROM replay_players WHERE match_id = ?', id);
        this.sql.exec('DELETE FROM replay_index WHERE match_id = ?', id);
      }
    });
    return ids;
  }

  /**
   * The served rows (settled between REPLAY_INDEX_DAYS and REPLAY_LIST_DELAY_MS ago) in the public
   * order, after `cursor` (null: from the newest), at most `limit`, each with its seats.
   */
  replayList(cursor: ReplayCursor | null, limit: number): ReplayRow[] {
    const now = this.now();
    const span = [now - REPLAY_LIST_DELAY_MS, now - REPLAY_INDEX_DAYS * DAY_MS];
    // `+at`: the time window is a filter, never the index, so SQLite walks replay_index_hour in order and
    // stops at `limit` (with replay_index_at it sorted the whole window: 0.1 ms against 300 ms for
    // 300,000 rows). The cursor's hour is the index's range; a row-value or an OR form would scan from the top.
    const order = `ORDER BY ${REPLAY_HOUR_SQL} DESC, match_id DESC LIMIT ?`;
    const rows = cursor
      ? this.sql
          .exec<{ data: string }>(`SELECT data FROM replay_index WHERE +at < ? AND +at >= ? AND ${REPLAY_HOUR_SQL} <= ? AND NOT (${REPLAY_HOUR_SQL} = ? AND match_id >= ?) ${order}`, ...span, cursor.hour, cursor.hour, cursor.matchId, limit)
          .toArray()
      : this.sql.exec<{ data: string }>(`SELECT data FROM replay_index WHERE +at < ? AND +at >= ? ${order}`, ...span, limit).toArray();
    const items = rows.map((r) => JSON.parse(r.data) as ReplayListItem);
    const seats = this.seatsOf(items.map((i) => i.matchId));
    return items.map((item) => ({ item, seats: seats.get(item.matchId) ?? null }));
  }

  /** The seats of each of `matchIds` that has any. */
  private seatsOf(matchIds: readonly string[]): Map<string, ReplaySeat[]> {
    const out = new Map<string, ReplaySeat[]>();
    if (matchIds.length === 0) return out;
    const marks = matchIds.map(() => '?').join(', ');
    for (const r of this.sql.exec<{ match_id: string; slot: number; player_id: string }>(`SELECT match_id, slot, player_id FROM replay_players WHERE match_id IN (${marks}) ORDER BY match_id, slot`, ...matchIds).toArray()) {
      const list = out.get(r.match_id) ?? [];
      list.push({ slot: Number(r.slot), playerId: r.player_id });
      out.set(r.match_id, list);
    }
    return out;
  }

  /** One served match (in replayList's time window), its replay's SHA-256 and its seats, or null. */
  replayEntry(matchId: string): (ReplayIndexRow & { seats: ReplaySeat[] | null }) | null {
    const now = this.now();
    const r = this.sql
      .exec<{ sha: string; data: string }>('SELECT sha, data FROM replay_index WHERE match_id = ? AND at < ? AND at >= ?', matchId, now - REPLAY_LIST_DELAY_MS, now - REPLAY_INDEX_DAYS * DAY_MS)
      .toArray()[0];
    return r ? { item: JSON.parse(r.data) as ReplayListItem, sha: r.sha, seats: this.seatsOf([matchId]).get(matchId) ?? null } : null;
  }

  /** A maintainer's delist (NodeRegistryDO adminDelist): the row and its seats go, whatever its age. True when there was a row. */
  delistReplay(matchId: string): boolean {
    const had = this.sql.exec('SELECT 1 AS x FROM replay_index WHERE match_id = ?', matchId).toArray().length > 0;
    this.tx(() => {
      this.sql.exec('DELETE FROM replay_players WHERE match_id = ?', matchId);
      this.sql.exec('DELETE FROM replay_index WHERE match_id = ?', matchId);
    });
    return had;
  }

  drop(matchId: string): void {
    this.sql.exec('DELETE FROM node_matches WHERE match_id = ?', matchId);
  }

  // ---- the rewards ledger -------------------------------------------------------------------

  /** One scored match (once per match id) and its operator's totals; entries past the window go. */
  private ledgerEntry(e: LedgerEntry, now: number): void {
    if (this.sql.exec('SELECT 1 AS x FROM ledger_entries WHERE match_id = ?', e.matchId).toArray().length > 0) return;
    this.sql.exec('INSERT INTO ledger_entries (match_id, operator_id, at, data) VALUES (?, ?, ?, ?)', e.matchId, e.operatorId, e.at, JSON.stringify(e));
    this.sql.exec(
      'INSERT INTO ledger_totals (operator_id, earned, verified) VALUES (?, ?, ?) ON CONFLICT(operator_id) DO UPDATE SET earned = earned + excluded.earned, verified = verified + excluded.verified',
      e.operatorId,
      e.points,
      countsAsHosted(e) ? 1 : 0,
    );
    this.sql.exec('DELETE FROM ledger_entries WHERE at < ?', now - WINDOW_DAYS * DAY_MS);
  }

  /** The ledger's note of a match that earned nothing by itself (Ledger onNote); notes past the repeat window go. */
  ledgerNote(n: GroupNote): void {
    this.sql.exec('INSERT INTO ledger_notes (operator_id, players, at) VALUES (?, ?, ?)', n.operatorId, JSON.stringify(n.playerIds), n.at);
    this.sql.exec('DELETE FROM ledger_notes WHERE at <= ?', n.at - REPEAT_WINDOW_MS);
  }

  /** What Ledger.restore reads at the start: the window's entries, the repeat window's notes, every operator's totals. */
  ledgerSnapshot(now: number): LedgerSnapshot {
    const s = this.sql;
    s.exec('DELETE FROM ledger_entries WHERE at < ?', now - WINDOW_DAYS * DAY_MS);
    s.exec('DELETE FROM ledger_notes WHERE at <= ?', now - REPEAT_WINDOW_MS);
    const entries: LedgerEntry[] = [];
    for (const r of s.exec<{ data: string }>('SELECT data FROM ledger_entries ORDER BY at').toArray()) {
      try {
        entries.push(JSON.parse(r.data) as LedgerEntry);
      } catch {
        /* a row that does not read is skipped: its points are in the totals and the account already */
      }
    }
    const notes = s
      .exec<{ operator_id: string; players: string; at: number }>('SELECT operator_id, players, at FROM ledger_notes')
      .toArray()
      .map((r) => ({ operatorId: r.operator_id, playerIds: playersOf(r.players), at: Number(r.at) }));
    const totals = s
      .exec<{ operator_id: string; earned: number; verified: number }>('SELECT operator_id, earned, verified FROM ledger_totals')
      .toArray()
      .map((r) => ({ operatorId: r.operator_id, earned: Number(r.earned), verified: Number(r.verified) }));
    return { entries, notes, totals };
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
