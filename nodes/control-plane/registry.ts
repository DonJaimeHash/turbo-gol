/**
 * Node registry: one-time registration tokens, node records and the status rules.
 *
 * Pure logic over in-memory maps. The reference control plane (devServer.ts) uses it as is; the
 * production NodeRegistryDO calls the same methods (see docs/INTEGRACION.md) with a `store` that
 * writes every durable change to its SQLite storage as it happens (persist.ts), and `restore`
 * loads the rows back after a restart. Heartbeats never write: what they carry comes back with
 * the next one.
 *
 * Lifecycle of a node (status):
 *   pending    registered with a valid token; not proven reachable yet -> no matches
 *   probation  reachable, casual matches only. Reachable means: a 'wss' node signed the nonce of
 *              GET <publicUrl>/healthz; an 'rtc' node passed its WebRTC self-test through a TURN
 *              relay (any player can reach it at worst through the relay). Without TURN (local
 *              development only) a plain self-test is accepted.
 *   active     PROBATION_MATCHES verified matches and no failed verification -> ranked too.
 *              A trusted node (run by the project, e.g. the Sao Paulo VPS) is active as soon as it
 *              is reachable.
 *   suspended  a failed verification (possible tampering or a build bug): until a maintainer
 *              looks, even if the node was already in a strike pause. Or MAX_STRIKES lost matches
 *              within STRIKE_WINDOW_MS (a home PC switched off mid-match): lifts by itself after
 *              STRIKE_COOLDOWN_MS, back to the previous status. Trusted nodes are never paused:
 *              a failed verification on one is a determinism bug and only raises an alert.
 *   banned     manual, permanent
 */
import { HEARTBEAT_TIMEOUT_MS } from '../shared/controlProtocol';
import type { BuildId, HeartbeatData, HelloData, NodeCapacity, NodeRole, NodeSpecs, NodeStatus, NodeTransport, RegisterRequest } from '../shared/controlProtocol';
import { isValidPublicKey, randomB64, randomHexId, sha256Hex } from '../shared/edcrypto';
import { nodeFromRow, tokenFromRow } from './persist';
import type { NodeRow, RegistryStore, TokenRow } from './persist';

export const TOKEN_TTL_MS = 60 * 60 * 1000;
export const TOKEN_PREFIX = 'tgn1_';
export const PROBATION_MATCHES = 20;
export const MAX_STRIKES = 3;
export const STRIKE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const STRIKE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** A second strike pause within this window sends an active node back to probation (20 verified matches again). */
export const REPEAT_PAUSE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_NODES_PER_OPERATOR = 10;
export const MAX_CAPACITY = 200;

export interface Operator {
  /** The operator's account id (the session `sub`): reputation and rewards attach to it. */
  id: string;
  name: string;
}

export interface TokenRecord {
  hash: string;
  operatorId: string;
  operatorName: string;
  region: string;
  name: string | null;
  createdAt: number;
  expiresAt: number;
  usedBy: string | null;
}

export interface NodeCounters {
  assigned: number;
  verified: number;
  rankedVerified: number;
  failedVerification: number;
  lost: number;
  /** Lost matches inside the current STRIKE_WINDOW_MS. */
  strikes: number;
  /** Verified matches since the node last entered probation (promotion to active counts these). */
  probationVerified: number;
}

export interface NodeRecord {
  nodeId: string;
  operatorId: string;
  operatorName: string;
  name: string;
  region: string;
  publicKey: string;
  roles: NodeRole[];
  transports: NodeTransport[];
  publicUrl: string | null;
  status: NodeStatus;
  statusReason: string | null;
  /** A project-run machine: skips probation, its verification verdicts are final. */
  trusted: boolean;
  createdAt: number;
  /** When the control plane last proved publicUrl reaches this node (null = not yet / URL changed / its re-probes failed). */
  reachableAt: number | null;
  /** The node's last WebRTC self-test passed (through TURN when the control plane has TURN). */
  rtcReady: boolean;
  /** The node process of the last hello (a new one means it restarted). */
  bootId: string | null;
  build: BuildId;
  specs: NodeSpecs;
  capacity: NodeCapacity;
  /** The largest capacity the node ever declared: the region's supply (lowering it later cannot raise the region factor). */
  capacityMax: number;
  egressCapGB: number | null;
  online: boolean;
  lastSeen: number;
  draining: boolean;
  active: number;
  tickLagP99Ms: number;
  egressGB: number;
  cpuLoad: number;
  counters: NodeCounters;
  strikeTimes: number[];
  /** When strike pauses started (REPEAT_PAUSE_WINDOW_MS): a repeated pause demotes the node. */
  pauseTimes: number[];
  /** Strike suspensions lift by themselves at this time (null: manual review). */
  suspendedUntil: number | null;
  statusBeforeSuspension: NodeStatus | null;
}

export type RegisterResult = { ok: true; node: NodeRecord } | { ok: false; code: string; message?: string };

export interface RegistryOptions {
  /** Accept ws:// public URLs and http control URLs (local development only). */
  allowInsecure?: boolean;
  /** Operators whose nodes are trusted (the project's own machines). */
  trustedOperators?: string[];
  /** Region ids the control plane knows (src/net/account.ts REGIONS). */
  regions?: string[];
  /** Where durable changes are written as they happen (none: memory only). */
  store?: RegistryStore;
  /** The control plane's log (default console.log); its ALERT lines are for the maintainers. */
  log?: (msg: string) => void;
}

function cleanName(s: unknown, fallback: string): string {
  if (typeof s !== 'string') return fallback;
  const t = s.replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 32);
  return t.length >= 2 ? t : fallback;
}

export function validPublicUrl(u: unknown, allowInsecure: boolean): u is string {
  if (typeof u !== 'string' || u.length > 200) return false;
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.protocol !== 'wss:' && !(allowInsecure && url.protocol === 'ws:')) return false;
  if (url.pathname !== '/' && url.pathname !== '') return false;
  return url.search === '' && url.hash === '' && url.username === '' && url.password === '';
}

/** The ways players can reach `n` right now. */
export function usableTransports(n: NodeRecord): NodeTransport[] {
  const out: NodeTransport[] = [];
  if (n.transports.includes('wss') && n.publicUrl && n.reachableAt !== null) out.push('wss');
  if (n.transports.includes('rtc') && n.rtcReady) out.push('rtc');
  return out;
}

export class Registry {
  private readonly tokens = new Map<string, TokenRecord>();
  private readonly nodes = new Map<string, NodeRecord>();
  private readonly opts: RegistryOptions;
  private readonly trusted: Set<string>;
  private readonly log: (msg: string) => void;

  constructor(opts: RegistryOptions = {}) {
    this.opts = opts;
    this.trusted = new Set(opts.trustedOperators ?? []);
    this.log = opts.log ?? ((m) => console.log(`[control] ${m}`));
  }

  /**
   * Load the rows written through `store` (a fresh registry, after a restart). `trusted` comes
   * from this registry's trusted operators, not from the rows.
   */
  restore(rows: { tokens: TokenRow[]; nodes: NodeRow[] }): void {
    this.tokens.clear();
    this.nodes.clear();
    for (const r of rows.tokens) this.tokens.set(r.hash, tokenFromRow(r));
    for (const r of rows.nodes) this.nodes.set(r.nodeId, nodeFromRow(r, this.trusted));
  }

  private save(n: NodeRecord): void {
    this.opts.store?.node(n);
  }

  /** Mark an operator as the project (production: NODE_TRUSTED_OPERATORS in the Worker env). */
  addTrustedOperator(id: string): void {
    this.trusted.add(id);
    for (const n of this.nodes.values()) {
      if (n.operatorId !== id || n.trusted) continue;
      n.trusted = true;
      this.save(n);
    }
  }

  isTrusted(operatorId: string): boolean {
    return this.trusted.has(operatorId);
  }

  // ---- tokens -----------------------------------------------------------------------------

  /** A one-time token, valid TOKEN_TTL_MS, shown to the operator once (only its hash is kept). */
  async createToken(op: Operator, region: string, now: number, name?: string): Promise<{ token: string; expiresAt: number }> {
    if (this.opts.regions && !this.opts.regions.includes(region)) throw new Error('bad region');
    const token = TOKEN_PREFIX + randomB64(24);
    const rec: TokenRecord = {
      hash: await sha256Hex(token),
      operatorId: op.id,
      operatorName: op.name,
      region,
      name: name ? cleanName(name, '') || null : null,
      createdAt: now,
      expiresAt: now + TOKEN_TTL_MS,
      usedBy: null,
    };
    this.tokens.set(rec.hash, rec);
    const pruned: string[] = [];
    for (const [h, t] of this.tokens) {
      if (t.expiresAt < now - TOKEN_TTL_MS) {
        this.tokens.delete(h);
        pruned.push(h);
      }
    }
    this.opts.store?.tokens([rec]);
    if (pruned.length > 0) this.opts.store?.dropTokens(pruned);
    // Its node will be trusted: it verifies ranked matches, its own included. A token nobody on the
    // team asked for means the project account is in someone else's hands.
    if (this.trusted.has(op.id)) this.log(`ALERT registration token created for trusted operator ${op.name} (${op.id}), region ${region}`);
    return { token, expiresAt: rec.expiresAt };
  }

  /** Every token kept (unused, used, and expired ones until they are pruned). */
  tokenList(): TokenRecord[] {
    return [...this.tokens.values()];
  }

  // ---- registration ---------------------------------------------------------------------------

  async register(req: RegisterRequest, now: number): Promise<RegisterResult> {
    if (!req || typeof req.token !== 'string' || !req.token.startsWith(TOKEN_PREFIX) || req.token.length > 80) return { ok: false, code: 'bad_token' };
    const tok = this.tokens.get(await sha256Hex(req.token));
    if (!tok || tok.usedBy !== null) return { ok: false, code: 'bad_token', message: 'unknown or already used' };
    if (tok.expiresAt < now) return { ok: false, code: 'token_expired' };
    if (this.byOperator(tok.operatorId).length >= MAX_NODES_PER_OPERATOR) return { ok: false, code: 'too_many_nodes' };
    if (!(await isValidPublicKey(req.publicKey))) return { ok: false, code: 'bad_public_key' };
    for (const n of this.nodes.values()) if (n.publicKey === req.publicKey) return { ok: false, code: 'key_in_use' };
    const roles = Array.isArray(req.roles) ? [...new Set(req.roles)].filter((r): r is NodeRole => r === 'host' || r === 'verify') : [];
    if (roles.length === 0) return { ok: false, code: 'bad_roles' };
    // Verification is the project's job for now: a community verifier would never get a job, and
    // today's verdict could be answered from the replay alone without simulating (docs/PRODUCCION.md).
    if (roles.includes('verify') && !this.trusted.has(tok.operatorId)) {
      return { ok: false, code: 'verify_reserved', message: 'only project nodes verify matches for now; register with --roles host' };
    }
    const insecure = this.opts.allowInsecure === true;
    let transports: NodeTransport[] = [];
    if (roles.includes('host')) {
      const asked = Array.isArray(req.transports) ? req.transports : req.publicUrl ? ['wss'] : ['rtc'];
      transports = [...new Set(asked)].filter((t): t is NodeTransport => t === 'wss' || t === 'rtc');
      if (transports.length === 0) return { ok: false, code: 'bad_transports' };
      if (transports.includes('wss') && !validPublicUrl(req.publicUrl, insecure)) return { ok: false, code: 'bad_public_url', message: insecure ? 'ws(s)://host[:port]' : 'wss://host[:port]' };
    }
    const b = req.build;
    if (!b || typeof b.version !== 'string' || typeof b.protocol !== 'number' || !/^[0-9a-f]{64}$/.test(String(b.wasmSha256))) return { ok: false, code: 'bad_build' };
    const c = req.capacity;
    if (!c || !Number.isInteger(c.matches) || c.matches < 1 || c.matches > MAX_CAPACITY) return { ok: false, code: 'bad_capacity' };

    const nodeId = randomHexId(8);
    const count = this.byOperator(tok.operatorId).length + 1;
    const node: NodeRecord = {
      nodeId,
      operatorId: tok.operatorId,
      operatorName: tok.operatorName,
      name: cleanName(req.name ?? tok.name, `${tok.region.toLowerCase()}-${tok.operatorName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) || 'node'}-${count}`),
      region: tok.region,
      publicKey: req.publicKey,
      roles,
      transports,
      publicUrl: transports.includes('wss') ? (req.publicUrl as string).replace(/\/$/, '') : null,
      status: 'pending',
      statusReason: null,
      trusted: this.trusted.has(tok.operatorId),
      createdAt: now,
      reachableAt: null,
      rtcReady: false,
      bootId: null,
      build: { version: b.version, protocol: b.protocol, wasmSha256: b.wasmSha256 },
      specs: req.specs,
      capacity: c,
      capacityMax: c.matches,
      egressCapGB: null,
      online: false,
      lastSeen: 0,
      draining: false,
      active: 0,
      tickLagP99Ms: 0,
      egressGB: 0,
      cpuLoad: 0,
      counters: { assigned: 0, verified: 0, rankedVerified: 0, failedVerification: 0, lost: 0, strikes: 0, probationVerified: 0 },
      strikeTimes: [],
      pauseTimes: [],
      suspendedUntil: null,
      statusBeforeSuspension: null,
    };
    // A verify-only node needs no reachability: it only dials out.
    if (!roles.includes('host')) {
      node.reachableAt = now;
      node.status = node.trusted ? 'active' : 'probation';
    }
    // The awaits above let other registrations run their checks meanwhile: with this token, this
    // key or another token of this operator. Nothing yields from here until the token is spent, so
    // check again.
    if (tok.usedBy !== null) return { ok: false, code: 'bad_token', message: 'unknown or already used' };
    if (this.byOperator(tok.operatorId).length >= MAX_NODES_PER_OPERATOR) return { ok: false, code: 'too_many_nodes' };
    for (const n of this.nodes.values()) if (n.publicKey === req.publicKey) return { ok: false, code: 'key_in_use' };
    tok.usedBy = nodeId;
    this.nodes.set(nodeId, node);
    this.opts.store?.register(tok, node);
    if (node.trusted) {
      this.log(`ALERT trusted node ${node.name} (${nodeId}) registered for ${node.operatorName} (${node.operatorId}), roles ${roles.join('+')}${node.publicUrl ? ' at ' + node.publicUrl : ''}`);
    }
    return { ok: true, node };
  }

  // ---- queries ------------------------------------------------------------------------------

  node(id: string): NodeRecord | undefined {
    return this.nodes.get(id);
  }

  list(): NodeRecord[] {
    return [...this.nodes.values()];
  }

  byOperator(operatorId: string): NodeRecord[] {
    return this.list().filter((n) => n.operatorId === operatorId);
  }

  // ---- live state ---------------------------------------------------------------------------

  /**
   * The node said hello (after every login and after a new WebRTC self-test). `hello` must come
   * from validate.parseHello. `requireRelay`: the control plane hands out TURN, so only a
   * self-test through the relay proves players can reach the node. Returns the new status when it
   * changed (an rtc node that just proved it is reachable).
   */
  connected(id: string, hello: HelloData, now: number, opts: { requireRelay?: boolean } = {}): NodeStatus | null {
    const n = this.nodes.get(id);
    if (!n) return null;
    n.online = true;
    n.lastSeen = now;
    n.build = hello.build;
    n.specs = hello.specs;
    n.draining = hello.draining;
    n.egressCapGB = hello.egressCapGB;
    n.bootId = hello.bootId ?? null;
    n.capacity = hello.capacity;
    n.capacityMax = Math.max(n.capacityMax ?? 0, hello.capacity.matches);
    const roles = hello.roles.filter((r): r is NodeRole => n.roles.includes(r));
    if (roles.length > 0) n.roles = roles;
    const transports = hello.transports.filter((t): t is NodeTransport => n.transports.includes(t));
    if (transports.length > 0) n.transports = transports;
    n.rtcReady = n.transports.includes('rtc') && hello.rtcReady === true && (opts.requireRelay !== true || hello.rtcRelay === true);
    const url = hello.publicUrl ? hello.publicUrl.replace(/\/$/, '') : null;
    if (n.transports.includes('wss') && url !== n.publicUrl) {
      if (url && validPublicUrl(url, this.opts.allowInsecure === true)) {
        n.publicUrl = url;
        n.reachableAt = null; // a new address must be proven again
      }
    }
    // An rtc-only host is reachable once its self-test passed.
    const changed = n.roles.includes('host') && !n.transports.includes('wss') && n.rtcReady ? this.reach(n, now) : null;
    this.save(n);
    return changed;
  }

  /** `hb` must come from validate.parseHeartbeat. */
  heartbeat(id: string, hb: HeartbeatData, now: number): void {
    const n = this.nodes.get(id);
    if (!n) return;
    n.online = true;
    n.lastSeen = now;
    n.active = Math.min(hb.active, n.capacity.matches);
    n.draining = hb.draining;
    n.tickLagP99Ms = hb.tickLagP99Ms;
    n.egressGB = hb.egressGB;
    n.egressCapGB = hb.egressCapGB;
    n.cpuLoad = hb.cpuLoad;
  }

  /**
   * The node's control socket outlived a restart of the control plane (a hibernation): it is live
   * as of `now`, so the heartbeat timeout covers it before its first heartbeat too. Not written,
   * like a heartbeat.
   */
  adopted(id: string, now: number): void {
    const n = this.nodes.get(id);
    if (!n) return;
    n.online = true;
    n.lastSeen = now;
  }

  disconnected(id: string): void {
    const n = this.nodes.get(id);
    if (n) n.online = false;
  }

  /**
   * Housekeeping: nodes whose heartbeats stopped go offline (the control plane voids their
   * matches); strike suspensions whose cooldown passed are lifted (the node is told).
   */
  sweep(now: number): { offline: NodeRecord[]; restored: NodeRecord[] } {
    const offline: NodeRecord[] = [];
    const restored: NodeRecord[] = [];
    for (const n of this.nodes.values()) {
      if (n.online && now - n.lastSeen > HEARTBEAT_TIMEOUT_MS) {
        n.online = false;
        offline.push(n);
      }
      if (n.status === 'suspended' && n.suspendedUntil !== null && now >= n.suspendedUntil) {
        n.status = n.statusBeforeSuspension ?? 'probation';
        n.statusReason = null;
        n.suspendedUntil = null;
        n.statusBeforeSuspension = null;
        // The strikes keep their own 7-day window: another one this week pauses the node again.
        n.strikeTimes = n.strikeTimes.filter((t) => now - t < STRIKE_WINDOW_MS);
        n.counters.strikes = n.strikeTimes.length;
        this.save(n);
        restored.push(n);
      }
    }
    return { offline, restored };
  }

  // ---- status rules ---------------------------------------------------------------------------

  /** Reachability proven: pending -> probation (a trusted node -> active). Returns the new status when it changed. */
  markReachable(id: string, now: number): NodeStatus | null {
    const n = this.nodes.get(id);
    if (!n) return null;
    const changed = this.reach(n, now);
    this.save(n);
    return changed;
  }

  /**
   * A proven wss host stopped answering its re-probes: no wss placements until a probe proves it
   * again. The status stays (a trusted node is still active): only the transport goes.
   */
  markUnreachable(id: string): void {
    const n = this.nodes.get(id);
    if (!n || n.reachableAt === null) return;
    n.reachableAt = null;
    this.save(n);
  }

  private reach(n: NodeRecord, now: number): NodeStatus | null {
    n.reachableAt = now;
    if (n.status === 'pending') {
      n.status = n.trusted ? 'active' : 'probation';
      n.statusReason = null;
      return n.status;
    }
    if (n.trusted && n.status === 'probation') {
      n.status = 'active';
      return n.status;
    }
    return null;
  }

  onAssigned(id: string): void {
    const n = this.nodes.get(id);
    if (!n) return;
    n.counters.assigned++;
    this.save(n);
  }

  /** A verification verdict for a match this node hosted. Returns the new status when it changed. */
  onVerified(id: string, ranked: boolean, ok: boolean): NodeStatus | null {
    const n = this.nodes.get(id);
    if (!n) return null;
    let changed: NodeStatus | null = null;
    if (!ok) {
      n.counters.failedVerification++;
      if (!n.trusted && n.status !== 'banned') {
        // Manual review, replacing any timed strike pause (which would otherwise lift by itself).
        n.status = 'suspended';
        n.statusReason = 'verification_failed';
        n.suspendedUntil = null;
        n.statusBeforeSuspension = null;
        changed = 'suspended'; // always told: the reason changed even when the status did not
      }
    } else {
      n.counters.verified++;
      n.counters.probationVerified = (n.counters.probationVerified ?? 0) + 1;
      if (ranked) n.counters.rankedVerified++;
      if (n.status === 'probation' && n.counters.probationVerified >= PROBATION_MATCHES && n.counters.failedVerification === 0) {
        changed = this.applyStatus(n, 'active', null);
      }
    }
    this.save(n);
    return changed;
  }

  /**
   * A match lost on this node (switched off, crashed, no replay). Strikes count inside
   * STRIKE_WINDOW_MS; MAX_STRIKES suspend the node for STRIKE_COOLDOWN_MS. Returns the new status
   * when it changed.
   */
  onLost(id: string, reason: string, now: number): NodeStatus | null {
    const n = this.nodes.get(id);
    if (!n) return null;
    n.counters.lost++;
    n.strikeTimes = n.strikeTimes.filter((t) => now - t < STRIKE_WINDOW_MS);
    n.strikeTimes.push(now);
    n.counters.strikes = n.strikeTimes.length;
    let changed: NodeStatus | null = null;
    if (n.counters.strikes >= MAX_STRIKES && (n.status === 'probation' || n.status === 'active') && !n.trusted) {
      n.pauseTimes = (n.pauseTimes ?? []).filter((t) => now - t < REPEAT_PAUSE_WINDOW_MS);
      const repeated = n.pauseTimes.length > 0;
      n.pauseTimes.push(now);
      // A second pause within 30 days: back to probation, the 20 verified matches start over.
      n.statusBeforeSuspension = repeated ? 'probation' : n.status;
      if (repeated) n.counters.probationVerified = 0;
      n.status = 'suspended';
      n.statusReason = 'strikes:' + reason;
      n.suspendedUntil = now + STRIKE_COOLDOWN_MS;
      changed = n.status;
    }
    this.save(n);
    return changed;
  }

  /** Manual status change (admin) or a verification failure; clears any automatic cooldown. */
  setStatus(id: string, status: NodeStatus, reason: string | null): NodeStatus | null {
    const n = this.nodes.get(id);
    if (!n || n.status === status) return null;
    this.applyStatus(n, status, reason);
    this.save(n);
    return status;
  }

  private applyStatus(n: NodeRecord, status: NodeStatus, reason: string | null): NodeStatus {
    n.status = status;
    n.statusReason = reason;
    n.suspendedUntil = null;
    n.statusBeforeSuspension = null;
    if (status === 'probation' || status === 'active') {
      n.strikeTimes = [];
      n.counters.strikes = 0;
    }
    if (status === 'probation') n.counters.probationVerified = 0; // a maintainer's demotion: the 20 matches start over
    return status;
  }
}
